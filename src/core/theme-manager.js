/**
 * Dynamic UI Theme, Custom Palette, Texture & Modular Port Layout Engine (`theme-manager.js`).
 *
 * Features:
 *   - 4 curated CSS Variable theme presets:
 *       1. deep_tactical (深海战术终端)
 *       2. fresh_breeze  (清爽海风白蓝)
 *       3. warm_harbor   (暖光日常港区)
 *       4. gilded_night  (暗夜鎏金指挥室)
 *   - Real-time mobile palette tuner: custom primary/accent colors, card border radius,
 *     background grid/dots/wave textures, and typewriter text reveal speed
 *   - Modular Port Hub Desktop Layout configuration (show/hide & reorder Port Hub cards)
 *   - Sync localStorage persistence so themes apply immediately at startup without flash.
 */

import { clamp } from './calc-engine.js';

const STORAGE_NS = 'core-theme';
const STATE_KEY = 'theme-state-v1';

export const THEME_PRESETS = Object.freeze([
  {
    id: 'deep_tactical',
    name: '深海战术终端',
    mode: 'dark',
    previewColors: ['#0e1218', '#151b24', '#14b8a6', '#2dd4bf'],
    vars: {
      '--bg-canvas': '#080b10',
      '--bg-app': '#0d121a',
      '--bg-surface': 'rgba(21, 28, 39, 0.92)',
      '--bg-surface-elevated': 'rgba(30, 40, 56, 0.96)',
      '--surface-elevated': '#1e2838',
      '--bg-input': '#101620',
      '--border-subtle': 'rgba(148, 163, 184, 0.16)',
      '--border-strong': 'rgba(148, 163, 184, 0.30)',
      '--text-primary': '#f1f5f9',
      '--text-secondary': '#94a3b8',
      '--text-muted': '#64748b',
      '--accent': '#14b8a6',
      '--accent-hover': '#2dd4bf',
      '--accent-ink': '#042f2e',
      '--accent-soft': 'rgba(20, 184, 166, 0.16)',
      '--warn': '#f59e0b',
      '--warn-soft': 'rgba(245, 158, 11, 0.15)',
      '--danger': '#f87171',
      '--danger-soft': 'rgba(239, 68, 68, 0.16)',
      '--banner-bg': '#172233',
      '--banner-text': '#f8fafc',
      '--banner-border': 'rgba(45, 212, 191, 0.48)',
      '--banner-shadow': '0 10px 28px rgba(0, 0, 0, 0.42)',
      '--overlay-pill-bg': '#131c2a',
      '--overlay-pill-text': '#f8fafc',
      '--status-ok-text': '#2dd4bf',
      '--status-warn-text': '#fbbf24',
      '--status-danger-text': '#fca5a5',
    },
    defaultTexture: 'grid',
    themeColor: '#0d121a',
  },
  {
    id: 'fresh_breeze',
    name: '清爽海风白蓝',
    mode: 'light',
    previewColors: ['#eef5fc', '#ffffff', '#0284c7', '#38bdf8'],
    vars: {
      '--bg-canvas': '#dbeafe',
      '--bg-app': '#f0f7ff',
      '--bg-surface': 'rgba(255, 255, 255, 0.95)',
      '--bg-surface-elevated': '#eef6ff',
      '--surface-elevated': '#ffffff',
      '--bg-input': '#f8fbff',
      '--border-subtle': 'rgba(15, 23, 42, 0.12)',
      '--border-strong': 'rgba(2, 132, 199, 0.34)',
      '--text-primary': '#0f172a',
      '--text-secondary': '#334155',
      '--text-muted': '#475569',
      '--accent': '#0284c7',
      '--accent-hover': '#0369a1',
      '--accent-ink': '#ffffff',
      '--accent-soft': 'rgba(2, 132, 199, 0.13)',
      '--warn': '#b45309',
      '--warn-soft': 'rgba(217, 119, 6, 0.15)',
      '--danger': '#dc2626',
      '--danger-soft': 'rgba(220, 38, 38, 0.13)',
      '--banner-bg': '#ffffff',
      '--banner-text': '#0f172a',
      '--banner-border': 'rgba(2, 132, 199, 0.55)',
      '--banner-shadow': '0 10px 26px rgba(15, 23, 42, 0.16)',
      '--overlay-pill-bg': '#ffffff',
      '--overlay-pill-text': '#0f172a',
      '--status-ok-text': '#0369a1',
      '--status-warn-text': '#b45309',
      '--status-danger-text': '#b91c1c',
    },
    defaultTexture: 'waves',
    themeColor: '#f0f7ff',
  },
  {
    id: 'warm_harbor',
    name: '暖光日常港区',
    mode: 'light',
    previewColors: ['#fdf6ec', '#fffdf9', '#d97706', '#f59e0b'],
    vars: {
      '--bg-canvas': '#f3e5d0',
      '--bg-app': '#fdf7ee',
      '--bg-surface': 'rgba(255, 252, 246, 0.96)',
      '--bg-surface-elevated': '#fcf1df',
      '--surface-elevated': '#fffdf9',
      '--bg-input': '#fffaf2',
      '--border-subtle': 'rgba(120, 53, 15, 0.14)',
      '--border-strong': 'rgba(180, 83, 9, 0.34)',
      '--text-primary': '#23170d',
      '--text-secondary': '#533b28',
      '--text-muted': '#70553e',
      '--accent': '#c2610c',
      '--accent-hover': '#9a3412',
      '--accent-ink': '#ffffff',
      '--accent-soft': 'rgba(217, 119, 6, 0.15)',
      '--warn': '#b45309',
      '--warn-soft': 'rgba(234, 88, 12, 0.15)',
      '--danger': '#b91c1c',
      '--danger-soft': 'rgba(220, 38, 38, 0.13)',
      '--banner-bg': '#fffdf9',
      '--banner-text': '#23170d',
      '--banner-border': 'rgba(194, 97, 12, 0.55)',
      '--banner-shadow': '0 10px 26px rgba(120, 53, 15, 0.16)',
      '--overlay-pill-bg': '#fffdf9',
      '--overlay-pill-text': '#23170d',
      '--status-ok-text': '#9a3412',
      '--status-warn-text': '#b45309',
      '--status-danger-text': '#b91c1c',
    },
    defaultTexture: 'dots',
    themeColor: '#fdf7ee',
  },
  {
    id: 'gilded_night',
    name: '暗夜鎏金指挥室',
    mode: 'dark',
    previewColors: ['#0d0b09', '#191511', '#eab308', '#facc15'],
    vars: {
      '--bg-canvas': '#090806',
      '--bg-app': '#110e0b',
      '--bg-surface': 'rgba(27, 22, 17, 0.93)',
      '--bg-surface-elevated': 'rgba(38, 31, 23, 0.97)',
      '--surface-elevated': '#261f17',
      '--bg-input': '#15110d',
      '--border-subtle': 'rgba(234, 179, 8, 0.18)',
      '--border-strong': 'rgba(234, 179, 8, 0.36)',
      '--text-primary': '#faf5e8',
      '--text-secondary': '#c6b698',
      '--text-muted': '#968466',
      '--accent': '#eab308',
      '--accent-hover': '#facc15',
      '--accent-ink': '#1c1505',
      '--accent-soft': 'rgba(234, 179, 8, 0.16)',
      '--warn': '#fb923c',
      '--warn-soft': 'rgba(251, 146, 60, 0.16)',
      '--danger': '#f87171',
      '--danger-soft': 'rgba(239, 68, 68, 0.16)',
      '--banner-bg': '#261f16',
      '--banner-text': '#fdf7ea',
      '--banner-border': 'rgba(234, 179, 8, 0.55)',
      '--banner-shadow': '0 10px 28px rgba(0, 0, 0, 0.45)',
      '--overlay-pill-bg': '#221b13',
      '--overlay-pill-text': '#fdf7ea',
      '--status-ok-text': '#facc15',
      '--status-warn-text': '#fb923c',
      '--status-danger-text': '#fca5a5',
    },
    defaultTexture: 'grid',
    themeColor: '#110e0b',
  },
  {
    id: 'cozy_night_lamp',
    name: '夜灯微醺',
    mode: 'dark',
    previewColors: ['#140a0d', '#241217', '#f59e0b', '#fb7185'],
    vars: {
      '--bg-canvas': '#0c0507',
      '--bg-app': '#150a0d',
      '--bg-surface': 'rgba(34, 17, 22, 0.88)',
      '--bg-surface-elevated': 'rgba(48, 24, 30, 0.94)',
      '--surface-elevated': '#2e171d',
      '--bg-input': 'rgba(24, 11, 15, 0.92)',
      '--border-subtle': 'rgba(251, 191, 36, 0.16)',
      '--border-strong': 'rgba(251, 146, 60, 0.36)',
      '--text-primary': '#fdf4ec',
      '--text-secondary': '#dec1b8',
      '--text-muted': '#a6837c',
      '--accent': '#f59e0b',
      '--accent-hover': '#fbbf24',
      '--accent-ink': '#260f06',
      '--accent-soft': 'rgba(245, 158, 11, 0.17)',
      '--warn': '#fb7185',
      '--warn-soft': 'rgba(251, 113, 133, 0.18)',
      '--danger': '#f87171',
      '--danger-soft': 'rgba(239, 68, 68, 0.18)',
      '--banner-bg': '#2d151b',
      '--banner-text': '#fef3e7',
      '--banner-border': 'rgba(251, 191, 36, 0.52)',
      '--banner-shadow': '0 12px 30px rgba(10, 2, 5, 0.55)',
      '--overlay-pill-bg': '#291319',
      '--overlay-pill-text': '#fef3e7',
      '--status-ok-text': '#fbbf24',
      '--status-warn-text': '#fda4af',
      '--status-danger-text': '#fca5a5',
    },
    defaultTexture: 'dots',
    themeColor: '#150a0d',
  },
]);

