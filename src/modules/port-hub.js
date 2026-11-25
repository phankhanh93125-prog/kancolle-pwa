/**
 * Official Home Screen Module: Port Hub (`port-hub` · 港区大本营).
 *
 * Complete mobile naval base command center featuring:
 *   1. Top Unified 6-Resource & Dual-Currency Bar
 *   2. Top Commander Character Card Summary (6 stats + 0-base Luck + 3..12 dynamic fleet cap + edit/debug sheet)
 *   3. Center Secretary Interactive Stage (portrait, current outfit, affinity/oath bar, dual-track dialogue bubble,
 *      Talk / Gift / Daily Event / Oath Ceremony / Switch Secretary)
 *   4. Port Operations Bar ("前往出征", "一键补给修复", quick nav to Character Console / Workshop / Compendium Studio / Action Console)
 *   5. Interactive Port Buildings & Facilities Grid:
 *        - Built-in Dormitory (宿舍): assign residents, offline morale/affinity recovery, feed supplies, expand beds
 *        - Built-in Dockyard (船坞): multi-bay repair queue, offline countdown, fast repair, expand bays, construct ship
 *        - Fleet Formation Center (舰队编成): 3..12 dynamic roster & 5 configurable formations
 *        - Expedition Center (远征中心): offline timestamp dispatches & Commander dispatch reward multiplier
 *        - Player-built Custom Facilities (自定义建筑): build, edit, upgrade, station shipgirls, global passive buffs
 */

