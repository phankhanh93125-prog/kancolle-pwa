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
  EQUIPMENT_SUBCATEGORY_DEFS,
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  ITEM_ICON_PRESETS,
  MAX_ENHANCE_LEVEL,
  OUTFIT_STYLE_PRESETS,
  WAREHOUSE_GROUPS,
  WAREHOUSE_GROUP_DEFS,
  classifyItemWarehouseGroup,
  computeEnhancedBonuses,
  getEnhanceCost,
  getItemIconSvg,
} from '../core/inventory-system.js';
import {
  ITEM_RARITIES,
  ITEM_RARITY_DEFS,
  ITEM_RARITY_MAP,
  NAVAL_EIGHT_STAT_DEFS,
  getEquipmentPromoteCost,
  inferItemRarity,
  normalizeRarity,
} from '../core/stat-rules.js';
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
  rarityFilter: 'all', // 'all' | 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
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

/**
 * Reusable Visual Equipment & Outfit Editor Sheet (used by both Supply Workshop & Compendium Studio).
 * Supports Core 3-piece (engine/armor/core), Main Weapons (main_gun/torpedo/aircraft),
 * Tactical Support (radar/sonar/aa_gun), and Shipgirl Outfits with White->Orange Rarity,
 * custom SVG icon selector, Outfit Style tag (linked to Secretary dialogue), and all 8 Naval Stats.
 */
