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

  uiKit.openModal({
    title: '新的征程 · 开局偏好设置',
    renderContent: (body, close) => {
      const renderForm = () => {
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
              <span><strong>保留已创建的自定义内容包、性格池与 UI 皮肤</strong>（推荐勾选，不丢失个人创作）</span>
            </label>

            <button type="button" id="btn-nj-confirm" class="btn-primary port-cta-btn">
              确认偏好 · 启航新征程
            </button>
          </div>
        `;

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

        body.querySelector('#nj-keep-custom').addEventListener('change', (e) => {
          prefs.keepCustomData = Boolean(e.target.checked);
        });

        body.querySelector('#btn-nj-confirm').addEventListener('click', async () => {
          syncName();
          const btn = body.querySelector('#btn-nj-confirm');
          btn.disabled = true;
          btn.textContent = '正在整备新港区...';
          try {
            if (appActions && typeof appActions.startNewJourney === 'function') {
              await appActions.startNewJourney(prefs);
            }
            close();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = '确认偏好 · 启航新征程';
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
};

async function renderTitleScreen() {
  if (!titleState.container || !titleState.context) return;
  const { commander, entities, formation, interaction, resources, saves, modules, appActions } =
    titleState.context;

  const autoMeta = saves ? await saves.getAutoSaveMeta() : null;
  const manualSlots = saves ? (await saves.listSlots()).filter((s) => !s.empty) : [];
  const cmd = commander ? commander.getProfile() : { name: '港区指挥官', level: 1 };
  const chars = entities ? entities.list({ kind: 'character' }) : [];
  const activeFleetCount = formation ? formation.getMemberIds().length : 0;
  const secretary = interaction?.getSecretary() || chars[0] || null;
  const hasContinuableSave = Boolean(autoMeta || manualSlots.length > 0 || chars.length > 0);
  const dropMult = resources && typeof resources.getDropMultiplier === 'function' ? resources.getDropMultiplier() : 1.0;

  const continueCmdName = autoMeta?.summary?.commanderName || cmd.name || '港区指挥官';
  const continueCmdLv = autoMeta?.summary?.commanderLevel ?? cmd.level ?? 1;
  const continueTotalShips = Math.max(chars.length, autoMeta?.summary?.characters || 0);
  const continueFleetShips = Math.max(activeFleetCount, autoMeta?.summary?.fleetCount || 0);
  const continueSecName = secretary?.name || autoMeta?.summary?.flagshipName || '';

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
      ${
        hasContinuableSave
          ? `
        <button type="button" id="btn-title-continue" class="title-cta-primary">
          <span class="title-cta-label">继续航行</span>
          <span class="title-cta-meta">
            指挥官：${escapeHtml(continueCmdName)} Lv.${continueCmdLv} · 舰队 ${continueFleetShips}/${continueTotalShips} 舰${continueSecName ? ` · 秘书舰 ${escapeHtml(continueSecName)}` : ''}
          </span>
        </button>
      `
          : ''
      }

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

  root.querySelector('#btn-title-continue')?.addEventListener('click', () => {
    if (modules.has('port-hub')) {
      modules.mount('port-hub', { transition: 'left' });
    }
  });

  root.querySelector('#btn-title-new-journey')?.addEventListener('click', () => {
    openNewJourneyModal(titleState.context);
  });

  root.querySelector('#btn-title-load-save')?.addEventListener('click', () => {
    if (appActions && typeof appActions.openSaveVault === 'function') {
      appActions.openSaveVault();
    }
  });

  root.querySelector('#btn-title-settings')?.addEventListener('click', () => {
    if (appActions && typeof appActions.openSettings === 'function') {
      appActions.openSettings();
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
    if (titleState.context?.ui && typeof titleState.context.ui.setTitleScreenMode === 'function') {
      titleState.context.ui.setTitleScreenMode(false);
    }
    titleState.container = null;
    titleState.context = null;
  },
};
