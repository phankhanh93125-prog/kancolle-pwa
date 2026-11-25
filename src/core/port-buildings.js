/**
 * Customizable Port Buildings & Facilities Engine (`port-buildings.js`).
 *
 * Persisted in IndexedDB (`core-port-buildings`) and integrated with `EntitySystem` offline time delta:
 *   1. Built-in Facility: Dormitory (宿舍)
 *        - Expandable bed capacity (default 3..12)
 *        - Residents automatically recover `morale` and trickle `affinity` over real offline time
 *        - Supports feeding supplies to immediately boost residents' morale & affinity
 *   2. Built-in Facility: Dockyard (船坞)
 *        - Expandable multi-bay repair queue (default 2..6)
 *        - Computes steel/bauxite cost & real-time repair countdown using missing HP + Commander dispatch/maintenance
 *        - Supports offline automatic completion OR fast-repair via consumable/silver
 *        - Integrated basic Ship Construction / New Ship Registration
 *   3. Custom Building Builder (自定义建筑类型建造器)
 *        - Players freely create, edit, upgrade, station shipgirls in, or demolish custom facilities
 *        - Aggregates global passive buffs (resource regen acceleration, EXP boost, morale boost, stat bonus)
 */

import { clamp } from './calc-engine.js';
import { formatDurationZh } from './entity-system.js';
import { SHIP_TYPE_PRESETS } from './stat-rules.js';
import { LOG_CATEGORIES } from './log-system.js';

const STORAGE_NS = 'core-port-buildings';
const STATE_KEY = 'port-buildings-v1';

export const CUSTOM_BUFF_TYPES = Object.freeze([
  { id: 'resource_regen', label: '资源恢复加速 (%)', unit: '%' },
  { id: 'exp_boost', label: '指挥官经验提升 (%)', unit: '%' },
  { id: 'morale_boost', label: '港区士气恢复加速 (%)', unit: '%' },
  { id: 'stat_boost', label: '全队指定属性微调 (+)', unit: '' },
]);

export const CUSTOM_BUFF_TYPE_MAP = Object.freeze(
  Object.fromEntries(CUSTOM_BUFF_TYPES.map((b) => [b.id, b]))
);

const SHIP_TYPE_BASE_TEMPLATES = {
  驱逐舰: { maxHp: 76, firepower: 44, armor: 34, torpedo: 74, evasion: 76, recon: 60, aa: 54, asw: 74 },
  轻巡洋舰: { maxHp: 92, firepower: 58, armor: 50, torpedo: 56, evasion: 64, recon: 70, aa: 68, asw: 64 },
  重巡洋舰: { maxHp: 112, firepower: 72, armor: 68, torpedo: 46, evasion: 54, recon: 62, aa: 60, asw: 36 },
  战列舰: { maxHp: 135, firepower: 88, armor: 84, torpedo: 10, evasion: 36, recon: 48, aa: 68, asw: 20 },
  航空母舰: { maxHp: 118, firepower: 64, armor: 60, torpedo: 20, evasion: 50, recon: 84, aa: 82, asw: 38 },
  潜艇: { maxHp: 56, firepower: 28, armor: 26, torpedo: 86, evasion: 70, recon: 58, aa: 20, asw: 44 },
  工作舰: { maxHp: 88, firepower: 24, armor: 46, torpedo: 12, evasion: 42, recon: 66, aa: 56, asw: 40 },
};

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function createDefaultBuildingsState() {
  return {
    dormitory: {
      level: 1,
      capacity: 3,
      maxCapacity: 12,
      residents: [],
      moralePerMin: 1.2,
      affinityPerHour: 1.8,
      lastSettledAt: Date.now(),
    },
    dockyard: {
      level: 1,
      capacity: 2,
      maxCapacity: 6,
      queue: [],
      completedRepairs: 0,
      constructedCount: 0,
    },
    customBuildings: [],
    updatedAt: Date.now(),
  };
}

