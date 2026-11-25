/**
 * Generic 6-Resource & Dual-Currency Manager.
 *
 * Official resource schema:
 *   - 4 Base Resources (slow offline auto-recovery up to soft storage cap):
 *       fuel (燃油), ammo (弹药), steel (钢材), bauxite (铝材)
 *   - 2 Currencies (do NOT auto-recover over time):
 *       silver (银条, standard currency), gold (金条, premium currency)
 *
 * Provides safe balance validation, batch transactions, custom resource entries,
 * offline recovery settlement, IndexedDB persistence, and a shared mobile overview bar component.
 */

import { clamp } from './calc-engine.js';
import { formatDurationZh } from './entity-system.js';

const STORAGE_NS = 'core-resources';
const STATE_KEY = 'resources-state-v2';

export const DEFAULT_RESOURCES = Object.freeze([
  {
    id: 'fuel',
    name: '燃油',
    unit: '',
    group: 'resource',
    amount: 1200,
    min: 0,
    cap: 3000,
    max: 999999,
    autoRecover: true,
    recoveryPerMin: 1.5,
  },
  {
    id: 'ammo',
    name: '弹药',
    unit: '',
    group: 'resource',
    amount: 1200,
    min: 0,
    cap: 3000,
    max: 999999,
    autoRecover: true,
    recoveryPerMin: 1.5,
  },
  {
    id: 'steel',
    name: '钢材',
    unit: '',
    group: 'resource',
    amount: 1200,
    min: 0,
    cap: 3000,
    max: 999999,
    autoRecover: true,
    recoveryPerMin: 1.5,
  },
  {
    id: 'bauxite',
    name: '铝材',
    unit: '',
    group: 'resource',
    amount: 800,
    min: 0,
    cap: 2000,
    max: 999999,
    autoRecover: true,
    recoveryPerMin: 0.8,
  },
  {
    id: 'silver',
    name: '银条',
    unit: '',
    group: 'currency',
    amount: 2500,
    min: 0,
    cap: 9999999,
    max: 9999999,
    autoRecover: false,
    recoveryPerMin: 0,
  },
  {
    id: 'gold',
    name: '金条',
    unit: '',
    group: 'currency',
    amount: 120,
    min: 0,
    cap: 9999999,
    max: 9999999,
    autoRecover: false,
    recoveryPerMin: 0,
  },
]);

export const CORE_RESOURCE_IDS = Object.freeze(['fuel', 'ammo', 'steel', 'bauxite']);
export const CORE_CURRENCY_IDS = Object.freeze(['silver', 'gold']);

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const RESOURCE_SVGS = Object.freeze({
  fuel: '<svg class="res-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2C8 2 3.5 7 3.5 10.2A4.5 4.5 0 0 0 12.5 10.2C12.5 7 8 2 8 2Z" fill="#22c55e" fill-opacity=".28" stroke="#22c55e" stroke-width="1.4"/></svg>',
  ammo: '<svg class="res-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 13V6.5C5 4 6.5 2 8 2C9.5 2 11 4 11 6.5V13H5Z" fill="#f59e0b" fill-opacity=".28" stroke="#f59e0b" stroke-width="1.4"/><path d="M5 10.5H11" stroke="#f59e0b" stroke-width="1.2"/></svg>',
  steel: '<svg class="res-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true"><polygon points="3,12 5,5 11,5 13,12" fill="#94a3b8" fill-opacity=".28" stroke="#94a3b8" stroke-width="1.4"/></svg>',
  bauxite: '<svg class="res-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true"><polygon points="8,2 14,8 8,14 2,8" fill="#fb923c" fill-opacity=".28" stroke="#fb923c" stroke-width="1.4"/></svg>',
  silver: '<svg class="res-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="5" width="11" height="6" rx="1.6" fill="#cbd5e1" fill-opacity=".30" stroke="#cbd5e1" stroke-width="1.4"/><path d="M5 8H11" stroke="#cbd5e1" stroke-width="1.2"/></svg>',
  gold: '<svg class="res-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="5" width="11" height="6" rx="1.6" fill="#facc15" fill-opacity=".32" stroke="#eab308" stroke-width="1.4"/><path d="M5 8H11" stroke="#facc15" stroke-width="1.2"/></svg>',
});

/**
 * Render a unified, compact 6-resource + dual-currency top overview bar element
 * with crisp inline vector icons.
 *
 * @param {ResourceManager} resources
 * @param {{ showCaps?: boolean, id?: string }} [options]
 */
