import { PROVIDER_PRESETS } from '../core/api.js';

const HISTORY_KEY = 'messages';
const MAX_MESSAGES = 40;

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

let state = {
  container: null,
  context: null,
  messages: [],
  busy: false,
  showStorage: false,
  abortController: null,
  unsubs: [],
};

function loadMessages() {
  const saved = state.context.storage.get(HISTORY_KEY, []);
  return Array.isArray(saved) ? saved : [];
}

function saveMessages(messages) {
  const trimmed = messages.slice(-MAX_MESSAGES);
  state.messages = trimmed;
  state.context.storage.set(HISTORY_KEY, trimmed);
}

function renderStatusCard() {
  const config = state.context.api.getConfig();
  const isMock = state.context.api.isMockMode(config);
  const providerLabel = PROVIDER_PRESETS[config.provider]?.label || config.provider;
  const usage = state.context.storage.getUsage();

  return `
    <section class="surface-card console-status-card" aria-label="网关与存储状态">
      <div class="status-row">
        <div class="status-meta">
          <span class="status-badge ${isMock ? 'badge-warn' : 'badge-ok'}">
            ${isMock ? '本地模拟回显' : escapeHtml(providerLabel)}
          </span>
          <span class="status-model" title="当前模型">${escapeHtml(config.model)}</span>
        </div>
        <button type="button" class="btn-ghost-sm" data-action="toggle-storage">
          ${state.showStorage ? '收起存储' : '存储状态'}
        </button>
      </div>
      <div class="status-subline">
        <span>命名空间：<code>${escapeHtml(usage.namespace)}</code></span>
        <span>${state.messages.length} 条记录 · ${formatBytes(usage.bytes)}</span>
      </div>
    </section>
  `;
}

function renderStorageInspector() {
  if (!state.showStorage) return '';
  const rootStats = state.context.rootStorage.getStats();
  const moduleData = state.context.storage.getAll();
  const preview = JSON.stringify(moduleData, null, 2);

  return `
    <section class="surface-card storage-inspector" aria-label="本地存储调试面板">
      <div class="section-header-row">
        <h2 class="section-title">本地存储快照</h2>
        <span class="muted-text">共 ${rootStats.namespaceCount} 个命名空间 · ${formatBytes(rootStats.totalBytes)}</span>
      </div>
      <div class="ns-chip-list">
        ${
          rootStats.namespaces.length
            ? rootStats.namespaces
                .map(
                  (ns) =>
                    `<span class="ns-chip"><code>${escapeHtml(ns.namespace)}</code> · ${ns.keysCount} 键 (${formatBytes(ns.bytes)})</span>`
                )
                .join('')
            : '<span class="muted-text">暂无持久化键值</span>'
        }
      </div>
      <pre class="code-block">${escapeHtml(preview)}</pre>
    </section>
  `;
}

function renderMessages() {
  if (state.messages.length === 0) {
    return `
      <section class="surface-card empty-state" aria-label="初始引导">
        <h2 class="empty-title">AI 调试台已就绪</h2>
        <p class="muted-text">
          通过底部通用输入框发送消息，可直接验证多模型 API 网关与本地持久化链路。未配置 API Key 时将自动使用「本地模拟回显模式」。
        </p>
      </section>
    `;
  }

  return `
    <div class="chat-stream" id="ai-console-stream" role="log" aria-label="对话记录">
      ${state.messages
        .map((msg) => {
          const isUser = msg.role === 'user';
          const isError = msg.role === 'error';
          const roleClass = isUser ? 'msg-user' : isError ? 'msg-error' : 'msg-assistant';
          const metaParts = [];
          if (msg.createdAt) metaParts.push(formatTime(msg.createdAt));
          if (msg.model) metaParts.push(msg.model);
          if (msg.latencyMs) metaParts.push(`${msg.latencyMs}ms`);
          if (msg.mock) metaParts.push('模拟回显');

          return `
            <article class="chat-msg ${roleClass}">
              <div class="chat-msg-body">${escapeHtml(msg.content)}</div>
              ${
                metaParts.length
                  ? `<div class="chat-msg-meta">${escapeHtml(metaParts.join(' · '))}</div>`
                  : ''
              }
            </article>
          `;
        })
        .join('')}
      ${
        state.busy
          ? `
        <article class="chat-msg msg-assistant msg-loading">
          <div class="chat-msg-body">正在请求模型响应...</div>
        </article>`
          : ''
      }
    </div>
  `;
}

