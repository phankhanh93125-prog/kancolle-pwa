/**
 * Commander Character Card & Growth Engine (`commander-system.js`).
 *
 * Implements:
 *   - Customizable Commander identity: name, title, avatar (via AssetManager), personality tags
 *   - Level & EXP progression (gained from sortie node progression & completed expeditions)
 *     granting free stat points upon level-up, plus manual debug override support
 *   - Strictly 6 Core Stats grouped into 2 Combat + 2 Shipgirl + 2 Logistics:
 *       * command     (统率 · 战斗): Fleet size cap (default 3..12, customizable formula) & multi-ship overhead reduction
 *       * tactics     (战术 · 战斗): Scan/Evade check bonus & procedural route node intel reveal probability
 *       * charisma    (魅力 · 舰娘): New recruit initial affinity bonus, lower affinity stage thresholds, special interaction tone
 *       * affinity    (亲和 · 舰娘): Post-battle affinity gain multiplier, port morale recovery boost, wingman Guard & Follow-up assist chance
 *       * dispatch    (调度 · 后勤): Sortie fuel/ammo step discount, port repair steel/bauxite discount, expedition reward multiplier
 *       * maintenance (整备 · 后勤): Workshop enhancement material discount & 3-core-part (engine/armor/core) effectiveness amplifier
 *   - Independent Special Stat `luck` (运气):
 *       * Separated outside the 6 core stats, strictly initialized to 0
 *       * Cannot be upgraded via normal level-up free points; only mutated via special events, rare items, milestones, or manual debug
 *       * Supports both positive and negative values; tunes D20 crit-success/crit-fail edge thresholds, rare drop rates, and hidden encounters
 */

import { clamp } from './calc-engine.js';

const STORAGE_NS = 'core-commander';
const STATE_KEY = 'commander-state-v1';

export const COMMANDER_STAT_GROUPS = Object.freeze({
  COMBAT: 'combat',
  SHIPGIRL: 'shipgirl',
  LOGISTICS: 'logistics',
});

export const COMMANDER_STAT_GROUP_LABELS = Object.freeze({
  [COMMANDER_STAT_GROUPS.COMBAT]: '战斗指挥',
  [COMMANDER_STAT_GROUPS.SHIPGIRL]: '舰娘羁绊',
  [COMMANDER_STAT_GROUPS.LOGISTICS]: '后勤保障',
});

export const COMMANDER_STAT_DEFS = Object.freeze([
  {
    key: 'command',
    label: '统率',
    group: COMMANDER_STAT_GROUPS.COMBAT,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '决定单次出征编队人数上限（3~12人），降低多船协同损耗',
  },
  {
    key: 'tactics',
    label: '战术',
    group: COMMANDER_STAT_GROUPS.COMBAT,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '提升遇敌「扫描/迂回」成功率，提高随机航线提前看穿节点概率',
  },
  {
    key: 'charisma',
    label: '魅力',
    group: COMMANDER_STAT_GROUPS.SHIPGIRL,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '提升初始好感、降低好感突破门槛，解锁特殊日常互动选项与语气',
  },
  {
    key: 'affinity',
    label: '亲和',
    group: COMMANDER_STAT_GROUPS.SHIPGIRL,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '提升战后好感倍率、加快士气恢复，提高僚机援护挡伤与协同补刀率',
  },
  {
    key: 'dispatch',
    label: '调度',
    group: COMMANDER_STAT_GROUPS.LOGISTICS,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '降低出征单步油弹与入渠钢铝消耗，提升远征物资与银条收益',
  },
  {
    key: 'maintenance',
    label: '整备',
    group: COMMANDER_STAT_GROUPS.LOGISTICS,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '降低工坊强化材料消耗，并放大「引擎/装甲/核心」三核心部件效能',
  },
]);

export const COMMANDER_STAT_MAP = Object.freeze(
  Object.fromEntries(COMMANDER_STAT_DEFS.map((d) => [d.key, d]))
);

