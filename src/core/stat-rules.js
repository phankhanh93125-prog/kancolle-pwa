/**
 * Naval Shipgirl Stat Rules, Dynamic Status Bars, Affinity Stages, and 1D20 Check Engine.
 *
 * Upgraded Naval Shipgirl Stat Template:
 *   - Ship Type (`shipType`): built-in presets (驱逐舰, 轻巡洋舰, 重巡洋舰, 战列舰, 航空母舰, 潜艇, 工作舰) + custom free text
 *   - 8 Naval Core & Survival Stats:
 *       1. maxHp     (耐久 / HP上限)
 *       2. firepower (火力)
 *       3. armor     (装甲)
 *       4. torpedo   (雷击)
 *       5. evasion   (机动)
 *       6. recon     (侦查)
 *       7. aa        (防空)
 *       8. asw       (反潜)
 *   - Dynamic Status Bars: hp (当前耐久), morale (士气 0..100), ap (行动点), affinity (好感度 0..100)
 *   - Standard 1D20 Check with Commander Luck edge-tuning (`commanderLuck`), morale mod, and equipment bonuses.
 *   - Legacy 5-stat key aliases (`attack -> firepower`, `burst -> torpedo`, `agility -> evasion`, `tactics -> recon`)
 *     for seamless compatibility with existing event/item rules.
 */

import { clamp, roll } from './calc-engine.js';

const STORAGE_NS = 'core-stat-rules';
const CONFIG_KEY = 'rules-config-v2';

export const SHIP_TYPE_PRESETS = Object.freeze([
  '驱逐舰',
  '轻巡洋舰',
  '重巡洋舰',
  '战列舰',
  '航空母舰',
  '潜艇',
  '维修舰',
  '补给舰',
]);

/**
 * 8 Canonical Ship-Class Profiles (Compressed 2-Digit Curve):
 *   - Level 1 base combat stats strictly in 8 ~ 25 (maxHp 26 ~ 46)
 *   - Natural per-level growth strictly in 0.30 ~ 0.50 (Lv.100 bare stats land in 40 ~ 75)
 *   - Full high-enhance orange gear pushes late-game cores cleanly into 110 ~ 160.
 */
export const SHIP_CLASS_PROFILES = Object.freeze({
  DD: {
    code: 'DD',
    name: '驱逐',
    fullName: '驱逐舰',
    color: '#38bdf8',
    roleSummary: '高机动/雷击/反潜 · 鱼雷破甲暴击 · 消耗最低',
    baseLv1: { maxHp: 28, firepower: 11, armor: 9, torpedo: 22, evasion: 23, recon: 15, aa: 13, asw: 21 },
    growth: { maxHp: 0.48, firepower: 0.32, armor: 0.30, torpedo: 0.50, evasion: 0.48, recon: 0.36, aa: 0.34, asw: 0.48 },
    stepCost: { fuel: 6, ammo: 6 },
    combat: {
      torpedoArmorPen: 0.40,
      torpedoCritMult: 1.5,
      aswCounterMult: 1.55,
    },
  },
  CL: {
    code: 'CL',
    name: '轻巡',
    fullName: '轻巡洋舰',
    color: '#2dd4bf',
    roleSummary: '均衡成长 · 突出防空/反潜/侦查 · 同排护航增幅',
    baseLv1: { maxHp: 34, firepower: 15, armor: 14, torpedo: 16, evasion: 18, recon: 19, aa: 19, asw: 18 },
    growth: { maxHp: 0.52, firepower: 0.38, armor: 0.36, torpedo: 0.38, evasion: 0.40, recon: 0.45, aa: 0.45, asw: 0.44 },
    stepCost: { fuel: 9, ammo: 9 },
    combat: {
      scanCheckBonus: 2,
      aaBarrierBonus: 0.12,
    },
  },
  CA: {
    code: 'CA',
    name: '重巡',
    fullName: '重巡洋舰',
    color: '#f59e0b',
    roleSummary: '侧重火力/装甲/耐久 · 僚机援护挡伤率与减伤高',
    baseLv1: { maxHp: 39, firepower: 20, armor: 19, torpedo: 13, evasion: 14, recon: 16, aa: 16, asw: 10 },
    growth: { maxHp: 0.58, firepower: 0.45, armor: 0.45, torpedo: 0.34, evasion: 0.34, recon: 0.38, aa: 0.38, asw: 0.30 },
    stepCost: { fuel: 13, ammo: 13 },
    combat: {
      shellingBonusMult: 1.08,
      guardChanceBonus: 0.18,
      guardDamageMult: 0.38,
    },
  },
  BB: {
    code: 'BB',
    name: '战列',
    fullName: '战列舰',
    color: '#f87171',
    roleSummary: '最高耐久/火力/装甲 · 重炮穿甲破防 · 消耗最高',
    baseLv1: { maxHp: 46, firepower: 25, armor: 24, torpedo: 8, evasion: 10, recon: 13, aa: 17, asw: 8 },
    growth: { maxHp: 0.65, firepower: 0.50, armor: 0.50, torpedo: 0.30, evasion: 0.30, recon: 0.34, aa: 0.40, asw: 0.30 },
    stepCost: { fuel: 18, ammo: 20 },
    combat: {
      shellingBonusMult: 1.15,
      shellingArmorPen: 0.35,
    },
  },
  CV: {
    code: 'CV',
    name: '航母',
    fullName: '航空母舰',
    color: '#a78bfa',
    roleSummary: '高侦查/防空/耐久 · 舰载机全图空袭无视排数衰减',
    baseLv1: { maxHp: 42, firepower: 21, armor: 17, torpedo: 8, evasion: 14, recon: 24, aa: 22, asw: 10 },
    growth: { maxHp: 0.60, firepower: 0.46, armor: 0.38, torpedo: 0.30, evasion: 0.34, recon: 0.50, aa: 0.48, asw: 0.32 },
    stepCost: { fuel: 16, ammo: 14 },
    combat: {
      airstrikeMode: true,
      visionRangeBonus: 1,
    },
  },
  SS: {
    code: 'SS',
    name: '潜艇',
    fullName: '潜艇',
    color: '#22d3ee',
    roleSummary: '极高雷击与水下隐蔽 · 开幕雷击奇袭 · 消耗极低',
    baseLv1: { maxHp: 24, firepower: 9, armor: 8, torpedo: 24, evasion: 22, recon: 16, aa: 8, asw: 12 },
    growth: { maxHp: 0.42, firepower: 0.30, armor: 0.30, torpedo: 0.50, evasion: 0.48, recon: 0.38, aa: 0.30, asw: 0.32 },
    stepCost: { fuel: 5, ammo: 6 },
    combat: {
      torpedoArmorPen: 0.40,
      torpedoCritMult: 1.5,
    },
  },
  AR: {
    code: 'AR',
    name: '维修',
    fullName: '维修舰',
    color: '#34d399',
    roleSummary: '战地抢修核心 · 锚地免费额外回血 · 远征钢铝增产',
    baseLv1: { maxHp: 36, firepower: 10, armor: 16, torpedo: 8, evasion: 13, recon: 18, aa: 17, asw: 12 },
    growth: { maxHp: 0.54, firepower: 0.30, armor: 0.42, torpedo: 0.30, evasion: 0.34, recon: 0.44, aa: 0.42, asw: 0.34 },
    stepCost: { fuel: 8, ammo: 5 },
    combat: {
      repairPowerBonus: 1.25,
      anchorageFreeHealPct: 0.22,
    },
  },
  AO: {
    code: 'AO',
    name: '补给',
    fullName: '补给舰',
    color: '#fbbf24',
    roleSummary: '提高随舰油弹携行上限 · 战中前线补给 · 远征油弹银增产',
    baseLv1: { maxHp: 35, firepower: 10, armor: 15, torpedo: 8, evasion: 14, recon: 17, aa: 16, asw: 12 },
    growth: { maxHp: 0.52, firepower: 0.30, armor: 0.40, torpedo: 0.30, evasion: 0.36, recon: 0.42, aa: 0.40, asw: 0.34 },
    stepCost: { fuel: 7, ammo: 5 },
    combat: {
      carriedSupplyBonusFuel: 160,
      carriedSupplyBonusAmmo: 160,
      resupplyPowerBonus: 1.25,
    },
  },
});

/**
 * Ship-class custom expandable equipment slot caps (outside 3 fixed core slots: engine/armor/core):
 *   - DD / SS          : max 2 expanded slots
 *   - CL / CA / AR / AO: max 3 expanded slots
 *   - BB / CV          : max 4 expanded slots
 */
export const SHIP_CLASS_CUSTOM_SLOT_CAPS = Object.freeze({
  DD: 2,
  SS: 2,
  CL: 3,
  CA: 3,
  AR: 3,
  AO: 3,
  BB: 4,
  CV: 4,
});

export function getShipClassSlotCap(shipType = '') {
  const code = resolveShipClass(shipType);
  return SHIP_CLASS_CUSTOM_SLOT_CAPS[code] ?? 3;
}

/**
 * Escalating material cost (steel / bauxite / silver) for expanding a shipgirl's N-th custom slot.
 */
export function getSlotExpansionCost(currentExpandedCount = 0) {
  const n = Math.max(0, Math.floor(Number(currentExpandedCount) || 0));
  return {
    steel: 80 + n * 75,
    bauxite: 50 + n * 45,
    silver: 120 + n * 110,
  };
}

/**
 * Material cost (steel / bauxite / silver) for re-tooling an existing expanded slot's equipment type.
 */
export function getSlotChangeTypeCost(currentExpandedCount = 1) {
  const n = Math.max(0, Math.floor(Number(currentExpandedCount) || 1) - 1);
  return {
    steel: 45 + n * 20,
    bauxite: 30 + n * 15,
    silver: 65 + n * 35,
  };
}

/**
 * Compute material + salvageParts cost for promoting a +10 max-enhanced item to the next rarity tier
 * (White -> Green -> Blue -> Purple -> Orange).
 */
export function getEquipmentPromoteCost(item = {}, { discount = 0 } = {}) {
  const rarityId = inferItemRarity(item);
  const idx = ITEM_RARITY_ORDER.indexOf(rarityId);
  if (idx < 0 || idx >= ITEM_RARITY_ORDER.length - 1) return null;
  const nextRarityId = ITEM_RARITY_ORDER[idx + 1];
  const tierScale = idx + 1; // 1 (common->uncommon) .. 4 (epic->legendary)
  const factor = Math.max(0.55, 1 - clamp(Number(discount) || 0, 0, 0.45));
  return {
    fromRarity: rarityId,
    toRarity: nextRarityId,
    resources: {
      steel: Math.max(40, Math.round((120 * tierScale) * factor)),
      bauxite: Math.max(25, Math.round((80 * tierScale) * factor)),
      silver: Math.max(80, Math.round((180 * tierScale) * factor)),
    },
    salvageParts: Math.max(2, tierScale * 4),
  };
}

/**
 * 3~12 Fleet Staggered Resource Consumption Tiers:
 *   - Ships #1..#3  : 100%
 *   - Ships #4..#6  :  75%
 *   - Ships #7..#12 :  55%
 */
export const FLEET_COST_TIERS = Object.freeze([
  { minSlot: 1, maxSlot: 3, factor: 1.0, label: '100%' },
  { minSlot: 4, maxSlot: 6, factor: 0.75, label: '75%' },
  { minSlot: 7, maxSlot: 12, factor: 0.55, label: '55%' },
]);

export function getFleetSlotCostFactor(zeroBasedIndex) {
  const slotNum = Math.max(1, Math.floor(Number(zeroBasedIndex) || 0) + 1);
  if (slotNum <= 3) return 1.0;
  if (slotNum <= 6) return 0.75;
  return 0.55;
}

/**
 * Map any Chinese/English/custom shipType string to one of the canonical class codes
 * ('DD'|'SS'|'CL'|'CA'|'BB'|'CV'|'AR'|'AO').
 */
export function resolveShipClass(shipType = '') {
  const s = String(shipType || '').trim().toUpperCase();
  if (!s) return 'DD';
  if (s === 'AR' || s.includes('维修') || s.includes('工作') || s.includes('REPAIR')) return 'AR';
  if (s === 'AO' || s.includes('补给') || s.includes('油船') || s.includes('SUPPLY') || s.includes('TANKER') || s.includes('OILER')) return 'AO';
  if (s.includes('航母') || s.includes('空母') || s.includes('CV') || s.includes('CARRIER')) return 'CV';
  if (s.includes('战列') || s.includes('战巡') || s.includes('BB') || s.includes('BATTLESHIP')) return 'BB';
  if (s.includes('重巡') || s.includes('CA') || s.includes('HEAVY')) return 'CA';
  if (s.includes('潜艇') || s.includes('潜舰') || s === 'SS' || s.includes('SUB')) return 'SS';
  if (s.includes('轻巡') || s.includes('CL') || s.includes('LIGHT')) return 'CL';
  if (s.includes('驱逐') || s.includes('DD') || s.includes('DESTROYER')) return 'DD';
  return 'CL';
}

export function getShipClassProfile(shipType = '') {
  const code = resolveShipClass(shipType);
  return SHIP_CLASS_PROFILES[code] || SHIP_CLASS_PROFILES.CL;
}

/**
 * Authoritative definitions for Equipment-Driven Tactical Commands + Universal Basic Commands.
 */
