'use strict';

// ============================================================================
// Yahoo!気象情報API → Google Home 雨通知
// ============================================================================
//
// 通知条件は隣の alert-rules.js で管理する。
// 各ルールの最終通知時刻を state.json に記録し、
// ルールごとに再通知を制限する。
//
// 実行例:
//   node rain-check.js
//     通常実行（必要なら音声通知）
//
//   node rain-check.js --dry-run
//     APIを取得して判定のみ（通知・保存なし）
//
//   node rain-check.js --fixture test.json --at 2026-11-11T12:00:00+09:00
//     指定したJSONと日時で判定（通知・保存なし）
//
// 22:00〜翌6:59はAPI取得・状態更新・通知を行わず正常終了する。
// Node.js 22の標準機能のみ使用。追加のnpmパッケージは不要。

const fs = require('node:fs');
const path = require('node:path');
const config = require('./alert-rules');

const MINUTE = 60 * 1000;
const APP_DIR = __dirname;
const APPID_PATH = path.join(APP_DIR, 'yahoo-appid');
const STATE_PATH = path.join(APP_DIR, 'state.json');

// ============================================================================
// 設定のチェック
// ============================================================================

function validateRules() {
  const ids = new Set();

  for (const rule of config.rules) {
    if (!rule.id || ids.has(rule.id)) {
      throw new Error(`Empty or duplicate rule id: ${rule.id}`);
    }

    ids.add(rule.id);

    // 現在対応している通知条件は2種類。
    // forecastは複数の時間帯を登録できる。
    if (!['forecast', 'observation_start'].includes(rule.type)) {
      throw new Error(`Unsupported rule type: ${rule.type}`);
    }

    if (
      !Number.isFinite(rule.cooldownMinutes) ||
      rule.cooldownMinutes < 0
    ) {
      throw new Error(`Invalid cooldownMinutes: ${rule.id}`);
    }

    // Yahoo!の予測範囲は最大60分。
    if (rule.type === 'forecast' && (
      !Number.isFinite(rule.minLeadMinutes) ||
      !Number.isFinite(rule.maxLeadMinutes) ||
      rule.minLeadMinutes < 0 ||
      rule.minLeadMinutes >= rule.maxLeadMinutes ||
      rule.maxLeadMinutes > 60
    )) {
      throw new Error(`Invalid forecast range: ${rule.id}`);
    }
  }
}

// ============================================================================
// 日本時間の処理
// ============================================================================