function render() {
  if (!state.container) return;
  state.container.innerHTML = `
    <div class="module-stack ai-console">
      ${renderStatusCard()}
      ${renderStorageInspector()}
      ${renderMessages()}
    </div>
  `;

  const toggleBtn = state.container.querySelector('[data-action="toggle-storage"]');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      state.showStorage = !state.showStorage;
      render();
    });
  }

  // Keep latest message visible inside stage
  requestAnimationFrame(() => {
    if (state.container) {
      state.container.scrollTop = state.container.scrollHeight;
    }
  });
}

async function handleSend(rawText) {
  const text = String(rawText || '').trim();
  if (!text || state.busy) return;

  const userMsg = {
    role: 'user',
    content: text,
    createdAt: new Date().toISOString(),
  };

  saveMessages([...state.messages, userMsg]);
  state.busy = true;
  state.context.ui.setInputBusy(true);
  render();

  state.abortController = new AbortController();

  try {
    const historyForApi = state.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));

    const result = await state.context.api.chat({
      messages: historyForApi,
      signal: state.abortController.signal,
    });

    const assistantMsg = {
      role: 'assistant',
      content: result.text,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      mock: result.mock,
      createdAt: new Date().toISOString(),
    };

    saveMessages([...state.messages, assistantMsg]);
  } catch (err) {
    if (err?.name !== 'AbortError') {
      const errorMsg = {
        role: 'error',
        content: err instanceof Error ? err.message : String(err),
        createdAt: new Date().toISOString(),
      };
      saveMessages([...state.messages, errorMsg]);
    }
  } finally {
    state.busy = false;
    state.abortController = null;
    if (state.context) {
      state.context.ui.setInputBusy(false);
    }
    render();
  }
}

async function runQuickPing() {
  if (state.busy) return;
  state.busy = true;
  state.context.ui.setInputBusy(true);
  render();

  const res = await state.context.api.testConnection();
  state.busy = false;
  state.context.ui.setInputBusy(false);

  if (res.ok) {
    state.context.ui.showToast(res.message, 'ok');
    saveMessages([
      ...state.messages,
      {
        role: 'assistant',
        content: `[连通性检测通过]\n${res.preview}`,
        provider: res.provider,
        model: res.model,
        latencyMs: res.latencyMs,
        mock: res.mock,
        createdAt: new Date().toISOString(),
      },
    ]);
  } else {
    state.context.ui.showToast(res.message, 'error');
    saveMessages([
      ...state.messages,
      {
        role: 'error',
        content: `[连通性检测失败]\n${res.message}`,
        createdAt: new Date().toISOString(),
      },
    ]);
  }
  render();
}

export default {
  id: 'ai-console',
  name: 'AI 调试台',
  description: '用于验证多模型 API 网关对话、本地模拟回显与独立存储命名空间的内置调试模块。',

  mount(container, context) {
    state.container = container;
    state.context = context;
    state.messages = loadMessages();
    state.busy = false;
    state.showStorage = false;

    context.ui.setPlaceholder('输入消息，测试大模型与本地存储...');
    context.ui.setInputHandler(handleSend);
    context.ui.setQuickActions([
      {
        id: 'ping-api',
        label: '测试连通',
        onClick: () => runQuickPing(),
      },
      {
        id: 'inspect-storage',
        label: '查看存储',
        onClick: () => {
          state.showStorage = !state.showStorage;
          render();
        },
      },
      {
        id: 'clear-chat',
        label: '清空对话',
        onClick: () => {
          state.context.storage.remove(HISTORY_KEY);
          state.messages = [];
          state.context.ui.showToast('已清空当前模块对话记录');
          render();
        },
      },
    ]);

    state.unsubs = [
      context.bus.on('api:config-changed', () => render()),
      context.bus.on('storage:changed', (detail) => {
        if (detail?.action === 'resetAll' || detail?.action === 'import') {
          state.messages = loadMessages();
        }
        render();
      }),
    ];

    render();
  },

  unmount() {
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    for (const unsub of state.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    state = {
      container: null,
      context: null,
      messages: [],
      busy: false,
      showStorage: false,
      abortController: null,
      unsubs: [],
    };
  },
};
