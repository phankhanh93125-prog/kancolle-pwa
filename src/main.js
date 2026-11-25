import { EventBus } from './core/event-bus.js';
import { StorageManager } from './core/storage.js';
import { ApiGateway, PROVIDER_PRESETS } from './core/api.js';
import { ModuleManager } from './core/module-manager.js';
import {
  SaveManager,
  VAULT_PRIMARY_SLOTS,
  migrateSavePayload,
  triggerJsonDownload,
} from './core/save-manager.js';
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
import { FxStage } from './core/fx-stage.js';
import { RouteGenerator } from './core/route-generator.js';
import { TacticalCombatEngine } from './core/tactical-combat.js';
import { CommanderSystem } from './core/commander-system.js';
import { FormationSystem } from './core/formation-system.js';
import { ExpeditionSystem } from './core/expedition-system.js';
import { PortBuildingsSystem } from './core/port-buildings.js';
import { InteractionSystem } from './core/interaction-system.js';
import { ContentManager } from './core/content-manager.js';
import { StoryPackEngine } from './core/story-pack-engine.js';
import { ThemeManager } from './core/theme-manager.js';
import { PersonalityPool } from './core/personality-pool.js';
import { DialogueEngine } from './core/dialogue-engine.js';
import { createUIKit, showToast } from './core/ui-kit.js';
import { REGISTERED_MODULES } from './modules/index.js';
import { hydrateCharacterRoster, persistCharacterRoster } from './modules/character-console.js';
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
const theme = new ThemeManager({ storage, bus });
// Apply persisted CSS Variable skin immediately before rendering UI
theme.applyTheme();

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
const commander = new CommanderSystem({ storage, bus });
const inventory = new InventorySystem({ storage, entities, commander, bus });
const resources = new ResourceManager({ storage, bus });
const logs = new LogSystem({ storage, bus });
const personalityPool = new PersonalityPool({ storage, bus });
const dialogueEngine = new DialogueEngine({ personalityPool, entities, logs });
const fxStage = new FxStage({ bus, storage });
const routeGenerator = new RouteGenerator({ storage, bus });
const formation = new FormationSystem({ storage, entities, inventory, commander, bus });
const expeditions = new ExpeditionSystem({
  storage,
  entities,
  inventory,
  resources,
  commander,
  statRules,
  logs,
  formation,
  bus,
});
formation.setExpeditions(expeditions);

const buildings = new PortBuildingsSystem({
  storage,
  entities,
  inventory,
  resources,
  commander,
  personalityPool,
  dialogueEngine,
  logs,
  bus,
});

const interaction = new InteractionSystem({
  storage,
  entities,
  inventory,
  resources,
  statRules,
  commander,
  narrative,
  dialogueEngine,
  logs,
  bus,
});

const contentManager = new ContentManager({
  storage,
  entities,
  inventory,
  routeGenerator,
  buildings,
  interaction,
  commander,
  logs,
  bus,
});
interaction.setContentManager(contentManager);

const storyPacks = new StoryPackEngine({
  storage,
  entities,
  inventory,
  resources,
  statRules,
  commander,
  interaction,
  narrative,
  logs,
  bus,
});

const combat = new TacticalCombatEngine({
  entities,
  inventory,
  statRules,
  resources,
  narrative,
  dialogueEngine,
  commander,
  formation,
  bus,
});
const uiKit = createUIKit();

const els = {
  activeModuleName: document.getElementById('active-module-name'),
  moduleNavStrip: document.getElementById('module-nav-strip'),
  stage: document.getElementById('app-stage'),
  quickActionsSlot: document.getElementById('quick-actions-slot'),
  inputForm: document.getElementById('universal-input-form'),
  inputField: document.getElementById('universal-input'),
  sendBtn: document.getElementById('btn-universal-send'),
  btnModules: document.getElementById('btn-open-modules'),
  btnTheme: document.getElementById('btn-open-theme'),
  btnVault: document.getElementById('btn-open-vault'),
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
    personalityPool,
    dialogueEngine,
    fxStage,
    routeGenerator,
    combat,
    commander,
    formation,
    expeditions,
    buildings,
    interaction,
    contentManager,
    storyPacks,
    theme,
    uiKit,
  },
});

function isAnyModalOpen() {
  if (els.sheetBackdrop && !els.sheetBackdrop.hidden) return true;
  const uiBackdrops = document.querySelectorAll('.uikit-sheet-backdrop');
  for (const bd of uiBackdrops) {
    if (!bd.hidden && !bd.closest('[hidden]') && window.getComputedStyle(bd).display !== 'none') {
      return true;
    }
  }
  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (const dlg of dialogs) {
    if (!dlg.hidden && !dlg.closest('[hidden]') && window.getComputedStyle(dlg).display !== 'none') {
      return true;
    }
  }
  return false;
}

