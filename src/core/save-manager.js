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

import {
  GRID_TOTAL_CELLS,
  KNOWN_EQUIPMENT_TYPES,
  KNOWN_EQUIPMENT_TYPE_MAP,
  STAR_SEA_TIER_ORDER,
  inferEquipmentTypeId,
  inferItemRarity,
  normalizeLegacyItemBonusesToCompressedScale,
  normalizeLegacyShipStatsToCompressedScale,
  resolveShipClass,
} from './stat-rules.js';

export const SAVE_ZONES = Object.freeze({
  GLOBAL_SETTINGS: 'save-global-settings',
  AUTO_SAVE: 'save-auto',
  MANUAL_SLOTS: 'save-slots',
  CUSTOM_MODS: 'save-mods',
});

export const DEFAULT_SLOT_COUNT = 5;
export const VAULT_PRIMARY_SLOTS = 3;
export const SAVE_SCHEMA_VERSION = 9;

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

/**
 * Lossless save payload migration: preserves every existing character, item, resource,
 * building, or custom field while safely backfilling any fields introduced in v2..v8+
 * (including 1★~5★ sea control migration, retrofitCores, and 2-digit compressed stat normalization).
 */
export function migrateSavePayload(rawData = {}) {
  const data = rawData && typeof rawData === 'object' ? deepClone(rawData) : {};
  let migrated = false;

  if (!data.commander || typeof data.commander !== 'object') {
    data.commander = {
      name: '港区指挥官',
      title: '新任提督',
      level: 1,
      exp: 0,
      freePoints: 0,
      stats: { command: 10, tactics: 10, charisma: 10, affinity: 10, dispatch: 10, maintenance: 10 },
      luck: 0,
    };
    migrated = true;
  } else if (data.commander.luck === undefined) {
    data.commander.luck = 0;
    migrated = true;
  }

  if (!data.entities || typeof data.entities !== 'object') {
    data.entities = { entities: [], tasks: [] };
    migrated = true;
  } else {
    if (!Array.isArray(data.entities.entities)) {
      data.entities.entities = [];
      migrated = true;
    }
    if (!Array.isArray(data.entities.tasks)) {
      data.entities.tasks = [];
      migrated = true;
    }
  }

  if (!data.inventory || typeof data.inventory !== 'object') {
    data.inventory = {
      version: 6,
      customSlotsByCharacter: {},
      items: [],
      equipped: {},
      salvageParts: 0,
      retrofitCores: 0,
    };
    migrated = true;
  } else {
    if (!Array.isArray(data.inventory.items)) {
      data.inventory.items = [];
      migrated = true;
    }
    if (!data.inventory.equipped || typeof data.inventory.equipped !== 'object') {
      data.inventory.equipped = {};
      migrated = true;
    }
    if (!data.inventory.customSlotsByCharacter || typeof data.inventory.customSlotsByCharacter !== 'object') {
      data.inventory.customSlotsByCharacter = {};
      migrated = true;
    }
    if (data.inventory.salvageParts === undefined || !Number.isFinite(Number(data.inventory.salvageParts))) {
      data.inventory.salvageParts = 0;
      migrated = true;
    }
    if (data.inventory.retrofitCores === undefined || !Number.isFinite(Number(data.inventory.retrofitCores))) {
      data.inventory.retrofitCores = 0;
      migrated = true;
    }
  }

  if (!data.expeditions || typeof data.expeditions !== 'object') {
    data.expeditions = { version: 1, completedCount: 0, activeRuns: [] };
    migrated = true;
  }

  if (!data.buildings || typeof data.buildings !== 'object') {
    data.buildings = {
      version: 2,
      dormitory: { level: 1, capacity: 3, maxCapacity: 12, residents: [], lastSettledAt: Date.now() },
      dockyard: { level: 1, capacity: 2, maxCapacity: 6, queue: [], completedRepairs: 0, constructedCount: 0 },
      customBuildings: [],
      medals: { unlockedIds: [], unlockedAt: {} },
      updatedAt: Date.now(),
    };
    migrated = true;
  } else if (!data.buildings.medals || typeof data.buildings.medals !== 'object') {
    data.buildings.medals = { unlockedIds: [], unlockedAt: {} };
    migrated = true;
  }

  if (!data.interaction || typeof data.interaction !== 'object') {
    data.interaction = { version: 1, secretaryId: null, oaths: {}, lastInteraction: null, interactionHistory: [] };
    migrated = true;
  }

  // Schema v8: Losslessly migrate legacy low/medium/high seaControl into 1★~5★ star_1..star_5
  if (!data.seaControl || typeof data.seaControl !== 'object') {
    const emptyZones = {};
    for (const id of STAR_SEA_TIER_ORDER) emptyZones[id] = { progress: 0, clearedCount: 0, controlledAt: null };
    data.seaControl = { version: 2, zones: emptyZones };
    migrated = true;
  } else {
    const rawZ = data.seaControl.zones || {};
    if (!rawZ.star_1 && (rawZ.low || rawZ.medium || rawZ.high)) {
      data.seaControl = {
        version: 2,
        zones: {
          star_1: rawZ.low || { progress: 0, clearedCount: 0, controlledAt: null },
          star_2: rawZ.medium || { progress: 0, clearedCount: 0, controlledAt: null },
          star_3: rawZ.high || { progress: 0, clearedCount: 0, controlledAt: null },
          star_4: rawZ.star_4 || { progress: 0, clearedCount: 0, controlledAt: null },
          star_5: rawZ.star_5 || { progress: 0, clearedCount: 0, controlledAt: null },
        },
      };
      migrated = true;
    }
  }

  if (!data.contentManager || typeof data.contentManager !== 'object') {
    data.contentManager = {
      version: 1,
      customEnemies: [],
      customDialogues: [],
      customGifts: [],
      customEquipment: [],
      encounteredEnemyNames: ['前哨巡逻编队'],
      clearedRouteIds: [],
      updatedAt: Date.now(),
    };
    migrated = true;
  }

  if (!data.storyPacks || typeof data.storyPacks !== 'object') {
    data.storyPacks = { version: 1, flags: {}, packs: [], playHistory: [] };
    migrated = true;
  } else {
    if (!data.storyPacks.flags || typeof data.storyPacks.flags !== 'object') {
      data.storyPacks.flags = {};
      migrated = true;
    }
    if (!Array.isArray(data.storyPacks.playHistory)) {
      data.storyPacks.playHistory = [];
      migrated = true;
    }
  }

  if (!data.theme || typeof data.theme !== 'object') {
    data.theme = { presetId: 'deep_tactical', cardRadius: 14, texture: 'grid', typewriterSpeed: 18 };
    migrated = true;
  }

  // Losslessly backfill Shipgirl level/exp/maxExp AND compress legacy 3-digit stats into 2-digit scale
  const entityList = Array.isArray(data.entities?.entities) ? data.entities.entities : [];
  const entityById = new Map();
  for (const ent of entityList) {
    if (ent?.id) entityById.set(String(ent.id), ent);
    if (!ent || ent.kind !== 'character') continue;
    if (!ent.stats || typeof ent.stats !== 'object') ent.stats = {};
    if (ent.stats.level === undefined || !Number.isFinite(Number(ent.stats.level))) {
      ent.stats.level = 1;
      migrated = true;
    }
    if (ent.stats.exp === undefined || !Number.isFinite(Number(ent.stats.exp))) {
      ent.stats.exp = 0;
      migrated = true;
    }
    if (ent.stats.maxExp === undefined || !Number.isFinite(Number(ent.stats.maxExp))) {
      const lv = Math.max(1, Math.floor(Number(ent.stats.level) || 1));
      ent.stats.maxExp = 100 + (lv - 1) * 50;
      migrated = true;
    }
    if (normalizeLegacyShipStatsToCompressedScale(ent)) {
      migrated = true;
    }
  }

  // Losslessly backfill universal White->Orange rarity, canonical equipmentType, and 2-digit compressed gear bonuses
  const invItems = Array.isArray(data.inventory?.items) ? data.inventory.items : [];
  const itemById = new Map();
  for (let i = 0; i < invItems.length; i++) {
    const it = invItems[i];
    if (!it || typeof it !== 'object') continue;
    if (!it.rarity) {
      it.rarity = inferItemRarity(it);
      migrated = true;
    }
    if (it.category !== 'consumable' && !it.equipmentType) {
      const eqType = inferEquipmentTypeId(it, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
      it.equipmentType = eqType;
      if (!it.subCategory) it.subCategory = eqType;
      migrated = true;
    }
    if (Number(it.statScaleVersion || 0) < 2) {
      invItems[i] = normalizeLegacyItemBonusesToCompressedScale(it);
      migrated = true;
    }
    if (invItems[i].id) itemById.set(String(invItems[i].id), invItems[i]);
  }

  // Schema v5+: Losslessly migrate historical freeform custom slots into typed expandable slots
  const customSlotsMap = data.inventory?.customSlotsByCharacter;
  if (customSlotsMap && typeof customSlotsMap === 'object') {
    const equippedMap = data.inventory?.equipped || {};
    for (const [charId, slotList] of Object.entries(customSlotsMap)) {
      if (!Array.isArray(slotList)) continue;
      const charEq = equippedMap[charId] || {};
      customSlotsMap[charId] = slotList.map((slot) => {
        if (!slot || typeof slot !== 'object') return slot;
        if (slot.equipmentType && KNOWN_EQUIPMENT_TYPE_MAP[slot.equipmentType] && Array.isArray(slot.allowedEquipmentTypes)) {
          return slot;
        }
        const equippedItemId = slot.id ? charEq[slot.id] : null;
        const equippedItem = equippedItemId ? itemById.get(String(equippedItemId)) : null;
        const inferredType = equippedItem
          ? inferEquipmentTypeId(equippedItem, KNOWN_EQUIPMENT_TYPES.MAIN_GUN)
          : inferEquipmentTypeId(slot, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
        const typeId = KNOWN_EQUIPMENT_TYPE_MAP[inferredType] ? inferredType : KNOWN_EQUIPMENT_TYPES.MAIN_GUN;
        const typeDef = KNOWN_EQUIPMENT_TYPE_MAP[typeId];
        migrated = true;
        return {
          ...slot,
          equipmentType: typeDef.id,
          label: typeDef.slotLabel || typeDef.label,
          typeLabel: typeDef.label,
          group: typeDef.group,
          iconKey: typeDef.defaultIcon,
          required: false,
          custom: true,
          expandable: true,
          allowedCategories: [typeDef.category],
          allowedEquipmentTypes: [typeDef.id],
        };
      });
    }
  }

  // Schema v6/v7: Ensure formation object always exists & map legacy memberIds into 3x4 gridSlots (length 12)
  if (!data.formation || typeof data.formation !== 'object') {
    data.formation = {
      version: 2,
      memberIds: [],
      gridSlots: Array(GRID_TOTAL_CELLS).fill(null),
      formationId: 'line_ahead',
      customFormationMods: {},
    };
    migrated = true;
  } else {
    const fMembers = Array.isArray(data.formation.memberIds) ? data.formation.memberIds.map(String) : [];
    const hasValidGrid =
      Array.isArray(data.formation.gridSlots) && data.formation.gridSlots.length === GRID_TOTAL_CELLS;
    if (!hasValidGrid) {
      const grid = Array(GRID_TOTAL_CELLS).fill(null);
      const pickCell = (cls) => {
        const pref = cls === 'DD' || cls === 'CL' || cls === 'SS' ? [0, 1, 2] : cls === 'CA' ? [1, 0, 2] : [2, 1, 0];
        for (const r of pref) {
          for (const c of [1, 2, 0, 3]) {
            const idx = r * 4 + c;
            if (grid[idx] === null) return idx;
          }
        }
        return grid.findIndex((x) => x === null);
      };
      for (const cid of fMembers) {
        const ent = entityById.get(cid);
        const cls = resolveShipClass(ent?.meta?.shipType || '');
        const idx = pickCell(cls);
        if (idx >= 0) grid[idx] = cid;
      }
      data.formation.gridSlots = grid;
      data.formation.version = 2;
      migrated = true;
    }
  }

  // Schema v9: Ensure storyEngine bubble-chat & 6-stage breakthrough state exists,
  // auto-unlock crossed gates for legacy high-affinity ships, and purge deprecated legacy built-in story packs
  if (!data.storyEngine || typeof data.storyEngine !== 'object') {
    const unlockedBreakthroughs = {};
    for (const ent of data.entities?.entities || []) {
      if (ent?.kind !== 'character' || !ent.id) continue;
      const aff = Math.round(Number(ent.stats?.affinity ?? 0));
      const crossed = [20, 40, 60, 80, 100].filter((g) => aff >= g);
      if (crossed.length > 0) unlockedBreakthroughs[ent.id] = crossed;
    }
    data.storyEngine = {
      version: 1,
      chatLogsByShip: {},
      dailyTalkByShip: {},
      unlockedBreakthroughs,
      activePromptByShip: {},
    };
    migrated = true;
  }

  if (data.storyPacks && Array.isArray(data.storyPacks.packs)) {
    const legacyIds = new Set([
      'pack_port_daily_ext',
      'pack_sea_investigation',
      'pack_port_life_15',
      'pack_abyssal_ruins_4ch',
      'pack_abyssal_ruins_04',
    ]);
    const beforeLen = data.storyPacks.packs.length;
    data.storyPacks.packs = data.storyPacks.packs.filter(
      (p) => p && p.id && !legacyIds.has(String(p.id)) && p.builtIn !== true
    );
    if (data.storyPacks.packs.length !== beforeLen) migrated = true;
  }

  return { data, migrated };
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
    /** @type {Set<() => void>} */
    this._autoSaveCancelers = new Set();
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
      const { data, migrated } = migrateSavePayload(record.data);
      record.data = data;
      record.schemaVersion = SAVE_SCHEMA_VERSION;
      record.migrated = migrated;
      this._emit('save:auto-loaded', { meta: record.meta, migrated });
    }
    return record;
  }

  async getAutoSaveMeta() {
    const record = await this._autoScope.getLarge('latest', null);
    return record ? record.meta : null;
  }

  async clearAutoSave() {
    this.cancelPendingAutoSaves();
    await this._autoScope.removeLarge('latest');
    this._emit('save:auto-cleared', {});
  }

  cancelPendingAutoSaves() {
    for (const cancel of Array.from(this._autoSaveCancelers)) {
      try {
        cancel();
      } catch {
        // ignore
      }
    }
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

    const cancelPending = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const flush = async () => {
      timer = null;
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
        cancelPending();
        if (debounceMs <= 0) {
          flush();
        } else {
          timer = setTimeout(flush, debounceMs);
        }
      })
    );

    const unbind = () => {
      active = false;
      cancelPending();
      unsubs.forEach((u) => u());
      this._autoSaveUnbinders.delete(unbind);
      this._autoSaveCancelers.delete(cancelPending);
    };

    this._autoSaveCancelers.add(cancelPending);
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
      const { data, migrated } = migrateSavePayload(record.data);
      record.data = data;
      record.schemaVersion = SAVE_SCHEMA_VERSION;
      record.migrated = migrated;
      this._emit('save:loaded', { slotIndex: idx, meta: record.meta, migrated });
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
    const { data } = migrateSavePayload(parsed.record.data);
    return this.saveSlot(idx, data, {
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
      const { data } = migrateSavePayload(autoSave.data);
      await this._autoScope.setLarge('latest', {
        ...autoSave,
        schemaVersion: SAVE_SCHEMA_VERSION,
        data,
      });
    }

    if (slots && typeof slots === 'object') {
      for (const [k, rec] of Object.entries(slots)) {
        if (!rec || typeof rec !== 'object') continue;
        const { data } = migrateSavePayload(rec.data);
        await this._slotsScope.setLarge(k, {
          ...rec,
          schemaVersion: SAVE_SCHEMA_VERSION,
          data,
        });
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
