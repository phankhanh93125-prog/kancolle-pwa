/**
 * Generic Inventory, Equipment & Outfit System.
 *
 * Manages:
 *   1. Global Item Warehouse (categories: 'outfit', 'equipment', 'consumable')
 *      with custom name, description, category tags, and multi-entry stat bonus affixes.
 *   2. Character Equipment Slots (defaults: 'outfit', 'main_equip', 'sub_equip', 'accessory';
 *      supports adding/removing custom slots).
 *   3. Automatic EntitySystem stat recalculation + EventBus notifications + IndexedDB persistence
 *      whenever items are equipped, unequipped, updated, or consumed.
 */

const STORAGE_NS = 'core-inventory';
const STATE_KEY = 'inventory-state';

export const ITEM_CATEGORIES = Object.freeze({
  OUTFIT: 'outfit',
  EQUIPMENT: 'equipment',
  CONSUMABLE: 'consumable',
});

export const ITEM_CATEGORY_LABELS = Object.freeze({
  [ITEM_CATEGORIES.OUTFIT]: '服装',
  [ITEM_CATEGORIES.EQUIPMENT]: '装备',
  [ITEM_CATEGORIES.CONSUMABLE]: '消耗品',
});

export const DEFAULT_EQUIPMENT_SLOTS = Object.freeze([
  { id: 'outfit', label: '服装', allowedCategories: [ITEM_CATEGORIES.OUTFIT] },
  { id: 'main_equip', label: '主装备', allowedCategories: [ITEM_CATEGORIES.EQUIPMENT] },
  { id: 'sub_equip', label: '副装备', allowedCategories: [ITEM_CATEGORIES.EQUIPMENT] },
  { id: 'accessory', label: '饰品', allowedCategories: [ITEM_CATEGORIES.EQUIPMENT, ITEM_CATEGORIES.OUTFIT] },
]);

export const STARTER_ITEMS = [
  {
    id: 'item_outfit_standard',
    name: '标准常服',
    category: ITEM_CATEGORIES.OUTFIT,
    slotType: 'outfit',
    tags: ['日常', '轻便'],
    description: '剪裁整洁的通用日常服装，兼顾行动灵活度与基础防护。',
    quantity: 2,
    bonuses: [
      { stat: 'agility', layer: 'baseAdd', value: 8 },
      { stat: 'tactics', layer: 'baseAdd', value: 5 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 1 },
    ],
  },
  {
    id: 'item_equip_main_01',
    name: '标准突击模块',
    category: ITEM_CATEGORIES.EQUIPMENT,
    slotType: 'main_equip',
    tags: ['主装备', '输出'],
    description: '通用制式主装备，显著提升正面攻击与瞬间爆发能力。',
    quantity: 2,
    bonuses: [
      { stat: 'attack', layer: 'baseAdd', value: 14 },
      { stat: 'burst', layer: 'baseAdd', value: 10 },
    ],
  },
  {
    id: 'item_equip_sub_01',
    name: '战术侦察单元',
    category: ITEM_CATEGORIES.EQUIPMENT,
    slotType: 'sub_equip',
    tags: ['副装备', '侦察'],
    description: '辅助态势感知装置，提供战术与机动加成。',
    quantity: 2,
    bonuses: [
      { stat: 'tactics', layer: 'baseAdd', value: 12 },
      { stat: 'agility', layer: 'baseAdd', value: 6 },
    ],
  },
  {
    id: 'item_acc_lucky_01',
    name: '幸运挂坠',
    category: ITEM_CATEGORIES.EQUIPMENT,
    slotType: 'accessory',
    tags: ['饰品', '幸运'],
    description: '小巧的通用金属挂饰，提升幸运与检定稳定性。',
    quantity: 2,
    bonuses: [
      { stat: 'luck', layer: 'baseAdd', value: 12 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 1 },
    ],
  },
  {
    id: 'item_consumable_med',
    name: '便携恢复包',
    category: ITEM_CATEGORIES.CONSUMABLE,
    slotType: null,
    tags: ['补给', '恢复'],
    description: '基础应急恢复物资，使用后恢复 25 点生命/耐久与 15 点士气。',
    quantity: 5,
    bonuses: [
      { stat: 'hp', layer: 'baseAdd', value: 25 },
      { stat: 'morale', layer: 'baseAdd', value: 15 },
    ],
  },
];

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function sanitizeBonuses(bonuses = []) {
  if (!Array.isArray(bonuses)) return [];
  const out = [];
  for (const b of bonuses) {
    if (!b || !b.stat) continue;
    const val = Number(b.value);
    if (!Number.isFinite(val) || val === 0) continue;
    out.push({
      stat: String(b.stat).trim(),
      layer: ['baseAdd', 'percentAdd', 'percentMult', 'flatFinal'].includes(b.layer)
        ? b.layer
        : 'baseAdd',
      value: Number(val.toFixed(4)),
    });
  }
  return out;
}

