/**
 * Official Business Module #3: Supply & Workshop Console (`supply-workshop`).
 *
 * Mobile-first logistics & workshop console integrating:
 *   1. Unified 6-Resource & Dual-Currency Overview Bar (fuel/ammo/steel/bauxite + silver/gold)
 *   2. Shop & Consumables Tab: buy core parts (engine/armor/core), generic extension gear,
 *      outfits, and consumables with silver/gold; apply recovery consumables directly to any character.
 *   3. Customizable Random Supply Pool Tab: pull x1 or x5 spending base resources or currencies,
 *      with mobile pool weight & reward editor persisted in IndexedDB.
 *   4. Equipment Enhancement Tab: spend steel/bauxite/silver to upgrade items +1 level,
 *      scaling stat bonuses via formula and syncing all wearing characters live + auto-saving.
 */

import {
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  MAX_ENHANCE_LEVEL,
  WAREHOUSE_GROUPS,
  WAREHOUSE_GROUP_DEFS,
  classifyItemWarehouseGroup,
  computeEnhancedBonuses,
  getEnhanceCost,
  getItemIconSvg,
} from '../core/inventory-system.js';
import { createResourceOverviewBar } from '../core/resource-manager.js';
import { LOG_CATEGORIES } from '../core/log-system.js';
import { getActiveCharacterId, persistCharacterRoster } from './character-console.js';

const WORKSHOP_STORAGE_NS = 'core-supply-workshop';
const POOL_CONFIG_KEY = 'supply-pool-config-v1';

const STAT_LABELS = {
  maxHp: '耐久',
  firepower: '火力',
  armor: '装甲',
  torpedo: '雷击',
  evasion: '机动',
  recon: '侦查',
  aa: '防空',
  asw: '反潜',
  attack: '火力',
  burst: '雷击',
  agility: '机动',
  tactics: '侦查',
  luck: '幸运',
  checkBonus: '检定',
  hp: 'HP',
  morale: '士气',
  ap: 'AP',
};

const SHOP_CATALOG = [
  {
    id: 'shop_engine_adv',
    name: '高出力引擎',
    category: ITEM_CATEGORIES.ENGINE,
    currency: 'silver',
    price: 420,
    description: '高推力改进型引擎，显著提升机动与攻击。',
    bonuses: [
      { stat: 'agility', layer: 'baseAdd', value: 16 },
      { stat: 'attack', layer: 'baseAdd', value: 8 },
    ],
  },
  {
    id: 'shop_armor_adv',
    name: '复合装甲',
    category: ITEM_CATEGORIES.ARMOR,
    currency: 'silver',
    price: 420,
    description: '轻量化复合装甲，兼顾战术稳定与爆发协同。',
    bonuses: [
      { stat: 'tactics', layer: 'baseAdd', value: 12 },
      { stat: 'burst', layer: 'baseAdd', value: 8 },
    ],
  },
  {
    id: 'shop_core_adv',
    name: '精密控制核心',
    category: ITEM_CATEGORIES.CORE,
    currency: 'gold',
    price: 15,
    description: '高阶核心部件，全面提升输出并提供 +2 检定加成。',
    bonuses: [
      { stat: 'attack', layer: 'baseAdd', value: 14 },
      { stat: 'burst', layer: 'baseAdd', value: 14 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 2 },
    ],
  },
  {
    id: 'shop_ext_gamma',
    name: '通用扩展装备 · 丙型组件',
    category: ITEM_CATEGORIES.EXTENSION,
    currency: 'silver',
    price: 360,
    description: '可装入任意自定义槽位的通用组件，均衡强化火力与战术。',
    bonuses: [
      { stat: 'attack', layer: 'baseAdd', value: 10 },
      { stat: 'tactics', layer: 'baseAdd', value: 10 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 1 },
    ],
  },
  {
    id: 'shop_ext_amp',
    name: '通用扩展装备 · 精密增幅器',
    category: ITEM_CATEGORIES.EXTENSION,
    currency: 'gold',
    price: 18,
    description: '高级通用扩展模块，大幅提升爆发、幸运与检定稳定度。',
    bonuses: [
      { stat: 'burst', layer: 'baseAdd', value: 16 },
      { stat: 'luck', layer: 'baseAdd', value: 12 },
      { stat: 'checkBonus', layer: 'flatFinal', value: 2 },
    ],
  },
  {
    id: 'shop_outfit_formal',
    name: '礼仪常服',
    category: ITEM_CATEGORIES.OUTFIT,
    currency: 'silver',
    price: 300,
    description: '端庄典雅的定制服装，提升幸运与战术表现。',
    bonuses: [
      { stat: 'luck', layer: 'baseAdd', value: 12 },
      { stat: 'tactics', layer: 'baseAdd', value: 8 },
    ],
  },
  {
    id: 'shop_consumable_med',
    name: '应急修复包',
    category: ITEM_CATEGORIES.CONSUMABLE,
    currency: 'silver',
    price: 80,
    description: '使用后立即为指定角色恢复 25 点 HP 与 10 点士气。',
    bonuses: [
      { stat: 'hp', layer: 'baseAdd', value: 25 },
      { stat: 'morale', layer: 'baseAdd', value: 10 },
    ],
  },
  {
    id: 'shop_consumable_ration',
    name: '高能补给盒',
    category: ITEM_CATEGORIES.CONSUMABLE,
    currency: 'silver',
    price: 80,
    description: '使用后立即为指定角色恢复 30 点 AP 与 15 点士气。',
    bonuses: [
      { stat: 'ap', layer: 'baseAdd', value: 30 },
      { stat: 'morale', layer: 'baseAdd', value: 15 },
    ],
  },
  {
    id: 'shop_consumable_full',
    name: '全效整备箱',
    category: ITEM_CATEGORIES.CONSUMABLE,
    currency: 'gold',
    price: 5,
    description: '高级整备物资，使用后恢复 60 点 HP、35 点士气与 50 点 AP。',
    bonuses: [
      { stat: 'hp', layer: 'baseAdd', value: 60 },
      { stat: 'morale', layer: 'baseAdd', value: 35 },
      { stat: 'ap', layer: 'baseAdd', value: 50 },
    ],
  },
];

