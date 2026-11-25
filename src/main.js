import { EventBus } from './core/event-bus.js';
import { StorageManager } from './core/storage.js';
import { ApiGateway, PROVIDER_PRESETS } from './core/api.js';
import { ModuleManager } from './core/module-manager.js';
import { SaveManager } from './core/save-manager.js';
import { CalcEngine } from './core/calc-engine.js';
import { EntitySystem } from './core/entity-system.js';
import { RuleEngine } from './core/rule-engine.js';
import { StateMachine, TurnStepper } from './core/state-machine.js';
import { PromptPipeline } from './core/prompt-pipeline.js';
import { AssetManager } from './core/asset-manager.js';
import { StatRulesEngine } from './core/stat-rules.js';
import { InventorySystem } from './core/inventory-system.js';
import { ResourceManager } from './core/resource-manager.js';
import { LogSystem } from './core/log-system.js';
import { createUIKit, showToast } from './core/ui-kit.js';
import { REGISTERED_MODULES } from './modules/index.js';
import { hydrateCharacterRoster } from './modules/character-console.js';
import { hydrateActionConsole } from './modules/action-console.js';
import { hydrateSortieConsole } from './modules/sortie-console.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

// ------------------------------------------------------------
// 1. Bootstrap Core Game Framework Engines
// ------------------------------------------------------------
const bus = new EventBus();
const storage = new StorageManager({ bus });
const api = new ApiGateway({ storage, bus });
const saves = new SaveManager({ storage, bus });
const calc = new CalcEngine();
const entities = new EntitySystem({ bus, calc });
const rules = new RuleEngine({ bus, calc, entities });
const stateMachine = new StateMachine({ bus });
const turnStepper = new TurnStepper({ bus });
const narrative = new PromptPipeline({ api, storage, bus });
const assets = new AssetManager({ storage, bus });
const statRules = new StatRulesEngine({ storage, bus });
const inventory = new InventorySystem({ storage, entities, bus });
const resources = new ResourceManager({ storage, bus });
const logs = new LogSystem({ storage, bus });
const uiKit = createUIKit();

const els = {
  activeModuleName: document.getElementById('active-module-name'),
  stage: document.getElementById('app-stage'),
  quickActionsSlot: document.getElementById('quick-actions-slot'),
  inputForm: document.getElementById('universal-input-form'),
  inputField: document.getElementById('universal-input'),
  sendBtn: document.getElementById('btn-universal-send'),
  btnModules: document.getElementById('btn-open-modules'),
  btnApi: document.getElementById('btn-open-api'),
  btnData: document.getElementById('btn-open-data'),
  sheetBackdrop: document.getElementById('sheet-backdrop'),
  sheetTitle: document.getElementById('sheet-title'),
  sheetBody: document.getElementById('sheet-body'),
  btnSheetClose: document.getElementById('btn-sheet-close'),
  toastRegion: document.getElementById('toast-region'),
};

// ------------------------------------------------------------
// 2. Shell UI Controller (passed to modules as context.ui)
// ------------------------------------------------------------
let activeInputHandler = null;
let inputBusy = false;

function autoResizeInput() {
  const el = els.inputField;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

const ui = {
  showToast,

  setPlaceholder(text) {
    els.inputField.placeholder = text || '输入指令或消息...';
  },

  setInputBusy(busy) {
    inputBusy = Boolean(busy);
    els.sendBtn.disabled = inputBusy;
    els.sendBtn.textContent = inputBusy ? '处理中' : '发送';
  },

  setInputHandler(fn) {
    activeInputHandler = typeof fn === 'function' ? fn : null;
  },

  setQuickActions(actions = []) {
    els.quickActionsSlot.innerHTML = '';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-action-btn';
      btn.textContent = action.label;
      if (action.id) btn.dataset.quickAction = action.id;
      btn.addEventListener('click', () => {
        if (typeof action.onClick === 'function') {
          action.onClick();
        }
      });
      els.quickActionsSlot.appendChild(btn);
    }
  },

  resetModuleBindings() {
    activeInputHandler = null;
    ui.setInputBusy(false);
    ui.setPlaceholder('输入指令或消息...');
    els.quickActionsSlot.innerHTML = '';
  },
};

