# DSH 插件 · 浏览器半边 API（CLIENT-API）

> **状态**：v1（2026-09-30 00:0x，Asia/Shanghai）— 为 `rh-ui` 抢时间先出的可用版本。
> **实测环境**：DSH 桌面版 **0.2.0-rc.2**（Electron 44 / Node 24.18.1），profile `$DSH_HOME/profiles/desktop`。
> **证据规则**：`[实证]` = 我实际读到了运行中的成品代码 / 跑通；`[源码]` = 直接读 DSH 实现源码得出（比推断强，但未在真机跑过我们自己的插件）；`[推断]` = 由前两者推演，未验证。
> 所有 DSH 内部源码已抽取到 `probe/_ref/<包名>/`，文中的行号**同时适用于** `probe/_ref/` 与原始 `app.asar`（见 `EVIDENCE.md` 的抽取方法）。

---

## 0. TL;DR —— 先看这段，能省你半天

| 问题 | 结论 |
|---|---|
| 浏览器半边怎么加载？ | 不用打包。手写一个 `.js`，内容是一个 IIFE 调用 `window.__ModuleLoader__.load({id, factory})`，`factory(require)` 里同步定义一切，**`return module.exports`**。 |
| 能 `require` 什么？ | ① 平台种子词：`react`、`react/jsx-runtime`；② 任何**声明了 `dsh.client` 且排在你这行前面的 DSH 客户端包**（如 `@deepseek-ai/dsh-client-ui-slots`）。其它一律抛错。 |
| 设置页插件区开 tab？ | `ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({name:'settings.plugins.tab', id:'runninghub', order:30, label:()=>'RunningHub', locale:NS, inject:()=>({...})}, Component))` |
| tab 组件收到什么 props？ | `{...标准 runtime props（含 renderSlot/useResource/useSessions 等）, t（来自 locale:NS）, ...inject() 返回的键}` |
| host 数据怎么拿？ | **`ctx.remote.$mount(contribution)` + 描述符**（mcp-panel 生产路径，**推荐**）。`host.call` **只存在于 `cordis-client-runner` 的动态浏览器半边**，静态包拿不到（详见 §6）。 |
| CSS 怎么写？ | 静态包**没有** `styles.insert`。自己 `ctx.effect(() => { 建 <style> ; return () => el.remove() })`，选择器用 `[data-dsh-runninghub]` 前缀，颜色只用 `var(--dsw-*)` token。 |
| 入口由谁指定？ | `package.json` 的 `exports["./client"].default`，且必须在 `dsh.client` 里声明 `platform: "web"`。 |

**最小骨架**（复制 `probe/client-minimal/client.js` 即可跑，见 §8）。

---

## 1. 三个"半边"必须分清（这是最容易搞错的地方）

DSH 有**两套完全不同的**浏览器端插件机制，符号面不同，混用必炸：

| | **A. 静态客户端包**（我们要用的） | **B. 动态浏览器半边**（agent 运行期写的插件） |
|---|---|---|
| 谁加载 | `@deepseek-ai/dsh-client-modules` 扫 `dsh.client` | `@deepseek-ai/dsh-cordis-client-runner` |
| 代码形态 | 一个 bundle 文件，`window.__ModuleLoader__.load({id, factory})` | 一段 **async 函数体**字符串，参数即符号面 |
| 能拿到什么 | 只有 `factory(require)` | `React`、`console`、`styles`、`host`（**没有** require/fetch/setTimeout） |
| 与 host 通信 | `ctx.remote.$mount` + 描述符 | `host.call(method, args)` ↔ host 侧 `harness.handle(method, fn)` |
| 证据 | `probe/_ref/dsh-client-modules/lib/index.js:104-111` | `probe/_ref/dsh-cordis-client-runner/lib/client.js:49-70, 71-105` |

> `probe/_ref/dsh-cordis-client-runner/lib/client.js:54-55` 原文：
> `fetch: "network belongs to the HOST half: register a handler there with harness.handle(method, fn) and call it here via host.call(method, args)."`、
> `require: "modules cannot be imported here. React arrives as the \`React\` closure symbol; everything else goes through ctx services or host.call."`
>
> —— 这两句直接证明：`host` / `styles` / `host.call` 是 **B 套**的东西。**我们的插件是 A 套**，所以别照抄 B 的写法。

---

## 2. `package.json` 要写什么 `[实证]`

出处：`dsh-mcp-panel/package.json:18-32`（exports）、`:47-61`（dsh 段）。

