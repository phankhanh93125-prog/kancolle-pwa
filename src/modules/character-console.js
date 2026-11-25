/**
 * Official Business Module #1: Character Console (`character-console`).
 *
 * Mobile-first character console featuring:
 *   - Unified 6-resource & dual-currency top overview bar (fuel/ammo/steel/bauxite + silver/gold)
 *   - Character roster CRUD + mobile gallery avatar upload (WebP -> IndexedDB)
 *   - 3 Fixed Mandatory Core Slots (引擎 / 装甲 / 核心) with live Seaworthiness (适航) validation
 *   - Completely freeform per-character custom optional slots (+ 添加自定义槽位 / 重命名 / 删除 / 装入任意通用扩展装备)
 *   - Full-slot live 5-stat recalculation + visual item/affix editor
 *   - Resource overview, Chronological Action Logs, Stat Rules Settings & Real-Time 1D20 Check Simulator
 */

import {
  CORE_STAT_DEFS,
  CORE_STAT_MAP,
  NAVAL_EIGHT_STAT_DEFS,
  NAVAL_EIGHT_STAT_MAP,
  SHIP_TYPE_PRESETS,
} from '../core/stat-rules.js';
import {
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
} from '../core/inventory-system.js';
import {
  CORE_CURRENCY_IDS,
  CORE_RESOURCE_IDS,
  createResourceOverviewBar,
} from '../core/resource-manager.js';
import { LOG_CATEGORIES, LOG_CATEGORY_LABELS } from '../core/log-system.js';
import { clamp } from '../core/calc-engine.js';

const CHAR_STORAGE_NS = 'core-characters';
const ROSTER_KEY = 'roster-state-v3';

const BONUS_STAT_OPTIONS = [
  { key: 'maxHp', label: '耐久 (HP上限)' },
  { key: 'firepower', label: '火力' },
  { key: 'armor', label: '装甲' },
  { key: 'torpedo', label: '雷击' },
  { key: 'evasion', label: '机动' },
  { key: 'recon', label: '侦查' },
  { key: 'aa', label: '防空' },
  { key: 'asw', label: '反潜' },
  { key: 'checkBonus', label: '检定额外加成' },
  { key: 'hp', label: '当前耐久恢复' },
  { key: 'morale', label: '士气' },
  { key: 'ap', label: '行动点' },
];

const BONUS_STAT_LABEL_MAP = Object.fromEntries(BONUS_STAT_OPTIONS.map((o) => [o.key, o.label]));

/**
 * 3 Default Seaworthy Naval Shipgirls (all 3 equipped with engine/armor/core on first boot)
 * so the player can immediately deploy a full 3-ship starter fleet.
 */
export const DEFAULT_CHARACTER_TEMPLATES = [
  {
    id: 'char_template_01',
    kind: 'character',
    name: '示范驱逐 · 一号舰',
    tags: ['驱逐舰', '雷击反潜'],
    stats: {
      maxHp: 78,
      hp: 78,
      firepower: 46,
      armor: 34,
      torpedo: 76,
      evasion: 78,
      recon: 62,
      aa: 54,
      asw: 74,
      morale: 78,
      ap: 90,
      maxAp: 100,
      affinity: 52,
      level: 1,
      exp: 0,
      maxExp: 100,
    },
    statBounds: {
      hp: { min: 0, max: 300 },
      morale: { min: 0, max: 100 },
      ap: { min: 0, max: 100 },
      affinity: { min: 0, max: 100 },
    },
    meta: {
      shipType: '驱逐舰',
      roleTag: '高机动雷击反潜',
      avatarAssetId: null,
      personality: '敏捷果断、擅长夜战突击与反潜护航，对指挥官指令响应极快。',
      speechHabit: '「一号舰全速前进，鱼雷管注水完毕！」',
    },
  },
  {
    id: 'char_template_02',
    kind: 'character',
    name: '示范轻巡 · 二号舰',
    tags: ['轻巡洋舰', '侦查防空'],
    stats: {
      maxHp: 94,
      hp: 94,
      firepower: 60,
      armor: 52,
      torpedo: 58,
      evasion: 64,
      recon: 72,
      aa: 70,
      asw: 66,
      morale: 82,
      ap: 90,
      maxAp: 100,
      affinity: 42,
      level: 1,
      exp: 0,
      maxExp: 100,
    },
    statBounds: {
      hp: { min: 0, max: 300 },
      morale: { min: 0, max: 100 },
      ap: { min: 0, max: 100 },
      affinity: { min: 0, max: 100 },
    },
    meta: {
      shipType: '轻巡洋舰',
      roleTag: '均衡侦查防空',
      avatarAssetId: null,
      personality: '冷静周密、擅长舰队侦察协调与对空掩护，是可靠的僚机中枢。',
      speechHabit: '「空域与水下态势已同步，随时可以掩护编队。」',
    },
  },
  {
    id: 'char_template_03',
    kind: 'character',
    name: '示范战列 · 三号舰',
    tags: ['战列舰', '重炮重甲'],
    stats: {
      maxHp: 132,
      hp: 132,
      firepower: 86,
      armor: 82,
      torpedo: 12,
      evasion: 38,
      recon: 48,
      aa: 68,
      asw: 22,
      morale: 76,
      ap: 90,
      maxAp: 100,
      affinity: 38,
      level: 1,
      exp: 0,
      maxExp: 100,
    },
    statBounds: {
      hp: { min: 0, max: 300 },
      morale: { min: 0, max: 100 },
      ap: { min: 0, max: 100 },
      affinity: { min: 0, max: 100 },
    },
    meta: {
      shipType: '战列舰',
      roleTag: '主力重炮重甲',
      avatarAssetId: null,
      personality: '沉稳坚毅、拥有强悍正面火力与装甲抗伤能力，擅长为编队承伤压阵。',
      speechHabit: '「主炮装填就绪，交给我正面突破即可。」',
    },
  },
];

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatSigned(n) {
  const v = Number(n) || 0;
  return v >= 0 ? `+${v}` : `${v}`;
}

function formatBonusChip(bonus) {
  const label = BONUS_STAT_LABEL_MAP[bonus.stat] || NAVAL_EIGHT_STAT_MAP[bonus.stat]?.label || bonus.stat;
  if (bonus.layer === 'percentAdd' || bonus.layer === 'percentMult') {
    const pct = Math.round((Number(bonus.value) || 0) * 100);
    return `${label} ${pct >= 0 ? `+${pct}%` : `${pct}%`}`;
  }
  return `${label} ${formatSigned(bonus.value)}`;
}

function formatItemTitle(item) {
  if (!item) return '';
  return item.level > 0 ? `${item.name} +${item.level}` : item.name;
}

function formatTimeShort(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

async function equipStarterCorePartsIfPresent(inventory, charId, includeOutfit = false) {
  if (inventory.getItem('item_core_engine_01')) {
    await inventory.equipItem(charId, 'engine', 'item_core_engine_01');
  }
  if (inventory.getItem('item_core_armor_01')) {
    await inventory.equipItem(charId, 'armor', 'item_core_armor_01');
  }
  if (inventory.getItem('item_core_core_01')) {
    await inventory.equipItem(charId, 'core', 'item_core_core_01');
  }
  if (includeOutfit && inventory.getItem('item_outfit_standard')) {
    await inventory.equipItem(charId, 'outfit', 'item_outfit_standard');
  }
}

/**
 * Hydrate persisted naval shipgirl roster from IndexedDB into EntitySystem on app boot.
 */
export async function hydrateCharacterRoster({ storage, entities, inventory, statRules, commander = null }) {
  const scope = storage.namespace(CHAR_STORAGE_NS);
  const saved = await scope.getLarge(ROSTER_KEY, null);
  const now = Date.now();

  if (saved && Array.isArray(saved.characters) && saved.characters.length > 0) {
    for (const ch of saved.characters) {
      if (ch && ch.id) {
        const reg = entities.register({ ...ch, kind: 'character' });
        if (statRules && typeof statRules.ensureShipProgression === 'function') {
          statRules.ensureShipProgression(reg);
        }
      }
    }
    inventory.syncAllCharacters();

    if (saved.lastActiveAt && now - saved.lastActiveAt >= 60 * 1000) {
      const charList = entities.list({ kind: 'character' });
      if (charList.length > 0) {
        const moraleMultiplier = commander ? commander.getMoraleRecoveryMultiplier() : 1.0;
        const rules = statRules.buildOfflineRecoveryRules(charList, { moraleMultiplier });
        entities.settleOfflineTime({
          lastTimestamp: saved.lastActiveAt,
          now,
          rules,
        });
      }
    }
    const restoredId = saved.activeCharacterId || saved.characters[0]?.id || null;
    consoleState.activeCharacterId = restoredId;
    if (restoredId) scope.set('activeCharacterId', restoredId);
    return { activeCharacterId: restoredId, seeded: false };
  }

  // First boot: seed 3 seaworthy starter shipgirls equipped with engine/armor/core + 1 sample custom module
  for (const tpl of DEFAULT_CHARACTER_TEMPLATES) {
    const reg = entities.register(tpl);
    if (statRules && typeof statRules.ensureShipProgression === 'function') {
      statRules.ensureShipProgression(reg);
    }
  }
  await equipStarterCorePartsIfPresent(inventory, 'char_template_01', true);
  await equipStarterCorePartsIfPresent(inventory, 'char_template_02', false);
  await equipStarterCorePartsIfPresent(inventory, 'char_template_03', false);

  // Equip a starter custom slot with dynamic extended attribute ('夜战修正') on ship #1
  if (inventory.getItem('item_ext_02')) {
    const slot = await inventory.addCharacterCustomSlot('char_template_01', '夜战与声呐扩展槽');
    await inventory.equipItem('char_template_01', slot.id, 'item_ext_02');
  }

  // Ensure initial HP matches effective maxHp after core armor bonus
  for (const tpl of DEFAULT_CHARACTER_TEMPLATES) {
    const effMaxHp = Math.round(entities.getEffectiveStat(tpl.id, 'maxHp', { round: 'round' }).final);
    entities.setStat(tpl.id, 'hp', effMaxHp, { min: 0, max: effMaxHp });
  }

  consoleState.activeCharacterId = 'char_template_01';
  await persistCharacterRoster({
    storage,
    entities,
    activeCharacterId: 'char_template_01',
  });
  return { activeCharacterId: 'char_template_01', seeded: true };
}

export function getActiveCharacterId(storage = null) {
  if (consoleState.activeCharacterId) return consoleState.activeCharacterId;
  if (storage) {
    const saved = storage.namespace(CHAR_STORAGE_NS).get('activeCharacterId', null);
    if (saved) {
      consoleState.activeCharacterId = saved;
      return saved;
    }
  }
  return null;
}

export async function persistCharacterRoster({ storage, entities, activeCharacterId = null }) {
  const scope = storage.namespace(CHAR_STORAGE_NS);
  const resolvedActiveId =
    activeCharacterId || consoleState.activeCharacterId || entities.list({ kind: 'character' })[0]?.id || null;
  if (resolvedActiveId) {
    consoleState.activeCharacterId = resolvedActiveId;
    scope.set('activeCharacterId', resolvedActiveId);
  }
  const characters = entities.list({ kind: 'character' }).map((e) => ({
    id: e.id,
    kind: 'character',
    name: e.name,
    tags: [...(e.tags || [])],
    stats: { ...(e.stats || {}) },
    statBounds: JSON.parse(JSON.stringify(e.statBounds || {})),
    modifiers: (e.modifiers || []).filter((m) => !String(m.id || '').startsWith('inv_eq_')),
    meta: JSON.parse(JSON.stringify(e.meta || {})),
  }));
  await scope.setLarge(ROSTER_KEY, {
    activeCharacterId: resolvedActiveId,
    lastActiveAt: Date.now(),
    characters,
  });
}

// ============================================================
// Module Runtime State
// ============================================================

let consoleState = {
  container: null,
  context: null,
  activeCharacterId: null,
  activeTab: 'overview',
  itemCategoryFilter: 'all',
  logCategoryFilter: 'all',
  tabsCtrl: null,
  avatarUrlCache: new Map(),
  unsubs: [],
};

function getCharacters() {
  return consoleState.context?.entities?.list({ kind: 'character' }) || [];
}

function getActiveCharacter() {
  const list = getCharacters();
  if (list.length === 0) return null;
  const found = list.find((c) => c.id === consoleState.activeCharacterId);
  if (found) return found;
  consoleState.activeCharacterId = list[0].id;
  return list[0];
}

async function resolveAvatarUrl(char) {
  const { assets } = consoleState.context;
  const assetId = char?.meta?.avatarAssetId || null;
  const cacheKey = `${char.id}::${assetId || 'none'}`;
  if (consoleState.avatarUrlCache.has(cacheKey)) {
    return consoleState.avatarUrlCache.get(cacheKey);
  }
  const resolved = await assets.getAssetUrl(assetId, {
    fallbackSeed: char.id,
    fallbackLabel: char.name.slice(0, 6),
  });
  consoleState.avatarUrlCache.set(cacheKey, resolved.url);
  return resolved.url;
}

async function saveRosterNow() {
  if (!consoleState.context) return;
  await persistCharacterRoster({
    storage: consoleState.context.rootStorage,
    entities: consoleState.context.entities,
    activeCharacterId: consoleState.activeCharacterId,
  });
}

// ============================================================
// Bottom Sheet Modals
// ============================================================

function openAddCustomSlotSheet(char) {
  if (!char) return;
  const { inventory, uiKit, logs } = consoleState.context;

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <p class="muted-text">
      自定义槽位属于<strong>非必须选装槽位</strong>，不限制名称与武器/电子分类。留空不影响适航状态，可随时装入任意「通用扩展装备」、重命名或删除。
    </p>
    <div class="form-group">
      <label class="form-label" for="cc-custom-slot-name">自定义槽位名称 *</label>
      <input id="cc-custom-slot-name" class="form-input" type="text" placeholder="自由输入任意名称（如：雷达 / 火控 / 主炮 / 扩展槽1）">
    </div>
  `;

  uiKit.openBottomSheet({
    title: `为「${char.name}」添加自定义槽位`,
    subtitle: '完全自由命名 · 默认兼容任意通用扩展装备',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'add',
        label: '确认添加',
        tone: 'primary',
        onClick: async () => {
          const label = wrap.querySelector('#cc-custom-slot-name').value.trim();
          if (!label) {
            uiKit.showToast('请输入自定义槽位名称', 'warn');
            return false;
          }
          await inventory.addCharacterCustomSlot(char.id, label);
          logs.add({
            category: LOG_CATEGORIES.EQUIPMENT,
            actorId: char.id,
            actorName: char.name,
            title: `[${char.name}] 添加自定义槽位「${label}」`,
            detail: '非必须选装槽位（兼容任意通用扩展装备）',
          });
          uiKit.showToast(`已添加自定义槽位：${label}`, 'ok');
          await renderConsole();
          return true;
        },
      },
    ],
  });
}

function openRenameCustomSlotSheet(char, slot) {
  const { inventory, uiKit } = consoleState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="cc-rename-slot-input">新槽位名称 *</label>
      <input id="cc-rename-slot-input" class="form-input" type="text" value="${escapeHtml(slot.label)}">
    </div>
  `;

  uiKit.openBottomSheet({
    title: `重命名槽位 · ${slot.label}`,
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: '保存名称',
        tone: 'primary',
        onClick: async () => {
          const nextName = wrap.querySelector('#cc-rename-slot-input').value.trim();
          if (!nextName) {
            uiKit.showToast('槽位名称不能为空', 'warn');
            return false;
          }
          await inventory.renameCharacterCustomSlot(char.id, slot.id, nextName);
          uiKit.showToast(`槽位已重命名为：${nextName}`, 'ok');
          await renderConsole();
          return true;
        },
      },
    ],
  });
}

