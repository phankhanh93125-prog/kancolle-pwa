/**
 * Official Home Screen Module: Port Hub (`port-hub` · 港区大本营).
 *
 * Refactored mobile command hub integrating:
 *   1. Unified 6-Resource & Dual-Currency Bar (fuel/ammo/steel/bauxite + silver/gold)
 *   2. Top Commander Character Card Summary (avatar, level/EXP, 6 core stats, independent 0-base Luck,
 *      dynamic 3..12 fleet cap, and one-tap Edit / Allocate Points / Mobile Debug bottom sheet)
 *   3. Flagship Duty Board (shipType, seaworthiness badge, HP/morale/AP bars, gear summary)
 *   4. Core Operations ("前往出征", "一键补给与入渠修复" with Commander dispatch discount & affinity morale boost)
 *   5. Sortie Fleet Formation Center (visual 3..12 dynamic slot roster, formation switcher & coefficient editor)
 *   6. Port Expedition Dispatch Center (offline timestamp countdowns via EntitySystem, seaworthy idle ship selection,
 *      Commander dispatch reward scaling & one-tap claim)
 */

import { createResourceOverviewBar } from '../core/resource-manager.js';
import {
  COMMANDER_STAT_DEFS,
  COMMANDER_STAT_GROUP_LABELS,
} from '../core/commander-system.js';
import { LOG_CATEGORIES } from '../core/log-system.js';
import {
  getActiveCharacterId,
  persistCharacterRoster,
} from './character-console.js';

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

let portState = {
  container: null,
  context: null,
  avatarCache: new Map(),
  selectedExpMissionId: 'exp_harbor_patrol',
  selectedExpShipIds: [],
  timerHandle: null,
  unsubs: [],
};

function getCharacters() {
  return portState.context?.entities?.list({ kind: 'character' }) || [];
}

function getFlagship() {
  const { formation, rootStorage } = portState.context;
  const fleetMembers = formation ? formation.getMembers() : [];
  if (fleetMembers.length > 0) return fleetMembers[0];
  const list = getCharacters();
  if (list.length === 0) return null;
  const activeId = getActiveCharacterId(rootStorage);
  return list.find((c) => c.id === activeId) || list[0];
}

function computeFleetServicePlan(chars) {
  const { entities, commander } = portState.context;
  const repairDisc = commander ? commander.getRepairCostDiscount() : 0;
  const moraleMult = commander ? commander.getMoraleRecoveryMultiplier() : 1.0;
  const targetMorale = Math.min(100, Math.round(80 + Math.max(0, (moraleMult - 1) * 15)));

  let totalMissingHp = 0;
  let totalMissingAp = 0;
  let needsMoraleCount = 0;
  const details = [];

  for (const char of chars) {
    const effMaxHp = Math.max(1, Math.round(entities.getEffectiveStat(char.id, 'maxHp', { round: 'round' }).final));
    const maxAp = Number(char.stats.maxAp ?? 100);
    const curHp = Math.round(Number(char.stats.hp ?? effMaxHp));
    const curAp = Math.round(Number(char.stats.ap ?? maxAp));
    const curMorale = Math.round(Number(char.stats.morale ?? 70));

    const missingHp = Math.max(0, effMaxHp - curHp);
    const missingAp = Math.max(0, maxAp - curAp);
    const needsMorale = curMorale < targetMorale;
    totalMissingHp += missingHp;
    totalMissingAp += missingAp;
    if (needsMorale) needsMoraleCount += 1;

    details.push({
      char,
      effMaxHp,
      maxAp,
      missingHp,
      missingAp,
      needsMorale,
      targetMorale: Math.max(curMorale, targetMorale),
    });
  }

  const needsService = totalMissingHp > 0 || totalMissingAp > 0 || needsMoraleCount > 0;
  const cost = {};
  const repairScale = Math.max(0.5, 1 - repairDisc);

  if (totalMissingHp > 0) {
    cost.steel = Math.max(8, Math.ceil(totalMissingHp * 1.4 * repairScale));
    cost.bauxite = Math.max(4, Math.ceil(totalMissingHp * 0.45 * repairScale));
  }
  if (totalMissingAp > 0 || needsMoraleCount > 0) {
    cost.fuel = Math.max(12, Math.ceil(totalMissingAp * 0.7 * repairScale));
    cost.ammo = Math.max(12, Math.ceil(totalMissingAp * 0.45 * repairScale));
  }

  return {
    needsService,
    totalMissingHp,
    totalMissingAp,
    needsMoraleCount,
    repairDisc,
    cost,
    details,
  };
}