import { createResourceOverviewBar } from '../core/resource-manager.js';
import {
  COMMANDER_STAT_DEFS,
  COMMANDER_STAT_GROUP_LABELS,
} from '../core/commander-system.js';
import {
  CUSTOM_BUFF_TYPES,
  SHIP_TYPE_PRESETS,
} from '../core/port-buildings.js';
import { CORE_STAT_DEFS, getShipClassSvg, resolveShipClass } from '../core/stat-rules.js';
import { NARRATIVE_MODES } from '../core/prompt-pipeline.js';
import { LOG_CATEGORIES } from '../core/log-system.js';
import {
  getActiveCharacterId,
  openCharacterCardById,
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
  busy: false,
  lastTypewrittenId: null,
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

async function resolveShipAvatarUrl(char) {
  if (!char || !portState.context?.assets) return '';
  const assetId = char.meta?.avatarAssetId || null;
  const cacheKey = `ship::${char.id}::${assetId || 'none'}`;
  if (portState.avatarCache.has(cacheKey)) {
    return portState.avatarCache.get(cacheKey);
  }
  const resolved = await portState.context.assets.getAssetUrl(assetId, {
    fallbackSeed: char.id,
    fallbackLabel: char.name.slice(0, 6),
  });
  portState.avatarCache.set(cacheKey, resolved.url);
  return resolved.url;
}

function jumpToCharacterCard(characterId, activeSheet = null) {
  if (activeSheet && typeof activeSheet.close === 'function') {
    activeSheet.close();
  }
  openCharacterCardById(characterId, portState.context || {});
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
    detail: `恢复：${recoveredParts.join('、')} | 消耗：${costSummary}`,
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
// Bottom Sheet 1: Commander Edit / Allocate / Debug
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
            当前 ${profile.luck === 0 ? '0' : formatSigned(profile.luck)}（初始为 0）
          </span>
        </div>
        <p class="muted-text" style="font-size:12px;">
          不参与常规升级自由加点，仅随特殊事件/里程碑或调试增减（支持正负）。
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
        try {
          await commander.allocateStat(btn.getAttribute('data-cmd-alloc'), 1);
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

// ============================================================
// Bottom Sheets 2~4: Secretary Switch, Gift Picker, Oath Ceremony
// ============================================================

function openSwitchSecretarySheet() {
  const { interaction, uiKit } = portState.context;
  const roster = getCharacters();
  const curId = interaction.getSecretaryId();
  const wrap = document.createElement('div');
  wrap.className = 'lab-stack-sm';

  for (const c of roster) {
    const isCur = c.id === curId;
    const isOath = interaction.isOathed(c.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${isCur ? 'btn-primary' : 'btn-secondary'} uikit-touch-target`;
    btn.dataset.pickSecretary = c.id;
    btn.textContent = `${isOath ? '★ ' : ''}${c.name}（${c.meta?.shipType || '驱逐舰'} · 好感 ${Math.round(c.stats.affinity ?? 0)}）${isCur ? ' · 当前秘书舰' : ''}`;
    btn.addEventListener('click', async () => {
      await interaction.setSecretary(c.id);
      uiKit.showToast(`已指派「${c.name}」担任港区秘书舰`, 'ok');
      sheet.close();
      await renderPortHub();
    });
    wrap.appendChild(btn);
  }

  const sheet = uiKit.openBottomSheet({
    title: '更换港区秘书舰',
    subtitle: '秘书舰将在港区中央互动舞台常驻执勤，响应日常交谈、送礼与誓约',
    content: wrap,
    actions: [{ id: 'close', label: '关闭', tone: 'secondary' }],
  });
}

function openGiftSheet(secretary) {
  const { interaction, resources, entities, rootStorage, uiKit } = portState.context;
  const gifts = interaction.listGifts();
  const wrap = document.createElement('div');
  wrap.className = 'lab-stack-sm';

  for (const g of gifts) {
    const curName = resources.get(g.currency)?.name || g.currency;
    const afford = g.price <= 0 || resources.canAfford({ [g.currency]: g.price }).ok;
    const card = document.createElement('div');
    card.className = 'lab-slot-card';
    card.dataset.giftCard = g.id;
    card.innerHTML = `
      <div class="lab-slot-head">
        <strong>${escapeHtml(g.name)}</strong>
        <span class="status-badge badge-ok">好感 +${g.affinityGain} · 士气 +${g.moraleGain}</span>
      </div>
      <p class="muted-text" style="font-size:12px;">${escapeHtml(g.description || '')}</p>
      <button type="button" class="btn-primary uikit-touch-target" data-send-gift="${escapeHtml(g.id)}" ${afford ? '' : 'disabled'}>
        ${g.price > 0 ? `赠送（消耗 ${curName} ${g.price}）` : '免费赠送'}
      </button>
    `;
    card.querySelector('[data-send-gift]').addEventListener('click', async () => {
      try {
        const res = await interaction.giveGift(secretary.id, g.id);
        await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: secretary.id });
        uiKit.showToast(`赠送「${g.name}」成功：好感 +${res.affDelta}（当前 ${res.afterAff}）`, 'ok');
        sheet.close();
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '赠送失败', 'warn');
      }
    });
    wrap.appendChild(card);
  }

  const sheet = uiKit.openBottomSheet({
    title: `赠送礼物给「${secretary.name}」`,
    subtitle: '含内置礼物与图鉴内容台自定义的专属礼物',
    content: wrap,
    actions: [{ id: 'close', label: '取消', tone: 'secondary' }],
  });
}

function openOathSheet(secretary) {
  const { interaction, entities, rootStorage, uiKit } = portState.context;
  const check = interaction.canOath(secretary.id);
  const existing = interaction.getOathRecord(secretary.id);

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  if (existing) {
    wrap.innerHTML = `
      <div class="surface-card lab-stack-sm">
        <div class="lab-slot-head">
          <strong>★ 已缔结誓约【${escapeHtml(existing.oathTitle)}】</strong>
          <span class="status-badge badge-ok">好感上限 200</span>
        </div>
        <p class="muted-text">誓约效果：全战斗八维属性 +8%，耐久上限 +12，解锁专属誓约互动台词。</p>
        ${existing.customVow ? `<p class="muted-text"><strong>誓言记录：</strong>「${escapeHtml(existing.customVow)}」</p>` : ''}
      </div>
    `;
    uiKit.openBottomSheet({
      title: `誓约纪念 · ${secretary.name}`,
      content: wrap,
      actions: [{ id: 'close', label: '关闭', tone: 'secondary' }],
    });
    return;
  }

  wrap.innerHTML = `
    <p class="muted-text">
      当舰娘好感度达到 <strong>100</strong> 时即可举行誓约仪式，授予专属誓约徽记、突破好感上限至 <strong>200</strong> 并获得全战斗属性 <strong>+8%</strong> 与耐久 <strong>+12</strong> 永久羁绊加成。
    </p>
    <div class="status-badge ${check.ok ? 'badge-ok' : 'badge-warn'}">${escapeHtml(check.reason)}</div>
    <div class="form-group">
      <label class="form-label" for="oath-f-title">誓约称号</label>
      <input id="oath-f-title" class="form-input" type="text" value="永恒誓约" ${check.ok ? '' : 'disabled'}>
    </div>
    <div class="form-group">
      <label class="form-label" for="oath-f-vow">自定义誓言（可选）</label>
      <input id="oath-f-vow" class="form-input" type="text" placeholder="写下你想对她说的话..." ${check.ok ? '' : 'disabled'}>
    </div>
  `;

  uiKit.openBottomSheet({
    title: `誓约仪式 · ${secretary.name}`,
    content: wrap,
    actions: [
      { id: 'cancel', label: '返回', tone: 'secondary' },
      ...(check.ok
        ? [
            {
              id: 'oath',
              label: '★ 举行誓约仪式',
              tone: 'primary',
              onClick: async () => {
                const oathTitle = wrap.querySelector('#oath-f-title').value.trim();
                const customVow = wrap.querySelector('#oath-f-vow').value.trim();
                await interaction.performOath(secretary.id, { oathTitle, customVow });
                await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: secretary.id });
                uiKit.showToast(`★ 与「${secretary.name}」誓约仪式完成！`, 'ok');
                await renderPortHub();
                return true;
              },
            },
          ]
        : []),
    ],
  });
}

// ============================================================
// Bottom Sheet 5: Dormitory Management (宿舍)
// ============================================================

function openDormitorySheet() {
  const { buildings, entities, statRules, formation, expeditions, interaction, rootStorage, uiKit } = portState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  let sheetHandle = null;

  const renderDorm = async () => {
    const dorm = buildings.getDormitoryState();
    const roster = getCharacters();
    const resSet = new Set(dorm.residents);

    const avatarMap = new Map();
    await Promise.all(
      roster.map(async (c) => {
        avatarMap.set(c.id, await resolveShipAvatarUrl(c));
      })
    );

    wrap.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <strong>宿舍 Lv.${dorm.level}（床位 ${dorm.residents.length}/${dorm.capacity}）</strong>
        <span class="status-badge badge-ok">离线自动恢复士气 & 好感</span>
      </div>

      <div class="lab-btn-grid">
        <button type="button" id="btn-dorm-feed" class="btn-primary uikit-touch-target" ${dorm.residents.length === 0 ? 'disabled' : ''}>
          投喂补给（士气+14/好感+2）
        </button>
        <button type="button" id="btn-dorm-expand" class="btn-secondary uikit-touch-target" ${dorm.canExpand ? '' : 'disabled'}>
          ${dorm.canExpand ? `扩建床位 +1（钢${dorm.expandCost.steel}/铝${dorm.expandCost.bauxite}/银${dorm.expandCost.silver}）` : '已达最大床位'}
        </button>
      </div>

      <span class="form-label">当前入住床位（${dorm.residentDetails.length}/${dorm.capacity} · 点头像直达角色卡）</span>
      <div class="lab-stack-sm" id="dorm-resident-list">
        ${
          dorm.residentDetails.length === 0
            ? '<p class="muted-text">宿舍目前空置，可从下方全员花名册分配舰娘入住。</p>'
            : dorm.residentDetails
                .map((r) => {
                  const ent = entities.get(r.id);
                  const prog = ent ? statRules.ensureShipProgression(ent) : { level: 1 };
                  const avUrl = avatarMap.get(r.id) || '';
                  return `
            <div class="lab-slot-card dorm-roster-row" data-dorm-resident="${escapeHtml(r.id)}">
              <div class="dorm-row-main">
                <button type="button" class="avatar-jump-btn" data-jump-char-card="${escapeHtml(r.id)}" title="点击查看「${escapeHtml(r.name)}」精修角色卡">
                  <img class="dorm-mini-avatar" src="${avUrl}" alt="${escapeHtml(r.name)}">
                </button>
                <div class="dorm-row-info">
                  <div class="dorm-row-title">
                    <span class="ship-class-ico">${getShipClassSvg(resolveShipClass(r.shipType), { size: 18 })}</span>
                    <strong>${escapeHtml(r.name)}</strong>
                    <span class="status-badge ship-lv-badge">Lv.${prog.level}</span>
                  </div>
                  <div class="cc-badge-row">
                    <span class="status-badge badge-ok">宿舍休整中</span>
                    <span class="status-badge badge-muted">士气 ${r.morale} · 好感 ${r.affinity}</span>
                  </div>
                </div>
              </div>
              <button type="button" class="btn-secondary uikit-touch-target" data-dorm-remove="${escapeHtml(r.id)}">移出宿舍</button>
            </div>
          `;
                })
                .join('')
        }
      </div>

      <div class="lab-divider"></div>
      <div class="section-header-row" style="margin-bottom:0;">
        <span class="form-label">港区全员花名册（共 ${roster.length} 舰 · 点击头像直达精修角色卡）</span>
      </div>
      <div class="lab-stack-sm" id="dorm-full-roster">
        ${roster
          .map((c) => {
            const inDorm = resSet.has(c.id);
            const prog = statRules.ensureShipProgression(c);
            const avUrl = avatarMap.get(c.id) || '';
            const status = buildings.getCharacterGlobalStatus(c.id, {
              formation,
              expeditions,
              interaction,
            });
            return `
          <div class="lab-slot-card dorm-roster-row" data-dorm-roster-char="${escapeHtml(c.id)}">
            <div class="dorm-row-main">
              <button type="button" class="avatar-jump-btn" data-jump-char-card="${escapeHtml(c.id)}" title="点击查看「${escapeHtml(c.name)}」精修角色卡">
                <img class="dorm-mini-avatar" src="${avUrl}" alt="${escapeHtml(c.name)}">
              </button>
              <div class="dorm-row-info">
                <div class="dorm-row-title">
                  <span class="ship-class-ico">${getShipClassSvg(resolveShipClass(c.meta?.shipType), { size: 18 })}</span>
                  <strong>${escapeHtml(c.name)}</strong>
                  <span class="status-badge ship-lv-badge">Lv.${prog.level}</span>
                </div>
                <div class="cc-badge-row">
                  <span class="status-badge badge-muted">${escapeHtml(c.meta?.shipType || '驱逐舰')}</span>
                  ${status.badges
                    .map(
                      (b) =>
                        `<span class="status-badge badge-${escapeHtml(b.tone)}" data-roster-status="${escapeHtml(b.id)}">${escapeHtml(b.label)}</span>`
                    )
                    .join('')}
                  ${status.isSecretary ? '<span class="status-badge badge-ok">★ 秘书舰</span>' : ''}
                </div>
              </div>
            </div>
            ${
              inDorm
                ? `<button type="button" class="btn-secondary uikit-touch-target" data-dorm-remove="${escapeHtml(c.id)}">移出宿舍</button>`
                : `<button type="button" class="btn-primary uikit-touch-target" data-dorm-assign="${escapeHtml(c.id)}" ${dorm.residents.length >= dorm.capacity ? 'disabled' : ''}>+ 入住宿舍</button>`
            }
          </div>
        `;
          })
          .join('')}
      </div>
    `;

    wrap.querySelectorAll('[data-jump-char-card]').forEach((btn) => {
      btn.addEventListener('click', () => {
        jumpToCharacterCard(btn.getAttribute('data-jump-char-card'), sheetHandle);
      });
    });

    wrap.querySelector('#btn-dorm-feed').addEventListener('click', async () => {
      try {
        const res = await buildings.feedDormitory();
        await persistCharacterRoster({ storage: rootStorage, entities });
        uiKit.showToast(`投喂完成：${res.count} 名入住舰娘士气 +${res.moraleGain}、好感 +${res.affGain}`, 'ok');
        await renderDorm();
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '投喂失败', 'warn');
      }
    });

    wrap.querySelector('#btn-dorm-expand').addEventListener('click', async () => {
      try {
        const next = await buildings.expandDormitory();
        uiKit.showToast(`宿舍已扩建至 ${next.capacity} 床位`, 'ok');
        await renderDorm();
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '扩建失败', 'warn');
      }
    });

    wrap.querySelectorAll('[data-dorm-assign]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await buildings.assignDormResident(btn.getAttribute('data-dorm-assign'));
          uiKit.showToast('已分配入住港区宿舍', 'ok');
          await renderDorm();
          await renderPortHub();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '分配失败', 'warn');
        }
      });
    });

    wrap.querySelectorAll('[data-dorm-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await buildings.removeDormResident(btn.getAttribute('data-dorm-remove'));
        uiKit.showToast('已移出宿舍', 'info');
        await renderDorm();
        await renderPortHub();
      });
    });
  };

  renderDorm();

  sheetHandle = uiKit.openBottomSheet({
    title: '港区宿舍与全员花名册',
    subtitle: '展示仓库全部舰娘全局状态，点击任意头像直达精修角色卡',
    content: wrap,
    actions: [{ id: 'close', label: '完成', tone: 'secondary' }],
  });
}

