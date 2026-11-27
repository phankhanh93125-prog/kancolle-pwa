/**
 * Port Expedition Dispatch Engine (`expedition-system.js`).
 *
 * Integrates with:
 *   - EntitySystem countdown task registry & real wall-clock timestamps (continues accurately offline/across page reloads)
 *   - InventorySystem seaworthiness validation (only seaworthy idle shipgirls can be dispatched)
 *   - CommanderSystem:
 *       * `dispatch` (调度) multiplies resource & silver rewards
 *       * `affinity` (亲和) multiplies post-expedition shipgirl affinity gains
 *       * Grants Commander EXP upon completing expeditions
 *   - ResourceManager & LogSystem for clean reward settlement & audit logging
 */

import { formatDurationZh } from './entity-system.js';
import { LOG_CATEGORIES } from './log-system.js';
import { resolveShipClass } from './stat-rules.js';

const STORAGE_NS = 'core-expeditions';
const STATE_KEY = 'expedition-state-v1';

export const EXPEDITION_MISSIONS = Object.freeze([
  {
    id: 'exp_harbor_patrol',
    name: '近港巡航警戒',
    description: '短途近海巡逻与漂浮物资回收，快速补充油弹与银条。',
    durationSec: 60,
    minShips: 1,
    maxShips: 3,
    rewards: { fuel: 65, ammo: 55, silver: 40 },
    commanderExp: 18,
    affinityGain: 2,
  },
  {
    id: 'exp_convoy_escort',
    name: '航道商船护航',
    description: '中型护航任务，稳定带回钢材、燃油与流通银条。',
    durationSec: 300,
    minShips: 1,
    maxShips: 4,
    rewards: { fuel: 140, ammo: 110, steel: 120, silver: 95 },
    commanderExp: 35,
    affinityGain: 4,
  },
  {
    id: 'exp_bauxite_transport',
    name: '外岛铝土资源输送',
    description: '长途航空资材输送任务，重点回收铝材、钢材与少量金条。',
    durationSec: 900,
    minShips: 2,
    maxShips: 6,
    rewards: { steel: 220, bauxite: 240, silver: 180, gold: 2 },
    commanderExp: 65,
    affinityGain: 6,
  },
  {
    id: 'exp_deep_logistics',
    name: '远洋战略联合远征',
    description: '高收益远洋后勤派遣，全面补充六项资源与金银双货币。',
    durationSec: 1800,
    minShips: 2,
    maxShips: 6,
    rewards: { fuel: 360, ammo: 340, steel: 320, bauxite: 280, silver: 320, gold: 5 },
    commanderExp: 110,
    affinityGain: 10,
  },
]);

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

export class ExpeditionSystem {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   entities: import('./entity-system.js').EntitySystem,
   *   inventory: import('./inventory-system.js').InventorySystem,
   *   resources: import('./resource-manager.js').ResourceManager,
   *   commander: import('./commander-system.js').CommanderSystem,
   *   logs?: import('./log-system.js').LogSystem | null,
   *   formation?: import('./formation-system.js').FormationSystem | null,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({
    storage,
    entities,
    inventory,
    resources,
    commander,
    statRules = null,
    routeGenerator = null,
    logs = null,
    formation = null,
    bus = null,
  }) {
    this._storage = storage;
    this._scope = storage.namespace(STORAGE_NS);
    this._entities = entities;
    this._inventory = inventory;
    this._resources = resources;
    this._commander = commander;
    this._statRules = statRules;
    this._routeGenerator = routeGenerator;
    this._logs = logs;
    this._formation = formation;
    this._bus = bus;

    /** @type {Array<{ id: string, missionId: string, missionName: string, characterIds: string[], startedAt: number, durationSec: number, endAt: number, rewards: Record<string, number>, commanderExp: number, affinityGain: number }>} */
    this._activeRuns = [];
    this._completedCount = 0;
    this._hydrated = false;
  }

  setFormation(formation) {
    this._formation = formation;
  }