const DEFAULT_SUPPLY_POOL = {
  costMode: 'resources', // 'resources' | 'silver' | 'gold'
  costs: {
    resources: { fuel: 80, ammo: 80, steel: 100, bauxite: 50 },
    silver: { silver: 220 },
    gold: { gold: 8 },
  },
  entries: [
    {
      id: 'drop_ext_std',
      name: '通用扩展装备 · 补给型',
      rewardType: 'item',
      category: ITEM_CATEGORIES.EXTENSION,
      weight: 35,
      bonuses: [
        { stat: 'attack', layer: 'baseAdd', value: 11 },
        { stat: 'agility', layer: 'baseAdd', value: 7 },
      ],
    },
    {
      id: 'drop_ext_tac',
      name: '通用扩展装备 · 侦察型',
      rewardType: 'item',
      category: ITEM_CATEGORIES.EXTENSION,
      weight: 28,
      bonuses: [
        { stat: 'tactics', layer: 'baseAdd', value: 12 },
        { stat: 'luck', layer: 'baseAdd', value: 8 },
      ],
    },
    {
      id: 'drop_outfit_field',
      name: '外勤便装',
      rewardType: 'item',
      category: ITEM_CATEGORIES.OUTFIT,
      weight: 16,
      bonuses: [
        { stat: 'agility', layer: 'baseAdd', value: 10 },
        { stat: 'luck', layer: 'baseAdd', value: 8 },
      ],
    },
    {
      id: 'drop_core_elite',
      name: '强化型核心部件',
      rewardType: 'item',
      category: ITEM_CATEGORIES.CORE,
      weight: 8,
      bonuses: [
        { stat: 'attack', layer: 'baseAdd', value: 12 },
        { stat: 'burst', layer: 'baseAdd', value: 12 },
        { stat: 'checkBonus', layer: 'flatFinal', value: 2 },
      ],
    },
    {
      id: 'drop_mat_bundle',
      name: '钢材与铝材补给箱（钢+140 铝+70）',
      rewardType: 'material',
      weight: 25,
      resourceRewards: { steel: 140, bauxite: 70 },
    },
  ],
};

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

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

function formatBonusSummary(bonuses = []) {
  return (bonuses || [])
    .map((b) => {
      const lbl = STAT_LABELS[b.stat] || b.stat;
      if (b.layer === 'percentAdd' || b.layer === 'percentMult') {
        const pct = Math.round((Number(b.value) || 0) * 100);
        return `${lbl} ${pct >= 0 ? `+${pct}%` : `${pct}%`}`;
      }
      return `${lbl} ${formatSigned(b.value)}`;
    })
    .join(' · ');
}

let workshopState = {
  container: null,
  context: null,
  activeTab: 'warehouse', // 'warehouse' | 'shop' | 'gacha'
  warehouseGroup: WAREHOUSE_GROUPS.ALL,
  equipStatus: 'all', // 'all' | 'idle' | 'equipped'
  expandedItemId: null,
  targetCharId: null,
  poolConfig: deepClone(DEFAULT_SUPPLY_POOL),
  lastDrops: [],
  tabsCtrl: null,
  hydrated: false,
  unsubs: [],
};

async function hydratePoolConfig() {
  if (workshopState.hydrated || !workshopState.context) return;
  const scope = workshopState.context.rootStorage.namespace(WORKSHOP_STORAGE_NS);
  const saved = await scope.getLarge(POOL_CONFIG_KEY, null);
  if (saved && Array.isArray(saved.entries) && saved.entries.length > 0) {
    workshopState.poolConfig = deepClone(saved);
  }
  workshopState.hydrated = true;
}

async function persistPoolConfig() {
  if (!workshopState.context) return;
  const scope = workshopState.context.rootStorage.namespace(WORKSHOP_STORAGE_NS);
  await scope.setLarge(POOL_CONFIG_KEY, workshopState.poolConfig);
}

function getTargetCharacter() {
  const { entities, rootStorage } = workshopState.context;
  const chars = entities.list({ kind: 'character' });
  if (chars.length === 0) return null;
  if (workshopState.targetCharId && chars.some((c) => c.id === workshopState.targetCharId)) {
    return chars.find((c) => c.id === workshopState.targetCharId);
  }
  const activeId = getActiveCharacterId(rootStorage);
  const picked = chars.find((c) => c.id === activeId) || chars[0];
  workshopState.targetCharId = picked.id;
  return picked;
}

