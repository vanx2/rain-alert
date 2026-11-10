'use strict';

// ============================================================================
// 雨が降り始める前に Google Home Mini へ通知するスクリプト
// ============================================================================
//
// 【目的】
//   Yahoo!気象情報APIから現在の降雨と今後60分間の予測を取得します。
//   現在ほぼ降っておらず、30分以内に一定以上の雨が予測されたときに、
//   同じMac miniで動いているslack2googlehomeの/say APIを呼び出します。
//
// 【実行環境】
//   Node.js 22以上。外部npmパッケージは使用しません。
//   launchdから5分間隔で起動する想定で、1回の実行が終われば終了します。
//
// 【実行方法】
//   node rain-check.js
//     本番実行（必要なら通知・状態保存）
//
//   node rain-check.js --dry-run
//     実際のAPIを取得して判定のみ表示
//
//   node rain-check.js --fixture x.json
//     JSONファイルで模擬テスト（通知・保存なし）
//
// 【注意】
//   Yahoo!気象情報APIの利用条件を確認してから運用してください。
//   特に家庭内だけで使う非公開用途が許可されるかに注意が必要です。
//   このスクリプトはHTTP APIを定期取得する方式で、Yahoo!からの
//   Webhook通知を待ち受ける方式ではありません。

// Node.js標準モジュールのみ使用します。
// fs   : 設定ファイルと通知済み状態ファイルの読み書き
// path : OS上のファイルパスの結合
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// 設定値：普段の運用で変更したくなったら、主にこの部分を編集してください。
// ---------------------------------------------------------------------------

// ユーザーのホームディレクトリ（launchdのUserNameと合わせます）。
const HOME = '/Users/v';
const APP_DIR = path.join(HOME, 'scripts/rain-alert');

// Yahoo!のClient IDを保存するファイル。1行にIDだけを記載します。
// 秘密情報をソースコードやGitHubに埋め込まないため、別ファイルにしています。
const CONFIG = path.join(APP_DIR, 'yahoo-appid');

// 前回通知したかどうかを保持するファイル（Mac再起動後も引き継ぎます）。
// 初回実行では存在しなくても構いません。
const STATE_DIR = APP_DIR;
const STATE_PATH = path.join(APP_DIR, 'state.json');

// JR住吉駅付近の概略地点。Yahoo! APIでは「経度,緯度」の順です。
// 正確な地点に変えたい場合のみ、この値を編集します。
const COORDINATES = '135.261859,34.719595';

// 雨の強さの単位は mm/h（1時間に何mmの雨に相当するか）。
// 予測値がこの値以上なら「雨が来る」と判定します。
const RAIN_THRESHOLD = 0.5;

// 「今はまだ降っていない」とみなす現在の降水強度。
// 実測値がこの値未満のときにだけ、事前通知の候補にします。
const CURRENT_DRY_THRESHOLD = 0.1;

// 何分以内の雨を通知対象にするか（このサンプルは0～30分以内）。
// ※「必ず15～30分前」と厳密に限定するものではありません。
//   予報の更新が遅れ、直前に初めて検知した場合にも通知します。
const LOOKAHEAD_MINUTES = 30;

// 実測・予測ともに雨がない状態が30分続いたら「通知済み」を解除します。
// 一時的に予報が晴れになっただけで何度も通知するのを防ぐためです。
const CLEAR_RESET_MINUTES = 30;

// 23:00～翌6:59は、Google Homeの読み上げ通知を行いません。
// 深夜も予報の取得・状態の更新は継続します。
const QUIET_START = 23;
const QUIET_END = 7;

// ---------------------------------------------------------------------------
// Yahoo! APIの日付文字列をJavaScriptのDateに変換する
// ---------------------------------------------------------------------------

// Yahoo! APIの日付文字列（例：202611101045）をDateに変換します。
// 文字列にはタイムゾーン情報が含まれないため「日本時間（JST）」と解釈し、
// 9時間差を補正してUTCの時刻を作ります。
// Dateの内部値は世界共通の時刻なので、後続の差分計算に利用できます。
function jstDate(yyyymmddhhmm) {
  if (!/^\d{12}$/.test(yyyymmddhhmm)) {
    throw new Error('Invalid Weather.Date');
  }

  const y = Number(yyyymmddhhmm.slice(0, 4));
  const mo = Number(yyyymmddhhmm.slice(4, 6));
  const d = Number(yyyymmddhhmm.slice(6, 8));
  const h = Number(yyyymmddhhmm.slice(8, 10));
  const mi = Number(yyyymmddhhmm.slice(10, 12));

  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi));
}

