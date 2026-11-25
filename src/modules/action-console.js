/**
 * Generic Action & Event Console Module (`action-console`).
 *
 * Plain, domain-neutral interactive gameplay loop integrating:
 *   - Compact active character status bar synced live with Character Console
 *   - One-tap Pure Local Mode / AI Enhanced Mode switch (via PromptPipeline)
 *   - Immersive chronological timeline (event cards, branching choices, D20 check breakdowns, settlement chips)
 *   - Quick actions ("执行探索", "随机事件", "状态休整") + freeform bottom input bar
 *   - Visual mobile Event Rule Editor Bottom Sheet persisted in IndexedDB
 *   - Automatic EventBus sync & SaveManager Auto-Save on every state/resource settlement
 */

import { CORE_STAT_DEFS, CORE_STAT_MAP } from '../core/stat-rules.js';
import { NARRATIVE_MODES } from '../core/prompt-pipeline.js';
import { LOG_CATEGORIES } from '../core/log-system.js';
import { getActiveCharacterId, persistCharacterRoster } from './character-console.js';
import { clamp } from '../core/calc-engine.js';

const ACTION_STORAGE_NS = 'core-action-events';
const EVENTS_KEY = 'event-library';
const TIMELINE_KEY = 'timeline-history';
const MAX_TIMELINE_ITEMS = 50;

const CATEGORY_LABELS = {
  explore: '探索事件',
  random: '随机事件',
  rest: '状态休整',
  custom: '自定义事件',
};

