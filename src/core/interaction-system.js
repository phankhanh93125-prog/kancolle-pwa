/**
 * Secretary Daily Interaction & Oath System (`interaction-system.js`).
 *
 * Integrates:
 *   - Commander `charisma` (魅力) & `affinity` (亲和) + independent `luck`
 *   - Character's equipped outfit, personality, speechHabit, and affinity stage
 *   - PromptPipeline dual-track narrative (rich offline dynamic dialogue OR AI context-aware chat)
 *   - Secretary designation, Daily Talk, Gift Giving, Daily Port Events, and Oath Ceremony (unlocks at Affinity >= 100)
 */

import { clamp } from './calc-engine.js';
import { LOG_CATEGORIES } from './log-system.js';
import {
  BASE_AFFINITY_CAP,
  OATH_AFFINITY_CAP,
  getOathBondModifiers,
} from './stat-rules.js';

const STORAGE_NS = 'core-interaction';
const STATE_KEY = 'interaction-state-v1';

export const BUILTIN_GIFTS = Object.freeze([
  {
    id: 'gift_port_tea',
    name: '港区特调红茶',
    currency: 'silver',
    price: 35,
    affinityGain: 5,
    moraleGain: 8,
    description: '香气柔和的港区下午茶礼盒，适合日常慰问秘书舰。',
  },
  {
    id: 'gift_sweet_box',
    name: '手工和果子礼盒',
    currency: 'silver',
    price: 80,
    affinityGain: 10,
    moraleGain: 14,
    description: '精致点心礼盒，大幅提升舰娘好感度与士气。',
  },
  {
    id: 'gift_crystal_brooch',
    name: '海星胸针纪念礼',
    currency: 'gold',
    price: 2,
    affinityGain: 22,
    moraleGain: 20,
    description: '珍贵纪念饰品，可显著拉近与心仪舰娘的羁绊距离。',
  },
]);

const OFFLINE_TALK_TEMPLATES = {
  stranger: [
    '「{speechHabit}」穿着{outfit}的{actor.name}向{commander.name}微微行礼，语气礼貌而认真，似乎正在熟悉港区节奏。',
    '{actor.name}整理着身上的{outfit}，向{commander.name}汇报了今日港区执勤状况：「目前一切正常，请随时下达指令。」',
  ],
  familiar: [
    '身着{outfit}的{actor.name}微笑着递来热茶：「{commander.name}，辛苦了。{speechHabit}」（指挥官魅力引导：{toneLabel}）',
    '{actor.name}在窗边眺望港湾，转身看向{commander.name}：「和指挥官一起在港区执勤，感觉越来越顺手了呢。」',
  ],
  trusted: [
    '穿着{outfit}的{actor.name}主动靠近一步，目光信赖而温柔：「{commander.name}，无论下一次出征去往哪片海域，我都随时准备陪在你身边。」',
    '「{speechHabit}」{actor.name}笑着与{commander.name}核对航线图，言语间流露出默契与深厚信赖。',
  ],
  close: [
    '穿着{outfit}的{actor.name}轻声向{commander.name}倾诉心声：「只要看到指挥官在港区里，心里就会特别安稳。今天也一起加油吧！」',
    '{actor.name}将珍藏的航行笔记展示给{commander.name}，眼底满是亲密与期待：「{speechHabit}」',
  ],
  oath: [
    '佩戴着誓约徽记、身着{outfit}的{actor.name}与{commander.name}相视一笑：「从立下【{oathTitle}】的那一刻起，无论风浪多大，我都会永远守护在指挥官身旁。」',
    '「{speechHabit}」{actor.name}轻轻握住{commander.name}的手，誓约之光在港湾微风中熠熠生辉。',
  ],
};

