/**
 * Official Business Module: Node-Based Sortie Route Console (`sortie-console`).
 *
 * Features:
 *   - Strict pre-sortie validation: Seaworthiness (engine / armor / core) + min fuel / ammo / AP
 *   - Visual mobile node route progress map (Resource / Encounter / Boss nodes)
 *   - Step-by-step progression with fuel & ammo deduction, D20 stat + all-slot equipment checks,
 *     salvage loot rewards, HP/morale damage, heavy damage (<25% HP) advance warning, and retreat to port
 *   - Dual-track Pure Local Template / AI Narrative Polish switch
 *   - Visual mobile Sortie Route Editor Bottom Sheet persisted in IndexedDB
 */

import { CORE_STAT_DEFS, CORE_STAT_MAP } from '../core/stat-rules.js';
import { createResourceOverviewBar } from '../core/resource-manager.js';
import { NARRATIVE_MODES } from '../core/prompt-pipeline.js';
import { LOG_CATEGORIES } from '../core/log-system.js';
import { getActiveCharacterId, persistCharacterRoster } from './character-console.js';
import { clamp } from '../core/calc-engine.js';

const SORTIE_STORAGE_NS = 'core-sortie';
const ROUTES_KEY = 'sortie-routes-v1';
const RUN_KEY = 'active-sortie-run-v1';

const NODE_TYPE_LABELS = {
  resource: '资源点',
  encounter: '遭遇检定',
  boss: 'Boss 决战',
};

export const DEFAULT_SORTIE_ROUTES = [
  {
    id: 'route_patrol_01',
    name: '近海常规巡逻线',
    description: '3 节点标准近海巡逻航线，难度适中，适合日常打捞油钢与银条。',
    builtIn: true,
    minFuel: 60,
    minAmmo: 60,
    apCost: 15,
    stepCost: { fuel: 25, ammo: 20 },
    nodes: [
      {
        code: 'A',
        name: '漂流补给区',
        type: 'resource',
        statKey: 'tactics',
        dc: 12,
        loot: { fuel: 45, steel: 40, silver: 70 },
        failDamage: { hp: 6, morale: 4 },
        affinityGain: 2,
      },
      {
        code: 'B',
        name: '前哨侦察点',
        type: 'encounter',
        statKey: 'agility',
        dc: 14,
        loot: { steel: 60, bauxite: 35, silver: 110 },
        failDamage: { hp: 14, morale: 8 },
        affinityGain: 3,
      },
      {
        code: 'C',
        name: '海域压制战',
        type: 'boss',
        statKey: 'attack',
        dc: 16,
        loot: { steel: 100, bauxite: 65, silver: 220, gold: 3 },
        failDamage: { hp: 22, morale: 12 },
        affinityGain: 5,
      },
    ],
  },
  {
    id: 'route_strike_02',
    name: '远洋主力作战线',
    description: '4 节点高收益远洋作战航线，包含资源打捞、双重遭遇战与高难 Boss 决战。',
    builtIn: true,
    minFuel: 120,
    minAmmo: 120,
    apCost: 25,
    stepCost: { fuel: 35, ammo: 35 },
    nodes: [
      {
        code: 'A',
        name: '外围警戒线',
        type: 'encounter',
        statKey: 'agility',
        dc: 14,
        loot: { fuel: 40, silver: 90 },
        failDamage: { hp: 12, morale: 6 },
        affinityGain: 2,
      },
      {
        code: 'B',
        name: '沉船打捞点',
        type: 'resource',
        statKey: 'luck',
        dc: 13,
        loot: { steel: 95, bauxite: 60, silver: 120 },
        failDamage: { hp: 8, morale: 4 },
        affinityGain: 2,
      },
      {
        code: 'C',
        name: '护卫编队拦截',
        type: 'encounter',
        statKey: 'burst',
        dc: 16,
        loot: { ammo: 60, steel: 85, silver: 160 },
        failDamage: { hp: 18, morale: 10 },
        affinityGain: 4,
      },
      {
        code: 'D',
        name: '中枢要塞决战',
        type: 'boss',
        statKey: 'attack',
        dc: 18,
        loot: { steel: 160, bauxite: 110, silver: 340, gold: 6 },
        failDamage: { hp: 28, morale: 15 },
        affinityGain: 6,
      },
    ],
  },
];

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

let sortieState = {
  container: null,
  context: null,
  routes: [],
  selectedRouteId: null,
  activeRun: null,
  busy: false,
  hydrated: false,
  unsubs: [],
};

export async function hydrateSortieConsole({ storage }) {
  const scope = storage.namespace(SORTIE_STORAGE_NS);
  const [savedRoutes, savedRun] = await Promise.all([
    scope.getLarge(ROUTES_KEY, null),
    scope.getLarge(RUN_KEY, null),
  ]);

  if (Array.isArray(savedRoutes) && savedRoutes.length > 0) {
    sortieState.routes = deepClone(savedRoutes);
  } else {
    sortieState.routes = deepClone(DEFAULT_SORTIE_ROUTES);
    await scope.setLarge(ROUTES_KEY, sortieState.routes);
  }

  sortieState.selectedRouteId = sortieState.routes[0]?.id || null;
  sortieState.activeRun = savedRun && typeof savedRun === 'object' ? deepClone(savedRun) : null;
  sortieState.hydrated = true;
}

async function persistRoutes() {
  if (!sortieState.context) return;
  const scope = sortieState.context.rootStorage.namespace(SORTIE_STORAGE_NS);
  await scope.setLarge(ROUTES_KEY, sortieState.routes);
}

