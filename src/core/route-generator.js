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
  ENCOUNTER: 'encounter',
  ELITE: 'elite',
  BOSS: 'boss',
});

export const NODE_TYPE_LABELS = Object.freeze({
  [NODE_TYPES.RESOURCE]: '资源打捞点',
  [NODE_TYPES.WEATHER]: '气象/侦察点',
  [NODE_TYPES.ENCOUNTER]: '常规遭遇战',
  [NODE_TYPES.ELITE]: '精英封锁战',
  [NODE_TYPES.BOSS]: '终点主力决战',
});

export const SEA_DIFFICULTIES = Object.freeze({
  low: {
    id: 'low',
    label: '低危海域',
    nodeRange: [3, 4],
    baseDc: 12,
    apCost: 12,
    stepCost: { fuel: 20, ammo: 18 },
    enemyHpRange: [45, 72],
    enemyArmorRange: [2, 5],
    enemyAtkRange: [8, 13],
    lootScale: 1.0,
    goldBonus: 2,
  },
  medium: {
    id: 'medium',
    label: '中危海域',
    nodeRange: [4, 5],
    baseDc: 14,
    apCost: 18,
    stepCost: { fuel: 28, ammo: 25 },
    enemyHpRange: [70, 110],
    enemyArmorRange: [5, 9],
    enemyAtkRange: [12, 18],
    lootScale: 1.5,
    goldBonus: 4,
  },
  high: {
    id: 'high',
    label: '高危海域',
    nodeRange: [5, 6],
    baseDc: 16,
    apCost: 24,
    stepCost: { fuel: 36, ammo: 32 },
    enemyHpRange: [105, 155],
    enemyArmorRange: [8, 14],
    enemyAtkRange: [16, 24],
    lootScale: 2.2,
    goldBonus: 7,
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
  low: ['近海巡航', '外港警戒', '浅滩打捞', '海峡护航'],
  medium: ['外海侦察', '航道封锁', '岛链突击', '深水压制'],
  high: ['深海破交', '主力决战', '要塞强袭', '风暴前线'],
};

const NODE_NAMES = {
  [NODE_TYPES.RESOURCE]: ['漂流补给区', '沉船物资点', '废弃浮标库', '散落集装箱区'],
  [NODE_TYPES.WEATHER]: ['海雾观测点', '气流异常带', '无人信标站', '暗流监测区'],
  [NODE_TYPES.ENCOUNTER]: ['前哨巡逻编队', '轻型警戒编队', '游弋侦察单位', '外围拦阻编队'],
  [NODE_TYPES.ELITE]: ['重装封锁编队', '精英护卫集群', '装甲拦截中队', '高速突击分队'],
  [NODE_TYPES.BOSS]: ['海域主力旗舰群', '中枢要塞守卫群', '重型核心编队'],
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

export function buildEnemyTemplate(type, tierCfg, rng = Math.random) {
  const isBoss = type === NODE_TYPES.BOSS;
  const isElite = type === NODE_TYPES.ELITE;
  const hpMult = isBoss ? 1.55 : isElite ? 1.25 : 0.95;
  const atkMult = isBoss ? 1.3 : isElite ? 1.12 : 0.9;
  const armorBonus = isBoss ? 5 : isElite ? 3 : 0;

  const maxHp = Math.round(randInt(tierCfg.enemyHpRange[0], tierCfg.enemyHpRange[1], rng) * hpMult);
  const armor = randInt(tierCfg.enemyArmorRange[0], tierCfg.enemyArmorRange[1], rng) + armorBonus;
  const attackPower = Math.round(randInt(tierCfg.enemyAtkRange[0], tierCfg.enemyAtkRange[1], rng) * atkMult);
  const weakness = rng() < 0.5 ? 'shelling' : 'torpedo';

  // Aerial & Submarine threat tiers so fleet AA (防空) and ASW (反潜) actively matter
  const threatRoll = rng();
  const baseThreat = isBoss ? 24 : isElite ? 18 : 12;
  let airThreat = 0;
  let subThreat = 0;
  let threatLabel = '水面主力编队';
  if (isBoss) {
    airThreat = Math.round(baseThreat * (0.7 + rng() * 0.5));
    subThreat = rng() < 0.5 ? Math.round(baseThreat * 0.65) : 0;
    threatLabel = subThreat > 0 ? '海空潜立体主力' : '舰载机编队威胁';
  } else if (threatRoll < 0.38) {
    airThreat = Math.round(baseThreat * (0.8 + rng() * 0.4));
    threatLabel = '敌方航空威胁';
  } else if (threatRoll < 0.72) {
    subThreat = Math.round(baseThreat * (0.8 + rng() * 0.4));
    threatLabel = '敌方水下潜艇威胁';
  } else {
    threatLabel = '常规水面炮雷编队';
  }

  return {
    name: pickRandom(NODE_NAMES[type] || NODE_NAMES[NODE_TYPES.ENCOUNTER], rng),
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
    weaknessLabel: weakness === 'shelling' ? '炮击弱点' : '鱼雷弱点',
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
    this._presets = createPresetRoutes();
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
   * Procedurally generate a standardized sortie route (3~6 nodes) for the given difficulty.
   * Accepts optional `commander` so Commander `tactics` reveals ahead-of-time node types (`intelRevealed`).
   */
  generateRoute({ difficulty = 'low', nodeCount = null, commander = null, customEnemies = [], rng = Math.random } = {}) {
    const tier = SEA_DIFFICULTIES[difficulty] || SEA_DIFFICULTIES.low;
    const totalNodes = nodeCount
      ? clamp(Math.floor(nodeCount), 3, 6)
      : randInt(tier.nodeRange[0], tier.nodeRange[1], rng);

    const seaCondition = deepClone(pickRandom(SEA_CONDITIONS, rng));
    const stepFuel = Math.max(10, tier.stepCost.fuel + (seaCondition.mods.fuelDelta || 0));
    const stepAmmo = tier.stepCost.ammo;
    const revealChance = commander && typeof commander.getRouteRevealChance === 'function'
      ? commander.getRouteRevealChance()
      : 0.25;

    // Ensure at least one early combat node and always end on a Boss node
    const middleTypeWeights = [
      { type: NODE_TYPES.ENCOUNTER, weight: 36 },
      { type: NODE_TYPES.RESOURCE, weight: 28 },
      { type: NODE_TYPES.WEATHER, weight: 18 },
      { type: NODE_TYPES.ELITE, weight: difficulty === 'low' ? 10 : difficulty === 'medium' ? 22 : 34 },
    ];

    const nodes = [];
    let hasCombatBeforeBoss = false;
    let revealedCount = 0;

    for (let i = 0; i < totalNodes; i++) {
      const code = String.fromCharCode(65 + i);
      const isLast = i === totalNodes - 1;
      let type = NODE_TYPES.BOSS;

      if (!isLast) {
        if (i === 0) {
          type = rng() < 0.65 ? NODE_TYPES.ENCOUNTER : rng() < 0.5 ? NODE_TYPES.RESOURCE : NODE_TYPES.WEATHER;
        } else if (i === totalNodes - 2 && !hasCombatBeforeBoss) {
          type = difficulty === 'low' ? NODE_TYPES.ENCOUNTER : NODE_TYPES.ELITE;
        } else {
          type = weightedPick(middleTypeWeights, (x) => x.weight, rng)?.type || NODE_TYPES.ENCOUNTER;
        }
      }

      if (type === NODE_TYPES.ENCOUNTER || type === NODE_TYPES.ELITE) {
        hasCombatBeforeBoss = true;
      }

      const isCombat = type === NODE_TYPES.ENCOUNTER || type === NODE_TYPES.ELITE || type === NODE_TYPES.BOSS;
      const matchingCustom = isCombat && Array.isArray(customEnemies)
        ? customEnemies.filter((e) => e && e.tier === type)
        : [];
      const enemyTemplate = isCombat
        ? matchingCustom.length > 0 && rng() < 0.45
          ? deepClone(pickRandom(matchingCustom, rng))
          : buildEnemyTemplate(type, tier, rng)
        : null;
      const name = isCombat ? enemyTemplate.name : pickRandom(NODE_NAMES[type], rng);
      const intelRevealed = i === 0 || isLast || rng() < revealChance;
      if (intelRevealed) revealedCount += 1;

      const scale = tier.lootScale * (type === NODE_TYPES.BOSS ? 1.8 : type === NODE_TYPES.ELITE ? 1.3 : 1.0);
      const loot =
        type === NODE_TYPES.RESOURCE
          ? {
              fuel: Math.round(50 * scale),
              steel: Math.round(50 * scale),
              bauxite: Math.round(25 * scale),
              silver: Math.round(75 * scale),
            }
          : type === NODE_TYPES.WEATHER
          ? {
              fuel: Math.round(35 * scale),
              bauxite: Math.round(40 * scale),
              silver: Math.round(65 * scale),
            }
          : type === NODE_TYPES.BOSS
          ? {
              steel: Math.round(95 * scale),
              bauxite: Math.round(60 * scale),
              silver: Math.round(180 * scale),
              gold: tier.goldBonus,
            }
          : {
              steel: Math.round(60 * scale),
              bauxite: Math.round(35 * scale),
              silver: Math.round(115 * scale),
            };

      nodes.push({
        code,
        name,
        type,
        typeLabel: NODE_TYPE_LABELS[type] || type,
        intelRevealed,
        statKey:
          type === NODE_TYPES.RESOURCE
            ? 'recon'
            : type === NODE_TYPES.WEATHER
            ? 'recon'
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
      });
    }

    const prefix = pickRandom(ROUTE_PREFIXES[tier.id] || ROUTE_PREFIXES.low, rng);
    const serial = randInt(10, 99, rng);
    const route = {
      id: `route_gen_${Date.now().toString(36)}_${serial}`,
      name: `${prefix} ${serial}号航线（${tier.label}）`,
      description: `程序化随机生成 · ${totalNodes} 节点（战术预侦察 ${revealedCount}/${totalNodes}）· 海况「${seaCondition.label}」：${seaCondition.description}`,
      difficulty: tier.id,
      difficultyLabel: tier.label,
      builtIn: false,
      generated: true,
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
      this._bus.emit('route:generated', { routeId: route.id, difficulty: tier.id, nodeCount: totalNodes });
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
