/**
 * Decoupled FX & Presentation Stage (`fx-stage.js`).
 *
 * Provides a lightweight animation/effect dispatcher `playEffect(type, payload)`
 * and subscribes to core EventBus signals (checks, hits, crits, scans, resource deltas)
 * while keeping presentation 100% decoupled from game logic.
 *
 * Built-in effect types:
 *   - 'shake'       : subtle micro-shake on the app shell
 *   - 'float-text'  : floating numeric/status callout text
 *   - 'scan-ripple' : expanding radar scan ring overlay
 *   - 'dice-roll'   : compact D20 roll/outcome badge animation
 *   - 'crit-flash'  : brief highlight pulse on critical hit / critical success
 *
 * Future skins or rich animations can replace any renderer via `registerRenderer(type, fn)`.
 */

const STORAGE_NS = 'core-fx';
const ENABLED_KEY = 'fx-enabled';

export const FX_TYPES = Object.freeze({
  SHAKE: 'shake',
  FLOAT_TEXT: 'float-text',
  SCAN_RIPPLE: 'scan-ripple',
  DICE_ROLL: 'dice-roll',
  CRIT_FLASH: 'crit-flash',
});

export class FxStage {
  /**
   * @param {{
   *   bus?: import('./event-bus.js').EventBus | null,
   *   storage?: import('./storage.js').StorageManager | null
   * }} [deps]
   */
  constructor({ bus = null, storage = null } = {}) {
    this._bus = bus;
    this._store = storage ? storage.namespace(STORAGE_NS) : null;
    this._enabled = this._store ? this._store.get(ENABLED_KEY, true) !== false : true;
    /** @type {Map<string, (payload: any, ctx: { overlay: HTMLElement }) => void>} */
    this._renderers = new Map();
    this._attached = false;
    this._unsubs = [];
    /** @type {HTMLElement | null} */
    this._overlay = null;
    this._history = [];

    this._registerBuiltInRenderers();
  }

  _ensureOverlay() {
    if (typeof document === 'undefined') return null;
    if (this._overlay && document.body.contains(this._overlay)) {
      return this._overlay;
    }
    let el = document.getElementById('fx-stage-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fx-stage-overlay';
      el.className = 'fx-stage-overlay';
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    this._overlay = el;
    return el;
  }

  _registerBuiltInRenderers() {
    this.registerRenderer(FX_TYPES.SHAKE, (payload = {}) => {
      const target = document.getElementById('app-shell') || document.body;
      if (!target) return;
      const cls = payload.heavy ? 'fx-shake-heavy' : 'fx-shake-light';
      target.classList.remove('fx-shake-light', 'fx-shake-heavy');
      // Force reflow so rapid consecutive shakes restart cleanly
      void target.offsetWidth;
      target.classList.add(cls);
      setTimeout(() => target.classList.remove(cls), 340);
    });

    this.registerRenderer(FX_TYPES.FLOAT_TEXT, (payload = {}, { overlay }) => {
      if (!overlay) return;
      const text = String(payload.text || '').trim();
      if (!text) return;
      const item = document.createElement('div');
      const tone = payload.tone || 'accent';
      item.className = `fx-float-text fx-tone-${tone}`;
      item.textContent = text;
      const offsetX = Math.round((Math.random() - 0.5) * 90);
      const offsetY = Math.round((Math.random() - 0.5) * 32);
      item.style.setProperty('--fx-x', `${offsetX}px`);
      item.style.setProperty('--fx-y', `${offsetY}px`);
      overlay.appendChild(item);
      setTimeout(() => item.remove(), 1100);
    });

    this.registerRenderer(FX_TYPES.SCAN_RIPPLE, (payload = {}, { overlay }) => {
      if (!overlay) return;
      const ring = document.createElement('div');
      ring.className = 'fx-scan-ripple';
      overlay.appendChild(ring);
      setTimeout(() => ring.remove(), 820);
      if (payload.label) {
        this.playEffect(FX_TYPES.FLOAT_TEXT, { text: payload.label, tone: 'accent' });
      }
    });

    this.registerRenderer(FX_TYPES.DICE_ROLL, (payload = {}, { overlay }) => {
      if (!overlay) return;
      const badge = document.createElement('div');
      const tone =
        payload.outcome === 'crit-success' || payload.outcome === 'success'
          ? 'ok'
          : payload.outcome === 'crit-fail'
          ? 'danger'
          : 'warn';
      badge.className = `fx-dice-pill fx-tone-${tone}`;
      badge.textContent = `1D20 · ${payload.naturalRoll ?? '?'} → ${payload.outcomeLabel || ''}`;
      overlay.appendChild(badge);
      setTimeout(() => badge.remove(), 1200);
    });

    this.registerRenderer(FX_TYPES.CRIT_FLASH, (_payload = {}, { overlay }) => {
      if (!overlay) return;
      const flash = document.createElement('div');
      flash.className = 'fx-crit-flash';
      overlay.appendChild(flash);
      setTimeout(() => flash.remove(), 420);
    });
  }

  /**
   * Register or override an effect renderer for custom skins / future animation packs.
   */
  registerRenderer(type, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError(`FxStage renderer for "${type}" must be a function`);
    }
    this._renderers.set(String(type), fn);
    return this;
  }

