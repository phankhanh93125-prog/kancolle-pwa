/**
 * Dynamic 3~12 Fleet Formation & Coordination System (`formation-system.js`).
 *
 * Responsibilities:
 *   - Enforces dynamic fleet size cap (3..12) governed by Commander `command` (统率)
 *   - Validates every member is Seaworthy (engine/armor/core equipped) AND not currently dispatched on expedition
 *   - Provides 5 configurable generic naval formations (单纵阵、复纵阵、轮形阵、警戒阵、梯形阵)
 *     whose multipliers can be customized and persisted
 *   - Computes aggregated full-fleet stats (maxHp, hp, firepower, armor, torpedo, evasion, recon, aa, asw)
 *     for multi-ship tactical combat with Commander synergy overhead reduction
 */

import { clamp } from './calc-engine.js';
import {
  GRID_COLS,
  GRID_ROWS,
  GRID_ROW_LABELS,
  GRID_TOTAL_CELLS,
  getFleetSlotCostFactor,
  getShipClassProfile,
  resolveShipClass,
} from './stat-rules.js';

const STORAGE_NS = 'core-formation';
const STATE_KEY = 'formation-state-v1';

export const DEFAULT_FORMATIONS = Object.freeze([
  {
    id: 'line_ahead',
    name: '单纵阵',
    desc: '经典主力突击阵型：纵列突击，大幅提升火力与雷击，适合正面对决。',
    mods: { firepower: 1.15, torpedo: 1.15, armor: 1.0, evasion: 0.95, recon: 1.0, aa: 0.95, asw: 0.9, guardBonus: 0, critBonus: 0.03 },
  },
  {
    id: 'double_line',
    name: '复纵阵',
    desc: '均衡协同阵型：双纵并进，兼顾装甲、侦查与火力稳定性。',
    mods: { firepower: 1.05, torpedo: 1.0, armor: 1.1, evasion: 1.05, recon: 1.1, aa: 1.05, asw: 1.05, guardBonus: 0.04, critBonus: 0 },
  },
  {
    id: 'diamond',
    name: '轮型防空阵',
    desc: '轮型护航阵型：轻重巡环护主力，大幅强化防空与同排/邻格援护挡伤。',
    mods: { firepower: 0.92, torpedo: 0.94, armor: 1.08, evasion: 1.02, recon: 1.05, aa: 1.32, asw: 1.15, guardBonus: 0.14, critBonus: 0 },
  },
  {
    id: 'vanguard',
    name: '警戒阵',
    desc: '高速规避阵型：前卫尖刀掩护后排，大幅提高机动与侦查，降低战损。',
    mods: { firepower: 0.88, torpedo: 0.95, armor: 1.02, evasion: 1.26, recon: 1.12, aa: 1.1, asw: 1.05, guardBonus: 0.1, critBonus: 0 },
  },
  {
    id: 'echelon',
    name: '梯形阵',
    desc: '反潜与侧翼突击阵型：斜翼展开，显著强化反潜、装甲与暴击倾向。',
    mods: { firepower: 1.05, torpedo: 1.06, armor: 1.1, evasion: 1.0, recon: 1.05, aa: 1.0, asw: 1.28, guardBonus: 0.06, critBonus: 0.05 },
  },
]);

export function formatSlotCode(slotNo) {
  return String(Math.max(1, Math.min(12, Math.floor(Number(slotNo) || 1)))).padStart(2, '0');
}

function getPreferredRowForShipClass(classCode) {
  const cls = String(classCode || 'CL').toUpperCase();
  if (cls === 'DD' || cls === 'CL' || cls === 'SS') return 0; // 前排
  if (cls === 'CA') return 1; // 中排
  return 2; // BB / CV -> 后排
}

/**
 * Compute optimal 3x4 grid slot array (length 12) for a given list of member IDs and formation preset.
 */
