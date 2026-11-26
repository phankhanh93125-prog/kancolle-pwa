/**
 * Game Title Cover & "New Journey Preferences" Screen (`title-screen.js`).
 *
 * Displayed at application launch with clean naval visual hierarchy:
 *   - 「继续航行」: displays latest commander name, level, and fleet/roster count -> enters Port Hub in 1 tap
 *   - 「新的征程」: opens "开局偏好设置" modal (Commander callsign, Starter Fleet Archetype,
 *                   Resource Mode, and default-checked preservation of custom content packs,
 *                   personality pool & UI theme skin)
 *   - 「读取存档」: opens Save Vault directly for manual save slots & JSON backup import
 */

const FLEET_PREF_OPTIONS = Object.freeze([
  {
    id: 'balanced',
    label: '均衡编队',
    badge: 'DD + CL + BB',
    desc: '驱逐/轻巡/战列全面搭配，稳健适应炮击、雷击与防空反潜全场景。',
  },
  {
    id: 'torpedo',
    label: '雷击先锋',
    badge: '双DD + CL',
    desc: '高机动抢先先攻与强力开幕雷击，额外获赠【精良】五联酸素鱼雷与主动声呐。',
  },
  {
    id: 'battleship',
    label: '重炮主力',
    badge: '双BB + CA',
    desc: '厚重装甲与远距主炮齐射压制，额外获赠【稀有】双联主炮与复合重甲。',
  },
  {
    id: 'carrier',
    label: '航空制空',
    badge: 'CV + CA + CL',
    desc: '开幕航空战制空与大视野雷达侦察，额外获赠【稀有】舰载轰炸机与对空雷达。',
  },
]);

const RESOURCE_MODE_OPTIONS = Object.freeze([
  {
    id: 'standard',
    label: '标准开荒',
    badge: '1.0x 常规',
    desc: '初始油弹钢 1800 / 铝 1200 / 银条 3200 / 金条 180，体验稳步成长节奏。',
  },
  {
    id: 'abundant',
    label: '丰饶畅玩',
    badge: '2.0x 丰饶',
    desc: '初始油弹钢 6000 / 铝 4000 / 银条 12000 / 金条 600，自动启用 2.0x 掉落倍率并附赠紫/蓝装备箱。',
  },
]);

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function openNewJourneyModal(context) {
  const { uiKit, commander, appActions } = context;
  let prefs = {
    commanderName: commander?.getProfile()?.name || '新任提督',
    fleetPreference: 'balanced',
    resourceMode: 'standard',
    keepCustomData: true,
  };

  const openFn = typeof uiKit.openTacticalModal === 'function' ? uiKit.openTacticalModal : uiKit.openModal;
  openFn({
    title: '新的征程 · 开局偏好设置',
    subtitle: '开启新征程将彻底清空当前运行的旧舰娘、装备仓库、3×4 编队、船坞与海域进度（手动存档槽位不受影响）',
    renderContent: (body, close) => {
      const renderForm = () => {
        const prevScroll = body.scrollTop;
        body.innerHTML = `
          <div class="module-stack" id="new-journey-form">
            <div class="form-group">
              <label class="form-label" for="nj-cmd-name">1. 指挥官代号</label>
              <input id="nj-cmd-name" class="form-input" type="text" maxlength="20" value="${escapeHtml(prefs.commanderName)}" placeholder="请输入您的指挥官代号..." />
            </div>

            <div class="form-group">
              <label class="form-label">2. 初始舰队偏好</label>
              <div class="nj-option-grid" id="nj-fleet-options">
                ${FLEET_PREF_OPTIONS.map(
                  (opt) => `
                  <button type="button" class="nj-option-card ${prefs.fleetPreference === opt.id ? 'is-selected' : ''}" data-nj-fleet="${opt.id}">
                    <div class="nj-option-top">
                      <strong>${escapeHtml(opt.label)}</strong>
                      <span class="status-badge ${prefs.fleetPreference === opt.id ? 'badge-ok' : 'badge-muted'}">${escapeHtml(opt.badge)}</span>
                    </div>
                    <span class="nj-option-desc">${escapeHtml(opt.desc)}</span>
                  </button>
                `
                ).join('')}
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">3. 开局资源模式</label>
              <div class="nj-option-grid" id="nj-res-options">
                ${RESOURCE_MODE_OPTIONS.map(
                  (opt) => `
                  <button type="button" class="nj-option-card ${prefs.resourceMode === opt.id ? 'is-selected' : ''}" data-nj-res="${opt.id}">
                    <div class="nj-option-top">
                      <strong>${escapeHtml(opt.label)}</strong>
                      <span class="status-badge ${prefs.resourceMode === opt.id ? 'badge-ok' : 'badge-muted'}">${escapeHtml(opt.badge)}</span>
                    </div>
                    <span class="nj-option-desc">${escapeHtml(opt.desc)}</span>
                  </button>
                `
                ).join('')}
              </div>
            </div>

            <label class="checkbox-row" style="padding:10px 12px; background:var(--surface-alt); border-radius:var(--radius-sm); border:1px solid var(--border);">
              <input type="checkbox" id="nj-keep-custom" ${prefs.keepCustomData ? 'checked' : ''} />
              <span><strong>保留自定义建筑与 UI 皮肤</strong>（注：外置 JSON 导入的角色模板、性格池、台词与剧情包始终受保护不丢失，旧档舰队与装备将彻底清空）</span>
            </label>

            <button type="button" id="btn-nj-confirm" class="btn-primary port-cta-btn">
              确认出发 · 清空旧档并开启新征程
            </button>
          </div>
        `;
        body.scrollTop = prevScroll;

        const syncName = () => {
          const inp = body.querySelector('#nj-cmd-name');
          if (inp) prefs.commanderName = inp.value.trim() || '新任提督';
        };

        body.querySelectorAll('[data-nj-fleet]').forEach((btn) => {
          btn.addEventListener('click', () => {
            syncName();
            prefs.fleetPreference = btn.getAttribute('data-nj-fleet');
            renderForm();
          });
        });

        body.querySelectorAll('[data-nj-res]').forEach((btn) => {
          btn.addEventListener('click', () => {
            syncName();
            prefs.resourceMode = btn.getAttribute('data-nj-res');
            renderForm();
          });
        });

        body.querySelector('#nj-keep-custom')?.addEventListener('change', (e) => {
          prefs.keepCustomData = Boolean(e.target.checked);
        });

        body.querySelector('#btn-nj-confirm')?.addEventListener('click', async () => {
          syncName();
          const btn = body.querySelector('#btn-nj-confirm');
          if (!btn || btn.disabled) return;
          btn.disabled = true;
          btn.textContent = '正在清空旧档并整备新港区...';
          try {
            if (!appActions || typeof appActions.startNewJourney !== 'function') {
              throw new Error('新征程初始化处理器未就绪');
            }
            close();
            await appActions.startNewJourney(prefs);
          } catch (err) {
            btn.disabled = false;
            btn.textContent = '确认出发 · 清空旧档并开启新征程';
            uiKit.showToast(err instanceof Error ? err.message : '开启新征程失败', 'error');
          }
        });
      };

      renderForm();
    },
  });
}

