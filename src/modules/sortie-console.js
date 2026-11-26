/**
 * Three-Stage Tactical Sortie & Custom Map Workshop Console (`sortie-console.js`).
 *
 * v25 3-Stage Flow:
 *   - Stage 1 「准备出征」: Fleet readiness check + quick Dockyard modal + Commander Logistics quick point allocation
 *                           + Carried Fuel/Ammo sliders bounded by Commander Logistics + AO ship bonus
 *                           + 1-Tap Max Load (100% unused refund on return/retreat!).
 *   - Stage 2 「自定义海图工坊」: 1★~5★ Sea Control progression (0%~100% unlocks next star) + Quick Random Sea Chart
 *                                 + Full Custom Map Workshop (1★~5★, scale, sea condition, node mix, enemy bias,
 *                                   seed code save/load, live supply & drop preview; zero fixed preset charts).
 *   - Stage 3 「航行与战斗」: Carried supplies HUD, Salvage nodes (refill carried oil/ammo & salvage parts),
 *                             Temporary Anchorage (AR free bonus repair!), Random Maritime Encounters (auto-invoking
 *                             imported JSON story packs), 3x4 Tactical Battle with top-right 100% Safe Retreat,
 *                             and 100% refund of unused carried supplies on Return/Retreat.
 */

import {
  CORE_STAT_DEFS,
  ENEMY_STRENGTH_PRESETS,
  clampEnemyStrengthMultiplier,
  getShipClassSvg,
  normalizeStarTierId,
  resolveShipClass,
} from '../core/stat-rules.js';
import { NARRATIVE_MODES } from '../core/prompt-pipeline.js';
import { LOG_CATEGORIES } from '../core/log-system.js';
import {
  BRANCH_LANE_META,
  ENEMY_BIAS_MODES,
  MAP_SCALES,
  NODE_MIX_MODES,
  NODE_TYPES,
  NODE_TYPE_LABELS,
  SEA_CONDITIONS,
  SEA_DIFFICULTIES,
  decodeMapSeed,
  encodeMapSeed,
  estimateRouteProfile,
} from '../core/route-generator.js';
import { getActiveCharacterId, persistCharacterRoster } from './character-console.js';
import { openDockyardTacticalModal } from './port-facilities.js';
import {
  playBattleStepChoreography,
  playOpeningChoreography,
  renderFullScreenBattleView,
} from './battle-screen.js';
import { clamp } from '../core/calc-engine.js';

const SORTIE_STORAGE_NS = 'core-sortie';
const RUN_KEY = 'active-sortie-run-v3';
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
  prepStage: 'prep', // 'prep' (Stage 1) | 'workshop' (Stage 2)
  carriedFuel: null,
  carriedAmmo: null,
  workshopConfig: {
    starLevel: 1,
    scale: 'medium',
    seaConditionId: 'random',
    nodeMix: 'balanced',
    enemyBias: 'mixed',
    seedInput: '',
    blueprintName: '',
  },
  enemyStrengthMultiplier: 1.0,
  activeRun: null,
  activeNodeStory: null,
  postBattleSettlement: null,
  inspectedEnemyId: null,
  highlightedAllyId: null,
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
  const savedRun =
    (await scope.getLarge(RUN_KEY, null)) ||
    (await scope.getLarge('active-sortie-run-v2', null));
  sortieState.activeRun = savedRun && typeof savedRun === 'object' ? deepClone(savedRun) : null;
  if (combat && sortieState.activeRun?.combatSnapshot) {
    combat.deserialize(sortieState.activeRun.combatSnapshot);
  }
  sortieState.hydrated = true;
}

export async function clearActiveSortieState({ storage, combat }) {
  sortieState.activeRun = null;
  sortieState.activeNodeStory = null;
  sortieState.postBattleSettlement = null;
  sortieState.inspectedEnemyId = null;
  sortieState.highlightedAllyId = null;
  sortieState.autoRunning = false;
  sortieState.busy = false;
  sortieState.prepStage = 'prep';
  sortieState.carriedFuel = null;
  sortieState.carriedAmmo = null;
  if (combat && typeof combat.deserialize === 'function') {
    combat.deserialize(null);
  }
  if (storage) {
    const scope = storage.namespace(SORTIE_STORAGE_NS);
    await scope.removeLarge(RUN_KEY);
    await scope.removeLarge('active-sortie-run-v2');
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

function getCurrentFleetMembers() {
  const { formation } = sortieState.context || {};
  if (formation) {
    const list = formation.getMembers();
    if (list.length > 0) return list;
  }
  const f = getFlagship();
  return f ? [f] : [];
}

function getCarriedSupplyCapsForCurrentFleet() {
  const { commander, resources } = sortieState.context || {};
  const members = getCurrentFleetMembers();
  const aoCount = members.filter((m) => resolveShipClass(m.meta?.shipType) === 'AO').length;
  const arCount = members.filter((m) => resolveShipClass(m.meta?.shipType) === 'AR').length;
  const caps =
    commander && typeof commander.getCarriedSupplyCaps === 'function'
      ? commander.getCarriedSupplyCaps({ aoCount })
      : { maxFuel: 180 + aoCount * 90, maxAmmo: 180 + aoCount * 90, logisticsScore: 10, aoCount };
  const portFuel = Math.max(0, Math.round(resources?.getBalance('fuel') ?? 0));
  const portAmmo = Math.max(0, Math.round(resources?.getBalance('ammo') ?? 0));
  const loadableFuel = Math.min(caps.maxFuel, portFuel);
  const loadableAmmo = Math.min(caps.maxAmmo, portAmmo);

  if (sortieState.carriedFuel === null || !Number.isFinite(sortieState.carriedFuel)) {
    sortieState.carriedFuel = Math.min(loadableFuel, Math.max(40, Math.round(caps.maxFuel * 0.75)));
  }
  if (sortieState.carriedAmmo === null || !Number.isFinite(sortieState.carriedAmmo)) {
    sortieState.carriedAmmo = Math.min(loadableAmmo, Math.max(40, Math.round(caps.maxAmmo * 0.75)));
  }
  sortieState.carriedFuel = clamp(Math.round(sortieState.carriedFuel), 0, loadableFuel);
  sortieState.carriedAmmo = clamp(Math.round(sortieState.carriedAmmo), 0, loadableAmmo);

  return {
    ...caps,
    aoCount,
    arCount,
    portFuel,
    portAmmo,
    loadableFuel,
    loadableAmmo,
    selectedFuel: sortieState.carriedFuel,
    selectedAmmo: sortieState.carriedAmmo,
  };
}

function validateSortieLaunch(char, route) {
  const { statRules, inventory, resources, formation } = sortieState.context;
  const errors = [];
  if (!route) return { ok: false, errors: ['请先生成海图'] };

  let fleetMembers = [];
  if (formation) {
    const fVal = formation.validateFleetForSortie();
    if (!fVal.ok) errors.push(...fVal.errors);
    fleetMembers = fVal.members;
  } else if (char) {
    const sw = statRules.evaluateSeaworthiness(inventory, char.id);
    if (!sw.seaworthy) errors.push(sw.statusText);
    if (Number(char.stats.hp ?? 0) <= 0) errors.push('当前旗舰 HP 为 0，请先入渠修复');
    fleetMembers = [char];
  } else {
    errors.push('暂无可用出征舰娘');
  }

  const caps = getCarriedSupplyCapsForCurrentFleet();
  if (caps.selectedFuel < 10) {
    errors.push(`携带燃油过低（至少装载 10，当前 ${caps.selectedFuel}，港区库存 ${resources.getBalance('fuel')}）`);
  }
  if (caps.selectedAmmo < 10) {
    errors.push(`携带弹药过低（至少装载 10，当前 ${caps.selectedAmmo}，港区库存 ${resources.getBalance('ammo')}）`);
  }
  return { ok: errors.length === 0, errors, seaworthy: errors.length === 0, fleetMembers, caps };
}

function formatLootSummary(lootObj = {}, resources) {
  const parts = [];
  for (const [k, v] of Object.entries(lootObj)) {
    const val = Number(v) || 0;
    if (val > 0) parts.push(`${resources.get(k)?.name || k} +${val}`);
  }
  return parts.length > 0 ? parts.join('、') : '暂无战利品';
}

function syncSuppliesFromCombatSession(run, session) {
  if (!run || !session) return;
  if (session.carriedSupplies) {
    run.carriedSupplies = deepClone(session.carriedSupplies);
    run.supplyDepleted = Boolean(
      session.supplyDepleted || run.carriedSupplies.fuel <= 0 || run.carriedSupplies.ammo <= 0
    );
  }
  if (Number.isFinite(Number(session.resupplyUsesRemaining))) {
    run.resupplyUsesRemaining = Math.max(0, Math.min(2, Math.floor(Number(session.resupplyUsesRemaining))));
  }
}

// ============================================================
// Stage 3 Execution: Launch, Advance, Anchorage, Story Events, Combat, Return
// ============================================================

async function launchSortie(route) {
  const char = getFlagship();
  const check = validateSortieLaunch(char, route);
  const { entities, formation, commander, resources, rootStorage, combat, logs, bus, uiKit } = sortieState.context;

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
      message: `编队中「${heavyDamaged.map((m) => m.name).join('、')}」当前耐久低于 25%，处于大破状态。建议先在船坞快速修复，确定仍要强行启航吗？`,
      confirmLabel: '强行启航',
      cancelLabel: '取消',
      tone: 'danger',
    });
    if (!proceed) return;
  }

  // Deduct carried fuel/ammo upfront from port warehouse into the fleet's carried supply pool (100% unused refunded on return!)
  const loadFuel = Math.max(10, Math.round(check.caps.selectedFuel));
  const loadAmmo = Math.max(10, Math.round(check.caps.selectedAmmo));
  const loadSpend = await resources.spendBatch(
    { fuel: loadFuel, ammo: loadAmmo },
    { reason: `出征装载携带油弹「${route.name}」（未消耗返港 100% 退回）` }
  );
  if (!loadSpend.ok) {
    uiKit.showToast(`装填携带油弹失败：${loadSpend.reason}`, 'error');
    return;
  }

  if (route.apCost > 0) {
    for (const m of fleetMembers) {
      entities.adjustStat(m.id, 'ap', -Math.min(route.apCost, Math.round(m.stats.ap ?? 0)), {
        min: 0,
        max: Number(m.stats.maxAp ?? 100),
      });
    }
    await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: lead.id });
  }

  const activeFormation = formation ? formation.getActiveFormation() : { id: 'line_ahead', name: '单纵阵' };
  const dispatchDisc = commander ? commander.getSortieStepDiscount() : 0;
  const fleetMemberIds = fleetMembers.map((m) => m.id);
  const effStepCost = {
    fuel: Math.max(6, Math.round((Number(route.stepCost?.fuel) || 16) * (1 - dispatchDisc))),
    ammo: Math.max(6, Math.round((Number(route.stepCost?.ammo) || 14) * (1 - dispatchDisc))),
  };

  combat.clearSession();
  sortieState.postBattleSettlement = null;
  sortieState.autoRunning = false;
  sortieState.activeNodeStory = null;
  sortieState.activeRun = {
    routeId: route.id,
    routeName: route.name,
    seedCode: route.seedCode || '',
    difficulty: normalizeStarTierId(route.difficulty || `star_${route.star || 1}`),
    star: route.star || 1,
    difficultyLabel: route.difficultyLabel || `${route.star || 1}★海域`,
    enemyStrengthMultiplier: sortieState.enemyStrengthMultiplier || 1.0,
    hasBranches: Boolean(route.hasBranches),
    seaCondition: route.seaCondition ? deepClone(route.seaCondition) : null,
    characterId: lead.id,
    characterName: lead.name,
    fleetMemberIds,
    formationId: activeFormation.id,
    formationName: activeFormation.name,
    stepCost: effStepCost,
    carriedSupplies: {
      fuel: loadFuel,
      ammo: loadAmmo,
      maxFuel: check.caps.maxFuel,
      maxAmmo: check.caps.maxAmmo,
      initialFuel: loadFuel,
      initialAmmo: loadAmmo,
    },
    supplyDepleted: false,
    resupplyUsesRemaining: 2,
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
    detail: `装载携带油 ${loadFuel} / 弹 ${loadAmmo}（返港 100% 退回余额）· 种子 ${route.seedCode || '随机'} · 海况：${route.seaCondition?.label || '标准'}`,
  });
  bus.emit('sortie:launched', { routeId: route.id, characterId: lead.id, fleetSize: fleetMembers.length });
  uiKit.showToast(`启航成功！已装填携带油 ${loadFuel} / 弹 ${loadAmmo}（返港全额退回剩余）`, 'ok');
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
            badge: lane === 'assault' ? '高危高爆率' : '打捞/海遇/锚地',
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

  if (node?.type === NODE_TYPES.BOSS || clearedIdx + 1 >= run.nodes.length || (nextCodes.length === 0 && run.hasBranches)) {
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

async function resolveAnchorageAction(mode = 'rest') {
  const run = sortieState.activeRun;
  if (!run || !run.pendingAnchorage) return;
  const { entities, resources, rootStorage, logs, bus, uiKit } = sortieState.context;
  const nodeIdx = run.pendingAnchorage.nodeIndex;
  const node = run.nodes[nodeIdx];
  const cfg = node?.anchorageConfig || { cost: { fuel: 16, steel: 14, silver: 15 }, healPct: 0.35, arBonusHealPct: 0.25, moraleGain: 22 };

  const memberIds =
    Array.isArray(run.fleetMemberIds) && run.fleetMemberIds.length > 0 ? run.fleetMemberIds : [run.characterId];
  const fleetMembers = memberIds.map((id) => entities.get(id)).filter(Boolean);
  const char = fleetMembers[0] || getFlagship();
  const hasAR = fleetMembers.some((m) => resolveShipClass(m.meta?.shipType) === 'AR');

  if (mode === 'ar_free' && hasAR) {
    let totalHeal = 0;
    for (const m of fleetMembers) {
      const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(m.id, 'maxHp', { round: 'round' }).final));
      const curHp = Math.round(Number(m.stats.hp ?? effMaxHp));
      const healAmt = Math.max(6, Math.round(effMaxHp * (cfg.arBonusHealPct || 0.25)));
      if (curHp < effMaxHp) {
        entities.adjustStat(m.id, 'hp', healAmt, { min: 0, max: effMaxHp });
        totalHeal += Math.min(healAmt, effMaxHp - curHp);
      }
      entities.adjustStat(m.id, 'morale', 14, { min: 0, max: 100 });
    }
    if (char) await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
    run.reports.unshift({
      id: `anc_ar_${Date.now()}`,
      nodeCode: node.code,
      nodeName: node.name,
      nodeType: '维修舰免费锚地抢修',
      text: `随队维修舰（AR）在「${node.name}」展开工作吊舱免费抢修：全队零消耗恢复耐久 +${totalHeal}、士气 +14！`,
      chips: [{ text: `AR免费维修 +${totalHeal}` }, { text: '士气 +14' }],
      timestamp: Date.now(),
    });
    uiKit.showToast(`维修舰免费锚地整备完成！全队耐久 +${totalHeal} · 零消耗`, 'ok');
  } else if (mode === 'rest') {
    const spend = await resources.spendBatch(cfg.cost, { reason: `临时锚地整备休整（${node.code}）` });
    if (!spend.ok) {
      uiKit.showToast(`资源不足无法锚地补给：${spend.reason}`, 'warn');
      return;
    }
    const totalPct = (cfg.healPct || 0.35) + (hasAR ? cfg.arBonusHealPct || 0.25 : 0);
    let totalHeal = 0;
    for (const m of fleetMembers) {
      const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(m.id, 'maxHp', { round: 'round' }).final));
      const curHp = Math.round(Number(m.stats.hp ?? effMaxHp));
      const healAmt = Math.max(8, Math.round(effMaxHp * totalPct));
      if (curHp < effMaxHp) {
        entities.adjustStat(m.id, 'hp', healAmt, { min: 0, max: effMaxHp });
        totalHeal += Math.min(healAmt, effMaxHp - curHp);
      }
      entities.adjustStat(m.id, 'morale', cfg.moraleGain || 22, { min: 0, max: 100 });
    }
    if (char) await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
    run.reports.unshift({
      id: `anc_${Date.now()}`,
      nodeCode: node.code,
      nodeName: node.name,
      nodeType: '临时锚地休整',
      text: `舰队在「${node.name}」抛锚整备${hasAR ? '（维修舰随队额外加修 +25%）' : ''}：全队恢复耐久 +${totalHeal}、士气 +${cfg.moraleGain || 22}。`,
      chips: [{ text: `耐久 +${totalHeal}` }, { text: `士气 +${cfg.moraleGain || 22}` }],
      timestamp: Date.now(),
    });
    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char?.id || null,
      actorName: char?.name || '',
      title: `[临时锚地] ${node.name} 应急休整完成`,
      detail: `恢复耐久 +${totalHeal} · 士气 +${cfg.moraleGain || 22}${hasAR ? '（含维修舰专精加修）' : ''}`,
    });
    uiKit.showToast(`锚地休整完成！全队耐久 +${totalHeal} · 士气 +${cfg.moraleGain || 22}`, 'ok');
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

