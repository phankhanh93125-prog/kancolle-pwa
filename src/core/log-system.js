/**
 * Generic Chronological Action Log System.
 *
 * Records stat changes, equipment/outfit changes, 1D20 checks, resource changes,
 * and character updates with IndexedDB persistence, filtering, and one-tap text summary export
 * (for direct consumption by narrative modules or user backup).
 */

const STORAGE_NS = 'core-logs';
const LOGS_KEY = 'action-logs';
const MAX_ENTRIES = 500;

export const LOG_CATEGORIES = Object.freeze({
  CHECK: 'check',
  EQUIPMENT: 'equipment',
  STAT: 'stat',
  RESOURCE: 'resource',
  CHARACTER: 'character',
  SYSTEM: 'system',
});

export const LOG_CATEGORY_LABELS = Object.freeze({
  [LOG_CATEGORIES.CHECK]: '检定',
  [LOG_CATEGORIES.EQUIPMENT]: '穿脱装备',
  [LOG_CATEGORIES.STAT]: '数值变化',
  [LOG_CATEGORIES.RESOURCE]: '资源变动',
  [LOG_CATEGORIES.CHARACTER]: '角色管理',
  [LOG_CATEGORIES.SYSTEM]: '系统',
});

function formatTimeStamp(ts) {
  try {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return String(ts);
  }
}

function formatSigned(n) {
  const v = Number(n) || 0;
  return v >= 0 ? `+${v}` : `${v}`;
}

export class LogSystem {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({ storage, bus = null }) {
    this._scope = storage.namespace(STORAGE_NS);
    this._bus = bus;
    /** @type {Array<{ id: string, timestamp: number, category: string, title: string, detail: string, actorId: string | null, actorName: string, meta: object }>} */
    this._entries = [];
    this._hydrated = false;
    this._busAttached = false;
    this._unsubs = [];
  }

  async init() {
    if (this._hydrated) return;
    const saved = await this._scope.getLarge(LOGS_KEY, []);
    this._entries = Array.isArray(saved) ? saved.slice(-MAX_ENTRIES) : [];
    this._hydrated = true;
  }

  async persist() {
    await this._scope.setLarge(LOGS_KEY, this._entries.slice(-MAX_ENTRIES));
  }

  /**
   * Automatically listen to core framework EventBus events and record concise action logs.
   */
  attachBusListeners() {
    if (!this._bus || this._busAttached) return;
    this._busAttached = true;

    this._unsubs = [
      this._bus.on('stat-rules:check-performed', (res) => {
        this.add({
          category: LOG_CATEGORIES.CHECK,
          actorId: res.actorId,
          actorName: res.actorName || '',
          title: `${res.actorName ? `[${res.actorName}] ` : ''}${res.statLabel}检定 → ${res.outcomeLabel}`,
          detail: res.formulaText,
          meta: {
            statKey: res.statKey,
            dc: res.dc,
            total: res.total,
            naturalRoll: res.naturalRoll,
            outcome: res.outcome,
          },
        });
      }),
      this._bus.on('inventory:equipped', (ev) => {
        this.add({
          category: LOG_CATEGORIES.EQUIPMENT,
          actorId: ev.characterId,
          actorName: ev.characterName || '',
          title: `[${ev.characterName}] 穿戴「${ev.item.name}」`,
          detail: `槽位：${ev.slotLabel}（类别：${ev.item.category === 'outfit' ? '服装' : '装备'}）`,
          meta: { slotId: ev.slotId, itemId: ev.item.id },
        });
      }),
      this._bus.on('inventory:unequipped', (ev) => {
        this.add({
          category: LOG_CATEGORIES.EQUIPMENT,
          actorId: ev.characterId,
          actorName: ev.characterName || '',
          title: `[${ev.characterName}] 卸下「${ev.item?.name || '物品'}」`,
          detail: `槽位：${ev.slotLabel}`,
          meta: { slotId: ev.slotId, itemId: ev.item?.id || null },
        });
      }),
      this._bus.on('inventory:consumed', (ev) => {
        const changes = (ev.applied || [])
          .map((c) => `${c.stat} ${formatSigned(c.delta)}`)
          .join('，');
        this.add({
          category: LOG_CATEGORIES.STAT,
          actorId: ev.characterId,
          actorName: ev.characterName || '',
          title: `[${ev.characterName}] 使用消耗品「${ev.item.name}」`,
          detail: changes || '已消耗 1 个',
          meta: { itemId: ev.item.id, applied: ev.applied },
        });
      }),
      this._bus.on('resource:changed', (ev) => {
        this.add({
          category: LOG_CATEGORIES.RESOURCE,
          title: `资源「${ev.name}」${formatSigned(ev.delta)}${ev.unit || ''}`,
          detail: `${ev.before} → ${ev.after}${ev.unit || ''}（来源：${ev.reason || '手动'}）`,
          meta: { resourceId: ev.id, delta: ev.delta, after: ev.after },
        });
      }),
      this._bus.on('entity:offline-settled', (report) => {
        if (!report || !report.statChanges || report.statChanges.length === 0) return;
        const nonZero = report.statChanges.filter((c) => c.delta !== 0);
        if (nonZero.length === 0) return;
        const text = nonZero
          .slice(0, 6)
          .map((c) => `${c.entityName}.${c.stat} ${formatSigned(c.delta)}`)
          .join('；');
        this.add({
          category: LOG_CATEGORIES.STAT,
          title: `离线时间差结算（经过 ${report.formattedDuration}）`,
          detail: text,
          meta: { elapsedSec: report.clampedSec },
        });
      }),
    ];
  }