  setRouteGenerator(rg) {
    this._routeGenerator = rg;
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  async init() {
    if (this._hydrated) return;
    const saved = await this._scope.getLarge(STATE_KEY, null);
    if (saved && typeof saved === 'object') {
      this._activeRuns = Array.isArray(saved.activeRuns) ? deepClone(saved.activeRuns) : [];
      this._completedCount = Math.max(0, Math.floor(Number(saved.completedCount) || 0));
      this._syncTasksToEntitySystem();
    }
    this._hydrated = true;
  }

  async persist() {
    await this._scope.setLarge(STATE_KEY, this.serialize());
  }

  _syncTasksToEntitySystem() {
    if (!this._entities) return;
    for (const run of this._activeRuns) {
      this._entities.registerTask({
        id: `exp_task_${run.id}`,
        label: `远征 · ${run.missionName}`,
        durationSec: run.durationSec,
        startedAt: run.startedAt,
        meta: { type: 'expedition', runId: run.id, characterIds: run.characterIds },
      });
    }
  }

  listMissions() {
    const mult = this._commander ? this._commander.getExpeditionRewardMultiplier() : 1.0;
    return EXPEDITION_MISSIONS.map((m) => {
      const projectedRewards = {};
      for (const [resId, amt] of Object.entries(m.rewards)) {
        projectedRewards[resId] =
          resId === 'gold' ? amt : Math.round(amt * mult);
      }
      return {
        ...deepClone(m),
        durationText: formatDurationZh(m.durationSec),
        dispatchMultiplier: mult,
        projectedRewards,
      };
    });
  }

  getDispatchedCharacterIds() {
    const ids = new Set();
    for (const run of this._activeRuns) {
      for (const cid of run.characterIds || []) {
        ids.add(String(cid));
      }
    }
    return ids;
  }

  isCharacterDispatched(characterId) {
    return this.getDispatchedCharacterIds().has(String(characterId));
  }

  listActiveRuns(now = Date.now()) {
    return this._activeRuns.map((run) => {
      const remainingSec = Math.max(0, Math.ceil((run.endAt - now) / 1000));
      const elapsedSec = Math.max(0, (now - run.startedAt) / 1000);
      const progress = Math.min(1, elapsedSec / Math.max(1, run.durationSec));
      const ready = remainingSec <= 0;
      const ships = (run.characterIds || [])
        .map((id) => this._entities?.get(id))
        .filter(Boolean)
        .map((c) => ({ id: c.id, name: c.name, shipType: c.meta?.shipType || '通用舰' }));
      return {
        ...deepClone(run),
        ships,
        remainingSec,
        remainingText: ready ? '已完成 · 可领取' : formatDurationZh(remainingSec),
        progress: Number(progress.toFixed(4)),
        ready,
      };
    });
  }

  /**
   * Dispatch 1+ idle seaworthy characters onto an expedition mission.
   * Characters currently in standby fleet are automatically removed from the sortie fleet to prevent conflicts.
   */
  async dispatch(missionId, characterIds = []) {
    const mission = EXPEDITION_MISSIONS.find((m) => m.id === missionId);
    if (!mission) throw new Error(`未找到远征任务：${missionId}`);

    const cleanIds = Array.from(new Set((characterIds || []).map(String).filter(Boolean)));
    if (cleanIds.length < mission.minShips) {
      throw new Error(`该远征至少需要派遣 ${mission.minShips} 名适航角色`);
    }
    if (cleanIds.length > mission.maxShips) {
      throw new Error(`该远征最多派遣 ${mission.maxShips} 名角色`);
    }

    for (const cid of cleanIds) {
      const actor = this._entities?.get(cid);
      if (!actor || actor.kind !== 'character') {
        throw new Error(`角色 "${cid}" 不存在`);
      }
      const sw = this._inventory.checkSeaworthiness(cid);
      if (!sw.seaworthy) {
        throw new Error(`「${actor.name}」${sw.statusText}，无法派遣远征`);
      }
      if (this.isCharacterDispatched(cid)) {
        throw new Error(`「${actor.name}」已在执行其他远征任务`);
      }
    }

    // Remove dispatched ships from active standby sortie formation so they aren't double-assigned
    if (this._formation) {
      for (const cid of cleanIds) {
        await this._formation.removeMember(cid);
      }
    }

    const now = Date.now();
    const run = {
      id: `exp_${now.toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      missionId: mission.id,
      missionName: mission.name,
      characterIds: cleanIds,
      startedAt: now,
      durationSec: mission.durationSec,
      endAt: now + mission.durationSec * 1000,
      rewards: deepClone(mission.rewards),
      commanderExp: mission.commanderExp,
      affinityGain: mission.affinityGain,
    };

    this._activeRuns.push(run);
    this._syncTasksToEntitySystem();
    await this.persist();

    const names = cleanIds.map((id) => this._entities?.get(id)?.name || id).join('、');
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        title: `远征派遣出发：${mission.name}`,
        detail: `派遣舰船：${names} | 预计耗时：${formatDurationZh(mission.durationSec)}`,
      });
    }

    this._emit('expedition:dispatched', { run: deepClone(run) });
    return deepClone(run);
  }

  /**
   * Claim rewards for a finished expedition (applying Commander `dispatch` & `affinity` bonuses).
   */
  async claim(runId, { now = Date.now(), forceComplete = false } = {}) {
    const idx = this._activeRuns.findIndex((r) => r.id === runId);
    if (idx < 0) throw new Error('未找到对应的远征记录');
    const run = this._activeRuns[idx];
    if (!forceComplete && now < run.endAt) {
      const rem = Math.ceil((run.endAt - now) / 1000);
      throw new Error(`远征尚未结束，剩余 ${formatDurationZh(rem)}`);
    }

    const dispatchMult = this._commander ? this._commander.getExpeditionRewardMultiplier() : 1.0;
    const affMult = this._commander ? this._commander.getAffinityGainMultiplier() : 1.0;
    const shipCountBonus = 1 + Math.max(0, (run.characterIds.length - 1) * 0.08);
    const seaControlMult =
      this._routeGenerator && typeof this._routeGenerator.getExpeditionYieldMultiplier === 'function'
        ? this._routeGenerator.getExpeditionYieldMultiplier()
        : 1.0;
    const totalMult = dispatchMult * shipCountBonus * seaControlMult;

    // AR (维修舰) boosts steel & bauxite (+12% each); AO (补给舰) boosts fuel, ammo & silver (+15% each)
    let arCount = 0;
    let aoCount = 0;
    for (const cid of run.characterIds || []) {
      const ent = this._entities?.get(cid);
      const cls = resolveShipClass(ent?.meta?.shipType || '');
      if (cls === 'AR') arCount += 1;
      else if (cls === 'AO') aoCount += 1;
    }
    const arMatMult = 1 + Math.min(0.36, arCount * 0.12);
    const aoSupplyMult = 1 + Math.min(0.45, aoCount * 0.15);

    const grantedRewards = {};
    for (const [resId, baseAmt] of Object.entries(run.rewards || {})) {
      const supportMult =
        resId === 'steel' || resId === 'bauxite'
          ? arMatMult
          : resId === 'fuel' || resId === 'ammo' || resId === 'silver'
          ? aoSupplyMult
          : 1.0;
      const amount =
        resId === 'gold'
          ? Math.max(1, Math.round(baseAmt * (1 + Math.max(0, dispatchMult * seaControlMult - 1) * 0.4)))
          : Math.max(1, Math.round(baseAmt * totalMult * supportMult));
      await this._resources.add(resId, amount, { reason: `远征完成：${run.missionName}` });
      grantedRewards[resId] = amount;
    }

    // Grant Shipgirl affinity (scaled by Commander `affinity`) and Shipgirl EXP
    const affDelta = Math.max(1, Math.round((run.affinityGain || 2) * affMult));
    const shipExpGain = Math.max(20, Math.round((run.commanderExp || 25) * 1.4));
    const shipExpResults = [];
    for (const cid of run.characterIds || []) {
      if (this._entities?.has(cid)) {
        this._entities.adjustStat(cid, 'affinity', affDelta, { min: 0, max: 100 });
        if (this._statRules && typeof this._statRules.grantShipExp === 'function') {
          const res = this._statRules.grantShipExp(this._entities, cid, shipExpGain, {
            reason: `远征完成：${run.missionName}`,
            inventory: this._inventory,
          });
          if (res) shipExpResults.push(res);
        }
      }
    }

    // Grant Commander EXP (accelerated v30 pace so 1-2 expeditions/sorties smoothly level up)
    let expResult = null;
    if (this._commander) {
      const cmdExpGain = Math.max(30, Math.round((run.commanderExp || 24) * 1.6));
      expResult = await this._commander.grantExp(cmdExpGain, `远征完成：${run.missionName}`);
    }

    this._activeRuns.splice(idx, 1);
    this._completedCount += 1;
    this._entities?.removeTask(`exp_task_${run.id}`);
    await this.persist();

    const rewardSummary = Object.entries(grantedRewards)
      .map(([k, v]) => `${this._resources.get(k)?.name || k} +${v}`)
      .join('、');
    const levelUpText = shipExpResults
      .filter((r) => r.leveledUp)
      .map((r) => `${r.characterName} Lv.${r.afterLevel}`)
      .join('、');
    const supportBonusParts = [];
    if (arCount > 0) supportBonusParts.push(`维修舰×${arCount} 钢铝+${Math.round((arMatMult - 1) * 100)}%`);
    if (aoCount > 0) supportBonusParts.push(`补给舰×${aoCount} 油弹银+${Math.round((aoSupplyMult - 1) * 100)}%`);
    const supportBonusNote = supportBonusParts.join(' · ');

    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.RESOURCE,
        title: `远征归港领取：${run.missionName}`,
        detail: `调度加成 x${dispatchMult.toFixed(2)}${supportBonusNote ? ` · ${supportBonusNote}` : ''} | 获得：${rewardSummary} | 指挥官经验 +${run.commanderExp} | 舰娘经验 +${shipExpGain}${levelUpText ? `（升级：${levelUpText}）` : ''}`,
      });
    }

    const payload = {
      run: deepClone(run),
      grantedRewards,
      dispatchMultiplier: dispatchMult,
      supportBonusNote,
      affinityGain: affDelta,
      commanderExp: run.commanderExp,
      shipExpGain,
      shipExpResults,
      leveledUp: Boolean(expResult?.leveledUp),
      timestamp: Date.now(),
    };
    this._emit('expedition:claimed', payload);
    return payload;
  }

  async recall(runId) {
    const idx = this._activeRuns.findIndex((r) => r.id === runId);
    if (idx < 0) return false;
    const [removed] = this._activeRuns.splice(idx, 1);
    this._entities?.removeTask(`exp_task_${removed.id}`);
    await this.persist();
    this._emit('expedition:recalled', { run: deepClone(removed) });
    return true;
  }

  serialize() {
    return {
      version: 1,
      completedCount: this._completedCount,
      activeRuns: deepClone(this._activeRuns),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._activeRuns = Array.isArray(snapshot.activeRuns) ? deepClone(snapshot.activeRuns) : [];
    this._completedCount = Math.max(0, Math.floor(Number(snapshot.completedCount) || 0));
    this._syncTasksToEntitySystem();
    if (persist) this.persist();
  }
}
