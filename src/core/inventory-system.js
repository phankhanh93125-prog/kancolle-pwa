/**
 * Generic Equipment, Mandatory Core Slots, Freeform Custom Slots, Dynamic Attribute Expansion & Warehouse System.
 *
 * Slot architecture per character:
 *   1. 3 Fixed Mandatory Core Slots (required: true, non-removable):
 *        - engine (引擎)  -> category: 'engine'
 *        - armor  (装甲)  -> category: 'armor'
 *        - core   (核心)  -> category: 'core'
 *      A character is Seaworthy (适航) if and only if all 3 core slots are equipped.
 *      Effectiveness of these 3 core slots is amplified by Commander `maintenance` (整备).
 *   2. Optional Outfit Slot (required: false):
 *        - outfit (服装)  -> category: 'outfit'
 *   3. Freeform Custom Optional Slots (required: false, custom: true):
 *      Players freely create, rename, or delete any number of named custom slots per character.
 *      Any equipped module carrying standard 8 naval stats OR arbitrary custom attribute keys
 *      automatically expands the character card's stat breakdown (`getCharacterStatBreakdown`).
 */

import { NAVAL_EIGHT_STAT_DEFS, NAVAL_EIGHT_STAT_MAP, normalizeStatKey } from './stat-rules.js';

const STORAGE_NS = 'core-inventory';
const STATE_KEY = 'inventory-state-v3';

export const MAX_ENHANCE_LEVEL = 10;

export const ITEM_CATEGORIES = Object.freeze({
  ENGINE: 'engine',
  ARMOR: 'armor',
  CORE: 'core',
  EXTENSION: 'extension',
  OUTFIT: 'outfit',
  CONSUMABLE: 'consumable',
});

export const ITEM_CATEGORY_LABELS = Object.freeze({
  [ITEM_CATEGORIES.ENGINE]: '引擎部件',
  [ITEM_CATEGORIES.ARMOR]: '装甲部件',
  [ITEM_CATEGORIES.CORE]: '核心部件',
  [ITEM_CATEGORIES.EXTENSION]: '通用扩展装备',
  [ITEM_CATEGORIES.OUTFIT]: '服装',
  [ITEM_CATEGORIES.CONSUMABLE]: '消耗品',
});

export const MANDATORY_CORE_SLOTS = Object.freeze([
  { id: 'engine', label: '引擎', required: true, custom: false, allowedCategories: [ITEM_CATEGORIES.ENGINE] },
  { id: 'armor', label: '装甲', required: true, custom: false, allowedCategories: [ITEM_CATEGORIES.ARMOR] },
  { id: 'core', label: '核心', required: true, custom: false, allowedCategories: [ITEM_CATEGORIES.CORE] },
]);

export const MANDATORY_SLOT_IDS = new Set(['engine', 'armor', 'core']);

export const OPTIONAL_OUTFIT_SLOT = Object.freeze({
  id: 'outfit',
  label: '服装',
  required: false,
  custom: false,
  allowedCategories: [ITEM_CATEGORIES.OUTFIT],
});

