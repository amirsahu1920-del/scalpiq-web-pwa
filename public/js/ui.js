import { UiStore } from './store.js';
import { APP_VERSION, UPDATE_NAME } from './config.js';

const $ = (s) => document.querySelector(s);
const money = (v) => `$${Number(v || 0).toFixed(2)}`;
const signed = (v) => `${Number(v || 0) >= 0 ? '+' : '-'}$${Math.abs(Number(v || 0)).toFixed(2)}`;
const price = (v) => Number(v || 0) >= 1000 ? Number(v).toFixed(2) : Number(v || 0) >= 1 ? Number(v).toFixed(4) : Number(v || 0).toFixed(6);
const clock = (ms) => new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false });
const duration = (ms) => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const esc = (s) => String(s ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));

export class AppUI {
  constructor(engine) {
    this.engine = engine;
    const savedTab = UiStore.load().tab;
    this.tab = ['auto', 'trades', 'settings'].includes(savedTab) ? savedTab : 'auto';
    this.installPrompt = null;
    this.bind();
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); this.installPrompt = e; $('#installBtn')?.classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => { this.installPrompt = null; $('#installBtn')?.classList.add('hidden'); });
  }

  bind() {
    document.addEventListener('click', async (e) => {
      const tab = e.target.closest('[data-tab]')?.dataset.tab;
      if (tab) { this.openTab(tab); return; }
      if (e.target.closest('[data-open-settings]')) { this.openTab('settings'); return; }
      if (e.target.closest('#startBtn') || e.target.closest('#newSessionBtn')) {
        const val = Number($('#balanceInput')?.value || $('#newBalanceInput')?.value);
        if (val > 0) this.engine.start(val);
      }
      if (e.target.closest('#stopBtn')) this.engine.stopNewTrades();
      if (e.target.closest('#resumeBtn')) this.engine.resumeAuto();
      if (e.target.closest('#clearTrades')) this.engine.resetHistory();
      if (e.target.closest('#researchPreset')) { this.engine.applyResearchPreset(); return; }
      if (e.target.closest('#resetShadowLearning')) {
        if (confirm('Shadow A/B learning evidence reset karni hai? Paper balance aur closed trades retain rahenge.')) this.engine.resetShadowLearning();
        return;
      }
      if (e.target.closest('#resetSettings')) {
        if (confirm('All ScalpIQ settings ko defaults par reset karna hai?')) this.engine.resetSettings();
      }
      if (e.target.closest('#resetSavedSession')) {
        if (confirm('Current saved paper session reset karna hai? Closed trade history delete nahi hogi.')) this.engine.resetSavedSession();
      }
      if (e.target.closest('#installBtn')) {
        if (this.installPrompt) { await this.installPrompt.prompt(); await this.installPrompt.userChoice; this.installPrompt = null; }
        else alert('Chrome menu → Cast, save, and share → Install page as app…');
      }
      if (e.target.closest('#apiSave')) {
        sessionStorage.setItem('scalpiq_api_key_draft', $('#apiKey')?.value || '');
        sessionStorage.setItem('scalpiq_api_secret_draft', $('#apiSecret')?.value || '');
        if ($('#apiSave')) $('#apiSave').textContent = 'SAVED THIS SESSION';
      }
      if (e.target.closest('#apiClear')) {
        sessionStorage.removeItem('scalpiq_api_key_draft'); sessionStorage.removeItem('scalpiq_api_secret_draft');
        if ($('#apiKey')) $('#apiKey').value = ''; if ($('#apiSecret')) $('#apiSecret').value = '';
      }
    });

    document.addEventListener('change', (e) => {
      const el = e.target.closest('[data-setting]');
      if (!el) return;
      const key = el.dataset.setting;
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.dataset.valueType === 'number') value = Number(el.value);
      else value = el.value;
      this.engine.updateSettings({ [key]: value });
    });
  }

  openTab(tab) {
    if (!['auto', 'trades', 'settings'].includes(tab)) return;
    this.tab = tab; UiStore.save({ tab }); this.render(this.engine.snapshot());
  }

  render(state) {
    const main = $('#main');
    if (!main) return;
    document.documentElement.dataset.theme = String(state.settings?.themeMode || 'DARK').toLowerCase();
    document.documentElement.classList.toggle('compact', !!state.settings?.compactMode);
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === this.tab));
    if (this.tab === 'trades') main.innerHTML = this.tradesView(state);
    else if (this.tab === 'settings') main.innerHTML = this.settingsView(state);
    else main.innerHTML = this.autoView(state);
  }

  autoView(s) {
    const cooldown = s.cooldownUntil > Date.now() ? Math.ceil((s.cooldownUntil - Date.now()) / 1000) : 0;
    const settings = s.settings || {};
    let control;
    if (s.autoEntriesEnabled) {
      control = `<button id="stopBtn" class="stop-btn">STOP NEW TRADES</button>`;
    } else if (s.sessionStartedAt) {
      control = `<section class="panel start-panel session-control">
        <div class="section-row"><div><span class="eyebrow green">SAVED PAPER SESSION</span><div class="session-balance">${money(s.realizedBalance)}</div></div><span class="tag">${s.activePositions.length ? `${s.activePositions.length} ACTIVE` : 'PAUSED'}</span></div>
        <button id="resumeBtn" class="primary">RESUME SAME SESSION</button>
        <p class="hint">Balance, P&amp;L, cooldown aur Shadow A/B evidence isi session se continue honge.</p>
        <div class="divider"></div>
        <label>New session starting balance</label>
        <div class="money-input"><span>$</span><input id="newBalanceInput" type="number" min="1" step="1" value="${s.initialBalance > 0 ? Number(s.initialBalance).toFixed(2) : '1000'}" ${s.activePositions.length ? 'disabled' : ''}></div>
        <button id="newSessionBtn" class="secondary" ${s.activePositions.length ? 'disabled' : ''}>START FRESH SESSION</button>
        <p class="hint">${s.activePositions.length ? 'Fresh session active positions close hone ke baad available hogi. Existing positions protection mein rahengi.' : 'Fresh session metrics reset karegi; closed trade evidence history safe rahegi.'}</p>
      </section>`;
    } else {
      control = `<section class="panel start-panel"><label>Virtual Balance</label><div class="money-input"><span>$</span><input id="balanceInput" type="number" min="1" step="1" value="${s.initialBalance > 0 ? s.initialBalance : 1000}"></div><button id="startBtn" class="primary">START FULL AUTO</button><p class="hint">Coin, direction, amount, SL/TP aur exit bot automatically manage karta hai.</p></section>`;
    }

    return `
      <section class="hero"><div class="brand-row"><div class="logo">S↑</div><div class="brand-copy"><h1>ScalpIQ</h1><p>BINANCE FUTURES • PAPER AUTO SCALPER • WEB/PWA</p></div><button class="icon-btn" data-open-settings title="Settings" aria-label="Settings">⚙</button><div class="live-pill ${s.feedConnected ? 'ok' : ''}"><i></i>${s.feedConnected ? 'LIVE DATA' : 'OFFLINE'}</div></div></section>
      ${control}
      <section class="panel status-panel"><div class="status-head"><div><span class="dot ${s.feedConnected ? 'ok' : ''}"></span><b>${esc(s.botStatus)}</b></div><span>${s.latencyMs ?? '--'}ms</span></div><div class="status-text">${esc(s.statusText)}</div>${s.consecutiveLosses ? `<div class="warn">Loss streak: ${s.consecutiveLosses}/${settings.lossStreakThreshold || 2}</div>` : ''}${cooldown ? `<div class="warn">Auto resume in ${Math.floor(cooldown/60)}m ${cooldown%60}s</div>` : ''}<div class="transport">REST: ${esc(s.apiTransport)}</div></section>
      <section class="metrics"><div class="metric"><span>EQUITY</span><b class="${s.totalNetPnl >= 0 ? 'green' : 'red'}">${money(s.equity)}</b></div><div class="metric"><span>NET P&amp;L</span><b class="${s.totalNetPnl >= 0 ? 'green' : 'red'}">${signed(s.totalNetPnl)}</b></div><div class="metric"><span>WIN RATE</span><b>${s.winRate.toFixed(1)}%</b></div><div class="metric"><span>PROFIT FACTOR</span><b>${s.profitFactor >= 99 ? '∞' : s.profitFactor.toFixed(2)}</b></div></section>
      ${s.sessionStartedAt ? `<section class="panel"><div class="section-row"><span class="eyebrow green">EXECUTION MODE</span><span class="tag green">${s.executionMode}</span></div><div class="two"><div><small>Normal shadow PF</small><b>${s.shadowNormalPf.toFixed(2)} (${s.shadowNormalSamples})</b></div><div><small>Inverse shadow PF</small><b>${s.shadowInversePf.toFixed(2)} (${s.shadowInverseSamples})</b></div></div><p class="hint">${esc(s.performanceGuardText)}</p></section>` : ''}
      ${s.activePositions.length ? `<h3 class="section-title">ACTIVE PAPER TRADES</h3>${s.activePositions.map((p) => this.activeCard(p)).join('')}` : ''}
      ${settings.showResearch && s.candidates.length ? `<h3 class="section-title">AUTO RESEARCH • BEST SETUPS</h3>${s.candidates.slice(0,5).map((c) => this.candidateCard(c, settings.confidenceMin || 80)).join('')}` : ''}
      ${settings.showEngineLog && s.logs.length ? `<h3 class="section-title">ENGINE LOG</h3><section class="panel logs">${s.logs.slice(0,8).map((l) => `<div class="${/ERROR|LOSS|RISK|DRAWDOWN/.test(l) ? 'red' : ''}">${esc(l)}</div>`).join('')}</section>` : ''}
    `;
  }

  activeCard(p) {
    const pnl = p.side === 'LONG' ? (p.lastPrice - p.entryPrice) * p.quantity : (p.entryPrice - p.lastPrice) * p.quantity;
    return `<section class="panel trade-card"><div class="trade-head"><div><strong>${p.symbol}</strong> <span class="tag ${p.side === 'LONG' ? 'green' : 'red'}">${p.side}</span></div><b class="${pnl >= 0 ? 'green' : 'red'}">${signed(pnl)}</b></div><p class="hint">${esc(p.strategy)} • ${Number(p.confidence).toFixed(1)}% • ${p.executionMode}</p><p class="mini">Signal ${p.analyzedSide} → Executed ${p.side}</p><div class="two"><div><small>Entry</small><b>${price(p.entryPrice)}</b></div><div><small>Now</small><b>${price(p.lastPrice)}</b></div><div><small>Position</small><b>${money(p.notional)}</b></div><div><small>Virtual Lev.</small><b>${p.virtualLeverage}x</b></div><div><small>Stop</small><b>${price(p.stopPrice)}</b></div><div><small>TP1</small><b>${price(p.tp1)}</b></div></div></section>`;
  }

  candidateCard(c, minConfidence) {
    const confidence = Number(c.confidence ?? c.score ?? 0);
    const quality = Number(c.score ?? 0);
    const vol = Number(c.atr5mPct || 0);
    const qvM = Number(c.quoteVolume || 0) / 1_000_000;
    return `<section class="panel candidate"><div class="trade-head"><strong>${c.symbol}</strong><div><span class="tag ${c.side === 'LONG' ? 'green' : 'red'}">${c.side || '--'}</span> <b class="${confidence >= minConfidence ? 'green' : ''}">${confidence.toFixed(1)}%</b></div></div><p class="hint">${esc(c.regime.replaceAll('_',' '))} • ${esc(c.note)}</p><p class="mini">Quality ${quality.toFixed(1)} • 5m ATR ${vol > 0 ? vol.toFixed(2) + '%' : '--'} • Volume ${qvM >= 1000 ? (qvM/1000).toFixed(1)+'B' : qvM.toFixed(0)+'M'} • spread ${c.spreadPct.toFixed(3)}%</p></section>`;
  }

  tradesView(s) {
    return `<section class="page-head"><div><h2>Trade Evidence</h2><p>Exact paper entry/exit evidence + market timestamps</p></div><button id="clearTrades" class="text-red" ${s.activePositions.length ? 'disabled' : ''}>CLEAR</button></section>${s.trades.length ? s.trades.map((t) => this.closedCard(t)).join('') : '<section class="panel"><p class="hint">Abhi koi closed paper trade nahi.</p></section>'}`;
  }

  closedCard(t) {
    return `<section class="panel trade-card"><div class="trade-head"><div><strong>${t.symbol}</strong> <span class="tag ${t.side === 'LONG' ? 'green' : 'red'}">${t.side}</span></div><b class="${t.netPnl >= 0 ? 'green' : 'red'}">${signed(t.netPnl)}</b></div><p class="hint">${esc(t.strategy)} • ${Number(t.confidence).toFixed(1)}% • ${t.executionMode}</p><p class="mini">Signal ${t.analyzedSide || '--'} → Executed ${t.side}</p><div class="two"><div><small>Entry</small><b>${price(t.entryPrice)}</b></div><div><small>Exit</small><b>${price(t.exitPrice)}</b></div><div><small>Entry time</small><b>${clock(t.entryTime)}</b></div><div><small>Exit time</small><b>${clock(t.exitTime)}</b></div><div><small>SL</small><b>${price(t.stopPrice)}</b></div><div><small>TP1</small><b>${price(t.tp1)}</b></div><div><small>Notional</small><b>${money(t.notional)}</b></div><div><small>Fees est.</small><b>${money(t.fees)}</b></div><div><small>Duration</small><b>${duration(t.durationMs)}</b></div><div><small>Exit reason</small><b>${esc(t.exitReason)}</b></div></div><p class="evidence">Evidence: event=${t.entryEventTime} • tx=${t.entryTransactionTime} • update=${t.entryUpdateId}</p></section>`;
  }

  settingsView(s) {
    const x = s.settings;
    const api = sessionStorage.getItem('scalpiq_api_key_draft') || '';
    const secret = sessionStorage.getItem('scalpiq_api_secret_draft') || '';
    return `<section class="page-head"><div><h2>Settings</h2><p>${esc(UPDATE_NAME)} • routine strategy, risk, session aur appearance controls.</p></div><span class="tag green">v${esc(APP_VERSION)}</span></section>
      ${this.category('APPEARANCE',
        this.select('Theme', 'themeMode', x.themeMode, [['DARK','Dark'],['AMOLED','AMOLED Black'],['SYSTEM','Follow System']]) +
        this.toggle('Compact layout', 'compactMode', x.compactMode, 'Cards aur spacing compact kare.') +
        this.toggle('Show auto research', 'showResearch', x.showResearch, 'Best setup cards dashboard par show kare.') +
        this.toggle('Show engine log', 'showEngineLog', x.showEngineLog, 'Recent engine events dashboard par show kare.'))}
      ${this.category('MODE & SHADOW A/B',
        this.select('Execution mode policy', 'executionModePolicy', x.executionModePolicy, [['ADAPTIVE','Adaptive A/B'],['NORMAL','Force Normal'],['INVERSE','Force Inverse']]) +
        `<div class="notice research-note"><b>Research default:</b> 25 minimum samples • rolling 50/mode • TP/SL-only • continuous sticky adaptive.</div><button id="researchPreset" class="secondary full">APPLY RESEARCH DEFAULTS</button>` +
        this.toggle('Shadow learning', 'shadowLearningEnabled', x.shadowLearningEnabled, 'NORMAL aur INVERSE parallel paper evidence collect kare.') +
        this.toggle('Continuous adaptive learning', 'adaptiveContinuousLearning', x.adaptiveContinuousLearning, 'Winner lock nahi hota; rolling evidence market regime badle to mode update kar sakta hai.') +
        this.toggle('Sticky mode switching', 'stickyModeSwitching', x.stickyModeSwitching, 'Challenger ko multiple confirmations ke baghair current winner replace na karne dein.') +
        this.number('Minimum samples / mode', 'minShadowSamplesPerMode', x.minShadowSamplesPerMode, 5, 100, 1, '') +
        this.number('Comparison window / mode', 'shadowComparisonWindowPerMode', x.shadowComparisonWindowPerMode, 10, 200, 5, 'latest completed samples') +
        this.number('Switch advantage', 'modeSwitchAdvantagePct', x.modeSwitchAdvantagePct, 5, 100, 5, '% better evidence') +
        this.number('Switch confirmations', 'modeSwitchConfirmations', x.modeSwitchConfirmations, 1, 10, 1, 'new shadow outcomes') +
        this.select('Shadow exit policy', 'shadowExitPolicy', x.shadowExitPolicy, [['TP_SL_ONLY','TP / SL only (recommended research)'],['TP_SL_TIMEOUT','TP / SL or timeout']]) +
        this.number('Shadow timeout', 'shadowTimeoutMinutes', x.shadowTimeoutMinutes, 2, 1440, 1, 'min • ignored in TP/SL-only mode') +
        this.toggle('Weak-shadow guard', 'weakShadowGuardEnabled', x.weakShadowGuardEnabled, 'Dono shadow modes weak hon to protective cooldown.'))}
      ${this.category('SCANNER & ENTRY',
        `<div class="notice"><b>High Quality defaults:</b> 80% confidence • 12 sec • 100M USDT • 12 coins • 0.06% max spread.</div>` +
        this.number('Minimum confidence', 'confidenceMin', x.confidenceMin, 50, 95, 1, '%') +
        this.number('Scan interval', 'scanIntervalSeconds', x.scanIntervalSeconds, 5, 60, 1, 'sec') +
        this.number('Min 24h quote volume', 'quoteVolumeMinMillions', x.quoteVolumeMinMillions, 20, 1000, 25, 'M USDT') +
        this.number('Coins per scan', 'maxScanSymbols', x.maxScanSymbols, 5, 30, 1, '') +
        this.number('Max spread', 'maxSpreadPct', x.maxSpreadPct, 0.02, 0.20, 0.01, '%') +
        this.toggle('Spread protection', 'spreadProtectionEnabled', x.spreadProtectionEnabled, 'Reject Trade – Spread Too Wide.') +
        this.toggle('Dead-market guard', 'deadMarketGuardEnabled', x.deadMarketGuardEnabled, 'Weak movement/activity ko independent dead-market check se reject kare.') +
        this.toggle('Strict liquidity mode', 'strictLiquidityMode', x.strictLiquidityMode, '24h volume ke sath spread + top-20 order-book executable depth check kare.') +
        this.toggle('5m multi-confirm', 'multiConfirmMode', x.multiConfirmMode, 'Existing 1m signal ko 5m EMA structure/momentum se confirm kare.'))}
      ${this.category('VOLATILITY FILTER',
        this.toggle('Volatility Filter', 'volatilityFilterEnabled', x.volatilityFilterEnabled, '5m ATR(14)% se slow/dead coins ko trade candidate banne se roke.') +
        this.number('Minimum 5m Volatility', 'minVolatility5mPct', x.minVolatility5mPct, 0.10, 2.00, 0.05, '% ATR(14)') +
        this.toggle('High-volatility guard', 'highVolatilityGuardEnabled', x.highVolatilityGuardEnabled, 'Existing market-shock detector + maximum safe 5m ATR threshold se extreme pump/dump block kare.') +
        this.number('Maximum Safe Volatility', 'maxSafeVolatilityPct', x.maxSafeVolatilityPct, 0.50, 10.00, 0.10, '% 5m ATR(14)'))}
      ${this.category('POSITION & RISK',
        this.number('Max active positions', 'maxOpenPositions', x.maxOpenPositions, 1, 6, 1, '') +
        this.number('Position notional cap', 'positionNotionalCapPct', x.positionNotionalCapPct, 5, 100, 1, '% equity') +
        this.number('Planned risk budget', 'riskBudgetPct', x.riskBudgetPct, 0.05, 3, 0.05, '% equity') +
        this.number('Virtual leverage', 'virtualLeverage', x.virtualLeverage, 1, 5, 1, 'x') +
        this.number('Paper taker fee estimate', 'paperTakerFeePct', x.paperTakerFeePct, 0, 0.5, 0.01, '% / side'))}
      ${this.category('PROTECTION',
        this.toggle('Loss-streak cooldown', 'lossCooldownEnabled', x.lossCooldownEnabled, 'Consecutive losses ke baad pause.') +
        this.number('Loss streak trigger', 'lossStreakThreshold', x.lossStreakThreshold, 1, 10, 1, 'losses') +
        this.number('Loss cooldown', 'lossCooldownMinutes', x.lossCooldownMinutes, 1, 120, 1, 'min') +
        this.toggle('Performance PF guard', 'performanceGuardEnabled', x.performanceGuardEnabled, 'Recent PF weak ho to protective pause.') +
        this.number('PF guard threshold', 'performanceGuardMinPf', x.performanceGuardMinPf, 0.1, 3, 0.05, '') +
        this.number('PF guard cooldown', 'performanceGuardMinutes', x.performanceGuardMinutes, 1, 240, 1, 'min') +
        this.toggle('Drawdown guard', 'drawdownGuardEnabled', x.drawdownGuardEnabled, 'Session drawdown limit par recovery pause.') +
        this.number('Drawdown limit', 'drawdownLimitPct', x.drawdownLimitPct, 0.5, 25, 0.5, '%') +
        this.number('Drawdown recovery', 'drawdownRecoveryMinutes', x.drawdownRecoveryMinutes, 1, 480, 1, 'min'))}
      ${this.category('SESSION & RECOVERY',
        this.toggle('Persist session', 'persistSession', x.persistSession, 'Balance, P&L, active trades, cooldown, selected mode, challenger progress aur shadow evidence save kare.') +
        this.toggle('Auto resume on launch', 'autoResumeOnLaunch', x.autoResumeOnLaunch, 'App/tab reopen par scanner automatically continue kare.') +
        this.toggle('Offline trade reconciliation', 'reconcileOfflineTrades', x.reconcileOfflineTrades, 'Downtime ke Binance 1m candles se missed TP/SL reconcile kare.'))}
      ${this.category('BINANCE API • OPTIONAL', `<div class="notice">Paper engine public market data use karta hai; live order placement disabled hai. Web fields sirf current browser session mein rehte hain.</div><label>API Key</label><input id="apiKey" class="field" value="${esc(api)}"><label>Secret Key</label><input id="apiSecret" class="field" type="password" value="${esc(secret)}"><div class="button-row"><button id="apiSave" class="secondary">SAVE SESSION API</button><button id="apiClear" class="ghost">REMOVE</button></div>`)}
      <section class="panel danger-zone"><h3>MAINTENANCE</h3><button id="resetShadowLearning" class="ghost">RESET SHADOW LEARNING ONLY</button><button id="resetSettings" class="ghost">RESET SETTINGS TO DEFAULTS</button><button id="resetSavedSession" class="ghost" ${s.autoEntriesEnabled || s.activePositions.length ? 'disabled' : ''}>RESET SAVED SESSION</button><p class="hint">Saved session reset closed Trade Evidence history ko delete nahi karta.</p></section>`;
  }

  category(title, body) { return `<section class="panel settings-card"><h3>${esc(title)}</h3>${body}</section>`; }
  toggle(label, key, checked, note = '') { return `<label class="setting-row"><div><b>${esc(label)}</b>${note ? `<small>${esc(note)}</small>` : ''}</div><span class="switch"><input type="checkbox" data-setting="${key}" ${checked ? 'checked' : ''}><i></i></span></label>`; }
  number(label, key, value, min, max, step, suffix) { return `<label class="setting-row"><div><b>${esc(label)}</b>${suffix ? `<small>${esc(suffix)}</small>` : ''}</div><input class="setting-number" type="number" data-setting="${key}" data-value-type="number" value="${value}" min="${min}" max="${max}" step="${step}"></label>`; }
  select(label, key, value, options) { return `<label class="setting-row"><div><b>${esc(label)}</b></div><select class="setting-select" data-setting="${key}">${options.map(([v,n]) => `<option value="${v}" ${v===value?'selected':''}>${esc(n)}</option>`).join('')}</select></label>`; }
}
