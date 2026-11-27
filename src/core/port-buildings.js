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
  驱逐舰: { maxHp: 24, firepower: 13, armor: 10, torpedo: 23, evasion: 24, recon: 17, aa: 15, asw: 22 },
  轻巡洋舰: { maxHp: 28, firepower: 17, armor: 15, torpedo: 18, evasion: 20, recon: 20, aa: 20, asw: 19 },
  重巡洋舰: { maxHp: 34, firepower: 22, armor: 21, torpedo: 15, evasion: 16, recon: 18, aa: 18, asw: 11 },
  战列舰: { maxHp: 42, firepower: 25, armor: 25, torpedo: 8, evasion: 11, recon: 15, aa: 20, asw: 8 },
  航空母舰: { maxHp: 38, firepower: 21, armor: 18, torpedo: 8, evasion: 16, recon: 25, aa: 24, asw: 11 },
  潜艇: { maxHp: 19, firepower: 9, armor: 8, torpedo: 25, evasion: 23, recon: 18, aa: 8, asw: 14 },
  维修舰: { maxHp: 32, firepower: 10, armor: 18, torpedo: 8, evasion: 14, recon: 21, aa: 20, asw: 14 },
  补给舰: { maxHp: 30, firepower: 10, armor: 16, torpedo: 8, evasion: 15, recon: 23, aa: 19, asw: 14 },
  工作舰: { maxHp: 32, firepower: 10, armor: 18, torpedo: 8, evasion: 14, recon: 21, aa: 20, asw: 14 },
};

export const CONSTRUCTION_RECIPE_PRESETS = Object.freeze([
  { id: 'dd_ss', label: '驱逐/潜艇 (30/30/30/30)', fuel: 30, ammo: 30, steel: 30, bauxite: 30 },
  { id: 'balanced', label: '标准均衡 (150/150/180/120)', fuel: 150, ammo: 150, steel: 180, bauxite: 120 },
  { id: 'support_ar_ao', label: '后勤特化 AR/AO (240/140/240/340)', fuel: 240, ammo: 140, steel: 240, bauxite: 340 },
  { id: 'heavy_bb', label: '主力重炮 BB/CA (400/200/550/80)', fuel: 400, ammo: 200, steel: 550, bauxite: 80 },
  { id: 'carrier_cv', label: '航空制空 CV (320/120/320/520)', fuel: 320, ammo: 120, steel: 320, bauxite: 520 },
]);