export const TACTICAL_ACTION_DEFS = Object.freeze({
  basic_fire: {
    id: 'basic_fire',
    label: '常规防卫射击',
    shortLabel: '防卫射击',
    desc: '通用副炮/轻武器射击，未装配专项武器时始终可用',
    statKey: 'firepower',
    kind: 'attack',
    visualStyle: 'shelling',
    tone: 'shelling',
    idealRanges: ['medium', 'close'],
    cost: { fuel: 0, ammo: 4 },
    universal: true,
    requiredEquipmentType: null,
  },
  evade_maneuver: {
    id: 'evade_maneuver',
    label: '机动规避 / 调整站位',
    shortLabel: '机动规避',
    desc: '拉近交战距离并强化 2 回合全队闪避减伤',
    statKey: 'evasion',
    kind: 'maneuver',
    visualStyle: 'evade',
    tone: 'maneuver',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 5, ammo: 0 },
    universal: true,
    requiredEquipmentType: null,
  },
  field_repair: {
    id: 'field_repair',
    label: '紧急抢修',
    shortLabel: '紧急抢修',
    desc: '为 3×4 阵型内受伤队友恢复耐久（维修舰施放额外 +25%）',
    statKey: 'recon',
    kind: 'support',
    visualStyle: 'repair',
    tone: 'support',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 2, ammo: 0 },
    requiredEquipmentType: 'support',
    requiredSupportRole: 'repair',
    requiredHint: '需装备抢修支援',
  },
  frontline_resupply: {
    id: 'frontline_resupply',
    label: '前线补给',
    shortLabel: '前线补给',
    desc: '恢复随舰携带弹药/燃油并提升全队士气（单次出征限用 2 次）',
    statKey: 'recon',
    kind: 'support',
    visualStyle: 'resupply',
    tone: 'support',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 0, ammo: 0 },
    requiredEquipmentType: 'support',
    requiredSupportRole: 'supply',
    requiredHint: '需装备补给支援',
  },
  main_salvo: {
    id: 'main_salvo',
    label: '主炮齐射',
    shortLabel: '主炮齐射',
    desc: '高穿甲远程火力打击（无视 35% 有效装甲，远/中距全威）',
    statKey: 'firepower',
    kind: 'attack',
    visualStyle: 'shelling',
    tone: 'shelling',
    idealRanges: ['long', 'medium'],
    cost: { fuel: 0, ammo: 10 },
    requiredEquipmentType: 'main_gun',
    requiredHint: '需装备主炮',
  },
  torpedo_strike: {
    id: 'torpedo_strike',
    label: '鱼雷突击',
    shortLabel: '鱼雷突击',
    desc: '中近距离高爆发雷击（无视 40% 有效装甲，近距额外 +28%）',
    statKey: 'torpedo',
    kind: 'attack',
    visualStyle: 'torpedo',
    tone: 'torpedo',
    idealRanges: ['close', 'medium'],
    cost: { fuel: 0, ammo: 9 },
    requiredEquipmentType: 'torpedo',
    requiredHint: '需装备鱼雷',
  },
  carrier_airstrike: {
    id: 'carrier_airstrike',
    label: '舰载机空袭',
    shortLabel: '舰载机空袭',
    desc: '无视前后排距离衰减的全图打击（受敌方防空削减）',
    statKey: 'firepower',
    kind: 'attack',
    visualStyle: 'airstrike',
    tone: 'airstrike',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 4, ammo: 9 },
    requiredEquipmentType: 'aircraft',
    requiredHint: '需装备舰载机',
  },
  aa_alert: {
    id: 'aa_alert',
    label: '防空警戒网',
    shortLabel: '防空警戒网',
    desc: '2 回合内为自身及相邻格子队友提供高额防空减伤护盾',
    statKey: 'aa',
    kind: 'support',
    visualStyle: 'aa',
    tone: 'support',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 0, ammo: 5 },
    requiredEquipmentType: 'aa_gun',
    requiredHint: '需装备防空',
  },
  radar_scan: {
    id: 'radar_scan',
    label: '雷达校射扫描',
    shortLabel: '雷达扫描',
    desc: '揭露敌舰意图弱点并大幅提升全队命中（d20 锁定 +3）',
    statKey: 'recon',
    kind: 'recon',
    visualStyle: 'scan',
    tone: 'scan',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 3, ammo: 0 },
    requiredEquipmentType: 'radar',
    requiredHint: '需装备雷达',
  },
  depth_asw: {
    id: 'depth_asw',
    label: '声呐深弹反潜',
    shortLabel: '声呐反潜',
    desc: '锁定并重创水下潜艇/隐蔽目标，压制敌方先制伏击',
    statKey: 'asw',
    kind: 'attack',
    visualStyle: 'asw',
    tone: 'scan',
    idealRanges: ['close', 'medium'],
    cost: { fuel: 0, ammo: 5 },
    requiredEquipmentType: 'sonar',
    requiredHint: '需装备声呐',
  },
  // Legacy action aliases preserved for 100% backward compatibility with existing scripts/tests
  smoke_screen: {
    id: 'smoke_screen',
    label: '释放烟幕',
    shortLabel: '释放烟幕',
    desc: '全队展开烟幕屏障，2 回合内大幅提升闪避与减伤',
    statKey: 'evasion',
    kind: 'support',
    visualStyle: 'smoke',
    tone: 'support',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 5, ammo: 0 },
  },
  full_ahead: {
    id: 'full_ahead',
    label: '全速突进',
    shortLabel: '全速突进',
    desc: '拉近交战距离（远→中→近）并提升自身机动闪避',
    statKey: 'evasion',
    kind: 'maneuver',
    visualStyle: 'advance',
    tone: 'maneuver',
    idealRanges: ['long', 'medium'],
    cost: { fuel: 6, ammo: 0 },
  },
  tactical_shelling: {
    id: 'tactical_shelling',
    label: '战术炮击',
    shortLabel: '战术炮击',
    desc: '均衡精准炮击，对常规水面目标稳定输出',
    statKey: 'firepower',
    kind: 'attack',
    visualStyle: 'shelling',
    tone: 'shelling',
    idealRanges: ['medium', 'close'],
    cost: { fuel: 0, ammo: 7 },
  },
  heavy_shelling: {
    id: 'heavy_shelling',
    label: '重炮射击',
    shortLabel: '重炮射击',
    desc: '高威力重巡主炮射击，中近距穿甲稳定打击',
    statKey: 'firepower',
    kind: 'attack',
    visualStyle: 'shelling',
    tone: 'shelling',
    idealRanges: ['medium', 'long'],
    cost: { fuel: 0, ammo: 8 },
  },
  vanguard_guard: {
    id: 'vanguard_guard',
    label: '前排援护',
    shortLabel: '前排援护',
    desc: '2 回合内为低血量队友构筑护盾分担 55% 伤害',
    statKey: 'armor',
    kind: 'support',
    visualStyle: 'guard',
    tone: 'support',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 3, ammo: 0 },
  },
  fire_suppress: {
    id: 'fire_suppress',
    label: '火力压制',
    shortLabel: '火力压制',
    desc: '重炮覆盖射击并大幅降低敌方下回合命中与火力',
    statKey: 'firepower',
    kind: 'attack',
    visualStyle: 'shelling',
    tone: 'support',
    idealRanges: ['long', 'medium'],
    cost: { fuel: 0, ammo: 10 },
  },
  carrier_recon: {
    id: 'carrier_recon',
    label: '舰载侦察',
    shortLabel: '舰载侦察',
    desc: '大范围揭露全部敌舰情报并提升全队命中修正',
    statKey: 'recon',
    kind: 'recon',
    visualStyle: 'scan',
    tone: 'scan',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 3, ammo: 0 },
  },
  evade_retreat: {
    id: 'evade_retreat',
    label: '机动迂回/撤退',
    shortLabel: '迂回/撤退',
    desc: '尝试全队机动回避并提升闪避',
    statKey: 'evasion',
    kind: 'maneuver',
    visualStyle: 'evade',
    tone: 'maneuver',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 6, ammo: 0 },
    universal: true,
  },
});

export const GEAR_DRIVEN_ACTION_ORDER = Object.freeze([
  'field_repair',
  'frontline_resupply',
  'main_salvo',
  'torpedo_strike',
  'carrier_airstrike',
  'aa_alert',
  'radar_scan',
  'depth_asw',
  'basic_fire',
  'evade_maneuver',
]);

export const SHIP_CLASS_EXCLUSIVE_ACTIONS = Object.freeze({
  DD: ['torpedo_strike', 'depth_asw', 'smoke_screen', 'full_ahead'],
  SS: ['torpedo_strike', 'evade_maneuver'],
  CL: ['tactical_shelling', 'torpedo_strike', 'aa_alert', 'radar_scan'],
  CA: ['heavy_shelling', 'vanguard_guard', 'full_ahead'],
  BB: ['main_salvo', 'fire_suppress'],
  CV: ['carrier_airstrike', 'carrier_recon'],
  AR: ['field_repair', 'aa_alert', 'basic_fire'],
  AO: ['frontline_resupply', 'aa_alert', 'basic_fire'],
});

/**
 * Determine whether a support equipment item provides 'repair' (紧急抢修), 'supply' (前线补给), or 'both'.
 */
export function inferSupportRole(item = null) {
  if (!item || typeof item !== 'object') return null;
  const eqType = inferEquipmentTypeId(item, null);
  if (eqType !== KNOWN_EQUIPMENT_TYPES.SUPPORT) return null;
  if (item.supportRole === 'repair' || item.supportRole === 'supply' || item.supportRole === 'both') {
    return item.supportRole;
  }
  const text = `${item.name || ''} ${(item.tags || []).join(' ')} ${item.description || ''} ${item.iconKey || ''}`.toLowerCase();
  const isRepair = /(抢修|维修|损管|修复|吊舱|起重|焊|repair|damage_control|crane)/.test(text);
  const isSupply = /(补给|油弹|弹药箱|油槽|输油|粮|supply|ration|oiler|resupply)/.test(text);
  if (isRepair && isSupply) return 'both';
  if (isSupply) return 'supply';
  return 'repair';
}

/**
 * Build the Equipment-Driven Tactical Command list for a shipgirl based strictly on her currently equipped items:
 *   - Universal basic commands (`basic_fire`, `evade_maneuver`) are ALWAYS unlocked.
 *   - Specialized commands (`field_repair`, `frontline_resupply`, `main_salvo`, `torpedo_strike`,
 *     `carrier_airstrike`, `aa_alert`, `radar_scan`, `depth_asw`) are unlocked ONLY when wearing
 *     matching equipment.
 */
export function getGearDrivenTacticalActions(
  equippedItems = [],
  { phase = 'day', resupplyUsesRemaining = 2 } = {}
) {
  const wornTypes = new Set();
  const wornSupportRoles = new Set();
  const list = Array.isArray(equippedItems) ? equippedItems : Object.values(equippedItems || {});
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.category === 'consumable' || item.category === 'outfit') continue;
    const eqType = inferEquipmentTypeId(item, null);
    if (eqType) {
      wornTypes.add(eqType);
      if (eqType === KNOWN_EQUIPMENT_TYPES.SUPPORT) {
        const role = inferSupportRole(item);
        if (role === 'both') {
          wornSupportRoles.add('repair');
          wornSupportRoles.add('supply');
        } else if (role) {
          wornSupportRoles.add(role);
        }
      }
    }
  }

  const actions = GEAR_DRIVEN_ACTION_ORDER.map((id) => {
    const base = TACTICAL_ACTION_DEFS[id];
    const reqType = base.requiredEquipmentType || null;
    let unlocked = !reqType || wornTypes.has(reqType);
    let requiredHint = unlocked ? null : base.requiredHint || '需装备对应武器';

    if (reqType === KNOWN_EQUIPMENT_TYPES.SUPPORT && base.requiredSupportRole) {
      unlocked = wornSupportRoles.has(base.requiredSupportRole);
      requiredHint = unlocked ? null : base.requiredHint;
    }

    let label = base.label;
    let desc = base.desc;
    if (id === 'frontline_resupply') {
      const rem = Math.max(0, Math.floor(Number(resupplyUsesRemaining ?? 2)));
      label = `前线补给 (${rem}/2)`;
      if (unlocked && rem <= 0) {
        unlocked = false;
        requiredHint = '本次出征次数已用尽';
      }
    } else if (phase === 'night' && id === 'torpedo_strike') {
      label = '夜战鱼雷突击';
      desc = '夜战核心爆发！中近距雷击伤害 +35%、暴击修正 +2';
    } else if (phase === 'night' && id === 'carrier_airstrike') {
      label = '夜间舰载空袭';
      desc = '无视前后排距离衰减的夜间航空突击（威力略降）';
    }
    return {
      ...base,
      label,
      desc,
      unlocked,
      requiredTypeId: reqType,
      requiredHint,
    };
  });

  const unlockedGear = actions.filter((a) => !a.universal && a.unlocked);
  const basics = actions.filter((a) => a.universal);
  const lockedGear = actions.filter((a) => !a.universal && !a.unlocked);
  return [...unlockedGear, ...basics, ...lockedGear];
}

/**
 * Backward-compatible class-based helper.
 */
export function getShipClassTacticalActions(
  shipType = '',
  { includeUniversal = true, phase = 'day', equippedItems = null, resupplyUsesRemaining = 2 } = {}
) {
  if (equippedItems !== null && equippedItems !== undefined) {
    return getGearDrivenTacticalActions(equippedItems, { phase, resupplyUsesRemaining });
  }
  const code = resolveShipClass(shipType);
  const ids = [...(SHIP_CLASS_EXCLUSIVE_ACTIONS[code] || SHIP_CLASS_EXCLUSIVE_ACTIONS.CL)];
  if (includeUniversal) {
    ids.push('evade_maneuver');
  }
  return ids
    .map((id) => TACTICAL_ACTION_DEFS[id])
    .filter(Boolean)
    .map((def) => ({ ...def, unlocked: true }));
}

/**
 * Pure-vector geometric SVG emblem for each ship class (zero external image dependencies).
 */
export function getShipClassSvg(shipType = '', { size = 18 } = {}) {
  const prof = getShipClassProfile(shipType);
  const c = prof.color;
  const s = Math.max(12, Number(size) || 18);
  if (prof.code === 'DD') {
    return `<svg class="ship-class-ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 3 19 19 12 15 5 19 12 3" fill="${c}" fill-opacity="0.18"/><path d="M12 7v8"/></svg>`;
  }
  if (prof.code === 'CL') {
    return `<svg class="ship-class-ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 21 12 12 22 3 12 12 2" fill="${c}" fill-opacity="0.18"/><circle cx="12" cy="12" r="3"/></svg>`;
  }
  if (prof.code === 'CA') {
    return `<svg class="ship-class-ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 20 7v6c0 4.5-3.4 7.5-8 9-4.6-1.5-8-4.5-8-9V7l8-4Z" fill="${c}" fill-opacity="0.18"/><path d="M8.5 11.5h7M12 8v7"/></svg>`;
  }
  if (prof.code === 'BB') {
    return `<svg class="ship-class-ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 21 7 21 17 12 22 3 17 3 7 12 2" fill="${c}" fill-opacity="0.2"/><path d="M8 9h8M7 13h10M9 17h6"/></svg>`;
  }
  if (prof.code === 'SS') {
    return `<svg class="ship-class-ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="14" rx="7.5" ry="3.8" fill="${c}" fill-opacity="0.2"/><path d="M12 10V6.5h2.5"/></svg>`;
  }
  if (prof.code === 'AR') {
    return `<svg class="ship-class-ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="${c}" fill-opacity="0.18"/><path d="M12 8v8M8 12h8"/></svg>`;
  }
  if (prof.code === 'AO') {
    return `<svg class="ship-class-ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7Z" fill="${c}" fill-opacity="0.18"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M9 13h6"/></svg>`;
  }
  // CV
  return `<svg class="ship-class-ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 21 17h-6l-3-4-3 4H3L12 3Z" fill="${c}" fill-opacity="0.2"/><path d="M7 20h10"/></svg>`;
}

export const GRID_ROWS = 3;
export const GRID_COLS = 4;
export const GRID_TOTAL_CELLS = GRID_ROWS * GRID_COLS;
export const GRID_ROW_LABELS = Object.freeze(['前排', '中排', '后排']);

/**
 * High-contrast minimalist tactical geometric SVG symbol for the 3x4 naval radar grid.
 * Supports DD, CL, CA, BB, CV, SS, AR (repair cross-crest), AO (supply canister), and BOSS.
 */
