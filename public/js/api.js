import { CONFIG } from './config.js';

function withTimeout(ms = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

export class BinanceMarketClient {
  constructor(onTransport) {
    this.onTransport = onTransport || (() => {});
    this.exchangeCache = null;
    this.exchangeCacheAt = 0;
  }

  async get(path, params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
    const suffix = q.toString() ? `?${q}` : '';
    const direct = `${CONFIG.REST_DIRECT}${path}${suffix}`;
    const proxy = `${CONFIG.REST_PROXY}${path}${suffix}`;
    let directError;
    try {
      const t = withTimeout();
      const r = await fetch(direct, { signal: t.signal, cache: 'no-store' });
      t.done();
      if (r.ok) {
        this.onTransport('DIRECT');
        return await r.json();
      }
      directError = new Error(`Binance HTTP ${r.status}`);
      if (r.status === 429 || r.status === 418) throw directError;
    } catch (e) { directError = e; }

    try {
      const t = withTimeout(12_000);
      const r = await fetch(proxy, { signal: t.signal, cache: 'no-store' });
      t.done();
      if (!r.ok) throw new Error(`Proxy HTTP ${r.status}: ${await r.text()}`);
      this.onTransport('CLOUDFLARE FALLBACK');
      return await r.json();
    } catch (proxyError) {
      throw new Error(`Market data failed: ${directError?.message || 'direct'}; ${proxyError.message}`);
    }
  }

  async tradingSymbols() {
    if (this.exchangeCache && Date.now() - this.exchangeCacheAt < 15 * 60_000) return this.exchangeCache;
    const root = await this.get('/fapi/v1/exchangeInfo');
    const set = new Set();
    for (const s of root.symbols || []) {
      if (s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.contractType === 'PERPETUAL') set.add(s.symbol);
    }
    this.exchangeCache = set;
    this.exchangeCacheAt = Date.now();
    return set;
  }

  async tickers24h() {
    const arr = await this.get('/fapi/v1/ticker/24hr');
    return (Array.isArray(arr) ? arr : []).map((o) => ({
      symbol: String(o.symbol || ''),
      lastPrice: Number(o.lastPrice || 0),
      priceChangePercent: Number(o.priceChangePercent || 0),
      quoteVolume: Number(o.quoteVolume || 0),
    })).filter((x) => x.symbol && Number.isFinite(x.lastPrice));
  }

  mapKlines(arr) {
    return (Array.isArray(arr) ? arr : []).map((k) => ({
      openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
      close: Number(k[4]), volume: Number(k[5]), closeTime: Number(k[6]),
    }));
  }

  async klines(symbol, interval = '1m', limit = 120) {
    return this.mapKlines(await this.get('/fapi/v1/klines', { symbol, interval, limit }));
  }

  // Used only when restoring an interrupted paper session. Binance allows up to
  // 1500 candles per call, so long outages are paged without inventing missing prices.
  async klinesRange(symbol, interval = '1m', startTime, endTime = Date.now(), maxPages = 60) {
    let cursor = Math.max(0, Number(startTime || 0));
    const end = Math.max(cursor, Number(endTime || Date.now()));
    const out = [];
    for (let page = 0; page < maxPages && cursor <= end; page += 1) {
      const rows = this.mapKlines(await this.get('/fapi/v1/klines', {
        symbol, interval, startTime: cursor, endTime: end, limit: 1500,
      }));
      if (!rows.length) break;
      for (const row of rows) {
        if (!out.length || row.openTime > out[out.length - 1].openTime) out.push(row);
      }
      const next = Number(rows[rows.length - 1].closeTime || 0) + 1;
      if (!(next > cursor) || rows.length < 1500 || next > end) break;
      cursor = next;
    }
    return out;
  }

  async depth(symbol, limit = 20) {
    const o = await this.get('/fapi/v1/depth', { symbol, limit });
    return {
      symbol,
      bids: (o.bids || []).map((r) => [Number(r[0]), Number(r[1])]),
      asks: (o.asks || []).map((r) => [Number(r[0]), Number(r[1])]),
      lastUpdateId: Number(o.lastUpdateId || 0),
      eventTime: Number(o.E || Date.now()),
      transactionTime: Number(o.T || Date.now()),
    };
  }

  subscribeBookTicker(symbol, onTick, onState) {
    const stream = `${symbol.toLowerCase()}@bookTicker`;
    let ws;
    try {
      ws = new WebSocket(`${CONFIG.WS_BASE}/${stream}`);
      ws.onopen = () => onState?.(true);
      ws.onmessage = (ev) => {
        try {
          const o = JSON.parse(ev.data);
          const bid = Number(o.b);
          const ask = Number(o.a);
          if (!(bid > 0 && ask > 0)) return;
          const mid = (bid + ask) / 2;
          onTick({
            symbol: o.s || symbol, bid, bidQty: Number(o.B || 0), ask, askQty: Number(o.A || 0),
            eventTime: Number(o.E || Date.now()), transactionTime: Number(o.T || Date.now()),
            updateId: Number(o.u || 0), mid, spreadPct: ((ask - bid) / mid) * 100,
          });
        } catch {}
      };
      ws.onclose = () => onState?.(false);
      ws.onerror = () => onState?.(false);
    } catch { onState?.(false); }
    return { close: () => { try { ws?.close(); } catch {} } };
  }
}