// ============================================================
// Bottom Sheet 6: Dockyard Management (船坞维修队列 + 新舰建造)
// ============================================================

function openDockyardSheet() {
  const { buildings, entities, rootStorage, uiKit } = portState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const renderDock = () => {
    const dock = buildings.getDockyardState();
    const roster = getCharacters();
    const inDockIds = new Set(dock.queue.map((q) => q.characterId));
    const idleForDock = roster.filter((c) => !inDockIds.has(c.id));

    wrap.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <strong>船坞 Lv.${dock.level}（渠位 ${dock.queue.length}/${dock.capacity}）</strong>
        <button type="button" id="btn-dock-expand" class="btn-secondary uikit-touch-target" style="padding:0 12px;" ${dock.canExpand ? '' : 'disabled'}>
          ${dock.canExpand ? '+ 扩建渠位' : '渠位已满'}
        </button>
      </div>

      <span class="form-label">维修渠位队列（支持离线倒计时自动完成）</span>
      <div class="lab-stack-sm" id="dock-queue-list">
        ${
          dock.queue.length === 0
            ? '<p class="muted-text">当前无入渠维修任务。</p>'
            : dock.queue
                .map(
                  (job) => `
            <div class="lab-slot-card" data-dock-job="${escapeHtml(job.characterId)}">
              <div class="lab-slot-head">
                <strong>${escapeHtml(job.characterName)}</strong>
                <span class="status-badge ${job.ready ? 'badge-ok' : 'badge-warn'}">${escapeHtml(job.remainingText)}</span>
              </div>
              <div class="muted-text" style="font-size:12px;">
                ${job.isMaintenanceOnly ? '预防性船体保养（恢复士气与 AP）' : `修复受损耐久 ${job.missingHp} 点`} · 消耗 钢${job.cost.steel}/铝${job.cost.bauxite}
              </div>
              <div class="lab-btn-row">
                <button type="button" class="btn-primary uikit-touch-target" data-dock-complete="${escapeHtml(job.characterId)}" ${job.ready ? '' : 'disabled'}>
                  ${job.ready ? '出渠完成' : '维修中…'}
                </button>
                ${
                  !job.ready
                    ? `<button type="button" class="btn-secondary uikit-touch-target" data-dock-fast="${escapeHtml(job.characterId)}">快速修复</button>`
                    : ''
                }
              </div>
            </div>
          `
                )
                .join('')
        }
      </div>

      <div class="lab-divider"></div>
      <span class="form-label">选择舰娘入渠维修 / 保养</span>
      <div class="lab-stack-sm" id="dock-candidates-list">
        ${idleForDock
          .map((c) => {
            const plan = buildings.computeDockRepairPlan(c.id);
            return `
            <div class="lab-slot-card">
              <div class="lab-slot-head">
                <strong>${escapeHtml(c.name)}</strong>
                <span class="status-badge ${plan.missingHp > 0 ? 'badge-warn' : 'badge-ok'}">
                  HP ${plan.curHp}/${plan.effMaxHp} · ${escapeHtml(plan.durationText)}
                </span>
              </div>
              <button type="button" class="btn-secondary uikit-touch-target" data-dock-start="${escapeHtml(c.id)}" ${dock.queue.length >= dock.capacity ? 'disabled' : ''}>
                ${plan.isMaintenanceOnly ? '入渠保养' : '入渠维修'}（钢${plan.cost.steel} / 铝${plan.cost.bauxite}）
              </button>
            </div>
          `;
          })
          .join('')}
      </div>

      <div class="lab-divider"></div>
      <div class="surface-card lab-stack-sm" style="padding:10px;">
        <strong style="font-size:13.5px;">船坞新舰建造 / 登记（油80/弹60/钢100/铝50）</strong>
        <div class="lab-kv-grid">
          <input id="dock-build-name" class="form-input" type="text" placeholder="输入新舰名称">
          <select id="dock-build-type" class="form-select">
            ${SHIP_TYPE_PRESETS.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
          </select>
        </div>
        <button type="button" id="btn-dock-construct" class="btn-primary uikit-touch-target">建造并登记新舰</button>
      </div>
    `;

    wrap.querySelector('#btn-dock-expand').addEventListener('click', async () => {
      try {
        const next = await buildings.expandDockyard();
        uiKit.showToast(`船坞渠位扩建至 ${next.capacity} 席`, 'ok');
        renderDock();
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '扩建失败', 'warn');
      }
    });

    wrap.querySelectorAll('[data-dock-start]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const job = await buildings.startDockRepair(btn.getAttribute('data-dock-start'));
          uiKit.showToast(`「${job.characterName}」已入渠（预计 ${job.durationSec}秒）`, 'ok');
          renderDock();
          await renderPortHub();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '入渠失败', 'warn');
        }
      });
    });

    wrap.querySelectorAll('[data-dock-complete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await buildings.completeDockRepair(btn.getAttribute('data-dock-complete'));
          await persistCharacterRoster({ storage: rootStorage, entities });
          uiKit.showToast('维修完成，舰船已出渠！', 'ok');
          renderDock();
          await renderPortHub();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '出渠失败', 'warn');
        }
      });
    });

    wrap.querySelectorAll('[data-dock-fast]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await buildings.completeDockRepair(btn.getAttribute('data-dock-fast'), { fastRepair: true });
          await persistCharacterRoster({ storage: rootStorage, entities });
          uiKit.showToast(`快速修复完成（消耗 ${res.fastMethod}）`, 'ok');
          renderDock();
          await renderPortHub();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '快速修复失败', 'warn');
        }
      });
    });

    wrap.querySelector('#btn-dock-construct').addEventListener('click', async () => {
      const name = wrap.querySelector('#dock-build-name').value.trim();
      const shipType = wrap.querySelector('#dock-build-type').value;
      try {
        const created = await buildings.constructShip({ name, shipType });
        await persistCharacterRoster({ storage: rootStorage, entities });
        uiKit.showToast(`新舰「${created.name}」（${shipType}）建造登记完成！`, 'ok');
        renderDock();
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '建造失败', 'warn');
      }
    });
  };

  renderDock();

  uiKit.openBottomSheet({
    title: '港区船坞（Dockyard）',
    subtitle: '多渠位入渠维修队列（离线计时完成 / 快速修复）与基础新舰建造',
    content: wrap,
    actions: [{ id: 'close', label: '完成', tone: 'secondary' }],
  });
}

// ============================================================
// Bottom Sheet 7 & 8: Custom Building Create/Edit & Manage
// ============================================================

function openCreateCustomBuildingSheet(existing = null) {
  const { buildings, uiKit } = portState.context;
  const isEdit = Boolean(existing);
  const draft = existing
    ? { ...existing }
    : {
        name: '',
        typeTag: '后勤设施',
        description: '',
        stationCap: 2,
        buffType: 'resource_regen',
        buffStat: 'firepower',
        buffValuePerLevel: 6,
        upgradeCost: { steel: 60, bauxite: 30, silver: 60 },
      };

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const renderForm = () => {
    wrap.innerHTML = `
      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="bld-f-name">建筑名称 *</label>
          <input id="bld-f-name" class="form-input" type="text" value="${escapeHtml(draft.name)}" placeholder="例如：海事研究所 / 补给仓库">
        </div>
        <div class="form-group">
          <label class="form-label" for="bld-f-tag">建筑类型标签</label>
          <input id="bld-f-tag" class="form-input" type="text" value="${escapeHtml(draft.typeTag)}" placeholder="后勤 / 科研 / 战术">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="bld-f-desc">功能描述</label>
        <input id="bld-f-desc" class="form-input" type="text" value="${escapeHtml(draft.description)}" placeholder="描述该设施的作用与背景...">
      </div>

      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="bld-f-bufftype">全局增益类型</label>
          <select id="bld-f-bufftype" class="form-select">
            ${CUSTOM_BUFF_TYPES.map(
              (b) => `<option value="${b.id}" ${draft.buffType === b.id ? 'selected' : ''}>${escapeHtml(b.label)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="bld-f-buffval">每级增益幅度</label>
          <input id="bld-f-buffval" class="form-input" type="number" min="1" max="50" value="${Number(draft.buffValuePerLevel ?? 6)}">
        </div>
      </div>

      ${
        draft.buffType === 'stat_boost'
          ? `
        <div class="form-group">
          <label class="form-label" for="bld-f-buffstat">加成目标属性</label>
          <select id="bld-f-buffstat" class="form-select">
            ${CORE_STAT_DEFS.map(
              (d) => `<option value="${d.key}" ${draft.buffStat === d.key ? 'selected' : ''}>${escapeHtml(d.label)}</option>`
            ).join('')}
          </select>
        </div>
      `
          : ''
      }

      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="bld-f-cap">可驻守角色数 (0~6)</label>
          <input id="bld-f-cap" class="form-input" type="number" min="0" max="6" value="${Number(draft.stationCap ?? 2)}">
        </div>
        <div class="form-group">
          <label class="form-label" for="bld-f-steel">升级基准钢材</label>
          <input id="bld-f-steel" class="form-input" type="number" min="0" value="${Number(draft.upgradeCost?.steel ?? 60)}">
        </div>
        <div class="form-group">
          <label class="form-label" for="bld-f-bauxite">升级基准铝材</label>
          <input id="bld-f-bauxite" class="form-input" type="number" min="0" value="${Number(draft.upgradeCost?.bauxite ?? 30)}">
        </div>
        <div class="form-group">
          <label class="form-label" for="bld-f-silver">升级基准银条</label>
          <input id="bld-f-silver" class="form-input" type="number" min="0" value="${Number(draft.upgradeCost?.silver ?? 60)}">
        </div>
      </div>
    `;

    wrap.querySelector('#bld-f-bufftype').addEventListener('change', (e) => {
      draft.name = wrap.querySelector('#bld-f-name').value.trim();
      draft.typeTag = wrap.querySelector('#bld-f-tag').value.trim();
      draft.description = wrap.querySelector('#bld-f-desc').value.trim();
      draft.buffType = e.target.value;
      renderForm();
    });
  };

  renderForm();

  uiKit.openBottomSheet({
    title: isEdit ? `编辑设施 · ${existing.name}` : '建造新自定义建筑',
    subtitle: '自由定义名称、驻守席位、升级消耗与全局被动增益',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: isEdit ? '保存修改' : '确认建造',
        tone: 'primary',
        onClick: async () => {
          const payload = {
            name: wrap.querySelector('#bld-f-name').value.trim(),
            typeTag: wrap.querySelector('#bld-f-tag').value.trim() || '自定义设施',
            description: wrap.querySelector('#bld-f-desc').value.trim(),
            buffType: wrap.querySelector('#bld-f-bufftype').value,
            buffStat: wrap.querySelector('#bld-f-buffstat')?.value || draft.buffStat || 'firepower',
            buffValuePerLevel: Number(wrap.querySelector('#bld-f-buffval').value) || 5,
            stationCap: Number(wrap.querySelector('#bld-f-cap').value) || 2,
            upgradeCost: {
              steel: Number(wrap.querySelector('#bld-f-steel').value) || 0,
              bauxite: Number(wrap.querySelector('#bld-f-bauxite').value) || 0,
              silver: Number(wrap.querySelector('#bld-f-silver').value) || 0,
            },
          };
          try {
            if (isEdit) {
              await buildings.updateCustomBuilding(existing.id, payload);
              uiKit.showToast(`已更新设施「${payload.name}」`, 'ok');
            } else {
              await buildings.createCustomBuilding(payload);
              uiKit.showToast(`自定义建筑「${payload.name}」建造完成！`, 'ok');
            }
            await renderPortHub();
            return true;
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '操作失败', 'warn');
            return false;
          }
        },
      },
    ],
  });
}