export function buildPresetGridSlots(memberIds = [], entities = null, presetId = 'line_ahead') {
  const slots = Array(GRID_TOTAL_CELLS).fill(null);
  const uniqueIds = [];
  const seen = new Set();
  for (const rawId of memberIds) {
    const id = String(rawId || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
    if (uniqueIds.length >= GRID_TOTAL_CELLS) break;
  }
  if (uniqueIds.length === 0) return slots;

  const getCls = (id) => {
    const ent = entities?.get ? entities.get(id) : null;
    return resolveShipClass(ent?.meta?.shipType || '');
  };

  const placeInOrder = (ids, cellOrder) => {
    let cursor = 0;
    for (const id of ids) {
      while (cursor < cellOrder.length && slots[cellOrder[cursor]] !== null) {
        cursor += 1;
      }
      if (cursor < cellOrder.length) {
        slots[cellOrder[cursor]] = id;
        cursor += 1;
      } else {
        const freeIdx = slots.findIndex((x) => x === null);
        if (freeIdx >= 0) slots[freeIdx] = id;
      }
    }
  };

  if (presetId === 'diamond') {
    // Core heavy ships (CV/BB) tucked inside protected middle/rear core, escorts (CL/CA/DD) forming ring
    const cores = uniqueIds.filter((id) => {
      const c = getCls(id);
      return c === 'CV' || c === 'BB';
    });
    const escorts = uniqueIds.filter((id) => !cores.includes(id));
    placeInOrder(cores, [5, 6, 9, 10, 1, 2, 4, 7, 0, 3, 8, 11]);
    placeInOrder(escorts, [1, 2, 4, 7, 9, 10, 0, 3, 5, 6, 8, 11]);
    return slots;
  }

  if (presetId === 'double_line') {
    // Balanced twin-column formation: vanguard DD/CL forward, CA midline, BB/CV rear
    const front = uniqueIds.filter((id) => getPreferredRowForShipClass(getCls(id)) === 0);
    const mid = uniqueIds.filter((id) => getPreferredRowForShipClass(getCls(id)) === 1);
    const back = uniqueIds.filter((id) => getPreferredRowForShipClass(getCls(id)) === 2);
    placeInOrder(front, [1, 2, 0, 3, 5, 6, 4, 7, 9, 10, 8, 11]);
    placeInOrder(mid, [5, 6, 4, 7, 1, 2, 9, 10, 0, 3, 8, 11]);
    placeInOrder(back, [9, 10, 8, 11, 5, 6, 4, 7, 1, 2, 0, 3]);
    return slots;
  }

  if (presetId === 'echelon') {
    placeInOrder(uniqueIds, [0, 5, 10, 1, 6, 11, 2, 4, 9, 3, 7, 8]);
    return slots;
  }

  if (presetId === 'vanguard') {
    const front = uniqueIds.filter((id) => getPreferredRowForShipClass(getCls(id)) === 0);
    const rest = uniqueIds.filter((id) => !front.includes(id));
    placeInOrder(front, [1, 2, 0, 3, 5, 6, 4, 7, 9, 10, 8, 11]);
    placeInOrder(rest, [9, 10, 5, 6, 8, 11, 4, 7, 0, 3, 1, 2]);
    return slots;
  }

  // Default: 'line_ahead' (单纵阵 — center spearhead column first, then right/left flanking columns)
  const sorted = [...uniqueIds].sort((a, b) => {
    const ra = getPreferredRowForShipClass(getCls(a));
    const rb = getPreferredRowForShipClass(getCls(b));
    return ra - rb;
  });
  const front = sorted.filter((id) => getPreferredRowForShipClass(getCls(id)) === 0);
  const mid = sorted.filter((id) => getPreferredRowForShipClass(getCls(id)) === 1);
  const back = sorted.filter((id) => getPreferredRowForShipClass(getCls(id)) === 2);
  placeInOrder(front, [1, 2, 0, 3, 5, 6, 4, 7, 9, 10, 8, 11]);
  placeInOrder(mid, [5, 1, 6, 2, 4, 7, 9, 10, 0, 3, 8, 11]);
  placeInOrder(back, [9, 10, 8, 11, 5, 6, 4, 7, 1, 2, 0, 3]);
  return slots;
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

export class FormationSystem {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   entities: import('./entity-system.js').EntitySystem,
   *   inventory: import('./inventory-system.js').InventorySystem,
   *   commander: import('./commander-system.js').CommanderSystem,
   *   expeditions?: import('./expedition-system.js').ExpeditionSystem | null,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({ storage, entities, inventory, commander, expeditions = null, bus = null }) {
    this._storage = storage;
    this._scope = storage.namespace(STORAGE_NS);
    this._entities = entities;
    this._inventory = inventory;
    this._commander = commander;
    this._expeditions = expeditions;
    this._bus = bus;

    this._memberIds = [];
    this._gridSlots = Array(GRID_TOTAL_CELLS).fill(null);
    this._formationId = 'line_ahead';
    this._customFormationMods = {};
    this._hydrated = false;

    if (this._bus) {
      this._bus.on('character:deleted', ({ characterId }) => {
        if (this._memberIds.includes(characterId) || this._gridSlots.includes(characterId)) {
          this._memberIds = this._memberIds.filter((id) => id !== characterId);
          this._gridSlots = this._gridSlots.map((id) => (id === characterId ? null : id));
          this.persist();
          this._emit('formation:changed', this.getState());
        }
      });
      this._bus.on('commander:updated', () => {
        this._enforceCapAndCleanup();
      });
    }
  }

  setExpeditions(expeditions) {
    this._expeditions = expeditions;
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  _findPreferredEmptyCell(characterId) {
    const ent = this._entities?.get(characterId);
    const cls = resolveShipClass(ent?.meta?.shipType || '');
    const prefRow = getPreferredRowForShipClass(cls);
    const colOrder = [1, 2, 0, 3];
    const rowOrder = prefRow === 0 ? [0, 1, 2] : prefRow === 1 ? [1, 0, 2] : [2, 1, 0];
    for (const r of rowOrder) {
      for (const c of colOrder) {
        const idx = r * GRID_COLS + c;
        if (this._gridSlots[idx] === null) return idx;
      }
    }
    return this._gridSlots.findIndex((x) => x === null);
  }

  _syncGridAndMembers() {
    // Normalize gridSlots length to 12
    const nextGrid = Array(GRID_TOTAL_CELLS).fill(null);
    const seenGrid = new Set();
    for (let i = 0; i < GRID_TOTAL_CELLS; i++) {
      const raw = this._gridSlots[i];
      if (!raw) continue;
      const cid = String(raw);
      if (seenGrid.has(cid)) continue;
      if (!this._entities?.has(cid)) continue;
      if (this.isCharacterDispatched(cid)) continue;
      seenGrid.add(cid);
      nextGrid[i] = cid;
    }

    // Ensure any memberId not yet in nextGrid gets placed into a smart empty cell
    for (const rawId of this._memberIds) {
      const cid = String(rawId || '');
      if (!cid || seenGrid.has(cid)) continue;
      if (!this._entities?.has(cid)) continue;
      if (this.isCharacterDispatched(cid)) continue;
      this._gridSlots = nextGrid;
      const idx = this._findPreferredEmptyCell(cid);
      if (idx >= 0) {
        nextGrid[idx] = cid;
        seenGrid.add(cid);
      }
    }

    // Preserve flagship / existing member order, then append any newly gridded members in row-major order
    const ordered = [];
    const added = new Set();
    for (const rawId of this._memberIds) {
      const cid = String(rawId || '');
      if (seenGrid.has(cid) && !added.has(cid)) {
        ordered.push(cid);
        added.add(cid);
      }
    }
    for (let i = 0; i < GRID_TOTAL_CELLS; i++) {
      const cid = nextGrid[i];
      if (cid && !added.has(cid)) {
        ordered.push(cid);
        added.add(cid);
      }
    }

    // Enforce commander fleet cap
    const cap = this.getFleetCap();
    const capped = ordered.slice(0, cap);
    const cappedSet = new Set(capped);
    for (let i = 0; i < GRID_TOTAL_CELLS; i++) {
      if (nextGrid[i] && !cappedSet.has(nextGrid[i])) {
        nextGrid[i] = null;
      }
    }

    const changed =
      capped.length !== this._memberIds.length ||
      capped.some((id, idx) => id !== this._memberIds[idx]) ||
      nextGrid.some((id, idx) => id !== this._gridSlots[idx]);

    this._memberIds = capped;
    this._gridSlots = nextGrid;
    return changed;
  }

  async init() {
    if (this._hydrated) return;
    const saved = await this._scope.getLarge(STATE_KEY, null);
    if (saved && typeof saved === 'object') {
      this._memberIds = Array.isArray(saved.memberIds) ? saved.memberIds.map(String) : [];
      this._formationId = String(saved.formationId || 'line_ahead');
      this._customFormationMods = deepClone(saved.customFormationMods || {});
      if (Array.isArray(saved.gridSlots) && saved.gridSlots.length === GRID_TOTAL_CELLS) {
        this._gridSlots = saved.gridSlots.map((x) => (x ? String(x) : null));
      } else if (this._memberIds.length > 0) {
        // Lossless legacy migration: place existing fleet into 3x4 grid automatically
        this._gridSlots = buildPresetGridSlots(this._memberIds, this._entities, this._formationId);
      }
    }
    this._enforceCapAndCleanup({ silent: true });

    // Seed initial fleet up to current cap (default 3) with available seaworthy idle shipgirls
    if (this._memberIds.length === 0) {
      await this.autoFillFleet({ persist: true, silent: true });
    } else {
      await this.persist();
    }
    this._hydrated = true;
  }

  async persist() {
    await this._scope.setLarge(STATE_KEY, this.serialize());
  }

  getFleetCap() {
    return this._commander ? this._commander.getFleetSizeCap() : 3;
  }

  isCharacterDispatched(characterId) {
    if (!this._expeditions || typeof this._expeditions.isCharacterDispatched !== 'function') {
      return false;
    }
    return this._expeditions.isCharacterDispatched(characterId);
  }

  _enforceCapAndCleanup({ silent = false } = {}) {
    const changed = this._syncGridAndMembers();
    if (changed && !silent) {
      this.persist();
      this._emit('formation:changed', this.getState());
    }
  }

  listFormations() {
    return DEFAULT_FORMATIONS.map((f) => ({
      ...deepClone(f),
      mods: {
        ...f.mods,
        ...(this._customFormationMods[f.id] || {}),
      },
      active: f.id === this._formationId,
    }));
  }

  getActiveFormation() {
    return this.listFormations().find((f) => f.id === this._formationId) || this.listFormations()[0];
  }

  async setFormation(formationId) {
    const exists = DEFAULT_FORMATIONS.some((f) => f.id === formationId);
    if (!exists) throw new Error(`未知阵型：${formationId}`);
    this._formationId = formationId;
    await this.persist();
    const state = this.getState();
    this._emit('formation:changed', state);
    return state;
  }

  /**
   * One-tap preset deployment: switches active formation buffs AND arranges all currently
   * deployed shipgirls into the preset's 3x4 tactical geometry (单纵阵 / 复纵阵 / 轮型防空阵 etc.).
   */
  async applyGridPreset(presetId) {
    const exists = DEFAULT_FORMATIONS.some((f) => f.id === presetId);
    if (!exists) throw new Error(`未知阵型预设：${presetId}`);
    this._enforceCapAndCleanup({ silent: true });
    this._formationId = presetId;
    this._gridSlots = buildPresetGridSlots(this._memberIds, this._entities, presetId);
    this._syncGridAndMembers();
    await this.persist();
    const state = this.getState();
    this._emit('formation:changed', state);
    return state;
  }

  async updateFormationModifiers(formationId, modsPatch = {}) {
    const base = DEFAULT_FORMATIONS.find((f) => f.id === formationId);
    if (!base) throw new Error(`未知阵型：${formationId}`);
    const prev = this._customFormationMods[formationId] || {};
    const next = { ...prev };
    for (const [k, v] of Object.entries(modsPatch)) {
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      next[k] = k === 'guardBonus' || k === 'critBonus' ? clamp(num, -0.3, 0.5) : clamp(num, 0.5, 2.0);
    }
    this._customFormationMods[formationId] = next;
    await this.persist();
    const state = this.getState();
    this._emit('formation:changed', state);
    return state;
  }

  /**
   * Validate whether a character can be added to the sortie fleet.
   */
  canAddMember(characterId) {
    const cid = String(characterId || '');
    const entity = this._entities?.get(cid);
    if (!entity || entity.kind !== 'character') {
      return { ok: false, reason: '目标角色不存在' };
    }
    if (this._memberIds.includes(cid)) {
      return { ok: false, reason: `「${entity.name}」已在当前出征编队中` };
    }
    const cap = this.getFleetCap();
    if (this._memberIds.length >= cap) {
      return {
        ok: false,
        reason: `编队已达当前统率上限（${this._memberIds.length}/${cap} 人），提升指挥官「统率」可解锁更多席位（最高 12 人）`,
      };
    }
    const sw = this._inventory.checkSeaworthiness(cid);
    if (!sw.seaworthy) {
      return { ok: false, reason: `「${entity.name}」${sw.statusText}，不可编入出征舰队` };
    }
    if (this.isCharacterDispatched(cid)) {
      return { ok: false, reason: `「${entity.name}」正在执行港区远征派遣，暂不可编入出征舰队` };
    }
    return { ok: true, reason: '' };
  }

  async addMember(characterId, { cellIndex = null } = {}) {
    this._enforceCapAndCleanup({ silent: true });
    const check = this.canAddMember(characterId);
    if (!check.ok) {
      throw new Error(check.reason);
    }
    const cid = String(characterId);
    let targetIdx =
      Number.isInteger(cellIndex) && cellIndex >= 0 && cellIndex < GRID_TOTAL_CELLS && this._gridSlots[cellIndex] === null
        ? cellIndex
        : this._findPreferredEmptyCell(cid);
    if (targetIdx < 0) {
      throw new Error('3×4 阵型盘已满，无法部署更多单位');
    }
    this._gridSlots[targetIdx] = cid;
    this._memberIds.push(cid);
    this._syncGridAndMembers();
    await this.persist();
    const state = this.getState();
    this._emit('formation:changed', state);
    return state;
  }

  /**
   * Deploy a shipgirl directly into a specific 3x4 grid cell (0..11).
   * - If already on grid, moves/swaps her into `cellIndex`.
   * - If not yet in fleet and target cell is occupied, replaces occupant (respecting fleet cap).
   */
  async deployToCell(characterId, cellIndex) {
    this._enforceCapAndCleanup({ silent: true });
    const cid = String(characterId || '');
    const idx = Number(cellIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_TOTAL_CELLS) {
      throw new RangeError(`无效的 3×4 格坐标：${cellIndex}`);
    }

    const existingIdx = this._gridSlots.indexOf(cid);
    if (existingIdx >= 0) {
      return this.swapGridCells(existingIdx, idx);
    }

    const occupant = this._gridSlots[idx];
    if (occupant) {
      // Check seaworthiness/expedition without tripping cap check since we replace occupant
      const entity = this._entities?.get(cid);
      if (!entity || entity.kind !== 'character') throw new Error('目标角色不存在');
      const sw = this._inventory.checkSeaworthiness(cid);
      if (!sw.seaworthy) throw new Error(`「${entity.name}」${sw.statusText}，不可编入出征舰队`);
      if (this.isCharacterDispatched(cid)) throw new Error(`「${entity.name}」正在远征派遣中`);

      this._gridSlots[idx] = cid;
      const mPos = this._memberIds.indexOf(occupant);
      if (mPos >= 0) {
        this._memberIds.splice(mPos, 1, cid);
      } else {
        this._memberIds.push(cid);
      }
      this._syncGridAndMembers();
      await this.persist();
      const state = this.getState();
      this._emit('formation:changed', state);
      return state;
    }

    return this.addMember(cid, { cellIndex: idx });
  }

  /**
   * Swap two 3x4 grid cells (supports moving a shipgirl into an empty cell or swapping two shipgirls).
   */
  async swapGridCells(indexA, indexB) {
    this._enforceCapAndCleanup({ silent: true });
    const a = Number(indexA);
    const b = Number(indexB);
    if (
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      a < 0 ||
      a >= GRID_TOTAL_CELLS ||
      b < 0 ||
      b >= GRID_TOTAL_CELLS
    ) {
      throw new RangeError(`无效的阵型格交换坐标：${indexA}, ${indexB}`);
    }
    if (a === b) return this.getState();
    const tmp = this._gridSlots[a];
    this._gridSlots[a] = this._gridSlots[b];
    this._gridSlots[b] = tmp;
    this._syncGridAndMembers();
    await this.persist();
    const state = this.getState();
    this._emit('formation:changed', state);
    return state;
  }

  async removeFromCell(cellIndex) {
    const idx = Number(cellIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= GRID_TOTAL_CELLS) return this.getState();
    const cid = this._gridSlots[idx];
    if (!cid) return this.getState();
    return this.removeMember(cid);
  }

  async removeMember(characterId) {
    const cid = String(characterId);
    if (!this._memberIds.includes(cid) && !this._gridSlots.includes(cid)) return this.getState();
    this._memberIds = this._memberIds.filter((id) => id !== cid);
    this._gridSlots = this._gridSlots.map((id) => (id === cid ? null : id));
    this._syncGridAndMembers();
    await this.persist();
    const state = this.getState();
    this._emit('formation:changed', state);
    return state;
  }

  async setFlagship(characterId) {
    const cid = String(characterId);
    if (!this._memberIds.includes(cid)) {
      await this.addMember(cid);
    }
    this._memberIds = [cid, ...this._memberIds.filter((id) => id !== cid)];
    this._syncGridAndMembers();
    await this.persist();
    const state = this.getState();
    this._emit('formation:changed', state);
    return state;
  }

  async autoFillFleet({ persist = true, silent = false } = {}) {
    this._enforceCapAndCleanup({ silent: true });
    const cap = this.getFleetCap();
    const candidates = this._entities.list({ kind: 'character' });
    for (const c of candidates) {
      if (this._memberIds.length >= cap) break;
      if (this._memberIds.includes(c.id)) continue;
      if (!this._inventory.checkSeaworthiness(c.id).seaworthy) continue;
      if (this.isCharacterDispatched(c.id)) continue;
      const cellIdx = this._findPreferredEmptyCell(c.id);
      if (cellIdx < 0) break;
      this._gridSlots[cellIdx] = c.id;
      this._memberIds.push(c.id);
    }
    this._syncGridAndMembers();
    if (persist) await this.persist();
    const state = this.getState();
    if (!silent) this._emit('formation:changed', state);
    return state;
  }

  getMemberIds() {
    this._enforceCapAndCleanup({ silent: true });
    return [...this._memberIds];
  }

  getMembers() {
    return this.getMemberIds()
      .map((id) => this._entities.get(id))
      .filter(Boolean);
  }

  getGridMap() {
    this._enforceCapAndCleanup({ silent: true });
    const map = {};
    for (let i = 0; i < GRID_TOTAL_CELLS; i++) {
      const cid = this._gridSlots[i];
      if (!cid) continue;
      const row = Math.floor(i / GRID_COLS);
      const col = i % GRID_COLS;
      const memberIdx = this._memberIds.indexOf(cid);
      const slotNo = memberIdx >= 0 ? memberIdx + 1 : i + 1;
      map[cid] = {
        index: i,
        row,
        col,
        rowLabel: GRID_ROW_LABELS[row] || '前排',
        slotNo,
        slotCode: formatSlotCode(slotNo),
      };
    }
    return map;
  }

  getGridSlots() {
    this._enforceCapAndCleanup({ silent: true });
    const summary = this.computeFleetSummary();
    const byId = new Map((summary.members || []).map((m) => [m.id, m]));
    return this._gridSlots.map((cid, index) => {
      const row = Math.floor(index / GRID_COLS);
      const col = index % GRID_COLS;
      const member = cid ? byId.get(cid) || null : null;
      return {
        index,
        row,
        col,
        rowLabel: GRID_ROW_LABELS[row] || '前排',
        characterId: cid,
        slotNo: member?.slotNo || null,
        slotCode: member?.slotCode || null,
        member,
      };
    });
  }

  getState() {
    const members = this.getMembers();
    const cap = this.getFleetCap();
    const summary = this.computeFleetSummary();
    return {
      memberIds: members.map((m) => m.id),
      gridSlots: [...this._gridSlots],
      gridCells: this.getGridSlots(),
      gridMap: this.getGridMap(),
      count: members.length,
      cap,
      maxPossibleCap: this._commander ? this._commander.getProfile().formula.maxFleetCap : 12,
      formationId: this._formationId,
      formation: this.getActiveFormation(),
      summary,
    };
  }

  /**
   * Validate full fleet readiness before launching a sortie.
   */
  validateFleetForSortie() {
    this._enforceCapAndCleanup({ silent: true });
    const members = this.getMembers();
    const errors = [];
    const cap = this.getFleetCap();

    if (members.length === 0) {
      errors.push('出征编队为空，请至少编入 1 名适航角色');
    }
    if (members.length > cap) {
      errors.push(`编队人数 (${members.length}) 超过当前统率上限 (${cap})`);
    }
    for (const m of members) {
      const sw = this._inventory.checkSeaworthiness(m.id);
      if (!sw.seaworthy) {
        errors.push(`「${m.name}」${sw.statusText}`);
      }
      if (this.isCharacterDispatched(m.id)) {
        errors.push(`「${m.name}」正在远征派遣中`);
      }
      if (Number(m.stats.hp ?? 0) <= 0) {
        errors.push(`「${m.name}」耐久为 0，请先回港区修复`);
      }
    }
    return {
      ok: errors.length === 0,
      errors,
      members,
      cap,
    };
  }

  /**
   * 3~12 Fleet Staggered Resource Consumption Formula:
   *   - Ships #1..#3  : 100% of ship-class base fuel/ammo
   *   - Ships #4..#6  :  75%
   *   - Ships #7..#12 :  55%
   *   Summed total is then multiplied by Commander `dispatch` logistics discount.
   */
  computeStaggeredStepCost(customMemberIds = null) {
    const memberIds = Array.isArray(customMemberIds) ? customMemberIds : this.getMemberIds();
    const members = memberIds.map((id) => this._entities?.get(id)).filter(Boolean);
    let rawFuel = 0;
    let rawAmmo = 0;
    const breakdown = [];

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const prof = getShipClassProfile(m.meta?.shipType);
      const tierFactor = getFleetSlotCostFactor(i);
      const shipFuel = Number((prof.stepCost.fuel * tierFactor).toFixed(2));
      const shipAmmo = Number((prof.stepCost.ammo * tierFactor).toFixed(2));
      rawFuel += shipFuel;
      rawAmmo += shipAmmo;
      breakdown.push({
        slotIndex: i + 1,
        id: m.id,
        name: m.name,
        shipType: m.meta?.shipType || prof.fullName,
        classCode: prof.code,
        tierFactor,
        tierLabel: `${Math.round(tierFactor * 100)}%`,
        fuel: Math.round(shipFuel),
        ammo: Math.round(shipAmmo),
      });
    }

    const dispatchDiscount = this._commander ? this._commander.getSortieStepDiscount() : 0;
    const scale = Math.max(0.5, 1 - dispatchDiscount);
    const fuel = Math.max(4, Math.round(rawFuel * scale));
    const ammo = Math.max(4, Math.round(rawAmmo * scale));

    return {
      fuel,
      ammo,
      rawFuel: Math.round(rawFuel),
      rawAmmo: Math.round(rawAmmo),
      dispatchDiscount,
      fleetCount: members.length,
      breakdown,
    };
  }

  /**
   * Aggregate full-fleet 8 naval stats with active formation multipliers, 3x4 grid coordinates,
   * ship-class composition, staggered step costs, vision range, and Commander synergy factor.
   */
  computeFleetSummary(customMemberIds = null, customFormationId = null) {
    const memberIds = Array.isArray(customMemberIds) ? customMemberIds : this.getMemberIds();
    const members = memberIds.map((id) => this._entities?.get(id)).filter(Boolean);
    const formation = customFormationId
      ? this.listFormations().find((f) => f.id === customFormationId) || this.getActiveFormation()
      : this.getActiveFormation();
    const mods = formation.mods;
    const gridMap = this.getGridMap();

    const totals = {
      hp: 0,
      maxHp: 0,
      firepower: 0,
      armor: 0,
      torpedo: 0,
      evasion: 0,
      recon: 0,
      aa: 0,
      asw: 0,
      moraleSum: 0,
      checkBonus: 0,
    };
    const classCounts = { DD: 0, CL: 0, CA: 0, BB: 0, CV: 0 };

    const memberDetails = [];
    for (let idx = 0; idx < members.length; idx++) {
      const m = members[idx];
      const eff = this._entities.getEffectiveStats(m.id, { round: 'round' });
      const eq = this._inventory.getCharacterEquipmentBonuses(m.id);
      const maxHp = Math.max(1, Math.round(Number(eff.maxHp ?? m.stats.maxHp ?? 100)));
      const hp = clamp(Math.round(Number(m.stats.hp ?? maxHp)), 0, maxHp);
      const morale = clamp(Math.round(Number(m.stats.morale ?? 60)), 0, 100);
      const alive = hp > 0;
      const classCode = resolveShipClass(m.meta?.shipType);
      const gPos = gridMap[m.id] || {
        index: idx % GRID_TOTAL_CELLS,
        row: Math.floor((idx % GRID_TOTAL_CELLS) / GRID_COLS),
        col: idx % GRID_COLS,
        rowLabel: GRID_ROW_LABELS[Math.floor((idx % GRID_TOTAL_CELLS) / GRID_COLS)] || '前排',
        slotNo: idx + 1,
        slotCode: formatSlotCode(idx + 1),
      };

      const row = {
        id: m.id,
        name: m.name,
        shipType: m.meta?.shipType || '通用舰',
        classCode,
        isFlagship: idx === 0,
        slotNo: idx + 1,
        slotCode: formatSlotCode(idx + 1),
        gridIndex: gPos.index,
        gridRow: gPos.row,
        gridCol: gPos.col,
        rowLabel: gPos.rowLabel,
        alive,
        hp,
        maxHp,
        morale,
        firepower: Math.round(Number(eff.firepower ?? 0)),
        armor: Math.round(Number(eff.armor ?? 0)),
        torpedo: Math.round(Number(eff.torpedo ?? 0)),
        evasion: Math.round(Number(eff.evasion ?? 0)),
        recon: Math.round(Number(eff.recon ?? 0)),
        aa: Math.round(Number(eff.aa ?? 0)),
        asw: Math.round(Number(eff.asw ?? 0)),
        checkBonus: eq.checkBonus,
      };
      memberDetails.push(row);

      totals.hp += hp;
      totals.maxHp += maxHp;
      if (alive) {
        classCounts[classCode] = (classCounts[classCode] || 0) + 1;
        totals.firepower += row.firepower;
        totals.armor += row.armor;
        totals.torpedo += row.torpedo;
        totals.evasion += row.evasion;
        totals.recon += row.recon;
        totals.aa += row.aa;
        totals.asw += row.asw;
        totals.moraleSum += morale;
        totals.checkBonus += eq.checkBonus;
      }
    }

    const aliveCount = memberDetails.filter((m) => m.alive).length;
    const count = Math.max(1, aliveCount);

    // Multi-ship synergy efficiency: slight overhead for large fleets, offset by Commander `command`
    const rawOverhead = Math.max(0, (count - 1) * 0.03);
    const reduction = this._commander ? this._commander.getFleetSynergyOverheadReduction() : 0;
    const synergyFactor = Number(clamp(1 - rawOverhead * (1 - reduction) + (count - 1) * 0.06, 0.85, 1.85).toFixed(3));

    const effective = {
      firepower: Math.round(totals.firepower * mods.firepower),
      armor: Math.round((totals.armor / count) * mods.armor * (1 + (count - 1) * 0.05)),
      torpedo: Math.round(totals.torpedo * mods.torpedo),
      evasion: Math.round((totals.evasion / count) * mods.evasion),
      recon: Math.round((totals.recon / count + totals.recon * 0.18) * mods.recon),
      aa: Math.round(totals.aa * mods.aa),
      asw: Math.round(totals.asw * mods.asw),
    };

    const checkRatings = {
      firepower: Math.round((totals.firepower / count) * mods.firepower * synergyFactor),
      armor: effective.armor,
      torpedo: Math.round((totals.torpedo / count) * mods.torpedo * synergyFactor),
      evasion: Math.round((totals.evasion / count) * mods.evasion * (1 + Math.min(0.25, (count - 1) * 0.02))),
      recon: Math.round((totals.recon / count) * mods.recon * (1 + Math.min(0.45, (count - 1) * 0.05))),
      aa: Math.round((totals.aa / count) * mods.aa * synergyFactor),
      asw: Math.round((totals.asw / count) * mods.asw * synergyFactor),
    };

    const hasCarrier = classCounts.CV > 0;
    const cmdTactics = this._commander ? this._commander.getProfile().stats.tactics : 10;
    const visionRange =
      1 +
      (hasCarrier ? 1 : 0) +
      (effective.recon >= 90 ? 1 : 0) +
      (cmdTactics >= 25 ? 1 : 0);

    const staggeredStepCost = this.computeStaggeredStepCost(memberIds);

    return {
      count: members.length,
      aliveCount,
      cap: this.getFleetCap(),
      formationId: formation.id,
      formationName: formation.name,
      formationMods: mods,
      synergyFactor,
      classCounts,
      hasCarrier,
      visionRange,
      staggeredStepCost,
      avgMorale: Math.round(totals.moraleSum / count),
      totalHp: totals.hp,
      totalMaxHp: totals.maxHp,
      avgCheckBonus: Number((totals.checkBonus / count).toFixed(2)),
      totals,
      effective,
      checkRatings,
      members: memberDetails,
    };
  }

  /**
   * One-click optimal auto-equip across the entire active fleet in priority order
   * (Flagship #1 -> Wingmen #2..#N), distributing best idle warehouse gear without conflicts.
   */
  async autoEquipFleet({ includeOutfit = true } = {}) {
    if (!this._inventory || typeof this._inventory.autoEquipCharacter !== 'function') {
      throw new Error('装备仓储引擎未就绪');
    }
    const memberIds = this.getMemberIds();
    if (memberIds.length === 0) {
      throw new Error('当前编队尚无舰娘，请先编入舰娘');
    }

    const reservedCounts = new Map();
    const perShip = [];
    let totalEquipped = 0;

    for (const cid of memberIds) {
      const res = await this._inventory.autoEquipCharacter(cid, {
        includeOutfit,
        excludeItemIds: reservedCounts,
      });
      for (const id of res.wornItemIds || []) {
        reservedCounts.set(id, (reservedCounts.get(id) || 0) + 1);
      }
      totalEquipped += res.equippedCount;
      perShip.push(res);
    }

    const nextState = this.getState();
    this._emit('formation:changed', nextState);
    return {
      fleetCount: memberIds.length,
      totalEquipped,
      perShip,
    };
  }

  serialize() {
    return {
      version: 2,
      memberIds: [...this._memberIds],
      gridSlots: [...this._gridSlots],
      formationId: this._formationId,
      customFormationMods: deepClone(this._customFormationMods),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._memberIds = Array.isArray(snapshot.memberIds) ? snapshot.memberIds.map(String) : [];
    this._formationId = String(snapshot.formationId || 'line_ahead');
    this._customFormationMods = deepClone(snapshot.customFormationMods || {});
    if (Array.isArray(snapshot.gridSlots) && snapshot.gridSlots.length === GRID_TOTAL_CELLS) {
      this._gridSlots = snapshot.gridSlots.map((x) => (x ? String(x) : null));
    } else {
      this._gridSlots = buildPresetGridSlots(this._memberIds, this._entities, this._formationId);
    }
    this._enforceCapAndCleanup({ silent: true });
    if (persist) this.persist();
    this._emit('formation:changed', this.getState());
  }
}
