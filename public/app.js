import { TradingEngine } from './js/engine.js';
import { AppUI } from './js/ui.js';

let ui = null;
const engine = new TradingEngine((state) => {
  // Avoid wiping a field while the user is typing on the API screen.
  if (ui?.tab === 'api' && document.activeElement?.matches('input')) return;
  ui?.render(state);
});
ui = new AppUI(engine);
ui.render(engine.snapshot());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

setInterval(() => {
  if (ui?.tab !== 'auto') return;
  const s = engine.snapshot();
  if (s.cooldownUntil > Date.now() || s.botStatus === 'COOLDOWN') ui.render(s);
}, 1_000);

window.ScalpIQ = { engine };
