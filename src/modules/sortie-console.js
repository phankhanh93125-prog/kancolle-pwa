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

import {
  CORE_STAT_DEFS,
  ENEMY_STRENGTH_PRESETS,
  clampEnemyStrengthMultiplier,
  getShipClassProfile,
  getShipClassSvg,
  resolveShipClass,
} from '../core/stat-rules.js';
import { createResourceOverviewBar } from '../core/resource-manager.js';
import { NARRATIVE_MODES } from '../core/prompt-pipeline.js';
import { LOG_CATEGORIES } from '../core/log-system.js';
import {
  BRANCH_LANE_META,
  NODE_TYPES,
  NODE_TYPE_LABELS,
  SEA_DIFFICULTIES,
} from '../core/route-generator.js';
import { COMBAT_COMMANDS } from '../core/tactical-combat.js';
import { getActiveCharacterId, persistCharacterRoster } from './character-console.js';
import {
  playBattleStepChoreography,
  playOpeningChoreography,
  renderFullScreenBattleView,
} from './battle-screen.js';
import { clamp } from '../core/calc-engine.js';

const SORTIE_STORAGE_NS = 'core-sortie';
const RUN_KEY = 'active-sortie-run-v2';
const STRENGTH_MULT_KEY = 'enemy-strength-mult-v1';

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
  selectedDifficulty: 'medium',
  enemyStrengthMultiplier: 1.0,
  generatedRoute: null,
  selectedRouteId: null,
  activeRun: null,
  postBattleSettlement: null,
  autoRunning: false,
  busy: false,
  hydrated: false,
  unsubs: [],
};

function setEnemyStrengthMultiplier(val) {
  const clamped = clampEnemyStrengthMultiplier(val);
  sortieState.enemyStrengthMultiplier = clamped;
  if (sortieState.context?.rootStorage) {
    sortieState.context.rootStorage.namespace(SORTIE_STORAGE_NS).set(STRENGTH_MULT_KEY, clamped);
  }
  return clamped;
}

export async function hydrateSortieConsole({ storage, routeGenerator, combat }) {
  if (routeGenerator) {
    await routeGenerator.init();
  }
  const scope = storage.namespace(SORTIE_STORAGE_NS);
  const savedMult = scope.get(STRENGTH_MULT_KEY, 1.0);
  sortieState.enemyStrengthMultiplier = clampEnemyStrengthMultiplier(savedMult);
  const savedRun = await scope.getLarge(RUN_KEY, null);
  sortieState.activeRun = savedRun && typeof savedRun === 'object' ? deepClone(savedRun) : null;
  if (combat && sortieState.activeRun?.combatSnapshot) {
    combat.deserialize(sortieState.activeRun.combatSnapshot);
  }
  const allRoutes = routeGenerator ? routeGenerator.listAllRoutes() : [];
  sortieState.selectedRouteId = allRoutes[0]?.id || null;
  sortieState.hydrated = true;
}

export async function clearActiveSortieState({ storage, combat }) {
  sortieState.activeRun = null;
  sortieState.postBattleSettlement = null;
  sortieState.autoRunning = false;
  sortieState.busy = false;
  if (combat && typeof combat.deserialize === 'function') {
    combat.deserialize(null);
  }
  if (storage) {
    await storage.namespace(SORTIE_STORAGE_NS).removeLarge(RUN_KEY);
  }
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
  const { entities, formation, rootStorage } = sortieState.context;
  const members = formation ? formation.getMembers() : [];
  if (members.length > 0) return members[0];
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
  const { statRules, inventory, resources, formation } = sortieState.context;
  const errors = [];
  if (!route) return { ok: false, errors: ['请先生成或选择一条航线'] };

  let fleetMembers = [];
  if (formation) {
    const fVal = formation.validateFleetForSortie();
    if (!fVal.ok) errors.push(...fVal.errors);
    fleetMembers = fVal.members;
  } else if (char) {
    const sw = statRules.evaluateSeaworthiness(inventory, char.id);
    if (!sw.seaworthy) errors.push(sw.statusText);
    if (Number(char.stats.hp ?? 0) <= 0) errors.push('当前旗舰 HP 为 0，请先回港区修复');
    fleetMembers = [char];
  } else {
    errors.push('暂无可用出征角色');
  }

  const lead = fleetMembers[0] || char;
  if (resources.getBalance('fuel') < route.minFuel) {
    errors.push(`燃油不足（需 ≥ ${route.minFuel}，当前 ${resources.getBalance('fuel')}）`);
  }
  if (resources.getBalance('ammo') < route.minAmmo) {
    errors.push(`弹药不足（需 ≥ ${route.minAmmo}，当前 ${resources.getBalance('ammo')}）`);
  }
  if (lead && Number(lead.stats.ap ?? 0) < route.apCost) {
    errors.push(`旗舰行动点 AP 不足（需 ≥ ${route.apCost}，当前 ${Math.round(lead.stats.ap ?? 0)}）`);
  }
  return { ok: errors.length === 0, errors, seaworthy: errors.length === 0, fleetMembers };
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
  const { entities, formation, commander, rootStorage, combat, logs, bus, uiKit } = sortieState.context;

  if (!check.ok) {
    uiKit.showToast(`无法启航：${check.errors[0]}`, 'error');
    return;
  }

  const fleetMembers = check.fleetMembers;
  const lead = fleetMembers[0] || char;

  const heavyDamaged = fleetMembers.filter((m) => {
    const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(m.id, 'maxHp', { round: 'round' }).final));
    return Number(m.stats.hp ?? effMaxHp) / effMaxHp < 0.25;
  });
  if (heavyDamaged.length > 0) {
    const proceed = await uiKit.confirmDialog({
      title: '编队大破状态启航警告',
      message: `编队中「${heavyDamaged.map((m) => m.name).join('、')}」当前耐久低于 25%，处于大破状态。建议先回港区入渠修复，确定仍要强行启航吗？`,
      confirmLabel: '强行启航',
      cancelLabel: '取消',
      tone: 'danger',
    });
    if (!proceed) return;
  }

  if (route.apCost > 0) {
    for (const m of fleetMembers) {
      entities.adjustStat(m.id, 'ap', -route.apCost, { min: 0, max: Number(m.stats.maxAp ?? 100) });
    }
    await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: lead.id });
  }

  const activeFormation = formation ? formation.getActiveFormation() : { id: 'line_ahead', name: '单纵阵' };
  const dispatchDisc = commander ? commander.getSortieStepDiscount() : 0;
  const fleetMemberIds = fleetMembers.map((m) => m.id);
  const staggered = formation
    ? formation.computeStaggeredStepCost(fleetMemberIds)
    : {
        fuel: Math.max(5, Math.round((Number(route.stepCost?.fuel) || 20) * (1 - dispatchDisc))),
        ammo: Math.max(5, Math.round((Number(route.stepCost?.ammo) || 18) * (1 - dispatchDisc))),
        breakdown: [],
      };
  const effStepCost = {
    fuel: staggered.fuel,
    ammo: staggered.ammo,
    breakdown: staggered.breakdown || [],
  };

  combat.clearSession();
  sortieState.postBattleSettlement = null;
  sortieState.autoRunning = false;
  sortieState.activeRun = {
    routeId: route.id,
    routeName: route.name,
    difficulty: route.difficulty || sortieState.selectedDifficulty || 'low',
    difficultyLabel: route.difficultyLabel || '标准海域',
    enemyStrengthMultiplier: sortieState.enemyStrengthMultiplier || 1.0,
    hasBranches: Boolean(route.hasBranches),
    seaCondition: route.seaCondition ? deepClone(route.seaCondition) : null,
    characterId: lead.id,
    characterName: lead.name,
    fleetMemberIds,
    formationId: activeFormation.id,
    formationName: activeFormation.name,
    stepCost: effStepCost,
    nodes: deepClone(route.nodes),
    nextNodeIndex: 0,
    clearedIndices: [],
    awaitingBranchChoices: null,
    pendingAnchorage: null,
    loot: { fuel: 0, ammo: 0, steel: 0, bauxite: 0, silver: 0, gold: 0 },
    reports: [],
    completed: false,
    combatSnapshot: null,
    startedAt: Date.now(),
  };

  await persistActiveRun();
  logs.add({
    category: LOG_CATEGORIES.SYSTEM,
    actorId: lead.id,
    actorName: lead.name,
    title: `[${lead.name} 等 ${fleetMembers.length} 舰] 启航出征「${route.name}」`,
    detail: `阵型：${activeFormation.name} · 阶梯单步消耗 油${effStepCost.fuel}/弹${effStepCost.ammo} · AP -${route.apCost} · 海况：${route.seaCondition?.label || '标准'} · 共 ${route.nodes.length} 节点`,
  });
  bus.emit('sortie:launched', { routeId: route.id, characterId: lead.id, fleetSize: fleetMembers.length });
  uiKit.showToast(`编队（${fleetMembers.length}舰 · ${activeFormation.name}）已启航！单步 油${effStepCost.fuel}/弹${effStepCost.ammo}`, 'ok');
  await renderSortieConsole();
}

function resolveNextStepAfterNode(run, clearedIdx) {
  if (!run || !Array.isArray(run.nodes)) return;
  if (!run.clearedIndices.includes(clearedIdx)) {
    run.clearedIndices.push(clearedIdx);
  }
  const node = run.nodes[clearedIdx];
  const nextCodes = Array.isArray(node?.nextCodes) ? node.nextCodes.filter(Boolean) : [];

  if (nextCodes.length >= 2) {
    // Fork decision point! Present branching lane choices on the sea chart.
    run.awaitingBranchChoices = Array.isArray(node.branchChoices) && node.branchChoices.length >= 2
      ? deepClone(node.branchChoices)
      : nextCodes.map((code) => {
          const target = run.nodes.find((n) => n.code === code);
          const lane = target?.lane || 'main';
          return {
            targetCode: code,
            lane,
            label: BRANCH_LANE_META[lane]?.label || `航道 ${code}`,
            desc: BRANCH_LANE_META[lane]?.desc || `前往节点 ${code}`,
            badge: lane === 'assault' ? '高危高回报' : '隐蔽/反潜',
          };
        });
    run.nextNodeIndex = clearedIdx;
    return;
  }

  run.awaitingBranchChoices = null;
  if (nextCodes.length === 1) {
    const nextIdx = run.nodes.findIndex((n) => n.code === nextCodes[0]);
    if (nextIdx >= 0) {
      run.nextNodeIndex = nextIdx;
      return;
    }
  }

  // Fallback for legacy linear routes or final node
  if (node?.type === NODE_TYPES.BOSS || clearedIdx + 1 >= run.nodes.length || nextCodes.length === 0 && run.hasBranches) {
    run.completed = true;
    run.nextNodeIndex = run.nodes.length;
  } else {
    run.nextNodeIndex = clearedIdx + 1;
    if (run.nextNodeIndex >= run.nodes.length) run.completed = true;
  }
}

