# ARCHITECTURE

本仓库是一个**零依赖、免编译、可直接部署到 GitHub Pages** 的移动端 PWA 通用游戏大框架，支持**纯本地离线确定性规则运行**与**多模型 AI 增强双轨切换**，核心由三层组成：

1. **移动端外壳层**（`index.html`、`styles/main.css`、`src/main.js`）：负责 `100dvh` 全面屏安全区域布局、顶部 5 键快捷导航栏（模块 / 主题 / 存档 / API / 数据）、顶部横向**模块导航指示栏**（`#module-nav-strip`）、中央动态挂载容器 `#app-stage`（支持移动端防误触左右触摸滑动切换模块，启动默认首屏严格进入港区 `port-hub`）、底部快捷按钮插槽与通用输入栏，以及「模块管理 / 主题换肤与桌面布局 / 多槽位存档保险箱 / API 设置 / 数据管理（混合存储）」底部抽屉。
2. **核心底层引擎层（`src/core/`）**：
   - `event-bus.js`：轻量级发布/订阅事件总线（`on` / `once` / `off` / `emit`）。
   - `storage.js`：混合大容量存储引擎，同时封装同步 `localStorage`（轻量配置）与异步浏览器原生 `IndexedDB`（大容量存档、事件库、本地图片 Blob），支持命名空间隔离、混合占用统计与含 Blob 的 JSON 备份导出/导入。
   - `save-manager.js`：四分区多槽位存读档引擎（全局设置区、事件驱动自动存档快照区、独立手动存档槽位、自定义模组数据区），内置 Schema v2 无损迁移函数（`migrateSavePayload`，自动补齐指挥官、剧情 Flags、主题以及舰娘 `level/exp/maxExp` 默认值），支持单槽位与全量存档 JSON 备份导出/导入。
   - `theme-manager.js`：可自定义切换的 UI 主题与模块化布局引擎，内置 4 套精选 CSS Variable 皮肤（深海战术终端 / 清爽海风白蓝 / 暖光日常港区 / 暗夜鎏金指挥室），提供成对自适应高对比度表面与文字变量（`--banner-bg` / `--banner-text`、`--surface-elevated` / `--text-primary`、`--overlay-pill-bg` / `--overlay-pill-text`），支持手机端实时调色、圆角、背景纹理（grid/dots/waves/none）、打字机速度调节以及港区主页卡片顺序与显隐控制。
   - `story-pack-engine.js`：可热插拔本地事件包与多章节剧情包引擎，维护持久化全局剧情变量（Flags：布尔/计数/字符串）与前置条件锁校验（Flag、好感度、持有道具、指挥官六维与独立运气），支持多包并行开关、可视化节点编辑、单包 `.json` 导出/导入，并内置 2 套开箱即用示例包（港区日常扩展包 + 3 章节海域调查剧情包）。
   - `calc-engine.js`：零 `eval` 安全公式解析器（递归下降解析，拦截原型链访问）、多面骰/概率检定（`roll` / `rollNotation` / `chanceCheck` / `weightedPick`）、数值钳制（`clamp`）与多层属性叠算器（`baseAdd → percentAdd → percentMult → flatFinal`）。
   - `entity-system.js`：通用实体（角色/道具/状态）注册表、属性与修饰器系统、倒计时任务注册以及**离线时间差结算器**（`settleOfflineTime`）。
   - `stat-rules.js`：新版海战舰娘数值、**等级经验成长**与检定规则引擎，内置舰种预设（驱逐/轻巡/重巡/战列/航母等+自由自定义）、海战八维属性（`maxHp` 耐久、`firepower` 火力、`armor` 装甲、`torpedo` 雷击、`evasion` 机动、`recon` 侦查、`aa` 防空、`asw` 反潜）、动态状态条（`hp / morale / ap`）、舰娘 `level / exp / maxExp` 升级成长曲线（`grantShipExp` / `setShipLevelManual`，可在数值规则设置中自定义每级经验与白值成长）、四阶段好感度（支持指挥官魅力门槛减免）以及支持指挥官独立运气微调的 `1D20` 检定函数。
   - `inventory-system.js`：三核心必装槽（引擎 / 装甲 / 核心，受指挥官「整备」效能放大，全部装齐判定为适航）+ 可选服装槽 + 每角色完全自由命名的自定义选装槽位；自动区分「白值」与「装备/模块加成」，并随自定义槽位模块词条自动动态扩展任意新增属性（`getCharacterStatBreakdown`）。
   - `commander-system.js`：指挥官角色卡与成长引擎，管理姓名/头像/称号/等级经验与自由加点，构建「2 战斗（统率/战术）+ 2 舰娘（魅力/亲和）+ 2 后勤（调度/整备）」六维属性与独立初值为 `0` 的特殊属性「运气（luck）」，动态控制 3~12 人编队上限及全站战备系数。
   - `formation-system.js`：3~12 人动态上限编队与协同引擎，受指挥官「统率」实时限制席位、校验适航与非远征状态，提供 5 种可自定义系数的海战阵型（单纵/复纵/轮形/警戒/梯形）并聚合全队八维战斗属性。
   - `expedition-system.js`：港区远征派遣引擎，接入 `EntitySystem` 实时时间戳倒计时（离线/刷新持续运行），派遣空闲适航角色并在归港时按指挥官「调度」加成结算六项资源、双货币与指挥官经验。
   - `port-buildings.js`：可自定义港区建筑引擎，内置「宿舍（离线回士气/好感、投喂与扩建）」「船坞（多渠位离线维修队列、快速修复与新舰建造登记）」及「自定义建筑类型建造器（自由新建/升级/驻守并聚合全局被动增益）」。
   - `interaction-system.js`：秘书舰日常互动与誓约框架，联动指挥官「魅力/亲和」、服装、性格口癖与好感阶段，支持日常交谈、赠礼、日常事件及满好感（100）解锁的誓约仪式（突破 200 好感上限 + 全属性永久羁绊加成），并接入 `PromptPipeline` 双轨叙事。
   - `content-manager.js`：全要素图鉴统计与自定义世界内容/模组管理引擎，汇总舰娘/装备服装/敌舰档案/海域航线收集率，支持自定义敌舰/互动台词/礼物 CRUD 及整套世界内容的 JSON 模组导出与合并/覆盖导入。
   - `resource-manager.js`：六项专用资源与双货币体系——四项基础资源（燃油 `fuel` / 弹药 `ammo` / 钢材 `steel` / 铝材 `bauxite`，带仓储上限与离线自动恢复）与两项货币（银条 `silver` / 金条 `gold`，不随时间自然恢复），提供带精致矢量 SVG 图标的共享顶部资源概览条组件（`createResourceOverviewBar`）。
   - `log-system.js`：通用行动日志系统，自动监听 `EventBus` 记录数值变化、穿脱装备、强化、属性检定与资源流水，支持按类别筛选与一键导出纯文本摘要。
   - `fx-stage.js`：解耦演出、触感与音效挂载层（`playEffect(type, payload)` / `typewrite` / `playSfx`），订阅 `EventBus` 的检定、受击、暴击、扫描与资源增减信号，提供 3D D20 骰子翻转、战斗受击红光闪烁、屏幕微震、打字机流式文字展示、可选移动端震动与零依赖 Web Audio 合成音效（支持全局一键静音）。
   - `route-generator.js`：随机航线生成引擎与自定义航线仓库，支持按低/中/高危难度程序化生成 3~6 节点随机航线（含空中/潜艇威胁、玩家自定义敌舰与随机海况词条），并结合指挥官「战术」提前看穿未知节点类型。
   - `tactical-combat.js`：独立多回合多指令编队战术交战引擎，综合全队侦查、机动、火力、雷击、装甲、防空（拦截空袭）与反潜（压制潜艇）属性，并结合指挥官「战术」「亲和」「运气」触发僚机援护挡伤、协同补刀及 `fx-stage.js` 动效演出。
   - `rule-engine.js`：纯本地确定性条件与分支事件规则引擎，支持解析通用 JSON 事件节点、加权随机事件池抽取、多选项分支跳转与本地状态变更执行器。
   - `state-machine.js`：通用状态机（`StateMachine`）与通用回合/周期步进器（`TurnStepper`）。
   - `prompt-pipeline.js`：双轨叙事路由器（`PromptPipeline`），支持 `local` / `ai-polish` / `ai-free` 一键切换，无 Key 或离线时自动无感降级为本地模板输出。
   - `asset-manager.js`：手机端图片压缩器（离屏 Canvas 压缩为 WebP 存入 IndexedDB）与确定性高颜值 SVG 几何占位图生成器。
   - `ui-kit.js`：单手友好移动端 UI 组件库（Bottom Sheet、Toast、二次确认框、进度条、分段标签页 Tabs、可折叠卡片），全量按钮 `≥ 44px` 热区并适配安全区域。
   - `api.js`：统一多模型 API 网关，兼容 **Google Gemini 官方 REST** 与 **OpenAI 兼容格式**。
   - `module-manager.js`：插件化模块管理器，负责模块注册校验、生命周期切换与全套底层引擎上下文注入。