async function performResupplyAndRepair(chars) {
  const { entities, resources, rootStorage, logs, bus, uiKit } = portState.context;
  const targetList = Array.isArray(chars) && chars.length > 0 ? chars : [];
  if (targetList.length === 0) return;

  const plan = computeFleetServicePlan(targetList);
  if (!plan.needsService) {
    uiKit.showToast('当前编队与执勤舰船状态已满，无需补给或修复', 'info');
    return;
  }

  const spend = await resources.spendBatch(plan.cost, {
    reason: `港区一键补给与入渠修复（${targetList.length}舰）`,
  });
  if (!spend.ok) {
    uiKit.showToast(spend.reason, 'warn');
    return;
  }

  for (const item of plan.details) {
    if (item.missingHp > 0) {
      entities.setStat(item.char.id, 'hp', item.effMaxHp, { min: 0, max: item.effMaxHp });
    }
    if (item.missingAp > 0) {
      entities.setStat(item.char.id, 'ap', item.maxAp, { min: 0, max: item.maxAp });
    }
    if (item.needsMorale) {
      entities.setStat(item.char.id, 'morale', item.targetMorale, { min: 0, max: 100 });
    }
  }

  await persistCharacterRoster({
    storage: rootStorage,
    entities,
    activeCharacterId: targetList[0].id,
  });

  const costSummary = Object.entries(plan.cost)
    .map(([k, v]) => `${resources.get(k)?.name || k} -${v}`)
    .join('、');

  const recoveredParts = [];
  if (plan.totalMissingHp > 0) recoveredParts.push(`耐久 +${plan.totalMissingHp}`);
  if (plan.totalMissingAp > 0) recoveredParts.push(`AP +${plan.totalMissingAp}`);
  if (plan.needsMoraleCount > 0) recoveredParts.push(`士气整备 ${plan.needsMoraleCount}舰`);

  logs.add({
    category: LOG_CATEGORIES.STAT,
    actorId: targetList[0].id,
    actorName: targetList[0].name,
    title: `港区一键补给与入渠修复（${targetList.length}舰）`,
    detail: `恢复：${recoveredParts.join('、')} | 消耗：${costSummary}${plan.repairDisc > 0 ? `（调度减免 ${Math.round(plan.repairDisc * 100)}%）` : ''}`,
  });

  bus.emit('port:serviced', {
    characterIds: targetList.map((c) => c.id),
    cost: plan.cost,
    recovered: recoveredParts,
    timestamp: Date.now(),
  });

  uiKit.showToast(`整备完成：${recoveredParts.join('、')}`, 'ok');
  await renderPortHub();
}

// ============================================================
// Commander Editor, Point Allocation & Mobile Debug Sheet
// ============================================================

function openCommanderSheet() {
  const { commander, assets, uiKit, logs } = portState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const renderInner = async () => {
    const profile = commander.getProfile();
    const avatarRes = await assets.getAssetUrl(profile.avatarAssetId, {
      fallbackSeed: 'commander-profile',
      fallbackLabel: profile.name.slice(0, 4),
    });

    wrap.innerHTML = `
      <div class="cc-hero-row">
        <img id="cmd-edit-avatar" class="cc-avatar" src="${avatarRes.url}" alt="指挥官头像">
        <div class="lab-stack-sm" style="flex:1 1 auto; min-width:0;">
          <button type="button" id="btn-cmd-upload-avatar" class="btn-secondary uikit-touch-target">上传指挥官头像</button>
          <span class="muted-text" style="font-size:11.5px;">Lv.${profile.level} · EXP ${profile.exp}/${profile.expToNext} · 自由属性点 ${profile.freePoints}</span>
        </div>
      </div>

      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="cmd-f-name">指挥官姓名</label>
          <input id="cmd-f-name" class="form-input" type="text" value="${escapeHtml(profile.name)}">
        </div>
        <div class="form-group">
          <label class="form-label" for="cmd-f-title">称号</label>
          <input id="cmd-f-title" class="form-input" type="text" value="${escapeHtml(profile.title)}">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="cmd-f-tags">性格标签（逗号分隔）</label>
        <input id="cmd-f-tags" class="form-input" type="text" value="${escapeHtml((profile.personalityTags || []).join(', '))}">
      </div>

      <div class="lab-divider"></div>

      <div class="section-header-row" style="margin-bottom:0;">
        <span class="form-label">六维核心属性（可用自由点：${profile.freePoints}）</span>
        <span class="status-badge badge-ok" id="cmd-sheet-fleet-cap">带队上限 ${profile.fleetCap}/${profile.formula.maxFleetCap} 人</span>
      </div>

      <div class="lab-stack-sm">
        ${COMMANDER_STAT_DEFS.map(
          (def) => `
          <div class="cmd-alloc-row" data-cmd-stat-row="${def.key}">
            <div style="flex:1 1 auto; min-width:0;">
              <strong>${escapeHtml(def.label)}</strong>
              <span class="status-badge badge-muted" style="margin-left:4px;">${escapeHtml(COMMANDER_STAT_GROUP_LABELS[def.group])}</span>
              <div class="muted-text" style="font-size:11.5px;">${escapeHtml(def.desc)}</div>
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
              <input class="form-input" style="width:68px; text-align:center;" type="number" min="${def.min}" max="${def.max}" id="cmd-manual-${def.key}" value="${profile.stats[def.key]}">
              <button type="button" class="btn-secondary uikit-touch-target" data-cmd-alloc="${def.key}" style="padding:0 12px;" ${profile.freePoints <= 0 ? 'disabled' : ''}>+1点</button>
            </div>
          </div>
        `
        ).join('')}
      </div>

      <div class="lab-divider"></div>

      <div class="surface-card lab-stack-sm" style="padding:10px;">
        <div class="section-header-row" style="margin-bottom:0;">
          <strong style="font-size:13.5px;">独立特殊属性 · 运气（Luck）</strong>
          <span class="status-badge ${profile.luck > 0 ? 'badge-ok' : profile.luck < 0 ? 'badge-danger' : 'badge-muted'}" id="cmd-sheet-luck-badge">
            当前 ${formatSigned(profile.luck)}（初始为 0）
          </span>
        </div>
        <p class="muted-text" style="font-size:12px;">
          不参与常规升级加点，仅随特殊事件/里程碑或下方调试增减（支持正负）。当前微调：大成功阈值 -${profile.effects.luckEffects.critSuccessShift} / 稀有掉率 ${formatSigned(Math.round(profile.effects.luckEffects.rareDropBonus * 100))}%。
        </p>
        <div class="lab-kv-grid">
          <div class="form-group">
            <label class="form-label" for="cmd-manual-luck">调试设定运气（-100~100）</label>
            <input id="cmd-manual-luck" class="form-input" type="number" min="-100" max="100" value="${profile.luck}">
          </div>
          <div class="form-group">
            <label class="form-label" for="cmd-manual-pts">调试自由属性点</label>
            <input id="cmd-manual-pts" class="form-input" type="number" min="0" max="200" value="${profile.freePoints}">
          </div>
        </div>
      </div>

      <div class="surface-card lab-stack-sm" style="padding:10px;">
        <strong style="font-size:13px;">统率带队上限公式系数（自定义）</strong>
        <div class="lab-kv-grid">
          <div class="form-group">
            <label class="form-label" for="cmd-f-mincap">初始编队人数</label>
            <input id="cmd-f-mincap" class="form-input" type="number" min="1" max="12" value="${profile.formula.minFleetCap}">
          </div>
          <div class="form-group">
            <label class="form-label" for="cmd-f-maxcap">最高编队上限</label>
            <input id="cmd-f-maxcap" class="form-input" type="number" min="3" max="12" value="${profile.formula.maxFleetCap}">
          </div>
          <div class="form-group">
            <label class="form-label" for="cmd-f-basecmd">起始统率基准</label>
            <input id="cmd-f-basecmd" class="form-input" type="number" min="1" max="50" value="${profile.formula.baseCommandForMinCap}">
          </div>
          <div class="form-group">
            <label class="form-label" for="cmd-f-percmd">每+1席位所需统率</label>
            <input id="cmd-f-percmd" class="form-input" type="number" min="1" max="50" value="${profile.formula.commandPerExtraSlot}">
          </div>
        </div>
      </div>

      <button type="button" id="btn-cmd-save-all" class="btn-primary uikit-touch-target">保存指挥官资料与调试数值</button>
    `;

    wrap.querySelector('#btn-cmd-upload-avatar').addEventListener('click', async () => {
      const file = await assets.pickImageFromDevice();
      if (!file) return;
      try {
        const meta = await assets.saveImageFromFile(file, {
          label: 'commander-avatar',
          maxWidth: 512,
          maxHeight: 512,
          quality: 0.8,
        });
        await commander.updateProfile({ avatarAssetId: meta.id });
        portState.avatarCache.clear();
        uiKit.showToast('指挥官头像已压缩入库', 'ok');
        await renderInner();
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '头像上传失败', 'error');
      }
    });

    wrap.querySelectorAll('[data-cmd-alloc]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-cmd-alloc');
        try {
          await commander.allocateStat(key, 1);
          uiKit.showToast('属性点分配成功', 'ok');
          await renderInner();
          await renderPortHub();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '分配失败', 'warn');
        }
      });
    });

    wrap.querySelector('#btn-cmd-save-all').addEventListener('click', async () => {
      const name = wrap.querySelector('#cmd-f-name').value.trim();
      const title = wrap.querySelector('#cmd-f-title').value.trim();
      const tags = wrap.querySelector('#cmd-f-tags').value;
      const statsPatch = {
        luck: Number(wrap.querySelector('#cmd-manual-luck').value),
        freePoints: Number(wrap.querySelector('#cmd-manual-pts').value),
      };
      for (const def of COMMANDER_STAT_DEFS) {
        statsPatch[def.key] = Number(wrap.querySelector(`#cmd-manual-${def.key}`).value);
      }
      const formulaPatch = {
        minFleetCap: Number(wrap.querySelector('#cmd-f-mincap').value),
        maxFleetCap: Number(wrap.querySelector('#cmd-f-maxcap').value),
        baseCommandForMinCap: Number(wrap.querySelector('#cmd-f-basecmd').value),
        commandPerExtraSlot: Number(wrap.querySelector('#cmd-f-percmd').value),
      };

      await commander.updateProfile({ name, title, personalityTags: tags });
      await commander.updateFormulaConfig(formulaPatch);
      const updated = await commander.setStatsManual(statsPatch);

      logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        title: `更新指挥官「${updated.name}」属性与公式`,
        detail: `统率 ${updated.stats.command}（带队上限 ${updated.fleetCap}/${updated.formula.maxFleetCap}）· 运气 ${updated.luck}`,
      });
      uiKit.showToast(`已保存！当前可带队上限 ${updated.fleetCap}/${updated.formula.maxFleetCap} 人`, 'ok');
      await renderInner();
      await renderPortHub();
    });
  };

  renderInner();

  uiKit.openBottomSheet({
    title: '指挥官角色卡 · 加点与调试',
    subtitle: '六维按 2战斗 + 2舰娘 + 2后勤 划分；「运气」独立于六维之外',
    content: wrap,
    actions: [{ id: 'close', label: '完成', tone: 'secondary' }],
  });
}