// ---------------------------------------------------------------------------
// 通知済み状態の読み込み
// ---------------------------------------------------------------------------

// 前回の状態を読み取ります。
// alerted   : 直近の降雨イベントについて既に読み上げたか
// clearSince: 「雨がない」という判定が連続し始めた時刻（Unixミリ秒）
//
// 初回起動などでstate.jsonが無い場合は、未通知の状態で開始します。
// 破損したJSONなど、ファイル未存在以外のエラーは隠さず上位へ伝えます。
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { alerted: false, clearSince: null };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 通知済み状態の保存
// ---------------------------------------------------------------------------

// 判定結果を次回の起動へ引き継ぐために保存します。
// 一時ファイルに書いてからrenameすることで、書き込み途中のstate.jsonを
// 次の起動が読んでしまう可能性を減らしています。
// 保存先ディレクトリは700、ファイルは600（所有者のみアクセス可）です。
function saveState(state) {
  fs.mkdirSync(STATE_DIR, {
    recursive: true,
    mode: 0o700
  });

  const temp = `${STATE_PATH}.${process.pid}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(state, null, 2) + '\n',
    { mode: 0o600 }
  );

  fs.renameSync(temp, STATE_PATH);
}

// ---------------------------------------------------------------------------
// Yahoo!気象情報APIから降雨データを取得
// ---------------------------------------------------------------------------

// --fixtureが指定された場合はネットワークを使わず、指定JSONを読み込みます。
// 通常実行では ~/.config/rain-alert/yahoo-appid のClient IDを使います。
// タイムアウトは10秒。HTTPエラーの場合は例外とし、誤って「雨なし」と
// 判定することを防ぎます。
async function loadWeather(fixture) {
  if (fixture) {
    return JSON.parse(fs.readFileSync(fixture, 'utf8'));
  }

  const appid = fs.readFileSync(CONFIG, 'utf8').trim();

  if (!appid) {
    throw new Error('Yahoo Client ID is empty');
  }

  // coordinatesは経度,緯度、interval=5は5分間隔を指定します。
  const url = new URL('https://map.yahooapis.jp/weather/V1/place');

  url.search = new URLSearchParams({
    appid,
    coordinates: COORDINATES,
    output: 'json',
    interval: '5'
  }).toString();

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Yahoo HTTP ${response.status}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// 降雨データを解析
// ---------------------------------------------------------------------------

// APIレスポンスを解析し、通知に必要な3つの情報を返します。
// observedRain : 最新の観測降水強度（mm/h）
// allClear     : 現在の実測がほぼ0、かつ今後60分の予報も閾値未満か
// minutes      : 最初に閾値以上の雨が予測されるまでの分数
//                （60分内に予測がなければnull）
//
// APIのレスポンス形式が予想と違う場合は、誤通知しないよう例外にします。
function getRainInfo(data, nowMs) {
  if (Number(data?.ResultInfo?.Status) !== 200) {
    throw new Error('Yahoo returned an unsuccessful result');
  }

  const list = data?.Feature?.[0]?.Property?.WeatherList?.Weather;

  if (!Array.isArray(list) || !list.length) {
    throw new Error('Missing Weather array');
  }

  // Rainfallを数値に、Dateをタイムスタンプに変換します。
  // 数値が欠落しているときは0と決めつけずエラーにします。
  const rows = list.map((entry) => {
    if (entry.Rainfall === '' || entry.Rainfall == null) {
      throw new Error('Missing rainfall value');
    }

    return {
      type: entry.Type,
      rain: Number(entry.Rainfall),
      timeMs: jstDate(String(entry.Date)).getTime()
    };
  });

  if (rows.some((r) =>
    !Number.isFinite(r.rain) ||
    r.rain < 0 ||
    !Number.isFinite(r.timeMs)
  )) {
    throw new Error('Invalid rainfall response');
  }

  // 観測値が複数あれば日時が最も新しいものを使います。
  const observations = rows
    .filter((r) => r.type === 'observation')
    .sort((a, b) => b.timeMs - a.timeMs);

  if (!observations.length) {
    throw new Error('Missing current observation');
  }

  // 現在より未来、かつ60分以内の予測だけを抽出します。
  // リセット判定では60分先まで見ています。
  const forecasts = rows
    .filter((r) =>
      r.type === 'forecast' &&
      r.timeMs > nowMs &&
      r.timeMs <= nowMs + 60 * 60000
    )
    .sort((a, b) => a.timeMs - b.timeMs);

  if (!forecasts.length) {
    throw new Error('Missing future forecasts');
  }

  // 閾値以上の雨が最初に予測される時刻を探します。
  const firstWet = forecasts.find((r) => r.rain >= RAIN_THRESHOLD);

  const minutes = firstWet
    ? Math.round((firstWet.timeMs - nowMs) / 60000)
    : null;

  return {
    observedRain: observations[0].rain,
    allClear:
      observations[0].rain < CURRENT_DRY_THRESHOLD &&
      forecasts.every((r) => r.rain < RAIN_THRESHOLD),
    minutes
  };
}

// ---------------------------------------------------------------------------
// Google Home Miniへ通知
// ---------------------------------------------------------------------------

// ローカルで起動中のslack2googlehomeの/say APIを利用します。
// Google Homeに直接アクセスする必要はありません。
//
// HTTP成功をもって通知依頼の成功と判断します。
// Google Homeで実際に音声が再生されたことまでは確認できません。
async function notifyHome() {
  const url = new URL('http://127.0.0.1:8080/say');

  url.searchParams.set('text', 'まもなく雨が降りそうです');

  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error(`Local server HTTP ${response.status}`);
  }
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

// 1回の実行の流れ：
//   (1) 起動オプションを確認
//   (2) 日本時間で深夜帯かどうか判定
//   (3) Yahoo!の実測・予測データを取得して解析
//   (4) 前回の通知状態を読み込む
//   (5) 雨が去った状態が続けば通知済みフラグを解除
//   (6) 通知条件がそろえば/sayへリクエスト
//   (7) 状態を保存して終了
async function main() {
  const args = process.argv.slice(2);

  // --fixtureはテスト用JSONファイルを指定する引数です。
  // --dry-runまたは--fixtureの場合は、音を鳴らさず状態も保存しません。
  const fixtureAt = args.indexOf('--fixture');
  const fixture = fixtureAt >= 0 ? args[fixtureAt + 1] : null;

  if (fixtureAt >= 0 && !fixture) {
    throw new Error('--fixture requires a file');
  }

  const dryRun = args.includes('--dry-run') || Boolean(fixture);

  const now = new Date();
  const nowMs = now.getTime();

  // Macのシステムタイムゾーンに依存せず、日本時間の「時」を求めます。
  // 23時以上または7時未満ならquiet=trueです。
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    hourCycle: 'h23'
  }).format(now));

  const quiet = hour >= QUIET_START || hour < QUIET_END;

  const data = await loadWeather(fixture);
  const info = getRainInfo(data, nowMs);

  // dry-runでは実際の通知履歴を変更しません。
  const state = dryRun
    ? { alerted: false, clearSince: null }
    : readState();

  // 30分間、雨なし状態が続いた場合は通知済みフラグを解除します。
  if (info.allClear) {
    if (!state.clearSince) {
      state.clearSince = nowMs;
    }

    if (nowMs - state.clearSince >= CLEAR_RESET_MINUTES * 60000) {
      state.alerted = false;
    }
  } else {
    state.clearSince = null;
  }

  // 次の4条件を満たす場合のみ通知します。
  //   1. 30分以内に一定以上の雨が予測される
  //   2. 現在はほぼ降っていない
  //   3. この降雨イベントではまだ通知していない
  //   4. 深夜帯ではない
  const soon =
    info.minutes !== null &&
    info.minutes <= LOOKAHEAD_MINUTES;

  const shouldAlert =
    info.observedRain < CURRENT_DRY_THRESHOLD &&
    soon &&
    !state.alerted &&
    !quiet;

  // 後から通知の判断理由を確認できるよう、ログに記録します。
  console.log(JSON.stringify({
    time: now.toISOString(),
    observedRain: info.observedRain,
    minutesUntilRain: info.minutes,
    quiet,
    alreadyAlerted: state.alerted,
    shouldAlert,
    dryRun
  }));

  // 通知に成功した後で状態を保存します。
  // HTTP通信に失敗した場合は次回実行で再試行します。
  if (shouldAlert) {
    if (!dryRun) {
      await notifyHome();
    }

    state.alerted = true;

    console.log(dryRun ? 'DRY RUN: would notify' : 'NOTIFIED');
  }

  if (!dryRun) {
    saveState(state);
  }
}

// 通信失敗やAPI形式の変更、設定ファイルの不備をログに記録します。
// 異常終了した場合は終了コード1を返します。
main().catch((error) => {
  console.error('Rain check failed:', error.message);
  process.exitCode = 1;
});

