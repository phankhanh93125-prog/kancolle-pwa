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
  ITEM_RARITY_MAP,
  KNOWN_EQUIPMENT_TYPES,
  KNOWN_EQUIPMENT_TYPE_DEFS,
  KNOWN_EQUIPMENT_TYPE_MAP,
  NAVAL_EIGHT_STAT_DEFS,
  NAVAL_EIGHT_STAT_MAP,
  SHIP_TYPE_PRESETS,
  getShipClassProfile,
  getShipClassSvg,
  inferEquipmentTypeId,
  inferItemRarity,
  resolveShipClass,
} from '../core/stat-rules.js';
import {
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  WAREHOUSE_GROUPS,
  WAREHOUSE_GROUP_DEFS,
  classifyItemWarehouseGroup,
  getItemIconSvg,
} from '../core/inventory-system.js';
import {
  CORE_CURRENCY_IDS,
  CORE_RESOURCE_IDS,
  createResourceOverviewBar,
} from '../core/resource-manager.js';
import { LOG_CATEGORIES, LOG_CATEGORY_LABELS } from '../core/log-system.js';
import { COMMANDER_STAT_DEFS } from '../core/commander-system.js';
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
      maxHp: 24,
      hp: 24,
      firepower: 13,
      armor: 10,
      torpedo: 23,
      evasion: 24,
      recon: 17,
      aa: 15,
      asw: 22,
      morale: 78,
      ap: 90,
      maxAp: 100,
      affinity: 52,
      level: 1,
      exp: 0,
      maxExp: 100,
    },
    statBounds: {
      hp: { min: 0, max: 500 },
      morale: { min: 0, max: 100 },
      ap: { min: 0, max: 100 },
      affinity: { min: 0, max: 100 },
    },
    meta: {
      shipType: '驱逐舰',
      roleTag: '高机动雷击反潜',
      avatarAssetId: null,
      statScaleVersion: 2,
      lv1BaseStats: { maxHp: 24, firepower: 13, armor: 10, torpedo: 23, evasion: 24, recon: 17, aa: 15, asw: 22 },
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
      maxHp: 28,
      hp: 28,
      firepower: 17,
      armor: 15,
      torpedo: 18,
      evasion: 20,
      recon: 20,
      aa: 20,
      asw: 19,
      morale: 82,
      ap: 90,
      maxAp: 100,
      affinity: 42,
      level: 1,
      exp: 0,
      maxExp: 100,
    },
    statBounds: {
      hp: { min: 0, max: 500 },
      morale: { min: 0, max: 100 },
      ap: { min: 0, max: 100 },
      affinity: { min: 0, max: 100 },
    },
    meta: {
      shipType: '轻巡洋舰',
      roleTag: '均衡侦查防空',
      avatarAssetId: null,
      statScaleVersion: 2,
      lv1BaseStats: { maxHp: 28, firepower: 17, armor: 15, torpedo: 18, evasion: 20, recon: 20, aa: 20, asw: 19 },
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
      maxHp: 42,
      hp: 42,
      firepower: 25,
      armor: 25,
      torpedo: 8,
      evasion: 11,
      recon: 15,
      aa: 20,
      asw: 8,
      morale: 76,
      ap: 90,
      maxAp: 100,
      affinity: 38,
      level: 1,
      exp: 0,
      maxExp: 100,
    },
    statBounds: {
      hp: { min: 0, max: 500 },
      morale: { min: 0, max: 100 },
      ap: { min: 0, max: 100 },
      affinity: { min: 0, max: 100 },
    },
    meta: {
      shipType: '战列舰',
      roleTag: '主力重炮重甲',
      avatarAssetId: null,
      statScaleVersion: 2,
      lv1BaseStats: { maxHp: 42, firepower: 25, armor: 25, torpedo: 8, evasion: 11, recon: 15, aa: 20, asw: 8 },
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
export async function hydrateCharacterRoster({
  storage,
  entities,
  inventory,
  statRules,
  commander = null,
  personalityPool = null,
}) {
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
        if (personalityPool && typeof personalityPool.ensurePersonalityOnEntity === 'function') {
          personalityPool.ensurePersonalityOnEntity(reg);
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
    if (personalityPool && typeof personalityPool.ensurePersonalityOnEntity === 'function') {
      personalityPool.ensurePersonalityOnEntity(reg);
    }
  }
  await equipStarterCorePartsIfPresent(inventory, 'char_template_01', true);
  await equipStarterCorePartsIfPresent(inventory, 'char_template_02', false);
  await equipStarterCorePartsIfPresent(inventory, 'char_template_03', false);

  // Equip a starter typed expanded Sonar slot carrying dynamic extended attribute ('夜战修正') on ship #1
  if (inventory.getItem('item_ext_02')) {
    const slot = await inventory.addExpandedSlot('char_template_01', KNOWN_EQUIPMENT_TYPES.SONAR);
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

/**
 * Open a shipgirl's details in a sleek Centered Frosted-Glass Tactical Modal over the Central Main Stage,
 * with live 8-stat breakdown, ship-class slot cap (`used/max`), and slide-up Bottom Sheets for equip/slot expansion.
 * Pass `{ fullScreen: true }` to mount the full `character-console` module directly.
 */
export function openCharacterCardById(characterId, context = {}, { fullScreen = false } = {}) {
  const cid = String(characterId || '');
  if (!cid) return;
  consoleState.activeCharacterId = cid;
  consoleState.activeTab = 'overview';

  if (context.rootStorage) {
    context.rootStorage.namespace(CHAR_STORAGE_NS).set('activeCharacterId', cid);
  }

  if (context.bus) {
    const entity = context.entities?.get(cid);
    context.bus.emit('character:selected', { characterId: cid, name: entity?.name || '' });
  }

  const activeId = context.modules?.getActiveId ? context.modules.getActiveId() : null;
  const shouldOpenFloating =
    !fullScreen &&
    activeId !== 'character-console' &&
    context.uiKit &&
    typeof context.uiKit.openTacticalModal === 'function' &&
    context.entities &&
    context.inventory &&
    context.statRules;

  if (shouldOpenFloating) {
    const {
      entities,
      inventory,
      resources,
      statRules,
      assets,
      buildings,
      interaction,
      personalityPool,
      rootStorage,
      modules,
      uiKit,
    } = context;
    const targetChar = entities.get(cid);
    if (!targetChar) return;

    uiKit.openTacticalModal({
      title: `舰娘战术档案 · ${targetChar.name}`,
      subtitle: `${targetChar.meta?.shipType || '驱逐舰'} · 点槽位滑出底部抽屉换装或扩建`,
      wide: true,
      renderContent: (body, closeModal) => {
        const renderDetailBody = async () => {
          const ch = entities.get(cid);
          if (!ch) {
            closeModal();
            return;
          }
          const prog = statRules.ensureShipProgression(ch);
          const breakdown = inventory.getCharacterStatBreakdown(ch.id);
          const seaworthy = inventory.checkSeaworthiness(ch.id);
          const slots = inventory.getCharacterSlots(ch.id);
          const equippedMap = inventory.getCharacterEquipment(ch.id);
          const capInfo = inventory.getCharacterSlotCapInfo(ch.id);
          const shipClass = resolveShipClass(ch.meta?.shipType);
          const combo = personalityPool ? personalityPool.ensurePersonalityOnEntity(ch) : ch.meta?.personalityCombo || null;
          const isSec = interaction?.getSecretaryId?.() === ch.id;
          const inDorm = buildings?.isInDormitory?.(ch.id) || false;
          const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(ch.id, 'maxHp', { round: 'round' }).final));
          const curHp = Math.min(effMaxHp, Math.round(Number(ch.stats.hp ?? effMaxHp)));
          let avatarUrl = '';
          if (assets) {
            const av = await assets.getAssetUrl(ch.meta?.avatarAssetId || null, {
              fallbackSeed: ch.id,
              fallbackLabel: ch.name.slice(0, 6),
            });
            avatarUrl = av.url;
          }

          body.innerHTML = `
            <div class="module-stack" id="tactical-ship-detail-body">
              <div class="cc-hero-row">
                ${avatarUrl ? `<img class="cc-avatar" src="${avatarUrl}" alt="${escapeHtml(ch.name)}">` : ''}
                <div class="cc-hero-info">
                  <div class="cc-hero-name-row">
                    <span class="ship-class-ico">${getShipClassSvg(shipClass, { size: 20 })}</span>
                    <h3 class="cc-hero-name">${escapeHtml(ch.name)}</h3>
                    <span class="status-badge ship-lv-badge">Lv.${prog.level}</span>
                    ${ch.meta?.locked ? '<span class="status-badge badge-warn ship-lock-badge">🔒 已锁定</span>' : ''}
                    <span class="status-badge ${seaworthy.seaworthy ? 'badge-ok' : 'badge-danger'}">${seaworthy.seaworthy ? '适航' : '未适航'}</span>
                  </div>
                  <div class="cc-badge-row">
                    <span class="status-badge badge-muted">${escapeHtml(ch.meta?.shipType || shipClass)}</span>
                    ${combo ? `<span class="status-badge badge-warn">${escapeHtml(combo.comboLabel)}</span>` : ''}
                    <span class="status-badge badge-muted">HP ${curHp}/${effMaxHp} · 士气 ${Math.round(Number(ch.stats.morale ?? 70))} · 好感 ${Math.round(Number(ch.stats.affinity ?? 0))}</span>
                  </div>
                </div>
              </div>

              <div class="tm-stat-8-grid">
                ${breakdown.standardStats
                  .map(
                    (st) => `
                  <div class="tm-stat-cell">
                    <span class="tm-stat-k">${escapeHtml(st.shortLabel)}</span>
                    <strong class="tm-stat-v">${st.total}${st.bonus > 0 ? `<small class="stat-diff-inline-up">+${st.bonus}</small>` : ''}</strong>
                  </div>
                `
                  )
                  .join('')}
              </div>

              <div class="lab-btn-grid">
                <button type="button" id="btn-tm-auto-equip" class="btn-primary uikit-touch-target">一键最优配装</button>
                <button type="button" id="btn-tm-expand-slot" class="btn-secondary uikit-touch-target" ${capInfo.canExpand ? '' : 'disabled'}>
                  ${capInfo.canExpand ? `+ 扩建槽位 (${capInfo.used}/${capInfo.max})` : `槽位已满 (${capInfo.used}/${capInfo.max})`}
                </button>
                <button type="button" id="btn-tm-toggle-dorm" class="btn-secondary uikit-touch-target">
                  ${inDorm ? '移出宿舍' : '入住宿舍'}
                </button>
                <button type="button" id="btn-tm-set-sec" class="btn-secondary uikit-touch-target" ${isSec ? 'disabled' : ''}>
                  ${isSec ? '★ 当前秘书舰' : '设为秘书舰'}
                </button>
              </div>
              <button type="button" id="btn-tm-toggle-lock" class="${ch.meta?.locked ? 'btn-primary' : 'btn-secondary'} uikit-touch-target">
                ${ch.meta?.locked ? '🔓 解除舰娘锁定保护' : '🔒 锁定舰娘（防止误删/退役）'}
              </button>

              <div class="lab-stack-sm">
                <div class="section-header-row" style="margin-bottom:0;">
                  <strong style="font-size:13px;">装备与扩展槽位（${capInfo.shipClass} 扩建上限 ${capInfo.used}/${capInfo.max}）</strong>
                  <span class="muted-text" style="font-size:11px;">点选槽位唤出底部抽屉</span>
                </div>
                ${slots
                  .map((s) => {
                    const item = equippedMap[s.id];
                    const rId = item ? inferItemRarity(item) : null;
                    const rDef = rId ? ITEM_RARITY_MAP[rId] : null;
                    return `
                  <div class="cc-slot-card ${rId ? `is-rarity-${rId}` : ''}" style="padding:9px 10px;">
                    <div class="lab-slot-head">
                      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                        <span class="status-badge ${s.required ? (item ? 'badge-ok' : 'badge-danger') : s.custom ? 'badge-ok' : 'badge-muted'}">
                          ${escapeHtml(s.label)}
                        </span>
                        ${rDef ? `<span class="rarity-pill is-rarity-${rId}">${escapeHtml(rDef.shortLabel)}</span>` : ''}
                        <strong style="font-size:12.5px;">${item ? escapeHtml(formatItemTitle(item)) : '空槽'}</strong>
                      </div>
                      <div style="display:flex; gap:5px;">
                        <button type="button" class="btn-secondary" style="min-height:34px; padding:0 10px; font-size:12px;" data-tm-pick-slot="${escapeHtml(s.id)}">${item ? '更换' : '装入'}</button>
                        ${s.custom ? `<button type="button" class="btn-secondary" style="min-height:34px; padding:0 8px; font-size:11.5px;" data-tm-change-slot="${escapeHtml(s.id)}">改型</button>` : ''}
                        ${item ? `<button type="button" class="btn-danger" style="min-height:34px; padding:0 8px; font-size:11.5px;" data-tm-unequip-slot="${escapeHtml(s.id)}">卸下</button>` : ''}
                      </div>
                    </div>
                  </div>
                `;
                  })
                  .join('')}
              </div>

              <button type="button" id="btn-tm-open-full-cc" class="btn-secondary uikit-touch-target">
                进入全屏精修角色台（编辑白值/性格/检定/日志）
              </button>
            </div>
          `;

          body.querySelector('#btn-tm-auto-equip')?.addEventListener('click', async () => {
            const res = await inventory.autoEquipCharacter(ch.id, { includeOutfit: true });
            if (rootStorage) await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: ch.id });
            uiKit.showToast(
              res.equippedCount > 0 ? `已为「${ch.name}」自动配装 ${res.equippedCount} 件最优装备` : '当前槽位已是最优配装',
              res.equippedCount > 0 ? 'ok' : 'info'
            );
            await renderDetailBody();
          });

          body.querySelector('#btn-tm-expand-slot')?.addEventListener('click', () => {
            openAddCustomSlotSheet(ch, {
              contextOverride: context,
              onUpdated: () => renderDetailBody(),
            });
          });

          body.querySelector('#btn-tm-toggle-dorm')?.addEventListener('click', async () => {
            if (!buildings) return;
            try {
              if (buildings.isInDormitory(ch.id)) {
                await buildings.removeDormResident(ch.id);
                uiKit.showToast(`「${ch.name}」已移出宿舍`, 'info');
              } else {
                await buildings.assignDormResident(ch.id);
                uiKit.showToast(`「${ch.name}」已入住港区宿舍`, 'ok');
              }
              await renderDetailBody();
            } catch (err) {
              uiKit.showToast(err instanceof Error ? err.message : '宿舍操作失败', 'warn');
            }
          });

          body.querySelector('#btn-tm-set-sec')?.addEventListener('click', async () => {
            if (!interaction) return;
            await interaction.setSecretary(ch.id);
            uiKit.showToast(`已指派「${ch.name}」担任秘书舰！`, 'ok');
            await renderDetailBody();
          });

          body.querySelector('#btn-tm-toggle-lock')?.addEventListener('click', async () => {
            if (!ch.meta) ch.meta = {};
            ch.meta.locked = !ch.meta.locked;
            if (rootStorage) await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: ch.id });
            uiKit.showToast(
              ch.meta.locked ? `🔒 已锁定舰娘「${ch.name}」，禁止误删或退役` : `🔓 已解除舰娘「${ch.name}」锁定`,
              'info'
            );
            await renderDetailBody();
          });

          body.querySelectorAll('[data-tm-pick-slot]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const sid = btn.getAttribute('data-tm-pick-slot');
              const slotObj = inventory.getCharacterSlot(ch.id, sid);
              if (slotObj) {
                openSlotEquipPickerSheet(ch, slotObj, {
                  contextOverride: context,
                  onUpdated: () => renderDetailBody(),
                });
              }
            });
          });

          body.querySelectorAll('[data-tm-change-slot]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const sid = btn.getAttribute('data-tm-change-slot');
              const slotObj = inventory.getCharacterSlot(ch.id, sid);
              if (slotObj) {
                openRenameCustomSlotSheet(ch, slotObj, {
                  contextOverride: context,
                  onUpdated: () => renderDetailBody(),
                });
              }
            });
          });

          body.querySelectorAll('[data-tm-unequip-slot]').forEach((btn) => {
            btn.addEventListener('click', async () => {
              const sid = btn.getAttribute('data-tm-unequip-slot');
              await inventory.unequipSlot(ch.id, sid);
              if (rootStorage) await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: ch.id });
              uiKit.showToast('已卸下该槽位装备', 'info');
              await renderDetailBody();
            });
          });

          body.querySelector('#btn-tm-open-full-cc')?.addEventListener('click', () => {
            closeModal();
            if (modules && modules.has('character-console')) {
              modules.mount('character-console');
            }
          });
        };

        renderDetailBody();
      },
    });
    return;
  }

  // Fallback / Full-screen mode
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.uikit-sheet-backdrop').forEach((el) => el.remove());
    const shellBackdrop = document.getElementById('sheet-backdrop');
    if (shellBackdrop) shellBackdrop.hidden = true;
  }

  if (context.modules && context.modules.has('character-console')) {
    if (context.modules.getActiveId && context.modules.getActiveId() === 'character-console') {
      renderConsole();
    } else {
      context.modules.mount('character-console');
    }
  }
}