function openFormationCoeffSheet() {
  const { formation, uiKit } = portState.context;
  const active = formation.getActiveFormation();
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const keys = [
    { key: 'firepower', label: '火力倍率' },
    { key: 'torpedo', label: '雷击倍率' },
    { key: 'armor', label: '装甲倍率' },
    { key: 'evasion', label: '机动倍率' },
    { key: 'recon', label: '侦查倍率' },
    { key: 'aa', label: '防空倍率' },
    { key: 'asw', label: '反潜倍率' },
    { key: 'guardBonus', label: '援护率增量' },
  ];

  wrap.innerHTML = `
    <p class="muted-text">正在调整阵型「<strong>${escapeHtml(active.name)}</strong>」的自定义系数：</p>
    <div class="lab-kv-grid">
      ${keys
        .map(
          (k) => `
        <div class="form-group">
          <label class="form-label" for="fm-mod-${k.key}">${k.label}</label>
          <input id="fm-mod-${k.key}" class="form-input" type="number" step="0.05" value="${Number(active.mods[k.key] ?? 1)}">
        </div>
      `
        )
        .join('')}
    </div>
  `;

  uiKit.openBottomSheet({
    title: `自定义阵型系数 · ${active.name}`,
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: '保存阵型系数',
        tone: 'primary',
        onClick: async () => {
          const patch = {};
          for (const k of keys) {
            patch[k.key] = Number(wrap.querySelector(`#fm-mod-${k.key}`).value);
          }
          await formation.updateFormationModifiers(active.id, patch);
          uiKit.showToast(`已保存「${active.name}」自定义系数`, 'ok');
          await renderPortHub();
          return true;
        },
      },
    ],
  });
}