3. **可插拔功能模块层**（`src/modules/`）：
   - `port-hub.js`（默认首屏启动模块）：**港区大本营**主中枢，支持按 `ThemeManager` 自定义卡片顺序与显隐展示指挥官角色卡、带打字机特效的**秘书舰日常互动与誓约舞台**、港区指挥中枢以及点击弹出管理抽屉的**港区建筑设施网格**（宿舍、船坞、舰队编成、远征中心及玩家新建自定义建筑）。
   - `sortie-console.js`：**出征战术指挥台**，集成全队适航与油弹前置校验、按难度一键「随机生成新航线」或预设/自定义航线选择、可视化节点连接图、遇敌多回合四指令（扫描/迂回/炮击/鱼雷）全队协同交战 HUD 与大破警告。
   - `character-console.js`：角色控制台，内置 3 名开箱适航示例舰娘，展示舰种、海战八维白值与模块加成拆解、动态模块扩展属性面板、三核心必装槽适航校验、完全自由的自定义槽位建造器与 1D20 模拟检定。
   - `supply-workshop.js`：物资与工坊控制台，集成银条/金条补给商店、背包消耗品快捷使用、随机补给池以及联动指挥官「整备」减免的装备强化台。
   - `compendium-studio.js`：**图鉴与内容台**，三分栏集成全要素图鉴（舰娘/装备服装/敌舰档案/海域航线收集统计）、**热插拔事件与剧情包演绎台**（全局 Flags 进度锁、多章节演绎、节点编辑器与单包 JSON 导出导入）及自定义世界内容模组管理台。
   - `action-console.js`：行动与事件控制台（支持一键设为默认启动页），集成本地适航出击校验、探索/随机事件/休整交互流、D20 检定拆解、纯本地/AI 增强双轨切换与可视化事件规则编辑器。
   - `framework-lab.js`：底层大框架自检沙盒（可通过顶部「模块」切换进入）。
   - `ai-console.js`：AI 多模型网关调试台。

---

## 新增自定义模块 3 步规范

后续任何新功能模块只需严格遵循以下 3 步即可无缝接入，无需修改底层引擎或外壳代码：

### 第 1 步：创建模块文件

在 `src/modules/` 下新建文件（例如 `src/modules/my-tool.js`），默认导出符合标准接口规范的对象（包含 `id`、`name`、`description`、`mount(container, context)`、`unmount()`）：

#### `context` 注入能力一览

