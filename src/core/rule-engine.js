/**
 * Local Deterministic Condition & Branching Event Rule Engine.
 *
 * Guarantees full offline playability with zero AI API dependency:
 *   - Evaluates composite preconditions (stat thresholds, flags, inventory items, vars, phase, formulas)
 *   - Draws weighted random event nodes from named pools
 *   - Resolves multi-choice branching jumps (direct nextNodeId or nextPoolId)
 *   - Executes local state mutations (entity stats, modifiers, flags, items, vars, custom events)
 */

import { CalcEngine, weightedPick } from './calc-engine.js';

function deepClone(val) {
  return JSON.parse(JSON.stringify(val ?? null));
}

function compareValues(actual, op, expected) {
  switch (op) {
    case '==':
    case 'eq':
      return actual === expected || (Number.isFinite(Number(actual)) && Number.isFinite(Number(expected)) && Math.abs(Number(actual) - Number(expected)) < 1e-9);
    case '!=':
    case 'neq':
      return !compareValues(actual, '==', expected);
    case '>':
    case 'gt':
      return Number(actual) > Number(expected);
    case '>=':
    case 'gte':
      return Number(actual) >= Number(expected);
    case '<':
    case 'lt':
      return Number(actual) < Number(expected);
    case '<=':
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'in':
      return Array.isArray(expected) ? expected.includes(actual) : false;
    case 'notIn':
      return Array.isArray(expected) ? !expected.includes(actual) : true;
    case 'exists':
      return actual !== undefined && actual !== null && actual !== false;
    default:
      return Boolean(actual);
  }
}

