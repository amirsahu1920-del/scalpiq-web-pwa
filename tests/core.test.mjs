import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, atr, momentum } from '../public/js/indicators.js';
import { createPosition, analyze } from '../public/js/strategy.js';
import { MODE, SIDE } from '../public/js/config.js';

test('indicators return finite values', () => {
  const vals = Array.from({length: 80}, (_, i) => 100 + i * 0.1 + Math.sin(i));
  assert.ok(Number.isFinite(ema(vals, 9)));
  assert.ok(Number.isFinite(rsi(vals, 14)));
  assert.ok(Number.isFinite(momentum(vals, 3)));
  const candles = vals.map((v, i) => ({openTime:i, open:v-.2, high:v+.5, low:v-.5, close:v, volume:1000+i, closeTime:i+1}));
  assert.ok(atr(candles, 14) > 0);
});

test('position sizing preserves fixed 2x and 30% notional cap', () => {
  const signal = {symbol:'BTCUSDT', side:SIDE.LONG, confidence:80, regime:'TREND_UP', strategy:'Test', price:100, atr:.5};
  const book = {bid:99.99, ask:100.01, spreadPct:.02, eventTime:1, transactionTime:1, updateId:1};
  const p = createPosition(signal, book, 1000, MODE.NORMAL);
  assert.equal(p.virtualLeverage, 2);
  assert.ok(p.notional <= 300.000001);
  assert.ok(p.stopPrice < p.entryPrice);
  assert.ok(p.tp1 > p.entryPrice);
});

test('inverse mode flips executed side', () => {
  const signal = {symbol:'ETHUSDT', side:SIDE.LONG, confidence:80, regime:'RANGE', strategy:'Test', price:100, atr:.5};
  const book = {bid:99.99, ask:100.01, spreadPct:.02, eventTime:1, transactionTime:1, updateId:1};
  assert.equal(createPosition(signal, book, 1000, MODE.INVERSE).side, SIDE.SHORT);
});

test('analyzer can accept a strong standard signal without multi-confirm gate', () => {
  const candles = Array.from({length:120}, (_, i) => {
    const close = 100 + i * .08;
    return {openTime:i, open:close-.05, high:close+.12, low:close-.12, close, volume:i===119?2200:1000, closeTime:i+1};
  });
  const book = {mid:109.55, spreadPct:.02};
  const depth = {bids:[[109.54,70],[109.53,50]], asks:[[109.56,20],[109.57,15]]};
  const ticker = {symbol:'BTCUSDT', lastPrice:109.55, priceChangePercent:2, quoteVolume:1e9};
  const out = analyze(ticker, candles, book, depth);
  assert.ok(out);
  assert.equal(out.signal.side, SIDE.LONG);
  assert.ok(out.signal.confidence >= 72);
});
