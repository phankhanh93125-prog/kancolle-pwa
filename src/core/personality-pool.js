/**
 * Local Personality Pool & Random Personality Combination Engine (`personality-pool.js`).
 *
 * Provides:
 *   - Primary Personality Pool (主性格池, 12 built-in archetypes + player CRUD)
 *   - Secondary Trait / Quirk Pool (副特质/口癖池, 12 built-in quirks + player CRUD)
 *   - Random Combination Generator ("同舰不同性格": every newly constructed or generated
 *     shipgirl receives a fresh Primary × Secondary combination, plus one-tap reroll)
 *   - IndexedDB persistence & SaveManager serialize/deserialize support
 */

const STORAGE_NS = 'core-personality-pool';
const STATE_KEY = 'personality-pool-v1';

export const DEFAULT_PRIMARY_TRAITS = Object.freeze([
  {
    id: 'genki',
    name: '元气',
    toneTag: '开朗跃动',
    summary: '充满干劲与行动力，总是笑着把港区气氛带动起来。',
    speechPrefix: '嘿嘿，',
    speechSuffix: '冲呀！',
    builtIn: true,
  },
  {
    id: 'kuudere',
    name: '三无',
    toneTag: '冷静寡言',
    summary: '面无表情且言简意赅，但指令执行度与信赖感极高。',
    speechPrefix: '……确认。',
    speechSuffix: '以上。',
    builtIn: true,
  },
  {
    id: 'tsundere',
    name: '傲娇',
    toneTag: '口是心非',
    summary: '嘴上不饶人，实际却比谁都在意指挥官与同伴的安危。',
    speechPrefix: '哼、才不是特意为你——',
    speechSuffix: '别误会了啊！',
    builtIn: true,
  },
  {
    id: 'composed',
    name: '沉稳',
    toneTag: '理性可靠',
    summary: '遇事冷静周密，擅长大局调度与稳健护航。',
    speechPrefix: '请放心，',
    speechSuffix: '一切尽在掌握。',
    builtIn: true,
  },
  {
    id: 'scheming',
    name: '腹黑',
    toneTag: '笑里藏锋',
    summary: '语气温和带笑，总能精准拿捏对手弱点与指挥官的小心思。',
    speechPrefix: '哎呀呀，',
    speechSuffix: '真是有趣的局面呢♪',
    builtIn: true,
  },
  {
    id: 'airhead',
    name: '天然',
    toneTag: '呆萌随性',
    summary: '思维跳跃而率真，常常在无意间说出直击要害的话。',
    speechPrefix: '诶？原来如此呀～',
    speechSuffix: '好像很有趣的样子！',
    builtIn: true,
  },
  {
    id: 'strict',
    name: '严厉',
    toneTag: '纪律严明',
    summary: '坚持军纪与高标准操演，对怠惰绝不姑息却极为公允。',
    speechPrefix: '立正！',
    speechSuffix: '绝不容许半点松懈！',
    builtIn: true,
  },
  {
    id: 'lazy',
    name: '慵懒',
    toneTag: '慢条斯理',
    summary: '平时总想找个晒太阳的角落打盹，关键时刻却异常靠谱。',
    speechPrefix: '呼啊……',
    speechSuffix: '快点解决就能回去休息了吧～',
    builtIn: true,
  },
  {
    id: 'gentle',
    name: '温柔',
    toneTag: '温暖治愈',
    summary: '细心体贴、善解人意，是港区里最让人安心的避风港。',
    speechPrefix: '辛苦了呢，',
    speechSuffix: '慢慢来也没关系哦。',
    builtIn: true,
  },
  {
    id: 'hotblooded',
    name: '热血',
    toneTag: '斗志昂扬',
    summary: '迎难而上、斗志燃烧，面对强敌反而越战越勇。',
    speechPrefix: '燃起来了！',
    speechSuffix: '正面突破吧！',
    builtIn: true,
  },
  {
    id: 'shy',
    name: '害羞',
    toneTag: '腼腆真诚',
    summary: '容易脸红结巴，但在守护重要之人时会鼓起惊人的勇气。',
    speechPrefix: '那、那个……',
    speechSuffix: '我会努力不拖后腿的！',
    builtIn: true,
  },
  {
    id: 'noble',
    name: '优雅',
    toneTag: '从容华贵',
    summary: '举止礼仪无可挑剔，将海战视作艺术般的优雅舞步。',
    speechPrefix: '失礼了，',
    speechSuffix: '请欣赏这优雅的一击。',
    builtIn: true,
  },
]);