async function chooseBranchPath(targetCode) {
  const run = sortieState.activeRun;
  if (!run || !Array.isArray(run.awaitingBranchChoices)) return;
  const idx = run.nodes.findIndex((n) => n.code === targetCode);
  if (idx < 0) return;
  const chosen = run.awaitingBranchChoices.find((c) => c.targetCode === targetCode);
  run.awaitingBranchChoices = null;
  run.chosenLane = chosen?.lane || run.nodes[idx]?.lane || 'main';
  run.nextNodeIndex = idx;
  run.nodes[idx].intelRevealed = true;
  await persistActiveRun();
  sortieState.context?.uiKit?.showToast(
    `已抉择进入【${chosen?.label || targetCode}】（下一节点 ${targetCode}）`,
    'ok'
  );
  await renderSortieConsole();
}

async function resolveAnchorageAction(doRest = true) {
  const run = sortieState.activeRun;
  if (!run || !run.pendingAnchorage) return;
  const { entities, resources, rootStorage, logs, bus, uiKit } = sortieState.context;
  const nodeIdx = run.pendingAnchorage.nodeIndex;
  const node = run.nodes[nodeIdx];
  const cfg = node?.anchorageConfig || { cost: { fuel: 22, steel: 18, silver: 20 }, healPct: 0.35, moraleGain: 20 };

  const memberIds =
    Array.isArray(run.fleetMemberIds) && run.fleetMemberIds.length > 0 ? run.fleetMemberIds : [run.characterId];
  const fleetMembers = memberIds.map((id) => entities.get(id)).filter(Boolean);
  const char = fleetMembers[0] || getFlagship();

  if (doRest) {
    const spend = await resources.spendBatch(cfg.cost, { reason: `临时锚地整备休整（${node.code}）` });
    if (!spend.ok) {
      uiKit.showToast(`资源不足无法锚地补给：${spend.reason}`, 'warn');
      return;
    }
    let totalHeal = 0;
    for (const m of fleetMembers) {
      const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(m.id, 'maxHp', { round: 'round' }).final));
      const curHp = Math.round(Number(m.stats.hp ?? effMaxHp));
      const healAmt = Math.max(10, Math.round(effMaxHp * (cfg.healPct || 0.35)));
      if (curHp < effMaxHp) {
        entities.adjustStat(m.id, 'hp', healAmt, { min: 0, max: effMaxHp });
        totalHeal += Math.min(healAmt, effMaxHp - curHp);
      }
      entities.adjustStat(m.id, 'morale', cfg.moraleGain || 20, { min: 0, max: 100 });
    }
    if (char) {
      await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
    }
    run.reports.unshift({
      id: `anc_${Date.now()}`,
      nodeCode: node.code,
      nodeName: node.name,
      nodeType: '临时锚地休整',
      text: `舰队在「${node.name}」抛锚应急整备：全队恢复耐久 +${totalHeal}、士气 +${cfg.moraleGain || 20}。`,
      chips: [{ text: `耐久 +${totalHeal}` }, { text: `士气 +${cfg.moraleGain || 20}` }],
      timestamp: Date.now(),
    });
    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char?.id || null,
      actorName: char?.name || '',
      title: `[临时锚地] ${node.name} 应急休整完成`,
      detail: `恢复耐久 +${totalHeal} · 士气 +${cfg.moraleGain || 20}`,
    });
    uiKit.showToast(`锚地休整完成！全队耐久 +${totalHeal} · 士气 +${cfg.moraleGain || 20}`, 'ok');
  } else {
    run.reports.unshift({
      id: `anc_skip_${Date.now()}`,
      nodeCode: node.code,
      nodeName: node.name,
      nodeType: '临时锚地通过',
      text: `舰队保持静默航速掠过「${node.name}」，未消耗额外物资。`,
      chips: [{ text: '免消耗通过' }],
      timestamp: Date.now(),
    });
    uiKit.showToast(`已掠过临时锚地 ${node.code}`, 'info');
  }

  run.pendingAnchorage = null;
  resolveNextStepAfterNode(run, nodeIdx);
  await persistActiveRun();
  bus.emit('sortie:node-resolved', { routeId: run.routeId, nodeCode: node.code, completed: run.completed });
  await renderSortieConsole();
}

