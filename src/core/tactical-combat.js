/**
 * Multi-Ship Fleet & Multi-Command Tactical Combat Engine (`tactical-combat.js`).
 *
 * Upgraded to integrate 3~12 ship formations, Naval 8-Stat template, Aerial/Submarine threats,
 * and Commander combat/bond stats:
 *   1. scan     (扫描): Full-fleet `recon` + Commander `tactics` + `luck` -> reveals enemy HP, armor,
 *                       airThreat, subThreat, weakness, and grants Lock-On bonus.
 *   2. evade    (迂回): Extra fuel + Full-fleet `evasion` + Commander `tactics` -> bypass non-boss cleanly
 *                       or gain 2-turn evasion buff vs Boss.
 *   3. shelling (炮击): Standard ammo + Full-fleet `firepower` (plus ASW depth-charge / AA bonus vs sub/air threats).
 *   4. torpedo  (鱼雷): High ammo + Full-fleet `torpedo` + Commander `luck` + Lock-On -> massive burst/crit.
 *
 * Fleet Coordination & Defense Mechanics:
 *   - Enemy `airThreat` is intercepted by full-fleet `aa` (防空)
 *   - Enemy `subThreat` is suppressed by full-fleet `asw` (反潜), granting bonus depth-charge damage & reducing ambush damage
 *   - Commander `affinity` + formation guard bonus triggers:
 *       * Wingman Follow-up Strike (僚机协同补刀)
 *       * Wingman Guard / Cover (僚机援护挡伤)
 *   - Emits EventBus hooks for FxStage animations (`fx:play`, `combat:scan`, `combat:hit`, `combat:enemy-hit`).
 */

import { clamp } from './calc-engine.js';

export const COMBAT_COMMANDS = Object.freeze({
  SCAN: {
    id: 'scan',
    label: '扫描',
    sublabel: '全队侦查+指挥官战术 · 揭露弱点/威胁 + 锁定',
    statKey: 'recon',
    cost: { fuel: 5, ammo: 0 },
  },
  EVADE: {
    id: 'evade',
    label: '迂回',
    sublabel: '全队机动+指挥官战术 · 油-20 绕过/闪避',
    statKey: 'evasion',
    cost: { fuel: 20, ammo: 0 },
  },
  SHELLING: {
    id: 'shelling',
    label: '炮击',
    sublabel: '全队火力+防空/反潜 · 弹-15 稳定齐射',
    statKey: 'firepower',
    cost: { fuel: 0, ammo: 15 },
  },
  TORPEDO: {
    id: 'torpedo',
    label: '鱼雷',
    sublabel: '全队雷击+运气 · 弹-30 高爆高风险',
    statKey: 'torpedo',
    cost: { fuel: 0, ammo: 30 },
  },
});

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