export class RuleEngine {
  /**
   * @param {{
   *   bus?: import('./event-bus.js').EventBus | null,
   *   calc?: CalcEngine,
   *   entities?: import('./entity-system.js').EntitySystem | null
   * }} [deps]
   */
  constructor({ bus = null, calc = new CalcEngine(), entities = null } = {}) {
    this._bus = bus;
    this._calc = calc;
    this._entities = entities;

    /** @type {Map<string, object>} */
    this._nodes = new Map();
    /** @type {Map<string, string[]>} */
    this._pools = new Map();

    /** @type {Record<string, any>} */
    this.flags = {};
    /** @type {Record<string, number>} */
    this.inventory = {};
    /** @type {Record<string, any>} */
    this.vars = {};
    /** @type {string | null} */
    this.currentNodeId = null;
    /** @type {Array<{ nodeId: string, choiceId?: string, timestamp: number }>} */
    this.history = [];
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  // ------------------------------------------------------------
  // Node & Event Pool Registry
  // ------------------------------------------------------------

  registerNode(nodeDef) {
    if (!nodeDef || !nodeDef.id) {
      throw new Error('事件节点必须包含非空 id');
    }
    const id = String(nodeDef.id).trim();
    const normalized = {
      id,
      title: String(nodeDef.title || id),
      weight: nodeDef.weight ?? 1,
      tags: Array.isArray(nodeDef.tags) ? [...nodeDef.tags] : [],
      conditions: Array.isArray(nodeDef.conditions) ? deepClone(nodeDef.conditions) : [],
      template: String(nodeDef.template || ''),
      onEnterEffects: Array.isArray(nodeDef.onEnterEffects) ? deepClone(nodeDef.onEnterEffects) : [],
      choices: Array.isArray(nodeDef.choices) ? deepClone(nodeDef.choices) : [],
      meta: deepClone(nodeDef.meta || {}),
    };
    this._nodes.set(id, normalized);
    return normalized;
  }

  registerNodes(nodeList = []) {
    for (const node of nodeList) {
      this.registerNode(node);
    }
    return this;
  }

  getNode(id) {
    return this._nodes.get(String(id)) || null;
  }

  listNodes() {
    return Array.from(this._nodes.values());
  }

  registerPool(poolId, nodeIds = []) {
    const cleanId = String(poolId || '').trim();
    if (!cleanId) throw new Error('事件池 poolId 不能为空');
    this._pools.set(cleanId, Array.from(new Set(nodeIds.map((x) => String(x)))));
    return this;
  }

  getPool(poolId) {
    return this._pools.get(String(poolId)) || [];
  }

  // ------------------------------------------------------------
  // Local State Helpers (Flags, Inventory, Vars)
  // ------------------------------------------------------------

  setFlag(key, value = true) {
    this.flags[String(key)] = value;
  }

  getFlag(key, fallback = false) {
    return Object.prototype.hasOwnProperty.call(this.flags, key) ? this.flags[key] : fallback;
  }

  removeFlag(key) {
    delete this.flags[String(key)];
  }

  getItemCount(key) {
    return Number(this.inventory[String(key)] || 0);
  }

  adjustItem(key, delta) {
    const k = String(key);
    const before = this.getItemCount(k);
    const after = Math.max(0, before + Number(delta || 0));
    if (after === 0) {
      delete this.inventory[k];
    } else {
      this.inventory[k] = after;
    }
    return { key: k, before, after, delta: after - before };
  }

  setVar(key, value) {
    this.vars[String(key)] = value;
  }

  getVar(key, fallback = null) {
    return Object.prototype.hasOwnProperty.call(this.vars, key) ? this.vars[key] : fallback;
  }

  // ------------------------------------------------------------
  // Runtime Context & Condition Evaluation
  // ------------------------------------------------------------

  _buildFormulaScope(runtimeCtx = {}) {
    const entitiesMap = {};
    if (this._entities) {
      for (const e of this._entities.list()) {
        entitiesMap[e.id] = {
          ...this._entities.getEffectiveStats(e.id),
          base: { ...e.stats },
        };
      }
    }
    return {
      flags: this.flags,
      items: this.inventory,
      inventory: this.inventory,
      vars: this.vars,
      entities: entitiesMap,
      phase: runtimeCtx.phase ?? '',
      turn: Number(runtimeCtx.turn ?? 1),
      ...(runtimeCtx.variables || {}),
    };
  }

  /**
   * Evaluate a single condition object against local state & EntitySystem.
   */
  evaluateCondition(condition, runtimeCtx = {}) {
    if (!condition || typeof condition !== 'object') {
      return { passed: true, reason: '' };
    }

    if (Array.isArray(condition.all)) {
      for (const sub of condition.all) {
        const res = this.evaluateCondition(sub, runtimeCtx);
        if (!res.passed) return res;
      }
      return { passed: true, reason: '' };
    }

    if (Array.isArray(condition.any)) {
      const reasons = [];
      for (const sub of condition.any) {
        const res = this.evaluateCondition(sub, runtimeCtx);
        if (res.passed) return { passed: true, reason: '' };
        if (res.reason) reasons.push(res.reason);
      }
      return { passed: false, reason: condition.hint || reasons[0] || '未满足任一前置条件' };
    }

    if (condition.not) {
      const res = this.evaluateCondition(condition.not, runtimeCtx);
      return {
        passed: !res.passed,
        reason: !res.passed ? '' : condition.hint || '触发了互斥条件',
      };
    }

    const type = String(condition.type || 'flag');
    const op = String(condition.op || '>=');

    if (type === 'stat') {
      if (!this._entities || !this._entities.has(condition.entityId)) {
        return { passed: false, reason: condition.hint || `实体 ${condition.entityId} 不存在` };
      }
      const actual = condition.useBase
        ? Number(this._entities.get(condition.entityId)?.stats?.[condition.stat] ?? 0)
        : this._entities.getEffectiveStat(condition.entityId, condition.stat).final;
      const passed = compareValues(actual, op, condition.value);
      return {
        passed,
        reason: passed ? '' : condition.hint || `${condition.stat} 需 ${op} ${condition.value}（当前 ${actual}）`,
      };
    }

    if (type === 'flag') {
      const actual = this.getFlag(condition.key, false);
      const expected = condition.value !== undefined ? condition.value : true;
      const flagOp = condition.op || '==';
      const passed = compareValues(actual, flagOp, expected);
      return {
        passed,
        reason: passed ? '' : condition.hint || `缺少状态标记 ${condition.key}`,
      };
    }

    if (type === 'item') {
      const actual = this.getItemCount(condition.key);
      const passed = compareValues(actual, op, condition.value ?? 1);
      return {
        passed,
        reason: passed ? '' : condition.hint || `物品 ${condition.key} 需 ${op} ${condition.value ?? 1}（当前 ${actual}）`,
      };
    }

    if (type === 'var') {
      const actual = this.getVar(condition.key, null);
      const passed = compareValues(actual, condition.op || '==', condition.value);
      return {
        passed,
        reason: passed ? '' : condition.hint || `变量 ${condition.key} 不满足条件`,
      };
    }

    if (type === 'phase') {
      const actual = runtimeCtx.phase ?? '';
      const passed = compareValues(actual, condition.op || '==', condition.value);
      return {
        passed,
        reason: passed ? '' : condition.hint || `仅限阶段 ${condition.value}`,
      };
    }

    if (type === 'formula') {
      const scope = this._buildFormulaScope(runtimeCtx);
      const val = this._calc.evaluate(condition.expr, scope);
      const passed = Boolean(val);
      return {
        passed,
        reason: passed ? '' : condition.hint || `公式条件未满足: ${condition.expr}`,
      };
    }

    return { passed: true, reason: '' };
  }

  checkConditions(conditions = [], runtimeCtx = {}) {
    for (const cond of conditions || []) {
      const res = this.evaluateCondition(cond, runtimeCtx);
      if (!res.passed) return res;
    }
    return { passed: true, reason: '' };
  }

  // ------------------------------------------------------------
  // Weighted Random Event Pool Drawing
  // ------------------------------------------------------------

  drawFromPool(poolId, runtimeCtx = {}, { excludeIds = [], rng = Math.random } = {}) {
    const nodeIds = this.getPool(poolId);
    const excludeSet = new Set(excludeIds);
    const eligible = [];

    for (const nid of nodeIds) {
      if (excludeSet.has(nid)) continue;
      const node = this.getNode(nid);
      if (!node) continue;
      const check = this.checkConditions(node.conditions, runtimeCtx);
      if (check.passed) {
        eligible.push(node);
      }
    }

    if (eligible.length === 0) {
      return { poolId, node: null, eligibleCount: 0, totalCount: nodeIds.length };
    }

    const scope = this._buildFormulaScope(runtimeCtx);
    const picked = weightedPick(
      eligible,
      (node) => {
        if (typeof node.weight === 'string') {
          try {
            return Math.max(0, this._calc.evaluate(node.weight, scope));
          } catch {
            return 1;
          }
        }
        return Math.max(0, Number(node.weight ?? 1));
      },
      rng
    );

    const result = {
      poolId,
      node: picked,
      eligibleCount: eligible.length,
      totalCount: nodeIds.length,
    };

    if (picked) {
      this.enterNode(picked.id, runtimeCtx);
    }

    this._emit('rule:pool-drawn', {
      poolId,
      nodeId: picked?.id || null,
      eligibleCount: eligible.length,
      totalCount: nodeIds.length,
    });
    return result;
  }

  enterNode(nodeId, runtimeCtx = {}) {
    const node = this.getNode(nodeId);
    if (!node) {
      throw new Error(`事件节点 "${nodeId}" 不存在`);
    }
    this.currentNodeId = node.id;
    const enterLog = node.onEnterEffects.length > 0 ? this.applyEffects(node.onEnterEffects, runtimeCtx) : null;
    this._emit('rule:node-entered', { nodeId: node.id, title: node.title, enterLog });
    return { node, enterLog };
  }

  getAvailableChoices(nodeId, runtimeCtx = {}) {
    const node = this.getNode(nodeId);
    if (!node) return [];
    return node.choices.map((choice) => {
      const check = this.checkConditions(choice.conditions || [], runtimeCtx);
      return {
        ...choice,
        available: check.passed,
        reason: check.passed ? '' : choice.disabledHint || check.reason,
      };
    });
  }

  // ------------------------------------------------------------
  // Local Deterministic Effect Executor
  // ------------------------------------------------------------

  applyEffects(effects = [], runtimeCtx = {}) {
    const appliedEffects = [];
    const deltas = {};
    const itemsChanged = {};
    const flagsChanged = {};
    const varsChanged = {};

    for (const eff of effects || []) {
      if (!eff || typeof eff !== 'object') continue;
      const type = String(eff.type || '');

      if (type === 'statDelta' && this._entities && this._entities.has(eff.entityId)) {
        const entity = this._entities.get(eff.entityId);
        const before = Number(entity.stats[eff.stat] ?? 0);
        const bounds = eff.min !== undefined || eff.max !== undefined ? { min: eff.min, max: eff.max } : null;
        const after = this._entities.adjustStat(eff.entityId, eff.stat, Number(eff.value || 0), bounds);
        const delta = Number((after - before).toFixed(4));
        deltas[eff.stat] = (deltas[eff.stat] || 0) + delta;
        appliedEffects.push({ type, entityId: eff.entityId, stat: eff.stat, before, after, delta });
      } else if (type === 'statSet' && this._entities && this._entities.has(eff.entityId)) {
        const entity = this._entities.get(eff.entityId);
        const before = Number(entity.stats[eff.stat] ?? 0);
        const bounds = eff.min !== undefined || eff.max !== undefined ? { min: eff.min, max: eff.max } : null;
        const after = this._entities.setStat(eff.entityId, eff.stat, Number(eff.value || 0), bounds);
        const delta = Number((after - before).toFixed(4));
        deltas[eff.stat] = (deltas[eff.stat] || 0) + delta;
        appliedEffects.push({ type, entityId: eff.entityId, stat: eff.stat, before, after, delta });
      } else if (type === 'statFormula' && this._entities && this._entities.has(eff.entityId)) {
        const entity = this._entities.get(eff.entityId);
        const before = Number(entity.stats[eff.stat] ?? 0);
        const scope = this._buildFormulaScope(runtimeCtx);
        const evaluated = this._calc.evaluate(eff.expr, scope);
        const bounds = eff.min !== undefined || eff.max !== undefined ? { min: eff.min, max: eff.max } : null;
        const after = this._entities.setStat(eff.entityId, eff.stat, evaluated, bounds);
        const delta = Number((after - before).toFixed(4));
        deltas[eff.stat] = (deltas[eff.stat] || 0) + delta;
        appliedEffects.push({ type, entityId: eff.entityId, stat: eff.stat, expr: eff.expr, before, after, delta });
      } else if (type === 'setFlag') {
        const val = eff.value !== undefined ? eff.value : true;
        this.setFlag(eff.key, val);
        flagsChanged[eff.key] = val;
        appliedEffects.push({ type, key: eff.key, value: val });
      } else if (type === 'removeFlag') {
        this.removeFlag(eff.key);
        flagsChanged[eff.key] = null;
        appliedEffects.push({ type, key: eff.key });
      } else if (type === 'itemDelta') {
        const change = this.adjustItem(eff.key, Number(eff.value || 0));
        itemsChanged[eff.key] = change.delta;
        appliedEffects.push({ type, ...change });
      } else if (type === 'setVar') {
        this.setVar(eff.key, eff.value);
        varsChanged[eff.key] = eff.value;
        appliedEffects.push({ type, key: eff.key, value: eff.value });
      } else if (type === 'addModifier' && this._entities && this._entities.has(eff.entityId)) {
        const mod = this._entities.addModifier(eff.entityId, eff.modifier);
        appliedEffects.push({ type, entityId: eff.entityId, modifier: mod });
      } else if (type === 'removeModifier' && this._entities) {
        const ok = this._entities.removeModifier(eff.entityId, eff.modifierId);
        appliedEffects.push({ type, entityId: eff.entityId, modifierId: eff.modifierId, removed: ok });
      } else if (type === 'emitEvent' && eff.event) {
        this._emit(String(eff.event), eff.payload ?? {});
        appliedEffects.push({ type, event: eff.event });
      }
    }

    return {
      appliedEffects,
      deltas,
      itemsChanged,
      flagsChanged,
      varsChanged,
    };
  }

  /**
   * Execute a player choice on the given node, mutate state deterministically, and resolve next node.
   */
  executeChoice(nodeId, choiceId, runtimeCtx = {}) {
    const node = this.getNode(nodeId);
    if (!node) throw new Error(`事件节点 "${nodeId}" 不存在`);

    const choice = node.choices.find((c) => c.id === choiceId);
    if (!choice) throw new Error(`节点 "${nodeId}" 中不存在选项 "${choiceId}"`);

    const check = this.checkConditions(choice.conditions || [], runtimeCtx);
    if (!check.passed) {
      return {
        ok: false,
        reason: choice.disabledHint || check.reason || '选项前置条件未满足',
        node,
        choice,
      };
    }

    const executionLog = this.applyEffects(choice.effects || [], runtimeCtx);

    let nextNode = null;
    if (choice.nextNodeId && this.getNode(choice.nextNodeId)) {
      nextNode = this.enterNode(choice.nextNodeId, runtimeCtx).node;
    } else if (choice.nextPoolId) {
      const drawn = this.drawFromPool(choice.nextPoolId, runtimeCtx, { excludeIds: [node.id] });
      nextNode = drawn.node;
    }

    const record = {
      nodeId: node.id,
      choiceId: choice.id,
      timestamp: Date.now(),
    };
    this.history.push(record);
    if (this.history.length > 100) this.history = this.history.slice(-100);

    const result = {
      ok: true,
      node,
      choice,
      executionLog,
      outcomeTemplate: choice.outcomeTemplate || node.template || '',
      nextNode,
      nextPhase: choice.nextPhase || null,
      timestamp: record.timestamp,
    };

    this._emit('rule:choice-executed', {
      nodeId: node.id,
      choiceId: choice.id,
      choiceLabel: choice.label,
      deltas: executionLog.deltas,
      itemsChanged: executionLog.itemsChanged,
      nextNodeId: nextNode?.id || null,
      nextPhase: result.nextPhase,
    });

    return result;
  }

  // ------------------------------------------------------------
  // Serialization
  // ------------------------------------------------------------

  serialize() {
    return {
      flags: deepClone(this.flags),
      inventory: deepClone(this.inventory),
      vars: deepClone(this.vars),
      currentNodeId: this.currentNodeId,
      history: deepClone(this.history),
    };
  }

  deserialize(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.flags = deepClone(snapshot.flags || {});
    this.inventory = deepClone(snapshot.inventory || {});
    this.vars = deepClone(snapshot.vars || {});
    this.currentNodeId = snapshot.currentNodeId ?? null;
    this.history = Array.isArray(snapshot.history) ? deepClone(snapshot.history) : [];
    this._emit('rule:deserialized', { currentNodeId: this.currentNodeId });
  }
}
