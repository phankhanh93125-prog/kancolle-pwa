/**
 * Official Business Module: Full-Spectrum Compendium & Custom Content Studio (`compendium-studio`).
 *
 * Provides two mobile-first tabs:
 *   1. 全要素图鉴 (Compendium):
 *        - Overall collection rate progress bar
 *        - 4 sub-categories: 舰娘图鉴 / 装备与服装图鉴 / 敌舰档案（含掉落表）/ 海域航线图鉴
 *   2. 自定义内容与模组管理 (Custom Content & Mod Studio):
 *        - Visual mobile forms to create/delete Custom Enemy Templates, Custom Secretary Dialogue Templates,
 *          and Custom Gift Items
 *        - One-tap Full World JSON Mod Export (characters, buildings, equipment, enemies, routes, dialogues, gifts)
 *          and External JSON Mod Import (Merge or Replace)
 */

import { NODE_TYPES } from '../core/route-generator.js';
import { createResourceOverviewBar } from '../core/resource-manager.js';
import { persistCharacterRoster } from './character-console.js';

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

let csState = {
  container: null,
  context: null,
  mainTab: 'compendium', // 'compendium' | 'studio'
  compSubTab: 'shipgirls', // 'shipgirls' | 'equipment' | 'enemies' | 'routes'
  lastExportSummary: null,
  unsubs: [],
};

// ============================================================
// Sub-Modals for Adding Custom Content
// ============================================================

function openNewEnemySheet() {
  const { contentManager, uiKit } = csState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="ce-name">敌舰名称 *</label>
        <input id="ce-name" class="form-input" type="text" placeholder="例如：深海重巡旗舰">
      </div>
      <div class="form-group">
        <label class="form-label" for="ce-tier">层级分类</label>
        <select id="ce-tier" class="form-select">
          <option value="${NODE_TYPES.ENCOUNTER}">常规遭遇战</option>
          <option value="${NODE_TYPES.ELITE}">精英封锁战</option>
          <option value="${NODE_TYPES.BOSS}">终点主力决战 (Boss)</option>
        </select>
      </div>
    </div>
    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="ce-hp">耐久 HP</label>
        <input id="ce-hp" class="form-input" type="number" min="20" max="2000" value="95">
      </div>
      <div class="form-group">
        <label class="form-label" for="ce-armor">装甲</label>
        <input id="ce-armor" class="form-input" type="number" min="0" max="100" value="8">
      </div>
      <div class="form-group">
        <label class="form-label" for="ce-atk">攻击力</label>
        <input id="ce-atk" class="form-input" type="number" min="3" max="120" value="15">
      </div>
      <div class="form-group">
        <label class="form-label" for="ce-weak">弱点类型</label>
        <select id="ce-weak" class="form-select">
          <option value="shelling">炮击弱点</option>
          <option value="torpedo">鱼雷弱点</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="ce-air">航空威胁值</label>
        <input id="ce-air" class="form-input" type="number" min="0" max="100" value="14">
      </div>
      <div class="form-group">
        <label class="form-label" for="ce-sub">潜艇威胁值</label>
        <input id="ce-sub" class="form-input" type="number" min="0" max="100" value="0">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="ce-drops">掉落表描述（逗号分隔）</label>
      <input id="ce-drops" class="form-input" type="text" value="钢材 90, 铝材 50, 银条 160">
    </div>
  `;

  uiKit.openBottomSheet({
    title: '新建自定义敌舰模板',
    subtitle: '新建后自动收入敌舰档案，并会在出征随机航线遭遇战中按层级抽取',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: '保存敌舰模板',
        tone: 'primary',
        onClick: async () => {
          try {
            const enemy = await contentManager.createCustomEnemy({
              name: wrap.querySelector('#ce-name').value.trim(),
              tier: wrap.querySelector('#ce-tier').value,
              hp: Number(wrap.querySelector('#ce-hp').value),
              armor: Number(wrap.querySelector('#ce-armor').value),
              attackPower: Number(wrap.querySelector('#ce-atk').value),
              weakness: wrap.querySelector('#ce-weak').value,
              airThreat: Number(wrap.querySelector('#ce-air').value),
              subThreat: Number(wrap.querySelector('#ce-sub').value),
              drops: wrap.querySelector('#ce-drops').value,
            });
            uiKit.showToast(`已新增自定义敌舰「${enemy.name}」`, 'ok');
            renderCompendiumStudio();
            return true;
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '保存失败', 'warn');
            return false;
          }
        },
      },
    ],
  });
}

function openNewDialogueSheet() {
  const { contentManager, uiKit } = csState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="cd-stage">适用好感阶段</label>
      <select id="cd-stage" class="form-select">
        <option value="any">全阶段通用</option>
        <option value="stranger">初识</option>
        <option value="familiar">熟悉</option>
        <option value="trusted">信赖</option>
        <option value="close">亲密</option>
        <option value="oath">誓约专属</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="cd-text">台词模板（支持 {actor.name} / {outfit} / {commander.name} / {speechHabit}）*</label>
      <textarea id="cd-text" class="form-textarea" placeholder="例如：身着{outfit}的{actor.name}笑着向{commander.name}招手：「今天海面风平浪静，一起巡航吧！」"></textarea>
    </div>
  `;

  uiKit.openBottomSheet({
    title: '新建自定义日常互动台词',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: '保存台词模板',
        tone: 'primary',
        onClick: async () => {
          try {
            await contentManager.createCustomDialogue({
              stage: wrap.querySelector('#cd-stage').value,
              text: wrap.querySelector('#cd-text').value.trim(),
            });
            uiKit.showToast('已保存自定义互动台词模板', 'ok');
            renderCompendiumStudio();
            return true;
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '保存失败', 'warn');
            return false;
          }
        },
      },
    ],
  });
}