export function resetCharacterConsoleState(storage = null) {
  consoleState.activeCharacterId = null;
  consoleState.expandedWarehouseItemId = null;
  consoleState.avatarUrlCache.clear();
  if (storage) {
    storage.namespace(CHAR_STORAGE_NS).remove('activeCharacterId');
  }
}

export async function persistCharacterRoster({ storage, entities, activeCharacterId = null }) {
  const scope = storage.namespace(CHAR_STORAGE_NS);
  const currentChars = entities.list({ kind: 'character' });
  const currentIds = new Set(currentChars.map((c) => c.id));
  const candidateId = activeCharacterId || consoleState.activeCharacterId;
  const resolvedActiveId = (candidateId && currentIds.has(candidateId) ? candidateId : currentChars[0]?.id) || null;
  consoleState.activeCharacterId = resolvedActiveId;
  if (resolvedActiveId) {
    scope.set('activeCharacterId', resolvedActiveId);
  } else {
    scope.remove('activeCharacterId');
  }
  const characters = currentChars.map((e) => ({
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
  warehouseGroup: WAREHOUSE_GROUPS.ALL,
  warehouseEquipStatus: 'all',
  expandedWarehouseItemId: null,
  logCategoryFilter: 'all',
  tabsCtrl: null,
  avatarUrlCache: new Map(),
  unsubs: [],
};

function openPersonalityPoolSheet() {
  const { personalityPool, uiKit } = consoleState.context || {};
  if (!personalityPool) return;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  let activePoolTab = 'primary';

  const renderPool = () => {
    const primaryList = personalityPool.listPrimary();
    const secondaryList = personalityPool.listSecondary();
    const isPri = activePoolTab === 'primary';
    const rows = isPri ? primaryList : secondaryList;

    wrap.innerHTML = `
      <div class="lab-btn-grid">
        <button type="button" class="${isPri ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-pp-tab="primary">
          主性格池 (${primaryList.length})
        </button>
        <button type="button" class="${!isPri ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-pp-tab="secondary">
          副特质/口癖池 (${secondaryList.length})
        </button>
      </div>

      <div class="surface-card lab-stack-sm" style="padding:10px;">
        <strong style="font-size:13px;">+ 新增自定义${isPri ? '主性格' : '副特质/口癖'}词条</strong>
        <div class="lab-kv-grid">
          <input id="pp-new-name" class="form-input" type="text" placeholder="${isPri ? '性格名（如：病娇/豪爽）' : '特质名（如：路痴/摄影控）'}">
          <input id="pp-new-extra" class="form-input" type="text" placeholder="${isPri ? '语气前缀（如：哈哈，）' : '专属口癖短句'}">
        </div>
        <input id="pp-new-summary" class="form-input" type="text" placeholder="性格简介描述（可选）">
        <button type="button" id="btn-pp-add" class="btn-primary uikit-touch-target">添加到${isPri ? '主性格池' : '副特质池'}</button>
      </div>

      <div class="lab-stack-sm" id="pp-entries-list">
        ${rows
          .map(
            (r) => `
          <div class="lab-slot-card">
            <div class="lab-slot-head">
              <strong>${escapeHtml(r.name)}</strong>
              <span class="status-badge ${r.builtIn ? 'badge-muted' : 'badge-ok'}">${r.builtIn ? '内置' : '自定义'}</span>
            </div>
            <p class="muted-text" style="font-size:11.5px; margin:0;">${escapeHtml(r.summary || '')}</p>
            ${
              isPri
                ? `<span class="cc-stat-sub">语气：${escapeHtml(r.speechPrefix || '—')} … ${escapeHtml(r.speechSuffix || '—')}</span>`
                : `<span class="cc-stat-sub">口癖：「${escapeHtml(r.catchphrase || '')}」</span>`
            }
            ${
              !r.builtIn
                ? `<button type="button" class="btn-danger uikit-touch-target" data-pp-del="${escapeHtml(r.id)}" style="margin-top:4px;">删除词条</button>`
                : ''
            }
          </div>
        `
          )
          .join('')}
      </div>
    `;

    wrap.querySelectorAll('[data-pp-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activePoolTab = btn.getAttribute('data-pp-tab');
        renderPool();
      });
    });

    wrap.querySelector('#btn-pp-add').addEventListener('click', async () => {
      const name = wrap.querySelector('#pp-new-name').value.trim();
      const extra = wrap.querySelector('#pp-new-extra').value.trim();
      const summary = wrap.querySelector('#pp-new-summary').value.trim();
      if (!name) {
        uiKit.showToast('请输入词条名称', 'warn');
        return;
      }
      try {
        if (isPri) {
          await personalityPool.addPrimary({ name, speechPrefix: extra, summary });
        } else {
          await personalityPool.addSecondary({ name, catchphrase: extra || `总是忍不住「${name}」呢。`, summary });
        }
        uiKit.showToast(`已新增${isPri ? '主性格' : '副特质'}「${name}」`, 'ok');
        renderPool();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '添加失败', 'warn');
      }
    });

    wrap.querySelectorAll('[data-pp-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-pp-del');
        try {
          if (isPri) await personalityPool.deletePrimary(id);
          else await personalityPool.deleteSecondary(id);
          uiKit.showToast('已删除自定义性格词条', 'info');
          renderPool();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '删除失败', 'warn');
        }
      });
    });
  };

  renderPool();
  uiKit.openBottomSheet({
    title: '本地性格词库管理（主性格 × 副特质）',
    subtitle: '船坞建造或点击「随机性格」将从此词库自动组合抽取，实现同舰不同性格',
    content: wrap,
    actions: [{ id: 'close', label: '完成', tone: 'secondary' }],
  });
}

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

