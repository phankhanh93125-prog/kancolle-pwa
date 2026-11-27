/**
 * Procedural 1★~5★ Sea Chart & Custom Map Workshop Engine (`route-generator.js`).
 *
 * v25 Upgrades:
 *   - All fixed preset sea charts removed (100% procedural & Custom Map Workshop driven).
 *   - 5-Star Sea Tiers (`star_1`..`star_5`) with exact symmetric 2-digit combat stat standards
 *     and 0%~100% Sea Control progression (reaching 100% unlocks the next star tier + expedition/patrol yield bonus).
 *   - Lossless migration of legacy `low/medium/high` sea control keys (`low`->`star_1`, `medium`->`star_2`, `high`->`star_3`).
 *   - Custom Map Workshop: star 1★~5★, scale (short/medium/long), sea condition (风平浪静/浓雾夜海/狂风巨浪/顺风航流/强电磁干扰),
 *     node mix, enemy fleet bias, deterministic seed code save/load (`encodeMapSeed` / `decodeMapSeed`),
 *     and live estimated supply & loot drop preview (`estimateRouteProfile`).
 *   - Supports Combat, Salvage (refills carried supplies/parts), Temporary Anchorage (AR free bonus repair),
 *     Elite Ambush, Boss Flagship, and Random Maritime Encounters (`story_event`) invoking imported JSON story packs.
 */

import { clamp } from './calc-engine.js';
import {
  STAR_SEA_TIERS,
  STAR_SEA_TIER_ORDER,
  normalizeStarTierId,
} from './stat-rules.js';

const STORAGE_NS = 'core-sortie-routes';
const CUSTOM_ROUTES_KEY = 'custom-routes-v2';
const SEA_CONTROL_KEY = 'sea-control-v2';

export const NODE_TYPES = Object.freeze({
  RESOURCE: 'resource',
  WEATHER: 'weather',
  ANCHORAGE: 'anchorage',
  STORY_EVENT: 'story_event',
  ENCOUNTER: 'encounter',
  ELITE: 'elite',
  BOSS: 'boss',
});

export const NODE_TYPE_LABELS = Object.freeze({
  [NODE_TYPES.RESOURCE]: '海上物资打捞',
  [NODE_TYPES.WEATHER]: '气象/侦察点',
  [NODE_TYPES.ANCHORAGE]: '临时锚地休整',
  [NODE_TYPES.STORY_EVENT]: '随机海遇事件',
  [NODE_TYPES.ENCOUNTER]: '常规遭遇战',
  [NODE_TYPES.ELITE]: '精英伏击战',
  [NODE_TYPES.BOSS]: '终点主力决战',
});

export const BRANCH_LANE_META = Object.freeze({
  main: {
    id: 'main',
    label: '主航道',
    desc: '标准联合舰队行进路线。',
  },
  assault: {
    id: 'assault',
    label: '主力强攻航道',
    desc: '精英伏击密集、正面火力交锋，钢材/铝材与稀有装备掉率 +45%。',
  },
  stealth: {
    id: 'stealth',
    label: '暗流探索航道',
    desc: '多打捞、临时锚地与随机海遇事件，考验侦查反潜且更省携带油弹。',
  },
});

export const MAP_SCALES = Object.freeze({
  short: { id: 'short', label: '短程奇袭 (6节点)', nodeCount: 6, combatEst: 3 },
  medium: { id: 'medium', label: '标准巡航 (9节点)', nodeCount: 9, combatEst: 4 },
  long: { id: 'long', label: '远程破交 (12节点)', nodeCount: 12, combatEst: 6 },
});

export const NODE_MIX_MODES = Object.freeze({
  balanced: { id: 'balanced', label: '均衡综合', desc: '战斗、打捞、锚地与随机海遇均衡分布' },
  combat_heavy: { id: 'combat_heavy', label: '高烈度歼灭', desc: '更多遭遇战与精英伏击，高战利品掉落' },
  salvage_heavy: { id: 'salvage_heavy', label: '后勤打捞线', desc: '增加物资打捞与临时锚地，适合补充油弹与练级' },
  encounter_heavy: { id: 'encounter_heavy', label: '奇遇探索线', desc: '大幅提升随机海遇事件（自动联动外置剧情包）' },
});

export const ENEMY_BIAS_MODES = Object.freeze({
  mixed: { id: 'mixed', label: '联合混编', desc: '水面舰、航母与潜艇综合编队' },
  surface: { id: 'surface', label: '重炮水面群', desc: '战列/重巡为主，考验破甲与防雷' },
  carrier: { id: 'carrier', label: '深海航空群', desc: '航母偏多，考验对空拦截与雷达' },
  submarine: { id: 'submarine', label: '暗流潜艇群', desc: '潜艇与高速驱逐偏多，考验声呐反潜' },
});

function buildSeaDifficultyEntry(tierId) {
  const s = STAR_SEA_TIERS[tierId] || STAR_SEA_TIERS.star_1;
  const star = Number(s.star ?? s.starLevel ?? 1) || 1;
  const hpArr = Array.isArray(s.enemyHp) ? s.enemyHp : Array.isArray(s.hpRange) ? s.hpRange : [25, 45];
  const armorArr = Array.isArray(s.enemyArmor) ? s.enemyArmor : Array.isArray(s.armorRange) ? s.armorRange : [8, 18];
  const atkArr = Array.isArray(s.enemyAtk) ? s.enemyAtk : Array.isArray(s.atkRange) ? s.atkRange : [15, 28];
  const stepCost = s.stepCost && typeof s.stepCost === 'object'
    ? { fuel: Number(s.stepCost.fuel) || 12, ammo: Number(s.stepCost.ammo) || 10 }
    : { fuel: 8 + star * 4, ammo: 6 + star * 4 };
  return Object.freeze({
    id: s.id,
    star,
    starLevel: star,
    code: s.code || `${star}★`,
    label: s.label || `${star}★ 海域`,
    name: s.name || String(s.label || `${star}★ 海域`).replace(/^\d+★\s*/, ''),
    nodeRange: star <= 2 ? [7, 9] : star <= 4 ? [9, 11] : [10, 12],
    baseDc: 10 + star,
    apCost: 8 + star * 3,
    stepCost,
    enemyHpRange: [...hpArr],
    enemyArmorRange: [...armorArr],
    enemyAtkRange: [...atkArr],
    bossMaxAtk: Number(s.bossMaxAtk ?? s.bossCap ?? atkArr[1]) || atkArr[1],
    lootScale: Number(s.lootScale) || 1.0,
    goldBonus: Number(s.goldBonus) || 3,
    dropHint:
      star === 1
        ? '白~蓝装为主 · 新手练级与物资打捞'
        : star === 2
        ? '绿~紫装 · 后勤支援装备开始掉落'
        : star === 3
        ? '蓝~紫装为主 · 少量橙装掉落'
        : star === 4
        ? '紫~橙装高概率 · 精锐支援与核心部件'
        : '顶级紫/橙装高爆率 · 传说武装与丰厚金条',
  });
}

const STAR_DIFF_MAP = {
  star_1: buildSeaDifficultyEntry('star_1'),
  star_2: buildSeaDifficultyEntry('star_2'),
  star_3: buildSeaDifficultyEntry('star_3'),
  star_4: buildSeaDifficultyEntry('star_4'),
  star_5: buildSeaDifficultyEntry('star_5'),
};

