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

export function buildEnemyTemplate(type, tierCfg, rng = Math.random, { lane = 'main' } = {}) {
  const isBoss = type === NODE_TYPES.BOSS;
  const isElite = type === NODE_TYPES.ELITE;
  const hpMult = isBoss ? 1.55 : isElite ? 1.25 : 0.95;
  const atkMult = isBoss ? 1.3 : isElite ? 1.12 : 0.9;
  const armorBonus = isBoss ? 5 : isElite ? 3 : 0;

  const maxHp = Math.round(randInt(tierCfg.enemyHpRange[0], tierCfg.enemyHpRange[1], rng) * hpMult);
  const armor = randInt(tierCfg.enemyArmorRange[0], tierCfg.enemyArmorRange[1], rng) + armorBonus;
  const attackPower = Math.round(randInt(tierCfg.enemyAtkRange[0], tierCfg.enemyAtkRange[1], rng) * atkMult);
  const weakness = lane === 'stealth' ? 'asw' : rng() < 0.5 ? 'shelling' : 'torpedo';

  // Aerial & Submarine threat tiers so fleet AA (防空) and ASW (反潜) actively matter
  const threatRoll = rng();
  const baseThreat = isBoss ? 26 : isElite ? 19 : 13;
  let airThreat = 0;
  let subThreat = 0;
  let threatLabel = '水面主力编队';
  if (isBoss) {
    airThreat = Math.round(baseThreat * (0.75 + rng() * 0.45));
    subThreat = rng() < 0.55 ? Math.round(baseThreat * 0.7) : 0;
    threatLabel = subThreat > 0 ? '海空潜立体主力' : '舰载机编队威胁';
  } else if (lane === 'stealth' || threatRoll < 0.36) {
    subThreat = Math.round(baseThreat * (0.85 + rng() * 0.4));
    threatLabel = '敌方水下潜艇伏击';
  } else if (lane === 'assault' && threatRoll < 0.65) {
    airThreat = Math.round(baseThreat * (0.85 + rng() * 0.4));
    threatLabel = '敌方航空压制威胁';
  } else if (threatRoll < 0.72) {
    airThreat = Math.round(baseThreat * (0.8 + rng() * 0.35));
    threatLabel = '敌方航空威胁';
  } else {
    threatLabel = '常规水面炮雷编队';
  }

  const weaknessLabel =
    weakness === 'asw' ? '反潜弱点' : weakness === 'shelling' ? '炮击弱点' : '鱼雷弱点';

  const baseName =
    lane === 'stealth' && !isBoss
      ? pickRandom(['深海潜艇猎杀群', '暗流隐蔽伏击队', '水下静默雷击群'], rng)
      : pickRandom(NODE_NAMES[type] || NODE_NAMES[NODE_TYPES.ENCOUNTER], rng);

  // Build 1~3 individual enemy ships for the turn-by-turn tactical battle screen
  const squadCount = isBoss ? 3 : isElite ? 2 : rng() < 0.55 ? 2 : 1;
  const squad = [];
  for (let idx = 0; idx < squadCount; idx++) {
    const isLead = idx === 0;
    const isSubEscort = !isLead && (subThreat > 0 || lane === 'stealth');
    const isAirEscort = !isLead && !isSubEscort && airThreat > 0;
    const unitHp = Math.max(24, Math.round(maxHp * (isLead ? 0.55 : 0.35)));
    const unitArmor = Math.max(1, Math.round(armor * (isLead ? 1.05 : isSubEscort ? 0.55 : 0.8)));
    const unitAtk = Math.max(6, Math.round(attackPower * (isLead ? 0.88 : 0.65)));
    const unitWeakness = isSubEscort ? 'asw' : isAirEscort ? 'aa' : weakness;
    const unitWeaknessLabel =
      unitWeakness === 'asw'
        ? '反潜弱点'
        : unitWeakness === 'aa'
        ? '防空/空袭弱点'
        : unitWeakness === 'shelling'
        ? '炮击弱点'
        : '鱼雷弱点';

    const unitName = isLead
      ? isBoss
        ? `${baseName} · 旗舰`
        : baseName
      : isSubEscort
      ? `深海潜艇 · ${idx}号`
      : isAirEscort
      ? `轻型航母护卫 · ${idx}号`
      : `护卫驱逐舰 · ${idx}号`;

    squad.push({
      id: `en_${idx + 1}`,
      name: unitName,
      role: isSubEscort ? 'sub' : isAirEscort ? 'carrier' : isLead && isBoss ? 'boss' : isLead ? 'flagship' : 'escort',
      tier: type,
      hp: unitHp,
      maxHp: unitHp,
      armor: unitArmor,
      attackPower: unitAtk,
      airThreat: isAirEscort || (isLead && airThreat > 0) ? airThreat : 0,
      subThreat: isSubEscort || (isLead && subThreat > 0 && squadCount === 1) ? Math.max(12, subThreat) : 0,
      weakness: unitWeakness,
      weaknessLabel: unitWeaknessLabel,
      threatLabel: isSubEscort ? '水下潜艇' : isAirEscort ? '航空护卫' : threatLabel,
    });
  }

  return {
    name: baseName,
    tier: type,
    forcedEngagement: isBoss,
    hp: maxHp,
    maxHp,
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
  generateRoute({ difficulty = 'low', nodeCount = null, commander = null, customEnemies = [], rng = Math.random } = {}) {
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

    let revealedCount = 0;

    const makeNode = ({ code, type, lane = 'main', col = 0, forceReveal = false }) => {
      const isCombat = type === NODE_TYPES.ENCOUNTER || type === NODE_TYPES.ELITE || type === NODE_TYPES.BOSS;
      const matchingCustom =
        isCombat && Array.isArray(customEnemies)
          ? customEnemies.filter((e) => e && e.tier === type)
          : [];
      let enemyTemplate = null;
      if (isCombat) {
        if (matchingCustom.length > 0 && rng() < 0.35 && lane !== 'stealth') {
          const picked = deepClone(pickRandom(matchingCustom, rng));
          if (!Array.isArray(picked.squad) || picked.squad.length === 0) {
            picked.squad = buildEnemyTemplate(type, tier, rng, { lane }).squad;
          }
          enemyTemplate = picked;
        } else {
          enemyTemplate = buildEnemyTemplate(type, tier, rng, { lane });
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