function openSlotEquipPickerSheet(char, slot) {
  const { inventory, uiKit } = consoleState.context;
  const compatibleItems = inventory
    .listItems()
    .filter((it) => slot.allowedCategories.includes(it.category));

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  let sheetHandle = null;

  if (compatibleItems.length === 0) {
    wrap.innerHTML = `<p class="muted-text">仓库中暂无可装入「${escapeHtml(slot.label)}」的物品，请先新建或前往「物资与工坊台」获取。</p>`;
  } else {
    const list = document.createElement('div');
    list.className = 'lab-stack-sm';
    for (const item of compatibleItems) {
      const currentSlot = inventory.getEquippedSlotOfItem(char.id, item.id);
      const isHere = currentSlot === slot.id;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lab-choice-btn';
      btn.dataset.pickItemId = item.id;
      btn.innerHTML = `
        <span class="lab-choice-title">${escapeHtml(formatItemTitle(item))}${isHere ? '（当前已装）' : ''}</span>
        <span class="lab-choice-sub">${
          item.bonuses?.length ? escapeHtml(item.bonuses.map(formatBonusChip).join(' · ')) : '无属性词条'
        }</span>
      `;
      btn.addEventListener('click', async () => {
        try {
          await inventory.equipItem(char.id, slot.id, item.id);
          await saveRosterNow();
          if (sheetHandle) sheetHandle.close();
          uiKit.showToast(`已将「${item.name}」装入「${slot.label}」`, 'ok');
          await renderConsole();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '装入失败', 'error');
        }
      });
      list.appendChild(btn);
    }
    wrap.appendChild(list);
  }

  sheetHandle = uiKit.openBottomSheet({
    title: `为「${slot.label}」选择部件/装备`,
    subtitle: slot.required ? '核心必装槽位' : slot.custom ? '自定义选装槽位（支持任意通用扩展装备）' : '可选穿戴槽位',
    content: wrap,
    actions: [{ id: 'close', label: '关闭', tone: 'secondary' }],
  });
}

