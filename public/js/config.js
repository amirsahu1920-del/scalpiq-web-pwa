export const CONFIG = Object.freeze({
  REST_DIRECT: 'https://fapi.binance.com',
  REST_PROXY: '/api/binance',
  WS_BASE: 'wss://fstream.binance.com/ws',
});

export const DEFAULT_SETTINGS = Object.freeze({
  // Appearance
  themeMode: 'DARK', // DARK | AMOLED | SYSTEM
  compactMode: false,
  showResearch: true,
  showEngineLog: true,

  // Trading / adaptive mode
  executionModePolicy: 'ADAPTIVE', // ADAPTIVE | NORMAL | INVERSE
  shadowLearningEnabled: true,
  weakShadowGuardEnabled: true,
  adaptiveContinuousLearning: true,
  stickyModeSwitching: true,
  minShadowSamplesPerMode: 25,
  shadowComparisonWindowPerMode: 50,
  modeSwitchAdvantagePct: 20,
  modeSwitchConfirmations: 3,
  shadowExitPolicy: 'TP_SL_ONLY', // TP_SL_ONLY | TP_SL_TIMEOUT
  shadowTimeoutMinutes: 15,

  // Scanner / entry
  scanIntervalSeconds: 12,
  quoteVolumeMinMillions: 20,
  maxScanSymbols: 7,
  confidenceMin: 72,
  maxSpreadPct: 0.12,
  strictLiquidityMode: false,
  multiConfirmMode: false,
  deadMarketGuardEnabled: true,
  highVolatilityGuardEnabled: true,
  spreadProtectionEnabled: true,

  // Position / risk
  maxOpenPositions: 2,
  positionNotionalCapPct: 30,
  riskBudgetPct: 0.30,
  virtualLeverage: 2,
  paperTakerFeePct: 0.05,

  // Protection
  lossCooldownEnabled: true,
  lossStreakThreshold: 2,
  lossCooldownMinutes: 3,
  performanceGuardEnabled: true,
  performanceGuardMinPf: 0.80,
  performanceGuardMinutes: 10,
  drawdownGuardEnabled: true,
  drawdownLimitPct: 2,
  drawdownRecoveryMinutes: 15,

  // Session / recovery
  persistSession: true,
  autoResumeOnLaunch: true,
  reconcileOfflineTrades: true,
});

const n = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const bool = (v, fallback) => typeof v === 'boolean' ? v : fallback;
const oneOf = (v, allowed, fallback) => allowed.includes(v) ? v : fallback;

