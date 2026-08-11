const ALLOWED = new Set([
  'fapi/v1/exchangeInfo',
  'fapi/v1/ticker/24hr',
  'fapi/v1/klines',
  'fapi/v1/depth',
]);

function headers(source) {
  const h = new Headers();
  h.set('content-type', source.headers.get('content-type') || 'application/json; charset=utf-8');
  h.set('cache-control', 'no-store');
  h.set('access-control-allow-origin', '*');
  h.set('x-scalpiq-proxy', 'cloudflare-pages');
  return h;
}

export async function onRequestGet(context) {
  const parts = Array.isArray(context.params.path) ? context.params.path : [context.params.path].filter(Boolean);
  const path = parts.join('/');
  if (!ALLOWED.has(path)) return new Response('Not found', { status: 404 });

  const incoming = new URL(context.request.url);
  const upstream = new URL(`https://fapi.binance.com/${path}`);
  for (const [k, v] of incoming.searchParams) upstream.searchParams.append(k, v);

  try {
    const r = await fetch(upstream.toString(), { method: 'GET', headers: { accept: 'application/json' } });
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: headers(r) });
  } catch (e) {
    return Response.json({ error: 'Binance proxy fetch failed', detail: String(e?.message || e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': '*' } });
}

export function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, OPTIONS' } });
}