function buildEquipmentTypePickerMarkup(inventory, { currentTypeId = null } = {}) {
  const allItems = inventory.listItems().filter((it) => it.category !== ITEM_CATEGORIES.CONSUMABLE && it.category !== ITEM_CATEGORIES.OUTFIT);
  const countByType = {};
  for (const it of allItems) {
    const tid = inferEquipmentTypeId(it, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
    countByType[tid] = (countByType[tid] || 0) + 1;
  }

  const groups = ['主战武器', '战术辅助', '核心三件套'];
  return groups
    .map((groupName) => {
      const defs = KNOWN_EQUIPMENT_TYPE_DEFS.filter((d) => d.group === groupName);
      return `
        <div class="lab-stack-sm">
          <strong style="font-size:12.5px; color:var(--accent-hover);">${escapeHtml(groupName)}</strong>
          <div class="nj-option-grid">
            ${defs
              .map((d) => {
                const isCur = currentTypeId === d.id;
                const stock = countByType[d.id] || 0;
                return `
                  <button
                    type="button"
                    class="nj-option-card ${isCur ? 'is-selected' : ''}"
                    data-pick-eq-type="${escapeHtml(d.id)}"
                  >
                    <div class="nj-option-top">
                      <span style="display:inline-flex; align-items:center; gap:6px;">
                        <span class="wh-item-ico">${getItemIconSvg({ category: d.category, subGroup: d.subGroup, iconKey: d.defaultIcon }, { size: 18, iconKey: d.defaultIcon })}</span>
                        <strong>${escapeHtml(d.label)}</strong>
                      </span>
                      <span class="status-badge ${stock > 0 ? 'badge-ok' : 'badge-muted'}">库存 ${stock}</span>
                    </div>
                    <span class="nj-option-desc">${escapeHtml(d.desc)}</span>
                  </button>
                `;
              })
              .join('')}
          </div>
        </div>
      `;
    })
    .join('');
}

function buildSlotCostCompareHtml(cost = {}, resources = null) {
  const keys = [
    { id: 'steel', label: '钢材' },
    { id: 'bauxite', label: '铝材' },
    { id: 'silver', label: '银条' },
  ];
  return keys
    .filter((k) => Number(cost[k.id]) > 0)
    .map((k) => {
      const need = Math.round(Number(cost[k.id]) || 0);
      const have = Math.floor(Number(resources?.get(k.id)?.amount ?? 0));
      const ok = have >= need;
      return `<span class="status-badge ${ok ? 'badge-ok' : 'badge-danger'}">${k.label} ${need}/${have}</span>`;
    })
    .join('');
}

function openAddCustomSlotSheet(char, { contextOverride = null, onUpdated = null } = {}) {
  if (!char) return;
  const ctx = contextOverride || consoleState.context;
  if (!ctx) return;
  const { inventory, resources, uiKit, logs } = ctx;
  const capInfo = inventory.getCharacterSlotCapInfo(char.id);
  const cost = capInfo.expansionCost;
  const permitQty = Number(inventory.getItem('item_permit_slot_expand')?.quantity || 0);
  const afford = permitQty > 0 ? { ok: true } : resources ? resources.canAfford(cost) : { ok: true };
  const blocked = !capInfo.canExpand || !afford.ok;

  uiKit.openBottomSheet({
    title: `扩建「${char.name}」装备槽位（${capInfo.used}/${capInfo.max}）`,
    subtitle: `${capInfo.shipClass} 舰种最多可扩建 ${capInfo.max} 个专属槽位（核心三槽之外）`,
    renderContent: (body, close) => {
      body.innerHTML = `
        <div class="module-stack" id="cc-expand-slot-picker">
          <div class="surface-card lab-stack-sm" style="padding:10px;">
            <div class="lab-slot-head">
              <strong style="font-size:12.5px;">${permitQty > 0 ? '🎟 已持有扩建许可（本次免费免材料）' : '本次扩建所需材料（需求 / 当前库存）'}</strong>
              <span class="status-badge ${capInfo.canExpand ? 'badge-ok' : 'badge-danger'}">
                已扩建 ${capInfo.used} / ${capInfo.max}
              </span>
            </div>
            ${
              permitQty > 0
                ? `<div class="cc-badge-row"><span class="status-badge badge-ok">自定义装备槽位扩建许可 ×${permitQty}（优先消耗 1 张）</span></div>`
                : `<div class="cc-badge-row">${buildSlotCostCompareHtml(cost, resources)}</div>`
            }
            ${
              !capInfo.canExpand
                ? `<div class="seaworthy-alert" style="margin:0;">该舰种（${escapeHtml(capInfo.shipClass)}）自定义槽位已达上限（${capInfo.used}/${capInfo.max}），可先拆除或变更已有槽位类型。</div>`
                : !afford.ok
                ? '<div class="seaworthy-alert" style="margin:0;">扩建材料不足，可补充钢材/铝材/银条或前往「设施 → 港区特许处」兑换扩建许可。</div>'
                : '<span class="muted-text" style="font-size:11.5px;">点击下方任意装备类型即可完成扩建，穿戴时精准匹配同类型装备。</span>'
            }
          </div>
          ${buildEquipmentTypePickerMarkup(inventory)}
        </div>
      `;

      body.querySelectorAll('[data-pick-eq-type]').forEach((btn) => {
        if (blocked) {
          btn.disabled = true;
          btn.classList.add('is-disabled-card');
          return;
        }
        btn.addEventListener('click', async () => {
          const typeId = btn.getAttribute('data-pick-eq-type');
          try {
            const slot = await inventory.addExpandedSlot(char.id, typeId, { resources });
            if (logs) {
              logs.add({
                category: LOG_CATEGORIES.EQUIPMENT,
                actorId: char.id,
                actorName: char.name,
                title: `[${char.name}] 扩建装备槽位「${slot.label}」`,
                detail: slot.usedPermit
                  ? `消耗槽位扩建许可 ×1 · 进度 ${capInfo.used + 1}/${capInfo.max}`
                  : `消耗 钢${cost.steel}/铝${cost.bauxite}/银${cost.silver} · 进度 ${capInfo.used + 1}/${capInfo.max}`,
              });
            }
            uiKit.showToast(
              slot.usedPermit
                ? `已使用扩建许可为「${char.name}」免费扩建「${slot.label}」！`
                : `已为「${char.name}」扩建「${slot.label}」（${capInfo.used + 1}/${capInfo.max}）`,
              'ok'
            );
            close();
            if (typeof onUpdated === 'function') await onUpdated();
            else await renderConsole();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '扩建槽位失败', 'warn');
          }
        });
      });
    },
    actions: [{ id: 'close', label: '关闭', tone: 'secondary' }],
  });
}

