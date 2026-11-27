/**
 * Hot-Pluggable Local Event Pack & Multi-Chapter Story Pack Engine (`story-pack-engine.js`).
 *
 * Capabilities:
 *   1. Global Story Variables & Progress Locks (Flags):
 *        - Persisted key-value store supporting booleans, numeric counters, and strings
 *        - Condition evaluator supporting flag checks, character affinity thresholds,
 *          owned inventory items, and Commander 6-stats / independent Luck checks
 *   2. Multiple Concurrent Event Packs & Story Packs:
 *        - Independent name, version, category ('port_daily' | 'sortie_encounter' | 'main_chapter'),
 *          non-destructive enabled/disabled toggle, multi-node branching scripts
 *        - Visual node/choice CRUD + single-pack `.json` export & import
 *   3. Built-in 2 Starter Packs:
 *        - Pack 1: 港区日常互动扩展包 (port_daily)
 *        - Pack 2: 多章节海域调查剧情包 (main_chapter, 3 linked chapters with Flag locks)
 *   4. Seamless Dual-Track Narrative (pure offline templates + optional AI polish via PromptPipeline).
 */

import { clamp } from './calc-engine.js';
import { LOG_CATEGORIES } from './log-system.js';

const STORAGE_NS = 'core-story-packs';
const STATE_KEY = 'story-packs-v1';

export const STORY_PACK_SCHEMA = 'kancolle-pwa-story-pack-v1';

export const PACK_CATEGORIES = Object.freeze({
  PORT_DAILY: 'port_daily',
  SORTIE_ENCOUNTER: 'sortie_encounter',
  MAIN_CHAPTER: 'main_chapter',
});

export const PACK_CATEGORY_LABELS = Object.freeze({
  [PACK_CATEGORIES.PORT_DAILY]: '港区日常',
  [PACK_CATEGORIES.SORTIE_ENCOUNTER]: '出征奇遇',
  [PACK_CATEGORIES.MAIN_CHAPTER]: '章节主线',
});

export const LEGACY_REMOVED_BUILTIN_PACK_IDS = Object.freeze(
  new Set([
    'pack_port_daily_ext',
    'pack_sea_investigation',
    'pack_port_life_15',
    'pack_abyssal_ruins_4ch',
    'pack_abyssal_ruins_04',
  ])
);

// All legacy built-in story packs have been permanently removed; user-imported external JSON packs remain 100% supported.
export const BUILTIN_STORY_PACKS = Object.freeze([]);

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

export class StoryPackEngine {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   entities: import('./entity-system.js').EntitySystem,
   *   inventory: import('./inventory-system.js').InventorySystem,
   *   resources: import('./resource-manager.js').ResourceManager,
   *   statRules: import('./stat-rules.js').StatRulesEngine,
   *   commander: import('./commander-system.js').CommanderSystem,
   *   narrative: import('./prompt-pipeline.js').PromptPipeline,
   *   interaction?: import('./interaction-system.js').InteractionSystem | null,
   *   logs?: import('./log-system.js').LogSystem | null,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({
    storage,
    entities,
    inventory,
    resources,
    statRules,
    commander,
    narrative,
    interaction = null,
    logs = null,
    bus = null,
  }) {
    this._storage = storage;
    this._scope = storage.namespace(STORAGE_NS);
    this._entities = entities;
    this._inventory = inventory;
    this._resources = resources;
    this._statRules = statRules;
    this._commander = commander;
    this._narrative = narrative;
    this._interaction = interaction;
    this._storyEngine = null;
    this._logs = logs;
    this._bus = bus;

    /** @type {Record<string, boolean | number | string>} */
    this._flags = {};
    /** @type {Array<object>} */
    this._packs = deepClone(BUILTIN_STORY_PACKS);
    /** @type {Array<object>} */
    this._playHistory = [];
    this._hydrated = false;
  }

  setStoryEngine(se) {
    this._storyEngine = se;
  }

  _emit(event, payload) {
    if (this._bus) this._bus.emit(event, payload);
  }

  async init() {
    if (this._hydrated) return;
    const saved = await this._scope.getLarge(STATE_KEY, null);
    if (saved && typeof saved === 'object') {
      this.deserialize(saved, { persist: false });
    } else {
      this._packs = deepClone(BUILTIN_STORY_PACKS);
      this._flags = {};
      await this.persist();
    }
    this._hydrated = true;
  }

  async persist() {
    await this._scope.setLarge(STATE_KEY, this.serialize());
  }

  /**
   * Non-destructively merge any missing built-in starter story/event packs
   * (such as 16-event Port Life Daily Pack & 4-Chapter Abyssal Ruins Pack) without overwriting existing data.
   */
  async ensureStarterStoryPacks() {
    const existingIds = new Set(this._packs.map((p) => p.id));
    let added = 0;
    for (const tpl of BUILTIN_STORY_PACKS) {
      if (!existingIds.has(tpl.id)) {
        this._packs.push(deepClone(tpl));
        added += 1;
      }
    }
    if (added > 0) {
      await this.persist();
      this._emit('story:packs-changed', { action: 'merge-starter', added });
    }
    return { added };
  }