function openNewGiftSheet() {
  const { contentManager, uiKit } = csState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="cg-name">礼物名称 *</label>
      <input id="cg-name" class="form-input" type="text" placeholder="例如：星海八音盒">
    </div>
    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="cg-cur">消耗货币</label>
        <select id="cg-cur" class="form-select">
          <option value="silver">银条</option>
          <option value="gold">金条</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="cg-price">价格</label>
        <input id="cg-price" class="form-input" type="number" min="0" value="50">
      </div>
      <div class="form-group">
        <label class="form-label" for="cg-aff">好感加成</label>
        <input id="cg-aff" class="form-input" type="number" min="1" max="100" value="12">
      </div>
      <div class="form-group">
        <label class="form-label" for="cg-mor">士气加成</label>
        <input id="cg-mor" class="form-input" type="number" min="0" max="100" value="12">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="cg-desc">礼物描述</label>
      <input id="cg-desc" class="form-input" type="text" placeholder="填写礼物简介...">
    </div>
  `;

  uiKit.openBottomSheet({
    title: '新建自定义礼物道具',
    subtitle: '新建后自动出现在「港区大本营 → 秘书舰赠送礼物」列表中',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: '保存礼物',
        tone: 'primary',
        onClick: async () => {
          try {
            const gift = await contentManager.createCustomGift({
              name: wrap.querySelector('#cg-name').value.trim(),
              currency: wrap.querySelector('#cg-cur').value,
              price: Number(wrap.querySelector('#cg-price').value),
              affinityGain: Number(wrap.querySelector('#cg-aff').value),
              moraleGain: Number(wrap.querySelector('#cg-mor').value),
              description: wrap.querySelector('#cg-desc').value.trim(),
            });
            uiKit.showToast(`已新增自定义礼物「${gift.name}」`, 'ok');
            renderCompendiumStudio();
            return true;
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '保存失败', 'warn');
            return false;
          }
        },
      },
    ],
  });
}

// ============================================================
// Tab 1: Full-Spectrum Compendium Renderer
// ============================================================

function renderCompendiumTab(host) {
  const { contentManager, uiKit } = csState.context;
  const report = contentManager.getCompendiumReport();

  const summaryCard = document.createElement('section');
  summaryCard.className = 'surface-card lab-stack-sm';
  summaryCard.id = 'cs-compendium-summary';
  summaryCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">全要素图鉴总览</h2>
      <span class="status-badge badge-ok" id="cs-overall-rate">总收集率 ${report.overallRate}%（${report.totalUnlocked}/${report.totalAll}）</span>
    </div>
    <div id="cs-overall-bar"></div>
    <div class="port-gear-summary">
      <span class="ns-chip">舰娘 ${report.stats.shipgirls.unlocked}/${report.stats.shipgirls.total}</span>
      <span class="ns-chip">装备服装 ${report.stats.equipment.unlocked}/${report.stats.equipment.total}</span>
      <span class="ns-chip">敌舰 ${report.stats.enemies.unlocked}/${report.stats.enemies.total}</span>
      <span class="ns-chip">航线 ${report.stats.routes.unlocked}（通关 ${report.stats.routes.cleared}）</span>
    </div>
    <div class="lab-btn-grid" id="cs-subtab-btns">
      <button type="button" class="${csState.compSubTab === 'shipgirls' ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-comp-sub="shipgirls">舰娘图鉴 (${report.shipgirls.length})</button>
      <button type="button" class="${csState.compSubTab === 'equipment' ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-comp-sub="equipment">装备与服装 (${report.equipment.length})</button>
      <button type="button" class="${csState.compSubTab === 'enemies' ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-comp-sub="enemies">敌舰档案 (${report.enemies.length})</button>
      <button type="button" class="${csState.compSubTab === 'routes' ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" data-comp-sub="routes">海域航线 (${report.routes.length})</button>
    </div>
  `;
  summaryCard.querySelector('#cs-overall-bar').appendChild(
    uiKit.createProgressBar({
      label: '港区图鉴收集进度',
      value: report.totalUnlocked,
      max: report.totalAll,
      tone: 'accent',
    }).element
  );
  summaryCard.querySelectorAll('[data-comp-sub]').forEach((btn) => {
    btn.addEventListener('click', () => {
      csState.compSubTab = btn.getAttribute('data-comp-sub');
      renderCompendiumStudio();
    });
  });
  host.appendChild(summaryCard);

  const listCard = document.createElement('section');
  listCard.className = 'surface-card lab-stack-sm';
  listCard.id = 'cs-compendium-list';

  if (csState.compSubTab === 'shipgirls') {
    listCard.innerHTML = `
      <h3 class="section-title">舰娘图鉴（${report.shipgirls.length} 名）</h3>
      ${report.shipgirls
        .map(
          (s) => `
        <div class="lab-slot-card" data-comp-ship="${escapeHtml(s.id)}">
          <div class="lab-slot-head">
            <strong>${s.oathed ? '★ ' : ''}${escapeHtml(s.name)}</strong>
            <span class="status-badge badge-ok">${escapeHtml(s.shipType)} · 好感 ${s.affinity}</span>
          </div>
          <div class="port-gear-summary">
            <span class="ns-chip">耐 ${s.stats.maxHp}</span>
            <span class="ns-chip">火 ${s.stats.firepower}</span>
            <span class="ns-chip">甲 ${s.stats.armor}</span>
            <span class="ns-chip">雷 ${s.stats.torpedo}</span>
            <span class="ns-chip">机 ${s.stats.evasion}</span>
            <span class="ns-chip">侦 ${s.stats.recon}</span>
            <span class="ns-chip">防空 ${s.stats.aa}</span>
            <span class="ns-chip">反潜 ${s.stats.asw}</span>
          </div>
        </div>
      `
        )
        .join('')}
    `;
  } else if (csState.compSubTab === 'equipment') {
    listCard.innerHTML = `
      <h3 class="section-title">装备与服装图鉴（${report.equipment.length} 件）</h3>
      ${report.equipment
        .map(
          (it) => `
        <div class="lab-slot-card" data-comp-equip="${escapeHtml(it.id)}">
          <div class="lab-slot-head">
            <strong>${escapeHtml(it.name)}${it.level > 0 ? ` +${it.level}` : ''}</strong>
            <span class="status-badge badge-muted">${escapeHtml(it.categoryLabel)} ×${it.quantity}</span>
          </div>
          <p class="muted-text" style="font-size:12px;">${escapeHtml(it.description || '无描述')}</p>
          <div class="port-gear-summary">
            ${(it.bonuses || [])
              .map((b) => `<span class="ns-chip">${escapeHtml(b.stat)} ${formatSigned(b.value)}</span>`)
              .join('') || '<span class="ns-chip">无属性词条</span>'}
          </div>
        </div>
      `
        )
        .join('')}
    `;
  } else if (csState.compSubTab === 'enemies') {
    listCard.innerHTML = `
      <h3 class="section-title">敌舰档案（${report.enemies.length} 类）</h3>
      ${report.enemies
        .map(
          (e) => `
        <div class="lab-slot-card" data-comp-enemy="${escapeHtml(e.id)}">
          <div class="lab-slot-head">
            <strong>${escapeHtml(e.name)}</strong>
            <span class="status-badge ${e.unlocked ? 'badge-ok' : 'badge-muted'}">
              ${e.builtIn ? (e.unlocked ? '已遭遇' : '未遭遇') : '自定义敌舰'}
            </span>
          </div>
          <div class="port-gear-summary">
            <span class="ns-chip">HP ${e.hp}</span>
            <span class="ns-chip">甲 ${e.armor}</span>
            <span class="ns-chip">攻 ${e.attackPower}</span>
            <span class="ns-chip">弱点 ${escapeHtml(e.weaknessLabel)}</span>
            ${e.airThreat > 0 ? `<span class="ns-chip">空袭威胁 ${e.airThreat}</span>` : ''}
            ${e.subThreat > 0 ? `<span class="ns-chip">潜艇威胁 ${e.subThreat}</span>` : ''}
          </div>
          <div class="muted-text" style="font-size:11.5px;">掉落列表：${escapeHtml((e.drops || []).join(' · ') || '常规物资')}</div>
        </div>
      `
        )
        .join('')}
    `;
  } else {
    listCard.innerHTML = `
      <h3 class="section-title">海域航线图鉴（${report.routes.length} 条）</h3>
      ${report.routes
        .map(
          (r) => `
        <div class="lab-slot-card" data-comp-route="${escapeHtml(r.id)}">
          <div class="lab-slot-head">
            <strong>${escapeHtml(r.name)}</strong>
            <span class="status-badge ${r.cleared ? 'badge-ok' : 'badge-muted'}">
              ${r.cleared ? '已通关' : r.builtIn ? '预设航线' : '自定义航线'} · ${r.nodeCount}节点
            </span>
          </div>
          <p class="muted-text" style="font-size:12px;">${escapeHtml(r.description || '')}（海况：${escapeHtml(r.seaConditionLabel)}）</p>
        </div>
      `
        )
        .join('')}
    `;
  }

  host.appendChild(listCard);
}