export function openEquipmentOutfitEditorSheet(
  context,
  { item = null, template = null, onSaved = null } = {}
) {
  const { inventory, contentManager, entities, rootStorage, uiKit } = context;
  const source = item || template || null;
  const isEditingWarehouseItem = Boolean(item);
  const isEditingTemplate = Boolean(template);

  // Infer initial subcategory from source
  const resolveSubCat = (src) => {
    if (!src) return 'main_gun';
    if (src.subCategory && EQUIPMENT_SUBCATEGORY_DEFS.some((d) => d.id === src.subCategory)) {
      return src.subCategory;
    }
    if (src.category === ITEM_CATEGORIES.ENGINE) return 'engine';
    if (src.category === ITEM_CATEGORIES.ARMOR) return 'armor';
    if (src.category === ITEM_CATEGORIES.CORE) return 'core';
    if (src.category === ITEM_CATEGORIES.OUTFIT) return 'outfit';
    const grp = classifyItemWarehouseGroup(src);
    return grp === WAREHOUSE_GROUPS.TACTICAL ? 'radar' : 'main_gun';
  };

  const statValues = {};
  for (const def of NAVAL_EIGHT_STAT_DEFS) statValues[def.key] = 0;
  let checkBonusVal = 0;
  for (const b of source?.baseBonuses || source?.bonuses || []) {
    if (b.stat === 'checkBonus') checkBonusVal += Number(b.value) || 0;
    else if (statValues[b.stat] !== undefined) statValues[b.stat] += Number(b.value) || 0;
  }

  let draft = {
    subCategory: resolveSubCat(source),
    rarity: source ? inferItemRarity(source) : ITEM_RARITIES.RARE,
    name: source?.name || '',
    iconKey: source?.iconKey || resolveSubCat(source),
    description: source?.description || '',
    outfitStyle: source?.outfitStyle || '优雅礼服',
    stats: statValues,
    checkBonus: checkBonusVal,
  };

  uiKit.openModal({
    title: isEditingWarehouseItem
      ? `编辑装备/服装 · ${source.name}`
      : isEditingTemplate
      ? `编辑图鉴模板 · ${source.name}`
      : '+ 新建自定义装备与服装',
    renderContent: (body, close) => {
      const renderEditor = () => {
        const prevScroll = body.scrollTop;
        const subDef =
          EQUIPMENT_SUBCATEGORY_DEFS.find((d) => d.id === draft.subCategory) || EQUIPMENT_SUBCATEGORY_DEFS[3];
        const isOutfit = subDef.category === ITEM_CATEGORIES.OUTFIT;
        const rDef = ITEM_RARITY_MAP[draft.rarity] || ITEM_RARITY_MAP.common;
        const previewItem = {
          name: draft.name || '未命名装备',
          category: subDef.category,
          subGroup: subDef.subGroup,
          iconKey: draft.iconKey,
          rarity: draft.rarity,
        };

        body.innerHTML = `
          <div class="module-stack" id="eq-visual-editor">
            <!-- Live Rarity Preview Header -->
            <div class="wh-compact-card is-rarity-${escapeHtml(draft.rarity)}" style="padding:10px 12px;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span class="wh-item-ico">${getItemIconSvg(previewItem, { size: 28, iconKey: draft.iconKey })}</span>
                <div style="flex:1; min-width:0;">
                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <strong>${escapeHtml(draft.name || (isOutfit ? '新自定义舰娘服装' : '新自定义战术装备'))}</strong>
                    <span class="rarity-pill is-rarity-${escapeHtml(draft.rarity)}">${escapeHtml(rDef.label)}</span>
                    ${isOutfit && draft.outfitStyle ? `<span class="status-badge badge-muted">${escapeHtml(draft.outfitStyle)}</span>` : ''}
                  </div>
                  <span class="muted-text" style="font-size:11.5px;">${escapeHtml(subDef.group)} · ${escapeHtml(subDef.label)}</span>
                </div>
              </div>
            </div>

            <!-- 1. Category / Subcategory Selector -->
            <div class="form-group">
              <label class="form-label" for="eq-ed-subcat">1. 装备 / 服装类别</label>
              <select id="eq-ed-subcat" class="form-select">
                ${['核心三件套', '主战武器', '战术辅助', '舰娘服装']
                  .map(
                    (grp) => `
                  <optgroup label="${escapeHtml(grp)}">
                    ${EQUIPMENT_SUBCATEGORY_DEFS.filter((d) => d.group === grp)
                      .map(
                        (d) =>
                          `<option value="${escapeHtml(d.id)}" ${draft.subCategory === d.id ? 'selected' : ''}>${escapeHtml(d.label)}</option>`
                      )
                      .join('')}
                  </optgroup>
                `
                  )
                  .join('')}
              </select>
            </div>

            <!-- 2. Five-Tier Rarity Selector (White -> Orange) -->
            <div class="form-group">
              <label class="form-label">2. 品级选择（白→绿→蓝→紫→橙）</label>
              <div class="rarity-picker-row" id="eq-ed-rarity-row">
                ${ITEM_RARITY_DEFS.map(
                  (r) => `
                  <button type="button" class="rarity-pick-btn is-rarity-${r.id} ${draft.rarity === r.id ? 'is-active' : ''}" data-ed-rarity="${r.id}">
                    ${escapeHtml(r.label)}
                  </button>
                `
                ).join('')}
              </div>
            </div>

            <!-- 3. Name & Description -->
            <div class="form-group">
              <label class="form-label" for="eq-ed-name">3. 名称</label>
              <input id="eq-ed-name" class="form-input" type="text" value="${escapeHtml(draft.name)}" placeholder="${isOutfit ? '例如：星海盛夏礼服 / 暗夜特勤作战服' : '例如：460mm 三联装主炮 / 试验型高频声呐'}" />
            </div>

            <div class="form-group">
              <label class="form-label" for="eq-ed-desc">描述文本</label>
              <textarea id="eq-ed-desc" class="form-textarea" style="min-height:60px;" placeholder="描述该装备的战术背景或服装设计细节...">${escapeHtml(draft.description)}</textarea>
            </div>

            <!-- 4. Vector Icon Picker -->
            <div class="form-group">
              <label class="form-label">4. 矢量图标选择</label>
              <div class="eq-icon-grid" id="eq-ed-icon-grid">
                ${ITEM_ICON_PRESETS.map(
                  (ic) => `
                  <button type="button" class="eq-icon-btn ${draft.iconKey === ic.id ? 'is-active' : ''}" data-ed-icon="${ic.id}" title="${escapeHtml(ic.label)}">
                    ${getItemIconSvg(previewItem, { size: 22, iconKey: ic.id })}
                    <span>${escapeHtml(ic.label.slice(0, 4))}</span>
                  </button>
                `
                ).join('')}
              </div>
            </div>

            <!-- 5. Outfit Style Tag (linked to Secretary Dialogue!) -->
            ${
              isOutfit
                ? `
              <div class="form-group" id="eq-ed-style-box">
                <label class="form-label" for="eq-ed-outfit-style">5. 服装风格标签（联动秘书舰日常台词反馈）</label>
                <div class="chip-row" style="margin-bottom:6px;">
                  ${OUTFIT_STYLE_PRESETS.map(
                    (st) => `
                    <button type="button" class="preset-chip ${draft.outfitStyle === st.id ? 'is-active' : ''}" data-ed-style="${escapeHtml(st.id)}">
                      ${escapeHtml(st.label)}
                    </button>
                  `
                  ).join('')}
                </div>
                <input id="eq-ed-outfit-style" class="form-input" type="text" value="${escapeHtml(draft.outfitStyle)}" placeholder="可输入任意自定义服装风格，如：哥特洋装 / 冬日大衣..." />
              </div>
            `
                : ''
            }

            <!-- 6. Eight Naval Stats + Check Bonus -->
            <div class="form-group">
              <label class="form-label">6. 八维海战属性加成配置（留 0 则不附加该词条）</label>
              <div class="eq-stat-8grid">
                ${NAVAL_EIGHT_STAT_DEFS.map(
                  (st) => `
                  <label class="eq-stat-cell">
                    <span>${escapeHtml(st.label)}</span>
                    <input type="number" class="form-input" data-ed-stat="${st.key}" value="${draft.stats[st.key] ?? 0}" min="-99" max="500" />
                  </label>
                `
                ).join('')}
                <label class="eq-stat-cell">
                  <span>检定加值</span>
                  <input type="number" class="form-input" id="eq-ed-check-bonus" value="${draft.checkBonus ?? 0}" min="-5" max="10" />
                </label>
              </div>
            </div>

            <!-- Action Buttons -->
            <div class="lab-stack-sm">
              ${
                isEditingWarehouseItem
                  ? `
                <button type="button" id="btn-eq-ed-update" class="btn-primary uikit-touch-target">保存修改到仓库物品</button>
                <button type="button" id="btn-eq-ed-save-tpl" class="btn-secondary uikit-touch-target">另存为本地内容图鉴模板</button>
              `
                  : `
                <button type="button" id="btn-eq-ed-save-and-issue" class="btn-primary uikit-touch-target">保存至图鉴并发放 1 件到仓库</button>
                <button type="button" id="btn-eq-ed-save-tpl" class="btn-secondary uikit-touch-target">仅保存至本地内容图鉴</button>
              `
              }
            </div>
          </div>
        `;
        body.scrollTop = prevScroll;

        const syncInputsToDraft = () => {
          draft.name = body.querySelector('#eq-ed-name')?.value.trim() || '';
          draft.description = body.querySelector('#eq-ed-desc')?.value.trim() || '';
          const styleEl = body.querySelector('#eq-ed-outfit-style');
          if (styleEl) draft.outfitStyle = styleEl.value.trim();
          body.querySelectorAll('[data-ed-stat]').forEach((inp) => {
            const k = inp.getAttribute('data-ed-stat');
            draft.stats[k] = Number(inp.value) || 0;
          });
          draft.checkBonus = Number(body.querySelector('#eq-ed-check-bonus')?.value) || 0;
        };

        const buildPayload = () => {
          syncInputsToDraft();
          const curSub =
            EQUIPMENT_SUBCATEGORY_DEFS.find((d) => d.id === draft.subCategory) || EQUIPMENT_SUBCATEGORY_DEFS[3];
          const bonuses = [];
          for (const st of NAVAL_EIGHT_STAT_DEFS) {
            const v = Math.round(Number(draft.stats[st.key]) || 0);
            if (v !== 0) bonuses.push({ stat: st.key, layer: 'baseAdd', value: v });
          }
          const cb = Math.round(Number(draft.checkBonus) || 0);
          if (cb !== 0) bonuses.push({ stat: 'checkBonus', layer: 'flatFinal', value: cb });

          return {
            id: isEditingTemplate ? template.id : undefined,
            name: draft.name,
            category: curSub.category,
            subGroup: curSub.subGroup,
            subCategory: curSub.id,
            equipmentType: curSub.id,
            rarity: normalizeRarity(draft.rarity),
            iconKey: draft.iconKey,
            outfitStyle: curSub.category === ITEM_CATEGORIES.OUTFIT ? draft.outfitStyle : '',
            description: draft.description,
            tags: [curSub.group, curSub.label, ITEM_RARITY_MAP[draft.rarity]?.shortLabel || '普通'],
            bonuses,
          };
        };

        body.querySelector('#eq-ed-subcat')?.addEventListener('change', (e) => {
          syncInputsToDraft();
          draft.subCategory = e.target.value;
          const nextSub = EQUIPMENT_SUBCATEGORY_DEFS.find((d) => d.id === draft.subCategory);
          if (nextSub) draft.iconKey = nextSub.defaultIcon;
          renderEditor();
        });

        body.querySelectorAll('[data-ed-rarity]').forEach((btn) => {
          btn.addEventListener('click', () => {
            syncInputsToDraft();
            draft.rarity = btn.getAttribute('data-ed-rarity');
            renderEditor();
          });
        });

        body.querySelectorAll('[data-ed-icon]').forEach((btn) => {
          btn.addEventListener('click', () => {
            syncInputsToDraft();
            draft.iconKey = btn.getAttribute('data-ed-icon');
            renderEditor();
          });
        });

        body.querySelectorAll('[data-ed-style]').forEach((btn) => {
          btn.addEventListener('click', () => {
            syncInputsToDraft();
            draft.outfitStyle = btn.getAttribute('data-ed-style');
            renderEditor();
          });
        });

        const btnUpdate = body.querySelector('#btn-eq-ed-update');
        if (btnUpdate && item) {
          btnUpdate.addEventListener('click', async () => {
            if (btnUpdate.disabled) return;
            btnUpdate.disabled = true;
            try {
              const payload = buildPayload();
              if (!payload.name) throw new Error('请输入装备/服装名称');
              await inventory.updateItem(item.id, payload);
              if (rootStorage && entities) {
                await persistCharacterRoster({ storage: rootStorage, entities });
              }
              uiKit.showToast(`已保存「${payload.name}」的品级与属性修改`, 'ok');
              close();
              if (typeof onSaved === 'function') onSaved();
            } catch (err) {
              btnUpdate.disabled = false;
              uiKit.showToast(err instanceof Error ? err.message : '保存失败', 'warn');
            }
          });
        }

        const btnSaveTpl = body.querySelector('#btn-eq-ed-save-tpl');
        if (btnSaveTpl) {
          btnSaveTpl.addEventListener('click', async () => {
            if (btnSaveTpl.disabled) return;
            btnSaveTpl.disabled = true;
            try {
              const payload = buildPayload();
              if (!payload.name) throw new Error('请输入装备/服装名称');
              if (!contentManager) throw new Error('内容图鉴引擎未就绪');
              await contentManager.saveCustomEquipmentTemplate(payload);
              uiKit.showToast(`已保存模板「${payload.name}」至本地内容图鉴`, 'ok');
              close();
              if (typeof onSaved === 'function') onSaved();
            } catch (err) {
              btnSaveTpl.disabled = false;
              uiKit.showToast(err instanceof Error ? err.message : '保存模板失败', 'warn');
            }
          });
        }

        const btnSaveIssue = body.querySelector('#btn-eq-ed-save-and-issue');
        if (btnSaveIssue) {
          btnSaveIssue.addEventListener('click', async () => {
            if (btnSaveIssue.disabled) return;
            btnSaveIssue.disabled = true;
            try {
              const payload = buildPayload();
              if (!payload.name) throw new Error('请输入装备/服装名称');
              if (contentManager) {
                const tpl = await contentManager.saveCustomEquipmentTemplate(payload);
                await contentManager.issueEquipmentToWarehouse(tpl.id, 1);
              } else {
                await inventory.createItem(payload);
              }
              uiKit.showToast(`已保存「${payload.name}」至图鉴并发放 1 件到仓库！`, 'ok');
              close();
              if (typeof onSaved === 'function') onSaved();
            } catch (err) {
              btnSaveIssue.disabled = false;
              uiKit.showToast(err instanceof Error ? err.message : '保存发放失败', 'warn');
            }
          });
        }
      };

      renderEditor();
    },
  });
}

