/**
 * Official Home Screen Module: Port Hub (`port-hub`).
 *
 * Clean, lightweight mobile base hub providing:
 *   - Top unified 6-resource & dual-currency overview bar (fuel/ammo/steel/bauxite + silver/gold)
 *   - Flagship Duty Board (avatar, name, affinity stage, Seaworthiness check, HP/morale/AP bars, gear overview, quick switcher)
 *   - Core Operations ("前往出征", "一键补给与入渠修复", quick nav to Character Console / Supply Workshop / Action Console)
 *   - Reserved Expandable Facilities Area (A/B/C placeholder slots ready for future port sub-systems)
 */

import { createResourceOverviewBar } from '../core/resource-manager.js';
import { LOG_CATEGORIES } from '../core/log-system.js';
import {
  getActiveCharacterId,
  persistCharacterRoster,
} from './character-console.js';

export const PORT_FACILITY_SLOTS = Object.freeze([
  { id: 'facility_a', title: '预留设施位 A', subtitle: '待扩展接口' },
  { id: 'facility_b', title: '预留设施位 B', subtitle: '待扩展接口' },
  { id: 'facility_c', title: '预留设施位 C', subtitle: '待扩展接口' },
]);

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

let portState = {
  container: null,
  context: null,
  avatarCache: new Map(),
  unsubs: [],
};

function getCharacters() {
  return portState.context?.entities?.list({ kind: 'character' }) || [];
}

function getFlagship() {
  const list = getCharacters();
  if (list.length === 0) return null;
  const activeId = getActiveCharacterId(portState.context.rootStorage);
  return list.find((c) => c.id === activeId) || list[0];
}

function computeServicePlan(char) {
  const maxHp = Number(char.stats.maxHp ?? 100);
  const maxAp = Number(char.stats.maxAp ?? 100);
  const curHp = Math.round(Number(char.stats.hp ?? maxHp));
  const curAp = Math.round(Number(char.stats.ap ?? maxAp));
  const curMorale = Math.round(Number(char.stats.morale ?? 70));

  const missingHp = Math.max(0, maxHp - curHp);
  const missingAp = Math.max(0, maxAp - curAp);
  const needsMorale = curMorale < 80;
  const needsService = missingHp > 0 || missingAp > 0 || needsMorale;

  const cost = {};
  if (missingHp > 0) {
    cost.steel = Math.max(10, Math.ceil(missingHp * 1.5));
    cost.bauxite = Math.max(5, Math.ceil(missingHp * 0.5));
  }
  if (missingAp > 0 || needsMorale) {
    cost.fuel = Math.max(15, Math.ceil(missingAp * 0.8));
    cost.ammo = Math.max(15, Math.ceil(missingAp * 0.5));
  }

  return {
    needsService,
    missingHp,
    missingAp,
    needsMorale,
    targetMorale: Math.max(curMorale, 80),
    maxHp,
    maxAp,
    cost,
  };
}

async function performResupplyAndRepair(char) {
  const { entities, resources, rootStorage, logs, bus, uiKit } = portState.context;
  const plan = computeServicePlan(char);

  if (!plan.needsService) {
    uiKit.showToast(`「${char.name}」当前状态已满，无需补给或修复`, 'info');
    return;
  }

  const spend = await resources.spendBatch(plan.cost, { reason: `港区一键补给与修复（${char.name}）` });
  if (!spend.ok) {
    uiKit.showToast(spend.reason, 'warn');
    return;
  }

  const recoveredParts = [];
  if (plan.missingHp > 0) {
    entities.setStat(char.id, 'hp', plan.maxHp, { min: 0, max: plan.maxHp });
    recoveredParts.push(`HP +${plan.missingHp}`);
  }
  if (plan.missingAp > 0) {
    entities.setStat(char.id, 'ap', plan.maxAp, { min: 0, max: plan.maxAp });
    recoveredParts.push(`AP +${plan.missingAp}`);
  }
  if (plan.needsMorale) {
    const beforeM = Math.round(Number(char.stats.morale ?? 0));
    entities.setStat(char.id, 'morale', plan.targetMorale, { min: 0, max: 100 });
    recoveredParts.push(`士气 +${plan.targetMorale - beforeM}`);
  }

  await persistCharacterRoster({
    storage: rootStorage,
    entities,
    activeCharacterId: char.id,
  });

  const costSummary = Object.entries(plan.cost)
    .map(([k, v]) => `${resources.get(k)?.name || k} -${v}`)
    .join('、');

  logs.add({
    category: LOG_CATEGORIES.STAT,
    actorId: char.id,
    actorName: char.name,
    title: `[${char.name}] 港区一键补给与入渠修复`,
    detail: `恢复：${recoveredParts.join('、')} | 消耗：${costSummary}`,
  });

  bus.emit('port:serviced', {
    characterId: char.id,
    cost: plan.cost,
    recovered: recoveredParts,
    timestamp: Date.now(),
  });

  uiKit.showToast(`整备完成：${recoveredParts.join('、')}`, 'ok');
  await renderPortHub();
}