export function getTacticalGridSymbolSvg(shipTypeOrClass = '', { side = 'ally', size = 26 } = {}) {
  const raw = String(shipTypeOrClass || '').trim().toUpperCase();
  const code =
    raw === 'BOSS' || raw === 'SS' || raw === 'DD' || raw === 'CL' || raw === 'CA' || raw === 'BB' || raw === 'CV' || raw === 'AR' || raw === 'AO'
      ? raw
      : resolveShipClass(shipTypeOrClass);
  const s = Math.max(16, Number(size) || 26);
  const isEnemy = side === 'enemy';

  const palette = isEnemy
    ? {
        DD: '#fb7185',
        CL: '#fb923c',
        CA: '#f59e0b',
        BB: '#ef4444',
        CV: '#e879f9',
        SS: '#22d3ee',
        AR: '#34d399',
        AO: '#facc15',
        BOSS: '#f43f5e',
      }
    : {
        DD: '#38bdf8',
        CL: '#2dd4bf',
        CA: '#fbbf24',
        BB: '#f97316',
        CV: '#c084fc',
        SS: '#06b6d4',
        AR: '#34d399',
        AO: '#facc15',
        BOSS: '#34d399',
      };
  const c = palette[code] || (isEnemy ? '#fb7185' : '#38bdf8');
  const fillOpacity = isEnemy ? '0.24' : '0.22';

  if (code === 'DD') {
    const pts = isEnemy ? '12 22 4 4 12 8 20 4' : '12 2 20 20 12 16 4 20';
    return `<svg class="grid-sym-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="${pts}" fill="${c}" fill-opacity="${fillOpacity}"/></svg>`;
  }
  if (code === 'CL') {
    return `<svg class="grid-sym-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 21 12 12 22 3 12" fill="${c}" fill-opacity="${fillOpacity}"/><circle cx="12" cy="12" r="2.6" fill="${c}"/></svg>`;
  }
  if (code === 'CA') {
    return `<svg class="grid-sym-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 20 6v6.5c0 4.5-3.4 7.6-8 9-4.6-1.4-8-4.5-8-9V6l8-3.5Z" fill="${c}" fill-opacity="${fillOpacity}"/><path d="M8.5 11.5h7M12 8v7"/></svg>`;
  }
  if (code === 'BB') {
    const barrelY1 = isEnemy ? 16 : 8;
    const barrelY2 = isEnemy ? 22 : 2;
    return `<svg class="grid-sym-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="7.5" width="15" height="9" rx="2.5" fill="${c}" fill-opacity="${fillOpacity}"/><line x1="9" y1="${barrelY1}" x2="9" y2="${barrelY2}"/><line x1="15" y1="${barrelY1}" x2="15" y2="${barrelY2}"/><line x1="7.5" y1="12" x2="16.5" y2="12"/></svg>`;
  }
  if (code === 'CV') {
    return `<svg class="grid-sym-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 18 3 21 21 9 21" fill="${c}" fill-opacity="${fillOpacity}"/><line x1="11" y1="6" x2="15" y2="18" stroke-dasharray="3 2.5"/><line x1="17" y1="9" x2="19.5" y2="9"/></svg>`;
  }
  if (code === 'SS') {
    return `<svg class="grid-sym-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="14" rx="7.5" ry="3.8" fill="${c}" fill-opacity="${fillOpacity}"/><path d="M12 10V6.5h2.5"/><path d="M6.5 6.5a8 8 0 0 1 11 0" stroke-width="1.6" stroke-dasharray="2.5 2"/></svg>`;
  }
  if (code === 'AR') {
    // Repair Ship: Tactical cross inside rounded octagon
    return `<svg class="grid-sym-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill="${c}" fill-opacity="${fillOpacity}"/><path d="M12 7.5v9M7.5 12h9" stroke-width="2.5"/></svg>`;
  }
  if (code === 'AO') {
    // Supply Ship: Fuel/Ammo logistics tank emblem
    return `<svg class="grid-sym-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7.5h14v10a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 17.5v-10Z" fill="${c}" fill-opacity="${fillOpacity}"/><path d="M8.5 7.5V5a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 15.5 5v2.5"/><path d="M9 13h6M12 10.5v5"/></svg>`;
  }
  return `<svg class="grid-sym-svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 21 7 21 17 12 22 3 17 3 7" fill="${c}" fill-opacity="0.28"/><polygon points="12 6.5 16.5 12 12 17.5 7.5 12" fill="${c}" fill-opacity="0.55"/></svg>`;
}

/**
 * 1★ ~ 5★ Symmetric Sea Tier Standards (Enemies use the exact same 2-digit..3-digit curve as Allies).
 */
export const STAR_SEA_TIERS = Object.freeze({
  star_1: {
    id: 'star_1',
    star: 1,
    starLevel: 1,
    code: '1★',
    name: '近海警戒区',
    label: '1★ 近海警戒区',
    stepCost: { fuel: 12, ammo: 10 },
    atkRange: [15, 28],
    enemyAtk: [15, 28],
    accRange: [15, 28],
    evaRange: [15, 28],
    armorRange: [8, 18],
    enemyArmor: [8, 18],
    hpRange: [25, 45],
    enemyHp: [25, 45],
    bossCap: 28,
    bossMaxAtk: 28,
    bossGainPct: 35,
    expeditionYieldBonusPct: 8,
    patrolYieldBonusPct: 10,
    lootScale: 1.0,
    goldBonus: 3,
  },
  star_2: {
    id: 'star_2',
    star: 2,
    starLevel: 2,
    code: '2★',
    name: '外海巡航道',
    label: '2★ 外海巡航道',
    stepCost: { fuel: 16, ammo: 14 },
    atkRange: [30, 48],
    enemyAtk: [30, 48],
    accRange: [30, 48],
    evaRange: [30, 48],
    armorRange: [18, 32],
    enemyArmor: [18, 32],
    hpRange: [45, 75],
    enemyHp: [45, 75],
    bossCap: 48,
    bossMaxAtk: 48,
    bossGainPct: 34,
    expeditionYieldBonusPct: 12,
    patrolYieldBonusPct: 15,
    lootScale: 1.35,
    goldBonus: 4,
  },
  star_3: {
    id: 'star_3',
    star: 3,
    starLevel: 3,
    code: '3★',
    name: '岛链破交线',
    label: '3★ 岛链破交线',
    stepCost: { fuel: 20, ammo: 18 },
    atkRange: [50, 72],
    enemyAtk: [50, 72],
    accRange: [50, 72],
    evaRange: [50, 72],
    armorRange: [32, 50],
    enemyArmor: [32, 50],
    hpRange: [70, 110],
    enemyHp: [70, 110],
    bossCap: 72,
    bossMaxAtk: 72,
    bossGainPct: 28,
    expeditionYieldBonusPct: 18,
    patrolYieldBonusPct: 22,
    lootScale: 1.75,
    goldBonus: 6,
  },
  star_4: {
    id: 'star_4',
    star: 4,
    starLevel: 4,
    code: '4★',
    name: '深海前沿域',
    label: '4★ 深海前沿域',
    stepCost: { fuel: 26, ammo: 22 },
    atkRange: [75, 98],
    enemyAtk: [75, 98],
    accRange: [75, 98],
    evaRange: [75, 98],
    armorRange: [50, 72],
    enemyArmor: [50, 72],
    hpRange: [105, 155],
    enemyHp: [105, 155],
    bossCap: 98,
    bossMaxAtk: 98,
    bossGainPct: 25,
    expeditionYieldBonusPct: 24,
    patrolYieldBonusPct: 30,
    lootScale: 2.25,
    goldBonus: 8,
  },
  star_5: {
    id: 'star_5',
    star: 5,
    starLevel: 5,
    code: '5★',
    name: '深海要塞核心',
    label: '5★ 深海要塞核心',
    stepCost: { fuel: 32, ammo: 28 },
    atkRange: [100, 135],
    enemyAtk: [100, 135],
    accRange: [100, 135],
    evaRange: [100, 135],
    armorRange: [75, 105],
    enemyArmor: [75, 105],
    hpRange: [150, 240],
    enemyHp: [150, 240],
    bossCap: 150,
    bossMaxAtk: 150,
    bossGainPct: 25,
    expeditionYieldBonusPct: 35,
    patrolYieldBonusPct: 45,
    lootScale: 3.0,
    goldBonus: 12,
  },
});

export const STAR_SEA_TIER_ORDER = Object.freeze(['star_1', 'star_2', 'star_3', 'star_4', 'star_5']);

export function normalizeStarTierId(raw = 'star_1') {
  const s = String(raw || '').trim().toLowerCase();
  if (STAR_SEA_TIERS[s]) return s;
  if (s === 'low' || s === '1' || s === '1★' || s === '1-1') return 'star_1';
  if (s === 'medium' || s === '2' || s === '2★' || s === '2-1') return 'star_2';
  if (s === 'high' || s === '3' || s === '3★' || s === '3-1') return 'star_3';
  if (s === '4' || s === '4★' || s === '4-1') return 'star_4';
  if (s === '5' || s === '5★' || s === '5-1') return 'star_5';
  return 'star_1';
}

/**
 * d20 Focused Combat Resolution (Hit / Graze / Crit):
 *   modifier = clamp(Math.round((accuracy - evasion) / 8), -5, 7) + Math.floor(commanderLuck / 5) + extraMod
 *   Roll 1d20 + modifier:
 *     - naturalRoll === 1               -> Graze (0.4x guaranteed chip damage)
 *     - naturalRoll === 20 || total>=19 -> Critical Hit (1.5x damage)
 *     - total >= 11                     -> Normal Hit (1.0x damage)
 *     - total < 11                      -> Graze (0.4x chip damage)
 */
/**
 * Derived Evasion (`闪避`) calculated from Mobility (`机动`) + Lightweight Ship-Class Agility Correction.
 * Keeps 2-digit baseline while allowing DD/SS (and CL) vanguards to evade incoming fire reliably.
 */
export function computeDerivedEvasion(mobility = 18, shipType = 'CL') {
  const mob = Math.max(4, Number(mobility) || 16);
  const cls = resolveShipClass(shipType);
  let mult = 1.0;
  let flatBonus = 0;
  let agilityTag = '标准机动';
  if (cls === 'DD' || cls === 'SS') {
    mult = 1.25;
    flatBonus = 6;
    agilityTag = cls === 'DD' ? '轻量化高闪避 (DD)' : '水下高机动 (SS)';
  } else if (cls === 'CL') {
    mult = 1.12;
    flatBonus = 3;
    agilityTag = '中幅轻盈闪避 (CL)';
  } else if (cls === 'BB' || cls === 'BOSS') {
    mult = 0.88;
    flatBonus = 0;
    agilityTag = '重型低闪避';
  }
  const dodgeValue = clamp(Math.round(mob * mult + flatBonus), 6, 120);
  return {
    mobility: Math.round(mob),
    dodgeValue,
    shipClass: cls,
    agilityBonus: dodgeValue - Math.round(mob),
    agilityTag,
  };
}

/**
 * Compute Radar Fire-Control Lock-On profile from equipped items:
 * Radar gear ignores a percentage of target derived evasion and provides bonus accuracy.
 */
export function computeRadarLockProfile(equippedMapOrList = []) {
  const items = Array.isArray(equippedMapOrList)
    ? equippedMapOrList.filter(Boolean)
    : Object.values(equippedMapOrList || {}).filter(Boolean);
  let radarCount = 0;
  let ignorePct = 0;
  let accBonus = 0;
  let aaBonus = 0;
  for (const it of items) {
    const eqType = inferEquipmentTypeId(it, '');
    const tags = Array.isArray(it.tags) ? it.tags.join(' ') : '';
    const nameStr = String(it.name || '');
    const isRadar = eqType === KNOWN_EQUIPMENT_TYPES.RADAR || /雷达|电探|火控/.test(nameStr + tags);
    if (isRadar) {
      radarCount += 1;
      const rId = inferItemRarity(it);
      const baseIgnore =
        rId === 'legendary' ? 0.36 : rId === 'epic' ? 0.3 : rId === 'rare' ? 0.25 : 0.2;
      ignorePct += baseIgnore + Math.min(0.08, (Number(it.level) || 0) * 0.008);
      accBonus += 2 + Math.floor((Number(it.level) || 0) / 3);
      if (/对空|防空|相控/.test(nameStr + tags)) {
        aaBonus += 6 + Math.round((Number(it.level) || 0) * 0.6);
      }
    }
  }
  return {
    hasRadar: radarCount > 0,
    radarCount,
    evasionIgnorePct: Number(clamp(ignorePct, 0, 0.55).toFixed(3)),
    accBonus,
    aaBonus,
  };
}

/**
 * Determine whether a unit can detect and attack submerged Submarines (SS):
 * True for DD, CL, CVL, or any unit wearing ASW equipment (sonar / depth charge / ASW aircraft).
 * False for BB, CA, AR, AO, and standard CV without ASW gear.
 */
