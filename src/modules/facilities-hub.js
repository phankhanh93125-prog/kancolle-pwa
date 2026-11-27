/**
 * Tab 5 Module: Port Facilities & Shop Hub (`port-facilities-hub` · 设施).
 *
 * Consolidates all port-wide production, commerce, infrastructure, and extensibility
 * with ZERO overlap with Tabs 1~4:
 *   1. 自由配方舰船建造 (30~600 sliders, live 8-class AR/AO odds, fast-build blueprint support, instant build)
 *   2. 军需与衣装商店（四大货架）:
 *        - 衣装定制馆 (outfits -> unlocks straight into Tab 1 「互动」 Wardrobe Drawer)
 *        - 心意礼物铺 (gifts -> stacks into backpack for Tab 1 「互动」 Gift Drawer)
 *        - 军需物资站 (fast-build blueprint, emergency supply box, damage control kit, purple/orange blueprint chests, commander stat reset book)
 *        - 港区特许处 (custom slot expand permit, dockyard repair bay expansion ticket)
 *   3. 远征派遣与港区基建升级 (Expeditions dispatch/claim + 舰娘宿舍 + 后勤仓库 upgrade)
 *   4. 图鉴与自定义扩展 (Compendium studio shortcut, direct paste JSON external library import, + 建造新自定义设施)
 */

import {
  CONSTRUCTION_RECIPE_PRESETS,
  CUSTOM_BUFF_TYPES,
  computeConstructionProbabilities,
} from '../core/port-buildings.js';
import {
  ITEM_RARITY_MAP,
  getShipClassSvg,
} from '../core/stat-rules.js';
import { ITEM_CATEGORIES, getItemIconSvg } from '../core/inventory-system.js';
import { LOG_CATEGORIES } from '../core/log-system.js';
import { FOUR_SHELF_CATALOG, SHOP_SHELVES } from '../data/shop-catalog.js';
import { openCharacterCardById, persistCharacterRoster } from './character-console.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDurationZh(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m}分${remS}秒` : `${m}分钟`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}时${remM}分` : `${h}小时`;
}

