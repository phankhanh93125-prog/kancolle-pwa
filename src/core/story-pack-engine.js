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

export const BUILTIN_STORY_PACKS = [
  {
    id: 'pack_port_daily_ext',
    name: '港区日常互动扩展包',
    version: '1.0.0',
    category: PACK_CATEGORIES.PORT_DAILY,
    description: '包含茶室闲谈、港区巡查与夜宵茶会 3 个可连贯推进的日常分支事件，并记录日常互动进度 Flag。',
    enabled: true,
    builtIn: true,
    entryNodeId: 'daily_tea_01',
    nodes: [
      {
        id: 'daily_tea_01',
        title: '午后茶室的战术笔记',
        body: '午后海风轻拂港区茶室，{actor.name}正拿着一叠航线图向{commander.name}请教补给分配方案。空气中飘散着淡淡红茶香。',
        conditions: [],
        choices: [
          {
            id: 'c_tea_discuss',
            label: '结合战术细致复盘（侦查 DC 11）',
            conditions: [],
            check: { statKey: 'recon', dc: 11 },
            effects: {
              flags: { port_tea_club: true, port_daily_done: 1 },
              resources: { silver: 45, fuel: 30 },
              affinity: 5,
              morale: 8,
              commanderExp: 18,
            },
            failEffects: {
              flags: { port_tea_club: true },
              resources: { silver: 20 },
              affinity: 2,
              morale: 4,
              commanderExp: 10,
            },
            resultText: '{actor.name}眼前一亮，迅速在海图上圈出了两条节能航道：「原来还可以这样调度！」（写入标记 port_tea_club=true）',
            failText: '虽然有几处推演略显匆忙，但两人还是整理出了不错的参考草稿。',
            nextNodeId: 'daily_tea_02',
          },
          {
            id: 'c_tea_relax',
            label: '先放下海图，一起享用红茶点心',
            conditions: [],
            check: null,
            effects: {
              flags: { port_tea_club: true, port_daily_done: 1 },
              affinity: 6,
              morale: 12,
              commanderExp: 12,
            },
            resultText: '难得的轻松午后让{actor.name}彻底放松下来，港区氛围变得更加温馨融洽。',
            nextNodeId: 'daily_tea_02',
          },
        ],
      },
      {
        id: 'daily_tea_02',
        title: '黄昏码头的灯光巡检',
        body: '傍晚时分，茶室的轻松氛围延续到了港口栈桥。远处的信号塔亮起柔和的航标灯，{actor.name}询问是否要顺路检视补给仓。',
        conditions: [{ type: 'flag', key: 'port_tea_club', op: 'truthy' }],
        choices: [
          {
            id: 'c_pier_inspect',
            label: '一起核对物资库存并清点油弹',
            conditions: [],
            check: null,
            effects: {
              flags: { port_pier_checked: true },
              resources: { fuel: 40, ammo: 40, steel: 30 },
              affinity: 4,
              morale: 6,
              commanderExp: 16,
            },
            resultText: '两人配合默契地找出了几箱遗漏的应急物资，并重新归档了港口清单！',
            nextNodeId: null,
          },
          {
            id: 'c_pier_stroll',
            label: '沿防波堤散步观海（需好感 ≥ 50）',
            conditions: [{ type: 'affinityMin', value: 50 }],
            check: null,
            effects: {
              flags: { port_pier_stroll: true },
              affinity: 8,
              morale: 14,
              commanderLuck: 1,
            },
            resultText: '潮声与晚霞映照在海面，{actor.name}轻声许下约定，仿佛连港区的幸运都悄然提升（指挥官运气 +1）。',
            nextNodeId: null,
          },
        ],
      },
    ],
  },
  {
    id: 'pack_sea_investigation',
    name: '多章节海域调查剧情包',
    version: '1.0.0',
    category: PACK_CATEGORIES.MAIN_CHAPTER,
    description: '三章节连贯海域调查主线：异常信标侦测 → 迷雾沉船坐标 → 深海遗迹核心，完整演示前置 Flag 进度锁、D20 检定与奖惩结算。',
    enabled: true,
    builtIn: true,
    entryNodeId: 'inv_ch1_beacon',
    nodes: [
      {
        id: 'inv_ch1_beacon',
        title: '第一章 · 异常信标侦测',
        body: '港区监听站捕捉到外海扇区传来一段规律的加密脉动信号。{commander.name}召集{actor.name}研判情报，准备展开第一阶段海域调查。',
        conditions: [],
        choices: [
          {
            id: 'c_ch1_decode',
            label: '启用舰载雷达解析信号频段（侦查 DC 12）',
            conditions: [],
            check: { statKey: 'recon', dc: 12 },
            effects: {
              flags: { inv_ch1_done: true, inv_clues: 2, inv_stage: 'chapter_2' },
              resources: { bauxite: 50, silver: 70 },
              affinity: 4,
              commanderExp: 25,
            },
            failEffects: {
              flags: { inv_ch1_done: true, inv_clues: 1, inv_stage: 'chapter_2' },
              resources: { silver: 35 },
              affinity: 2,
              commanderExp: 15,
            },
            resultText: '雷达精准剥离了电磁杂波！坐标锁定在雾海沉船带，已解锁「第二章 · 迷雾沉船坐标」（Flag: inv_ch1_done=true）。',
            failText: '强杂波干扰了部分频段，但依然锁定了大致雾海方向，已解锁第二章调查！',
            nextNodeId: 'inv_ch2_wreck',
          },
          {
            id: 'c_ch1_recon_direct',
            label: '直接派遣高速前哨接近采样（稳定推进）',
            conditions: [],
            check: null,
            effects: {
              flags: { inv_ch1_done: true, inv_clues: 1, inv_stage: 'chapter_2' },
              resources: { fuel: -15, steel: 45, silver: 55 },
              affinity: 3,
              commanderExp: 20,
            },
            resultText: '前哨舰安全带回了浮标残片与海图坐标，正式解锁「第二章 · 迷雾沉船坐标」（Flag: inv_ch1_done=true）。',
            nextNodeId: 'inv_ch2_wreck',
          },
        ],
      },
      {
        id: 'inv_ch2_wreck',
        title: '第二章 · 迷雾沉船坐标',
        body: '循着第一章解锁的坐标，编队驶入浓雾笼罩的古老航道。声呐屏幕显示海床静卧着一座保存完好的旧时代监测舱，周围潜伏着警戒浮雷。',
        conditions: [{ type: 'flag', key: 'inv_ch1_done', op: 'eq', value: true }],
        choices: [
          {
            id: 'c_ch2_disarm',
            label: '反潜排雷并打捞核心黑匣子（反潜 DC 13）',
            conditions: [],
            check: { statKey: 'asw', dc: 13 },
            effects: {
              flags: { inv_ch2_done: true, inv_blackbox: true, inv_stage: 'chapter_3' },
              resources: { steel: 90, bauxite: 70, silver: 110 },
              affinity: 5,
              morale: 8,
              commanderExp: 35,
            },
            failEffects: {
              flags: { inv_ch2_done: true, inv_blackbox: false, inv_stage: 'chapter_3' },
              resources: { steel: 45, silver: 50 },
              morale: -4,
              commanderExp: 20,
            },
            resultText: '反潜班干净利落地清除了浮雷，完整回收加密黑匣子！终章坐标已解锁（Flag: inv_ch2_done=true）。',
            failText: '虽有一枚浮雷提前引爆造成轻微震荡，但编队仍抢救出了关键航路日志，终章已解锁。',
            nextNodeId: 'inv_ch3_core',
          },
          {
            id: 'c_ch2_fire_clear',
            label: '远程炮击引爆雷区开辟航道（火力 DC 12）',
            conditions: [],
            check: { statKey: 'firepower', dc: 12 },
            effects: {
              flags: { inv_ch2_done: true, inv_blackbox: true, inv_stage: 'chapter_3' },
              resources: { ammo: -20, steel: 80, silver: 95 },
              affinity: 4,
              commanderExp: 32,
            },
            failEffects: {
              flags: { inv_ch2_done: true, inv_stage: 'chapter_3' },
              resources: { ammo: -20, steel: 40 },
              commanderExp: 18,
            },
            resultText: '精准齐射瞬间清空了前方雷阵，编队顺利取得深海遗迹密钥，解锁终章！',
            failText: '弹着略有偏移，消耗部分弹药后总算开辟出通往终章的安全航线。',
            nextNodeId: 'inv_ch3_core',
          },
        ],
      },
      {
        id: 'inv_ch3_core',
        title: '终章 · 深海遗迹核心',
        body: '穿过迷雾海门，一座漂浮着淡蓝光晕的古代海事中继塔呈现在舰队眼前。随着前两章收集的密匙激活，遗迹核心向{commander.name}敞开了资材库。',
        conditions: [{ type: 'flag', key: 'inv_ch2_done', op: 'eq', value: true }],
        choices: [
          {
            id: 'c_ch3_claim',
            label: '回收全部战略资材与遗迹星图（通关终章）',
            conditions: [],
            check: null,
            effects: {
              flags: { inv_campaign_cleared: true, inv_stage: 'completed' },
              resources: { fuel: 120, ammo: 100, steel: 150, bauxite: 120, silver: 240, gold: 3 },
              affinity: 8,
              morale: 15,
              commanderExp: 60,
              commanderLuck: 2,
            },
            resultText: '★ 海域调查主线圆满通关！港区收获海量战略资材与珍贵金条，指挥官运气 +2，全舰队士气振奋！',
            nextNodeId: null,
          },
          {
            id: 'c_ch3_preserve',
            label: '保留中继塔运转并将其接入港区雷达网',
            conditions: [{ type: 'flag', key: 'inv_blackbox', op: 'eq', value: true }],
            check: null,
            effects: {
              flags: { inv_campaign_cleared: true, inv_radar_linked: true, inv_stage: 'completed' },
              resources: { bauxite: 180, silver: 200, gold: 4 },
              affinity: 10,
              morale: 18,
              commanderExp: 75,
              commanderLuck: 3,
            },
            resultText: '★ 隐藏路线达成！中继塔与港区成功联网，获得金条 +4、指挥官运气 +3 与永久标记 inv_radar_linked=true！',
            nextNodeId: null,
          },
        ],
      },
    ],
  },
  {
    id: 'pack_port_life_15',
    name: '港区生活日常包（16 项随机事件）',
    version: '1.0.0',
    category: PACK_CATEGORIES.PORT_DAILY,
    description: '收录食堂咖喱大赛、午后茶歇、船坞夜谈、海风晨练、防波堤观星、装备校准等 16 项港区生活事件，支持连续推进与随机抽选。',
    enabled: true,
    builtIn: true,
    entryNodeId: 'pl_evt_01',
    nodes: [
      {
        id: 'pl_evt_01',
        title: '港区食堂 · 周五海风咖喱大赛',
        body: '港区食堂飘来浓郁的香料气息，{actor.name}正围着围裙邀请{commander.name}担任今日特制海员咖喱的首席评委。',
        conditions: [],
        choices: [
          { id: 'c_pl01_a', label: '认真试吃并给出专业点评', conditions: [], check: null, effects: { flags: { port_life_curry: true, port_life_events: 1 }, resources: { fuel: 30, silver: 35 }, affinity: 5, morale: 10, commanderExp: 14 }, resultText: '你的点评赢得全场掌声，{actor.name}开心地端上秘制甜点！', nextNodeId: 'pl_evt_02' },
          { id: 'c_pl01_b', label: '亲自下厨露一手拿手好菜', conditions: [], check: { statKey: 'recon', dc: 11 }, effects: { flags: { port_life_curry: true }, resources: { silver: 55 }, affinity: 7, morale: 14, commanderExp: 18 }, failEffects: { affinity: 3, morale: 6 }, resultText: '香气瞬间征服了整个食堂，连挑食的舰娘都连盛两大碗！', failText: '火候稍猛了点，但大家还是笑着把咖喱吃了个精光。', nextNodeId: 'pl_evt_02' },
        ],
      },
      {
        id: 'pl_evt_02',
        title: '防波堤上的橘猫巡逻队',
        body: '清晨码头巡查时，几只常驻港区的橘猫排着队蹭着{actor.name}的鞋边，看起来像是来讨早饭的。',
        conditions: [],
        choices: [
          { id: 'c_pl02_a', label: '分发小鱼干并合影留念', conditions: [], check: null, effects: { flags: { port_cat_friend: true }, resources: { silver: 25 }, affinity: 5, morale: 12, commanderLuck: 1 }, resultText: '橘猫们满足地打起呼噜，港区的氛围愈发治愈（指挥官运气 +1）。', nextNodeId: 'pl_evt_03' },
          { id: 'c_pl02_b', label: '任命大橘为港区荣誉巡逻队长', conditions: [], check: null, effects: { flags: { port_cat_captain: true }, affinity: 6, morale: 10, commanderExp: 12 }, resultText: '{actor.name}忍俊不禁地为大橘戴上了迷你纸质水手帽！', nextNodeId: 'pl_evt_03' },
        ],
      },
      {
        id: 'pl_evt_03',
        title: '晨雾中的炮术校准演练',
        body: '海面微风轻拂，{actor.name}主动申请利用早操时间校准新装火控参数与主炮仰角。',
        conditions: [],
        choices: [
          { id: 'c_pl03_a', label: '亲自测算风偏并指导齐射（火力 DC 12）', conditions: [], check: { statKey: 'firepower', dc: 12 }, effects: { flags: { port_drill_ace: true }, resources: { ammo: 45, steel: 35 }, affinity: 5, morale: 8, commanderExp: 20 }, failEffects: { resources: { ammo: 20 }, affinity: 2, commanderExp: 10 }, resultText: '靶标正中红心！全舰队对火控协同更有信心了。', failText: '海雾影响了目视测距，但仍收集到宝贵的校准数据。', nextNodeId: 'pl_evt_04' },
        ],
      },
      {
        id: 'pl_evt_04',
        title: '雨天资料室的旧海图整理',
        body: '突如其来的阵雨让室外操演暂停，{actor.name}与{commander.name}在资料室翻出了几卷泛黄的旧航道记录。',
        conditions: [],
        choices: [
          { id: 'c_pl04_a', label: '细致修复海图并录入港区数据库', conditions: [], check: null, effects: { flags: { port_old_chart: true }, resources: { bauxite: 40, silver: 40 }, affinity: 4, morale: 6, commanderExp: 16 }, resultText: '从旧海图中发现了隐蔽补给点的坐标记录！', nextNodeId: 'pl_evt_05' },
        ],
      },
      {
        id: 'pl_evt_05',
        title: '黄昏船坞的机油与晚风',
        body: '刚完成保养的舰装在夕阳下泛着金属光泽，{actor.name}正细心擦拭着甲板护栏。',
        conditions: [],
        choices: [
          { id: 'c_pl05_a', label: '递上冰镇柠檬水并帮忙收整工具', conditions: [], check: null, effects: { resources: { steel: 45 }, affinity: 6, morale: 10, commanderExp: 14 }, resultText: '{actor.name}接过冷饮露出安心笑容，保养进度提前完成！', nextNodeId: 'pl_evt_06' },
        ],
      },
      {
        id: 'pl_evt_06',
        title: '港口灯塔的夜空观星会',
        body: '万里无云的夏夜，银河横跨港湾上空，{actor.name}在灯塔露台铺开了观星毯。',
        conditions: [],
        choices: [
          { id: 'c_pl06_a', label: '辨认航海星座并聊起未来航程', conditions: [], check: null, effects: { flags: { port_stargaze: true }, affinity: 7, morale: 14, commanderExp: 15 }, resultText: '璀璨星光下，两人的羁绊又加深了一分。', nextNodeId: 'pl_evt_07' },
        ],
      },
      {
        id: 'pl_evt_07',
        title: '后勤仓库的意外漂流补给箱',
        body: '潮水将几只密封完好的海上补给箱推上了栈桥浅滩，{actor.name}第一时间赶来汇报。',
        conditions: [],
        choices: [
          { id: 'c_pl07_a', label: '安全开箱清点并归入港区储备', conditions: [], check: null, effects: { resources: { fuel: 50, ammo: 50, steel: 40, bauxite: 30 }, affinity: 3, commanderExp: 15 }, resultText: '箱内竟装满了保存完好的四项战略资源！', nextNodeId: 'pl_evt_08' },
        ],
      },
      {
        id: 'pl_evt_08',
        title: '夏日港湾轻音乐晚会',
        body: '宿舍公共厅临时搭起了小型舞台，舰娘们自发组织起港区轻音乐放松晚会。',
        conditions: [],
        choices: [
          { id: 'c_pl08_a', label: '为演出鼓掌并赞助茶点经费', conditions: [], check: null, effects: { resources: { silver: 35 }, affinity: 6, morale: 16, commanderExp: 15 }, resultText: '欢快的旋律回荡港湾，全体舰娘士气大涨！', nextNodeId: 'pl_evt_09' },
        ],
      },
      {
        id: 'pl_evt_09',
        title: '反潜声呐的港湾试音',
        body: '平静的内港水下传来奇怪回声，{actor.name}好奇地打开声呐进行排查。',
        conditions: [],
        choices: [
          { id: 'c_pl09_a', label: '仔细辨别频谱（反潜 DC 11）', conditions: [], check: { statKey: 'asw', dc: 11 }, effects: { resources: { bauxite: 45, silver: 40 }, affinity: 5, commanderExp: 18 }, failEffects: { morale: 6, commanderExp: 10 }, resultText: '原来是一群路过的海豚家族！声呐校准数据也顺利存档。', failText: '回声很快消失在远海，只留下一串欢快的气泡声。', nextNodeId: 'pl_evt_10' },
        ],
      },
      {
        id: 'pl_evt_10',
        title: '港区商店街的新装试穿',
        body: '裁缝工坊送来了最新季度的港区常服与礼装样衣，{actor.name}略带期待地征求你的意见。',
        conditions: [],
        choices: [
          { id: 'c_pl10_a', label: '真诚夸赞最适合她的配色方案', conditions: [], check: null, effects: { flags: { port_fashion_talk: true }, affinity: 7, morale: 12, commanderExp: 14 }, resultText: '{actor.name}眼角弯成月牙，似乎对下一次换装充满期待！', nextNodeId: 'pl_evt_11' },
        ],
      },
      {
        id: 'pl_evt_11',
        title: '突发热带气旋防风加固',
        body: '气象台发出短时强风预警，需要迅速固定港口系泊缆绳与露天资材。',
        conditions: [],
        choices: [
          { id: 'c_pl11_a', label: '率队高速完成防风部署（机动 DC 12）', conditions: [], check: { statKey: 'evasion', dc: 12 }, effects: { resources: { steel: 60, fuel: 40 }, affinity: 5, morale: 10, commanderExp: 20 }, failEffects: { resources: { steel: 20 }, commanderExp: 10 }, resultText: '暴风袭来前港口已固若金汤，零损失平安度过！', failText: '虽然淋了点雨，但关键资材全部保住了。', nextNodeId: 'pl_evt_12' },
        ],
      },
      {
        id: 'pl_evt_12',
        title: '午夜指挥室的暖心夜宵',
        body: '深夜仍在整理航线简报时，{actor.name}悄悄端来一碗热气腾腾的乌冬面。',
        conditions: [],
        choices: [
          { id: 'c_pl12_a', label: '放下笔和她一起趁热享用', conditions: [], check: null, effects: { flags: { port_midnight_noodle: true }, affinity: 8, morale: 12, commanderExp: 15 }, resultText: '温暖的汤香驱散了疲惫，深夜的指挥室格外温馨。', nextNodeId: 'pl_evt_13' },
        ],
      },
      {
        id: 'pl_evt_13',
        title: '海岸线体能竞速晨跑',
        body: '朝阳跃出海面，{actor.name}邀请你沿着海岸公路来一场轻快的晨跑热身。',
        conditions: [],
        choices: [
          { id: 'c_pl13_a', label: '全力跟上她的步伐完成拉练', conditions: [], check: null, effects: { resources: { fuel: 35 }, affinity: 5, morale: 12, commanderExp: 16 }, resultText: '海风拂面、汗水畅快，今天的精神状态达到巅峰！', nextNodeId: 'pl_evt_14' },
        ],
      },
      {
        id: 'pl_evt_14',
        title: '灯笼节前夜的港区装饰',
        body: '港湾栈桥挂起了一排排暖色信号灯笼，{actor.name}正踮脚调整最显眼的那一盏。',
        conditions: [],
        choices: [
          { id: 'c_pl14_a', label: '帮她稳住梯子并点亮总开关', conditions: [], check: null, effects: { flags: { port_lantern_night: true }, resources: { silver: 65 }, affinity: 7, morale: 15, commanderExp: 18 }, resultText: '整片港湾瞬间灯火璀璨，倒映在波光粼粼的海面上！', nextNodeId: 'pl_evt_15' },
        ],
      },
      {
        id: 'pl_evt_15',
        title: '模拟沙盘推演与战法交流',
        body: '战术教室里摆开了多舰种协同沙盘，驱逐、轻巡、重巡、战列与航母的配合思路碰撞出新火花。',
        conditions: [],
        choices: [
          { id: 'c_pl15_a', label: '总结五舰种协同战法笔记', conditions: [], check: null, effects: { resources: { ammo: 45, bauxite: 45 }, affinity: 5, morale: 10, commanderExp: 22 }, resultText: '新的大编队战术手册编纂完成，指挥官经验大幅增长！', nextNodeId: 'pl_evt_16' },
        ],
      },
      {
        id: 'pl_evt_16',
        title: '黎明栈桥的出征约定',
        body: '第一缕晨光照亮了停泊在码头的舰队剪影，{actor.name}向{commander.name}伸出手，约定共同迈向下一段航程。',
        conditions: [],
        choices: [
          { id: 'c_pl16_a', label: '握紧她的手，迎向崭新的一天（完成日常巡礼）', conditions: [], check: null, effects: { flags: { port_life_cycle_done: true }, resources: { fuel: 60, ammo: 60, silver: 120, gold: 1 }, affinity: 10, morale: 18, commanderExp: 30, commanderLuck: 1 }, resultText: '★ 港区生活日常巡礼达成！全队士气焕发，收获金条 +1 与指挥官运气 +1！', nextNodeId: null },
        ],
      },
    ],
  },
  {
    id: 'pack_abyssal_ruins_4ch',
    name: '深海遗迹调查剧情包（四章主线）',
    version: '1.0.0',
    category: PACK_CATEGORIES.MAIN_CHAPTER,
    description: '四章节连贯深海遗迹调查主线：异常深海脉动 → 迷雾沉船带 → 遗迹海门破译 → 终章中枢抉择，含完整 Flag 进度锁与双结局分支。',
    enabled: true,
    builtIn: true,
    entryNodeId: 'ruins_ch1_signal',
    nodes: [
      {
        id: 'ruins_ch1_signal',
        title: '第一章 · 异常深海脉动信号',
        body: '凌晨三点，港区深海监听阵捕捉到来自外海断层的规律声波。{commander.name}携{actor.name}分析频谱，确认那是一座沉没已久的古代海事遗迹发出的唤醒脉冲。',
        conditions: [],
        choices: [
          {
            id: 'c_r1_analyze',
            label: '使用舰载电探与声呐联合解码（侦查 DC 12）',
            conditions: [],
            check: { statKey: 'recon', dc: 12 },
            effects: {
              flags: { ruins_ch1_done: true, ruins_clues: 2, ruins_stage: 'ch2' },
              resources: { bauxite: 60, silver: 80 },
              affinity: 5,
              commanderExp: 25,
            },
            failEffects: {
              flags: { ruins_ch1_done: true, ruins_clues: 1, ruins_stage: 'ch2' },
              resources: { silver: 40 },
              affinity: 2,
              commanderExp: 15,
            },
            resultText: '解码成功！获取精准航路密钥（ruins_clues=2），已解锁第二章「迷雾沉船带」。',
            failText: '强电磁干扰阻断了部分波段，但仍锁定了迷雾沉船带方向，已解锁第二章。',
            nextNodeId: 'ruins_ch2_fog_fleet',
          },
          {
            id: 'c_r1_scout',
            label: '派遣高速前哨直接实地抵近采样',
            conditions: [],
            check: null,
            effects: {
              flags: { ruins_ch1_done: true, ruins_clues: 1, ruins_stage: 'ch2' },
              resources: { fuel: -15, steel: 55, silver: 65 },
              affinity: 4,
              commanderExp: 22,
            },
            resultText: '前哨舰带回深海漂浮信标残片，正式解锁第二章「迷雾沉船带」（Flag: ruins_ch1_done=true）。',
            nextNodeId: 'ruins_ch2_fog_fleet',
          },
        ],
      },
      {
        id: 'ruins_ch2_fog_fleet',
        title: '第二章 · 迷雾沉船带与护卫侦察',
        body: '舰队驶入能见度不足百米的浓雾航道。水下声呐显示沉船群间潜伏着自动警戒浮雷与旧时代护卫残骸，一枚刻有遗迹纹章的黑匣子正闪烁微光。',
        conditions: [{ type: 'flag', key: 'ruins_ch1_done', op: 'eq', value: true }],
        choices: [
          {
            id: 'c_r2_asw',
            label: '反潜班静默排雷并完整回收黑匣子（反潜 DC 13）',
            conditions: [],
            check: { statKey: 'asw', dc: 13 },
            effects: {
              flags: { ruins_ch2_done: true, ruins_key_found: true, ruins_stage: 'ch3' },
              resources: { steel: 95, bauxite: 75, silver: 110 },
              affinity: 6,
              morale: 8,
              commanderExp: 35,
            },
            failEffects: {
              flags: { ruins_ch2_done: true, ruins_key_found: false, ruins_stage: 'ch3' },
              resources: { steel: 45, silver: 55 },
              morale: -4,
              commanderExp: 20,
            },
            resultText: '完美排雷！成功夺回「遗迹海门密匙」（ruins_key_found=true），解锁第三章！',
            failText: '虽触发一枚警戒浮雷，但编队依托装甲硬抗下来并突破雾区，解锁第三章。',
            nextNodeId: 'ruins_ch3_gate',
          },
          {
            id: 'c_r2_evade',
            label: '高速蛇形机动绕过雷区切入外环（机动 DC 12）',
            conditions: [],
            check: { statKey: 'evasion', dc: 12 },
            effects: {
              flags: { ruins_ch2_done: true, ruins_key_found: true, ruins_stage: 'ch3' },
              resources: { fuel: 40, silver: 95 },
              affinity: 5,
              morale: 10,
              commanderExp: 32,
            },
            failEffects: {
              flags: { ruins_ch2_done: true, ruins_key_found: false, ruins_stage: 'ch3' },
              resources: { silver: 45 },
              commanderExp: 18,
            },
            resultText: '编队划出漂亮航迹无伤穿出雾区，顺手勾回沉船秘钥，解锁第三章！',
            failText: '擦着雷阵边缘惊险脱出，顺利推进至第三章海门前。',
            nextNodeId: 'ruins_ch3_gate',
          },
        ],
      },
      {
        id: 'ruins_ch3_gate',
        title: '第三章 · 遗迹海门破译与防线突破',
        body: '巍峨的深海石拱海门矗立在波涛中央，外围自动炮台与拦截无人机同时启动。{actor.name}请示采取智取破译还是火力强攻。',
        conditions: [{ type: 'flag', key: 'ruins_ch2_done', op: 'eq', value: true }],
        choices: [
          {
            id: 'c_r3_key_open',
            label: '插入第二章回收的黑匣子密匙静默开门（需 ruins_key_found）',
            conditions: [{ type: 'flag', key: 'ruins_key_found', op: 'eq', value: true }],
            check: null,
            effects: {
              flags: { ruins_ch3_done: true, ruins_breach_style: 'stealth', ruins_stage: 'ch4' },
              resources: { bauxite: 110, steel: 90, silver: 140 },
              affinity: 7,
              morale: 12,
              commanderExp: 45,
            },
            resultText: '海门自动解除警戒并发出欢迎蓝光！无损开启通往终章中枢的航道！',
            nextNodeId: 'ruins_ch4_sanctum',
          },
          {
            id: 'c_r3_fire_breach',
            label: '全编队集中火力摧毁外围炮台强行破门（火力 DC 14）',
            conditions: [],
            check: { statKey: 'firepower', dc: 14 },
            effects: {
              flags: { ruins_ch3_done: true, ruins_breach_style: 'assault', ruins_stage: 'ch4' },
              resources: { ammo: -25, steel: 130, silver: 135 },
              affinity: 5,
              morale: 8,
              commanderExp: 42,
            },
            failEffects: {
              flags: { ruins_ch3_done: true, ruins_breach_style: 'assault', ruins_stage: 'ch4' },
              resources: { ammo: -25, steel: 60 },
              morale: -5,
              commanderExp: 25,
            },
            resultText: '震天齐射轰碎外围防线，海门屏障应声瓦解，直指终章遗迹中枢！',
            failText: '经历一番激烈交火后总算压制了炮台，打开通往终章的缺口。',
            nextNodeId: 'ruins_ch4_sanctum',
          },
        ],
      },
      {
        id: 'ruins_ch4_sanctum',
        title: '终章 · 深海遗迹中枢的最终抉择',
        body: '中枢圣殿漂浮着一座仍在运转的深海导航核心，周围封存着大量旧时代精炼钢铝、战略燃料与古代星图。{actor.name}静静望向{commander.name}，等待你的最终决断。',
        conditions: [{ type: 'flag', key: 'ruins_ch3_done', op: 'eq', value: true }],
        choices: [
          {
            id: 'c_r4_salvage_all',
            label: '结局 A：全面拆解回收全部战略储备与金库',
            conditions: [],
            check: null,
            effects: {
              flags: { ruins_cleared: true, ruins_ending: 'salvage_all', ruins_stage: 'completed' },
              resources: { fuel: 180, ammo: 160, steel: 220, bauxite: 180, silver: 360, gold: 4 },
              affinity: 8,
              morale: 15,
              commanderExp: 70,
              commanderLuck: 2,
            },
            resultText: '★ 终章结局 A「满载凯旋」达成！港区入账巨量四项资材与金条 +4，指挥官运气 +2！',
            nextNodeId: null,
          },
          {
            id: 'c_r4_preserve_beacon',
            label: '结局 B：保留深海导航中枢运转并与港区雷达网共振',
            conditions: [],
            check: null,
            effects: {
              flags: { ruins_cleared: true, ruins_ending: 'preserve_beacon', ruins_radar_resonance: true, ruins_stage: 'completed' },
              resources: { bauxite: 200, silver: 260, gold: 5 },
              affinity: 12,
              morale: 20,
              commanderExp: 85,
              commanderLuck: 3,
            },
            resultText: '★ 终章结局 B「星海共鸣」达成！深海遗迹成为港区的永恒灯塔，金条 +5、全舰羁绊升华、指挥官运气 +3！',
            nextNodeId: null,
          },
        ],
      },
    ],
  },
];

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
    const name = String(packDef.name || '').trim();
    if (!name) throw new Error('剧情包名称不能为空');
    const id = String(packDef.id || `pack_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`);
    const nodes = Array.isArray(packDef.nodes) && packDef.nodes.length > 0
      ? deepClone(packDef.nodes)
      : [
          {
            id: 'node_01',
            title: '起始节点',
            body: '{commander.name}与{actor.name}在港区开启了新的故事篇章。',
            conditions: [],
            choices: [
              {
                id: 'c_default',
                label: '继续推进',
                conditions: [],
                check: null,
                effects: { flags: { [`${id}_started`]: true }, affinity: 3, commanderExp: 15 },
                resultText: '故事节点已完成并记录了进度标记。',
                nextNodeId: null,
              },
            ],
          },
        ];

    const pack = {
      id,
      name,
      version: String(packDef.version || '1.0.0').trim(),
      category: Object.values(PACK_CATEGORIES).includes(packDef.category)
        ? packDef.category
        : PACK_CATEGORIES.PORT_DAILY,
      description: String(packDef.description || '自定义本地事件/剧情包').trim(),
      enabled: packDef.enabled !== false,
      builtIn: Boolean(packDef.builtIn),
      entryNodeId: String(packDef.entryNodeId || nodes[0].id),
      nodes,
    };

    const idx = this._packs.findIndex((p) => p.id === id);
    if (idx >= 0) this._packs[idx] = pack;
    else this._packs.push(pack);

    await this.persist();
    this._emit('story:packs-changed', { packId: id, action: 'save' });
    return deepClone(pack);
  }

  async saveNode(packId, nodeDef) {
    const pack = this._packs.find((p) => p.id === String(packId));
    if (!pack) throw new Error('目标剧情包不存在');
    const cleanId = String(nodeDef.id || `node_${Date.now().toString(36)}`).trim();
    const node = {
      id: cleanId,
      title: String(nodeDef.title || '未命名节点').trim(),
      body: String(nodeDef.body || '').trim(),
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
    const parsed = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
    const packObj = parsed?.schema === STORY_PACK_SCHEMA ? parsed.pack : parsed;
    if (!packObj || !packObj.name || !Array.isArray(packObj.nodes)) {
      throw new Error('无效的剧情包 JSON 格式（缺少 name 或 nodes 数组）');
    }
    return this.savePack({ ...packObj, builtIn: false });
  }

  // ------------------------------------------------------------
  // Interactive Story Execution (Node Rendering + Branch Choice Settlement)
  // ------------------------------------------------------------

  _getActor(actorId = null) {
    if (actorId && this._entities?.has(actorId)) return this._entities.get(actorId);
    return this._interaction?.getSecretary() || this._entities?.list({ kind: 'character' })[0] || null;
  }

  async renderNodeView(packId, nodeId = null, { actorId = null } = {}) {
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
      flags: this.getAllFlags(),
    };

    const renderedBody = await this._narrative.run({
      template: node.body,
      variables: vars,
      polishInstruction: `请以简洁细腻的剧情演绎风格润色剧情节点「${node.title}」的叙述，保留人物与场景事实：`,
    });

    const choices = (node.choices || []).map((ch) => {
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
        renderedBody: renderedBody.text,
        source: renderedBody.source,
        degraded: renderedBody.degraded,
      },
      nodeUnlocked: nodeCond.ok,
      unmetReasons: nodeCond.unmetReasons,
      choices,
      actorName: actor?.name || '秘书舰',
    };
  }

  async executeChoice(packId, nodeId, choiceId, { actorId = null } = {}) {
    const pack = this.getPack(packId);
    if (!pack) throw new Error('剧情包不存在');
    if (!pack.enabled) throw new Error(`剧情包「${pack.name}」当前已停用，请先启用`);
    const node = pack.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error('目标节点不存在');
    const choice = (node.choices || []).find((c) => c.id === choiceId);
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
        const maxAff = this._interaction ? this._interaction.getMaxAffinityFor(actor.id) : 100;
        this._entities.adjustStat(actor.id, 'affinity', affDelta, { min: 0, max: maxAff });
        appliedChips.push({ text: `好感 ${affDelta >= 0 ? `+${affDelta}` : affDelta}`, negative: affDelta < 0 });
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
    const template = passed ? choice.resultText || '抉择已完成。' : choice.failText || choice.resultText || '行动遇阻。';
    const rendered = await this._narrative.run({
      template,
      variables: {
        actor: { name: actor?.name || '秘书舰' },
        commander: { name: cmdProfile.name },
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
      timestamp: Date.now(),
    };

    this._playHistory.unshift(record);
    if (this._playHistory.length > 30) this._playHistory.length = 30;
    await this.persist();

    if (this._logs) {
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
    const savedPacks = Array.isArray(snapshot.packs) ? deepClone(snapshot.packs) : [];
    // Ensure built-in starter packs are always present if missing
    const byId = new Map(savedPacks.map((p) => [p.id, p]));
    for (const bp of BUILTIN_STORY_PACKS) {
      if (!byId.has(bp.id)) {
        savedPacks.unshift(deepClone(bp));
      }
    }
    this._packs = savedPacks;
    this._playHistory = Array.isArray(snapshot.playHistory) ? deepClone(snapshot.playHistory.slice(0, 30)) : [];
    if (persist) this.persist();
  }
}
