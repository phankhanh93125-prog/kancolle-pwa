/**
 * Generic Resource Manager.
 *
 * Tracks global countable resources (e.g., credits, supplies, materials, and custom user entries)
 * with balance validation, safe add/spend operations, batch transactions, EventBus broadcasts,
 * and IndexedDB persistence.
 */

import { clamp } from './calc-engine.js';

const STORAGE_NS = 'core-resources';
const STATE_KEY = 'resources-state';

export const DEFAULT_RESOURCES = Object.freeze([
  { id: 'credits', name: '资金', unit: '币', amount: 1200, min: 0, max: 9999999 },
  { id: 'supplies', name: '补给', unit: '份', amount: 600, min: 0, max: 9999999 },
  { id: 'materials', name: '材料', unit: '件', amount: 350, min: 0, max: 9999999 },
]);

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

export class ResourceManager {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({ storage, bus = null }) {
    this._scope = storage.namespace(STORAGE_NS);
    this._bus = bus;
    /** @type {Map<string, { id: string, name: string, unit: string, amount: number, min: number, max: number, updatedAt: number }>} */
    this._resources = new Map();
    this._hydrated = false;
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  async init() {
    if (this._hydrated) return;
    const saved = await this._scope.getLarge(STATE_KEY, null);
    if (saved && Array.isArray(saved.resources) && saved.resources.length > 0) {
      this.deserialize(saved, { persist: false });
    } else {
      const now = Date.now();
      for (const r of DEFAULT_RESOURCES) {
        this._resources.set(r.id, { ...r, updatedAt: now });
      }
      await this.persist();
    }
    this._hydrated = true;
  }

  async persist() {
    await this._scope.setLarge(STATE_KEY, this.serialize());
  }

  list() {
    return Array.from(this._resources.values()).map((r) => deepClone(r));
  }

  get(id) {
    const r = this._resources.get(String(id));
    return r ? deepClone(r) : null;
  }

  getBalance(id) {
    return Number(this._resources.get(String(id))?.amount ?? 0);
  }

  async defineResource({ id, name, unit = '', amount = 0, min = 0, max = 9999999 }) {
    const cleanName = String(name || '').trim();
    const cleanId = String(id || `res_${Date.now().toString(36)}`).trim();
    if (!cleanId || !cleanName) throw new Error('资源 ID 与名称不能为空');
    const lo = Number.isFinite(Number(min)) ? Number(min) : 0;
    const hi = Number.isFinite(Number(max)) ? Number(max) : 9999999;
    const entry = {
      id: cleanId,
      name: cleanName,
      unit: String(unit || '').trim(),
      amount: clamp(Math.round(Number(amount) || 0), lo, hi),
      min: lo,
      max: hi,
      updatedAt: Date.now(),
    };
    this._resources.set(cleanId, entry);
    await this.persist();
    this._emit('resource:defined', { resource: deepClone(entry) });
    return deepClone(entry);
  }

  async removeResource(id) {
    const cleanId = String(id);
    if (!this._resources.has(cleanId)) return false;
    this._resources.delete(cleanId);
    await this.persist();
    this._emit('resource:removed', { id: cleanId });
    return true;
  }

  /**
   * Validate whether current balances cover a single cost or a cost map `{ credits: 100, materials: 20 }`.
   */
  canAfford(idOrCostMap, amount = null) {
    if (typeof idOrCostMap === 'string') {
      const need = Math.max(0, Number(amount) || 0);
      const have = this.getBalance(idOrCostMap);
      return {
        ok: have >= need,
        shortages: have >= need ? [] : [{ id: idOrCostMap, need, have, missing: need - have }],
      };
    }
    const shortages = [];
    for (const [resId, rawNeed] of Object.entries(idOrCostMap || {})) {
      const need = Math.max(0, Number(rawNeed) || 0);
      const have = this.getBalance(resId);
      if (have < need) {
        shortages.push({ id: resId, name: this._resources.get(resId)?.name || resId, need, have, missing: need - have });
      }
    }
    return { ok: shortages.length === 0, shortages };
  }

  async add(id, amount, { reason = 'manual' } = {}) {
    const entry = this._resources.get(String(id));
    if (!entry) throw new Error(`资源 "${id}" 不存在`);
    const delta = Math.max(0, Number(amount) || 0);
    const before = entry.amount;
    entry.amount = clamp(Number((before + delta).toFixed(2)), entry.min, entry.max);
    entry.updatedAt = Date.now();
    await this.persist();

    const detail = {
      id: entry.id,
      name: entry.name,
      unit: entry.unit,
      before,
      after: entry.amount,
      delta: Number((entry.amount - before).toFixed(2)),
      reason,
      timestamp: entry.updatedAt,
    };
    this._emit('resource:changed', detail);
    return { ok: true, ...detail };
  }

  async spend(id, amount, { reason = 'manual' } = {}) {
    const entry = this._resources.get(String(id));
    if (!entry) throw new Error(`资源 "${id}" 不存在`);
    const cost = Math.max(0, Number(amount) || 0);
    if (entry.amount - cost < entry.min) {
      return {
        ok: false,
        reason: `${entry.name}余额不足（当前 ${entry.amount}，需要 ${cost}）`,
        id: entry.id,
        have: entry.amount,
        need: cost,
      };
    }
    const before = entry.amount;
    entry.amount = clamp(Number((before - cost).toFixed(2)), entry.min, entry.max);
    entry.updatedAt = Date.now();
    await this.persist();

    const detail = {
      id: entry.id,
      name: entry.name,
      unit: entry.unit,
      before,
      after: entry.amount,
      delta: Number((entry.amount - before).toFixed(2)),
      reason,
      timestamp: entry.updatedAt,
    };
    this._emit('resource:changed', detail);
    return { ok: true, ...detail };
  }

  async spendBatch(costMap = {}, { reason = 'batch' } = {}) {
    const check = this.canAfford(costMap);
    if (!check.ok) {
      const msg = check.shortages.map((s) => `${s.name || s.id} 缺 ${s.missing}`).join('、');
      return { ok: false, reason: `资源不足：${msg}`, shortages: check.shortages };
    }
    const results = [];
    for (const [resId, cost] of Object.entries(costMap)) {
      if (Number(cost) > 0) {
        results.push(await this.spend(resId, Number(cost), { reason }));
      }
    }
    return { ok: true, results };
  }

  async setAmount(id, amount, { reason = 'set' } = {}) {
    const entry = this._resources.get(String(id));
    if (!entry) throw new Error(`资源 "${id}" 不存在`);
    const before = entry.amount;
    entry.amount = clamp(Number(amount) || 0, entry.min, entry.max);
    entry.updatedAt = Date.now();
    await this.persist();

    const detail = {
      id: entry.id,
      name: entry.name,
      unit: entry.unit,
      before,
      after: entry.amount,
      delta: Number((entry.amount - before).toFixed(2)),
      reason,
      timestamp: entry.updatedAt,
    };
    this._emit('resource:changed', detail);
    return { ok: true, ...detail };
  }

  serialize() {
    return {
      resources: this.list(),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || !Array.isArray(snapshot.resources)) return;
    this._resources.clear();
    for (const r of snapshot.resources) {
      if (r && r.id) this._resources.set(String(r.id), deepClone(r));
    }
    if (persist) {
      this.persist();
    }
  }
}