function renderModuleNavStrip(activeId = null) {
  if (!els.moduleNavStrip) return;
  const list = moduleManager.list();
  const curId = activeId || moduleManager.getActive()?.id || list[0]?.id;
  els.moduleNavStrip.innerHTML = '';

  for (const mod of list) {
    const isAct = mod.id === curId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `module-nav-pill ${isAct ? 'is-active' : ''}`.trim();
    btn.dataset.navModule = mod.id;
    btn.textContent = mod.name;
    if (isAct) btn.setAttribute('aria-current', 'page');
    btn.addEventListener('click', () => {
      if (mod.id === moduleManager.getActive()?.id) return;
      const curIdx = list.findIndex((m) => m.id === moduleManager.getActive()?.id);
      const nextIdx = list.findIndex((m) => m.id === mod.id);
      const dir = curIdx >= 0 && nextIdx >= 0 ? (nextIdx > curIdx ? 'left' : 'right') : null;
      moduleManager.mount(mod.id, { transition: dir });
    });
    els.moduleNavStrip.appendChild(btn);
  }

  const activePill = els.moduleNavStrip.querySelector('.module-nav-pill.is-active');
  if (activePill && typeof activePill.scrollIntoView === 'function') {
    activePill.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
}

function hasHorizontallyScrollableAncestor(target, boundary) {
  let node = target instanceof Element ? target : null;
  while (node && node !== boundary && node !== document.body) {
    if (node.dataset?.noSwipe === 'true') return true;
    const tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
    const style = window.getComputedStyle(node);
    const ox = style.overflowX;
    if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth + 4) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function attachStageSwipeNavigation() {
  if (!els.stage) return;
  let touchState = null;

  els.stage.addEventListener(
    'touchstart',
    (e) => {
      if (isAnyModalOpen()) {
        touchState = null;
        return;
      }
      if (!e.touches || e.touches.length !== 1) {
        touchState = null;
        return;
      }
      if (hasHorizontallyScrollableAncestor(e.target, els.stage)) {
        touchState = null;
        return;
      }
      const t = e.touches[0];
      touchState = {
        startX: t.clientX,
        startY: t.clientY,
        lastX: t.clientX,
        lastY: t.clientY,
        startedAt: Date.now(),
        cancelled: false,
      };
    },
    { passive: true }
  );

  els.stage.addEventListener(
    'touchmove',
    (e) => {
      if (!touchState || touchState.cancelled) return;
      if (isAnyModalOpen() || !e.touches || e.touches.length !== 1) {
        touchState.cancelled = true;
        return;
      }
      const t = e.touches[0];
      touchState.lastX = t.clientX;
      touchState.lastY = t.clientY;
    },
    { passive: true }
  );

  els.stage.addEventListener(
    'touchcancel',
    () => {
      touchState = null;
    },
    { passive: true }
  );

  els.stage.addEventListener(
    'touchend',
    (e) => {
      if (!touchState || touchState.cancelled || isAnyModalOpen()) {
        touchState = null;
        return;
      }
      const changed = e.changedTouches && e.changedTouches[0];
      const endX = changed ? changed.clientX : touchState.lastX;
      const endY = changed ? changed.clientY : touchState.lastY;
      const dx = endX - touchState.startX;
      const dy = endY - touchState.startY;
      touchState = null;

      // Strict anti-mistouch guards:
      // 1) Vertical scroll dominant (|deltaY| >= |deltaX|) -> ignore
      // 2) Horizontal distance < 60px -> ignore
      if (Math.abs(dy) >= Math.abs(dx)) return;
      if (Math.abs(dx) < 60) return;

      const list = moduleManager.list();
      const curId = moduleManager.getActive()?.id;
      const curIdx = list.findIndex((m) => m.id === curId);
      if (curIdx < 0) return;

      if (dx <= -60 && curIdx < list.length - 1) {
        // Swipe left -> Next module
        moduleManager.mount(list[curIdx + 1].id, { transition: 'left' });
      } else if (dx >= 60 && curIdx > 0) {
        // Swipe right -> Previous module
        moduleManager.mount(list[curIdx - 1].id, { transition: 'right' });
      }
    },
    { passive: true }
  );
}

bus.on('module:changed', (mod) => {
  els.activeModuleName.textContent = mod.name;
  renderModuleNavStrip(mod.id);
});

moduleManager.registerAll(REGISTERED_MODULES);
renderModuleNavStrip();
attachStageSwipeNavigation();

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

// ------------------------------------------------------------
// Full-World Snapshot Capture & Lossless Restore Helpers
// ------------------------------------------------------------
function captureFullWorldSnapshot() {
  return {
    commander: commander.serialize(),
    formation: formation.serialize(),
    expeditions: expeditions.serialize(),
    buildings: buildings.serialize(),
    interaction: interaction.serialize(),
    contentManager: contentManager.serialize(),
    storyPacks: storyPacks.serialize(),
    personalityPool: personalityPool.serialize(),
    theme: theme.serialize(),
    entities: entities.serialize(),
    inventory: inventory.serialize(),
    resources: resources.serialize(),
    statRules: statRules.getConfig(),
  };
}

function buildSaveSummary(trigger = 'manual') {
  const cmd = commander.getProfile();
  const sec = interaction.getSecretary() || entities.list({ kind: 'character' })[0] || null;
  const flagsCount = Object.keys(storyPacks.getAllFlags()).length;
  return {
    trigger,
    commanderName: cmd.name,
    commanderLevel: cmd.level,
    flagshipName: sec ? sec.name : '未指派',
    fleetCount: formation.getMemberIds().length,
    customBuildings: buildings.listCustomBuildings().length,
    characters: entities.list({ kind: 'character' }).length,
    items: inventory.listItems().length,
    flagsCount,
    themePreset: theme.getActivePreset().name,
  };
}

async function restoreFullWorldSnapshot(rawData) {
  const { data, migrated } = migrateSavePayload(rawData);
  if (data.statRules) statRules.updateConfig(data.statRules);
  if (data.personalityPool) personalityPool.deserialize(data.personalityPool, { persist: true });
  if (data.commander) commander.deserialize(data.commander, { persist: true });
  if (data.entities) {
    entities.deserialize(data.entities);
    for (const ch of entities.list({ kind: 'character' })) {
      personalityPool.ensurePersonalityOnEntity(ch);
    }
    await persistCharacterRoster({ storage, entities });
  }
  if (data.inventory) inventory.deserialize(data.inventory, { persist: true });
  if (data.resources) resources.deserialize(data.resources, { persist: true });
  if (data.formation) formation.deserialize(data.formation, { persist: true });
  if (data.expeditions) expeditions.deserialize(data.expeditions, { persist: true });
  if (data.buildings) buildings.deserialize(data.buildings, { persist: true });
  if (data.interaction) interaction.deserialize(data.interaction, { persist: true });
  if (data.contentManager) contentManager.deserialize(data.contentManager, { persist: true });
  if (data.storyPacks) storyPacks.deserialize(data.storyPacks, { persist: true });
  if (data.theme) theme.deserialize(data.theme, { persist: true });

  const active = moduleManager.getActive();
  if (active?.id) {
    moduleManager.mount(active.id);
  }
  return { migrated };
}

function formatTimeShort(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

// --- Sheet 4: UI Theme Skin, Visual FX/Audio & Modular Port Layout ---
function openThemeSheet() {
  openSheet('主题换肤与桌面布局', (body) => {
    const renderThemeView = () => {
      const state = theme.getState();
      const presets = theme.listPresets();
      const activePreset = theme.getActivePreset();
      const currentAccent = state.customAccent || activePreset.vars['--accent'] || '#14b8a6';
      const currentHighlight = state.customHighlight || activePreset.vars['--accent-hover'] || '#2dd4bf';
      const layout = theme.getPortLayout();

      body.innerHTML = `
        <div class="module-stack">
          <div class="lab-stack-sm">
            <div class="section-header-row" style="margin-bottom:0;">
              <strong style="font-size:13.5px;">1. 精选 UI 主题皮肤（实时生效）</strong>
              <span class="status-badge badge-ok" id="theme-active-badge">${escapeHtml(activePreset.name)}</span>
            </div>
            <div class="theme-preset-grid" id="theme-preset-grid">
              ${presets
                .map(
                  (p) => `
                <button
                  type="button"
                  class="theme-swatch-card ${p.id === state.presetId ? 'is-active' : ''}"
                  data-theme-preset="${escapeHtml(p.id)}"
                >
                  <div class="section-header-row" style="margin-bottom:0; width:100%;">
                    <strong style="font-size:13px;">${escapeHtml(p.name)}</strong>
                    <span class="muted-text" style="font-size:11px;">${p.mode === 'light' ? '浅色' : '深色'}</span>
                  </div>
                  <div class="theme-swatch-dots">
                    ${p.previewColors
                      .map((c) => `<span class="theme-swatch-dot" style="background:${escapeHtml(c)};"></span>`)
                      .join('')}
                  </div>
                </button>
              `
                )
                .join('')}
            </div>
          </div>

          <div class="lab-divider"></div>

          <div class="lab-stack-sm">
            <strong style="font-size:13.5px;">2. 手机端实时微调（色板 / 圆角 / 纹理 / 打字机）</strong>
            <div class="lab-kv-grid">
              <div class="form-group">
                <label class="form-label" for="theme-accent-color">主强调色</label>
                <input id="theme-accent-color" class="form-input" style="height:44px; padding:4px;" type="color" value="${escapeHtml(currentAccent)}">
              </div>
              <div class="form-group">
                <label class="form-label" for="theme-highlight-color">高亮辅助色</label>
                <input id="theme-highlight-color" class="form-input" style="height:44px; padding:4px;" type="color" value="${escapeHtml(currentHighlight)}">
              </div>
            </div>

            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label" for="theme-radius-range">卡片圆角半径</label>
                <span id="theme-radius-val" class="status-model">${state.cardRadius}px</span>
              </div>
              <input id="theme-radius-range" class="range-input" type="range" min="6" max="24" step="1" value="${state.cardRadius}">
            </div>

            <div class="form-group">
              <label class="form-label" for="theme-texture-select">背景纹理质感</label>
              <select id="theme-texture-select" class="form-select">
                <option value="grid" ${state.texture === 'grid' ? 'selected' : ''}>战术网格 (Grid)</option>
                <option value="dots" ${state.texture === 'dots' ? 'selected' : ''}>微点阵 (Dots)</option>
                <option value="waves" ${state.texture === 'waves' ? 'selected' : ''}>柔光海浪 (Waves)</option>
                <option value="none" ${state.texture === 'none' ? 'selected' : ''}>纯色极简 (None)</option>
              </select>
            </div>

            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label" for="theme-tw-speed">剧情打字机速度</label>
                <span id="theme-tw-val" class="status-model">${state.typewriterSpeed === 0 ? '瞬间显示' : `${state.typewriterSpeed}ms/字`}</span>
              </div>
              <input id="theme-tw-speed" class="range-input" type="range" min="0" max="50" step="2" value="${state.typewriterSpeed}">
            </div>
          </div>

          <div class="lab-divider"></div>

          <div class="lab-stack-sm">
            <strong style="font-size:13.5px;">3. 动效、触感震动与合成音效开关</strong>
            <label class="checkbox-row">
              <input id="chk-fx-enabled" type="checkbox" ${fxStage.isEnabled() ? 'checked' : ''}>
              <span>启用战斗红光闪烁、3D 骰子检定与屏幕震动演出</span>
            </label>
            <label class="checkbox-row">
              <input id="chk-fx-sound" type="checkbox" ${fxStage.isSoundEnabled() ? 'checked' : ''}>
              <span>启用轻量级 Web Audio 合成音效（可随时静音）</span>
            </label>
            <label class="checkbox-row">
              <input id="chk-fx-haptics" type="checkbox" ${fxStage.isHapticsEnabled() ? 'checked' : ''}>
              <span>启用手机端轻微触感震动反馈 (Vibration)</span>
            </label>
            <button type="button" id="btn-fx-test-sfx" class="btn-secondary uikit-touch-target">试听检定音效与 3D 骰子演出</button>
          </div>

          <div class="lab-divider"></div>

          <div class="lab-stack-sm">
            <strong style="font-size:13.5px;">4. 模块化港区主页卡片顺序与显隐</strong>
            <div class="lab-stack-sm" id="theme-port-layout-list">
              ${layout
                .map(
                  (item, idx) => `
                <div class="layout-order-row" data-layout-item="${escapeHtml(item.id)}">
                  <label style="display:flex; align-items:center; gap:8px; flex:1 1 auto; min-width:0; cursor:pointer;">
                    <input type="checkbox" data-layout-toggle="${escapeHtml(item.id)}" ${item.visible ? 'checked' : ''}>
                    <span style="font-size:13px;">${escapeHtml(item.label)}</span>
                  </label>
                  <div class="layout-order-actions">
                    <button type="button" class="layout-mini-btn" data-layout-up="${idx}" ${idx === 0 ? 'disabled' : ''}>上移</button>
                    <button type="button" class="layout-mini-btn" data-layout-down="${idx}" ${idx === layout.length - 1 ? 'disabled' : ''}>下移</button>
                  </div>
                </div>
              `
                )
                .join('')}
            </div>
          </div>

          <button type="button" id="btn-theme-reset" class="btn-secondary uikit-touch-target">恢复默认深海主题与布局</button>
        </div>
      `;

      body.querySelectorAll('[data-theme-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-theme-preset');
          theme.setPreset(id);
          fxStage.playSfx('click');
          showToast(`已切换主题皮肤：${theme.getActivePreset().name}`, 'ok');
          renderThemeView();
        });
      });

      body.querySelector('#theme-accent-color').addEventListener('input', (e) => {
        theme.updateCustomVars({ customAccent: e.target.value });
      });
      body.querySelector('#theme-highlight-color').addEventListener('input', (e) => {
        theme.updateCustomVars({ customHighlight: e.target.value });
      });

      const radiusInput = body.querySelector('#theme-radius-range');
      const radiusVal = body.querySelector('#theme-radius-val');
      radiusInput.addEventListener('input', () => {
        const val = Number(radiusInput.value);
        radiusVal.textContent = `${val}px`;
        theme.updateCustomVars({ cardRadius: val });
      });

      body.querySelector('#theme-texture-select').addEventListener('change', (e) => {
        theme.updateCustomVars({ texture: e.target.value });
      });

      const twInput = body.querySelector('#theme-tw-speed');
      const twVal = body.querySelector('#theme-tw-val');
      twInput.addEventListener('input', () => {
        const val = Number(twInput.value);
        twVal.textContent = val === 0 ? '瞬间显示' : `${val}ms/字`;
        theme.updateCustomVars({ typewriterSpeed: val });
      });

      body.querySelector('#chk-fx-enabled').addEventListener('change', (e) => {
        fxStage.setEnabled(e.target.checked);
      });
      body.querySelector('#chk-fx-sound').addEventListener('change', (e) => {
        fxStage.setSoundEnabled(e.target.checked);
      });
      body.querySelector('#chk-fx-haptics').addEventListener('change', (e) => {
        fxStage.setHapticsEnabled(e.target.checked);
      });
      body.querySelector('#btn-fx-test-sfx').addEventListener('click', () => {
        fxStage.playEffect('dice-roll', { naturalRoll: 18, total: 22, dc: 14, outcome: 'success', outcomeLabel: '成功' });
      });

      body.querySelectorAll('[data-layout-toggle]').forEach((chk) => {
        chk.addEventListener('change', () => {
          const id = chk.getAttribute('data-layout-toggle');
          const next = theme.getPortLayout().map((it) => (it.id === id ? { ...it, visible: chk.checked } : it));
          theme.updatePortLayout(next);
          renderThemeView();
        });
      });

      body.querySelectorAll('[data-layout-up]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = Number(btn.getAttribute('data-layout-up'));
          const next = theme.getPortLayout();
          if (i > 0) {
            [next[i - 1], next[i]] = [next[i], next[i - 1]];
            theme.updatePortLayout(next);
            renderThemeView();
          }
        });
      });

      body.querySelectorAll('[data-layout-down]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = Number(btn.getAttribute('data-layout-down'));
          const next = theme.getPortLayout();
          if (i < next.length - 1) {
            [next[i], next[i + 1]] = [next[i + 1], next[i]];
            theme.updatePortLayout(next);
            renderThemeView();
          }
        });
      });

      body.querySelector('#btn-theme-reset').addEventListener('click', () => {
        theme.resetTheme();
        showToast('已恢复默认深海战术终端主题与港区布局', 'ok');
        renderThemeView();
      });
    };

    renderThemeView();
  });
}