export class PortBuildingsSystem {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   entities: import('./entity-system.js').EntitySystem,
   *   inventory: import('./inventory-system.js').InventorySystem,
   *   resources: import('./resource-manager.js').ResourceManager,
   *   commander: import('./commander-system.js').CommanderSystem,
   *   logs?: import('./log-system.js').LogSystem | null,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({
    storage,
    entities,
    inventory,
    resources,
    commander,
    personalityPool = null,
    dialogueEngine = null,
    logs = null,
    bus = null,
  }) {
    this._storage = storage;
    this._scope = storage.namespace(STORAGE_NS);
    this._entities = entities;
    this._inventory = inventory;
    this._resources = resources;
    this._commander = commander;
    this._personalityPool = personalityPool;
    this._dialogueEngine = dialogueEngine;
    this._logs = logs;
    this._bus = bus;

    this._state = createDefaultBuildingsState();
    this._hydrated = false;

    if (this._bus) {
      this._bus.on('character:deleted', ({ characterId }) => {
        this._cleanupDeletedCharacter(characterId);
      });
    }
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
      this.deserialize(saved, { persist: false });
    } else {
      this._state = createDefaultBuildingsState();
      await this.persist();
    }
    await this.settleOfflineBuildings();
    this.syncCustomBuildingModifiers();
    this._hydrated = true;
  }

  async persist() {
    this._state.updatedAt = Date.now();
    await this._scope.setLarge(STATE_KEY, this.serialize());
  }

  _cleanupDeletedCharacter(characterId) {
    const cid = String(characterId);
    let changed = false;
    if (this._state.dormitory.residents.includes(cid)) {
      this._state.dormitory.residents = this._state.dormitory.residents.filter((id) => id !== cid);
      changed = true;
    }
    const prevQ = this._state.dockyard.queue.length;
    this._state.dockyard.queue = this._state.dockyard.queue.filter((q) => q.characterId !== cid);
    if (this._state.dockyard.queue.length !== prevQ) changed = true;

    for (const b of this._state.customBuildings) {
      if (Array.isArray(b.stationedIds) && b.stationedIds.includes(cid)) {
        b.stationedIds = b.stationedIds.filter((id) => id !== cid);
        changed = true;
      }
    }
    if (changed) {
      this.syncCustomBuildingModifiers();
      this.persist();
      this._emit('buildings:updated', { reason: 'cleanup' });
    }
  }

  _syncDockTasksToEntitySystem() {
    if (!this._entities) return;
    for (const item of this._state.dockyard.queue) {
      this._entities.registerTask({
        id: `dock_task_${item.characterId}`,
        label: `船坞维修 · ${item.characterName}`,
        durationSec: item.durationSec,
        startedAt: item.startedAt,
        meta: { type: 'dockyard', characterId: item.characterId },
      });
    }
  }

  /**
   * Settle offline time delta for Dormitory residents (morale + trickle affinity)
   * and auto-complete any finished Dockyard repairs whose endAt has passed.
   */
  async settleOfflineBuildings(now = Date.now()) {
    let changed = false;

    // 1. Dormitory offline recovery via EntitySystem.settleOfflineTime
    const dorm = this._state.dormitory;
    const validResidents = dorm.residents.filter((id) => this._entities?.has(id));
    if (validResidents.length !== dorm.residents.length) {
      dorm.residents = validResidents;
      changed = true;
    }

    const elapsedMs = Math.max(0, now - (Number(dorm.lastSettledAt) || now));
    if (validResidents.length > 0 && elapsedMs >= 60 * 1000) {
      const cmdMoraleMult = this._commander ? this._commander.getMoraleRecoveryMultiplier() : 1.0;
      const customBuffs = this.getGlobalBuffSummary();
      const totalMoraleRate = dorm.moralePerMin * (1 + (dorm.level - 1) * 0.15) * cmdMoraleMult * (1 + customBuffs.moraleBoostPct / 100);
      const affRatePerMin = (dorm.affinityPerHour * (1 + (dorm.level - 1) * 0.12)) / 60;

      const rules = [];
      for (const cid of validResidents) {
        const entity = this._entities.get(cid);
        const maxAff = Number(entity?.statBounds?.affinity?.max ?? 100);
        rules.push(
          { entityId: cid, stat: 'morale', ratePerMinute: totalMoraleRate, min: 0, max: 100, round: 'round' },
          { entityId: cid, stat: 'affinity', ratePerMinute: affRatePerMin, min: 0, max: maxAff, round: 'round' }
        );
      }
      this._entities.settleOfflineTime({ lastTimestamp: dorm.lastSettledAt, now, rules });
      dorm.lastSettledAt = now;
      changed = true;
    } else if (!dorm.lastSettledAt) {
      dorm.lastSettledAt = now;
      changed = true;
    }

    // 2. Auto-complete finished Dockyard queue entries
    const finished = this._state.dockyard.queue.filter((q) => now >= q.endAt);
    for (const job of finished) {
      await this.completeDockRepair(job.characterId, { now, silent: true });
      changed = true;
    }

    this._syncDockTasksToEntitySystem();
    if (changed) {
      await this.persist();
    }
    return { settledDormResidents: validResidents.length, autoCompletedRepairs: finished.length };
  }

  // ------------------------------------------------------------
  // 1. Dormitory (宿舍) Operations
  // ------------------------------------------------------------

  getDormitoryState() {
    const dorm = this._state.dormitory;
    const residents = dorm.residents
      .map((id) => this._entities?.get(id))
      .filter(Boolean)
      .map((c) => ({
        id: c.id,
        name: c.name,
        shipType: c.meta?.shipType || '驱逐舰',
        morale: Math.round(Number(c.stats.morale ?? 60)),
        affinity: Math.round(Number(c.stats.affinity ?? 0)),
      }));
    const expandCost = {
      steel: 120 * dorm.capacity,
      bauxite: 60 * dorm.capacity,
      silver: 150 * dorm.capacity,
    };
    return {
      ...deepClone(dorm),
      residentDetails: residents,
      expandCost,
      canExpand: dorm.capacity < dorm.maxCapacity,
    };
  }

  isInDormitory(characterId) {
    return this._state.dormitory.residents.includes(String(characterId));
  }

  isInDockyard(characterId) {
    return this._state.dockyard.queue.some((q) => q.characterId === String(characterId));
  }

  /**
   * Compute global status badges for any shipgirl across Dockyard, Expedition, Formation, Dormitory, and Secretary.
   */
  getCharacterGlobalStatus(characterId, { formation = null, expeditions = null, interaction = null } = {}) {
    const cid = String(characterId || '');
    const inDorm = this.isInDormitory(cid);
    const inDock = this.isInDockyard(cid);
    const onExpedition = Boolean(expeditions && typeof expeditions.isCharacterDispatched === 'function' && expeditions.isCharacterDispatched(cid));
    const inFleet = Boolean(formation && typeof formation.getMemberIds === 'function' && formation.getMemberIds().includes(cid));
    const isSecretary = Boolean(interaction && typeof interaction.getSecretaryId === 'function' && interaction.getSecretaryId() === cid);

    const badges = [];
    if (inDock) badges.push({ id: 'dock', label: '船坞维修中', tone: 'danger' });
    if (onExpedition) badges.push({ id: 'expedition', label: '远征派遣中', tone: 'warn' });
    if (inFleet) badges.push({ id: 'fleet', label: '出征编队中', tone: 'ok' });
    if (inDorm) badges.push({ id: 'dorm', label: '宿舍休整中', tone: 'ok' });
    if (badges.length === 0) badges.push({ id: 'idle', label: '待命', tone: 'muted' });

    const primary = badges[0];
    return {
      primaryLabel: primary.label,
      primaryTone: primary.tone,
      badges,
      inDorm,
      inDock,
      inFleet,
      onExpedition,
      isSecretary,
    };
  }

  async assignDormResident(characterId) {
    const cid = String(characterId);
    const actor = this._entities?.get(cid);
    if (!actor || actor.kind !== 'character') throw new Error('角色不存在');
    const dorm = this._state.dormitory;
    if (dorm.residents.includes(cid)) {
      throw new Error(`「${actor.name}」已入住港区宿舍`);
    }
    if (dorm.residents.length >= dorm.capacity) {
      throw new Error(`宿舍床位已满（${dorm.residents.length}/${dorm.capacity}），请先扩建宿舍或移出其他角色`);
    }
    dorm.residents.push(cid);
    dorm.lastSettledAt = Date.now();
    await this.persist();
    const restLine = this._dialogueEngine ? this._dialogueEngine.composeDormRestLine(actor) : '';
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        actorId: cid,
        actorName: actor.name,
        title: `[${actor.name}] 入住港区宿舍`,
        detail: `${restLine ? `${restLine} | ` : ''}当前宿舍入住 ${dorm.residents.length}/${dorm.capacity}，离线将自动恢复士气与好感`,
      });
    }
    this._emit('buildings:dorm-changed', { action: 'assign', characterId: cid, restLine });
    this._emit('buildings:updated', { reason: 'dorm-assign' });
    return { ...this.getDormitoryState(), restLine };
  }

  async removeDormResident(characterId) {
    const cid = String(characterId);
    const dorm = this._state.dormitory;
    if (!dorm.residents.includes(cid)) return this.getDormitoryState();
    dorm.residents = dorm.residents.filter((id) => id !== cid);
    await this.persist();
    this._emit('buildings:dorm-changed', { action: 'remove', characterId: cid });
    this._emit('buildings:updated', { reason: 'dorm-remove' });
    return this.getDormitoryState();
  }

  async expandDormitory() {
    const dorm = this._state.dormitory;
    if (dorm.capacity >= dorm.maxCapacity) {
      throw new Error(`宿舍已达最大床位上限（${dorm.maxCapacity} 床位）`);
    }
    const cost = this.getDormitoryState().expandCost;
    const spend = await this._resources.spendBatch(cost, { reason: '扩建港区宿舍床位' });
    if (!spend.ok) throw new Error(spend.reason);

    dorm.capacity += 1;
    dorm.level += 1;
    await this.persist();
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.RESOURCE,
        title: `扩建港区宿舍至 Lv.${dorm.level}（${dorm.capacity} 床位）`,
        detail: `消耗：钢材 ${cost.steel} / 铝材 ${cost.bauxite} / 银条 ${cost.silver}`,
      });
    }
    this._emit('buildings:dorm-changed', { action: 'expand', capacity: dorm.capacity });
    this._emit('buildings:updated', { reason: 'dorm-expand' });
    return this.getDormitoryState();
  }

  async feedDormitory() {
    const dorm = this._state.dormitory;
    const residents = dorm.residents.map((id) => this._entities?.get(id)).filter(Boolean);
    if (residents.length === 0) throw new Error('宿舍当前没有入住角色，请先分配角色入住');

    const cost = { fuel: 25 * residents.length, silver: 30 * residents.length };
    const spend = await this._resources.spendBatch(cost, { reason: '宿舍投喂补给' });
    if (!spend.ok) throw new Error(spend.reason);

    const affMult = this._commander ? this._commander.getAffinityGainMultiplier() : 1.0;
    const affGain = Math.max(1, Math.round(2 * affMult));
    const moraleGain = 14;

    for (const c of residents) {
      const maxAff = Number(c.statBounds?.affinity?.max ?? 100);
      this._entities.adjustStat(c.id, 'morale', moraleGain, { min: 0, max: 100 });
      this._entities.adjustStat(c.id, 'affinity', affGain, { min: 0, max: maxAff });
    }
    dorm.lastSettledAt = Date.now();
    await this.persist();
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.STAT,
        title: `宿舍投喂补给（${residents.length} 名入住舰娘）`,
        detail: `全员士气 +${moraleGain}、好感 +${affGain} | 消耗：燃油 ${cost.fuel} / 银条 ${cost.silver}`,
      });
    }
    this._emit('buildings:dorm-changed', { action: 'feed', count: residents.length });
    this._emit('buildings:updated', { reason: 'dorm-feed' });
    return { count: residents.length, moraleGain, affGain, cost };
  }

  // ------------------------------------------------------------
  // 2. Dockyard (船坞) Repair Queue & Ship Construction
  // ------------------------------------------------------------

  isInDockyard(characterId) {
    return this._state.dockyard.queue.some((q) => q.characterId === String(characterId));
  }

  computeDockRepairPlan(characterId) {
    const cid = String(characterId);
    const actor = this._entities?.get(cid);
    if (!actor) throw new Error('角色不存在');

    const effMaxHp = Math.max(1, Math.round(this._entities.getEffectiveStat(cid, 'maxHp', { round: 'round' }).final));
    const curHp = clamp(Math.round(Number(actor.stats.hp ?? effMaxHp)), 0, effMaxHp);
    const missingHp = Math.max(0, effMaxHp - curHp);
    const isMaintenanceOnly = missingHp === 0;

    const dispatchDisc = this._commander ? this._commander.getRepairCostDiscount() : 0;
    const maintDisc = this._commander ? this._commander.getEnhanceCostDiscount() * 0.5 : 0;
    const costScale = Math.max(0.45, 1 - dispatchDisc);
    const timeScale = Math.max(0.5, 1 - maintDisc);

    const cost = isMaintenanceOnly
      ? {
          steel: Math.max(8, Math.round(18 * costScale)),
          bauxite: Math.max(4, Math.round(8 * costScale)),
        }
      : {
          steel: Math.max(12, Math.round(missingHp * 1.45 * costScale)),
          bauxite: Math.max(5, Math.round(missingHp * 0.55 * costScale)),
        };

    const durationSec = isMaintenanceOnly
      ? Math.max(20, Math.round(45 * timeScale))
      : Math.max(30, Math.round((40 + missingHp * 3.5) * timeScale));

    return {
      characterId: cid,
      characterName: actor.name,
      curHp,
      effMaxHp,
      missingHp,
      isMaintenanceOnly,
      cost,
      durationSec,
      durationText: formatDurationZh(durationSec),
      discountPct: Math.round(dispatchDisc * 100),
    };
  }

  getDockyardState(now = Date.now()) {
    const dock = this._state.dockyard;
    const queue = dock.queue.map((job) => {
      const remainingSec = Math.max(0, Math.ceil((job.endAt - now) / 1000));
      const elapsedSec = Math.max(0, (now - job.startedAt) / 1000);
      const progress = clamp(elapsedSec / Math.max(1, job.durationSec), 0, 1);
      return {
        ...deepClone(job),
        remainingSec,
        remainingText: remainingSec <= 0 ? '维修完成 · 可出渠' : formatDurationZh(remainingSec),
        progress: Number(progress.toFixed(4)),
        ready: remainingSec <= 0,
      };
    });
    const expandCost = {
      steel: 220 * dock.capacity,
      bauxite: 140 * dock.capacity,
      silver: 240 * dock.capacity,
    };
    return {
      ...deepClone(dock),
      queue,
      expandCost,
      canExpand: dock.capacity < dock.maxCapacity,
    };
  }

  async startDockRepair(characterId) {
    const cid = String(characterId);
    const dock = this._state.dockyard;
    if (this.isInDockyard(cid)) throw new Error('该角色已在船坞维修渠位中');
    if (dock.queue.length >= dock.capacity) {
      throw new Error(`船坞渠位已满（${dock.queue.length}/${dock.capacity}），请等待完成或扩建渠位`);
    }
    const plan = this.computeDockRepairPlan(cid);
    const spend = await this._resources.spendBatch(plan.cost, {
      reason: `船坞入渠${plan.isMaintenanceOnly ? '保养' : '维修'}（${plan.characterName}）`,
    });
    if (!spend.ok) throw new Error(spend.reason);

    const now = Date.now();
    const job = {
      bayId: `bay_${now.toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      characterId: cid,
      characterName: plan.characterName,
      missingHp: plan.missingHp,
      effMaxHp: plan.effMaxHp,
      isMaintenanceOnly: plan.isMaintenanceOnly,
      cost: plan.cost,
      startedAt: now,
      durationSec: plan.durationSec,
      endAt: now + plan.durationSec * 1000,
    };

    dock.queue.push(job);
    this._syncDockTasksToEntitySystem();
    await this.persist();

    const dockActor = this._entities?.get(cid);
    const repairLine = this._dialogueEngine && dockActor ? this._dialogueEngine.composeDockRepairLine(dockActor, { isComplete: false }) : '';
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.STAT,
        actorId: cid,
        actorName: plan.characterName,
        title: `[${plan.characterName}] 进入船坞${plan.isMaintenanceOnly ? '预防性船体保养' : '入渠维修'}`,
        detail: `${repairLine ? `${repairLine} | ` : ''}预计耗时 ${plan.durationText} | 消耗：钢材 ${plan.cost.steel} / 铝材 ${plan.cost.bauxite}`,
      });
    }

    this._emit('buildings:dock-started', { job: deepClone(job), repairLine });
    this._emit('buildings:updated', { reason: 'dock-start' });
    return { ...deepClone(job), repairLine };
  }

  async completeDockRepair(characterId, { now = Date.now(), fastRepair = false, silent = false } = {}) {
    const cid = String(characterId);
    const dock = this._state.dockyard;
    const idx = dock.queue.findIndex((q) => q.characterId === cid);
    if (idx < 0) return null;
    const job = dock.queue[idx];

    if (!fastRepair && now < job.endAt) {
      throw new Error(`维修尚未完成，剩余 ${formatDurationZh(Math.ceil((job.endAt - now) / 1000))}`);
    }

    let fastMethod = null;
    if (fastRepair && now < job.endAt) {
      // Prefer consuming 1x medkit consumable if owned, otherwise small silver express fee
      const med = this._inventory?.getItem('item_consumable_med');
      if (med && med.quantity > 0) {
        await this._inventory.updateItem(med.id, { quantity: med.quantity - 1 });
        fastMethod = '应急损管修复包 ×1';
      } else {
        const fee = { silver: 40 };
        const sp = await this._resources.spendBatch(fee, { reason: `船坞快速修复（${job.characterName}）` });
        if (!sp.ok) throw new Error('应急损管包不足且银条不足（需 40 银条）');
        fastMethod = '银条 40';
      }
    }

    const actor = this._entities?.get(cid);
    if (actor) {
      const effMaxHp = Math.max(1, Math.round(this._entities.getEffectiveStat(cid, 'maxHp', { round: 'round' }).final));
      this._entities.setStat(cid, 'hp', effMaxHp, { min: 0, max: effMaxHp });
      this._entities.adjustStat(cid, 'morale', job.isMaintenanceOnly ? 10 : 6, { min: 0, max: 100 });
      this._entities.adjustStat(cid, 'ap', 20, { min: 0, max: Number(actor.stats.maxAp ?? 100) });
    }

    dock.queue.splice(idx, 1);
    dock.completedRepairs += 1;
    this._entities?.removeTask(`dock_task_${cid}`);
    await this.persist();

    const completeLine = this._dialogueEngine && actor ? this._dialogueEngine.composeDockRepairLine(actor, { isComplete: true }) : '';
    if (!silent && this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.STAT,
        actorId: cid,
        actorName: job.characterName,
        title: `[${job.characterName}] 船坞${fastRepair ? '快速修复' : '维修'}完成出渠`,
        detail: `${completeLine ? `${completeLine} | ` : ''}耐久已恢复满值${fastMethod ? `（快速修复消耗：${fastMethod}）` : ''}`,
      });
    }

    this._emit('buildings:dock-completed', { characterId: cid, fastRepair, fastMethod, completeLine });
    this._emit('buildings:updated', { reason: 'dock-complete' });
    return { characterId: cid, characterName: job.characterName, fastMethod, completeLine };
  }

  async expandDockyard() {
    const dock = this._state.dockyard;
    if (dock.capacity >= dock.maxCapacity) {
      throw new Error(`船坞已达最大渠位上限（${dock.maxCapacity} 渠位）`);
    }
    const cost = this.getDockyardState().expandCost;
    const spend = await this._resources.spendBatch(cost, { reason: '扩建船坞维修渠位' });
    if (!spend.ok) throw new Error(spend.reason);

    dock.capacity += 1;
    dock.level += 1;
    await this.persist();
    this._emit('buildings:updated', { reason: 'dock-expand' });
    return this.getDockyardState();
  }

  /**
   * Construct & register a new shipgirl at the Dockyard, spending basic naval resources.
   */
  async constructShip({ name, shipType = '驱逐舰', cost = { fuel: 80, ammo: 60, steel: 100, bauxite: 50 } } = {}) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('请输入新舰名称');
    const cleanType = String(shipType || '驱逐舰').trim() || '驱逐舰';

    const spend = await this._resources.spendBatch(cost, { reason: `船坞建造登记「${cleanName}」` });
    if (!spend.ok) throw new Error(spend.reason);

    const tpl = SHIP_TYPE_BASE_TEMPLATES[cleanType] || SHIP_TYPE_BASE_TEMPLATES['驱逐舰'];
    const initialAffBonus = this._commander ? this._commander.getInitialAffinityBonus() : 0;
    const charId = `char_dock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

    // Same ship, different personality: avoid repeating the last same-name ship's combo key
    const existingSameName = this._entities
      .list({ kind: 'character' })
      .filter((c) => c.name === cleanName && c.meta?.personalityCombo?.key);
    const avoidKey = existingSameName.length > 0 ? existingSameName[existingSameName.length - 1].meta.personalityCombo.key : null;
    const rolledCombo = this._personalityPool ? this._personalityPool.rollCombination({ avoidKey }) : null;

    const entity = this._entities.register({
      id: charId,
      kind: 'character',
      name: cleanName,
      tags: [cleanType, '船坞建造', ...(rolledCombo ? [rolledCombo.primaryName, rolledCombo.secondaryName] : [])],
      stats: {
        ...tpl,
        hp: tpl.maxHp,
        morale: 80,
        ap: 100,
        maxAp: 100,
        affinity: clamp(20 + initialAffBonus, 0, 100),
        level: 1,
        exp: 0,
        maxExp: 100,
      },
      statBounds: {
        hp: { min: 0, max: 500 },
        morale: { min: 0, max: 100 },
        ap: { min: 0, max: 100 },
        affinity: { min: 0, max: 100 },
      },
      meta: {
        shipType: cleanType,
        roleTag: rolledCombo ? `${cleanType} · ${rolledCombo.comboLabel}` : `${cleanType} · 船坞新锐`,
        avatarAssetId: null,
        personalityCombo: rolledCombo,
        personality:
          rolledCombo?.description ||
          '刚从港区船坞下水的新锐舰娘，干劲十足，期待与指挥官共同出击。',
        speechHabit: rolledCombo?.speechHabit || `「${cleanName}，正式向指挥官报到！」`,
      },
    });

    // Auto-equip starter core parts if present in warehouse so newly built ship is seaworthy right away
    if (this._inventory) {
      if (this._inventory.getItem('item_core_engine_01')) {
        await this._inventory.equipItem(charId, 'engine', 'item_core_engine_01');
      }
      if (this._inventory.getItem('item_core_armor_01')) {
        await this._inventory.equipItem(charId, 'armor', 'item_core_armor_01');
      }
      if (this._inventory.getItem('item_core_core_01')) {
        await this._inventory.equipItem(charId, 'core', 'item_core_core_01');
      }
      const effMaxHp = Math.round(this._entities.getEffectiveStat(charId, 'maxHp', { round: 'round' }).final);
      this._entities.setStat(charId, 'hp', effMaxHp, { min: 0, max: effMaxHp });
    }

    this._state.dockyard.constructedCount += 1;
    await this.persist();

    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.CHARACTER,
        actorId: charId,
        actorName: cleanName,
        title: `船坞新建造登记「${cleanName}」（${cleanType}）`,
        detail: `初始耐久 ${tpl.maxHp} / 火力 ${tpl.firepower} / 装甲 ${tpl.armor}`,
      });
    }
    this._emit('character:saved', { characterId: charId, name: cleanName, isEdit: false, source: 'dockyard' });
    this._emit('buildings:updated', { reason: 'dock-construct' });
    return entity;
  }

  // ------------------------------------------------------------
  // 3. Custom Building Builder (自定义建筑类型建造器)
  // ------------------------------------------------------------

  listCustomBuildings() {
    return this._state.customBuildings.map((b) => {
      const nextCost = this.getCustomUpgradeCost(b);
      const totalBuff = this._computeSingleBuildingBuffValue(b);
      return {
        ...deepClone(b),
        nextUpgradeCost: nextCost,
        totalBuffValue: totalBuff,
        buffLabel: CUSTOM_BUFF_TYPE_MAP[b.buffType]?.label || b.buffType,
      };
    });
  }

  getCustomBuilding(buildingId) {
    return this.listCustomBuildings().find((b) => b.id === String(buildingId)) || null;
  }

  _computeSingleBuildingBuffValue(b) {
    const lv = Math.max(1, Number(b.level) || 1);
    const stationed = Array.isArray(b.stationedIds) ? b.stationedIds.filter((id) => this._entities?.has(id)).length : 0;
    const perLv = Math.max(1, Number(b.buffValuePerLevel) || 4);
    return Number((perLv * lv + stationed * Math.max(1, Math.round(perLv * 0.5))).toFixed(1));
  }

  getCustomUpgradeCost(b) {
    const lv = Math.max(1, Number(b.level) || 1);
    const base = b.upgradeCost || { steel: 80, bauxite: 40, silver: 80 };
    const out = {};
    for (const [k, v] of Object.entries(base)) {
      const n = Math.max(0, Math.round((Number(v) || 0) * lv));
      if (n > 0) out[k] = n;
    }
    return out;
  }

  async createCustomBuilding(def = {}) {
    const name = String(def.name || '').trim();
    if (!name) throw new Error('自定义建筑名称不能为空');

    const buildCost = {
      steel: Math.max(0, Math.round(Number(def.buildCost?.steel ?? def.upgradeCost?.steel ?? 60))),
      bauxite: Math.max(0, Math.round(Number(def.buildCost?.bauxite ?? def.upgradeCost?.bauxite ?? 30))),
      silver: Math.max(0, Math.round(Number(def.buildCost?.silver ?? def.upgradeCost?.silver ?? 60))),
    };
    const nonZeroCost = Object.fromEntries(Object.entries(buildCost).filter(([, v]) => v > 0));
    if (Object.keys(nonZeroCost).length > 0 && def.chargeBuildCost !== false) {
      const spend = await this._resources.spendBatch(nonZeroCost, { reason: `建造自定义设施「${name}」` });
      if (!spend.ok) throw new Error(spend.reason);
    }

    const building = {
      id: String(def.id || `bld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`),
      name,
      typeTag: String(def.typeTag || '后勤设施').trim() || '自定义设施',
      description: String(def.description || '玩家自定义的港区扩展设施。').trim(),
      level: clamp(Math.floor(Number(def.level) || 1), 1, 10),
      maxLevel: clamp(Math.floor(Number(def.maxLevel) || 10), 1, 20),
      stationCap: clamp(Math.floor(Number(def.stationCap ?? 2)), 0, 6),
      stationedIds: Array.isArray(def.stationedIds) ? def.stationedIds.map(String) : [],
      upgradeCost: {
        fuel: Math.max(0, Math.round(Number(def.upgradeCost?.fuel ?? 0))),
        ammo: Math.max(0, Math.round(Number(def.upgradeCost?.ammo ?? 0))),
        steel: Math.max(0, Math.round(Number(def.upgradeCost?.steel ?? 80))),
        bauxite: Math.max(0, Math.round(Number(def.upgradeCost?.bauxite ?? 40))),
        silver: Math.max(0, Math.round(Number(def.upgradeCost?.silver ?? 80))),
      },
      buffType: CUSTOM_BUFF_TYPE_MAP[def.buffType] ? def.buffType : 'resource_regen',
      buffStat: String(def.buffStat || 'firepower').trim(),
      buffValuePerLevel: clamp(Number(def.buffValuePerLevel ?? 5) || 5, 1, 50),
      createdAt: Date.now(),
    };

    this._state.customBuildings.push(building);
    this.syncCustomBuildingModifiers();
    await this.persist();

    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        title: `港区新建自定义设施「${building.name}」`,
        detail: `类型：${building.typeTag} | 增益：${CUSTOM_BUFF_TYPE_MAP[building.buffType]?.label} (+${building.buffValuePerLevel}/级)`,
      });
    }
    this._emit('buildings:custom-created', { building: deepClone(building) });
    this._emit('buildings:updated', { reason: 'custom-create' });
    return this.getCustomBuilding(building.id);
  }

  async updateCustomBuilding(buildingId, patch = {}) {
    const target = this._state.customBuildings.find((b) => b.id === String(buildingId));
    if (!target) throw new Error('目标建筑不存在');
    if (patch.name !== undefined && String(patch.name).trim()) target.name = String(patch.name).trim();
    if (patch.typeTag !== undefined) target.typeTag = String(patch.typeTag).trim() || target.typeTag;
    if (patch.description !== undefined) target.description = String(patch.description).trim();
    if (patch.stationCap !== undefined) {
      target.stationCap = clamp(Math.floor(Number(patch.stationCap) || 0), 0, 6);
      target.stationedIds = target.stationedIds.slice(0, target.stationCap);
    }
    if (patch.buffType && CUSTOM_BUFF_TYPE_MAP[patch.buffType]) target.buffType = patch.buffType;
    if (patch.buffStat) target.buffStat = String(patch.buffStat).trim();
    if (patch.buffValuePerLevel !== undefined) {
      target.buffValuePerLevel = clamp(Number(patch.buffValuePerLevel) || 5, 1, 50);
    }
    if (patch.upgradeCost && typeof patch.upgradeCost === 'object') {
      target.upgradeCost = { ...target.upgradeCost, ...patch.upgradeCost };
    }
    this.syncCustomBuildingModifiers();
    await this.persist();
    this._emit('buildings:updated', { reason: 'custom-update', buildingId: target.id });
    return this.getCustomBuilding(target.id);
  }

  async upgradeCustomBuilding(buildingId) {
    const target = this._state.customBuildings.find((b) => b.id === String(buildingId));
    if (!target) throw new Error('目标建筑不存在');
    if (target.level >= target.maxLevel) throw new Error(`「${target.name}」已达最高等级 Lv.${target.maxLevel}`);

    const cost = this.getCustomUpgradeCost(target);
    if (Object.keys(cost).length > 0) {
      const spend = await this._resources.spendBatch(cost, { reason: `升级建筑「${target.name}」至 Lv.${target.level + 1}` });
      if (!spend.ok) throw new Error(spend.reason);
    }
    target.level += 1;
    this.syncCustomBuildingModifiers();
    await this.persist();

    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.RESOURCE,
        title: `升级设施「${target.name}」至 Lv.${target.level}`,
        detail: `当前总增益：+${this._computeSingleBuildingBuffValue(target)}${CUSTOM_BUFF_TYPE_MAP[target.buffType]?.unit || ''}`,
      });
    }
    this._emit('buildings:custom-upgraded', { buildingId: target.id, level: target.level });
    this._emit('buildings:updated', { reason: 'custom-upgrade' });
    return this.getCustomBuilding(target.id);
  }

  async assignCustomStation(buildingId, characterId) {
    const target = this._state.customBuildings.find((b) => b.id === String(buildingId));
    if (!target) throw new Error('目标建筑不存在');
    const cid = String(characterId);
    if (!this._entities?.has(cid)) throw new Error('角色不存在');
    if (target.stationedIds.includes(cid)) return this.getCustomBuilding(target.id);
    if (target.stationedIds.length >= target.stationCap) {
      throw new Error(`「${target.name}」驻守人数已满（${target.stationCap}人）`);
    }
    target.stationedIds.push(cid);
    this.syncCustomBuildingModifiers();
    await this.persist();
    this._emit('buildings:updated', { reason: 'custom-station' });
    return this.getCustomBuilding(target.id);
  }

  async removeCustomStation(buildingId, characterId) {
    const target = this._state.customBuildings.find((b) => b.id === String(buildingId));
    if (!target) return null;
    target.stationedIds = target.stationedIds.filter((id) => id !== String(characterId));
    this.syncCustomBuildingModifiers();
    await this.persist();
    this._emit('buildings:updated', { reason: 'custom-unstation' });
    return this.getCustomBuilding(target.id);
  }

  async deleteCustomBuilding(buildingId) {
    const idx = this._state.customBuildings.findIndex((b) => b.id === String(buildingId));
    if (idx < 0) return false;
    this._state.customBuildings.splice(idx, 1);
    this.syncCustomBuildingModifiers();
    await this.persist();
    this._emit('buildings:updated', { reason: 'custom-delete' });
    return true;
  }

  /**
   * Compute aggregated global passive buffs from all custom buildings.
   */
  getGlobalBuffSummary() {
    const summary = {
      resourceRegenPct: 0,
      expBoostPct: 0,
      moraleBoostPct: 0,
      statBonuses: {},
    };
    for (const b of this._state.customBuildings) {
      const val = this._computeSingleBuildingBuffValue(b);
      if (b.buffType === 'resource_regen') summary.resourceRegenPct += val;
      else if (b.buffType === 'exp_boost') summary.expBoostPct += val;
      else if (b.buffType === 'morale_boost') summary.moraleBoostPct += val;
      else if (b.buffType === 'stat_boost' && b.buffStat) {
        summary.statBonuses[b.buffStat] = (summary.statBonuses[b.buffStat] || 0) + val;
      }
    }
    return summary;
  }

  /**
   * Sync custom building stat_boost buffs onto all character entities via EntitySystem modifiers.
   */
  syncCustomBuildingModifiers() {
    if (!this._entities) return;
    const summary = this.getGlobalBuffSummary();
    const chars = this._entities.list({ kind: 'character' });
    for (const c of chars) {
      const prevIds = (c.modifiers || [])
        .filter((m) => String(m.id || '').startsWith('bld_buff_'))
        .map((m) => m.id);
      for (const mid of prevIds) {
        this._entities.removeModifier(c.id, mid);
      }
      for (const [statKey, val] of Object.entries(summary.statBonuses)) {
        if (val !== 0) {
          this._entities.addModifier(c.id, {
            id: `bld_buff_${statKey}`,
            stat: statKey,
            layer: 'baseAdd',
            value: val,
            source: '港区自定义设施加成',
            enabled: true,
          });
        }
      }
    }
  }

  serialize() {
    return {
      version: 1,
      ...deepClone(this._state),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const def = createDefaultBuildingsState();
    this._state = {
      dormitory: {
        ...def.dormitory,
        ...(snapshot.dormitory || {}),
        residents: Array.isArray(snapshot.dormitory?.residents) ? snapshot.dormitory.residents.map(String) : [],
      },
      dockyard: {
        ...def.dockyard,
        ...(snapshot.dockyard || {}),
        queue: Array.isArray(snapshot.dockyard?.queue) ? deepClone(snapshot.dockyard.queue) : [],
      },
      customBuildings: Array.isArray(snapshot.customBuildings) ? deepClone(snapshot.customBuildings) : [],
      updatedAt: Number(snapshot.updatedAt) || Date.now(),
    };
    this._syncDockTasksToEntitySystem();
    this.syncCustomBuildingModifiers();
    if (persist) this.persist();
  }
}

export { SHIP_TYPE_PRESETS };
