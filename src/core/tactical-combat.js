/**
 * Multi-Command Tactical Combat Engine (`tactical-combat.js`).
 *
 * Independent multi-turn tactical engagement state machine supporting 4 player commands:
 *   1. scan     (扫描) : tactics check -> reveals hidden enemy HP/armor/weakness & grants Lock-On buff
 *   2. evade    (迂回) : extra fuel + agility check -> bypass non-boss cleanly, or gain evasion buff vs boss
 *   3. shelling (炮击) : standard ammo + attack check -> reliable steady damage
 *   4. torpedo  (鱼雷) : high ammo + burst & luck check -> massive burst/crit (boosted by Lock-On), higher counter risk on miss
 *
 * Integrates StatRulesEngine (1D20 + all-slot equipment bonuses), FxStage (via EventBus),
 * and PromptPipeline (pure local tactical templates / AI battle report polish with fallback).
 */

import { clamp } from './calc-engine.js';

export const COMBAT_COMMANDS = Object.freeze({
  SCAN: {
    id: 'scan',
    label: '扫描',
    sublabel: '索敌 · 揭露弱点 + 锁定增益',
    statKey: 'tactics',
    cost: { fuel: 5, ammo: 0 },
  },
  EVADE: {
    id: 'evade',
    label: '迂回',
    sublabel: '机动 · 油-20 绕过/闪避',
    statKey: 'agility',
    cost: { fuel: 20, ammo: 0 },
  },
  SHELLING: {
    id: 'shelling',
    label: '炮击',
    sublabel: '火力 · 弹-15 稳定输出',
    statKey: 'attack',
    cost: { fuel: 0, ammo: 15 },
  },
  TORPEDO: {
    id: 'torpedo',
    label: '鱼雷',
    sublabel: '雷装+幸运 · 弹-30 高爆发',
    statKey: 'burst',
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
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({ entities, inventory, statRules, resources, narrative, bus = null }) {
    this._entities = entities;
    this._inventory = inventory;
    this._statRules = statRules;
    this._resources = resources;
    this._narrative = narrative;
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
   * Initialize a new tactical combat engagement for a sortie node.
   */
  startEncounter({ characterId, node, seaCondition = null }) {
    const enemyTpl = node.enemyTemplate || {
      name: node.name || '未知敌方单位',
      tier: node.type || 'encounter',
      forcedEngagement: node.type === 'boss',
      hp: 65,
      maxHp: 65,
      armor: 4,
      attackPower: 12,
      scanDc: 13,
      evadeDc: 13,
      shellingDc: 13,
      torpedoDc: 15,
      weakness: 'shelling',
      weaknessLabel: '炮击弱点',
    };

    this._session = {
      id: `cmb_${Date.now().toString(36)}`,
      characterId: String(characterId),
      nodeCode: node.code || 'A',
      nodeName: node.name || enemyTpl.name,
      seaCondition: seaCondition ? deepClone(seaCondition) : null,
      turn: 1,
      status: 'active', // 'active' | 'victory' | 'bypassed' | 'defeated'
      lockOnBonus: 0,
      evasionBuffTurns: 0,
      enemy: {
        ...deepClone(enemyTpl),
        hp: Number(enemyTpl.maxHp ?? enemyTpl.hp ?? 65),
        maxHp: Number(enemyTpl.maxHp ?? enemyTpl.hp ?? 65),
        scanned: false,
      },
      turnsLog: [],
    };

    this._emit('combat:started', {
      sessionId: this._session.id,
      characterId,
      enemyName: this._session.enemy.name,
      forcedEngagement: this._session.enemy.forcedEngagement,
    });
    return this.getSession();
  }

  /**
   * Execute one of the 4 tactical commands: 'scan' | 'evade' | 'shelling' | 'torpedo'.
   */
  async executeCommand(commandId) {
    if (!this.isActive()) {
      return { ok: false, reason: '当前没有进行中的战术交战' };
    }
    const cmdDef = Object.values(COMBAT_COMMANDS).find((c) => c.id === commandId);
    if (!cmdDef) {
      return { ok: false, reason: `未知战术指令：${commandId}` };
    }

    const session = this._session;
    const char = this._entities.get(session.characterId);
    if (!char) {
      return { ok: false, reason: '当前出战角色不存在' };
    }

    // 1. Spend command resource cost (fuel / ammo)
    const costMap = {};
    if (cmdDef.cost.fuel > 0) costMap.fuel = cmdDef.cost.fuel;
    if (cmdDef.cost.ammo > 0) costMap.ammo = cmdDef.cost.ammo;
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
    const eqBonuses = this._inventory.getCharacterEquipmentBonuses(char.id);
    const maxHp = Number(char.stats.maxHp ?? 100);
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

    const runEnemyCounter = (mult = 1.0) => {
      const evadeMult = session.evasionBuffTurns > 0 ? 0.5 : 1.0;
      const rawDmg = Math.max(3, Math.round(enemy.attackPower * mult * evadeMult));
      const beforeHp = Number(char.stats.hp ?? maxHp);
      const afterHp = this._entities.adjustStat(char.id, 'hp', -rawDmg, { min: 0, max: maxHp });
      const actual = Math.max(0, Math.round(beforeHp - afterHp));
      if (actual > 0) {
        chips.push({ text: `受击 HP -${actual}`, negative: true });
        this._emit('combat:enemy-hit', { characterId: char.id, damage: actual });
      }
      if (session.evasionBuffTurns > 0) {
        session.evasionBuffTurns = Math.max(0, session.evasionBuffTurns - 1);
      }
      if (afterHp <= 0) {
        session.status = 'defeated';
      }
      return actual;
    };

    // 2. Command Resolution
    if (commandId === 'scan') {
      const baseVal = Number(char.stats.tactics ?? 50);
      const effVal = this._entities.getEffectiveStat(char.id, 'tactics', { round: 'round' }).final;
      const dc = Math.max(8, enemy.scanDc + (seaMods.scanDcDelta || 0));

      checkResult = this._statRules.performCheck({
        actorId: char.id,
        actorName: char.name,
        statKey: 'tactics',
        baseStatValue: baseVal,
        effectiveStatValue: effVal,
        equipmentCheckBonus: eqBonuses.checkBonus,
        moraleValue: char.stats.morale ?? 60,
        dc,
        extraModifier: seaMods.checkBonus || 0,
      });

      const ok = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
      this._emit('combat:scan', { success: ok, enemyName: enemy.name });

      if (ok) {
        enemy.scanned = true;
        const lockVal = checkResult.outcome === 'crit-success' ? 4 : 3;
        session.lockOnBonus = Math.max(session.lockOnBonus, lockVal);
        outcomeTag = `锁定成功 (+${session.lockOnBonus})`;
        chips.push({ text: `弱点揭露：${enemy.weaknessLabel}`, negative: false });
        chips.push({ text: `锁定增益 +${session.lockOnBonus}`, negative: false });
        localTemplate =
          '{actor.name}执行【扫描】成功（{check.total} vs DC {check.dc}），精准揭露「{enemy.name}」耐久 {enemy.hp}/{enemy.maxHp}、护甲 {enemy.armor} 与弱点【{enemy.weaknessLabel}】，己方获得锁定增益 +{lockOnBonus}！';
      } else {
        outcomeTag = '扫描受干扰';
        damageTaken = runEnemyCounter(0.55);
        localTemplate =
          '{actor.name}尝试【扫描】遭遇干扰（{check.total} vs DC {check.dc}），未能获取完整数据，遭敌方试探射击损失 {damageTaken} HP。';
      }
    } else if (commandId === 'evade') {
      const baseVal = Number(char.stats.agility ?? 50);
      const effVal = this._entities.getEffectiveStat(char.id, 'agility', { round: 'round' }).final;
      const dc = Math.max(8, enemy.evadeDc);

      checkResult = this._statRules.performCheck({
        actorId: char.id,
        actorName: char.name,
        statKey: 'agility',
        baseStatValue: baseVal,
        effectiveStatValue: effVal,
        equipmentCheckBonus: eqBonuses.checkBonus,
        moraleValue: char.stats.morale ?? 60,
        dc,
        extraModifier: (seaMods.checkBonus || 0) + (seaMods.evadeBonus || 0),
      });

      const ok = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
      if (ok && !enemy.forcedEngagement) {
        session.status = 'bypassed';
        outcomeTag = '无伤迂回成功';
        chips.push({ text: '成功绕过敌人', negative: false });
        localTemplate =
          '{actor.name}全速执行【迂回】机动（{check.total} vs DC {check.dc}），成功从侧翼无伤绕过「{enemy.name}」，航路畅通！';
      } else if (ok && enemy.forcedEngagement) {
        session.evasionBuffTurns = 2;
        outcomeTag = '获得先手闪避';
        chips.push({ text: '闪避减伤 50% (2回合)', negative: false });
        localTemplate =
          '面对强制决战目标「{enemy.name}」，{actor.name}【迂回】占据有利航向（{check.total} vs DC {check.dc}），获得 2 回合先手闪避增益（受击伤害减半）！';
      } else {
        outcomeTag = '迂回被截击';
        damageTaken = runEnemyCounter(1.05);
        this._entities.adjustStat(char.id, 'morale', -5, { min: 0, max: 100 });
        chips.push({ text: '士气 -5', negative: true });
        localTemplate =
          '{actor.name}【迂回】机动被「{enemy.name}」识破拦截（{check.total} vs DC {check.dc}），承受截击伤害 -{damageTaken} HP！';
      }
    } else if (commandId === 'shelling') {
      const baseVal = Number(char.stats.attack ?? 50);
      const effVal = this._entities.getEffectiveStat(char.id, 'attack', { round: 'round' }).final;
      const dc = Math.max(8, enemy.shellingDc);

      checkResult = this._statRules.performCheck({
        actorId: char.id,
        actorName: char.name,
        statKey: 'attack',
        baseStatValue: baseVal,
        effectiveStatValue: effVal,
        equipmentCheckBonus: eqBonuses.checkBonus,
        moraleValue: char.stats.morale ?? 60,
        dc,
        extraModifier: (seaMods.checkBonus || 0) + session.lockOnBonus,
      });

      const ok = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
      isCrit = checkResult.outcome === 'crit-success';
      if (ok) {
        const weakMult = enemy.weakness === 'shelling' ? 1.3 : 1.0;
        const critMult = isCrit ? 1.6 : 1.0;
        const lockDmgMult = session.lockOnBonus > 0 ? seaMods.dmgMult || 1.0 : 1.0;
        damageDealt = Math.max(
          8,
          Math.round((effVal * 0.46 - enemy.armor * 0.65) * weakMult * critMult * lockDmgMult)
        );
        enemy.hp = Math.max(0, enemy.hp - damageDealt);
        this._emit('combat:hit', { command: 'shelling', damage: damageDealt, crit: isCrit });
        chips.push({ text: `炮击命中 -${damageDealt}`, negative: false });
        outcomeTag = isCrit ? `炮击暴击 -${damageDealt}` : `炮击命中 -${damageDealt}`;

        if (enemy.hp <= 0) {
          session.status = 'victory';
          localTemplate =
            '{actor.name}发动【炮击】精准命中（{check.total} vs DC {check.dc}），造成 {damageDealt} 点伤害，彻底击破「{enemy.name}」！';
        } else {
          damageTaken = runEnemyCounter(0.85);
          localTemplate =
            '{actor.name}发动【炮击】稳定命中（{check.total} vs DC {check.dc}），对「{enemy.name}」造成 {damageDealt} 点伤害；敌方反击造成 -{damageTaken} HP。';
        }
      } else {
        outcomeTag = '炮击偏失';
        damageTaken = runEnemyCounter(0.95);
        localTemplate =
          '{actor.name}【炮击】弹着偏移（{check.total} vs DC {check.dc}），未能有效杀伤「{enemy.name}」，遭敌方反击损失 {damageTaken} HP。';
      }
    } else if (commandId === 'torpedo') {
      const baseBurst = Number(char.stats.burst ?? 50);
      const effBurst = this._entities.getEffectiveStat(char.id, 'burst', { round: 'round' }).final;
      const effLuck = this._entities.getEffectiveStat(char.id, 'luck', { round: 'round' }).final;
      const luckBonus = Math.floor(effLuck / 15);
      const lockBoost = Math.round(session.lockOnBonus * 1.5);
      const dc = Math.max(10, enemy.torpedoDc);

      checkResult = this._statRules.performCheck({
        actorId: char.id,
        actorName: char.name,
        statKey: 'burst',
        baseStatValue: baseBurst,
        effectiveStatValue: effBurst,
        equipmentCheckBonus: eqBonuses.checkBonus,
        moraleValue: char.stats.morale ?? 60,
        dc,
        extraModifier: (seaMods.checkBonus || 0) + luckBonus + lockBoost,
      });

      const ok = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
      isCrit = checkResult.outcome === 'crit-success';
      if (ok) {
        const weakMult = enemy.weakness === 'torpedo' ? 1.35 : 1.0;
        const critMult = isCrit ? 1.85 : 1.0;
        const lockDmgMult = session.lockOnBonus > 0 ? seaMods.dmgMult || 1.0 : 1.0;
        damageDealt = Math.max(
          14,
          Math.round((effBurst * 0.72 + effLuck * 0.12 - enemy.armor * 0.35) * weakMult * critMult * lockDmgMult)
        );
        enemy.hp = Math.max(0, enemy.hp - damageDealt);
        this._emit('combat:hit', { command: 'torpedo', damage: damageDealt, crit: isCrit });
        chips.push({ text: `鱼雷爆发 -${damageDealt}`, negative: false });
        outcomeTag = isCrit ? `鱼雷暴击 -${damageDealt}` : `鱼雷重创 -${damageDealt}`;

        if (enemy.hp <= 0) {
          session.status = 'victory';
          localTemplate =
            '{actor.name}抓住战机齐射【鱼雷】（{check.total} vs DC {check.dc}，幸运修正 +{luckBonus}），爆发出 {damageDealt} 点毁灭伤害，瞬间击沉「{enemy.name}」！';
        } else {
          damageTaken = runEnemyCounter(0.9);
          localTemplate =
            '{actor.name}齐射【鱼雷】重创目标（{check.total} vs DC {check.dc}），造成 {damageDealt} 点高额伤害；敌方残存火力反击 -{damageTaken} HP。';
        }
      } else {
        outcomeTag = '鱼雷被拦截';
        damageTaken = runEnemyCounter(1.3);
        this._entities.adjustStat(char.id, 'morale', -6, { min: 0, max: 100 });
        chips.push({ text: '士气 -6', negative: true });
        localTemplate =
          '{actor.name}【鱼雷】雷迹被「{enemy.name}」提前规避拦截（{check.total} vs DC {check.dc}），暴露破绽承受高额反击 -{damageTaken} HP！';
      }
    }

    // 3. Render dual-track tactical report via PromptPipeline
    const rendered = await this._narrative.run({
      template: localTemplate,
      variables: {
        actor: { name: char.name, hp: Math.round(char.stats.hp ?? 0), maxHp },
        enemy: {
          name: enemy.name,
          hp: enemy.hp,
          maxHp: enemy.maxHp,
          armor: enemy.armor,
          weaknessLabel: enemy.weaknessLabel,
        },
        check: checkResult,
        damageDealt,
        damageTaken,
        lockOnBonus: session.lockOnBonus,
        luckBonus: Math.floor(this._entities.getEffectiveStat(char.id, 'luck', { round: 'round' }).final / 15),
      },
      polishInstruction: `请以简洁紧凑的战术战报口吻润色第 ${session.turn} 回合的【${cmdDef.label}】交战结果，严格保留所有伤害与检定数字：`,
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
