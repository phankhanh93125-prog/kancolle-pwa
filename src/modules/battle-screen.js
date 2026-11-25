/**
 * Three-Tier 3x4 Tactical Radar Sandbox Battle Stage (`battle-screen.js`).
 *
 * Mounted in-place inside the unified Central Main Stage (`#app-stage`) whenever combat is active:
 *   - Tier 1 (Upper)  : Enemy 3x4 vs Ally 3x4 Tactical Radar Grid separated by Engagement Range Ruler
 *                       (high-contrast ship-class geometric symbols + 01~12 badges, blank radar dots for empty cells,
 *                       pulsing ring on acting ship, and exact cell-to-cell SVG trajectory overlay).
 *   - Tier 2 (Middle) : Tactical Command Bar immediately beneath the radar sandbox with acting shipgirl identity,
 *                       class-exclusive command buttons, Round Auto-Delegate toggle, and 1x/2x animation speed toggle.
 *   - Tier 3 (Lower)  : Allied Fleet Detailed Status List (01~12 linked to grid; tap ally to highlight her symbol)
 *                       OR Click-to-Inspect Enemy Intel Panel (tapping any enemy symbol locks target & opens detailed
 *                       intel with HP/armor, next-turn intent warning, scanned weakness, and quick return button).
 */

import { RANGE_META } from '../core/tactical-combat.js';
import {
  GRID_COLS,
  GRID_ROWS,
  GRID_ROW_LABELS,
  computeRangeRowCombatModifiers,
  getShipClassProfile,
  getShipClassSvg,
  getTacticalGridSymbolSvg,
  resolveShipClass,
} from '../core/stat-rules.js';
import { buildPointToPointTrajectorySvg } from '../core/fx-stage.js';

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function measureCellCenterInSandbox(sandboxEl, selector, fallback = { x: 180, y: 120 }) {
  if (!sandboxEl) return fallback;
  const sRect = sandboxEl.getBoundingClientRect();
  if (!sRect || sRect.width <= 0 || sRect.height <= 0) return fallback;
  const cell = selector ? sandboxEl.querySelector(selector) : null;
  if (!cell) return fallback;
  const cRect = cell.getBoundingClientRect();
  const relX = cRect.left + cRect.width / 2 - sRect.left;
  const relY = cRect.top + cRect.height / 2 - sRect.top;
  return {
    x: Number(((relX / sRect.width) * 360).toFixed(1)),
    y: Number(((relY / sRect.height) * 280).toFixed(1)),
  };
}

export function buildBattleSvgMarkup(visualStyle, coords = null) {
  if (coords && Number.isFinite(coords.x1) && Number.isFinite(coords.y1)) {
    return buildPointToPointTrajectorySvg(visualStyle, coords);
  }
  const isEnemy =
    visualStyle === 'enemy_airstrike' ||
    visualStyle === 'enemy_torpedo' ||
    visualStyle === 'enemy_salvo' ||
    visualStyle === 'ambush' ||
    visualStyle === 'counter';
  return buildPointToPointTrajectorySvg(
    visualStyle,
    isEnemy ? { x1: 230, y1: 58, x2: 130, y2: 222 } : { x1: 130, y1: 222, x2: 230, y2: 58 }
  );
}

/**
 * Play Opening Phase SVG Choreography (Recon / Ambush / Opening Airstrike / Opening Torpedo) before Round 1!
 */
export async function playOpeningChoreography(rootEl, { openingEvents = [], fxStage }) {
  if (!rootEl || !Array.isArray(openingEvents) || openingEvents.length === 0) return;
  const wait = (ms) =>
    fxStage && typeof fxStage.wait === 'function' ? fxStage.wait(ms) : new Promise((r) => setTimeout(r, ms));
  const svg = rootEl.querySelector('#bf-svg-canvas');
  const banner = rootEl.querySelector('#bf-banner');
  const callout = rootEl.querySelector('#bf-callout');

  for (const ev of openingEvents) {
    if (banner) {
      banner.textContent = ev.title || '开幕交锋';
      banner.className = `bf-banner is-${ev.kind === 'ambush' ? 'counter' : ev.visualStyle || 'scan'}`;
    }
    if (svg) {
      svg.innerHTML = buildBattleSvgMarkup(ev.visualStyle || 'scan');
    }
    if (callout) {
      if (ev.kind === 'ambush') {
        callout.textContent = `⚠ 先制伏击 -${ev.damageTaken || 0} HP`;
        callout.className = 'bf-callout is-visible is-counter';
      } else if (ev.damageDealt > 0 && ev.damageTaken > 0) {
        callout.textContent = `敌 -${ev.damageDealt} / 我 -${ev.damageTaken}`;
        callout.className = 'bf-callout is-visible is-dmg';
      } else if (ev.damageDealt > 0) {
        callout.textContent = `开幕重创 -${ev.damageDealt} HP`;
        callout.className = 'bf-callout is-visible is-crit';
      } else if (ev.damageTaken > 0) {
        callout.textContent = `开幕受击 -${ev.damageTaken} HP`;
        callout.className = 'bf-callout is-visible is-counter';
      } else {
        callout.textContent = ev.title || '索敌就绪';
        callout.className = 'bf-callout is-visible is-scan';
      }
    }
    await wait(440);
  }
  if (svg) svg.innerHTML = '';
}