// ------------------------------------------------------------
// 3. Universal Input Handling
// ------------------------------------------------------------
async function submitUniversalInput() {
  if (inputBusy) return;
  const text = els.inputField.value.trim();
  if (!text) return;

  els.inputField.value = '';
  autoResizeInput();

  bus.emit('input:submit', { text });
  if (activeInputHandler) {
    await activeInputHandler(text);
  } else {
    showToast('当前模块未绑定输入处理器');
  }
}

els.inputForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitUniversalInput();
});

els.inputField.addEventListener('input', autoResizeInput);
els.inputField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitUniversalInput();
  }
});

// ------------------------------------------------------------
// 4. Module Manager Initialization
// ------------------------------------------------------------
const moduleManager = new ModuleManager({
  stageElement: els.stage,
  bus,
  storage,
  api,
  ui,
  services: {
    saves,
    calc,
    entities,
    rules,
    stateMachine,
    turnStepper,
    narrative,
    assets,
    statRules,
    inventory,
    resources,
    logs,
    uiKit,
  },
});

bus.on('module:changed', (mod) => {
  els.activeModuleName.textContent = mod.name;
});

moduleManager.registerAll(REGISTERED_MODULES);

// ------------------------------------------------------------
// 5. Bottom Sheet Modal Controller
// ------------------------------------------------------------
function openSheet(title, renderFn) {
  els.sheetTitle.textContent = title;
  els.sheetBody.innerHTML = '';
  renderFn(els.sheetBody);
  els.sheetBackdrop.hidden = false;
}

function closeSheet() {
  els.sheetBackdrop.hidden = true;
  els.sheetBody.innerHTML = '';
}

els.btnSheetClose.addEventListener('click', closeSheet);
els.sheetBackdrop.addEventListener('click', (e) => {
  if (e.target === els.sheetBackdrop) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.sheetBackdrop.hidden) {
    closeSheet();
  }
});

// --- Sheet 1: Module Management ---
function openModulesSheet() {
  openSheet('模块管理', (body) => {
    const modules = moduleManager.list();

    body.innerHTML = `
      <p class="muted-text">点击任意已注册模块即可实时切换挂载到主容器，每个模块拥有独立的数据命名空间（支持 localStorage 与 IndexedDB 双层存储）。</p>
      <div class="module-list" id="module-manager-list">
        ${modules
          .map(
            (m) => `
          <button type="button" class="module-item ${m.active ? 'is-active' : ''}" data-module-id="${escapeHtml(m.id)}">
            <div class="module-item-info">
              <div class="module-item-title">
                <span>${escapeHtml(m.name)}</span>
                <span class="module-item-id">${escapeHtml(m.id)}</span>
              </div>
              <div class="module-item-desc">${escapeHtml(m.description || '无描述')}</div>
            </div>
            <span class="status-badge ${m.active ? 'badge-ok' : ''}">
              ${m.active ? '运行中' : '切换'}
            </span>
          </button>
        `
          )
          .join('')}
      </div>
      <div class="surface-card">
        <p class="muted-text">扩展提示：按照根目录 <code>ARCHITECTURE.md</code> 的 3 步规范新建模块文件并注册到 <code>src/modules/index.js</code>，即可自动出现在此列表。</p>
      </div>
    `;

    body.querySelectorAll('[data-module-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-module-id');
        if (id) {
          moduleManager.mount(id);
          showToast(`已切换模块：${moduleManager.getActive()?.name || id}`, 'ok');
          closeSheet();
        }
      });
    });
  });
}