function openRenameCustomSlotSheet(char, slot, { contextOverride = null, onUpdated = null } = {}) {
  const ctx = contextOverride || consoleState.context;
  if (!ctx) return;
  const { inventory, resources, entities, rootStorage, uiKit } = ctx;
  const currentTypeId = slot.equipmentType || inferEquipmentTypeId(slot, KNOWN_EQUIPMENT_TYPES.MAIN_GUN);
  const capInfo = inventory.getCharacterSlotCapInfo(char.id);
  const cost = capInfo.changeCost;
  const afford = resources ? resources.canAfford(cost) : { ok: true };

  uiKit.openBottomSheet({
    title: `变更槽位类型 · ${slot.label}`,
    subtitle: '切换为其他已知装备类型；原槽位不兼容装备将自动安全退回仓库',
    renderContent: (body, close) => {
      body.innerHTML = `
        <div class="module-stack" id="cc-change-slot-type-picker">
          <div class="surface-card lab-stack-sm" style="padding:10px;">
            <strong style="font-size:12.5px;">变更槽位类型所需材料（需求 / 当前库存）</strong>
            <div class="cc-badge-row">${buildSlotCostCompareHtml(cost, resources)}</div>
            ${!afford.ok ? '<div class="seaworthy-alert" style="margin:0;">改造材料不足，无法变更槽位类型。</div>' : ''}
          </div>
          ${buildEquipmentTypePickerMarkup(inventory, { currentTypeId })}
        </div>
      `;

      body.querySelectorAll('[data-pick-eq-type]').forEach((btn) => {
        const nextTypeId = btn.getAttribute('data-pick-eq-type');
        if (!afford.ok && nextTypeId !== currentTypeId) {
          btn.disabled = true;
          btn.classList.add('is-disabled-card');
          return;
        }
        btn.addEventListener('click', async () => {
          if (nextTypeId === currentTypeId) {
            close();
            return;
          }
          try {
            const res = await inventory.changeExpandedSlotType(char.id, slot.id, nextTypeId, { resources });
            if (rootStorage && entities) {
              await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
            } else {
              await saveRosterNow();
            }
            uiKit.showToast(
              res.unequippedItem
                ? `槽位已变更为「${res.slot.label}」，原装备「${res.unequippedItem.name}」已退回仓库`
                : `槽位已变更为「${res.slot.label}」`,
              'ok'
            );
            close();
            if (typeof onUpdated === 'function') await onUpdated();
            else await renderConsole();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '变更槽位类型失败', 'warn');
          }
        });
      });
    },
    actions: [{ id: 'close', label: '关闭', tone: 'secondary' }],
  });
}

function openSlotEquipPickerSheet(char, slot, { contextOverride = null, onUpdated = null } = {}) {
  const ctx = contextOverride || consoleState.context;
  if (!ctx) return;
  const { inventory, entities, rootStorage, uiKit } = ctx;
  const compatibleItems = inventory.getSlotCompatibleItems(char.id, slot.id);
  const slotTypeId = slot.equipmentType || (slot.id === 'outfit' ? 'outfit' : inferEquipmentTypeId(slot, KNOWN_EQUIPMENT_TYPES.MAIN_GUN));
  const slotTypeLabel = slotTypeId === 'outfit' ? '服装' : KNOWN_EQUIPMENT_TYPE_MAP[slotTypeId]?.label || slot.label;

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  let sheetHandle = null;

  if (compatibleItems.length === 0) {
    wrap.innerHTML = `<p class="muted-text">仓库中暂无【${escapeHtml(slotTypeLabel)}】类型的可用装备，请前往「仓库图鉴 → + 新建装备/服装」制作或通过出征掉落获取。</p>`;
  } else {
    const list = document.createElement('div');
    list.className = 'lab-stack-sm';
    for (const item of compatibleItems) {
      const currentSlot = inventory.getEquippedSlotOfItem(char.id, item.id);
      const isHere = currentSlot === slot.id;
      const wearers = inventory.getWearersOfItem(item.id);
      const rarityId = inferItemRarity(item);
      const rDef = ITEM_RARITY_MAP[rarityId] || ITEM_RARITY_MAP.common;
      const diffRes =
        !isHere && typeof inventory.previewEquipStatDiff === 'function'
          ? inventory.previewEquipStatDiff(char.id, slot.id, item.id)
          : { diffs: [] };

      const diffHtml =
        diffRes.diffs.length > 0
          ? `<div class="stat-diff-row">
              ${diffRes.diffs
                .map(
                  (d) =>
                    `<span class="stat-diff-pill ${d.delta > 0 ? 'is-up' : 'is-down'}">${escapeHtml(d.shortLabel)} ${
                      d.delta > 0 ? `+${d.delta}` : d.delta
                    }</span>`
                )
                .join('')}
            </div>`
          : isHere
          ? '<span class="muted-text" style="font-size:11px;">当前槽位已穿戴此装备</span>'
          : '<span class="muted-text" style="font-size:11px;">八维属性无增减变化</span>';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `lab-choice-btn is-rarity-${rarityId}`;
      btn.dataset.pickItemId = item.id;
      btn.innerHTML = `
        <span class="lab-choice-title" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span class="wh-item-ico">${getItemIconSvg(item, { size: 18 })}</span>
          <span class="rarity-pill is-rarity-${rarityId}">${escapeHtml(rDef.shortLabel)}</span>
          <span>${escapeHtml(formatItemTitle(item))}${isHere ? '（当前已装）' : ''}</span>
          ${wearers.length && !isHere ? `<span class="status-badge badge-muted" style="font-size:10.5px;">已装:${escapeHtml(wearers[0].name.slice(0, 5))}</span>` : ''}
        </span>
        <span class="lab-choice-sub">${
          item.bonuses?.length ? escapeHtml(item.bonuses.map(formatBonusChip).join(' · ')) : '无属性词条'
        }</span>
        ${diffHtml}
      `;
      btn.addEventListener('click', async () => {
        try {
          await inventory.equipItem(char.id, slot.id, item.id);
          if (rootStorage && entities) {
            await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
          } else {
            await saveRosterNow();
          }
          if (sheetHandle) sheetHandle.close();
          uiKit.showToast(`已将「${item.name}」装入「${slot.label}」`, 'ok');
          if (typeof onUpdated === 'function') await onUpdated();
          else await renderConsole();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '装入失败', 'error');
        }
      });
      list.appendChild(btn);
    }
    wrap.appendChild(list);
  }

  sheetHandle = uiKit.openBottomSheet({
    title: `为「${slot.label}」选择【${slotTypeLabel}】装备`,
    subtitle: slot.required
      ? `核心固定槽位 · 绿升/红降实时对比八维差值（${compatibleItems.length} 件）`
      : slot.custom
      ? `扩建专属槽位 · 绿升/红降实时对比八维差值（${compatibleItems.length} 件）`
      : `舰娘服装槽位 · 绿升/红降实时对比八维差值（${compatibleItems.length} 件）`,
    content: wrap,
    actions: [{ id: 'close', label: '关闭', tone: 'secondary' }],
  });
}