function openCustomBuildingDetailSheet(buildingId) {
  const { buildings, resources, uiKit } = portState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const renderDetail = () => {
    const b = buildings.getCustomBuilding(buildingId);
    if (!b) return;
    const roster = getCharacters();
    const stSet = new Set(b.stationedIds || []);
    const costStr = Object.entries(b.nextUpgradeCost || {})
      .map(([k, v]) => `${resources.get(k)?.name || k} ${v}`)
      .join(' / ');

    wrap.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <strong>${escapeHtml(b.name)} · Lv.${b.level}/${b.maxLevel}</strong>
        <span class="status-badge badge-ok">${escapeHtml(b.typeTag)}</span>
      </div>
      <p class="muted-text">${escapeHtml(b.description)}</p>
      <div class="status-badge badge-ok" id="custom-bld-buff-badge">
        当前总增益：${escapeHtml(b.buffLabel)} +${b.totalBuffValue}
      </div>

      <button type="button" id="btn-custom-bld-upgrade" class="btn-primary uikit-touch-target" ${b.level >= b.maxLevel ? 'disabled' : ''}>
        ${b.level >= b.maxLevel ? '已达最高等级' : `升级至 Lv.${b.level + 1}（${escapeHtml(costStr || '免费')}）`}
      </button>

      <div class="lab-divider"></div>
      <span class="form-label">驻守角色（${(b.stationedIds || []).length}/${b.stationCap} · 驻守提升额外增益）</span>
      <div class="chip-row">
        ${roster
          .map((c) => {
            const stationed = stSet.has(c.id);
            return `
            <button type="button" class="preset-chip ${stationed ? 'is-active' : ''}" data-bld-toggle-station="${escapeHtml(c.id)}"
              style="${stationed ? 'border-color:var(--accent);color:var(--text-primary);background:var(--accent-soft);' : ''}">
              ${stationed ? '✓ ' : '+ '}${escapeHtml(c.name)}
            </button>
          `;
          })
          .join('')}
      </div>

      <div class="lab-btn-grid" style="margin-top:8px;">
        <button type="button" id="btn-custom-bld-edit" class="btn-secondary uikit-touch-target">编辑设定</button>
        <button type="button" id="btn-custom-bld-delete" class="btn-danger uikit-touch-target">拆除建筑</button>
      </div>
    `;

    wrap.querySelector('#btn-custom-bld-upgrade').addEventListener('click', async () => {
      try {
        const up = await buildings.upgradeCustomBuilding(b.id);
        uiKit.showToast(`「${up.name}」已升级至 Lv.${up.level}！`, 'ok');
        renderDetail();
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '升级失败', 'warn');
      }
    });

    wrap.querySelectorAll('[data-bld-toggle-station]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cid = btn.getAttribute('data-bld-toggle-station');
        try {
          if (stSet.has(cid)) {
            await buildings.removeCustomStation(b.id, cid);
          } else {
            await buildings.assignCustomStation(b.id, cid);
          }
          renderDetail();
          await renderPortHub();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '驻守调整失败', 'warn');
        }
      });
    });

    wrap.querySelector('#btn-custom-bld-edit').addEventListener('click', () => {
      sheet.close();
      openCreateCustomBuildingSheet(b);
    });

    wrap.querySelector('#btn-custom-bld-delete').addEventListener('click', async () => {
      await buildings.deleteCustomBuilding(b.id);
      uiKit.showToast(`已拆除设施「${b.name}」`, 'info');
      sheet.close();
      await renderPortHub();
    });
  };

  renderDetail();

  const sheet = uiKit.openBottomSheet({
    title: '自定义建筑管理',
    content: wrap,
    actions: [{ id: 'close', label: '完成', tone: 'secondary' }],
  });
}

// ============================================================
// Bottom Sheet 9 & 10: Fleet Formation & Expedition Center Sheets
// ============================================================

function openFormationSheet() {
  const { formation, expeditions, entities, rootStorage, uiKit } = portState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  let sheetHandle = null;

  const renderInner = async () => {
    const fleetState = formation.getState();
    const fleetSummary = fleetState.summary;
    const formationsList = formation.listFormations();
    const roster = getCharacters();
    const inFleetSet = new Set(fleetState.memberIds);
    const idleCandidates = roster.filter((c) => !inFleetSet.has(c.id));
    const staggered = fleetSummary.staggeredStepCost || { fuel: 0, ammo: 0, breakdown: [] };

    const avatarMap = new Map();
    await Promise.all(
      roster.map(async (c) => {
        avatarMap.set(c.id, await resolveShipAvatarUrl(c));
      })
    );

    wrap.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <strong>当前出征编队（${fleetState.count}/${fleetState.cap} 席位）</strong>
        <button type="button" id="btn-sheet-autofill" class="btn-secondary uikit-touch-target" style="padding:0 12px;">一键补满</button>
      </div>

      <div class="chip-row">
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
      <p class="muted-text" style="font-size:12px;">${escapeHtml(fleetState.formation.desc)}</p>

      <div class="port-gear-summary">
        <span class="ns-chip">阶梯单步 油${staggered.fuel}/弹${staggered.ammo}</span>
        <span class="ns-chip">视野 ${fleetSummary.visionRange ?? 2}格</span>
        <span class="ns-chip">火 ${fleetSummary.effective.firepower}</span>
        <span class="ns-chip">雷 ${fleetSummary.effective.torpedo}</span>
        <span class="ns-chip">甲 ${fleetSummary.effective.armor}</span>
        <span class="ns-chip">机 ${fleetSummary.effective.evasion}</span>
        <span class="ns-chip">侦 ${fleetSummary.effective.recon}</span>
        <span class="ns-chip">防空 ${fleetSummary.effective.aa}</span>
        <span class="ns-chip">反潜 ${fleetSummary.effective.asw}</span>
      </div>

      <div class="lab-stack-sm">
        ${fleetSummary.members
          .map((m, idx) => {
            const avUrl = avatarMap.get(m.id) || '';
            const tierLabel = idx < 3 ? '100%' : idx < 6 ? '75%' : '55%';
            return `
          <div class="lab-slot-card dorm-roster-row">
            <div class="dorm-row-main">
              <button type="button" class="avatar-jump-btn" data-jump-char-card="${escapeHtml(m.id)}" title="点击查看「${escapeHtml(m.name)}」精修角色卡">
                <img class="dorm-mini-avatar" src="${avUrl}" alt="${escapeHtml(m.name)}">
              </button>
              <div class="dorm-row-info">
                <div class="dorm-row-title">
                  <span class="ship-class-ico">${getShipClassSvg(m.classCode || resolveShipClass(m.shipType), { size: 18 })}</span>
                  <strong>${idx === 0 ? '★ 旗舰' : `僚机 #${idx}`} · ${escapeHtml(m.name)}</strong>
                </div>
                <div class="cc-badge-row">
                  <span class="status-badge badge-muted">${escapeHtml(m.shipType)} · HP ${m.hp}/${m.maxHp}</span>
                  <span class="status-badge badge-ok">阶梯 ${tierLabel}</span>
                </div>
              </div>
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
        `;
          })
          .join('')}
      </div>

      ${
        idleCandidates.length > 0
          ? `
        <div class="lab-divider"></div>
        <span class="form-label">待命舰娘（点击头像直达角色卡）</span>
        <div class="lab-stack-sm">
          ${idleCandidates
            .map((c) => {
              const check = formation.canAddMember(c.id);
              const disp = expeditions.isCharacterDispatched(c.id);
              const avUrl = avatarMap.get(c.id) || '';
              return `
              <div class="lab-slot-card dorm-roster-row">
                <div class="dorm-row-main">
                  <button type="button" class="avatar-jump-btn" data-jump-char-card="${escapeHtml(c.id)}" title="点击查看「${escapeHtml(c.name)}」精修角色卡">
                    <img class="dorm-mini-avatar" src="${avUrl}" alt="${escapeHtml(c.name)}">
                  </button>
                  <div class="dorm-row-info">
                    <div class="dorm-row-title">
                      <span class="ship-class-ico">${getShipClassSvg(resolveShipClass(c.meta?.shipType), { size: 18 })}</span>
                      <strong>${escapeHtml(c.name)}</strong>
                    </div>
                    <span class="status-badge ${disp ? 'badge-warn' : check.ok ? 'badge-ok' : 'badge-muted'}">
                      ${disp ? '远征中' : check.ok ? '可入队' : '暂不可用'}
                    </span>
                  </div>
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
    `;

    wrap.querySelectorAll('[data-jump-char-card]').forEach((btn) => {
      btn.addEventListener('click', () => {
        jumpToCharacterCard(btn.getAttribute('data-jump-char-card'), sheetHandle);
      });
    });

    wrap.querySelector('#btn-sheet-autofill').addEventListener('click', async () => {
      await formation.autoFillFleet();
      await renderInner();
      await renderPortHub();
    });
    wrap.querySelectorAll('[data-select-formation]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await formation.setFormation(btn.getAttribute('data-select-formation'));
        await renderInner();
        await renderPortHub();
      });
    });
    wrap.querySelectorAll('[data-fleet-promote]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-fleet-promote');
        await formation.setFlagship(id);
        await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: id });
        await renderInner();
        await renderPortHub();
      });
    });
    wrap.querySelectorAll('[data-fleet-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await formation.removeMember(btn.getAttribute('data-fleet-remove'));
        await renderInner();
        await renderPortHub();
      });
    });
    wrap.querySelectorAll('[data-fleet-add]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await formation.addMember(btn.getAttribute('data-fleet-add'));
          await renderInner();
          await renderPortHub();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '无法入队', 'warn');
        }
      });
    });
  };

  renderInner();

  sheetHandle = uiKit.openBottomSheet({
    title: '出征舰队编成（3~12 人动态上限）',
    subtitle: '1~3舰100% / 4~6舰75% / 7~12舰55% 阶梯消耗 · 点击头像直达角色卡',
    content: wrap,
    actions: [{ id: 'close', label: '完成', tone: 'secondary' }],
  });
}