export function normalizeSettings(value = {}) {
  const d = DEFAULT_SETTINGS;
  return {
    themeMode: oneOf(value.themeMode, ['DARK', 'AMOLED', 'SYSTEM'], d.themeMode),
    compactMode: bool(value.compactMode, d.compactMode),
    showResearch: bool(value.showResearch, d.showResearch),
    showEngineLog: bool(value.showEngineLog, d.showEngineLog),

    executionModePolicy: oneOf(value.executionModePolicy, ['ADAPTIVE', 'NORMAL', 'INVERSE'], d.executionModePolicy),
    shadowLearningEnabled: bool(value.shadowLearningEnabled, d.shadowLearningEnabled),
    weakShadowGuardEnabled: bool(value.weakShadowGuardEnabled, d.weakShadowGuardEnabled),
    adaptiveContinuousLearning: bool(value.adaptiveContinuousLearning, d.adaptiveContinuousLearning),
    stickyModeSwitching: bool(value.stickyModeSwitching, d.stickyModeSwitching),
    minShadowSamplesPerMode: Math.round(clamp(n(value.minShadowSamplesPerMode, d.minShadowSamplesPerMode), 5, 100)),
    shadowComparisonWindowPerMode: Math.round(clamp(n(value.shadowComparisonWindowPerMode, d.shadowComparisonWindowPerMode), 10, 200)),
    modeSwitchAdvantagePct: clamp(n(value.modeSwitchAdvantagePct, d.modeSwitchAdvantagePct), 5, 100),
    modeSwitchConfirmations: Math.round(clamp(n(value.modeSwitchConfirmations, d.modeSwitchConfirmations), 1, 10)),
    shadowExitPolicy: oneOf(value.shadowExitPolicy, ['TP_SL_ONLY', 'TP_SL_TIMEOUT'], d.shadowExitPolicy),
    shadowTimeoutMinutes: clamp(n(value.shadowTimeoutMinutes, d.shadowTimeoutMinutes), 2, 1440),

    scanIntervalSeconds: clamp(n(value.scanIntervalSeconds, d.scanIntervalSeconds), 5, 120),
    quoteVolumeMinMillions: clamp(n(value.quoteVolumeMinMillions, d.quoteVolumeMinMillions), 1, 1000),
    maxScanSymbols: Math.round(clamp(n(value.maxScanSymbols, d.maxScanSymbols), 3, 25)),
    confidenceMin: clamp(n(value.confidenceMin, d.confidenceMin), 50, 98),
    maxSpreadPct: clamp(n(value.maxSpreadPct, d.maxSpreadPct), 0.01, 1.0),
    strictLiquidityMode: bool(value.strictLiquidityMode, d.strictLiquidityMode),
    multiConfirmMode: bool(value.multiConfirmMode, d.multiConfirmMode),
    deadMarketGuardEnabled: bool(value.deadMarketGuardEnabled, d.deadMarketGuardEnabled),
    highVolatilityGuardEnabled: bool(value.highVolatilityGuardEnabled, d.highVolatilityGuardEnabled),
    spreadProtectionEnabled: bool(value.spreadProtectionEnabled, d.spreadProtectionEnabled),

    maxOpenPositions: Math.round(clamp(n(value.maxOpenPositions, d.maxOpenPositions), 1, 6)),
    positionNotionalCapPct: clamp(n(value.positionNotionalCapPct, d.positionNotionalCapPct), 5, 100),
    riskBudgetPct: clamp(n(value.riskBudgetPct, d.riskBudgetPct), 0.05, 3),
    virtualLeverage: Math.round(clamp(n(value.virtualLeverage, d.virtualLeverage), 1, 5)),
    paperTakerFeePct: clamp(n(value.paperTakerFeePct, d.paperTakerFeePct), 0, 0.5),

    lossCooldownEnabled: bool(value.lossCooldownEnabled, d.lossCooldownEnabled),
    lossStreakThreshold: Math.round(clamp(n(value.lossStreakThreshold, d.lossStreakThreshold), 1, 10)),
    lossCooldownMinutes: clamp(n(value.lossCooldownMinutes, d.lossCooldownMinutes), 1, 120),
    performanceGuardEnabled: bool(value.performanceGuardEnabled, d.performanceGuardEnabled),
    performanceGuardMinPf: clamp(n(value.performanceGuardMinPf, d.performanceGuardMinPf), 0.1, 3),
    performanceGuardMinutes: clamp(n(value.performanceGuardMinutes, d.performanceGuardMinutes), 1, 240),
    drawdownGuardEnabled: bool(value.drawdownGuardEnabled, d.drawdownGuardEnabled),
    drawdownLimitPct: clamp(n(value.drawdownLimitPct, d.drawdownLimitPct), 0.5, 25),
    drawdownRecoveryMinutes: clamp(n(value.drawdownRecoveryMinutes, d.drawdownRecoveryMinutes), 1, 480),

    persistSession: bool(value.persistSession, d.persistSession),
    autoResumeOnLaunch: bool(value.autoResumeOnLaunch, d.autoResumeOnLaunch),
    reconcileOfflineTrades: bool(value.reconcileOfflineTrades, d.reconcileOfflineTrades),
  };
}

export const SIDE = Object.freeze({ LONG: 'LONG', SHORT: 'SHORT' });
export const MODE = Object.freeze({ NORMAL: 'NORMAL', INVERSE: 'INVERSE' });
export const REGIME = Object.freeze({
  TREND_UP: 'TREND_UP', TREND_DOWN: 'TREND_DOWN', RANGE: 'RANGE', BREAKOUT: 'BREAKOUT',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY', DEAD: 'DEAD',
});
