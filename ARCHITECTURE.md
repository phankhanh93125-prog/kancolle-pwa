# ARCHITECTURE

本仓库是一个**零依赖、免编译、可直接部署到 GitHub Pages** 的移动端 PWA 通用游戏大框架，支持**纯本地离线确定性规则运行**与**多模型 AI 增强双轨切换**，核心由三层组成：

1. **移动端外壳层**（`index.html`、`styles/main.css`、`src/main.js`）：负责 `100dvh` 全面屏安全区域布局、顶部导航栏、中央动态挂载容器 `#app-stage`、底部快捷按钮插槽与通用输入栏，以及「模块管理 / API 设置 / 数据管理（混合存储）」底部抽屉。
2. **核心底层引擎层（`src/core/`）**：
   - `event-bus.js`：轻量级发布/订阅事件总线（`on` / `once` / `off` / `emit`）。
   - `storage.js`：混合大容量存储引擎，同时封装同步 `localStorage`（轻量配置）与异步浏览器原生 `IndexedDB`（大容量存档、事件库、本地图片 Blob），支持命名空间隔离、混合占用统计与含 Blob 的 JSON 备份导出/导入。
   - `save-manager.js`：四分区多槽位存读档引擎（全局设置区、事件驱动自动存档快照区、5 个独立手动存档槽位、自定义模组数据区），支持单槽位与全库 JSON 导出/导入。
   - `calc-engine.js`：零 `eval` 安全公式解析器（递归下降解析，拦截原型链访问）、多面骰/概率检定（`roll` / `rollNotation` / `chanceCheck` / `weightedPick`）、数值钳制（`clamp`）与多层属性叠算器（`baseAdd → percentAdd → percentMult → flatFinal`）。
   - `entity-system.js`：通用实体（角色/道具/状态）注册表、属性与修饰器系统、倒计时任务注册以及**离线时间差结算器**（`settleOfflineTime`）。
   - `stat-rules.js`：通用数值与检定规则引擎，定义基础五维（`attack / burst / agility / tactics / luck`）、动态状态条（`hp / morale / ap`，支持离线恢复）、四阶段好感度映射以及标准 `1D20` 检定函数（`performCheck`，输出大成功/成功/失败/大失败及逐步计算明细），支持自定义系数持久化。
   - `inventory-system.js`：通用背包与装备/服装穿戴系统，管理全局物品仓库（「服装」「装备」「消耗品」，支持多条属性加减词条）与角色穿戴槽位（默认「服装 / 主装备 / 副装备 / 饰品」，支持增删自定义槽位），穿脱时自动重算角色最终属性并触发自动存档。
   - `resource-manager.js`：通用计数资源管理器（默认资金/补给/材料，支持自定义新增条目），提供余额校验与安全增减接口。
   - `log-system.js`：通用行动日志系统，自动监听 `EventBus` 记录数值变化、穿脱装备、属性检定与资源流水，支持按类别筛选与一键导出纯文本摘要。
   - `rule-engine.js`：纯本地确定性条件与分支事件规则引擎，支持解析通用 JSON 事件节点、加权随机事件池抽取、多选项分支跳转与本地状态变更执行器。
   - `state-machine.js`：通用状态机（`StateMachine`）与通用回合/周期步进器（`TurnStepper`）。
   - `prompt-pipeline.js`：双轨叙事路由器（`PromptPipeline`），支持 `local` / `ai-polish` / `ai-free` 一键切换，无 Key 或离线时自动无感降级为本地模板输出。
   - `asset-manager.js`：手机端图片压缩器（离屏 Canvas 压缩为 WebP 存入 IndexedDB）与确定性高颜值 SVG 几何占位图生成器。
   - `ui-kit.js`：单手友好移动端 UI 组件库（Bottom Sheet、Toast、二次确认框、进度条、分段标签页 Tabs、可折叠卡片），全量按钮 `≥ 44px` 热区并适配安全区域。
   - `api.js`：统一多模型 API 网关，兼容 **Google Gemini 官方 REST** 与 **OpenAI 兼容格式**。
   - `module-manager.js`：插件化模块管理器，负责模块注册校验、生命周期切换与全套底层引擎上下文注入。
3. **可插拔功能模块层**（`src/modules/`）：
   - `character-console.js`（默认首屏模块）：角色控制台，集成角色新建/编辑/立绘上传、五维面板、背包与服装/装备穿戴台、资源管理、行动日志、数值规则设置与实时 `1D20` 模拟检定。
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
| `context.statRules` | `src/core/stat-rules.js` | 五维与检定规则、好感度阶段映射、士气修正、`performCheck` 与规则系数配置 |
| `context.inventory` | `src/core/inventory-system.js` | 全局服装/装备/消耗品仓库、自定义穿戴槽位、穿脱联动重算与消耗品使用 |
| `context.resources` | `src/core/resource-manager.js` | 全局资金/补给/材料及自定义资源管理、余额校验与批量扣除 |
| `context.logs` | `src/core/log-system.js` | 行动日志自动采集、分类筛选与纯文本摘要导出（`exportTextSummary`） |
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