  // ------------------------------------------------------------
  // Global Story Variables & Progress Flags
  // ------------------------------------------------------------

  getFlag(key, defaultValue = undefined) {
    const k = String(key || '').trim();
    return Object.prototype.hasOwnProperty.call(this._flags, k) ? this._flags[k] : defaultValue;
  }

  getAllFlags() {
    return deepClone(this._flags);
  }

  async setFlag(key, value) {
    const k = String(key || '').trim();
    if (!k) return;
    this._flags[k] = value;
    await this.persist();
    this._emit('story:flag-changed', { key: k, value });
  }

  async incrementFlag(key, delta = 1) {
    const k = String(key || '').trim();
    if (!k) return 0;
    const next = (Number(this._flags[k]) || 0) + (Number(delta) || 0);
    this._flags[k] = next;
    await this.persist();
    this._emit('story:flag-changed', { key: k, value: next });
    return next;
  }

  async deleteFlag(key) {
    const k = String(key || '').trim();
    if (Object.prototype.hasOwnProperty.call(this._flags, k)) {
      delete this._flags[k];
      await this.persist();
      this._emit('story:flag-changed', { key: k, deleted: true });
    }
  }

  /**
   * Evaluate condition array against Flags, active character affinity, inventory items, and Commander stats/luck.
   */
  checkConditions(conditions = [], { actor = null } = {}) {
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return { ok: true, unmetReasons: [] };
    }
    const targetActor = actor || this._interaction?.getSecretary() || this._entities?.list({ kind: 'character' })[0] || null;
    const unmetReasons = [];

    for (const cond of conditions) {
      if (!cond || typeof cond !== 'object') continue;
      if (cond.type === 'flag') {
        const cur = this.getFlag(cond.key);
        const op = cond.op || 'truthy';
        let pass = false;
        if (op === 'truthy') pass = Boolean(cur);
        else if (op === 'falsy') pass = !cur;
        else if (op === 'eq') pass = cur === cond.value;
        else if (op === 'neq') pass = cur !== cond.value;
        else if (op === 'gte') pass = Number(cur || 0) >= Number(cond.value);
        else if (op === 'lte') pass = Number(cur || 0) <= Number(cond.value);
        if (!pass) {
          unmetReasons.push(`需要进度标记 ${cond.key}${op === 'truthy' ? ' 已激活' : ` ${op} ${cond.value}`}`);
        }
      } else if (cond.type === 'affinityMin') {
        const aff = Math.round(Number(targetActor?.stats?.affinity ?? 0));
        if (aff < Number(cond.value || 0)) {
          unmetReasons.push(`需要角色好感 ≥ ${cond.value}（当前 ${aff}）`);
        }
      } else if (cond.type === 'hasItem') {
        const items = this._inventory?.listItems() || [];
        const found = items.some((it) => it.id === cond.itemId || it.name === cond.itemId);
        if (!found) {
          unmetReasons.push(`需要拥有物品「${cond.itemId}」`);
        }
      } else if (cond.type === 'commanderStat') {
        const val = this._commander ? this._commander.getStat(cond.stat) : 0;
        if (val < Number(cond.min ?? 0)) {
          unmetReasons.push(`需要指挥官 ${cond.stat} ≥ ${cond.min}（当前 ${val}）`);
        }
      }
    }

