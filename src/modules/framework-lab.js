/**
 * Framework Self-Test Sandbox Module (`framework-lab`).
 *
 * Domain-neutral interactive testbench for verifying all core framework engines on mobile:
 *   1. Local deterministic rule engine, state machine, turn stepper & dual-track narrative router
 *   2. Safe zero-eval formula calculator, multi-layer stat stacking, dice & offline time settlement
 *   3. Hybrid IndexedDB storage, event-driven auto-save & 5-slot manual save/load/export/import
 *   4. Mobile image downscaling/WebP compression into IndexedDB & geometric SVG placeholders
 *   5. One-handed mobile UI Kit components (>=44px touch targets & safe-area layout)
 */

import { NARRATIVE_MODES, NARRATIVE_MODE_META } from '../core/prompt-pipeline.js';
import { triggerJsonDownload } from '../core/save-manager.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function formatShortTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString([], {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

const DEMO_NODES = [
  {
    id: 'node_alpha',
    title: '节点 Alpha · 资源调度检测',
    weight: 40,
    tags: ['lab', 'pool'],
    conditions: [],
    template:
      '【{phaseLabel} · 第 {turn} 回合】主体 {actor.name} 当前能量 {actor.energy}、完整度 {actor.integrity}、积分 {actor.score}。请选择执行分支以验证纯本地规则引擎。',
    choices: [
      {
        id: 'alpha_boost',
        label: '高负荷运转（消耗 20 能量 → 积分 +25，令牌 +1）',
        conditions: [{ type: 'stat', entityId: 'unit_a', stat: 'energy', op: '>=', value: 20 }],
        disabledHint: '需要能量 >= 20',
        effects: [
          { type: 'statDelta', entityId: 'unit_a', stat: 'energy', value: -20, min: 0, max: 100 },
          { type: 'statDelta', entityId: 'unit_a', stat: 'score', value: 25, min: 0, max: 9999 },
          { type: 'itemDelta', key: 'token', value: 1 },
          { type: 'setFlag', key: 'boost_tested', value: true },
        ],
        outcomeTemplate:
          '分支「高负荷运转」执行完毕：能量 {+delta.energy|0}，积分 {+delta.score|0}，获得通用令牌 +1（当前共 {items.token|0} 枚）。',
        nextNodeId: 'node_beta',
        nextPhase: 'active',
      },
      {
        id: 'alpha_recover',
        label: '低耗休整（恢复 25 能量，完整度 +10）',
        conditions: [],
        effects: [
          { type: 'statDelta', entityId: 'unit_a', stat: 'energy', value: 25, min: 0, max: 100 },
          { type: 'statDelta', entityId: 'unit_a', stat: 'integrity', value: 10, min: 0, max: 100 },
        ],
        outcomeTemplate:
          '分支「低耗休整」执行完毕：能量 {+delta.energy|0}（当前 {actor.energy}），完整度 {+delta.integrity|0}（当前 {actor.integrity}）。',
        nextPoolId: 'lab_pool',
        nextPhase: 'standby',
      },
    ],
  },
  {
    id: 'node_beta',
    title: '节点 Beta · 条件与公式联动',
    weight: 35,
    tags: ['lab', 'pool'],
    conditions: [],
    template:
      '【{phaseLabel} · 第 {turn} 回合】进入条件校验节点。主体 {actor.name} 持有通用令牌 {items.token|0} 枚，有效战力系数 {effective.power}。',
    choices: [
      {
        id: 'beta_token_spend',
        label: '消耗 1 令牌触发公式结算（积分 += floor(power * 0.4) + 1d6）',
        conditions: [{ type: 'item', key: 'token', op: '>=', value: 1 }],
        disabledHint: '需要持有至少 1 枚通用令牌',
        effects: [
          { type: 'itemDelta', key: 'token', value: -1 },
          {
            type: 'statFormula',
            entityId: 'unit_a',
            stat: 'score',
            expr: 'entities.unit_a.score + floor(entities.unit_a.power * 0.4) + roll(1, 6)',
            min: 0,
            max: 9999,
          },
          { type: 'setFlag', key: 'formula_branch_done', value: true },
        ],
        outcomeTemplate:
          '分支「公式结算」完成：消耗 1 令牌，积分变动 {+delta.score|0}（当前积分 {actor.score}），已标记 formula_branch_done。',
        nextNodeId: 'node_gamma',
        nextPhase: 'settle',
      },
      {
        id: 'beta_safe_pass',
        label: '保守推进（积分 +10，跳转随机池）',
        conditions: [],
        effects: [
          { type: 'statDelta', entityId: 'unit_a', stat: 'score', value: 10, min: 0, max: 9999 },
        ],
        outcomeTemplate: '分支「保守推进」完成：积分 {+delta.score|0}，已重新从加权事件池抽取下一节点。',
        nextPoolId: 'lab_pool',
        nextPhase: 'active',
      },
    ],
  },
  {
    id: 'node_gamma',
    title: '节点 Gamma · 周期结算与标记回环',
    weight: 25,
    tags: ['lab', 'pool'],
    conditions: [],
    template:
      '【{phaseLabel} · 第 {turn} 回合】周期结算节点已激活。当前完整度 {actor.integrity}%，已验证高负荷标记：{flags.boost_tested|false}。',
    choices: [
      {
        id: 'gamma_complete',
        label: '完成周期结算（能量 +15，令牌 +1，回到待机阶段）',
        conditions: [],
        effects: [
          { type: 'statDelta', entityId: 'unit_a', stat: 'energy', value: 15, min: 0, max: 100 },
          { type: 'itemDelta', key: 'token', value: 1 },
          { type: 'setVar', key: 'cyclesCleared', value: 1 },
        ],
        outcomeTemplate:
          '周期结算完成：能量 {+delta.energy|0}，令牌 +1，系统状态切换回「待机准备」，继续下一轮验证。',
        nextNodeId: 'node_alpha',
        nextPhase: 'standby',
      },
    ],
  },
];

let labState = {
  container: null,
  context: null,
  activeTab: 'rules',
  tabsCtrl: null,
  unsubs: [],
  autoSaveEnabled: true,
  autoSaveUnbind: null,
  lastNarrative: null,
  lastCalcResult: null,
  lastDiceResult: null,
  lastOfflineReport: null,
  formulaDraft: 'clamp(round(power * (1 + bonusPct) + flat), 0, 999)',
  saveNameDraft: '',
  placeholderSeed: 'unit-01',
  demoProgressVal: 68,
  busy: false,
  slotsCache: [],
  autoMetaCache: null,
  hybridStatsCache: null,
  modsCache: [],
  assetsCache: [],
  assetUrls: new Map(),
};