export function hasUnitAswCapability(shipType = '', equippedMapOrList = [], explicitFlag = false) {
  if (explicitFlag) return true;
  const rawType = String(shipType || '');
  const cls = resolveShipClass(rawType);
  if (cls === 'DD' || cls === 'CL' || /轻母|轻航|CVL|护航航母/i.test(rawType)) {
    return true;
  }
  const items = Array.isArray(equippedMapOrList)
    ? equippedMapOrList.filter(Boolean)
    : Object.values(equippedMapOrList || {}).filter(Boolean);
  for (const it of items) {
    const eqType = inferEquipmentTypeId(it, '');
    const text = `${it.name || ''} ${(Array.isArray(it.tags) ? it.tags.join(' ') : '')} ${it.description || ''}`;
    if (eqType === KNOWN_EQUIPMENT_TYPES.SONAR || /声呐|深水炸弹|深弹|反潜|水听/.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Enhanced Symmetric 1d20 Combat Roll:
 *   - Supports both `{ accuracy, evasion }` and `{ attackerAcc, defenderEva }`
 *   - Applies Radar Fire-Control Lock-On (`radarIgnorePct`) to penetrate target evasion
 *   - Higher sensitivity to accuracy vs evasion difference (`round((acc - effEva) / 5)`)
 *   - Immediate per-point Commander Luck bonus (`luckCheckBonus` / `commanderLuck * 0.25`) + crit shift
 *   - Triggers 「高速规避」 extra damage reduction (`rollMult = 0.25`) when a high-evasion unit is grazed
 */
export function resolveD20CombatRoll({
  accuracy = undefined,
  evasion = undefined,
  attackerAcc = undefined,
  defenderEva = undefined,
  radarIgnorePct = 0,
  commanderLuck = 0,
  extraMod = 0,
  rng = Math.random,
} = {}) {
  const acc = Number(accuracy ?? attackerAcc ?? 20) || 0;
  const rawEva = Math.max(0, Number(evasion ?? defenderEva ?? 20) || 0);
  const penPct = clamp(Number(radarIgnorePct) || 0, 0, 0.75);
  const effEva = Math.max(0, Math.round(rawEva * (1 - penPct)));
  const radarIgnoredEvasion = Math.max(0, Math.round(rawEva - effEva));

  // Higher evasion difference sensitivity (/ 5 instead of / 8) so lightweight vanguards reliably dodge
  const baseDiffMod = clamp(Math.round((acc - effEva) / 5), -7, 7);
  const lk = Number(commanderLuck) || 0;
  const luckMod = Math.round(lk * 0.25);
  const critShift = lk >= 8 ? Math.min(3, Math.floor(lk / 8)) : 0;
  const bonusMod = Math.round(Number(extraMod) || 0);
  const modifier = baseDiffMod + luckMod + bonusMod;
  const naturalRoll = clamp(Math.floor(rng() * 20) + 1, 1, 20);
  const total = naturalRoll + modifier;

  let outcome = 'graze';
  let outcomeLabel = '擦伤';
  let rollMult = 0.4;
  let isCrit = false;
  let isHit = false;
  let highSpeedDodge = false;

  if (naturalRoll === 1) {
    outcome = 'graze';
    outcomeLabel = effEva >= 26 ? '高速规避(1)' : '擦伤(1)';
    rollMult = effEva >= 26 ? 0.25 : 0.4;
    highSpeedDodge = effEva >= 26;
  } else if (naturalRoll >= 20 - critShift || total >= 19) {
    outcome = 'crit';
    outcomeLabel = '要害暴击';
    rollMult = 1.5;
    isCrit = true;
    isHit = true;
  } else if (total >= 11) {
    outcome = 'hit';
    outcomeLabel = '命中';
    rollMult = 1.0;
    isHit = true;
  } else {
    outcome = 'graze';
    if (effEva >= 26) {
      highSpeedDodge = true;
      outcomeLabel = '高速规避';
      rollMult = 0.25;
    } else {
      outcomeLabel = '擦伤';
      rollMult = 0.4;
    }
  }

  return {
    naturalRoll,
    die: naturalRoll,
    baseDiffMod,
    luckMod,
    extraMod: bonusMod,
    modifier,
    total,
    outcome,
    tier: outcome,
    outcomeLabel,
    tierLabel: outcomeLabel,
    rollMult,
    isCrit,
    isHit,
    highSpeedDodge,
    rawEvasion: Math.round(rawEva),
    effectiveEvasion: effEva,
    radarIgnoredEvasion,
    formulaText: `1d20(${naturalRoll}) ${modifier >= 0 ? `+ ${modifier}` : `- ${Math.abs(modifier)}`} = ${total}`,
  };
}

/**
 * Symmetric Smooth Armor Mitigation Formula (shared identically by Allies & Enemies):
 *   actualDamage = Math.max(1, Math.round(effectiveAttack * (50 / (50 + effectiveArmor)) * skillMult * rangeMult * rollMult))
 */
export function computeSymmetricDamage({
  attack = 20,
  armor = 10,
  armorPen = 0,
  skillMult = 1.0,
  rangeMult = 1.0,
  rollMult = 1.0,
} = {}) {
  const effAttack = Math.max(1, Number(attack) || 1);
  const pen = clamp(Number(armorPen) || 0, 0, 0.85);
  const effArmor = Math.max(0, (Number(armor) || 0) * (1 - pen));
  const armorFactor = 50 / (50 + effArmor);
  const raw = effAttack * armorFactor * (Number(skillMult) || 1) * (Number(rangeMult) || 1) * (Number(rollMult) || 1);
  return {
    damage: Math.max(1, Math.round(raw)),
    effectiveArmor: Number(effArmor.toFixed(1)),
    armorFactor: Number(armorFactor.toFixed(3)),
  };
}

/**
 * Free all-grid targeting with Engagement Range (long/medium/close) + Row Distance (0..4)
 * dynamic accuracy & damage decay formula.
 */
export function computeRangeRowCombatModifiers({
  engagementRange = 'long',
  attackerRow = 0,
  defenderRow = 0,
  actionId = 'basic_fire',
  shipClass = 'CL',
} = {}) {
  const aRow = clamp(Math.floor(Number(attackerRow) || 0), 0, 2);
  const dRow = clamp(Math.floor(Number(defenderRow) || 0), 0, 2);
  const baseDist = engagementRange === 'close' ? 0 : engagementRange === 'medium' ? 1 : 2;
  const rowSpan = aRow + dRow;
  const effectiveDist = baseDist + rowSpan;
  const cls = String(shipClass || 'CL').toUpperCase();
  const act = String(actionId || '');

  const isAirstrikeFullMap = act === 'carrier_airstrike' || act === 'airstrike';
  if (isAirstrikeFullMap) {
    return { effectiveDist, rowSpan, dmgMult: 1.0, hitMod: 1, label: '全图空袭无视衰减', tone: 'ok' };
  }

  const isUltraLong =
    act === 'main_salvo' ||
    act === 'fire_suppress' ||
    act === 'salvo' ||
    cls === 'BB' ||
    cls === 'BOSS';

  const isShortRange =
    act === 'torpedo_strike' ||
    act === 'depth_asw' ||
    act === 'torpedo_ambush' ||
    act === 'torpedo_salvo' ||
    (!isUltraLong && (cls === 'DD' || cls === 'SS'));

  if (isUltraLong) {
    if (effectiveDist >= 4) {
      return { effectiveDist, rowSpan, dmgMult: 1.15, hitMod: 1, label: '超远射程全威', tone: 'ok' };
    }
    if (effectiveDist >= 2) {
      return { effectiveDist, rowSpan, dmgMult: 1.06, hitMod: 1, label: '远中程稳定压制', tone: 'ok' };
    }
    if (effectiveDist === 1) {
      return { effectiveDist, rowSpan, dmgMult: 1.0, hitMod: 0, label: '常规射程', tone: 'muted' };
    }
    return { effectiveDist, rowSpan, dmgMult: 0.92, hitMod: -1, label: '过近贴身微降', tone: 'warn' };
  }

  if (isShortRange) {
    if (effectiveDist === 0) {
      return { effectiveDist, rowSpan, dmgMult: 1.28, hitMod: 2, label: '前排贴脸全额爆发', tone: 'ok' };
    }
    if (effectiveDist === 1) {
      return { effectiveDist, rowSpan, dmgMult: 1.14, hitMod: 1, label: '近中距突击加成', tone: 'ok' };
    }
    if (effectiveDist === 2) {
      return { effectiveDist, rowSpan, dmgMult: 1.0, hitMod: 0, label: '标准交战射程', tone: 'muted' };
    }
    if (effectiveDist === 3) {
      return { effectiveDist, rowSpan, dmgMult: 0.84, hitMod: -1, label: '跨排射程衰减', tone: 'warn' };
    }
    if (effectiveDist === 4) {
      return { effectiveDist, rowSpan, dmgMult: 0.7, hitMod: -2, label: '远距跨排衰减 -30%', tone: 'danger' };
    }
    return { effectiveDist, rowSpan, dmgMult: 0.62, hitMod: -3, label: '超距衰减 -38%（建议突进）', tone: 'danger' };
  }

  if (effectiveDist <= 1) {
    return { effectiveDist, rowSpan, dmgMult: 1.06, hitMod: 1, label: '近中距精准火力', tone: 'ok' };
  }
  if (effectiveDist <= 3) {
    return { effectiveDist, rowSpan, dmgMult: 1.0, hitMod: 0, label: '中距标准射程', tone: 'ok' };
  }
  if (effectiveDist === 4) {
    return { effectiveDist, rowSpan, dmgMult: 0.88, hitMod: -1, label: '远距跨排衰减 -12%', tone: 'warn' };
  }
  return { effectiveDist, rowSpan, dmgMult: 0.78, hitMod: -2, label: '远距跨排衰减 -22%', tone: 'warn' };
}

/**
 * Compute real-time Aiming Preview metrics aligned 100% with the new d20 Combat Formula.
 */
export function computeTacticalAimPreview({
  engagementRange = 'long',
  attackerRow = 0,
  defenderRow = 0,
  actionId = 'basic_fire',
  shipClass = 'CL',
  attackerStat = 20,
  targetEvasion = 20,
  lockOnBonus = 0,
  commanderTactics = 0,
  commanderLuck = 0,
} = {}) {
  const mod = computeRangeRowCombatModifiers({
    engagementRange,
    attackerRow,
    defenderRow,
    actionId,
    shipClass,
  });
  const rangeLabel = engagementRange === 'close' ? '近距离' : engagementRange === 'medium' ? '中距离' : '远距离';
  const diffMod = clamp(Math.round(((Number(attackerStat) || 20) - (Number(targetEvasion) || 20)) / 8), -5, 7);
  const luckMod = Math.floor((Number(commanderLuck) || 0) / 5);
  const totalMod = diffMod + luckMod + (mod.hitMod || 0) + (Number(lockOnBonus) || 0) + Math.min(2, Math.floor((Number(commanderTactics) || 0) / 2));

  // Exact probability of 1d20 + totalMod >= 11 (with natural 1 always grazing)
  let hitFaces = 0;
  let critFaces = 0;
  for (let d = 1; d <= 20; d++) {
    if (d === 1) continue;
    if (d === 20 || d + totalMod >= 19) {
      critFaces += 1;
      hitFaces += 1;
    } else if (d + totalMod >= 11) {
      hitFaces += 1;
    }
  }
  const hitChancePct = Math.round((hitFaces / 20) * 100);
  const critChancePct = Math.round((critFaces / 20) * 100);
  const dmgMultPct = Math.round((mod.dmgMult || 1.0) * 100);
  const decayDelta = dmgMultPct - 100;
  const decayTag =
    decayDelta < 0
      ? `跨排衰减 ${decayDelta}%`
      : decayDelta > 0
      ? `${mod.label} +${decayDelta}%`
      : mod.label;

  return {
    ...mod,
    rangeLabel,
    d20Modifier: totalMod,
    hitChancePct,
    critChancePct,
    dmgMultPct,
    summaryText: `${rangeLabel} · d20${totalMod >= 0 ? `+${totalMod}` : totalMod} · 命中 ${hitChancePct}% / 暴击 ${critChancePct}% · ${decayTag}`,
  };
}

/**
 * Evaluate same-row & adjacent-cell (Chebyshev distance <= 1) CL/CA escort aura
 * for anti-air damage mitigation and cooperative vanguard damage sharing.
 */
export function getSameRowAndAdjacentAura(allies = [], targetUnit = null) {
  if (!targetUnit || !Array.isArray(allies)) {
    return { aaReduction: 0, aaProviders: [], guardian: null, guardShareRatio: 0 };
  }
  const tRow = Number(targetUnit.gridRow ?? 0);
  const tCol = Number(targetUnit.gridCol ?? 0);
  const aaProviders = [];
  let bestGuardian = null;
  let bestGuardScore = -1;

  for (const u of allies) {
    if (!u || !u.alive || u.id === targetUnit.id) continue;
    const cls = String(u.classCode || resolveShipClass(u.shipType)).toUpperCase();
    if (cls !== 'CL' && cls !== 'CA') continue;

    const uRow = Number(u.gridRow ?? 0);
    const uCol = Number(u.gridCol ?? 0);
    const sameRow = uRow === tRow;
    const adjacent = Math.abs(uRow - tRow) <= 1 && Math.abs(uCol - tCol) <= 1;
    if (!sameRow && !adjacent) continue;

    aaProviders.push({ id: u.id, name: u.name, classCode: cls, sameRow, adjacent });

    // CA / CL with healthy HP (> 30%) can intercept & share damage for teammates in same row / adjacent cell
    const hpRatio = Number(u.hp || 0) / Math.max(1, Number(u.maxHp || 100));
    if (hpRatio > 0.3) {
      const score = (cls === 'CA' ? 100 : 60) + (adjacent ? 25 : 10) + Number(u.armor || 0);
      if (score > bestGuardScore) {
        bestGuardScore = score;
        bestGuardian = u;
      }
    }
  }

  let aaReduction = 0;
  for (const p of aaProviders) {
    aaReduction += p.classCode === 'CL' ? (p.adjacent ? 0.14 : 0.1) : p.adjacent ? 0.1 : 0.07;
  }
  aaReduction = clamp(Number(aaReduction.toFixed(2)), 0, 0.34);

  const guardShareRatio = bestGuardian
    ? String(bestGuardian.classCode || resolveShipClass(bestGuardian.shipType)).toUpperCase() === 'CA'
      ? 0.4
      : 0.28
    : 0;

  return {
    aaReduction,
    aaProviders,
    guardian: bestGuardian,
    guardShareRatio,
  };
}

/**
 * Full 8 Naval Stats displayed on every Shipgirl Character Card
 * (maxHp is the survival durability ceiling; the other 7 are combat/utility stats).
 */
export const NAVAL_EIGHT_STAT_DEFS = Object.freeze([
  { key: 'maxHp', label: '耐久', shortLabel: '耐久', min: 20, max: 300, defaultValue: 90, isVital: true },
  { key: 'firepower', label: '火力', shortLabel: '火力', min: 1, max: 200, defaultValue: 55 },
  { key: 'armor', label: '装甲', shortLabel: '装甲', min: 1, max: 200, defaultValue: 45 },
  { key: 'torpedo', label: '雷击', shortLabel: '雷击', min: 0, max: 200, defaultValue: 50 },
  { key: 'evasion', label: '机动', shortLabel: '机动', min: 1, max: 200, defaultValue: 55 },
  { key: 'recon', label: '侦查', shortLabel: '侦查', min: 1, max: 200, defaultValue: 50 },
  { key: 'aa', label: '防空', shortLabel: '防空', min: 0, max: 200, defaultValue: 48 },
  { key: 'asw', label: '反潜', shortLabel: '反潜', min: 0, max: 200, defaultValue: 46 },
]);

/**
 * 7 Checkable Naval Combat Stats (exported as CORE_STAT_DEFS for backward compatibility with check UIs).
 */
export const CORE_STAT_DEFS = Object.freeze(
  NAVAL_EIGHT_STAT_DEFS.filter((d) => !d.isVital)
);

export const NAVAL_EIGHT_STAT_MAP = Object.freeze(
  Object.fromEntries(NAVAL_EIGHT_STAT_DEFS.map((d) => [d.key, d]))
);

export const CORE_STAT_MAP = Object.freeze(
  Object.fromEntries(CORE_STAT_DEFS.map((d) => [d.key, d]))
);

export const LEGACY_STAT_ALIASES = Object.freeze({
  attack: 'firepower',
  burst: 'torpedo',
  agility: 'evasion',
  tactics: 'recon',
});

export function normalizeStatKey(statKey) {
  const k = String(statKey || '').trim();
  return LEGACY_STAT_ALIASES[k] || k;
}

export const DYNAMIC_STAT_DEFS = Object.freeze([
  { key: 'hp', label: '生命/耐久', shortLabel: 'HP', defaultMax: 100 },
  { key: 'morale', label: '士气', shortLabel: '士气', defaultMax: 100 },
  { key: 'ap', label: '行动点', shortLabel: 'AP', defaultMax: 100 },
]);

export const AFFINITY_STAGES = Object.freeze([
  { stageIndex: 1, id: 'stranger', label: '初识', min: 0, max: 24, tone: 'muted' },
  { stageIndex: 2, id: 'familiar', label: '熟悉', min: 25, max: 49, tone: 'info' },
  { stageIndex: 3, id: 'trusted', label: '信赖', min: 50, max: 79, tone: 'ok' },
  { stageIndex: 4, id: 'close', label: '亲密', min: 80, max: 100, tone: 'accent' },
]);

export const DEFAULT_STAT_RULES_CONFIG = Object.freeze({
  statMin: 0,
  statMax: 200,
  statModifierStep: 10,        // Every 10 points gives +1 check modifier
  diceSides: 20,               // 1D20 standard check
  critSuccessNatural: 20,      // Natural roll >= 20 -> Critical Success
  critFailNatural: 1,          // Natural roll <= 1  -> Critical Failure
  critMarginThreshold: 10,     // Beat DC by >= 10 -> Critical Success; miss by >= 10 -> Critical Failure
  moraleHighThreshold: 80,
  moraleHighBonus: 2,
  moraleNormalThreshold: 50,
  moraleLowThreshold: 25,
  moraleLowPenalty: -1,
  moraleCriticalPenalty: -2,
  offlineRecoveryPerMin: {
    hp: 1.0,
    morale: 0.5,
    ap: 1.0,
  },
  scoreWeights: {
    maxHp: 0.7,
    firepower: 1.2,
    armor: 1.0,
    torpedo: 1.1,
    evasion: 1.0,
    recon: 1.0,
    aa: 0.9,
    asw: 0.9,
  },
  shipLevelMax: 100,
  shipExpBase: 100,
  shipExpStep: 50,
  shipGrowthPerLevel: {
    maxHp: 3,
    firepower: 1,
    armor: 1,
    torpedo: 1,
    evasion: 1,
    recon: 1,
    aa: 1,
    asw: 1,
  },
});

function formatSigned(n) {
  const v = Number(n) || 0;
  return v >= 0 ? `+${v}` : `${v}`;
}

export class StatRulesEngine {
  /**
   * @param {{
   *   storage?: import('./storage.js').StorageManager | null,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} [deps]
   */
  constructor({ storage = null, bus = null } = {}) {
    this._store = storage ? storage.namespace(STORAGE_NS) : null;
    this._bus = bus;
    this._config = this._loadConfig();
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  _sanitizeConfig(raw = {}) {
    const base = DEFAULT_STAT_RULES_CONFIG;
    const rec = raw.offlineRecoveryPerMin || {};
    const weights = raw.scoreWeights || {};
    const growth = raw.shipGrowthPerLevel || {};
    return {
      statMin: clamp(Number(raw.statMin ?? base.statMin), 0, 50),
      statMax: clamp(Number(raw.statMax ?? base.statMax), 20, 999),
      statModifierStep: clamp(Number(raw.statModifierStep ?? base.statModifierStep), 1, 50),
      diceSides: clamp(Math.floor(Number(raw.diceSides ?? base.diceSides)), 6, 100),
      critSuccessNatural: clamp(Math.floor(Number(raw.critSuccessNatural ?? base.critSuccessNatural)), 2, 100),
      critFailNatural: clamp(Math.floor(Number(raw.critFailNatural ?? base.critFailNatural)), 1, 10),
      critMarginThreshold: clamp(Math.floor(Number(raw.critMarginThreshold ?? base.critMarginThreshold)), 3, 50),
      moraleHighThreshold: clamp(Number(raw.moraleHighThreshold ?? base.moraleHighThreshold), 50, 100),
      moraleHighBonus: clamp(Number(raw.moraleHighBonus ?? base.moraleHighBonus), 0, 10),
      moraleNormalThreshold: clamp(Number(raw.moraleNormalThreshold ?? base.moraleNormalThreshold), 20, 80),
      moraleLowThreshold: clamp(Number(raw.moraleLowThreshold ?? base.moraleLowThreshold), 0, 60),
      moraleLowPenalty: clamp(Number(raw.moraleLowPenalty ?? base.moraleLowPenalty), -10, 0),
      moraleCriticalPenalty: clamp(Number(raw.moraleCriticalPenalty ?? base.moraleCriticalPenalty), -10, 0),
      offlineRecoveryPerMin: {
        hp: clamp(Number(rec.hp ?? base.offlineRecoveryPerMin.hp), 0, 100),
        morale: clamp(Number(rec.morale ?? base.offlineRecoveryPerMin.morale), 0, 100),
        ap: clamp(Number(rec.ap ?? base.offlineRecoveryPerMin.ap), 0, 100),
      },
      scoreWeights: {
        maxHp: clamp(Number(weights.maxHp ?? base.scoreWeights.maxHp), 0.1, 5),
        firepower: clamp(Number(weights.firepower ?? base.scoreWeights.firepower), 0.1, 5),
        armor: clamp(Number(weights.armor ?? base.scoreWeights.armor), 0.1, 5),
        torpedo: clamp(Number(weights.torpedo ?? base.scoreWeights.torpedo), 0.1, 5),
        evasion: clamp(Number(weights.evasion ?? base.scoreWeights.evasion), 0.1, 5),
        recon: clamp(Number(weights.recon ?? base.scoreWeights.recon), 0.1, 5),
        aa: clamp(Number(weights.aa ?? base.scoreWeights.aa), 0.1, 5),
        asw: clamp(Number(weights.asw ?? base.scoreWeights.asw), 0.1, 5),
      },
      shipLevelMax: clamp(Math.floor(Number(raw.shipLevelMax ?? base.shipLevelMax)), 10, 200),
      shipExpBase: clamp(Math.floor(Number(raw.shipExpBase ?? base.shipExpBase)), 10, 5000),
      shipExpStep: clamp(Math.floor(Number(raw.shipExpStep ?? base.shipExpStep)), 0, 2000),
      shipGrowthPerLevel: {
        maxHp: clamp(Number(growth.maxHp ?? base.shipGrowthPerLevel.maxHp), 0, 30),
        firepower: clamp(Number(growth.firepower ?? base.shipGrowthPerLevel.firepower), 0, 20),
        armor: clamp(Number(growth.armor ?? base.shipGrowthPerLevel.armor), 0, 20),
        torpedo: clamp(Number(growth.torpedo ?? base.shipGrowthPerLevel.torpedo), 0, 20),
        evasion: clamp(Number(growth.evasion ?? base.shipGrowthPerLevel.evasion), 0, 20),
        recon: clamp(Number(growth.recon ?? base.shipGrowthPerLevel.recon), 0, 20),
        aa: clamp(Number(growth.aa ?? base.shipGrowthPerLevel.aa), 0, 20),
        asw: clamp(Number(growth.asw ?? base.shipGrowthPerLevel.asw), 0, 20),
      },
    };
  }

  _loadConfig() {
    if (!this._store) return this._sanitizeConfig({});
    const saved = this._store.get(CONFIG_KEY, null);
    return this._sanitizeConfig(saved || {});
  }

  getConfig() {
    return JSON.parse(JSON.stringify(this._config));
  }

  updateConfig(partial = {}) {
    const merged = {
      ...this._config,
      ...partial,
      offlineRecoveryPerMin: {
        ...this._config.offlineRecoveryPerMin,
        ...(partial.offlineRecoveryPerMin || {}),
      },
      scoreWeights: {
        ...this._config.scoreWeights,
        ...(partial.scoreWeights || {}),
      },
      shipGrowthPerLevel: {
        ...this._config.shipGrowthPerLevel,
        ...(partial.shipGrowthPerLevel || {}),
      },
    };
    this._config = this._sanitizeConfig(merged);
    if (this._store) {
      this._store.set(CONFIG_KEY, this._config);
    }
    this._emit('stat-rules:changed', this.getConfig());
    return this.getConfig();
  }

  resetConfig() {
    this._config = this._sanitizeConfig({});
    if (this._store) {
      this._store.set(CONFIG_KEY, this._config);
    }
    this._emit('stat-rules:changed', this.getConfig());
    return this.getConfig();
  }

  // ------------------------------------------------------------
  // Shipgirl Level & Experience Progression
  // ------------------------------------------------------------

  getShipMaxExp(level = 1) {
    const lv = Math.max(1, Math.floor(Number(level) || 1));
    return Math.max(10, Math.round(this._config.shipExpBase + (lv - 1) * this._config.shipExpStep));
  }

  /**
   * Ensure a character entity has valid level / exp / maxExp fields and compressed 2-digit growth anchor.
   */
  ensureShipProgression(entity) {
    if (!entity || typeof entity !== 'object') return { level: 1, exp: 0, maxExp: this.getShipMaxExp(1) };
    if (!entity.stats || typeof entity.stats !== 'object') entity.stats = {};
    if (!entity.meta || typeof entity.meta !== 'object') entity.meta = {};
    const lv = clamp(Math.floor(Number(entity.stats.level ?? 1) || 1), 1, this._config.shipLevelMax);
    const maxExp = this.getShipMaxExp(lv);
    const exp = clamp(Math.floor(Number(entity.stats.exp ?? 0) || 0), 0, Math.max(maxExp, 999999));
    entity.stats.level = lv;
    entity.stats.exp = exp;
    entity.stats.maxExp = maxExp;
    normalizeLegacyShipStatsToCompressedScale(entity);
    if (!entity.meta.lv1BaseStats || typeof entity.meta.lv1BaseStats !== 'object') {
      const growth = this.getShipGrowthForEntity(entity);
      const baseSnap = {};
      for (const def of NAVAL_EIGHT_STAT_DEFS) {
        const cur = Number(entity.stats[def.key] ?? def.defaultValue);
        const g = Number(growth[def.key]) || 0.35;
        baseSnap[def.key] = Math.max(def.isVital ? 18 : 6, Number((cur - g * Math.max(0, lv - 1)).toFixed(2)));
      }
      entity.meta.lv1BaseStats = baseSnap;
    }
    return { level: lv, exp, maxExp };
  }

  /**
   * Resolve per-level 8-stat growth weights for a shipgirl based on her ship class (DD/CL/CA/BB/CV/SS/AR/AO)
   * or optional custom per-class overrides in config.
   */
  getShipGrowthForEntity(entity) {
    const shipType = entity?.meta?.shipType || '';
    const profile = getShipClassProfile(shipType);
    const customMap = this._config.shipClassGrowthOverrides || {};
    const customForClass = customMap[profile.code] || customMap[shipType] || null;
    return {
      ...profile.growth,
      ...(customForClass || {}),
    };
  }

  /**
   * Grant experience to a shipgirl character, automatically handling multi-level-up fractional growth & stat refresh.
   */
  grantShipExp(entities, characterId, rawAmount, { reason = '', inventory = null, emitEvent = true } = {}) {
    if (!entities || !entities.has(characterId)) return null;
    const amount = Math.max(0, Math.round(Number(rawAmount) || 0));
    const entity = entities.get(characterId);
    const prog = this.ensureShipProgression(entity);
    const beforeLevel = prog.level;
    let level = prog.level;
    let exp = prog.exp + amount;
    let maxExp = prog.maxExp;
    let levelsGained = 0;
    const statGains = {};

    while (exp >= maxExp && level < this._config.shipLevelMax) {
      exp -= maxExp;
      level += 1;
      levelsGained += 1;
      maxExp = this.getShipMaxExp(level);
    }
    if (level >= this._config.shipLevelMax) {
      exp = Math.min(exp, maxExp);
    }

    if (levelsGained > 0) {
      const growth = this.getShipGrowthForEntity(entity);
      const lv1Base = entity.meta?.lv1BaseStats || {};
      for (const def of NAVAL_EIGHT_STAT_DEFS) {
        const curBase = Number(entity.stats[def.key] ?? def.defaultValue);
        const cap = def.isVital ? 999 : this._config.statMax;
        const g = Number(growth[def.key]) || 0;
        const anchor = Number.isFinite(Number(lv1Base[def.key])) ? Number(lv1Base[def.key]) : curBase;
        const targetVal = clamp(Math.round(anchor + g * (level - 1)), def.min, cap);
        const applied = targetVal - curBase;
        if (applied > 0) {
          entities.setStat(characterId, def.key, targetVal, { min: def.min, max: cap });
          statGains[def.key] = applied;
        }
      }
      if (statGains.maxHp > 0) {
        const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(characterId, 'maxHp', { round: 'round' }).final));
        entities.adjustStat(characterId, 'hp', statGains.maxHp, { min: 0, max: effMaxHp });
      }
    }

    entities.setStat(characterId, 'level', level, { min: 1, max: this._config.shipLevelMax });
    entities.setStat(characterId, 'exp', exp, { min: 0, max: 9999999 });
    entities.setStat(characterId, 'maxExp', maxExp, { min: 10, max: 9999999 });

    if (inventory && typeof inventory.syncCharacterModifiers === 'function') {
      inventory.syncCharacterModifiers(characterId);
    }

    const result = {
      characterId,
      characterName: entity.name,
      shipClass: resolveShipClass(entity.meta?.shipType),
      amount,
      reason,
      beforeLevel,
      afterLevel: level,
      levelsGained,
      leveledUp: levelsGained > 0,
      exp,
      maxExp,
      statGains,
      timestamp: Date.now(),
    };

    if (emitEvent) {
      if (amount > 0) this._emit('character:exp-gained', result);
      if (levelsGained > 0) this._emit('character:leveled-up', result);
    }
    return result;
  }

  /**
   * Manually adjust a shipgirl's level (for testing / debugging), applying proportional fractional class growth cleanly.
   */
  setShipLevelManual(entities, characterId, targetLevel, { exp = 0, inventory = null, applyGrowthDelta = true } = {}) {
    if (!entities || !entities.has(characterId)) return null;
    const entity = entities.get(characterId);
    const prog = this.ensureShipProgression(entity);
    const beforeLevel = prog.level;
    const nextLevel = clamp(Math.floor(Number(targetLevel) || 1), 1, this._config.shipLevelMax);
    const levelDelta = nextLevel - beforeLevel;
    const maxExp = this.getShipMaxExp(nextLevel);
    const nextExp = clamp(Math.floor(Number(exp) || 0), 0, Math.max(0, maxExp - 1));
    const statGains = {};

    if (applyGrowthDelta && levelDelta !== 0) {
      const growth = this.getShipGrowthForEntity(entity);
      const lv1Base = entity.meta?.lv1BaseStats || {};
      for (const def of NAVAL_EIGHT_STAT_DEFS) {
        const curBase = Number(entity.stats[def.key] ?? def.defaultValue);
        const cap = def.isVital ? 999 : this._config.statMax;
        const g = Number(growth[def.key]) || 0;
        const anchor = Number.isFinite(Number(lv1Base[def.key])) ? Number(lv1Base[def.key]) : curBase;
        const nextBase = clamp(Math.round(anchor + g * (nextLevel - 1)), def.min, cap);
        entities.setStat(characterId, def.key, nextBase, { min: def.min, max: cap });
        statGains[def.key] = nextBase - curBase;
      }
      if (statGains.maxHp) {
        const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(characterId, 'maxHp', { round: 'round' }).final));
        entities.adjustStat(characterId, 'hp', statGains.maxHp, { min: 1, max: effMaxHp });
      }
    }

    entities.setStat(characterId, 'level', nextLevel, { min: 1, max: this._config.shipLevelMax });
    entities.setStat(characterId, 'exp', nextExp, { min: 0, max: 9999999 });
    entities.setStat(characterId, 'maxExp', maxExp, { min: 10, max: 9999999 });

    if (inventory && typeof inventory.syncCharacterModifiers === 'function') {
      inventory.syncCharacterModifiers(characterId);
    }

    const result = {
      characterId,
      characterName: entity.name,
      shipClass: resolveShipClass(entity.meta?.shipType),
      beforeLevel,
      afterLevel: nextLevel,
      levelsGained: Math.max(0, levelDelta),
      leveledUp: levelDelta > 0,
      exp: nextExp,
      maxExp,
      statGains,
      timestamp: Date.now(),
    };
    if (levelDelta > 0) this._emit('character:leveled-up', result);
    return result;
  }

  // ------------------------------------------------------------
  // Stat Modifiers, Morale Modifiers & Affinity Mapping
  // ------------------------------------------------------------

  getStatModifier(statValue) {
    const step = this._config.statModifierStep || 10;
    return Math.floor(Math.max(0, Number(statValue) || 0) / step);
  }

  getMoraleModifier(moraleValue) {
    const m = clamp(Number(moraleValue ?? 50), 0, 100);
    if (m >= this._config.moraleHighThreshold) return this._config.moraleHighBonus;
    if (m >= this._config.moraleNormalThreshold) return 0;
    if (m >= this._config.moraleLowThreshold) return this._config.moraleLowPenalty;
    return this._config.moraleCriticalPenalty;
  }

  getMoraleLabel(moraleValue) {
    const m = clamp(Number(moraleValue ?? 50), 0, 100);
    if (m >= this._config.moraleHighThreshold) return '高昂';
    if (m >= this._config.moraleNormalThreshold) return '平稳';
    if (m >= this._config.moraleLowThreshold) return '低落';
    return '疲惫';
  }

  /**
   * Map affinity (0..150) into the 6 slow-paced stages:
   *   陌生 (0~20) -> 熟悉 (20~40) -> 信赖 (40~60) -> 心动 (60~80) -> 恋慕 (80~100) -> 誓约 (100~150)
   */
  getAffinityStage(affinityValue, { isOathed = false } = {}) {
    const val = clamp(Math.round(Number(affinityValue ?? 0)), 0, OATH_AFFINITY_CAP);
    const sixStages = [
      { stageIndex: 0, id: 'stranger', label: '陌生', min: 0, max: 20, tone: 'muted' },
      { stageIndex: 1, id: 'familiar', label: '熟悉', min: 20, max: 40, tone: 'info' },
      { stageIndex: 2, id: 'trusted', label: '信赖', min: 40, max: 60, tone: 'ok' },
      { stageIndex: 3, id: 'flutter', label: '心动', min: 60, max: 80, tone: 'warn' },
      { stageIndex: 4, id: 'adoration', label: '恋慕', min: 80, max: 100, tone: 'warn' },
      { stageIndex: 5, id: 'oath', label: '誓约', min: 100, max: OATH_AFFINITY_CAP, tone: 'ok' },
    ];
    const stage =
      isOathed || val > 100
        ? sixStages[5]
        : val >= 80
        ? sixStages[4]
        : val >= 60
        ? sixStages[3]
        : val >= 40
        ? sixStages[2]
        : val >= 20
        ? sixStages[1]
        : sixStages[0];
    const span = Math.max(1, stage.max - stage.min);
    const progressInStage = clamp((val - stage.min) / span, 0, 1);
    return {
      value: val,
      stageIndex: stage.stageIndex,
      id: stage.id,
      label: stage.label,
      min: stage.min,
      max: stage.max,
      tone: stage.tone,
      thresholdReduction: 0,
      progressInStage: Number(progressInStage.toFixed(4)),
    };
  }

  /**
   * Compute overall composite character rating from effective 8 naval stats + check bonus.
   */
  computeOverallScore(effectiveStats = {}, equipmentCheckBonus = 0) {
    const w = this._config.scoreWeights;
    let total = 0;
    for (const def of NAVAL_EIGHT_STAT_DEFS) {
      total += (Number(effectiveStats[def.key]) || 0) * (w[def.key] || 1);
    }
    total += (Number(equipmentCheckBonus) || 0) * 14;
    return Math.round(total);
  }

  /**
   * Evaluate whether a character satisfies the 3 mandatory core slots (engine / armor / core).
   */
  evaluateSeaworthiness(inventory, characterId) {
    if (!inventory || typeof inventory.checkSeaworthiness !== 'function') {
      return { seaworthy: true, missingSlots: [], statusText: '适航 (Seaworthy)' };
    }
    return inventory.checkSeaworthiness(characterId);
  }

  /**
   * Build offline time recovery rules for EntitySystem.settleOfflineTime().
   * Accepts optional moraleMultiplier (from Commander `affinity`).
   */
  buildOfflineRecoveryRules(entityList = [], { moraleMultiplier = 1.0 } = {}) {
    const rates = this._config.offlineRecoveryPerMin;
    const mMult = Math.max(0.5, Number(moraleMultiplier) || 1.0);
    const rules = [];
    for (const entity of entityList) {
      const maxHp = Number(entity.stats?.maxHp ?? 100);
      const maxAp = Number(entity.stats?.maxAp ?? 100);
      rules.push(
        { entityId: entity.id, stat: 'hp', ratePerMinute: rates.hp, min: 0, max: maxHp, round: 'round' },
        { entityId: entity.id, stat: 'morale', ratePerMinute: rates.morale * mMult, min: 0, max: 100, round: 'round' },
        { entityId: entity.id, stat: 'ap', ratePerMinute: rates.ap, min: 0, max: maxAp, round: 'round' }
      );
    }
    return rules;
  }

  // ------------------------------------------------------------
  // Standard 1D20 Attribute Check (with Commander Luck edge-tuning)
  // ------------------------------------------------------------

  performCheck({
    actorId = null,
    actorName = '',
    statKey = 'firepower',
    baseStatValue = 50,
    effectiveStatValue = null,
    equipmentCheckBonus = 0,
    moraleValue = 60,
    dc = 15,
    extraModifier = 0,
    commanderLuck = 0,
    rng = Math.random,
    emitEvent = true,
  } = {}) {
    const normalizedKey = normalizeStatKey(statKey);
    const statDef = NAVAL_EIGHT_STAT_MAP[normalizedKey] || { key: normalizedKey, label: normalizedKey };
    const baseVal = Number(baseStatValue) || 0;
    const effVal =
      effectiveStatValue !== null && effectiveStatValue !== undefined ? Number(effectiveStatValue) : baseVal;
    const equipStatDelta = Number((effVal - baseVal).toFixed(2));

    const diceRes = roll(1, this._config.diceSides, 0, rng);
    const naturalRoll = diceRes.total;

    const baseStatMod = this.getStatModifier(baseVal);
    const effectiveStatMod = this.getStatModifier(effVal);
    const statBonusFromEquipMod = effectiveStatMod - baseStatMod;
    const flatEquipCheckBonus = Number(equipmentCheckBonus) || 0;
    const totalEquipModifier = statBonusFromEquipMod + flatEquipCheckBonus;
    const moraleMod = this.getMoraleModifier(moraleValue);
    const extraMod = Number(extraModifier) || 0;

    // Independent Commander Luck edge adjustment
    const lk = Math.round(Number(commanderLuck) || 0);
    const critSuccessShift = lk > 0 ? Math.min(3, Math.floor(lk / 10)) : 0;
    const critFailShift = lk < 0 ? Math.min(3, Math.floor(Math.abs(lk) / 10)) : 0;
    const luckEdgeMod = lk >= 0 ? Math.floor(lk / 15) : Math.ceil(lk / 15);
    const effectiveCritSuccessNat = Math.max(15, this._config.critSuccessNatural - critSuccessShift);
    const effectiveCritFailNat = Math.min(5, this._config.critFailNatural + critFailShift);

    const targetDc = clamp(Math.round(Number(dc) || 15), 1, 99);
    const total = naturalRoll + baseStatMod + totalEquipModifier + moraleMod + extraMod + luckEdgeMod;
    const margin = total - targetDc;

    let outcome = 'fail';
    let outcomeLabel = '失败';
    if (naturalRoll <= effectiveCritFailNat) {
      outcome = 'crit-fail';
      outcomeLabel = '大失败';
    } else if (naturalRoll >= effectiveCritSuccessNat) {
      outcome = 'crit-success';
      outcomeLabel = '大成功';
    } else if (margin >= this._config.critMarginThreshold) {
      outcome = 'crit-success';
      outcomeLabel = '大成功';
    } else if (margin <= -this._config.critMarginThreshold) {
      outcome = 'crit-fail';
      outcomeLabel = '大失败';
    } else if (total >= targetDc) {
      outcome = 'success';
      outcomeLabel = '成功';
    }

    const steps = [
      { label: `基础掷骰 (1D${this._config.diceSides})`, value: naturalRoll, text: `${naturalRoll}` },
      {
        label: `基础属性修正（${statDef.label} ${baseVal} / ${this._config.statModifierStep}）`,
        value: baseStatMod,
        text: formatSigned(baseStatMod),
      },
      {
        label: `装备与模块加成（属性 ${formatSigned(equipStatDelta)} → 修正 ${formatSigned(statBonusFromEquipMod)}，检定词条 ${formatSigned(flatEquipCheckBonus)}）`,
        value: totalEquipModifier,
        text: formatSigned(totalEquipModifier),
      },
      {
        label: `士气修正（士气 ${Math.round(Number(moraleValue) || 0)} · ${this.getMoraleLabel(moraleValue)}）`,
        value: moraleMod,
        text: formatSigned(moraleMod),
      },
    ];
    if (extraMod !== 0) {
      steps.push({ label: '战术/阵型/海况修正', value: extraMod, text: formatSigned(extraMod) });
    }
    if (lk !== 0) {
      steps.push({
        label: `指挥官运气微调（运气 ${formatSigned(lk)}，大成功≥${effectiveCritSuccessNat} / 大失败≤${effectiveCritFailNat}）`,
        value: luckEdgeMod,
        text: formatSigned(luckEdgeMod),
      });
    }

    const formulaParts = [
      `1D${this._config.diceSides}(${naturalRoll})`,
      `属性(${formatSigned(baseStatMod)})`,
      `装备模块(${formatSigned(totalEquipModifier)})`,
      `士气(${formatSigned(moraleMod)})`,
    ];
    if (extraMod !== 0) formulaParts.push(`战术(${formatSigned(extraMod)})`);
    if (luckEdgeMod !== 0) formulaParts.push(`运气(${formatSigned(luckEdgeMod)})`);
    const formulaText = `${formulaParts.join(' + ')} = ${total} vs DC ${targetDc}`;

    const result = {
      actorId,
      actorName,
      statKey: statDef.key,
      statLabel: statDef.label,
      dc: targetDc,
      naturalRoll,
      baseStatValue: baseVal,
      effectiveStatValue: effVal,
      equipmentStatDelta: equipStatDelta,
      baseStatModifier: baseStatMod,
      equipmentModifier: totalEquipModifier,
      moraleValue: Number(moraleValue) || 0,
      moraleModifier: moraleMod,
      extraModifier: extraMod,
      commanderLuck: lk,
      luckEdgeModifier: luckEdgeMod,
      total,
      margin,
      outcome,
      outcomeLabel,
      formulaText,
      steps,
      timestamp: Date.now(),
    };

    if (emitEvent) {
      this._emit('stat-rules:check-performed', result);
    }
    return result;
  }
}

