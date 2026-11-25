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
  SHIP_TYPE_PRESETS,
  getShipClassProfile,
  getShipClassSvg,
  resolveShipClass,
} from '../core/stat-rules.js';
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
        <span class="status-badge badge-ok">同舰不同随机性格</span>
      </div>
      <p class="muted-text" style="font-size:12px;">
        消耗 燃油80 / 弹药60 / 钢材100 / 铝材50 建造新舰娘，自动配备基础适航核心并从性格池随机生成「主性格 × 副特质」。
      </p>
      <div class="lab-kv-grid">
        <input id="dock-new-name" class="form-input" type="text" placeholder="新舰名称（如：驱逐新锐号）">
        <select id="dock-new-type" class="form-input">
          ${SHIP_TYPE_PRESETS.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
        </select>
      </div>
      <button type="button" id="btn-dock-construct" class="btn-primary uikit-touch-target">开始建造并登记入港</button>
    `;

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
  const state = { container: null, context: null, unsubs: [], avatarCache: new Map() };

  async function render() {
    if (!state.container || !state.context) return;
    const { formation, entities, resources, assets, modules, uiKit } = state.context;
    const fState = formation.getState();
    const allFormations = formation.listFormations();
    const summary = fState.summary;
    const costInfo = summary.staggeredStepCost || formation.computeStaggeredStepCost();
    const allChars = getAllCharacters(entities);
    const inFleetIds = new Set(fState.memberIds);
    const candidates = allChars.filter((c) => !inFleetIds.has(c.id));

    const avatars = new Map();
    for (const c of allChars) {
      avatars.set(c.id, await resolveAvatar(assets, state.avatarCache, c));
    }

    state.container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'subpage-root';
    root.id = 'page-port-formation';

    root.appendChild(
      uiKit.createSubpageHeader({
        title: '舰队编成与阵型',
        subtitle: `${fState.count}/${fState.cap} 席位 · ${summary.formationName}`,
        modules,
        resources,
        resourceKeys: ['fuel', 'ammo'],
        id: 'formation-subpage-header',
      })
    );

    // 1. Staggered Cost & Fleet Stats Summary Card
    const sumCard = document.createElement('section');
    sumCard.className = 'surface-card lab-stack-sm';
    sumCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">全队聚合战力与阶梯消耗</h2>
        <span class="status-badge badge-ok" id="form-staggered-badge">单步 油${costInfo.fuel} / 弹${costInfo.ammo}</span>
      </div>
      <div class="port-gear-summary">
        <span class="ns-chip">火力 ${summary.effective.firepower}</span>
        <span class="ns-chip">雷击 ${summary.effective.torpedo}</span>
        <span class="ns-chip">机动 ${summary.effective.evasion}</span>
        <span class="ns-chip">防空 ${summary.effective.aa}</span>
        <span class="ns-chip">反潜 ${summary.effective.asw}</span>
        <span class="ns-chip">侦查 ${summary.effective.recon}</span>
        <span class="ns-chip">视野 ${summary.visionRange || 2}格</span>
      </div>
      <p class="muted-text" style="font-size:11.5px;">
        阶梯公式：第 1~3 号舰 100% · 第 4~6 号舰 75% · 第 7~12 号舰 55%${
          costInfo.dispatchDiscount > 0 ? ` × 调度折扣 -${Math.round(costInfo.dispatchDiscount * 100)}%` : ''
        }
      </p>
      <div class="lab-btn-grid">
        <button type="button" id="btn-form-autofill" class="btn-secondary uikit-touch-target">一键补满席位</button>
        <button type="button" id="btn-form-goto-sortie" class="btn-primary uikit-touch-target">前往出征海图</button>
      </div>
    `;

    sumCard.querySelector('#btn-form-autofill').addEventListener('click', async () => {
      const next = await formation.autoFillFleet();
      uiKit.showToast(`已自动编成 ${next.count} 人舰队`, 'ok');
      render();
    });

    sumCard.querySelector('#btn-form-goto-sortie').addEventListener('click', () => {
      if (modules.has('sortie-console')) modules.mount('sortie-console', { transition: 'left' });
    });
    root.appendChild(sumCard);

    // 2. Active Formation Picker
    const fmtCard = document.createElement('section');
    fmtCard.className = 'surface-card lab-stack-sm';
    fmtCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">海战阵型选择</h2>
        <span class="status-badge badge-muted">${escapeHtml(summary.formationName)}</span>
      </div>
      <div class="cc-btn-3col" id="formation-picker-grid">
        ${allFormations
          .map(
            (f) => `
          <button type="button" class="${f.id === fState.formationId ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-pick-formation="${escapeHtml(f.id)}">
            ${escapeHtml(f.name)}
          </button>
        `
          )
          .join('')}
      </div>
      <p class="muted-text" style="font-size:12px;">${escapeHtml(fState.formation?.description || '')}</p>
    `;

    fmtCard.querySelectorAll('[data-pick-formation]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await formation.setFormation(btn.getAttribute('data-pick-formation'));
        uiKit.showToast('海战阵型已切换', 'ok');
        render();
      });
    });
    root.appendChild(fmtCard);

    // 3. Active Fleet Members
    const membersCard = document.createElement('section');
    membersCard.className = 'surface-card lab-stack-sm';
    membersCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">当前参战编队（${fState.count}/${fState.cap}）</h2>
      </div>
      <div class="lab-stack-sm" id="formation-members-list">
        ${
          summary.members.length === 0
            ? '<p class="muted-text">当前编队为空，请从下方候补舰娘中添加。</p>'
            : summary.members
                .map((m, idx) => {
                  const slotCost = costInfo.breakdown?.[idx];
                  const avatarUrl = avatars.get(m.id) || '';
                  return `
                  <div class="lab-slot-card dorm-roster-row" data-fleet-member="${escapeHtml(m.id)}">
                    <div class="dorm-row-main">
                      <button type="button" class="avatar-jump-btn" data-jump-char-card="${escapeHtml(m.id)}">
                        <img class="dorm-mini-avatar" src="${avatarUrl}" alt="${escapeHtml(m.name)}">
                      </button>
                      <div class="dorm-row-info">
                        <div class="dorm-row-title">
                          <span class="ship-class-ico">${getShipClassSvg(m.shipType, { size: 16 })}</span>
                          <strong>${idx === 0 ? '★旗舰 · ' : `#${idx + 1} `}${escapeHtml(m.name)}</strong>
                          ${slotCost ? `<span class="status-badge badge-muted">阶梯 ${slotCost.tierLabel}</span>` : ''}
                        </div>
                        <div class="cc-stat-sub">
                          ${escapeHtml(m.shipType)} · HP ${m.hp}/${m.maxHp} · 火${m.firepower} 雷${m.torpedo} 机${m.evasion || 50}
                        </div>
                      </div>
                    </div>
                    <div class="lab-btn-grid">
                      ${
                        idx > 0
                          ? `<button type="button" class="btn-secondary uikit-touch-target" data-fleet-promote="${escapeHtml(m.id)}">设为旗舰</button>`
                          : '<button type="button" class="btn-secondary uikit-touch-target" disabled>当前旗舰</button>'
                      }
                      <button type="button" class="btn-danger uikit-touch-target" data-fleet-remove="${escapeHtml(m.id)}">离队</button>
                    </div>
                  </div>
                `;
                })
                .join('')
        }
      </div>
    `;
    root.appendChild(membersCard);

    // 4. Candidate Pool
    const candCard = document.createElement('section');
    candCard.className = 'surface-card lab-stack-sm';
    candCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">港区候补舰娘（${candidates.length} 名）</h2>
      </div>
      <div class="lab-stack-sm" id="formation-candidates-list">
        ${
          candidates.length === 0
            ? '<p class="muted-text">所有舰娘均已在编队中。</p>'
            : candidates
                .map((c) => {
                  const check = formation.canAddMember(c.id);
                  const avatarUrl = avatars.get(c.id) || '';
                  const prof = getShipClassProfile(c.meta?.shipType);
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
                          <span class="status-badge badge-muted">${escapeHtml(prof.fullName)}</span>
                        </div>
                        <div class="cc-stat-sub">${escapeHtml(check.ok ? prof.roleSummary : check.reason)}</div>
                      </div>
                    </div>
                    <button type="button" class="btn-primary uikit-touch-target" data-fleet-add="${escapeHtml(c.id)}" ${check.ok ? '' : 'disabled'}>
                      ${check.ok ? '编入舰队' : '暂不可入队'}
                    </button>
                  </div>
                `;
                })
                .join('')
        }
      </div>
    `;
    root.appendChild(candCard);

    root.querySelectorAll('[data-jump-char-card]').forEach((btn) => {
      btn.addEventListener('click', () => openCharacterCardById(btn.getAttribute('data-jump-char-card'), state.context));
    });
    root.querySelectorAll('[data-fleet-promote]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await formation.setFlagship(btn.getAttribute('data-fleet-promote'));
        uiKit.showToast('旗舰已更新', 'ok');
        render();
      });
    });
    root.querySelectorAll('[data-fleet-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await formation.removeMember(btn.getAttribute('data-fleet-remove'));
        uiKit.showToast('已移出编队', 'info');
        render();
      });
    });
    root.querySelectorAll('[data-fleet-add]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await formation.addMember(btn.getAttribute('data-fleet-add'));
          uiKit.showToast('已编入出征舰队', 'ok');
          render();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '入队失败', 'warn');
        }
      });
    });

    state.container.appendChild(root);
  }

  return {
    id: 'port-formation',
    name: '舰队编成',
    description: '独立全屏舰队编成页：3~12 人动态上限、五阵型切换与阶梯消耗实时预览。',
    isSubpage: true,
    lockSwipe: true,
    mount(container, context) {
      state.container = container;
      state.context = context;
      state.avatarCache.clear();
      context.ui.setSwipeLocked(true);
      context.ui.setPlaceholder('舰队编成备忘...');
      context.ui.setQuickActions([
        { id: 'form-back', label: '← 返回港区', onClick: () => context.modules.mount('port-hub', { transition: 'right' }) },
        { id: 'form-sortie', label: '前往出征海图', onClick: () => context.modules.mount('sortie-console', { transition: 'left' }) },
      ]);
      state.unsubs = [
        context.bus.on('formation:changed', () => render()),
        context.bus.on('commander:updated', () => render()),
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

export const portDormitoryModule = createDormitoryModule();
export const portDockyardModule = createDockyardModule();
export const portFormationModule = createFormationModule();
export const portExpeditionModule = createExpeditionModule();
