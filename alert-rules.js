'use strict';

// ============================================================================
// 雨通知の設定
// ============================================================================
//
// 通知条件を変更する場合は、原則としてこのファイルだけ編集する。
//
// enabled: true       通知を有効にする
// enabled: false      通知を無効にする
// cooldownMinutes     同じルールで再通知するまでの最低時間（分）
//
// forecast型:
//   minLeadMinutes    予測される降雨開始までの最小残り時間
//   maxLeadMinutes    予測される降雨開始までの最大残り時間
//
// observation_start型:
//   観測値が「雨なし」から「雨あり」に変わった際に通知する。
//   降雨が続いているだけでは再通知しない。
//
// ルールIDはstate.jsonの通知履歴に使うため、
// 時間設定を変更してもIDは変更しない。

module.exports = {

  // JR住吉駅付近。経度,緯度の順。
  coordinates: '135.261859,34.719595',
  coordinates: '135.2640184,34.7247423',

  // 降水強度の判定基準（mm/h）。
  forecastRainThreshold: 0.5,
  observationWetThreshold: 0.1,

  // 観測データの鮮度・連続性の判定。
  maxObservationAgeMinutes: 15,
  maxObservationGapMinutes: 15,

  // 22:00〜翌6:59は何もせず終了する。
  // API取得・状態更新・Google Home通知を行わない。
  quietHours: {
    start: 22,
    end: 7
  },

  // ========================================================================
  // 通知ルール一覧
  // ========================================================================

  rules: [

    // ① 事前予測通知
    // 50〜60分以内に雨が降る予報なら通知。
    {
      id: 'forecast_advance',
      enabled: true,
      type: 'forecast',
      minLeadMinutes: 50,
      maxLeadMinutes: 60,
      cooldownMinutes: 60,
      message: '1時間以内に雨'
    },

    // ② 直前予測通知
    // 5分以内に雨が降る予報なら通知。
    {
      id: 'forecast_soon',
      enabled: true,
      type: 'forecast',
      minLeadMinutes: 0,
      maxLeadMinutes: 5,
      cooldownMinutes: 60,
      message: 'もうすぐ雨'
    },

    // ③ 降雨開始通知
    // 前回の観測が雨なし、今回の観測が雨ありなら通知。
    {
      id: 'observation_start',
      enabled: true,
      type: 'observation_start',
      cooldownMinutes: 60,
      message: '雨です'
    }

  ]
};