// --- Sheet 2: API Settings ---
function openApiSheet() {
  openSheet('API 设置', (body) => {
    let draft = api.getConfig();

    const renderForm = () => {
      const preset = PROVIDER_PRESETS[draft.provider] || PROVIDER_PRESETS.gemini;
      body.innerHTML = `
        <form id="api-settings-form" class="module-stack" novalidate>
          <div class="form-group">
            <span class="form-label">接口协议</span>
            <div class="segmented-control" role="tablist">
              <button type="button" class="segment-btn ${draft.provider === 'gemini' ? 'is-active' : ''}" data-provider="gemini">
                Google Gemini REST
              </button>
              <button type="button" class="segment-btn ${draft.provider === 'openai' ? 'is-active' : ''}" data-provider="openai">
                OpenAI 兼容格式
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="api-base-url">Base URL</label>
            <input id="api-base-url" class="form-input" type="url" value="${escapeHtml(draft.baseUrl)}" placeholder="${escapeHtml(preset.baseUrl)}">
          </div>

          <div class="form-group">
            <label class="form-label" for="api-key">API Key（仅保存在本地浏览器，留空自动使用模拟回显 / 离线模式）</label>
            <input id="api-key" class="form-input" type="password" value="${escapeHtml(draft.apiKey)}" placeholder="留空即启用本地模拟回显与离线降级" autocomplete="off">
          </div>

          <div class="form-group">
            <label class="form-label" for="api-model">模型名称</label>
            <input id="api-model" class="form-input" type="text" value="${escapeHtml(draft.model)}" placeholder="${escapeHtml(preset.model)}">
            <div class="chip-row">
              ${preset.suggestedModels
                .map(
                  (m) =>
                    `<button type="button" class="preset-chip" data-preset-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`
                )
                .join('')}
            </div>
          </div>

          <div class="form-group">
            <div class="form-label-row">
              <label class="form-label" for="api-temp">温度（Temperature）</label>
              <span id="api-temp-val" class="status-model">${Number(draft.temperature).toFixed(1)}</span>
            </div>
            <input id="api-temp" class="range-input" type="range" min="0" max="2" step="0.1" value="${escapeHtml(draft.temperature)}">
          </div>

          <div class="form-group">
            <label class="form-label" for="api-system-prompt">系统提示词（System Prompt）</label>
            <textarea id="api-system-prompt" class="form-textarea" placeholder="定义模型的默认角色或回复风格...">${escapeHtml(draft.systemPrompt)}</textarea>
          </div>

          <label class="checkbox-row">
            <input id="api-force-mock" type="checkbox" ${draft.forceMock ? 'checked' : ''}>
            <span>强制启用本地模拟回显模式（即使已填 Key 也不发起网络请求）</span>
          </label>

          <div id="api-test-output" class="test-result-box" hidden></div>

          <div class="sheet-actions">
            <button type="button" id="btn-api-test" class="btn-secondary">测试连接</button>
            <button type="submit" id="btn-api-save" class="btn-primary">保存配置</button>
          </div>
        </form>
      `;

      const readDraftFromInputs = () => ({
        provider: draft.provider,
        baseUrl: body.querySelector('#api-base-url').value.trim(),
        apiKey: body.querySelector('#api-key').value.trim(),
        model: body.querySelector('#api-model').value.trim(),
        temperature: Number(body.querySelector('#api-temp').value),
        systemPrompt: body.querySelector('#api-system-prompt').value,
        forceMock: body.querySelector('#api-force-mock').checked,
      });

      body.querySelectorAll('[data-provider]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const nextProvider = btn.getAttribute('data-provider');
          if (!nextProvider || nextProvider === draft.provider) return;
          const current = readDraftFromInputs();
          const nextPreset = PROVIDER_PRESETS[nextProvider];
          draft = {
            ...current,
            provider: nextProvider,
            baseUrl: nextPreset.baseUrl,
            model: nextPreset.model,
          };
          renderForm();
        });
      });

      body.querySelectorAll('[data-preset-model]').forEach((chip) => {
        chip.addEventListener('click', () => {
          const val = chip.getAttribute('data-preset-model');
          body.querySelector('#api-model').value = val;
        });
      });

      const tempInput = body.querySelector('#api-temp');
      const tempVal = body.querySelector('#api-temp-val');
      tempInput.addEventListener('input', () => {
        tempVal.textContent = Number(tempInput.value).toFixed(1);
      });

      const testBtn = body.querySelector('#btn-api-test');
      const testOutput = body.querySelector('#api-test-output');
      testBtn.addEventListener('click', async () => {
        const current = readDraftFromInputs();
        testBtn.disabled = true;
        testBtn.textContent = '测试中...';
        testOutput.hidden = false;
        testOutput.className = 'test-result-box';
        testOutput.textContent = '正在执行连通性测试...';

        const result = await api.testConnection(current);
        testBtn.disabled = false;
        testBtn.textContent = '测试连接';
        testOutput.className = `test-result-box ${result.ok ? 'is-ok' : 'is-error'}`;
        testOutput.textContent = result.message;
      });

      body.querySelector('#api-settings-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const saved = api.saveConfig(readDraftFromInputs());
        showToast(
          api.isMockMode(saved)
            ? '配置已保存到本地（当前为模拟回显 / 离线模式）'
            : `配置已保存：${saved.provider} / ${saved.model}`,
          'ok'
        );
        closeSheet();
      });
    };

    renderForm();
  });
}

