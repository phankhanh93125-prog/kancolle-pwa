import { EventBus } from './core/event-bus.js';
import { StorageManager } from './core/storage.js';
import { ApiGateway, PROVIDER_PRESETS } from './core/api.js';
import { ModuleManager } from './core/module-manager.js';
import {
  SaveManager,
  VAULT_PRIMARY_SLOTS,
  buildNewGameSeedPlan,
  migrateSavePayload,
  triggerJsonDownload,
} from './core/save-manager.js';
import { CalcEngine } from './core/calc-engine.js';
import { EntitySystem } from './core/entity-system.js';
import { RuleEngine } from './core/rule-engine.js';
import { StateMachine, TurnStepper } from './core/state-machine.js';
import { PromptPipeline } from './core/prompt-pipeline.js';
import { AssetManager } from './core/asset-manager.js';
import {
  ITEM_RARITIES,
  RESOURCE_DROP_MULTIPLIER_PRESETS,
  StatRulesEngine,
} from './core/stat-rules.js';
import { ITEM_CATEGORIES, InventorySystem, STARTER_ITEMS } from './core/inventory-system.js';
import { DEFAULT_RESOURCES, ResourceManager } from './core/resource-manager.js';
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
import { StoryEngine } from './core/story-engine.js';
import { ThemeManager } from './core/theme-manager.js';
import { PersonalityPool } from './core/personality-pool.js';
import { DialogueEngine } from './core/dialogue-engine.js';
import { createUIKit, showToast } from './core/ui-kit.js';
import { REGISTERED_MODULES } from './modules/index.js';
import {
  hydrateCharacterRoster,
  persistCharacterRoster,
  resetCharacterConsoleState,
} from './modules/character-console.js';
import { resetWorkshopState } from './modules/supply-workshop.js';
import { resetPortHubState } from './modules/port-hub.js';
import { openFacilitiesSection, resetFacilitiesHubState } from './modules/facilities-hub.js';
import { openCustomWorkshopModal } from './modules/custom-workshop.js';
import { openNewJourneyModal } from './modules/title-screen.js';
import { hydrateActionConsole } from './modules/action-console.js';
import { clearActiveSortieState, hydrateSortieConsole } from './modules/sortie-console.js';

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

const storyEngine = new StoryEngine({
  storage,
  entities,
  inventory,
  commander,
  interaction,
  contentManager,
  dialogueEngine,
  narrative,
  logs,
  bus,
});
interaction.setStoryEngine(storyEngine);
buildings.setStoryEngine(storyEngine);
expeditions.setStoryEngine(storyEngine);
storyPacks.setStoryEngine(storyEngine);

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
expeditions.setRouteGenerator(routeGenerator);
const uiKit = createUIKit();

bus.on('medal:unlocked', (ev) => {
  if (ev?.medal) {
    uiKit.showToast(`★ 点亮荣誉勋章「${ev.medal.title}」· 指挥官运气永久 +${ev.luckBonus}！`, 'ok', { duration: 2800 });
  }
});

const els = {
  activeModuleName: document.getElementById('active-module-name'),
  topCmdBtn: document.getElementById('btn-top-commander'),
  topCmdAvatar: document.getElementById('top-cmd-avatar'),
  topCmdFallback: document.getElementById('top-cmd-fallback'),
  topCmdSummary: document.getElementById('top-cmd-summary'),
  topResourceStrip: document.getElementById('top-resource-strip'),
  moduleNavStrip: document.getElementById('module-nav-strip'),
  bottomTabBar: document.getElementById('bottom-tab-bar'),
  stage: document.getElementById('app-stage'),
  quickActionsSlot: document.getElementById('quick-actions-slot'),
  inputForm: document.getElementById('universal-input-form'),
  inputField: document.getElementById('universal-input'),
  sendBtn: document.getElementById('btn-universal-send'),
  btnModules: document.getElementById('btn-open-modules'),
  btnCustomWorkshop: document.getElementById('btn-open-custom-workshop'),
  btnTheme: document.getElementById('btn-open-theme'),
  btnVault: document.getElementById('btn-open-vault'),
  btnReturnTitle: document.getElementById('btn-return-title'),
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
let swipeLockedByModule = false;
let sortieNavLocked = false;
let currentStageMode = 'theatre';

const TOP_RESOURCE_META = [
  { key: 'fuel', label: '油', cls: 'res-fuel' },
  { key: 'ammo', label: '弹', cls: 'res-ammo' },
  { key: 'steel', label: '钢', cls: 'res-steel' },
  { key: 'bauxite', label: '铝', cls: 'res-bauxite' },
  { key: 'silver', label: '银', cls: 'res-silver' },
  { key: 'gold', label: '金', cls: 'res-gold' },
];

let topCmdAvatarAssetCache = { assetId: '__init__', url: '' };

async function renderTopStatusBar() {
  if (els.topCmdSummary && commander) {
    const p = commander.getProfile();
    els.topCmdSummary.textContent = `${p.name || '指挥官'} Lv.${p.level || 1}`;
    const assetId = p.avatarAssetId || null;
    if (els.topCmdAvatar && els.topCmdFallback) {
      if (assetId) {
        if (topCmdAvatarAssetCache.assetId !== assetId) {
          try {
            const res = await assets.getAssetUrl(assetId, {
              fallbackSeed: 'commander-profile',
              fallbackLabel: (p.name || 'CMD').slice(0, 4),
            });
            topCmdAvatarAssetCache = { assetId, url: res.url };
          } catch {
            topCmdAvatarAssetCache = { assetId, url: '' };
          }
        }
        if (topCmdAvatarAssetCache.url) {
          els.topCmdAvatar.src = topCmdAvatarAssetCache.url;
          els.topCmdAvatar.hidden = false;
          els.topCmdFallback.hidden = true;
        }
      } else {
        els.topCmdAvatar.hidden = true;
        els.topCmdFallback.hidden = false;
      }
    }
  }

  if (els.topResourceStrip && resources) {
    els.topResourceStrip.innerHTML = TOP_RESOURCE_META.map((item) => {
      const r = resources.get(item.key);
      const val = Math.round(Number(r?.amount ?? 0));
      return `<span class="top-res-chip ${item.cls}" data-top-res="${item.key}" title="${escapeHtml(r?.name || item.label)}">
        <span class="top-res-k">${item.label}</span>
        <strong class="top-res-v">${val}</strong>
      </span>`;
    }).join('');
  }
}

function resolveDefaultStageMode(moduleId) {
  if (moduleId === 'port-hub') return 'theatre';
  if (moduleId === 'sortie-console') return combat?.isInBattleScreen?.() ? 'battle' : 'chart';
  if (moduleId === 'title-screen') return 'title';
  return 'facility';
}

function autoResizeInput() {
  const el = els.inputField;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

function scrollChatViewportToBottom() {
  const vp = document.getElementById('chat-bubble-viewport');
  if (vp) {
    vp.scrollTop = vp.scrollHeight;
  }
}

const ui = {
  showToast,

  setSwipeLocked(locked) {
    swipeLockedByModule = Boolean(locked);
    document.body.dataset.swipeLocked = swipeLockedByModule || sortieNavLocked ? 'true' : 'false';
  },

  isSwipeLocked() {
    return swipeLockedByModule || sortieNavLocked;
  },

  /**
   * Gesture Conflict Lock #3:
   * During Sortie Stage 2 (Custom Map Workshop) and Stage 3 (Navigation & Combat),
   * lock global horizontal swipe AND bottom 5-tab bar clicks to prevent accidental exit.
   */
  setSortieNavLocked(locked) {
    sortieNavLocked = Boolean(locked);
    document.body.dataset.sortieNavLocked = sortieNavLocked ? 'true' : 'false';
    document.body.dataset.swipeLocked = swipeLockedByModule || sortieNavLocked ? 'true' : 'false';
    if (els.bottomTabBar) {
      els.bottomTabBar.classList.toggle('is-nav-locked', sortieNavLocked);
    }
  },

  isSortieNavLocked() {
    return sortieNavLocked;
  },

  setStageMode(mode = 'theatre') {
    const normalized = ['theatre', 'chart', 'battle', 'facility', 'title'].includes(mode)
      ? mode
      : 'facility';
    currentStageMode = normalized;
    if (els.stage) {
      els.stage.dataset.stageMode = normalized;
    }
    document.body.dataset.stageMode = normalized;
  },

  getStageMode() {
    return currentStageMode;
  },

  setImmersiveBattle(active) {
    const flag = Boolean(active);
    document.body.classList.toggle('is-immersive-battle', flag);
    ui.setSwipeLocked(flag);
    if (flag) {
      ui.setSortieNavLocked(true);
      ui.setStageMode('battle');
    } else if (currentStageMode === 'battle') {
      ui.setStageMode('chart');
    }
    if (els.moduleNavStrip) {
      els.moduleNavStrip.hidden = true;
    }
  },

  setTitleScreenMode(active) {
    const flag = Boolean(active);
    document.body.classList.toggle('is-title-screen', flag);
    ui.setSwipeLocked(flag);
    if (flag) {
      ui.setSortieNavLocked(false);
      ui.setStageMode('title');
    }
    if (els.moduleNavStrip) {
      els.moduleNavStrip.hidden = true;
    }
  },

  setPlaceholder(text) {
    if (els.inputField) {
      els.inputField.placeholder = text || '和秘书舰说点什么...';
    }
  },

  setInputBusy(busy) {
    inputBusy = Boolean(busy);
    if (els.sendBtn) {
      els.sendBtn.disabled = inputBusy;
      els.sendBtn.textContent = inputBusy ? '处理中' : '发送';
    }
  },

  setInputHandler(fn) {
    activeInputHandler = typeof fn === 'function' ? fn : null;
  },

  setQuickActions(actions = []) {
    if (!els.quickActionsSlot) return;
    els.quickActionsSlot.innerHTML = '';
    els.quickActionsSlot.hidden = true;
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
    ui.setImmersiveBattle(false);
    ui.setTitleScreenMode(false);
    ui.setSortieNavLocked(false);
    ui.setPlaceholder('和秘书舰说点什么...');
    if (els.quickActionsSlot) {
      els.quickActionsSlot.innerHTML = '';
      els.quickActionsSlot.hidden = true;
    }
  },
};

// ------------------------------------------------------------
// 3. Universal Input Handling (Visible ONLY on Tab 1 「互动」)
// ------------------------------------------------------------
async function submitUniversalInput() {
  if (inputBusy || !els.inputField) return;
  const text = els.inputField.value.trim();
  if (!text) return;

  els.inputField.value = '';
  autoResizeInput();

  bus.emit('input:submit', { text });
  if (activeInputHandler) {
    await activeInputHandler(text);
    setTimeout(scrollChatViewportToBottom, 40);
  } else {
    showToast('当前页面未绑定聊天输入');
  }
}

if (els.inputForm) {
  els.inputForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitUniversalInput();
  });
}