/**
 * Build a Random Maritime Encounter story card by automatically pulling from user-imported
 * external JSON story packs (`storyPacks`) whenever available, with rich built-in fallback!
 */
function buildMaritimeEncounterStory({ node, nodeIdx, stepCost, char, memberIds, run, storyPacks }) {
  const allPacks = storyPacks && typeof storyPacks.listPacks === 'function' ? storyPacks.listPacks() : [];
  const customPacks = allPacks.filter((p) => p && !p.builtIn && Array.isArray(p.nodes) && p.nodes.length > 0);
  const candidatePool = customPacks.length > 0 ? customPacks : allPacks.filter((p) => p && Array.isArray(p.nodes) && p.nodes.length > 0);

  if (candidatePool.length > 0) {
    const pickedPack = candidatePool[Math.floor(Math.random() * candidatePool.length)];
    const startNode = pickedPack.nodes.find((n) => n.id === pickedPack.startNodeId) || pickedPack.nodes[0];
    if (startNode) {
      const rawChoices = Array.isArray(startNode.choices) && startNode.choices.length > 0
        ? startNode.choices.slice(0, 3)
        : [
            { label: '上前调查并记录海图情报', text: '舰队抵近查明真相，收获额外补给与好感。' },
            { label: '谨慎警戒并绕航推进', text: '舰队稳妥绕过异象区域，安全继续航程。' },
          ];
      return {
        nodeIndex: nodeIdx,
        node: deepClone(node),
        stepCost: deepClone(stepCost),
        flagshipId: char.id,
        memberIds: [...memberIds],
        isStoryPackEvent: true,
        sourcePackTitle: pickedPack.title || '外置奇遇剧情包',
        title: `${pickedPack.title || '随机海遇'} · 节点 ${node.code}`,
        badge: customPacks.length > 0 ? '外置 JSON 海遇' : '随机海遇事件',
        prompt: String(startNode.text || `舰队在节点 ${node.code}「${node.name}」遭遇奇遇事件：`).replaceAll('{{flagship}}', char.name),
        choices: rawChoices.map((ch, idx) => ({
          id: ch.id || `sp_ch_${idx}`,
          label: String(ch.label || ch.text || `抉择 ${idx + 1}`),
          dcDelta: idx === 0 ? 0 : -2,
          lootMult: idx === 0 ? 1.25 : 0.95,
          crateBonus: idx === 0 ? 0.22 : 0.08,
          safeWeather: idx > 0,
          customReplyText: ch.nextText || ch.reply || '',
          tag: ch.check ? '检定抉择' : idx === 0 ? '深入探索' : '稳健应对',
        })),
        outcome: null,
      };
    }
  }

  // Fallback built-in maritime encounter
  return {
    nodeIndex: nodeIdx,
    node: deepClone(node),
    stepCost: deepClone(stepCost),
    flagshipId: char.id,
    memberIds: [...memberIds],
    isStoryPackEvent: true,
    title: `随机海遇 · 节点 ${node.code}「${node.name}」`,
    badge: '随机海遇事件',
    prompt: `海雾散开时，舰队在节点 ${node.code}「${node.name}」发现一艘发出微弱摩斯电码的旧时代补给浮标船，旗舰「${char.name}」等待你的指示：`,
    choices: [
      {
        id: 'enc_board',
        label: '派遣登临小队检索海图与储备油弹（高收益 + 携带油弹补充）',
        dcDelta: 0,
        lootMult: 1.3,
        crateBonus: 0.25,
        safeWeather: false,
        refillCarried: { fuel: 25, ammo: 25 },
        tag: '登临探索',
      },
      {
        id: 'enc_signal',
        label: '远距离发送友好识别信号并回收外围漂流箱（稳健无风险）',
        dcDelta: -2,
        lootMult: 0.95,
        crateBonus: 0.1,
        safeWeather: true,
        refillCarried: { fuel: 14, ammo: 14 },
        tag: '稳妥回收',
      },
    ],
    outcome: null,
  };
}

