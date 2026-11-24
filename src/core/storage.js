/**
 * Namespaced localStorage persistence engine.
 * Each module receives an isolated ScopedStorage namespace, while
 * StorageManager provides global backup export, import, and reset.
 */

const DEFAULT_PREFIX = 'pwa_base';
const SEP = '::';

function byteLength(str) {
  return new Blob([str]).size;
}

export class ScopedStorage {
  /**
   * @param {StorageManager} manager
   * @param {string} namespace
   */
  constructor(manager, namespace) {
    this._manager = manager;
    this.namespace = namespace;
  }

  _fullKey(key) {
    return `${this._manager.prefix}${SEP}${this.namespace}${SEP}${key}`;
  }

  _nsPrefix() {
    return `${this._manager.prefix}${SEP}${this.namespace}${SEP}`;
  }

  get(key, defaultValue = null) {
    try {
      const raw = this._manager.backend.getItem(this._fullKey(key));
      if (raw === null) return defaultValue;
      return JSON.parse(raw);
    } catch {
      return defaultValue;
    }
  }

  set(key, value) {
    const serialized = JSON.stringify(value);
    this._manager.backend.setItem(this._fullKey(key), serialized);
    this._manager._notify({ action: 'set', namespace: this.namespace, key });
    return value;
  }

  remove(key) {
    this._manager.backend.removeItem(this._fullKey(key));
    this._manager._notify({ action: 'remove', namespace: this.namespace, key });
  }

  has(key) {
    return this._manager.backend.getItem(this._fullKey(key)) !== null;
  }

  keys() {
    const prefix = this._nsPrefix();
    const result = [];
    for (let i = 0; i < this._manager.backend.length; i++) {
      const k = this._manager.backend.key(i);
      if (k && k.startsWith(prefix)) {
        result.push(k.slice(prefix.length));
      }
    }
    return result.sort();
  }

  getAll() {
    const data = {};
    for (const key of this.keys()) {
      data[key] = this.get(key);
    }
    return data;
  }

  clear() {
    const prefix = this._nsPrefix();
    const toRemove = [];
    for (let i = 0; i < this._manager.backend.length; i++) {
      const k = this._manager.backend.key(i);
      if (k && k.startsWith(prefix)) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => this._manager.backend.removeItem(k));
    this._manager._notify({ action: 'clear', namespace: this.namespace });
    return toRemove.length;
  }

  getUsage() {
    const prefix = this._nsPrefix();
    let keysCount = 0;
    let bytes = 0;
    for (let i = 0; i < this._manager.backend.length; i++) {
      const k = this._manager.backend.key(i);
      if (k && k.startsWith(prefix)) {
        const v = this._manager.backend.getItem(k) || '';
        keysCount += 1;
        bytes += byteLength(k) + byteLength(v);
      }
    }
    return { namespace: this.namespace, keysCount, bytes };
  }
}

export class StorageManager {
  /**
   * @param {{ prefix?: string, bus?: import('./event-bus.js').EventBus, backend?: Storage }} [options]
   */
  constructor(options = {}) {
    this.prefix = options.prefix || DEFAULT_PREFIX;
    this.bus = options.bus || null;
    this.backend = options.backend || window.localStorage;
  }

  _notify(detail) {
    if (this.bus) {
      this.bus.emit('storage:changed', detail);
    }
  }

  /**
   * Create an isolated storage handle for a module or subsystem.
   * @param {string} ns
   * @returns {ScopedStorage}
   */
  namespace(ns) {
    const clean = String(ns || '').trim();
    if (!clean || clean.includes(SEP)) {
      throw new Error(`Invalid storage namespace: "${ns}"`);
    }
    return new ScopedStorage(this, clean);
  }

  /**
   * List all active namespaces currently persisted.
   * @returns {string[]}
   */
  listNamespaces() {
    const rootPrefix = `${this.prefix}${SEP}`;
    const set = new Set();
    for (let i = 0; i < this.backend.length; i++) {
      const k = this.backend.key(i);
      if (k && k.startsWith(rootPrefix)) {
        const rest = k.slice(rootPrefix.length);
        const sepIdx = rest.indexOf(SEP);
        if (sepIdx > 0) {
          set.add(rest.slice(0, sepIdx));
        }
      }
    }
    return Array.from(set).sort();
  }

  /**
   * Aggregate storage statistics across all managed namespaces.
   */
  getStats() {
    const namespaces = this.listNamespaces().map((ns) => this.namespace(ns).getUsage());
    const totalKeys = namespaces.reduce((acc, item) => acc + item.keysCount, 0);
    const totalBytes = namespaces.reduce((acc, item) => acc + item.bytes, 0);
    return {
      prefix: this.prefix,
      namespaceCount: namespaces.length,
      totalKeys,
      totalBytes,
      namespaces,
    };
  }

  /**
   * Export all namespaced data as a structured JSON-serializable backup object.
   */
  exportBackup() {
    const namespaces = {};
    for (const ns of this.listNamespaces()) {
      namespaces[ns] = this.namespace(ns).getAll();
    }
    return {
      schema: 'modular-pwa-base-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      prefix: this.prefix,
      namespaces,
    };
  }

  /**
   * Import a previously exported JSON string or backup object.
   * @param {string | object} input
   * @param {{ replace?: boolean }} [options]
   */
  importBackup(input, { replace = false } = {}) {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schema !== 'modular-pwa-base-backup' ||
      !parsed.namespaces ||
      typeof parsed.namespaces !== 'object'
    ) {
      throw new Error('无效的备份文件格式（缺少标准 schema 或 namespaces 字段）');
    }

    if (replace) {
      this.resetAll({ silent: true });
    }

    let importedKeys = 0;
    const importedNamespaces = [];

    for (const [ns, entries] of Object.entries(parsed.namespaces)) {
      if (!ns || ns.includes(SEP) || !entries || typeof entries !== 'object') continue;
      const scope = this.namespace(ns);
      importedNamespaces.push(ns);
      for (const [key, value] of Object.entries(entries)) {
        this.backend.setItem(scope._fullKey(key), JSON.stringify(value));
        importedKeys += 1;
      }
    }

    this._notify({ action: 'import', namespaces: importedNamespaces, importedKeys });
    return { importedNamespaces, importedKeys };
  }

  /**
   * Clear all keys belonging to this application prefix.
   */
  resetAll({ silent = false } = {}) {
    const rootPrefix = `${this.prefix}${SEP}`;
    const toRemove = [];
    for (let i = 0; i < this.backend.length; i++) {
      const k = this.backend.key(i);
      if (k && k.startsWith(rootPrefix)) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => this.backend.removeItem(k));
    if (!silent) {
      this._notify({ action: 'resetAll', removedKeys: toRemove.length });
    }
    return toRemove.length;
  }
}