if (els.inputField) {
  els.inputField.addEventListener('input', autoResizeInput);
  // Gesture Conflict Lock #5: Soft keyboard focus auto-scrolls Tab 1 chat window to latest message
  els.inputField.addEventListener('focus', () => {
    setTimeout(scrollChatViewportToBottom, 80);
    setTimeout(scrollChatViewportToBottom, 260);
  });
  els.inputField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitUniversalInput();
    }
  });
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (document.body.dataset.activeModule === 'port-hub') {
      setTimeout(scrollChatViewportToBottom, 60);
    }
  });
}

// ------------------------------------------------------------
// 4. Module Manager Initialization
// ------------------------------------------------------------
const appActions = {
  startNewJourney: null,
  openSaveVault: () => openSaveVaultSheet(),
  openSettings: () => openThemeSheet(),
  returnToTitle: () => moduleManager.mount('title-screen'),
  openFacilitiesShop: (shelfId = 'outfits') => {
    openFacilitiesSection('shop', shelfId);
    if (moduleManager.getActive()?.id !== 'port-facilities-hub') {
      moduleManager.mount('port-facilities-hub', { transition: 'left' });
    }
  },
  launchStoryPackInTheatre: (packId, nodeId = null) => {
    const sess = storyPacks.setActiveTheatreSession(packId, nodeId);
    if (!sess) return null;
    if (moduleManager.getActive()?.id !== 'port-hub') {
      moduleManager.mount('port-hub', { transition: 'right' });
    }
    return sess;
  },
};

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
    storyEngine,
    theme,
    uiKit,
    appActions,
  },
});