function openBatchDisassembleSheet(context, { onDone = null } = {}) {
  const { inventory, resources, logs, uiKit } = context;
  let selectedRarities = new Set([ITEM_RARITIES.COMMON, ITEM_RARITIES.UNCOMMON]);
  let includeEnhanced = false;

  const openFn = typeof uiKit.openTacticalModal === 'function' ? uiKit.openTacticalModal : uiKit.openModal;
  openFn({
    title: '按品级批量拆解闲置装备',
    subtitle: '拆解多余装备可返还钢材/铝材/银条，并获取「拆解余料」用于高阶装备升阶',
    renderContent: (body, close) => {
      const renderPanel = () => {
        const prevScroll = body.scrollTop;
        const dropMult = typeof resources.getDropMultiplier === 'function' ? resources.getDropMultiplier() : 1.0;
        const preview = inventory.previewBatchDisassemble({
          rarities: Array.from(selectedRarities),
          includeEnhanced,
          dropMultiplier: dropMult,
        });

        body.innerHTML = `
          <div class="module-stack">
            <p class="muted-text" style="font-size:12px; margin:0;">
              选择要批量拆解的闲置品级（已装备给舰娘的物品与消耗品绝对不会被拆解），当前倍率 ${dropMult.toFixed(1)}x。
            </p>

            <div class="rarity-picker-row">
              ${ITEM_RARITY_DEFS.map(
                (r) => `
                <button type="button" class="rarity-pick-btn is-rarity-${r.id} ${selectedRarities.has(r.id) ? 'is-active' : ''}" data-dis-rarity="${r.id}">
                  ${selectedRarities.has(r.id) ? '✓ ' : ''}${escapeHtml(r.label)}
                </button>
              `
              ).join('')}
            </div>

            <label class="checkbox-row">
              <input type="checkbox" id="chk-dis-enhanced" ${includeEnhanced ? 'checked' : ''} />
              <span>同时包含已强化（+1 以上）的闲置装备</span>
            </label>

            <div class="surface-card lab-stack-sm" style="background:var(--surface-alt);">
              <div class="section-header-row" style="margin-bottom:0;">
                <strong>预计拆解数量</strong>
                <span class="status-badge ${preview.count > 0 ? 'badge-warn' : 'badge-muted'}">${preview.count} 件闲置装备</span>
              </div>
              <div class="port-gear-summary">
                <span class="ns-chip">钢材 +${preview.yield.steel}</span>
                <span class="ns-chip">铝材 +${preview.yield.bauxite}</span>
                <span class="ns-chip">银条 +${preview.yield.silver}</span>
                <span class="ns-chip" style="border-color:var(--accent); color:var(--accent);">拆解余料 +${preview.yield.salvageParts || 0}</span>
              </div>
              ${
                preview.count > 0
                  ? `<p class="muted-text" style="font-size:11.5px; margin:0;">含：${escapeHtml(
                      preview.items
                        .slice(0, 8)
                        .map((i) => i.name)
                        .join('、')
                    )}${preview.count > 8 ? ' 等' : ''}</p>`
                  : '<p class="muted-text" style="font-size:11.5px; margin:0;">当前勾选品级下暂无可拆解的闲置装备。</p>'
              }
            </div>

            <button type="button" id="btn-confirm-disassemble" class="btn-danger uikit-touch-target" ${preview.count === 0 ? 'disabled' : ''}>
              确认批量拆解 ${preview.count} 件并领取物资
            </button>
          </div>
        `;
        body.scrollTop = prevScroll;

        body.querySelectorAll('[data-dis-rarity]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const rid = btn.getAttribute('data-dis-rarity');
            if (selectedRarities.has(rid)) selectedRarities.delete(rid);
            else selectedRarities.add(rid);
            renderPanel();
          });
        });

        body.querySelector('#chk-dis-enhanced')?.addEventListener('change', (e) => {
          includeEnhanced = Boolean(e.target.checked);
          renderPanel();
        });

        body.querySelector('#btn-confirm-disassemble')?.addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          if (btn.disabled) return;
          btn.disabled = true;
          try {
            const res = await inventory.disassembleItemsByRarity({
              rarities: Array.from(selectedRarities),
              includeEnhanced,
              resources,
            });
            if (res.removedCount > 0) {
              logs.add({
                category: LOG_CATEGORIES.EQUIPMENT,
                title: `按品级批量拆解 ${res.removedCount} 件闲置装备`,
                detail: `返还 钢材+${res.yield.steel} / 铝材+${res.yield.bauxite} / 银条+${res.yield.silver} / 拆解余料+${res.yield.salvageParts || 0}`,
              });
              uiKit.showToast(
                `拆解 ${res.removedCount} 件成功！返还 钢+${res.yield.steel} 铝+${res.yield.bauxite} 银+${res.yield.silver} 余料+${res.yield.salvageParts || 0}`,
                'ok'
              );
            }
            close();
            if (typeof onDone === 'function') onDone();
          } catch (err) {
            btn.disabled = false;
            uiKit.showToast(err instanceof Error ? err.message : '批量拆解失败', 'error');
          }
        });
      };

      renderPanel();
    },
  });
}