// ============================================================
// Tab 1: Shop & Consumables
// ============================================================

function renderShopTab(host) {
  const { resources, inventory, entities, rootStorage, logs, uiKit } = workshopState.context;
  const targetChar = getTargetCharacter();

  // 1. Backpack Consumables Quick-Use Section
  const consumables = inventory.listItems({ category: ITEM_CATEGORIES.CONSUMABLE }).filter((c) => c.quantity > 0);
  const consCard = document.createElement('section');
  consCard.className = 'surface-card lab-stack-sm';
  consCard.id = 'sw-consumables-card';
  consCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">背包消耗品快捷使用</h2>
      <span class="status-badge badge-ok">目标：${escapeHtml(targetChar?.name || '无角色')}</span>
    </div>
    ${
      consumables.length === 0
        ? '<p class="muted-text">当前背包暂无恢复消耗品，可在下方商店使用银条或金条购买。</p>'
        : '<div class="lab-stack-sm" id="sw-consumables-list"></div>'
    }
  `;

  if (consumables.length > 0) {
    const listEl = consCard.querySelector('#sw-consumables-list');
    for (const item of consumables) {
      const row = document.createElement('div');
      row.className = 'cc-slot-row';
      row.dataset.consumableId = item.id;
      row.innerHTML = `
        <div class="cc-slot-info">
          <span class="cc-slot-item-name">${escapeHtml(item.name)} ×${item.quantity}</span>
          <span class="cc-slot-label">${escapeHtml(formatBonusSummary(item.bonuses))}</span>
        </div>
        <button type="button" class="btn-primary uikit-touch-target" data-use-cons style="padding:0 14px;" ${!targetChar ? 'disabled' : ''}>使用</button>
      `;
      row.querySelector('[data-use-cons]').addEventListener('click', async () => {
        if (!targetChar) return;
        try {
          await inventory.useConsumable(targetChar.id, item.id);
          await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: targetChar.id });
          uiKit.showToast(`已对「${targetChar.name}」使用「${item.name}」`, 'ok');
          renderWorkshop();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '使用失败', 'error');
        }
      });
      listEl.appendChild(row);
    }
  }
  host.appendChild(consCard);

  // 2. Supply Shop (Silver & Gold)
  const shopCard = document.createElement('section');
  shopCard.className = 'surface-card lab-stack-sm';
  shopCard.id = 'sw-shop-card';
  shopCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">补给商店（银条 / 金条）</h2>
      <span class="status-badge badge-muted">${SHOP_CATALOG.length} 件商品</span>
    </div>
    <div class="lab-stack-sm" id="sw-shop-list"></div>
  `;

  const shopList = shopCard.querySelector('#sw-shop-list');
  for (const offer of SHOP_CATALOG) {
    const currName = offer.currency === 'gold' ? '金条' : '银条';
    const canBuy = resources.canAfford(offer.currency, offer.price).ok;
    const itemCard = document.createElement('div');
    itemCard.className = 'sw-shop-card';
    itemCard.dataset.shopOfferId = offer.id;
    itemCard.innerHTML = `
      <div class="lab-slot-head">
        <strong>${escapeHtml(offer.name)}</strong>
        <span class="status-badge ${offer.currency === 'gold' ? 'badge-warn' : 'badge-muted'}">
          ${escapeHtml(ITEM_CATEGORY_LABELS[offer.category] || offer.category)}
        </span>
      </div>
      <p class="muted-text" style="font-size:12px;">${escapeHtml(offer.description)}</p>
      <div class="cc-stat-sub">词条：${escapeHtml(formatBonusSummary(offer.bonuses))}</div>
      <div class="lab-slot-head">
        <span class="status-badge ${offer.currency === 'gold' ? 'badge-warn' : 'badge-ok'}">${currName} ${offer.price}</span>
        <button type="button" class="btn-primary uikit-touch-target" data-buy-offer style="padding:6px 16px;" ${canBuy ? '' : 'disabled'}>
          ${canBuy ? '立即购买' : `${currName}不足`}
        </button>
      </div>
    `;

    itemCard.querySelector('[data-buy-offer]').addEventListener('click', async () => {
      const spend = await resources.spend(offer.currency, offer.price, { reason: `商店购买「${offer.name}」` });
      if (!spend.ok) {
        uiKit.showToast(spend.reason, 'warn');
        return;
      }
      await inventory.createItem({
        name: offer.name,
        category: offer.category,
        tags: ['商店购入'],
        description: offer.description,
        quantity: 1,
        bonuses: offer.bonuses,
        stackByName: offer.category === ITEM_CATEGORIES.CONSUMABLE,
      });
      logs.add({
        category: LOG_CATEGORIES.RESOURCE,
        title: `商店购入「${offer.name}」`,
        detail: `消耗 ${currName} ${offer.price}`,
      });
      uiKit.showToast(`购买成功：「${offer.name}」已入库`, 'ok');
      renderWorkshop();
    });

    shopList.appendChild(itemCard);
  }

  host.appendChild(shopCard);
}