    return { ok: unmetReasons.length === 0, unmetReasons };
  }

  // ------------------------------------------------------------
  // Hot-Pluggable Pack Management (CRUD / Enable-Disable / JSON)
  // ------------------------------------------------------------

  listPacks({ enabledOnly = false, category = null } = {}) {
    return this._packs
      .filter((p) => {
        if (enabledOnly && !p.enabled) return false;
        if (category && p.category !== category) return false;
        return true;
      })
      .map((p) => deepClone(p));
  }

  getPack(packId) {
    const p = this._packs.find((x) => x.id === String(packId));
    return p ? deepClone(p) : null;
  }

  async togglePack(packId, forceState = null) {
    const target = this._packs.find((p) => p.id === String(packId));
    if (!target) throw new Error(`未找到剧情包：${packId}`);
    target.enabled = forceState !== null ? Boolean(forceState) : !target.enabled;
    await this.persist();
    this._emit('story:packs-changed', { packId: target.id, enabled: target.enabled });
    return deepClone(target);
  }

  async savePack(packDef = {}) {
    const normalized = normalizeAdaptiveStoryPack(packDef);
    if (!normalized) throw new Error('剧情包名称不能为空或缺少有效剧情内容');
    const pack = {
      ...normalized,
      builtIn: Boolean(packDef.builtIn),
    };

    const idx = this._packs.findIndex((p) => p.id === pack.id);
    if (idx >= 0) this._packs[idx] = pack;
    else this._packs.push(pack);

    await this.persist();
    this._emit('story:packs-changed', { packId: pack.id, action: 'save' });
    return deepClone(pack);
  }

  async saveNode(packId, nodeDef) {
    const pack = this._packs.find((p) => p.id === String(packId));
    if (!pack) throw new Error('目标剧情包不存在');
    const cleanId = String(nodeDef.id || `node_${Date.now().toString(36)}`).trim();
    const node = {
      id: cleanId,
      title: String(nodeDef.title || '未命名节点').trim(),
      speaker: String(nodeDef.speaker || '').trim(),
      body: String(nodeDef.body || nodeDef.text || nodeDef.content || '').trim(),
      conditions: Array.isArray(nodeDef.conditions) ? deepClone(nodeDef.conditions) : [],
      choices: Array.isArray(nodeDef.choices) ? deepClone(nodeDef.choices) : [],
    };
    const idx = pack.nodes.findIndex((n) => n.id === cleanId);
    if (idx >= 0) pack.nodes[idx] = node;
    else pack.nodes.push(node);

    await this.persist();
    this._emit('story:packs-changed', { packId: pack.id, nodeId: cleanId });
    return deepClone(node);
  }

  async deletePack(packId) {
    const target = this._packs.find((p) => p.id === String(packId));
    if (!target) return false;
    if (target.builtIn) {
      throw new Error('内置示例包不可删除，可通过开关停用');
    }
    this._packs = this._packs.filter((p) => p.id !== String(packId));
    await this.persist();
    this._emit('story:packs-changed', { packId, action: 'delete' });
    return true;
  }

  exportPackToJSON(packId) {
    const pack = this.getPack(packId);
    if (!pack) throw new Error('目标剧情包不存在');
    return {
      schema: STORY_PACK_SCHEMA,
      exportedAt: new Date().toISOString(),
      pack: { ...pack, builtIn: false },
    };
  }

  async importPackFromJSON(rawInput) {
    const res = await this.importPacksFromData(rawInput);
    return res.lastPack;
  }

  /**
   * Adaptive importer for one or multiple story/event packs from parsed JSON, array, or pasted text.
   * Supports `packs`, `storyPacks`, `events`, `stories`, `chapters`, bare arrays, or single event objects
   * using `nodes` / `scenes` / `steps` / `dialogues` and `choices` / `options` / `branches`.
   */
  async importPacksFromData(rawInput) {
    const cleaned =
      typeof rawInput === 'string'
        ? rawInput.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        : rawInput;
    const parsed = typeof cleaned === 'string' ? JSON.parse(cleaned) : cleaned;
    let list = [];
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed?.schema === STORY_PACK_SCHEMA && parsed.pack) {
      list = [parsed.pack];
    } else if (parsed && typeof parsed === 'object') {
      const containerArrays = [parsed.packs, parsed.storyPacks, parsed.events, parsed.stories, parsed.chapters].filter(
        Array.isArray
      );
      if (containerArrays.length > 0) {
        list = containerArrays.flat();
      } else {
        list = [parsed];
      }
    }

    const imported = [];
    for (const p of list) {
      const target = p?.schema === STORY_PACK_SCHEMA && p.pack ? p.pack : p;
      const normalized = normalizeAdaptiveStoryPack(target);
      if (normalized) {
        const saved = await this.savePack({ ...normalized, builtIn: false });
        imported.push(saved);
      }
    }
    if (imported.length === 0) {
      throw new Error('未在 JSON 中识别到有效的事件/剧情包（需包含 title/name 及 scenes/nodes/text 内容）');
    }
    return {
      importedCount: imported.length,
      packNames: imported.map((p) => p.name),
      lastPack: imported[imported.length - 1],
    };
  }

  // ------------------------------------------------------------
  // Interactive Story Execution (Node Rendering + Branch Choice Settlement)
  // ------------------------------------------------------------

  _getActor(actorId = null) {
    if (actorId && this._entities?.has(actorId)) return this._entities.get(actorId);
    return this._interaction?.getSecretary() || this._entities?.list({ kind: 'character' })[0] || null;
  }

  async renderNodeView(packId, nodeId = null, opts = {}) {
    const actorId = typeof opts === 'string' ? opts : opts?.actorId || opts?.characterId || null;
    const pack = this.getPack(packId);
    if (!pack) throw new Error('剧情包不存在');
    const actor = this._getActor(actorId);
    const targetId = nodeId || pack.entryNodeId || pack.nodes[0]?.id;
    const node = pack.nodes.find((n) => n.id === targetId) || pack.nodes[0];
    if (!node) throw new Error('该剧情包没有可用节点');

    const nodeCond = this.checkConditions(node.conditions || [], { actor });
    const cmdProfile = this._commander ? this._commander.getProfile() : { name: '指挥官', title: '提督' };
    const vars = {
      actor: { name: actor?.name || '秘书舰', shipType: actor?.meta?.shipType || '驱逐舰' },
      commander: { name: cmdProfile.name, title: cmdProfile.title },
      cmd: cmdProfile.name,
      name: actor?.name || '秘书舰',
      flags: this.getAllFlags(),
    };

    const rawBody = String(node.body || node.text || node.content || node.line || '').trim() || `${pack.name} · ${node.title}`;
    const renderedBody = await this._narrative.run({
      template: rawBody,
      variables: vars,
      polishInstruction: `请以简洁细腻的剧情演绎风格润色剧情节点「${node.title}」的叙述，保留人物与场景事实：`,
    });

    const speakerResolved = node.speaker
      ? String(node.speaker)
          .replaceAll('{actor.name}', actor?.name || '秘书舰')
          .replaceAll('{actor}', actor?.name || '秘书舰')
          .replaceAll('{name}', actor?.name || '秘书舰')
          .replaceAll('{commander.name}', cmdProfile.name)
          .replaceAll('{commander}', cmdProfile.name)
          .replaceAll('{cmd}', cmdProfile.name)
      : '';

    const rawChoices = Array.isArray(node.choices) && node.choices.length > 0
      ? node.choices
      : [
          {
            id: 'c_auto_end',
            label: '结束本幕',
            conditions: [],
            check: null,
            effects: { affinity: 2, morale: 4 },
            resultText: '这一段港区回忆静静落下了帷幕。',
            nextNodeId: null,
          },
        ];

    const choices = rawChoices.map((ch) => {
      const chCond = this.checkConditions(ch.conditions || [], { actor });
      return {
        ...deepClone(ch),
        unlocked: nodeCond.ok && chCond.ok,
        unmetReasons: [...nodeCond.unmetReasons, ...chCond.unmetReasons],
      };
    });

    return {
      pack,
      node: {
        ...deepClone(node),
        speaker: speakerResolved,
        renderedBody: renderedBody.text,
        source: renderedBody.source,
        degraded: renderedBody.degraded,
      },
      speaker: speakerResolved,
      text: renderedBody.text,
      nodeUnlocked: nodeCond.ok,
      unmetReasons: nodeCond.unmetReasons,
      choices,
      actorName: actor?.name || '秘书舰',
    };
  }

  async executeChoice(packIdOrObj, nodeIdArg = null, choiceIdArg = null, optsArg = {}) {
    let packId = packIdOrObj;
    let nodeId = nodeIdArg;
    let choiceId = choiceIdArg;
    let actorId = typeof optsArg === 'string' ? optsArg : optsArg?.actorId || optsArg?.characterId || null;

    if (packIdOrObj && typeof packIdOrObj === 'object') {
      packId = packIdOrObj.packId;
      nodeId = packIdOrObj.nodeId;
      choiceId = packIdOrObj.choiceId;
      actorId = packIdOrObj.actorId || packIdOrObj.characterId || null;
    }

    const pack = this.getPack(packId);
    if (!pack) throw new Error('剧情包不存在');
    if (!pack.enabled) throw new Error(`剧情包「${pack.name}」当前已停用，请先启用`);
    const node = pack.nodes.find((n) => n.id === nodeId) || pack.nodes[0];
    if (!node) throw new Error('目标节点不存在');
    let choice = (node.choices || []).find((c) => c.id === choiceId);
    if (!choice && choiceId === 'c_auto_end') {
      choice = {
        id: 'c_auto_end',
        label: '结束本幕',
        conditions: [],
        check: null,
        effects: { affinity: 2, morale: 4 },
        resultText: '这一段港区回忆静静落下了帷幕。',
        nextNodeId: null,
      };
    }
    if (!choice) throw new Error('目标选项不存在');

    const actor = this._getActor(actorId);
    const nodeCond = this.checkConditions(node.conditions || [], { actor });
    const chCond = this.checkConditions(choice.conditions || [], { actor });
    if (!nodeCond.ok || !chCond.ok) {
      throw new Error(`前置条件未满足：${[...nodeCond.unmetReasons, ...chCond.unmetReasons].join('；')}`);
    }

    let checkResult = null;
    let passed = true;
    if (choice.check && choice.check.statKey) {
      const sk = choice.check.statKey;
      const baseVal = Number(actor?.stats?.[sk] ?? 50);
      const effVal = actor ? this._entities.getEffectiveStat(actor.id, sk, { round: 'round' }).final : baseVal;
      const eqCheck = actor ? this._inventory.getCharacterEquipmentBonuses(actor.id).checkBonus : 0;
      checkResult = this._statRules.performCheck({
        actorId: actor?.id || null,
        actorName: actor?.name || '舰娘',
        statKey: sk,
        baseStatValue: baseVal,
        effectiveStatValue: effVal,
        equipmentCheckBonus: eqCheck,
        moraleValue: actor?.stats?.morale ?? 70,
        dc: Number(choice.check.dc) || 12,
        commanderLuck: this._commander ? this._commander.getLuck() : 0,
      });
      passed = checkResult.outcome === 'crit-success' || checkResult.outcome === 'success';
    }

    const activeEffects = passed ? choice.effects || {} : choice.failEffects || choice.effects || {};
    const appliedChips = [];

    // 1. Write Flags
    if (activeEffects.flags && typeof activeEffects.flags === 'object') {
      for (const [fk, fv] of Object.entries(activeEffects.flags)) {
        this._flags[fk] = fv;
        appliedChips.push({ text: `Flag ${fk}=${fv}`, negative: false });
      }
    }

    // 2. Apply Resource Deltas
    if (activeEffects.resources && typeof activeEffects.resources === 'object') {
      for (const [rk, rawDelta] of Object.entries(activeEffects.resources)) {
        const delta = Math.round(Number(rawDelta) || 0);
        if (delta > 0) {
          await this._resources.add(rk, delta, { reason: `剧情「${pack.name}」` });
          appliedChips.push({ text: `${this._resources.get(rk)?.name || rk} +${delta}`, negative: false });
        } else if (delta < 0) {
          await this._resources.spend(rk, Math.abs(delta), { reason: `剧情「${pack.name}」` }).catch(() => null);
          appliedChips.push({ text: `${this._resources.get(rk)?.name || rk} ${delta}`, negative: true });
        }
      }
    }

    // 3. Apply Character Affinity / Morale
    if (actor) {
      if (activeEffects.affinity) {
        const mult = this._commander ? this._commander.getAffinityGainMultiplier() : 1.0;
        const affDelta = Math.round(Number(activeEffects.affinity) * (activeEffects.affinity > 0 ? mult : 1));
        if (this._storyEngine && typeof this._storyEngine.gainAffection === 'function') {
          const res = this._storyEngine.gainAffection(actor.id, affDelta, { source: 'story-pack' });
          appliedChips.push({
            text: res.gained >= 0 ? `好感 +${res.gained}${res.hitGate ? `（达上限${res.hitGate}）` : ''}` : `好感 ${res.gained}`,
            negative: res.gained < 0,
          });
        } else {
          const maxAff = this._interaction ? this._interaction.getMaxAffinityFor(actor.id) : 100;
          this._entities.adjustStat(actor.id, 'affinity', affDelta, { min: 0, max: maxAff });
          appliedChips.push({ text: `好感 ${affDelta >= 0 ? `+${affDelta}` : affDelta}`, negative: affDelta < 0 });
        }
      }
      if (activeEffects.morale) {
        const mDelta = Math.round(Number(activeEffects.morale));
        this._entities.adjustStat(actor.id, 'morale', mDelta, { min: 0, max: 100 });
        appliedChips.push({ text: `士气 ${mDelta >= 0 ? `+${mDelta}` : mDelta}`, negative: mDelta < 0 });
      }
    }

    // 4. Apply Commander EXP & Independent Luck
    if (this._commander) {
      if (activeEffects.commanderExp > 0) {
        await this._commander.grantExp(activeEffects.commanderExp, `剧情「${node.title}」`);
        appliedChips.push({ text: `指挥官 EXP +${activeEffects.commanderExp}`, negative: false });
      }
      if (activeEffects.commanderLuck) {
        await this._commander.adjustLuck(activeEffects.commanderLuck, `剧情抉择：${node.title}`);
        appliedChips.push({
          text: `指挥官运气 ${activeEffects.commanderLuck > 0 ? `+${activeEffects.commanderLuck}` : activeEffects.commanderLuck}`,
          negative: activeEffects.commanderLuck < 0,
        });
      }
    }

    // 5. Render Dual-Track Outcome Narrative
    const cmdProfile = this._commander ? this._commander.getProfile() : { name: '指挥官' };
    const isSilentAutoAdvance = Boolean(choice.autoAdvance && !choice.resultText && choice.nextNodeId);
    const template = isSilentAutoAdvance
      ? ''
      : passed
      ? choice.resultText || '抉择已完成。'
      : choice.failText || choice.resultText || '行动遇阻。';
    const rendered = isSilentAutoAdvance
      ? { text: '', source: 'local', degraded: false }
      : await this._narrative.run({
          template,
          variables: {
            actor: { name: actor?.name || '秘书舰' },
            commander: { name: cmdProfile.name },
            cmd: cmdProfile.name,
            name: actor?.name || '秘书舰',
            check: checkResult,
          },
          polishInstruction: `请简短润色剧情「${node.title}」的抉择结局，保留关键事件事实：`,
        });

    const record = {
      id: `st_${Date.now().toString(36)}`,
      packId: pack.id,
      packName: pack.name,
      nodeId: node.id,
      nodeTitle: node.title,
      choiceLabel: choice.label,
      passed,
      check: checkResult,
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      chips: appliedChips,
      nextNodeId: choice.nextNodeId || null,
      autoAdvance: isSilentAutoAdvance,
      timestamp: Date.now(),
    };

    if (!isSilentAutoAdvance) {
      this._playHistory.unshift(record);
      if (this._playHistory.length > 30) this._playHistory.length = 30;
    }
    await this.persist();

    if (this._logs && !isSilentAutoAdvance) {
      this._logs.add({
        category: LOG_CATEGORIES.ACTION,
        actorId: actor?.id || null,
        actorName: actor?.name || '',
        title: `[剧情] ${pack.name} · ${node.title}`,
        detail: `${choice.label} → ${appliedChips.map((c) => c.text).join('、') || '推进完成'}`,
      });
    }
    this._emit('story:choice-resolved', record);
    return record;
  }

  getHistory() {
    return deepClone(this._playHistory);
  }

  /**
   * Central Story Theatre handoff state so launching any Story/Event Pack from Compendium
   * or Port Hub immediately plays it full-stage in the unified Central Story Theatre.
   */
  setActiveTheatreSession(packId, nodeId = null) {
    const pack = this.getPack(packId);
    if (!pack) return null;
    const targetNodeId =
      nodeId && pack.nodes.some((n) => n.id === nodeId)
        ? String(nodeId)
        : pack.entryNodeId || pack.nodes[0]?.id || null;
    this._theatreSession = {
      packId: pack.id,
      nodeId: targetNodeId,
      lastOutcome: null,
      startedAt: Date.now(),
    };
    this._emit('story:theatre-updated', deepClone(this._theatreSession));
    return deepClone(this._theatreSession);
  }

  getActiveTheatreSession() {
    if (!this._theatreSession) return null;
    const pack = this.getPack(this._theatreSession.packId);
    if (!pack) {
      this._theatreSession = null;
      return null;
    }
    return deepClone(this._theatreSession);
  }

  updateActiveTheatreOutcome(outcome = null, nextNodeId = null) {
    if (!this._theatreSession) return null;
    this._theatreSession.lastOutcome = outcome ? deepClone(outcome) : null;
    if (nextNodeId) {
      this._theatreSession.nodeId = String(nextNodeId);
    }
    return deepClone(this._theatreSession);
  }

  clearActiveTheatreSession() {
    this._theatreSession = null;
    this._emit('story:theatre-updated', null);
  }

  serialize() {
    return {
      version: 1,
      flags: deepClone(this._flags),
      packs: deepClone(this._packs),
      playHistory: deepClone(this._playHistory.slice(0, 30)),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._flags = deepClone(snapshot.flags || {});
    const rawPacks = Array.isArray(snapshot.packs) ? deepClone(snapshot.packs) : [];
    // Purge all legacy built-in packs while strictly preserving every external / user-imported JSON pack!
    const filteredPacks = rawPacks.filter((p) => {
      if (!p || !p.id) return false;
      if (LEGACY_REMOVED_BUILTIN_PACK_IDS.has(String(p.id))) return false;
      if (p.builtIn === true) return false;
      return true;
    });
    const hadLegacy = filteredPacks.length !== rawPacks.length;
    this._packs = filteredPacks;
    this._playHistory = Array.isArray(snapshot.playHistory) ? deepClone(snapshot.playHistory.slice(0, 30)) : [];
    if (persist || hadLegacy) this.persist();
  }
}

