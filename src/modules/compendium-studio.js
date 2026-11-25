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
import { PACK_CATEGORIES, PACK_CATEGORY_LABELS } from '../core/story-pack-engine.js';
import { NARRATIVE_MODES } from '../core/prompt-pipeline.js';
import { triggerJsonDownload } from '../core/save-manager.js';
import { getItemIconSvg } from '../core/inventory-system.js';
import { ITEM_RARITY_MAP, inferItemRarity } from '../core/stat-rules.js';
import { persistCharacterRoster } from './character-console.js';
import { openEquipmentOutfitEditorSheet } from './supply-workshop.js';

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
  mainTab: 'compendium', // 'compendium' | 'story' | 'studio'
  compSubTab: 'shipgirls', // 'shipgirls' | 'equipment' | 'enemies' | 'routes'
  activePackId: 'pack_abyssal_ruins_4ch',
  activeNodeId: null,
  lastStoryOutcome: null,
  lastRenderedNodeKey: null,
  storyBusy: false,
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
    const customTemplates = report.customEquipment || [];
    listCard.innerHTML = `
      <div class="section-header-row" style="margin-bottom:0;">
        <h3 class="section-title">装备与服装图鉴（${report.equipment.length} 仓库 / ${customTemplates.length} 自定义模板）</h3>
        <button type="button" id="btn-cs-new-eq-tpl" class="btn-primary uikit-touch-target" style="padding:0 12px;">+ 新建装备/服装</button>
      </div>

      ${
        customTemplates.length > 0
          ? `
        <div class="lab-stack-sm" id="cs-custom-eq-list">
          <strong style="font-size:12.5px; color:var(--accent-hover);">本地自定义装备与服装模板（支持随世界模组 JSON 导出/导入）</strong>
          ${customTemplates
            .map((tpl) => {
              const rId = inferItemRarity(tpl);
              const rDef = ITEM_RARITY_MAP[rId] || ITEM_RARITY_MAP.common;
              return `
              <div class="lab-slot-card is-rarity-${rId}" data-custom-eq-tpl="${escapeHtml(tpl.id)}">
                <div class="lab-slot-head">
                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <span class="wh-item-ico">${getItemIconSvg(tpl, { size: 20 })}</span>
                    <span class="rarity-pill is-rarity-${rId}">${escapeHtml(rDef.label)}</span>
                    <strong>${escapeHtml(tpl.name)}</strong>
                    ${tpl.outfitStyle ? `<span class="status-badge badge-ok">风格:${escapeHtml(tpl.outfitStyle)}</span>` : ''}
                  </div>
                </div>
                <p class="muted-text" style="font-size:12px;">${escapeHtml(tpl.description || '无描述')}</p>
                <div class="port-gear-summary">
                  ${(tpl.bonuses || [])
                    .map((b) => `<span class="ns-chip">${escapeHtml(b.stat)} ${formatSigned(b.value)}</span>`)
                    .join('') || '<span class="ns-chip">无属性词条</span>'}
                </div>
                <div class="lab-btn-grid">
                  <button type="button" class="btn-primary uikit-touch-target" data-issue-tpl="${escapeHtml(tpl.id)}">一键发放到仓库</button>
                  <button type="button" class="btn-secondary uikit-touch-target" data-edit-tpl="${escapeHtml(tpl.id)}">编辑模板</button>
                  <button type="button" class="btn-danger uikit-touch-target" data-del-tpl="${escapeHtml(tpl.id)}">删除</button>
                </div>
              </div>
            `;
            })
            .join('')}
        </div>
        <div class="lab-divider"></div>
      `
          : ''
      }

      ${report.equipment
        .map((it) => {
          const rId = inferItemRarity(it);
          const rDef = ITEM_RARITY_MAP[rId] || ITEM_RARITY_MAP.common;
          const canEdit = it.category !== 'consumable';
          return `
        <div class="lab-slot-card is-rarity-${rId}" data-comp-equip="${escapeHtml(it.id)}">
          <div class="lab-slot-head">
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span class="wh-item-ico">${getItemIconSvg(it, { size: 18 })}</span>
              <span class="rarity-pill is-rarity-${rId}">${escapeHtml(rDef.shortLabel)}</span>
              <strong>${escapeHtml(it.name)}${it.level > 0 ? ` +${it.level}` : ''}</strong>
              ${it.outfitStyle ? `<span class="status-badge badge-ok">${escapeHtml(it.outfitStyle)}</span>` : ''}
            </div>
            <span class="status-badge badge-muted">${escapeHtml(it.categoryLabel)} ×${it.quantity}</span>
          </div>
          <p class="muted-text" style="font-size:12px;">${escapeHtml(it.description || '无描述')}</p>
          <div class="port-gear-summary">
            ${(it.bonuses || [])
              .map((b) => `<span class="ns-chip">${escapeHtml(b.stat)} ${formatSigned(b.value)}</span>`)
              .join('') || '<span class="ns-chip">无属性词条</span>'}
          </div>
          ${
            canEdit
              ? `<button type="button" class="btn-secondary uikit-touch-target" data-edit-comp-item="${escapeHtml(it.id)}">编辑品级/属性</button>`
              : ''
          }
        </div>
      `;
        })
        .join('')}
    `;

    listCard.querySelector('#btn-cs-new-eq-tpl')?.addEventListener('click', () => {
      openEquipmentOutfitEditorSheet(csState.context, {
        onSaved: () => renderCompendiumStudio(),
      });
    });

    listCard.querySelectorAll('[data-edit-comp-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-edit-comp-item');
        const realItem = csState.context.inventory?.getItem(id);
        if (!realItem) return;
        openEquipmentOutfitEditorSheet(csState.context, {
          item: realItem,
          onSaved: () => renderCompendiumStudio(),
        });
      });
    });

    listCard.querySelectorAll('[data-issue-tpl]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-issue-tpl');
        try {
          const issued = await contentManager.issueEquipmentToWarehouse(id, 1);
          uiKit.showToast(`已发放「${issued[0]?.name || '自定义物品'}」×1 到仓库！`, 'ok');
          renderCompendiumStudio();
        } catch (err) {
          uiKit.showToast(err instanceof Error ? err.message : '发放失败', 'warn');
        }
      });
    });

    listCard.querySelectorAll('[data-edit-tpl]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-edit-tpl');
        const tpl = customTemplates.find((t) => t.id === id);
        if (!tpl) return;
        openEquipmentOutfitEditorSheet(csState.context, {
          template: tpl,
          onSaved: () => renderCompendiumStudio(),
        });
      });
    });

    listCard.querySelectorAll('[data-del-tpl]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del-tpl');
        await contentManager.deleteCustomEquipmentTemplate(id);
        uiKit.showToast('已删除自定义装备/服装模板', 'info');
        renderCompendiumStudio();
      });
    });
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
  const { contentManager, storyPacks, personalityPool, statRules, entities, rootStorage, uiKit } = csState.context;
  const customEnemies = contentManager.listCustomEnemies();
  const customDialogues = contentManager.listCustomDialogues();
  const customGifts = contentManager.listCustomGifts();

  // 1. World Mod JSON Export / Import Card (File Upload + Direct Paste JSON Text)
  const modCard = document.createElement('section');
  modCard.className = 'surface-card lab-stack-sm';
  modCard.id = 'cs-mod-card';
  modCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">世界内容 JSON 模组导出 / 导入</h2>
      <span class="status-badge badge-ok">文件 + 粘贴双入口</span>
    </div>
    <p class="muted-text" style="font-size:12px;">
      支持导出/上传 <code>.json</code> 文件，或直接粘贴角色、装备/服装、性格词条、敌舰、剧情/事件包 JSON 文本一键识别合并入库。
    </p>
    <button type="button" id="btn-cs-export-mod" class="btn-primary uikit-touch-target">导出世界内容 JSON 模组包</button>
    <div class="lab-btn-grid">
      <button type="button" id="btn-cs-import-merge" class="btn-secondary uikit-touch-target">选择文件导入（合并）</button>
      <button type="button" id="btn-cs-import-replace" class="btn-secondary uikit-touch-target">选择文件导入（覆盖）</button>
    </div>
    <input type="file" id="cs-mod-file-input" accept="application/json,.json" hidden>

    <div class="lab-divider"></div>
    <div class="form-group">
      <label class="form-label" for="cs-paste-json-input">直接粘贴 JSON 文本导入（自动识别角色 / 装备服装 / 性格词条 / 剧情包 / 完整模组）</label>
      <textarea
        id="cs-paste-json-input"
        class="form-textarea"
        style="min-height:96px; font-family:var(--font-mono); font-size:12px;"
        placeholder='在此粘贴 JSON 文本（支持含 \`\`\`json 代码块包裹的 AI 输出，例如 {"name":"460mm主炮","equipmentType":"main_gun","rarity":"legendary","bonuses":[{"stat":"firepower","value":45}]} ）'
      ></textarea>
    </div>
    <button type="button" id="btn-cs-paste-import" class="btn-primary uikit-touch-target">粘贴 JSON 文本一键合并导入</button>
    ${
      csState.lastExportSummary
        ? `<div class="status-badge badge-ok" id="cs-export-feedback" style="white-space:normal;">${escapeHtml(csState.lastExportSummary)}</div>`
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
      if (pendingImportMode === 'replace') {
        const counts = await contentManager.importWorldMod(text, { mode: 'replace' });
        await persistCharacterRoster({ storage: rootStorage, entities });
        uiKit.showToast(`模组覆盖导入成功：角色 ${counts.characters} / 敌舰 ${counts.enemies} / 建筑 ${counts.buildings}`, 'ok');
      } else {
        const res = await contentManager.smartImportJSONText(text, {
          mode: 'merge',
          storyPacks,
          personalityPool,
          statRules,
        });
        await persistCharacterRoster({ storage: rootStorage, entities });
        csState.lastExportSummary = res.summaryText;
        uiKit.showToast(res.summaryText, 'ok');
      }
      renderCompendiumStudio();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '导入失败', 'error');
    } finally {
      fileInput.value = '';
    }
  });

  modCard.querySelector('#btn-cs-paste-import').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const area = modCard.querySelector('#cs-paste-json-input');
    const rawText = area?.value || '';
    if (!rawText.trim()) {
      uiKit.showToast('请先在文本框中粘贴 JSON 内容', 'warn');
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const res = await contentManager.smartImportJSONText(rawText, {
        mode: 'merge',
        storyPacks,
        personalityPool,
        statRules,
      });
      await persistCharacterRoster({ storage: rootStorage, entities });
      if (area) area.value = '';
      csState.lastExportSummary = res.summaryText;
      uiKit.showToast(res.summaryText, 'ok');
      renderCompendiumStudio();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : 'JSON 导入失败', 'error');
    } finally {
      btn.disabled = false;
    }
  });
  host.appendChild(modCard);

  // 1B. Custom Equipment & Outfit Templates Section (also accessible from Compendium -> Equipment)
  const customEqList = contentManager.listCustomEquipment();
  const eqTplCard = document.createElement('section');
  eqTplCard.className = 'surface-card lab-stack-sm';
  eqTplCard.id = 'cs-studio-custom-eq-card';
  eqTplCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h3 class="section-title">自定义装备与服装模板（${customEqList.length}）</h3>
      <button type="button" id="btn-cs-studio-new-eq" class="btn-primary uikit-touch-target" style="padding:0 12px;">+ 新建装备/服装</button>
    </div>
    ${
      customEqList.length === 0
        ? '<p class="muted-text" style="font-size:12px;">暂无自定义装备或服装模板。点击「+ 新建装备/服装」可自由定制五阶品级、八维属性、图标与服装风格，并一键发放到仓库或导出到模组包。</p>'
        : customEqList
            .map((tpl) => {
              const rId = inferItemRarity(tpl);
              const rDef = ITEM_RARITY_MAP[rId] || ITEM_RARITY_MAP.common;
              return `
        <div class="lab-slot-card is-rarity-${rId}">
          <div class="lab-slot-head">
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span class="wh-item-ico">${getItemIconSvg(tpl, { size: 18 })}</span>
              <span class="rarity-pill is-rarity-${rId}">${escapeHtml(rDef.shortLabel)}</span>
              <strong>${escapeHtml(tpl.name)}</strong>
              ${tpl.outfitStyle ? `<span class="status-badge badge-ok">${escapeHtml(tpl.outfitStyle)}</span>` : ''}
            </div>
          </div>
          <div class="lab-btn-grid">
            <button type="button" class="btn-primary uikit-touch-target" data-studio-issue-eq="${escapeHtml(tpl.id)}">发放到仓库</button>
            <button type="button" class="btn-secondary uikit-touch-target" data-studio-edit-eq="${escapeHtml(tpl.id)}">编辑</button>
            <button type="button" class="btn-danger uikit-touch-target" data-studio-del-eq="${escapeHtml(tpl.id)}">删除</button>
          </div>
        </div>
      `;
            })
            .join('')
    }
  `;
  eqTplCard.querySelector('#btn-cs-studio-new-eq')?.addEventListener('click', () => {
    openEquipmentOutfitEditorSheet(csState.context, {
      onSaved: () => renderCompendiumStudio(),
    });
  });
  eqTplCard.querySelectorAll('[data-studio-issue-eq]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-studio-issue-eq');
      try {
        const issued = await contentManager.issueEquipmentToWarehouse(id, 1);
        uiKit.showToast(`已发放「${issued[0]?.name || '自定义物品'}」×1 到仓库！`, 'ok');
        renderCompendiumStudio();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '发放失败', 'warn');
      }
    });
  });
  eqTplCard.querySelectorAll('[data-studio-edit-eq]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-studio-edit-eq');
      const tpl = customEqList.find((t) => t.id === id);
      if (!tpl) return;
      openEquipmentOutfitEditorSheet(csState.context, {
        template: tpl,
        onSaved: () => renderCompendiumStudio(),
      });
    });
  });
  eqTplCard.querySelectorAll('[data-studio-del-eq]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await contentManager.deleteCustomEquipmentTemplate(btn.getAttribute('data-studio-del-eq'));
      uiKit.showToast('已删除自定义装备/服装模板', 'info');
      renderCompendiumStudio();
    });
  });
  host.appendChild(eqTplCard);

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
// Tab 3: Hot-Pluggable Event & Story Packs + Global Flags
// ============================================================

function openAddFlagSheet() {
  const { storyPacks, uiKit } = csState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="sf-key">Flag 键名 *</label>
      <input id="sf-key" class="form-input" type="text" placeholder="例如：inv_ch1_done 或 secret_route">
    </div>
    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="sf-type">值类型</label>
        <select id="sf-type" class="form-select">
          <option value="boolean">布尔值 (true/false)</option>
          <option value="number">计数数值</option>
          <option value="string">状态字符串</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="sf-val">值</label>
        <input id="sf-val" class="form-input" type="text" value="true">
      </div>
    </div>
  `;

  uiKit.openBottomSheet({
    title: '设置全局剧情 Flag 变量',
    subtitle: '用于调试或手动控制多章节前置进度锁',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'save',
        label: '写入 Flag',
        tone: 'primary',
        onClick: async () => {
          const key = wrap.querySelector('#sf-key').value.trim();
          const type = wrap.querySelector('#sf-type').value;
          const rawVal = wrap.querySelector('#sf-val').value.trim();
          if (!key) {
            uiKit.showToast('Flag 键名不能为空', 'warn');
            return false;
          }
          let parsed = rawVal;
          if (type === 'boolean') parsed = rawVal !== 'false' && rawVal !== '0' && rawVal !== '';
          else if (type === 'number') parsed = Number(rawVal) || 0;
          await storyPacks.setFlag(key, parsed);
          uiKit.showToast(`已写入 Flag：${key} = ${parsed}`, 'ok');
          renderCompendiumStudio();
          return true;
        },
      },
    ],
  });
}