function isAnyModalOpen() {
  if (els.sheetBackdrop && !els.sheetBackdrop.hidden) return true;
  const uiBackdrops = document.querySelectorAll('.uikit-sheet-backdrop, .uikit-tactical-backdrop');
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

const SWIPE_LOCKED_MODULE_IDS = new Set([
  'title-screen',
  'port-dormitory',
  'port-dockyard',
  'port-formation',
  'port-expedition',
]);

function isSwipeBlockedNow() {
  // Gesture Conflict Lock #4: Any open modal/drawer freezes background horizontal swipe
  if (isAnyModalOpen()) return true;
  // Gesture Conflict Lock #3: Sortie Stage 2/3 or explicit module swipe lock
  if (sortieNavLocked || swipeLockedByModule) return true;
  if (combat && (combat.isActive() || combat.isInBattleScreen())) return true;
  if (document.body.classList.contains('is-immersive-battle')) return true;
  const active = moduleManager.getActive();
  if (!active) return false;
  if (active.isSubpage || active.lockSwipe || SWIPE_LOCKED_MODULE_IDS.has(active.id)) {
    return true;
  }
  return false;
}

const BOTTOM_NAV_ORDER = [
  'port-hub',
  'character-console',
  'sortie-console',
  'supply-workshop',
  'port-facilities-hub',
];

function syncBottomTabBar(activeId = null) {
  if (!els.bottomTabBar) return;
  const curId = activeId || moduleManager.getActive()?.id || 'port-hub';
  const mappedId =
    curId === 'compendium-studio' || curId === 'port-dormitory' || curId === 'port-expedition'
      ? 'port-facilities-hub'
      : curId === 'port-dockyard'
      ? 'supply-workshop'
      : curId === 'port-formation'
      ? 'sortie-console'
      : curId;
  els.bottomTabBar.querySelectorAll('[data-bottom-nav]').forEach((btn) => {
    const targetId = btn.getAttribute('data-bottom-nav');
    const isAct = targetId === mappedId;
    btn.classList.toggle('is-active', isAct);
    if (isAct) {
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.removeAttribute('aria-current');
    }
  });
}

function attachBottomTabNavigation() {
  if (!els.bottomTabBar) return;
  els.bottomTabBar.querySelectorAll('[data-bottom-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-bottom-nav');
      if (!targetId || !moduleManager.has(targetId)) return;
      const curId = moduleManager.getActive()?.id;
      if (targetId === curId) return;
      // Gesture Conflict Lock #3: Block bottom nav switching during Sortie Stage 2/3
      if (sortieNavLocked) {
        showToast('出征配置或航行战斗中已锁定切页，请先返回出征准备或安全撤退', 'warn');
        return;
      }
      const curIdx = BOTTOM_NAV_ORDER.indexOf(curId);
      const nextIdx = BOTTOM_NAV_ORDER.indexOf(targetId);
      const dir = curIdx >= 0 && nextIdx >= 0 ? (nextIdx > curIdx ? 'left' : 'right') : null;
      moduleManager.mount(targetId, { transition: dir });
    });
  });
}

function renderModuleNavStrip(activeId = null) {
  if (els.moduleNavStrip) {
    els.moduleNavStrip.hidden = true;
  }
  syncBottomTabBar(activeId);
}

/**
 * Gesture Conflict Lock #1:
 * Range sliders, horizontal chip strips, 3×4 formation/tactical boards, modals/drawers,
 * and elements marked `data-no-swipe="true"` MUST block global horizontal swipe.
 */
function hasHorizontallyScrollableAncestor(target, boundary) {
  let node = target instanceof Element ? target : null;
  while (node && node !== boundary && node !== document.body) {
    if (node.dataset?.noSwipe === 'true') return true;
    if (
      node.classList?.contains('tactical-grid-3x4') ||
      node.classList?.contains('tac-radar-board') ||
      node.classList?.contains('wh-filter-strip') ||
      node.classList?.contains('chip-row') ||
      node.classList?.contains('fac-shelf-pills') ||
      node.classList?.contains('fac-top-segmented') ||
      node.classList?.contains('map-workshop-panel') ||
      node.classList?.contains('uikit-tactical-modal') ||
      node.classList?.contains('uikit-sheet')
    ) {
      return true;
    }
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
      if (isSwipeBlockedNow()) {
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
        lockedVertical: false,
        cancelled: false,
      };
    },
    { passive: true }
  );

  els.stage.addEventListener(
    'touchmove',
    (e) => {
      if (!touchState || touchState.cancelled) return;
      if (isSwipeBlockedNow() || !e.touches || e.touches.length !== 1) {
        touchState.cancelled = true;
        return;
      }
      const t = e.touches[0];
      touchState.lastX = t.clientX;
      touchState.lastY = t.clientY;
      // Gesture Conflict Lock #2: Lock swipe as soon as vertical scrolling intent is detected
      const curDx = Math.abs(t.clientX - touchState.startX);
      const curDy = Math.abs(t.clientY - touchState.startY);
      if (curDy > 10 && curDy > curDx) {
        touchState.lockedVertical = true;
      }
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
      if (!touchState || touchState.cancelled || touchState.lockedVertical || isSwipeBlockedNow()) {
        touchState = null;
        return;
      }
      const changed = e.changedTouches && e.changedTouches[0];
      const endX = changed ? changed.clientX : touchState.lastX;
      const endY = changed ? changed.clientY : touchState.lastY;
      const dx = endX - touchState.startX;
      const dy = endY - touchState.startY;
      touchState = null;

      // Gesture Conflict Lock #2: Strict horizontal dominance (`|dx| > 60 && |dx| > |dy| * 1.8`)
      if (Math.abs(dx) <= 60 || Math.abs(dx) <= Math.abs(dy) * 1.8) return;

      // Strictly align horizontal swipe to the 5 bottom navigation tabs
      const curId = moduleManager.getActive()?.id;
      const curIdx = BOTTOM_NAV_ORDER.indexOf(curId);
      if (curIdx < 0) return;

      if (dx < -60 && curIdx < BOTTOM_NAV_ORDER.length - 1) {
        const nextId = BOTTOM_NAV_ORDER[curIdx + 1];
        if (moduleManager.has(nextId)) {
          moduleManager.mount(nextId, { transition: 'left' });
        }
      } else if (dx > 60 && curIdx > 0) {
        const prevId = BOTTOM_NAV_ORDER[curIdx - 1];
        if (moduleManager.has(prevId)) {
          moduleManager.mount(prevId, { transition: 'right' });
        }
      }
    },
    { passive: true }
  );
}

bus.on('module:changed', (mod) => {
  if (els.activeModuleName) {
    els.activeModuleName.textContent = mod.name;
  }
  document.body.dataset.activeModule = mod.id;
  document.body.dataset.swipeLocked = isSwipeBlockedNow() ? 'true' : 'false';
  ui.setStageMode(resolveDefaultStageMode(mod.id));
  renderModuleNavStrip(mod.id);
  renderTopStatusBar();
});

moduleManager.registerAll(REGISTERED_MODULES);
attachBottomTabNavigation();
renderModuleNavStrip();
attachStageSwipeNavigation();

// ------------------------------------------------------------
// 5. Bottom Sheet Modal Controller
// ------------------------------------------------------------
function openSheet(title, renderFn) {
  if (!els.sheetBackdrop || !els.sheetTitle || !els.sheetBody) return;
  els.sheetTitle.textContent = title;
  els.sheetBody.innerHTML = '';
  renderFn(els.sheetBody);
  els.sheetBackdrop.hidden = false;
}

function closeSheet() {
  if (!els.sheetBackdrop || !els.sheetBody) return;
  els.sheetBackdrop.hidden = true;
  els.sheetBody.innerHTML = '';
}

if (els.btnSheetClose) {
  els.btnSheetClose.addEventListener('click', closeSheet);
}
if (els.sheetBackdrop) {
  els.sheetBackdrop.addEventListener('click', (e) => {
    if (e.target === els.sheetBackdrop) closeSheet();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.sheetBackdrop && !els.sheetBackdrop.hidden) {
    closeSheet();
  }
});

