/**
 * Hybrid Large-Capacity Persistence Engine.
 *
 * Layer 1 (Sync, lightweight): localStorage — ideal for small configs, preferences, and flags.
 * Layer 2 (Async, high-capacity): IndexedDB — breaks the ~5MB mobile localStorage limit for
 *   multi-slot saves, event libraries, mod bundles, and compressed WebP image Blobs.
 *
 * Both layers enforce strict namespace isolation and expose unified usage statistics
 * plus JSON backup export / import (including Blob serialization).
 */

const DEFAULT_PREFIX = 'pwa_base';
const SEP = '::';
const IDB_STORE_NAME = 'records';
const IDB_VERSION = 1;

function byteLength(str) {
  return new Blob([String(str ?? '')]).size;
}

function estimateValueBytes(value) {
  if (value === null || value === undefined) return 0;
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return value.size;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (typeof value === 'string') {
    return byteLength(value);
  }
  if (typeof value === 'object') {
    // Handle objects that embed Blobs (e.g., asset records)
    let blobBytes = 0;
    try {
      const json = JSON.stringify(value, (_k, v) => {
        if (typeof Blob !== 'undefined' && v instanceof Blob) {
          blobBytes += v.size;
          return '__blob__';
        }
        return v;
      });
      return byteLength(json || '') + blobBytes;
    } catch {
      return blobBytes;
    }
  }
  return byteLength(String(value));
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBlob(base64, mimeType = 'application/octet-stream') {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

async function serializeForBackup(value) {
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return {
      __pwaBlob: true,
      mimeType: value.type || 'application/octet-stream',
      base64: await blobToBase64(value),
    };
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      out.push(await serializeForBackup(item));
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await serializeForBackup(v);
    }
    return out;
  }
  return value;
}

function deserializeFromBackup(value) {
  if (Array.isArray(value)) {
    return value.map((item) => deserializeFromBackup(item));
  }
  if (value && typeof value === 'object') {
    if (value.__pwaBlob === true && typeof value.base64 === 'string') {
      return base64ToBlob(value.base64, value.mimeType);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deserializeFromBackup(v);
    }
    return out;
  }
  return value;
}

/**
 * Lightweight native IndexedDB key-value store with namespace index
 * and graceful in-memory fallback when IndexedDB is unavailable.
 */
export class IndexedDBStore {
  constructor(dbName) {
    this.dbName = dbName;
    /** @type {Promise<IDBDatabase | null> | null} */
    this._dbPromise = null;
    /** @type {Map<string, any>} */
    this._memoryFallback = new Map();
    this._useMemory = typeof indexedDB === 'undefined';
  }

