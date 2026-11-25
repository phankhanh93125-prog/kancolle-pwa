/**
 * Generic Stat Rules, Dynamic Status Bars, Affinity Stages, and 1D20 Check Engine.
 *
 * Domain-neutral rule definitions:
 *   - 5 Core Stats: attack, burst, agility, tactics, luck (default 10..100, +1 check mod per 10 pts)
 *   - Dynamic Status Bars: hp, morale (0..100), ap (supports offline auto-recovery)
 *   - Affinity Stages: 0..100 mapped cleanly into 4 stages
 *   - Standard 1D20 Check: 1D20 + statMod + equipmentCheckBonus + moraleMod + extraMod vs DC
 *     yielding 'crit-success' | 'success' | 'fail' | 'crit-fail' with step-by-step breakdown.
 */

import { clamp, roll } from './calc-engine.js';

const STORAGE_NS = 'core-stat-rules';
const CONFIG_KEY = 'rules-config';

export const CORE_STAT_DEFS = Object.freeze([
  { key: 'attack', label: '攻击/火力', shortLabel: '攻击', min: 10, max: 100, defaultValue: 50 },
  { key: 'burst', label: '爆发/雷装', shortLabel: '爆发', min: 10, max: 100, defaultValue: 45 },
  { key: 'agility', label: '机动', shortLabel: '机动', min: 10, max: 100, defaultValue: 55 },
  { key: 'tactics', label: '战术/侦察', shortLabel: '战术', min: 10, max: 100, defaultValue: 50 },
  { key: 'luck', label: '幸运', shortLabel: '幸运', min: 10, max: 100, defaultValue: 40 },
]);

export const CORE_STAT_MAP = Object.freeze(
  Object.fromEntries(CORE_STAT_DEFS.map((d) => [d.key, d]))
);

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
  statMin: 10,
  statMax: 100,
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
    attack: 1.2,
    burst: 1.1,
    agility: 1.0,
    tactics: 1.0,
    luck: 0.8,
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
        attack: clamp(Number(weights.attack ?? base.scoreWeights.attack), 0.1, 5),
        burst: clamp(Number(weights.burst ?? base.scoreWeights.burst), 0.1, 5),
        agility: clamp(Number(weights.agility ?? base.scoreWeights.agility), 0.1, 5),
        tactics: clamp(Number(weights.tactics ?? base.scoreWeights.tactics), 0.1, 5),
        luck: clamp(Number(weights.luck ?? base.scoreWeights.luck), 0.1, 5),
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

  getAffinityStage(affinityValue) {
    const val = clamp(Math.round(Number(affinityValue ?? 0)), 0, 100);
    const stage =
      AFFINITY_STAGES.find((s) => val >= s.min && val <= s.max) || AFFINITY_STAGES[0];
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
      progressInStage: Number(progressInStage.toFixed(4)),
    };
  }

  /**
   * Compute overall composite character rating from effective 5 core stats + check bonus.
   */
  computeOverallScore(effectiveStats = {}, equipmentCheckBonus = 0) {
    const w = this._config.scoreWeights;
    let total = 0;
    for (const def of CORE_STAT_DEFS) {
      total += (Number(effectiveStats[def.key]) || 0) * (w[def.key] || 1);
    }
    total += (Number(equipmentCheckBonus) || 0) * 12;
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
   */
  buildOfflineRecoveryRules(entityList = []) {
    const rates = this._config.offlineRecoveryPerMin;
    const rules = [];
    for (const entity of entityList) {
      const maxHp = Number(entity.stats?.maxHp ?? 100);
      const maxAp = Number(entity.stats?.maxAp ?? 100);
      rules.push(
        { entityId: entity.id, stat: 'hp', ratePerMinute: rates.hp, min: 0, max: maxHp, round: 'round' },
        { entityId: entity.id, stat: 'morale', ratePerMinute: rates.morale, min: 0, max: 100, round: 'round' },
        { entityId: entity.id, stat: 'ap', ratePerMinute: rates.ap, min: 0, max: maxAp, round: 'round' }
      );
    }
    return rules;
  }

  // ------------------------------------------------------------
  // Standard 1D20 Attribute Check
  // ------------------------------------------------------------

  /**
   * Execute standard 1D20 + statMod + equipmentBonus + moraleMod (+ extraMod) vs DC check.
   *
   * @param {{
   *   actorId?: string,
   *   actorName?: string,
   *   statKey: string,
   *   baseStatValue: number,
   *   effectiveStatValue?: number,
   *   equipmentCheckBonus?: number,
   *   moraleValue?: number,
   *   dc?: number,
   *   extraModifier?: number,
   *   rng?: () => number,
   *   emitEvent?: boolean
   * }} params
   */
  performCheck({
    actorId = null,
    actorName = '',
    statKey = 'attack',
    baseStatValue = 50,
    effectiveStatValue = null,
    equipmentCheckBonus = 0,
    moraleValue = 60,
    dc = 15,
    extraModifier = 0,
    rng = Math.random,
    emitEvent = true,
  } = {}) {
    const statDef = CORE_STAT_MAP[statKey] || { key: statKey, label: statKey };
    const baseVal = Number(baseStatValue) || 0;
    const effVal = effectiveStatValue !== null && effectiveStatValue !== undefined ? Number(effectiveStatValue) : baseVal;
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
    const targetDc = clamp(Math.round(Number(dc) || 15), 1, 99);

    const total = naturalRoll + baseStatMod + totalEquipModifier + moraleMod + extraMod;
    const margin = total - targetDc;

    let outcome = 'fail';
    let outcomeLabel = '失败';
    if (naturalRoll <= this._config.critFailNatural) {
      outcome = 'crit-fail';
      outcomeLabel = '大失败';
    } else if (naturalRoll >= this._config.critSuccessNatural) {
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
        label: `装备与服装加成（属性 ${formatSigned(equipStatDelta)} → 修正 ${formatSigned(statBonusFromEquipMod)}，检定词条 ${formatSigned(flatEquipCheckBonus)}）`,
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
      steps.push({ label: '额外修正', value: extraMod, text: formatSigned(extraMod) });
    }

    const formulaParts = [
      `1D${this._config.diceSides}(${naturalRoll})`,
      `属性(${formatSigned(baseStatMod)})`,
      `装备服装(${formatSigned(totalEquipModifier)})`,
      `士气(${formatSigned(moraleMod)})`,
    ];
    if (extraMod !== 0) formulaParts.push(`额外(${formatSigned(extraMod)})`);
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