// ============================================================
// Enemy Strength Multipliers, Dynamic Scaling & Opening Strikes
// ============================================================

export const ENEMY_STRENGTH_PRESETS = Object.freeze([
  { id: 'normal', label: '常规 1.0x', multiplier: 1.0, desc: '标准海战对抗节奏，适合日常推图与养成' },
  { id: 'realistic', label: '拟真高难 1.5x', multiplier: 1.5, desc: '强化敌方防空/护甲与智能集火，掉落加成 +18%' },
  { id: 'inferno', label: '深海炼狱 2.2x', multiplier: 2.2, desc: '大编队精英集群高压对抗，掉落加成 +42%' },
]);

export function clampEnemyStrengthMultiplier(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return 1.0;
  return Number(clamp(Math.round(num * 10) / 10, 0.5, 3.5).toFixed(1));
}

/**
 * Compute dynamic enemy stat & count scaling factors based on sea difficulty,
 * current node depth ratio (0..1), allied fleet size, and player strength multiplier.
 */
export function computeDynamicEnemyScale({
  difficulty = 'low',
  nodeDepthRatio = 0,
  fleetSize = 3,
  strengthMultiplier = 1.0,
} = {}) {
  const diffMult = difficulty === 'high' ? 1.38 : difficulty === 'medium' ? 1.16 : 1.0;
  const depthFactor = 1 + clamp(Number(nodeDepthRatio) || 0, 0, 1) * 0.42;
  const sizeFactor = 1 + Math.max(0, Math.round(Number(fleetSize) || 1) - 3) * 0.11;
  const strMult = clampEnemyStrengthMultiplier(strengthMultiplier);

  const statScale = Number((diffMult * depthFactor * sizeFactor * strMult).toFixed(3));
  const atkScale = Number((diffMult * (1 + clamp(Number(nodeDepthRatio) || 0, 0, 1) * 0.25) * (0.85 + strMult * 0.35)).toFixed(3));
  const armorScale = Number((diffMult * (0.8 + strMult * 0.35)).toFixed(3));
  const lootBonus = Number((1 + Math.max(0, strMult - 1) * 0.35).toFixed(2));

  return {
    diffMult,
    depthFactor: Number(depthFactor.toFixed(3)),
    sizeFactor: Number(sizeFactor.toFixed(3)),
    strengthMultiplier: strMult,
    statScale,
    atkScale,
    armorScale,
    lootBonus,
  };
}

