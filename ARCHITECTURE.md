# ARCHITECTURE

本仓库是一个**零依赖、免编译、可直接部署到 GitHub Pages** 的移动端 PWA 通用游戏大框架，支持**纯本地离线确定性规则运行**与**多模型 AI 增强双轨切换**，核心由三层组成：

1. **移动端外壳层**（`index.html`、`styles/main.css`、`src/main.js`）：负责 `100dvh` 全面屏安全区域布局、顶部导航栏、中央动态挂载容器 `#app-stage`、底部快捷按钮插槽与通用输入栏，以及「模块管理 / API 设置 / 数据管理（混合存储）」底部抽屉。
2. **核心底层引擎层（`src/core/`）**：
   - `event-bus.js`：轻量级发布/订阅事件总线（`on` / `once` / `off` / `emit`）。
   - `storage.js`：混合大容量存储引擎，同时封装同步 `localStorage`（轻量配置）与异步浏览器原生 `IndexedDB`（大容量存档、事件库、本地图片 Blob），支持命名空间隔离、混合占用统计与含 Blob 的 JSON 备份导出/导入。
   - `save-manager.js`：四分区多槽位存读档引擎（全局设置区、事件驱动自动存档快照区、5 个独立手动存档槽位、自定义模组数据区），支持单槽位与全库 JSON 导出/导入。
   - `calc-engine.js`：零 `eval` 安全公式解析器（递归下降解析，拦截原型链访问）、多面骰/概率检定（`roll` / `rollNotation` / `chanceCheck` / `weightedPick`）、数值钳制（`clamp`）与多层属性叠算器（`baseAdd → percentAdd → percentMult → flatFinal`）。
   - `entity-system.js`：通用实体（角色/道具/状态）注册表、属性与修饰器系统、倒计时任务注册以及**离线时间差结算器**（`settleOfflineTime`）。
   - `stat-rules.js`：新版海战舰娘数值与检定规则引擎，内置舰种预设（驱逐/轻巡/重巡/战列/航母等+自由自定义）、海战八维属性（`maxHp` 耐久、`firepower` 火力、`armor` 装甲、`torpedo` 雷击、`evasion` 机动、`recon` 侦查、`aa` 防空、`asw` 反潜）、动态状态条（`hp / morale / ap`）、四阶段好感度（支持指挥官魅力门槛减免）以及支持指挥官独立运气微调的 `1D20` 检定函数。
   - `inventory-system.js`：三核心必装槽（引擎 / 装甲 / 核心，受指挥官「整备」效能放大，全部装齐判定为适航）+ 可选服装槽 + 每角色完全自由命名的自定义选装槽位；自动区分「白值」与「装备/模块加成」，并随自定义槽位模块词条自动动态扩展任意新增属性（`getCharacterStatBreakdown`）。
   - `commander-system.js`：指挥官角色卡与成长引擎，管理姓名/头像/称号/等级经验与自由加点，构建「2 战斗（统率/战术）+ 2 舰娘（魅力/亲和）+ 2 后勤（调度/整备）」六维属性与独立初值为 `0` 的特殊属性「运气（luck）」，动态控制 3~12 人编队上限及全站战备系数。
   - `formation-system.js`：3~12 人动态上限编队与协同引擎，受指挥官「统率」实时限制席位、校验适航与非远征状态，提供 5 种可自定义系数的海战阵型（单纵/复纵/轮形/警戒/梯形）并聚合全队八维战斗属性。
   - `expedition-system.js`：港区远征派遣引擎，接入 `EntitySystem` 实时时间戳倒计时（离线/刷新持续运行），派遣空闲适航角色并在归港时按指挥官「调度」加成结算六项资源、双货币与指挥官经验。
   - `port-buildings.js`：可自定义港区建筑引擎，内置「宿舍（离线回士气/好感、投喂与扩建）」「船坞（多渠位离线维修队列、快速修复与新舰建造登记）」及「自定义建筑类型建造器（自由新建/升级/驻守并聚合全局被动增益）」。
   - `interaction-system.js`：秘书舰日常互动与誓约框架，联动指挥官「魅力/亲和」、服装、性格口癖与好感阶段，支持日常交谈、赠礼、日常事件及满好感（100）解锁的誓约仪式（突破 200 好感上限 + 全属性永久羁绊加成），并接入 `PromptPipeline` 双轨叙事。
   - `content-manager.js`：全要素图鉴统计与自定义世界内容/模组管理引擎，汇总舰娘/装备服装/敌舰档案/海域航线收集率，支持自定义敌舰/互动台词/礼物 CRUD 及整套世界内容的 JSON 模组导出与合并/覆盖导入。
   - `resource-manager.js`：六项专用资源与双货币体系——四项基础资源（燃油 `fuel` / 弹药 `ammo` / 钢材 `steel` / 铝材 `bauxite`，带仓储上限与离线自动恢复）与两项货币（银条 `silver` / 金条 `gold`，不随时间自然恢复），提供共享顶部资源概览条组件（`createResourceOverviewBar`）。
   - `log-system.js`：通用行动日志系统，自动监听 `EventBus` 记录数值变化、穿脱装备、强化、属性检定与资源流水，支持按类别筛选与一键导出纯文本摘要。
   - `fx-stage.js`：解耦演出与动效挂载层（`playEffect(type, payload)`），订阅 `EventBus` 的检定、受击、暴击、扫描与资源增减信号，提供屏幕微震、数值飘字、扫描波纹、骰子翻转状态与暴击闪烁等轻量 CSS 动效，支持通过 `registerRenderer` 独立替换升级表现层。
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
   - `port-hub.js`（默认首屏启动模块）：**港区大本营**主中枢，集成指挥官角色卡摘要、中央**秘书舰日常互动与誓约舞台**、港区指挥中枢以及点击弹出管理抽屉的**港区建筑设施网格**（宿舍、船坞、舰队编成、远征中心及玩家新建自定义建筑）。
   - `sortie-console.js`：**出征战术指挥台**，集成全队适航与油弹前置校验、按难度一键「随机生成新航线」或预设/自定义航线选择、可视化节点连接图、遇敌多回合四指令（扫描/迂回/炮击/鱼雷）全队协同交战 HUD 与大破警告。
   - `character-console.js`：角色控制台，内置 3 名开箱适航示例舰娘，展示舰种、海战八维白值与模块加成拆解、动态模块扩展属性面板、三核心必装槽适航校验、完全自由的自定义槽位建造器与 1D20 模拟检定。
   - `supply-workshop.js`：物资与工坊控制台，集成银条/金条补给商店、背包消耗品快捷使用、随机补给池以及联动指挥官「整备」减免的装备强化台。
   - `compendium-studio.js`：**图鉴与内容台**，分栏展示全要素图鉴（舰娘/装备服装/敌舰档案/海域航线收集统计），并提供自定义敌舰/台词/礼物编辑器与世界内容 JSON 模组导出/导入。
   - `action-console.js`：行动与事件控制台（支持一键设为默认启动页），集成本地适航出击校验、探索/随机事件/休整交互流、D20 检定拆解、纯本地/AI 增强双轨切换与可视化事件规则编辑器。
   - `framework-lab.js`：底层大框架自检沙盒（可通过顶部「模块管理」切换进入）。
   - `ai-console.js`：AI 多模型网关调试台。