| 属性 | 来源文件 | 说明 |
| --- | --- | --- |
| `context.theme` | `src/core/theme-manager.js` | 4 套 UI 主题换肤、色板/圆角/纹理/打字机速度微调与港区卡片布局配置 |
| `context.personalityPool` | `src/core/personality-pool.js` | 本地主性格池（12+）与副特质/口癖池（12+）随机组合引擎、同舰不同性格防重复抽取与手机端词库 CRUD |
| `context.dialogueEngine` | `src/core/dialogue-engine.js` | 性格驱动动态台词与战报引擎（结合主性格×副特质、好感、服装与战损状态生成交谈/赠礼/休整/维修/战术台词，并向 AI 润色/自由模式注入人设上下文） |
| `context.storyPacks` | `src/core/story-pack-engine.js` | 热插拔本地事件包/多章节剧情包管理、全局 Flags 进度锁校验与双轨节点演绎 |
| `context.commander` | `src/core/commander-system.js` | 指挥官角色卡、经验升级、六维属性（统率/战术/魅力/亲和/调度/整备）与 0 初值独立运气 |
| `context.formation` | `src/core/formation-system.js` | 3~12 人动态编队上限管理、适航/远征校验、5 种可自定义阵型与全队八维聚合 |
| `context.expeditions` | `src/core/expedition-system.js` | 港区远征派遣、离线时间戳倒计时、调度加成结算与奖励领取 |
| `context.buildings` | `src/core/port-buildings.js` | 港区宿舍、船坞维修/建造队列、自定义建筑建造器与全局被动增益 |
| `context.interaction` | `src/core/interaction-system.js` | 秘书舰指定、日常交谈/赠礼/日常事件与满好感誓约仪式（双轨台词） |
| `context.contentManager` | `src/core/content-manager.js` | 全要素图鉴统计、示范内容大礼包无损合并、自定义敌舰/台词/礼物 CRUD 与世界内容 JSON 模组导出/导入 |
| `context.statRules` | `src/core/stat-rules.js` | 海战八维与检定规则、舰种预设、好感度阶段映射、士气修正与 `performCheck` |
| `context.inventory` | `src/core/inventory-system.js` | 三核心槽+自由自定义槽位、紧凑分类装备仓储（核心/武器/辅助/服道具 + 闲置+0 批量清理）、动态扩展属性拆解与装备强化 |
| `context.resources` | `src/core/resource-manager.js` | 六项资源与双货币管理、余额校验与批量扣除 |
| `context.logs` | `src/core/log-system.js` | 行动日志自动采集、分类筛选与纯文本摘要导出（`exportTextSummary`） |
| `context.fxStage` | `src/core/fx-stage.js` | 解耦动效、打字机、震动与合成音效舞台（`playEffect` / `typewrite` / `playSfx` / `setSoundEnabled`） |
| `context.routeGenerator` | `src/core/route-generator.js` | 程序化随机航线生成器（低/中/高危难度、空中/潜艇威胁与海况）与持久化自定义航线仓库 |
| `context.combat` | `src/core/tactical-combat.js` | 全队多回合四指令战术交战引擎（`scan` / `evade` / `shelling` / `torpedo` + 僚机援护与补刀） |
| `context.storage` | `src/core/storage.js` | 当前模块隔离存储（同步 `get/set` 走 localStorage，异步 `getLarge/setLarge` 走 IndexedDB） |
| `context.rootStorage` | `src/core/storage.js` | 全局混合存储管理器（`getHybridStats` / `exportHybridBackup` / `importHybridBackup`） |
| `context.saves` | `src/core/save-manager.js` | 4 分区多槽位存档管理器（全局设置 / 自动存档监听 / 独立手动槽位 / 无损迁移 v3 / JSON 导出导入） |
| `context.calc` | `src/core/calc-engine.js` | 零 `eval` 公式计算器、`roll`、`chanceCheck`、`weightedPick`、`clamp`、`stackStat` |
| `context.entities` | `src/core/entity-system.js` | 通用实体与属性修饰器注册表、倒计时任务与离线时间差结算器（`settleOfflineTime`） |
| `context.rules` | `src/core/rule-engine.js` | 纯本地 JSON 事件节点条件校验、加权池抽取、分支选择与状态变更执行器 |
| `context.stateMachine` | `src/core/state-machine.js` | 通用阶段状态机（`addState` / `addTransition` / `transition` / `getAllowedTransitions`） |
| `context.turnStepper` | `src/core/state-machine.js` | 通用回合/周期步进器（`advance` 自动广播 `turn:advanced` 与 `cycle:completed`） |
| `context.narrative` | `src/core/prompt-pipeline.js` | 双轨叙事路由器（`local` / `ai-polish` / `ai-free`），内置模板插值、人设上下文注入与无 Key/断网自动降级 |
| `context.assets` | `src/core/asset-manager.js` | 手机相册选图、离屏 Canvas WebP 压缩入 IndexedDB、几何 SVG 占位图生成 |
| `context.uiKit` | `src/core/ui-kit.js` | 单手友好组件库（`openBottomSheet` / `confirmDialog` / `showToast` / `createProgressBar` / `createTabs` / `createCollapsibleCard`） |
| `context.api` | `src/core/api.js` | 多模型统一网关（`chat` / `testConnection` / `getConfig` / `isMockMode`） |
| `context.bus` | `src/core/event-bus.js` | 全局事件总线（`on` / `once` / `off` / `emit`） |
| `context.ui` | `src/main.js` | 壳层交互接口（`setQuickActions` / `setInputHandler` / `setPlaceholder` / `setInputBusy` / `showToast`） |
| `context.modules` | `src/core/module-manager.js` | 模块管理器引用（`mount(id)` / `list()` / `getActive()`） |

### 第 2 步：注册模块并同步离线缓存清单

1. 在 `src/modules/index.js` 中导入并加入 `REGISTERED_MODULES` 数组（数组首项将作为默认首页挂载）。
2. 在根目录 `sw.js` 的 `CORE_ASSETS` 中补充新模块相对路径，并递增 `CACHE_NAME` 版本号以支持离线缓存更新。

### 第 3 步：刷新页面并切换使用

刷新浏览器后，点击顶部栏「**模块管理**」，即可看到新注册的模块并一键切换运行；如需移除或替换模块，反向删除注册项即可，不会影响其他模块的存储与运行。

---

## 专项系统规范（v12~v13 更新）

### 1. 五舰种差异化成长、战斗定位与大编队阶梯消耗
- **舰种成长与定位（`src/core/stat-rules.js` & `src/core/tactical-combat.js`）：**
  - **驱逐（DD）**：高成长机动/雷击/反潜，低耐久装甲，油弹基准消耗最低；鱼雷指令享有高破甲与暴击倍率，反潜对水下目标造成巨额克制伤害。
  - **轻巡（CL）**：均衡成长并突出防空/反潜/侦查；提升全队扫描成功修正与对空防御屏障，炮雷均衡。
  - **重巡（CA）**：侧重火力/装甲/耐久；炮击输出扎实，且拥有显著更高的僚机援护（护盾挡伤）触发率与减伤倍率。
  - **战列（BB）**：最高耐久/火力/装甲成长，低机动雷击，油弹基准消耗最高；炮击指令附带重炮穿甲系数（无视 45% 敌方护甲）。
  - **航母（CV）**：高侦查/防空/耐久成长；出击编队含航母时，炮击指令自动切换为「**舰载机空袭**」（受火力+侦查加成、无视前排护甲、仅受敌方防空削减），并扩大战术海图视野范围。