function openCharacterEditorSheet(existingChar = null) {
  const { entities, inventory, assets, uiKit, logs, bus, statRules, commander } = consoleState.context;
  const isEdit = Boolean(existingChar);
  const rulesCfg = statRules.getConfig();
  const initialAffBonus = commander ? commander.getInitialAffinityBonus() : 0;
  const initialProg = existingChar
    ? statRules.ensureShipProgression(existingChar)
    : { level: 1, exp: 0, maxExp: statRules.getShipMaxExp(1) };
  let originalLevel = initialProg.level;

  const draft = existingChar
    ? {
        name: existingChar.name,
        shipType: existingChar.meta?.shipType || '驱逐舰',
        roleTag: existingChar.meta?.roleTag || '',
        avatarAssetId: existingChar.meta?.avatarAssetId || null,
        personality: existingChar.meta?.personality || '',
        speechHabit: existingChar.meta?.speechHabit || '',
        stats: {
          ...existingChar.stats,
          level: initialProg.level,
          exp: initialProg.exp,
          maxExp: initialProg.maxExp,
        },
      }
    : {
        name: '',
        shipType: '驱逐舰',
        roleTag: '新编舰船',
        avatarAssetId: null,
        personality: '',
        speechHabit: '',
        stats: {
          maxHp: 90,
          hp: 90,
          firepower: 55,
          armor: 45,
          torpedo: 50,
          evasion: 55,
          recon: 50,
          aa: 48,
          asw: 46,
          morale: 75,
          ap: 100,
          maxAp: 100,
          affinity: clamp(20 + initialAffBonus, 0, 100),
          level: 1,
          exp: 0,
          maxExp: statRules.getShipMaxExp(1),
        },
      };

  const formWrap = document.createElement('div');
  formWrap.className = 'module-stack';

  const syncInputsToDraft = () => {
    const nameEl = formWrap.querySelector('#cc-f-name');
    if (!nameEl) return;
    draft.name = nameEl.value.trim();
    draft.shipType = formWrap.querySelector('#cc-f-shiptype').value.trim() || '驱逐舰';
    draft.roleTag = formWrap.querySelector('#cc-f-role').value.trim();
    draft.personality = formWrap.querySelector('#cc-f-personality').value.trim();
    draft.speechHabit = formWrap.querySelector('#cc-f-speech').value.trim();
    for (const def of NAVAL_EIGHT_STAT_DEFS) {
      const v = Number(formWrap.querySelector(`#cc-f-stat-${def.key}`).value);
      const minB = def.isVital ? 20 : rulesCfg.statMin;
      const maxB = def.isVital ? 999 : rulesCfg.statMax;
      draft.stats[def.key] = clamp(Number.isFinite(v) ? v : def.defaultValue, minB, maxB);
    }
    const lvInput = formWrap.querySelector('#cc-f-level');
    const expInput = formWrap.querySelector('#cc-f-exp');
    const lvVal = clamp(Math.floor(Number(lvInput?.value) || 1), 1, rulesCfg.shipLevelMax);
    draft.stats.level = lvVal;
    draft.stats.maxExp = statRules.getShipMaxExp(lvVal);
    draft.stats.exp = clamp(Math.floor(Number(expInput?.value) || 0), 0, Math.max(0, draft.stats.maxExp - 1));

    draft.stats.affinity = clamp(Number(formWrap.querySelector('#cc-f-affinity').value) || 0, 0, 100);
    const hpVal = clamp(Number(formWrap.querySelector('#cc-f-hp').value) || 0, 0, 999);
    const apVal = clamp(Number(formWrap.querySelector('#cc-f-ap').value) || 0, 0, 999);
    draft.stats.hp = Math.min(hpVal, draft.stats.maxHp);
    draft.stats.morale = clamp(Number(formWrap.querySelector('#cc-f-morale').value) || 0, 0, 100);
    draft.stats.ap = apVal;
    draft.stats.maxAp = Math.max(Number(draft.stats.maxAp || 100), apVal);
  };

  const renderForm = async () => {
    const avatarRes = await assets.getAssetUrl(draft.avatarAssetId, {
      fallbackSeed: existingChar?.id || draft.name || 'new-char',
      fallbackLabel: (draft.name || 'SHIP').slice(0, 6),
    });

    formWrap.innerHTML = `
      <div class="cc-hero-row">
        <img id="cc-edit-avatar-img" class="cc-avatar" src="${avatarRes.url}" alt="角色头像预览">
        <div class="lab-stack-sm" style="flex:1 1 auto; min-width:0;">
          <button type="button" id="btn-cc-upload-avatar" class="btn-secondary uikit-touch-target">从相册上传头像立绘</button>
          ${
            draft.avatarAssetId
              ? '<button type="button" id="btn-cc-clear-avatar" class="btn-ghost-sm">恢复默认几何占位图</button>'
              : '<span class="muted-text" style="font-size:11.5px;">未上传时自动使用几何占位图</span>'
          }
        </div>
      </div>

      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="cc-f-name">舰娘名称 *</label>
          <input id="cc-f-name" class="form-input" type="text" value="${escapeHtml(draft.name)}" placeholder="例如：示范重巡 · 四号舰">
        </div>
        <div class="form-group">
          <label class="form-label" for="cc-f-shiptype">舰种（可自由输入自定义舰种）*</label>
          <input id="cc-f-shiptype" class="form-input" type="text" value="${escapeHtml(draft.shipType)}" placeholder="驱逐舰 / 轻巡 / 自定义">
        </div>
      </div>

      <div class="chip-row" id="cc-shiptype-presets">
        ${SHIP_TYPE_PRESETS.map(
          (st) => `<button type="button" class="preset-chip" data-shiptype-preset="${escapeHtml(st)}">${escapeHtml(st)}</button>`
        ).join('')}
      </div>

      <div class="form-group">
        <label class="form-label" for="cc-f-role">定位简称</label>
        <input id="cc-f-role" class="form-input" type="text" value="${escapeHtml(draft.roleTag)}" placeholder="例如：防空护航型 / 夜战突击型">
      </div>

      <div class="surface-card lab-stack-sm" style="padding:10px;">
        <div class="section-header-row" style="margin-bottom:0;">
          <strong style="font-size:13px;">等级与经验调试（自动按成长曲线结算白值）</strong>
          <span class="status-badge ship-lv-badge">Lv.${draft.stats.level}</span>
        </div>
        <div class="lab-kv-grid">
          <div class="form-group">
            <label class="form-label" for="cc-f-level">舰娘等级 (1~${rulesCfg.shipLevelMax})</label>
            <input id="cc-f-level" class="form-input" type="number" min="1" max="${rulesCfg.shipLevelMax}" value="${draft.stats.level}">
          </div>
          <div class="form-group">
            <label class="form-label" for="cc-f-exp">当前经验 (上限 ${draft.stats.maxExp})</label>
            <input id="cc-f-exp" class="form-input" type="number" min="0" max="${Math.max(0, draft.stats.maxExp - 1)}" value="${draft.stats.exp}">
          </div>
        </div>
        ${
          isEdit
            ? `<button type="button" id="btn-cc-debug-grant-exp" class="btn-secondary uikit-touch-target">调试注入 +120 经验（立即结算升级成长）</button>`
            : ''
        }
      </div>

      <div class="form-group">
        <span class="form-label">舰娘白值八维属性（不含装备/模块加成）</span>
        <div class="lab-kv-grid">
          ${NAVAL_EIGHT_STAT_DEFS.map(
            (def) => `
            <div class="form-group">
              <label class="form-label" for="cc-f-stat-${def.key}">${escapeHtml(def.label)}</label>
              <input id="cc-f-stat-${def.key}" class="form-input" type="number" min="${def.isVital ? 20 : rulesCfg.statMin}" max="${def.isVital ? 999 : rulesCfg.statMax}" value="${Number(draft.stats[def.key] ?? def.defaultValue)}">
            </div>
          `
          ).join('')}
        </div>
      </div>

      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="cc-f-hp">当前耐久 HP</label>
          <input id="cc-f-hp" class="form-input" type="number" min="0" max="999" value="${Number(draft.stats.hp ?? draft.stats.maxHp ?? 90)}">
        </div>
        <div class="form-group">
          <label class="form-label" for="cc-f-affinity">好感度（0~100${!isEdit && initialAffBonus > 0 ? `，含魅力+${initialAffBonus}` : ''}）</label>
          <input id="cc-f-affinity" class="form-input" type="number" min="0" max="100" value="${Number(draft.stats.affinity ?? 20)}">
        </div>
        <div class="form-group">
          <label class="form-label" for="cc-f-morale">士气 (0~100)</label>
          <input id="cc-f-morale" class="form-input" type="number" min="0" max="100" value="${Number(draft.stats.morale ?? 75)}">
        </div>
        <div class="form-group">
          <label class="form-label" for="cc-f-ap">行动点 AP</label>
          <input id="cc-f-ap" class="form-input" type="number" min="0" max="999" value="${Number(draft.stats.ap ?? 100)}">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="cc-f-personality">性格设定</label>
        <textarea id="cc-f-personality" class="form-textarea" placeholder="描述角色性格特征、行动倾向...">${escapeHtml(draft.personality)}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label" for="cc-f-speech">对话口癖</label>
        <input id="cc-f-speech" class="form-input" type="text" value="${escapeHtml(draft.speechHabit)}" placeholder="例如：「了解，马上处理。」">
      </div>
    `;

    formWrap.querySelectorAll('[data-shiptype-preset]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const val = chip.getAttribute('data-shiptype-preset');
        formWrap.querySelector('#cc-f-shiptype').value = val;
        draft.shipType = val;
      });
    });

    const dbgExpBtn = formWrap.querySelector('#btn-cc-debug-grant-exp');
    if (dbgExpBtn && isEdit) {
      dbgExpBtn.addEventListener('click', async () => {
        const res = statRules.grantShipExp(entities, existingChar.id, 120, {
          reason: '角色编辑调试经验注入',
          inventory,
        });
        if (res) {
          const fresh = entities.get(existingChar.id);
          draft.stats = { ...fresh.stats };
          originalLevel = fresh.stats.level;
          await saveRosterNow();
          uiKit.showToast(
            res.leveledUp
              ? `★ ${res.characterName} 升级至 Lv.${res.afterLevel}！白值已自动成长`
              : `${res.characterName} 获得 +${res.amount} EXP (${res.exp}/${res.maxExp})`,
            'ok'
          );
          await renderForm();
          await renderConsole();
        }
      });
    }

    formWrap.querySelector('#btn-cc-upload-avatar').addEventListener('click', async () => {
      syncInputsToDraft();
      const file = await assets.pickImageFromDevice();
      if (!file) return;
      try {
        const meta = await assets.saveImageFromFile(file, {
          label: `avatar-${draft.name || 'char'}`,
          maxWidth: 512,
          maxHeight: 512,
          quality: 0.8,
        });
        draft.avatarAssetId = meta.id;
        uiKit.showToast(`头像已压缩入库（${meta.width}×${meta.height} WebP）`, 'ok');
        await renderForm();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '头像上传失败', 'error');
      }
    });

    const clearBtn = formWrap.querySelector('#btn-cc-clear-avatar');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        syncInputsToDraft();
        draft.avatarAssetId = null;
        await renderForm();
      });
    }
  };

  renderForm();

  uiKit.openBottomSheet({
    title: isEdit ? `编辑舰娘 · ${existingChar.name}` : '新建自定义舰娘角色',
    subtitle: '默认配置「引擎 / 装甲 / 核心」三个必装槽位，可自由扩展自定义模块槽并调试等级',
    content: formWrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: isEdit ? '保存修改' : '创建角色',
        tone: 'primary',
        onClick: async () => {
          syncInputsToDraft();
          if (!draft.name) {
            uiKit.showToast('请输入角色名称', 'warn');
            return false;
          }
          const charId = isEdit ? existingChar.id : `char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const nonInvMods = isEdit
            ? (existingChar.modifiers || []).filter((m) => !String(m.id || '').startsWith('inv_eq_'))
            : [];

          const targetLv = draft.stats.level;
          const targetExp = draft.stats.exp;
          const baseStatsForReg = { ...draft.stats };
          if (isEdit && targetLv !== originalLevel) {
            // Let setShipLevelManual compute clean growth delta from originalLevel -> targetLv
            baseStatsForReg.level = originalLevel;
            baseStatsForReg.maxExp = statRules.getShipMaxExp(originalLevel);
          }

          entities.register({
            id: charId,
            kind: 'character',
            name: draft.name,
            tags: [draft.shipType, draft.roleTag || '自定义'].filter(Boolean),
            stats: baseStatsForReg,
            statBounds: {
              hp: { min: 0, max: 999 },
              morale: { min: 0, max: 100 },
              ap: { min: 0, max: draft.stats.maxAp },
              affinity: { min: 0, max: 100 },
            },
            modifiers: nonInvMods,
            meta: {
              shipType: draft.shipType,
              roleTag: draft.roleTag || draft.shipType,
              avatarAssetId: draft.avatarAssetId,
              personality: draft.personality,
              speechHabit: draft.speechHabit,
            },
          });

          if (!isEdit) {
            await equipStarterCorePartsIfPresent(inventory, charId, false);
            if (targetLv > 1) {
              statRules.setShipLevelManual(entities, charId, targetLv, {
                exp: targetExp,
                inventory,
                applyGrowthDelta: true,
              });
            }
            const effMaxHp = Math.round(entities.getEffectiveStat(charId, 'maxHp', { round: 'round' }).final);
            entities.setStat(charId, 'hp', effMaxHp, { min: 0, max: effMaxHp });
          } else {
            if (targetLv !== originalLevel) {
              statRules.setShipLevelManual(entities, charId, targetLv, {
                exp: targetExp,
                inventory,
                applyGrowthDelta: true,
              });
            } else {
              inventory.syncCharacterModifiers(charId);
            }
          }

          consoleState.activeCharacterId = charId;
          consoleState.avatarUrlCache.clear();
          await saveRosterNow();

          const savedEntity = entities.get(charId);
          logs.add({
            category: LOG_CATEGORIES.CHARACTER,
            actorId: charId,
            actorName: draft.name,
            title: isEdit ? `更新角色「${draft.name}」资料 (Lv.${savedEntity.stats.level})` : `新建舰娘「${draft.name}」(${draft.shipType})`,
            detail: `Lv.${savedEntity.stats.level} · 八维：耐${savedEntity.stats.maxHp}/火${savedEntity.stats.firepower}/甲${savedEntity.stats.armor}/雷${savedEntity.stats.torpedo}/机${savedEntity.stats.evasion}/侦${savedEntity.stats.recon}/防${savedEntity.stats.aa}/潜${savedEntity.stats.asw}`,
          });
          bus.emit('character:saved', { characterId: charId, name: draft.name, isEdit });
          uiKit.showToast(
            isEdit
              ? `已保存角色：${draft.name}（Lv.${savedEntity.stats.level}）`
              : `已创建舰娘：${draft.name}（${draft.shipType} · Lv.${savedEntity.stats.level}）`,
            'ok'
          );
          await renderConsole();
          return true;
        },
      },
    ],
  });
}

function openItemEditorSheet(existingItem = null) {
  const { inventory, uiKit, logs } = consoleState.context;
  const isEdit = Boolean(existingItem);
  const standardKeys = new Set(BONUS_STAT_OPTIONS.map((o) => o.key));

  const draft = existingItem
    ? {
        name: existingItem.name,
        category: existingItem.category,
        tags: (existingItem.tags || []).join(', '),
        description: existingItem.description || '',
        quantity: existingItem.quantity ?? 1,
        bonuses: (existingItem.baseBonuses || existingItem.bonuses || []).map((b) => ({
          ...b,
          isCustomKey: !standardKeys.has(b.stat),
        })),
      }
    : {
        name: '',
        category: ITEM_CATEGORIES.EXTENSION,
        tags: '通用扩展',
        description: '',
        quantity: 1,
        bonuses: [
          { stat: 'firepower', layer: 'baseAdd', value: 10, isCustomKey: false },
          { stat: '夜战修正', layer: 'baseAdd', value: 6, isCustomKey: true },
        ],
      };

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const readBonusRows = () => {
    const rows = [];
    wrap.querySelectorAll('[data-bonus-row]').forEach((row) => {
      const selVal = row.querySelector('[data-b-stat]').value;
      const customInput = row.querySelector('[data-b-custom-stat]');
      const isCustom = selVal === '__custom__';
      const stat = isCustom ? String(customInput?.value || '').trim() : selVal;
      const layer = row.querySelector('[data-b-layer]').value;
      const val = Number(row.querySelector('[data-b-val]').value);
      if (stat && Number.isFinite(val)) {
        rows.push({ stat, layer, value: val, isCustomKey: isCustom || !standardKeys.has(stat) });
      }
    });
    draft.bonuses = rows;
  };

  const readMainFields = () => {
    const nameEl = wrap.querySelector('#cc-item-name');
    if (!nameEl) return;
    draft.name = nameEl.value.trim();
    draft.category = wrap.querySelector('#cc-item-cat').value;
    draft.tags = wrap.querySelector('#cc-item-tags').value;
    draft.description = wrap.querySelector('#cc-item-desc').value.trim();
    draft.quantity = Math.max(1, Math.floor(Number(wrap.querySelector('#cc-item-qty').value) || 1));
    readBonusRows();
  };

  const renderForm = () => {
    wrap.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="cc-item-name">物品 / 模块名称 *</label>
        <input id="cc-item-name" class="form-input" type="text" value="${escapeHtml(draft.name)}" placeholder="例如：高出力引擎 / 夜战观瞄模块 / 礼服">
      </div>

      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="cc-item-cat">物品分类</label>
          <select id="cc-item-cat" class="form-select">
            <option value="${ITEM_CATEGORIES.EXTENSION}" ${draft.category === ITEM_CATEGORIES.EXTENSION ? 'selected' : ''}>通用扩展装备（任意自定义槽位）</option>
            <option value="${ITEM_CATEGORIES.ENGINE}" ${draft.category === ITEM_CATEGORIES.ENGINE ? 'selected' : ''}>引擎部件（核心必装槽）</option>
            <option value="${ITEM_CATEGORIES.ARMOR}" ${draft.category === ITEM_CATEGORIES.ARMOR ? 'selected' : ''}>装甲部件（核心必装槽）</option>
            <option value="${ITEM_CATEGORIES.CORE}" ${draft.category === ITEM_CATEGORIES.CORE ? 'selected' : ''}>核心部件（核心必装槽）</option>
            <option value="${ITEM_CATEGORIES.OUTFIT}" ${draft.category === ITEM_CATEGORIES.OUTFIT ? 'selected' : ''}>服装（选装）</option>
            <option value="${ITEM_CATEGORIES.CONSUMABLE}" ${draft.category === ITEM_CATEGORIES.CONSUMABLE ? 'selected' : ''}>消耗品</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="cc-item-qty">数量</label>
          <input id="cc-item-qty" class="form-input" type="number" min="1" max="999" value="${draft.quantity}">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="cc-item-tags">标签（逗号分隔）</label>
        <input id="cc-item-tags" class="form-input" type="text" value="${escapeHtml(draft.tags)}" placeholder="例如：高出力, 通用扩展">
      </div>

      <div class="form-group">
        <label class="form-label" for="cc-item-desc">外观 / 效果描述</label>
        <textarea id="cc-item-desc" class="form-textarea" placeholder="填写部件说明或服装外观描述...">${escapeHtml(draft.description)}</textarea>
      </div>

      <div class="form-group">
        <span class="form-label">属性词条（支持标准八维或任意自定义动态属性名）</span>
        <div id="cc-bonus-list" class="lab-stack-sm">
          ${draft.bonuses
            .map((b, idx) => {
              const isCustom = b.isCustomKey || !standardKeys.has(b.stat);
              return `
              <div class="lab-stack-sm" style="padding:8px; border:1px solid var(--border); border-radius:10px;" data-bonus-row="${idx}">
                <div class="cc-bonus-row">
                  <select class="form-select" data-b-stat aria-label="目标属性">
                    ${BONUS_STAT_OPTIONS.map(
                      (o) => `<option value="${o.key}" ${!isCustom && b.stat === o.key ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
                    ).join('')}
                    <option value="__custom__" ${isCustom ? 'selected' : ''}>自定义动态属性…</option>
                  </select>
                  <select class="form-select" data-b-layer aria-label="词条类型">
                    <option value="baseAdd" ${b.layer === 'baseAdd' || !b.layer ? 'selected' : ''}>固定值</option>
                    <option value="percentAdd" ${b.layer === 'percentAdd' ? 'selected' : ''}>百分比</option>
                    <option value="flatFinal" ${b.layer === 'flatFinal' ? 'selected' : ''}>终值</option>
                  </select>
                  <input class="form-input" type="number" step="any" data-b-val value="${Number(b.value ?? 0)}" aria-label="词条数值">
                  <button type="button" class="btn-danger uikit-touch-target" data-remove-bonus="${idx}" style="padding:0 10px;">×</button>
                </div>
                ${
                  isCustom
                    ? `<input class="form-input" type="text" data-b-custom-stat value="${escapeHtml(isCustom && b.stat !== '__custom__' ? b.stat : '')}" placeholder="输入自定义属性名，如：夜战修正 / 电子干扰 / 航速">`
                    : ''
                }
              </div>
            `;
            })
            .join('')}
        </div>
        <div class="lab-btn-grid" style="margin-top:6px;">
          <button type="button" id="btn-cc-add-bonus" class="btn-secondary uikit-touch-target">+ 标准八维词条</button>
          <button type="button" id="btn-cc-add-custom-bonus" class="btn-secondary uikit-touch-target">+ 自定义动态属性</button>
        </div>
      </div>
    `;

    wrap.querySelectorAll('[data-b-stat]').forEach((sel, idx) => {
      sel.addEventListener('change', () => {
        const nextVal = sel.value;
        readMainFields();
        if (draft.bonuses[idx]) {
          draft.bonuses[idx].isCustomKey = nextVal === '__custom__';
          if (nextVal === '__custom__' && standardKeys.has(draft.bonuses[idx].stat)) {
            draft.bonuses[idx].stat = '自定义属性';
          }
        }
        renderForm();
      });
    });

    wrap.querySelector('#btn-cc-add-bonus').addEventListener('click', () => {
      readMainFields();
      draft.bonuses.push({ stat: 'aa', layer: 'baseAdd', value: 8, isCustomKey: false });
      renderForm();
    });

    wrap.querySelector('#btn-cc-add-custom-bonus').addEventListener('click', () => {
      readMainFields();
      draft.bonuses.push({ stat: '夜战修正', layer: 'baseAdd', value: 6, isCustomKey: true });
      renderForm();
    });

    wrap.querySelectorAll('[data-remove-bonus]').forEach((btn) => {
      btn.addEventListener('click', () => {
        readMainFields();
        const idx = Number(btn.getAttribute('data-remove-bonus'));
        draft.bonuses.splice(idx, 1);
        renderForm();
      });
    });
  };

  renderForm();

  uiKit.openBottomSheet({
    title: isEdit ? `编辑词条与资料 · ${existingItem.name}` : '新建核心部件 / 扩展模块 / 服装',
    subtitle: '通用扩展模块装入自定义槽位后，附带的新增属性将自动动态显示在角色卡面板上',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: isEdit ? '保存并重算' : '加入仓库',
        tone: 'primary',
        onClick: async () => {
          readMainFields();
          if (!draft.name) {
            uiKit.showToast('请输入物品名称', 'warn');
            return false;
          }
          const cleanPayload = {
            ...draft,
            bonuses: draft.bonuses.map(({ stat, layer, value }) => ({ stat, layer, value })),
          };
          if (isEdit) {
            await inventory.updateItem(existingItem.id, cleanPayload);
            logs.add({
              category: LOG_CATEGORIES.EQUIPMENT,
              title: `调整物品词条「${draft.name}」`,
              detail: cleanPayload.bonuses.map(formatBonusChip).join('、') || '无词条',
            });
            uiKit.showToast(`已更新「${draft.name}」并实时重算属性`, 'ok');
          } else {
            await inventory.createItem(cleanPayload);
            logs.add({
              category: LOG_CATEGORIES.EQUIPMENT,
              title: `新建${ITEM_CATEGORY_LABELS[draft.category]}「${draft.name}」`,
              detail: cleanPayload.bonuses.map(formatBonusChip).join('、') || '无词条',
            });
            uiKit.showToast(`已新建入库：${draft.name}`, 'ok');
          }
          await saveRosterNow();
          await renderConsole();
          return true;
        },
      },
    ],
  });
}

function openStatRulesSheet() {
  const { statRules, uiKit } = consoleState.context;
  const cfg = statRules.getConfig();

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <p class="muted-text">所有系数实时生效并持久化，立即作用于五维检定修正、士气判定、大成功/大失败阈值与离线自动恢复。</p>
    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="rule-step">每 N 点属性 +1 修正</label>
        <input id="rule-step" class="form-input" type="number" min="1" max="50" value="${cfg.statModifierStep}">
      </div>
      <div class="form-group">
        <label class="form-label" for="rule-crit-margin">超额大成/大败差值</label>
        <input id="rule-crit-margin" class="form-input" type="number" min="3" max="50" value="${cfg.critMarginThreshold}">
      </div>
      <div class="form-group">
        <label class="form-label" for="rule-crit-nat">自然大成功点数</label>
        <input id="rule-crit-nat" class="form-input" type="number" min="2" max="20" value="${cfg.critSuccessNatural}">
      </div>
      <div class="form-group">
        <label class="form-label" for="rule-fail-nat">自然大失败点数</label>
        <input id="rule-fail-nat" class="form-input" type="number" min="1" max="10" value="${cfg.critFailNatural}">
      </div>
      <div class="form-group">
        <label class="form-label" for="rule-morale-hi">高士气加成 (≥${cfg.moraleHighThreshold})</label>
        <input id="rule-morale-hi" class="form-input" type="number" min="0" max="10" value="${cfg.moraleHighBonus}">
      </div>
      <div class="form-group">
        <label class="form-label" for="rule-morale-lo">疲惫士气惩罚 (<${cfg.moraleLowThreshold})</label>
        <input id="rule-morale-lo" class="form-input" type="number" min="-10" max="0" value="${cfg.moraleCriticalPenalty}">
      </div>
    </div>
    <div class="lab-kv-grid-3">
      <div class="form-group">
        <label class="form-label" for="rule-rec-hp">HP/分恢复</label>
        <input id="rule-rec-hp" class="form-input" type="number" step="0.1" min="0" value="${cfg.offlineRecoveryPerMin.hp}">
      </div>
      <div class="form-group">
        <label class="form-label" for="rule-rec-morale">士气/分恢复</label>
        <input id="rule-rec-morale" class="form-input" type="number" step="0.1" min="0" value="${cfg.offlineRecoveryPerMin.morale}">
      </div>
      <div class="form-group">
        <label class="form-label" for="rule-rec-ap">AP/分恢复</label>
        <input id="rule-rec-ap" class="form-input" type="number" step="0.1" min="0" value="${cfg.offlineRecoveryPerMin.ap}">
      </div>
    </div>

    <div class="lab-divider"></div>
    <strong style="font-size:13px;">舰娘等级经验曲线与每级白值成长（可配置）</strong>
    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="rule-exp-base">Lv.1 升级基础经验</label>
        <input id="rule-exp-base" class="form-input" type="number" min="10" max="5000" value="${cfg.shipExpBase}">
      </div>
      <div class="form-group">
        <label class="form-label" for="rule-exp-step">每级递增经验步长</label>
        <input id="rule-exp-step" class="form-input" type="number" min="0" max="2000" value="${cfg.shipExpStep}">
      </div>
    </div>
    <div class="lab-kv-grid">
      ${NAVAL_EIGHT_STAT_DEFS.map(
        (d) => `
        <div class="form-group">
          <label class="form-label" for="rule-grow-${d.key}">每级 ${escapeHtml(d.label)} +</label>
          <input id="rule-grow-${d.key}" class="form-input" type="number" min="0" max="30" step="1" value="${Number(cfg.shipGrowthPerLevel?.[d.key] ?? 1)}">
        </div>
      `
      ).join('')}
    </div>
  `;

  uiKit.openBottomSheet({
    title: '数值规则设置',
    subtitle: '通用 1D20 检定公式、离线恢复与舰娘升级成长曲线参数',
    content: wrap,
    actions: [
      {
        id: 'reset',
        label: '恢复默认',
        tone: 'secondary',
        onClick: async () => {
          statRules.resetConfig();
          uiKit.showToast('已恢复默认数值规则系数', 'ok');
          await renderConsole();
        },
      },
      {
        id: 'save',
        label: '保存规则',
        tone: 'primary',
        onClick: async () => {
          const shipGrowthPerLevel = {};
          for (const d of NAVAL_EIGHT_STAT_DEFS) {
            shipGrowthPerLevel[d.key] = Number(wrap.querySelector(`#rule-grow-${d.key}`).value);
          }
          statRules.updateConfig({
            statModifierStep: Number(wrap.querySelector('#rule-step').value),
            critMarginThreshold: Number(wrap.querySelector('#rule-crit-margin').value),
            critSuccessNatural: Number(wrap.querySelector('#rule-crit-nat').value),
            critFailNatural: Number(wrap.querySelector('#rule-fail-nat').value),
            moraleHighBonus: Number(wrap.querySelector('#rule-morale-hi').value),
            moraleCriticalPenalty: Number(wrap.querySelector('#rule-morale-lo').value),
            offlineRecoveryPerMin: {
              hp: Number(wrap.querySelector('#rule-rec-hp').value),
              morale: Number(wrap.querySelector('#rule-rec-morale').value),
              ap: Number(wrap.querySelector('#rule-rec-ap').value),
            },
            shipExpBase: Number(wrap.querySelector('#rule-exp-base').value),
            shipExpStep: Number(wrap.querySelector('#rule-exp-step').value),
            shipGrowthPerLevel,
          });
          uiKit.showToast('数值规则与舰娘成长曲线已更新并保存', 'ok');
          await renderConsole();
        },
      },
    ],
  });
}

function openCheckSimulatorSheet(char) {
  if (!char) return;
  const { entities, inventory, statRules, commander, uiKit } = consoleState.context;
  let selectedStat = 'firepower';
  let dcValue = 15;
  let extraMod = 0;
  let lastResult = null;

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const renderSim = () => {
    const baseVal = Number(char.stats[selectedStat] ?? 50);
    const effVal = entities.getEffectiveStat(char.id, selectedStat, { round: 'round' }).final;
    const eqBonuses = inventory.getCharacterEquipmentBonuses(char.id);
    const moraleVal = Number(char.stats.morale ?? 50);
    const statDef = CORE_STAT_MAP[selectedStat];

    wrap.innerHTML = `
      <div class="form-group">
        <span class="form-label">选择检定属性（当前角色：${escapeHtml(char.name)}）</span>
        <div class="chip-row" id="cc-sim-stat-chips">
          ${CORE_STAT_DEFS.map(
            (d) => `
            <button type="button" class="preset-chip ${selectedStat === d.key ? 'is-active' : ''}"
              style="${selectedStat === d.key ? 'border-color:var(--accent);color:var(--text-primary);background:var(--accent-soft);' : ''}"
              data-sim-stat="${d.key}">${escapeHtml(d.shortLabel)} (${entities.getEffectiveStat(char.id, d.key, { round: 'round' }).final})</button>
          `
          ).join('')}
        </div>
      </div>

      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="cc-sim-dc">难度阈值 (DC)</label>
          <input id="cc-sim-dc" class="form-input" type="number" min="1" max="50" value="${dcValue}">
        </div>
        <div class="form-group">
          <label class="form-label" for="cc-sim-extra">额外修正</label>
          <input id="cc-sim-extra" class="form-input" type="number" min="-20" max="20" value="${extraMod}">
        </div>
      </div>

      <div class="chip-row">
        <button type="button" class="preset-chip" data-sim-dc="10">简单 DC 10</button>
        <button type="button" class="preset-chip" data-sim-dc="15">普通 DC 15</button>
        <button type="button" class="preset-chip" data-sim-dc="20">困难 DC 20</button>
        <button type="button" class="preset-chip" data-sim-dc="25">极难 DC 25</button>
      </div>

      <p class="muted-text">
        预览：<code>1D20 + ${escapeHtml(statDef.label)}修正(${formatSigned(statRules.getStatModifier(effVal))}) + 部件/装备检定词条(${formatSigned(eqBonuses.checkBonus)}) + 士气(${formatSigned(statRules.getMoraleModifier(moraleVal))})</code> vs DC ${dcValue}
      </p>

      <button type="button" id="btn-cc-run-check" class="btn-primary uikit-touch-target">执行 1D20 实时模拟检定</button>

      ${
        lastResult
          ? `
        <div class="cc-check-result outcome-${escapeHtml(lastResult.outcome)}" id="cc-check-result-box">
          <div class="cc-check-headline">
            <span class="cc-check-outcome" id="cc-check-outcome-label">${escapeHtml(lastResult.outcomeLabel)}</span>
            <span class="cc-check-score">${lastResult.total} / DC ${lastResult.dc}（${formatSigned(lastResult.margin)}）</span>
          </div>
          <div class="cc-check-steps">
            ${lastResult.steps
              .map(
                (st) => `
              <div class="cc-check-step">
                <span>${escapeHtml(st.label)}</span>
                <strong>${escapeHtml(st.text)}</strong>
              </div>
            `
              )
              .join('')}
          </div>
          <div class="muted-text" style="font-family:var(--font-mono);font-size:11.5px;">${escapeHtml(lastResult.formulaText)}</div>
        </div>
      `
          : ''
      }
    `;

    wrap.querySelectorAll('[data-sim-stat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedStat = btn.getAttribute('data-sim-stat');
        renderSim();
      });
    });

    wrap.querySelector('#cc-sim-dc').addEventListener('input', (e) => {
      dcValue = clamp(Number(e.target.value) || 15, 1, 50);
    });

    wrap.querySelector('#cc-sim-extra').addEventListener('input', (e) => {
      extraMod = clamp(Number(e.target.value) || 0, -20, 20);
    });

    wrap.querySelectorAll('[data-sim-dc]').forEach((btn) => {
      btn.addEventListener('click', () => {
        dcValue = Number(btn.getAttribute('data-sim-dc'));
        renderSim();
      });
    });

    wrap.querySelector('#btn-cc-run-check').addEventListener('click', async () => {
      dcValue = clamp(Number(wrap.querySelector('#cc-sim-dc').value) || 15, 1, 50);
      extraMod = clamp(Number(wrap.querySelector('#cc-sim-extra').value) || 0, -20, 20);
      lastResult = statRules.performCheck({
        actorId: char.id,
        actorName: char.name,
        statKey: selectedStat,
        baseStatValue: baseVal,
        effectiveStatValue: effVal,
        equipmentCheckBonus: eqBonuses.checkBonus,
        moraleValue: moraleVal,
        dc: dcValue,
        extraModifier: extraMod,
      });
      uiKit.showToast(
        `${statDef.label}检定：${lastResult.outcomeLabel}（${lastResult.total} vs DC ${lastResult.dc}）`,
        lastResult.outcome === 'crit-success' || lastResult.outcome === 'success' ? 'ok' : 'warn'
      );
      renderSim();
      if (consoleState.activeTab === 'logs') {
        await renderConsole();
      }
    });
  };

  renderSim();
  uiKit.openBottomSheet({
    title: '实时模拟检定（1D20）',
    subtitle: '自动计入当前角色属性、核心部件与自定义槽位加成、士气修正',
    content: wrap,
    actions: [{ id: 'close', label: '关闭', tone: 'secondary' }],
  });
}

