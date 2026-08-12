import { DEFAULT_SETTINGS, SIDE, MODE, REGIME, normalizeSettings } from './config.js';
import * as I from './indicators.js';

const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function bookFromDepth(depth) {
  const [bid = 0, bidQty = 0] = depth.bids?.[0] || [];
  const [ask = 0, askQty = 0] = depth.asks?.[0] || [];
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
  return {
    symbol: depth.symbol, bid, bidQty, ask, askQty,
    eventTime: depth.eventTime || Date.now(), transactionTime: depth.transactionTime || Date.now(),
    updateId: depth.lastUpdateId || 0, mid,
    spreadPct: mid > 0 ? ((ask - bid) / mid) * 100 : 0,
  };
}

export function orderBookImbalance(depth) {
  const b = (depth.bids || []).reduce((s, row) => s + Number(row[1] || 0), 0);
  const a = (depth.asks || []).reduce((s, row) => s + Number(row[1] || 0), 0);
  return b + a === 0 ? 0.5 : b / (b + a);
}

export function analyze(ticker, candles, book, depth, userSettings = DEFAULT_SETTINGS, confirmCandles = null) {
  const settings = normalizeSettings(userSettings);
  if (!candles || candles.length < 60 || book.mid <= 0) return null;
  const closes = candles.map((c) => c.close);
  const price = book.mid;
  const ema9 = I.ema(closes.slice(-60), 9);
  const ema21 = I.ema(closes.slice(-80), 21);
  const ema50 = I.ema(closes.slice(-100), 50);
  const rsi = I.rsi(closes, 14);
  const atr = I.atr(candles, 14);
  const atrPct = price > 0 ? (atr / price) * 100 : 0;
  const vw = I.vwap(candles, 30);
  const volRatio = I.volumeRatio(candles, 20);
  const mom3 = I.momentum(closes, 3);
  const prev20 = candles.slice(0, -1).slice(-20);
  const high20 = prev20.length ? Math.max(...prev20.map((c) => c.high)) : price;
  const low20 = prev20.length ? Math.min(...prev20.map((c) => c.low)) : price;
  const imb = orderBookImbalance(depth);

  let regime;
  if (atrPct > 2.0) regime = REGIME.HIGH_VOLATILITY;
  else if (volRatio < 0.45 && Math.abs(ticker.priceChangePercent) < 0.8) regime = REGIME.DEAD;
  else if (price > high20 && volRatio > 1.15) regime = REGIME.BREAKOUT;
  else if (price < low20 && volRatio > 1.15) regime = REGIME.BREAKOUT;
  else if (ema9 > ema21 && ema21 > ema50 && Math.abs(ema9 - ema21) / price > 0.0007) regime = REGIME.TREND_UP;
  else if (ema9 < ema21 && ema21 < ema50 && Math.abs(ema9 - ema21) / price > 0.0007) regime = REGIME.TREND_DOWN;
  else regime = REGIME.RANGE;

  let long = 0;
  let short = 0;
  const longReasons = [];
  const shortReasons = [];
  if (ema9 > ema21) { long += 16; longReasons.push('EMA 9 > EMA 21'); } else { short += 16; shortReasons.push('EMA 9 < EMA 21'); }
  if (ema21 > ema50) { long += 12; longReasons.push('1m trend bullish'); } else { short += 12; shortReasons.push('1m trend bearish'); }
  if (price > vw) { long += 10; longReasons.push('Price above VWAP'); } else { short += 10; shortReasons.push('Price below VWAP'); }
  if (rsi >= 52 && rsi <= 72) { long += 10; longReasons.push(`RSI momentum ${Math.trunc(rsi)}`); }
  if (rsi >= 28 && rsi <= 48) { short += 10; shortReasons.push(`RSI momentum ${Math.trunc(rsi)}`); }
  if (mom3 > 0.08) { long += 10; longReasons.push(`3-bar momentum +${mom3.toFixed(2)}%`); }
  if (mom3 < -0.08) { short += 10; shortReasons.push(`3-bar momentum ${mom3.toFixed(2)}%`); }
  if (volRatio > 1.20) {
    if (mom3 >= 0) { long += 10; longReasons.push(`Volume expansion ${volRatio.toFixed(1)}x`); }
    else { short += 10; shortReasons.push(`Volume expansion ${volRatio.toFixed(1)}x`); }
  }
  if (price >= high20 * 0.9995) { long += 12; longReasons.push('20-bar breakout pressure'); }
  if (price <= low20 * 1.0005) { short += 12; shortReasons.push('20-bar breakdown pressure'); }
  if (imb > 0.54) { long += 14; longReasons.push(`Order book bids ${(imb * 100).toFixed(0)}%`); }
  if (imb < 0.46) { short += 14; shortReasons.push(`Order book asks ${((1 - imb) * 100).toFixed(0)}%`); }
  if (ticker.priceChangePercent > 0.5) long += 6;
  if (ticker.priceChangePercent < -0.5) short += 6;

  if (regime === REGIME.HIGH_VOLATILITY || regime === REGIME.DEAD) { long *= 0.72; short *= 0.72; }
  if (settings.spreadProtectionEnabled && book.spreadPct > settings.maxSpreadPct) { long *= 0.70; short *= 0.70; }

  const side = long >= short ? SIDE.LONG : SIDE.SHORT;
  const raw = Math.max(long, short);
  const confidence = clamp(50 + raw * 0.5, 50, 98);
  const reasons = side === SIDE.LONG ? longReasons : shortReasons;
  const strategy = regime === REGIME.BREAKOUT ? 'Breakout + Order Flow'
    : (regime === REGIME.TREND_UP || regime === REGIME.TREND_DOWN) ? 'Trend Pullback + Momentum'
      : regime === REGIME.RANGE ? 'VWAP Range Filter' : 'Adaptive Momentum';

  let confirmOk = true;
  if (settings.multiConfirmMode) {
    if (!confirmCandles || confirmCandles.length < 30) confirmOk = false;
    else {
      const cc = confirmCandles.map((c) => c.close);
      const c9 = I.ema(cc, 9);
      const c21 = I.ema(cc, 21);
      confirmOk = side === SIDE.LONG ? c9 >= c21 : c9 <= c21;
      if (confirmOk) reasons.push('5m trend confirmed');
    }
  }

  const strictLiquidityOk = !settings.strictLiquidityMode || (
    Number(ticker.quoteVolume || 0) >= Math.max(settings.quoteVolumeMinMillions * 1_000_000, 50_000_000)
    && book.spreadPct <= Math.min(settings.maxSpreadPct, 0.08)
    && Math.abs(imb - 0.5) >= 0.02
  );
  const deadOk = !settings.deadMarketGuardEnabled || regime !== REGIME.DEAD;
  const volatilityOk = !settings.highVolatilityGuardEnabled || regime !== REGIME.HIGH_VOLATILITY;
  const spreadOk = !settings.spreadProtectionEnabled || book.spreadPct <= settings.maxSpreadPct;
  const confidenceOk = confidence >= settings.confidenceMin;
  const accepted = confidenceOk && spreadOk && deadOk && volatilityOk && strictLiquidityOk && confirmOk;

  let rejectionReason = null;
  if (!deadOk) rejectionReason = 'Dead/low-volume market';
  else if (!volatilityOk) rejectionReason = 'Market shock guard';
  else if (!confidenceOk) rejectionReason = `Confidence below ${settings.confidenceMin.toFixed(0)}%`;
  else if (!spreadOk) rejectionReason = 'Spread protection';
  else if (!strictLiquidityOk) rejectionReason = 'Strict liquidity filter';
  else if (!confirmOk) rejectionReason = '5m confirmation missing';

  const signal = {
    id: uid(), symbol: ticker.symbol, side, confidence, regime, strategy, price, atr,
    spreadPct: book.spreadPct, orderBookImbalance: imb, reasons: reasons.slice(0, 7), createdAt: Date.now(),
    accepted, rejectionReason,
  };
  const candidate = {
    symbol: ticker.symbol, side, score: confidence, regime, price, spreadPct: book.spreadPct,
    note: accepted ? reasons.slice(0, 3).join(' • ') : (rejectionReason || 'Filtered'),
  };
  return { signal, candidate };
}