export class TacticalCombatEngine {
  /**
   * @param {{
   *   entities: import('./entity-system.js').EntitySystem,
   *   inventory: import('./inventory-system.js').InventorySystem,
   *   statRules: import('./stat-rules.js').StatRulesEngine,
   *   resources: import('./resource-manager.js').ResourceManager,
   *   narrative: import('./prompt-pipeline.js').PromptPipeline,
   *   commander?: import('./commander-system.js').CommanderSystem | null,
   *   formation?: import('./formation-system.js').FormationSystem | null,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({ entities, inventory, statRules, resources, narrative, commander = null, formation = null, bus = null }) {
    this._entities = entities;
    this._inventory = inventory;
    this._statRules = statRules;
    this._resources = resources;
    this._narrative = narrative;
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
    return Boolean(this._session && this._session.status === 'active');
  }

  getSession() {
    return this._session ? deepClone(this._session) : null;
  }

  clearSession() {
    this._session = null;
  }

  /**
   * Initialize a new tactical combat engagement for a full fleet (or fallback single character).
   */
  startEncounter({ characterId = null, fleetMemberIds = null, formationId = null, node, seaCondition = null }) {
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

    // Scale enemy HP modestly with fleet size so 3..12 fleets feel impactful without trivializing bosses
    const fleetSize = Math.max(1, memberIds.length);
    const fleetScale = 1 + Math.max(0, fleetSize - 1) * 0.28;

    const baseTpl = node.enemyTemplate || {
      name: node.name || '未知敌方单位',
      tier: node.type || 'encounter',
      forcedEngagement: node.type === 'boss',
      hp: 65,
      maxHp: 65,
      armor: 5,
      attackPower: 12,
      airThreat: 0,
      subThreat: 0,
      threatLabel: '常规水面编队',
      scanDc: 13,
      evadeDc: 13,
      shellingDc: 13,
      torpedoDc: 15,
      weakness: 'shelling',
      weaknessLabel: '炮击弱点',
    };

    const scaledMaxHp = Math.round(Number(baseTpl.maxHp ?? baseTpl.hp ?? 65) * fleetScale);

    this._session = {
      id: `cmb_${Date.now().toString(36)}`,
      characterId: flagshipId,
      fleetMemberIds: memberIds,
      formationId: activeFormationId,
      nodeCode: node.code || 'A',
      nodeName: node.name || baseTpl.name,
      seaCondition: seaCondition ? deepClone(seaCondition) : null,
      turn: 1,
      status: 'active', // 'active' | 'victory' | 'bypassed' | 'defeated'
      lockOnBonus: 0,
      evasionBuffTurns: 0,
      enemy: {
        ...deepClone(baseTpl),
        hp: scaledMaxHp,
        maxHp: scaledMaxHp,
        airThreat: Number(baseTpl.airThreat ?? 0),
        subThreat: Number(baseTpl.subThreat ?? 0),
        threatLabel: baseTpl.threatLabel || '常规水面编队',
        scanned: false,
      },
      turnsLog: [],
    };

    this._emit('combat:started', {
      sessionId: this._session.id,
      characterId: flagshipId,
      fleetMemberIds: memberIds,
      enemyName: this._session.enemy.name,
      forcedEngagement: this._session.enemy.forcedEngagement,
    });
    return this.getSession();
  }