function ensureDemoFixtures(context) {
  const { entities, rules, stateMachine, turnStepper } = context;

  // Register generic phase state machine once
  if (stateMachine.listStates().length === 0) {
    stateMachine
      .addState('standby', { label: '待机准备' })
      .addState('active', { label: '执行阶段' })
      .addState('settle', { label: '周期结算' })
      .addTransitions([
        { from: 'standby', to: 'active', label: '进入执行' },
        { from: 'active', to: 'settle', label: '进入结算' },
        { from: 'settle', to: 'standby', label: '返回待机' },
        { from: 'active', to: 'standby', label: '中断待机' },
      ]);
  }

  // Register generic test entity once
  if (!entities.has('unit_a')) {
    entities.register({
      id: 'unit_a',
      kind: 'actor',
      name: '测试主体 #01',
      tags: ['demo', 'primary'],
      stats: {
        power: 100,
        energy: 75,
        integrity: 82,
        score: 120,
      },
      statBounds: {
        energy: { min: 0, max: 100 },
        integrity: { min: 0, max: 100 },
        score: { min: 0, max: 99999 },
      },
      modifiers: [
        { id: 'mod_base_add', stat: 'power', layer: 'baseAdd', value: 20, source: '基础固定加成 +20', enabled: true },
        { id: 'mod_pct_add', stat: 'power', layer: 'percentAdd', value: 0.25, source: '加法百分比 +25%', enabled: true },
        { id: 'mod_pct_mult', stat: 'power', layer: 'percentMult', value: 0.1, source: '独立乘区 ×1.10', enabled: true },
        { id: 'mod_flat_final', stat: 'power', layer: 'flatFinal', value: 15, source: '最终固定附加 +15', enabled: true },
      ],
    });
  }

  // Register generic countdown task if none exists
  if (entities.listTasks().length === 0) {
    entities.registerTask({
      id: 'task_01',
      label: '通用倒计时任务 #01（60分钟）',
      durationSec: 3600,
      startedAt: Date.now() - 600 * 1000,
    });
  }

  // Register generic rule nodes & pool once
  if (rules.listNodes().length === 0) {
    rules.registerNodes(DEMO_NODES);
    rules.registerPool('lab_pool', ['node_alpha', 'node_beta', 'node_gamma']);
    if (rules.getItemCount('token') === 0) {
      rules.adjustItem('token', 1);
    }
    rules.enterNode('node_alpha', buildRuntimeCtx(context));
  } else if (!rules.currentNodeId) {
    rules.enterNode('node_alpha', buildRuntimeCtx(context));
  }

  // Ensure stepper has generic labels
  if (!turnStepper.getSnapshot().cycleLabel) {
    turnStepper.setCycleLabels(['阶段 I', '阶段 II', '阶段 III']);
  }
}

function buildRuntimeCtx(context) {
  const { stateMachine, turnStepper } = context;
  const step = turnStepper.getSnapshot();
  return {
    phase: stateMachine.getState(),
    phaseLabel: stateMachine.getStateDef()?.label || stateMachine.getState() || '',
    turn: step.turn,
    cycleLabel: step.cycleLabel,
  };
}

function buildTemplateVars(context, extra = {}) {
  const { entities, rules, stateMachine, turnStepper } = context;
  const actor = entities.get('unit_a');
  const effective = actor ? entities.getEffectiveStats('unit_a') : {};
  const step = turnStepper.getSnapshot();
  return {
    phase: stateMachine.getState() || '',
    phaseLabel: stateMachine.getStateDef()?.label || '',
    turn: step.turn,
    cycleLabel: step.cycleLabel,
    actor: actor ? { name: actor.name, ...actor.stats } : {},
    effective,
    items: { ...rules.inventory },
    flags: { ...rules.flags },
    vars: { ...rules.vars },
    ...extra,
  };
}

function captureFrameworkSnapshot(context) {
  const { entities, rules, stateMachine, turnStepper } = context;
  const actor = entities.get('unit_a');
  const step = turnStepper.getSnapshot();
  return {
    data: {
      entities: entities.serialize(),
      rules: rules.serialize(),
      stateMachine: stateMachine.serialize(),
      turnStepper: turnStepper.serialize(),
      savedAtTs: Date.now(),
    },
    summary: {
      turn: step.turn,
      phase: stateMachine.getStateDef()?.label || stateMachine.getState(),
      energy: actor?.stats?.energy ?? 0,
      score: actor?.stats?.score ?? 0,
      tokens: rules.getItemCount('token'),
    },
  };
}

function restoreFrameworkSnapshot(context, data) {
  if (!data || typeof data !== 'object') return;
  if (data.entities) context.entities.deserialize(data.entities);
  if (data.rules) context.rules.deserialize(data.rules);
  if (data.stateMachine) context.stateMachine.deserialize(data.stateMachine);
  if (data.turnStepper) context.turnStepper.deserialize(data.turnStepper);
}

async function refreshAsyncCaches() {
  if (!labState.context) return;
  const { saves, rootStorage, assets } = labState.context;
  const [slots, autoMeta, hybridStats, mods, assetList] = await Promise.all([
    saves.listSlots(),
    saves.getAutoSaveMeta(),
    rootStorage.getHybridStats(),
    saves.listModData(),
    assets.listAssets(),
  ]);
  labState.slotsCache = slots;
  labState.autoMetaCache = autoMeta;
  labState.hybridStatsCache = hybridStats;
  labState.modsCache = mods;
  labState.assetsCache = assetList;

  const urlEntries = await Promise.all(
    assetList.map(async (item) => {
      const resolved = await assets.getAssetUrl(item.id, { fallbackSeed: item.id, fallbackLabel: item.label });
      return [item.id, resolved.url];
    })
  );
  labState.assetUrls = new Map(urlEntries);
}

// ============================================================
// Tab 1: Rules Engine, State Machine & Dual-Track Narrative
// ============================================================

