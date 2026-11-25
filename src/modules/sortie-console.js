/**
 * Official Business Module: Tactical Sortie Command Console (`sortie-console`).
 *
 * Integrates:
 *   - RouteGenerator: procedural random routes (low/medium/high, 3-6 nodes, sea conditions) + custom routes
 *   - TacticalCombatEngine: multi-turn Scan / Evade / Shelling / Torpedo combat HUD
 *   - FxStage: decoupled EventBus animations (micro-shake, scan ripple, floating damage, dice roll)
 *   - Pre-sortie Seaworthiness (engine/armor/core) + fuel/ammo/AP checks, Heavy Damage (<25% HP) warning,
 *     auto-salvage resource/weather nodes, and dual-track local/AI battle reports.
 */

import { CORE_STAT_DEFS } from '../core/stat-rules.js';
import { createResourceOverviewBar } from '../core/resource-manager.js';
import { NARRATIVE_MODES } from '../core/prompt-pipeline.js';
import { LOG_CATEGORIES } from '../core/log-system.js';
import {
  NODE_TYPES,
  NODE_TYPE_LABELS,
  SEA_DIFFICULTIES,
} from '../core/route-generator.js';
import { COMBAT_COMMANDS } from '../core/tactical-combat.js';
import { getActiveCharacterId, persistCharacterRoster } from './character-console.js';
import { clamp } from '../core/calc-engine.js';

const SORTIE_STORAGE_NS = 'core-sortie';
const RUN_KEY = 'active-sortie-run-v2';

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

function isCombatNodeType(type) {
  return type === NODE_TYPES.ENCOUNTER || type === NODE_TYPES.ELITE || type === NODE_TYPES.BOSS;
}

let sortieState = {
  container: null,
  context: null,
  selectedDifficulty: 'low',
  generatedRoute: null,
  selectedRouteId: null,
  activeRun: null,
  busy: false,
  hydrated: false,
  unsubs: [],
};

export async function hydrateSortieConsole({ storage, routeGenerator, combat }) {
  if (routeGenerator) {
    await routeGenerator.init();
  }
  const scope = storage.namespace(SORTIE_STORAGE_NS);
  const savedRun = await scope.getLarge(RUN_KEY, null);
  sortieState.activeRun = savedRun && typeof savedRun === 'object' ? deepClone(savedRun) : null;
  if (combat && sortieState.activeRun?.combatSnapshot) {
    combat.deserialize(sortieState.activeRun.combatSnapshot);
  }
  const allRoutes = routeGenerator ? routeGenerator.listAllRoutes() : [];
  sortieState.selectedRouteId = allRoutes[0]?.id || null;
  sortieState.hydrated = true;
}

