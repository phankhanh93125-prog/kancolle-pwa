/**
 * Dedicated Full-Screen Creation & Modding Center: Custom Workshop (`src/modules/custom-workshop.js` · 自定义工坊).
 *
 * Completely isolated from the 5 Pure-Play bottom tabs (`互动 / 档案 / 出征 / 工坊 / 设施`),
 * opened from the prominent top-bar「自定义工坊」button. Features 4 creation tabs:
 *   1. 自定义舰娘 (ship)           : 8 classes incl. AR/AO, 2-digit stats, personality, avatar upload -> Add to Roster / Export JSON
 *   2. 自定义装备 (gear)           : all types incl. `support` (repair/resupply), rarity, 2-digit bonuses -> Send to Warehouse / Export JSON
 *   3. 自定义设施与剧情 (facility) : "+ 建造新自定义设施", custom interactive dialogues, custom maritime encounters
 *   4. 模组包管理 (mods)           : paste/file JSON smart import, enable/disable/delete external packs, full backup export
 */

import {
  ITEM_RARITIES,
  ITEM_RARITY_DEFS,
  KNOWN_EQUIPMENT_TYPE_DEFS,
  KNOWN_EQUIPMENT_TYPE_MAP,
  SHIP_TYPE_PRESETS,
  resolveShipClass,
} from '../core/stat-rules.js';
import { ITEM_CATEGORIES } from '../core/inventory-system.js';
import { CUSTOM_BUFF_TYPES } from '../core/port-buildings.js';
import { triggerJsonDownload } from '../core/save-manager.js';
import { persistCharacterRoster } from './character-console.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const CW_TABS = [
  { id: 'ship', label: '自定义舰娘' },
  { id: 'gear', label: '自定义装备' },
  { id: 'facility_story', label: '设施与剧情' },
  { id: 'mod_packs', label: '模组包管理' },
];

const SHIP_CLASS_DEFAULT_2DIGIT = {
  驱逐舰: { maxHp: 24, firepower: 14, armor: 10, torpedo: 24, evasion: 24, recon: 16, aa: 15, asw: 22 },
  轻巡洋舰: { maxHp: 29, firepower: 18, armor: 15, torpedo: 18, evasion: 20, recon: 20, aa: 20, asw: 19 },
  重巡洋舰: { maxHp: 35, firepower: 22, armor: 20, torpedo: 14, evasion: 16, recon: 18, aa: 18, asw: 12 },
  战列舰: { maxHp: 44, firepower: 28, armor: 26, torpedo: 6, evasion: 11, recon: 15, aa: 19, asw: 8 },
  航空母舰: { maxHp: 38, firepower: 24, armor: 18, torpedo: 6, evasion: 15, recon: 26, aa: 23, asw: 12 },
  潜艇: { maxHp: 20, firepower: 10, armor: 8, torpedo: 27, evasion: 23, recon: 18, aa: 6, asw: 16 },
  维修舰: { maxHp: 36, firepower: 10, armor: 20, torpedo: 6, evasion: 14, recon: 22, aa: 18, asw: 14 },
  补给舰: { maxHp: 34, firepower: 10, armor: 18, torpedo: 6, evasion: 15, recon: 23, aa: 17, asw: 14 },
};

const GEAR_TYPE_OPTIONS = [
  { id: 'main_gun', label: '主炮 (武器)', category: ITEM_CATEGORIES.EXTENSION, subGroup: 'weapon' },
  { id: 'torpedo', label: '鱼雷 (武器)', category: ITEM_CATEGORIES.EXTENSION, subGroup: 'weapon' },
  { id: 'aircraft', label: '舰载机 (武器)', category: ITEM_CATEGORIES.EXTENSION, subGroup: 'weapon' },
  { id: 'radar', label: '雷达 (战术)', category: ITEM_CATEGORIES.EXTENSION, subGroup: 'tactical' },
  { id: 'sonar', label: '声呐 (战术)', category: ITEM_CATEGORIES.EXTENSION, subGroup: 'tactical' },
  { id: 'aa_gun', label: '防空炮 (战术)', category: ITEM_CATEGORIES.EXTENSION, subGroup: 'tactical' },
  { id: 'support', label: '后勤支援装备 (support · AR/AO 专精)', category: ITEM_CATEGORIES.EXTENSION, subGroup: 'support' },
  { id: 'engine', label: '引擎 (核心三槽)', category: ITEM_CATEGORIES.ENGINE, subGroup: 'core' },
  { id: 'armor', label: '装甲 (核心三槽)', category: ITEM_CATEGORIES.ARMOR, subGroup: 'core' },
  { id: 'core', label: '控制核心 (核心三槽)', category: ITEM_CATEGORIES.CORE, subGroup: 'core' },
  { id: 'outfit', label: '舰娘装束 (衣装)', category: ITEM_CATEGORIES.OUTFIT, subGroup: 'outfit' },
];

const DIALOGUE_STAGE_OPTIONS = [
  { id: 'any', label: '全阶段通用' },
  { id: 'stranger', label: '陌生 (0~19)' },
  { id: 'familiar', label: '熟悉 (20~39)' },
  { id: 'trusted', label: '信赖 (40~59)' },
  { id: 'flutter', label: '心动 (60~79)' },
  { id: 'adoration', label: '恋慕 (80~99)' },
  { id: 'oath', label: '誓约 (100+)' },
];

