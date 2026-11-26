/**
 * Dedicated Full-Screen Port Facility Pages (`port-facilities.js`).
 *
 * Exports 4 dedicated full-screen sub-page modules (`isSubpage: true`, `lockSwipe: true`),
 * each featuring the unified `← 返回港区` top header and relevant resource balances:
 *   1. `portDormitoryModule`  (`port-dormitory`)  : 舰娘宿舍 & 全员花名册（点头像直达角色卡）
 *   2. `portDockyardModule`   (`port-dockyard`)   : 船坞整备（入渠维修队列 + 新舰建造登记）
 *   3. `portFormationModule`  (`port-formation`)  : 舰队编成（3~12人动态编队 + 阶梯消耗拆解 + 阵型）
 *   4. `portExpeditionModule` (`port-expedition`) : 远征派遣中心（离线时间戳倒计时与结算）
 */

import {
  GRID_COLS,
  GRID_ROWS,
  GRID_ROW_LABELS,
  SHIP_TYPE_PRESETS,
  getShipClassProfile,
  getShipClassSvg,
  getTacticalGridSymbolSvg,
  resolveShipClass,
} from '../core/stat-rules.js';
import {
  CONSTRUCTION_RECIPE_PRESETS,
  computeConstructionProbabilities,
} from '../core/port-buildings.js';
import { openCharacterCardById, persistCharacterRoster } from './character-console.js';

function formatDurationZh(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m}分${remS}秒` : `${m}分钟`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}时${remM}分` : `${h}小时`;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatCostInline(costObj, resources) {
  return Object.entries(costObj || {})
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${resources.get(k)?.name || k} ${v}`)
    .join(' · ');
}

function getAllCharacters(entities) {
  return entities.list({ kind: 'character' });
}

async function resolveAvatar(assets, cache, char) {
  const assetId = char.meta?.avatarAssetId || null;
  const key = `${char.id}::${assetId || 'none'}`;
  if (cache.has(key)) return cache.get(key);
  const res = await assets.getAssetUrl(assetId, {
    fallbackSeed: char.id,
    fallbackLabel: (char.name || '?').slice(0, 4),
  });
  cache.set(key, res.url);
  return res.url;
}

// ============================================================
// 1. Dedicated Full-Screen Page: 舰娘宿舍 (`port-dormitory`)
// ============================================================

function createDormitoryModule() {
  const state = { container: null, context: null, unsubs: [], avatarCache: new Map() };

  async function render() {
    if (!state.container || !state.context) return;
    const { buildings, entities, formation, expeditions, interaction, statRules, resources, assets, rootStorage, modules, uiKit } =
      state.context;
    const dorm = buildings.getDormitoryState();
    const resSet = new Set(dorm.residents.map((r) => r.id));
    const roster = getAllCharacters(entities);

    const avatars = new Map();
    for (const c of roster) {
      avatars.set(c.id, await resolveAvatar(assets, state.avatarCache, c));
    }

    state.container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'subpage-root';
    root.id = 'page-port-dormitory';

    root.appendChild(
      uiKit.createSubpageHeader({
        title: `舰娘宿舍 · Lv.${dorm.level}`,
        subtitle: `床位 ${dorm.residents.length}/${dorm.capacity} · 离线自动回士气与好感`,
        modules,
        resources,
        resourceKeys: ['fuel', 'silver', 'steel'],
        id: 'dorm-subpage-header',
      })
    );

    // Controls & Beds Card
    const topCard = document.createElement('section');
    topCard.className = 'surface-card lab-stack-sm';
    topCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">宿舍设施管理</h2>
        <span class="status-badge badge-ok">士气 +${dorm.moralePerHour}/时 · 好感 +${dorm.affinityPerHour}/时</span>
      </div>
      <div class="lab-btn-grid">
        <button type="button" id="btn-dorm-settle" class="btn-secondary uikit-touch-target">结算离线休整</button>
        <button type="button" id="btn-dorm-feed" class="btn-primary uikit-touch-target" ${dorm.residents.length === 0 ? 'disabled' : ''}>
          投喂补给（全员士气+16/好感+2）
        </button>
      </div>
      <button type="button" id="btn-dorm-expand" class="btn-secondary uikit-touch-target" ${dorm.canExpand ? '' : 'disabled'}>
        ${dorm.canExpand ? `扩建宿舍床位 +1（${escapeHtml(formatCostInline(dorm.expandCost, resources))}）` : '宿舍床位已达上限'}
      </button>
    `;

    topCard.querySelector('#btn-dorm-settle').addEventListener('click', async () => {
      const res = await buildings.settleDormitoryOffline();
      await persistCharacterRoster({ storage: rootStorage, entities });
      uiKit.showToast(
        res.settled ? `宿舍已结算 ${res.minutes} 分钟离线休整` : '距离上次结算不足 1 分钟',
        res.settled ? 'ok' : 'info'
      );
      render();
    });

    topCard.querySelector('#btn-dorm-feed').addEventListener('click', async () => {
      try {
        const res = await buildings.feedDormitory();
        await persistCharacterRoster({ storage: rootStorage, entities });
        uiKit.showToast(`已投喂 ${res.count} 名入住舰娘，士气与好感提升！`, 'ok');
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '投喂失败', 'warn');
      }
    });

    topCard.querySelector('#btn-dorm-expand').addEventListener('click', async () => {
      try {
        const next = await buildings.expandDormitory();
        uiKit.showToast(`宿舍已扩建至 Lv.${next.level}（${next.capacity} 床位）`, 'ok');
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '扩建失败', 'warn');
      }
    });
    root.appendChild(topCard);

    // Active Residents Card
    const bedsCard = document.createElement('section');
    bedsCard.className = 'surface-card lab-stack-sm';
    bedsCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">当前入住床位（${dorm.residents.length}/${dorm.capacity}）</h2>
      </div>
      <div class="lab-stack-sm" id="dorm-beds-list">
        ${
          dorm.residents.length === 0
            ? '<p class="muted-text">当前宿舍暂无入住舰娘，请在下方全员花名册中安排入住。</p>'
            : dorm.residents
                .map((r) => {
                  const ent = entities.get(r.id);
                  const prog = ent ? statRules.ensureShipProgression(ent) : { level: 1 };
                  const avatarUrl = avatars.get(r.id) || '';
                  return `
                  <div class="lab-slot-card dorm-roster-row" data-dorm-resident="${escapeHtml(r.id)}">
                    <div class="dorm-row-main">
                      <button type="button" class="avatar-jump-btn" data-jump-char-card="${escapeHtml(r.id)}" title="点击头像直达精修角色卡">
                        <img class="dorm-mini-avatar" src="${avatarUrl}" alt="${escapeHtml(r.name)}">
                      </button>
                      <div class="dorm-row-info">
                        <div class="dorm-row-title">
                          <span class="ship-class-ico">${getShipClassSvg(r.shipType, { size: 16 })}</span>
                          <strong>${escapeHtml(r.name)}</strong>
                          <span class="status-badge ship-lv-badge">Lv.${prog.level}</span>
                          <span class="status-badge badge-ok">宿舍休整中</span>
                        </div>
                        <div class="cc-stat-sub">士气 ${r.morale}/100 · 好感 ${r.affinity} · ${escapeHtml(ent?.meta?.personalityCombo?.comboLabel || '')}</div>
                      </div>
                    </div>
                    <button type="button" class="btn-secondary uikit-touch-target" data-dorm-remove="${escapeHtml(r.id)}">移出宿舍</button>
                  </div>
                `;
                })
                .join('')
        }
      </div>
    `;
    root.appendChild(bedsCard);

    // Full Fleet Roster Card
    const rosterCard = document.createElement('section');
    rosterCard.className = 'surface-card lab-stack-sm';
    rosterCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">港区全员舰娘花名册（${roster.length} 名）</h2>
        <span class="status-badge badge-muted">点头像直达角色卡</span>
      </div>
      <div class="lab-stack-sm" id="dorm-full-roster">
        ${roster
          .map((c) => {
            const inDorm = resSet.has(c.id);
            const prog = statRules.ensureShipProgression(c);
            const avatarUrl = avatars.get(c.id) || '';
            const status = buildings.getCharacterGlobalStatus(c.id, {
              formation,
              expeditions,
              interaction,
            });
            const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(c.id, 'maxHp', { round: 'round' }).final));
            const curHp = Math.min(effMaxHp, Math.round(Number(c.stats.hp ?? effMaxHp)));
            return `
              <div class="lab-slot-card dorm-roster-row" data-dorm-roster-char="${escapeHtml(c.id)}">
                <div class="dorm-row-main">
                  <button type="button" class="avatar-jump-btn" data-jump-char-card="${escapeHtml(c.id)}" title="点击头像直达精修角色卡">
                    <img class="dorm-mini-avatar" src="${avatarUrl}" alt="${escapeHtml(c.name)}">
                  </button>
                  <div class="dorm-row-info">
                    <div class="dorm-row-title">
                      <span class="ship-class-ico">${getShipClassSvg(c.meta?.shipType, { size: 16 })}</span>
                      <strong>${escapeHtml(c.name)}</strong>
                      <span class="status-badge ship-lv-badge">Lv.${prog.level}</span>
                      ${status.badges
                        .map((b) => `<span class="status-badge badge-${escapeHtml(b.tone)}">${escapeHtml(b.label)}</span>`)
                        .join('')}
                    </div>
                    <div class="cc-stat-sub">
                      ${escapeHtml(c.meta?.shipType || '驱逐舰')} · HP ${curHp}/${effMaxHp} · 士气 ${Math.round(Number(c.stats.morale ?? 70))} · 好感 ${Math.round(Number(c.stats.affinity ?? 0))}
                    </div>
                  </div>
                </div>
                <div class="lab-btn-grid">
                  <button type="button" class="btn-secondary uikit-touch-target" data-jump-char-card="${escapeHtml(c.id)}">查看角色卡</button>
                  ${
                    inDorm
                      ? `<button type="button" class="btn-secondary uikit-touch-target" data-dorm-remove="${escapeHtml(c.id)}">移出宿舍</button>`
                      : `<button type="button" class="btn-primary uikit-touch-target" data-dorm-add="${escapeHtml(c.id)}" ${dorm.residents.length >= dorm.capacity ? 'disabled' : ''}>入住宿舍</button>`
                  }
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
    root.appendChild(rosterCard);

    root.querySelectorAll('[data-jump-char-card]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openCharacterCardById(btn.getAttribute('data-jump-char-card'), state.context);
      });
    });

    root.querySelectorAll('[data-dorm-add]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await buildings.assignDormResident(btn.getAttribute('data-dorm-add'));
          uiKit.showToast('已安排入住港区宿舍', 'ok');
          render();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '入住失败', 'warn');
        }
      });
    });

    root.querySelectorAll('[data-dorm-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await buildings.removeDormResident(btn.getAttribute('data-dorm-remove'));
        uiKit.showToast('已移出宿舍', 'info');
        render();
      });
    });

    state.container.appendChild(root);
  }

  return {
    id: 'port-dormitory',
    name: '舰娘宿舍',
    description: '独立全屏宿舍管理页：床位休整、离线回士气好感、全员花名册与点头像直达角色卡。',
    isSubpage: true,
    lockSwipe: true,
    mount(container, context) {
      state.container = container;
      state.context = context;
      state.avatarCache.clear();
      context.ui.setSwipeLocked(true);
      context.ui.setPlaceholder('宿舍休整备忘...');
      context.ui.setQuickActions([
        { id: 'dorm-back', label: '← 返回港区', onClick: () => context.modules.mount('port-hub', { transition: 'right' }) },
        { id: 'dorm-dock', label: '前往船坞整备', onClick: () => context.modules.mount('port-dockyard', { transition: 'left' }) },
      ]);
      state.unsubs = [
        context.bus.on('buildings:updated', () => render()),
        context.bus.on('resources:changed', () => render()),
      ];
      render();
    },
    unmount() {
      state.unsubs.forEach((u) => { try { u(); } catch {} });
      state.unsubs = [];
      state.container = null;
      state.context = null;
    },
  };
}

