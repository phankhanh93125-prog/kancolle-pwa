/**
 * Full-Spectrum Compendium & Custom World Content/Mod Manager (`content-manager.js`).
 *
 * Responsibilities:
 *   1. Tracks compendium discovery/collection across:
 *        - Shipgirls (舰娘图鉴)
 *        - Equipment & Outfits (装备与服装图鉴)
 *        - Enemy Archive (敌舰档案 — built-in archetypes + player custom enemies + drop tables)
 *        - Sea Routes (海域航线图鉴 — presets + custom routes + cleared counters)
 *   2. Manages player-created custom content in IndexedDB:
 *        - Custom Enemy Templates (usable in procedural sortie encounters)
 *        - Custom Daily Interaction Dialogue Templates (consumed by InteractionSystem)
 *        - Custom Gift Items (available in Secretary Gift Picker)
 *   3. Full World JSON Mod Export / Import (merge or replace):
 *        - Packages characters, inventory, port buildings, custom routes, custom enemies,
 *          custom dialogues, custom gifts, and oath records into a single portable `.json` mod pack.
 */

import { clamp } from './calc-engine.js';
import { NODE_TYPES } from './route-generator.js';
import { ITEM_CATEGORIES, ITEM_CATEGORY_LABELS, STARTER_PACK_EQUIPMENT_16 } from './inventory-system.js';
import {
  KNOWN_EQUIPMENT_TYPES,
  inferItemRarity,
  inferSupportRole,
  normalizeEquipmentTypeId,
  normalizeLegacyItemBonusesToCompressedScale,
  normalizeLegacyShipStatsToCompressedScale,
  normalizeRarity,
  resolveShipClass,
} from './stat-rules.js';
import { normalizeDialogueCategories, normalizeLineArray } from './personality-pool.js';
import { normalizeAdaptiveStoryPack } from './story-pack-engine.js';
import { LOG_CATEGORIES } from './log-system.js';

const STORAGE_NS = 'core-content-studio';
const STATE_KEY = 'content-studio-v1';

export const WORLD_MOD_SCHEMA = 'kancolle-pwa-world-mod-v1';

export const BUILTIN_ENEMY_ARCHIVE = Object.freeze([
  {
    id: 'enemy_builtin_patrol',
    name: '前哨巡逻编队',
    tier: NODE_TYPES.ENCOUNTER,
    riskLevel: '1★ 近海防卫区',
    star: 1,
    hp: 34,
    armor: 12,
    attackPower: 20,
    airThreat: 0,
    subThreat: 0,
    threatLabel: '常规水面炮雷编队',
    weakness: 'shelling',
    weaknessLabel: '炮击弱点',
    drops: ['钢材 55~75', '铝材 30~45', '银条 100~140'],
    builtIn: true,
  },
  {
    id: 'enemy_builtin_sub_wolfpack',
    name: '潜航伏击狼群',
    tier: NODE_TYPES.ENCOUNTER,
    riskLevel: '2★ 外海破交航道',
    star: 2,
    hp: 52,
    armor: 20,
    attackPower: 36,
    airThreat: 0,
    subThreat: 28,
    threatLabel: '敌方水下潜艇威胁',
    weakness: 'asw',
    weaknessLabel: '反潜弱点',
    drops: ['燃油 55~85', '钢材 70~95', '银条 140~180'],
    builtIn: true,
  },
  {
    id: 'enemy_builtin_heavy_cruiser_div',
    name: '重巡破交封锁支队',
    tier: NODE_TYPES.ELITE,
    riskLevel: '3★ 深水前线海域',
    star: 3,
    hp: 88,
    armor: 42,
    attackPower: 60,
    airThreat: 10,
    subThreat: 0,
    threatLabel: '重甲水面火力编队',
    weakness: 'torpedo',
    weaknessLabel: '鱼雷弱点',
    drops: ['钢材 115~155', '燃油 85~115', '银条 210~280'],
    builtIn: true,
  },
  {
    id: 'enemy_builtin_air_raider',
    name: '轻航突袭中队',
    tier: NODE_TYPES.ELITE,
    riskLevel: '4★ 要塞外围战区',
    star: 4,
    hp: 128,
    armor: 56,
    attackPower: 84,
    airThreat: 62,
    subThreat: 0,
    threatLabel: '敌方航空威胁',
    weakness: 'aa',
    weaknessLabel: '防空/空袭弱点',
    drops: ['铝材 110~155', '钢材 120~165', '银条 260~340'],
    builtIn: true,
  },
  {
    id: 'enemy_builtin_abyssal_dreadnought',
    name: '深海战列强袭群',
    tier: NODE_TYPES.BOSS,
    riskLevel: '4★ 要塞外围战区',
    star: 4,
    hp: 148,
    armor: 68,
    attackPower: 94,
    airThreat: 44,
    subThreat: 24,
    threatLabel: '超重甲炮击主力',
    weakness: 'torpedo',
    weaknessLabel: '鱼雷弱点',
    drops: ['钢材 180~260', '铝材 110~165', '银条 340~460', '金条 4~8'],
    builtIn: true,
  },
  {
    id: 'enemy_builtin_boss_flagship',
    name: '深渊核心联合旗舰',
    tier: NODE_TYPES.BOSS,
    riskLevel: '5★ 深渊核心海域',
    star: 5,
    hp: 218,
    armor: 96,
    attackPower: 138,
    airThreat: 90,
    subThreat: 55,
    threatLabel: '海空潜立体主力旗舰',
    weakness: 'torpedo',
    weaknessLabel: '鱼雷/破甲弱点',
    drops: ['钢材 220~320', '铝材 150~220', '银条 420~580', '金条 6~12'],
    builtIn: true,
  },
]);

/**
 * Featured Starter Shipgirls covering ALL core & support ship classes (DD/CL/CA/BB/CV/AR/AO)
 * calibrated to the 2-Digit Compressed Lv.1 Stat Curve (8 ~ 25).
 */
export const STARTER_PACK_SHIPGIRLS_8 = Object.freeze([
  {
    id: 'char_template_01',
    name: '示范驱逐 · 一号舰',
    shipType: '驱逐舰',
    roleTag: '高机动雷击反潜',
    stats: { maxHp: 24, hp: 24, firepower: 13, armor: 10, torpedo: 23, evasion: 24, recon: 17, aa: 15, asw: 22, morale: 80, ap: 90, maxAp: 100, affinity: 52, level: 1, exp: 0, maxExp: 100 },
  },
  {
    id: 'char_template_02',
    name: '示范轻巡 · 二号舰',
    shipType: '轻巡洋舰',
    roleTag: '均衡侦查防空',
    stats: { maxHp: 28, hp: 28, firepower: 17, armor: 15, torpedo: 18, evasion: 20, recon: 21, aa: 20, asw: 19, morale: 82, ap: 90, maxAp: 100, affinity: 42, level: 1, exp: 0, maxExp: 100 },
  },
  {
    id: 'char_template_03',
    name: '示范战列 · 三号舰',
    shipType: '战列舰',
    roleTag: '主力重炮重甲',
    stats: { maxHp: 42, hp: 42, firepower: 25, armor: 24, torpedo: 8, evasion: 11, recon: 15, aa: 20, asw: 8, morale: 78, ap: 90, maxAp: 100, affinity: 38, level: 1, exp: 0, maxExp: 100 },
  },
  {
    id: 'char_pack_ca_04',
    name: '曙光重巡 · 四号舰',
    shipType: '重巡洋舰',
    roleTag: '重甲护盾援护主力',
    stats: { maxHp: 34, hp: 34, firepower: 22, armor: 21, torpedo: 15, evasion: 16, recon: 18, aa: 18, asw: 11, morale: 80, ap: 100, maxAp: 100, affinity: 35, level: 1, exp: 0, maxExp: 100 },
  },
  {
    id: 'char_pack_cv_05',
    name: '苍穹航母 · 五号舰',
    shipType: '航空母舰',
    roleTag: '舰载机空袭与视野扩展',
    stats: { maxHp: 38, hp: 38, firepower: 21, armor: 18, torpedo: 8, evasion: 16, recon: 25, aa: 24, asw: 11, morale: 82, ap: 100, maxAp: 100, affinity: 36, level: 1, exp: 0, maxExp: 100 },
  },
  {
    id: 'char_pack_dd_06',
    name: '疾风驱逐 · 六号舰',
    shipType: '驱逐舰',
    roleTag: '高速夜战氧雷突击',
    stats: { maxHp: 23, hp: 23, firepower: 12, armor: 10, torpedo: 25, evasion: 25, recon: 17, aa: 14, asw: 23, morale: 84, ap: 100, maxAp: 100, affinity: 30, level: 1, exp: 0, maxExp: 100 },
  },
  {
    id: 'char_pack_ar_07',
    name: '明石维修 · 七号舰',
    shipType: '维修舰',
    roleTag: '战地抢修与锚地专精 (AR)',
    stats: { maxHp: 32, hp: 32, firepower: 10, armor: 18, torpedo: 8, evasion: 14, recon: 21, aa: 20, asw: 14, morale: 84, ap: 100, maxAp: 100, affinity: 34, level: 1, exp: 0, maxExp: 100 },
  },
  {
    id: 'char_pack_ao_08',
    name: '汐风补给 · 八号舰',
    shipType: '补给舰',
    roleTag: '携带油弹扩容与前线补给 (AO)',
    stats: { maxHp: 30, hp: 30, firepower: 10, armor: 16, torpedo: 8, evasion: 15, recon: 23, aa: 19, asw: 14, morale: 84, ap: 100, maxAp: 100, affinity: 34, level: 1, exp: 0, maxExp: 100 },
  },
]);

export const STARTER_PACK_ENEMIES_TIERED = Object.freeze([
  {
    id: 'enemy_pack_low_picket',
    name: '近海高速哨戒驱逐队',
    tier: NODE_TYPES.ENCOUNTER,
    star: 1,
    hp: 34,
    armor: 12,
    attackPower: 20,
    airThreat: 0,
    subThreat: 8,
    threatLabel: '1★ · 驱逐哨戒编队',
    weakness: 'shelling',
    drops: ['燃油 50', '钢材 60', '银条 120'],
  },
  {
    id: 'enemy_pack_mid_ca_cvl',
    name: '中海重巡轻航混编队',
    tier: NODE_TYPES.ELITE,
    star: 3,
    hp: 86,
    armor: 40,
    attackPower: 60,
    airThreat: 38,
    subThreat: 0,
    threatLabel: '3★ · 航空与重炮混编',
    weakness: 'torpedo',
    drops: ['铝材 95', '钢材 120', '银条 220'],
  },
  {
    id: 'enemy_pack_high_carrier_taskforce',
    name: '深海机动航母特混舰队',
    tier: NODE_TYPES.BOSS,
    star: 5,
    hp: 210,
    armor: 92,
    attackPower: 132,
    airThreat: 88,
    subThreat: 44,
    threatLabel: '5★ · 航母特混决战群',
    weakness: 'aa',
    drops: ['钢材 220', '铝材 190', '银条 420', '金条 8'],
  },
]);

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function normalizeDialogueStageKey(rawStage = 'any') {
  const s = String(rawStage || 'any').trim().toLowerCase();
  if (s === 'friendly' || s === 'familiar') return 'familiar';
  if (s === 'close' || s === 'trusted') return 'trusted';
  if (['any', 'stranger', 'flutter', 'adoration', 'oath'].includes(s)) return s;
  return 'any';
}