// Backward-compatible aliases so legacy callers using 'low'/'medium'/'high' still resolve cleanly
export const SEA_DIFFICULTIES = Object.freeze({
  ...STAR_DIFF_MAP,
  low: STAR_DIFF_MAP.star_1,
  medium: STAR_DIFF_MAP.star_2,
  high: STAR_DIFF_MAP.star_3,
});

export const SEA_CONDITIONS = Object.freeze([
  {
    id: 'calm_sea',
    label: '风平浪静',
    description: '海况稳定，全行动 d20 检定 +1，航行平稳。',
    mods: { checkBonus: 1, fuelDelta: 0, scanDcDelta: 0, evadeBonus: 0, dmgMult: 1.0 },
  },
  {
    id: 'dense_fog_night',
    label: '浓雾夜海',
    description: '能见度骤降，索敌难度提升，鱼雷与奇袭威力 +12%，迂回 +2。',
    mods: { checkBonus: 0, fuelDelta: 0, scanDcDelta: 2, evadeBonus: 2, dmgMult: 1.12, nightFog: true },
  },
  {
    id: 'heavy_storm',
    label: '狂风巨浪',
    description: '风浪剧烈，步进燃油 +4，机动 -1，但炮雷破甲伤害 +15%。',
    mods: { checkBonus: -1, fuelDelta: 4, scanDcDelta: 1, evadeBonus: -1, dmgMult: 1.15 },
  },
  {
    id: 'tailwind',
    label: '顺风航流',
    description: '顺流加速，每步携带燃油消耗 -4，机动检定 +1。',
    mods: { checkBonus: 0, fuelDelta: -4, scanDcDelta: 0, evadeBonus: 1, dmgMult: 1.0 },
  },
  {
    id: 'em_storm',
    label: '强电磁干扰',
    description: '雷达波杂乱，索敌难度 +1，但锁定后的精准打击伤害 +15%。',
    mods: { checkBonus: 0, fuelDelta: 0, scanDcDelta: 1, evadeBonus: 0, dmgMult: 1.15 },
  },
]);

export const SEA_CONTROL_ZONES = Object.freeze(
  STAR_SEA_TIER_ORDER.map((tierId, idx) => {
    const s = STAR_SEA_TIERS[tierId] || STAR_SEA_TIERS.star_1;
    const star = Number(s.star ?? s.starLevel ?? idx + 1) || (idx + 1);
    return Object.freeze({
      id: s.id,
      star,
      code: s.code || `${star}★`,
      name: s.name || String(s.label || `${star}★ 海域`).replace(/^\d+★\s*/, ''),
      difficultyLabel: s.label || `${star}★ 海域`,
      bossGainPct: Number(s.bossGainPct) || 30,
      expeditionYieldBonusPct: Number(s.expeditionYieldBonusPct) || 8 + idx * 6,
      patrolYieldBonusPct: Number(s.patrolYieldBonusPct) || 10 + idx * 8,
      unlockRequires: idx > 0 ? STAR_SEA_TIER_ORDER[idx - 1] : null,
    });
  })
);

const ROUTE_PREFIXES = {
  star_1: ['近海巡逻扇区', '港外岛礁线', '海湾打捞航道', '浅海护航区'],
  star_2: ['外海破交航线', '珊瑚礁巡弋区', '岛链钳形海域', '商路护卫线'],
  star_3: ['深水前线扇区', '铁底海峡航道', '风暴侦察航线', '迷雾封锁区'],
  star_4: ['外围要塞航道', '深渊强袭扇区', '联合决战海域', '高压突破线'],
  star_5: ['深渊中枢王座', '极境最终海域', '深海核心裂隙', '决战风暴眼'],
};

const NODE_NAMES = {
  [NODE_TYPES.RESOURCE]: ['漂流补给箱群', '沉船物资打捞点', '废弃油料浮标', '散落军需集装箱'],
  [NODE_TYPES.WEATHER]: ['海雾气象观测点', '洋流侦察信标', '高空无人机监测带', '暗流声呐监听站'],
  [NODE_TYPES.ANCHORAGE]: ['隐蔽避风锚地', '前线浮船坞锚地', '无人礁盘整备湾', '临时海上补给锚地'],
  [NODE_TYPES.STORY_EVENT]: ['神秘漂流信号', '迷雾中的旧港区遗址', '偶遇商船护航请求', '海面星光奇遇'],
  [NODE_TYPES.ENCOUNTER]: ['深海前哨巡逻群', '轻型警戒编队', '游弋侦察舰队', '外围拦阻中队'],
  [NODE_TYPES.ELITE]: ['深海精英伏击群', '重装封锁编队', '装甲拦截中队', '高速突击猎杀队'],
  [NODE_TYPES.BOSS]: ['海域深海旗舰群', '中枢要塞守卫旗舰', '深渊核心联合舰队'],
};

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function hashSeedString(seedStr = '') {
  let h = 2166136261 >>> 0;
  const s = String(seedStr || 'KANCOLLE');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h || 133791;
}