// Yahoo! APIのDateはYYYYMMDDHHmm形式の日本時間。
// JST（UTC+9）としてミリ秒に変換する。
function parseJstTime(value) {
  const s = String(value);

  if (!/^\d{12}$/.test(s)) {
    throw new Error(`Invalid Weather.Date: ${s}`);
  }

  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  const hour = Number(s.slice(8, 10));
  const minute = Number(s.slice(10, 12));

  const ms = Date.UTC(
    year,
    month - 1,
    day,
    hour - 9,
    minute
  );

  // Date.UTCは不正な日付も自動補正するため、
  // 往復変換して元の日付と一致することを確認。
  const roundTrip = new Date(ms + 9 * 60 * MINUTE)
    .toISOString()
    .slice(0, 16);

  const expected =
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` +
    `T${s.slice(8, 10)}:${s.slice(10, 12)}`;

  if (roundTrip !== expected) {
    throw new Error(`Invalid Weather.Date: ${s}`);
  }

  return ms;
}

// 指定時刻が通知・処理停止時間帯か判定。
// Macのシステムタイムゾーンには依存しない。
function isQuiet(nowMs) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(nowMs)));

  const { start, end } = config.quietHours;

  if (start === end) return false;

  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

// ============================================================================
// Yahoo! APIから実測・予測を取得
// ============================================================================

async function loadWeather(fixture) {

  // --fixture指定時はAPIを呼ばない。
  if (fixture) {
    return JSON.parse(fs.readFileSync(fixture, 'utf8'));
  }

  // Client IDはGit管理外のファイルから読み込む。
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
    throw new Error(
      `Yahoo HTTP ${response.status}: ` +
      (await response.text()).slice(0, 300)
    );
  }

  return response.json();
}

// ============================================================================
// 観測値と予測値を抽出
// ============================================================================
//
// observation:
//   最新の降水強度と観測時刻。
//
// forecast:
//   今後60分以内に、最初に降水強度が閾値以上となる時刻。
//
// 予測で雨がない場合、minutesToRainはnull。

function getWeatherInfo(data, nowMs) {

  if (Number(data?.ResultInfo?.Status) !== 200) {
    throw new Error('Yahoo returned an unsuccessful result');
  }

  const weather =
    data?.Feature?.[0]?.Property?.WeatherList?.Weather;

  if (!Array.isArray(weather) || weather.length === 0) {
    throw new Error('Missing Weather array');
  }

  const rows = weather.map((entry) => {

    if (entry.Rainfall == null || entry.Rainfall === '') {
      throw new Error('Missing Rainfall');
    }

    const rain = Number(entry.Rainfall);

    if (!Number.isFinite(rain) || rain < 0) {
      throw new Error('Invalid Rainfall');
    }

    return {
      type: entry.Type,
      timeMs: parseJstTime(entry.Date),
      rain
    };
  });

  // observationが複数ある場合は最新を採用。
  const observation = rows
    .filter((r) => r.type === 'observation')
    .sort((a, b) => b.timeMs - a.timeMs)[0];

  if (!observation) {
    throw new Error('Missing observation');
  }

  // 古すぎる観測値や未来の観測値では判定しない。
  if (
    nowMs - observation.timeMs >
      config.maxObservationAgeMinutes * MINUTE ||
    observation.timeMs - nowMs > 2 * MINUTE
  ) {
    throw new Error('Observation is stale or in the future');
  }

  // 現在より未来、かつ60分以内の予測。
  const forecasts = rows
    .filter((r) =>
      r.type === 'forecast' &&
      r.timeMs > nowMs &&
      r.timeMs <= nowMs + 60 * MINUTE
    )
    .sort((a, b) => a.timeMs - b.timeMs);

  if (forecasts.length === 0) {
    throw new Error('Missing future forecasts');
  }

  // 最初に閾値以上の雨になる予測時刻。
  const firstRain = forecasts.find(
    (r) => r.rain >= config.forecastRainThreshold
  );

  return {
    observationRain: observation.rain,
    observationTime: observation.timeMs,

    // 予測される降雨開始までの残り時間（分）。
    minutesToRain: firstRain
      ? (firstRain.timeMs - nowMs) / MINUTE
      : null
  };
}

// ============================================================================
// state.jsonの管理
// ============================================================================
//
// lastNotifiedAt:
//   ルールIDごとの最終通知日時。
//   例: { forecast_advance: "2026-11-11T03:00:00.000Z" }
//
// lastObservationAt:
//   最後に処理した観測時刻（ミリ秒）。
//
// lastObservationWet:
//   前回の観測が雨だったか。
//   true  = 雨あり
//   false = 雨なし
//   null  = 前回の観測なし
//
// 旧仕様のrainLockは使用しない。

function emptyState() {
  return {
    version: 3,
    lastNotifiedAt: {},
    lastObservationAt: null,
    lastObservationWet: null
  };
}

function normalizeState(raw = {}, nowMs = Date.now()) {
  const state = emptyState();

  if (raw.version === 3) {

    // ルールごとの最終通知時刻を読み込む。
    for (const [id, when] of Object.entries(
      raw.lastNotifiedAt || {}
    )) {
      if (
        typeof when === 'string' &&
        Number.isFinite(Date.parse(when))
      ) {
        state.lastNotifiedAt[id] = when;
      }
    }

    // 過去のルール名で保存した通知履歴があれば引き継ぐ。
    const renamed = {
      forecast_advance: [
        'forecast_60',
        'forecast_early'
      ],
      forecast_soon: [
        'forecast_near',
        'forecast_5',
        'forecast_before'
      ]
    };

    for (const [currentId, aliases] of Object.entries(renamed)) {

      if (!state.lastNotifiedAt[currentId]) {

        for (const oldId of aliases) {
          if (state.lastNotifiedAt[oldId]) {
            state.lastNotifiedAt[currentId] =
              state.lastNotifiedAt[oldId];
            break;
          }
        }
      }
    }

    state.lastObservationAt =
      Number.isFinite(raw.lastObservationAt)
        ? raw.lastObservationAt
        : null;

    state.lastObservationWet =
      typeof raw.lastObservationWet === 'boolean'
        ? raw.lastObservationWet
        : null;

    return state;
  }

  // ------------------------------------------------------------------------
  // 旧state.jsonからの移行
  // ------------------------------------------------------------------------
  //
  // 旧版は通知済みフラグしかなく、
  // 実際の通知時刻が記録されていなかった。
  //
  // 旧版で通知済みなら、移行時点で通知したものとみなし、
  // 60分間の再通知を抑制する。
  //
  // 旧rainLockは新仕様では使わない。

  const previouslySent = raw.sentRules || {};

  const legacyIds = {
    forecast_advance: [
      'forecast_advance',
      'forecast_60',
      'forecast_early'
    ],
    forecast_soon: [
      'forecast_soon',
      'forecast_5',
      'forecast_near',
      'forecast_before'
    ]
  };

  const migratedAt = new Date(nowMs).toISOString();

  for (const rule of config.rules) {

    const aliases = legacyIds[rule.id] || [rule.id];

    if (
      aliases.some((id) => previouslySent[id]) ||
      (
        rule.type === 'forecast' &&
        (raw.alerted || raw.forecastAlerted)
      )
    ) {
      state.lastNotifiedAt[rule.id] = migratedAt;
    }
  }

  // 旧版では直前の雨の有無が分からないため、
  // 初回のobservationだけで「降り始め」とは判断しない。
  return state;
}

function readState(nowMs) {
  try {
    const raw = JSON.parse(
      fs.readFileSync(STATE_PATH, 'utf8')
    );

    return normalizeState(raw, nowMs);

  } catch (err) {
    if (err.code === 'ENOENT') {
      return emptyState();
    }

    throw err;
  }
}

// 一時ファイルに書き込んでから置き換える。
// state.jsonの途中破損を防ぐため。
function saveState(state) {
  const temp = `${STATE_PATH}.${process.pid}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(state, null, 2) + '\n',
    { mode: 0o600 }
  );

  fs.renameSync(temp, STATE_PATH);
}

