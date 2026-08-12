import { SIDE, MODE } from './config.js';
import { BinanceMarketClient } from './api.js';
import { analyze, createPosition, bookFromDepth } from './strategy.js';
import { SessionStore, SettingsStore, TradeStore } from './store.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const money = (v) => `$${Number(v).toFixed(2)}`;
const signedMoney = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(Number(v)).toFixed(2)}`;

export class TradingEngine {
  constructor(onState) {
    this.onState = onState || (() => {});
    this.apiTransport = '--';
    this.market = new BinanceMarketClient((t) => { this.apiTransport = t; });
    this.settings = SettingsStore.load();
    this.state = this.initialState();
    this.scanToken = 0;
    this.symbols = new Set();
    this.sockets = new Map();
    this.lastWsTick = new Map();
    this.cooldownUntil = 0;
    this.executionMode = this.settings.executionModePolicy === 'INVERSE' ? MODE.INVERSE : MODE.NORMAL;
    this.shadowPositions = [];
    this.shadowOutcomes = [];
    this.lastPerformanceGuardTradeCount = 0;
    this.pendingModeCandidate = null;
    this.pendingModeConfirmations = 0;
    this.adaptiveLocked = false;
    this.autoEntriesEnabled = false;
    this.wakeLock = null;
    this.persistTimer = null;
    this.restoredSavedAt = 0;
    this.hasRestoredSession = false;

    this.restoreSavedSnapshot();

    this.pollTimer = setInterval(() => this.pollStalePositionFeeds(), 3_000);
    this.persistHeartbeat = setInterval(() => {
      if (this.state.sessionStartedAt) this.persistNow();
    }, 3_000);

    document.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (this.isSessionActive() || this.needsAnyFeed())) this.requestWakeLock();
      if (document.visibilityState === 'hidden') this.persistNow();
    });
    window.addEventListener?.('pagehide', () => this.persistNow());
    window.addEventListener?.('beforeunload', () => this.persistNow());
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
      cooldownUntil: 0, apiTransport: '--', autoEntriesEnabled: false,
      restoredFromDisk: false, settings: { ...this.settings },
    };
  }

  restoreSavedSnapshot() {
    if (!this.settings.persistSession) return;
    const saved = SessionStore.load();
    if (!saved || ![2, 3, 4].includes(saved.version) || !saved.state?.sessionStartedAt) return;

    const storedTrades = TradeStore.load();
    this.cooldownUntil = Number(saved.cooldownUntil || saved.state.cooldownUntil || 0);
    this.executionMode = saved.executionMode === MODE.INVERSE ? MODE.INVERSE : MODE.NORMAL;
    this.shadowPositions = Array.isArray(saved.shadowPositions) ? saved.shadowPositions : [];
    this.shadowOutcomes = Array.isArray(saved.shadowOutcomes) ? saved.shadowOutcomes.slice(0, 400) : [];
    this.lastPerformanceGuardTradeCount = Number(saved.lastPerformanceGuardTradeCount || 0);
    this.pendingModeCandidate = saved.pendingModeCandidate === MODE.INVERSE ? MODE.INVERSE : saved.pendingModeCandidate === MODE.NORMAL ? MODE.NORMAL : null;
    this.pendingModeConfirmations = Number(saved.pendingModeConfirmations || 0);
    this.adaptiveLocked = !!saved.adaptiveLocked;
    this.autoEntriesEnabled = saved.autoEntriesEnabled !== false && this.settings.autoResumeOnLaunch;
    this.restoredSavedAt = Number(saved.savedAt || Date.now());
    this.hasRestoredSession = true;
    this.applyModePolicy();

    this.state = {
      ...this.initialState(),
      ...saved.state,
      trades: storedTrades.length ? storedTrades : (Array.isArray(saved.state.trades) ? saved.state.trades : []),
      feedConnected: false,
      latencyMs: null,
      apiTransport: '--',
      executionMode: this.executionMode,
      cooldownUntil: this.cooldownUntil,
      autoEntriesEnabled: this.autoEntriesEnabled,
      restoredFromDisk: true, settings: { ...this.settings },
      botStatus: this.autoEntriesEnabled ? 'CONNECTING' : 'STOPPED',
      statusText: this.autoEntriesEnabled
        ? 'Saved paper session restore ho rahi hai...'
        : 'Saved session restored • new trades manually stopped',
    };
    this.state.unrealizedPnl = this.state.activePositions.reduce((s, p) => s + this.unrealized(p), 0);
  }

  persistPayload() {
    const persistedState = {
      ...this.state,
      // Market connection fields are transient and are re-established on launch.
      feedConnected: false,
      latencyMs: null,
      apiTransport: '--',
      autoEntriesEnabled: this.autoEntriesEnabled,
      cooldownUntil: this.cooldownUntil,
      executionMode: this.executionMode,
      // Closed trades already have their own dedicated store; avoid duplicating hundreds of records.
      trades: undefined,
    };
    return {
      version: 4,
      savedAt: Date.now(),
      autoEntriesEnabled: this.autoEntriesEnabled,
      cooldownUntil: this.cooldownUntil,
      executionMode: this.executionMode,
      shadowPositions: this.shadowPositions.slice(0, 400),
      shadowOutcomes: this.shadowOutcomes.slice(0, 400),
      lastPerformanceGuardTradeCount: this.lastPerformanceGuardTradeCount,
      pendingModeCandidate: this.pendingModeCandidate,
      pendingModeConfirmations: this.pendingModeConfirmations,
      adaptiveLocked: this.adaptiveLocked,
      state: persistedState,
    };
  }

  persistNow() {
    if (!this.state.sessionStartedAt) return;
    if (!this.settings.persistSession) { SessionStore.clear(); return; }
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    TradeStore.save(this.state.trades);
    SessionStore.save(this.persistPayload());
  }

  persistSoon() {
    if (!this.state.sessionStartedAt || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 700);
  }

  emit(patch = {}) {
    Object.assign(this.state, patch, {
      executionMode: this.executionMode,
      cooldownUntil: this.cooldownUntil,
      apiTransport: this.apiTransport,
      autoEntriesEnabled: this.autoEntriesEnabled,
      settings: { ...this.settings },
    });
    this.state.unrealizedPnl = this.state.activePositions.reduce((s, p) => s + this.unrealized(p), 0);
    this.onState(this.snapshot());
    this.persistSoon();
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
    return !!(this.autoEntriesEnabled && this.state.sessionStartedAt
      && ['CONNECTING', 'SCANNING', 'RUNNING', 'COOLDOWN', 'ERROR'].includes(this.state.botStatus));
  }

  needsAnyFeed() {
    return this.state.activePositions.length > 0 || this.shadowPositions.length > 0;
  }

  // Desktop/Web build deliberately does not force the screen awake. Keep-screen-on is mobile-only.
  async requestWakeLock() {}
  async releaseWakeLock() { this.wakeLock = null; }

  // Called once by app.js after the UI exists. Restores active/shadow trades, reconciles
  // the offline interval from Binance 1m candles, and resumes scanning if the user did not stop it.
  async bootstrap() {
    if (!this.hasRestoredSession) return;
    this.log(`SESSION RESTORE • Saved ${new Date(this.restoredSavedAt).toLocaleString()} • balance ${money(this.state.realizedBalance)}`);
    if (this.settings.reconcileOfflineTrades) await this.reconcileDowntime();

    const feedSymbols = new Set([
      ...this.state.activePositions.map((p) => p.symbol),
      ...this.shadowPositions.map((p) => p.symbol),
    ]);
    for (const symbol of feedSymbols) this.subscribePosition(symbol);

    if (this.autoEntriesEnabled) {
      const token = ++this.scanToken;
      this.emit({ botStatus: 'CONNECTING', statusText: Date.now() < this.cooldownUntil
        ? 'Saved session restored • cooldown continue ho raha hai'
        : 'Saved session restored • Binance reconnecting...' });
      this.requestWakeLock();
      this.scanLoop(token);
    } else {
      this.emit({ botStatus: 'STOPPED', statusText: this.state.activePositions.length
        ? 'New trades stopped • restored active positions protected hain'
        : 'Saved session restored • new trades manually stopped' });
      if (this.needsAnyFeed()) this.requestWakeLock(); else this.releaseWakeLock();
    }
    this.persistNow();
  }

  start(virtualBalance) {
    const balance = Number(virtualBalance);
    if (!(balance > 0) || this.autoEntriesEnabled || this.state.activePositions.length) return;
    this.scanToken += 1;
    const token = this.scanToken;
    this.cooldownUntil = 0;
    this.executionMode = this.settings.executionModePolicy === 'INVERSE' ? MODE.INVERSE : MODE.NORMAL;
    this.shadowPositions = [];
    this.shadowOutcomes = [];
    this.lastPerformanceGuardTradeCount = 0;
    this.pendingModeCandidate = null;
    this.pendingModeConfirmations = 0;
    this.adaptiveLocked = false;
    this.autoEntriesEnabled = true;
    this.symbols = new Set();
    for (const s of this.sockets.values()) s.close();
    this.sockets.clear();
    this.lastWsTick.clear();
    SessionStore.clear();
    this.state = {
      ...this.initialState(),
      trades: TradeStore.load(), initialBalance: balance, realizedBalance: balance,
      botStatus: 'CONNECTING', statusText: 'Binance Futures live feed connect ho rahi hai...',
      sessionStartedAt: Date.now(), performanceGuardText: this.settings.shadowLearningEnabled ? 'Collecting live evidence' : 'Shadow learning disabled',
      autoEntriesEnabled: true, settings: { ...this.settings },
    };
    this.log(`SESSION START • Virtual balance ${money(balance)} • mode policy ${this.settings.executionModePolicy}`);
    this.persistNow();
    this.requestWakeLock();
    this.scanLoop(token);
  }

  resumeAuto() {
    if (!this.state.sessionStartedAt || this.autoEntriesEnabled) return;
    this.autoEntriesEnabled = true;
    const token = ++this.scanToken;
    this.emit({ botStatus: 'CONNECTING', statusText: Date.now() < this.cooldownUntil
      ? 'Auto resumed • saved cooldown continue ho raha hai'
      : 'Auto resumed • Binance reconnecting...' });
    this.log('AUTO RESUME • New entries enabled by user');
    this.persistNow();
    this.requestWakeLock();
    this.scanLoop(token);
  }

  stopNewTrades() {
    this.autoEntriesEnabled = false;
    this.scanToken += 1;
    this.emit({ botStatus: 'STOPPED', statusText: this.state.activePositions.length
      ? 'New trades stopped • active positions abhi protected hain'
      : 'Bot stopped • saved session retained' });
    this.log('BOT STOP • New entries disabled • session saved');
    this.persistNow();
    if (!this.needsAnyFeed()) this.releaseWakeLock();
  }

  applyModePolicy() {
    if (this.settings.executionModePolicy === 'NORMAL') this.executionMode = MODE.NORMAL;
    else if (this.settings.executionModePolicy === 'INVERSE') this.executionMode = MODE.INVERSE;
  }

  updateSettings(patch = {}) {
    const adaptiveKeys = ['executionModePolicy','shadowComparisonWindowPerMode','minShadowSamplesPerMode','modeSwitchAdvantagePct','modeSwitchConfirmations','adaptiveContinuousLearning','stickyModeSwitching'];
    const adaptiveChanged = Object.keys(patch).some((k) => adaptiveKeys.includes(k));
    this.settings = SettingsStore.save({ ...this.settings, ...patch });
    this.applyModePolicy();
    if (!this.settings.shadowLearningEnabled) {
      this.shadowPositions = [];
      this.pendingModeCandidate = null;
      this.pendingModeConfirmations = 0;
      this.emit({ performanceGuardText: `Mode policy ${this.settings.executionModePolicy}` });
    }
    if (adaptiveChanged) {
      this.adaptiveLocked = false;
      this.refreshShadowStatsAndMode(false);
    }
    if (!this.settings.persistSession) SessionStore.clear();
    this.emit({ settings: { ...this.settings }, executionMode: this.executionMode });
    this.log('SETTINGS UPDATED • saved locally');
    return this.settings;
  }

  applyResearchPreset() {
    this.settings = SettingsStore.save({ ...this.settings,
      executionModePolicy: 'ADAPTIVE', shadowLearningEnabled: true, weakShadowGuardEnabled: true,
      adaptiveContinuousLearning: true, stickyModeSwitching: true, minShadowSamplesPerMode: 25,
      shadowComparisonWindowPerMode: 50, modeSwitchAdvantagePct: 20, modeSwitchConfirmations: 3,
      shadowExitPolicy: 'TP_SL_ONLY', shadowTimeoutMinutes: 15,
    });
    this.pendingModeCandidate = null;
    this.pendingModeConfirmations = 0;
    this.adaptiveLocked = false;
    this.applyModePolicy();
    this.refreshShadowStatsAndMode(false);
    this.emit({ settings: { ...this.settings }, executionMode: this.executionMode });
    this.log('RESEARCH PRESET • 25 minimum • rolling 50/mode • TP/SL-only • sticky continuous adaptive');
    this.persistNow();
    return this.settings;
  }

  resetShadowLearning() {
    this.shadowPositions = [];
    this.shadowOutcomes = [];
    this.pendingModeCandidate = null;
    this.pendingModeConfirmations = 0;
    this.adaptiveLocked = false;
    this.executionMode = this.settings.executionModePolicy === 'INVERSE' ? MODE.INVERSE : MODE.NORMAL;
    this.emit({ shadowNormalPf: 0, shadowInversePf: 0, shadowNormalSamples: 0, shadowInverseSamples: 0,
      performanceGuardText: this.settings.shadowLearningEnabled ? 'Shadow learning reset • collecting fresh TP/SL evidence' : `Mode policy ${this.settings.executionModePolicy}` });
    this.log('SHADOW LEARNING RESET • paper balance and closed trade history retained');
    this.persistNow();
  }

  resetSettings() {
    this.settings = SettingsStore.reset();
    this.pendingModeCandidate = null; this.pendingModeConfirmations = 0; this.adaptiveLocked = false;
    this.applyModePolicy();
    this.emit({ settings: { ...this.settings }, executionMode: this.executionMode });
    this.log('SETTINGS RESET • defaults restored');
    return this.settings;
  }

  resetSavedSession() {
    if (this.autoEntriesEnabled || this.state.activePositions.length) return false;
    SessionStore.clear();
    this.cooldownUntil = 0;
    this.shadowPositions = [];
    this.shadowOutcomes = [];
    this.pendingModeCandidate = null; this.pendingModeConfirmations = 0; this.adaptiveLocked = false;
    this.executionMode = this.settings.executionModePolicy === 'INVERSE' ? MODE.INVERSE : MODE.NORMAL;
    this.state = { ...this.initialState(), trades: TradeStore.load(), settings: { ...this.settings } };
    this.emit();
    return true;
  }

  resetHistory() {
    if (this.state.activePositions.length) return;
    TradeStore.clear();
    this.shadowPositions = [];
    this.shadowOutcomes = [];
    this.pendingModeCandidate = null; this.pendingModeConfirmations = 0; this.adaptiveLocked = false;
    this.emit({ trades: [], signals: [], logs: [], shadowNormalPf: 0, shadowInversePf: 0, shadowNormalSamples: 0, shadowInverseSamples: 0 });
    this.persistNow();
  }

  async scanLoop(token) {
    while (token === this.scanToken && this.autoEntriesEnabled) {
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
        if (token !== this.scanToken || !this.autoEntriesEnabled) return;
        this.emit({ feedConnected: true, botStatus: 'RUNNING', statusText: this.settings.shadowLearningEnabled ? `AUTO ${this.executionMode} • shadow A/B evidence active` : `AUTO ${this.executionMode} • fixed mode policy` });
        await delay(this.settings.scanIntervalSeconds * 1000);
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
      .filter((t) => t.quoteVolume >= this.settings.quoteVolumeMinMillions * 1_000_000)
      .filter((t) => !t.symbol.startsWith('USDCUSDT'))
      .map((t) => {
        const liquidity = Math.min(25, Math.log(1 + t.quoteVolume));
        const motion = Math.min(18, Math.abs(t.priceChangePercent));
        return { t, score: liquidity * 2.1 + motion * 1.7 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, this.settings.maxScanSymbols)
      .map((x) => x.t);

    const raw = [];
    for (const ticker of all) {
      if (token !== this.scanToken) return;
      try {
        const requests = [this.market.klines(ticker.symbol, '1m', 120), this.market.depth(ticker.symbol, 20)];
        if (this.settings.multiConfirmMode) requests.push(this.market.klines(ticker.symbol, '5m', 80));
        const [candles, depth, confirmCandles = null] = await Promise.all(requests);
        const book = bookFromDepth(depth);
        const a = analyze(ticker, candles, book, depth, this.settings, confirmCandles);
        if (a) raw.push(a);
      } catch (e) {
        this.log(`SCAN SKIP ${ticker.symbol} • ${e.message}`);
      }
    }

    const analyses = raw.map((a) => {
      // Entry confidence must stay tied to the CURRENT market setup.
      // Do not feed recent session win-rate back into the signal score: after ~10 trades
      // a weak/short sample could crush a valid 90% raw setup to ~50% and silently stop entries.
      // Shadow A/B performance still learns independently and selects NORMAL/INVERSE execution mode.
      const marketConfidence = this.calibratedConfidence(a.signal.confidence);
      const accepted = a.signal.accepted;
      const signal = {
        ...a.signal, confidence: marketConfidence, accepted,
        rejectionReason: a.signal.rejectionReason,
        reasons: [...a.signal.reasons, `Market confidence ${marketConfidence.toFixed(1)}%`].slice(0, 7),
      };
      return {
        signal,
        candidate: { ...a.candidate, score: marketConfidence, note: accepted ? a.candidate.note : (signal.rejectionReason || a.candidate.note) },
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
    if (best && this.state.activePositions.length < this.settings.maxOpenPositions) await this.openPaperPosition(best.signal);
    else if (!best && candidates.length) this.log(`NO TRADE • Best ${candidates[0].symbol} confidence ${candidates[0].score.toFixed(1)}`);
  }

  calibratedConfidence(raw) {
    // Keep technical confidence stable across long-running sessions.
    // Realized win-rate/PF is already used by the risk guards and Shadow A/B mode selector;
    // using it again as a hard confidence calibration caused the 10-11 trade confidence collapse.
    return Math.min(98, Math.max(50, Number(raw || 0)));
  }

  async openPaperPosition(signal) {
    if (!this.autoEntriesEnabled) return;
    if (this.state.activePositions.length >= this.settings.maxOpenPositions) return;
    if (this.state.activePositions.some((p) => p.symbol === signal.symbol)) return;
    if (Date.now() < this.cooldownUntil) return;
    const depth = await this.market.depth(signal.symbol, 20);
    const book = bookFromDepth(depth);
    if (this.settings.spreadProtectionEnabled && book.spreadPct > this.settings.maxSpreadPct) {
      this.log(`REJECT ${signal.symbol} • spread protection`);
      return;
    }
    const equity = this.state.realizedBalance + this.state.unrealizedPnl;
    const normalPlan = createPosition(signal, book, equity, MODE.NORMAL, this.settings);
    const inversePlan = createPosition(signal, book, equity, MODE.INVERSE, this.settings);
    if (!normalPlan || !inversePlan) return;
    this.applyModePolicy();
    const position = this.executionMode === MODE.NORMAL ? normalPlan : inversePlan;
    if (this.settings.shadowLearningEnabled) {
      // Keep every independent shadow experiment alive until its own exit rule fires.
      // A new signal for the same symbol must not delete an older unresolved A/B sample.
      this.shadowPositions.push(this.toShadow(normalPlan), this.toShadow(inversePlan));
    }
    this.state.activePositions = [...this.state.activePositions, position];
    this.emit();
    this.log(`SIGNAL ${signal.side} → OPEN ${position.side} ${position.symbol} • MODE ${this.executionMode} • ${money(position.notional)} • ${position.confidence.toFixed(1)}% • SL ${this.fmtPrice(position.stopPrice)} • TP1 ${this.fmtPrice(position.tp1)}`);
    this.persistNow();
    this.subscribePosition(position.symbol);
  }

  toShadow(p) {
    return { ...p, id: `${p.id}-${p.executionMode}`, mode: p.executionMode, lastObservedAt: p.lastObservedAt || Date.now() };
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
    const observedAt = Number(book.eventTime || Date.now());
    const p = { ...old, lastPrice: marketExit, lastObservedAt: observedAt };
    const tpReached = p.side === SIDE.LONG ? marketExit >= p.tp1 : marketExit <= p.tp1;
    const stopReached = p.side === SIDE.LONG ? marketExit <= p.stopPrice : marketExit >= p.stopPrice;
    if (tpReached) { this.closePosition(p, marketExit, 'TP1 target'); return; }
    if (stopReached) { this.closePosition(p, marketExit, 'Initial stop'); return; }
    const positions = [...this.state.activePositions];
    positions[idx] = p;
    this.state.activePositions = positions;
    this.emit({ latencyMs: Math.max(0, Date.now() - observedAt) });
  }

  updateShadowPositions(book) {
    const matching = this.shadowPositions.filter((p) => p.symbol === book.symbol);
    const now = Number(book.eventTime || Date.now());
    for (const shadow of matching) {
      const exit = this.exitPriceFor(shadow.side, book, shadow.slippageRate);
      shadow.lastPrice = exit;
      shadow.lastObservedAt = now;
      const tpHit = shadow.side === SIDE.LONG ? exit >= shadow.tp1 : exit <= shadow.tp1;
      const slHit = shadow.side === SIDE.LONG ? exit <= shadow.stopPrice : exit >= shadow.stopPrice;
      const timeoutEnabled = this.settings.shadowExitPolicy === 'TP_SL_TIMEOUT';
      const timedOut = timeoutEnabled && now - shadow.entryTime >= this.settings.shadowTimeoutMinutes * 60_000;
      if (tpHit || slHit || timedOut) this.closeShadow(shadow, exit, now);
    }
    this.persistSoon();
  }

  closeShadow(shadow, exit, closedAt = Date.now()) {
    if (!this.shadowPositions.some((p) => p.id === shadow.id)) return;
    const gross = this.signedPnl(shadow.side, shadow.entryPrice, exit, shadow.quantity);
    const fees = shadow.notional * shadow.feeRate * 2;
    this.shadowOutcomes.unshift({ mode: shadow.mode, netPnl: gross - fees, closedAt });
    this.shadowOutcomes = this.shadowOutcomes.slice(0, 400);
    this.shadowPositions = this.shadowPositions.filter((p) => p.id !== shadow.id);
    this.refreshShadowStatsAndMode(false, closedAt);
    this.persistNow();
  }

  refreshShadowStatsAndMode(forceFallbackFlip = false, baseTime = Date.now()) {
    const windowSize = Math.max(this.settings.minShadowSamplesPerMode, this.settings.shadowComparisonWindowPerMode);
    const normal = this.shadowOutcomes.filter((x) => x.mode === MODE.NORMAL).slice(0, windowSize);
    const inverse = this.shadowOutcomes.filter((x) => x.mode === MODE.INVERSE).slice(0, windowSize);
    const normalPf = this.profitFactor(normal.map((x) => x.netPnl));
    const inversePf = this.profitFactor(inverse.map((x) => x.netPnl));
    const enough = normal.length >= this.settings.minShadowSamplesPerMode && inverse.length >= this.settings.minShadowSamplesPerMode;
    const previous = this.executionMode;

    if (this.settings.executionModePolicy === 'NORMAL') this.executionMode = MODE.NORMAL;
    else if (this.settings.executionModePolicy === 'INVERSE') this.executionMode = MODE.INVERSE;
    else if (this.settings.shadowLearningEnabled && enough && (!this.adaptiveLocked || this.settings.adaptiveContinuousLearning)) {
      const normalAvg = normal.reduce((s, x) => s + x.netPnl, 0) / normal.length;
      const inverseAvg = inverse.reduce((s, x) => s + x.netPnl, 0) / inverse.length;
      const advantage = 1 + (this.settings.modeSwitchAdvantagePct / 100);
      let preferred = null;
      if (normalPf >= 1.05 && normalPf > inversePf * advantage) preferred = MODE.NORMAL;
      else if (inversePf >= 1.05 && inversePf > normalPf * advantage) preferred = MODE.INVERSE;
      else {
        const avgGap = Math.abs(normalAvg - inverseAvg);
        const avgBase = Math.max(0.01, Math.min(Math.abs(normalAvg), Math.abs(inverseAvg)));
        if (avgGap / avgBase >= this.settings.modeSwitchAdvantagePct / 100) preferred = normalAvg > inverseAvg ? MODE.NORMAL : MODE.INVERSE;
      }

      if (preferred === this.executionMode) {
        this.pendingModeCandidate = null; this.pendingModeConfirmations = 0;
        if (!this.settings.adaptiveContinuousLearning) this.adaptiveLocked = true;
      } else if (preferred) {
        if (!this.settings.stickyModeSwitching) {
          this.executionMode = preferred; this.pendingModeCandidate = null; this.pendingModeConfirmations = 0;
          if (!this.settings.adaptiveContinuousLearning) this.adaptiveLocked = true;
        } else {
          if (this.pendingModeCandidate === preferred) this.pendingModeConfirmations += 1;
          else { this.pendingModeCandidate = preferred; this.pendingModeConfirmations = 1; }
          if (this.pendingModeConfirmations >= this.settings.modeSwitchConfirmations) {
            this.executionMode = preferred; this.pendingModeCandidate = null; this.pendingModeConfirmations = 0;
            if (!this.settings.adaptiveContinuousLearning) this.adaptiveLocked = true;
          }
        }
      } else {
        this.pendingModeCandidate = null; this.pendingModeConfirmations = 0;
      }
    }

    // Protection no longer blindly flips mode. A switch must be supported by A/B evidence.
    const bothWeak = this.settings.shadowLearningEnabled && enough && normalPf < 0.80 && inversePf < 0.80;
    const progress = this.pendingModeCandidate ? ` • challenger ${this.pendingModeCandidate} ${this.pendingModeConfirmations}/${this.settings.modeSwitchConfirmations}` : '';
    const guard = bothWeak ? `Both shadow modes weak • protection guard • rolling ${windowSize}/mode`
      : enough ? `Shadow-selected ${this.executionMode} • rolling ${windowSize}/mode${progress}`
        : this.settings.shadowLearningEnabled ? `Shadow learning ${normal.length}/${this.settings.minShadowSamplesPerMode} N • ${inverse.length}/${this.settings.minShadowSamplesPerMode} I • window ${windowSize}` : `Mode policy ${this.settings.executionModePolicy}`;
    if (bothWeak && this.settings.weakShadowGuardEnabled) this.cooldownUntil = Math.max(this.cooldownUntil, Number(baseTime) + this.settings.performanceGuardMinutes * 60_000);
    this.emit({ shadowNormalPf: normalPf, shadowInversePf: inversePf, shadowNormalSamples: normal.length, shadowInverseSamples: inverse.length, performanceGuardText: guard });
    if (previous !== this.executionMode) this.log(`SHADOW SELECT • ${previous} → ${this.executionMode} • N PF ${normalPf.toFixed(2)} • I PF ${inversePf.toFixed(2)} • ${this.settings.modeSwitchAdvantagePct}% edge confirmed`);
  }

  // Reconstruct what happened while the PWA/PC was closed. If both TP and SL lie inside
  // the same 1m candle, the conservative paper assumption is SL (never optimistic guessing).
  historicalTrigger(position, candles, includeTimeout = false) {
    const from = Number(position.lastObservedAt || position.entryTime || 0);
    const timeoutEnabled = includeTimeout && this.settings.shadowExitPolicy === 'TP_SL_TIMEOUT';
    const timeoutAt = Number(position.entryTime || 0) + this.settings.shadowTimeoutMinutes * 60_000;
    for (const c of candles) {
      if (Number(c.closeTime) < from) continue;
      const stopHit = position.side === SIDE.LONG ? c.low <= position.stopPrice : c.high >= position.stopPrice;
      const tpHit = position.side === SIDE.LONG ? c.high >= position.tp1 : c.low <= position.tp1;
      if (stopHit && tpHit) {
        return { type: 'STOP', exitPrice: position.stopPrice, at: c.closeTime, reason: 'Initial stop • offline 1m ambiguous' };
      }
      if (stopHit) return { type: 'STOP', exitPrice: position.stopPrice, at: c.closeTime, reason: 'Initial stop • offline reconcile' };
      if (tpHit) return { type: 'TP', exitPrice: position.tp1, at: c.closeTime, reason: 'TP1 target • offline reconcile' };
      if (timeoutEnabled && timeoutAt <= c.closeTime) {
        return { type: 'TIMEOUT', exitPrice: c.close, at: Math.max(timeoutAt, c.openTime), reason: 'Shadow timeout • offline reconcile' };
      }
    }
    if (timeoutEnabled && timeoutAt <= Date.now()) {
      const last = candles[candles.length - 1];
      if (last) return { type: 'TIMEOUT', exitPrice: last.close, at: Math.max(timeoutAt, last.openTime), reason: 'Shadow timeout • offline reconcile' };
    }
    return null;
  }

  async reconcileDowntime() {
    if (!this.needsAnyFeed()) return;
    const now = Date.now();
    const all = [...this.state.activePositions, ...this.shadowPositions];
    const bySymbol = new Map();
    for (const p of all) {
      const list = bySymbol.get(p.symbol) || [];
      list.push(p);
      bySymbol.set(p.symbol, list);
    }

    const events = [];
    const latestBooks = new Map();
    for (const [symbol, positions] of bySymbol.entries()) {
      try {
        const earliest = Math.min(...positions.map((p) => Number(p.lastObservedAt || p.entryTime || this.restoredSavedAt || now)));
        // Include the previous candle so a close near the shutdown boundary is not missed.
        const start = Math.max(0, earliest - 60_000);
        const candles = await this.market.klinesRange(symbol, '1m', start, now);
        for (const p of this.state.activePositions.filter((x) => x.symbol === symbol)) {
          const hit = this.historicalTrigger(p, candles, false);
          if (hit) events.push({ kind: 'ACTIVE', p, ...hit });
        }
        for (const p of this.shadowPositions.filter((x) => x.symbol === symbol)) {
          const hit = this.historicalTrigger(p, candles, true);
          if (hit) events.push({ kind: 'SHADOW', p, ...hit });
        }
        const depth = await this.market.depth(symbol, 5);
        latestBooks.set(symbol, bookFromDepth(depth));
      } catch (e) {
        this.log(`RESTORE WARNING ${symbol} • ${e.message}`);
      }
    }

    events.sort((a, b) => (a.at - b.at) || (a.kind === 'SHADOW' ? -1 : 1));
    let activeClosed = 0;
    let shadowClosed = 0;
    for (const ev of events) {
      if (ev.kind === 'SHADOW') {
        const liveShadow = this.shadowPositions.find((x) => x.id === ev.p.id);
        if (!liveShadow) continue;
        this.closeShadow(liveShadow, ev.exitPrice, ev.at);
        shadowClosed += 1;
      } else {
        const live = this.state.activePositions.find((x) => x.id === ev.p.id);
        if (!live) continue;
        this.closePosition(live, ev.exitPrice, ev.reason, ev.at);
        activeClosed += 1;
      }
    }

    // Surviving positions are marked to the current Binance book immediately.
    for (const [symbol, book] of latestBooks.entries()) {
      if (this.needsSymbolFeed(symbol)) this.onBookTick(book);
    }

    if (activeClosed || shadowClosed) this.log(`OFFLINE RECONCILE • ${activeClosed} active + ${shadowClosed} shadow outcomes restored`);
    else this.log('OFFLINE RECONCILE • No missed TP/SL detected');
    this.persistNow();
  }

  closePosition(p, exitPrice, reason, closedAt = Date.now()) {
    if (!this.state.activePositions.some((x) => x.id === p.id)) return;
    const exitTime = Number(closedAt || Date.now());
    const gross = this.signedPnl(p.side, p.entryPrice, exitPrice, p.quantity);
    const fees = p.notional * p.feeRate * 2;
    const slippageCost = p.notional * p.slippageRate * 2;
    const net = gross - fees;
    const closed = {
      id: p.id, symbol: p.symbol, side: p.side, strategy: p.strategy, confidence: p.confidence,
      entryPrice: p.entryPrice, entryTime: p.entryTime, exitPrice, exitTime, stopPrice: p.stopPrice,
      tp1: p.tp1, notional: p.notional, quantity: p.quantity, virtualLeverage: p.virtualLeverage,
      grossPnl: gross, fees, slippageCost, netPnl: net, durationMs: Math.max(0, exitTime - p.entryTime),
      exitReason: reason, entryEventTime: p.entryEventTime, entryTransactionTime: p.entryTransactionTime,
      entryUpdateId: p.entryUpdateId, analyzedSide: p.analyzedSide, executionMode: p.executionMode,
    };
    const remaining = this.state.activePositions.filter((x) => x.id !== p.id);
    const losses = net < 0 ? this.state.consecutiveLosses + 1 : 0;
    const trades = [closed, ...this.state.trades].sort((a, b) => b.exitTime - a.exitTime).slice(0, 500);
    const newBalance = this.state.realizedBalance + net;
    this.state.activePositions = remaining;
    this.state.trades = trades;
    this.state.realizedBalance = newBalance;
    this.state.consecutiveLosses = losses;
    TradeStore.save(trades);
    this.emit();
    this.log(`CLOSE ${p.symbol} • ${p.executionMode} • ${signedMoney(net)} • ${reason}`);

    if (this.settings.lossCooldownEnabled && losses >= this.settings.lossStreakThreshold) {
      this.refreshShadowStatsAndMode(false, exitTime);
      this.cooldownUntil = Math.max(this.cooldownUntil, exitTime + this.settings.lossCooldownMinutes * 60_000);
      this.state.consecutiveLosses = 0;
      this.log(`AUTO COOLDOWN • ${this.settings.lossStreakThreshold} consecutive losses • ${this.settings.lossCooldownMinutes} min • mode ${this.executionMode}`);
    }
    this.applyPerformanceGuard(exitTime);
    if (this.settings.drawdownGuardEnabled && this.state.initialBalance > 0 && (newBalance - this.state.initialBalance) / this.state.initialBalance <= -(this.settings.drawdownLimitPct / 100)) {
      this.cooldownUntil = Math.max(this.cooldownUntil, exitTime + this.settings.drawdownRecoveryMinutes * 60_000);
      this.emit({ performanceGuardText: `${this.settings.drawdownLimitPct}% drawdown hit • ${this.settings.drawdownRecoveryMinutes}-min recovery pause` });
      this.log(`DRAWDOWN PAUSE • Session drawdown reached ${this.settings.drawdownLimitPct}% • ${this.settings.drawdownRecoveryMinutes}-minute auto-resume`);
    }
    if (!this.needsSymbolFeed(p.symbol)) { this.sockets.get(p.symbol)?.close(); this.sockets.delete(p.symbol); }
    if (!this.autoEntriesEnabled && !this.needsAnyFeed()) this.releaseWakeLock();
    this.persistNow();
  }

  applyPerformanceGuard(baseTime = Date.now()) {
    if (!this.settings.performanceGuardEnabled) return;
    const session = this.snapshot().sessionTrades;
    if (session.length < 8 || session.length - this.lastPerformanceGuardTradeCount < 4) return;
    const pf = this.profitFactor(session.slice(0, 8).map((t) => t.netPnl));
    if (pf < this.settings.performanceGuardMinPf) {
      this.lastPerformanceGuardTradeCount = session.length;
      this.refreshShadowStatsAndMode(false, baseTime);
      this.cooldownUntil = Math.max(this.cooldownUntil, Number(baseTime) + this.settings.performanceGuardMinutes * 60_000);
      this.emit({ performanceGuardText: `Recent PF ${pf.toFixed(2)} • ${this.settings.performanceGuardMinutes}-min protection` });
      this.log(`PERFORMANCE GUARD • last 8 PF ${pf.toFixed(2)} • ${this.settings.performanceGuardMinutes}-minute cooldown`);
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
