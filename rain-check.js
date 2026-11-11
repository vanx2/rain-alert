'use strict';

// ============================================================================
// Yahoo!気象情報API -> Google Home 雨通知
// ============================================================================
//
// 実行方法:
//   node rain-check.js
//     本番実行。必要に応じてGoogle Homeへ通知し、state.jsonを更新。
//
//   node rain-check.js --dry-run
//     実際のAPIを取得して判定するが、通知・状態保存はしない。
//
//   node rain-check.js --fixture sample.json --at 2026-11-11T12:00:00+09:00
//     サンプルJSONを使って指定日時の動作を検証する。
//
// 通知条件は隣のalert-rules.jsで管理します。
// 外部npmパッケージは不要。Node.js 22で動作します。
//
// 処理の流れ:
//   1. Yahoo! APIから観測値と予測値を取得
//   2. 実測値によって「降雨中・降雨後の通知停止」を判定
//   3. 通知停止中でなければ予測通知ルールを評価
//   4. 条件を満たしたルールだけGoogle Homeへ通知
//   5. ルール別の通知履歴をstate.jsonへ保存

const fs = require('node:fs');
const path = require('node:path');
const config = require('./alert-rules');

const APP_DIR = __dirname;
const APPID_PATH = path.join(APP_DIR, 'yahoo-appid');
const STATE_PATH = path.join(APP_DIR, 'state.json');

const MINUTE = 60 * 1000;

// ============================================================================
// 通知ルールの設定チェック
// ============================================================================

function validateRules() {
  const ids = new Set();

  for (const rule of config.rules) {

    // ルールIDは通知履歴のキーなので重複禁止。
    if (!rule.id || ids.has(rule.id)) {
      throw new Error(`Duplicate/empty rule id: ${rule.id}`);
    }

    ids.add(rule.id);

    if (rule.type !== 'forecast') {
      throw new Error(`Unsupported rule type: ${rule.type}`);
    }

    // Yahoo! APIの予測範囲は最大60分。
    if (
      !Number.isFinite(rule.minLeadMinutes) ||
      !Number.isFinite(rule.maxLeadMinutes) ||
      rule.minLeadMinutes < 0 ||
      rule.maxLeadMinutes > 60 ||
      rule.minLeadMinutes >= rule.maxLeadMinutes
    ) {
      throw new Error(`Invalid lead time range: ${rule.id}`);
    }
  }
}

// ============================================================================
// Yahoo! APIの日付処理
// ============================================================================

