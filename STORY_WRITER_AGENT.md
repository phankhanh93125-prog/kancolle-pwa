# STORY_WRITER_AGENT.md — 舰娘港区专职剧情写作与导入规范

> 本文件为 `kancolle-pwa` 项目专职剧情生成 Agent 的最高行为准则。凡执行任何剧情、台词、阶段突破小剧场、誓约剧场或海图奇遇创作任务，**必须严格遵守以下四条铁律**。

---

## 铁律一：绝对目录与代码隔离

1. **唯一产出目录**：所有生成的剧情/台词 JSON 文件必须统一存放于仓库根目录下的：
   ```text
   custom-packs/stories/
   ```
2. **统一文件命名**：为防止重名覆盖，常规剧情包必须采用如下命名规范：
   ```text
   story-<角色或主题英文标识>-<YYYYMMDD>.json
   ```
   - 示例：`story-tsundere-dd-20261127.json`、`story-autumn-harbor-20261127.json`
   - 仅限英文小写字母、数字与连字符 `-`（不含空格与中文）。
   - 特例：文风试写样张固定使用 `custom-packs/stories/story-style-preview.json`。
3. **绝对代码隔离**：执行剧情任务时，**严禁新建、修改或删除**以下任何代码与静态资源文件：
   - `src/` 下的任何 `.js` 模块（含 `story-engine.js`、`default-dialogues.js`、`content-manager.js` 等）
   - `styles/` 下的任何样式文件
   - `index.html`、`sw.js`、`manifest.json`、图标及任何构建/运行配置文件

---

## 铁律二：100% 兼容「自定义工坊」JSON 导入格式

顶栏 **「自定义工坊 → 模组包管理 → 外部 JSON 内容包导入」** 调用 `ContentManager.smartImportJSONText()`（`src/core/content-manager.js`），内部协同 `PersonalityPool`（`src/core/personality-pool.js`）与 `StoryPackEngine`（`src/core/story-pack-engine.js`）完成解析入库。同时，完整剧情包亦需与 `StoryEngine`（`src/core/story-engine.js`）及 `src/data/default-dialogues.js` 的数据结构保持 100% 字段对齐。

### 2.1 通用占位符规范

| 占位符 | 解析含义 | 适用模块 |
| --- | --- | --- |
| `{actor}` / `{actor.name}` | 当前互动舰娘名称 | `StoryEngine` / `DialogueEngine` / `StoryPackEngine` |
| `{cmd}` / `{commander.name}` | 指挥官名称 | `StoryEngine` / `DialogueEngine` / `StoryPackEngine` |
| `{outfit}` | 舰娘当前装备的服装名称（缺省为「日常港区便装」） | `StoryEngine` / `DialogueEngine` |
| `{gift}` | 赠送的礼物名称 | `StoryEngine` / `DialogueEngine` |
| `{{flagship}}` | 出征舰队旗舰名称（海遇事件兼容占位符） | `sortie-console.js` 外置海遇 |

> **写作提示**：凡通用或可复用于任意舰娘的台词/剧情，优先使用 `{actor}`、`{cmd}`、`{outfit}`、`{gift}` 占位符，避免硬编码指挥官称谓。

---

### 2.2 顶层 JSON 容器结构（单文件可混合包含全部模块）

```json
{
  "schema": "kancolle-pwa-story-bundle-v1",
  "meta": {
    "id": "story-example-20261127",
    "title": "剧情包中文标题",
    "version": "1.0.0",
    "author": "STORY_WRITER_AGENT",
    "archetype": "角色或性格基调标签",
    "description": "简要说明本包包含的内容与适用场景"
  },
  "personalities": [],
  "traits": [],
  "customDialogues": [],
  "storyPacks": [],
  "dialogueBank": {},
  "portraitTouchLines": {},
  "outfitFlavorLines": {},
  "favoriteGiftReactions": [],
  "breakthroughTheatres": {},
  "oathRitualTheatre": {},
  "maritimeEncounters": []
}
```