// --- Sheet 5: Multi-Slot Save Vault & Lossless Migration ---
function openSaveVaultSheet() {
  openSheet('存档保险箱（多槽位与无损迁移）', (body) => {
    let lastExportNote = '';

    const askConfirm = (title, message, confirmLabel, onConfirm) => {
      uiKit.openBottomSheet({
        title,
        subtitle: '防止误操作覆盖或丢失进度，请再次确认',
        content: `<p class="muted-text">${escapeHtml(message)}</p>`,
        actions: [
          { id: 'cancel', label: '取消', tone: 'secondary' },
          {
            id: 'ok',
            label: confirmLabel,
            tone: 'danger',
            onClick: async () => {
              await onConfirm();
              return true;
            },
          },
        ],
      });
    };

    const renderVaultView = async () => {
      body.innerHTML = '<p class="muted-text">正在读取多槽位存档保险箱...</p>';
      const [autoMeta, allSlots] = await Promise.all([saves.getAutoSaveMeta(), saves.listSlots()]);
      const primarySlots = allSlots.slice(0, VAULT_PRIMARY_SLOTS);

      body.innerHTML = `
        <div class="module-stack">
          <div class="vault-slot-card is-auto" id="vault-auto-card">
            <div class="section-header-row" style="margin-bottom:0;">
              <strong>自动存档快照（Auto-Save）</strong>
              <span class="status-badge ${autoMeta ? 'badge-ok' : 'badge-muted'}">${autoMeta ? '已保护' : '暂无记录'}</span>
            </div>
            <p class="muted-text" style="font-size:12px;">
              ${
                autoMeta
                  ? `保存时间：${escapeHtml(formatTimeShort(autoMeta.timestamp))} · 指挥官 Lv.${autoMeta.summary?.commanderLevel ?? 1} · 舰娘 ${autoMeta.summary?.characters ?? 0} 位 · Flags ${autoMeta.summary?.flagsCount ?? 0} 项`
                  : '每次关键操作（抽卡/改造/出征/剧情抉择/换肤）都会自动备份快照至此。'
              }
            </p>
            <button type="button" id="btn-vault-load-auto" class="btn-secondary uikit-touch-target" ${autoMeta ? '' : 'disabled'}>
              读取并恢复自动存档
            </button>
          </div>

          <strong style="font-size:13.5px;">独立手动存档槽位（3 个主槽位 · 支持自定义备注名）</strong>

          ${primarySlots
            .map((slot) => {
              const s = slot.meta?.summary || {};
              const noteVal = slot.meta?.name || `手动存档 #${slot.slotIndex}`;
              return `
              <div class="vault-slot-card" data-vault-slot="${slot.slotIndex}">
                <div class="section-header-row" style="margin-bottom:0;">
                  <strong>槽位 #${slot.slotIndex}</strong>
                  <span class="status-badge ${slot.empty ? 'badge-muted' : 'badge-ok'}" id="vault-slot-status-${slot.slotIndex}">
                    ${slot.empty ? '空闲槽位' : formatTimeShort(slot.meta.timestamp)}
                  </span>
                </div>
                <div class="form-group">
                  <label class="form-label" for="vault-note-${slot.slotIndex}">存档备注名</label>
                  <input id="vault-note-${slot.slotIndex}" class="form-input" type="text" value="${escapeHtml(noteVal)}" placeholder="输入存档备注名...">
                </div>
                <p class="muted-text" style="font-size:12px;" id="vault-slot-summary-${slot.slotIndex}">
                  ${
                    slot.empty
                      ? '尚未写入存档数据。点击下方「保存至此槽位」即可完整备份当前港区、剧情 Flags 与主题。'
                      : `指挥官：${escapeHtml(s.commanderName || '提督')} Lv.${s.commanderLevel ?? 1} · 秘书舰：${escapeHtml(s.flagshipName || '—')} · 剧情 Flags：${s.flagsCount ?? 0} · 主题：${escapeHtml(s.themePreset || '默认')}`
                  }
                </p>
                <div class="lab-btn-grid">
                  <button type="button" id="btn-vault-save-${slot.slotIndex}" class="btn-primary uikit-touch-target" data-vault-save="${slot.slotIndex}">
                    ${slot.empty ? `保存到槽位 #${slot.slotIndex}` : `覆盖槽位 #${slot.slotIndex}`}
                  </button>
                  <button type="button" id="btn-vault-load-${slot.slotIndex}" class="btn-secondary uikit-touch-target" data-vault-load="${slot.slotIndex}" ${slot.empty ? 'disabled' : ''}>
                    读取槽位 #${slot.slotIndex}
                  </button>
                </div>
                ${
                  !slot.empty
                    ? `<button type="button" id="btn-vault-del-${slot.slotIndex}" class="btn-danger uikit-touch-target" data-vault-del="${slot.slotIndex}">清空槽位 #${slot.slotIndex}</button>`
                    : ''
                }
              </div>
            `;
            })
            .join('')}

          <div class="lab-divider"></div>

          <div class="lab-stack-sm">
            <strong style="font-size:13.5px;">全量存档文件备份与跨版本无损迁移（v2）</strong>
            <p class="muted-text" style="font-size:12px;">
              导出的 JSON 包含自动存档、所有手动槽位与全局设置；导入旧版（v1）存档将自动无损补齐指挥官、剧情 Flags 与主题字段，不会丢失原有舰娘与装备。
            </p>
            ${
              lastExportNote
                ? `<div class="status-badge badge-ok" id="vault-export-status" style="white-space:normal;">${escapeHtml(lastExportNote)}</div>`
                : ''
            }
            <button type="button" id="btn-vault-export-all" class="btn-primary uikit-touch-target">导出全量存档 JSON 备份</button>
            <button type="button" id="btn-vault-import-all" class="btn-secondary uikit-touch-target">导入全量存档 JSON 恢复</button>
            <input type="file" id="input-vault-import-file" accept="application/json,.json" hidden>
          </div>
        </div>
      `;

      const loadAutoBtn = body.querySelector('#btn-vault-load-auto');
      if (loadAutoBtn) {
        loadAutoBtn.addEventListener('click', () => {
          askConfirm(
            '确认读取自动存档？',
            '将使用自动存档快照覆盖当前内存中的港区进度、剧情 Flags 与主题设置。',
            '确认读取恢复',
            async () => {
              const rec = await saves.loadAutoSave();
              if (!rec) return;
              const { migrated } = await restoreFullWorldSnapshot(rec.data);
              showToast(migrated ? '自动存档已无损迁移并恢复完成' : '自动存档已恢复完成', 'ok');
              closeSheet();
            }
          );
        });
      }

      body.querySelectorAll('[data-vault-save]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = Number(btn.getAttribute('data-vault-save'));
          const noteInput = body.querySelector(`#vault-note-${idx}`);
          const noteName = noteInput ? noteInput.value.trim() || `手动存档 #${idx}` : `手动存档 #${idx}`;
          const targetSlot = primarySlots.find((s) => s.slotIndex === idx);

          const doSave = async () => {
            await saves.saveSlot(idx, captureFullWorldSnapshot(), {
              name: noteName,
              summary: buildSaveSummary(`manual-slot-${idx}`),
            });
            fxStage.playSfx('success');
            showToast(`已保存到手动槽位 #${idx}（${noteName}）`, 'ok');
            await renderVaultView();
          };

          if (targetSlot && !targetSlot.empty) {
            askConfirm(
              `确认覆盖槽位 #${idx}？`,
              `槽位 #${idx} 已有存档「${targetSlot.meta?.name || ''}」，覆盖后原槽位记录将被替换为当前最新进度。`,
              `确认覆盖槽位 #${idx}`,
              doSave
            );
          } else {
            await doSave();
          }
        });
      });

      body.querySelectorAll('[data-vault-load]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-vault-load'));
          askConfirm(
            `确认读取手动槽位 #${idx}？`,
            '读取后将恢复该槽位保存时的所有舰娘、装备、建筑、剧情 Flags 与主题配置。',
            `确认读取槽位 #${idx}`,
            async () => {
              const rec = await saves.loadSlot(idx);
              if (!rec) return;
              const { migrated } = await restoreFullWorldSnapshot(rec.data);
              showToast(
                migrated
                  ? `槽位 #${idx} 已通过无损迁移恢复（${rec.meta?.name || ''}）`
                  : `已恢复槽位 #${idx}（${rec.meta?.name || ''}）`,
                'ok'
              );
              closeSheet();
            }
          );
        });
      });

      body.querySelectorAll('[data-vault-del]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-vault-del'));
          askConfirm(
            `确认清空槽位 #${idx}？`,
            '清空后该手动槽位记录将被移除，不会影响当前正在运行的港区进度。',
            '确认清空',
            async () => {
              await saves.deleteSlot(idx);
              showToast(`已清空槽位 #${idx}`, 'info');
              await renderVaultView();
            }
          );
        });
      });

      body.querySelector('#btn-vault-export-all').addEventListener('click', async () => {
        const bundle = await saves.exportAllToJSON();
        const jsonStr = JSON.stringify(bundle, null, 2);
        const filename = `kancolle-pwa-save-bundle-${new Date().toISOString().slice(0, 10)}.json`;
        triggerJsonDownload(filename, jsonStr);
        const slotCount = Object.keys(bundle.zones?.slots || {}).length;
        lastExportNote = `已导出 ${filename}（含 ${slotCount} 个手动槽位 · ${formatBytes(jsonStr.length)}）`;
        showToast(lastExportNote, 'ok');
        await renderVaultView();
      });

      const vaultFileInput = body.querySelector('#input-vault-import-file');
      body.querySelector('#btn-vault-import-all').addEventListener('click', () => vaultFileInput.click());
      vaultFileInput.addEventListener('change', async () => {
        const file = vaultFileInput.files?.[0];
        if (!file) return;
        const text = await file.text();
        vaultFileInput.value = '';
        askConfirm(
          '确认导入存档备份包？',
          '将合并导入该备份中的手动槽位与自动存档，并对旧版本数据结构自动执行无损迁移。',
          '确认导入并迁移',
          async () => {
            try {
              const res = await saves.importAllFromJSON(text, { replace: false });
              showToast(`存档包导入成功（手动槽位 ${res.importedSlots} 个）`, 'ok');
              await renderVaultView();
            } catch (err) {
              showToast(err instanceof Error ? err.message : '导入失败', 'error');
            }
          }
        );
      });
    };

    renderVaultView();
  });
}