// ============================================================
// 2. Dedicated Full-Screen Page: 船坞整备 (`port-dockyard`)
// ============================================================

function createDockyardModule() {
  const state = { container: null, context: null, unsubs: [], timer: null, avatarCache: new Map() };

  async function render() {
    if (!state.container || !state.context) return;
    const { buildings, entities, resources, assets, rootStorage, modules, uiKit } = state.context;
    const dock = buildings.getDockyardState();
    const chars = getAllCharacters(entities);
    const inDockIds = new Set(dock.queue.map((q) => q.characterId));
    const repairable = chars.filter((c) => !inDockIds.has(c.id));

    const avatars = new Map();
    for (const c of chars) {
      avatars.set(c.id, await resolveAvatar(assets, state.avatarCache, c));
    }

    state.container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'subpage-root';
    root.id = 'page-port-dockyard';

    root.appendChild(
      uiKit.createSubpageHeader({
        title: `船坞整备 · Lv.${dock.level}`,
        subtitle: `渠位 ${dock.queue.length}/${dock.capacity} · 离线维修队列 & 新舰建造`,
        modules,
        resources,
        resourceKeys: ['steel', 'bauxite', 'silver'],
        id: 'dock-subpage-header',
      })
    );

    // 1. Active Repair Bays Queue
    const queueCard = document.createElement('section');
    queueCard.className = 'surface-card lab-stack-sm';
    queueCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">船坞维修渠位（${dock.queue.length}/${dock.capacity}）</h2>
        <button type="button" id="btn-dock-expand" class="btn-secondary uikit-touch-target" style="padding:0 12px;" ${dock.canExpand ? '' : 'disabled'}>
          ${dock.canExpand ? '扩建渠位 +1' : '已满渠位'}
        </button>
      </div>
      ${
        dock.queue.length === 0
          ? '<p class="muted-text">当前所有维修渠位空闲。</p>'
          : dock.queue
              .map(
                (job) => `
              <div class="lab-slot-card" data-dock-job="${escapeHtml(job.characterId)}">
                <div class="lab-slot-head">
                  <strong>${escapeHtml(job.characterName)}</strong>
                  <span class="status-badge ${job.ready ? 'badge-ok' : 'badge-warn'}">
                    ${job.ready ? '维修完工可出渠' : `剩余 ${formatDurationZh(job.remainingSec)}`}
                  </span>
                </div>
                <div class="lab-btn-grid">
                  ${
                    job.ready
                      ? `<button type="button" class="btn-primary uikit-touch-target" data-dock-complete="${escapeHtml(job.characterId)}">完成出渠</button>`
                      : `<button type="button" class="btn-secondary uikit-touch-target" data-dock-fast="${escapeHtml(job.characterId)}">快速修复（损管/40银）</button>`
                  }
                </div>
              </div>
            `
              )
              .join('')
      }
    `;

    queueCard.querySelector('#btn-dock-expand').addEventListener('click', async () => {
      try {
        const next = await buildings.expandDockyard();
        uiKit.showToast(`船坞已扩建至 Lv.${next.level}（${next.capacity} 渠位）`, 'ok');
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '扩建失败', 'warn');
      }
    });

    queueCard.querySelectorAll('[data-dock-complete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await buildings.completeDockRepair(btn.getAttribute('data-dock-complete'));
          await persistCharacterRoster({ storage: rootStorage, entities });
          uiKit.showToast(`「${res.characterName}」已满血出渠！`, 'ok');
          render();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '出渠失败', 'warn');
        }
      });
    });

    queueCard.querySelectorAll('[data-dock-fast]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await buildings.completeDockRepair(btn.getAttribute('data-dock-fast'), { fastRepair: true });
          await persistCharacterRoster({ storage: rootStorage, entities });
          uiKit.showToast(`「${res.characterName}」快速修复完成（${res.fastMethod}）`, 'ok');
          render();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '快速修复失败', 'warn');
        }
      });
    });
    root.appendChild(queueCard);

    // 2. Repair / Maintenance Roster
    const repairCard = document.createElement('section');
    repairCard.className = 'surface-card lab-stack-sm';
    repairCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">舰队入渠维修与保养</h2>
        <span class="status-badge badge-muted">点头像进角色卡</span>
      </div>
      <div class="lab-stack-sm" id="dock-repair-list">
        ${repairable
          .map((c) => {
            const plan = buildings.computeDockRepairPlan(c.id);
            const avatarUrl = avatars.get(c.id) || '';
            return `
            <div class="lab-slot-card dorm-roster-row">
              <div class="dorm-row-main">
                <button type="button" class="avatar-jump-btn" data-jump-char-card="${escapeHtml(c.id)}">
                  <img class="dorm-mini-avatar" src="${avatarUrl}" alt="${escapeHtml(c.name)}">
                </button>
                <div class="dorm-row-info">
                  <div class="dorm-row-title">
                    <span class="ship-class-ico">${getShipClassSvg(c.meta?.shipType, { size: 16 })}</span>
                    <strong>${escapeHtml(c.name)}</strong>
                    <span class="status-badge ${plan.missingHp > 0 ? 'badge-danger' : 'badge-ok'}">
                      ${plan.missingHp > 0 ? `损血 -${plan.missingHp}` : '满血完好'}
                    </span>
                  </div>
                  <div class="cc-stat-sub">耗时 ${plan.durationText} · 消耗：${escapeHtml(formatCostInline(plan.cost, resources))}</div>
                </div>
              </div>
              <button type="button" class="${plan.missingHp > 0 ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-dock-start="${escapeHtml(c.id)}" ${dock.queue.length >= dock.capacity ? 'disabled' : ''}>
                ${plan.isMaintenanceOnly ? '预防性保养入渠' : '立即入渠维修'}
              </button>
            </div>
          `;
          })
          .join('')}
      </div>
    `;

    repairCard.querySelectorAll('[data-jump-char-card]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openCharacterCardById(btn.getAttribute('data-jump-char-card'), state.context);
      });
    });

    repairCard.querySelectorAll('[data-dock-start]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const job = await buildings.startDockRepair(btn.getAttribute('data-dock-start'));
          uiKit.showToast(`「${job.characterName}」已入渠维修（${formatDurationZh(job.durationSec)}）`, 'ok');
          render();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '入渠失败', 'warn');
        }
      });
    });
    root.appendChild(repairCard);

    // 3. New Shipgirl Construction Desk (Same-Ship Different-Personality!)
    const buildCard = document.createElement('section');
    buildCard.className = 'surface-card lab-stack-sm';
    buildCard.id = 'dock-construct-card';
    buildCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">新舰建造登记台</h2>
        <button type="button" id="btn-dock-open-free-build" class="btn-primary uikit-touch-target" style="padding:0 12px; min-height:34px; font-size:12px;">
          自由配方建造（即时出坞）
        </button>
      </div>
      <p class="muted-text" style="font-size:12px;">
        上方「自由配方建造」支持 30~600 四项资源滑块、8 舰种实时概率与重复舰自动转化「改造核心」；下方可手动定向登记自定义舰娘。
      </p>
      <div class="lab-kv-grid">
        <input id="dock-new-name" class="form-input" type="text" placeholder="新舰名称（如：驱逐新锐号）">
        <select id="dock-new-type" class="form-input">
          ${SHIP_TYPE_PRESETS.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
        </select>
      </div>
      <button type="button" id="btn-dock-construct" class="btn-secondary uikit-touch-target">定向命名登记入港</button>
    `;

    buildCard.querySelector('#btn-dock-open-free-build')?.addEventListener('click', () => {
      openShipConstructionModal(state.context, { onConstructed: () => render() });
    });

    buildCard.querySelector('#btn-dock-construct').addEventListener('click', async () => {
      const name = buildCard.querySelector('#dock-new-name').value.trim();
      const shipType = buildCard.querySelector('#dock-new-type').value;
      if (!name) {
        uiKit.showToast('请输入新舰名称', 'warn');
        return;
      }
      try {
        const entity = await buildings.constructShip({ name, shipType });
        await persistCharacterRoster({ storage: rootStorage, entities });
        const combo = entity?.meta?.personalityCombo?.comboLabel || '';
        uiKit.showToast(`建造完成！「${name}」（${shipType}${combo ? ` · ${combo}` : ''}）已入港`, 'ok');
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '建造失败', 'warn');
      }
    });
    root.appendChild(buildCard);

    state.container.appendChild(root);
  }

  return {
    id: 'port-dockyard',
    name: '船坞整备',
    description: '独立全屏船坞页：多渠位离线维修队列、快速修复与新舰建造登记台。',
    isSubpage: true,
    lockSwipe: true,
    mount(container, context) {
      state.container = container;
      state.context = context;
      state.avatarCache.clear();
      context.ui.setSwipeLocked(true);
      context.ui.setPlaceholder('船坞整备记录...');
      context.ui.setQuickActions([
        { id: 'dock-back', label: '← 返回港区', onClick: () => context.modules.mount('port-hub', { transition: 'right' }) },
        { id: 'dock-sortie', label: '前往出征海图', onClick: () => context.modules.mount('sortie-console', { transition: 'left' }) },
      ]);
      state.unsubs = [
        context.bus.on('buildings:updated', () => render()),
        context.bus.on('resources:changed', () => render()),
      ];
      state.timer = setInterval(() => {
        if (state.context?.buildings?.getDockyardState().queue.length > 0) {
          render();
        }
      }, 15000);
      render();
    },
    unmount() {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      state.unsubs.forEach((u) => { try { u(); } catch {} });
      state.unsubs = [];
      state.container = null;
      state.context = null;
    },
  };
}

// ============================================================
// 3. Dedicated Full-Screen Page: 舰队编成 (`port-formation`)
// ============================================================

function createFormationModule() {
  const state = {
    container: null,
    context: null,
    unsubs: [],
    avatarCache: new Map(),
    selectedCellIndex: null,
  };

  async function render() {
    if (!state.container || !state.context) return;
    const { formation, entities, resources, assets, rootStorage, modules, uiKit } = state.context;
    const fState = formation.getState();
    const allFormations = formation.listFormations();
    const summary = fState.summary;
    const costInfo = summary.staggeredStepCost || formation.computeStaggeredStepCost();
    const gridCells = fState.gridCells || formation.getGridSlots();
    const allChars = getAllCharacters(entities);
    const gridMap = fState.gridMap || {};
    const candidates = allChars.filter((c) => !gridMap[c.id]);

    const avatars = new Map();
    for (const c of allChars) {
      avatars.set(c.id, await resolveAvatar(assets, state.avatarCache, c));
    }

    const selIdx = state.selectedCellIndex;
    const selectedCell =
      Number.isInteger(selIdx) && selIdx >= 0 && selIdx < gridCells.length ? gridCells[selIdx] : null;

    state.container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'subpage-root';
    root.id = 'page-port-formation';

    root.appendChild(
      uiKit.createSubpageHeader({
        title: '3×4 自由排阵编队',
        subtitle: `统率上限 ${fState.count}/${fState.cap} 舰 · ${summary.formationName}`,
        modules,
        resources,
        resourceKeys: [],
        id: 'formation-subpage-header',
      })
    );

    // 1. Upper Section: 3×4 Tactical Ship-Class Symbol Formation Board + One-Tap Presets
    const boardCard = document.createElement('section');
    boardCard.className = 'surface-card lab-stack-sm form-board-card';
    boardCard.id = 'formation-board-card';

    const rowsHtml = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      const cellsHtml = [];
      for (let c = 0; c < GRID_COLS; c++) {
        const idx = r * GRID_COLS + c;
        const cell = gridCells[idx];
        const m = cell?.member || null;
        const isSel = selIdx === idx;
        if (m) {
          const hpPct = Math.round((Math.max(0, m.hp) / Math.max(1, m.maxHp)) * 100);
          cellsHtml.push(`
            <button type="button" class="tac-grid-cell is-occupied is-ally ${isSel ? 'is-selected' : ''} ${m.isFlagship ? 'is-flagship' : ''}" data-grid-cell="${idx}" title="${escapeHtml(m.name)}（${escapeHtml(cell.rowLabel)}）">
              <span class="tac-cell-no">${m.isFlagship ? '★' : ''}${escapeHtml(m.slotCode)}</span>
              ${getTacticalGridSymbolSvg(m.classCode, { side: 'ally', size: 28 })}
              <span class="tac-cell-mini-name">${escapeHtml(m.name.slice(0, 4))}</span>
              <span class="tac-cell-hp"><span class="tac-cell-hp-fill ${hpPct < 25 ? 'is-danger' : ''}" style="width:${hpPct}%"></span></span>
            </button>
          `);
        } else {
          cellsHtml.push(`
            <button type="button" class="tac-grid-cell is-empty ${isSel ? 'is-selected-empty' : ''}" data-grid-cell="${idx}" aria-label="${escapeHtml(GRID_ROW_LABELS[r])} 第${c + 1}列空位">
              <span class="tac-radar-dot" aria-hidden="true"></span>
            </button>
          `);
        }
      }
      rowsHtml.push(`
        <div class="tac-grid-row" data-grid-row="${r}">
          <span class="tac-row-label">${escapeHtml(GRID_ROW_LABELS[r])}</span>
          <div class="tac-grid-row-cells">${cellsHtml.join('')}</div>
        </div>
      `);
    }

    const hintText = selectedCell
      ? selectedCell.member
        ? `已选中 [${selectedCell.member.slotCode}] ${selectedCell.member.name}（${selectedCell.rowLabel}）：点任意格可移动/互换站位，再点自身或下方按钮可撤下`
        : `已选中 ${selectedCell.rowLabel}空位：请点击下方可用舰娘直接部署到此格`
      : '点空位部署舰娘 · 点两格互换站位 · 点已部署单位可移位或撤下';

    const quickPresets = [
      { id: 'line_ahead', label: '单纵阵' },
      { id: 'double_line', label: '复纵阵' },
      { id: 'diamond', label: '轮型防空阵' },
    ];
    const extraPresets = allFormations.filter((f) => !quickPresets.some((q) => q.id === f.id));

    boardCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">3×4 舰种战术排阵盘</h2>
        <span class="status-badge badge-ok" id="form-staggered-badge">单步 油${costInfo.fuel} / 弹${costInfo.ammo}</span>
      </div>

      <div class="tac-preset-bar" id="formation-preset-bar">
        ${quickPresets
          .map(
            (p) => `
          <button type="button" class="${p.id === fState.formationId ? 'btn-primary' : 'btn-secondary'} tac-preset-btn" data-preset-arrange="${p.id}">
            ${escapeHtml(p.label)}
          </button>
        `
          )
          .join('')}
        ${extraPresets
          .map(
            (p) => `
          <button type="button" class="${p.id === fState.formationId ? 'btn-primary' : 'btn-secondary'} tac-preset-btn is-compact" data-preset-arrange="${escapeHtml(p.id)}">
            ${escapeHtml(p.name)}
          </button>
        `
          )
          .join('')}
      </div>

      <div class="tac-radar-board is-editor-board" id="formation-grid-3x4" data-no-swipe="true">
        <div class="tac-board-axis-hint">▲ 接敌海面方向（前排近距突击 · 后排战列/航母远程压制）</div>
        ${rowsHtml.join('')}
      </div>

      <div class="formation-live-eval-bar" id="formation-live-eval-bar" aria-label="编队实时评估条">
        <div class="form-eval-item">
          <span class="form-eval-k">阶梯单步消耗</span>
          <strong class="form-eval-v">油 ${costInfo.fuel} / 弹 ${costInfo.ammo}</strong>
        </div>
        <div class="form-eval-item">
          <span class="form-eval-k">全队总侦查</span>
          <strong class="form-eval-v">${summary.effective.recon}</strong>
        </div>
        <div class="form-eval-item">
          <span class="form-eval-k">全队总防空</span>
          <strong class="form-eval-v">${summary.effective.aa}</strong>
        </div>
      </div>

      <div class="tac-board-hint ${selectedCell ? 'is-active' : ''}" id="formation-grid-hint">${escapeHtml(hintText)}</div>

      ${
        selectedCell?.member
          ? `
        <div class="tac-selected-bar" id="formation-selected-actions">
          <div class="tac-selected-info">
            <strong>[${escapeHtml(selectedCell.member.slotCode)}] ${escapeHtml(selectedCell.member.name)}</strong>
            <span class="status-badge badge-muted">${escapeHtml(selectedCell.rowLabel)} · ${escapeHtml(selectedCell.member.classCode)}</span>
          </div>
          <div class="tac-selected-btns">
            ${
              !selectedCell.member.isFlagship
                ? `<button type="button" class="btn-secondary tac-mini-act" id="btn-sel-flagship">设为旗舰</button>`
                : ''
            }
            <button type="button" class="btn-secondary tac-mini-act" id="btn-sel-card">角色卡</button>
            <button type="button" class="btn-danger tac-mini-act" id="btn-sel-remove">撤下</button>
          </div>
        </div>
      `
          : ''
      }

      <div class="port-gear-summary">
        <span class="ns-chip">火力 ${summary.effective.firepower}</span>
        <span class="ns-chip">雷击 ${summary.effective.torpedo}</span>
        <span class="ns-chip">机动 ${summary.effective.evasion}</span>
        <span class="ns-chip">防空 ${summary.effective.aa}</span>
        <span class="ns-chip">反潜 ${summary.effective.asw}</span>
        <span class="ns-chip">侦查 ${summary.effective.recon}</span>
      </div>

      <div class="lab-btn-grid">
        <button type="button" id="btn-form-autofill" class="btn-secondary uikit-touch-target">一键补满席位</button>
        <button type="button" id="btn-form-auto-equip-fleet" class="btn-secondary uikit-touch-target" ${summary.members.length === 0 ? 'disabled' : ''}>全队一键最优配装</button>
      </div>
      <button type="button" id="btn-form-goto-sortie" class="btn-primary uikit-touch-target">确认阵型 · 前往出征海图</button>
    `;

    // Cell tap interactions: click empty -> select/move; click two cells -> swap; double-tap occupied -> remove
    boardCard.querySelectorAll('[data-grid-cell]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.getAttribute('data-grid-cell'));
        const clickedCell = gridCells[idx];
        const prevIdx = state.selectedCellIndex;
        const prevCell = Number.isInteger(prevIdx) ? gridCells[prevIdx] : null;

        // Same cell clicked twice: if occupied, remove her cleanly; if empty, deselect
        if (prevIdx === idx) {
          if (clickedCell?.member) {
            const name = clickedCell.member.name;
            await formation.removeFromCell(idx);
            state.selectedCellIndex = null;
            uiKit.showToast(`已将「${name}」从阵型盘撤下`, 'info');
            render();
            return;
          }
          state.selectedCellIndex = null;
          render();
          return;
        }

        // Previous cell was an occupied ship -> swap/move to clicked cell!
        if (prevCell?.member) {
          await formation.swapGridCells(prevIdx, idx);
          state.selectedCellIndex = null;
          uiKit.showToast(
            clickedCell?.member
              ? `已互换「${prevCell.member.name}」与「${clickedCell.member.name}」站位`
              : `已移动「${prevCell.member.name}」至${GRID_ROW_LABELS[Math.floor(idx / GRID_COLS)]}`,
            'ok'
          );
          render();
          return;
        }

        // Previous cell was an empty target & clicked cell is occupied -> move clicked ship into that empty slot!
        if (prevCell && !prevCell.member && clickedCell?.member) {
          await formation.swapGridCells(idx, prevIdx);
          state.selectedCellIndex = null;
          uiKit.showToast(`已移动「${clickedCell.member.name}」至${prevCell.rowLabel}`, 'ok');
          render();
          return;
        }

        // Otherwise select this cell
        state.selectedCellIndex = idx;
        render();
      });
    });

    // Contextual selected ship buttons
    boardCard.querySelector('#btn-sel-flagship')?.addEventListener('click', async () => {
      if (!selectedCell?.member) return;
      await formation.setFlagship(selectedCell.member.id);
      uiKit.showToast(`已指派「${selectedCell.member.name}」担任旗舰`, 'ok');
      render();
    });
    boardCard.querySelector('#btn-sel-card')?.addEventListener('click', () => {
      if (!selectedCell?.member) return;
      openCharacterCardById(selectedCell.member.id, state.context);
    });
    boardCard.querySelector('#btn-sel-remove')?.addEventListener('click', async () => {
      if (!selectedCell?.member) return;
      const name = selectedCell.member.name;
      await formation.removeFromCell(selIdx);
      state.selectedCellIndex = null;
      uiKit.showToast(`已将「${name}」撤出编队`, 'info');
      render();
    });

    // One-tap preset buttons (单纵阵 / 复纵阵 / 轮型防空阵 / 警戒阵 / 梯形阵)
    boardCard.querySelectorAll('[data-preset-arrange]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const presetId = btn.getAttribute('data-preset-arrange');
        const next = await formation.applyGridPreset(presetId);
        state.selectedCellIndex = null;
        uiKit.showToast(`已一键排阵：${next.formation?.name || presetId}`, 'ok');
        render();
      });
    });

    boardCard.querySelector('#btn-form-autofill').addEventListener('click', async () => {
      const next = await formation.autoFillFleet();
      state.selectedCellIndex = null;
      uiKit.showToast(`已自动补满 ${next.count}/${next.cap} 席位`, 'ok');
      render();
    });

    boardCard.querySelector('#btn-form-auto-equip-fleet').addEventListener('click', async () => {
      try {
        const res = await formation.autoEquipFleet({ includeOutfit: true });
        await persistCharacterRoster({ storage: rootStorage, entities });
        uiKit.showToast(
          res.totalEquipped > 0
            ? `已按编号顺序为 ${res.fleetCount} 名舰娘自动配装 ${res.totalEquipped} 件最优装备！`
            : `当前编队 ${res.fleetCount} 名舰娘均已是仓库最优配装`,
          res.totalEquipped > 0 ? 'ok' : 'info'
        );
        render();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '全队自动配装失败', 'warn');
      }
    });

    boardCard.querySelector('#btn-form-goto-sortie').addEventListener('click', () => {
      if (modules.has('sortie-console')) modules.mount('sortie-console', { transition: 'left' });
    });

    root.appendChild(boardCard);

    // 2. Lower Section: Available Shipgirls Roster (Deployed + Candidates)
    const rosterCard = document.createElement('section');
    rosterCard.className = 'surface-card lab-stack-sm';
    rosterCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">可用舰娘名册（已部署 ${fState.count}/${fState.cap} · 候补 ${candidates.length}）</h2>
      </div>
      <div class="lab-stack-sm" id="formation-candidates-list">
        ${
          allChars.length === 0
            ? '<p class="muted-text">暂无舰娘，请前往船坞建造。</p>'
            : allChars
                .map((c) => {
                  const pos = gridMap[c.id] || null;
                  const check = pos ? { ok: true, reason: '' } : formation.canAddMember(c.id);
                  const avatarUrl = avatars.get(c.id) || '';
                  const prof = getShipClassProfile(c.meta?.shipType);
                  const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(c.id, 'maxHp', { round: 'round' }).final));
                  const curHp = Math.min(effMaxHp, Math.round(Number(c.stats.hp ?? effMaxHp)));
                  const targetEmptySelected = selectedCell && !selectedCell.member;
                  return `
                  <div class="lab-slot-card dorm-roster-row ${pos ? 'is-deployed-row' : ''}" data-roster-ship="${escapeHtml(c.id)}">
                    <div class="dorm-row-main">
                      <button type="button" class="avatar-jump-btn" data-jump-char-card="${escapeHtml(c.id)}" title="点击头像直达精修角色卡">
                        <img class="dorm-mini-avatar" src="${avatarUrl}" alt="${escapeHtml(c.name)}">
                      </button>
                      <div class="dorm-row-info">
                        <div class="dorm-row-title">
                          <span class="ship-class-ico">${getShipClassSvg(c.meta?.shipType, { size: 16 })}</span>
                          <strong>${escapeHtml(c.name)}</strong>
                          <span class="status-badge badge-muted">${escapeHtml(prof.code)}</span>
                          ${
                            pos
                              ? `<span class="status-badge badge-ok">${escapeHtml(pos.slotCode)}·${escapeHtml(pos.rowLabel)}</span>`
                              : ''
                          }
                        </div>
                        <div class="cc-stat-sub">
                          HP ${curHp}/${effMaxHp} · ${escapeHtml(pos ? '已在阵型盘执勤' : check.ok ? prof.roleSummary : check.reason)}
                        </div>
                      </div>
                    </div>
                    ${
                      pos
                        ? `<button type="button" class="btn-secondary uikit-touch-target" data-fleet-remove="${escapeHtml(c.id)}">撤下</button>`
                        : `<button type="button" class="btn-primary uikit-touch-target" data-fleet-deploy="${escapeHtml(c.id)}" ${
                            check.ok || (selectedCell?.member && !formation.isCharacterDispatched(c.id)) ? '' : 'disabled'
                          }>
                            ${targetEmptySelected ? `部署至${escapeHtml(selectedCell.rowLabel)}` : selectedCell?.member ? '替换站位' : check.ok ? '部署上阵' : '暂不可入队'}
                          </button>`
                    }
                  </div>
                `;
                })
                .join('')
        }
      </div>
    `;

    rosterCard.querySelectorAll('[data-jump-char-card]').forEach((btn) => {
      btn.addEventListener('click', () => openCharacterCardById(btn.getAttribute('data-jump-char-card'), state.context));
    });

    rosterCard.querySelectorAll('[data-fleet-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await formation.removeMember(btn.getAttribute('data-fleet-remove'));
        state.selectedCellIndex = null;
        uiKit.showToast('已撤出 3×4 阵型盘', 'info');
        render();
      });
    });

    rosterCard.querySelectorAll('[data-fleet-deploy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cid = btn.getAttribute('data-fleet-deploy');
        try {
          if (Number.isInteger(state.selectedCellIndex)) {
            await formation.deployToCell(cid, state.selectedCellIndex);
          } else {
            await formation.addMember(cid);
          }
          state.selectedCellIndex = null;
          uiKit.showToast('已部署至 3×4 阵型盘', 'ok');
          render();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '部署失败', 'warn');
        }
      });
    });

    root.appendChild(rosterCard);
    state.container.appendChild(root);
  }

  return {
    id: 'port-formation',
    name: '舰队编成',
    description: '3×4 舰种符号自由排阵编队：点格部署/互换/撤下、单纵/复纵/轮型防空一键排阵与全队最优配装。',
    isSubpage: true,
    lockSwipe: true,
    mount(container, context) {
      state.container = container;
      state.context = context;
      state.selectedCellIndex = null;
      state.avatarCache.clear();
      context.ui.setSwipeLocked(true);
      context.ui.setStageMode?.('facility');
      context.ui.setPlaceholder('舰队编成备忘...');
      context.ui.setQuickActions([]);
      state.unsubs = [
        context.bus.on('formation:changed', () => render()),
        context.bus.on('commander:updated', () => render()),
      ];
      render();
    },
    unmount() {
      state.unsubs.forEach((u) => {
        try {
          u();
        } catch {}
      });
      state.unsubs = [];
      state.selectedCellIndex = null;
      state.container = null;
      state.context = null;
    },
  };
}

// ============================================================
// 4. Dedicated Full-Screen Page: 远征派遣 (`port-expedition`)
// ============================================================

function createExpeditionModule() {
  const state = { container: null, context: null, unsubs: [], timer: null, selectedIds: new Set() };

  function render() {
    if (!state.container || !state.context) return;
    const { expeditions, entities, formation, inventory, commander, resources, modules, uiKit } = state.context;
    const activeRuns = expeditions.listActiveRuns();
    const missions = expeditions.listMissions();
    const fleetIds = new Set(formation ? formation.getMemberIds() : []);
    const eligible = getAllCharacters(entities).filter(
      (c) =>
        !expeditions.isCharacterDispatched(c.id) &&
        !fleetIds.has(c.id) &&
        inventory.checkSeaworthiness(c.id).seaworthy
    );
    const mult = commander ? commander.getExpeditionRewardMultiplier() : 1.0;

    // Clean stale selections
    const eligibleIds = new Set(eligible.map((c) => c.id));
    for (const id of Array.from(state.selectedIds)) {
      if (!eligibleIds.has(id)) state.selectedIds.delete(id);
    }

    state.container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'subpage-root';
    root.id = 'page-port-expedition';

    root.appendChild(
      uiKit.createSubpageHeader({
        title: '远征派遣中心',
        subtitle: `调度收益 x${mult.toFixed(2)} · 离线真实计时`,
        modules,
        resources,
        resourceKeys: ['fuel', 'silver', 'gold'],
        id: 'exp-subpage-header',
      })
    );

    // 1. Active Expedition Runs
    const activeCard = document.createElement('section');
    activeCard.className = 'surface-card lab-stack-sm';
    activeCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">进行中的远征（${activeRuns.length} 支）</h2>
      </div>
      ${
        activeRuns.length === 0
          ? '<p class="muted-text">当前没有执行中的远征舰队。</p>'
          : activeRuns
              .map(
                (run) => `
              <div class="lab-slot-card" data-exp-run="${escapeHtml(run.id)}">
                <div class="lab-slot-head">
                  <strong>${escapeHtml(run.missionName)}</strong>
                  <span class="status-badge ${run.ready ? 'badge-ok' : 'badge-warn'}">
                    ${run.ready ? '已归港可领取' : `剩余 ${formatDurationZh(run.remainingSec)}`}
                  </span>
                </div>
                <div class="cc-stat-sub">派遣舰娘：${escapeHtml((run.memberNames || []).join('、'))}</div>
                <div class="lab-btn-grid">
                  ${
                    run.ready
                      ? `<button type="button" class="btn-primary uikit-touch-target" data-exp-claim="${escapeHtml(run.id)}">领取远征奖励</button>`
                      : `<button type="button" class="btn-secondary uikit-touch-target" data-exp-recall="${escapeHtml(run.id)}">提前召回</button>`
                  }
                </div>
              </div>
            `
              )
              .join('')
      }
    `;

    activeCard.querySelectorAll('[data-exp-claim]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await expeditions.claim(btn.getAttribute('data-exp-claim'));
          uiKit.showToast(`远征「${res.missionName}」归港成功！指挥官 EXP +${res.commanderExp}`, 'ok');
          render();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '领取失败', 'warn');
        }
      });
    });

    activeCard.querySelectorAll('[data-exp-recall]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await expeditions.recall(btn.getAttribute('data-exp-recall'));
        uiKit.showToast('已召回远征编队', 'info');
        render();
      });
    });
    root.appendChild(activeCard);

    // 2. Eligible Ship Selector
    const pickCard = document.createElement('section');
    pickCard.className = 'surface-card lab-stack-sm';
    pickCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">选择派遣空闲舰娘（已选 ${state.selectedIds.size} 名）</h2>
      </div>
      <div class="port-gear-summary" id="exp-eligible-chips">
        ${
          eligible.length === 0
            ? '<p class="muted-text">当前暂无空闲适航舰娘（请先在舰队编成腾出空闲舰娘）。</p>'
            : eligible
                .map(
                  (c) => `
                <button type="button" class="${state.selectedIds.has(c.id) ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-exp-pick="${escapeHtml(c.id)}">
                  ${escapeHtml(c.name)}
                </button>
              `
                )
                .join('')
        }
      </div>
    `;
    pickCard.querySelectorAll('[data-exp-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-exp-pick');
        if (state.selectedIds.has(id)) state.selectedIds.delete(id);
        else state.selectedIds.add(id);
        render();
      });
    });
    root.appendChild(pickCard);

    // 3. Mission Catalog
    const catalogCard = document.createElement('section');
    catalogCard.className = 'surface-card lab-stack-sm';
    catalogCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">可派遣远征任务（${missions.length} 项）</h2>
      </div>
      <div class="lab-stack-sm">
        ${missions
          .map(
            (m) => `
          <div class="lab-slot-card">
            <div class="lab-slot-head">
              <strong>${escapeHtml(m.name)}</strong>
              <span class="status-badge badge-muted">${formatDurationZh(m.durationSec)} · 需≥${m.minShips}舰</span>
            </div>
            <p class="muted-text" style="font-size:12px; margin:0;">${escapeHtml(m.description || '')}</p>
            <div class="cc-stat-sub">基础收益：${escapeHtml(formatCostInline(m.baseRewards, resources))} · 指挥官 EXP +${m.commanderExp}</div>
            <button type="button" class="btn-primary uikit-touch-target" data-exp-start="${escapeHtml(m.id)}" ${state.selectedIds.size < m.minShips ? 'disabled' : ''}>
              派遣出航（已选 ${state.selectedIds.size}/${m.minShips}）
            </button>
          </div>
        `
          )
          .join('')}
      </div>
    `;

    catalogCard.querySelectorAll('[data-exp-start]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const run = await expeditions.dispatch(btn.getAttribute('data-exp-start'), Array.from(state.selectedIds));
          state.selectedIds.clear();
          uiKit.showToast(`远征「${run.missionName}」已启航！`, 'ok');
          render();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '派遣失败', 'warn');
        }
      });
    });
    root.appendChild(catalogCard);

    state.container.appendChild(root);
  }

  return {
    id: 'port-expedition',
    name: '远征派遣',
    description: '独立全屏远征派遣中心：离线时间戳倒计时、后勤调度收益加成与舰娘派遣。',
    isSubpage: true,
    lockSwipe: true,
    mount(container, context) {
      state.container = container;
      state.context = context;
      state.selectedIds.clear();
      context.ui.setSwipeLocked(true);
      context.ui.setPlaceholder('远征调度备忘...');
      context.ui.setQuickActions([
        { id: 'exp-back', label: '← 返回港区', onClick: () => context.modules.mount('port-hub', { transition: 'right' }) },
      ]);
      state.unsubs = [
        context.bus.on('expedition:updated', () => render()),
        context.bus.on('resources:changed', () => render()),
      ];
      state.timer = setInterval(() => {
        if (state.context?.expeditions?.listActiveRuns().length > 0) render();
      }, 15000);
      render();
    },
    unmount() {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      state.unsubs.forEach((u) => { try { u(); } catch {} });
      state.unsubs = [];
      state.container = null;
      state.context = null;
    },
  };
}