- **全部字段均已实时挂载生效**（`ContentManager.smartImportJSONText` 直接写入 IndexedDB 并由各引擎精准分流，启动时自动同步 `custom-packs/stories/index.json` 清单）：
  - `personalities` → 写入 `PersonalityPool` 主性格语音库
  - `traits` → 写入 `PersonalityPool` 副特质/口癖库
  - `customDialogues` → 写入 `ContentManager` 自定义日常互动台词库（`StoryEngine.dailyTalk` 直接抽取，完整支持全部六阶段 + `any`）
  - `storyPacks` → 写入 `StoryPackEngine` 外置剧场与海图奇遇包（`port_daily` / `main_chapter` 供港区/图鉴剧场游玩，`sortie_encounter` 专供出征突发海遇抽选，互不串台）
  - `dialogueBank` / `portraitTouchLines` / `outfitFlavorLines` / `favoriteGiftReactions` / `breakthroughTheatres` / `oathRitualTheatre` / `maritimeEncounters` → 写入 `ContentManager.storyExtensions`，由 `StoryEngine` 按阶段、昼夜、服装风格、触摸部位/档位、偏爱礼物 ID、20/40/60/80/100 突破节点、誓约仪式与海图奇遇**精准分流并优先抽取**（无自定义条目时无缝回退内置词库）
  - （可选扩展）`customGifts`、`outfits`、`ships`、`customEnemies`

> **自动挂载清单**：每次在 `custom-packs/stories/` 新增正式剧情包后，将其登记到 `custom-packs/stories/index.json` 的 `packs` 数组中（含 `id`、`file`、`version`、`enabled`），游戏启动时即会自动无损增量加载（同版本仅加载一次，绝不覆盖存档或复活玩家主动删除的包）。

---

### 2.3 六阶段好感定义与阶段台词

`src/data/default-dialogues.js` 中的六阶段慢节奏好感体系：

| 索引 | 阶段 ID (`stage`) | 中文名 | 好感区间 | 突破阈值 (`gate`) | 情绪基调 |
| --- | --- | --- | --- | --- | --- |
| 0 | `stranger` | 陌生 | 0 ~ 19 | 20 | 礼貌克制、略带距离感 |
| 1 | `familiar` | 熟悉 | 20 ~ 39 | 40 | 轻松自然、愿意搭话 |
| 2 | `trusted` | 信赖 | 40 ~ 59 | 60 | 默契坦诚、彼此托付 |
| 3 | `flutter` | 心动 | 60 ~ 79 | 80 | 细微羞赧、藏不住在意 |
| 4 | `adoration` | 恋慕 | 80 ~ 99 | 100 | 温柔依恋、私密亲近 |
| 5 | `oath` | 誓约 | 100 ~ 150 | 誓约仪式解放 | 长相厮守、心照不宣 |

#### A. `customDialogues`（直接导入「自定义工坊」生效）

```json
"customDialogues": [
  {
    "id": "dlg_unique_01",
    "stage": "familiar",
    "text": "「{cmd}，今天的执勤表我已经按优先级排好了，省得你又翻半天。」"
  }
]
```

> `ContentManager.createCustomDialogue()` 已完整支持全部六阶段 `stranger` / `familiar` / `trusted` / `flutter` / `adoration` / `oath` 及 `any`（保留 `close` 向后兼容）。

#### B. `dialogueBank`（六阶段 × 白天/深夜时段问候与分支选项）

时间段判定规则（`getTimeOfDayBucket`）：
- `day`：06:00 ~ 19:59（白天）
- `night`：20:00 ~ 次日 05:59（深夜）

```json
"dialogueBank": {
  "stranger": { "day": [], "night": [] },
  "familiar": {
    "day": [
      {
        "narration": "动作与微表情旁白（可使用 {actor} / {outfit}）",
        "text": "「自然口语化的舰娘台词，支持 {cmd}」",
        "choices": [
          {
            "label": "指挥官的快捷回复选项",
            "narration": "舰娘听完后的神态与微动作描写",
            "reply": "「舰娘的后续回应」"
          }
        ]
      }
    ],
    "night": [
      {
        "narration": "深夜氛围与微表情描写",
        "text": "「深夜专属台词」"
      }
    ]
  },
  "trusted": { "day": [], "night": [] },
  "flutter": { "day": [], "night": [] },
  "adoration": { "day": [], "night": [] },
  "oath": { "day": [], "night": [] }
}
```