/**
 * Centered Frosted-Glass Equipment Detail, Enhancement (+1~+10) & Rarity Promotion Modal.
 */
export function openEquipmentDetailModal(itemId, context = workshopState.context, { onUpdated = null } = {}) {
  const ctx = context || workshopState.context;
  if (!ctx) return;
  const { inventory, resources, entities, commander, rootStorage, logs, uiKit } = ctx;
  const initialItem = inventory.getItem(itemId);
  if (!initialItem) {
    uiKit.showToast('该物品已不存在', 'warn');
    return;
  }

  const openFn = typeof uiKit.openTacticalModal === 'function' ? uiKit.openTacticalModal : uiKit.openModal;
  openFn({
    title: '装备详情 · 强化与升阶',
    subtitle: '消耗钢材/铝材/银条强化至 +10，并消耗拆解余料升阶品级（白→绿→蓝→紫→橙）',
    renderContent: (body, close) => {
      const renderInner = () => {
        const item = inventory.getItem(itemId);
        if (!item) {
          close();
          return;
        }
        const lv = Math.max(0, Math.floor(Number(item.level) || 0));
        const rarityId = inferItemRarity(item);
        const rDef = ITEM_RARITY_MAP[rarityId] || ITEM_RARITY_MAP.common;
        const isConsumable = item.category === ITEM_CATEGORIES.CONSUMABLE;
        const isMaxLv = isConsumable || lv >= MAX_ENHANCE_LEVEL;
        const maintDisc = commander ? commander.getEnhanceCostDiscount() : 0;
        const enhCost = isConsumable ? null : getEnhanceCost(item, { discount: maintDisc });
        const enhAfford = enhCost ? resources.canAfford(enhCost) : { ok: false };
        const nextBonuses = isMaxLv ? [] : computeEnhancedBonuses(item.baseBonuses || item.bonuses, lv + 1);

        const promotePlan = !isConsumable ? getEquipmentPromoteCost(item, { discount: maintDisc }) : null;
        const nextRarityDef = promotePlan ? ITEM_RARITY_MAP[promotePlan.toRarity] : null;
        const salvageOwned = inventory.getSalvageParts();
        const promoteResAfford = promotePlan ? resources.canAfford(promotePlan.resources) : { ok: false };
        const promotePartsOk = promotePlan ? salvageOwned >= promotePlan.salvageParts : false;
        const canPromote = Boolean(promotePlan && lv >= MAX_ENHANCE_LEVEL && promoteResAfford.ok && promotePartsOk);

        const wearers = inventory.getWearersOfItem(item.id);
        const targetChar = getTargetCharacter();
        const equippedSlotOnTarget = targetChar ? inventory.getEquippedSlotOfItem(targetChar.id, item.id) : null;

        const stockSteel = Math.floor(resources.get('steel')?.amount ?? 0);
        const stockBauxite = Math.floor(resources.get('bauxite')?.amount ?? 0);
        const stockSilver = Math.floor(resources.get('silver')?.amount ?? 0);

        body.innerHTML = `
          <div class="module-stack">
            <div class="surface-card lab-stack-sm" style="background:var(--surface-alt);">
              <div style="display:flex; align-items:center; gap:10px;">
                <span class="wh-item-ico" style="width:40px; height:40px;">${getItemIconSvg(item, { size: 24 })}</span>
                <div style="flex:1 1 auto; min-width:0;">
                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <span class="rarity-pill is-rarity-${rarityId}">${escapeHtml(rDef.label)}</span>
                    <strong style="font-size:15px;">${escapeHtml(item.name)}</strong>
                    ${lv > 0 ? `<span class="wh-lv-pill">+${lv}</span>` : ''}
                    ${isConsumable ? `<span class="wh-qty-pill">×${item.quantity}</span>` : ''}
                  </div>
                  <div class="cc-stat-sub" style="margin-top:3px;">
                    ${escapeHtml(ITEM_CATEGORY_LABELS[item.category] || item.category)}
                    ${item.outfitStyle ? ` · 风格：${escapeHtml(item.outfitStyle)}` : ''}
                    · ${wearers.length > 0 ? `已装备：${escapeHtml(wearers.map((w) => w.name).join('、'))}` : '当前闲置'}
                  </div>
                </div>
              </div>
              ${item.description ? `<p class="muted-text" style="font-size:12px; margin:0;">${escapeHtml(item.description)}</p>` : ''}
              <div class="cc-stat-sub"><strong>当前属性词条：</strong>${escapeHtml(formatBonusSummary(item.bonuses) || '无')}</div>
            </div>

            ${
              !isConsumable
                ? `
              <div class="surface-card lab-stack-sm">
                <div class="section-header-row" style="margin-bottom:0;">
                  <strong style="font-size:13.5px;">装备强化（+${lv} / +${MAX_ENHANCE_LEVEL}）</strong>
                  <span class="status-badge ${isMaxLv ? 'badge-ok' : 'badge-muted'}">${isMaxLv ? '已达 +10 满级' : `下一级 +${lv + 1}`}</span>
                </div>
                ${
                  !isMaxLv && enhCost
                    ? `
                  <div class="cc-stat-sub" style="color:var(--accent);">强化至 +${lv + 1} 预览：${escapeHtml(formatBonusSummary(nextBonuses))}</div>
                  <div class="port-gear-summary">
                    <span class="ns-chip ${stockSteel < enhCost.steel ? 'is-cost-short' : ''}">钢材 ${enhCost.steel}/${stockSteel}</span>
                    <span class="ns-chip ${stockBauxite < enhCost.bauxite ? 'is-cost-short' : ''}">铝材 ${enhCost.bauxite}/${stockBauxite}</span>
                    <span class="ns-chip ${stockSilver < enhCost.silver ? 'is-cost-short' : ''}">银条 ${enhCost.silver}/${stockSilver}</span>
                  </div>
                  <button type="button" id="btn-tm-do-enhance" class="btn-primary uikit-touch-target" ${enhAfford.ok ? '' : 'disabled'}>
                    ${enhAfford.ok ? `立即强化至 +${lv + 1}` : '强化材料不足'}
                  </button>
                `
                    : `<p class="muted-text" style="font-size:12px; margin:0;">已强化至 +${MAX_ENHANCE_LEVEL} 满级！${promotePlan ? '可在下方升阶至更高品级并解锁新一轮 +1~+10 成长。' : '已达最高传说品级满级。'}</p>`
                }
              </div>

              <div class="surface-card lab-stack-sm">
                <div class="section-header-row" style="margin-bottom:0;">
                  <strong style="font-size:13.5px;">品级升阶（白→绿→蓝→紫→橙）</strong>
                  <span class="status-badge badge-muted">余料库存 ${salvageOwned}</span>
                </div>
                ${
                  promotePlan && nextRarityDef
                    ? `
                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:12.5px;">
                    <span class="rarity-pill is-rarity-${rarityId}">${escapeHtml(rDef.label)}</span>
                    <span>➔</span>
                    <span class="rarity-pill is-rarity-${promotePlan.toRarity}">${escapeHtml(nextRarityDef.label)}</span>
                    <span class="muted-text" style="font-size:11.5px;">（底板全面突破并重置强化至 +0）</span>
                  </div>
                  <div class="port-gear-summary">
                    <span class="ns-chip ${stockSteel < promotePlan.resources.steel ? 'is-cost-short' : ''}">钢材 ${promotePlan.resources.steel}/${stockSteel}</span>
                    <span class="ns-chip ${stockBauxite < promotePlan.resources.bauxite ? 'is-cost-short' : ''}">铝材 ${promotePlan.resources.bauxite}/${stockBauxite}</span>
                    <span class="ns-chip ${stockSilver < promotePlan.resources.silver ? 'is-cost-short' : ''}">银条 ${promotePlan.resources.silver}/${stockSilver}</span>
                    <span class="ns-chip ${!promotePartsOk ? 'is-cost-short' : ''}">拆解余料 ${promotePlan.salvageParts}/${salvageOwned}</span>
                  </div>
                  <button type="button" id="btn-tm-do-promote" class="btn-primary uikit-touch-target" ${canPromote ? '' : 'disabled'}>
                    ${
                      lv < MAX_ENHANCE_LEVEL
                        ? `需先强化至 +${MAX_ENHANCE_LEVEL}（当前 +${lv}）`
                        : !promotePartsOk
                        ? `拆解余料不足（缺 ${promotePlan.salvageParts - salvageOwned}）`
                        : !promoteResAfford.ok
                        ? '升阶材料不足'
                        : `升阶至【${escapeHtml(nextRarityDef.label)}】品级`
                    }
                  </button>
                `
                    : '<p class="muted-text" style="font-size:12px; margin:0;">该装备已达最高【传说 · 橙】品级。</p>'
                }
              </div>
            `
                : `
              <button type="button" id="btn-tm-do-use" class="btn-primary uikit-touch-target" ${!targetChar || item.quantity <= 0 ? 'disabled' : ''}>
                对「${escapeHtml(targetChar?.name || '目标舰娘')}」使用
              </button>
            `
            }

            <div class="lab-btn-grid">
              ${
                !isConsumable && targetChar
                  ? `<button type="button" id="btn-tm-do-equip" class="btn-secondary uikit-touch-target">
                      ${equippedSlotOnTarget ? `从 ${escapeHtml(targetChar.name.slice(0, 5))} 卸下` : `装给 ${escapeHtml(targetChar.name.slice(0, 5))}`}
                    </button>`
                  : ''
              }
              ${
                !isConsumable
                  ? '<button type="button" id="btn-tm-do-edit" class="btn-secondary uikit-touch-target">编辑品级/词条</button>'
                  : ''
              }
              <button type="button" id="btn-tm-do-disassemble" class="btn-danger uikit-touch-target">拆解回收余料</button>
            </div>
          </div>
        `;

        body.querySelector('#btn-tm-do-enhance')?.addEventListener('click', async () => {
          const spend = await resources.spendBatch(enhCost, { reason: `强化「${item.name}」至 +${lv + 1}` });
          if (!spend.ok) {
            uiKit.showToast(spend.reason, 'warn');
            return;
          }
          const res = await inventory.enhanceItem(item.id);
          await persistCharacterRoster({ storage: rootStorage, entities });
          uiKit.showToast(`强化成功：「${res.item.name}」升至 +${res.nextLevel}`, 'ok');
          renderInner();
          if (typeof onUpdated === 'function') onUpdated();
        });

        body.querySelector('#btn-tm-do-promote')?.addEventListener('click', async () => {
          try {
            const res = await inventory.promoteItemRarity(item.id, { resources, discount: maintDisc });
            await persistCharacterRoster({ storage: rootStorage, entities });
            const nextDef = ITEM_RARITY_MAP[res.toRarity];
            logs?.add({
              category: LOG_CATEGORIES.EQUIPMENT,
              title: `装备品级升阶：「${res.item.name}」➔ ${nextDef?.label || res.toRarity}`,
              detail: `消耗拆解余料 ${res.salvageSpent}，剩余余料 ${res.salvagePartsRemaining}`,
            });
            uiKit.showToast(`升阶成功！「${res.item.name}」晋升为【${nextDef?.label || res.toRarity}】品级！`, 'ok');
            renderInner();
            if (typeof onUpdated === 'function') onUpdated();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '升阶失败', 'warn');
          }
        });

        body.querySelector('#btn-tm-do-use')?.addEventListener('click', async () => {
          if (!targetChar) return;
          try {
            await inventory.useConsumable(targetChar.id, item.id);
            await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: targetChar.id });
            uiKit.showToast(`已对「${targetChar.name}」使用「${item.name}」`, 'ok');
            renderInner();
            if (typeof onUpdated === 'function') onUpdated();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '使用失败', 'error');
          }
        });

        body.querySelector('#btn-tm-do-equip')?.addEventListener('click', async () => {
          if (!targetChar) return;
          try {
            if (equippedSlotOnTarget) {
              await inventory.unequipSlot(targetChar.id, equippedSlotOnTarget);
              uiKit.showToast(`已从「${targetChar.name}」卸下「${item.name}」`, 'info');
            } else {
              const res = await inventory.equipItem(targetChar.id, null, item.id);
              uiKit.showToast(`已为「${targetChar.name}」装入「${item.name}」（${res.slotLabel}）`, 'ok');
            }
            await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: targetChar.id });
            renderInner();
            if (typeof onUpdated === 'function') onUpdated();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '穿戴失败', 'warn');
          }
        });

        body.querySelector('#btn-tm-do-edit')?.addEventListener('click', () => {
          close();
          openEquipmentOutfitEditorSheet(ctx, {
            item,
            onSaved: () => {
              if (typeof onUpdated === 'function') onUpdated();
            },
          });
        });

        body.querySelector('#btn-tm-do-disassemble')?.addEventListener('click', async () => {
          const ok = await uiKit.confirmDialog({
            title: `拆解回收「${item.name}」`,
            message: '拆解后将移除该物品并返还钢材/铝材/银条及「拆解余料」，确认继续吗？',
            confirmLabel: '确认拆解',
            tone: 'danger',
          });
          if (!ok) return;
          const res = await inventory.disassembleSingleItem(item.id, { resources });
          await persistCharacterRoster({ storage: rootStorage, entities });
          uiKit.showToast(
            `已拆解「${item.name}」：钢+${res.yield.steel} 铝+${res.yield.bauxite} 银+${res.yield.silver} 余料+${res.yield.salvageParts}`,
            'ok'
          );
          close();
          if (typeof onUpdated === 'function') onUpdated();
        });
      };

      renderInner();
    },
  });
}