  add({ category = LOG_CATEGORIES.SYSTEM, title = '', detail = '', actorId = null, actorName = '', meta = {} } = {}) {
    const entry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      category: String(category || LOG_CATEGORIES.SYSTEM),
      title: String(title || '系统事件'),
      detail: String(detail || ''),
      actorId: actorId ? String(actorId) : null,
      actorName: String(actorName || ''),
      meta: meta && typeof meta === 'object' ? { ...meta } : {},
    };
    this._entries.push(entry);
    if (this._entries.length > MAX_ENTRIES) {
      this._entries = this._entries.slice(-MAX_ENTRIES);
    }
    this.persist();
    if (this._bus) {
      this._bus.emit('log:added', entry);
    }
    return entry;
  }

  list({ category = null, actorId = null, keyword = '', limit = 100 } = {}) {
    const kw = String(keyword || '').trim().toLowerCase();
    const filtered = [];
    for (let i = this._entries.length - 1; i >= 0; i--) {
      const e = this._entries[i];
      if (category && category !== 'all' && e.category !== category) continue;
      if (actorId && e.actorId !== actorId) continue;
      if (kw) {
        const hay = `${e.title} ${e.detail} ${e.actorName}`.toLowerCase();
        if (!hay.includes(kw)) continue;
      }
      filtered.push(e);
      if (filtered.length >= limit) break;
    }
    return filtered;
  }

  count() {
    return this._entries.length;
  }

  /**
   * Export a chronological plain-text summary (ready for copy/download or narrative context injection).
   */
  exportTextSummary({ category = null, actorId = null, limit = 40 } = {}) {
    const rows = this.list({ category, actorId, limit }).reverse();
    if (rows.length === 0) {
      return '（当前暂无符合条件的行动日志记录）';
    }
    const header = `=== 行动日志摘要（共 ${rows.length} 条，导出于 ${formatTimeStamp(Date.now())}）===`;
    const lines = rows.map((e) => {
      const catLabel = LOG_CATEGORY_LABELS[e.category] || e.category;
      const body = e.detail ? `${e.title} | ${e.detail}` : e.title;
      return `[${formatTimeStamp(e.timestamp)}] [${catLabel}] ${body}`;
    });
    return `${header}\n${lines.join('\n')}`;
  }

  async clear() {
    this._entries = [];
    await this.persist();
    if (this._bus) {
      this._bus.emit('log:cleared', {});
    }
  }
}