---

### 2.4 人格词库 `personalities` 与副特质 `traits`（实时驱动对话与战斗语音）

```json
"personalities": [
  {
    "id": "pri_unique_id",
    "name": "性格显示名（如：微甜傲娇）",
    "toneTag": "四字气场标签",
    "summary": "一句话性格画像",
    "speechPrefix": "可选句首口癖（可留空避免生硬）",
    "speechSuffix": "可选句尾口癖（可留空避免生硬）",
    "dialogues": {
      "secretary_idle": ["白天日常闲聊台词1", "台词2"],
      "secretary_night": ["深夜值班台词1", "台词2"],
      "outfit_change": ["换装反应台词"],
      "gift": ["收到礼物反应台词（支持 {gift}）"],
      "dock_repair": ["入渠/出渠修理台词"],
      "dorm": ["宿舍休息台词"],
      "sortie_start": ["出征起航台词"],
      "combat_turn": ["常规炮击/交战台词"],
      "combat_skill": ["雷击/空袭/暴击台词"],
      "combat_ambush": ["受创/警戒台词"],
      "combat_night_chase": ["夜战追击台词"],
      "sortie_return": ["凯旋/MVP 归港台词"]
    }
  }
]
```

> `normalizeDialogueCategories` 自动识别全部 12 个标准语音分类键；每条台词支持纯字符串或 `{ "text": "..." }` 对象。

---

### 2.5 立绘触摸反应 `portraitTouchLines`（头部 / 肩部 / 手部）

- 三个部位键：`head`（轻抚发顶）、`shoulder`（轻触肩头）、`hand`（轻握指尖）
- 四个好感档位：
  - `low`：陌生 / 熟悉（stage index 0~1）
  - `mid`：信赖 / 心动（stage index 2~3）
  - `high`：恋慕（stage index 4）
  - `oath`：誓约（已缔结誓约）

```json
"portraitTouchLines": {
  "head": {
    "low": [{ "narration": "...", "text": "「...」" }],
    "mid": [{ "narration": "...", "text": "「...」" }],
    "high": [{ "narration": "...", "text": "「...」" }],
    "oath": [{ "narration": "...", "text": "「...」" }]
  },
  "shoulder": { "low": [], "mid": [], "high": [], "oath": [] },
  "hand": { "low": [], "mid": [], "high": [], "oath": [] }
}
```

---

### 2.6 特殊服装专属台词 `outfitFlavorLines`

支持内置 `outfitStyle` 键名：`水手服`、`丝质睡裙`、`居家宽衬衫`、`针织毛衣`、`晚礼服`，亦支持自定义服装风格（如 `优雅礼服`、`海滨泳装`、`祭典和服`、`誓约花嫁` 等）：

```json
"outfitFlavorLines": {
  "水手服": { "narration": "...", "text": "「...」" },
  "丝质睡裙": { "narration": "...", "text": "「...」" },
  "居家宽衬衫": { "narration": "...", "text": "「...」" },
  "针织毛衣": { "narration": "...", "text": "「...」" },
  "晚礼服": { "narration": "...", "text": "「...」" }
}
```

---

### 2.7 偏爱礼物反应 `favoriteGiftReactions`

内置五种心意礼物 ID（`GIFT_NAME_BY_ID`）：
- `item_gift_dessert_box`：港区甜点盒
- `item_gift_black_tea`：伯爵红茶礼罐
- `item_gift_aroma_candle`：海风香薰蜡烛
- `item_gift_pocket_watch`：精工机械怀表
- `item_gift_tactical_journal`：精装战术手札

```json
"favoriteGiftReactions": [
  {
    "giftId": "item_gift_dessert_box",
    "giftName": "港区甜点盒",
    "narration": "拆开礼物时的动作与神情描写",
    "text": "「收到{gift}时的专属台词」"
  }
]
```