- **3~12 人大编队阶梯消耗公式（`src/core/formation-system.js`）：**
  - 第 `1~3` 号舰按 `100%`、第 `4~6` 号舰按 `75%`、第 `7~12` 号舰按 `55%` 累加单步油弹消耗，再统一乘以指挥官「调度」后勤减免系数。

### 2. 零立绘纯代码慢放战术战场与雷达海图
- **雷达海图（`src/modules/sortie-console.js`）**：采用战术网格 + SVG 虚线航迹 + 实时脉冲船标，超出编队视野半径（受指挥官战术、全队侦查与航母加成）的未探索节点自动覆盖战争迷雾。
- **纯 SVG 四阶段慢放战斗演出（`src/core/fx-stage.js` & `src/modules/sortie-console.js`）**：右上角提供持久化 `1x / 2x` 倍速切换；下达战术指令期间锁定按钮，依次播放「行动卡片高亮与指令横幅 → 中央纯 SVG 弹道/空袭/鱼雷/声呐/闪避轨迹 → 受击抖动红闪或情报翻转 → 驻留大号伤害飘字、血条更新与敌方反击动画」。

### 3. 宿舍全员花名册与点头像直达精修角色卡
- **全局状态汇总（`src/core/port-buildings.js`）**：宿舍面板除床位外，底部展示仓库**全部舰娘花名册**与全局状态徽章（`宿舍休整中`、`出征编队中`、`远征派遣中`、`船坞维修中`、`待命`）。
- **零中转直达角色卡（`openCharacterCardById`）**：点击宿舍、港区秘书舰舞台或舰队编成中的任意舰娘头像，自动关闭弹窗并直接进入其完整精修角色卡；顶部内置行内快捷条（`入住宿舍/移出宿舍`、`设为秘书舰`、`投喂补给恢复`、`调级/改白值`）。

### 4. 本地性格池与同舰不同性格组合引擎（v13）
- **双池随机组合（`src/core/personality-pool.js`）**：内置 12 种主性格 × 12 种副特质/口癖（144 种基础组合），并支持在角色卡「管理性格词库」弹窗中自由增删改持久化存入 IndexedDB。
- **同舰不同性格**：船坞建造新舰娘或新建角色时自动抽取不与前一只同名舰重复的 `主性格 × 副特质` 组合；角色卡顶部提供「**重新随机性格**」按钮一键重随。

### 5. 紧凑型分类装备仓储系统（v13）
- **分类筛选与单行折叠卡片（`src/core/inventory-system.js`、`src/modules/supply-workshop.js`、`src/modules/character-console.js`）**：顶部提供「全部 / 核心三件套 / 主战武器 / 战术辅助 / 服装与道具」五类标签与「全部状态 / 闲置中 / 已装备」筛选；每件装备默认以紧凑单行折叠卡片展示图标、名称、`+Lv`、精简数值与穿戴者徽章，点击展开强化/换装/调词条/删除面板，并支持「**清理闲置+0**」一键批量清理。

### 6. 性格驱动动态台词引擎与示范内容大礼包（v13）
- **动态台词与 AI 上下文注入（`src/core/dialogue-engine.js` & `src/core/prompt-pipeline.js`）**：秘书舰交谈/赠礼、宿舍休整、船坞维修及出征战斗指令均结合当前 `主性格 × 副特质`、好感、服装与战损状态（完好/中破/大破）生成鲜活台词；外部 AI 模式下自动在 System Prompt 注入完整人设、服装与战损上下文。
- **开箱示范内容大礼包与老存档保护（`src/core/content-manager.js` & `src/core/story-pack-engine.js`）**：包含 5 大舰种 8 名特色舰娘、16 件核心/主战/辅助/服装装备、低中高三档敌舰编队、16 事件港区生活日常包与 4 章节《深海遗迹调查》分支剧情包。全新存档自动加载完整大礼包；已有老存档保持原有记录不被覆盖，可在「图鉴与内容台」点击「**一键合并导入示范内容大礼包**」无损增量补全。

### 7. 独立全屏设施路由、8~15 节点分岔海图与轮流下令独立战斗界面（v14）
- **港区总枢纽 + 独立全屏设施页（`src/modules/port-hub.js` & `src/modules/port-facilities.js`）**：港区首页精简为资源栏、指挥官摘要、秘书舰舞台及清晰设施入口卡片（出征海图、舰队编成、舰娘宿舍、船坞整备、远征派遣、仓库工坊、图鉴内容库、舰娘角色卡）；所有重要设施与详情页均以独立全屏模块渲染并配备统一 `← 返回港区` 顶栏（`uiKit.createSubpageHeader`），进入全屏子页面、角色卡或战斗界面时自动锁定左右滑动切换防止误触。
- **8~15 节点分岔雷达海图（`src/core/route-generator.js` & `src/modules/sortie-console.js`）**：支持生成 8~15 节点双线分岔海图，中途可抉择「主力强攻航道（高危高钢铝）」或「暗流隐蔽航道（反潜伏击+临时锚地）」，并内置可消耗少量物资回血回士气的**临时锚地节点（`anchorage`）**。
- **按机动排序轮流下令的独立全屏战斗界面（`src/core/tactical-combat.js` & `src/modules/battle-screen.js`）**：遇敌自动隐藏海图并锁定手势进入沉浸式全屏战斗舞台，上方呈现多敌舰独立血条/护甲/弱点与**下回合意图预警**，中部为**交战距离指示器（远/中/近）**与纯 SVG 弹道/声呐/烟幕/防空/空袭演出层，底部按「机动」排序依次高亮舰娘并动态切换五舰种专属战术指令（DD 鱼雷突击/深水反潜/释放烟幕/全速突进；CL 战术炮击/鱼雷突击/防空警戒/雷达扫描；CA 重炮射击/前排援护/全速突进；BB 主炮齐射/火力压制；CV 舰载机空袭/舰载侦察 + 通用迂回撤退），配备「本回合托管」开关、`1x/2x` 倍速、昼夜战追击抉择及战后直达「船坞整备」「一键补给」快捷入口。

