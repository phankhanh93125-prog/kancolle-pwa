/**
 * Dedicated Full-Screen Unified-Initiative Ship-Type Tactical Battle View (`battle-screen.js`).
 *
 * Mounted immersively by `sortie-console.js` whenever a combat encounter is active or awaiting
 * day/night transition or post-battle settlement. Automatically hides the sea chart and locks
 * horizontal swipe navigation (`ui.setImmersiveBattle(true)`).
 *
 * Visual Highlights:
 *   - Supports 1~12 dynamically scaled enemy ships with ship-class badges, CA guard state & locked-ally intent warnings
 *   - Unified Ally + Enemy Initiative Queue (`#bf-turn-queue`) clearly marking 己方 vs 敌方 & initiative order
 *   - Opening Phase SVG Choreography (Recon / Preemptive Ambush / Opening Airstrike / Opening Torpedo)
 *   - Class-exclusive allied command deck + 1x/2x speed + Round Auto-Delegate + Day/Night prompt + Post-Battle Settlement
 */

import { RANGE_META } from '../core/tactical-combat.js';
import { getShipClassProfile, getShipClassSvg, resolveShipClass } from '../core/stat-rules.js';

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildEnemyUnitSvg(role = 'flagship', shipClass = '') {
  const cls = String(shipClass || '').toUpperCase();
  if (role === 'boss' || cls === 'BOSS') {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="1.9"><polygon points="12 2 21 7 21 17 12 22 3 17 3 7 12 2" fill="rgba(248,113,113,0.22)"/><path d="M8 9h8M7 13h10M9 17h6"/></svg>`;
  }
  if (role === 'sub' || cls === 'SS') {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="1.9"><ellipse cx="12" cy="14" rx="8" ry="4" fill="rgba(34,211,238,0.18)"/><path d="M12 10V6h3"/></svg>`;
  }
  if (role === 'carrier' || cls === 'CV') {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="1.9"><path d="M12 3 21 17h-6l-3-4-3 4H3L12 3Z" fill="rgba(192,132,252,0.2)"/></svg>`;
  }
  if (role === 'battleship' || cls === 'BB') {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="1.9"><rect x="4" y="5" width="16" height="14" rx="3" fill="rgba(249,115,22,0.2)"/><path d="M8 9h8M8 15h8"/></svg>`;
  }
  if (role === 'cruiser' || cls === 'CA') {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="1.9"><polygon points="12 3 20 8 18 19 6 19 4 8 12 3" fill="rgba(251,191,36,0.18)"/></svg>`;
  }
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="1.9"><polygon points="12 3 20 12 12 21 4 12 12 3" fill="rgba(251,146,60,0.18)"/><circle cx="12" cy="12" r="2.6"/></svg>`;
}

export function buildBattleSvgMarkup(visualStyle) {
  if (visualStyle === 'airstrike') {
    return `
      <g class="bf-anim-airstrike">
        <path class="bf-arc-path" d="M 48 118 Q 140 58 264 30" stroke="#c084fc" stroke-width="2.5" stroke-dasharray="6 4" fill="none" />
        <path class="bf-arc-path" d="M 104 124 Q 190 66 284 36" stroke="#a78bfa" stroke-width="2.2" stroke-dasharray="6 4" fill="none" />
        <polygon points="244,24 260,34 248,40" fill="#e9d5ff" />
        <polygon points="266,30 282,40 270,46" fill="#c084fc" />
        <circle class="bf-impact-ring" cx="288" cy="34" r="18" stroke="#c084fc" stroke-width="2.6" fill="rgba(168,85,247,0.22)" />
      </g>
    `;
  }
  if (visualStyle === 'enemy_airstrike') {
    return `
      <g class="bf-anim-airstrike">
        <path class="bf-arc-path" d="M 308 24 Q 210 66 90 116" stroke="#f43f5e" stroke-width="2.6" stroke-dasharray="6 4" fill="none" />
        <path class="bf-arc-path" d="M 256 20 Q 170 60 66 108" stroke="#fb7185" stroke-width="2.2" stroke-dasharray="6 4" fill="none" />
        <polygon points="104,104 86,116 100,122" fill="#fda4af" />
        <polygon points="80,96 62,108 76,114" fill="#f43f5e" />
        <circle class="bf-impact-ring" cx="84" cy="116" r="18" stroke="#f43f5e" stroke-width="2.6" fill="rgba(244,63,94,0.25)" />
      </g>
    `;
  }
  if (visualStyle === 'torpedo') {
    return `
      <g class="bf-anim-torpedo">
        <line class="bf-torp-path" x1="78" y1="120" x2="262" y2="34" stroke="#22d3ee" stroke-width="3" stroke-dasharray="10 6" stroke-linecap="round" />
        <line class="bf-torp-path" x1="112" y1="126" x2="288" y2="42" stroke="#38bdf8" stroke-width="2.6" stroke-dasharray="10 6" stroke-linecap="round" />
        <circle class="bf-torp-ripple" cx="274" cy="38" r="18" stroke="#22d3ee" stroke-width="2.5" fill="rgba(34,211,238,0.2)" />
      </g>
    `;
  }
  if (visualStyle === 'enemy_torpedo') {
    return `
      <g class="bf-anim-torpedo">
        <line class="bf-torp-path" x1="286" y1="26" x2="96" y2="114" stroke="#fb7185" stroke-width="3" stroke-dasharray="10 6" stroke-linecap="round" />
        <line class="bf-torp-path" x1="252" y1="22" x2="68" y2="108" stroke="#22d3ee" stroke-width="2.5" stroke-dasharray="10 6" stroke-linecap="round" />
        <circle class="bf-torp-ripple" cx="86" cy="112" r="18" stroke="#f43f5e" stroke-width="2.6" fill="rgba(244,63,94,0.24)" />
      </g>
    `;
  }
  if (visualStyle === 'ambush') {
    return `
      <g class="bf-anim-counter">
        <path class="bf-arc-path" d="M 312 22 L 220 58 L 240 66 L 94 116" stroke="#ef4444" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        <path class="bf-arc-path" d="M 264 18 Q 186 58 72 104" stroke="#f97316" stroke-width="2.4" stroke-dasharray="6 4" fill="none" />
        <circle class="bf-impact-ring" cx="94" cy="116" r="22" stroke="#ef4444" stroke-width="3" fill="rgba(239,68,68,0.3)" />
      </g>
    `;
  }
  if (visualStyle === 'enemy_salvo') {
    return `
      <g class="bf-anim-counter">
        <path class="bf-arc-path" d="M 294 26 Q 198 56 84 114" stroke="#ef4444" stroke-width="3.4" fill="none" stroke-linecap="round" />
        <path class="bf-arc-path" d="M 264 22 Q 174 52 108 118" stroke="#fb923c" stroke-width="2.6" fill="none" stroke-linecap="round" />
        <circle class="bf-impact-ring" cx="94" cy="116" r="20" stroke="#ef4444" stroke-width="2.8" fill="rgba(239,68,68,0.26)" />
      </g>
    `;
  }
  if (visualStyle === 'enemy_guard') {
    return `
      <g class="bf-anim-guard">
        <polygon class="bf-shield-hex" points="230,20 272,38 272,76 230,94 188,76 188,38" fill="rgba(251,146,60,0.22)" stroke="#fb923c" stroke-width="2.6" />
        <path d="M 216 57 L 228 69 L 248 47" stroke="#fed7aa" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </g>
    `;
  }
  if (visualStyle === 'asw') {
    return `
      <g class="bf-anim-asw">
        <circle class="bf-sonar-fan" cx="180" cy="70" r="24" stroke="#22d3ee" stroke-width="2" fill="rgba(34,211,238,0.12)" />
        <circle class="bf-sonar-fan" cx="180" cy="70" r="46" stroke="#38bdf8" stroke-width="1.6" stroke-dasharray="5 4" fill="none" />
        <path class="bf-arc-path" d="M 110 116 Q 185 36 258 76" stroke="#34d399" stroke-width="2.8" fill="none" />
        <circle class="bf-impact-ring" cx="258" cy="76" r="16" stroke="#34d399" stroke-width="2.5" fill="rgba(52,211,153,0.26)" />
      </g>
    `;
  }
  if (visualStyle === 'scan') {
    return `
      <g class="bf-anim-scan">
        <path class="bf-sonar-fan" d="M 180 120 L 92 24 A 118 118 0 0 1 268 24 Z" fill="rgba(16,185,129,0.22)" stroke="#34d399" stroke-width="2" />
        <circle class="bf-impact-ring" cx="180" cy="40" r="20" stroke="#34d399" stroke-width="2" fill="none" stroke-dasharray="4 3" />
      </g>
    `;
  }
  if (visualStyle === 'smoke') {
    return `
      <g class="bf-anim-smoke">
        <circle class="bf-sonar-fan" cx="130" cy="86" r="26" fill="rgba(148,163,184,0.34)" stroke="#cbd5e1" stroke-width="1.8" />
        <circle class="bf-sonar-fan" cx="180" cy="76" r="32" fill="rgba(148,163,184,0.32)" stroke="#e2e8f0" stroke-width="2" />
        <circle class="bf-sonar-fan" cx="232" cy="86" r="26" fill="rgba(148,163,184,0.34)" stroke="#cbd5e1" stroke-width="1.8" />
      </g>
    `;
  }
  if (visualStyle === 'aa') {
    return `
      <g class="bf-anim-aa">
        <line class="bf-speed-line" x1="88" y1="122" x2="155" y2="38" stroke="#fbbf24" stroke-width="2.4" stroke-dasharray="6 4" />
        <line class="bf-speed-line" x1="180" y1="124" x2="188" y2="28" stroke="#fbbf24" stroke-width="2.6" stroke-dasharray="6 4" />
        <line class="bf-speed-line" x1="272" y1="122" x2="218" y2="38" stroke="#fbbf24" stroke-width="2.4" stroke-dasharray="6 4" />
        <circle class="bf-impact-ring" cx="155" cy="38" r="11" stroke="#fde047" stroke-width="2" fill="rgba(250,204,21,0.25)" />
        <circle class="bf-impact-ring" cx="218" cy="38" r="11" stroke="#fde047" stroke-width="2" fill="rgba(250,204,21,0.25)" />
      </g>
    `;
  }
  if (visualStyle === 'guard') {
    return `
      <g class="bf-anim-guard">
        <polygon class="bf-shield-hex" points="180,26 232,50 232,96 180,120 128,96 128,50" fill="rgba(59,130,246,0.22)" stroke="#60a5fa" stroke-width="2.6" />
        <path d="M 162 72 L 176 86 L 202 58" stroke="#93c5fd" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </g>
    `;
  }
  if (visualStyle === 'advance' || visualStyle === 'evade') {
    return `
      <g class="bf-anim-evade">
        <path class="bf-speed-line" d="M 96 112 L 180 62 L 264 112" stroke="#38bdf8" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        <path class="bf-speed-line" d="M 116 84 L 180 42 L 244 84" stroke="#60a5fa" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </g>
    `;
  }
  if (visualStyle === 'counter') {
    return `
      <g class="bf-anim-counter">
        <path class="bf-arc-path" d="M 276 26 Q 190 70 96 116" stroke="#ef4444" stroke-width="3.2" fill="none" stroke-linecap="round" />
        <circle class="bf-impact-ring" cx="96" cy="116" r="18" stroke="#f87171" stroke-width="2.6" fill="rgba(239,68,68,0.26)" />
      </g>
    `;
  }
  // Default: shelling / heavy_shelling / main_salvo
  return `
    <g class="bf-anim-shelling">
      <path class="bf-arc-path" d="M 68 118 Q 168 38 278 32" stroke="#f97316" stroke-width="3.2" fill="none" stroke-linecap="round" />
      <path class="bf-arc-path" d="M 102 124 Q 194 48 294 40" stroke="#fbbf24" stroke-width="2.4" fill="none" stroke-linecap="round" />
      <circle class="bf-impact-ring" cx="282" cy="36" r="18" stroke="#fb923c" stroke-width="2.6" fill="rgba(249,115,22,0.25)" />
    </g>
  `;
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
    await wait(480);
  }
}