function openAddResourceSheet() {
  const { resources, uiKit } = consoleState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="cc-res-name">自定义资源名称 *</label>
      <input id="cc-res-name" class="form-input" type="text" placeholder="例如：开发图纸 / 凭证">
    </div>
    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="cc-res-unit">单位</label>
        <input id="cc-res-unit" class="form-input" type="text" placeholder="例如：张 / 个">
      </div>
      <div class="form-group">
        <label class="form-label" for="cc-res-amt">初始数量</label>
        <input id="cc-res-amt" class="form-input" type="number" min="0" value="50">
      </div>
    </div>
  `;

  uiKit.openBottomSheet({
    title: '新增自定义资源条目',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'create',
        label: '确认新增',
        tone: 'primary',
        onClick: async () => {
          const name = wrap.querySelector('#cc-res-name').value.trim();
          const unit = wrap.querySelector('#cc-res-unit').value.trim();
          const amount = Number(wrap.querySelector('#cc-res-amt').value) || 0;
          if (!name) {
            uiKit.showToast('请输入资源名称', 'warn');
            return false;
          }
          await resources.defineResource({ name, unit, amount, group: 'resource', autoRecover: false });
          uiKit.showToast(`已新增资源：${name}`, 'ok');
          await renderConsole();
          return true;
        },
      },
    ],
  });
}

function openLogExportSheet() {
  const { logs, uiKit } = consoleState.context;
  const summaryText = logs.exportTextSummary({
    category: consoleState.logCategoryFilter === 'all' ? null : consoleState.logCategoryFilter,
    limit: 50,
  });

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <p class="muted-text">以下纯文本摘要可直接复制或注入后续叙事模块作为上下文依据：</p>
    <pre class="code-block" id="cc-log-export-preview" style="max-height:280px;">${escapeHtml(summaryText)}</pre>
  `;

  uiKit.openBottomSheet({
    title: '行动日志文本摘要',
    content: wrap,
    actions: [
      {
        id: 'copy',
        label: '复制摘要',
        tone: 'secondary',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(summaryText);
            uiKit.showToast('已复制到剪贴板', 'ok');
          } catch {
            uiKit.showToast('当前环境不支持自动剪贴板，请长按文本复制', 'warn');
          }
          return false;
        },
      },
      {
        id: 'download',
        label: '下载 .txt',
        tone: 'primary',
        onClick: () => {
          const blob = new Blob([summaryText], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `action-logs-${new Date().toISOString().slice(0, 10)}.txt`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          uiKit.showToast('已导出行动日志摘要文件', 'ok');
        },
      },
    ],
  });
}