### 8. 敌我混合机动行动轴、开幕交锋、智能集火 AI 与动态敌军缩放（v15）
- **敌我混合机动行动轴与先制伏击（`src/core/tactical-combat.js` & `src/core/fx-stage.js`）**：参战己方舰娘与敌舰全部纳入同一 `turnQueue`，按「`evasion` + 微量随机先攻」降序穿插行动并在行动条明确区分敌我标识；进战前自动执行「己方侦查 + 指挥官战术 vs 敌方隐蔽」索敌检定，失利或踩中伏击点将触发敌方先制伏击（附带震屏与伏击预警动效）。
- **开幕航空战与开幕雷击（`src/core/stat-rules.js` & `src/core/tactical-combat.js`）**：第 1 回合前自动结算并播放纯 SVG 轨迹：双方航母触发开幕航空战（按防空 `aa` 比例拦截减伤并判定制空状态）；潜艇及高雷装舰艇触发开幕雷击（受反潜 `asw` 与机动抑制）。
- **动态 6~12 敌舰缩放、智能集火 AI 与敌军强度倍率（`src/core/route-generator.js`、`src/core/tactical-combat.js`、`src/modules/sortie-console.js`）**：中高危海域与深层节点随危级、深度、我方编队人数与强度倍率动态生成 6~12 艘混合舰种敌舰；敌方按自身舰种执行航母空袭、潜艇雷击、重巡援护、战列齐射并优先集火我方残血或高威胁目标（含锁定预警）；出征准备台内置持久化「敌军强度倍率」预设（`常规 1.0x` / `拟真高难 1.5x` / `深海炼狱 2.2x`）与 `0.5x~3.5x` 自定义滑块。

### 9. 启动封面、全站白→橙五阶品级、自定义装备/服装编辑器与高产倍率调节（v16）
- **启动封面与开局偏好设置（`src/modules/title-screen.js`、`src/core/save-manager.js`、`src/main.js`）**：启动默认呈现全屏封面，提供「继续航行」（显示最近存档指挥官名、等级、舰队人数与秘书舰）、「新的征程」（弹窗设置指挥官代号、初始舰队流派 `均衡编队/雷击先锋/重炮主力/航空制空`、开局资源模式 `标准开荒/丰饶畅玩` 及默认勾选保留个人创作内容包/性格池/UI 皮肤）与「读取存档」；顶部存档保险箱新增「返回标题画面」按钮，存档迁移升级至 Schema v4 自动无损回填品级。
- **全站统一白→绿→蓝→紫→橙五阶品级（`src/core/stat-rules.js`、`src/core/inventory-system.js`、`src/modules/supply-workshop.js`）**：所有装备模块与舰娘服装均统一接入 `common(白·普通)`、`uncommon(绿·精良)`、`rare(蓝·稀有)`、`epic(紫·史诗)`、`legendary(橙·传说)` 五阶品级，呈现品级色框与角标，支持仓库按品级筛选及历史存档自动无损推断补齐。
- **自定义装备与服装可视化编辑器（`src/modules/supply-workshop.js`、`src/modules/compendium-studio.js`、`src/core/content-manager.js`、`src/core/dialogue-engine.js`）**：仓库工坊与图鉴内容库均提供「+ 新建装备/服装」入口，覆盖核心三件套、主战武器、战术辅助与舰娘服装，支持五阶品级、SVG 图标选择、自由配置八维属性与检定加成、服装风格标签（联动秘书舰交谈台词反馈），支持保存至本地图鉴、一键发放到仓库及随世界模组 JSON 导出/导入。
- **高产出资源、品级批量拆解与倍率调节器（`src/core/resource-manager.js`、`src/core/port-buildings.js`、`src/core/route-generator.js`、`src/modules/sortie-console.js`）**：全面提升出征节点/精英/Boss 收益与高品级装备/服装箱掉落，提高港区离线每小时自然恢复速度；仓库工坊支持按品级批量拆解闲置装备返还钢材、铝材与银条；设置面板新增持久化「资源与掉落倍率」调节器（`1.0x 常规` / `2.0x 丰饶` / `3.0x 畅玩` + `0.5x~5.0x` 自定义滑块）。
- **已知装备类型扩建槽位与 Schema v5 无损迁移（`src/core/stat-rules.js`、`src/core/inventory-system.js`、`src/modules/character-console.js`、`src/core/save-manager.js`）**：确立全站统一的 9 类已知装备枚举（`主炮/鱼雷/舰载机/雷达/声呐/防空/引擎/装甲/核心`）并与自定义装备编辑器完全同源；角色卡保留固定三大核心槽位，将原自由输入槽位重构为「+ 扩建装备槽位」类型选择面板（支持变更类型、拆除槽位与同类型精准筛选穿戴），历史存档自动按已穿戴装备或关键词无损迁移至专属类型槽位。
- **单舰/全队一键最优配装、战后快捷整备与粘贴 JSON 直导（`src/core/inventory-system.js`、`src/core/formation-system.js`、`src/core/port-buildings.js`、`src/core/content-manager.js`、`src/modules/compendium-studio.js`）**：角色卡提供「一键最优配装 / 一键卸下全部」，舰队编成提供「全队一键最优配装」（按旗舰至僚机顺序按品级→强化→八维总和分配仓库最优空闲装备及服装）；出征结算与返航界面集成「全队一键补给油弹」与「受损舰娘一键入渠维修」；图鉴与内容管理台新增多行文本框支持直接粘贴 JSON 文本一键合并导入角色、装备/服装、性格词条与剧情/事件包。
- **三段式移动端骨架与统一中央沉浸主舞台（v20：`index.html`、`src/main.js`、`src/modules/port-hub.js`、`src/modules/sortie-console.js`、`src/core/story-pack-engine.js`、`src/core/tactical-combat.js`）**：
  - **顶部固定状态栏**：紧凑常驻油/弹/钢/铝/银条/金条实时余额、可点击指挥官头像/等级摘要及「主题」「存档」「封面」「系统工具」快捷入口。
  - **底部固定导航栏**：拇指友好 7 键常驻导航（「剧场港区」「出征战斗」「编队」「宿舍」「船坞」「仓库」「图鉴」），非聊天页及战斗态自动收起输入框，释放中央视口高度。
  - **统一中央主舞台（`#app-stage[data-stage-mode]`）**：在 `theatre`（Galgame 风格剧情剧场：大尺寸秘书舰/角色立绘、舰种徽记、主副性格组合标签、高对比度大号打字机对话箱、快/中/瞬速切换、历史对话回看抽屉，以及图鉴剧情包一键全屏直达演绎）、`chart`（8~15 节点分岔雷达海图，触及打捞/气象节点时原地无缝切入 2 选 1 海域遭遇剧情剧场）与 `battle`（遇敌原地展开上下对阵轮流下令战术战场，战后平滑切回海图）之间同台流转。