export class InventorySystem {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   entities: import('./entity-system.js').EntitySystem,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({ storage, entities, bus = null }) {
    this._storage = storage;
    this._scope = storage.namespace(STORAGE_NS);
    this._entities = entities;
    this._bus = bus;

    /** @type {Map<string, object>} */
    this._items = new Map();
    /** @type {Array<{ id: string, label: string, allowedCategories: string[] }>} */
    this._slots = deepClone(DEFAULT_EQUIPMENT_SLOTS);
    /** @type {Record<string, Record<string, string>>} characterId -> { slotId: itemId } */
    this._equipped = {};
    this._hydrated = false;
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  async init() {
    if (this._hydrated) return;
    const saved = await this._scope.getLarge(STATE_KEY, null);
    if (saved && typeof saved === 'object') {
      this.deserialize(saved, { persist: false });
    } else {
      // Seed clean generic starter items on very first boot
      for (const item of STARTER_ITEMS) {
        this._items.set(item.id, {
          ...deepClone(item),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      await this.persist();
    }
    this._hydrated = true;
  }

  async persist() {
    await this._scope.setLarge(STATE_KEY, this.serialize());
  }

  // ------------------------------------------------------------
  // Equipment Slots Management
  // ------------------------------------------------------------

  listSlots() {
    return deepClone(this._slots);
  }

  getSlot(slotId) {
    return this._slots.find((s) => s.id === slotId) || null;
  }

  async addSlot({ id, label, allowedCategories = [ITEM_CATEGORIES.EQUIPMENT, ITEM_CATEGORIES.OUTFIT] }) {
    const cleanId = String(id || `slot_${Date.now().toString(36)}`).trim();
    const cleanLabel = String(label || cleanId).trim();
    if (!cleanId || !cleanLabel) throw new Error('槽位 ID 和名称不能为空');
    if (this._slots.some((s) => s.id === cleanId)) {
      throw new Error(`槽位 "${cleanId}" 已存在`);
    }
    const cats = Array.isArray(allowedCategories) && allowedCategories.length > 0
      ? allowedCategories.filter((c) => c === ITEM_CATEGORIES.OUTFIT || c === ITEM_CATEGORIES.EQUIPMENT)
      : [ITEM_CATEGORIES.EQUIPMENT, ITEM_CATEGORIES.OUTFIT];

    const slot = { id: cleanId, label: cleanLabel, allowedCategories: cats };
    this._slots.push(slot);
    await this.persist();
    this._emit('inventory:slot-added', { slot });
    return slot;
  }

  async removeSlot(slotId) {
    const idx = this._slots.findIndex((s) => s.id === slotId);
    if (idx < 0) return false;
    this._slots.splice(idx, 1);

    // Unequip from all characters who had an item in this slot
    for (const charId of Object.keys(this._equipped)) {
      if (this._equipped[charId]?.[slotId]) {
        delete this._equipped[charId][slotId];
        this.syncCharacterModifiers(charId);
      }
    }
    await this.persist();
    this._emit('inventory:slot-removed', { slotId });
    return true;
  }

  // ------------------------------------------------------------
  // Global Warehouse Items CRUD
  // ------------------------------------------------------------

  listItems({ category = null, slotType = null, tag = null } = {}) {
    const out = [];
    for (const item of this._items.values()) {
      if (category && item.category !== category) continue;
      if (slotType && item.slotType && item.slotType !== slotType) continue;
      if (tag && !(item.tags || []).includes(tag)) continue;
      out.push(deepClone(item));
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getItem(itemId) {
    const item = this._items.get(String(itemId));
    return item ? deepClone(item) : null;
  }

  async createItem(def = {}) {
    const name = String(def.name || '').trim();
    if (!name) throw new Error('物品名称不能为空');
    const category = Object.values(ITEM_CATEGORIES).includes(def.category)
      ? def.category
      : ITEM_CATEGORIES.EQUIPMENT;
    const id = String(def.id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`).trim();
    const now = Date.now();
    const defaultSlot =
      category === ITEM_CATEGORIES.OUTFIT
        ? 'outfit'
        : category === ITEM_CATEGORIES.EQUIPMENT
        ? 'main_equip'
        : null;

    const item = {
      id,
      name,
      category,
      slotType: category === ITEM_CATEGORIES.CONSUMABLE ? null : String(def.slotType || defaultSlot),
      tags: Array.isArray(def.tags)
        ? def.tags.map((t) => String(t).trim()).filter(Boolean)
        : String(def.tags || '')
            .split(/[,，\s]+/)
            .map((t) => t.trim())
            .filter(Boolean),
      description: String(def.description || '').trim(),
      quantity: Math.max(1, Math.floor(Number(def.quantity ?? 1) || 1)),
      bonuses: sanitizeBonuses(def.bonuses),
      createdAt: now,
      updatedAt: now,
    };

    this._items.set(id, item);
    await this.persist();
    this._emit('inventory:item-created', { item: deepClone(item) });
    return deepClone(item);
  }

  async updateItem(itemId, patch = {}) {
    const existing = this._items.get(String(itemId));
    if (!existing) throw new Error(`物品 "${itemId}" 不存在`);

    const nextCategory = Object.values(ITEM_CATEGORIES).includes(patch.category)
      ? patch.category
      : existing.category;

    const updated = {
      ...existing,
      name: patch.name !== undefined ? String(patch.name).trim() || existing.name : existing.name,
      category: nextCategory,
      slotType:
        nextCategory === ITEM_CATEGORIES.CONSUMABLE
          ? null
          : patch.slotType !== undefined
          ? String(patch.slotType || existing.slotType || 'main_equip')
          : existing.slotType,
      tags:
        patch.tags !== undefined
          ? Array.isArray(patch.tags)
            ? patch.tags.map((t) => String(t).trim()).filter(Boolean)
            : String(patch.tags)
                .split(/[,，\s]+/)
                .map((t) => t.trim())
                .filter(Boolean)
          : existing.tags,
      description: patch.description !== undefined ? String(patch.description).trim() : existing.description,
      quantity:
        patch.quantity !== undefined
          ? Math.max(0, Math.floor(Number(patch.quantity) || 0))
          : existing.quantity,
      bonuses: patch.bonuses !== undefined ? sanitizeBonuses(patch.bonuses) : existing.bonuses,
      updatedAt: Date.now(),
    };

    this._items.set(existing.id, updated);

    // Re-sync stats for all characters currently wearing this item
    for (const [charId, slotMap] of Object.entries(this._equipped)) {
      if (Object.values(slotMap).includes(existing.id)) {
        this.syncCharacterModifiers(charId);
      }
    }

    await this.persist();
    this._emit('inventory:item-updated', { item: deepClone(updated) });
    return deepClone(updated);
  }

  async deleteItem(itemId) {
    const id = String(itemId);
    if (!this._items.has(id)) return false;

    // Unequip from any character wearing it
    for (const [charId, slotMap] of Object.entries(this._equipped)) {
      let changed = false;
      for (const [slotId, eqId] of Object.entries(slotMap)) {
        if (eqId === id) {
          delete slotMap[slotId];
          changed = true;
        }
      }
      if (changed) this.syncCharacterModifiers(charId);
    }

    this._items.delete(id);
    await this.persist();
    this._emit('inventory:item-deleted', { itemId: id });
    return true;
  }

  // ------------------------------------------------------------
  // Equip / Unequip / Consume & Entity Stat Sync
  // ------------------------------------------------------------

  getCompatibleSlotIdForItem(item) {
    if (!item || item.category === ITEM_CATEGORIES.CONSUMABLE) return null;
    if (item.slotType && this.getSlot(item.slotType)) {
      const slot = this.getSlot(item.slotType);
      if (slot.allowedCategories.includes(item.category)) return slot.id;
    }
    const fallback = this._slots.find((s) => s.allowedCategories.includes(item.category));
    return fallback ? fallback.id : null;
  }

  getCharacterEquipment(characterId) {
    const slotMap = this._equipped[String(characterId)] || {};
    const out = {};
    for (const slot of this._slots) {
      const itemId = slotMap[slot.id] || null;
      out[slot.id] = itemId ? this.getItem(itemId) : null;
    }
    return out;
  }

  getEquippedSlotOfItem(characterId, itemId) {
    const slotMap = this._equipped[String(characterId)] || {};
    for (const [slotId, eqId] of Object.entries(slotMap)) {
      if (eqId === itemId) return slotId;
    }
    return null;
  }

  /**
   * Aggregate flat checkBonus & per-stat delta summary for all equipped items on a character.
   */
  getCharacterEquipmentBonuses(characterId) {
    const equipped = this.getCharacterEquipment(characterId);
    let checkBonus = 0;
    const statBonuses = {};
    const items = [];

    for (const [slotId, item] of Object.entries(equipped)) {
      if (!item) continue;
      items.push({ slotId, id: item.id, name: item.name, category: item.category });
      for (const b of item.bonuses || []) {
        if (b.stat === 'checkBonus') {
          checkBonus += Number(b.value) || 0;
        } else {
          if (!statBonuses[b.stat]) statBonuses[b.stat] = [];
          statBonuses[b.stat].push({ layer: b.layer, value: b.value, source: item.name });
        }
      }
    }

    return {
      checkBonus: Number(checkBonus.toFixed(2)),
      statBonuses,
      items,
    };
  }

  /**
   * Synchronize all equipped item modifiers onto EntitySystem so getEffectiveStat() reflects them immediately.
   */
  syncCharacterModifiers(characterId) {
    if (!this._entities || !this._entities.has(characterId)) return;
    const entity = this._entities.get(characterId);
    // Remove previous inventory modifiers
    const prevIds = (entity.modifiers || [])
      .filter((m) => String(m.id || '').startsWith('inv_eq_'))
      .map((m) => m.id);
    for (const mid of prevIds) {
      this._entities.removeModifier(characterId, mid);
    }

    const equipped = this.getCharacterEquipment(characterId);
    for (const [slotId, item] of Object.entries(equipped)) {
      if (!item) continue;
      (item.bonuses || []).forEach((bonus, idx) => {
        if (bonus.stat === 'checkBonus') return;
        this._entities.addModifier(characterId, {
          id: `inv_eq_${slotId}_${item.id}_${idx}`,
          stat: bonus.stat,
          layer: bonus.layer || 'baseAdd',
          value: bonus.value,
          source: `${item.name}`,
          enabled: true,
        });
      });
    }
  }

  syncAllCharacters() {
    if (!this._entities) return;
    for (const charId of Object.keys(this._equipped)) {
      if (this._entities.has(charId)) {
        this.syncCharacterModifiers(charId);
      }
    }
  }

  async equipItem(characterId, slotId, itemId) {
    const cid = String(characterId);
    const item = this._items.get(String(itemId));
    if (!item) throw new Error(`物品 "${itemId}" 不存在`);
    if (item.category === ITEM_CATEGORIES.CONSUMABLE) {
      throw new Error('消耗品不能穿戴到装备槽位，请点击「使用」');
    }

    const targetSlotId = slotId || this.getCompatibleSlotIdForItem(item);
    const slot = this.getSlot(targetSlotId);
    if (!slot) throw new Error(`装备槽位 "${targetSlotId}" 不存在`);
    if (!slot.allowedCategories.includes(item.category)) {
      throw new Error(`「${item.name}」(${ITEM_CATEGORY_LABELS[item.category]}) 无法穿戴到「${slot.label}」槽位`);
    }

    if (!this._equipped[cid]) this._equipped[cid] = {};

    // If same item is already in another slot of this character, clear that slot first
    for (const [sId, eqId] of Object.entries(this._equipped[cid])) {
      if (eqId === item.id && sId !== slot.id) {
        delete this._equipped[cid][sId];
      }
    }

    const previousItemId = this._equipped[cid][slot.id] || null;
    this._equipped[cid][slot.id] = item.id;
    this.syncCharacterModifiers(cid);
    await this.persist();

    const actor = this._entities?.get(cid);
    const payload = {
      characterId: cid,
      characterName: actor?.name || cid,
      slotId: slot.id,
      slotLabel: slot.label,
      item: deepClone(item),
      previousItemId,
      timestamp: Date.now(),
    };
    this._emit('inventory:equipped', payload);
    return payload;
  }

  async unequipSlot(characterId, slotId) {
    const cid = String(characterId);
    const slot = this.getSlot(slotId);
    const prevId = this._equipped[cid]?.[slotId] || null;
    if (!prevId) return null;

    const prevItem = this.getItem(prevId);
    delete this._equipped[cid][slotId];
    this.syncCharacterModifiers(cid);
    await this.persist();

    const actor = this._entities?.get(cid);
    const payload = {
      characterId: cid,
      characterName: actor?.name || cid,
      slotId,
      slotLabel: slot?.label || slotId,
      item: prevItem,
      timestamp: Date.now(),
    };
    this._emit('inventory:unequipped', payload);
    return payload;
  }

  async removeCharacterEquipment(characterId) {
    const cid = String(characterId);
    if (this._equipped[cid]) {
      delete this._equipped[cid];
      await this.persist();
    }
  }

  async useConsumable(characterId, itemId) {
    const cid = String(characterId);
    const item = this._items.get(String(itemId));
    if (!item || item.category !== ITEM_CATEGORIES.CONSUMABLE) {
      throw new Error('该物品不是可用的消耗品');
    }
    if (item.quantity <= 0) {
      throw new Error(`「${item.name}」库存不足`);
    }
    const entity = this._entities?.get(cid);
    if (!entity) throw new Error(`角色 "${cid}" 不存在`);

    const applied = [];
    for (const b of item.bonuses || []) {
      const before = Number(entity.stats[b.stat] ?? 0);
      const maxBound =
        b.stat === 'hp'
          ? Number(entity.stats.maxHp ?? 100)
          : b.stat === 'ap'
          ? Number(entity.stats.maxAp ?? 100)
          : b.stat === 'morale'
          ? 100
          : undefined;
      const after = this._entities.adjustStat(
        cid,
        b.stat,
        b.value,
        maxBound !== undefined ? { min: 0, max: maxBound } : null
      );
      applied.push({ stat: b.stat, before, after, delta: Number((after - before).toFixed(2)) });
    }

    item.quantity -= 1;
    item.updatedAt = Date.now();
    await this.persist();

    const payload = {
      characterId: cid,
      characterName: entity.name,
      item: deepClone(item),
      applied,
      timestamp: Date.now(),
    };
    this._emit('inventory:consumed', payload);
    return payload;
  }

  // ------------------------------------------------------------
  // Serialization
  // ------------------------------------------------------------

  serialize() {
    return {
      slots: deepClone(this._slots),
      items: Array.from(this._items.values()).map((it) => deepClone(it)),
      equipped: deepClone(this._equipped),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._slots =
      Array.isArray(snapshot.slots) && snapshot.slots.length > 0
        ? deepClone(snapshot.slots)
        : deepClone(DEFAULT_EQUIPMENT_SLOTS);
    this._items.clear();
    if (Array.isArray(snapshot.items)) {
      for (const it of snapshot.items) {
        if (it && it.id) this._items.set(String(it.id), deepClone(it));
      }
    }
    this._equipped = deepClone(snapshot.equipped || {});
    this.syncAllCharacters();
    if (persist) {
      this.persist();
    }
  }
}
