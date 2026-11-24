/**
 * Generic Application / Game Phase State Machine & Turn/Time Stepper.
 *
 * - StateMachine: manages custom state nodes, guarded transitions, and transition history.
 * - TurnStepper: advances generic turns / sub-cycles and broadcasts periodic EventBus events.
 */

export class StateMachine {
  /**
   * @param {{
   *   bus?: import('./event-bus.js').EventBus | null,
   *   initialState?: string | null
   * }} [options]
   */
  constructor({ bus = null, initialState = null } = {}) {
    this._bus = bus;
    /** @type {Map<string, { id: string, label: string, meta: object, onEnter?: Function, onExit?: Function }>} */
    this._states = new Map();
    /** @type {Array<{ from: string, to: string, label: string, guard?: Function }>} */
    this._transitions = [];
    /** @type {string | null} */
    this._current = initialState;
    /** @type {Array<{ from: string | null, to: string, timestamp: number, reason: string }>} */
    this._history = [];
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  addState(id, { label, meta = {}, onEnter = null, onExit = null } = {}) {
    const cleanId = String(id || '').trim();
    if (!cleanId) throw new Error('State id 不能为空');
    this._states.set(cleanId, {
      id: cleanId,
      label: String(label || cleanId),
      meta: { ...meta },
      onEnter,
      onExit,
    });
    if (this._current === null) {
      this._current = cleanId;
    }
    return this;
  }

  addStates(defs = []) {
    for (const def of defs) {
      this.addState(def.id, def);
    }
    return this;
  }

  /**
   * Define a valid transition from `from` (or '*' wildcard) to `to`.
   */
  addTransition(from, to, { label = '', guard = null } = {}) {
    this._transitions.push({
      from: String(from),
      to: String(to),
      label: String(label || `${from} -> ${to}`),
      guard: typeof guard === 'function' ? guard : null,
    });
    return this;
  }

  addTransitions(list = []) {
    for (const t of list) {
      this.addTransition(t.from, t.to, t);
    }
    return this;
  }

  getState() {
    return this._current;
  }

  getStateDef(id = this._current) {
    return id ? this._states.get(id) || null : null;
  }

  listStates() {
    return Array.from(this._states.values()).map((s) => ({
      id: s.id,
      label: s.label,
      meta: s.meta,
      active: s.id === this._current,
    }));
  }

  getHistory() {
    return [...this._history];
  }

  canTransition(to, payload = {}) {
    const targetId = String(to || '');
    if (!this._states.has(targetId)) {
      return { ok: false, reason: `目标状态 "${targetId}" 未注册` };
    }
    if (this._current === targetId) {
      return { ok: false, reason: `当前已处于 "${targetId}" 状态` };
    }
    const matching = this._transitions.filter(
      (t) => (t.from === this._current || t.from === '*') && t.to === targetId
    );
    if (matching.length === 0) {
      return { ok: false, reason: `不允许从 "${this._current}" 直接切换到 "${targetId}"` };
    }
    for (const rule of matching) {
      if (!rule.guard) return { ok: true, reason: '', rule };
      const guardResult = rule.guard({ from: this._current, to: targetId, payload });
      if (guardResult === true) return { ok: true, reason: '', rule };
      if (guardResult && typeof guardResult === 'object' && guardResult.ok) {
        return { ok: true, reason: '', rule };
      }
      if (guardResult && typeof guardResult === 'object' && guardResult.reason) {
        return { ok: false, reason: guardResult.reason };
      }
    }
    return { ok: false, reason: `切换至 "${targetId}" 未通过守卫校验` };
  }

  getAllowedTransitions(payload = {}) {
    const results = [];
    for (const state of this._states.values()) {
      if (state.id === this._current) continue;
      const check = this.canTransition(state.id, payload);
      if (check.ok) {
        results.push({
          to: state.id,
          label: state.label,
          transitionLabel: check.rule?.label || state.label,
        });
      }
    }
    return results;
  }

  transition(to, payload = {}, { reason = 'transition', force = false } = {}) {
    const targetId = String(to || '');
    if (!this._states.has(targetId)) {
      return { ok: false, reason: `目标状态 "${targetId}" 未注册` };
    }
    if (!force) {
      const check = this.canTransition(targetId, payload);
      if (!check.ok) return check;
    }

    const prevId = this._current;
    const prevDef = prevId ? this._states.get(prevId) : null;
    const nextDef = this._states.get(targetId);

    if (prevDef && typeof prevDef.onExit === 'function') {
      prevDef.onExit({ from: prevId, to: targetId, payload });
    }

    this._current = targetId;
    const timestamp = Date.now();
    this._history.push({ from: prevId, to: targetId, timestamp, reason });
    if (this._history.length > 80) this._history = this._history.slice(-80);

    if (nextDef && typeof nextDef.onEnter === 'function') {
      nextDef.onEnter({ from: prevId, to: targetId, payload });
    }

    const detail = {
      from: prevId,
      to: targetId,
      label: nextDef.label,
      payload,
      reason,
      timestamp,
    };
    this._emit('state:changed', detail);
    return { ok: true, ...detail };
  }

  serialize() {
    return {
      current: this._current,
      history: this._history.slice(-40),
    };
  }

  deserialize(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot.current && this._states.has(snapshot.current)) {
      this._current = snapshot.current;
    }
    if (Array.isArray(snapshot.history)) {
      this._history = snapshot.history.slice(-40);
    }
    this._emit('state:deserialized', { current: this._current });
  }
}