/**
 * Centered Frosted-Glass Floating Dockyard Repair & Construction Tactical Modal.
 */
export function openDockyardTacticalModal(context) {
  if (!context) return null;
  const { buildings, entities, resources, rootStorage, modules, uiKit } = context;
  const openFn = typeof uiKit.openTacticalModal === 'function' ? uiKit.openTacticalModal : uiKit.openModal;

  return openFn({
    title: '船坞整备 · 入渠维修浮窗',
    subtitle: '点击舰娘快速入渠维修、加速出渠或建造新舰，点击遮罩关闭',
    renderContent: (body, close) => {
      const renderInner = () => {
        const dock = buildings.getDockyardState();
        const chars = getAllCharacters(entities);
        const inDockIds = new Set(dock.queue.map((q) => q.characterId));
        const repairable = chars
          .filter((c) => !inDockIds.has(c.id))
          .sort((a, b) => {
            const pa = buildings.computeDockRepairPlan(a.id);
            const pb = buildings.computeDockRepairPlan(b.id);
            return pb.missingHp - pa.missingHp;
          });

        body.innerHTML = `
          <div class="module-stack">
            <div class="surface-card lab-stack-sm" style="background:var(--surface-alt);">
              <div class="section-header-row" style="margin-bottom:0;">
                <strong style="font-size:13.5px;">维修渠位 · Lv.${dock.level}（${dock.queue.length}/${dock.capacity}）</strong>
                <button type="button" id="btn-tm-dock-expand" class="btn-secondary uikit-touch-target" style="padding:0 10px; min-height:32px; font-size:12px;" ${dock.canExpand ? '' : 'disabled'}>
                  ${dock.canExpand ? '扩建 +1 渠位' : '已满渠位'}
                </button>
              </div>
              ${
                dock.queue.length === 0
                  ? '<p class="muted-text" style="font-size:12px; margin:0;">当前维修渠位空闲，可从下方选择受损舰娘入渠。</p>'
                  : dock.queue
                      .map(
                        (job) => `
                    <div class="lab-slot-card" style="padding:8px 10px;">
                      <div class="lab-slot-head">
                        <strong>${escapeHtml(job.characterName)}</strong>
                        <span class="status-badge ${job.ready ? 'badge-ok' : 'badge-warn'}">
                          ${job.ready ? '完工可出渠' : `剩余 ${formatDurationZh(job.remainingSec)}`}
                        </span>
                      </div>
                      ${
                        job.ready
                          ? `<button type="button" class="btn-primary uikit-touch-target" style="min-height:36px;" data-tm-dock-complete="${escapeHtml(job.characterId)}">完成出渠</button>`
                          : `<button type="button" class="btn-secondary uikit-touch-target" style="min-height:36px;" data-tm-dock-fast="${escapeHtml(job.characterId)}">快速修复（损管/40银）</button>`
                      }
                    </div>
                  `
                      )
                      .join('')
              }
            </div>

            <div class="surface-card lab-stack-sm">
              <div class="section-header-row" style="margin-bottom:0;">
                <strong style="font-size:13.5px;">舰队入渠列表（优先显示受损舰娘）</strong>
                <span class="status-badge badge-muted">${repairable.length} 名</span>
              </div>
              <div class="lab-stack-sm">
                ${repairable
                  .map((c) => {
                    const plan = buildings.computeDockRepairPlan(c.id);
                    return `
                    <div class="cc-slot-row" style="padding:8px 10px;">
                      <div class="cc-slot-info">
                        <span class="cc-slot-item-name">
                          ${escapeHtml(c.name)}
                          <span class="status-badge ${plan.missingHp > 0 ? 'badge-danger' : 'badge-ok'}" style="margin-left:4px;">
                            ${plan.missingHp > 0 ? `损血 -${plan.missingHp}` : '满血'}
                          </span>
                        </span>
                        <span class="cc-slot-label">耗时 ${plan.durationText} · ${escapeHtml(formatCostInline(plan.cost, resources))}</span>
                      </div>
                      <button type="button" class="${plan.missingHp > 0 ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" style="padding:0 12px; min-height:34px; font-size:12px;" data-tm-dock-start="${escapeHtml(c.id)}" ${dock.queue.length >= dock.capacity ? 'disabled' : ''}>
                        ${plan.isMaintenanceOnly ? '保养入渠' : '立即入渠'}
                      </button>
                    </div>
                  `;
                  })
                  .join('')}
              </div>
            </div>

            <div class="lab-btn-grid">
              <button type="button" id="btn-tm-dock-free-build" class="btn-primary uikit-touch-target">自由配方舰船建造</button>
              <button type="button" id="btn-tm-dock-fullpage" class="btn-secondary uikit-touch-target">完整船坞页</button>
            </div>
            <button type="button" id="btn-tm-dock-close" class="btn-secondary uikit-touch-target">关闭浮窗</button>
          </div>
        `;

        body.querySelector('#btn-tm-dock-expand')?.addEventListener('click', async () => {
          try {
            const next = await buildings.expandDockyard();
            uiKit.showToast(`船坞已扩建至 Lv.${next.level}（${next.capacity} 渠位）`, 'ok');
            renderInner();
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '扩建失败', 'warn');
          }
        });

        body.querySelectorAll('[data-tm-dock-complete]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            try {
              const res = await buildings.completeDockRepair(btn.getAttribute('data-tm-dock-complete'));
              await persistCharacterRoster({ storage: rootStorage, entities });
              uiKit.showToast(`「${res.characterName}」已满血出渠！`, 'ok');
              renderInner();
            } catch (err) {
              uiKit.showToast(err instanceof Error ? err.message : '出渠失败', 'warn');
            }
          });
        });

        body.querySelectorAll('[data-tm-dock-fast]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            try {
              const res = await buildings.completeDockRepair(btn.getAttribute('data-tm-dock-fast'), { fastRepair: true });
              await persistCharacterRoster({ storage: rootStorage, entities });
              uiKit.showToast(`「${res.characterName}」快速修复完成（${res.fastMethod}）`, 'ok');
              renderInner();
            } catch (err) {
              uiKit.showToast(err instanceof Error ? err.message : '快速修复失败', 'warn');
            }
          });
        });

        body.querySelectorAll('[data-tm-dock-start]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            try {
              const job = await buildings.startDockRepair(btn.getAttribute('data-tm-dock-start'));
              uiKit.showToast(`「${job.characterName}」已入渠维修（${formatDurationZh(job.durationSec)}）`, 'ok');
              renderInner();
            } catch (err) {
              uiKit.showToast(err instanceof Error ? err.message : '入渠失败', 'warn');
            }
          });
        });

        body.querySelector('#btn-tm-dock-free-build')?.addEventListener('click', () => {
          close();
          openShipConstructionModal(context);
        });
        body.querySelector('#btn-tm-dock-fullpage')?.addEventListener('click', () => {
          close();
          if (modules?.has('port-dockyard')) modules.mount('port-dockyard', { transition: 'left' });
        });
        body.querySelector('#btn-tm-dock-close')?.addEventListener('click', () => close());
      };

      renderInner();
    },
  });
}

