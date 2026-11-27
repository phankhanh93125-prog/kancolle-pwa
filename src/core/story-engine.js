/**
 * Bubble Chat, Slow 6-Stage Affection, Stage Breakthrough Mini-Theatre & Maritime Encounter Engine (`src/core/story-engine.js`).
 *
 * Features:
 *   - Per-shipgirl persistent WeChat/QQ-style bubble chat history (`chatLogsByShip`) stored in IndexedDB.
 *   - Slow-paced 6-stage affection progression:
 *       陌生 (0~19) -> 熟悉 (20~39) -> 信赖 (40~59) -> 心动 (60~79) -> 恋慕 (80~99) -> 誓约 (100+)
 *     Daily chat grants +1 affinity (max 5 times/day per shipgirl).
 *     Sortie victories, Dockyard care & Gifts (+2 ~ +5) are the main affection drivers.
 *   - Stage breakthrough mini-theatres at every 20-point gate (20 / 40 / 60 / 80 / 100),
 *     played directly inside the bubble chat window with quick-reply choices.
 *   - Lossless legacy high-affinity save migration: automatically marks crossed gates as unlocked & replayable!
 *   - Natural multi-dimensional dialogue (stage x day/night x equipped outfit x portrait touch zone) +
 *     100% compatible with external imported JSON custom dialogues & story packs.
 */

import {
  AFFINITY_STAGES_6,
  BREAKTHROUGH_GATES,
  BREAKTHROUGH_THEATRES,
  DEFAULT_DIALOGUE_BANK,
  MARITIME_ENCOUNTER_STORIES,
  OATH_RITUAL_THEATRE,
  OUTFIT_FLAVOR_LINES,
  PORTRAIT_TOUCH_LINES,
  getTimeOfDayBucket,
  resolveAffinityStage6,
} from '../data/default-dialogues.js';
import { BASE_AFFINITY_CAP, OATH_AFFINITY_CAP } from './stat-rules.js';
import { LOG_CATEGORIES } from './log-system.js';

const STORAGE_NS = 'core-story-engine';
const STATE_KEY = 'story-engine-v1';
const MAX_MESSAGES_PER_SHIP = 80;
export const DAILY_TALK_AFFINITY_CAP = 5;

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function pickRandom(list = []) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function getLocalDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDialogueText(template, vars = {}) {
  return String(template || '')
    .replaceAll('{actor.name}', vars.actorName || '舰娘')
    .replaceAll('{actor}', vars.actorName || '舰娘')
    .replaceAll('{commander.name}', vars.cmdName || '指挥官')
    .replaceAll('{cmd}', vars.cmdName || '指挥官')
    .replaceAll('{outfit}', vars.outfitName || '日常便装')
    .replaceAll('{gift}', vars.giftName || '心意礼物');
}

function createEmptyStoryEngineState() {
  return {
    version: 1,
    /** @type {Record<string, Array<object>>} */
    chatLogsByShip: {},
    /** @type {Record<string, { dateKey: string, count: number }>} */
    dailyTalkByShip: {},
    /** @type {Record<string, number[]>} */
    unlockedBreakthroughs: {},
    /** @type {Record<string, object | null>} */
    activePromptByShip: {},
  };
}

export class StoryEngine {
  constructor({
    storage = null,
    entities = null,
    inventory = null,
    commander = null,
    interaction = null,
    contentManager = null,
    dialogueEngine = null,
    narrative = null,
    logs = null,
    bus = null,
  } = {}) {
    this._storage = storage;
    this._scope = storage ? storage.namespace(STORAGE_NS) : null;
    this._entities = entities;
    this._inventory = inventory;
    this._commander = commander;
    this._interaction = interaction;
    this._contentManager = contentManager;
    this._dialogueEngine = dialogueEngine;
    this._narrative = narrative;
    this._logs = logs;
    this._bus = bus;

    this._state = createEmptyStoryEngineState();
    this._hydrated = false;
  }

  _emit(event, payload) {
    if (this._bus) this._bus.emit(event, payload);
  }

  async init() {
    if (this._hydrated) return;
    if (this._scope) {
      const saved = await this._scope.getLarge(STATE_KEY, null);
      if (saved && typeof saved === 'object') {
        this.deserialize(saved, { persist: false });
      }
    }
    this.syncLegacyBreakthroughs();
    this._hydrated = true;
  }

  async persist() {
    if (!this._scope) return;
    await this._scope.setLarge(STATE_KEY, this.serialize());
  }

  serialize() {
    return deepClone(this._state);
  }