export class TurnStepper {
  /**
   * @param {{
   *   bus?: import('./event-bus.js').EventBus | null,
   *   cycleLabels?: string[],
   *   initialTurn?: number
   * }} [options]
   */
  constructor({ bus = null, cycleLabels = ['阶段 I', '阶段 II', '阶段 III'], initialTurn = 1 } = {}) {
    this._bus = bus;
    this.cycleLabels = Array.isArray(cycleLabels) && cycleLabels.length > 0 ? [...cycleLabels] : ['常规'];
    this.turn = Math.max(1, Number(initialTurn) || 1);
    this.cycleIndex = 0;
    this.totalTicks = 0;
    this.lastTickAt = Date.now();
  }

  setCycleLabels(labels) {
    if (Array.isArray(labels) && labels.length > 0) {
      this.cycleLabels = [...labels];
      this.cycleIndex = this.cycleIndex % this.cycleLabels.length;
    }
    return this;
  }

  getSnapshot() {
    return {
      turn: this.turn,
      cycleIndex: this.cycleIndex,
      cycleLabel: this.cycleLabels[this.cycleIndex] || '',
      cycleLength: this.cycleLabels.length,
      totalTicks: this.totalTicks,
      lastTickAt: this.lastTickAt,
    };
  }

  /**
   * Advance by `steps` sub-steps (or full turns if `advanceTurnDirectly` is true).
   */
  advance({ steps = 1, advanceTurnDirectly = false, reason = 'step', meta = {} } = {}) {
    const count = Math.max(1, Math.floor(Number(steps) || 1));
    const prev = this.getSnapshot();
    let cyclesCompleted = 0;

    if (advanceTurnDirectly) {
      this.turn += count;
      this.totalTicks += count;
      cyclesCompleted = count;
    } else {
      for (let i = 0; i < count; i++) {
        this.totalTicks += 1;
        this.cycleIndex += 1;
        if (this.cycleIndex >= this.cycleLabels.length) {
          this.cycleIndex = 0;
          this.turn += 1;
          cyclesCompleted += 1;
        }
      }
    }

    this.lastTickAt = Date.now();
    const current = this.getSnapshot();
    const payload = {
      prev,
      current,
      steps: count,
      cyclesCompleted,
      reason,
      meta,
      timestamp: this.lastTickAt,
    };

    if (this._bus) {
      this._bus.emit('turn:advanced', payload);
      if (cyclesCompleted > 0) {
        this._bus.emit('cycle:completed', payload);
      }
    }
    return payload;
  }

  reset({ initialTurn = 1 } = {}) {
    this.turn = Math.max(1, Number(initialTurn) || 1);
    this.cycleIndex = 0;
    this.totalTicks = 0;
    this.lastTickAt = Date.now();
    if (this._bus) {
      this._bus.emit('turn:reset', this.getSnapshot());
    }
    return this.getSnapshot();
  }

  serialize() {
    return {
      turn: this.turn,
      cycleIndex: this.cycleIndex,
      cycleLabels: [...this.cycleLabels],
      totalTicks: this.totalTicks,
      lastTickAt: this.lastTickAt,
    };
  }

  deserialize(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (Array.isArray(snapshot.cycleLabels) && snapshot.cycleLabels.length > 0) {
      this.cycleLabels = [...snapshot.cycleLabels];
    }
    this.turn = Math.max(1, Number(snapshot.turn) || 1);
    this.cycleIndex = Math.max(0, Number(snapshot.cycleIndex) || 0) % this.cycleLabels.length;
    this.totalTicks = Math.max(0, Number(snapshot.totalTicks) || 0);
    this.lastTickAt = Number(snapshot.lastTickAt) || Date.now();
  }
}