  _getFleetCombatContext(session) {
    if (this._formation) {
      return this._formation.computeFleetSummary(session.fleetMemberIds, session.formationId);
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
              name: char.name,
              shipType: char.meta?.shipType || '通用舰',
              isFlagship: true,
              alive: hp > 0,
              hp,
              maxHp,
              armor: Math.round(Number(eff.armor ?? 40)),
              firepower: Math.round(Number(eff.firepower ?? 50)),
              torpedo: Math.round(Number(eff.torpedo ?? 45)),
            },
          ]
        : [],
    };
  }

  /**
   * Execute one of the 4 tactical commands: 'scan' | 'evade' | 'shelling' | 'torpedo'.
   */
  async executeCommand(commandId, { rng = Math.random } = {}) {
    if (!this.isActive()) {
      return { ok: false, reason: '当前没有进行中的战术交战' };
    }
    const cmdDef = Object.values(COMBAT_COMMANDS).find((c) => c.id === commandId);
    if (!cmdDef) {
      return { ok: false, reason: `未知战术指令：${commandId}` };
    }

    const session = this._session;
    const fleet = this._getFleetCombatContext(session);
    const aliveMembers = fleet.members.filter((m) => m.alive);
    if (aliveMembers.length === 0) {
      session.status = 'defeated';
      return { ok: false, reason: '编队全员失去战斗力，请返航回港区修复' };
    }

    const flagship = aliveMembers[0];
    const fleetLabel =
      aliveMembers.length > 1 ? `${flagship.name}率领的 ${aliveMembers.length} 舰编队` : flagship.name;

    // 1. Spend command resource cost (slightly discounted by Commander `dispatch`)
    const dispatchDisc = this._commander ? this._commander.getSortieStepDiscount() : 0;
    const costScale = Math.max(0.6, 1 - dispatchDisc);
    const costMap = {};
    if (cmdDef.cost.fuel > 0) costMap.fuel = Math.max(2, Math.round(cmdDef.cost.fuel * costScale));
    if (cmdDef.cost.ammo > 0) costMap.ammo = Math.max(5, Math.round(cmdDef.cost.ammo * costScale));
    if (Object.keys(costMap).length > 0) {
      const spend = await this._resources.spendBatch(costMap, {
        reason: `战术指令「${cmdDef.label}」`,
      });
      if (!spend.ok) {
        return { ok: false, reason: spend.reason };
      }
    }

    const seaMods = session.seaCondition?.mods || {
      checkBonus: 0,
      scanDcDelta: 0,
      evadeBonus: 0,
      dmgMult: 1.0,
    };

    const cmdTacticsBonus = this._commander ? this._commander.getTacticsCheckBonus() : 0;
    const cmdLuck = this._commander ? this._commander.getLuck() : 0;
    const wingmanBaseChance = this._commander ? this._commander.getWingmanAssistChance() : 0.15;
    const guardChance = clamp(wingmanBaseChance + (fleet.formationMods?.guardBonus || 0), 0.1, 0.75);
    const followUpChance = clamp(wingmanBaseChance + (fleet.formationMods?.critBonus || 0), 0.1, 0.7);

    const enemy = session.enemy;
    const chips = [];
    if (costMap.fuel) chips.push({ text: `燃油 -${costMap.fuel}`, negative: true });
    if (costMap.ammo) chips.push({ text: `弹药 -${costMap.ammo}`, negative: true });

    let checkResult = null;
    let damageDealt = 0;
    let damageTaken = 0;
    let isCrit = false;
    let localTemplate = '';
    let outcomeTag = '';
    const extraEvents = [];

    // Helper: Enemy Counterattack with AA interception, ASW suppression, Armor mitigation & Wingman Guard
    const runEnemyCounter = (mult = 1.0) => {
      const currentAlive = this._getFleetCombatContext(session).members.filter((m) => m.alive);
      if (currentAlive.length === 0) {
        session.status = 'defeated';
        return 0;
      }

      const evadeMult = session.evasionBuffTurns > 0 ? 0.5 : 1.0;
      let rawThreatDmg = enemy.attackPower * mult * evadeMult;

      // Air Threat vs Fleet AA (防空拦截)
      if (enemy.airThreat > 0) {
        const aaMitigation = clamp(fleet.effective.aa / (fleet.effective.aa + enemy.airThreat * 4.5), 0.15, 0.85);
        const airDmg = Math.max(0, Math.round(enemy.airThreat * 0.65 * (1 - aaMitigation)));
        const blocked = Math.max(1, Math.round(enemy.airThreat * 0.65 * aaMitigation));
        rawThreatDmg += airDmg;
        chips.push({ text: `防空拦截 -${blocked} 空袭伤`, negative: false });
      }

      // Submarine Threat vs Fleet ASW (反潜压制)
      if (enemy.subThreat > 0) {
        const aswMitigation = clamp(fleet.effective.asw / (fleet.effective.asw + enemy.subThreat * 4.5), 0.15, 0.85);
        const subDmg = Math.max(0, Math.round(enemy.subThreat * 0.6 * (1 - aswMitigation)));
        const suppressed = Math.max(1, Math.round(enemy.subThreat * 0.6 * aswMitigation));
        rawThreatDmg += subDmg;
        chips.push({ text: `反潜警戒 -${suppressed} 潜袭伤`, negative: false });
      }

      // Target selection (flagship or random alive member)
      let target = currentAlive[Math.floor(rng() * currentAlive.length)];
      let guardedBy = null;

      // Wingman Cover / Guard (僚机援护挡伤) triggered by Commander `affinity` + formation guardBonus
      if (currentAlive.length >= 2) {
        const protectors = currentAlive.filter((m) => m.id !== target.id && m.hp / m.maxHp > 0.35);
        if (protectors.length > 0 && rng() < guardChance) {
          guardedBy = protectors[Math.floor(rng() * protectors.length)];
          rawThreatDmg *= 0.52;
          target = guardedBy;
          chips.push({ text: `僚机援护：${guardedBy.name} 挡伤减半`, negative: false });
          extraEvents.push(`僚机「${guardedBy.name}」果断前出援护挡伤`);
          this._emit('fx:play', {
            type: 'float-text',
            payload: { text: `援护挡伤 · ${guardedBy.name}`, tone: 'ok' },
          });
        }
      }

      // Armor damage mitigation
      const armorReduction = clamp(target.armor * 0.16, 0, rawThreatDmg * 0.55);
      const finalDmg = Math.max(2, Math.round(rawThreatDmg - armorReduction));

      const entity = this._entities.get(target.id);
      const effMaxHp = Math.max(1, Math.round(this._entities.getEffectiveStat(target.id, 'maxHp', { round: 'round' }).final));
      const beforeHp = Number(entity.stats.hp ?? effMaxHp);
      const afterHp = this._entities.adjustStat(target.id, 'hp', -finalDmg, { min: 0, max: effMaxHp });
      const actual = Math.max(0, Math.round(beforeHp - afterHp));

      if (actual > 0) {
        chips.push({ text: `${target.name} 受击 -${actual} HP`, negative: true });
        this._emit('combat:enemy-hit', { characterId: target.id, damage: actual });
      }
      if (session.evasionBuffTurns > 0) {
        session.evasionBuffTurns = Math.max(0, session.evasionBuffTurns - 1);
      }

      // Check if all fleet members fell
      const remainingAlive = this._getFleetCombatContext(session).members.filter((m) => m.alive);
      if (remainingAlive.length === 0) {
        session.status = 'defeated';
      }
      return actual;
    };

    // Helper: Wingman Coordinated Follow-up Strike (僚机协同补刀)
    const tryWingmanFollowUp = (baseStrikeDmg, attackKind) => {
      const wingmen = aliveMembers.filter((m) => !m.isFlagship);
      if (wingmen.length === 0 || enemy.hp <= 0) return 0;
      if (rng() >= followUpChance) return 0;

      const wingman = wingmen[Math.floor(rng() * wingmen.length)];
      const statContribution = attackKind === 'torpedo' ? wingman.torpedo * 0.32 : wingman.firepower * 0.3;
      const bonusDmg = Math.max(6, Math.round(baseStrikeDmg * 0.3 + statContribution));
      enemy.hp = Math.max(0, enemy.hp - bonusDmg);
      chips.push({ text: `协同补刀：${wingman.name} -${bonusDmg}`, negative: false });
      extraEvents.push(`僚机「${wingman.name}」协同补刀追加 ${bonusDmg} 伤害`);
      this._emit('fx:play', {
        type: 'float-text',
        payload: { text: `协同补刀 ${wingman.name} -${bonusDmg}`, tone: 'accent' },
      });
      return bonusDmg;
    };

    // Helper: Active AA/ASW bonus strike when engaging air/sub threat enemies
    const computeCounterThreatBonus = () => {
      let bonus = 0;
      if (enemy.subThreat > 0 && fleet.effective.asw > 0) {
        const aswDmg = Math.max(4, Math.round(fleet.effective.asw * 0.14));
        bonus += aswDmg;
        chips.push({ text: `反潜深弹 +${aswDmg}`, negative: false });
      }
      if (enemy.airThreat > 0 && fleet.effective.aa > 0) {
        const aaDmg = Math.max(3, Math.round(fleet.effective.aa * 0.1));
        bonus += aaDmg;
        chips.push({ text: `防空击落加成 +${aaDmg}`, negative: false });
      }
      return bonus;
    };

    // 2. Command Resolution
    if (commandId === 'scan') {
      const baseRecon = Math.round(fleet.totals?.recon / Math.max(1, fleet.aliveCount) || fleet.checkRatings.recon);
      const effRecon = fleet.checkRatings.recon;
      const dc = Math.max(8, enemy.scanDc + (seaMods.scanDcDelta || 0));

      checkResult = this._statRules.performCheck({
        actorId: flagship.id,
        actorName: fleetLabel,
        statKey: 'recon',
        baseStatValue: baseRecon,
        effectiveStatValue: effRecon,
        equipmentCheckBonus: fleet.avgCheckBonus,
        moraleValue: fleet.avgMorale,
        dc,
        extraModifier: (seaMods.checkBonus || 0) + cmdTacticsBonus,
        commanderLuck: cmdLuck,
        rng,
      });

      const ok = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
      this._emit('combat:scan', { success: ok, enemyName: enemy.name });

      if (ok) {
        enemy.scanned = true;
        const lockVal = checkResult.outcome === 'crit-success' ? 4 : 3;
        session.lockOnBonus = Math.max(session.lockOnBonus, lockVal);
        outcomeTag = `锁定成功 (+${session.lockOnBonus})`;
        chips.push({ text: `弱点：${enemy.weaknessLabel}`, negative: false });
        chips.push({ text: `威胁：${enemy.threatLabel}`, negative: false });
        chips.push({ text: `锁定增益 +${session.lockOnBonus}`, negative: false });
        localTemplate =
          '{actor.name}（{formation}）执行【扫描】成功（{check.total} vs DC {check.dc}），揭露「{enemy.name}」耐久 {enemy.hp}/{enemy.maxHp}、护甲 {enemy.armor}、威胁【{enemy.threatLabel}】与弱点【{enemy.weaknessLabel}】，全队获得锁定 +{lockOnBonus}！';
      } else {
        outcomeTag = '扫描受干扰';
        damageTaken = runEnemyCounter(0.55);
        localTemplate =
          '{actor.name}尝试【扫描】遭遇干扰（{check.total} vs DC {check.dc}），未能获取完整数据，遭敌方试探射击损失 {damageTaken} HP。';
      }
    } else if (commandId === 'evade') {
      const baseEva = Math.round(fleet.totals?.evasion / Math.max(1, fleet.aliveCount) || fleet.checkRatings.evasion);
      const effEva = fleet.checkRatings.evasion;
      const dc = Math.max(8, enemy.evadeDc);

      checkResult = this._statRules.performCheck({
        actorId: flagship.id,
        actorName: fleetLabel,
        statKey: 'evasion',
        baseStatValue: baseEva,
        effectiveStatValue: effEva,
        equipmentCheckBonus: fleet.avgCheckBonus,
        moraleValue: fleet.avgMorale,
        dc,
        extraModifier: (seaMods.checkBonus || 0) + (seaMods.evadeBonus || 0) + cmdTacticsBonus,
        commanderLuck: cmdLuck,
        rng,
      });

      const ok = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
      if (ok && !enemy.forcedEngagement) {
        session.status = 'bypassed';
        outcomeTag = '全队无伤迂回';
        chips.push({ text: '全队绕过敌群', negative: false });
        localTemplate =
          '{actor.name}在「{formation}」下全速执行【迂回】机动（{check.total} vs DC {check.dc}），成功从侧翼无伤绕过「{enemy.name}」！';
      } else if (ok && enemy.forcedEngagement) {
        session.evasionBuffTurns = 2;
        outcomeTag = '全队先手闪避';
        chips.push({ text: '闪避减伤 50% (2回合)', negative: false });
        localTemplate =
          '面对强制决战目标「{enemy.name}」，{actor.name}【迂回】占据有利航向（{check.total} vs DC {check.dc}），全队获得 2 回合闪避增益（受击减半）！';
      } else {
        outcomeTag = '迂回被截击';
        damageTaken = runEnemyCounter(1.0);
        for (const m of aliveMembers) {
          this._entities.adjustStat(m.id, 'morale', -4, { min: 0, max: 100 });
        }
        chips.push({ text: '全队士气 -4', negative: true });
        localTemplate =
          '{actor.name}【迂回】机动被「{enemy.name}」截击（{check.total} vs DC {check.dc}），编队承受 -{damageTaken} HP 损伤！';
      }
    } else if (commandId === 'shelling') {
      const baseFp = Math.round(fleet.totals?.firepower / Math.max(1, fleet.aliveCount) || fleet.checkRatings.firepower);
      const effFp = fleet.checkRatings.firepower;
      const dc = Math.max(8, enemy.shellingDc);

      checkResult = this._statRules.performCheck({
        actorId: flagship.id,
        actorName: fleetLabel,
        statKey: 'firepower',
        baseStatValue: baseFp,
        effectiveStatValue: effFp,
        equipmentCheckBonus: fleet.avgCheckBonus,
        moraleValue: fleet.avgMorale,
        dc,
        extraModifier: (seaMods.checkBonus || 0) + session.lockOnBonus,
        commanderLuck: cmdLuck,
        rng,
      });

      const ok = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
      isCrit = checkResult.outcome === 'crit-success';
      if (ok) {
        const weakMult = enemy.weakness === 'shelling' ? 1.3 : 1.0;
        const critMult = isCrit ? 1.6 : 1.0;
        const lockDmgMult = session.lockOnBonus > 0 ? seaMods.dmgMult || 1.0 : 1.0;
        const counterBonus = computeCounterThreatBonus();
        const mainDmg = Math.max(
          10,
          Math.round((fleet.effective.firepower * 0.24 + effFp * 0.22 - enemy.armor * 0.65) * weakMult * critMult * lockDmgMult) +
            counterBonus
        );
        enemy.hp = Math.max(0, enemy.hp - mainDmg);
        const followUpDmg = tryWingmanFollowUp(mainDmg, 'shelling');
        damageDealt = mainDmg + followUpDmg;

        this._emit('combat:hit', { command: 'shelling', damage: damageDealt, crit: isCrit });
        chips.push({ text: `炮击齐射 -${mainDmg}`, negative: false });
        outcomeTag = isCrit ? `炮击暴击 -${damageDealt}` : `炮击命中 -${damageDealt}`;

        if (enemy.hp <= 0) {
          session.status = 'victory';
          localTemplate =
            '{actor.name}（{formation}）齐射【炮击】（{check.total} vs DC {check.dc}），造成总计 {damageDealt} 点伤害，彻底击破「{enemy.name}」！{extraText}';
        } else {
          damageTaken = runEnemyCounter(0.85);
          localTemplate =
            '{actor.name}（{formation}）发动【炮击】命中（{check.total} vs DC {check.dc}），造成 {damageDealt} 点伤害；敌方反击造成 -{damageTaken} HP。{extraText}';
        }
      } else {
        outcomeTag = '炮击偏失';
        damageTaken = runEnemyCounter(0.95);
        localTemplate =
          '{actor.name}【炮击】弹着偏移（{check.total} vs DC {check.dc}），遭敌方反击损失 {damageTaken} HP。{extraText}';
      }
    } else if (commandId === 'torpedo') {
      const baseTorp = Math.round(fleet.totals?.torpedo / Math.max(1, fleet.aliveCount) || fleet.checkRatings.torpedo);
      const effTorp = fleet.checkRatings.torpedo;
      const lockBoost = Math.round(session.lockOnBonus * 1.5);
      const dc = Math.max(10, enemy.torpedoDc);

      checkResult = this._statRules.performCheck({
        actorId: flagship.id,
        actorName: fleetLabel,
        statKey: 'torpedo',
        baseStatValue: baseTorp,
        effectiveStatValue: effTorp,
        equipmentCheckBonus: fleet.avgCheckBonus,
        moraleValue: fleet.avgMorale,
        dc,
        extraModifier: (seaMods.checkBonus || 0) + lockBoost,
        commanderLuck: cmdLuck,
        rng,
      });

      const ok = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
      isCrit = checkResult.outcome === 'crit-success';
      if (ok) {
        const weakMult = enemy.weakness === 'torpedo' ? 1.35 : 1.0;
        const critMult = isCrit ? 1.85 : 1.0;
        const lockDmgMult = session.lockOnBonus > 0 ? seaMods.dmgMult || 1.0 : 1.0;
        const counterBonus = computeCounterThreatBonus();
        const mainDmg = Math.max(
          16,
          Math.round((fleet.effective.torpedo * 0.34 + effTorp * 0.28 - enemy.armor * 0.35) * weakMult * critMult * lockDmgMult) +
            counterBonus
        );
        enemy.hp = Math.max(0, enemy.hp - mainDmg);
        const followUpDmg = tryWingmanFollowUp(mainDmg, 'torpedo');
        damageDealt = mainDmg + followUpDmg;

        this._emit('combat:hit', { command: 'torpedo', damage: damageDealt, crit: isCrit });
        chips.push({ text: `雷击爆发 -${mainDmg}`, negative: false });
        outcomeTag = isCrit ? `雷击暴击 -${damageDealt}` : `雷击重创 -${damageDealt}`;

        if (enemy.hp <= 0) {
          session.status = 'victory';
          localTemplate =
            '{actor.name}抓住战机齐射【鱼雷】（{check.total} vs DC {check.dc}），爆发出总计 {damageDealt} 点毁灭伤害，瞬间击沉「{enemy.name}」！{extraText}';
        } else {
          damageTaken = runEnemyCounter(0.9);
          localTemplate =
            '{actor.name}齐射【鱼雷】重创「{enemy.name}」（{check.total} vs DC {check.dc}），造成 {damageDealt} 点高额伤害；敌方残存火力反击 -{damageTaken} HP。{extraText}';
        }
      } else {
        outcomeTag = '雷击被规避';
        damageTaken = runEnemyCounter(1.25);
        for (const m of aliveMembers) {
          this._entities.adjustStat(m.id, 'morale', -5, { min: 0, max: 100 });
        }
        chips.push({ text: '全队士气 -5', negative: true });
        localTemplate =
          '{actor.name}【鱼雷】雷迹被「{enemy.name}」规避拦截（{check.total} vs DC {check.dc}），承受高额反击 -{damageTaken} HP！{extraText}';
      }
    }

    // 2.5 Award Shipgirl EXP on Combat Victory (with +20% flagship bonus)
    const shipExpResults = [];
    if (session.status === 'victory' && this._statRules && typeof this._statRules.grantShipExp === 'function') {
      const baseShipExp =
        session.nodeType === 'boss' ? 85 : session.nodeType === 'elite' ? 55 : 35;
      for (const m of aliveMembers) {
        const gain = m.isFlagship ? Math.round(baseShipExp * 1.2) : baseShipExp;
        const expRes = this._statRules.grantShipExp(this._entities, m.id, gain, {
          reason: `战术交战胜利：${enemy.name}`,
          inventory: this._inventory,
        });
        if (expRes) {
          shipExpResults.push(expRes);
          if (expRes.leveledUp) {
            chips.push({ text: `★ ${expRes.characterName} 升至 Lv.${expRes.afterLevel}`, negative: false });
          }
        }
      }
      if (shipExpResults.length > 0) {
        chips.push({ text: `编队舰娘 EXP +${baseShipExp}`, negative: false });
      }
    }

    // 3. Render dual-track tactical report via PromptPipeline
    const extraText = extraEvents.length > 0 ? `（${extraEvents.join('；')}）` : '';
    const rendered = await this._narrative.run({
      template: localTemplate,
      variables: {
        actor: { name: fleetLabel, hp: flagship.hp, maxHp: flagship.maxHp },
        formation: fleet.formationName,
        enemy: {
          name: enemy.name,
          hp: enemy.hp,
          maxHp: enemy.maxHp,
          armor: enemy.armor,
          threatLabel: enemy.threatLabel,
          weaknessLabel: enemy.weaknessLabel,
        },
        check: checkResult,
        damageDealt,
        damageTaken,
        lockOnBonus: session.lockOnBonus,
        extraText,
      },
      polishInstruction: `请以简洁紧凑的海战战术战报口吻润色第 ${session.turn} 回合「${fleet.formationName}」的【${cmdDef.label}】交战结果，严格保留所有伤害、僚机协同与检定数字：`,
    });

    const turnEntry = {
      turn: session.turn,
      commandId,
      commandLabel: cmdDef.label,
      outcomeTag,
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      damageDealt,
      damageTaken,
      isCrit,
      extraEvents,
      check: {
        statLabel: checkResult.statLabel,
        dc: checkResult.dc,
        total: checkResult.total,
        margin: checkResult.margin,
        outcome: checkResult.outcome,
        outcomeLabel: checkResult.outcomeLabel,
        steps: checkResult.steps,
      },
      chips,
      timestamp: Date.now(),
    };

    session.turnsLog.unshift(turnEntry);
    session.turn += 1;

    this._emit('combat:turn-resolved', {
      sessionId: session.id,
      turn: turnEntry.turn,
      commandId,
      status: session.status,
      damageDealt,
      damageTaken,
      fleetSize: aliveMembers.length,
    });

    return {
      ok: true,
      turnEntry,
      session: this.getSession(),
    };
  }

  serialize() {
    return this._session ? deepClone(this._session) : null;
  }

  deserialize(snapshot) {
    this._session = snapshot && typeof snapshot === 'object' ? deepClone(snapshot) : null;
  }
}
