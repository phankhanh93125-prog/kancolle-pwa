/**
 * Unified Multi-Model LLM API Gateway.
 * Supports:
 *   1. Google Gemini Official REST API (generateContent)
 *   2. OpenAI-Compatible Chat Completions API
 *   3. Local Mock Echo Mode (automatically active when API Key is empty or mock mode is enabled)
 *
 * All credentials remain strictly in local browser storage and are never sent to any third-party proxy.
 */

export const PROVIDER_PRESETS = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini 官方 REST',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI 兼容格式',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    suggestedModels: ['gpt-4o-mini', 'gpt-4.1-mini', 'deepseek-chat'],
  },
};

export const DEFAULT_API_CONFIG = {
  provider: 'gemini',
  baseUrl: PROVIDER_PRESETS.gemini.baseUrl,
  apiKey: '',
  model: PROVIDER_PRESETS.gemini.model,
  temperature: 0.7,
  systemPrompt: '你是一个简洁、严谨、响应迅速的通用 AI 助手。',
  forceMock: false,
};

function trimTrailingSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

export class ApiGateway {
  /**
   * @param {{ storage: import('./storage.js').StorageManager, bus?: import('./event-bus.js').EventBus }} deps
   */
  constructor({ storage, bus = null }) {
    this._store = storage.namespace('core-api');
    this._bus = bus;
  }

  getDefaults(provider = 'gemini') {
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.gemini;
    return {
      ...DEFAULT_API_CONFIG,
      provider: preset.id,
      baseUrl: preset.baseUrl,
      model: preset.model,
    };
  }

  getConfig() {
    const saved = this._store.get('config', null);
    if (!saved || typeof saved !== 'object') {
      return { ...DEFAULT_API_CONFIG };
    }
    const provider = PROVIDER_PRESETS[saved.provider] ? saved.provider : 'gemini';
    const preset = PROVIDER_PRESETS[provider];
    return {
      ...DEFAULT_API_CONFIG,
      ...saved,
      provider,
      baseUrl: typeof saved.baseUrl === 'string' && saved.baseUrl.trim()
        ? trimTrailingSlash(saved.baseUrl)
        : preset.baseUrl,
      model: typeof saved.model === 'string' && saved.model.trim()
        ? saved.model.trim()
        : preset.model,
      temperature: Number.isFinite(Number(saved.temperature))
        ? Math.min(2, Math.max(0, Number(saved.temperature)))
        : DEFAULT_API_CONFIG.temperature,
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey.trim() : '',
      systemPrompt: typeof saved.systemPrompt === 'string'
        ? saved.systemPrompt
        : DEFAULT_API_CONFIG.systemPrompt,
      forceMock: Boolean(saved.forceMock),
    };
  }

  saveConfig(partial) {
    const next = {
      ...this.getConfig(),
      ...partial,
    };
    const provider = PROVIDER_PRESETS[next.provider] ? next.provider : 'gemini';
    const preset = PROVIDER_PRESETS[provider];
    const sanitized = {
      provider,
      baseUrl: trimTrailingSlash(next.baseUrl || preset.baseUrl),
      apiKey: String(next.apiKey || '').trim(),
      model: String(next.model || preset.model).trim(),
      temperature: Math.min(2, Math.max(0, Number(next.temperature ?? 0.7))),
      systemPrompt: String(next.systemPrompt ?? ''),
      forceMock: Boolean(next.forceMock),
    };
    this._store.set('config', sanitized);
    if (this._bus) {
      this._bus.emit('api:config-changed', sanitized);
    }
    return sanitized;
  }

  isMockMode(config = this.getConfig()) {
    return Boolean(config.forceMock || !config.apiKey);
  }