export const DEFAULT_PORT_LAYOUT = Object.freeze([
  { id: 'commander', label: '指挥官角色卡', visible: true },
  { id: 'secretary', label: '秘书舰互动舞台', visible: true },
  { id: 'operations', label: '港区指挥中枢', visible: true },
  { id: 'buildings', label: '港区建筑设施网格', visible: true },
]);

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function hexToRgba(hex, alpha = 0.16) {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(20, 184, 166, ${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/**
 * Pick readable ink color (#0f172a vs #ffffff) for any custom accent hex color using WCAG relative luminance.
 */
function pickContrastInk(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#ffffff';
  const toLin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * toLin(rgb.r) + 0.7152 * toLin(rgb.g) + 0.0722 * toLin(rgb.b);
  return lum > 0.42 ? '#0f172a' : '#ffffff';
}

function createDefaultThemeState() {
  return {
    presetId: 'deep_tactical',
    customAccent: null,
    customHighlight: null,
    cardRadius: 14,
    texture: 'grid', // 'none' | 'grid' | 'dots' | 'waves'
    typewriterSpeed: 18, // ms per char, 0 = instant
    portLayout: deepClone(DEFAULT_PORT_LAYOUT),
  };
}

export class ThemeManager {
  /**
   * @param {{
   *   storage?: import('./storage.js').StorageManager | null,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} [deps]
   */
  constructor({ storage = null, bus = null } = {}) {
    this._store = storage ? storage.namespace(STORAGE_NS) : null;
    this._bus = bus;
    this._state = this._loadSync();
  }

  _emit(event, payload) {
    if (this._bus) this._bus.emit(event, payload);
  }

  _sanitizeState(raw = {}) {
    const def = createDefaultThemeState();
    const presetExists = THEME_PRESETS.some((p) => p.id === raw.presetId);
    const presetId = presetExists ? raw.presetId : def.presetId;

    const rawLayout = Array.isArray(raw.portLayout) ? raw.portLayout : def.portLayout;
    const seen = new Set();
    const layout = [];
    for (const item of rawLayout) {
      if (!item || !item.id || seen.has(item.id)) continue;
      const baseDef = DEFAULT_PORT_LAYOUT.find((d) => d.id === item.id);
      if (!baseDef) continue;
      seen.add(item.id);
      layout.push({
        id: baseDef.id,
        label: baseDef.label,
        visible: item.visible !== false,
      });
    }
    for (const baseDef of DEFAULT_PORT_LAYOUT) {
      if (!seen.has(baseDef.id)) {
        layout.push({ ...baseDef });
      }
    }

    return {
      presetId,
      customAccent: /^#[0-9a-fA-F]{6}$/.test(String(raw.customAccent || '')) ? raw.customAccent : null,
      customHighlight: /^#[0-9a-fA-F]{6}$/.test(String(raw.customHighlight || '')) ? raw.customHighlight : null,
      cardRadius: clamp(Math.round(Number(raw.cardRadius ?? def.cardRadius)), 6, 26),
      texture: ['none', 'grid', 'dots', 'waves'].includes(raw.texture) ? raw.texture : def.texture,
      typewriterSpeed: clamp(Math.round(Number(raw.typewriterSpeed ?? def.typewriterSpeed)), 0, 60),
      portLayout: layout,
    };
  }

  _loadSync() {
    if (!this._store) return createDefaultThemeState();
    const saved = this._store.get(STATE_KEY, null);
    return this._sanitizeState(saved || {});
  }

  _saveSync() {
    if (this._store) {
      this._store.set(STATE_KEY, deepClone(this._state));
    }
  }

  listPresets() {
    return deepClone(THEME_PRESETS);
  }

  getState() {
    return deepClone(this._state);
  }

  getActivePreset() {
    return THEME_PRESETS.find((p) => p.id === this._state.presetId) || THEME_PRESETS[0];
  }

  getTypewriterSpeed() {
    return this._state.typewriterSpeed;
  }

  getPortLayout() {
    return deepClone(this._state.portLayout);
  }

  applyTheme() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const preset = this.getActivePreset();

    root.dataset.theme = preset.id;
    root.dataset.themeMode = preset.mode;
    root.dataset.bgTexture = this._state.texture || 'none';

    for (const [varName, val] of Object.entries(preset.vars)) {
      root.style.setProperty(varName, val);
    }

    if (this._state.customAccent) {
      root.style.setProperty('--accent', this._state.customAccent);
      root.style.setProperty('--accent-soft', hexToRgba(this._state.customAccent, 0.15));
      root.style.setProperty('--accent-ink', pickContrastInk(this._state.customAccent));
      root.style.setProperty('--banner-border', hexToRgba(this._state.customAccent, 0.55));
    }
    if (this._state.customHighlight) {
      root.style.setProperty('--accent-hover', this._state.customHighlight);
    }

    const r = this._state.cardRadius;
    root.style.setProperty('--radius-md', `${r}px`);
    root.style.setProperty('--radius-sm', `${Math.max(6, r - 4)}px`);
    root.style.setProperty('--radius-lg', `${Math.min(28, r + 6)}px`);

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', preset.themeColor);
    }
  }

  setPreset(presetId) {
    const preset = THEME_PRESETS.find((p) => p.id === presetId);
    if (!preset) return this.getState();
    this._state.presetId = preset.id;
    this._state.customAccent = null;
    this._state.customHighlight = null;
    this._state.texture = preset.defaultTexture || 'grid';
    this._saveSync();
    this.applyTheme();
    this._emit('theme:changed', this.getState());
    return this.getState();
  }

  updateCustomVars(patch = {}) {
    this._state = this._sanitizeState({
      ...this._state,
      ...patch,
    });
    this._saveSync();
    this.applyTheme();
    this._emit('theme:changed', this.getState());
    return this.getState();
  }

  updatePortLayout(nextLayout) {
    this._state = this._sanitizeState({
      ...this._state,
      portLayout: nextLayout,
    });
    this._saveSync();
    this._emit('theme:layout-changed', this.getPortLayout());
    return this.getPortLayout();
  }

  resetTheme() {
    this._state = createDefaultThemeState();
    this._saveSync();
    this.applyTheme();
    this._emit('theme:changed', this.getState());
    return this.getState();
  }

  serialize() {
    return deepClone(this._state);
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._state = this._sanitizeState(snapshot);
    if (persist) this._saveSync();
    this.applyTheme();
    this._emit('theme:changed', this.getState());
  }
}
