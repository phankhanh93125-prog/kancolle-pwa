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
    desc: '基础 10 点解锁 4 席位，之后每 +2 点立增 1 出战席位（上限 12），且每点即刻提升全队攻击与命中',
  },
  {
    key: 'tactics',
    label: '战术',
    group: COMMANDER_STAT_GROUPS.COMBAT,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '每投入 1 点即刻提高舰队索敌侦察加值、航线透视概率与阵型战术加成',
  },
  {
    key: 'charisma',
    label: '魅力',
    group: COMMANDER_STAT_GROUPS.SHIPGIRL,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '每投入 1 点即刻提升舰娘好感度获取效率与宿舍士气恢复速度',
  },
  {
    key: 'affinity',
    label: '亲和',
    group: COMMANDER_STAT_GROUPS.SHIPGIRL,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '每投入 1 点即刻提升舰队协同作战、AR/AO 支援技能与援护效果及互动奇遇好感收益',
  },
  {
    key: 'dispatch',
    label: '调度',
    group: COMMANDER_STAT_GROUPS.LOGISTICS,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '每投入 1 点即刻提升随舰油弹携带上限（+25油/+25弹）、远征收益并降低定向建造消耗',
  },
  {
    key: 'maintenance',
    label: '整备',
    group: COMMANDER_STAT_GROUPS.LOGISTICS,
    defaultValue: 10,
    min: 1,
    max: 200,
    desc: '每投入 1 点即刻加快船坞维修速度、降低维修与强化消耗并提升装备强化效能',
  },
]);

export const COMMANDER_STAT_MAP = Object.freeze(
  Object.fromEntries(COMMANDER_STAT_DEFS.map((d) => [d.key, d]))
);

