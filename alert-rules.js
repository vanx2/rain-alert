'use strict';

// ============================================================================
// 通知ルール設定
// ============================================================================
//
// ルールを追加する: rules 配列に新しい設定を1件追加する。
// ルールを停止する: enabled: false にする。
// ルールを削除する: rules 配列から該当要素を削除する。
//
// idは通知履歴の管理に使うため、既存ルールのidは変更しないこと。
//
// forecast型のルールは、雨の予測開始までの残り時間が
// minLeadMinutes～maxLeadMinutes の範囲に入ると通知します。
// 同じ降雨イベントでは、各ルールにつき1回だけ通知します。

module.exports = {

  // JR住吉駅付近。Yahoo! APIでは「経度,緯度」の順。
  coordinates: '135.261859,34.719595',

  // 降水強度の判定基準（単位：mm/h）。
  forecastRainThreshold: 0.5,
  observationWetThreshold: 0.1,

  // 実際に雨が降り始めた後の通知停止ルール。
  // enabled: false にすれば、この停止条件を無効化できます。
  rainLock: {
    enabled: true,
    dryMinutes: 60
  },

  // 予報では雨だったが実際には降らなかった場合、
  // 予報から雨が消えた状態が60分続けば通知履歴をリセット。
  forecastClearResetMinutes: 60,

  // 古い実測データでは降雨判定しない。
  maxObservationAgeMinutes: 15,

  // 実測データに欠落があった場合、
  // 「連続して雨がやんだ時間」を数え直す。
  maxObservationGapMinutes: 15,

  // Google Homeを鳴らさない時間帯。
  quietHours: {
    start: 23,
    end: 7
  },

  // ========================================================================
  // 通知ルール一覧
  // ========================================================================
  rules: [

    // ① 雨が降る約1時間前に1回通知
    {
      id: 'forecast_60',
      enabled: true,
      type: 'forecast',
      minLeadMinutes: 50,
      maxLeadMinutes: 60,
      message: '1時間以内に雨が降る予報です'
    },

    // ② 雨が降る約5分前に1回通知
    {
      id: 'forecast_5',
      enabled: true,
      type: 'forecast',
      minLeadMinutes: 0,
      maxLeadMinutes: 5,
      message: '5分以内に雨が降る予報です'
    }

  ]
};