// ============================================================
// Main Port Hub Renderer
// ============================================================

async function renderPortHub() {
  if (!portState.container || !portState.context) return;
  const {
    assets,
    resources,
    inventory,
    statRules,
    entities,
    commander,
    formation,
    expeditions,
    rootStorage,
    modules,
    bus,
    uiKit,
  } = portState.context;

  const roster = getCharacters();
  const flagship = getFlagship();
  const cmdProfile = commander.getProfile();
  const fleetState = formation.getState();
  const fleetSummary = fleetState.summary;

  // Resolve Commander Avatar
  const cmdCacheKey = `cmd::${cmdProfile.avatarAssetId || 'none'}`;
  let cmdAvatarUrl = portState.avatarCache.get(cmdCacheKey);
  if (!cmdAvatarUrl) {
    const res = await assets.getAssetUrl(cmdProfile.avatarAssetId, {
      fallbackSeed: 'commander-profile',
      fallbackLabel: cmdProfile.name.slice(0, 4),
    });
    cmdAvatarUrl = res.url;
    portState.avatarCache.set(cmdCacheKey, cmdAvatarUrl);
  }

  portState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'port-root';

  // 1. Unified 6-Resource & Dual-Currency Overview Bar
  root.appendChild(createResourceOverviewBar(resources, { showCaps: true, id: 'port-resource-bar' }));

  // 2. Top Commander Character Card Summary
  const cmdCard = document.createElement('section');
  cmdCard.className = 'surface-card lab-stack-sm';
  cmdCard.id = 'port-commander-card';
  cmdCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">指挥官角色卡</h2>
      <span class="status-badge badge-ok" id="port-commander-fleet-cap">可带队上限 ${cmdProfile.fleetCap}/${cmdProfile.formula.maxFleetCap} 人</span>
    </div>

    <div class="cc-hero-row">
      <img class="cc-avatar" id="port-commander-avatar" src="${cmdAvatarUrl}" alt="${escapeHtml(cmdProfile.name)}">
      <div class="cc-hero-info">
        <div class="cc-hero-name-row">
          <h3 class="cc-hero-name" id="port-commander-name">${escapeHtml(cmdProfile.name)}</h3>
          <span class="status-badge badge-muted">Lv.${cmdProfile.level}</span>
        </div>
        <div class="cc-badge-row">
          <span class="status-badge badge-ok">${escapeHtml(cmdProfile.title)}</span>
          <span class="status-badge ${cmdProfile.luck > 0 ? 'badge-ok' : cmdProfile.luck < 0 ? 'badge-danger' : 'badge-warn'}" id="port-commander-luck">
            独立运气 ${cmdProfile.luck === 0 ? '0' : formatSigned(cmdProfile.luck)}
          </span>
          ${
            cmdProfile.freePoints > 0
              ? `<span class="status-badge badge-ok">待分配 ${cmdProfile.freePoints} 点</span>`
              : ''
          }
        </div>
      </div>
    </div>

    <div id="port-commander-exp-bar"></div>

    <div class="cmd-six-grid" id="port-commander-stats">
      ${COMMANDER_STAT_DEFS.map(
        (d) => `
        <div class="cmd-stat-pill" data-cmd-stat="${d.key}">
          <span class="cmd-stat-group">${escapeHtml(COMMANDER_STAT_GROUP_LABELS[d.group])}</span>
          <span class="cmd-stat-label">${escapeHtml(d.label)}</span>
          <strong class="cmd-stat-val">${cmdProfile.stats[d.key]}</strong>
        </div>
      `
      ).join('')}
    </div>

    <div class="muted-text" style="font-size:11.5px;">
      扫描/迂回 +${cmdProfile.effects.tacticsCheckBonus} · 援护/补刀 ${Math.round(cmdProfile.effects.wingmanAssistChance * 100)}% · 油弹/维修减免 ${Math.round(cmdProfile.effects.sortieStepDiscount * 100)}%/${Math.round(cmdProfile.effects.repairCostDiscount * 100)}% · 远征收益 x${cmdProfile.effects.expeditionRewardMultiplier.toFixed(2)}
    </div>

    <button type="button" id="btn-port-edit-commander" class="btn-secondary uikit-touch-target">
      指挥官加点 / 资料编辑与调试
    </button>
  `;
  cmdCard.querySelector('#port-commander-exp-bar').appendChild(
    uiKit.createProgressBar({
      label: `指挥官经验 (Lv.${cmdProfile.level})`,
      value: cmdProfile.exp,
      max: cmdProfile.expToNext,
      tone: 'accent',
    }).element
  );
  cmdCard.querySelector('#btn-port-edit-commander').addEventListener('click', () => openCommanderSheet());
  root.appendChild(cmdCard);

  // 3. Flagship Duty Board Card
  if (flagship) {
    const assetId = flagship.meta?.avatarAssetId || null;
    const cacheKey = `${flagship.id}::${assetId || 'none'}`;
    let avatarUrl = portState.avatarCache.get(cacheKey);
    if (!avatarUrl) {
      const resolved = await assets.getAssetUrl(assetId, {
        fallbackSeed: flagship.id,
        fallbackLabel: flagship.name.slice(0, 6),
      });
      avatarUrl = resolved.url;
      portState.avatarCache.set(cacheKey, avatarUrl);
    }

    const seaworthyInfo = statRules.evaluateSeaworthiness(inventory, flagship.id);
    const affStage = statRules.getAffinityStage(flagship.stats.affinity ?? 0, {
      thresholdReduction: cmdProfile.effects.affinityThresholdReduction,
    });
    const moraleMod = statRules.getMoraleModifier(flagship.stats.morale ?? 50);
    const effStats = entities.getEffectiveStats(flagship.id, { round: 'round' });
    const eqBonuses = inventory.getCharacterEquipmentBonuses(flagship.id);
    const overallScore = statRules.computeOverallScore(effStats, eqBonuses.checkBonus);
    const equippedMap = inventory.getCharacterEquipment(flagship.id);

    const flagshipCard = document.createElement('section');
    flagshipCard.className = 'surface-card lab-stack-sm';
    flagshipCard.id = 'port-flagship-card';
    flagshipCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">旗舰执勤看板</h2>
        <span class="status-badge badge-ok" id="port-overall-score">评分 ${overallScore}</span>
      </div>

      <div class="cc-hero-row">
        <img class="cc-avatar" id="port-flagship-avatar" src="${avatarUrl}" alt="${escapeHtml(flagship.name)}">
        <div class="cc-hero-info">
          <div class="cc-hero-name-row">
            <h3 class="cc-hero-name" id="port-flagship-name">${escapeHtml(flagship.name)}</h3>
            <span class="status-badge ${seaworthyInfo.seaworthy ? 'badge-ok' : 'badge-danger'}" id="port-seaworthy-badge">
              ${seaworthyInfo.seaworthy ? '适航' : '未适航'}
            </span>
          </div>
          <div class="cc-badge-row">
            <span class="status-badge badge-ok">${escapeHtml(flagship.meta?.shipType || '驱逐舰')}</span>
            <span class="status-badge badge-ok">好感 · ${escapeHtml(affStage.label)} (${affStage.value})</span>
          </div>
        </div>
      </div>

      ${
        !seaworthyInfo.seaworthy
          ? `<div class="seaworthy-alert" id="port-seaworthy-alert">${escapeHtml(seaworthyInfo.statusText)}。请前往「角色控制台」装齐引擎、装甲、核心。</div>`
          : ''
      }

      <div id="port-flagship-bars" class="lab-stack-sm"></div>

      <div class="port-gear-summary" id="port-gear-summary">
        <span class="ns-chip">火 ${Math.round(effStats.firepower ?? 0)}</span>
        <span class="ns-chip">甲 ${Math.round(effStats.armor ?? 0)}</span>
        <span class="ns-chip">雷 ${Math.round(effStats.torpedo ?? 0)}</span>
        <span class="ns-chip">机 ${Math.round(effStats.evasion ?? 0)}</span>
        <span class="ns-chip">侦 ${Math.round(effStats.recon ?? 0)}</span>
        <span class="ns-chip">防空 ${Math.round(effStats.aa ?? 0)}</span>
        <span class="ns-chip">反潜 ${Math.round(effStats.asw ?? 0)}</span>
        <span class="ns-chip">核心：${escapeHtml(equippedMap.core?.name || '缺失')}</span>
      </div>
    `;

    const barsHost = flagshipCard.querySelector('#port-flagship-bars');
    const maxHp = Math.max(1, Math.round(Number(effStats.maxHp ?? flagship.stats.maxHp ?? 100)));
    const maxAp = Number(flagship.stats.maxAp ?? 100);
    const hpVal = Math.min(maxHp, Math.round(Number(flagship.stats.hp ?? maxHp)));
    barsHost.appendChild(
      uiKit.createProgressBar({
        label: hpVal / maxHp < 0.25 ? '耐久 (HP · 大破警告)' : '耐久 (HP)',
        value: hpVal,
        max: maxHp,
        tone: hpVal / maxHp < 0.25 ? 'danger' : hpVal / maxHp < 0.5 ? 'warn' : 'accent',
      }).element
    );
    barsHost.appendChild(
      uiKit.createProgressBar({
        label: `士气（${statRules.getMoraleLabel(flagship.stats.morale)} · 检定 ${formatSigned(moraleMod)}）`,
        value: flagship.stats.morale ?? 50,
        max: 100,
        tone: (flagship.stats.morale ?? 50) < 30 ? 'danger' : (flagship.stats.morale ?? 50) < 50 ? 'warn' : 'accent',
      }).element
    );
    barsHost.appendChild(
      uiKit.createProgressBar({
        label: '行动点 (AP)',
        value: flagship.stats.ap ?? maxAp,
        max: maxAp,
        tone: (flagship.stats.ap ?? maxAp) / maxAp < 0.25 ? 'warn' : 'accent',
      }).element
    );
    root.appendChild(flagshipCard);
  }

  // 4. Port Core Operations Card
  const serviceTargets = fleetState.count > 0 ? formation.getMembers() : flagship ? [flagship] : [];
  const servicePlan = computeFleetServicePlan(serviceTargets);
  const costText = servicePlan.needsService
    ? Object.entries(servicePlan.cost)
        .map(([k, v]) => `${resources.get(k)?.name || k} ${v}`)
        .join(' · ')
    : '全队状态已满，无需补给或修复';

  const opsCard = document.createElement('section');
  opsCard.className = 'surface-card lab-stack-sm';
  opsCard.id = 'port-ops-card';
  opsCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">港区指挥中枢</h2>
      <span class="status-badge badge-muted">出征编队 ${fleetState.count}/${fleetState.cap} 舰</span>
    </div>
    <button type="button" id="btn-port-goto-sortie" class="btn-primary port-cta-btn">前往出征（${fleetState.count}舰 · ${escapeHtml(fleetSummary.formationName)}）</button>
    <button type="button" id="btn-port-resupply-repair" class="btn-secondary uikit-touch-target">
      一键补给与入渠修复（${serviceTargets.length}舰）
    </button>
    <p class="muted-text" id="port-service-cost-hint" style="font-size:12px;">整备预计：${escapeHtml(costText)}</p>
    <div class="lab-divider"></div>
    <div class="cc-btn-3col">
      <button type="button" id="btn-port-goto-char" class="btn-secondary uikit-touch-target">角色控制台</button>
      <button type="button" id="btn-port-goto-workshop" class="btn-secondary uikit-touch-target">物资工坊</button>
      <button type="button" id="btn-port-goto-action" class="btn-secondary uikit-touch-target">行动事件台</button>
    </div>
  `;

  opsCard.querySelector('#btn-port-goto-sortie').addEventListener('click', () => {
    if (modules.has('sortie-console')) modules.mount('sortie-console');
  });
  opsCard.querySelector('#btn-port-resupply-repair').addEventListener('click', () =>
    performResupplyAndRepair(serviceTargets)
  );
  opsCard.querySelector('#btn-port-goto-char').addEventListener('click', () => {
    if (modules.has('character-console')) modules.mount('character-console');
  });
  opsCard.querySelector('#btn-port-goto-workshop').addEventListener('click', () => {
    if (modules.has('supply-workshop')) modules.mount('supply-workshop');
  });
  opsCard.querySelector('#btn-port-goto-action').addEventListener('click', () => {
    if (modules.has('action-console')) modules.mount('action-console');
  });
  root.appendChild(opsCard);

  // 5. Sortie Fleet Formation Management Card (3..12 Dynamic Cap + Formations)
  const fleetCard = document.createElement('section');
  fleetCard.className = 'surface-card lab-stack-sm';
  fleetCard.id = 'port-fleet-card';
  const formationsList = formation.listFormations();
  const inFleetSet = new Set(fleetState.memberIds);
  const idleCandidates = roster.filter((c) => !inFleetSet.has(c.id));

  fleetCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">出征舰队编成（3~12人动态上限）</h2>
      <span class="status-badge badge-ok" id="port-fleet-slot-badge">${fleetState.count} / ${fleetState.cap} 席位</span>
    </div>

    <div class="chip-row" id="port-formation-chips">
      ${formationsList
        .map(
          (f) => `
        <button type="button" class="preset-chip ${f.active ? 'is-active' : ''}" data-select-formation="${f.id}"
          style="${f.active ? 'border-color:var(--accent);color:var(--text-primary);background:var(--accent-soft);' : ''}">
          ${escapeHtml(f.name)}
        </button>
      `
        )
        .join('')}
    </div>
    <div class="muted-text" style="font-size:12px;">
      ${escapeHtml(fleetState.formation.desc)}
    </div>

    <div class="port-gear-summary" id="port-fleet-totals">
      <span class="ns-chip">全队火力 ${fleetSummary.effective.firepower}</span>
      <span class="ns-chip">全队雷击 ${fleetSummary.effective.torpedo}</span>
      <span class="ns-chip">均甲 ${fleetSummary.effective.armor}</span>
      <span class="ns-chip">机动 ${fleetSummary.effective.evasion}</span>
      <span class="ns-chip">侦查 ${fleetSummary.effective.recon}</span>
      <span class="ns-chip">防空 ${fleetSummary.effective.aa}</span>
      <span class="ns-chip">反潜 ${fleetSummary.effective.asw}</span>
    </div>

    <div class="lab-stack-sm" id="port-fleet-members">
      ${
        fleetSummary.members.length === 0
          ? '<p class="muted-text">当前编队为空，请从下方选择闲置适航舰娘入队。</p>'
          : fleetSummary.members
              .map(
                (m, idx) => `
          <div class="lab-slot-card" data-fleet-member="${escapeHtml(m.id)}">
            <div class="lab-slot-head">
              <strong>${idx === 0 ? '★ 旗舰' : `僚机 #${idx}`} · ${escapeHtml(m.name)}</strong>
              <span class="status-badge badge-muted">${escapeHtml(m.shipType)} · HP ${m.hp}/${m.maxHp}</span>
            </div>
            <div class="lab-btn-row">
              ${
                idx > 0
                  ? `<button type="button" class="btn-secondary uikit-touch-target" data-fleet-promote="${escapeHtml(m.id)}">设为旗舰</button>`
                  : ''
              }
              <button type="button" class="btn-danger uikit-touch-target" data-fleet-remove="${escapeHtml(m.id)}">移出编队</button>
            </div>
          </div>
        `
              )
              .join('')
      }
    </div>

    ${
      idleCandidates.length > 0
        ? `
      <div class="lab-divider"></div>
      <span class="form-label">待命舰娘（点击编入出征编队）</span>
      <div class="lab-stack-sm" id="port-fleet-candidates">
        ${idleCandidates
          .map((c) => {
            const check = formation.canAddMember(c.id);
            const disp = expeditions.isCharacterDispatched(c.id);
            return `
            <div class="lab-slot-card">
              <div class="lab-slot-head">
                <strong>${escapeHtml(c.name)}</strong>
                <span class="status-badge ${disp ? 'badge-warn' : check.ok ? 'badge-ok' : 'badge-muted'}">
                  ${escapeHtml(c.meta?.shipType || '驱逐舰')} · ${disp ? '远征中' : check.ok ? '可入队' : '暂不可用'}
                </span>
              </div>
              <button type="button" class="btn-secondary uikit-touch-target" data-fleet-add="${escapeHtml(c.id)}" ${check.ok ? '' : 'disabled'}>
                ${check.ok ? '+ 编入出征舰队' : escapeHtml(check.reason.slice(0, 26))}
              </button>
            </div>
          `;
          })
          .join('')}
      </div>
    `
        : ''
    }

    <div class="lab-btn-grid">
      <button type="button" id="btn-port-autofill-fleet" class="btn-secondary uikit-touch-target">一键补满编队</button>
      <button type="button" id="btn-port-edit-formation" class="btn-secondary uikit-touch-target">自定义阵型系数</button>
    </div>
  `;

  fleetCard.querySelectorAll('[data-select-formation]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await formation.setFormation(btn.getAttribute('data-select-formation'));
      await renderPortHub();
    });
  });
  fleetCard.querySelectorAll('[data-fleet-promote]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-fleet-promote');
      await formation.setFlagship(id);
      await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: id });
      await renderPortHub();
    });
  });
  fleetCard.querySelectorAll('[data-fleet-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await formation.removeMember(btn.getAttribute('data-fleet-remove'));
      await renderPortHub();
    });
  });
  fleetCard.querySelectorAll('[data-fleet-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await formation.addMember(btn.getAttribute('data-fleet-add'));
        uiKit.showToast('已编入出征舰队', 'ok');
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '无法加入编队', 'warn');
      }
    });
  });
  fleetCard.querySelector('#btn-port-autofill-fleet').addEventListener('click', async () => {
    await formation.autoFillFleet();
    uiKit.showToast(`当前编队 ${formation.getMemberIds().length}/${formation.getFleetCap()} 舰`, 'ok');
    await renderPortHub();
  });
  fleetCard.querySelector('#btn-port-edit-formation').addEventListener('click', () => openFormationCoeffSheet());
  root.appendChild(fleetCard);

  // 6. Port Expedition Dispatch Center Card
  const expCard = document.createElement('section');
  expCard.className = 'surface-card lab-stack-sm';
  expCard.id = 'port-expedition-card';

  const missions = expeditions.listMissions();
  const activeRuns = expeditions.listActiveRuns();
  const selectedMission =
    missions.find((m) => m.id === portState.selectedExpMissionId) || missions[0];

  // Clean selectedExpShipIds so only available seaworthy non-dispatched ships remain selected
  const dispatchableShips = roster.filter(
    (c) => inventory.checkSeaworthiness(c.id).seaworthy && !expeditions.isCharacterDispatched(c.id)
  );
  const validDispIds = new Set(dispatchableShips.map((c) => c.id));
  portState.selectedExpShipIds = portState.selectedExpShipIds.filter((id) => validDispIds.has(id));
  if (portState.selectedExpShipIds.length === 0 && dispatchableShips.length > 0) {
    // Prefer a non-flagship idle ship first if available
    const preferred =
      dispatchableShips.find((c) => !inFleetSet.has(c.id)) ||
      dispatchableShips[dispatchableShips.length - 1];
    if (preferred) portState.selectedExpShipIds = [preferred.id];
  }

  expCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">港区远征派遣中心</h2>
      <span class="status-badge badge-ok">调度收益 x${cmdProfile.effects.expeditionRewardMultiplier.toFixed(2)}</span>
    </div>

    ${
      activeRuns.length > 0
        ? `
      <div class="lab-stack-sm" id="port-exp-active-runs">
        ${activeRuns
          .map(
            (run) => `
          <div class="lab-slot-card" data-exp-run="${escapeHtml(run.id)}">
            <div class="lab-slot-head">
              <strong>${escapeHtml(run.missionName)}</strong>
              <span class="status-badge ${run.ready ? 'badge-ok' : 'badge-warn'}" data-exp-countdown="${escapeHtml(run.id)}">
                ${escapeHtml(run.remainingText)}
              </span>
            </div>
            <div class="muted-text" style="font-size:12px;">
              执勤舰船：${escapeHtml(run.ships.map((s) => s.name).join('、'))}
            </div>
            <div data-exp-bar="${escapeHtml(run.id)}"></div>
            <div class="lab-btn-row">
              <button type="button" class="btn-primary uikit-touch-target" data-exp-claim="${escapeHtml(run.id)}" ${run.ready ? '' : 'disabled'}>
                ${run.ready ? '一键领取远征物资' : '倒计时进行中…'}
              </button>
              <button type="button" class="btn-secondary uikit-touch-target" data-exp-recall="${escapeHtml(run.id)}">提前召回</button>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
      <div class="lab-divider"></div>
    `
        : '<p class="muted-text" style="font-size:12px;">当前无进行中的远征。派遣后关闭或刷新页面仍按真实时间戳继续倒计时。</p>'
    }

    <div class="form-group">
      <label class="form-label" for="port-exp-mission-select">选择远征任务</label>
      <select id="port-exp-mission-select" class="form-select">
        ${missions
          .map(
            (m) => `
          <option value="${escapeHtml(m.id)}" ${m.id === selectedMission.id ? 'selected' : ''}>
            ${escapeHtml(m.name)}（${escapeHtml(m.durationText)} · ${m.minShips}~${m.maxShips}舰）
          </option>
        `
          )
          .join('')}
      </select>
    </div>

    <div class="muted-text" style="font-size:12px;">
      ${escapeHtml(selectedMission.description)}<br>
      预计回报（含调度加成）：${escapeHtml(
        Object.entries(selectedMission.projectedRewards)
          .map(([k, v]) => `${resources.get(k)?.name || k} +${v}`)
          .join(' / ')
      )} · 指挥官 EXP +${selectedMission.commanderExp}
    </div>

    <div class="form-group">
      <span class="form-label">选择派遣适航舰船（已选 ${portState.selectedExpShipIds.length}/${selectedMission.maxShips}）</span>
      <div class="chip-row" id="port-exp-ship-picker">
        ${
          dispatchableShips.length === 0
            ? '<span class="muted-text" style="font-size:12px;">暂无空闲适航舰娘可派遣</span>'
            : dispatchableShips
                .map((c) => {
                  const picked = portState.selectedExpShipIds.includes(c.id);
                  const inSortie = inFleetSet.has(c.id);
                  return `
                  <button type="button" class="preset-chip ${picked ? 'is-active' : ''}" data-exp-pick-ship="${escapeHtml(c.id)}"
                    style="${picked ? 'border-color:var(--accent);color:var(--text-primary);background:var(--accent-soft);' : ''}">
                    ${escapeHtml(c.name)}${inSortie ? ' (在编)' : ''}
                  </button>
                `;
                })
                .join('')
        }
      </div>
    </div>

    <button type="button" id="btn-port-dispatch-exp" class="btn-primary uikit-touch-target"
      ${portState.selectedExpShipIds.length < selectedMission.minShips ? 'disabled' : ''}>
      派遣远征出发（${escapeHtml(selectedMission.name)}）
    </button>
  `;

  // Mount progress bars for active runs
  for (const run of activeRuns) {
    const barHost = expCard.querySelector(`[data-exp-bar="${run.id}"]`);
    if (barHost) {
      barHost.appendChild(
        uiKit.createProgressBar({
          label: '远征进度',
          value: Math.round(run.progress * 100),
          max: 100,
          tone: run.ready ? 'ok' : 'accent',
        }).element
      );
    }
  }

  expCard.querySelector('#port-exp-mission-select').addEventListener('change', (e) => {
    portState.selectedExpMissionId = e.target.value;
    renderPortHub();
  });

  expCard.querySelectorAll('[data-exp-pick-ship]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cid = btn.getAttribute('data-exp-pick-ship');
      if (portState.selectedExpShipIds.includes(cid)) {
        portState.selectedExpShipIds = portState.selectedExpShipIds.filter((id) => id !== cid);
      } else if (portState.selectedExpShipIds.length < selectedMission.maxShips) {
        portState.selectedExpShipIds.push(cid);
      }
      renderPortHub();
    });
  });

  expCard.querySelector('#btn-port-dispatch-exp').addEventListener('click', async () => {
    try {
      const run = await expeditions.dispatch(selectedMission.id, portState.selectedExpShipIds);
      portState.selectedExpShipIds = [];
      uiKit.showToast(`远征「${run.missionName}」已出发！`, 'ok');
      await renderPortHub();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '派遣失败', 'warn');
    }
  });

  expCard.querySelectorAll('[data-exp-claim]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await expeditions.claim(btn.getAttribute('data-exp-claim'));
        await persistCharacterRoster({ storage: rootStorage, entities });
        uiKit.showToast(
          `远征归港领取成功！指挥官 EXP +${res.commanderExp}${res.leveledUp ? '（升级！）' : ''}`,
          'ok'
        );
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '领取失败', 'warn');
      }
    });
  });

  expCard.querySelectorAll('[data-exp-recall]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await expeditions.recall(btn.getAttribute('data-exp-recall'));
      uiKit.showToast('已召回远征舰船', 'info');
      await renderPortHub();
    });
  });

  root.appendChild(expCard);
  portState.container.appendChild(root);
}