/**
 * Opening Airstrike formula:
 * Calculates AA interception ratio from defender `aa` vs attacker `airPower`.
 */
export function computeOpeningAirstrikeOutcome({
  attackerAirPower = 60,
  defenderAa = 50,
  aaAlertActive = false,
  rng = Math.random,
} = {}) {
  const atk = Math.max(10, Number(attackerAirPower) || 10);
  const defAa = Math.max(5, Number(defenderAa) || 5) * (aaAlertActive ? 1.45 : 1.0);
  const ratio = defAa / (atk + defAa);
  const interceptPct = Number(clamp(ratio * 0.88, 0.1, 0.78).toFixed(3));
  const passThrough = Number(clamp(1 - interceptPct, 0.22, 0.9).toFixed(3));

  let airState = '航空均势';
  if (atk >= defAa * 1.6) airState = '制空确保';
  else if (atk >= defAa * 1.15) airState = '航空优势';
  else if (atk < defAa * 0.75) airState = '航空劣势';

  const variance = 0.88 + rng() * 0.24;
  const strikeDamageBase = Math.max(6, Math.round(atk * 0.36 * passThrough * variance));

  return {
    airState,
    interceptPct,
    interceptLabel: `防空拦截 ${Math.round(interceptPct * 100)}%`,
    passThrough,
    strikeDamageBase,
  };
}