```jsonc
{
  "name": "dsh-runninghub-plugin",
  "type": "module",
  "main": "./host/index.mjs",              // 宿主半边入口（Lead 负责）
  "exports": {
    ".":       { "default": "./host/index.mjs" },
    "./client":{ "default": "./client/client.js" }   // ← 必须叫 "./client"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",                   // 必填，字符串
      // 【依赖顺序】这些包的客户端半边必须先到位。写 DSH 真实包名。
      "inject": [
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-settings"
      ]
      // "external": ["@deepseek-ai/dsh-api-gateway/client"],  // 可选：bundle 里 require 的 `<pkg>/client` 子路径
      // "immediately": false                                 // 可选：是否随外壳立即加载
    }
  }
}
```

字段校验规则（**照抄源码，别猜**）：

- `probe/_ref/dsh-client-modules/lib/index.js:63-68`
  `dsh.client.platform` 必须是 string；`inject`/`external` 必须是 string[]；`immediately` 必须是 boolean —— 否则 **加载期就 throw**（`:63` 起）。
- `probe/_ref/dsh-client-modules/lib/index.js:170-180`（`clientExportOf`）：
  `exports["./client"]` 只接受 **字符串**，或**带字符串 `default` 的对象**；否则
  `throw new Error('client-modules: <pkg> exports["./client"] must be a string or an object with a string default')`。
  → 所以 `{ "types": "...", "default": "./lib/client.js" }` 是合法写法（mcp-panel 就这么写）。
- `probe/_ref/dsh-client-modules/lib/index.js:718-719`：声明了 `dsh.client` 却没有 `exports["./client"]` →
  `throw new Error('client-modules: <pkg> declares dsh.client but exports no "./client" bundle')`。

### `inject` vs `external` 的区别 `[源码]`

| 字段 | 语义 | 出处 |
|---|---|---|
| `dsh.client.inject` | **包名**列表。宿主把这些包的客户端半边也编进启动图，**排在你这行之前**。 | `probe/_ref/dsh-client-modules/lib/index.js:656-659`（`arriveGraphRow` 遍历 `row.inject` 先 `arriveDependency`） |
| `dsh.client.external` | **require 说明符**列表（可为 `<pkg>/client` 形式）。图中若有该行，先物化再加载你。 | `probe/_ref/dsh-client-modules/lib/index.js:650-655`（`stripClientSuffix(request)` 后查 `graphRows`） |

> 实践建议：把你要 `require` 的包**同时**写进 `inject`（保险），或者只写 `external`。mcp-panel 只写了 `inject`（因为它只 require react）。

---

## 3. 客户端 bundle 的确切格式 `[实证]`

### 3.1 成品长什么样

出处：`$DSH_HOME/profiles/desktop\node_modules\dsh-mcp-panel\lib\client.js:1-8`（头）与文件尾（`return module.exports`）。

```js
window.__ModuleLoader__.load({
  id: "dsh-mcp-panel",                       // 必须等于包名
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");
    /* ... 你的全部代码 ... */
    exports.apply  = apply;
    exports.inject = inject;
    exports.name   = name;                    // 可选
    return module.exports;
  }
});
```

**关键点（全部来自成品代码）：**

1. `factory` 是**同步**执行的（`probe/_ref/dsh-client-modules/lib/client.js:683` 直接调用，无 await）→ **顶部不能有 `await`**。
2. 一切副作用（包括建 `<style>`）都要么同步，要么放进 `apply()` / `ctx.effect()`。
3. JSX 不能直接用（无编译器）。用 `react_jsx_runtime.jsx(type, props)` / `jsxs(...)`，或 `React.createElement`。
   mcp-panel 成品就是 `jsx("div", {className: ..., children: ...})` 这种写法。
4. 返回值必须 `return module.exports`（不是 `exports`）—— `probe/_ref/.../client.js:683` 用的是 factory 的**返回值**。

### 3.2 `require` 的解析规则（这是硬边界）

`probe/_ref/dsh-client-modules/lib/client.js:697-706`：