  isEnabled() {
    return this._enabled;
  }

  setEnabled(flag) {
    this._enabled = Boolean(flag);
    if (this._store) {
      this._store.set(ENABLED_KEY, this._enabled);
    }
    return this._enabled;
  }

  getRecentEffects() {
    return [...this._history];
  }

  /**
   * Play a named effect through the registered renderer.
   * @param {string} type
   * @param {object} [payload={}]
   */
  playEffect(type, payload = {}) {
    const cleanType = String(type || '');
    this._history.push({ type: cleanType, payload, timestamp: Date.now() });
    if (this._history.length > 30) this._history = this._history.slice(-30);

    if (!this._enabled) return false;
    const renderer = this._renderers.get(cleanType);
    if (!renderer) return false;

    try {
      const overlay = this._ensureOverlay();
      renderer(payload, { overlay });
      return true;
    } catch (err) {
      console.warn(`[FxStage] Effect "${cleanType}" failed:`, err);
      return false;
    }
  }

  /**
   * Bind EventBus listeners so business modules automatically emit visual effects
   * without directly touching DOM animation code.
   */
  attachBusListeners() {
    if (!this._bus || this._attached) return;
    this._attached = true;

    this._unsubs = [
      this._bus.on('fx:play', (ev) => {
        if (ev && ev.type) this.playEffect(ev.type, ev.payload || {});
      }),
      this._bus.on('stat-rules:check-performed', (res) => {
        this.playEffect(FX_TYPES.DICE_ROLL, {
          naturalRoll: res.naturalRoll,
          total: res.total,
          outcome: res.outcome,
          outcomeLabel: res.outcomeLabel,
        });
        if (res.outcome === 'crit-success') {
          this.playEffect(FX_TYPES.CRIT_FLASH, {});
        }
      }),
      this._bus.on('combat:scan', (ev) => {
        this.playEffect(FX_TYPES.SCAN_RIPPLE, {
          label: ev?.success ? '目标已锁定' : '扫描受干扰',
        });
      }),
      this._bus.on('combat:hit', (ev) => {
        this.playEffect(FX_TYPES.SHAKE, { heavy: Boolean(ev?.crit) });
        if (ev?.crit) this.playEffect(FX_TYPES.CRIT_FLASH, {});
        if (ev?.damage > 0) {
          this.playEffect(FX_TYPES.FLOAT_TEXT, {
            text: `${ev.crit ? '暴击 ' : ''}-${ev.damage}`,
            tone: ev.crit ? 'warn' : 'accent',
          });
        }
      }),
      this._bus.on('combat:enemy-hit', (ev) => {
        this.playEffect(FX_TYPES.SHAKE, { heavy: (ev?.damage || 0) >= 16 });
        if (ev?.damage > 0) {
          this.playEffect(FX_TYPES.FLOAT_TEXT, {
            text: `受击 HP -${ev.damage}`,
            tone: 'danger',
          });
        }
      }),
      this._bus.on('resource:changed', (ev) => {
        if (!ev || !ev.delta) return;
        const sign = ev.delta > 0 ? `+${ev.delta}` : `${ev.delta}`;
        this.playEffect(FX_TYPES.FLOAT_TEXT, {
          text: `${ev.name} ${sign}`,
          tone: ev.delta > 0 ? 'accent' : 'muted',
        });
      }),
    ];
  }

  detachBusListeners() {
    for (const unsub of this._unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this._unsubs = [];
    this._attached = false;
  }
}