/**
 * Air Superiority Fighter Contest (制空权争夺):
 * Compares ally vs enemy fighter air power; determines AS+ / AS / AP / AD / AI,
 * enemy/ally plane shoot-down percentages, and shelling d20 hit bonus.
 */
export function computeAirSuperiorityContest({
  allyFighterPower = 0,
  enemyFighterPower = 0,
} = {}) {
  const ally = Math.max(0, Number(allyFighterPower) || 0);
  const enemy = Math.max(0, Number(enemyFighterPower) || 0);

  if (ally <= 0 && enemy <= 0) {
    return {
      stateCode: 'NONE',
      stateLabel: '无航空制空',
      allyFighterPower: 0,
      enemyFighterPower: 0,
      allyHitBonus: 0,
      enemyHitBonus: 0,
      enemyPlanesShotDownPct: 0,
      allyPlanesShotDownPct: 0,
      allyBombMult: 1.0,
      enemyBombMult: 1.0,
    };
  }

  const ratio = enemy <= 0 ? 99 : ally / enemy;
  if (ratio >= 2.0) {
    return {
      stateCode: 'AS+',
      stateLabel: '制空确保',
      allyFighterPower: Math.round(ally),
      enemyFighterPower: Math.round(enemy),
      allyHitBonus: 2,
      enemyHitBonus: -1,
      enemyPlanesShotDownPct: 0.55,
      allyPlanesShotDownPct: 0.08,
      allyBombMult: 1.18,
      enemyBombMult: 0.45,
    };
  }
  if (ratio >= 1.3) {
    return {
      stateCode: 'AS',
      stateLabel: '航空优势',
      allyFighterPower: Math.round(ally),
      enemyFighterPower: Math.round(enemy),
      allyHitBonus: 1,
      enemyHitBonus: 0,
      enemyPlanesShotDownPct: 0.35,
      allyPlanesShotDownPct: 0.16,
      allyBombMult: 1.08,
      enemyBombMult: 0.65,
    };
  }
  if (ratio >= 0.75) {
    return {
      stateCode: 'AP',
      stateLabel: '制空均势',
      allyFighterPower: Math.round(ally),
      enemyFighterPower: Math.round(enemy),
      allyHitBonus: 0,
      enemyHitBonus: 0,
      enemyPlanesShotDownPct: 0.22,
      allyPlanesShotDownPct: 0.22,
      allyBombMult: 0.92,
      enemyBombMult: 0.85,
    };
  }
  if (ratio >= 0.4) {
    return {
      stateCode: 'AD',
      stateLabel: '航空劣势',
      allyFighterPower: Math.round(ally),
      enemyFighterPower: Math.round(enemy),
      allyHitBonus: 0,
      enemyHitBonus: 1,
      enemyPlanesShotDownPct: 0.12,
      allyPlanesShotDownPct: 0.42,
      allyBombMult: 0.68,
      enemyBombMult: 1.08,
    };
  }
  return {
    stateCode: 'AI',
    stateLabel: '制空丧失',
    allyFighterPower: Math.round(ally),
    enemyFighterPower: Math.round(enemy),
    allyHitBonus: -1,
    enemyHitBonus: 2,
    enemyPlanesShotDownPct: 0.05,
    allyPlanesShotDownPct: 0.6,
    allyBombMult: 0.45,
    enemyBombMult: 1.18,
  };
}

/**
 * Combined AA Barrage Interception (防空弹幕联动拦截):
 * Combines escort fighters + fleet total AA stat + AA gun / air-search radar gear.
 */
export function computeAaBarrageInterception({
  incomingAirPower = 30,
  fleetAa = 25,
  aaGearBonus = 0,
  escortFighterBonus = 0,
  aaAlertActive = false,
} = {}) {
  const atk = Math.max(8, Number(incomingAirPower) || 8);
  const totalDefense =
    (Math.max(4, Number(fleetAa) || 4) +
      Math.max(0, Number(aaGearBonus) || 0) +
      Math.max(0, Number(escortFighterBonus) || 0)) *
    (aaAlertActive ? 1.45 : 1.0);
  const shootDownPct = Number(clamp((totalDefense / (atk * 1.15 + totalDefense)) * 0.86, 0.08, 0.82).toFixed(3));
  const passThrough = Number(clamp(1 - shootDownPct, 0.18, 0.92).toFixed(3));
  return {
    totalDefense: Math.round(totalDefense),
    shootDownPct,
    passThrough,
    label: `防空弹幕击落 ${Math.round(shootDownPct * 100)}% 来袭机群`,
  };
}

/**
 * Opening Torpedo formula:
 * High-torpedo units & submarines launch preemptive torpedoes suppressed by defender `asw` & `evasion`.
 */
export function computeOpeningTorpedoOutcome({
  attackerTorpedo = 65,
  defenderAsw = 45,
  defenderEvasion = 55,
  isSubmarine = false,
  rng = Math.random,
} = {}) {
  const torp = Math.max(10, Number(attackerTorpedo) || 10);
  const asw = Math.max(0, Number(defenderAsw) || 0);
  const eva = Math.max(10, Number(defenderEvasion) || 10);

  // Submarines are heavily suppressed by ASW; surface torp destroyers are suppressed by Evasion + ASW screening
  const suppressWeight = isSubmarine ? asw * 0.8 + eva * 0.35 : eva * 0.68 + asw * 0.35;
  const suppressRatio = clamp(suppressWeight / (torp * 1.35 + suppressWeight), 0.12, 0.76);
  const hitChance = clamp(0.84 - suppressRatio * 0.52, 0.28, 0.88);
  const hit = rng() <= hitChance;
  const damageMult = Number(clamp(1 - suppressRatio * 0.72, 0.28, 0.92).toFixed(3));
  const variance = 0.88 + rng() * 0.24;
  const strikeDamageBase = hit ? Math.max(5, Math.round(torp * 0.38 * damageMult * variance)) : 0;

  return {
    hit,
    hitChance: Number(hitChance.toFixed(3)),
    suppressPct: Number(suppressRatio.toFixed(3)),
    suppressLabel: isSubmarine
      ? `反潜压制 ${Math.round(suppressRatio * 100)}%`
      : `机动规避 ${Math.round(suppressRatio * 100)}%`,
    strikeDamageBase,
  };
}

// ============================================================
// Universal Five-Tier Rarity System (White -> Green -> Blue -> Purple -> Orange)
// Applies uniformly to ALL Equipment Modules AND Shipgirl Outfits
// ============================================================

export const ITEM_RARITIES = Object.freeze({
  COMMON: 'common',
  UNCOMMON: 'uncommon',
  RARE: 'rare',
  EPIC: 'epic',
  LEGENDARY: 'legendary',
});

export const ITEM_RARITY_DEFS = Object.freeze([
  {
    id: ITEM_RARITIES.COMMON,
    rank: 1,
    label: '白·普通',
    shortLabel: '普通',
    color: '#cbd5e1',
    borderColor: '#94a3b8',
    bgTint: 'rgba(148, 163, 184, 0.14)',
    statScale: 1.0,
    disassembleBase: { steel: 28, bauxite: 14, silver: 45 },
  },
  {
    id: ITEM_RARITIES.UNCOMMON,
    rank: 2,
    label: '绿·精良',
    shortLabel: '精良',
    color: '#4ade80',
    borderColor: '#22c55e',
    bgTint: 'rgba(34, 197, 94, 0.14)',
    statScale: 1.18,
    disassembleBase: { steel: 58, bauxite: 30, silver: 95 },
  },
  {
    id: ITEM_RARITIES.RARE,
    rank: 3,
    label: '蓝·稀有',
    shortLabel: '稀有',
    color: '#60a5fa',
    borderColor: '#3b82f6',
    bgTint: 'rgba(59, 130, 246, 0.16)',
    statScale: 1.38,
    disassembleBase: { steel: 110, bauxite: 60, silver: 185 },
  },
  {
    id: ITEM_RARITIES.EPIC,
    rank: 4,
    label: '紫·史诗',
    shortLabel: '史诗',
    color: '#c084fc',
    borderColor: '#a855f7',
    bgTint: 'rgba(168, 85, 247, 0.18)',
    statScale: 1.62,
    disassembleBase: { steel: 210, bauxite: 120, silver: 340 },
  },
  {
    id: ITEM_RARITIES.LEGENDARY,
    rank: 5,
    label: '橙·传说',
    shortLabel: '传说',
    color: '#fb923c',
    borderColor: '#f97316',
    bgTint: 'rgba(249, 115, 22, 0.2)',
    statScale: 1.9,
    disassembleBase: { steel: 380, bauxite: 220, silver: 620 },
  },
]);

export const ITEM_RARITY_MAP = Object.freeze(
  Object.fromEntries(ITEM_RARITY_DEFS.map((r) => [r.id, r]))
);

export const ITEM_RARITY_ORDER = Object.freeze(ITEM_RARITY_DEFS.map((r) => r.id));

export function normalizeRarity(rarity) {
  const key = String(rarity || '').trim().toLowerCase();
  if (ITEM_RARITY_MAP[key]) return key;
  if (key === 'white' || key === '普通' || key === '白') return ITEM_RARITIES.COMMON;
  if (key === 'green' || key === '精良' || key === '绿') return ITEM_RARITIES.UNCOMMON;
  if (key === 'blue' || key === '稀有' || key === '蓝') return ITEM_RARITIES.RARE;
  if (key === 'purple' || key === '史诗' || key === '紫') return ITEM_RARITIES.EPIC;
  if (key === 'orange' || key === 'gold' || key === '传说' || key === '橙') return ITEM_RARITIES.LEGENDARY;
  return ITEM_RARITIES.COMMON;
}

/**
 * Losslessly infer an item or outfit's rarity tier for legacy IndexedDB saves
 * based on total stat bonus power, checkBonus, and enhance level.
 */
export function inferItemRarity(item = {}) {
  if (!item || typeof item !== 'object') return ITEM_RARITIES.COMMON;
  if (item.rarity && ITEM_RARITY_MAP[String(item.rarity).toLowerCase()]) {
    return String(item.rarity).toLowerCase();
  }
  const bonuses = Array.isArray(item.baseBonuses) && item.baseBonuses.length > 0
    ? item.baseBonuses
    : Array.isArray(item.bonuses)
    ? item.bonuses
    : [];
  let powerScore = 0;
  for (const b of bonuses) {
    const val = Math.abs(Number(b?.value) || 0);
    if (b?.stat === 'checkBonus') powerScore += val * 12;
    else if (b?.layer === 'percentAdd' || b?.layer === 'percentMult') powerScore += val * 120;
    else powerScore += val;
  }
  const lv = Math.max(0, Math.floor(Number(item.level) || 0));
  const nameText = `${item.name || ''} ${(item.tags || []).join(' ')}`;
  if (/(传说|旗舰|花嫁|誓约|超重|实验型|原型|终极)/.test(nameText)) powerScore += 18;
  else if (/(史诗|精密|精锐|夜战|盛装|礼服|涡轮)/.test(nameText)) powerScore += 10;

  const combined = powerScore + lv * 3.5;
  if (combined >= 52 || lv >= 9) return ITEM_RARITIES.LEGENDARY;
  if (combined >= 38 || lv >= 6) return ITEM_RARITIES.EPIC;
  if (combined >= 26 || lv >= 4) return ITEM_RARITIES.RARE;
  if (combined >= 16 || lv >= 2) return ITEM_RARITIES.UNCOMMON;
  return ITEM_RARITIES.COMMON;
}

/**
 * Compute steel, bauxite, and silver yield when disassembling an idle equipment or outfit item.
 */
export function getDisassembleYieldByRarity(item = {}, { dropMultiplier = 1.0 } = {}) {
  const rarityId = inferItemRarity(item);
  const def = ITEM_RARITY_MAP[rarityId] || ITEM_RARITY_MAP.common;
  const lv = Math.max(0, Math.floor(Number(item?.level) || 0));
  const lvScale = 1 + lv * 0.25;
  const mult = clampResourceDropMultiplier(dropMultiplier);
  return {
    steel: Math.max(10, Math.round(def.disassembleBase.steel * lvScale * mult)),
    bauxite: Math.max(5, Math.round(def.disassembleBase.bauxite * lvScale * mult)),
    silver: Math.max(20, Math.round(def.disassembleBase.silver * lvScale * mult)),
  };
}

// ============================================================
// Resource & Drop Multiplier Settings (1.0x / 2.0x / 3.0x + Custom Slider)
// ============================================================

export const RESOURCE_DROP_MULTIPLIER_PRESETS = Object.freeze([
  { id: 'standard', label: '1.0x 常规', multiplier: 1.0, value: 1.0, desc: '标准丰度产出与装备掉落率' },
  { id: 'abundant', label: '2.0x 丰饶', multiplier: 2.0, value: 2.0, desc: '双倍资源产出、离线恢复与高阶掉落权重提升' },
  { id: 'chill', label: '3.0x 畅玩', multiplier: 3.0, value: 3.0, desc: '三倍资源涌流与超高紫/橙装备箱掉落体验' },
]);

export function clampResourceDropMultiplier(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return 1.0;
  return Number(clamp(Math.round(num * 10) / 10, 0.5, 5.0).toFixed(1));
}

// ============================================================
// Canonical Known Equipment Types (Shared across Expandable Slots,
// Warehouse Filtering, Custom Equipment Editor & Save v5 Migration)
// ============================================================

export const KNOWN_EQUIPMENT_TYPES = Object.freeze({
  MAIN_GUN: 'main_gun',
  TORPEDO: 'torpedo',
  AIRCRAFT: 'aircraft',
  RADAR: 'radar',
  SONAR: 'sonar',
  AA_GUN: 'aa_gun',
  SUPPORT: 'support',
  ENGINE: 'engine',
  ARMOR: 'armor',
  CORE: 'core',
});

