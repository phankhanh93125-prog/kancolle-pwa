/**
 * Procedural Random Sortie Route Generator & Custom Route Repository (`route-generator.js`).
 *
 * Capabilities:
 *   - Procedurally generates 3~6 node sortie routes by difficulty tier ('low' | 'medium' | 'high')
 *   - Supports 5 standardized node types: resource, weather, encounter, elite, boss
 *   - Attaches random sea-state modifier affixes (seaCondition) affecting combat/checks/step costs
 *   - Manages persisted custom fixed routes alongside built-in presets in IndexedDB
 */

import { clamp, weightedPick } from './calc-engine.js';

const STORAGE_NS = 'core-sortie-routes';
const CUSTOM_ROUTES_KEY = 'custom-routes-v1';

export const NODE_TYPES = Object.freeze({
  RESOURCE: 'resource',
  WEATHER: 'weather',
  ANCHORAGE: 'anchorage',
  ENCOUNTER: 'encounter',
  ELITE: 'elite',
  BOSS: 'boss',
});

export const NODE_TYPE_LABELS = Object.freeze({
  [NODE_TYPES.RESOURCE]: '资源打捞点',
  [NODE_TYPES.WEATHER]: '气象/侦察点',
  [NODE_TYPES.ANCHORAGE]: '临时锚地休整',
  [NODE_TYPES.ENCOUNTER]: '常规遭遇战',
  [NODE_TYPES.ELITE]: '精英封锁战',
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
    desc: '精英敌舰密集、正面火力交锋，钢材/铝材与高额战利品加成 +50%。',
  },
  stealth: {
    id: 'stealth',
    label: '暗流隐蔽航道',
    desc: '迷雾与潜艇伏击频发、考验侦查与反潜，含临时锚地休整且航行更省油。',
  },
});

export const SEA_DIFFICULTIES = Object.freeze({
  low: {
    id: 'low',
    label: '低危海域',
    nodeRange: [8, 10],
    baseDc: 12,
    apCost: 12,
    stepCost: { fuel: 20, ammo: 18 },
    enemyHpRange: [48, 76],
    enemyArmorRange: [2, 5],
    enemyAtkRange: [8, 13],
    lootScale: 1.0,
    goldBonus: 3,
  },
  medium: {
    id: 'medium',
    label: '中危海域',
    nodeRange: [10, 12],
    baseDc: 14,
    apCost: 18,
    stepCost: { fuel: 28, ammo: 25 },
    enemyHpRange: [72, 114],
    enemyArmorRange: [5, 9],
    enemyAtkRange: [12, 18],
    lootScale: 1.5,
    goldBonus: 5,
  },
  high: {
    id: 'high',
    label: '高危海域',
    nodeRange: [12, 15],
    baseDc: 16,
    apCost: 24,
    stepCost: { fuel: 36, ammo: 32 },
    enemyHpRange: [108, 160],
    enemyArmorRange: [8, 14],
    enemyAtkRange: [16, 24],
    lootScale: 2.2,
    goldBonus: 8,
  },
});

export const SEA_CONDITIONS = Object.freeze([
  {
    id: 'calm_sea',
    label: '风平浪静',
    description: '海况稳定，全行动检定 +1。',
    mods: { checkBonus: 1, fuelDelta: 0, scanDcDelta: 0, evadeBonus: 0, dmgMult: 1.0 },
  },
  {
    id: 'heavy_swell',
    label: '高海况涌浪',
    description: '涌浪颠簸，机动迂回 -1，炮击与鱼雷伤害 +10%。',
    mods: { checkBonus: 0, fuelDelta: 4, scanDcDelta: 0, evadeBonus: -1, dmgMult: 1.1 },
  },
  {
    id: 'dense_fog',
    label: '低能见度海雾',
    description: '视野受限，扫描 DC +1，但迂回成功率 +2。',
    mods: { checkBonus: 0, fuelDelta: 0, scanDcDelta: 1, evadeBonus: 2, dmgMult: 1.0 },
  },
  {
    id: 'tailwind',
    label: '顺风航流',
    description: '航速顺畅，单步燃油消耗 -5，机动检定 +1。',
    mods: { checkBonus: 0, fuelDelta: -5, scanDcDelta: 0, evadeBonus: 1, dmgMult: 1.0 },
  },
  {
    id: 'em_storm',
    label: '强电磁干扰',
    description: '雷达波杂乱，扫描 DC +1，但锁定成功后伤害 +15%。',
    mods: { checkBonus: 0, fuelDelta: 0, scanDcDelta: 1, evadeBonus: 0, dmgMult: 1.15 },
  },
]);

const ROUTE_PREFIXES = {
  low: ['近海分岔巡航', '外港警戒线', '岛礁打捞航道', '海峡双线护航'],
  medium: ['外海双路侦察', '航道破交作战', '岛链钳形突击', '深水压制航线'],
  high: ['深海主力破交', '双线合围决战', '要塞强袭航道', '风暴前线突破'],
};