export const DEFAULT_COMMANDER_FORMULA = Object.freeze({
  minFleetCap: 4,
  maxFleetCap: 12,
  baseCommandForMinCap: 10,
  commandPerExtraSlot: 2,
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
    // Losslessly migrate legacy 10-point stair-step formula (minFleetCap: 3, commandPerExtraSlot: 10) -> v30 immediate formula (4 slots, +1 per 2 pts)
    const isLegacyStairStep =
      Number(rawFormula.minFleetCap) === 3 && Number(rawFormula.commandPerExtraSlot) === 10;
    const formula = {
      minFleetCap: isLegacyStairStep
        ? def.formula.minFleetCap
        : clamp(Math.floor(Number(rawFormula.minFleetCap ?? def.formula.minFleetCap)), 1, 12),
      maxFleetCap: clamp(Math.floor(Number(rawFormula.maxFleetCap ?? def.formula.maxFleetCap)), 4, 12),
      baseCommandForMinCap: clamp(Math.floor(Number(rawFormula.baseCommandForMinCap ?? def.formula.baseCommandForMinCap)), 1, 50),
      commandPerExtraSlot: isLegacyStairStep
        ? def.formula.commandPerExtraSlot
        : clamp(Math.floor(Number(rawFormula.commandPerExtraSlot ?? def.formula.commandPerExtraSlot)), 1, 50),
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

  /**
   * Faster early-game leveling curve: Lv.1->2 requires 50 EXP, +30 per subsequent level
   * so 1~2 sorties or expeditions smoothly level up the Commander.
   */
  getExpToNextLevel(level = this._state.level) {
    const lv = Math.max(1, Math.floor(Number(level) || 1));
    return 50 + (lv - 1) * 30;
  }

  // ------------------------------------------------------------
  // Formula-Driven Per-Point Immediate Gameplay Modifiers (All 7 Stats)
  // ------------------------------------------------------------

  /**
   * 1. `command` (统率): Base 10 -> 4 deployable slots; every +2 points immediately unlocks +1 slot (max 12).
   */
  getFleetSizeCap() {
    const f = this._state.formula;
    const cmd = this._state.stats.command;
    const extraSlots = Math.max(0, Math.floor((cmd - f.baseCommandForMinCap) / Math.max(1, f.commandPerExtraSlot)));
    return clamp(f.minFleetCap + extraSlots, f.minFleetCap, f.maxFleetCap);
  }

  /** Every +1 `command` immediately grants +0.5% fleet attack bonus (up to +45%). */
  getCommandAttackBonusPct() {
    return Number(clamp(this._state.stats.command * 0.005, 0, 0.45).toFixed(4));
  }

  /** Every +1 `command` immediately grants +0.35 accuracy rating to the fleet. */
  getCommandHitBonus() {
    return Number(clamp(this._state.stats.command * 0.35, 0, 25).toFixed(2));
  }

  /** Reduces multi-ship coordination penalty/overhead immediately per point (0..40%). */
  getFleetSynergyOverheadReduction() {
    return Number(clamp(this._state.stats.command * 0.005, 0, 0.4).toFixed(4));
  }

  /**
   * 2. `tactics` (战术): Per-point continuous recon bonus (+1.2 per pt), check modifier (+0.18 per pt),
   * route intel reveal chance, and formation tactical multiplier (+0.5% per pt).
   */
  getTacticsReconBonus() {
    return Number(clamp(this._state.stats.tactics * 1.2, 0, 90).toFixed(1));
  }

  getTacticsCheckBonus() {
    return Number(clamp(this._state.stats.tactics * 0.18, 0, 12).toFixed(2));
  }

  getTacticsFormationBonusPct() {
    return Number(clamp(this._state.stats.tactics * 0.005, 0, 0.45).toFixed(4));
  }

  /** Probability of revealing unknown node types ahead of time on procedural route generation. */
  getRouteRevealChance() {
    return Number(clamp(0.18 + this._state.stats.tactics * 0.012, 0.18, 0.95).toFixed(4));
  }

  /**
   * 3. `charisma` (魅力): Every +1 point immediately improves affinity gain efficiency (+1.5%/pt)
   * and dormitory morale recovery speed (+1.8%/pt).
   */
  getInitialAffinityBonus() {
    return clamp(Math.round(this._state.stats.charisma * 0.5), 0, 45);
  }

  /** Smooth per-point affinity breakthrough threshold reduction (0..18 pts). */
  getAffinityThresholdReduction() {
    return clamp(Math.round(this._state.stats.charisma * 0.2), 0, 18);
  }

  /** Special daily interaction options & tone tendencies unlocked by `charisma`. */
  getInteractionProfile() {
    const ch = this._state.stats.charisma;
    if (ch >= 35) {
      return {
        tier: 3,
        toneLabel: '极具号召力（核心信赖语气）',
        unlockedOptions: ['战术鼓舞演讲', '港区茶会邀约', '私密心声倾听'],
      };
    }
    if (ch >= 18) {
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

  /** Morale recovery acceleration multiplier at Port Hub & Dormitory from Commander `charisma` (+1.8%/pt). */
  getMoraleRecoveryMultiplier() {
    return Number((1 + clamp(this._state.stats.charisma * 0.018, 0, 2.0)).toFixed(4));
  }

  /**
   * 4. `affinity` (亲和): Every +1 point immediately boosts fleet synergy combat (+0.45%/pt),
   * AR/AO/escort support skill multiplier (+1.2%/pt), wingman assist chance, and daily interaction affinity gain.
   */
  getAffinitySynergyBonusPct() {
    return Number(clamp(this._state.stats.affinity * 0.0045, 0, 0.45).toFixed(4));
  }

  getSupportSkillMultiplier() {
    return Number((1 + clamp(this._state.stats.affinity * 0.012, 0, 1.5)).toFixed(4));
  }

  /** Combined affinity gain multiplier driven immediately by `charisma` (+1.5%/pt) and `affinity` (+1.2%/pt). */
  getAffinityGainMultiplier() {
    const chBonus = this._state.stats.charisma * 0.015;
    const afBonus = this._state.stats.affinity * 0.012;
    return Number((1 + clamp(chBonus + afBonus, 0, 2.2)).toFixed(4));
  }

  /** Wingman Cover (援护挡伤) & Coordinated Follow-up (协同补刀) base trigger chance. */
  getWingmanAssistChance() {
    return Number(clamp(0.14 + this._state.stats.affinity * 0.008, 0.14, 0.72).toFixed(4));
  }

  /**
   * 5. `dispatch` (调度): Every +1 point immediately adds +25 carried fuel & +25 carried ammo cap,
   * raises expedition rewards (+1.5%/pt), and discounts deterministic ship/gear crafting costs (-0.6%/pt).
   */
  getSortieStepDiscount() {
    return Number(clamp(this._state.stats.dispatch * 0.005, 0, 0.42).toFixed(4));
  }

  getCraftingCostDiscount() {
    return Number(clamp(this._state.stats.dispatch * 0.006, 0, 0.36).toFixed(4));
  }

  /** Expedition resource & silver reward multiplier from Commander `dispatch` (+1.5%/pt). */
  getExpeditionRewardMultiplier() {
    return Number((1 + clamp(this._state.stats.dispatch * 0.015, 0, 2.0)).toFixed(4));
  }

  /**
   * 6. `maintenance` (整备): Every +1 point immediately speeds up Dockyard repair (+2.0%/pt),
   * reduces Dockyard repair resource costs (-0.8%/pt), discounts Workshop enhancement (-0.7%/pt),
   * and amplifies equipment enhancement effectiveness (+0.8%/pt).
   */
  getRepairSpeedMultiplier() {
    return Number((1 + clamp(this._state.stats.maintenance * 0.02, 0, 2.5)).toFixed(4));
  }

  /** Port repair steel & bauxite discount from Commander `maintenance` (0..48%). */
  getRepairCostDiscount() {
    return Number(clamp(this._state.stats.maintenance * 0.008, 0, 0.48).toFixed(4));
  }

  /** Workshop enhancement cost discount from Commander `maintenance` (0..45%). */
  getEnhanceCostDiscount() {
    return Number(clamp(this._state.stats.maintenance * 0.007, 0, 0.45).toFixed(4));
  }

  /** Workshop enhancement bonus multiplier from Commander `maintenance` (+0.8%/pt). */
  getEnhanceEffectivenessMultiplier() {
    return Number((1 + clamp(this._state.stats.maintenance * 0.008, 0, 0.65)).toFixed(4));
  }

  /** Effectiveness multiplier for the 3 mandatory core slots (engine / armor / core). */
  getCorePartsAmplifier() {
    return Number((1 + clamp(this._state.stats.maintenance * 0.004, 0, 0.45)).toFixed(4));
  }

  /**
   * 7. Independent Luck (`luck`, 0-based, +/-) — ZERO 10-point stair-step!
   * Every 1 point directly provides d20 check modifier, crit chance bonus, and rare salvage drop bonus.
   */
  getLuckEffects() {
    const lk = this._state.luck;
    const d20CheckBonus = Number(clamp(lk * 0.25, -6, 10).toFixed(2));
    const critChanceBonus = Number(clamp(lk * 0.008, -0.15, 0.45).toFixed(4));
    const critSuccessShift = lk >= 8 ? Math.min(3, Math.floor(lk / 8)) : 0;
    const critFailShift = lk <= -8 ? Math.min(3, Math.floor(Math.abs(lk) / 8)) : 0;
    const edgeCheckMod = lk >= 0 ? Math.round(lk * 0.25) : -Math.round(Math.abs(lk) * 0.25);
    const rareDropBonus = Number(clamp(lk * 0.012, -0.25, 0.6).toFixed(4));
    const hiddenEncounterBonus = Number(clamp(lk * 0.01, -0.15, 0.45).toFixed(4));
    return {
      luck: lk,
      d20CheckBonus,
      critChanceBonus,
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
      commandAttackBonusPct: this.getCommandAttackBonusPct(),
      commandHitBonus: this.getCommandHitBonus(),
      synergyOverheadReduction: this.getFleetSynergyOverheadReduction(),
      tacticsReconBonus: this.getTacticsReconBonus(),
      tacticsCheckBonus: this.getTacticsCheckBonus(),
      tacticsFormationBonusPct: this.getTacticsFormationBonusPct(),
      routeRevealChance: this.getRouteRevealChance(),
      initialAffinityBonus: this.getInitialAffinityBonus(),
      affinityThresholdReduction: this.getAffinityThresholdReduction(),
      interactionProfile: this.getInteractionProfile(),
      affinityGainMultiplier: this.getAffinityGainMultiplier(),
      affinitySynergyBonusPct: this.getAffinitySynergyBonusPct(),
      supportSkillMultiplier: this.getSupportSkillMultiplier(),
      moraleRecoveryMultiplier: this.getMoraleRecoveryMultiplier(),
      wingmanAssistChance: this.getWingmanAssistChance(),
      sortieStepDiscount: this.getSortieStepDiscount(),
      craftingCostDiscount: this.getCraftingCostDiscount(),
      repairSpeedMultiplier: this.getRepairSpeedMultiplier(),
      repairCostDiscount: this.getRepairCostDiscount(),
      expeditionRewardMultiplier: this.getExpeditionRewardMultiplier(),
      enhanceCostDiscount: this.getEnhanceCostDiscount(),
      enhanceEffectivenessMultiplier: this.getEnhanceEffectivenessMultiplier(),
      corePartsAmplifier: this.getCorePartsAmplifier(),
      carriedSupplyCaps: this.getCarriedSupplyCaps(),
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
   * Combined Logistics capability (dispatch + maintenance) readout.
   */
  getLogisticsScore() {
    const dispatch = Number(this._state.stats?.dispatch ?? 10) || 10;
    const maintenance = Number(this._state.stats?.maintenance ?? 10) || 10;
    return Math.round(dispatch * 0.7 + maintenance * 0.3);
  }

  /**
   * Compute maximum carried Fuel & Ammo for a single sortie:
   * Every +1 `dispatch` immediately adds +25 Fuel & +25 Ammo cap!
   */
  getCarriedSupplyCaps({ aoCount = 0, logisticsBonus = 0 } = {}) {
    const dispatch = Math.max(1, Number(this._state.stats?.dispatch ?? 10) || 10);
    const logScore = this.getLogisticsScore();
    const ao = Math.max(0, Math.floor(Number(aoCount) || 0));
    const bonus = Math.max(0, Math.round(Number(logisticsBonus) || 0));
    const maxFuel = Math.round(150 + dispatch * 25 + ao * 160 + bonus);
    const maxAmmo = Math.round(150 + dispatch * 25 + ao * 160 + bonus);
    return {
      logisticsScore: logScore,
      dispatch,
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