async function advanceNextNode() {
  if (sortieState.busy || !sortieState.activeRun) return;
  const run = sortieState.activeRun;
  const {
    entities,
    statRules,
    resources,
    narrative,
    turnStepper,
    combat,
    formation,
    commander,
    rootStorage,
    logs,
    bus,
    uiKit,
  } = sortieState.context;

  if (combat.isActive() || run.completed || run.awaitingBranchChoices || run.pendingAnchorage || run.nextNodeIndex >= run.nodes.length) {
    return;
  }

  const memberIds =
    Array.isArray(run.fleetMemberIds) && run.fleetMemberIds.length > 0 ? run.fleetMemberIds : [run.characterId];
  const fleetMembers = memberIds.map((id) => entities.get(id)).filter(Boolean);
  const char = fleetMembers[0] || getFlagship();
  if (!char) return;

  const aliveMembers = fleetMembers.filter((m) => Number(m.stats.hp ?? 0) > 0);
  if (aliveMembers.length === 0) {
    uiKit.showToast('编队全员耐久归零，请立即返航回港区修复', 'error');
    return;
  }

  const heavyDamaged = aliveMembers.filter((m) => {
    const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(m.id, 'maxHp', { round: 'round' }).final));
    return Number(m.stats.hp ?? effMaxHp) / effMaxHp < 0.25;
  });
  if (heavyDamaged.length > 0) {
    const confirmed = await uiKit.confirmDialog({
      title: '大破强行进击风险警告',
      message: `警告：「${heavyDamaged.map((m) => m.name).join('、')}」耐久低于 25% 大破线！强行进击风险极高，建议立即返航回港区。确定继续前进吗？`,
      confirmLabel: '强行继续前进',
      cancelLabel: '取消并返航',
      tone: 'danger',
    });
    if (!confirmed) return;
  }

  const nodeIdx = run.nextNodeIndex;
  const node = run.nodes[nodeIdx];
  node.intelRevealed = true;

  // Deduct single-step fuel & ammo (stealth lane saves 15% fuel)
  const stealthDisc = node.lane === 'stealth' ? 0.85 : 1.0;
  const stepCost = {
    fuel: Math.max(0, Math.round((Number(run.stepCost?.fuel) || 0) * stealthDisc)),
    ammo: Math.max(0, Number(run.stepCost?.ammo) || 0),
  };
  const spend = await resources.spendBatch(stepCost, { reason: `出征推进 ${run.routeName} (${node.code})` });
  if (!spend.ok) {
    uiKit.showToast(`油弹不足，无法继续推进：${spend.reason}`, 'error');
    return;
  }

  turnStepper.advance({ steps: 1, reason: `sortie-node-${node.code}` });

  // Branch A: Temporary Anchorage Node -> Present Rest/Skip choice on Sea Chart!
  if (node.type === NODE_TYPES.ANCHORAGE) {
    run.pendingAnchorage = { nodeIndex: nodeIdx, code: node.code, name: node.name };
    await persistActiveRun();
    uiKit.showToast(`抵达临时锚地「${node.name}」，可消耗少量物资休整`, 'ok');
    await renderSortieConsole();
    return;
  }

  // Branch B: Combat Node (encounter / elite / boss) -> Launch Independent Full-Screen Tactical Battle Screen!
  if (isCombatNodeType(node.type)) {
    sortieState.postBattleSettlement = null;
    sortieState.autoRunning = false;
    const nodeDepthRatio =
      node.depthRatio !== undefined
        ? Number(node.depthRatio)
        : Number((nodeIdx / Math.max(1, (run.nodes?.length || 1) - 1)).toFixed(2));
    const startedSession = combat.startEncounter({
      characterId: char.id,
      fleetMemberIds: memberIds,
      formationId: run.formationId,
      node,
      seaCondition: run.seaCondition,
      difficulty: run.difficulty || node.difficulty || 'low',
      nodeDepthRatio,
      strengthMultiplier: run.enemyStrengthMultiplier || sortieState.enemyStrengthMultiplier || 1.0,
    });

    // Record opening events (Recon/Ambush, Opening Airstrike, Opening Torpedo) into sortie timeline
    for (const oe of startedSession.openingEvents || []) {
      run.reports.unshift({
        id: `opn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        nodeCode: node.code,
        nodeName: `${node.name} · ${oe.title}`,
        nodeType: oe.kind,
        text: oe.text,
        source: 'local',
        degraded: false,
        chips: [
          ...(oe.damageDealt > 0 ? [{ text: `开幕伤敌 ${oe.damageDealt}` }] : []),
          ...(oe.damageTaken > 0 ? [{ text: `我方受损 ${oe.damageTaken}`, negative: true }] : []),
        ],
        timestamp: Date.now(),
      });
    }

    await persistActiveRun();
    uiKit.showToast(
      startedSession.reconStatus === 'ambushed'
        ? `⚠ 节点 ${node.code} 遭遇敌方先制伏击！（敌 ${startedSession.enemies.length} 舰）`
        : `节点 ${node.code} 遇敌：${node.name}（敌 ${startedSession.enemies.length} 舰）`,
      startedSession.reconStatus === 'ambushed' ? 'error' : 'warn'
    );
    await renderSortieConsole();

    // Play Opening Phase SVG Choreography (Recon/Ambush -> Opening Airstrike -> Opening Torpedo)
    const stageRoot = sortieState.container?.querySelector('#battle-fullscreen-stage');
    if (stageRoot && Array.isArray(startedSession.openingEvents) && startedSession.openingEvents.length > 0) {
      sortieState.busy = true;
      try {
        await playOpeningChoreography(stageRoot, {
          openingEvents: startedSession.openingEvents,
          fxStage: sortieState.context.fxStage,
        });
        combat.markOpeningPlayed();
      } finally {
        sortieState.busy = false;
      }
    }

    const latestSess = combat.getSession();
    if (latestSess && (latestSess.status === 'victory' || latestSess.status === 'defeated')) {
      await finalizeBattleOutcome(latestSess);
      await renderSortieConsole();
      return;
    }

    // If high-speed enemies won initiative ahead of our first ally, execute their turns with SVG animation!
    await drainPendingEnemyTurnsWithChoreography();
    return;
  }

  // Branch C: Non-combat Resource / Weather-Recon Node -> Auto Salvage & Settlement
  sortieState.busy = true;
  await renderSortieConsole();
  try {
    const fleetSum = formation
      ? formation.computeFleetSummary(memberIds, run.formationId)
      : null;
    const statKey = node.statKey || 'recon';
    const baseVal = fleetSum
      ? Math.round((fleetSum.totals?.[statKey] || fleetSum.totals?.recon || 50) / Math.max(1, fleetSum.aliveCount))
      : Number(char.stats[statKey] ?? 50);
    const effVal = fleetSum
      ? Number(fleetSum.checkRatings?.[statKey] ?? fleetSum.checkRatings?.recon ?? baseVal)
      : entities.getEffectiveStat(char.id, statKey, { round: 'round' }).final;
    const eqCheckBonus = fleetSum ? fleetSum.avgCheckBonus : 0;
    const avgMorale = fleetSum ? fleetSum.avgMorale : Number(char.stats.morale ?? 60);
    const seaBonus = run.seaCondition?.mods?.checkBonus || 0;
    const cmdLuck = commander ? commander.getLuck() : 0;
    const luckDropBonus = commander ? commander.getLuckEffects().rareDropBonus : 0;

    const checkResult = statRules.performCheck({
      actorId: char.id,
      actorName: fleetMembers.length > 1 ? `${char.name}等${fleetMembers.length}舰` : char.name,
      statKey,
      baseStatValue: baseVal,
      effectiveStatValue: effVal,
      equipmentCheckBonus: eqCheckBonus,
      moraleValue: avgMorale,
      dc: Number(node.dc) || 12,
      extraModifier: seaBonus,
      commanderLuck: cmdLuck,
    });

    const isSuccess = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
    const dropMult = typeof resources.getDropMultiplier === 'function' ? resources.getDropMultiplier() : 1.0;
    const mult =
      (checkResult.outcome === 'crit-success' ? 1.45 : isSuccess ? 1.0 : 0.5) *
      dropMult *
      (1 + Math.max(-0.2, luckDropBonus));
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

    // High-probability equipment / outfit crate drop on resource salvage nodes
    const { inventory } = sortieState.context;
    const salvageCrateChance = Math.min(0.92, (node.type === NODE_TYPES.RESOURCE ? 0.42 : 0.25) * dropMult);
    if (isSuccess && inventory && typeof inventory.rollLootDropItem === 'function' && Math.random() < salvageCrateChance) {
      const dropped = await inventory.rollLootDropItem({
        tier: 'resource',
        difficulty: run.difficulty || node.difficulty || 'low',
        dropMultiplier: dropMult,
      });
      if (dropped) {
        chips.push({ text: `打捞装备箱：${dropped.name}`, negative: false });
      }
    }

    const affMult = commander ? commander.getAffinityGainMultiplier() : 1.0;
    if (isSuccess) {
      const aff = Math.max(1, Math.round((Number(node.affinityGain) || 2) * affMult));
      for (const m of aliveMembers) {
        entities.adjustStat(m.id, 'affinity', aff, { min: 0, max: 100 });
        entities.adjustStat(m.id, 'morale', 3, { min: 0, max: 100 });
      }
      chips.push({ text: `全队好感 +${aff}`, negative: false });
    } else if (node.type === NODE_TYPES.WEATHER) {
      const dmg = Math.max(4, Number(node.failDamage?.hp) || 6);
      const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(char.id, 'maxHp', { round: 'round' }).final));
      entities.adjustStat(char.id, 'hp', -dmg, { min: 0, max: effMaxHp });
      chips.push({ text: `海况损耗 ${char.name} HP -${dmg}`, negative: true });
    }

    if (commander) {
      const expGain = 15;
      await commander.grantExp(expGain, `出征节点 ${node.code}`);
      chips.push({ text: `指挥官 EXP +${expGain}`, negative: false });
    }

    if (statRules && typeof statRules.grantShipExp === 'function') {
      const shipNodeExp = 25;
      let anyShipExp = false;
      for (const m of aliveMembers) {
        const sr = statRules.grantShipExp(entities, m.id, shipNodeExp, {
          reason: `出征推进节点 ${node.code}`,
          inventory: sortieState.context.inventory,
        });
        if (sr) {
          anyShipExp = true;
          if (sr.leveledUp) {
            chips.push({ text: `★ ${sr.characterName} 升至 Lv.${sr.afterLevel}`, negative: false });
          }
        }
      }
      if (anyShipExp) {
        chips.push({ text: `编队舰娘 EXP +${shipNodeExp}`, negative: false });
      }
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
        actor: { name: fleetMembers.length > 1 ? `${char.name}率领的${fleetMembers.length}舰编队` : char.name },
        lootText,
        check: checkResult,
      },
      polishInstruction: `请简短润色节点 ${node.code} 的打捞/气象侦察战报，保留全部客观数字：`,
    });

    resolveNextStepAfterNode(run, nodeIdx);

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
      title: `[${char.name}等] 节点 ${node.code}·${node.name}（${NODE_TYPE_LABELS[node.type] || node.type}）`,
      detail: `收获：${lootText}`,
    });
    bus.emit('sortie:node-resolved', { routeId: run.routeId, nodeCode: node.code, completed: run.completed });
    uiKit.showToast(`节点 ${node.code} 打捞完成：${lootText}`, 'ok');
  } finally {
    sortieState.busy = false;
    await renderSortieConsole();
  }
}

// ============================================================
// Pure-SVG Tactical Battlefield Trajectory & Emblem Helpers
// ============================================================

function buildEnemyEmblemSvg(tier = 'encounter') {
  const isBoss = tier === NODE_TYPES.BOSS;
  const isElite = tier === NODE_TYPES.ELITE;
  const stroke = isBoss ? '#fb7185' : isElite ? '#f59e0b' : '#f87171';
  return `<svg class="bf-emblem-svg" width="38" height="38" viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <polygon points="20,3 36,14 31,35 9,35 4,14" stroke="${stroke}" stroke-width="2" fill="rgba(248,113,113,0.14)"/>
    <circle cx="20" cy="20" r="${isBoss ? 8 : 6}" stroke="${stroke}" stroke-width="1.8"/>
    <path d="M20 7V12M20 28V33M7 20H12M28 20H33" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round"/>
    ${isBoss ? '<circle cx="20" cy="20" r="2.5" fill="#fb7185"/>' : ''}
  </svg>`;
}

function buildBattleSvgMarkup(style) {
  if (style === 'airstrike') {
    return `
      <g class="bf-fx-group bf-fx-airstrike" data-fx-kind="airstrike">
        <path class="bf-arc-path" d="M70,126 Q130,68 175,24" stroke="#f59e0b" stroke-width="2.6" fill="none" stroke-linecap="round"/>
        <path class="bf-arc-path" d="M180,128 Q182,72 180,22" stroke="#c084fc" stroke-width="3" fill="none" stroke-linecap="round"/>
        <path class="bf-arc-path" d="M290,126 Q230,68 185,24" stroke="#f59e0b" stroke-width="2.6" fill="none" stroke-linecap="round"/>
        <polygon class="bf-plane-icon" points="180,38 171,56 180,51 189,56" fill="#fde68a" stroke="#a855f7" stroke-width="1.4"/>
        <polygon class="bf-plane-icon" points="132,56 125,70 132,66 139,70" fill="#fde68a" stroke="#f59e0b" stroke-width="1.2"/>
        <polygon class="bf-plane-icon" points="228,56 221,70 228,66 235,70" fill="#fde68a" stroke="#f59e0b" stroke-width="1.2"/>
        <circle class="bf-impact-ring" cx="180" cy="24" r="14" stroke="#c084fc" stroke-width="2.4" fill="rgba(192,132,252,0.18)"/>
        <circle class="bf-impact-ring" cx="180" cy="24" r="26" stroke="#f59e0b" stroke-width="1.6" fill="none"/>
      </g>
    `;
  }
  if (style === 'torpedo') {
    return `
      <g class="bf-fx-group bf-fx-torpedo" data-fx-kind="torpedo">
        <path class="bf-torp-path" d="M105,126 L158,24" stroke="#22d3ee" stroke-width="3" stroke-dasharray="9 6" fill="none" stroke-linecap="round"/>
        <path class="bf-torp-path" d="M180,128 L180,20" stroke="#38bdf8" stroke-width="3.4" stroke-dasharray="10 6" fill="none" stroke-linecap="round"/>
        <path class="bf-torp-path" d="M255,126 L202,24" stroke="#22d3ee" stroke-width="3" stroke-dasharray="9 6" fill="none" stroke-linecap="round"/>
        <circle class="bf-torp-ripple" cx="180" cy="22" r="12" stroke="#38bdf8" stroke-width="2.2" fill="rgba(56,189,248,0.2)"/>
        <circle class="bf-torp-ripple" cx="180" cy="22" r="28" stroke="#22d3ee" stroke-width="1.5" fill="none"/>
      </g>
    `;
  }
  if (style === 'scan') {
    return `
      <g class="bf-fx-group bf-fx-scan" data-fx-kind="scan">
        <path class="bf-sonar-fan" d="M180,124 L86,20 A142,142 0 0,1 274,20 Z" fill="rgba(16,185,129,0.18)" stroke="#10b981" stroke-width="1.6"/>
        <circle class="bf-impact-ring" cx="180" cy="28" r="16" stroke="#34d399" stroke-width="2" fill="none" stroke-dasharray="4 3"/>
        <circle class="bf-impact-ring" cx="180" cy="28" r="30" stroke="#10b981" stroke-width="1.4" fill="none"/>
        <path d="M156,28 H204 M180,6 V50" stroke="#34d399" stroke-width="1.5" stroke-dasharray="3 3"/>
      </g>
    `;
  }
  if (style === 'evade') {
    return `
      <g class="bf-fx-group bf-fx-evade" data-fx-kind="evade">
        <path class="bf-speed-line" d="M40,98 Q180,76 320,98" stroke="#3b82f6" stroke-width="2.4" fill="none" stroke-linecap="round"/>
        <path class="bf-speed-line" d="M62,114 Q180,92 298,114" stroke="#60a5fa" stroke-width="2.2" fill="none" stroke-linecap="round"/>
        <polygon class="bf-shield-hex" points="180,58 214,76 214,112 180,130 146,112 146,76" fill="rgba(59,130,246,0.18)" stroke="#60a5fa" stroke-width="2.4"/>
      </g>
    `;
  }
  if (style === 'enemy-counter') {
    return `
      <g class="bf-fx-group bf-fx-counter" data-fx-kind="enemy-counter">
        <path class="bf-arc-path" d="M140,18 Q162,72 176,124" stroke="#ef4444" stroke-width="3" fill="none" stroke-linecap="round"/>
        <path class="bf-arc-path" d="M220,18 Q198,72 184,124" stroke="#fb7185" stroke-width="3" fill="none" stroke-linecap="round"/>
        <circle class="bf-impact-ring" cx="180" cy="122" r="16" stroke="#ef4444" stroke-width="2.4" fill="rgba(239,68,68,0.22)"/>
      </g>
    `;
  }
  // Default: shelling orange-red ballistic arcs
  return `
    <g class="bf-fx-group bf-fx-shelling" data-fx-kind="shelling">
      <path class="bf-arc-path" d="M88,126 Q116,56 176,22" stroke="#f97316" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path class="bf-arc-path" d="M180,128 Q180,68 180,18" stroke="#fb923c" stroke-width="3.4" fill="none" stroke-linecap="round"/>
      <path class="bf-arc-path" d="M272,126 Q244,56 184,22" stroke="#ef4444" stroke-width="3" fill="none" stroke-linecap="round"/>
      <circle class="bf-impact-ring" cx="180" cy="22" r="14" stroke="#fb923c" stroke-width="2.5" fill="rgba(249,115,22,0.25)"/>
      <circle class="bf-impact-ring" cx="180" cy="22" r="28" stroke="#ef4444" stroke-width="1.6" fill="none"/>
    </g>
  `;
}

async function playCombatChoreography(turnEntry, session) {
  const { fxStage } = sortieState.context || {};
  const wait = (ms) =>
    fxStage && typeof fxStage.wait === 'function'
      ? fxStage.wait(ms)
      : new Promise((r) => setTimeout(r, ms));

  const stageEl = sortieState.container?.querySelector('#sortie-battlefield');
  if (!stageEl) return;

  const playerCard = stageEl.querySelector('#bf-player-card');
  const enemyCard = stageEl.querySelector('#bf-enemy-card');
  const svgCanvas = stageEl.querySelector('#bf-svg-canvas');
  const bannerEl = stageEl.querySelector('#bf-banner');
  const calloutEl = stageEl.querySelector('#bf-callout');

  const clearCardStates = () => {
    playerCard?.classList.remove('is-acting', 'is-hit', 'is-shielded');
    enemyCard?.classList.remove('is-acting', 'is-hit', 'is-intel-flip');
  };

  // Stage 1 (400ms @ 1x): Acting unit card glow + Command Banner
  clearCardStates();
  playerCard?.classList.add('is-acting');
  if (bannerEl) {
    bannerEl.textContent = `${turnEntry.actorName || '舰队'} · 发动【${turnEntry.commandLabel}】`;
    bannerEl.className = `bf-banner is-visible is-${turnEntry.visualStyle || 'shelling'}`;
  }
  await wait(400);

  // Stage 2 (600ms @ 1x): Center pure-SVG trajectory animation
  if (svgCanvas) {
    svgCanvas.dataset.activeFx = turnEntry.visualStyle || 'shelling';
    svgCanvas.innerHTML = buildBattleSvgMarkup(turnEntry.visualStyle || 'shelling');
  }
  await wait(600);

  // Stage 3 (400ms @ 1x): Impact shake / red flash / intel flip / evade shield
  if (turnEntry.damageDealt > 0) {
    enemyCard?.classList.add('is-hit');
    if (fxStage && typeof fxStage.playEffect === 'function') {
      fxStage.playEffect('shake', { intensity: turnEntry.isCrit ? 'heavy' : 'light' });
    }
    const enemyHpFill = stageEl.querySelector('#bf-enemy-hp-bar .progress-fill');
    const enemyHpText = stageEl.querySelector('#bf-enemy-hp-bar .progress-meta-sub');
    if (enemyHpFill && turnEntry.enemyMaxHp > 0) {
      const pct = Math.max(0, Math.min(100, (turnEntry.enemyHpAfter / turnEntry.enemyMaxHp) * 100));
      enemyHpFill.style.width = `${pct.toFixed(1)}%`;
    }
    if (enemyHpText && session?.enemy?.scanned) {
      enemyHpText.textContent = `${turnEntry.enemyHpAfter} / ${turnEntry.enemyMaxHp}`;
    }
  } else if (turnEntry.scannedNow) {
    enemyCard?.classList.add('is-intel-flip');
  } else if (turnEntry.visualStyle === 'evade') {
    playerCard?.classList.add('is-shielded');
  }
  await wait(400);

  // Stage 4 (1000ms @ 1x): Persistent large callout & optional enemy counterattack
  if (calloutEl) {
    const calloutText =
      turnEntry.damageDealt > 0
        ? `${turnEntry.isCrit ? '★ 暴击 ' : ''}-${turnEntry.damageDealt}${turnEntry.followUpBy ? ` (+${turnEntry.followUpBy}追击)` : ''}`
        : turnEntry.outcomeTag;
    calloutEl.textContent = calloutText;
    calloutEl.className = `bf-callout is-visible ${
      turnEntry.isCrit
        ? 'is-crit'
        : turnEntry.damageDealt > 0
        ? 'is-dmg'
        : turnEntry.scannedNow
        ? 'is-scan'
        : 'is-info'
    }`;
  }

  if (turnEntry.damageTaken > 0) {
    await wait(450);
    clearCardStates();
    enemyCard?.classList.add('is-acting');
    if (bannerEl) {
      bannerEl.textContent = `${session?.enemy?.name || '敌舰'} · 发起反击${turnEntry.guardedBy ? `（${turnEntry.guardedBy}掩护）` : ''}`;
      bannerEl.className = 'bf-banner is-visible is-counter';
    }
    if (svgCanvas) {
      svgCanvas.dataset.activeFx = 'enemy-counter';
      svgCanvas.innerHTML = buildBattleSvgMarkup('enemy-counter');
    }
    await wait(300);
    playerCard?.classList.add('is-hit');
    if (calloutEl) {
      calloutEl.textContent = `我方受击 -${turnEntry.damageTaken} HP`;
      calloutEl.className = 'bf-callout is-visible is-counter';
    }
    await wait(450);
  } else {
    await wait(800);
  }
}

async function finalizeBattleOutcome(session) {
  const run = sortieState.activeRun;
  if (!run || !session) return;
  const { combat, entities, resources, statRules, commander, rootStorage, logs, bus, uiKit } = sortieState.context;
  const nodeIdx = run.nextNodeIndex;
  const node = run.nodes[nodeIdx];
  const memberIds =
    Array.isArray(run.fleetMemberIds) && run.fleetMemberIds.length > 0 ? run.fleetMemberIds : [run.characterId];
  const fleetMembers = memberIds.map((id) => entities.get(id)).filter(Boolean);
  const char = fleetMembers[0] || getFlagship();

  if (session.status === 'victory' || session.status === 'bypassed' || session.status === 'day_ended') {
    const gained = {};
    const luckDropBonus = commander ? commander.getLuckEffects().rareDropBonus : 0;
    const affMult = commander ? commander.getAffinityGainMultiplier() : 1.0;
    const rewardFactor = session.status === 'victory' ? 1.0 : session.status === 'day_ended' ? 0.55 : 0;

    const lootBonus = Math.max(0.8, Number(session.lootBonus) || 1.0);
    const dropMult = typeof resources.getDropMultiplier === 'function' ? resources.getDropMultiplier() : 1.0;
    const droppedItems = [];
    if (rewardFactor > 0) {
      for (const [rk, rawVal] of Object.entries(node.loot || {})) {
        const val = Math.round((Number(rawVal) || 0) * rewardFactor * lootBonus * (1 + Math.max(-0.2, luckDropBonus)));
        if (val <= 0) continue;
        await resources.add(rk, val, { reason: `节点 ${node.code}·${node.name} 战利品` });
        run.loot[rk] = (run.loot[rk] || 0) + val;
        gained[rk] = val;
      }

      // High-rarity equipment & outfit crate drops on combat victory!
      const { inventory } = sortieState.context;
      if (session.status === 'victory' && inventory && typeof inventory.rollLootDropItem === 'function') {
        const tierKey =
          node.type === NODE_TYPES.BOSS ? 'boss' : node.type === NODE_TYPES.ELITE ? 'elite' : 'encounter';
        const baseChance = tierKey === 'boss' || tierKey === 'elite' ? 1.0 : Math.min(1.0, 0.7 * dropMult);
        if (Math.random() < baseChance) {
          const item1 = await inventory.rollLootDropItem({
            tier: tierKey,
            difficulty: run.difficulty || node.difficulty || 'low',
            dropMultiplier: dropMult,
          });
          if (item1) droppedItems.push(item1);
        }
        // Bonus 2nd crate on BOSS or high dropMultiplier elite victories!
        const bonusChance = tierKey === 'boss' ? Math.min(0.95, 0.55 * dropMult) : tierKey === 'elite' ? Math.min(0.8, 0.25 * dropMult) : 0;
        if (bonusChance > 0 && Math.random() < bonusChance) {
          const item2 = await inventory.rollLootDropItem({
            tier: tierKey,
            difficulty: run.difficulty || node.difficulty || 'low',
            dropMultiplier: dropMult,
          });
          if (item2) droppedItems.push(item2);
        }
      }

      const aff = Math.max(1, Math.round((Number(node.affinityGain) || 3) * affMult));
      const shipExp = node.type === NODE_TYPES.BOSS ? 65 : node.type === NODE_TYPES.ELITE ? 45 : 28;
      for (const m of fleetMembers) {
        entities.adjustStat(m.id, 'affinity', aff, { min: 0, max: 100 });
        entities.adjustStat(m.id, 'morale', session.status === 'victory' ? 4 : 1, { min: 0, max: 100 });
        if (statRules && typeof statRules.grantShipExp === 'function') {
          statRules.grantShipExp(entities, m.id, Math.round(shipExp * rewardFactor * lootBonus), {
            reason: `节点 ${node.code}·${node.name} 战斗结算`,
          });
        }
      }
    }

    if (commander) {
      const expGain = Math.round((node.type === NODE_TYPES.BOSS ? 45 : node.type === NODE_TYPES.ELITE ? 30 : 20) * lootBonus);
      await commander.grantExp(expGain, `节点 ${node.code} 结算`);
    }

    resolveNextStepAfterNode(run, nodeIdx);
    const lootText = formatLootSummary(gained, resources);
    const dropCrateText =
      droppedItems.length > 0 ? ` · 缴获装备/服装：${droppedItems.map((d) => d.name).join('、')}` : '';

    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char?.id || null,
      actorName: char?.name || '',
      title: `[${char?.name || ''}等] 节点 ${node.code}·${node.name} ${
        session.status === 'victory' ? '交战胜利' : session.status === 'day_ended' ? '昼战收兵' : '迂回通过'
      }`,
      detail: rewardFactor > 0 ? `战利品：${lootText}${dropCrateText}` : '全队无伤绕过敌方封锁',
    });
    bus.emit('sortie:node-resolved', {
      routeId: run.routeId,
      nodeCode: node.code,
      status: session.status,
      completed: run.completed,
    });

    sortieState.postBattleSettlement = {
      sessionSnapshot: deepClone(session),
      headline:
        session.status === 'victory'
          ? `节点 ${node.code} 战斗大捷！`
          : session.status === 'day_ended'
          ? `节点 ${node.code} 昼战收兵`
          : `节点 ${node.code} 成功迂回脱离`,
      badge: session.status === 'victory' ? '胜利结算' : session.status === 'day_ended' ? '部分战果' : '无伤脱离',
      tone: session.status === 'victory' ? 'ok' : 'warn',
      summary:
        rewardFactor > 0
          ? `获得战利品：${lootText}${dropCrateText}。${run.completed ? '已击破本海域全部目标，可凯旋返航！' : '可返回分岔海图继续推进或直达船坞整备。'}`
          : '全队保持完整耐久绕过封锁，可继续推进海图。',
      continueLabel: run.completed ? '返回海图并凯旋返航' : '继续分岔雷达海图航行',
    };

    uiKit.showToast(
      session.status === 'victory' ? `战斗胜利！${lootText}${dropCrateText}` : `节点 ${node.code} 战斗已结算`,
      'ok'
    );
  } else if (session.status === 'defeated') {
    sortieState.postBattleSettlement = {
      sessionSnapshot: deepClone(session),
      headline: '编队失利 · 紧急脱离',
      badge: '急需入渠',
      tone: 'danger',
      summary: '编队全员耐久耗尽，建议立即前往「船坞整备」或执行「一键补给全队」恢复战力。',
      continueLabel: '返回海图准备返航',
    };
    uiKit.showToast('编队全员耐久归零！建议立即直达船坞整备', 'error');
  }

  combat.clearSession();
  if (char) {
    await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
  }
  await persistActiveRun();
}

/**
 * Play consecutive pending enemy initiative turns one-by-one with SVG choreography
 * until the next allied shipgirl's turn, round transition, night prompt, or battle end.
 */
async function drainPendingEnemyTurnsWithChoreography({ maxSteps = 16, stopRound = null } = {}) {
  const run = sortieState.activeRun;
  if (!run || !sortieState.context) return { roundCompleted: false };
  const { combat, entities, fxStage, rootStorage, uiKit } = sortieState.context;
  let roundCompleted = false;
  let steps = 0;

  while (combat.isActive() && combat.isEnemyTurnPending() && steps < maxSteps) {
    const preSess = combat.getSession();
    if (stopRound !== null && preSess && preSess.round !== stopRound) break;

    sortieState.busy = true;
    await renderSortieConsole();
    try {
      const res = combat.executeEnemyTurn();
      if (!res.ok) break;
      const { turnEntry, session } = res;
      const stageRoot = sortieState.container?.querySelector('#battle-fullscreen-stage');
      if (stageRoot) {
        await playBattleStepChoreography(stageRoot, { turnEntry, fxStage });
      }

      const nodeIdx = run.nextNodeIndex;
      const node = run.nodes[nodeIdx] || { code: session.nodeCode, name: session.nodeName };
      run.reports.unshift({
        id: `cmbe_${Date.now()}_${turnEntry.turn}`,
        nodeCode: node.code,
        nodeName: `${node.name} · R${turnEntry.round} 敌:${turnEntry.actorName}·${turnEntry.commandLabel}`,
        nodeType: 'enemy-action',
        text: turnEntry.text,
        source: 'local',
        degraded: false,
        chips: turnEntry.damageTaken > 0 ? [{ text: `我方受击 -${turnEntry.damageTaken}`, negative: true }] : [],
        timestamp: Date.now(),
      });

      if (turnEntry.roundCompleted) roundCompleted = true;

      if (
        session.status === 'victory' ||
        session.status === 'bypassed' ||
        session.status === 'day_ended' ||
        session.status === 'defeated'
      ) {
        sortieState.autoRunning = false;
        await finalizeBattleOutcome(session);
        break;
      } else if (session.status === 'night_prompt') {
        sortieState.autoRunning = false;
        uiKit.showToast('昼战结束！请抉择是否追击进入夜战', 'warn');
        await persistActiveRun();
        break;
      } else {
        const char = getFlagship();
        if (char) {
          await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
        }
        await persistActiveRun();
      }
      steps += 1;
    } finally {
      sortieState.busy = false;
      await renderSortieConsole();
    }
  }
  return { roundCompleted };
}

async function handleBattleShipAction(actionId, { silentRender = false } = {}) {
  if (sortieState.busy || !sortieState.activeRun) return null;
  const run = sortieState.activeRun;
  const { combat, entities, fxStage, rootStorage, uiKit } = sortieState.context;
  if (!combat.isActive()) return null;

  sortieState.busy = true;
  sortieState.container?.querySelectorAll('[data-battle-action]').forEach((btn) => {
    btn.disabled = true;
  });

  let actionResult = null;
  try {
    const res = await combat.executeShipAction(actionId, { autoResolveEnemyTurns: false });
    if (!res.ok) {
      uiKit.showToast(res.reason || '无法执行战术指令', 'warn');
      return null;
    }
    actionResult = res;

    const { turnEntry, session } = res;
    const stageRoot = sortieState.container?.querySelector('#battle-fullscreen-stage');
    if (stageRoot) {
      await playBattleStepChoreography(stageRoot, { turnEntry, fxStage });
    }

    const nodeIdx = run.nextNodeIndex;
    const node = run.nodes[nodeIdx] || { code: session.nodeCode, name: session.nodeName };
    run.reports.unshift({
      id: `cmbr_${Date.now()}_${turnEntry.turn}`,
      nodeCode: node.code,
      nodeName: `${node.name} · R${turnEntry.round} ${turnEntry.actorName}·${turnEntry.commandLabel}`,
      nodeType: turnEntry.outcomeTag,
      text: turnEntry.text,
      source: turnEntry.source,
      degraded: turnEntry.degraded,
      check: turnEntry.check,
      chips: turnEntry.damageDealt > 0 ? [{ text: `伤害 ${turnEntry.damageDealt}` }] : [],
      timestamp: Date.now(),
    });

    if (
      session.status === 'victory' ||
      session.status === 'bypassed' ||
      session.status === 'day_ended' ||
      session.status === 'defeated'
    ) {
      sortieState.autoRunning = false;
      await finalizeBattleOutcome(session);
    } else if (session.status === 'night_prompt') {
      sortieState.autoRunning = false;
      uiKit.showToast('昼战结束！请抉择是否追击进入夜战', 'warn');
      await persistActiveRun();
    } else {
      const char = getFlagship();
      if (char) {
        await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
      }
      await persistActiveRun();
    }
  } finally {
    sortieState.busy = false;
    if (!silentRender) {
      await renderSortieConsole();
    }
  }

  // After our shipgirl finishes, automatically play any enemy ships whose initiative slot is next!
  if (actionResult && combat.isActive() && combat.isEnemyTurnPending()) {
    const drain = await drainPendingEnemyTurnsWithChoreography();
    if (drain.roundCompleted && actionResult.turnEntry) {
      actionResult.turnEntry.roundCompleted = true;
    }
    actionResult.session = combat.getSession();
  }
  return actionResult;
}

async function handleBattleToggleAuto() {
  const { combat, uiKit } = sortieState.context;
  if (!combat.isActive()) return;
  if (sortieState.autoRunning) {
    sortieState.autoRunning = false;
    combat.setAutoDelegate(false);
    uiKit.showToast('已暂停本回合自动托管', 'info');
    await renderSortieConsole();
    return;
  }

  sortieState.autoRunning = true;
  combat.setAutoDelegate(true);
  uiKit.showToast('本回合托管启动：按混合机动顺序自动执行本回合指令', 'ok');
  await renderSortieConsole();

  const startRound = combat.getSession()?.round || 1;
  let guardSteps = 0;
  while (sortieState.autoRunning && combat.isActive() && guardSteps < 24) {
    const sess = combat.getSession();
    if (!sess || sess.status !== 'active' || sess.round !== startRound) break;
    if (combat.isEnemyTurnPending()) {
      const drain = await drainPendingEnemyTurnsWithChoreography({ stopRound: startRound });
      if (drain.roundCompleted) break;
      continue;
    }
    const actor = combat.getCurrentActor();
    if (!actor) break;
    const picked = combat.pickAutoActionForActor(actor);
    const res = await handleBattleShipAction(picked, { silentRender: true });
    if (!res || !res.ok) break;
    await renderSortieConsole();
    if (res.turnEntry?.roundCompleted || res.session?.status !== 'active') break;
    guardSteps += 1;
  }

  sortieState.autoRunning = false;
  combat.setAutoDelegate(false);
  await renderSortieConsole();
}

async function handleBattleEnterNight() {
  const { combat, uiKit } = sortieState.context;
  const res = combat.enterNightBattle();
  if (!res.ok) {
    uiKit.showToast(res.reason || '无法进入夜战', 'warn');
    return;
  }
  await persistActiveRun();
  uiKit.showToast('★ 追击进入夜战！交战拉近至近距离，雷击与近战暴击大幅强化', 'ok');
  await renderSortieConsole();
  if (combat.isActive() && combat.isEnemyTurnPending()) {
    await drainPendingEnemyTurnsWithChoreography();
  }
}

async function handleBattleFinishEarly() {
  const { combat } = sortieState.context;
  const res = combat.finishBattleEarly();
  if (res.ok && res.session) {
    await finalizeBattleOutcome(res.session);
  }
  await renderSortieConsole();
}

async function performQuickFleetResupply() {
  const { entities, resources, formation, rootStorage, uiKit } = sortieState.context;
  const members = formation ? formation.getMembers() : [getFlagship()].filter(Boolean);
  if (members.length === 0) return;

  let fuelNeed = 0;
  let steelNeed = 0;
  for (const m of members) {
    const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(m.id, 'maxHp', { round: 'round' }).final));
    const missingHp = Math.max(0, effMaxHp - Math.round(Number(m.stats.hp ?? effMaxHp)));
    const missingAp = Math.max(0, Number(m.stats.maxAp ?? 100) - Math.round(Number(m.stats.ap ?? 100)));
    fuelNeed += Math.ceil(missingAp * 0.4);
    steelNeed += Math.ceil(missingHp * 0.6);
  }
  const cost = {};
  if (fuelNeed > 0) cost.fuel = fuelNeed;
  if (steelNeed > 0) cost.steel = steelNeed;
  if (Object.keys(cost).length > 0) {
    const spend = await resources.spendBatch(cost, { reason: '战后一键补给全队' });
    if (!spend.ok) {
      uiKit.showToast(`一键补给失败：${spend.reason}`, 'warn');
      return;
    }
  }
  for (const m of members) {
    const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(m.id, 'maxHp', { round: 'round' }).final));
    entities.setStat(m.id, 'hp', effMaxHp);
    entities.setStat(m.id, 'ap', Number(m.stats.maxAp ?? 100));
    entities.adjustStat(m.id, 'morale', 12, { min: 0, max: 100 });
  }
  await persistCharacterRoster({ storage: rootStorage, entities });
  uiKit.showToast(`已完成全队（${members.length}舰）一键补给与应急修复！`, 'ok');
  await renderSortieConsole();
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
// Radar Sea-Chart Route Map Helper (SVG Track + Fog-of-War)
// ============================================================

function createRadarSeaChartElement(
  nodes,
  clearedIndices = [],
  nextNodeIndex = -1,
  { visionRange = 2, enableFog = false } = {}
) {
  const wrap = document.createElement('div');
  wrap.className = 'radar-chart-panel';
  wrap.id = enableFog ? 'sortie-radar-chart' : undefined;

  const clearedSet = new Set(clearedIndices);
  const hasBranches = nodes.some((n) => n.lane === 'assault' || n.lane === 'stealth' || (Array.isArray(n.nextCodes) && n.nextCodes.length >= 2));
  const maxCol = Math.max(
    1,
    ...nodes.map((n, idx) => (typeof n.col === 'number' ? n.col : idx))
  );
  const svgW = 340;
  const svgH = hasBranches ? 82 : 46;
  const stepX = maxCol > 0 ? (svgW - 44) / maxCol : 0;

  const codeToPt = new Map();
  const pts = nodes.map((node, idx) => {
    const col = typeof node.col === 'number' ? node.col : idx;
    const x = Math.round(22 + col * stepX);
    let y = hasBranches ? 41 : idx % 2 === 0 ? 18 : 28;
    if (hasBranches) {
      if (node.lane === 'assault') y = 16;
      else if (node.lane === 'stealth') y = 66;
      else y = 41;
    }
    const pt = { x, y, idx, node };
    codeToPt.set(node.code, pt);
    return pt;
  });

  // Build SVG connecting edges (DAG nextCodes if present, else sequential)
  const edgeLines = [];
  for (let i = 0; i < pts.length; i++) {
    const from = pts[i];
    const nextCodes = Array.isArray(from.node.nextCodes) ? from.node.nextCodes : [];
    if (nextCodes.length > 0) {
      for (const nc of nextCodes) {
        const to = codeToPt.get(nc);
        if (to) {
          const laneStroke =
            to.node.lane === 'assault'
              ? 'rgba(249,115,22,0.75)'
              : to.node.lane === 'stealth'
              ? 'rgba(34,211,238,0.75)'
              : 'rgba(56,189,248,0.65)';
          edgeLines.push(
            `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${laneStroke}" stroke-width="2" stroke-dasharray="5 3" />`
          );
        }
      }
    } else if (!hasBranches && i < pts.length - 1) {
      const to = pts[i + 1];
      edgeLines.push(
        `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="radar-track-line" stroke-width="2" stroke-dasharray="5 3" />`
      );
    }
  }

  const activePt = nextNodeIndex >= 0 && nextNodeIndex < pts.length ? pts[nextNodeIndex] : null;
  const activeCol = activePt ? (typeof activePt.node.col === 'number' ? activePt.node.col : activePt.idx) : -1;

  wrap.innerHTML = `
    <div class="radar-chart-header">
      <span class="radar-chart-title">${hasBranches ? '分岔雷达海图（上:强攻 / 下:隐蔽）' : '战术海图 · 雷达航迹'}</span>
      <span class="radar-chart-vision">${nodes.length}节点 · 视野${visionRange}格${enableFog ? ' · 迷雾' : ''}</span>
    </div>
    <svg class="radar-track-svg" style="height:${svgH}px;" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="none" aria-hidden="true">
      ${edgeLines.join('')}
      ${pts
        .map((p) => {
          const isCleared = clearedSet.has(p.idx);
          const isCur = p.idx === nextNodeIndex;
          const fill = isCleared
            ? '#34d399'
            : isCur
            ? '#38bdf8'
            : p.node.type === NODE_TYPES.ANCHORAGE
            ? '#facc15'
            : p.node.type === NODE_TYPES.BOSS
            ? '#f87171'
            : p.node.lane === 'assault'
            ? '#fb923c'
            : p.node.lane === 'stealth'
            ? '#22d3ee'
            : '#64748b';
          return `<circle cx="${p.x}" cy="${p.y}" r="${isCur ? 5.5 : 4}" fill="${fill}" stroke="#0f172a" stroke-width="1.5"/>`;
        })
        .join('')}
      ${
        activePt
          ? `
        <circle class="radar-pulse-ring" cx="${activePt.x}" cy="${activePt.y}" r="11" fill="none" stroke="#38bdf8" stroke-width="1.8"/>
        <polygon points="${activePt.x},${activePt.y - 9} ${activePt.x + 6},${activePt.y + 4} ${activePt.x - 6},${activePt.y + 4}" fill="#38bdf8" stroke="#e0f2fe" stroke-width="1"/>
      `
          : ''
      }
    </svg>
    <div class="radar-node-grid" id="sortie-node-map"></div>
  `;

  const grid = wrap.querySelector('.radar-node-grid');
  nodes.forEach((node, idx) => {
    const isCleared = clearedSet.has(idx);
    const isCurrent = idx === nextNodeIndex;
    const nodeCol = typeof node.col === 'number' ? node.col : idx;
    const isFogged =
      enableFog &&
      !isCleared &&
      !isCurrent &&
      !node.intelRevealed &&
      activeCol >= 0 &&
      nodeCol > activeCol + visionRange;

    const laneTag =
      node.lane === 'assault' ? '强攻' : node.lane === 'stealth' ? '隐蔽' : '';

    const step = document.createElement('div');
    step.className = `radar-node sortie-node-step ${isCleared ? 'is-cleared' : ''} ${
      isCurrent ? 'is-current' : ''
    } ${node.type === NODE_TYPES.BOSS && !isFogged ? 'is-boss' : ''} ${
      node.type === NODE_TYPES.ANCHORAGE && !isFogged ? 'is-anchorage' : ''
    } ${node.lane === 'assault' ? 'is-lane-assault' : node.lane === 'stealth' ? 'is-lane-stealth' : ''} ${
      isFogged ? 'is-fogged' : ''
    }`;
    step.dataset.nodeCode = node.code;
    step.dataset.nodeType = isFogged ? 'fog' : node.type;
    step.innerHTML = isFogged
      ? `
      <span class="sortie-node-code">${escapeHtml(node.code)}</span>
      <span class="sortie-node-type">${laneTag ? `${laneTag}·` : ''}迷雾</span>
      <span class="sortie-node-name">???</span>
    `
      : `
      <span class="sortie-node-code">${isCleared ? '✓' : escapeHtml(node.code)}</span>
      <span class="sortie-node-type">${laneTag ? `${laneTag}·` : ''}${escapeHtml(NODE_TYPE_LABELS[node.type] || node.type)}</span>
      <span class="sortie-node-name">${escapeHtml(node.name)}</span>
    `;
    grid.appendChild(step);
  });

  return wrap;
}

