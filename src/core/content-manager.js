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
import { ITEM_CATEGORY_LABELS } from './inventory-system.js';
import { LOG_CATEGORIES } from './log-system.js';

const STORAGE_NS = 'core-content-studio';
const STATE_KEY = 'content-studio-v1';

export const WORLD_MOD_SCHEMA = 'kancolle-pwa-world-mod-v1';

export const BUILTIN_ENEMY_ARCHIVE = Object.freeze([
  {
    id: 'enemy_builtin_patrol',
    name: '前哨巡逻编队',
    tier: NODE_TYPES.ENCOUNTER,
    hp: 58,
    armor: 4,
    attackPower: 11,
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
    hp: 62,
    armor: 3,
    attackPower: 12,
    airThreat: 0,
    subThreat: 18,
    threatLabel: '敌方水下潜艇威胁',
    weakness: 'torpedo',
    weaknessLabel: '鱼雷弱点',
    drops: ['燃油 45~70', '钢材 60~80', '银条 120~160'],
    builtIn: true,
  },
  {
    id: 'enemy_builtin_air_raider',
    name: '轻航突袭中队',
    tier: NODE_TYPES.ELITE,
    hp: 96,
    armor: 7,
    attackPower: 16,
    airThreat: 22,
    subThreat: 0,
    threatLabel: '敌方航空威胁',
    weakness: 'shelling',
    weaknessLabel: '炮击弱点',
    drops: ['铝材 70~110', '钢材 85~120', '银条 170~220'],
    builtIn: true,
  },
  {
    id: 'enemy_builtin_boss_flagship',
    name: '海域主力旗舰群',
    tier: NODE_TYPES.BOSS,
    hp: 168,
    armor: 12,
    attackPower: 22,
    airThreat: 26,
    subThreat: 14,
    threatLabel: '海空潜立体主力',
    weakness: 'torpedo',
    weaknessLabel: '鱼雷弱点',
    drops: ['钢材 140~220', '铝材 90~150', '银条 280~400', '金条 2~7'],
    builtIn: true,
  },
]);

function deepClone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function createDefaultContentState() {
  return {
    customEnemies: [],
    customDialogues: [],
    customGifts: [],
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

  async createCustomDialogue({ id = null, stage = 'any', text = '' } = {}) {
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('台词模板内容不能为空');
    const validStages = ['any', 'stranger', 'familiar', 'trusted', 'close', 'oath'];
    const dlg = {
      id: String(id || `dlg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`),
      stage: validStages.includes(stage) ? stage : 'any',
      text: cleanText,
      createdAt: Date.now(),
    };
    const idx = this._state.customDialogues.findIndex((d) => d.id === dlg.id);
    if (idx >= 0) this._state.customDialogues[idx] = dlg;
    else this._state.customDialogues.push(dlg);

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
  // 4. Full-Spectrum Compendium Aggregation
  // ------------------------------------------------------------

  getCompendiumReport() {
    const chars = this._entities?.list({ kind: 'character' }) || [];
    const items = this._inventory?.listItems() || [];
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
      categoryLabel: ITEM_CATEGORY_LABELS[it.category] || it.category,
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

    // 5. Custom Enemies, Dialogues, Gifts
    if (isReplace) {
      this._state.customEnemies = [];
      this._state.customDialogues = [];
      this._state.customGifts = [];
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
      customDialogues: Array.isArray(snapshot.customDialogues) ? deepClone(snapshot.customDialogues) : [],
      customGifts: Array.isArray(snapshot.customGifts) ? deepClone(snapshot.customGifts) : [],
      encounteredEnemyNames: Array.isArray(snapshot.encounteredEnemyNames)
        ? snapshot.encounteredEnemyNames.map(String)
        : def.encounteredEnemyNames,
      clearedRouteIds: Array.isArray(snapshot.clearedRouteIds)
        ? snapshot.clearedRouteIds.map(String)
        : [],
      updatedAt: Number(snapshot.updatedAt) || Date.now(),
    };
    if (persist) this.persist();
  }
}
