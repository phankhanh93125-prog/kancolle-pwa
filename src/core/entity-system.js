/**
 * Generic Entity Registry, Stat Modifier System, and Offline Time Delta Settlement Engine.
 *
 * Completely domain-agnostic: supports registering any actor, item, status, or resource entity,
 * attaching multi-layer stat modifiers, and settling elapsed offline time (recovery, decay,
 * production rates, and countdown timers).
 */

import { CalcEngine, clamp, computeStackedStat } from './calc-engine.js';

function deepClone(val) {
  return JSON.parse(JSON.stringify(val ?? null));
}

export function formatDurationZh(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const remSec = sec % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (mins > 0) parts.push(`${mins}分`);
  if (remSec > 0 || parts.length === 0) parts.push(`${remSec}秒`);
  return parts.join(' ');
}

export class EntitySystem {
  /**
   * @param {{ bus?: import('./event-bus.js').EventBus | null, calc?: CalcEngine }} [deps]
   */
  constructor({ bus = null, calc = new CalcEngine() } = {}) {
    this._bus = bus;
    this._calc = calc;
    /** @type {Map<string, object>} */
    this._entities = new Map();
    /** @type {Map<string, object>} */
    this._tasks = new Map();
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  // ------------------------------------------------------------
  // Entity Registration & Lifecycle
  // ------------------------------------------------------------

  /**
   * Register or update a generic entity (actor, item, status, etc.).
   * @param {{
   *   id: string,
   *   kind?: string,
   *   name?: string,
   *   tags?: string[],
   *   stats?: Record<string, number>,
   *   statBounds?: Record<string, { min?: number, max?: number }>,
   *   modifiers?: Array<{ id: string, stat: string, layer: string, value: number, source?: string, durationTurns?: number | null, expiresAt?: number | null, enabled?: boolean }>,
   *   meta?: Record<string, any>
   * }} entityDef
   */
  register(entityDef) {
    if (!entityDef || !entityDef.id) {
      throw new Error('Entity 必须包含非空 id');
    }
    const id = String(entityDef.id).trim();
    const now = Date.now();
    const entity = {
      id,
      kind: String(entityDef.kind || 'actor'),
      name: String(entityDef.name || id),
      tags: Array.isArray(entityDef.tags) ? [...entityDef.tags] : [],
      stats: { ...(entityDef.stats || {}) },
      statBounds: deepClone(entityDef.statBounds || {}),
      modifiers: Array.isArray(entityDef.modifiers) ? deepClone(entityDef.modifiers) : [],
      meta: deepClone(entityDef.meta || {}),
      updatedAt: now,
    };
    this._entities.set(id, entity);
    this._emit('entity:registered', { id, kind: entity.kind, entity: deepClone(entity) });
    return entity;
  }

  get(id) {
    return this._entities.get(String(id)) || null;
  }

  has(id) {
    return this._entities.has(String(id));
  }

  remove(id) {
    const existed = this._entities.delete(String(id));
    if (existed) {
      this._emit('entity:removed', { id: String(id) });
    }
    return existed;
  }

  list({ kind = null, tag = null } = {}) {
    const out = [];
    for (const entity of this._entities.values()) {
      if (kind && entity.kind !== kind) continue;
      if (tag && !entity.tags.includes(tag)) continue;
      out.push(entity);
    }
    return out;
  }

  clear() {
    this._entities.clear();
    this._tasks.clear();
    this._emit('entity:cleared', {});
  }

  // ------------------------------------------------------------
  // Base Stats & Multi-Layer Stat Modifiers
  // ------------------------------------------------------------

  setStat(entityId, statKey, value, bounds = null) {
    const entity = this.get(entityId);
    if (!entity) throw new Error(`Entity "${entityId}" 不存在`);
    const definedBounds = bounds || entity.statBounds?.[statKey] || {};
    const before = Number(entity.stats[statKey] ?? 0);
    const next = clamp(
      Number(value),
      definedBounds.min !== undefined ? definedBounds.min : -Infinity,
      definedBounds.max !== undefined ? definedBounds.max : Infinity
    );
    entity.stats[statKey] = Number(next.toFixed(6));
    entity.updatedAt = Date.now();
    this._emit('entity:stat-changed', {
      entityId: entity.id,
      stat: statKey,
      before,
      after: entity.stats[statKey],
      delta: Number((entity.stats[statKey] - before).toFixed(6)),
    });
    return entity.stats[statKey];
  }

  adjustStat(entityId, statKey, delta, bounds = null) {
    const entity = this.get(entityId);
    if (!entity) throw new Error(`Entity "${entityId}" 不存在`);
    const current = Number(entity.stats[statKey] ?? 0);
    return this.setStat(entityId, statKey, current + Number(delta || 0), bounds);
  }

  addModifier(entityId, modifier) {
    const entity = this.get(entityId);
    if (!entity) throw new Error(`Entity "${entityId}" 不存在`);
    if (!modifier || !modifier.stat) {
      throw new Error('Modifier 必须指定目标属性 stat');
    }
    const mod = {
      id: String(modifier.id || `mod_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
      stat: String(modifier.stat),
      layer: String(modifier.layer || 'baseAdd'),
      value: Number(modifier.value || 0),
      source: String(modifier.source || 'manual'),
      durationTurns: modifier.durationTurns ?? null,
      expiresAt: modifier.expiresAt ?? null,
      enabled: modifier.enabled !== false,
    };
    // Replace existing modifier with the same id if present
    const idx = entity.modifiers.findIndex((m) => m.id === mod.id);
    if (idx >= 0) entity.modifiers[idx] = mod;
    else entity.modifiers.push(mod);

    entity.updatedAt = Date.now();
    this._emit('entity:modifier-added', { entityId: entity.id, modifier: mod });
    return mod;
  }

  removeModifier(entityId, modifierId) {
    const entity = this.get(entityId);
    if (!entity) return false;
    const prevLen = entity.modifiers.length;
    entity.modifiers = entity.modifiers.filter((m) => m.id !== modifierId);
    if (entity.modifiers.length !== prevLen) {
      entity.updatedAt = Date.now();
      this._emit('entity:modifier-removed', { entityId: entity.id, modifierId });
      return true;
    }
    return false;
  }

  toggleModifier(entityId, modifierId, force) {
    const entity = this.get(entityId);
    if (!entity) return null;
    const mod = entity.modifiers.find((m) => m.id === modifierId);
    if (!mod) return null;
    mod.enabled = force !== undefined ? Boolean(force) : !mod.enabled;
    entity.updatedAt = Date.now();
    this._emit('entity:modifier-updated', { entityId: entity.id, modifier: mod });
    return mod;
  }

  /**
   * Compute a single stat with all active modifiers stacked cleanly.
   */
  getEffectiveStat(entityId, statKey, options = {}) {
    const entity = this.get(entityId);
    if (!entity) throw new Error(`Entity "${entityId}" 不存在`);
    const base = Number(entity.stats[statKey] ?? 0);
    const relevant = entity.modifiers.filter((m) => m.stat === statKey && m.enabled !== false);
    const bounds = entity.statBounds?.[statKey] || {};
    return computeStackedStat(base, relevant, {
      min: options.min !== undefined ? options.min : bounds.min,
      max: options.max !== undefined ? options.max : bounds.max,
      round: options.round ?? 'none',
    });
  }

  /**
   * Compute all effective stats for an entity as a flat key -> number map.
   */
  getEffectiveStats(entityId, options = {}) {
    const entity = this.get(entityId);
    if (!entity) throw new Error(`Entity "${entityId}" 不存在`);
    const statKeys = new Set([
      ...Object.keys(entity.stats || {}),
      ...entity.modifiers.map((m) => m.stat),
    ]);
    const result = {};
    for (const key of statKeys) {
      result[key] = this.getEffectiveStat(entityId, key, options).final;
    }
    return result;
  }

  /**
   * Advance modifier lifetimes by `turns` and prune timestamp-expired modifiers.
   */
  tickModifiers({ turns = 1, now = Date.now() } = {}) {
    const expired = [];
    for (const entity of this._entities.values()) {
      const kept = [];
      for (const mod of entity.modifiers) {
        let isExpired = false;
        if (mod.expiresAt !== null && mod.expiresAt !== undefined && now >= mod.expiresAt) {
          isExpired = true;
        }
        if (!isExpired && mod.durationTurns !== null && mod.durationTurns !== undefined) {
          mod.durationTurns -= turns;
          if (mod.durationTurns <= 0) isExpired = true;
        }
        if (isExpired) {
          expired.push({ entityId: entity.id, modifierId: mod.id, stat: mod.stat });
        } else {
          kept.push(mod);
        }
      }
      entity.modifiers = kept;
    }
    if (expired.length > 0) {
      this._emit('entity:modifiers-expired', { expired });
    }
    return expired;
  }

  // ------------------------------------------------------------
  // Generic Countdown Timers (Idle / Dispatch / Recovery Tasks)
  // ------------------------------------------------------------

  registerTask({ id, label, durationSec, startedAt = Date.now(), meta = {} }) {
    const cleanId = String(id || `task_${Date.now()}`);
    const dur = Math.max(1, Number(durationSec) || 60);
    const task = {
      id: cleanId,
      label: String(label || cleanId),
      startedAt: Number(startedAt),
      durationSec: dur,
      endAt: Number(startedAt) + dur * 1000,
      completed: false,
      meta: deepClone(meta),
    };
    this._tasks.set(cleanId, task);
    this._emit('entity:task-registered', task);
    return task;
  }

  listTasks(now = Date.now()) {
    return Array.from(this._tasks.values()).map((t) => {
      const elapsedSec = Math.max(0, (now - t.startedAt) / 1000);
      const remainingSec = Math.max(0, Math.ceil((t.endAt - now) / 1000));
      const progress = clamp(elapsedSec / t.durationSec, 0, 1);
      return {
        ...t,
        completed: t.completed || remainingSec <= 0,
        remainingSec,
        progress: Number(progress.toFixed(4)),
      };
    });
  }

  removeTask(id) {
    return this._tasks.delete(String(id));
  }

  // ------------------------------------------------------------
  // Offline Time Delta Settlement Engine
  // ------------------------------------------------------------

  /**
   * Calculate elapsed offline duration and settle stat recovery/decay rules & countdown tasks.
   *
   * @param {{
   *   lastTimestamp: number,
   *   now?: number,
   *   maxElapsedSec?: number,
   *   rules?: Array<{
   *     entityId: string,
   *     stat: string,
   *     ratePerSecond?: number,
   *     ratePerMinute?: number,
   *     ratePerHour?: number,
   *     min?: number,
   *     max?: number,
   *     mode?: 'add' | 'decay',
   *     round?: 'none' | 'floor' | 'round'
   *   }>,
   *   applyChanges?: boolean
   * }} params
   */
  settleOfflineTime({
    lastTimestamp,
    now = Date.now(),
    maxElapsedSec = 86400 * 7,
    rules = [],
    applyChanges = true,
  }) {
    const prevTs = Number(lastTimestamp) || now;
    const rawElapsedMs = Math.max(0, Number(now) - prevTs);
    const rawElapsedSec = rawElapsedMs / 1000;
    const clampedSec = Math.min(rawElapsedSec, Math.max(0, Number(maxElapsedSec) || rawElapsedSec));
    const wasClamped = rawElapsedSec > clampedSec;

    const statChanges = [];
    for (const rule of rules || []) {
      const entity = this.get(rule.entityId);
      if (!entity) continue;

      let ratePerSec = 0;
      if (Number.isFinite(Number(rule.ratePerSecond))) ratePerSec = Number(rule.ratePerSecond);
      else if (Number.isFinite(Number(rule.ratePerMinute))) ratePerSec = Number(rule.ratePerMinute) / 60;
      else if (Number.isFinite(Number(rule.ratePerHour))) ratePerSec = Number(rule.ratePerHour) / 3600;

      const direction = rule.mode === 'decay' ? -1 : 1;
      let rawDelta = clampedSec * ratePerSec * direction;
      if (rule.round === 'floor') rawDelta = direction >= 0 ? Math.floor(rawDelta) : Math.ceil(rawDelta);
      else if (rule.round === 'round') rawDelta = Math.round(rawDelta);
      else rawDelta = Number(rawDelta.toFixed(4));

      const before = Number(entity.stats[rule.stat] ?? 0);
      const definedBounds = entity.statBounds?.[rule.stat] || {};
      const lo = rule.min !== undefined ? rule.min : definedBounds.min ?? -Infinity;
      const hi = rule.max !== undefined ? rule.max : definedBounds.max ?? Infinity;
      const after = Number(clamp(before + rawDelta, lo, hi).toFixed(4));
      const actualDelta = Number((after - before).toFixed(4));

      if (applyChanges && actualDelta !== 0) {
        this.setStat(entity.id, rule.stat, after, { min: lo, max: hi });
      }

      statChanges.push({
        entityId: entity.id,
        entityName: entity.name,
        stat: rule.stat,
        before,
        after,
        delta: actualDelta,
        clampedToBound: Math.abs(actualDelta) < Math.abs(rawDelta) - 1e-6,
      });
    }

    // Settle registered countdown tasks
    const taskUpdates = [];
    const completedTaskIds = [];
    for (const task of this._tasks.values()) {
      const elapsedForTask = Math.max(0, (now - task.startedAt) / 1000);
      const remainingSec = Math.max(0, Math.ceil((task.endAt - now) / 1000));
      const progress = clamp(elapsedForTask / task.durationSec, 0, 1);
      const justCompleted = !task.completed && remainingSec <= 0;
      if (applyChanges && remainingSec <= 0) {
        task.completed = true;
      }
      if (remainingSec <= 0) {
        completedTaskIds.push(task.id);
      }
      taskUpdates.push({
        id: task.id,
        label: task.label,
        progress: Number(progress.toFixed(4)),
        remainingSec,
        completed: remainingSec <= 0,
        justCompleted,
      });
    }

    // Also prune timestamp-expired modifiers
    const expiredModifiers = applyChanges ? this.tickModifiers({ turns: 0, now }) : [];

    const report = {
      lastTimestamp: prevTs,
      now,
      elapsedMs: rawElapsedMs,
      elapsedSec: Number(rawElapsedSec.toFixed(2)),
      clampedSec: Number(clampedSec.toFixed(2)),
      wasClamped,
      formattedDuration: formatDurationZh(clampedSec),
      statChanges,
      taskUpdates,
      completedTaskIds,
      expiredModifiers,
    };

    this._emit('entity:offline-settled', report);
    return report;
  }

  // ------------------------------------------------------------
  // Snapshot Serialization (for SaveManager)
  // ------------------------------------------------------------

  serialize() {
    return {
      entities: Array.from(this._entities.values()).map((e) => deepClone(e)),
      tasks: Array.from(this._tasks.values()).map((t) => deepClone(t)),
    };
  }

  deserialize(snapshot) {
    this._entities.clear();
    this._tasks.clear();
    if (!snapshot || typeof snapshot !== 'object') return;
    if (Array.isArray(snapshot.entities)) {
      for (const e of snapshot.entities) {
        if (e && e.id) this._entities.set(String(e.id), deepClone(e));
      }
    }
    if (Array.isArray(snapshot.tasks)) {
      for (const t of snapshot.tasks) {
        if (t && t.id) this._tasks.set(String(t.id), deepClone(t));
      }
    }
    this._emit('entity:deserialized', {
      entityCount: this._entities.size,
      taskCount: this._tasks.size,
    });
  }
}