async function advanceNextNode() {
  if (sortieState.busy || !sortieState.activeRun) return;
  const run = sortieState.activeRun;
  const {
    entities,
    turnStepper,
    combat,
    storyPacks,
    uiKit,
  } = sortieState.context;

  if (
    combat.isActive() ||
    sortieState.activeNodeStory ||
    run.completed ||
    run.awaitingBranchChoices ||
    run.pendingAnchorage ||
    run.nextNodeIndex >= run.nodes.length
  ) {
    return;
  }

  const memberIds =
    Array.isArray(run.fleetMemberIds) && run.fleetMemberIds.length > 0 ? run.fleetMemberIds : [run.characterId];
  const fleetMembers = memberIds.map((id) => entities.get(id)).filter(Boolean);
  const char = fleetMembers[0] || getFlagship();
  if (!char) return;

  const aliveMembers = fleetMembers.filter((m) => Number(m.stats.hp ?? 0) > 0);
  if (aliveMembers.length === 0) {
    uiKit.showToast('编队全员耐久归零，请点击「返航回港区」并入渠维修', 'error');
    return;
  }

  const heavyDamaged = aliveMembers.filter((m) => {
    const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(m.id, 'maxHp', { round: 'round' }).final));
    return Number(m.stats.hp ?? effMaxHp) / effMaxHp < 0.25;
  });
  if (heavyDamaged.length > 0) {
    const confirmed = await uiKit.confirmDialog({
      title: '大破强行进击风险警告',
      message: `警告：「${heavyDamaged.map((m) => m.name).join('、')}」耐久低于 25% 大破线！强行进击风险极高，建议先返航回港区。确定继续前进吗？`,
      confirmLabel: '强行继续前进',
      cancelLabel: '取消',
      tone: 'danger',
    });
    if (!confirmed) return;
  }

  const nodeIdx = run.nextNodeIndex;
  const node = run.nodes[nodeIdx];
  node.intelRevealed = true;

  // Deduct step fuel from carriedSupplies (NEVER blocks movement — hitting 0 triggers supplyDepleted debuff!)
  const stealthDisc = node.lane === 'stealth' ? 0.85 : 1.0;
  const stepFuel = Math.max(4, Math.round((Number(run.stepCost?.fuel) || 14) * stealthDisc));
  const stepAmmo = isCombatNodeType(node.type) ? Math.max(4, Math.round(Number(run.stepCost?.ammo) || 12)) : 0;
  if (!run.carriedSupplies) {
    run.carriedSupplies = { fuel: 80, ammo: 80, maxFuel: 180, maxAmmo: 180, initialFuel: 80, initialAmmo: 80 };
  }
  run.carriedSupplies.fuel = Math.max(0, Math.round(run.carriedSupplies.fuel - stepFuel));
  run.carriedSupplies.ammo = Math.max(0, Math.round(run.carriedSupplies.ammo - stepAmmo));
  const becameDepleted =
    !run.supplyDepleted && (run.carriedSupplies.fuel <= 0 || run.carriedSupplies.ammo <= 0);
  run.supplyDepleted = run.carriedSupplies.fuel <= 0 || run.carriedSupplies.ammo <= 0;
  if (becameDepleted) {
    uiKit.showToast('⚠ 携带油弹耗尽！舰队进入【补给匮乏】状态（攻防机动 -25%，禁止夜战，可返航或使用前线补给）', 'warn');
  }

  const stepCost = { fuel: stepFuel, ammo: stepAmmo };
  turnStepper.advance({ steps: 1, reason: `sortie-node-${node.code}` });

  // Branch A: Temporary Anchorage Node
  if (node.type === NODE_TYPES.ANCHORAGE) {
    run.pendingAnchorage = { nodeIndex: nodeIdx, code: node.code, name: node.name };
    await persistActiveRun();
    uiKit.showToast(`抵达临时锚地「${node.name}」`, 'ok');
    await renderSortieConsole();
    return;
  }

  // Branch B: Combat Node (encounter / elite / boss)
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
      difficulty: run.difficulty || node.difficulty || 'star_1',
      nodeDepthRatio,
      strengthMultiplier: run.enemyStrengthMultiplier || sortieState.enemyStrengthMultiplier || 1.0,
      carriedSupplies: run.carriedSupplies,
      resupplyUsesRemaining: run.resupplyUsesRemaining ?? 2,
    });
    syncSuppliesFromCombatSession(run, startedSession);

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

    await drainPendingEnemyTurnsWithChoreography();
    return;
  }

  // Branch C: Random Maritime Encounter (auto-invokes imported JSON story packs!)
  if (node.type === NODE_TYPES.STORY_EVENT) {
    sortieState.activeNodeStory = buildMaritimeEncounterStory({
      node,
      nodeIdx,
      stepCost,
      char,
      memberIds,
      run,
      storyPacks,
    });
    await renderSortieConsole();
    return;
  }

  // Branch D: Resource Salvage / Weather-Recon Node
  const isWeather = node.type === NODE_TYPES.WEATHER;
  const seaName = run.seaCondition?.label || '常规海况';
  const baseDc = Number(node.dc) || 12;
  const statKey = node.statKey || (isWeather ? 'recon' : 'recon');
  const statLabel = CORE_STAT_DEFS.find((d) => d.key === statKey)?.label || '侦查';

  sortieState.activeNodeStory = {
    nodeIndex: nodeIdx,
    node: deepClone(node),
    stepCost: deepClone(stepCost),
    flagshipId: char.id,
    memberIds: [...memberIds],
    title: isWeather
      ? `气象侦察 · 节点 ${node.code}「${node.name}」`
      : `海上打捞 · 节点 ${node.code}「${node.name}」`,
    badge: isWeather ? '海域气象点' : '海上物资打捞',
    prompt: isWeather
      ? `舰队驶入节点 ${node.code}「${node.name}」（海况：${seaName}）。前方气象突变，旗舰「${char.name}」请求指示：`
      : `声呐在节点 ${node.code}「${node.name}」发现漂流油弹补给桶与拆解余料（海况：${seaName}），旗舰「${char.name}」已带队就位：`,
    choices: isWeather
      ? [
          {
            id: 'weather_brave',
            label: `破雾抵近测绘（${statLabel} DC ${baseDc} · 高额奖励与全队好感）`,
            dcDelta: 0,
            lootMult: 1.28,
            crateBonus: 0.16,
            safeWeather: false,
            tag: '高收益',
          },
          {
            id: 'weather_safe',
            label: `稳健绕行测绘（${statLabel} DC ${Math.max(8, baseDc - 2)} · 零损伤）`,
            dcDelta: -2,
            lootMult: 0.9,
            crateBonus: 0.0,
            safeWeather: true,
            tag: '稳健保船',
          },
        ]
      : [
          {
            id: 'res_deep',
            label: `深层打捞并补充携带油弹（${statLabel} DC ${baseDc} · 油弹补充 + 余料 + 装备箱）`,
            dcDelta: 0,
            lootMult: 1.25,
            crateBonus: 0.2,
            safeWeather: false,
            refillCarried: node.salvageCarriedRefill || { fuel: 28, ammo: 24, salvageParts: 2 },
            tag: '深层打捞',
          },
          {
            id: 'res_quick',
            label: `快速回收漂流补给（${statLabel} DC ${Math.max(8, baseDc - 2)} · 稳补携带油弹）`,
            dcDelta: -2,
            lootMult: 0.92,
            crateBonus: 0.05,
            safeWeather: true,
            refillCarried: {
              fuel: Math.round((node.salvageCarriedRefill?.fuel || 24) * 0.65),
              ammo: Math.round((node.salvageCarriedRefill?.ammo || 20) * 0.65),
              salvageParts: 1,
            },
            tag: '快速补给',
          },
        ],
    outcome: null,
  };

  await renderSortieConsole();
}

async function resolveActiveNodeStoryChoice(choiceIdx) {
  if (sortieState.busy || !sortieState.activeRun || !sortieState.activeNodeStory) return;
  const story = sortieState.activeNodeStory;
  if (story.outcome) return;
  const choice = story.choices[Number(choiceIdx)] || story.choices[0];
  if (!choice) return;

  const run = sortieState.activeRun;
  const nodeIdx = story.nodeIndex;
  const node = run.nodes[nodeIdx] || story.node;
  const stepCost = story.stepCost || { fuel: 0, ammo: 0 };
  const {
    entities,
    statRules,
    resources,
    narrative,
    formation,
    commander,
    inventory,
    rootStorage,
    logs,
    bus,
    uiKit,
  } = sortieState.context;

  const memberIds = story.memberIds || run.fleetMemberIds || [run.characterId];
  const fleetMembers = memberIds.map((id) => entities.get(id)).filter(Boolean);
  const char = fleetMembers[0] || getFlagship();
  const aliveMembers = fleetMembers.filter((m) => Number(m.stats.hp ?? 0) > 0);
  if (!char) return;

  sortieState.busy = true;
  await renderSortieConsole();

  try {
    const fleetSum = formation ? formation.computeFleetSummary(memberIds, run.formationId) : null;
    const statKey = node.statKey || 'recon';
    const baseVal = fleetSum
      ? Math.round((fleetSum.totals?.[statKey] || fleetSum.totals?.recon || 20) / Math.max(1, fleetSum.aliveCount))
      : Number(char.stats[statKey] ?? 20);
    const effVal = fleetSum
      ? Number(fleetSum.checkRatings?.[statKey] ?? fleetSum.checkRatings?.recon ?? baseVal)
      : entities.getEffectiveStat(char.id, statKey, { round: 'round' }).final;
    const eqCheckBonus = fleetSum ? fleetSum.avgCheckBonus : 0;
    const avgMorale = fleetSum ? fleetSum.avgMorale : Number(char.stats.morale ?? 70);
    const seaBonus = run.seaCondition?.mods?.checkBonus || 0;
    const cmdLuck = commander ? commander.getLuck() : 0;
    const luckDropBonus = commander ? commander.getLuckEffects().rareDropBonus : 0;
    const effectiveDc = Math.max(6, (Number(node.dc) || 11) + (Number(choice.dcDelta) || 0));

    const checkResult = statRules.performCheck({
      actorId: char.id,
      actorName: fleetMembers.length > 1 ? `${char.name}等${fleetMembers.length}舰` : char.name,
      statKey,
      baseStatValue: baseVal,
      effectiveStatValue: effVal,
      equipmentCheckBonus: eqCheckBonus,
      moraleValue: avgMorale,
      dc: effectiveDc,
      extraModifier: seaBonus,
      commanderLuck: cmdLuck,
    });

    const isSuccess = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
    const dropMult = typeof resources.getDropMultiplier === 'function' ? resources.getDropMultiplier() : 1.0;
    const choiceLootMult = Number(choice.lootMult) || 1.0;
    const mult =
      (checkResult.outcome === 'crit-success' ? 1.4 : isSuccess ? 1.0 : 0.6) *
      choiceLootMult *
      dropMult *
      (1 + Math.max(-0.2, luckDropBonus));
    const chips = [
      ...(stepCost.fuel > 0 ? [{ text: `携带油 -${stepCost.fuel}`, negative: true }] : []),
    ];
    const gained = {};

    // Direct Carried Supply Refill & Salvage Parts on Salvage / Encounter nodes!
    if (choice.refillCarried && run.carriedSupplies) {
      const fAdd = Math.round((choice.refillCarried.fuel || 0) * (isSuccess ? 1 : 0.6));
      const aAdd = Math.round((choice.refillCarried.ammo || 0) * (isSuccess ? 1 : 0.6));
      if (fAdd > 0) {
        const before = run.carriedSupplies.fuel;
        run.carriedSupplies.fuel = Math.min(run.carriedSupplies.maxFuel, before + fAdd);
        const diff = run.carriedSupplies.fuel - before;
        if (diff > 0) chips.push({ text: `携带油 +${diff}`, negative: false });
      }
      if (aAdd > 0) {
        const before = run.carriedSupplies.ammo;
        run.carriedSupplies.ammo = Math.min(run.carriedSupplies.maxAmmo, before + aAdd);
        const diff = run.carriedSupplies.ammo - before;
        if (diff > 0) chips.push({ text: `携带弹 +${diff}`, negative: false });
      }
      run.supplyDepleted = run.carriedSupplies.fuel <= 0 || run.carriedSupplies.ammo <= 0;
      const partsGain = Math.max(0, Math.round(choice.refillCarried.salvageParts || 0));
      if (partsGain > 0 && inventory && typeof inventory.addSalvageParts === 'function') {
        await inventory.addSalvageParts(partsGain);
        chips.push({ text: `拆解余料 +${partsGain}`, negative: false });
      }
    }

    for (const [rk, rawVal] of Object.entries(node.loot || {})) {
      const val = Math.round((Number(rawVal) || 0) * mult);
      if (val <= 0) continue;
      await resources.add(rk, val, { reason: `节点 ${node.code}·${node.name} 收获` });
      run.loot[rk] = (run.loot[rk] || 0) + val;
      gained[rk] = val;
      chips.push({ text: `${resources.get(rk)?.name || rk} +${val}`, negative: false });
    }

    const baseCrate = (node.type === NODE_TYPES.RESOURCE || node.type === NODE_TYPES.STORY_EVENT ? 0.38 : 0.22) + (Number(choice.crateBonus) || 0);
    const salvageCrateChance = Math.min(0.95, baseCrate * dropMult);
    if (isSuccess && inventory && typeof inventory.rollLootDropItem === 'function' && Math.random() < salvageCrateChance) {
      const dropped = await inventory.rollLootDropItem({
        tier: 'resource',
        difficulty: run.difficulty || node.difficulty || 'star_1',
        dropMultiplier: dropMult,
      });
      if (dropped) {
        chips.push({ text: `装备箱：${dropped.name}`, negative: false });
      }
    }

    const affMult = commander ? commander.getAffinityGainMultiplier() : 1.0;
    if (isSuccess) {
      const aff = Math.max(1, Math.round((Number(node.affinityGain) || 2) * affMult));
      for (const m of aliveMembers) {
        entities.adjustStat(m.id, 'affinity', aff, { min: 0, max: 100 });
        entities.adjustStat(m.id, 'morale', 5, { min: 0, max: 100 });
      }
      chips.push({ text: `全队好感 +${aff}`, negative: false });
    } else if (node.type === NODE_TYPES.WEATHER && !choice.safeWeather) {
      const dmg = Math.max(3, Math.round((Number(node.failDamage?.hp) || 5) * 0.6));
      const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(char.id, 'maxHp', { round: 'round' }).final));
      entities.adjustStat(char.id, 'hp', -dmg, { min: 0, max: effMaxHp });
      chips.push({ text: `海况损耗 ${char.name} HP -${dmg}`, negative: true });
    }

    if (commander) {
      const expGain = 16;
      await commander.grantExp(expGain, `出征节点 ${node.code}`);
      chips.push({ text: `指挥官 EXP +${expGain}`, negative: false });
    }

    if (statRules && typeof statRules.grantShipExp === 'function') {
      const shipNodeExp = 24;
      for (const m of aliveMembers) {
        const sr = statRules.grantShipExp(entities, m.id, shipNodeExp, {
          reason: `出征节点 ${node.code}`,
          inventory,
        });
        if (sr?.leveledUp) {
          chips.push({ text: `★ ${sr.characterName} 升至 Lv.${sr.afterLevel}`, negative: false });
        }
      }
    }

    await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
    const lootText = formatLootSummary(gained, resources);

    const customLine = choice.customReplyText ? `${choice.customReplyText} ` : '';
    const rendered = await narrative.run({
      template: isSuccess
        ? `${customLine}【节点 {nodeCode} · {nodeName}】{actor.name}执行「{choiceTag}」顺利完成（{check.total} vs DC {check.dc}），收获：{lootText}。`
        : `${customLine}【节点 {nodeCode} · {nodeName}】{actor.name}在「{choiceTag}」中稳妥回收了部分物资：{lootText}。`,
      variables: {
        nodeCode: node.code,
        nodeName: node.name,
        choiceTag: choice.tag || choice.label,
        actor: { name: fleetMembers.length > 1 ? `${char.name}等${fleetMembers.length}舰` : char.name },
        lootText,
        check: checkResult,
      },
      polishInstruction: `请简短润色节点 ${node.code} 的海域事件结果，保留数字：`,
    });

    resolveNextStepAfterNode(run, nodeIdx);

    const reportRecord = {
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
    };
    run.reports.unshift(reportRecord);

    story.outcome = {
      passed: isSuccess,
      choiceLabel: choice.label,
      text: rendered.text,
      check: reportRecord.check,
      chips,
    };

    await persistActiveRun();
    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char.id,
      actorName: char.name,
      title: `[${char.name}等] 节点 ${node.code}·${node.name}`,
      detail: `${choice.tag || ''} · 收获：${lootText}`,
    });
    bus.emit('sortie:node-resolved', { routeId: run.routeId, nodeCode: node.code, completed: run.completed });
    uiKit.showToast(`节点 ${node.code} 结算完成：${lootText}`, isSuccess ? 'ok' : 'info');
  } finally {
    sortieState.busy = false;
    await renderSortieConsole();
  }
}