- **3×4 舰种符号对峙沙盘、三层式海战舞台、点击查敌舰情报与全图射程衰减（v21：`src/core/stat-rules.js`、`src/core/formation-system.js`、`src/core/save-manager.js`、`src/core/tactical-combat.js`、`src/core/fx-stage.js`、`src/modules/port-facilities.js`、`src/modules/battle-screen.js`、`src/modules/sortie-console.js`）**：
  - **双方通用 `3行 × 4列`（前/中/后排）阵型体系**：受指挥官统率上限控制，空位仅留极简雷达定位点；舰队编成重构为「上方 3×4 舰种符号阵型盘（点空位部署、点两格互换、点自身或按钮撤下，支持单纵阵/复纵阵/轮型防空阵一键排阵）+ 下方可用舰娘名册」，Schema v6 无损迁移旧存档编队至 3×4 坐标。
  - **三层式海战指挥舞台**：上层为敌我 3×4 战术雷达沙盘（隔交战距离标尺相对，纯高对比度几何舰种矢量符号 + `01~12`/`E01~E12` 编号、行动脉冲光圈、点对点格间飞行的 SVG 弹道/雷击/空袭轨迹）；中层紧贴沙盘展示当前行动舰娘与专属战术指令、托管与 `1x/2x` 倍速；下层默认展示己方舰娘全名与实时耐久/护甲状态（点名高亮上方沙盘符号），点击上方任意敌舰符号即锁定目标并临时切换下层为**敌舰情报面板**（舰名/舰种/耐久护甲/下回合意图预警/已侦查弱点/射程衰减预览 + 一键返回我方状态）。
  - **全图自由索敌、距离跨排衰减与同排/邻格护航**：取消前排硬墙限制，双方 3×4 任意存活单位均可自由瞄准，但依据「交战距离（远/中/近）+ 双方排数跨度」动态结算命中与伤害倍率（战列/航母后排跨排保持超远全威；驱逐/轻巡与鱼雷远距跨排明显衰减，前排或突进后爆发全额杀伤）；轻巡/重巡自动为同排及相邻格子队友提供防空减伤与协同援护分担。
- **全自动 JSON 字段自适应转换器与港区小剧场完整修复（v22：`src/core/content-manager.js`、`src/core/personality-pool.js`、`src/core/dialogue-engine.js`、`src/core/story-pack-engine.js`、`src/modules/port-hub.js`、`src/modules/compendium-studio.js`）**：
  - **智能字段自适应 Normalizer**：粘贴或上传 `.json`（兼容完整包对象、裸数组 `[...]`、单条目对象 `{...}` 及 Markdown 代码块）时自动识别并转换常见变体字段——涵盖性格与台词分类别名（`personalities`/`personalityPool`/`personas`/`archetypes` 及 `secretary_idle`/`idle`/`daily`、`secretary_night`/`night`、`combat_skill`/`skill` 等 10 类映射）、副特质（`traits`/`subTraits`/`quirks`）、剧情与事件包（`events`/`storyPacks`/`stories`/`chapters`、`scenes`/`nodes`/`steps`/`dialogues`、`speaker`/`name`/`character`、`text`/`content`/`line`、`choices`/`options`/`branches`、`nextText`/`reply` 与 `nextNodeId`/`nextSceneId`）、舰娘与装备服装及中英文品级自动规范化，并返回逐类统计汇总提示或明确报错。
  - **港区小剧场与动态性格台词联动修复**：修复 `port-hub.js` 未 `await` 异步 `renderNodeView` 导致的剧场无法渲染问题；中央主舞台常驻可一键点播的「选择剧场事件 / 播放剧情」快捷面板（导入包置顶优先），原生支持多幕连续 `scenes` 自动串联推进与单幕 `choices + nextText` 反馈结算、好感/士气/资源发放及「结束剧场 · 返回港区」；秘书舰日常交谈与战斗/休整台词实时从内置及新导入的 `personalities` / `traits` 词库按时段与状态抽取。