  /**
   * Unified chat completion call across Gemini, OpenAI-compatible, or Local Mock Echo.
   * @param {{
   *   prompt?: string,
   *   messages?: Array<{ role: 'user'|'assistant'|'system', content: string }>,
   *   systemPrompt?: string,
   *   temperature?: number,
   *   signal?: AbortSignal,
   *   configOverride?: Partial<typeof DEFAULT_API_CONFIG>
   * }} params
   */
  async chat(params = {}) {
    const config = params.configOverride
      ? { ...this.getConfig(), ...params.configOverride }
      : this.getConfig();

    const normalizedMessages = Array.isArray(params.messages) && params.messages.length > 0
      ? params.messages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
          content: String(m.content ?? ''),
        }))
      : [{ role: 'user', content: String(params.prompt ?? '') }];

    const systemPrompt = params.systemPrompt !== undefined ? params.systemPrompt : config.systemPrompt;
    const temperature = params.temperature !== undefined ? params.temperature : config.temperature;

    const start = performance.now();

    if (this.isMockMode(config)) {
      return this._runMockEcho({
        config,
        messages: normalizedMessages,
        systemPrompt,
        temperature,
        start,
      });
    }

    if (config.provider === 'gemini') {
      return this._callGemini({
        config,
        messages: normalizedMessages,
        systemPrompt,
        temperature,
        signal: params.signal,
        start,
      });
    }

    return this._callOpenAICompatible({
      config,
      messages: normalizedMessages,
      systemPrompt,
      temperature,
      signal: params.signal,
      start,
    });
  }

  async _runMockEcho({ config, messages, systemPrompt, temperature, start }) {
    await new Promise((resolve) => setTimeout(resolve, 220));
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const inputText = lastUser?.content?.trim() || '(空消息)';
    const providerLabel = PROVIDER_PRESETS[config.provider]?.label || config.provider;
    const latencyMs = Math.max(1, Math.round(performance.now() - start));

    const text = [
      `[本地模拟回显模式] 已收到指令：「${inputText}」`,
      `当前通道：${providerLabel} · 模型：${config.model} · Temperature：${temperature.toFixed(1)}`,
      systemPrompt ? `系统提示词已载入（${systemPrompt.length} 字符）。` : '未设置系统提示词。',
      '提示：如需连接真实大模型，请在顶部「API 设置」中填入对应 API Key。',
    ].join('\n');

    return {
      text,
      provider: config.provider,
      model: config.model,
      mock: true,
      latencyMs,
      usage: null,
      raw: null,
    };
  }

  async _callGemini({ config, messages, systemPrompt, temperature, signal, start }) {
    const baseUrl = trimTrailingSlash(config.baseUrl || PROVIDER_PRESETS.gemini.baseUrl);
    const endpoint = `${baseUrl}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body = {
      contents,
      generationConfig: {
        temperature,
      },
    };

    if (systemPrompt && systemPrompt.trim()) {
      body.systemInstruction = {
        parts: [{ text: systemPrompt.trim() }],
      };
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.error?.message || `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`Gemini 接口调用失败：${detail}`);
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((p) => p?.text || '')
      .join('')
      .trim();

    if (!text) {
      throw new Error('Gemini 返回内容为空，请检查模型名或安全过滤策略');
    }

    return {
      text,
      provider: 'gemini',
      model: config.model,
      mock: false,
      latencyMs: Math.max(1, Math.round(performance.now() - start)),
      usage: data?.usageMetadata || null,
      raw: data,
    };
  }

  async _callOpenAICompatible({ config, messages, systemPrompt, temperature, signal, start }) {
    const baseUrl = trimTrailingSlash(config.baseUrl || PROVIDER_PRESETS.openai.baseUrl);
    const endpoint = baseUrl.endsWith('/chat/completions')
      ? baseUrl
      : `${baseUrl}/chat/completions`;

    const payloadMessages = [];
    if (systemPrompt && systemPrompt.trim()) {
      payloadMessages.push({ role: 'system', content: systemPrompt.trim() });
    }
    for (const m of messages) {
      if (m.role !== 'system') {
        payloadMessages.push({ role: m.role, content: m.content });
      }
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature,
        messages: payloadMessages,
      }),
      signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.error?.message || `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`OpenAI 兼容接口调用失败：${detail}`);
    }

    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    if (!text) {
      throw new Error('接口返回内容为空，请检查模型配置或 Base URL');
    }

    return {
      text,
      provider: 'openai',
      model: config.model,
      mock: false,
      latencyMs: Math.max(1, Math.round(performance.now() - start)),
      usage: data?.usage || null,
      raw: data,
    };
  }

  /**
   * Run a lightweight connectivity check against current (or unsaved form) config.
   * @param {Partial<typeof DEFAULT_API_CONFIG>} [configOverride]
   */
  async testConnection(configOverride) {
    try {
      const result = await this.chat({
        prompt: '连通性测试：请简短回复 OK。',
        configOverride,
      });
      return {
        ok: true,
        mock: result.mock,
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        message: result.mock
          ? `模拟回显测试成功（${result.latencyMs}ms，未填 API Key 时自动启用本地模拟模式）`
          : `连接成功（${result.provider} / ${result.model} · ${result.latencyMs}ms）`,
        preview: result.text,
      };
    } catch (err) {
      return {
        ok: false,
        mock: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