  deserialize(snapshot, { persist = true } = {}) {
    const clean = createEmptyStoryEngineState();
    if (snapshot && typeof snapshot === 'object') {
      if (snapshot.chatLogsByShip && typeof snapshot.chatLogsByShip === 'object') {
        for (const [cid, arr] of Object.entries(snapshot.chatLogsByShip)) {
          if (Array.isArray(arr)) {
            clean.chatLogsByShip[cid] = deepClone(arr.slice(-MAX_MESSAGES_PER_SHIP));
          }
        }
      }
      if (snapshot.dailyTalkByShip && typeof snapshot.dailyTalkByShip === 'object') {
        clean.dailyTalkByShip = deepClone(snapshot.dailyTalkByShip);
      }
      if (snapshot.unlockedBreakthroughs && typeof snapshot.unlockedBreakthroughs === 'object') {
        for (const [cid, gates] of Object.entries(snapshot.unlockedBreakthroughs)) {
          if (Array.isArray(gates)) {
            clean.unlockedBreakthroughs[cid] = Array.from(
              new Set(gates.map((g) => Number(g)).filter((g) => BREAKTHROUGH_GATES.includes(g)))
            ).sort((a, b) => a - b);
          }
        }
      }
      if (snapshot.activePromptByShip && typeof snapshot.activePromptByShip === 'object') {
        clean.activePromptByShip = deepClone(snapshot.activePromptByShip);
      }
    }
    this._state = clean;
    this.syncLegacyBreakthroughs();
    if (persist) {
      this.persist().catch(() => {});
    }
    this._emit('story-engine:updated', { reason: 'deserialize' });
  }

  resetAll({ persist = false } = {}) {
    this._state = createEmptyStoryEngineState();
    if (persist) {
      this.persist().catch(() => {});
    }
    this._emit('story-engine:updated', { reason: 'reset' });
  }

  /**
   * Losslessly migrate legacy saves: sync already-crossed historical bands (`aff > gate`)
   * as unlocked while preserving hard interception on the NEXT 20-point gate!
   * Also ensures safe default `isOathed` / `oathDate` metadata on every character entity.
   */
  syncLegacyBreakthroughs() {
    if (!this._entities) return;
    const chars = this._entities.list({ kind: 'character' }) || [];
    for (const ch of chars) {
      if (!ch || !ch.id) continue;
      if (!ch.meta || typeof ch.meta !== 'object') ch.meta = {};
      const oathRec = this._interaction?.getOathRecord?.(ch.id) || null;
      const isOathed = Boolean(oathRec || ch.meta.isOathed || ch.isOathed);
      const oathDate = oathRec?.oathedAt || ch.meta.oathDate || ch.oathDate || null;
      ch.meta.isOathed = isOathed;
      ch.meta.oathDate = oathDate;
      ch.isOathed = isOathed;
      ch.oathDate = oathDate;

      const maxAff = isOathed ? OATH_AFFINITY_CAP : BASE_AFFINITY_CAP;
      if (!ch.statBounds || typeof ch.statBounds !== 'object') ch.statBounds = {};
      ch.statBounds.affinity = { min: 0, max: maxAff };

      const aff = Math.max(0, Math.round(Number(ch?.stats?.affinity ?? 0)));
      const existing = new Set(this._state.unlockedBreakthroughs[ch.id] || []);
      for (const gate of BREAKTHROUGH_GATES) {
        // Strictly crossed in an older save (`aff > gate`), or already oathed
        if (aff > gate || (isOathed && gate <= BASE_AFFINITY_CAP)) {
          existing.add(gate);
        }
      }
      if (existing.size > 0) {
        this._state.unlockedBreakthroughs[ch.id] = Array.from(existing).sort((a, b) => a - b);
      }
    }
  }

  // ------------------------------------------------------------
  // Affection Stage & Hard Gate Helpers (20 / 40 / 60 / 80 / 100 / 150)
  // ------------------------------------------------------------

