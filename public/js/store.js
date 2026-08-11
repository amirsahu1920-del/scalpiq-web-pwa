const TRADE_KEY = 'scalpiq_web_trades_v1';
const UI_KEY = 'scalpiq_web_ui_v1';
const SESSION_KEY = 'scalpiq_web_session_v2';

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

// Full paper-session persistence. This deliberately contains NO Binance API key/secret.
// It survives tab/PWA close, browser restart and PC power loss as long as the same
// browser profile/site storage is retained.
export const SessionStore = {
  load() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return value && typeof value === 'object' ? value : null;
    } catch { return null; }
  },
  save(value) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(value || null)); return true; }
    catch { return false; }
  },
  clear() { try { localStorage.removeItem(SESSION_KEY); } catch {} },
};
