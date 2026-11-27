/**
 * Unified Mixed-Initiative Ship-Type Tactical Combat Engine (`tactical-combat.js`).
 *
 * Core Mechanics:
 *   - Unified Ally + Enemy Initiative Queue (`turnQueue[]`) sorted by `evasion + initiativeBonus`
 *     so fast enemy destroyers/submarines/elites can interleave before slow allied battleships/carriers.
 *   - Pre-Battle Recon Check (`allyRecon + commanderTactics` vs `enemyStealth`) & Enemy Preemptive Ambush.
 *   - Automatic Opening Strikes before Round 1:
 *       * Opening Airstrike (allied & enemy CVs mitigated by defender `aa` interception ratio)
 *       * Opening Torpedo (submarines & high-torpedo units inhibited by defender `asw` & `evasion`)
 *   - Dynamic Enemy Scaling (up to 6~12 enemy ships in medium/high/deep nodes) + Strength Multiplier (`0.5x~3.5x`).
 *   - Class-Aware Smart Enemy AI (CV airstrike, SS torpedo, CA vanguard guard, BB salvo, focus-fire on low-HP/high-threat targets)
 *     with pre-telegraphed `nextIntent` + locked ally warning.
 *   - Day Battle -> Night Battle Transition (`status: 'night_prompt'` -> `enterNightBattle()` / `finishBattleEarly()`).
 *   - 100% lossless backward compatibility with legacy sessions & `executeCommand(...)`.
 */

import { clamp } from './calc-engine.js';
import {
  GRID_COLS,
  GRID_ROW_LABELS,
  GRID_TOTAL_CELLS,
  TACTICAL_ACTION_DEFS,
  clampEnemyStrengthMultiplier,
  computeAaBarrageInterception,
  computeAirSuperiorityContest,
  computeDerivedEvasion,
  computeDynamicEnemyScale,
  computeOpeningAirstrikeOutcome,
  computeOpeningTorpedoOutcome,
  computeRadarLockProfile,
  computeRangeRowCombatModifiers,
  computeSymmetricDamage,
  getGearDrivenTacticalActions,
  getSameRowAndAdjacentAura,
  getShipClassProfile,
  getShipClassTacticalActions,
  hasUnitAswCapability,
  inferEquipmentTypeId,
  normalizeStarTierId,
  resolveD20CombatRoll,
  resolveShipClass,
} from './stat-rules.js';
import { NODE_TYPES, SEA_DIFFICULTIES, buildEnemyUnitByClass } from './route-generator.js';

function assignEnemyGridPositions(enemies = []) {
  const occupied = new Set();
  const colOrder = [1, 2, 0, 3];
  const pickCell = (cls) => {
    const c = String(cls || 'CL').toUpperCase();
    // Row 0 = Enemy Frontline (facing sea divider), Row 1 = Midline, Row 2 = Backline
    const rowOrder =
      c === 'DD' || c === 'SS'
        ? [0, 1, 2]
        : c === 'CL' || c === 'CA'
        ? [1, 0, 2]
        : [2, 1, 0]; // BB, CV, BOSS
    for (const r of rowOrder) {
      for (const col of colOrder) {
        const idx = r * GRID_COLS + col;
        if (!occupied.has(idx)) {
          occupied.add(idx);
          return { row: r, col, index: idx };
        }
      }
    }
    for (let idx = 0; idx < GRID_TOTAL_CELLS; idx++) {
      if (!occupied.has(idx)) {
        occupied.add(idx);
        return { row: Math.floor(idx / GRID_COLS), col: idx % GRID_COLS, index: idx };
      }
    }
    return { row: 0, col: 0, index: 0 };
  };

  enemies.forEach((en, i) => {
    const pos = pickCell(en.shipClass || inferEnemyShipClass(en));
    en.gridRow = pos.row;
    en.gridCol = pos.col;
    en.gridIndex = pos.index;
    en.rowLabel = GRID_ROW_LABELS[pos.row] || '前排';
    en.slotNo = i + 1;
    en.slotCode = String(i + 1).padStart(2, '0');
  });
  return enemies;
}

export const ENGAGEMENT_RANGES = Object.freeze({
  LONG: 'long',
  MEDIUM: 'medium',
  CLOSE: 'close',
});

export const RANGE_META = Object.freeze({
  long: {
    id: 'long',
    label: '远距离',
    shortLabel: '远距',
    desc: '战列主炮齐射与航母空袭 +15% · 鱼雷威力 -25%',
  },
  medium: {
    id: 'medium',
    label: '中距离',
    shortLabel: '中距',
    desc: '全舰种均衡交战 · 巡洋主炮与雷击均可稳定发挥',
  },
  close: {
    id: 'close',
    label: '近距离',
    shortLabel: '近距',
    desc: '鱼雷突击与深水反潜 +30% 且暴击率 +15% · 敌我互损加剧',
  },
});

export const COMBAT_COMMANDS = Object.freeze({
  SCAN: {
    id: 'scan',
    label: '雷达扫描',
    sublabel: '揭露弱点/意图 + 全队锁定',
    statKey: 'recon',
    cost: { fuel: 4, ammo: 0 },
  },
  EVADE: {
    id: 'evade',
    label: '机动迂回',
    sublabel: '非BOSS绕过 / BOSS闪避减伤',
    statKey: 'evasion',
    cost: { fuel: 10, ammo: 0 },
  },
  SHELLING: {
    id: 'shelling',
    label: '炮击',
    sublabel: '主炮/空袭稳定输出',
    statKey: 'firepower',
    cost: { fuel: 0, ammo: 10 },
  },
  TORPEDO: {
    id: 'torpedo',
    label: '鱼雷',
    sublabel: '近中距高破甲高暴击',
    statKey: 'torpedo',
    cost: { fuel: 0, ammo: 10 },
  },
});

const ENEMY_INTENTS = Object.freeze({
  salvo: {
    id: 'salvo',
    label: '战列齐射',
    visualStyle: 'enemy_salvo',
    tone: 'danger',
    desc: '高口径重炮齐射，优先轰击高威胁主力舰',
  },
  airstrike: {
    id: 'airstrike',
    label: '航母空袭',
    visualStyle: 'enemy_airstrike',
    tone: 'warn',
    desc: '舰载机编队俯冲轰炸（防空警戒可大幅拦截）',
  },
  torpedo_ambush: {
    id: 'torpedo_ambush',
    label: '潜艇雷击',
    visualStyle: 'enemy_torpedo',
    tone: 'danger',
    desc: '潜艇发射高破甲水下鱼雷（反潜与高机动可抑制）',
  },
  torpedo_salvo: {
    id: 'torpedo_salvo',
    label: '高速雷击',
    visualStyle: 'enemy_torpedo',
    tone: 'danger',
    desc: '高速驱逐/轻巡突前发射鱼雷齐射',
  },
  heavy_shelling: {
    id: 'heavy_shelling',
    label: '重炮集火',
    visualStyle: 'counter',
    tone: 'danger',
    desc: '重巡精准集火我方残血或高威胁目标',
  },
  focus_fire: {
    id: 'focus_fire',
    label: '残血集火',
    visualStyle: 'counter',
    tone: 'danger',
    desc: '锁定我方低耐久舰娘实施精确补刀（前排援护可挡伤）',
  },
  enemy_guard: {
    id: 'enemy_guard',
    label: '重巡援护',
    visualStyle: 'enemy_guard',
    tone: 'muted',
    desc: '重巡前出掩护敌方主力，替友舰分担 50% 伤害并强化护甲',
  },
  brace_armor: {
    id: 'brace_armor',
    label: '装甲强化',
    visualStyle: 'enemy_guard',
    tone: 'muted',
    desc: '强化自身装甲防御并蓄力准备下轮齐射',
  },
});

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function inferEnemyShipClass(u = {}) {
  if (u.shipClass) return String(u.shipClass).toUpperCase();
  const role = String(u.role || '').toLowerCase();
  if (role === 'boss') return 'BOSS';
  if (role === 'sub' || (u.subThreat || 0) > 0) return 'SS';
  if (role === 'carrier' || (u.airThreat || 0) > 0) return 'CV';
  if (role === 'battleship') return 'BB';
  if (role === 'cruiser') return 'CA';
  if (role === 'destroyer') return 'DD';
  if (role === 'flagship') return 'BB';
  return 'CL';
}

function getDefaultEnemyStatsByClass(shipClass) {
  const map = {
    BOSS: { evasion: 50, aa: 66, asw: 44, torpedo: 60, stealth: 18 },
    BB: { evasion: 42, aa: 52, asw: 28, torpedo: 20, stealth: 10 },
    CV: { evasion: 58, aa: 70, asw: 28, torpedo: 14, stealth: 16 },
    CA: { evasion: 60, aa: 54, asw: 40, torpedo: 54, stealth: 14 },
    CL: { evasion: 70, aa: 60, asw: 62, torpedo: 62, stealth: 18 },
    DD: { evasion: 84, aa: 42, asw: 66, torpedo: 78, stealth: 24 },
    SS: { evasion: 76, aa: 14, asw: 32, torpedo: 88, stealth: 36 },
  };
  return map[shipClass] || map.CL;
}

/**
 * Weighted Enemy Target Selection (3x4 Grid Row Weight + Heavy Ship Guard Weight + Dispersion):
 *   - Frontline (row 0) & Heavy Armored Ships (BB / CA) draw substantially higher aggro weight.
 *   - Midline/Backline Flagship has greatly reduced targeting weight while teammates survive.
 *   - Non-ASW attackers automatically skip submerged ally SS while surface allies are alive.
 *   - Uses weighted random roulette draw instead of deterministic max-score to stop tunnel-visioning.
 */
function selectSmartAllyTarget(
  livingAllies = [],
  enemyUnit = null,
  rng = Math.random,
  { isAirstrike = false } = {}
) {
  if (!Array.isArray(livingAllies) || livingAllies.length === 0) return null;
  if (livingAllies.length === 1) return livingAllies[0];

  const cls = inferEnemyShipClass(enemyUnit);
  const attackerCanAsw = Boolean(enemyUnit?.hasAswCapability || cls === 'DD' || cls === 'CL');

  // Non-ASW attackers cannot target submerged SS when surface targets exist
  const surfaceAllies = livingAllies.filter((a) => !(a.submerged || a.classCode === 'SS'));
  const pool = !attackerCanAsw && surfaceAllies.length > 0 ? surfaceAllies : livingAllies;
  if (pool.length === 1) return pool[0];

  const weighted = pool.map((ally) => {
    const row = clamp(Number(ally.gridRow ?? 0), 0, 2);
    const hpPct = clamp((ally.hp || 0) / Math.max(1, ally.maxHp || 1), 0, 1);

    // 1. Row position weight (Airstrikes bypass frontline to strike mid/backline)
    const rowWeight = isAirstrike
      ? row === 2
        ? 2.1
        : row === 1
        ? 1.7
        : 0.75
      : row === 0
      ? 3.4
      : row === 1
      ? 1.35
      : 0.5;

    // 2. Heavy armored ship guard weight
    const aCls = ally.classCode || resolveShipClass(ally.shipType);
    const classGuardWeight =
      aCls === 'BB'
        ? 1.6
        : aCls === 'CA'
        ? 1.48
        : aCls === 'CL'
        ? 1.1
        : aCls === 'DD'
        ? 0.92
        : aCls === 'AR' || aCls === 'AO'
        ? 0.85
        : 0.72; // CV / SS

    // 3. Protect Mid/Backline Flagship while teammates are alive
    const flagshipFactor = ally.isFlagship && pool.length > 1 && row >= 1 && !isAirstrike ? 0.38 : 1.0;

    // 4. Mild damaged-unit attention + random dispersion floor
    const hpFactor = hpPct < 0.35 ? 1.24 : hpPct < 0.6 ? 1.1 : 1.0;
    const weight = Math.max(0.15, rowWeight * classGuardWeight * flagshipFactor * hpFactor * (0.82 + rng() * 0.36));
    return { ally, weight };
  });

  const totalW = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = rng() * totalW;
  for (const item of weighted) {
    roll -= item.weight;
    if (roll <= 0) return item.ally;
  }
  return weighted[weighted.length - 1].ally;
}

/**
 * Strictly pick a target prioritizing Front Row (row 0) first -> Mid Row (row 1) -> Back Row (row 2).
 * Used by Opening Torpedo Salvo so front-row ships absorb torpedoes before mid/backline can be hit.
 */
function pickFrontRowPriorityTarget(units = [], rng = Math.random) {
  const alive = (units || []).filter((u) => (u.alive !== undefined ? u.alive : (u.hp || 0) > 0));
  if (alive.length === 0) return null;
  for (const row of [0, 1, 2]) {
    const inRow = alive.filter((u) => clamp(Number(u.gridRow ?? 0), 0, 2) === row);
    if (inRow.length > 0) {
      return inRow[Math.floor(rng() * inRow.length)];
    }
  }
  return alive[Math.floor(rng() * alive.length)];
}

/**
 * Pick targets for Opening Bombing / Torpedo Bombers: bypasses frontline to prioritize Mid/Backline (row 2 -> 1 -> 0).
 */
function pickMidBackPriorityTargets(units = [], count = 1, rng = Math.random) {
  const alive = (units || []).filter((u) => (u.alive !== undefined ? u.alive : (u.hp || 0) > 0));
  if (alive.length === 0) return [];
  const ordered = [];
  for (const row of [2, 1, 0]) {
    const inRow = alive.filter((u) => clamp(Number(u.gridRow ?? 0), 0, 2) === row);
    // Shuffle within row
    for (let i = inRow.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [inRow[i], inRow[j]] = [inRow[j], inRow[i]];
    }
    ordered.push(...inRow);
  }
  return ordered.slice(0, Math.max(1, count));
}

/**
 * Class-aware smart Enemy AI intent picker with pre-selected locked target warning.
 */
function pickEnemyIntent(enemyUnit, livingAllies = [], allEnemies = [], rng = Math.random) {
  if (!enemyUnit || enemyUnit.hp <= 0) return null;
  const cls = inferEnemyShipClass(enemyUnit);
  const aliveAllies = (livingAllies || []).filter((a) => a.alive && a.hp > 0);
  const lowHpAlly = aliveAllies.find((a) => a.hp / Math.max(1, a.maxHp) < 0.48);
  const targetAlly = selectSmartAllyTarget(aliveAllies, enemyUnit, rng);

  let baseIntent = ENEMY_INTENTS.heavy_shelling;

  if (cls === 'CV') {
    baseIntent = ENEMY_INTENTS.airstrike;
  } else if (cls === 'SS') {
    baseIntent = ENEMY_INTENTS.torpedo_ambush;
  } else if (cls === 'CA') {
    const damagedComrade = (allEnemies || []).find(
      (e) => e.id !== enemyUnit.id && e.hp > 0 && (e.hp / Math.max(1, e.maxHp) < 0.72 || e.shipClass === 'BOSS' || e.shipClass === 'CV')
    );
    if (damagedComrade && !enemyUnit.guardingEnemyId && rng() < 0.48) {
      return {
        ...ENEMY_INTENTS.enemy_guard,
        guardTargetId: damagedComrade.id,
        guardTargetName: damagedComrade.name,
        targetAllyId: null,
        targetAllyName: null,
      };
    }
    baseIntent = lowHpAlly && rng() < 0.55 ? ENEMY_INTENTS.focus_fire : ENEMY_INTENTS.heavy_shelling;
  } else if (cls === 'BB' || cls === 'BOSS') {
    if (cls === 'BOSS' && (enemyUnit.airThreat || 0) > 0 && rng() < 0.32) {
      baseIntent = ENEMY_INTENTS.airstrike;
    } else if (lowHpAlly && rng() < 0.35) {
      baseIntent = ENEMY_INTENTS.focus_fire;
    } else {
      baseIntent = ENEMY_INTENTS.salvo;
    }
  } else if (cls === 'DD') {
    baseIntent = lowHpAlly && rng() < 0.5 ? ENEMY_INTENTS.focus_fire : ENEMY_INTENTS.torpedo_salvo;
  } else {
    // CL / escort
    baseIntent = lowHpAlly && rng() < 0.55 ? ENEMY_INTENTS.focus_fire : rng() < 0.45 ? ENEMY_INTENTS.torpedo_salvo : ENEMY_INTENTS.heavy_shelling;
  }

  return {
    ...baseIntent,
    targetAllyId: targetAlly?.id || null,
    targetAllyName: targetAlly?.name || null,
    guardTargetId: null,
    guardTargetName: null,
  };
}