/**
 * Centered Frosted-Glass Free-Recipe Instant Ship Construction Modal.
 * Features 4-resource sliders (30~600), recipe presets, live 8-class probability bars
 * (including boosted AR 维修舰 & AO 补给舰 formulas), zero wait time, and duplicate -> 改造核心 conversion.
 */
export function openShipConstructionModal(context, { onConstructed = null } = {}) {
  if (!context) return null;
  const { buildings, entities, resources, inventory, rootStorage, uiKit } = context;
  const openFn = typeof uiKit.openTacticalModal === 'function' ? uiKit.openTacticalModal : uiKit.openModal;

  const recipe = {
    fuel: 240,
    ammo: 140,
    steel: 240,
    bauxite: 340,
    customName: '',
  };
  let lastResult = null;
  const SILVER_FEE = 60;

  return openFn({
    title: '自由配方舰船建造（零等待即时出坞）',
    subtitle: '自由调配 30~600 四项资源，实时查看 8 舰种概率；重复舰自动转化为「改造核心 + 礼物/银条」',
    wide: true,
    renderContent: (body, close) => {
      const renderInner = () => {
        const probs = computeConstructionProbabilities(recipe);
        const stock = {
          fuel: Math.floor(resources.get('fuel')?.amount ?? 0),
          ammo: Math.floor(resources.get('ammo')?.amount ?? 0),
          steel: Math.floor(resources.get('steel')?.amount ?? 0),
          bauxite: Math.floor(resources.get('bauxite')?.amount ?? 0),
          silver: Math.floor(resources.get('silver')?.amount ?? 0),
        };
        const canAfford =
          stock.fuel >= recipe.fuel &&
          stock.ammo >= recipe.ammo &&
          stock.steel >= recipe.steel &&
          stock.bauxite >= recipe.bauxite &&
          stock.silver >= SILVER_FEE;
        const coresOwned = inventory?.getRetrofitCores ? inventory.getRetrofitCores() : 0;

        body.innerHTML = `
          <div class="module-stack" id="free-construction-modal">
            <!-- Quick Recipe Presets -->
            <div class="surface-card lab-stack-sm" style="background:var(--surface-alt);">
              <div class="section-header-row" style="margin-bottom:0;">
                <strong style="font-size:13px;">快捷建造配方推荐</strong>
                <span class="status-badge badge-ok">改造核心库存 ${coresOwned}</span>
              </div>
              <div class="chip-row" id="build-preset-row">
                ${CONSTRUCTION_RECIPE_PRESETS.map(
                  (p) => `
                  <button type="button" class="preset-chip" data-build-preset="${escapeHtml(p.id)}">
                    ${escapeHtml(p.label)}
                  </button>
                `
                ).join('')}
              </div>
            </div>

            <!-- 4 Resource Sliders (30 ~ 600) -->
            <div class="surface-card lab-stack-sm">
              <div class="section-header-row" style="margin-bottom:0;">
                <strong style="font-size:13px;">四项资源投入（30 ~ 600）</strong>
                <span class="status-badge ${stock.silver >= SILVER_FEE ? 'badge-muted' : 'badge-danger'}">
                  建坞费 银条 ${SILVER_FEE}/${stock.silver}
                </span>
              </div>
              ${[
                { key: 'fuel', label: '燃油', stock: stock.fuel },
                { key: 'ammo', label: '弹药', stock: stock.ammo },
                { key: 'steel', label: '钢材', stock: stock.steel },
                { key: 'bauxite', label: '铝材', stock: stock.bauxite },
              ]
                .map(
                  (r) => `
                <div class="construction-slider-row">
                  <div class="construction-slider-head">
                    <label for="build-sl-${r.key}"><strong>${r.label}</strong></label>
                    <span class="${r.stock < recipe[r.key] ? 'stat-diff-inline-down' : 'muted-text'}" data-build-val="${r.key}">
                      投入 <strong>${recipe[r.key]}</strong> / 库存 ${r.stock}
                    </span>
                  </div>
                  <input id="build-sl-${r.key}" data-build-slider="${r.key}" type="range" min="30" max="600" step="10" value="${recipe[r.key]}" style="width:100%;">
                </div>
              `
                )
                .join('')}

              <div class="form-group" style="margin-top:4px;">
                <label class="form-label" for="build-custom-name">自定义新舰命名（留空则按舰种随机抽选名舰）</label>
                <input id="build-custom-name" class="form-input" type="text" placeholder="留空自动命名，或输入专属舰名..." value="${escapeHtml(recipe.customName)}">
              </div>
            </div>

            <!-- Live 8-Class Probability Bars -->
            <div class="surface-card lab-stack-sm">
              <div class="section-header-row" style="margin-bottom:0;">
                <strong style="font-size:13px;">实时舰种建造概率预估（含 AR 维修舰 / AO 补给舰）</strong>
              </div>
              <div class="construction-prob-grid" id="build-prob-grid">
                ${probs
                  .map((p) => {
                    const isSupport = p.shipClass === 'AR' || p.shipClass === 'AO';
                    return `
                  <div class="construction-prob-row ${isSupport ? 'is-support' : ''}">
                    <div class="construction-prob-label">
                      <span class="ship-class-ico">${getShipClassSvg(p.shipClass, { size: 15 })}</span>
                      <span>${escapeHtml(p.shipType)} (${escapeHtml(p.shipClass)})</span>
                      <strong>${p.pct.toFixed(1)}%</strong>
                    </div>
                    <div class="construction-prob-track">
                      <div class="construction-prob-fill ${isSupport ? 'is-support' : ''}" style="width:${Math.min(100, Math.max(2, p.pct * 1.4))}%"></div>
                    </div>
                  </div>
                `;
                  })
                  .join('')}
              </div>
            </div>

            ${
              lastResult
                ? `
              <div class="surface-card construction-result-card ${lastResult.isDuplicate ? 'is-duplicate' : 'is-new'}" id="build-result-card">
                ${
                  lastResult.isDuplicate
                    ? `
                  <div class="section-header-row" style="margin-bottom:4px;">
                    <strong>♻ 重复舰船自动转化 · ${escapeHtml(lastResult.shipName)}</strong>
                    <span class="status-badge badge-warn">${escapeHtml(lastResult.shipType)} (${escapeHtml(lastResult.classCode)})</span>
                  </div>
                  <p class="muted-text" style="font-size:12px; margin:0;">
                    港区已有该舰，自动转化为：<strong>改造核心 ×${lastResult.retrofitCoreGained}</strong>（累计 ${lastResult.retrofitCoresTotal}）、<strong>${escapeHtml(lastResult.giftName)} ×1</strong>、<strong>银条 +${lastResult.silverBonus}</strong>！
                  </p>
                `
                    : `
                  <div class="section-header-row" style="margin-bottom:4px;">
                    <strong>★ 建造成功！${escapeHtml(lastResult.shipName)} 已即时出坞</strong>
                    <span class="status-badge badge-ok">${escapeHtml(lastResult.shipType)} (${escapeHtml(lastResult.classCode)})</span>
                  </div>
                  <p class="muted-text" style="font-size:12px; margin:0;">
                    ${escapeHtml(lastResult.roleTag || '')} · 已自动配备基础适航核心组件${lastResult.classCode === 'AR' || lastResult.classCode === 'AO' ? '与后勤支援槽位' : ''}，随时可编队出征！
                  </p>
                  ${
                    lastResult.entity?.id
                      ? `<button type="button" id="btn-build-view-ship" class="btn-secondary uikit-touch-target" style="margin-top:6px;">查看「${escapeHtml(lastResult.shipName)}」角色档案</button>`
                      : ''
                  }
                `
                }
              </div>
            `
                : ''
            }

            <div class="lab-btn-grid">
              <button type="button" id="btn-do-free-construct" class="btn-primary uikit-touch-target" ${canAfford ? '' : 'disabled'}>
                ${canAfford ? `立即建造（消耗 银条 ${SILVER_FEE}）` : '资源或银条不足'}
              </button>
              <button type="button" id="btn-close-free-construct" class="btn-secondary uikit-touch-target">关闭船台</button>
            </div>
          </div>
        `;

        // Bind preset chips
        body.querySelectorAll('[data-build-preset]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const pid = btn.getAttribute('data-build-preset');
            const p = CONSTRUCTION_RECIPE_PRESETS.find((x) => x.id === pid);
            if (!p) return;
            recipe.fuel = p.fuel;
            recipe.ammo = p.ammo;
            recipe.steel = p.steel;
            recipe.bauxite = p.bauxite;
            renderInner();
          });
        });

        // Bind sliders without losing drag smoothness — update live probability grid & labels on input
        body.querySelectorAll('[data-build-slider]').forEach((sl) => {
          sl.addEventListener('input', () => {
            const key = sl.getAttribute('data-build-slider');
            recipe[key] = Number(sl.value) || 30;
            const valEl = body.querySelector(`[data-build-val="${key}"]`);
            if (valEl) {
              const curStock = stock[key] ?? 0;
              valEl.className = curStock < recipe[key] ? 'stat-diff-inline-down' : 'muted-text';
              valEl.innerHTML = `投入 <strong>${recipe[key]}</strong> / 库存 ${curStock}`;
            }
            const nextProbs = computeConstructionProbabilities(recipe);
            const probGrid = body.querySelector('#build-prob-grid');
            if (probGrid) {
              probGrid.innerHTML = nextProbs
                .map((p) => {
                  const isSupport = p.shipClass === 'AR' || p.shipClass === 'AO';
                  return `
                    <div class="construction-prob-row ${isSupport ? 'is-support' : ''}">
                      <div class="construction-prob-label">
                        <span class="ship-class-ico">${getShipClassSvg(p.shipClass, { size: 15 })}</span>
                        <span>${escapeHtml(p.shipType)} (${escapeHtml(p.shipClass)})</span>
                        <strong>${p.pct.toFixed(1)}%</strong>
                      </div>
                      <div class="construction-prob-track">
                        <div class="construction-prob-fill ${isSupport ? 'is-support' : ''}" style="width:${Math.min(100, Math.max(2, p.pct * 1.4))}%"></div>
                      </div>
                    </div>
                  `;
                })
                .join('');
            }
            const buildBtn = body.querySelector('#btn-do-free-construct');
            if (buildBtn) {
              const okNow =
                stock.fuel >= recipe.fuel &&
                stock.ammo >= recipe.ammo &&
                stock.steel >= recipe.steel &&
                stock.bauxite >= recipe.bauxite &&
                stock.silver >= SILVER_FEE;
              buildBtn.disabled = !okNow;
              buildBtn.textContent = okNow ? `立即建造（消耗 银条 ${SILVER_FEE}）` : '资源或银条不足';
            }
          });
        });

        body.querySelector('#build-custom-name')?.addEventListener('input', (e) => {
          recipe.customName = e.target.value;
        });

        body.querySelector('#btn-do-free-construct')?.addEventListener('click', async () => {
          try {
            const res = await buildings.constructShipByRecipe({
              fuel: recipe.fuel,
              ammo: recipe.ammo,
              steel: recipe.steel,
              bauxite: recipe.bauxite,
              customName: recipe.customName,
            });
            await persistCharacterRoster({
              storage: rootStorage,
              entities,
              activeCharacterId: res.entity?.id || undefined,
            });
            lastResult = res;
            recipe.customName = '';
            if (res.isDuplicate) {
              uiKit.showToast(`重复舰「${res.shipName}」已转化为改造核心 ×1 + 礼盒与银条！`, 'ok');
            } else {
              uiKit.showToast(`建造成功！「${res.shipName}」（${res.shipType}）已即时入港！`, 'ok');
            }
            renderInner();
            if (typeof onConstructed === 'function') onConstructed(res);
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '建造失败', 'warn');
          }
        });

        body.querySelector('#btn-build-view-ship')?.addEventListener('click', () => {
          if (lastResult?.entity?.id) {
            close();
            openCharacterCardById(lastResult.entity.id, context);
          }
        });

        body.querySelector('#btn-close-free-construct')?.addEventListener('click', () => close());
      };

      renderInner();
    },
  });
}

export const portDormitoryModule = createDormitoryModule();
export const portDockyardModule = createDockyardModule();
export const portFormationModule = createFormationModule();
export const portExpeditionModule = createExpeditionModule();