---

## 新增自定义模块 3 步规范

后续任何新功能模块只需严格遵循以下 3 步即可无缝接入，无需修改底层引擎或外壳代码：

### 第 1 步：创建模块文件

在 `src/modules/` 下新建文件（例如 `src/modules/my-tool.js`），默认导出符合标准接口规范的对象（包含 `id`、`name`、`description`、`mount(container, context)`、`unmount()`）：

#### `context` 注入能力一览

| 属性 | 来源文件 | 说明 |
| --- | --- | --- |
| `context.commander` | `src/core/commander-system.js` | 指挥官角色卡、经验升级、六维属性（统率/战术/魅力/亲和/调度/整备）与 0 初值独立运气 |
| `context.formation` | `src/core/formation-system.js` | 3~12 人动态编队上限管理、适航/远征校验、5 种可自定义阵型与全队八维聚合 |
| `context.expeditions` | `src/core/expedition-system.js` | 港区远征派遣、离线时间戳倒计时、调度加成结算与奖励领取 |
| `context.buildings` | `src/core/port-buildings.js` | 港区宿舍、船坞维修/建造队列、自定义建筑建造器与全局被动增益 |
| `context.interaction` | `src/core/interaction-system.js` | 秘书舰指定、日常交谈/赠礼/日常事件与满好感誓约仪式（双轨台词） |
| `context.contentManager` | `src/core/content-manager.js` | 全要素图鉴统计、自定义敌舰/台词/礼物 CRUD 与世界内容 JSON 模组导出/导入 |
| `context.statRules` | `src/core/stat-rules.js` | 海战八维与检定规则、舰种预设、好感度阶段映射、士气修正与 `performCheck` |
| `context.inventory` | `src/core/inventory-system.js` | 三核心槽+自由自定义槽位、动态扩展属性拆解（`getCharacterStatBreakdown`）与装备强化 |
| `context.resources` | `src/core/resource-manager.js` | 六项资源与双货币管理、余额校验与批量扣除 |
| `context.logs` | `src/core/log-system.js` | 行动日志自动采集、分类筛选与纯文本摘要导出（`exportTextSummary`） |
| `context.fxStage` | `src/core/fx-stage.js` | 解耦动效与演出舞台（`playEffect` / `registerRenderer` / `setEnabled`），响应检定/受击/暴击/扫描 |
| `context.routeGenerator` | `src/core/route-generator.js` | 程序化随机航线生成器（低/中/高危难度、空中/潜艇威胁与海况）与持久化自定义航线仓库 |
| `context.combat` | `src/core/tactical-combat.js` | 全队多回合四指令战术交战引擎（`scan` / `evade` / `shelling` / `torpedo` + 僚机援护与补刀） |
| `context.storage` | `src/core/storage.js` | 当前模块隔离存储（同步 `get/set` 走 localStorage，异步 `getLarge/setLarge` 走 IndexedDB） |
| `context.rootStorage` | `src/core/storage.js` | 全局混合存储管理器（`getHybridStats` / `exportHybridBackup` / `importHybridBackup`） |
| `context.saves` | `src/core/save-manager.js` | 4 分区多槽位存档管理器（全局设置 / 自动存档监听 / 5 槽位手动存读档 / 模组区 / JSON 导出导入） |
| `context.calc` | `src/core/calc-engine.js` | 零 `eval` 公式计算器、`roll`、`chanceCheck`、`weightedPick`、`clamp`、`stackStat` |
| `context.entities` | `src/core/entity-system.js` | 通用实体与属性修饰器注册表、倒计时任务与离线时间差结算器（`settleOfflineTime`） |
| `context.rules` | `src/core/rule-engine.js` | 纯本地 JSON 事件节点条件校验、加权池抽取、分支选择与状态变更执行器 |
| `context.stateMachine` | `src/core/state-machine.js` | 通用阶段状态机（`addState` / `addTransition` / `transition` / `getAllowedTransitions`） |
| `context.turnStepper` | `src/core/state-machine.js` | 通用回合/周期步进器（`advance` 自动广播 `turn:advanced` 与 `cycle:completed`） |
| `context.narrative` | `src/core/prompt-pipeline.js` | 双轨叙事路由器（`local` / `ai-polish` / `ai-free`），内置模板插值与无 Key/断网自动降级 |
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
