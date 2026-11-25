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
const SPEED_KEY = 'fx-battle-speed';

export const FX_TYPES = Object.freeze({
  SHAKE: 'shake',
  FLOAT_TEXT: 'float-text',
  SCAN_RIPPLE: 'scan-ripple',
  DICE_ROLL: 'dice-roll',
  CRIT_FLASH: 'crit-flash',
  DAMAGE_FLASH: 'damage-flash',
  AMBUSH_FLASH: 'ambush-flash',
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
    const savedSpeed = this._store ? Number(this._store.get(SPEED_KEY, 1)) : 1;
    this._battleSpeed = savedSpeed === 2 ? 2 : 1;
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

  getBattleSpeed() {
    return this._battleSpeed;
  }

  setBattleSpeed(speed) {
    this._battleSpeed = Number(speed) === 2 ? 2 : 1;
    if (this._store) this._store.set(SPEED_KEY, this._battleSpeed);
    if (this._bus) this._bus.emit('fx:speed-changed', { speed: this._battleSpeed });
    return this._battleSpeed;
  }

  toggleBattleSpeed() {
    return this.setBattleSpeed(this._battleSpeed === 1 ? 2 : 1);
  }

  wait(baseMs) {
    const ms = Math.max(30, Math.round((Number(baseMs) || 0) / this._battleSpeed));
    return new Promise((resolve) => setTimeout(resolve, ms));
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

    this.registerRenderer(FX_TYPES.AMBUSH_FLASH, (payload = {}, { overlay }) => {
      if (!overlay) return;
      const vig = document.createElement('div');
      vig.className = 'fx-damage-vignette is-ambush';
      overlay.appendChild(vig);
      this.playSfx('hit');
      this._vibrate([35, 25, 45]);
      if (payload.label) {
        this.playEffect(FX_TYPES.FLOAT_TEXT, { text: payload.label, tone: 'danger' });
      }
      setTimeout(() => vig.remove(), 620);
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
      this._bus.on('combat:recon-result', (ev) => {
        if (!ev) return;
        this.playEffect(FX_TYPES.SCAN_RIPPLE, {
          label: ev.success ? `索敌成功 · 锁定 +${ev.lockBonus || 1}` : '⚠ 索敌失利 · 敌军隐蔽接近',
        });
      }),
      this._bus.on('combat:ambush', (ev) => {
        this.playEffect(FX_TYPES.SHAKE, { heavy: true });
        this.playEffect(FX_TYPES.AMBUSH_FLASH, {
          label: `⚠ 敌方先制伏击${ev?.totalDamage ? ` -${ev.totalDamage} HP` : '！'}`,
        });
      }),
      this._bus.on('combat:opening-airstrike', (ev) => {
        if (!ev) return;
        this.playSfx('scan');
        this.playEffect(FX_TYPES.FLOAT_TEXT, {
          text: `开幕航空战 · ${ev.airState || '空中交锋'}`,
          tone: ev.allyDamage > 0 ? 'accent' : 'warn',
        });
      }),
      this._bus.on('combat:opening-torpedo', (ev) => {
        if (!ev) return;
        this.playSfx('hit');
        this.playEffect(FX_TYPES.FLOAT_TEXT, {
          text: `开幕雷击${ev.allyDamage > 0 ? ` 敌-${ev.allyDamage}` : ''}${ev.enemyDamage > 0 ? ` 我-${ev.enemyDamage}` : ''}`,
          tone: ev.enemyDamage > ev.allyDamage ? 'danger' : 'accent',
        });
      }),
      this._bus.on('combat:enemy-action', (ev) => {
        if (!ev) return;
        if (ev.damage > 0) {
          this.playEffect(FX_TYPES.SHAKE, { heavy: ev.damage >= 16 });
          this.playEffect(FX_TYPES.DAMAGE_FLASH, {});
          this.playEffect(FX_TYPES.FLOAT_TEXT, {
            text: `${ev.enemyName || '敌舰'} ${ev.intentLabel || '反击'} -${ev.damage}`,
            tone: 'danger',
          });
        } else if (ev.intentId === 'enemy_guard') {
          this.playEffect(FX_TYPES.FLOAT_TEXT, {
            text: `${ev.enemyName || '敌重巡'} 展开前排援护`,
            tone: 'warn',
          });
        }
      }),
      this._bus.on('combat:scan', (ev) => {
        this.playEffect(FX_TYPES.SCAN_RIPPLE, {
          label: ev?.label || (ev?.success ? '目标已锁定' : '扫描受干扰'),
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
      this._bus.on('character:exp-gained', (ev) => {
        if (!ev || !ev.amount || ev.leveledUp) return;
        this.playEffect(FX_TYPES.FLOAT_TEXT, {
          text: `${ev.characterName} EXP +${ev.amount}`,
          tone: 'accent',
        });
      }),
      this._bus.on('character:leveled-up', (ev) => {
        if (!ev) return;
        this.playEffect(FX_TYPES.CRIT_FLASH, {});
        this.playEffect(FX_TYPES.FLOAT_TEXT, {
          text: `★ ${ev.characterName} 升级至 Lv.${ev.afterLevel}！`,
          tone: 'ok',
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

  buildPointToPointTrajectorySvg(visualStyle, coords) {
    return buildPointToPointTrajectorySvg(visualStyle, coords);
  }
}

/**
 * Pure SVG point-to-point trajectory generator between any two (x1,y1)->(x2,y2) cells
 * on the 3x4 vs 3x4 naval radar sandbox.
 */
export function buildPointToPointTrajectorySvg(
  visualStyle = 'shelling',
  { x1 = 180, y1 = 230, x2 = 180, y2 = 55 } = {}
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const curveShift = Math.abs(dx) < 28 ? 34 : Math.sign(dx) * -28;
  const cx = mx + curveShift;
  const cy = my;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  if (visualStyle === 'airstrike' || visualStyle === 'enemy_airstrike') {
    const isEnemy = visualStyle === 'enemy_airstrike';
    const stroke1 = isEnemy ? '#f43f5e' : '#c084fc';
    const stroke2 = isEnemy ? '#fb7185' : '#a78bfa';
    const fillRing = isEnemy ? 'rgba(244,63,94,0.28)' : 'rgba(192,132,252,0.28)';
    return `
      <g class="bf-anim-airstrike">
        <path class="bf-arc-path" d="M ${x1} ${y1} Q ${cx - 18} ${cy} ${x2} ${y2}" stroke="${stroke1}" stroke-width="2.6" stroke-dasharray="6 4" fill="none" />
        <path class="bf-arc-path" d="M ${x1 + 10} ${y1} Q ${cx + 22} ${cy} ${x2 + 6} ${y2 + 4}" stroke="${stroke2}" stroke-width="2.2" stroke-dasharray="5 4" fill="none" />
        <polygon points="-7,-4 8,0 -7,4 -3,0" fill="${stroke1}" transform="translate(${(mx + x2) / 2},${(my + y2) / 2}) rotate(${angleDeg})" />
        <circle class="bf-impact-ring" cx="${x2}" cy="${y2}" r="18" stroke="${stroke1}" stroke-width="2.6" fill="${fillRing}" />
      </g>
    `;
  }

  if (visualStyle === 'torpedo' || visualStyle === 'enemy_torpedo') {
    const isEnemy = visualStyle === 'enemy_torpedo';
    const stroke1 = isEnemy ? '#fb7185' : '#22d3ee';
    const stroke2 = isEnemy ? '#f43f5e' : '#38bdf8';
    const fillRing = isEnemy ? 'rgba(244,63,94,0.26)' : 'rgba(34,211,238,0.24)';
    return `
      <g class="bf-anim-torpedo">
        <line class="bf-torp-path" x1="${x1 - 5}" y1="${y1}" x2="${x2 - 4}" y2="${y2}" stroke="${stroke1}" stroke-width="2.8" stroke-dasharray="10 6" stroke-linecap="round" />
        <line class="bf-torp-path" x1="${x1 + 5}" y1="${y1}" x2="${x2 + 4}" y2="${y2}" stroke="${stroke2}" stroke-width="2.4" stroke-dasharray="10 6" stroke-linecap="round" />
        <circle class="bf-torp-ripple" cx="${x2}" cy="${y2}" r="18" stroke="${stroke1}" stroke-width="2.5" fill="${fillRing}" />
      </g>
    `;
  }

  if (visualStyle === 'asw') {
    return `
      <g class="bf-anim-asw">
        <circle class="bf-sonar-fan" cx="${x2}" cy="${y2}" r="14" stroke="#22d3ee" stroke-width="2" fill="rgba(34,211,238,0.16)" />
        <circle class="bf-sonar-fan" cx="${x2}" cy="${y2}" r="28" stroke="#38bdf8" stroke-width="1.6" stroke-dasharray="5 4" fill="none" />
        <path class="bf-arc-path" d="M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}" stroke="#34d399" stroke-width="2.6" fill="none" />
        <circle class="bf-impact-ring" cx="${x2}" cy="${y2}" r="16" stroke="#34d399" stroke-width="2.5" fill="rgba(52,211,153,0.28)" />
      </g>
    `;
  }

  if (visualStyle === 'scan') {
    return `
      <g class="bf-anim-scan">
        <line class="bf-speed-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#34d399" stroke-width="2" stroke-dasharray="5 4" />
        <circle class="bf-sonar-fan" cx="${x2}" cy="${y2}" r="24" fill="rgba(16,185,129,0.2)" stroke="#34d399" stroke-width="2" />
        <circle class="bf-impact-ring" cx="${x2}" cy="${y2}" r="12" stroke="#6ee7b7" stroke-width="2" fill="none" stroke-dasharray="3 2" />
      </g>
    `;
  }

  if (visualStyle === 'smoke') {
    return `
      <g class="bf-anim-smoke">
        <circle class="bf-sonar-fan" cx="${x1 - 24}" cy="${y1}" r="22" fill="rgba(148,163,184,0.34)" stroke="#cbd5e1" stroke-width="1.8" />
        <circle class="bf-sonar-fan" cx="${x1}" cy="${y1 - 8}" r="28" fill="rgba(148,163,184,0.32)" stroke="#e2e8f0" stroke-width="2" />
        <circle class="bf-sonar-fan" cx="${x1 + 24}" cy="${y1}" r="22" fill="rgba(148,163,184,0.34)" stroke="#cbd5e1" stroke-width="1.8" />
      </g>
    `;
  }

  if (visualStyle === 'aa') {
    return `
      <g class="bf-anim-aa">
        <line class="bf-speed-line" x1="${x1}" y1="${y1}" x2="${mx - 28}" y2="${my}" stroke="#fbbf24" stroke-width="2.2" stroke-dasharray="5 4" />
        <line class="bf-speed-line" x1="${x1}" y1="${y1}" x2="${mx}" y2="${my - 14}" stroke="#fde047" stroke-width="2.4" stroke-dasharray="5 4" />
        <line class="bf-speed-line" x1="${x1}" y1="${y1}" x2="${mx + 28}" y2="${my}" stroke="#fbbf24" stroke-width="2.2" stroke-dasharray="5 4" />
        <circle class="bf-impact-ring" cx="${mx - 28}" cy="${my}" r="10" stroke="#fde047" stroke-width="2" fill="rgba(250,204,21,0.26)" />
        <circle class="bf-impact-ring" cx="${mx + 28}" cy="${my}" r="10" stroke="#fde047" stroke-width="2" fill="rgba(250,204,21,0.26)" />
      </g>
    `;
  }

  if (visualStyle === 'guard' || visualStyle === 'enemy_guard') {
    const isEnemy = visualStyle === 'enemy_guard';
    const stroke = isEnemy ? '#fb923c' : '#60a5fa';
    const fill = isEnemy ? 'rgba(251,146,60,0.22)' : 'rgba(59,130,246,0.24)';
    return `
      <g class="bf-anim-guard">
        <circle class="bf-shield-hex" cx="${x1}" cy="${y1}" r="24" fill="${fill}" stroke="${stroke}" stroke-width="2.6" />
        <path d="M ${x1 - 8} ${y1} L ${x1 - 2} ${y1 + 6} L ${x1 + 9} ${y1 - 6}" stroke="${stroke}" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </g>
    `;
  }

  if (visualStyle === 'advance' || visualStyle === 'evade') {
    return `
      <g class="bf-anim-evade">
        <path class="bf-speed-line" d="M ${x1 - 22} ${y1 + 10} L ${x1} ${y1 - 14} L ${x1 + 22} ${y1 + 10}" stroke="#38bdf8" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        <path class="bf-speed-line" d="M ${x1 - 16} ${y1 - 4} L ${x1} ${y1 - 26} L ${x1 + 16} ${y1 - 4}" stroke="#60a5fa" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </g>
    `;
  }

  if (visualStyle === 'ambush' || visualStyle === 'enemy_salvo' || visualStyle === 'counter') {
    return `
      <g class="bf-anim-counter">
        <path class="bf-arc-path" d="M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}" stroke="#ef4444" stroke-width="3.2" fill="none" stroke-linecap="round" />
        <path class="bf-arc-path" d="M ${x1 + 6} ${y1} Q ${cx + 12} ${cy} ${x2 + 4} ${y2}" stroke="#fb923c" stroke-width="2.2" fill="none" stroke-linecap="round" />
        <circle class="bf-impact-ring" cx="${x2}" cy="${y2}" r="19" stroke="#f87171" stroke-width="2.6" fill="rgba(239,68,68,0.28)" />
      </g>
    `;
  }

  // Default: allied shelling / heavy_shelling / main_salvo
  return `
    <g class="bf-anim-shelling">
      <path class="bf-arc-path" d="M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}" stroke="#f97316" stroke-width="3.2" fill="none" stroke-linecap="round" />
      <path class="bf-arc-path" d="M ${x1 + 6} ${y1} Q ${cx + 12} ${cy} ${x2 + 4} ${y2}" stroke="#fbbf24" stroke-width="2.2" fill="none" stroke-linecap="round" />
      <circle class="bf-impact-ring" cx="${x2}" cy="${y2}" r="18" stroke="#fb923c" stroke-width="2.6" fill="rgba(249,115,22,0.26)" />
    </g>
  `;
}