function normalizeAdaptiveEffects(rawChoice = {}) {
  const src =
    rawChoice.effects && typeof rawChoice.effects === 'object'
      ? rawChoice.effects
      : rawChoice.rewards && typeof rawChoice.rewards === 'object'
      ? rawChoice.rewards
      : rawChoice.reward && typeof rawChoice.reward === 'object'
      ? rawChoice.reward
      : {};

  const out = {};
  if (src.flags && typeof src.flags === 'object') {
    out.flags = deepClone(src.flags);
  } else if (rawChoice.flags && typeof rawChoice.flags === 'object') {
    out.flags = deepClone(rawChoice.flags);
  }

  const resMap = {};
  const srcRes =
    src.resources && typeof src.resources === 'object'
      ? src.resources
      : rawChoice.resources && typeof rawChoice.resources === 'object'
      ? rawChoice.resources
      : {};
  for (const [k, v] of Object.entries(srcRes)) {
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) resMap[k] = n;
  }
  for (const rk of ['fuel', 'ammo', 'steel', 'bauxite', 'silver', 'gold']) {
    const v = src[rk] !== undefined ? src[rk] : rawChoice[rk];
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0 && resMap[rk] === undefined) {
      resMap[rk] = n;
    }
  }
  if (Object.keys(resMap).length > 0) out.resources = resMap;

  const aff = Number(src.affinity ?? rawChoice.affinity ?? src.aff ?? rawChoice.aff ?? 0);
  if (Number.isFinite(aff) && aff !== 0) out.affinity = aff;

  const mor = Number(src.morale ?? rawChoice.morale ?? 0);
  if (Number.isFinite(mor) && mor !== 0) out.morale = mor;

  const exp = Number(src.commanderExp ?? rawChoice.commanderExp ?? src.exp ?? rawChoice.exp ?? 0);
  if (Number.isFinite(exp) && exp > 0) out.commanderExp = exp;

  const luck = Number(src.commanderLuck ?? rawChoice.commanderLuck ?? src.luck ?? rawChoice.luck ?? 0);
  if (Number.isFinite(luck) && luck !== 0) out.commanderLuck = luck;

  return out;
}