/**
 * Play slow-motion vector trajectory + hit choreography inside the mounted full-screen battle screen.
 * Supports both allied actions and interleaved enemy initiative actions!
 */
export async function playBattleStepChoreography(rootEl, { turnEntry, fxStage }) {
  if (!rootEl || !turnEntry) return;
  const wait = (ms) =>
    fxStage && typeof fxStage.wait === 'function' ? fxStage.wait(ms) : new Promise((r) => setTimeout(r, ms));

  const svg = rootEl.querySelector('#bf-svg-canvas');
  const banner = rootEl.querySelector('#bf-banner');
  const callout = rootEl.querySelector('#bf-callout');

  if (turnEntry.side === 'enemy') {
    const enemyCard = rootEl.querySelector(`[data-enemy-unit-id="${CSS.escape(turnEntry.actorId || '')}"]`);
    if (enemyCard) enemyCard.classList.add('is-acting-enemy');
    if (banner) {
      banner.textContent = `敌方行动：[${turnEntry.actorClass}] ${turnEntry.actorName} → 【${turnEntry.commandLabel}】`;
      banner.className = 'bf-banner is-counter';
    }
    if (svg) {
      svg.innerHTML = buildBattleSvgMarkup(turnEntry.visualStyle || 'counter');
    }
    await wait(280);
    if (callout) {
      if (turnEntry.damageTaken > 0) {
        callout.textContent = `${turnEntry.targetAllyName || '我方'} -${turnEntry.damageTaken} HP`;
        callout.className = 'bf-callout is-visible is-counter';
      } else {
        callout.textContent = `敌方【${turnEntry.commandLabel}】生效`;
        callout.className = 'bf-callout is-visible is-scan';
      }
    }
    await wait(340);
    if (enemyCard) enemyCard.classList.remove('is-acting-enemy');
    return;
  }

  const targetEnemyCard = rootEl.querySelector(`[data-enemy-unit-id="${CSS.escape(turnEntry.targetEnemyId || '')}"]`);

  // Phase 1: Banner + SVG Vector Trajectory
  if (banner) {
    banner.textContent = `[${turnEntry.actorClass}] ${turnEntry.actorName} → 【${turnEntry.commandLabel}】`;
    banner.className = `bf-banner is-${turnEntry.visualStyle || 'shelling'}`;
  }
  if (svg) {
    svg.innerHTML = buildBattleSvgMarkup(turnEntry.visualStyle || 'shelling');
  }
  await wait(320);

  // Phase 2: Hit shake / callout
  if (turnEntry.damageDealt > 0 && targetEnemyCard) {
    targetEnemyCard.classList.add('is-hit');
  }
  if (callout) {
    if (turnEntry.damageDealt > 0) {
      callout.textContent = `${turnEntry.isCrit ? '★ CRIT ' : ''}-${turnEntry.damageDealt} HP`;
      callout.className = `bf-callout is-visible ${turnEntry.isCrit ? 'is-crit' : 'is-dmg'}`;
    } else if (turnEntry.rangeChangedTo) {
      callout.textContent = `距离拉近 → ${turnEntry.rangeChangedTo}`;
      callout.className = 'bf-callout is-visible is-scan';
    } else if (turnEntry.scannedNow) {
      callout.textContent = '弱点与意图已揭露！';
      callout.className = 'bf-callout is-visible is-scan';
    } else {
      callout.textContent = `【${turnEntry.commandLabel}】生效`;
      callout.className = 'bf-callout is-visible is-scan';
    }
  }
  await wait(360);

  if (targetEnemyCard) targetEnemyCard.classList.remove('is-hit');
}