async function renderPortHub() {
  if (!portState.container || !portState.context) return;
  const { assets, resources, inventory, statRules, entities, rootStorage, modules, bus, uiKit } = portState.context;
  const roster = getCharacters();
  const flagship = getFlagship();
  if (!flagship) {
    portState.container.innerHTML = `
      <section class="surface-card">
        <h2 class="section-title">港区暂无执勤角色</h2>
        <p class="muted-text">请前往「角色控制台」创建至少一名角色。</p>
      </section>
    `;
    return;
  }

  const assetId = flagship.meta?.avatarAssetId || null;
  const cacheKey = `${flagship.id}::${assetId || 'none'}`;
  let avatarUrl = portState.avatarCache.get(cacheKey);
  if (!avatarUrl) {
    const resolved = await assets.getAssetUrl(assetId, {
      fallbackSeed: flagship.id,
      fallbackLabel: flagship.name.slice(0, 6),
    });
    avatarUrl = resolved.url;
    portState.avatarCache.set(cacheKey, avatarUrl);
  }

  const seaworthyInfo = statRules.evaluateSeaworthiness(inventory, flagship.id);
  const affStage = statRules.getAffinityStage(flagship.stats.affinity ?? 0);
  const moraleMod = statRules.getMoraleModifier(flagship.stats.morale ?? 50);
  const effStats = entities.getEffectiveStats(flagship.id, { round: 'round' });
  const eqBonuses = inventory.getCharacterEquipmentBonuses(flagship.id);
  const overallScore = statRules.computeOverallScore(effStats, eqBonuses.checkBonus);
  const slots = inventory.getCharacterSlots(flagship.id);
  const equippedMap = inventory.getCharacterEquipment(flagship.id);
  const customSlots = slots.filter((s) => s.custom);
  const customFilled = customSlots.filter((s) => Boolean(equippedMap[s.id])).length;
  const servicePlan = computeServicePlan(flagship);

  const costText = servicePlan.needsService
    ? Object.entries(servicePlan.cost)
        .map(([k, v]) => `${resources.get(k)?.name || k} ${v}`)
        .join(' · ')
    : '状态已满，无需补给或修复';

  portState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'port-root';

  // 1. Unified 6-Resource & Dual-Currency Overview Bar
  root.appendChild(createResourceOverviewBar(resources, { showCaps: true, id: 'port-resource-bar' }));

  // 2. Quick Flagship Switcher Strip
  const strip = document.createElement('div');
  strip.className = 'cc-roster-strip';
  strip.id = 'port-roster-strip';
  for (const c of roster) {
    const sw = inventory.checkSeaworthiness(c.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cc-roster-chip ${c.id === flagship.id ? 'is-active' : ''}`;
    btn.dataset.portSelectChar = c.id;
    btn.textContent = sw.seaworthy ? `旗舰 · ${c.name}` : `${c.name} (未适航)`;
    btn.addEventListener('click', async () => {
      await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: c.id });
      bus.emit('character:selected', { characterId: c.id, name: c.name });
      await renderPortHub();
    });
    strip.appendChild(btn);
  }
  root.appendChild(strip);

  // 3. Flagship Duty Board Card
  const flagshipCard = document.createElement('section');
  flagshipCard.className = 'surface-card lab-stack-sm';
  flagshipCard.id = 'port-flagship-card';
  flagshipCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">旗舰执勤看板</h2>
      <span class="status-badge badge-ok" id="port-overall-score">综合评分 ${overallScore}</span>
    </div>

    <div class="cc-hero-row">
      <img class="cc-avatar" id="port-flagship-avatar" src="${avatarUrl}" alt="${escapeHtml(flagship.name)}">
      <div class="cc-hero-info">
        <div class="cc-hero-name-row">
          <h3 class="cc-hero-name" id="port-flagship-name">${escapeHtml(flagship.name)}</h3>
          <span class="status-badge ${seaworthyInfo.seaworthy ? 'badge-ok' : 'badge-danger'}" id="port-seaworthy-badge">
            ${seaworthyInfo.seaworthy ? '适航' : '未适航'}
          </span>
        </div>
        <div class="cc-badge-row">
          <span class="status-badge badge-muted">${escapeHtml(flagship.meta?.roleTag || '通用型')}</span>
          <span class="status-badge badge-ok">好感 · ${escapeHtml(affStage.label)} (${affStage.value})</span>
        </div>
      </div>
    </div>

    ${
      !seaworthyInfo.seaworthy
        ? `<div class="seaworthy-alert" id="port-seaworthy-alert">${escapeHtml(seaworthyInfo.statusText)}。请前往「角色控制台」装齐引擎、装甲、核心后再出征。</div>`
        : ''
    }

    <div id="port-flagship-bars" class="lab-stack-sm"></div>

    <div class="port-gear-summary" id="port-gear-summary">
      <span class="ns-chip">引擎：${escapeHtml(equippedMap.engine?.name || '缺失')}</span>
      <span class="ns-chip">装甲：${escapeHtml(equippedMap.armor?.name || '缺失')}</span>
      <span class="ns-chip">核心：${escapeHtml(equippedMap.core?.name || '缺失')}</span>
      <span class="ns-chip">服装：${escapeHtml(equippedMap.outfit?.name || '默认便装')}</span>
      <span class="ns-chip">自定义槽：${customFilled}/${customSlots.length}</span>
    </div>
  `;

  const barsHost = flagshipCard.querySelector('#port-flagship-bars');
  const maxHp = Number(flagship.stats.maxHp ?? 100);
  const maxAp = Number(flagship.stats.maxAp ?? 100);
  const hpVal = Number(flagship.stats.hp ?? maxHp);
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: hpVal / maxHp < 0.25 ? '生命 / 耐久 (HP · 大破警告)' : '生命 / 耐久 (HP)',
      value: hpVal,
      max: maxHp,
      tone: hpVal / maxHp < 0.25 ? 'danger' : hpVal / maxHp < 0.5 ? 'warn' : 'accent',
    }).element
  );
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: `士气（${statRules.getMoraleLabel(flagship.stats.morale)} · 检定 ${formatSigned(moraleMod)}）`,
      value: flagship.stats.morale ?? 50,
      max: 100,
      tone: (flagship.stats.morale ?? 50) < 30 ? 'danger' : (flagship.stats.morale ?? 50) < 50 ? 'warn' : 'accent',
    }).element
  );
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: '行动点 (AP)',
      value: flagship.stats.ap ?? maxAp,
      max: maxAp,
      tone: (flagship.stats.ap ?? maxAp) / maxAp < 0.25 ? 'warn' : 'accent',
    }).element
  );
  root.appendChild(flagshipCard);

  // 4. Port Core Operations Card
  const opsCard = document.createElement('section');
  opsCard.className = 'surface-card lab-stack-sm';
  opsCard.id = 'port-ops-card';
  opsCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">港区指挥中枢</h2>
    </div>
    <button type="button" id="btn-port-goto-sortie" class="btn-primary port-cta-btn">前往出征（航线作战）</button>
    <button type="button" id="btn-port-resupply-repair" class="btn-secondary uikit-touch-target">
      一键补给与入渠修复
    </button>
    <p class="muted-text" id="port-service-cost-hint" style="font-size:12px;">整备预计：${escapeHtml(costText)}</p>
    <div class="lab-divider"></div>
    <div class="cc-btn-3col">
      <button type="button" id="btn-port-goto-char" class="btn-secondary uikit-touch-target">角色控制台</button>
      <button type="button" id="btn-port-goto-workshop" class="btn-secondary uikit-touch-target">物资工坊</button>
      <button type="button" id="btn-port-goto-action" class="btn-secondary uikit-touch-target">行动事件台</button>
    </div>
  `;

  opsCard.querySelector('#btn-port-goto-sortie').addEventListener('click', () => {
    if (modules.has('sortie-console')) modules.mount('sortie-console');
  });
  opsCard.querySelector('#btn-port-resupply-repair').addEventListener('click', () =>
    performResupplyAndRepair(flagship)
  );
  opsCard.querySelector('#btn-port-goto-char').addEventListener('click', () => {
    if (modules.has('character-console')) modules.mount('character-console');
  });
  opsCard.querySelector('#btn-port-goto-workshop').addEventListener('click', () => {
    if (modules.has('supply-workshop')) modules.mount('supply-workshop');
  });
  opsCard.querySelector('#btn-port-goto-action').addEventListener('click', () => {
    if (modules.has('action-console')) modules.mount('action-console');
  });
  root.appendChild(opsCard);

  // 5. Port Expandable Facilities Reserved Area
  const facCard = document.createElement('section');
  facCard.className = 'surface-card lab-stack-sm';
  facCard.id = 'port-facilities-card';
  facCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">港区扩展设施区</h2>
      <span class="status-badge badge-muted">预留接口</span>
    </div>
    <div class="port-facility-grid">
      ${PORT_FACILITY_SLOTS.map(
        (slot) => `
        <div class="port-facility-slot" data-facility-slot="${escapeHtml(slot.id)}">
          <span class="port-facility-name">${escapeHtml(slot.title)}</span>
          <span class="port-facility-tag">${escapeHtml(slot.subtitle)}</span>
        </div>
      `
      ).join('')}
    </div>
  `;
  root.appendChild(facCard);

  portState.container.appendChild(root);
}

