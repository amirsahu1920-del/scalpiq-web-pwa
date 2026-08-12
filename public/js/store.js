import { DEFAULT_SETTINGS, normalizeSettings } from './config.js';

const TRADE_KEY = 'scalpiq_web_trades_v1';
const UI_KEY = 'scalpiq_web_ui_v1';
const SESSION_KEY = 'scalpiq_web_session_v3';
const OLD_SESSION_KEY = 'scalpiq_web_session_v2';
const SETTINGS_KEY = 'scalpiq_web_settings_v1';

export const TradeStore = {
  load() {
    try { const data = JSON.parse(localStorage.getItem(TRADE_KEY) || '[]'); return Array.isArray(data) ? data.slice(0, 500) : []; }
    catch { return []; }
  },
  save(trades) { try { localStorage.setItem(TRADE_KEY, JSON.stringify((trades || []).slice(0, 500))); } catch {} },
  clear() { try { localStorage.removeItem(TRADE_KEY); } catch {} },
};

export const UiStore = {
  load() { try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch { return {}; } },
  save(value) { try { localStorage.setItem(UI_KEY, JSON.stringify(value || {})); } catch {} },
};

export const SettingsStore = {
  load() {
    try { return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}); }
    catch { return normalizeSettings(DEFAULT_SETTINGS); }
  },
  save(value) {
    const normalized = normalizeSettings(value);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized)); } catch {}
    return normalized;
  },
  reset() {
    try { localStorage.removeItem(SETTINGS_KEY); } catch {}
    return normalizeSettings(DEFAULT_SETTINGS);
  },
};

// Full paper-session persistence. No Binance API key/secret is stored here.
export const SessionStore = {
  load() {
    try {
      let raw = localStorage.getItem(SESSION_KEY);
      if (!raw) raw = localStorage.getItem(OLD_SESSION_KEY); // one-time compatibility with v1.1.x
      const value = JSON.parse(raw || 'null');
      return value && typeof value === 'object' ? value : null;
    } catch { return null; }
  },
  save(value) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(value || null));
      localStorage.removeItem(OLD_SESSION_KEY);
      return true;
    } catch { return false; }
  },
  clear() {
    try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(OLD_SESSION_KEY); } catch {}
  },
};
