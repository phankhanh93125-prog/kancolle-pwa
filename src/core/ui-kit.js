/**
 * One-Handed Mobile UI Component Kit.
 *
 * All interactive elements enforce >= 44px touch targets and full safe-area awareness:
 *   - showToast(message, type, options)
 *   - openBottomSheet({ title, subtitle, content, actions, dismissible, onClose })
 *   - confirmDialog({ title, message, confirmLabel, cancelLabel, tone })
 *   - createProgressBar({ label, value, max, tone, showPercent, sublabel })
 *   - createTabs({ items, activeId, onChange })
 *   - createCollapsibleCard({ title, subtitle, badge, open, content })
 */

function clampPercent(value, max) {
  const m = Number(max);
  if (!Number.isFinite(m) || m <= 0) return 0;
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, (v / m) * 100));
}

function appendContent(container, content) {
  if (content === null || content === undefined) return;
  if (typeof content === 'string') {
    container.innerHTML = content;
  } else if (content instanceof Node) {
    container.appendChild(content);
  } else if (typeof content === 'function') {
    const ret = content(container);
    if (ret instanceof Node) container.appendChild(ret);
    else if (typeof ret === 'string') container.innerHTML = ret;
  }
}

export function showToast(message, type = 'info', { duration = 2600 } = {}) {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    document.body.appendChild(region);
  }

  const toneClass =
    type === 'ok'
      ? 'toast-ok'
      : type === 'error'
      ? 'toast-error'
      : type === 'warn'
      ? 'toast-warn'
      : '';

  const item = document.createElement('div');
  item.className = `toast-item ${toneClass}`.trim();
  item.textContent = String(message ?? '');
  item.style.pointerEvents = 'auto';
  item.addEventListener('click', () => item.remove());
  region.appendChild(item);

  const timer = setTimeout(() => {
    item.remove();
  }, Math.max(800, Number(duration) || 2600));

  return {
    dismiss() {
      clearTimeout(timer);
      item.remove();
    },
  };
}

/**
 * Open a one-handed slide-up Bottom Sheet modal (stackable, safe-area aware, >=44px controls).
 */