// ============================================================
// Tab 2: Customizable Random Supply Pool (Single / x5 Pull)
// ============================================================

function openPoolEditorSheet() {
  const { uiKit } = workshopState.context;
  const draft = deepClone(workshopState.poolConfig);
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const readInputs = () => {
    wrap.querySelectorAll('[data-pool-row]').forEach((row, idx) => {
      if (!draft.entries[idx]) return;
      draft.entries[idx].name = row.querySelector('[data-p-name]').value.trim() || draft.entries[idx].name;
      draft.entries[idx].weight = Math.max(1, Number(row.querySelector('[data-p-weight]').value) || 1);
    });
  };

  const renderRows = () => {
    wrap.innerHTML = `
      <p class="muted-text">可随时调整奖池各条目名称与权重（数值越高抽取概率越大），或新增自定义通用扩展装备掉落项。</p>
      <div class="lab-stack-sm">
        ${draft.entries
          .map(
            (en, idx) => `
          <div class="cc-bonus-row" data-pool-row="${idx}" style="grid-template-columns: 1.8fr 0.8fr auto;">
            <input class="form-input" type="text" data-p-name value="${escapeHtml(en.name)}" aria-label="奖池条目名">
            <input class="form-input" type="number" min="1" max="1000" data-p-weight value="${Number(en.weight)}" aria-label="权重">
            <button type="button" class="btn-danger uikit-touch-target" data-del-entry="${idx}" style="padding:0 10px;" ${draft.entries.length <= 1 ? 'disabled' : ''}>×</button>
          </div>
        `
          )
          .join('')}
      </div>
      <button type="button" id="btn-sw-add-drop" class="btn-secondary uikit-touch-target">+ 新增通用扩展掉落项</button>
    `;

    wrap.querySelector('#btn-sw-add-drop').addEventListener('click', () => {
      readInputs();
      draft.entries.push({
        id: `drop_custom_${Date.now().toString(36)}`,
        name: `自定义扩展装备 #${draft.entries.length + 1}`,
        rewardType: 'item',
        category: ITEM_CATEGORIES.EXTENSION,
        weight: 20,
        bonuses: [
          { stat: 'attack', layer: 'baseAdd', value: 10 },
          { stat: 'tactics', layer: 'baseAdd', value: 8 },
        ],
      });
      renderRows();
    });

    wrap.querySelectorAll('[data-del-entry]').forEach((btn) => {
      btn.addEventListener('click', () => {
        readInputs();
        const idx = Number(btn.getAttribute('data-del-entry'));
        draft.entries.splice(idx, 1);
        renderRows();
      });
    });
  };

  renderRows();
  uiKit.openBottomSheet({
    title: '自定义补给奖池配置',
    subtitle: '权重配置持久化至 IndexedDB',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: '保存奖池',
        tone: 'primary',
        onClick: async () => {
          readInputs();
          workshopState.poolConfig = draft;
          await persistPoolConfig();
          uiKit.showToast('补给奖池配置已保存', 'ok');
          renderWorkshop();
          return true;
        },
      },
    ],
  });
}