export const CONSTRUCTION_SHIP_POOL = Object.freeze({
  DD: [
    { key: 'dd_fubuki', name: '吹雪型 · 白浪', shipType: '驱逐舰', roleTag: '高速雷击前锋' },
    { key: 'dd_shimakaze', name: '岛风型 · 疾风', shipType: '驱逐舰', roleTag: '极限航速氧雷' },
    { key: 'dd_akizuki', name: '秋月型 · 凉月', shipType: '驱逐舰', roleTag: '对空警戒驱逐' },
    { key: 'dd_yukikaze', name: '阳炎型 · 祥瑞', shipType: '驱逐舰', roleTag: '高运高闪避前卫' },
  ],
  SS: [
    { key: 'ss_i19', name: '巡潜乙型 · 潜影', shipType: '潜艇', roleTag: '隐蔽先制雷击' },
    { key: 'ss_u511', name: '远洋潜艇 · 暗流', shipType: '潜艇', roleTag: '深水伏击猎手' },
  ],
  CL: [
    { key: 'cl_sendai', name: '川内型 · 夜樱', shipType: '轻巡洋舰', roleTag: '夜战侦查领舰' },
    { key: 'cl_yubari', name: '实验轻巡 · 夕铃', shipType: '轻巡洋舰', roleTag: '多用途反潜防空' },
    { key: 'cl_noshiro', name: '阿贺野型 · 星镜', shipType: '轻巡洋舰', roleTag: '雷达校射核心' },
  ],
  CA: [
    { key: 'ca_takao', name: '高雄型 · 苍岚', shipType: '重巡洋舰', roleTag: '重甲炮雷前排' },
    { key: 'ca_myoko', name: '妙高型 · 曙光', shipType: '重巡洋舰', roleTag: '主力护卫重巡' },
    { key: 'ca_prinz', name: '重巡 · 欧若拉', shipType: '重巡洋舰', roleTag: '高甲盾卫重巡' },
  ],
  BB: [
    { key: 'bb_kongou', name: '高速战列 · 煌星', shipType: '战列舰', roleTag: '高速重炮主力' },
    { key: 'bb_nagato', name: '战列舰 · 铁壁', shipType: '战列舰', roleTag: '远程穿甲齐射' },
    { key: 'bb_yamato', name: '超弩级 · 镇海', shipType: '战列舰', roleTag: '重装旗舰主炮' },
  ],
  CV: [
    { key: 'cv_akagi', name: '正规航母 · 苍穹', shipType: '航空母舰', roleTag: '制空开幕打击' },
    { key: 'cv_shokaku', name: '翔鹤型 · 瑞羽', shipType: '航空母舰', roleTag: '远程舰载轰炸' },
    { key: 'cv_enterprise', name: '特遣航母 · 灰隼', shipType: '航空母舰', roleTag: '全能制空核心' },
  ],
  AR: [
    { key: 'ar_akashi', name: '工作维修舰 · 明石', shipType: '维修舰', roleTag: '战地抢修与锚地专精' },
    { key: 'ar_vestal', name: '远洋维修舰 · 晨星', shipType: '维修舰', roleTag: '损伤管制与应急抢修' },
  ],
  AO: [
    { key: 'ao_hayasui', name: '舰队补给舰 · 汐风', shipType: '补给舰', roleTag: '携带油弹扩容与前线补给' },
    { key: 'ao_kamoi', name: '高速补给舰 · 潮音', shipType: '补给舰', roleTag: '远征增产与士气维持' },
  ],
});

/**
 * Compute live ship-class construction probability table for any 4-resource recipe (30~600 each):
 *   - Low investment -> DD / SS
 *   - High Steel + Fuel -> BB / CA
 *   - High Bauxite -> CV
 *   - Medium-High Bauxite + balanced Fuel/Steel -> boosted AR (维修舰) & AO (补给舰)
 */