```js
makeRequire(ownerId, edges) {
  const require = (spec) => {
    edges.add(spec);
    if (this.seed.has(spec)) return this.seed.get(spec);          // ① 平台种子词
    const id = stripClientSuffix(spec);                            // ② 去掉 "/client" 后缀
    const record = this.loadCache.get(id);                         // ③ 已物化的图行
    if (record !== void 0) return record.exports;
    if (this.factories.has(id)) return this.materialize(id).exports;
    throw new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`);
  };
  ...
}
```

- ① **种子词**来自外壳的 `options.staticModules`（`probe/_ref/dsh-client-modules/lib/client.js:548`）。
  实测成品只用 `react` 与 `react/jsx-runtime`；`dsh-client-ui-settings-plugins/lib/client.js:7-9` 是 `require("@deepseek-ai/dsh-client-ui-slots")` + 两个 react 词。
  → **`@deepseek-ai/dsh-client-ui-slots` 能 require 是因为它是图行，不是种子词。**
- ② `stripClientSuffix` 让 `"@deepseek-ai/dsh-api-gateway/client"` 与 `"@deepseek-ai/dsh-api-gateway"` 解析到同一个包。
- ③ 物化是**记忆化 + 同步**的；require 环会抛
  `client-modules: require cycle through "<id>" (factory-form CJS cannot deliver partial exports)`（`:677`）。

**可 require 的 DSH 客户端包共 71 个**（我用脚本扫的全树，见 `probe/_scanclient.cjs`）。与 UI 相关的常用项：

| 包名 | 用途 |
|---|---|
| `@deepseek-ai/dsh-client-ui-slots` | `SlotOwnershipError` / `StaleAuthorizationError` / `InjectFace` 等类型与常量（renderer 用它） |
| `@deepseek-ai/dsh-client-ui-renderer` | slot 渲染器宿主（`ctx.slots` 的实现在这里，**不要重复 install**） |
| `@deepseek-ai/dsh-client-ui-primitives` | 官方基础组件库（530 KB，最大的一个） |
| `@deepseek-ai/dsh-client-locale` | 本地化（`ctx.locale.register/bind`） |
| `@deepseek-ai/dsh-api-remotes` | `ctx.remote` facade（`$mount`） |
| `@deepseek-ai/dsh-api-gateway` | Remote 网关实现（通常经 remotes facade 用，别直连） |

> ⚠️ **未验证**：我没有实测过 `require("@deepseek-ai/dsh-client-ui-primitives")`。若 `rh-ui` 想用官方组件，**第一件事就是先试这一句**，失败就退回纯 DOM + 自带 CSS（mcp-panel 就是纯 DOM + 自带 CSS，最稳）。标 `[推断]`。

---

## 4. 插件对象的形状 `[实证]`

出处：`dsh-mcp-panel/src/client/index.ts:55-58`、`:85-124`。

```js
export const name   = 'dsh-mcp-panel';                              // 可选，便于诊断
export const inject = ['slots', 'locale', 'remote', 'sessions'];    // 客户端服务名
export async function apply(ctx) { /* ... */ }
```

- `inject` 是**客户端**服务名（不是包名！）：`slots`、`locale`、`remote`、`sessions`、`connection`…
- `apply` 可以是 async（加载器会 await；与 factory 的同步限制无关）。
- mcp-panel 的注释（`:57`）明确写：`remote.mcpPanel` 要在**自己 mount 之后**才存在，所以它先 `await ctx.remote.$mount(...)`，再用 `ctx.inject(['remote.mcpPanel'], scope => ...)` 包住 slot 注册。**这个顺序是必需的，别颠倒。**

---

## 5. `settings.plugins.tab` —— 精确注册参数 `[实证]`

### 5.1 槽位官方目录（运行时里嵌了一份权威文档）

出处：`probe/_ref/dsh-cordis-client-runner/lib/client.js:4663-4708`（这是 `client-ui-slots` 的 slot 目录表，**运行时真值**）：

```
key: "settings.plugins.tab"
kind: "list"
scope: "root"
summary: "One page inside the Plugins settings section."
doc: "One page inside the Plugins settings section. The section owner renders
      localized entry labels as tabs and mounts each contribution inside its
      corresponding tab panel. Options: `id` (tab key), `order` (tab order),
      and `label` (registrant-localized tab text). Declared at runtime by the
      feature that owns the Plugins section; ..."