export function createSeededRng(seedStr) {
  let state = hashSeedString(seedStr);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randInt(min, max, rng = Math.random) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

function pickRandom(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Encode / Decode compact shareable Map Workshop seed code:
 * Format: `S{1..5}-{S|M|L}-{condIdx}-{mixIdx}-{biasIdx}-{4charSalt}`
 */
const SCALE_CODE = { short: 'S', medium: 'M', long: 'L' };
const SCALE_FROM_CODE = { S: 'short', M: 'medium', L: 'long' };
const MIX_LIST = ['balanced', 'combat_heavy', 'salvage_heavy', 'encounter_heavy'];
const BIAS_LIST = ['mixed', 'surface', 'carrier', 'submarine'];

export function encodeMapSeed({
  starLevel = 1,
  scale = 'medium',
  seaConditionId = 'random',
  nodeMix = 'balanced',
  enemyBias = 'mixed',
  salt = '',
} = {}) {
  const s = clamp(Math.floor(Number(starLevel) || 1), 1, 5);
  const sc = SCALE_CODE[scale] || 'M';
  const condIdx = seaConditionId === 'random' ? 'R' : Math.max(0, SEA_CONDITIONS.findIndex((c) => c.id === seaConditionId));
  const mixIdx = Math.max(0, MIX_LIST.indexOf(nodeMix));
  const biasIdx = Math.max(0, BIAS_LIST.indexOf(enemyBias));
  const cleanSalt =
    String(salt || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 5) || Math.random().toString(36).slice(2, 6).toUpperCase();
  return `S${s}-${sc}-${condIdx}-${mixIdx}-${biasIdx}-${cleanSalt}`;
}

export function decodeMapSeed(seedCode = '') {
  const raw = String(seedCode || '').trim().toUpperCase();
  const parts = raw.split('-');
  if (parts.length < 6 || !parts[0].startsWith('S')) {
    return null;
  }
  const starLevel = clamp(parseInt(parts[0].slice(1), 10) || 1, 1, 5);
  const scale = SCALE_FROM_CODE[parts[1]] || 'medium';
  const condRaw = parts[2];
  const seaConditionId =
    condRaw === 'R'
      ? 'random'
      : SEA_CONDITIONS[clamp(parseInt(condRaw, 10) || 0, 0, SEA_CONDITIONS.length - 1)]?.id || 'random';
  const nodeMix = MIX_LIST[clamp(parseInt(parts[3], 10) || 0, 0, MIX_LIST.length - 1)] || 'balanced';
  const enemyBias = BIAS_LIST[clamp(parseInt(parts[4], 10) || 0, 0, BIAS_LIST.length - 1)] || 'mixed';
  const salt = parts[5] || '0000';
  return {
    starLevel,
    difficulty: `star_${starLevel}`,
    scale,
    seaConditionId,
    nodeMix,
    enemyBias,
    salt,
    seedCode: `S${starLevel}-${SCALE_CODE[scale]}-${condRaw === 'R' ? 'R' : clamp(parseInt(condRaw, 10) || 0, 0, SEA_CONDITIONS.length - 1)}-${MIX_LIST.indexOf(nodeMix)}-${BIAS_LIST.indexOf(enemyBias)}-${salt}`,
  };
}

/**
 * Live preview helper for Custom Map Workshop UI (estimated oil/ammo & loot drop).
 */
export function estimateRouteProfile({
  starLevel = 1,
  difficulty = null,
  scale = 'medium',
  seaConditionId = 'random',
  nodeMix = 'balanced',
} = {}) {
  const diffId = difficulty ? normalizeStarTierId(difficulty) : `star_${clamp(Math.floor(Number(starLevel) || 1), 1, 5)}`;
  const tier = SEA_DIFFICULTIES[diffId] || SEA_DIFFICULTIES.star_1;
  const scaleMeta = MAP_SCALES[scale] || MAP_SCALES.medium;
  const cond = SEA_CONDITIONS.find((c) => c.id === seaConditionId) || null;
  const stepFuel = Math.max(8, tier.stepCost.fuel + (cond?.mods?.fuelDelta || 0));
  const stepAmmo = tier.stepCost.ammo;
  // Main path traverses roughly 60%~70% of total branching nodes
  const pathSteps = Math.max(4, Math.round(scaleMeta.nodeCount * 0.65));
  const combatFactor = nodeMix === 'combat_heavy' ? 1.2 : nodeMix === 'salvage_heavy' ? 0.8 : 1.0;
  const estFuel = Math.round(stepFuel * pathSteps);
  const estAmmo = Math.round(stepAmmo * Math.max(3, Math.round(scaleMeta.combatEst * combatFactor)));
  return {
    difficulty: tier.id,
    star: tier.star,
    tierLabel: tier.label,
    nodeCount: scaleMeta.nodeCount,
    pathSteps,
    stepFuel,
    stepAmmo,
    estFuel,
    estAmmo,
    dropHint: tier.dropHint,
    enemySummary: `攻 ${tier.enemyAtkRange[0]}~${tier.enemyAtkRange[1]} · 甲 ${tier.enemyArmorRange[0]}~${tier.enemyArmorRange[1]} · 耐久 ${tier.enemyHpRange[0]}~${tier.enemyHpRange[1]}`,
  };
}

/**
 * Symmetric 2-digit enemy class multipliers matching player ship classes cleanly.
 */
const ENEMY_CLASS_ARCHETYPES = Object.freeze({
  BOSS: {
    shipClass: 'BOSS',
    role: 'boss',
    title: '深海要塞旗舰',
    hpMult: 1.25,
    armorMult: 1.15,
    atkMult: 1.14,
    evaMult: 0.78,
    aaMult: 1.1,
    aswMult: 0.75,
    torpMult: 0.9,
    stealth: 16,
    weakness: 'torpedo',
    weaknessLabel: '鱼雷/破甲弱点',
  },
  BB: {
    shipClass: 'BB',
    role: 'battleship',
    title: '深海战列舰',
    hpMult: 1.14,
    armorMult: 1.16,
    atkMult: 1.1,
    evaMult: 0.62,
    aaMult: 0.85,
    aswMult: 0.45,
    torpMult: 0.35,
    stealth: 10,
    weakness: 'torpedo',
    weaknessLabel: '鱼雷弱点',
  },
  CV: {
    shipClass: 'CV',
    role: 'carrier',
    title: '深海航母',
    hpMult: 1.0,
    armorMult: 0.86,
    atkMult: 1.02,
    evaMult: 0.85,
    aaMult: 1.15,
    aswMult: 0.48,
    torpMult: 0.25,
    stealth: 14,
    weakness: 'aa',
    weaknessLabel: '防空/空袭弱点',
  },
  CA: {
    shipClass: 'CA',
    role: 'cruiser',
    title: '深海重巡洋舰',
    hpMult: 0.96,
    armorMult: 1.02,
    atkMult: 0.98,
    evaMult: 0.92,
    aaMult: 0.9,
    aswMult: 0.65,
    torpMult: 0.82,
    stealth: 14,
    weakness: 'shelling',
    weaknessLabel: '炮击弱点',
  },
  CL: {
    shipClass: 'CL',
    role: 'escort',
    title: '深海轻巡洋舰',
    hpMult: 0.82,
    armorMult: 0.82,
    atkMult: 0.88,
    evaMult: 1.05,
    aaMult: 1.0,
    aswMult: 1.05,
    torpMult: 0.92,
    stealth: 16,
    weakness: 'shelling',
    weaknessLabel: '炮击弱点',
  },
  DD: {
    shipClass: 'DD',
    role: 'destroyer',
    title: '深海高速驱逐舰',
    hpMult: 0.72,
    armorMult: 0.66,
    atkMult: 0.84,
    evaMult: 1.24,
    aaMult: 0.78,
    aswMult: 1.1,
    torpMult: 1.12,
    stealth: 20,
    weakness: 'shelling',
    weaknessLabel: '炮击弱点',
  },
  SS: {
    shipClass: 'SS',
    role: 'sub',
    title: '深海猎杀潜艇',
    hpMult: 0.66,
    armorMult: 0.58,
    atkMult: 0.9,
    evaMult: 1.18,
    aaMult: 0.35,
    aswMult: 0.5,
    torpMult: 1.22,
    stealth: 28,
    weakness: 'asw',
    weaknessLabel: '反潜弱点',
  },
});

/**
 * Build a single enemy ship unit strictly calibrated to the 1★~5★ symmetric 2-digit combat spec.
 */
export function buildEnemyUnitByClass(shipClass, idx, tierCfg, {
  type = NODE_TYPES.ENCOUNTER,
  baseName = '',
  depthRatio = 0,
  strengthMultiplier = 1.0,
  rng = Math.random,
} = {}) {
  const tierId = normalizeStarTierId(tierCfg?.id || 'star_1');
  const starSpec = STAR_SEA_TIERS[tierId] || STAR_SEA_TIERS.star_1;
  const arch = ENEMY_CLASS_ARCHETYPES[shipClass] || ENEMY_CLASS_ARCHETYPES.DD;
  const depthScale = 1 + clamp(Number(depthRatio) || 0, 0, 1) * 0.14;
  const strMult = clamp(Number(strengthMultiplier) || 1.0, 0.5, 2.5);
  const tierMult = type === NODE_TYPES.BOSS ? 1.12 : type === NODE_TYPES.ELITE ? 1.05 : 0.96;

  const hpArr = Array.isArray(starSpec.enemyHp) ? starSpec.enemyHp : Array.isArray(starSpec.hpRange) ? starSpec.hpRange : [25, 45];
  const armorArr = Array.isArray(starSpec.enemyArmor) ? starSpec.enemyArmor : Array.isArray(starSpec.armorRange) ? starSpec.armorRange : [8, 18];
  const atkArr = Array.isArray(starSpec.enemyAtk) ? starSpec.enemyAtk : Array.isArray(starSpec.atkRange) ? starSpec.atkRange : [15, 28];
  const bossCapVal = Number(starSpec.bossMaxAtk ?? starSpec.bossCap ?? atkArr[1]) || atkArr[1];
  const starNum = Number(starSpec.star ?? starSpec.starLevel ?? 1) || 1;

  const rawHp = randInt(hpArr[0], hpArr[1], rng);
  const rawArmor = randInt(armorArr[0], armorArr[1], rng);
  const rawAtk = randInt(atkArr[0], atkArr[1], rng);

  const maxAtkCap = arch.shipClass === 'BOSS' || type === NODE_TYPES.BOSS ? bossCapVal : atkArr[1];
  const unitHp = clamp(
    Math.round(rawHp * arch.hpMult * depthScale * tierMult * strMult),
    Math.round(hpArr[0] * 0.7),
    Math.round(hpArr[1] * (arch.shipClass === 'BOSS' ? 1.22 : 1.05) * strMult)
  );
  const unitArmor = clamp(
    Math.round(rawArmor * arch.armorMult * (0.9 + strMult * 0.1)),
    Math.max(4, Math.round(armorArr[0] * 0.65)),
    Math.round(armorArr[1] * (arch.shipClass === 'BOSS' ? 1.1 : 1.02))
  );
  const unitAtk = clamp(
    Math.round(rawAtk * arch.atkMult * depthScale * tierMult * (0.85 + strMult * 0.15)),
    Math.max(10, Math.round(atkArr[0] * 0.8)),
    Math.round(maxAtkCap * Math.max(1, strMult * 0.95))
  );

  // Symmetric secondary attributes aligned to the same 2-digit combat band
  const baseSec = Math.round((rawAtk + rawArmor) * 0.5);
  const evasion = clamp(Math.round(baseSec * arch.evaMult), 10, 115);
  const aa = clamp(Math.round(baseSec * arch.aaMult), 8, 120);
  const asw = clamp(Math.round(baseSec * arch.aswMult), 8, 105);
  const torpedo = clamp(Math.round(rawAtk * arch.torpMult), 8, maxAtkCap);

  const labelIdx = idx === 0 && baseName ? `${baseName} · 旗舰` : `${arch.title} #${idx + 1}`;
  return {
    id: `en_${idx + 1}`,
    name: labelIdx,
    shipClass: arch.shipClass,
    role: arch.role,
    tier: type,
    star: starNum,
    hp: unitHp,
    maxHp: unitHp,
    armor: unitArmor,
    attackPower: unitAtk,
    evasion,
    aa,
    asw,
    torpedo,
    stealth: Math.round(arch.stealth + starSpec.star * 4),
    airThreat: arch.shipClass === 'CV' || arch.shipClass === 'BOSS' ? Math.round(unitAtk * 0.72) : 0,
    subThreat: arch.shipClass === 'SS' ? Math.round(torpedo * 0.68) : 0,
    weakness: arch.weakness,
    weaknessLabel: arch.weaknessLabel,
    threatLabel:
      arch.shipClass === 'SS'
        ? '水下潜艇'
        : arch.shipClass === 'CV'
        ? '深海航空编队'
        : arch.shipClass === 'CA'
        ? '重巡护卫'
        : arch.shipClass === 'BB' || arch.shipClass === 'BOSS'
        ? '主力重炮'
        : '高速前卫',
  };
}

export function buildEnemyTemplate(
  type,
  tierCfg,
  rng = Math.random,
  { lane = 'main', depthRatio = 0, fleetSize = 3, strengthMultiplier = 1.0, enemyBias = 'mixed' } = {}
) {
  const isBoss = type === NODE_TYPES.BOSS;
  const isElite = type === NODE_TYPES.ELITE;
  const diffId = normalizeStarTierId(tierCfg?.id || 'star_1');
  const tier = SEA_DIFFICULTIES[diffId] || SEA_DIFFICULTIES.star_1;
  const star = tier.star || 1;
  const depthStep = clamp(Number(depthRatio) || 0, 0, 1);

  const fleetAdj = Math.max(0, Math.round((Number(fleetSize) || 3) - 3) * 0.35);
  let minShips = 2;
  let maxShips = 3;
  if (star >= 5) {
    minShips = isBoss ? 6 : isElite ? 5 : 4;
    maxShips = isBoss ? 9 : isElite ? 7 : 6;
  } else if (star >= 4) {
    minShips = isBoss ? 5 : isElite ? 4 : 3;
    maxShips = isBoss ? 8 : isElite ? 6 : 5;
  } else if (star >= 3) {
    minShips = isBoss ? 4 : isElite ? 3 : 3;
    maxShips = isBoss ? 6 : isElite ? 5 : 4;
  } else if (star === 2) {
    minShips = isBoss ? 3 : isElite ? 3 : 2;
    maxShips = isBoss ? 5 : isElite ? 4 : 3;
  } else {
    minShips = isBoss ? 3 : 2;
    maxShips = isBoss ? 4 : 3;
  }
  const squadCount = clamp(Math.round(randInt(minShips, maxShips, rng) + fleetAdj), 2, 10);

  const baseName =
    enemyBias === 'submarine' || (lane === 'stealth' && !isBoss)
      ? pickRandom(['深海潜艇猎杀群', '暗流隐蔽伏击队', '水下静默雷击群'], rng)
      : enemyBias === 'carrier' && !isBoss
      ? pickRandom(['深海机动航空编队', '海空压制打击群', '黑翼航母特遣队'], rng)
      : enemyBias === 'surface' && !isBoss
      ? pickRandom(['深海重炮主力舰队', '铁甲炮雷突击队', '前线战列编队'], rng)
      : pickRandom(NODE_NAMES[type] || NODE_NAMES[NODE_TYPES.ENCOUNTER], rng);

  const classPlan = [];
  if (isBoss) {
    classPlan.push('BOSS');
    if (enemyBias === 'carrier') {
      if (squadCount >= 2) classPlan.push('CV');
      if (squadCount >= 3) classPlan.push('CV');
    } else if (enemyBias === 'submarine') {
      if (squadCount >= 2) classPlan.push('SS');
      if (squadCount >= 3) classPlan.push('DD');
    } else if (enemyBias === 'surface') {
      if (squadCount >= 2) classPlan.push('BB');
      if (squadCount >= 3) classPlan.push('CA');
    } else {
      if (squadCount >= 2) classPlan.push('CV');
      if (squadCount >= 3) classPlan.push('CA');
    }
    if (squadCount >= 4) classPlan.push('BB');
    if (squadCount >= 5) classPlan.push('DD');
  } else if (enemyBias === 'submarine' || lane === 'stealth') {
    classPlan.push('SS');
    if (squadCount >= 2) classPlan.push('DD');
    if (squadCount >= 3) classPlan.push('SS');
  } else if (enemyBias === 'carrier') {
    classPlan.push('CV');
    if (squadCount >= 2) classPlan.push('CL');
    if (squadCount >= 3) classPlan.push('CV');
  } else if (enemyBias === 'surface' || lane === 'assault' || isElite) {
    classPlan.push(rng() < 0.6 ? 'BB' : 'CA');
    if (squadCount >= 2) classPlan.push('CA');
    if (squadCount >= 3) classPlan.push(star >= 3 ? 'CV' : 'CL');
  } else {
    classPlan.push(rng() < 0.5 ? 'CL' : 'CA');
    if (squadCount >= 2) classPlan.push('DD');
  }

  const fillerPool =
    enemyBias === 'submarine' || lane === 'stealth'
      ? ['SS', 'DD', 'CL']
      : enemyBias === 'carrier'
      ? ['CV', 'CL', 'DD', 'CA']
      : enemyBias === 'surface'
      ? ['BB', 'CA', 'CL', 'DD']
      : star >= 3 || isBoss
      ? ['BB', 'CV', 'CA', 'CL', 'DD', 'SS']
      : ['CA', 'CL', 'DD', 'SS'];
  while (classPlan.length < squadCount) {
    classPlan.push(pickRandom(fillerPool, rng));
  }

  const squad = classPlan.map((cls, idx) =>
    buildEnemyUnitByClass(cls, idx, tier, {
      type,
      baseName: idx === 0 ? baseName : '',
      depthRatio: depthStep,
      strengthMultiplier,
      rng,
    })
  );

  const lead = squad[0];
  const airThreat = squad.reduce((m, u) => Math.max(m, u.airThreat || 0), 0);
  const subThreat = squad.reduce((m, u) => Math.max(m, u.subThreat || 0), 0);
  const hasCarriers = squad.some((u) => u.shipClass === 'CV' || u.shipClass === 'BOSS');
  const hasSubs = squad.some((u) => u.shipClass === 'SS');
  const threatLabel =
    hasCarriers && hasSubs
      ? `海空潜联合舰队（${squad.length}舰）`
      : hasSubs
      ? `潜艇伏击集群（${squad.length}舰）`
      : hasCarriers
      ? `机动航空编队（${squad.length}舰）`
      : `水面炮雷舰队（${squad.length}舰）`;

  const weakness = lead?.weakness || (hasSubs ? 'asw' : 'shelling');
  const weaknessLabel = lead?.weaknessLabel || '炮击弱点';
  const isAmbush =
    isElite ? rng() < 0.38 : lane === 'stealth' ? rng() < 0.45 : !isBoss && rng() < (star >= 4 ? 0.24 : 0.12);
  const stealthRating = Math.round(16 + star * 7 + (hasSubs ? 10 : 0) + (lane === 'stealth' ? 10 : 0) + depthStep * 8);

  return {
    name: baseName,
    tier: type,
    difficulty: diffId,
    star,
    depthRatio: Number(depthStep.toFixed(2)),
    forcedEngagement: isBoss,
    isAmbush,
    stealthRating,
    hp: squad.reduce((s, u) => s + u.hp, 0),
    maxHp: squad.reduce((s, u) => s + u.maxHp, 0),
    armor: lead?.armor || tier.enemyArmorRange[0],
    attackPower: lead?.attackPower || tier.enemyAtkRange[0],
    airThreat,
    subThreat,
    threatLabel,
    scanDc: tier.baseDc + (isBoss ? 2 : isElite ? 1 : 0),
    evadeDc: tier.baseDc + (isBoss ? 3 : isElite ? 2 : 0),
    shellingDc: tier.baseDc + (isBoss ? 2 : isElite ? 1 : 0),
    torpedoDc: tier.baseDc + (isBoss ? 3 : isElite ? 2 : 1),
    weakness,
    weaknessLabel,
    squad,
  };
}

/**
 * Legacy export kept as an empty array: all fixed preset sea charts are removed in v25.
 */
export function createPresetRoutes() {
  return [];
}

function createDefaultSeaControlState() {
  const out = {};
  for (const id of STAR_SEA_TIER_ORDER) {
    out[id] = { progress: 0, clearedCount: 0, controlledAt: null };
  }
  return out;
}

export class RouteGenerator {
  constructor({ storage = null, bus = null } = {}) {
    this._scope = storage ? storage.namespace(STORAGE_NS) : null;
    this._bus = bus;
    this._customRoutes = [];
    this._seaControl = createDefaultSeaControlState();
    this._presets = [];
    this._hydrated = false;
  }

  async init() {
    if (this._hydrated) return;
    if (this._scope) {
      const saved = await this._scope.getLarge(CUSTOM_ROUTES_KEY, null);
      const rawRoutes = Array.isArray(saved)
        ? saved
        : await this._scope.getLarge('custom-routes-v1', []);
      this._customRoutes = Array.isArray(rawRoutes)
        ? rawRoutes
            .filter((r) => r && typeof r === 'object' && Array.isArray(r.nodes) && r.nodes.length > 0)
            .map((r) => {
              const copy = deepClone(r);
              const tierId = normalizeStarTierId(copy.difficulty || copy.star || 'star_1');
              const tier = SEA_DIFFICULTIES[tierId] || SEA_DIFFICULTIES.star_1;
              copy.difficulty = tier.id;
              copy.star = tier.star;
              copy.difficultyLabel = copy.difficultyLabel || tier.label;
              if (!copy.stepCost || typeof copy.stepCost !== 'object') {
                copy.stepCost = { ...tier.stepCost };
              }
              return copy;
            })
        : [];
      const savedControl =
        (await this._scope.getLarge(SEA_CONTROL_KEY, null)) ||
        (await this._scope.getLarge('sea-control-v1', null));
      if (savedControl && typeof savedControl === 'object') {
        this.deserializeSeaControl(savedControl, { persist: false });
      }
    }
    this._hydrated = true;
  }

  async persistCustomRoutes() {
    if (!this._scope) return;
    await this._scope.setLarge(CUSTOM_ROUTES_KEY, this._customRoutes);
  }

  async persistSeaControl() {
    if (!this._scope) return;
    await this._scope.setLarge(SEA_CONTROL_KEY, this.serializeSeaControl());
  }

  isSeaZoneUnlocked(difficultyId = 'star_1') {
    const id = normalizeStarTierId(difficultyId);
    const def = SEA_CONTROL_ZONES.find((z) => z.id === id);
    if (!def || !def.unlockRequires) return true;
    const reqState = this._seaControl[def.unlockRequires];
    return Number(reqState?.progress || 0) >= 100;
  }

  getHighestUnlockedStar() {
    let highest = 1;
    for (const z of SEA_CONTROL_ZONES) {
      if (this.isSeaZoneUnlocked(z.id)) highest = Math.max(highest, z.star);
    }
    return highest;
  }

  getSeaControlOverview() {
    let totalExpeditionBonusPct = 0;
    let totalPatrolBonusPct = 0;
    let controlledCount = 0;

    const zones = SEA_CONTROL_ZONES.map((def) => {
      const st = this._seaControl[def.id] || { progress: 0, clearedCount: 0, controlledAt: null };
      const progress = clamp(Math.round(Number(st.progress) || 0), 0, 100);
      const controlled = progress >= 100;
      const unlocked = this.isSeaZoneUnlocked(def.id);
      if (controlled) {
        controlledCount += 1;
        totalExpeditionBonusPct += def.expeditionYieldBonusPct;
        totalPatrolBonusPct += def.patrolYieldBonusPct;
      }
      const reqZone = def.unlockRequires ? SEA_CONTROL_ZONES.find((z) => z.id === def.unlockRequires) : null;
      return {
        ...def,
        progress,
        clearedCount: Math.max(0, Math.floor(Number(st.clearedCount) || 0)),
        controlled,
        unlocked,
        unlockHint: unlocked ? '已开放出征' : `需「${reqZone?.name || '前置星级海域'}」制海权达 100% 解锁`,
      };
    });

    return {
      zones,
      controlledCount,
      totalZones: zones.length,
      highestUnlockedStar: this.getHighestUnlockedStar(),
      totalExpeditionBonusPct,
      totalPatrolBonusPct,
    };
  }

  getExpeditionYieldMultiplier() {
    const ov = this.getSeaControlOverview();
    return Number((1 + ov.totalExpeditionBonusPct / 100).toFixed(2));
  }

  getPatrolYieldMultiplier(difficultyId = 'star_1') {
    const id = normalizeStarTierId(difficultyId);
    const ov = this.getSeaControlOverview();
    const zone = ov.zones.find((z) => z.id === id);
    const localBonus = zone?.controlled ? zone.patrolYieldBonusPct : 0;
    return Number((1 + localBonus / 100).toFixed(2));
  }

  /**
   * Advance 1★~5★ Sea Control progress (0% -> 100%) upon defeating a Boss flagship.
   */
  async recordBossVictory(difficultyId = 'star_1', { isNight = false } = {}) {
    const id = normalizeStarTierId(difficultyId);
    const zoneDef = SEA_CONTROL_ZONES.find((z) => z.id === id) || SEA_CONTROL_ZONES[0];
    const st = this._seaControl[zoneDef.id] || { progress: 0, clearedCount: 0, controlledAt: null };
    const before = clamp(Math.round(Number(st.progress) || 0), 0, 100);
    const gain = zoneDef.bossGainPct || 34;
    const after = clamp(before + gain, 0, 100);
    const newlyControlled = before < 100 && after >= 100;

    st.progress = after;
    st.clearedCount = (Number(st.clearedCount) || 0) + 1;
    if (newlyControlled && !st.controlledAt) st.controlledAt = Date.now();
    this._seaControl[zoneDef.id] = st;

    await this.persistSeaControl();

    const nextZoneDef = SEA_CONTROL_ZONES.find((z) => z.unlockRequires === zoneDef.id) || null;
    const newlyUnlockedZone = newlyControlled && nextZoneDef ? nextZoneDef : null;

    const payload = {
      difficulty: zoneDef.id,
      star: zoneDef.star,
      zoneName: zoneDef.name,
      zoneCode: zoneDef.code,
      before,
      after,
      gain: after - before,
      controlled: after >= 100,
      newlyControlled,
      newlyUnlockedZone,
      isNight: Boolean(isNight),
      overview: this.getSeaControlOverview(),
    };

    if (this._bus) {
      this._bus.emit('sortie:boss-defeated', payload);
      this._bus.emit('sea-control:updated', payload);
    }
    return payload;
  }

  serializeSeaControl() {
    return {
      version: 2,
      zones: deepClone(this._seaControl),
    };
  }

  deserializeSeaControl(snapshot, { persist = true } = {}) {
    const def = createDefaultSeaControlState();
    const rawZones = snapshot?.zones || snapshot || {};
    // Losslessly map both new star_1..star_5 and legacy low/medium/high keys
    const legacyFallback = {
      star_1: rawZones.star_1 || rawZones.low,
      star_2: rawZones.star_2 || rawZones.medium,
      star_3: rawZones.star_3 || rawZones.high,
      star_4: rawZones.star_4,
      star_5: rawZones.star_5,
    };
    for (const z of SEA_CONTROL_ZONES) {
      const src = legacyFallback[z.id];
      if (src && typeof src === 'object') {
        def[z.id] = {
          progress: clamp(Math.round(Number(src.progress) || 0), 0, 100),
          clearedCount: Math.max(0, Math.floor(Number(src.clearedCount) || 0)),
          controlledAt: src.controlledAt || null,
        };
      }
    }
    this._seaControl = def;
    if (persist) this.persistSeaControl();
  }

  getPresetRoutes() {
    return [];
  }

  listCustomRoutes() {
    return deepClone(this._customRoutes);
  }

  listAllRoutes() {
    return this.listCustomRoutes();
  }

  /**
   * Procedurally generate a 1★~5★ branching sea chart with full Custom Map Workshop customization.
   */
  generateRoute({
    difficulty = null,
    starLevel = null,
    scale = 'medium', // 'short' | 'medium' | 'long'
    nodeCount = null,
    seaConditionId = 'random',
    nodeMix = 'balanced',
    enemyBias = 'mixed',
    seedCode = null,
    commander = null,
    customEnemies = [],
    fleetSize = 3,
    strengthMultiplier = 1.0,
    rng = null,
  } = {}) {
    // Decode seedCode if provided
    let parsedSeed = null;
    if (seedCode && String(seedCode).trim()) {
      parsedSeed = decodeMapSeed(seedCode);
    }

    const resolvedStar = parsedSeed
      ? parsedSeed.starLevel
      : starLevel
      ? clamp(Math.floor(Number(starLevel)), 1, 5)
      : (SEA_DIFFICULTIES[normalizeStarTierId(difficulty || 'star_1')]?.star || 1);
    const diffId = `star_${resolvedStar}`;
    const tier = SEA_DIFFICULTIES[diffId] || SEA_DIFFICULTIES.star_1;

    const resolvedScale = parsedSeed?.scale || (MAP_SCALES[scale] ? scale : 'medium');
    const resolvedCondId = parsedSeed?.seaConditionId || seaConditionId || 'random';
    const resolvedMix = parsedSeed?.nodeMix || (NODE_MIX_MODES[nodeMix] ? nodeMix : 'balanced');
    const resolvedBias = parsedSeed?.enemyBias || (ENEMY_BIAS_MODES[enemyBias] ? enemyBias : 'mixed');
    const finalSeedCode =
      parsedSeed?.seedCode ||
      encodeMapSeed({
        starLevel: resolvedStar,
        scale: resolvedScale,
        seaConditionId: resolvedCondId,
        nodeMix: resolvedMix,
        enemyBias: resolvedBias,
      });

    const activeRng = typeof rng === 'function' ? rng : createSeededRng(finalSeedCode);
    const totalNodes = nodeCount
      ? clamp(Math.floor(nodeCount), 6, 12)
      : MAP_SCALES[resolvedScale]?.nodeCount || 9;

    const seaCondition = deepClone(
      resolvedCondId !== 'random'
        ? SEA_CONDITIONS.find((c) => c.id === resolvedCondId) || SEA_CONDITIONS[0]
        : pickRandom(SEA_CONDITIONS, activeRng)
    );

    const stepFuel = Math.max(8, tier.stepCost.fuel + (seaCondition.mods.fuelDelta || 0));
    const stepAmmo = tier.stepCost.ammo;
    const revealChance =
      commander && typeof commander.getRouteRevealChance === 'function'
        ? commander.getRouteRevealChance()
        : 0.28;

    // Branching layout: Entry (2: A->B fork), Upper 'assault' (laneLen), Lower 'stealth' (laneLen), Tail (tailLen -> BOSS)
    const remaining = Math.max(4, totalNodes - 2);
    const laneLen = clamp(Math.floor((remaining - 2) / 2), 1, 3);
    const tailLen = Math.max(2, remaining - laneLen * 2);
    const maxCol = Math.max(1, 2 + laneLen + tailLen - 1);

    let revealedCount = 0;

    const pickNonBossType = (lane, indexInLane) => {
      const r = activeRng();
      if (resolvedMix === 'combat_heavy') {
        if (lane === 'assault') return r < 0.6 ? NODE_TYPES.ELITE : NODE_TYPES.ENCOUNTER;
        return r < 0.2 ? NODE_TYPES.ANCHORAGE : r < 0.35 ? NODE_TYPES.STORY_EVENT : NODE_TYPES.ENCOUNTER;
      }
      if (resolvedMix === 'salvage_heavy') {
        if (indexInLane === 1 && lane === 'stealth') return NODE_TYPES.ANCHORAGE;
        if (r < 0.42) return NODE_TYPES.RESOURCE;
        if (r < 0.62) return NODE_TYPES.ANCHORAGE;
        if (r < 0.78) return NODE_TYPES.STORY_EVENT;
        return NODE_TYPES.ENCOUNTER;
      }
      if (resolvedMix === 'encounter_heavy') {
        if (r < 0.46) return NODE_TYPES.STORY_EVENT;
        if (r < 0.64) return NODE_TYPES.RESOURCE;
        if (r < 0.78) return NODE_TYPES.ANCHORAGE;
        return lane === 'assault' ? NODE_TYPES.ELITE : NODE_TYPES.ENCOUNTER;
      }
      // balanced
      if (lane === 'assault') {
        if (indexInLane === 0) return NODE_TYPES.ELITE;
        if (r < 0.45) return NODE_TYPES.ELITE;
        if (r < 0.7) return NODE_TYPES.ENCOUNTER;
        return NODE_TYPES.RESOURCE;
      }
      if (indexInLane === 0) return r < 0.55 ? NODE_TYPES.STORY_EVENT : NODE_TYPES.ENCOUNTER;
      if (indexInLane === 1) return NODE_TYPES.ANCHORAGE;
      return r < 0.45 ? NODE_TYPES.RESOURCE : r < 0.75 ? NODE_TYPES.STORY_EVENT : NODE_TYPES.WEATHER;
    };

    const makeNode = ({ code, type, lane = 'main', col = 0, forceReveal = false }) => {
      const isCombat = type === NODE_TYPES.ENCOUNTER || type === NODE_TYPES.ELITE || type === NODE_TYPES.BOSS;
      const depthRatio = Number(clamp(col / maxCol, 0, 1).toFixed(2));
      const matchingCustom =
        isCombat && Array.isArray(customEnemies)
          ? customEnemies.filter((e) => e && e.tier === type)
          : [];
      let enemyTemplate = null;
      if (isCombat) {
        if (matchingCustom.length > 0 && activeRng() < 0.3 && lane !== 'stealth') {
          const picked = deepClone(pickRandom(matchingCustom, activeRng));
          if (!Array.isArray(picked.squad) || picked.squad.length === 0) {
            picked.squad = buildEnemyTemplate(type, tier, activeRng, {
              lane,
              depthRatio,
              fleetSize,
              strengthMultiplier,
              enemyBias: resolvedBias,
            }).squad;
          }
          picked.depthRatio = depthRatio;
          picked.difficulty = tier.id;
          picked.star = tier.star;
          enemyTemplate = picked;
        } else {
          enemyTemplate = buildEnemyTemplate(type, tier, activeRng, {
            lane,
            depthRatio,
            fleetSize,
            strengthMultiplier,
            enemyBias: resolvedBias,
          });
        }
      }
      const name = isCombat ? enemyTemplate.name : pickRandom(NODE_NAMES[type] || NODE_NAMES[NODE_TYPES.RESOURCE], activeRng);
      const intelRevealed =
        forceReveal ||
        type === NODE_TYPES.BOSS ||
        type === NODE_TYPES.ANCHORAGE ||
        type === NODE_TYPES.STORY_EVENT ||
        activeRng() < revealChance;
      if (intelRevealed) revealedCount += 1;

      const laneBonus = lane === 'assault' ? 1.45 : 1.0;
      const scaleMult = tier.lootScale * laneBonus * (type === NODE_TYPES.BOSS ? 2.0 : type === NODE_TYPES.ELITE ? 1.45 : 1.1);
      const loot =
        type === NODE_TYPES.ANCHORAGE
          ? { fuel: 30, ammo: 25, silver: 60 }
          : type === NODE_TYPES.STORY_EVENT
          ? {
              fuel: Math.round(55 * scaleMult),
              ammo: Math.round(45 * scaleMult),
              silver: Math.round(135 * scaleMult),
              bauxite: Math.round(45 * scaleMult),
            }
          : type === NODE_TYPES.RESOURCE
          ? {
              fuel: Math.round(90 * scaleMult),
              ammo: Math.round(80 * scaleMult),
              steel: Math.round(115 * scaleMult),
              bauxite: Math.round(75 * scaleMult),
              silver: Math.round(160 * scaleMult),
            }
          : type === NODE_TYPES.WEATHER
          ? {
              fuel: Math.round(65 * scaleMult),
              ammo: Math.round(50 * scaleMult),
              bauxite: Math.round(90 * scaleMult),
              silver: Math.round(140 * scaleMult),
            }
          : type === NODE_TYPES.BOSS
          ? {
              fuel: Math.round(115 * scaleMult),
              ammo: Math.round(110 * scaleMult),
              steel: Math.round(210 * scaleMult),
              bauxite: Math.round(150 * scaleMult),
              silver: Math.round(380 * scaleMult),
              gold: Math.max(3, Math.round((tier.goldBonus || 3) * 1.4)),
            }
          : {
              fuel: Math.round(65 * scaleMult),
              ammo: Math.round(60 * scaleMult),
              steel: Math.round(125 * scaleMult),
              bauxite: Math.round(85 * scaleMult),
              silver: Math.round(215 * scaleMult),
            };

      return {
        code,
        name,
        type,
        typeLabel: NODE_TYPE_LABELS[type] || type,
        lane,
        laneLabel: BRANCH_LANE_META[lane]?.label || '主航道',
        col,
        depthRatio,
        difficulty: tier.id,
        star: tier.star,
        isAmbush: Boolean(enemyTemplate?.isAmbush),
        nextCodes: [],
        branchChoices: null,
        intelRevealed,
        anchorageConfig:
          type === NODE_TYPES.ANCHORAGE
            ? {
                cost: { fuel: 16, steel: 14, silver: 15 },
                healPct: 0.35,
                arBonusHealPct: 0.25,
                moraleGain: 22,
              }
            : null,
        salvageCarriedRefill:
          type === NODE_TYPES.RESOURCE
            ? {
                fuel: Math.round(24 + tier.star * 8),
                ammo: Math.round(20 + tier.star * 8),
                salvageParts: Math.max(1, Math.round(tier.star * 1.5)),
              }
            : null,
        statKey:
          type === NODE_TYPES.RESOURCE || type === NODE_TYPES.WEATHER || type === NODE_TYPES.ANCHORAGE || type === NODE_TYPES.STORY_EVENT
            ? 'recon'
            : lane === 'stealth'
            ? 'asw'
            : type === NODE_TYPES.ELITE
            ? 'torpedo'
            : 'firepower',
        dc: tier.baseDc + (type === NODE_TYPES.BOSS ? 3 : type === NODE_TYPES.ELITE ? 2 : 0),
        loot,
        failDamage: {
          hp: Math.round((type === NODE_TYPES.BOSS ? 16 : type === NODE_TYPES.ELITE ? 12 : 7) * (0.7 + tier.star * 0.15)),
          morale: type === NODE_TYPES.BOSS ? 8 : 5,
        },
        affinityGain: type === NODE_TYPES.BOSS ? 5 : type === NODE_TYPES.ELITE ? 4 : 2,
        enemyTemplate,
      };
    };

    const nodes = [];

    // 1. Entry Segment: A -> B (Fork)
    const nodeA = makeNode({
      code: 'A',
      type: resolvedMix === 'salvage_heavy' ? NODE_TYPES.RESOURCE : resolvedMix === 'encounter_heavy' ? NODE_TYPES.STORY_EVENT : NODE_TYPES.ENCOUNTER,
      lane: 'main',
      col: 0,
      forceReveal: true,
    });
    const nodeB = makeNode({
      code: 'B',
      type: nodeA.type === NODE_TYPES.ENCOUNTER ? (activeRng() < 0.55 ? NODE_TYPES.RESOURCE : NODE_TYPES.STORY_EVENT) : NODE_TYPES.ENCOUNTER,
      lane: 'main',
      col: 1,
      forceReveal: true,
    });
    nodeA.nextCodes = ['B'];
    nodes.push(nodeA, nodeB);

    // 2. Upper Branch ('assault')
    const assaultNodes = [];
    for (let i = 0; i < laneLen; i++) {
      const code = `${String.fromCharCode(67 + i)}1`;
      const type = pickNonBossType('assault', i);
      assaultNodes.push(makeNode({ code, type, lane: 'assault', col: 2 + i }));
    }

    // 3. Lower Branch ('stealth')
    const stealthNodes = [];
    for (let i = 0; i < laneLen; i++) {
      const code = `${String.fromCharCode(67 + i)}2`;
      const type = pickNonBossType('stealth', i);
      stealthNodes.push(makeNode({ code, type, lane: 'stealth', col: 2 + i }));
    }

    nodeB.nextCodes = [assaultNodes[0].code, stealthNodes[0].code];
    nodeB.branchChoices = [
      {
        targetCode: assaultNodes[0].code,
        lane: 'assault',
        label: BRANCH_LANE_META.assault.label,
        desc: BRANCH_LANE_META.assault.desc,
        badge: '高危高爆率',
      },
      {
        targetCode: stealthNodes[0].code,
        lane: 'stealth',
        label: BRANCH_LANE_META.stealth.label,
        desc: BRANCH_LANE_META.stealth.desc,
        badge: '打捞/海遇/锚地',
      },
    ];

    for (let i = 0; i < laneLen - 1; i++) {
      assaultNodes[i].nextCodes = [assaultNodes[i + 1].code];
      stealthNodes[i].nextCodes = [stealthNodes[i + 1].code];
    }
    nodes.push(...assaultNodes, ...stealthNodes);

    // 4. Tail Segment after Convergence -> BOSS
    const tailNodes = [];
    const mergeCol = 2 + laneLen;
    const baseTailChar = 67 + laneLen;
    for (let i = 0; i < tailLen; i++) {
      const isBoss = i === tailLen - 1;
      const code = isBoss ? 'BOSS' : String.fromCharCode(baseTailChar + i);
      let type = NODE_TYPES.BOSS;
      if (!isBoss) {
        if (i === 0) type = NODE_TYPES.ANCHORAGE;
        else if (i === tailLen - 2) type = resolvedStar >= 3 ? NODE_TYPES.ELITE : NODE_TYPES.ENCOUNTER;
        else type = activeRng() < 0.5 ? NODE_TYPES.STORY_EVENT : NODE_TYPES.RESOURCE;
      }
      tailNodes.push(
        makeNode({
          code,
          type,
          lane: 'main',
          col: mergeCol + i,
          forceReveal: isBoss || type === NODE_TYPES.ANCHORAGE,
        })
      );
    }

    assaultNodes[laneLen - 1].nextCodes = [tailNodes[0].code];
    stealthNodes[laneLen - 1].nextCodes = [tailNodes[0].code];
    for (let i = 0; i < tailNodes.length - 1; i++) {
      tailNodes[i].nextCodes = [tailNodes[i + 1].code];
    }
    nodes.push(...tailNodes);

    const prefix = pickRandom(ROUTE_PREFIXES[tier.id] || ROUTE_PREFIXES.star_1, activeRng);
    const serial = randInt(10, 99, activeRng);
    const route = {
      id: `route_gen_${Date.now().toString(36)}_${serial}`,
      name: `${prefix} ${serial}号（${tier.label}）`,
      description: `${MAP_SCALES[resolvedScale]?.label || `${nodes.length}节点`} · 海况「${seaCondition.label}」· ${NODE_MIX_MODES[resolvedMix]?.label} · 敌情「${ENEMY_BIAS_MODES[resolvedBias]?.label}」· 预侦察 ${revealedCount}/${nodes.length}`,
      difficulty: tier.id,
      star: tier.star,
      difficultyLabel: tier.label,
      scale: resolvedScale,
      nodeMix: resolvedMix,
      enemyBias: resolvedBias,
      seedCode: finalSeedCode,
      builtIn: false,
      generated: true,
      hasBranches: true,
      seaCondition,
      revealChance,
      minFuel: stepFuel * 2,
      minAmmo: stepAmmo * 2,
      apCost: tier.apCost,
      stepCost: { fuel: stepFuel, ammo: stepAmmo },
      nodes,
      createdAt: Date.now(),
    };

    if (this._bus) {
      this._bus.emit('route:generated', {
        routeId: route.id,
        difficulty: tier.id,
        star: tier.star,
        seedCode: finalSeedCode,
        nodeCount: nodes.length,
        hasBranches: true,
      });
    }
    return route;
  }

  /**
   * Save a Custom Map Workshop blueprint (or seed recipe) so commanders can reload favorite farming/challenge maps.
   */
  async saveCustomRoute(routeDef) {
    if (!routeDef || !routeDef.name) {
      throw new Error('海图名称不能为空');
    }
    const diffId = normalizeStarTierId(routeDef.difficulty || `star_${routeDef.star || 1}`);
    const tier = SEA_DIFFICULTIES[diffId] || SEA_DIFFICULTIES.star_1;

    const record = {
      id: routeDef.id || `route_custom_${Date.now().toString(36)}`,
      name: String(routeDef.name).trim(),
      description: String(routeDef.description || '自定义海图工坊配方').trim(),
      difficulty: tier.id,
      star: tier.star,
      difficultyLabel: tier.label,
      scale: routeDef.scale || 'medium',
      nodeMix: routeDef.nodeMix || 'balanced',
      enemyBias: routeDef.enemyBias || 'mixed',
      seaConditionId: routeDef.seaConditionId || routeDef.seaCondition?.id || 'random',
      seedCode:
        routeDef.seedCode ||
        encodeMapSeed({
          starLevel: tier.star,
          scale: routeDef.scale || 'medium',
          seaConditionId: routeDef.seaConditionId || 'random',
          nodeMix: routeDef.nodeMix || 'balanced',
          enemyBias: routeDef.enemyBias || 'mixed',
        }),
      builtIn: false,
      generated: true,
      seaCondition: routeDef.seaCondition || deepClone(SEA_CONDITIONS[0]),
      stepCost: routeDef.stepCost || { ...tier.stepCost },
      nodes: Array.isArray(routeDef.nodes) && routeDef.nodes.length > 0 ? deepClone(routeDef.nodes) : [],
      updatedAt: Date.now(),
    };

    const idx = this._customRoutes.findIndex((r) => r.id === record.id || (r.seedCode && r.seedCode === record.seedCode));
    if (idx >= 0) this._customRoutes[idx] = record;
    else this._customRoutes.unshift(record);

    await this.persistCustomRoutes();
    if (this._bus) {
      this._bus.emit('sortie:routes-changed', { routeId: record.id });
    }
    return deepClone(record);
  }

  async deleteCustomRoute(routeId) {
    const prevLen = this._customRoutes.length;
    this._customRoutes = this._customRoutes.filter((r) => r.id !== routeId);
    if (this._customRoutes.length !== prevLen) {
      await this.persistCustomRoutes();
      if (this._bus) {
        this._bus.emit('sortie:routes-changed', { routeId, deleted: true });
      }
      return true;
    }
    return false;
  }
}