export function createPosition(signal, book, equity, mode, userSettings = DEFAULT_SETTINGS) {
  const settings = normalizeSettings(userSettings);
  if (equity <= 0 || book.bid <= 0 || book.ask <= 0) return null;
  const rawStopPct = signal.price > 0 ? (signal.atr * 1.20) / signal.price : 0.005;
  const stopPct = clamp(rawStopPct, 0.0025, 0.0100);
  const dynamicSlip = clamp(Math.max(0.00004, (book.spreadPct / 100) * 0.30), 0, 0.0006);
  const entry = signal.side === SIDE.LONG ? book.ask * (1 + dynamicSlip) : book.bid * (1 - dynamicSlip);
  const executedSide = mode === MODE.NORMAL ? signal.side : (signal.side === SIDE.LONG ? SIDE.SHORT : SIDE.LONG);
  const feeRate = settings.paperTakerFeePct / 100;
  const roundTripCostRate = (feeRate * 2) + (dynamicSlip * 2);
  const riskDollars = equity * (settings.riskBudgetPct / 100);
  const lossRateAtStop = stopPct + roundTripCostRate;
  const maxNotional = Math.max(1, equity * (settings.positionNotionalCapPct / 100));
  const minNotional = Math.min(5, maxNotional);
  const notional = clamp(riskDollars / Math.max(lossRateAtStop, 0.000001), minNotional, maxNotional);
  const stopDistance = entry * stopPct;
  const stop = executedSide === SIDE.LONG ? entry - stopDistance : entry + stopDistance;
  const targetR = signal.regime === REGIME.BREAKOUT ? 1.80
    : (signal.regime === REGIME.TREND_UP || signal.regime === REGIME.TREND_DOWN) ? 1.60
      : signal.regime === REGIME.RANGE ? 1.35 : 1.30;
  const targetMovePct = clamp(targetR * lossRateAtStop + roundTripCostRate, stopPct * targetR, stopPct * 2.50);
  const targetDistance = entry * targetMovePct;
  const tp1 = executedSide === SIDE.LONG ? entry + targetDistance : entry - targetDistance;
  return {
    id: uid(), symbol: signal.symbol, side: executedSide, strategy: signal.strategy,
    confidence: signal.confidence, entryPrice: entry, entryTime: Date.now(),
    entryEventTime: book.eventTime, entryTransactionTime: book.transactionTime, entryUpdateId: book.updateId,
    initialStop: stop, stopPrice: stop, tp1, quantity: notional / entry, notional,
    virtualLeverage: settings.virtualLeverage, feeRate, slippageRate: dynamicSlip,
    analyzedSide: signal.side, executionMode: mode, lastPrice: entry, lastObservedAt: Number(book.eventTime || Date.now()),
  };
}
