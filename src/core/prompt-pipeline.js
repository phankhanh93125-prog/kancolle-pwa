/**
 * Dual-Track Narrative Router & Variable Interpolation Pipeline.
 *
 * Implements "Local Rule First + Optional AI Enhancement":
 *   1. `local`     — Pure local template mode (zero API usage, 100% offline).
 *   2. `ai-polish` — Deterministic rule outcome is rendered locally first, then optionally
 *                    expanded/polished by the configured LLM API without altering objective facts.
 *   3. `ai-free`   — Freeform AI generation with automatic seamless degradation to local template
 *                    when API Key is unconfigured, device is offline, or request fails/times out.
 */

export const NARRATIVE_MODES = Object.freeze({
  LOCAL: 'local',
  AI_POLISH: 'ai-polish',
  AI_FREE: 'ai-free',
});

export const NARRATIVE_MODE_META = Object.freeze({
  [NARRATIVE_MODES.LOCAL]: {
    id: NARRATIVE_MODES.LOCAL,
    label: '纯本地模板',
    shortLabel: '本地离线',
    description: '零 API 消耗，完全依赖本地规则与模板变量插值即时渲染。',
  },
  [NARRATIVE_MODES.AI_POLISH]: {
    id: NARRATIVE_MODES.AI_POLISH,
    label: 'AI 润色模式',
    shortLabel: 'AI 润色',
    description: '先由本地规则引擎计算客观结果，再交由大模型润色扩写；无 Key 或断网自动无感降级。',
  },
  [NARRATIVE_MODES.AI_FREE]: {
    id: NARRATIVE_MODES.AI_FREE,
    label: 'AI 自由模式',
    shortLabel: 'AI 自由',
    description: '允许自由文本交互由模型直接生成；API 不可用时自动降级回退至本地模板兜底。',
  },
});

const FORBIDDEN_PATH_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

