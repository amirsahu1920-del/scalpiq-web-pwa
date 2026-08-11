import { UiStore } from './store.js';

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
    this.tab = UiStore.load().tab || 'auto';
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
      if (tab) { this.tab = tab; UiStore.save({ tab }); this.render(this.engine.snapshot()); return; }
      if (e.target.closest('#startBtn')) {
        const val = Number($('#balanceInput').value);
        if (val > 0) this.engine.start(val);
      }
      if (e.target.closest('#stopBtn')) this.engine.stopNewTrades();
      if (e.target.closest('#resumeBtn')) this.engine.resumeAuto();
      if (e.target.closest('#clearTrades')) this.engine.resetHistory();
      if (e.target.closest('#installBtn')) {
        if (this.installPrompt) { await this.installPrompt.prompt(); await this.installPrompt.userChoice; this.installPrompt = null; }
        else alert('Chrome menu → Cast, save, and share → Install page as app…');
      }
      if (e.target.closest('#apiSave')) {
        sessionStorage.setItem('scalpiq_api_key_draft', $('#apiKey').value || '');
        sessionStorage.setItem('scalpiq_api_secret_draft', $('#apiSecret').value || '');
        $('#apiSave').textContent = 'SAVED THIS SESSION';
      }
      if (e.target.closest('#apiClear')) {
        sessionStorage.removeItem('scalpiq_api_key_draft'); sessionStorage.removeItem('scalpiq_api_secret_draft');
        $('#apiKey').value = ''; $('#apiSecret').value = ''; $('#apiSave').textContent = 'SAVE THIS SESSION';
      }
    });
  }

  render(state) {
    const main = $('#main');
    if (!main) return;
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === this.tab));
    if (this.tab === 'trades') main.innerHTML = this.tradesView(state);
    else if (this.tab === 'api') main.innerHTML = this.apiView(state);
    else main.innerHTML = this.autoView(state);
  }

  autoView(s) {
    const running = ['CONNECTING','SCANNING','RUNNING','COOLDOWN'].includes(s.botStatus);
    const cooldown = s.cooldownUntil > Date.now() ? Math.ceil((s.cooldownUntil - Date.now()) / 1000) : 0;
    return `
      <section class="hero">
        <div class="brand-row"><div class="logo">S↑</div><div><h1>ScalpIQ</h1><p>BINANCE FUTURES • PAPER AUTO SCALPER • WEB/PWA</p></div><div class="live-pill ${s.feedConnected ? 'ok' : ''}"><i></i>${s.feedConnected ? 'LIVE DATA' : 'OFFLINE'}</div></div>
      </section>
      ${s.sessionStartedAt && !s.autoEntriesEnabled ? `
      <section class="panel start-panel"><label>SAVED PAPER SESSION</label><div class="money-input"><span>$</span><input type="text" value="${Number(s.realizedBalance).toFixed(2)}" disabled></div><button id="resumeBtn" class="primary">RESUME FULL AUTO</button><p class="hint">Session, balance, trades, adaptive Shadow A/B aur cooldown saved hain. Resume se isi session mein new entries dobara start hongi.</p></section>` : (!running && !s.activePositions.length ? `
      <section class="panel start-panel"><label>Virtual Balance</label><div class="money-input"><span>$</span><input id="balanceInput" type="number" min="1" step="1" value="${s.initialBalance > 0 ? s.initialBalance : 1000}"></div><button id="startBtn" class="primary">START FULL AUTO</button><p class="hint">Aap sirf balance dete ho. Coin, direction, amount, SL/TP aur exit bot khud select karta hai.</p></section>` : `
      <button id="stopBtn" class="stop-btn">STOP NEW TRADES</button>`)}
      <section class="panel status-panel"><div class="status-head"><div><span class="dot ${s.feedConnected ? 'ok' : ''}"></span><b>${esc(s.botStatus)}</b></div><span>${s.latencyMs ?? '--'}ms</span></div><div class="status-text">${esc(s.statusText)}</div>${s.consecutiveLosses ? `<div class="warn">Loss streak: ${s.consecutiveLosses}/2</div>` : ''}${cooldown ? `<div class="warn">Auto resume in ${Math.floor(cooldown/60)}m ${cooldown%60}s</div>` : ''}<div class="transport">REST: ${esc(s.apiTransport)}</div></section>
      <section class="metrics"><div class="metric"><span>EQUITY</span><b class="${s.totalNetPnl >= 0 ? 'green' : 'red'}">${money(s.equity)}</b></div><div class="metric"><span>NET P&L</span><b class="${s.totalNetPnl >= 0 ? 'green' : 'red'}">${signed(s.totalNetPnl)}</b></div><div class="metric"><span>WIN RATE</span><b>${s.winRate.toFixed(1)}%</b></div><div class="metric"><span>PROFIT FACTOR</span><b>${s.profitFactor >= 99 ? '∞' : s.profitFactor.toFixed(2)}</b></div></section>
      ${s.sessionStartedAt ? `<section class="panel"><div class="section-row"><span class="eyebrow green">ADAPTIVE MODE</span><span class="tag green">${s.executionMode}</span></div><div class="two"><div><small>Normal shadow PF</small><b>${s.shadowNormalPf.toFixed(2)} (${s.shadowNormalSamples})</b></div><div><small>Inverse shadow PF</small><b>${s.shadowInversePf.toFixed(2)} (${s.shadowInverseSamples})</b></div></div><p class="hint">${esc(s.performanceGuardText)}</p></section>` : ''}
      ${s.activePositions.length ? `<h3 class="section-title">ACTIVE PAPER TRADES</h3>${s.activePositions.map((p) => this.activeCard(p)).join('')}` : ''}
      ${s.candidates.length ? `<h3 class="section-title">AUTO RESEARCH • BEST SETUPS</h3>${s.candidates.slice(0,5).map((c) => this.candidateCard(c)).join('')}` : ''}
      ${s.logs.length ? `<h3 class="section-title">ENGINE LOG</h3><section class="panel logs">${s.logs.slice(0,8).map((l) => `<div class="${/ERROR|LOSS|RISK|DRAWDOWN/.test(l) ? 'red' : ''}">${esc(l)}</div>`).join('')}</section>` : ''}
    `;
  }

  activeCard(p) {
    const pnl = p.side === 'LONG' ? (p.lastPrice - p.entryPrice) * p.quantity : (p.entryPrice - p.lastPrice) * p.quantity;
    return `<section class="panel trade-card"><div class="trade-head"><div><strong>${p.symbol}</strong> <span class="tag ${p.side === 'LONG' ? 'green' : 'red'}">${p.side}</span></div><b class="${pnl >= 0 ? 'green' : 'red'}">${signed(pnl)}</b></div><p class="hint">${esc(p.strategy)} • ${p.confidence.toFixed(1)}% • ${p.executionMode}</p><p class="mini">Signal ${p.analyzedSide} → Executed ${p.side}</p><div class="two"><div><small>Entry</small><b>${price(p.entryPrice)}</b></div><div><small>Now</small><b>${price(p.lastPrice)}</b></div><div><small>Position</small><b>${money(p.notional)}</b></div><div><small>Virtual Lev.</small><b>${p.virtualLeverage}x</b></div><div><small>Stop</small><b>${price(p.stopPrice)}</b></div><div><small>TP1</small><b>${price(p.tp1)}</b></div></div></section>`;
  }

  candidateCard(c) {
    return `<section class="panel candidate"><div class="trade-head"><strong>${c.symbol}</strong><div>${c.side ? `<span class="tag ${c.side === 'LONG' ? 'green' : 'red'}">${c.side}</span>` : ''} <b class="${c.score >= 72 ? 'green' : ''}">${c.score.toFixed(1)}%</b></div></div><p class="hint">${esc(c.regime.replaceAll('_',' '))} • ${esc(c.note)}</p><p class="mini">Price ${price(c.price)} • spread ${c.spreadPct.toFixed(3)}%</p></section>`;
  }

  tradesView(s) {
    return `<section class="page-head"><div><h2>Trade Evidence</h2><p>Exact entry/exit timestamps + Binance market-based paper execution history</p></div><button id="clearTrades" class="text-red" ${s.activePositions.length ? 'disabled' : ''}>CLEAR</button></section>${s.trades.length ? s.trades.map((t) => this.closedCard(t)).join('') : '<section class="panel"><p class="hint">Abhi koi closed paper trade nahi.</p></section>'}`;
  }

  closedCard(t) {
    return `<section class="panel trade-card"><div class="trade-head"><div><strong>${t.symbol}</strong> <span class="tag ${t.side === 'LONG' ? 'green' : 'red'}">${t.side}</span></div><b class="${t.netPnl >= 0 ? 'green' : 'red'}">${signed(t.netPnl)}</b></div><p class="hint">${esc(t.strategy)} • ${Number(t.confidence).toFixed(1)}% • ${t.executionMode}</p><p class="mini">Signal ${t.analyzedSide || '--'} → Executed ${t.side}</p><div class="two"><div><small>Entry</small><b>${price(t.entryPrice)}</b></div><div><small>Exit</small><b>${price(t.exitPrice)}</b></div><div><small>Entry time</small><b>${clock(t.entryTime)}</b></div><div><small>Exit time</small><b>${clock(t.exitTime)}</b></div><div><small>SL</small><b>${price(t.stopPrice)}</b></div><div><small>TP1</small><b>${price(t.tp1)}</b></div><div><small>Notional</small><b>${money(t.notional)}</b></div><div><small>Fees est.</small><b>${money(t.fees)}</b></div><div><small>Duration</small><b>${duration(t.durationMs)}</b></div><div><small>Exit reason</small><b>${esc(t.exitReason)}</b></div></div><p class="evidence">Evidence: event=${t.entryEventTime} • tx=${t.entryTransactionTime} • update=${t.entryUpdateId}</p></section>`;
  }

  apiView() {
    const api = sessionStorage.getItem('scalpiq_api_key_draft') || '';
    const secret = sessionStorage.getItem('scalpiq_api_secret_draft') || '';
    return `<section class="page-head"><div><h2>Binance API</h2><p>Paper engine public Binance Futures data use karta hai. API key ki zarurat nahi.</p></div></section><section class="panel"><div class="notice">SECURITY: Web/PWA build live order placement nahi karta. Neeche ke fields future reference ke liye sirf current browser session mein rakhe jaate hain; Cloudflare ya Binance ko send nahi hote.</div><label>API Key (optional / future)</label><input id="apiKey" class="field" value="${esc(api)}"><label>Secret Key (optional / future)</label><input id="apiSecret" class="field" type="password" value="${esc(secret)}"><button id="apiSave" class="primary">SAVE THIS SESSION</button><button id="apiClear" class="ghost">REMOVE SESSION API</button></section><section class="panel rules"><h3>PAPER ENGINE RULES</h3>${this.rule('Market','Binance USDⓈ-M Futures public live data')}${this.rule('Selection','Auto coin + auto LONG/SHORT + auto strategy')}${this.rule('Sizing','Auto amount • 30% notional cap • ~0.30% planned risk budget')}${this.rule('Leverage','Fixed 2x virtual leverage')}${this.rule('Mode','Shadow A/B compares NORMAL vs INVERSE and auto-selects')}${this.rule('Entry','Standard auto signal scan • strict liquidity & multi-confirm OFF')}${this.rule('Protection','Regime-aware fee-aware TP1 • TP1 hit = full close')}${this.rule('Guard','2 losses = 3-min cooldown • low PF = 10-min guard • 2% drawdown = 15-min auto-resume')}${this.rule('Persistence','Session auto-saved • tab/PC restart par same state resume')}${this.rule('Max positions','2 simultaneous paper positions')}</section>`;
  }

  rule(k, v) { return `<div class="rule"><span>${esc(k)}</span><b>${esc(v)}</b></div>`; }
}