function normalizeAdaptiveChoice(rawChoice = {}, idx = 0) {
  if (typeof rawChoice === 'string') {
    return {
      id: `c_${idx + 1}`,
      label: rawChoice.trim() || '继续',
      conditions: [],
      check: null,
      effects: { affinity: 2, morale: 4 },
      resultText: '做出了这个选择，港区的微风轻拂而过。',
      failText: '',
      nextNodeId: null,
    };
  }
  const label = String(
    rawChoice.label ?? rawChoice.text ?? rawChoice.title ?? rawChoice.option ?? rawChoice.name ?? '继续'
  ).trim();
  const resultText = String(
    rawChoice.resultText ??
      rawChoice.nextText ??
      rawChoice.reply ??
      rawChoice.response ??
      rawChoice.feedback ??
      rawChoice.outcomeText ??
      rawChoice.outcome ??
      '抉择已完成。'
  ).trim();
  const failText = String(rawChoice.failText ?? rawChoice.failReply ?? '').trim();
  const nextRaw =
    rawChoice.nextNodeId ??
    rawChoice.nextSceneId ??
    rawChoice.nextStepId ??
    rawChoice.targetNodeId ??
    rawChoice.next ??
    null;
  const nextNodeId = nextRaw !== null && nextRaw !== undefined && String(nextRaw).trim() !== '' ? String(nextRaw).trim() : null;

  let check = null;
  if (rawChoice.check && typeof rawChoice.check === 'object' && rawChoice.check.statKey) {
    check = {
      statKey: String(rawChoice.check.statKey),
      dc: Math.max(5, Number(rawChoice.check.dc) || 12),
    };
  }

  const effects = normalizeAdaptiveEffects(rawChoice);
  const failEffects =
    rawChoice.failEffects && typeof rawChoice.failEffects === 'object'
      ? deepClone(rawChoice.failEffects)
      : undefined;

  return {
    id: String(rawChoice.id || `c_${idx + 1}`),
    label: label || `选项 ${idx + 1}`,
    conditions: Array.isArray(rawChoice.conditions) ? deepClone(rawChoice.conditions) : [],
    check,
    effects,
    ...(failEffects ? { failEffects } : {}),
    resultText,
    ...(failText ? { failText } : {}),
    nextNodeId,
  };
}