function openNewStoryPackSheet() {
  const { storyPacks, uiKit } = csState.context;
  const wrap = document.createElement('div');
  wrap.className = 'module-stack';
  wrap.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="sp-name">剧情/事件包名称 *</label>
      <input id="sp-name" class="form-input" type="text" placeholder="例如：港区夏日烟火祭典包">
    </div>
    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="sp-cat">分类</label>
        <select id="sp-cat" class="form-select">
          ${Object.entries(PACK_CATEGORY_LABELS)
            .map(([k, lbl]) => `<option value="${k}">${escapeHtml(lbl)}</option>`)
            .join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="sp-ver">版本号</label>
        <input id="sp-ver" class="form-input" type="text" value="1.0.0">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="sp-desc">简介</label>
      <input id="sp-desc" class="form-input" type="text" placeholder="填写事件包说明...">
    </div>
    <div class="lab-divider"></div>
    <div class="form-group">
      <label class="form-label" for="sp-n1-title">起始节点标题 *</label>
      <input id="sp-n1-title" class="form-input" type="text" value="第一章 · 序幕事件">
    </div>
    <div class="form-group">
      <label class="form-label" for="sp-n1-body">起始节点剧情文本（支持 {actor.name} / {commander.name}）</label>
      <textarea id="sp-n1-body" class="form-textarea">海面微风轻拂，{actor.name}拿着刚收到的电报走进{commander.name}的指挥室。</textarea>
    </div>
    <div class="lab-kv-grid">
      <div class="form-group">
        <label class="form-label" for="sp-c1-label">分支选项文案</label>
        <input id="sp-c1-label" class="form-input" type="text" value="立刻展开调查">
      </div>
      <div class="form-group">
        <label class="form-label" for="sp-c1-flag">写入 Flag 键名</label>
        <input id="sp-c1-flag" class="form-input" type="text" value="custom_story_started">
      </div>
    </div>
  `;

  uiKit.openBottomSheet({
    title: '新建自定义事件/剧情包',
    subtitle: '创建后可继续可视化增改更多章节节点与分支选项，或导出独立 .json 分享',
    content: wrap,
    actions: [
      { id: 'cancel', label: '取消', tone: 'secondary' },
      {
        id: 'create',
        label: '创建并挂载',
        tone: 'primary',
        onClick: async () => {
          const name = wrap.querySelector('#sp-name').value.trim();
          if (!name) {
            uiKit.showToast('请输入剧情包名称', 'warn');
            return false;
          }
          const flagKey = wrap.querySelector('#sp-c1-flag').value.trim();
          const pack = await storyPacks.savePack({
            name,
            version: wrap.querySelector('#sp-ver').value.trim() || '1.0.0',
            category: wrap.querySelector('#sp-cat').value,
            description: wrap.querySelector('#sp-desc').value.trim(),
            enabled: true,
            entryNodeId: 'node_01',
            nodes: [
              {
                id: 'node_01',
                title: wrap.querySelector('#sp-n1-title').value.trim() || '起始节点',
                body: wrap.querySelector('#sp-n1-body').value.trim() || '一段新的港区物语正式展开。',
                conditions: [],
                choices: [
                  {
                    id: 'c_01',
                    label: wrap.querySelector('#sp-c1-label').value.trim() || '推进剧情',
                    conditions: [],
                    check: null,
                    effects: {
                      flags: flagKey ? { [flagKey]: true } : {},
                      resources: { silver: 50 },
                      affinity: 4,
                      commanderExp: 15,
                    },
                    resultText: '{actor.name}记录下了这次行动的成果，新的线索已经显现。',
                    nextNodeId: null,
                  },
                ],
              },
            ],
          });
          csState.activePackId = pack.id;
          csState.activeNodeId = pack.entryNodeId;
          csState.lastStoryOutcome = null;
          uiKit.showToast(`已创建并挂载「${pack.name}」`, 'ok');
          renderCompendiumStudio();
          return true;
        },
      },
    ],
  });
}

function openEditStoryPackSheet(packId) {
  const { storyPacks, uiKit } = csState.context;
  const pack = storyPacks.getPack(packId);
  if (!pack) return;

  const wrap = document.createElement('div');
  wrap.className = 'module-stack';

  const renderInner = () => {
    const curPack = storyPacks.getPack(packId);
    if (!curPack) return;

    wrap.innerHTML = `
      <div class="lab-stack-sm">
        <div class="section-header-row" style="margin-bottom:0;">
          <strong>${escapeHtml(curPack.name)}（v${escapeHtml(curPack.version)}）</strong>
          <span class="status-badge badge-ok">${curPack.nodes.length} 节点</span>
        </div>
        <p class="muted-text" style="font-size:12px;">现有节点列表（点击可新增后续章节并绑定前置 Flag 锁）：</p>
        ${curPack.nodes
          .map(
            (n, i) => `
          <div class="lab-slot-card">
            <div class="lab-slot-head">
              <strong>#${i + 1} ${escapeHtml(n.title)}</strong>
              <code>${escapeHtml(n.id)}</code>
            </div>
            <p class="muted-text" style="font-size:12px;">${escapeHtml(n.body.slice(0, 80))}${n.body.length > 80 ? '...' : ''}</p>
            <span class="muted-text" style="font-size:11px;">前置条件：${(n.conditions || []).length} 条 · 选项：${(n.choices || []).length} 个</span>
          </div>
        `
          )
          .join('')}
      </div>

      <div class="lab-divider"></div>
      <strong style="font-size:13.5px;">+ 追加/覆写剧情节点</strong>
      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="sn-id">节点 ID *</label>
          <input id="sn-id" class="form-input" type="text" value="node_${curPack.nodes.length + 1}">
        </div>
        <div class="form-group">
          <label class="form-label" for="sn-req-flag">前置 Flag 锁（选填）</label>
          <input id="sn-req-flag" class="form-input" type="text" placeholder="例如：inv_ch1_done">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="sn-title">节点标题 *</label>
        <input id="sn-title" class="form-input" type="text" placeholder="例如：隐藏终章 · 星海回响">
      </div>
      <div class="form-group">
        <label class="form-label" for="sn-body">节点叙述文本 *</label>
        <textarea id="sn-body" class="form-textarea" placeholder="支持 {actor.name} / {commander.name}..."></textarea>
      </div>
      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="sn-choice">选项文案</label>
          <input id="sn-choice" class="form-input" type="text" value="确认并记录调查报告">
        </div>
        <div class="form-group">
          <label class="form-label" for="sn-out-flag">结算写入 Flag</label>
          <input id="sn-out-flag" class="form-input" type="text" placeholder="例如：epilogue_clear">
        </div>
      </div>
      <div class="lab-kv-grid">
        <div class="form-group">
          <label class="form-label" for="sn-silver">奖励银条</label>
          <input id="sn-silver" class="form-input" type="number" min="0" value="60">
        </div>
        <div class="form-group">
          <label class="form-label" for="sn-aff">奖励好感</label>
          <input id="sn-aff" class="form-input" type="number" min="0" value="5">
        </div>
      </div>
      <button type="button" id="btn-sn-save-node" class="btn-primary uikit-touch-target">保存节点到剧情包</button>
    `;

    wrap.querySelector('#btn-sn-save-node').addEventListener('click', async () => {
      const nodeId = wrap.querySelector('#sn-id').value.trim();
      const title = wrap.querySelector('#sn-title').value.trim();
      const bodyText = wrap.querySelector('#sn-body').value.trim();
      if (!nodeId || !title || !bodyText) {
        uiKit.showToast('节点 ID、标题与叙述文本均不可为空', 'warn');
        return;
      }
      const reqFlag = wrap.querySelector('#sn-req-flag').value.trim();
      const outFlag = wrap.querySelector('#sn-out-flag').value.trim();
      const silver = Math.max(0, Number(wrap.querySelector('#sn-silver').value) || 0);
      const aff = Math.max(0, Number(wrap.querySelector('#sn-aff').value) || 0);
      await storyPacks.saveNode(packId, {
        id: nodeId,
        title,
        body: bodyText,
        conditions: reqFlag ? [{ type: 'flag', key: reqFlag, op: 'truthy' }] : [],
        choices: [
          {
            id: `c_${nodeId}`,
            label: wrap.querySelector('#sn-choice').value.trim() || '继续',
            conditions: [],
            check: null,
            effects: {
              flags: outFlag ? { [outFlag]: true } : {},
              resources: silver > 0 ? { silver } : {},
              affinity: aff,
              commanderExp: 18,
            },
            resultText: '节点剧情已顺利推进，所有奖励与 Flag 均已结算入库。',
            nextNodeId: null,
          },
        ],
      });
      uiKit.showToast(`已保存节点「${title}」`, 'ok');
      renderInner();
      renderCompendiumStudio();
    });
  };

  renderInner();

  uiKit.openBottomSheet({
    title: '可视化编辑剧情包节点',
    subtitle: '支持自定义章节、前置 Flag 锁、选项与结算奖励',
    content: wrap,
    actions: [{ id: 'close', label: '完成', tone: 'secondary' }],
  });
}

async function renderStoryPacksTab(host) {
  const { storyPacks, narrative, fxStage, theme, entities, rootStorage, uiKit } = csState.context;
  if (!storyPacks) {
    const empty = document.createElement('section');
    empty.className = 'surface-card';
    empty.innerHTML = '<p class="muted-text">剧情包引擎尚未初始化。</p>';
    host.appendChild(empty);
    return;
  }

  const flags = storyPacks.getAllFlags();
  const flagEntries = Object.entries(flags);
  const packs = storyPacks.listPacks();
  const isAiMode = narrative.getMode() !== NARRATIVE_MODES.LOCAL;

  // 1. Global Story Flags Panel
  const flagsCard = document.createElement('section');
  flagsCard.className = 'surface-card lab-stack-sm';
  flagsCard.id = 'cs-flags-panel';
  flagsCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">全局剧情变量与进度锁（Flags）</h2>
      <span class="status-badge badge-ok" id="cs-flags-count">${flagEntries.length} 项已记录</span>
    </div>
    <div class="chip-row" id="cs-flags-chips">
      ${
        flagEntries.length === 0
          ? '<span class="muted-text" style="font-size:12px;">尚无剧情进度标记，体验下方内置剧情包即可自动解锁并记录 Flag。</span>'
          : flagEntries
              .map(
                ([k, v]) =>
                  `<span class="story-flag-chip" data-flag-key="${escapeHtml(k)}">${escapeHtml(k)} = ${escapeHtml(String(v))}</span>`
              )
              .join('')
      }
    </div>
    <div class="lab-btn-grid">
      <button type="button" id="btn-cs-add-flag" class="btn-secondary uikit-touch-target">+ 手动写入 Flag</button>
      <button type="button" id="btn-cs-clear-flags" class="btn-danger uikit-touch-target" ${flagEntries.length === 0 ? 'disabled' : ''}>清空 Flags</button>
    </div>
  `;

  flagsCard.querySelector('#btn-cs-add-flag').addEventListener('click', () => openAddFlagSheet());
  flagsCard.querySelector('#btn-cs-clear-flags').addEventListener('click', () => {
    uiKit.openBottomSheet({
      title: '确认清空全部剧情 Flags？',
      subtitle: '清空后，依赖前置 Flag 的章节将重新回到锁定状态',
      content: '<p class="muted-text">此操作仅清空全局进度标记，不会删除你的剧情包、角色或资源。</p>',
      actions: [
        { id: 'cancel', label: '取消', tone: 'secondary' },
        {
          id: 'confirm',
          label: '确认清空 Flags',
          tone: 'danger',
          onClick: async () => {
            for (const [k] of Object.entries(storyPacks.getAllFlags())) {
              await storyPacks.deleteFlag(k);
            }
            csState.lastStoryOutcome = null;
            uiKit.showToast('已清空全部剧情 Flags', 'info');
            renderCompendiumStudio();
            return true;
          },
        },
      ],
    });
  });
  host.appendChild(flagsCard);

  // 2. Interactive Story Player
  const activePack = packs.find((p) => p.id === csState.activePackId) || packs.find((p) => p.enabled) || packs[0] || null;
  if (activePack) {
    csState.activePackId = activePack.id;
    const targetNodeId = csState.activeNodeId && activePack.nodes.some((n) => n.id === csState.activeNodeId)
      ? csState.activeNodeId
      : activePack.entryNodeId || activePack.nodes[0]?.id;
    csState.activeNodeId = targetNodeId;

    const playerCard = document.createElement('section');
    playerCard.className = 'surface-card lab-stack-sm';
    playerCard.id = 'cs-story-player';
    playerCard.innerHTML = '<p class="muted-text">正在加载剧情节点...</p>';
    host.appendChild(playerCard);

    try {
      const view = await storyPacks.renderNodeView(activePack.id, targetNodeId);
      const outcome = csState.lastStoryOutcome;
      const nodeKey = `${activePack.id}::${view.node.id}`;
      const shouldTypewrite = csState.lastRenderedNodeKey !== nodeKey;
      csState.lastRenderedNodeKey = nodeKey;

      playerCard.innerHTML = `
        <div class="section-header-row" style="margin-bottom:0;">
          <h2 class="section-title">交互剧情演绎台 · ${escapeHtml(activePack.name)}</h2>
          <button type="button" id="btn-story-mode-toggle" class="ac-mode-toggle ${isAiMode ? 'is-ai' : ''}">
            ${isAiMode ? 'AI 润色增强' : '纯本地演绎'}
          </button>
        </div>

        <div class="form-group">
          <label class="form-label" for="cs-node-jump">当前章节节点（执勤角色：${escapeHtml(view.actorName)}）</label>
          <select id="cs-node-jump" class="form-select">
            ${activePack.nodes
              .map((n, idx) => {
                const cond = storyPacks.checkConditions(n.conditions || []);
                return `<option value="${escapeHtml(n.id)}" ${n.id === view.node.id ? 'selected' : ''}>${
                  cond.ok ? '🔓' : '🔒'
                } 第${idx + 1}节 · ${escapeHtml(n.title)}</option>`;
              })
              .join('')}
          </select>
        </div>

        <div class="section-header-row" style="margin-bottom:0;">
          <strong id="cs-story-node-title" style="font-size:15px;">${escapeHtml(view.node.title)}</strong>
          <span class="status-badge ${view.nodeUnlocked ? 'badge-ok' : 'badge-warn'}" id="cs-story-lock-badge">
            ${view.nodeUnlocked ? '已解锁可执行' : '前置条件锁定'}
          </span>
        </div>

        ${
          !view.nodeUnlocked
            ? `<div class="surface-card" style="padding:10px; border-color:var(--warn);" id="cs-story-lock-reason">
                <strong style="font-size:12.5px; color:var(--warn);">未满足进入前置条件：</strong>
                <div class="muted-text" style="font-size:12px;">${escapeHtml(view.unmetReasons.join('；'))}</div>
              </div>`
            : ''
        }

        <div class="story-narrative-box" id="cs-story-body">${escapeHtml(view.node.renderedBody)}</div>

        ${
          !activePack.enabled
            ? '<p class="muted-text" style="color:var(--warn);">该剧情包当前已停用，请在下方包列表中重新启用后继续游玩。</p>'
            : ''
        }

        <div class="lab-stack-sm" id="cs-story-choices">
          ${view.choices
            .map(
              (ch) => `
            <button
              type="button"
              class="story-choice-btn"
              data-story-choice="${escapeHtml(ch.id)}"
              ${ch.unlocked && activePack.enabled && !csState.storyBusy ? '' : 'disabled'}
            >
              <strong>${escapeHtml(ch.label)}</strong>
              <span class="muted-text" style="font-size:11.5px;">
                ${
                  !ch.unlocked
                    ? `🔒 条件未满足：${escapeHtml(ch.unmetReasons.join('；'))}`
                    : ch.check
                      ? `D20 属性检定：${escapeHtml(ch.check.statKey)} · DC ${ch.check.dc}`
                      : '直接推进分支并结算奖励与 Flag'
                }
              </span>
            </button>
          `
            )
            .join('')}
        </div>

        ${
          outcome && outcome.packId === activePack.id
            ? `
          <div class="surface-card lab-stack-sm" id="cs-story-outcome" style="padding:12px; border-color:var(--accent);">
            <div class="section-header-row" style="margin-bottom:0;">
              <strong style="font-size:13.5px;">结算回执 · ${escapeHtml(outcome.nodeTitle)}</strong>
              <span class="status-badge ${outcome.passed ? 'badge-ok' : 'badge-warn'}">${outcome.passed ? '推进成功' : '遇阻分支'}</span>
            </div>
            ${
              outcome.check
                ? `<div class="muted-text" style="font-size:12px;">检定：${escapeHtml(outcome.check.breakdown)}（${escapeHtml(outcome.check.outcomeLabel)}）</div>`
                : ''
            }
            <div id="cs-story-outcome-text" style="font-size:13.5px; line-height:1.55;">${escapeHtml(outcome.text)}</div>
            <div class="chip-row">
              ${(outcome.chips || [])
                .map((c) => `<span class="status-badge ${c.negative ? 'badge-danger' : 'badge-ok'}">${escapeHtml(c.text)}</span>`)
                .join('')}
            </div>
            ${
              outcome.nextNodeId
                ? `<button type="button" id="btn-story-next-node" class="btn-primary uikit-touch-target" data-next-node="${escapeHtml(outcome.nextNodeId)}">进入下一章 / 节点 →</button>`
                : '<span class="muted-text" style="font-size:12px;">本条剧情分支已告一段落，可切换其他章节或剧情包。</span>'
            }
          </div>
        `
            : ''
        }
      `;

      if (shouldTypewrite && fxStage && typeof fxStage.typewrite === 'function') {
        const bodyEl = playerCard.querySelector('#cs-story-body');
        if (bodyEl) {
          fxStage.typewrite(bodyEl, view.node.renderedBody, {
            speedMs: theme ? theme.getTypewriterSpeed() : 16,
          });
        }
      }

      playerCard.querySelector('#btn-story-mode-toggle').addEventListener('click', () => {
        const next = isAiMode ? NARRATIVE_MODES.LOCAL : NARRATIVE_MODES.AI_POLISH;
        narrative.setMode(next);
        uiKit.showToast(next === NARRATIVE_MODES.LOCAL ? '切换为纯本地离线剧情模板' : '切换为 AI 剧情润色增强', 'ok');
        renderCompendiumStudio();
      });

      playerCard.querySelector('#cs-node-jump').addEventListener('change', (e) => {
        csState.activeNodeId = e.target.value;
        csState.lastStoryOutcome = null;
        renderCompendiumStudio();
      });

      playerCard.querySelectorAll('[data-story-choice]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (csState.storyBusy) return;
          csState.storyBusy = true;
          try {
            const choiceId = btn.getAttribute('data-story-choice');
            const rec = await storyPacks.executeChoice(activePack.id, view.node.id, choiceId);
            await persistCharacterRoster({ storage: rootStorage, entities });
            csState.lastStoryOutcome = rec;
            uiKit.showToast(`剧情推进完成：${rec.chips.slice(0, 2).map((c) => c.text).join(' · ') || '已记录'}`, 'ok');
          } catch (err) {
            uiKit.showToast(err instanceof Error ? err.message : '执行选项失败', 'warn');
          } finally {
            csState.storyBusy = false;
            renderCompendiumStudio();
          }
        });
      });

      const nextBtn = playerCard.querySelector('#btn-story-next-node');
      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          csState.activeNodeId = nextBtn.getAttribute('data-next-node');
          csState.lastStoryOutcome = null;
          renderCompendiumStudio();
        });
      }
    } catch (err) {
      playerCard.innerHTML = `<p class="muted-text">加载剧情节点失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
    }
  }

  // 3. Mounted Story Packs Manager
  const listCard = document.createElement('section');
  listCard.className = 'surface-card lab-stack-sm';
  listCard.id = 'cs-story-packs-list';
  listCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <h2 class="section-title">已挂载本地事件包与剧情包（热插拔）</h2>
      <span class="status-badge badge-ok">${packs.filter((p) => p.enabled).length}/${packs.length} 启用</span>
    </div>
    <div class="lab-btn-grid">
      <button type="button" id="btn-cs-new-pack" class="btn-primary uikit-touch-target">+ 新建剧情包</button>
      <button type="button" id="btn-cs-import-pack" class="btn-secondary uikit-touch-target">上传 .json 剧情包</button>
      <input type="file" id="input-cs-import-pack" accept="application/json,.json" hidden>
    </div>

    <div class="form-group">
      <label class="form-label" for="cs-story-paste-json">直接粘贴事件/剧情包 JSON 文本（也支持角色/装备/性格词条混合导入）</label>
      <textarea
        id="cs-story-paste-json"
        class="form-textarea"
        style="min-height:80px; font-family:var(--font-mono); font-size:12px;"
        placeholder='在此粘贴剧情包 JSON（含 name 与 nodes 数组）或任意模组 JSON 文本...'
      ></textarea>
    </div>
    <button type="button" id="btn-cs-story-paste-import" class="btn-primary uikit-touch-target">粘贴 JSON 文本一键合并导入</button>

    ${packs
      .map(
        (p) => `
      <div class="lab-slot-card" data-pack-card="${escapeHtml(p.id)}">
        <div class="lab-slot-head">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="status-badge ${p.enabled ? 'badge-ok' : 'badge-muted'}">
            ${escapeHtml(PACK_CATEGORY_LABELS[p.category] || p.category)} · v${escapeHtml(p.version)}
          </span>
        </div>
        <p class="muted-text" style="font-size:12px;">${escapeHtml(p.description || '')}（共 ${p.nodes.length} 个节点）</p>
        <div class="lab-btn-grid">
          <button type="button" class="btn-primary uikit-touch-target" data-play-pack="${escapeHtml(p.id)}" ${p.enabled ? '' : 'disabled'}>开始/继续演绎</button>
          <button type="button" class="btn-secondary uikit-touch-target" data-toggle-pack="${escapeHtml(p.id)}">${p.enabled ? '停用此包' : '启用此包'}</button>
          <button type="button" class="btn-secondary uikit-touch-target" data-edit-pack="${escapeHtml(p.id)}">编辑节点</button>
          <button type="button" class="btn-secondary uikit-touch-target" data-export-pack="${escapeHtml(p.id)}">导出 JSON</button>
        </div>
        ${
          !p.builtIn
            ? `<button type="button" class="btn-danger uikit-touch-target" data-delete-pack="${escapeHtml(p.id)}">删除自定义包</button>`
            : ''
        }
      </div>
    `
      )
      .join('')}
  `;

  listCard.querySelector('#btn-cs-new-pack').addEventListener('click', () => openNewStoryPackSheet());

  const packFileInput = listCard.querySelector('#input-cs-import-pack');
  listCard.querySelector('#btn-cs-import-pack').addEventListener('click', () => packFileInput.click());
  packFileInput.addEventListener('change', async () => {
    const file = packFileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const { contentManager, personalityPool, statRules } = csState.context;
      const res = await contentManager.smartImportJSONText(text, {
        mode: 'merge',
        storyPacks,
        personalityPool,
        statRules,
      });
      await persistCharacterRoster({ storage: rootStorage, entities });
      if (res.counts.storyPacks > 0) {
        const all = storyPacks.listPacks();
        const newest = all[all.length - 1];
        if (newest) {
          csState.activePackId = newest.id;
          csState.activeNodeId = newest.entryNodeId || newest.nodes[0]?.id || null;
          csState.lastStoryOutcome = null;
        }
      }
      uiKit.showToast(res.summaryText, 'ok');
      renderCompendiumStudio();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '导入剧情包失败', 'error');
    } finally {
      packFileInput.value = '';
    }
  });

  listCard.querySelector('#btn-cs-story-paste-import').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const area = listCard.querySelector('#cs-story-paste-json');
    const rawText = area?.value || '';
    if (!rawText.trim()) {
      uiKit.showToast('请先粘贴需要导入的 JSON 文本', 'warn');
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const { contentManager, personalityPool, statRules } = csState.context;
      const res = await contentManager.smartImportJSONText(rawText, {
        mode: 'merge',
        storyPacks,
        personalityPool,
        statRules,
      });
      await persistCharacterRoster({ storage: rootStorage, entities });
      if (area) area.value = '';
      if (res.counts.storyPacks > 0) {
        const all = storyPacks.listPacks();
        const newest = all[all.length - 1];
        if (newest) {
          csState.activePackId = newest.id;
          csState.activeNodeId = newest.entryNodeId || newest.nodes[0]?.id || null;
          csState.lastStoryOutcome = null;
        }
      }
      uiKit.showToast(res.summaryText, 'ok');
      renderCompendiumStudio();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : 'JSON 导入失败', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  listCard.querySelectorAll('[data-play-pack]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-play-pack');
      const target = storyPacks.getPack(id);
      if (!target) return;
      const entryNode = target.entryNodeId || target.nodes[0]?.id || null;
      csState.activePackId = target.id;
      csState.activeNodeId = entryNode;
      csState.lastStoryOutcome = null;
      csState.lastRenderedNodeKey = null;

      if (csState.context?.appActions && typeof csState.context.appActions.launchStoryPackInTheatre === 'function') {
        csState.context.appActions.launchStoryPackInTheatre(target.id, entryNode);
        uiKit.showToast(`已在中央主舞台开启剧场：「${target.name}」`, 'ok');
        return;
      }
      if (typeof storyPacks.setActiveTheatreSession === 'function' && csState.context?.modules?.has('port-hub')) {
        storyPacks.setActiveTheatreSession(target.id, entryNode);
        csState.context.modules.mount('port-hub', { transition: 'right' });
        uiKit.showToast(`已在中央主舞台开启剧场：「${target.name}」`, 'ok');
        return;
      }
      renderCompendiumStudio();
    });
  });

  listCard.querySelectorAll('[data-toggle-pack]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-toggle-pack');
      const target = storyPacks.getPack(id);
      if (!target) return;
      await storyPacks.togglePack(id, !target.enabled);
      uiKit.showToast(`剧情包「${target.name}」已${!target.enabled ? '启用' : '停用'}`, 'ok');
      renderCompendiumStudio();
    });
  });

  listCard.querySelectorAll('[data-edit-pack]').forEach((btn) => {
    btn.addEventListener('click', () => openEditStoryPackSheet(btn.getAttribute('data-edit-pack')));
  });

  listCard.querySelectorAll('[data-export-pack]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-export-pack');
      const exported = storyPacks.exportPackToJSON(id);
      triggerJsonDownload(`story-pack-${id}.json`, exported);
      uiKit.showToast(`已导出独立剧情包：story-pack-${id}.json`, 'ok');
    });
  });

  listCard.querySelectorAll('[data-delete-pack]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await storyPacks.deletePack(btn.getAttribute('data-delete-pack'));
        uiKit.showToast('已删除自定义剧情包', 'info');
        renderCompendiumStudio();
      } catch (err) {
        uiKit.showToast(err instanceof Error ? err.message : '删除失败', 'warn');
      }
    });
  });

  host.appendChild(listCard);
}

