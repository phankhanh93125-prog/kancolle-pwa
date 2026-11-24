/**
 * Lightweight Pub/Sub EventBus for decoupled inter-module communication.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {(payload?: any) => void} handler
   * @returns {() => void} Unsubscribe function
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`EventBus.on expects a function handler for "${event}"`);
    }
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    const set = this._listeners.get(event);
    set.add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event once.
   * @param {string} event
   * @param {(payload?: any) => void} handler
   * @returns {() => void} Unsubscribe function
   */
  once(event, handler) {
    const wrapper = (payload) => {
      this.off(event, wrapper);
      handler(payload);
    };
    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe a handler from an event.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this._listeners.delete(event);
    }
  }

  /**
   * Emit an event synchronously to all registered subscribers.
   * @param {string} event
   * @param {any} [payload]
   */
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    // Snapshot to stay safe if handlers unsubscribe during dispatch
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] Error in listener for "${event}":`, err);
      }
    }
  }

  /**
   * Remove all listeners for a specific event, or all events if omitted.
   * @param {string} [event]
   */
  clear(event) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
  }

  /**
   * Return the number of active listeners for an event.
   * @param {string} event
   * @returns {number}
   */
  listenerCount(event) {
    return this._listeners.get(event)?.size ?? 0;
  }
}

export const eventBus = new EventBus();