// ============================================================================
// 通知条件の判定
// ============================================================================

function evaluateAlerts(previous, info, nowMs) {

  const state = normalizeState(previous, nowMs);

  const wet =
    info.observationRain >= config.observationWetThreshold;

  const prevTime = state.lastObservationAt;

  let rainStarted = false;

  if (
    prevTime !== null &&
    info.observationTime < prevTime
  ) {
    throw new Error('Observation time moved backwards');
  }

  // 同じ観測時刻のデータを再処理しない。
  if (
    prevTime === null ||
    info.observationTime > prevTime
  ) {

    // 観測が連続していることを確認。
    // 夜間停止などで観測時刻が大きく空いていた場合は、
    // いつ降り始めたか分からないため通知対象にしない。
    const continuous =
      prevTime !== null &&
      info.observationTime - prevTime <=
        config.maxObservationGapMinutes * MINUTE;

    // 「前回は雨なし」→「今回は雨あり」を検知。
    rainStarted =
      continuous &&
      state.lastObservationWet === false &&
      wet;

    // 次回の判定に使用する観測情報を更新。
    state.lastObservationAt = info.observationTime;
    state.lastObservationWet = wet;
  }

  const due = [];

  // alert-rules.jsのルールを1件ずつ評価。
  for (const rule of config.rules) {

    if (!rule.enabled) {
      continue;
    }

    // --------------------------------------------------------------
    // 再通知の抑制
    // --------------------------------------------------------------
    //
    // このルールの最終通知からcooldownMinutes未満ならスキップ。
    // 他ルールの通知履歴は影響しない。

    const last = state.lastNotifiedAt[rule.id];

    if (
      last &&
      nowMs - Date.parse(last) <
        rule.cooldownMinutes * MINUTE
    ) {
      continue;
    }

    // --------------------------------------------------------------
    // 事前予測・直前予測
    // --------------------------------------------------------------

    if (rule.type === 'forecast') {

      // 実際に雨が降っている場合は予測通知を行わない。
      // 残り時間が各ルールの範囲内なら通知候補にする。
      if (
        !wet &&
        info.minutesToRain !== null &&
        info.minutesToRain > 0 &&
        info.minutesToRain >= rule.minLeadMinutes &&
        info.minutesToRain <= rule.maxLeadMinutes
      ) {
        due.push(rule);
      }

    // --------------------------------------------------------------
    // 降雨開始（observation）
    // --------------------------------------------------------------

    } else if (
      rule.type === 'observation_start' &&
      rainStarted
    ) {
      // 降り続いているだけでは再通知しない。
      // 降雨開始を検知し、クールダウン期間外なら通知。
      due.push(rule);
    }
  }

  return {
    state,
    due,
    rainStarted
  };
}