export function openBottomSheet({
  title = '面板',
  subtitle = '',
  content = null,
  actions = [],
  dismissible = true,
  onClose = null,
} = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop uikit-sheet-backdrop';
  backdrop.setAttribute('role', 'presentation');

  const dialog = document.createElement('section');
  dialog.className = 'sheet-dialog uikit-sheet-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  handle.setAttribute('aria-hidden', 'true');

  const header = document.createElement('header');
  header.className = 'sheet-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'uikit-sheet-titles';

  const titleEl = document.createElement('h2');
  titleEl.className = 'sheet-title';
  titleEl.textContent = title;
  titleWrap.appendChild(titleEl);

  if (subtitle) {
    const subEl = document.createElement('p');
    subEl.className = 'uikit-sheet-subtitle';
    subEl.textContent = subtitle;
    titleWrap.appendChild(subEl);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn-icon-close uikit-touch-target';
  closeBtn.setAttribute('aria-label', '关闭弹窗');
  closeBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
      <path d="M18 6 6 18"/>
      <path d="m6 6 12 12"/>
    </svg>
  `;

  header.appendChild(titleWrap);
  if (dismissible) {
    header.appendChild(closeBtn);
  }

  const body = document.createElement('div');
  body.className = 'sheet-body';
  appendContent(body, content);

  dialog.appendChild(handle);
  dialog.appendChild(header);
  dialog.appendChild(body);

  let closed = false;
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && dismissible) {
      close('escape');
    }
  };

  const close = (reason = 'close') => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
    if (typeof onClose === 'function') {
      onClose(reason);
    }
  };

  if (Array.isArray(actions) && actions.length > 0) {
    const footer = document.createElement('div');
    footer.className = 'uikit-sheet-footer';
    footer.style.gridTemplateColumns = actions.length === 1 ? '1fr' : `repeat(${Math.min(actions.length, 2)}, 1fr)`;
    for (const act of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const tone = act.tone === 'danger' ? 'btn-danger' : act.tone === 'secondary' ? 'btn-secondary' : 'btn-primary';
      btn.className = `${tone} uikit-touch-target`;
      btn.textContent = act.label || '确定';
      if (act.id) btn.dataset.sheetAction = act.id;
      btn.addEventListener('click', async () => {
        if (typeof act.onClick === 'function') {
          const ret = await act.onClick({ close, body });
          if (ret !== false && act.closeOnClick !== false) {
            close(act.id || 'action');
          }
        } else if (act.closeOnClick !== false) {
          close(act.id || 'action');
        }
      });
      footer.appendChild(btn);
    }
    dialog.appendChild(footer);
  }

  closeBtn.addEventListener('click', () => close('button'));
  if (dismissible) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close('backdrop');
    });
    document.addEventListener('keydown', onKeyDown);
  }

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  return {
    close,
    backdrop,
    dialog,
    body,
  };
}

/**
 * One-handed confirmation dialog built on Bottom Sheet.
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = '确认操作',
  message = '确定要继续执行此操作吗？',
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'primary',
} = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };

    const msgEl = document.createElement('p');
    msgEl.className = 'uikit-confirm-message';
    msgEl.textContent = message;

    openBottomSheet({
      title,
      content: msgEl,
      dismissible: true,
      onClose: () => finish(false),
      actions: [
        {
          id: 'cancel',
          label: cancelLabel,
          tone: 'secondary',
          onClick: () => finish(false),
        },
        {
          id: 'confirm',
          label: confirmLabel,
          tone: tone === 'danger' ? 'danger' : 'primary',
          onClick: () => finish(true),
        },
      ],
    });
  });
}

/**
 * Create a reactive progress bar component.
 */
export function createProgressBar({
  label = '',
  value = 0,
  max = 100,
  tone = 'accent',
  showPercent = true,
  sublabel = '',
} = {}) {
  const root = document.createElement('div');
  root.className = 'uikit-progress';

  const header = document.createElement('div');
  header.className = 'uikit-progress-header';

  const labelEl = document.createElement('span');
  labelEl.className = 'uikit-progress-label';

  const valueEl = document.createElement('span');
  valueEl.className = 'uikit-progress-value';

  header.appendChild(labelEl);
  header.appendChild(valueEl);

  const track = document.createElement('div');
  track.className = 'uikit-progress-track';
  track.setAttribute('role', 'progressbar');

  const fill = document.createElement('div');
  fill.className = 'uikit-progress-fill';
  track.appendChild(fill);

  root.appendChild(header);
  root.appendChild(track);

  let state = { label, value, max, tone, showPercent, sublabel };

  const render = () => {
    const pct = clampPercent(state.value, state.max);
    labelEl.textContent = state.label;
    if (state.sublabel) {
      valueEl.textContent = state.sublabel;
    } else if (state.showPercent) {
      valueEl.textContent = `${Math.round(state.value)} / ${state.max} (${Math.round(pct)}%)`;
    } else {
      valueEl.textContent = `${Math.round(state.value)} / ${state.max}`;
    }
    fill.style.width = `${pct.toFixed(1)}%`;
    fill.dataset.tone = state.tone || 'accent';
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(state.max));
    track.setAttribute('aria-valuenow', String(state.value));
  };

  render();

  return {
    element: root,
    update(patch = {}) {
      state = { ...state, ...patch };
      render();
    },
  };
}

/**
 * Create mobile segmented tabs (>= 44px touch targets, horizontally scrollable when > 4 items).
 */
export function createTabs({ items = [], activeId = null, onChange = null } = {}) {
  const root = document.createElement('div');
  root.className = `uikit-tabs ${items.length <= 4 ? 'uikit-tabs-grid' : 'uikit-tabs-scroll'}`;
  root.setAttribute('role', 'tablist');
  if (items.length <= 4 && items.length > 0) {
    root.style.gridTemplateColumns = `repeat(${items.length}, minmax(0, 1fr))`;
  }

  let currentId = activeId || items[0]?.id || null;
  /** @type {Map<string, HTMLButtonElement>} */
  const buttons = new Map();

  const updateActiveStyles = () => {
    for (const [id, btn] of buttons.entries()) {
      const isActive = id === currentId;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  };

  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'uikit-tab-btn uikit-touch-target';
    btn.setAttribute('role', 'tab');
    btn.dataset.tabId = item.id;

    const textSpan = document.createElement('span');
    textSpan.textContent = item.label;
    btn.appendChild(textSpan);

    if (item.badge !== undefined && item.badge !== null && item.badge !== '') {
      const badge = document.createElement('span');
      badge.className = 'uikit-tab-badge';
      badge.textContent = String(item.badge);
      btn.appendChild(badge);
    }

    btn.addEventListener('click', () => {
      if (currentId === item.id) return;
      currentId = item.id;
      updateActiveStyles();
      if (typeof onChange === 'function') {
        onChange(item.id, item);
      }
    });

    buttons.set(item.id, btn);
    root.appendChild(btn);
  }

  updateActiveStyles();

  return {
    element: root,
    getActive() {
      return currentId;
    },
    setActive(id, { silent = false } = {}) {
      if (!buttons.has(id)) return;
      currentId = id;
      updateActiveStyles();
      if (!silent && typeof onChange === 'function') {
        const item = items.find((i) => i.id === id);
        onChange(id, item);
      }
    },
  };
}

/**
 * Create a collapsible accordion card with >= 44px header button.
 */
export function createCollapsibleCard({
  title = '折叠面板',
  subtitle = '',
  badge = '',
  open = false,
  content = null,
} = {}) {
  const card = document.createElement('section');
  card.className = 'surface-card uikit-collapsible';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'uikit-collapsible-trigger uikit-touch-target';
  trigger.setAttribute('aria-expanded', open ? 'true' : 'false');

  const meta = document.createElement('div');
  meta.className = 'uikit-collapsible-meta';

  const titleRow = document.createElement('div');
  titleRow.className = 'uikit-collapsible-title-row';

  const titleEl = document.createElement('span');
  titleEl.className = 'uikit-collapsible-title';
  titleEl.textContent = title;
  titleRow.appendChild(titleEl);

  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'status-badge badge-ok';
    badgeEl.textContent = badge;
    titleRow.appendChild(badgeEl);
  }
  meta.appendChild(titleRow);

  if (subtitle) {
    const subEl = document.createElement('span');
    subEl.className = 'uikit-collapsible-subtitle';
    subEl.textContent = subtitle;
    meta.appendChild(subEl);
  }

  const chevron = document.createElement('span');
  chevron.className = 'uikit-collapsible-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

  trigger.appendChild(meta);
  trigger.appendChild(chevron);

  const body = document.createElement('div');
  body.className = 'uikit-collapsible-body';
  body.hidden = !open;
  appendContent(body, content);

  let isOpen = Boolean(open);
  const sync = () => {
    card.classList.toggle('is-open', isOpen);
    trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    body.hidden = !isOpen;
  };
  sync();

  trigger.addEventListener('click', () => {
    isOpen = !isOpen;
    sync();
  });

  card.appendChild(trigger);
  card.appendChild(body);

  return {
    element: card,
    body,
    isOpen() {
      return isOpen;
    },
    toggle(force) {
      isOpen = force !== undefined ? Boolean(force) : !isOpen;
      sync();
    },
    setContent(nextContent) {
      body.innerHTML = '';
      appendContent(body, nextContent);
    },
  };
}

/**
 * Unified Full-Screen Sub-Page Top Header (`← 返回港区` + Module Title + Key Resource Balances).
 */
export function createSubpageHeader({
  title,
  subtitle = '',
  backLabel = '← 返回港区',
  onBack = null,
  modules = null,
  resources = null,
  resourceKeys = ['fuel', 'ammo'],
  rightSlot = null,
  id = '',
} = {}) {
  const header = document.createElement('div');
  header.className = 'subpage-topbar';
  if (id) header.id = id;

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'subpage-back-btn';
  backBtn.id = 'btn-subpage-back';
  backBtn.textContent = backLabel;
  backBtn.addEventListener('click', () => {
    if (typeof onBack === 'function') {
      onBack();
    } else if (modules && modules.has('port-hub')) {
      modules.mount('port-hub', { transition: 'right' });
    }
  });

  const titleBox = document.createElement('div');
  titleBox.className = 'subpage-title-box';
  const titleEl = document.createElement('h1');
  titleEl.className = 'subpage-title';
  titleEl.textContent = title || '设施界面';
  titleBox.appendChild(titleEl);
  if (subtitle) {
    const subEl = document.createElement('span');
    subEl.className = 'subpage-subtitle';
    subEl.textContent = subtitle;
    titleBox.appendChild(subEl);
  }

  const rightBox = document.createElement('div');
  rightBox.className = 'subpage-right-box';
  if (rightSlot instanceof Node) {
    rightBox.appendChild(rightSlot);
  } else if (resources && Array.isArray(resourceKeys) && resourceKeys.length > 0) {
    const shortLabels = {
      fuel: '油',
      ammo: '弹',
      steel: '钢',
      bauxite: '铝',
      silver: '银',
      gold: '金',
    };
    for (const key of resourceKeys.slice(0, 3)) {
      const r = resources.get(key);
      if (!r) continue;
      const pill = document.createElement('span');
      pill.className = 'subpage-res-pill';
      pill.dataset.subpageRes = key;
      pill.textContent = `${shortLabels[key] || r.name}${Math.floor(r.amount)}`;
      rightBox.appendChild(pill);
    }
  }

  header.appendChild(backBtn);
  header.appendChild(titleBox);
  header.appendChild(rightBox);

  return header;
}

export function createUIKit() {
  return {
    showToast,
    openBottomSheet,
    confirmDialog,
    createProgressBar,
    createTabs,
    createCollapsibleCard,
    createSubpageHeader,
  };
}