export function computeConstructionProbabilities({ fuel = 150, ammo = 150, steel = 150, bauxite = 150 } = {}) {
  const f = clamp(Math.round(Number(fuel) || 30), 30, 600);
  const a = clamp(Math.round(Number(ammo) || 30), 30, 600);
  const s = clamp(Math.round(Number(steel) || 30), 30, 600);
  const b = clamp(Math.round(Number(bauxite) || 30), 30, 600);
  const total = f + a + s + b;

  const weights = {
    DD: 34,
    SS: 10,
    CL: 22,
    CA: 8,
    BB: 2,
    CV: 2,
    AR: 3,
    AO: 3,
  };

  // Low resource formula favors DD & SS
  if (total <= 360) {
    weights.DD += 36;
    weights.SS += 22;
    weights.CL += 12;
  } else if (total <= 720) {
    weights.CL += 18;
    weights.CA += 14;
    weights.DD += 10;
  }

  // High steel + fuel unlocks & boosts BB / CA
  if (s >= 280 && f >= 250) {
    weights.CA += 18;
    weights.BB += 24 + Math.round((s - 280) * 0.09) + Math.round((f - 250) * 0.05);
    weights.DD = Math.max(8, weights.DD - 16);
  } else if (s >= 180) {
    weights.CA += 12;
    weights.BB += 8;
  }

  // High bauxite boosts CV
  if (b >= 300) {
    weights.CV += 28 + Math.round((b - 300) * 0.11);
    weights.DD = Math.max(8, weights.DD - 14);
  } else if (b >= 180) {
    weights.CV += 10;
  }

  // Medium-high bauxite (200..460) + balanced fuel/steel (160..380) significantly boosts AR & AO!
  const balancedFS = Math.abs(f - s) <= 130 && f >= 150 && s >= 150;
  if (b >= 200 && balancedFS) {
    const arBoost = b <= 460 ? 22 : 12;
    const aoBoost = f >= 180 && a >= 100 ? 22 : 14;
    weights.AR += arBoost;
    weights.AO += aoBoost;
  } else if (b >= 150 && s >= 120) {
    weights.AR += 6;
    weights.AO += 6;
  }

  // Ammo skew slightly favors torpedo cruisers / submarines
  if (a >= 260 && s < 260) {
    weights.SS += 12;
    weights.CL += 8;
  }

  const sum = Object.values(weights).reduce((acc, v) => acc + v, 0) || 1;
  const order = ['DD', 'CL', 'CA', 'BB', 'CV', 'SS', 'AR', 'AO'];
  const labels = {
    DD: '驱逐舰',
    CL: '轻巡洋舰',
    CA: '重巡洋舰',
    BB: '战列舰',
    CV: '航空母舰',
    SS: '潜艇',
    AR: '维修舰',
    AO: '补给舰',
  };
  return order.map((cls) => ({
    shipClass: cls,
    shipType: labels[cls],
    weight: weights[cls],
    pct: Number(((weights[cls] / sum) * 100).toFixed(1)),
  }));
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

export const PORT_MEDAL_DEFS = Object.freeze([
  {
    id: 'first_slot_expand',
    title: '船体改装先驱',
    desc: '首次完成任意舰娘自定义装备槽位扩建',
    luckBonus: 2,
    category: '整备',
  },
  {
    id: 'max_enhance_10',
    title: '精工锻造大师',
    desc: '将任意装备强化至满级 +10',
    luckBonus: 2,
    category: '工坊',
  },
  {
    id: 'first_promote_rarity',
    title: '军工升阶突破',
    desc: '首次将满级装备升阶至更高品级',
    luckBonus: 3,
    category: '工坊',
  },
  {
    id: 'night_boss_kill',
    title: '夜战斩首勋章',
    desc: '在夜战阶段成功击破海域终点旗舰',
    luckBonus: 3,
    category: '战绩',
  },
  {
    id: 'sea_control_low',
    title: '近海制海勋章',
    desc: '1★ 近海防卫区制海权压制达到 100%',
    luckBonus: 2,
    category: '制海',
  },
  {
    id: 'sea_control_medium',
    title: '外海制霸勋章',
    desc: '2★ 外海破交航道制海权压制达到 100%',
    luckBonus: 3,
    category: '制海',
  },
  {
    id: 'sea_control_high',
    title: '深海压制大十字勋章',
    desc: '3★ 及以上深海海域制海权压制达到 100%',
    luckBonus: 5,
    category: '制海',
  },
  {
    id: 'full_fleet_6',
    title: '联合舰队司令官',
    desc: '成功编成 6 舰以上联合舰队阵型',
    luckBonus: 2,
    category: '编成',
  },
]);

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
    warehouse: {
      level: 1,
      maxLevel: 10,
    },
    customBuildings: [],
    medals: {
      unlockedIds: [],
      unlockedAt: {},
    },
    updatedAt: Date.now(),
  };
}

export class PortBuildingsSystem {
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
    this._autoMedalPaused = false;