// ============================================================
// Tab 2: Custom Content & World Mod Studio Renderer
// ============================================================

function renderStudioTab(host) {
  const { contentManager, entities, rootStorage, uiKit } = csState.context;
  const customEnemies = contentManager.listCustomEnemies();
  const customDialogues = contentManager.listCustomDialogues();
  const customGifts = contentManager.listCustomGifts();

  // 1. World Mod JSON Export / Import Card
  const modCard = document.createElement('section');
  modCard.className = 'surface-card lab-stack-sm';
  modCard.id = 'cs-mod-card';
  modCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">世界内容 JSON 模组导出 / 导入</h2>
      <span class="status-badge badge-ok">批量内容包</span>
    </div>
    <p class="muted-text" style="font-size:12px;">
      一键打包导出当前全量自定义内容（角色、建筑、装备、敌舰、航线、台词、礼物、誓约），或导入外部 JSON 模组进行合并 / 覆盖。
    </p>
    <button type="button" id="btn-cs-export-mod" class="btn-primary uikit-touch-target">导出世界内容 JSON 模组包</button>
    <div class="lab-btn-grid">
      <button type="button" id="btn-cs-import-merge" class="btn-secondary uikit-touch-target">导入 JSON（合并）</button>
      <button type="button" id="btn-cs-import-replace" class="btn-secondary uikit-touch-target">导入 JSON（覆盖）</button>
    </div>
    <input type="file" id="cs-mod-file-input" accept="application/json,.json" hidden>
    ${
      csState.lastExportSummary
        ? `<div class="status-badge badge-ok" id="cs-export-feedback">${escapeHtml(csState.lastExportSummary)}</div>`
        : ''
    }
  `;

  modCard.querySelector('#btn-cs-export-mod').addEventListener('click', () => {
    const pack = contentManager.exportWorldMod();
    const jsonText = JSON.stringify(pack, null, 2);
    const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `world-content-mod-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    const p = pack.payload;
    csState.lastExportSummary = `已导出模组包：角色 ${p.characters.length} · 物品 ${(p.inventory?.items || []).length} · 自定义建筑 ${(p.buildings?.customBuildings || []).length} · 敌舰 ${p.customEnemies.length} · 台词 ${p.customDialogues.length} · 礼物 ${p.customGifts.length}`;
    uiKit.showToast('世界内容 JSON 模组包已导出！', 'ok');
    renderCompendiumStudio();
  });

  let pendingImportMode = 'merge';
  const fileInput = modCard.querySelector('#cs-mod-file-input');
  modCard.querySelector('#btn-cs-import-merge').addEventListener('click', () => {
    pendingImportMode = 'merge';
    fileInput.click();
  });
  modCard.querySelector('#btn-cs-import-replace').addEventListener('click', () => {
    pendingImportMode = 'replace';
    fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const counts = await contentManager.importWorldMod(text, { mode: pendingImportMode });
      await persistCharacterRoster({ storage: rootStorage, entities });
      uiKit.showToast(`模组导入成功（${pendingImportMode === 'replace' ? '覆盖' : '合并'}）：角色 ${counts.characters} / 敌舰 ${counts.enemies} / 建筑 ${counts.buildings}`, 'ok');
      renderCompendiumStudio();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '导入失败', 'error');
    } finally {
      fileInput.value = '';
    }
  });
  host.appendChild(modCard);

  // 2. Custom Enemies Section
  const enemyCard = document.createElement('section');
  enemyCard.className = 'surface-card lab-stack-sm';
  enemyCard.id = 'cs-custom-enemies-card';
  enemyCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h3 class="section-title">自定义敌舰模板（${customEnemies.length}）</h3>
      <button type="button" id="btn-cs-new-enemy" class="btn-primary uikit-touch-target" style="padding:0 14px;">+ 新增敌舰</button>
    </div>
    ${
      customEnemies.length === 0
        ? '<p class="muted-text" style="font-size:12px;">暂无自定义敌舰。新增后将同步显示在敌舰档案并加入出征随机遭遇池。</p>'
        : customEnemies
            .map(
              (e) => `
        <div class="lab-slot-card">
          <div class="lab-slot-head">
            <strong>${escapeHtml(e.name)}</strong>
            <span class="status-badge badge-muted">HP ${e.hp} / 甲 ${e.armor} / 攻 ${e.attackPower}</span>
          </div>
          <button type="button" class="btn-danger uikit-touch-target" data-del-enemy="${escapeHtml(e.id)}">删除模板</button>
        </div>
      `
            )
            .join('')
    }
  `;
  enemyCard.querySelector('#btn-cs-new-enemy').addEventListener('click', () => openNewEnemySheet());
  enemyCard.querySelectorAll('[data-del-enemy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await contentManager.deleteCustomEnemy(btn.getAttribute('data-del-enemy'));
      uiKit.showToast('已删除自定义敌舰', 'info');
      renderCompendiumStudio();
    });
  });
  host.appendChild(enemyCard);

  // 3. Custom Dialogues Section
  const dlgCard = document.createElement('section');
  dlgCard.className = 'surface-card lab-stack-sm';
  dlgCard.id = 'cs-custom-dialogues-card';
  dlgCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h3 class="section-title">自定义秘书舰台词模板（${customDialogues.length}）</h3>
      <button type="button" id="btn-cs-new-dlg" class="btn-secondary uikit-touch-target" style="padding:0 14px;">+ 新增台词</button>
    </div>
    ${
      customDialogues.length === 0
        ? '<p class="muted-text" style="font-size:12px;">暂无自定义台词模板。新增后会在港区秘书舰日常交谈中自动抽取。</p>'
        : customDialogues
            .map(
              (d) => `
        <div class="lab-slot-card">
          <div class="muted-text" style="font-size:12px;">[${escapeHtml(d.stage)}] ${escapeHtml(d.text)}</div>
          <button type="button" class="btn-danger uikit-touch-target" data-del-dlg="${escapeHtml(d.id)}">删除</button>
        </div>
      `
            )
            .join('')
    }
  `;
  dlgCard.querySelector('#btn-cs-new-dlg').addEventListener('click', () => openNewDialogueSheet());
  dlgCard.querySelectorAll('[data-del-dlg]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await contentManager.deleteCustomDialogue(btn.getAttribute('data-del-dlg'));
      uiKit.showToast('已删除台词模板', 'info');
      renderCompendiumStudio();
    });
  });
  host.appendChild(dlgCard);

  // 4. Custom Gifts Section
  const giftCard = document.createElement('section');
  giftCard.className = 'surface-card lab-stack-sm';
  giftCard.id = 'cs-custom-gifts-card';
  giftCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h3 class="section-title">自定义礼物道具（${customGifts.length}）</h3>
      <button type="button" id="btn-cs-new-gift" class="btn-secondary uikit-touch-target" style="padding:0 14px;">+ 新增礼物</button>
    </div>
    ${
      customGifts.length === 0
        ? '<p class="muted-text" style="font-size:12px;">暂无自定义礼物。新增后可直接用于港区秘书舰赠礼互动。</p>'
        : customGifts
            .map(
              (g) => `
        <div class="lab-slot-card">
          <div class="lab-slot-head">
            <strong>${escapeHtml(g.name)}</strong>
            <span class="status-badge badge-ok">好感 +${g.affinityGain} · 士气 +${g.moraleGain}</span>
          </div>
          <button type="button" class="btn-danger uikit-touch-target" data-del-gift="${escapeHtml(g.id)}">删除</button>
        </div>
      `
            )
            .join('')
    }
  `;
  giftCard.querySelector('#btn-cs-new-gift').addEventListener('click', () => openNewGiftSheet());
  giftCard.querySelectorAll('[data-del-gift]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await contentManager.deleteCustomGift(btn.getAttribute('data-del-gift'));
      uiKit.showToast('已删除自定义礼物', 'info');
      renderCompendiumStudio();
    });
  });
  host.appendChild(giftCard);
}

// ============================================================
// Root Renderer
// ============================================================

function renderCompendiumStudio() {
  if (!csState.container || !csState.context) return;
  const { resources, modules } = csState.context;

  csState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'module-stack';

  root.appendChild(createResourceOverviewBar(resources, { id: 'cs-resource-bar' }));

  const navCard = document.createElement('section');
  navCard.className = 'surface-card lab-stack-sm';
  navCard.innerHTML = `
    <div class="lab-btn-grid" id="cs-main-tabs">
      <button type="button" id="btn-cs-tab-compendium" class="${csState.mainTab === 'compendium' ? 'btn-primary' : 'btn-secondary'} uikit-touch-target">全要素图鉴</button>
      <button type="button" id="btn-cs-tab-studio" class="${csState.mainTab === 'studio' ? 'btn-primary' : 'btn-secondary'} uikit-touch-target">自定义内容与模组</button>
    </div>
    <button type="button" id="btn-cs-back-port" class="btn-secondary uikit-touch-target">返回港区大本营</button>
  `;
  navCard.querySelector('#btn-cs-tab-compendium').addEventListener('click', () => {
    csState.mainTab = 'compendium';
    renderCompendiumStudio();
  });
  navCard.querySelector('#btn-cs-tab-studio').addEventListener('click', () => {
    csState.mainTab = 'studio';
    renderCompendiumStudio();
  });
  navCard.querySelector('#btn-cs-back-port').addEventListener('click', () => {
    if (modules.has('port-hub')) modules.mount('port-hub');
  });
  root.appendChild(navCard);

  if (csState.mainTab === 'compendium') {
    renderCompendiumTab(root);
  } else {
    renderStudioTab(root);
  }

  csState.container.appendChild(root);
}

export default {
  id: 'compendium-studio',
  name: '图鉴与内容台',
  description: '全要素图鉴（舰娘/装备服装/敌舰档案/海域航线收集统计）与自定义敌舰/台词/礼物/JSON世界模组导出导入管理台。',

  mount(container, context) {
    csState.container = container;
    csState.context = context;

    context.ui.setPlaceholder('快速新增一条全阶段秘书舰互动台词模板，发送即入库...');
    context.ui.setInputHandler(async (text) => {
      await context.contentManager.createCustomDialogue({ stage: 'any', text });
      context.uiKit.showToast('已快捷添加为自定义互动台词模板', 'ok');
      renderCompendiumStudio();
    });

    context.ui.setQuickActions([
      {
        id: 'cs-q-comp',
        label: '全要素图鉴',
        onClick: () => {
          csState.mainTab = 'compendium';
          renderCompendiumStudio();
        },
      },
      {
        id: 'cs-q-studio',
        label: '内容与模组',
        onClick: () => {
          csState.mainTab = 'studio';
          renderCompendiumStudio();
        },
      },
      {
        id: 'cs-q-new-enemy',
        label: '+ 自定义敌舰',
        onClick: () => openNewEnemySheet(),
      },
      {
        id: 'cs-q-port',
        label: '返回港区',
        onClick: () => context.modules.mount('port-hub'),
      },
    ]);

    csState.unsubs = [
      context.bus.on('content:updated', () => renderCompendiumStudio()),
      context.bus.on('content:mod-imported', () => renderCompendiumStudio()),
      context.bus.on('character:saved', () => renderCompendiumStudio()),
      context.bus.on('inventory:item-created', () => renderCompendiumStudio()),
    ];

    renderCompendiumStudio();
  },

  unmount() {
    for (const unsub of csState.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    csState.unsubs = [];
    csState.container = null;
    csState.context = null;
  },
};
