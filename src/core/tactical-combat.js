/**
 * Turn-by-Turn Evasion-Ordered Ship-Type Tactical Combat Engine (`tactical-combat.js`).
 *
 * Core Mechanics:
 *   - Multi-unit Enemy Fleet (`enemies[]`) with independent HP, armor, weakness & telegraphed `nextIntent`
 *   - Engagement Distance (`range`: 'long' | 'medium' | 'close') dynamically affecting weapons & shifting via `full_ahead`
 *   - Evasion-sorted Turn Queue (`turnQueue[]`) per round so each shipgirl acts in speed order with her class-exclusive commands:
 *       * DD: torpedo_strike, depth_asw, smoke_screen, full_ahead
 *       * CL: tactical_shelling, torpedo_strike, aa_alert, radar_scan
 *       * CA: heavy_shelling, vanguard_guard, full_ahead
 *       * BB: main_salvo, fire_suppress
 *       * CV: carrier_airstrike, carrier_recon
 *       * Universal: evade_retreat
 *   - Smart class-aware Auto-Execute (`pickAutoActionForActor`) for one-tap round delegation
 *   - Day Battle -> Night Battle Transition (`status: 'night_prompt'` -> `enterNightBattle()` or `finishBattleEarly()`)
 *   - Personality-driven battle speeches via `dialogueEngine` + EventBus FX hooks
 *   - 100% backward compatible with legacy `executeCommand('scan'|'evade'|'shelling'|'torpedo')` & saved sessions
 */

import { clamp } from './calc-engine.js';
import {
  TACTICAL_ACTION_DEFS,
  getShipClassProfile,
  getShipClassTacticalActions,
  resolveShipClass,
} from './stat-rules.js';

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
  salvo: { id: 'salvo', label: '重炮齐射', tone: 'danger', desc: '瞄准我方主力倾泻高威力炮火' },
  airstrike: { id: 'airstrike', label: '舰载机空袭', tone: 'warn', desc: '即将发动高空空袭（防空警戒可大幅削减）' },
  torpedo_ambush: { id: 'torpedo_ambush', label: '水下鱼雷伏击', tone: 'danger', desc: '潜艇逼近发射暗雷（深水反潜可强力克制）' },
  focus_fire: { id: 'focus_fire', label: '集火低血目标', tone: 'danger', desc: '锁定我方残血舰娘（前排援护可分担伤害）' },
  brace_armor: { id: 'brace_armor', label: '装甲强化蓄力', tone: 'muted', desc: '本回合强化防御并准备下轮强攻' },
});

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function rollEnemyIntent(enemyUnit, rng = Math.random) {
  if (!enemyUnit || enemyUnit.hp <= 0) return null;
  if (enemyUnit.role === 'sub' || (enemyUnit.subThreat > 0 && rng() < 0.65)) {
    return { ...ENEMY_INTENTS.torpedo_ambush };
  }
  if (enemyUnit.role === 'carrier' || (enemyUnit.airThreat > 0 && rng() < 0.6)) {
    return { ...ENEMY_INTENTS.airstrike };
  }
  const r = rng();
  if (r < 0.42) return { ...ENEMY_INTENTS.salvo };
  if (r < 0.78) return { ...ENEMY_INTENTS.focus_fire };
  return { ...ENEMY_INTENTS.brace_armor };
}