let activeBackdrop = null;

export function closeCustomWorkshopModal() {
  if (activeBackdrop) {
    activeBackdrop.remove();
    activeBackdrop = null;
  }
}

export function openCustomWorkshopModal(services, { initialTab = 'ship' } = {}) {
  if (!services) return;
  closeCustomWorkshopModal();

  const {
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
  } = services;

  const cwState = {
    activeTab: CW_TABS.some((t) => t.id === initialTab) ? initialTab : 'ship',
    shipDraft: {
      name: '',
      shipType: '驱逐舰',
      ...SHIP_CLASS_DEFAULT_2DIGIT['驱逐舰'],
      personality: '沉着冷静、可靠温柔',
      speechHabit: '「指挥官，今天也请多指教。」',
      avatarAssetId: null,
      avatarPreviewUrl: '',
    },
    gearDraft: {
      name: '',
      equipmentType: 'main_gun',
      supportRole: 'repair',
      rarity: ITEM_RARITIES.RARE,
      outfitStyle: '自定义装束',
      firepower: 6,
      torpedo: 0,
      armor: 2,
      maxHp: 2,
      evasion: 2,
      recon: 2,
      aa: 2,
      asw: 0,
      description: '',
    },
    lastImportReport: '',
  };

  const backdrop = document.createElement('div');
  backdrop.id = 'custom-workshop-backdrop';
  backdrop.className = 'sheet-backdrop uikit-tactical-backdrop cw-fullscreen-backdrop';
  backdrop.setAttribute('role', 'presentation');
  backdrop.dataset.noSwipe = 'true';

  const modal = document.createElement('section');
  modal.id = 'custom-workshop-modal';
  modal.className = 'uikit-tactical-modal cw-fullscreen-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', '自定义工坊');
  backdrop.appendChild(modal);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      close();
    }
  };

  function close() {
    document.removeEventListener('keydown', onKeyDown);
    closeCustomWorkshopModal();
  }

  document.addEventListener('keydown', onKeyDown);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  function buildShipPayload() {
    const d = cwState.shipDraft;
    const shipType = d.shipType || '驱逐舰';
    const cls = resolveShipClass(shipType);
    const id = `char_custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const stats = {
      maxHp: Math.max(10, Math.min(99, Math.round(Number(d.maxHp) || 24))),
      hp: Math.max(10, Math.min(99, Math.round(Number(d.maxHp) || 24))),
      firepower: Math.max(1, Math.min(60, Math.round(Number(d.firepower) || 14))),
      armor: Math.max(1, Math.min(60, Math.round(Number(d.armor) || 12))),
      torpedo: Math.max(1, Math.min(60, Math.round(Number(d.torpedo) || 12))),
      evasion: Math.max(1, Math.min(60, Math.round(Number(d.evasion) || 16))),
      recon: Math.max(1, Math.min(60, Math.round(Number(d.recon) || 16))),
      aa: Math.max(1, Math.min(60, Math.round(Number(d.aa) || 15))),
      asw: Math.max(1, Math.min(60, Math.round(Number(d.asw) || 14))),
      morale: 82,
      ap: 100,
      maxAp: 100,
      affinity: 10,
      level: 1,
      exp: 0,
      maxExp: 100,
    };
    return {
      id,
      kind: 'character',
      name: String(d.name || '').trim() || `自定义${shipType}`,
      tags: [shipType, cls, '自定义创作'],
      stats,
      statBounds: {
        hp: { min: 0, max: 500 },
        morale: { min: 0, max: 100 },
        ap: { min: 0, max: 100 },
        affinity: { min: 0, max: 100 },
      },
      meta: {
        shipType,
        roleTag: cls === 'AR' ? '前线维修支援' : cls === 'AO' ? '前线补给支援' : '自定义舰娘',
        avatarAssetId: d.avatarAssetId || null,
        statScaleVersion: 2,
        lv1BaseStats: {
          maxHp: stats.maxHp,
          firepower: stats.firepower,
          armor: stats.armor,
          torpedo: stats.torpedo,
          evasion: stats.evasion,
          recon: stats.recon,
          aa: stats.aa,
          asw: stats.asw,
        },
        personality: String(d.personality || '').trim() || '沉着温柔',
        speechHabit: String(d.speechHabit || '').trim() || '「随时准备起航。」',
      },
    };
  }

  function buildGearPayload() {
    const g = cwState.gearDraft;
    const typeOpt = GEAR_TYPE_OPTIONS.find((x) => x.id === g.equipmentType) || GEAR_TYPE_OPTIONS[0];
    const bonuses = [];
    for (const key of ['maxHp', 'firepower', 'armor', 'torpedo', 'evasion', 'recon', 'aa', 'asw']) {
      const val = Math.round(Number(g[key]) || 0);
      if (val !== 0) {
        bonuses.push({ stat: key, layer: 'baseAdd', value: Math.max(-30, Math.min(40, val)) });
      }
    }
    const payload = {
      name: String(g.name || '').trim() || `自定义${typeOpt.label.split(' ')[0]}`,
      category: typeOpt.category,
      subGroup: typeOpt.subGroup,
      subCategory: typeOpt.id,
      equipmentType: typeOpt.id,
      rarity: g.rarity || ITEM_RARITIES.RARE,
      statScaleVersion: 2,
      iconKey: KNOWN_EQUIPMENT_TYPE_MAP[typeOpt.id]?.defaultIcon || typeOpt.id,
      tags: ['自定义装备', typeOpt.label.split(' ')[0]],
      description: String(g.description || '').trim() || '于「自定义工坊」锻造的专属装备。',
      bonuses,
    };
    if (typeOpt.id === 'support') {
      payload.supportRole = g.supportRole === 'resupply' ? 'resupply' : 'repair';
      payload.tags.push(payload.supportRole === 'resupply' ? '前线补给' : '战地抢修');
    }
    if (typeOpt.id === 'outfit') {
      payload.outfitStyle = String(g.outfitStyle || '').trim() || '自定义装束';
    }
    return payload;
  }

  // ------------------------------------------------------------
  // Tab 1: 自定义舰娘
  // ------------------------------------------------------------
  function renderShipTab(host) {
    const d = cwState.shipDraft;
    const section = document.createElement('div');
    section.className = 'lab-stack-sm';
    section.id = 'cw-panel-ship';
    section.innerHTML = `
      <div class="surface-card lab-stack-sm">
        <div class="section-header-row" style="margin-bottom:0;">
          <h3 class="section-title">自定义舰娘工坊（支持 AR 维修舰 / AO 补给舰）</h3>
          <span class="status-badge badge-ok">两位数数值体系</span>
        </div>

        <div class="cw-avatar-row">
          <div class="cw-avatar-box">
            ${
              d.avatarPreviewUrl
                ? `<img src="${d.avatarPreviewUrl}" alt="头像预览" class="cw-avatar-img">`
                : `<span class="muted-text" style="font-size:11px;">默认立绘</span>`
            }
          </div>
          <div class="lab-stack-sm" style="flex:1 1 auto;">
            <button type="button" id="btn-cw-ship-avatar" class="btn-secondary uikit-touch-target">上传舰娘头像/立绘</button>
            <span class="muted-text" style="font-size:11.5px;">自动压缩为 WebP 存入本地 IndexedDB，留空则自动生成舰种几何立绘。</span>
          </div>
        </div>

        <div class="lab-kv-grid">
          <div class="form-group">
            <label class="form-label" for="cw-ship-name">舰娘名称</label>
            <input id="cw-ship-name" class="form-input" type="text" value="${escapeHtml(d.name)}" placeholder="例如：朝霞 / 明石改">
          </div>
          <div class="form-group">
            <label class="form-label" for="cw-ship-type">舰种（含 AR/AO）</label>
            <select id="cw-ship-type" class="form-select">
              ${SHIP_TYPE_PRESETS.map(
                (t) => `<option value="${escapeHtml(t)}" ${t === d.shipType ? 'selected' : ''}>${escapeHtml(t)} (${escapeHtml(resolveShipClass(t))})</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="cw-stat-inputs-grid">
          ${[
            { k: 'maxHp', l: '耐久' },
            { k: 'firepower', l: '火力' },
            { k: 'armor', l: '装甲' },
            { k: 'torpedo', l: '雷击' },
            { k: 'evasion', l: '机动' },
            { k: 'recon', l: '侦查' },
            { k: 'aa', l: '防空' },
            { k: 'asw', l: '反潜' },
          ]
            .map(
              (f) => `
            <label class="cw-num-cell">
              <span>${f.l}</span>
              <input type="number" min="1" max="99" data-cw-ship-stat="${f.k}" value="${Number(d[f.k] ?? 15)}" class="form-input cw-num-input">
            </label>
          `
            )
            .join('')}
        </div>

        <div class="lab-kv-grid">
          <div class="form-group">
            <label class="form-label" for="cw-ship-personality">性格标签</label>
            <input id="cw-ship-personality" class="form-input" type="text" value="${escapeHtml(d.personality)}" placeholder="温柔、干练、元气...">
          </div>
          <div class="form-group">
            <label class="form-label" for="cw-ship-habit">口癖 / 问候台词</label>
            <input id="cw-ship-habit" class="form-input" type="text" value="${escapeHtml(d.speechHabit)}" placeholder="「指挥官，随时待命！」">
          </div>
        </div>

        <div class="lab-btn-grid">
          <button type="button" id="btn-cw-ship-add" class="btn-primary uikit-touch-target">一键加入当前存档名册</button>
          <button type="button" id="btn-cw-ship-export" class="btn-secondary uikit-touch-target">导出舰娘 JSON</button>
        </div>
      </div>
    `;

    section.querySelector('#cw-ship-name')?.addEventListener('input', (e) => {
      cwState.shipDraft.name = e.target.value;
    });
    section.querySelector('#cw-ship-type')?.addEventListener('change', (e) => {
      const nextType = e.target.value;
      cwState.shipDraft.shipType = nextType;
      const preset = SHIP_CLASS_DEFAULT_2DIGIT[nextType];
      if (preset) {
        Object.assign(cwState.shipDraft, preset);
      }
      render();
    });
    section.querySelectorAll('[data-cw-ship-stat]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const k = inp.getAttribute('data-cw-ship-stat');
        cwState.shipDraft[k] = Number(inp.value) || 10;
      });
    });
    section.querySelector('#cw-ship-personality')?.addEventListener('input', (e) => {
      cwState.shipDraft.personality = e.target.value;
    });
    section.querySelector('#cw-ship-habit')?.addEventListener('input', (e) => {
      cwState.shipDraft.speechHabit = e.target.value;
    });

    section.querySelector('#btn-cw-ship-avatar')?.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.onchange = async () => {
        const file = inp.files?.[0];
        if (!file || !assets) return;
        try {
          const saved = await assets.saveImageFile(file, { maxWidth: 420, maxHeight: 420, quality: 0.85 });
          const resolved = await assets.getAssetUrl(saved.id);
          cwState.shipDraft.avatarAssetId = saved.id;
          cwState.shipDraft.avatarPreviewUrl = resolved.url;
          uiKit.showToast('立绘/头像已保存', 'ok');
          render();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '图片处理失败', 'warn');
        }
      };
      inp.click();
    });

    section.querySelector('#btn-cw-ship-add')?.addEventListener('click', async () => {
      const name = String(cwState.shipDraft.name || '').trim();
      if (!name) {
        uiKit.showToast('请输入自定义舰娘名称', 'warn');
        return;
      }
      try {
        const payload = buildShipPayload();
        const entity = entities.register(payload);
        if (statRules?.ensureShipProgression) statRules.ensureShipProgression(entity);
        if (personalityPool?.ensurePersonalityOnEntity) personalityPool.ensurePersonalityOnEntity(entity);

        // Equip starter seaworthy core set so the new custom shipgirl is immediately ready to sortie
        const coreCreates = [
          { slot: 'engine', name: `${name}制式轮机`, category: ITEM_CATEGORIES.ENGINE, bonuses: [{ stat: 'evasion', layer: 'baseAdd', value: 4 }] },
          { slot: 'armor', name: `${name}舰体装甲`, category: ITEM_CATEGORIES.ARMOR, bonuses: [{ stat: 'armor', layer: 'baseAdd', value: 4 }, { stat: 'maxHp', layer: 'baseAdd', value: 4 }] },
          { slot: 'core', name: `${name}火控中枢`, category: ITEM_CATEGORIES.CORE, bonuses: [{ stat: 'firepower', layer: 'baseAdd', value: 4 }, { stat: 'recon', layer: 'baseAdd', value: 3 }] },
        ];
        for (const c of coreCreates) {
          const item = await inventory.createItem({
            name: c.name,
            category: c.category,
            rarity: ITEM_RARITIES.COMMON,
            statScaleVersion: 2,
            bonuses: c.bonuses,
          });
          await inventory.equipItem(entity.id, c.slot, item.id);
        }
        const cls = resolveShipClass(payload.meta.shipType);
        if (cls === 'AR' || cls === 'AO') {
          await inventory.addExpandedSlot(entity.id, 'support', { skipCost: true });
        }

        await persistCharacterRoster({ storage, entities, activeCharacterId: entity.id });
        bus?.emit?.('character:saved', { characterId: entity.id, name: entity.name });
        uiKit.showToast(`自定义舰娘「${entity.name}」（${payload.meta.shipType}）已加入港区名册！`, 'ok');
        cwState.shipDraft.name = '';
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '创建舰娘失败', 'error');
      }
    });

    section.querySelector('#btn-cw-ship-export')?.addEventListener('click', () => {
      const payload = buildShipPayload();
      const modBundle = { format: 'kancolle-pwa-custom-ship-v1', characters: [payload] };
      triggerJsonDownload(`custom-ship-${payload.name}.json`, JSON.stringify(modBundle, null, 2));
      uiKit.showToast(`已导出「${payload.name}」JSON 文件`, 'ok');
    });

    host.appendChild(section);
  }

  // ------------------------------------------------------------
  // Tab 2: 自定义装备
  // ------------------------------------------------------------
  function renderGearTab(host) {
    const g = cwState.gearDraft;
    const section = document.createElement('div');
    section.className = 'lab-stack-sm';
    section.id = 'cw-panel-gear';
    section.innerHTML = `
      <div class="surface-card lab-stack-sm">
        <div class="section-header-row" style="margin-bottom:0;">
          <h3 class="section-title">自定义装备锻造台（支持 support 支援装备）</h3>
          <span class="status-badge badge-ok">白~橙五品级</span>
        </div>

        <div class="lab-kv-grid">
          <div class="form-group">
            <label class="form-label" for="cw-gear-name">装备名称</label>
            <input id="cw-gear-name" class="form-input" type="text" value="${escapeHtml(g.name)}" placeholder="例如：试制双联电磁主炮 / 战地急救包">
          </div>
          <div class="form-group">
            <label class="form-label" for="cw-gear-rarity">装备品级</label>
            <select id="cw-gear-rarity" class="form-select">
              ${ITEM_RARITY_DEFS.map(
                (r) => `<option value="${escapeHtml(r.id)}" ${r.id === g.rarity ? 'selected' : ''}>${escapeHtml(r.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="cw-gear-type">装备类型与槽位匹配</label>
          <select id="cw-gear-type" class="form-select">
            ${GEAR_TYPE_OPTIONS.map(
              (o) => `<option value="${escapeHtml(o.id)}" ${o.id === g.equipmentType ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
            ).join('')}
          </select>
        </div>

        ${
          g.equipmentType === 'support'
            ? `
          <div class="form-group">
            <label class="form-label" for="cw-gear-support-role">后勤支援特殊效果</label>
            <select id="cw-gear-support-role" class="form-select">
              <option value="repair" ${g.supportRole === 'repair' ? 'selected' : ''}>战地抢修（解锁战斗中修复友舰指令 · AR 维修舰增幅）</option>
              <option value="resupply" ${g.supportRole === 'resupply' ? 'selected' : ''}>前线补给（解锁战斗中补给油弹士气指令 · AO 补给舰增幅）</option>
            </select>
          </div>
        `
            : g.equipmentType === 'outfit'
            ? `
          <div class="form-group">
            <label class="form-label" for="cw-gear-outfit-style">装束风格标签</label>
            <input id="cw-gear-outfit-style" class="form-input" type="text" value="${escapeHtml(g.outfitStyle)}" placeholder="水手服 / 晚礼服 / 居家宽衬衫...">
          </div>
        `
            : ''
        }

        <div class="cw-stat-inputs-grid">
          ${[
            { k: 'maxHp', l: '耐久+' },
            { k: 'firepower', l: '火力+' },
            { k: 'armor', l: '装甲+' },
            { k: 'torpedo', l: '雷击+' },
            { k: 'evasion', l: '机动+' },
            { k: 'recon', l: '侦查+' },
            { k: 'aa', l: '防空+' },
            { k: 'asw', l: '反潜+' },
          ]
            .map(
              (f) => `
            <label class="cw-num-cell">
              <span>${f.l}</span>
              <input type="number" min="-20" max="40" data-cw-gear-stat="${f.k}" value="${Number(g[f.k] ?? 0)}" class="form-input cw-num-input">
            </label>
          `
            )
            .join('')}
        </div>

        <div class="form-group">
          <label class="form-label" for="cw-gear-desc">装备说明与特殊效果备注</label>
          <input id="cw-gear-desc" class="form-input" type="text" value="${escapeHtml(g.description)}" placeholder="简述该装备的背景或战术用途...">
        </div>

        <div class="lab-btn-grid">
          <button type="button" id="btn-cw-gear-add" class="btn-primary uikit-touch-target">一键发入装备仓库</button>
          <button type="button" id="btn-cw-gear-export" class="btn-secondary uikit-touch-target">导出装备 JSON</button>
        </div>
      </div>
    `;

    section.querySelector('#cw-gear-name')?.addEventListener('input', (e) => {
      cwState.gearDraft.name = e.target.value;
    });
    section.querySelector('#cw-gear-rarity')?.addEventListener('change', (e) => {
      cwState.gearDraft.rarity = e.target.value;
    });
    section.querySelector('#cw-gear-type')?.addEventListener('change', (e) => {
      cwState.gearDraft.equipmentType = e.target.value;
      render();
    });
    section.querySelector('#cw-gear-support-role')?.addEventListener('change', (e) => {
      cwState.gearDraft.supportRole = e.target.value;
    });
    section.querySelector('#cw-gear-outfit-style')?.addEventListener('input', (e) => {
      cwState.gearDraft.outfitStyle = e.target.value;
    });
    section.querySelectorAll('[data-cw-gear-stat]').forEach((inp) => {
      inp.addEventListener('input', () => {
        cwState.gearDraft[inp.getAttribute('data-cw-gear-stat')] = Number(inp.value) || 0;
      });
    });
    section.querySelector('#cw-gear-desc')?.addEventListener('input', (e) => {
      cwState.gearDraft.description = e.target.value;
    });

    section.querySelector('#btn-cw-gear-add')?.addEventListener('click', async () => {
      if (!String(cwState.gearDraft.name || '').trim()) {
        uiKit.showToast('请输入自定义装备名称', 'warn');
        return;
      }
      try {
        const payload = buildGearPayload();
        const created = await inventory.createItem(payload);
        uiKit.showToast(`自定义装备「${created.name}」已发入「工坊」仓库！`, 'ok');
        cwState.gearDraft.name = '';
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '锻造装备失败', 'error');
      }
    });

    section.querySelector('#btn-cw-gear-export')?.addEventListener('click', () => {
      const payload = buildGearPayload();
      const modBundle = { format: 'kancolle-pwa-custom-gear-v1', equipment: [payload] };
      triggerJsonDownload(`custom-gear-${payload.name}.json`, JSON.stringify(modBundle, null, 2));
      uiKit.showToast(`已导出「${payload.name}」JSON 文件`, 'ok');
    });

    host.appendChild(section);
  }

  // ------------------------------------------------------------
  // Tab 3: 自定义设施与剧情
  // ------------------------------------------------------------
  function renderFacilityStoryTab(host) {
    const customBldgs = buildings?.listCustomBuildings?.() || [];
    const customDlgs = contentManager?.listCustomDialogues?.() || [];
    const wrap = document.createElement('div');
    wrap.className = 'lab-stack-sm';
    wrap.id = 'cw-panel-facility-story';

    // A. Custom Facility Builder
    const bldgCard = document.createElement('section');
    bldgCard.className = 'surface-card lab-stack-sm';
    bldgCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h3 class="section-title">A. + 建造新自定义设施（已建 ${customBldgs.length}）</h3>
      </div>
      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="cw-bldg-name">设施名称</label>
          <input id="cw-bldg-name" class="form-input" type="text" placeholder="例如：深夜茶歇吧 / 气象观测塔">
        </div>
        <div class="form-group">
          <label class="form-label" for="cw-bldg-buff">常驻增益类型</label>
          <select id="cw-bldg-buff" class="form-select">
            ${(CUSTOM_BUFF_TYPES || [])
              .map((bt) => `<option value="${escapeHtml(bt.id)}">${escapeHtml(bt.label)}</option>`)
              .join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="cw-bldg-desc">设施简介</label>
        <input id="cw-bldg-desc" class="form-input" type="text" placeholder="简述设施的港区作用...">
      </div>
      <button type="button" id="btn-cw-bldg-create" class="btn-primary uikit-touch-target">+ 建造新自定义设施（钢180/铝120/银220）</button>
      ${
        customBldgs.length > 0
          ? `<div class="lab-stack-sm">
              ${customBldgs
                .map(
                  (b) => `
                <div class="lab-slot-card interact-drawer-item">
                  <div class="interact-drawer-info">
                    <strong>${escapeHtml(b.name)} · Lv.${b.level || 1}</strong>
                    <div class="cc-stat-sub">${escapeHtml(b.buffLabel || b.buffType || '')}</div>
                  </div>
                  <button type="button" class="btn-danger fac-mini-btn" data-cw-bldg-del="${escapeHtml(b.id)}">拆除</button>
                </div>
              `
                )
                .join('')}
            </div>`
          : ''
      }
    `;

    bldgCard.querySelector('#btn-cw-bldg-create')?.addEventListener('click', async () => {
      const name = bldgCard.querySelector('#cw-bldg-name')?.value?.trim();
      const buffType = bldgCard.querySelector('#cw-bldg-buff')?.value;
      const description = bldgCard.querySelector('#cw-bldg-desc')?.value?.trim() || '';
      if (!name) {
        uiKit.showToast('请输入设施名称', 'warn');
        return;
      }
      try {
        await buildings.createCustomBuilding({ name, buffType, description });
        uiKit.showToast(`已建成自定义设施「${name}」！`, 'ok');
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '建造失败', 'warn');
      }
    });
    bldgCard.querySelectorAll('[data-cw-bldg-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await buildings.deleteCustomBuilding(btn.getAttribute('data-cw-bldg-del'));
        uiKit.showToast('已拆除该设施', 'info');
        render();
      });
    });
    wrap.appendChild(bldgCard);

    // B. Custom Interactive Dialogue Writer
    const dlgCard = document.createElement('section');
    dlgCard.className = 'surface-card lab-stack-sm';
    dlgCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h3 class="section-title">B. 自定义互动台词编写（已收录 ${customDlgs.length} 条）</h3>
      </div>
      <div class="form-group">
        <label class="form-label" for="cw-dlg-stage">触发好感阶段</label>
        <select id="cw-dlg-stage" class="form-select">
          ${DIALOGUE_STAGE_OPTIONS.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="cw-dlg-text">台词内容（支持 {actor} / {cmd} / {outfit} 占位符）</label>
        <textarea id="cw-dlg-text" class="form-textarea" rows="2" placeholder="例如：「{cmd}，今天港区海风很舒服，要一起散散步吗？」"></textarea>
      </div>
      <button type="button" id="btn-cw-dlg-add" class="btn-secondary uikit-touch-target">添加自定义互动台词</button>
      ${
        customDlgs.length > 0
          ? `<div class="lab-stack-sm">
              ${customDlgs
                .slice(-6)
                .reverse()
                .map(
                  (d) => `
                <div class="lab-slot-card interact-drawer-item">
                  <div class="interact-drawer-info">
                    <div class="cc-stat-sub">[${escapeHtml(d.stage || 'any')}] ${escapeHtml(d.text)}</div>
                  </div>
                  <button type="button" class="btn-danger fac-mini-btn" data-cw-dlg-del="${escapeHtml(d.id)}">删除</button>
                </div>
              `
                )
                .join('')}
            </div>`
          : ''
      }
    `;

    dlgCard.querySelector('#btn-cw-dlg-add')?.addEventListener('click', async () => {
      const stage = dlgCard.querySelector('#cw-dlg-stage')?.value || 'any';
      const text = dlgCard.querySelector('#cw-dlg-text')?.value?.trim();
      if (!text) {
        uiKit.showToast('请输入自定义台词内容', 'warn');
        return;
      }
      try {
        await contentManager.createCustomDialogue({ stage, text });
        uiKit.showToast('自定义互动台词已收录！', 'ok');
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '添加失败', 'warn');
      }
    });
    dlgCard.querySelectorAll('[data-cw-dlg-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await contentManager.deleteCustomDialogue(btn.getAttribute('data-cw-dlg-del'));
        uiKit.showToast('已删除该条台词', 'info');
        render();
      });
    });
    wrap.appendChild(dlgCard);

    // C. Custom Maritime Encounter Writer
    const encCard = document.createElement('section');
    encCard.className = 'surface-card lab-stack-sm';
    encCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h3 class="section-title">C. 自定义海事奇遇事件编写</h3>
        <span class="status-badge badge-muted">出征海遇自动抽选</span>
      </div>
      <div class="form-group">
        <label class="form-label" for="cw-enc-title">奇遇标题</label>
        <input id="cw-enc-title" class="form-input" type="text" placeholder="例如：月夜漂流灯塔">
      </div>
      <div class="form-group">
        <label class="form-label" for="cw-enc-body">奇遇剧情描述（支持 {{flagship}} 旗舰名）</label>
        <textarea id="cw-enc-body" class="form-textarea" rows="2" placeholder="海面浮起一盏暖光信号灯，{{flagship}}轻声向你汇报..."></textarea>
      </div>
      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="cw-enc-c1">选项 1 文案</label>
          <input id="cw-enc-c1" class="form-input" type="text" value="靠前探索并打捞补给">
        </div>
        <div class="form-group">
          <label class="form-label" for="cw-enc-c2">选项 2 文案</label>
          <input id="cw-enc-c2" class="form-input" type="text" value="稳健绕行继续航程">
        </div>
      </div>
      <button type="button" id="btn-cw-enc-save" class="btn-primary uikit-touch-target">保存为外置海事奇遇包</button>
    `;

    encCard.querySelector('#btn-cw-enc-save')?.addEventListener('click', async () => {
      const title = encCard.querySelector('#cw-enc-title')?.value?.trim();
      const text = encCard.querySelector('#cw-enc-body')?.value?.trim();
      const c1 = encCard.querySelector('#cw-enc-c1')?.value?.trim() || '上前调查';
      const c2 = encCard.querySelector('#cw-enc-c2')?.value?.trim() || '稳健绕航';
      if (!title || !text) {
        uiKit.showToast('请填写奇遇标题与剧情描述', 'warn');
        return;
      }
      try {
        await storyPacks.savePack({
          id: `custom_enc_${Date.now().toString(36)}`,
          title,
          category: 'maritime',
          builtIn: false,
          enabled: true,
          startNodeId: 'n_start',
          nodes: [
            {
              id: 'n_start',
              text,
              choices: [
                { id: 'c1', label: c1, nextText: '舰队顺利完成调查，收获补给与好感！' },
                { id: 'c2', label: c2, nextText: '舰队平稳通过该海域，全员状态良好。' },
              ],
            },
          ],
        });
        uiKit.showToast(`自定义海事奇遇「${title}」已保存并启用！`, 'ok');
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '保存奇遇失败', 'warn');
      }
    });
    wrap.appendChild(encCard);

    host.appendChild(wrap);
  }

  // ------------------------------------------------------------
  // Tab 4: 模组包管理（JSON 导入/导出）
  // ------------------------------------------------------------
  function renderModPacksTab(host) {
    const extPacks = (storyPacks?.listPacks?.() || []).filter((p) => !p.builtIn);
    const wrap = document.createElement('div');
    wrap.className = 'lab-stack-sm';
    wrap.id = 'cw-panel-mod-packs';

    const importCard = document.createElement('section');
    importCard.className = 'surface-card lab-stack-sm';
    importCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h3 class="section-title">外部 JSON 内容包导入（智能字段适配）</h3>
        <span class="status-badge badge-ok">开新档永久保留</span>
      </div>
      <p class="muted-text" style="font-size:12px; margin:0;">
        支持直接粘贴或选择本地 <code>.json</code> 文件（兼容舰娘、装备、敌舰、性格词库、互动台词与外置剧情/海遇包，自动转换常见字段变体）。
      </p>
      <textarea id="cw-json-textarea" class="form-textarea" rows="6" placeholder="在此粘贴完整 JSON 对象 {...} 或条目数组 [...]"></textarea>
      ${
        cwState.lastImportReport
          ? `<div class="status-badge badge-ok" style="white-space:normal;">${escapeHtml(cwState.lastImportReport)}</div>`
          : ''
      }
      <div class="lab-btn-grid">
        <button type="button" id="btn-cw-json-import" class="btn-primary uikit-touch-target">解析并导入 JSON</button>
        <button type="button" id="btn-cw-json-file" class="btn-secondary uikit-touch-target">选择本地 .json 文件</button>
      </div>
      <input type="file" id="input-cw-json-file" accept="application/json,.json" hidden>
    `;

    const doSmartImport = async (rawText) => {
      try {
        const res = await contentManager.smartImportJSONText(rawText, {
          mode: 'merge',
          storyPacks,
          personalityPool,
          statRules,
        });
        await persistCharacterRoster({ storage, entities });
        const summary = res?.summary || res?.message || '外部 JSON 内容包导入成功！';
        cwState.lastImportReport = summary;
        uiKit.showToast(summary, 'ok');
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : 'JSON 解析或导入失败', 'error');
      }
    };

    importCard.querySelector('#btn-cw-json-import')?.addEventListener('click', () => {
      const raw = importCard.querySelector('#cw-json-textarea')?.value?.trim();
      if (!raw) {
        uiKit.showToast('请先粘贴 JSON 内容', 'warn');
        return;
      }
      doSmartImport(raw);
    });

    const fileInput = importCard.querySelector('#input-cw-json-file');
    importCard.querySelector('#btn-cw-json-file')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      const text = await f.text();
      fileInput.value = '';
      await doSmartImport(text);
    });
    wrap.appendChild(importCard);

    // Imported External Story/Mod Packs List + Backup Export
    const listCard = document.createElement('section');
    listCard.className = 'surface-card lab-stack-sm';
    listCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h3 class="section-title">已导入外置剧情与奇遇包（${extPacks.length}）</h3>
        <button type="button" id="btn-cw-export-all" class="btn-secondary fac-mini-btn">导出全部备份 JSON</button>
      </div>
      ${
        extPacks.length === 0
          ? '<p class="muted-text" style="font-size:12px;">当前尚无外置剧情/海遇包，可在上方粘贴导入或在「设施与剧情」分栏自行编写。</p>'
          : extPacks
              .map(
                (p) => `
            <div class="lab-slot-card interact-drawer-item" data-cw-pack="${escapeHtml(p.id)}">
              <div class="interact-drawer-info">
                <strong>${escapeHtml(p.title || p.id)}</strong>
                <div class="cc-stat-sub">节点数 ${(p.nodes || []).length} · ${p.enabled !== false ? '已启用' : '已停用'}</div>
              </div>
              <div style="display:flex; gap:6px; flex-shrink:0;">
                <button type="button" class="btn-secondary fac-mini-btn" data-cw-pack-toggle="${escapeHtml(p.id)}">${p.enabled !== false ? '停用' : '启用'}</button>
                <button type="button" class="btn-danger fac-mini-btn" data-cw-pack-del="${escapeHtml(p.id)}">删除</button>
              </div>
            </div>
          `
              )
              .join('')
      }
    `;

    listCard.querySelector('#btn-cw-export-all')?.addEventListener('click', () => {
      const worldMod = contentManager?.exportWorldMod ? contentManager.exportWorldMod({ name: '自定义工坊内容库备份' }) : {};
      const bundle = {
        ...worldMod,
        storyPacks: extPacks,
        exportedAt: new Date().toISOString(),
      };
      triggerJsonDownload(`kancolle-custom-library-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2));
      uiKit.showToast('已导出全部自定义内容库 JSON 备份', 'ok');
    });

    listCard.querySelectorAll('[data-cw-pack-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await storyPacks.togglePack(btn.getAttribute('data-cw-pack-toggle'));
        render();
      });
    });

    listCard.querySelectorAll('[data-cw-pack-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await storyPacks.deletePack(btn.getAttribute('data-cw-pack-del'));
        uiKit.showToast('已移除该外置包', 'info');
        render();
      });
    });
    wrap.appendChild(listCard);

    host.appendChild(wrap);
  }

  function render() {
    modal.innerHTML = `
      <header class="sheet-header uikit-tactical-header cw-modal-header">
        <div>
          <h2 class="sheet-title uikit-tactical-title">自定义工坊</h2>
          <p class="muted-text" style="font-size:11.5px; margin:2px 0 0;">独立创作与模组管理中心（与主游玩界面完全隔离）</p>
        </div>
        <button type="button" id="btn-cw-close" class="btn-icon-close" aria-label="关闭自定义工坊">✕</button>
      </header>
      <div class="cw-tabs-bar" data-no-swipe="true" role="tablist">
        ${CW_TABS.map(
          (t) => `
          <button
            type="button"
            class="cw-tab-btn ${t.id === cwState.activeTab ? 'is-active' : ''}"
            data-cw-tab="${escapeHtml(t.id)}"
            role="tab"
            aria-selected="${t.id === cwState.activeTab ? 'true' : 'false'}"
          >${escapeHtml(t.label)}</button>
        `
        ).join('')}
      </div>
      <div class="sheet-body uikit-tactical-body cw-modal-body" id="cw-modal-body"></div>
    `;

    modal.querySelector('#btn-cw-close')?.addEventListener('click', close);
    modal.querySelectorAll('[data-cw-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        cwState.activeTab = btn.getAttribute('data-cw-tab');
        render();
      });
    });

    const bodyEl = modal.querySelector('#cw-modal-body');
    if (cwState.activeTab === 'ship') {
      renderShipTab(bodyEl);
    } else if (cwState.activeTab === 'gear') {
      renderGearTab(bodyEl);
    } else if (cwState.activeTab === 'facility_story') {
      renderFacilityStoryTab(bodyEl);
    } else {
      renderModPacksTab(bodyEl);
    }
  }

  render();
  document.body.appendChild(backdrop);
  activeBackdrop = backdrop;
}
