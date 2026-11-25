/**
 * Official Business Module #1: Character Console (`character-console`).
 *
 * Plain, domain-neutral mobile-first console integrating:
 *   - Character roster management (2 starter templates + visual create/edit/delete + photo avatar upload)
 *   - Core status card (avatar, affinity stage, HP/morale/AP bars, global resource summary)
 *   - 5 core stats panel with live equipment/outfit bonus breakdown & composite score
 *   - Inventory & Equipment/Outfit bench (custom outfits/equipment with multi-entry stat bonuses, custom slots)
 *   - Resource manager & Chronological Action Logs (with text summary export)
 *   - Built-in "数值规则设置" & "实时模拟检定" bottom sheets
 */

import { CORE_STAT_DEFS, CORE_STAT_MAP } from '../core/stat-rules.js';
import { ITEM_CATEGORIES, ITEM_CATEGORY_LABELS } from '../core/inventory-system.js';
import { LOG_CATEGORIES, LOG_CATEGORY_LABELS } from '../core/log-system.js';
import { clamp } from '../core/calc-engine.js';

const CHAR_STORAGE_NS = 'core-characters';
const ROSTER_KEY = 'roster-state';

const BONUS_STAT_OPTIONS = [
  { key: 'attack', label: '攻击/火力' },
  { key: 'burst', label: '爆发/雷装' },
  { key: 'agility', label: '机动' },
  { key: 'tactics', label: '战术/侦察' },
  { key: 'luck', label: '幸运' },
  { key: 'checkBonus', label: '检定额外加成' },
  { key: 'hp', label: '生命/耐久' },
  { key: 'morale', label: '士气' },
  { key: 'ap', label: '行动点' },
];

const BONUS_STAT_LABEL_MAP = Object.fromEntries(BONUS_STAT_OPTIONS.map((o) => [o.key, o.label]));

