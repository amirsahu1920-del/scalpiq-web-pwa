import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/binance/[[path]].js';

test('proxy rejects non-whitelisted Binance routes', async () => {
  const r = await onRequest({ request: new Request('https://x.test/api/binance/fapi/v1/order'), params: { path: ['fapi','v1','order'] } });
  assert.equal(r.status, 404);
});

test('proxy forwards whitelisted GET query', async () => {
  const oldFetch = globalThis.fetch;
  let seen = '';
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const req = new Request('https://x.test/api/binance/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=120');
    const r = await onRequest({ request: req, params: { path: ['fapi','v1','klines'] } });
    assert.equal(r.status, 200);
    assert.ok(seen.startsWith('https://fapi.binance.com/fapi/v1/klines?'));
    assert.ok(seen.includes('symbol=BTCUSDT'));
  } finally { globalThis.fetch = oldFetch; }
});