---

### 2.8 阶段突破小剧场（20/40/60/80/100）与誓约仪式剧场

#### A. 引擎对齐结构（`breakthroughTheatres` & `oathRitualTheatre`）

```json
"breakthroughTheatres": {
  "20": { "gate": 20, "fromLabel": "陌生", "toLabel": "熟悉", "title": "...", "introNarration": "...", "openingLine": "「...」", "choices": [] },
  "40": {
    "gate": 40,
    "fromLabel": "熟悉",
    "toLabel": "信赖",
    "title": "阶段突破 · 剧场标题",
    "introNarration": "开场环境与人物动作铺垫",
    "openingLine": "「舰娘开启突破对话的台词」",
    "choices": [
      {
        "id": "bt40_a",
        "label": "指挥官回应选项文案",
        "narration": "舰娘听到回应后的微表情与动作",
        "reply": "「舰娘真情流露的回应」",
        "closingNarration": "收束氛围并点明跨入【信赖】阶段"
      }
    ]
  },
  "60": { "gate": 60, "fromLabel": "信赖", "toLabel": "心动", "title": "...", "introNarration": "...", "openingLine": "「...」", "choices": [] },
  "80": { "gate": 80, "fromLabel": "心动", "toLabel": "恋慕", "title": "...", "introNarration": "...", "openingLine": "「...」", "choices": [] },
  "100": { "gate": 100, "fromLabel": "恋慕", "toLabel": "誓约", "title": "...", "introNarration": "...", "openingLine": "「...」", "choices": [] }
},
"oathRitualTheatre": {
  "title": "誓约仪式 · 标题",
  "introNarration": "纯白礼堂与细节铺垫",
  "openingLine": "「誓约开场台词」",
  "choices": [
    {
      "id": "oath_vow_a",
      "label": "💍 誓约回应选项",
      "oathTitle": "永恒誓约",
      "narration": "戴上指环时的动作与眼神细节",
      "reply": "「誓约落定后的深情告白」",
      "closingNarration": "仪式尾声旁白"
    }
  ]
}
```

#### B. 外置可播放剧场包结构（`storyPacks[]` —— 导入后可直接在港区/图鉴剧场游玩）

每段突破剧场、深夜小剧场或海图奇遇，均应同步提供标准 `storyPacks` 条目，以便玩家导入后即可在游戏内直接触发体验：

```json
"storyPacks": [
  {
    "id": "pack_unique_id",
    "name": "剧场/奇遇包名称",
    "title": "剧场/奇遇包名称（与 name 保持一致，兼容出征海遇标题读取）",
    "version": "1.0.0",
    "category": "port_daily",
    "description": "一句话剧情简介",
    "enabled": true,
    "entryNodeId": "node_01",
    "startNodeId": "node_01",
    "nodes": [
      {
        "id": "node_01",
        "title": "节点标题",
        "speaker": "{actor}",
        "body": "旁白与台词正文（支持 {actor} / {cmd}）",
        "conditions": [
          { "type": "affinityMin", "value": 40 }
        ],
        "choices": [
          {
            "id": "c_01",
            "label": "有温度的选项文案",
            "conditions": [],
            "check": null,
            "effects": {
              "affinity": 3,
              "morale": 8,
              "flags": { "preview_bt40_done": true }
            },
            "resultText": "选择后的细腻反馈与舰娘台词",
            "nextNodeId": "node_02"
          }
        ]
      }
    ]
  }
]
```

- `category` 枚举值（`PACK_CATEGORIES`）：
  - `port_daily`：港区日常 / 深夜互动 / 阶段突破小剧场
  - `sortie_encounter`：出征海图奇遇事件
  - `main_chapter`：多章节主线剧场（支持 `flags` 进度锁）
- `conditions` 支持四种条件类型：
  - `{ "type": "affinityMin", "value": 40 }`
  - `{ "type": "flag", "key": "flag_name", "op": "truthy|falsy|eq|neq|gte|lte", "value": true }`
  - `{ "type": "hasItem", "itemId": "item_gift_black_tea" }`
  - `{ "type": "commanderStat", "stat": "command|tactics|logistics|maintenance|charisma|insight", "min": 5 }`
