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
  '工作舰',
]);

/**
 * 5 Canonical Ship-Class Profiles:
 * Differentiated per-level stat growth, combat role modifiers, base step cost, and geometric SVG emblem.
 */
export const SHIP_CLASS_PROFILES = Object.freeze({
  DD: {
    code: 'DD',
    name: '驱逐',
    fullName: '驱逐舰',
    color: '#38bdf8',
    roleSummary: '高机动/雷击/反潜 · 鱼雷高破甲高暴击 · 反潜巨额克制 · 消耗最低',
    growth: { maxHp: 2, firepower: 1, armor: 1, torpedo: 3, evasion: 3, recon: 1, aa: 1, asw: 3 },
    stepCost: { fuel: 6, ammo: 6 },
    combat: {
      torpedoArmorPen: 0.55,
      torpedoCritMult: 2.15,
      aswCounterMult: 1.75,
    },
  },
  CL: {
    code: 'CL',
    name: '轻巡',
    fullName: '轻巡洋舰',
    color: '#2dd4bf',
    roleSummary: '均衡成长 · 突出防空/反潜/侦查 · 提升全队扫描与防空屏障',
    growth: { maxHp: 3, firepower: 2, armor: 2, torpedo: 2, evasion: 2, recon: 3, aa: 3, asw: 3 },
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
    roleSummary: '侧重火力/装甲/耐久 · 常规炮击扎实 · 僚机援护挡伤率与减伤大增',
    growth: { maxHp: 4, firepower: 3, armor: 3, torpedo: 1, evasion: 1, recon: 2, aa: 2, asw: 1 },
    stepCost: { fuel: 13, ammo: 13 },
    combat: {
      shellingBonusMult: 1.12,
      guardChanceBonus: 0.18,
      guardDamageMult: 0.36,
    },
  },
  BB: {
    code: 'BB',
    name: '战列',
    fullName: '战列舰',
    color: '#f87171',
    roleSummary: '最高耐久/火力/装甲 · 重炮高破甲系数击穿重甲 · 消耗最高',
    growth: { maxHp: 6, firepower: 4, armor: 4, torpedo: 0, evasion: 0, recon: 1, aa: 2, asw: 0 },
    stepCost: { fuel: 18, ammo: 20 },
    combat: {
      shellingBonusMult: 1.24,
      shellingArmorPen: 0.45,
    },
  },
  CV: {
    code: 'CV',
    name: '航母',
    fullName: '航空母舰',
    color: '#a78bfa',
    roleSummary: '高侦查/防空/耐久 · 炮击转为舰载机空袭（无视前排护甲）· 扩大海图视野',
    growth: { maxHp: 4, firepower: 2, armor: 2, torpedo: 0, evasion: 1, recon: 4, aa: 4, asw: 1 },
    stepCost: { fuel: 16, ammo: 14 },
    combat: {
      airstrikeMode: true,
      visionRangeBonus: 1,
    },
  },
});

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
 * Map any Chinese/English/custom shipType string to one of the 5 canonical class codes ('DD'|'CL'|'CA'|'BB'|'CV').
 */
export function resolveShipClass(shipType = '') {
  const s = String(shipType || '').trim().toUpperCase();
  if (!s) return 'DD';
  if (s.includes('航母') || s.includes('空母') || s.includes('CV') || s.includes('CARRIER')) return 'CV';
  if (s.includes('战列') || s.includes('战巡') || s.includes('BB') || s.includes('BATTLESHIP')) return 'BB';
  if (s.includes('重巡') || s.includes('CA') || s.includes('HEAVY')) return 'CA';
  if (s.includes('轻巡') || s.includes('CL') || s.includes('工作') || s.includes('LIGHT')) return 'CL';
  if (s.includes('驱逐') || s.includes('潜艇') || s.includes('DD') || s.includes('SS') || s.includes('DESTROYER')) return 'DD';
  return 'CL';
}

export function getShipClassProfile(shipType = '') {
  const code = resolveShipClass(shipType);
  return SHIP_CLASS_PROFILES[code] || SHIP_CLASS_PROFILES.CL;
}