function tickExpeditionCountdowns() {
  if (!portState.container || !portState.context?.expeditions) return;
  const activeRuns = portState.context.expeditions.listActiveRuns();
  if (activeRuns.length === 0) return;
  let needsFullRefresh = false;
  for (const run of activeRuns) {
    const badge = portState.container.querySelector(`[data-exp-countdown="${run.id}"]`);
    if (badge) {
      badge.textContent = run.remainingText;
    }
    const claimBtn = portState.container.querySelector(`[data-exp-claim="${run.id}"]`);
    if (run.ready && claimBtn && claimBtn.disabled) {
      needsFullRefresh = true;
    }
  }
  if (needsFullRefresh) {
    renderPortHub();
  }
}

export default {
  id: 'port-hub',
  name: '港区大本营',
  description: '港区大本营主中枢：指挥官角色卡（六维+0初值运气）、旗舰执勤、3~12人舰队编成、远征派遣中心与一键补给修复。',

  mount(container, context) {
    portState.container = container;
    portState.context = context;
    portState.avatarCache.clear();

    context.ui.setPlaceholder('港区备忘：输入内容将记录到行动日志...');
    context.ui.setInputHandler((text) => {
      const flagship = getFlagship();
      context.logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        actorId: flagship?.id || null,
        actorName: flagship?.name || '',
        title: `${flagship ? `[${flagship.name}] ` : ''}港区日志备忘`,
        detail: text,
      });
      context.uiKit.showToast('已记录至行动日志', 'ok');
    });

    context.ui.setQuickActions([
      {
        id: 'port-q-sortie',
        label: '前往出征',
        onClick: () => context.modules.mount('sortie-console'),
      },
      {
        id: 'port-q-commander',
        label: '指挥官卡',
        onClick: () => openCommanderSheet(),
      },
      {
        id: 'port-q-repair',
        label: '一键补给修复',
        onClick: () => {
          const members = context.formation?.getMembers() || [];
          const targets = members.length > 0 ? members : [getFlagship()].filter(Boolean);
          if (targets.length > 0) performResupplyAndRepair(targets);
        },
      },
      {
        id: 'port-q-char',
        label: '角色控制台',
        onClick: () => context.modules.mount('character-console'),
      },
    ]);

    portState.unsubs = [
      context.bus.on('resource:changed', () => renderPortHub()),
      context.bus.on('inventory:equipped', () => renderPortHub()),
      context.bus.on('inventory:unequipped', () => renderPortHub()),
      context.bus.on('inventory:enhanced', () => renderPortHub()),
      context.bus.on('sortie:returned', () => renderPortHub()),
      context.bus.on('commander:updated', () => renderPortHub()),
      context.bus.on('formation:changed', () => renderPortHub()),
      context.bus.on('expedition:dispatched', () => renderPortHub()),
      context.bus.on('expedition:claimed', () => renderPortHub()),
      context.bus.on('expedition:recalled', () => renderPortHub()),
      context.bus.on('storage:changed', (detail) => {
        if (detail?.action === 'resetAll' || detail?.action === 'import') {
          renderPortHub();
        }
      }),
    ];

    portState.timerHandle = setInterval(tickExpeditionCountdowns, 1000);
    renderPortHub();
  },

  unmount() {
    if (portState.timerHandle) {
      clearInterval(portState.timerHandle);
      portState.timerHandle = null;
    }
    for (const unsub of portState.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    portState.unsubs = [];
    portState.container = null;
    portState.context = null;
  },
};