function lookupPath(obj, path) {
  const parts = String(path || '').split('.');
  let cur = obj;
  for (const part of parts) {
    if (!part || FORBIDDEN_PATH_PARTS.has(part)) return undefined;
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Safe variable interpolation renderer.
 * Supports:
 *   - `{name}` and nested dot paths `{actor.energy}`, `{delta.score}`
 *   - Default fallback values `{delta.score|0}` or `{label|未命名}`
 *   - Signed number formatting `{+delta.energy}` (prefixes positive numbers with "+")
 *
 * @param {string} template
 * @param {Record<string, any>} [variables={}]
 * @returns {string}
 */
export function renderTemplate(template, variables = {}) {
  const src = String(template ?? '');
  if (!src) return '';

  return src.replace(/\{([^{}]+)\}/g, (_full, rawExpr) => {
    const expr = String(rawExpr).trim();
    const pipeIdx = expr.indexOf('|');
    const rawKey = pipeIdx >= 0 ? expr.slice(0, pipeIdx).trim() : expr;
    const fallback = pipeIdx >= 0 ? expr.slice(pipeIdx + 1).trim() : '';

    const forceSign = rawKey.startsWith('+');
    const key = forceSign ? rawKey.slice(1).trim() : rawKey;
    const value = lookupPath(variables, key);

    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    if (forceSign && typeof value === 'number') {
      return value > 0 ? `+${value}` : String(value);
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return fallback;
      }
    }
    return String(value);
  });
}

function withTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`AI 请求超时（>${timeoutMs}ms）`));
    }, timeoutMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class PromptPipeline {
  /**
   * @param {{
   *   api: import('./api.js').ApiGateway,
   *   storage?: import('./storage.js').StorageManager | null,
   *   bus?: import('./event-bus.js').EventBus | null,
   *   defaultMode?: string
   * }} deps
   */
  constructor({ api, storage = null, bus = null, defaultMode = NARRATIVE_MODES.LOCAL }) {
    this._api = api;
    this._store = storage ? storage.namespace('core-narrative') : null;
    this._bus = bus;
    const savedMode = this._store?.get('mode', null);
    this._mode = NARRATIVE_MODE_META[savedMode] ? savedMode : defaultMode;
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  getMode() {
    return this._mode;
  }

  getModeInfo(mode = this._mode) {
    return NARRATIVE_MODE_META[mode] || NARRATIVE_MODE_META[NARRATIVE_MODES.LOCAL];
  }

  setMode(mode) {
    if (!NARRATIVE_MODE_META[mode]) {
      throw new Error(`不支持的叙事模式: "${mode}"`);
    }
    this._mode = mode;
    if (this._store) {
      this._store.set('mode', mode);
    }
    this._emit('narrative:mode-changed', { mode, info: this.getModeInfo(mode) });
    return mode;
  }

  /**
   * Check whether a live (non-mock) remote LLM API is currently ready.
   */
  canUseLiveAI() {
    if (!this._api) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    return !this._api.isMockMode();
  }

  renderTemplate(template, variables = {}) {
    return renderTemplate(template, variables);
  }

  /**
   * Execute the dual-track pipeline.
   * Guarantees an uninterrupted result even when offline, unconfigured, or on API error.
   *
   * @param {{
   *   template?: string,
   *   variables?: Record<string, any>,
   *   ruleResult?: object | null,
   *   userInput?: string,
   *   systemPrompt?: string,
   *   polishInstruction?: string,
   *   modeOverride?: string | null,
   *   timeoutMs?: number
   * }} request
   */
  async run(request = {}) {
    const start = performance.now();
    const mode = request.modeOverride && NARRATIVE_MODE_META[request.modeOverride]
      ? request.modeOverride
      : this._mode;

    const variables = request.variables || {};
    const templateStr = request.template || (request.userInput ? '本地响应：已记录输入「{userInput}」。' : '规则已执行完成。');
    const localText = renderTemplate(templateStr, {
      ...variables,
      userInput: request.userInput ?? variables.userInput ?? '',
    });

    // Track 1: Pure local template mode (zero API calls)
    if (mode === NARRATIVE_MODES.LOCAL) {
      const output = {
        text: localText,
        localText,
        mode,
        source: 'local-template',
        degraded: false,
        degradeReason: null,
        latencyMs: Math.max(1, Math.round(performance.now() - start)),
        model: null,
      };
      this._emit('narrative:rendered', output);
      return output;
    }

    // Check API readiness before attempting Track 2 / Track 3
    if (!this.canUseLiveAI()) {
      const reason =
        typeof navigator !== 'undefined' && navigator.onLine === false
          ? '设备当前离线，已自动降级为本地模板输出'
          : '未配置真实 API Key（或处于模拟模式），已自动降级为本地模板输出';
      const output = {
        text: localText,
        localText,
        mode,
        source: 'local-fallback',
        degraded: true,
        degradeReason: reason,
        latencyMs: Math.max(1, Math.round(performance.now() - start)),
        model: null,
      };
      this._emit('narrative:rendered', output);
      return output;
    }

    // Track 2 / Track 3: Call live LLM API with automatic fallback on failure/timeout
    const timeoutMs = Number(request.timeoutMs) || 20000;
    try {
      let promptText = '';
      let sysPrompt = request.systemPrompt;

      if (mode === NARRATIVE_MODES.AI_POLISH) {
        const objectiveJson = request.ruleResult
          ? JSON.stringify(
              {
                deltas: request.ruleResult.executionLog?.deltas || {},
                itemsChanged: request.ruleResult.executionLog?.itemsChanged || {},
                flagsChanged: request.ruleResult.executionLog?.flagsChanged || {},
              },
              null,
              0
            )
          : '{}';
        sysPrompt =
          sysPrompt ||
          '你是通用的叙事润色助手。请严格保留给定客观结果中的全部数值与事实，不要篡改或虚构数值变化，仅在语言表达上进行简洁流畅的润色扩展。';
        promptText = [
          request.polishInstruction || '请基于以下客观规则结果进行简洁润色：',
          `[本地客观结果] ${localText}`,
          `[结构化变更] ${objectiveJson}`,
        ].join('\n');
      } else {
        // AI_FREE
        sysPrompt =
          sysPrompt ||
          '你是通用交互式系统的自由文本响应助手，请基于给定上下文给出清晰、简洁的回复。';
        promptText = request.userInput
          ? `${request.userInput}\n\n[上下文参考] ${localText}`
          : localText;
      }

      const apiRes = await withTimeout(
        this._api.chat({
          prompt: promptText,
          systemPrompt: sysPrompt,
        }),
        timeoutMs
      );

      const output = {
        text: apiRes.text || localText,
        localText,
        mode,
        source: mode === NARRATIVE_MODES.AI_POLISH ? 'ai-polish' : 'ai-free',
        degraded: false,
        degradeReason: null,
        latencyMs: Math.max(1, Math.round(performance.now() - start)),
        model: apiRes.model || null,
      };
      this._emit('narrative:rendered', output);
      return output;
    } catch (err) {
      const reason = `AI 调用异常（${err instanceof Error ? err.message : String(err)}），已无感降级为本地模板输出`;
      const output = {
        text: localText,
        localText,
        mode,
        source: 'local-fallback',
        degraded: true,
        degradeReason: reason,
        latencyMs: Math.max(1, Math.round(performance.now() - start)),
        model: null,
      };
      this._emit('narrative:rendered', output);
      return output;
    }
  }
}