function renderRulesTab(host) {
  const { entities, rules, stateMachine, turnStepper, narrative, uiKit } = labState.context;
  const actor = entities.get('unit_a');
  const step = turnStepper.getSnapshot();
  const phaseId = stateMachine.getState();
  const phaseLabel = stateMachine.getStateDef()?.label || phaseId;
  const allowedTransitions = stateMachine.getAllowedTransitions();
  const currentMode = narrative.getMode();
  const canLiveAI = narrative.canUseLiveAI();

  const runtimeCtx = buildRuntimeCtx(labState.context);
  const currentNode = rules.getNode(rules.currentNodeId) || rules.listNodes()[0];
  const nodeDesc = currentNode ? narrative.renderTemplate(currentNode.template, buildTemplateVars(labState.context)) : '';
  const choices = currentNode ? rules.getAvailableChoices(currentNode.id, runtimeCtx) : [];

  // Card 1: State Machine & Turn Stepper
  const stateCard = document.createElement('section');
  stateCard.className = 'surface-card lab-stack-sm';
  stateCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom: 0;">
      <h2 class="section-title">状态机与回合步进器</h2>
      <span class="status-badge badge-ok" id="lab-phase-badge">${escapeHtml(phaseLabel)}</span>
    </div>
    <div class="lab-kv-grid-3">
      <div class="metric-card">
        <span class="metric-value" id="lab-turn-val">T${step.turn}</span>
        <span class="metric-label">${escapeHtml(step.cycleLabel)}</span>
      </div>
      <div class="metric-card">
        <span class="metric-value" id="lab-energy-val">${actor?.stats?.energy ?? 0}</span>
        <span class="metric-label">主体能量</span>
      </div>
      <div class="metric-card">
        <span class="metric-value" id="lab-score-val">${actor?.stats?.score ?? 0}</span>
        <span class="metric-label">积分 · 令牌 ${rules.getItemCount('token')}</span>
      </div>
    </div>
    <div class="lab-btn-row" id="lab-state-actions"></div>
  `;

  const stateActions = stateCard.querySelector('#lab-state-actions');
  const stepBtn = document.createElement('button');
  stepBtn.type = 'button';
  stepBtn.id = 'btn-lab-step-turn';
  stepBtn.className = 'btn-primary uikit-touch-target';
  stepBtn.textContent = '步进周期 (+1)';
  stepBtn.addEventListener('click', () => {
    const res = turnStepper.advance({ steps: 1, reason: 'lab-manual' });
    entities.tickModifiers({ turns: 1 });
    uiKit.showToast(`已推进至第 ${res.current.turn} 回合 · ${res.current.cycleLabel}`, 'ok');
    renderActiveTab();
  });
  stateActions.appendChild(stepBtn);

  for (const tr of allowedTransitions) {
    const trBtn = document.createElement('button');
    trBtn.type = 'button';
    trBtn.className = 'btn-secondary uikit-touch-target';
    trBtn.dataset.transitionTo = tr.to;
    trBtn.textContent = `切换：${tr.label}`;
    trBtn.addEventListener('click', () => {
      const res = stateMachine.transition(tr.to, { source: 'lab' });
      if (res.ok) {
        uiKit.showToast(`状态机切换：${res.from} → ${res.to}`, 'ok');
        renderActiveTab();
      } else {
        uiKit.showToast(res.reason, 'warn');
      }
    });
    stateActions.appendChild(trBtn);
  }
  host.appendChild(stateCard);

  // Card 2: Dual-Track Narrative Mode Switcher
  const modeCard = document.createElement('section');
  modeCard.className = 'surface-card lab-stack-sm';
  modeCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom: 0;">
      <h2 class="section-title">双轨叙事路由模式</h2>
      <span class="status-badge ${canLiveAI ? 'badge-ok' : 'badge-warn'}" id="lab-ai-readiness">
        ${canLiveAI ? '真实 API 已就绪' : '无 Key · 离线/降级可用'}
      </span>
    </div>
    <div id="lab-mode-tabs-mount"></div>
    <p class="muted-text" id="lab-mode-desc">${escapeHtml(NARRATIVE_MODE_META[currentMode]?.description || '')}</p>
  `;
  const modeTabs = uiKit.createTabs({
    items: [
      { id: NARRATIVE_MODES.LOCAL, label: '纯本地模板' },
      { id: NARRATIVE_MODES.AI_POLISH, label: 'AI 润色' },
      { id: NARRATIVE_MODES.AI_FREE, label: 'AI 自由' },
    ],
    activeId: currentMode,
    onChange: (nextMode) => {
      narrative.setMode(nextMode);
      uiKit.showToast(`已切换路由模式：${narrative.getModeInfo(nextMode).label}`, 'ok');
      renderActiveTab();
    },
  });
  modeCard.querySelector('#lab-mode-tabs-mount').appendChild(modeTabs.element);
  host.appendChild(modeCard);

  // Card 3: Deterministic Local Event Node & Choices
  const nodeCard = document.createElement('section');
  nodeCard.className = 'surface-card lab-stack-sm';
  nodeCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom: 0;">
      <h2 class="section-title" id="lab-node-title">${escapeHtml(currentNode?.title || '无活动节点')}</h2>
      <button type="button" id="btn-lab-draw-pool" class="btn-ghost-sm">加权抽取</button>
    </div>
    <div class="lab-narrative-box" id="lab-node-template">${escapeHtml(nodeDesc)}</div>
    <div class="lab-choice-list" id="lab-choice-list"></div>
  `;

  nodeCard.querySelector('#btn-lab-draw-pool').addEventListener('click', () => {
    const drawn = rules.drawFromPool('lab_pool', buildRuntimeCtx(labState.context));
    if (drawn.node) {
      uiKit.showToast(`加权抽取节点：${drawn.node.title}（候选 ${drawn.eligibleCount}/${drawn.totalCount}）`, 'ok');
      renderActiveTab();
    } else {
      uiKit.showToast('当前无满足条件的事件节点', 'warn');
    }
  });

  const choiceList = nodeCard.querySelector('#lab-choice-list');
  for (const ch of choices) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lab-choice-btn';
    btn.dataset.choiceId = ch.id;
    btn.disabled = !ch.available || labState.busy;
    btn.innerHTML = `
      <span class="lab-choice-title">${escapeHtml(ch.label)}</span>
      <span class="lab-choice-sub">${
        ch.available
          ? `跳转：${escapeHtml(ch.nextNodeId || (ch.nextPoolId ? `随机池 ${ch.nextPoolId}` : '保持当前'))}`
          : `不可用：${escapeHtml(ch.reason)}`
      }</span>
    `;
    btn.addEventListener('click', async () => {
      if (labState.busy) return;
      labState.busy = true;
      try {
        const res = rules.executeChoice(currentNode.id, ch.id, buildRuntimeCtx(labState.context));
        if (!res.ok) {
          uiKit.showToast(res.reason, 'warn');
          return;
        }
        if (res.nextPhase && stateMachine.getState() !== res.nextPhase) {
          const can = stateMachine.canTransition(res.nextPhase);
          if (can.ok) {
            stateMachine.transition(res.nextPhase, { source: 'rule-engine', choiceId: ch.id });
          } else {
            stateMachine.transition(res.nextPhase, { source: 'rule-engine', choiceId: ch.id }, { force: true });
          }
        }
        const vars = buildTemplateVars(labState.context, {
          delta: res.executionLog.deltas,
        });
        const rendered = await narrative.run({
          template: res.outcomeTemplate,
          variables: vars,
          ruleResult: res,
        });
        labState.lastNarrative = {
          ...rendered,
          choiceLabel: ch.label,
          deltas: res.executionLog.deltas,
          itemsChanged: res.executionLog.itemsChanged,
          timestamp: Date.now(),
        };
        uiKit.showToast(
          rendered.degraded ? '无可用 API，已自动降级为本地模板输出' : `执行完成（${rendered.source}）`,
          rendered.degraded ? 'warn' : 'ok'
        );
      } finally {
        labState.busy = false;
        renderActiveTab();
      }
    });
    choiceList.appendChild(btn);
  }
  host.appendChild(nodeCard);

  // Card 4: Latest Dual-Track Output Box
  if (labState.lastNarrative) {
    const out = labState.lastNarrative;
    const outCard = document.createElement('section');
    outCard.className = 'surface-card';
    outCard.id = 'lab-narrative-output-card';
    outCard.innerHTML = `
      <div class="lab-narrative-meta">
        <span class="section-title">双轨输出回执</span>
        <span class="status-badge ${out.degraded ? 'badge-warn' : 'badge-ok'}" id="lab-narrative-source-badge">
          ${escapeHtml(out.degraded ? `降级回退 → ${out.source}` : out.source)} · ${out.latencyMs}ms
        </span>
      </div>
      <div class="lab-narrative-box" id="lab-narrative-text">${escapeHtml(out.text)}</div>
      ${
        out.degradeReason
          ? `<p class="muted-text" style="margin-top:8px;" id="lab-degrade-reason">降级说明：${escapeHtml(out.degradeReason)}</p>`
          : ''
      }
    `;
    host.appendChild(outCard);
  }
}

// ============================================================
// Tab 2: Calc Engine, Stat Stacking, Dice & Offline Settlement
// ============================================================

function renderCalcTab(host) {
  const { calc, entities, uiKit } = labState.context;
  const actor = entities.get('unit_a');
  const stackedPower = entities.getEffectiveStat('unit_a', 'power', { round: 'round' });

  // Card 1: Safe Formula Evaluator
  const formulaCard = document.createElement('section');
  formulaCard.className = 'surface-card lab-stack-sm';
  formulaCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">安全公式解析器（零 eval）</h2>
      <span class="status-badge badge-ok">AST/递归下降</span>
    </div>
    <p class="muted-text">可用变量：<code>power=${stackedPower.final}</code>、<code>energy=${actor.stats.energy}</code>、<code>bonusPct=0.35</code>、<code>flat=18</code></p>
    <input id="lab-formula-input" class="form-input" type="text" value="${escapeHtml(labState.formulaDraft)}" aria-label="数学与属性公式">
    <div class="chip-row" id="lab-formula-presets">
      <button type="button" class="preset-chip" data-formula="clamp(round(power * (1 + bonusPct) + flat), 0, 999)">基础倍率钳制</button>
      <button type="button" class="preset-chip" data-formula="energy >= 50 ? power * 1.25 : power * 0.75">条件三元分支</button>
      <button type="button" class="preset-chip" data-formula="floor(sqrt(power) * 10) + roll(2, 6)">开方+骰子</button>
    </div>
    <div class="lab-btn-grid">
      <button type="button" id="btn-lab-eval-formula" class="btn-primary uikit-touch-target">计算公式</button>
      <button type="button" id="btn-lab-eval-unsafe" class="btn-secondary uikit-touch-target">测试安全拦截</button>
    </div>
    <div id="lab-formula-output" class="test-result-box ${
      labState.lastCalcResult ? (labState.lastCalcResult.ok ? 'is-ok' : 'is-error') : ''
    }" ${labState.lastCalcResult ? '' : 'hidden'}>${escapeHtml(labState.lastCalcResult?.message || '')}</div>
  `;

  const formulaInput = formulaCard.querySelector('#lab-formula-input');
  formulaInput.addEventListener('input', () => {
    labState.formulaDraft = formulaInput.value;
  });

  formulaCard.querySelectorAll('[data-formula]').forEach((chip) => {
    chip.addEventListener('click', () => {
      labState.formulaDraft = chip.getAttribute('data-formula') || '';
      formulaInput.value = labState.formulaDraft;
    });
  });

  const sampleVars = {
    power: stackedPower.final,
    energy: actor.stats.energy,
    integrity: actor.stats.integrity,
    bonusPct: 0.35,
    flat: 18,
  };

  formulaCard.querySelector('#btn-lab-eval-formula').addEventListener('click', () => {
    const expr = formulaInput.value.trim();
    labState.formulaDraft = expr;
    const check = calc.validate(expr, sampleVars);
    labState.lastCalcResult = check.valid
      ? { ok: true, message: `计算结果：${check.value}（公式：${expr}）` }
      : { ok: false, message: `解析拒绝：${check.error}` };
    renderActiveTab();
  });

  formulaCard.querySelector('#btn-lab-eval-unsafe').addEventListener('click', () => {
    const malicious = 'constructor.constructor("return 1")()';
    const check = calc.validate(malicious, sampleVars);
    labState.lastCalcResult = {
      ok: !check.valid,
      message: !check.valid
        ? `安全拦截通过：已拒绝非法表达式（${check.error}）`
        : '异常：非法表达式未被拦截',
    };
    uiKit.showToast('零 eval 安全拦截验证通过', 'ok');
    renderActiveTab();
  });

  host.appendChild(formulaCard);

  // Card 2: Multi-layer Stat Stacking + Dice
  const stackCard = document.createElement('section');
  stackCard.className = 'surface-card lab-stack-sm';
  stackCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">多层属性叠算 & 多面骰检定</h2>
      <span class="status-badge badge-ok" id="lab-stacked-final">最终值 ${stackedPower.final}</span>
    </div>
    <p class="muted-text">
      公式：<code>(基础 ${stackedPower.base} + 固定 ${stackedPower.breakdown.baseAdd}) × (1 + ${Math.round(stackedPower.breakdown.percentAddTotal * 100)}%) × ${stackedPower.breakdown.percentMultFactor} + 终值 ${stackedPower.breakdown.flatFinal} = ${stackedPower.final}</code>
    </p>
    <div class="lab-btn-grid" id="lab-mod-toggles"></div>
    <div class="lab-divider"></div>
    <div class="lab-btn-grid">
      <button type="button" id="btn-lab-roll-dice" class="btn-secondary uikit-touch-target">掷骰 roll(2, 6, 3)</button>
      <button type="button" id="btn-lab-chance-check" class="btn-secondary uikit-touch-target">65% 概率检定</button>
    </div>
    <div id="lab-dice-output" class="test-result-box is-ok" ${labState.lastDiceResult ? '' : 'hidden'}>${escapeHtml(
      labState.lastDiceResult || ''
    )}</div>
  `;

  const modGrid = stackCard.querySelector('#lab-mod-toggles');
  for (const mod of actor.modifiers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${mod.enabled ? 'btn-primary' : 'btn-secondary'} uikit-touch-target`;
    btn.style.fontSize = '12px';
    btn.textContent = `${mod.enabled ? '✓ ' : '○ '}${mod.source}`;
    btn.addEventListener('click', () => {
      entities.toggleModifier('unit_a', mod.id);
      renderActiveTab();
    });
    modGrid.appendChild(btn);
  }

  stackCard.querySelector('#btn-lab-roll-dice').addEventListener('click', () => {
    const r = calc.roll(2, 6, 3);
    labState.lastDiceResult = `骰子 ${r.expression} → 点数 [${r.rolls.join(', ')}] + 修正 ${r.modifier} = 总计 ${r.total}`;
    renderActiveTab();
  });

  stackCard.querySelector('#btn-lab-chance-check').addEventListener('click', () => {
    const c = calc.chanceCheck(65, { scale: 100 });
    labState.lastDiceResult = `概率检定（阈值 65%）：随机值 ${c.roll.toFixed(2)} → ${c.passed ? '检定成功' : '检定未通过'}`;
    renderActiveTab();
  });

  host.appendChild(stackCard);

  // Card 3: Offline Time Delta Simulator
  const offlineCard = document.createElement('section');
  offlineCard.className = 'surface-card lab-stack-sm';
  offlineCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">离线时间差结算模拟器</h2>
      <span class="status-badge badge-muted">恢复 + 倒计时</span>
    </div>
    <p class="muted-text">自动对比上次存档时间戳与当前时间，批量结算体力/能量恢复速率与倒计时任务进度。</p>
    <div id="lab-offline-bars" class="lab-stack-sm"></div>
    <div class="lab-btn-row">
      <button type="button" class="btn-secondary uikit-touch-target" data-offline-mins="15">模拟离线 +15分</button>
      <button type="button" class="btn-secondary uikit-touch-target" data-offline-mins="120">模拟离线 +2小时</button>
      <button type="button" class="btn-primary uikit-touch-target" id="btn-lab-drain-energy">消耗能量至 20</button>
    </div>
    <pre class="code-block" id="lab-offline-report" ${labState.lastOfflineReport ? '' : 'hidden'}>${escapeHtml(
      labState.lastOfflineReport ? JSON.stringify(labState.lastOfflineReport, null, 2) : ''
    )}</pre>
  `;

  const barsMount = offlineCard.querySelector('#lab-offline-bars');
  const energyBar = uiKit.createProgressBar({
    label: '主体能量（恢复速率 +0.5/分）',
    value: actor.stats.energy,
    max: 100,
    tone: actor.stats.energy < 30 ? 'danger' : 'accent',
  });
  barsMount.appendChild(energyBar.element);

  const tasks = entities.listTasks();
  for (const t of tasks) {
    const taskBar = uiKit.createProgressBar({
      label: t.label,
      value: Math.round(t.progress * 100),
      max: 100,
      tone: t.completed ? 'accent' : 'warn',
      sublabel: t.completed ? '已完成 (100%)' : `剩余 ${Math.ceil(t.remainingSec / 60)} 分钟`,
    });
    barsMount.appendChild(taskBar.element);
  }

  offlineCard.querySelector('#btn-lab-drain-energy').addEventListener('click', () => {
    entities.setStat('unit_a', 'energy', 20);
    // Reset demo task so user can test offline completion repeatedly
    entities.registerTask({
      id: 'task_01',
      label: '通用倒计时任务 #01（60分钟）',
      durationSec: 3600,
      startedAt: Date.now() - 600 * 1000,
    });
    uiKit.showToast('已将能量重置为 20 并重置倒计时任务', 'info');
    renderActiveTab();
  });

  offlineCard.querySelectorAll('[data-offline-mins]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mins = Number(btn.getAttribute('data-offline-mins'));
      const now = Date.now();
      const fakeLastTs = now - mins * 60 * 1000;
      // Shift demo task back to simulate passage of offline time
      const existing = entities.listTasks(now).find((t) => t.id === 'task_01');
      if (existing) {
        entities.registerTask({
          id: existing.id,
          label: existing.label,
          durationSec: existing.durationSec,
          startedAt: existing.startedAt - mins * 60 * 1000,
        });
      }
      const report = entities.settleOfflineTime({
        lastTimestamp: fakeLastTs,
        now,
        rules: [
          { entityId: 'unit_a', stat: 'energy', ratePerMinute: 0.5, min: 0, max: 100, round: 'round' },
          { entityId: 'unit_a', stat: 'integrity', ratePerMinute: 0.2, min: 0, max: 100, round: 'round' },
        ],
      });
      labState.lastOfflineReport = {
        elapsed: report.formattedDuration,
        statChanges: report.statChanges,
        completedTaskIds: report.completedTaskIds,
      };
      uiKit.showToast(`离线结算完成（经过 ${report.formattedDuration}）`, 'ok');
      renderActiveTab();
    });
  });

  host.appendChild(offlineCard);
}

// ============================================================
// Tab 3: Hybrid Storage, Auto-Save & 5 Manual Save Slots
// ============================================================

function renderSavesTab(host) {
  const { saves, uiKit } = labState.context;
  const stats = labState.hybridStatsCache;
  const autoMeta = labState.autoMetaCache;

  // Card 1: Hybrid Storage Stats + Auto-Save Snapshot
  const overviewCard = document.createElement('section');
  overviewCard.className = 'surface-card lab-stack-sm';
  overviewCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">混合存储 & 自动存档快照区</h2>
      <span class="status-badge badge-ok">IDB + Local</span>
    </div>
    <div class="lab-kv-grid">
      <div class="metric-card">
        <span class="metric-value">${stats ? formatBytes(stats.local.totalBytes) : '—'}</span>
        <span class="metric-label">localStorage (${stats?.local.totalKeys ?? 0} 键)</span>
      </div>
      <div class="metric-card">
        <span class="metric-value" id="lab-idb-bytes">${stats ? formatBytes(stats.idb.totalBytes) : '—'}</span>
        <span class="metric-label">IndexedDB (${stats?.idb.totalKeys ?? 0} 键)</span>
      </div>
    </div>
    <div class="lab-slot-card">
      <div class="lab-slot-head">
        <strong>自动存档快照（Auto-Save）</strong>
        <span class="status-badge ${labState.autoSaveEnabled ? 'badge-ok' : 'badge-muted'}">
          ${labState.autoSaveEnabled ? '事件监听开启' : '监听已暂停'}
        </span>
      </div>
      <div class="muted-text" id="lab-autosave-meta">
        ${
          autoMeta
            ? `最近保存：${escapeHtml(formatShortTime(autoMeta.timestamp))} · 触发源：<code>${escapeHtml(autoMeta.reason)}</code> · 回合 T${autoMeta.summary?.turn ?? '?'} / 能量 ${autoMeta.summary?.energy ?? '?'}`
            : '尚无自动存档（推进回合或触发事件时自动生成）'
        }
      </div>
      <div class="lab-btn-row">
        <button type="button" id="btn-lab-toggle-autosave" class="btn-secondary uikit-touch-target">
          ${labState.autoSaveEnabled ? '暂停监听' : '恢复监听'}
        </button>
        <button type="button" id="btn-lab-trigger-autosave" class="btn-primary uikit-touch-target">立即快照</button>
        <button type="button" id="btn-lab-load-autosave" class="btn-secondary uikit-touch-target" ${autoMeta ? '' : 'disabled'}>读取快照</button>
      </div>
    </div>
  `;

  overviewCard.querySelector('#btn-lab-toggle-autosave').addEventListener('click', () => {
    labState.autoSaveEnabled = !labState.autoSaveEnabled;
    uiKit.showToast(labState.autoSaveEnabled ? '已开启事件驱动自动存档' : '已暂停自动存档监听');
    renderActiveTab();
  });

  overviewCard.querySelector('#btn-lab-trigger-autosave').addEventListener('click', async () => {
    const snap = captureFrameworkSnapshot(labState.context);
    await saves.autoSave(snap.data, { reason: 'manual-trigger', summary: snap.summary });
    await refreshAsyncCaches();
    uiKit.showToast('自动存档快照已写入 IndexedDB', 'ok');
    renderActiveTab();
  });

  overviewCard.querySelector('#btn-lab-load-autosave').addEventListener('click', async () => {
    const rec = await saves.loadAutoSave();
    if (!rec) return;
    restoreFrameworkSnapshot(labState.context, rec.data);
    uiKit.showToast('已从自动存档快照恢复状态', 'ok');
    renderActiveTab();
  });

  host.appendChild(overviewCard);

  // Card 2: 5 Independent Manual Save Slots
  const slotsCard = document.createElement('section');
  slotsCard.className = 'surface-card lab-stack-sm';
  slotsCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">5 槽位独立手动存档（IndexedDB）</h2>
    </div>
    <input id="lab-save-name-input" class="form-input" type="text" placeholder="可选：输入自定义存档名称..." value="${escapeHtml(
      labState.saveNameDraft
    )}" aria-label="存档名称">
    <div id="lab-slots-list" class="lab-stack-sm"></div>
    <div class="lab-divider"></div>
    <div class="lab-btn-grid">
      <button type="button" id="btn-lab-export-all" class="btn-secondary uikit-touch-target">导出全库存档 JSON</button>
      <button type="button" id="btn-lab-import-all" class="btn-secondary uikit-touch-target">导入存档包 JSON</button>
      <input type="file" id="input-lab-import-saves" accept="application/json,.json" hidden>
    </div>
    <div class="lab-btn-row">
      <button type="button" id="btn-lab-save-mod" class="btn-secondary uikit-touch-target">写入模组区示例 (${labState.modsCache.length} 条)</button>
    </div>
  `;

  const nameInput = slotsCard.querySelector('#lab-save-name-input');
  nameInput.addEventListener('input', () => {
    labState.saveNameDraft = nameInput.value;
  });

  const slotsList = slotsCard.querySelector('#lab-slots-list');
  for (const slot of labState.slotsCache) {
    const item = document.createElement('div');
    item.className = 'lab-slot-card';
    item.dataset.slotIndex = String(slot.slotIndex);
    const meta = slot.meta;
    const summaryText = meta?.summary
      ? `回合 T${meta.summary.turn} · ${meta.summary.phase} · 能量 ${meta.summary.energy} · 积分 ${meta.summary.score}`
      : '空槽位';
    item.innerHTML = `
      <div class="lab-slot-head">
        <strong>槽位 ${slot.slotIndex} · ${escapeHtml(meta ? meta.name : '未使用')}</strong>
        <span class="muted-text" style="font-size:11.5px;">${meta ? escapeHtml(formatShortTime(meta.timestamp)) : '空'}</span>
      </div>
      <div class="muted-text">${escapeHtml(summaryText)}</div>
      <div class="lab-slot-actions">
        <button type="button" class="btn-primary" data-slot-act="save">保存</button>
        <button type="button" class="btn-secondary" data-slot-act="load" ${slot.empty ? 'disabled' : ''}>读取</button>
        <button type="button" class="btn-secondary" data-slot-act="export" ${slot.empty ? 'disabled' : ''}>导出</button>
        <button type="button" class="btn-danger" data-slot-act="delete" ${slot.empty ? 'disabled' : ''}>删除</button>
      </div>
    `;

    item.querySelector('[data-slot-act="save"]').addEventListener('click', async () => {
      const snap = captureFrameworkSnapshot(labState.context);
      const customName = labState.saveNameDraft.trim() || `测试存档 #${slot.slotIndex}`;
      await saves.saveSlot(slot.slotIndex, snap.data, { name: customName, summary: snap.summary });
      await refreshAsyncCaches();
      uiKit.showToast(`已保存到槽位 ${slot.slotIndex}：${customName}`, 'ok');
      renderActiveTab();
    });

    item.querySelector('[data-slot-act="load"]').addEventListener('click', async () => {
      const rec = await saves.loadSlot(slot.slotIndex);
      if (!rec) return;
      restoreFrameworkSnapshot(labState.context, rec.data);
      uiKit.showToast(`已读取槽位 ${slot.slotIndex}（${rec.meta.name}）`, 'ok');
      renderActiveTab();
    });

    item.querySelector('[data-slot-act="export"]').addEventListener('click', async () => {
      const envelope = await saves.exportSlotToJSON(slot.slotIndex);
      triggerJsonDownload(`save-slot-${slot.slotIndex}.json`, envelope);
      uiKit.showToast(`已导出槽位 ${slot.slotIndex} JSON`, 'ok');
    });

    item.querySelector('[data-slot-act="delete"]').addEventListener('click', async () => {
      const confirmed = await uiKit.confirmDialog({
        title: `删除槽位 ${slot.slotIndex}`,
        message: `确认永久删除槽位 ${slot.slotIndex}（${meta?.name || ''}）吗？此操作不可撤销。`,
        confirmLabel: '确认删除',
        tone: 'danger',
      });
      if (!confirmed) return;
      await saves.deleteSlot(slot.slotIndex);
      await refreshAsyncCaches();
      uiKit.showToast(`已删除槽位 ${slot.slotIndex}`, 'ok');
      renderActiveTab();
    });

    slotsList.appendChild(item);
  }

  slotsCard.querySelector('#btn-lab-export-all').addEventListener('click', async () => {
    const bundle = await saves.exportAllToJSON();
    triggerJsonDownload(`game-saves-bundle-${new Date().toISOString().slice(0, 10)}.json`, bundle);
    uiKit.showToast('已导出全库 4 分区存档包 JSON', 'ok');
  });

  const fileInput = slotsCard.querySelector('#input-lab-import-saves');
  slotsCard.querySelector('#btn-lab-import-all').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed.schema === 'pwa-game-save-slot') {
        const res = await saves.importSlotFromJSON(parsed);
        uiKit.showToast(`已导入单槽位存档至槽位 ${res.slotIndex}`, 'ok');
      } else {
        const res = await saves.importAllFromJSON(parsed, { replace: false });
        uiKit.showToast(`已导入全库存档包（${res.importedSlots} 槽位）`, 'ok');
      }
      await refreshAsyncCaches();
      renderActiveTab();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '导入失败', 'error');
    } finally {
      fileInput.value = '';
    }
  });

  slotsCard.querySelector('#btn-lab-save-mod').addEventListener('click', async () => {
    const modId = 'demo-rule-pack';
    await saves.saveModData(
      modId,
      { nodesCount: DEMO_NODES.length, customWeight: 1.5, updatedAt: Date.now() },
      { name: '通用示例扩展包', version: '1.0.0', description: '用于验证自定义模组数据区读写' }
    );
    await refreshAsyncCaches();
    uiKit.showToast('自定义模组数据区写入成功', 'ok');
    renderActiveTab();
  });

  host.appendChild(slotsCard);
}