function formatCostInline(costObj, resources) {
  return Object.entries(costObj || {})
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${resources?.get(k)?.name || k} ${v}`)
    .join(' · ');
}

const SECTION_TABS = [
  { id: 'shop', label: '四大货架商店' },
  { id: 'build', label: '舰船建造' },
  { id: 'infra', label: '远征与基建' },
  { id: 'studio', label: '图鉴与扩展' },
];

const state = {
  container: null,
  context: null,
  activeSection: 'shop', // 'shop' | 'build' | 'infra' | 'studio'
  activeShelf: 'outfits', // 'outfits' | 'gifts' | 'supplies' | 'permits'
  recipe: { fuel: 240, ammo: 140, steel: 240, bauxite: 340, customName: '' },
  lastBuildResult: null,
  lastChestItem: null,
  selectedExpMissionId: 'exp_harbor_patrol',
  selectedExpShipIds: [],
  timer: null,
  unsubs: [],
};

export function openFacilitiesSection(sectionId = 'shop', shelfId = null) {
  if (SECTION_TABS.some((t) => t.id === sectionId)) {
    state.activeSection = sectionId;
  }
  if (shelfId && SHOP_SHELVES.some((s) => s.id === shelfId)) {
    state.activeShelf = shelfId;
  }
  if (state.container && state.context) {
    render();
  }
}

export function resetFacilitiesHubState() {
  state.lastBuildResult = null;
  state.lastChestItem = null;
  state.selectedExpShipIds = [];
}

function getStockMap(resources) {
  return {
    fuel: Math.floor(Number(resources?.get('fuel')?.amount ?? 0)),
    ammo: Math.floor(Number(resources?.get('ammo')?.amount ?? 0)),
    steel: Math.floor(Number(resources?.get('steel')?.amount ?? 0)),
    bauxite: Math.floor(Number(resources?.get('bauxite')?.amount ?? 0)),
    silver: Math.floor(Number(resources?.get('silver')?.amount ?? 0)),
    gold: Math.floor(Number(resources?.get('gold')?.amount ?? 0)),
  };
}

// ============================================================
// Custom Facility Builder Modal (Preserved "+ 建造新自定义设施")
// ============================================================
function openCreateCustomBuildingModal(context, onDone) {
  const { buildings, resources, uiKit } = context;
  const openFn = typeof uiKit.openTacticalModal === 'function' ? uiKit.openTacticalModal : uiKit.openModal;

  openFn({
    title: '建造新自定义设施',
    subtitle: '为港区增建专属功能建筑，提供常驻增益并可指派舰娘驻守',
    renderContent: (body, close) => {
      body.innerHTML = `
        <form id="custom-bldg-form" class="module-stack">
          <div class="form-group">
            <label class="form-label" for="cb-name">设施名称</label>
            <input id="cb-name" class="form-input" type="text" placeholder="例如：深夜茶歇吧 / 战术气象台" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="cb-buff-type">常驻增益类型</label>
            <select id="cb-buff-type" class="form-select">
              ${(CUSTOM_BUFF_TYPES || []).map(
                (bt) => `<option value="${escapeHtml(bt.id)}">${escapeHtml(bt.label)}（${escapeHtml(bt.desc || '')}）</option>`
              ).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="cb-desc">设施简介</label>
            <input id="cb-desc" class="form-input" type="text" placeholder="描述设施的港区特色与日常作用...">
          </div>
          <p class="muted-text" style="font-size:12px;">建造成本：钢材 180 · 铝材 120 · 银条 220（可升级并驻守舰娘）</p>
          <div class="lab-btn-grid">
            <button type="button" id="btn-cb-cancel" class="btn-secondary uikit-touch-target">取消</button>
            <button type="submit" id="btn-cb-submit" class="btn-primary uikit-touch-target">立即建造</button>
          </div>
        </form>
      `;

      body.querySelector('#btn-cb-cancel')?.addEventListener('click', () => close());
      body.querySelector('#custom-bldg-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = body.querySelector('#cb-name')?.value?.trim();
        const buffType = body.querySelector('#cb-buff-type')?.value;
        const description = body.querySelector('#cb-desc')?.value?.trim() || '';
        if (!name) {
          uiKit.showToast('请输入自定义设施名称', 'warn');
          return;
        }
        try {
          await buildings.createCustomBuilding({ name, buffType, description });
          uiKit.showToast(`已新建自定义设施「${name}」！`, 'ok');
          close();
          if (typeof onDone === 'function') onDone();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '建造失败', 'warn');
        }
      });
    },
  });
}

// ============================================================
// Direct Paste External JSON Modal
// ============================================================
function openDirectJsonImportModal(context, onDone) {
  const { contentManager, personalityPool, storyPacks, statRules, entities, rootStorage, uiKit } = context;
  const openFn = typeof uiKit.openTacticalModal === 'function' ? uiKit.openTacticalModal : uiKit.openModal;

  openFn({
    title: '粘贴导入外置 JSON 内容库',
    subtitle: '支持舰娘/装备/敌舰/台词/性格/外置剧情包（自动适配字段，开新档永久保留）',
    wide: true,
    renderContent: (body, close) => {
      body.innerHTML = `
        <div class="module-stack">
          <textarea id="fac-json-paste" class="form-textarea" rows="8" placeholder="在此直接粘贴完整 JSON 对象或条目数组 [...]"></textarea>
          <div class="lab-btn-grid">
            <button type="button" id="btn-fac-json-cancel" class="btn-secondary uikit-touch-target">取消</button>
            <button type="button" id="btn-fac-json-apply" class="btn-primary uikit-touch-target">解析并导入内容库</button>
          </div>
        </div>
      `;
      body.querySelector('#btn-fac-json-cancel')?.addEventListener('click', () => close());
      body.querySelector('#btn-fac-json-apply')?.addEventListener('click', async () => {
        const raw = body.querySelector('#fac-json-paste')?.value?.trim();
        if (!raw) {
          uiKit.showToast('请先粘贴 JSON 内容', 'warn');
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const res = await contentManager.importModBundle(parsed, {
            personalityPool,
            storyPacks,
            statRules,
            persistRosterFn: () => persistCharacterRoster({ storage: rootStorage, entities }),
          });
          const summary = res?.summaryText || '外置内容库导入成功';
          uiKit.showToast(summary, 'ok');
          close();
          if (typeof onDone === 'function') onDone();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? `导入失败：${err.message}` : 'JSON 格式错误', 'error');
        }
      });
    },
  });
}

// ============================================================
// Purchase Handler for 4-Shelf Shop
// ============================================================
async function handleShopPurchase(offer) {
  const { resources, inventory, commander, buildings, logs, uiKit, fxStage } = state.context;
  if (!offer) return;

  // Guard already-owned outfit
  if (offer.shelf === 'outfits') {
    const owned = inventory.listOwnedOutfits().some((it) => it.id === offer.itemId || it.name === offer.name);
    if (owned) {
      uiKit.showToast(`「${offer.name}」已解锁，可直接前往「互动 → 更换装束」穿戴`, 'info');
      return;
    }
  }

  // Guard dock bay max cap before spending gold
  if (offer.actionType === 'expand_dock_bay') {
    const dock = buildings.getDockyardState();
    if (!dock.canExpand) {
      uiKit.showToast(`船坞维修席位已达上限（${dock.capacity}/${dock.maxCapacity}），无需再扩建`, 'warn');
      return;
    }
  }

  const currencyLabel = offer.currency === 'gold' ? '金条' : '银条';
  const spend = await resources.spendBatch({ [offer.currency]: offer.price }, {
    reason: `设施商店购买「${offer.name}」`,
  });
  if (!spend.ok) {
    uiKit.showToast(`${currencyLabel}不足（需要 ${offer.price} ${currencyLabel}）`, 'warn');
    return;
  }

  try {
    if (offer.shelf === 'outfits') {
      await inventory.createItem({
        id: offer.itemId,
        name: offer.name,
        category: ITEM_CATEGORIES.OUTFIT,
        rarity: offer.rarity,
        outfitStyle: offer.outfitStyle,
        iconKey: offer.iconKey || 'outfit_casual',
        description: offer.description,
        bonuses: offer.bonuses || [],
        tags: ['衣装定制馆', offer.outfitStyle || '装束'],
      });
      fxStage?.playSfx?.('success');
      uiKit.showToast(`已解锁「${offer.name}」！前往「互动 → 更换装束」即可为舰娘换上`, 'ok');
    } else if (offer.shelf === 'gifts') {
      await inventory.createItem(
        {
          id: offer.itemId,
          name: offer.name,
          category: ITEM_CATEGORIES.CONSUMABLE,
          rarity: offer.rarity,
          quantity: 1,
          tags: offer.tags || ['心意礼物', '礼物'],
          description: offer.description,
          bonuses: offer.bonuses || [],
        },
        { stackByName: true }
      );
      fxStage?.playSfx?.('success');
      uiKit.showToast(`已购入「${offer.name}」×1 存入背包，可在「互动 → 赠送礼物」赠出！`, 'ok');
    } else if (offer.actionType === 'open_gear_chest') {
      const rolled = await inventory.rollLootDropItem({
        tier: offer.chestRarity === 'legendary' ? 'boss' : 'elite',
        difficulty: 'star_4',
        forcedRarity: offer.chestRarity,
      });
      state.lastChestItem = rolled;
      const rLabel = ITEM_RARITY_MAP[rolled?.rarity]?.label || '高阶';
      fxStage?.playSfx?.('success');
      uiKit.showToast(`设计图解析完成！获得【${rLabel}】「${rolled?.name || '舰装'}」，已存入「工坊」仓库！`, 'ok');
    } else if (offer.actionType === 'reset_commander_stats') {
      const res = await commander.resetAllocatedStats();
      fxStage?.playSfx?.('success');
      uiKit.showToast(`已重塑指挥官六维属性！返还自由属性点（当前可分配 ${res.profile.freePoints} 点）`, 'ok');
    } else if (offer.actionType === 'expand_dock_bay') {
      const next = await buildings.expandDockyard({ skipCost: true });
      fxStage?.playSfx?.('success');
      uiKit.showToast(`特许扩建生效！船坞维修渠位已永久扩充至 ${next.capacity}/${next.maxCapacity}！`, 'ok');
    } else {
      // store_item: fast-build blueprint / emergency supply box / damage control kit / slot expand permit
      await inventory.createItem(
        {
          id: offer.itemId,
          name: offer.name,
          category: ITEM_CATEGORIES.CONSUMABLE,
          rarity: offer.rarity,
          quantity: 1,
          tags: offer.tags || ['军需物资'],
          description: offer.description,
          bonuses: offer.bonuses || [],
        },
        { stackByName: true }
      );
      fxStage?.playSfx?.('success');
      uiKit.showToast(`已购入「${offer.name}」×1 存入仓库背包！`, 'ok');
    }

    logs?.add?.({
      category: LOG_CATEGORIES.RESOURCE,
      title: `商店购入「${offer.name}」`,
      detail: `消耗 ${currencyLabel} ${offer.price}`,
    });
  } catch (err) {
    uiKit.showToast(err instanceof Error ? err.message : '购买执行失败', 'error');
  }

  render();
}

// ============================================================
// Section Renderers
// ============================================================

function renderShopSection(stock) {
  const { inventory, buildings } = state.context;
  const activeShelf = SHOP_SHELVES.find((s) => s.id === state.activeShelf) || SHOP_SHELVES[0];
  const offers = FOUR_SHELF_CATALOG[activeShelf.id] || [];
  const ownedOutfits = inventory.listOwnedOutfits();
  const ownedOutfitIds = new Set(ownedOutfits.map((it) => it.id));
  const ownedOutfitNames = new Set(ownedOutfits.map((it) => it.name));
  const dock = buildings.getDockyardState();

  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm';
  card.id = 'facilities-shop-section';

  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">港区军需与衣装商店</h2>
      <span class="status-badge badge-muted">银 ${stock.silver} · 金 ${stock.gold}</span>
    </div>

    <div class="fac-shelf-pills" data-no-swipe="true" role="tablist">
      ${SHOP_SHELVES.map(
        (s) => `
        <button
          type="button"
          class="fac-shelf-pill ${s.id === activeShelf.id ? 'is-active' : ''}"
          data-shop-shelf="${escapeHtml(s.id)}"
          role="tab"
          aria-selected="${s.id === activeShelf.id ? 'true' : 'false'}"
        >${escapeHtml(s.label)}</button>
      `
      ).join('')}
    </div>

    <p class="muted-text" style="font-size:12px; margin:0;">${escapeHtml(activeShelf.desc)}</p>

    ${
      state.lastChestItem && activeShelf.id === 'supplies'
        ? `
      <div class="fac-chest-banner" id="fac-chest-result">
        <span>✨ 最近解析图纸：<strong>${escapeHtml(state.lastChestItem.name)}</strong>（${escapeHtml(ITEM_RARITY_MAP[state.lastChestItem.rarity]?.label || '')}）</span>
        <button type="button" class="btn-secondary fac-mini-btn" id="btn-fac-goto-workshop">去工坊查看</button>
      </div>
    `
        : ''
    }

    <div class="fac-shop-grid" id="fac-shop-offers">
      ${offers
        .map((offer) => {
          const rDef = ITEM_RARITY_MAP[offer.rarity] || ITEM_RARITY_MAP.common;
          const isOutfitOwned =
            offer.shelf === 'outfits' &&
            (ownedOutfitIds.has(offer.itemId) || ownedOutfitNames.has(offer.name));
          const isDockFull = offer.actionType === 'expand_dock_bay' && !dock.canExpand;
          const canAfford = (stock[offer.currency] ?? 0) >= offer.price;
          const curQty = offer.itemId ? Number(inventory.getItem(offer.itemId)?.quantity || 0) : 0;
          const curLabel = offer.currency === 'gold' ? '金条' : '银条';
          const btnDisabled = isOutfitOwned || isDockFull || !canAfford;
          const btnText = isOutfitOwned
            ? '已解锁衣装'
            : isDockFull
            ? '渠位已满上限'
            : `${offer.price} ${curLabel} 购入`;

          return `
          <div class="fac-offer-card rarity-border-${escapeHtml(offer.rarity || 'common')}" data-shop-offer="${escapeHtml(offer.id)}">
            <div class="fac-offer-head">
              <div class="fac-offer-title-wrap">
                <span class="fac-offer-ico">${getItemIconSvg({ iconKey: offer.iconKey, category: offer.category }, { size: 18 })}</span>
                <strong>${escapeHtml(offer.name)}</strong>
              </div>
              <span class="status-badge rarity-badge-${escapeHtml(offer.rarity || 'common')}">${escapeHtml(rDef.label)}</span>
            </div>
            <p class="fac-offer-desc">${escapeHtml(offer.description)}</p>
            <div class="fac-offer-foot">
              <span class="muted-text" style="font-size:11.5px;">
                ${
                  offer.shelf === 'gifts'
                    ? `背包库存 ${curQty} · 好感 +${offer.affinityGain}`
                    : offer.shelf === 'outfits'
                    ? `风格：${escapeHtml(offer.outfitStyle || '装束')}`
                    : offer.itemId
                    ? `背包库存 ${curQty}`
                    : '购后即刻生效'
                }
              </span>
              <button
                type="button"
                class="${btnDisabled ? 'btn-secondary' : 'btn-primary'} fac-buy-btn"
                data-buy-offer="${escapeHtml(offer.id)}"
                ${btnDisabled ? 'disabled' : ''}
              >${escapeHtml(btnText)}</button>
            </div>
          </div>
        `;
        })
        .join('')}
    </div>
  `;

  card.querySelectorAll('[data-shop-shelf]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeShelf = btn.getAttribute('data-shop-shelf');
      render();
    });
  });

  card.querySelectorAll('[data-buy-offer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-buy-offer');
      const offer = offers.find((o) => o.id === id);
      if (offer) handleShopPurchase(offer);
    });
  });

  card.querySelector('#btn-fac-goto-workshop')?.addEventListener('click', () => {
    state.context.modules?.mount('supply-workshop', { transition: 'right' });
  });

  return card;
}