// ============================================================================
// Google Homeへの通知
// ============================================================================

async function notifyHome(message) {

  // 既存のslack2googlehomeの/say APIを呼び出す。
  const url = new URL('http://127.0.0.1:8080/say');

  url.searchParams.set('text', message);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error(
      `Local server HTTP ${response.status}`
    );
  }
}

// ============================================================================
// メイン処理
// ============================================================================

async function main() {

  const args = process.argv.slice(2);

  const fixtureIndex = args.indexOf('--fixture');
  const atIndex = args.indexOf('--at');

  if (
    fixtureIndex >= 0 &&
    !args[fixtureIndex + 1]
  ) {
    throw new Error('--fixture requires a file');
  }

  if (
    atIndex >= 0 &&
    !args[atIndex + 1]
  ) {
    throw new Error('--at requires a time');
  }

  const fixture =
    fixtureIndex < 0
      ? null
      : args[fixtureIndex + 1];

  if (atIndex >= 0 && !fixture) {
    throw new Error('--at requires --fixture');
  }

  const nowMs =
    atIndex < 0
      ? Date.now()
      : Date.parse(args[atIndex + 1]);

  if (!Number.isFinite(nowMs)) {
    throw new Error('Invalid --at time');
  }

  const dryRun =
    args.includes('--dry-run') || Boolean(fixture);

  // ------------------------------------------------------------------------
  // 夜間の処理停止
  // ------------------------------------------------------------------------
  //
  // 22:00〜6:59はここで終了。
  // Yahoo! API、state.json、Google Homeには一切アクセスしない。
  // --dry-runも同様にスキップする。

  if (isQuiet(nowMs)) {
    console.log('SKIPPED: Quiet hours');
    return;
  }

  // 設定ファイルのルールを検証。
  validateRules();

  // Yahoo! APIから実測・予測データを取得して解析。
  const info = getWeatherInfo(
    await loadWeather(fixture),
    nowMs
  );

  // 前回の通知・観測状態を読み込んで、今回の通知候補を判定。
  const previous = readState(nowMs);

  const { state, due, rainStarted } = evaluateAlerts(
    previous,
    info,
    nowMs
  );

  // ログに判定内容を記録。
  console.log(JSON.stringify({
    time: new Date(nowMs).toISOString(),
    observationRain: info.observationRain,
    minutesToRain: info.minutesToRain,
    rainStarted,
    lastNotifiedAt: state.lastNotifiedAt,
    notifications: due.map((rule) => rule.id),
    dryRun
  }));

  // dry-runでは通知も状態保存も行わない。
  if (dryRun) {

    for (const rule of due) {
      console.log(`DRY RUN: ${rule.id}`);
    }

    return;
  }

  // ------------------------------------------------------------------------
  // Google Homeへの通知
  // ------------------------------------------------------------------------
  //
  // 通知が成功したら、そのルールの通知時刻を保存。
  //
  // 途中で通知に失敗した場合も、
  // 成功した通知の時刻だけは残す。
  //
  // 全通知が完了するまでは前回の観測状態を維持し、
  // 降雨開始通知が失敗した場合に再試行できるようにする。

  const checkpoint = normalizeState(previous, nowMs);

  for (const rule of due) {

    await notifyHome(rule.message);

    const notifiedAt = new Date().toISOString();

    state.lastNotifiedAt[rule.id] = notifiedAt;
    checkpoint.lastNotifiedAt[rule.id] = notifiedAt;

    saveState(checkpoint);

    console.log(`NOTIFIED: ${rule.id}`);
  }

  // 通知がなくても実測状態を更新する。
  // 次回の「雨なし→雨あり」判定に必要。
  saveState(state);
}

// ============================================================================
// 単体テスト用の関数公開
// ============================================================================

module.exports = {
  parseJstTime,
  isQuiet,
  getWeatherInfo,
  normalizeState,
  evaluateAlerts
};

if (require.main === module) {
  main().catch((error) => {
    console.error('Rain check failed:', error.message);
    process.exitCode = 1;
  });
}