// --- Sheet 3: Data Management (Hybrid localStorage + IndexedDB) ---
function openDataSheet() {
  openSheet('数据管理（混合存储）', (body) => {
    let confirmResetArmed = false;

    const renderDataView = async () => {
      body.innerHTML = '<p class="muted-text">正在统计 localStorage 与 IndexedDB 占用...</p>';
      const stats = await storage.getHybridStats();
      const quotaText =
        stats.quotaEstimate && stats.quotaEstimate.quota > 0
          ? `浏览器可用配额：${formatBytes(stats.quotaEstimate.usage)} / ${formatBytes(stats.quotaEstimate.quota)}`
          : '浏览器配额信息由本地引擎自动托管';

      body.innerHTML = `
        <div class="storage-summary-grid">
          <div class="metric-card">
            <span class="metric-value">${stats.namespaceCount}</span>
            <span class="metric-label">总命名空间</span>
          </div>
          <div class="metric-card">
            <span class="metric-value">${formatBytes(stats.local.totalBytes)}</span>
            <span class="metric-label">localStorage</span>
          </div>
          <div class="metric-card">
            <span class="metric-value">${formatBytes(stats.idb.totalBytes)}</span>
            <span class="metric-label">IndexedDB</span>
          </div>
        </div>
        <p class="muted-text">${escapeHtml(quotaText)}</p>

        <div class="namespace-list">
          ${stats.local.namespaces
            .map(
              (ns) => `
            <div class="namespace-row">
              <code>[Local] ${escapeHtml(ns.namespace)}</code>
              <span class="muted-text">${ns.keysCount} 键 · ${formatBytes(ns.bytes)}</span>
            </div>
          `
            )
            .join('')}
          ${stats.idb.namespaces
            .map(
              (ns) => `
            <div class="namespace-row">
              <code>[IDB] ${escapeHtml(ns.namespace)}</code>
              <span class="muted-text">${ns.keysCount} 项 · ${formatBytes(ns.bytes)}</span>
            </div>
          `
            )
            .join('')}
          ${
            stats.local.namespaces.length === 0 && stats.idb.namespaces.length === 0
              ? '<p class="muted-text">当前尚无本地存储数据。</p>'
              : ''
          }
        </div>

        <div class="data-actions-stack">
          <button type="button" id="btn-export-json" class="btn-primary">导出混合 JSON 备份（含 IDB 与图片）</button>
          <button type="button" id="btn-import-json" class="btn-secondary">导入 JSON 备份</button>
          <input type="file" id="input-import-file" accept="application/json,.json" hidden>
          <button type="button" id="btn-reset-storage" class="btn-danger">
            ${confirmResetArmed ? '再次点击确认：清空全部本地与 IDB 数据' : '清空重置全部本地与 IDB 数据'}
          </button>
        </div>
      `;

      body.querySelector('#btn-export-json').addEventListener('click', async () => {
        const backup = await storage.exportHybridBackup();
        const blob = new Blob([JSON.stringify(backup, null, 2)], {
          type: 'application/json;charset=utf-8',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pwa-hybrid-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast('已导出混合 JSON 备份文件', 'ok');
      });

      const fileInput = body.querySelector('#input-import-file');
      body.querySelector('#btn-import-json').addEventListener('click', () => {
        fileInput.click();
      });

      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const result = await storage.importHybridBackup(text, { replace: false });
          showToast(`导入成功：Local ${result.importedLocalKeys} 项 + IDB ${result.importedIdbKeys} 项`, 'ok');
          await renderDataView();
        } catch (err) {
          showToast(err instanceof Error ? err.message : '导入失败', 'error');
        } finally {
          fileInput.value = '';
        }
      });

      body.querySelector('#btn-reset-storage').addEventListener('click', async () => {
        if (!confirmResetArmed) {
          confirmResetArmed = true;
          await renderDataView();
          return;
        }
        const removed = await storage.resetHybridAll();
        confirmResetArmed = false;
        showToast(`已清空 Local ${removed.removedLocal} 项 + IDB ${removed.removedIdb} 项`, 'ok');
        await renderDataView();
      });
    };

    renderDataView();
  });
}