export const DEFAULT_SECONDARY_TRAITS = Object.freeze([
  {
    id: 'protective',
    name: '护短',
    habitTag: '守护同伴',
    summary: '极度护着自家编队和指挥官，谁敢动同伴就加倍奉还。',
    catchphrase: '敢碰我方舰队一根汗毛，就别想全身而退。',
    builtIn: true,
  },
  {
    id: 'foodie',
    name: '贪吃',
    habitTag: '甜点雷达',
    summary: '对港区食堂加餐和下午茶点心有着超凡执念。',
    catchphrase: '打完这仗，食堂的限定甜点可要留我一份哦！',
    builtIn: true,
  },
  {
    id: 'milgeek',
    name: '军迷',
    habitTag: '装备考据',
    summary: '痴迷火控参数、弹道曲线与舰船机械结构，谈起装备滔滔不绝。',
    catchphrase: '这组仰角与装药配比简直堪称教科书级！',
    builtIn: true,
  },
  {
    id: 'sharp_tongue',
    name: '毒舌',
    habitTag: '精准吐槽',
    summary: '总能一针见血地指出战术漏洞，吐槽犀利却句句实用。',
    catchphrase: '这种程度的阵型破绽，闭着眼睛都能拆穿吧？',
    builtIn: true,
  },
  {
    id: 'worrier',
    name: '爱操心',
    habitTag: '管家气质',
    summary: '时刻惦记油弹库存、指挥官作息和天气变化。',
    catchphrase: '油弹核对了吗？外套带了吗？可别着凉了！',
    builtIn: true,
  },
  {
    id: 'romantic',
    name: '浪漫派',
    habitTag: '星海诗意',
    summary: '喜欢将海风、星辰与航迹编织成诗意的浪漫话语。',
    catchphrase: '海天相接的彼岸，一定藏着属于我们的星辰。',
    builtIn: true,
  },
  {
    id: 'sleepy',
    name: '嗜睡',
    habitTag: '午休至上',
    summary: '只要没有警报响起，随时随地都能进入省电待机模式。',
    catchphrase: '唔……再让我闭目养神五分钟……就五分钟……',
    builtIn: true,
  },
  {
    id: 'neatfreak',
    name: '洁癖',
    habitTag: '甲板锃亮',
    summary: '坚持让甲板与装备一尘不染，讨厌硝烟弄脏礼服。',
    catchphrase: '甲板必须擦得能照出人影，作战也要干干净净！',
    builtIn: true,
  },
  {
    id: 'collector',
    name: '收藏癖',
    habitTag: '战利品控',
    summary: '热衷于打捞海图纪念品、稀有徽章和奇特漂流物。',
    catchphrase: '这片海域肯定藏着稀有纪念品，全部收进收藏柜！',
    builtIn: true,
  },
  {
    id: 'perfectionist',
    name: '完美主义',
    habitTag: '零误差',
    summary: '追求无伤通关与满分评价，对每个细节都精益求精。',
    catchphrase: '目标只有一个：零失误、全胜归港。',
    builtIn: true,
  },
  {
    id: 'tease',
    name: '爱捉弄',
    habitTag: '俏皮打趣',
    summary: '最喜欢看指挥官露出惊讶或手忙脚乱的表情。',
    catchphrase: '哎呀，指挥官的耳朵好像有点红呢？',
    builtIn: true,
  },
  {
    id: 'lucky_star',
    name: '直觉派',
    habitTag: '玄学直感',
    summary: '靠直觉就能避开暗礁与雷区，总相信风向站在自己这边。',
    catchphrase: '我的直觉告诉我，今天一定是大丰收的好日子！',
    builtIn: true,
  },
]);

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function pickFrom(list, rng = Math.random) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = Math.floor(Math.max(0, Math.min(0.999999, rng())) * list.length);
  return list[idx];
}

