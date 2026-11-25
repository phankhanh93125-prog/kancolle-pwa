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