  getAffectionStatus(characterId) {
    const cid = String(characterId || '');
    const actor = this._entities?.get(cid);
    const aff = Math.max(0, Math.round(Number(actor?.stats?.affinity ?? 0)));
    const oathRec = this._interaction?.getOathRecord?.(cid) || null;
    const isOathed = Boolean(oathRec || actor?.meta?.isOathed || actor?.isOathed);
    const oathDate = oathRec?.oathedAt || actor?.meta?.oathDate || actor?.oathDate || null;
    const maxAff = isOathed ? OATH_AFFINITY_CAP : BASE_AFFINITY_CAP;
    const unlocked = new Set(this._state.unlockedBreakthroughs[cid] || []);
    const unlockedList = Array.from(unlocked).sort((a, b) => a - b);

    const stage = resolveAffinityStage6(aff, { isOathed, unlockedGates: unlocked });

    // Hard stage ceiling: strictly 20 -> 40 -> 60 -> 80 -> 100 (locked at 100 until Oath -> 150)
    let currentCap = maxAff;
    if (!isOathed) {
      let nextLockedGate = null;
      for (const gate of BREAKTHROUGH_GATES) {
        if (!unlocked.has(gate)) {
          nextLockedGate = gate;
          break;
        }
      }
      currentCap = nextLockedGate !== null ? Math.min(BASE_AFFINITY_CAP, nextLockedGate) : BASE_AFFINITY_CAP;
    }

    // Pending breakthrough gate triggers strictly once affinity reaches the current locked ceiling (20/40/60/80/100)
    let pendingGate = null;
    if (!isOathed) {
      for (const gate of BREAKTHROUGH_GATES) {
        if (!unlocked.has(gate) && aff >= gate) {
          pendingGate = gate;
          break;
        }
      }
    }

    const canStartOath = !isOathed && aff >= BASE_AFFINITY_CAP && unlocked.has(BASE_AFFINITY_CAP);
    const atStageCap = !isOathed && (Boolean(pendingGate) || aff >= currentCap);
    const unlockedStage = isOathed ? 5 : unlockedList.length;

    const todayKey = getLocalDateKey();
    const dailyRec = this._state.dailyTalkByShip[cid];
    const dailyTalkUsed = dailyRec && dailyRec.dateKey === todayKey ? Number(dailyRec.count) || 0 : 0;

    return {
      characterId: cid,
      affinity: aff,
      maxAffinity: maxAff,
      isOathed,
      oathDate,
      stage,
      unlockedStage,
      stages: AFFINITY_STAGES_6,
      unlockedGates: unlockedList,
      pendingGate,
      pendingTheatre: pendingGate ? BREAKTHROUGH_THEATRES[pendingGate] || null : null,
      currentCap,
      atStageCap,
      canStartOath,
      dailyTalkUsed,
      dailyTalkCap: DAILY_TALK_AFFINITY_CAP,
      dailyTalkRemaining: Math.max(0, DAILY_TALK_AFFINITY_CAP - dailyTalkUsed),
    };
  }

  /**
   * SINGLE authoritative affection mutation funnel for ALL modules (chat, gifts, sorties,
   * dockyard repairs, dormitory, expeditions, story events).
   * Strictly clamps positive gains at `currentCap` (20 / 40 / 60 / 80 / 100, or 150 after Oath)
   * so affection can NEVER overflow a locked stage ceiling without completing its breakthrough theatre!
   */
  gainAffection(shipId, rawDelta, { source = 'interaction', allowBypassGate = false } = {}) {
    const cid = String(shipId || '');
    const actor = this._entities?.get(cid);
    if (!actor) {
      return { before: 0, after: 0, gained: 0, hitGate: null, cappedByGate: false, currentCap: 20, source };
    }

    const status = this.getAffectionStatus(cid);
    const before = status.affinity;
    const cap = allowBypassGate ? status.maxAffinity : status.currentCap;
    const delta = Math.round(Number(rawDelta) || 0);

    if (!actor.statBounds || typeof actor.statBounds !== 'object') actor.statBounds = {};
    actor.statBounds.affinity = { min: 0, max: status.maxAffinity };

    let after = before;
    if (delta > 0) {
      const allowedGain = Math.max(0, cap - before);
      const actualDelta = Math.min(delta, allowedGain);
      if (actualDelta > 0) {
        after = this._entities.adjustStat(cid, 'affinity', actualDelta, {
          min: 0,
          max: cap,
        });
      }
    } else if (delta < 0) {
      after = this._entities.adjustStat(cid, 'affinity', delta, {
        min: 0,
        max: status.maxAffinity,
      });
    }

    const postStatus = this.getAffectionStatus(cid);
    const gained = after - before;
    const cappedByGate = delta > 0 && (after < before + delta || before >= cap) && (Boolean(postStatus.pendingGate) || (!postStatus.isOathed && after >= BASE_AFFINITY_CAP));

    if (gained !== 0) {
      this._emit('story-engine:affection-changed', {
        characterId: cid,
        before,
        after,
        gained,
        currentCap: postStatus.currentCap,
        pendingGate: postStatus.pendingGate,
        source,
      });
    }

    return {
      before,
      after,
      gained,
      hitGate: postStatus.pendingGate,
      cappedByGate,
      currentCap: postStatus.currentCap,
      canStartOath: postStatus.canStartOath,
      source,
    };
  }

  /**
   * Backward-compatible alias delegating directly to the single canonical `gainAffection` funnel.
   */
  applySlowAffinityGain(characterId, rawDelta, opts = {}) {
    return this.gainAffection(characterId, rawDelta, opts);
  }

  // ------------------------------------------------------------
  // Per-Shipgirl Bubble Chat Storage
  // ------------------------------------------------------------

  getChatHistory(characterId) {
    const cid = String(characterId || '');
    if (!cid) return [];
    const list = this._state.chatLogsByShip[cid];
    return Array.isArray(list) ? deepClone(list) : [];
  }