export class TacticalCombatEngine {
  /**
   * @param {{
   *   entities: import('./entity-system.js').EntitySystem,
   *   inventory: import('./inventory-system.js').InventorySystem,
   *   statRules: import('./stat-rules.js').StatRulesEngine,
   *   resources: import('./resource-manager.js').ResourceManager,
   *   narrative: import('./prompt-pipeline.js').PromptPipeline,
   *   dialogueEngine?: import('./dialogue-engine.js').DialogueEngine | null,
   *   commander?: import('./commander-system.js').CommanderSystem | null,
   *   formation?: import('./formation-system.js').FormationSystem | null,
   *   bus?: import('./event-bus.js').EventBus | null,
   * }} deps
   */
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
    // Ensure targetEnemyId points to a living enemy
    const curTarget = session.enemies.find((e) => e.id === session.targetEnemyId && e.hp > 0);
    if (!curTarget) {
      const firstAlive = session.enemies.find((e) => e.hp > 0);
      session.targetEnemyId = firstAlive ? firstAlive.id : session.enemies[0].id;
    }
  }

  _buildTurnQueue(session) {
    const fleet = this._getFleetCombatContext(session);
    const alive = fleet.members.filter((m) => m.alive);
    const sorted = [...alive].sort((a, b) => {
      const evDiff = (b.evasion || 0) - (a.evasion || 0);
      if (evDiff !== 0) return evDiff;
      return (a.slotIndex ?? 0) - (b.slotIndex ?? 0);
    });
    session.turnQueue = sorted.map((m) => ({
      characterId: m.id,
      name: m.name,
      shipType: m.shipType,
      classCode: resolveShipClass(m.shipType),
      evasion: Math.round(m.evasion || 50),
      acted: false,
      actionLabel: null,
    }));
    session.currentActorIndex = 0;
  }

  /**
   * Initialize a new turn-by-turn tactical combat engagement.
   */
  startEncounter({ characterId = null, fleetMemberIds = null, formationId = null, node, seaCondition = null, rng = Math.random }) {
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
    const fleetScale = 1 + Math.max(0, fleetSize - 1) * 0.22;

    const rawTpl = node?.enemyTemplate || node?.enemy || {
      name: node?.name || '未知敌方编队',
      tier: node?.type || 'encounter',
      forcedEngagement: node?.type === 'boss',
      hp: 68,
      maxHp: 68,
      armor: 5,
      attackPower: 12,
      airThreat: 0,
      subThreat: 0,
      threatLabel: '常规水面编队',
      scanDc: 13,
      evadeDc: 13,
      shellingDc: 13,
      torpedoDc: 14,
      weakness: 'shelling',
      weaknessLabel: '炮击弱点',
    };

    const rawSquad =
      Array.isArray(rawTpl.squad) && rawTpl.squad.length > 0
        ? deepClone(rawTpl.squad)
        : [
            {
              id: 'en_1',
              name: rawTpl.name || node?.name || '敌方旗舰',
              role: rawTpl.tier === 'boss' ? 'boss' : rawTpl.subThreat > 0 ? 'sub' : rawTpl.airThreat > 0 ? 'carrier' : 'flagship',
              tier: rawTpl.tier || node?.type || 'encounter',
              hp: Math.round(Number(rawTpl.maxHp ?? rawTpl.hp ?? 68)),
              maxHp: Math.round(Number(rawTpl.maxHp ?? rawTpl.hp ?? 68)),
              armor: Number(rawTpl.armor ?? 5),
              attackPower: Number(rawTpl.attackPower ?? 12),
              airThreat: Number(rawTpl.airThreat ?? 0),
              subThreat: Number(rawTpl.subThreat ?? 0),
              weakness: rawTpl.weakness || 'shelling',
              weaknessLabel: rawTpl.weaknessLabel || '炮击弱点',
              threatLabel: rawTpl.threatLabel || '常规水面编队',
            },
          ];

    const enemies = rawSquad.map((u, idx) => {
      const scaledHp = Math.max(24, Math.round(Number(u.maxHp ?? u.hp ?? 55) * fleetScale));
      const unit = {
        id: String(u.id || `en_${idx + 1}`),
        name: String(u.name || `敌舰 #${idx + 1}`),
        role: u.role || (idx === 0 ? 'flagship' : 'escort'),
        tier: u.tier || rawTpl.tier || 'encounter',
        hp: scaledHp,
        maxHp: scaledHp,
        armor: Math.max(1, Math.round(Number(u.armor ?? 4))),
        attackPower: Math.max(5, Math.round(Number(u.attackPower ?? 11))),
        airThreat: Number(u.airThreat ?? 0),
        subThreat: Number(u.subThreat ?? 0),
        weakness: u.weakness || 'shelling',
        weaknessLabel: u.weaknessLabel || '炮击弱点',
        threatLabel: u.threatLabel || '水面编队',
        scanned: false,
        suppressedTurns: 0,
        armorBraceBonus: 0,
        nextIntent: null,
      };
      unit.nextIntent = rollEnemyIntent(unit, rng);
      return unit;
    });

    const initialRange =
      node?.lane === 'stealth' ? ENGAGEMENT_RANGES.MEDIUM : ENGAGEMENT_RANGES.LONG;

    this._session = {
      id: `cmb_${Date.now().toString(36)}`,
      characterId: flagshipId,
      fleetMemberIds: memberIds,
      formationId: activeFormationId,
      nodeCode: node?.code || 'A',
      nodeName: node?.name || rawTpl.name || '交战海域',
      nodeLane: node?.lane || 'main',
      seaCondition: seaCondition ? deepClone(seaCondition) : null,
      round: 1,
      turn: 1,
      phase: 'day', // 'day' | 'night'
      dayMaxRounds: 2,
      nightMaxRounds: 2,
      range: initialRange, // 'long' | 'medium' | 'close'
      status: 'active', // 'active' | 'night_prompt' | 'victory' | 'bypassed' | 'day_ended' | 'defeated'
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
        scanDc: Number(rawTpl.scanDc ?? 13),
        evadeDc: Number(rawTpl.evadeDc ?? 13),
        shellingDc: Number(rawTpl.shellingDc ?? 13),
        torpedoDc: Number(rawTpl.torpedoDc ?? 14),
        scanned: false,
      },
      turnQueue: [],
      currentActorIndex: 0,
      turnsLog: [],
    };

    this._syncAggregateEnemy(this._session);
    this._buildTurnQueue(this._session);

    this._emit('combat:started', {
      sessionId: this._session.id,
      characterId: flagshipId,
      fleetMemberIds: memberIds,
      enemyName: this._session.enemy.name,
      enemyCount: enemies.length,
      forcedEngagement: this._session.enemy.forcedEngagement,
    });
    return this.getSession();
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

  _getFleetCombatContext(session) {
    if (this._formation) {
      const summary = this._formation.computeFleetSummary(session.fleetMemberIds, session.formationId);
      // Enrich each member with individual effective naval stats for turn-by-turn actions
      const enrichedMembers = (summary.members || []).map((m, idx) => {
        const eff = this._entities.getEffectiveStats(m.id, { round: 'round' });
        const ent = this._entities.get(m.id);
        return {
          ...m,
          slotIndex: idx,
          evasion: Math.round(Number(eff.evasion ?? ent?.stats?.evasion ?? 50)),
          recon: Math.round(Number(eff.recon ?? ent?.stats?.recon ?? 50)),
          aa: Math.round(Number(eff.aa ?? ent?.stats?.aa ?? 45)),
          asw: Math.round(Number(eff.asw ?? ent?.stats?.asw ?? 45)),
          firepower: Math.round(Number(eff.firepower ?? m.firepower ?? 50)),
          torpedo: Math.round(Number(eff.torpedo ?? m.torpedo ?? 45)),
          armor: Math.round(Number(eff.armor ?? m.armor ?? 40)),
          morale: Math.round(Number(ent?.stats?.morale ?? 70)),
          classCode: resolveShipClass(m.shipType),
        };
      });
      return { ...summary, members: enrichedMembers };
    }
    const char = this._entities.get(session.characterId);
    const eff = char ? this._entities.getEffectiveStats(char.id, { round: 'round' }) : {};
    const maxHp = Math.round(Number(eff.maxHp ?? char?.stats?.maxHp ?? 100));
    const hp = Math.round(Number(char?.stats?.hp ?? maxHp));
    return {
      count: char ? 1 : 0,
      aliveCount: hp > 0 ? 1 : 0,
      formationName: '单舰阵',
      formationMods: { guardBonus: 0, critBonus: 0 },
      synergyFactor: 1,
      avgMorale: Math.round(Number(char?.stats?.morale ?? 60)),
      avgCheckBonus: char ? this._inventory.getCharacterEquipmentBonuses(char.id).checkBonus : 0,
      effective: {
        firepower: Math.round(Number(eff.firepower ?? 50)),
        armor: Math.round(Number(eff.armor ?? 40)),
        torpedo: Math.round(Number(eff.torpedo ?? 45)),
        evasion: Math.round(Number(eff.evasion ?? 50)),
        recon: Math.round(Number(eff.recon ?? 50)),
        aa: Math.round(Number(eff.aa ?? 40)),
        asw: Math.round(Number(eff.asw ?? 40)),
      },
      checkRatings: {
        firepower: Math.round(Number(eff.firepower ?? 50)),
        armor: Math.round(Number(eff.armor ?? 40)),
        torpedo: Math.round(Number(eff.torpedo ?? 45)),
        evasion: Math.round(Number(eff.evasion ?? 50)),
        recon: Math.round(Number(eff.recon ?? 50)),
        aa: Math.round(Number(eff.aa ?? 40)),
        asw: Math.round(Number(eff.asw ?? 40)),
      },
      members: char
        ? [
            {
              id: char.id,
              slotIndex: 0,
              name: char.name,
              shipType: char.meta?.shipType || '驱逐舰',
              classCode: resolveShipClass(char.meta?.shipType),
              isFlagship: true,
              alive: hp > 0,
              hp,
              maxHp,
              armor: Math.round(Number(eff.armor ?? 40)),
              firepower: Math.round(Number(eff.firepower ?? 50)),
              torpedo: Math.round(Number(eff.torpedo ?? 45)),
              evasion: Math.round(Number(eff.evasion ?? 50)),
              recon: Math.round(Number(eff.recon ?? 50)),
              aa: Math.round(Number(eff.aa ?? 40)),
              asw: Math.round(Number(eff.asw ?? 40)),
              morale: Math.round(Number(char.stats?.morale ?? 70)),
            },
          ]
        : [],
    };
  }

  getCurrentActor() {
    if (!this._session || this._session.status !== 'active') return null;
    const fleet = this._getFleetCombatContext(this._session);
    const queue = this._session.turnQueue || [];
    while (this._session.currentActorIndex < queue.length) {
      const slot = queue[this._session.currentActorIndex];
      const member = fleet.members.find((m) => m.id === slot.characterId && m.alive);
      if (member && !slot.acted) {
        return member;
      }
      this._session.currentActorIndex += 1;
    }
    return null;
  }

  getAvailableActionsForCurrentActor() {
    const actor = this.getCurrentActor();
    if (!actor || !this._session) return [];
    return getShipClassTacticalActions(actor.shipType, {
      includeUniversal: true,
      phase: this._session.phase,
    });
  }

  /**
   * Smart ship-class aware auto-delegate AI decision for the currently acting shipgirl.
   */
  pickAutoActionForActor(actor = null) {
    const session = this._session;
    const cur = actor || this.getCurrentActor();
    if (!session || !cur) return 'tactical_shelling';
    const cls = resolveShipClass(cur.shipType);
    const aliveEnemies = session.enemies.filter((e) => e.hp > 0);
    const hasSub = aliveEnemies.some((e) => e.role === 'sub' || e.subThreat > 0);
    const hasAirIntent = aliveEnemies.some((e) => e.nextIntent?.id === 'airstrike');
    const anyUnscanned = aliveEnemies.some((e) => !e.scanned);
    const fleet = this._getFleetCombatContext(session);
    const hasLowHpAlly = fleet.members.some((m) => m.alive && m.hp / Math.max(1, m.maxHp) < 0.55);

    if (cls === 'DD') {
      if (hasSub) return 'depth_asw';
      if (session.range === ENGAGEMENT_RANGES.LONG) return 'full_ahead';
      if (hasLowHpAlly && session.smokeTurns <= 0) return 'smoke_screen';
      return 'torpedo_strike';
    }
    if (cls === 'CL') {
      if (hasAirIntent && session.aaAlertTurns <= 0) return 'aa_alert';
      if (anyUnscanned && session.lockOnBonus <= 0) return 'radar_scan';
      if (session.range === ENGAGEMENT_RANGES.CLOSE || session.phase === 'night') return 'torpedo_strike';
      return 'tactical_shelling';
    }
    if (cls === 'CA') {
      if (hasLowHpAlly && session.guardTurns <= 0) return 'vanguard_guard';
      if (session.range === ENGAGEMENT_RANGES.LONG && session.phase === 'day' && session.round === 1) {
        return 'full_ahead';
      }
      return 'heavy_shelling';
    }
    if (cls === 'BB') {
      const target = aliveEnemies.find((e) => e.id === session.targetEnemyId) || aliveEnemies[0];
      if (target && target.suppressedTurns <= 0 && target.nextIntent?.id === 'salvo') {
        return 'fire_suppress';
      }
      return 'main_salvo';
    }
    if (cls === 'CV') {
      if (anyUnscanned && session.reconCritTurns <= 0 && session.round === 1) return 'carrier_recon';
      return 'carrier_airstrike';
    }
    return 'tactical_shelling';
  }

  /**
   * Transition from Day Battle prompt into Night Battle Pursuit!
   */
  enterNightBattle({ rng = Math.random } = {}) {
    if (!this._session || this._session.status !== 'night_prompt') {
      return { ok: false, reason: '当前不在昼夜战转换时机' };
    }
    const session = this._session;
    session.phase = 'night';
    session.status = 'active';
    session.round += 1;
    session.range = ENGAGEMENT_RANGES.CLOSE;
    for (const en of session.enemies) {
      if (en.hp > 0) {
        en.nextIntent = rollEnemyIntent(en, rng);
      }
    }
    this._buildTurnQueue(session);
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
   * Execute one shipgirl's exclusive tactical action in turn order.
   */
  async executeShipAction(actionId, { targetEnemyId = null, rng = Math.random } = {}) {
    if (!this._session || this._session.status !== 'active') {
      return { ok: false, reason: '当前没有可下达指令的战斗回合' };
    }
    const session = this._session;
    const actor = this.getCurrentActor();
    if (!actor) {
      return { ok: false, reason: '本回合所有舰娘已行动完毕' };
    }

    const actionDef = TACTICAL_ACTION_DEFS[actionId];
    if (!actionDef) {
      return { ok: false, reason: `未知战术指令：${actionId}` };
    }

    if (targetEnemyId) {
      this.setTargetEnemy(targetEnemyId);
    }

    const fleet = this._getFleetCombatContext(session);
    const aliveMembers = fleet.members.filter((m) => m.alive);
    const aliveEnemies = session.enemies.filter((e) => e.hp > 0);
    if (aliveEnemies.length === 0) {
      session.status = 'victory';
      return { ok: false, reason: '敌方编队已被全部击破' };
    }

    let targetEnemy =
      aliveEnemies.find((e) => e.id === session.targetEnemyId) || aliveEnemies[0];
    // Auto-prioritize submarine target for depth_asw if current target isn't a sub
    if (actionId === 'depth_asw' && targetEnemy.role !== 'sub' && targetEnemy.subThreat <= 0) {
      const subTarget = aliveEnemies.find((e) => e.role === 'sub' || e.subThreat > 0);
      if (subTarget) {
        targetEnemy = subTarget;
        session.targetEnemyId = subTarget.id;
      }
    }

    // 1. Spend per-action resource cost (discounted by Commander `dispatch`)
    const dispatchDisc = this._commander ? this._commander.getSortieStepDiscount() : 0;
    const costScale = Math.max(0.55, 1 - dispatchDisc);
    const costMap = {};
    if (actionDef.cost?.fuel > 0) costMap.fuel = Math.max(1, Math.round(actionDef.cost.fuel * costScale));
    if (actionDef.cost?.ammo > 0) costMap.ammo = Math.max(2, Math.round(actionDef.cost.ammo * costScale));
    if (Object.keys(costMap).length > 0) {
      const spend = await this._resources.spendBatch(costMap, {
        reason: `[${actor.name}] 战术指令「${actionDef.label}」`,
      });
      if (!spend.ok) {
        return { ok: false, reason: spend.reason };
      }
    }

    // 2. Perform 1D20 check using acting shipgirl's effective stat + Commander tactics/luck
    const seaMods = session.seaCondition?.mods || {};
    const cmdTactics = this._commander ? this._commander.getTacticsCheckBonus() : 0;
    const cmdLuckFx = this._commander ? this._commander.getLuckEffects() : { luck: 0, edgeCheckMod: 0 };
    const cmdLuck = cmdLuckFx.luck || 0;
    const eqBonus = this._inventory ? this._inventory.getCharacterEquipmentBonuses(actor.id).checkBonus : 0;
    const classProfile = getShipClassProfile(actor.shipType);
    const isNight = session.phase === 'night';

    let statVal = Number(actor[actionDef.statKey] ?? 50);
    let dc = session.enemy.shellingDc || 13;
    let extraMod = (seaMods.checkBonus || 0) + cmdTactics + session.lockOnBonus;

    if (actionId === 'radar_scan' || actionId === 'carrier_recon') {
      dc = (session.enemy.scanDc || 13) + (seaMods.scanDcDelta || 0);
      if (classProfile.code === 'CL') extraMod += classProfile.combat.scanCheckBonus || 2;
      if (classProfile.code === 'CV') extraMod += 2;
    } else if (actionId === 'evade_retreat' || actionId === 'full_ahead' || actionId === 'smoke_screen') {
      dc = session.enemy.evadeDc || 13;
      extraMod += (seaMods.evadeBonus || 0);
    } else if (actionId === 'torpedo_strike') {
      dc = session.enemy.torpedoDc || 14;
      extraMod += (cmdLuckFx.edgeCheckMod || 0) + (session.range === ENGAGEMENT_RANGES.CLOSE ? 3 : 0) + (isNight ? 3 : 0);
    } else if (actionId === 'depth_asw') {
      dc = 12;
      extraMod += targetEnemy.role === 'sub' || targetEnemy.subThreat > 0 ? 4 : 1;
    } else if (actionId === 'carrier_airstrike') {
      statVal = Math.round(actor.firepower * 0.65 + actor.recon * 0.55);
      dc = session.enemy.shellingDc || 13;
      extraMod += session.range === ENGAGEMENT_RANGES.LONG ? 2 : 0;
    }

    const checkResult = this._statRules.performCheck({
      actorId: actor.id,
      actorName: actor.name,
      statKey: actionDef.statKey,
      baseStatValue: statVal,
      effectiveStatValue: statVal,
      equipmentCheckBonus: eqBonus,
      moraleValue: actor.morale ?? 70,
      dc,
      extraModifier: extraMod,
      commanderLuck: cmdLuck,
      rng,
    });

    const isSuccess = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
    const isCritRoll = checkResult.outcome === 'crit-success';
    const critChanceBonus =
      (session.reconCritTurns > 0 ? 0.2 : 0) +
      (session.range === ENGAGEMENT_RANGES.CLOSE && actionId === 'torpedo_strike' ? 0.15 : 0) +
      (isNight && (actionId === 'torpedo_strike' || actionId === 'heavy_shelling' || actionId === 'tactical_shelling') ? 0.25 : 0) +
      (fleet.formationMods?.critBonus || 0);
    const isCrit = isCritRoll || (isSuccess && rng() < critChanceBonus);

    // 3. Resolve action effect!
    let damageDealt = 0;
    let outcomeTag = 'action';
    const extraEvents = [];
    let rangeChangedTo = null;
    let scannedNow = false;
    const seaDmgMult = seaMods.dmgMult || 1.0;

    // Range & Night multipliers
    const calcRangeMult = () => {
      if (actionId === 'main_salvo' || actionId === 'carrier_airstrike' || actionId === 'fire_suppress') {
        return session.range === ENGAGEMENT_RANGES.LONG ? 1.15 : session.range === ENGAGEMENT_RANGES.MEDIUM ? 1.05 : 0.9;
      }
      if (actionId === 'torpedo_strike' || actionId === 'depth_asw') {
        return session.range === ENGAGEMENT_RANGES.CLOSE ? 1.3 : session.range === ENGAGEMENT_RANGES.MEDIUM ? 1.0 : 0.75;
      }
      return session.range === ENGAGEMENT_RANGES.MEDIUM ? 1.08 : 1.0;
    };

    const nightDmgMult =
      isNight && actionId === 'torpedo_strike'
        ? 1.45
        : isNight && (actionId === 'tactical_shelling' || actionId === 'heavy_shelling' || actionId === 'main_salvo')
        ? 1.25
        : isNight && actionId === 'carrier_airstrike'
        ? 0.82
        : 1.0;

    if (actionId === 'radar_scan' || actionId === 'carrier_recon') {
      scannedNow = true;
      for (const en of session.enemies) {
        if (actionId === 'carrier_recon' || en.id === targetEnemy.id || isCrit) {
          en.scanned = true;
        }
      }
      session.lockOnBonus = Math.min(6, session.lockOnBonus + (isCrit ? 4 : 3));
      if (actionId === 'carrier_recon') {
        session.reconCritTurns = Math.max(session.reconCritTurns, 2);
        extraEvents.push('全队暴击率 +20%（2回合）');
      }
      outcomeTag = 'scan-ok';
      this._emit('combat:scan', { label: actionId === 'carrier_recon' ? '舰载侦察 · 全域揭露' : '雷达锁定 +3' });
      extraEvents.push(`敌方护甲/弱点/意图已揭露 · 全队锁定 +${session.lockOnBonus}`);
    } else if (actionId === 'smoke_screen') {
      session.smokeTurns = Math.max(session.smokeTurns, isCrit ? 3 : 2);
      outcomeTag = 'buff-smoke';
      extraEvents.push(`全队烟幕屏障生效（${session.smokeTurns}回合 · 敌方伤害 -38%）`);
      this._emit('fx:play', { type: 'float-text', payload: { text: '烟幕展开 · 全队闪避UP', tone: 'ok' } });
    } else if (actionId === 'aa_alert') {
      session.aaAlertTurns = Math.max(session.aaAlertTurns, isCrit ? 3 : 2);
      outcomeTag = 'buff-aa';
      extraEvents.push(`全队防空警戒开启（${session.aaAlertTurns}回合 · 敌方空袭削减 60%）`);
      this._emit('fx:play', { type: 'float-text', payload: { text: '防空警戒就绪', tone: 'ok' } });
    } else if (actionId === 'vanguard_guard') {
      session.guardActorId = actor.id;
      session.guardTurns = Math.max(session.guardTurns, isCrit ? 3 : 2);
      outcomeTag = 'buff-guard';
      extraEvents.push(`「${actor.name}」进入前排援护（${session.guardTurns}回合 · 为残血队友分担 60% 伤害）`);
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
            ? 'BOSS 封锁无法撤离，转为规避机动（2回合减伤 30%）'
            : '脱离未完全甩开敌舰，已获得 2 回合机动减伤'
        );
      }
    } else {
      // Attack commands: torpedo_strike, depth_asw, tactical_shelling, heavy_shelling, main_salvo, fire_suppress, carrier_airstrike
      const effectiveArmor = Math.max(0, targetEnemy.armor + (targetEnemy.armorBraceBonus || 0));
      let armorPen = 0.15;
      let basePower = statVal * 0.62;
      let critMult = 1.6;
      let weakBonus = 1.0;

      if (actionId === 'torpedo_strike') {
        armorPen = classProfile.code === 'DD' ? 0.6 : 0.45;
        basePower = actor.torpedo * 0.72 + (session.lockOnBonus * 2.5);
        critMult = classProfile.code === 'DD' ? 2.05 : 1.75;
        if (targetEnemy.weakness === 'torpedo') weakBonus = 1.3;
      } else if (actionId === 'depth_asw') {
        armorPen = 0.8;
        basePower = actor.asw * 0.7;
        const isSub = targetEnemy.role === 'sub' || targetEnemy.subThreat > 0;
        weakBonus = isSub ? (classProfile.code === 'DD' ? 2.1 : 1.75) : 0.75;
        if (isSub) extraEvents.push('深水炸弹命中潜艇弱点，造成巨额反潜克制！');
      } else if (actionId === 'main_salvo') {
        armorPen = 0.5;
        basePower = actor.firepower * 0.76;
        critMult = 1.85;
        if (targetEnemy.weakness === 'shelling') weakBonus = 1.25;
      } else if (actionId === 'fire_suppress') {
        armorPen = 0.35;
        basePower = actor.firepower * 0.58;
        targetEnemy.suppressedTurns = Math.max(targetEnemy.suppressedTurns, 2);
        extraEvents.push(`「${targetEnemy.name}」陷入火力压制（2回合攻击与命中 -35%）`);
      } else if (actionId === 'heavy_shelling') {
        armorPen = 0.32;
        basePower = actor.firepower * 0.68;
        if (targetEnemy.weakness === 'shelling') weakBonus = 1.25;
      } else if (actionId === 'tactical_shelling') {
        armorPen = 0.22;
        basePower = actor.firepower * 0.6;
        if (targetEnemy.weakness === 'shelling') weakBonus = 1.2;
      } else if (actionId === 'carrier_airstrike') {
        armorPen = 0.92; // ignores frontline hull armor, mitigated by enemy AA/airThreat instead
        basePower = (actor.firepower * 0.55 + actor.recon * 0.55) * 0.86;
        const enemyAaMit = clamp(1 - (targetEnemy.airThreat || 0) * 0.012, 0.58, 1.0);
        basePower *= enemyAaMit;
        if (targetEnemy.weakness === 'aa') weakBonus = 1.3;
      }

      const mitigatedArmor = effectiveArmor * (1 - armorPen);
      const rollFactor = isSuccess ? 1.05 : 0.68;
      let rawDmg = (basePower - mitigatedArmor) * rollFactor * calcRangeMult() * nightDmgMult * weakBonus * seaDmgMult;
      if (isCrit) rawDmg *= critMult;
      damageDealt = Math.max(8, Math.round(rawDmg));

      targetEnemy.hp = Math.max(0, targetEnemy.hp - damageDealt);
      outcomeTag = isCrit ? 'attack-crit' : isSuccess ? 'attack-hit' : 'attack-graze';

      if (targetEnemy.hp <= 0) {
        extraEvents.push(`击沉「${targetEnemy.name}」！`);
      }

      this._emit('combat:enemy-hit', {
        damage: damageDealt,
        crit: isCrit,
        weapon: actionDef.visualStyle,
        targetId: targetEnemy.id,
      });
    }

    // Mark current actor as acted
    const curSlot = session.turnQueue[session.currentActorIndex];
    if (curSlot) {
      curSlot.acted = true;
      curSlot.actionLabel = actionDef.shortLabel;
    }
    session.currentActorIndex += 1;

    // 4. Check victory before enemy counter-attack
    this._syncAggregateEnemy(session);
    const remainingEnemies = session.enemies.filter((e) => e.hp > 0);
    let roundCompleted = false;
    let enteredNightPrompt = false;
    const enemyCounterEvents = [];
    let totalDamageTaken = 0;

    if (session.status === 'active' && remainingEnemies.length === 0) {
      session.status = 'victory';
      outcomeTag = 'victory';
    } else if (session.status === 'active') {
      // Check if all alive ships in turnQueue have acted -> trigger Enemy Counterattack Phase!
      const nextActor = this.getCurrentActor();
      if (!nextActor) {
        roundCompleted = true;
        const freshFleet = this._getFleetCombatContext(session);
        const livingAllies = freshFleet.members.filter((m) => m.alive);

        for (const en of remainingEnemies) {
          if (livingAllies.length === 0) break;
          const intent = en.nextIntent || ENEMY_INTENTS.salvo;
          en.armorBraceBonus = 0;

          if (intent.id === 'brace_armor') {
            en.armorBraceBonus = 4;
            enemyCounterEvents.push({
              enemyId: en.id,
              enemyName: en.name,
              intentLabel: intent.label,
              damage: 0,
              text: `「${en.name}」强化舰体装甲（护甲 +4）并积蓄火力`,
            });
          } else {
            // Pick target ally
            let targetAlly =
              intent.id === 'focus_fire'
                ? [...livingAllies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]
                : livingAllies[Math.floor(rng() * livingAllies.length)];

            // Check CA vanguard_guard interception
            let guardedBy = null;
            if (session.guardTurns > 0 && session.guardActorId && targetAlly.id !== session.guardActorId) {
              const guardian = livingAllies.find((m) => m.id === session.guardActorId);
              if (guardian && guardian.hp > 5) {
                guardedBy = guardian;
              }
            }

            let rawAtk = en.attackPower * (intent.id === 'salvo' ? 1.15 : 1.0);
            if (en.suppressedTurns > 0) rawAtk *= 0.65;
            if (session.smokeTurns > 0) rawAtk *= 0.62;
            if (session.evasionBuffTurns > 0) rawAtk *= 0.72;
            if (intent.id === 'airstrike') {
              if (session.aaAlertTurns > 0) rawAtk *= 0.4;
              const fleetAaScale = clamp(1 - (freshFleet.effective?.aa || 40) * 0.0025, 0.55, 1.0);
              rawAtk *= fleetAaScale;
            }
            if (intent.id === 'torpedo_ambush') {
              const fleetAswScale = clamp(1 - (freshFleet.effective?.asw || 40) * 0.0025, 0.55, 1.0);
              rawAtk *= fleetAswScale;
            }

            const armorMit = clamp(1 - (targetAlly.armor || 30) * 0.0045, 0.55, 0.95);
            let dmg = Math.max(3, Math.round(rawAtk * armorMit));

            if (guardedBy) {
              const sharedDmg = Math.max(2, Math.round(dmg * 0.55));
              const residualDmg = Math.max(1, Math.round(dmg * 0.2));
              this._entities.adjustStat(guardedBy.id, 'hp', -sharedDmg, { min: 0, max: guardedBy.maxHp });
              this._entities.adjustStat(targetAlly.id, 'hp', -residualDmg, { min: 0, max: targetAlly.maxHp });
              totalDamageTaken += sharedDmg + residualDmg;
              enemyCounterEvents.push({
                enemyId: en.id,
                enemyName: en.name,
                intentLabel: intent.label,
                targetId: targetAlly.id,
                targetName: targetAlly.name,
                guardedBy: guardedBy.name,
                damage: sharedDmg + residualDmg,
                text: `「${en.name}」发动【${intent.label}】→「${guardedBy.name}」前排援护挡下主力伤害（援护 -${sharedDmg} / ${targetAlly.name} -${residualDmg}）`,
              });
            } else {
              this._entities.adjustStat(targetAlly.id, 'hp', -dmg, { min: 0, max: targetAlly.maxHp });
              totalDamageTaken += dmg;
              enemyCounterEvents.push({
                enemyId: en.id,
                enemyName: en.name,
                intentLabel: intent.label,
                targetId: targetAlly.id,
                targetName: targetAlly.name,
                damage: dmg,
                text: `「${en.name}」发动【${intent.label}】命中「${targetAlly.name}」，造成 ${dmg} 点伤害`,
              });
            }
          }

          if (en.suppressedTurns > 0) en.suppressedTurns -= 1;
          en.nextIntent = rollEnemyIntent(en, rng);
        }

        if (totalDamageTaken > 0) {
          this._emit('combat:hit', { damage: totalDamageTaken, heavy: totalDamageTaken >= 18 });
        }

        // Decrement fleet round buffs
        if (session.smokeTurns > 0) session.smokeTurns -= 1;
        if (session.aaAlertTurns > 0) session.aaAlertTurns -= 1;
        if (session.evasionBuffTurns > 0) session.evasionBuffTurns -= 1;
        if (session.reconCritTurns > 0) session.reconCritTurns -= 1;
        if (session.guardTurns > 0) {
          session.guardTurns -= 1;
          if (session.guardTurns === 0) session.guardActorId = null;
        }
        session.autoDelegateRound = false;

        // Check player fleet defeat
        const postFleet = this._getFleetCombatContext(session);
        if (postFleet.aliveCount <= 0) {
          session.status = 'defeated';
        } else if (session.phase === 'day' && session.round >= session.dayMaxRounds) {
          // Day Battle completed with surviving enemies -> Day/Night Transition Prompt!
          session.status = 'night_prompt';
          enteredNightPrompt = true;
        } else if (session.phase === 'night' && session.round >= session.dayMaxRounds + session.nightMaxRounds) {
          session.status = 'day_ended';
        } else {
          session.round += 1;
          this._buildTurnQueue(session);
        }
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
    const actorSpeech = typeof actorSpeechRes === 'string' ? actorSpeechRes : (actorSpeechRes?.speech || '');

    const extraSummary = extraEvents.length ? ` ${extraEvents.join('；')}。` : '';
    const counterSummary = enemyCounterEvents.length
      ? ` 【敌方反击】${enemyCounterEvents.map((e) => e.text).join('；')}。`
      : '';

    let localTemplate = '';
    if (damageDealt > 0) {
      localTemplate = `${actorSpeech ? `${actorSpeech} ` : ''}[${classProfile.code}]${actor.name} 对「${targetEnemy.name}」执行【${actionDef.label}】（${RANGE_META[session.range]?.label || ''} · ${checkResult.total} vs DC ${checkResult.dc}），造成 ${damageDealt} 点${isCrit ? '暴击' : ''}伤害！${extraSummary}${counterSummary}`;
    } else {
      localTemplate = `${actorSpeech ? `${actorSpeech} ` : ''}[${classProfile.code}]${actor.name} 执行【${actionDef.label}】（${checkResult.total} vs DC ${checkResult.dc}）。${extraSummary}${counterSummary}`;
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
      commandId: actionId,
      commandLabel: actionDef.label,
      visualStyle: actionDef.visualStyle,
      actorId: actor.id,
      actorName: actor.name,
      actorClass: classProfile.code,
      targetEnemyId: targetEnemy.id,
      targetEnemyName: targetEnemy.name,
      outcomeTag,
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      damageDealt,
      damageTaken: totalDamageTaken,
      isCrit,
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
    if (session.turnsLog.length > 30) session.turnsLog.length = 30;
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
   * Backward-compatible wrapper mapping legacy 4 command IDs ('scan'|'evade'|'shelling'|'torpedo')
   * to the currently acting shipgirl's turn action.
   */
  async executeCommand(commandId, { rng = Math.random } = {}) {
    if (TACTICAL_ACTION_DEFS[commandId]) {
      return this.executeShipAction(commandId, { rng });
    }
    const actor = this.getCurrentActor();
    const cls = actor ? resolveShipClass(actor.shipType) : 'CL';
    if (commandId === 'scan') {
      return this.executeShipAction(cls === 'CV' ? 'carrier_recon' : 'radar_scan', { rng });
    }
    if (commandId === 'evade') {
      return this.executeShipAction('evade_retreat', { rng });
    }
    if (commandId === 'torpedo') {
      return this.executeShipAction('torpedo_strike', { rng });
    }
    // shelling
    const mapped =
      cls === 'CV'
        ? 'carrier_airstrike'
        : cls === 'BB'
        ? 'main_salvo'
        : cls === 'CA'
        ? 'heavy_shelling'
        : 'tactical_shelling';
    return this.executeShipAction(mapped, { rng });
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
    // Lossless upgrade for any pre-v14 saved combat session
    if (!Array.isArray(s.enemies) || s.enemies.length === 0) {
      const en = s.enemy || { name: '残存敌舰', hp: 50, maxHp: 50, armor: 4, attackPower: 10 };
      s.enemies = [
        {
          id: 'en_1',
          name: en.name,
          role: 'flagship',
          tier: en.tier || 'encounter',
          hp: en.hp ?? 50,
          maxHp: en.maxHp ?? 50,
          armor: en.armor ?? 4,
          attackPower: en.attackPower ?? 10,
          airThreat: en.airThreat ?? 0,
          subThreat: en.subThreat ?? 0,
          weakness: en.weakness || 'shelling',
          weaknessLabel: en.weaknessLabel || '炮击弱点',
          threatLabel: en.threatLabel || '水面编队',
          scanned: Boolean(en.scanned),
          suppressedTurns: 0,
          armorBraceBonus: 0,
          nextIntent: { ...ENEMY_INTENTS.salvo },
        },
      ];
    }
    if (!s.range) s.range = ENGAGEMENT_RANGES.LONG;
    if (!s.phase) s.phase = 'day';
    if (!s.round) s.round = 1;
    if (!s.dayMaxRounds) s.dayMaxRounds = 2;
    if (!s.nightMaxRounds) s.nightMaxRounds = 2;
    this._session = s;
    this._syncAggregateEnemy(this._session);
    if (!Array.isArray(this._session.turnQueue) || this._session.turnQueue.length === 0) {
      this._buildTurnQueue(this._session);
    }
  }
}