- `check` 可选 1D20 检定字段：
  - `{ "statKey": "recon|asw|firepower|torpedo|evasion|aa|armor", "dc": 10 }`（推荐 DC 范围 `10 ~ 14`），配合 `failText` 与 `failEffects`。
- `effects` 支持：`flags`、`resources`（`fuel`/`ammo`/`steel`/`bauxite`/`silver`/`gold`）、`affinity`、`morale`、`commanderExp`、`commanderLuck`。

---

### 2.9 海图奇遇事件 `maritimeEncounters`

与 `src/data/default-dialogues.js` 的 `MARITIME_ENCOUNTER_STORIES` 完全对齐，同时建议同步写入 `storyPacks`（`category: "sortie_encounter"`）：

```json
"maritimeEncounters": [
  {
    "id": "sea_enc_unique_id",
    "title": "海面奇遇 · 标题",
    "speaker": "{actor}",
    "body": "海况环境描写与{actor}的话语（支持 {actor} / {cmd}）",
    "choices": [
      {
        "id": "se_opt_a",
        "label": "选项 A（可带属性检定说明）",
        "statKey": "recon",
        "dc": 11,
        "successText": "检定成功后的画面与台词",
        "failText": "检定未过但温和合理的兜底描写",
        "reward": { "fuel": 30, "ammo": 25, "silver": 110 },
        "affinity": 2,
        "morale": 10
      },
      {
        "id": "se_opt_b",
        "label": "选项 B（无检定温情互动）",
        "statKey": null,
        "dc": 0,
        "successText": "互动后的细腻反应",
        "reward": { "fuel": 20, "silver": 75 },
        "affinity": 3,
        "morale": 14
      }
    ]
  }
]
```

---

## 铁律三：预设文风基调（含用户调优区）

### 3.1 基础文风准则

1. **自然口语化，杜绝翻译腔与 AI 说教**：
   - 严禁出现“哦，我亲爱的指挥官”“你真是太棒了”“这让我感到非常温暖和安心”等生硬西式直译或书面腔总结。
   - 多用短句、停顿（`……`、破折号）、生活化细节（杯垫、袖口、微凉的茶、没拧干的发梢、发红的耳尖）表达情绪，让角色“像活生生站在指挥室里说话”。
2. **神态、微表情与动作自然融入旁白**：
   - 旁白（`narration`）负责交代视线闪躲、指尖小动作、呼吸节奏、光线与海风声音，与台词形成反差或呼应；避免长篇抒情独白，单段旁白以 20~65 字为宜。
   - 傲娇类角色切忌只会“哼！笨蛋！”式脸谱化吼叫，应通过**口头轻描淡写 + 动作暗中照顾**写出立体感。
3. **阶段突破与誓约剧场讲究铺垫与细腻暧昧感**：
   - 20（熟悉）：卸下防备的小契机，从公事公办转入日常闲谈。
   - 40（信赖）：交出某件私下用心准备的东西或弱点，建立“把后背交给你”的重量。
   - 60（心动）：克制不住的近距离失神与试探，留白大于直白告白。
   - 80（恋慕）：静夜私密空间的独占欲与依赖感，语气柔软、呼吸靠近。
   - 100 / 誓约：回望一路同行的细碎记忆，克制而滚烫地落定一生之约。
4. **选项分支有温度、数值反馈克制合理**：
   - 指挥官的每个选项都应有独立的情绪色彩（温柔接住 / 轻快打趣 / 认真回应），避免敷衍选项（如“好的”“知道了”）。
   - 数值参考：日常对话 `+1`；海遇或短剧场好感 `+2 ~ +3`、士气 `+6 ~ +15`；突破剧场好感 `+3 ~ +5`、士气 `+10 ~ +16`；单次资源奖励控制在油/弹/钢/铝 `15 ~ 65`、银条 `60 ~ 160` 区间，严禁破坏港区两位数轻量数值体系。