function renderBuildSection(stock) {
  const { buildings, inventory, entities, rootStorage, uiKit } = state.context;
  const recipe = state.recipe;
  const probs = computeConstructionProbabilities(recipe);
  const fastBpQty = Number(inventory.getItem('item_supply_fast_build_bp')?.quantity || 0);
  const silverFee = fastBpQty > 0 ? 0 : 60;
  const coresOwned = inventory.getRetrofitCores ? inventory.getRetrofitCores() : 0;
  const canAfford =
    stock.fuel >= recipe.fuel &&
    stock.ammo >= recipe.ammo &&
    stock.steel >= recipe.steel &&
    stock.bauxite >= recipe.bauxite &&
    stock.silver >= silverFee;

  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm';
  card.id = 'facilities-build-section';

  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">自由配方舰船建造（零等待出坞）</h2>
      <span class="status-badge badge-ok">改造核心 ${coresOwned}</span>
    </div>

    <div class="chip-row" data-no-swipe="true">
      ${CONSTRUCTION_RECIPE_PRESETS.map(
        (p) => `<button type="button" class="preset-chip" data-fac-preset="${escapeHtml(p.id)}">${escapeHtml(p.label)}</button>`
      ).join('')}
    </div>

    <div class="lab-stack-sm" data-no-swipe="true">
      ${[
        { key: 'fuel', label: '燃油' },
        { key: 'ammo', label: '弹药' },
        { key: 'steel', label: '钢材' },
        { key: 'bauxite', label: '铝材' },
      ]
        .map(
          (r) => `
        <div class="construction-slider-row">
          <div class="construction-slider-head">
            <label for="fac-sl-${r.key}"><strong>${r.label}</strong></label>
            <span class="${stock[r.key] < recipe[r.key] ? 'stat-diff-inline-down' : 'muted-text'}" data-fac-val="${r.key}">
              投入 <strong>${recipe[r.key]}</strong> / 库存 ${stock[r.key]}
            </span>
          </div>
          <input id="fac-sl-${r.key}" data-fac-slider="${r.key}" type="range" min="30" max="600" step="10" value="${recipe[r.key]}" style="width:100%;">
        </div>
      `
        )
        .join('')}
    </div>

    <div class="form-group">
      <label class="form-label" for="fac-build-name">自定义新舰命名（留空按舰种随机名舰）</label>
      <input id="fac-build-name" class="form-input" type="text" value="${escapeHtml(recipe.customName)}" placeholder="留空自动命名...">
    </div>

    <div class="construction-prob-grid" id="fac-prob-grid">
      ${probs
        .map((p) => {
          const isSup = p.shipClass === 'AR' || p.shipClass === 'AO';
          return `
          <div class="construction-prob-row ${isSup ? 'is-support' : ''}">
            <div class="construction-prob-label">
              <span class="ship-class-ico">${getShipClassSvg(p.shipClass, { size: 14 })}</span>
              <span>${escapeHtml(p.shipType)} (${escapeHtml(p.shipClass)})</span>
              <strong>${p.pct.toFixed(1)}%</strong>
            </div>
            <div class="construction-prob-track">
              <div class="construction-prob-fill ${isSup ? 'is-support' : ''}" style="width:${Math.min(100, Math.max(2, p.pct * 1.4))}%"></div>
            </div>
          </div>
        `;
        })
        .join('')}
    </div>

    ${
      state.lastBuildResult
        ? `
      <div class="surface-card construction-result-card ${state.lastBuildResult.isDuplicate ? 'is-duplicate' : 'is-new'}" id="fac-build-result">
        ${
          state.lastBuildResult.isDuplicate
            ? `<strong>♻ 重复舰转化：${escapeHtml(state.lastBuildResult.shipName)}</strong>
               <p class="muted-text" style="font-size:12px; margin:4px 0 0;">获得改造核心 ×${state.lastBuildResult.retrofitCoreGained} · ${escapeHtml(state.lastBuildResult.giftName)} ×1 · 银条 +${state.lastBuildResult.silverBonus}</p>`
            : `<strong>★ 建造成功：${escapeHtml(state.lastBuildResult.shipName)}（${escapeHtml(state.lastBuildResult.shipType)}）</strong>
               <p class="muted-text" style="font-size:12px; margin:4px 0 0;">已配发基础核心件${state.lastBuildResult.classCode === 'AR' || state.lastBuildResult.classCode === 'AO' ? '与后勤支援槽位' : ''}，随时可编队出征！</p>`
        }
      </div>
    `
        : ''
    }

    <button type="button" id="btn-fac-do-build" class="btn-primary uikit-touch-target" ${canAfford ? '' : 'disabled'}>
      ${
        !canAfford
          ? '资源或银条不足'
          : fastBpQty > 0
          ? `立即建造（使用快建图纸免银条 · 剩余 ${fastBpQty}）`
          : '立即建造（建坞费 银条 60）'
      }
    </button>
  `;

  card.querySelectorAll('[data-fac-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = CONSTRUCTION_RECIPE_PRESETS.find((x) => x.id === btn.getAttribute('data-fac-preset'));
      if (!p) return;
      recipe.fuel = p.fuel;
      recipe.ammo = p.ammo;
      recipe.steel = p.steel;
      recipe.bauxite = p.bauxite;
      render();
    });
  });

  card.querySelectorAll('[data-fac-slider]').forEach((sl) => {
    sl.addEventListener('input', () => {
      const key = sl.getAttribute('data-fac-slider');
      recipe[key] = Number(sl.value) || 30;
      const valEl = card.querySelector(`[data-fac-val="${key}"]`);
      if (valEl) {
        valEl.className = stock[key] < recipe[key] ? 'stat-diff-inline-down' : 'muted-text';
        valEl.innerHTML = `投入 <strong>${recipe[key]}</strong> / 库存 ${stock[key]}`;
      }
      const nextProbs = computeConstructionProbabilities(recipe);
      const grid = card.querySelector('#fac-prob-grid');
      if (grid) {
        grid.innerHTML = nextProbs
          .map((p) => {
            const isSup = p.shipClass === 'AR' || p.shipClass === 'AO';
            return `
            <div class="construction-prob-row ${isSup ? 'is-support' : ''}">
              <div class="construction-prob-label">
                <span class="ship-class-ico">${getShipClassSvg(p.shipClass, { size: 14 })}</span>
                <span>${escapeHtml(p.shipType)} (${escapeHtml(p.shipClass)})</span>
                <strong>${p.pct.toFixed(1)}%</strong>
              </div>
              <div class="construction-prob-track">
                <div class="construction-prob-fill ${isSup ? 'is-support' : ''}" style="width:${Math.min(100, Math.max(2, p.pct * 1.4))}%"></div>
              </div>
            </div>
          `;
          })
          .join('');
      }
      const btn = card.querySelector('#btn-fac-do-build');
      if (btn) {
        const okNow =
          stock.fuel >= recipe.fuel &&
          stock.ammo >= recipe.ammo &&
          stock.steel >= recipe.steel &&
          stock.bauxite >= recipe.bauxite &&
          stock.silver >= silverFee;
        btn.disabled = !okNow;
        btn.textContent = !okNow
          ? '资源或银条不足'
          : fastBpQty > 0
          ? `立即建造（使用快建图纸免银条 · 剩余 ${fastBpQty}）`
          : '立即建造（建坞费 银条 60）';
      }
    });
  });

  card.querySelector('#fac-build-name')?.addEventListener('input', (e) => {
    recipe.customName = e.target.value;
  });

  card.querySelector('#btn-fac-do-build')?.addEventListener('click', async () => {
    try {
      const res = await buildings.constructShipByRecipe({
        fuel: recipe.fuel,
        ammo: recipe.ammo,
        steel: recipe.steel,
        bauxite: recipe.bauxite,
        customName: recipe.customName,
      });
      await persistCharacterRoster({
        storage: rootStorage,
        entities,
        activeCharacterId: res.entity?.id || undefined,
      });
      state.lastBuildResult = res;
      recipe.customName = '';
      uiKit.showToast(
        res.isDuplicate
          ? `重复舰「${res.shipName}」已转化为改造核心 ×1！`
          : `建造成功！「${res.shipName}」（${res.shipType}）已入港！`,
        'ok'
      );
      render();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '建造失败', 'warn');
    }
  });

  return card;
}

function renderInfraSection() {
  const { expeditions, buildings, entities, resources, rootStorage, uiKit } = state.context;
  const wrap = document.createElement('div');
  wrap.className = 'lab-stack-sm';
  wrap.id = 'facilities-infra-section';

  const missions = expeditions.listMissions();
  const activeRuns = expeditions.getActiveRuns();
  const allChars = entities.list({ kind: 'character' });
  const busyIds = new Set();
  for (const r of activeRuns) {
    for (const id of r.characterIds || []) busyIds.add(id);
  }
  const idleChars = allChars.filter((c) => !busyIds.has(c.id));
  state.selectedExpShipIds = state.selectedExpShipIds.filter((id) => idleChars.some((c) => c.id === id));
  const curMission = missions.find((m) => m.id === state.selectedExpMissionId) || missions[0];

  // 1. Expedition Dispatch Card
  const expCard = document.createElement('section');
  expCard.className = 'surface-card lab-stack-sm';
  expCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">远征派遣中心</h2>
      <span class="status-badge badge-muted">执行中 ${activeRuns.length}</span>
    </div>

    ${
      activeRuns.length > 0
        ? `<div class="lab-stack-sm">
            ${activeRuns
              .map(
                (run) => `
              <div class="lab-slot-card">
                <div class="lab-slot-head">
                  <strong>${escapeHtml(run.missionTitle)}</strong>
                  <span class="status-badge ${run.ready ? 'badge-ok' : 'badge-warn'}">
                    ${run.ready ? '可领取收益' : `剩余 ${formatDurationZh(run.remainingSec)}`}
                  </span>
                </div>
                <div class="cc-stat-sub">成员：${escapeHtml((run.characterNames || []).join('、'))}</div>
                <div class="lab-btn-grid">
                  ${
                    run.ready
                      ? `<button type="button" class="btn-primary uikit-touch-target" data-exp-claim="${escapeHtml(run.id)}">领取远征收获</button>`
                      : `<button type="button" class="btn-secondary uikit-touch-target" data-exp-recall="${escapeHtml(run.id)}">中途召回</button>`
                  }
                </div>
              </div>
            `
              )
              .join('')}
          </div>`
        : ''
    }

    <div class="form-group">
      <label class="form-label" for="fac-exp-mission">选择远征航线（编入 AR 维修舰 / AO 补给舰可获额外资源加成）</label>
      <select id="fac-exp-mission" class="form-select">
        ${missions
          .map(
            (m) =>
              `<option value="${escapeHtml(m.id)}" ${m.id === curMission?.id ? 'selected' : ''}>${escapeHtml(m.title)}（${formatDurationZh(m.durationSec)} · 需≥${m.minShips}舰）</option>`
          )
          .join('')}
      </select>
    </div>

    <div class="chip-row" data-no-swipe="true">
      ${
        idleChars.length === 0
          ? '<span class="muted-text" style="font-size:12px;">暂无空闲舰娘可派遣</span>'
          : idleChars
              .map((c) => {
                const sel = state.selectedExpShipIds.includes(c.id);
                return `<button type="button" class="preset-chip ${sel ? 'is-active' : ''}" data-exp-ship="${escapeHtml(c.id)}">${sel ? '✓ ' : ''}${escapeHtml(c.name)}</button>`;
              })
              .join('')
      }
    </div>

    <button type="button" id="btn-fac-exp-dispatch" class="btn-primary uikit-touch-target" ${
      !curMission || state.selectedExpShipIds.length < (curMission?.minShips || 1) ? 'disabled' : ''
    }>
      派遣远征（已选 ${state.selectedExpShipIds.length}/${curMission?.minShips || 1} 舰）
    </button>
  `;

  expCard.querySelector('#fac-exp-mission')?.addEventListener('change', (e) => {
    state.selectedExpMissionId = e.target.value;
    render();
  });
  expCard.querySelectorAll('[data-exp-ship]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-exp-ship');
      if (state.selectedExpShipIds.includes(id)) {
        state.selectedExpShipIds = state.selectedExpShipIds.filter((x) => x !== id);
      } else {
        state.selectedExpShipIds = [...state.selectedExpShipIds, id];
      }
      render();
    });
  });
  expCard.querySelector('#btn-fac-exp-dispatch')?.addEventListener('click', async () => {
    try {
      await expeditions.dispatch(curMission.id, state.selectedExpShipIds);
      state.selectedExpShipIds = [];
      uiKit.showToast(`远征「${curMission.title}」已起航！`, 'ok');
      render();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '派遣失败', 'warn');
    }
  });
  expCard.querySelectorAll('[data-exp-claim]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await expeditions.claim(btn.getAttribute('data-exp-claim'));
        await persistCharacterRoster({ storage: rootStorage, entities });
        uiKit.showToast(`远征收获已入库！指挥官经验 +${res.commanderExp || 0}`, 'ok');
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '领取失败', 'warn');
      }
    });
  });
  expCard.querySelectorAll('[data-exp-recall]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await expeditions.recall(btn.getAttribute('data-exp-recall'));
      uiKit.showToast('已召回远征舰队', 'info');
      render();
    });
  });
  wrap.appendChild(expCard);

  // 2. Infrastructure Upgrades: 舰娘宿舍 & 后勤仓库
  const dorm = buildings.getDormitoryState();
  const wh = buildings.getWarehouseState();
  const resIds = new Set(dorm.residents.map((r) => r.id));

  const infraCard = document.createElement('section');
  infraCard.className = 'surface-card lab-stack-sm';
  infraCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">港区基建升级</h2>
      <span class="status-badge badge-ok">宿舍 Lv.${dorm.level} · 仓库 Lv.${wh.level}</span>
    </div>

    <div class="lab-slot-card">
      <div class="lab-slot-head">
        <strong>舰娘宿舍（床位 ${dorm.residents.length}/${dorm.capacity}）</strong>
        <span class="muted-text" style="font-size:11.5px;">士气 +${dorm.moralePerHour}/时 · 好感 +${dorm.affinityPerHour}/时</span>
      </div>
      <div class="chip-row" data-no-swipe="true">
        ${allChars
          .map((c) => {
            const inside = resIds.has(c.id);
            return `<button type="button" class="preset-chip ${inside ? 'is-active' : ''}" data-dorm-toggle="${escapeHtml(c.id)}">${inside ? '🛏 ' : '+ '}${escapeHtml(c.name)}</button>`;
          })
          .join('')}
      </div>
      <div class="lab-btn-grid">
        <button type="button" id="btn-fac-dorm-feed" class="btn-secondary uikit-touch-target" ${dorm.residents.length === 0 ? 'disabled' : ''}>投喂补给</button>
        <button type="button" id="btn-fac-dorm-expand" class="btn-primary uikit-touch-target" ${dorm.canExpand ? '' : 'disabled'}>
          ${dorm.canExpand ? `扩建床位 +1（${escapeHtml(formatCostInline(dorm.expandCost, resources))}）` : '床位已满'}
        </button>
      </div>
    </div>

    <div class="lab-slot-card">
      <div class="lab-slot-head">
        <strong>后勤仓库 · Lv.${wh.level}/${wh.maxLevel}</strong>
        <span class="status-badge badge-ok">储量 +${wh.capBonus} · 携带上限 +${wh.carriedSupplyBonus}</span>
      </div>
      <p class="muted-text" style="font-size:12px; margin:0;">
        升级后勤仓库可永久提高四项基础物资储备上限、出征随舰补给上限与港区自然恢复效率（当前 +${wh.regenBonusPct}%）。
      </p>
      <button type="button" id="btn-fac-wh-upgrade" class="btn-primary uikit-touch-target" ${wh.canUpgrade ? '' : 'disabled'}>
        ${wh.canUpgrade ? `升级后勤仓库至 Lv.${wh.level + 1}（${escapeHtml(formatCostInline(wh.upgradeCost, resources))}）` : '后勤仓库已满级'}
      </button>
    </div>
  `;

  infraCard.querySelectorAll('[data-dorm-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cid = btn.getAttribute('data-dorm-toggle');
      try {
        if (resIds.has(cid)) {
          await buildings.removeDormResident(cid);
          uiKit.showToast('已移出宿舍', 'info');
        } else {
          await buildings.assignDormResident(cid);
          uiKit.showToast('已安排入住宿舍休整', 'ok');
        }
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '操作失败', 'warn');
      }
    });
  });

  infraCard.querySelector('#btn-fac-dorm-feed')?.addEventListener('click', async () => {
    try {
      const res = await buildings.feedDormitory();
      await persistCharacterRoster({ storage: rootStorage, entities });
      uiKit.showToast(`已投喂 ${res.count} 位入住舰娘，士气与好感提升！`, 'ok');
      render();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '投喂失败', 'warn');
    }
  });

  infraCard.querySelector('#btn-fac-dorm-expand')?.addEventListener('click', async () => {
    try {
      const next = await buildings.expandDormitory();
      uiKit.showToast(`宿舍已扩建至 Lv.${next.level}（${next.capacity} 床位）`, 'ok');
      render();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '扩建失败', 'warn');
    }
  });

  infraCard.querySelector('#btn-fac-wh-upgrade')?.addEventListener('click', async () => {
    try {
      const next = await buildings.upgradeLogisticsWarehouse();
      uiKit.showToast(`后勤仓库已升级至 Lv.${next.level}！`, 'ok');
      render();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '升级失败', 'warn');
    }
  });

  wrap.appendChild(infraCard);
  return wrap;
}

function renderStudioSection() {
  const { entities, inventory, buildings, storyPacks, contentManager, modules, uiKit } = state.context;
  const wrap = document.createElement('div');
  wrap.className = 'lab-stack-sm';
  wrap.id = 'facilities-studio-section';

  const charsCount = entities.list({ kind: 'character' }).length;
  const itemsCount = inventory.listItems().length;
  const extPacks = (storyPacks?.listPacks?.() || []).filter((p) => !p.builtIn);
  const customDlgs = contentManager?.listCustomDialogues?.()?.length || 0;
  const customBldgs = buildings.listCustomBuildings() || [];

  // 1. Compendium & External JSON Library
  const compCard = document.createElement('section');
  compCard.className = 'surface-card lab-stack-sm';
  compCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">港区图鉴与外置 JSON 内容库</h2>
      <span class="status-badge badge-ok">外置包 ${extPacks.length} · 自定义台词 ${customDlgs}</span>
    </div>
    <p class="muted-text" style="font-size:12px; margin:0;">
      当前图鉴已收录舰娘 ${charsCount} 名、舰装与道具 ${itemsCount} 件。导入的外置 JSON 角色、装备、台词与剧情包会在开启新档时完整保留。
    </p>
    <div class="lab-btn-grid">
      <button type="button" id="btn-fac-open-compendium" class="btn-primary uikit-touch-target">打开全站图鉴与工坊</button>
      <button type="button" id="btn-fac-paste-json" class="btn-secondary uikit-touch-target">粘贴导入 JSON 包</button>
    </div>
  `;

  compCard.querySelector('#btn-fac-open-compendium')?.addEventListener('click', () => {
    if (modules.has('compendium-studio')) {
      modules.mount('compendium-studio', { transition: 'left' });
    }
  });
  compCard.querySelector('#btn-fac-paste-json')?.addEventListener('click', () => {
    openDirectJsonImportModal(state.context, () => render());
  });
  wrap.appendChild(compCard);

  // 2. Preserved "+ 建造新自定义设施" & Custom Facility List
  const customCard = document.createElement('section');
  customCard.className = 'surface-card lab-stack-sm';
  customCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">自定义扩展设施（${customBldgs.length}）</h2>
      <button type="button" id="btn-fac-create-custom" class="btn-primary fac-mini-btn">+ 建造新自定义设施</button>
    </div>
    ${
      customBldgs.length === 0
        ? '<p class="muted-text" style="font-size:12px;">尚未建造自定义设施，点击右上角「+ 建造新自定义设施」自由扩建港区！</p>'
        : customBldgs
            .map(
              (b) => `
          <div class="lab-slot-card" data-custom-bldg="${escapeHtml(b.id)}">
            <div class="lab-slot-head">
              <strong>${escapeHtml(b.name)} · Lv.${b.level || 1}</strong>
              <span class="status-badge badge-ok">${escapeHtml(b.buffLabel || b.buffType || '常驻增益')}</span>
            </div>
            ${b.description ? `<div class="cc-stat-sub">${escapeHtml(b.description)}</div>` : ''}
            <div class="lab-btn-grid">
              <button type="button" class="btn-secondary uikit-touch-target" data-cb-upgrade="${escapeHtml(b.id)}">升级设施</button>
              <button type="button" class="btn-danger uikit-touch-target" data-cb-delete="${escapeHtml(b.id)}">拆除</button>
            </div>
          </div>
        `
            )
            .join('')
    }
  `;

  customCard.querySelector('#btn-fac-create-custom')?.addEventListener('click', () => {
    openCreateCustomBuildingModal(state.context, () => render());
  });
  customCard.querySelectorAll('[data-cb-upgrade]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const up = await buildings.upgradeCustomBuilding(btn.getAttribute('data-cb-upgrade'));
        uiKit.showToast(`「${up.name}」已升级至 Lv.${up.level}！`, 'ok');
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '升级失败', 'warn');
      }
    });
  });
  customCard.querySelectorAll('[data-cb-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await buildings.deleteCustomBuilding(btn.getAttribute('data-cb-delete'));
      uiKit.showToast('已拆除该自定义设施', 'info');
      render();
    });
  });
  wrap.appendChild(customCard);

  return wrap;
}

function render() {
  if (!state.container || !state.context) return;
  const { resources } = state.context;
  const stock = getStockMap(resources);

  state.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'module-stack fac-hub-root';
  root.id = 'page-facilities-hub';

  // Top 4-module segmented bar
  const segBar = document.createElement('div');
  segBar.className = 'fac-top-segmented';
  segBar.dataset.noSwipe = 'true';
  segBar.setAttribute('role', 'tablist');
  segBar.innerHTML = SECTION_TABS.map(
    (t) => `
    <button
      type="button"
      class="fac-seg-btn ${t.id === state.activeSection ? 'is-active' : ''}"
      data-fac-section="${escapeHtml(t.id)}"
      role="tab"
      aria-selected="${t.id === state.activeSection ? 'true' : 'false'}"
    >${escapeHtml(t.label)}</button>
  `
  ).join('');
  segBar.querySelectorAll('[data-fac-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeSection = btn.getAttribute('data-fac-section');
      render();
    });
  });
  root.appendChild(segBar);

  if (state.activeSection === 'shop') {
    root.appendChild(renderShopSection(stock));
  } else if (state.activeSection === 'build') {
    root.appendChild(renderBuildSection(stock));
  } else if (state.activeSection === 'infra') {
    root.appendChild(renderInfraSection());
  } else {
    root.appendChild(renderStudioSection());
  }

  state.container.appendChild(root);
}

export default {
  id: 'port-facilities-hub',
  name: '设施',
  description: '港区设施综合中心：自由配方舰船建造、四大货架商店、远征与宿舍/仓库基建、图鉴与自定义扩展。',
  mount(container, context) {
    state.container = container;
    state.context = context;
    context.ui.setSwipeLocked(false);
    state.unsubs = [
      context.bus.on('resource:changed', () => render()),
      context.bus.on('buildings:updated', () => render()),
      context.bus.on('expedition:dispatched', () => render()),
      context.bus.on('expedition:claimed', () => render()),
      context.bus.on('expedition:recalled', () => render()),
    ];
    state.timer = setInterval(() => {
      if (state.activeSection === 'infra' && state.context?.expeditions?.getActiveRuns()?.length > 0) {
        render();
      }
    }, 15000);
    render();
  },
  unmount() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.unsubs.forEach((u) => { try { u(); } catch {} });
    state.unsubs = [];
    state.container = null;
    state.context = null;
  },
};