function renderGachaTab(host) {
  const { resources, inventory, calc, logs, uiKit } = workshopState.context;
  const pool = workshopState.poolConfig;
  const costMap = pool.costs[pool.costMode] || pool.costs.resources;
  const cost5Map = Object.fromEntries(Object.entries(costMap).map(([k, v]) => [k, v * 5]));
  const totalWeight = pool.entries.reduce((acc, e) => acc + Math.max(1, Number(e.weight) || 1), 0);

  const formatCostStr = (map) =>
    Object.entries(map)
      .map(([k, v]) => `${resources.get(k)?.name || k} ${v}`)
      .join(' · ');

  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm';
  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">通用随机补给池</h2>
      <button type="button" id="btn-sw-edit-pool" class="btn-ghost-sm">自定义奖池</button>
    </div>
    <p class="muted-text">支持消耗基础资源（油/弹/钢/铝）或银条/金条进行单抽与五连抽，按概率权重产出装备、服装与材料。</p>

    <div class="chip-row" id="sw-cost-modes">
      <button type="button" class="preset-chip" data-cost-mode="resources" style="${pool.costMode === 'resources' ? 'border-color:var(--accent);color:var(--text-primary);background:var(--accent-soft);' : ''}">油弹钢铝抽取</button>
      <button type="button" class="preset-chip" data-cost-mode="silver" style="${pool.costMode === 'silver' ? 'border-color:var(--accent);color:var(--text-primary);background:var(--accent-soft);' : ''}">银条抽取</button>
      <button type="button" class="preset-chip" data-cost-mode="gold" style="${pool.costMode === 'gold' ? 'border-color:var(--accent);color:var(--text-primary);background:var(--accent-soft);' : ''}">金条抽取</button>
    </div>

    <div class="muted-text" style="font-size:12px;">单抽消耗：<code>${escapeHtml(formatCostStr(costMap))}</code></div>

    <div class="lab-btn-grid">
      <button type="button" id="btn-sw-pull-1" class="btn-primary uikit-touch-target">单抽 (×1)</button>
      <button type="button" id="btn-sw-pull-5" class="btn-secondary uikit-touch-target">五连抽 (×5)</button>
    </div>

    ${
      workshopState.lastDrops.length > 0
        ? `
      <div class="lab-divider"></div>
      <h3 class="section-title">最近抽取结果（${workshopState.lastDrops.length}）</h3>
      <div class="sw-drop-list" id="sw-drop-results">
        ${workshopState.lastDrops
          .map(
            (d) => `
          <div class="sw-drop-item">
            <span>${escapeHtml(d.name)}</span>
            <span class="status-badge badge-ok">${escapeHtml(d.tag)}</span>
          </div>
        `
          )
          .join('')}
      </div>
    `
        : ''
    }

    <div class="lab-divider"></div>
    <h3 class="section-title">当前奖池概率一览</h3>
    <div class="lab-stack-sm">
      ${pool.entries
        .map((e) => {
          const pct = ((Math.max(1, Number(e.weight) || 1) / totalWeight) * 100).toFixed(1);
          return `
            <div class="namespace-row">
              <span>${escapeHtml(e.name)}</span>
              <span class="muted-text">${pct}% (权重 ${e.weight})</span>
            </div>
          `;
        })
        .join('')}
    </div>
  `;

  card.querySelector('#btn-sw-edit-pool').addEventListener('click', () => openPoolEditorSheet());

  card.querySelectorAll('[data-cost-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      workshopState.poolConfig.costMode = btn.getAttribute('data-cost-mode');
      await persistPoolConfig();
      renderWorkshop();
    });
  });

  const runPull = async (count) => {
    const reqCost = count === 5 ? cost5Map : costMap;
    const spend = await resources.spendBatch(reqCost, { reason: `随机补给池 ${count} 抽` });
    if (!spend.ok) {
      uiKit.showToast(spend.reason, 'warn');
      return;
    }

    const drops = [];
    for (let i = 0; i < count; i++) {
      const picked = calc.weightedPick(pool.entries, (e) => Number(e.weight) || 1);
      if (!picked) continue;
      if (picked.rewardType === 'material' && picked.resourceRewards) {
        for (const [rk, rv] of Object.entries(picked.resourceRewards)) {
          await resources.add(rk, rv, { reason: '补给池产出' });
        }
        drops.push({ name: picked.name, tag: '资源补给' });
      } else {
        await inventory.createItem({
          name: picked.name,
          category: picked.category || ITEM_CATEGORIES.EXTENSION,
          tags: ['补给池获取'],
          description: '通过随机补给池获取的部件/装备，可在角色控制台装入对应槽位。',
          quantity: 1,
          bonuses: picked.bonuses || [{ stat: 'attack', layer: 'baseAdd', value: 8 }],
        });
        drops.push({
          name: picked.name,
          tag: ITEM_CATEGORY_LABELS[picked.category] || '装备',
        });
      }
    }

    workshopState.lastDrops = drops;
    logs.add({
      category: LOG_CATEGORIES.RESOURCE,
      title: `随机补给池完成 ${count} 连抽`,
      detail: `获得：${drops.map((d) => d.name).join('、')}`,
    });
    uiKit.showToast(`抽取完成：获得 ${drops.length} 项补给`, 'ok');
    renderWorkshop();
  };

  card.querySelector('#btn-sw-pull-1').addEventListener('click', () => runPull(1));
  card.querySelector('#btn-sw-pull-5').addEventListener('click', () => runPull(5));

  host.appendChild(card);
}

// ============================================================
// Tab 3 (Default): Compact Categorized Equipment Warehouse & Enhancement
// ============================================================

function formatCompactStatTags(bonuses = [], maxCount = 3) {
  return (bonuses || [])
    .slice(0, maxCount)
    .map((b) => {
      const lbl = STAT_LABELS[b.stat] || b.stat;
      if (b.layer === 'percentAdd' || b.layer === 'percentMult') {
        const pct = Math.round((Number(b.value) || 0) * 100);
        return `${lbl}${pct >= 0 ? `+${pct}%` : `${pct}%`}`;
      }
      return `${lbl}${formatSigned(b.value)}`;
    });
}

function renderWarehouseEnhanceTab(host) {
  const { inventory, resources, entities, commander, rootStorage, logs, uiKit } = workshopState.context;
  const targetChar = getTargetCharacter();
  const allItems = inventory.listItems();
  const items = inventory.listItems({
    warehouseGroup: workshopState.warehouseGroup,
    equipStatus: workshopState.equipStatus,
  });
  const idleCleanable = inventory.getIdleUnenhancedItems();

  // Compute counts per warehouse group for clear overview
  const groupCounts = { [WAREHOUSE_GROUPS.ALL]: allItems.length };
  for (const g of WAREHOUSE_GROUP_DEFS) {
    if (g.id === WAREHOUSE_GROUPS.ALL) continue;
    groupCounts[g.id] = allItems.filter((it) => classifyItemWarehouseGroup(it) === g.id).length;
  }

  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm';
  card.id = 'sw-warehouse-card';
  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">紧凑分类装备仓库（${items.length}/${allItems.length}）</h2>
      <span class="status-badge badge-muted">点击条目展开操作</span>
    </div>

    <!-- Category Tabs -->
    <div class="wh-filter-strip" id="sw-wh-group-tabs" role="tablist" aria-label="装备分类">
      ${WAREHOUSE_GROUP_DEFS.map(
        (g) => `
        <button type="button" class="wh-pill-btn ${workshopState.warehouseGroup === g.id ? 'is-active' : ''}" data-wh-group="${g.id}">
          ${escapeHtml(g.label)} (${groupCounts[g.id] || 0})
        </button>
      `
      ).join('')}
    </div>

    <!-- Status Filter + Batch Cleanup -->
    <div class="wh-status-toolbar">
      <div class="wh-status-pills" id="sw-wh-status-filters">
        ${[
          { id: 'all', label: '全部状态' },
          { id: 'idle', label: '闲置中' },
          { id: 'equipped', label: '已装备' },
        ]
          .map(
            (st) => `
          <button type="button" class="wh-pill-btn is-sm ${workshopState.equipStatus === st.id ? 'is-active' : ''}" data-wh-status="${st.id}">
            ${escapeHtml(st.label)}
          </button>
        `
          )
          .join('')}
      </div>
      <button type="button" id="btn-sw-batch-clean" class="btn-danger uikit-touch-target wh-clean-btn" ${idleCleanable.length === 0 ? 'disabled' : ''}>
        清理闲置+0 (${idleCleanable.length})
      </button>
    </div>

    <div class="wh-compact-list" id="sw-enhance-list"></div>
  `;

  card.querySelectorAll('[data-wh-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      workshopState.warehouseGroup = btn.getAttribute('data-wh-group');
      renderWorkshop();
    });
  });

  card.querySelectorAll('[data-wh-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      workshopState.equipStatus = btn.getAttribute('data-wh-status');
      renderWorkshop();
    });
  });

  card.querySelector('#btn-sw-batch-clean').addEventListener('click', async () => {
    const cleanTargets = inventory.getIdleUnenhancedItems();
    if (cleanTargets.length === 0) {
      uiKit.showToast('当前没有可清理的闲置未强化装备', 'info');
      return;
    }
    const confirmed = await uiKit.confirmDialog({
      title: `批量清理闲置未强化装备（${cleanTargets.length} 件）`,
      message: `将清理所有当前未被任何舰娘装备且强化等级为 +0 的装备（消耗品与已装备/已强化装备不受影响）：${cleanTargets
        .slice(0, 6)
        .map((i) => i.name)
        .join('、')}${cleanTargets.length > 6 ? ' 等' : ''}。确认执行吗？`,
      confirmLabel: `确认清理 ${cleanTargets.length} 件`,
      tone: 'danger',
    });
    if (!confirmed) return;
    const res = await inventory.cleanupIdleUnenhancedItems();
    logs.add({
      category: LOG_CATEGORIES.EQUIPMENT,
      title: `仓库批量清理闲置未强化装备（${res.removedCount} 件）`,
      detail: res.removedNames.join('、'),
    });
    uiKit.showToast(`已清理 ${res.removedCount} 件闲置未强化装备`, 'ok');
    renderWorkshop();
  });

  const maintDisc = commander ? commander.getEnhanceCostDiscount() : 0;
  const listEl = card.querySelector('#sw-enhance-list');
  if (items.length === 0) {
    listEl.innerHTML = '<p class="muted-text" style="padding:8px 0;">当前分类与筛选条件下暂无物品。</p>';
  } else {
    for (const item of items) {
      const lv = Number(item.level) || 0;
      const isConsumable = item.category === ITEM_CATEGORIES.CONSUMABLE;
      const isMax = isConsumable || lv >= MAX_ENHANCE_LEVEL;
      const cost = isConsumable ? null : getEnhanceCost(item, { discount: maintDisc });
      const afford = cost ? resources.canAfford(cost) : { ok: false };
      const nextBonuses = isMax ? [] : computeEnhancedBonuses(item.baseBonuses || item.bonuses, lv + 1);
      const wearers = inventory.getWearersOfItem(item.id);
      const isExpanded = workshopState.expandedItemId === item.id;
      const statTags = formatCompactStatTags(item.bonuses, 3);
      const equippedSlotOnTarget = targetChar ? inventory.getEquippedSlotOfItem(targetChar.id, item.id) : null;

      const row = document.createElement('div');
      row.className = `wh-compact-card ${isExpanded ? 'is-expanded' : ''} ${wearers.length ? 'is-equipped' : ''}`;
      row.dataset.enhanceItemId = item.id;
      row.dataset.whGroup = classifyItemWarehouseGroup(item);

      row.innerHTML = `
        <button type="button" class="wh-compact-header" data-wh-toggle="${escapeHtml(item.id)}" aria-expanded="${isExpanded ? 'true' : 'false'}">
          <span class="wh-item-ico">${getItemIconSvg(item, { size: 20 })}</span>
          <div class="wh-compact-main">
            <div class="wh-compact-title-row">
              <strong class="wh-item-name">${escapeHtml(item.name)}</strong>
              ${lv > 0 ? `<span class="wh-lv-pill">+${lv}</span>` : ''}
              ${isConsumable ? `<span class="wh-qty-pill">×${item.quantity}</span>` : ''}
            </div>
            <div class="wh-compact-stat-row">
              ${statTags.map((t) => `<span class="wh-stat-mini">${escapeHtml(t)}</span>`).join('')}
            </div>
          </div>
          <div class="wh-compact-right">
            <span class="status-badge ${wearers.length ? 'badge-ok' : 'badge-muted'} wh-wearer-badge">
              ${wearers.length ? escapeHtml(wearers[0].name.slice(0, 6)) + (wearers.length > 1 ? `+${wearers.length - 1}` : '') : '闲置'}
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
              ${wearers.length > 0 ? `<span class="status-badge badge-ok">已装备：${escapeHtml(wearers.map((w) => w.name).join('、'))}</span>` : '<span class="status-badge badge-muted">当前闲置</span>'}
            </div>
            ${item.description ? `<p class="muted-text" style="font-size:12px; margin:0;">${escapeHtml(item.description)}</p>` : ''}
            <div class="cc-stat-sub">完整词条：${escapeHtml(formatBonusSummary(item.bonuses) || '无')}</div>
            ${
              !isConsumable && !isMax
                ? `<div class="cc-stat-sub" style="color:var(--accent-hover);">强化至 +${lv + 1}：${escapeHtml(formatBonusSummary(nextBonuses))}（消耗：钢${cost.steel} / 铝${cost.bauxite} / 银${cost.silver}）</div>`
                : !isConsumable
                ? '<div class="cc-stat-sub" style="color:var(--warn);">已达最高强化等级</div>'
                : ''
            }
            <div class="lab-btn-grid">
              ${
                !isConsumable
                  ? `<button type="button" class="btn-primary uikit-touch-target" data-do-enhance ${isMax || !afford.ok ? 'disabled' : ''}>
                      ${isMax ? '已满级' : afford.ok ? `强化 +${lv + 1}` : '资源不足'}
                    </button>`
                  : `<button type="button" class="btn-primary uikit-touch-target" data-do-use ${!targetChar || item.quantity <= 0 ? 'disabled' : ''}>
                      对「${escapeHtml(targetChar?.name?.slice(0, 5) || '目标')}」使用
                    </button>`
              }
              ${
                !isConsumable && targetChar
                  ? `<button type="button" class="btn-secondary uikit-touch-target" data-do-equip>
                      ${equippedSlotOnTarget ? '从目标卸下' : `装给 ${escapeHtml(targetChar.name.slice(0, 5))}`}
                    </button>`
                  : ''
              }
              <button type="button" class="btn-danger uikit-touch-target" data-do-delete>删除装备</button>
            </div>
          </div>
        `
            : ''
        }
      `;

      row.querySelector('[data-wh-toggle]').addEventListener('click', () => {
        workshopState.expandedItemId = isExpanded ? null : item.id;
        renderWorkshop();
      });

      const enhBtn = row.querySelector('[data-do-enhance]');
      if (enhBtn) {
        enhBtn.addEventListener('click', async () => {
          const spend = await resources.spendBatch(cost, { reason: `强化「${item.name}」至 +${lv + 1}` });
          if (!spend.ok) {
            uiKit.showToast(spend.reason, 'warn');
            return;
          }
          const res = await inventory.enhanceItem(item.id);
          await persistCharacterRoster({ storage: rootStorage, entities });
          uiKit.showToast(
            `强化成功：「${res.item.name}」升至 +${res.nextLevel}${res.affectedCharacters.length ? '（已同步刷新角色面板）' : ''}`,
            'ok'
          );
          renderWorkshop();
        });
      }

      const useBtn = row.querySelector('[data-do-use]');
      if (useBtn && targetChar) {
        useBtn.addEventListener('click', async () => {
          try {
            await inventory.useConsumable(targetChar.id, item.id);
            await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: targetChar.id });
            uiKit.showToast(`已对「${targetChar.name}」使用「${item.name}」`, 'ok');
            renderWorkshop();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '使用失败', 'error');
          }
        });
      }

      const eqBtn = row.querySelector('[data-do-equip]');
      if (eqBtn && targetChar) {
        eqBtn.addEventListener('click', async () => {
          try {
            if (equippedSlotOnTarget) {
              await inventory.unequipSlot(targetChar.id, equippedSlotOnTarget);
              uiKit.showToast(`已从「${targetChar.name}」卸下「${item.name}」`, 'info');
            } else {
              const res = await inventory.equipItem(targetChar.id, null, item.id);
              uiKit.showToast(`已为「${targetChar.name}」装入「${item.name}」（${res.slotLabel}）`, 'ok');
            }
            await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: targetChar.id });
            renderWorkshop();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '穿戴失败', 'warn');
          }
        });
      }

      const delBtn = row.querySelector('[data-do-delete]');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          const ok = await uiKit.confirmDialog({
            title: `删除物品「${item.name}」`,
            message: '确认从仓库永久删除该装备吗？',
            confirmLabel: '确认删除',
            tone: 'danger',
          });
          if (!ok) return;
          await inventory.deleteItem(item.id);
          await persistCharacterRoster({ storage: rootStorage, entities });
          workshopState.expandedItemId = null;
          uiKit.showToast(`已删除「${item.name}」`, 'ok');
          renderWorkshop();
        });
      }

      listEl.appendChild(row);
    }
  }

  host.appendChild(card);
}

// ============================================================
// Root View Renderer
// ============================================================

function renderWorkshop() {
  if (!workshopState.container || !workshopState.context) return;
  const { resources, entities, modules, uiKit } = workshopState.context;
  const chars = entities.list({ kind: 'character' });
  const targetChar = getTargetCharacter();

  workshopState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'sw-root';

  root.appendChild(
    uiKit.createSubpageHeader({
      title: '仓库与工坊',
      subtitle: '分类装备仓储 · 强化与补给商店',
      modules,
      resources,
      resourceKeys: ['steel', 'bauxite', 'silver'],
      id: 'sw-subpage-header',
    })
  );

  // 1. Unified 6-Resource & Dual-Currency Overview Bar
  root.appendChild(createResourceOverviewBar(resources, { showCaps: true, id: 'sw-resource-bar' }));

  // 2. Target Character Selector + Quick Nav Card
  const topCard = document.createElement('section');
  topCard.className = 'surface-card lab-stack-sm';
  topCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">目标舰娘（穿戴与消耗品生效对象）</h2>
      <button type="button" id="btn-sw-back-char" class="btn-secondary uikit-touch-target" style="padding:0 12px;">返回角色台</button>
    </div>
    <div class="cc-roster-strip" id="sw-char-strip"></div>
  `;
  topCard.querySelector('#btn-sw-back-char').addEventListener('click', () => {
    if (modules.has('character-console')) modules.mount('character-console');
  });

  const strip = topCard.querySelector('#sw-char-strip');
  for (const c of chars) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `cc-roster-chip ${targetChar && c.id === targetChar.id ? 'is-active' : ''}`;
    chip.dataset.swChar = c.id;
    chip.textContent = `${c.name} (HP ${Math.round(c.stats.hp ?? 0)})`;
    chip.addEventListener('click', () => {
      workshopState.targetCharId = c.id;
      renderWorkshop();
    });
    strip.appendChild(chip);
  }
  root.appendChild(topCard);

  // 3. 3 Segmented Tabs (Compact Warehouse & Enhance / Shop / Supply Pool)
  workshopState.tabsCtrl = uiKit.createTabs({
    items: [
      { id: 'warehouse', label: '装备仓库与强化' },
      { id: 'shop', label: '商店与消耗品' },
      { id: 'gacha', label: '随机补给池' },
    ],
    activeId: workshopState.activeTab === 'enhance' ? 'warehouse' : workshopState.activeTab,
    onChange: (next) => {
      workshopState.activeTab = next;
      renderWorkshop();
    },
  });
  const tabsWrap = document.createElement('div');
  tabsWrap.id = 'sw-tabs-mount';
  tabsWrap.appendChild(workshopState.tabsCtrl.element);
  root.appendChild(tabsWrap);

  // 4. Tab Content
  const body = document.createElement('div');
  body.className = 'module-stack';
  body.id = 'sw-tab-body';
  if (workshopState.activeTab === 'shop') {
    renderShopTab(body);
  } else if (workshopState.activeTab === 'gacha') {
    renderGachaTab(body);
  } else {
    renderWarehouseEnhanceTab(body);
  }
  root.appendChild(body);

  workshopState.container.appendChild(root);
}