// ============================================================
// Reusable Character Slots Section Renderer
// ============================================================

function createSlotsSection(char, { compact = false } = {}) {
  const { inventory, uiKit } = consoleState.context;
  const slots = inventory.getCharacterSlots(char.id);
  const equippedMap = inventory.getCharacterEquipment(char.id);
  const seaworthyInfo = inventory.checkSeaworthiness(char.id);

  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm';
  card.id = compact ? 'cc-overview-slots-card' : 'cc-slots-card';

  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">核心槽位与自由扩展槽位</h2>
      <button type="button" id="${compact ? 'btn-cc-add-custom-slot-ov' : 'btn-cc-add-custom-slot'}" class="btn-primary uikit-touch-target" style="padding:6px 12px;font-size:12.5px;">+ 添加自定义槽位</button>
    </div>
    <p class="muted-text" style="font-size:12px;">
      「引擎 / 装甲 / 核心」为固定必装槽（${seaworthyInfo.seaworthy ? '已适航' : '未适航，缺少必装项'}）；自定义槽位完全自由命名、不限扩展装备类型，留空依然适航。
    </p>
    <div class="lab-stack-sm" data-slots-list></div>
  `;

  card
    .querySelector(compact ? '#btn-cc-add-custom-slot-ov' : '#btn-cc-add-custom-slot')
    .addEventListener('click', () => openAddCustomSlotSheet(char));

  const listEl = card.querySelector('[data-slots-list]');
  for (const s of slots) {
    const item = equippedMap[s.id];
    const isMissingCore = s.required && !item;
    const row = document.createElement('div');
    row.className = `cc-slot-card ${isMissingCore ? 'is-missing-core' : ''}`;
    row.dataset.equipSlot = s.id;
    row.dataset.slotCustom = s.custom ? 'true' : 'false';

    const tagHtml = s.required
      ? `<span class="status-badge ${item ? 'badge-ok' : 'badge-danger'}">必装核心</span>`
      : s.custom
      ? '<span class="status-badge badge-muted">自定义选装</span>'
      : '<span class="status-badge badge-muted">选装</span>';

    row.innerHTML = `
      <div class="cc-slot-card-top">
        <div class="cc-slot-info">
          <div class="cc-badge-row">
            <span class="cc-slot-item-name">${escapeHtml(s.label)}</span>
            ${tagHtml}
          </div>
          <span class="cc-slot-label">${item ? `已装：${escapeHtml(formatItemTitle(item))}` : isMissingCore ? '未装入（影响适航状态）' : '留空（不影响适航）'}</span>
          ${
            item && item.bonuses?.length
              ? `<span class="cc-stat-sub">${escapeHtml(item.bonuses.map(formatBonusChip).join(' · '))}</span>`
              : ''
          }
        </div>
      </div>
      <div class="cc-slot-btn-row">
        <button type="button" class="btn-secondary" data-slot-act="pick">${item ? '更换' : '装入'}</button>
        ${item ? '<button type="button" class="btn-danger" data-slot-act="unequip">卸下</button>' : ''}
        ${s.custom ? '<button type="button" class="btn-secondary" data-slot-act="rename">重命名</button>' : ''}
        ${s.custom ? '<button type="button" class="btn-danger" data-slot-act="remove-slot">删槽</button>' : ''}
      </div>
    `;

    row.querySelector('[data-slot-act="pick"]').addEventListener('click', () => openSlotEquipPickerSheet(char, s));

    const unequipBtn = row.querySelector('[data-slot-act="unequip"]');
    if (unequipBtn) {
      unequipBtn.addEventListener('click', async () => {
        await inventory.unequipSlot(char.id, s.id);
        await saveRosterNow();
        const check = inventory.checkSeaworthiness(char.id);
        uiKit.showToast(
          check.seaworthy ? `已从「${s.label}」卸下「${item.name}」` : `已卸下「${item.name}」：角色当前未适航`,
          check.seaworthy ? 'ok' : 'warn'
        );
        await renderConsole();
      });
    }

    const renameBtn = row.querySelector('[data-slot-act="rename"]');
    if (renameBtn) {
      renameBtn.addEventListener('click', () => openRenameCustomSlotSheet(char, s));
    }

    const removeSlotBtn = row.querySelector('[data-slot-act="remove-slot"]');
    if (removeSlotBtn) {
      removeSlotBtn.addEventListener('click', async () => {
        const ok = await uiKit.confirmDialog({
          title: `删除自定义槽位「${s.label}」`,
          message: '确认删除此自定义槽位吗？若已装入扩展装备将自动退回仓库并重算属性。',
          confirmLabel: '确认删除',
          tone: 'danger',
        });
        if (!ok) return;
        await inventory.removeCharacterCustomSlot(char.id, s.id);
        await saveRosterNow();
        uiKit.showToast(`已删除自定义槽位：${s.label}`, 'ok');
        await renderConsole();
      });
    }

    listEl.appendChild(row);
  }

  return card;
}

// ============================================================
// Sub-Tab Renderers
// ============================================================

function renderOverviewTab(host, char) {
  const { entities, inventory, statRules, resources, commander, uiKit, logs } = consoleState.context;
  const breakdown = inventory.getCharacterStatBreakdown(char.id);
  const coreAmpPct = Math.round((breakdown.coreAmplifier - 1) * 100);
  const affThresholdRed = commander ? commander.getAffinityThresholdReduction() : 0;
  const affGainMult = commander ? commander.getAffinityGainMultiplier() : 1.0;

  // 1. Naval 8-Stat Panel (strictly separating Base 白值 vs Equipment/Module Bonus 装备加成)
  const statCard = document.createElement('section');
  statCard.className = 'surface-card lab-stack-sm';
  statCard.id = 'cc-naval-stats-card';
  statCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">海战八维属性（白值 + 装备/模块加成）</h2>
      <span class="status-badge badge-ok" id="cc-equip-check-badge">装备检定 ${formatSigned(breakdown.checkBonus)}</span>
    </div>
    ${
      coreAmpPct > 0
        ? `<p class="muted-text" style="font-size:12px;">指挥官「整备」生效中：引擎/装甲/核心三核心部件效能 +${coreAmpPct}%</p>`
        : ''
    }
    <div class="cc-stat-grid" id="cc-stat-grid">
      ${breakdown.standardStats
        .map((st) => {
          const isVital = st.key === 'maxHp';
          const mod = isVital ? null : statRules.getStatModifier(st.total);
          return `
          <div class="cc-stat-tile" data-stat-tile="${st.key}">
            <div class="cc-stat-tile-top">
              <span class="cc-stat-name">${escapeHtml(st.label)}</span>
              ${
                isVital
                  ? '<span class="status-badge badge-muted">生存上限</span>'
                  : `<span class="status-badge badge-muted">检定 ${formatSigned(mod)}</span>`
              }
            </div>
            <div class="cc-stat-val-row">
              <span class="cc-stat-final" data-stat-final="${st.key}">${st.total}</span>
              ${
                st.bonus !== 0
                  ? `<span class="cc-stat-delta ${st.bonus < 0 ? 'is-neg' : ''}" data-stat-delta="${st.key}">${formatSigned(st.bonus)}</span>`
                  : ''
              }
            </div>
            <span class="cc-stat-sub">白值 ${st.base}${st.bonus !== 0 ? ` · 模块 ${formatSigned(st.bonus)}` : ' · 无加成'}</span>
          </div>
        `;
        })
        .join('')}
    </div>
  `;
  host.appendChild(statCard);

  // 1B. Dynamic Module-Extended Attributes Panel (automatically expands from equipped modules/custom slots)
  const dynCard = document.createElement('section');
  dynCard.className = 'surface-card lab-stack-sm';
  dynCard.id = 'cc-dynamic-stats-card';
  dynCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">动态模块扩展属性（随自定义槽位自动扩展）</h2>
      <span class="status-badge ${breakdown.dynamicStats.length > 0 ? 'badge-ok' : 'badge-muted'}" id="cc-dynamic-stats-count">
        ${breakdown.dynamicStats.length} 项扩展
      </span>
    </div>
    ${
      breakdown.dynamicStats.length > 0
        ? `
      <div class="cc-stat-grid" id="cc-dynamic-stats-grid">
        ${breakdown.dynamicStats
          .map(
            (ds) => `
          <div class="cc-stat-tile is-dynamic" data-dynamic-stat="${escapeHtml(ds.key)}">
            <div class="cc-stat-tile-top">
              <span class="cc-stat-name">${escapeHtml(ds.label)}</span>
              <span class="status-badge badge-ok">模块扩展</span>
            </div>
            <div class="cc-stat-val-row">
              <span class="cc-stat-final">${ds.total}</span>
              <span class="cc-stat-delta">${formatSigned(ds.bonus)}</span>
            </div>
            <span class="cc-stat-sub">白值 ${ds.base} · 来源：${escapeHtml((ds.sources || []).join('、') || '自定义模块')}</span>
          </div>
        `
          )
          .join('')}
      </div>
    `
        : '<p class="muted-text" style="font-size:12.5px;">当前未装备带自定义扩展词条的模块。在「背包与装备」新建/编辑带自定义属性名的模块并装入自定义槽位后，此处将自动扩展显示。</p>'
    }
  `;
  host.appendChild(dynCard);

  // 2. Direct Core & Custom Slots Builder right on Character Overview Card
  host.appendChild(createSlotsSection(char, { compact: true }));

  // 3. Character Persona & Quick Status Adjust
  const personaCard = document.createElement('section');
  personaCard.className = 'surface-card lab-stack-sm';
  const affStage = statRules.getAffinityStage(char.stats.affinity ?? 0, { thresholdReduction: affThresholdRed });
  const interactProfile = commander ? commander.getInteractionProfile() : null;
  personaCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">舰娘设定与状态微调</h2>
      <span class="status-badge badge-ok">好感 ${affStage.label} (${affStage.value}/100)</span>
    </div>
    <p class="muted-text"><strong>舰种 / 定位：</strong>${escapeHtml(char.meta?.shipType || '驱逐舰')} · ${escapeHtml(char.meta?.roleTag || '通用型')}</p>
    <p class="muted-text"><strong>性格设定：</strong>${escapeHtml(char.meta?.personality || '未填写性格设定')}</p>
    <p class="muted-text"><strong>对话口癖：</strong>${escapeHtml(char.meta?.speechHabit || '未填写对话口癖')}</p>
    ${
      interactProfile
        ? `<p class="muted-text" style="font-size:12px;"><strong>魅力互动倾向：</strong>${escapeHtml(interactProfile.toneLabel)}（解锁：${escapeHtml(interactProfile.unlockedOptions.join(' / '))}）</p>`
        : ''
    }
    <div class="lab-divider"></div>
    <div class="cc-btn-3col">
      <button type="button" id="btn-cc-aff-inc" class="btn-secondary uikit-touch-target">好感 +${Math.round(5 * affGainMult)}</button>
      <button type="button" id="btn-cc-morale-inc" class="btn-secondary uikit-touch-target">士气 +10</button>
      <button type="button" id="btn-cc-ap-dec" class="btn-secondary uikit-touch-target">消耗 15 AP</button>
    </div>
    <div class="lab-btn-grid">
      <button type="button" id="btn-cc-offline-sim" class="btn-secondary uikit-touch-target">离线恢复 +30分</button>
      <button type="button" id="btn-cc-del-char" class="btn-danger uikit-touch-target" ${getCharacters().length <= 1 ? 'disabled' : ''}>删除当前角色</button>
    </div>
  `;

  personaCard.querySelector('#btn-cc-aff-inc').addEventListener('click', async () => {
    const delta = Math.max(1, Math.round(5 * affGainMult));
    const after = entities.adjustStat(char.id, 'affinity', delta, { min: 0, max: 100 });
    await saveRosterNow();
    const st = statRules.getAffinityStage(after, { thresholdReduction: affThresholdRed });
    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char.id,
      actorName: char.name,
      title: `[${char.name}] 好感度 +${delta}`,
      detail: `当前好感度 ${after}/100（阶段：${st.label}）`,
    });
    uiKit.showToast(`好感度提升至 ${after}（${st.label}）`, 'ok');
    await renderConsole();
  });

  personaCard.querySelector('#btn-cc-morale-inc').addEventListener('click', async () => {
    const after = entities.adjustStat(char.id, 'morale', 10, { min: 0, max: 100 });
    await saveRosterNow();
    uiKit.showToast(`士气恢复至 ${after}（修正 ${formatSigned(statRules.getMoraleModifier(after))}）`, 'ok');
    await renderConsole();
  });

  personaCard.querySelector('#btn-cc-ap-dec').addEventListener('click', async () => {
    const after = entities.adjustStat(char.id, 'ap', -15, { min: 0, max: char.stats.maxAp ?? 100 });
    await saveRosterNow();
    uiKit.showToast(`行动点 AP 剩余 ${after}`, 'info');
    await renderConsole();
  });

  personaCard.querySelector('#btn-cc-offline-sim').addEventListener('click', async () => {
    const now = Date.now();
    const rules = statRules.buildOfflineRecoveryRules(getCharacters());
    entities.settleOfflineTime({
      lastTimestamp: now - 30 * 60 * 1000,
      now,
      rules,
    });
    await resources.settleOfflineResources({ lastTimestamp: now - 30 * 60 * 1000, now });
    await saveRosterNow();
    uiKit.showToast('已模拟离线恢复 30 分钟（含角色状态与基础四项资源）', 'ok');
    await renderConsole();
  });

  personaCard.querySelector('#btn-cc-del-char').addEventListener('click', async () => {
    if (getCharacters().length <= 1) return;
    const ok = await uiKit.confirmDialog({
      title: `删除角色「${char.name}」`,
      message: '确认删除该角色吗？其已装入的部件与装备将保留在全局仓库中。',
      confirmLabel: '确认删除',
      tone: 'danger',
    });
    if (!ok) return;
    const removedName = char.name;
    const removedId = char.id;
    await inventory.removeCharacterEquipment(removedId);
    entities.remove(removedId);
    const remaining = getCharacters();
    consoleState.activeCharacterId = remaining[0]?.id || null;
    await saveRosterNow();
    logs.add({
      category: LOG_CATEGORIES.CHARACTER,
      title: `删除角色「${removedName}」`,
      detail: `剩余角色 ${remaining.length} 名`,
    });
    consoleState.context.bus.emit('character:deleted', { characterId: removedId, name: removedName });
    uiKit.showToast(`已删除角色：${removedName}`, 'ok');
    await renderConsole();
  });

  host.appendChild(personaCard);
}