export class TacticalCombatEngine {
  constructor({
    entities,
    inventory,
    statRules,
    resources,
    narrative,
    dialogueEngine = null,
    commander = null,
    formation = null,
    bus = null,
  }) {
    this._entities = entities;
    this._inventory = inventory;
    this._statRules = statRules;
    this._resources = resources;
    this._narrative = narrative;
    this._dialogueEngine = dialogueEngine;
    this._commander = commander;
    this._formation = formation;
    this._bus = bus;
    /** @type {object | null} */
    this._session = null;
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  isActive() {
    return Boolean(
      this._session && (this._session.status === 'active' || this._session.status === 'night_prompt')
    );
  }

  isInBattleScreen() {
    return Boolean(this._session);
  }

  getStageMode() {
    if (!this._session) return 'chart';
    return 'battle';
  }

  getSession() {
    return this._session ? deepClone(this._session) : null;
  }

  clearSession() {
    this._session = null;
  }

  _syncAggregateEnemy(session) {
    if (!session || !Array.isArray(session.enemies) || session.enemies.length === 0) return;
    const totalHp = session.enemies.reduce((s, e) => s + Math.max(0, e.hp), 0);
    const totalMaxHp = session.enemies.reduce((s, e) => s + Math.max(1, e.maxHp), 0);
    const lead = session.enemies.find((e) => e.hp > 0) || session.enemies[0];
    session.enemy = {
      ...session.enemy,
      name: lead.name,
      hp: totalHp,
      maxHp: totalMaxHp,
      armor: lead.armor,
      attackPower: lead.attackPower,
      airThreat: Math.max(...session.enemies.map((e) => (e.hp > 0 ? e.airThreat || 0 : 0)), 0),
      subThreat: Math.max(...session.enemies.map((e) => (e.hp > 0 ? e.subThreat || 0 : 0)), 0),
      weakness: lead.weakness,
      weaknessLabel: lead.weaknessLabel,
      threatLabel: lead.threatLabel,
      scanned: session.enemies.some((e) => e.scanned),
    };
    const curTarget = session.enemies.find((e) => e.id === session.targetEnemyId && e.hp > 0);
    if (!curTarget) {
      const firstAlive = session.enemies.find((e) => e.hp > 0);
      session.targetEnemyId = firstAlive ? firstAlive.id : session.enemies[0].id;
    }
  }

  /**
   * Build Unified Ally + Enemy Initiative Queue sorted by `evasion + initiativeBonus`.
   */
  _buildTurnQueue(session, rng = Math.random) {
    const fleet = this._getFleetCombatContext(session);
    const aliveAllies = fleet.members.filter((m) => m.alive);
    const aliveEnemies = (session.enemies || []).filter((e) => e.hp > 0);

    const combined = [];

    for (const m of aliveAllies) {
      const baseEva = Math.round(m.evasion || 50);
      const initRoll = Math.round(rng() * 10 - 4); // -4..+6 micro initiative roll
      combined.push({
        side: 'ally',
        unitId: m.id,
        characterId: m.id,
        name: m.name,
        shipType: m.shipType,
        classCode: resolveShipClass(m.shipType),
        evasion: baseEva,
        initiativeBonus: initRoll,
        initiative: baseEva + initRoll,
        slotOrder: m.slotIndex ?? 0,
        acted: false,
        actionLabel: null,
      });
    }

    for (let idx = 0; idx < aliveEnemies.length; idx++) {
      const en = aliveEnemies[idx];
      const cls = inferEnemyShipClass(en);
      const baseEva = Math.round(Number(en.evasion ?? getDefaultEnemyStatsByClass(cls).evasion));
      const initRoll = Math.round(rng() * 10 - 4); // -4..+6 micro initiative roll
      combined.push({
        side: 'enemy',
        unitId: en.id,
        characterId: null,
        name: en.name,
        shipType: cls,
        classCode: cls,
        role: en.role || 'escort',
        evasion: baseEva,
        initiativeBonus: initRoll,
        initiative: baseEva + initRoll,
        slotOrder: 100 + idx,
        acted: false,
        actionLabel: null,
      });
    }

    combined.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      if (b.evasion !== a.evasion) return b.evasion - a.evasion;
      if (a.side !== b.side) return a.side === 'ally' ? -1 : 1;
      return a.slotOrder - b.slotOrder;
    });

