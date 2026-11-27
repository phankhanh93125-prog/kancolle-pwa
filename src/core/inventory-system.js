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

import {
  ITEM_RARITIES,
  ITEM_RARITY_MAP,
  ITEM_RARITY_ORDER,
  KNOWN_EQUIPMENT_TYPES,
  KNOWN_EQUIPMENT_TYPE_DEFS,
  KNOWN_EQUIPMENT_TYPE_MAP,
  NAVAL_EIGHT_STAT_DEFS,
  NAVAL_EIGHT_STAT_MAP,
  RARITY_STAT_BUDGETS,
  getDisassembleYieldByRarity,
  getEquipmentPromoteCost,
  getShipClassSlotCap,
  getSlotChangeTypeCost,
  getSlotExpansionCost,
  inferEquipmentTypeId,
  inferItemRarity,
  inferSupportRole,
  normalizeEquipmentTypeId,
  normalizeLegacyItemBonusesToCompressedScale,
  normalizeRarity,
  normalizeStatKey,
  resolveShipClass,
} from './stat-rules.js';

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

export const EQUIPMENT_SUBCATEGORY_DEFS = Object.freeze([
  ...KNOWN_EQUIPMENT_TYPE_DEFS.map((d) => ({
    id: d.id,
    group: d.group,
    label: d.label,
    slotLabel: d.slotLabel,
    category: d.category,
    subGroup: d.subGroup,
    defaultIcon: d.defaultIcon,
    desc: d.desc,
  })),
  {
    id: 'outfit',
    group: '舰娘服装',
    label: '舰娘服装',
    slotLabel: '服装槽',
    category: ITEM_CATEGORIES.OUTFIT,
    subGroup: 'outfit',
    defaultIcon: 'outfit_dress',
    desc: '舰娘日常与仪式服装，支持风格标签联动秘书舰台词',
  },
]);

export const ITEM_ICON_PRESETS = Object.freeze([
  { id: 'engine', label: '涡轮引擎' },
  { id: 'armor', label: '重装盾甲' },
  { id: 'core', label: '中枢晶核' },
  { id: 'main_gun', label: '主炮炮管' },
  { id: 'torpedo', label: '酸素鱼雷' },
  { id: 'aircraft', label: '舰载机翼' },
  { id: 'support_repair', label: '抢修吊舱' },
  { id: 'support_supply', label: '补给物资箱' },
  { id: 'radar', label: '相控雷达' },
  { id: 'sonar', label: '水下声呐' },
  { id: 'aa_gun', label: '防空火网' },
  { id: 'outfit_casual', label: '日常常服' },
  { id: 'outfit_dress', label: '华美礼服' },
  { id: 'outfit_tactical', label: '战术作战服' },
  { id: 'outfit_oath', label: '誓约花嫁' },
]);

export const OUTFIT_STYLE_PRESETS = Object.freeze([
  { id: '优雅礼服', label: '优雅礼服' },
  { id: '海滨泳装', label: '海滨泳装' },
  { id: '战术作战服', label: '战术作战服' },
  { id: '日常便装', label: '日常便装' },
  { id: '祭典和服', label: '祭典和服' },
  { id: '誓约花嫁', label: '誓约花嫁' },
]);

export const MANDATORY_CORE_SLOTS = Object.freeze([
  {
    id: 'engine',
    label: '引擎',
    equipmentType: KNOWN_EQUIPMENT_TYPES.ENGINE,
    required: true,
    custom: false,
    allowedCategories: [ITEM_CATEGORIES.ENGINE],
    allowedEquipmentTypes: [KNOWN_EQUIPMENT_TYPES.ENGINE],
  },
  {
    id: 'armor',
    label: '装甲',
    equipmentType: KNOWN_EQUIPMENT_TYPES.ARMOR,
    required: true,
    custom: false,
    allowedCategories: [ITEM_CATEGORIES.ARMOR],
    allowedEquipmentTypes: [KNOWN_EQUIPMENT_TYPES.ARMOR],
  },
  {
    id: 'core',
    label: '核心',
    equipmentType: KNOWN_EQUIPMENT_TYPES.CORE,
    required: true,
    custom: false,
    allowedCategories: [ITEM_CATEGORIES.CORE],
    allowedEquipmentTypes: [KNOWN_EQUIPMENT_TYPES.CORE],
  },
]);

export const MANDATORY_SLOT_IDS = new Set(['engine', 'armor', 'core']);

export const OPTIONAL_OUTFIT_SLOT = Object.freeze({
  id: 'outfit',
  label: '服装',
  equipmentType: 'outfit',
  required: false,
  custom: false,
  allowedCategories: [ITEM_CATEGORIES.OUTFIT],
  allowedEquipmentTypes: ['outfit'],
});

export const WAREHOUSE_GROUPS = Object.freeze({
  ALL: 'all',
  CORE: 'core',
  WEAPON: 'weapon',
  SUPPORT: 'support',
  TACTICAL: 'tactical',
  OUTFIT_CONSUMABLE: 'outfit_consumable',
});

export const WAREHOUSE_GROUP_DEFS = Object.freeze([
  { id: WAREHOUSE_GROUPS.ALL, label: '全部', shortLabel: '全部' },
  { id: WAREHOUSE_GROUPS.CORE, label: '核心三件套', shortLabel: '核心' },
  { id: WAREHOUSE_GROUPS.WEAPON, label: '主战武器', shortLabel: '武器' },
  { id: WAREHOUSE_GROUPS.SUPPORT, label: '后勤支援', shortLabel: '支援' },
  { id: WAREHOUSE_GROUPS.TACTICAL, label: '战术辅助', shortLabel: '辅助' },
  { id: WAREHOUSE_GROUPS.OUTFIT_CONSUMABLE, label: '服装与道具', shortLabel: '服/道具' },
]);

/**
 * Classify any item into one of the compact warehouse tabs.
 */
export function classifyItemWarehouseGroup(item) {
  if (!item) return WAREHOUSE_GROUPS.TACTICAL;
  if (
    item.category === ITEM_CATEGORIES.ENGINE ||
    item.category === ITEM_CATEGORIES.ARMOR ||
    item.category === ITEM_CATEGORIES.CORE
  ) {
    return WAREHOUSE_GROUPS.CORE;
  }
  if (item.category === ITEM_CATEGORIES.OUTFIT || item.category === ITEM_CATEGORIES.CONSUMABLE) {
    return WAREHOUSE_GROUPS.OUTFIT_CONSUMABLE;
  }
  if (item.subGroup === 'support' || inferEquipmentTypeId(item, null) === KNOWN_EQUIPMENT_TYPES.SUPPORT) {
    return WAREHOUSE_GROUPS.SUPPORT;
  }
  if (item.subGroup === 'weapon') return WAREHOUSE_GROUPS.WEAPON;
  if (item.subGroup === 'tactical') return WAREHOUSE_GROUPS.TACTICAL;

  const text = `${item.name || ''} ${(item.tags || []).join(' ')} ${item.description || ''}`;
  if (/(抢修|维修|损管|补给箱|海上补给|后勤|支援)/.test(text)) {
    return WAREHOUSE_GROUPS.SUPPORT;
  }
  if (/(主炮|重炮|副炮|高平两用炮|鱼雷|氧雷|舰载|轰炸机|攻击机|战斗机|主战武器)/.test(text)) {
    return WAREHOUSE_GROUPS.WEAPON;
  }
  if (/(雷达|电探|声呐|声纳|防空|观瞄|测距|战术辅助|夜战|侦察)/.test(text)) {
    return WAREHOUSE_GROUPS.TACTICAL;
  }
  const hasOffense = (item.bonuses || []).some((b) => b.stat === 'firepower' || b.stat === 'torpedo');
  return hasOffense ? WAREHOUSE_GROUPS.WEAPON : WAREHOUSE_GROUPS.TACTICAL;
}

/**
 * Pure geometric SVG icon for compact equipment & outfit cards.
 */