export const STARTER_ITEMS = [
  {
    id: 'item_core_engine_01',
    name: '标准蒸汽轮机引擎',
    category: ITEM_CATEGORIES.ENGINE,
    tags: ['核心必装', '动力'],
    description: '制式舰用推进引擎，提供稳定的机动性与反潜航速支持。',
    quantity: 4,
    level: 0,
    bonuses: [
      { stat: 'evasion', layer: 'baseAdd', value: 12 },
      { stat: 'asw', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    id: 'item_core_armor_01',
    name: '复合均质舰体装甲',
    category: ITEM_CATEGORIES.ARMOR,
    tags: ['核心必装', '防护'],
    description: '均衡型舰体装甲结构，提升装甲防护、耐久上限与防空结构强度。',
    quantity: 4,
    level: 0,
    bonuses: [
      { stat: 'armor', layer: 'baseAdd', value: 10 },
      { stat: 'maxHp', layer: 'baseAdd', value: 8 },
      { stat: 'aa', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    id: 'item_core_core_01',
    name: '标准火控中枢核心',
    category: ITEM_CATEGORIES.CORE,
    tags: ['核心必装', '中枢'],
    description: '舰载作战控制核心，强化火力、雷击、侦查与检定基准精度。',
    quantity: 4,
    level: 0,
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 8 },
      { stat: 'torpedo', layer: 'baseAdd', value: 6 },
      { stat: 'recon', layer: 'baseAdd', value: 6 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 1 },
    ],
  },
  {
    id: 'item_ext_01',
    name: '双联装高平两用炮模块',
    category: ITEM_CATEGORIES.EXTENSION,
    tags: ['通用扩展', '火控防空'],
    description: '可装入任意自定义槽位的扩展武装，兼顾火力、防空与自定义「射程延伸」词条。',
    quantity: 3,
    level: 0,
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 12 },
      { stat: 'aa', layer: 'baseAdd', value: 10 },
      { stat: '射程延伸', layer: 'baseAdd', value: 2 },
    ],
  },
  {
    id: 'item_ext_02',
    name: '主动声呐与夜战观瞄模块',
    category: ITEM_CATEGORIES.EXTENSION,
    tags: ['通用扩展', '反潜侦查'],
    description: '可装入任意自定义槽位的特种观瞄模块，提升侦查、反潜并附带「夜战修正」扩展属性。',
    quantity: 3,
    level: 0,
    bonuses: [
      { stat: 'recon', layer: 'baseAdd', value: 10 },
      { stat: 'asw', layer: 'baseAdd', value: 12 },
      { stat: '夜战修正', layer: 'baseAdd', value: 8 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 1 },
    ],
  },
  {
    id: 'item_outfit_standard',
    name: '标准港区常服',
    category: ITEM_CATEGORIES.OUTFIT,
    tags: ['服装', '日常'],
    description: '剪裁轻便的港区执勤常服，提供机动与侦查小幅加成。',
    quantity: 3,
    level: 0,
    bonuses: [
      { stat: 'evasion', layer: 'baseAdd', value: 6 },
      { stat: 'recon', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    id: 'item_consumable_med',
    name: '应急损管修复包',
    category: ITEM_CATEGORIES.CONSUMABLE,
    tags: ['消耗品', '恢复'],
    description: '现场紧急损管物资，使用后恢复 25 点耐久与 10 点士气。',
    quantity: 5,
    level: 0,
    bonuses: [
      { stat: 'hp', layer: 'baseAdd', value: 25 },
      { stat: 'morale', layer: 'baseAdd', value: 10 },
    ],
  },
  {
    id: 'item_consumable_ration',
    name: '高能舰队配给盒',
    category: ITEM_CATEGORIES.CONSUMABLE,
    tags: ['消耗品', '补给'],
    description: '便携式高能配给，使用后恢复 30 点行动点 AP 与 15 点士气。',
    quantity: 5,
    level: 0,
    bonuses: [
      { stat: 'ap', layer: 'baseAdd', value: 30 },
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
    const rawStat = String(b.stat).trim();
    if (!rawStat) continue;
    const stat = normalizeStatKey(rawStat);
    out.push({
      stat,
      layer: ['baseAdd', 'percentAdd', 'percentMult', 'flatFinal'].includes(b.layer)
        ? b.layer
        : 'baseAdd',
      value: Number(val.toFixed(4)),
    });
  }
  return out;
}

/**
 * Deterministic enhancement bonus scaling formula for a given target level.
 */
export function computeEnhancedBonuses(baseBonuses = [], level = 0) {
  const lv = Math.max(0, Math.min(MAX_ENHANCE_LEVEL, Math.floor(Number(level) || 0)));
  return sanitizeBonuses(baseBonuses).map((b) => {
    if (lv === 0 || b.value <= 0) return { ...b };
    if (b.layer === 'percentAdd' || b.layer === 'percentMult') {
      return { ...b, value: Number((b.value + lv * 0.02).toFixed(4)) };
    }
    if (b.stat === 'checkBonus') {
      return { ...b, value: b.value + Math.floor((lv + 1) / 2) };
    }
    const perLevelGain = Math.max(2, Math.round(b.value * 0.25));
    return { ...b, value: b.value + perLevelGain * lv };
  });
}

/**
 * Enhancement material cost, optionally discounted by Commander `maintenance` (0..0.45).
 */
export function getEnhanceCost(item, { discount = 0 } = {}) {
  const lv = Math.max(0, Math.floor(Number(item?.level) || 0));
  const tier = lv + 1;
  const mult = Math.max(0.5, 1 - Math.max(0, Math.min(0.45, Number(discount) || 0)));
  return {
    steel: Math.max(10, Math.round(80 * tier * mult)),
    bauxite: Math.max(5, Math.round(40 * tier * mult)),
    silver: Math.max(15, Math.round(120 * tier * mult)),
  };
}

export class InventorySystem {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   entities: import('./entity-system.js').EntitySystem,
   *   commander?: import('./commander-system.js').CommanderSystem | null,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({ storage, entities, commander = null, bus = null }) {
    this._storage = storage;
    this._scope = storage.namespace(STORAGE_NS);
    this._entities = entities;
    this._commander = commander;
    this._bus = bus;

    /** @type {Map<string, object>} */
    this._items = new Map();
    /** @type {Record<string, Array<{ id: string, label: string, required: false, custom: true, allowedCategories: string[] }>>} */
    this._customSlotsByCharacter = {};
    /** @type {Record<string, Record<string, string>>} characterId -> { slotId: itemId } */
    this._equipped = {};
    this._hydrated = false;

    if (this._bus) {
      this._bus.on('commander:updated', () => {
        this.syncAllCharacters();
      });
    }
  }

  setCommander(commander) {
    this._commander = commander;
    this.syncAllCharacters();
  }

  getCorePartsAmplifier() {
    if (this._commander && typeof this._commander.getCorePartsAmplifier === 'function') {
      return this._commander.getCorePartsAmplifier();
    }
    return 1.0;
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  async init() {
    if (this._hydrated) return;
    const saved = await this._scope.getLarge(STATE_KEY, null);
    if (saved && typeof saved === 'object' && Array.isArray(saved.items) && saved.items.length > 0) {
      this.deserialize(saved, { persist: false });
    } else {
      const now = Date.now();
      for (const item of STARTER_ITEMS) {
        const cleanBonuses = sanitizeBonuses(item.bonuses);
        this._items.set(item.id, {
          ...deepClone(item),
          level: 0,
          baseBonuses: deepClone(cleanBonuses),
          bonuses: deepClone(cleanBonuses),
          createdAt: now,
          updatedAt: now,
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
  // Per-Character Slot Architecture (3 Mandatory Core + Outfit + Freeform Custom)
  // ------------------------------------------------------------

  getCharacterSlots(characterId) {
    const cid = String(characterId || '');
    const customList = Array.isArray(this._customSlotsByCharacter[cid])
      ? this._customSlotsByCharacter[cid]
      : [];
    return [
      ...deepClone(MANDATORY_CORE_SLOTS),
      deepClone(OPTIONAL_OUTFIT_SLOT),
      ...deepClone(customList),
    ];
  }

  getCharacterSlot(characterId, slotId) {
    return this.getCharacterSlots(characterId).find((s) => s.id === slotId) || null;
  }

  async addCharacterCustomSlot(characterId, label) {
    const cid = String(characterId || '').trim();
    const cleanLabel = String(label || '').trim();
    if (!cid) throw new Error('角色 ID 不能为空');
    if (!cleanLabel) throw new Error('自定义槽位名称不能为空');

    if (!Array.isArray(this._customSlotsByCharacter[cid])) {
      this._customSlotsByCharacter[cid] = [];
    }
    const slot = {
      id: `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      label: cleanLabel,
      required: false,
      custom: true,
      allowedCategories: [ITEM_CATEGORIES.EXTENSION],
    };
    this._customSlotsByCharacter[cid].push(slot);
    await this.persist();
    this._emit('inventory:slot-added', { characterId: cid, slot: deepClone(slot) });
    return deepClone(slot);
  }

  async renameCharacterCustomSlot(characterId, slotId, newLabel) {
    const cid = String(characterId || '').trim();
    const cleanLabel = String(newLabel || '').trim();
    if (!cleanLabel) throw new Error('槽位名称不能为空');
    const list = this._customSlotsByCharacter[cid] || [];
    const target = list.find((s) => s.id === slotId);
    if (!target || !target.custom) {
      throw new Error('仅支持重命名自定义槽位');
    }
    target.label = cleanLabel;
    await this.persist();
    this._emit('inventory:slot-renamed', { characterId: cid, slotId, label: cleanLabel });
    return deepClone(target);
  }

  async removeCharacterCustomSlot(characterId, slotId) {
    const cid = String(characterId || '').trim();
    const slot = this.getCharacterSlot(cid, slotId);
    if (!slot) return false;
    if (slot.required || !slot.custom) {
      throw new Error(`「${slot.label}」为基础固定槽位，不可删除`);
    }

    if (this._equipped[cid]?.[slotId]) {
      delete this._equipped[cid][slotId];
      this.syncCharacterModifiers(cid);
    }
    this._customSlotsByCharacter[cid] = (this._customSlotsByCharacter[cid] || []).filter(
      (s) => s.id !== slotId
    );
    await this.persist();
    this._emit('inventory:slot-removed', { characterId: cid, slotId, label: slot.label });
    return true;
  }

  checkSeaworthiness(characterId) {
    const cid = String(characterId || '');
    const slotMap = this._equipped[cid] || {};
    const missingSlots = [];
    for (const coreSlot of MANDATORY_CORE_SLOTS) {
      const itemId = slotMap[coreSlot.id];
      const item = itemId ? this._items.get(itemId) : null;
      if (!item) {
        missingSlots.push({ id: coreSlot.id, label: coreSlot.label });
      }
    }
    const seaworthy = missingSlots.length === 0;
    const statusText = seaworthy
      ? '适航 (Seaworthy)'
      : `未适航（缺少核心部件：${missingSlots.map((s) => s.label).join('、')}）`;
    return {
      seaworthy,
      missingSlots,
      statusText,
    };
  }

  // ------------------------------------------------------------
  // Global Warehouse Items CRUD & Enhancement
  // ------------------------------------------------------------

  listItems({ category = null, tag = null, enhanceableOnly = false } = {}) {
    const out = [];
    for (const item of this._items.values()) {
      if (category && item.category !== category) continue;
      if (tag && !(item.tags || []).includes(tag)) continue;
      if (enhanceableOnly && item.category === ITEM_CATEGORIES.CONSUMABLE) continue;
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
      : ITEM_CATEGORIES.EXTENSION;

    if (category === ITEM_CATEGORIES.CONSUMABLE && def.stackByName) {
      for (const existing of this._items.values()) {
        if (existing.category === ITEM_CATEGORIES.CONSUMABLE && existing.name === name) {
          existing.quantity += Math.max(1, Math.floor(Number(def.quantity ?? 1) || 1));
          existing.updatedAt = Date.now();
          await this.persist();
          this._emit('inventory:item-updated', { item: deepClone(existing) });
          return deepClone(existing);
        }
      }
    }

    const id = String(def.id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`).trim();
    const now = Date.now();
    const baseBonuses = sanitizeBonuses(def.bonuses);
    const level = Math.max(0, Math.min(MAX_ENHANCE_LEVEL, Math.floor(Number(def.level) || 0)));

    const item = {
      id,
      name,
      category,
      tags: Array.isArray(def.tags)
        ? def.tags.map((t) => String(t).trim()).filter(Boolean)
        : String(def.tags || '')
            .split(/[,，\s]+/)
            .map((t) => t.trim())
            .filter(Boolean),
      description: String(def.description || '').trim(),
      quantity: Math.max(1, Math.floor(Number(def.quantity ?? 1) || 1)),
      level,
      baseBonuses: deepClone(baseBonuses),
      bonuses: computeEnhancedBonuses(baseBonuses, level),
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

    const nextLevel =
      patch.level !== undefined
        ? Math.max(0, Math.min(MAX_ENHANCE_LEVEL, Math.floor(Number(patch.level) || 0)))
        : existing.level || 0;

    let nextBaseBonuses = existing.baseBonuses || existing.bonuses || [];
    let nextBonuses = existing.bonuses || [];
    if (patch.bonuses !== undefined) {
      nextBaseBonuses = sanitizeBonuses(patch.bonuses);
      nextBonuses = nextLevel > 0 ? computeEnhancedBonuses(nextBaseBonuses, nextLevel) : deepClone(nextBaseBonuses);
    } else if (patch.level !== undefined) {
      nextBonuses = computeEnhancedBonuses(nextBaseBonuses, nextLevel);
    }

    const updated = {
      ...existing,
      name: patch.name !== undefined ? String(patch.name).trim() || existing.name : existing.name,
      category: nextCategory,
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
      level: nextLevel,
      baseBonuses: deepClone(nextBaseBonuses),
      bonuses: deepClone(nextBonuses),
      updatedAt: Date.now(),
    };

    this._items.set(existing.id, updated);

    for (const [charId, slotMap] of Object.entries(this._equipped)) {
      if (Object.values(slotMap).includes(existing.id)) {
        this.syncCharacterModifiers(charId);
      }
    }

    await this.persist();
    this._emit('inventory:item-updated', { item: deepClone(updated) });
    return deepClone(updated);
  }

  async enhanceItem(itemId) {
    const existing = this._items.get(String(itemId));
    if (!existing) throw new Error(`物品 "${itemId}" 不存在`);
    if (existing.category === ITEM_CATEGORIES.CONSUMABLE) {
      throw new Error('消耗品不支持强化升级');
    }
    const prevLevel = Math.max(0, Math.floor(Number(existing.level) || 0));
    if (prevLevel >= MAX_ENHANCE_LEVEL) {
      throw new Error(`「${existing.name}」已达到最高强化等级 +${MAX_ENHANCE_LEVEL}`);
    }

    const nextLevel = prevLevel + 1;
    const baseBonuses =
      Array.isArray(existing.baseBonuses) && existing.baseBonuses.length > 0
        ? existing.baseBonuses
        : existing.bonuses || [];
    const nextBonuses = computeEnhancedBonuses(baseBonuses, nextLevel);

    existing.level = nextLevel;
    existing.baseBonuses = deepClone(baseBonuses);
    existing.bonuses = nextBonuses;
    existing.updatedAt = Date.now();

    const affectedCharacters = [];
    for (const [charId, slotMap] of Object.entries(this._equipped)) {
      if (Object.values(slotMap).includes(existing.id)) {
        this.syncCharacterModifiers(charId);
        affectedCharacters.push(charId);
      }
    }

    await this.persist();
    const payload = {
      item: deepClone(existing),
      prevLevel,
      nextLevel,
      affectedCharacters,
      timestamp: Date.now(),
    };
    this._emit('inventory:enhanced', payload);
    return payload;
  }

  getWearersOfItem(itemId) {
    const wearers = [];
    for (const [charId, slotMap] of Object.entries(this._equipped)) {
      if (Object.values(slotMap).includes(itemId)) {
        const entity = this._entities?.get(charId);
        if (entity) wearers.push({ id: charId, name: entity.name });
      }
    }
    return wearers;
  }

  async deleteItem(itemId) {
    const id = String(itemId);
    if (!this._items.has(id)) return false;

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
  // Equip / Unequip / Consume & Dynamic Full-Slot Stat Breakdown
  // ------------------------------------------------------------

  getCompatibleSlotIdForItem(characterId, item) {
    if (!item || item.category === ITEM_CATEGORIES.CONSUMABLE) return null;
    const slots = this.getCharacterSlots(characterId);
    const matching = slots.filter((s) => s.allowedCategories.includes(item.category));
    if (matching.length === 0) return null;
    const slotMap = this._equipped[String(characterId)] || {};
    const empty = matching.find((s) => !slotMap[s.id]);
    return (empty || matching[0]).id;
  }

  getCharacterEquipment(characterId) {
    const cid = String(characterId || '');
    const slotMap = this._equipped[cid] || {};
    const out = {};
    for (const slot of this.getCharacterSlots(cid)) {
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
   * Compute amplified bonus value when the item sits in one of the 3 mandatory core slots
   * (amplified by Commander `maintenance`).
   */
  _resolveSlotBonusValue(slotId, bonus) {
    const rawVal = Number(bonus.value) || 0;
    if (!MANDATORY_SLOT_IDS.has(slotId) || rawVal <= 0 || bonus.stat === 'checkBonus') {
      return rawVal;
    }
    const amp = this.getCorePartsAmplifier();
    if (amp <= 1.0) return rawVal;
    if (bonus.layer === 'percentAdd' || bonus.layer === 'percentMult') {
      return Number((rawVal * amp).toFixed(4));
    }
    return Math.round(rawVal * amp);
  }

  getCharacterEquipmentBonuses(characterId) {
    const equipped = this.getCharacterEquipment(characterId);
    let checkBonus = 0;
    const statBonuses = {};
    const items = [];

    for (const [slotId, item] of Object.entries(equipped)) {
      if (!item) continue;
      items.push({ slotId, id: item.id, name: item.name, category: item.category, level: item.level || 0 });
      for (const b of item.bonuses || []) {
        const effVal = this._resolveSlotBonusValue(slotId, b);
        if (b.stat === 'checkBonus') {
          checkBonus += effVal;
        } else {
          if (!statBonuses[b.stat]) statBonuses[b.stat] = [];
          statBonuses[b.stat].push({
            layer: b.layer,
            value: effVal,
            source: item.level > 0 ? `${item.name} +${item.level}` : item.name,
            slotId,
          });
        }
      }
    }

    return {
      checkBonus: Number(checkBonus.toFixed(2)),
      statBonuses,
      items,
      coreAmplifier: this.getCorePartsAmplifier(),
    };
  }

  /**
   * Full stat breakdown separating Base (白值) vs Equipment/Module Bonus (装备/模块加成) vs Total (总值),
   * covering:
   *   1. standardStats: all 8 Naval Stats (maxHp, firepower, armor, torpedo, evasion, recon, aa, asw)
   *   2. dynamicStats: any extra custom attributes dynamically contributed by equipped items/custom-slot modules
   */
  getCharacterStatBreakdown(characterId) {
    const entity = this._entities?.get(characterId);
    const eqInfo = this.getCharacterEquipmentBonuses(characterId);
    const standardKeys = new Set(NAVAL_EIGHT_STAT_DEFS.map((d) => d.key));
    const ignoreKeys = new Set(['hp', 'morale', 'ap', 'maxAp', 'affinity', 'checkBonus']);

    const standardStats = NAVAL_EIGHT_STAT_DEFS.map((def) => {
      const base = Math.round(Number(entity?.stats?.[def.key] ?? def.defaultValue));
      const total = entity
        ? Math.round(this._entities.getEffectiveStat(characterId, def.key, { round: 'round' }).final)
        : base;
      const bonus = Number((total - base).toFixed(2));
      const sources = (eqInfo.statBonuses[def.key] || []).map((s) => s.source);
      return {
        key: def.key,
        label: def.label,
        shortLabel: def.shortLabel,
        base,
        bonus,
        total,
        sources,
      };
    });

    // Discover ALL non-standard custom stat keys across equipped modules & custom slots
    const dynamicKeySet = new Set();
    for (const statKey of Object.keys(eqInfo.statBonuses)) {
      if (!standardKeys.has(statKey) && !ignoreKeys.has(statKey)) {
        dynamicKeySet.add(statKey);
      }
    }

    const dynamicStats = Array.from(dynamicKeySet).map((key) => {
      const base = Number(entity?.stats?.[key] ?? 0);
      const total = entity
        ? Number(this._entities.getEffectiveStat(characterId, key, { round: 'none' }).final.toFixed(2))
        : base;
      const bonus = Number((total - base).toFixed(2));
      const sources = (eqInfo.statBonuses[key] || []).map((s) => s.source);
      return {
        key,
        label: NAVAL_EIGHT_STAT_MAP[key]?.label || key,
        base,
        bonus,
        total,
        sources,
      };
    });

    return {
      standardStats,
      dynamicStats,
      checkBonus: eqInfo.checkBonus,
      coreAmplifier: eqInfo.coreAmplifier,
    };
  }

  /**
   * Traverse ALL slots (3 core + outfit + all custom slots) and recalculate EntitySystem modifiers.
   */
  syncCharacterModifiers(characterId) {
    if (!this._entities || !this._entities.has(characterId)) return;
    const entity = this._entities.get(characterId);
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
        const effVal = this._resolveSlotBonusValue(slotId, bonus);
        this._entities.addModifier(characterId, {
          id: `inv_eq_${slotId}_${item.id}_${idx}`,
          stat: bonus.stat,
          layer: bonus.layer || 'baseAdd',
          value: effVal,
          source: item.level > 0 ? `${item.name} +${item.level}` : item.name,
          enabled: true,
        });
      });
    }

    // Clamp current HP to effective maxHp ceiling if maxHp changed
    const effMaxHp = Math.max(1, Math.round(this._entities.getEffectiveStat(characterId, 'maxHp', { round: 'round' }).final));
    if (Number(entity.stats.hp ?? effMaxHp) > effMaxHp) {
      this._entities.setStat(characterId, 'hp', effMaxHp, { min: 0, max: effMaxHp });
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
      throw new Error('消耗品不能穿戴到槽位，请点击「使用」');
    }

    const targetSlotId = slotId || this.getCompatibleSlotIdForItem(cid, item);
    const slot = this.getCharacterSlot(cid, targetSlotId);
    if (!slot) {
      if (item.category === ITEM_CATEGORIES.EXTENSION) {
        throw new Error('当前角色尚无自定义扩展槽位，请先点击「+ 添加自定义槽位」');
      }
      throw new Error(`未找到兼容槽位 "${targetSlotId}"`);
    }
    if (!slot.allowedCategories.includes(item.category)) {
      throw new Error(
        `「${item.name}」(${ITEM_CATEGORY_LABELS[item.category]}) 无法装入「${slot.label}」槽位`
      );
    }

    if (!this._equipped[cid]) this._equipped[cid] = {};

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
    const seaworthyInfo = this.checkSeaworthiness(cid);
    const payload = {
      characterId: cid,
      characterName: actor?.name || cid,
      slotId: slot.id,
      slotLabel: slot.label,
      item: deepClone(item),
      previousItemId,
      seaworthy: seaworthyInfo.seaworthy,
      timestamp: Date.now(),
    };
    this._emit('inventory:equipped', payload);
    return payload;
  }

  async unequipSlot(characterId, slotId) {
    const cid = String(characterId);
    const slot = this.getCharacterSlot(cid, slotId);
    const prevId = this._equipped[cid]?.[slotId] || null;
    if (!prevId) return null;

    const prevItem = this.getItem(prevId);
    delete this._equipped[cid][slotId];
    this.syncCharacterModifiers(cid);
    await this.persist();

    const actor = this._entities?.get(cid);
    const seaworthyInfo = this.checkSeaworthiness(cid);
    const payload = {
      characterId: cid,
      characterName: actor?.name || cid,
      slotId,
      slotLabel: slot?.label || slotId,
      item: prevItem,
      seaworthy: seaworthyInfo.seaworthy,
      timestamp: Date.now(),
    };
    this._emit('inventory:unequipped', payload);
    return payload;
  }

  async removeCharacterEquipment(characterId) {
    const cid = String(characterId);
    delete this._equipped[cid];
    delete this._customSlotsByCharacter[cid];
    await this.persist();
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

    const effMaxHp = Math.max(1, Math.round(this._entities.getEffectiveStat(cid, 'maxHp', { round: 'round' }).final));
    const applied = [];
    for (const b of item.bonuses || []) {
      const before = Number(entity.stats[b.stat] ?? 0);
      const maxBound =
        b.stat === 'hp'
          ? effMaxHp
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
      version: 3,
      customSlotsByCharacter: deepClone(this._customSlotsByCharacter),
      items: Array.from(this._items.values()).map((it) => deepClone(it)),
      equipped: deepClone(this._equipped),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._customSlotsByCharacter = deepClone(snapshot.customSlotsByCharacter || {});
    this._items.clear();
    if (Array.isArray(snapshot.items)) {
      for (const it of snapshot.items) {
        if (it && it.id) {
          const baseBonuses = sanitizeBonuses(it.baseBonuses || it.bonuses || []);
          const level = Math.max(0, Math.min(MAX_ENHANCE_LEVEL, Math.floor(Number(it.level) || 0)));
          this._items.set(String(it.id), {
            ...deepClone(it),
            level,
            baseBonuses,
            bonuses: computeEnhancedBonuses(baseBonuses, level),
          });
        }
      }
    }
    this._equipped = deepClone(snapshot.equipped || {});
    this.syncAllCharacters();
    if (persist) {
      this.persist();
    }
  }
}