/**
 * Authoritative definitions for all Ship-Class Exclusive Tactical Commands + Universal Evade/Retreat.
 */
export const TACTICAL_ACTION_DEFS = Object.freeze({
  torpedo_strike: {
    id: 'torpedo_strike',
    label: '鱼雷突击',
    shortLabel: '鱼雷突击',
    desc: '近/中距离高破甲暴击打击（近距额外 +30%）',
    statKey: 'torpedo',
    kind: 'attack',
    visualStyle: 'torpedo',
    tone: 'torpedo',
    idealRanges: ['close', 'medium'],
    cost: { fuel: 0, ammo: 10 },
  },
  depth_asw: {
    id: 'depth_asw',
    label: '深水反潜',
    shortLabel: '深水反潜',
    desc: '克制水下潜艇造成巨额克制伤害并压制伏击',
    statKey: 'asw',
    kind: 'attack',
    visualStyle: 'asw',
    tone: 'scan',
    idealRanges: ['close', 'medium'],
    cost: { fuel: 0, ammo: 6 },
  },
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
    cost: { fuel: 6, ammo: 0 },
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
    cost: { fuel: 8, ammo: 0 },
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
    cost: { fuel: 0, ammo: 8 },
  },
  aa_alert: {
    id: 'aa_alert',
    label: '防空警戒',
    shortLabel: '防空警戒',
    desc: '2 回合内大幅削减敌方空袭伤害并击落来袭敌机',
    statKey: 'aa',
    kind: 'support',
    visualStyle: 'aa',
    tone: 'support',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 0, ammo: 6 },
  },
  radar_scan: {
    id: 'radar_scan',
    label: '雷达扫描',
    shortLabel: '雷达扫描',
    desc: '揭露敌舰完整护甲/弱点/意图，全队锁定命中 +3',
    statKey: 'recon',
    kind: 'recon',
    visualStyle: 'scan',
    tone: 'scan',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 4, ammo: 0 },
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
    cost: { fuel: 0, ammo: 10 },
  },
  vanguard_guard: {
    id: 'vanguard_guard',
    label: '前排援护',
    shortLabel: '前排援护',
    desc: '2 回合内为低血量队友构筑护盾分担 60% 伤害',
    statKey: 'armor',
    kind: 'support',
    visualStyle: 'guard',
    tone: 'support',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 4, ammo: 0 },
  },
  main_salvo: {
    id: 'main_salvo',
    label: '主炮齐射',
    shortLabel: '主炮齐射',
    desc: '无视 45% 护甲的高额远程战列齐射（远/中距最佳）',
    statKey: 'firepower',
    kind: 'attack',
    visualStyle: 'shelling',
    tone: 'shelling',
    idealRanges: ['long', 'medium'],
    cost: { fuel: 0, ammo: 14 },
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
    cost: { fuel: 0, ammo: 12 },
  },
  carrier_airstrike: {
    id: 'carrier_airstrike',
    label: '舰载机空袭',
    shortLabel: '舰载机空袭',
    desc: '远程无视前排护甲精确轰炸（受敌方防空削减）',
    statKey: 'firepower',
    kind: 'attack',
    visualStyle: 'airstrike',
    tone: 'airstrike',
    idealRanges: ['long', 'medium'],
    cost: { fuel: 4, ammo: 10 },
  },
  carrier_recon: {
    id: 'carrier_recon',
    label: '舰载侦察',
    shortLabel: '舰载侦察',
    desc: '大范围揭露全部敌舰情报告并提升全队暴击 +20%',
    statKey: 'recon',
    kind: 'recon',
    visualStyle: 'scan',
    tone: 'scan',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 4, ammo: 0 },
  },
  evade_retreat: {
    id: 'evade_retreat',
    label: '机动迂回/撤退',
    shortLabel: '迂回/撤退',
    desc: '非 BOSS 尝试全队无伤脱离；BOSS 战大幅提升闪避',
    statKey: 'evasion',
    kind: 'maneuver',
    visualStyle: 'evade',
    tone: 'maneuver',
    idealRanges: ['long', 'medium', 'close'],
    cost: { fuel: 10, ammo: 0 },
    universal: true,
  },
});