    session.turnQueue = combined;
    session.currentActorIndex = 0;
  }

  /**
   * Pre-battle Recon Check (`fleetRecon + commander.getTacticsReconBonus()` vs Star-Tier Threshold)
   * Grants 「索敌成功 · 战术优势」 (hit/crit boost, full enemy intel, ambush reduction, enemy frontline evasion debuff).
   */
  _resolveReconAndAmbush(session, fleet, node, rng = Math.random) {
    const aliveAllies = fleet.members.filter((m) => m.alive);
    const aliveEnemies = session.enemies.filter((e) => e.hp > 0);
    if (aliveAllies.length === 0 || aliveEnemies.length === 0) return null;

    const cmdTacticsRecon =
      this._commander && typeof this._commander.getTacticsReconBonus === 'function'
        ? this._commander.getTacticsReconBonus()
        : this._commander
        ? this._commander.getTacticsCheckBonus() * 6
        : 0;
    const seaMods = session.seaCondition?.mods || {};
    const totalAllyRecon = aliveAllies.reduce((sum, m) => sum + (Number(m.recon) || 16), 0);
    const radarBonus = aliveAllies.reduce((sum, m) => sum + ((m.radarProfile?.radarCount || 0) * 6), 0);
    const reconRoll = Math.round(rng() * 10);
    const allyReconScore = Math.round(
      totalAllyRecon * 0.55 +
        (fleet.effective?.recon || 20) * 0.45 +
        cmdTacticsRecon +
        radarBonus +
        (node?.intelRevealed ? 10 : 0) -
        (seaMods.scanDcDelta || 0) * 5 +
        reconRoll
    );

    const STAR_RECON_THRESHOLDS = { 1: 24, 2: 36, 3: 48, 4: 62, 5: 76 };
    const starThreshold = STAR_RECON_THRESHOLDS[clamp(Number(session.star || 1), 1, 5)] || 24;
    const avgEnemyStealth =
      aliveEnemies.reduce((s, e) => s + (Number(e.stealth) || 16), 0) / Math.max(1, aliveEnemies.length);
    const subBonus = aliveEnemies.filter((e) => e.shipClass === 'SS' || e.role === 'sub').length * 4;
    const laneBonus = node?.lane === 'stealth' ? 12 : 0;
    const stealthRoll = Math.round(rng() * 8);
    const enemyStealthScore = Math.round(
      Math.max(starThreshold, avgEnemyStealth * 1.15 + starThreshold * 0.45) +
        subBonus +
        laneBonus +
        (seaMods.scanDcDelta || 0) * 5 +
        stealthRoll
    );

    // High recon score reduces even forced elite ambush chance
    const rawForcedAmbush = Boolean(node?.isAmbush || node?.enemyTemplate?.isAmbush);
    const ambushMitigated = rawForcedAmbush && allyReconScore >= enemyStealthScore + 12 && rng() < 0.65;
    const forcedAmbush = rawForcedAmbush && !ambushMitigated;
    const reconSuccess = !forcedAmbush && allyReconScore >= enemyStealthScore;
    const margin = allyReconScore - enemyStealthScore;

    if (reconSuccess) {
      const lockGain = margin >= 18 ? 3 : 2;
      const evaDebuffPct = margin >= 18 ? 0.25 : 0.18;
      session.reconStatus = 'success';
      session.reconAdvantage = true;
      session.reconCritBonus = 0.1;
      session.enemyEvasionDebuffPct = evaDebuffPct;
      session.reconDetail = {
        allyReconScore,
        enemyStealthScore,
        starThreshold,
        margin,
        lockBonus: lockGain,
        evaDebuffPct,
        ambushed: false,
      };
      session.lockOnBonus = Math.min(6, session.lockOnBonus + lockGain);
      // Reveal all enemy fleet intel pre-battle
      for (const en of session.enemies) {
        en.scanned = true;
      }

      const text = `【索敌成功 · 战术优势】我方总索敌 ${allyReconScore} vs 门槛 ${enemyStealthScore}（+${margin}）！透视敌舰配置、全队 d20 命中 +${lockGain}、暴击 +10%，并削弱敌前排高机动单位 ${Math.round(
        evaDebuffPct * 100
      )}% 闪避！`;
      const ev = {
        kind: 'recon',
        title: `索敌成功 · 战术优势 (+${lockGain} 命中)`,
        visualStyle: 'scan',
        damageDealt: 0,
        damageTaken: 0,
        text,
      };
      session.openingEvents.push(ev);
      session.turnsLog.unshift({
        turn: 0,
        round: 0,
        phase: 'opening',
        side: 'ally',
        commandId: 'opening_recon',
        commandLabel: '索敌战术优势',
        visualStyle: 'scan',
        actorId: aliveAllies[0].id,
        actorName: '舰队索敌组',
        actorClass: 'RECON',
        targetEnemyId: session.enemies[0]?.id || '',
        targetEnemyName: session.enemy.name,
        outcomeTag: 'recon-ok',
        text,
        source: 'local',
        degraded: false,
        damageDealt: 0,
        damageTaken: 0,
        isCrit: false,
        scannedNow: true,
      });
      this._emit('combat:recon-result', {
        success: true,
        reconAdvantage: true,
        allyReconScore,
        enemyStealthScore,
        lockBonus: lockGain,
        evaDebuffPct,
      });
      return ev;
    }

    // Recon failed OR stepped on ambush node -> Enemy Preemptive Ambush!
    session.reconStatus = 'ambushed';
    session.reconAdvantage = false;
    session.reconCritBonus = 0;
    session.enemyEvasionDebuffPct = 0;
    const ambushers = [...aliveEnemies]
      .sort((a, b) => (b.stealth || 0) + (b.evasion || 0) - ((a.stealth || 0) + (a.evasion || 0)))
      .slice(0, Math.min(3, Math.max(1, Math.ceil(aliveEnemies.length / 3))));

    let totalAmbushDmg = 0;
    const hits = [];
    for (const en of ambushers) {
      const freshAllies = this._getFleetCombatContext(session).members.filter((m) => m.alive);
      if (freshAllies.length === 0) break;
      const target = selectSmartAllyTarget(freshAllies, en, rng);
      if (!target) break;
      if ((target.submerged || target.classCode === 'SS') && !en.hasAswCapability) continue;
      const armorMit = clamp(1 - (target.armor || 16) * 0.008, 0.58, 0.96);
      const rawAmbush = Math.max(2, Math.round(en.attackPower * 0.5 * armorMit));
      const dmg = Math.min(Math.max(6, Math.round(target.maxHp * 0.22)), rawAmbush);
      this._entities.adjustStat(target.id, 'hp', -dmg, { min: 0, max: target.maxHp });
      totalAmbushDmg += dmg;
      hits.push(`${en.name}→${target.name}(-${dmg})`);
    }

    session.reconDetail = {
      allyReconScore,
      enemyStealthScore,
      starThreshold,
      margin,
      lockBonus: 0,
      ambushed: true,
      forcedAmbush,
      totalDamage: totalAmbushDmg,
    };

    const reasonText = forcedAmbush ? '踩中敌军预设伏击圈' : `索敌不足（${allyReconScore} vs ${enemyStealthScore}）`;
    const text = `⚠ 【敌方先制伏击】${reasonText}！敌方前卫发动突袭：${hits.join('、') || '被我方紧急避开'}，我方受损 ${totalAmbushDmg} HP！`;
    const ev = {
      kind: 'ambush',
      title: `⚠ 敌方先制伏击 -${totalAmbushDmg} HP`,
      visualStyle: 'ambush',
      damageDealt: 0,
      damageTaken: totalAmbushDmg,
      text,
    };
    session.openingEvents.push(ev);
    session.turnsLog.unshift({
      turn: 0,
      round: 0,
      phase: 'opening',
      side: 'enemy',
      commandId: 'opening_ambush',
      commandLabel: '先制伏击',
      visualStyle: 'ambush',
      actorId: ambushers[0]?.id || 'en_1',
      actorName: ambushers[0]?.name || '伏击编队',
      actorClass: ambushers[0]?.shipClass || 'SS',
      targetEnemyId: '',
      targetEnemyName: '我方编队',
      outcomeTag: 'ambush',
      text,
      source: 'local',
      degraded: false,
      damageDealt: 0,
      damageTaken: totalAmbushDmg,
      isCrit: false,
    });
    this._emit('combat:recon-result', { success: false, allyReconScore, enemyStealthScore, ambushed: true });
    this._emit('combat:ambush', { totalDamage: totalAmbushDmg, attackers: ambushers.length });
    return ev;
  }

  /**
   * Stage 1 Opening Aerial Battle:
   *   1. Fighter Air Superiority Contest (制空权争夺 -> AS+/AS/AP/AD/AI + plane shoot-down + shelling hit bonus)
   *   2. Opening Bombing & Torpedo Bombers (bypasses frontline to strike mid/backline targets!)
   *   3. Combined AA Barrage Interception (escort fighters + fleet AA + AA guns & air-search radars)
   */
  _resolveOpeningAirstrike(session, rng = Math.random) {
    const fleet = this._getFleetCombatContext(session);
    const allyCarriers = fleet.members.filter(
      (m) => m.alive && (m.classCode === 'CV' || m.hasAircraftGear)
    );
    const enemyCarriers = session.enemies.filter(
      (e) => e.hp > 0 && (e.shipClass === 'CV' || (e.airThreat || 0) > 0)
    );
    if (allyCarriers.length === 0 && enemyCarriers.length === 0) return null;

    const cmdTacticsMult =
      this._commander && typeof this._commander.getTacticsFormationBonusPct === 'function'
        ? 1 + this._commander.getTacticsFormationBonusPct()
        : 1.0;

    // 1. Fighter Air Superiority Contest
    const allyFighterPower = Math.round(
      allyCarriers.reduce(
        (sum, c) => sum + (c.aa * 0.75 + c.recon * 0.7 + (c.aircraftGearBonus || 0)),
        0
      ) * cmdTacticsMult
    );
    const enemyFighterPower = Math.round(
      enemyCarriers.reduce((sum, e) => sum + ((Number(e.aa) || 18) * 0.65 + (Number(e.airThreat) || 16) * 0.8), 0)
    );
    const airContest = computeAirSuperiorityContest({ allyFighterPower, enemyFighterPower });
    session.airSuperiority = airContest;

    let allyAirDamageTotal = 0;
    let enemyAirDamageTotal = 0;
    const parts = [
      `【${airContest.stateLabel}】我方制空 ${airContest.allyFighterPower} vs 敌方 ${airContest.enemyFighterPower}${
        airContest.allyHitBonus > 0 ? `（炮击 d20 命中 +${airContest.allyHitBonus}）` : ''
      }`,
    ];

    // 2. Allied Opening Bombing (bypasses frontline -> strikes mid/backline!)
    if (allyCarriers.length > 0) {
      const surfaceEnemies = session.enemies.filter((e) => e.hp > 0 && !(e.submerged || e.shipClass === 'SS'));
      const validEnemies = surfaceEnemies.length > 0 ? surfaceEnemies : session.enemies.filter((e) => e.hp > 0);
      if (validEnemies.length > 0) {
        const allyBombPower =
          allyCarriers.reduce((s, c) => s + (c.firepower * 0.65 + c.recon * 0.55 + (c.aircraftGearBonus || 0)), 0) *
          airContest.allyBombMult;
        const enemyFleetAa = validEnemies.reduce((s, e) => s + (Number(e.aa) || 18), 0) / Math.max(1, validEnemies.length);
        const enemyAaBarrage = computeAaBarrageInterception({
          incomingAirPower: allyBombPower,
          fleetAa: enemyFleetAa,
          escortFighterBonus: enemyFighterPower * 0.28,
        });
        const hitCount = Math.min(validEnemies.length, Math.max(1, allyCarriers.length + 1));
        const pickedTargets = pickMidBackPriorityTargets(validEnemies, hitCount, rng);
        const totalPool = Math.max(8, Math.round(allyBombPower * 0.55 * enemyAaBarrage.passThrough));
        const perTargetBase = Math.max(5, Math.round(totalPool / Math.max(1, hitCount * 0.78)));
        const hitNotes = [];
        const sunkNames = [];
        for (const en of pickedTargets) {
          const dmg = Math.max(4, Math.round(perTargetBase * (0.85 + rng() * 0.3)));
          en.hp = Math.max(0, en.hp - dmg);
          allyAirDamageTotal += dmg;
          hitNotes.push(`${en.name}[${en.rowLabel || '后排'}](-${dmg})`);
          if (en.hp <= 0) sunkNames.push(en.name);
        }
        parts.push(
          `我方舰载机越过前排开幕轰炸（敌${enemyAaBarrage.label}）：${hitNotes.join('、')}${
            sunkNames.length ? `（击沉 ${sunkNames.join('、')}）` : ''
          }`
        );
      }
    }

    // 3. Surviving Enemy Carriers Opening Bombing -> Intercepted by Allied Escort Fighters + Fleet AA + AA Guns/Radars!
    const survivingEnemyCvs = session.enemies.filter(
      (e) => e.hp > 0 && (e.shipClass === 'CV' || (e.airThreat || 0) > 0)
    );
    const livingAllies = this._getFleetCombatContext(session).members.filter((m) => m.alive);
    if (survivingEnemyCvs.length > 0 && livingAllies.length > 0) {
      const rawEnemyBombPower =
        survivingEnemyCvs.reduce((s, e) => s + ((Number(e.attackPower) || 18) * 0.8 + (Number(e.airThreat) || 14) * 0.65), 0) *
        airContest.enemyBombMult;
      const allyTotalAa = livingAllies.reduce((s, m) => s + (Number(m.aa) || 16), 0) / Math.max(1, livingAllies.length);
      const allyAaGearBonus = livingAllies.reduce((s, m) => s + (Number(m.aaGearBonus) || 0), 0);
      const allyAaBarrage = computeAaBarrageInterception({
        incomingAirPower: rawEnemyBombPower,
        fleetAa: allyTotalAa,
        aaGearBonus: allyAaGearBonus,
        escortFighterBonus: allyFighterPower * 0.35,
        aaAlertActive: session.aaAlertTurns > 0,
      });
      session.lastAaBarrage = allyAaBarrage;

      const hitCount = Math.min(livingAllies.length, Math.max(1, Math.min(3, survivingEnemyCvs.length)));
      const hitDetails = [];
      const surfaceAllies = livingAllies.filter((m) => !(m.submerged || m.classCode === 'SS'));
      const bombPool = surfaceAllies.length > 0 ? surfaceAllies : livingAllies;
      const bombTargets = pickMidBackPriorityTargets(bombPool, hitCount, rng);

      for (const target of bombTargets) {
        const rawHit = Math.max(
          2,
          Math.round(((rawEnemyBombPower * 0.42 * allyAaBarrage.passThrough) / Math.max(1, hitCount * 0.95)) * (0.85 + rng() * 0.3))
        );
        const dmg = Math.min(Math.max(6, Math.round(target.maxHp * 0.24)), rawHit);
        this._entities.adjustStat(target.id, 'hp', -dmg, { min: 0, max: target.maxHp });
        enemyAirDamageTotal += dmg;
        hitDetails.push(`${target.name}(-${dmg})`);
      }
      parts.push(
        `敌机群空袭遭我方【${allyAaBarrage.label}】拦截（敌机制空损毁 ${Math.round(
          airContest.enemyPlanesShotDownPct * 100
        )}%），残余命中 ${hitDetails.join('、')}`
      );
    }

    this._syncAggregateEnemy(session);
    const text = `【航空制空与开幕轰炸】${parts.join('；')}。`;
    const ev = {
      kind: 'opening_air',
      title: `航空战 · ${airContest.stateLabel}`,
      visualStyle: allyAirDamageTotal >= enemyAirDamageTotal ? 'airstrike' : 'enemy_airstrike',
      airState: airContest.stateLabel,
      airSuperiority: airContest,
      damageDealt: allyAirDamageTotal,
      damageTaken: enemyAirDamageTotal,
      text,
    };
    session.openingEvents.push(ev);
    session.turnsLog.unshift({
      turn: 0,
      round: 0,
      phase: 'opening',
      side: allyAirDamageTotal >= enemyAirDamageTotal ? 'ally' : 'enemy',
      commandId: 'opening_airstrike',
      commandLabel: `航空战·${airContest.stateLabel}`,
      visualStyle: ev.visualStyle,
      actorId: allyCarriers[0]?.id || enemyCarriers[0]?.id || '',
      actorName: allyCarriers.length > 0 ? `${allyCarriers[0].name}航空队` : '敌方航空编队',
      actorClass: 'CV',
      targetEnemyId: session.targetEnemyId,
      targetEnemyName: session.enemy.name,
      outcomeTag: 'opening-air',
      text,
      source: 'local',
      degraded: false,
      damageDealt: allyAirDamageTotal,
      damageTaken: enemyAirDamageTotal,
      isCrit: false,
    });
    this._emit('combat:opening-airstrike', {
      airState: airContest.stateLabel,
      airSuperiority: airContest,
      allyDamage: allyAirDamageTotal,
      enemyDamage: enemyAirDamageTotal,
    });
    return ev;
  }

  /**
   * Stage 2 Automatic Opening Torpedo Strike:
   * Strictly prioritizes Enemy/Ally FRONT ROW (gridRow === 0) first; only spills to mid/backline once front row is sunk!
   */
  _resolveOpeningTorpedo(session, rng = Math.random) {
    const fleet = this._getFleetCombatContext(session);
    const allyTorpUnits = fleet.members.filter(
      (m) => m.alive && (m.classCode === 'DD' || m.classCode === 'SS' || (m.torpedo || 0) >= 26)
    );
    const enemyTorpUnits = session.enemies.filter(
      (e) => e.hp > 0 && (e.shipClass === 'SS' || e.role === 'sub' || e.shipClass === 'DD' || (e.torpedo || 0) >= 28)
    );
    if (allyTorpUnits.length === 0 && enemyTorpUnits.length === 0) return null;

    let allyTorpDamageTotal = 0;
    let enemyTorpDamageTotal = 0;
    const parts = [];
    const allyHitRows = [];

    // 1. Allied Opening Torpedo Salvo -> STRICT FRONT-ROW PRIORITY!
    const aliveEnemies = session.enemies.filter((e) => e.hp > 0);
    if (allyTorpUnits.length > 0 && aliveEnemies.length > 0) {
      const shooters = allyTorpUnits.slice(0, 4);
      let hits = 0;
      const sunkNames = [];
      for (const shooter of shooters) {
        const curAlive = session.enemies.filter((e) => e.hp > 0 && !(e.submerged || e.shipClass === 'SS'));
        const pool = curAlive.length > 0 ? curAlive : session.enemies.filter((e) => e.hp > 0);
        if (pool.length === 0) break;
        const target = pickFrontRowPriorityTarget(pool, rng);
        if (!target) break;
        const targetDerivedEva = computeDerivedEvasion(target.evasion || 18, target.shipClass).dodgeValue;
        const res = computeOpeningTorpedoOutcome({
          attackerTorpedo: shooter.torpedo || 24,
          defenderAsw: target.asw || 16,
          defenderEvasion: Math.round(targetDerivedEva * (1 - (session.enemyEvasionDebuffPct || 0))),
          isSubmarine: shooter.classCode === 'SS',
          rng,
        });
        if (res.hit && res.strikeDamageBase > 0) {
          hits += 1;
          allyHitRows.push(target.gridRow ?? 0);
          target.hp = Math.max(0, target.hp - res.strikeDamageBase);
          allyTorpDamageTotal += res.strikeDamageBase;
          if (target.hp <= 0) sunkNames.push(target.name);
        }
      }
      parts.push(
        `我方雷击编队(${shooters.length}舰)优先突击敌前排，命中 ${hits} 枚共造成 ${allyTorpDamageTotal} 点伤害${
          sunkNames.length ? `（击沉 ${sunkNames.join('、')}）` : ''
        }`
      );
    }

    // 2. Surviving Enemy Submarines / Destroyers Opening Torpedo -> STRICT FRONT-ROW PRIORITY!
    const survivingEnemyTorp = session.enemies.filter(
      (e) => e.hp > 0 && (e.shipClass === 'SS' || e.role === 'sub' || e.shipClass === 'DD' || (e.torpedo || 0) >= 28)
    );
    if (survivingEnemyTorp.length > 0) {
      const shooters = survivingEnemyTorp.slice(0, 2);
      const hitDetails = [];
      let suppressedCount = 0;
      for (const en of shooters) {
        const curAllies = this._getFleetCombatContext(session).members.filter(
          (m) => m.alive && !(m.submerged || m.classCode === 'SS')
        );
        if (curAllies.length === 0) break;
        const target = pickFrontRowPriorityTarget(curAllies, rng);
        if (!target) break;
        const res = computeOpeningTorpedoOutcome({
          attackerTorpedo: en.torpedo || 24,
          defenderAsw: Math.max(target.asw || 16, fleet.effective?.asw || 18),
          defenderEvasion: target.derivedEvasion || target.evasion || 20,
          isSubmarine: en.shipClass === 'SS' || en.role === 'sub',
          rng,
        });
        if (res.hit && res.strikeDamageBase > 0) {
          const rawTorp = Math.max(2, Math.round(res.strikeDamageBase * 0.55));
          const scaledDmg = Math.min(Math.max(6, Math.round(target.maxHp * 0.22)), rawTorp);
          this._entities.adjustStat(target.id, 'hp', -scaledDmg, { min: 0, max: target.maxHp });
          enemyTorpDamageTotal += scaledDmg;
          hitDetails.push(`${target.name}[${target.rowLabel || '前排'}](-${scaledDmg})`);
        } else {
          suppressedCount += 1;
        }
      }
      parts.push(
        hitDetails.length > 0
          ? `敌雷击单位冲击我方前排命中 ${hitDetails.join('、')}${suppressedCount > 0 ? `（另有 ${suppressedCount} 枚被高速规避）` : ''}`
          : `敌方开幕雷击被我方前排反潜与高速机动全部规避！`
      );
    }

    this._syncAggregateEnemy(session);
    const text = `【开幕雷击·前排优先】${parts.join('；')}。`;
    const ev = {
      kind: 'opening_torpedo',
      title: `开幕雷击${allyTorpDamageTotal > 0 ? ` 敌-${allyTorpDamageTotal}` : ''}${enemyTorpDamageTotal > 0 ? ` 我-${enemyTorpDamageTotal}` : ''}`,
      visualStyle: allyTorpDamageTotal >= enemyTorpDamageTotal ? 'torpedo' : 'enemy_torpedo',
      allyHitRows,
      damageDealt: allyTorpDamageTotal,
      damageTaken: enemyTorpDamageTotal,
      text,
    };
    session.openingEvents.push(ev);
    session.turnsLog.unshift({
      turn: 0,
      round: 0,
      phase: 'opening',
      side: allyTorpDamageTotal >= enemyTorpDamageTotal ? 'ally' : 'enemy',
      commandId: 'opening_torpedo',
      commandLabel: '开幕雷击',
      visualStyle: ev.visualStyle,
      actorId: allyTorpUnits[0]?.id || enemyTorpUnits[0]?.id || '',
      actorName: allyTorpUnits.length > 0 ? `${allyTorpUnits[0].name}雷击队` : '敌方水下雷击群',
      actorClass: allyTorpUnits.length > 0 ? allyTorpUnits[0].classCode : 'SS',
      targetEnemyId: session.targetEnemyId,
      targetEnemyName: session.enemy.name,
      outcomeTag: 'opening-torpedo',
      text,
      source: 'local',
      degraded: false,
      damageDealt: allyTorpDamageTotal,
      damageTaken: enemyTorpDamageTotal,
      isCrit: false,
    });
    this._emit('combat:opening-torpedo', {
      allyDamage: allyTorpDamageTotal,
      enemyDamage: enemyTorpDamageTotal,
      allyHitRows,
    });
    return ev;
  }

  /**
   * Initialize a new mixed-initiative tactical combat engagement with 1★~5★ symmetric enemy stats,
   * carried sortie supplies, pre-battle Recon/Ambush check, Opening Airstrike, and Opening Torpedo phases.
   */
  startEncounter({
    characterId = null,
    fleetMemberIds = null,
    formationId = null,
    node,
    seaCondition = null,
    difficulty = null,
    nodeDepthRatio = null,
    strengthMultiplier = 1.0,
    carriedSupplies = null,
    resupplyUsesRemaining = 2,
    rng = Math.random,
  }) {
    const memberIds =
      Array.isArray(fleetMemberIds) && fleetMemberIds.length > 0
        ? fleetMemberIds.map(String)
        : this._formation && this._formation.getMemberIds().length > 0
        ? this._formation.getMemberIds()
        : characterId
        ? [String(characterId)]
        : [];

    const flagshipId = memberIds[0] || String(characterId || '');
    const activeFormationId = formationId || this._formation?.getActiveFormation()?.id || 'line_ahead';
    const fleetSize = Math.max(1, memberIds.length);
    const diffId = normalizeStarTierId(difficulty || node?.difficulty || node?.enemyTemplate?.difficulty || 'star_1');
    const depthRatio = clamp(
      Number(nodeDepthRatio ?? node?.depthRatio ?? node?.enemyTemplate?.depthRatio ?? 0.35),
      0,
      1
    );
    const strMult = clampEnemyStrengthMultiplier(strengthMultiplier);
    const dynScale = computeDynamicEnemyScale({
      difficulty: diffId,
      nodeDepthRatio: depthRatio,
      fleetSize,
      strengthMultiplier: strMult,
    });

    const tierCfg = SEA_DIFFICULTIES[diffId] || SEA_DIFFICULTIES.star_1;
    const rawTpl = node?.enemyTemplate || node?.enemy || {
      name: node?.name || '未知敌方编队',
      tier: node?.type || 'encounter',
      difficulty: diffId,
      star: tierCfg.star || 1,
      forcedEngagement: node?.type === 'boss',
      hp: tierCfg.enemyHpRange[0],
      maxHp: tierCfg.enemyHpRange[0],
      armor: tierCfg.enemyArmorRange[0],
      attackPower: tierCfg.enemyAtkRange[0],
      airThreat: 0,
      subThreat: 0,
      threatLabel: '常规水面编队',
      scanDc: tierCfg.baseDc,
      evadeDc: tierCfg.baseDc,
      shellingDc: tierCfg.baseDc,
      torpedoDc: tierCfg.baseDc + 1,
      weakness: 'shelling',
      weaknessLabel: '炮击弱点',
    };

    let rawSquad =
      Array.isArray(rawTpl.squad) && rawTpl.squad.length > 0
        ? deepClone(rawTpl.squad)
        : [
            buildEnemyUnitByClass(
              rawTpl.tier === 'boss'
                ? 'BOSS'
                : rawTpl.subThreat > 0
                ? 'SS'
                : rawTpl.airThreat > 0
                ? 'CV'
                : 'CL',
              0,
              tierCfg,
              {
                type: rawTpl.tier || node?.type || NODE_TYPES.ENCOUNTER,
                baseName: rawTpl.name || node?.name || '敌方旗舰',
                depthRatio,
                strengthMultiplier: strMult,
                rng,
              }
            ),
          ];

    const enemies = rawSquad.map((u, idx) => {
      const cls = inferEnemyShipClass(u);
      const defaults = getDefaultEnemyStatsByClass(cls);
      const alreadyStarCalibrated = Number(u.star || 0) >= 1;
      const unitHp = alreadyStarCalibrated
        ? Math.max(18, Math.round(Number(u.maxHp ?? u.hp ?? 35)))
        : Math.max(20, Math.round(Number(u.maxHp ?? u.hp ?? 38) * (0.85 + (strMult - 1) * 0.25)));
      const unitArmor = alreadyStarCalibrated
        ? Math.max(4, Math.round(Number(u.armor ?? 12)))
        : Math.max(6, Math.round(Number(u.armor ?? 12) * (0.9 + (strMult - 1) * 0.2)));
      const unitAtk = alreadyStarCalibrated
        ? Math.max(10, Math.round(Number(u.attackPower ?? 20)))
        : Math.max(12, Math.round(Number(u.attackPower ?? 20) * (0.9 + (strMult - 1) * 0.2)));

      const starNum = Number(u.star || tierCfg.star || 1);
      const hasAutoAsw = Boolean(u.hasAswCapability || cls === 'DD' || cls === 'CL');
      const eqGear = Array.isArray(u.equippedGear)
        ? deepClone(u.equippedGear)
        : hasAutoAsw
        ? [{ slotType: 'sonar', name: `${starNum}★ 深海反潜声呐`, star: starNum, bonusAsw: 6 + starNum * 3 }]
        : [];
      const baseAsw = clamp(Math.round(Number(u.asw ?? Math.round(defaults.asw * 0.55))), 6, 125);
      const rawEva = clamp(Math.round(Number(u.evasion ?? Math.round(defaults.evasion * 0.55))), 8, 120);

      return {
        id: String(u.id || `en_${idx + 1}`),
        name: String(u.name || `敌舰 #${idx + 1}`),
        shipClass: cls,
        role: u.role || (cls === 'BOSS' ? 'boss' : cls === 'SS' ? 'sub' : cls === 'CV' ? 'carrier' : cls === 'CA' ? 'cruiser' : 'escort'),
        tier: u.tier || rawTpl.tier || 'encounter',
        star: starNum,
        hp: unitHp,
        maxHp: unitHp,
        armor: unitArmor,
        attackPower: unitAtk,
        evasion: rawEva,
        derivedEvasion: computeDerivedEvasion(rawEva, cls).dodgeValue,
        aa: clamp(Math.round(Number(u.aa ?? Math.round(defaults.aa * 0.55))), 6, 120),
        asw: hasAutoAsw && !u.equippedGear ? clamp(baseAsw + 6 + starNum * 3, 12, 125) : baseAsw,
        torpedo: clamp(Math.round(Number(u.torpedo ?? unitAtk)), 6, 150),
        submerged: Boolean(u.submerged ?? cls === 'SS'),
        hasAswCapability: hasAutoAsw,
        equippedGear: eqGear,
        stealth: Math.round(Number(u.stealth ?? defaults.stealth)),
        airThreat: Number(u.airThreat ?? (cls === 'CV' || cls === 'BOSS' ? Math.round(unitAtk * 0.7) : 0)),
        subThreat: Number(u.subThreat ?? (cls === 'SS' ? Math.round(unitAtk * 0.7) : 0)),
        weakness: u.weakness || (cls === 'SS' ? 'asw' : cls === 'CV' ? 'aa' : 'shelling'),
        weaknessLabel:
          u.weaknessLabel ||
          (cls === 'SS' ? '反潜弱点' : cls === 'CV' ? '防空/空袭弱点' : '炮击弱点'),
        threatLabel: u.threatLabel || '水面编队',
        scanned: false,
        suppressedTurns: 0,
        armorBraceBonus: 0,
        guardingEnemyId: null,
        guardTurns: 0,
        nextIntent: null,
      };
    });

    assignEnemyGridPositions(enemies);

    const allyPositions =
      this._formation && typeof this._formation.getGridMap === 'function'
        ? deepClone(this._formation.getGridMap())
        : {};

    const initialRange =
      node?.lane === 'stealth' ? ENGAGEMENT_RANGES.MEDIUM : ENGAGEMENT_RANGES.LONG;

    const resDropMult =
      this._resources && typeof this._resources.getDropMultiplier === 'function'
        ? this._resources.getDropMultiplier()
        : 1.0;

    const trackedSupplies = carriedSupplies
      ? {
          fuel: Math.max(0, Math.round(Number(carriedSupplies.fuel) || 0)),
          ammo: Math.max(0, Math.round(Number(carriedSupplies.ammo) || 0)),
          maxFuel: Math.max(1, Math.round(Number(carriedSupplies.maxFuel ?? carriedSupplies.fuel) || 100)),
          maxAmmo: Math.max(1, Math.round(Number(carriedSupplies.maxAmmo ?? carriedSupplies.ammo) || 100)),
        }
      : null;

    this._session = {
      id: `cmb_${Date.now().toString(36)}`,
      characterId: flagshipId,
      fleetMemberIds: memberIds,
      allyPositions,
      formationId: activeFormationId,
      nodeCode: node?.code || 'A',
      nodeName: node?.name || rawTpl.name || '交战海域',
      nodeLane: node?.lane || 'main',
      difficulty: diffId,
      star: tierCfg.star || 1,
      depthRatio,
      strengthMultiplier: strMult,
      resourceDropMultiplier: resDropMult,
      lootBonus: Number((dynScale.lootBonus * resDropMult).toFixed(2)),
      seaCondition: seaCondition ? deepClone(seaCondition) : null,
      carriedSupplies: trackedSupplies,
      supplyDepleted: Boolean(trackedSupplies && (trackedSupplies.fuel <= 0 || trackedSupplies.ammo <= 0)),
      resupplyUsesRemaining: Math.max(0, Math.min(2, Math.floor(Number(resupplyUsesRemaining ?? 2)))),
      round: 1,
      turn: 1,
      phase: 'day',
      dayMaxRounds: 2,
      nightMaxRounds: 2,
      range: initialRange,
      status: 'active',
      reconStatus: 'pending',
      reconAdvantage: false,
      reconCritBonus: 0,
      enemyEvasionDebuffPct: 0,
      airSuperiority: null,
      lastAaBarrage: null,
      aswStalemateRounds: 0,
      reconDetail: null,
      openingEvents: [],
      openingPlayed: false,
      autoDelegateRound: false,
      lockOnBonus: 0,
      evasionBuffTurns: 0,
      smokeTurns: 0,
      aaAlertTurns: 0,
      reconCritTurns: 0,
      guardActorId: null,
      guardTurns: 0,
      targetEnemyId: enemies[0].id,
      enemies,
      enemy: {
        ...deepClone(rawTpl),
        forcedEngagement: Boolean(rawTpl.forcedEngagement || node?.type === 'boss'),
        scanDc: Number(rawTpl.scanDc ?? tierCfg.baseDc),
        evadeDc: Number(rawTpl.evadeDc ?? tierCfg.baseDc),
        shellingDc: Number(rawTpl.shellingDc ?? tierCfg.baseDc),
        torpedoDc: Number(rawTpl.torpedoDc ?? tierCfg.baseDc + 1),
        scanned: false,
      },
      turnQueue: [],
      currentActorIndex: 0,
      turnsLog: [],
    };

    const initFleet = this._getFleetCombatContext(this._session);
    this._syncAggregateEnemy(this._session);

    // 1. Pre-Battle Recon Check & Preemptive Ambush
    this._resolveReconAndAmbush(this._session, initFleet, node, rng);

    // 2. Opening Aerial Battle (Air Superiority -> Opening Bombing -> AA Barrage)
    if (
      this._getFleetCombatContext(this._session).aliveCount > 0 &&
      this._session.enemies.some((e) => e.hp > 0)
    ) {
      this._resolveOpeningAirstrike(this._session, rng);
    }

    // 3. Opening Torpedo (Front-Row Priority!)
    if (
      this._getFleetCombatContext(this._session).aliveCount > 0 &&
      this._session.enemies.some((e) => e.hp > 0)
    ) {
      this._resolveOpeningTorpedo(this._session, rng);
    }

    // 4. Assign smart enemy intents (with pre-locked ally warnings!) & build Unified Mixed Initiative Queue
    const postOpeningFleet = this._getFleetCombatContext(this._session);
    const aliveAllies = postOpeningFleet.members.filter((m) => m.alive);
    const aliveEnemies = this._session.enemies.filter((e) => e.hp > 0);
    if (aliveAllies.length === 0) {
      this._session.status = 'defeated';
    } else if (aliveEnemies.length === 0) {
      this._session.status = 'victory';
    } else {
      for (const en of aliveEnemies) {
        en.nextIntent = pickEnemyIntent(en, aliveAllies, aliveEnemies, rng);
      }
      this._buildTurnQueue(this._session, rng);
    }

    this._syncAggregateEnemy(this._session);
    this._emit('combat:started', {
      sessionId: this._session.id,
      characterId: flagshipId,
      fleetMemberIds: memberIds,
      enemyName: this._session.enemy.name,
      enemyCount: enemies.length,
      strengthMultiplier: strMult,
      reconStatus: this._session.reconStatus,
      airSuperiority: this._session.airSuperiority,
      forcedEngagement: this._session.enemy.forcedEngagement,
    });
    return this.getSession();
  }

  /**
   * 100% Guaranteed Safe Retreat (逃跑) from any combat encounter (including BOSS).
   * Preserves current ship HP & remaining carried supplies; forfeits only unfinished battle loot.
   */
  retreatFromCombat() {
    if (!this._session) return { ok: false, reason: '当前无进行中的战斗' };
    const session = this._session;
    session.status = 'retreated';
    session.autoDelegateRound = false;
    session.turnsLog.unshift({
      turn: session.turn,
      round: session.round,
      phase: session.phase,
      side: 'ally',
      commandId: 'safe_retreat',
      commandLabel: '紧急撤退',
      visualStyle: 'evade',
      actorId: session.characterId,
      actorName: '全舰队',
      actorClass: 'FLEET',
      targetEnemyId: '',
      targetEnemyName: session.enemy?.name || '',
      outcomeTag: 'retreated',
      text: '【100% 安全撤退】舰队拉起烟幕有序脱离战区，保留当前耐久与剩余携带油弹！',
      source: 'local',
      degraded: false,
      damageDealt: 0,
      damageTaken: 0,
      isCrit: false,
    });
    this._emit('combat:retreated', {
      sessionId: session.id,
      carriedSupplies: session.carriedSupplies ? deepClone(session.carriedSupplies) : null,
      resupplyUsesRemaining: session.resupplyUsesRemaining,
    });
    return { ok: true, session: this.getSession() };
  }

  /**
   * Deduct action fuel/ammo from carried sortie supplies (never soft-locks; sets `supplyDepleted` at 0).
   */
  async _consumeCombatSupplies(session, { fuel = 0, ammo = 0, reason = '战术行动' } = {}) {
    if (session.carriedSupplies) {
      if (fuel > 0) {
        session.carriedSupplies.fuel = Math.max(0, Math.round(session.carriedSupplies.fuel - fuel));
      }
      if (ammo > 0) {
        session.carriedSupplies.ammo = Math.max(0, Math.round(session.carriedSupplies.ammo - ammo));
      }
      session.supplyDepleted =
        session.carriedSupplies.fuel <= 0 || session.carriedSupplies.ammo <= 0;
      return { ok: true, depleted: session.supplyDepleted };
    }
    // Fallback for standalone combat without carried supplies pool
    const costMap = {};
    if (fuel > 0) costMap.fuel = fuel;
    if (ammo > 0) costMap.ammo = ammo;
    if (Object.keys(costMap).length > 0 && this._resources) {
      const spend = await this._resources.spendBatch(costMap, { reason });
      if (!spend.ok) {
        session.supplyDepleted = true;
        return { ok: true, depleted: true };
      }
    }
    return { ok: true, depleted: Boolean(session.supplyDepleted) };
  }

  markOpeningPlayed() {
    if (this._session) {
      this._session.openingPlayed = true;
    }
  }

  setTargetEnemy(enemyId) {
    if (!this._session) return null;
    const found = this._session.enemies.find((e) => e.id === String(enemyId) && e.hp > 0);
    if (found) {
      this._session.targetEnemyId = found.id;
    }
    return this.getSession();
  }

  setAutoDelegate(flag) {
    if (!this._session) return false;
    this._session.autoDelegateRound = Boolean(flag);
    return this._session.autoDelegateRound;
  }

  _enrichAllyMember(m, idx, posMap) {
    const eff = this._entities.getEffectiveStats(m.id, { round: 'round' });
    const ent = this._entities.get(m.id);
    const snapPos = posMap[m.id];
    const gridIndex = snapPos?.index ?? m.gridIndex ?? idx % GRID_TOTAL_CELLS;
    const gridRow = snapPos?.row ?? m.gridRow ?? Math.floor(gridIndex / GRID_COLS);
    const gridCol = snapPos?.col ?? m.gridCol ?? gridIndex % GRID_COLS;
    const slotNo = snapPos?.slotNo ?? m.slotNo ?? idx + 1;
    const equippedMap =
      this._inventory && typeof this._inventory.getCharacterEquipment === 'function'
        ? this._inventory.getCharacterEquipment(m.id)
        : {};
    const eqItems = Object.values(equippedMap || {}).filter(Boolean);
    const shipType = m.shipType || ent?.meta?.shipType || '驱逐舰';
    const classCode = resolveShipClass(shipType);
    const mobility = Math.round(Number(eff.evasion ?? ent?.stats?.evasion ?? 20));
    const derivedEva = computeDerivedEvasion(mobility, shipType);
    const radarProfile = computeRadarLockProfile(eqItems);
    const hasAswCapability = hasUnitAswCapability(shipType, eqItems);

    let hasAircraftGear = false;
    let aircraftGearBonus = 0;
    let aaGearBonus = radarProfile.aaBonus || 0;
    for (const it of eqItems) {
      const t = inferEquipmentTypeId(it, '');
      if (t === 'aircraft') {
        hasAircraftGear = true;
        aircraftGearBonus += 10 + Math.round((Number(it.level) || 0) * 1.2);
      } else if (t === 'aa_gun') {
        aaGearBonus += 8 + Math.round((Number(it.level) || 0) * 1.0);
      }
    }

    return {
      ...m,
      shipType,
      slotIndex: idx,
      slotNo,
      slotCode: String(slotNo).padStart(2, '0'),
      gridIndex,
      gridRow,
      gridCol,
      rowLabel: GRID_ROW_LABELS[gridRow] || '前排',
      evasion: mobility,
      derivedEvasion: derivedEva.dodgeValue,
      agilityTag: derivedEva.agilityTag,
      radarProfile,
      hasAswCapability,
      submerged: classCode === 'SS',
      hasAircraftGear,
      aircraftGearBonus,
      aaGearBonus,
      recon: Math.round(Number(eff.recon ?? ent?.stats?.recon ?? 18)),
      aa: Math.round(Number(eff.aa ?? ent?.stats?.aa ?? 18)),
      asw: Math.round(Number(eff.asw ?? ent?.stats?.asw ?? 16)),
      firepower: Math.round(Number(eff.firepower ?? m.firepower ?? 18)),
      torpedo: Math.round(Number(eff.torpedo ?? m.torpedo ?? 16)),
      armor: Math.round(Number(eff.armor ?? m.armor ?? 16)),
      morale: Math.round(Number(ent?.stats?.morale ?? 70)),
      classCode,
    };
  }

  _getFleetCombatContext(session) {
    const posMap = session?.allyPositions || {};
    if (this._formation) {
      const summary = this._formation.computeFleetSummary(session.fleetMemberIds, session.formationId);
      const enrichedMembers = (summary.members || []).map((m, idx) => this._enrichAllyMember(m, idx, posMap));
      return { ...summary, members: enrichedMembers };
    }
    const char = this._entities.get(session.characterId);
    const eff = char ? this._entities.getEffectiveStats(char.id, { round: 'round' }) : {};
    const maxHp = Math.round(Number(eff.maxHp ?? char?.stats?.maxHp ?? 30));
    const hp = Math.round(Number(char?.stats?.hp ?? maxHp));
    const soloMember = char
      ? this._enrichAllyMember(
          {
            id: char.id,
            name: char.name,
            shipType: char.meta?.shipType || '驱逐舰',
            isFlagship: true,
            alive: hp > 0,
            hp,
            maxHp,
          },
          0,
          posMap
        )
      : null;
    return {
      count: char ? 1 : 0,
      aliveCount: hp > 0 ? 1 : 0,
      formationName: '单舰阵',
      formationMods: { guardBonus: 0, critBonus: 0 },
      synergyFactor: 1,
      avgMorale: Math.round(Number(char?.stats?.morale ?? 60)),
      avgCheckBonus: char ? this._inventory.getCharacterEquipmentBonuses(char.id).checkBonus : 0,
      effective: {
        firepower: soloMember?.firepower ?? 18,
        armor: soloMember?.armor ?? 16,
        torpedo: soloMember?.torpedo ?? 16,
        evasion: soloMember?.evasion ?? 20,
        recon: soloMember?.recon ?? 18,
        aa: soloMember?.aa ?? 18,
        asw: soloMember?.asw ?? 16,
      },
      checkRatings: {
        firepower: soloMember?.firepower ?? 18,
        armor: soloMember?.armor ?? 16,
        torpedo: soloMember?.torpedo ?? 16,
        evasion: soloMember?.evasion ?? 20,
        recon: soloMember?.recon ?? 18,
        aa: soloMember?.aa ?? 18,
        asw: soloMember?.asw ?? 16,
      },
      members: soloMember ? [soloMember] : [],
    };
  }

  /**
   * Return the next living, unacted unit slot in the unified ally+enemy turnQueue.
   */
  getCurrentTurnSlot() {
    if (!this._session || this._session.status !== 'active') return null;
    const fleet = this._getFleetCombatContext(this._session);
    const queue = this._session.turnQueue || [];
    while (this._session.currentActorIndex < queue.length) {
      const slot = queue[this._session.currentActorIndex];
      if (!slot || slot.acted) {
        this._session.currentActorIndex += 1;
        continue;
      }
      const side = slot.side || 'ally';
      if (side === 'ally') {
        const uid = slot.unitId || slot.characterId;
        const member = fleet.members.find((m) => m.id === uid && m.alive);
        if (member) return { ...slot, side: 'ally', unitId: member.id, member };
      } else {
        const enemy = (this._session.enemies || []).find((e) => e.id === slot.unitId && e.hp > 0);
        if (enemy) return { ...slot, side: 'enemy', unitId: enemy.id, enemy };
      }
      this._session.currentActorIndex += 1;
    }
    return null;
  }

  isEnemyTurnPending() {
    const slot = this.getCurrentTurnSlot();
    return Boolean(slot && slot.side === 'enemy');
  }

  getCurrentActor() {
    const slot = this.getCurrentTurnSlot();
    if (!slot || slot.side !== 'ally') return null;
    return slot.member || null;
  }

  getAvailableActionsForActor(actor = null) {
    const target = actor || this.getCurrentActor();
    if (!target || !this._session) return [];
    const equippedMap =
      this._inventory && typeof this._inventory.getCharacterEquipment === 'function'
        ? this._inventory.getCharacterEquipment(target.id)
        : {};
    return getGearDrivenTacticalActions(equippedMap, {
      phase: this._session.phase,
      shipType: target.shipType,
      resupplyUsesRemaining: this._session.resupplyUsesRemaining ?? 2,
    });
  }

  getAvailableActionsForCurrentActor() {
    return this.getAvailableActionsForActor(this.getCurrentActor());
  }

  /**
   * Complete current round when all living units (allies + enemies) in `turnQueue` have acted.
   */
  _completeRoundIfNeeded(session, rng = Math.random) {
    if (!session || session.status !== 'active') return { roundCompleted: false, enteredNightPrompt: false };
    const nextSlot = this.getCurrentTurnSlot();
    if (nextSlot) return { roundCompleted: false, enteredNightPrompt: false };

    // Decrement fleet & enemy round buffs
    if (session.smokeTurns > 0) session.smokeTurns -= 1;
    if (session.aaAlertTurns > 0) {
      session.aaAlertTurns -= 1;
      if (session.aaAlertTurns === 0) session.aaShieldOrigin = null;
    }
    if (session.evasionBuffTurns > 0) session.evasionBuffTurns -= 1;
    if (session.reconCritTurns > 0) session.reconCritTurns -= 1;
    if (session.guardTurns > 0) {
      session.guardTurns -= 1;
      if (session.guardTurns === 0) session.guardActorId = null;
    }
    for (const en of session.enemies || []) {
      if (en.suppressedTurns > 0) en.suppressedTurns -= 1;
      if (en.guardTurns > 0) {
        en.guardTurns -= 1;
        if (en.guardTurns === 0) en.guardingEnemyId = null;
      }
      if (en.armorBraceBonus > 0) en.armorBraceBonus = 0;
    }
    session.autoDelegateRound = false;

    const postFleet = this._getFleetCombatContext(session);
    const livingAllies = postFleet.members.filter((m) => m.alive);
    const aliveEnemies = (session.enemies || []).filter((e) => e.hp > 0);
    let enteredNightPrompt = false;

    const allEnemiesSubOnly = aliveEnemies.length > 0 && aliveEnemies.every((e) => e.submerged || e.shipClass === 'SS');
    const allyHasAsw = livingAllies.some((m) => m.hasAswCapability);
    const allAlliesSubOnly = livingAllies.length > 0 && livingAllies.every((m) => m.submerged || m.classCode === 'SS');
    const enemyHasAsw = aliveEnemies.some((e) => e.hasAswCapability);
    const isSubStalemate = (allEnemiesSubOnly && !allyHasAsw) || (allAlliesSubOnly && !enemyHasAsw);
    if (isSubStalemate) {
      session.aswStalemateRounds = (session.aswStalemateRounds || 0) + 1;
    }

    if (livingAllies.length === 0) {
      session.status = 'defeated';
    } else if (aliveEnemies.length === 0) {
      session.status = 'victory';
      if (session.phase === 'night') session.victoryInNight = true;
    } else if (isSubStalemate && (session.supplyDepleted || session.aswStalemateRounds >= 2 || session.round >= session.dayMaxRounds)) {
      session.status = 'day_ended';
      session.turnsLog.unshift({
        turn: session.turn,
        round: session.round,
        phase: session.phase,
        side: 'ally',
        commandId: 'sub_stalemate_withdraw',
        commandLabel: '水下隐匿脱离',
        visualStyle: 'evade',
        actorId: session.characterId,
        actorName: '舰队指挥组',
        actorClass: 'FLEET',
        targetEnemyId: '',
        targetEnemyName: session.enemy?.name || '',
        outcomeTag: 'sub-stalemate',
        text: '【水下隐匿脱离】一方仅存水下潜艇且另一方全员无反潜手段，回合结束/弹药耗尽后双方安全脱离结束交战！',
        source: 'local',
        degraded: false,
        damageDealt: 0,
        damageTaken: 0,
        isCrit: false,
      });
    } else if (session.phase === 'day' && session.round >= session.dayMaxRounds) {
      session.status = 'night_prompt';
      enteredNightPrompt = true;
    } else if (session.phase === 'night' && session.round >= session.dayMaxRounds + session.nightMaxRounds) {
      session.status = 'day_ended';
    } else {
      session.round += 1;
      for (const en of aliveEnemies) {
        en.nextIntent = pickEnemyIntent(en, livingAllies, aliveEnemies, rng);
      }
      this._buildTurnQueue(session, rng);
    }

    return { roundCompleted: true, enteredNightPrompt };
  }

  /**
   * Smart gear-aware auto-delegate AI decision for the currently acting shipgirl.
   * Strictly picks ONLY among currently unlocked gear-driven / basic commands,
   * automatically utilizing AR/AO `field_repair` and `frontline_resupply` when needed!
   */
  pickAutoActionForActor(actor = null) {
    const session = this._session;
    const cur = actor || this.getCurrentActor();
    if (!session || !cur) return 'basic_fire';
    const unlockedIds = new Set(
      this.getAvailableActionsForActor(cur)
        .filter((a) => a.unlocked)
        .map((a) => a.id)
    );
    const fleet = this._getFleetCombatContext(session);
    const livingAllies = fleet.members.filter((m) => m.alive);
    const injuredAlly = livingAllies.find((m) => m.hp / Math.max(1, m.maxHp) < 0.68);
    const carriedAmmoRatio = session.carriedSupplies
      ? session.carriedSupplies.ammo / Math.max(1, session.carriedSupplies.maxAmmo)
      : 1;
    const carriedFuelRatio = session.carriedSupplies
      ? session.carriedSupplies.fuel / Math.max(1, session.carriedSupplies.maxFuel)
      : 1;

    // Prioritize Support Gear (AR field repair & AO frontline resupply)
    if (injuredAlly && unlockedIds.has('field_repair')) return 'field_repair';
    if (
      unlockedIds.has('frontline_resupply') &&
      (session.resupplyUsesRemaining ?? 0) > 0 &&
      (session.supplyDepleted || carriedAmmoRatio < 0.45 || carriedFuelRatio < 0.4 || (fleet.avgMorale || 80) < 62)
    ) {
      return 'frontline_resupply';
    }

    const aliveEnemies = session.enemies.filter((e) => e.hp > 0);
    const hasSub = aliveEnemies.some((e) => e.role === 'sub' || e.shipClass === 'SS' || e.subThreat > 0);
    const hasAirIntent = aliveEnemies.some((e) => e.nextIntent?.id === 'airstrike');
    const anyUnscanned = aliveEnemies.some((e) => !e.scanned);

    if (hasSub && unlockedIds.has('depth_asw')) return 'depth_asw';
    if (hasAirIntent && session.aaAlertTurns <= 0 && unlockedIds.has('aa_alert')) return 'aa_alert';
    if (anyUnscanned && session.lockOnBonus <= 0 && unlockedIds.has('radar_scan')) return 'radar_scan';

    if (session.phase === 'night' && unlockedIds.has('torpedo_strike')) return 'torpedo_strike';
    if (session.range === ENGAGEMENT_RANGES.CLOSE && unlockedIds.has('torpedo_strike')) return 'torpedo_strike';
    if (unlockedIds.has('carrier_airstrike')) return 'carrier_airstrike';
    if (unlockedIds.has('main_salvo')) return 'main_salvo';
    if (unlockedIds.has('torpedo_strike')) return 'torpedo_strike';
    if (unlockedIds.has('depth_asw')) return 'depth_asw';
    return 'basic_fire';
  }

  /**
   * Transition from Day Battle prompt into Night Battle Pursuit!
   * Blocked when fleet is in `supplyDepleted` (补给匮乏) state.
   */
  enterNightBattle({ rng = Math.random } = {}) {
    if (!this._session || this._session.status !== 'night_prompt') {
      return { ok: false, reason: '当前不在昼夜战转换时机' };
    }
    const session = this._session;
    if (session.supplyDepleted) {
      return {
        ok: false,
        reason: '当前处于【补给匮乏】状态（携带油弹耗尽），无法发动夜战追击！',
      };
    }
    session.phase = 'night';
    session.status = 'active';
    session.round += 1;
    session.range = ENGAGEMENT_RANGES.CLOSE;
    const livingAllies = this._getFleetCombatContext(session).members.filter((m) => m.alive);
    const aliveEnemies = session.enemies.filter((e) => e.hp > 0);
    for (const en of aliveEnemies) {
      en.nextIntent = pickEnemyIntent(en, livingAllies, aliveEnemies, rng);
    }
    this._buildTurnQueue(session, rng);
    this._emit('combat:night-started', { sessionId: session.id, round: session.round });
    return { ok: true, session: this.getSession() };
  }

  /**
   * Conclude battle cleanly after Day Battle without pursuing into Night Battle.
   */
  finishBattleEarly() {
    if (!this._session) return { ok: false, reason: '无进行中战斗' };
    const session = this._session;
    const aliveEnemies = session.enemies.filter((e) => e.hp > 0);
    session.status = aliveEnemies.length === 0 ? 'victory' : 'day_ended';
    this._emit('combat:ended-early', { sessionId: session.id, status: session.status });
    return { ok: true, session: this.getSession() };
  }

  /**
   * Execute ONE enemy unit's class-based AI turn using exact symmetric d20 roll + `50 / (50 + effArmor)` formula.
   */
  executeEnemyTurn({ rng = Math.random } = {}) {
    if (!this._session || this._session.status !== 'active') {
      return { ok: false, reason: '当前战斗未激活' };
    }
    const session = this._session;
    const slot = this.getCurrentTurnSlot();
    if (!slot || slot.side !== 'enemy' || !slot.enemy) {
      return { ok: false, reason: '当前并非敌方行动顺位' };
    }

    const en = slot.enemy;
    const freshFleet = this._getFleetCombatContext(session);
    const livingAllies = freshFleet.members.filter((m) => m.alive);
    const aliveEnemies = session.enemies.filter((e) => e.hp > 0);
    if (livingAllies.length === 0) {
      session.status = 'defeated';
      return { ok: false, reason: '我方编队已全员失能' };
    }

    const intent = en.nextIntent || pickEnemyIntent(en, livingAllies, aliveEnemies, rng) || ENEMY_INTENTS.heavy_shelling;
    let damageTaken = 0;
    let targetAlly = null;
    let text = '';
    let enemyD20 = null;
    let enemyIsCrit = false;

    if (intent.id === 'enemy_guard') {
      const comrade =
        aliveEnemies.find((e) => e.id === intent.guardTargetId && e.id !== en.id) ||
        aliveEnemies.find((e) => e.id !== en.id) ||
        en;
      en.guardingEnemyId = comrade.id;
      en.guardTurns = 2;
      en.armorBraceBonus = Math.max(en.armorBraceBonus || 0, 6);
      text = `【敌方重巡援护】[${en.shipClass}]${en.name} 前出掩护「${comrade.name}」（2回合分担 50% 伤害 · 护甲 +6）！`;
    } else if (intent.id === 'brace_armor') {
      en.armorBraceBonus = Math.max(en.armorBraceBonus || 0, 8);
      text = `【敌方装甲强化】[${en.shipClass}]${en.name} 收缩阵型强化护甲（护甲 +8）！`;
    } else {
      targetAlly =
        livingAllies.find((m) => m.id === intent.targetAllyId) ||
        selectSmartAllyTarget(livingAllies, en, rng, { isAirstrike: intent.id === 'airstrike' });

      // Submarine underwater stealth guard: non-ASW enemy ships cannot hit submerged allied SS!
      if (targetAlly && (targetAlly.submerged || targetAlly.classCode === 'SS') && !en.hasAswCapability) {
        damageTaken = 0;
        text = `【无法锁定水下目标】[${en.shipClass}]${en.name} 缺乏反潜装备，无法命中水下隐匿的「${targetAlly.name}」！`;
      } else {
        const rangeRowMod = computeRangeRowCombatModifiers({
          engagementRange: session.range,
          attackerRow: en.gridRow ?? 0,
          defenderRow: targetAlly.gridRow ?? 0,
          actionId: intent.id,
          shipClass: en.shipClass,
        });

        const escortAura = getSameRowAndAdjacentAura(livingAllies, targetAlly);
        const cmdAffinitySupport =
          this._commander && typeof this._commander.getSupportSkillMultiplier === 'function'
            ? this._commander.getSupportSkillMultiplier()
            : 1.0;

        let guardedBy = null;
        let guardShareRatio = 0.55;
        let guardSourceLabel = '前排援护';
        if (session.guardTurns > 0 && session.guardActorId && targetAlly.id !== session.guardActorId) {
          const guardian = livingAllies.find((m) => m.id === session.guardActorId);
          if (guardian && guardian.hp > 5) {
            guardedBy = guardian;
            guardShareRatio = clamp(0.55 * Math.min(1.2, cmdAffinitySupport), 0.5, 0.7);
            guardSourceLabel = '前排援护';
          }
        } else if (escortAura.guardian) {
          const cmdAssist = this._commander?.getWingmanAssistChance ? this._commander.getWingmanAssistChance() * 0.25 : 0;
          const procChance =
            (escortAura.guardian.classCode === 'CA' ? 0.55 : 0.35) +
            (freshFleet.formationMods?.guardBonus || 0) +
            cmdAssist;
          if (rng() < procChance) {
            guardedBy = escortAura.guardian;
            guardShareRatio = escortAura.guardShareRatio || 0.35;
            guardSourceLabel = '同排/邻格协同援护';
          }
        }

        // Symmetric d20 Hit / Graze / High-Speed Dodge / Crit roll using Derived Evasion!
        const baseDerivedEva = targetAlly.derivedEvasion || computeDerivedEvasion(targetAlly.evasion || 20, targetAlly.shipType).dodgeValue;
        const allyEvaEff =
          baseDerivedEva * (session.supplyDepleted ? 0.75 : 1) +
          (session.smokeTurns > 0 ? 14 : 0) +
          (session.evasionBuffTurns > 0 ? 10 : 0);
        const enemyAcc = Math.round((en.attackPower || 20) * 0.65 + (en.evasion || 20) * 0.35);
        const airHitPenalty = session.airSuperiority?.enemyHitBonus || 0;
        const extraEnemyMod = (en.suppressedTurns > 0 ? -3 : 0) + (rangeRowMod.hitMod || 0) + airHitPenalty;
        enemyD20 = resolveD20CombatRoll({
          accuracy: enemyAcc,
          evasion: allyEvaEff,
          commanderLuck: 0,
          extraMod: extraEnemyMod,
          rng,
        });
        enemyIsCrit = enemyD20.isCrit;

        let skillMult =
          intent.id === 'salvo'
            ? 1.15
            : intent.id === 'airstrike'
            ? 1.08
            : intent.id === 'torpedo_ambush' || intent.id === 'torpedo_salvo'
            ? 1.12
            : intent.id === 'focus_fire'
            ? 1.05
            : 0.96;

        if (en.suppressedTurns > 0) skillMult *= 0.72;
        if (session.smokeTurns > 0) skillMult *= 0.72;
        if (session.evasionBuffTurns > 0) skillMult *= 0.78;
        if (session.phase === 'night' && (intent.id === 'torpedo_ambush' || intent.id === 'torpedo_salvo')) {
          skillMult *= 1.15;
        }

        let auraAaNote = '';
        if (intent.id === 'airstrike') {
          if (session.aaAlertTurns > 0) {
            const orig = session.aaShieldOrigin;
            const inShieldNet =
              orig &&
              Math.abs((targetAlly.gridRow ?? 0) - orig.row) <= 1 &&
              Math.abs((targetAlly.gridCol ?? 0) - orig.col) <= 1;
            skillMult *= inShieldNet ? 0.38 : 0.55;
            if (inShieldNet) auraAaNote = '（防空警戒网邻格护盾 -62%）';
          }
          if (escortAura.aaReduction > 0) {
            skillMult *= 1 - escortAura.aaReduction;
            auraAaNote = auraAaNote || `（同排/邻格防空减伤 -${Math.round(escortAura.aaReduction * 100)}%）`;
          }
          const allyAaGearBonus = livingAllies.reduce((s, m) => s + (Number(m.aaGearBonus) || 0), 0);
          const aaBarrage = computeAaBarrageInterception({
            incomingAirPower: Math.max(18, en.attackPower * 1.35),
            fleetAa: freshFleet.effective?.aa || 22,
            aaGearBonus: allyAaGearBonus,
            escortFighterBonus: (session.airSuperiority?.allyFighterPower || 0) * 0.3,
            aaAlertActive: session.aaAlertTurns > 0,
          });
          skillMult *= clamp(aaBarrage.passThrough, 0.28, 1.0);
          auraAaNote = auraAaNote || `（${aaBarrage.label}）`;
        } else if (intent.id === 'torpedo_ambush' || intent.id === 'torpedo_salvo') {
          const aswFactor = clamp(1 - (freshFleet.effective?.asw || 20) * 0.004, 0.58, 1.0);
          skillMult *= aswFactor;
        }

        const armorPen =
          intent.id === 'torpedo_ambush' || intent.id === 'torpedo_salvo'
            ? 0.4
            : intent.id === 'salvo' || intent.id === 'heavy_shelling'
            ? 0.35
            : intent.id === 'airstrike'
            ? 0.35
            : 0.15;

        const dmgRes = computeSymmetricDamage({
          attack: Math.max(8, en.attackPower * 0.72),
          armor: targetAlly.armor || 16,
          armorPen,
          skillMult,
          rangeMult: rangeRowMod.dmgMult,
          rollMult: enemyD20.rollMult,
        });
        const dmg = dmgRes.damage;
        const rollTag = `1d20(${enemyD20.die})${enemyD20.modifier >= 0 ? '+' : ''}${enemyD20.modifier}=${enemyD20.total}·${enemyD20.tierLabel}`;
        const dodgeNote = enemyD20.highSpeedDodge ? '【高速规避减伤】' : '';

        if (guardedBy) {
          const sharedDmg = Math.max(1, Math.round(dmg * guardShareRatio));
          const residualDmg = Math.max(1, Math.round(dmg * (1 - guardShareRatio - 0.12)));
          this._entities.adjustStat(guardedBy.id, 'hp', -sharedDmg, { min: 0, max: guardedBy.maxHp });
          this._entities.adjustStat(targetAlly.id, 'hp', -residualDmg, { min: 0, max: targetAlly.maxHp });
          damageTaken = sharedDmg + residualDmg;
          text = `【敌方行动】[${en.shipClass}]${en.name}【${intent.label}】(${rollTag})${dodgeNote} 瞄准「${targetAlly.name}」${auraAaNote}→「${guardedBy.name}」${guardSourceLabel}分担（${guardedBy.name} -${sharedDmg} / ${targetAlly.name} -${residualDmg}）！`;
        } else {
          this._entities.adjustStat(targetAlly.id, 'hp', -dmg, { min: 0, max: targetAlly.maxHp });
          damageTaken = dmg;
          text = `【敌方行动】[${en.shipClass}]${en.name}【${intent.label}】(${rollTag})${dodgeNote} 攻击「${targetAlly.name}」${auraAaNote}（${rangeRowMod.label}），造成 ${dmg} 点${enemyIsCrit ? '暴击' : enemyD20.highSpeedDodge ? '高速规避微伤' : enemyD20.tier === 'graze' ? '擦伤' : ''}伤害！`;
        }
      }
    }

    // Mark enemy slot acted and refresh next intent
    const curSlot = session.turnQueue[session.currentActorIndex];
    if (curSlot) {
      curSlot.acted = true;
      curSlot.actionLabel = intent.label;
    }
    session.currentActorIndex += 1;

    const postAllies = this._getFleetCombatContext(session).members.filter((m) => m.alive);
    if (postAllies.length === 0) {
      session.status = 'defeated';
    } else {
      en.nextIntent = pickEnemyIntent(en, postAllies, aliveEnemies, rng);
    }

    const { roundCompleted, enteredNightPrompt } = this._completeRoundIfNeeded(session, rng);

    const turnEntry = {
      turn: session.turn,
      round: session.round,
      phase: session.phase,
      side: 'enemy',
      commandId: intent.id,
      commandLabel: intent.label,
      visualStyle: intent.visualStyle || 'counter',
      actorId: en.id,
      actorName: en.name,
      actorClass: en.shipClass,
      attackerGrid: { side: 'enemy', row: en.gridRow ?? 0, col: en.gridCol ?? 0, index: en.gridIndex ?? 0 },
      targetGrid: targetAlly
        ? { side: 'ally', row: targetAlly.gridRow ?? 0, col: targetAlly.gridCol ?? 0, index: targetAlly.gridIndex ?? 0 }
        : null,
      targetAllyId: targetAlly?.id || null,
      targetAllyName: targetAlly?.name || null,
      targetEnemyId: en.id,
      targetEnemyName: en.name,
      outcomeTag: enemyD20?.tier === 'graze' ? 'enemy-graze' : enemyIsCrit ? 'enemy-crit' : 'enemy-action',
      text,
      source: 'local',
      degraded: false,
      damageDealt: 0,
      damageTaken,
      isCrit: enemyIsCrit,
      d20Roll: enemyD20,
      roundCompleted,
      enteredNightPrompt,
      enemyCounterEvents: [],
    };

    session.turnsLog.unshift(turnEntry);
    if (session.turnsLog.length > 40) session.turnsLog.length = 40;
    session.turn += 1;

    this._emit('combat:enemy-action', {
      sessionId: session.id,
      enemyId: en.id,
      enemyName: en.name,
      enemyClass: en.shipClass,
      intentId: intent.id,
      intentLabel: intent.label,
      targetAllyId: targetAlly?.id || null,
      damage: damageTaken,
      d20Roll: enemyD20,
    });

    return {
      ok: true,
      turnEntry,
      session: this.getSession(),
    };
  }

  /**
   * Drain all consecutive pending enemy turns until an ally turn, defeat, or round end.
   */
  advancePendingEnemyTurns({ rng = Math.random } = {}) {
    const enemyTurns = [];
    let guard = 0;
    while (this._session && this._session.status === 'active' && this.isEnemyTurnPending() && guard < 16) {
      const res = this.executeEnemyTurn({ rng });
      if (!res.ok) break;
      enemyTurns.push(res.turnEntry);
      guard += 1;
      if (res.turnEntry?.roundCompleted || this._session.status !== 'active') break;
    }
    return {
      ok: true,
      enemyTurns,
      session: this.getSession(),
    };
  }

  /**
   * Execute one allied shipgirl's gear-driven or universal tactical action in unified initiative turn order.
   */
  async executeShipAction(actionId, { targetEnemyId = null, rng = Math.random, autoResolveEnemyTurns = false } = {}) {
    if (!this._session || this._session.status !== 'active') {
      return { ok: false, reason: '当前没有可下达指令的战斗回合' };
    }
    const session = this._session;

    // If an enemy turn is currently ahead of the ally (e.g., direct API call), resolve it cleanly first
    if (this.isEnemyTurnPending()) {
      this.advancePendingEnemyTurns({ rng });
      if (session.status !== 'active') {
        return { ok: false, reason: session.status === 'defeated' ? '我方编队在敌军先手攻击中全员失能' : '本回合已结算' };
      }
    }

    const actor = this.getCurrentActor();
    if (!actor) {
      return { ok: false, reason: '本回合所有舰娘已行动完毕' };
    }

    const actionDef = TACTICAL_ACTION_DEFS[actionId];
    if (!actionDef) {
      return { ok: false, reason: `未知战术指令：${actionId}` };
    }

    // Strict equipment-driven skill validation: specialized skills require wearing matching gear type
    if (actionDef.requiredEquipmentType) {
      const avail = this.getAvailableActionsForActor(actor);
      const match = avail.find((a) => a.id === actionId);
      if (match && !match.unlocked) {
        return { ok: false, reason: `${actor.name} 当前未穿戴对应装备（${match.requiredHint || '需先装备对应武器'}）` };
      }
    }

    if (targetEnemyId) {
      this.setTargetEnemy(targetEnemyId);
    }

    const fleet = this._getFleetCombatContext(session);
    const aliveEnemies = session.enemies.filter((e) => e.hp > 0);
    if (aliveEnemies.length === 0) {
      session.status = 'victory';
      if (session.phase === 'night') session.victoryInNight = true;
      return { ok: false, reason: '敌方编队已被全部击破' };
    }

    let targetEnemy =
      aliveEnemies.find((e) => e.id === session.targetEnemyId) || aliveEnemies[0];
    if (actionId === 'depth_asw' && targetEnemy.role !== 'sub' && targetEnemy.shipClass !== 'SS' && targetEnemy.subThreat <= 0) {
      const subTarget = aliveEnemies.find((e) => e.role === 'sub' || e.shipClass === 'SS' || e.subThreat > 0);
      if (subTarget) {
        targetEnemy = subTarget;
        session.targetEnemyId = subTarget.id;
      }
    }

    // 1. Deduct per-action cost from carried sortie supplies (never soft-locks; activates supplyDepleted at 0)
    const dispatchDisc = this._commander ? this._commander.getSortieStepDiscount() : 0;
    const costScale = Math.max(0.55, 1 - dispatchDisc);
    const fuelSpend = actionDef.cost?.fuel > 0 ? Math.max(1, Math.round(actionDef.cost.fuel * costScale)) : 0;
    const ammoSpend = actionDef.cost?.ammo > 0 ? Math.max(1, Math.round(actionDef.cost.ammo * costScale)) : 0;
    if (fuelSpend > 0 || ammoSpend > 0) {
      await this._consumeCombatSupplies(session, {
        fuel: fuelSpend,
        ammo: ammoSpend,
        reason: `[${actor.name}] 战术指令「${actionDef.label}」`,
      });
    }

    // 2. Perform 1D20 roll (exact symmetric hit/graze/high-speed-dodge/crit + Radar Lock-On + 7-stat Commander bonuses)
    const seaMods = session.seaCondition?.mods || {};
    const cmdTactics = this._commander ? this._commander.getTacticsCheckBonus() : 0;
    const cmdHitBonus = this._commander?.getCommandHitBonus ? this._commander.getCommandHitBonus() : 0;
    const cmdAtkMult =
      1 +
      (this._commander?.getCommandAttackBonusPct ? this._commander.getCommandAttackBonusPct() : 0) +
      (this._commander?.getTacticsFormationBonusPct ? this._commander.getTacticsFormationBonusPct() : 0) +
      (this._commander?.getAffinitySynergyBonusPct ? this._commander.getAffinitySynergyBonusPct() : 0);
    const cmdSupportMult =
      this._commander?.getSupportSkillMultiplier ? this._commander.getSupportSkillMultiplier() : 1.0;
    const cmdLuckFx = this._commander ? this._commander.getLuckEffects() : { luck: 0, edgeCheckMod: 0, critChanceBonus: 0 };
    const cmdLuck = cmdLuckFx.luck || 0;
    const eqBonus = this._inventory ? this._inventory.getCharacterEquipmentBonuses(actor.id).checkBonus : 0;
    const classProfile = getShipClassProfile(actor.shipType);
    const isNight = session.phase === 'night';
    const depletedMult = session.supplyDepleted ? 0.75 : 1.0;

    const rangeRowMod = computeRangeRowCombatModifiers({
      engagementRange: session.range,
      attackerRow: actor.gridRow ?? 0,
      defenderRow: targetEnemy.gridRow ?? 0,
      actionId,
      shipClass: classProfile.code,
    });

    const isOffensiveAction =
      actionId === 'basic_fire' ||
      actionId === 'torpedo_strike' ||
      actionId === 'depth_asw' ||
      actionId === 'main_salvo' ||
      actionId === 'fire_suppress' ||
      actionId === 'heavy_shelling' ||
      actionId === 'tactical_shelling' ||
      actionId === 'carrier_airstrike';

    const airHitBonus =
      isOffensiveAction && session.airSuperiority?.allyHitBonus ? session.airSuperiority.allyHitBonus : 0;
    const radarProfile = actor.radarProfile || { hasRadar: false, evasionIgnorePct: 0, accBonus: 0 };
    const totalRadarIgnorePct = clamp(
      (radarProfile.evasionIgnorePct || 0) + (session.enemyEvasionDebuffPct || 0),
      0,
      0.72
    );

    let statVal = Number(actor[actionDef.statKey] ?? 24);
    let dc = session.enemy.shellingDc || 12;
    let extraMod =
      (seaMods.checkBonus || 0) +
      Math.round(cmdTactics) +
      session.lockOnBonus +
      Math.round(eqBonus) +
      airHitBonus +
      (radarProfile.accBonus || 0) +
      (isOffensiveAction ? rangeRowMod.hitMod : 0) +
      (session.supplyDepleted && isOffensiveAction ? -2 : 0);

    if (actionId === 'radar_scan' || actionId === 'carrier_recon') {
      dc = (session.enemy.scanDc || 12) + (seaMods.scanDcDelta || 0);
      if (classProfile.code === 'CL') extraMod += classProfile.combat.scanCheckBonus || 2;
      if (classProfile.code === 'CV') extraMod += 2;
    } else if (actionId === 'evade_maneuver' || actionId === 'evade_retreat' || actionId === 'full_ahead' || actionId === 'smoke_screen') {
      dc = session.enemy.evadeDc || 12;
      extraMod += (seaMods.evadeBonus || 0);
    } else if (actionId === 'torpedo_strike') {
      dc = session.enemy.torpedoDc || 13;
      extraMod += (isNight ? 3 : 0);
    } else if (actionId === 'depth_asw') {
      dc = 11;
      extraMod += targetEnemy.role === 'sub' || targetEnemy.shipClass === 'SS' || targetEnemy.subThreat > 0 || (targetEnemy.stealth || 0) >= 22 ? 4 : 1;
    } else if (actionId === 'carrier_airstrike') {
      statVal = Math.round(actor.firepower * 0.65 + actor.recon * 0.55);
      dc = session.enemy.shellingDc || 12;
    }

    const enemyDerivedEva =
      targetEnemy.derivedEvasion || computeDerivedEvasion(targetEnemy.evasion || 20, targetEnemy.shipClass).dodgeValue;
    const allyD20 = resolveD20CombatRoll({
      accuracy: Math.round((statVal * 0.7 + (actor.recon || 18) * 0.3 + cmdHitBonus) * depletedMult),
      evasion: enemyDerivedEva,
      radarIgnorePct: totalRadarIgnorePct,
      commanderLuck: cmdLuck,
      extraMod,
      rng,
    });

    const checkResult = {
      die: allyD20.die,
      modifier: allyD20.modifier,
      total: allyD20.total,
      dc: 11,
      outcome: allyD20.isCrit ? 'crit-success' : allyD20.tier === 'hit' ? 'success' : 'failure',
      tier: allyD20.tier,
      tierLabel: allyD20.tierLabel,
      rollMult: allyD20.rollMult,
    };

    const isSuccess = allyD20.tier === 'hit' || allyD20.tier === 'crit';
    const critChanceBonus =
      (session.reconCritBonus || 0) +
      (cmdLuckFx.critChanceBonus || 0) +
      (session.reconCritTurns > 0 ? 0.16 : 0) +
      (session.range === ENGAGEMENT_RANGES.CLOSE && actionId === 'torpedo_strike' ? 0.12 : 0) +
      (isNight && (actionId === 'torpedo_strike' || actionId === 'heavy_shelling' || actionId === 'tactical_shelling' || actionId === 'main_salvo') ? 0.18 : 0) +
      (fleet.formationMods?.critBonus || 0);
    const isCrit = allyD20.isCrit || (isSuccess && rng() < critChanceBonus);
    const effectiveRollMult = isCrit ? 1.5 : allyD20.rollMult;

    // 3. Resolve action effect!
    let damageDealt = 0;
    let outcomeTag = 'action';
    const extraEvents = [];
    let rangeChangedTo = null;
    let scannedNow = false;
    const seaDmgMult = seaMods.dmgMult || 1.0;

    const calcRangeMult = () => rangeRowMod.dmgMult;

    const nightDmgMult =
      isNight && actionId === 'torpedo_strike'
        ? 1.38
        : isNight && (actionId === 'tactical_shelling' || actionId === 'heavy_shelling' || actionId === 'main_salvo' || actionId === 'basic_fire')
        ? 1.22
        : isNight && actionId === 'carrier_airstrike'
        ? 0.86
        : 1.0;

    if (actionId === 'field_repair') {
      const livingAllies = fleet.members.filter((m) => m.alive);
      const injuredSorted = [...livingAllies].sort(
        (a, b) => a.hp / Math.max(1, a.maxHp) - b.hp / Math.max(1, b.maxHp)
      );
      const healTarget = injuredSorted[0] || actor;
      const arBonus = classProfile.code === 'AR' ? 0.16 : 0;
      const healRatio = (0.28 + arBonus + (isCrit ? 0.12 : 0)) * cmdSupportMult;
      const healAmt = Math.max(8, Math.round(healTarget.maxHp * healRatio + (actor.armor || 16) * 0.2));
      const beforeHp = healTarget.hp;
      const afterHp = this._entities.adjustStat(healTarget.id, 'hp', healAmt, { min: 0, max: healTarget.maxHp });
      const actualHeal = Math.max(0, Math.round(afterHp - beforeHp));
      outcomeTag = 'support-repair';
      extraEvents.push(
        `紧急抢修「${healTarget.name}」恢复 ${actualHeal} HP（${Math.round(afterHp)}/${healTarget.maxHp}）${classProfile.code === 'AR' ? ' · 维修舰专精加成' : ''}`
      );
      this._emit('fx:play', {
        type: 'float-text',
        payload: { text: `抢修 ${healTarget.name} +${actualHeal} HP`, tone: 'ok' },
      });
    } else if (actionId === 'frontline_resupply') {
      if ((session.resupplyUsesRemaining ?? 0) <= 0) {
        return { ok: false, reason: '本次出征「前线补给」次数已用尽（需返港补满）' };
      }
      session.resupplyUsesRemaining = Math.max(0, (session.resupplyUsesRemaining ?? 2) - 1);
      const aoBonus = (classProfile.code === 'AO' ? 1.25 : 1.0) * cmdSupportMult;
      let fuelGain = 0;
      let ammoGain = 0;
      if (session.carriedSupplies) {
        const addFuel = Math.round(Math.max(28, session.carriedSupplies.maxFuel * 0.34) * aoBonus);
        const addAmmo = Math.round(Math.max(32, session.carriedSupplies.maxAmmo * 0.38) * aoBonus);
        const prevF = session.carriedSupplies.fuel;
        const prevA = session.carriedSupplies.ammo;
        session.carriedSupplies.fuel = Math.min(session.carriedSupplies.maxFuel, prevF + addFuel);
        session.carriedSupplies.ammo = Math.min(session.carriedSupplies.maxAmmo, prevA + addAmmo);
        fuelGain = session.carriedSupplies.fuel - prevF;
        ammoGain = session.carriedSupplies.ammo - prevA;
        session.supplyDepleted =
          session.carriedSupplies.fuel <= 0 || session.carriedSupplies.ammo <= 0;
      }
      const moraleBoost = Math.round(12 * aoBonus);
      for (const m of fleet.members) {
        if (m.alive) {
          this._entities.adjustStat(m.id, 'morale', moraleBoost, { min: 0, max: 100 });
        }
      }
      outcomeTag = 'support-resupply';
      extraEvents.push(
        `前线补给生效：携带油 +${fuelGain}、弹 +${ammoGain}、全队士气 +${moraleBoost}（剩余 ${session.resupplyUsesRemaining}/2 次）${classProfile.code === 'AO' ? ' · 补给舰专精加成' : ''}`
      );
      this._emit('fx:play', {
        type: 'float-text',
        payload: { text: `前线补给 油+${fuelGain} 弹+${ammoGain}`, tone: 'ok' },
      });
    } else if (actionId === 'radar_scan' || actionId === 'carrier_recon') {
      scannedNow = true;
      for (const en of session.enemies) {
        en.scanned = true;
      }
      session.lockOnBonus = Math.min(6, session.lockOnBonus + (isCrit ? 3 : 2));
      session.enemyEvasionDebuffPct = Math.max(session.enemyEvasionDebuffPct || 0, 0.22);
      if (actionId === 'carrier_recon' || isCrit) {
        session.reconCritTurns = Math.max(session.reconCritTurns, 2);
        extraEvents.push('全队暴击率 +16%（2回合）');
      }
      outcomeTag = 'scan-ok';
      this._emit('combat:scan', { success: true, label: `雷达校射锁定 +${session.lockOnBonus}` });
      extraEvents.push(`敌舰意图与弱点已全面揭露 · 全队命中修正 +${session.lockOnBonus} · 敌闪避削弱 22%`);
    } else if (actionId === 'smoke_screen') {
      session.smokeTurns = Math.max(session.smokeTurns, isCrit ? 3 : 2);
      outcomeTag = 'buff-smoke';
      extraEvents.push(`全队烟幕屏障生效（${session.smokeTurns}回合 · 敌方命中与伤害大幅下降）`);
      this._emit('fx:play', { type: 'float-text', payload: { text: '烟幕展开 · 全队闪避UP', tone: 'ok' } });
    } else if (actionId === 'aa_alert') {
      session.aaAlertTurns = Math.max(session.aaAlertTurns, isCrit ? 3 : 2);
      session.aaShieldOrigin = { row: actor.gridRow ?? 0, col: actor.gridCol ?? 0, actorId: actor.id };
      outcomeTag = 'buff-aa';
      extraEvents.push(`「${actor.name}」展开防空警戒网（${session.aaAlertTurns}回合 · 自身及邻格队友空袭减伤 -62%）`);
      this._emit('fx:play', { type: 'float-text', payload: { text: '防空警戒网护盾开启', tone: 'ok' } });
    } else if (actionId === 'vanguard_guard') {
      session.guardActorId = actor.id;
      session.guardTurns = Math.max(session.guardTurns, isCrit ? 3 : 2);
      outcomeTag = 'buff-guard';
      extraEvents.push(`「${actor.name}」进入前排援护（${session.guardTurns}回合 · 为残血队友分担伤害）`);
      this._emit('fx:play', { type: 'float-text', payload: { text: `${actor.name} 前排援护`, tone: 'ok' } });
    } else if (actionId === 'full_ahead') {
      if (session.range === ENGAGEMENT_RANGES.LONG) {
        session.range = ENGAGEMENT_RANGES.MEDIUM;
        rangeChangedTo = RANGE_META.medium.label;
      } else if (session.range === ENGAGEMENT_RANGES.MEDIUM) {
        session.range = ENGAGEMENT_RANGES.CLOSE;
        rangeChangedTo = RANGE_META.close.label;
      }
      session.evasionBuffTurns = Math.max(session.evasionBuffTurns, 2);
      outcomeTag = 'maneuver-advance';
      extraEvents.push(
        rangeChangedTo
          ? `全速突进拉近至【${rangeChangedTo}】· 全队闪避缓冲 2 回合`
          : '已处于【近距离】贴脸缠斗 · 闪避缓冲刷新至 2 回合'
      );
      this._emit('fx:play', { type: 'float-text', payload: { text: rangeChangedTo ? `突进 → ${rangeChangedTo}` : '近距闪避UP', tone: 'accent' } });
    } else if (actionId === 'evade_maneuver') {
      session.evasionBuffTurns = Math.max(session.evasionBuffTurns, 2);
      if (session.range === ENGAGEMENT_RANGES.LONG) {
        session.range = ENGAGEMENT_RANGES.MEDIUM;
        rangeChangedTo = RANGE_META.medium.label;
      } else if (session.range === ENGAGEMENT_RANGES.MEDIUM) {
        session.range = ENGAGEMENT_RANGES.CLOSE;
        rangeChangedTo = RANGE_META.close.label;
      } else if (!session.enemy.forcedEngagement && isSuccess) {
        session.status = 'bypassed';
        outcomeTag = 'evade-bypass';
        extraEvents.push('全队借近距机动成功甩开敌方防线，无伤脱离！');
      }
      if (session.status !== 'bypassed') {
        outcomeTag = 'maneuver-evade';
        extraEvents.push(
          rangeChangedTo
            ? `机动调整站位至【${rangeChangedTo}】并强化全队闪避减伤（2回合）`
            : '执行高机动规避演练（2回合全队闪避减伤）'
        );
      }
      this._emit('fx:play', { type: 'float-text', payload: { text: rangeChangedTo ? `调距 → ${rangeChangedTo}` : '机动规避 UP', tone: 'accent' } });
    } else if (actionId === 'evade_retreat') {
      if (!session.enemy.forcedEngagement && isSuccess) {
        session.status = 'bypassed';
        outcomeTag = 'evade-bypass';
        extraEvents.push('全队高速机动绕过敌方防线，无伤脱离！');
      } else {
        session.evasionBuffTurns = Math.max(session.evasionBuffTurns, 2);
        outcomeTag = session.enemy.forcedEngagement ? 'evade-boss-buff' : 'evade-fail';
        extraEvents.push(
          session.enemy.forcedEngagement
            ? 'BOSS 封锁无法绕过（可点击右上角「安全撤退」），转为规避机动'
            : '脱离未完全甩开敌舰，已获得 2 回合机动减伤'
        );
      }
    } else if ((targetEnemy.submerged || targetEnemy.shipClass === 'SS') && !actor.hasAswCapability) {
      // Submarine underwater stealth guard: BB / CA / AR / AO / non-ASW CV cannot hit submerged SS!
      damageDealt = 0;
      outcomeTag = 'sub-untargetable';
      extraEvents.push(`无法锁定水下目标（${actor.name} 无反潜能力/反潜装备，需由驱逐/轻巡/轻母或装配声呐深弹的舰娘反潜）`);
      this._emit('fx:play', {
        type: 'float-text',
        payload: { text: '无法锁定水下目标', tone: 'warn' },
      });
    } else {
      // Exact Symmetric Smooth Armor Formula: effectiveAttack * (50 / (50 + effectiveArmor)) * skillMult * rangeMult * rollMult
      const rawEnemyArmor = Math.max(0, targetEnemy.armor + (targetEnemy.armorBraceBonus || 0));
      let armorPen = 0.15;
      let effectiveAttack = (actor.firepower || 20) * depletedMult * cmdAtkMult;
      let skillMult = 1.0;
      let weakBonus = 1.0;

      if (actionId === 'basic_fire') {
        armorPen = 0.15;
        effectiveAttack = Math.max(actor.firepower || 16, (actor.torpedo || 14) * 0.85) * depletedMult * cmdAtkMult;
        skillMult = 0.82;
        if (targetEnemy.weakness === 'shelling') weakBonus = 1.08;
      } else if (actionId === 'torpedo_strike') {
        armorPen = 0.4; // Torpedo ignores 40% effective armor
        effectiveAttack = ((actor.torpedo || 20) + session.lockOnBonus * 1.5) * depletedMult * cmdAtkMult;
        skillMult = classProfile.code === 'DD' || classProfile.code === 'SS' ? 1.24 : 1.12;
        if (targetEnemy.weakness === 'torpedo') weakBonus = 1.22;
      } else if (actionId === 'depth_asw') {
        armorPen = 0.55;
        effectiveAttack = (actor.asw || 20) * depletedMult * cmdAtkMult;
        const isSubOrStealth =
          targetEnemy.role === 'sub' ||
          targetEnemy.shipClass === 'SS' ||
          targetEnemy.subThreat > 0 ||
          (targetEnemy.stealth || 0) >= 22;
        skillMult = isSubOrStealth ? (classProfile.code === 'DD' ? 1.65 : 1.45) : 0.82;
        if (isSubOrStealth) {
          targetEnemy.stealth = Math.max(0, (targetEnemy.stealth || 0) - 12);
          extraEvents.push('声呐深弹精准锁定水下目标，造成反潜重创！');
        }
      } else if (actionId === 'main_salvo') {
        armorPen = 0.35; // Main gun AP ignores 35% effective armor
        effectiveAttack = (actor.firepower || 22) * depletedMult * cmdAtkMult;
        skillMult = 1.2;
        if (targetEnemy.weakness === 'shelling') weakBonus = 1.18;
      } else if (actionId === 'fire_suppress') {
        armorPen = 0.35;
        effectiveAttack = (actor.firepower || 20) * depletedMult * cmdAtkMult;
        skillMult = 0.92;
        targetEnemy.suppressedTurns = Math.max(targetEnemy.suppressedTurns, 2);
        extraEvents.push(`「${targetEnemy.name}」陷入火力压制（2回合攻击与命中大幅下降）`);
      } else if (actionId === 'heavy_shelling') {
        armorPen = 0.35;
        effectiveAttack = (actor.firepower || 22) * depletedMult * cmdAtkMult;
        skillMult = 1.12;
        if (targetEnemy.weakness === 'shelling') weakBonus = 1.18;
      } else if (actionId === 'tactical_shelling') {
        armorPen = 0.35;
        effectiveAttack = (actor.firepower || 20) * depletedMult * cmdAtkMult;
        skillMult = 1.04;
        if (targetEnemy.weakness === 'shelling') weakBonus = 1.15;
      } else if (actionId === 'carrier_airstrike') {
        armorPen = 0.45;
        effectiveAttack = ((actor.firepower || 20) * 0.65 + (actor.recon || 20) * 0.5) * depletedMult * cmdAtkMult;
        const enemyAaMit = clamp(50 / (50 + (targetEnemy.aa || 22) * 0.45), 0.62, 1.0);
        skillMult = 1.2 * enemyAaMit;
        if (targetEnemy.weakness === 'aa') weakBonus = 1.22;
      }

      if (allyD20.radarIgnoredEvasion > 0) {
        extraEvents.push(`火控锁定无视敌闪避 -${allyD20.radarIgnoredEvasion}`);
      }
      if (session.supplyDepleted) {
        extraEvents.push('⚠ 补给匮乏（攻防机动 -25%）');
      }
      if (rangeRowMod.dmgMult !== 1.0) {
        extraEvents.push(`${rangeRowMod.label}（伤害 x${rangeRowMod.dmgMult.toFixed(2)}）`);
      }

      const dmgRes = computeSymmetricDamage({
        attack: effectiveAttack,
        armor: rawEnemyArmor,
        armorPen,
        skillMult: skillMult * nightDmgMult * weakBonus * seaDmgMult,
        rangeMult: calcRangeMult(),
        rollMult: effectiveRollMult,
      });
      damageDealt = dmgRes.damage;

      // Check if an enemy CA is actively guarding `targetEnemy`!
      const enemyGuardian = session.enemies.find(
        (e) => e.hp > 0 && e.id !== targetEnemy.id && e.guardTurns > 0 && e.guardingEnemyId === targetEnemy.id
      );
      if (enemyGuardian && actionId !== 'depth_asw' && actionId !== 'carrier_airstrike') {
        const absorbDmg = Math.max(1, Math.round(damageDealt * 0.5));
        const passDmg = Math.max(1, damageDealt - absorbDmg);
        enemyGuardian.hp = Math.max(0, enemyGuardian.hp - absorbDmg);
        targetEnemy.hp = Math.max(0, targetEnemy.hp - passDmg);
        extraEvents.push(`敌重巡「${enemyGuardian.name}」前排援护挡下 ${absorbDmg} 点伤害`);
        if (enemyGuardian.hp <= 0) extraEvents.push(`击沉援护重巡「${enemyGuardian.name}」！`);
        if (targetEnemy.hp <= 0) extraEvents.push(`击沉「${targetEnemy.name}」！`);
      } else {
        targetEnemy.hp = Math.max(0, targetEnemy.hp - damageDealt);
        if (targetEnemy.hp <= 0) {
          extraEvents.push(`击沉「${targetEnemy.name}」！`);
        }
      }

      outcomeTag = isCrit ? 'attack-crit' : isSuccess ? 'attack-hit' : 'attack-graze';
      this._emit('combat:hit', {
        damage: damageDealt,
        crit: isCrit,
        graze: allyD20.tier === 'graze',
        weapon: actionDef.visualStyle,
        targetId: targetEnemy.id,
        d20Roll: allyD20,
      });
    }

    // Mark current ally slot as acted
    const curSlot = session.turnQueue[session.currentActorIndex];
    if (curSlot) {
      curSlot.acted = true;
      curSlot.actionLabel = actionDef.shortLabel;
    }
    session.currentActorIndex += 1;

    // 4. Sync enemy state & check victory / round completion
    this._syncAggregateEnemy(session);
    const remainingEnemies = session.enemies.filter((e) => e.hp > 0);
    let roundCompleted = false;
    let enteredNightPrompt = false;
    const enemyCounterEvents = [];
    let totalDamageTaken = 0;

    if (session.status === 'active' && remainingEnemies.length === 0) {
      session.status = 'victory';
      if (session.phase === 'night') session.victoryInNight = true;
      outcomeTag = 'victory';
    } else if (session.status === 'active') {
      if (autoResolveEnemyTurns && this.isEnemyTurnPending()) {
        const autoRes = this.advancePendingEnemyTurns({ rng });
        for (const et of autoRes.enemyTurns) {
          totalDamageTaken += et.damageTaken || 0;
          enemyCounterEvents.push({
            enemyId: et.actorId,
            enemyName: et.actorName,
            intentLabel: et.commandLabel,
            damage: et.damageTaken || 0,
            text: et.text,
          });
          if (et.roundCompleted) roundCompleted = true;
          if (et.enteredNightPrompt) enteredNightPrompt = true;
        }
      }
      if (!roundCompleted && session.status === 'active') {
        const comp = this._completeRoundIfNeeded(session, rng);
        roundCompleted = comp.roundCompleted;
        enteredNightPrompt = comp.enteredNightPrompt;
      }
    }

    // 5. Compose personality-driven combat speech + battle report
    const actorEntity = this._entities.get(actor.id);
    const speechKind =
      session.status === 'victory'
        ? 'victory'
        : actionId === 'radar_scan' || actionId === 'carrier_recon'
        ? 'scan'
        : actionId === 'evade_retreat' || actionId === 'full_ahead' || actionId === 'smoke_screen'
        ? 'evade'
        : actionId === 'torpedo_strike' || actionId === 'depth_asw'
        ? 'torpedo'
        : actionId === 'carrier_airstrike'
        ? 'airstrike'
        : 'shelling';

    const actorSpeechRes =
      this._dialogueEngine && actorEntity
        ? this._dialogueEngine.composeCombatLine({
            actor: actorEntity,
            commanderName: this._commander ? this._commander.getProfile().name : '港区指挥官',
            commandId: speechKind,
            visualStyle: actionDef.visualStyle,
            damageDealt,
            damageTaken: totalDamageTaken,
            isCrit,
            victory: session.status === 'victory',
          })
        : null;
    const actorSpeech = typeof actorSpeechRes === 'string' ? actorSpeechRes : actorSpeechRes?.speech || '';

    const extraSummary = extraEvents.length ? ` ${extraEvents.join('；')}。` : '';
    const counterSummary = enemyCounterEvents.length
      ? ` 【敌方插队反击】${enemyCounterEvents.map((e) => e.text).join('；')}。`
      : '';
    const rollSummary = `1d20(${allyD20.die})${allyD20.modifier >= 0 ? '+' : ''}${allyD20.modifier}=${allyD20.total}·${isCrit ? '暴击' : allyD20.tierLabel}`;

    let localTemplate = '';
    if (damageDealt > 0) {
      localTemplate = `${actorSpeech ? `${actorSpeech} ` : ''}[${classProfile.code}]${actor.name} 对「${targetEnemy.name}」执行【${actionDef.label}】（${RANGE_META[session.range]?.label || ''} · ${rollSummary}），造成 ${damageDealt} 点${isCrit ? '暴击' : allyD20.tier === 'graze' ? '擦伤' : ''}伤害！${extraSummary}${counterSummary}`;
    } else {
      localTemplate = `${actorSpeech ? `${actorSpeech} ` : ''}[${classProfile.code}]${actor.name} 执行【${actionDef.label}】。${extraSummary}${counterSummary}`;
    }

    const contextMeta =
      this._dialogueEngine && actorEntity
        ? this._dialogueEngine.buildAiContextMeta({
            actor: actorEntity,
            sceneType: `combat-${actionId}`,
            extra: {
              enemyName: targetEnemy.name,
              range: RANGE_META[session.range]?.label,
              phase: session.phase === 'night' ? '夜战' : '昼战',
              commandLabel: actionDef.label,
            },
          })
        : null;

    const rendered = await this._narrative.run({
      template: localTemplate,
      variables: {
        actor: { name: actor.name, hp: actor.hp, maxHp: actor.maxHp },
        enemy: { name: targetEnemy.name, hp: targetEnemy.hp, maxHp: targetEnemy.maxHp },
        damageDealt,
        damageTaken: totalDamageTaken,
      },
      contextMeta,
      polishInstruction: `请以紧凑的海战战术战报口吻润色「${actor.name}」执行【${actionDef.label}】的战果，保留全部伤害数字与舰娘性格口吻：`,
    });

    const turnEntry = {
      turn: session.turn,
      round: session.round,
      phase: session.phase,
      side: 'ally',
      commandId: actionId,
      commandLabel: actionDef.label,
      visualStyle: actionDef.visualStyle,
      actorId: actor.id,
      actorName: actor.name,
      actorClass: classProfile.code,
      attackerGrid: { side: 'ally', row: actor.gridRow ?? 0, col: actor.gridCol ?? 0, index: actor.gridIndex ?? 0 },
      targetGrid: targetEnemy
        ? { side: 'enemy', row: targetEnemy.gridRow ?? 0, col: targetEnemy.gridCol ?? 0, index: targetEnemy.gridIndex ?? 0 }
        : null,
      rangeMod: rangeRowMod,
      targetEnemyId: targetEnemy.id,
      targetEnemyName: targetEnemy.name,
      outcomeTag,
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      damageDealt,
      damageTaken: totalDamageTaken,
      isCrit,
      d20Roll: allyD20,
      scannedNow,
      rangeAfter: session.range,
      rangeChangedTo,
      roundCompleted,
      enteredNightPrompt,
      enemyCounterEvents,
      enemyHpAfter: session.enemy.hp,
      enemyMaxHp: session.enemy.maxHp,
      extraEvents,
      check: checkResult,
    };

    session.turnsLog.unshift(turnEntry);
    if (session.turnsLog.length > 40) session.turnsLog.length = 40;
    session.turn += 1;

    this._emit('combat:turn-resolved', {
      sessionId: session.id,
      turn: turnEntry.turn,
      round: session.round,
      commandId: actionId,
      visualStyle: actionDef.visualStyle,
      status: session.status,
      damageDealt,
      damageTaken: totalDamageTaken,
      roundCompleted,
      enteredNightPrompt,
    });

    return {
      ok: true,
      turnEntry,
      session: this.getSession(),
    };
  }

  /**
   * Backward-compatible wrapper mapping legacy 4 command IDs ('scan'|'evade'|'shelling'|'torpedo').
   */
  async executeCommand(commandId, { rng = Math.random } = {}) {
    if (this.isEnemyTurnPending()) {
      this.advancePendingEnemyTurns({ rng });
    }
    if (TACTICAL_ACTION_DEFS[commandId]) {
      return this.executeShipAction(commandId, { rng, autoResolveEnemyTurns: true });
    }
    const actor = this.getCurrentActor();
    const cls = actor ? resolveShipClass(actor.shipType) : 'CL';
    if (commandId === 'scan') {
      return this.executeShipAction(cls === 'CV' ? 'carrier_recon' : 'radar_scan', { rng, autoResolveEnemyTurns: true });
    }
    if (commandId === 'evade') {
      return this.executeShipAction('evade_retreat', { rng, autoResolveEnemyTurns: true });
    }
    if (commandId === 'torpedo') {
      return this.executeShipAction('torpedo_strike', { rng, autoResolveEnemyTurns: true });
    }
    const mapped =
      cls === 'CV'
        ? 'carrier_airstrike'
        : cls === 'BB'
        ? 'main_salvo'
        : cls === 'CA'
        ? 'heavy_shelling'
        : 'tactical_shelling';
    return this.executeShipAction(mapped, { rng, autoResolveEnemyTurns: true });
  }

  serialize() {
    return this._session ? deepClone(this._session) : null;
  }

  deserialize(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      this._session = null;
      return;
    }
    const s = deepClone(snapshot);
    if (!Array.isArray(s.enemies) || s.enemies.length === 0) {
      const en = s.enemy || { name: '残存敌舰', hp: 50, maxHp: 50, armor: 4, attackPower: 10 };
      s.enemies = [
        {
          id: 'en_1',
          name: en.name,
          shipClass: 'BB',
          role: 'flagship',
          tier: en.tier || 'encounter',
          hp: en.hp ?? 50,
          maxHp: en.maxHp ?? 50,
          armor: en.armor ?? 4,
          attackPower: en.attackPower ?? 10,
          evasion: 48,
          aa: 50,
          asw: 35,
          torpedo: 30,
          stealth: 15,
          airThreat: en.airThreat ?? 0,
          subThreat: en.subThreat ?? 0,
          weakness: en.weakness || 'shelling',
          weaknessLabel: en.weaknessLabel || '炮击弱点',
          threatLabel: en.threatLabel || '水面编队',
          scanned: Boolean(en.scanned),
          suppressedTurns: 0,
          armorBraceBonus: 0,
          guardingEnemyId: null,
          guardTurns: 0,
          nextIntent: { ...ENEMY_INTENTS.salvo },
        },
      ];
    } else {
      // Lossless upgrade for v14 enemy units missing v15 stats
      for (const e of s.enemies) {
        const cls = inferEnemyShipClass(e);
        const defs = getDefaultEnemyStatsByClass(cls);
        if (!e.shipClass) e.shipClass = cls;
        if (e.evasion === undefined) e.evasion = defs.evasion;
        if (e.aa === undefined) e.aa = defs.aa;
        if (e.asw === undefined) e.asw = defs.asw;
        if (e.torpedo === undefined) e.torpedo = defs.torpedo;
        if (e.stealth === undefined) e.stealth = defs.stealth;
        if (e.guardingEnemyId === undefined) e.guardingEnemyId = null;
        if (e.guardTurns === undefined) e.guardTurns = 0;
      }
    }

    if (s.enemies.some((e) => e.gridIndex === undefined || e.gridRow === undefined || !e.slotCode)) {
      assignEnemyGridPositions(s.enemies);
    }
    if (!s.allyPositions || typeof s.allyPositions !== 'object') {
      s.allyPositions =
        this._formation && typeof this._formation.getGridMap === 'function'
          ? deepClone(this._formation.getGridMap())
          : {};
    }

    if (!s.range) s.range = ENGAGEMENT_RANGES.LONG;
    if (!s.phase) s.phase = 'day';
    if (!s.round) s.round = 1;
    if (!s.dayMaxRounds) s.dayMaxRounds = 2;
    if (!s.nightMaxRounds) s.nightMaxRounds = 2;
    if (!s.strengthMultiplier) s.strengthMultiplier = 1.0;
    if (!s.lootBonus) s.lootBonus = 1.0;
    if (!Array.isArray(s.openingEvents)) s.openingEvents = [];
    if (s.openingPlayed === undefined) s.openingPlayed = true;
    if (!s.reconStatus) s.reconStatus = 'success';

    this._session = s;
    this._syncAggregateEnemy(this._session);

    // Upgrade legacy ally-only turnQueue seamlessly
    if (!Array.isArray(this._session.turnQueue) || this._session.turnQueue.length === 0) {
      this._buildTurnQueue(this._session);
    } else {
      for (const slot of this._session.turnQueue) {
        if (!slot.side) slot.side = 'ally';
        if (!slot.unitId) slot.unitId = slot.characterId;
        if (slot.initiative === undefined) slot.initiative = Number(slot.evasion || 50);
      }
    }
  }
}