function openCharacterEditorSheet(existingChar = null) {
  const { entities, inventory, assets, uiKit, logs, bus, statRules, commander, personalityPool } = consoleState.context;
  const isEdit = Boolean(existingChar);
  const rulesCfg = statRules.getConfig();
  const initialAffBonus = commander ? commander.getInitialAffinityBonus() : 0;
  const initialProg = existingChar
    ? statRules.ensureShipProgression(existingChar)
    : { level: 1, exp: 0, maxExp: statRules.getShipMaxExp(1) };
  let originalLevel = initialProg.level;
  const initialCombo = existingChar
    ? existingChar.meta?.personalityCombo || (personalityPool ? personalityPool.ensurePersonalityOnEntity(existingChar) : null)
    : personalityPool
    ? personalityPool.rollCombination()
    : null;

  const draft = existingChar
    ? {
        name: existingChar.name,
        shipType: existingChar.meta?.shipType || '驱逐舰',
        roleTag: existingChar.meta?.roleTag || '',
        avatarAssetId: existingChar.meta?.avatarAssetId || null,
        personalityCombo: initialCombo,
        personality: existingChar.meta?.personality || initialCombo?.description || '',
        speechHabit: existingChar.meta?.speechHabit || initialCombo?.speechHabit || '',
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
        roleTag: initialCombo ? `新编舰船 · ${initialCombo.comboLabel}` : '新编舰船',
        avatarAssetId: null,
        personalityCombo: initialCombo,
        personality: initialCombo?.description || '',
        speechHabit: initialCombo?.speechHabit || '',
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
              personalityCombo: draft.personalityCombo || null,
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
  const capInfo = inventory.getCharacterSlotCapInfo(char.id);

  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm';
  card.id = compact ? 'cc-overview-slots-card' : 'cc-slots-card';

  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <h2 class="section-title">核心槽位与扩建槽位</h2>
        <span class="status-badge ${capInfo.canExpand ? 'badge-ok' : 'badge-warn'}">${escapeHtml(capInfo.shipClass)} 扩建 ${capInfo.used}/${capInfo.max}</span>
      </div>
      <button type="button" id="${compact ? 'btn-cc-add-custom-slot-ov' : 'btn-cc-add-custom-slot'}" class="btn-primary uikit-touch-target" style="padding:6px 12px;font-size:12.5px;" ${capInfo.canExpand ? '' : 'disabled'}>
        ${capInfo.canExpand ? '+ 扩建装备槽位' : `已达上限 ${capInfo.used}/${capInfo.max}`}
      </button>
    </div>
    <div class="lab-btn-grid">
      <button type="button" id="${compact ? 'btn-cc-auto-equip-ov' : 'btn-cc-auto-equip'}" class="btn-primary uikit-touch-target">一键最优配装</button>
      <button type="button" id="${compact ? 'btn-cc-unequip-all-ov' : 'btn-cc-unequip-all'}" class="btn-secondary uikit-touch-target">一键卸下全部</button>
    </div>
    <p class="muted-text" style="font-size:12px;">
      「引擎 / 装甲 / 核心」为固定必装核心槽（${seaworthyInfo.seaworthy ? '已适航' : '未适航，缺少必装项'}）；按舰种上限（DD/SS 2槽 · CL/CA 3槽 · BB/CV 4槽）消耗钢/铝/银扩建专属槽位，穿戴装备解锁对应战斗指令。
    </p>
    <div class="lab-stack-sm" data-slots-list></div>
  `;

  card
    .querySelector(compact ? '#btn-cc-add-custom-slot-ov' : '#btn-cc-add-custom-slot')
    .addEventListener('click', () => openAddCustomSlotSheet(char));

  card
    .querySelector(compact ? '#btn-cc-auto-equip-ov' : '#btn-cc-auto-equip')
    .addEventListener('click', async () => {
      try {
        const res = await inventory.autoEquipCharacter(char.id, { includeOutfit: true });
        await saveRosterNow();
        uiKit.showToast(
          res.equippedCount > 0
            ? `已为「${char.name}」自动配装 ${res.equippedCount} 件最优空闲装备（${res.seaworthy ? '已适航' : '待补核心部件'}）`
            : `「${char.name}」当前槽位已是最优配装，或仓库暂无更优同类型空闲装备`,
          res.equippedCount > 0 ? 'ok' : 'info'
        );
        await renderConsole();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '自动配装失败', 'warn');
      }
    });

  card
    .querySelector(compact ? '#btn-cc-unequip-all-ov' : '#btn-cc-unequip-all')
    .addEventListener('click', async () => {
      const ok = await uiKit.confirmDialog({
        title: `卸下「${char.name}」全部装备？`,
        message: '将把三大核心槽、全部扩建槽及服装槽内的装备一键退回仓库（核心槽清空后角色将暂处于未适航状态）。',
        confirmLabel: '确认一键卸下',
        tone: 'danger',
      });
      if (!ok) return;
      const res = await inventory.unequipAllForCharacter(char.id);
      await saveRosterNow();
      uiKit.showToast(
        res.removedCount > 0
          ? `已从「${char.name}」卸下全部 ${res.removedCount} 件装备`
          : `「${char.name}」当前未穿戴任何装备`,
        res.removedCount > 0 ? 'ok' : 'info'
      );
      await renderConsole();
    });

  const listEl = card.querySelector('[data-slots-list]');
  for (const s of slots) {
    const item = equippedMap[s.id];
    const isMissingCore = s.required && !item;
    const slotTypeId = s.equipmentType || (s.id === 'outfit' ? 'outfit' : inferEquipmentTypeId(s, KNOWN_EQUIPMENT_TYPES.MAIN_GUN));
    const slotTypeDef = KNOWN_EQUIPMENT_TYPE_MAP[slotTypeId] || null;
    const itemRarityId = item ? inferItemRarity(item) : null;
    const itemRarityDef = itemRarityId ? ITEM_RARITY_MAP[itemRarityId] : null;

    const row = document.createElement('div');
    row.className = `cc-slot-card ${isMissingCore ? 'is-missing-core' : ''} ${itemRarityId ? `is-rarity-${itemRarityId}` : ''}`;
    row.dataset.equipSlot = s.id;
    row.dataset.slotType = slotTypeId;
    row.dataset.slotCustom = s.custom ? 'true' : 'false';

    const tagHtml = s.required
      ? `<span class="status-badge ${item ? 'badge-ok' : 'badge-danger'}">必装核心</span>`
      : s.custom
      ? `<span class="status-badge badge-ok">扩建 · ${escapeHtml(slotTypeDef?.label || s.label)}</span>`
      : '<span class="status-badge badge-muted">服装选装</span>';

    const slotIconHtml = getItemIconSvg(
      item || {
        category: slotTypeDef?.category || (slotTypeId === 'outfit' ? ITEM_CATEGORIES.OUTFIT : ITEM_CATEGORIES.EXTENSION),
        subGroup: slotTypeDef?.subGroup || 'weapon',
        iconKey: slotTypeDef?.defaultIcon || (slotTypeId === 'outfit' ? 'outfit_dress' : 'main_gun'),
      },
      { size: 18, iconKey: item?.iconKey || slotTypeDef?.defaultIcon }
    );

    row.innerHTML = `
      <div class="cc-slot-card-top">
        <div class="cc-slot-info">
          <div class="cc-badge-row">
            <span class="wh-item-ico">${slotIconHtml}</span>
            <span class="cc-slot-item-name">${escapeHtml(s.label)}</span>
            ${tagHtml}
            ${itemRarityDef ? `<span class="rarity-pill is-rarity-${itemRarityId}">${escapeHtml(itemRarityDef.shortLabel)}</span>` : ''}
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
        ${s.custom ? '<button type="button" class="btn-secondary" data-slot-act="rename">变更类型</button>' : ''}
        ${s.custom ? '<button type="button" class="btn-danger" data-slot-act="remove-slot">拆除槽位</button>' : ''}
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
          title: `拆除扩建槽位「${s.label}」`,
          message: '确认拆除该扩建装备槽位吗？若槽位内已装入装备将自动退回仓库并重算属性。',
          confirmLabel: '确认拆除',
          tone: 'danger',
        });
        if (!ok) return;
        await inventory.removeExpandedSlot(char.id, s.id);
        await saveRosterNow();
        uiKit.showToast(`已拆除扩建槽位：${s.label}`, 'ok');
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
      <button type="button" id="btn-cc-toggle-lock" class="${char.meta?.locked ? 'btn-primary' : 'btn-secondary'} uikit-touch-target">
        ${char.meta?.locked ? '🔓 解除舰娘锁定' : '🔒 锁定防误删'}
      </button>
    </div>
    <button type="button" id="btn-cc-del-char" class="btn-danger uikit-touch-target" ${getCharacters().length <= 1 || char.meta?.locked ? 'disabled' : ''}>
      ${char.meta?.locked ? '🔒 已锁定（不可删除当前角色）' : '删除当前角色'}
    </button>
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

  personaCard.querySelector('#btn-cc-toggle-lock').addEventListener('click', async () => {
    if (!char.meta) char.meta = {};
    char.meta.locked = !char.meta.locked;
    await saveRosterNow();
    uiKit.showToast(
      char.meta.locked ? `🔒 已锁定舰娘「${char.name}」，防止误删` : `🔓 已解除舰娘「${char.name}」锁定`,
      'info'
    );
    await renderConsole();
  });

  personaCard.querySelector('#btn-cc-del-char').addEventListener('click', async () => {
    if (getCharacters().length <= 1) return;
    if (char.meta?.locked) {
      uiKit.showToast(`「${char.name}」已锁定保护，请先解除锁定后再删除`, 'warn');
      return;
    }
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
  const { inventory, logs, uiKit } = consoleState.context;

  // Card 1: Full Slot Manager (Core 3 + Outfit + Freeform Custom)
  host.appendChild(createSlotsSection(char, { compact: false }));

  // Card 2: Compact Categorized Global Item Warehouse
  const allItems = inventory.listItems();
  const items = inventory.listItems({
    warehouseGroup: consoleState.warehouseGroup,
    equipStatus: consoleState.warehouseEquipStatus,
  });
  const idleCleanable = inventory.getIdleUnenhancedItems();

  const groupCounts = { [WAREHOUSE_GROUPS.ALL]: allItems.length };
  for (const g of WAREHOUSE_GROUP_DEFS) {
    if (g.id === WAREHOUSE_GROUPS.ALL) continue;
    groupCounts[g.id] = allItems.filter((it) => classifyItemWarehouseGroup(it) === g.id).length;
  }

  const warehouseCard = document.createElement('section');
  warehouseCard.className = 'surface-card lab-stack-sm';
  warehouseCard.id = 'cc-warehouse-card';
  warehouseCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">分类装备仓库（${items.length}/${allItems.length}）</h2>
      <button type="button" id="btn-cc-new-item" class="btn-primary uikit-touch-target" style="padding:6px 12px;font-size:12.5px;">+ 新建装备</button>
    </div>

    <div class="wh-filter-strip" id="cc-item-filters">
      ${WAREHOUSE_GROUP_DEFS.map(
        (g) => `
        <button type="button" class="wh-pill-btn ${consoleState.warehouseGroup === g.id ? 'is-active' : ''}" data-cc-wh-group="${g.id}">
          ${escapeHtml(g.label)} (${groupCounts[g.id] || 0})
        </button>
      `
      ).join('')}
    </div>

    <div class="wh-status-toolbar">
      <div class="wh-status-pills">
        ${[
          { id: 'all', label: '全部状态' },
          { id: 'idle', label: '闲置中' },
          { id: 'equipped', label: '已装备' },
        ]
          .map(
            (st) => `
          <button type="button" class="wh-pill-btn is-sm ${consoleState.warehouseEquipStatus === st.id ? 'is-active' : ''}" data-cc-wh-status="${st.id}">
            ${escapeHtml(st.label)}
          </button>
        `
          )
          .join('')}
      </div>
      <button type="button" id="btn-cc-batch-clean" class="btn-danger uikit-touch-target wh-clean-btn" ${idleCleanable.length === 0 ? 'disabled' : ''}>
        清理闲置+0 (${idleCleanable.length})
      </button>
    </div>

    <div class="wh-compact-list" id="cc-warehouse-list"></div>
  `;

  warehouseCard.querySelector('#btn-cc-new-item').addEventListener('click', () => openItemEditorSheet(null));
  warehouseCard.querySelectorAll('[data-cc-wh-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      consoleState.warehouseGroup = btn.getAttribute('data-cc-wh-group');
      renderConsole();
    });
  });
  warehouseCard.querySelectorAll('[data-cc-wh-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      consoleState.warehouseEquipStatus = btn.getAttribute('data-cc-wh-status');
      renderConsole();
    });
  });

  warehouseCard.querySelector('#btn-cc-batch-clean').addEventListener('click', async () => {
    const cleanTargets = inventory.getIdleUnenhancedItems();
    if (cleanTargets.length === 0) return;
    const ok = await uiKit.confirmDialog({
      title: `批量清理闲置未强化装备（${cleanTargets.length} 件）`,
      message: '将批量清理所有未装备且强化等级为 +0 的装备（消耗品与已装备/已强化装备不受影响），确定继续吗？',
      confirmLabel: `确认清理 ${cleanTargets.length} 件`,
      tone: 'danger',
    });
    if (!ok) return;
    const res = await inventory.cleanupIdleUnenhancedItems();
    logs.add({
      category: LOG_CATEGORIES.EQUIPMENT,
      title: `批量清理闲置未强化装备（${res.removedCount} 件）`,
      detail: res.removedNames.join('、'),
    });
    uiKit.showToast(`已清理 ${res.removedCount} 件闲置未强化装备`, 'ok');
    await renderConsole();
  });

  const listEl = warehouseCard.querySelector('#cc-warehouse-list');
  if (items.length === 0) {
    listEl.innerHTML = '<p class="muted-text">当前分类与筛选条件下暂无物品。</p>';
  } else {
    for (const item of items) {
      const equippedSlotId = inventory.getEquippedSlotOfItem(char.id, item.id);
      const isEquipped = Boolean(equippedSlotId);
      const isConsumable = item.category === ITEM_CATEGORIES.CONSUMABLE;
      const equippedSlotObj = equippedSlotId ? inventory.getCharacterSlot(char.id, equippedSlotId) : null;
      const wearers = inventory.getWearersOfItem(item.id);
      const isExpanded = consoleState.expandedWarehouseItemId === item.id;
      const lv = Number(item.level) || 0;

      const card = document.createElement('div');
      card.className = `wh-compact-card ${isExpanded ? 'is-expanded' : ''} ${wearers.length ? 'is-equipped' : ''}`;
      card.dataset.itemId = item.id;
      card.innerHTML = `
        <button type="button" class="wh-compact-header" data-cc-wh-toggle="${escapeHtml(item.id)}" aria-expanded="${isExpanded ? 'true' : 'false'}">
          <span class="wh-item-ico">${getItemIconSvg(item, { size: 20 })}</span>
          <div class="wh-compact-main">
            <div class="wh-compact-title-row">
              <strong class="wh-item-name">${escapeHtml(item.name)}</strong>
              ${lv > 0 ? `<span class="wh-lv-pill">+${lv}</span>` : ''}
              ${isConsumable ? `<span class="wh-qty-pill">×${item.quantity}</span>` : ''}
            </div>
            <div class="wh-compact-stat-row">
              ${(item.bonuses || [])
                .slice(0, 3)
                .map((b) => `<span class="wh-stat-mini">${escapeHtml(formatBonusChip(b))}</span>`)
                .join('')}
            </div>
          </div>
          <div class="wh-compact-right">
            <span class="status-badge ${wearers.length ? 'badge-ok' : 'badge-muted'} wh-wearer-badge">
              ${wearers.length ? escapeHtml(wearers[0].name.slice(0, 6)) : '闲置'}
            </span>
            <span class="wh-chevron" aria-hidden="true">${isExpanded ? '▴' : '▾'}</span>
          </div>
        </button>

        ${
          isExpanded
            ? `
          <div class="wh-compact-detail">
            <div class="cc-badge-row">
              <span class="status-badge badge-muted">${escapeHtml(ITEM_CATEGORY_LABELS[item.category] || item.category)}</span>
              ${isEquipped ? `<span class="status-badge badge-ok">当前已装：${escapeHtml(equippedSlotObj?.label || equippedSlotId)}</span>` : ''}
            </div>
            ${item.description ? `<p class="muted-text" style="font-size:12px; margin:0;">${escapeHtml(item.description)}</p>` : ''}
            <div class="ns-chip-list">
              ${
                (item.bonuses || []).length > 0
                  ? item.bonuses.map((b) => `<span class="ns-chip">${escapeHtml(formatBonusChip(b))}</span>`).join('')
                  : '<span class="muted-text" style="font-size:11.5px;">无属性词条</span>'
              }
            </div>
            <div class="cc-item-actions">
              <button type="button" class="${isEquipped ? 'btn-secondary' : 'btn-primary'} uikit-touch-target" data-act="primary" ${isConsumable && item.quantity <= 0 ? 'disabled' : ''}>
                ${isConsumable ? '使用消耗品' : isEquipped ? '卸下部件' : '一键装入'}
              </button>
              <button type="button" class="btn-secondary uikit-touch-target" data-act="edit">调词条</button>
              <button type="button" class="btn-danger uikit-touch-target" data-act="delete" ${item.locked ? 'disabled' : ''}>${item.locked ? '🔒 锁定' : '删除'}</button>
            </div>
          </div>
        `
            : ''
        }
      `;

      card.querySelector('[data-cc-wh-toggle]').addEventListener('click', () => {
        consoleState.expandedWarehouseItemId = isExpanded ? null : item.id;
        renderConsole();
      });

      const primaryBtn = card.querySelector('[data-act="primary"]');
      if (primaryBtn) {
        primaryBtn.addEventListener('click', async () => {
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
      }

      const editBtn = card.querySelector('[data-act="edit"]');
      if (editBtn) editBtn.addEventListener('click', () => openItemEditorSheet(item));

      const delBtn = card.querySelector('[data-act="delete"]');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (item.locked) {
            uiKit.showToast(`「${item.name}」已锁定保护，请先解锁后再删除`, 'warn');
            return;
          }
          const ok = await uiKit.confirmDialog({
            title: `删除物品「${item.name}」`,
            message: '确认从仓库永久删除该物品吗？若角色正在穿戴，将自动卸下并重算属性。',
            confirmLabel: '确认删除',
            tone: 'danger',
          });
          if (!ok) return;
          try {
            await inventory.deleteItem(item.id);
            await saveRosterNow();
            consoleState.expandedWarehouseItemId = null;
            uiKit.showToast(`已删除物品：${item.name}`, 'ok');
            await renderConsole();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '删除失败', 'warn');
          }
        });
      }

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
// Tab 2 「档案」: Commander 6-Stat & Medals + Full Shipgirl Roster
// ============================================================
let archiveFilterClass = 'all';

function openCommanderEditModal() {
  const { commander, assets, uiKit } = consoleState.context;
  const openFn = typeof uiKit.openTacticalModal === 'function' ? uiKit.openTacticalModal : uiKit.openModal;

  openFn({
    title: '编辑指挥官档案',
    subtitle: '修改呼号、头衔与头像，所有变更实时同步至顶部状态栏与对话称呼',
    renderContent: (body, close) => {
      const renderForm = async () => {
        const p = commander.getProfile();
        const avatarRes = await assets.getAssetUrl(p.avatarAssetId, {
          fallbackSeed: 'commander-profile',
          fallbackLabel: (p.name || 'CMD').slice(0, 4),
        });
        body.innerHTML = `
          <form id="archive-cmd-edit-form" class="module-stack">
            <div class="cc-hero-row">
              <img class="cc-avatar" src="${avatarRes.url}" alt="指挥官头像">
              <div class="lab-stack-sm" style="flex:1 1 auto;">
                <button type="button" id="btn-arc-cmd-avatar" class="btn-secondary uikit-touch-target">上传指挥官头像</button>
                <span class="muted-text" style="font-size:11.5px;">Lv.${p.level} · EXP ${p.exp}/${p.expToNext} · 自由点 ${p.freePoints}</span>
              </div>
            </div>
            <div class="lab-kv-grid">
              <div class="form-group">
                <label class="form-label" for="arc-cmd-name">指挥官呼号</label>
                <input id="arc-cmd-name" class="form-input" type="text" value="${escapeHtml(p.name)}">
              </div>
              <div class="form-group">
                <label class="form-label" for="arc-cmd-title">军衔头衔</label>
                <input id="arc-cmd-title" class="form-input" type="text" value="${escapeHtml(p.title)}">
              </div>
            </div>
            <div class="lab-btn-grid">
              <button type="button" id="btn-arc-cmd-cancel" class="btn-secondary uikit-touch-target">取消</button>
              <button type="submit" class="btn-primary uikit-touch-target">保存档案</button>
            </div>
          </form>
        `;

        body.querySelector('#btn-arc-cmd-avatar')?.addEventListener('click', () => {
          const inp = document.createElement('input');
          inp.type = 'file';
          inp.accept = 'image/*';
          inp.onchange = async () => {
            const f = inp.files?.[0];
            if (!f) return;
            try {
              const saved = await assets.saveImageFile(f, { maxWidth: 320, maxHeight: 320, quality: 0.85 });
              await commander.updateProfile({ avatarAssetId: saved.id });
              uiKit.showToast('指挥官头像已更新', 'ok');
              renderForm();
            } catch (err) {
              uiKit.showToast(err instanceof Error ? err.message : '上传失败', 'warn');
            }
          };
          inp.click();
        });
        body.querySelector('#btn-arc-cmd-cancel')?.addEventListener('click', () => close());
        body.querySelector('#archive-cmd-edit-form')?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const name = body.querySelector('#arc-cmd-name')?.value?.trim() || '指挥官';
          const title = body.querySelector('#arc-cmd-title')?.value?.trim() || '提督';
          await commander.updateProfile({ name, title });
          uiKit.showToast('指挥官档案已保存', 'ok');
          close();
          renderConsole();
        });
      };
      renderForm();
    },
  });
}

function openHonorMedalsModal() {
  const { buildings, commander, uiKit } = consoleState.context;
  const openFn = typeof uiKit.openTacticalModal === 'function' ? uiKit.openTacticalModal : uiKit.openModal;
  const overview = buildings?.getMedalsOverview?.() || { unlockedCount: 0, totalCount: 0, totalLuckBonus: 0, medals: [] };
  const luckFx = commander?.getLuckEffects?.() || { luck: 0, rareDropBonus: 0 };

  openFn({
    title: `港区荣誉勋章室（${overview.unlockedCount}/${overview.totalCount}）`,
    subtitle: `当前指挥官永久运气 ${luckFx.luck}（勋章提供 +${overview.totalLuckBonus} · 稀有掉率加成 +${Math.round((luckFx.rareDropBonus || 0) * 100)}%）`,
    wide: true,
    renderContent: (body, close) => {
      body.innerHTML = `
        <div class="module-stack">
          <div class="lab-stack-sm">
            ${(overview.medals || [])
              .map(
                (m) => `
              <div class="lab-slot-card ${m.unlocked ? 'is-medal-unlocked' : ''}">
                <div class="lab-slot-head">
                  <strong>${m.unlocked ? '★ ' : '☆ '}${escapeHtml(m.title)}</strong>
                  <span class="status-badge ${m.unlocked ? 'badge-ok' : 'badge-muted'}">
                    ${m.unlocked ? `已点亮 · 运气 +${m.luckBonus}` : `未解锁 · 运气 +${m.luckBonus}`}
                  </span>
                </div>
                <div class="cc-stat-sub">${escapeHtml(m.description || '')}</div>
              </div>
            `
              )
              .join('')}
          </div>
          <button type="button" id="btn-arc-medals-close" class="btn-secondary uikit-touch-target">关闭勋章室</button>
        </div>
      `;
      body.querySelector('#btn-arc-medals-close')?.addEventListener('click', () => close());
    },
  });
}

async function renderArchiveConsole() {
  if (!consoleState.container || !consoleState.context) return;
  const {
    entities,
    inventory,
    statRules,
    commander,
    expeditions,
    buildings,
    formation,
    interaction,
    storyEngine,
    assets,
    uiKit,
  } = consoleState.context;

  const profile = commander.getProfile();
  const luckFx = commander.getLuckEffects();
  const fleetCap = formation?.getFleetCap
    ? formation.getFleetCap()
    : typeof commander.getFleetCapacity === 'function'
    ? commander.getFleetCapacity()
    : 3;
  const cmdAvatar = await assets.getAssetUrl(profile.avatarAssetId, {
    fallbackSeed: 'commander-profile',
    fallbackLabel: (profile.name || 'CMD').slice(0, 4),
  });
  const medalsOv = buildings?.getMedalsOverview?.() || { unlockedCount: 0, totalCount: 0 };

  const roster = getCharacters();
  const avatars = new Map();
  for (const c of roster) {
    avatars.set(c.id, await resolveAvatarUrl(c));
  }

  const classFilters = [
    { id: 'all', label: `全部 (${roster.length})` },
    { id: 'DD', label: '驱逐' },
    { id: 'CRUISER', label: '巡洋' },
    { id: 'BB', label: '战列' },
    { id: 'CV', label: '航母' },
    { id: 'SUP', label: '后勤(AR/AO)' },
  ];

  const filteredRoster = roster.filter((c) => {
    if (archiveFilterClass === 'all') return true;
    const cls = resolveShipClass(c.meta?.shipType);
    if (archiveFilterClass === 'CRUISER') return cls === 'CL' || cls === 'CA';
    if (archiveFilterClass === 'SUP') return cls === 'AR' || cls === 'AO';
    return cls === archiveFilterClass;
  });

  consoleState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'cc-root archive-hub-root';
  root.id = 'page-character-archive';

  // 1. Upper Section: Commander 6-Stat Card + Honor Medals
  const cmdCard = document.createElement('section');
  cmdCard.className = 'surface-card lab-stack-sm archive-cmd-card';
  cmdCard.id = 'archive-commander-card';
  const expPct = Math.min(100, Math.round((Number(profile.exp || 0) / Math.max(1, Number(profile.expToNext || 100))) * 100));

  cmdCard.innerHTML = `
    <div class="archive-cmd-top">
      <img class="archive-cmd-avatar" src="${cmdAvatar.url}" alt="${escapeHtml(profile.name)}">
      <div class="archive-cmd-meta">
        <div class="section-header-row" style="margin-bottom:2px; gap:6px;">
          <div style="display:flex; align-items:center; gap:6px; min-width:0; flex-wrap:wrap;">
            <strong style="font-size:15px;">${escapeHtml(profile.name)}</strong>
            <span class="status-badge badge-ok">Lv.${profile.level}</span>
            <span class="status-badge badge-muted">${escapeHtml(profile.title || '提督')}</span>
          </div>
          <div style="display:flex; gap:4px; flex-shrink:0;">
            <button type="button" id="btn-arc-cmd-edit" class="interact-icon-btn">编辑</button>
            <button type="button" id="btn-arc-medals" class="interact-icon-btn">★ 勋章 ${medalsOv.unlockedCount}/${medalsOv.totalCount}</button>
          </div>
        </div>
        <div class="cc-stat-sub">
          EXP ${profile.exp}/${profile.expToNext} · 出战上限 ${fleetCap} 舰 · 永久运气 ${luckFx.luck}
          ${profile.freePoints > 0 ? ` · <strong style="color:var(--accent);">可分配点数 ${profile.freePoints}</strong>` : ''}
        </div>
        <div class="interact-aff-track" style="margin-top:4px;">
          <div class="interact-aff-fill" style="width:${expPct}%"></div>
        </div>
      </div>
    </div>

    <div class="archive-cmd-stats-grid" id="archive-cmd-stats">
      ${COMMANDER_STAT_DEFS.map((d) => {
        const val = Number(profile.stats?.[d.key] ?? 10);
        return `
          <div class="archive-cmd-stat-cell">
            <div class="archive-cmd-stat-head">
              <span class="muted-text" style="font-size:11.5px;">${escapeHtml(d.label)}</span>
              <strong>${val}</strong>
            </div>
            ${
              profile.freePoints > 0
                ? `<button type="button" class="archive-alloc-btn" data-cmd-alloc="${escapeHtml(d.key)}">+1</button>`
                : ''
            }
          </div>
        `;
      }).join('')}
    </div>
  `;

  cmdCard.querySelector('#btn-arc-cmd-edit')?.addEventListener('click', () => openCommanderEditModal());
  cmdCard.querySelector('#btn-arc-medals')?.addEventListener('click', () => openHonorMedalsModal());
  cmdCard.querySelectorAll('[data-cmd-alloc]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const statKey = btn.getAttribute('data-cmd-alloc');
      try {
        await commander.allocateStat(statKey, 1);
        uiKit.showToast('已分配 1 点指挥官属性', 'ok');
        renderConsole();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '分配失败', 'warn');
      }
    });
  });
  root.appendChild(cmdCard);

  // 2. Lower Section: Full Shipgirl Roster (Tap any card -> Centered Frosted Detail Modal)
  const rosterSection = document.createElement('section');
  rosterSection.className = 'surface-card lab-stack-sm archive-roster-section';
  rosterSection.id = 'archive-roster-section';
  rosterSection.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">全员舰娘档案名册（${roster.length} 名）</h2>
      <button type="button" id="btn-arc-new-ship" class="btn-secondary fac-mini-btn">+ 新建舰娘</button>
    </div>

    <div class="chip-row" data-no-swipe="true">
      ${classFilters
        .map(
          (f) =>
            `<button type="button" class="preset-chip ${archiveFilterClass === f.id ? 'is-active' : ''}" data-arc-filter="${escapeHtml(f.id)}">${escapeHtml(f.label)}</button>`
        )
        .join('')}
    </div>

    <div class="archive-roster-grid" id="archive-roster-grid">
      ${
        filteredRoster.length === 0
          ? '<p class="muted-text" style="grid-column:1/-1; text-align:center;">该分类下暂无舰娘。</p>'
          : filteredRoster
              .map((c) => {
                const prog = statRules.ensureShipProgression(c);
                const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(c.id, 'maxHp', { round: 'round' }).final));
                const curHp = Math.min(effMaxHp, Math.round(Number(c.stats.hp ?? effMaxHp)));
                const hpPct = Math.round((curHp / effMaxHp) * 100);
                const affSt = storyEngine?.getAffectionStatus
                  ? storyEngine.getAffectionStatus(c.id)
                  : { affinity: Math.round(Number(c.stats.affinity ?? 0)), stage: { label: '陌生' } };
                const status = buildings?.getCharacterGlobalStatus
                  ? buildings.getCharacterGlobalStatus(c.id, { formation, expeditions, interaction })
                  : { badges: [] };
                const isLocked = Boolean(c.meta?.locked);
                const slotsCap = inventory.getCharacterSlotCapInfo(c.id);

                return `
                  <div class="archive-ship-card" data-arc-ship="${escapeHtml(c.id)}">
                    <div class="archive-ship-head">
                      <img class="archive-ship-avatar" src="${avatars.get(c.id) || ''}" alt="${escapeHtml(c.name)}">
                      <div class="archive-ship-info">
                        <div class="archive-ship-title">
                          <span class="ship-class-ico">${getShipClassSvg(c.meta?.shipType, { size: 15 })}</span>
                          <strong>${escapeHtml(c.name)}</strong>
                          <span class="status-badge ship-lv-badge">Lv.${prog.level}</span>
                        </div>
                        <div class="cc-stat-sub">
                          ${escapeHtml(c.meta?.shipType || '驱逐舰')} · ${escapeHtml(affSt.stage.label)}(${affSt.affinity}) · 槽 ${slotsCap.used}/${slotsCap.max}
                        </div>
                      </div>
                      <button
                        type="button"
                        class="archive-lock-btn ${isLocked ? 'is-locked' : ''}"
                        data-arc-lock="${escapeHtml(c.id)}"
                        title="${isLocked ? '已锁定保护' : '点击锁定'}"
                      >${isLocked ? '🔒' : '🔓'}</button>
                    </div>
                    <div class="archive-ship-bars">
                      <div class="tac-cell-hp" style="height:5px;">
                        <div class="tac-cell-hp-fill ${hpPct < 30 ? 'is-danger' : ''}" style="width:${hpPct}%"></div>
                      </div>
                      <div class="archive-ship-foot">
                        <span class="muted-text" style="font-size:11px;">HP ${curHp}/${effMaxHp}</span>
                        <div style="display:flex; gap:4px; flex-wrap:wrap;">
                          ${(status.badges || [])
                            .slice(0, 2)
                            .map((b) => `<span class="status-badge badge-${escapeHtml(b.tone)}" style="font-size:10px; padding:1px 5px;">${escapeHtml(b.label)}</span>`)
                            .join('')}
                        </div>
                      </div>
                    </div>
                  </div>
                `;
              })
              .join('')
      }
    </div>
  `;

  rosterSection.querySelector('#btn-arc-new-ship')?.addEventListener('click', () => openCharacterEditorSheet(null));

  rosterSection.querySelectorAll('[data-arc-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      archiveFilterClass = btn.getAttribute('data-arc-filter') || 'all';
      renderConsole();
    });
  });

  rosterSection.querySelectorAll('[data-arc-lock]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cid = btn.getAttribute('data-arc-lock');
      const ent = entities.get(cid);
      if (!ent) return;
      ent.meta = ent.meta || {};
      ent.meta.locked = !ent.meta.locked;
      await saveRosterNow();
      uiKit.showToast(ent.meta.locked ? `已锁定「${ent.name}」` : `已解锁「${ent.name}」`, 'info');
      renderConsole();
    });
  });

  rosterSection.querySelectorAll('[data-arc-ship]').forEach((card) => {
    card.addEventListener('click', () => {
      const cid = card.getAttribute('data-arc-ship');
      if (cid) {
        consoleState.activeCharacterId = cid;
        openCharacterCardById(cid, consoleState.context);
      }
    });
  });

  root.appendChild(rosterSection);
  consoleState.container.appendChild(root);
}