- **现代磨砂战术浮窗、装备驱动战斗指令、分舰种槽位扩建、装备升阶与海域制海权进度（v23：`src/core/ui-kit.js`、`src/core/stat-rules.js`、`src/core/inventory-system.js`、`src/core/tactical-combat.js`、`src/core/route-generator.js`、`src/core/expedition-system.js`、`src/core/port-buildings.js`、`src/modules/battle-screen.js`、`src/modules/sortie-console.js`、`src/modules/character-console.js`、`src/modules/supply-workshop.js`、`src/modules/compendium-studio.js`、`src/modules/port-facilities.js`、`src/modules/port-hub.js`、`index.html`、`styles/main.css`）**：
  - **现代磨砂战术浮窗 + 底部抽屉 + 顶部 2s Toast + 精简 4 键底部导航**：全站零原生 `alert()/confirm()`，引入 `uiKit.openTacticalModal` 居中半透明磨砂切角微光战术浮窗（应用于舰娘详情卡、船坞入渠维修、装备强化升阶详情、批量拆解、荣誉勋章、存档保险箱与主题皮肤）与 `openBottomSheet` 磨砂底部滑出抽屉（选装换装实时红绿八维数值差值对比、扩建/改型槽位）；底部导航精简为「剧场港区 / 出征海图 / 舰队编成 / 仓库图鉴」4 枚宽敞按键，仓库与图鉴顶部双标签无缝切换；3×4 编队盘下方新增实时评估条（阶梯单步油弹、全队总侦查、全队总防空）。
  - **装备驱动型战斗指令 + 3×4 实时瞄准线与命中/衰减预览**：每舰始终保留「常规射击」「机动规避 / 调整站位」通用基础指令，其余专属技能（`主炮齐射 / 鱼雷突击 / 舰载机空袭 / 防空警戒网 / 雷达校射扫描 / 声呐深弹反潜`）严格由当前实装装备解锁，未装配时置灰并标明解锁需求；3×4 战斗沙盘实时绘制行动舰娘至锁定敌舰的 SVG 瞄准矢量线与准星，并在指令条上方展示单行命中率与跨排衰减预览（舰载机空袭无视排数衰减，防空警戒网保护自身及邻格队友）。
  - **分舰种槽位上限与材料扩建 + 装备 +1~+10 强化与白→橙品级升阶**：在三大核心槽位之外实行分舰种扩建上限（`DD/SS: 2`、`CL/CA: 3`、`BB/CV: 4`），扩建与改型消耗钢材/铝材/银条并实时校验库存；仓库拆解多余装备可获得持久化「拆解余料（`salvageParts`）」，装备强化至满级 `+10` 后可消耗材料与拆解余料执行品级升阶（`白→绿→蓝→紫→橙`），突破基础属性底板并开启新一轮强化上限。
  - **海域制海权进度（`0%~100%`）与港区荣誉勋章闭环**：三大海域（`1-1 近海防卫区`、`2-1 外海破交航道`、`3-1 深海要塞核心区`）追踪制海权压制进度，击破海域 Boss 推进压制，达 `100%` 解锁下一高危海域并永久提升远征与巡航产出；新增 8 枚港区荣誉勋章浮窗，达成里程碑自动解锁并永久提升指挥官「独立运气」，直接提高高阶橙装掉率与 D20 检定收益；所有新增状态均提供无损默认值，完全兼容历史 IndexedDB 存档。
- **v25 全面重平衡与玩法扩展（Schema v8 无损迁移：`src/core/stat-rules.js`、`src/core/inventory-system.js`、`src/core/commander-system.js`、`src/core/tactical-combat.js`、`src/core/route-generator.js`、`src/core/port-buildings.js`、`src/core/expedition-system.js`、`src/core/content-manager.js`、`src/core/save-manager.js`、`src/main.js`、`src/modules/sortie-console.js`、`src/modules/battle-screen.js`、`src/modules/port-facilities.js`、`src/modules/port-hub.js`、`src/modules/supply-workshop.js`、`src/modules/character-console.js`）**：
  - **开新档彻底清档 + 外置 JSON 内容库保护**：开新档清空所有进度快照（舰娘名册、装备仓库、3×4 编队、船坞队列、制海权与勋章）并抑制内置强弹开局剧情，同时永久保留外置导入的 JSON 模板、性格词库、台词与剧情包。
  - **二位数压缩数值曲线、D20 命中/擦伤/暴击与对称护甲公式**：Lv.1 裸装 `8~25`、每级成长 `0.30~0.50`、Lv.100 裸装 `40~75`；装备白→橙底板 `+2~4` 至 `+16~22`、`+1~+10` 总计追加 `+5~+10`；敌我统一 `1d20+修正`（`≥11` 命中 `1.0x`、自然 `20` 或 `≥19` 暴击 `1.5x`、自然 `1` 或 `<11` 擦伤 `0.4x`）与对称护甲减伤 `effectiveAttack * (50 / (50 + effectiveArmor))`（主炮穿甲 `0.35`、鱼雷 `0.40`）；Schema v8 自动无损将历史 3 位数存档压缩转换至新曲线。
  - **维修舰（AR）、补给舰（AO）、后勤支援装备与锁定保护**：新增 `AR/AO`（3 扩建槽位上限、专属雷达矢量符号与远征钢铝/油弹银条增产）、`后勤/支援装备`（`战地抢修吊舱` / `海上补给箱` / `精工损管抢修套件`，战斗解锁限次 `2` 次的「战地抢修」与「前线补给」）、以及装备与舰娘的 `🔒 锁定保护` 防误拆/误删机制。
  - **自由配方即时舰船建造**：船坞与港区均提供「自由配方舰船建造」战术浮窗，`30~600` 四项资源滑块 + 实时 8 舰种概率条（含 AR/AO 特化配方）+ 零等待出坞 + 重复舰自动转化为「改造核心 ×1 + 礼盒 + 银条」。
  - **三段式出征流、随身携带补给与自定义海图工坊**：完整串联「准备出征（船坞浮窗/后勤快捷加点/随身携带油弹滑块与返航 100% 退还，耗尽触发 `-25%` 补给匮乏与夜战锁定）→ 自定义海图工坊（移除固定预设海图，支持 `1★~5★` 制海权分级、一键随机、参数工坊、种子码导入导出与预估面板）→ 航行与战斗（打捞补给、AR 免费锚地维修、外置 JSON 海域遭遇事件及战斗右上角 100% 安全撤退按钮）」。
  - **全局手势对齐与弹窗防误触锁**：左右滑屏严格对齐 4 枚底部导航标签，打开任意居中战术浮窗、底部抽屉、自定义海图工坊或处于 3×4 排阵/战斗阶段时自动锁定页面切屏手势。


---

## v27 架构升级说明（五屏零重复导航 · 气泡聊天与 6 阶慢好感 · 四大货架商店 · 手势冲突锁）

1. **静态文案与商店配置分离（`src/data/`）**：
   - `src/data/default-dialogues.js`：统一管理 6 阶好感配置（`陌生 0~19 / 熟悉 20~39 / 信赖 40~59 / 心动 60~79 / 恋慕 80~99 / 誓约 100+`）、昼夜/着装/立绘触碰（发顶/肩头/指尖）台词库、每 20 点好感阶段突破小剧场剧本及清新鲜活的随机海遇文本。
   - `src/data/shop-catalog.js`：统一管理港区四大货架商品目录（`衣装定制馆` / `心意礼物铺` / `军需物资站` / `港区特许处`）。