function renderWarehouseEnhanceTab(host) {
  const { inventory, resources, uiKit } = workshopState.context;
  const allItems = inventory.listItems();
  const items = inventory.listItems({
    warehouseGroup: workshopState.warehouseGroup,
    rarity: workshopState.rarityFilter,
    equipStatus: workshopState.equipStatus,
  });
  const idleCleanable = inventory.getIdleUnenhancedItems();
  const salvageParts = inventory.getSalvageParts();

  const groupCounts = { [WAREHOUSE_GROUPS.ALL]: allItems.length };
  for (const g of WAREHOUSE_GROUP_DEFS) {
    if (g.id === WAREHOUSE_GROUPS.ALL) continue;
    groupCounts[g.id] = allItems.filter((it) => classifyItemWarehouseGroup(it) === g.id).length;
  }

  const card = document.createElement('section');
  card.className = 'surface-card lab-stack-sm';
  card.id = 'sw-warehouse-card';
  card.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0; gap:6px; flex-wrap:wrap;">
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <h2 class="section-title">装备与服装仓库（${items.length}/${allItems.length}）</h2>
        <span class="status-badge badge-ok" id="sw-salvage-parts-badge">拆解余料 ${salvageParts}</span>
      </div>
      <button type="button" id="btn-sw-new-custom-eq" class="btn-primary uikit-touch-target" style="padding:0 12px;">+ 新建装备/服装</button>
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

    <!-- Five-Tier Rarity Filter Strip (White -> Green -> Blue -> Purple -> Orange) -->
    <div class="wh-filter-strip" id="sw-wh-rarity-tabs" role="tablist" aria-label="品级筛选">
      <button type="button" class="wh-pill-btn is-sm ${workshopState.rarityFilter === 'all' ? 'is-active' : ''}" data-wh-rarity="all">全部品级</button>
      ${ITEM_RARITY_DEFS.map(
        (r) => `
        <button type="button" class="wh-pill-btn is-sm is-rarity-${r.id} ${workshopState.rarityFilter === r.id ? 'is-active' : ''}" data-wh-rarity="${r.id}">
          ${escapeHtml(r.label)}
        </button>
      `
      ).join('')}
    </div>

    <!-- Status Filter + Batch Disassemble by Rarity -->
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
        按品级拆解 (${idleCleanable.length})
      </button>
    </div>

    <p class="muted-text" style="font-size:11.5px; margin:0;">点击任意装备打开「居中战术浮窗」执行 +1~+10 强化、白→橙品级升阶或拆解回收余料。</p>
    <div class="wh-compact-list" id="sw-enhance-list"></div>
  `;

  card.querySelector('#btn-sw-new-custom-eq').addEventListener('click', () => {
    openEquipmentOutfitEditorSheet(workshopState.context, {
      onSaved: () => renderWorkshop(),
    });
  });

  card.querySelectorAll('[data-wh-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      workshopState.warehouseGroup = btn.getAttribute('data-wh-group');
      renderWorkshop();
    });
  });

  card.querySelectorAll('[data-wh-rarity]').forEach((btn) => {
    btn.addEventListener('click', () => {
      workshopState.rarityFilter = btn.getAttribute('data-wh-rarity');
      renderWorkshop();
    });
  });

  card.querySelectorAll('[data-wh-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      workshopState.equipStatus = btn.getAttribute('data-wh-status');
      renderWorkshop();
    });
  });

  card.querySelector('#btn-sw-batch-clean').addEventListener('click', () => {
    openBatchDisassembleSheet(workshopState.context, {
      onDone: () => renderWorkshop(),
    });
  });

  const listEl = card.querySelector('#sw-enhance-list');
  if (items.length === 0) {
    listEl.innerHTML = '<p class="muted-text" style="padding:8px 0;">当前分类与品级筛选条件下暂无物品。</p>';
  } else {
    for (const item of items) {
      const lv = Number(item.level) || 0;
      const rarityId = inferItemRarity(item);
      const rDef = ITEM_RARITY_MAP[rarityId] || ITEM_RARITY_MAP.common;
      const isConsumable = item.category === ITEM_CATEGORIES.CONSUMABLE;
      const wearers = inventory.getWearersOfItem(item.id);
      const statTags = formatCompactStatTags(item.bonuses, 3);
      const canPromoteHint = !isConsumable && lv >= MAX_ENHANCE_LEVEL && Boolean(getEquipmentPromoteCost(item));

      const row = document.createElement('div');
      row.className = `wh-compact-card is-rarity-${rarityId} ${wearers.length ? 'is-equipped' : ''}`;
      row.dataset.enhanceItemId = item.id;
      row.dataset.whGroup = classifyItemWarehouseGroup(item);
      row.dataset.rarity = rarityId;

      row.innerHTML = `
        <button type="button" class="wh-compact-header" data-wh-open-detail="${escapeHtml(item.id)}">
          <span class="wh-item-ico">${getItemIconSvg(item, { size: 20 })}</span>
          <div class="wh-compact-main">
            <div class="wh-compact-title-row">
              <span class="rarity-pill is-rarity-${rarityId}">${escapeHtml(rDef.shortLabel)}</span>
              <strong class="wh-item-name">${escapeHtml(item.name)}</strong>
              ${lv > 0 ? `<span class="wh-lv-pill">+${lv}</span>` : ''}
              ${canPromoteHint ? '<span class="status-badge badge-ok" style="font-size:10px; padding:1px 6px;">可升阶</span>' : ''}
              ${isConsumable ? `<span class="wh-qty-pill">×${item.quantity}</span>` : ''}
            </div>
            <div class="wh-compact-stat-row">
              ${item.outfitStyle ? `<span class="wh-stat-mini">风:${escapeHtml(item.outfitStyle)}</span>` : ''}
              ${statTags.map((t) => `<span class="wh-stat-mini">${escapeHtml(t)}</span>`).join('')}
            </div>
          </div>
          <div class="wh-compact-right">
            <span class="status-badge ${wearers.length ? 'badge-ok' : 'badge-muted'} wh-wearer-badge">
              ${wearers.length ? escapeHtml(wearers[0].name.slice(0, 6)) + (wearers.length > 1 ? `+${wearers.length - 1}` : '') : '闲置'}
            </span>
            <span class="wh-chevron" aria-hidden="true">›</span>
          </div>
        </button>
      `;

      row.querySelector('[data-wh-open-detail]').addEventListener('click', () => {
        openEquipmentDetailModal(item.id, workshopState.context, {
          onUpdated: () => renderWorkshop(),
        });
      });

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
      title: '仓库与图鉴',
      subtitle: '装备强化升阶 · 补给工坊与图鉴内容库',
      modules,
      resources,
      resourceKeys: ['steel', 'bauxite', 'silver'],
      id: 'sw-subpage-header',
    })
  );

  // Unified 4th-Tab Top Switcher: 装备仓库与工坊 ⇄ 图鉴与内容库
  const hubSwitcher = document.createElement('div');
  hubSwitcher.className = 'wh-hub-switch-bar';
  hubSwitcher.id = 'sw-hub-switch-bar';
  hubSwitcher.innerHTML = `
    <button type="button" class="wh-hub-switch-btn is-active" id="btn-hub-to-warehouse">装备仓库与工坊</button>
    <button type="button" class="wh-hub-switch-btn" id="btn-hub-to-compendium">图鉴与内容库</button>
  `;
  hubSwitcher.querySelector('#btn-hub-to-compendium').addEventListener('click', () => {
    if (modules.has('compendium-studio')) modules.mount('compendium-studio', { transition: 'left' });
  });
  root.appendChild(hubSwitcher);

  // 1. Unified 6-Resource & Dual-Currency Overview Bar
  root.appendChild(createResourceOverviewBar(resources, { showCaps: true, id: 'sw-resource-bar' }));

  // 2. Target Character Selector + Quick Nav Card
  const topCard = document.createElement('section');
  topCard.className = 'surface-card lab-stack-sm';
  topCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">目标舰娘（穿戴与消耗品生效对象）</h2>
      <button type="button" id="btn-sw-back-char" class="btn-secondary uikit-touch-target" style="padding:0 12px;">角色详情卡</button>
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
  description: '紧凑型分类装备仓库（核心/武器/辅助/服道具、闲置清理与强化升阶）、补给商店与可自定义随机补给池。',

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
      context.bus.on('inventory:promoted', () => renderWorkshop()),
      context.bus.on('inventory:salvage-changed', () => renderWorkshop()),
      context.bus.on('inventory:cleaned', () => renderWorkshop()),
      context.bus.on('inventory:item-created', () => renderWorkshop()),
      context.bus.on('inventory:item-updated', () => renderWorkshop()),
      context.bus.on('inventory:item-deleted', () => renderWorkshop()),
      context.bus.on('content:updated', () => renderWorkshop()),
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