/**
 * Render the complete Dedicated Full-Screen Tactical Battle Interface.
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
  fxStage,
  uiKit,
  onSelectTarget,
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
  root.className = 'battle-fullscreen-root';
  root.id = 'battle-fullscreen-stage';

  const curSpeed = fxStage && typeof fxStage.getBattleSpeed === 'function' ? fxStage.getBattleSpeed() : 1;
  const isNight = session.phase === 'night';
  const rangeMeta = RANGE_META[session.range] || RANGE_META.long;
  const latestLog = session.turnsLog?.[0] || null;
  const enemies = session.enemies || [];
  const aliveEnemyCount = enemies.filter((e) => e.hp > 0).length;
  const strMult = Number(session.strengthMultiplier || 1.0);

  // 1. Dedicated Full-Screen Battle Topbar
  const topbar = document.createElement('div');
  topbar.className = 'bf-fullscreen-topbar';
  topbar.innerHTML = `
    <div class="bf-phase-group">
      <span class="status-badge ${isNight ? 'badge-warn' : 'badge-danger'}" id="bf-phase-badge">
        ${isNight ? `★ 夜战追击 · 第 ${session.round} 回合` : `昼战交锋 · 第 ${session.round}/${session.dayMaxRounds} 回合`}
      </span>
      <span class="bf-node-tag">${escapeHtml(session.nodeCode)} · ${escapeHtml(session.nodeName)} · 敌${aliveEnemyCount}/${enemies.length}${strMult !== 1 ? ` · ${strMult.toFixed(1)}x` : ''}</span>
    </div>
    <div class="bf-topbar-controls">
      <button type="button" id="btn-battle-auto-toggle" class="${autoRunning || session.autoDelegateRound ? 'btn-primary' : 'btn-secondary'} bf-ctrl-btn" ${session.status !== 'active' ? 'disabled' : ''}>
        ${autoRunning || session.autoDelegateRound ? '托管执行中' : '本回合托管'}
      </button>
      <button type="button" id="btn-battle-speed-toggle" class="btn-secondary bf-ctrl-btn">
        ${curSpeed}x
      </button>
    </div>
  `;
  topbar.querySelector('#btn-battle-auto-toggle').addEventListener('click', () => onToggleAuto());
  topbar.querySelector('#btn-battle-speed-toggle').addEventListener('click', () => onToggleSpeed());
  root.appendChild(topbar);

  // 2. Upper Section: Enemy Fleet Cards (scales cleanly from 1 to 12 ships!)
  const enemyGrid = document.createElement('div');
  enemyGrid.className = `bf-enemy-grid ${enemies.length >= 4 ? 'is-large-fleet' : ''}`;
  enemyGrid.id = 'bf-enemy-grid';
  for (const en of enemies) {
    const alive = en.hp > 0;
    const isTargeted = en.id === session.targetEnemyId && alive;
    const isActingEnemy =
      session.status === 'active' &&
      currentTurnSlot &&
      currentTurnSlot.side === 'enemy' &&
      currentTurnSlot.unitId === en.id;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `bf-enemy-unit-card ${isTargeted ? 'is-targeted' : ''} ${!alive ? 'is-sunk' : ''} ${isActingEnemy ? 'is-acting-enemy' : ''}`;
    card.dataset.enemyUnitId = en.id;
    card.disabled = !alive || busy;
    const intent = en.nextIntent;
    const lockedLabel = intent?.targetAllyName ? `→${intent.targetAllyName.slice(0, 4)}` : intent?.guardTargetName ? `→护卫` : '';
    card.innerHTML = `
      <div class="bf-enemy-unit-top">
        <span class="bf-enemy-ico">${buildEnemyUnitSvg(en.role, en.shipClass)}</span>
        <div class="bf-enemy-meta">
          <strong class="bf-enemy-name">[${escapeHtml(en.shipClass || 'CL')}] ${escapeHtml(en.name)}</strong>
          <span class="bf-enemy-sub">
            ${
              !alive
                ? '已击沉'
                : en.scanned
                ? `机${en.evasion || 50} · 甲${en.armor}${en.armorBraceBonus ? `+${en.armorBraceBonus}` : ''} · 弱:${escapeHtml(en.weaknessLabel)}`
                : `机${en.evasion || 50} · 护甲??? · 扫描揭露弱点`
            }
          </span>
        </div>
        ${en.guardTurns > 0 ? '<span class="status-badge badge-warn">援护</span>' : ''}
        ${isTargeted ? '<span class="status-badge badge-danger">锁定</span>' : ''}
      </div>
      <div class="bf-mini-hp-track">
        <div class="bf-mini-hp-fill is-enemy" style="width:${Math.round((Math.max(0, en.hp) / Math.max(1, en.maxHp)) * 100)}%"></div>
      </div>
      <div class="bf-enemy-foot">
        <span class="bf-hp-num">${en.scanned || !alive ? `${en.hp}/${en.maxHp}` : '??? / ???'}</span>
        ${
          alive && intent
            ? `<span class="bf-intent-pill is-${escapeHtml(intent.tone || 'danger')}" data-enemy-intent="${escapeHtml(intent.id)}">⚠ ${escapeHtml(intent.label)}${escapeHtml(lockedLabel)}</span>`
            : ''
        }
      </div>
    `;
    card.addEventListener('click', () => onSelectTarget(en.id));
    enemyGrid.appendChild(card);
  }
  root.appendChild(enemyGrid);

  // 3. Center Tactical Stage: Opening Strip + Engagement Range + Active Buffs + Pure-SVG Arena
  const centerStage = document.createElement('div');
  centerStage.className = 'bf-center-stage';
  const activeBuffs = [];
  if (session.reconStatus === 'ambushed') activeBuffs.push('⚠ 曾遭先制伏击');
  else if (session.reconStatus === 'success') activeBuffs.push('✓ 索敌成功');
  if (session.smokeTurns > 0) activeBuffs.push(`烟幕(${session.smokeTurns}T)`);
  if (session.aaAlertTurns > 0) activeBuffs.push(`防空警戒(${session.aaAlertTurns}T)`);
  if (session.guardTurns > 0) activeBuffs.push(`前排援护(${session.guardTurns}T)`);
  if (session.reconCritTurns > 0) activeBuffs.push(`侦察暴击+20%(${session.reconCritTurns}T)`);
  if (session.lockOnBonus > 0) activeBuffs.push(`锁定+${session.lockOnBonus}`);
  if (session.evasionBuffTurns > 0) activeBuffs.push(`机动规避(${session.evasionBuffTurns}T)`);

  const openingEvents = Array.isArray(session.openingEvents) ? session.openingEvents : [];

  centerStage.innerHTML = `
    <div class="bf-range-bar" id="bf-range-indicator" data-range="${escapeHtml(session.range)}">
      <span class="bf-range-title">交战距离</span>
      <div class="bf-range-steps">
        ${['long', 'medium', 'close']
          .map(
            (rId) => `
          <span class="bf-range-step ${session.range === rId ? 'is-active' : ''}">${escapeHtml(RANGE_META[rId].label)}</span>
        `
          )
          .join('')}
      </div>
    </div>
    <div class="bf-range-desc">${escapeHtml(rangeMeta.desc)}</div>
    ${
      openingEvents.length > 0
        ? `<div class="bf-opening-strip" id="bf-opening-strip">
            ${openingEvents
              .map(
                (oe) =>
                  `<span class="status-badge ${oe.kind === 'ambush' ? 'badge-danger' : oe.kind === 'recon' ? 'badge-ok' : 'badge-warn'}">${escapeHtml(oe.title)}</span>`
              )
              .join('')}
          </div>`
        : ''
    }
    ${
      activeBuffs.length > 0
        ? `<div class="bf-buff-strip">${activeBuffs.map((b) => `<span class="status-badge ${b.includes('伏击') ? 'badge-danger' : 'badge-ok'}">${escapeHtml(b)}</span>`).join('')}</div>`
        : ''
    }
    <div class="bf-arena" id="bf-svg-stage">
      <div class="bf-banner" id="bf-banner" aria-live="polite">
        ${
          latestLog
            ? `${latestLog.side === 'enemy' ? '敌方 · ' : ''}[${escapeHtml(latestLog.actorClass)}] ${escapeHtml(latestLog.actorName)} · ${escapeHtml(latestLog.commandLabel)}`
            : currentTurnSlot && currentTurnSlot.side === 'enemy'
            ? `敌方高速舰 [${escapeHtml(currentTurnSlot.classCode)}] ${escapeHtml(currentTurnSlot.name)} 正在行动…`
            : currentActor
            ? `轮到 [${escapeHtml(resolveShipClass(currentActor.shipType))}] ${escapeHtml(currentActor.name)} 下达指令`
            : '战局结算中'
        }
      </div>
      <svg id="bf-svg-canvas" class="bf-svg-layer" viewBox="0 0 360 136" preserveAspectRatio="xMidYMid meet" aria-hidden="true"></svg>
      <div class="bf-callout" id="bf-callout" aria-live="polite"></div>
    </div>
    ${
      latestLog
        ? `<div class="bf-live-speech" id="bf-live-speech">${escapeHtml(latestLog.text)}</div>`
        : ''
    }
  `;
  root.appendChild(centerStage);

  // 4. Unified Ally + Enemy Mixed Initiative Sequence Strip
  const queueBar = document.createElement('div');
  queueBar.className = 'bf-turn-queue';
  queueBar.id = 'bf-turn-queue';
  queueBar.dataset.noSwipe = 'true';
  for (let i = 0; i < (session.turnQueue || []).length; i++) {
    const slot = session.turnQueue[i];
    const side = slot.side || 'ally';
    const uid = slot.unitId || slot.characterId;
    const isCur =
      session.status === 'active' &&
      currentTurnSlot &&
      currentTurnSlot.side === side &&
      currentTurnSlot.unitId === uid;
    const isDead =
      side === 'enemy'
        ? !(enemies.find((e) => e.id === uid)?.hp > 0)
        : !(fleetSummary?.members?.find((m) => m.id === uid)?.alive ?? true);

    const pill = document.createElement('div');
    pill.className = `bf-queue-chip ${side === 'enemy' ? 'is-enemy-slot' : 'is-ally-slot'} ${isCur ? 'is-active-actor' : ''} ${slot.acted || isDead ? 'is-acted' : ''}`;
    pill.dataset.queueSide = side;
    pill.dataset.queueUnitId = String(uid || '');
    pill.dataset.queueCharId = side === 'ally' ? String(uid || '') : '';
    pill.dataset.queueClass = slot.classCode;
    pill.dataset.queueEvasion = String(slot.evasion);
    pill.dataset.queueInitiative = String(slot.initiative ?? slot.evasion);
    pill.innerHTML =
      side === 'enemy'
        ? `
          <span class="bf-side-tag is-enemy">敌</span>
          <span class="bf-queue-name">[${escapeHtml(slot.classCode)}]${escapeHtml(slot.name.slice(0, 4))}</span>
          <span class="bf-queue-spd">${isDead ? '沉' : slot.acted ? '✓' : `先${slot.initiative ?? slot.evasion}`}</span>
        `
        : `
          <span class="ship-class-ico">${getShipClassSvg(slot.shipType, { size: 14 })}</span>
          <span class="bf-queue-name">${escapeHtml(slot.name.slice(0, 5))}</span>
          <span class="bf-queue-spd">${isDead ? '退' : slot.acted ? '✓' : `先${slot.initiative ?? slot.evasion}`}</span>
        `;
    queueBar.appendChild(pill);
  }
  root.appendChild(queueBar);

  // 5. Lower Section: Night Prompt OR Settlement OR Active Ally Command Deck OR Enemy Turn Banner
  if (session.status === 'night_prompt') {
    const nightCard = document.createElement('section');
    nightCard.className = 'bf-prompt-card';
    nightCard.id = 'bf-night-prompt';
    nightCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h3 class="section-title" style="color:#fef08a;">昼战结束 · 尚余 ${aliveEnemyCount} 艘敌舰</h3>
        <span class="status-badge badge-warn">昼夜战抉择</span>
      </div>
      <p class="muted-text" style="color:#cbd5e1; font-size:12.5px; margin:0;">
        追击进入夜战将自动贴近至「近距离」，雷击突击伤害 +45%、暴击率 +25%，但敌方残存舰艇也会发动反击。
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
      <p style="font-size:12.5px; color:#cbd5e1; margin:0;">${escapeHtml(settlementInfo.summary)}</p>
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
    const deck = document.createElement('section');
    deck.className = 'bf-command-deck';
    deck.id = 'bf-command-deck';
    deck.dataset.activeActorId = currentActor.id;
    deck.dataset.activeActorClass = actorProf.code;

    deck.innerHTML = `
      <div class="bf-actor-header">
        <div class="bf-actor-id">
          <span class="ship-class-ico">${getShipClassSvg(currentActor.shipType, { size: 20 })}</span>
          <strong>${escapeHtml(currentActor.name)}</strong>
          <span class="status-badge badge-ok">${escapeHtml(actorProf.fullName)} (${actorProf.code})</span>
        </div>
        <span class="bf-actor-hp">HP ${currentActor.hp}/${currentActor.maxHp} · 机${currentActor.evasion}</span>
      </div>
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

    deck.querySelectorAll('[data-battle-action]').forEach((btn) => {
      btn.addEventListener('click', () => onExecuteAction(btn.getAttribute('data-battle-action')));
    });
    root.appendChild(deck);
  } else if (currentTurnSlot && currentTurnSlot.side === 'enemy') {
    const enemyWait = document.createElement('section');
    enemyWait.className = 'bf-command-deck';
    enemyWait.id = 'bf-enemy-acting-banner';
    enemyWait.innerHTML = `
      <div class="bf-actor-header">
        <div class="bf-actor-id">
          <span class="status-badge badge-danger">敌方先手</span>
          <strong>[${escapeHtml(currentTurnSlot.classCode)}] ${escapeHtml(currentTurnSlot.name)}</strong>
        </div>
        <span class="bf-actor-hp">先攻 ${currentTurnSlot.initiative ?? currentTurnSlot.evasion}</span>
      </div>
      <p class="muted-text" style="color:#fca5a5; font-size:12px; margin:4px 0 0;">
        敌方高速舰艇抢先出手，正在结算敌军战术指令…
      </p>
    `;
    root.appendChild(enemyWait);
  }

  // 6. Player Fleet Compact HP Bar Strip
  if (fleetSummary && Array.isArray(fleetSummary.members)) {
    const strip = document.createElement('div');
    strip.className = 'bf-player-fleet-strip';
    strip.id = 'bf-player-fleet-strip';
    for (const m of fleetSummary.members) {
      const isAct = currentActor && m.id === currentActor.id;
      const pct = Math.round((Math.max(0, m.hp) / Math.max(1, m.maxHp)) * 100);
      const pill = document.createElement('div');
      pill.className = `bf-ally-chip ${isAct ? 'is-acting' : ''} ${pct < 25 ? 'is-danger' : ''}`;
      pill.innerHTML = `
        <div class="bf-ally-top">
          <span>[${escapeHtml(resolveShipClass(m.shipType))}] ${escapeHtml(m.name.slice(0, 5))}</span>
          <span>${m.hp}/${m.maxHp}</span>
        </div>
        <div class="bf-mini-hp-track">
          <div class="bf-mini-hp-fill ${pct < 25 ? 'is-danger' : 'is-ally'}" style="width:${pct}%"></div>
        </div>
      `;
      strip.appendChild(pill);
    }
    root.appendChild(strip);
  }

  host.appendChild(root);
  return root;
}