// ============================================================
// Standard Module Export
// ============================================================

export default {
  id: 'supply-workshop',
  name: '物资与工坊台',
  description: '紧凑型分类装备仓库（核心/武器/辅助/服道具、闲置清理与强化）、补给商店与可自定义随机补给池。',

  mount(container, context) {
    workshopState.container = container;
    workshopState.context = context;

    context.ui.setPlaceholder('工坊台：可输入采购或整理备忘记录到行动日志...');
    context.ui.setInputHandler((text) => {
      context.logs.add({
        category: LOG_CATEGORIES.RESOURCE,
        title: '物资工坊备忘',
        detail: text,
      });
      context.uiKit.showToast('已记录至行动日志', 'ok');
    });

    context.ui.setQuickActions([
      {
        id: 'sw-q-warehouse',
        label: '分类装备仓库',
        onClick: () => {
          workshopState.activeTab = 'warehouse';
          renderWorkshop();
        },
      },
      {
        id: 'sw-q-shop',
        label: '商店与消耗品',
        onClick: () => {
          workshopState.activeTab = 'shop';
          renderWorkshop();
        },
      },
      {
        id: 'sw-q-gacha',
        label: '随机补给池',
        onClick: () => {
          workshopState.activeTab = 'gacha';
          renderWorkshop();
        },
      },
    ]);

    workshopState.unsubs = [
      context.bus.on('resource:changed', () => renderWorkshop()),
      context.bus.on('inventory:enhanced', () => renderWorkshop()),
      context.bus.on('inventory:cleaned', () => renderWorkshop()),
      context.bus.on('inventory:item-created', () => renderWorkshop()),
      context.bus.on('content:mod-imported', () => renderWorkshop()),
      context.bus.on('storage:changed', (detail) => {
        if (detail?.action === 'resetAll' || detail?.action === 'import') {
          renderWorkshop();
        }
      }),
    ];

    hydratePoolConfig().then(() => renderWorkshop());
  },

  unmount() {
    for (const unsub of workshopState.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    workshopState.unsubs = [];
    workshopState.container = null;
    workshopState.context = null;
    workshopState.tabsCtrl = null;
  },
};