/**
 * Universal Adaptive Story / Event Pack Normalizer:
 * Accepts canonical packs (`name` + `nodes`), visual-novel scene scripts (`title` + `scenes` + `choices` + `nextText`),
 * step arrays (`steps` / `dialogues`), or single flat event objects (`title` + `text` + `options`).
 */
export function normalizeAdaptiveStoryPack(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? raw.title ?? raw.eventName ?? raw.packName ?? '').trim();
  if (!name) return null;

  const id = String(raw.id || `pack_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`);

  const rawCategory = String(raw.category ?? raw.type ?? '').toLowerCase();
  const category = Object.values(PACK_CATEGORIES).includes(raw.category)
    ? raw.category
    : rawCategory.includes('main') || rawCategory.includes('chapter')
    ? PACK_CATEGORIES.MAIN_CHAPTER
    : rawCategory.includes('season') || rawCategory.includes('fest') || rawCategory.includes('holiday')
    ? PACK_CATEGORIES.SEASONAL_EVENT
    : PACK_CATEGORIES.PORT_DAILY;

  const rawParagraphs =
    Array.isArray(raw.nodes)
      ? raw.nodes
      : Array.isArray(raw.scenes)
      ? raw.scenes
      : Array.isArray(raw.steps)
      ? raw.steps
      : Array.isArray(raw.dialogues)
      ? raw.dialogues
      : Array.isArray(raw.stages)
      ? raw.stages
      : Array.isArray(raw.parts)
      ? raw.parts
      : null;

  const topChoicesRaw =
    Array.isArray(raw.choices)
      ? raw.choices
      : Array.isArray(raw.options)
      ? raw.options
      : Array.isArray(raw.branches)
      ? raw.branches
      : null;

  let normalizedNodes = [];

  if (rawParagraphs && rawParagraphs.length > 0) {
    // First pass: assign stable IDs so sequential scenes can chain cleanly
    const assignedIds = rawParagraphs.map((seg, i) => {
      if (seg && typeof seg === 'object') {
        return String(seg.id || seg.sceneId || seg.stepId || `scene_${String(i + 1).padStart(2, '0')}`);
      }
      return `scene_${String(i + 1).padStart(2, '0')}`;
    });

    normalizedNodes = rawParagraphs.map((seg, i) => {
      const isLast = i === rawParagraphs.length - 1;
      const nextSeqId = !isLast ? assignedIds[i + 1] : null;
      if (typeof seg === 'string') {
        const choices = isLast && topChoicesRaw && topChoicesRaw.length > 0
          ? topChoicesRaw.map((ch, ci) => normalizeAdaptiveChoice(ch, ci))
          : nextSeqId
          ? [
              {
                id: `c_next_${i + 1}`,
                label: '继续 →',
                conditions: [],
                check: null,
                effects: {},
                resultText: '',
                nextNodeId: nextSeqId,
              },
            ]
          : [
              {
                id: `c_end_${i + 1}`,
                label: '结束剧场',
                conditions: [],
                check: null,
                effects: { affinity: 3, morale: 5 },
                resultText: '这一段港区日常小剧场圆满落幕。',
                nextNodeId: null,
              },
            ];
        return {
          id: assignedIds[i],
          title: rawParagraphs.length > 1 ? `${name} (${i + 1}/${rawParagraphs.length})` : name,
          speaker: '',
          body: seg.trim(),
          conditions: [],
          choices,
        };
      }

      const nodeTitle = String(
        seg.title ?? seg.sceneTitle ?? (rawParagraphs.length > 1 ? `${name} · 第 ${i + 1} 幕` : name)
      ).trim();
      const speaker = String(seg.speaker ?? seg.character ?? seg.actor ?? (seg.title ? seg.name || '' : seg.name || '')).trim();
      const body = String(
        seg.body ?? seg.text ?? seg.content ?? seg.line ?? seg.dialogue ?? seg.narration ?? ''
      ).trim();

      const segChoicesRaw =
        Array.isArray(seg.choices)
          ? seg.choices
          : Array.isArray(seg.options)
          ? seg.options
          : Array.isArray(seg.branches)
          ? seg.branches
          : null;

      let choices = [];
      if (segChoicesRaw && segChoicesRaw.length > 0) {
        choices = segChoicesRaw.map((ch, ci) => normalizeAdaptiveChoice(ch, ci));
      } else if (isLast && topChoicesRaw && topChoicesRaw.length > 0) {
        choices = topChoicesRaw.map((ch, ci) => normalizeAdaptiveChoice(ch, ci));
      } else if (nextSeqId) {
        choices = [
          {
            id: `c_next_${i + 1}`,
            label: '继续 →',
            conditions: [],
            check: null,
            effects: {},
            resultText: '',
            nextNodeId: nextSeqId,
            autoAdvance: true,
          },
        ];
      } else {
        choices = [
          {
            id: `c_end_${i + 1}`,
            label: '完成本幕',
            conditions: [],
            check: null,
            effects: { affinity: 3, morale: 6 },
            resultText: '剧场演绎圆满完成！',
            nextNodeId: null,
          },
        ];
      }

      return {
        id: assignedIds[i],
        title: nodeTitle || name,
        speaker,
        body: body || `${name} 的剧情正在展开……`,
        conditions: Array.isArray(seg.conditions) ? deepClone(seg.conditions) : [],
        choices,
      };
    });
  } else {
    const flatBody = String(raw.body ?? raw.text ?? raw.content ?? raw.line ?? raw.prompt ?? '').trim();
    if (!flatBody && !topChoicesRaw && !raw.description) {
      return null;
    }
    const choices =
      topChoicesRaw && topChoicesRaw.length > 0
        ? topChoicesRaw.map((ch, ci) => normalizeAdaptiveChoice(ch, ci))
        : [
            {
              id: 'c_default',
              label: '继续推进',
              conditions: [],
              check: null,
              effects: { flags: { [`${id}_started`]: true }, affinity: 3, commanderExp: 15 },
              resultText: '故事节点已完成并记录了进度标记。',
              nextNodeId: null,
            },
          ];
    normalizedNodes = [
      {
        id: 'node_01',
        title: name,
        speaker: String(raw.speaker ?? raw.character ?? '').trim(),
        body: flatBody || String(raw.description || '{commander.name}与{actor.name}在港区开启了新的故事篇章。'),
        conditions: Array.isArray(raw.conditions) ? deepClone(raw.conditions) : [],
        choices,
      },
    ];
  }

  return {
    id,
    name,
    version: String(raw.version || '1.0.0').trim(),
    category,
    description: String(raw.description ?? raw.desc ?? raw.summary ?? raw.intro ?? '自定义本地事件/剧情包').trim(),
    enabled: raw.enabled !== false,
    builtIn: Boolean(raw.builtIn),
    entryNodeId: String(
      raw.entryNodeId && normalizedNodes.some((n) => n.id === String(raw.entryNodeId))
        ? raw.entryNodeId
        : normalizedNodes[0].id
    ),
    nodes: normalizedNodes,
  };
}