const DAILY_PORT_EVENTS = [
  {
    minCharismaTier: 1,
    title: '港湾巡视茶歇',
    template: '{commander.name}与穿着{outfit}的{actor.name}一同巡视港区码头，顺手清理了漂流物资，气氛轻松愉快。',
    affinity: 4,
    morale: 8,
    reward: { silver: 30 },
  },
  {
    minCharismaTier: 2,
    title: '战术沙盘复盘与茶会',
    template: '在指挥官「{toneLabel}」的带动下，{actor.name}兴致勃勃地分享了海战演练心得，港区士气高涨！',
    affinity: 6,
    morale: 12,
    reward: { fuel: 35, silver: 45 },
  },
  {
    minCharismaTier: 3,
    title: '黄昏栈桥的私密心声',
    template: '夕阳映照港湾，身着{outfit}的{actor.name}向{commander.name}敞开心扉，约定携手驶向更远的星海。',
    affinity: 9,
    morale: 16,
    reward: { silver: 60, bauxite: 25 },
  },
];

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class InteractionSystem {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   entities: import('./entity-system.js').EntitySystem,
   *   inventory: import('./inventory-system.js').InventorySystem,
   *   resources: import('./resource-manager.js').ResourceManager,
   *   statRules: import('./stat-rules.js').StatRulesEngine,
   *   commander: import('./commander-system.js').CommanderSystem,
   *   narrative: import('./prompt-pipeline.js').PromptPipeline,
   *   logs?: import('./log-system.js').LogSystem | null,
   *   contentManager?: import('./content-manager.js').ContentManager | null,
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
    dialogueEngine = null,
    logs = null,
    contentManager = null,
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
    this._dialogueEngine = dialogueEngine;
    this._storyEngine = null;
    this._logs = logs;
    this._contentManager = contentManager;
    this._bus = bus;

    this._secretaryId = null;
    /** @type {Record<string, { oathedAt: number, oathTitle: string, customVow: string }>} */
    this._oaths = {};
    this._lastInteraction = null;
    this._interactionHistory = [];
    this._hydrated = false;
  }

  setContentManager(cm) {
    this._contentManager = cm;
  }

  setDialogueEngine(de) {
    this._dialogueEngine = de;
  }

  setStoryEngine(se) {
    this._storyEngine = se;
  }

  _applyAffectionDelta(cid, delta, source) {
    if (this._storyEngine && typeof this._storyEngine.gainAffection === 'function') {
      const res = this._storyEngine.gainAffection(cid, delta, { source });
      return { afterAff: res.after, actualDelta: res.gained };
    }
    const maxAff = this.getMaxAffinityFor(cid);
    const before = Math.round(Number(this._entities?.get(cid)?.stats?.affinity ?? 0));
    const afterAff = this._entities.adjustStat(cid, 'affinity', delta, { min: 0, max: maxAff });
    return { afterAff, actualDelta: afterAff - before };
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  async init() {
    if (this._hydrated) return;
    const saved = await this._scope.getLarge(STATE_KEY, null);
    if (saved && typeof saved === 'object') {
      this.deserialize(saved, { persist: false });
    }
    this._ensureValidSecretary();
    this.syncOathModifiers();
    this._hydrated = true;
  }

  async persist() {
    await this._scope.setLarge(STATE_KEY, this.serialize());
  }

  _ensureValidSecretary() {
    if (this._secretaryId && this._entities?.has(this._secretaryId)) {
      return this._secretaryId;
    }
    const chars = this._entities?.list({ kind: 'character' }) || [];
    this._secretaryId = chars[0]?.id || null;
    return this._secretaryId;
  }

  getSecretaryId() {
    return this._ensureValidSecretary();
  }

  getSecretary() {
    const id = this._ensureValidSecretary();
    return id ? this._entities.get(id) : null;
  }

  async setSecretary(characterId) {
    if (characterId === null || characterId === undefined || characterId === '') {
      this._secretaryId = null;
      await this.persist();
      this._emit('interaction:secretary-changed', { characterId: null, name: '' });
      return null;
    }
    const cid = String(characterId);
    const actor = this._entities?.get(cid);
    if (!actor || actor.kind !== 'character') throw new Error('指定角色不存在');
    this._secretaryId = cid;
    await this.persist();
    this._emit('interaction:secretary-changed', { characterId: cid, name: actor.name });
    return actor;
  }

  async removeCharacterData(characterId) {
    const cid = String(characterId || '');
    if (!cid) return;
    if (this._secretaryId === cid) {
      this._secretaryId = null;
    }
    delete this._oaths[cid];
    await this.persist();
  }

  getLastInteraction() {
    return this._lastInteraction ? deepClone(this._lastInteraction) : null;
  }

  listHistory() {
    return deepClone(this._interactionHistory);
  }

  isOathed(characterId) {
    const cid = String(characterId || '');
    if (!cid) return false;
    if (this._oaths[cid]) return true;
    const ent = this._entities?.get?.(cid);
    return Boolean(ent?.meta?.isOathed || ent?.isOathed);
  }

  getOathRecord(characterId) {
    const cid = String(characterId || '');
    if (!cid) return null;
    const rec = this._oaths[cid];
    if (rec) return deepClone(rec);
    const ent = this._entities?.get?.(cid);
    if (ent?.meta?.isOathed || ent?.isOathed) {
      return {
        oathedAt: ent.meta?.oathDate || ent.oathDate || Date.now(),
        oathTitle: ent.meta?.oathTitle || '永恒誓约',
        customVow: '',
      };
    }
    return null;
  }

  getAllOaths() {
    return deepClone(this._oaths);
  }

  getMaxAffinityFor(characterId) {
    return this.isOathed(characterId) ? OATH_AFFINITY_CAP : BASE_AFFINITY_CAP;
  }

  canOath(characterId) {
    const cid = String(characterId || '');
    const actor = this._entities?.get(cid);
    if (!actor) return { ok: false, reason: '角色不存在', affinity: 0 };
    if (this.isOathed(cid)) {
      return {
        ok: false,
        reason: '已完成誓约仪式',
        affinity: Math.round(Number(actor.stats.affinity ?? 0)),
        oathed: true,
      };
    }
    const aff = Math.round(Number(actor.stats.affinity ?? 0));
    return {
      ok: aff >= BASE_AFFINITY_CAP,
      reason:
        aff >= BASE_AFFINITY_CAP
          ? '好感度已达 100，可举行誓约仪式'
          : `好感度需达到 100 解锁誓约（当前 ${aff}/100）`,
      affinity: aff,
      oathed: false,
    };
  }

  listGifts() {
    const custom = this._contentManager ? this._contentManager.listCustomGifts() : [];
    return [...deepClone(BUILTIN_GIFTS), ...custom];
  }

  /**
   * Apply permanent 「誓约羁绊」 stat modifiers (+4 to all 6 core stats), 150 affinity ceiling,
   * and safe default `isOathed` / `oathDate` metadata on all character entities.
   */
  syncOathModifiers() {
    if (!this._entities) return;
    const allChars = this._entities.list({ kind: 'character' }) || [];
    for (const entity of allChars) {
      if (!entity || !entity.id) continue;
      const cid = entity.id;
      if (!entity.meta || typeof entity.meta !== 'object') entity.meta = {};
      if (!entity.statBounds || typeof entity.statBounds !== 'object') entity.statBounds = {};

      // Sync legacy entity-side oath flags into `_oaths` if present
      if (!this._oaths[cid] && (entity.meta.isOathed || entity.isOathed)) {
        this._oaths[cid] = {
          oathedAt: Number(entity.meta.oathDate || entity.oathDate) || Date.now(),
          oathTitle: String(entity.meta.oathTitle || '永恒誓约'),
          customVow: '',
        };
      }

      const oath = this._oaths[cid] || null;
      // Clear any previous/legacy oath modifiers cleanly before re-applying
      for (let i = 0; i < 10; i++) {
        this._entities.removeModifier?.(cid, `oath_bond_${cid}_${i}`);
      }

      if (oath) {
        const oathTs = Number(oath.oathedAt) || Date.now();
        entity.meta.isOathed = true;
        entity.meta.oathDate = oathTs;
        entity.meta.oathTitle = oath.oathTitle || '永恒誓约';
        entity.isOathed = true;
        entity.oathDate = oathTs;
        entity.statBounds.affinity = { min: 0, max: OATH_AFFINITY_CAP };

        const mods = getOathBondModifiers(cid, oath.oathTitle || '永恒誓约');
        for (const mod of mods) {
          this._entities.addModifier(cid, mod);
        }
      } else {
        entity.meta.isOathed = false;
        entity.meta.oathDate = null;
        entity.isOathed = false;
        entity.oathDate = null;
        entity.statBounds.affinity = { min: 0, max: BASE_AFFINITY_CAP };
      }
    }
  }

  _buildDialogueVariables(actor) {
    const cmdProfile = this._commander ? this._commander.getProfile() : { name: '指挥官', title: '提督' };
    const equipped = this._inventory ? this._inventory.getCharacterEquipment(actor.id) : {};
    const outfitName = equipped.outfit?.name || '日常港区便装';
    const affRed = this._commander ? this._commander.getAffinityThresholdReduction() : 0;
    const stage = this._statRules.getAffinityStage(Math.min(100, Number(actor.stats.affinity ?? 0)), {
      thresholdReduction: affRed,
    });
    const interactProfile = this._commander ? this._commander.getInteractionProfile() : { toneLabel: '稳重标准' };
    const oath = this.getOathRecord(actor.id);

    return {
      actor: {
        name: actor.name,
        shipType: actor.meta?.shipType || '驱逐舰',
        personality: actor.meta?.personality || '温和认真',
        affinity: Math.round(Number(actor.stats.affinity ?? 0)),
      },
      commander: {
        name: cmdProfile.name,
        title: cmdProfile.title,
      },
      outfit: outfitName,
      outfitStyle: equipped?.outfit?.outfitStyle || '',
      speechHabit: actor.meta?.speechHabit || '「随时听候指挥官差遣。」',
      stageLabel: oath ? '誓约伴侣' : stage.label,
      stageKey: oath ? 'oath' : stage.id,
      toneLabel: interactProfile.toneLabel,
      oathTitle: oath?.oathTitle || '誓约守护',
    };
  }

  async talkToSecretary({ characterId = null, customTopic = '' } = {}) {
    const actor = characterId ? this._entities.get(String(characterId)) : this.getSecretary();
    if (!actor) throw new Error('暂无可互动的秘书舰');

    const vars = this._buildDialogueVariables(actor);
    const customPool = this._contentManager
      ? this._contentManager
          .listCustomDialogues()
          .filter((d) => d && d.text && (d.stage === 'any' || d.stage === vars.stageKey))
          .map((d) => d.text)
      : [];

    let baseTemplate = '';
    let contextMeta = null;
    if (customPool.length > 0 && !customTopic && Math.random() < 0.3) {
      baseTemplate = pickRandom(customPool);
    } else if (this._dialogueEngine) {
      const composed = this._dialogueEngine.composeSecretaryTalk({
        actor,
        commanderName: vars.commander.name,
        outfitName: vars.outfit,
        outfitStyle: vars.outfitStyle || '',
        affStageId: vars.stageKey,
        isOathed: this.isOathed(actor.id),
        oathTitle: vars.oathTitle,
        customTopic,
      });
      baseTemplate = composed?.text || `「${vars.commander.name}，今天也一起加油吧。」`;
      contextMeta = this._dialogueEngine.buildAiContextMeta({
        actor,
        commander: this._commander,
        outfitName: vars.outfit,
        affStageLabel: vars.stageLabel,
        sceneType: 'secretary-talk',
      });
    } else {
      const builtInPool = OFFLINE_TALK_TEMPLATES[vars.stageKey] || OFFLINE_TALK_TEMPLATES.familiar;
      baseTemplate = customTopic
        ? `面对指挥官提及的「${customTopic}」，身着{outfit}的{actor.name}认真回应道：「{speechHabit}」（当前好感阶段：{stageLabel} · {toneLabel}）`
        : pickRandom(builtInPool);
    }

    const rendered = await this._narrative.run({
      template: baseTemplate,
      variables: vars,
      contextMeta,
      polishInstruction: `请以舰娘「${actor.name}」（舰种：${vars.actor.shipType}，性格：${vars.actor.personality}，穿着：${vars.outfit}，好感阶段：${vars.stageLabel}）的口吻，回应指挥官「${vars.commander.name}」的日常交谈${customTopic ? `（话题：${customTopic}）` : ''}，保持简短生动：`,
    });

    const affMult = this._commander ? this._commander.getAffinityGainMultiplier() : 1.0;
    const rawAffDelta = Math.max(1, Math.round(3 * affMult));
    const moraleDelta = 5;
    const maxAff = this.getMaxAffinityFor(actor.id);

    const { afterAff, actualDelta: affDelta } = this._applyAffectionDelta(actor.id, rawAffDelta, 'interaction-talk');
    const afterMorale = this._entities.adjustStat(actor.id, 'morale', moraleDelta, { min: 0, max: 100 });

    const entry = {
      id: `int_${Date.now().toString(36)}`,
      type: 'talk',
      characterId: actor.id,
      characterName: actor.name,
      outfit: vars.outfit,
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      affDelta,
      moraleDelta,
      afterAff,
      afterMorale,
      timestamp: Date.now(),
    };
    this._lastInteraction = entry;
    this._interactionHistory.unshift(entry);
    if (this._interactionHistory.length > 30) this._interactionHistory.length = 30;
    await this.persist();

    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.CHARACTER,
        actorId: actor.id,
        actorName: actor.name,
        title: `[${actor.name}] 秘书舰日常交谈`,
        detail: `好感 +${affDelta}（当前 ${afterAff}/${maxAff}）· 士气 +${moraleDelta} | ${rendered.text.slice(0, 60)}`,
      });
    }
    this._emit('interaction:talked', entry);
    return entry;
  }

  async giveGift(characterId, giftId) {
    const cid = String(characterId || this.getSecretaryId() || '');
    const actor = this._entities?.get(cid);
    if (!actor) throw new Error('目标角色不存在');

    const gift = this.listGifts().find((g) => g.id === giftId);
    if (!gift) throw new Error(`未找到礼物：${giftId}`);

    if (gift.price > 0) {
      const spend = await this._resources.spendBatch(
        { [gift.currency || 'silver']: gift.price },
        { reason: `赠送「${gift.name}」给 ${actor.name}` }
      );
      if (!spend.ok) throw new Error(spend.reason);
    }

    const affMult = this._commander ? this._commander.getAffinityGainMultiplier() : 1.0;
    const rawAffDelta = Math.max(1, Math.round((Number(gift.affinityGain) || 5) * affMult));
    const moraleDelta = Math.max(0, Math.round(Number(gift.moraleGain) || 6));
    const maxAff = this.getMaxAffinityFor(actor.id);

    const { afterAff, actualDelta: affDelta } = this._applyAffectionDelta(actor.id, rawAffDelta, 'interaction-gift');
    const afterMorale = this._entities.adjustStat(actor.id, 'morale', moraleDelta, { min: 0, max: 100 });

    const vars = this._buildDialogueVariables(actor);
    let giftTemplate =
      '收到{commander.name}赠送的「{giftName}」后，穿着{outfit}的{actor.name}露出了灿烂的笑容：「非常喜欢这份心意！{speechHabit}」（好感 +{affDelta}，士气 +{moraleDelta}）';
    let contextMeta = null;
    if (this._dialogueEngine) {
      const composed = this._dialogueEngine.composeGiftFeedback({
        actor,
        commanderName: vars.commander.name,
        giftName: gift.name,
        outfitName: vars.outfit,
        affStageId: vars.stageKey,
        isOathed: this.isOathed(actor.id),
      });
      giftTemplate = `${composed.text}（好感 +{affDelta}，士气 +{moraleDelta}）`;
      contextMeta = this._dialogueEngine.buildAiContextMeta({
        actor,
        commander: this._commander,
        outfitName: vars.outfit,
        affStageLabel: vars.stageLabel,
        sceneType: 'secretary-gift',
      });
    }

    const rendered = await this._narrative.run({
      template: giftTemplate,
      variables: {
        ...vars,
        giftName: gift.name,
        affDelta,
        moraleDelta,
      },
      contextMeta,
      polishInstruction: `请以「${actor.name}」的口吻简短表达收到礼物「${gift.name}」的喜悦：`,
    });

    const entry = {
      id: `gift_${Date.now().toString(36)}`,
      type: 'gift',
      characterId: actor.id,
      characterName: actor.name,
      giftName: gift.name,
      outfit: vars.outfit,
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      affDelta,
      moraleDelta,
      afterAff,
      afterMorale,
      timestamp: Date.now(),
    };
    this._lastInteraction = entry;
    this._interactionHistory.unshift(entry);
    if (this._interactionHistory.length > 30) this._interactionHistory.length = 30;
    await this.persist();

    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.CHARACTER,
        actorId: actor.id,
        actorName: actor.name,
        title: `[${actor.name}] 获赠礼物「${gift.name}」`,
        detail: `好感 +${affDelta}（${afterAff}/${maxAff}）· 士气 +${moraleDelta}`,
      });
    }
    this._emit('interaction:gifted', entry);
    return entry;
  }

  async triggerDailyPortEvent(characterId = null) {
    const actor = characterId ? this._entities.get(String(characterId)) : this.getSecretary();
    if (!actor) throw new Error('暂无可触发日常事件的秘书舰');

    const profile = this._commander ? this._commander.getInteractionProfile() : { tier: 1 };
    const eligible = DAILY_PORT_EVENTS.filter((e) => e.minCharismaTier <= (profile.tier || 1));
    const picked = pickRandom(eligible.length > 0 ? eligible : DAILY_PORT_EVENTS);

    const affMult = this._commander ? this._commander.getAffinityGainMultiplier() : 1.0;
    const rawAffDelta = Math.max(1, Math.round(picked.affinity * affMult));
    const { afterAff, actualDelta: affDelta } = this._applyAffectionDelta(actor.id, rawAffDelta, 'daily-port-event');
    const afterMorale = this._entities.adjustStat(actor.id, 'morale', picked.morale, { min: 0, max: 100 });

    const rewardSummary = [];
    for (const [resId, amt] of Object.entries(picked.reward || {})) {
      await this._resources.add(resId, amt, { reason: `港区日常事件：${picked.title}` });
      rewardSummary.push(`${this._resources.get(resId)?.name || resId} +${amt}`);
    }

    const vars = this._buildDialogueVariables(actor);
    const rendered = await this._narrative.run({
      template: `【${picked.title}】${picked.template}`,
      variables: vars,
      polishInstruction: `请润色这段港区日常事件「${picked.title}」的温馨互动描写：`,
    });

    const entry = {
      id: `evt_${Date.now().toString(36)}`,
      type: 'daily-event',
      title: picked.title,
      characterId: actor.id,
      characterName: actor.name,
      outfit: vars.outfit,
      text: rendered.text,
      source: rendered.source,
      degraded: rendered.degraded,
      affDelta,
      moraleDelta: picked.morale,
      afterAff,
      afterMorale,
      rewardSummary,
      timestamp: Date.now(),
    };
    this._lastInteraction = entry;
    this._interactionHistory.unshift(entry);
    if (this._interactionHistory.length > 30) this._interactionHistory.length = 30;
    await this.persist();

    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.CHARACTER,
        actorId: actor.id,
        actorName: actor.name,
        title: `[${actor.name}] 港区日常事件：${picked.title}`,
        detail: `好感 +${affDelta} · 士气 +${picked.morale}${rewardSummary.length ? ` · 收获：${rewardSummary.join('、')}` : ''}`,
      });
    }
    this._emit('interaction:daily-event', entry);
    return entry;
  }

  async performOath(characterId, { oathTitle = '永恒誓约', customVow = '' } = {}) {
    const cid = String(characterId || '');
    const check = this.canOath(cid);
    if (!check.ok) throw new Error(check.reason);

    const actor = this._entities.get(cid);
    const cleanTitle = String(oathTitle || '永恒誓约').trim() || '永恒誓约';
    const cleanVow = String(customVow || '').trim();
    const oathedAt = Date.now();

    this._oaths[cid] = {
      oathedAt,
      oathTitle: cleanTitle,
      customVow: cleanVow,
    };
    this.syncOathModifiers();

    // Restore morale to 100 on ceremony completion
    this._entities.setStat(cid, 'morale', 100, { min: 0, max: 100 });

    const vars = this._buildDialogueVariables(actor);
    const fallbackText = `在港湾晴空与海风的见证下，${vars.commander.name}与穿着${vars.outfit}的${actor.name}正式缔结【${cleanTitle}】！好感上限突破至 ${OATH_AFFINITY_CAP}，永久激活基础六维各 +4、出征油弹消耗 -10% 与宿舍心情加速恢复！`;
    let rendered = { text: fallbackText, source: 'local', degraded: false };
    if (this._narrative && typeof this._narrative.run === 'function') {
      try {
        rendered = await this._narrative.run({
          template:
            '在港湾晴空与海风的见证下，{commander.name}与穿着{outfit}的{actor.name}正式缔结【{oathTitle}】！{customVowLine}好感上限突破至 150，永久激活基础六维各 +4、出征油弹 -10% 与宿舍心情加速恢复！',
          variables: {
            ...vars,
            oathTitle: cleanTitle,
            customVowLine: cleanVow ? `誓言：「${cleanVow}」 ` : '',
          },
          polishInstruction: `请庄重温馨地描写指挥官与「${actor.name}」完成誓约仪式的瞬间：`,
        });
      } catch {
        rendered = { text: fallbackText, source: 'local', degraded: true };
      }
    }

    const entry = {
      id: `oath_${Date.now().toString(36)}`,
      type: 'oath',
      characterId: cid,
      characterName: actor.name,
      oathTitle: cleanTitle,
      oathedAt,
      text: rendered?.text || fallbackText,
      source: rendered?.source || 'local',
      degraded: Boolean(rendered?.degraded),
      timestamp: oathedAt,
    };
    this._lastInteraction = entry;
    this._interactionHistory.unshift(entry);
    await this.persist();

    this._emit('fx:play', { type: 'crit-flash', payload: {} });
    this._emit('fx:play', { type: 'float-text', payload: { text: `💍 誓约达成 · ${actor.name}`, tone: 'ok' } });
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.CHARACTER,
        actorId: cid,
        actorName: actor.name,
        title: `💍 与「${actor.name}」缔结誓约【${cleanTitle}】`,
        detail: `好感上限提升至 ${OATH_AFFINITY_CAP}，永久激活基础六维各 +4、出征油弹 -10% 与宿舍心情加速恢复`,
      });
    }
    this._emit('interaction:oathed', { characterId: cid, oath: deepClone(this._oaths[cid]), entry });
    return entry;
  }

  /** Backward-compatible alias so any caller invoking `performOathCeremony` never crashes. */
  async performOathCeremony(characterId, opts = {}) {
    return this.performOath(characterId, opts);
  }

  serialize() {
    return {
      version: 1,
      secretaryId: this._secretaryId,
      oaths: deepClone(this._oaths),
      lastInteraction: deepClone(this._lastInteraction),
      interactionHistory: deepClone(this._interactionHistory.slice(0, 30)),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._secretaryId = snapshot.secretaryId ? String(snapshot.secretaryId) : null;
    this._oaths = deepClone(snapshot.oaths || {});
    this._lastInteraction = snapshot.lastInteraction ? deepClone(snapshot.lastInteraction) : null;
    this._interactionHistory = Array.isArray(snapshot.interactionHistory)
      ? deepClone(snapshot.interactionHistory.slice(0, 30))
      : [];
    this.syncOathModifiers();
    if (persist) this.persist();
  }
}