async function persistActiveRun() {
  if (!sortieState.context) return;
  const scope = sortieState.context.rootStorage.namespace(SORTIE_STORAGE_NS);
  if (sortieState.activeRun) {
    await scope.setLarge(RUN_KEY, sortieState.activeRun);
  } else {
    await scope.removeLarge(RUN_KEY);
  }
}

function getFlagship() {
  const { entities, rootStorage } = sortieState.context;
  const chars = entities.list({ kind: 'character' });
  if (chars.length === 0) return null;
  const activeId = getActiveCharacterId(rootStorage);
  return chars.find((c) => c.id === activeId) || chars[0];
}

function getSelectedRoute() {
  return (
    sortieState.routes.find((r) => r.id === sortieState.selectedRouteId) ||
    sortieState.routes[0] ||
    null
  );
}

function validateSortieLaunch(char, route) {
  const { statRules, inventory, resources } = sortieState.context;
  const errors = [];
  if (!char) return { ok: false, errors: ['暂无可用角色'] };
  if (!route) return { ok: false, errors: ['请选择出征航线'] };

  const sw = statRules.evaluateSeaworthiness(inventory, char.id);
  if (!sw.seaworthy) {
    errors.push(sw.statusText);
  }
  if (Number(char.stats.hp ?? 0) <= 0) {
    errors.push('当前角色 HP 为 0，请先回港区入渠修复');
  }
  if (resources.getBalance('fuel') < route.minFuel) {
    errors.push(`燃油不足（需 ≥ ${route.minFuel}，当前 ${resources.getBalance('fuel')}）`);
  }
  if (resources.getBalance('ammo') < route.minAmmo) {
    errors.push(`弹药不足（需 ≥ ${route.minAmmo}，当前 ${resources.getBalance('ammo')}）`);
  }
  if (Number(char.stats.ap ?? 0) < route.apCost) {
    errors.push(`行动点 AP 不足（需 ≥ ${route.apCost}，当前 ${Math.round(char.stats.ap ?? 0)}）`);
  }

  return { ok: errors.length === 0, errors, seaworthy: sw.seaworthy };
}

function formatLootSummary(lootObj = {}, resources) {
  const parts = [];
  for (const [k, v] of Object.entries(lootObj)) {
    const val = Number(v) || 0;
    if (val > 0) {
      parts.push(`${resources.get(k)?.name || k} +${val}`);
    }
  }
  return parts.length > 0 ? parts.join('、') : '暂无战利品';
}

// ============================================================
// Sortie Lifecycle: Launch, Step Node, Retreat to Port
// ============================================================

async function launchSortie(route) {
  const char = getFlagship();
  const check = validateSortieLaunch(char, route);
  const { entities, rootStorage, logs, bus, uiKit } = sortieState.context;

  if (!check.ok) {
    uiKit.showToast(`无法启航：${check.errors[0]}`, 'error');
    return;
  }

  // Warn if launching while already heavily damaged (<25% HP)
  const maxHp = Number(char.stats.maxHp ?? 100);
  if (Number(char.stats.hp ?? maxHp) / maxHp < 0.25) {
    const proceed = await uiKit.confirmDialog({
      title: '大破状态启航警告',
      message: `「${char.name}」当前 HP 低于 25%，处于大破状态。建议先在港区修复后再出击，是否仍要强行启航？`,
      confirmLabel: '强行启航',
      cancelLabel: '取消',
      tone: 'danger',
    });
    if (!proceed) return;
  }

  // Deduct launch AP cost
  if (route.apCost > 0) {
    entities.adjustStat(char.id, 'ap', -route.apCost, { min: 0, max: Number(char.stats.maxAp ?? 100) });
    await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
  }

  sortieState.activeRun = {
    routeId: route.id,
    routeName: route.name,
    characterId: char.id,
    characterName: char.name,
    stepCost: deepClone(route.stepCost),
    nodes: deepClone(route.nodes),
    nextNodeIndex: 0,
    clearedIndices: [],
    loot: { fuel: 0, ammo: 0, steel: 0, bauxite: 0, silver: 0, gold: 0 },
    reports: [],
    completed: false,
    startedAt: Date.now(),
  };

  await persistActiveRun();
  logs.add({
    category: LOG_CATEGORIES.SYSTEM,
    actorId: char.id,
    actorName: char.name,
    title: `[${char.name}] 启航出征「${route.name}」`,
    detail: `消耗 AP -${route.apCost}，共 ${route.nodes.length} 个航线节点`,
  });
  bus.emit('sortie:launched', { routeId: route.id, characterId: char.id });
  uiKit.showToast(`已启航进入「${route.name}」，点击推进首个节点`, 'ok');
  await renderSortieConsole();
}