function renderEquipmentTab(host, char) {
  const { inventory, uiKit } = consoleState.context;

  // Card 1: Full Slot Manager (Core 3 + Outfit + Freeform Custom)
  host.appendChild(createSlotsSection(char, { compact: false }));

  // Card 2: Global Item Warehouse
  const items = inventory.listItems({
    category: consoleState.itemCategoryFilter === 'all' ? null : consoleState.itemCategoryFilter,
  });

  const warehouseCard = document.createElement('section');
  warehouseCard.className = 'surface-card lab-stack-sm';
  warehouseCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">全局仓库（${items.length}）</h2>
      <button type="button" id="btn-cc-new-item" class="btn-primary uikit-touch-target" style="padding:6px 12px;font-size:12.5px;">+ 新建装备/部件</button>
    </div>
    <div class="chip-row" id="cc-item-filters">
      ${[
        { id: 'all', label: '全部' },
        { id: ITEM_CATEGORIES.ENGINE, label: '引擎' },
        { id: ITEM_CATEGORIES.ARMOR, label: '装甲' },
        { id: ITEM_CATEGORIES.CORE, label: '核心' },
        { id: ITEM_CATEGORIES.EXTENSION, label: '通用扩展' },
        { id: ITEM_CATEGORIES.OUTFIT, label: '服装' },
        { id: ITEM_CATEGORIES.CONSUMABLE, label: '消耗品' },
      ]
        .map(
          (f) => `
        <button type="button" class="preset-chip" data-item-filter="${f.id}"
          style="${consoleState.itemCategoryFilter === f.id ? 'border-color:var(--accent);color:var(--text-primary);background:var(--accent-soft);' : ''}">
          ${escapeHtml(f.label)}
        </button>
      `
        )
        .join('')}
    </div>
    <div class="lab-stack-sm" id="cc-warehouse-list"></div>
  `;

  warehouseCard.querySelector('#btn-cc-new-item').addEventListener('click', () => openItemEditorSheet(null));
  warehouseCard.querySelectorAll('[data-item-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      consoleState.itemCategoryFilter = btn.getAttribute('data-item-filter');
      renderConsole();
    });
  });

  const listEl = warehouseCard.querySelector('#cc-warehouse-list');
  if (items.length === 0) {
    listEl.innerHTML = '<p class="muted-text">当前分类暂无物品，可新建物品或前往「物资与工坊台」获取。</p>';
  } else {
    for (const item of items) {
      const equippedSlotId = inventory.getEquippedSlotOfItem(char.id, item.id);
      const isEquipped = Boolean(equippedSlotId);
      const isConsumable = item.category === ITEM_CATEGORIES.CONSUMABLE;
      const equippedSlotObj = equippedSlotId ? inventory.getCharacterSlot(char.id, equippedSlotId) : null;

      const card = document.createElement('div');
      card.className = `cc-item-card ${isEquipped ? 'is-equipped' : ''}`;
      card.dataset.itemId = item.id;
      card.innerHTML = `
        <div class="cc-item-head">
          <div style="min-width:0;">
            <strong>${escapeHtml(formatItemTitle(item))}</strong>
            <div class="cc-badge-row" style="margin-top:4px;">
              <span class="status-badge badge-muted">${escapeHtml(ITEM_CATEGORY_LABELS[item.category] || item.category)}</span>
              ${isConsumable ? `<span class="status-badge badge-warn">库存 ×${item.quantity}</span>` : ''}
              ${isEquipped ? `<span class="status-badge badge-ok">已装：${escapeHtml(equippedSlotObj?.label || equippedSlotId)}</span>` : ''}
            </div>
          </div>
        </div>
        ${item.description ? `<p class="muted-text" style="font-size:12.5px;">${escapeHtml(item.description)}</p>` : ''}
        <div class="ns-chip-list">
          ${
            (item.bonuses || []).length > 0
              ? item.bonuses.map((b) => `<span class="ns-chip">${escapeHtml(formatBonusChip(b))}</span>`).join('')
              : '<span class="muted-text" style="font-size:11.5px;">无属性词条</span>'
          }
        </div>
        <div class="cc-item-actions">
          <button type="button" class="${isEquipped ? 'btn-secondary' : 'btn-primary'}" data-act="primary" ${isConsumable && item.quantity <= 0 ? 'disabled' : ''}>
            ${isConsumable ? '使用消耗品' : isEquipped ? '卸下部件' : '一键装入'}
          </button>
          <button type="button" class="btn-secondary" data-act="edit">调词条</button>
          <button type="button" class="btn-danger" data-act="delete">删除</button>
        </div>
      `;

      card.querySelector('[data-act="primary"]').addEventListener('click', async () => {
        try {
          if (isConsumable) {
            await inventory.useConsumable(char.id, item.id);
            await saveRosterNow();
            uiKit.showToast(`已对 ${char.name} 使用「${item.name}」`, 'ok');
          } else if (isEquipped) {
            await inventory.unequipSlot(char.id, equippedSlotId);
            await saveRosterNow();
            uiKit.showToast(`已卸下「${item.name}」`, 'ok');
          } else {
            const res = await inventory.equipItem(char.id, null, item.id);
            await saveRosterNow();
            uiKit.showToast(`已为 ${char.name} 装入「${item.name}」（${res.slotLabel}）`, 'ok');
          }
          await renderConsole();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '操作失败', 'error');
        }
      });

      card.querySelector('[data-act="edit"]').addEventListener('click', () => openItemEditorSheet(item));

      card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        const ok = await uiKit.confirmDialog({
          title: `删除物品「${item.name}」`,
          message: '确认从仓库永久删除该物品吗？若角色正在穿戴，将自动卸下并重算属性。',
          confirmLabel: '确认删除',
          tone: 'danger',
        });
        if (!ok) return;
        await inventory.deleteItem(item.id);
        await saveRosterNow();
        uiKit.showToast(`已删除物品：${item.name}`, 'ok');
        await renderConsole();
      });

      listEl.appendChild(card);
    }
  }

  host.appendChild(warehouseCard);
}

function renderResourcesTab(host) {
  const { resources, uiKit } = consoleState.context;
  const list = resources.list();

  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm';
  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">六项专用资源与双货币</h2>
      <button type="button" id="btn-cc-add-res" class="btn-primary uikit-touch-target" style="padding:6px 12px;font-size:12.5px;">+ 新增条目</button>
    </div>
    <p class="muted-text">四项基础资源（燃油/弹药/钢材/铝材）随离线时间自动恢复至仓储上限；银条与金条不随时间自然恢复。</p>
    <div class="lab-stack-sm" id="cc-res-list"></div>
  `;

  card.querySelector('#btn-cc-add-res').addEventListener('click', () => openAddResourceSheet());

  const listEl = card.querySelector('#cc-res-list');
  for (const r of list) {
    const isCore = CORE_RESOURCE_IDS.includes(r.id) || CORE_CURRENCY_IDS.includes(r.id);
    const stepAmt = r.id === 'gold' ? 20 : 100;
    const row = document.createElement('div');
    row.className = 'lab-slot-card';
    row.dataset.resId = r.id;
    row.innerHTML = `
      <div class="lab-slot-head">
        <div>
          <strong>${escapeHtml(r.name)}</strong>
          <span class="status-badge ${r.group === 'currency' ? 'badge-warn' : 'badge-muted'}" style="margin-left:6px;">
            ${r.autoRecover ? `上限 ${r.cap} · +${r.recoveryPerMin}/分` : '不自动恢复'}
          </span>
        </div>
        <span class="metric-value" style="font-size:17px;">${Math.floor(r.amount)}${escapeHtml(r.unit)}</span>
      </div>
      <div class="cc-btn-3col">
        <button type="button" class="btn-secondary uikit-touch-target" data-res-act="spend">-${stepAmt}</button>
        <button type="button" class="btn-primary uikit-touch-target" data-res-act="add">+${stepAmt}</button>
        <button type="button" class="btn-danger uikit-touch-target" data-res-act="remove" ${isCore ? 'disabled' : ''}>${isCore ? '核心项' : '删除'}</button>
      </div>
    `;

    row.querySelector('[data-res-act="spend"]').addEventListener('click', async () => {
      const res = await resources.spend(r.id, stepAmt, { reason: '控制台测试扣除' });
      if (!res.ok) {
        uiKit.showToast(res.reason, 'warn');
        return;
      }
      uiKit.showToast(`${r.name} -${stepAmt}（剩余 ${res.after}）`, 'ok');
      await renderConsole();
    });

    row.querySelector('[data-res-act="add"]').addEventListener('click', async () => {
      const res = await resources.add(r.id, stepAmt, { reason: '控制台测试补充' });
      uiKit.showToast(`${r.name} +${stepAmt}（当前 ${res.after}）`, 'ok');
      await renderConsole();
    });

    if (!isCore) {
      row.querySelector('[data-res-act="remove"]').addEventListener('click', async () => {
        const ok = await uiKit.confirmDialog({
          title: `删除资源「${r.name}」`,
          message: '确认删除该自定义资源条目吗？',
          confirmLabel: '确认删除',
          tone: 'danger',
        });
        if (!ok) return;
        await resources.removeResource(r.id);
        uiKit.showToast(`已删除资源：${r.name}`, 'ok');
        await renderConsole();
      });
    }

    listEl.appendChild(row);
  }

  host.appendChild(card);
}