els.btnModules.addEventListener('click', openModulesSheet);
els.btnTheme.addEventListener('click', openThemeSheet);
els.btnVault.addEventListener('click', openSaveVaultSheet);
els.btnApi.addEventListener('click', openApiSheet);
els.btnData.addEventListener('click', openDataSheet);

// ------------------------------------------------------------
// 6. Hydrate Persisted Core Data, Bind Auto-Save & Boot Home
// ------------------------------------------------------------
async function bootApplication() {
  try {
    await Promise.all([commander.init(), personalityPool.init()]);
    await Promise.all([inventory.init(), resources.init(), logs.init()]);
    const rosterRes = await hydrateCharacterRoster({
      storage,
      entities,
      inventory,
      statRules,
      commander,
      personalityPool,
    });
    await Promise.all([
      expeditions.init(),
      buildings.init(),
      interaction.init(),
      contentManager.init(),
      storyPacks.init(),
    ]);

    // On brand-new fresh saves, automatically load the full 8-ship / 16-gear / tiered-enemy / story-pack starter bundle.
    // Existing saves remain untouched and can non-destructively merge via Compendium Studio's one-tap button.
    if (rosterRes?.seeded) {
      await contentManager.mergeStarterContentBundle({
        personalityPool,
        storyPacks,
        statRules,
        persistRosterFn: () => persistCharacterRoster({ storage, entities }),
        silent: true,
      });
    }

    await formation.init();
    await Promise.all([
      hydrateActionConsole({ storage, rules }),
      hydrateSortieConsole({ storage, routeGenerator, combat }),
    ]);
  } catch (err) {
    console.error('[App] Persistence hydration failed:', err);
  }

  logs.attachBusListeners();
  fxStage.attachBusListeners();

  // Auto-persist character roster whenever any shipgirl gains EXP, levels up, or rerolls personality
  const syncRosterOnProgression = () => {
    persistCharacterRoster({ storage, entities }).catch(() => {});
  };
  bus.on('character:exp-gained', syncRosterOnProgression);
  bus.on('character:leveled-up', syncRosterOnProgression);
  bus.on('personality:rolled', syncRosterOnProgression);

  // Trigger Auto-Save snapshot whenever core engines, story packs, flags, theme, or resources mutate
  saves.bindAutoSaveEvents(
    [
      'commander:updated',
      'formation:changed',
      'expedition:dispatched',
      'expedition:claimed',
      'expedition:recalled',
      'buildings:updated',
      'interaction:talked',
      'interaction:gifted',
      'interaction:oathed',
      'content:updated',
      'content:mod-imported',
      'story:flag-changed',
      'story:packs-changed',
      'story:choice-resolved',
      'personality:pool-updated',
      'personality:rolled',
      'theme:changed',
      'theme:layout-changed',
      'inventory:equipped',
      'inventory:unequipped',
      'inventory:consumed',
      'inventory:enhanced',
      'inventory:cleaned',
      'inventory:slot-added',
      'inventory:slot-renamed',
      'inventory:slot-removed',
      'character:saved',
      'character:deleted',
      'character:exp-gained',
      'character:leveled-up',
      'resource:changed',
      'stat-rules:changed',
      'action:settled',
      'action:events-changed',
      'port:serviced',
      'sortie:launched',
      'sortie:node-resolved',
      'sortie:returned',
      'sortie:routes-changed',
      'combat:turn-resolved',
      'route:custom-saved',
    ],
    (eventName) => ({
      name: '系统自动存档快照',
      data: captureFullWorldSnapshot(),
      summary: buildSaveSummary(eventName),
    }),
    { debounceMs: 180 }
  );

  // Boot strictly into Port Hub by default (unless user explicitly pinned a custom default module)
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
  personalityPool,
  dialogueEngine,
  fxStage,
  routeGenerator,
  combat,
  commander,
  formation,
  expeditions,
  buildings,
  interaction,
  contentManager,
  storyPacks,
  theme,
  uiKit,
  modules: moduleManager,
  captureFullWorldSnapshot,
  restoreFullWorldSnapshot,
};