async function advanceNextNode() {
  if (sortieState.busy || !sortieState.activeRun) return;
  const run = sortieState.activeRun;
  if (run.completed || run.nextNodeIndex >= run.nodes.length) return;

  const { entities, inventory, statRules, resources, narrative, turnStepper, rootStorage, logs, bus, uiKit } =
    sortieState.context;
  const char = entities.get(run.characterId) || getFlagship();
  if (!char) return;

  // Heavy damage (<25% HP) explicit confirmation warning before advancing
  const maxHp = Number(char.stats.maxHp ?? 100);
  const curHp = Number(char.stats.hp ?? maxHp);
  if (curHp / maxHp < 0.25) {
    const confirmed = await uiKit.confirmDialog({
      title: '大破强行进击风险警告',
      message: `警告：「${char.name}」当前 HP 仅剩 ${Math.round(curHp)}/${maxHp}（低于 25% 大破线）！强行进击极易造成严重损毁，建议立即点击「携带战利品返航回港区」。是否仍要强行推进？`,
      confirmLabel: '强行继续前进',
      cancelLabel: '取消并考虑返航',
      tone: 'danger',
    });
    if (!confirmed) return;
  }

  // Deduct single-step fuel & ammo
  const stepCost = {
    fuel: Math.max(0, Number(run.stepCost?.fuel) || 0),
    ammo: Math.max(0, Number(run.stepCost?.ammo) || 0),
  };
  const spend = await resources.spendBatch(stepCost, { reason: `出征推进 ${run.routeName}` });
  if (!spend.ok) {
    uiKit.showToast(`油弹补给不足，无法继续推进：${spend.reason}`, 'error');
    return;
  }

  sortieState.busy = true;
  await renderSortieConsole();

  try {
    const nodeIdx = run.nextNodeIndex;
    const node = run.nodes[nodeIdx];
    const statKey = node.statKey || 'tactics';
    const baseVal = Number(char.stats[statKey] ?? 50);
    const effVal = entities.getEffectiveStat(char.id, statKey, { round: 'round' }).final;
    const eqBonuses = inventory.getCharacterEquipmentBonuses(char.id);

    const checkResult = statRules.performCheck({
      actorId: char.id,
      actorName: char.name,
      statKey,
      baseStatValue: baseVal,
      effectiveStatValue: effVal,
      equipmentCheckBonus: eqBonuses.checkBonus,
      moraleValue: char.stats.morale ?? 60,
      dc: Number(node.dc) || 14,
    });

    const isSuccess = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
    const isCrit = checkResult.outcome === 'crit-success';
    const chips = [
      { text: `燃油 -${stepCost.fuel}`, negative: true },
      { text: `弹药 -${stepCost.ammo}`, negative: true },
    ];
    const nodeLootGained = {};

    if (isSuccess) {
      const mult = isCrit ? 1.4 : 1;
      for (const [rk, rawVal] of Object.entries(node.loot || {})) {
        const gain = Math.round((Number(rawVal) || 0) * mult);
        if (gain <= 0) continue;
        await resources.add(rk, gain, { reason: `出征节点 ${node.code}·${node.name} 打捞` });
        run.loot[rk] = (run.loot[rk] || 0) + gain;
        nodeLootGained[rk] = gain;
        chips.push({ text: `${resources.get(rk)?.name || rk} +${gain}`, negative: false });
      }
      const affGain = Number(node.affinityGain) || 2;
      entities.adjustStat(char.id, 'affinity', affGain, { min: 0, max: 100 });
      entities.adjustStat(char.id, 'morale', 3, { min: 0, max: 100 });
      chips.push({ text: `好感 +${affGain}`, negative: false });
      chips.push({ text: '士气 +3', negative: false });
    } else {
      const dmgHp = Math.max(4, Number(node.failDamage?.hp) || 14);
      const dmgMorale = Math.max(3, Number(node.failDamage?.morale) || 8);
      entities.adjustStat(char.id, 'hp', -dmgHp, { min: 0, max: maxHp });
      entities.adjustStat(char.id, 'morale', -dmgMorale, { min: 0, max: 100 });
      chips.push({ text: `HP -${dmgHp}`, negative: true });
      chips.push({ text: `士气 -${dmgMorale}`, negative: true });
    }

    await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
    turnStepper.advance({ steps: 1, reason: `sortie-node-${node.code}` });

    const equipped = inventory.getCharacterEquipment(char.id);
    const outfitName = equipped.outfit?.name || '默认便装';
    const lootText = formatLootSummary(nodeLootGained, resources);

    const templateStr = isSuccess
      ? '【节点 {nodeCode} · {nodeName}（{nodeType}）】{actor.name}身着「{outfitName}」通过 {check.statLabel} 检定（{check.total} vs DC {check.dc}，{check.outcomeLabel}），成功打捞战利品：{lootText}。'
      : '【节点 {nodeCode} · {nodeName}（{nodeType}）】{actor.name}在 {check.statLabel} 检定中受挫（{check.total} vs DC {check.dc}，{check.outcomeLabel}），船体与士气受损，当前剩余 HP {actor.hp}/{actor.maxHp}。';

    const rendered = await narrative.run({
      template: templateStr,
      variables: {
        nodeCode: node.code,
        nodeName: node.name,
        nodeType: NODE_TYPE_LABELS[node.type] || node.type,
        actor: { name: char.name, hp: Math.round(char.stats.hp ?? 0), maxHp },
        outfitName,
        lootText,
        check: checkResult,
      },
      polishInstruction: `请以简洁有代入感的战报口吻润色节点 ${node.code} 的出征战果，保留全部客观检定与战利品/受损数字：`,
    });

    run.clearedIndices.push(nodeIdx);
    run.nextNodeIndex = nodeIdx + 1;
    if (run.nextNodeIndex >= run.nodes.length) {
      run.completed = true;
    }

    run.reports.unshift({
      id: `sr_${Date.now()}_${nodeIdx}`,
      nodeCode: node.code,
      nodeName: node.name,
      nodeType: NODE_TYPE_LABELS[node.type] || node.type,
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      check: {
        statLabel: checkResult.statLabel,
        dc: checkResult.dc,
        total: checkResult.total,
        margin: checkResult.margin,
        outcome: checkResult.outcome,
        outcomeLabel: checkResult.outcomeLabel,
        steps: checkResult.steps,
      },
      chips,
      timestamp: Date.now(),
    });

    await persistActiveRun();

    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char.id,
      actorName: char.name,
      title: `[${char.name}] 出征节点 ${node.code}·${node.name} → ${checkResult.outcomeLabel}`,
      detail: isSuccess ? `战利品：${lootText}` : `受损后剩余 HP ${Math.round(char.stats.hp ?? 0)}/${maxHp}`,
    });

    bus.emit('sortie:node-resolved', {
      routeId: run.routeId,
      nodeCode: node.code,
      outcome: checkResult.outcome,
      completed: run.completed,
      timestamp: Date.now(),
    });

    uiKit.showToast(
      run.completed
        ? `航线「${run.routeName}」全节点通关！请携带战利品返航回港区`
        : `节点 ${node.code} 结算：${checkResult.outcomeLabel}`,
      isSuccess ? 'ok' : 'warn'
    );
  } finally {
    sortieState.busy = false;
    await renderSortieConsole();
  }
}