// --- Sheet 1: System Tools & Module Management ---
function openModulesSheet() {
  openSheet('系统工具与模块管理', (body) => {
    const modules = moduleManager.list();

    body.innerHTML = `
      <div class="lab-btn-grid" style="margin-bottom:10px;">
        <button type="button" id="btn-sys-open-api" class="btn-secondary uikit-touch-target">多模型 API 设置</button>
        <button type="button" id="btn-sys-open-data" class="btn-secondary uikit-touch-target">存储与数据管理</button>
      </div>
      <p class="muted-text">点击任意已注册模块即可实时切换挂载到中央主舞台，每个模块拥有独立的数据命名空间（支持 localStorage 与 IndexedDB 双层存储）。</p>
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

    body.querySelector('#btn-sys-open-api')?.addEventListener('click', () => openApiSheet());
    body.querySelector('#btn-sys-open-data')?.addEventListener('click', () => openDataSheet());

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
        isWorldTransitioning = true;
        saves.cancelPendingAutoSaves();
        buildings.setMedalAutoCheckPaused(true);
        try {
          await clearActiveSortieState({ storage, combat });
          const removed = await storage.resetHybridAll();
          await resetAllInMemoryState({ keepCustomData: false, preserveCustomBuildings: [] });
          confirmResetArmed = false;
          showToast(`已清空全部内存、Local ${removed.removedLocal} 项与 IDB ${removed.removedIdb} 项`, 'ok');
          closeSheet();
          await renderTopStatusBar();
          moduleManager.mount('title-screen');
        } finally {
          buildings.setMedalAutoCheckPaused(false);
          isWorldTransitioning = false;
        }
      });
    };

    renderDataView();
  });
}

// ------------------------------------------------------------
// Full-World Snapshot Capture, Complete Reset & Isolated Slot Restore
// ------------------------------------------------------------
let isWorldTransitioning = false;

const RUNTIME_IDB_NAMESPACES = Object.freeze([
  'core-characters',
  'core-inventory',
  'core-formation',
  'core-port-buildings',
  'core-expeditions',
  'core-interaction',
  'core-story-engine',
  'core-commander',
  'core-resources',
  'core-logs',
  'core-sortie',
  'save-auto',
]);

/**
 * Explicitly wipe all runtime game state from IndexedDB & localStorage before a New Game
 * or Save-Slot Restore so ZERO old ships, items, formations, dockyard queues, sea control,
 * chat histories, or medals can leak from IndexedDB. Never deletes manual save slots (`save-slots`).
 */
async function clearAllRuntimePersistence({ keepCustomData = true, preserveImportedLibrary = true } = {}) {
  saves.cancelPendingAutoSaves();
  await clearActiveSortieState({ storage, combat });

  const idbClears = RUNTIME_IDB_NAMESPACES.map((ns) => storage.namespace(ns).clearLarge());
  // Reset 1★~5★ & legacy sea-control progress without wiping user's saved Map Workshop blueprints
  idbClears.push(storage.namespace('core-sortie-routes').removeLarge('sea-control-v1'));
  idbClears.push(storage.namespace('core-sortie-routes').removeLarge('sea-control-v2'));
  if (!keepCustomData && !preserveImportedLibrary) {
    idbClears.push(storage.namespace('core-sortie-routes').clearLarge());
    idbClears.push(storage.namespace('core-content-studio').clearLarge());
    idbClears.push(storage.namespace('core-story-packs').clearLarge());
    idbClears.push(storage.namespace('core-personality-pool').clearLarge());
  }
  await Promise.all(idbClears);

  // Also clear runtime localStorage pointers (activeCharacterId, etc.)
  storage.namespace('core-characters').clear();
  if (!keepCustomData) {
    storage.namespace('core-theme').clear();
  }
}

/**
 * Reset every in-memory core engine & UI module cache to a clean empty baseline
 * without triggering intermediate IndexedDB writes.
 */
async function resetAllInMemoryState({ keepCustomData = true, preserveCustomBuildings = [] } = {}) {
  const now = Date.now();
  resetCharacterConsoleState(storage);
  resetWorkshopState();
  resetPortHubState();
  resetFacilitiesHubState();
  topCmdAvatarAssetCache = { assetId: '__refresh__', url: '' };

  if (storyPacks && typeof storyPacks.clearActiveTheatreSession === 'function') {
    storyPacks.clearActiveTheatreSession();
  }
  if (storyEngine && typeof storyEngine.resetAll === 'function') {
    storyEngine.resetAll({ persist: false });
  }
  if (logs && typeof logs.clear === 'function') {
    await logs.clear();
  }

  entities.clear();
  inventory.deserialize(
    {
      version: 6,
      customSlotsByCharacter: {},
      equipped: {},
      items: [],
      salvageParts: 0,
      retrofitCores: 0,
    },
    { persist: false }
  );
  formation.deserialize(
    {
      version: 2,
      memberIds: [],
      gridSlots: Array(12).fill(null),
      formationId: 'line_ahead',
      customFormationMods: {},
    },
    { persist: false }
  );
  expeditions.deserialize({ version: 1, completedCount: 0, activeRuns: [] }, { persist: false });
  interaction.deserialize(
    { version: 1, secretaryId: null, oaths: {}, lastInteraction: null, interactionHistory: [] },
    { persist: false }
  );
  buildings.deserialize(
    {
      version: 3,
      dormitory: { level: 1, capacity: 3, maxCapacity: 12, residents: [], lastSettledAt: now },
      dockyard: { level: 1, capacity: 2, maxCapacity: 6, queue: [], completedRepairs: 0, constructedCount: 0 },
      warehouse: { level: 1, maxLevel: 10 },
      customBuildings: keepCustomData ? preserveCustomBuildings : [],
      medals: { unlockedIds: [], unlockedAt: {} },
      updatedAt: now,
    },
    { persist: false }
  );
  routeGenerator.deserializeSeaControl({ version: 2, zones: {} }, { persist: false });
}

function captureFullWorldSnapshot() {
  return {
    commander: commander.serialize(),
    formation: formation.serialize(),
    expeditions: expeditions.serialize(),
    buildings: buildings.serialize(),
    interaction: interaction.serialize(),
    storyEngine: storyEngine.serialize(),
    contentManager: contentManager.serialize(),
    storyPacks: storyPacks.serialize(),
    personalityPool: personalityPool.serialize(),
    seaControl: routeGenerator.serializeSeaControl(),
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
  const seaOv = typeof routeGenerator.getSeaControlOverview === 'function' ? routeGenerator.getSeaControlOverview() : null;
  const seaSummary = seaOv
    ? seaOv.zones
        .filter((z) => z.unlocked || z.progress > 0)
        .slice(0, 3)
        .map((z) => `${z.code} ${z.progress}%`)
        .join(' / ')
    : '1★ 0%';
  const medalsOv = typeof buildings.getMedalsOverview === 'function' ? buildings.getMedalsOverview() : null;
  return {
    trigger,
    commanderName: cmd.name,
    commanderLevel: cmd.level,
    flagshipName: sec ? sec.name : '未指派',
    fleetCount: formation.getMemberIds().length,
    customBuildings: buildings.listCustomBuildings().length,
    characters: entities.list({ kind: 'character' }).length,
    items: inventory.listItems().length,
    salvageParts: typeof inventory.getSalvageParts === 'function' ? inventory.getSalvageParts() : 0,
    retrofitCores: typeof inventory.getRetrofitCores === 'function' ? inventory.getRetrofitCores() : 0,
    medalsUnlocked: medalsOv ? medalsOv.unlockedCount : 0,
    seaSummary,
    flagsCount,
    themePreset: theme.getActivePreset().name,
  };
}

async function persistAllWorldSubsystems(activeCharacterId = null) {
  await Promise.all([
    commander.persist(),
    resources.persist(),
    inventory.persist(),
    formation.persist(),
    buildings.persist(),
    expeditions.persist(),
    interaction.persist(),
    storyEngine.persist(),
    routeGenerator.persistSeaControl(),
    contentManager.persist(),
    storyPacks.persist(),
    personalityPool.persist(),
    persistCharacterRoster({ storage, entities, activeCharacterId }),
  ]);
}

async function restoreFullWorldSnapshot(rawData, { syncAutoSave = true, sourceName = null } = {}) {
  const { data, migrated } = migrateSavePayload(rawData);
  isWorldTransitioning = true;
  saves.cancelPendingAutoSaves();
  buildings.setMedalAutoCheckPaused(true);

  try {
    // 1. Wipe all live IndexedDB runtime records & in-memory state first (never touches manual save-slots!)
    await clearAllRuntimePersistence({ keepCustomData: false, preserveImportedLibrary: false });
    await resetAllInMemoryState({ keepCustomData: false, preserveCustomBuildings: [] });

    // 2. Restore EVERY subsystem unconditionally in strict dependency order with { persist: false }
    if (data.statRules) statRules.updateConfig(data.statRules);
    personalityPool.deserialize(data.personalityPool || { primary: [], secondary: [] }, { persist: false });
    commander.deserialize(data.commander, { persist: false });

    entities.deserialize(data.entities);
    for (const ch of entities.list({ kind: 'character' })) {
      if (typeof statRules.ensureShipProgression === 'function') {
        statRules.ensureShipProgression(ch);
      }
      personalityPool.ensurePersonalityOnEntity(ch);
    }

    inventory.deserialize(data.inventory, { persist: false });
    if (data.resources) {
      resources.deserialize(data.resources, { persist: false });
    } else {
      const now = Date.now();
      resources.deserialize(
        {
          version: 3,
          lastRecoveryAt: now,
          dropMultiplier: 1.0,
          resources: DEFAULT_RESOURCES.map((def) => ({ ...def, updatedAt: now })),
        },
        { persist: false }
      );
    }

    buildings.deserialize(data.buildings, { persist: false });
    expeditions.deserialize(data.expeditions, { persist: false });
    interaction.deserialize(data.interaction, { persist: false });
    storyEngine.deserialize(data.storyEngine, { persist: false });
    formation.deserialize(data.formation, { persist: false });
    routeGenerator.deserializeSeaControl(data.seaControl, { persist: false });
    contentManager.deserialize(data.contentManager, { persist: false });
    storyPacks.deserialize(data.storyPacks, { persist: false });
    storyPacks.clearActiveTheatreSession();
    theme.deserialize(data.theme, { persist: false });

    // Ensure secretary / activeCharacterId points to a valid ship in the restored slot
    const restoredChars = entities.list({ kind: 'character' });
    const restoredIds = new Set(restoredChars.map((c) => c.id));
    const preferredActiveId =
      (data.interaction?.secretaryId && restoredIds.has(data.interaction.secretaryId)
        ? data.interaction.secretaryId
        : null) ||
      formation.getMemberIds().find((id) => restoredIds.has(id)) ||
      restoredChars[0]?.id ||
      null;

    // 3. Await full persistence of every subsystem cleanly to IndexedDB
    await persistAllWorldSubsystems(preferredActiveId);

    // 4. Sync Auto-Save snapshot to the loaded slot so page reloads / Continue stay inside this slot
    if (syncAutoSave) {
      await saves.autoSave(captureFullWorldSnapshot(), {
        reason: 'slot-loaded',
        name: sourceName || `读取存档 · ${commander.getProfile().name}`,
        summary: buildSaveSummary('slot-loaded'),
      });
    }
  } finally {
    buildings.setMedalAutoCheckPaused(false);
    isWorldTransitioning = false;
  }

  await renderTopStatusBar();
  const active = moduleManager.getActive();
  if (!active?.id || active.id === 'title-screen') {
    moduleManager.mount('port-hub', { transition: 'left' });
  } else {
    moduleManager.mount(active.id);
  }
  return { migrated };
}

async function startNewJourney(prefs = {}) {
  const plan = buildNewGameSeedPlan(prefs);
  const commanderName = plan.commander.name;
  const keepCustomData = plan.keepCustomData;

  isWorldTransitioning = true;
  saves.cancelPendingAutoSaves();
  buildings.setMedalAutoCheckPaused(true);

  let flagshipId = null;
  try {
    // CRITICAL PROTECTION BOUNDARY:
    // ALWAYS preserve user-imported external JSON content libraries (custom character/equipment/enemy templates,
    // custom personality/trait pools, dialogue packs, and custom story/encounter packs) across New Game,
    // while strictly wiping ALL gameplay save progress!
    const preservedCustomBuildings = keepCustomData ? buildings.listCustomBuildings() : [];
    const prevContentSnap = contentManager.serialize();
    const prevStorySnap = storyPacks.serialize();
    const prevPersonalitySnap = personalityPool.serialize();

    // 1. Purge ALL old runtime progress from IndexedDB & localStorage (manual save-slots & imported libraries protected!)
    await clearAllRuntimePersistence({ keepCustomData, preserveImportedLibrary: true });

    // 2. Thoroughly reset ALL in-memory engines & UI caches (ships, gear, 3x4 formation, dockyard, sea control, medals, logs)
    await resetAllInMemoryState({ keepCustomData, preserveCustomBuildings: preservedCustomBuildings });

    // 3. Reset commander profile & 6 focus attributes cleanly from player's chosen options
    commander.deserialize(
      {
        name: plan.commander.name,
        title: plan.commander.title,
        avatarAssetId: null,
        personalityTags: plan.commander.personalityTags,
        level: 1,
        exp: 0,
        freePoints: 0,
        stats: { ...plan.commander.stats },
        luck: 0,
      },
      { persist: false }
    );

    // 4. Reset resources & exact drop multiplier from player's chosen Resource Mode + Drop Multiplier
    const now = Date.now();
    const freshResources = DEFAULT_RESOURCES.map((def) => ({
      ...def,
      amount: plan.resources.amounts[def.id] ?? def.amount,
      updatedAt: now,
    }));
    resources.deserialize(
      {
        version: 3,
        lastRecoveryAt: now,
        dropMultiplier: plan.resources.dropMultiplier,
        resources: freshResources,
      },
      { persist: false }
    );

    // 5. Restore protected external JSON content libraries cleanly while resetting all story flags & discovery progress
    if (!keepCustomData) {
      theme.resetTheme();
    }
    personalityPool.deserialize(prevPersonalitySnap || { primary: [], secondary: [] }, { persist: false });
    contentManager.deserialize(
      {
        version: 1,
        customEnemies: prevContentSnap?.customEnemies || [],
        customDialogues: prevContentSnap?.customDialogues || [],
        customGifts: prevContentSnap?.customGifts || [],
        customEquipment: prevContentSnap?.customEquipment || [],
        encounteredEnemyNames: ['前哨巡逻编队'],
        clearedRouteIds: [],
        updatedAt: now,
      },
      { persist: false }
    );
    storyPacks.deserialize(
      {
        version: 1,
        flags: {},
        packs: prevStorySnap?.packs || [],
        playHistory: [],
      },
      { persist: false }
    );
    // Suppress any forced built-in intro story popup on New Game
    storyPacks.clearActiveTheatreSession();

    // 6. Seed strictly clean 2-digit starter warehouse items & tiered enemy templates (ZERO hardcoded demo ships!)
    entities.clear();
    inventory.deserialize(
      {
        version: 6,
        customSlotsByCharacter: {},
        equipped: {},
        salvageParts: 0,
        retrofitCores: 0,
        items: STARTER_ITEMS.map((it) => ({ ...it, level: 0, statScaleVersion: 2, createdAt: now, updatedAt: now })),
      },
      { persist: false }
    );

    // Only ensure tiered enemy templates (includeDemoShips: false -> NEVER inject hardcoded demo shipgirls!)
    await contentManager.mergeStarterContentBundle({
      personalityPool,
      storyPacks,
      statRules,
      persistRosterFn: null,
      silent: true,
      includeDemoShips: false,
      includeItems: false,
    });
    storyPacks.clearActiveTheatreSession();

    // 7. Create archetype bonus gear & abundant loot rolls
    const createdBonusItems = [];
    for (const gear of plan.bonusGear) {
      const created = await inventory.createItem(gear);
      createdBonusItems.push(created);
    }
    if (plan.resources.isAbundant) {
      await inventory.rollLootDropItem({
        tier: 'elite',
        difficulty: 'star_2',
        dropMultiplier: plan.resources.dropMultiplier,
      });
      await inventory.rollLootDropItem({
        tier: 'boss',
        difficulty: 'star_2',
        dropMultiplier: plan.resources.dropMultiplier,
      });
    }

    // 8. Strictly instantiate ONLY the exact chosen starter ship(s) — 0 ships for Free Build mode!
    const createdShipIds = [];
    const usedComboKeys = new Set();
    for (const tpl of plan.starterShips) {
      let combo = null;
      if (personalityPool) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const cand = personalityPool.rollCombination();
          if (!usedComboKeys.has(cand.key)) {
            combo = cand;
            break;
          }
        }
        if (!combo) combo = personalityPool.rollCombination();
        usedComboKeys.add(combo.key);
      }

      const entity = entities.register({
        id: tpl.id,
        kind: 'character',
        name: tpl.name,
        tags: [tpl.shipType, ...(combo ? [combo.primaryName, combo.secondaryName] : [])],
        stats: { ...tpl.stats },
        statBounds: {
          hp: { min: 0, max: 500 },
          morale: { min: 0, max: 100 },
          ap: { min: 0, max: 100 },
          affinity: { min: 0, max: 100 },
        },
        meta: {
          shipType: tpl.shipType,
          roleTag: tpl.roleTag,
          avatarAssetId: null,
          personalityCombo: combo,
          personality: combo?.description || `${tpl.shipType}初始旗舰，已就位待命。`,
          speechHabit: combo?.speechHabit || `「${tpl.name}，听候指挥官调遣！」`,
          locked: false,
        },
      });
      if (statRules?.ensureShipProgression) {
        statRules.ensureShipProgression(entity);
      }

      // Equip dedicated seaworthy core 3-piece gear so the chosen starter ship can sortie immediately
      const coreParts = [
        {
          slot: 'engine',
          name: `${tpl.name}制式轮机`,
          category: ITEM_CATEGORIES.ENGINE,
          bonuses: [{ stat: 'evasion', layer: 'baseAdd', value: 4 }],
        },
        {
          slot: 'armor',
          name: `${tpl.name}舰体装甲`,
          category: ITEM_CATEGORIES.ARMOR,
          bonuses: [
            { stat: 'armor', layer: 'baseAdd', value: 4 },
            { stat: 'maxHp', layer: 'baseAdd', value: 4 },
          ],
        },
        {
          slot: 'core',
          name: `${tpl.name}火控中枢`,
          category: ITEM_CATEGORIES.CORE,
          bonuses: [
            { stat: 'firepower', layer: 'baseAdd', value: 4 },
            { stat: 'recon', layer: 'baseAdd', value: 3 },
          ],
        },
      ];
      for (const part of coreParts) {
        const gearItem = await inventory.createItem({
          name: part.name,
          category: part.category,
          rarity: ITEM_RARITIES.COMMON,
          statScaleVersion: 2,
          bonuses: part.bonuses,
        });
        await inventory.equipItem(entity.id, part.slot, gearItem.id);
      }

      // If AR / AO starter ship, automatically unlock 1 support slot and equip starter support gear
      if (tpl.grantSupportSlot) {
        const supSlot = await inventory.addExpandedSlot(entity.id, 'support', { skipCost: true });
        const supItem = createdBonusItems.find((it) => it.equipmentType === 'support');
        if (supSlot?.id && supItem?.id) {
          await inventory.equipItem(entity.id, supSlot.id, supItem.id);
        }
      }

      const effMaxHp = Math.round(entities.getEffectiveStat(entity.id, 'maxHp', { round: 'round' }).final);
      entities.setStat(entity.id, 'hp', effMaxHp, { min: 0, max: effMaxHp });
      createdShipIds.push(entity.id);
    }

    formation.deserialize(
      {
        version: 2,
        memberIds: createdShipIds,
        gridSlots: null,
        formationId: plan.starter.formationId,
        customFormationMods: {},
      },
      { persist: false }
    );

    flagshipId = createdShipIds[0] || null;
    await interaction.setSecretary(flagshipId);

    // 9. Await clean write of EVERY subsystem into IndexedDB before writing the fresh Auto-Save snapshot
    await persistAllWorldSubsystems(flagshipId);
    await saves.autoSave(captureFullWorldSnapshot(), {
      reason: 'new-journey',
      name: `新征程 · ${commanderName}`,
      summary: buildSaveSummary('new-journey'),
    });
  } finally {
    buildings.setMedalAutoCheckPaused(false);
    isWorldTransitioning = false;
  }

  await renderTopStatusBar();
  fxStage.playSfx('success');
  showToast(
    `欢迎就任，${commanderName}（${plan.commander.focusLabel}）！已开启「${plan.starter.label}」· ${plan.resources.modeLabel} · ${plan.resources.dropMultiplier.toFixed(1)}x 掉落（外部 JSON 库已保留）`,
    'ok'
  );
  moduleManager.mount('port-hub', { transition: 'left' });
}

async function continueLatestSave() {
  const autoRec = await saves.loadAutoSave();
  if (autoRec && autoRec.data) {
    const { migrated } = await restoreFullWorldSnapshot(autoRec.data, { syncAutoSave: false });
    showToast(migrated ? '已无损迁移并读取最近自动存档，欢迎回港！' : '已读取最近自动存档，欢迎回到港区！', 'ok');
    return { ok: true, source: 'auto' };
  }

  const slots = (await saves.listSlots())
    .filter((s) => !s.empty)
    .sort((a, b) => (Number(b.meta?.timestamp) || 0) - (Number(a.meta?.timestamp) || 0));
  if (slots.length > 0) {
    const latestRec = await saves.loadSlot(slots[0].slotIndex);
    if (latestRec && latestRec.data) {
      const { migrated } = await restoreFullWorldSnapshot(latestRec.data, {
        syncAutoSave: true,
        sourceName: latestRec.meta?.name || `手动存档 #${slots[0].slotIndex}`,
      });
      showToast(
        migrated
          ? `已无损迁移并读取槽位 #${slots[0].slotIndex}，欢迎回港！`
          : `已读取存档槽位 #${slots[0].slotIndex}，欢迎回到港区！`,
        'ok'
      );
      return { ok: true, source: `slot-${slots[0].slotIndex}` };
    }
  }

  if (entities.list({ kind: 'character' }).length > 0) {
    moduleManager.mount('port-hub', { transition: 'left' });
    showToast('欢迎回到港区大本营！', 'ok');
    return { ok: true, source: 'live' };
  }

  return { ok: false, reason: 'no-save' };
}

