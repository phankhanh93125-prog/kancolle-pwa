/**
 * Multi-Slot Auto & Manual Save Manager.
 *
 * Partitions persistence into 4 dedicated zones backed by StorageManager (IndexedDB + localStorage):
 *   1. Global Settings Zone   (globalSettings)
 *   2. Auto-Save Snapshot Zone (autoSave)
 *   3. 5 Manual Save Slots     (slot-1 .. slot-5)
 *   4. Custom Mod Data Zone    (mods)
 *
 * Supports event-driven auto-saving, single-slot and full-bundle JSON export/import.
 */

export const SAVE_ZONES = Object.freeze({
  GLOBAL_SETTINGS: 'save-global-settings',
  AUTO_SAVE: 'save-auto',
  MANUAL_SLOTS: 'save-slots',
  CUSTOM_MODS: 'save-mods',
});

export const DEFAULT_SLOT_COUNT = 5;
const SAVE_SCHEMA_VERSION = 1;

function deepClone(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON clone
    }
  }
  return JSON.parse(JSON.stringify(value ?? null));
}

function slotKey(slotIndex) {
  return `slot-${slotIndex}`;
}

export function triggerJsonDownload(filename, payload) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class SaveManager {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   bus?: import('./event-bus.js').EventBus | null,
   *   slotCount?: number
   * }} deps
   */
  constructor({ storage, bus = null, slotCount = DEFAULT_SLOT_COUNT }) {
    this._storage = storage;
    this._bus = bus;
    this.slotCount = Math.max(1, Number(slotCount) || DEFAULT_SLOT_COUNT);

    this._settingsScope = storage.namespace(SAVE_ZONES.GLOBAL_SETTINGS);
    this._autoScope = storage.namespace(SAVE_ZONES.AUTO_SAVE);
    this._slotsScope = storage.namespace(SAVE_ZONES.MANUAL_SLOTS);
    this._modsScope = storage.namespace(SAVE_ZONES.CUSTOM_MODS);

    /** @type {Set<() => void>} */
    this._autoSaveUnbinders = new Set();
  }

  _assertSlotIndex(slotIndex) {
    const idx = Number(slotIndex);
    if (!Number.isInteger(idx) || idx < 1 || idx > this.slotCount) {
      throw new RangeError(`存档槽位编号必须在 1 ~ ${this.slotCount} 之间，收到: ${slotIndex}`);
    }
    return idx;
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  // ------------------------------------------------------------
  // Zone 1: Global Settings (sync localStorage for fast boot)
  // ------------------------------------------------------------

  getGlobalSettings() {
    return this._settingsScope.get('settings', {});
  }

  setGlobalSettings(nextSettings) {
    const clean = nextSettings && typeof nextSettings === 'object' ? deepClone(nextSettings) : {};
    this._settingsScope.set('settings', clean);
    this._emit('save:settings-changed', clean);
    return clean;
  }

  updateGlobalSetting(key, value) {
    const current = this.getGlobalSettings();
    current[key] = value;
    return this.setGlobalSettings(current);
  }

  // ------------------------------------------------------------
  // Zone 2: Auto-Save Snapshot (IndexedDB)
  // ------------------------------------------------------------

  async autoSave(data, { reason = 'auto', summary = null, name = '自动存档快照' } = {}) {
    const now = Date.now();
    const record = {
      id: 'auto-snapshot',
      zone: 'auto',
      schemaVersion: SAVE_SCHEMA_VERSION,
      meta: {
        name: String(name || '自动存档快照'),
        reason: String(reason || 'auto'),
        timestamp: now,
        savedAt: new Date(now).toISOString(),
        summary: summary ?? null,
      },
      data: deepClone(data),
    };
    await this._autoScope.setLarge('latest', record);
    this._emit('save:auto-saved', { meta: record.meta });
    return record;
  }

  async loadAutoSave() {
    const record = await this._autoScope.getLarge('latest', null);
    if (record) {
      this._emit('save:auto-loaded', { meta: record.meta });
    }
    return record;
  }

  async getAutoSaveMeta() {
    const record = await this._autoScope.getLarge('latest', null);
    return record ? record.meta : null;
  }

  async clearAutoSave() {
    await this._autoScope.removeLarge('latest');
    this._emit('save:auto-cleared', {});
  }

  /**
   * Listen to critical EventBus events and automatically trigger debounced auto-save snapshots.
   *
   * @param {string[]} events - Event names to watch (e.g. ['state:changed', 'turn:advanced'])
   * @param {(eventName: string, payload: any) => ({ data: any, summary?: any, name?: string } | null)} stateProvider
   * @param {{ debounceMs?: number, enabled?: () => boolean }} [options]
   * @returns {() => void} Unbind function
   */
  bindAutoSaveEvents(events = [], stateProvider, { debounceMs = 250, enabled = () => true } = {}) {
    if (!this._bus) {
      throw new Error('SaveManager.bindAutoSaveEvents 需要 EventBus 实例');
    }
    if (typeof stateProvider !== 'function') {
      throw new TypeError('stateProvider 必须是函数');
    }

    let timer = null;
    let pendingReason = 'event';
    let pendingPayload = null;
    let active = true;

    const flush = async () => {
      if (!active || !enabled()) return;
      try {
        const snapshot = stateProvider(pendingReason, pendingPayload);
        if (!snapshot || snapshot.data === undefined) return;
        await this.autoSave(snapshot.data, {
          reason: pendingReason,
          summary: snapshot.summary ?? null,
          name: snapshot.name || '自动存档快照',
        });
      } catch (err) {
        console.error('[SaveManager] Auto-save failed:', err);
      }
    };

    const unsubs = events.map((eventName) =>
      this._bus.on(eventName, (payload) => {
        if (!active || !enabled()) return;
        pendingReason = eventName;
        pendingPayload = payload;
        if (timer) clearTimeout(timer);
        if (debounceMs <= 0) {
          flush();
        } else {
          timer = setTimeout(flush, debounceMs);
        }
      })
    );

    const unbind = () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      unsubs.forEach((u) => u());
      this._autoSaveUnbinders.delete(unbind);
    };

    this._autoSaveUnbinders.add(unbind);
    return unbind;
  }

  unbindAllAutoSaveEvents() {
    for (const unbind of Array.from(this._autoSaveUnbinders)) {
      unbind();
    }
  }

  // ------------------------------------------------------------
  // Zone 3: 5 Independent Manual Save Slots (IndexedDB)
  // ------------------------------------------------------------

  async saveSlot(slotIndex, data, { name, summary = null, tags = [], thumbnailAssetId = null } = {}) {
    const idx = this._assertSlotIndex(slotIndex);
    const now = Date.now();
    const record = {
      id: slotKey(idx),
      slotIndex: idx,
      zone: 'manual',
      schemaVersion: SAVE_SCHEMA_VERSION,
      meta: {
        slotIndex: idx,
        name: String(name || `手动存档 #${idx}`).trim(),
        timestamp: now,
        savedAt: new Date(now).toISOString(),
        summary: summary ?? null,
        tags: Array.isArray(tags) ? [...tags] : [],
        thumbnailAssetId: thumbnailAssetId || null,
      },
      data: deepClone(data),
    };
    await this._slotsScope.setLarge(slotKey(idx), record);
    this._emit('save:saved', { slotIndex: idx, meta: record.meta });
    return record;
  }

  async loadSlot(slotIndex) {
    const idx = this._assertSlotIndex(slotIndex);
    const record = await this._slotsScope.getLarge(slotKey(idx), null);
    if (record) {
      this._emit('save:loaded', { slotIndex: idx, meta: record.meta });
    }
    return record;
  }

  async deleteSlot(slotIndex) {
    const idx = this._assertSlotIndex(slotIndex);
    await this._slotsScope.removeLarge(slotKey(idx));
    this._emit('save:deleted', { slotIndex: idx });
    return true;
  }

  async listSlots() {
    const all = await this._slotsScope.getAllLarge();
    const list = [];
    for (let i = 1; i <= this.slotCount; i++) {
      const key = slotKey(i);
      const record = all[key] || null;
      list.push({
        slotIndex: i,
        id: key,
        empty: !record,
        meta: record ? record.meta : null,
      });
    }
    return list;
  }

  // ------------------------------------------------------------
  // Zone 4: Custom Mod Data Zone (IndexedDB)
  // ------------------------------------------------------------

  async saveModData(modId, data, { name, version = '1.0.0', description = '' } = {}) {
    const cleanId = String(modId || '').trim();
    if (!cleanId) throw new Error('modId 不能为空');
    const now = Date.now();
    const record = {
      modId: cleanId,
      meta: {
        modId: cleanId,
        name: String(name || cleanId),
        version: String(version || '1.0.0'),
        description: String(description || ''),
        updatedAt: now,
        updatedAtIso: new Date(now).toISOString(),
      },
      data: deepClone(data),
    };
    await this._modsScope.setLarge(cleanId, record);
    this._emit('save:mod-saved', { modId: cleanId, meta: record.meta });
    return record;
  }

  async loadModData(modId) {
    const cleanId = String(modId || '').trim();
    if (!cleanId) return null;
    return this._modsScope.getLarge(cleanId, null);
  }

  async listModData() {
    const all = await this._modsScope.getAllLarge();
    return Object.values(all)
      .map((rec) => rec.meta)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async deleteModData(modId) {
    const cleanId = String(modId || '').trim();
    if (!cleanId) return false;
    await this._modsScope.removeLarge(cleanId);
    this._emit('save:mod-deleted', { modId: cleanId });
    return true;
  }

  // ------------------------------------------------------------
  // Single-Slot & Full-Database JSON Export / Import
  // ------------------------------------------------------------

  async exportSlotToJSON(slotIndex) {
    const idx = this._assertSlotIndex(slotIndex);
    const record = await this._slotsScope.getLarge(slotKey(idx), null);
    if (!record) {
      throw new Error(`槽位 ${idx} 为空，无法导出`);
    }
    return {
      schema: 'pwa-game-save-slot',
      version: SAVE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      slotIndex: idx,
      record,
    };
  }

  async importSlotFromJSON(input, targetSlotIndex = null) {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (!parsed || parsed.schema !== 'pwa-game-save-slot' || !parsed.record) {
      throw new Error('无效的单槽位存档 JSON 文件');
    }
    const idx = this._assertSlotIndex(targetSlotIndex ?? parsed.slotIndex ?? parsed.record.slotIndex ?? 1);
    const srcMeta = parsed.record.meta || {};
    return this.saveSlot(idx, parsed.record.data, {
      name: srcMeta.name || `导入存档 #${idx}`,
      summary: srcMeta.summary ?? null,
      tags: srcMeta.tags || [],
      thumbnailAssetId: srcMeta.thumbnailAssetId || null,
    });
  }

  async exportAllToJSON() {
    const [autoSave, slotsMap, modsMap] = await Promise.all([
      this._autoScope.getLarge('latest', null),
      this._slotsScope.getAllLarge(),
      this._modsScope.getAllLarge(),
    ]);
    return {
      schema: 'pwa-game-save-bundle',
      version: SAVE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      slotCount: this.slotCount,
      zones: {
        globalSettings: this.getGlobalSettings(),
        autoSave,
        slots: slotsMap,
        mods: modsMap,
      },
    };
  }

  async importAllFromJSON(input, { replace = false } = {}) {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (!parsed || parsed.schema !== 'pwa-game-save-bundle' || !parsed.zones) {
      throw new Error('无效的全库存档包 JSON 文件');
    }

    if (replace) {
      await Promise.all([
        this._autoScope.clearLarge(),
        this._slotsScope.clearLarge(),
        this._modsScope.clearLarge(),
      ]);
      this._settingsScope.clear();
    }

    const { globalSettings, autoSave, slots, mods } = parsed.zones;
    let importedSlots = 0;
    let importedMods = 0;

    if (globalSettings && typeof globalSettings === 'object') {
      this.setGlobalSettings(globalSettings);
    }

    if (autoSave && typeof autoSave === 'object') {
      await this._autoScope.setLarge('latest', autoSave);
    }

    if (slots && typeof slots === 'object') {
      for (const [k, rec] of Object.entries(slots)) {
        if (!rec || typeof rec !== 'object') continue;
        await this._slotsScope.setLarge(k, rec);
        importedSlots += 1;
      }
    }

    if (mods && typeof mods === 'object') {
      for (const [modId, rec] of Object.entries(mods)) {
        if (!rec || typeof rec !== 'object') continue;
        await this._modsScope.setLarge(modId, rec);
        importedMods += 1;
      }
    }

    this._emit('save:bundle-imported', { importedSlots, importedMods, hasAutoSave: Boolean(autoSave) });
    return { importedSlots, importedMods, hasAutoSave: Boolean(autoSave) };
  }
}