registerOptions: [
  { name: "id",    requirement: "required", type: "string",
    doc: "Your cell key. Use an id of your own: a fresh id is added beside the
          shipped entries, while reusing a shipped id puts you in THAT cell and
          replaces it. ..." },
  { name: "order", requirement: "optional", type: "number",
    doc: "Position among the entries, ascending (default 0)." },
  { name: "label", requirement: "optional", type: "string | (() => string)",
    doc: "Display text where the owner projects one (nav rows, tabs). A thunk is
          re-read on every projection, so localized text follows the active
          locale without re-registering." }
]
ownerProps: SettingsPluginsTabOwnerProps { children?: never }   // 该槽所有者不传任何 props
declaredBy: "an entry in 'settings.section' (client-ui-settings-plugins),
             so it exists while that entry is mounted"
occupants: ["client-ui-settings-plugin-inventory PluginInventorySettingsTab id 'all'"]
replaceRisk: "none"
source: "packages/client/ui-settings/src/client/contract/slots.ts:66"
```

**结论（照抄即可）：**

- `id` 必填，自取（建议 `'runninghub'`），**不要**用别人的 id（会覆盖）。
- `order` 可选，数值升序。已占用：`'all'`（plugin-inventory，order 未知）、`'mcp'`（mcp-panel，**order 30**，`src/client/index.ts:118`）。→ 建议我们用 **40 或 60**，排在 MCP 后面。
- `label` 可以是 `string` 或 **`() => string`**。**要跟着中英文切换就必须用 thunk**（每次投影重读，无需重注册）。
- 该槽的 `ownerProps` 是空（`children?: never`），所以别指望从父级拿业务数据。

### 5.2 生产级注册代码（照抄这段）

出处：`dsh-mcp-panel/src/client/index.ts:115-122`（**运行中的成品**）。

```js
slots.inject('settings.plugins.tab', () => slots.register({
  name: 'settings.plugins.tab',
  id: 'runninghub',                       // 自取；别撞 'all' / 'mcp'
  order: 40,                              // mcp 用了 30
  label: () => t('tab'),                  // thunk → 跟随语言
  locale: NS,                             // 让你拿到 props.t
  inject: () => ({ workflows, refresh, runWorkflow }),   // → props.workflows / props.refresh / props.runWorkflow
}, RunningHubTab));
```

- `slots` 的获取（mcp-panel 因为跨版本漂移用了结构化断言，我们可以直接 `scope.slots`）：
  `dsh-mcp-panel/src/client/index.ts:93-97` 用 `scope.get('slots')`。我们直接 `scope.slots` 即可（我们的 baseline 是 0.2.0-rc.2）。
- `slots.inject(key, cb)` 的语义（`probe/_ref/dsh-client-ui-renderer/lib/client.js:1343-1402`）：
  **槽位被声明之前不执行回调**；声明出现时执行；声明消失时自动清理已注册的东西；槽位重新声明（epoch 变）会**重跑**回调。
  → 所以「设置页没打开时注册不生效」是**正常的**，打开设置页才会注册进去。
- `slots.register(options, component)` 返回 disposer，并且**本身就是一个 `ctx.effect`**
  （`probe/_ref/dsh-client-ui-renderer/lib/client.js:1788-1792`：`return this.ctx.effect(() => this._register(options, component), "slots.register()")`）。
  → 不要把它再包一层 `ctx.effect`，会双重注册。

### 5.3 组件收到的 props `[实证]`

出处：`dsh-mcp-panel/lib/types/client/McpPanelTab.d.ts:19-21`。

```ts
export type McpPanelTabProps =
    PropsRuntime<'settings.plugins.tab'>       // 标准 runtime props
  & PropsLocale<'settings.mcpPanel'>           // 提供 t()，来自注册项 locale: NS
  & InjectFace<McpPanelTabInjected>;           // 把 inject() 返回对象的键拍平进来
```

对应的运行时装配在 `dsh-client-ui-renderer` 的 `_register` 路径
（`probe/_ref/dsh-client-ui-renderer/lib/client.js:1662-1663`：`copyUnique("hook", hooks, contribution.hooks, ...)` / `copyUnique("keyed hook", ...)`）。

**标准 runtime props 里有用的**（来自 slot 目录的 `standardProps`，`dsh-cordis-client-runner/lib/client.js:4691-4699`）：

```
useResource, useWorkspaces, usePanelInfo, useSessions, useSessionStatus, useSessionRetainInfo
```

注意：**是小驼峰的 hook 名**，且是**已绑定好的可调用 hook**（`standardHookPropName`）。想做数据订阅就 `props.useSessions(sel => ...)`。

> `[推断]`：`renderSlot` 本身不在 `settings.plugins.tab` 的 standardProps 列表里（那个列表是 6 个 hook）。
> `renderSlot` 属于「子槽所有者」能力（`probe/_ref/dsh-client-ui-renderer/lib/client.js:330-333` 会校验
> `slot '${key}' is not declared by this entry's children`）。我们要自己声明子槽才能用 —— 见 §5.4。

### 5.4 自己声明一个子槽（工作流详情/节点编辑要用）`[源码]`

`probe/_ref/dsh-client-ui-renderer/lib/client.js:330-333` 的报错证明：`renderSlot` 只能渲染**本注册项自己声明的子槽**。声明方式与注册一致，`register` 时带 `slots: { 'my.child': { kind: 'list' } }`（Factory 走 `registerFactory`）。
**`[推断]`**：具体 `slots` 声明对象的确切 schema 我还没读到确证行，**`rh-ui` 若要用子槽，先找我确认或直接照 `dsh-client-ui-renderer` 的 `registerFactory` 分支**（`probe/_ref/dsh-client-ui-renderer/lib/client.js:1706+`）。

**结论：v1 建议不要用子槽**，工作流的展开/折叠用我们自己组件内的 React state 做，最稳（也符合 DESIGN.md §0.2「默认不展开」）。

---

## 6. host ↔ client 数据通道

### 6.1 `host.call` —— **对我们的插件不可用** `[源码，强证据]`

- `host.call` 的签名只出现在**动态浏览器半边**的符号表里：
  `probe/_ref/dsh-cordis-client-runner/lib/client.js:6164` → `signatures: ["host.call(method: string, args?: JsonValue): Promise<JsonValue>"]`
- 它的教学文案（`:6540`、`:6553-6560`）写明：由宿主半边的 `harness.handle(method, fn)` 应答，**双向只过 JSON**，省略参数过 `null`。
- `probe/_ref/dsh-cordis-client-runner/README.zh.md:32` 原文：
  「它拿到一组固定的名字——`React`、`console`、`styles` 与 `host`；而 `fetch`、`setTimeout` 这类浏览器全局不可用。」
- 而我们的**静态 bundle 只有 `factory(require)`**（§3.2），**没有 `host` 这个标识符**。

> **所以：`host.call` 方案否决。** 它属于 B 套（动态半边），A 套拿不到。
> 唯一能看到 `host.call` 的场景是：走 `cordis/request-run` 让用户在页面上批准运行一个「动态插件定义」。我们的插件是要随 profile 常驻安装的，不走那条路。
> **下一步（如果有人非要 `host.call`）**：那就要放弃静态包、改用动态插件分发机制 —— 与 DESIGN.md §1「不构建、随包安装」冲突，**不建议**。

### 6.2 唯一可行通道：`ctx.remote.$mount(contribution)` + 描述符 `[实证]`

这就是 mcp-panel 的生产链路，**已在桌面版跑着**。完整拆解：

#### ① 描述符（Host 与 Client 共享同一份对象）

出处：`dsh-mcp-panel/src/wire.ts:316-325`（无参方法）、`:345-359`（带参方法）、`:507-513`（清单）。

```js
// 无参
const STATUS_DESCRIPTOR = Object.freeze({
  id: 'dsh-runninghub-plugin#runninghub/status',
  service: 'runninghub',                 // ← ctx.remote.runninghub
  namespace: 'runninghub',
  method: 'status',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([]),
  result: strictCodec('dsh-runninghub-plugin/types#Snapshot', SNAPSHOT_SCHEMA),
  sourceLocation: Object.freeze({ file: 'src/wire.ts', line: 1, column: 1 }),
});

// 带参（每个参数一个 descriptor）
parameters: Object.freeze([Object.freeze({
  name: 'workflowName',        // ← 方法签名里的形参名
  wire: 'workflowName',        // ← 线上字段名
  source: 'json',
  codec: strictCodec('...#WorkflowName', z.string()),
})])
```

`strictCodec(typeRef, zodSchema)` 把 zod schema 包成 Typert 的 codec（`dsh-mcp-panel/src/wire.ts` 里定义，zod **v4**）。

#### ② Host 半边：一个 `TypertRemoteService` 子类

出处：`dsh-mcp-panel/src/service.ts:194-196`、`:222-223`、`:287`。

```ts
export class RunningHubService extends TypertRemoteService {
  static inject = ['loader', 'tools'];
  constructor(ctx, config) {
    super(ctx, 'runninghub');          // ← 服务名 = namespace
    // ...
  }
  status() { return { /* 纯 JSON */ }; }      // 无装饰器
}
```

**关键（`service.ts:280-283` 的注释原文）**：
> 「Exported on the wire by the `mcpPanel/status` invocation descriptor in `./wire.ts` … — **no method decorator, so the built bundle stays plain ESM**.」
→ 用描述符清单导出方法**不需要** `@Remote` 装饰器。**这对我们的「不构建」硬约束极其有利**：不用 TS 装饰器语法。

Host 侧 manifest（`src/typert.host.ts:15-25`，导出为包的 `./typert`）：

```js
export const TYPERT = Object.freeze({
  package: 'dsh-runninghub-plugin',
  face: 'host',
  schemas: Object.freeze([]),
  invocations: RUNNINGHUB_INVOCATIONS,
  model: Object.freeze({ services: [], events: [], objects: [] }),
});
```

> ✅ **已解决（2026-09-30 更新）**：host 侧**已实证跑通**，纯 `.mjs`、无装饰器、无 TS、**连 zod 都不需要**。
> 完整骨架与原始日志见 **`docs/dsh/PLUGIN-API.md` §11**（`host/rpc.mjs` 可直接落）。三条关键结论：
> 1. 服务类：`class X extends TypertRemoteService { constructor(ctx, rt) { super(ctx, 'runninghub') } }`，`import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'`。
> 2. codec：`api-gateway/lib/index.js:1513` 只做 `codec.create().parse(value)` → 手写 `{ mode:'strict', typeSymbol, create: () => ({ parse: fn }) }` 就够，**不需要 zod**。
> 3. 注册：`package.json` 的 `exports["./typert"]` 会被 `dsh-typert-loader` 自动发现（manifest 的 `package` 必须**严格等于包名**）；**或**手工 `ctx.typert.register(TYPERT)` —— `probe/_ref/dsh-typert-loader/lib/index.js:27-28` 注释明写这是给 hand-written wire schemas 的正式通道，**更推荐**。
>
> **对 client 半边的影响：无。** `ctx.remote.$mount(contribution)` 的 contribution 形状不变（`{ package, descriptors }`），只需保证描述符数组**与 host 是同一份**（mcp-panel 的做法：两边都 import `wire.ts` 里的 `MCP_PANEL_INVOCATIONS`）。

#### ③ Client 半边：mount 贡献 + 调用

出处：`dsh-mcp-panel/src/client/remote.ts:46-50`、`src/client/index.ts:91-114`。

```js
// client/remote.js —— 与 host 共享同一份 INVOCATIONS
export const RUNNINGHUB_REMOTE = Object.freeze({
  package: 'dsh-runninghub-plugin',
  descriptors: RUNNINGHUB_INVOCATIONS,
});

// apply() 里：
await ctx.remote.$mount(RUNNINGHUB_REMOTE);        // ← 注册 ctx.remote.runninghub

ctx.inject(['remote.runninghub'], (scope) => {
  const unwrap = (result, method) => {
    if (!result.ok) throw new Error(`runninghub.${method} failed: ${result.error.code}: ${result.error.message}`);
    return result.value;
  };
  const status = async () => unwrap(await scope.remote.runninghub.status(), 'status');
  // ...
});
```

- 返回值是 **`RemoteResult<T>`**（判别联合）：`{ ok: true, value }` / `{ ok: false, error: { code, message } }`。
  **不会 reject** —— 必须自己 unwrap（`src/client/index.ts:99-104`）。
- `ctx.remote.$mount()` 返回 disposer；`dsh-api-remotes/lib/client.js:13538` 的官方用法就是
  `disposers.push(await ctx.remote.$mount(contribution))`。
- `inject: ['remote']` 后才能用 `ctx.remote`；`remote.<ns>` 要 mount 之后才存在，所以用 `ctx.inject(['remote.runninghub'], ...)` 兜住。

#### ④ 能把什么过线 `[源码]`

`probe/_ref/dsh-cordis-client-runner/lib/client.js:6553-6560` 的教学文案：
> `Both directions carry JSON only: pass plain JSON data as the argument — or omit it, and the handler receives null — and answer from harness.handle(...) with JSON`

→ **只过 JSON**。图片/Blob/Uint8Array **不能**直接过线。方案：
- 小图（缩略图）→ base64 字符串过线；
- 大文件 → host 侧另开 HTTP 路由（`ctx.webServer.register`）或走附件 URL，client 用 `<img src>`。`[推断]`，未实测。

---

## 7. CSS 与主题 token

### 7.1 静态包怎么插样式 `[实证]`

出处：`dsh-mcp-panel/src/client/styles.ts:21-40`（**注意开头的注释**）：

> 「Standalone client bundles cannot use the in-repo CSS-module pipeline, so the sheet ships as a string and is installed effect-scoped into a `<style data-dsh-mcp-panel>` element. Every selector is scoped under `[data-dsh-mcp-panel]` and uses theme design tokens only, so it follows both color schemes.」

```js
// 引用计数 + 幂等 disposer 的完整实现见 styles.ts:11-40
export function installPanelStyles() {
  let element = document.querySelector('style[data-dsh-runninghub]');
  if (element === null) {
    element = document.createElement('style');
    element.dataset.dshRunninghub = '';
    element.textContent = CSS;
    document.head.append(element);
  }
  return () => { /* 计数归零才 remove */ };
}

// apply() 里：
ctx.effect(() => installPanelStyles(), 'dsh-runninghub: stylesheet');
```

- **`styles.insert(css)` 不可用**（那是 B 套的，`probe/_ref/dsh-cordis-client-runner/lib/client.js:71-105`），别照抄。
- `ctx.effect(fn, label)` 的 `fn` 返回 disposer → 插件卸载时自动摘掉样式。

### 7.2 主题 token `[实证]`（来自 mcp-panel 生产 CSS）

`dsh-mcp-panel/src/client/styles.ts` 里实际用到的 token（直接用 `var(...)`）：

| token | 语义（从用法推断 `[推断]`） |
|---|---|
| `--dsw-alias-label-secondary` | 次级文字颜色（`styles.ts:51`） |
| 其余见 `styles.ts` 全文（506 行 CSS，建议直接抄样式思路） | |

> ⚠️ **`cordis_inspect_query(platform=client, provider=Theme, method=listTokens)` 我这边调用超时**（3 次，各 10 s）：
> `Error: Theme.listTokens: Client inspect query timed out after 10000ms. Open or reconnect the Harness page, then retry.`
> 同样超时的还有 `Builtin.listBuiltins`、`Slots.listSubTree`。
> **推测原因**：client 类 Inspect 需要**本会话的** Harness 页面处于连接状态；我这个 subagent 会话可能没有可应答的页面（`[推断]`）。
> **补救**：`rh-ui` 在自己的会话里重试这三个查询（很可能成功）；同时我已经把权威来源换成了源码直读：
> 主题实现在 `probe/_ref/dsh-client-ui-theme/lib/client.js`（101 KB，token 定义应该在里面）。
> **建议**：v1 先用 `var(--dsw-*)` 保守取值 + `color: inherit` 兜底，不要硬编码颜色。

---

## 8. 最小可跑 host + client 双半插件

完整可安装形态在 **`probe/client-minimal/`**（含 `package.json` + `cordis.patch.yml` + `host/index.mjs` + `client/client.js` + README）。
目标：**设置页 → 插件 → 出现一个 "RunningHub Probe" tab，点开显示 host 传回的一行文本。**

`client/client.js` 骨架（可直接抄）：

```js
window.__ModuleLoader__.load({
  id: "dsh-runninghub-probe",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const jsx = require("react/jsx-runtime");

    const NS = "settings.runninghubProbe";
    const en = { tab: "RunningHub Probe", hello: "Host says:" };
    const zh = { tab: "RunningHub 探针", hello: "宿主返回：" };

    const inject = ["slots", "locale", "remote"];

    function RunningHubTab(props) {
      const t = props.t;
      const [line, setLine] = React.useState("(loading)");
      React.useEffect(() => {
        let alive = true;
        props.ping()
          .then((v) => { if (alive) setLine(String(v)); })
          .catch((e) => { if (alive) setLine("error: " + (e && e.message)); });
        return () => { alive = false; };
      }, []);
      return jsx("div", {
        "data-dsh-runninghub": "",
        style: { color: "var(--dsw-alias-label-secondary)" },
        children: [jsx("p", { children: t("hello") }, "h"), jsx("pre", { children: line }, "v")],
      });
    }

    async function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "runninghub-probe: dicts");
      await ctx.remote.$mount(RUNNINGHUB_REMOTE);
      ctx.inject(["remote.runninghubProbe"], (scope) => {
        const slots = scope.slots;
        const t = scope.locale.bind(NS);
        const ping = async () => {
          const r = await scope.remote.runninghubProbe.ping();
          if (!r.ok) throw new Error(`runninghubProbe.ping failed: ${r.error.code}: ${r.error.message}`);
          return r.value.line;
        };
        slots.inject("settings.plugins.tab", () => slots.register({
          name: "settings.plugins.tab",
          id: "runninghub-probe",
          order: 40,
          label: () => t("tab"),
          locale: NS,
          inject: () => ({ ping }),
        }, RunningHubTab));
      });
    }

    exports.name = "dsh-runninghub-probe";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
```

Host 半边（见 `probe/client-minimal/host/index.mjs`）：`TypertRemoteService` 子类 + `TYPERT` 导出，返回 `{ line: "hello from host" }`。

---

## 9. 未确认 / 风险清单（**别当成已验证**）

| # | 事项 | 状态 | 下一步 |
|---|---|---|---|
| 1 | 手写 `.mjs`（无 TS、无装饰器）能否让 `TypertRemoteService` + 描述符清单注册成功 | ✅ **已实证**（`probe/remote-probe.mjs`，见 `PLUGIN-API.md` §11.1） | — |
| 2 | `exports["./typert"]` 是否必需、loader 如何发现 `TYPERT` | ✅ **已实证为"非必需"**：`ctx.typert.register()` 是正式手工通道（`typert-loader/lib/index.js:27-28`）；`./typert` 导出走 loader 自动发现，manifest `package` 必须严格等于包名 | 二选一即可 |
| 3 | `require("@deepseek-ai/dsh-client-ui-primitives")` 是否可用 | 未测 | `rh-ui` 首个试验；失败就纯 DOM + 自带 CSS |
| 4 | client 类 Inspect（Slots/Theme/Builtin）超时原因 | 未确认 | `rh-ui` 在**自己的**会话里重试（很可能是页面连接问题，与插件无关） |
| 5 | 自声明子槽的确切 `slots` 声明 schema | `[推断]` | v1 避开子槽（用组件内 state） |
| 6 | 大文件（图/视频）怎么过线 | `[实证]` 结论：**Remote 只过 JSON**，实测 28 MiB 单次返回值无障碍（`PLUGIN-API.md` §11.3 F）；但图片**不该**走 Remote —— 图片/视频走**工具回执的 ContentBlock**（`PLUGIN-API.md` §4），UI 展示走 Remote 的**文本/URL/概要** | 设计已定 |
| 7 | `settings.plugins.tab` 组件里能否拿到 `renderSlot`（自声明子槽） | `[源码]` 需自己声明子槽才合法 | v1 不用 |

### 9.1 给 `rh-ui` 的"最小可跑"建议路径

1. 先只做**纯静态**：`slots.register` 一个 tab，组件里渲染硬编码文案 + `ctx.locale` 的 `t()`。**先证明 tab 能出现。**
2. 再加 `ctx.remote.$mount(RUNNINGHUB_REMOTE)` + `scope.remote.runninghub.status()` 取一行文本。**证明通道通。**
3. 最后接 `workflowList()` 渲染列表 + 展开节点（组件内 `useState`，不用子槽）。

每一步都独立可回退；第 1 步失败 = 客户端包声明问题，第 2 步失败 = Remote 描述符问题，第 3 步失败 = 数据形状问题 —— 分得清。

---

## 10. 出处索引（可复核）

| 内容 | 路径:行 |
|---|---|
| `__ModuleLoader__` facade 注入 | `probe/_ref/dsh-client-modules/lib/index.js:453-498` |
| `dsh.client` 字段校验 | `probe/_ref/dsh-client-modules/lib/index.js:63-68` |
| `exports["./client"]` 解析 | `probe/_ref/dsh-client-modules/lib/index.js:170-180` |
| 启动图依赖顺序（inject/external） | `probe/_ref/dsh-client-modules/lib/index.js:644-661` |
| `require` 三级解析 + 报错原文 | `probe/_ref/dsh-client-modules/lib/client.js:696-706` |
| factory 同步物化 / 环检测 | `probe/_ref/dsh-client-modules/lib/client.js:670-695` |
| `settings.plugins.tab` 权威目录 | `probe/_ref/dsh-cordis-client-runner/lib/client.js:4663-4708` |
| `host.call` 签名与教学文案 | `probe/_ref/dsh-cordis-client-runner/lib/client.js:6164, 6553-6560` |
| B 套符号面（React/console/styles/host） | `probe/_ref/dsh-cordis-client-runner/README.zh.md:32, 75` |
| `styles.insert` 实现（B 套） | `probe/_ref/dsh-cordis-client-runner/lib/client.js:71-105` |
| `slots.inject` 实现 | `probe/_ref/dsh-client-ui-renderer/lib/client.js:1343-1402` |
| `slots.register` = ctx.effect | `probe/_ref/dsh-client-ui-renderer/lib/client.js:1788-1794` |
| `renderSlot` 子槽归属校验 | `probe/_ref/dsh-client-ui-renderer/lib/client.js:330-333` |
| `locale.register/bind` | `probe/_ref/dsh-client-locale/lib/client.js:1387-1422` |
| 官方 slot+locale 用法示例 | `probe/_ref/dsh-client-locale/lib/client.js:1553-1560` |
| 成品 bundle 头 | `dsh-mcp-panel/lib/client.js:1-8` |
| 成品 bundle 尾（exports） | `dsh-mcp-panel/lib/client.js` 末 12 行 |
| 成品 apply()（slot 注册全流程） | `dsh-mcp-panel/src/client/index.ts:85-124` |
| 成品 Remote 贡献 | `dsh-mcp-panel/src/client/remote.ts:46-50` |
| 成品 host service（无装饰器） | `dsh-mcp-panel/src/service.ts:194-196, 222-223, 280-287` |
| 成品 host manifest | `dsh-mcp-panel/src/typert.host.ts:15-25` |
| 成品描述符 | `dsh-mcp-panel/src/wire.ts:316-325, 345-359, 507-513` |
| 成品 CSS 策略 | `dsh-mcp-panel/src/client/styles.ts:1-40` |
| 成品 package.json | `dsh-mcp-panel/package.json:18-32, 47-61` |
| 71 个客户端包扫描脚本 | `probe/_scanclient.cjs` |
| 源码抽取脚本 | `probe/_extract.cjs`, `probe/_extract2.cjs` |