  async open() {
    if (this._useMemory) return null;
    if (this._dbPromise) return this._dbPromise;

    this._dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(this.dbName, IDB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
            const store = db.createObjectStore(IDB_STORE_NAME, { keyPath: 'fullKey' });
            store.createIndex('by_namespace', 'namespace', { unique: false });
            store.createIndex('by_updatedAt', 'updatedAt', { unique: false });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            this._dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => {
          console.warn('[Storage] IndexedDB open failed, using in-memory fallback:', req.error);
          this._useMemory = true;
          resolve(null);
        };
      } catch (err) {
        console.warn('[Storage] IndexedDB unavailable, using in-memory fallback:', err);
        this._useMemory = true;
        resolve(null);
      }
    });

    return this._dbPromise;
  }

  _fullKey(namespace, key) {
    return `${namespace}${SEP}${key}`;
  }

  async getRecord(namespace, key) {
    const fullKey = this._fullKey(namespace, key);
    const db = await this.open();
    if (!db) {
      return this._memoryFallback.get(fullKey) || null;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readonly');
      const req = tx.objectStore(IDB_STORE_NAME).get(fullKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async putRecord(namespace, key, value, { contentType = 'application/json' } = {}) {
    const fullKey = this._fullKey(namespace, key);
    const record = {
      fullKey,
      namespace,
      key,
      value,
      sizeBytes: estimateValueBytes(value) + byteLength(fullKey),
      contentType,
      updatedAt: Date.now(),
    };
    const db = await this.open();
    if (!db) {
      this._memoryFallback.set(fullKey, record);
      return record;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_STORE_NAME).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteRecord(namespace, key) {
    const fullKey = this._fullKey(namespace, key);
    const db = await this.open();
    if (!db) {
      this._memoryFallback.delete(fullKey);
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_STORE_NAME).delete(fullKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllByNamespace(namespace) {
    const db = await this.open();
    if (!db) {
      const list = [];
      for (const rec of this._memoryFallback.values()) {
        if (rec.namespace === namespace) list.push(rec);
      }
      return list;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readonly');
      const index = tx.objectStore(IDB_STORE_NAME).index('by_namespace');
      const req = index.getAll(IDBKeyRange.only(namespace));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getAllRecords() {
    const db = await this.open();
    if (!db) {
      return Array.from(this._memoryFallback.values());
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readonly');
      const req = tx.objectStore(IDB_STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async clearNamespace(namespace) {
    const records = await this.getAllByNamespace(namespace);
    if (records.length === 0) return 0;
    const db = await this.open();
    if (!db) {
      for (const rec of records) {
        this._memoryFallback.delete(rec.fullKey);
      }
      return records.length;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IDB_STORE_NAME);
      for (const rec of records) {
        store.delete(rec.fullKey);
      }
      tx.oncomplete = () => resolve(records.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearAll() {
    const db = await this.open();
    if (!db) {
      const count = this._memoryFallback.size;
      this._memoryFallback.clear();
      return count;
    }
    const all = await this.getAllRecords();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_STORE_NAME).clear();
      tx.oncomplete = () => resolve(all.length);
      tx.onerror = () => reject(tx.error);
    });
  }
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

  // ------------------------------------------------------------
  // Layer 1: Synchronous localStorage (lightweight configs)
  // ------------------------------------------------------------

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
    this._manager._notify({ action: 'set', layer: 'local', namespace: this.namespace, key });
    return value;
  }

  remove(key) {
    this._manager.backend.removeItem(this._fullKey(key));
    this._manager._notify({ action: 'remove', layer: 'local', namespace: this.namespace, key });
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
    this._manager._notify({ action: 'clear', layer: 'local', namespace: this.namespace });
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

  // ------------------------------------------------------------
  // Layer 2: Asynchronous IndexedDB (large saves, events, blobs)
  // ------------------------------------------------------------

  async getLarge(key, defaultValue = null) {
    const rec = await this._manager.idb.getRecord(this.namespace, String(key));
    return rec ? rec.value : defaultValue;
  }

  async setLarge(key, value, options = {}) {
    await this._manager.idb.putRecord(this.namespace, String(key), value, options);
    this._manager._notify({ action: 'set', layer: 'idb', namespace: this.namespace, key: String(key) });
    return value;
  }

  async removeLarge(key) {
    await this._manager.idb.deleteRecord(this.namespace, String(key));
    this._manager._notify({ action: 'remove', layer: 'idb', namespace: this.namespace, key: String(key) });
  }

  async hasLarge(key) {
    const rec = await this._manager.idb.getRecord(this.namespace, String(key));
    return rec !== null;
  }

  async keysLarge() {
    const records = await this._manager.idb.getAllByNamespace(this.namespace);
    return records.map((r) => r.key).sort();
  }

  async getAllLarge() {
    const records = await this._manager.idb.getAllByNamespace(this.namespace);
    const out = {};
    for (const rec of records) {
      out[rec.key] = rec.value;
    }
    return out;
  }

  async clearLarge() {
    const count = await this._manager.idb.clearNamespace(this.namespace);
    this._manager._notify({ action: 'clear', layer: 'idb', namespace: this.namespace });
    return count;
  }

  async getLargeUsage() {
    const records = await this._manager.idb.getAllByNamespace(this.namespace);
    const bytes = records.reduce((acc, r) => acc + (Number(r.sizeBytes) || 0), 0);
    return { namespace: this.namespace, keysCount: records.length, bytes };
  }

  async getHybridUsage() {
    const local = this.getUsage();
    const idb = await this.getLargeUsage();
    return {
      namespace: this.namespace,
      local,
      idb,
      totalKeys: local.keysCount + idb.keysCount,
      totalBytes: local.bytes + idb.bytes,
    };
  }
}

export class StorageManager {
  /**
   * @param {{ prefix?: string, dbName?: string, bus?: import('./event-bus.js').EventBus, backend?: Storage }} [options]
   */
  constructor(options = {}) {
    this.prefix = options.prefix || DEFAULT_PREFIX;
    this.dbName = options.dbName || `${this.prefix}_idb`;
    this.bus = options.bus || null;
    this.backend = options.backend || window.localStorage;
    this.idb = new IndexedDBStore(this.dbName);
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
   * List all active localStorage namespaces currently persisted.
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
   * List all active IndexedDB namespaces currently persisted.
   * @returns {Promise<string[]>}
   */
  async listLargeNamespaces() {
    const records = await this.idb.getAllRecords();
    const set = new Set(records.map((r) => r.namespace));
    return Array.from(set).sort();
  }

  /**
   * Aggregate localStorage statistics across all managed namespaces (synchronous, backwards compatible).
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
   * Aggregate IndexedDB statistics across all managed namespaces.
   */
  async getLargeStats() {
    const records = await this.idb.getAllRecords();
    /** @type {Map<string, { namespace: string, keysCount: number, bytes: number }>} */
    const map = new Map();
    for (const rec of records) {
      if (!map.has(rec.namespace)) {
        map.set(rec.namespace, { namespace: rec.namespace, keysCount: 0, bytes: 0 });
      }
      const entry = map.get(rec.namespace);
      entry.keysCount += 1;
      entry.bytes += Number(rec.sizeBytes) || 0;
    }
    const namespaces = Array.from(map.values()).sort((a, b) => a.namespace.localeCompare(b.namespace));
    const totalKeys = namespaces.reduce((acc, item) => acc + item.keysCount, 0);
    const totalBytes = namespaces.reduce((acc, item) => acc + item.bytes, 0);
    return {
      dbName: this.dbName,
      usingMemoryFallback: this.idb._useMemory,
      namespaceCount: namespaces.length,
      totalKeys,
      totalBytes,
      namespaces,
    };
  }

  /**
   * Unified statistics combining localStorage, IndexedDB, and navigator.storage.estimate() quota.
   */
  async getHybridStats() {
    const local = this.getStats();
    const idb = await this.getLargeStats();
    let quotaEstimate = null;
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
      try {
        const est = await navigator.storage.estimate();
        quotaEstimate = {
          supported: true,
          usage: Number(est.usage) || 0,
          quota: Number(est.quota) || 0,
        };
      } catch {
        quotaEstimate = null;
      }
    }
    const allNs = new Set([
      ...local.namespaces.map((n) => n.namespace),
      ...idb.namespaces.map((n) => n.namespace),
    ]);
    return {
      prefix: this.prefix,
      dbName: this.dbName,
      namespaceCount: allNs.size,
      totalKeys: local.totalKeys + idb.totalKeys,
      totalBytes: local.totalBytes + idb.totalBytes,
      local,
      idb,
      quotaEstimate,
    };
  }

  /**
   * Export localStorage namespaces synchronously (backwards compatible v1 schema).
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
   * Export both localStorage and IndexedDB namespaces (v2 hybrid schema, Blob-safe).
   */
  async exportHybridBackup() {
    const localNamespaces = {};
    for (const ns of this.listNamespaces()) {
      localNamespaces[ns] = this.namespace(ns).getAll();
    }

    const idbNamespaces = {};
    const records = await this.idb.getAllRecords();
    for (const rec of records) {
      if (!idbNamespaces[rec.namespace]) {
        idbNamespaces[rec.namespace] = {};
      }
      idbNamespaces[rec.namespace][rec.key] = await serializeForBackup(rec.value);
    }

    return {
      schema: 'modular-pwa-hybrid-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      prefix: this.prefix,
      dbName: this.dbName,
      namespaces: localNamespaces,
      idbNamespaces,
    };
  }

  /**
   * Import synchronous v1 localStorage backup.
   */
  importBackup(input, { replace = false } = {}) {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed.schema !== 'modular-pwa-base-backup' && parsed.schema !== 'modular-pwa-hybrid-backup') ||
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

    this._notify({ action: 'import', layer: 'local', namespaces: importedNamespaces, importedKeys });
    return { importedNamespaces, importedKeys };
  }

  /**
   * Import v1 or v2 hybrid backup into both localStorage and IndexedDB.
   */
  async importHybridBackup(input, { replace = false } = {}) {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed.schema !== 'modular-pwa-base-backup' && parsed.schema !== 'modular-pwa-hybrid-backup')
    ) {
      throw new Error('无效的混合备份文件格式（不支持的 schema）');
    }

    if (replace) {
      await this.resetHybridAll({ silent: true });
    }

    let importedLocalKeys = 0;
    const importedNamespacesSet = new Set();

    if (parsed.namespaces && typeof parsed.namespaces === 'object') {
      const localRes = this.importBackup(parsed, { replace: false });
      importedLocalKeys = localRes.importedKeys;
      localRes.importedNamespaces.forEach((n) => importedNamespacesSet.add(n));
    }

    let importedIdbKeys = 0;
    if (parsed.idbNamespaces && typeof parsed.idbNamespaces === 'object') {
      for (const [ns, entries] of Object.entries(parsed.idbNamespaces)) {
        if (!ns || ns.includes(SEP) || !entries || typeof entries !== 'object') continue;
        importedNamespacesSet.add(ns);
        for (const [key, rawVal] of Object.entries(entries)) {
          const restored = deserializeFromBackup(rawVal);
          await this.idb.putRecord(ns, key, restored);
          importedIdbKeys += 1;
        }
      }
    }

    const importedNamespaces = Array.from(importedNamespacesSet);
    this._notify({
      action: 'import',
      layer: 'hybrid',
      namespaces: importedNamespaces,
      importedKeys: importedLocalKeys + importedIdbKeys,
      importedLocalKeys,
      importedIdbKeys,
    });
    return {
      importedNamespaces,
      importedLocalKeys,
      importedIdbKeys,
      importedKeys: importedLocalKeys + importedIdbKeys,
    };
  }

  /**
   * Clear all localStorage keys belonging to this application prefix.
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
      this._notify({ action: 'resetAll', layer: 'local', removedKeys: toRemove.length });
    }
    return toRemove.length;
  }

  /**
   * Clear all IndexedDB records belonging to this application database.
   */
  async resetLargeAll({ silent = false } = {}) {
    const removed = await this.idb.clearAll();
    if (!silent) {
      this._notify({ action: 'resetAll', layer: 'idb', removedKeys: removed });
    }
    return removed;
  }

  /**
   * Clear both localStorage and IndexedDB data.
   */
  async resetHybridAll({ silent = false } = {}) {
    const removedLocal = this.resetAll({ silent: true });
    const removedIdb = await this.resetLargeAll({ silent: true });
    if (!silent) {
      this._notify({
        action: 'resetAll',
        layer: 'hybrid',
        removedKeys: removedLocal + removedIdb,
        removedLocal,
        removedIdb,
      });
    }
    return { removedLocal, removedIdb, totalRemoved: removedLocal + removedIdb };
  }
}