export const SHIP_CLASS_EXCLUSIVE_ACTIONS = Object.freeze({
  DD: ['torpedo_strike', 'depth_asw', 'smoke_screen', 'full_ahead'],
  CL: ['tactical_shelling', 'torpedo_strike', 'aa_alert', 'radar_scan'],
  CA: ['heavy_shelling', 'vanguard_guard', 'full_ahead'],
  BB: ['main_salvo', 'fire_suppress'],
  CV: ['carrier_airstrike', 'carrier_recon'],
});

/**
 * Return the ordered list of tactical action definitions for a shipgirl's class,
 * plus the universal 'evade_retreat' option.
 */
export function getShipClassTacticalActions(shipType = '', { includeUniversal = true, phase = 'day' } = {}) {
  const code = resolveShipClass(shipType);
  const ids = [...(SHIP_CLASS_EXCLUSIVE_ACTIONS[code] || SHIP_CLASS_EXCLUSIVE_ACTIONS.CL)];
  // During night battle, CV can still perform night recon & tactical support strikes
  if (includeUniversal) {
    ids.push('evade_retreat');
  }
  return ids
    .map((id) => TACTICAL_ACTION_DEFS[id])
    .filter(Boolean)
    .map((def) => {
      if (phase === 'night' && def.id === 'carrier_airstrike') {
        return {
          ...def,
          label: '夜间舰载突袭',
          desc: '夜战照明弹引导下的舰载机精确补刀（威力略降）',
        };
      }
      if (phase === 'night' && def.id === 'torpedo_strike') {
        return {
          ...def,
          label: '夜战雷击突击',
          desc: '夜战核心爆发！伤害 +45%、暴击率大幅提升',
        };
      }
      return { ...def };
    });
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
  // CV
  return `<svg class="ship-class-ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 21 17h-6l-3-4-3 4H3L12 3Z" fill="${c}" fill-opacity="0.2"/><path d="M7 20h10"/></svg>`;
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
   * Ensure a character entity has valid level / exp / maxExp fields without overwriting existing stats.
   */
  ensureShipProgression(entity) {
    if (!entity || typeof entity !== 'object') return { level: 1, exp: 0, maxExp: this.getShipMaxExp(1) };
    if (!entity.stats || typeof entity.stats !== 'object') entity.stats = {};
    const lv = clamp(Math.floor(Number(entity.stats.level ?? 1) || 1), 1, this._config.shipLevelMax);
    const maxExp = this.getShipMaxExp(lv);
    const exp = clamp(Math.floor(Number(entity.stats.exp ?? 0) || 0), 0, Math.max(maxExp, 999999));
    entity.stats.level = lv;
    entity.stats.exp = exp;
    entity.stats.maxExp = maxExp;
    return { level: lv, exp, maxExp };
  }

  /**
   * Resolve per-level 8-stat growth weights for a shipgirl based on her ship class (DD/CL/CA/BB/CV)
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
   * Grant experience to a shipgirl character, automatically handling multi-level-up growth & stat refresh.
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
      for (const def of NAVAL_EIGHT_STAT_DEFS) {
        const delta = Math.round((Number(growth[def.key]) || 0) * levelsGained);
        if (delta <= 0) continue;
        const curBase = Number(entity.stats[def.key] ?? def.defaultValue);
        const cap = def.isVital ? 999 : this._config.statMax;
        const nextBase = clamp(curBase + delta, def.min, cap);
        const applied = nextBase - curBase;
        if (applied > 0) {
          entities.setStat(characterId, def.key, nextBase, { min: def.min, max: cap });
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
   * Manually adjust a shipgirl's level (for testing / debugging), applying proportional class growth delta if requested.
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
      for (const def of NAVAL_EIGHT_STAT_DEFS) {
        const delta = Math.round((Number(growth[def.key]) || 0) * levelDelta);
        if (delta === 0) continue;
        const curBase = Number(entity.stats[def.key] ?? def.defaultValue);
        const cap = def.isVital ? 999 : this._config.statMax;
        const nextBase = clamp(curBase + delta, def.min, cap);
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
   * Map affinity (0..100) into 4 stages, optionally lowered by Commander `charisma` thresholdReduction.
   */
  getAffinityStage(affinityValue, { thresholdReduction = 0 } = {}) {
    const val = clamp(Math.round(Number(affinityValue ?? 0)), 0, 100);
    const red = clamp(Math.floor(Number(thresholdReduction) || 0), 0, 20);
    const adjusted = AFFINITY_STAGES.map((s, idx) => ({
      ...s,
      min: idx === 0 ? 0 : Math.max(1, s.min - red),
      max: idx === AFFINITY_STAGES.length - 1 ? 100 : Math.max(idx * 5 + 4, s.max - red),
    }));
    // Ensure contiguous boundaries
    for (let i = 0; i < adjusted.length - 1; i++) {
      adjusted[i].max = Math.max(adjusted[i].min, adjusted[i + 1].min - 1);
    }

    const stage = adjusted.find((s) => val >= s.min && val <= s.max) || adjusted[adjusted.length - 1];
    const span = Math.max(1, stage.max - stage.min + 1);
    const progressInStage = clamp((val - stage.min) / span, 0, 1);
    return {
      value: val,
      stageIndex: stage.stageIndex,
      id: stage.id,
      label: stage.label,
      min: stage.min,
      max: stage.max,
      tone: stage.tone,
      thresholdReduction: red,
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
    desc: '舰炮与穿甲重炮武器，大幅强化火力输出',
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
    desc: '酸素鱼雷与近距雷装，强化雷击与高破甲暴击',
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
    id: KNOWN_EQUIPMENT_TYPES.RADAR,
    label: '雷达',
    slotLabel: '雷达槽',
    group: '战术辅助',
    category: 'extension',
    subGroup: 'tactical',
    defaultIcon: 'radar',
    desc: '相控电探、火控校准与夜战侦察系统',
    keywords: ['雷达', '电探', '侦查', '侦察', '火控', '夜战', '探照灯', '通信', '协同', '增幅', '补给型', 'radar', 'recon'],
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
 * Returns 'outfit' for outfit items, or one of KNOWN_EQUIPMENT_TYPES for all equipment/slots.
 */
export function inferEquipmentTypeId(target = null, fallback = KNOWN_EQUIPMENT_TYPES.MAIN_GUN) {
  if (!target || typeof target !== 'object') return fallback;

  if (target.category === 'outfit' || target.equipmentType === 'outfit' || target.subCategory === 'outfit') {
    return 'outfit';
  }

  // 1. Direct canonical equipmentType / subCategory match
  const explicit = String(target.equipmentType || target.subCategory || '').trim().toLowerCase();
  if (KNOWN_EQUIPMENT_TYPE_MAP[explicit]) return explicit;

  // 2. Mandatory core categories
  if (target.category === 'engine') return KNOWN_EQUIPMENT_TYPES.ENGINE;
  if (target.category === 'armor') return KNOWN_EQUIPMENT_TYPES.ARMOR;
  if (target.category === 'core') return KNOWN_EQUIPMENT_TYPES.CORE;

  // 3. Icon key match
  const icon = String(target.iconKey || '').trim().toLowerCase();
  if (KNOWN_EQUIPMENT_TYPE_MAP[icon]) return icon;

  // 4. Keyword match with priority: name/label -> tags -> description
  const primaryText = `${target.name || ''} ${target.label || ''}`.trim();
  const byPrimary = normalizeEquipmentTypeId(primaryText, null);
  if (byPrimary) return byPrimary;

  const tagsText = Array.isArray(target.tags) ? target.tags.join(' ') : String(target.tags || '');
  const byTags = normalizeEquipmentTypeId(tagsText, null);
  if (byTags) return byTags;

  const byDesc = normalizeEquipmentTypeId(String(target.description || ''), null);
  if (byDesc) return byDesc;

  // 5. Fallback heuristic from dominant stat bonus
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