// ============================================================
// Root Renderer
// ============================================================

function renderCompendiumStudio() {
  if (!csState.container || !csState.context) return;
  const { resources, modules, uiKit } = csState.context;

  csState.container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'module-stack';

  root.appendChild(
    uiKit.createSubpageHeader({
      title: '图鉴与内容库',
      subtitle: '全要素图鉴 · 剧情包与模组导入',
      modules,
      resources,
      resourceKeys: ['silver', 'gold'],
      id: 'cs-subpage-header',
    })
  );

  root.appendChild(createResourceOverviewBar(resources, { id: 'cs-resource-bar' }));

  const navCard = document.createElement('section');
  navCard.className = 'surface-card lab-stack-sm';
  navCard.innerHTML = `
    <div class="lab-btn-grid" id="cs-main-tabs" style="grid-template-columns:repeat(3,minmax(0,1fr));">
      <button type="button" id="btn-cs-tab-compendium" class="${csState.mainTab === 'compendium' ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" style="padding:0 6px; font-size:12.5px;">全要素图鉴</button>
      <button type="button" id="btn-cs-tab-story" class="${csState.mainTab === 'story' ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" style="padding:0 6px; font-size:12.5px;">事件与剧情包</button>
      <button type="button" id="btn-cs-tab-studio" class="${csState.mainTab === 'studio' ? 'btn-primary' : 'btn-secondary'} uikit-touch-target" style="padding:0 6px; font-size:12.5px;">自定义模组</button>
    </div>
    <button type="button" id="btn-cs-back-port" class="btn-secondary uikit-touch-target">返回港区大本营</button>
  `;
  navCard.querySelector('#btn-cs-tab-compendium').addEventListener('click', () => {
    csState.mainTab = 'compendium';
    renderCompendiumStudio();
  });
  navCard.querySelector('#btn-cs-tab-story').addEventListener('click', () => {
    csState.mainTab = 'story';
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

  // Prominent Non-Destructive Starter Content Pack Merge Card (Protects Existing Saves)
  const bundleCard = document.createElement('section');
  bundleCard.className = 'surface-card lab-stack-sm starter-bundle-card';
  bundleCard.id = 'cs-starter-bundle-card';
  bundleCard.innerHTML = `
    <div class="section-header-row" style="margin-bottom:0;">
      <strong style="font-size:14px;">开局标准示范内容大礼包（无损合并）</strong>
      <span class="status-badge badge-ok">不覆盖旧存档</span>
    </div>
    <p class="muted-text" style="font-size:12px; margin:0;">
      含覆盖 DD/CL/CA/BB/CV 全五舰种的 <strong>8 名独立性格舰娘</strong>、<strong>16 件核心/武器/辅助/服装装备</strong>、低/中/高危分级敌舰、<strong>16 项港区生活日常包</strong>与<strong>四章节深海遗迹主线包</strong>。仅补齐缺失条目，绝不覆盖您已有数据。
    </p>
    <button type="button" id="btn-cs-merge-starter-pack" class="btn-primary port-cta-btn">
      一键合并导入示范内容大礼包
    </button>
  `;
  bundleCard.querySelector('#btn-cs-merge-starter-pack').addEventListener('click', async () => {
    const { contentManager, personalityPool, storyPacks, statRules, rootStorage, entities, uiKit } = csState.context;
    try {
      const res = await contentManager.mergeStarterContentBundle({
        personalityPool,
        storyPacks,
        statRules,
        persistRosterFn: () => persistCharacterRoster({ storage: rootStorage, entities }),
      });
      const total = res.addedShips + res.addedItems + res.addedEnemies + res.addedPacks;
      uiKit.showToast(
        total > 0
          ? `合并完成：新增 ${res.addedShips} 名舰娘、${res.addedItems} 件装备、${res.addedEnemies} 支敌舰、${res.addedPacks} 套剧情包！`
          : '全套示范内容大礼包已完整收录，无需重复导入（旧数据已无损保留）',
        'ok'
      );
      renderCompendiumStudio();
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '合并导入失败', 'error');
    }
  });
  root.appendChild(bundleCard);

  if (csState.mainTab === 'compendium') {
    renderCompendiumTab(root);
  } else if (csState.mainTab === 'story') {
    renderStoryPacksTab(root);
  } else {
    renderStudioTab(root);
  }

  csState.container.appendChild(root);
}

export default {
  id: 'compendium-studio',
  name: '图鉴与内容台',
  description: '全要素图鉴、热插拔本地事件包与多章节剧情包（含 Flags 进度锁）以及自定义敌舰/台词/礼物/JSON世界模组管理台。',

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
        id: 'cs-q-story',
        label: '事件与剧情包',
        onClick: () => {
          csState.mainTab = 'story';
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
      context.bus.on('inventory:item-updated', () => renderCompendiumStudio()),
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