async function retreatToPort() {
  const { resources, logs, bus, modules, uiKit } = sortieState.context;
  const run = sortieState.activeRun;
  if (run) {
    const haul = formatLootSummary(run.loot, resources);
    logs.add({
      category: LOG_CATEGORIES.SYSTEM,
      actorId: run.characterId,
      actorName: run.characterName,
      title: `[${run.characterName}] ${run.completed ? '凯旋返航' : '中途返航'}（${run.routeName}）`,
      detail: `已通过 ${run.clearedIndices.length}/${run.nodes.length} 节点 | 累计打捞：${haul}`,
    });
    sortieState.activeRun = null;
    await persistActiveRun();
    bus.emit('sortie:returned', { routeId: run.routeId, completed: run.completed, haul });
    uiKit.showToast(`已返航回港区（累计打捞：${haul}）`, 'ok');
  }
  if (modules.has('port-hub')) {
    modules.mount('port-hub');
  }
}

// ============================================================
// Visual Mobile Sortie Route Editor Bottom Sheet
// ============================================================

function openRouteFormSheet(existingRoute = null, onSaved = null) {
  const { uiKit, bus } = sortieState.context;
  const isEdit = Boolean(existingRoute);

  const draft = existingRoute
    ? deepClone(existingRoute)
    : {
        id: `route_custom_${Date.now().toString(36)}`,
        name: '',
        description: '玩家自定义出征航线。',
        builtIn: false,
        minFuel: 60,
        minAmmo: 60,
        apCost: 15,
        stepCost: { fuel: 25, ammo: 20 },
        nodes: [
          {
            code: 'A',
            name: '物资搜索点',
            type: 'resource',
            statKey: 'tactics',
            dc: 12,
            loot: { fuel: 50, steel: 50, silver: 80 },
            failDamage: { hp: 8, morale: 4 },
            affinityGain: 2,
          },
          {
            code: 'B',
            name: '中途遭遇点',
            type: 'encounter',
            statKey: 'agility',
            dc: 14,
            loot: { steel: 70, silver: 120 },
            failDamage: { hp: 14, morale: 8 },
            affinityGain: 3,
          },
          {
            code: 'C',
            name: '终点压制战',
            type: 'boss',
            statKey: 'attack',
            dc: 16,
            loot: { steel: 110, bauxite: 70, silver: 220, gold: 3 },
            failDamage: { hp: 20, morale: 12 },
            affinityGain: 5,
          },
        ],
      };

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const readForm = () => {
    const nameEl = wrap.querySelector('#rt-f-name');
    if (!nameEl) return;
    draft.name = nameEl.value.trim();
    draft.description = wrap.querySelector('#rt-f-desc').value.trim();
    draft.stepCost.fuel = clamp(Number(wrap.querySelector('#rt-f-sfuel').value) || 25, 0, 500);
    draft.stepCost.ammo = clamp(Number(wrap.querySelector('#rt-f-sammo').value) || 20, 0, 500);
    draft.apCost = clamp(Number(wrap.querySelector('#rt-f-ap').value) || 15, 0, 100);
    draft.minFuel = Math.max(draft.stepCost.fuel * 2, 20);
    draft.minAmmo = Math.max(draft.stepCost.ammo * 2, 20);

    const nodes = [];
    wrap.querySelectorAll('[data-node-row]').forEach((row, idx) => {
      const prev = draft.nodes[idx] || {};
      const type = row.querySelector('[data-n-type]').value;
      nodes.push({
        code: String.fromCharCode(65 + idx),
        name: row.querySelector('[data-n-name]').value.trim() || `节点 ${String.fromCharCode(65 + idx)}`,
        type,
        statKey: row.querySelector('[data-n-stat]').value,
        dc: clamp(Number(row.querySelector('[data-n-dc]').value) || 14, 5, 35),
        loot:
          prev.loot ||
          (type === 'boss'
            ? { steel: 110, bauxite: 70, silver: 220, gold: 3 }
            : type === 'resource'
            ? { fuel: 50, steel: 50, silver: 80 }
            : { steel: 65, silver: 110 }),
        failDamage: prev.failDamage || (type === 'boss' ? { hp: 20, morale: 12 } : { hp: 12, morale: 6 }),
        affinityGain: prev.affinityGain || (type === 'boss' ? 5 : 2),
      });
    });
    draft.nodes = nodes;
  };

  const renderForm = () => {
    wrap.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="rt-f-name">航线名称 *</label>
        <input id="rt-f-name" class="form-input" type="text" value="${escapeHtml(draft.name)}" placeholder="例如：北方资源打捞线">
      </div>
      <div class="form-group">
        <label class="form-label" for="rt-f-desc">航线简介</label>
        <input id="rt-f-desc" class="form-input" type="text" value="${escapeHtml(draft.description)}">
      </div>
      <div class="lab-kv-grid-3">
        <div class="form-group">
          <label class="form-label" for="rt-f-sfuel">单步燃油</label>
          <input id="rt-f-sfuel" class="form-input" type="number" min="0" value="${draft.stepCost.fuel}">
        </div>
        <div class="form-group">
          <label class="form-label" for="rt-f-sammo">单步弹药</label>
          <input id="rt-f-sammo" class="form-input" type="number" min="0" value="${draft.stepCost.ammo}">
        </div>
        <div class="form-group">
          <label class="form-label" for="rt-f-ap">启航 AP</label>
          <input id="rt-f-ap" class="form-input" type="number" min="0" value="${draft.apCost}">
        </div>
      </div>

      <div class="form-group">
        <span class="form-label">航线节点序列（${draft.nodes.length} 个节点）</span>
        <div class="lab-stack-sm">
          ${draft.nodes
            .map(
              (n, idx) => `
            <div class="sortie-editor-node-row" data-node-row="${idx}">
              <div class="lab-slot-head">
                <strong>节点 ${String.fromCharCode(65 + idx)}</strong>
                <button type="button" class="btn-danger uikit-touch-target" data-del-node="${idx}" style="padding:0 10px;" ${draft.nodes.length <= 2 ? 'disabled' : ''}>删节点</button>
              </div>
              <input class="form-input" type="text" data-n-name value="${escapeHtml(n.name)}" placeholder="节点名称">
              <div class="lab-kv-grid-3">
                <select class="form-select" data-n-type aria-label="节点类型">
                  <option value="resource" ${n.type === 'resource' ? 'selected' : ''}>资源点</option>
                  <option value="encounter" ${n.type === 'encounter' ? 'selected' : ''}>遭遇检定</option>
                  <option value="boss" ${n.type === 'boss' ? 'selected' : ''}>Boss决战</option>
                </select>
                <select class="form-select" data-n-stat aria-label="检定属性">
                  ${CORE_STAT_DEFS.map(
                    (d) => `<option value="${d.key}" ${n.statKey === d.key ? 'selected' : ''}>${escapeHtml(d.shortLabel)}</option>`
                  ).join('')}
                </select>
                <input class="form-input" type="number" min="5" max="35" data-n-dc value="${Number(n.dc)}" aria-label="难度DC">
              </div>
            </div>
          `
            )
            .join('')}
        </div>
        <button type="button" id="btn-rt-add-node" class="btn-secondary uikit-touch-target" style="margin-top:4px;" ${draft.nodes.length >= 6 ? 'disabled' : ''}>+ 添加节点</button>
      </div>
    `;

    wrap.querySelector('#btn-rt-add-node').addEventListener('click', () => {
      readForm();
      if (draft.nodes.length >= 6) return;
      draft.nodes.push({
        code: String.fromCharCode(65 + draft.nodes.length),
        name: `扩展节点 ${String.fromCharCode(65 + draft.nodes.length)}`,
        type: 'encounter',
        statKey: 'tactics',
        dc: 15,
        loot: { steel: 75, silver: 120 },
        failDamage: { hp: 14, morale: 8 },
        affinityGain: 3,
      });
      renderForm();
    });

    wrap.querySelectorAll('[data-del-node]').forEach((btn) => {
      btn.addEventListener('click', () => {
        readForm();
        const idx = Number(btn.getAttribute('data-del-node'));
        draft.nodes.splice(idx, 1);
        renderForm();
      });
    });
  };

  renderForm();
  uiKit.openBottomSheet({
    title: isEdit ? `编辑航线 · ${existingRoute.name}` : '新增自定义出征航线',
    subtitle: '配置持久化至 IndexedDB',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: '保存航线',
        tone: 'primary',
        onClick: async () => {
          readForm();
          if (!draft.name) {
            uiKit.showToast('请输入航线名称', 'warn');
            return false;
          }
          if (isEdit) {
            const idx = sortieState.routes.findIndex((r) => r.id === existingRoute.id);
            if (idx >= 0) sortieState.routes[idx] = draft;
          } else {
            sortieState.routes.push(draft);
            sortieState.selectedRouteId = draft.id;
          }
          await persistRoutes();
          bus.emit('sortie:routes-changed', { routeId: draft.id });
          uiKit.showToast(`航线「${draft.name}」已保存`, 'ok');
          if (typeof onSaved === 'function') onSaved();
          await renderSortieConsole();
          return true;
        },
      },
    ],
  });
}

function openRouteEditorSheet() {
  const { uiKit } = sortieState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const renderList = () => {
    wrap.innerHTML = `
      <button type="button" id="btn-sortie-new-route" class="btn-primary uikit-touch-target">+ 新增自定义航线</button>
      <div class="lab-stack-sm">
        ${sortieState.routes
          .map(
            (r) => `
          <div class="ac-editor-card" data-editor-route-id="${escapeHtml(r.id)}">
            <div class="lab-slot-head">
              <strong>${escapeHtml(r.name)}</strong>
              <span class="status-badge ${r.builtIn ? 'badge-muted' : 'badge-ok'}">${r.nodes.length} 节点</span>
            </div>
            <span class="cc-stat-sub">单步：油 ${r.stepCost.fuel} / 弹 ${r.stepCost.ammo} · 启航 AP ${r.apCost}</span>
            <div class="lab-btn-grid">
              <button type="button" class="btn-secondary uikit-touch-target" data-rt-edit>编辑</button>
              <button type="button" class="btn-danger uikit-touch-target" data-rt-del ${sortieState.routes.length <= 1 ? 'disabled' : ''}>删除</button>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    wrap.querySelector('#btn-sortie-new-route').addEventListener('click', () => {
      openRouteFormSheet(null, () => renderList());
    });

    wrap.querySelectorAll('[data-editor-route-id]').forEach((card) => {
      const rid = card.getAttribute('data-editor-route-id');
      const rt = sortieState.routes.find((x) => x.id === rid);
      if (!rt) return;

      card.querySelector('[data-rt-edit]').addEventListener('click', () => {
        openRouteFormSheet(rt, () => renderList());
      });

      card.querySelector('[data-rt-del]').addEventListener('click', async () => {
        if (sortieState.routes.length <= 1) return;
        const ok = await uiKit.confirmDialog({
          title: `删除航线「${rt.name}」`,
          message: '确认删除该出征航线吗？',
          confirmLabel: '确认删除',
          tone: 'danger',
        });
        if (!ok) return;
        sortieState.routes = sortieState.routes.filter((x) => x.id !== rid);
        if (sortieState.selectedRouteId === rid) {
          sortieState.selectedRouteId = sortieState.routes[0]?.id || null;
        }
        await persistRoutes();
        uiKit.showToast(`已删除航线：${rt.name}`, 'ok');
        renderList();
        await renderSortieConsole();
      });
    });
  };

  renderList();
  uiKit.openBottomSheet({
    title: '出征航线编辑器',
    subtitle: '自由配置航线节点序列、单步油弹消耗与检定难度',
    content: wrap,
    actions: [{ id: 'close', label: '关闭', tone: 'secondary' }],
  });
}

// ============================================================
// Visual Route Node Map Helper
// ============================================================

function createNodeMapElement(nodes, clearedIndices = [], nextNodeIndex = -1) {
  const map = document.createElement('div');
  map.className = 'sortie-node-map';
  map.id = 'sortie-node-map';

  const clearedSet = new Set(clearedIndices);

  nodes.forEach((node, idx) => {
    if (idx > 0) {
      const conn = document.createElement('span');
      conn.className = 'sortie-connector';
      conn.textContent = '→';
      map.appendChild(conn);
    }
    const isCleared = clearedSet.has(idx);
    const isCurrent = idx === nextNodeIndex;
    const step = document.createElement('div');
    step.className = `sortie-node-step ${isCleared ? 'is-cleared' : ''} ${isCurrent ? 'is-current' : ''} ${
      node.type === 'boss' ? 'is-boss' : ''
    }`;
    step.dataset.nodeCode = node.code;
    step.innerHTML = `
      <span class="sortie-node-code">${isCleared ? '✓' : escapeHtml(node.code)}</span>
      <span class="sortie-node-type">${escapeHtml(NODE_TYPE_LABELS[node.type] || node.type)}</span>
      <span class="sortie-node-name">${escapeHtml(node.name)}</span>
    `;
    map.appendChild(step);
  });

  return map;
}

// ============================================================
// Root View Renderer
// ============================================================

async function renderSortieConsole() {
  if (!sortieState.container || !sortieState.context) return;
  const { resources, statRules, inventory, narrative, modules, uiKit } = sortieState.context;
  const char = getFlagship();
  if (!char) {
    sortieState.container.innerHTML = `
      <section class="surface-card">
        <h2 class="section-title">暂无可用出征角色</h2>
        <p class="muted-text">请先返回港区或角色控制台配置旗舰角色。</p>
      </section>
    `;
    return;
  }

  const seaworthyInfo = statRules.evaluateSeaworthiness(inventory, char.id);
  const mode = narrative.getMode();
  const isAiMode = mode !== NARRATIVE_MODES.LOCAL;
  const maxHp = Number(char.stats.maxHp ?? 100);
  const maxAp = Number(char.stats.maxAp ?? 100);
  const curHp = Number(char.stats.hp ?? maxHp);
  const isHeavyDamage = curHp / maxHp < 0.25;

  sortieState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'sortie-root';

  // 1. Unified 6-Resource Bar
  root.appendChild(createResourceOverviewBar(resources, { id: 'sortie-resource-bar' }));

  // 2. Flagship Compact Status & Controls Bar
  const topCard = document.createElement('section');
  topCard.className = 'surface-card lab-stack-sm';
  topCard.id = 'sortie-flagship-bar';
  topCard.innerHTML = `
    <div class="lab-slot-head">
      <div class="cc-badge-row">
        <strong>旗舰：${escapeHtml(char.name)}</strong>
        <span class="status-badge ${seaworthyInfo.seaworthy ? 'badge-ok' : 'badge-danger'}" id="sortie-seaworthy-badge">
          ${seaworthyInfo.seaworthy ? '适航' : '未适航'}
        </span>
        ${isHeavyDamage ? '<span class="status-badge badge-danger" id="sortie-heavy-dmg-badge">大破警告</span>' : ''}
      </div>
      <button type="button" id="btn-sortie-mode-toggle" class="ac-mode-toggle ${isAiMode ? 'is-ai' : ''}">
        ${isAiMode ? 'AI 润色' : '纯本地模板'}
      </button>
    </div>

    <div id="sortie-compact-bars" class="ac-bars-compact"></div>

    <div class="lab-btn-grid">
      <button type="button" id="btn-sortie-open-editor" class="btn-secondary uikit-touch-target">航线编辑器</button>
      <button type="button" id="btn-sortie-back-port" class="btn-secondary uikit-touch-target">返回港区</button>
    </div>
  `;

  const barsHost = topCard.querySelector('#sortie-compact-bars');
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: 'HP',
      value: curHp,
      max: maxHp,
      showPercent: false,
      sublabel: `${Math.round(curHp)}/${maxHp}`,
      tone: isHeavyDamage ? 'danger' : curHp / maxHp < 0.5 ? 'warn' : 'accent',
    }).element
  );
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: '士气',
      value: char.stats.morale ?? 50,
      max: 100,
      showPercent: false,
      sublabel: `${Math.round(char.stats.morale ?? 50)}`,
      tone: (char.stats.morale ?? 50) < 30 ? 'danger' : 'accent',
    }).element
  );
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: 'AP',
      value: char.stats.ap ?? maxAp,
      max: maxAp,
      showPercent: false,
      sublabel: `${Math.round(char.stats.ap ?? maxAp)}/${maxAp}`,
      tone: (char.stats.ap ?? maxAp) / maxAp < 0.25 ? 'warn' : 'accent',
    }).element
  );

  topCard.querySelector('#btn-sortie-mode-toggle').addEventListener('click', () => {
    const next = isAiMode ? NARRATIVE_MODES.LOCAL : NARRATIVE_MODES.AI_POLISH;
    narrative.setMode(next);
    uiKit.showToast(
      next === NARRATIVE_MODES.LOCAL ? '已切换为纯本地离线战报模板' : '已切换为 AI 剧情润色（无 Key 自动降级）',
      'ok'
    );
    renderSortieConsole();
  });
  topCard.querySelector('#btn-sortie-open-editor').addEventListener('click', () => openRouteEditorSheet());
  topCard.querySelector('#btn-sortie-back-port').addEventListener('click', () => {
    if (modules.has('port-hub')) modules.mount('port-hub');
  });
  root.appendChild(topCard);

  // 3. Active Sortie Run OR Route Selection View
  if (sortieState.activeRun) {
    const run = sortieState.activeRun;
    const activeCard = document.createElement('section');
    activeCard.className = 'surface-card lab-stack-sm';
    activeCard.id = 'sortie-active-panel';
    activeCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">出征中：${escapeHtml(run.routeName)}</h2>
        <span class="status-badge ${run.completed ? 'badge-ok' : 'badge-warn'}">
          ${run.completed ? '全节点通关' : `进度 ${run.clearedIndices.length}/${run.nodes.length}`}
        </span>
      </div>
      <div id="sortie-map-mount"></div>
      <div class="muted-text" style="font-size:12px;" id="sortie-loot-summary">
        累计战利品：<strong>${escapeHtml(formatLootSummary(run.loot, resources))}</strong>
      </div>
      ${
        isHeavyDamage && !run.completed
          ? '<div class="seaworthy-alert" id="sortie-heavy-dmg-alert">大破危险状态（HP < 25%）！建议立即点击「携带战利品返航回港区」进行入渠修复，强行进击风险极高。</div>'
          : ''
      }
      <div class="lab-stack-sm" id="sortie-decision-btns">
        ${
          !run.completed
            ? `
          <button type="button" id="btn-sortie-advance" class="btn-primary port-cta-btn" ${sortieState.busy ? 'disabled' : ''}>
            ${
              run.nextNodeIndex === 0
                ? `向首节点 ${run.nodes[0].code} 进发（油-${run.stepCost.fuel} / 弹-${run.stepCost.ammo}）`
                : `继续前进 → 节点 ${run.nodes[run.nextNodeIndex].code}（油-${run.stepCost.fuel} / 弹-${run.stepCost.ammo}）`
            }
          </button>
        `
            : ''
        }
        <button type="button" id="btn-sortie-retreat" class="${run.completed ? 'btn-primary port-cta-btn' : 'btn-secondary uikit-touch-target'}">
          ${run.completed ? '胜利凯旋 · 携带战利品返航回港区' : '携带战利品返航回港区'}
        </button>
      </div>
    `;

    activeCard
      .querySelector('#sortie-map-mount')
      .appendChild(createNodeMapElement(run.nodes, run.clearedIndices, run.completed ? -1 : run.nextNodeIndex));

    const advBtn = activeCard.querySelector('#btn-sortie-advance');
    if (advBtn) {
      advBtn.addEventListener('click', () => advanceNextNode());
    }
    activeCard.querySelector('#btn-sortie-retreat').addEventListener('click', () => retreatToPort());
    root.appendChild(activeCard);

    // Node Battle / Salvage Reports Timeline
    const reportsWrap = document.createElement('div');
    reportsWrap.className = 'ac-timeline';
    reportsWrap.id = 'sortie-reports-list';
    for (const rep of run.reports || []) {
      const card = document.createElement('article');
      card.className = 'ac-card';
      card.dataset.sortieReport = rep.id;
      card.innerHTML = `
        <div class="ac-card-head">
          <h3 class="ac-card-title">节点 ${escapeHtml(rep.nodeCode)} · ${escapeHtml(rep.nodeName)}</h3>
          <span class="status-badge ${rep.degraded ? 'badge-warn' : 'badge-muted'}">${escapeHtml(rep.nodeType)} · ${escapeHtml(rep.check.outcomeLabel)}</span>
        </div>
        <p class="ac-card-body">${escapeHtml(rep.text)}</p>
        <div class="cc-check-result outcome-${escapeHtml(rep.check.outcome)}" style="padding:10px;">
          <div class="cc-check-headline">
            <span class="cc-check-outcome" style="font-size:15px;">${escapeHtml(rep.check.statLabel)} · ${escapeHtml(rep.check.outcomeLabel)}</span>
            <span class="cc-check-score" style="font-size:13.5px;">${rep.check.total} / DC ${rep.check.dc}（${formatSigned(rep.check.margin)}）</span>
          </div>
          <div class="cc-check-steps">
            ${(rep.check.steps || [])
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
        </div>
        <div class="ac-settlement-chips">
          ${(rep.chips || [])
            .map((c) => `<span class="ac-delta-chip ${c.negative ? 'is-neg' : ''}">${escapeHtml(c.text)}</span>`)
            .join('')}
        </div>
      `;
      reportsWrap.appendChild(card);
    }
    root.appendChild(reportsWrap);
  } else {
    // Route Selection & Pre-Sortie Validation View
    const selectedRoute = getSelectedRoute();
    const validation = validateSortieLaunch(char, selectedRoute);

    const selectCard = document.createElement('section');
    selectCard.className = 'surface-card lab-stack-sm';
    selectCard.id = 'sortie-select-panel';
    selectCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">选择出征航线（${sortieState.routes.length} 条）</h2>
      </div>
      <div class="lab-stack-sm" id="sortie-route-list"></div>
      ${
        !validation.ok
          ? `<div class="seaworthy-alert" id="sortie-launch-errors">启航条件未满足：${escapeHtml(validation.errors.join('；'))}</div>`
          : ''
      }
      <button type="button" id="btn-sortie-launch" class="btn-primary port-cta-btn" ${validation.ok ? '' : 'disabled'}>
        ${selectedRoute ? `启航出击：${escapeHtml(selectedRoute.name)}（AP -${selectedRoute.apCost}）` : '请选择航线'}
      </button>
    `;

    const listHost = selectCard.querySelector('#sortie-route-list');
    for (const rt of sortieState.routes) {
      const isSel = selectedRoute && rt.id === selectedRoute.id;
      const card = document.createElement('div');
      card.className = `sortie-route-card ${isSel ? 'is-selected' : ''}`;
      card.dataset.routeId = rt.id;
      card.innerHTML = `
        <div class="lab-slot-head">
          <strong>${escapeHtml(rt.name)}</strong>
          <span class="status-badge ${isSel ? 'badge-ok' : 'badge-muted'}">${rt.nodes.length} 节点</span>
        </div>
        <p class="muted-text" style="font-size:12px;">${escapeHtml(rt.description)}</p>
        <div data-rt-map></div>
        <div class="cc-stat-sub">最低要求：油 ≥ ${rt.minFuel} / 弹 ≥ ${rt.minAmmo} / AP ≥ ${rt.apCost} · 单步油 ${rt.stepCost.fuel} / 弹 ${rt.stepCost.ammo}</div>
        <button type="button" class="${isSel ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-select-route="${escapeHtml(rt.id)}">
          ${isSel ? '当前已选航线' : '选择此航线'}
        </button>
      `;
      card.querySelector('[data-rt-map]').appendChild(createNodeMapElement(rt.nodes, [], -1));
      card.querySelector('[data-select-route]').addEventListener('click', () => {
        sortieState.selectedRouteId = rt.id;
        renderSortieConsole();
      });
      listHost.appendChild(card);
    }

    selectCard.querySelector('#btn-sortie-launch').addEventListener('click', () => {
      if (selectedRoute) launchSortie(selectedRoute);
    });

    root.appendChild(selectCard);
  }

  sortieState.container.appendChild(root);
}

// ============================================================
// Standard Module Export
// ============================================================

export default {
  id: 'sortie-console',
  name: '出征航线台',
  description: '节点式出征航线控制台：适航与油弹前置校验、可视化节点进度图、D20 战利品结算、大破强行进击警告与可视化航线编辑器。',

  mount(container, context) {
    sortieState.container = container;
    sortieState.context = context;

    context.ui.setPlaceholder('出征指挥记录：输入备忘将写入行动日志...');
    context.ui.setInputHandler((text) => {
      const char = getFlagship();
      context.logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        actorId: char?.id || null,
        actorName: char?.name || '',
        title: `${char ? `[${char.name}] ` : ''}出征战地记录`,
        detail: text,
      });
      context.uiKit.showToast('已记入行动日志', 'ok');
    });

    context.ui.setQuickActions([
      {
        id: 'sortie-q-port',
        label: '返回港区',
        onClick: () => context.modules.mount('port-hub'),
      },
      {
        id: 'sortie-q-editor',
        label: '航线编辑器',
        onClick: () => openRouteEditorSheet(),
      },
      {
        id: 'sortie-q-char',
        label: '角色控制台',
        onClick: () => context.modules.mount('character-console'),
      },
    ]);

    sortieState.unsubs = [
      context.bus.on('character:selected', () => renderSortieConsole()),
      context.bus.on('inventory:equipped', () => renderSortieConsole()),
      context.bus.on('inventory:unequipped', () => renderSortieConsole()),
      context.bus.on('storage:changed', (detail) => {
        if (detail?.action === 'resetAll' || detail?.action === 'import') {
          renderSortieConsole();
        }
      }),
    ];

    if (!sortieState.hydrated) {
      hydrateSortieConsole({ storage: context.rootStorage }).then(() => renderSortieConsole());
    } else {
      renderSortieConsole();
    }
  },

  unmount() {
    for (const unsub of sortieState.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    sortieState.unsubs = [];
    sortieState.container = null;
    sortieState.context = null;
  },
};