function openExpeditionSheet() {
  const { expeditions, inventory, resources, entities, rootStorage, formation, commander, uiKit } = portState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const renderInner = () => {
    const missions = expeditions.listMissions();
    const activeRuns = expeditions.listActiveRuns();
    const selectedMission =
      missions.find((m) => m.id === portState.selectedExpMissionId) || missions[0];
    const roster = getCharacters();
    const inFleetSet = new Set(formation.getMemberIds());
    const dispatchable = roster.filter(
      (c) => inventory.checkSeaworthiness(c.id).seaworthy && !expeditions.isCharacterDispatched(c.id)
    );
    const validSet = new Set(dispatchable.map((c) => c.id));
    portState.selectedExpShipIds = portState.selectedExpShipIds.filter((id) => validSet.has(id));
    if (portState.selectedExpShipIds.length === 0 && dispatchable.length > 0) {
      const pref = dispatchable.find((c) => !inFleetSet.has(c.id)) || dispatchable[dispatchable.length - 1];
      if (pref) portState.selectedExpShipIds = [pref.id];
    }

    wrap.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <strong>进行中远征（${activeRuns.length}）</strong>
        <span class="status-badge badge-ok">调度收益 x${commander.getExpeditionRewardMultiplier().toFixed(2)}</span>
      </div>

      ${
        activeRuns.length > 0
          ? activeRuns
              .map(
                (run) => `
          <div class="lab-slot-card" data-exp-run="${escapeHtml(run.id)}">
            <div class="lab-slot-head">
              <strong>${escapeHtml(run.missionName)}</strong>
              <span class="status-badge ${run.ready ? 'badge-ok' : 'badge-warn'}">${escapeHtml(run.remainingText)}</span>
            </div>
            <div class="muted-text" style="font-size:12px;">舰船：${escapeHtml(run.ships.map((s) => s.name).join('、'))}</div>
            <div class="lab-btn-row">
              <button type="button" class="btn-primary uikit-touch-target" data-exp-claim="${escapeHtml(run.id)}" ${run.ready ? '' : 'disabled'}>
                ${run.ready ? '一键领取物资' : '倒计时中…'}
              </button>
              <button type="button" class="btn-secondary uikit-touch-target" data-exp-recall="${escapeHtml(run.id)}">召回</button>
            </div>
          </div>
        `
              )
              .join('')
          : '<p class="muted-text" style="font-size:12px;">暂无进行中的远征任务。</p>'
      }

      <div class="lab-divider"></div>
      <div class="form-group">
        <label class="form-label" for="sheet-exp-mission">选择远征任务</label>
        <select id="sheet-exp-mission" class="form-select">
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
      <p class="muted-text" style="font-size:12px;">
        预计回报：${escapeHtml(
          Object.entries(selectedMission.projectedRewards)
            .map(([k, v]) => `${resources.get(k)?.name || k} +${v}`)
            .join(' / ')
        )} · 指挥官 EXP +${selectedMission.commanderExp}
      </p>
      <div class="chip-row">
        ${dispatchable
          .map((c) => {
            const picked = portState.selectedExpShipIds.includes(c.id);
            return `
            <button type="button" class="preset-chip ${picked ? 'is-active' : ''}" data-exp-pick="${escapeHtml(c.id)}"
              style="${picked ? 'border-color:var(--accent);color:var(--text-primary);background:var(--accent-soft);' : ''}">
              ${escapeHtml(c.name)}
            </button>
          `;
          })
          .join('')}
      </div>
      <button type="button" id="btn-sheet-dispatch-exp" class="btn-primary uikit-touch-target"
        ${portState.selectedExpShipIds.length < selectedMission.minShips ? 'disabled' : ''}>
        派遣远征出发
      </button>
    `;

    wrap.querySelector('#sheet-exp-mission').addEventListener('change', (e) => {
      portState.selectedExpMissionId = e.target.value;
      renderInner();
    });
    wrap.querySelectorAll('[data-exp-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cid = btn.getAttribute('data-exp-pick');
        if (portState.selectedExpShipIds.includes(cid)) {
          portState.selectedExpShipIds = portState.selectedExpShipIds.filter((id) => id !== cid);
        } else if (portState.selectedExpShipIds.length < selectedMission.maxShips) {
          portState.selectedExpShipIds.push(cid);
        }
        renderInner();
      });
    });
    wrap.querySelector('#btn-sheet-dispatch-exp').addEventListener('click', async () => {
      try {
        const run = await expeditions.dispatch(selectedMission.id, portState.selectedExpShipIds);
        portState.selectedExpShipIds = [];
        uiKit.showToast(`远征「${run.missionName}」已出发！`, 'ok');
        renderInner();
        await renderPortHub();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '派遣失败', 'warn');
      }
    });
    wrap.querySelectorAll('[data-exp-claim]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await expeditions.claim(btn.getAttribute('data-exp-claim'));
          await persistCharacterRoster({ storage: rootStorage, entities });
          uiKit.showToast(`远征领取成功！指挥官 EXP +${res.commanderExp}`, 'ok');
          renderInner();
          await renderPortHub();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '领取失败', 'warn');
        }
      });
    });
    wrap.querySelectorAll('[data-exp-recall]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await expeditions.recall(btn.getAttribute('data-exp-recall'));
        uiKit.showToast('已召回远征舰船', 'info');
        renderInner();
        await renderPortHub();
      });
    });
  };

  renderInner();

  uiKit.openBottomSheet({
    title: '港区远征派遣中心',
    subtitle: '关闭页面仍按真实时间戳倒计时，完成后按指挥官「调度」加成结算',
    content: wrap,
    actions: [{ id: 'close', label: '完成', tone: 'secondary' }],
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
    buildings,
    interaction,
    narrative,
    fxStage,
    theme,
    rootStorage,
    modules,
    uiKit,
  } = portState.context;

  const cmdProfile = commander.getProfile();
  const fleetState = formation.getState();
  const fleetSummary = fleetState.summary;
  const secretary = interaction.getSecretary() || getFlagship();
  const dorm = buildings.getDormitoryState();
  const dock = buildings.getDockyardState();
  const customBlds = buildings.listCustomBuildings();
  const activeExps = expeditions.listActiveRuns();
  const globalBuffs = buildings.getGlobalBuffSummary();

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

  // 1. Unified 6-Resource & Dual-Currency Overview Bar (Always pinned top)
  root.appendChild(createResourceOverviewBar(resources, { showCaps: true, id: 'port-resource-bar' }));

  const sectionElements = {};

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
        </div>
      </div>
    </div>

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

    <button type="button" id="btn-port-edit-commander" class="btn-secondary uikit-touch-target">
      指挥官加点 / 资料编辑与调试
    </button>
  `;
  cmdCard.querySelector('#btn-port-edit-commander').addEventListener('click', () => openCommanderSheet());
  sectionElements.commander = cmdCard;

  // 3. Center Secretary Daily Interaction & Oath Stage
  let freshSpeechInfo = null;
  if (secretary) {
    const assetId = secretary.meta?.avatarAssetId || null;
    const cacheKey = `sec::${secretary.id}::${assetId || 'none'}`;
    let secAvatarUrl = portState.avatarCache.get(cacheKey);
    if (!secAvatarUrl) {
      const resolved = await assets.getAssetUrl(assetId, {
        fallbackSeed: secretary.id,
        fallbackLabel: secretary.name.slice(0, 6),
      });
      secAvatarUrl = resolved.url;
      portState.avatarCache.set(cacheKey, secAvatarUrl);
    }

    const eqMap = inventory.getCharacterEquipment(secretary.id);
    const secProg = statRules.ensureShipProgression(secretary);
    const outfitName = eqMap.outfit?.name || '日常港区便装';
    const seaworthyInfo = statRules.evaluateSeaworthiness(inventory, secretary.id);
    const isOathed = interaction.isOathed(secretary.id);
    const oathRec = interaction.getOathRecord(secretary.id);
    const maxAff = interaction.getMaxAffinityFor(secretary.id);
    const curAff = Math.round(Number(secretary.stats.affinity ?? 0));
    const affStage = statRules.getAffinityStage(Math.min(100, curAff), {
      thresholdReduction: cmdProfile.effects.affinityThresholdReduction,
    });
    const canOathNow = interaction.canOath(secretary.id).ok;
    const lastTalk = interaction.getLastInteraction();
    const speechText =
      lastTalk && lastTalk.characterId === secretary.id
        ? lastTalk.text
        : secretary.meta?.speechHabit || `「${secretary.name} 正在港区秘书舰执勤中，指挥官有什么安排？」`;
    const isAiMode = narrative.getMode() !== NARRATIVE_MODES.LOCAL;

    const secCard = document.createElement('section');
    secCard.className = 'surface-card lab-stack-sm';
    secCard.id = 'port-secretary-stage';
    secCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h2 class="section-title">秘书舰互动舞台</h2>
        <button type="button" id="btn-sec-mode-toggle" class="ac-mode-toggle ${isAiMode ? 'is-ai' : ''}">
          ${isAiMode ? 'AI 对话增强' : '纯本地台词'}
        </button>
      </div>

      <div class="cc-hero-row">
        <button type="button" class="avatar-jump-btn" id="btn-port-sec-jump-card" data-jump-char-card="${escapeHtml(secretary.id)}" title="点击头像直达精修角色卡">
          <img class="cc-avatar" id="port-sec-avatar" src="${secAvatarUrl}" alt="${escapeHtml(secretary.name)}">
        </button>
        <div class="cc-hero-info">
          <div class="cc-hero-name-row">
            <span class="ship-class-ico">${getShipClassSvg(resolveShipClass(secretary.meta?.shipType), { size: 20 })}</span>
            <h3 class="cc-hero-name" id="port-sec-name">${isOathed ? '★ ' : ''}${escapeHtml(secretary.name)}</h3>
            <span class="status-badge ship-lv-badge" id="port-sec-level-badge">Lv.${secProg.level}</span>
            <span class="status-badge ${seaworthyInfo.seaworthy ? 'badge-ok' : 'badge-danger'}" id="port-seaworthy-badge">
              ${seaworthyInfo.seaworthy ? '适航' : '未适航'}
            </span>
          </div>
          <div class="cc-badge-row">
            <span class="status-badge badge-ok">${escapeHtml(secretary.meta?.shipType || '驱逐舰')}</span>
            <span class="status-badge badge-muted">服装：${escapeHtml(outfitName)}</span>
            <span class="status-badge ${isOathed ? 'badge-ok' : 'badge-warn'}" id="port-sec-aff-badge">
              ${isOathed ? `誓约·${escapeHtml(oathRec?.oathTitle || '永恒')}` : affStage.label} (${curAff}/${maxAff})
            </span>
          </div>
        </div>
      </div>

      <div class="sec-dialogue-bubble" id="port-sec-dialogue">
        ${escapeHtml(speechText)}
      </div>

      <div id="port-sec-bars" class="lab-stack-sm"></div>

      <div class="lab-btn-grid">
        <button type="button" id="btn-sec-talk" class="btn-primary uikit-touch-target" ${portState.busy ? 'disabled' : ''}>日常交谈</button>
        <button type="button" id="btn-sec-gift" class="btn-secondary uikit-touch-target">赠送礼物</button>
        <button type="button" id="btn-sec-event" class="btn-secondary uikit-touch-target" ${portState.busy ? 'disabled' : ''}>港区日常事件</button>
        <button type="button" id="btn-sec-oath" class="${canOathNow || isOathed ? 'btn-primary' : 'btn-secondary'} uikit-touch-target">
          ${isOathed ? '★ 誓约纪念' : canOathNow ? '★ 举行誓约仪式' : `誓约 (${curAff}/100)`}
        </button>
      </div>
      <button type="button" id="btn-sec-switch" class="btn-secondary uikit-touch-target">更换秘书舰</button>
    `;

    const secBars = secCard.querySelector('#port-sec-bars');
    const secExpBar = uiKit.createProgressBar({
      label: `旗舰经验 (Lv.${secProg.level} · EXP ${secProg.exp}/${secProg.maxExp})`,
      value: secProg.exp,
      max: secProg.maxExp,
      tone: 'ok',
    });
    secExpBar.element.id = 'port-sec-exp-bar';
    secBars.appendChild(secExpBar.element);
    secBars.appendChild(
      uiKit.createProgressBar({
        label: isOathed ? `誓约好感度 (${curAff}/${maxAff})` : `好感阶段 · ${affStage.label} (${curAff}/${maxAff})`,
        value: curAff,
        max: maxAff,
        tone: isOathed || canOathNow ? 'ok' : 'accent',
      }).element
    );
    secBars.appendChild(
      uiKit.createProgressBar({
        label: `士气（${statRules.getMoraleLabel(secretary.stats.morale)}）`,
        value: Math.round(Number(secretary.stats.morale ?? 70)),
        max: 100,
        tone: (secretary.stats.morale ?? 70) < 30 ? 'danger' : 'accent',
      }).element
    );

    secCard.querySelector('#btn-port-sec-jump-card').addEventListener('click', () => {
      jumpToCharacterCard(secretary.id);
    });

    secCard.querySelector('#btn-sec-mode-toggle').addEventListener('click', () => {
      const next = isAiMode ? NARRATIVE_MODES.LOCAL : NARRATIVE_MODES.AI_POLISH;
      narrative.setMode(next);
      uiKit.showToast(next === NARRATIVE_MODES.LOCAL ? '秘书舰互动切换为纯本地离线台词' : '秘书舰互动切换为 AI 对话增强', 'ok');
      renderPortHub();
    });

    secCard.querySelector('#btn-sec-talk').addEventListener('click', async () => {
      if (portState.busy) return;
      portState.busy = true;
      try {
        const res = await interaction.talkToSecretary({ characterId: secretary.id });
        await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: secretary.id });
        uiKit.showToast(`好感 +${res.affDelta}（${res.afterAff}） · 士气 +${res.moraleDelta}`, 'ok');
      } finally {
        portState.busy = false;
        await renderPortHub();
      }
    });

    secCard.querySelector('#btn-sec-gift').addEventListener('click', () => openGiftSheet(secretary));

    secCard.querySelector('#btn-sec-event').addEventListener('click', async () => {
      if (portState.busy) return;
      portState.busy = true;
      try {
        const res = await interaction.triggerDailyPortEvent(secretary.id);
        await persistCharacterRoster({ storage: rootStorage, entities, activeCharacterId: secretary.id });
        uiKit.showToast(`日常事件「${res.title}」：好感 +${res.affDelta}`, 'ok');
      } finally {
        portState.busy = false;
        await renderPortHub();
      }
    });

    secCard.querySelector('#btn-sec-oath').addEventListener('click', () => openOathSheet(secretary));
    secCard.querySelector('#btn-sec-switch').addEventListener('click', () => openSwitchSecretarySheet());

    if (lastTalk && lastTalk.characterId === secretary.id && lastTalk.timestamp && portState.lastTypewrittenId !== lastTalk.timestamp) {
      portState.lastTypewrittenId = lastTalk.timestamp;
      freshSpeechInfo = {
        el: secCard.querySelector('#port-sec-dialogue'),
        text: speechText,
      };
    }

    sectionElements.secretary = secCard;
  }

  // 4. Streamlined Port Operations Strip (Quick Sortie CTA + One-Tap Resupply)
  const serviceTargets = fleetState.count > 0 ? formation.getMembers() : secretary ? [secretary] : [];
  const servicePlan = computeFleetServicePlan(serviceTargets);
  const costText = servicePlan.needsService
    ? Object.entries(servicePlan.cost)
        .map(([k, v]) => `${resources.get(k)?.name || k} ${v}`)
        .join(' · ')
    : '出征舰队状态已满，随时可以启航';

  const opsCard = document.createElement('section');
  opsCard.className = 'surface-card lab-stack-sm';
  opsCard.id = 'port-ops-card';
  opsCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">港区快捷出击与整备</h2>
      <span class="status-badge badge-muted" id="port-fleet-slot-badge">${fleetState.count} / ${fleetState.cap} 席位</span>
    </div>
    <button type="button" id="btn-port-goto-sortie" class="btn-primary port-cta-btn">出征海图（${fleetState.count}舰 · ${escapeHtml(fleetSummary.formationName)}）</button>
    <button type="button" id="btn-port-resupply-repair" class="btn-secondary uikit-touch-target">
      一键补给与入渠修复（${serviceTargets.length}舰）
    </button>
    <p class="muted-text" id="port-service-cost-hint" style="font-size:12px;">整备预计：${escapeHtml(costText)}</p>
  `;

  opsCard.querySelector('#btn-port-goto-sortie').addEventListener('click', () => {
    if (modules.has('sortie-console')) modules.mount('sortie-console', { transition: 'left' });
  });
  opsCard.querySelector('#btn-port-resupply-repair').addEventListener('click', () =>
    performResupplyAndRepair(serviceTargets)
  );
  sectionElements.operations = opsCard;

  // 5. Dedicated Full-Screen Facilities Entry Hub (出征海图 / 舰队编成 / 舰娘宿舍 / 船坞整备 / 远征派遣 / 仓库工坊 / 图鉴内容库)
  const buffParts = [];
  if (globalBuffs.resourceRegenPct > 0) buffParts.push(`资源恢复 +${globalBuffs.resourceRegenPct}%`);
  if (globalBuffs.expBoostPct > 0) buffParts.push(`经验获取 +${globalBuffs.expBoostPct}%`);
  if (globalBuffs.moraleBoostPct > 0) buffParts.push(`士气恢复 +${globalBuffs.moraleBoostPct}%`);
  for (const [k, v] of Object.entries(globalBuffs.statBonuses || {})) {
    buffParts.push(`${k} +${v}`);
  }

  const itemCount = inventory ? inventory.listItems().length : 0;
  const charCount = entities ? entities.list({ kind: 'character' }).length : 0;

  const bldCard = document.createElement('section');
  bldCard.className = 'surface-card lab-stack-sm';
  bldCard.id = 'port-buildings-card';
  bldCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">港区功能设施（独立全屏页）</h2>
      <span class="status-badge badge-ok">${7 + customBlds.length} 个入口</span>
    </div>
    ${
      buffParts.length > 0
        ? `<p class="muted-text" style="font-size:12px;" id="port-custom-buffs-summary">自定义设施全局增益：<strong>${escapeHtml(buffParts.join(' · '))}</strong></p>`
        : ''
    }

    <div class="port-facility-grid-2" id="port-buildings-grid">
      <button type="button" class="port-building-tile is-featured" id="btn-open-sortie-hub" data-open-facility="sortie">
        <div class="port-building-head">
          <strong>出征海图</strong>
          <span class="status-badge badge-ok">8~15节点</span>
        </div>
        <span class="port-building-sub">分岔雷达海图 · 独立全屏战术战斗</span>
      </button>

      <button type="button" class="port-building-tile" id="btn-open-formation" data-open-facility="formation">
        <div class="port-building-head">
          <strong>舰队编成</strong>
          <span class="status-badge badge-ok">${fleetState.count}/${fleetState.cap}舰</span>
        </div>
        <span class="port-building-sub">${escapeHtml(fleetSummary.formationName)} · 3~12人阶梯消耗</span>
      </button>

      <button type="button" class="port-building-tile" id="btn-open-dormitory" data-open-facility="dormitory">
        <div class="port-building-head">
          <strong>舰娘宿舍 · Lv.${dorm.level}</strong>
          <span class="status-badge badge-ok">${dorm.residents.length}/${dorm.capacity}床</span>
        </div>
        <span class="port-building-sub">全员花名册（${charCount}名）· 离线回士气</span>
      </button>

      <button type="button" class="port-building-tile" id="btn-open-dockyard" data-open-facility="dockyard">
        <div class="port-building-head">
          <strong>船坞整备 · Lv.${dock.level}</strong>
          <span class="status-badge ${dock.queue.length > 0 ? 'badge-warn' : 'badge-ok'}">${dock.queue.length}/${dock.capacity}渠位</span>
        </div>
        <span class="port-building-sub">入渠维修队列 · 新舰随机性格建造</span>
      </button>

      <button type="button" class="port-building-tile" id="btn-open-expedition" data-open-facility="expedition">
        <div class="port-building-head">
          <strong>远征派遣</strong>
          <span class="status-badge ${activeExps.length > 0 ? 'badge-warn' : 'badge-muted'}">${activeExps.length}支执行</span>
        </div>
        <span class="port-building-sub">离线计时后勤 · 调度 x${cmdProfile.effects.expeditionRewardMultiplier.toFixed(2)}</span>
      </button>

      <button type="button" class="port-building-tile" id="btn-open-workshop-hub" data-open-facility="workshop">
        <div class="port-building-head">
          <strong>仓库工坊</strong>
          <span class="status-badge badge-ok">${itemCount} 件</span>
        </div>
        <span class="port-building-sub">紧凑分类装备仓储 · 强化与补给商店</span>
      </button>

      <button type="button" class="port-building-tile" id="btn-open-compendium-hub" data-open-facility="compendium">
        <div class="port-building-head">
          <strong>图鉴与内容库</strong>
          <span class="status-badge badge-ok">大礼包/剧情</span>
        </div>
        <span class="port-building-sub">全要素图鉴 · 分支剧情包与模组导入</span>
      </button>

      <button type="button" class="port-building-tile" id="btn-open-charcard-hub" data-open-facility="character">
        <div class="port-building-head">
          <strong>舰娘角色卡</strong>
          <span class="status-badge badge-muted">${charCount} 名</span>
        </div>
        <span class="port-building-sub">八维属性 · 性格词库与自定义槽位</span>
      </button>

      ${customBlds
        .map(
          (b) => `
        <button type="button" class="port-building-tile is-custom" data-open-custom-building="${escapeHtml(b.id)}">
          <div class="port-building-head">
            <strong>${escapeHtml(b.name)} · Lv.${b.level}</strong>
            <span class="status-badge badge-ok">${escapeHtml(b.typeTag)}</span>
          </div>
          <span class="port-building-sub">驻守 ${(b.stationedIds || []).length}/${b.stationCap} · ${escapeHtml(b.buffLabel)} +${b.totalBuffValue}</span>
        </button>
      `
        )
        .join('')}
    </div>

    <button type="button" id="btn-port-new-building" class="btn-primary uikit-touch-target">+ 建造新自定义建筑</button>
  `;

  bldCard.querySelector('#btn-open-sortie-hub').addEventListener('click', () => {
    if (modules.has('sortie-console')) modules.mount('sortie-console', { transition: 'left' });
  });
  bldCard.querySelector('#btn-open-formation').addEventListener('click', () => {
    if (modules.has('port-formation')) modules.mount('port-formation', { transition: 'left' });
  });
  bldCard.querySelector('#btn-open-dormitory').addEventListener('click', () => {
    if (modules.has('port-dormitory')) modules.mount('port-dormitory', { transition: 'left' });
  });
  bldCard.querySelector('#btn-open-dockyard').addEventListener('click', () => {
    if (modules.has('port-dockyard')) modules.mount('port-dockyard', { transition: 'left' });
  });
  bldCard.querySelector('#btn-open-expedition').addEventListener('click', () => {
    if (modules.has('port-expedition')) modules.mount('port-expedition', { transition: 'left' });
  });
  bldCard.querySelector('#btn-open-workshop-hub').addEventListener('click', () => {
    if (modules.has('supply-workshop')) modules.mount('supply-workshop', { transition: 'left' });
  });
  bldCard.querySelector('#btn-open-compendium-hub').addEventListener('click', () => {
    if (modules.has('compendium-studio')) modules.mount('compendium-studio', { transition: 'left' });
  });
  bldCard.querySelector('#btn-open-charcard-hub').addEventListener('click', () => {
    if (modules.has('character-console')) modules.mount('character-console', { transition: 'left' });
  });
  bldCard.querySelector('#btn-port-new-building').addEventListener('click', () => openCreateCustomBuildingSheet(null));

  bldCard.querySelectorAll('[data-open-custom-building]').forEach((btn) => {
    btn.addEventListener('click', () => openCustomBuildingDetailSheet(btn.getAttribute('data-open-custom-building')));
  });

  sectionElements.buildings = bldCard;

  // Render cards according to user's Modular Port Hub Layout (order & visibility)
  const layoutOrder = theme
    ? theme.getPortLayout()
    : [
        { id: 'commander', visible: true },
        { id: 'secretary', visible: true },
        { id: 'operations', visible: true },
        { id: 'buildings', visible: true },
      ];

  let appendedCount = 0;
  for (const entry of layoutOrder) {
    if (entry.visible !== false && sectionElements[entry.id]) {
      root.appendChild(sectionElements[entry.id]);
      appendedCount += 1;
    }
  }
  if (appendedCount === 0) {
    const emptyHint = document.createElement('section');
    emptyHint.className = 'surface-card';
    emptyHint.innerHTML = '<p class="muted-text">所有港区卡片已在桌面布局中隐藏，请点击顶部「主题」按钮恢复显示。</p>';
    root.appendChild(emptyHint);
  }

  portState.container.appendChild(root);

  if (freshSpeechInfo && freshSpeechInfo.el && fxStage && typeof fxStage.typewrite === 'function') {
    const speedMs = theme ? theme.getTypewriterSpeed() : 18;
    fxStage.typewrite(freshSpeechInfo.el, freshSpeechInfo.text, { speedMs });
  }
}

export default {
  id: 'port-hub',
  name: '港区大本营',
  description: '港区大本营主中枢：指挥官角色卡、秘书舰日常互动与誓约舞台、宿舍/船坞/编队/远征与自定义港区建筑设施。',

  mount(container, context) {
    portState.container = container;
    portState.context = context;
    portState.avatarCache.clear();

    context.ui.setPlaceholder('和秘书舰聊聊任何话题，直接发送即可触发对话...');
    context.ui.setInputHandler(async (text) => {
      const sec = context.interaction?.getSecretary();
      if (sec) {
        const res = await context.interaction.talkToSecretary({ characterId: sec.id, customTopic: text });
        await persistCharacterRoster({ storage: context.rootStorage, entities: context.entities, activeCharacterId: sec.id });
        context.uiKit.showToast(`「${sec.name}」回应了你：好感 +${res.affDelta}`, 'ok');
        await renderPortHub();
      }
    });

    context.ui.setQuickActions([
      {
        id: 'port-q-sortie',
        label: '前往出征',
        onClick: () => context.modules.mount('sortie-console'),
      },
      {
        id: 'port-q-dorm',
        label: '宿舍管理',
        onClick: () => openDormitorySheet(),
      },
      {
        id: 'port-q-dock',
        label: '船坞维修',
        onClick: () => openDockyardSheet(),
      },
      {
        id: 'port-q-compendium',
        label: '图鉴与剧情包',
        onClick: () => context.modules.mount('compendium-studio'),
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
      context.bus.on('buildings:updated', () => renderPortHub()),
      context.bus.on('interaction:talked', () => renderPortHub()),
      context.bus.on('interaction:gifted', () => renderPortHub()),
      context.bus.on('interaction:oathed', () => renderPortHub()),
      context.bus.on('character:exp-gained', () => renderPortHub()),
      context.bus.on('character:leveled-up', () => renderPortHub()),
      context.bus.on('theme:layout-changed', () => renderPortHub()),
      context.bus.on('storage:changed', (detail) => {
        if (detail?.action === 'resetAll' || detail?.action === 'import') {
          renderPortHub();
        }
      }),
    ];

    // Periodically auto-settle finished dockyard repairs while user stays in Port Hub
    portState.timerHandle = setInterval(() => {
      if (context.buildings) {
        const dock = context.buildings.getDockyardState();
        if (dock.queue.some((q) => q.ready)) {
          context.buildings.settleOfflineBuildings().then(() => renderPortHub());
        }
      }
    }, 3000);

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