// ============================================================
// Root View Renderer
// ============================================================

async function renderSortieConsole() {
  if (!sortieState.container || !sortieState.context) return;
  const {
    entities,
    resources,
    statRules,
    inventory,
    narrative,
    routeGenerator,
    combat,
    formation,
    commander,
    fxStage,
    modules,
    ui,
    uiKit,
  } = sortieState.context;
  const char = getFlagship();
  if (!char) {
    ui.setImmersiveBattle(false);
    sortieState.container.innerHTML = `
      <section class="surface-card">
        <h2 class="section-title">暂无可用出征编队</h2>
        <p class="muted-text">请先返回港区大本营配置至少 1 名适航舰娘入队。</p>
      </section>
    `;
    return;
  }

  const runMemberIds = sortieState.activeRun?.fleetMemberIds || null;
  const runFormationId = sortieState.activeRun?.formationId || null;
  const fleetSummary = formation
    ? formation.computeFleetSummary(runMemberIds, runFormationId)
    : null;

  // ============================================================
  // IMMERSIVE FULL-SCREEN BATTLE SCREEN MODE
  // Automatically hides the sea chart & locks horizontal swipe!
  // ============================================================
  const activeCombatSession = combat.isInBattleScreen() ? combat.getSession() : null;
  if (activeCombatSession || sortieState.postBattleSettlement) {
    ui.setImmersiveBattle(true);
    const displaySession = activeCombatSession || sortieState.postBattleSettlement.sessionSnapshot;
    const currentTurnSlot = activeCombatSession ? combat.getCurrentTurnSlot() : null;
    const currentActor = activeCombatSession ? combat.getCurrentActor() : null;
    const availableActions = activeCombatSession ? combat.getAvailableActionsForCurrentActor() : [];

    renderFullScreenBattleView({
      host: sortieState.container,
      session: displaySession,
      fleetSummary,
      currentActor,
      currentTurnSlot,
      availableActions,
      busy: sortieState.busy,
      autoRunning: sortieState.autoRunning,
      fxStage,
      uiKit,
      settlementInfo: activeCombatSession ? null : sortieState.postBattleSettlement,
      onSelectTarget: (enemyId) => {
        combat.setTargetEnemy(enemyId);
        renderSortieConsole();
      },
      onExecuteAction: (actionId) => handleBattleShipAction(actionId),
      onToggleAuto: () => handleBattleToggleAuto(),
      onToggleSpeed: () => {
        if (fxStage && typeof fxStage.toggleBattleSpeed === 'function') {
          const nextSpd = fxStage.toggleBattleSpeed();
          uiKit.showToast(`战斗演出倍速切换为 ${nextSpd}x`, 'info');
          renderSortieConsole();
        }
      },
      onEnterNight: () => handleBattleEnterNight(),
      onFinishEarly: () => handleBattleFinishEarly(),
      onPostBattleContinue: () => {
        sortieState.postBattleSettlement = null;
        ui.setImmersiveBattle(false);
        renderSortieConsole();
      },
      onPostBattleDockyard: () => {
        sortieState.postBattleSettlement = null;
        ui.setImmersiveBattle(false);
        if (modules.has('port-dockyard')) modules.mount('port-dockyard', { transition: 'left' });
      },
      onPostBattleResupply: () => performQuickFleetResupply(),
    });
    return;
  }

  // Normal Sea-Chart Mode (unlock immersive battle)
  ui.setImmersiveBattle(false);

  const fleetCap = formation ? formation.getFleetCap() : 3;
  const visionRange = fleetSummary?.visionRange ?? 2;
  const staggeredCost = fleetSummary?.staggeredStepCost || { fuel: 20, ammo: 18 };
  const flagshipClass = resolveShipClass(char.meta?.shipType);

  const seaworthyInfo = statRules.evaluateSeaworthiness(inventory, char.id);
  const mode = narrative.getMode();
  const isAiMode = mode !== NARRATIVE_MODES.LOCAL;
  const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(char.id, 'maxHp', { round: 'round' }).final));
  const maxAp = Number(char.stats.maxAp ?? 100);
  const curHp = Math.min(effMaxHp, Math.round(Number(char.stats.hp ?? effMaxHp)));
  const isHeavyDamage = curHp / effMaxHp < 0.25;

  sortieState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'sortie-root';

  // Unified Full-Screen Subpage Top Bar (`← 返回港区` + Title + Fuel/Ammo)
  root.appendChild(
    uiKit.createSubpageHeader({
      title: '出征分岔海图',
      subtitle: '8~15 节点雷达海图 · 遇敌自动进入全屏战斗',
      modules,
      resources,
      resourceKeys: ['fuel', 'ammo', 'steel'],
      id: 'sortie-subpage-header',
    })
  );

  // 1. Unified 6-Resource Bar
  root.appendChild(createResourceOverviewBar(resources, { id: 'sortie-resource-bar' }));

  // 2. Fleet & Flagship Compact Status Bar
  const topCard = document.createElement('section');
  topCard.className = 'surface-card lab-stack-sm';
  topCard.id = 'sortie-flagship-bar';
  topCard.innerHTML = `
    <div class="lab-slot-head">
      <div class="cc-badge-row">
        <span class="ship-class-ico">${getShipClassSvg(flagshipClass, { size: 22 })}</span>
        <strong>旗舰：${escapeHtml(char.name)}</strong>
        ${
          fleetSummary
            ? `<span class="status-badge badge-ok" id="sortie-fleet-badge">编队 ${fleetSummary.count}/${fleetCap} 舰 · ${escapeHtml(fleetSummary.formationName)}</span>`
            : ''
        }
        <span class="status-badge ${seaworthyInfo.seaworthy ? 'badge-ok' : 'badge-danger'}" id="sortie-seaworthy-badge">
          ${seaworthyInfo.seaworthy ? '适航' : '未适航'}
        </span>
        ${isHeavyDamage ? '<span class="status-badge badge-danger" id="sortie-heavy-dmg-badge">大破警告</span>' : ''}
      </div>
      <button type="button" id="btn-sortie-mode-toggle" class="ac-mode-toggle ${isAiMode ? 'is-ai' : ''}">
        ${isAiMode ? 'AI 润色' : '纯本地模板'}
      </button>
    </div>

    ${
      fleetSummary
        ? `
      <div class="port-gear-summary" id="sortie-fleet-stats-strip">
        <span class="ns-chip">全队火力 ${fleetSummary.effective.firepower}</span>
        <span class="ns-chip">全队雷击 ${fleetSummary.effective.torpedo}</span>
        <span class="ns-chip">防空 ${fleetSummary.effective.aa}</span>
        <span class="ns-chip">反潜 ${fleetSummary.effective.asw}</span>
        <span class="ns-chip">侦查 ${fleetSummary.effective.recon}</span>
        <span class="ns-chip">视野 ${visionRange}格</span>
        <span class="ns-chip" id="sortie-staggered-cost-chip">阶梯单步 油${staggeredCost.fuel}/弹${staggeredCost.ammo}</span>
      </div>
      <div class="port-gear-summary" id="sortie-fleet-hp-strip">
        ${fleetSummary.members
          .map(
            (m, i) => `
          <span class="ns-chip">${i === 0 ? '★' : `#${i}`}[${escapeHtml(m.classCode || 'DD')}]${escapeHtml(m.name)} ${m.hp}/${m.maxHp}</span>
        `
          )
          .join('')}
      </div>
    `
        : ''
    }

    <div id="sortie-compact-bars" class="ac-bars-compact"></div>

    <div class="lab-btn-grid">
      <button type="button" id="btn-sortie-open-editor" class="btn-secondary uikit-touch-target">航线编辑器</button>
      <button type="button" id="btn-sortie-back-port" class="btn-secondary uikit-touch-target">返回港区编成</button>
    </div>
  `;

  const barsHost = topCard.querySelector('#sortie-compact-bars');
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: '旗舰HP',
      value: curHp,
      max: effMaxHp,
      showPercent: false,
      sublabel: `${Math.round(curHp)}/${effMaxHp}`,
      tone: isHeavyDamage ? 'danger' : curHp / effMaxHp < 0.5 ? 'warn' : 'accent',
    }).element
  );
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: '均士气',
      value: fleetSummary ? fleetSummary.avgMorale : char.stats.morale ?? 50,
      max: 100,
      showPercent: false,
      sublabel: `${Math.round(fleetSummary ? fleetSummary.avgMorale : char.stats.morale ?? 50)}`,
      tone: (fleetSummary ? fleetSummary.avgMorale : char.stats.morale ?? 50) < 30 ? 'danger' : 'accent',
    }).element
  );
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: '旗舰AP',
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
          ${run.completed ? '全节点通关' : combatSession ? '全队战术交战中' : `进度 ${run.clearedIndices.length}/${run.nodes.length}`}
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
    activeCard.querySelector('#sortie-map-mount').appendChild(
      createRadarSeaChartElement(run.nodes, run.clearedIndices, run.completed ? -1 : run.nextNodeIndex, {
        visionRange,
        enableFog: true,
      })
    );

    // Sub-panel A: Branching Lane Fork Decision Card
    if (Array.isArray(run.awaitingBranchChoices) && run.awaitingBranchChoices.length >= 2) {
      const forkBox = document.createElement('div');
      forkBox.className = 'sortie-branch-panel lab-stack-sm';
      forkBox.id = 'sortie-branch-choices';
      forkBox.innerHTML = `
        <div class="section-header-row" style="margin-bottom:0;">
          <strong style="font-size:14px;">航线分岔抉择 · 请选择前进航道</strong>
          <span class="status-badge badge-warn">分岔节点</span>
        </div>
        ${run.awaitingBranchChoices
          .map(
            (ch) => `
          <button type="button" class="sortie-branch-btn is-lane-${escapeHtml(ch.lane || 'main')}" data-choose-branch="${escapeHtml(ch.targetCode)}">
            <div class="lab-slot-head">
              <strong>${escapeHtml(ch.label)}（→ ${escapeHtml(ch.targetCode)}）</strong>
              <span class="status-badge ${ch.lane === 'assault' ? 'badge-danger' : 'badge-ok'}">${escapeHtml(ch.badge || '可选航道')}</span>
            </div>
            <span class="cc-stat-sub">${escapeHtml(ch.desc || '')}</span>
          </button>
        `
          )
          .join('')}
      `;
      forkBox.querySelectorAll('[data-choose-branch]').forEach((btn) => {
        btn.addEventListener('click', () => chooseBranchPath(btn.getAttribute('data-choose-branch')));
      });
      activeCard.appendChild(forkBox);
    } else if (run.pendingAnchorage) {
      // Sub-panel B: Temporary Anchorage Rest & Resupply Decision Card
      const ancNode = run.nodes[run.pendingAnchorage.nodeIndex];
      const cfg = ancNode?.anchorageConfig || { cost: { fuel: 22, steel: 18, silver: 20 }, healPct: 0.35, moraleGain: 20 };
      const ancBox = document.createElement('div');
      ancBox.className = 'sortie-anchorage-panel lab-stack-sm';
      ancBox.id = 'sortie-anchorage-panel';
      ancBox.innerHTML = `
        <div class="section-header-row" style="margin-bottom:0;">
          <strong>临时锚地：${escapeHtml(ancNode?.name || '避风锚地')}</strong>
          <span class="status-badge badge-ok">应急休整点</span>
        </div>
        <p class="muted-text" style="font-size:12px; margin:0;">
          可消耗少量物资（燃油 ${cfg.cost.fuel} / 钢材 ${cfg.cost.steel} / 银条 ${cfg.cost.silver}）为全队恢复 ${Math.round((cfg.healPct || 0.35) * 100)}% 耐久与 +${cfg.moraleGain || 20} 士气，或免消耗轻装继续航行。
        </p>
        <div class="lab-btn-grid">
          <button type="button" id="btn-anchorage-rest" class="btn-primary uikit-touch-target">锚地整备恢复</button>
          <button type="button" id="btn-anchorage-skip" class="btn-secondary uikit-touch-target">免消耗继续航行</button>
        </div>
      `;
      ancBox.querySelector('#btn-anchorage-rest').addEventListener('click', () => resolveAnchorageAction(true));
      ancBox.querySelector('#btn-anchorage-skip').addEventListener('click', () => resolveAnchorageAction(false));
      activeCard.appendChild(ancBox);
    } else {
      // Sub-panel C: Advance / Retreat & Post-Sortie Dockyard/Resupply Shortcuts
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

      if (!run.completed && run.nodes[run.nextNodeIndex]) {
        const nextNode = run.nodes[run.nextNodeIndex];
        const advBtn = document.createElement('button');
        advBtn.type = 'button';
        advBtn.id = 'btn-sortie-advance';
        advBtn.className = 'btn-primary port-cta-btn';
        advBtn.disabled = sortieState.busy;
        advBtn.textContent =
          run.nextNodeIndex === 0
            ? `向首节点 ${nextNode.code} 进发（阶梯单步 油-${run.stepCost.fuel} / 弹-${run.stepCost.ammo}）`
            : `继续向下一节点 ${nextNode.code} 进发（阶梯单步 油-${run.stepCost.fuel} / 弹-${run.stepCost.ammo}）`;
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

      if (run.completed) {
        const postRow = document.createElement('div');
        postRow.className = 'lab-btn-grid';
        postRow.innerHTML = `
          <button type="button" id="btn-sortie-goto-dockyard" class="btn-secondary uikit-touch-target">直达船坞整备</button>
          <button type="button" id="btn-sortie-quick-resupply" class="btn-secondary uikit-touch-target">一键补给全队</button>
        `;
        postRow.querySelector('#btn-sortie-goto-dockyard').addEventListener('click', async () => {
          await retreatToPort();
          if (modules.has('port-dockyard')) modules.mount('port-dockyard', { transition: 'left' });
        });
        postRow.querySelector('#btn-sortie-quick-resupply').addEventListener('click', () => performQuickFleetResupply());
        btnStack.appendChild(postRow);
      }

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
    // Procedural Route Generator & Enemy Strength Scaling Card
    const curMult = clampEnemyStrengthMultiplier(sortieState.enemyStrengthMultiplier);
    const curLootBonusPct = Math.round(Math.max(0, curMult - 1) * 35);
    const genCard = document.createElement('section');
    genCard.className = 'surface-card lab-stack-sm';
    genCard.id = 'sortie-generator-card';
    genCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">随机分岔海图与敌军强度</h2>
        <span class="status-badge badge-ok">8~15 节点 · 动态 6~12 敌舰</span>
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

      <div class="sortie-strength-box" id="sortie-strength-panel">
        <div class="lab-slot-head">
          <strong style="font-size:13px;">敌军强度倍率</strong>
          <span class="status-badge ${curMult >= 2.0 ? 'badge-danger' : curMult >= 1.4 ? 'badge-warn' : 'badge-ok'}" id="sortie-strength-badge">
            当前 ${curMult.toFixed(1)}x${curLootBonusPct > 0 ? ` · 战利品 +${curLootBonusPct}%` : ''}
          </span>
        </div>
        <div class="cc-btn-3col" id="sortie-strength-presets">
          ${ENEMY_STRENGTH_PRESETS.map(
            (p) => `
            <button type="button" class="${Math.abs(curMult - p.multiplier) < 0.05 ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-strength-preset="${p.multiplier}">
              ${escapeHtml(p.label)}
            </button>
          `
          ).join('')}
        </div>
        <label class="sortie-slider-row">
          <span class="muted-text" style="font-size:11.5px;">自定义滑块（0.5x ~ 3.5x）：</span>
          <input type="range" id="sortie-strength-slider" min="0.5" max="3.5" step="0.1" value="${curMult.toFixed(1)}" />
        </label>
        <p class="muted-text" style="font-size:11px; margin:0;">
          中高危海域与深层节点将随危级、节点深度、我方编队人数与强度倍率动态刷出 6~12 艘混合舰种敌舰并启用智能集火 AI。
        </p>
      </div>

      <button type="button" id="btn-sortie-gen-route" class="btn-primary port-cta-btn">随机生成新航线</button>
    `;

    genCard.querySelectorAll('[data-sortie-diff]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sortieState.selectedDifficulty = btn.getAttribute('data-sortie-diff');
        renderSortieConsole();
      });
    });
    genCard.querySelectorAll('[data-strength-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextVal = setEnemyStrengthMultiplier(btn.getAttribute('data-strength-preset'));
        uiKit.showToast(`敌军强度倍率已切换为 ${nextVal.toFixed(1)}x（已持久化保存）`, 'ok');
        renderSortieConsole();
      });
    });
    const sliderEl = genCard.querySelector('#sortie-strength-slider');
    if (sliderEl) {
      sliderEl.addEventListener('input', () => {
        const val = setEnemyStrengthMultiplier(sliderEl.value);
        const badge = genCard.querySelector('#sortie-strength-badge');
        const bonusPct = Math.round(Math.max(0, val - 1) * 35);
        if (badge) {
          badge.textContent = `当前 ${val.toFixed(1)}x${bonusPct > 0 ? ` · 战利品 +${bonusPct}%` : ''}`;
          badge.className = `status-badge ${val >= 2.0 ? 'badge-danger' : val >= 1.4 ? 'badge-warn' : 'badge-ok'}`;
        }
      });
      sliderEl.addEventListener('change', () => {
        const val = setEnemyStrengthMultiplier(sliderEl.value);
        uiKit.showToast(`自定义敌军强度倍率已保存：${val.toFixed(1)}x`, 'ok');
        renderSortieConsole();
      });
    }
    genCard.querySelector('#btn-sortie-gen-route').addEventListener('click', () => {
      const customEnemies = sortieState.context?.contentManager?.listCustomEnemies() || [];
      const fresh = routeGenerator.generateRoute({
        difficulty: sortieState.selectedDifficulty,
        commander,
        customEnemies,
        fleetSize: fleetSummary?.count || 3,
        strengthMultiplier: sortieState.enemyStrengthMultiplier,
      });
      sortieState.generatedRoute = fresh;
      sortieState.selectedRouteId = fresh.id;
      uiKit.showToast(
        `已生成「${fresh.name}」（${fresh.nodes.length} 节点 · 强度 ${sortieState.enemyStrengthMultiplier.toFixed(1)}x · 海况：${fresh.seaCondition.label}）`,
        'ok'
      );
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
        <span class="status-badge badge-muted">编队阶梯单步：油${staggeredCost.fuel} / 弹${staggeredCost.ammo}</span>
      </div>
      <p class="muted-text" style="font-size:11.5px;">
        大编队阶梯消耗规则：1~3号舰 100% · 4~6号舰 75% · 7~12号舰 55%，再乘以指挥官「调度」减免。
      </p>
      ${
        !validation.ok
          ? `<div class="seaworthy-alert" id="sortie-launch-errors">启航条件未满足：${escapeHtml(validation.errors.join('；'))}</div>`
          : ''
      }
      <button type="button" id="btn-sortie-launch" class="btn-primary port-cta-btn" ${validation.ok ? '' : 'disabled'}>
        ${selectedRoute ? `启航出击：${escapeHtml(selectedRoute.name)}（AP -${selectedRoute.apCost} · 单步油${staggeredCost.fuel}/弹${staggeredCost.ammo}）` : '请选择航线'}
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
          海况：${escapeHtml(rt.seaCondition?.label || '标准')} · 最低要求 油≥${rt.minFuel} / 弹≥${rt.minAmmo} / AP≥${rt.apCost} · 当前编队单步 油${staggeredCost.fuel}/弹${staggeredCost.ammo}
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
      card.querySelector('[data-rt-map]').appendChild(
        createRadarSeaChartElement(rt.nodes, [], -1, { visionRange, enableFog: false })
      );
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