// ============================================================
// Tab 4: Asset Compressor (WebP -> IndexedDB) & SVG Placeholder
// ============================================================

async function createSyntheticHighResPngBlob() {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 900;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 1200, 900);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(0.5, '#134e4a');
  grad.addColorStop(1, '#1e293b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1200, 900);

  // Add rich visual detail so PNG is significantly larger than WebP
  for (let i = 0; i < 42; i++) {
    ctx.beginPath();
    ctx.arc(
      (i * 173) % 1200,
      (i * 251) % 900,
      30 + (i % 7) * 18,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = i % 2 === 0 ? 'rgba(45, 212, 191, 0.22)' : 'rgba(56, 189, 248, 0.18)';
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(241, 245, 249, 0.35)';
  ctx.lineWidth = 4;
  ctx.strokeRect(48, 48, 1104, 804);
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 46px sans-serif';
  ctx.fillText('SYNTHETIC 1200x900 PNG', 96, 140);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('生成测试图片失败'))),
      'image/png'
    );
  });
}

function renderAssetsTab(host) {
  const { assets, uiKit } = labState.context;

  // Card 1: Compress & Upload
  const uploadCard = document.createElement('section');
  uploadCard.className = 'surface-card lab-stack-sm';
  uploadCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">相册图片 WebP 压缩入库</h2>
      <span class="status-badge badge-ok">已存 ${labState.assetsCache.length} 张</span>
    </div>
    <p class="muted-text">使用离屏 Canvas 自动等比缩放至最大 720px 并压缩为轻量 WebP，直接存入 IndexedDB。</p>
    <div class="lab-btn-grid">
      <button type="button" id="btn-lab-pick-image" class="btn-primary uikit-touch-target">从相册选择图片</button>
      <button type="button" id="btn-lab-synth-image" class="btn-secondary uikit-touch-target">压缩测试高清图</button>
    </div>
  `;

  uploadCard.querySelector('#btn-lab-pick-image').addEventListener('click', async () => {
    const file = await assets.pickImageFromDevice();
    if (!file) return;
    try {
      const meta = await assets.saveImageFromFile(file, { label: file.name, maxWidth: 720, maxHeight: 720, quality: 0.78 });
      await refreshAsyncCaches();
      uiKit.showToast(
        `压缩完成：${formatBytes(meta.originalBytes)} → ${formatBytes(meta.compressedBytes)} (${meta.mimeType})`,
        'ok'
      );
      renderActiveTab();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '图片压缩失败', 'error');
    }
  });

  uploadCard.querySelector('#btn-lab-synth-image').addEventListener('click', async () => {
    try {
      const pngBlob = await createSyntheticHighResPngBlob();
      const meta = await assets.saveImageFromFile(pngBlob, {
        label: `synthetic-${Date.now().toString().slice(-4)}.png`,
        maxWidth: 720,
        maxHeight: 720,
        quality: 0.78,
      });
      await refreshAsyncCaches();
      uiKit.showToast(
        `WebP 压缩成功：${meta.originalWidth}×${meta.originalHeight} → ${meta.width}×${meta.height}（${formatBytes(meta.originalBytes)} → ${formatBytes(meta.compressedBytes)}）`,
        'ok'
      );
      renderActiveTab();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '测试图压缩失败', 'error');
    }
  });

  host.appendChild(uploadCard);

  // Card 2: Geometric SVG Placeholder Generator
  const placeholderUri = assets.generatePlaceholderDataUri(labState.placeholderSeed, {
    width: 240,
    height: 240,
    label: labState.placeholderSeed,
  });

  const placeholderCard = document.createElement('section');
  placeholderCard.className = 'surface-card lab-stack-sm';
  placeholderCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">无图默认 SVG 几何占位图</h2>
      <span class="status-badge badge-muted">确定性哈希</span>
    </div>
    <div style="display:flex; gap:12px; align-items:center;">
      <img id="lab-placeholder-img" src="${placeholderUri}" alt="SVG 占位图" style="width:92px; height:92px; border-radius:12px; flex:0 0 auto; border:1px solid var(--border-subtle);">
      <div class="lab-stack-sm" style="flex:1 1 auto; min-width:0;">
        <input id="lab-placeholder-seed" class="form-input" type="text" value="${escapeHtml(labState.placeholderSeed)}" placeholder="输入种子名称..." aria-label="占位图种子">
        <button type="button" id="btn-lab-random-seed" class="btn-secondary uikit-touch-target">随机切换样式</button>
      </div>
    </div>
  `;

  const seedInput = placeholderCard.querySelector('#lab-placeholder-seed');
  seedInput.addEventListener('input', () => {
    labState.placeholderSeed = seedInput.value || 'asset';
    placeholderCard.querySelector('#lab-placeholder-img').src = assets.generatePlaceholderDataUri(
      labState.placeholderSeed,
      { width: 240, height: 240, label: labState.placeholderSeed }
    );
  });

  placeholderCard.querySelector('#btn-lab-random-seed').addEventListener('click', () => {
    labState.placeholderSeed = `node-${Math.random().toString(36).slice(2, 6)}`;
    renderActiveTab();
  });

  host.appendChild(placeholderCard);

  // Card 3: Stored Assets Gallery
  const galleryCard = document.createElement('section');
  galleryCard.className = 'surface-card lab-stack-sm';
  galleryCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">IndexedDB 本地资产库</h2>
    </div>
    ${
      labState.assetsCache.length === 0
        ? '<p class="muted-text">暂无已压缩图片，点击上方按钮测试压缩入库。</p>'
        : '<div class="lab-asset-grid" id="lab-asset-grid"></div>'
    }
  `;

  if (labState.assetsCache.length > 0) {
    const grid = galleryCard.querySelector('#lab-asset-grid');
    for (const item of labState.assetsCache) {
      const card = document.createElement('div');
      card.className = 'lab-asset-card';
      const url = labState.assetUrls.get(item.id) || placeholderUri;
      const pct = Math.round(item.ratio * 100);
      card.innerHTML = `
        <img class="lab-asset-thumb" src="${url}" alt="${escapeHtml(item.label)}">
        <div class="lab-asset-meta">
          <strong title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</strong>
          <span>${item.width}×${item.height} · ${escapeHtml(item.mimeType.replace('image/', '').toUpperCase())}</span>
          <span>${formatBytes(item.originalBytes)} → ${formatBytes(item.compressedBytes)} (${pct}%)</span>
          <button type="button" class="btn-danger uikit-touch-target" data-del-asset="${escapeHtml(item.id)}" style="margin-top:4px;">删除</button>
        </div>
      `;
      card.querySelector('[data-del-asset]').addEventListener('click', async () => {
        await assets.deleteAsset(item.id);
        await refreshAsyncCaches();
        uiKit.showToast('已删除本地图片资产', 'ok');
        renderActiveTab();
      });
      grid.appendChild(card);
    }
  }

  host.appendChild(galleryCard);
}

// ============================================================
// Tab 5: One-Handed Mobile UI Kit Component Preview
// ============================================================

function renderUiKitTab(host) {
  const { uiKit } = labState.context;

  // Card 1: Modals & Toasts
  const overlayCard = document.createElement('section');
  overlayCard.className = 'surface-card lab-stack-sm';
  overlayCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">单手弹窗与提示组件</h2>
      <span class="status-badge badge-ok">热区 ≥ 44px</span>
    </div>
    <div class="lab-btn-grid">
      <button type="button" id="btn-ui-sheet" class="btn-primary uikit-touch-target">打开 Bottom Sheet</button>
      <button type="button" id="btn-ui-confirm" class="btn-secondary uikit-touch-target">打开二次确认框</button>
      <button type="button" id="btn-ui-toast-ok" class="btn-secondary uikit-touch-target">成功 Toast</button>
      <button type="button" id="btn-ui-toast-warn" class="btn-danger uikit-touch-target">警告/错误 Toast</button>
    </div>
  `;

  overlayCard.querySelector('#btn-ui-sheet').addEventListener('click', () => {
    uiKit.openBottomSheet({
      title: '单手底部抽屉示例',
      subtitle: '自动适配全面屏底部安全区域与键盘 Escape 关闭',
      content: `
        <p class="muted-text">此组件由 <code>src/core/ui-kit.js</code> 提供，可被任意后续业务模块直接调用，支持自定义 DOM/HTML 内容与底部双按钮。</p>
      `,
      actions: [
        { id: 'cancel', label: '关闭', tone: 'secondary' },
        {
          id: 'ok',
          label: '触发反馈',
          tone: 'primary',
          onClick: () => uiKit.showToast('Bottom Sheet 操作按钮已响应', 'ok'),
        },
      ],
    });
  });

  overlayCard.querySelector('#btn-ui-confirm').addEventListener('click', async () => {
    const ok = await uiKit.confirmDialog({
      title: '二次确认框预览',
      message: '这是一个拇指友好的底部确认弹窗，返回 Promise<boolean>。是否确认？',
      confirmLabel: '确认执行',
      cancelLabel: '取消',
      tone: 'primary',
    });
    uiKit.showToast(ok ? '用户点击了「确认执行」' : '用户取消了操作', ok ? 'ok' : 'info');
  });

  overlayCard.querySelector('#btn-ui-toast-ok').addEventListener('click', () => {
    uiKit.showToast('操作成功：顶部轻量提示已触发（轻触可关闭）', 'ok');
  });

  overlayCard.querySelector('#btn-ui-toast-warn').addEventListener('click', () => {
    uiKit.showToast('警告提示：网络异常时系统将自动降级到本地模式', 'warn');
  });

  host.appendChild(overlayCard);

  // Card 2: Progress Bars
  const progCard = document.createElement('section');
  progCard.className = 'surface-card lab-stack-sm';
  progCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">响应式进度条组件</h2>
    </div>
    <div id="lab-uikit-bars" class="lab-stack-sm"></div>
    <div class="lab-btn-grid">
      <button type="button" id="btn-prog-dec" class="btn-secondary uikit-touch-target">进度 -15%</button>
      <button type="button" id="btn-prog-inc" class="btn-primary uikit-touch-target">进度 +15%</button>
    </div>
  `;

  const barsHost = progCard.querySelector('#lab-uikit-bars');
  const mainBar = uiKit.createProgressBar({
    label: '动态示例进度（Accent / Warn / Danger）',
    value: labState.demoProgressVal,
    max: 100,
    tone: labState.demoProgressVal < 30 ? 'danger' : labState.demoProgressVal < 60 ? 'warn' : 'accent',
  });
  const staticWarnBar = uiKit.createProgressBar({
    label: '中等阈值提示条',
    value: 52,
    max: 100,
    tone: 'warn',
  });
  barsHost.appendChild(mainBar.element);
  barsHost.appendChild(staticWarnBar.element);

  progCard.querySelector('#btn-prog-dec').addEventListener('click', () => {
    labState.demoProgressVal = Math.max(0, labState.demoProgressVal - 15);
    mainBar.update({
      value: labState.demoProgressVal,
      tone: labState.demoProgressVal < 30 ? 'danger' : labState.demoProgressVal < 60 ? 'warn' : 'accent',
    });
  });

  progCard.querySelector('#btn-prog-inc').addEventListener('click', () => {
    labState.demoProgressVal = Math.min(100, labState.demoProgressVal + 15);
    mainBar.update({
      value: labState.demoProgressVal,
      tone: labState.demoProgressVal < 30 ? 'danger' : labState.demoProgressVal < 60 ? 'warn' : 'accent',
    });
  });

  host.appendChild(progCard);

  // Card 3: Collapsible Card + Touch Audit
  const collapse1 = uiKit.createCollapsibleCard({
    title: '可折叠卡片（Collapsible Card）',
    subtitle: '点击整行头部展开/收起，支持副标题与状态徽章',
    badge: '默认展开',
    open: true,
    content: (body) => {
      const p = document.createElement('p');
      p.className = 'muted-text';
      p.textContent = '用于承载游戏内属性明细、规则日志、长表单或扩展说明，减少手机竖屏信息拥挤。';
      const auditBtn = document.createElement('button');
      auditBtn.type = 'button';
      auditBtn.id = 'btn-ui-audit';
      auditBtn.className = 'btn-secondary uikit-touch-target';
      auditBtn.style.marginTop = '10px';
      auditBtn.style.width = '100%';
      auditBtn.textContent = '执行当前页面触控热区 & 横向溢出自检';
      const auditOut = document.createElement('div');
      auditOut.id = 'lab-ui-audit-out';
      auditOut.className = 'test-result-box';
      auditOut.style.marginTop = '8px';
      auditOut.hidden = true;

      auditBtn.addEventListener('click', () => {
        const visibleBtns = Array.from(document.querySelectorAll('button')).filter(
          (b) => b.offsetParent !== null
        );
        let minHeight = Infinity;
        let under44 = 0;
        for (const b of visibleBtns) {
          const rect = b.getBoundingClientRect();
          if (rect.height > 0 && rect.height < minHeight) minHeight = rect.height;
          if (rect.height < 43.5) under44 += 1;
        }
        const overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth;
        auditOut.hidden = false;
        auditOut.className = `test-result-box ${!overflowX && under44 === 0 ? 'is-ok' : 'is-error'}`;
        auditOut.textContent = `可见按钮 ${visibleBtns.length} 个 · 最小高度 ${
          Number.isFinite(minHeight) ? minHeight.toFixed(1) : 0
        }px · <44px 数量 ${under44} · 横向溢出：${overflowX ? '有' : '无'}`;
      });

      body.appendChild(p);
      body.appendChild(auditBtn);
      body.appendChild(auditOut);
    },
  });
  host.appendChild(collapse1.element);
}

// ============================================================
// Root Render & Module Lifecycle
// ============================================================

function renderActiveTab() {
  if (!labState.container) return;
  const tabContent = labState.container.querySelector('#lab-tab-content');
  if (!tabContent) return;
  tabContent.innerHTML = '';

  if (labState.activeTab === 'rules') {
    renderRulesTab(tabContent);
  } else if (labState.activeTab === 'calc') {
    renderCalcTab(tabContent);
  } else if (labState.activeTab === 'saves') {
    renderSavesTab(tabContent);
  } else if (labState.activeTab === 'assets') {
    renderAssetsTab(tabContent);
  } else if (labState.activeTab === 'uikit') {
    renderUiKitTab(tabContent);
  }
}

function mountShellLayout() {
  const { uiKit } = labState.context;
  labState.container.innerHTML = `
    <div class="lab-root">
      <div id="lab-tabs-mount"></div>
      <div id="lab-tab-content" class="module-stack"></div>
    </div>
  `;

  labState.tabsCtrl = uiKit.createTabs({
    items: [
      { id: 'rules', label: '规则/双轨' },
      { id: 'calc', label: '计算/离线' },
      { id: 'saves', label: '多槽存档' },
      { id: 'assets', label: '资产压缩' },
      { id: 'uikit', label: 'UI 组件' },
    ],
    activeId: labState.activeTab,
    onChange: async (nextTab) => {
      labState.activeTab = nextTab;
      if (nextTab === 'saves' || nextTab === 'assets') {
        await refreshAsyncCaches();
      }
      renderActiveTab();
    },
  });

  labState.container.querySelector('#lab-tabs-mount').appendChild(labState.tabsCtrl.element);
  renderActiveTab();
}

async function handleUniversalInput(text) {
  const { narrative, uiKit } = labState.context;
  const rendered = await narrative.run({
    userInput: text,
    template: '【第 {turn} 回合 · {phaseLabel}】本地模板已接收指令「{userInput}」（当前主体能量 {actor.energy}，积分 {actor.score}）。',
    variables: buildTemplateVars(labState.context),
  });
  labState.lastNarrative = {
    ...rendered,
    choiceLabel: '底部通用输入',
    timestamp: Date.now(),
  };
  labState.activeTab = 'rules';
  if (labState.tabsCtrl) labState.tabsCtrl.setActive('rules', { silent: true });
  uiKit.showToast(
    rendered.degraded ? '无可用 API，已自动降级本地模板响应' : `双轨路由响应完成（${rendered.source}）`,
    rendered.degraded ? 'warn' : 'ok'
  );
  renderActiveTab();
}

export default {
  id: 'framework-lab',
  name: '框架自检沙盒',
  description: '通用游戏大框架底层能力可视化测试台：本地规则引擎、双轨降级、公式/离线结算、多槽存档、图片 WebP 压缩与单手 UI 组件。',

  mount(container, context) {
    labState.container = container;
    labState.context = context;
    ensureDemoFixtures(context);

    context.ui.setPlaceholder('输入任意文本，测试双轨叙事路由与无 Key 自动降级...');
    context.ui.setInputHandler(handleUniversalInput);
    context.ui.setQuickActions([
      {
        id: 'lab-quick-step',
        label: '步进回合',
        onClick: () => {
          const res = context.turnStepper.advance({ steps: 1, reason: 'quick-action' });
          context.entities.tickModifiers({ turns: 1 });
          context.uiKit.showToast(`第 ${res.current.turn} 回合 · ${res.current.cycleLabel}`, 'ok');
          renderActiveTab();
        },
      },
      {
        id: 'lab-quick-draw',
        label: '抽规则节点',
        onClick: () => {
          const drawn = context.rules.drawFromPool('lab_pool', buildRuntimeCtx(context));
          labState.activeTab = 'rules';
          if (labState.tabsCtrl) labState.tabsCtrl.setActive('rules', { silent: true });
          context.uiKit.showToast(drawn.node ? `已抽取：${drawn.node.title}` : '无可用节点', 'ok');
          renderActiveTab();
        },
      },
      {
        id: 'lab-quick-autosave',
        label: '触发自动存档',
        onClick: async () => {
          const snap = captureFrameworkSnapshot(context);
          await context.saves.autoSave(snap.data, { reason: 'quick-bar', summary: snap.summary });
          await refreshAsyncCaches();
          context.uiKit.showToast('自动存档快照已更新', 'ok');
          renderActiveTab();
        },
      },
    ]);

    // Bind EventBus automatic snapshot saving
    labState.autoSaveUnbind = context.saves.bindAutoSaveEvents(
      ['state:changed', 'turn:advanced', 'rule:choice-executed'],
      () => captureFrameworkSnapshot(context),
      {
        debounceMs: 120,
        enabled: () => labState.autoSaveEnabled,
      }
    );

    labState.unsubs = [
      context.bus.on('api:config-changed', () => renderActiveTab()),
      context.bus.on('save:auto-saved', async () => {
        if (labState.activeTab === 'saves') {
          await refreshAsyncCaches();
          renderActiveTab();
        }
      }),
      context.bus.on('storage:changed', async (detail) => {
        if (detail?.action === 'resetAll' || detail?.action === 'import') {
          await refreshAsyncCaches();
          renderActiveTab();
        }
      }),
    ];

    mountShellLayout();
    refreshAsyncCaches().then(() => {
      if (labState.activeTab === 'saves' || labState.activeTab === 'assets') {
        renderActiveTab();
      }
    });
  },

  unmount() {
    if (labState.autoSaveUnbind) {
      labState.autoSaveUnbind();
      labState.autoSaveUnbind = null;
    }
    for (const unsub of labState.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    labState.unsubs = [];
    labState.container = null;
    labState.context = null;
    labState.tabsCtrl = null;
  },
};