function buildDefaultState() {
  return {
    primary: deepClone(DEFAULT_PRIMARY_TRAITS),
    secondary: deepClone(DEFAULT_SECONDARY_TRAITS),
    updatedAt: Date.now(),
  };
}

export const DIALOGUE_CATEGORY_ALIASES = Object.freeze({
  secretary_idle: ['secretary_idle', 'idle', 'daily', 'talk', 'port', 'greeting', 'idleLines', 'lines', 'secretaryIdle'],
  secretary_night: ['secretary_night', 'night', 'midnight', 'evening', 'late_night', 'secretaryNight'],
  outfit_change: ['outfit_change', 'outfit', 'costume', 'dress', 'outfitChange'],
  dock_repair: ['dock_repair', 'repair', 'dock', 'dockIn', 'dockOut', 'dockRepair'],
  sortie_start: ['sortie_start', 'sortie', 'departure', 'launch', 'sortieStart'],
  combat_turn: ['combat_turn', 'combat', 'attack', 'shelling', 'battle', 'combatTurn'],
  combat_skill: ['combat_skill', 'skill', 'torpedo', 'airstrike', 'crit', 'special', 'combatSkill'],
  combat_ambush: ['combat_ambush', 'ambush', 'hit', 'damaged', 'warning', 'combatAmbush'],
  combat_night_chase: ['combat_night_chase', 'night_battle', 'night_chase', 'nightCombat', 'combatNightChase'],
  sortie_return: ['sortie_return', 'return', 'victory', 'mvp', 'clear', 'sortieReturn'],
  gift: ['gift', 'present', 'reward'],
  dorm: ['dorm', 'rest', 'dormitory'],
});

const ALIAS_TO_CANONICAL_CATEGORY = Object.freeze(
  Object.entries(DIALOGUE_CATEGORY_ALIASES).reduce((acc, [canon, aliases]) => {
    for (const a of aliases) {
      acc[String(a).toLowerCase()] = canon;
    }
    return acc;
  }, {})
);

export function normalizeLineArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const str =
      typeof item === 'string'
        ? item.trim()
        : item && typeof item === 'object'
        ? String(item.text || item.content || item.line || item.dialogue || '').trim()
        : '';
    if (!str || seen.has(str)) continue;
    seen.add(str);
    out.push(str);
  }
  return out;
}

export function normalizeDialogueCategories(rawObj = {}) {
  const result = {};
  const appendLines = (canonKey, rawVal) => {
    const lines = normalizeLineArray(rawVal);
    if (lines.length === 0) return;
    const prev = result[canonKey] || [];
    const seen = new Set(prev);
    for (const l of lines) {
      if (!seen.has(l)) {
        seen.add(l);
        prev.push(l);
      }
    }
    result[canonKey] = prev;
  };

  if (!rawObj || typeof rawObj !== 'object') return result;

  // Support nested `dialogues` / `lines` / `voice` / `quotes` container (object OR flat array)
  const nestedContainers = [rawObj.dialogues, rawObj.lines, rawObj.voice, rawObj.quotes, rawObj.templates];
  for (const container of nestedContainers) {
    if (!container) continue;
    if (Array.isArray(container) || typeof container === 'string') {
      appendLines('secretary_idle', container);
    } else if (typeof container === 'object') {
      for (const [k, v] of Object.entries(container)) {
        const canon = ALIAS_TO_CANONICAL_CATEGORY[String(k).toLowerCase()];
        if (canon) {
          appendLines(canon, v);
        } else if (k === 'combat' && v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [ck, cv] of Object.entries(v)) {
            const cCanon = ALIAS_TO_CANONICAL_CATEGORY[String(ck).toLowerCase()] || 'combat_turn';
            appendLines(cCanon, cv);
          }
        }
      }
    }
  }

  // Also scan direct top-level alias keys on the personality object itself
  for (const [k, v] of Object.entries(rawObj)) {
    if (k === 'dialogues' || k === 'lines' || k === 'voice' || k === 'quotes') continue;
    const canon = ALIAS_TO_CANONICAL_CATEGORY[String(k).toLowerCase()];
    if (canon) {
      appendLines(canon, v);
    }
  }

  return result;
}