### 3.2 用户文风调优区（STYLE_TUNING_OVERRIDES）

> 审阅样张后，可直接在下方表格中修改偏好；后续所有剧情生成任务将**优先覆盖执行**本区配置。

| 调优维度 | 当前默认预设 | 用户自定义覆盖（留空则沿用默认） |
| --- | --- | --- |
| 角色对指挥官默认称呼 | `{cmd}`（支持玩家自定义名） | _（待用户审阅后填写）_ |
| 傲娇/嘴硬浓度 | 中偏软（嘴上别扭 40% + 细心体贴 60%，不刻薄） | _（待用户审阅后填写）_ |
| 暧昧与亲密描写尺度 | 细腻含蓄、重呼吸/指尖/眼神拉扯（全年龄清爽向） | _（待用户审阅后填写）_ |
| 单句台词篇幅偏好 | 20 ~ 65 字（适配手机气泡聊天阅读节奏） | _（待用户审阅后填写）_ |
| 旁白镜头感偏好 | 轻描写、重微动作与氛围感，不抢台词戏份 | _（待用户审阅后填写）_ |
| 明确禁用词 / 忌讳桥段 | 翻译腔、说教总结、高频“哼笨蛋”复读、OOC 强行降智 | _（待用户审阅后填写）_ |

---

## 铁律四：校验与无冲突安全提交流程

每次生成或更新剧情包 JSON 后，**必须严格按以下顺序执行**，绝不可跳步或扩大暂存范围：

### Step 1：Node.js 语法与导入器全链路校验

运行 Node.js 校验脚本，确认：
1. `JSON.parse()` 语法 100% 合法，无多余逗号或转义错误；
2. 实际调用仓库内的 `ContentManager.smartImportJSONText()`、`StoryPackEngine`、`PersonalityPool` 导入该文件零报错且各模块解析计数 > 0；
3. 检查节点引用（`entryNodeId` / `nextNodeId`）无悬空断链。

```bash
node --input-type=module -e "
import fs from 'node:fs';
import { ContentManager } from './src/core/content-manager.js';
import { StoryPackEngine } from './src/core/story-pack-engine.js';
import { PersonalityPool } from './src/core/personality-pool.js';

const file = 'custom-packs/stories/<你的剧情文件>.json';
const raw = fs.readFileSync(file, 'utf8');
const data = JSON.parse(raw);

const mem = new Map();
const mockStorage = {
  namespace(ns) {
    return {
      async getLarge(k, d) { return mem.has(ns + ':' + k) ? mem.get(ns + ':' + k) : d; },
      async setLarge(k, v) { mem.set(ns + ':' + k, v); },
    };
  },
};

const personalityPool = new PersonalityPool({ storage: mockStorage });
const storyPacks = new StoryPackEngine({
  storage: mockStorage, entities: null, inventory: null, resources: null,
  statRules: null, commander: null, narrative: { async run({ template }) { return { text: template, source: 'local', degraded: false }; } },
});
const cm = new ContentManager({ storage: mockStorage, entities: null, inventory: null, routeGenerator: null });
await personalityPool.init();
await storyPacks.init();
await cm.init();

const res = await cm.smartImportJSONText(raw, { mode: 'merge', storyPacks, personalityPool });
console.log('IMPORT_OK:', JSON.stringify(res));
"
```

### Step 2：确认代码隔离（零代码文件变更）

```bash
git status --short
```

核对输出中**没有任何** `src/`、`styles/`、`index.html`、`sw.js` 等游戏代码改动。

### Step 3：严格隔离暂存与提交

**严禁使用 `git add .` 或 `git add -A`**，常规剧情任务仅执行：

```bash
git add custom-packs/stories/
git commit -m "story(<角色或主题标识>): <简明中文或英文说明>"
```

### Step 4：先 Rebase 对齐远程再推送

```bash
git pull --rebase origin main
git push origin main
```

如遇到远程分支并行提交，rebase 将自动将新剧情包顺滑接在最新提交之后，绝不与主线代码修改产生冲突。