  getActivePrompt(characterId) {
    const cid = String(characterId || '');
    return cid && this._state.activePromptByShip[cid] ? deepClone(this._state.activePromptByShip[cid]) : null;
  }

  /**
   * Completely remove a retired/deleted shipgirl's independent chat log, prompts,
   * daily talk counter, and breakthrough markers from memory & IndexedDB.
   */
  async deleteShipChatHistory(characterId) {
    const cid = String(characterId || '');
    if (!cid) return false;
    delete this._state.chatLogsByShip[cid];
    delete this._state.activePromptByShip[cid];
    delete this._state.dailyTalkByShip[cid];
    delete this._state.unlockedBreakthroughs[cid];
    await this.persist();
    this._emit('story-engine:updated', { characterId: cid, deleted: true });
    return true;
  }

  _appendMessage(characterId, msg) {
    const cid = String(characterId || '');
    if (!cid) return;
    if (!Array.isArray(this._state.chatLogsByShip[cid])) {
      this._state.chatLogsByShip[cid] = [];
    }
    const entry = {
      id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      ...msg,
    };
    this._state.chatLogsByShip[cid].push(entry);
    if (this._state.chatLogsByShip[cid].length > MAX_MESSAGES_PER_SHIP) {
      this._state.chatLogsByShip[cid] = this._state.chatLogsByShip[cid].slice(-MAX_MESSAGES_PER_SHIP);
    }
    return entry;
  }

  ensureGreeting(actor) {
    if (!actor || !actor.id) return;
    const hist = this._state.chatLogsByShip[actor.id];
    if (Array.isArray(hist) && hist.length > 0) return;

    const vars = this._buildVars(actor);
    const tod = getTimeOfDayBucket();
    const st = this.getAffectionStatus(actor.id);
    const stageBank = DEFAULT_DIALOGUE_BANK[st.stage.id] || DEFAULT_DIALOGUE_BANK.stranger;
    const sample = pickRandom(stageBank[tod] || stageBank.day) || stageBank.day[0];

    if (sample?.narration) {
      this._appendMessage(actor.id, {
        role: 'narration',
        text: formatDialogueText(sample.narration, vars),
      });
    }
    this._appendMessage(actor.id, {
      role: 'ship',
      speaker: actor.name,
      text: formatDialogueText(sample?.text || `「${vars.cmdName}，港区今日海况平稳，随时可以聊聊天。」`, vars),
    });
  }

  _buildVars(actor, extra = {}) {
    const cmdProfile = this._commander?.getProfile ? this._commander.getProfile() : { name: '指挥官' };
    const equipped = this._inventory?.getCharacterEquipment ? this._inventory.getCharacterEquipment(actor.id) : {};
    const outfitItem = equipped?.outfit || null;
    return {
      actorName: actor?.name || '舰娘',
      cmdName: cmdProfile?.name || '指挥官',
      outfitName: outfitItem?.name || '日常港区便装',
      outfitStyle: outfitItem?.outfitStyle || '',
      ...extra,
    };
  }

  // ------------------------------------------------------------
  // Core Chat Actions (Daily Talk / Free Input / Touch / Gift / Breakthrough)
  // ------------------------------------------------------------