export function createResourceOverviewBar(resources, { showCaps = false, id = 'shared-resource-bar' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'res-overview-bar';
  wrap.id = id;

  const baseItems = CORE_RESOURCE_IDS.map((rid) => resources.get(rid)).filter(Boolean);
  const currencyItems = CORE_CURRENCY_IDS.map((rid) => resources.get(rid)).filter(Boolean);

  wrap.innerHTML = `
    <div class="res-overview-grid-4">
      ${baseItems
        .map(
          (r) => `
        <div class="res-mini-cell" data-res-cell="${escapeHtml(r.id)}">
          <span class="res-mini-label">${RESOURCE_SVGS[r.id] || ''}${escapeHtml(r.name)}</span>
          <span class="res-mini-val">${Math.floor(r.amount)}${showCaps && r.cap ? `<small>/${r.cap}</small>` : ''}</span>
        </div>
      `
        )
        .join('')}
    </div>
    <div class="res-overview-grid-2">
      ${currencyItems
        .map(
          (c) => `
        <div class="res-mini-cell is-currency is-${escapeHtml(c.id)}" data-res-cell="${escapeHtml(c.id)}">
          <span class="res-mini-label">${RESOURCE_SVGS[c.id] || ''}${escapeHtml(c.name)}</span>
          <span class="res-mini-val">${Math.floor(c.amount)}</span>
        </div>
      `
        )
        .join('')}
    </div>
  `;

  return wrap;
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
    /** @type {Map<string, object>} */
    this._resources = new Map();
    this._lastRecoveryAt = Date.now();
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
    const now = Date.now();

    if (saved && Array.isArray(saved.resources) && saved.resources.length > 0) {
      this.deserialize(saved, { persist: false });
      // Ensure all 6 mandatory defaults exist
      for (const def of DEFAULT_RESOURCES) {
        if (!this._resources.has(def.id)) {
          this._resources.set(def.id, { ...def, updatedAt: now });
        }
      }
      // Settle slow offline auto-recovery for the 4 base resources if >= 60s elapsed
      if (this._lastRecoveryAt && now - this._lastRecoveryAt >= 60 * 1000) {
        await this.settleOfflineResources({ lastTimestamp: this._lastRecoveryAt, now });
      }
    } else {
      for (const def of DEFAULT_RESOURCES) {
        this._resources.set(def.id, { ...def, updatedAt: now });
      }
      this._lastRecoveryAt = now;
      await this.persist();
    }
    this._hydrated = true;
  }

  async persist() {
    await this._scope.setLarge(STATE_KEY, this.serialize());
  }

  list({ group = null } = {}) {
    const out = [];
    for (const r of this._resources.values()) {
      if (group && r.group !== group) continue;
      out.push(deepClone(r));
    }
    return out;
  }

  get(id) {
    const r = this._resources.get(String(id));
    return r ? deepClone(r) : null;
  }

  getBalance(id) {
    return Number(this._resources.get(String(id))?.amount ?? 0);
  }

  async defineResource({
    id,
    name,
    unit = '',
    group = 'resource',
    amount = 0,
    min = 0,
    cap = 999999,
    max = 9999999,
    autoRecover = false,
    recoveryPerMin = 0,
  }) {
    const cleanName = String(name || '').trim();
    const cleanId = String(id || `res_${Date.now().toString(36)}`).trim();
    if (!cleanId || !cleanName) throw new Error('资源 ID 与名称不能为空');
    const lo = Number.isFinite(Number(min)) ? Number(min) : 0;
    const hi = Number.isFinite(Number(max)) ? Number(max) : 9999999;
    const softCap = Number.isFinite(Number(cap)) ? Number(cap) : hi;
    const entry = {
      id: cleanId,
      name: cleanName,
      unit: String(unit || '').trim(),
      group: group === 'currency' ? 'currency' : 'resource',
      amount: clamp(Math.round(Number(amount) || 0), lo, hi),
      min: lo,
      cap: softCap,
      max: hi,
      autoRecover: Boolean(autoRecover),
      recoveryPerMin: Math.max(0, Number(recoveryPerMin) || 0),
      updatedAt: Date.now(),
    };
    this._resources.set(cleanId, entry);
    await this.persist();
    this._emit('resource:defined', { resource: deepClone(entry) });
    return deepClone(entry);
  }

  async removeResource(id) {
    const cleanId = String(id);
    if (CORE_RESOURCE_IDS.includes(cleanId) || CORE_CURRENCY_IDS.includes(cleanId)) {
      throw new Error('基础四项资源与双货币为系统核心条目，不可删除');
    }
    if (!this._resources.has(cleanId)) return false;
    this._resources.delete(cleanId);
    await this.persist();
    this._emit('resource:removed', { id: cleanId });
    return true;
  }

  /**
   * Settle slow offline auto-recovery for resources with `autoRecover === true` up to their soft `cap`.
   * Currencies (silver / gold) are never auto-recovered.
   */
  async settleOfflineResources({ lastTimestamp = this._lastRecoveryAt, now = Date.now(), maxElapsedSec = 86400 * 7 } = {}) {
    const prevTs = Number(lastTimestamp) || now;
    const elapsedSec = Math.min(Math.max(0, (now - prevTs) / 1000), maxElapsedSec);
    const elapsedMins = elapsedSec / 60;
    const changes = [];

    for (const r of this._resources.values()) {
      if (!r.autoRecover || !(r.recoveryPerMin > 0)) continue;
      const cap = Number(r.cap ?? r.max ?? 3000);
      if (r.amount >= cap) continue;
      const gain = Math.floor(elapsedMins * r.recoveryPerMin);
      if (gain <= 0) continue;
      const before = r.amount;
      const after = Math.min(cap, before + gain);
      const actual = after - before;
      if (actual > 0) {
        r.amount = after;
        r.updatedAt = now;
        changes.push({ id: r.id, name: r.name, before, after, delta: actual, cap });
      }
    }

    this._lastRecoveryAt = now;
    if (changes.length > 0) {
      await this.persist();
    }

    const report = {
      elapsedSec: Number(elapsedSec.toFixed(1)),
      formattedDuration: formatDurationZh(elapsedSec),
      changes,
      timestamp: now,
    };
    if (changes.length > 0) {
      this._emit('resource:offline-recovered', report);
    }
    return report;
  }

  /**
   * Validate whether current balances cover a single cost or a cost map `{ steel: 100, silver: 200 }`.
   */
  canAfford(idOrCostMap, amount = null) {
    if (typeof idOrCostMap === 'string') {
      const need = Math.max(0, Number(amount) || 0);
      const have = this.getBalance(idOrCostMap);
      return {
        ok: have >= need,
        shortages: have >= need ? [] : [{ id: idOrCostMap, name: this._resources.get(idOrCostMap)?.name || idOrCostMap, need, have, missing: need - have }],
      };
    }
    const shortages = [];
    for (const [resId, rawNeed] of Object.entries(idOrCostMap || {})) {
      const need = Math.max(0, Number(rawNeed) || 0);
      if (need <= 0) continue;
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
    entry.amount = clamp(Math.round(before + delta), entry.min, entry.max);
    entry.updatedAt = Date.now();
    await this.persist();

    const detail = {
      id: entry.id,
      name: entry.name,
      unit: entry.unit,
      before,
      after: entry.amount,
      delta: entry.amount - before,
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
        reason: `${entry.name}不足（当前 ${entry.amount}，需要 ${cost}）`,
        id: entry.id,
        have: entry.amount,
        need: cost,
      };
    }
    const before = entry.amount;
    entry.amount = clamp(Math.round(before - cost), entry.min, entry.max);
    entry.updatedAt = Date.now();
    await this.persist();

    const detail = {
      id: entry.id,
      name: entry.name,
      unit: entry.unit,
      before,
      after: entry.amount,
      delta: entry.amount - before,
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
    entry.amount = clamp(Math.round(Number(amount) || 0), entry.min, entry.max);
    entry.updatedAt = Date.now();
    await this.persist();

    const detail = {
      id: entry.id,
      name: entry.name,
      unit: entry.unit,
      before,
      after: entry.amount,
      delta: entry.amount - before,
      reason,
      timestamp: entry.updatedAt,
    };
    this._emit('resource:changed', detail);
    return { ok: true, ...detail };
  }

  serialize() {
    return {
      version: 2,
      lastRecoveryAt: this._lastRecoveryAt,
      resources: this.list(),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || !Array.isArray(snapshot.resources)) return;
    this._resources.clear();
    for (const r of snapshot.resources) {
      if (r && r.id) this._resources.set(String(r.id), deepClone(r));
    }
    this._lastRecoveryAt = Number(snapshot.lastRecoveryAt) || Date.now();
    if (persist) {
      this.persist();
    }
  }
}