els.btnModules.addEventListener('click', openModulesSheet);
els.btnApi.addEventListener('click', openApiSheet);
els.btnData.addEventListener('click', openDataSheet);

// ------------------------------------------------------------
// 6. Hydrate Persisted Core Data, Bind Auto-Save & Boot Home
// ------------------------------------------------------------
async function bootApplication() {
  try {
    await Promise.all([inventory.init(), resources.init(), logs.init()]);
    await hydrateCharacterRoster({ storage, entities, inventory, statRules });
    await Promise.all([
      hydrateActionConsole({ storage, rules }),
      hydrateSortieConsole({ storage }),
    ]);
  } catch (err) {
    console.error('[App] Persistence hydration failed:', err);
  }

  logs.attachBusListeners();

  // Trigger Auto-Save snapshot whenever equipment, slots, characters, port service, sortie, actions, resources, or rules mutate
  saves.bindAutoSaveEvents(
    [
      'inventory:equipped',
      'inventory:unequipped',
      'inventory:consumed',
      'inventory:enhanced',
      'inventory:slot-added',
      'inventory:slot-renamed',
      'inventory:slot-removed',
      'character:saved',
      'character:deleted',
      'resource:changed',
      'stat-rules:changed',
      'action:settled',
      'action:events-changed',
      'port:serviced',
      'sortie:launched',
      'sortie:node-resolved',
      'sortie:returned',
      'sortie:routes-changed',
    ],
    (eventName) => ({
      name: '系统自动存档快照',
      data: {
        entities: entities.serialize(),
        inventory: inventory.serialize(),
        resources: resources.serialize(),
        statRules: statRules.getConfig(),
      },
      summary: {
        trigger: eventName,
        characters: entities.list({ kind: 'character' }).length,
        items: inventory.listItems().length,
      },
    }),
    { debounceMs: 180 }
  );

  // One-time default home migration so Port Hub opens as default home screen
  const shellStore = storage.namespace('core-shell');
  if (shellStore.get('homeVersion', null) !== 'port-hub-v1') {
    shellStore.set('homeVersion', 'port-hub-v1');
    shellStore.set('activeModuleId', 'port-hub');
  }

  moduleManager.mountInitial();
}

bootApplication();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((err) => {
      console.warn('[PWA] Service Worker registration skipped:', err);
    });
  });
}

// Expose read-only debug handle for browser console inspection
window.__APP_BASE__ = {
  bus,
  storage,
  api,
  saves,
  calc,
  entities,
  rules,
  stateMachine,
  turnStepper,
  narrative,
  assets,
  statRules,
  inventory,
  resources,
  logs,
  uiKit,
  modules: moduleManager,
};