export const DEFAULT_CHARACTER_TEMPLATES = [
  {
    id: 'char_template_01',
    kind: 'character',
    name: '角色模板 A',
    tags: ['均衡型', '示例'],
    stats: {
      attack: 62,
      burst: 54,
      agility: 52,
      tactics: 50,
      luck: 45,
      hp: 90,
      maxHp: 100,
      morale: 72,
      ap: 80,
      maxAp: 100,
      affinity: 55,
    },
    statBounds: {
      hp: { min: 0, max: 100 },
      morale: { min: 0, max: 100 },
      ap: { min: 0, max: 100 },
      affinity: { min: 0, max: 100 },
    },
    meta: {
      roleTag: '均衡前卫型',
      avatarAssetId: null,
      personality: '沉着务实、行动条理清晰，注重团队协同与稳健推进。',
      speechHabit: '「收到，按计划稳步执行。」',
    },
  },
  {
    id: 'char_template_02',
    kind: 'character',
    name: '角色模板 B',
    tags: ['机动型', '示例'],
    stats: {
      attack: 46,
      burst: 48,
      agility: 74,
      tactics: 68,
      luck: 60,
      hp: 85,
      maxHp: 100,
      morale: 84,
      ap: 90,
      maxAp: 100,
      affinity: 36,
    },
    statBounds: {
      hp: { min: 0, max: 100 },
      morale: { min: 0, max: 100 },
      ap: { min: 0, max: 100 },
      affinity: { min: 0, max: 100 },
    },
    meta: {
      roleTag: '机动侦察型',
      avatarAssetId: null,
      personality: '敏锐机警、擅长快速响应与信息收集，面对突发状况适应力强。',
      speechHabit: '「前方情况已确认，随时可以行动。」',
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
  const label = BONUS_STAT_LABEL_MAP[bonus.stat] || bonus.stat;
  if (bonus.layer === 'percentAdd' || bonus.layer === 'percentMult') {
    const pct = Math.round((Number(bonus.value) || 0) * 100);
    return `${label} ${pct >= 0 ? `+${pct}%` : `${pct}%`}`;
  }
  return `${label} ${formatSigned(bonus.value)}`;
}

function formatTimeShort(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Hydrate persisted character roster from IndexedDB into EntitySystem on app boot.
 * Also applies offline recovery for HP / Morale / AP if >= 60s elapsed since last visit.
 */
export async function hydrateCharacterRoster({ storage, entities, inventory, statRules }) {
  const scope = storage.namespace(CHAR_STORAGE_NS);
  const saved = await scope.getLarge(ROSTER_KEY, null);
  const now = Date.now();

  if (saved && Array.isArray(saved.characters) && saved.characters.length > 0) {
    for (const ch of saved.characters) {
      if (ch && ch.id) {
        entities.register({ ...ch, kind: 'character' });
      }
    }
    inventory.syncAllCharacters();

    // Auto-settle offline recovery if elapsed >= 60 seconds
    if (saved.lastActiveAt && now - saved.lastActiveAt >= 60 * 1000) {
      const charList = entities.list({ kind: 'character' });
      if (charList.length > 0) {
        const rules = statRules.buildOfflineRecoveryRules(charList);
        entities.settleOfflineTime({
          lastTimestamp: saved.lastActiveAt,
          now,
          rules,
        });
      }
    }
    const restoredId = saved.activeCharacterId || saved.characters[0]?.id || null;
    consoleState.activeCharacterId = restoredId;
    return {
      activeCharacterId: restoredId,
      seeded: false,
    };
  }

  // First boot: seed 2 plain generic templates
  for (const tpl of DEFAULT_CHARACTER_TEMPLATES) {
    entities.register(tpl);
  }
  // Equip 1 starter outfit on Template A so live bonus display works immediately
  if (inventory.getItem('item_outfit_standard')) {
    await inventory.equipItem('char_template_01', 'outfit', 'item_outfit_standard');
  }
  consoleState.activeCharacterId = 'char_template_01';
  await persistCharacterRoster({
    storage,
    entities,
    activeCharacterId: 'char_template_01',
  });
  return { activeCharacterId: 'char_template_01', seeded: true };
}

export async function persistCharacterRoster({ storage, entities, activeCharacterId = null }) {
  const scope = storage.namespace(CHAR_STORAGE_NS);
  const characters = entities.list({ kind: 'character' }).map((e) => ({
    id: e.id,
    kind: 'character',
    name: e.name,
    tags: [...(e.tags || [])],
    stats: { ...(e.stats || {}) },
    statBounds: JSON.parse(JSON.stringify(e.statBounds || {})),
    // Persist only non-inventory modifiers; inventory modifiers are re-synced from InventorySystem
    modifiers: (e.modifiers || []).filter((m) => !String(m.id || '').startsWith('inv_eq_')),
    meta: JSON.parse(JSON.stringify(e.meta || {})),
  }));
  await scope.setLarge(ROSTER_KEY, {
    activeCharacterId,
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
// Bottom Sheet Modals (Character, Item, Slots, Rules, 1D20 Check)
// ============================================================

function openCharacterEditorSheet(existingChar = null) {
  const { entities, inventory, assets, uiKit, logs, bus, statRules } = consoleState.context;
  const isEdit = Boolean(existingChar);
  const rulesCfg = statRules.getConfig();

  const draft = existingChar
    ? {
        name: existingChar.name,
        roleTag: existingChar.meta?.roleTag || '',
        avatarAssetId: existingChar.meta?.avatarAssetId || null,
        personality: existingChar.meta?.personality || '',
        speechHabit: existingChar.meta?.speechHabit || '',
        stats: { ...existingChar.stats },
      }
    : {
        name: '',
        roleTag: '自定义角色',
        avatarAssetId: null,
        personality: '',
        speechHabit: '',
        stats: {
          attack: 50,
          burst: 50,
          agility: 50,
          tactics: 50,
          luck: 50,
          hp: 100,
          maxHp: 100,
          morale: 70,
          ap: 100,
          maxAp: 100,
          affinity: 20,
        },
      };

  const formWrap = document.createElement('div');
  formWrap.className = 'module-stack';

  const renderForm = async () => {
    const avatarRes = await assets.getAssetUrl(draft.avatarAssetId, {
      fallbackSeed: existingChar?.id || draft.name || 'new-char',
      fallbackLabel: (draft.name || 'NEW').slice(0, 6),
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
          <label class="form-label" for="cc-f-name">角色名称 *</label>
          <input id="cc-f-name" class="form-input" type="text" value="${escapeHtml(draft.name)}" placeholder="例如：测试角色 03">
        </div>
        <div class="form-group">
          <label class="form-label" for="cc-f-role">定位简称</label>
          <input id="cc-f-role" class="form-input" type="text" value="${escapeHtml(draft.roleTag)}" placeholder="例如：突击支援型">
        </div>
      </div>

      <div class="form-group">
        <span class="form-label">基础五维属性（${rulesCfg.statMin} ~ ${rulesCfg.statMax}）</span>
        <div class="lab-kv-grid">
          ${CORE_STAT_DEFS.map(
            (def) => `
            <div class="form-group">
              <label class="form-label" for="cc-f-stat-${def.key}">${escapeHtml(def.label)}</label>
              <input id="cc-f-stat-${def.key}" class="form-input" type="number" min="${rulesCfg.statMin}" max="${rulesCfg.statMax}" value="${Number(draft.stats[def.key] ?? def.defaultValue)}">
            </div>
          `
          ).join('')}
          <div class="form-group">
            <label class="form-label" for="cc-f-affinity">好感度（0~100）</label>
            <input id="cc-f-affinity" class="form-input" type="number" min="0" max="100" value="${Number(draft.stats.affinity ?? 20)}">
          </div>
        </div>
      </div>

      <div class="lab-kv-grid-3">
        <div class="form-group">
          <label class="form-label" for="cc-f-hp">生命 HP</label>
          <input id="cc-f-hp" class="form-input" type="number" min="0" max="999" value="${Number(draft.stats.hp ?? 100)}">
        </div>
        <div class="form-group">
          <label class="form-label" for="cc-f-morale">士气 (0~100)</label>
          <input id="cc-f-morale" class="form-input" type="number" min="0" max="100" value="${Number(draft.stats.morale ?? 70)}">
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

  const syncInputsToDraft = () => {
    const nameEl = formWrap.querySelector('#cc-f-name');
    if (!nameEl) return;
    draft.name = nameEl.value.trim();
    draft.roleTag = formWrap.querySelector('#cc-f-role').value.trim();
    draft.personality = formWrap.querySelector('#cc-f-personality').value.trim();
    draft.speechHabit = formWrap.querySelector('#cc-f-speech').value.trim();
    for (const def of CORE_STAT_DEFS) {
      const v = Number(formWrap.querySelector(`#cc-f-stat-${def.key}`).value);
      draft.stats[def.key] = clamp(Number.isFinite(v) ? v : def.defaultValue, rulesCfg.statMin, rulesCfg.statMax);
    }
    draft.stats.affinity = clamp(Number(formWrap.querySelector('#cc-f-affinity').value) || 0, 0, 100);
    const hpVal = clamp(Number(formWrap.querySelector('#cc-f-hp').value) || 0, 0, 999);
    const apVal = clamp(Number(formWrap.querySelector('#cc-f-ap').value) || 0, 0, 999);
    draft.stats.hp = hpVal;
    draft.stats.maxHp = Math.max(Number(draft.stats.maxHp || 100), hpVal);
    draft.stats.morale = clamp(Number(formWrap.querySelector('#cc-f-morale').value) || 0, 0, 100);
    draft.stats.ap = apVal;
    draft.stats.maxAp = Math.max(Number(draft.stats.maxAp || 100), apVal);
  };

  renderForm();

  const actions = [
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

        entities.register({
          id: charId,
          kind: 'character',
          name: draft.name,
          tags: [draft.roleTag || '自定义'],
          stats: { ...draft.stats },
          statBounds: {
            hp: { min: 0, max: draft.stats.maxHp },
            morale: { min: 0, max: 100 },
            ap: { min: 0, max: draft.stats.maxAp },
            affinity: { min: 0, max: 100 },
          },
          modifiers: nonInvMods,
          meta: {
            roleTag: draft.roleTag || '通用型',
            avatarAssetId: draft.avatarAssetId,
            personality: draft.personality,
            speechHabit: draft.speechHabit,
          },
        });

        inventory.syncCharacterModifiers(charId);
        consoleState.activeCharacterId = charId;
        consoleState.avatarUrlCache.clear();
        await saveRosterNow();

        logs.add({
          category: LOG_CATEGORIES.CHARACTER,
          actorId: charId,
          actorName: draft.name,
          title: isEdit ? `更新角色「${draft.name}」资料` : `新建角色「${draft.name}」`,
          detail: `五维：攻${draft.stats.attack}/爆${draft.stats.burst}/机${draft.stats.agility}/战${draft.stats.tactics}/幸${draft.stats.luck}`,
        });
        bus.emit('character:saved', { characterId: charId, name: draft.name, isEdit });
        uiKit.showToast(isEdit ? `已保存角色：${draft.name}` : `已创建角色：${draft.name}`, 'ok');
        await renderConsole();
        return true;
      },
    },
  ];

  uiKit.openBottomSheet({
    title: isEdit ? `编辑角色 · ${existingChar.name}` : '新建自定义角色',
    subtitle: '数据自动持久化至本地 IndexedDB 数据库',
    content: formWrap,
    actions,
  });
}

function openItemEditorSheet(existingItem = null) {
  const { inventory, uiKit, logs } = consoleState.context;
  const isEdit = Boolean(existingItem);
  const slots = inventory.listSlots();

  const draft = existingItem
    ? {
        name: existingItem.name,
        category: existingItem.category,
        slotType: existingItem.slotType || 'main_equip',
        tags: (existingItem.tags || []).join(', '),
        description: existingItem.description || '',
        quantity: existingItem.quantity ?? 1,
        bonuses: (existingItem.bonuses || []).map((b) => ({ ...b })),
      }
    : {
        name: '',
        category: ITEM_CATEGORIES.OUTFIT,
        slotType: 'outfit',
        tags: '自定义',
        description: '',
        quantity: 1,
        bonuses: [
          { stat: 'attack', layer: 'baseAdd', value: 10 },
          { stat: 'checkBonus', layer: 'flatFinal', value: 1 },
        ],
      };

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const readBonusRows = () => {
    const rows = [];
    wrap.querySelectorAll('[data-bonus-row]').forEach((row) => {
      const stat = row.querySelector('[data-b-stat]').value;
      const layer = row.querySelector('[data-b-layer]').value;
      const val = Number(row.querySelector('[data-b-val]').value);
      if (stat && Number.isFinite(val)) {
        rows.push({ stat, layer, value: val });
      }
    });
    draft.bonuses = rows;
  };

  const readMainFields = () => {
    const nameEl = wrap.querySelector('#cc-item-name');
    if (!nameEl) return;
    draft.name = nameEl.value.trim();
    draft.category = wrap.querySelector('#cc-item-cat').value;
    const slotEl = wrap.querySelector('#cc-item-slot');
    if (slotEl) draft.slotType = slotEl.value;
    draft.tags = wrap.querySelector('#cc-item-tags').value;
    draft.description = wrap.querySelector('#cc-item-desc').value.trim();
    draft.quantity = Math.max(1, Math.floor(Number(wrap.querySelector('#cc-item-qty').value) || 1));
    readBonusRows();
  };

  const renderForm = () => {
    const compatibleSlots = slots.filter((s) => s.allowedCategories.includes(draft.category));
    if (draft.category !== ITEM_CATEGORIES.CONSUMABLE && compatibleSlots.length > 0) {
      if (!compatibleSlots.some((s) => s.id === draft.slotType)) {
        draft.slotType = compatibleSlots[0].id;
      }
    }

    wrap.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="cc-item-name">物品名称 *</label>
        <input id="cc-item-name" class="form-input" type="text" value="${escapeHtml(draft.name)}" placeholder="例如：强化战术风衣 / 高能核心">
      </div>

      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="cc-item-cat">物品分类</label>
          <select id="cc-item-cat" class="form-select">
            <option value="${ITEM_CATEGORIES.OUTFIT}" ${draft.category === ITEM_CATEGORIES.OUTFIT ? 'selected' : ''}>服装</option>
            <option value="${ITEM_CATEGORIES.EQUIPMENT}" ${draft.category === ITEM_CATEGORIES.EQUIPMENT ? 'selected' : ''}>装备</option>
            <option value="${ITEM_CATEGORIES.CONSUMABLE}" ${draft.category === ITEM_CATEGORIES.CONSUMABLE ? 'selected' : ''}>消耗品</option>
          </select>
        </div>
        ${
          draft.category === ITEM_CATEGORIES.CONSUMABLE
            ? `
          <div class="form-group">
            <label class="form-label" for="cc-item-qty">库存数量</label>
            <input id="cc-item-qty" class="form-input" type="number" min="1" max="999" value="${draft.quantity}">
          </div>`
            : `
          <div class="form-group">
            <label class="form-label" for="cc-item-slot">穿戴槽位</label>
            <select id="cc-item-slot" class="form-select">
              ${compatibleSlots
                .map(
                  (s) =>
                    `<option value="${escapeHtml(s.id)}" ${draft.slotType === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`
                )
                .join('')}
            </select>
          </div>`
        }
      </div>

      ${
        draft.category !== ITEM_CATEGORIES.CONSUMABLE
          ? `<input id="cc-item-qty" type="hidden" value="${draft.quantity}">`
          : ''
      }

      <div class="form-group">
        <label class="form-label" for="cc-item-tags">分类标签（逗号分隔）</label>
        <input id="cc-item-tags" class="form-input" type="text" value="${escapeHtml(draft.tags)}" placeholder="例如：轻甲, 进阶, 礼服">
      </div>

      <div class="form-group">
        <label class="form-label" for="cc-item-desc">外观 / 效果描述</label>
        <textarea id="cc-item-desc" class="form-textarea" placeholder="填写服装外观细节或装备效果说明...">${escapeHtml(draft.description)}</textarea>
      </div>

      <div class="form-group">
        <div class="form-label-row">
          <span class="form-label">属性加减词条（支持正负值，百分比填小数如 0.15 表示 +15%）</span>
        </div>
        <div id="cc-bonus-list" class="lab-stack-sm">
          ${draft.bonuses
            .map(
              (b, idx) => `
            <div class="cc-bonus-row" data-bonus-row="${idx}">
              <select class="form-select" data-b-stat aria-label="目标属性">
                ${BONUS_STAT_OPTIONS.map(
                  (o) => `<option value="${o.key}" ${b.stat === o.key ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
                ).join('')}
              </select>
              <select class="form-select" data-b-layer aria-label="词条类型">
                <option value="baseAdd" ${b.layer === 'baseAdd' || !b.layer ? 'selected' : ''}>固定值</option>
                <option value="percentAdd" ${b.layer === 'percentAdd' ? 'selected' : ''}>百分比</option>
                <option value="flatFinal" ${b.layer === 'flatFinal' ? 'selected' : ''}>终值</option>
              </select>
              <input class="form-input" type="number" step="any" data-b-val value="${Number(b.value ?? 0)}" aria-label="词条数值">
              <button type="button" class="btn-danger uikit-touch-target" data-remove-bonus="${idx}" style="padding:0 10px;">×</button>
            </div>
          `
            )
            .join('')}
        </div>
        <button type="button" id="btn-cc-add-bonus" class="btn-secondary uikit-touch-target" style="margin-top:4px;">+ 添加属性词条</button>
      </div>
    `;

    wrap.querySelector('#cc-item-cat').addEventListener('change', () => {
      readMainFields();
      renderForm();
    });

    wrap.querySelector('#btn-cc-add-bonus').addEventListener('click', () => {
      readMainFields();
      draft.bonuses.push({ stat: 'agility', layer: 'baseAdd', value: 5 });
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
    title: isEdit ? `编辑物品 · ${existingItem.name}` : '新建服装 / 装备 / 消耗品',
    subtitle: '保存后即可为任意角色一键穿戴或使用',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: isEdit ? '保存物品' : '加入仓库',
        tone: 'primary',
        onClick: async () => {
          readMainFields();
          if (!draft.name) {
            uiKit.showToast('请输入物品名称', 'warn');
            return false;
          }
          if (isEdit) {
            await inventory.updateItem(existingItem.id, draft);
            logs.add({
              category: LOG_CATEGORIES.EQUIPMENT,
              title: `更新物品「${draft.name}」`,
              detail: draft.bonuses.map(formatBonusChip).join('、') || '无词条',
            });
            uiKit.showToast(`已更新物品：${draft.name}`, 'ok');
          } else {
            await inventory.createItem(draft);
            logs.add({
              category: LOG_CATEGORIES.EQUIPMENT,
              title: `新建${ITEM_CATEGORY_LABELS[draft.category]}「${draft.name}」`,
              detail: draft.bonuses.map(formatBonusChip).join('、') || '无词条',
            });
            uiKit.showToast(`已新建并入库：${draft.name}`, 'ok');
          }
          await saveRosterNow();
          await renderConsole();
          return true;
        },
      },
    ],
  });
}

function openSlotManagerSheet() {
  const { inventory, uiKit } = consoleState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const renderSlots = () => {
    const slots = inventory.listSlots();
    wrap.innerHTML = `
      <div class="lab-stack-sm">
        ${slots
          .map(
            (s) => `
          <div class="cc-slot-row">
            <div class="cc-slot-info">
              <span class="cc-slot-item-name">${escapeHtml(s.label)}</span>
              <span class="cc-slot-label">ID: <code>${escapeHtml(s.id)}</code> · 允许：${s.allowedCategories.map((c) => ITEM_CATEGORY_LABELS[c] || c).join(' / ')}</span>
            </div>
            <button type="button" class="btn-danger uikit-touch-target" data-del-slot="${escapeHtml(s.id)}" style="padding:0 12px;" ${slots.length <= 1 ? 'disabled' : ''}>删除</button>
          </div>
        `
          )
          .join('')}
      </div>
      <div class="lab-divider"></div>
      <div class="form-group">
        <label class="form-label" for="cc-new-slot-label">新增自定义槽位名称</label>
        <input id="cc-new-slot-label" class="form-input" type="text" placeholder="例如：头部饰件 / 外挂模块">
      </div>
      <div class="form-group">
        <label class="form-label" for="cc-new-slot-cat">允许穿戴类别</label>
        <select id="cc-new-slot-cat" class="form-select">
          <option value="both">服装与装备通用</option>
          <option value="equipment">仅装备</option>
          <option value="outfit">仅服装</option>
        </select>
      </div>
      <button type="button" id="btn-cc-add-slot" class="btn-primary uikit-touch-target">添加槽位</button>
    `;

    wrap.querySelectorAll('[data-del-slot]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sid = btn.getAttribute('data-del-slot');
        await inventory.removeSlot(sid);
        uiKit.showToast(`已移除槽位：${sid}`, 'ok');
        renderSlots();
        await renderConsole();
      });
    });

    wrap.querySelector('#btn-cc-add-slot').addEventListener('click', async () => {
      const label = wrap.querySelector('#cc-new-slot-label').value.trim();
      const catSel = wrap.querySelector('#cc-new-slot-cat').value;
      if (!label) {
        uiKit.showToast('请输入槽位名称', 'warn');
        return;
      }
      const allowedCategories =
        catSel === 'equipment'
          ? [ITEM_CATEGORIES.EQUIPMENT]
          : catSel === 'outfit'
          ? [ITEM_CATEGORIES.OUTFIT]
          : [ITEM_CATEGORIES.EQUIPMENT, ITEM_CATEGORIES.OUTFIT];
      await inventory.addSlot({ label, allowedCategories });
      uiKit.showToast(`已新增槽位：${label}`, 'ok');
      renderSlots();
      await renderConsole();
    });
  };

  renderSlots();
  uiKit.openBottomSheet({
    title: '管理角色穿戴槽位',
    subtitle: '默认包含服装/主装备/副装备/饰品，可自由增删',
    content: wrap,
    actions: [{ id: 'done', label: '完成', tone: 'primary' }],
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
  `;

  uiKit.openBottomSheet({
    title: '数值规则设置',
    subtitle: '通用 1D20 检定公式与离线恢复参数',
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
          });
          uiKit.showToast('数值规则系数已更新并保存', 'ok');
          await renderConsole();
        },
      },
    ],
  });
}

function openCheckSimulatorSheet(char) {
  if (!char) return;
  const { entities, inventory, statRules, uiKit } = consoleState.context;
  let selectedStat = 'attack';
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
        预览：<code>1D20 + ${escapeHtml(statDef.label)}修正(${formatSigned(statRules.getStatModifier(effVal))}) + 装备检定词条(${formatSigned(eqBonuses.checkBonus)}) + 士气(${formatSigned(statRules.getMoraleModifier(moraleVal))})</code> vs DC ${dcValue}
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
    subtitle: '自动计入当前角色属性、已穿戴服装/装备加成与士气修正，并写入行动日志',
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
      <label class="form-label" for="cc-res-name">资源名称 *</label>
      <input id="cc-res-name" class="form-input" type="text" placeholder="例如：核心元件 / 凭证">
    </div>
    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="cc-res-unit">单位</label>
        <input id="cc-res-unit" class="form-input" type="text" placeholder="例如：个 / 点">
      </div>
      <div class="form-group">
        <label class="form-label" for="cc-res-amt">初始数量</label>
        <input id="cc-res-amt" class="form-input" type="number" min="0" value="100">
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
          await resources.defineResource({ name, unit, amount });
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
// Sub-Tab Renderers
// ============================================================

function renderOverviewTab(host, char) {
  const { entities, inventory, statRules, uiKit, logs } = consoleState.context;
  const eqBonuses = inventory.getCharacterEquipmentBonuses(char.id);
  const equippedMap = inventory.getCharacterEquipment(char.id);
  const slots = inventory.listSlots();

  // 1. Core 5 Stats Panel
  const statCard = document.createElement('section');
  statCard.className = 'surface-card lab-stack-sm';
  statCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">五维面板属性</h2>
      <span class="status-badge badge-ok" id="cc-equip-check-badge">装备检定加成 ${formatSigned(eqBonuses.checkBonus)}</span>
    </div>
    <div class="cc-stat-grid" id="cc-stat-grid">
      ${CORE_STAT_DEFS.map((def) => {
        const baseVal = Number(char.stats[def.key] ?? def.defaultValue);
        const stacked = entities.getEffectiveStat(char.id, def.key, { round: 'round' });
        const delta = Number((stacked.final - baseVal).toFixed(1));
        const mod = statRules.getStatModifier(stacked.final);
        return `
          <div class="cc-stat-tile" data-stat-tile="${def.key}">
            <div class="cc-stat-tile-top">
              <span class="cc-stat-name">${escapeHtml(def.label)}</span>
              <span class="status-badge badge-muted">检定 ${formatSigned(mod)}</span>
            </div>
            <div class="cc-stat-val-row">
              <span class="cc-stat-final" data-stat-final="${def.key}">${stacked.final}</span>
              ${
                delta !== 0
                  ? `<span class="cc-stat-delta ${delta < 0 ? 'is-neg' : ''}" data-stat-delta="${def.key}">${formatSigned(delta)}</span>`
                  : ''
              }
            </div>
            <span class="cc-stat-sub">基础 ${baseVal}${delta !== 0 ? ` · 穿戴 ${formatSigned(delta)}` : ''}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
  host.appendChild(statCard);

  // 2. Character Persona & Quick Adjust Card
  const personaCard = document.createElement('section');
  personaCard.className = 'surface-card lab-stack-sm';
  const affStage = statRules.getAffinityStage(char.stats.affinity ?? 0);
  personaCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">角色设定与状态微调</h2>
      <span class="status-badge badge-ok">好感 ${affStage.label} (${affStage.value}/100)</span>
    </div>
    <p class="muted-text"><strong>性格设定：</strong>${escapeHtml(char.meta?.personality || '未填写性格设定')}</p>
    <p class="muted-text"><strong>对话口癖：</strong>${escapeHtml(char.meta?.speechHabit || '未填写对话口癖')}</p>
    <div class="lab-divider"></div>
    <div class="cc-btn-3col">
      <button type="button" id="btn-cc-aff-inc" class="btn-secondary uikit-touch-target">好感 +5</button>
      <button type="button" id="btn-cc-morale-inc" class="btn-secondary uikit-touch-target">士气 +10</button>
      <button type="button" id="btn-cc-ap-dec" class="btn-secondary uikit-touch-target">消耗 15 AP</button>
    </div>
    <div class="lab-btn-grid">
      <button type="button" id="btn-cc-offline-sim" class="btn-secondary uikit-touch-target">模拟离线恢复 +30分</button>
      <button type="button" id="btn-cc-del-char" class="btn-danger uikit-touch-target" ${getCharacters().length <= 1 ? 'disabled' : ''}>删除当前角色</button>
    </div>
  `;

  personaCard.querySelector('#btn-cc-aff-inc').addEventListener('click', async () => {
    const after = entities.adjustStat(char.id, 'affinity', 5, { min: 0, max: 100 });
    await saveRosterNow();
    const st = statRules.getAffinityStage(after);
    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char.id,
      actorName: char.name,
      title: `[${char.name}] 好感度 +5`,
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
    const report = entities.settleOfflineTime({
      lastTimestamp: now - 30 * 60 * 1000,
      now,
      rules,
    });
    await saveRosterNow();
    uiKit.showToast(`已模拟离线恢复 ${report.formattedDuration}`, 'ok');
    await renderConsole();
  });

  personaCard.querySelector('#btn-cc-del-char').addEventListener('click', async () => {
    if (getCharacters().length <= 1) return;
    const ok = await uiKit.confirmDialog({
      title: `删除角色「${char.name}」`,
      message: '确认删除该角色吗？其已穿戴的装备将自动保留在全局仓库中。',
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

  // 3. Compact Equipped Slots Preview
  const eqPreviewCard = uiKit.createCollapsibleCard({
    title: '当前穿戴槽位一览',
    subtitle: `已装备 ${eqBonuses.items.length} / ${slots.length} 个槽位`,
    badge: `${eqBonuses.items.length}/${slots.length}`,
    open: true,
    content: (body) => {
      const list = document.createElement('div');
      list.className = 'lab-stack-sm';
      for (const s of slots) {
        const item = equippedMap[s.id];
        const row = document.createElement('div');
        row.className = 'cc-slot-row';
        row.innerHTML = `
          <div class="cc-slot-info">
            <span class="cc-slot-label">${escapeHtml(s.label)}</span>
            <span class="cc-slot-item-name">${item ? escapeHtml(item.name) : '（未穿戴）'}</span>
          </div>
          <span class="muted-text" style="font-size:11.5px;">${
            item && item.bonuses?.length ? escapeHtml(item.bonuses.map(formatBonusChip).slice(0, 2).join(' · ')) : '空闲'
          }</span>
        `;
        list.appendChild(row);
      }
      const goBtn = document.createElement('button');
      goBtn.type = 'button';
      goBtn.className = 'btn-secondary uikit-touch-target';
      goBtn.style.width = '100%';
      goBtn.style.marginTop = '8px';
      goBtn.textContent = '前往背包与装备穿戴台';
      goBtn.addEventListener('click', () => {
        consoleState.activeTab = 'equipment';
        if (consoleState.tabsCtrl) consoleState.tabsCtrl.setActive('equipment', { silent: true });
        renderConsole();
      });
      body.appendChild(list);
      body.appendChild(goBtn);
    },
  });
  host.appendChild(eqPreviewCard.element);
}

function renderEquipmentTab(host, char) {
  const { inventory, uiKit } = consoleState.context;
  const slots = inventory.listSlots();
  const equippedMap = inventory.getCharacterEquipment(char.id);

  // Card 1: Character Equipment Slots
  const slotsCard = document.createElement('section');
  slotsCard.className = 'surface-card lab-stack-sm';
  slotsCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">${escapeHtml(char.name)} · 穿戴槽位</h2>
      <button type="button" id="btn-cc-manage-slots" class="btn-ghost-sm">管理槽位</button>
    </div>
    <div class="lab-stack-sm" id="cc-slots-container"></div>
  `;

  slotsCard.querySelector('#btn-cc-manage-slots').addEventListener('click', () => openSlotManagerSheet());

  const slotsContainer = slotsCard.querySelector('#cc-slots-container');
  for (const s of slots) {
    const item = equippedMap[s.id];
    const row = document.createElement('div');
    row.className = 'cc-slot-row';
    row.dataset.equipSlot = s.id;
    row.innerHTML = `
      <div class="cc-slot-info">
        <span class="cc-slot-label">${escapeHtml(s.label)}</span>
        <span class="cc-slot-item-name">${item ? escapeHtml(item.name) : '（未穿戴）'}</span>
        ${
          item && item.bonuses?.length
            ? `<span class="cc-stat-sub">${escapeHtml(item.bonuses.map(formatBonusChip).join(' · '))}</span>`
            : ''
        }
      </div>
      ${
        item
          ? `<button type="button" class="btn-danger uikit-touch-target" data-unequip-slot="${escapeHtml(s.id)}" style="padding:0 12px;">卸下</button>`
          : `<span class="status-badge badge-muted">空闲</span>`
      }
    `;
    const unequipBtn = row.querySelector('[data-unequip-slot]');
    if (unequipBtn) {
      unequipBtn.addEventListener('click', async () => {
        await inventory.unequipSlot(char.id, s.id);
        await saveRosterNow();
        uiKit.showToast(`已从「${s.label}」卸下「${item.name}」`, 'ok');
        await renderConsole();
      });
    }
    slotsContainer.appendChild(row);
  }
  host.appendChild(slotsCard);

  // Card 2: Global Item Warehouse
  const items = inventory.listItems({
    category: consoleState.itemCategoryFilter === 'all' ? null : consoleState.itemCategoryFilter,
  });

  const warehouseCard = document.createElement('section');
  warehouseCard.className = 'surface-card lab-stack-sm';
  warehouseCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">全局物品仓库（${items.length}）</h2>
      <button type="button" id="btn-cc-new-item" class="btn-primary uikit-touch-target" style="padding:6px 12px;font-size:12.5px;">+ 新建服装/装备</button>
    </div>
    <div class="chip-row" id="cc-item-filters">
      ${[
        { id: 'all', label: '全部' },
        { id: ITEM_CATEGORIES.OUTFIT, label: '服装' },
        { id: ITEM_CATEGORIES.EQUIPMENT, label: '装备' },
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
    listEl.innerHTML = '<p class="muted-text">当前分类暂无物品，点击上方按钮新建服装或装备。</p>';
  } else {
    for (const item of items) {
      const equippedSlotId = inventory.getEquippedSlotOfItem(char.id, item.id);
      const isEquipped = Boolean(equippedSlotId);
      const isConsumable = item.category === ITEM_CATEGORIES.CONSUMABLE;
      const targetSlot = !isConsumable ? inventory.getSlot(item.slotType) : null;

      const card = document.createElement('div');
      card.className = `cc-item-card ${isEquipped ? 'is-equipped' : ''}`;
      card.dataset.itemId = item.id;
      card.innerHTML = `
        <div class="cc-item-head">
          <div style="min-width:0;">
            <strong>${escapeHtml(item.name)}</strong>
            <div class="cc-badge-row" style="margin-top:4px;">
              <span class="status-badge ${item.category === ITEM_CATEGORIES.OUTFIT ? 'badge-ok' : 'badge-muted'}">${escapeHtml(ITEM_CATEGORY_LABELS[item.category] || item.category)}</span>
              ${targetSlot ? `<span class="status-badge badge-muted">槽位：${escapeHtml(targetSlot.label)}</span>` : ''}
              ${isConsumable ? `<span class="status-badge badge-warn">库存 ×${item.quantity}</span>` : ''}
              ${isEquipped ? `<span class="status-badge badge-ok">已穿戴</span>` : ''}
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
            ${isConsumable ? '使用消耗品' : isEquipped ? '卸下物品' : '一键穿戴'}
          </button>
          <button type="button" class="btn-secondary" data-act="edit">编辑</button>
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
            const res = await inventory.equipItem(char.id, item.slotType, item.id);
            await saveRosterNow();
            uiKit.showToast(`已为 ${char.name} 穿戴「${item.name}」（${res.slotLabel}）`, 'ok');
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
      <h2 class="section-title">全局资源管理（${list.length} 项）</h2>
      <button type="button" id="btn-cc-add-res" class="btn-primary uikit-touch-target" style="padding:6px 12px;font-size:12.5px;">+ 新增资源</button>
    </div>
    <p class="muted-text">内置余额校验，消耗不足时自动安全拦截并提示，支持随时增删自定义资源条目。</p>
    <div class="lab-stack-sm" id="cc-res-list"></div>
  `;

  card.querySelector('#btn-cc-add-res').addEventListener('click', () => openAddResourceSheet());

  const listEl = card.querySelector('#cc-res-list');
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'lab-slot-card';
    row.dataset.resId = r.id;
    row.innerHTML = `
      <div class="lab-slot-head">
        <strong>${escapeHtml(r.name)}</strong>
        <span class="metric-value" style="font-size:17px;">${r.amount}${escapeHtml(r.unit)}</span>
      </div>
      <div class="cc-btn-3col">
        <button type="button" class="btn-secondary uikit-touch-target" data-res-act="spend">-100</button>
        <button type="button" class="btn-primary uikit-touch-target" data-res-act="add">+100</button>
        <button type="button" class="btn-danger uikit-touch-target" data-res-act="remove" ${list.length <= 1 ? 'disabled' : ''}>删除</button>
      </div>
    `;

    row.querySelector('[data-res-act="spend"]').addEventListener('click', async () => {
      const res = await resources.spend(r.id, 100, { reason: '控制台测试扣除' });
      if (!res.ok) {
        uiKit.showToast(res.reason, 'warn');
        return;
      }
      uiKit.showToast(`${r.name} -100（剩余 ${res.after}）`, 'ok');
      await renderConsole();
    });

    row.querySelector('[data-res-act="add"]').addEventListener('click', async () => {
      const res = await resources.add(r.id, 100, { reason: '控制台测试补充' });
      uiKit.showToast(`${r.name} +100（当前 ${res.after}）`, 'ok');
      await renderConsole();
    });

    row.querySelector('[data-res-act="remove"]').addEventListener('click', async () => {
      const ok = await uiKit.confirmDialog({
        title: `删除资源「${r.name}」`,
        message: '确认删除该资源条目吗？',
        confirmLabel: '确认删除',
        tone: 'danger',
      });
      if (!ok) return;
      await resources.removeResource(r.id);
      uiKit.showToast(`已删除资源：${r.name}`, 'ok');
      await renderConsole();
    });

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
        { id: LOG_CATEGORIES.EQUIPMENT, label: '穿脱装备' },
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
  const { entities, inventory, resources, statRules, uiKit } = consoleState.context;
  const roster = getCharacters();
  const char = getActiveCharacter();
  if (!char) return;

  const avatarUrl = await resolveAvatarUrl(char);
  const effStats = entities.getEffectiveStats(char.id, { round: 'round' });
  const eqBonuses = inventory.getCharacterEquipmentBonuses(char.id);
  const overallScore = statRules.computeOverallScore(effStats, eqBonuses.checkBonus);
  const affStage = statRules.getAffinityStage(char.stats.affinity ?? 0);
  const moraleMod = statRules.getMoraleModifier(char.stats.morale ?? 50);
  const resList = resources.list();

  consoleState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'cc-root';

  // 1. Character Roster Switcher Strip
  const rosterStrip = document.createElement('div');
  rosterStrip.className = 'cc-roster-strip';
  rosterStrip.id = 'cc-roster-strip';
  for (const c of roster) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `cc-roster-chip ${c.id === char.id ? 'is-active' : ''}`;
    chip.dataset.selectChar = c.id;
    chip.textContent = c.name;
    chip.addEventListener('click', async () => {
      consoleState.activeCharacterId = c.id;
      await saveRosterNow();
      await renderConsole();
    });
    rosterStrip.appendChild(chip);
  }
  const addCharBtn = document.createElement('button');
  addCharBtn.type = 'button';
  addCharBtn.id = 'btn-cc-new-char';
  addCharBtn.className = 'cc-roster-chip is-add';
  addCharBtn.textContent = '+ 新建角色';
  addCharBtn.addEventListener('click', () => openCharacterEditorSheet(null));
  rosterStrip.appendChild(addCharBtn);
  root.appendChild(rosterStrip);

  // 2. Top Core Status Card (Hero + Dynamic Bars + Resource Summary + Quick Modals)
  const heroCard = document.createElement('section');
  heroCard.className = 'surface-card lab-stack-sm';
  heroCard.id = 'cc-hero-card';
  heroCard.innerHTML = `
    <div class="cc-hero-row">
      <img class="cc-avatar" id="cc-active-avatar" src="${avatarUrl}" alt="${escapeHtml(char.name)} 头像">
      <div class="cc-hero-info">
        <div class="cc-hero-name-row">
          <h2 class="cc-hero-name" id="cc-active-name">${escapeHtml(char.name)}</h2>
          <span class="status-badge badge-ok" id="cc-overall-score">综合评分 ${overallScore}</span>
        </div>
        <div class="cc-badge-row">
          <span class="status-badge badge-muted">${escapeHtml(char.meta?.roleTag || '通用型')}</span>
          <span class="status-badge badge-ok" id="cc-affinity-badge">好感 · ${escapeHtml(affStage.label)} (${affStage.value})</span>
        </div>
      </div>
    </div>

    <div id="cc-dynamic-bars" class="lab-stack-sm"></div>

    <div class="cc-resource-strip" id="cc-resource-summary">
      ${resList
        .slice(0, 4)
        .map(
          (r) => `
        <div class="cc-resource-pill">
          <span class="cc-resource-pill-label">${escapeHtml(r.name)}</span>
          <span class="cc-resource-pill-val">${r.amount}${escapeHtml(r.unit)}</span>
        </div>
      `
        )
        .join('')}
    </div>

    <div class="cc-btn-3col">
      <button type="button" id="btn-cc-open-check" class="btn-primary uikit-touch-target">模拟检定</button>
      <button type="button" id="btn-cc-open-rules" class="btn-secondary uikit-touch-target">数值规则</button>
      <button type="button" id="btn-cc-edit-char" class="btn-secondary uikit-touch-target">编辑角色</button>
    </div>
  `;

  const barsMount = heroCard.querySelector('#cc-dynamic-bars');
  const maxHp = Number(char.stats.maxHp ?? 100);
  const maxAp = Number(char.stats.maxAp ?? 100);
  barsMount.appendChild(
    uiKit.createProgressBar({
      label: '生命 / 耐久 (HP)',
      value: char.stats.hp ?? 100,
      max: maxHp,
      tone: (char.stats.hp ?? 100) / maxHp < 0.3 ? 'danger' : 'accent',
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

  heroCard.querySelector('#btn-cc-open-check').addEventListener('click', () => openCheckSimulatorSheet(char));
  heroCard.querySelector('#btn-cc-open-rules').addEventListener('click', () => openStatRulesSheet());
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
  description: '通用角色管理、五维面板与 1D20 检定、背包与服装/装备穿戴、资源管理及行动日志控制台。',

  mount(container, context) {
    consoleState.container = container;
    consoleState.context = context;
    consoleState.avatarUrlCache.clear();

    // Ensure roster exists even if storage was just cleared
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
        id: 'cc-quick-check',
        label: '模拟检定',
        onClick: () => openCheckSimulatorSheet(getActiveCharacter()),
      },
      {
        id: 'cc-quick-new-item',
        label: '新建服装/装备',
        onClick: () => openItemEditorSheet(null),
      },
      {
        id: 'cc-quick-rules',
        label: '数值规则',
        onClick: () => openStatRulesSheet(),
      },
      {
        id: 'cc-quick-logs',
        label: '导出日志摘要',
        onClick: () => openLogExportSheet(),
      },
    ]);

    consoleState.unsubs = [
      context.bus.on('stat-rules:changed', () => renderConsole()),
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