/**
 * Play cell-to-cell vector trajectory + hit choreography directly across the 3x4 vs 3x4 radar sandbox!
 */
export async function playBattleStepChoreography(rootEl, { turnEntry, fxStage }) {
  if (!rootEl || !turnEntry) return;
  const wait = (ms) =>
    fxStage && typeof fxStage.wait === 'function' ? fxStage.wait(ms) : new Promise((r) => setTimeout(r, ms));

  const sandbox = rootEl.querySelector('#bf-radar-sandbox');
  const svg = rootEl.querySelector('#bf-svg-canvas');
  const banner = rootEl.querySelector('#bf-banner');
  const callout = rootEl.querySelector('#bf-callout');

  const isEnemySide = turnEntry.side === 'enemy';
  const attackerSelector = isEnemySide
    ? `[data-enemy-unit-id="${CSS.escape(turnEntry.actorId || '')}"]`
    : `[data-ally-unit-id="${CSS.escape(turnEntry.actorId || '')}"]`;
  const targetSelector = isEnemySide
    ? `[data-ally-unit-id="${CSS.escape(turnEntry.targetAllyId || '')}"]`
    : `[data-enemy-unit-id="${CSS.escape(turnEntry.targetEnemyId || '')}"]`;

  const fromPt = measureCellCenterInSandbox(
    sandbox,
    attackerSelector,
    isEnemySide ? { x: 180, y: 58 } : { x: 180, y: 222 }
  );
  const toPt = measureCellCenterInSandbox(
    sandbox,
    targetSelector,
    isEnemySide ? { x: 180, y: 222 } : { x: 180, y: 58 }
  );

  const attackerEl = sandbox?.querySelector(attackerSelector);
  const targetEl = sandbox?.querySelector(targetSelector);
  if (attackerEl) attackerEl.classList.add('is-acting-pulse');

  if (banner) {
    banner.textContent = isEnemySide
      ? `敌方行动：[${turnEntry.actorClass}] ${turnEntry.actorName} → 【${turnEntry.commandLabel}】`
      : `[${turnEntry.actorClass}] ${turnEntry.actorName} → 【${turnEntry.commandLabel}】`;
    banner.className = `bf-banner is-${isEnemySide ? 'counter' : turnEntry.visualStyle || 'shelling'}`;
  }

  if (svg) {
    svg.innerHTML = buildBattleSvgMarkup(
      turnEntry.visualStyle || (isEnemySide ? 'counter' : 'shelling'),
      { x1: fromPt.x, y1: fromPt.y, x2: toPt.x, y2: toPt.y }
    );
  }

  await wait(300);

  if (isEnemySide) {
    if (turnEntry.damageTaken > 0 && targetEl) targetEl.classList.add('is-hit');
    if (callout) {
      if (turnEntry.damageTaken > 0) {
        callout.textContent = `${turnEntry.targetAllyName || '我方'} -${turnEntry.damageTaken} HP`;
        callout.className = 'bf-callout is-visible is-counter';
      } else {
        callout.textContent = `敌方【${turnEntry.commandLabel}】生效`;
        callout.className = 'bf-callout is-visible is-scan';
      }
    }
    await wait(320);
    if (attackerEl) attackerEl.classList.remove('is-acting-pulse');
    if (targetEl) targetEl.classList.remove('is-hit');
    if (svg) svg.innerHTML = '';
    return;
  }

  if (turnEntry.damageDealt > 0 && targetEl) targetEl.classList.add('is-hit');
  if (callout) {
    if (turnEntry.damageDealt > 0) {
      callout.textContent = `${turnEntry.isCrit ? '★ CRIT ' : ''}-${turnEntry.damageDealt} HP`;
      callout.className = `bf-callout is-visible ${turnEntry.isCrit ? 'is-crit' : 'is-dmg'}`;
    } else if (turnEntry.rangeChangedTo) {
      callout.textContent = `距离拉近 → ${turnEntry.rangeChangedTo}`;
      callout.className = 'bf-callout is-visible is-scan';
    } else if (turnEntry.scannedNow) {
      callout.textContent = '敌舰情报与弱点已揭露！';
      callout.className = 'bf-callout is-visible is-scan';
    } else {
      callout.textContent = `【${turnEntry.commandLabel}】生效`;
      callout.className = 'bf-callout is-visible is-scan';
    }
  }
  await wait(340);

  if (attackerEl) attackerEl.classList.remove('is-acting-pulse');
  if (targetEl) targetEl.classList.remove('is-hit');
  if (svg) svg.innerHTML = '';
}