appActions.startNewJourney = startNewJourney;
appActions.continueLatestSave = continueLatestSave;

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
            <strong style="font-size:13.5px;">3. 视觉动效与合成音效开关</strong>
            <label class="checkbox-row">
              <input id="chk-fx-enabled" type="checkbox" ${fxStage.isEnabled() ? 'checked' : ''}>
              <span>启用战斗红光闪烁、3D 骰子检定与视觉演出</span>
            </label>
            <label class="checkbox-row">
              <input id="chk-fx-sound" type="checkbox" ${fxStage.isSoundEnabled() ? 'checked' : ''}>
              <span>启用轻量级 Web Audio 合成音效（可随时静音）</span>
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

          <div class="lab-divider"></div>

          <div class="lab-stack-sm">
            <div class="section-header-row" style="margin-bottom:0;">
              <strong style="font-size:13.5px;">5. 资源与掉落倍率调节（实时持久化）</strong>
              <span class="status-badge badge-ok" id="theme-drop-mult-badge">${resources.getDropMultiplier().toFixed(1)}x</span>
            </div>
            <p class="muted-text" style="font-size:12px;">
              同步调节出征物资与战利品收益、高品级装备箱掉率、批量拆解回收及港区每小时自然恢复产量。
            </p>
            <div class="lab-btn-grid" style="grid-template-columns: repeat(3, 1fr);">
              ${RESOURCE_DROP_MULTIPLIER_PRESETS.map((p) => {
                const isCur = Math.abs(resources.getDropMultiplier() - p.value) < 0.05;
                return `
                  <button
                    type="button"
                    class="${isCur ? 'btn-primary' : 'btn-secondary'} uikit-touch-target"
                    data-drop-mult-preset="${p.value}"
                    style="font-size:12px; padding:0 6px;"
                  >${escapeHtml(p.label)}</button>
                `;
              }).join('')}
            </div>
            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label" for="theme-drop-mult-range">自定义倍率（0.5x ~ 5.0x）</label>
                <span id="theme-drop-mult-val" class="status-model">${resources.getDropMultiplier().toFixed(1)}x</span>
              </div>
              <input id="theme-drop-mult-range" class="range-input" type="range" min="0.5" max="5.0" step="0.1" value="${resources.getDropMultiplier().toFixed(1)}">
            </div>
            ${(() => {
              const hr = buildings.getHourlyResourceYield();
              return `<div class="muted-text" id="theme-hourly-yield-readout" style="font-size:12px; padding:8px 10px; border-radius:var(--radius-sm); background:var(--surface-alt); border:1px solid var(--border);">
                当前港区自然恢复（每小时）：燃油 +${hr.fuel} · 弹药 +${hr.ammo} · 钢材 +${hr.steel} · 铝材 +${hr.bauxite}
              </div>`;
            })()}
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

      const refreshDropMultUi = (nextVal) => {
        const clean = resources.setDropMultiplier(nextVal);
        const badgeEl = body.querySelector('#theme-drop-mult-badge');
        const valEl = body.querySelector('#theme-drop-mult-val');
        const rangeEl = body.querySelector('#theme-drop-mult-range');
        const yieldEl = body.querySelector('#theme-hourly-yield-readout');
        if (badgeEl) badgeEl.textContent = `${clean.toFixed(1)}x`;
        if (valEl) valEl.textContent = `${clean.toFixed(1)}x`;
        if (rangeEl) rangeEl.value = clean.toFixed(1);
        if (yieldEl) {
          const hr = buildings.getHourlyResourceYield();
          yieldEl.textContent = `当前港区自然恢复（每小时）：燃油 +${hr.fuel} · 弹药 +${hr.ammo} · 钢材 +${hr.steel} · 铝材 +${hr.bauxite}`;
        }
        return clean;
      };

      body.querySelectorAll('[data-drop-mult-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = Number(btn.getAttribute('data-drop-mult-preset'));
          const clean = refreshDropMultUi(target);
          showToast(`资源与掉落倍率已设为 ${clean.toFixed(1)}x`, 'ok');
          renderThemeView();
        });
      });

      body.querySelector('#theme-drop-mult-range')?.addEventListener('input', (e) => {
        refreshDropMultUi(Number(e.target.value));
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
          <div class="lab-btn-grid" style="grid-template-columns: repeat(2, 1fr);">
            <button type="button" id="btn-vault-new-journey" class="btn-primary uikit-touch-target" style="font-size:12px;">开启新的征程（新建存档）</button>
            <button type="button" id="btn-vault-return-title" class="btn-secondary uikit-touch-target" style="font-size:12px;">返回标题封面</button>
            <button type="button" id="btn-vault-open-api" class="btn-secondary uikit-touch-target" style="font-size:12px;">AI 模型设置</button>
            <button type="button" id="btn-vault-open-data" class="btn-secondary uikit-touch-target" style="font-size:12px;">混合存储管理</button>
          </div>

          <div class="vault-slot-card is-auto" id="vault-auto-card">
            <div class="section-header-row" style="margin-bottom:0;">
              <strong>自动存档快照（Auto-Save）</strong>
              <span class="status-badge ${autoMeta ? 'badge-ok' : 'badge-muted'}">${autoMeta ? '已保护' : '暂无记录'}</span>
            </div>
            <p class="muted-text" style="font-size:12px;">
              ${
                autoMeta
                  ? `保存时间：${escapeHtml(formatTimeShort(autoMeta.timestamp))} · 指挥官 ${escapeHtml(autoMeta.summary?.commanderName || '提督')} Lv.${autoMeta.summary?.commanderLevel ?? 1} · 舰娘 ${autoMeta.summary?.characters ?? 0} 位 · 装备 ${autoMeta.summary?.items ?? 0} 件${autoMeta.summary?.seaSummary ? ` · 制海 ${escapeHtml(autoMeta.summary.seaSummary)}` : ''}`
                  : '每次关键操作（建造/改造/出征/互动/换肤）都会自动备份快照至此。'
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
                      ? '尚未写入存档数据。点击下方「保存至此槽位」即可独立备份当前舰娘名册、装备仓库、聊天记录、3×4 编队与海域进度。'
                      : `指挥官：${escapeHtml(s.commanderName || '提督')} Lv.${s.commanderLevel ?? 1} · 舰娘 ${s.characters ?? 0} 位 · 装备 ${s.items ?? 0} 件 · 秘书舰：${escapeHtml(s.flagshipName || '—')}${s.seaSummary ? ` · 制海：${escapeHtml(s.seaSummary)}` : ''}`
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
            <strong style="font-size:13.5px;">全量存档文件备份与跨版本无损迁移（v9）</strong>
            <p class="muted-text" style="font-size:12px;">
              导出的 JSON 包含自动存档、所有独立手动槽位与全局设置；导入旧版（v1~v8）存档将自动无损迁移并解锁已跨过的好感阶段突破小剧场，清理旧内置剧情包且完整保留外置 JSON 内容库。
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

      body.querySelector('#btn-vault-new-journey')?.addEventListener('click', () => {
        closeSheet();
        openNewJourneyModal({ uiKit, commander, appActions });
      });
      body.querySelector('#btn-vault-return-title')?.addEventListener('click', () => {
        closeSheet();
        moduleManager.mount('title-screen');
      });
      body.querySelector('#btn-vault-open-api')?.addEventListener('click', () => openApiSheet());
      body.querySelector('#btn-vault-open-data')?.addEventListener('click', () => openDataSheet());

      const loadAutoBtn = body.querySelector('#btn-vault-load-auto');
      if (loadAutoBtn) {
        loadAutoBtn.addEventListener('click', () => {
          askConfirm(
            '确认读取自动存档？',
            '将清空当前内存中的临时状态并使用自动存档快照完整恢复港区进度、舰娘、装备与海域制海权。',
            '确认读取恢复',
            async () => {
              const rec = await saves.loadAutoSave();
              if (!rec) return;
              const { migrated } = await restoreFullWorldSnapshot(rec.data, { syncAutoSave: false });
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
            '读取前会彻底清空当前运行的内存与缓存状态，并完整独立恢复该槽位的舰娘、装备、3×4 编队、船坞与海域进度。',
            `确认读取槽位 #${idx}`,
            async () => {
              const rec = await saves.loadSlot(idx);
              if (!rec) return;
              const { migrated } = await restoreFullWorldSnapshot(rec.data, {
                syncAutoSave: true,
                sourceName: rec.meta?.name || `手动存档 #${idx}`,
              });
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

function openCustomWorkshop(initialTab = 'ship') {
  openCustomWorkshopModal(
    {
      entities,
      inventory,
      buildings,
      contentManager,
      storyPacks,
      personalityPool,
      statRules,
      assets,
      storage,
      uiKit,
      bus,
    },
    { initialTab }
  );
}

els.btnCustomWorkshop?.addEventListener('click', () => openCustomWorkshop('ship'));
els.btnModules?.addEventListener('click', openModulesSheet);
els.btnTheme?.addEventListener('click', openThemeSheet);
els.btnVault?.addEventListener('click', openSaveVaultSheet);
els.btnReturnTitle?.addEventListener('click', () => {
  moduleManager.mount('title-screen');
});
els.topCmdBtn?.addEventListener('click', () => {
  if (sortieNavLocked) {
    showToast('出征配置或航行战斗中已锁定切页，请先返回出征准备或安全撤退', 'warn');
    return;
  }
  if (moduleManager.getActive()?.id !== 'character-console') {
    moduleManager.mount('character-console', { transition: 'left' });
  }
});
els.btnApi?.addEventListener('click', openApiSheet);
els.btnData?.addEventListener('click', openDataSheet);

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
      storyEngine.init(),
    ]);

    // Ensure tiered enemy templates exist without ever injecting hardcoded demo shipgirls into the dock
    await contentManager.mergeStarterContentBundle({
      personalityPool,
      storyPacks,
      statRules,
      persistRosterFn: null,
      silent: true,
      includeDemoShips: false,
      includeItems: false,
    });
    if (entities.list({ kind: 'character' }).length > 0) {
      storyEngine.syncLegacyBreakthroughs();
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

  // Keep the fixed top status bar (Commander summary + 6 resources) live-synced
  await renderTopStatusBar();
  bus.on('resource:changed', () => {
    if (!isWorldTransitioning) renderTopStatusBar();
  });
  bus.on('commander:updated', () => {
    if (isWorldTransitioning) return;
    topCmdAvatarAssetCache = { assetId: '__refresh__', url: '' };
    renderTopStatusBar();
  });
  bus.on('storage:changed', () => {
    if (!isWorldTransitioning) renderTopStatusBar();
  });

  // Auto-persist character roster whenever any shipgirl gains EXP, levels up, or rerolls personality
  const syncRosterOnProgression = () => {
    if (isWorldTransitioning) return;
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
      'medal:unlocked',
      'sea-control:updated',
      'interaction:talked',
      'interaction:gifted',
      'interaction:oathed',
      'story-engine:updated',
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
      'inventory:promoted',
      'inventory:salvage-changed',
      'inventory:slot-expanded',
      'inventory:cleaned',
      'inventory:item-created',
      'inventory:item-updated',
      'inventory:item-deleted',
      'inventory:slot-added',
      'inventory:slot-renamed',
      'inventory:slot-removed',
      'character:saved',
      'character:deleted',
      'character:exp-gained',
      'character:leveled-up',
      'resource:changed',
      'resource:multiplier-changed',
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
    { debounceMs: 180, enabled: () => !isWorldTransitioning }
  );

  // Boot onto the Title Cover screen so players can Continue, start a New Journey with preferences, or Load Save
  moduleManager.mount('title-screen');
}

bootApplication().catch((err) => {
  console.error('[App] Fatal boot error:', err);
  if (typeof window !== 'undefined' && typeof window.__SHOW_BOOT_ERROR__ === 'function') {
    window.__SHOW_BOOT_ERROR__(err, '应用启动失败');
  }
});

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
  storyEngine,
  theme,
  uiKit,
  modules: moduleManager,
  openCustomWorkshop,
  resetCurrentSavePreserveExternalJson: async () => {
    await startNewJourney({
      commanderName: commander.getProfile()?.name || '新任提督',
      commanderFocus: 'balanced',
      starterSelection: 'none',
      resourceMode: 'standard',
      dropMultiplier: 1.0,
      keepCustomData: true,
    });
  },
  captureFullWorldSnapshot,
  restoreFullWorldSnapshot,
};