// ============================================================
// Tactical Combat Outcome & 100% Safe Retreat
// ============================================================

async function finalizeBattleOutcome(session) {
  const run = sortieState.activeRun;
  if (!run || !session) return;
  syncSuppliesFromCombatSession(run, session);
  const { combat, entities, resources, statRules, commander, rootStorage, logs, bus, uiKit } = sortieState.context;
  const nodeIdx = run.nextNodeIndex;
  const node = run.nodes[nodeIdx];
  const memberIds =
    Array.isArray(run.fleetMemberIds) && run.fleetMemberIds.length > 0 ? run.fleetMemberIds : [run.characterId];
  const fleetMembers = memberIds.map((id) => entities.get(id)).filter(Boolean);
  const char = fleetMembers[0] || getFlagship();

  if (session.status === 'retreated') {
    sortieState.postBattleSettlement = {
      sessionSnapshot: deepClone(session),
      headline: `已从节点 ${node?.code || ''} 100% 安全撤退`,
      badge: '安全脱离',
      tone: 'warn',
      summary: `已放弃本场未完成战斗战利品，完整保留当前舰队耐久与剩余携带油弹（油 ${Math.round(run.carriedSupplies?.fuel ?? 0)} / 弹 ${Math.round(run.carriedSupplies?.ammo ?? 0)}）。返港时未消耗油弹将 100% 退回港区仓库！`,
      continueLabel: '返回雷达海图（可继续航行或立即返航）',
    };
    logs.add({
      category: LOG_CATEGORIES.SYSTEM,
      actorId: char?.id || null,
      actorName: char?.name || '',
      title: `[${char?.name || ''}等] 节点 ${node?.code || ''} 100% 安全撤退`,
      detail: `保留当前耐久与剩余携带油 ${Math.round(run.carriedSupplies?.fuel ?? 0)} / 弹 ${Math.round(run.carriedSupplies?.ammo ?? 0)}`,
    });
    uiKit.showToast('已 100% 安全撤离当前战斗！保留耐久与剩余携带油弹', 'ok');
  } else if (session.status === 'victory' || session.status === 'bypassed' || session.status === 'day_ended') {
    const gained = {};
    const luckDropBonus = commander ? commander.getLuckEffects().rareDropBonus : 0;
    const affMult = commander ? commander.getAffinityGainMultiplier() : 1.0;
    const rewardFactor = session.status === 'victory' ? 1.0 : session.status === 'day_ended' ? 0.55 : 0;

    const { routeGenerator, inventory } = sortieState.context;
    const lootBonus = Math.max(0.8, Number(session.lootBonus) || 1.0);
    const diffId = normalizeStarTierId(run.difficulty || node?.difficulty || 'star_1');
    const patrolYieldMult =
      routeGenerator && typeof routeGenerator.getPatrolYieldMultiplier === 'function'
        ? routeGenerator.getPatrolYieldMultiplier(diffId)
        : 1.0;
    const dropMult = typeof resources.getDropMultiplier === 'function' ? resources.getDropMultiplier() : 1.0;
    const droppedItems = [];
    let seaControlNote = '';

    if (rewardFactor > 0) {
      for (const [rk, rawVal] of Object.entries(node.loot || {})) {
        const val = Math.round(
          (Number(rawVal) || 0) * rewardFactor * lootBonus * patrolYieldMult * (1 + Math.max(-0.2, luckDropBonus))
        );
        if (val <= 0) continue;
        await resources.add(rk, val, { reason: `节点 ${node.code}·${node.name} 战利品` });
        run.loot[rk] = (run.loot[rk] || 0) + val;
        gained[rk] = val;
      }

      if (session.status === 'victory' && inventory && typeof inventory.rollLootDropItem === 'function') {
        const tierKey =
          node.type === NODE_TYPES.BOSS ? 'boss' : node.type === NODE_TYPES.ELITE ? 'elite' : 'encounter';
        const baseChance = tierKey === 'boss' || tierKey === 'elite' ? 1.0 : Math.min(1.0, 0.72 * dropMult);
        if (Math.random() < baseChance) {
          const item1 = await inventory.rollLootDropItem({
            tier: tierKey,
            difficulty: diffId,
            dropMultiplier: dropMult,
          });
          if (item1) droppedItems.push(item1);
        }
        const bonusChance = tierKey === 'boss' ? Math.min(0.95, 0.55 * dropMult) : tierKey === 'elite' ? Math.min(0.8, 0.25 * dropMult) : 0;
        if (bonusChance > 0 && Math.random() < bonusChance) {
          const item2 = await inventory.rollLootDropItem({
            tier: tierKey,
            difficulty: diffId,
            dropMultiplier: dropMult,
          });
          if (item2) droppedItems.push(item2);
        }
      }

      if (
        session.status === 'victory' &&
        node.type === NODE_TYPES.BOSS &&
        routeGenerator &&
        typeof routeGenerator.recordBossVictory === 'function'
      ) {
        const scRes = await routeGenerator.recordBossVictory(diffId, {
          isNight: Boolean(session.victoryInNight || session.phase === 'night'),
        });
        if (scRes) {
          seaControlNote = scRes.newlyUnlockedZone
            ? ` · ★ 「${scRes.zoneName}」制海权 100%！已解锁「${scRes.newlyUnlockedZone.name}」`
            : scRes.newlyControlled
            ? ` · ★ 「${scRes.zoneName}」制海权 100% 达成！`
            : ` · 「${scRes.zoneName}」制海权推进至 ${scRes.after}%`;
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
            inventory,
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
      droppedItems.length > 0 ? ` · 缴获：${droppedItems.map((d) => d.name).join('、')}` : '';

    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char?.id || null,
      actorName: char?.name || '',
      title: `[${char?.name || ''}等] 节点 ${node.code}·${node.name} ${
        session.status === 'victory' ? '交战胜利' : session.status === 'day_ended' ? '昼战收兵' : '迂回通过'
      }`,
      detail: rewardFactor > 0 ? `战利品：${lootText}${dropCrateText}${seaControlNote}` : '全队无伤绕过敌方封锁',
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
          ? `获得战利品：${lootText}${dropCrateText}${seaControlNote}。${run.completed ? '已击破本海域全部目标，可凯旋返航！' : '可返回分岔海图继续推进或直达船坞整备。'}`
          : '全队保持完整耐久绕过封锁，可继续推进海图。',
      continueLabel: run.completed ? '返回海图并凯旋返航' : '继续雷达海图航行',
    };

    uiKit.showToast(
      session.status === 'victory' ? `战斗胜利！${lootText}${dropCrateText}${seaControlNote}` : `节点 ${node.code} 战斗已结算`,
      'ok'
    );
  } else if (session.status === 'defeated') {
    sortieState.postBattleSettlement = {
      sessionSnapshot: deepClone(session),
      headline: '编队失利 · 紧急脱离',
      badge: '急需入渠',
      tone: 'danger',
      summary: '编队全员耐久耗尽，剩余未消耗携带油弹将在返航时 100% 退回港区仓库。',
      continueLabel: '返回海图准备返航',
    };
    uiKit.showToast('编队全员耐久归零！建议立即返航回港区入渠维修', 'error');
  }

  combat.clearSession();
  if (char) {
    await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
  }
  await persistActiveRun();
}

async function handleBattleSafeRetreat() {
  const { combat, uiKit } = sortieState.context || {};
  if (!combat || !combat.isActive()) return;
  const ok = await uiKit.confirmDialog({
    title: '确认 100% 安全撤退（逃跑）？',
    message: '撤退 100% 成功，保留当前舰队耐久与剩余携带油弹，仅放弃本场未完成战斗的战利品。',
    confirmLabel: '确认安全撤退',
    cancelLabel: '继续战斗',
    tone: 'warn',
  });
  if (!ok) return;
  sortieState.autoRunning = false;
  const res = combat.retreatFromCombat();
  if (res.ok && res.session) {
    await finalizeBattleOutcome(res.session);
  }
  await renderSortieConsole();
}

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
      syncSuppliesFromCombatSession(run, session);
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
        session.status === 'defeated' ||
        session.status === 'retreated'
      ) {
        sortieState.autoRunning = false;
        await finalizeBattleOutcome(session);
        break;
      } else if (session.status === 'night_prompt') {
        sortieState.autoRunning = false;
        uiKit.showToast(
          session.supplyDepleted ? '昼战结束（补给匮乏禁止夜战）' : '昼战结束！请抉择是否追击进入夜战',
          'warn'
        );
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
    syncSuppliesFromCombatSession(run, session);
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
      session.status === 'defeated' ||
      session.status === 'retreated'
    ) {
      sortieState.autoRunning = false;
      await finalizeBattleOutcome(session);
    } else if (session.status === 'night_prompt') {
      sortieState.autoRunning = false;
      uiKit.showToast(
        session.supplyDepleted ? '昼战结束（补给匮乏禁止夜战）' : '昼战结束！请抉择是否追击进入夜战',
        'warn'
      );
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
  uiKit.showToast('本回合托管启动（自动调度抢修/补给与火力输出）', 'ok');
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
  uiKit.showToast('★ 追击进入夜战！交战拉近至近距离，雷击与近战大幅强化', 'ok');
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
  const { entities, resources, formation, commander, logs, bus, rootStorage, uiKit } = sortieState.context;
  const runIds = sortieState.activeRun?.fleetMemberIds;
  const members =
    Array.isArray(runIds) && runIds.length > 0
      ? runIds.map((id) => entities.get(id)).filter(Boolean)
      : formation
      ? formation.getMembers()
      : [getFlagship()].filter(Boolean);
  if (members.length === 0) return;

  const discount = commander && typeof commander.getLogisticsDiscount === 'function' ? commander.getLogisticsDiscount() : 0;
  let fuelNeed = 0;
  let ammoNeed = 0;
  let needCount = 0;

  for (const m of members) {
    const maxAp = Number(m.stats.maxAp ?? 100);
    const curAp = Math.round(Number(m.stats.ap ?? maxAp));
    const curMorale = Math.round(Number(m.stats.morale ?? 80));
    const missingAp = Math.max(0, maxAp - curAp);
    const missingMorale = Math.max(0, 85 - curMorale);
    if (missingAp > 0 || missingMorale > 0) {
      needCount += 1;
      fuelNeed += Math.max(8, Math.ceil(missingAp * 0.45 + missingMorale * 0.2));
      ammoNeed += Math.max(6, Math.ceil(missingAp * 0.35 + missingMorale * 0.15));
    }
  }

  if (needCount === 0) {
    uiKit.showToast('全队油弹与士气均已饱满，无需补给', 'info');
    return;
  }

  const mult = Math.max(0.55, 1 - discount);
  const cost = {
    fuel: Math.max(5, Math.round(fuelNeed * mult)),
    ammo: Math.max(5, Math.round(ammoNeed * mult)),
  };
  const spend = await resources.spendBatch(cost, { reason: '战后全队一键补给油弹' });
  if (!spend.ok) {
    uiKit.showToast(`油弹补给失败：${spend.reason}`, 'warn');
    return;
  }

  for (const m of members) {
    const maxAp = Number(m.stats.maxAp ?? 100);
    entities.setStat(m.id, 'ap', maxAp, { min: 0, max: maxAp });
    entities.adjustStat(m.id, 'morale', 15, { min: 0, max: 100 });
  }
  await persistCharacterRoster({ storage: rootStorage, entities });
  if (logs) {
    logs.add({
      category: LOG_CATEGORIES.RESOURCE,
      title: `全队一键补给油弹（${members.length} 舰）`,
      detail: `消耗燃油 ${cost.fuel} / 弹药 ${cost.ammo}，全员行动点已补满且士气 +15`,
    });
  }
  bus.emit('port:serviced', { action: 'quick-resupply', count: members.length, cost });
  uiKit.showToast(`全队 ${members.length} 舰油弹补给完成（消耗 油${cost.fuel} / 弹${cost.ammo}）`, 'ok');
  await renderSortieConsole();
}

async function performQuickAutoDockDamaged() {
  const { buildings, entities, formation, rootStorage, uiKit } = sortieState.context;
  if (!buildings || typeof buildings.autoDockDamagedShipgirls !== 'function') {
    uiKit.showToast('船坞系统尚未就绪', 'warn');
    return;
  }
  const runIds = sortieState.activeRun?.fleetMemberIds;
  const memberIds =
    Array.isArray(runIds) && runIds.length > 0
      ? runIds
      : formation
      ? formation.getMemberIds()
      : [getFlagship()?.id].filter(Boolean);

  const res = await buildings.autoDockDamagedShipgirls(memberIds);
  await persistCharacterRoster({ storage: rootStorage, entities });

  if (res.docked.length > 0) {
    uiKit.showToast(`已将 ${res.docked.length} 名受损舰娘送入船坞维修（剩余渠位 ${res.freeBaysLeft}）`, 'ok');
  } else if (res.skippedFull.length > 0) {
    uiKit.showToast(`船坞维修渠位已满（${res.capacity}/${res.capacity}）`, 'warn');
  } else if (res.skippedResource.length > 0) {
    uiKit.showToast(`入渠失败：${res.skippedResource[0].reason}`, 'warn');
  } else {
    uiKit.showToast('参战舰娘均处于满耐久或已在船坞中', 'info');
  }
  await renderSortieConsole();
}

/**
 * Return to Port: 100% refunds ALL remaining unused carried Fuel & Ammo back into Port Warehouse!
 */
async function retreatToPort({ stayInSortiePrep = false } = {}) {
  const { resources, combat, logs, bus, modules, uiKit } = sortieState.context;
  const run = sortieState.activeRun;
  combat.clearSession();
  if (run) {
    const refundFuel = Math.max(0, Math.round(Number(run.carriedSupplies?.fuel) || 0));
    const refundAmmo = Math.max(0, Math.round(Number(run.carriedSupplies?.ammo) || 0));
    if (refundFuel > 0) {
      await resources.add('fuel', refundFuel, { reason: `返港 100% 退回未消耗携带燃油（${run.routeName}）` });
    }
    if (refundAmmo > 0) {
      await resources.add('ammo', refundAmmo, { reason: `返港 100% 退回未消耗携带弹药（${run.routeName}）` });
    }
    const refundNote =
      refundFuel > 0 || refundAmmo > 0
        ? ` · 100% 退回剩余携带 油+${refundFuel} / 弹+${refundAmmo}`
        : '';
    const haul = formatLootSummary(run.loot, resources);
    logs.add({
      category: LOG_CATEGORIES.SYSTEM,
      actorId: run.characterId,
      actorName: run.characterName,
      title: `[${run.characterName}] ${run.completed ? '凯旋返航' : '携战利品返航'}（${run.routeName}）`,
      detail: `已通关 ${run.clearedIndices.length}/${run.nodes.length} 节点 | 累计打捞：${haul}${refundNote}`,
    });
    sortieState.activeRun = null;
    sortieState.activeNodeStory = null;
    sortieState.postBattleSettlement = null;
    sortieState.prepStage = 'prep';
    await persistActiveRun();
    bus.emit('sortie:returned', { routeId: run.routeId, completed: run.completed, haul, refundFuel, refundAmmo });
    uiKit.showToast(`已返航回港区！累计打捞：${haul}${refundNote}`, 'ok');
  }
  if (!stayInSortiePrep && modules.has('port-hub')) {
    modules.mount('port-hub');
  } else {
    await renderSortieConsole();
  }
}

// ============================================================
// Radar Sea-Chart SVG Helper
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
  wrap.dataset.noSwipe = 'true';

  const clearedSet = new Set(clearedIndices);
  const hasBranches = nodes.some((n) => n.lane === 'assault' || n.lane === 'stealth' || (Array.isArray(n.nextCodes) && n.nextCodes.length >= 2));
  const maxCol = Math.max(1, ...nodes.map((n, idx) => (typeof n.col === 'number' ? n.col : idx)));
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
    }
  }

  const activePt = nextNodeIndex >= 0 && nextNodeIndex < pts.length ? pts[nextNodeIndex] : null;
  const activeCol = activePt ? (typeof activePt.node.col === 'number' ? activePt.node.col : activePt.idx) : -1;

  wrap.innerHTML = `
    <div class="radar-chart-header">
      <span class="radar-chart-title">${hasBranches ? '分岔雷达海图（上:强攻 / 下:探索）' : '战术海图 · 雷达航迹'}</span>
      <span class="radar-chart-vision">${nodes.length}节点 · 视野${visionRange}格</span>
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
            : p.node.type === NODE_TYPES.STORY_EVENT
            ? '#c084fc'
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

    const laneTag = node.lane === 'assault' ? '强攻' : node.lane === 'stealth' ? '探索' : '';
    const step = document.createElement('div');
    step.className = `radar-node sortie-node-step ${isCleared ? 'is-cleared' : ''} ${
      isCurrent ? 'is-current' : ''
    } ${node.type === NODE_TYPES.BOSS && !isFogged ? 'is-boss' : ''} ${
      node.type === NODE_TYPES.ANCHORAGE && !isFogged ? 'is-anchorage' : ''
    } ${isFogged ? 'is-fogged' : ''}`;
    step.dataset.nodeCode = node.code;
    step.innerHTML = isFogged
      ? `<span class="sortie-node-code">${escapeHtml(node.code)}</span><span class="sortie-node-type">${laneTag ? `${laneTag}·` : ''}迷雾</span><span class="sortie-node-name">???</span>`
      : `<span class="sortie-node-code">${isCleared ? '✓' : escapeHtml(node.code)}</span><span class="sortie-node-type">${laneTag ? `${laneTag}·` : ''}${escapeHtml(NODE_TYPE_LABELS[node.type] || node.type)}</span><span class="sortie-node-name">${escapeHtml(node.name)}</span>`;
    grid.appendChild(step);
  });

  return wrap;
}

// ============================================================
// Root 3-Stage View Renderer
// ============================================================

async function renderSortieConsole() {
  if (!sortieState.container || !sortieState.context) return;
  const {
    assets,
    entities,
    resources,
    statRules,
    inventory,
    personalityPool,
    narrative,
    routeGenerator,
    combat,
    formation,
    commander,
    fxStage,
    theme,
    modules,
    ui,
    uiKit,
  } = sortieState.context;

  const char = getFlagship();
  if (!char) {
    ui.setImmersiveBattle(false);
    ui.setStageMode?.('chart');
    sortieState.container.innerHTML = `
      <section class="surface-card">
        <h2 class="section-title">暂无可用出征编队</h2>
        <p class="muted-text">请先前往编成页面部署至少 1 名适航舰娘入队。</p>
      </section>
    `;
    return;
  }

  const runMemberIds = sortieState.activeRun?.fleetMemberIds || null;
  const runFormationId = sortieState.activeRun?.formationId || null;
  const fleetSummary = formation ? formation.computeFleetSummary(runMemberIds, runFormationId) : null;

  // ============================================================
  // MODE 1: IMMERSIVE IN-PLACE TACTICAL BATTLE STAGE (Stage 3 Combat)
  // ============================================================
  const activeCombatSession = combat.isInBattleScreen() ? combat.getSession() : null;
  if (activeCombatSession || sortieState.postBattleSettlement) {
    ui.setImmersiveBattle(true);
    ui.setStageMode?.('battle');
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
      inspectedEnemyId: sortieState.inspectedEnemyId,
      highlightedAllyId: sortieState.highlightedAllyId,
      fxStage,
      uiKit,
      settlementInfo: activeCombatSession ? null : sortieState.postBattleSettlement,
      onSelectTarget: (enemyId, opts = {}) => {
        combat.setTargetEnemy(enemyId);
        if (opts?.openIntel) {
          sortieState.inspectedEnemyId = enemyId;
          sortieState.highlightedAllyId = null;
        }
        renderSortieConsole();
      },
      onInspectEnemy: (enemyId) => {
        sortieState.inspectedEnemyId = enemyId;
        sortieState.highlightedAllyId = null;
        renderSortieConsole();
      },
      onClearInspectEnemy: () => {
        sortieState.inspectedEnemyId = null;
        renderSortieConsole();
      },
      onHighlightAlly: (allyId) => {
        sortieState.inspectedEnemyId = null;
        sortieState.highlightedAllyId = sortieState.highlightedAllyId === allyId ? null : allyId;
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
      onRetreat: () => handleBattleSafeRetreat(),
      onEnterNight: () => handleBattleEnterNight(),
      onFinishEarly: () => handleBattleFinishEarly(),
      onPostBattleContinue: () => {
        sortieState.postBattleSettlement = null;
        sortieState.inspectedEnemyId = null;
        sortieState.highlightedAllyId = null;
        ui.setImmersiveBattle(false);
        ui.setStageMode?.('chart');
        renderSortieConsole();
      },
      onPostBattleDockyard: () => {
        sortieState.postBattleSettlement = null;
        sortieState.inspectedEnemyId = null;
        sortieState.highlightedAllyId = null;
        ui.setImmersiveBattle(false);
        openDockyardTacticalModal(sortieState.context);
      },
      onPostBattleResupply: () => performQuickFleetResupply(),
      onPostBattleAutoDock: () => performQuickAutoDockDamaged(),
    });
    return;
  }

  // ============================================================
  // MODE 2: IN-PLACE MARITIME ENCOUNTER / SALVAGE STORY STAGE
  // ============================================================
  if (sortieState.activeNodeStory && sortieState.activeRun) {
    ui.setImmersiveBattle(false);
    ui.setStageMode?.('theatre');
    const story = sortieState.activeNodeStory;
    const storyChar = entities.get(story.flagshipId) || char;
    const storyProg = statRules.ensureShipProgression(storyChar);
    const storyClass = resolveShipClass(storyChar.meta?.shipType);
    const persSum =
      personalityPool && typeof personalityPool.getPersonalitySummary === 'function'
        ? personalityPool.getPersonalitySummary(storyChar)
        : null;
    const primaryTrait = persSum?.primary?.name || '沉稳';

    let flagshipUrl = '';
    if (assets) {
      const avRes = await assets.getAssetUrl(storyChar.meta?.avatarAssetId || null, {
        fallbackSeed: storyChar.id,
        fallbackLabel: storyChar.name.slice(0, 6),
      });
      flagshipUrl = avRes.url;
    }

    const displayText = story.outcome ? story.outcome.text : story.prompt;
    sortieState.container.innerHTML = '';
    const storyWrap = document.createElement('div');
    storyWrap.className = 'sortie-root';
    storyWrap.dataset.noSwipe = 'true';
    storyWrap.innerHTML = `
      <section class="surface-card theatre-stage-card is-sea-encounter" id="sortie-encounter-theatre">
        <div class="theatre-toolbar-row">
          <span class="status-badge badge-ok">${escapeHtml(story.badge)}</span>
          <span class="status-badge badge-muted">${escapeHtml(sortieState.activeRun.routeName || '出征海域')} · 节点 ${escapeHtml(story.node?.code || '')}</span>
        </div>

        <div class="theatre-hero-stage">
          <div class="theatre-portrait-frame">
            <img class="theatre-portrait-img" src="${flagshipUrl}" alt="${escapeHtml(storyChar.name)}">
            <span class="theatre-lv-pill">Lv.${storyProg.level}</span>
          </div>
          <div class="theatre-hero-meta">
            <div class="cc-hero-name-row">
              <span class="ship-class-ico">${getShipClassSvg(storyClass, { size: 20 })}</span>
              <h3 class="cc-hero-name">${escapeHtml(storyChar.name)}</h3>
              <span class="status-badge badge-ok">旗舰</span>
            </div>
            <div class="cc-badge-row">
              <span class="status-badge badge-accent-soft">${escapeHtml(primaryTrait)}</span>
              ${story.sourcePackTitle ? `<span class="status-badge badge-warn">${escapeHtml(story.sourcePackTitle)}</span>` : ''}
            </div>
            <div class="muted-text" style="font-size:12px;">${escapeHtml(story.title)}</div>
          </div>
        </div>

        <div class="theatre-dialogue-box" id="sortie-story-dialogue-box">
          <div class="theatre-speaker-row">
            <span class="theatre-speaker-tag">${escapeHtml(story.outcome ? '海遇结算' : `${storyChar.name} · 舰桥请示`)}</span>
            ${
              story.outcome?.check
                ? `<span class="status-badge ${story.outcome.passed ? 'badge-ok' : 'badge-warn'}">${escapeHtml(story.outcome.check.statLabel)} ${story.outcome.check.total} vs DC ${story.outcome.check.dc}</span>`
                : `<span class="status-badge badge-muted">请选择应对方案</span>`
            }
          </div>
          <div class="theatre-dialogue-text" id="sortie-story-dialogue-text">${escapeHtml(displayText)}</div>
          ${
            story.outcome?.chips?.length
              ? `<div class="cc-badge-row" style="margin-top:8px;">
                  ${story.outcome.chips
                    .map((c) => `<span class="status-badge ${c.negative ? 'badge-danger' : 'badge-ok'}">${escapeHtml(c.text)}</span>`)
                    .join('')}
                </div>`
              : ''
          }
        </div>

        <div class="theatre-choices-stack">
          ${
            story.outcome
              ? `<button type="button" id="btn-sortie-story-return-chart" class="btn-primary uikit-touch-target">返回雷达海图继续航行 →</button>`
              : story.choices
                  .map(
                    (ch, idx) => `
                  <button type="button" class="theatre-choice-btn" data-sea-story-choice="${idx}" ${sortieState.busy ? 'disabled' : ''}>
                    <span class="theatre-choice-label">${escapeHtml(ch.label)}</span>
                    <span class="status-badge badge-ok">${escapeHtml(ch.tag || '执行')}</span>
                  </button>
                `
                  )
                  .join('')
          }
        </div>
      </section>
    `;

    storyWrap.querySelectorAll('[data-sea-story-choice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        resolveActiveNodeStoryChoice(Number(btn.getAttribute('data-sea-story-choice')));
      });
    });
    storyWrap.querySelector('#btn-sortie-story-return-chart')?.addEventListener('click', () => {
      sortieState.activeNodeStory = null;
      ui.setStageMode?.('chart');
      renderSortieConsole();
    });
    sortieState.container.appendChild(storyWrap);
    if (fxStage && typeof fxStage.typewrite === 'function') {
      const dlgEl = storyWrap.querySelector('#sortie-story-dialogue-text');
      const speedMs = theme ? theme.getTypewriterSpeed() : 12;
      if (dlgEl && speedMs > 0) fxStage.typewrite(dlgEl, displayText, { speedMs });
    }
    return;
  }

  // ============================================================
  // THREE-STAGE SORTIE SHELL
  // ============================================================
  ui.setImmersiveBattle(false);
  ui.setStageMode?.('chart');

  const isStage3 = Boolean(sortieState.activeRun);
  const activeStep = isStage3 ? 3 : sortieState.prepStage === 'workshop' ? 2 : 1;

  // Lock horizontal swipe during active voyage or custom map workshop!
  if (ui && typeof ui.setSwipeLocked === 'function') {
    ui.setSwipeLocked(isStage3 || activeStep === 2);
  }

  sortieState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'sortie-root';

  // 3-Stage Stepper Header
  const stepper = document.createElement('div');
  stepper.className = 'sortie-stepper-bar';
  stepper.innerHTML = `
    <button type="button" class="sortie-step-pill ${activeStep === 1 ? 'is-active' : activeStep > 1 ? 'is-done' : ''}" data-step-jump="prep" ${isStage3 ? 'disabled' : ''}>
      <span class="step-no">1</span> 准备出征
    </button>
    <span class="step-arrow">›</span>
    <button type="button" class="sortie-step-pill ${activeStep === 2 ? 'is-active' : activeStep > 2 ? 'is-done' : ''}" data-step-jump="workshop" ${isStage3 ? 'disabled' : ''}>
      <span class="step-no">2</span> 自定义海图工坊
    </button>
    <span class="step-arrow">›</span>
    <span class="sortie-step-pill ${activeStep === 3 ? 'is-active' : ''}">
      <span class="step-no">3</span> 航行与战斗
    </span>
  `;
  stepper.querySelectorAll('[data-step-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (sortieState.activeRun) return;
      sortieState.prepStage = btn.getAttribute('data-step-jump') || 'prep';
      renderSortieConsole();
    });
  });
  root.appendChild(stepper);

  // ============================================================
  // STAGE 3: ACTIVE VOYAGE ON PROCEDURAL RADAR SEA CHART
  // ============================================================
  if (sortieState.activeRun) {
    const run = sortieState.activeRun;
    const visionRange = fleetSummary?.visionRange ?? 2;
    const carried = run.carriedSupplies || { fuel: 0, ammo: 0, maxFuel: 180, maxAmmo: 180 };
    const members = (run.fleetMemberIds || []).map((id) => entities.get(id)).filter(Boolean);
    const hasAR = members.some((m) => resolveShipClass(m.meta?.shipType) === 'AR');
    const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(char.id, 'maxHp', { round: 'round' }).final));
    const curHp = Math.min(effMaxHp, Math.round(Number(char.stats.hp ?? effMaxHp)));
    const isHeavyDamage = curHp / effMaxHp < 0.25;

    const activeCard = document.createElement('section');
    activeCard.className = 'surface-card lab-stack-sm';
    activeCard.id = 'sortie-active-panel';
    activeCard.dataset.noSwipe = 'true';
    activeCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">${escapeHtml(run.routeName)}</h2>
        <span class="status-badge ${run.completed ? 'badge-ok' : run.supplyDepleted ? 'badge-danger' : 'badge-warn'}">
          ${run.completed ? '全节点通关' : run.supplyDepleted ? '⚠ 补给匮乏 -25%' : `进度 ${run.clearedIndices.length}/${run.nodes.length}`}
        </span>
      </div>
      <div class="sortie-carried-hud" id="sortie-carried-hud">
        <span class="status-badge ${carried.fuel <= 0 ? 'badge-danger' : 'badge-ok'}">携带燃油 ${Math.round(carried.fuel)} / ${Math.round(carried.maxFuel)}</span>
        <span class="status-badge ${carried.ammo <= 0 ? 'badge-danger' : 'badge-ok'}">携带弹药 ${Math.round(carried.ammo)} / ${Math.round(carried.maxAmmo)}</span>
        <span class="status-badge badge-muted">前线补给 ${run.resupplyUsesRemaining ?? 2}/2 次</span>
        ${run.seedCode ? `<span class="status-badge badge-muted">种子 ${escapeHtml(run.seedCode)}</span>` : ''}
      </div>
      ${
        run.seaCondition
          ? `<span class="cc-stat-sub">海况：<strong>${escapeHtml(run.seaCondition.label)}</strong> · ${escapeHtml(run.seaCondition.description)}</span>`
          : ''
      }
      <div id="sortie-map-mount"></div>
      <div class="muted-text" style="font-size:12px;" id="sortie-loot-summary">
        累计战利品：<strong>${escapeHtml(formatLootSummary(run.loot, resources))}</strong>（返港时剩余携带油弹 100% 退回港区仓库）
      </div>
    `;
    activeCard.querySelector('#sortie-map-mount').appendChild(
      createRadarSeaChartElement(run.nodes, run.clearedIndices, run.completed ? -1 : run.nextNodeIndex, {
        visionRange,
        enableFog: true,
      })
    );

    if (Array.isArray(run.awaitingBranchChoices) && run.awaitingBranchChoices.length >= 2) {
      const forkBox = document.createElement('div');
      forkBox.className = 'sortie-branch-panel lab-stack-sm';
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
      const ancNode = run.nodes[run.pendingAnchorage.nodeIndex];
      const cfg = ancNode?.anchorageConfig || { cost: { fuel: 16, steel: 14, silver: 15 }, healPct: 0.35, arBonusHealPct: 0.25, moraleGain: 22 };
      const ancBox = document.createElement('div');
      ancBox.className = 'sortie-anchorage-panel lab-stack-sm';
      ancBox.innerHTML = `
        <div class="section-header-row" style="margin-bottom:0;">
          <strong>临时锚地：${escapeHtml(ancNode?.name || '避风锚地')}</strong>
          <span class="status-badge badge-ok">${hasAR ? '★ 维修舰随队专精' : '应急休整点'}</span>
        </div>
        <p class="muted-text" style="font-size:12px; margin:0;">
          消耗少量港区资材（油 ${cfg.cost.fuel} / 钢 ${cfg.cost.steel} / 银 ${cfg.cost.silver}）恢复全队 ${Math.round(((cfg.healPct || 0.35) + (hasAR ? cfg.arBonusHealPct || 0.25 : 0)) * 100)}% 耐久与 +${cfg.moraleGain || 22} 士气。${hasAR ? '随队维修舰（AR）更可触发「零消耗免费应急抢修」恢复 25% 耐久！' : ''}
        </p>
        <div class="lab-btn-grid">
          ${hasAR ? `<button type="button" id="btn-anchorage-ar-free" class="btn-primary uikit-touch-target">★ 维修舰免费抢修 (+25% HP)</button>` : ''}
          <button type="button" id="btn-anchorage-rest" class="${hasAR ? 'btn-secondary' : 'btn-primary'} uikit-touch-target">锚地整备恢复</button>
          <button type="button" id="btn-anchorage-skip" class="btn-secondary uikit-touch-target">免消耗继续航行</button>
        </div>
      `;
      ancBox.querySelector('#btn-anchorage-ar-free')?.addEventListener('click', () => resolveAnchorageAction('ar_free'));
      ancBox.querySelector('#btn-anchorage-rest').addEventListener('click', () => resolveAnchorageAction('rest'));
      ancBox.querySelector('#btn-anchorage-skip').addEventListener('click', () => resolveAnchorageAction('skip'));
      activeCard.appendChild(ancBox);
    } else {
      if (isHeavyDamage && !run.completed) {
        const warn = document.createElement('div');
        warn.className = 'seaworthy-alert';
        warn.textContent = '大破危险状态（HP < 25%）！建议立即点击「返航回港区」（剩余油弹 100% 退回）。';
        activeCard.appendChild(warn);
      }

      const btnStack = document.createElement('div');
      btnStack.className = 'lab-stack-sm';
      if (!run.completed && run.nodes[run.nextNodeIndex]) {
        const nextNode = run.nodes[run.nextNodeIndex];
        const advBtn = document.createElement('button');
        advBtn.type = 'button';
        advBtn.id = 'btn-sortie-advance';
        advBtn.className = 'btn-primary port-cta-btn';
        advBtn.disabled = sortieState.busy;
        advBtn.textContent = `向节点 ${nextNode.code}「${nextNode.name}」进发（携带油 -${run.stepCost.fuel}）`;
        advBtn.addEventListener('click', () => advanceNextNode());
        btnStack.appendChild(advBtn);
      }

      const retBtn = document.createElement('button');
      retBtn.type = 'button';
      retBtn.id = 'btn-sortie-retreat';
      retBtn.className = run.completed ? 'btn-primary port-cta-btn' : 'btn-secondary uikit-touch-target';
      retBtn.textContent = run.completed
        ? `胜利凯旋 · 返航回港（退回剩余 油+${Math.round(carried.fuel)} / 弹+${Math.round(carried.ammo)}）`
        : `撤离返航回港区（100% 退回剩余 油+${Math.round(carried.fuel)} / 弹+${Math.round(carried.ammo)}）`;
      retBtn.addEventListener('click', () => retreatToPort());
      btnStack.appendChild(retBtn);

      const postRow = document.createElement('div');
      postRow.className = 'lab-btn-grid';
      postRow.innerHTML = `
        <button type="button" id="btn-sortie-quick-dock" class="btn-secondary uikit-touch-target">打开船坞维修浮窗</button>
        <button type="button" id="btn-sortie-auto-dock" class="btn-secondary uikit-touch-target">受损舰娘一键入渠</button>
      `;
      postRow.querySelector('#btn-sortie-quick-dock').addEventListener('click', () => openDockyardTacticalModal(sortieState.context));
      postRow.querySelector('#btn-sortie-auto-dock').addEventListener('click', () => performQuickAutoDockDamaged());
      btnStack.appendChild(postRow);
      activeCard.appendChild(btnStack);
    }

    root.appendChild(activeCard);

    // Compact Voyage Reports
    const reportsWrap = document.createElement('div');
    reportsWrap.className = 'ac-timeline';
    for (const rep of (run.reports || []).slice(0, 14)) {
      const card = document.createElement('article');
      card.className = 'ac-card';
      card.innerHTML = `
        <div class="ac-card-head">
          <h3 class="ac-card-title">节点 ${escapeHtml(rep.nodeCode)} · ${escapeHtml(rep.nodeName)}</h3>
          <span class="status-badge badge-muted">${escapeHtml(rep.nodeType)}</span>
        </div>
        <p class="ac-card-body">${escapeHtml(rep.text)}</p>
        <div class="ac-settlement-chips">
          ${(rep.chips || [])
            .map((c) => `<span class="ac-delta-chip ${c.negative ? 'is-neg' : ''}">${escapeHtml(c.text)}</span>`)
            .join('')}
        </div>
      `;
      reportsWrap.appendChild(card);
    }
    root.appendChild(reportsWrap);
    sortieState.container.appendChild(root);
    return;
  }

  // ============================================================
  // STAGE 1: PREPARE SORTIE (Fleet Status + Logistics + Carried Supplies Sliders)
  // ============================================================
  if (activeStep === 1) {
    const caps = getCarriedSupplyCapsForCurrentFleet();
    const cmdProfile = commander ? commander.getProfile() : { name: '指挥官', level: 1, freePoints: 0, stats: { dispatch: 10 } };
    const freePoints = Number(cmdProfile.freePoints || 0);
    const fleetCap = formation ? formation.getFleetCap() : 3;
    const fVal = formation ? formation.validateFleetForSortie() : { ok: true, errors: [], members: [char] };
    const members = fleetSummary?.members || [];
    const mode = narrative.getMode();
    const isAiMode = mode !== NARRATIVE_MODES.LOCAL;

    const prepCard = document.createElement('section');
    prepCard.className = 'surface-card lab-stack-sm';
    prepCard.id = 'sortie-stage1-prep';
    prepCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">第 1 步 · 准备出征与携带油弹装填</h2>
        <button type="button" id="btn-sortie-mode-toggle" class="ac-mode-toggle ${isAiMode ? 'is-ai' : ''}">
          ${isAiMode ? 'AI 润色' : '纯本地模板'}
        </button>
      </div>

      <div class="lab-slot-head">
        <div class="cc-badge-row">
          <span class="status-badge ${fVal.ok ? 'badge-ok' : 'badge-danger'}">${fVal.ok ? '编队适航就绪' : '编队待整备'}</span>
          <span class="status-badge badge-muted">${members.length}/${fleetCap} 舰 · ${escapeHtml(fleetSummary?.formationName || '单纵阵')}</span>
          ${caps.arCount > 0 ? `<span class="status-badge badge-ok">AR 维修舰×${caps.arCount}</span>` : ''}
          ${caps.aoCount > 0 ? `<span class="status-badge badge-ok">AO 补给舰×${caps.aoCount}（携带扩容）</span>` : ''}
        </div>
      </div>

      ${!fVal.ok ? `<div class="seaworthy-alert">${escapeHtml(fVal.errors[0] || '编队未满足适航条件')}</div>` : ''}

      <div class="port-gear-summary">
        ${members
          .map(
            (m, i) => `
          <span class="ns-chip ${m.hp / Math.max(1, m.maxHp) < 0.5 ? 'is-warn' : ''}">
            ${i === 0 ? '★' : `#${i}`}[${escapeHtml(m.classCode || 'DD')}]${escapeHtml(m.name)} ${m.hp}/${m.maxHp}
          </span>
        `
          )
          .join('')}
      </div>

      <div class="lab-btn-grid">
        <button type="button" id="btn-prep-open-dock" class="btn-secondary uikit-touch-target">快速入渠 / 船坞浮窗</button>
        <button type="button" id="btn-prep-goto-formation" class="btn-secondary uikit-touch-target">调整 3×4 舰队编成</button>
      </div>

      <div class="lab-divider"></div>

      <div class="sortie-logistics-box" data-no-swipe="true">
        <div class="lab-slot-head">
          <strong style="font-size:13.5px;">指挥官后勤与随舰携带油弹</strong>
          <span class="status-badge badge-ok">后勤评分 ${caps.logisticsScore} · 携带上限 油${caps.maxFuel}/弹${caps.maxAmmo}</span>
        </div>
        ${
          freePoints > 0
            ? `<div class="lab-slot-head" style="background:rgba(20,184,166,0.1); padding:6px 10px; border-radius:var(--radius-sm); border:1px solid var(--border);">
                <span class="muted-text" style="font-size:12px;">可用指挥官自由属性点：<strong>${freePoints}</strong>（每 +1 后勤调度，随舰油弹上限 +10）</span>
                <button type="button" id="btn-prep-add-logistics" class="btn-primary uikit-touch-target" style="min-height:32px; padding:0 10px; font-size:12px;">+1 后勤加点</button>
              </div>`
            : `<span class="cc-stat-sub">提升指挥官「后勤调度」或编入「补给舰 (AO)」均可大幅扩容随舰携带油弹上限。</span>`
        }

        <div class="sortie-supply-sliders">
          <div class="form-group">
            <div class="form-label-row">
              <label class="form-label" for="prep-fuel-slider">随舰携带燃油（港区库存 ${caps.portFuel}）</label>
              <strong id="prep-fuel-val" class="status-badge badge-ok">${caps.selectedFuel} / ${caps.maxFuel}</strong>
            </div>
            <input id="prep-fuel-slider" class="range-input" type="range" min="0" max="${caps.loadableFuel}" step="5" value="${caps.selectedFuel}" />
          </div>

          <div class="form-group">
            <div class="form-label-row">
              <label class="form-label" for="prep-ammo-slider">随舰携带弹药（港区库存 ${caps.portAmmo}）</label>
              <strong id="prep-ammo-val" class="status-badge badge-ok">${caps.selectedAmmo} / ${caps.maxAmmo}</strong>
            </div>
            <input id="prep-ammo-slider" class="range-input" type="range" min="0" max="${caps.loadableAmmo}" step="5" value="${caps.selectedAmmo}" />
          </div>
        </div>

        <div class="lab-btn-grid">
          <button type="button" id="btn-prep-fill-max" class="btn-secondary uikit-touch-target">一键按上限装填</button>
          <button type="button" id="btn-prep-resupply-ap" class="btn-secondary uikit-touch-target">全队补充士气与AP</button>
        </div>

        <p class="muted-text" style="font-size:11.5px; margin:0;">
          规则说明：出征返航或安全撤退时，<strong>剩余未消耗携带油弹 100% 退回港区仓库</strong>；航行中耗尽仅触发「补给匮乏」（攻防机动 -25%、禁夜战），绝不卡死。
        </p>
      </div>

      <button type="button" id="btn-prep-next-workshop" class="btn-primary port-cta-btn" ${!fVal.ok ? 'disabled' : ''}>
        下一步：进入自定义海图工坊 →
      </button>
    `;

    prepCard.querySelector('#btn-sortie-mode-toggle').addEventListener('click', () => {
      const next = isAiMode ? NARRATIVE_MODES.LOCAL : NARRATIVE_MODES.AI_POLISH;
      narrative.setMode(next);
      uiKit.showToast(next === NARRATIVE_MODES.LOCAL ? '已切换为纯本地离线战报' : '已切换为 AI 润色战报', 'ok');
      renderSortieConsole();
    });
    prepCard.querySelector('#btn-prep-open-dock').addEventListener('click', () => openDockyardTacticalModal(sortieState.context));
    prepCard.querySelector('#btn-prep-goto-formation').addEventListener('click', () => {
      if (modules.has('port-formation')) modules.mount('port-formation', { transition: 'left' });
    });
    prepCard.querySelector('#btn-prep-add-logistics')?.addEventListener('click', async () => {
      try {
        await commander.allocatePoint('dispatch', 1);
        uiKit.showToast('指挥官「调度/后勤」+1！携带油弹上限已提升', 'ok');
        renderSortieConsole();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '加点失败', 'warn');
      }
    });

    const fuelSlider = prepCard.querySelector('#prep-fuel-slider');
    const ammoSlider = prepCard.querySelector('#prep-ammo-slider');
    fuelSlider?.addEventListener('input', () => {
      sortieState.carriedFuel = Number(fuelSlider.value);
      const vEl = prepCard.querySelector('#prep-fuel-val');
      if (vEl) vEl.textContent = `${sortieState.carriedFuel} / ${caps.maxFuel}`;
    });
    ammoSlider?.addEventListener('input', () => {
      sortieState.carriedAmmo = Number(ammoSlider.value);
      const vEl = prepCard.querySelector('#prep-ammo-val');
      if (vEl) vEl.textContent = `${sortieState.carriedAmmo} / ${caps.maxAmmo}`;
    });
    prepCard.querySelector('#btn-prep-fill-max').addEventListener('click', () => {
      sortieState.carriedFuel = caps.loadableFuel;
      sortieState.carriedAmmo = caps.loadableAmmo;
      uiKit.showToast(`已一键装填至上限：油 ${caps.loadableFuel} / 弹 ${caps.loadableAmmo}`, 'ok');
      renderSortieConsole();
    });
    prepCard.querySelector('#btn-prep-resupply-ap').addEventListener('click', () => performQuickFleetResupply());
    prepCard.querySelector('#btn-prep-next-workshop').addEventListener('click', () => {
      sortieState.prepStage = 'workshop';
      renderSortieConsole();
    });

    root.appendChild(prepCard);
    sortieState.container.appendChild(root);
    return;
  }

  // ============================================================
  // STAGE 2: 1★~5★ SEA CONTROL & CUSTOM MAP WORKSHOP
  // ============================================================
  const seaOverview = routeGenerator.getSeaControlOverview();
  const cfg = sortieState.workshopConfig;
  if (!routeGenerator.isSeaZoneUnlocked(`star_${cfg.starLevel}`)) {
    cfg.starLevel = seaOverview.highestUnlockedStar || 1;
  }
  const caps = getCarriedSupplyCapsForCurrentFleet();
  const preview = estimateRouteProfile({
    starLevel: cfg.starLevel,
    scale: cfg.scale,
    seaConditionId: cfg.seaConditionId,
    nodeMix: cfg.nodeMix,
  });
  const curMult = clampEnemyStrengthMultiplier(sortieState.enemyStrengthMultiplier);
  const savedBlueprints = routeGenerator.listCustomRoutes();

  // 2A. 1★~5★ Sea Control Progress Panel
  const seaCard = document.createElement('section');
  seaCard.className = 'surface-card lab-stack-sm';
  seaCard.id = 'sortie-sea-control-card';
  seaCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">1★~5★ 海域制海权压制进度</h2>
      <span class="status-badge ${seaOverview.controlledCount > 0 ? 'badge-ok' : 'badge-muted'}">
        制霸 ${seaOverview.controlledCount}/${seaOverview.totalZones} · 远征 +${seaOverview.totalExpeditionBonusPct}%
      </span>
    </div>
    <div class="sea-control-grid-5">
      ${seaOverview.zones
        .map(
          (z) => `
        <button
          type="button"
          class="sea-star-card ${cfg.starLevel === z.star ? 'is-selected' : ''} ${z.controlled ? 'is-controlled' : z.unlocked ? 'is-unlocked' : 'is-locked'}"
          data-pick-star="${z.star}"
          ${z.unlocked ? '' : 'disabled'}
          title="${escapeHtml(z.unlockHint)}"
        >
          <div class="sea-star-top">
            <strong>${z.unlocked ? `${z.star}★` : `🔒${z.star}★`}</strong>
            <span>${z.progress}%</span>
          </div>
          <div class="uikit-progress-track" style="height:5px;">
            <div class="uikit-progress-fill" data-tone="${z.controlled ? 'ok' : 'accent'}" style="width:${z.progress}%"></div>
          </div>
          <span class="sea-star-name">${escapeHtml(z.name)}</span>
        </button>
      `
        )
        .join('')}
    </div>
    <button type="button" id="btn-workshop-quick-random" class="btn-primary port-cta-btn">
      ⚡ 快速随机 ${cfg.starLevel}★ 海图并立即启航
    </button>
  `;
  seaCard.querySelectorAll('[data-pick-star]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const st = Number(btn.getAttribute('data-pick-star'));
      if (!routeGenerator.isSeaZoneUnlocked(`star_${st}`)) {
        uiKit.showToast('需先将前置星级海域制海权推进至 100% 解锁！', 'warn');
        return;
      }
      cfg.starLevel = st;
      renderSortieConsole();
    });
  });
  seaCard.querySelector('#btn-workshop-quick-random').addEventListener('click', async () => {
    const customEnemies = sortieState.context?.contentManager?.listCustomEnemies() || [];
    const route = routeGenerator.generateRoute({
      starLevel: cfg.starLevel,
      scale: 'medium',
      seaConditionId: 'random',
      nodeMix: 'balanced',
      enemyBias: 'mixed',
      commander,
      customEnemies,
      fleetSize: fleetSummary?.count || 3,
      strengthMultiplier: curMult,
    });
    await launchSortie(route);
  });
  root.appendChild(seaCard);

  // 2B. Custom Map Workshop Panel (data-no-swipe="true" locks horizontal gesture!)
  const wsCard = document.createElement('section');
  wsCard.className = 'surface-card lab-stack-sm map-workshop-panel';
  wsCard.id = 'sortie-map-workshop';
  wsCard.dataset.noSwipe = 'true';
  wsCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">自定义海图工坊</h2>
      <span class="status-badge badge-ok">已装携带 油${caps.selectedFuel} / 弹${caps.selectedAmmo}</span>
    </div>

    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="ws-scale">航线规模</label>
        <select id="ws-scale" class="form-select">
          ${Object.values(MAP_SCALES)
            .map((s) => `<option value="${s.id}" ${cfg.scale === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`)
            .join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="ws-cond">海况词条</label>
        <select id="ws-cond" class="form-select">
          <option value="random" ${cfg.seaConditionId === 'random' ? 'selected' : ''}>随机海况</option>
          ${SEA_CONDITIONS.map(
            (c) => `<option value="${c.id}" ${cfg.seaConditionId === c.id ? 'selected' : ''}>${escapeHtml(c.label)}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="ws-mix">节点配比倾向</label>
        <select id="ws-mix" class="form-select">
          ${Object.values(NODE_MIX_MODES)
            .map((m) => `<option value="${m.id}" ${cfg.nodeMix === m.id ? 'selected' : ''}>${escapeHtml(m.label)}</option>`)
            .join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="ws-bias">敌舰编队倾向</label>
        <select id="ws-bias" class="form-select">
          ${Object.values(ENEMY_BIAS_MODES)
            .map((b) => `<option value="${b.id}" ${cfg.enemyBias === b.id ? 'selected' : ''}>${escapeHtml(b.label)}</option>`)
            .join('')}
        </select>
      </div>
    </div>

    <div class="form-group">
      <div class="form-label-row">
        <label class="form-label" for="ws-strength">敌军强度微调（0.5x ~ 2.5x）</label>
        <span class="status-badge badge-muted" id="ws-strength-val">${curMult.toFixed(1)}x</span>
      </div>
      <input id="ws-strength" class="range-input" type="range" min="0.5" max="2.5" step="0.1" value="${curMult.toFixed(1)}" />
    </div>

    <div class="ws-preview-card" id="ws-live-preview">
      <div class="lab-slot-head">
        <strong>${escapeHtml(preview.tierLabel)} · ${preview.nodeCount} 节点预计评估</strong>
        <span class="status-badge ${caps.selectedFuel >= preview.estFuel && caps.selectedAmmo >= preview.estAmmo ? 'badge-ok' : 'badge-warn'}">
          预估 油${preview.estFuel} / 弹${preview.estAmmo}
        </span>
      </div>
      <span class="cc-stat-sub">敌军基准：${escapeHtml(preview.enemySummary)}</span>
      <span class="cc-stat-sub">掉落预览：${escapeHtml(preview.dropHint)}</span>
    </div>

    <div class="form-group">
      <label class="form-label" for="ws-seed-input">海图种子码（输入已有种子可精准复现）</label>
      <div class="lab-btn-grid">
        <input id="ws-seed-input" class="form-input" type="text" value="${escapeHtml(cfg.seedInput)}" placeholder="如 S1-M-R-0-0-AB12（留空自动生成）" />
        <button type="button" id="btn-ws-decode-seed" class="btn-secondary uikit-touch-target">解析种子</button>
      </div>
    </div>

    <div class="lab-btn-grid">
      <button type="button" id="btn-ws-save-blueprint" class="btn-secondary uikit-touch-target">收藏当前配方</button>
      <button type="button" id="btn-ws-back-prep" class="btn-secondary uikit-touch-target">← 返回调油弹</button>
    </div>

    <button type="button" id="btn-ws-launch" class="btn-primary port-cta-btn">
      生成自定义海图并启航出征
    </button>

    ${
      savedBlueprints.length > 0
        ? `
      <div class="lab-divider"></div>
      <strong style="font-size:13px;">已收藏自定义海图配方（${savedBlueprints.length}）</strong>
      <div class="lab-stack-sm">
        ${savedBlueprints
          .slice(0, 6)
          .map(
            (bp) => `
          <div class="ac-editor-card">
            <div class="lab-slot-head">
              <strong>${escapeHtml(bp.name)}</strong>
              <span class="status-badge badge-muted">${escapeHtml(bp.seedCode || bp.difficultyLabel)}</span>
            </div>
            <div class="lab-btn-grid">
              <button type="button" class="btn-primary uikit-touch-target" data-load-bp="${escapeHtml(bp.id)}">载入启航</button>
              <button type="button" class="btn-danger uikit-touch-target" data-del-bp="${escapeHtml(bp.id)}">删除</button>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    `
        : ''
    }
  `;

  wsCard.querySelector('#ws-scale').addEventListener('change', (e) => {
    cfg.scale = e.target.value;
    renderSortieConsole();
  });
  wsCard.querySelector('#ws-cond').addEventListener('change', (e) => {
    cfg.seaConditionId = e.target.value;
    renderSortieConsole();
  });
  wsCard.querySelector('#ws-mix').addEventListener('change', (e) => {
    cfg.nodeMix = e.target.value;
    renderSortieConsole();
  });
  wsCard.querySelector('#ws-bias').addEventListener('change', (e) => {
    cfg.enemyBias = e.target.value;
    renderSortieConsole();
  });
  const strSlider = wsCard.querySelector('#ws-strength');
  strSlider?.addEventListener('input', () => {
    const val = setEnemyStrengthMultiplier(strSlider.value);
    const valEl = wsCard.querySelector('#ws-strength-val');
    if (valEl) valEl.textContent = `${val.toFixed(1)}x`;
  });
  wsCard.querySelector('#ws-seed-input').addEventListener('input', (e) => {
    cfg.seedInput = e.target.value.trim();
  });
  wsCard.querySelector('#btn-ws-decode-seed').addEventListener('click', () => {
    const decoded = decodeMapSeed(cfg.seedInput);
    if (!decoded) {
      uiKit.showToast('种子格式无效，请使用如 S1-M-R-0-0-AB12 格式', 'warn');
      return;
    }
    if (!routeGenerator.isSeaZoneUnlocked(`star_${decoded.starLevel}`)) {
      uiKit.showToast(`${decoded.starLevel}★ 海域尚未解锁，请先推进前置星级制海权至 100%`, 'warn');
      return;
    }
    cfg.starLevel = decoded.starLevel;
    cfg.scale = decoded.scale;
    cfg.seaConditionId = decoded.seaConditionId;
    cfg.nodeMix = decoded.nodeMix;
    cfg.enemyBias = decoded.enemyBias;
    cfg.seedInput = decoded.seedCode;
    uiKit.showToast(`种子解析成功：${decoded.starLevel}★ · ${MAP_SCALES[decoded.scale]?.label}`, 'ok');
    renderSortieConsole();
  });
  wsCard.querySelector('#btn-ws-save-blueprint').addEventListener('click', async () => {
    const seed =
      (cfg.seedInput && decodeMapSeed(cfg.seedInput)?.seedCode) ||
      encodeMapSeed({
        starLevel: cfg.starLevel,
        scale: cfg.scale,
        seaConditionId: cfg.seaConditionId,
        nodeMix: cfg.nodeMix,
        enemyBias: cfg.enemyBias,
      });
    cfg.seedInput = seed;
    await routeGenerator.saveCustomRoute({
      name: `${cfg.starLevel}★ ${NODE_MIX_MODES[cfg.nodeMix]?.label || '自定义'}（${seed}）`,
      difficulty: `star_${cfg.starLevel}`,
      star: cfg.starLevel,
      scale: cfg.scale,
      nodeMix: cfg.nodeMix,
      enemyBias: cfg.enemyBias,
      seaConditionId: cfg.seaConditionId,
      seedCode: seed,
    });
    uiKit.showToast(`已收藏海图配方（种子 ${seed}）`, 'ok');
    renderSortieConsole();
  });
  wsCard.querySelector('#btn-ws-back-prep').addEventListener('click', () => {
    sortieState.prepStage = 'prep';
    renderSortieConsole();
  });
  wsCard.querySelector('#btn-ws-launch').addEventListener('click', async () => {
    const customEnemies = sortieState.context?.contentManager?.listCustomEnemies() || [];
    const route = routeGenerator.generateRoute({
      starLevel: cfg.starLevel,
      scale: cfg.scale,
      seaConditionId: cfg.seaConditionId,
      nodeMix: cfg.nodeMix,
      enemyBias: cfg.enemyBias,
      seedCode: cfg.seedInput || null,
      commander,
      customEnemies,
      fleetSize: fleetSummary?.count || 3,
      strengthMultiplier: curMult,
    });
    await launchSortie(route);
  });

  wsCard.querySelectorAll('[data-load-bp]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const bp = savedBlueprints.find((x) => x.id === btn.getAttribute('data-load-bp'));
      if (!bp) return;
      if (!routeGenerator.isSeaZoneUnlocked(`star_${bp.star || 1}`)) {
        uiKit.showToast(`需先解锁 ${bp.star || 1}★ 海域方可载入此配方`, 'warn');
        return;
      }
      const customEnemies = sortieState.context?.contentManager?.listCustomEnemies() || [];
      const route = routeGenerator.generateRoute({
        starLevel: bp.star || 1,
        scale: bp.scale || 'medium',
        seaConditionId: bp.seaConditionId || 'random',
        nodeMix: bp.nodeMix || 'balanced',
        enemyBias: bp.enemyBias || 'mixed',
        seedCode: bp.seedCode || null,
        commander,
        customEnemies,
        fleetSize: fleetSummary?.count || 3,
        strengthMultiplier: curMult,
      });
      await launchSortie(route);
    });
  });
  wsCard.querySelectorAll('[data-del-bp]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await routeGenerator.deleteCustomRoute(btn.getAttribute('data-del-bp'));
      uiKit.showToast('已删除收藏配方', 'info');
      renderSortieConsole();
    });
  });

  root.appendChild(wsCard);
  sortieState.container.appendChild(root);
}

export default {
  id: 'sortie-console',
  name: '出征作战',
  description: '三段式出征流程（准备与携带油弹 → 1★~5★ 自定义海图工坊 → 航行与 3×4 战术战斗）。',

  async mount(container, context) {
    sortieState.container = container;
    sortieState.context = context;
    if (!sortieState.hydrated) {
      await hydrateSortieConsole({
        storage: context.rootStorage,
        routeGenerator: context.routeGenerator,
        combat: context.combat,
      });
    }
    const rerender = () => renderSortieConsole();
    sortieState.unsubs = [
      context.bus.on('formation:changed', rerender),
      context.bus.on('commander:updated', rerender),
      context.bus.on('buildings:updated', rerender),
      context.bus.on('sea-control:updated', rerender),
    ];
    await renderSortieConsole();
  },

  unmount() {
    sortieState.autoRunning = false;
    if (sortieState.context?.ui) {
      sortieState.context.ui.setImmersiveBattle(false);
      sortieState.context.ui.setSwipeLocked(false);
    }
    for (const u of sortieState.unsubs) {
      try {
        u();
      } catch {
        // ignore
      }
    }
    sortieState.unsubs = [];
    sortieState.container = null;
    sortieState.context = null;
  },
};