export const DEFAULT_COMMANDER_FORMULA = Object.freeze({
  minFleetCap: 3,
  maxFleetCap: 12,
  baseCommandForMinCap: 10,
  commandPerExtraSlot: 10,
  pointsPerLevel: 3,
});

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function createDefaultCommanderState() {
  return {
    name: '港区指挥官',
    title: '新任提督',
    avatarAssetId: null,
    personalityTags: ['沉着务实', '重视协同'],
    level: 1,
    exp: 0,
    freePoints: 0,
    stats: {
      command: 10,
      tactics: 10,
      charisma: 10,
      affinity: 10,
      dispatch: 10,
      maintenance: 10,
    },
    /** Independent special stat: strictly initialized to 0, outside the 6 core stats */
    luck: 0,
    formula: { ...DEFAULT_COMMANDER_FORMULA },
    milestones: [],
    updatedAt: Date.now(),
  };
}

export class CommanderSystem {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({ storage, bus = null }) {
    this._storage = storage;
    this._scope = storage.namespace(STORAGE_NS);
    this._bus = bus;
    this._state = createDefaultCommanderState();
    this._hydrated = false;
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  _sanitizeState(raw = {}) {
    const def = createDefaultCommanderState();
    const rawStats = raw.stats || {};
    const stats = {};
    for (const d of COMMANDER_STAT_DEFS) {
      stats[d.key] = clamp(Math.round(Number(rawStats[d.key] ?? d.defaultValue) || d.defaultValue), d.min, d.max);
    }
    const rawFormula = raw.formula || {};
    const formula = {
      minFleetCap: clamp(Math.floor(Number(rawFormula.minFleetCap ?? def.formula.minFleetCap)), 1, 12),
      maxFleetCap: clamp(Math.floor(Number(rawFormula.maxFleetCap ?? def.formula.maxFleetCap)), 3, 12),
      baseCommandForMinCap: clamp(Math.floor(Number(rawFormula.baseCommandForMinCap ?? def.formula.baseCommandForMinCap)), 1, 50),
      commandPerExtraSlot: clamp(Math.floor(Number(rawFormula.commandPerExtraSlot ?? def.formula.commandPerExtraSlot)), 1, 50),
      pointsPerLevel: clamp(Math.floor(Number(rawFormula.pointsPerLevel ?? def.formula.pointsPerLevel)), 1, 20),
    };
    if (formula.maxFleetCap < formula.minFleetCap) {
      formula.maxFleetCap = formula.minFleetCap;
    }

    const luckVal = Number(raw.luck);
    return {
      name: String(raw.name || def.name).trim() || def.name,
      title: String(raw.title || def.title).trim() || def.title,
      avatarAssetId: raw.avatarAssetId || null,
      personalityTags: Array.isArray(raw.personalityTags)
        ? raw.personalityTags.map((t) => String(t).trim()).filter(Boolean)
        : def.personalityTags,
      level: clamp(Math.floor(Number(raw.level ?? 1) || 1), 1, 999),
      exp: Math.max(0, Math.floor(Number(raw.exp ?? 0) || 0)),
      freePoints: Math.max(0, Math.floor(Number(raw.freePoints ?? 0) || 0)),
      stats,
      luck: Number.isFinite(luckVal) ? clamp(Math.round(luckVal), -100, 100) : 0,
      formula,
      milestones: Array.isArray(raw.milestones) ? raw.milestones.slice(-40) : [],
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  }

  async init() {
    if (this._hydrated) return;
    const saved = await this._scope.getLarge(STATE_KEY, null);
    if (saved && typeof saved === 'object') {
      this._state = this._sanitizeState(saved);
    } else {
      this._state = createDefaultCommanderState();
      await this.persist();
    }
    this._hydrated = true;
  }

  async persist() {
    this._state.updatedAt = Date.now();
    await this._scope.setLarge(STATE_KEY, deepClone(this._state));
  }

  getProfile() {
    return {
      ...deepClone(this._state),
      expToNext: this.getExpToNextLevel(this._state.level),
      fleetCap: this.getFleetSizeCap(),
      effects: this.getEffectSummary(),
    };
  }

  getStat(key) {
    if (key === 'luck') return this._state.luck;
    return Number(this._state.stats[key] ?? 0);
  }

  getLuck() {
    return this._state.luck;
  }

  getExpToNextLevel(level = this._state.level) {
    const lv = Math.max(1, Math.floor(Number(level) || 1));
    return 100 + (lv - 1) * 50;
  }

  // ------------------------------------------------------------
  // Formula-Driven Derived Gameplay Modifiers
  // ------------------------------------------------------------

  /**
   * Fleet size cap strictly between minFleetCap (default 3) and maxFleetCap (default 12),
   * governed by Commander `command` (统率).
   * Default: command 10 -> 3 ships; +1 slot per +10 command up to 12 ships at command 100.
   */
  getFleetSizeCap() {
    const f = this._state.formula;
    const cmd = this._state.stats.command;
    const extraSlots = Math.max(0, Math.floor((cmd - f.baseCommandForMinCap) / f.commandPerExtraSlot));
    return clamp(f.minFleetCap + extraSlots, f.minFleetCap, f.maxFleetCap);
  }

  /** Reduces multi-ship coordination penalty/overhead as command grows (0..35%). */
  getFleetSynergyOverheadReduction() {
    return Number(clamp(this._state.stats.command * 0.0035, 0, 0.35).toFixed(4));
  }

  /** Bonus check modifier for Scan & Evade from Commander `tactics` (+1 per 10 pts). */
  getTacticsCheckBonus() {
    return Math.floor(this._state.stats.tactics / 10);
  }

  /** Probability of revealing unknown node types ahead of time on procedural route generation. */
  getRouteRevealChance() {
    return Number(clamp(0.15 + this._state.stats.tactics * 0.008, 0.15, 0.9).toFixed(4));
  }

  /** Extra starting affinity for newly recruited shipgirls from Commander `charisma`. */
  getInitialAffinityBonus() {
    return clamp(Math.floor(this._state.stats.charisma * 0.4), 0, 40);
  }

  /** Reduces affinity stage breakthrough thresholds (0..15 pts). */
  getAffinityThresholdReduction() {
    return clamp(Math.floor(this._state.stats.charisma / 10) * 2, 0, 15);
  }

  /** Special daily interaction options & tone tendencies unlocked by `charisma`. */
  getInteractionProfile() {
    const ch = this._state.stats.charisma;
    if (ch >= 60) {
      return {
        tier: 3,
        toneLabel: '极具号召力（核心信赖语气）',
        unlockedOptions: ['战术鼓舞演讲', '港区茶会邀约', '私密心声倾听'],
      };
    }
    if (ch >= 30) {
      return {
        tier: 2,
        toneLabel: '亲切可靠（温和鼓励语气）',
        unlockedOptions: ['战术鼓舞演讲', '港区茶会邀约'],
      };
    }
    return {
      tier: 1,
      toneLabel: '稳重标准（常规指挥语气）',
      unlockedOptions: ['常规执勤慰问'],
    };
  }

  /** Post-combat & event affinity gain multiplier from Commander `affinity`. */
  getAffinityGainMultiplier() {
    return Number((1 + clamp(this._state.stats.affinity * 0.01, 0, 1.5)).toFixed(4));
  }

  /** Morale recovery acceleration multiplier at Port Hub from Commander `affinity`. */
  getMoraleRecoveryMultiplier() {
    return Number((1 + clamp(this._state.stats.affinity * 0.015, 0, 1.5)).toFixed(4));
  }

  /** Wingman Cover (援护挡伤) & Coordinated Follow-up (协同补刀) base trigger chance. */
  getWingmanAssistChance() {
    return Number(clamp(0.12 + this._state.stats.affinity * 0.006, 0.12, 0.65).toFixed(4));
  }

  /** Sortie step fuel & ammo discount from Commander `dispatch` (0..40%). */
  getSortieStepDiscount() {
    return Number(clamp(this._state.stats.dispatch * 0.004, 0, 0.4).toFixed(4));
  }

  /** Port repair steel & bauxite discount from Commander `dispatch` (0..45%). */
  getRepairCostDiscount() {
    return Number(clamp(this._state.stats.dispatch * 0.005, 0, 0.45).toFixed(4));
  }

  /** Expedition resource & silver reward multiplier from Commander `dispatch`. */
  getExpeditionRewardMultiplier() {
    return Number((1 + clamp(this._state.stats.dispatch * 0.012, 0, 1.5)).toFixed(4));
  }

  /** Workshop enhancement cost discount from Commander `maintenance` (0..45%). */
  getEnhanceCostDiscount() {
    return Number(clamp(this._state.stats.maintenance * 0.005, 0, 0.45).toFixed(4));
  }

  /** Effectiveness multiplier for the 3 mandatory core slots (engine / armor / core). */
  getCorePartsAmplifier() {
    return Number((1 + clamp(this._state.stats.maintenance * 0.003, 0, 0.35)).toFixed(4));
  }

  /**
   * Independent Luck (`luck`, 0-based, +/-) adjustments:
   *  - Edge shifts on D20 crit-success / crit-fail natural roll thresholds
   *  - Rare drop rate delta on salvage & supply pool
   *  - Hidden encounter bonus chance
   */
  getLuckEffects() {
    const lk = this._state.luck;
    const critSuccessShift = lk > 0 ? Math.min(3, Math.floor(lk / 10)) : 0; // lowers crit-success natural threshold (e.g. 20 -> 19)
    const critFailShift = lk < 0 ? Math.min(3, Math.floor(Math.abs(lk) / 10)) : 0; // raises crit-fail natural threshold (e.g. 1 -> 2)
    const edgeCheckMod = lk >= 0 ? Math.floor(lk / 15) : Math.ceil(lk / 15);
    const rareDropBonus = Number(clamp(lk * 0.01, -0.25, 0.5).toFixed(4));
    const hiddenEncounterBonus = Number(clamp(lk * 0.008, -0.15, 0.4).toFixed(4));
    return {
      luck: lk,
      critSuccessShift,
      critFailShift,
      edgeCheckMod,
      rareDropBonus,
      hiddenEncounterBonus,
    };
  }

  getEffectSummary() {
    const luckFx = this.getLuckEffects();
    return {
      fleetCap: this.getFleetSizeCap(),
      synergyOverheadReduction: this.getFleetSynergyOverheadReduction(),
      tacticsCheckBonus: this.getTacticsCheckBonus(),
      routeRevealChance: this.getRouteRevealChance(),
      initialAffinityBonus: this.getInitialAffinityBonus(),
      affinityThresholdReduction: this.getAffinityThresholdReduction(),
      interactionProfile: this.getInteractionProfile(),
      affinityGainMultiplier: this.getAffinityGainMultiplier(),
      moraleRecoveryMultiplier: this.getMoraleRecoveryMultiplier(),
      wingmanAssistChance: this.getWingmanAssistChance(),
      sortieStepDiscount: this.getSortieStepDiscount(),
      repairCostDiscount: this.getRepairCostDiscount(),
      expeditionRewardMultiplier: this.getExpeditionRewardMultiplier(),
      enhanceCostDiscount: this.getEnhanceCostDiscount(),
      corePartsAmplifier: this.getCorePartsAmplifier(),
      luckEffects: luckFx,
    };
  }

  // ------------------------------------------------------------
  // Mutations: Profile, EXP, Free Point Allocation, Luck & Debug
  // ------------------------------------------------------------

  async updateProfile(patch = {}) {
    if (patch.name !== undefined) {
      const clean = String(patch.name).trim();
      if (clean) this._state.name = clean;
    }
    if (patch.title !== undefined) {
      const clean = String(patch.title).trim();
      if (clean) this._state.title = clean;
    }
    if (patch.avatarAssetId !== undefined) {
      this._state.avatarAssetId = patch.avatarAssetId || null;
    }
    if (patch.personalityTags !== undefined) {
      this._state.personalityTags = Array.isArray(patch.personalityTags)
        ? patch.personalityTags.map((t) => String(t).trim()).filter(Boolean)
        : String(patch.personalityTags || '')
            .split(/[,，、\s]+/)
            .map((t) => t.trim())
            .filter(Boolean);
    }
    await this.persist();
    const profile = this.getProfile();
    this._emit('commander:updated', { profile, reason: 'profile' });
    return profile;
  }

  async updateFormulaConfig(patch = {}) {
    this._state = this._sanitizeState({
      ...this._state,
      formula: {
        ...this._state.formula,
        ...(patch || {}),
      },
    });
    await this.persist();
    const profile = this.getProfile();
    this._emit('commander:updated', { profile, reason: 'formula' });
    return profile;
  }

  /**
   * Combined Logistics capability (dispatch + maintenance) governing carried sortie oil/ammo caps.
   */
  getLogisticsScore() {
    const dispatch = Number(this._state.stats?.dispatch ?? 10) || 10;
    const maintenance = Number(this._state.stats?.maintenance ?? 10) || 10;
    return Math.round(dispatch * 0.65 + maintenance * 0.35);
  }

  /**
   * Compute maximum carried Fuel & Ammo for a single sortie based on Commander Logistics,
   * Port logistics facility upgrades, and Supply Ships (AO) in the active fleet.
   */
  getCarriedSupplyCaps({ aoCount = 0, logisticsBonus = 0 } = {}) {
    const logScore = this.getLogisticsScore();
    const ao = Math.max(0, Math.floor(Number(aoCount) || 0));
    const bonus = Math.max(0, Math.round(Number(logisticsBonus) || 0));
    const maxFuel = Math.round(220 + logScore * 14 + ao * 160 + bonus);
    const maxAmmo = Math.round(220 + logScore * 14 + ao * 160 + bonus);
    return {
      logisticsScore: logScore,
      aoCount: ao,
      maxFuel,
      maxAmmo,
    };
  }

  /**
   * Grant Commander EXP (from sortie node clear or expedition completion).
   * Automatically handles multi-level ups and awards free stat points.
   */
  async grantExp(amount, reason = '作战经验') {
    const gain = Math.max(0, Math.round(Number(amount) || 0));
    if (gain <= 0) return { leveledUp: false, levelsGained: 0, profile: this.getProfile() };

    const prevLevel = this._state.level;
    this._state.exp += gain;
    let levelsGained = 0;

    while (this._state.exp >= this.getExpToNextLevel(this._state.level)) {
      this._state.exp -= this.getExpToNextLevel(this._state.level);
      this._state.level += 1;
      this._state.freePoints += this._state.formula.pointsPerLevel;
      levelsGained += 1;
    }

    await this.persist();
    const profile = this.getProfile();
    this._emit('commander:exp-gained', {
      gain,
      reason,
      prevLevel,
      level: this._state.level,
      levelsGained,
      freePoints: this._state.freePoints,
    });
    if (levelsGained > 0) {
      this._emit('commander:leveled-up', {
        prevLevel,
        level: this._state.level,
        levelsGained,
        pointsAwarded: levelsGained * this._state.formula.pointsPerLevel,
      });
    }
    this._emit('commander:updated', { profile, reason: 'exp' });
    return { leveledUp: levelsGained > 0, levelsGained, profile };
  }

  /**
   * Allocate level-up freePoints into one of the 6 core stats.
   * Strictly rejects `luck` because Luck does not participate in regular level-up point allocation.
   */
  async allocateStat(statKey, points = 1) {
    if (statKey === 'luck') {
      throw new Error('「运气」为独立特殊属性，不参与升级自由加点');
    }
    const def = COMMANDER_STAT_MAP[statKey];
    if (!def) {
      throw new Error(`未知指挥官属性：${statKey}`);
    }
    const spend = Math.max(1, Math.floor(Number(points) || 1));
    if (this._state.freePoints < spend) {
      throw new Error(`可用自由属性点不足（剩余 ${this._state.freePoints}）`);
    }
    const nextVal = clamp(this._state.stats[statKey] + spend, def.min, def.max);
    const actualAdded = nextVal - this._state.stats[statKey];
    if (actualAdded <= 0) {
      throw new Error(`「${def.label}」已达上限 (${def.max})`);
    }
    this._state.stats[statKey] = nextVal;
    this._state.freePoints -= actualAdded;
    await this.persist();
    const profile = this.getProfile();
    this._emit('commander:stats-changed', {
      statKey,
      delta: actualAdded,
      value: nextVal,
      profile,
    });
    this._emit('commander:updated', { profile, reason: 'allocate' });
    return profile;
  }

  /**
   * Reset all 6 allocated core stats back to baseline (10) and refund 100% of spent points into freePoints.
   * Independent `luck` is preserved untouched.
   */
  async resetAllocatedStats() {
    let refunded = 0;
    for (const def of COMMANDER_STAT_DEFS) {
      const cur = Math.round(Number(this._state.stats[def.key] ?? 10));
      if (cur > 10) {
        refunded += cur - 10;
        this._state.stats[def.key] = 10;
      }
    }
    this._state.freePoints = Math.max(0, Math.round(Number(this._state.freePoints || 0))) + refunded;
    await this.persist();
    const profile = this.getProfile();
    this._emit('commander:updated', { profile, reason: 'reset-stats', refunded });
    return { refunded, freePoints: this._state.freePoints, profile };
  }

  /**
   * Adjust independent Luck stat (positive or negative) via special events, rare items, or milestones.
   */
  async adjustLuck(delta, reason = '特殊事件影响') {
    const d = Math.round(Number(delta) || 0);
    if (d === 0) return this.getProfile();
    const before = this._state.luck;
    this._state.luck = clamp(before + d, -100, 100);
    this._state.milestones.push({
      id: `lk_${Date.now().toString(36)}`,
      reason: String(reason),
      delta: this._state.luck - before,
      after: this._state.luck,
      timestamp: Date.now(),
    });
    if (this._state.milestones.length > 40) {
      this._state.milestones = this._state.milestones.slice(-40);
    }
    await this.persist();
    const profile = this.getProfile();
    this._emit('commander:luck-changed', {
      before,
      after: this._state.luck,
      delta: this._state.luck - before,
      reason,
      profile,
    });
    this._emit('commander:updated', { profile, reason: 'luck' });
    return profile;
  }

  /**
   * Mobile debug / manual adjustment entry for stats, level, freePoints, and Luck.
   */
  async setStatsManual(patch = {}) {
    const nextStats = { ...this._state.stats };
    for (const def of COMMANDER_STAT_DEFS) {
      if (patch[def.key] !== undefined) {
        nextStats[def.key] = clamp(Math.round(Number(patch[def.key]) || def.defaultValue), def.min, def.max);
      }
    }
    this._state = this._sanitizeState({
      ...this._state,
      stats: nextStats,
      luck: patch.luck !== undefined ? Number(patch.luck) : this._state.luck,
      level: patch.level !== undefined ? Number(patch.level) : this._state.level,
      freePoints: patch.freePoints !== undefined ? Number(patch.freePoints) : this._state.freePoints,
    });
    await this.persist();
    const profile = this.getProfile();
    this._emit('commander:stats-changed', { manual: true, profile });
    this._emit('commander:updated', { profile, reason: 'manual-debug' });
    return profile;
  }

  serialize() {
    return deepClone(this._state);
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._state = this._sanitizeState(snapshot);
    if (persist) {
      this.persist();
    }
    this._emit('commander:updated', { profile: this.getProfile(), reason: 'deserialize' });
  }
}
