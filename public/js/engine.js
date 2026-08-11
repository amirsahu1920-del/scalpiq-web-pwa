import { CONFIG, SIDE, MODE } from './config.js';
import { BinanceMarketClient } from './api.js';
import { analyze, createPosition, bookFromDepth } from './strategy.js';
import { TradeStore } from './store.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const money = (v) => `$${Number(v).toFixed(2)}`;
const signedMoney = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(Number(v)).toFixed(2)}`;

export class TradingEngine {
  constructor(onState) {
    this.onState = onState || (() => {});
    this.apiTransport = '--';
    this.market = new BinanceMarketClient((t) => { this.apiTransport = t; });
    this.state = this.initialState();
    this.scanToken = 0;
    this.symbols = new Set();
    this.sockets = new Map();
    this.lastWsTick = new Map();
    this.cooldownUntil = 0;
    this.executionMode = MODE.NORMAL;
    this.shadowPositions = [];
    this.shadowOutcomes = [];
    this.lastPerformanceGuardTradeCount = 0;
    this.wakeLock = null;
    this.pollTimer = setInterval(() => this.pollStalePositionFeeds(), 3_000);
    document.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.isSessionActive()) this.requestWakeLock();
    });
  }

  initialState() {
    return {
      initialBalance: 0, realizedBalance: 0, unrealizedPnl: 0,
      botStatus: 'IDLE', statusText: 'Virtual balance enter karein aur Start dabayein',
      feedConnected: false, latencyMs: null, activePositions: [], trades: TradeStore.load(),
      signals: [], candidates: [], logs: [], consecutiveLosses: 0,
      executionMode: MODE.NORMAL, shadowNormalPf: 0, shadowInversePf: 0,
      shadowNormalSamples: 0, shadowInverseSamples: 0,
      performanceGuardText: 'Collecting live evidence', sessionStartedAt: null,
      cooldownUntil: 0, apiTransport: '--',
    };
  }

  emit(patch = {}) {
    Object.assign(this.state, patch, { executionMode: this.executionMode, cooldownUntil: this.cooldownUntil, apiTransport: this.apiTransport });
    this.state.unrealizedPnl = this.state.activePositions.reduce((s, p) => s + this.unrealized(p), 0);
    this.onState(this.snapshot());
  }

  snapshot() {
    const s = this.state;
    const sessionTrades = s.sessionStartedAt ? s.trades.filter((t) => t.entryTime >= s.sessionStartedAt) : s.trades;
    const wins = sessionTrades.filter((t) => t.netPnl > 0).length;
    const losses = sessionTrades.filter((t) => t.netPnl < 0).length;
    const winRate = sessionTrades.length ? (wins * 100) / sessionTrades.length : 0;
    const pf = this.profitFactor(sessionTrades.map((t) => t.netPnl));
    return {
      ...s, activePositions: [...s.activePositions], trades: [...s.trades], signals: [...s.signals],
      candidates: [...s.candidates], logs: [...s.logs],
      equity: s.realizedBalance + s.unrealizedPnl,
      totalNetPnl: s.realizedBalance - s.initialBalance,
      sessionTrades, wins, losses, winRate, profitFactor: pf,
    };
  }

  isSessionActive() {
    return this.state.sessionStartedAt && ['CONNECTING', 'SCANNING', 'RUNNING', 'COOLDOWN'].includes(this.state.botStatus);
  }

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      }
    } catch {}
  }

  async releaseWakeLock() {
    try { await this.wakeLock?.release(); } catch {}
    this.wakeLock = null;
  }

  start(virtualBalance) {
    const balance = Number(virtualBalance);
    if (!(balance > 0) || this.isSessionActive()) return;
    this.scanToken += 1;
    const token = this.scanToken;
    this.cooldownUntil = 0;
    this.executionMode = MODE.NORMAL;
    this.shadowPositions = [];
    this.shadowOutcomes = [];
    this.lastPerformanceGuardTradeCount = 0;
    this.symbols = new Set();
    for (const s of this.sockets.values()) s.close();
    this.sockets.clear();
    this.lastWsTick.clear();
    this.state = {
      ...this.initialState(),
      trades: TradeStore.load(), initialBalance: balance, realizedBalance: balance,
      botStatus: 'CONNECTING', statusText: 'Binance Futures live feed connect ho rahi hai...',
      sessionStartedAt: Date.now(), performanceGuardText: 'Collecting live evidence',
    };
    this.log(`SESSION START • Virtual balance ${money(balance)} • Shadow A/B starts NORMAL`);
    this.requestWakeLock();
    this.scanLoop(token);
  }

  stopNewTrades() {
    this.scanToken += 1;
    this.emit({ botStatus: 'STOPPED', statusText: this.state.activePositions.length ? 'New trades stopped • active positions abhi protected hain' : 'Bot stopped' });
    this.log('BOT STOP • New entries disabled');
    if (!this.state.activePositions.length) this.releaseWakeLock();
  }

  resetHistory() {
    if (this.state.activePositions.length) return;
    TradeStore.clear();
    this.shadowPositions = [];
    this.shadowOutcomes = [];
    this.emit({ trades: [], signals: [], logs: [], shadowNormalPf: 0, shadowInversePf: 0, shadowNormalSamples: 0, shadowInverseSamples: 0 });
  }

  async scanLoop(token) {
    while (token === this.scanToken) {
      if (!this.symbols.size) {
        try {
          this.symbols = await this.market.tradingSymbols();
          this.emit({ feedConnected: true, botStatus: 'RUNNING', statusText: `Auto market scanner • ${this.symbols.size} USDT perpetual markets available` });
          this.log(`BINANCE CONNECTED • ${this.symbols.size} tradable USDT perpetual symbols`);
        } catch (e) {
          this.log(`CONNECT ERROR • ${e.message}`);
          this.emit({ botStatus: 'ERROR', feedConnected: false, statusText: 'Binance reconnecting...' });
          await delay(5_000);
          continue;
        }
      }

      if (Date.now() < this.cooldownUntil) {
        const left = Math.max(0, Math.floor((this.cooldownUntil - Date.now()) / 1000));
        this.emit({ botStatus: 'COOLDOWN', statusText: `Risk cooldown • ${left}s remaining • mode ${this.executionMode}` });
        await delay(2_000);
        continue;
      }

      try {
        this.emit({ botStatus: 'SCANNING', statusText: 'Market + regime + signal scan...' });
        await this.scanOnce(token);
        if (token !== this.scanToken) return;
        this.emit({ feedConnected: true, botStatus: 'RUNNING', statusText: `AUTO ${this.executionMode} • shadow A/B evidence active` });
        await delay(CONFIG.SCAN_INTERVAL_MS);
      } catch (e) {
        this.log(`FEED ERROR • ${e.message}`);
        this.symbols = new Set();
        this.emit({ botStatus: 'ERROR', feedConnected: false, statusText: 'Feed interrupted • auto reconnecting' });
        await delay(5_000);
      }
    }
  }

  async scanOnce(token) {
    const started = Date.now();
    const tickers = await this.market.tickers24h();
    if (token !== this.scanToken) return;
    const all = tickers
      .filter((t) => this.symbols.has(t.symbol))
      .filter((t) => t.quoteVolume >= CONFIG.QUOTE_VOLUME_MIN)
      .filter((t) => !t.symbol.startsWith('USDCUSDT'))
      .map((t) => {
        const liquidity = Math.min(25, Math.log(1 + t.quoteVolume));
        const motion = Math.min(18, Math.abs(t.priceChangePercent));
        return { t, score: liquidity * 2.1 + motion * 1.7 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, CONFIG.MAX_SCAN_SYMBOLS)
      .map((x) => x.t);

    const raw = [];
    for (const ticker of all) {
      if (token !== this.scanToken) return;
      try {
        const [candles, depth] = await Promise.all([
          this.market.klines(ticker.symbol, '1m', 120),
          this.market.depth(ticker.symbol, 20),
        ]);
        const book = bookFromDepth(depth);
        const a = analyze(ticker, candles, book, depth);
        if (a) raw.push(a);
      } catch (e) {
        this.log(`SCAN SKIP ${ticker.symbol} • ${e.message}`);
      }
    }

    const analyses = raw.map((a) => {
      const calibrated = this.calibratedConfidence(a.signal.confidence);
      const accepted = a.signal.accepted && calibrated >= 70;
      const signal = {
        ...a.signal, confidence: calibrated, accepted,
        rejectionReason: a.signal.accepted && calibrated < 70 ? 'Calibrated confidence below 70%' : a.signal.rejectionReason,
        reasons: [...a.signal.reasons, `Calibrated ${calibrated.toFixed(1)}%`].slice(0, 7),
      };
      return {
        signal,
        candidate: { ...a.candidate, score: calibrated, note: accepted ? a.candidate.note : (signal.rejectionReason || a.candidate.note) },
      };
    });

    const candidates = analyses.map((a) => a.candidate).sort((a, b) => b.score - a.score).slice(0, 7);
    const newSignals = analyses.map((a) => a.signal).sort((a, b) => b.confidence - a.confidence);
    const signals = [...newSignals, ...this.state.signals].filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i).slice(0, 120);
    this.emit({ candidates, signals, latencyMs: Date.now() - started });

    const best = analyses
      .filter((a) => a.signal.accepted)
      .filter((a) => !this.state.activePositions.some((p) => p.symbol === a.signal.symbol))
      .sort((a, b) => b.signal.confidence - a.signal.confidence)[0];
    if (best && this.state.activePositions.length < CONFIG.MAX_OPEN_POSITIONS) await this.openPaperPosition(best.signal);
    else if (!best && candidates.length) this.log(`NO TRADE • Best ${candidates[0].symbol} calibrated ${candidates[0].score.toFixed(1)}`);
  }

  calibratedConfidence(raw) {
    const recent = this.snapshot().sessionTrades.slice(0, 30);
    if (recent.length < 10) return raw;
    let sample = recent.filter((t) => Math.abs(t.confidence - raw) <= 8);
    if (sample.length < 8) sample = recent;
    if (sample.length < 8) return raw;
    const empiricalWin = (sample.filter((t) => t.netPnl > 0).length * 100) / sample.length;
    return Math.min(95, Math.max(50, raw * 0.35 + empiricalWin * 0.65));
  }

  async openPaperPosition(signal) {
    if (this.state.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) return;
    if (this.state.activePositions.some((p) => p.symbol === signal.symbol)) return;
    if (Date.now() < this.cooldownUntil) return;
    const depth = await this.market.depth(signal.symbol, 20);
    const book = bookFromDepth(depth);
    if (book.spreadPct > CONFIG.MAX_SPREAD_PCT) {
      this.log(`REJECT ${signal.symbol} • spread protection`);
      return;
    }
    const equity = this.state.realizedBalance + this.state.unrealizedPnl;
    const normalPlan = createPosition(signal, book, equity, MODE.NORMAL);
    const inversePlan = createPosition(signal, book, equity, MODE.INVERSE);
    if (!normalPlan || !inversePlan) return;
    const position = this.executionMode === MODE.NORMAL ? normalPlan : inversePlan;
    this.shadowPositions = this.shadowPositions.filter((p) => p.symbol !== signal.symbol);
    this.shadowPositions.push(this.toShadow(normalPlan), this.toShadow(inversePlan));
    this.state.activePositions = [...this.state.activePositions, position];
    this.emit();
    this.log(`SIGNAL ${signal.side} → OPEN ${position.side} ${position.symbol} • MODE ${this.executionMode} • ${money(position.notional)} • ${position.confidence.toFixed(1)}% • SL ${this.fmtPrice(position.stopPrice)} • TP1 ${this.fmtPrice(position.tp1)}`);
    this.subscribePosition(position.symbol);
  }

  toShadow(p) {
    return { ...p, id: `${p.id}-${p.executionMode}`, mode: p.executionMode };
  }

  subscribePosition(symbol) {
    this.sockets.get(symbol)?.close();
    const sock = this.market.subscribeBookTicker(symbol,
      (tick) => { this.lastWsTick.set(symbol, Date.now()); this.onBookTick(tick); },
      (connected) => {
        if (connected) this.emit({ feedConnected: true });
        else if (this.needsSymbolFeed(symbol)) setTimeout(() => { if (this.needsSymbolFeed(symbol)) this.subscribePosition(symbol); }, 2_000);
      });
    this.sockets.set(symbol, sock);
  }

  async pollStalePositionFeeds() {
    const symbols = new Set([
      ...this.state.activePositions.map((p) => p.symbol),
      ...this.shadowPositions.map((p) => p.symbol),
    ]);
    for (const symbol of symbols) {
      if (Date.now() - (this.lastWsTick.get(symbol) || 0) < 8_000) continue;
      try {
        const depth = await this.market.depth(symbol, 5);
        this.onBookTick(bookFromDepth(depth));
      } catch {}
    }
  }

  needsSymbolFeed(symbol) {
    return this.state.activePositions.some((p) => p.symbol === symbol) || this.shadowPositions.some((p) => p.symbol === symbol);
  }

  onBookTick(book) {
    this.updateShadowPositions(book);
    const idx = this.state.activePositions.findIndex((p) => p.symbol === book.symbol);
    if (idx < 0) {
      if (!this.needsSymbolFeed(book.symbol)) { this.sockets.get(book.symbol)?.close(); this.sockets.delete(book.symbol); }
      return;
    }
    const old = this.state.activePositions[idx];
    const marketExit = this.exitPriceFor(old.side, book, old.slippageRate);
    const p = { ...old, lastPrice: marketExit };
    const tpReached = p.side === SIDE.LONG ? marketExit >= p.tp1 : marketExit <= p.tp1;
    const stopReached = p.side === SIDE.LONG ? marketExit <= p.stopPrice : marketExit >= p.stopPrice;
    if (tpReached) { this.closePosition(p, marketExit, 'TP1 target'); return; }
    if (stopReached) { this.closePosition(p, marketExit, 'Initial stop'); return; }
    const positions = [...this.state.activePositions];
    positions[idx] = p;
    this.state.activePositions = positions;
    this.emit({ latencyMs: Math.max(0, Date.now() - (book.eventTime || Date.now())) });
  }

  updateShadowPositions(book) {
    const matching = this.shadowPositions.filter((p) => p.symbol === book.symbol);
    const now = Date.now();
    for (const shadow of matching) {
      const exit = this.exitPriceFor(shadow.side, book, shadow.slippageRate);
      const tpHit = shadow.side === SIDE.LONG ? exit >= shadow.tp1 : exit <= shadow.tp1;
      const slHit = shadow.side === SIDE.LONG ? exit <= shadow.stopPrice : exit >= shadow.stopPrice;
      const timedOut = now - shadow.entryTime >= CONFIG.SHADOW_TIMEOUT_MS;
      if (tpHit || slHit || timedOut) {
        const gross = this.signedPnl(shadow.side, shadow.entryPrice, exit, shadow.quantity);
        const fees = shadow.notional * shadow.feeRate * 2;
        this.shadowOutcomes.unshift({ mode: shadow.mode, netPnl: gross - fees, closedAt: now });
        this.shadowOutcomes = this.shadowOutcomes.slice(0, 80);
        this.shadowPositions = this.shadowPositions.filter((p) => p.id !== shadow.id);
        this.refreshShadowStatsAndMode(false);
      }
    }
  }

  refreshShadowStatsAndMode(forceFallbackFlip = false) {
    const normal = this.shadowOutcomes.filter((x) => x.mode === MODE.NORMAL).slice(0, 20);
    const inverse = this.shadowOutcomes.filter((x) => x.mode === MODE.INVERSE).slice(0, 20);
    const normalPf = this.profitFactor(normal.map((x) => x.netPnl));
    const inversePf = this.profitFactor(inverse.map((x) => x.netPnl));
    const enough = normal.length >= CONFIG.MIN_SHADOW_SAMPLES_PER_MODE && inverse.length >= CONFIG.MIN_SHADOW_SAMPLES_PER_MODE;
    const previous = this.executionMode;
    if (enough) {
      const normalAvg = normal.reduce((s, x) => s + x.netPnl, 0) / normal.length;
      const inverseAvg = inverse.reduce((s, x) => s + x.netPnl, 0) / inverse.length;
      if (normalPf >= 1.05 && normalPf > inversePf * 1.12) this.executionMode = MODE.NORMAL;
      else if (inversePf >= 1.05 && inversePf > normalPf * 1.12) this.executionMode = MODE.INVERSE;
      else if (normalAvg > inverseAvg * 1.20) this.executionMode = MODE.NORMAL;
      else if (inverseAvg > normalAvg * 1.20) this.executionMode = MODE.INVERSE;
    } else if (forceFallbackFlip) {
      this.executionMode = this.executionMode === MODE.NORMAL ? MODE.INVERSE : MODE.NORMAL;
    }
    const bothWeak = enough && normalPf < 0.80 && inversePf < 0.80;
    const guard = bothWeak ? 'Both shadow modes weak • extended cooldown on guard'
      : enough ? `Shadow-selected ${this.executionMode}`
        : `Shadow learning ${normal.length}/${CONFIG.MIN_SHADOW_SAMPLES_PER_MODE} N • ${inverse.length}/${CONFIG.MIN_SHADOW_SAMPLES_PER_MODE} I`;
    this.emit({ shadowNormalPf: normalPf, shadowInversePf: inversePf, shadowNormalSamples: normal.length, shadowInverseSamples: inverse.length, performanceGuardText: guard });
    if (previous !== this.executionMode) this.log(`SHADOW SELECT • ${previous} → ${this.executionMode} • N PF ${normalPf.toFixed(2)} • I PF ${inversePf.toFixed(2)}`);
    if (bothWeak) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + CONFIG.PERFORMANCE_COOLDOWN_MS);
  }

  closePosition(p, exitPrice, reason) {
    const gross = this.signedPnl(p.side, p.entryPrice, exitPrice, p.quantity);
    const fees = p.notional * p.feeRate * 2;
    const slippageCost = p.notional * p.slippageRate * 2;
    const net = gross - fees;
    const closed = {
      id: p.id, symbol: p.symbol, side: p.side, strategy: p.strategy, confidence: p.confidence,
      entryPrice: p.entryPrice, entryTime: p.entryTime, exitPrice, exitTime: Date.now(), stopPrice: p.stopPrice,
      tp1: p.tp1, notional: p.notional, quantity: p.quantity, virtualLeverage: p.virtualLeverage,
      grossPnl: gross, fees, slippageCost, netPnl: net, durationMs: Date.now() - p.entryTime,
      exitReason: reason, entryEventTime: p.entryEventTime, entryTransactionTime: p.entryTransactionTime,
      entryUpdateId: p.entryUpdateId, analyzedSide: p.analyzedSide, executionMode: p.executionMode,
    };
    const remaining = this.state.activePositions.filter((x) => x.id !== p.id);
    const losses = net < 0 ? this.state.consecutiveLosses + 1 : 0;
    const trades = [closed, ...this.state.trades].slice(0, 500);
    const newBalance = this.state.realizedBalance + net;
    this.state.activePositions = remaining;
    this.state.trades = trades;
    this.state.realizedBalance = newBalance;
    this.state.consecutiveLosses = losses;
    TradeStore.save(trades);
    this.emit();
    this.log(`CLOSE ${p.symbol} • ${p.executionMode} • ${signedMoney(net)} • ${reason}`);

    if (losses >= 2) {
      this.refreshShadowStatsAndMode(true);
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + CONFIG.LOSS_COOLDOWN_MS);
      this.state.consecutiveLosses = 0;
      this.log(`AUTO COOLDOWN • 2 consecutive losses • 3 minutes • next mode ${this.executionMode}`);
    }
    this.applyPerformanceGuard();
    if (this.state.initialBalance > 0 && (newBalance - this.state.initialBalance) / this.state.initialBalance <= CONFIG.SESSION_DRAWDOWN_LOCK) {
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + CONFIG.DRAWDOWN_RECOVERY_MS);
      this.emit({ performanceGuardText: '2% drawdown hit • 15-min auto recovery pause' });
      this.log('DRAWDOWN PAUSE • Session drawdown reached 2% • 15-minute auto-resume');
    }
    if (!this.needsSymbolFeed(p.symbol)) { this.sockets.get(p.symbol)?.close(); this.sockets.delete(p.symbol); }
    if (this.state.botStatus === 'STOPPED' && !this.state.activePositions.length) this.releaseWakeLock();
  }

  applyPerformanceGuard() {
    const session = this.snapshot().sessionTrades;
    if (session.length < 8 || session.length - this.lastPerformanceGuardTradeCount < 4) return;
    const pf = this.profitFactor(session.slice(0, 8).map((t) => t.netPnl));
    if (pf < 0.80) {
      this.lastPerformanceGuardTradeCount = session.length;
      this.refreshShadowStatsAndMode(true);
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + CONFIG.PERFORMANCE_COOLDOWN_MS);
      this.emit({ performanceGuardText: `Recent PF ${pf.toFixed(2)} • 10-min protection` });
      this.log(`PERFORMANCE GUARD • last 8 PF ${pf.toFixed(2)} • 10-minute cooldown`);
    }
  }

  profitFactor(values) {
    if (!values?.length) return 0;
    const wins = values.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const losses = -values.filter((x) => x < 0).reduce((a, b) => a + b, 0);
    return losses <= 0 ? (wins > 0 ? 99 : 0) : wins / losses;
  }

  exitPriceFor(side, book, slippageRate) {
    return side === SIDE.LONG ? book.bid * (1 - slippageRate) : book.ask * (1 + slippageRate);
  }
  unrealized(p) { return this.signedPnl(p.side, p.entryPrice, p.lastPrice, p.quantity) - (p.notional * p.feeRate * 2); }
  signedPnl(side, entry, exit, qty) { return side === SIDE.LONG ? (exit - entry) * qty : (entry - exit) * qty; }
  log(message) {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    this.state.logs = [`${time}  ${message}`, ...this.state.logs].slice(0, 160);
    this.emit();
  }
  fmtPrice(v) { return v >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6); }
}