/**
 * Render the Three-Tier 3x4 Naval Tactical Sandbox Battle Interface.
 */
export function renderFullScreenBattleView({
  host,
  session,
  fleetSummary,
  currentActor,
  currentTurnSlot = null,
  availableActions,
  busy = false,
  autoRunning = false,
  inspectedEnemyId = null,
  highlightedAllyId = null,
  fxStage,
  uiKit,
  onSelectTarget,
  onInspectEnemy = null,
  onClearInspectEnemy = null,
  onHighlightAlly = null,
  onExecuteAction,
  onToggleAuto,
  onToggleSpeed,
  onEnterNight,
  onFinishEarly,
  onPostBattleContinue,
  onPostBattleDockyard,
  onPostBattleResupply,
  onPostBattleAutoDock = null,
  settlementInfo = null,
}) {
  host.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'battle-fullscreen-root is-three-tier-stage';
  root.id = 'battle-fullscreen-stage';

  const curSpeed = fxStage && typeof fxStage.getBattleSpeed === 'function' ? fxStage.getBattleSpeed() : 1;
  const isNight = session.phase === 'night';
  const latestLog = session.turnsLog?.[0] || null;
  const enemies = session.enemies || [];
  const allies = fleetSummary?.members || [];
  const aliveEnemyCount = enemies.filter((e) => e.hp > 0).length;
  const strMult = Number(session.strengthMultiplier || 1.0);

  // Build 3x4 lookup maps for Enemy & Ally
  const enemyByCell = new Map();
  enemies.forEach((en, idx) => {
    const cellIdx = Number.isInteger(en.gridIndex) ? en.gridIndex : idx % 12;
    enemyByCell.set(cellIdx, en);
  });

  const allyByCell = new Map();
  allies.forEach((m, idx) => {
    const snap = session.allyPositions?.[m.id];
    const cellIdx = Number.isInteger(snap?.index)
      ? snap.index
      : Number.isInteger(m.gridIndex)
      ? m.gridIndex
      : idx % 12;
    const row = Math.floor(cellIdx / GRID_COLS);
    const col = cellIdx % GRID_COLS;
    const slotCode = snap?.slotCode || m.slotCode || String(idx + 1).padStart(2, '0');
    allyByCell.set(cellIdx, { ...m, gridIndex: cellIdx, gridRow: row, gridCol: col, slotCode });
  });

  const inspectedEnemy = inspectedEnemyId ? enemies.find((e) => e.id === inspectedEnemyId) || null : null;
  const lockedEnemy =
    enemies.find((e) => e.id === session.targetEnemyId && e.hp > 0) ||
    enemies.find((e) => e.hp > 0) ||
    enemies[0] ||
    null;

  // Compact Battle Header Strip (Phase + Node + Active Buffs)
  const activeBuffs = [];
  if (session.reconStatus === 'ambushed') activeBuffs.push({ text: '⚠ 伏击', tone: 'danger' });
  else if (session.reconStatus === 'success') activeBuffs.push({ text: '索敌✓', tone: 'ok' });
  if (session.smokeTurns > 0) activeBuffs.push({ text: `烟幕${session.smokeTurns}T`, tone: 'ok' });
  if (session.aaAlertTurns > 0) activeBuffs.push({ text: `防空${session.aaAlertTurns}T`, tone: 'ok' });
  if (session.guardTurns > 0) activeBuffs.push({ text: `援护${session.guardTurns}T`, tone: 'ok' });
  if (session.reconCritTurns > 0) activeBuffs.push({ text: `暴击+${session.reconCritTurns}T`, tone: 'ok' });
  if (session.lockOnBonus > 0) activeBuffs.push({ text: `锁定+${session.lockOnBonus}`, tone: 'ok' });

  const topbar = document.createElement('div');
  topbar.className = 'bf-compact-topbar';
  topbar.innerHTML = `
    <div class="bf-phase-group">
      <span class="status-badge ${isNight ? 'badge-warn' : 'badge-danger'}" id="bf-phase-badge">
        ${isNight ? `★ 夜战 R${session.round}` : `昼战 R${session.round}/${session.dayMaxRounds}`}
      </span>
      <span class="bf-node-tag">${escapeHtml(session.nodeCode)}·${escapeHtml(session.nodeName)} · 敌${aliveEnemyCount}/${enemies.length}${strMult !== 1 ? ` · ${strMult.toFixed(1)}x` : ''}</span>
    </div>
    <div class="bf-mini-buffs">
      ${activeBuffs.map((b) => `<span class="status-badge badge-${b.tone}">${escapeHtml(b.text)}</span>`).join('')}
    </div>
  `;
  root.appendChild(topbar);

  // ============================================================
  // TIER 1 (UPPER): Enemy 3x4 vs Ally 3x4 Tactical Radar Sandbox
  // ============================================================
  const sandbox = document.createElement('section');
  sandbox.className = 'bf-radar-sandbox';
  sandbox.id = 'bf-radar-sandbox';
  sandbox.dataset.noSwipe = 'true';

  // Build Enemy 3x4 visual rows: Top = Row 2 (敌后), Mid = Row 1 (敌中), Bottom facing sea = Row 0 (敌前)
  const enemyRowsHtml = [2, 1, 0]
    .map((r) => {
      const cells = [];
      for (let c = 0; c < GRID_COLS; c++) {
        const idx = r * GRID_COLS + c;
        const en = enemyByCell.get(idx);
        if (!en) {
          cells.push(`<div class="radar-cell is-empty" data-radar-cell="enemy-${idx}"><span class="tac-radar-dot"></span></div>`);
          continue;
        }
        const alive = en.hp > 0;
        const isTargeted = alive && en.id === session.targetEnemyId;
        const isInspected = inspectedEnemy && inspectedEnemy.id === en.id;
        const isActing =
          session.status === 'active' &&
          currentTurnSlot &&
          currentTurnSlot.side === 'enemy' &&
          currentTurnSlot.unitId === en.id;
        const hpPct = Math.round((Math.max(0, en.hp) / Math.max(1, en.maxHp)) * 100);
        const code = en.slotCode || String((en.slotNo || 1)).padStart(2, '0');
        cells.push(`
          <button
            type="button"
            class="radar-cell is-occupied is-enemy ${isTargeted ? 'is-targeted' : ''} ${isInspected ? 'is-inspected' : ''} ${isActing ? 'is-acting-pulse' : ''} ${!alive ? 'is-sunk' : ''}"
            data-radar-cell="enemy-${idx}"
            data-enemy-unit-id="${escapeHtml(en.id)}"
            title="[E${escapeHtml(code)}] ${escapeHtml(en.name)}（点击查看情报并锁定）"
          >
            <span class="radar-cell-no is-enemy">E${escapeHtml(code)}</span>
            ${getTacticalGridSymbolSvg(en.shipClass || en.role, { side: 'enemy', size: 24 })}
            <span class="radar-cell-hp"><span class="radar-cell-hp-fill is-enemy" style="width:${hpPct}%"></span></span>
            ${en.guardTurns > 0 && alive ? '<span class="radar-cell-flag">护</span>' : ''}
          </button>
        `);
      }
      return `
        <div class="radar-grid-row is-enemy-row" data-enemy-row="${r}">
          <span class="radar-row-tag is-enemy">敌${GRID_ROW_LABELS[r][0]}</span>
          <div class="radar-row-cells">${cells.join('')}</div>
        </div>
      `;
    })
    .join('');

  // Build Ally 3x4 visual rows: Top facing sea = Row 0 (我前), Mid = Row 1 (我中), Bottom = Row 2 (我后)
  const allyRowsHtml = [0, 1, 2]
    .map((r) => {
      const cells = [];
      for (let c = 0; c < GRID_COLS; c++) {
        const idx = r * GRID_COLS + c;
        const m = allyByCell.get(idx);
        if (!m) {
          cells.push(`<div class="radar-cell is-empty" data-radar-cell="ally-${idx}"><span class="tac-radar-dot"></span></div>`);
          continue;
        }
        const isActing =
          session.status === 'active' &&
          currentActor &&
          currentActor.id === m.id &&
          (!currentTurnSlot || currentTurnSlot.side === 'ally');
        const isHighlighted = highlightedAllyId && highlightedAllyId === m.id;
        const hpPct = Math.round((Math.max(0, m.hp) / Math.max(1, m.maxHp)) * 100);
        cells.push(`
          <button
            type="button"
            class="radar-cell is-occupied is-ally ${isActing ? 'is-acting-pulse' : ''} ${isHighlighted ? 'is-highlighted' : ''} ${!m.alive ? 'is-sunk' : ''} ${hpPct > 0 && hpPct < 25 ? 'is-heavy-dmg' : ''}"
            data-radar-cell="ally-${idx}"
            data-ally-unit-id="${escapeHtml(m.id)}"
            title="[${escapeHtml(m.slotCode)}] ${escapeHtml(m.name)}（${escapeHtml(GRID_ROW_LABELS[r])}）"
          >
            <span class="radar-cell-no is-ally">${escapeHtml(m.slotCode)}</span>
            ${getTacticalGridSymbolSvg(m.classCode || m.shipType, { side: 'ally', size: 24 })}
            <span class="radar-cell-hp"><span class="radar-cell-hp-fill ${hpPct < 25 ? 'is-danger' : 'is-ally'}" style="width:${hpPct}%"></span></span>
            ${session.guardActorId === m.id && session.guardTurns > 0 ? '<span class="radar-cell-flag is-ally">护</span>' : ''}
          </button>
        `);
      }
      return `
        <div class="radar-grid-row is-ally-row" data-ally-row="${r}">
          <span class="radar-row-tag is-ally">我${GRID_ROW_LABELS[r][0]}</span>
          <div class="radar-row-cells">${cells.join('')}</div>
        </div>
      `;
    })
    .join('');

  sandbox.innerHTML = `
    <div class="radar-side-grid is-enemy-grid" id="bf-enemy-grid">${enemyRowsHtml}</div>

    <div class="radar-sea-divider" id="bf-range-indicator" data-range="${escapeHtml(session.range)}">
      <div class="radar-range-ruler">
        ${['long', 'medium', 'close']
          .map(
            (rId) =>
              `<span class="radar-range-pill ${session.range === rId ? 'is-active' : ''}">${escapeHtml(RANGE_META[rId].label)}</span>`
          )
          .join('')}
      </div>
      <div class="bf-banner" id="bf-banner" aria-live="polite">
        ${
          latestLog
            ? `${latestLog.side === 'enemy' ? '敌方 · ' : ''}[${escapeHtml(latestLog.actorClass)}] ${escapeHtml(latestLog.actorName)} · ${escapeHtml(latestLog.commandLabel)}`
            : currentTurnSlot && currentTurnSlot.side === 'enemy'
            ? `敌方高速舰 [${escapeHtml(currentTurnSlot.classCode)}] ${escapeHtml(currentTurnSlot.name)} 行动中…`
            : currentActor
            ? `轮到 [${escapeHtml(currentActor.slotCode || '01')}] ${escapeHtml(currentActor.name)} 下令`
            : '战局结算中'
        }
      </div>
      <div class="bf-callout" id="bf-callout" aria-live="polite"></div>
    </div>

    <div class="radar-side-grid is-ally-grid" id="bf-ally-grid">${allyRowsHtml}</div>

    <svg id="bf-svg-canvas" class="radar-svg-overlay" viewBox="0 0 360 280" preserveAspectRatio="none" aria-hidden="true"></svg>
  `;

  // Clicking ANY enemy symbol locks target (if alive) AND switches Tier 3 to Enemy Intel Panel!
  sandbox.querySelectorAll('[data-enemy-unit-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const eid = btn.getAttribute('data-enemy-unit-id');
      if (!eid) return;
      const targetObj = enemies.find((e) => e.id === eid);
      if (targetObj && targetObj.hp > 0 && typeof onSelectTarget === 'function') {
        onSelectTarget(eid, { openIntel: true });
      } else if (typeof onInspectEnemy === 'function') {
        onInspectEnemy(eid);
      }
    });
  });

  // Clicking an ally symbol highlights her & returns Tier 3 to allied roster
  sandbox.querySelectorAll('[data-ally-unit-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const aid = btn.getAttribute('data-ally-unit-id');
      if (typeof onHighlightAlly === 'function') onHighlightAlly(aid);
    });
  });

  root.appendChild(sandbox);

  // ============================================================
  // TIER 2 (MIDDLE): Tactical Command Bar + Auto-Delegate + 1x/2x Speed
  // ============================================================
  if (session.status === 'night_prompt') {
    const nightCard = document.createElement('section');
    nightCard.className = 'bf-prompt-card';
    nightCard.id = 'bf-night-prompt';
    nightCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h3 class="section-title" style="color:#fef08a;">昼战结束 · 尚余 ${aliveEnemyCount} 艘敌舰</h3>
        <span class="status-badge badge-warn">昼夜战抉择</span>
      </div>
      <p class="muted-text" style="color:#cbd5e1; font-size:12px; margin:0;">
        追击进入夜战将自动贴近至「近距离」，鱼雷突击伤害 +45%、暴击率 +25%。
      </p>
      <div class="lab-btn-grid">
        <button type="button" id="btn-battle-enter-night" class="btn-primary uikit-touch-target">★ 追击进入夜战</button>
        <button type="button" id="btn-battle-end-day" class="btn-secondary uikit-touch-target">结束战斗（保留战果）</button>
      </div>
    `;
    nightCard.querySelector('#btn-battle-enter-night').addEventListener('click', () => onEnterNight());
    nightCard.querySelector('#btn-battle-end-day').addEventListener('click', () => onFinishEarly());
    root.appendChild(nightCard);
  } else if (settlementInfo) {
    const settleCard = document.createElement('section');
    settleCard.className = 'bf-prompt-card is-settlement';
    settleCard.id = 'bf-settlement-card';
    settleCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h3 class="section-title" style="color:#f8fafc;">${escapeHtml(settlementInfo.headline)}</h3>
        <span class="status-badge ${settlementInfo.tone === 'ok' ? 'badge-ok' : settlementInfo.tone === 'danger' ? 'badge-danger' : 'badge-warn'}">
          ${escapeHtml(settlementInfo.badge)}
        </span>
      </div>
      <p style="font-size:12px; color:#cbd5e1; margin:0;">${escapeHtml(settlementInfo.summary)}</p>
      <div class="lab-stack-sm">
        <button type="button" id="btn-postbattle-continue" class="btn-primary uikit-touch-target">
          ${escapeHtml(settlementInfo.continueLabel || '返回分岔雷达海图')}
        </button>
        <div class="lab-btn-grid">
          <button type="button" id="btn-postbattle-resupply" class="btn-secondary uikit-touch-target">全队一键补给油弹</button>
          <button type="button" id="btn-postbattle-autodock" class="btn-secondary uikit-touch-target">受损舰娘一键入渠</button>
        </div>
        <button type="button" id="btn-postbattle-dockyard" class="btn-secondary uikit-touch-target">直达船坞整备</button>
      </div>
    `;
    settleCard.querySelector('#btn-postbattle-continue').addEventListener('click', () => onPostBattleContinue());
    settleCard.querySelector('#btn-postbattle-resupply').addEventListener('click', () => onPostBattleResupply());
    settleCard.querySelector('#btn-postbattle-autodock').addEventListener('click', () => {
      if (typeof onPostBattleAutoDock === 'function') onPostBattleAutoDock();
      else onPostBattleDockyard();
    });
    settleCard.querySelector('#btn-postbattle-dockyard').addEventListener('click', () => onPostBattleDockyard());
    root.appendChild(settleCard);
  } else if (currentActor) {
    const actorProf = getShipClassProfile(currentActor.shipType);
    const actorCode = currentActor.slotCode || '01';
    const actorRowLabel = GRID_ROW_LABELS[currentActor.gridRow ?? 0] || '前排';
    const previewMod = lockedEnemy
      ? computeRangeRowCombatModifiers({
          engagementRange: session.range,
          attackerRow: currentActor.gridRow ?? 0,
          defenderRow: lockedEnemy.gridRow ?? 0,
          actionId: availableActions?.[0]?.id || 'tactical_shelling',
          shipClass: actorProf.code,
        })
      : null;

    const deck = document.createElement('section');
    deck.className = 'bf-command-deck';
    deck.id = 'bf-command-deck';
    deck.dataset.activeActorId = currentActor.id;
    deck.dataset.activeActorClass = actorProf.code;

    deck.innerHTML = `
      <div class="bf-cmd-header-row">
        <div class="bf-actor-id">
          <span class="status-badge badge-ok">${escapeHtml(actorCode)}</span>
          <span class="ship-class-ico">${getShipClassSvg(currentActor.shipType, { size: 18 })}</span>
          <strong>${escapeHtml(currentActor.name)}</strong>
          <span class="bf-actor-row-pill">${escapeHtml(actorProf.code)}·${escapeHtml(actorRowLabel)}</span>
        </div>
        <div class="bf-topbar-controls">
          <button type="button" id="btn-battle-auto-toggle" class="${autoRunning || session.autoDelegateRound ? 'btn-primary' : 'btn-secondary'} bf-ctrl-btn" ${session.status !== 'active' ? 'disabled' : ''}>
            ${autoRunning || session.autoDelegateRound ? '托管中' : '本回合托管'}
          </button>
          <button type="button" id="btn-battle-speed-toggle" class="btn-secondary bf-ctrl-btn">
            ${curSpeed}x
          </button>
        </div>
      </div>

      ${
        lockedEnemy && previewMod
          ? `<div class="bf-target-preview-bar">
              <span>锁定目标：<strong>E${escapeHtml(lockedEnemy.slotCode || '01')} ${escapeHtml(lockedEnemy.name)}</strong>（敌${escapeHtml(GRID_ROW_LABELS[lockedEnemy.gridRow ?? 0]?.[0] || '前')}）</span>
              <span class="status-badge badge-${previewMod.tone === 'danger' ? 'danger' : previewMod.tone === 'warn' ? 'warn' : 'ok'}">
                ${escapeHtml(previewMod.label)} x${previewMod.dmgMult.toFixed(2)}
              </span>
            </div>`
          : ''
      }

      <div class="tactical-cmd-grid" id="bf-exclusive-cmds">
        ${availableActions
          .map(
            (act) => `
          <button type="button" class="tactical-cmd-btn is-tone-${escapeHtml(act.tone || 'shelling')}" data-battle-action="${escapeHtml(act.id)}" ${busy || autoRunning ? 'disabled' : ''}>
            <span class="tactical-cmd-title">${escapeHtml(act.label)}</span>
            <span class="tactical-cmd-sub">${escapeHtml(act.desc)}</span>
          </button>
        `
          )
          .join('')}
      </div>
    `;

    deck.querySelector('#btn-battle-auto-toggle').addEventListener('click', () => onToggleAuto());
    deck.querySelector('#btn-battle-speed-toggle').addEventListener('click', () => onToggleSpeed());
    deck.querySelectorAll('[data-battle-action]').forEach((btn) => {
      btn.addEventListener('click', () => onExecuteAction(btn.getAttribute('data-battle-action')));
    });
    root.appendChild(deck);
  } else if (currentTurnSlot && currentTurnSlot.side === 'enemy') {
    const enemyWait = document.createElement('section');
    enemyWait.className = 'bf-command-deck';
    enemyWait.id = 'bf-enemy-acting-banner';
    enemyWait.innerHTML = `
      <div class="bf-cmd-header-row">
        <div class="bf-actor-id">
          <span class="status-badge badge-danger">敌方先手</span>
          <strong>[${escapeHtml(currentTurnSlot.classCode)}] ${escapeHtml(currentTurnSlot.name)}</strong>
        </div>
        <div class="bf-topbar-controls">
          <button type="button" id="btn-battle-auto-toggle" class="${autoRunning || session.autoDelegateRound ? 'btn-primary' : 'btn-secondary'} bf-ctrl-btn" disabled>托管</button>
          <button type="button" id="btn-battle-speed-toggle" class="btn-secondary bf-ctrl-btn">${curSpeed}x</button>
        </div>
      </div>
      <p class="muted-text" style="color:#fca5a5; font-size:12px; margin:2px 0 0;">
        敌方高速舰艇正在执行战术动作，请稍候…
      </p>
    `;
    enemyWait.querySelector('#btn-battle-speed-toggle').addEventListener('click', () => onToggleSpeed());
    root.appendChild(enemyWait);
  }

  // ============================================================
  // TIER 3 (LOWER): Allied Roster Status OR Click-to-Inspect Enemy Intel Panel
  // ============================================================
  const lowerZone = document.createElement('section');
  lowerZone.className = 'bf-lower-status-zone';
  lowerZone.id = 'bf-lower-status-zone';

  if (inspectedEnemy) {
    const alive = inspectedEnemy.hp > 0;
    const hpPct = Math.round((Math.max(0, inspectedEnemy.hp) / Math.max(1, inspectedEnemy.maxHp)) * 100);
    const eCode = inspectedEnemy.slotCode || '01';
    const eRowLabel = GRID_ROW_LABELS[inspectedEnemy.gridRow ?? 0] || '前排';
    const intent = inspectedEnemy.nextIntent;
    const lockedAllyText = intent?.targetAllyName
      ? `锁定我方「${intent.targetAllyName}」`
      : intent?.guardTargetName
      ? `护卫敌舰「${intent.guardTargetName}」`
      : '常规警戒';
    const curRangeEval = currentActor
      ? computeRangeRowCombatModifiers({
          engagementRange: session.range,
          attackerRow: currentActor.gridRow ?? 0,
          defenderRow: inspectedEnemy.gridRow ?? 0,
          actionId: availableActions?.[0]?.id || 'tactical_shelling',
          shipClass: resolveShipClass(currentActor.shipType),
        })
      : null;

    lowerZone.innerHTML = `
      <div class="bf-enemy-intel-panel" id="bf-enemy-intel-panel" data-inspected-enemy="${escapeHtml(inspectedEnemy.id)}">
        <div class="bf-intel-head">
          <div class="bf-intel-title-group">
            <span class="status-badge badge-danger">敌舰 E${escapeHtml(eCode)}</span>
            ${getTacticalGridSymbolSvg(inspectedEnemy.shipClass || inspectedEnemy.role, { side: 'enemy', size: 20 })}
            <strong>${escapeHtml(inspectedEnemy.name)}</strong>
            <span class="status-badge badge-muted">${escapeHtml(inspectedEnemy.shipClass || 'CL')} · 敌${escapeHtml(eRowLabel)}</span>
          </div>
          <button type="button" id="btn-intel-back-allies" class="btn-secondary bf-ctrl-btn">← 返回我方编队状态</button>
        </div>

        <div class="bf-intel-hp-row">
          <div class="bf-mini-hp-track is-tall">
            <div class="bf-mini-hp-fill is-enemy" style="width:${hpPct}%"></div>
          </div>
          <span class="bf-intel-hp-val">
            ${!alive ? '已击沉' : inspectedEnemy.scanned ? `HP ${inspectedEnemy.hp}/${inspectedEnemy.maxHp}` : `HP ${hpPct}% (未扫描)`}
          </span>
        </div>

        <div class="bf-intel-grid">
          <div class="bf-intel-cell">
            <span class="bf-intel-k">护甲 / 机动</span>
            <strong>${inspectedEnemy.scanned ? `甲 ${inspectedEnemy.armor}${inspectedEnemy.armorBraceBonus ? `+${inspectedEnemy.armorBraceBonus}` : ''} · 机 ${inspectedEnemy.evasion}` : `甲 ??? · 机 ${inspectedEnemy.evasion}`}</strong>
          </div>
          <div class="bf-intel-cell">
            <span class="bf-intel-k">已侦查弱点</span>
            <strong>${inspectedEnemy.scanned ? escapeHtml(inspectedEnemy.weaknessLabel || '炮击弱点') : '未侦查（雷达扫描揭露）'}</strong>
          </div>
        </div>

        ${
          alive && intent
            ? `<div class="bf-intel-intent-box">
                <span class="status-badge badge-warn">⚠ 下回合意图：${escapeHtml(intent.label)}</span>
                <span class="bf-intel-intent-desc">${escapeHtml(lockedAllyText)} · ${escapeHtml(intent.desc || '')}</span>
              </div>`
            : ''
        }

        ${
          curRangeEval && alive
            ? `<div class="bf-intel-range-note">
                当前「${escapeHtml(currentActor.name)}」瞄准此目标：<strong>${escapeHtml(curRangeEval.label)}（伤害 x${curRangeEval.dmgMult.toFixed(2)} · 命中 ${curRangeEval.hitMod >= 0 ? `+${curRangeEval.hitMod}` : curRangeEval.hitMod}）</strong>
              </div>`
            : ''
        }
      </div>
    `;

    lowerZone.querySelector('#btn-intel-back-allies')?.addEventListener('click', () => {
      if (typeof onClearInspectEnemy === 'function') onClearInspectEnemy();
    });
  } else {
    const orderedAllies = Array.from(allyByCell.values()).sort((a, b) => (a.slotNo || 99) - (b.slotNo || 99));
    lowerZone.innerHTML = `
      <div class="bf-lower-head">
        <span class="bf-lower-title">我方参战编队状态（点名高亮沙盘 · 点上方敌标查情报）</span>
        <span class="status-badge badge-muted">${orderedAllies.filter((m) => m.alive).length}/${orderedAllies.length} 存活</span>
      </div>
      <div class="bf-ally-status-list" id="bf-player-fleet-strip">
        ${orderedAllies
          .map((m) => {
            const isAct = currentActor && m.id === currentActor.id;
            const isHi = highlightedAllyId && highlightedAllyId === m.id;
            const pct = Math.round((Math.max(0, m.hp) / Math.max(1, m.maxHp)) * 100);
            const rowTag = GRID_ROW_LABELS[m.gridRow ?? 0]?.[0] || '前';
            const statusText = !m.alive
              ? '退场'
              : isAct
              ? '行动中'
              : session.guardActorId === m.id && session.guardTurns > 0
              ? '援护中'
              : pct < 25
              ? '大破'
              : '正常';
            const statusTone = !m.alive || pct < 25 ? 'danger' : isAct ? 'ok' : 'muted';
            return `
            <button type="button" class="bf-ally-row-card ${isAct ? 'is-acting' : ''} ${isHi ? 'is-highlighted' : ''} ${pct < 25 ? 'is-danger' : ''}" data-status-ally-id="${escapeHtml(m.id)}">
              <div class="bf-ally-row-top">
                <span class="bf-ally-num">${escapeHtml(m.slotCode)}</span>
                <span class="ship-class-ico">${getShipClassSvg(m.shipType, { size: 15 })}</span>
                <strong class="bf-ally-full-name">${escapeHtml(m.name)}</strong>
                <span class="bf-ally-pos-tag">${escapeHtml(rowTag)}排·甲${m.armor || 0}</span>
                <span class="status-badge badge-${statusTone}">${statusText}</span>
              </div>
              <div class="bf-ally-row-hp">
                <div class="bf-mini-hp-track">
                  <div class="bf-mini-hp-fill ${pct < 25 ? 'is-danger' : 'is-ally'}" style="width:${pct}%"></div>
                </div>
                <span class="bf-ally-hp-num">${m.hp}/${m.maxHp}</span>
              </div>
            </button>
          `;
          })
          .join('')}
      </div>
    `;

    lowerZone.querySelectorAll('[data-status-ally-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const aid = btn.getAttribute('data-status-ally-id');
        if (typeof onHighlightAlly === 'function') onHighlightAlly(aid);
      });
    });
  }

  if (latestLog) {
    const logLine = document.createElement('div');
    logLine.className = 'bf-live-speech';
    logLine.id = 'bf-live-speech';
    logLine.textContent = latestLog.text;
    lowerZone.appendChild(logLine);
  }

  root.appendChild(lowerZone);
  host.appendChild(root);
  return root;
}