export const KNOWN_EQUIPMENT_TYPE_DEFS = Object.freeze([
  {
    id: KNOWN_EQUIPMENT_TYPES.MAIN_GUN,
    label: '主炮',
    slotLabel: '主炮槽',
    group: '主战武器',
    category: 'extension',
    subGroup: 'weapon',
    defaultIcon: 'main_gun',
    desc: '舰炮与穿甲重炮武器，大幅强化火力输出（无视 35% 护甲）',
    keywords: ['主炮', '舰炮', '重炮', '火炮', '炮塔', '炮击', 'gun', 'cannon', 'turret'],
  },
  {
    id: KNOWN_EQUIPMENT_TYPES.TORPEDO,
    label: '鱼雷',
    slotLabel: '鱼雷槽',
    group: '主战武器',
    category: 'extension',
    subGroup: 'weapon',
    defaultIcon: 'torpedo',
    desc: '酸素鱼雷与近距雷装，强化雷击（无视 40% 护甲）',
    keywords: ['鱼雷', '酸素', '氧雷', '雷装', '鱼雷管', 'torpedo'],
  },
  {
    id: KNOWN_EQUIPMENT_TYPES.AIRCRAFT,
    label: '舰载机',
    slotLabel: '舰载机槽',
    group: '主战武器',
    category: 'extension',
    subGroup: 'weapon',
    defaultIcon: 'aircraft',
    desc: '俯冲轰炸机、鱼雷机与制空战机联队',
    keywords: ['舰载机', '舰载', '轰炸机', '攻击机', '战斗机', '空袭', '航空', '侦察机', 'aircraft', 'plane'],
  },
  {
    id: KNOWN_EQUIPMENT_TYPES.SUPPORT,
    label: '后勤支援',
    slotLabel: '支援槽',
    group: '后勤支援',
    category: 'extension',
    subGroup: 'support',
    defaultIcon: 'support_repair',
    desc: '战地抢修吊舱、海上补给箱与损管套件（解锁紧急抢修 / 前线补给）',
    keywords: ['支援', '后勤', '抢修', '维修', '损管', '补给箱', '海上补给', '油弹补给', '吊舱', '起重', 'support', 'repair', 'supply', 'logistics'],
  },
  {
    id: KNOWN_EQUIPMENT_TYPES.RADAR,
    label: '雷达',
    slotLabel: '雷达槽',
    group: '战术辅助',
    category: 'extension',
    subGroup: 'tactical',
    defaultIcon: 'radar',
    desc: '相控电探、火控校准与夜战侦察系统',
    keywords: ['雷达', '电探', '侦查', '侦察', '火控', '夜战', '探照灯', '通信', '协同', '增幅', 'radar', 'recon'],
  },
  {
    id: KNOWN_EQUIPMENT_TYPES.SONAR,
    label: '声呐',
    slotLabel: '声呐槽',
    group: '战术辅助',
    category: 'extension',
    subGroup: 'tactical',
    defaultIcon: 'sonar',
    desc: '水下主动声呐与深水炸弹反潜组件',
    keywords: ['声呐', '声纳', '反潜', '深水', '爆雷', '投射机', '潜艇', 'sonar', 'asw'],
  },
  {
    id: KNOWN_EQUIPMENT_TYPES.AA_GUN,
    label: '防空',
    slotLabel: '防空槽',
    group: '战术辅助',
    category: 'extension',
    subGroup: 'tactical',
    defaultIcon: 'aa_gun',
    desc: '速射高炮、近防机炮与对空弹幕火网',
    keywords: ['防空', '高炮', '对空', '机炮', '高射', '弹幕', 'aa_gun', 'aa'],
  },
  {
    id: KNOWN_EQUIPMENT_TYPES.ENGINE,
    label: '引擎',
    slotLabel: '引擎扩建槽',
    group: '核心三件套',
    category: 'engine',
    subGroup: 'core',
    defaultIcon: 'engine',
    desc: '额外动力推进引擎模块，强化机动与航速',
    keywords: ['引擎', '轮机', '涡轮', '动力', '锅炉', '推进', 'engine', 'turbine'],
  },
  {
    id: KNOWN_EQUIPMENT_TYPES.ARMOR,
    label: '装甲',
    slotLabel: '装甲扩建槽',
    group: '核心三件套',
    category: 'armor',
    subGroup: 'core',
    defaultIcon: 'armor',
    desc: '额外复合装甲带与防雷隔舱，提升耐久与防护',
    keywords: ['装甲', '防雷', '护盾', '钢甲', '甲板', '防护', 'armor', 'shield'],
  },
  {
    id: KNOWN_EQUIPMENT_TYPES.CORE,
    label: '核心',
    slotLabel: '核心扩建槽',
    group: '核心三件套',
    category: 'core',
    subGroup: 'core',
    defaultIcon: 'core',
    desc: '额外火控中枢与战术晶核，全面提升核心属性',
    keywords: ['核心', '中枢', '晶核', '芯片', '模块', '组件', 'core', 'module'],
  },
]);

export const KNOWN_EQUIPMENT_TYPE_MAP = Object.freeze(
  Object.fromEntries(KNOWN_EQUIPMENT_TYPE_DEFS.map((d) => [d.id, d]))
);

/**
 * Normalize any equipment type id or Chinese/English keyword string to a canonical Known Equipment Type id.
 */
export function normalizeEquipmentTypeId(raw, fallback = KNOWN_EQUIPMENT_TYPES.MAIN_GUN) {
  const s = String(raw || '').trim();
  if (!s) return fallback;
  const lower = s.toLowerCase();
  if (KNOWN_EQUIPMENT_TYPE_MAP[lower]) return lower;
  for (const def of KNOWN_EQUIPMENT_TYPE_DEFS) {
    if (def.label === s || def.slotLabel === s) return def.id;
  }
  for (const def of KNOWN_EQUIPMENT_TYPE_DEFS) {
    if (def.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return def.id;
    }
  }
  return fallback;
}

/**
 * Infer canonical Known Equipment Type id for any equipment item or legacy custom slot.
 */
export function inferEquipmentTypeId(target = null, fallback = KNOWN_EQUIPMENT_TYPES.MAIN_GUN) {
  if (!target || typeof target !== 'object') return fallback;

  if (target.category === 'outfit' || target.equipmentType === 'outfit' || target.subCategory === 'outfit') {
    return 'outfit';
  }

  const explicit = String(target.equipmentType || target.subCategory || '').trim().toLowerCase();
  if (KNOWN_EQUIPMENT_TYPE_MAP[explicit]) return explicit;
  if (explicit === 'support_repair' || explicit === 'support_supply' || explicit === 'logistics') {
    return KNOWN_EQUIPMENT_TYPES.SUPPORT;
  }

  if (target.category === 'engine') return KNOWN_EQUIPMENT_TYPES.ENGINE;
  if (target.category === 'armor') return KNOWN_EQUIPMENT_TYPES.ARMOR;
  if (target.category === 'core') return KNOWN_EQUIPMENT_TYPES.CORE;

  const icon = String(target.iconKey || '').trim().toLowerCase();
  if (KNOWN_EQUIPMENT_TYPE_MAP[icon]) return icon;
  if (icon === 'support_repair' || icon === 'support_supply') return KNOWN_EQUIPMENT_TYPES.SUPPORT;

  const primaryText = `${target.name || ''} ${target.label || ''}`.trim();
  const byPrimary = normalizeEquipmentTypeId(primaryText, null);
  if (byPrimary) return byPrimary;

  const tagsText = Array.isArray(target.tags) ? target.tags.join(' ') : String(target.tags || '');
  const byTags = normalizeEquipmentTypeId(tagsText, null);
  if (byTags) return byTags;

  const byDesc = normalizeEquipmentTypeId(String(target.description || ''), null);
  if (byDesc) return byDesc;

  const bonuses = Array.isArray(target.bonuses) && target.bonuses.length > 0 ? target.bonuses : target.baseBonuses || [];
  let topStat = null;
  let topVal = 0;
  for (const b of bonuses) {
    const k = normalizeStatKey(b?.stat);
    const v = Math.abs(Number(b?.value) || 0);
    if (k && k !== 'checkBonus' && v > topVal) {
      topStat = k;
      topVal = v;
    }
  }
  if (topStat === 'torpedo') return KNOWN_EQUIPMENT_TYPES.TORPEDO;
  if (topStat === 'asw') return KNOWN_EQUIPMENT_TYPES.SONAR;
  if (topStat === 'aa') return KNOWN_EQUIPMENT_TYPES.AA_GUN;
  if (topStat === 'recon') return KNOWN_EQUIPMENT_TYPES.RADAR;
  if (topStat === 'firepower') return KNOWN_EQUIPMENT_TYPES.MAIN_GUN;
  if (topStat === 'evasion') return KNOWN_EQUIPMENT_TYPES.ENGINE;
  if (topStat === 'armor' || topStat === 'maxHp') return KNOWN_EQUIPMENT_TYPES.ARMOR;

  return fallback;
}

// ============================================================
// Compressed 2-Digit Stat Curve Normalization (Lossless Legacy / External JSON Support)
// ============================================================

export const RARITY_STAT_BUDGETS = Object.freeze({
  common: { min: 2, max: 4 },
  uncommon: { min: 4, max: 7 },
  rare: { min: 7, max: 11 },
  epic: { min: 11, max: 16 },
  legendary: { min: 16, max: 22 },
});

/**
 * Smoothly compress legacy inflated 3-digit bare ship stats (e.g. from pre-v25 saves or external JSON mods)
 * onto the new 2-digit curve: Lv.1 base 8..25 + 0.30..0.50/lv growth -> Lv.100 bare 40..75.
 * Idempotent: tags `meta.statScaleVersion = 2` so already-compressed ships are never touched twice.
 */
export function normalizeLegacyShipStatsToCompressedScale(entity) {
  if (!entity || typeof entity !== 'object' || entity.kind !== 'character') return false;
  if (!entity.stats || typeof entity.stats !== 'object') entity.stats = {};
  if (!entity.meta || typeof entity.meta !== 'object') entity.meta = {};
  if (Number(entity.meta.statScaleVersion) >= 2) return false;

  const lv = clamp(Math.floor(Number(entity.stats.level ?? 1) || 1), 1, 100);
  const combatKeys = ['firepower', 'armor', 'torpedo', 'evasion', 'recon', 'aa', 'asw'];
  const maxCombatStat = Math.max(...combatKeys.map((k) => Number(entity.stats[k]) || 0));
  const curMaxHp = Number(entity.stats.maxHp) || 32;
  const expectedBareCap = 28 + Math.round((lv - 1) * 0.52);

  // Only compress if clearly on the legacy 40~100+ bare scale
  const needsCompress = maxCombatStat > expectedBareCap + 10 || curMaxHp > 58 + Math.round((lv - 1) * 0.7);
  if (!needsCompress) {
    entity.meta.statScaleVersion = 2;
    return false;
  }

  const profile = getShipClassProfile(entity.meta.shipType || '');
  const hpRatio = clamp((Number(entity.stats.hp ?? curMaxHp) || curMaxHp) / Math.max(1, curMaxHp), 0, 1);

  // Smoothly compress each combat stat while preserving the ship's relative strengths/archetype
  for (const k of combatKeys) {
    const raw = Number(entity.stats[k]) || 0;
    const lv1Target = clamp(Math.round(8 + (clamp(raw, 0, 110) / 110) * 17), 8, 25);
    const g = Number(profile.growth?.[k]) || 0.38;
    entity.stats[k] = clamp(Math.round(lv1Target + g * (lv - 1)), 8, 75);
  }
  const lv1Hp = clamp(Math.round(24 + (clamp(curMaxHp, 40, 160) - 40) / 120 * 24), 24, 48);
  const hpG = Number(profile.growth?.maxHp) || 0.52;
  const nextMaxHp = clamp(Math.round(lv1Hp + hpG * (lv - 1)), 24, 115);
  entity.stats.maxHp = nextMaxHp;
  entity.stats.hp = Math.max(1, Math.round(nextMaxHp * hpRatio));
  entity.meta.statScaleVersion = 2;
  delete entity.meta.lv1BaseStats;
  return true;
}

/**
 * Smoothly compress legacy inflated equipment bonuses onto the v25 budget:
 *   White +2~4, Green +4~7, Blue +7~11, Purple +11~16, Orange +16~22 (before +1~+10 enhance).
 */
export function normalizeLegacyItemBonusesToCompressedScale(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.category === 'consumable') {
    item.statScaleVersion = 2;
    return item;
  }
  if (Number(item.statScaleVersion) >= 2) return item;

  const baseList = Array.isArray(item.baseBonuses) && item.baseBonuses.length > 0 ? item.baseBonuses : item.bonuses;
  if (!Array.isArray(baseList) || baseList.length === 0) {
    item.statScaleVersion = 2;
    return item;
  }

  const rarityId = inferItemRarity(item);
  const budget = RARITY_STAT_BUDGETS[rarityId] || RARITY_STAT_BUDGETS.common;
  const flatStats = baseList.filter((b) => b && b.stat !== 'checkBonus' && b.layer !== 'percentAdd' && b.layer !== 'percentMult');
  const maxSingle = flatStats.reduce((m, b) => Math.max(m, Math.abs(Number(b.value) || 0)), 0);

  if (maxSingle <= budget.max + 2) {
    item.statScaleVersion = 2;
    return item;
  }

  const scaleFactor = budget.max / Math.max(1, maxSingle);
  const compressedBase = baseList.map((b) => {
    if (!b || b.stat === 'checkBonus' || b.layer === 'percentAdd' || b.layer === 'percentMult') {
      return { ...b };
    }
    const raw = Number(b.value) || 0;
    const sign = raw < 0 ? -1 : 1;
    const scaled = Math.max(budget.min >= 4 ? 2 : 1, Math.min(budget.max, Math.round(Math.abs(raw) * scaleFactor)));
    return { ...b, value: sign * scaled };
  });

  item.baseBonuses = compressedBase;
  if (!Number(item.level)) {
    item.bonuses = compressedBase.map((b) => ({ ...b }));
  }
  item.statScaleVersion = 2;
  return item;
}

export const BASE_AFFINITY_CAP = 100;
export const OATH_AFFINITY_CAP = 150;
export const OATH_BOND_STAT_BONUS = 4;
export const OATH_BOND_STAT_KEYS = Object.freeze(['firepower', 'armor', 'torpedo', 'evasion', 'recon', 'aa']);
export const OATH_SORTIE_COST_DISCOUNT = 0.1;
export const OATH_DORM_MORALE_MULT = 1.35;

/**
 * Authoritative permanent 「誓约羁绊」 stat modifiers (+4 to all 6 core combat stats)
 * keeping 2-digit / late-game balance clean across EntitySystem & UI breakdown panels.
 */
export function getOathBondModifiers(characterId, oathTitle = '永恒誓约') {
  const cid = String(characterId || '');
  const title = String(oathTitle || '永恒誓约').trim() || '永恒誓约';
  return OATH_BOND_STAT_KEYS.map((stat, idx) => ({
    id: `oath_bond_${cid}_${idx}`,
    stat,
    layer: 'baseAdd',
    value: OATH_BOND_STAT_BONUS,
    source: `誓约羁绊 · ${title}`,
    enabled: true,
  }));
}