  async dailyTalk(actor, { customTopic = '' } = {}) {
    if (!actor || !actor.id) throw new Error('暂无可互动的舰娘');
    this.ensureGreeting(actor);

    const cid = actor.id;
    const vars = this._buildVars(actor);
    const status = this.getAffectionStatus(cid);
    const tod = getTimeOfDayBucket();
    const topic = String(customTopic || '').trim();

    if (topic) {
      this._appendMessage(cid, {
        role: 'commander',
        speaker: vars.cmdName,
        text: topic,
      });
    }

    // Pick natural dialogue (compatible with custom JSON dialogues, outfit flavors, and 6-stage bank)
    const customDialogues = this._contentManager?.listCustomDialogues
      ? this._contentManager
          .listCustomDialogues()
          .filter((d) => d && d.text && (d.stage === 'any' || d.stage === status.stage.id))
      : [];

    let narrationText = '';
    let spokenText = '';
    let quickChoices = null;

    const outfitFlavor = vars.outfitStyle ? OUTFIT_FLAVOR_LINES[vars.outfitStyle] : null;
    if (!topic && customDialogues.length > 0 && Math.random() < 0.35) {
      const pickedCustom = pickRandom(customDialogues);
      spokenText = formatDialogueText(pickedCustom.text, vars);
      narrationText = `${actor.name}看着你，轻声分享了港区近况。`;
    } else if (!topic && outfitFlavor && Math.random() < 0.32) {
      narrationText = formatDialogueText(outfitFlavor.narration, vars);
      spokenText = formatDialogueText(outfitFlavor.text, vars);
    } else if (topic) {
      // Respond naturally to commander's typed message (with optional AI polish via PromptPipeline)
      const stagePool = DEFAULT_DIALOGUE_BANK[status.stage.id] || DEFAULT_DIALOGUE_BANK.familiar;
      const fallbackEntry = pickRandom(stagePool[tod] || stagePool.day) || stagePool.day[0];
      const baseReply =
        this._dialogueEngine && typeof this._dialogueEngine.composeSecretaryTalk === 'function'
          ? this._dialogueEngine.composeSecretaryTalk({
              actor,
              commanderName: vars.cmdName,
              outfitName: vars.outfitName,
              outfitStyle: vars.outfitStyle,
              affStageId: status.stage.id,
              isOathed: status.isOathed,
              customTopic: topic,
            })?.text || formatDialogueText(fallbackEntry.text, vars)
          : formatDialogueText(fallbackEntry.text, vars);

      let finalReply = baseReply;
      if (this._narrative && typeof this._narrative.run === 'function') {
        try {
          const rendered = await this._narrative.run({
            template: baseReply,
            variables: {
              actor: { name: vars.actorName },
              commander: { name: vars.cmdName },
              outfit: vars.outfitName,
              stageLabel: status.stage.label,
            },
            polishInstruction: `请以舰娘「${vars.actorName}」（好感阶段：${status.stage.label}，穿着：${vars.outfitName}）自然口语化的口吻回复指挥官「${vars.cmdName}」说的话「${topic}」，简短亲切：`,
          });
          if (rendered?.text) finalReply = rendered.text;
        } catch {
          // graceful local fallback
        }
      }
      narrationText = `${actor.name}认真听完你的话，轻轻抬起眼眸。`;
      spokenText = finalReply;
    } else {
      const stagePool = DEFAULT_DIALOGUE_BANK[status.stage.id] || DEFAULT_DIALOGUE_BANK.stranger;
      const list = stagePool[tod] || stagePool.day;
      const entry = pickRandom(list) || list[0];
      narrationText = formatDialogueText(entry.narration || '', vars);
      spokenText = formatDialogueText(entry.text || '', vars);
      if (Array.isArray(entry.choices) && entry.choices.length > 0) {
        quickChoices = {
          kind: 'casual_branch',
          choices: entry.choices.map((ch, idx) => ({
            id: `cb_${Date.now().toString(36)}_${idx}`,
            label: formatDialogueText(ch.label, vars),
            reply: formatDialogueText(ch.reply, vars),
            narration: formatDialogueText(ch.narration || '', vars),
          })),
        };
      }
    }

    if (narrationText) {
      this._appendMessage(cid, { role: 'narration', text: narrationText });
    }
    this._appendMessage(cid, { role: 'ship', speaker: actor.name, text: spokenText });

    // Slow-paced daily talk affection (+1, max 5 times/day)
    const todayKey = getLocalDateKey();
    const rec = this._state.dailyTalkByShip[cid];
    const usedToday = rec && rec.dateKey === todayKey ? Number(rec.count) || 0 : 0;
    let affResult = { before: status.affinity, after: status.affinity, gained: 0, hitGate: status.pendingGate, cappedByGate: false };
    let dailyCapReached = usedToday >= DAILY_TALK_AFFINITY_CAP;

    if (!dailyCapReached) {
      affResult = this.gainAffection(cid, 1, { source: 'daily-talk' });
      if (affResult.gained > 0) {
        this._state.dailyTalkByShip[cid] = { dateKey: todayKey, count: usedToday + 1 };
      }
    }
    this._entities.adjustStat(cid, 'morale', 3, { min: 0, max: 100 });

    if (quickChoices) {
      this._state.activePromptByShip[cid] = quickChoices;
    } else if (this._state.activePromptByShip[cid]?.kind === 'casual_branch') {
      this._state.activePromptByShip[cid] = null;
    }

    // Subtle system pill note inside chat when reaching stage cap or breakthrough gate
    if (affResult.hitGate) {
      this._appendMessage(cid, {
        role: 'system',
        text: `✨ 已达阶段上限 ${affResult.after}/${affResult.hitGate}，点击上方「触发阶段突破小剧场」完成后方可继续提升好感！`,
      });
    } else if (affResult.canStartOath && affResult.cappedByGate) {
      this._appendMessage(cid, {
        role: 'system',
        text: `💍 好感已达当前上限 100/100，点击上方「发起誓约」举行誓约仪式即可解放至 150！`,
      });
    } else if (dailyCapReached) {
      this._appendMessage(cid, {
        role: 'system',
        text: `今日日常闲聊好感已达上限（${DAILY_TALK_AFFINITY_CAP}/${DAILY_TALK_AFFINITY_CAP}），并肩出征、船坞照料或赠送礼物可继续升温。`,
      });
    }

    await this.persist();
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.CHARACTER,
        actorId: cid,
        actorName: actor.name,
        title: `[${actor.name}] 日常互动交谈`,
        detail: `好感 +${affResult.gained}（${affResult.after}/${status.maxAffinity} · ${status.stage.label}）`,
      });
    }
    this._emit('story-engine:updated', { characterId: cid, action: 'talk' });
    this._emit('interaction:talked', { characterId: cid, affDelta: affResult.gained, afterAff: affResult.after });
    return {
      affDelta: affResult.gained,
      afterAff: affResult.after,
      dailyCapReached,
      pendingGate: affResult.hitGate,
      text: spokenText,
    };
  }

  async touchPortrait(actor, zone = 'head') {
    if (!actor || !actor.id) throw new Error('暂无可互动的舰娘');
    this.ensureGreeting(actor);

    const cid = actor.id;
    const vars = this._buildVars(actor);
    const status = this.getAffectionStatus(cid);
    const zonePool = PORTRAIT_TOUCH_LINES[zone] || PORTRAIT_TOUCH_LINES.head;
    const band = status.isOathed && Array.isArray(zonePool.oath)
      ? 'oath'
      : status.stage.index >= 4
      ? 'high'
      : status.stage.index >= 2
      ? 'mid'
      : 'low';
    const picked = pickRandom(zonePool[band] || zonePool.low) || zonePool.low[0];

    const zoneLabels = { head: '轻抚发顶', shoulder: '轻触肩头', hand: '轻握指尖' };
    this._appendMessage(cid, {
      role: 'narration',
      text: formatDialogueText(picked.narration, vars),
    });
    this._appendMessage(cid, {
      role: 'ship',
      speaker: actor.name,
      text: formatDialogueText(picked.text, vars),
    });
    this._entities.adjustStat(cid, 'morale', 2, { min: 0, max: 100 });
    await this.persist();
    this._emit('story-engine:updated', { characterId: cid, action: 'touch', zone });
    return { zoneLabel: zoneLabels[zone] || '互动', text: formatDialogueText(picked.text, vars) };
  }

  async giveBackpackGift(actor, itemId) {
    if (!actor || !actor.id) throw new Error('目标舰娘不存在');
    if (!this._inventory) throw new Error('仓库系统未就绪');
    const item = this._inventory.getItem(itemId);
    if (!item || Number(item.quantity || 0) <= 0) {
      throw new Error('背包中该礼物数量不足，可前往「设施 → 心意礼物铺」购置');
    }

    this.ensureGreeting(actor);
    const cid = actor.id;
    const affBonus = (item.bonuses || []).find((b) => b.stat === 'affinity');
    const moraleBonus = (item.bonuses || []).find((b) => b.stat === 'morale');
    const rawAff = Math.max(2, Math.min(8, Math.round(Number(affBonus?.value) || 3)));
    const moraleGain = Math.max(4, Math.round(Number(moraleBonus?.value) || 10));

    // Decrement quantity cleanly via inventory
    await this._inventory.consumeItemQuantity(item.id, 1);

    const vars = this._buildVars(actor, { giftName: item.name });
    const affResult = this.gainAffection(cid, rawAff, { source: 'gift' });
    this._entities.adjustStat(cid, 'morale', moraleGain, { min: 0, max: 100 });

    this._appendMessage(cid, {
      role: 'commander',
      kind: 'gift',
      speaker: vars.cmdName,
      giftName: item.name,
      text: `🎁 赠送了心意礼物「${item.name}」`,
    });
    this._appendMessage(cid, {
      role: 'narration',
      text: `${actor.name}双手接过「${item.name}」，眼底浮起柔和的惊喜。`,
    });

    const postStatus = this.getAffectionStatus(cid);
    const stage = postStatus.stage;
    const replyByStage = {
      stranger: `「给我的吗？谢谢{cmd}，这份{gift}我会好好收起来的。」`,
      familiar: `「哇，是{gift}！{cmd}眼光真好，刚好是我最近想找的呢。」`,
      trusted: `「谢谢你总记着我的喜好，{cmd}。收到这份{gift}，感觉整个人都被治愈了。」`,
      flutter: `「特意为我挑的{gift}吗……{cmd}这样用心，会让我越来越在意的呀。」`,
      adoration: `「{gift}我很喜欢，不过……比起礼物，更开心的是送它的人是你，{cmd}。」`,
      oath: `「每次收到你送的{gift}，都会觉得和你在一起的每一天都闪闪发光呢。」`,
    };
    this._appendMessage(cid, {
      role: 'ship',
      speaker: actor.name,
      text: formatDialogueText(replyByStage[stage.id] || replyByStage.familiar, vars),
    });
    this._appendMessage(cid, {
      role: 'system',
      text: affResult.gained > 0
        ? `好感 +${affResult.gained}（当前 ${affResult.after}/${postStatus.currentCap}） · 士气 +${moraleGain}${affResult.hitGate ? ` · ✨ 已达阶段上限 ${affResult.after}/${affResult.hitGate}，请点击触发阶段突破小剧场！` : ''}`
        : `士气 +${moraleGain}${affResult.hitGate ? ` · 已达阶段上限 ${affResult.after}/${affResult.hitGate}，完成突破剧场后继续提升` : postStatus.canStartOath ? ' · 好感已达 100/100，点击「💍 发起誓约」解锁 150 上限！' : ''}`,
    });

    await this.persist();
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.CHARACTER,
        actorId: cid,
        actorName: actor.name,
        title: `[${actor.name}] 获赠礼物「${item.name}」`,
        detail: `好感 +${affResult.gained}（${affResult.after}/${postStatus.currentCap}）· 士气 +${moraleGain}`,
      });
    }
    this._emit('story-engine:updated', { characterId: cid, action: 'gift' });
    this._emit('interaction:gifted', { characterId: cid, giftName: item.name, affDelta: affResult.gained, afterAff: affResult.after });
    return {
      giftName: item.name,
      affDelta: affResult.gained,
      moraleGain,
      afterAff: affResult.after,
      pendingGate: affResult.hitGate,
      cappedByGate: affResult.cappedByGate,
    };
  }

  /**
   * Launch a stage breakthrough mini-theatre (or replay an unlocked one) right inside the bubble chat!
   */
  async startBreakthroughTheatre(actor, gate, { isReplay = false } = {}) {
    if (!actor || !actor.id) throw new Error('舰娘不存在');
    const theatre = BREAKTHROUGH_THEATRES[Number(gate)];
    if (!theatre) throw new Error('未找到对应阶段突破小剧场');

    const cid = actor.id;
    const vars = this._buildVars(actor);

    this._appendMessage(cid, {
      role: 'system',
      text: `${isReplay ? '↺ 重温小剧场' : '✨ 开启阶段突破小剧场'} · ${theatre.title}（${theatre.fromLabel} → ${theatre.toLabel}）`,
    });
    this._appendMessage(cid, {
      role: 'narration',
      text: formatDialogueText(theatre.introNarration, vars),
    });
    this._appendMessage(cid, {
      role: 'ship',
      speaker: actor.name,
      text: formatDialogueText(theatre.openingLine, vars),
    });

    this._state.activePromptByShip[cid] = {
      kind: 'breakthrough',
      gate: Number(gate),
      isReplay: Boolean(isReplay),
      title: theatre.title,
      choices: theatre.choices.map((c) => ({
        id: c.id,
        label: formatDialogueText(c.label, vars),
        narration: formatDialogueText(c.narration, vars),
        reply: formatDialogueText(c.reply, vars),
        closingNarration: formatDialogueText(c.closingNarration, vars),
      })),
    };

    await this.persist();
    this._emit('story-engine:updated', { characterId: cid, action: 'breakthrough-start', gate });
    return theatre;
  }

  /**
   * Launch the romantic Oath Ceremony Mini-Theatre directly inside the bubble chat window!
   */
  async startOathRitualTheatre(actor) {
    if (!actor || !actor.id) throw new Error('舰娘不存在');
    const cid = actor.id;
    const status = this.getAffectionStatus(cid);
    if (status.isOathed) {
      throw new Error(`「${actor.name}」已经与您缔结誓约`);
    }
    if (status.affinity < BASE_AFFINITY_CAP) {
      throw new Error(`好感度需达到 ${BASE_AFFINITY_CAP} 才可发起誓约（当前 ${status.affinity}/${BASE_AFFINITY_CAP}）`);
    }
    if (status.pendingGate) {
      throw new Error(`请先完成 ${status.pendingGate} 阶段突破小剧场后再发起誓约`);
    }

    const vars = this._buildVars(actor);
    const ritual = OATH_RITUAL_THEATRE;

    this._appendMessage(cid, {
      role: 'system',
      text: `💍 开启誓约仪式小剧场 · ${ritual.title}`,
    });
    this._appendMessage(cid, {
      role: 'narration',
      text: formatDialogueText(ritual.introNarration, vars),
    });
    this._appendMessage(cid, {
      role: 'ship',
      speaker: actor.name,
      text: formatDialogueText(ritual.openingLine, vars),
    });

    this._state.activePromptByShip[cid] = {
      kind: 'oath_ritual',
      title: ritual.title,
      choices: ritual.choices.map((c) => ({
        id: c.id,
        oathTitle: c.oathTitle || '永恒誓约',
        label: formatDialogueText(c.label, vars),
        narration: formatDialogueText(c.narration, vars),
        reply: formatDialogueText(c.reply, vars),
        closingNarration: formatDialogueText(c.closingNarration, vars),
      })),
    };

    await this.persist();
    this._emit('story-engine:updated', { characterId: cid, action: 'oath-ritual-start' });
    return ritual;
  }

  async resolveChatChoice(actor, choiceId) {
    if (!actor || !actor.id) return null;
    const cid = actor.id;
    const prompt = this._state.activePromptByShip[cid];
    if (!prompt || !Array.isArray(prompt.choices)) return null;
    const choice = prompt.choices.find((c) => c.id === choiceId);
    if (!choice) return null;

    const vars = this._buildVars(actor);
    this._appendMessage(cid, {
      role: 'commander',
      speaker: vars.cmdName,
      text: choice.label,
    });
    if (choice.narration) {
      this._appendMessage(cid, { role: 'narration', text: choice.narration });
    }
    if (choice.reply) {
      this._appendMessage(cid, { role: 'ship', speaker: actor.name, text: choice.reply });
    }

    let unlockedGate = null;
    let oathed = false;
    let oathRecord = null;

    if (prompt.kind === 'breakthrough') {
      const gate = Number(prompt.gate);
      if (choice.closingNarration) {
        this._appendMessage(cid, { role: 'narration', text: choice.closingNarration });
      }
      if (!prompt.isReplay) {
        const set = new Set(this._state.unlockedBreakthroughs[cid] || []);
        set.add(gate);
        this._state.unlockedBreakthroughs[cid] = Array.from(set).sort((a, b) => a - b);
        unlockedGate = gate;
        const postSt = this.getAffectionStatus(cid);
        this._appendMessage(cid, {
          role: 'system',
          text:
            gate >= BASE_AFFINITY_CAP
              ? `🎉 恋慕阶段突破完成！现在可以点击上方「💍 发起誓约」举行誓约仪式，解放 150 好感上限！`
              : `🎉 阶段突破成功！已解锁【${BREAKTHROUGH_THEATRES[gate]?.toLabel || ''}】阶段，好感上限已解除至 ${postSt.currentCap}！`,
        });
      }
    } else if (prompt.kind === 'oath_ritual') {
      if (choice.closingNarration) {
        this._appendMessage(cid, { role: 'narration', text: choice.closingNarration });
      }
      // Guarantee all gates <= 100 are unlocked and perform the official Oath ceremony cleanly
      this._state.unlockedBreakthroughs[cid] = [...BREAKTHROUGH_GATES];
      if (this._interaction && typeof this._interaction.performOath === 'function') {
        const res = await this._interaction.performOath(cid, {
          oathTitle: choice.oathTitle || '永恒誓约',
          customVow: choice.label,
        });
        oathRecord = this._interaction.getOathRecord(cid) || res;
      } else {
        // Ultra-safe fallback even if interaction service were absent
        const now = Date.now();
        if (!actor.meta) actor.meta = {};
        actor.meta.isOathed = true;
        actor.meta.oathDate = now;
        actor.isOathed = true;
        actor.oathDate = now;
        if (!actor.statBounds) actor.statBounds = {};
        actor.statBounds.affinity = { min: 0, max: OATH_AFFINITY_CAP };
        oathRecord = { oathedAt: now, oathTitle: choice.oathTitle || '永恒誓约' };
      }
      oathed = true;
      this._appendMessage(cid, {
        role: 'system',
        text: `💍 誓约缔结完成！「${actor.name}」好感上限已突破至 ${OATH_AFFINITY_CAP}，永久获得基础六维各 +4、出征油弹消耗 -10%、宿舍心情加速恢复与专属誓约台词！`,
      });
    }

    this._state.activePromptByShip[cid] = null;
    await this.persist();
    this._emit('story-engine:updated', { characterId: cid, action: 'choice-resolved', unlockedGate, oathed });
    return { unlockedGate, oathed, oath: oathRecord, choice };
  }

  /**
   * Pick a fresh maritime encounter story for Sortie Stage 3 chart nodes.
   * Respects external imported JSON packs first, then draws from `MARITIME_ENCOUNTER_STORIES`.
   */
  pickMaritimeEncounter({ actor }) {
    const vars = this._buildVars(actor || { id: '', name: '旗舰' });
    const raw = pickRandom(MARITIME_ENCOUNTER_STORIES) || MARITIME_ENCOUNTER_STORIES[0];
    return {
      id: raw.id,
      title: raw.title,
      speaker: formatDialogueText(raw.speaker, vars),
      body: formatDialogueText(raw.body, vars),
      choices: raw.choices.map((c) => ({
        ...deepClone(c),
        label: formatDialogueText(c.label, vars),
        successText: formatDialogueText(c.successText, vars),
        failText: c.failText ? formatDialogueText(c.failText, vars) : '',
      })),
    };
  }
}