export function getItemIconSvg(item, { size = 20, iconKey = null } = {}) {
  const s = Number(size) || 20;
  const rarityId = inferItemRarity(item);
  const rarityColor = ITEM_RARITY_MAP[rarityId]?.color || null;
  const key = iconKey || item?.iconKey || '';

  if (key === 'support_repair' || (inferEquipmentTypeId(item, null) === KNOWN_EQUIPMENT_TYPES.SUPPORT && inferSupportRole(item) === 'repair')) {
    const c = rarityColor || '#34d399';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" stroke="${c}" stroke-width="1.9" fill="rgba(52,211,153,0.18)"/><path d="M12 8v8M8 12h8" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  }
  if (key === 'support_supply' || inferEquipmentTypeId(item, null) === KNOWN_EQUIPMENT_TYPES.SUPPORT) {
    const c = rarityColor || '#fbbf24';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7Z" stroke="${c}" stroke-width="1.9" fill="rgba(251,191,36,0.18)"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M9 13h6" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  }
  if (key === 'torpedo') {
    const c = rarityColor || '#22d3ee';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 16L17 5l2 2-11 13-4-4Z" stroke="${c}" stroke-width="1.9" fill="rgba(34,211,238,0.16)"/><path d="M5 19l-2 2M8 19l-1 2" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  }
  if (key === 'aircraft') {
    const c = rarityColor || '#c084fc';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l8 14h-6l-2-3-2 3H4l8-14Z" stroke="${c}" stroke-width="1.9" fill="rgba(192,132,252,0.18)"/></svg>`;
  }
  if (key === 'main_gun') {
    const c = rarityColor || '#f97316';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 18L17 5M14 5H19V10M7 15L10 18" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (key === 'sonar') {
    const c = rarityColor || '#38bdf8';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="${c}" stroke-width="1.6" stroke-dasharray="4 3"/><circle cx="12" cy="12" r="4.5" stroke="${c}" stroke-width="1.8"/><circle cx="12" cy="12" r="1.6" fill="${c}"/></svg>`;
  }
  if (key === 'aa_gun') {
    const c = rarityColor || '#fbbf24';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 19L11 6M19 19L13 6M8 15h8" stroke="${c}" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="5" r="2" fill="${c}"/></svg>`;
  }
  if (key === 'radar') {
    const c = rarityColor || '#34d399';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="${c}" stroke-width="1.8" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="3" stroke="${c}" stroke-width="1.8"/><path d="M12 12L17.5 6.5" stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  if (key === 'outfit_oath') {
    const c = rarityColor || '#f9a8d4';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 20s-7-4.5-7-9.5A4.2 4.2 0 0 1 12 7.4 4.2 4.2 0 0 1 19 10.5C19 15.5 12 20 12 20Z" stroke="${c}" stroke-width="1.9" fill="rgba(244,114,182,0.22)"/></svg>`;
  }
  if (key === 'outfit_tactical') {
    const c = rarityColor || '#38bdf8';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 4h10l3 5-3 3v8H7v-8L4 9l3-5Z" stroke="${c}" stroke-width="1.8" fill="rgba(56,189,248,0.16)"/><path d="M10 11h4M12 9v6" stroke="${c}" stroke-width="1.6"/></svg>`;
  }
  if (key === 'outfit_dress' || key === 'outfit_casual' || item?.category === ITEM_CATEGORIES.OUTFIT) {
    const c = rarityColor || '#f472b6';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 4L12 7L16 4L20 8L17 11V20H7V11L4 8L8 4Z" stroke="${c}" stroke-width="1.8" fill="rgba(244,114,182,0.16)" stroke-linejoin="round"/></svg>`;
  }

  const grp = classifyItemWarehouseGroup(item);
  if (key === 'engine' || item?.category === ITEM_CATEGORIES.ENGINE) {
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="7" stroke="${rarityColor || '#38bdf8'}" stroke-width="2"/><path d="M12 5V12L17 15" stroke="${rarityColor || '#38bdf8'}" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  if (key === 'armor' || item?.category === ITEM_CATEGORIES.ARMOR) {
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3L19 6V12C19 16.5 15.8 19.8 12 21C8.2 19.8 5 16.5 5 12V6L12 3Z" stroke="${rarityColor || '#60a5fa'}" stroke-width="2" fill="rgba(96,165,250,0.16)"/></svg>`;
  }
  if (key === 'core' || item?.category === ITEM_CATEGORIES.CORE) {
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><polygon points="12,3 20,12 12,21 4,12" stroke="${rarityColor || '#c084fc'}" stroke-width="2" fill="rgba(192,132,252,0.18)"/><circle cx="12" cy="12" r="2.8" fill="${rarityColor || '#c084fc'}"/></svg>`;
  }
  if (grp === WAREHOUSE_GROUPS.WEAPON) {
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 18L17 5M14 5H19V10M7 15L10 18" stroke="${rarityColor || '#f97316'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (grp === WAREHOUSE_GROUPS.TACTICAL) {
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="${rarityColor || '#10b981'}" stroke-width="1.8" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="3" stroke="${rarityColor || '#34d399'}" stroke-width="1.8"/><path d="M12 12L17.5 6.5" stroke="${rarityColor || '#34d399'}" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="3" stroke="#fbbf24" stroke-width="1.8" fill="rgba(251,191,36,0.15)"/><path d="M12 9V15M9 12H15" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/></svg>`;
}

/**
 * Compressed 2-Digit Starter Items:
 * White (+2~4), Green (+4~7), Blue (+7~11), Purple (+11~16), Orange (+16~22).
 */
export const STARTER_ITEMS = [
  {
    id: 'item_core_engine_01',
    name: '标准蒸汽轮机引擎',
    category: ITEM_CATEGORIES.ENGINE,
    rarity: ITEM_RARITIES.COMMON,
    statScaleVersion: 2,
    tags: ['核心必装', '动力'],
    description: '制式舰用推进引擎，提供稳定的机动性与反潜航速支持。',
    quantity: 10,
    level: 0,
    bonuses: [
      { stat: 'evasion', layer: 'baseAdd', value: 4 },
      { stat: 'asw', layer: 'baseAdd', value: 2 },
    ],
  },
  {
    id: 'item_core_armor_01',
    name: '复合均质舰体装甲',
    category: ITEM_CATEGORIES.ARMOR,
    rarity: ITEM_RARITIES.COMMON,
    statScaleVersion: 2,
    tags: ['核心必装', '防护'],
    description: '均衡型舰体装甲结构，提升装甲防护与耐久上限。',
    quantity: 10,
    level: 0,
    bonuses: [
      { stat: 'armor', layer: 'baseAdd', value: 4 },
      { stat: 'maxHp', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    id: 'item_core_core_01',
    name: '标准火控中枢核心',
    category: ITEM_CATEGORIES.CORE,
    rarity: ITEM_RARITIES.COMMON,
    statScaleVersion: 2,
    tags: ['核心必装', '中枢'],
    description: '舰载作战控制核心，强化火力、侦查与基础检定精度。',
    quantity: 10,
    level: 0,
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 3 },
      { stat: 'recon', layer: 'baseAdd', value: 3 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 1 },
    ],
  },
  {
    id: 'item_ext_01',
    name: '高爆双联主炮',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'weapon',
    equipmentType: KNOWN_EQUIPMENT_TYPES.MAIN_GUN,
    iconKey: 'main_gun',
    rarity: ITEM_RARITIES.UNCOMMON,
    statScaleVersion: 2,
    tags: ['主战武器', '主炮'],
    description: '高初速双联装主炮模块，穿甲系数稳定。',
    quantity: 3,
    level: 0,
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 6 },
      { stat: 'aa', layer: 'baseAdd', value: 3 },
    ],
  },
  {
    id: 'item_ext_02',
    name: '主动声呐阵列',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'tactical',
    equipmentType: KNOWN_EQUIPMENT_TYPES.SONAR,
    iconKey: 'sonar',
    rarity: ITEM_RARITIES.UNCOMMON,
    statScaleVersion: 2,
    tags: ['战术辅助', '声呐', '反潜'],
    description: '高灵敏度水下声呐模块，强化反潜与侦查定位。',
    quantity: 3,
    level: 0,
    bonuses: [
      { stat: 'asw', layer: 'baseAdd', value: 6 },
      { stat: 'recon', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    id: 'item_support_repair_01',
    name: '战地抢修吊舱',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'support',
    equipmentType: KNOWN_EQUIPMENT_TYPES.SUPPORT,
    supportRole: 'repair',
    iconKey: 'support_repair',
    rarity: ITEM_RARITIES.UNCOMMON,
    statScaleVersion: 2,
    tags: ['后勤支援', '抢修', '损管'],
    description: '装备后解锁战斗指令「紧急抢修」，为 3×4 阵型内受伤队友恢复耐久。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'armor', layer: 'baseAdd', value: 4 },
      { stat: 'recon', layer: 'baseAdd', value: 5 },
    ],
  },
  {
    id: 'item_support_supply_01',
    name: '海上补给箱',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'support',
    equipmentType: KNOWN_EQUIPMENT_TYPES.SUPPORT,
    supportRole: 'supply',
    iconKey: 'support_supply',
    rarity: ITEM_RARITIES.UNCOMMON,
    statScaleVersion: 2,
    tags: ['后勤支援', '补给', '油弹'],
    description: '装备后解锁战斗指令「前线补给」，恢复随舰弹药并提升全队士气（单次出征限用 2 次）。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'maxHp', layer: 'baseAdd', value: 5 },
      { stat: 'recon', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    id: 'item_outfit_standard',
    name: '标准港区常服',
    category: ITEM_CATEGORIES.OUTFIT,
    rarity: ITEM_RARITIES.COMMON,
    statScaleVersion: 2,
    tags: ['服装', '日常'],
    description: '剪裁轻便的港区执勤常服，提供机动与侦查小幅加成。',
    quantity: 4,
    level: 0,
    bonuses: [
      { stat: 'evasion', layer: 'baseAdd', value: 3 },
      { stat: 'recon', layer: 'baseAdd', value: 2 },
    ],
  },
  {
    id: 'item_consumable_med',
    name: '应急损管修复包',
    category: ITEM_CATEGORIES.CONSUMABLE,
    tags: ['消耗品', '恢复'],
    description: '现场紧急损管物资，使用后恢复 25 点耐久与 10 点士气。',
    quantity: 6,
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
    quantity: 6,
    level: 0,
    bonuses: [
      { stat: 'ap', layer: 'baseAdd', value: 30 },
      { stat: 'morale', layer: 'baseAdd', value: 15 },
    ],
  },
];

/**
 * Full Starter Content Pack Equipment Catalog (Compressed 2-Digit Scale: White +2~4, Green +4~7, Blue +7~11).
 */
export const STARTER_PACK_EQUIPMENT_16 = [
  ...STARTER_ITEMS.filter((i) => i.category !== ITEM_CATEGORIES.CONSUMABLE),
  {
    id: 'item_pack_engine_turbo',
    name: '涡轮增压引擎',
    category: ITEM_CATEGORIES.ENGINE,
    rarity: ITEM_RARITIES.UNCOMMON,
    statScaleVersion: 2,
    tags: ['核心必装', '高机动'],
    description: '高出力增压轮机，提供爆发机动与迂回优势。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'evasion', layer: 'baseAdd', value: 7 },
      { stat: 'torpedo', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    id: 'item_pack_armor_sloped',
    name: '倾角装甲板',
    category: ITEM_CATEGORIES.ARMOR,
    rarity: ITEM_RARITIES.UNCOMMON,
    statScaleVersion: 2,
    tags: ['核心必装', '重甲防护'],
    description: '大倾角复合跳弹装甲，抬升装甲与耐久上限。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'armor', layer: 'baseAdd', value: 7 },
      { stat: 'maxHp', layer: 'baseAdd', value: 6 },
    ],
  },
  {
    id: 'item_pack_core_tactical',
    name: '精密战术火控核心',
    category: ITEM_CATEGORIES.CORE,
    rarity: ITEM_RARITIES.RARE,
    statScaleVersion: 2,
    tags: ['核心必装', '精密火控'],
    description: '多目标弹道解算中枢，提升火力、侦查与命中修正。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 8 },
      { stat: 'recon', layer: 'baseAdd', value: 7 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 1 },
    ],
  },
  {
    id: 'item_pack_wpn_oxygen_torp',
    name: '九三式氧雷',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'weapon',
    equipmentType: KNOWN_EQUIPMENT_TYPES.TORPEDO,
    iconKey: 'torpedo',
    rarity: ITEM_RARITIES.RARE,
    statScaleVersion: 2,
    tags: ['主战武器', '鱼雷'],
    description: '高航速无航迹重型酸素鱼雷，无视 40% 有效装甲。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'torpedo', layer: 'baseAdd', value: 10 },
      { stat: 'evasion', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    id: 'item_pack_wpn_triple_gun',
    name: '超重三联装主炮',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'weapon',
    equipmentType: KNOWN_EQUIPMENT_TYPES.MAIN_GUN,
    iconKey: 'main_gun',
    rarity: ITEM_RARITIES.RARE,
    statScaleVersion: 2,
    tags: ['主战武器', '主炮', '重炮'],
    description: '主力舰级超重穿甲三联主炮，无视 35% 有效装甲。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 11 },
      { stat: 'armor', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    id: 'item_pack_wpn_dive_bomber',
    name: '舰载俯冲轰炸机中队',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'weapon',
    equipmentType: KNOWN_EQUIPMENT_TYPES.AIRCRAFT,
    iconKey: 'aircraft',
    rarity: ITEM_RARITIES.RARE,
    statScaleVersion: 2,
    tags: ['主战武器', '舰载机', '航母'],
    description: '精锐舰载俯冲轰炸中队，全图空袭无视排数衰减。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 9 },
      { stat: 'recon', layer: 'baseAdd', value: 8 },
    ],
  },
  {
    id: 'item_pack_tac_aa_radar',
    name: '对空电探',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'tactical',
    equipmentType: KNOWN_EQUIPMENT_TYPES.RADAR,
    iconKey: 'radar',
    rarity: ITEM_RARITIES.UNCOMMON,
    statScaleVersion: 2,
    tags: ['战术辅助', '雷达', '防空'],
    description: '广域相控对空电探，提升雷达校射扫描与防空拦截。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'aa', layer: 'baseAdd', value: 6 },
      { stat: 'recon', layer: 'baseAdd', value: 6 },
    ],
  },
  {
    id: 'item_pack_tac_aa_gun',
    name: '四联装速射防空炮',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'tactical',
    equipmentType: KNOWN_EQUIPMENT_TYPES.AA_GUN,
    iconKey: 'aa_gun',
    rarity: ITEM_RARITIES.UNCOMMON,
    statScaleVersion: 2,
    tags: ['战术辅助', '防空', '高炮'],
    description: '高射速防空炮塔，装备后解锁「防空警戒网」邻格护盾。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'aa', layer: 'baseAdd', value: 7 },
      { stat: 'firepower', layer: 'baseAdd', value: 3 },
    ],
  },
  {
    id: 'item_pack_support_dc_kit',
    name: '精工损管抢修套件',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'support',
    equipmentType: KNOWN_EQUIPMENT_TYPES.SUPPORT,
    supportRole: 'repair',
    iconKey: 'support_repair',
    rarity: ITEM_RARITIES.RARE,
    statScaleVersion: 2,
    tags: ['后勤支援', '损管', '抢修'],
    description: '军工级损管抢修套件，强化紧急抢修效率并提升耐久装甲。',
    quantity: 1,
    level: 0,
    bonuses: [
      { stat: 'armor', layer: 'baseAdd', value: 8 },
      { stat: 'maxHp', layer: 'baseAdd', value: 9 },
    ],
  },
  {
    id: 'item_pack_outfit_banquet',
    name: '港区礼装宴会服',
    category: ITEM_CATEGORIES.OUTFIT,
    rarity: ITEM_RARITIES.UNCOMMON,
    statScaleVersion: 2,
    tags: ['服装', '礼装'],
    description: '优雅精致的港区庆典礼服，穿戴后提升侦查与机动。',
    quantity: 2,
    level: 0,
    bonuses: [
      { stat: 'recon', layer: 'baseAdd', value: 5 },
      { stat: 'evasion', layer: 'baseAdd', value: 5 },
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
 * Compressed 2-Digit Enhancement Scaling (+1 ~ +10 provides +5 ~ +10 additional stat points total).
 */
export function computeEnhancedBonuses(baseBonuses = [], level = 0) {
  const lv = Math.max(0, Math.min(MAX_ENHANCE_LEVEL, Math.floor(Number(level) || 0)));
  return sanitizeBonuses(baseBonuses).map((b) => {
    if (lv === 0 || b.value <= 0) return { ...b };
    if (b.layer === 'percentAdd' || b.layer === 'percentMult') {
      return { ...b, value: Number((b.value + lv * 0.015).toFixed(4)) };
    }
    if (b.stat === 'checkBonus') {
      return { ...b, value: b.value + Math.floor(lv / 4) };
    }
    // +10 provides +5 (low-base secondary stat) to +10 (primary high-tier stat)
    const maxAt10 = Math.max(5, Math.min(10, Math.round(5 + b.value * 0.25)));
    const gain = Math.round((maxAt10 * lv) / MAX_ENHANCE_LEVEL);
    return { ...b, value: b.value + gain };
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
    /** @type {number} Salvage parts accumulated from disassembling surplus equipment for rarity promotion */
    this._salvageParts = 0;
    /** @type {number} Retrofit Cores earned from duplicate ship construction */
    this._retrofitCores = 0;
    this._hydrated = false;

    if (this._bus) {
      this._bus.on('commander:updated', () => {
        this.syncAllCharacters();
      });
    }
  }

  getSalvageParts() {
    return Math.max(0, Math.floor(Number(this._salvageParts) || 0));
  }

  async addSalvageParts(amount) {
    const add = Math.max(0, Math.floor(Number(amount) || 0));
    if (add <= 0) return this.getSalvageParts();
    this._salvageParts = this.getSalvageParts() + add;
    await this.persist();
    this._emit('inventory:salvage-changed', { salvageParts: this._salvageParts, delta: add });
    return this._salvageParts;
  }

  getRetrofitCores() {
    return Math.max(0, Math.floor(Number(this._retrofitCores) || 0));
  }

  async addRetrofitCores(amount) {
    const add = Math.max(0, Math.floor(Number(amount) || 0));
    if (add <= 0) return this.getRetrofitCores();
    this._retrofitCores = this.getRetrofitCores() + add;
    await this.persist();
    this._emit('inventory:retrofit-cores-changed', { retrofitCores: this._retrofitCores, delta: add });
    return this._retrofitCores;
  }

  async toggleItemLock(itemId, force = null) {
    const id = String(itemId || '');
    const item = this._items.get(id);
    if (!item) throw new Error('目标装备不存在');
    const nextLocked = force !== null && force !== undefined ? Boolean(force) : !item.locked;
    item.locked = nextLocked;
    item.updatedAt = Date.now();
    await this.persist();
    this._emit('inventory:item-updated', { item: deepClone(item) });
    return deepClone(item);
  }

  getSalvagePartsYield(item) {
    const rId = inferItemRarity(item);
    const baseByRarity = {
      common: 2,
      uncommon: 4,
      rare: 8,
      epic: 16,
      legendary: 30,
    };
    const lv = Math.max(0, Math.floor(Number(item?.level) || 0));
    return (baseByRarity[rId] || 2) + Math.floor(lv / 2);
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
  // Per-Character Slot Architecture (3 Mandatory Core + Outfit + Typed Expandable Slots)
  // ------------------------------------------------------------

  _normalizeExpandedSlot(rawSlot = {}, equippedItem = null) {
    // When migrating a legacy slot that already has an equipped item, infer type from the equipped item first
    // so historical saves NEVER unequip or drop existing stat bonuses!
    const inferredType = rawSlot.equipmentType && KNOWN_EQUIPMENT_TYPE_MAP[rawSlot.equipmentType]
      ? rawSlot.equipmentType
      : equippedItem
      ? inferEquipmentTypeId(equippedItem, KNOWN_EQUIPMENT_TYPES.MAIN_GUN)
      : inferEquipmentTypeId(rawSlot, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
    const typeId = KNOWN_EQUIPMENT_TYPE_MAP[inferredType] ? inferredType : KNOWN_EQUIPMENT_TYPES.MAIN_GUN;
    const typeDef = KNOWN_EQUIPMENT_TYPE_MAP[typeId] || KNOWN_EQUIPMENT_TYPE_MAP[KNOWN_EQUIPMENT_TYPES.MAIN_GUN];

    return {
      id: String(rawSlot.id || `slot_${typeId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`),
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
  }

  getCharacterSlots(characterId) {
    const cid = String(characterId || '');
    const customList = Array.isArray(this._customSlotsByCharacter[cid])
      ? this._customSlotsByCharacter[cid]
      : [];
    const slotMap = this._equipped[cid] || {};
    const normalizedExpanded = customList.map((s) => {
      const eqItem = slotMap[s.id] ? this._items.get(slotMap[s.id]) : null;
      return this._normalizeExpandedSlot(s, eqItem);
    });
    return [
      ...deepClone(MANDATORY_CORE_SLOTS),
      deepClone(OPTIONAL_OUTFIT_SLOT),
      ...normalizedExpanded,
    ];
  }

  getCharacterSlot(characterId, slotId) {
    return this.getCharacterSlots(characterId).find((s) => s.id === slotId) || null;
  }

  /**
   * Return ship-class custom expandable slot cap info and escalating material costs for a shipgirl:
   *   - DD / SS : max 2
   *   - CL / CA : max 3
   *   - BB / CV : max 4
   */
  getCharacterSlotCapInfo(characterId) {
    const cid = String(characterId || '');
    const entity = this._entities?.get(cid);
    const shipType = entity?.meta?.shipType || '';
    const shipClass = resolveShipClass(shipType);
    const max = getShipClassSlotCap(shipType);
    const used = Array.isArray(this._customSlotsByCharacter[cid]) ? this._customSlotsByCharacter[cid].length : 0;
    return {
      characterId: cid,
      shipClass,
      shipType: shipType || shipClass,
      used,
      max,
      canExpand: used < max,
      expansionCost: getSlotExpansionCost(used),
      changeCost: getSlotChangeTypeCost(Math.max(1, used)),
    };
  }

  /**
   * Expand a new typed equipment slot on a shipgirl chosen from KNOWN_EQUIPMENT_TYPES.
   * Enforces ship-class slot cap and optional steel/bauxite/silver material expenditure.
   */
  async addExpandedSlot(characterId, equipmentTypeId, { resources = null, skipCost = false } = {}) {
    const cid = String(characterId || '').trim();
    if (!cid) throw new Error('角色 ID 不能为空');
    const typeId = normalizeEquipmentTypeId(equipmentTypeId, null);
    if (!typeId || !KNOWN_EQUIPMENT_TYPE_MAP[typeId]) {
      throw new Error('请选择有效的已知装备类型');
    }
    const capInfo = this.getCharacterSlotCapInfo(cid);
    if (!skipCost && !capInfo.canExpand) {
      throw new Error(`该舰种（${capInfo.shipClass}）自定义槽位已达上限（${capInfo.used}/${capInfo.max}）`);
    }

    let paidCost = null;
    let usedPermit = false;
    if (resources && !skipCost) {
      const permitItem = this.getItem('item_permit_slot_expand');
      if (permitItem && Number(permitItem.quantity || 0) > 0) {
        await this.consumeItemQuantity(permitItem.id, 1);
        usedPermit = true;
      } else {
        const cost = capInfo.expansionCost;
        const spend = await resources.spendBatch(cost, {
          reason: `扩建「${this._entities?.get(cid)?.name || cid}」第 ${capInfo.used + 1} 个装备槽位`,
        });
        if (!spend.ok) {
          throw new Error(spend.reason || '扩建所需钢材/铝材/银条不足');
        }
        paidCost = cost;
      }
    }

    const typeDef = KNOWN_EQUIPMENT_TYPE_MAP[typeId];

    if (!Array.isArray(this._customSlotsByCharacter[cid])) {
      this._customSlotsByCharacter[cid] = [];
    }
    const slot = this._normalizeExpandedSlot({
      id: `slot_${typeDef.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      equipmentType: typeDef.id,
      label: typeDef.slotLabel,
    });
    this._customSlotsByCharacter[cid].push(slot);
    await this.persist();
    const payload = {
      characterId: cid,
      slot: deepClone(slot),
      cost: paidCost,
      usedPermit,
      used: this._customSlotsByCharacter[cid].length,
      max: capInfo.max,
    };
    this._emit('inventory:slot-added', payload);
    this._emit('inventory:slot-expanded', payload);
    return deepClone(slot);
  }

  /**
   * Backward-compatible wrapper: maps any label/type string to its matching Known Equipment Type.
   */
  async addCharacterCustomSlot(characterId, labelOrTypeId, opts = {}) {
    const typeId = normalizeEquipmentTypeId(labelOrTypeId, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
    return this.addExpandedSlot(characterId, typeId, { skipCost: true, ...opts });
  }

  /**
   * Change an existing expanded slot to another Known Equipment Type.
   * Consumes steel/bauxite/silver when `resources` is provided, and returns any incompatible item to warehouse.
   */
  async changeExpandedSlotType(characterId, slotId, nextEquipmentTypeId, { resources = null, skipCost = false } = {}) {
    const cid = String(characterId || '').trim();
    const typeId = normalizeEquipmentTypeId(nextEquipmentTypeId, null);
    if (!typeId || !KNOWN_EQUIPMENT_TYPE_MAP[typeId]) {
      throw new Error('请选择有效的已知装备类型');
    }
    const list = this._customSlotsByCharacter[cid] || [];
    const idx = list.findIndex((s) => s.id === slotId);
    if (idx < 0 || !list[idx]?.custom) {
      throw new Error('仅支持变更已扩建的装备槽位类型');
    }

    let paidCost = null;
    if (resources && !skipCost) {
      const capInfo = this.getCharacterSlotCapInfo(cid);
      const cost = capInfo.changeCost;
      const spend = await resources.spendBatch(cost, {
        reason: `变更「${this._entities?.get(cid)?.name || cid}」槽位类型`,
      });
      if (!spend.ok) {
        throw new Error(spend.reason || '变更槽位类型所需材料不足');
      }
      paidCost = cost;
    }

    const updatedSlot = this._normalizeExpandedSlot({
      ...list[idx],
      id: list[idx].id,
      equipmentType: typeId,
    });
    list[idx] = updatedSlot;

    let unequippedItem = null;
    const eqId = this._equipped[cid]?.[slotId];
    if (eqId) {
      const curItem = this._items.get(eqId);
      if (curItem && !this.isItemCompatibleWithSlot(updatedSlot, curItem)) {
        unequippedItem = deepClone(curItem);
        delete this._equipped[cid][slotId];
        this.syncCharacterModifiers(cid);
      }
    }

    await this.persist();
    this._emit('inventory:slot-renamed', {
      characterId: cid,
      slotId,
      equipmentType: updatedSlot.equipmentType,
      label: updatedSlot.label,
      unequippedItem,
      cost: paidCost,
    });
    return { slot: deepClone(updatedSlot), unequippedItem, cost: paidCost };
  }

  async renameCharacterCustomSlot(characterId, slotId, newLabelOrTypeId, opts = {}) {
    const typeId = normalizeEquipmentTypeId(newLabelOrTypeId, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
    const res = await this.changeExpandedSlotType(characterId, slotId, typeId, { skipCost: true, ...opts });
    return res.slot;
  }

  async removeCharacterCustomSlot(characterId, slotId) {
    const cid = String(characterId || '').trim();
    const slot = this.getCharacterSlot(cid, slotId);
    if (!slot) return false;
    if (slot.required || !slot.custom) {
      throw new Error(`「${slot.label}」为基础固定槽位，不可拆除`);
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

  async removeExpandedSlot(characterId, slotId) {
    return this.removeCharacterCustomSlot(characterId, slotId);
  }

  /**
   * Authoritative check whether an equipment/outfit item matches a specific slot's type.
   */
  isItemCompatibleWithSlot(slot, item) {
    if (!slot || !item) return false;
    if (item.category === ITEM_CATEGORIES.CONSUMABLE) return false;

    const slotType = slot.equipmentType || (slot.id === 'outfit' ? 'outfit' : inferEquipmentTypeId(slot, KNOWN_EQUIPMENT_TYPES.MAIN_GUN));
    const itemType = inferEquipmentTypeId(item, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);

    if (slotType === 'outfit') {
      return item.category === ITEM_CATEGORIES.OUTFIT;
    }
    if (item.category === ITEM_CATEGORIES.OUTFIT) {
      return false;
    }
    if (
      slotType === KNOWN_EQUIPMENT_TYPES.ENGINE ||
      slotType === KNOWN_EQUIPMENT_TYPES.ARMOR ||
      slotType === KNOWN_EQUIPMENT_TYPES.CORE
    ) {
      return item.category === slotType || itemType === slotType;
    }
    return itemType === slotType;
  }

  /**
   * Return all warehouse items strictly matching a slot's equipment type (sorted by rarity -> level).
   */
  getSlotCompatibleItems(characterId, slotId) {
    const slot = this.getCharacterSlot(characterId, slotId);
    if (!slot) return [];
    return this.listItems().filter((it) => this.isItemCompatibleWithSlot(slot, it));
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

  listItems({
    category = null,
    warehouseGroup = null,
    rarity = null, // 'all' | 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
    equipStatus = null, // 'all' | 'idle' | 'equipped'
    tag = null,
    enhanceableOnly = false,
  } = {}) {
    const out = [];
    for (const item of this._items.values()) {
      const itemRarity = inferItemRarity(item);
      if (category && item.category !== category) continue;
      if (warehouseGroup && warehouseGroup !== WAREHOUSE_GROUPS.ALL) {
        if (classifyItemWarehouseGroup(item) !== warehouseGroup) continue;
      }
      if (rarity && rarity !== 'all' && itemRarity !== rarity) continue;
      if (tag && !(item.tags || []).includes(tag)) continue;
      if (enhanceableOnly && item.category === ITEM_CATEGORIES.CONSUMABLE) continue;
      if (equipStatus === 'equipped' || equipStatus === 'idle') {
        const worn = this.getWearersOfItem(item.id).length > 0;
        if (equipStatus === 'equipped' && !worn) continue;
        if (equipStatus === 'idle' && worn) continue;
      }
      out.push({ ...deepClone(item), rarity: itemRarity });
    }
    return out.sort((a, b) => {
      const rDiff = (ITEM_RARITY_MAP[b.rarity]?.rank || 1) - (ITEM_RARITY_MAP[a.rarity]?.rank || 1);
      if (rDiff !== 0) return rDiff;
      return (b.level || 0) - (a.level || 0) || (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  getIdleUnenhancedItems() {
    const list = [];
    for (const item of this._items.values()) {
      if (item.category === ITEM_CATEGORIES.CONSUMABLE) continue;
      if (item.locked) continue;
      if ((Number(item.level) || 0) > 0) continue;
      if (this.getWearersOfItem(item.id).length > 0) continue;
      list.push({ ...deepClone(item), rarity: inferItemRarity(item) });
    }
    return list;
  }

  /**
   * Filter idle (unequipped, unlocked, non-consumable) items matching selected rarities for batch disassembly.
   */
  getIdleItemsByRarity({
    rarities = [ITEM_RARITIES.COMMON, ITEM_RARITIES.UNCOMMON],
    includeEnhanced = false,
  } = {}) {
    const allowed = new Set((Array.isArray(rarities) ? rarities : [rarities]).map((r) => normalizeRarity(r)));
    const list = [];
    for (const item of this._items.values()) {
      if (item.category === ITEM_CATEGORIES.CONSUMABLE) continue;
      if (item.locked) continue;
      if (!includeEnhanced && (Number(item.level) || 0) > 0) continue;
      if (this.getWearersOfItem(item.id).length > 0) continue;
      const r = inferItemRarity(item);
      if (!allowed.has(r)) continue;
      list.push({ ...deepClone(item), rarity: r });
    }
    return list;
  }

  previewBatchDisassemble({
    rarities = [ITEM_RARITIES.COMMON, ITEM_RARITIES.UNCOMMON],
    includeEnhanced = false,
    dropMultiplier = 1.0,
  } = {}) {
    const targets = this.getIdleItemsByRarity({ rarities, includeEnhanced });
    const totals = { steel: 0, bauxite: 0, silver: 0, salvageParts: 0 };
    for (const t of targets) {
      const y = getDisassembleYieldByRarity(t, { dropMultiplier });
      totals.steel += y.steel;
      totals.bauxite += y.bauxite;
      totals.silver += y.silver;
      totals.salvageParts += this.getSalvagePartsYield(t);
    }
    return { count: targets.length, items: targets, yield: totals };
  }

  async disassembleSingleItem(itemId, { resources = null } = {}) {
    const id = String(itemId || '');
    const existing = this._items.get(id);
    if (!existing) throw new Error('目标物品不存在');
    if (existing.locked) {
      throw new Error(`「${existing.name}」已上锁（🔒），请先解锁后再拆解`);
    }
    const mult = resources && typeof resources.getDropMultiplier === 'function' ? resources.getDropMultiplier() : 1.0;
    const baseYield =
      existing.category === ITEM_CATEGORIES.CONSUMABLE
        ? { steel: 0, bauxite: 0, silver: 25 }
        : getDisassembleYieldByRarity(existing, { dropMultiplier: mult });
    const partsYield = existing.category === ITEM_CATEGORIES.CONSUMABLE ? 0 : this.getSalvagePartsYield(existing);
    const snapshot = deepClone(existing);

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
    if (partsYield > 0) {
      this._salvageParts = this.getSalvageParts() + partsYield;
    }
    await this.persist();

    if (resources) {
      if (baseYield.steel > 0) await resources.add('steel', baseYield.steel, { reason: `拆解装备「${snapshot.name}」` });
      if (baseYield.bauxite > 0) await resources.add('bauxite', baseYield.bauxite, { reason: `拆解装备「${snapshot.name}」` });
      if (baseYield.silver > 0) await resources.add('silver', baseYield.silver, { reason: `拆解装备「${snapshot.name}」` });
    }
    const yieldObj = { ...baseYield, salvageParts: partsYield };
    this._emit('inventory:item-deleted', { itemId: id, yield: yieldObj });
    this._emit('inventory:salvage-changed', { salvageParts: this._salvageParts, delta: partsYield });
    return { item: snapshot, yield: yieldObj, salvagePartsTotal: this._salvageParts };
  }

  async disassembleItemsByRarity({
    rarities = [ITEM_RARITIES.COMMON, ITEM_RARITIES.UNCOMMON],
    includeEnhanced = false,
    resources = null,
    dropMultiplier = null,
  } = {}) {
    const mult =
      dropMultiplier !== null && dropMultiplier !== undefined
        ? dropMultiplier
        : resources && typeof resources.getDropMultiplier === 'function'
        ? resources.getDropMultiplier()
        : 1.0;
    const preview = this.previewBatchDisassemble({ rarities, includeEnhanced, dropMultiplier: mult });
    if (preview.count === 0) {
      return { removedCount: 0, removedNames: [], yield: { steel: 0, bauxite: 0, silver: 0, salvageParts: 0 } };
    }
    for (const t of preview.items) {
      this._items.delete(t.id);
    }
    if (preview.yield.salvageParts > 0) {
      this._salvageParts = this.getSalvageParts() + preview.yield.salvageParts;
    }
    await this.persist();
    if (resources) {
      if (preview.yield.steel > 0) await resources.add('steel', preview.yield.steel, { reason: `批量拆解 ${preview.count} 件闲置装备` });
      if (preview.yield.bauxite > 0) await resources.add('bauxite', preview.yield.bauxite, { reason: `批量拆解 ${preview.count} 件闲置装备` });
      if (preview.yield.silver > 0) await resources.add('silver', preview.yield.silver, { reason: `批量拆解 ${preview.count} 件闲置装备` });
    }
    const payload = {
      removedCount: preview.count,
      removedNames: preview.items.map((t) => t.name),
      yield: preview.yield,
      salvagePartsTotal: this._salvageParts,
    };
    this._emit('inventory:cleaned', payload);
    this._emit('inventory:salvage-changed', { salvageParts: this._salvageParts, delta: preview.yield.salvageParts });
    return payload;
  }

  async cleanupIdleUnenhancedItems({ resources = null } = {}) {
    const targets = this.getIdleUnenhancedItems();
    if (targets.length === 0) {
      return { removedCount: 0, removedNames: [], yield: { steel: 0, bauxite: 0, silver: 0, salvageParts: 0 } };
    }
    const mult = resources && typeof resources.getDropMultiplier === 'function' ? resources.getDropMultiplier() : 1.0;
    const totals = { steel: 0, bauxite: 0, silver: 0, salvageParts: 0 };
    for (const t of targets) {
      const y = getDisassembleYieldByRarity(t, { dropMultiplier: mult });
      totals.steel += y.steel;
      totals.bauxite += y.bauxite;
      totals.silver += y.silver;
      totals.salvageParts += this.getSalvagePartsYield(t);
      this._items.delete(t.id);
    }
    this._salvageParts = this.getSalvageParts() + totals.salvageParts;
    await this.persist();
    if (resources) {
      if (totals.steel > 0) await resources.add('steel', totals.steel, { reason: `批量拆解 ${targets.length} 件闲置装备` });
      if (totals.bauxite > 0) await resources.add('bauxite', totals.bauxite, { reason: `批量拆解 ${targets.length} 件闲置装备` });
      if (totals.silver > 0) await resources.add('silver', totals.silver, { reason: `批量拆解 ${targets.length} 件闲置装备` });
    }
    this._emit('inventory:cleaned', {
      removedCount: targets.length,
      removedNames: targets.map((t) => t.name),
      yield: totals,
    });
    return {
      removedCount: targets.length,
      removedNames: targets.map((t) => t.name),
      yield: totals,
    };
  }

  /**
   * Roll & create a compressed 2-digit equipment or outfit drop crate from 1★~5★ sortie salvage / combat victories.
   * Commander permanent Luck directly boosts Legendary (橙装) drop odds. Includes AR/AO support equipment!
   */
  async rollLootDropItem({
    tier = 'encounter', // 'resource' | 'encounter' | 'elite' | 'boss'
    difficulty = 'star_1',
    dropMultiplier = 1.0,
    luckBonus = null,
    forcedRarity = null,
    rng = Math.random,
  } = {}) {
    const mult = Math.max(0.5, Number(dropMultiplier) || 1.0);
    const diffStr = String(difficulty || 'star_1').toLowerCase();
    const starBoostMap = {
      low: 0,
      star_1: 0,
      medium: 0.1,
      star_2: 0.08,
      high: 0.22,
      star_3: 0.16,
      star_4: 0.24,
      star_5: 0.34,
    };
    const diffBoost = starBoostMap[diffStr] ?? 0;
    const multBoost = Math.min(0.24, Math.max(0, mult - 1) * 0.1);
    const cmdLuckBoost =
      luckBonus !== null && luckBonus !== undefined
        ? Number(luckBonus) || 0
        : this._commander && typeof this._commander.getLuckEffects === 'function'
        ? Math.max(0, Math.min(0.28, (this._commander.getLuckEffects().rareDropBonus || 0) * 0.85))
        : 0;
    const roll = rng() + diffBoost + multBoost + cmdLuckBoost;

    let rarity = ITEM_RARITIES.UNCOMMON;
    if (forcedRarity && ITEM_RARITY_MAP[forcedRarity]) {
      rarity = forcedRarity;
    } else if (tier === 'boss') {
      rarity = roll >= 0.78 ? ITEM_RARITIES.LEGENDARY : roll >= 0.42 ? ITEM_RARITIES.EPIC : ITEM_RARITIES.RARE;
    } else if (tier === 'elite') {
      rarity = roll >= 0.9 ? ITEM_RARITIES.LEGENDARY : roll >= 0.56 ? ITEM_RARITIES.EPIC : roll >= 0.22 ? ITEM_RARITIES.RARE : ITEM_RARITIES.UNCOMMON;
    } else if (tier === 'encounter') {
      rarity = roll >= 0.96 ? ITEM_RARITIES.LEGENDARY : roll >= 0.75 ? ITEM_RARITIES.EPIC : roll >= 0.42 ? ITEM_RARITIES.RARE : ITEM_RARITIES.UNCOMMON;
    } else {
      rarity = roll >= 0.88 ? ITEM_RARITIES.EPIC : roll >= 0.54 ? ITEM_RARITIES.RARE : roll >= 0.22 ? ITEM_RARITIES.UNCOMMON : ITEM_RARITIES.COMMON;
    }

    const rDef = ITEM_RARITY_MAP[rarity] || ITEM_RARITY_MAP.uncommon;
    const budget = RARITY_STAT_BUDGETS[rarity] || RARITY_STAT_BUDGETS.uncommon;
    const primaryVal = Math.round(budget.min + rng() * (budget.max - budget.min));
    const secondaryVal = Math.max(2, Math.round(primaryVal * (0.45 + rng() * 0.15)));

    const pool = [
      {
        name: '高初速穿甲双联主炮',
        category: ITEM_CATEGORIES.EXTENSION,
        subGroup: 'weapon',
        subCategory: KNOWN_EQUIPMENT_TYPES.MAIN_GUN,
        equipmentType: KNOWN_EQUIPMENT_TYPES.MAIN_GUN,
        iconKey: 'main_gun',
        tags: ['主战武器', '主炮', '战利品'],
        bonuses: [
          { stat: 'firepower', layer: 'baseAdd', value: primaryVal },
          { stat: 'aa', layer: 'baseAdd', value: secondaryVal },
        ],
      },
      {
        name: '五联装酸素鱼雷发射管',
        category: ITEM_CATEGORIES.EXTENSION,
        subGroup: 'weapon',
        subCategory: KNOWN_EQUIPMENT_TYPES.TORPEDO,
        equipmentType: KNOWN_EQUIPMENT_TYPES.TORPEDO,
        iconKey: 'torpedo',
        tags: ['主战武器', '鱼雷', '战利品'],
        bonuses: [
          { stat: 'torpedo', layer: 'baseAdd', value: primaryVal },
          { stat: 'evasion', layer: 'baseAdd', value: secondaryVal },
        ],
      },
      {
        name: '精锐舰载俯冲轰炸机队',
        category: ITEM_CATEGORIES.EXTENSION,
        subGroup: 'weapon',
        subCategory: KNOWN_EQUIPMENT_TYPES.AIRCRAFT,
        equipmentType: KNOWN_EQUIPMENT_TYPES.AIRCRAFT,
        iconKey: 'aircraft',
        tags: ['主战武器', '舰载机', '战利品'],
        bonuses: [
          { stat: 'firepower', layer: 'baseAdd', value: primaryVal },
          { stat: 'recon', layer: 'baseAdd', value: secondaryVal },
          { stat: 'aa', layer: 'baseAdd', value: Math.max(2, Math.round(secondaryVal * 0.8)) },
        ],
      },
      {
        name: '深水脉冲反潜声呐阵列',
        category: ITEM_CATEGORIES.EXTENSION,
        subGroup: 'tactical',
        subCategory: KNOWN_EQUIPMENT_TYPES.SONAR,
        equipmentType: KNOWN_EQUIPMENT_TYPES.SONAR,
        iconKey: 'sonar',
        tags: ['战术辅助', '声呐', '反潜'],
        bonuses: [
          { stat: 'asw', layer: 'baseAdd', value: primaryVal },
          { stat: 'recon', layer: 'baseAdd', value: secondaryVal },
          ...(rDef.rank >= 4 ? [{ stat: 'checkBonus', layer: 'flatFinal', value: rDef.rank >= 5 ? 2 : 1 }] : []),
        ],
      },
      {
        name: '相控阵对空搜索雷达',
        category: ITEM_CATEGORIES.EXTENSION,
        subGroup: 'tactical',
        subCategory: KNOWN_EQUIPMENT_TYPES.RADAR,
        equipmentType: KNOWN_EQUIPMENT_TYPES.RADAR,
        iconKey: 'radar',
        tags: ['战术辅助', '雷达', '防空'],
        bonuses: [
          { stat: 'aa', layer: 'baseAdd', value: primaryVal },
          { stat: 'recon', layer: 'baseAdd', value: secondaryVal },
          ...(rDef.rank >= 4 ? [{ stat: 'checkBonus', layer: 'flatFinal', value: rDef.rank >= 5 ? 2 : 1 }] : []),
        ],
      },
      {
        name: '高射速防空联装机炮',
        category: ITEM_CATEGORIES.EXTENSION,
        subGroup: 'tactical',
        subCategory: KNOWN_EQUIPMENT_TYPES.AA_GUN,
        equipmentType: KNOWN_EQUIPMENT_TYPES.AA_GUN,
        iconKey: 'aa_gun',
        tags: ['战术辅助', '防空', '高炮'],
        bonuses: [
          { stat: 'aa', layer: 'baseAdd', value: primaryVal },
          { stat: 'firepower', layer: 'baseAdd', value: secondaryVal },
        ],
      },
      {
        name: '战地抢修吊舱',
        category: ITEM_CATEGORIES.EXTENSION,
        subGroup: 'support',
        subCategory: KNOWN_EQUIPMENT_TYPES.SUPPORT,
        equipmentType: KNOWN_EQUIPMENT_TYPES.SUPPORT,
        supportRole: 'repair',
        iconKey: 'support_repair',
        tags: ['后勤支援', '抢修', '维修舰'],
        bonuses: [
          { stat: 'armor', layer: 'baseAdd', value: primaryVal },
          { stat: 'maxHp', layer: 'baseAdd', value: secondaryVal },
        ],
      },
      {
        name: '海上补给箱',
        category: ITEM_CATEGORIES.EXTENSION,
        subGroup: 'support',
        subCategory: KNOWN_EQUIPMENT_TYPES.SUPPORT,
        equipmentType: KNOWN_EQUIPMENT_TYPES.SUPPORT,
        supportRole: 'supply',
        iconKey: 'support_supply',
        tags: ['后勤支援', '补给', '补给舰'],
        bonuses: [
          { stat: 'recon', layer: 'baseAdd', value: primaryVal },
          { stat: 'evasion', layer: 'baseAdd', value: secondaryVal },
        ],
      },
      {
        name: '精工损管抢修套件',
        category: ITEM_CATEGORIES.EXTENSION,
        subGroup: 'support',
        subCategory: KNOWN_EQUIPMENT_TYPES.SUPPORT,
        equipmentType: KNOWN_EQUIPMENT_TYPES.SUPPORT,
        supportRole: 'repair',
        iconKey: 'support_repair',
        tags: ['后勤支援', '损管', '抢修'],
        bonuses: [
          { stat: 'maxHp', layer: 'baseAdd', value: primaryVal },
          { stat: 'armor', layer: 'baseAdd', value: secondaryVal },
        ],
      },
      {
        name: '高出力舰用燃气轮机',
        category: ITEM_CATEGORIES.ENGINE,
        subGroup: 'core',
        subCategory: KNOWN_EQUIPMENT_TYPES.ENGINE,
        equipmentType: KNOWN_EQUIPMENT_TYPES.ENGINE,
        iconKey: 'engine',
        tags: ['核心必装', '引擎'],
        bonuses: [
          { stat: 'evasion', layer: 'baseAdd', value: primaryVal },
          { stat: 'asw', layer: 'baseAdd', value: secondaryVal },
        ],
      },
      {
        name: '多层陶瓷复合舰体装甲',
        category: ITEM_CATEGORIES.ARMOR,
        subGroup: 'core',
        subCategory: KNOWN_EQUIPMENT_TYPES.ARMOR,
        equipmentType: KNOWN_EQUIPMENT_TYPES.ARMOR,
        iconKey: 'armor',
        tags: ['核心必装', '装甲'],
        bonuses: [
          { stat: 'armor', layer: 'baseAdd', value: primaryVal },
          { stat: 'maxHp', layer: 'baseAdd', value: secondaryVal },
        ],
      },
      {
        name: '星辉海风盛装礼服箱',
        category: ITEM_CATEGORIES.OUTFIT,
        subGroup: 'outfit',
        subCategory: 'outfit',
        iconKey: rDef.rank >= 5 ? 'outfit_oath' : 'outfit_dress',
        outfitStyle: rDef.rank >= 5 ? '誓约花嫁' : rDef.rank >= 4 ? '优雅礼服' : '海滨泳装',
        tags: ['服装', '战利品服装箱'],
        bonuses: [
          { stat: 'evasion', layer: 'baseAdd', value: Math.max(2, Math.round(primaryVal * 0.65)) },
          { stat: 'recon', layer: 'baseAdd', value: Math.max(2, Math.round(primaryVal * 0.65)) },
          ...(rDef.rank >= 4 ? [{ stat: 'checkBonus', layer: 'flatFinal', value: 1 }] : []),
        ],
      },
    ];

    const picked = pool[Math.floor(rng() * pool.length)];
    const prefix =
      rarity === ITEM_RARITIES.LEGENDARY
        ? '【传说】'
        : rarity === ITEM_RARITIES.EPIC
        ? '【史诗】'
        : rarity === ITEM_RARITIES.RARE
        ? '【精锐】'
        : '';

    return this.createItem({
      name: `${prefix}${picked.name}`,
      category: picked.category,
      subGroup: picked.subGroup,
      subCategory: picked.subCategory,
      equipmentType: picked.equipmentType,
      supportRole: picked.supportRole || '',
      iconKey: picked.iconKey,
      outfitStyle: picked.outfitStyle || '',
      rarity,
      statScaleVersion: 2,
      tags: [...picked.tags, rDef.shortLabel],
      description: `海域缴获的${rDef.label}级${picked.category === ITEM_CATEGORIES.OUTFIT ? '舰娘服装' : picked.subGroup === 'support' ? '后勤支援装备' : '战术装备'}。`,
      bonuses: picked.bonuses,
      quantity: 1,
      level: 0,
    });
  }

  getItem(itemId) {
    const item = this._items.get(String(itemId));
    return item ? { ...deepClone(item), rarity: inferItemRarity(item) } : null;
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

    const draft = {
      id,
      name,
      category,
      ...(def.subGroup ? { subGroup: String(def.subGroup) } : {}),
      ...(def.subCategory ? { subCategory: String(def.subCategory) } : {}),
      ...(def.equipmentType ? { equipmentType: String(def.equipmentType) } : {}),
      ...(def.supportRole ? { supportRole: String(def.supportRole) } : {}),
      ...(def.iconKey ? { iconKey: String(def.iconKey) } : {}),
      ...(def.outfitStyle ? { outfitStyle: String(def.outfitStyle).trim() } : {}),
      locked: Boolean(def.locked),
      statScaleVersion: Number(def.statScaleVersion) || 2,
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
    draft.rarity = def.rarity ? normalizeRarity(def.rarity) : inferItemRarity(draft);
    if (category !== ITEM_CATEGORIES.CONSUMABLE) {
      const resolvedType = inferEquipmentTypeId(draft, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
      draft.equipmentType = resolvedType;
      draft.subCategory = resolvedType;
      if (resolvedType === KNOWN_EQUIPMENT_TYPES.SUPPORT && !draft.supportRole) {
        draft.supportRole = inferSupportRole(draft) || 'repair';
      }
    }

    this._items.set(id, draft);
    await this.persist();
    this._emit('inventory:item-created', { item: deepClone(draft) });
    return deepClone(draft);
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
      subGroup: patch.subGroup !== undefined ? String(patch.subGroup) : existing.subGroup,
      subCategory: patch.subCategory !== undefined ? String(patch.subCategory) : existing.subCategory,
      equipmentType: patch.equipmentType !== undefined ? String(patch.equipmentType) : patch.subCategory !== undefined ? String(patch.subCategory) : existing.equipmentType,
      supportRole: patch.supportRole !== undefined ? String(patch.supportRole) : existing.supportRole || '',
      iconKey: patch.iconKey !== undefined ? String(patch.iconKey) : existing.iconKey,
      outfitStyle: patch.outfitStyle !== undefined ? String(patch.outfitStyle).trim() : existing.outfitStyle || '',
      locked: patch.locked !== undefined ? Boolean(patch.locked) : Boolean(existing.locked),
      statScaleVersion: Number(patch.statScaleVersion ?? existing.statScaleVersion ?? 2),
      rarity:
        patch.rarity !== undefined
          ? normalizeRarity(patch.rarity)
          : existing.rarity
          ? normalizeRarity(existing.rarity)
          : inferItemRarity({ ...existing, bonuses: nextBonuses, level: nextLevel }),
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

  /**
   * Promote a +10 max-enhanced equipment/outfit item to the next rarity tier
   * (common -> uncommon -> rare -> epic -> legendary), elevating its base bonuses cleanly
   * and resetting enhance level to +0 to unlock another +1..+10 growth ceiling.
   */
  async promoteItemRarity(itemId, { resources = null, discount = 0 } = {}) {
    const existing = this._items.get(String(itemId));
    if (!existing) throw new Error(`物品 "${itemId}" 不存在`);
    if (existing.category === ITEM_CATEGORIES.CONSUMABLE) {
      throw new Error('消耗品不支持品级升阶');
    }
    const curLevel = Math.max(0, Math.floor(Number(existing.level) || 0));
    if (curLevel < MAX_ENHANCE_LEVEL) {
      throw new Error(`需先强化至满级 +${MAX_ENHANCE_LEVEL} 方可升阶（当前 +${curLevel}）`);
    }
    const curRarity = inferItemRarity(existing);
    const plan = getEquipmentPromoteCost(existing, { discount });
    if (!plan) {
      throw new Error(`「${existing.name}」已是最高传说（橙）品级，无法继续升阶`);
    }

    const curParts = this.getSalvageParts();
    if (curParts < plan.salvageParts) {
      throw new Error(`装备拆解余料不足：需要 ${plan.salvageParts}，当前拥有 ${curParts}（拆解多余装备可获取）`);
    }

    if (resources) {
      const spend = await resources.spendBatch(plan.resources, {
        reason: `装备品级升阶「${existing.name}」`,
      });
      if (!spend.ok) {
        throw new Error(spend.reason || '升阶所需钢材/铝材/银条不足');
      }
    }

    this._salvageParts = Math.max(0, curParts - plan.salvageParts);

    // Elevate base bonuses to slightly exceed previous +10 effective values so promotion is strictly an upgrade
    const curEffective = Array.isArray(existing.bonuses) && existing.bonuses.length > 0
      ? existing.bonuses
      : existing.baseBonuses || [];
    const promotedBase = curEffective.map((b) => {
      if (b.stat === 'checkBonus') {
        return { ...b, value: Math.max(1, Math.round(Number(b.value) || 0) + (plan.toRarity === ITEM_RARITIES.LEGENDARY ? 1 : 0)) };
      }
      if (b.layer === 'percentAdd' || b.layer === 'percentMult') {
        return { ...b, value: Number(((Number(b.value) || 0) * 1.12).toFixed(4)) };
      }
      const curVal = Number(b.value) || 0;
      const boosted = curVal >= 0 ? Math.max(curVal + 2, Math.round(curVal * 1.08)) : curVal;
      return { ...b, value: boosted };
    });

    existing.rarity = plan.toRarity;
    existing.level = 0;
    existing.baseBonuses = deepClone(promotedBase);
    existing.bonuses = deepClone(promotedBase);
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
      fromRarity: curRarity,
      toRarity: plan.toRarity,
      salvageSpent: plan.salvageParts,
      salvagePartsRemaining: this._salvageParts,
      affectedCharacters,
      timestamp: Date.now(),
    };
    this._emit('inventory:promoted', payload);
    this._emit('inventory:salvage-changed', { salvageParts: this._salvageParts, delta: -plan.salvageParts });
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
    const existing = this._items.get(id);
    if (!existing) return false;
    if (existing.locked) {
      throw new Error(`「${existing.name}」已上锁（🔒），请先解锁后再删除`);
    }

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
    const matching = slots.filter((s) => this.isItemCompatibleWithSlot(s, item));
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
   * Compute amplified bonus value from Commander `maintenance`:
   *   - Mandatory 3 core slots amplified by `getCorePartsAmplifier()`
   *   - Enhanced items (`level > 0`) amplified by `getEnhanceEffectivenessMultiplier()`
   */
  _resolveSlotBonusValue(slotId, bonus, item = null) {
    const rawVal = Number(bonus.value) || 0;
    if (rawVal <= 0 || bonus.stat === 'checkBonus') {
      return rawVal;
    }
    let amp = 1.0;
    if (MANDATORY_SLOT_IDS.has(slotId)) {
      amp *= this.getCorePartsAmplifier();
    }
    if (item && Number(item.level || 0) > 0 && this._commander?.getEnhanceEffectivenessMultiplier) {
      const enhMult = this._commander.getEnhanceEffectivenessMultiplier();
      amp *= 1 + (enhMult - 1) * Math.min(1, Number(item.level) / 5);
    }
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
        const effVal = this._resolveSlotBonusValue(slotId, b, item);
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
   * Compute live 8-stat delta (`delta > 0` green up / `delta < 0` red down) if `candidateItemId`
   * were equipped into `slotId` on `characterId` replacing whatever currently occupies `slotId`.
   */
  previewEquipStatDiff(characterId, slotId, candidateItemId) {
    const cid = String(characterId || '');
    const curEquipped = this.getCharacterEquipment(cid);
    const currentItem = curEquipped[slotId] || null;
    const candidateItem = candidateItemId ? this.getItem(candidateItemId) : null;

    const sumItemStats = (item) => {
      const map = {};
      if (!item) return map;
      for (const b of item.bonuses || []) {
        if (!b?.stat || b.stat === 'checkBonus') continue;
        const val = this._resolveSlotBonusValue(slotId, b);
        if (b.layer === 'percentAdd' || b.layer === 'percentMult') continue;
        map[b.stat] = (map[b.stat] || 0) + Math.round(Number(val) || 0);
      }
      return map;
    };

    const curMap = sumItemStats(currentItem);
    const nextMap = sumItemStats(candidateItem);
    const diffs = [];
    for (const def of NAVAL_EIGHT_STAT_DEFS) {
      const before = curMap[def.key] || 0;
      const after = nextMap[def.key] || 0;
      const delta = after - before;
      if (delta !== 0) {
        diffs.push({
          key: def.key,
          label: def.label,
          shortLabel: def.shortLabel,
          before,
          after,
          delta,
        });
      }
    }
    return {
      slotId,
      currentItemId: currentItem?.id || null,
      candidateItemId: candidateItem?.id || null,
      diffs,
      hasChanges: diffs.length > 0,
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
      const itemTypeId = inferEquipmentTypeId(item, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
      const itemTypeLabel = KNOWN_EQUIPMENT_TYPE_MAP[itemTypeId]?.label || ITEM_CATEGORY_LABELS[item.category] || '装备';
      if (item.category === ITEM_CATEGORIES.EXTENSION) {
        throw new Error(`当前角色尚未扩建「${itemTypeLabel}」装备槽位，请先在角色卡点击「+ 扩建装备槽位」添加${itemTypeLabel}槽`);
      }
      throw new Error(`未找到兼容的「${itemTypeLabel}」槽位`);
    }
    if (!this.isItemCompatibleWithSlot(slot, item)) {
      const itemTypeId = inferEquipmentTypeId(item, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
      const itemTypeLabel = itemTypeId === 'outfit' ? '服装' : KNOWN_EQUIPMENT_TYPE_MAP[itemTypeId]?.label || ITEM_CATEGORY_LABELS[item.category];
      throw new Error(
        `「${item.name}」（${itemTypeLabel}）与「${slot.label}」类型不匹配，请先扩建或变更对应装备槽位`
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

  /**
   * Compute deterministic priority tuple for optimal auto-equip:
   *   1. Ship-class role affinity bonus (AR/AO prioritize support/AA/radar/armor/recon over heavy offensive guns)
   *   2. Rarity rank (legendary 5 > epic 4 > rare 3 > uncommon 2 > common 1)
   *   3. Enhancement level (+Lv)
   *   4. Weighted naval 8-stat + checkBonus sum
   */
  _scoreItemForAutoEquip(item, shipClass = '') {
    const rId = inferItemRarity(item);
    const rarityRank = ITEM_RARITY_MAP[rId]?.rank || 1;
    const level = Math.max(0, Math.floor(Number(item?.level) || 0));
    const cls = String(shipClass || '').toUpperCase();
    const eqType = inferEquipmentTypeId(item, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
    const supportRole = inferSupportRole(item);

    let roleBias = 0;
    if (cls === 'AR' || cls === 'AO') {
      if (eqType === KNOWN_EQUIPMENT_TYPES.SUPPORT) {
        roleBias += 25;
        if (cls === 'AR' && supportRole === 'repair') roleBias += 12;
        if (cls === 'AO' && supportRole === 'supply') roleBias += 12;
      } else if (
        eqType === KNOWN_EQUIPMENT_TYPES.AA_GUN ||
        eqType === KNOWN_EQUIPMENT_TYPES.RADAR ||
        eqType === KNOWN_EQUIPMENT_TYPES.SONAR
      ) {
        roleBias += 10;
      } else if (eqType === KNOWN_EQUIPMENT_TYPES.MAIN_GUN || eqType === KNOWN_EQUIPMENT_TYPES.TORPEDO) {
        roleBias -= 10;
      }
    } else if (cls === 'CV') {
      if (eqType === KNOWN_EQUIPMENT_TYPES.AIRCRAFT) roleBias += 12;
    } else if (cls === 'BB') {
      if (eqType === KNOWN_EQUIPMENT_TYPES.MAIN_GUN) roleBias += 10;
    } else if (cls === 'DD' || cls === 'SS') {
      if (eqType === KNOWN_EQUIPMENT_TYPES.TORPEDO || eqType === KNOWN_EQUIPMENT_TYPES.SONAR) roleBias += 8;
    }

    let statSum = 0;
    for (const b of item?.bonuses || []) {
      const val = Number(b?.value) || 0;
      let weight = 1.0;
      if (cls === 'AR') {
        if (b?.stat === 'armor' || b?.stat === 'maxHp' || b?.stat === 'aa' || b?.stat === 'recon') weight = 1.35;
        else if (b?.stat === 'firepower' || b?.stat === 'torpedo') weight = 0.6;
      } else if (cls === 'AO') {
        if (b?.stat === 'recon' || b?.stat === 'evasion' || b?.stat === 'aa' || b?.stat === 'armor') weight = 1.35;
        else if (b?.stat === 'firepower' || b?.stat === 'torpedo') weight = 0.6;
      }
      if (b?.stat === 'checkBonus') statSum += val * 8;
      else if (b?.layer === 'percentAdd' || b?.layer === 'percentMult') statSum += val * 100 * weight;
      else statSum += val * weight;
    }
    return { roleBias, rarityRank, level, statSum };
  }

  _compareAutoEquipCandidates(a, b, shipClass = '') {
    const sa = this._scoreItemForAutoEquip(a, shipClass);
    const sb = this._scoreItemForAutoEquip(b, shipClass);
    if (sb.roleBias !== sa.roleBias) return sb.roleBias - sa.roleBias;
    if (sb.rarityRank !== sa.rarityRank) return sb.rarityRank - sa.rarityRank;
    if (sb.level !== sa.level) return sb.level - sa.level;
    if (sb.statSum !== sa.statSum) return sb.statSum - sa.statSum;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  }

  /**
   * One-click optimal auto-equip for a single shipgirl:
   * Iterates 3 mandatory core slots -> all expanded typed slots -> outfit slot (if currently empty),
   * assigning the highest-rarity / highest-level / highest-stat IDLE matching warehouse equipment.
   * Respects ship class specialization (AR/AO prioritize support/AA/radar over BB main guns).
   * Never downgrades a slot that already holds a better item.
   */
  async autoEquipCharacter(characterId, { includeOutfit = true, excludeItemIds = null } = {}) {
    const cid = String(characterId || '');
    if (!cid) throw new Error('目标角色 ID 不能为空');
    const entity = this._entities?.get(cid);
    const shipClass = resolveShipClass(entity?.meta?.shipType || '');
    const slots = this.getCharacterSlots(cid);
    if (!this._equipped[cid]) this._equipped[cid] = {};

    const reservedCounts = new Map();
    if (excludeItemIds instanceof Map) {
      for (const [k, v] of excludeItemIds.entries()) reservedCounts.set(String(k), Number(v) || 0);
    } else if (excludeItemIds instanceof Set || Array.isArray(excludeItemIds)) {
      for (const k of excludeItemIds) reservedCounts.set(String(k), (reservedCounts.get(String(k)) || 0) + 1);
    }

    // Count how many OTHER characters currently wear each itemId (respecting item.quantity)
    const wornByOthersCount = new Map();
    for (const [otherCid, slotMap] of Object.entries(this._equipped)) {
      if (otherCid === cid) continue;
      for (const eqId of Object.values(slotMap || {})) {
        if (eqId) {
          const id = String(eqId);
          wornByOthersCount.set(id, (wornByOthersCount.get(id) || 0) + 1);
        }
      }
    }

    const coreSlots = slots.filter((s) => s.required);
    const expandedSlots = slots.filter((s) => s.custom);
    const outfitSlots = includeOutfit ? slots.filter((s) => !s.required && !s.custom && s.id === 'outfit') : [];
    const orderedSlots = [...coreSlots, ...expandedSlots, ...outfitSlots];

    const usedOnThisChar = new Set();
    const equippedDetails = [];
    let changedCount = 0;

    for (const slot of orderedSlots) {
      const currentItemId = this._equipped[cid][slot.id] || null;
      const currentItem = currentItemId ? this._items.get(currentItemId) : null;

      // For outfit slot: only auto-equip if the shipgirl is not already wearing an outfit
      if (slot.id === 'outfit' && currentItem) {
        usedOnThisChar.add(currentItem.id);
        continue;
      }

      const candidates = [];
      for (const item of this._items.values()) {
        if (!this.isItemCompatibleWithSlot(slot, item)) continue;
        if (usedOnThisChar.has(item.id)) continue;
        const maxCopies = Math.max(1, Math.floor(Number(item.quantity ?? 1) || 1));
        const otherUsed = Math.max(wornByOthersCount.get(item.id) || 0, reservedCounts.get(item.id) || 0);
        if (otherUsed >= maxCopies && item.id !== currentItemId) continue;
        candidates.push(item);
      }

      if (candidates.length === 0) {
        if (currentItem) usedOnThisChar.add(currentItem.id);
        continue;
      }

      candidates.sort((a, b) => this._compareAutoEquipCandidates(a, b, shipClass));
      const best = candidates[0];

      // Avoid swapping if already wearing an equally good or better item in this slot
      if (currentItem && currentItem.id === best.id) {
        usedOnThisChar.add(best.id);
        continue;
      }
      if (currentItem && this._compareAutoEquipCandidates(currentItem, best, shipClass) <= 0) {
        usedOnThisChar.add(currentItem.id);
        continue;
      }

      // If `best` was sitting in a different slot of this same character, free that slot first
      for (const [sId, eqId] of Object.entries(this._equipped[cid])) {
        if (eqId === best.id && sId !== slot.id) {
          delete this._equipped[cid][sId];
        }
      }

      this._equipped[cid][slot.id] = best.id;
      usedOnThisChar.add(best.id);
      changedCount += 1;
      equippedDetails.push({
        slotId: slot.id,
        slotLabel: slot.label,
        itemId: best.id,
        itemName: best.name,
        rarity: inferItemRarity(best),
      });
    }

    if (changedCount > 0) {
      this.syncCharacterModifiers(cid);
      await this.persist();
      const actor = this._entities?.get(cid);
      this._emit('inventory:equipped', {
        characterId: cid,
        characterName: actor?.name || cid,
        autoEquipped: true,
        equippedCount: changedCount,
        seaworthy: this.checkSeaworthiness(cid).seaworthy,
        timestamp: Date.now(),
      });
    }

    const actor = this._entities?.get(cid);
    const seaworthyInfo = this.checkSeaworthiness(cid);
    return {
      characterId: cid,
      characterName: actor?.name || cid,
      equippedCount: changedCount,
      equippedDetails,
      wornItemIds: Array.from(usedOnThisChar),
      seaworthy: seaworthyInfo.seaworthy,
    };
  }

  /**
   * One-click unequip all slots (core + expanded + outfit) for a single shipgirl.
   */
  async unequipAllForCharacter(characterId) {
    const cid = String(characterId || '');
    const slotMap = this._equipped[cid];
    if (!slotMap || Object.keys(slotMap).length === 0) {
      return { characterId: cid, removedCount: 0, seaworthy: this.checkSeaworthiness(cid).seaworthy };
    }
    const removedCount = Object.keys(slotMap).length;
    this._equipped[cid] = {};
    this.syncCharacterModifiers(cid);
    await this.persist();

    const actor = this._entities?.get(cid);
    const seaworthyInfo = this.checkSeaworthiness(cid);
    this._emit('inventory:unequipped', {
      characterId: cid,
      characterName: actor?.name || cid,
      unequipAll: true,
      removedCount,
      seaworthy: seaworthyInfo.seaworthy,
      timestamp: Date.now(),
    });
    return {
      characterId: cid,
      characterName: actor?.name || cid,
      removedCount,
      seaworthy: seaworthyInfo.seaworthy,
    };
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

  async consumeItemQuantity(itemId, count = 1) {
    const item = this._items.get(String(itemId));
    const n = Math.max(1, Math.floor(Number(count) || 1));
    if (!item || Number(item.quantity || 0) < n) {
      throw new Error('背包道具数量不足');
    }
    item.quantity = Math.max(0, Math.floor(Number(item.quantity || 0)) - n);
    item.updatedAt = Date.now();
    await this.persist();
    this._emit('inventory:item-updated', { item: deepClone(item), consumed: n });
    return deepClone(item);
  }

  listBackpackGifts() {
    return this.listItems({ category: ITEM_CATEGORIES.CONSUMABLE }).filter((it) => {
      if (Number(it.quantity || 0) <= 0) return false;
      const hasAffBonus = (it.bonuses || []).some((b) => b.stat === 'affinity' && Number(b.value) > 0);
      const hasGiftTag = (it.tags || []).some((t) => /礼物|好感|心意/.test(String(t)));
      return hasAffBonus || hasGiftTag;
    });
  }

  listOwnedOutfits() {
    return this.listItems({ category: ITEM_CATEGORIES.OUTFIT });
  }

  // ------------------------------------------------------------
  // Serialization
  // ------------------------------------------------------------

  serialize() {
    return {
      version: 6,
      customSlotsByCharacter: deepClone(this._customSlotsByCharacter),
      items: Array.from(this._items.values()).map((it) => deepClone(it)),
      equipped: deepClone(this._equipped),
      salvageParts: this.getSalvageParts(),
      retrofitCores: this.getRetrofitCores(),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._items.clear();
    this._salvageParts = Math.max(0, Math.floor(Number(snapshot.salvageParts) || 0));
    this._retrofitCores = Math.max(0, Math.floor(Number(snapshot.retrofitCores) || 0));
    if (Array.isArray(snapshot.items)) {
      for (const it of snapshot.items) {
        if (it && it.id) {
          const rawMerged = {
            ...deepClone(it),
            locked: Boolean(it.locked),
          };
          rawMerged.rarity = it.rarity ? normalizeRarity(it.rarity) : inferItemRarity(rawMerged);
          const normalized = normalizeLegacyItemBonusesToCompressedScale(rawMerged);
          const baseBonuses = sanitizeBonuses(normalized.baseBonuses || normalized.bonuses || []);
          const level = Math.max(0, Math.min(MAX_ENHANCE_LEVEL, Math.floor(Number(normalized.level) || 0)));
          const bonuses = computeEnhancedBonuses(baseBonuses, level);
          const merged = {
            ...normalized,
            level,
            baseBonuses,
            bonuses,
            statScaleVersion: 2,
          };
          if (merged.category !== ITEM_CATEGORIES.CONSUMABLE) {
            const resolvedType = inferEquipmentTypeId(merged, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
            merged.equipmentType = resolvedType;
            merged.subCategory = resolvedType;
            if (resolvedType === KNOWN_EQUIPMENT_TYPES.SUPPORT && !merged.supportRole) {
              merged.supportRole = inferSupportRole(merged) || 'repair';
            }
          }
          this._items.set(String(it.id), merged);
        }
      }
    }
    this._equipped = deepClone(snapshot.equipped || {});

    // Losslessly normalize all historical custom slots into typed expandable slots
    const rawSlotsMap = snapshot.customSlotsByCharacter || {};
    const normalizedMap = {};
    for (const [charId, slotList] of Object.entries(rawSlotsMap)) {
      if (!Array.isArray(slotList)) continue;
      const eqMap = this._equipped[charId] || {};
      normalizedMap[charId] = slotList.map((s) => {
        const eqItem = s?.id && eqMap[s.id] ? this._items.get(eqMap[s.id]) : null;
        return this._normalizeExpandedSlot(s, eqItem);
      });
    }
    this._customSlotsByCharacter = normalizedMap;

    this.syncAllCharacters();
    if (persist) {
      this.persist();
    }
  }

  /**
   * 100% Deterministic Equipment Crafting (自由定向装备制造):
   * Spends exact resources discounted by Commander `dispatch` and immediately crafts the exact selected gear.
   */
  async craftGearDeterministic(blueprint, { resources = null, commander = null } = {}) {
    if (!blueprint || !blueprint.name) {
      throw new Error('请选择有效的装备制造蓝图');
    }
    const costInfo = computeDeterministicGearCost(blueprint, { commander: commander || this._commander });
    if (resources && typeof resources.spendBatch === 'function') {
      const spend = await resources.spendBatch(costInfo.cost, {
        reason: `定向制造装备「${blueprint.name}」`,
      });
      if (!spend.ok) throw new Error(spend.reason);
    }
    const created = await this.createItem({
      name: blueprint.name,
      category: blueprint.category || ITEM_CATEGORIES.EXTENSION,
      subGroup: blueprint.subGroup || 'weapon',
      subCategory: blueprint.equipmentType || blueprint.subCategory || 'main_gun',
      equipmentType: blueprint.equipmentType || 'main_gun',
      supportRole: blueprint.supportRole || undefined,
      rarity: blueprint.rarity || ITEM_RARITIES.UNCOMMON,
      statScaleVersion: 2,
      tags: Array.isArray(blueprint.tags) ? [...blueprint.tags] : ['定向制造'],
      description: blueprint.description || '港区工坊定向制造的制式装备。',
      bonuses: deepClone(blueprint.bonuses || []),
    });
    return { item: created, costInfo };
  }
}

// ============================================================
// Deterministic Equipment Crafting Catalog & Dispatch Discount
// ============================================================

export const DETERMINISTIC_GEAR_CATALOG = Object.freeze([
  {
    key: 'craft_main_gun_dd',
    name: '双联高平驱逐主炮',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'weapon',
    equipmentType: 'main_gun',
    rarity: ITEM_RARITIES.UNCOMMON,
    specialLabel: '轻量化炮击+防空',
    baseCost: { fuel: 30, ammo: 60, steel: 70, bauxite: 20, silver: 60 },
    tags: ['主炮', '定向制造'],
    description: '适用于驱逐/轻巡的高射速双联主炮，兼顾炮击与防空。',
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 6 },
      { stat: 'aa', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    key: 'craft_main_gun_bb',
    name: '410mm 三联穿甲重炮',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'weapon',
    equipmentType: 'main_gun',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: '高破甲齐射火力',
    baseCost: { fuel: 50, ammo: 130, steel: 160, bauxite: 30, silver: 120 },
    tags: ['主炮', '重炮', '定向制造'],
    description: '战列舰主力重炮，大幅提升火力与装甲压制。',
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 11 },
      { stat: 'armor', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    key: 'craft_torpedo_oxygen',
    name: '五联装酸素重型鱼雷',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'weapon',
    equipmentType: 'torpedo',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: '开幕雷击高破甲',
    baseCost: { fuel: 70, ammo: 110, steel: 90, bauxite: 20, silver: 100 },
    tags: ['鱼雷', '开幕雷击', '定向制造'],
    description: '高装药酸素鱼雷，显著强化开幕雷击前排突击与夜战爆发。',
    bonuses: [
      { stat: 'torpedo', layer: 'baseAdd', value: 11 },
      { stat: 'evasion', layer: 'baseAdd', value: 3 },
    ],
  },
  {
    key: 'craft_aa_gun_flak',
    name: '双联高角防空机炮阵',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'tactical',
    equipmentType: 'aa_gun',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: '强化防空弹幕拦截',
    baseCost: { fuel: 30, ammo: 90, steel: 90, bauxite: 80, silver: 90 },
    tags: ['防空炮', '防空弹幕', '定向制造'],
    description: '高密度防空弹幕炮，显著提高敌方开幕空袭拦截击落率。',
    bonuses: [
      { stat: 'aa', layer: 'baseAdd', value: 11 },
      { stat: 'firepower', layer: 'baseAdd', value: 3 },
    ],
  },
  {
    key: 'craft_sonar_asw',
    name: '三式主动声呐与深弹套组',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'tactical',
    equipmentType: 'sonar',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: '解锁水下反潜锁定',
    baseCost: { fuel: 40, ammo: 70, steel: 75, bauxite: 75, silver: 90 },
    tags: ['声呐', '深弹', '反潜', '定向制造'],
    description: '装配后可锁定并重创水下隐匿潜艇，大幅提升反潜与索敌。',
    bonuses: [
      { stat: 'asw', layer: 'baseAdd', value: 12 },
      { stat: 'recon', layer: 'baseAdd', value: 4 },
    ],
  },
  {
    key: 'craft_radar_fcs',
    name: '精密火控对空相控雷达',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'tactical',
    equipmentType: 'radar',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: '火控锁定无视闪避 + 防空',
    baseCost: { fuel: 45, ammo: 45, steel: 100, bauxite: 130, silver: 120 },
    tags: ['雷达', '火控', '对空', '定向制造'],
    description: '赋予「火控锁定」特效（无视目标部分闪避值），强化全队索敌与防空。',
    bonuses: [
      { stat: 'recon', layer: 'baseAdd', value: 9 },
      { stat: 'aa', layer: 'baseAdd', value: 6 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 1 },
    ],
  },
  {
    key: 'craft_aircraft_squadron',
    name: '制空战斗轰炸机混编联队',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'weapon',
    equipmentType: 'aircraft',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: '制空权争夺 + 越前排开幕轰炸',
    baseCost: { fuel: 70, ammo: 70, steel: 60, bauxite: 170, silver: 130 },
    tags: ['舰载机', '制空', '开幕轰炸', '定向制造'],
    description: '开战阶段参与制空权争夺并发动越过前排的开幕轰炸。',
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 9 },
      { stat: 'recon', layer: 'baseAdd', value: 7 },
      { stat: 'aa', layer: 'baseAdd', value: 7 },
    ],
  },
  {
    key: 'craft_support_repair',
    name: '战地抢修损管工作艇',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'support',
    equipmentType: 'support',
    supportRole: 'repair',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: 'AR 维修舰专精 · 战地抢修',
    baseCost: { fuel: 60, ammo: 30, steel: 120, bauxite: 90, silver: 100 },
    tags: ['后勤支援', '维修', '定向制造'],
    description: '解锁战斗中「战地抢修」指令，维修舰 (AR) 装配获得额外抢修增幅。',
    bonuses: [
      { stat: 'armor', layer: 'baseAdd', value: 6 },
      { stat: 'maxHp', layer: 'baseAdd', value: 6 },
      { stat: 'recon', layer: 'baseAdd', value: 3 },
    ],
  },
  {
    key: 'craft_support_resupply',
    name: '海上洋上油弹补给包',
    category: ITEM_CATEGORIES.EXTENSION,
    subGroup: 'support',
    equipmentType: 'support',
    supportRole: 'resupply',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: 'AO 补给舰专精 · 前线补给',
    baseCost: { fuel: 100, ammo: 100, steel: 60, bauxite: 70, silver: 100 },
    tags: ['后勤支援', '补给', '定向制造'],
    description: '解锁战斗中「前线补给」指令，补给舰 (AO) 装配获得额外补给与士气增幅。',
    bonuses: [
      { stat: 'recon', layer: 'baseAdd', value: 6 },
      { stat: 'evasion', layer: 'baseAdd', value: 5 },
      { stat: 'aa', layer: 'baseAdd', value: 3 },
    ],
  },
  {
    key: 'craft_core_engine',
    name: '高出力舰用蒸汽轮机',
    category: ITEM_CATEGORIES.ENGINE,
    subGroup: 'core',
    equipmentType: 'engine',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: '核心必装 · 高机动闪避',
    baseCost: { fuel: 90, ammo: 30, steel: 110, bauxite: 50, silver: 100 },
    tags: ['核心必装', '引擎', '定向制造'],
    description: '高性能轮机，大幅提升机动与派生闪避值。',
    bonuses: [
      { stat: 'evasion', layer: 'baseAdd', value: 9 },
      { stat: 'firepower', layer: 'baseAdd', value: 3 },
    ],
  },
  {
    key: 'craft_core_armor',
    name: '精炼复合主装甲带',
    category: ITEM_CATEGORIES.ARMOR,
    subGroup: 'core',
    equipmentType: 'armor',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: '核心必装 · 耐久护甲',
    baseCost: { fuel: 40, ammo: 30, steel: 150, bauxite: 40, silver: 100 },
    tags: ['核心必装', '装甲', '定向制造'],
    description: '重型复合装甲带，提升舰体耐久与抗炮击防护。',
    bonuses: [
      { stat: 'armor', layer: 'baseAdd', value: 8 },
      { stat: 'maxHp', layer: 'baseAdd', value: 9 },
    ],
  },
  {
    key: 'craft_core_fcs',
    name: '精密战术火控核心',
    category: ITEM_CATEGORIES.CORE,
    subGroup: 'core',
    equipmentType: 'core',
    rarity: ITEM_RARITIES.RARE,
    specialLabel: '核心必装 · 火力侦查检定',
    baseCost: { fuel: 50, ammo: 60, steel: 90, bauxite: 100, silver: 110 },
    tags: ['核心必装', '控制核心', '定向制造'],
    description: '精密火控中枢，均衡强化火力、索敌与 d20 检定。',
    bonuses: [
      { stat: 'firepower', layer: 'baseAdd', value: 6 },
      { stat: 'recon', layer: 'baseAdd', value: 6 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 1 },
    ],
  },
]);

export function computeDeterministicGearCost(blueprint = {}, { commander = null } = {}) {
  const discount =
    commander && typeof commander.getCraftingCostDiscount === 'function'
      ? commander.getCraftingCostDiscount()
      : 0;
  const scale = Math.max(0.64, 1 - discount);
  const rarityMult =
    blueprint.rarity === ITEM_RARITIES.LEGENDARY
      ? 1.65
      : blueprint.rarity === ITEM_RARITIES.EPIC
      ? 1.3
      : blueprint.rarity === ITEM_RARITIES.RARE
      ? 1.0
      : 0.78;
  const base = blueprint.baseCost || {
    fuel: Math.round(50 * rarityMult),
    ammo: Math.round(60 * rarityMult),
    steel: Math.round(85 * rarityMult),
    bauxite: Math.round(65 * rarityMult),
    silver: Math.round(90 * rarityMult),
  };
  const cost = {};
  for (const [k, v] of Object.entries(base)) {
    const n = Number(v) || 0;
    if (n > 0) cost[k] = Math.max(10, Math.round(n * scale));
  }
  return {
    cost,
    discountPct: Math.round(discount * 100),
  };
}

export function getDeterministicGearCatalog({ contentManager = null } = {}) {
  const list = DETERMINISTIC_GEAR_CATALOG.map((g) => ({ ...deepClone(g), isCustom: false }));
  const customEq = contentManager?.serialize?.()?.customEquipment || [];
  for (const c of customEq) {
    if (!c || !c.name) continue;
    const eqType = inferEquipmentTypeId(c, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
    list.push({
      key: `custom_eq_${c.id || c.name}`,
      name: c.name,
      category: c.category || ITEM_CATEGORIES.EXTENSION,
      subGroup: c.subGroup || (eqType === 'support' ? 'support' : 'weapon'),
      equipmentType: eqType,
      supportRole: c.supportRole || (eqType === 'support' ? 'repair' : undefined),
      rarity: c.rarity || ITEM_RARITIES.RARE,
      specialLabel: '自定义工坊蓝图',
      tags: Array.isArray(c.tags) ? [...c.tags] : ['自定义装备'],
      description: c.description || '来自自定义工坊/外置 JSON 的装备蓝图。',
      bonuses: sanitizeBonuses(c.bonuses || []),
      isCustom: true,
    });
  }
  return list;
}