2. **气泡互动与慢节奏好感引擎（`src/core/story-engine.js`）**：
   - 为每位舰娘维护独立持久化的微信/QQ 式气泡聊天记录（`chatLogsByShip`）与每日闲聊好感计数（每日 `+1`，上限 5 次）；主要好感增量来自出征胜利、船坞出渠照料与背包赠礼（`+2~+5`）。
   - 支持每 20 点阶段突破小剧场直接在聊天窗内演绎与快捷回复，并在 `save-manager.js` Schema v9 迁移时自动为旧高好感存档解锁已跨过的小剧场供随时回顾；同时彻底清理所有 4 套旧版内置剧情包，严格保护玩家自行导入的外置 JSON 内容库。
3. **精简顶栏 + 五屏零重复底部导航（`index.html`、`styles/v27-layout.css`、`src/main.js`）**：
   - **Tab 1 `互动`（`port-hub.js`）**：立绘触碰区、6 阶好感条与突破小剧场、微信/QQ 式滚动气泡聊天窗、背包赠礼抽屉、衣装换装抽屉；底部通用文字输入栏仅在 Tab 1 显示且绝不被底部导航栏遮挡。
   - **Tab 2 `档案`（`character-console.js`）**：上方为指挥官六维属性卡与荣誉勋章室，下方为全员舰娘档案网格（点击打开居中磨砂详情弹窗查看八维、使用槽位扩建许可、配装与锁定）。
   - **Tab 3 `出征`（`sortie-console.js`）**：第 1 步合并完整「3×4 自由排阵编队盘 + 满编智能替换弹窗」与携带油弹配置；第 2/3 步保留 1★~5★ 制海权、自定义海图工坊与全屏 3×4 战斗安全撤退。
   - **Tab 4 `工坊`（`supply-workshop.js`）**：纯粹硬件整备台——上方为分类分页装备仓库（强化/升阶/锁定/拆解），下方直嵌船坞入渠维修队列（移除了重复商店/抽卡标签）。
   - **Tab 5 `设施`（`facilities-hub.js`）**：聚合四大货架商店、自由配方舰船建造、远征派遣与宿舍/后勤仓库基建升级、图鉴与外置 JSON 粘贴导入以及「+ 建造新自定义设施」。
4. **全局五屏横滑与 5 重手势冲突锁（`src/main.js`）**：
   - 滑块/横滑筛选条/3×4 阵型盘防穿透；纵滑即锁（`|dx| > 60 && |dx| > |dy| * 1.8`）；出征第 2/3 步锁定横滑与底栏切页（`setSortieNavLocked`）；弹窗/抽屉开启时冻结底层横滑；Tab 1 键盘聚焦自动滚动聊天窗至最新消息。
5. **全新「夜灯微醺」（`cozy_night_lamp`）暗绯红暖灯磨砂主题**与**严格零手机震动（无 `navigator.vibrate`）规范**。

---

## v28 纯粹游玩与独立「自定义工坊」分离规范

1. **远征接口对齐与全局安全重载（`src/modules/facilities-hub.js`、`index.html`、`src/main.js`）**：
   - 对齐 `ExpeditionSystem` 的真实接口 `expeditions.listActiveRuns()`（及 `run.missionName` / `run.ships`、`mission.name`），消除「设施 → 远征与基建」挂载崩溃。
   - 顶部全局异常拦截条默认提供**「安全重载界面（保留全部存档）」**（绝不触碰 IndexedDB/localStorage），并另设带二次确认弹窗的**「重置当前存档（保留已导入JSON）」**按钮，杜绝误触清档。
2. **「互动」聊天窗增量追加与零回顶流畅滚动（`src/modules/port-hub.js`）**：
   - 同秘书舰互动时通过 `renderedShipId` 与 `renderedMsgIds` 执行 DOM 增量末尾追加，禁止清空容器将 `scrollTop` 重置为 `0`，确保新气泡从当前底部平滑滑出。
3. **纯粹游玩五屏 vs 独立「自定义工坊」（`src/modules/custom-workshop.js`）**：
   - 底部 5 大主标签（`互动 / 档案 / 出征 / 工坊 / 设施`）与图鉴页严格回归纯粹游玩体验（移除散落的自定义舰娘/装备/设施/JSON 导入按钮）。
   - 顶部状态栏新增独立「**自定义工坊**」入口，全屏创作模态层集中提供四大创作分栏：`自定义舰娘`（含 AR/AO 舰种）、`自定义装备`（含 `support` 支援装）、`设施与剧情`（自定义设施 + 互动台词 + 海事奇遇）与 `模组包管理`（JSON 智能导入/启停/备份导出）。

---

## v29 确定性开新档生成器与舰娘安全退役体系

1. **全选项开新档生成器与零示范舰残留（`src/core/save-manager.js`、`src/modules/title-screen.js`、`src/main.js`、`src/core/content-manager.js`）**：
   - `buildNewGameSeedPlan(prefs)` 完整接入指挥官代号、指挥官初始偏向（六维属性差异）、初始舰娘/舰种选择（含「无初始舰 · 自由建造」空船坞模式及 DD/CL/CA/BB/CV/SS/AR/AO 单舰定制命名）、资源模式与独立掉落倍率。
   - 彻底移除开新档与首次启动时自动注入写死名字示范舰队（`示范驱逐 · 一号舰` 等）的逻辑，并保留「自定义工坊」导入的外部 JSON 内容库。
2. **舰娘安全退役与装备自动退回仓库（`src/modules/character-console.js`、`src/core/story-engine.js`、`src/core/interaction-system.js`）**：
   - 修复 Tab 2「档案」点击舰娘卡片直接打开居中磨砂战术详情抽屉，并在抽屉底部提供醒目红色「退役 / 删除舰娘」按钮，同时在未锁定且未出战的卡片操作区提供「退役」快捷入口。
   - 完整实现锁定拦截（🔒 置灰与解锁引导）、远征/船坞维修中阻断、3×4 编队中一键移出二次确认、穿戴装备自动安全卸下退回「工坊」仓库、油/钢拆解物资返还及独立聊天记录清理（`storyEngine.deleteShipChatHistory`）。

