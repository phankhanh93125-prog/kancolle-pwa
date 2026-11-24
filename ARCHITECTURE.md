# ARCHITECTURE

本仓库是一个**零依赖、免编译、可直接部署到 GitHub Pages** 的移动端 PWA 通用应用底座，核心由三层组成：

1. **移动端外壳层**（`index.html`、`styles/main.css`、`src/main.js`）：负责 `100dvh` 安全区域布局、顶部导航栏、中央动态挂载容器 `#app-stage`、底部快捷按钮插槽与通用输入栏，以及「模块管理 / API 设置 / 数据管理」底部抽屉。
2. **核心底层引擎**（`src/core/`）：
   - `event-bus.js`：轻量级发布/订阅事件总线（`on` / `once` / `off` / `emit`）。
   - `storage.js`：命名空间隔离的 `localStorage` 封装（每模块独享 `mod-<id>` 空间），内置 JSON 备份导出/导入与一键清空重置。
   - `api.js`：统一多模型 API 网关，同时兼容 **Google Gemini 官方 REST** 与 **OpenAI 兼容格式**，配置仅保存在本地浏览器，无 Key 时自动进入**本地模拟回显模式**。
   - `module-manager.js`：插件化模块管理器，负责模块注册校验、生命周期切换与上下文注入。
3. **可插拔功能模块层**（`src/modules/`）：每个业务功能以独立 ES Module 文件存在，默认内置 `ai-console.js` 调试模块。

---

## 新增自定义模块 3 步规范

后续任何新功能模块只需严格遵循以下 3 步即可无缝接入，无需修改底层引擎或外壳代码：

### 第 1 步：创建模块文件

在 `src/modules/` 下新建文件（例如 `src/modules/my-tool.js`），默认导出符合标准接口规范的对象（包含 `id`、`name`、`description`、`mount(container, context)`、`unmount()`）：

```js
let cleanupFns = [];

export default {
  id: 'my-tool',
  name: '示例模块',
  description: '一句话说明该模块的核心用途。',

  mount(container, context) {
    // 1. 渲染模块界面到 #app-stage
    container.innerHTML = `
      <section class="surface-card">
        <h2 class="section-title">示例模块已挂载</h2>
        <p class="muted-text" id="my-tool-output">等待输入...</p>
      </section>
    `;

    // 2. 接管底部快捷按钮与通用输入框
    context.ui.setPlaceholder('向示例模块发送指令...');
    context.ui.setQuickActions([
      {
        id: 'demo-ping',
        label: '调用大模型',
        onClick: async () => {
          const res = await context.api.chat({ prompt: '你好' });
          container.querySelector('#my-tool-output').textContent = res.text;
        },
      },
    ]);
    context.ui.setInputHandler(async (text) => {
      context.storage.set('lastInput', text);
      container.querySelector('#my-tool-output').textContent = `已保存：${text}`;
    });

    // 3. 如需跨模块通信，通过 context.bus 订阅事件并记录注销函数
    cleanupFns.push(
      context.bus.on('api:config-changed', () => {
        // 响应 API 配置变更
      })
    );
  },

  unmount() {
    // 清理事件监听、定时器与临时引用
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
  },
};
```

#### `context` 注入能力一览

| 属性 | 说明 |
| --- | --- |
| `context.storage` | 当前模块专属隔离存储（`get` / `set` / `remove` / `keys` / `getAll` / `clear` / `getUsage`） |
| `context.api` | 多模型统一网关（`chat({ prompt, messages, systemPrompt, temperature })` / `testConnection()` / `getConfig()`） |
| `context.bus` | 全局事件总线（`on` / `once` / `off` / `emit`） |
| `context.ui` | 壳层交互接口（`setQuickActions` / `setInputHandler` / `setPlaceholder` / `setInputBusy` / `showToast`） |
| `context.modules` | 模块管理器引用（可用于程序化切换模块 `modules.mount(id)`） |

### 第 2 步：注册模块并同步离线缓存清单

1. 在 `src/modules/index.js` 中导入并加入 `REGISTERED_MODULES` 数组：
   ```js
   import aiConsoleModule from './ai-console.js';
   import myToolModule from './my-tool.js';

   export const REGISTERED_MODULES = [
     aiConsoleModule,
     myToolModule,
   ];
   ```
2. 在根目录 `sw.js` 的 `CORE_ASSETS` 中补充 `'./src/modules/my-tool.js'`，并递增 `CACHE_NAME` 版本号以支持离线缓存更新。

### 第 3 步：刷新页面并切换使用

刷新浏览器后，点击顶部栏「**模块管理**」，即可看到新注册的模块并一键切换运行；如需移除或替换模块，反向删除注册项即可，不会影响其他模块的存储与运行。