function createEmptyStoryBank() {
  return {
    dialogueBank: {},
    portraitTouchLines: {},
    outfitFlavorLines: {},
    favoriteGiftReactions: [],
    breakthroughTheatres: {},
    oathRitualTheatre: null,
    oathRitualTheatres: [],
  };
}

function createEmptyStoryExtensions() {
  return {
    ...createEmptyStoryBank(),
    maritimeEncounters: [],
    personalityExtensions: {},
  };
}

function createDefaultContentState() {
  return {
    customEnemies: [],
    customDialogues: [],
    customGifts: [],
    customEquipment: [],
    storyExtensions: createEmptyStoryExtensions(),
    loadedStoryPackFiles: {},
    encounteredEnemyNames: ['前哨巡逻编队'],
    clearedRouteIds: [],
    updatedAt: Date.now(),
  };
}

export class ContentManager {
  /**
   * @param {{
   *   storage: import('./storage.js').StorageManager,
   *   entities: import('./entity-system.js').EntitySystem,
   *   inventory: import('./inventory-system.js').InventorySystem,
   *   routeGenerator: import('./route-generator.js').RouteGenerator,
   *   buildings?: import('./port-buildings.js').PortBuildingsSystem | null,
   *   interaction?: import('./interaction-system.js').InteractionSystem | null,
   *   commander?: import('./commander-system.js').CommanderSystem | null,
   *   logs?: import('./log-system.js').LogSystem | null,
   *   bus?: import('./event-bus.js').EventBus | null
   * }} deps
   */
  constructor({
    storage,
    entities,
    inventory,
    routeGenerator,
    buildings = null,
    interaction = null,
    commander = null,
    logs = null,
    bus = null,
  }) {
    this._storage = storage;
    this._scope = storage.namespace(STORAGE_NS);
    this._entities = entities;
    this._inventory = inventory;
    this._routeGenerator = routeGenerator;
    this._buildings = buildings;
    this._interaction = interaction;
    this._commander = commander;
    this._logs = logs;
    this._bus = bus;

    this._state = createDefaultContentState();
    this._hydrated = false;

    if (this._bus) {
      this._bus.on('combat:started', ({ enemyName }) => {
        if (enemyName && !this._state.encounteredEnemyNames.includes(enemyName)) {
          this._state.encounteredEnemyNames.push(enemyName);
          this.persist();
        }
      });
      this._bus.on('sortie:node-resolved', ({ routeId, completed }) => {
        if (completed && routeId && !this._state.clearedRouteIds.includes(routeId)) {
          this._state.clearedRouteIds.push(routeId);
          this.persist();
        }
      });
    }
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
    } else {
      this._state = createDefaultContentState();
      await this.persist();
    }
    this._hydrated = true;
  }

  async persist() {
    this._state.updatedAt = Date.now();
    await this._scope.setLarge(STATE_KEY, this.serialize());
  }

  // ------------------------------------------------------------
  // 1. Custom Enemy Templates CRUD
  // ------------------------------------------------------------

  listCustomEnemies() {
    return deepClone(this._state.customEnemies);
  }

  async createCustomEnemy(def = {}) {
    const name = String(def.name || '').trim();
    if (!name) throw new Error('敌舰名称不能为空');
    const tier = [NODE_TYPES.ENCOUNTER, NODE_TYPES.ELITE, NODE_TYPES.BOSS].includes(def.tier)
      ? def.tier
      : NODE_TYPES.ENCOUNTER;
    const weakness = def.weakness === 'torpedo' ? 'torpedo' : 'shelling';
    const airThreat = clamp(Math.round(Number(def.airThreat) || 0), 0, 100);
    const subThreat = clamp(Math.round(Number(def.subThreat) || 0), 0, 100);
    const threatLabel =
      String(def.threatLabel || '').trim() ||
      (airThreat > 0 && subThreat > 0
        ? '海空潜立体威胁'
        : airThreat > 0
        ? '敌方航空威胁'
        : subThreat > 0
        ? '敌方水下潜艇威胁'
        : '水面主力编队');

    const enemy = {
      id: String(def.id || `enemy_cust_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`),
      name,
      tier,
      forcedEngagement: tier === NODE_TYPES.BOSS,
      hp: clamp(Math.round(Number(def.hp) || 85), 20, 2000),
      maxHp: clamp(Math.round(Number(def.hp) || 85), 20, 2000),
      armor: clamp(Math.round(Number(def.armor) || 6), 0, 100),
      attackPower: clamp(Math.round(Number(def.attackPower) || 14), 3, 120),
      airThreat,
      subThreat,
      threatLabel,
      scanDc: clamp(Math.round(Number(def.scanDc) || 13), 6, 30),
      evadeDc: clamp(Math.round(Number(def.evadeDc) || 14), 6, 30),
      shellingDc: clamp(Math.round(Number(def.shellingDc) || 13), 6, 30),
      torpedoDc: clamp(Math.round(Number(def.torpedoDc) || 15), 6, 30),
      weakness,
      weaknessLabel: weakness === 'torpedo' ? '鱼雷弱点' : '炮击弱点',
      drops: Array.isArray(def.drops)
        ? def.drops.map((d) => String(d).trim()).filter(Boolean)
        : String(def.drops || '钢材 80, 银条 150')
            .split(/[,，、]+/)
            .map((s) => s.trim())
            .filter(Boolean),
      builtIn: false,
      createdAt: Date.now(),
    };

    const idx = this._state.customEnemies.findIndex((e) => e.id === enemy.id);
    if (idx >= 0) this._state.customEnemies[idx] = enemy;
    else this._state.customEnemies.push(enemy);

    if (!this._state.encounteredEnemyNames.includes(enemy.name)) {
      this._state.encounteredEnemyNames.push(enemy.name);
    }

    await this.persist();
    this._emit('content:updated', { type: 'enemy', id: enemy.id });
    return deepClone(enemy);
  }

  async deleteCustomEnemy(enemyId) {
    const prev = this._state.customEnemies.length;
    this._state.customEnemies = this._state.customEnemies.filter((e) => e.id !== String(enemyId));
    if (this._state.customEnemies.length !== prev) {
      await this.persist();
      this._emit('content:updated', { type: 'enemy-deleted', id: enemyId });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------
  // 2. Custom Interaction Dialogue Templates CRUD
  // ------------------------------------------------------------

  listCustomDialogues() {
    return deepClone(this._state.customDialogues);
  }

  _upsertCustomDialogueSync({ id = null, stage = 'any', text = '', personalityId = null, secondaryId = null } = {}) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return null;
    const normStage = normalizeDialogueStageKey(stage);
    const cleanPid = personalityId ? String(personalityId).trim() : null;
    const cleanSid = secondaryId ? String(secondaryId).trim() : null;
    const dlg = {
      id: String(id || `dlg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`),
      stage: normStage,
      text: cleanText,
      ...(cleanPid ? { personalityId: cleanPid } : {}),
      ...(cleanSid ? { secondaryId: cleanSid } : {}),
      createdAt: Date.now(),
    };
    const idx = this._state.customDialogues.findIndex(
      (d) => d.id === dlg.id || (d.text === dlg.text && (d.personalityId || null) === (dlg.personalityId || null))
    );
    if (idx >= 0) this._state.customDialogues[idx] = dlg;
    else this._state.customDialogues.push(dlg);
    return dlg;
  }

  async createCustomDialogue({ id = null, stage = 'any', text = '', personalityId = null, secondaryId = null } = {}) {
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('台词模板内容不能为空');
    const dlg = this._upsertCustomDialogueSync({ id, stage, text: cleanText, personalityId, secondaryId });
    await this.persist();
    this._emit('content:updated', { type: 'dialogue', id: dlg.id });
    return deepClone(dlg);
  }

  async deleteCustomDialogue(dialogueId) {
    const prev = this._state.customDialogues.length;
    this._state.customDialogues = this._state.customDialogues.filter((d) => d.id !== String(dialogueId));
    if (this._state.customDialogues.length !== prev) {
      await this.persist();
      this._emit('content:updated', { type: 'dialogue-deleted', id: dialogueId });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------
  // 2B. Extended Story Engine Banks (dialogueBank, portraitTouchLines,
  //     outfitFlavorLines, favoriteGiftReactions, breakthroughTheatres,
  //     oathRitualTheatre/oathRitualTheatres, maritimeEncounters,
  //     and per-personality isolated personalityExtensions)
  // ------------------------------------------------------------

  getStoryExtensions() {
    if (!this._state.storyExtensions || typeof this._state.storyExtensions !== 'object') {
      this._state.storyExtensions = createEmptyStoryExtensions();
    }
    if (!this._state.storyExtensions.personalityExtensions || typeof this._state.storyExtensions.personalityExtensions !== 'object') {
      this._state.storyExtensions.personalityExtensions = {};
    }
    if (!Array.isArray(this._state.storyExtensions.oathRitualTheatres)) {
      this._state.storyExtensions.oathRitualTheatres = this._state.storyExtensions.oathRitualTheatre
        ? [deepClone(this._state.storyExtensions.oathRitualTheatre)]
        : [];
    }
    return deepClone(this._state.storyExtensions);
  }

  getPersonalityStoryExtensions(personalityId) {
    const pid = String(personalityId || '').trim();
    if (!pid) return null;
    const ext = this._state.storyExtensions;
    const pBank = ext?.personalityExtensions?.[pid];
    return pBank ? deepClone(pBank) : null;
  }

  mergeStoryExtensions(rawExt = {}, { personalityId = null } = {}) {
    if (!rawExt || typeof rawExt !== 'object') return 0;
    if (!this._state.storyExtensions || typeof this._state.storyExtensions !== 'object') {
      this._state.storyExtensions = createEmptyStoryExtensions();
    }
    const ext = this._state.storyExtensions;
    if (!ext.personalityExtensions || typeof ext.personalityExtensions !== 'object') {
      ext.personalityExtensions = {};
    }
    if (!Array.isArray(ext.oathRitualTheatres)) {
      ext.oathRitualTheatres = ext.oathRitualTheatre ? [deepClone(ext.oathRitualTheatre)] : [];
    }

    let mergedCount = 0;

    const resolveTargetBank = (pid = null) => {
      const cleanPid = String(pid || '').trim();
      if (!cleanPid) return ext;
      if (!ext.personalityExtensions[cleanPid] || typeof ext.personalityExtensions[cleanPid] !== 'object') {
        ext.personalityExtensions[cleanPid] = createEmptyStoryBank();
      }
      const pBank = ext.personalityExtensions[cleanPid];
      if (!Array.isArray(pBank.oathRitualTheatres)) {
        pBank.oathRitualTheatres = pBank.oathRitualTheatre ? [deepClone(pBank.oathRitualTheatre)] : [];
      }
      return pBank;
    };

    const mergeSingleStoryBank = (bankObj, forcedPid = null) => {
      if (!bankObj || typeof bankObj !== 'object') return;
      const bankDefaultPid = String(forcedPid || bankObj.personalityId || '').trim() || null;

      // Optional nested customDialogues inside a personality bank
      if (Array.isArray(bankObj.customDialogues)) {
        for (const d of bankObj.customDialogues) {
          const line = typeof d === 'string' ? d : d?.text || d?.line || d?.content;
          if (!line) continue;
          const itemPid = (typeof d === 'object' && d?.personalityId) || bankDefaultPid;
          const saved = this._upsertCustomDialogueSync({
            ...(typeof d === 'object' ? d : {}),
            text: line,
            personalityId: itemPid,
          });
          if (saved) mergedCount += 1;
        }
      }

      // 1. Six-stage x day/night dialogueBank (supports familiar/friendly and trusted/close aliases)
      if (bankObj.dialogueBank && typeof bankObj.dialogueBank === 'object') {
        const rawStageMap = [
          ['stranger', 'stranger'],
          ['familiar', 'familiar'],
          ['friendly', 'familiar'],
          ['trusted', 'trusted'],
          ['close', 'trusted'],
          ['flutter', 'flutter'],
          ['adoration', 'adoration'],
          ['oath', 'oath'],
        ];
        for (const [rawKey, stageKey] of rawStageMap) {
          const srcStage = bankObj.dialogueBank[rawKey];
          if (!srcStage || typeof srcStage !== 'object') continue;
          for (const tod of ['day', 'night']) {
            const arr = Array.isArray(srcStage[tod]) ? srcStage[tod] : [];
            for (const entry of arr) {
              if (!entry || typeof entry !== 'object') continue;
              const textVal = String(entry.text || entry.line || entry.content || '').trim();
              if (!textVal) continue;
              const itemPid = String(forcedPid || entry.personalityId || bankDefaultPid || '').trim() || null;
              const targetBank = resolveTargetBank(itemPid);
              if (!targetBank.dialogueBank[stageKey]) {
                targetBank.dialogueBank[stageKey] = { day: [], night: [] };
              }
              const dest = targetBank.dialogueBank[stageKey][tod];
              const norm = {
                ...(itemPid ? { personalityId: itemPid } : {}),
                narration: String(entry.narration || '').trim(),
                text: textVal,
                ...(Array.isArray(entry.choices) && entry.choices.length > 0
                  ? {
                      choices: entry.choices
                        .filter((c) => c && (c.label || c.reply || c.text || c.line))
                        .map((c) => ({
                          label: String(c.label || '').trim(),
                          narration: String(c.narration || '').trim(),
                          reply: String(c.reply || c.text || c.line || c.resultText || '').trim(),
                        })),
                    }
                  : {}),
              };
              const existIdx = dest.findIndex((x) => x.text === norm.text);
              if (existIdx >= 0) dest[existIdx] = norm;
              else dest.push(norm);
              mergedCount += 1;
            }
          }
        }
      }

      // 2. Portrait touch reactions (head / shoulder / hand x low / mid / high / oath)
      if (bankObj.portraitTouchLines && typeof bankObj.portraitTouchLines === 'object') {
        for (const zone of ['head', 'shoulder', 'hand']) {
          const srcZone = bankObj.portraitTouchLines[zone];
          if (!srcZone || typeof srcZone !== 'object') continue;
          for (const band of ['low', 'mid', 'high', 'oath']) {
            const arr = Array.isArray(srcZone[band]) ? srcZone[band] : [];
            for (const item of arr) {
              if (!item || typeof item !== 'object') continue;
              const textVal = String(item.text || item.line || item.content || '').trim();
              if (!textVal) continue;
              const itemPid = String(forcedPid || item.personalityId || bankDefaultPid || '').trim() || null;
              const targetBank = resolveTargetBank(itemPid);
              if (!targetBank.portraitTouchLines[zone]) {
                targetBank.portraitTouchLines[zone] = { low: [], mid: [], high: [], oath: [] };
              }
              const dest = targetBank.portraitTouchLines[zone][band];
              const norm = {
                ...(itemPid ? { personalityId: itemPid } : {}),
                narration: String(item.narration || '').trim(),
                text: textVal,
              };
              const existIdx = dest.findIndex((x) => x.text === norm.text);
              if (existIdx >= 0) dest[existIdx] = norm;
              else dest.push(norm);
              mergedCount += 1;
            }
          }
        }
      }

      // 3. Outfit flavor lines (outfitStyle -> array of { narration, text })
      if (bankObj.outfitFlavorLines && typeof bankObj.outfitFlavorLines === 'object') {
        for (const [styleKey, val] of Object.entries(bankObj.outfitFlavorLines)) {
          const key = String(styleKey || '').trim();
          if (!key || !val) continue;
          const list = Array.isArray(val) ? val : [val];
          for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const textVal = String(item.text || item.line || item.content || '').trim();
            if (!textVal) continue;
            const itemPid = String(forcedPid || item.personalityId || bankDefaultPid || '').trim() || null;
            const targetBank = resolveTargetBank(itemPid);
            if (!Array.isArray(targetBank.outfitFlavorLines[key])) {
              targetBank.outfitFlavorLines[key] = [];
            }
            const dest = targetBank.outfitFlavorLines[key];
            const norm = {
              ...(itemPid ? { personalityId: itemPid } : {}),
              narration: String(item.narration || '').trim(),
              text: textVal,
            };
            const existIdx = dest.findIndex((x) => x.text === norm.text);
            if (existIdx >= 0) dest[existIdx] = norm;
            else dest.push(norm);
            mergedCount += 1;
          }
        }
      }

      // 4. Favorite gift reactions (array OR object keyed by giftId)
      if (bankObj.favoriteGiftReactions && typeof bankObj.favoriteGiftReactions === 'object') {
        let rawGiftList = [];
        if (Array.isArray(bankObj.favoriteGiftReactions)) {
          rawGiftList = bankObj.favoriteGiftReactions;
        } else {
          for (const [gKey, gVal] of Object.entries(bankObj.favoriteGiftReactions)) {
            const arr = Array.isArray(gVal) ? gVal : [gVal];
            for (const it of arr) {
              if (it && typeof it === 'object') {
                rawGiftList.push({ giftId: it.giftId || gKey, ...it });
              }
            }
          }
        }
        for (const item of rawGiftList) {
          if (!item || typeof item !== 'object') continue;
          const textVal = String(item.text || item.line || item.content || '').trim();
          if (!textVal) continue;
          const itemPid = String(forcedPid || item.personalityId || bankDefaultPid || '').trim() || null;
          const targetBank = resolveTargetBank(itemPid);
          if (!Array.isArray(targetBank.favoriteGiftReactions)) {
            targetBank.favoriteGiftReactions = [];
          }
          const dest = targetBank.favoriteGiftReactions;
          const norm = {
            ...(itemPid ? { personalityId: itemPid } : {}),
            ...(item.giftId ? { giftId: String(item.giftId).trim() } : {}),
            ...(item.giftName ? { giftName: String(item.giftName).trim() } : {}),
            narration: String(item.narration || '').trim(),
            text: textVal,
          };
          const existIdx = dest.findIndex((x) => x.text === norm.text && (x.giftId || '') === (norm.giftId || ''));
          if (existIdx >= 0) dest[existIdx] = norm;
          else dest.push(norm);
          mergedCount += 1;
        }
      }

      // 5. Stage breakthrough mini-theatres (20 / 40 / 60 / 80 / 100)
      if (bankObj.breakthroughTheatres && typeof bankObj.breakthroughTheatres === 'object') {
        for (const gate of [20, 40, 60, 80, 100]) {
          const rawVal = bankObj.breakthroughTheatres[gate] ?? bankObj.breakthroughTheatres[String(gate)];
          if (!rawVal) continue;
          const list = Array.isArray(rawVal) ? rawVal : [rawVal];
          const gk = String(gate);
          for (const t of list) {
            if (!t || typeof t !== 'object') continue;
            const openingLine = String(t.openingLine || t.text || t.line || '').trim();
            if (!openingLine || !Array.isArray(t.choices) || t.choices.length === 0) continue;
            const itemPid = String(forcedPid || t.personalityId || bankDefaultPid || '').trim() || null;
            const targetBank = resolveTargetBank(itemPid);
            if (!Array.isArray(targetBank.breakthroughTheatres[gk])) {
              targetBank.breakthroughTheatres[gk] = [];
            }
            const dest = targetBank.breakthroughTheatres[gk];
            const norm = {
              ...(itemPid ? { personalityId: itemPid } : {}),
              gate,
              fromLabel: String(t.fromLabel || '').trim(),
              toLabel: String(t.toLabel || '').trim(),
              title: String(t.title || `阶段突破 · ${gate}`).trim(),
              introNarration: String(t.introNarration || t.narration || '').trim(),
              openingLine,
              choices: t.choices
                .filter((c) => c && String(c.label || '').trim())
                .map((c, idx) => ({
                  id: String(c.id || `bt${gate}_${itemPid || 'ext'}_${idx + 1}`),
                  label: String(c.label || '').trim(),
                  narration: String(c.narration || '').trim(),
                  reply: String(c.reply || c.text || c.line || '').trim(),
                  closingNarration: String(c.closingNarration || '').trim(),
                })),
            };
            if (norm.choices.length === 0) continue;
            const existIdx = dest.findIndex((x) => x.title === norm.title && x.openingLine === norm.openingLine);
            if (existIdx >= 0) dest[existIdx] = norm;
            else dest.push(norm);
            mergedCount += 1;
          }
        }
      }

      // 6. Custom Oath Ritual Theatre(s) (supports both oathRitualTheatre and oathRitualTheatres)
      const oathCandidates = [];
      if (Array.isArray(bankObj.oathRitualTheatres)) {
        oathCandidates.push(...bankObj.oathRitualTheatres);
      }
      if (bankObj.oathRitualTheatre && typeof bankObj.oathRitualTheatre === 'object') {
        if (Array.isArray(bankObj.oathRitualTheatre)) {
          oathCandidates.push(...bankObj.oathRitualTheatre);
        } else {
          oathCandidates.push(bankObj.oathRitualTheatre);
        }
      }
      for (const r of oathCandidates) {
        if (!r || typeof r !== 'object') continue;
        const openingLine = String(r.openingLine || r.text || r.line || '').trim();
        if (!openingLine || !Array.isArray(r.choices) || r.choices.length === 0) continue;
        const itemPid = String(forcedPid || r.personalityId || bankDefaultPid || '').trim() || null;
        const targetBank = resolveTargetBank(itemPid);
        const normOath = {
          ...(itemPid ? { personalityId: itemPid } : {}),
          title: String(r.title || '誓约仪式').trim(),
          introNarration: String(r.introNarration || r.narration || '').trim(),
          openingLine,
          choices: r.choices
            .filter((c) => c && String(c.label || '').trim())
            .map((c, idx) => ({
              id: String(c.id || `oath_${itemPid || 'ext'}_${idx + 1}`),
              label: String(c.label || '').trim(),
              oathTitle: String(c.oathTitle || '永恒誓约').trim(),
              narration: String(c.narration || '').trim(),
              reply: String(c.reply || c.text || c.line || '').trim(),
              closingNarration: String(c.closingNarration || '').trim(),
            })),
        };
        if (normOath.choices.length === 0) continue;
        targetBank.oathRitualTheatre = normOath;
        if (!Array.isArray(targetBank.oathRitualTheatres)) {
          targetBank.oathRitualTheatres = [];
        }
        const existIdx = targetBank.oathRitualTheatres.findIndex(
          (x) => x.title === normOath.title && x.openingLine === normOath.openingLine
        );
        if (existIdx >= 0) targetBank.oathRitualTheatres[existIdx] = normOath;
        else targetBank.oathRitualTheatres.push(normOath);
        mergedCount += 1;
      }
    };

    // A. Merge top-level banks (respecting optional personalityId or item-level personalityId)
    const topPid = String(personalityId || rawExt.personalityId || '').trim() || null;
    mergeSingleStoryBank(rawExt, topPid);

    // B. Merge per-personality isolated banks under `personalityExtensions`
    if (rawExt.personalityExtensions && typeof rawExt.personalityExtensions === 'object') {
      for (const [pidKey, pBankObj] of Object.entries(rawExt.personalityExtensions)) {
        const cleanPid = String(pidKey || '').trim();
        if (!cleanPid || !pBankObj || typeof pBankObj !== 'object') continue;
        mergeSingleStoryBank(pBankObj, cleanPid);
      }
    }

    // C. Maritime encounters (universal sea chart encounter pool)
    if (Array.isArray(rawExt.maritimeEncounters)) {
      if (!Array.isArray(ext.maritimeEncounters)) ext.maritimeEncounters = [];
      for (const enc of rawExt.maritimeEncounters) {
        if (!enc || typeof enc !== 'object' || !String(enc.body || enc.text || '').trim()) continue;
        const norm = {
          id: String(enc.id || `sea_enc_ext_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`),
          title: String(enc.title || '海面奇遇').trim(),
          speaker: String(enc.speaker || '{actor}').trim(),
          body: String(enc.body || enc.text || '').trim(),
          choices: Array.isArray(enc.choices)
            ? enc.choices
                .filter((c) => c && String(c.label || '').trim())
                .map((c, idx) => ({
                  id: String(c.id || `me_ext_${idx + 1}`),
                  label: String(c.label || '').trim(),
                  statKey: c.statKey || null,
                  dc: Number(c.dc) || 0,
                  successText: String(c.successText || c.resultText || '').trim(),
                  failText: String(c.failText || '').trim(),
                  reward: c.reward && typeof c.reward === 'object' ? deepClone(c.reward) : {},
                  affinity: Number(c.affinity) || 2,
                  morale: Number(c.morale) || 10,
                }))
            : [],
        };
        if (norm.choices.length === 0) continue;
        const existIdx = ext.maritimeEncounters.findIndex((x) => x.id === norm.id || x.title === norm.title);
        if (existIdx >= 0) ext.maritimeEncounters[existIdx] = norm;
        else ext.maritimeEncounters.push(norm);
        mergedCount += 1;
      }
    }

    return mergedCount;
  }

  /**
   * Auto-load bundled external story packs declared in `custom-packs/stories/index.json`.
   * Tracks `file -> version` so each version is imported once non-destructively (never resurrects
   * user-deleted packs or overwrites saves; safely no-ops offline or when manifest is absent).
   */
  async syncStoryPackManifest(
    manifestUrl = './custom-packs/stories/index.json',
    { storyPacks = null, personalityPool = null, statRules = null, fetchImpl = null, force = false } = {}
  ) {
    const fetcher = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetcher) return { loaded: 0, skipped: 0, failed: 0, totalEntries: 0 };
    if (!this._state.loadedStoryPackFiles || typeof this._state.loadedStoryPackFiles !== 'object') {
      this._state.loadedStoryPackFiles = {};
    }

    let manifest;
    try {
      const resp = await fetcher(manifestUrl, { cache: 'no-cache' });
      if (!resp || !resp.ok) return { loaded: 0, skipped: 0, failed: 1, totalEntries: 0 };
      manifest = await resp.json();
    } catch {
      return { loaded: 0, skipped: 0, failed: 1, totalEntries: 0 };
    }

    const entries = Array.isArray(manifest?.packs) ? manifest.packs : Array.isArray(manifest) ? manifest : [];
    const baseDir = manifestUrl.replace(/[^/]+$/, '');
    let loaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const entry of entries) {
      if (!entry || entry.enabled === false || !entry.file) continue;
      const fileKey = String(entry.file).trim();
      const ver = String(entry.version || '1.0.0').trim();
      if (!force && this._state.loadedStoryPackFiles[fileKey] === ver) {
        skipped += 1;
        continue;
      }
      try {
        const packUrl = fileKey.startsWith('./') || fileKey.startsWith('/') || /^https?:\/\//i.test(fileKey)
          ? fileKey
          : `${baseDir}${fileKey}`;
        const packResp = await fetcher(packUrl, { cache: 'no-cache' });
        if (!packResp || !packResp.ok) {
          failed += 1;
          continue;
        }
        const rawText = await packResp.text();
        await this.smartImportJSONText(rawText, { mode: 'merge', storyPacks, personalityPool, statRules });
        this._state.loadedStoryPackFiles[fileKey] = ver;
        loaded += 1;
      } catch (err) {
        failed += 1;
        console.warn(`[ContentManager] Failed to auto-load story pack "${fileKey}":`, err);
      }
    }

    if (loaded > 0) {
      await this.persist();
    }
    return { loaded, skipped, failed, totalEntries: entries.length };
  }

  // ------------------------------------------------------------
  // 3. Custom Gifts CRUD
  // ------------------------------------------------------------

  listCustomGifts() {
    return deepClone(this._state.customGifts);
  }

  async createCustomGift(def = {}) {
    const name = String(def.name || '').trim();
    if (!name) throw new Error('礼物名称不能为空');
    const gift = {
      id: String(def.id || `gift_cust_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`),
      name,
      currency: def.currency === 'gold' ? 'gold' : 'silver',
      price: clamp(Math.round(Number(def.price ?? 50)), 0, 99999),
      affinityGain: clamp(Math.round(Number(def.affinityGain ?? 8)), 1, 100),
      moraleGain: clamp(Math.round(Number(def.moraleGain ?? 10)), 0, 100),
      description: String(def.description || '玩家自定义的港区好感礼物。').trim(),
      custom: true,
      createdAt: Date.now(),
    };
    const idx = this._state.customGifts.findIndex((g) => g.id === gift.id);
    if (idx >= 0) this._state.customGifts[idx] = gift;
    else this._state.customGifts.push(gift);

    await this.persist();
    this._emit('content:updated', { type: 'gift', id: gift.id });
    return deepClone(gift);
  }

  async deleteCustomGift(giftId) {
    const prev = this._state.customGifts.length;
    this._state.customGifts = this._state.customGifts.filter((g) => g.id !== String(giftId));
    if (this._state.customGifts.length !== prev) {
      await this.persist();
      this._emit('content:updated', { type: 'gift-deleted', id: giftId });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------
  // 3B. Custom Equipment & Outfit Templates CRUD + Issue to Warehouse
  // ------------------------------------------------------------

  listCustomEquipment() {
    return deepClone(this._state.customEquipment || []);
  }

  async saveCustomEquipmentTemplate(tpl = {}) {
    const name = String(tpl.name || '').trim();
    if (!name) throw new Error('装备/服装名称不能为空');
    const category = Object.values(ITEM_CATEGORIES).includes(tpl.category)
      ? tpl.category
      : ITEM_CATEGORIES.EXTENSION;
    const bonuses = Array.isArray(tpl.bonuses)
      ? tpl.bonuses
          .filter((b) => b && b.stat && Number.isFinite(Number(b.value)) && Number(b.value) !== 0)
          .map((b) => ({
            stat: String(b.stat).trim(),
            layer: b.layer || (b.stat === 'checkBonus' ? 'flatFinal' : 'baseAdd'),
            value: Number(b.value),
          }))
      : [];
    const now = Date.now();
    const record = {
      id: String(tpl.id || `eq_tpl_${now.toString(36)}_${Math.random().toString(36).slice(2, 5)}`).trim(),
      name,
      category,
      subGroup: String(tpl.subGroup || (category === ITEM_CATEGORIES.OUTFIT ? 'outfit' : 'weapon')),
      subCategory: String(tpl.subCategory || category),
      rarity: tpl.rarity ? normalizeRarity(tpl.rarity) : inferItemRarity({ name, bonuses }),
      iconKey: String(tpl.iconKey || tpl.subCategory || category),
      outfitStyle: category === ITEM_CATEGORIES.OUTFIT ? String(tpl.outfitStyle || '').trim() : '',
      description: String(tpl.description || '').trim(),
      tags: Array.isArray(tpl.tags)
        ? tpl.tags.map((t) => String(t).trim()).filter(Boolean)
        : String(tpl.tags || '')
            .split(/[,，\s]+/)
            .map((t) => t.trim())
            .filter(Boolean),
      bonuses,
      custom: true,
      updatedAt: now,
    };

    if (!Array.isArray(this._state.customEquipment)) this._state.customEquipment = [];
    const idx = this._state.customEquipment.findIndex((e) => e.id === record.id);
    if (idx >= 0) this._state.customEquipment[idx] = record;
    else this._state.customEquipment.unshift(record);

    await this.persist();
    this._emit('content:updated', { type: 'equipment-saved', id: record.id });
    return deepClone(record);
  }

  async deleteCustomEquipmentTemplate(tplId) {
    const list = this._state.customEquipment || [];
    const prev = list.length;
    this._state.customEquipment = list.filter((e) => e.id !== String(tplId));
    if (this._state.customEquipment.length !== prev) {
      await this.persist();
      this._emit('content:updated', { type: 'equipment-deleted', id: tplId });
      return true;
    }
    return false;
  }

  async issueEquipmentToWarehouse(templateId, quantity = 1) {
    if (!this._inventory) throw new Error('仓库系统未就绪');
    const tpl = (this._state.customEquipment || []).find((e) => e.id === String(templateId));
    if (!tpl) throw new Error('未找到对应的自定义装备/服装模板');
    const count = Math.max(1, Math.min(10, Math.floor(Number(quantity) || 1)));
    const created = [];
    for (let i = 0; i < count; i++) {
      const inst = await this._inventory.createItem({
        name: tpl.name,
        category: tpl.category,
        subGroup: tpl.subGroup,
        subCategory: tpl.subCategory,
        rarity: tpl.rarity,
        iconKey: tpl.iconKey,
        outfitStyle: tpl.outfitStyle || '',
        tags: [...(tpl.tags || []), '自定义'],
        description: tpl.description || '',
        bonuses: deepClone(tpl.bonuses || []),
        quantity: 1,
        level: 0,
      });
      created.push(inst);
    }
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.EQUIPMENT,
        title: `工坊发放自定义${tpl.category === ITEM_CATEGORIES.OUTFIT ? '服装' : '装备'}「${tpl.name}」×${count}`,
        detail: `品级：${tpl.rarity} · 已入库`,
      });
    }
    return created;
  }

  // ------------------------------------------------------------
  // 4. Full-Spectrum Compendium Aggregation
  // ------------------------------------------------------------

  getCompendiumReport() {
    const chars = this._entities?.list({ kind: 'character' }) || [];
    const items = this._inventory?.listItems() || [];
    const customEqs = this.listCustomEquipment();
    const routes = this._routeGenerator?.listAllRoutes() || [];
    const allEnemies = [...deepClone(BUILTIN_ENEMY_ARCHIVE), ...this.listCustomEnemies()];
    const encounteredSet = new Set(this._state.encounteredEnemyNames || []);
    const clearedSet = new Set(this._state.clearedRouteIds || []);

    const shipgirls = chars.map((c) => {
      const eff = this._entities.getEffectiveStats(c.id, { round: 'round' });
      const sw = this._inventory.checkSeaworthiness(c.id);
      const oath = this._interaction ? this._interaction.getOathRecord(c.id) : null;
      return {
        id: c.id,
        name: c.name,
        shipType: c.meta?.shipType || '驱逐舰',
        roleTag: c.meta?.roleTag || '',
        seaworthy: sw.seaworthy,
        oathed: Boolean(oath),
        oathTitle: oath?.oathTitle || null,
        affinity: Math.round(Number(c.stats.affinity ?? 0)),
        stats: {
          maxHp: Math.round(Number(eff.maxHp ?? c.stats.maxHp ?? 90)),
          firepower: Math.round(Number(eff.firepower ?? 0)),
          armor: Math.round(Number(eff.armor ?? 0)),
          torpedo: Math.round(Number(eff.torpedo ?? 0)),
          evasion: Math.round(Number(eff.evasion ?? 0)),
          recon: Math.round(Number(eff.recon ?? 0)),
          aa: Math.round(Number(eff.aa ?? 0)),
          asw: Math.round(Number(eff.asw ?? 0)),
        },
        unlocked: true,
      };
    });

    const equipment = items.map((it) => ({
      id: it.id,
      name: it.name,
      category: it.category,
      subGroup: it.subGroup || '',
      subCategory: it.subCategory || it.category,
      categoryLabel: ITEM_CATEGORY_LABELS[it.category] || it.category,
      rarity: inferItemRarity(it),
      iconKey: it.iconKey || '',
      outfitStyle: it.outfitStyle || '',
      level: it.level || 0,
      quantity: it.quantity || 0,
      description: it.description || '',
      bonuses: deepClone(it.bonuses || []),
      unlocked: true,
    }));

    const enemies = allEnemies.map((e) => ({
      ...e,
      unlocked: !e.builtIn || encounteredSet.has(e.name),
    }));

    const routeEntries = routes.map((r) => ({
      id: r.id,
      name: r.name,
      difficultyLabel: r.difficultyLabel || r.difficulty || '标准',
      nodeCount: Array.isArray(r.nodes) ? r.nodes.length : 0,
      builtIn: Boolean(r.builtIn),
      cleared: clearedSet.has(r.id),
      unlocked: true,
      description: r.description || '',
      seaConditionLabel: r.seaCondition?.label || '标准',
    }));

    const stats = {
      shipgirls: { unlocked: shipgirls.length, total: Math.max(shipgirls.length, 3) },
      equipment: { unlocked: equipment.length, total: Math.max(equipment.length, 8) },
      enemies: {
        unlocked: enemies.filter((e) => e.unlocked).length,
        total: enemies.length,
      },
      routes: {
        unlocked: routeEntries.length,
        cleared: routeEntries.filter((r) => r.cleared).length,
        total: routeEntries.length,
      },
    };

    const totalUnlocked =
      stats.shipgirls.unlocked + stats.equipment.unlocked + stats.enemies.unlocked + stats.routes.unlocked;
    const totalAll = Math.max(
      1,
      stats.shipgirls.total + stats.equipment.total + stats.enemies.total + stats.routes.total
    );

    return {
      overallRate: Math.min(100, Math.round((totalUnlocked / totalAll) * 100)),
      totalUnlocked,
      totalAll,
      stats,
      shipgirls,
      equipment,
      customEquipment: customEqs,
      enemies,
      routes: routeEntries,
    };
  }

  // ------------------------------------------------------------
  // 5. Full World JSON Mod Export & Import
  // ------------------------------------------------------------

  exportWorldMod({ name = '自定义港区世界模组包', author = '' } = {}) {
    const characters = (this._entities?.list({ kind: 'character' }) || []).map((e) => ({
      id: e.id,
      kind: 'character',
      name: e.name,
      tags: [...(e.tags || [])],
      stats: { ...(e.stats || {}) },
      statBounds: deepClone(e.statBounds || {}),
      meta: deepClone(e.meta || {}),
    }));

    return {
      schema: WORLD_MOD_SCHEMA,
      exportedAt: new Date().toISOString(),
      modMeta: {
        name: String(name || '自定义港区世界模组包'),
        author: String(author || this._commander?.getProfile()?.name || '指挥官'),
      },
      payload: {
        characters,
        inventory: this._inventory ? this._inventory.serialize() : null,
        buildings: this._buildings ? this._buildings.serialize() : null,
        customRoutes: this._routeGenerator ? this._routeGenerator.listCustomRoutes() : [],
        customEnemies: this.listCustomEnemies(),
        customDialogues: this.listCustomDialogues(),
        customGifts: this.listCustomGifts(),
        customEquipment: this.listCustomEquipment(),
        storyExtensions: this.getStoryExtensions(),
        oaths: this._interaction ? this._interaction.getAllOaths() : {},
      },
    };
  }

  async importWorldMod(rawInput, { mode = 'merge' } = {}) {
    const parsed = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
    if (!parsed || typeof parsed !== 'object' || !parsed.payload) {
      throw new Error('无效的世界模组 JSON 格式（缺少 payload 字段）');
    }
    const p = parsed.payload;
    const isReplace = mode === 'replace';
    const counts = {
      characters: 0,
      items: 0,
      buildings: 0,
      routes: 0,
      enemies: 0,
      dialogues: 0,
      gifts: 0,
      customEquipment: 0,
      storyExtensions: 0,
    };

    // 1. Characters
    if (Array.isArray(p.characters) && p.characters.length > 0 && this._entities) {
      if (isReplace) {
        for (const old of this._entities.list({ kind: 'character' })) {
          this._entities.remove(old.id);
        }
      }
      for (const ch of p.characters) {
        if (ch && ch.id && ch.name) {
          this._entities.register({ ...ch, kind: 'character' });
          counts.characters += 1;
        }
      }
    }

    // 2. Inventory items
    if (p.inventory && this._inventory) {
      if (isReplace) {
        this._inventory.deserialize(p.inventory, { persist: true });
        counts.items = (p.inventory.items || []).length;
      } else if (Array.isArray(p.inventory.items)) {
        for (const it of p.inventory.items) {
          if (!it || !it.id) continue;
          if (!this._inventory.getItem(it.id)) {
            await this._inventory.createItem(it);
          } else {
            await this._inventory.updateItem(it.id, it);
          }
          counts.items += 1;
        }
      }
      this._inventory.syncAllCharacters();
    }

    // 3. Buildings
    if (p.buildings && this._buildings) {
      if (isReplace) {
        this._buildings.deserialize(p.buildings, { persist: true });
        counts.buildings = (p.buildings.customBuildings || []).length;
      } else if (Array.isArray(p.buildings.customBuildings)) {
        for (const b of p.buildings.customBuildings) {
          if (!b || !b.name) continue;
          if (this._buildings.getCustomBuilding(b.id)) {
            await this._buildings.updateCustomBuilding(b.id, b);
          } else {
            await this._buildings.createCustomBuilding({ ...b, chargeBuildCost: false });
          }
          counts.buildings += 1;
        }
      }
    }

    // 4. Custom Routes
    if (Array.isArray(p.customRoutes) && this._routeGenerator) {
      for (const r of p.customRoutes) {
        if (r && r.name && Array.isArray(r.nodes)) {
          await this._routeGenerator.saveCustomRoute(r);
          counts.routes += 1;
        }
      }
    }

    // 5. Custom Enemies, Dialogues, Gifts, Equipment Templates & Story Extensions
    if (isReplace) {
      this._state.customEnemies = [];
      this._state.customDialogues = [];
      this._state.customGifts = [];
      this._state.customEquipment = [];
      this._state.storyExtensions = createEmptyStoryExtensions();
    }
    if (Array.isArray(p.customEnemies)) {
      for (const e of p.customEnemies) {
        if (e && e.name) {
          await this.createCustomEnemy(e);
          counts.enemies += 1;
        }
      }
    }
    if (Array.isArray(p.customDialogues)) {
      for (const d of p.customDialogues) {
        if (d && d.text) {
          await this.createCustomDialogue(d);
          counts.dialogues += 1;
        }
      }
    }
    if (Array.isArray(p.customGifts)) {
      for (const g of p.customGifts) {
        if (g && g.name) {
          await this.createCustomGift(g);
          counts.gifts += 1;
        }
      }
    }
    if (Array.isArray(p.customEquipment)) {
      for (const eq of p.customEquipment) {
        if (eq && eq.name) {
          await this.saveCustomEquipmentTemplate(eq);
          counts.customEquipment += 1;
        }
      }
    }
    if (p.storyExtensions && typeof p.storyExtensions === 'object') {
      counts.storyExtensions += this.mergeStoryExtensions(p.storyExtensions);
    }

    await this.persist();
    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        title: `导入世界内容模组（${isReplace ? '覆盖模式' : '合并模式'}）`,
        detail: `角色 ${counts.characters} / 物品 ${counts.items} / 自定义建筑 ${counts.buildings} / 敌舰 ${counts.enemies} / 台词 ${counts.dialogues} / 礼物 ${counts.gifts}`,
      });
    }
    this._emit('content:mod-imported', { mode, counts });
    return counts;
  }

  /**
   * Smart Adaptive JSON Field Normalizer & Importer:
   * Automatically strips optional Markdown ```json fences and adapts common schema variants
   * (full bundle object, bare array `[...]`, or single item object `{...}`):
   *   - Personalities & Dialogue Pools: `personalities` / `personalityPool` / `personas` / `archetypes`
   *     with full dialogue category alias mapping (`secretary_idle`/`idle`/`daily`, `secretary_night`/`night`, etc.)
   *   - Secondary Traits: `traits` / `subTraits` / `quirks` with `idleLines` / `lines` / `dialogues`
   *   - Events & Story Packs: `events` / `storyPacks` / `stories` / `chapters` / `packs`
   *     with `scenes`/`nodes`/`steps`/`dialogues`, `speaker`/`name`/`character`, `text`/`content`/`line`,
   *     `choices`/`options`/`branches`, `nextText`/`reply`, and `nextNodeId`/`nextSceneId`
   *   - Extended Story Engine Banks: `dialogueBank`, `portraitTouchLines`, `outfitFlavorLines`,
   *     `favoriteGiftReactions`, `breakthroughTheatres`, `oathRitualTheatre`, `maritimeEncounters`
   *   - Ships & Equipment/Outfits: `ships`/`characters`, `equipments`/`equipment`/`outfits`/`items`
   *     with automatic Chinese/English rarity normalization (`白/绿/蓝/紫/橙` or `common..legendary`).
   */
  async smartImportJSONText(
    rawInput,
    { mode = 'merge', storyPacks = null, personalityPool = null, statRules = null } = {}
  ) {
    const text =
      typeof rawInput === 'string'
        ? rawInput.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        : '';
    let parsed;
    if (typeof rawInput === 'string') {
      if (!text) throw new Error('请先粘贴需要导入的 JSON 文本内容');
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error(`JSON 语法解析失败：${err instanceof Error ? err.message : '请检查括号、引号与逗号格式'}`);
      }
    } else {
      parsed = rawInput;
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('导入失败：JSON 根节点必须是对象 `{...}` 或数组 `[...]`');
    }

    const counts = {
      personalities: 0,
      traits: 0,
      storyPacks: 0,
      storyExtensions: 0,
      characters: 0,
      equipment: 0,
      enemies: 0,
      dialogues: 0,
      gifts: 0,
    };

    const normalizeAdaptiveRarity = (rawRarity, fallbackItem = {}) => {
      if (rawRarity !== undefined && rawRarity !== null && String(rawRarity).trim() !== '') {
        const s = String(rawRarity).trim().toLowerCase();
        if (s === '白' || s === '白色' || s === '普通' || s === 'n' || s === 'common' || s === '1') return 'common';
        if (s === '绿' || s === '绿色' || s === '精良' || s === 'r' || s === 'uncommon' || s === '2') return 'uncommon';
        if (s === '蓝' || s === '蓝色' || s === '稀有' || s === 'sr' || s === 'rare' || s === '3') return 'rare';
        if (s === '紫' || s === '紫色' || s === '史诗' || s === 'ssr' || s === 'epic' || s === '4') return 'epic';
        if (s === '橙' || s === '橙色' || s === '金' || s === '金色' || s === '传说' || s === 'ur' || s === 'legendary' || s === '5') {
          return 'legendary';
        }
        return normalizeRarity(s);
      }
      return inferItemRarity(fallbackItem);
    };

    const toArrayEntries = (val, { keyAsName = false } = {}) => {
      if (!val) return [];
      if (Array.isArray(val)) return val.filter((x) => x && typeof x === 'object');
      if (typeof val === 'object') {
        return Object.entries(val)
          .filter(([, v]) => v && typeof v === 'object')
          .map(([k, v]) => ({
            ...(keyAsName && !v.name && !v.title ? { name: k } : {}),
            ...(v.id ? {} : { id: k }),
            ...v,
          }));
      }
      return [];
    };

    const normalizeImportedShipType = (rawType = '驱逐舰') => {
      const s = String(rawType || '').trim();
      const cls = resolveShipClass(s);
      const map = {
        DD: '驱逐舰',
        CL: '轻巡洋舰',
        CA: '重巡洋舰',
        BB: '战列舰',
        CV: '航空母舰',
        SS: '潜艇',
        AR: '维修舰',
        AO: '补给舰',
      };
      return map[cls] || s || '驱逐舰';
    };

    const importCharacterEntry = async (ch) => {
      if (!ch || typeof ch !== 'object' || !this._entities) return false;
      const name = String(ch.name ?? ch.title ?? ch.shipName ?? '').trim();
      if (!name) return false;
      const cid = String(ch.id || `char_imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`);
      const baseStats = ch.stats && typeof ch.stats === 'object' ? ch.stats : ch;
      const rawMaxHp = Math.max(12, Number(baseStats.maxHp ?? baseStats.hp ?? 28) || 28);
      const shipType = normalizeImportedShipType(ch.meta?.shipType || ch.shipType || ch.shipClass || ch.class || '驱逐舰');
      const reg = this._entities.register({
        id: cid,
        kind: 'character',
        name,
        tags: Array.isArray(ch.tags) ? [...ch.tags] : [shipType],
        stats: {
          maxHp: rawMaxHp,
          hp: Math.min(rawMaxHp, Number(baseStats.hp ?? rawMaxHp) || rawMaxHp),
          firepower: Number(baseStats.firepower ?? 16) || 16,
          armor: Number(baseStats.armor ?? 14) || 14,
          torpedo: Number(baseStats.torpedo ?? 16) || 16,
          evasion: Number(baseStats.evasion ?? 18) || 18,
          recon: Number(baseStats.recon ?? 18) || 18,
          aa: Number(baseStats.aa ?? 16) || 16,
          asw: Number(baseStats.asw ?? 16) || 16,
          morale: Number(baseStats.morale ?? 80) || 80,
          ap: Number(baseStats.ap ?? 100) || 100,
          maxAp: Number(baseStats.maxAp ?? 100) || 100,
          affinity: Number(baseStats.affinity ?? 30) || 30,
          level: Math.max(1, Math.floor(Number(baseStats.level ?? 1) || 1)),
          exp: Math.max(0, Math.floor(Number(baseStats.exp ?? 0) || 0)),
          maxExp: Math.max(50, Math.floor(Number(baseStats.maxExp ?? 100) || 100)),
        },
        statBounds: ch.statBounds || { hp: { min: 0, max: 500 }, morale: { min: 0, max: 100 }, ap: { min: 0, max: 100 }, affinity: { min: 0, max: 200 } },
        meta: {
          shipType,
          roleTag: ch.meta?.roleTag || ch.roleTag || '自定义舰娘',
          avatarAssetId: ch.meta?.avatarAssetId || null,
          personality: ch.meta?.personality || ch.personality || '',
          speechHabit: ch.meta?.speechHabit || ch.speechHabit || '',
          ...(ch.meta || {}),
        },
      });
      // Smoothly compress legacy/3-digit imported ship stats to 2-digit scale
      normalizeLegacyShipStatsToCompressedScale(reg);
      if (statRules && typeof statRules.ensureShipProgression === 'function') {
        statRules.ensureShipProgression(reg);
      }
      if (personalityPool && typeof personalityPool.ensurePersonalityOnEntity === 'function') {
        personalityPool.ensurePersonalityOnEntity(reg);
      }
      if (this._inventory) {
        if (this._inventory.getItem('item_core_engine_01')) await this._inventory.equipItem(reg.id, 'engine', 'item_core_engine_01');
        if (this._inventory.getItem('item_core_armor_01')) await this._inventory.equipItem(reg.id, 'armor', 'item_core_armor_01');
        if (this._inventory.getItem('item_core_core_01')) await this._inventory.equipItem(reg.id, 'core', 'item_core_core_01');
      }
      counts.characters += 1;
      return true;
    };

    const importEquipmentEntry = async (eq, { forceOutfit = false } = {}) => {
      if (!eq || typeof eq !== 'object') return false;
      const name = String(eq.name ?? eq.title ?? '').trim();
      if (!name) return false;
      const rawTypeHint = eq.equipmentType || eq.subCategory || eq.type || eq.slotType || '';
      const resolvedEqType = rawTypeHint ? normalizeEquipmentTypeId(rawTypeHint, null) : null;
      const isSupport = resolvedEqType === KNOWN_EQUIPMENT_TYPES.SUPPORT;
      const rawBonuses = Array.isArray(eq.bonuses)
        ? eq.bonuses
        : eq.stats && typeof eq.stats === 'object'
        ? Object.entries(eq.stats)
            .filter(([, v]) => Number.isFinite(Number(v)) && Number(v) !== 0)
            .map(([stat, value]) => ({ stat, layer: 'baseAdd', value: Number(value) }))
        : [];
      const draftEq = {
        ...eq,
        name,
        rarity: normalizeAdaptiveRarity(eq.rarity ?? eq.quality ?? eq.grade ?? eq.tier, eq),
        category: forceOutfit || eq.outfitStyle || eq.style ? ITEM_CATEGORIES.OUTFIT : eq.category || ITEM_CATEGORIES.EXTENSION,
        subGroup: isSupport ? 'support' : eq.subGroup,
        subCategory: resolvedEqType || eq.subCategory,
        equipmentType: resolvedEqType || eq.equipmentType,
        supportRole: isSupport ? eq.supportRole || inferSupportRole(eq) || 'repair' : eq.supportRole || '',
        outfitStyle: eq.outfitStyle || eq.style || (forceOutfit ? '日常便装' : ''),
        bonuses: rawBonuses,
        baseBonuses: rawBonuses,
        description: String(eq.description ?? eq.desc ?? '').trim(),
      };
      const normalizedEq = normalizeLegacyItemBonusesToCompressedScale(draftEq);
      const tpl = await this.saveCustomEquipmentTemplate(normalizedEq);
      if (this._inventory) {
        await this.issueEquipmentToWarehouse(tpl.id, 1);
      }
      counts.equipment += 1;
      return true;
    };

    const importPersonalityEntry = async (pri) => {
      if (!pri || typeof pri !== 'object' || !personalityPool) return false;
      const name = String(pri.name ?? pri.title ?? pri.label ?? pri.id ?? '').trim();
      if (!name) return false;
      const dialogues = normalizeDialogueCategories(pri);
      await personalityPool.addPrimary({
        ...pri,
        name,
        dialogues,
      });
      counts.personalities += 1;
      return true;
    };

    const importTraitEntry = async (tr, forceKind = null) => {
      if (!tr || typeof tr !== 'object' || !personalityPool) return false;
      const name = String(tr.name ?? tr.title ?? tr.label ?? tr.id ?? '').trim();
      if (!name) return false;
      const hasCategorizedDialogues = Object.keys(normalizeDialogueCategories(tr)).length > 0;
      const isExplicitPrimary =
        forceKind === 'primary' ||
        tr.pool === 'primary' ||
        tr.type === 'primary' ||
        (forceKind !== 'secondary' &&
          (tr.toneTag !== undefined ||
            tr.speechPrefix !== undefined ||
            (hasCategorizedDialogues && tr.idleLines === undefined && tr.habitTag === undefined && tr.catchphrase === undefined)));
      if (isExplicitPrimary) {
        return importPersonalityEntry(tr);
      }
      if (typeof personalityPool.addSecondary === 'function') {
        await personalityPool.addSecondary({
          ...tr,
          name,
          idleLines: normalizeLineArray(tr.idleLines ?? tr.lines ?? tr.dialogues ?? tr.quotes ?? tr.catchphrase),
        });
        counts.traits += 1;
        return true;
      }
      return false;
    };

    const importStoryOrEventEntry = async (ev) => {
      if (!ev || typeof ev !== 'object' || !storyPacks) return false;
      const normalized = normalizeAdaptiveStoryPack(ev?.pack && ev?.schema ? ev.pack : ev);
      if (!normalized) return false;
      await storyPacks.savePack({ ...normalized, builtIn: false });
      counts.storyPacks += 1;
      return true;
    };

    const classifySingleItem = (obj) => {
      if (!obj || typeof obj !== 'object') return 'unknown';
      // Story / Event detection (supports nodes, scenes, steps, dialogues+choices, text+choices/options)
      if (
        Array.isArray(obj.nodes) ||
        Array.isArray(obj.scenes) ||
        Array.isArray(obj.steps) ||
        (obj.schema && obj.pack && (Array.isArray(obj.pack.nodes) || Array.isArray(obj.pack.scenes))) ||
        ((obj.title || obj.name) && (Array.isArray(obj.choices) || Array.isArray(obj.options) || Array.isArray(obj.branches)))
      ) {
        return 'storyPack';
      }
      // Primary Personality detection (including rich categorized dialogue objects)
      const catDialogues = normalizeDialogueCategories(obj);
      const hasCatKeys = Object.keys(catDialogues).length > 0;
      if (
        (obj.name || obj.title) &&
        (obj.toneTag !== undefined ||
          obj.speechPrefix !== undefined ||
          obj.speechSuffix !== undefined ||
          (obj.dialogues && typeof obj.dialogues === 'object' && !Array.isArray(obj.dialogues)) ||
          (hasCatKeys && obj.idleLines === undefined && obj.habitTag === undefined && obj.catchphrase === undefined))
      ) {
        return 'personality';
      }
      // Secondary Trait detection
      if (
        (obj.name || obj.title) &&
        (obj.idleLines !== undefined ||
          obj.habitTag !== undefined ||
          obj.catchphrase !== undefined ||
          obj.quirk !== undefined ||
          Array.isArray(obj.lines))
      ) {
        return 'trait';
      }
      // Shipgirl / Character detection
      if (
        obj.kind === 'character' ||
        obj.shipType ||
        obj.shipClass ||
        obj.meta?.shipType ||
        (obj.stats && (obj.stats.firepower !== undefined || obj.stats.maxHp !== undefined) && obj.bonuses === undefined && obj.equipmentType === undefined)
      ) {
        return 'character';
      }
      // Equipment / Outfit detection
      if (
        obj.bonuses !== undefined ||
        obj.equipmentType !== undefined ||
        obj.subCategory !== undefined ||
        obj.outfitStyle !== undefined ||
        obj.rarity !== undefined ||
        obj.quality !== undefined ||
        Object.values(ITEM_CATEGORIES).includes(obj.category)
      ) {
        return 'equipment';
      }
      if (obj.attackPower !== undefined || obj.weakness !== undefined) return 'enemy';
      if ((obj.text || obj.line || obj.content) && !obj.name && !obj.title) return 'dialogue';
      if (obj.affinityGain !== undefined || obj.moraleGain !== undefined) return 'gift';
      return 'unknown';
    };

    const handleSingleOrArray = async (entry) => {
      const kind = classifySingleItem(entry);
      if (kind === 'storyPack') {
        await importStoryOrEventEntry(entry);
      } else if (kind === 'personality') {
        await importPersonalityEntry(entry);
      } else if (kind === 'trait') {
        await importTraitEntry(entry, 'secondary');
      } else if (kind === 'character') {
        await importCharacterEntry(entry);
      } else if (kind === 'equipment') {
        await importEquipmentEntry(entry);
      } else if (kind === 'enemy') {
        await this.createCustomEnemy(entry);
        counts.enemies += 1;
      } else if (kind === 'dialogue') {
        await this.createCustomDialogue({
          ...entry,
          text: entry.text || entry.line || entry.content,
        });
        counts.dialogues += 1;
      } else if (kind === 'gift') {
        await this.createCustomGift(entry);
        counts.gifts += 1;
      }
    };

    const processContainer = async (rootObj) => {
      let matched = false;

      // 1. Personalities (`personalities` / `personalityPool` / `personas` / `archetypes`)
      if (personalityPool) {
        if (rootObj.personalityPool && typeof rootObj.personalityPool === 'object' && !Array.isArray(rootObj.personalityPool)) {
          const pp = rootObj.personalityPool;
          if (pp.primary || pp.personalities || pp.personas || pp.archetypes) {
            matched = true;
            for (const p of toArrayEntries(pp.primary || pp.personalities || pp.personas || pp.archetypes, { keyAsName: true })) {
              await importPersonalityEntry(p);
            }
          }
          if (pp.secondary || pp.traits || pp.subTraits || pp.quirks) {
            matched = true;
            for (const s of toArrayEntries(pp.secondary || pp.traits || pp.subTraits || pp.quirks, { keyAsName: true })) {
              await importTraitEntry(s, 'secondary');
            }
          }
        }
        const priBuckets = [
          rootObj.personalities,
          Array.isArray(rootObj.personalityPool) ? rootObj.personalityPool : null,
          rootObj.personas,
          rootObj.archetypes,
          rootObj.primary,
        ].filter(Boolean);
        for (const bucket of priBuckets) {
          const entries = toArrayEntries(bucket, { keyAsName: true });
          if (entries.length > 0) {
            matched = true;
            for (const p of entries) await importPersonalityEntry(p);
          }
        }

        // 2. Secondary Traits (`traits` / `subTraits` / `quirks` / `secondary`)
        const secBuckets = [rootObj.traits, rootObj.subTraits, rootObj.quirks, rootObj.secondary].filter(Boolean);
        for (const bucket of secBuckets) {
          const entries = toArrayEntries(bucket, { keyAsName: true });
          if (entries.length > 0) {
            matched = true;
            for (const t of entries) await importTraitEntry(t, 'secondary');
          }
        }
      }

      // 3. Events & Story Packs (`events` / `storyPacks` / `stories` / `chapters` / `packs`)
      if (storyPacks) {
        const storyBuckets = [
          rootObj.events,
          rootObj.storyPacks,
          rootObj.stories,
          rootObj.chapters,
          rootObj.packs,
        ].filter(Boolean);
        for (const bucket of storyBuckets) {
          const entries = toArrayEntries(bucket, { keyAsName: true });
          if (entries.length > 0) {
            matched = true;
            for (const ev of entries) await importStoryOrEventEntry(ev);
          }
        }
      }

      // 4. Ships / Characters (`ships` / `characters` / `shipgirls` / `roster`)
      const shipBuckets = [rootObj.ships, rootObj.characters, rootObj.shipgirls, rootObj.roster].filter(Array.isArray);
      for (const bucket of shipBuckets) {
        matched = true;
        for (const ch of bucket) await importCharacterEntry(ch);
      }

      // 5. Equipment & Outfits (`equipments` / `equipment` / `customEquipment` / `items` / `outfits`)
      const eqBuckets = [rootObj.customEquipment, rootObj.equipments, rootObj.equipment, rootObj.items].filter(Array.isArray);
      for (const bucket of eqBuckets) {
        matched = true;
        for (const eq of bucket) await importEquipmentEntry(eq);
      }
      if (Array.isArray(rootObj.outfits)) {
        matched = true;
        for (const outfit of rootObj.outfits) await importEquipmentEntry(outfit, { forceOutfit: true });
      }

      // 6. Enemies / Dialogues / Gifts
      const enemyArr = rootObj.customEnemies || rootObj.enemies;
      if (Array.isArray(enemyArr)) {
        matched = true;
        for (const en of enemyArr) {
          if (en && (en.name || en.title)) {
            await this.createCustomEnemy({ ...en, name: en.name || en.title });
            counts.enemies += 1;
          }
        }
      }
      const dlgArr = rootObj.customDialogues || (Array.isArray(rootObj.dialogues) && !rootObj.name && !rootObj.title ? rootObj.dialogues : null);
      if (Array.isArray(dlgArr)) {
        matched = true;
        for (const d of dlgArr) {
          const line = typeof d === 'string' ? d : d?.text || d?.content || d?.line;
          if (line) {
            await this.createCustomDialogue(typeof d === 'string' ? { text: d } : { ...d, text: line });
            counts.dialogues += 1;
          }
        }
      }
      const giftArr = rootObj.customGifts || rootObj.gifts;
      if (Array.isArray(giftArr)) {
        matched = true;
        for (const g of giftArr) {
          if (g && (g.name || g.title)) {
            await this.createCustomGift({ ...g, name: g.name || g.title });
            counts.gifts += 1;
          }
        }
      }

      // 7. Extended Story Engine Banks (6-stage day/night dialogueBank, portraitTouchLines,
      //    outfitFlavorLines, favoriteGiftReactions, breakthroughTheatres, oathRitualTheatre/oathRitualTheatres,
      //    maritimeEncounters, and per-personality isolated personalityExtensions)
      const extSource =
        rootObj.storyExtensions && typeof rootObj.storyExtensions === 'object'
          ? { ...rootObj, ...rootObj.storyExtensions }
          : rootObj;
      const hasStoryExtKeys =
        Boolean(extSource.personalityExtensions) ||
        Boolean(extSource.dialogueBank) ||
        Boolean(extSource.portraitTouchLines) ||
        Boolean(extSource.outfitFlavorLines) ||
        Boolean(extSource.favoriteGiftReactions) ||
        Boolean(extSource.breakthroughTheatres) ||
        Boolean(extSource.oathRitualTheatre) ||
        Boolean(extSource.oathRitualTheatres) ||
        Array.isArray(extSource.maritimeEncounters);
      if (hasStoryExtKeys) {
        const extMerged = this.mergeStoryExtensions(extSource);
        if (extMerged > 0) {
          matched = true;
          counts.storyExtensions += extMerged;
        }
      }

      return matched;
    };

    // Case 1: Full World Mod JSON (`payload`)
    if (!Array.isArray(parsed) && parsed.payload && typeof parsed.payload === 'object') {
      const modRes = await this.importWorldMod(parsed, { mode });
      counts.characters += modRes.characters || 0;
      counts.equipment += (modRes.items || 0) + (modRes.customEquipment || 0);
      counts.enemies += modRes.enemies || 0;
      counts.dialogues += modRes.dialogues || 0;
      counts.gifts += modRes.gifts || 0;
      counts.storyExtensions += modRes.storyExtensions || 0;
      await processContainer(parsed.payload);
    } else if (Array.isArray(parsed)) {
      // Case 2: Bare JSON Array `[...]`
      for (const entry of parsed) {
        await handleSingleOrArray(entry);
      }
    } else {
      // Case 3: Container object with alias collections OR single item `{...}`
      const matched = await processContainer(parsed);
      if (!matched) {
        await handleSingleOrArray(parsed);
      }
    }

    const total =
      counts.personalities +
      counts.traits +
      counts.storyPacks +
      counts.storyExtensions +
      counts.characters +
      counts.equipment +
      counts.enemies +
      counts.dialogues +
      counts.gifts;

    if (total === 0) {
      const detectedKeys = Array.isArray(parsed)
        ? `数组长度 ${parsed.length}`
        : `检测到字段：${Object.keys(parsed).slice(0, 8).join(', ') || '(空对象)'}`;
      throw new Error(
        `自适应识别失败（${detectedKeys}）：未匹配到性格(personalities/personas)、特质(traits/quirks)、剧情事件(events/storyPacks/scenes)、扩展剧情词库(dialogueBank/portraitTouchLines/breakthroughTheatres)、舰娘(ships/characters)或装备服装(equipments/outfits/items)结构`
      );
    }

    await this.persist();
    const parts = [];
    if (counts.personalities > 0) parts.push(`新增 ${counts.personalities} 种性格`);
    if (counts.traits > 0) parts.push(`${counts.traits} 个特质`);
    if (counts.storyPacks > 0) parts.push(`${counts.storyPacks} 个剧情事件`);
    if (counts.storyExtensions > 0) parts.push(`${counts.storyExtensions} 条互动/触摸/突破剧情词库`);
    if (counts.characters > 0) parts.push(`${counts.characters} 名舰娘`);
    if (counts.equipment > 0) parts.push(`${counts.equipment} 件装备/服装`);
    if (counts.enemies > 0) parts.push(`${counts.enemies} 种敌舰`);
    if (counts.dialogues > 0) parts.push(`${counts.dialogues} 条台词`);
    if (counts.gifts > 0) parts.push(`${counts.gifts} 种礼物`);
    const summaryText = `自适应导入成功：${parts.join('、')}`;

    if (this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        title: '智能自适应 JSON 导入成功',
        detail: summaryText,
      });
    }
    this._emit('content:mod-imported', { mode: 'adaptive-paste-merge', counts });
    return { counts, total, summaryText };
  }

  /**
   * Non-destructively merge the full Starter Content Bundle into the current save:
   *   - 8 featured shipgirls across all 5 ship classes (DD/CL/CA/BB/CV) with distinct random personalities
   *   - 16 core parts, main weapons, tactical support modules & outfits
   *   - Low/Medium/High tiered enemy formations
   *   - 16-event Port Life Daily Pack + 4-Chapter Abyssal Ruins Investigation Story Pack
   * NEVER overwrites existing characters, items, enemies, or story flags!
   */
  async mergeStarterContentBundle({
    personalityPool = null,
    storyPacks = null,
    statRules = null,
    persistRosterFn = null,
    silent = false,
    includeDemoShips = false,
    includeItems = true,
  } = {}) {
    const summary = {
      addedShips: 0,
      addedItems: 0,
      addedEnemies: 0,
      addedPacks: 0,
    };

    // 1. Merge 16-piece Equipment Pack first (only missing IDs)
    if (includeItems && this._inventory) {
      for (const tpl of STARTER_PACK_EQUIPMENT_16) {
        if (!this._inventory.getItem(tpl.id)) {
          await this._inventory.createItem(deepClone(tpl));
          summary.addedItems += 1;
        }
      }
    }

    // 2. Demo ships are disabled by default — New Game strictly creates ONLY the player's chosen starter ship(s)
    if (includeDemoShips && this._entities) {
      const usedComboKeys = new Set(
        this._entities
          .list({ kind: 'character' })
          .map((c) => c.meta?.personalityCombo?.key)
          .filter(Boolean)
      );

      for (const tpl of STARTER_PACK_SHIPGIRLS_8) {
        if (this._entities.has(tpl.id)) {
          // Ensure existing ships also have a personality combo if missing (lossless)
          if (personalityPool) {
            personalityPool.ensurePersonalityOnEntity(this._entities.get(tpl.id));
          }
          continue;
        }
        let combo = null;
        if (personalityPool) {
          for (let attempt = 0; attempt < 10; attempt++) {
            const cand = personalityPool.rollCombination();
            if (!usedComboKeys.has(cand.key)) {
              combo = cand;
              break;
            }
          }
          if (!combo) combo = personalityPool.rollCombination();
          usedComboKeys.add(combo.key);
        }

        const reg = this._entities.register({
          id: tpl.id,
          kind: 'character',
          name: tpl.name,
          tags: [tpl.shipType, ...(combo ? [combo.primaryName, combo.secondaryName] : [])],
          stats: deepClone(tpl.stats),
          statBounds: {
            hp: { min: 0, max: 500 },
            morale: { min: 0, max: 100 },
            ap: { min: 0, max: 100 },
            affinity: { min: 0, max: 100 },
          },
          meta: {
            shipType: tpl.shipType,
            roleTag: tpl.roleTag,
            avatarAssetId: null,
            personalityCombo: combo,
            personality: combo?.description || `${tpl.shipType}主力舰娘，随时待命出击。`,
            speechHabit: combo?.speechHabit || `「${tpl.name}，报到完毕！」`,
          },
        });
        if (statRules && typeof statRules.ensureShipProgression === 'function') {
          statRules.ensureShipProgression(reg);
        }

        // Equip starter core 3-piece so newly merged ships are immediately seaworthy
        if (this._inventory) {
          if (this._inventory.getItem('item_core_engine_01')) {
            await this._inventory.equipItem(reg.id, 'engine', 'item_core_engine_01');
          }
          if (this._inventory.getItem('item_core_armor_01')) {
            await this._inventory.equipItem(reg.id, 'armor', 'item_core_armor_01');
          }
          if (this._inventory.getItem('item_core_core_01')) {
            await this._inventory.equipItem(reg.id, 'core', 'item_core_core_01');
          }
          const effMaxHp = Math.round(this._entities.getEffectiveStat(reg.id, 'maxHp', { round: 'round' }).final);
          this._entities.setStat(reg.id, 'hp', effMaxHp, { min: 0, max: effMaxHp });
        }

        summary.addedShips += 1;
      }
    }

    // 3. Merge Tiered Low / Medium / High Enemy Formations (only missing IDs)
    const existingEnemyIds = new Set(this._state.customEnemies.map((e) => e.id));
    for (const enemyTpl of STARTER_PACK_ENEMIES_TIERED) {
      if (!existingEnemyIds.has(enemyTpl.id)) {
        await this.createCustomEnemy(deepClone(enemyTpl));
        summary.addedEnemies += 1;
      }
    }

    // 4. Merge 16-Event Port Life Pack & 4-Chapter Abyssal Ruins Pack (only missing IDs)
    if (storyPacks && typeof storyPacks.ensureStarterStoryPacks === 'function') {
      const spRes = await storyPacks.ensureStarterStoryPacks();
      summary.addedPacks = spRes.added || 0;
    }

    if (typeof persistRosterFn === 'function') {
      await persistRosterFn();
    }

    await this.persist();
    if (!silent && this._logs) {
      this._logs.add({
        category: LOG_CATEGORIES.SYSTEM,
        title: '合并导入「开局标准示范内容大礼包」',
        detail: `新增舰娘 ${summary.addedShips} 名 · 装备 ${summary.addedItems} 件 · 分级敌舰 ${summary.addedEnemies} 支 · 剧情事件包 ${summary.addedPacks} 套（未覆盖任何旧存档数据）`,
      });
    }
    this._emit('content:mod-imported', { mode: 'starter-merge', counts: summary });
    return summary;
  }

  serialize() {
    return {
      version: 1,
      ...deepClone(this._state),
    };
  }

  deserialize(snapshot, { persist = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const def = createDefaultContentState();
    this._state = {
      customEnemies: Array.isArray(snapshot.customEnemies) ? deepClone(snapshot.customEnemies) : [],
      customDialogues: Array.isArray(snapshot.customDialogues)
        ? deepClone(snapshot.customDialogues).map((d) => ({
            ...d,
            stage: normalizeDialogueStageKey(d?.stage || 'any'),
          }))
        : [],
      customGifts: Array.isArray(snapshot.customGifts) ? deepClone(snapshot.customGifts) : [],
      customEquipment: Array.isArray(snapshot.customEquipment) ? deepClone(snapshot.customEquipment) : [],
      storyExtensions: createEmptyStoryExtensions(),
      loadedStoryPackFiles:
        snapshot.loadedStoryPackFiles && typeof snapshot.loadedStoryPackFiles === 'object'
          ? deepClone(snapshot.loadedStoryPackFiles)
          : {},
      encounteredEnemyNames: Array.isArray(snapshot.encounteredEnemyNames)
        ? snapshot.encounteredEnemyNames.map(String)
        : def.encounteredEnemyNames,
      clearedRouteIds: Array.isArray(snapshot.clearedRouteIds)
        ? snapshot.clearedRouteIds.map(String)
        : [],
      updatedAt: Number(snapshot.updatedAt) || Date.now(),
    };
    if (snapshot.storyExtensions && typeof snapshot.storyExtensions === 'object') {
      this.mergeStoryExtensions(snapshot.storyExtensions);
    }
    if (snapshot.personalityExtensions && typeof snapshot.personalityExtensions === 'object') {
      this.mergeStoryExtensions({ personalityExtensions: snapshot.personalityExtensions });
    }
    if (persist) this.persist();
  }
}