async function persistActiveRun() {
  if (!sortieState.context) return;
  const scope = sortieState.context.rootStorage.namespace(SORTIE_STORAGE_NS);
  if (sortieState.activeRun) {
    sortieState.activeRun.combatSnapshot = sortieState.context.combat?.serialize() || null;
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

function getAvailableRoutes() {
  const saved = sortieState.context?.routeGenerator?.listAllRoutes() || [];
  return sortieState.generatedRoute ? [sortieState.generatedRoute, ...saved] : saved;
}

function getSelectedRoute() {
  const list = getAvailableRoutes();
  return list.find((r) => r.id === sortieState.selectedRouteId) || list[0] || null;
}

function validateSortieLaunch(char, route) {
  const { statRules, inventory, resources } = sortieState.context;
  const errors = [];
  if (!char) return { ok: false, errors: ['暂无可用角色'] };
  if (!route) return { ok: false, errors: ['请先生成或选择一条航线'] };

  const sw = statRules.evaluateSeaworthiness(inventory, char.id);
  if (!sw.seaworthy) errors.push(sw.statusText);
  if (Number(char.stats.hp ?? 0) <= 0) errors.push('当前旗舰 HP 为 0，请先回港区修复');
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
    if (val > 0) parts.push(`${resources.get(k)?.name || k} +${val}`);
  }
  return parts.length > 0 ? parts.join('、') : '暂无战利品';
}

// ============================================================
// Sortie Flow: Launch, Step Node, Tactical Command, Retreat
// ============================================================

async function launchSortie(route) {
  const char = getFlagship();
  const check = validateSortieLaunch(char, route);
  const { entities, rootStorage, combat, logs, bus, uiKit } = sortieState.context;

  if (!check.ok) {
    uiKit.showToast(`无法启航：${check.errors[0]}`, 'error');
    return;
  }

  const maxHp = Number(char.stats.maxHp ?? 100);
  if (Number(char.stats.hp ?? maxHp) / maxHp < 0.25) {
    const proceed = await uiKit.confirmDialog({
      title: '大破状态启航警告',
      message: `「${char.name}」当前 HP 低于 25%，处于大破状态。建议先在港区入渠修复，确定仍要强行启航吗？`,
      confirmLabel: '强行启航',
      cancelLabel: '取消',
      tone: 'danger',
    });
    if (!proceed) return;
  }

  if (route.apCost > 0) {
    entities.adjustStat(char.id, 'ap', -route.apCost, { min: 0, max: Number(char.stats.maxAp ?? 100) });
    await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
  }

  combat.clearSession();
  sortieState.activeRun = {
    routeId: route.id,
    routeName: route.name,
    difficultyLabel: route.difficultyLabel || '标准海域',
    seaCondition: route.seaCondition ? deepClone(route.seaCondition) : null,
    characterId: char.id,
    characterName: char.name,
    stepCost: deepClone(route.stepCost),
    nodes: deepClone(route.nodes),
    nextNodeIndex: 0,
    clearedIndices: [],
    loot: { fuel: 0, ammo: 0, steel: 0, bauxite: 0, silver: 0, gold: 0 },
    reports: [],
    completed: false,
    combatSnapshot: null,
    startedAt: Date.now(),
  };

  await persistActiveRun();
  logs.add({
    category: LOG_CATEGORIES.SYSTEM,
    actorId: char.id,
    actorName: char.name,
    title: `[${char.name}] 启航出征「${route.name}」`,
    detail: `消耗 AP -${route.apCost}，海况：${route.seaCondition?.label || '标准'}，共 ${route.nodes.length} 节点`,
  });
  bus.emit('sortie:launched', { routeId: route.id, characterId: char.id });
  uiKit.showToast(`已启航进入「${route.name}」`, 'ok');
  await renderSortieConsole();
}

async function advanceNextNode() {
  if (sortieState.busy || !sortieState.activeRun) return;
  const run = sortieState.activeRun;
  const { entities, inventory, statRules, resources, narrative, turnStepper, combat, rootStorage, logs, bus, uiKit } =
    sortieState.context;

  if (combat.isActive() || run.completed || run.nextNodeIndex >= run.nodes.length) return;

  const char = entities.get(run.characterId) || getFlagship();
  if (!char) return;

  const maxHp = Number(char.stats.maxHp ?? 100);
  const curHp = Number(char.stats.hp ?? maxHp);
  if (curHp <= 0) {
    uiKit.showToast('当前旗舰 HP 为 0，请立即返航回港区修复', 'error');
    return;
  }

  if (curHp / maxHp < 0.25) {
    const confirmed = await uiKit.confirmDialog({
      title: '大破强行进击风险警告',
      message: `警告：「${char.name}」当前 HP 仅剩 ${Math.round(curHp)}/${maxHp}（低于 25% 大破线）！强行进击风险极高，建议立即返航回港区。确定继续前进吗？`,
      confirmLabel: '强行继续前进',
      cancelLabel: '取消并返航',
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
    uiKit.showToast(`油弹不足，无法继续推进：${spend.reason}`, 'error');
    return;
  }

  const nodeIdx = run.nextNodeIndex;
  const node = run.nodes[nodeIdx];
  turnStepper.advance({ steps: 1, reason: `sortie-node-${node.code}` });

  // Branch A: Combat Node (encounter / elite / boss) -> Launch Tactical Combat Panel!
  if (isCombatNodeType(node.type)) {
    combat.startEncounter({
      characterId: char.id,
      node,
      seaCondition: run.seaCondition,
    });
    await persistActiveRun();
    uiKit.showToast(`节点 ${node.code} 遇敌：${node.name}！请选择战术指令`, 'warn');
    await renderSortieConsole();
    return;
  }

  // Branch B: Non-combat Resource / Weather-Recon Node -> Auto Salvage & Settlement
  sortieState.busy = true;
  await renderSortieConsole();
  try {
    const statKey = node.statKey || (node.type === NODE_TYPES.RESOURCE ? 'luck' : 'tactics');
    const baseVal = Number(char.stats[statKey] ?? 50);
    const effVal = entities.getEffectiveStat(char.id, statKey, { round: 'round' }).final;
    const eqBonuses = inventory.getCharacterEquipmentBonuses(char.id);
    const seaBonus = run.seaCondition?.mods?.checkBonus || 0;

    const checkResult = statRules.performCheck({
      actorId: char.id,
      actorName: char.name,
      statKey,
      baseStatValue: baseVal,
      effectiveStatValue: effVal,
      equipmentCheckBonus: eqBonuses.checkBonus,
      moraleValue: char.stats.morale ?? 60,
      dc: Number(node.dc) || 12,
      extraModifier: seaBonus,
    });

    const isSuccess = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
    const mult = checkResult.outcome === 'crit-success' ? 1.4 : isSuccess ? 1.0 : 0.45;
    const chips = [
      { text: `燃油 -${stepCost.fuel}`, negative: true },
      { text: `弹药 -${stepCost.ammo}`, negative: true },
    ];
    const gained = {};

    for (const [rk, rawVal] of Object.entries(node.loot || {})) {
      const val = Math.round((Number(rawVal) || 0) * mult);
      if (val <= 0) continue;
      await resources.add(rk, val, { reason: `节点 ${node.code}·${node.name} 打捞` });
      run.loot[rk] = (run.loot[rk] || 0) + val;
      gained[rk] = val;
      chips.push({ text: `${resources.get(rk)?.name || rk} +${val}`, negative: false });
    }

    if (isSuccess) {
      const aff = Number(node.affinityGain) || 2;
      entities.adjustStat(char.id, 'affinity', aff, { min: 0, max: 100 });
      entities.adjustStat(char.id, 'morale', 3, { min: 0, max: 100 });
      chips.push({ text: `好感 +${aff}`, negative: false });
    } else if (node.type === NODE_TYPES.WEATHER) {
      const dmg = Math.max(4, Number(node.failDamage?.hp) || 6);
      entities.adjustStat(char.id, 'hp', -dmg, { min: 0, max: maxHp });
      chips.push({ text: `海况损耗 HP -${dmg}`, negative: true });
    }

    await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
    const lootText = formatLootSummary(gained, resources);

    const rendered = await narrative.run({
      template: isSuccess
        ? '【节点 {nodeCode} · {nodeName}（{nodeType}）】{actor.name}顺利完成打捞与勘察（{check.total} vs DC {check.dc}），收获：{lootText}。'
        : '【节点 {nodeCode} · {nodeName}（{nodeType}）】受限于海域环境（{check.total} vs DC {check.dc}），仅回收到部分物资：{lootText}。',
      variables: {
        nodeCode: node.code,
        nodeName: node.name,
        nodeType: NODE_TYPE_LABELS[node.type] || node.type,
        actor: { name: char.name },
        lootText,
        check: checkResult,
      },
      polishInstruction: `请简短润色节点 ${node.code} 的打捞/气象侦察战报，保留全部客观数字：`,
    });

    run.clearedIndices.push(nodeIdx);
    run.nextNodeIndex = nodeIdx + 1;
    if (run.nextNodeIndex >= run.nodes.length) run.completed = true;

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
      title: `[${char.name}] 节点 ${node.code}·${node.name}（${NODE_TYPE_LABELS[node.type] || node.type}）`,
      detail: `收获：${lootText}`,
    });
    bus.emit('sortie:node-resolved', { routeId: run.routeId, nodeCode: node.code, completed: run.completed });
    uiKit.showToast(`节点 ${node.code} 打捞完成：${lootText}`, 'ok');
  } finally {
    sortieState.busy = false;
    await renderSortieConsole();
  }
}

async function handleTacticalCommand(commandId) {
  if (sortieState.busy || !sortieState.activeRun) return;
  const run = sortieState.activeRun;
  const { combat, entities, resources, rootStorage, logs, bus, uiKit } = sortieState.context;
  if (!combat.isActive()) return;

  sortieState.busy = true;
  await renderSortieConsole();

  try {
    const res = await combat.executeCommand(commandId);
    if (!res.ok) {
      uiKit.showToast(res.reason || '无法执行战术指令', 'warn');
      return;
    }

    const { turnEntry, session } = res;
    const nodeIdx = run.nextNodeIndex;
    const node = run.nodes[nodeIdx];
    const char = entities.get(run.characterId) || getFlagship();

    // Push combat turn report to sortie reports
    run.reports.unshift({
      id: `cmbr_${Date.now()}_${turnEntry.turn}`,
      nodeCode: node.code,
      nodeName: `${node.name} · T${turnEntry.turn} ${turnEntry.commandLabel}`,
      nodeType: turnEntry.outcomeTag,
      text: turnEntry.text,
      source: turnEntry.source,
      degraded: turnEntry.degraded,
      check: turnEntry.check,
      chips: turnEntry.chips,
      timestamp: turnEntry.timestamp,
    });

    if (session.status === 'victory' || session.status === 'bypassed') {
      const gained = {};
      if (session.status === 'victory') {
        for (const [rk, rawVal] of Object.entries(node.loot || {})) {
          const val = Number(rawVal) || 0;
          if (val <= 0) continue;
          await resources.add(rk, val, { reason: `击破节点 ${node.code}·${node.name} 战利品` });
          run.loot[rk] = (run.loot[rk] || 0) + val;
          gained[rk] = val;
        }
        if (char) {
          const aff = Number(node.affinityGain) || 3;
          entities.adjustStat(char.id, 'affinity', aff, { min: 0, max: 100 });
          entities.adjustStat(char.id, 'morale', 4, { min: 0, max: 100 });
        }
      }

      run.clearedIndices.push(nodeIdx);
      run.nextNodeIndex = nodeIdx + 1;
      if (run.nextNodeIndex >= run.nodes.length) run.completed = true;
      combat.clearSession();

      const lootText = formatLootSummary(gained, resources);
      logs.add({
        category: LOG_CATEGORIES.STAT,
        actorId: char?.id || null,
        actorName: char?.name || '',
        title: `[${char?.name || ''}] 节点 ${node.code}·${node.name} ${session.status === 'victory' ? '交战胜利' : '迂回通过'}`,
        detail: session.status === 'victory' ? `战利品：${lootText}` : '无伤绕过敌方封锁',
      });
      bus.emit('sortie:node-resolved', {
        routeId: run.routeId,
        nodeCode: node.code,
        status: session.status,
        completed: run.completed,
      });

      uiKit.showToast(
        session.status === 'victory'
          ? `战斗胜利！打捞：${lootText}`
          : `成功迂回绕过节点 ${node.code}！`,
        'ok'
      );
    } else if (session.status === 'defeated') {
      combat.clearSession();
      uiKit.showToast('旗舰 HP 归零！请立即返航回港区入渠修复', 'error');
    } else {
      uiKit.showToast(`${turnEntry.commandLabel}：${turnEntry.outcomeTag}`, turnEntry.damageDealt > 0 ? 'ok' : 'info');
    }

    if (char) {
      await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
    }
    await persistActiveRun();
  } finally {
    sortieState.busy = false;
    await renderSortieConsole();
  }
}

async function retreatToPort() {
  const { resources, combat, logs, bus, modules, uiKit } = sortieState.context;
  const run = sortieState.activeRun;
  combat.clearSession();
  if (run) {
    const haul = formatLootSummary(run.loot, resources);
    logs.add({
      category: LOG_CATEGORIES.SYSTEM,
      actorId: run.characterId,
      actorName: run.characterName,
      title: `[${run.characterName}] ${run.completed ? '凯旋返航' : '携战利品返航'}（${run.routeName}）`,
      detail: `已通关 ${run.clearedIndices.length}/${run.nodes.length} 节点 | 累计打捞：${haul}`,
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
  const { routeGenerator, uiKit } = sortieState.context;
  const isEdit = Boolean(existingRoute);

  const draft = existingRoute
    ? deepClone(existingRoute)
    : {
        id: `route_custom_${Date.now().toString(36)}`,
        name: '',
        description: '玩家自定义固定航线。',
        difficulty: 'low',
        apCost: 15,
        stepCost: { fuel: 25, ammo: 20 },
        nodes: [
          { code: 'A', name: '物资打捞点', type: NODE_TYPES.RESOURCE, statKey: 'tactics', dc: 12 },
          { code: 'B', name: '常规遭遇编队', type: NODE_TYPES.ENCOUNTER, statKey: 'attack', dc: 14 },
          { code: 'C', name: '终点主力决战', type: NODE_TYPES.BOSS, statKey: 'attack', dc: 16 },
        ],
      };

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const readForm = () => {
    const nameEl = wrap.querySelector('#rt-f-name');
    if (!nameEl) return;
    draft.name = nameEl.value.trim();
    draft.description = wrap.querySelector('#rt-f-desc').value.trim();
    draft.difficulty = wrap.querySelector('#rt-f-diff').value;
    draft.stepCost.fuel = clamp(Number(wrap.querySelector('#rt-f-sfuel').value) || 25, 0, 500);
    draft.stepCost.ammo = clamp(Number(wrap.querySelector('#rt-f-sammo').value) || 20, 0, 500);
    draft.apCost = clamp(Number(wrap.querySelector('#rt-f-ap').value) || 15, 0, 100);

    const nodes = [];
    wrap.querySelectorAll('[data-node-row]').forEach((row, idx) => {
      nodes.push({
        code: String.fromCharCode(65 + idx),
        name: row.querySelector('[data-n-name]').value.trim() || `节点 ${String.fromCharCode(65 + idx)}`,
        type: row.querySelector('[data-n-type]').value,
        statKey: row.querySelector('[data-n-stat]').value,
        dc: clamp(Number(row.querySelector('[data-n-dc]').value) || 14, 5, 35),
      });
    });
    draft.nodes = nodes;
  };

  const renderForm = () => {
    wrap.innerHTML = `
      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="rt-f-name">航线名称 *</label>
          <input id="rt-f-name" class="form-input" type="text" value="${escapeHtml(draft.name)}" placeholder="例如：自定义巡逻线">
        </div>
        <div class="form-group">
          <label class="form-label" for="rt-f-diff">海域难度</label>
          <select id="rt-f-diff" class="form-select">
            <option value="low" ${draft.difficulty === 'low' ? 'selected' : ''}>低危海域</option>
            <option value="medium" ${draft.difficulty === 'medium' ? 'selected' : ''}>中危海域</option>
            <option value="high" ${draft.difficulty === 'high' ? 'selected' : ''}>高危海域</option>
          </select>
        </div>
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
        <span class="form-label">节点序列（${draft.nodes.length} 节点）</span>
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
                  <option value="${NODE_TYPES.RESOURCE}" ${n.type === NODE_TYPES.RESOURCE ? 'selected' : ''}>资源打捞</option>
                  <option value="${NODE_TYPES.WEATHER}" ${n.type === NODE_TYPES.WEATHER ? 'selected' : ''}>气象侦察</option>
                  <option value="${NODE_TYPES.ENCOUNTER}" ${n.type === NODE_TYPES.ENCOUNTER ? 'selected' : ''}>常规遭遇</option>
                  <option value="${NODE_TYPES.ELITE}" ${n.type === NODE_TYPES.ELITE ? 'selected' : ''}>精英封锁</option>
                  <option value="${NODE_TYPES.BOSS}" ${n.type === NODE_TYPES.BOSS ? 'selected' : ''}>Boss决战</option>
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
        name: `扩展遭遇 ${String.fromCharCode(65 + draft.nodes.length)}`,
        type: NODE_TYPES.ENCOUNTER,
        statKey: 'attack',
        dc: 14,
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
    title: isEdit ? `编辑自定义航线 · ${existingRoute.name}` : '新增自定义固定航线',
    subtitle: '持久化存入 IndexedDB',
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
          const saved = await routeGenerator.saveCustomRoute(draft);
          sortieState.selectedRouteId = saved.id;
          uiKit.showToast(`航线「${saved.name}」已保存`, 'ok');
          if (typeof onSaved === 'function') onSaved();
          await renderSortieConsole();
          return true;
        },
      },
    ],
  });
}

function openRouteEditorSheet() {
  const { routeGenerator, uiKit } = sortieState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const renderList = () => {
    const customs = routeGenerator.listCustomRoutes();
    wrap.innerHTML = `
      <button type="button" id="btn-sortie-new-route" class="btn-primary uikit-touch-target">+ 新增自定义固定航线</button>
      <div class="lab-stack-sm">
        ${
          customs.length === 0
            ? '<p class="muted-text">暂无自定义航线，点击上方按钮新建或将随机生成的航线保存为固定航线。</p>'
            : customs
                .map(
                  (r) => `
            <div class="ac-editor-card" data-editor-route-id="${escapeHtml(r.id)}">
              <div class="lab-slot-head">
                <strong>${escapeHtml(r.name)}</strong>
                <span class="status-badge badge-ok">${r.nodes.length} 节点</span>
              </div>
              <span class="cc-stat-sub">单步：油 ${r.stepCost.fuel} / 弹 ${r.stepCost.ammo} · 启航 AP ${r.apCost}</span>
              <div class="lab-btn-grid">
                <button type="button" class="btn-secondary uikit-touch-target" data-rt-edit>编辑</button>
                <button type="button" class="btn-danger uikit-touch-target" data-rt-del>删除</button>
              </div>
            </div>
          `
                )
                .join('')
        }
      </div>
    `;

    wrap.querySelector('#btn-sortie-new-route').addEventListener('click', () => {
      openRouteFormSheet(null, () => renderList());
    });

    wrap.querySelectorAll('[data-editor-route-id]').forEach((card) => {
      const rid = card.getAttribute('data-editor-route-id');
      const rt = customs.find((x) => x.id === rid);
      if (!rt) return;

      card.querySelector('[data-rt-edit]').addEventListener('click', () => {
        openRouteFormSheet(rt, () => renderList());
      });

      card.querySelector('[data-rt-del]').addEventListener('click', async () => {
        const ok = await uiKit.confirmDialog({
          title: `删除航线「${rt.name}」`,
          message: '确认删除该自定义航线吗？',
          confirmLabel: '确认删除',
          tone: 'danger',
        });
        if (!ok) return;
        await routeGenerator.deleteCustomRoute(rid);
        uiKit.showToast(`已删除航线：${rt.name}`, 'ok');
        renderList();
        await renderSortieConsole();
      });
    });
  };

  renderList();
  uiKit.openBottomSheet({
    title: '自定义航线编辑器',
    subtitle: '支持保存固定航线或随时在主界面程序化随机生成航线',
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
      node.type === NODE_TYPES.BOSS ? 'is-boss' : ''
    }`;
    step.dataset.nodeCode = node.code;
    step.dataset.nodeType = node.type;
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
  const { resources, statRules, inventory, narrative, routeGenerator, combat, modules, uiKit } = sortieState.context;
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
      next === NARRATIVE_MODES.LOCAL ? '已切换为纯本地离线战报模板' : '已切换为 AI 战报润色（无 Key 自动降级）',
      'ok'
    );
    renderSortieConsole();
  });
  topCard.querySelector('#btn-sortie-open-editor').addEventListener('click', () => openRouteEditorSheet());
  topCard.querySelector('#btn-sortie-back-port').addEventListener('click', () => {
    if (modules.has('port-hub')) modules.mount('port-hub');
  });
  root.appendChild(topCard);

  // 3. Active Sortie Run OR Procedural Generator + Route Selector
  if (sortieState.activeRun) {
    const run = sortieState.activeRun;
    const combatSession = combat.isActive() ? combat.getSession() : null;

    const activeCard = document.createElement('section');
    activeCard.className = 'surface-card lab-stack-sm';
    activeCard.id = 'sortie-active-panel';
    activeCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">${escapeHtml(run.routeName)}</h2>
        <span class="status-badge ${run.completed ? 'badge-ok' : combatSession ? 'badge-danger' : 'badge-warn'}">
          ${run.completed ? '全节点通关' : combatSession ? '战术交战中' : `进度 ${run.clearedIndices.length}/${run.nodes.length}`}
        </span>
      </div>
      ${
        run.seaCondition
          ? `<span class="cc-stat-sub">海况词条：<strong>${escapeHtml(run.seaCondition.label)}</strong> · ${escapeHtml(run.seaCondition.description)}</span>`
          : ''
      }
      <div id="sortie-map-mount"></div>
      <div class="muted-text" style="font-size:12px;" id="sortie-loot-summary">
        累计战利品：<strong>${escapeHtml(formatLootSummary(run.loot, resources))}</strong>
      </div>
    `;
    activeCard
      .querySelector('#sortie-map-mount')
      .appendChild(createNodeMapElement(run.nodes, run.clearedIndices, run.completed ? -1 : run.nextNodeIndex));

    // Sub-panel A: Active Multi-Command Tactical Combat Panel
    if (combatSession) {
      const enemy = combatSession.enemy;
      const combatPanel = document.createElement('div');
      combatPanel.className = 'enemy-hud-card';
      combatPanel.id = 'sortie-combat-panel';

      combatPanel.innerHTML = `
        <div class="lab-slot-head">
          <strong>敌方目标：${escapeHtml(enemy.name)}</strong>
          <span class="status-badge badge-danger">
            ${enemy.forcedEngagement ? '主力决战 · 强制交战' : NODE_TYPE_LABELS[enemy.tier] || '交战'} · 第 ${combatSession.turn} 回合
          </span>
        </div>
        <div id="sortie-enemy-hp-bar"></div>
        <div class="cc-badge-row" id="sortie-enemy-intel">
          ${
            enemy.scanned
              ? `
            <span class="status-badge badge-ok">已扫描 · 护甲 ${enemy.armor}</span>
            <span class="status-badge badge-warn">弱点：${escapeHtml(enemy.weaknessLabel)}</span>
          `
              : '<span class="status-badge badge-muted">护甲：??? · 弱点：???（执行「扫描」揭露）</span>'
          }
          ${
            combatSession.lockOnBonus > 0
              ? `<span class="status-badge badge-ok" id="sortie-lockon-badge">锁定增益 +${combatSession.lockOnBonus}</span>`
              : ''
          }
          ${
            combatSession.evasionBuffTurns > 0
              ? `<span class="status-badge badge-ok">闪避减伤 (${combatSession.evasionBuffTurns}回合)</span>`
              : ''
          }
        </div>
        <div class="tactical-cmd-grid" id="sortie-tactical-cmds">
          <button type="button" id="btn-cmd-scan" class="tactical-cmd-btn" data-combat-cmd="scan" ${sortieState.busy ? 'disabled' : ''}>
            <span class="tactical-cmd-title">扫描（Scan）</span>
            <span class="tactical-cmd-sub">索敌 · 油-5 · 揭露弱点+锁定</span>
          </button>
          <button type="button" id="btn-cmd-evade" class="tactical-cmd-btn" data-combat-cmd="evade" ${sortieState.busy ? 'disabled' : ''}>
            <span class="tactical-cmd-title">迂回（Evade）</span>
            <span class="tactical-cmd-sub">机动 · 油-20 · ${enemy.forcedEngagement ? '先手闪避减伤' : '无伤绕过敌人'}</span>
          </button>
          <button type="button" id="btn-cmd-shelling" class="tactical-cmd-btn is-shelling" data-combat-cmd="shelling" ${sortieState.busy ? 'disabled' : ''}>
            <span class="tactical-cmd-title">炮击（Shelling）</span>
            <span class="tactical-cmd-sub">火力 · 弹-15 · 稳定常规伤害</span>
          </button>
          <button type="button" id="btn-cmd-torpedo" class="tactical-cmd-btn is-torpedo" data-combat-cmd="torpedo" ${sortieState.busy ? 'disabled' : ''}>
            <span class="tactical-cmd-title">鱼雷（Torpedo）</span>
            <span class="tactical-cmd-sub">雷装+幸运 · 弹-30 · 高爆高风险</span>
          </button>
        </div>
      `;

      const enemyBar = uiKit.createProgressBar({
        label: '敌方耐久',
        value: enemy.scanned ? enemy.hp : enemy.maxHp,
        max: enemy.maxHp,
        tone: 'danger',
        showPercent: false,
        sublabel: enemy.scanned ? `${enemy.hp} / ${enemy.maxHp}` : '??? / ???（未扫描）',
      });
      combatPanel.querySelector('#sortie-enemy-hp-bar').appendChild(enemyBar.element);

      combatPanel.querySelectorAll('[data-combat-cmd]').forEach((btn) => {
        btn.addEventListener('click', () => handleTacticalCommand(btn.getAttribute('data-combat-cmd')));
      });

      activeCard.appendChild(combatPanel);
    } else {
      // Sub-panel B: Advance / Retreat Decision Controls
      if (isHeavyDamage && !run.completed) {
        const warn = document.createElement('div');
        warn.className = 'seaworthy-alert';
        warn.id = 'sortie-heavy-dmg-alert';
        warn.textContent = '大破危险状态（HP < 25%）！建议立即点击「携带战利品返航回港区」进行入渠修复，强行进击风险极高。';
        activeCard.appendChild(warn);
      }

      const btnStack = document.createElement('div');
      btnStack.className = 'lab-stack-sm';
      btnStack.id = 'sortie-decision-btns';

      if (!run.completed) {
        const nextNode = run.nodes[run.nextNodeIndex];
        const advBtn = document.createElement('button');
        advBtn.type = 'button';
        advBtn.id = 'btn-sortie-advance';
        advBtn.className = 'btn-primary port-cta-btn';
        advBtn.disabled = sortieState.busy;
        advBtn.textContent =
          run.nextNodeIndex === 0
            ? `向首节点 ${nextNode.code} 进发（油-${run.stepCost.fuel} / 弹-${run.stepCost.ammo}）`
            : `继续向下一节点 ${nextNode.code} 进发（油-${run.stepCost.fuel} / 弹-${run.stepCost.ammo}）`;
        advBtn.addEventListener('click', () => advanceNextNode());
        btnStack.appendChild(advBtn);
      }

      const retBtn = document.createElement('button');
      retBtn.type = 'button';
      retBtn.id = 'btn-sortie-retreat';
      retBtn.className = run.completed ? 'btn-primary port-cta-btn' : 'btn-secondary uikit-touch-target';
      retBtn.textContent = run.completed ? '胜利凯旋 · 携带战利品返航回港区' : '携带战利品返航回港区';
      retBtn.addEventListener('click', () => retreatToPort());
      btnStack.appendChild(retBtn);
      activeCard.appendChild(btnStack);
    }

    root.appendChild(activeCard);

    // Tactical Battle & Salvage Reports Timeline
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
          <span class="status-badge ${rep.degraded ? 'badge-warn' : 'badge-muted'}">${escapeHtml(rep.nodeType)}</span>
        </div>
        <p class="ac-card-body">${escapeHtml(rep.text)}</p>
        ${
          rep.check
            ? `
          <div class="cc-check-result outcome-${escapeHtml(rep.check.outcome)}" style="padding:10px;">
            <div class="cc-check-headline">
              <span class="cc-check-outcome" style="font-size:14.5px;">${escapeHtml(rep.check.statLabel)} · ${escapeHtml(rep.check.outcomeLabel)}</span>
              <span class="cc-check-score" style="font-size:13px;">${rep.check.total} / DC ${rep.check.dc}（${formatSigned(rep.check.margin)}）</span>
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
        `
            : ''
        }
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
    // Procedural Route Generator Card
    const genCard = document.createElement('section');
    genCard.className = 'surface-card lab-stack-sm';
    genCard.id = 'sortie-generator-card';
    genCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">随机航线生成器</h2>
        <span class="status-badge badge-ok">3~6 节点 + 随机海况</span>
      </div>
      <div class="cc-btn-3col" id="sortie-diff-chips">
        ${Object.values(SEA_DIFFICULTIES)
          .map(
            (d) => `
          <button type="button" class="${sortieState.selectedDifficulty === d.id ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-sortie-diff="${d.id}">
            ${escapeHtml(d.label)}
          </button>
        `
          )
          .join('')}
      </div>
      <button type="button" id="btn-sortie-gen-route" class="btn-primary port-cta-btn">随机生成新航线</button>
    `;

    genCard.querySelectorAll('[data-sortie-diff]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sortieState.selectedDifficulty = btn.getAttribute('data-sortie-diff');
        renderSortieConsole();
      });
    });
    genCard.querySelector('#btn-sortie-gen-route').addEventListener('click', () => {
      const fresh = routeGenerator.generateRoute({ difficulty: sortieState.selectedDifficulty });
      sortieState.generatedRoute = fresh;
      sortieState.selectedRouteId = fresh.id;
      uiKit.showToast(`已生成「${fresh.name}」（${fresh.nodes.length} 节点 · 海况：${fresh.seaCondition.label}）`, 'ok');
      renderSortieConsole();
    });
    root.appendChild(genCard);

    // Route Selector & Pre-Sortie Validation Card
    const allRoutes = getAvailableRoutes();
    const selectedRoute = getSelectedRoute();
    const validation = validateSortieLaunch(char, selectedRoute);

    const selectCard = document.createElement('section');
    selectCard.className = 'surface-card lab-stack-sm';
    selectCard.id = 'sortie-select-panel';
    selectCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">航线列表（${allRoutes.length} 条）</h2>
      </div>
      ${
        !validation.ok
          ? `<div class="seaworthy-alert" id="sortie-launch-errors">启航条件未满足：${escapeHtml(validation.errors.join('；'))}</div>`
          : ''
      }
      <button type="button" id="btn-sortie-launch" class="btn-primary port-cta-btn" ${validation.ok ? '' : 'disabled'}>
        ${selectedRoute ? `启航出击：${escapeHtml(selectedRoute.name)}（AP -${selectedRoute.apCost}）` : '请选择航线'}
      </button>
      <div class="lab-stack-sm" id="sortie-route-list"></div>
    `;

    const listHost = selectCard.querySelector('#sortie-route-list');
    for (const rt of allRoutes) {
      const isSel = selectedRoute && rt.id === selectedRoute.id;
      const card = document.createElement('div');
      card.className = `sortie-route-card ${isSel ? 'is-selected' : ''}`;
      card.dataset.routeId = rt.id;
      card.innerHTML = `
        <div class="lab-slot-head">
          <strong>${escapeHtml(rt.name)}</strong>
          <span class="status-badge ${rt.generated ? 'badge-warn' : isSel ? 'badge-ok' : 'badge-muted'}">
            ${rt.generated ? '随机生成' : rt.builtIn ? '预设' : '自定义'} · ${rt.nodes.length} 节点
          </span>
        </div>
        <p class="muted-text" style="font-size:12px;">${escapeHtml(rt.description)}</p>
        <div data-rt-map></div>
        <div class="cc-stat-sub">
          海况：${escapeHtml(rt.seaCondition?.label || '标准')} · 最低要求 油≥${rt.minFuel} / 弹≥${rt.minAmmo} / AP≥${rt.apCost} · 单步 油${rt.stepCost.fuel}/弹${rt.stepCost.ammo}
        </div>
        <div class="lab-btn-row">
          <button type="button" class="${isSel ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-select-route="${escapeHtml(rt.id)}">
            ${isSel ? '当前已选航线' : '选择此航线'}
          </button>
          ${
            rt.generated
              ? '<button type="button" class="btn-secondary uikit-touch-target" data-save-gen-route>保存为固定航线</button>'
              : ''
          }
        </div>
      `;
      card.querySelector('[data-rt-map]').appendChild(createNodeMapElement(rt.nodes, [], -1));
      card.querySelector('[data-select-route]').addEventListener('click', () => {
        sortieState.selectedRouteId = rt.id;
        renderSortieConsole();
      });
      const saveGenBtn = card.querySelector('[data-save-gen-route]');
      if (saveGenBtn) {
        saveGenBtn.addEventListener('click', async () => {
          const saved = await routeGenerator.saveCustomRoute({
            ...deepClone(rt),
            id: `route_custom_${Date.now().toString(36)}`,
            generated: false,
          });
          sortieState.generatedRoute = null;
          sortieState.selectedRouteId = saved.id;
          uiKit.showToast(`已将「${saved.name}」保存为固定航线`, 'ok');
          renderSortieConsole();
        });
      }
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
  name: '出征战术指挥台',
  description: '程序化随机航线生成、多指令战术交战（扫描/迂回/炮击/鱼雷）、演出动效联动、大破警告与双轨战报。',

  mount(container, context) {
    sortieState.container = container;
    sortieState.context = context;

    context.ui.setPlaceholder('战地指挥记录：输入备忘将写入行动日志...');
    context.ui.setInputHandler((text) => {
      const char = getFlagship();
      context.logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        actorId: char?.id || null,
        actorName: char?.name || '',
        title: `${char ? `[${char.name}] ` : ''}战术指挥记录`,
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
        id: 'sortie-q-gen',
        label: '随机新航线',
        onClick: () => {
          if (sortieState.activeRun) {
            context.uiKit.showToast('当前出征尚未结束，返航后可生成新航线', 'warn');
            return;
          }
          const fresh = context.routeGenerator.generateRoute({ difficulty: sortieState.selectedDifficulty });
          sortieState.generatedRoute = fresh;
          sortieState.selectedRouteId = fresh.id;
          context.uiKit.showToast(`已生成：${fresh.name}`, 'ok');
          renderSortieConsole();
        },
      },
      {
        id: 'sortie-q-editor',
        label: '航线编辑器',
        onClick: () => openRouteEditorSheet(),
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
      hydrateSortieConsole({
        storage: context.rootStorage,
        routeGenerator: context.routeGenerator,
        combat: context.combat,
      }).then(() => renderSortieConsole());
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