function mergeDialogueMaps(prevMap = {}, nextMap = {}) {
  const merged = deepClone(prevMap && typeof prevMap === 'object' ? prevMap : {});
  for (const [k, lines] of Object.entries(nextMap || {})) {
    const existing = Array.isArray(merged[k]) ? merged[k] : [];
    const seen = new Set(existing);
    for (const line of normalizeLineArray(lines)) {
      if (!seen.has(line)) {
        seen.add(line);
        existing.push(line);
      }
    }
    merged[k] = existing;
  }
  return merged;
}

export class PersonalityPool {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({ storage, bus = null }) {
    this._storage = storage;
    this._scope = storage ? storage.namespace(STORAGE_NS) : null;
    this._bus = bus;
    this._state = buildDefaultState();
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
      } else {
        this._state = buildDefaultState();
        await this.persist();
      }
    }
    this._hydrated = true;
  }

  async persist() {
    this._state.updatedAt = Date.now();
    if (this._scope) {
      await this._scope.setLarge(STATE_KEY, this.serialize());
    }
  }

  listPrimary() {
    return deepClone(this._state.primary);
  }

  listSecondary() {
    return deepClone(this._state.secondary);
  }

  getPrimary(id) {
    return this._state.primary.find((p) => p.id === String(id)) || null;
  }

  getPrimaryByIdOrName(idOrName) {
    const q = String(idOrName || '').trim();
    if (!q) return null;
    return this._state.primary.find((p) => p.id === q || p.name === q) || null;
  }

  getSecondary(id) {
    return this._state.secondary.find((s) => s.id === String(id)) || null;
  }

  getSecondaryByIdOrName(idOrName) {
    const q = String(idOrName || '').trim();
    if (!q) return null;
    return this._state.secondary.find((s) => s.id === q || s.name === q) || null;
  }

  getPrimaryDialogueLines(primaryIdOrName, category = 'secretary_idle') {
    const canon = ALIAS_TO_CANONICAL_CATEGORY[String(category || '').toLowerCase()] || 'secretary_idle';
    const pri = this.getPrimaryByIdOrName(primaryIdOrName);
    if (!pri || !pri.dialogues || typeof pri.dialogues !== 'object') return [];
    return normalizeLineArray(pri.dialogues[canon]);
  }

  getAllPrimaryDialogueLines(category = 'secretary_idle') {
    const canon = ALIAS_TO_CANONICAL_CATEGORY[String(category || '').toLowerCase()] || 'secretary_idle';
    const out = [];
    for (const pri of this._state.primary) {
      if (pri?.dialogues?.[canon]?.length) {
        for (const line of pri.dialogues[canon]) {
          out.push({ primaryId: pri.id, primaryName: pri.name, line });
        }
      }
    }
    return out;
  }

  getSecondaryIdleLines(secondaryIdOrName) {
    const sec = this.getSecondaryByIdOrName(secondaryIdOrName);
    if (!sec) return [];
    const lines = normalizeLineArray(sec.idleLines);
    if (sec.catchphrase && !lines.includes(sec.catchphrase)) {
      lines.push(sec.catchphrase);
    }
    return lines;
  }

  getAllSecondaryIdleLines() {
    const out = [];
    for (const sec of this._state.secondary) {
      for (const line of normalizeLineArray(sec.idleLines)) {
        out.push({ secondaryId: sec.id, secondaryName: sec.name, line });
      }
    }
    return out;
  }

  getPersonalitySummary(entity) {
    if (!entity) return null;
    const combo = this.ensurePersonalityOnEntity(entity);
    const primary = this.getPrimaryByIdOrName(combo?.primaryId || combo?.primaryName) || {
      id: combo?.primaryId || 'composed',
      name: combo?.primaryName || '沉稳',
    };
    const secondary = this.getSecondaryByIdOrName(combo?.secondaryId || combo?.secondaryName) || {
      id: combo?.secondaryId || 'protective',
      name: combo?.secondaryName || '护短',
    };
    return {
      combo,
      primary: deepClone(primary),
      secondaries: [deepClone(secondary)],
    };
  }

  async addPrimary(def = {}) {
    const name = String(def.name || def.title || def.label || '').trim();
    if (!name) throw new Error('主性格名称不能为空');
    const dialogues = normalizeDialogueCategories(def);
    const existingIdx = this._state.primary.findIndex(
      (p) => (def.id && p.id === String(def.id)) || p.name === name
    );

    if (existingIdx >= 0) {
      const prev = this._state.primary[existingIdx];
      const merged = {
        ...prev,
        name,
        toneTag: String(def.toneTag || def.tone || prev.toneTag || name).trim(),
        summary: String(def.summary || def.desc || def.description || prev.summary || `带有「${name}」气场的独特主性格。`).trim(),
        speechPrefix: def.speechPrefix !== undefined ? String(def.speechPrefix).trim() : prev.speechPrefix || '',
        speechSuffix: def.speechSuffix !== undefined ? String(def.speechSuffix).trim() : prev.speechSuffix || '',
        dialogues: mergeDialogueMaps(prev.dialogues, dialogues),
      };
      this._state.primary[existingIdx] = merged;
      await this.persist();
      this._emit('personality:pool-updated', { kind: 'primary', item: deepClone(merged) });
      return deepClone(merged);
    }

    const item = {
      id: String(def.id || `pri_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`),
      name,
      toneTag: String(def.toneTag || def.tone || name).trim(),
      summary: String(def.summary || def.desc || def.description || `带有「${name}」气场的独特主性格。`).trim(),
      speechPrefix: String(def.speechPrefix || def.prefix || '').trim(),
      speechSuffix: String(def.speechSuffix || def.suffix || '').trim(),
      dialogues,
      builtIn: false,
    };
    this._state.primary.push(item);
    await this.persist();
    this._emit('personality:pool-updated', { kind: 'primary', item: deepClone(item) });
    return deepClone(item);
  }

  async updatePrimary(id, patch = {}) {
    const idx = this._state.primary.findIndex((p) => p.id === String(id));
    if (idx < 0) throw new Error('目标主性格词条不存在');
    const prev = this._state.primary[idx];
    const nextDialogues = normalizeDialogueCategories(patch);
    const next = {
      ...prev,
      name: patch.name !== undefined ? String(patch.name).trim() || prev.name : prev.name,
      toneTag: patch.toneTag !== undefined ? String(patch.toneTag).trim() : prev.toneTag,
      summary: patch.summary !== undefined ? String(patch.summary).trim() : prev.summary,
      speechPrefix: patch.speechPrefix !== undefined ? String(patch.speechPrefix).trim() : prev.speechPrefix,
      speechSuffix: patch.speechSuffix !== undefined ? String(patch.speechSuffix).trim() : prev.speechSuffix,
      dialogues: Object.keys(nextDialogues).length > 0 ? mergeDialogueMaps(prev.dialogues, nextDialogues) : prev.dialogues || {},
    };
    this._state.primary[idx] = next;
    await this.persist();
    this._emit('personality:pool-updated', { kind: 'primary', item: deepClone(next) });
    return deepClone(next);
  }

  async deletePrimary(id) {
    if (this._state.primary.length <= 2) throw new Error('主性格池至少需要保留 2 个词条');
    const prevLen = this._state.primary.length;
    this._state.primary = this._state.primary.filter((p) => p.id !== String(id));
    if (this._state.primary.length !== prevLen) {
      await this.persist();
      this._emit('personality:pool-updated', { kind: 'primary', deletedId: id });
      return true;
    }
    return false;
  }

  async addSecondary(def = {}) {
    const name = String(def.name || def.title || def.label || '').trim();
    if (!name) throw new Error('副特质名称不能为空');
    const incomingLines = normalizeLineArray([
      ...(Array.isArray(def.idleLines) ? def.idleLines : def.idleLines ? [def.idleLines] : []),
      ...(Array.isArray(def.lines) ? def.lines : def.lines ? [def.lines] : []),
      ...(Array.isArray(def.dialogues) ? def.dialogues : def.dialogues ? [def.dialogues] : []),
      ...(Array.isArray(def.quotes) ? def.quotes : def.quotes ? [def.quotes] : []),
      ...(Array.isArray(def.catchphrases) ? def.catchphrases : []),
      ...(def.catchphrase ? [def.catchphrase] : []),
    ]);

    const existingIdx = this._state.secondary.findIndex(
      (s) => (def.id && s.id === String(def.id)) || s.name === name
    );
    if (existingIdx >= 0) {
      const prev = this._state.secondary[existingIdx];
      const mergedLines = normalizeLineArray([...(prev.idleLines || []), ...incomingLines]);
      const merged = {
        ...prev,
        name,
        habitTag: String(def.habitTag || def.tag || prev.habitTag || name).trim(),
        summary: String(def.summary || def.desc || def.description || prev.summary || `拥有「${name}」鲜明副特质与生活习惯。`).trim(),
        catchphrase: String(def.catchphrase || prev.catchphrase || mergedLines[0] || `果然还是「${name}」最让人安心呢。`).trim(),
        idleLines: mergedLines,
      };
      this._state.secondary[existingIdx] = merged;
      await this.persist();
      this._emit('personality:pool-updated', { kind: 'secondary', item: deepClone(merged) });
      return deepClone(merged);
    }

    const item = {
      id: String(def.id || `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`),
      name,
      habitTag: String(def.habitTag || def.tag || name).trim(),
      summary: String(def.summary || def.desc || def.description || `拥有「${name}」鲜明副特质与生活习惯。`).trim(),
      catchphrase: String(def.catchphrase || incomingLines[0] || `果然还是「${name}」最让人安心呢。`).trim(),
      idleLines: incomingLines,
      builtIn: false,
    };
    this._state.secondary.push(item);
    await this.persist();
    this._emit('personality:pool-updated', { kind: 'secondary', item: deepClone(item) });
    return deepClone(item);
  }

  async updateSecondary(id, patch = {}) {
    const idx = this._state.secondary.findIndex((s) => s.id === String(id));
    if (idx < 0) throw new Error('目标副特质词条不存在');
    const prev = this._state.secondary[idx];
    const incomingLines = normalizeLineArray(patch.idleLines || patch.lines || patch.dialogues);
    const next = {
      ...prev,
      name: patch.name !== undefined ? String(patch.name).trim() || prev.name : prev.name,
      habitTag: patch.habitTag !== undefined ? String(patch.habitTag).trim() : prev.habitTag,
      summary: patch.summary !== undefined ? String(patch.summary).trim() : prev.summary,
      catchphrase: patch.catchphrase !== undefined ? String(patch.catchphrase).trim() : prev.catchphrase,
      idleLines: incomingLines.length > 0 ? normalizeLineArray([...(prev.idleLines || []), ...incomingLines]) : prev.idleLines || [],
    };
    this._state.secondary[idx] = next;
    await this.persist();
    this._emit('personality:pool-updated', { kind: 'secondary', item: deepClone(next) });
    return deepClone(next);
  }

  async deleteSecondary(id) {
    if (this._state.secondary.length <= 2) throw new Error('副特质池至少需要保留 2 个词条');
    const prevLen = this._state.secondary.length;
    this._state.secondary = this._state.secondary.filter((s) => s.id !== String(id));
    if (this._state.secondary.length !== prevLen) {
      await this.persist();
      this._emit('personality:pool-updated', { kind: 'secondary', deletedId: id });
      return true;
    }
    return false;
  }

  /**
   * Roll a random Primary × Secondary combination ("同舰不同性格").
   * Optionally avoids repeating the current combo key when rerolling.
   */
  rollCombination({ avoidKey = null, primaryId = null, secondaryId = null, rng = Math.random } = {}) {
    const primaryPool = this._state.primary.length > 0 ? this._state.primary : DEFAULT_PRIMARY_TRAITS;
    const secondaryPool = this._state.secondary.length > 0 ? this._state.secondary : DEFAULT_SECONDARY_TRAITS;

    let pri = primaryId ? primaryPool.find((p) => p.id === primaryId || p.name === primaryId) : null;
    let sec = secondaryId ? secondaryPool.find((s) => s.id === secondaryId || s.name === secondaryId) : null;

    if (!pri || !sec) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const candPri = pri || pickFrom(primaryPool, rng);
        const candSec = sec || pickFrom(secondaryPool, rng);
        const key = `${candPri.id}__${candSec.id}`;
        if (!avoidKey || key !== avoidKey || (primaryPool.length <= 1 && secondaryPool.length <= 1)) {
          pri = candPri;
          sec = candSec;
          break;
        }
      }
      if (!pri) pri = primaryPool[0];
      if (!sec) sec = secondaryPool[0];
    }

    const comboKey = `${pri.id}__${sec.id}`;
    const comboLabel = `${pri.name} × ${sec.name}`;
    const description = `【${comboLabel}】${pri.summary}${sec.summary}`;
    const speechHabit = `「${pri.speechPrefix}${sec.catchphrase}」`;

    return {
      key: comboKey,
      primaryId: pri.id,
      primaryName: pri.name,
      secondaryId: sec.id,
      secondaryName: sec.name,
      comboLabel,
      toneTag: pri.toneTag,
      habitTag: sec.habitTag,
      speechPrefix: pri.speechPrefix,
      speechSuffix: pri.speechSuffix,
      catchphrase: sec.catchphrase,
      description,
      speechHabit,
    };
  }

  /**
   * Ensure a shipgirl entity carries a valid structured `meta.personalityCombo`.
   * Preserves any existing valid combo without overwriting.
   */
  ensurePersonalityOnEntity(entity, { rng = Math.random } = {}) {
    if (!entity) return null;
    if (!entity.meta || typeof entity.meta !== 'object') entity.meta = {};
    const existing = entity.meta.personalityCombo;
    if (existing && existing.primaryId && existing.secondaryId && existing.comboLabel) {
      return existing;
    }
    const combo = this.rollCombination({ rng });
    entity.meta.personalityCombo = combo;
    if (!entity.meta.personality) {
      entity.meta.personality = combo.description;
    }
    if (!entity.meta.speechHabit) {
      entity.meta.speechHabit = combo.speechHabit;
    }
    return combo;
  }

  /**
   * Roll and assign a brand-new random Primary × Secondary personality to an existing shipgirl.
   */
  assignRandomPersonality(entities, characterId, { avoidCurrent = true, rng = Math.random } = {}) {
    const entity = entities?.get(String(characterId));
    if (!entity) throw new Error('目标舰娘不存在');
    if (!entity.meta || typeof entity.meta !== 'object') entity.meta = {};
    const currentKey = avoidCurrent ? entity.meta.personalityCombo?.key || null : null;
    const combo = this.rollCombination({ avoidKey: currentKey, rng });
    entity.meta.personalityCombo = combo;
    entity.meta.personality = combo.description;
    entity.meta.speechHabit = combo.speechHabit;
    this._emit('personality:rolled', {
      characterId: entity.id,
      characterName: entity.name,
      combo: deepClone(combo),
    });
    return deepClone(combo);
  }

  serialize() {
    return {
      version: 2,
      primary: deepClone(this._state.primary),
      secondary: deepClone(this._state.secondary),
      updatedAt: this._state.updatedAt,
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const mergeDefaults = (incoming, defaults) => {
      const list = Array.isArray(incoming) && incoming.length > 0 ? deepClone(incoming) : deepClone(defaults);
      const existingIds = new Set(list.map((x) => x.id));
      for (const d of defaults) {
        if (!existingIds.has(d.id)) list.push(deepClone(d));
      }
      return list;
    };
    this._state = {
      primary: mergeDefaults(snapshot.primary, DEFAULT_PRIMARY_TRAITS),
      secondary: mergeDefaults(snapshot.secondary, DEFAULT_SECONDARY_TRAITS),
      updatedAt: Number(snapshot.updatedAt) || Date.now(),
    };
    if (persist) this.persist();
  }
}