async function renderConsole() {
  return renderArchiveConsole();
}

async function _legacyRenderConsoleUnused() {
  if (!consoleState.container || !consoleState.context) return;
  const {
    entities,
    inventory,
    resources,
    statRules,
    commander,
    expeditions,
    buildings,
    formation,
    interaction,
    personalityPool,
    logs,
    uiKit,
  } = consoleState.context;
  const roster = getCharacters();
  const char = getActiveCharacter();
  if (!char) return;

  const avatarUrl = await resolveAvatarUrl(char);
  const prog = statRules.ensureShipProgression(char);
  const combo = personalityPool ? personalityPool.ensurePersonalityOnEntity(char) : char.meta?.personalityCombo || null;
  const effStats = entities.getEffectiveStats(char.id, { round: 'round' });
  const eqBonuses = inventory.getCharacterEquipmentBonuses(char.id);
  const overallScore = statRules.computeOverallScore(effStats, eqBonuses.checkBonus);
  const affThresholdRed = commander ? commander.getAffinityThresholdReduction() : 0;
  const affStage = statRules.getAffinityStage(char.stats.affinity ?? 0, { thresholdReduction: affThresholdRed });
  const moraleMod = statRules.getMoraleModifier(char.stats.morale ?? 50);
  const seaworthyInfo = statRules.evaluateSeaworthiness(inventory, char.id);
  const shipClass = resolveShipClass(char.meta?.shipType);
  const classProfile = getShipClassProfile(char.meta?.shipType);
  const globalStatus = buildings
    ? buildings.getCharacterGlobalStatus(char.id, { formation, expeditions, interaction })
    : {
        primaryLabel: '待命',
        primaryTone: 'muted',
        badges: [{ id: 'idle', label: '待命', tone: 'muted' }],
        inDorm: false,
        inDock: false,
        inFleet: false,
        onExpedition: false,
        isSecretary: false,
      };

  consoleState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'cc-root';

  // Unified Full-Screen Subpage Top Bar (`← 返回港区` + Title + Core Resource Pills)
  root.appendChild(
    uiKit.createSubpageHeader({
      title: `舰娘角色卡 · ${char.name}`,
      subtitle: `${char.meta?.shipType || '驱逐舰'} · 防误触已锁定滑动`,
      modules: consoleState.context.modules,
      resources,
      resourceKeys: ['fuel', 'ammo', 'silver'],
      id: 'cc-subpage-header',
    })
  );

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

  // 2. Refined Top Core Character Card (Avatar + Class SVG + Personality Combo + Global Status + Inline Quick Actions)
  const heroCard = document.createElement('section');
  heroCard.className = 'surface-card lab-stack-sm';
  heroCard.id = 'cc-hero-card';
  heroCard.innerHTML = `
    <div class="cc-hero-row">
      <img class="cc-avatar" id="cc-active-avatar" src="${avatarUrl}" alt="${escapeHtml(char.name)} 头像">
      <div class="cc-hero-info">
        <div class="cc-hero-name-row">
          <span class="ship-class-ico" id="cc-ship-class-svg">${getShipClassSvg(shipClass, { size: 22 })}</span>
          <h2 class="cc-hero-name" id="cc-active-name">${escapeHtml(char.name)}</h2>
          <span class="status-badge ship-lv-badge" id="cc-level-badge">Lv.${prog.level}</span>
          <span class="status-badge badge-ok" id="cc-overall-score">评分 ${overallScore}</span>
        </div>
        <div class="cc-badge-row" id="cc-global-status-badges">
          <span class="status-badge badge-ok" id="cc-ship-type-badge">${escapeHtml(char.meta?.shipType || classProfile.fullName)}</span>
          ${
            combo
              ? `<span class="status-badge badge-warn" id="cc-personality-combo-badge">性格：${escapeHtml(combo.comboLabel)}</span>`
              : ''
          }
          <span class="status-badge ${seaworthyInfo.seaworthy ? 'badge-ok' : 'badge-danger'}" id="cc-seaworthy-badge">
            ${seaworthyInfo.seaworthy ? '适航' : '未适航'}
          </span>
          ${globalStatus.badges
            .map(
              (b) =>
                `<span class="status-badge badge-${escapeHtml(b.tone)}" data-global-status="${escapeHtml(b.id)}">${escapeHtml(b.label)}</span>`
            )
            .join('')}
          ${
            globalStatus.isSecretary
              ? '<span class="status-badge badge-ok" id="cc-secretary-badge">★ 秘书舰</span>'
              : ''
          }
          <span class="status-badge badge-muted" id="cc-affinity-badge">好感 ${escapeHtml(affStage.label)}(${affStage.value})</span>
        </div>
      </div>
    </div>

    <p class="muted-text" style="font-size:11.5px; margin:0;" id="cc-class-role-summary">
      <strong>[${escapeHtml(classProfile.code)} · ${escapeHtml(classProfile.name)}]</strong> ${escapeHtml(classProfile.roleSummary)}
    </p>

    ${
      !seaworthyInfo.seaworthy
        ? `<div class="seaworthy-alert" id="cc-seaworthy-alert">${escapeHtml(seaworthyInfo.statusText)}。装齐「引擎 / 装甲 / 核心」后即可恢复适航出击。</div>`
        : ''
    }

    <div id="cc-dynamic-bars" class="lab-stack-sm"></div>

    <!-- Streamlined Inline Quick-Action Bar (Dorm / Secretary / Feed / Edit / Personality) -->
    <div class="lab-btn-grid" id="cc-inline-actions">
      <button type="button" id="btn-cc-toggle-dorm" class="${globalStatus.inDorm ? 'btn-secondary' : 'btn-primary'} uikit-touch-target">
        ${globalStatus.inDorm ? '移出宿舍' : '入住宿舍'}
      </button>
      <button type="button" id="btn-cc-set-secretary" class="${globalStatus.isSecretary ? 'btn-secondary' : 'btn-primary'} uikit-touch-target" ${globalStatus.isSecretary ? 'disabled' : ''}>
        ${globalStatus.isSecretary ? '★ 当前秘书舰' : '设为秘书舰'}
      </button>
      <button type="button" id="btn-cc-quick-feed" class="btn-secondary uikit-touch-target">
        投喂补给恢复
      </button>
      <button type="button" id="btn-cc-edit-char" class="btn-secondary uikit-touch-target">
        调级 / 改白值
      </button>
      <button type="button" id="btn-cc-reroll-personality" class="btn-secondary uikit-touch-target">
        重新随机性格
      </button>
      <button type="button" id="btn-cc-manage-personality-pool" class="btn-secondary uikit-touch-target">
        管理性格词库
      </button>
    </div>

    <div class="cc-btn-3col">
      <button type="button" id="btn-cc-goto-action" class="btn-secondary uikit-touch-target">行动台</button>
      <button type="button" id="btn-cc-goto-workshop" class="btn-secondary uikit-touch-target">物资工坊</button>
      <button type="button" id="btn-cc-open-check" class="btn-secondary uikit-touch-target">模拟检定</button>
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

  // Inline Quick Action Handlers
  heroCard.querySelector('#btn-cc-reroll-personality').addEventListener('click', async () => {
    if (!personalityPool) return;
    const nextCombo = personalityPool.assignRandomPersonality(entities, char.id, { avoidCurrent: true });
    await saveRosterNow();
    if (logs) {
      logs.add({
        category: LOG_CATEGORIES.CHARACTER,
        actorId: char.id,
        actorName: char.name,
        title: `[${char.name}] 随机刷新性格组合`,
        detail: `新性格：【${nextCombo.comboLabel}】${nextCombo.speechHabit}`,
      });
    }
    uiKit.showToast(`「${char.name}」新性格：【${nextCombo.comboLabel}】`, 'ok');
    await renderConsole();
  });

  heroCard.querySelector('#btn-cc-manage-personality-pool').addEventListener('click', () => {
    openPersonalityPoolSheet();
  });

  heroCard.querySelector('#btn-cc-toggle-dorm').addEventListener('click', async () => {
    if (!buildings) return;
    try {
      if (buildings.isInDormitory(char.id)) {
        await buildings.removeDormResident(char.id);
        uiKit.showToast(`「${char.name}」已移出宿舍`, 'info');
      } else {
        await buildings.assignDormResident(char.id);
        uiKit.showToast(`「${char.name}」已入住港区宿舍，离线自动恢复士气与好感`, 'ok');
      }
      await renderConsole();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '宿舍操作失败', 'warn');
    }
  });

  heroCard.querySelector('#btn-cc-set-secretary').addEventListener('click', async () => {
    if (!interaction) return;
    await interaction.setSecretary(char.id);
    uiKit.showToast(`已将「${char.name}」设为港区秘书舰！`, 'ok');
    await renderConsole();
  });

  heroCard.querySelector('#btn-cc-quick-feed').addEventListener('click', async () => {
    const cost = { fuel: 20, silver: 25 };
    const spend = await resources.spendBatch(cost, { reason: `快捷投喂补给（${char.name}）` });
    if (!spend.ok) {
      uiKit.showToast(spend.reason, 'warn');
      return;
    }
    const maxAff = Number(char.statBounds?.affinity?.max ?? 100);
    const healHp = Math.max(8, Math.round(maxHp * 0.2));
    entities.adjustStat(char.id, 'morale', 14, { min: 0, max: 100 });
    entities.adjustStat(char.id, 'affinity', 2, { min: 0, max: maxAff });
    entities.adjustStat(char.id, 'hp', healHp, { min: 0, max: maxHp });
    await saveRosterNow();
    if (logs) {
      logs.add({
        category: LOG_CATEGORIES.STAT,
        actorId: char.id,
        actorName: char.name,
        title: `[${char.name}] 角色卡快捷投喂补给`,
        detail: `士气 +14 · 好感 +2 · 耐久 +${healHp}（消耗燃油 20 / 银条 25）`,
      });
    }
    uiKit.showToast(`已投喂「${char.name}」：士气 +14 · 好感 +2 · HP +${healHp}`, 'ok');
    await renderConsole();
  });

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
  name: '档案',
  description: '指挥官六维属性与荣誉勋章室 + 全员舰娘档案名册（点开查看八维、扩建槽位与换装）。',

  mount(container, context) {
    consoleState.container = container;
    consoleState.context = context;
    consoleState.avatarUrlCache.clear();
    context.ui.setSwipeLocked(false);

    if (getCharacters().length === 0) {
      for (const tpl of DEFAULT_CHARACTER_TEMPLATES) {
        context.entities.register(tpl);
      }
      context.inventory.syncAllCharacters();
    }

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
      context.bus.on('inventory:cleaned', () => renderConsole()),
      context.bus.on('personality:rolled', () => renderConsole()),
      context.bus.on('content:mod-imported', () => renderConsole()),
      context.bus.on('commander:updated', () => renderConsole()),
      context.bus.on('buildings:updated', () => renderConsole()),
      context.bus.on('formation:changed', () => renderConsole()),
      context.bus.on('interaction:secretary-changed', () => renderConsole()),
      context.bus.on('story-engine:updated', () => renderConsole()),
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
