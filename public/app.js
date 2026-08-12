import { TradingEngine } from './js/engine.js';
import { AppUI } from './js/ui.js';

let ui = null;
const engine = new TradingEngine((state) => {
  // Settings/API number/text fields should not be destroyed while the user is typing.
  if (ui?.tab === 'settings' && document.activeElement?.matches('input,select')) return;
  ui?.render(state);
});
ui = new AppUI(engine);
ui.render(engine.snapshot());
engine.bootstrap().catch((e) => console.error('ScalpIQ restore failed', e));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

setInterval(() => {
  if (ui?.tab !== 'auto') return;
  const s = engine.snapshot();
  if (s.cooldownUntil > Date.now() || s.botStatus === 'COOLDOWN') ui.render(s);
}, 1_000);

window.ScalpIQ = { engine };