export const DEFAULT_ACTION_EVENTS = [
  {
    id: 'evt_routine_survey',
    title: '常规区域勘查',
    category: 'explore',
    weight: 40,
    apCost: 10,
    description: '前方区域出现未记录的环境读数，适合派遣当前角色进行实地核查并评估可回收物资。',
    builtIn: true,
    choices: [
      {
        id: 'ch_survey_tactics',
        label: '稳健推进并核查数据',
        statKey: 'tactics',
        dc: 14,
        successEffects: { hp: 0, morale: 5, ap: 0, affinity: 3, credits: 80, supplies: 30, materials: 20 },
        failEffects: { hp: -8, morale: -5, ap: 0, affinity: 0, credits: 15, supplies: 0, materials: 0 },
        successTemplate:
          '{actor.name}身着「{outfitName}」，凭借清晰的战术判断顺利完成区域核查（检定 {check.total} vs DC {check.dc}），结算收益：{rewardSummary}。',
        failTemplate:
          '{actor.name}在核查途中遭遇局部干扰，被迫提前撤离（检定 {check.total} vs DC {check.dc}），结算变动：{penaltySummary}。',
      },
      {
        id: 'ch_survey_agility',
        label: '快速机动绕行侦察',
        statKey: 'agility',
        dc: 13,
        successEffects: { hp: 0, morale: 4, ap: 5, affinity: 2, credits: 50, supplies: 45, materials: 10 },
        failEffects: { hp: -5, morale: -3, ap: -5, affinity: 0, credits: 0, supplies: 0, materials: 0 },
        successTemplate:
          '{actor.name}灵活绕开障碍区域，高效带回一批沿途补给（检定 {check.total} vs DC {check.dc}），结算收益：{rewardSummary}。',
        failTemplate:
          '{actor.name}绕行路线较为耗费体力，未能收集到有效物资（检定 {check.total} vs DC {check.dc}），结算变动：{penaltySummary}。',
      },
      {
        id: 'ch_survey_withdraw',
        label: '标记坐标后安全撤回（免检定）',
        statKey: 'none',
        dc: 0,
        successEffects: { hp: 0, morale: 2, ap: 0, affinity: 1, credits: 20, supplies: 0, materials: 0 },
        failEffects: {},
        successTemplate:
          '{actor.name}稳妥记录了坐标信息并返回基地，获得基础补贴：{rewardSummary}。',
        failTemplate: '',
      },
    ],
  },
  {
    id: 'evt_supply_cache',
    title: '旧物资点回收',
    category: 'explore',
    weight: 35,
    apCost: 12,
    description: '发现一处封闭的旧式仓储点，外层门锁已经锈蚀，内部隐约存放着可用材料与补给。',
    builtIn: true,
    choices: [
      {
        id: 'ch_cache_force',
        label: '强行破拆门锁（高回报）',
        statKey: 'attack',
        dc: 15,
        successEffects: { hp: 0, morale: 6, ap: 0, affinity: 3, credits: 100, supplies: 50, materials: 45 },
        failEffects: { hp: -12, morale: -4, ap: 0, affinity: 0, credits: 0, supplies: 10, materials: 0 },
        successTemplate:
          '{actor.name}果断破开封闭门锁，完整回收内部库存（检定 {check.total} vs DC {check.dc}），结算收益：{rewardSummary}。',
        failTemplate:
          '{actor.name}破拆时触发老化支架滑落，受到轻微擦伤（检定 {check.total} vs DC {check.dc}），结算变动：{penaltySummary}。',
      },
      {
        id: 'ch_cache_luck',
        label: '搜寻侧面备用通道',
        statKey: 'luck',
        dc: 13,
        successEffects: { hp: 0, morale: 5, ap: 0, affinity: 2, credits: 70, supplies: 35, materials: 30 },
        failEffects: { hp: -4, morale: -3, ap: 0, affinity: 0, credits: 10, supplies: 0, materials: 0 },
        successTemplate:
          '{actor.name}意外找到未上锁的维护通道，轻松取走物资（检定 {check.total} vs DC {check.dc}），结算收益：{rewardSummary}。',
        failTemplate:
          '{actor.name}绕行一圈未发现备用入口，只顺手捡回少量零散零件（检定 {check.total} vs DC {check.dc}），结算变动：{penaltySummary}。',
      },
    ],
  },
  {
    id: 'evt_signal_anomaly',
    title: '突发干扰信号处理',
    category: 'random',
    weight: 40,
    apCost: 8,
    description: '周边通讯频道突然出现周期性杂波，需要尽快决定压制或解析干扰源。',
    builtIn: true,
    choices: [
      {
        id: 'ch_signal_burst',
        label: '高功率瞬时压制干扰源',
        statKey: 'burst',
        dc: 15,
        successEffects: { hp: 0, morale: 8, ap: 0, affinity: 4, credits: 110, supplies: 20, materials: 35 },
        failEffects: { hp: -10, morale: -6, ap: 0, affinity: 0, credits: 0, supplies: 0, materials: 0 },
        successTemplate:
          '{actor.name}以精准爆发输出瞬间清除干扰源，频道恢复畅通（检定 {check.total} vs DC {check.dc}），结算收益：{rewardSummary}。',
        failTemplate:
          '{actor.name}未能一次压制信号波动，设备承受了反冲损耗（检定 {check.total} vs DC {check.dc}），结算变动：{penaltySummary}。',
      },
      {
        id: 'ch_signal_analyze',
        label: '记录频谱并逆向解析',
        statKey: 'tactics',
        dc: 14,
        successEffects: { hp: 0, morale: 5, ap: 0, affinity: 3, credits: 90, supplies: 25, materials: 25 },
        failEffects: { hp: -4, morale: -4, ap: 0, affinity: 0, credits: 20, supplies: 0, materials: 0 },
        successTemplate:
          '{actor.name}成功解析杂波背后的规律并导出数据（检定 {check.total} vs DC {check.dc}），结算收益：{rewardSummary}。',
        failTemplate:
          '{actor.name}仅截获部分片段数据，干扰随后自行消散（检定 {check.total} vs DC {check.dc}），结算变动：{penaltySummary}。',
      },
    ],
  },
  {
    id: 'evt_camp_encounter',
    title: '中转补给站偶遇',
    category: 'random',
    weight: 35,
    apCost: 5,
    description: '在沿途中转站点遇到一支临时休整的运输小队，对方正在征集协助并交换富余物资。',
    builtIn: true,
    choices: [
      {
        id: 'ch_camp_trade',
        label: '友好接洽并互换物资',
        statKey: 'luck',
        dc: 12,
        successEffects: { hp: 6, morale: 8, ap: 0, affinity: 4, credits: 60, supplies: 60, materials: 15 },
        failEffects: { hp: 0, morale: 2, ap: 0, affinity: 1, credits: 20, supplies: 15, materials: 0 },
        successTemplate:
          '{actor.name}身着「{outfitName}」与对方愉快达成交换，顺便获得热食补给（检定 {check.total} vs DC {check.dc}），结算收益：{rewardSummary}。',
        failTemplate:
          '{actor.name}与对方简单交流后只换到少量常规物资（检定 {check.total} vs DC {check.dc}），结算变动：{penaltySummary}。',
      },
      {
        id: 'ch_camp_assist',
        label: '协助快速装卸（机动检定）',
        statKey: 'agility',
        dc: 14,
        successEffects: { hp: 0, morale: 6, ap: 0, affinity: 3, credits: 120, supplies: 30, materials: 20 },
        failEffects: { hp: -6, morale: -2, ap: 0, affinity: 1, credits: 40, supplies: 0, materials: 0 },
        successTemplate:
          '{actor.name}高效完成装卸协助，对方慷慨支付报酬（检定 {check.total} vs DC {check.dc}），结算收益：{rewardSummary}。',
        failTemplate:
          '{actor.name}搬运途中略显吃力，但仍拿到基础酬劳（检定 {check.total} vs DC {check.dc}），结算变动：{penaltySummary}。',
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

function formatTimeShort(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

// ============================================================
// Module Persistent State & RuleEngine Sync
// ============================================================

let actionState = {
  container: null,
  context: null,
  events: [],
  timeline: [],
  activeEvent: null,
  busy: false,
  hydrated: false,
  avatarCache: new Map(),
  unsubs: [],
};

function syncEventsToRuleEngine(rulesEngine, eventsList) {
  if (!rulesEngine) return;
  const exploreIds = [];
  const randomIds = [];
  const allIds = [];

  for (const evt of eventsList) {
    const nodeId = `ac_${evt.id}`;
    rulesEngine.registerNode({
      id: nodeId,
      title: evt.title,
      weight: Math.max(1, Number(evt.weight) || 10),
      tags: ['action-console', evt.category || 'random'],
      conditions: [],
      template: evt.description || '',
      choices: [],
      meta: { actionEventId: evt.id, category: evt.category },
    });
    allIds.push(nodeId);
    if (evt.category === 'explore') {
      exploreIds.push(nodeId);
    } else {
      randomIds.push(nodeId);
    }
  }

  rulesEngine.registerPool('action_explore_pool', exploreIds.length ? exploreIds : allIds);
  rulesEngine.registerPool('action_random_pool', randomIds.length ? randomIds : allIds);
  rulesEngine.registerPool('action_all_pool', allIds);
}

export async function hydrateActionConsole({ storage, rules }) {
  const scope = storage.namespace(ACTION_STORAGE_NS);
  const [savedEvents, savedTimeline] = await Promise.all([
    scope.getLarge(EVENTS_KEY, null),
    scope.getLarge(TIMELINE_KEY, null),
  ]);

  if (Array.isArray(savedEvents) && savedEvents.length > 0) {
    actionState.events = deepClone(savedEvents);
  } else {
    actionState.events = deepClone(DEFAULT_ACTION_EVENTS);
    await scope.setLarge(EVENTS_KEY, actionState.events);
  }

  if (Array.isArray(savedTimeline)) {
    actionState.timeline = savedTimeline.slice(-MAX_TIMELINE_ITEMS);
  } else {
    actionState.timeline = [];
  }

  syncEventsToRuleEngine(rules, actionState.events);
  actionState.hydrated = true;
}

async function persistEvents() {
  if (!actionState.context) return;
  const scope = actionState.context.rootStorage.namespace(ACTION_STORAGE_NS);
  await scope.setLarge(EVENTS_KEY, actionState.events);
  syncEventsToRuleEngine(actionState.context.rules, actionState.events);
}

async function persistTimeline() {
  if (!actionState.context) return;
  const scope = actionState.context.rootStorage.namespace(ACTION_STORAGE_NS);
  await scope.setLarge(TIMELINE_KEY, actionState.timeline.slice(-MAX_TIMELINE_ITEMS));
}

function getActiveCharacter() {
  const { entities, rootStorage } = actionState.context;
  const chars = entities.list({ kind: 'character' });
  if (chars.length === 0) return null;
  const selectedId = getActiveCharacterId(rootStorage);
  return chars.find((c) => c.id === selectedId) || chars[0];
}

function getCharacterOutfitAndGearContext(char) {
  const { inventory } = actionState.context;
  const equipped = inventory.getCharacterEquipment(char.id);
  const outfitItem = equipped.outfit || null;
  const outfitName = outfitItem ? outfitItem.name : '默认便装';
  const outfitDesc = outfitItem?.description || '简洁轻便的常规服装';

  const gearList = Object.entries(equipped)
    .filter(([, item]) => Boolean(item))
    .map(([slotId, item]) => {
      const slot = inventory.getSlot(slotId);
      return `${slot?.label || slotId}：${item.name}${item.description ? `（${item.description}）` : ''}`;
    });

  return {
    outfitName,
    outfitDesc,
    gearSummaryText: gearList.length > 0 ? gearList.join('；') : '当前未穿戴额外装备与服装',
  };
}

function buildAiSystemPrompt(char) {
  const { logs, statRules } = actionState.context;
  const gear = getCharacterOutfitAndGearContext(char);
  const aff = statRules.getAffinityStage(char.stats.affinity ?? 0);
  const recentLogs = logs.exportTextSummary({ actorId: char.id, limit: 6 });

  return [
    '你是一个通用文字模拟与事件交互叙事助手。请严格遵循以下客观设定与数值结果进行简洁、有代入感的中文描写，不要篡改客观数值结果：',
    `【当前出战角色】${char.name}（定位：${char.meta?.roleTag || '通用型'}，好感度阶段：${aff.label} ${aff.value}/100）`,
    `【性格设定】${char.meta?.personality || '稳重务实'}`,
    `【对话口癖】${char.meta?.speechHabit || '无特定口癖'}`,
    `【当前穿戴服装与装备】${gear.gearSummaryText}`,
    `【近期行动日志参考】\n${recentLogs}`,
  ].join('\n');
}

async function applyEffectsBundle(char, effects = {}, { critBonus = false, reason = '事件结算' } = {}) {
  const { entities, resources, rootStorage } = actionState.context;
  const chips = [];
  const summaryParts = [];
  const mult = critBonus ? 1.5 : 1;

  const statSpecs = [
    { key: 'hp', label: 'HP', max: Number(char.stats.maxHp ?? 100) },
    { key: 'morale', label: '士气', max: 100 },
    { key: 'ap', label: 'AP', max: Number(char.stats.maxAp ?? 100) },
    { key: 'affinity', label: '好感', max: 100 },
  ];

  for (const spec of statSpecs) {
    const rawVal = Number(effects[spec.key] || 0);
    if (!rawVal) continue;
    const val = rawVal > 0 && critBonus ? Math.round(rawVal * mult) : rawVal;
    const before = Number(char.stats[spec.key] ?? 0);
    const after = entities.adjustStat(char.id, spec.key, val, { min: 0, max: spec.max });
    const actual = Number((after - before).toFixed(1));
    if (actual !== 0) {
      const txt = `${spec.label} ${formatSigned(actual)}`;
      chips.push({ text: txt, negative: actual < 0 });
      summaryParts.push(txt);
    }
  }

  const resKeys = ['credits', 'supplies', 'materials'];
  for (const rKey of resKeys) {
    const rawVal = Number(effects[rKey] || 0);
    if (!rawVal) continue;
    const resObj = resources.get(rKey);
    if (!resObj) continue;
    const val = rawVal > 0 && critBonus ? Math.round(rawVal * mult) : rawVal;
    if (val > 0) {
      await resources.add(rKey, val, { reason });
      const txt = `${resObj.name} +${val}${resObj.unit}`;
      chips.push({ text: txt, negative: false });
      summaryParts.push(txt);
    } else if (val < 0) {
      const spendRes = await resources.spend(rKey, Math.abs(val), { reason });
      if (spendRes.ok) {
        const txt = `${resObj.name} ${val}${resObj.unit}`;
        chips.push({ text: txt, negative: true });
        summaryParts.push(txt);
      }
    }
  }

  await persistCharacterRoster({
    storage: rootStorage,
    entities,
    activeCharacterId: char.id,
  });

  return {
    chips,
    summaryText: summaryParts.length > 0 ? summaryParts.join('，') : '无额外变动',
  };
}

// ============================================================
// Core Actions: Explore, Random Event, Choice Execution, Rest, Free Input
// ============================================================

async function triggerEventById(eventId, { spendAp = false } = {}) {
  const evt = actionState.events.find((e) => e.id === eventId);
  if (!evt) return;
  const char = getActiveCharacter();
  if (!char) return;
  const { entities, rootStorage, turnStepper, uiKit } = actionState.context;

  const apCost = spendAp ? Math.max(0, Number(evt.apCost) || 0) : 0;
  if (apCost > 0 && Number(char.stats.ap ?? 0) < apCost) {
    uiKit.showToast(`行动点 AP 不足（需要 ${apCost}，请先点击「状态休整」恢复）`, 'warn');
    return;
  }

  if (apCost > 0) {
    entities.adjustStat(char.id, 'ap', -apCost, { min: 0, max: Number(char.stats.maxAp ?? 100) });
    await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: char.id });
  }

  turnStepper.advance({ steps: 1, reason: `action-${evt.category}` });
  actionState.activeEvent = deepClone(evt);
  await renderActionConsole();

  requestAnimationFrame(() => {
    const activeCard = actionState.container?.querySelector('#ac-active-event-card');
    if (activeCard) activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

async function drawAndTriggerFromPool(poolName, { spendAp = true } = {}) {
  const { rules, uiKit } = actionState.context;
  const lastId = actionState.activeEvent ? `ac_${actionState.activeEvent.id}` : null;
  const excludeIds = lastId && actionState.events.length > 1 ? [lastId] : [];
  let drawn = rules.drawFromPool(poolName, {}, { excludeIds });
  if (!drawn.node) {
    drawn = rules.drawFromPool('action_all_pool', {}, { excludeIds: [] });
  }
  if (!drawn.node) {
    uiKit.showToast('当前事件池为空，请在事件编辑器中新增事件', 'warn');
    return;
  }
  const eventId = drawn.node.meta?.actionEventId;
  await triggerEventById(eventId, { spendAp });
}

async function executeActiveChoice(choiceId) {
  if (actionState.busy || !actionState.activeEvent) return;
  const evt = actionState.activeEvent;
  const choice = (evt.choices || []).find((c) => c.id === choiceId);
  if (!choice) return;

  const char = getActiveCharacter();
  if (!char) return;

  const { entities, inventory, statRules, narrative, logs, bus, uiKit } = actionState.context;
  actionState.busy = true;
  await renderActionConsole();

  try {
    const gear = getCharacterOutfitAndGearContext(char);
    let checkResult = null;
    let isSuccess = true;
    let isCritSuccess = false;

    if (choice.statKey && choice.statKey !== 'none') {
      const baseVal = Number(char.stats[choice.statKey] ?? 50);
      const effVal = entities.getEffectiveStat(char.id, choice.statKey, { round: 'round' }).final;
      const eqBonuses = inventory.getCharacterEquipmentBonuses(char.id);
      checkResult = statRules.performCheck({
        actorId: char.id,
        actorName: char.name,
        statKey: choice.statKey,
        baseStatValue: baseVal,
        effectiveStatValue: effVal,
        equipmentCheckBonus: eqBonuses.checkBonus,
        moraleValue: char.stats.morale ?? 60,
        dc: Number(choice.dc) || 14,
      });
      isSuccess = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
      isCritSuccess = checkResult.outcome === 'crit-success';
    }

    const effectsObj = isSuccess ? choice.successEffects || {} : choice.failEffects || {};
    const settled = await applyEffectsBundle(char, effectsObj, {
      critBonus: isCritSuccess,
      reason: `${evt.title}·${choice.label}`,
    });

    const templateStr = isSuccess
      ? choice.successTemplate ||
        '{actor.name}身着「{outfitName}」完成了「{choiceLabel}」，结算：{rewardSummary}。'
      : choice.failTemplate ||
        '{actor.name}尝试「{choiceLabel}」未能成功，结算：{penaltySummary}。';

    const rendered = await narrative.run({
      template: templateStr,
      variables: {
        actor: { name: char.name, ...char.stats },
        outfitName: gear.outfitName,
        eventTitle: evt.title,
        choiceLabel: choice.label,
        rewardSummary: settled.summaryText,
        penaltySummary: settled.summaryText,
        check: checkResult || { total: 0, dc: 0, outcomeLabel: '免检定' },
      },
      systemPrompt: buildAiSystemPrompt(char),
      polishInstruction: `请结合角色人设、口癖和当前穿着「${gear.outfitName}」，润色以下事件结算描写（保留全部客观结果与检定事实）：`,
    });

    const cardEntry = {
      id: `tl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      type: 'outcome',
      eventTitle: evt.title,
      choiceLabel: choice.label,
      actorName: char.name,
      outfitName: gear.outfitName,
      check: checkResult
        ? {
            statLabel: checkResult.statLabel,
            dc: checkResult.dc,
            total: checkResult.total,
            margin: checkResult.margin,
            outcome: checkResult.outcome,
            outcomeLabel: checkResult.outcomeLabel,
            formulaText: checkResult.formulaText,
            steps: checkResult.steps,
          }
        : null,
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      degradeReason: rendered.degradeReason,
      chips: settled.chips,
    };

    actionState.timeline.push(cardEntry);
    if (actionState.timeline.length > MAX_TIMELINE_ITEMS) {
      actionState.timeline = actionState.timeline.slice(-MAX_TIMELINE_ITEMS);
    }
    actionState.activeEvent = null;
    await persistTimeline();

    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char.id,
      actorName: char.name,
      title: `[${char.name}] 完成事件「${evt.title}」· ${choice.label}`,
      detail: `${checkResult ? `${checkResult.outcomeLabel}(${checkResult.total}/${checkResult.dc}) · ` : ''}${settled.summaryText}`,
    });

    bus.emit('action:settled', {
      characterId: char.id,
      eventId: evt.id,
      choiceId: choice.id,
      outcome: checkResult?.outcome || 'auto',
      chips: settled.chips,
      timestamp: Date.now(),
    });

    uiKit.showToast(
      checkResult
        ? `${checkResult.outcomeLabel}（${checkResult.total} vs DC ${checkResult.dc}）`
        : `事件结算完成：${settled.summaryText}`,
      isSuccess ? 'ok' : 'warn'
    );
  } finally {
    actionState.busy = false;
    await renderActionConsole();
    scrollTimelineToBottom();
  }
}

async function performRestAction() {
  if (actionState.busy) return;
  const char = getActiveCharacter();
  if (!char) return;
  const { resources, turnStepper, narrative, logs, bus, uiKit } = actionState.context;

  actionState.busy = true;
  try {
    const canSpendSupply = resources.canAfford('supplies', 20).ok;
    const restEffects = canSpendSupply
      ? { hp: 20, morale: 16, ap: 30, affinity: 1, supplies: -20 }
      : { hp: 10, morale: 10, ap: 20, affinity: 0 };

    const settled = await applyEffectsBundle(char, restEffects, { reason: '状态休整' });
    turnStepper.advance({ steps: 1, reason: 'action-rest' });

    const gear = getCharacterOutfitAndGearContext(char);
    const rendered = await narrative.run({
      template: canSpendSupply
        ? '{actor.name}身着「{outfitName}」使用 20 份补给进行了充分休整，状态恢复：{rewardSummary}。'
        : '{actor.name}身着「{outfitName}」进行了简易休整（当前补给不足 20 份），状态恢复：{rewardSummary}。',
      variables: {
        actor: { name: char.name, ...char.stats },
        outfitName: gear.outfitName,
        rewardSummary: settled.summaryText,
      },
      systemPrompt: buildAiSystemPrompt(char),
      polishInstruction: '请简短润色本次状态休整反馈，保留客观恢复数值：',
    });

    actionState.timeline.push({
      id: `tl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      type: 'rest',
      eventTitle: '状态休整',
      choiceLabel: canSpendSupply ? '补给休整' : '简易休整',
      actorName: char.name,
      outfitName: gear.outfitName,
      check: null,
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      degradeReason: rendered.degradeReason,
      chips: settled.chips,
    });
    if (actionState.timeline.length > MAX_TIMELINE_ITEMS) {
      actionState.timeline = actionState.timeline.slice(-MAX_TIMELINE_ITEMS);
    }
    await persistTimeline();

    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char.id,
      actorName: char.name,
      title: `[${char.name}] 执行状态休整`,
      detail: settled.summaryText,
    });

    bus.emit('action:settled', {
      characterId: char.id,
      eventId: 'rest',
      chips: settled.chips,
      timestamp: Date.now(),
    });
    uiKit.showToast(`休整完成：${settled.summaryText}`, 'ok');
  } finally {
    actionState.busy = false;
    await renderActionConsole();
    scrollTimelineToBottom();
  }
}

async function handleFreeActionInput(rawText) {
  const text = String(rawText || '').trim();
  if (!text || actionState.busy) return;

  // Keyword intent shortcut in pure local mode
  if (actionState.context.narrative.getMode() === NARRATIVE_MODES.LOCAL) {
    if (/^(探索|执行探索|搜查|勘查)/.test(text)) {
      await drawAndTriggerFromPool('action_explore_pool', { spendAp: true });
      return;
    }
    if (/^(休整|休息|恢复|状态休整)/.test(text)) {
      await performRestAction();
      return;
    }
  }

  const char = getActiveCharacter();
  if (!char) return;
  const { entities, inventory, statRules, narrative, turnStepper, logs, bus, uiKit } = actionState.context;

  actionState.busy = true;
  await renderActionConsole();

  try {
    // Pick best matching stat keyword or default to tactics
    let statKey = 'tactics';
    if (/(攻击|战斗|打击|火力|破拆)/.test(text)) statKey = 'attack';
    else if (/(爆发|强攻|压制|突击)/.test(text)) statKey = 'burst';
    else if (/(移动|闪避|机动|绕行|快)/.test(text)) statKey = 'agility';
    else if (/(运气|寻找|翻找|碰运气|抽)/.test(text)) statKey = 'luck';

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
      dc: 14,
    });

    const isSuccess = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
    const settled = await applyEffectsBundle(
      char,
      isSuccess
        ? { ap: -5, morale: 3, affinity: 2, credits: 35 }
        : { ap: -5, morale: -2, credits: 10 },
      { critBonus: checkResult.outcome === 'crit-success', reason: '自由行动' }
    );
    turnStepper.advance({ steps: 1, reason: 'action-free-input' });

    const gear = getCharacterOutfitAndGearContext(char);
    const modeNow = narrative.getMode();
    const rendered = await narrative.run({
      modeOverride: modeNow === NARRATIVE_MODES.LOCAL ? NARRATIVE_MODES.LOCAL : NARRATIVE_MODES.AI_FREE,
      userInput: `玩家指令：「${text}」。检定结果：${checkResult.statLabel} ${checkResult.outcomeLabel}（${checkResult.formulaText}），状态结算：${settled.summaryText}。`,
      template: isSuccess
        ? '{actor.name}身着「{outfitName}」，围绕指令「{userInput}」展开行动并顺利达成目标（{check.statLabel} {check.outcomeLabel}：{check.total} vs DC {check.dc}）。结算：{rewardSummary}。'
        : '{actor.name}身着「{outfitName}」，围绕指令「{userInput}」尝试行动但遇到阻力（{check.statLabel} {check.outcomeLabel}：{check.total} vs DC {check.dc}）。结算：{rewardSummary}。',
      variables: {
        actor: { name: char.name, ...char.stats },
        outfitName: gear.outfitName,
        userInput: text,
        rewardSummary: settled.summaryText,
        check: checkResult,
      },
      systemPrompt: buildAiSystemPrompt(char),
    });

    actionState.timeline.push({
      id: `tl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      type: 'free',
      eventTitle: `自由行动：${text.slice(0, 18)}`,
      choiceLabel: `${checkResult.statLabel}检定`,
      actorName: char.name,
      outfitName: gear.outfitName,
      check: {
        statLabel: checkResult.statLabel,
        dc: checkResult.dc,
        total: checkResult.total,
        margin: checkResult.margin,
        outcome: checkResult.outcome,
        outcomeLabel: checkResult.outcomeLabel,
        formulaText: checkResult.formulaText,
        steps: checkResult.steps,
      },
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      degradeReason: rendered.degradeReason,
      chips: settled.chips,
    });
    if (actionState.timeline.length > MAX_TIMELINE_ITEMS) {
      actionState.timeline = actionState.timeline.slice(-MAX_TIMELINE_ITEMS);
    }
    await persistTimeline();

    logs.add({
      category: LOG_CATEGORIES.STAT,
      actorId: char.id,
      actorName: char.name,
      title: `[${char.name}] 自由行动「${text.slice(0, 20)}」`,
      detail: `${checkResult.outcomeLabel}(${checkResult.total}/${checkResult.dc}) · ${settled.summaryText}`,
    });

    bus.emit('action:settled', {
      characterId: char.id,
      eventId: 'free-input',
      chips: settled.chips,
      timestamp: Date.now(),
    });

    uiKit.showToast(
      rendered.degraded ? '无可用 API，已自动降级本地模板响应' : `行动完成（${checkResult.outcomeLabel}）`,
      rendered.degraded ? 'warn' : isSuccess ? 'ok' : 'info'
    );
  } finally {
    actionState.busy = false;
    await renderActionConsole();
    scrollTimelineToBottom();
  }
}

function scrollTimelineToBottom() {
  requestAnimationFrame(() => {
    if (actionState.container) {
      actionState.container.scrollTop = actionState.container.scrollHeight;
    }
  });
}

// ============================================================
// Visual Mobile Event Rule Editor Bottom Sheet
// ============================================================

function openEventFormSheet(existingEvent = null, onSaved = null) {
  const { uiKit, logs, bus } = actionState.context;
  const isEdit = Boolean(existingEvent);
  const primaryChoice = existingEvent?.choices?.[0] || {
    id: 'ch_main',
    label: '执行主方案',
    statKey: 'tactics',
    dc: 14,
    successEffects: { hp: 0, morale: 5, ap: 0, affinity: 3, credits: 90, supplies: 30, materials: 20 },
    failEffects: { hp: -8, morale: -4, ap: 0, affinity: 0, credits: 10, supplies: 0, materials: 0 },
    successTemplate: '{actor.name}身着「{outfitName}」顺利完成了事件目标，获得：{rewardSummary}。',
    failTemplate: '{actor.name}行动受阻未能达成目标，状态变动：{penaltySummary}。',
  };

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="ev-f-title">事件标题 *</label>
      <input id="ev-f-title" class="form-input" type="text" value="${escapeHtml(existingEvent?.title || '')}" placeholder="例如：夜间巡检测试">
    </div>

    <div class="lab-kv-grid-3">
      <div class="form-group">
        <label class="form-label" for="ev-f-cat">所属事件池</label>
        <select id="ev-f-cat" class="form-select">
          <option value="explore" ${(existingEvent?.category || 'explore') === 'explore' ? 'selected' : ''}>探索池</option>
          <option value="random" ${existingEvent?.category === 'random' ? 'selected' : ''}>随机池</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="ev-f-weight">触发权重</label>
        <input id="ev-f-weight" class="form-input" type="number" min="1" max="1000" value="${Number(existingEvent?.weight ?? 50)}">
      </div>
      <div class="form-group">
        <label class="form-label" for="ev-f-ap">AP 消耗</label>
        <input id="ev-f-ap" class="form-input" type="number" min="0" max="50" value="${Number(existingEvent?.apCost ?? 8)}">
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="ev-f-desc">事件描述</label>
      <textarea id="ev-f-desc" class="form-textarea" placeholder="描述事件触发时的背景与状况...">${escapeHtml(existingEvent?.description || '')}</textarea>
    </div>

    <div class="lab-divider"></div>

    <div class="form-group">
      <label class="form-label" for="ev-f-choice-label">主分支选项名称 *</label>
      <input id="ev-f-choice-label" class="form-input" type="text" value="${escapeHtml(primaryChoice.label)}" placeholder="例如：迎难而上执行检定">
    </div>

    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="ev-f-stat">检定属性</label>
        <select id="ev-f-stat" class="form-select">
          ${CORE_STAT_DEFS.map(
            (d) => `<option value="${d.key}" ${primaryChoice.statKey === d.key ? 'selected' : ''}>${escapeHtml(d.label)}</option>`
          ).join('')}
          <option value="none" ${primaryChoice.statKey === 'none' ? 'selected' : ''}>免检定（必成功）</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="ev-f-dc">检定难度 DC</label>
        <input id="ev-f-dc" class="form-input" type="number" min="5" max="35" value="${Number(primaryChoice.dc ?? 14)}">
      </div>
    </div>

    <div class="form-group">
      <span class="form-label">检定成功奖惩（支持正负值）</span>
      <div class="lab-kv-grid-3">
        <input id="ev-f-s-credits" class="form-input" type="number" value="${Number(primaryChoice.successEffects?.credits ?? 90)}" placeholder="资金" aria-label="成功资金">
        <input id="ev-f-s-supplies" class="form-input" type="number" value="${Number(primaryChoice.successEffects?.supplies ?? 30)}" placeholder="补给" aria-label="成功补给">
        <input id="ev-f-s-materials" class="form-input" type="number" value="${Number(primaryChoice.successEffects?.materials ?? 20)}" placeholder="材料" aria-label="成功材料">
        <input id="ev-f-s-hp" class="form-input" type="number" value="${Number(primaryChoice.successEffects?.hp ?? 0)}" placeholder="HP" aria-label="成功HP">
        <input id="ev-f-s-morale" class="form-input" type="number" value="${Number(primaryChoice.successEffects?.morale ?? 5)}" placeholder="士气" aria-label="成功士气">
        <input id="ev-f-s-affinity" class="form-input" type="number" value="${Number(primaryChoice.successEffects?.affinity ?? 3)}" placeholder="好感" aria-label="成功好感">
      </div>
      <span class="cc-stat-sub">上排：资金 / 补给 / 材料；下排：HP / 士气 / 好感</span>
    </div>

    <div class="form-group">
      <span class="form-label">检定失败奖惩（支持正负值）</span>
      <div class="lab-kv-grid-3">
        <input id="ev-f-f-hp" class="form-input" type="number" value="${Number(primaryChoice.failEffects?.hp ?? -8)}" placeholder="HP" aria-label="失败HP">
        <input id="ev-f-f-morale" class="form-input" type="number" value="${Number(primaryChoice.failEffects?.morale ?? -4)}" placeholder="士气" aria-label="失败士气">
        <input id="ev-f-f-credits" class="form-input" type="number" value="${Number(primaryChoice.failEffects?.credits ?? 10)}" placeholder="资金" aria-label="失败资金">
      </div>
      <span class="cc-stat-sub">依次：HP / 士气 / 资金</span>
    </div>

    <div class="form-group">
      <label class="form-label" for="ev-f-stpl">成功本地输出模板（可用 {actor.name} {outfitName} {rewardSummary}）</label>
      <textarea id="ev-f-stpl" class="form-textarea">${escapeHtml(primaryChoice.successTemplate || '')}</textarea>
    </div>

    <div class="form-group">
      <label class="form-label" for="ev-f-ftpl">失败本地输出模板（可用 {actor.name} {outfitName} {penaltySummary}）</label>
      <textarea id="ev-f-ftpl" class="form-textarea">${escapeHtml(primaryChoice.failTemplate || '')}</textarea>
    </div>
  `;

  uiKit.openBottomSheet({
    title: isEdit ? `编辑事件 · ${existingEvent.title}` : '新增自定义本地事件',
    subtitle: '保存后立即持久化至 IndexedDB 并注入规则引擎事件池',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: isEdit ? '保存修改' : '保存事件',
        tone: 'primary',
        onClick: async () => {
          const title = wrap.querySelector('#ev-f-title').value.trim();
          const choiceLabel = wrap.querySelector('#ev-f-choice-label').value.trim();
          if (!title || !choiceLabel) {
            uiKit.showToast('请填写事件标题与主选项名称', 'warn');
            return false;
          }

          const updatedMainChoice = {
            id: primaryChoice.id || `ch_${Date.now()}`,
            label: choiceLabel,
            statKey: wrap.querySelector('#ev-f-stat').value,
            dc: clamp(Number(wrap.querySelector('#ev-f-dc').value) || 14, 0, 40),
            successEffects: {
              credits: Number(wrap.querySelector('#ev-f-s-credits').value) || 0,
              supplies: Number(wrap.querySelector('#ev-f-s-supplies').value) || 0,
              materials: Number(wrap.querySelector('#ev-f-s-materials').value) || 0,
              hp: Number(wrap.querySelector('#ev-f-s-hp').value) || 0,
              morale: Number(wrap.querySelector('#ev-f-s-morale').value) || 0,
              affinity: Number(wrap.querySelector('#ev-f-s-affinity').value) || 0,
              ap: 0,
            },
            failEffects: {
              hp: Number(wrap.querySelector('#ev-f-f-hp').value) || 0,
              morale: Number(wrap.querySelector('#ev-f-f-morale').value) || 0,
              credits: Number(wrap.querySelector('#ev-f-f-credits').value) || 0,
              supplies: 0,
              materials: 0,
              affinity: 0,
              ap: 0,
            },
            successTemplate: wrap.querySelector('#ev-f-stpl').value.trim(),
            failTemplate: wrap.querySelector('#ev-f-ftpl').value.trim(),
          };

          const extraChoices = isEdit && existingEvent.choices.length > 1
            ? existingEvent.choices.slice(1)
            : [
                {
                  id: 'ch_safe_skip',
                  label: '谨慎观察后离开（免检定）',
                  statKey: 'none',
                  dc: 0,
                  successEffects: { hp: 0, morale: 1, ap: 0, affinity: 0, credits: 10, supplies: 0, materials: 0 },
                  failEffects: {},
                  successTemplate: '{actor.name}评估风险后选择稳妥撤离，获得少量记录补贴：{rewardSummary}。',
                  failTemplate: '',
                },
              ];

          const record = {
            id: isEdit ? existingEvent.id : `evt_custom_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
            title,
            category: wrap.querySelector('#ev-f-cat').value,
            weight: clamp(Number(wrap.querySelector('#ev-f-weight').value) || 50, 1, 1000),
            apCost: clamp(Number(wrap.querySelector('#ev-f-ap').value) || 0, 0, 50),
            description: wrap.querySelector('#ev-f-desc').value.trim() || '自定义本地交互事件。',
            builtIn: Boolean(existingEvent?.builtIn),
            choices: [updatedMainChoice, ...extraChoices],
            updatedAt: Date.now(),
          };

          if (isEdit) {
            const idx = actionState.events.findIndex((e) => e.id === existingEvent.id);
            if (idx >= 0) actionState.events[idx] = record;
          } else {
            actionState.events.unshift(record);
          }

          await persistEvents();
          logs.add({
            category: LOG_CATEGORIES.SYSTEM,
            title: isEdit ? `编辑事件节点「${record.title}」` : `新增自定义事件「${record.title}」`,
            detail: `事件池：${CATEGORY_LABELS[record.category] || record.category} · 权重 ${record.weight} · DC ${updatedMainChoice.dc}`,
          });
          bus.emit('action:events-changed', { eventId: record.id });
          uiKit.showToast(isEdit ? `已更新事件：${record.title}` : `已新增自定义事件：${record.title}`, 'ok');
          if (typeof onSaved === 'function') onSaved(record);
          return true;
        },
      },
    ],
  });
}

function openEventEditorSheet() {
  const { uiKit } = actionState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  let sheetHandle = null;

  const renderList = () => {
    wrap.innerHTML = `
      <div class="lab-btn-row">
        <button type="button" id="btn-ac-new-event" class="btn-primary uikit-touch-target">+ 新增自定义事件</button>
      </div>
      <div class="lab-stack-sm" id="ac-editor-list">
        ${actionState.events
          .map((evt) => {
            const c0 = evt.choices?.[0];
            const statLabel = c0?.statKey && c0.statKey !== 'none' ? CORE_STAT_MAP[c0.statKey]?.shortLabel || c0.statKey : '免检定';
            return `
              <div class="ac-editor-card" data-editor-event-id="${escapeHtml(evt.id)}">
                <div class="lab-slot-head">
                  <strong>${escapeHtml(evt.title)}</strong>
                  <span class="status-badge ${evt.builtIn ? 'badge-muted' : 'badge-ok'}">${evt.builtIn ? '内置' : '自定义'} · 权重 ${evt.weight}</span>
                </div>
                <p class="muted-text" style="font-size:12px;">${escapeHtml(evt.description)}</p>
                <span class="cc-stat-sub">事件池：${escapeHtml(CATEGORY_LABELS[evt.category] || evt.category)} · AP ${evt.apCost || 0} · 主检定：${escapeHtml(statLabel)}${c0?.dc ? ` DC ${c0.dc}` : ''}</span>
                <div class="cc-btn-3col">
                  <button type="button" class="btn-primary uikit-touch-target" data-ev-act="trigger">立即触发</button>
                  <button type="button" class="btn-secondary uikit-touch-target" data-ev-act="edit">编辑</button>
                  <button type="button" class="btn-danger uikit-touch-target" data-ev-act="delete" ${actionState.events.length <= 1 ? 'disabled' : ''}>删除</button>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;

    wrap.querySelector('#btn-ac-new-event').addEventListener('click', () => {
      openEventFormSheet(null, () => renderList());
    });

    wrap.querySelectorAll('[data-editor-event-id]').forEach((card) => {
      const evtId = card.getAttribute('data-editor-event-id');
      const evt = actionState.events.find((e) => e.id === evtId);
      if (!evt) return;

      card.querySelector('[data-ev-act="trigger"]').addEventListener('click', async () => {
        if (sheetHandle) sheetHandle.close();
        await triggerEventById(evt.id, { spendAp: false });
        uiKit.showToast(`已手动触发事件：${evt.title}`, 'ok');
      });

      card.querySelector('[data-ev-act="edit"]').addEventListener('click', () => {
        openEventFormSheet(evt, () => renderList());
      });

      card.querySelector('[data-ev-act="delete"]').addEventListener('click', async () => {
        if (actionState.events.length <= 1) return;
        const ok = await uiKit.confirmDialog({
          title: `删除事件「${evt.title}」`,
          message: '确认删除该本地事件节点吗？',
          confirmLabel: '确认删除',
          tone: 'danger',
        });
        if (!ok) return;
        actionState.events = actionState.events.filter((e) => e.id !== evt.id);
        await persistEvents();
        uiKit.showToast(`已删除事件：${evt.title}`, 'ok');
        renderList();
      });
    });
  };

  renderList();
  sheetHandle = uiKit.openBottomSheet({
    title: '事件规则编辑器',
    subtitle: `共 ${actionState.events.length} 个本地事件节点（IndexedDB 持久化）`,
    content: wrap,
    actions: [{ id: 'done', label: '关闭', tone: 'secondary' }],
  });
}

// ============================================================
// Root View Renderer
// ============================================================

async function renderActionConsole() {
  if (!actionState.container || !actionState.context) return;
  const { assets, resources, narrative, turnStepper, modules, uiKit } = actionState.context;
  const char = getActiveCharacter();
  if (!char) {
    actionState.container.innerHTML = `
      <section class="surface-card">
        <h2 class="section-title">暂无可用角色</h2>
        <p class="muted-text">请先在「角色控制台」创建至少一名角色。</p>
      </section>
    `;
    return;
  }

  const assetId = char.meta?.avatarAssetId || null;
  const cacheKey = `${char.id}::${assetId || 'none'}`;
  let avatarUrl = actionState.avatarCache.get(cacheKey);
  if (!avatarUrl) {
    const resolved = await assets.getAssetUrl(assetId, {
      fallbackSeed: char.id,
      fallbackLabel: char.name.slice(0, 6),
    });
    avatarUrl = resolved.url;
    actionState.avatarCache.set(cacheKey, avatarUrl);
  }

  const gear = getCharacterOutfitAndGearContext(char);
  const mode = narrative.getMode();
  const isAiMode = mode !== NARRATIVE_MODES.LOCAL;
  const step = turnStepper.getSnapshot();
  const resList = resources.list();
  const isPinnedDefault = modules.getDefaultModuleId() === 'action-console';

  actionState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'ac-root';

  // 1. Top Compact Status Bar
  const statusCard = document.createElement('section');
  statusCard.className = 'surface-card ac-status-card';
  statusCard.id = 'ac-status-card';
  statusCard.innerHTML = `
    <div class="ac-status-top">
      <img class="ac-avatar-sm" src="${avatarUrl}" alt="${escapeHtml(char.name)} 头像">
      <div class="ac-status-meta">
        <div class="ac-status-name-row">
          <span class="ac-char-name" id="ac-char-name">${escapeHtml(char.name)}</span>
          <span class="status-badge badge-muted">T${step.turn}</span>
        </div>
        <span class="ac-outfit-line" id="ac-outfit-name">服装：${escapeHtml(gear.outfitName)}</span>
      </div>
      <button type="button" id="btn-ac-mode-toggle" class="ac-mode-toggle ${isAiMode ? 'is-ai' : ''}">
        ${isAiMode ? 'AI 增强模式' : '纯本地模式'}
      </button>
    </div>

    <div id="ac-compact-bars" class="ac-bars-compact"></div>

    <div class="cc-resource-strip" id="ac-resource-strip">
      ${resList
        .slice(0, 3)
        .map(
          (r) => `
        <div class="cc-resource-pill" data-ac-res="${escapeHtml(r.id)}">
          <span class="cc-resource-pill-label">${escapeHtml(r.name)}</span>
          <span class="cc-resource-pill-val">${r.amount}${escapeHtml(r.unit)}</span>
        </div>
      `
        )
        .join('')}
    </div>

    <div class="cc-btn-3col">
      <button type="button" id="btn-ac-open-editor" class="btn-secondary uikit-touch-target">事件编辑器</button>
      <button type="button" id="btn-ac-pin-default" class="btn-secondary uikit-touch-target">${isPinnedDefault ? '已设默认页' : '设为默认页'}</button>
      <button type="button" id="btn-ac-goto-char" class="btn-secondary uikit-touch-target">返回角色台</button>
    </div>
  `;

  const barsHost = statusCard.querySelector('#ac-compact-bars');
  const maxHp = Number(char.stats.maxHp ?? 100);
  const maxAp = Number(char.stats.maxAp ?? 100);
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: 'HP',
      value: char.stats.hp ?? 100,
      max: maxHp,
      showPercent: false,
      sublabel: `${Math.round(char.stats.hp ?? 100)}/${maxHp}`,
      tone: (char.stats.hp ?? 100) / maxHp < 0.3 ? 'danger' : 'accent',
    }).element
  );
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: '士气',
      value: char.stats.morale ?? 50,
      max: 100,
      showPercent: false,
      sublabel: `${Math.round(char.stats.morale ?? 50)}`,
      tone: (char.stats.morale ?? 50) < 30 ? 'danger' : (char.stats.morale ?? 50) < 50 ? 'warn' : 'accent',
    }).element
  );
  barsHost.appendChild(
    uiKit.createProgressBar({
      label: 'AP',
      value: char.stats.ap ?? 100,
      max: maxAp,
      showPercent: false,
      sublabel: `${Math.round(char.stats.ap ?? 100)}/${maxAp}`,
      tone: (char.stats.ap ?? 100) / maxAp < 0.25 ? 'warn' : 'accent',
    }).element
  );

  statusCard.querySelector('#btn-ac-mode-toggle').addEventListener('click', () => {
    const next = isAiMode ? NARRATIVE_MODES.LOCAL : NARRATIVE_MODES.AI_POLISH;
    narrative.setMode(next);
    uiKit.showToast(
      next === NARRATIVE_MODES.LOCAL
        ? '已切换至「纯本地模式」（零 API 消耗，离线可用）'
        : '已切换至「AI 增强模式」（无 Key 时自动降级到本地模板）',
      'ok'
    );
    renderActionConsole();
  });

  statusCard.querySelector('#btn-ac-open-editor').addEventListener('click', () => openEventEditorSheet());

  statusCard.querySelector('#btn-ac-pin-default').addEventListener('click', () => {
    if (modules.getDefaultModuleId() === 'action-console') {
      modules.setDefaultModuleId(null);
      uiKit.showToast('已取消默认启动页固定', 'info');
    } else {
      modules.setDefaultModuleId('action-console');
      uiKit.showToast('已将「行动与事件台」设为默认启动页', 'ok');
    }
    renderActionConsole();
  });

  statusCard.querySelector('#btn-ac-goto-char').addEventListener('click', () => {
    if (modules.has('character-console')) {
      modules.mount('character-console');
    }
  });

  root.appendChild(statusCard);

  // 2. Primary Action Triggers Bar
  const actionsCard = document.createElement('section');
  actionsCard.className = 'surface-card';
  actionsCard.style.padding = '10px 12px';
  actionsCard.innerHTML = `
    <div class="cc-btn-3col">
      <button type="button" id="btn-ac-explore" class="btn-primary uikit-touch-target" ${actionState.busy ? 'disabled' : ''}>执行探索</button>
      <button type="button" id="btn-ac-random" class="btn-secondary uikit-touch-target" ${actionState.busy ? 'disabled' : ''}>随机事件</button>
      <button type="button" id="btn-ac-rest" class="btn-secondary uikit-touch-target" ${actionState.busy ? 'disabled' : ''}>状态休整</button>
    </div>
  `;
  actionsCard.querySelector('#btn-ac-explore').addEventListener('click', () =>
    drawAndTriggerFromPool('action_explore_pool', { spendAp: true })
  );
  actionsCard.querySelector('#btn-ac-random').addEventListener('click', () =>
    drawAndTriggerFromPool('action_random_pool', { spendAp: true })
  );
  actionsCard.querySelector('#btn-ac-rest').addEventListener('click', () => performRestAction());
  root.appendChild(actionsCard);

  // 3. Active Unresolved Event Card (Interactive Branching)
  if (actionState.activeEvent) {
    const evt = actionState.activeEvent;
    const evtCard = document.createElement('section');
    evtCard.className = 'ac-card ac-card-event';
    evtCard.id = 'ac-active-event-card';
    evtCard.innerHTML = `
      <div class="ac-card-head">
        <h3 class="ac-card-title" id="ac-active-event-title">${escapeHtml(evt.title)}</h3>
        <span class="status-badge badge-ok">${escapeHtml(CATEGORY_LABELS[evt.category] || '事件')}</span>
      </div>
      <p class="ac-card-body">${escapeHtml(evt.description)}</p>
      <div class="lab-choice-list" id="ac-active-choices"></div>
    `;

    const choiceHost = evtCard.querySelector('#ac-active-choices');
    for (const ch of evt.choices || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lab-choice-btn';
      btn.dataset.acChoiceId = ch.id;
      btn.disabled = actionState.busy;
      const statLabel =
        ch.statKey && ch.statKey !== 'none'
          ? `${CORE_STAT_MAP[ch.statKey]?.label || ch.statKey}检定 · DC ${ch.dc}`
          : '免检定（稳妥结算）';
      btn.innerHTML = `
        <span class="lab-choice-title">${escapeHtml(ch.label)}</span>
        <span class="lab-choice-sub">${escapeHtml(statLabel)}</span>
      `;
      btn.addEventListener('click', () => executeActiveChoice(ch.id));
      choiceHost.appendChild(btn);
    }

    root.appendChild(evtCard);
  }

  // 4. Chronological Timeline Stream
  const timelineWrap = document.createElement('div');
  timelineWrap.className = 'ac-timeline';
  timelineWrap.id = 'ac-timeline';

  if (actionState.timeline.length === 0 && !actionState.activeEvent) {
    timelineWrap.innerHTML = `
      <section class="surface-card empty-state">
        <h3 class="empty-title">行动与事件台已就绪</h3>
        <p class="muted-text">
          点击上方「执行探索」「随机事件」「状态休整」，或在底部输入框输入任意自由行动指令即可开始。纯本地模式下无需配置任何 API Key 即可完整运行。
        </p>
      </section>
    `;
  } else {
    // Show newest records at top or bottom? Showing newest first keeps the latest settlement immediately visible under active event on mobile!
    const reversed = [...actionState.timeline].reverse();
    for (const item of reversed) {
      const card = document.createElement('article');
      card.className = 'ac-card';
      card.dataset.timelineId = item.id;

      const sourceLabel = item.degraded
        ? '降级 → 本地模板'
        : item.source === 'local-template'
        ? '纯本地模板'
        : 'AI 增强';

      card.innerHTML = `
        <div class="ac-card-head">
          <h3 class="ac-card-title">${escapeHtml(item.eventTitle)}</h3>
          <span class="status-badge ${item.degraded ? 'badge-warn' : 'badge-muted'}">${escapeHtml(sourceLabel)} · ${escapeHtml(formatTimeShort(item.timestamp))}</span>
        </div>
        <p class="ac-card-body">${escapeHtml(item.text)}</p>
        ${
          item.check
            ? `
          <div class="cc-check-result outcome-${escapeHtml(item.check.outcome)}" style="padding:10px;">
            <div class="cc-check-headline">
              <span class="cc-check-outcome" style="font-size:15px;">${escapeHtml(item.check.statLabel)} · ${escapeHtml(item.check.outcomeLabel)}</span>
              <span class="cc-check-score" style="font-size:13.5px;">${item.check.total} / DC ${item.check.dc}（${formatSigned(item.check.margin)}）</span>
            </div>
            <div class="cc-check-steps">
              ${(item.check.steps || [])
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
        ${
          item.chips && item.chips.length > 0
            ? `
          <div class="ac-settlement-chips">
            ${item.chips
              .map(
                (c) => `<span class="ac-delta-chip ${c.negative ? 'is-neg' : ''}">${escapeHtml(c.text)}</span>`
              )
              .join('')}
          </div>
        `
            : ''
        }
      `;
      timelineWrap.appendChild(card);
    }
  }

  root.appendChild(timelineWrap);
  actionState.container.appendChild(root);
}

// ============================================================
// Standard Module Export
// ============================================================

export default {
  id: 'action-console',
  name: '行动与事件台',
  description: '纯本地离线与 AI 增强双轨行动台：探索、随机事件、D20 检定拆解、状态休整与手机端可视化事件规则编辑器。',

  mount(container, context) {
    actionState.container = container;
    actionState.context = context;
    actionState.avatarCache.clear();

    context.ui.setPlaceholder('输入自由行动指令（如：侦察周边 / 寻找物资 / 状态休整）...');
    context.ui.setInputHandler(handleFreeActionInput);
    context.ui.setQuickActions([
      {
        id: 'ac-q-explore',
        label: '执行探索',
        onClick: () => drawAndTriggerFromPool('action_explore_pool', { spendAp: true }),
      },
      {
        id: 'ac-q-random',
        label: '随机事件',
        onClick: () => drawAndTriggerFromPool('action_random_pool', { spendAp: true }),
      },
      {
        id: 'ac-q-rest',
        label: '状态休整',
        onClick: () => performRestAction(),
      },
      {
        id: 'ac-q-editor',
        label: '事件编辑器',
        onClick: () => openEventEditorSheet(),
      },
    ]);

    actionState.unsubs = [
      context.bus.on('character:selected', () => renderActionConsole()),
      context.bus.on('inventory:equipped', () => renderActionConsole()),
      context.bus.on('inventory:unequipped', () => renderActionConsole()),
      context.bus.on('narrative:mode-changed', () => renderActionConsole()),
      context.bus.on('storage:changed', (detail) => {
        if (detail?.action === 'resetAll' || detail?.action === 'import') {
          renderActionConsole();
        }
      }),
    ];

    if (!actionState.hydrated) {
      hydrateActionConsole({ storage: context.rootStorage, rules: context.rules }).then(() =>
        renderActionConsole()
      );
    } else {
      syncEventsToRuleEngine(context.rules, actionState.events);
      renderActionConsole();
    }
  },

  unmount() {
    for (const unsub of actionState.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    actionState.unsubs = [];
    actionState.container = null;
    actionState.context = null;
  },
};