export default {
  id: 'port-hub',
  name: '港区主界面',
  description: '港区大本营主中枢：六项资源概览、旗舰执勤状态、一键补给修复、前往出征入口与预留扩展设施位。',

  mount(container, context) {
    portState.container = container;
    portState.context = context;
    portState.avatarCache.clear();

    context.ui.setPlaceholder('港区备忘：输入内容将记录到当前旗舰的行动日志...');
    context.ui.setInputHandler((text) => {
      const flagship = getFlagship();
      context.logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        actorId: flagship?.id || null,
        actorName: flagship?.name || '',
        title: `${flagship ? `[${flagship.name}] ` : ''}港区日志备忘`,
        detail: text,
      });
      context.uiKit.showToast('已记录至行动日志', 'ok');
    });

    context.ui.setQuickActions([
      {
        id: 'port-q-sortie',
        label: '前往出征',
        onClick: () => context.modules.mount('sortie-console'),
      },
      {
        id: 'port-q-repair',
        label: '一键补给修复',
        onClick: () => {
          const flagship = getFlagship();
          if (flagship) performResupplyAndRepair(flagship);
        },
      },
      {
        id: 'port-q-char',
        label: '角色控制台',
        onClick: () => context.modules.mount('character-console'),
      },
      {
        id: 'port-q-workshop',
        label: '物资工坊',
        onClick: () => context.modules.mount('supply-workshop'),
      },
    ]);

    portState.unsubs = [
      context.bus.on('resource:changed', () => renderPortHub()),
      context.bus.on('inventory:equipped', () => renderPortHub()),
      context.bus.on('inventory:unequipped', () => renderPortHub()),
      context.bus.on('inventory:enhanced', () => renderPortHub()),
      context.bus.on('sortie:returned', () => renderPortHub()),
      context.bus.on('storage:changed', (detail) => {
        if (detail?.action === 'resetAll' || detail?.action === 'import') {
          renderPortHub();
        }
      }),
    ];

    renderPortHub();
  },

  unmount() {
    for (const unsub of portState.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    portState.unsubs = [];
    portState.container = null;
    portState.context = null;
  },
};