function renderLogsTab(host) {
  const { logs, uiKit } = consoleState.context;
  const rows = logs.list({
    category: consoleState.logCategoryFilter === 'all' ? null : consoleState.logCategoryFilter,
    limit: 60,
  });

  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm';
  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">行动日志（${rows.length} / ${logs.count()}）</h2>
      <button type="button" id="btn-cc-export-logs" class="btn-primary uikit-touch-target" style="padding:6px 12px;font-size:12.5px;">导出摘要</button>
    </div>
    <div class="chip-row" id="cc-log-filters">
      ${[
        { id: 'all', label: '全部' },
        { id: LOG_CATEGORIES.CHECK, label: '检定' },
        { id: LOG_CATEGORIES.EQUIPMENT, label: '穿脱/强化' },
        { id: LOG_CATEGORIES.STAT, label: '数值' },
        { id: LOG_CATEGORIES.RESOURCE, label: '资源' },
        { id: LOG_CATEGORIES.CHARACTER, label: '角色' },
      ]
        .map(
          (f) => `
        <button type="button" class="preset-chip" data-log-filter="${f.id}"
          style="${consoleState.logCategoryFilter === f.id ? 'border-color:var(--accent);color:var(--text-primary);background:var(--accent-soft);' : ''}">
          ${escapeHtml(f.label)}
        </button>
      `
        )
        .join('')}
    </div>
    <div class="lab-stack-sm" id="cc-log-list">
      ${
        rows.length === 0
          ? '<p class="muted-text">当前筛选条件下暂无行动日志。</p>'
          : rows
              .map(
                (entry) => `
            <article class="cc-log-item">
              <div class="cc-log-head">
                <span class="status-badge badge-muted">${escapeHtml(LOG_CATEGORY_LABELS[entry.category] || entry.category)}</span>
                <span class="cc-log-time">${escapeHtml(formatTimeShort(entry.timestamp))}</span>
              </div>
              <div class="cc-log-title">${escapeHtml(entry.title)}</div>
              ${entry.detail ? `<div class="cc-log-detail">${escapeHtml(entry.detail)}</div>` : ''}
            </article>
          `
              )
              .join('')
      }
    </div>
    ${
      logs.count() > 0
        ? '<button type="button" id="btn-cc-clear-logs" class="btn-danger uikit-touch-target">清空全部日志</button>'
        : ''
    }
  `;

  card.querySelector('#btn-cc-export-logs').addEventListener('click', () => openLogExportSheet());
  card.querySelectorAll('[data-log-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      consoleState.logCategoryFilter = btn.getAttribute('data-log-filter');
      renderConsole();
    });
  });

  const clearBtn = card.querySelector('#btn-cc-clear-logs');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const ok = await uiKit.confirmDialog({
        title: '清空行动日志',
        message: '确定清空全部行动流水记录吗？',
        confirmLabel: '确认清空',
        tone: 'danger',
      });
      if (!ok) return;
      await logs.clear();
      uiKit.showToast('行动日志已清空', 'ok');
      await renderConsole();
    });
  }

  host.appendChild(card);
}

// ============================================================
// Root Console Render
// ============================================================

async function renderConsole() {
  if (!consoleState.container || !consoleState.context) return;
  const { entities, inventory, resources, statRules, commander, expeditions, uiKit } = consoleState.context;
  const roster = getCharacters();
  const char = getActiveCharacter();
  if (!char) return;

  const avatarUrl = await resolveAvatarUrl(char);
  const prog = statRules.ensureShipProgression(char);
  const effStats = entities.getEffectiveStats(char.id, { round: 'round' });
  const eqBonuses = inventory.getCharacterEquipmentBonuses(char.id);
  const overallScore = statRules.computeOverallScore(effStats, eqBonuses.checkBonus);
  const affThresholdRed = commander ? commander.getAffinityThresholdReduction() : 0;
  const affStage = statRules.getAffinityStage(char.stats.affinity ?? 0, { thresholdReduction: affThresholdRed });
  const moraleMod = statRules.getMoraleModifier(char.stats.morale ?? 50);
  const seaworthyInfo = statRules.evaluateSeaworthiness(inventory, char.id);
  const isDispatched = expeditions ? expeditions.isCharacterDispatched(char.id) : false;

  consoleState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'cc-root';

  // 0. Unified 6-Resource & Dual-Currency Overview Bar
  root.appendChild(createResourceOverviewBar(resources, { id: 'cc-resource-bar' }));

  // 1. Character Roster Switcher Strip
  const rosterStrip = document.createElement('div');
  rosterStrip.className = 'cc-roster-strip';
  rosterStrip.id = 'cc-roster-strip';
  for (const c of roster) {
    const sw = inventory.checkSeaworthiness(c.id);
    const disp = expeditions ? expeditions.isCharacterDispatched(c.id) : false;
    const cProg = statRules.ensureShipProgression(c);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `cc-roster-chip ${c.id === char.id ? 'is-active' : ''}`;
    chip.dataset.selectChar = c.id;
    const typeTag = c.meta?.shipType ? `[${c.meta.shipType}] ` : '';
    chip.textContent = disp
      ? `${typeTag}${c.name} Lv.${cProg.level} (远征中)`
      : sw.seaworthy
      ? `${typeTag}${c.name} Lv.${cProg.level}`
      : `${typeTag}${c.name} Lv.${cProg.level} (未适航)`;
    chip.addEventListener('click', async () => {
      consoleState.activeCharacterId = c.id;
      await saveRosterNow();
      consoleState.context.bus.emit('character:selected', { characterId: c.id, name: c.name });
      await renderConsole();
    });
    rosterStrip.appendChild(chip);
  }
  const addCharBtn = document.createElement('button');
  addCharBtn.type = 'button';
  addCharBtn.id = 'btn-cc-new-char';
  addCharBtn.className = 'cc-roster-chip is-add';
  addCharBtn.textContent = '+ 新建舰娘';
  addCharBtn.addEventListener('click', () => openCharacterEditorSheet(null));
  rosterStrip.appendChild(addCharBtn);
  root.appendChild(rosterStrip);

  // 2. Top Core Status Card
  const heroCard = document.createElement('section');
  heroCard.className = 'surface-card lab-stack-sm';
  heroCard.id = 'cc-hero-card';
  heroCard.innerHTML = `
    <div class="cc-hero-row">
      <img class="cc-avatar" id="cc-active-avatar" src="${avatarUrl}" alt="${escapeHtml(char.name)} 头像">
      <div class="cc-hero-info">
        <div class="cc-hero-name-row">
          <h2 class="cc-hero-name" id="cc-active-name">${escapeHtml(char.name)}</h2>
          <span class="status-badge ship-lv-badge" id="cc-level-badge">Lv.${prog.level}</span>
          <span class="status-badge badge-ok" id="cc-overall-score">评分 ${overallScore}</span>
        </div>
        <div class="cc-badge-row">
          <span class="status-badge badge-ok" id="cc-ship-type-badge">${escapeHtml(char.meta?.shipType || '驱逐舰')}</span>
          <span class="status-badge ${seaworthyInfo.seaworthy ? 'badge-ok' : 'badge-danger'}" id="cc-seaworthy-badge">
            ${seaworthyInfo.seaworthy ? '适航' : '未适航（缺少核心部件）'}
          </span>
          ${isDispatched ? '<span class="status-badge badge-warn">远征派遣中</span>' : ''}
          <span class="status-badge badge-ok" id="cc-affinity-badge">好感 ${escapeHtml(affStage.label)}(${affStage.value})</span>
        </div>
      </div>
    </div>

    ${
      !seaworthyInfo.seaworthy
        ? `<div class="seaworthy-alert" id="cc-seaworthy-alert">${escapeHtml(seaworthyInfo.statusText)}。装齐「引擎 / 装甲 / 核心」后即可恢复适航出击。</div>`
        : ''
    }

    <div id="cc-dynamic-bars" class="lab-stack-sm"></div>

    <div class="lab-btn-grid">
      <button type="button" id="btn-cc-goto-action" class="btn-primary uikit-touch-target">前往行动台</button>
      <button type="button" id="btn-cc-goto-workshop" class="btn-secondary uikit-touch-target">物资与工坊台</button>
      <button type="button" id="btn-cc-open-check" class="btn-secondary uikit-touch-target">模拟检定</button>
      <button type="button" id="btn-cc-edit-char" class="btn-secondary uikit-touch-target">编辑舰娘</button>
    </div>
  `;

  const barsMount = heroCard.querySelector('#cc-dynamic-bars');
  const maxHp = Math.max(1, Math.round(Number(effStats.maxHp ?? char.stats.maxHp ?? 100)));
  const maxAp = Number(char.stats.maxAp ?? 100);
  const expBar = uiKit.createProgressBar({
    label: `等级经验 (Lv.${prog.level} · EXP ${prog.exp}/${prog.maxExp})`,
    value: prog.exp,
    max: prog.maxExp,
    tone: 'ok',
  });
  expBar.element.id = 'cc-exp-bar';
  barsMount.appendChild(expBar.element);
  barsMount.appendChild(
    uiKit.createProgressBar({
      label: '耐久 (HP)',
      value: Math.min(maxHp, Math.round(Number(char.stats.hp ?? maxHp))),
      max: maxHp,
      tone: (char.stats.hp ?? maxHp) / maxHp < 0.3 ? 'danger' : 'accent',
    }).element
  );
  barsMount.appendChild(
    uiKit.createProgressBar({
      label: `士气（${statRules.getMoraleLabel(char.stats.morale)} · 检定 ${formatSigned(moraleMod)}）`,
      value: char.stats.morale ?? 50,
      max: 100,
      tone: (char.stats.morale ?? 50) < 25 ? 'danger' : (char.stats.morale ?? 50) < 50 ? 'warn' : 'accent',
    }).element
  );
  barsMount.appendChild(
    uiKit.createProgressBar({
      label: '行动点 (AP)',
      value: char.stats.ap ?? 100,
      max: maxAp,
      tone: (char.stats.ap ?? 100) / maxAp < 0.25 ? 'warn' : 'accent',
    }).element
  );

  heroCard.querySelector('#btn-cc-goto-action').addEventListener('click', () => {
    if (consoleState.context.modules.has('action-console')) {
      consoleState.context.modules.mount('action-console');
    }
  });
  heroCard.querySelector('#btn-cc-goto-workshop').addEventListener('click', () => {
    if (consoleState.context.modules.has('supply-workshop')) {
      consoleState.context.modules.mount('supply-workshop');
    }
  });
  heroCard.querySelector('#btn-cc-open-check').addEventListener('click', () => openCheckSimulatorSheet(char));
  heroCard.querySelector('#btn-cc-edit-char').addEventListener('click', () => openCharacterEditorSheet(char));
  root.appendChild(heroCard);

  // 3. Segmented Sub-Tabs
  consoleState.tabsCtrl = uiKit.createTabs({
    items: [
      { id: 'overview', label: '角色面板' },
      { id: 'equipment', label: '背包与装备' },
      { id: 'resources', label: '资源管理' },
      { id: 'logs', label: '行动日志' },
    ],
    activeId: consoleState.activeTab,
    onChange: (nextTab) => {
      consoleState.activeTab = nextTab;
      renderConsole();
    },
  });
  const tabsWrap = document.createElement('div');
  tabsWrap.id = 'cc-tabs-mount';
  tabsWrap.appendChild(consoleState.tabsCtrl.element);
  root.appendChild(tabsWrap);

  // 4. Active Sub-Tab Body
  const tabBody = document.createElement('div');
  tabBody.className = 'module-stack';
  tabBody.id = 'cc-tab-body';

  if (consoleState.activeTab === 'overview') {
    renderOverviewTab(tabBody, char);
  } else if (consoleState.activeTab === 'equipment') {
    renderEquipmentTab(tabBody, char);
  } else if (consoleState.activeTab === 'resources') {
    renderResourcesTab(tabBody);
  } else if (consoleState.activeTab === 'logs') {
    renderLogsTab(tabBody);
  }

  root.appendChild(tabBody);
  consoleState.container.appendChild(root);
}

// ============================================================
// Standard Module Export
// ============================================================

export default {
  id: 'character-console',
  name: '角色控制台',
  description: '角色管理、舰娘等级经验成长、三核心必装槽适航校验、完全自由自定义槽位、八维面板与 1D20 检定控制台。',

  mount(container, context) {
    consoleState.container = container;
    consoleState.context = context;
    consoleState.avatarUrlCache.clear();

    if (getCharacters().length === 0) {
      for (const tpl of DEFAULT_CHARACTER_TEMPLATES) {
        context.entities.register(tpl);
      }
      context.inventory.syncAllCharacters();
    }

    context.ui.setPlaceholder('输入快捷备忘或指令，记录到当前角色行动日志...');
    context.ui.setInputHandler(async (text) => {
      const char = getActiveCharacter();
      context.logs.add({
        category: LOG_CATEGORIES.CHARACTER,
        actorId: char?.id || null,
        actorName: char?.name || '',
        title: `${char ? `[${char.name}] ` : ''}控制台备忘`,
        detail: text,
      });
      context.uiKit.showToast('已记入行动日志', 'ok');
      if (consoleState.activeTab === 'logs') {
        await renderConsole();
      }
    });

    context.ui.setQuickActions([
      {
        id: 'cc-quick-add-slot',
        label: '+ 自定义槽位',
        onClick: () => openAddCustomSlotSheet(getActiveCharacter()),
      },
      {
        id: 'cc-quick-check',
        label: '模拟检定',
        onClick: () => openCheckSimulatorSheet(getActiveCharacter()),
      },
      {
        id: 'cc-quick-rules',
        label: '数值规则',
        onClick: () => openStatRulesSheet(),
      },
      {
        id: 'cc-quick-new-item',
        label: '新建部件/装备',
        onClick: () => openItemEditorSheet(null),
      },
    ]);

    consoleState.unsubs = [
      context.bus.on('stat-rules:changed', () => renderConsole()),
      context.bus.on('action:settled', () => renderConsole()),
      context.bus.on('character:exp-gained', () => renderConsole()),
      context.bus.on('character:leveled-up', () => renderConsole()),
      context.bus.on('inventory:equipped', () => renderConsole()),
      context.bus.on('inventory:unequipped', () => renderConsole()),
      context.bus.on('inventory:slot-added', () => renderConsole()),
      context.bus.on('inventory:slot-removed', () => renderConsole()),
      context.bus.on('inventory:enhanced', () => renderConsole()),
      context.bus.on('commander:updated', () => renderConsole()),
      context.bus.on('storage:changed', (detail) => {
        if (detail?.action === 'resetAll' || detail?.action === 'import') {
          renderConsole();
        }
      }),
    ];

    renderConsole();
  },

  unmount() {
    for (const unsub of consoleState.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    consoleState.unsubs = [];
    consoleState.container = null;
    consoleState.context = null;
    consoleState.tabsCtrl = null;
  },
};
