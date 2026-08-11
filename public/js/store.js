const TRADE_KEY = 'scalpiq_web_trades_v1';
const UI_KEY = 'scalpiq_web_ui_v1';

export const TradeStore = {
  load() {
    try {
      const data = JSON.parse(localStorage.getItem(TRADE_KEY) || '[]');
      return Array.isArray(data) ? data.slice(0, 500) : [];
    } catch { return []; }
  },
  save(trades) {
    try { localStorage.setItem(TRADE_KEY, JSON.stringify((trades || []).slice(0, 500))); } catch {}
  },
  clear() { try { localStorage.removeItem(TRADE_KEY); } catch {} },
};

export const UiStore = {
  load() {
    try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch { return {}; }
  },
  save(value) { try { localStorage.setItem(UI_KEY, JSON.stringify(value || {})); } catch {} },
};
