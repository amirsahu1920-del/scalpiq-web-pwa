# ScalpIQ Web/PWA — Cloudflare Pages

A browser/PWA port of the latest ScalpIQ paper auto-scalper logic.

## Current locked behavior
- Paper trading only; no live Binance orders.
- Binance USD-M Futures public market data.
- Strict Liquidity Mode: OFF.
- Multi-Confirm Entry Mode: OFF.
- Fixed virtual leverage: 2x.
- Auto coin, direction, strategy, amount, SL, TP1, exit.
- 30% equity max notional and ~0.30% planned risk budget.
- Shadow A/B NORMAL vs INVERSE auto-selection.
- TP1-only full close, no TP2/trailing.
- 2 consecutive losses: 3-minute cooldown.
- Recent 8-trade PF < 0.80: 10-minute performance guard.
- 2% session drawdown: 15-minute pause then automatic resume.
- Maximum 2 paper positions.
- Closed trade history persists locally in the browser.

## Cloudflare Pages settings
- Framework preset: None
- Production branch: main
- Build command: `exit 0` (or leave blank)
- Build output directory: `public`
- Root directory: leave blank

The `/functions` folder is intentionally at repository root. It provides a same-origin fallback proxy for Binance REST calls if direct browser REST access fails. The app tries direct Binance REST first to minimize Pages Functions usage. WebSocket book-ticker data connects directly to Binance, with REST depth polling as a fallback when a live WebSocket is stale.

## Local test (optional)
Node 18+:

```bash
npm test
npm run check
```

Cloudflare local preview (optional):

```bash
npm run dev
```

## Important runtime note
A PWA is not a 24/7 cloud bot. Keep the ScalpIQ window open and the PC awake. Closing the app/browser or shutting down/sleeping the PC stops the browser engine.