let titleState = {
  container: null,
  context: null,
  renderSeq: 0,
};

async function renderTitleScreen() {
  if (!titleState.container || !titleState.context) return;
  const seq = ++titleState.renderSeq;
  const ctx = titleState.context;
  const { commander, entities, formation, interaction, resources, saves, modules, appActions, uiKit } = ctx;

  let autoMeta = null;
  let manualSlots = [];
  try {
    if (saves) {
      autoMeta = await saves.getAutoSaveMeta();
      manualSlots = (await saves.listSlots()).filter((s) => !s.empty);
    }
  } catch (err) {
    console.warn('[TitleScreen] Failed to read save metadata:', err);
  }

  // Guard against unmount or newer render while awaiting IndexedDB
  if (seq !== titleState.renderSeq || !titleState.container || !titleState.context) return;

  const latestManual = manualSlots
    .slice()
    .sort((a, b) => (Number(b.meta?.timestamp) || 0) - (Number(a.meta?.timestamp) || 0))[0] || null;
  const latestMeta = autoMeta || latestManual?.meta || null;

  const cmd = commander ? commander.getProfile() : { name: '港区指挥官', level: 1 };
  const chars = entities ? entities.list({ kind: 'character' }) : [];
  const activeFleetCount = formation ? formation.getMemberIds().length : 0;
  const secretary = interaction?.getSecretary() || chars[0] || null;
  const hasContinuableSave = Boolean(latestMeta || chars.length > 0);
  const dropMult = resources && typeof resources.getDropMultiplier === 'function' ? resources.getDropMultiplier() : 1.0;

  const continueCmdName = latestMeta?.summary?.commanderName || cmd.name || '港区指挥官';
  const continueCmdLv = latestMeta?.summary?.commanderLevel ?? cmd.level ?? 1;
  const continueTotalShips = latestMeta?.summary?.characters ?? chars.length;
  const continueFleetShips = latestMeta?.summary?.fleetCount ?? activeFleetCount;
  const continueSecName = latestMeta?.summary?.flagshipName || secretary?.name || '';

  titleState.container.innerHTML = '';
  const root = document.createElement('section');
  root.className = 'title-cover-root';
  root.id = 'title-screen-cover';
  root.innerHTML = `
    <div class="title-cover-hero">
      <div class="title-crest" aria-hidden="true">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          <circle cx="32" cy="32" r="28" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4" opacity="0.65"/>
          <circle cx="32" cy="32" r="20" stroke="var(--accent)" stroke-width="1.6" fill="rgba(20,184,166,0.12)"/>
          <path d="M32 14V46M22 24H42M18 36C18 44 24 49 32 49C40 49 46 44 46 36" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="32" cy="14" r="3" fill="var(--accent)"/>
        </svg>
      </div>
      <span class="status-badge badge-ok" style="letter-spacing:0.08em;">NAVAL COMMAND PWA</span>
      <h1 class="title-main-heading">港区战术指挥中枢</h1>
      <p class="title-sub-copy">
        混合机动行动轴 · 开幕空袭雷击 · 五阶品级工坊 · 离线自由扩展
      </p>
    </div>

    <div class="title-action-stack">
      <button type="button" id="btn-title-continue" class="${hasContinuableSave ? 'title-cta-primary' : 'title-cta-secondary'}">
        <span class="title-cta-label">继续航行</span>
        <span class="title-cta-meta">
          ${
            hasContinuableSave
              ? `指挥官：${escapeHtml(continueCmdName)} Lv.${continueCmdLv} · 舰队 ${continueFleetShips}/${continueTotalShips} 舰${continueSecName ? ` · 秘书舰 ${escapeHtml(continueSecName)}` : ''}`
              : '暂无已保存的航程，点击后可引导开启「新的征程」'
          }
        </span>
      </button>

      <button type="button" id="btn-title-new-journey" class="${hasContinuableSave ? 'title-cta-secondary' : 'title-cta-primary'}">
        <span class="title-cta-label">新的征程</span>
        <span class="title-cta-meta">自定义指挥官代号、初始舰队流派与开局资源模式</span>
      </button>

      <button type="button" id="btn-title-load-save" class="title-cta-secondary">
        <span class="title-cta-label">读取存档</span>
        <span class="title-cta-meta">打开手动存档槽位（${manualSlots.length} 个已存）与 JSON 备份导入</span>
      </button>
    </div>

    <div class="title-footer-bar">
      <span class="muted-text" style="font-size:11.5px;">
        当前掉落倍率 <strong>${dropMult.toFixed(1)}x</strong> · 本地 IndexedDB 无损保护
      </span>
      <button type="button" id="btn-title-settings" class="btn-secondary uikit-touch-target" style="padding:0 12px;">
        主题与倍率设置
      </button>
    </div>
  `;

  root.querySelector('#btn-title-continue')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      if (appActions && typeof appActions.continueLatestSave === 'function') {
        const res = await appActions.continueLatestSave();
        if (res && !res.ok && res.reason === 'no-save') {
          btn.disabled = false;
          uiKit.showToast('暂无可继续的存档，请先配置「新的征程」偏好！', 'warn');
          openNewJourneyModal(ctx);
        }
      } else if (modules.has('port-hub')) {
        modules.mount('port-hub', { transition: 'left' });
      }
    } catch (err) {
      btn.disabled = false;
      uiKit.showToast(err instanceof Error ? err.message : '读取存档失败', 'error');
    }
  });

  root.querySelector('#btn-title-new-journey')?.addEventListener('click', () => {
    try {
      openNewJourneyModal(ctx);
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '打开开局偏好设置失败', 'error');
    }
  });

  root.querySelector('#btn-title-load-save')?.addEventListener('click', () => {
    try {
      if (appActions && typeof appActions.openSaveVault === 'function') {
        appActions.openSaveVault();
      } else {
        uiKit.showToast('存档保险箱尚未就绪', 'warn');
      }
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '打开存档保险箱失败', 'error');
    }
  });

  root.querySelector('#btn-title-settings')?.addEventListener('click', () => {
    try {
      if (appActions && typeof appActions.openSettings === 'function') {
        appActions.openSettings();
      }
    } catch (err) {
      uiKit.showToast(err instanceof Error ? err.message : '打开设置失败', 'error');
    }
  });

  titleState.container.appendChild(root);
}

export default {
  id: 'title-screen',
  name: '启动封面',
  description: '游戏启动封面与开局偏好设置入口。',
  isSubpage: true,
  lockSwipe: true,

  mount(container, context) {
    titleState.container = container;
    titleState.context = context;
    if (context.ui && typeof context.ui.setTitleScreenMode === 'function') {
      context.ui.setTitleScreenMode(true);
    }
    renderTitleScreen();
  },

  unmount() {
    titleState.renderSeq += 1;
    if (titleState.context?.ui && typeof titleState.context.ui.setTitleScreenMode === 'function') {
      titleState.context.ui.setTitleScreenMode(false);
    }
    titleState.container = null;
    titleState.context = null;
  },
};