const NODE_NAMES = {
  [NODE_TYPES.RESOURCE]: ['漂流补给区', '沉船物资点', '废弃浮标库', '散落集装箱区'],
  [NODE_TYPES.WEATHER]: ['海雾观测点', '气流异常带', '无人信标站', '暗流监测区'],
  [NODE_TYPES.ANCHORAGE]: ['隐蔽避风锚地', '前线浮船坞锚地', '无人礁盘补给湾', '临时应急整备点'],
  [NODE_TYPES.ENCOUNTER]: ['前哨巡逻编队', '轻型警戒编队', '游弋侦察单位', '外围拦阻编队'],
  [NODE_TYPES.ELITE]: ['重装封锁编队', '精英护卫集群', '装甲拦截中队', '高速突击分队'],
  [NODE_TYPES.BOSS]: ['海域主力旗舰群', '中枢要塞守卫群', '深海核心联合舰队'],
};

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function randInt(min, max, rng = Math.random) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

function pickRandom(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

const ENEMY_CLASS_ARCHETYPES = Object.freeze({
  BOSS: {
    shipClass: 'BOSS',
    role: 'boss',
    title: '深海要塞旗舰',
    hpMult: 1.45,
    armorMult: 1.35,
    atkMult: 1.28,
    evasion: [44, 58],
    aa: [55, 78],
    asw: [35, 55],
    torpedo: [50, 72],
    stealth: 18,
    weakness: 'torpedo',
    weaknessLabel: '鱼雷/破甲弱点',
  },
  BB: {
    shipClass: 'BB',
    role: 'battleship',
    title: '深海战列舰',
    hpMult: 1.18,
    armorMult: 1.25,
    atkMult: 1.15,
    evasion: [36, 48],
    aa: [42, 62],
    asw: [20, 35],
    torpedo: [15, 28],
    stealth: 10,
    weakness: 'torpedo',
    weaknessLabel: '鱼雷弱点',
  },
  CV: {
    shipClass: 'CV',
    role: 'carrier',
    title: '深海航母',
    hpMult: 0.96,
    armorMult: 0.88,
    atkMult: 1.05,
    evasion: [52, 66],
    aa: [58, 82],
    asw: [22, 36],
    torpedo: [10, 20],
    stealth: 16,
    weakness: 'aa',
    weaknessLabel: '防空/空袭弱点',
  },
  CA: {
    shipClass: 'CA',
    role: 'cruiser',
    title: '深海重巡洋舰',
    hpMult: 0.92,
    armorMult: 1.08,
    atkMult: 0.96,
    evasion: [54, 68],
    aa: [44, 64],
    asw: [34, 48],
    torpedo: [46, 62],
    stealth: 14,
    weakness: 'shelling',
    weaknessLabel: '炮击弱点',
  },
  CL: {
    shipClass: 'CL',
    role: 'escort',
    title: '深海轻巡洋舰',
    hpMult: 0.72,
    armorMult: 0.78,
    atkMult: 0.82,
    evasion: [64, 78],
    aa: [50, 70],
    asw: [52, 72],
    torpedo: [54, 70],
    stealth: 18,
    weakness: 'shelling',
    weaknessLabel: '炮击弱点',
  },
  DD: {
    shipClass: 'DD',
    role: 'destroyer',
    title: '深海高速驱逐舰',
    hpMult: 0.58,
    armorMult: 0.56,
    atkMult: 0.78,
    evasion: [74, 94],
    aa: [34, 52],
    asw: [56, 78],
    torpedo: [68, 88],
    stealth: 24,
    weakness: 'shelling',
    weaknessLabel: '炮击弱点',
  },
  SS: {
    shipClass: 'SS',
    role: 'sub',
    title: '深海猎杀潜艇',
    hpMult: 0.52,
    armorMult: 0.48,
    atkMult: 0.86,
    evasion: [66, 86],
    aa: [10, 20],
    asw: [25, 40],
    torpedo: [76, 98],
    stealth: 36,
    weakness: 'asw',
    weaknessLabel: '反潜弱点',
  },
});

export function buildEnemyUnitByClass(shipClass, idx, tierCfg, {
  type = NODE_TYPES.ENCOUNTER,
  baseHp = 60,
  baseArmor = 6,
  baseAtk = 14,
  baseName = '',
  depthRatio = 0,
  strengthMultiplier = 1.0,
  rng = Math.random,
} = {}) {
  const arch = ENEMY_CLASS_ARCHETYPES[shipClass] || ENEMY_CLASS_ARCHETYPES.DD;
  const depthScale = 1 + clamp(Number(depthRatio) || 0, 0, 1) * 0.35;
  const strMult = clamp(Number(strengthMultiplier) || 1.0, 0.5, 3.5);
  const tierFactor = tierCfg?.id === 'high' ? 1.22 : tierCfg?.id === 'medium' ? 1.08 : 0.94;

  const unitHp = Math.max(22, Math.round(baseHp * 0.52 * arch.hpMult * depthScale * strMult));
  const unitArmor = Math.max(1, Math.round(baseArmor * arch.armorMult * (0.85 + strMult * 0.25)));
  const unitAtk = Math.max(6, Math.round(baseAtk * 0.78 * arch.atkMult * (0.82 + strMult * 0.32)));
  const evasion = Math.round(randInt(arch.evasion[0], arch.evasion[1], rng) * (0.94 + depthRatio * 0.14));
  const aa = Math.round(randInt(arch.aa[0], arch.aa[1], rng) * tierFactor);
  const asw = Math.round(randInt(arch.asw[0], arch.asw[1], rng) * tierFactor);
  const torpedo = Math.round(randInt(arch.torpedo[0], arch.torpedo[1], rng) * tierFactor);

  const labelIdx = idx === 0 && baseName ? `${baseName} · 旗舰` : `${arch.title} #${idx + 1}`;
  return {
    id: `en_${idx + 1}`,
    name: labelIdx,
    shipClass: arch.shipClass,
    role: arch.role,
    tier: type,
    hp: unitHp,
    maxHp: unitHp,
    armor: unitArmor,
    attackPower: unitAtk,
    evasion,
    aa,
    asw,
    torpedo,
    stealth: arch.stealth,
    airThreat: arch.shipClass === 'CV' || arch.shipClass === 'BOSS' ? Math.round(aa * 0.45) : 0,
    subThreat: arch.shipClass === 'SS' ? Math.round(torpedo * 0.42) : 0,
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
  { lane = 'main', depthRatio = 0, fleetSize = 3, strengthMultiplier = 1.0 } = {}
) {
  const isBoss = type === NODE_TYPES.BOSS;
  const isElite = type === NODE_TYPES.ELITE;
  const diffId = tierCfg?.id || 'low';
  const hpMult = isBoss ? 1.55 : isElite ? 1.25 : 0.95;
  const atkMult = isBoss ? 1.3 : isElite ? 1.12 : 0.9;
  const armorBonus = isBoss ? 5 : isElite ? 3 : 0;

  const maxHp = Math.round(randInt(tierCfg.enemyHpRange[0], tierCfg.enemyHpRange[1], rng) * hpMult);
  const armor = randInt(tierCfg.enemyArmorRange[0], tierCfg.enemyArmorRange[1], rng) + armorBonus;
  const attackPower = Math.round(randInt(tierCfg.enemyAtkRange[0], tierCfg.enemyAtkRange[1], rng) * atkMult);
  const weakness = lane === 'stealth' ? 'asw' : rng() < 0.5 ? 'shelling' : 'torpedo';

  // Dynamic squad count: medium/high seas & deeper nodes scale up to 6~12 enemy ships!
  const depthStep = clamp(Number(depthRatio) || 0, 0, 1);
  const fleetAdj = Math.max(0, Math.round((Number(fleetSize) || 3) - 3) * 0.45);
  let minShips = 2;
  let maxShips = 3;
  if (diffId === 'high') {
    minShips = isBoss ? 8 : isElite || depthStep >= 0.45 ? 6 : 4;
    maxShips = isBoss ? 12 : isElite || depthStep >= 0.45 ? 10 : 7;
  } else if (diffId === 'medium') {
    minShips = isBoss ? 6 : isElite || depthStep >= 0.5 ? 5 : 3;
    maxShips = isBoss ? 10 : isElite || depthStep >= 0.5 ? 8 : 5;
  } else {
    minShips = isBoss ? 4 : isElite ? 3 : 2;
    maxShips = isBoss ? 6 : isElite ? 4 : 3;
  }
  const squadCount = clamp(Math.round(randInt(minShips, maxShips, rng) + fleetAdj), 2, 12);

  const baseName =
    lane === 'stealth' && !isBoss
      ? pickRandom(['深海潜艇猎杀群', '暗流隐蔽伏击队', '水下静默雷击群'], rng)
      : pickRandom(NODE_NAMES[type] || NODE_NAMES[NODE_TYPES.ENCOUNTER], rng);

  // Compose realistic mixed enemy fleet classes (BOSS / BB / CV / CA / CL / DD / SS)
  const classPlan = [];
  if (isBoss) {
    classPlan.push('BOSS');
    if (squadCount >= 2) classPlan.push('CV');
    if (squadCount >= 3) classPlan.push('CA');
    if (squadCount >= 4) classPlan.push('BB');
    if (squadCount >= 5) classPlan.push('DD');
    if (squadCount >= 6) classPlan.push('SS');
  } else if (lane === 'stealth') {
    classPlan.push('SS');
    if (squadCount >= 2) classPlan.push('DD');
    if (squadCount >= 3) classPlan.push('SS');
    if (squadCount >= 4) classPlan.push('CL');
  } else if (lane === 'assault' || isElite) {
    classPlan.push(rng() < 0.55 ? 'BB' : 'CV');
    if (squadCount >= 2) classPlan.push('CA');
    if (squadCount >= 3) classPlan.push('CV');
    if (squadCount >= 4) classPlan.push('DD');
  } else {
    classPlan.push(rng() < 0.5 ? 'CL' : 'CA');
    if (squadCount >= 2) classPlan.push('DD');
  }

  const fillerPool =
    lane === 'stealth'
      ? ['SS', 'DD', 'CL', 'CA']
      : diffId === 'high' || isBoss
      ? ['BB', 'CV', 'CA', 'CL', 'DD', 'SS']
      : ['CA', 'CL', 'DD', 'CV', 'SS'];
  while (classPlan.length < squadCount) {
    classPlan.push(pickRandom(fillerPool, rng));
  }

  const squad = classPlan.map((cls, idx) =>
    buildEnemyUnitByClass(cls, idx, tierCfg, {
      type,
      baseHp: maxHp,
      baseArmor: armor,
      baseAtk: attackPower,
      baseName: idx === 0 ? baseName : '',
      depthRatio: depthStep,
      strengthMultiplier,
      rng,
    })
  );

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

  const weaknessLabel =
    weakness === 'asw' ? '反潜弱点' : weakness === 'shelling' ? '炮击弱点' : '鱼雷弱点';

  const isAmbush = lane === 'stealth' ? rng() < 0.65 : !isBoss && rng() < (diffId === 'high' ? 0.25 : 0.14);
  const stealthRating = Math.round(
    (lane === 'stealth' ? 42 : 24) +
      (hasSubs ? 16 : 0) +
      (diffId === 'high' ? 14 : diffId === 'medium' ? 8 : 0) +
      depthStep * 14
  );

  return {
    name: baseName,
    tier: type,
    difficulty: diffId,
    depthRatio: Number(depthStep.toFixed(2)),
    forcedEngagement: isBoss,
    isAmbush,
    stealthRating,
    hp: squad.reduce((s, u) => s + u.hp, 0),
    maxHp: squad.reduce((s, u) => s + u.maxHp, 0),
    armor,
    attackPower,
    airThreat,
    subThreat,
    threatLabel,
    scanDc: tierCfg.baseDc + (isBoss ? 2 : isElite ? 1 : 0),
    evadeDc: tierCfg.baseDc + (isBoss ? 3 : isElite ? 2 : 0),
    shellingDc: tierCfg.baseDc + (isBoss ? 2 : isElite ? 1 : 0),
    torpedoDc: tierCfg.baseDc + (isBoss ? 4 : isElite ? 2 : 1),
    weakness,
    weaknessLabel,
    squad,
  };
}

export function createPresetRoutes() {
  const lowCfg = SEA_DIFFICULTIES.low;
  const medCfg = SEA_DIFFICULTIES.medium;
  return [
    {
      id: 'preset_patrol_low',
      name: '标准近海巡逻线（预设）',
      description: '3 节点低危巡逻航线：资源打捞 → 常规遭遇战 → 终点主力决战，适合稳健熟悉战术指令。',
      difficulty: 'low',
      difficultyLabel: lowCfg.label,
      builtIn: true,
      generated: false,
      seaCondition: deepClone(SEA_CONDITIONS[0]),
      minFuel: 60,
      minAmmo: 60,
      apCost: lowCfg.apCost,
      stepCost: { ...lowCfg.stepCost },
      nodes: [
        {
          code: 'A',
          name: '漂流补给区',
          type: NODE_TYPES.RESOURCE,
          typeLabel: NODE_TYPE_LABELS[NODE_TYPES.RESOURCE],
          statKey: 'tactics',
          dc: 12,
          loot: { fuel: 55, steel: 45, silver: 80 },
          failDamage: { hp: 5, morale: 3 },
          affinityGain: 2,
          enemyTemplate: null,
        },
        {
          code: 'B',
          name: '前哨巡逻编队',
          type: NODE_TYPES.ENCOUNTER,
          typeLabel: NODE_TYPE_LABELS[NODE_TYPES.ENCOUNTER],
          statKey: 'attack',
          dc: 13,
          loot: { steel: 65, bauxite: 35, silver: 120 },
          failDamage: { hp: 12, morale: 6 },
          affinityGain: 3,
          enemyTemplate: {
            name: '前哨巡逻编队',
            tier: NODE_TYPES.ENCOUNTER,
            forcedEngagement: false,
            hp: 54,
            maxHp: 54,
            armor: 3,
            attackPower: 10,
            scanDc: 12,
            evadeDc: 12,
            shellingDc: 12,
            torpedoDc: 13,
            weakness: 'torpedo',
            weaknessLabel: '鱼雷弱点',
          },
        },
        {
          code: 'C',
          name: '海域主力旗舰群',
          type: NODE_TYPES.BOSS,
          typeLabel: NODE_TYPE_LABELS[NODE_TYPES.BOSS],
          statKey: 'attack',
          dc: 15,
          loot: { steel: 110, bauxite: 70, silver: 220, gold: 3 },
          failDamage: { hp: 18, morale: 10 },
          affinityGain: 5,
          enemyTemplate: {
            name: '海域主力旗舰群',
            tier: NODE_TYPES.BOSS,
            forcedEngagement: true,
            hp: 78,
            maxHp: 78,
            armor: 6,
            attackPower: 14,
            scanDc: 14,
            evadeDc: 15,
            shellingDc: 14,
            torpedoDc: 16,
            weakness: 'shelling',
            weaknessLabel: '炮击弱点',
          },
        },
      ],
    },
    {
      id: 'preset_strike_med',
      name: '外海突破作战线（预设）',
      description: '4 节点中危作战航线：气象侦察 → 常规遭遇 → 精英封锁 → 终点主力决战。',
      difficulty: 'medium',
      difficultyLabel: medCfg.label,
      builtIn: true,
      generated: false,
      seaCondition: deepClone(SEA_CONDITIONS[2]),
      minFuel: 100,
      minAmmo: 100,
      apCost: medCfg.apCost,
      stepCost: { ...medCfg.stepCost },
      nodes: [
        {
          code: 'A',
          name: '海雾观测点',
          type: NODE_TYPES.WEATHER,
          typeLabel: NODE_TYPE_LABELS[NODE_TYPES.WEATHER],
          statKey: 'tactics',
          dc: 13,
          loot: { fuel: 60, bauxite: 50, silver: 90 },
          failDamage: { hp: 6, morale: 4 },
          affinityGain: 2,
          enemyTemplate: null,
        },
        {
          code: 'B',
          name: '游弋侦察单位',
          type: NODE_TYPES.ENCOUNTER,
          typeLabel: NODE_TYPE_LABELS[NODE_TYPES.ENCOUNTER],
          statKey: 'attack',
          dc: 14,
          loot: { steel: 80, silver: 140 },
          failDamage: { hp: 14, morale: 7 },
          affinityGain: 3,
          enemyTemplate: {
            name: '游弋侦察单位',
            tier: NODE_TYPES.ENCOUNTER,
            forcedEngagement: false,
            hp: 76,
            maxHp: 76,
            armor: 5,
            attackPower: 13,
            scanDc: 14,
            evadeDc: 14,
            shellingDc: 14,
            torpedoDc: 15,
            weakness: 'shelling',
            weaknessLabel: '炮击弱点',
          },
        },
        {
          code: 'C',
          name: '重装封锁编队',
          type: NODE_TYPES.ELITE,
          typeLabel: NODE_TYPE_LABELS[NODE_TYPES.ELITE],
          statKey: 'burst',
          dc: 15,
          loot: { steel: 110, bauxite: 65, silver: 180 },
          failDamage: { hp: 18, morale: 9 },
          affinityGain: 4,
          enemyTemplate: {
            name: '重装封锁编队',
            tier: NODE_TYPES.ELITE,
            forcedEngagement: false,
            hp: 102,
            maxHp: 102,
            armor: 8,
            attackPower: 16,
            scanDc: 15,
            evadeDc: 16,
            shellingDc: 15,
            torpedoDc: 16,
            weakness: 'torpedo',
            weaknessLabel: '鱼雷弱点',
          },
        },
        {
          code: 'D',
          name: '中枢要塞守卫群',
          type: NODE_TYPES.BOSS,
          typeLabel: NODE_TYPE_LABELS[NODE_TYPES.BOSS],
          statKey: 'attack',
          dc: 16,
          loot: { steel: 160, bauxite: 105, silver: 320, gold: 5 },
          failDamage: { hp: 24, morale: 12 },
          affinityGain: 6,
          enemyTemplate: {
            name: '中枢要塞守卫群',
            tier: NODE_TYPES.BOSS,
            forcedEngagement: true,
            hp: 132,
            maxHp: 132,
            armor: 10,
            attackPower: 19,
            scanDc: 16,
            evadeDc: 17,
            shellingDc: 16,
            torpedoDc: 18,
            weakness: 'torpedo',
            weaknessLabel: '鱼雷弱点',
          },
        },
      ],
    },
  ];
}

export class RouteGenerator {
  /**
   * @param {{
   *   storage?: import('./storage.js').StorageManager | null,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} [deps]
   */
  constructor({ storage = null, bus = null } = {}) {
    this._scope = storage ? storage.namespace(STORAGE_NS) : null;
    this._bus = bus;
    this._customRoutes = [];
    // Build a deterministic 10-node branching preset sea chart alongside classic presets
    let seed = 133791;
    const seededRng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const presetBranch10 = this.generateRoute({
      difficulty: 'medium',
      nodeCount: 10,
      rng: seededRng,
    });
    presetBranch10.id = 'preset_branching_10';
    presetBranch10.name = '双线岛链分岔海域（10节点预设）';
    presetBranch10.description =
      '10 节点分岔雷达海图：含「主力强攻航道（高危高钢铝）」vs「暗流隐蔽航道（反潜+临时锚地）」与终点主力决战。';
    presetBranch10.builtIn = true;
    presetBranch10.generated = false;
    // Guarantee first node is an encounter so players can test combat immediately on Node A too
    if (presetBranch10.nodes[0]) {
      const n0 = presetBranch10.nodes[0];
      if (n0.type !== NODE_TYPES.ENCOUNTER) {
        const eq = buildEnemyTemplate(NODE_TYPES.ENCOUNTER, SEA_DIFFICULTIES.low, seededRng, { lane: 'main' });
        n0.type = NODE_TYPES.ENCOUNTER;
        n0.typeLabel = NODE_TYPE_LABELS[NODE_TYPES.ENCOUNTER];
        n0.name = eq.name;
        n0.enemyTemplate = eq;
      }
    }
    this._presets = [presetBranch10, ...createPresetRoutes()];
    this._hydrated = false;
  }

  async init() {
    if (this._hydrated) return;
    if (this._scope) {
      const saved = await this._scope.getLarge(CUSTOM_ROUTES_KEY, []);
      this._customRoutes = Array.isArray(saved) ? deepClone(saved) : [];
    }
    this._hydrated = true;
  }

  async persistCustomRoutes() {
    if (!this._scope) return;
    await this._scope.setLarge(CUSTOM_ROUTES_KEY, this._customRoutes);
  }

  getPresetRoutes() {
    return deepClone(this._presets);
  }

  listCustomRoutes() {
    return deepClone(this._customRoutes);
  }

  listAllRoutes() {
    return [...this.getPresetRoutes(), ...this.listCustomRoutes()];
  }

  /**
   * Procedurally generate an 8~15 node branching sortie route with:
   *   - Mid-route Fork Choice: 「主力强攻航道 (assault)」 vs 「暗流隐蔽航道 (stealth)」
   *   - Temporary Anchorage rest nodes (NODE_TYPES.ANCHORAGE)
   *   - Multi-ship enemy squads (enemyTemplate.squad) for turn-by-turn tactical combat
   */
  generateRoute({
    difficulty = 'low',
    nodeCount = null,
    commander = null,
    customEnemies = [],
    fleetSize = 3,
    strengthMultiplier = 1.0,
    rng = Math.random,
  } = {}) {
    const tier = SEA_DIFFICULTIES[difficulty] || SEA_DIFFICULTIES.low;
    const totalNodes = nodeCount
      ? clamp(Math.floor(nodeCount), 8, 15)
      : randInt(tier.nodeRange[0], tier.nodeRange[1], rng);

    const seaCondition = deepClone(pickRandom(SEA_CONDITIONS, rng));
    const stepFuel = Math.max(10, tier.stepCost.fuel + (seaCondition.mods.fuelDelta || 0));
    const stepAmmo = tier.stepCost.ammo;
    const revealChance =
      commander && typeof commander.getRouteRevealChance === 'function'
        ? commander.getRouteRevealChance()
        : 0.25;

    // Partition 8..15 total nodes into:
    //   Entry (2 nodes: A -> B [FORK])
    //   Upper Lane 'assault' (laneLen nodes: C1.. -> merge)
    //   Lower Lane 'stealth' (laneLen nodes: C2.. -> merge)
    //   Tail after merge (tailLen >= 2 nodes: ... -> BOSS)
    const remaining = totalNodes - 2; // 6..13
    const laneLen = clamp(Math.floor((remaining - 2) / 2), 2, 4); // 2..4 per branch
    const tailLen = Math.max(2, remaining - laneLen * 2); // 2..5 tail nodes
    const maxCol = Math.max(1, 2 + laneLen + tailLen - 1);

    let revealedCount = 0;

    const makeNode = ({ code, type, lane = 'main', col = 0, forceReveal = false }) => {
      const isCombat = type === NODE_TYPES.ENCOUNTER || type === NODE_TYPES.ELITE || type === NODE_TYPES.BOSS;
      const depthRatio = Number(clamp(col / maxCol, 0, 1).toFixed(2));
      const matchingCustom =
        isCombat && Array.isArray(customEnemies)
          ? customEnemies.filter((e) => e && e.tier === type)
          : [];
      let enemyTemplate = null;
      if (isCombat) {
        if (matchingCustom.length > 0 && rng() < 0.35 && lane !== 'stealth') {
          const picked = deepClone(pickRandom(matchingCustom, rng));
          if (!Array.isArray(picked.squad) || picked.squad.length === 0) {
            picked.squad = buildEnemyTemplate(type, tier, rng, {
              lane,
              depthRatio,
              fleetSize,
              strengthMultiplier,
            }).squad;
          }
          picked.depthRatio = depthRatio;
          picked.difficulty = tier.id;
          enemyTemplate = picked;
        } else {
          enemyTemplate = buildEnemyTemplate(type, tier, rng, {
            lane,
            depthRatio,
            fleetSize,
            strengthMultiplier,
          });
        }
      }
      const name = isCombat ? enemyTemplate.name : pickRandom(NODE_NAMES[type] || NODE_NAMES[NODE_TYPES.RESOURCE], rng);
      const intelRevealed = forceReveal || type === NODE_TYPES.BOSS || type === NODE_TYPES.ANCHORAGE || rng() < revealChance;
      if (intelRevealed) revealedCount += 1;

      const laneBonus = lane === 'assault' ? 1.5 : 1.0;
      const scale = tier.lootScale * laneBonus * (type === NODE_TYPES.BOSS ? 1.9 : type === NODE_TYPES.ELITE ? 1.35 : 1.0);
      const loot =
        type === NODE_TYPES.ANCHORAGE
          ? { fuel: 15, silver: 30 }
          : type === NODE_TYPES.RESOURCE
          ? {
              fuel: Math.round(52 * scale),
              steel: Math.round(56 * scale),
              bauxite: Math.round(32 * scale),
              silver: Math.round(80 * scale),
            }
          : type === NODE_TYPES.WEATHER
          ? {
              fuel: Math.round(36 * scale),
              bauxite: Math.round(44 * scale),
              silver: Math.round(70 * scale),
            }
          : type === NODE_TYPES.BOSS
          ? {
              steel: Math.round(105 * scale),
              bauxite: Math.round(72 * scale),
              silver: Math.round(200 * scale),
              gold: tier.goldBonus,
            }
          : {
              steel: Math.round(64 * scale),
              bauxite: Math.round(40 * scale),
              silver: Math.round(120 * scale),
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
        isAmbush: Boolean(enemyTemplate?.isAmbush),
        nextCodes: [],
        branchChoices: null,
        intelRevealed,
        anchorageConfig:
          type === NODE_TYPES.ANCHORAGE
            ? {
                cost: { fuel: 22, steel: 18, silver: 20 },
                healPct: 0.35,
                moraleGain: 20,
              }
            : null,
        statKey:
          type === NODE_TYPES.RESOURCE || type === NODE_TYPES.WEATHER || type === NODE_TYPES.ANCHORAGE
            ? 'recon'
            : lane === 'stealth'
            ? 'asw'
            : type === NODE_TYPES.ELITE
            ? 'torpedo'
            : 'firepower',
        dc: tier.baseDc + (type === NODE_TYPES.BOSS ? 3 : type === NODE_TYPES.ELITE ? 2 : 0),
        loot,
        failDamage: {
          hp: Math.round((type === NODE_TYPES.BOSS ? 20 : type === NODE_TYPES.ELITE ? 15 : 9) * tier.lootScale * 0.7),
          morale: type === NODE_TYPES.BOSS ? 10 : 6,
        },
        affinityGain: type === NODE_TYPES.BOSS ? 5 : type === NODE_TYPES.ELITE ? 4 : 2,
        enemyTemplate,
      };
    };

    const nodes = [];

    // 1. Entry Segment: A (Encounter or Resource) -> B (Fork Decision Node)
    const nodeA = makeNode({
      code: 'A',
      type: rng() < 0.7 ? NODE_TYPES.ENCOUNTER : NODE_TYPES.RESOURCE,
      lane: 'main',
      col: 0,
      forceReveal: true,
    });
    const nodeB = makeNode({
      code: 'B',
      type: nodeA.type === NODE_TYPES.ENCOUNTER ? NODE_TYPES.WEATHER : NODE_TYPES.ENCOUNTER,
      lane: 'main',
      col: 1,
      forceReveal: true,
    });
    nodeA.nextCodes = ['B'];
    nodes.push(nodeA, nodeB);

    // 2. Upper Branch: 'assault' (主力强攻航道)
    const assaultNodes = [];
    for (let i = 0; i < laneLen; i++) {
      const code = `${String.fromCharCode(67 + i)}1`;
      let type = NODE_TYPES.ELITE;
      if (i === 0) type = NODE_TYPES.ELITE;
      else if (i === laneLen - 1) type = NODE_TYPES.ELITE;
      else type = rng() < 0.55 ? NODE_TYPES.RESOURCE : NODE_TYPES.ENCOUNTER;
      const n = makeNode({ code, type, lane: 'assault', col: 2 + i });
      assaultNodes.push(n);
    }

    // 3. Lower Branch: 'stealth' (暗流隐蔽航道)
    const stealthNodes = [];
    for (let i = 0; i < laneLen; i++) {
      const code = `${String.fromCharCode(67 + i)}2`;
      let type = NODE_TYPES.ENCOUNTER;
      if (i === 0) type = NODE_TYPES.ENCOUNTER; // Submarine ambush
      else if (i === 1) type = NODE_TYPES.ANCHORAGE; // Temporary Anchorage rest stop
      else if (i === laneLen - 1) type = NODE_TYPES.WEATHER;
      else type = NODE_TYPES.ENCOUNTER;
      const n = makeNode({ code, type, lane: 'stealth', col: 2 + i });
      stealthNodes.push(n);
    }

    // Link Fork Node B -> Assault[0] and Stealth[0]
    nodeB.nextCodes = [assaultNodes[0].code, stealthNodes[0].code];
    nodeB.branchChoices = [
      {
        targetCode: assaultNodes[0].code,
        lane: 'assault',
        label: BRANCH_LANE_META.assault.label,
        desc: BRANCH_LANE_META.assault.desc,
        badge: '高危高回报',
      },
      {
        targetCode: stealthNodes[0].code,
        lane: 'stealth',
        label: BRANCH_LANE_META.stealth.label,
        desc: BRANCH_LANE_META.stealth.desc,
        badge: '反潜/锚地休整',
      },
    ];

    for (let i = 0; i < laneLen - 1; i++) {
      assaultNodes[i].nextCodes = [assaultNodes[i + 1].code];
      stealthNodes[i].nextCodes = [stealthNodes[i + 1].code];
    }
    nodes.push(...assaultNodes, ...stealthNodes);

    // 4. Tail Segment after Convergence (includes an Anchorage before Boss if tailLen >= 3)
    const tailNodes = [];
    const mergeCol = 2 + laneLen;
    const baseTailChar = 67 + laneLen; // e.g., F, G, H...
    for (let i = 0; i < tailLen; i++) {
      const isBoss = i === tailLen - 1;
      const code = isBoss ? 'BOSS' : String.fromCharCode(baseTailChar + i);
      let type = NODE_TYPES.BOSS;
      if (!isBoss) {
        if (i === 0) type = NODE_TYPES.ANCHORAGE;
        else if (i === tailLen - 2) type = difficulty === 'low' ? NODE_TYPES.ENCOUNTER : NODE_TYPES.ELITE;
        else type = rng() < 0.5 ? NODE_TYPES.RESOURCE : NODE_TYPES.ENCOUNTER;
      }
      const n = makeNode({
        code,
        type,
        lane: 'main',
        col: mergeCol + i,
        forceReveal: isBoss || type === NODE_TYPES.ANCHORAGE,
      });
      tailNodes.push(n);
    }

    assaultNodes[laneLen - 1].nextCodes = [tailNodes[0].code];
    stealthNodes[laneLen - 1].nextCodes = [tailNodes[0].code];
    for (let i = 0; i < tailNodes.length - 1; i++) {
      tailNodes[i].nextCodes = [tailNodes[i + 1].code];
    }
    nodes.push(...tailNodes);

    const prefix = pickRandom(ROUTE_PREFIXES[tier.id] || ROUTE_PREFIXES.low, rng);
    const serial = randInt(10, 99, rng);
    const route = {
      id: `route_gen_${Date.now().toString(36)}_${serial}`,
      name: `${prefix} ${serial}号海域（${tier.label}）`,
      description: `分岔雷达海图 · ${nodes.length} 节点（含强攻/隐蔽双航道与临时锚地 · 预侦察 ${revealedCount}/${nodes.length}）· 海况「${seaCondition.label}」`,
      difficulty: tier.id,
      difficultyLabel: tier.label,
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
        nodeCount: nodes.length,
        hasBranches: true,
      });
    }
    return route;
  }

  async saveCustomRoute(routeDef) {
    if (!routeDef || !routeDef.name) {
      throw new Error('航线名称不能为空');
    }
    const tier = SEA_DIFFICULTIES[routeDef.difficulty] || SEA_DIFFICULTIES.low;
    const normalizedNodes = (routeDef.nodes || []).map((n, idx) => {
      const type = Object.values(NODE_TYPES).includes(n.type) ? n.type : NODE_TYPES.ENCOUNTER;
      const isCombat = type === NODE_TYPES.ENCOUNTER || type === NODE_TYPES.ELITE || type === NODE_TYPES.BOSS;
      return {
        code: String.fromCharCode(65 + idx),
        name: String(n.name || `节点 ${String.fromCharCode(65 + idx)}`).trim(),
        type,
        typeLabel: NODE_TYPE_LABELS[type] || type,
        statKey: n.statKey || 'attack',
        dc: clamp(Number(n.dc) || tier.baseDc, 5, 35),
        loot: n.loot || { steel: 70, bauxite: 40, silver: 120 },
        failDamage: n.failDamage || { hp: 12, morale: 6 },
        affinityGain: Number(n.affinityGain) || 3,
        enemyTemplate: isCombat
          ? n.enemyTemplate || buildEnemyTemplate(type, tier)
          : null,
      };
    });

    const record = {
      id: routeDef.id || `route_custom_${Date.now().toString(36)}`,
      name: String(routeDef.name).trim(),
      description: String(routeDef.description || '玩家自定义固定航线。').trim(),
      difficulty: tier.id,
      difficultyLabel: tier.label,
      builtIn: false,
      generated: false,
      seaCondition: routeDef.seaCondition || deepClone(SEA_CONDITIONS[0]),
      minFuel: Math.max(20, (Number(routeDef.stepCost?.fuel) || 25) * 2),
      minAmmo: Math.max(20, (Number(routeDef.stepCost?.ammo) || 20) * 2),
      apCost: clamp(Number(routeDef.apCost) || 15, 0, 100),
      stepCost: {
        fuel: clamp(Number(routeDef.stepCost?.fuel) || 25, 0, 500),
        ammo: clamp(Number(routeDef.stepCost?.ammo) || 20, 0, 500),
      },
      nodes: normalizedNodes,
      updatedAt: Date.now(),
    };

    const idx = this._customRoutes.findIndex((r) => r.id === record.id);
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