    if (this._bus) {
      this._bus.on('character:deleted', ({ characterId }) => {
        if (this._autoMedalPaused) return;
        this._cleanupDeletedCharacter(characterId);
      });
      this._bus.on('inventory:slot-expanded', () => {
        if (this._autoMedalPaused) return;
        this.unlockMedal('first_slot_expand');
      });
      this._bus.on('inventory:enhanced', (ev) => {
        if (this._autoMedalPaused) return;
        if ((Number(ev?.nextLevel) || 0) >= 10) {
          this.unlockMedal('max_enhance_10');
        }
      });
      this._bus.on('inventory:promoted', () => {
        if (this._autoMedalPaused) return;
        this.unlockMedal('first_promote_rarity');
      });
      this._bus.on('sortie:boss-defeated', (ev) => {
        if (this._autoMedalPaused) return;
        if (ev?.isNight) {
          this.unlockMedal('night_boss_kill');
        }
      });
      this._bus.on('sea-control:updated', (ev) => {
        if (this._autoMedalPaused) return;
        if (ev?.controlled) {
          if (ev.difficulty === 'low' || ev.difficulty === 'star_1') this.unlockMedal('sea_control_low');
          if (ev.difficulty === 'medium' || ev.difficulty === 'star_2') this.unlockMedal('sea_control_medium');
          if (
            ev.difficulty === 'high' ||
            ev.difficulty === 'star_3' ||
            ev.difficulty === 'star_4' ||
            ev.difficulty === 'star_5'
          ) {
            this.unlockMedal('sea_control_high');
          }
        }
      });
      this._bus.on('formation:changed', (ev) => {
        if (this._autoMedalPaused) return;
        const count = Number(ev?.count ?? ev?.memberIds?.length ?? 0);
        if (count >= 6) {
          this.unlockMedal('full_fleet_6');
        }
      });
    }
  }

  setMedalAutoCheckPaused(paused) {
    this._autoMedalPaused = Boolean(paused);
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

    // 3. Port-level boosted hourly offline resource recovery (dorm/dock levels + custom building resource_regen buffs)
    let offlineResourceReport = null;
    if (this._resources && typeof this._resources.settleOfflineResources === 'function') {
      const buffs = this.getGlobalBuffSummary();
      const portLevelBonusPct =
        Math.max(0, (this._state.dormitory.level - 1) * 8) +
        Math.max(0, (this._state.dockyard.level - 1) * 10);
      const totalRegenPct = (buffs.resourceRegenPct || 0) + portLevelBonusPct + 20; // +20% 港区基础后勤产能
      offlineResourceReport = await this._resources.settleOfflineResources({
        now,
        extraRegenPct: totalRegenPct,
      });
    }

    this._syncDockTasksToEntitySystem();
    if (changed) {
      await this.persist();
    }
    return {
      settledDormResidents: validResidents.length,
      autoCompletedRepairs: finished.length,
      offlineResourceReport,
    };
  }

  /** Return effective hourly natural resource recovery across fuel/ammo/steel/bauxite. */
  getHourlyResourceYield() {
    if (!this._resources || typeof this._resources.getHourlyRecoverySummary !== 'function') {
      return { fuel: 0, ammo: 0, steel: 0, bauxite: 0 };
    }
    const buffs = this.getGlobalBuffSummary();
    const portLevelBonusPct =
      Math.max(0, (this._state.dormitory.level - 1) * 8) +
      Math.max(0, (this._state.dockyard.level - 1) * 10);
    return this._resources.getHourlyRecoverySummary({
      extraRegenPct: (buffs.resourceRegenPct || 0) + portLevelBonusPct + 20,
    });
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

  /**
   * Batch-assign damaged shipgirls (hp < maxHp) into all available free Dockyard repair bays,
   * prioritizing lowest HP% first.
   */
  async autoDockDamagedShipgirls(characterIds = []) {
    const dock = this._state.dockyard;
    const candidateIds =
      Array.isArray(characterIds) && characterIds.length > 0
        ? characterIds.map(String)
        : (this._entities?.list({ kind: 'character' }) || []).map((c) => c.id);

    const damaged = [];
    let alreadyHealthy = 0;
    let alreadyInDock = 0;

    for (const cid of candidateIds) {
      const actor = this._entities?.get(cid);
      if (!actor || actor.kind !== 'character') continue;
      if (this.isInDockyard(cid)) {
        alreadyInDock += 1;
        continue;
      }
      const effMaxHp = Math.max(1, Math.round(this._entities.getEffectiveStat(cid, 'maxHp', { round: 'round' }).final));
      const curHp = Math.min(effMaxHp, Math.round(Number(actor.stats.hp ?? effMaxHp)));
      if (curHp >= effMaxHp) {
        alreadyHealthy += 1;
        continue;
      }
      damaged.push({ id: cid, name: actor.name, hpRatio: curHp / effMaxHp });
    }

    // Prioritize most heavily damaged shipgirls first
    damaged.sort((a, b) => a.hpRatio - b.hpRatio);

    const docked = [];
    const skippedFull = [];
    const skippedResource = [];

    for (const d of damaged) {
      if (dock.queue.length >= dock.capacity) {
        skippedFull.push(d.name);
        continue;
      }
      try {
        const job = await this.startDockRepair(d.id);
        docked.push({ id: d.id, name: d.name, durationSec: job.durationSec });
      } catch (err) {
        skippedResource.push({ name: d.name, reason: err instanceof Error ? err.message : '资源不足' });
      }
    }

    return {
      docked,
      skippedFull,
      skippedResource,
      alreadyHealthy,
      alreadyInDock,
      freeBaysLeft: Math.max(0, dock.capacity - dock.queue.length),
      capacity: dock.capacity,
    };
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
      // Slow affection care bonus from Dockyard repair (+2, capped below next un-cleared gate via event or gentle clamp)
      const curAff = Math.round(Number(actor.stats.affinity ?? 0));
      const maxAff = Math.max(100, Number(actor.statBounds?.affinity?.max ?? 100));
      this._entities.adjustStat(cid, 'affinity', 2, { min: 0, max: Math.min(maxAff, curAff + 2) });
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
        detail: `${completeLine ? `${completeLine} | ` : ''}耐久已恢复满值 · 照料好感 +2${fastMethod ? `（快速修复消耗：${fastMethod}）` : ''}`,
      });
    }

    this._emit('buildings:dock-completed', { characterId: cid, fastRepair, fastMethod, completeLine });
    this._emit('buildings:updated', { reason: 'dock-complete' });
    return { characterId: cid, characterName: job.characterName, fastMethod, completeLine };
  }

  async expandDockyard({ skipCost = false } = {}) {
    const dock = this._state.dockyard;
    if (dock.capacity >= dock.maxCapacity) {
      throw new Error(`船坞已达最大渠位上限（${dock.maxCapacity} 渠位）`);
    }
    if (!skipCost) {
      const cost = this.getDockyardState().expandCost;
      const spend = await this._resources.spendBatch(cost, { reason: '扩建船坞维修渠位' });
      if (!spend.ok) throw new Error(spend.reason);
    }

    dock.capacity += 1;
    dock.level += 1;
    await this.persist();
    this._emit('buildings:updated', { reason: 'dock-expand' });
    return this.getDockyardState();
  }

  getWarehouseState() {
    const wh = this._state.warehouse || { level: 1, maxLevel: 10 };
    const lv = Math.max(1, Math.min(wh.maxLevel || 10, Math.floor(Number(wh.level) || 1)));
    const maxLevel = wh.maxLevel || 10;
    const canUpgrade = lv < maxLevel;
    return {
      level: lv,
      maxLevel,
      canUpgrade,
      capBonus: (lv - 1) * 1500,
      carriedSupplyBonus: (lv - 1) * 40,
      regenBonusPct: (lv - 1) * 10,
      upgradeCost: {
        steel: 220 + lv * 140,
        bauxite: 140 + lv * 90,
        silver: 260 + lv * 160,
      },
    };
  }

  async upgradeLogisticsWarehouse() {
    const st = this.getWarehouseState();
    if (!st.canUpgrade) throw new Error(`后勤仓库已达最高等级 Lv.${st.maxLevel}`);
    const spend = await this._resources.spendBatch(st.upgradeCost, { reason: `升级后勤仓库至 Lv.${st.level + 1}` });
    if (!spend.ok) throw new Error(spend.reason);
    if (!this._state.warehouse) this._state.warehouse = { level: 1, maxLevel: 10 };
    this._state.warehouse.level = st.level + 1;
    // Expand base 4 resource storage caps in ResourceManager
    if (this._resources && typeof this._resources.get === 'function') {
      for (const k of ['fuel', 'ammo', 'steel', 'bauxite']) {
        const r = this._resources.get(k);
        if (r && Number.isFinite(Number(r.cap))) {
          r.cap = Math.max(r.cap, 5000 + (this._state.warehouse.level - 1) * 1500);
        }
      }
      if (typeof this._resources.persist === 'function') await this._resources.persist();
    }
    await this.persist();
    this._emit('buildings:updated', { reason: 'warehouse-upgrade' });
    return this.getWarehouseState();
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
        statScaleVersion: 2,
        lv1BaseStats: { ...tpl },
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

  /**
   * Free-Recipe Instant Ship Construction (`30 ~ 600` per resource + small silver fee, zero wait time).
   * Duplicate ships automatically convert into `改造核心 ×1` + affinity gift / silver bonus!
   */
  async constructShipByRecipe({
    fuel = 150,
    ammo = 150,
    steel = 180,
    bauxite = 120,
    customName = '',
    rng = Math.random,
  } = {}) {
    const f = clamp(Math.round(Number(fuel) || 30), 30, 600);
    const a = clamp(Math.round(Number(ammo) || 30), 30, 600);
    const s = clamp(Math.round(Number(steel) || 30), 30, 600);
    const b = clamp(Math.round(Number(bauxite) || 30), 30, 600);
    const fastBp = this._inventory?.getItem ? this._inventory.getItem('item_supply_fast_build_bp') : null;
    const useFastBp = Boolean(fastBp && Number(fastBp.quantity || 0) > 0);
    const silverFee = useFastBp ? 0 : 60;

    const batchCost = { fuel: f, ammo: a, steel: s, bauxite: b };
    if (silverFee > 0) batchCost.silver = silverFee;
    const spend = await this._resources.spendBatch(
      batchCost,
      { reason: `自由配方舰船建造（${f}/${a}/${s}/${b}${useFastBp ? ' · 快建图纸免银条' : ` + 银条${silverFee}`}）` }
    );
    if (!spend.ok) throw new Error(spend.reason);
    if (useFastBp && typeof this._inventory?.consumeItemQuantity === 'function') {
      await this._inventory.consumeItemQuantity(fastBp.id, 1);
    }

    const probs = computeConstructionProbabilities({ fuel: f, ammo: a, steel: s, bauxite: b });
    const totalW = probs.reduce((acc, p) => acc + p.weight, 0) || 1;
    let roll = rng() * totalW;
    let chosenClass = probs[0];
    for (const p of probs) {
      roll -= p.weight;
      if (roll <= 0) {
        chosenClass = p;
        break;
      }
    }

    const pool = CONSTRUCTION_SHIP_POOL[chosenClass.shipClass] || CONSTRUCTION_SHIP_POOL.DD;
    const blueprint = pool[Math.floor(rng() * pool.length)] || pool[0];
    const finalName = String(customName || '').trim() || blueprint.name;
    const shipType = blueprint.shipType;

    // Duplicate detection (match by templateKey or exact name when customName is not overridden)
    const existingList = this._entities.list({ kind: 'character' });
    const dupMatch = !String(customName || '').trim()
      ? existingList.find(
          (c) =>
            (c.meta?.blueprintKey && c.meta.blueprintKey === blueprint.key) ||
            c.name === finalName
        )
      : null;

    if (dupMatch) {
      const coresTotal = this._inventory ? await this._inventory.addRetrofitCores(1) : 1;
      const silverRefund = 120;
      await this._resources.add('silver', silverRefund, { reason: `重复舰娘「${finalName}」自动转化补给` });
      let giftName = '港区誓约花束礼盒';
      if (this._inventory) {
        await this._inventory.createItem({
          id: `item_consumable_gift_bouquet`,
          name: giftName,
          category: 'consumable',
          rarity: 'rare',
          stackByName: true,
          quantity: 1,
          tags: ['好感礼物', '建造转化'],
          description: '重复舰船建造自动转化的精致礼盒，可在仓库/互动中使用提升舰娘好感与士气。',
          bonuses: [
            { stat: 'affinity', layer: 'baseAdd', value: 8 },
            { stat: 'morale', layer: 'baseAdd', value: 15 },
          ],
        });
      }
      this._state.dockyard.constructedCount += 1;
      await this.persist();

      if (this._logs) {
        this._logs.add({
          category: LOG_CATEGORIES.CHARACTER,
          title: `建造重复转化：「${finalName}」（${shipType}）`,
          detail: `已拥有该舰 → 自动转化为「改造核心 ×1」（累计 ${coresTotal}）+「${giftName} ×1」+ 银条 ${silverRefund}`,
        });
      }
      const res = {
        isDuplicate: true,
        shipName: finalName,
        shipType,
        classCode: chosenClass.shipClass,
        roleTag: blueprint.roleTag,
        recipe: { fuel: f, ammo: a, steel: s, bauxite: b, silver: silverFee },
        retrofitCoreGained: 1,
        retrofitCoresTotal: coresTotal,
        giftName,
        silverBonus: silverRefund,
      };
      this._emit('buildings:ship-constructed', res);
      this._emit('buildings:updated', { reason: 'dock-construct-dup' });
      return res;
    }

    // Fresh new shipgirl registration with 2-digit Lv.1 stats
    const tpl = SHIP_TYPE_BASE_TEMPLATES[shipType] || SHIP_TYPE_BASE_TEMPLATES['驱逐舰'];
    const initialAffBonus = this._commander ? this._commander.getInitialAffinityBonus() : 0;
    const charId = `char_build_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const rolledCombo = this._personalityPool ? this._personalityPool.rollCombination() : null;

    const entity = this._entities.register({
      id: charId,
      kind: 'character',
      name: finalName,
      tags: [shipType, chosenClass.shipClass, '自由建造', ...(rolledCombo ? [rolledCombo.primaryName, rolledCombo.secondaryName] : [])],
      stats: {
        ...tpl,
        hp: tpl.maxHp,
        morale: 85,
        ap: 100,
        maxAp: 100,
        affinity: clamp(24 + initialAffBonus, 0, 100),
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
        shipType,
        blueprintKey: blueprint.key,
        roleTag: rolledCombo ? `${blueprint.roleTag} · ${rolledCombo.comboLabel}` : blueprint.roleTag,
        avatarAssetId: null,
        statScaleVersion: 2,
        lv1BaseStats: { ...tpl },
        personalityCombo: rolledCombo,
        personality: rolledCombo?.description || '由港区自由配方建造成型的全新舰娘，期待与指挥官并肩航行。',
        speechHabit: rolledCombo?.speechHabit || `「${shipType} ${finalName}，建造完成！请指挥官多多指教！」`,
      },
    });

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
      // Give AR / AO 1 starter support slot automatically so they can equip repair/supply gear right away
      if (chosenClass.shipClass === 'AR' || chosenClass.shipClass === 'AO') {
        await this._inventory.addExpandedSlot(charId, 'support', { skipCost: true });
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
        actorName: finalName,
        title: `舰船建造完成：「${finalName}」（${shipType}）`,
        detail: `配方 ${f}/${a}/${s}/${b} | 耐久 ${tpl.maxHp} · 火力 ${tpl.firepower} · 装甲 ${tpl.armor}`,
      });
    }

    const res = {
      isDuplicate: false,
      entity,
      shipName: finalName,
      shipType,
      classCode: chosenClass.shipClass,
      roleTag: blueprint.roleTag,
      comboLabel: rolledCombo?.comboLabel || '',
      recipe: { fuel: f, ammo: a, steel: s, bauxite: b, silver: silverFee },
    };
    this._emit('character:saved', { characterId: charId, name: finalName, isEdit: false, source: 'construction' });
    this._emit('buildings:ship-constructed', res);
    this._emit('buildings:updated', { reason: 'dock-construct' });
    return res;
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

  // ------------------------------------------------------------
  // Port Honor Medals & Stage Directives (Permanent Commander Luck Growth)
  // ------------------------------------------------------------

  getMedalsOverview() {
    const raw = this._state.medals || { unlockedIds: [], unlockedAt: {} };
    const unlockedSet = new Set(Array.isArray(raw.unlockedIds) ? raw.unlockedIds : []);
    let totalLuckGained = 0;
    const medals = PORT_MEDAL_DEFS.map((def) => {
      const unlocked = unlockedSet.has(def.id);
      if (unlocked) totalLuckGained += def.luckBonus;
      return {
        ...def,
        unlocked,
        unlockedAt: unlocked ? raw.unlockedAt?.[def.id] || null : null,
      };
    });
    return {
      medals,
      unlockedCount: medals.filter((m) => m.unlocked).length,
      totalCount: medals.length,
      totalLuckGained,
    };
  }

  async unlockMedal(medalId) {
    const def = PORT_MEDAL_DEFS.find((m) => m.id === String(medalId));
    if (!def) return null;
    if (!this._state.medals || typeof this._state.medals !== 'object') {
      this._state.medals = { unlockedIds: [], unlockedAt: {} };
    }
    if (!Array.isArray(this._state.medals.unlockedIds)) {
      this._state.medals.unlockedIds = [];
    }
    if (!this._state.medals.unlockedAt || typeof this._state.medals.unlockedAt !== 'object') {
      this._state.medals.unlockedAt = {};
    }
    if (this._state.medals.unlockedIds.includes(def.id)) {
      return null;
    }

    this._state.medals.unlockedIds.push(def.id);
    this._state.medals.unlockedAt[def.id] = Date.now();
    await this.persist();

    if (this._commander && typeof this._commander.adjustLuck === 'function') {
      await this._commander.adjustLuck(def.luckBonus, `点亮荣誉勋章「${def.title}」`);
    }
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        title: `点亮荣誉勋章「${def.title}」`,
        detail: `${def.desc} · 指挥官运气永久 +${def.luckBonus}`,
      });
    }
    const payload = {
      medal: { ...def, unlocked: true, unlockedAt: this._state.medals.unlockedAt[def.id] },
      luckBonus: def.luckBonus,
      overview: this.getMedalsOverview(),
    };
    this._emit('medal:unlocked', payload);
    this._emit('buildings:updated', { reason: 'medal-unlocked', medalId: def.id });
    return payload;
  }

  serialize() {
    return {
      version: 2,
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
      medals: {
        unlockedIds: Array.isArray(snapshot.medals?.unlockedIds)
          ? Array.from(new Set(snapshot.medals.unlockedIds.map(String)))
          : [],
        unlockedAt:
          snapshot.medals?.unlockedAt && typeof snapshot.medals.unlockedAt === 'object'
            ? deepClone(snapshot.medals.unlockedAt)
            : {},
      },
      updatedAt: Number(snapshot.updatedAt) || Date.now(),
    };
    this._syncDockTasksToEntitySystem();
    this.syncCustomBuildingModifiers();
    if (persist) this.persist();
  }
}

export { SHIP_TYPE_PRESETS };