// Yahoo!のYYYYMMDDHHmmはJSTと解釈してUnix時刻へ変換。
// JSTとUTCの9時間差を補正します。
function parseJstTime(value) {
  const s = String(value);

  if (!/^\d{12}$/.test(s)) {
    throw new Error(`Invalid weather Date: ${s}`);
  }

  const y = +s.slice(0, 4);
  const mo = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  const h = +s.slice(8, 10);
  const mi = +s.slice(10, 12);

  const ms = Date.UTC(y, mo - 1, d, h - 9, mi);

  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid weather Date: ${s}`);
  }

  return ms;
}

// ============================================================================
// Yahoo! APIへのアクセス
// ============================================================================

async function loadWeather(fixture) {

  // 模擬テストの場合はAPI通信を行わない。
  if (fixture) {
    return JSON.parse(fs.readFileSync(fixture, 'utf8'));
  }

  // Client IDはソースコードに埋め込まず別ファイルから取得。
  const appid = fs.readFileSync(APPID_PATH, 'utf8').trim();

  if (!appid) {
    throw new Error('yahoo-appid is empty');
  }

  const url = new URL('https://map.yahooapis.jp/weather/V1/place');

  url.search = new URLSearchParams({
    appid,
    coordinates: config.coordinates,
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

// ============================================================================
// 観測値と予測値の抽出
// ============================================================================

// observation: 最新の降水強度。
// forecast   : 今後60分以内で、最初に降雨閾値を超える時刻。
//
// 古い観測値を使って「雨がやんだ」と誤判定することを防ぐため、
// 実測時刻の新しさもチェックします。
function getWeatherInfo(data, nowMs) {

  if (Number(data?.ResultInfo?.Status) !== 200) {
    throw new Error('Yahoo returned an unsuccessful result');
  }

  const list = data?.Feature?.[0]?.Property?.WeatherList?.Weather;

  if (!Array.isArray(list) || !list.length) {
    throw new Error('Missing Weather array');
  }

  const rows = list.map((entry) => {

    if (entry.Rainfall === '' || entry.Rainfall == null) {
      throw new Error('Missing Rainfall');
    }

    const rain = Number(entry.Rainfall);
    const timeMs = parseJstTime(entry.Date);

    if (!Number.isFinite(rain) || rain < 0) {
      throw new Error('Invalid Rainfall');
    }

    return {
      type: entry.Type,
      rain,
      timeMs
    };
  });

  // 最新のobservationを取得。
  const obs = rows
    .filter((r) => r.type === 'observation')
    .sort((a, b) => b.timeMs - a.timeMs)[0];

  if (!obs) {
    throw new Error('Missing observation');
  }

  // 実測値が古すぎる場合は通知判定をしない。
  if (
    nowMs - obs.timeMs >
      config.maxObservationAgeMinutes * MINUTE ||
    obs.timeMs - nowMs > 2 * MINUTE
  ) {
    throw new Error('Observation is stale or in the future');
  }

  // 現在より未来、かつ60分以内の予測だけを対象とする。
  const forecast = rows
    .filter((r) =>
      r.type === 'forecast' &&
      r.timeMs > nowMs &&
      r.timeMs <= nowMs + 60 * MINUTE
    )
    .sort((a, b) => a.timeMs - b.timeMs);

  if (!forecast.length) {
    throw new Error('Missing future forecasts');
  }

  // 最初に一定以上の雨が予測される時刻を探す。
  const firstWet = forecast.find(
    (r) => r.rain >= config.forecastRainThreshold
  );

  return {
    observationRain: obs.rain,
    observationTime: obs.timeMs,

    firstRainAt: firstWet?.timeMs ?? null,

    // 雨の予測開始までの残り時間（分）。
    minutesToRain: firstWet
      ? (firstWet.timeMs - nowMs) / MINUTE
      : null
  };
}

// ============================================================================
// 状態ファイルの読み書き
// ============================================================================

// sentRules:
//   ルールIDごとの通知済み履歴。
//   例：{ forecast_60: true, forecast_5: true }
//
// rainLock:
//   実測で雨を検知したため通知停止中か。
//
// drySince:
//   雨がやんだ状態が始まった実測時刻。
//
// noForecastSince:
//   降雨予測が消えた状態が始まった時刻。
//
// lastObservationAt:
//   最後に確認できた実測時刻。

function normalizeState(raw = {}) {

  const sentRules = { ...(raw.sentRules || {}) };

  // 旧版state.jsonからの移行。
  // 旧版の通知がすでに行われていた場合は、
  // 新しい通知が重複しないよう両ルールを通知済みにする。
  if (
    !raw.sentRules &&
    (raw.alerted || raw.forecastAlerted)
  ) {
    for (const rule of config.rules) {
      sentRules[rule.id] = true;
    }
  }

  return {
    version: 2,
    sentRules,
    rainLock: Boolean(raw.rainLock),
    drySince: raw.drySince ?? null,
    noForecastSince: raw.noForecastSince ?? null,
    lastObservationAt: raw.lastObservationAt ?? null
  };
}

function readState() {
  try {
    const raw = JSON.parse(
      fs.readFileSync(STATE_PATH, 'utf8')
    );

    return normalizeState(raw);

  } catch (err) {
    if (err.code === 'ENOENT') {
      return normalizeState();
    }

    throw err;
  }
}

// 一時ファイルを経由して状態を保存。
// 途中で処理が落ちてもstate.jsonが壊れにくい方法。
function saveState(state) {
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(state, null, 2) + '\n',
    { mode: 0o600 }
  );

  fs.renameSync(tmp, STATE_PATH);
}

// ============================================================================
// 降雨状態の管理
// ============================================================================

// 実測で雨を検知したらrainLockを有効化。
// 以後、60分連続して雨が降っていないことを確認するまで解除しない。
//
// API取得に失敗して観測データが長時間途切れた場合は、
// その時間を「雨がやんでいた時間」とはみなさず数え直す。
//
// また、雨が実際には降らず予報だけ消えた場合も、
// 60分間予報が消えた状態が続けば通知履歴をリセットする。

function advanceState(previous, info, nowMs) {

  const state = normalizeState(previous);

  const wet =
    info.observationRain >=
    config.observationWetThreshold;

  const last = state.lastObservationAt;

  if (
    last !== null &&
    info.observationTime < last
  ) {
    throw new Error('Observation time moved backwards');
  }

  // 実測データが15分以上飛んだか。
  const gap =
    last !== null &&
    info.observationTime - last >
      config.maxObservationGapMinutes * MINUTE;

  if (!config.rainLock.enabled) {

    // 降雨後の通知停止ルールを無効化した場合。
    state.rainLock = false;
    state.drySince = null;

  } else if (wet) {

    // 雨が降っている。通知停止を維持。
    state.rainLock = true;
    state.drySince = null;

  } else if (state.rainLock) {

    // 雨がやんでいる。
    // 最初の乾燥観測時刻から60分を数える。
    if (state.drySince === null || gap) {
      state.drySince = info.observationTime;
    }

    if (
      info.observationTime - state.drySince >=
      config.rainLock.dryMinutes * MINUTE
    ) {

      // 60分間連続して雨がやんだ。
      // 次の降雨イベントに備えて通知履歴を解除する。
      state.rainLock = false;
      state.drySince = null;
      state.sentRules = {};
    }
  }

  // 降雨しなかった予報の通知履歴をリセットする処理。
  if (!wet && !state.rainLock) {

    if (info.firstRainAt === null) {

      if (state.noForecastSince === null) {
        state.noForecastSince = nowMs;
      }

      if (
        nowMs - state.noForecastSince >=
        config.forecastClearResetMinutes * MINUTE
      ) {
        state.sentRules = {};
      }

    } else {
      state.noForecastSince = null;
    }

  } else {
    state.noForecastSince = null;
  }

  state.lastObservationAt = info.observationTime;

  return state;
}

// ============================================================================
// 夜間の通知抑制
// ============================================================================

function isQuiet(nowMs) {

  // Mac miniのタイムゾーン設定に依存せずJSTで判定。
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      hourCycle: 'h23'
    }).format(new Date(nowMs))
  );

  const { start, end } = config.quietHours;

  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

// ============================================================================
// 通知ルールの評価
// ============================================================================

// 設定ファイルのrules配列を順番に評価します。
// 通知済みのルールは同じ降雨イベントでは実行しません。
function eligibleRules(state, info, nowMs) {

  // 降雨中、降雨後のロック中、夜間は通知しない。
  if (
    state.rainLock ||
    info.observationRain >=
      config.observationWetThreshold ||
    isQuiet(nowMs) ||
    info.minutesToRain === null
  ) {
    return [];
  }

  return config.rules.filter((rule) =>

    // 有効化されたルールのみ。
    rule.enabled &&

    // この雨について未通知であること。
    !state.sentRules[rule.id] &&

    // 雨が降るまでの残り時間が条件内にあること。
    info.minutesToRain > 0 &&
    info.minutesToRain >= rule.minLeadMinutes &&
    info.minutesToRain <= rule.maxLeadMinutes &&

    // 5分前通知がすでに発生した後で、
    // 遅れて「1時間前」通知を出すことを防ぐ。
    !config.rules.some((shorter) =>
      shorter.enabled &&
      shorter.type === 'forecast' &&
      shorter.maxLeadMinutes < rule.maxLeadMinutes &&
      state.sentRules[shorter.id]
    )
  );
}

// ============================================================================
// Google Homeへの音声通知
// ============================================================================

async function notifyHome(message) {

  // 既存のslack2googlehomeをそのまま利用。
  const url = new URL('http://127.0.0.1:8080/say');

  url.searchParams.set('text', message);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error(`Local server HTTP ${response.status}`);
  }
}

// ============================================================================
// メイン処理
// ============================================================================

async function main() {

  validateRules();

  const args = process.argv.slice(2);
  const fixtureIdx = args.indexOf('--fixture');
  const atIdx = args.indexOf('--at');

  if (fixtureIdx >= 0 && !args[fixtureIdx + 1]) {
    throw new Error('--fixture requires a path');
  }

  if (atIdx >= 0 && !args[atIdx + 1]) {
    throw new Error('--at requires an ISO date');
  }

  const fixture =
    fixtureIdx >= 0 ? args[fixtureIdx + 1] : null;

  if (atIdx >= 0 && !fixture) {
    throw new Error('--at requires --fixture');
  }

  const nowMs =
    atIdx >= 0
      ? Date.parse(args[atIdx + 1])
      : Date.now();

  if (!Number.isFinite(nowMs)) {
    throw new Error('Invalid --at timestamp');
  }

  const dryRun =
    args.includes('--dry-run') || Boolean(fixture);

  // Yahoo! APIから現在の観測・予測データを取得。
  const info = getWeatherInfo(
    await loadWeather(fixture),
    nowMs
  );

  // 状態更新を行ってから、通知条件を評価する。
  const state = advanceState(
    readState(),
    info,
    nowMs
  );

  const due = eligibleRules(state, info, nowMs);

  // 通知の判断結果をログに残す。
  console.log(JSON.stringify({
    time: new Date(nowMs).toISOString(),
    observationRain: info.observationRain,
    minutesToRain: info.minutesToRain,
    rainLock: state.rainLock,
    drySince: state.drySince,
    sentRules: state.sentRules,
    notifications: due.map((rule) => rule.id),
    quiet: isQuiet(nowMs),
    dryRun
  }));

  // 通知が失敗しても、降雨ロックの状態は保持する。
  if (!dryRun) {
    saveState(state);
  }

  // 条件に一致した通知ルールを順番に実行。
  for (const rule of due) {

    if (!dryRun) {
      await notifyHome(rule.message);
    }

    // 通知が成功したルールだけ通知済みにする。
    state.sentRules[rule.id] = true;

    if (!dryRun) {
      saveState(state);
    }

    console.log(
      `${dryRun ? 'DRY RUN' : 'NOTIFIED'}: ${rule.id}`
    );
  }
}

// 単体テストから判定関数を呼べるようにしておく。
module.exports = {
  parseJstTime,
  getWeatherInfo,
  normalizeState,
  advanceState,
  eligibleRules,
  isQuiet
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Rain check failed:', err.message);
    process.exitCode = 1;
  });
}
