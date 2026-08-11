export function ema(values, period) {
  if (!values?.length) return 0;
  const k = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i += 1) out = values[i] * k + out * (1 - k);
  return out;
}

export function rsi(values, period = 14) {
  if (!values || values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses += -d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function atr(candles, period = 14) {
  if (!candles || candles.length < 2) return 0;
  const trs = [];
  const start = Math.max(1, candles.length - period);
  for (let i = start; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  return trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : 0;
}

export function vwap(candles, lookback = 30) {
  const slice = (candles || []).slice(-lookback);
  if (!slice.length) return 0;
  let pv = 0;
  let vol = 0;
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
  }
  return vol === 0 ? slice.at(-1)?.close ?? 0 : pv / vol;
}

export function volumeRatio(candles, lookback = 20) {
  if (!candles || candles.length < 3) return 1;
  const latest = candles.at(-1).volume;
  const base = candles.slice(0, -1).slice(-lookback).map((c) => c.volume);
  const avg = base.length ? base.reduce((a, b) => a + b, 0) / base.length : latest;
  return avg <= 0 ? 1 : latest / avg;
}

export function momentum(values, bars = 3) {
  if (!values || values.length <= bars) return 0;
  const old = values[values.length - 1 - bars];
  const now = values.at(-1);
  return old === 0 ? 0 : ((now - old) / old) * 100;
}
