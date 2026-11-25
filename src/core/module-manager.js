/**
 * Pluggable Module Manager.
 *
 * Standard Module Interface:
 * {
 *   id: string,                        // Unique identifier
 *   name: string,                      // Human-readable display name
 *   description: string,               // Concise module summary
 *   mount(container, context): void,   // Render UI & subscribe to context
 *   unmount(): void                    // Cleanup timers, listeners, references
 * }
 */

export class ModuleManager {
  /**
   * @param {{
   *   stageElement: HTMLElement,
   *   bus: import('./event-bus.js').EventBus,
   *   storage: import('./storage.js').StorageManager,
   *   api: import('./api.js').ApiGateway,
   *   ui: object
   * }} deps
   */
  constructor({ stageElement, bus, storage, api, ui, services = {} }) {
    this._stage = stageElement;
    this._bus = bus;
    this._storage = storage;
    this._shellStore = storage.namespace('core-shell');
    this._api = api;
    this._ui = ui;
    this._services = { ...services };

    /** @type {Map<string, object>} */
    this._registry = new Map();
    /** @type {object | null} */
    this._activeModule = null;
  }

  /**
   * Validate and register a pluggable module.
   * @param {object} moduleDef
   */
  register(moduleDef) {
    if (!moduleDef || typeof moduleDef !== 'object') {
      throw new TypeError('Module definition must be an object');
    }
    const { id, name, description, mount, unmount } = moduleDef;
    if (!id || typeof id !== 'string') {
      throw new TypeError('Module must define a non-empty string "id"');
    }
    if (!name || typeof name !== 'string') {
      throw new TypeError(`Module "${id}" must define a non-empty string "name"`);
    }
    if (typeof mount !== 'function') {
      throw new TypeError(`Module "${id}" must implement mount(container, context)`);
    }
    if (typeof unmount !== 'function') {
      throw new TypeError(`Module "${id}" must implement unmount()`);
    }

    const normalized = {
      ...moduleDef,
      id: id.trim(),
      name: name.trim(),
      description: typeof description === 'string' ? description.trim() : '',
    };

    this._registry.set(normalized.id, normalized);
    this._bus.emit('module:registered', normalized);
    return this;
  }

  /**
   * Register multiple modules in sequence.
   * @param {object[]} moduleList
   */
  registerAll(moduleList = []) {
    for (const mod of moduleList) {
      this.register(mod);
    }
    return this;
  }

  /**
   * Unregister a module by id. If active, unmounts it cleanly first.
   * @param {string} id
   */
  unregister(id) {
    if (!this._registry.has(id)) return false;
    if (this._activeModule?.id === id) {
      this.unmountCurrent();
    }
    this._registry.delete(id);
    this._bus.emit('module:unregistered', { id });
    return true;
  }

  has(id) {
    return this._registry.has(id);
  }

  list() {
    return Array.from(this._registry.values()).map((mod) => ({
      id: mod.id,
      name: mod.name,
      description: mod.description,
      active: this._activeModule?.id === mod.id,
    }));
  }

  getActive() {
    return this._activeModule;
  }

  getSavedModuleId() {
    return this._shellStore.get('activeModuleId', null);
  }

  getDefaultModuleId() {
    return this._shellStore.get('defaultModuleId', null);
  }

  setDefaultModuleId(id) {
    if (!id) {
      this._shellStore.remove('defaultModuleId');
      this._bus.emit('module:default-changed', { id: null });
      return null;
    }
    if (!this._registry.has(id)) {
      throw new Error(`Module "${id}" is not registered`);
    }
    this._shellStore.set('defaultModuleId', id);
    this._shellStore.set('activeModuleId', id);
    this._bus.emit('module:default-changed', { id });
    return id;
  }

  unmountCurrent() {
    if (!this._activeModule) return;
    const prev = this._activeModule;
    try {
      prev.unmount();
    } catch (err) {
      console.error(`[ModuleManager] Error unmounting "${prev.id}":`, err);
    }
    this._ui.resetModuleBindings();
    this._stage.innerHTML = '';
    this._activeModule = null;
  }

  /**
   * Mount and activate a registered module by id.
   * @param {string} id
   */
  mount(id) {
    const mod = this._registry.get(id);
    if (!mod) {
      throw new Error(`Module "${id}" is not registered`);
    }

    this.unmountCurrent();

    const context = {
      ...this._services,
      moduleId: mod.id,
      bus: this._bus,
      storage: this._storage.namespace(`mod-${mod.id}`),
      rootStorage: this._storage,
      api: this._api,
      ui: this._ui,
      modules: this,
    };

    this._activeModule = mod;
    this._shellStore.set('activeModuleId', mod.id);

    try {
      mod.mount(this._stage, context);
    } catch (err) {
      console.error(`[ModuleManager] Error mounting "${mod.id}":`, err);
      this._stage.innerHTML = `
        <section class="surface-card error-card">
          <h2>模块加载失败</h2>
          <p class="muted-text">模块 <code>${mod.id}</code> 在 mount 阶段抛出异常。</p>
          <pre class="code-block">${String(err?.stack || err)}</pre>
        </section>
      `;
    }

    this._bus.emit('module:changed', {
      id: mod.id,
      name: mod.name,
      description: mod.description,
    });
    return mod;
  }

  /**
   * Mount the previously active module (or pinned default module), falling back to the first registered module.
   */
  mountInitial() {
    const defaultId = this.getDefaultModuleId();
    if (defaultId && this._registry.has(defaultId)) {
      return this.mount(defaultId);
    }
    const savedId = this.getSavedModuleId();
    if (savedId && this._registry.has(savedId)) {
      return this.mount(savedId);
    }
    const first = this._registry.values().next().value;
    if (first) {
      return this.mount(first.id);
    }
    return null;
  }
}
