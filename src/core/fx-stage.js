/**
 * Decoupled FX, Presentation, Haptics, Typewriter & Web Audio SFX Stage (`fx-stage.js`).
 *
 * Upgraded capabilities:
 *   - Built-in visual effect types:
 *       * 'shake'        : micro-shake on app shell (light / heavy)
 *       * 'float-text'   : floating damage / buff / resource delta callouts
 *       * 'scan-ripple'  : expanding radar scan pulse ring
 *       * 'dice-roll'    : 3D rolling/flipping D20 badge animation
 *       * 'crit-flash'   : bright highlight flash on crit success / crit hit / oath
 *       * 'damage-flash' : red edge vignette warning flash on taking combat damage
 *   - Typewriter text reveal helper: `typewrite(el, text, { speedMs })` with tap-to-complete
 *   - Optional lightweight mobile haptic feedback (`navigator.vibrate`)
 *   - Optional zero-dependency Web Audio synthesized SFX (dice, hit, crit, scan, click, chime)
 *     with global mute toggles persisted in localStorage.
 */

const STORAGE_NS = 'core-fx';
const ENABLED_KEY = 'fx-enabled';
const SOUND_KEY = 'fx-sound-enabled';
const HAPTICS_KEY = 'fx-haptics-enabled';

export const FX_TYPES = Object.freeze({
  SHAKE: 'shake',
  FLOAT_TEXT: 'float-text',
  SCAN_RIPPLE: 'scan-ripple',
  DICE_ROLL: 'dice-roll',
  CRIT_FLASH: 'crit-flash',
  DAMAGE_FLASH: 'damage-flash',
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
    this._soundEnabled = this._store ? this._store.get(SOUND_KEY, false) === true : false;
    this._hapticsEnabled = this._store ? this._store.get(HAPTICS_KEY, true) !== false : true;
    /** @type {Map<string, (payload: any, ctx: { overlay: HTMLElement }) => void>} */
    this._renderers = new Map();
    this._attached = false;
    this._unsubs = [];
    /** @type {HTMLElement | null} */
    this._overlay = null;
    this._history = [];
    this._audioCtx = null;

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

  _vibrate(pattern) {
    if (!this._hapticsEnabled) return;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
      }
    } catch {
      // ignore unsupported environments
    }
  }

  /**
   * Zero-dependency Web Audio synthesized sound effects (guarded by global mute toggle).
   */
  playSfx(kind = 'click') {
    if (!this._soundEnabled || typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    try {
      if (!this._audioCtx) this._audioCtx = new AudioCtx();
      const ctx = this._audioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (kind === 'crit') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(980, now + 0.14);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.23);
      } else if (kind === 'hit') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(190, now);
        osc.frequency.exponentialRampToValueAtTime(70, now + 0.12);
        gain.gain.setValueAtTime(0.11, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.start(now);
        osc.stop(now + 0.15);
      } else if (kind === 'scan') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(420, now);
        osc.frequency.exponentialRampToValueAtTime(760, now + 0.18);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.21);
      } else if (kind === 'dice') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(640, now);
        osc.frequency.setValueAtTime(780, now + 0.05);
        gain.gain.setValueAtTime(0.07, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.13);
      } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(520, now);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        osc.start(now);
        osc.stop(now + 0.07);
      }
    } catch {
      // ignore audio autoplay blocks
    }
  }

  /**
   * Adjustable-speed typewriter text reveal helper.
   * Tapping the element finishes the text immediately.
   */
  typewrite(element, text, { speedMs = 18 } = {}) {
    if (!element) return () => {};
    const full = String(text ?? '');
    const spd = Math.max(0, Number(speedMs) || 0);
    if (spd === 0 || full.length === 0) {
      element.textContent = full;
      return () => {};
    }

    let idx = 0;
    let done = false;
    element.textContent = '';

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      element.textContent = full;
      element.removeEventListener('click', finish);
    };

    element.addEventListener('click', finish);
    const step = full.length > 140 ? 3 : full.length > 70 ? 2 : 1;
    const timer = setInterval(() => {
      idx += step;
      if (idx >= full.length) {
        finish();
      } else {
        element.textContent = full.slice(0, idx);
      }
    }, spd);

    return finish;
  }

  _registerBuiltInRenderers() {
    this.registerRenderer(FX_TYPES.SHAKE, (payload = {}) => {
      const target = document.getElementById('app-shell') || document.body;
      if (!target) return;
      const cls = payload.heavy ? 'fx-shake-heavy' : 'fx-shake-light';
      target.classList.remove('fx-shake-light', 'fx-shake-heavy');
      void target.offsetWidth;
      target.classList.add(cls);
      this._vibrate(payload.heavy ? [25, 25, 35] : 18);
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
      this.playSfx('scan');
      this._vibrate(15);
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
      badge.innerHTML = `<span class="fx-dice-cube" aria-hidden="true">D20</span><span>${payload.naturalRoll ?? '?'} → ${payload.outcomeLabel || ''}</span>`;
      overlay.appendChild(badge);
      this.playSfx('dice');
      setTimeout(() => badge.remove(), 1280);
    });

    this.registerRenderer(FX_TYPES.CRIT_FLASH, (_payload = {}, { overlay }) => {
      if (!overlay) return;
      const flash = document.createElement('div');
      flash.className = 'fx-crit-flash';
      overlay.appendChild(flash);
      this.playSfx('crit');
      this._vibrate([20, 20, 30]);
      setTimeout(() => flash.remove(), 440);
    });

    this.registerRenderer(FX_TYPES.DAMAGE_FLASH, (_payload = {}, { overlay }) => {
      if (!overlay) return;
      const vig = document.createElement('div');
      vig.className = 'fx-damage-vignette';
      overlay.appendChild(vig);
      this.playSfx('hit');
      setTimeout(() => vig.remove(), 460);
    });
  }

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
    if (this._store) this._store.set(ENABLED_KEY, this._enabled);
    return this._enabled;
  }

  isSoundEnabled() {
    return this._soundEnabled;
  }

  setSoundEnabled(flag) {
    this._soundEnabled = Boolean(flag);
    if (this._store) this._store.set(SOUND_KEY, this._soundEnabled);
    return this._soundEnabled;
  }

  isHapticsEnabled() {
    return this._hapticsEnabled;
  }

  setHapticsEnabled(flag) {
    this._hapticsEnabled = Boolean(flag);
    if (this._store) this._store.set(HAPTICS_KEY, this._hapticsEnabled);
    return this._hapticsEnabled;
  }

  getRecentEffects() {
    return [...this._history];
  }

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
        else this.playSfx('hit');
        if (ev?.damage > 0) {
          this.playEffect(FX_TYPES.FLOAT_TEXT, {
            text: `${ev.crit ? '暴击 ' : ''}-${ev.damage}`,
            tone: ev.crit ? 'warn' : 'accent',
          });
        }
      }),
      this._bus.on('combat:enemy-hit', (ev) => {
        this.playEffect(FX_TYPES.SHAKE, { heavy: (ev?.damage || 0) >= 14 });
        this.playEffect(FX_TYPES.DAMAGE_FLASH, {});
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
