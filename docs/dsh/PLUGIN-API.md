# DSH 插件 · 宿主半边 API（PLUGIN-API）

> **实测环境**：DSH 桌面版 **0.2.0-rc.2**（Electron 44.0.0 / Node 24.18.1），profile `$DSH_HOME/profiles/desktop`。
> **证据标注**：`[实证]` = 我真跑过并贴了原始输出；`[实证-成品]` = 正在生产环境运行的插件（dsh-mcp-panel@0.6.17 / dsh-blender-plugin）里的代码；`[源码]` = 直接读 DSH 0.2.0-rc.2 实现源码；`[推断]` = 未验证。
> **证据方法**（可复现）：用 Electron 的 Node 模式直接读 `app.asar` 里的 DSH 实现。
> ```powershell
> $env:ELECTRON_RUN_AS_NODE=1
> & "D:\Program Files (x86)\deepseekharness\DeepSeek Harness.exe" -e "const fs=require('fs');console.log(fs.readdirSync('D:\\Program Files (x86)\\deepseekharness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai').length)"
> # → 289
> ```
> 抽取脚本：`probe/_extract.cjs`（43 个核心包）、`probe/_extract2.cjs`（按需追加）。产物在 `probe/_ref/<包名>/`。

---

## 0. 结论速查

| 问题 | 结论 | 证据等级 |
|---|---|---|
| 插件入口形状 | `export const name` / `export const inject = ['tools']` / `export const Config = z.object({})` / `export async function apply(ctx, config)`；**也支持函数插件 + `exports.default ?? exports`** | `[实证-成品]` |
| `defineTool` 从哪来 | `import { defineTool } from '@deepseek-ai/dsh-tools'` | `[实证-成品]` |
| 参数 schema 写法 | **手写 JSON-Schema 风格对象字面量**（`{ type:'string', required:true, description }`）或 schemastery；`defineTool` 内部转成 JSON Schema | `[源码]`+`[实证-成品]` |
| 工具返回图片让聊天渲染 | `execute()` 返回 **value**；`output.render(args, value)` 返回 **`ContentBlock[]`**，图片块 = `{ type:'image', attachment: ImageAttachmentRef }` | `[实证-成品]`+`[源码]` |
| `ctx.jobs` 自定义 kind | **接受**。运行时只校验 `kind.length > 0` 和 `label.length > 0` | `[实证]` ✱ |
| 标准 `job_list`/`job_output` 能读到吗 | **能**，只要 owner 匹配：`job_list` 显示「caller-owned + unowned」，无 kind 过滤 | `[实证]`+`[源码]` |
| 内部提示词注入 | `ctx.systemPrompt.section({name, order, text})`；`order` 用 `ctx.systemPrompt.getSectionOrder('TOOL_X')` | `[源码]` |
| 多 Key 存储 | `ctx.credentials` 的 `CredentialRef` **一个 ref 只能存一个值**；多 Key 用 `CredentialKey`（`<scope>/<id>`）+ `modifyRecord` | `[源码]` |
| host↔client 通道 | `TypertRemoteService` 子类 + 描述符数组 + `ctx.typert.register()`；**纯 .mjs 无装饰器可行** | `[实证]` ✱ |

---

## 1. host 半边入口形状 `[实证-成品]`

出处：`dsh-mcp-panel/src/index.ts:44-49, 86`、`dsh-blender-plugin\src\index.ts:178`。

```js
// host/index.mjs —— 纯 ESM，无构建
export const name = 'dsh-runninghub-plugin';        // 诊断用
export const inject = ['tools'];                    // 硬依赖的服务键；缺一个就不激活
export const Config = z.object({ /* ... */ });       // schemastery schema（可选）
export async function apply(ctx, config) { /* ... */ }
```

- **`inject` 是硬依赖**：列进去的服务缺失 → 插件 fiber 不激活（静默不加载，这是"插件整体消失"的主因之一）。**可选服务不要写进 `inject`**，用 `ctx.get('x')` 或 `ctx.inject(['x'], scope => ...)`。
- `Config` 用 schemastery（`@deepseek-ai/schemastery`）。blender 插件用 `createRequire` 双名解析（有/无 scope 两种包名），见 `dsh-blender-plugin/src/index.ts:168-175` `[实证-成品]`。
- **函数插件也支持**：mcp-panel 的注释（`src/index.ts:26-27`）原文：
  > 「Function plugin — no default export (**the Loader unwraps `exports.default ?? exports`**).」

---

## 2. `apply()` 里的生命周期规则

| 动词 | 语义 | 出处 |
|---|---|---|
| `ctx.effect(() => disposer, label)` | 注册一个随 fiber 卸载自动执行的清理。**注册类调用一律包在这里** | `[源码]` |
| `ctx.inject(['svc'], scope => ...)` | **服务出现时才跑回调**，消失时自动清理。可选服务的标准写法 | `dsh-mcp-panel/src/index.ts:125-135` `[实证-成品]` |
| `await ctx.plugin(ServiceClass, config)` | 挂一个子插件/服务；返回后服务已可用。**注意 await 之后 fiber 可能已被销毁** | `dsh-mcp-panel/src/index.ts:93, 112` |
| `ctx.get('name')` | 可选服务读取，**必须判 undefined** | `dsh-blender-plugin/src/index.ts:601-602` `[实证-成品]` |

**mcp-panel 的黄金写法**（`src/index.ts:125-135`，`[实证-成品]`）：

```js
// 可选服务：命令注册表
ctx.inject(['commands'], (scope) => {
  scope.effect(() => scope.commands.register(mcpCommand(service, resolved.outputLanguage)), 'dsh-mcp-panel: /mcp command')
})

// 可选服务：jobs —— 同时挂 controller 和注册工具
ctx.inject(['jobs'], (scope) => {
  scope.effect(() => scope.jobs.attachController('dsh-mcp-panel'), 'dsh-mcp-panel: jobs controller')
  if (resolved.probeEnabled) {
    scope.effect(() => scope.tools.register(mcpProbeTool(service, scope.jobs, resolved.probeTimeoutMs)), 'dsh-mcp-panel: probe tool')
  }
})
```

**`await` 之后必须重新检查 fiber**（`dsh-mcp-panel/src/index.ts:108-113` 的注释 + 代码）：

```js
await ctx.plugin(McpPanelService, {...})
// A02: mounting the service opens an await window inside `apply`. If this
// fiber was disposed while it resolved, stop here — a listener or tool
// registration now would either throw INACTIVE_EFFECT or leak into a dead fiber.
if (ctx.fiber.uid === null) return
```

### 2.1 ⚠️★Cordis 把 Service 包在 Proxy 里 —— `#private` 字段会炸★ `[实证]`

**这是本次探针抓到的最有价值的一个坑，所有服务类都适用。**

`@deepseek-ai/cordis/lib/index.js:120` 用 `Object.apply` 把服务的方法包了一层 Proxy。于是方法里的 `this` 是 **Proxy**，而 Proxy **不携带私有字段**：

```
TypeError: Cannot read private member #startedAt from an object whose class did not declare it
    at Proxy.ping (…/host/index.mjs:50:23)
    at Proxy.invokePrepared (…/dsh-api-gateway/lib/index.js:732:25)
```

复现：`probe/client-minimal/host/index.mjs` 早期版本里 `#startedAt = Date.now()`，`probe/client-minimal/selftest.mjs` 调用 `runninghubProbe/ping` 时炸。

**规则**：
- 服务类里**一律用普通属性**（`this.startedAt = …`）或**闭包变量**，**不要用 `#private`**。
- 同理：`WeakMap` 关联实例也行，但普通属性最省事。
- **不适用于**：非 Service 的普通类、工具定义里的闭包（那些不走 Proxy）。

> ✅ **对 `host/rpc-remote.mjs` 无影响**：它用 `Object.defineProperty` + 闭包捕获 `methods`，没有任何私有字段（已实证跑通）。
> ⚠️ **对 `host/rpc.mjs`（Lead 的）与 `host/core/**`（rh-core）有影响**：任何 `class X extends Service` 或 `extends TypertRemoteService` 的类，检查一遍有没有 `#`。

---

## 3. `ctx.tools.register(defineTool({...}))` 完整字段

### 3.1 出处与 import

- `import { defineTool } from '@deepseek-ai/dsh-tools'` —— `probe/_ref/dsh-tool-jobs/lib/index.js:4`、`dsh-mcp-panel/src/probe.ts:21` `[实证-成品]`
- `defineTool` 定义在 `probe/_ref/dsh-tools/lib/index.js:838`
- 注册：`ctx.tools.register(definition): () => void`（`cordis_inspect_query(host/Service/tools)` 原始签名）

### 3.2 `defineTool` 接受的字段（`probe/_ref/dsh-tools/lib/index.js:838-860` + `:461-472`）`[源码]`

```js
defineTool({
  name: 'runninghub_search',                  // 必填
  description: '…',                           // 必填，模型看的就是它
  parameters: {                               // 参数 spec（会被转成 JSON Schema）
    kind: { type: 'string', required: false, description: '…' },
    limit: { type: 'number', description: '…' },
  },
  output: {                                   // ★必填★ 没有它 register 会 throw
    schema: { type: 'object', additionalProperties: false, properties: { … } },
    render: (args, value) => [{ type: 'text', text: '…' }],   // → ContentBlock[]
    presentationMeta: (args, value) => ({ … }),               // 可选
  },
  timeoutMs: 120000,                          // 可选；必须是正有限数
  async execute(args, exec) { return value }, // 返回 value，必须满足 output.schema
  finalizeContent: (exec, result) => ContentBlock[] | undefined,   // 可选
  projectContent: (…) => …,                   // 可选
  presentCall: (…) => …,                      // 可选
  presentResult: (…) => …,                    // 可选
  isConcurrencySafe: (…) => boolean,          // 可选
  deferLoading: true,                         // 可选
})
```

**硬校验（会 throw，插件整体挂掉）**：
- `probe/_ref/dsh-tools/lib/index.js:461-467`：
  ```js
  const output = definition.output;
  if (output === undefined || typeof output !== 'object'
      || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  }
  assertSupportedJsonSchema(output.schema);
  ```
- `:847`：`timeoutMs` 非正有限数 → `defineTool(<name>): timeoutMs must be a positive finite number`
- `:1191-1193`：`execute` 返回值不过 `output.schema` → `ToolOutputError: tool "<name>" returned invalid output: …`
- `:1197-1200`：`render` 抛异常 → `output.render failed: …`
- `:95`：projector 返回非 lossless JSON → `output.<projector> returned non-lossless JSON`

### 3.3 参数 schema 到底怎么写 `[实证-成品]`

**两条路都行，`defineTool` 都吃：**

**① 手写对象字面量（推荐，零依赖）** —— `dsh-mcp-panel/src/probe.ts:271-277`（生产代码）：

```js
parameters: {
  server: {
    type: 'string',
    required: true,
    description: 'serverName of a configured MCP server (see /mcp for the list); …',
  },
},
```

**② schemastery** —— `dsh-tool-jobs/lib/index.js:300-309` 也是同样的对象字面量风格；`dsh-tool-subagent` 用 schemastery（`z.string().min(1).required()`，见 `probe/_ref/dsh-tool-subagent/lib/index.js:9, 253`）。

**结论**：`parameters` 是 **DSH 自己的参数 spec DSL**（不是 JSON Schema 也不是 schemastery），最稳的写法就是 ①。需要 `enum` / `min` / `max` 时用 `assertAuthorKeys` 支持的键（`probe/_ref/dsh-tools/lib/index.js:555-556, 609, 655`）。**`[推断]`**：完整的 key 白名单我还没逐个列全，遇到"key is not supported by the value schema DSL"报错时按该报错信息调整。

### 3.4 `output.schema` 的写法 `[实证-成品]`

- 严格 schema（推荐）：普通 JSON Schema 对象。`dsh-mcp-panel/src/probe.ts:278-291`。
- 万能 schema：`const ANY_SCHEMA = { type: 'json' }` —— `dsh-blender-plugin/src/index.ts:919`，配 `output: { schema: ANY_SCHEMA, render: renderOne }`（`:974` 等 12 处）。**要返回 attachment 引用（见 §4）时用这个最省事。**

---

## 4. ★工具返回值 → 聊天里渲染图片/视频★ `[实证-成品]` + `[源码]`

### 4.1 数据流

```
execute(args) → value
    ↓ 校验 output.schema（不过 → ToolOutputError）
output.render(args, value) → ContentBlock[]
    ↓ snapshotProjection()
ToolExecutionResult.content  → 聊天消息
```
出处：`probe/_ref/dsh-tools/lib/types/index.js:1188-1221`。

### 4.2 `ContentBlock` 的完整类型集 `[源码]`

`probe/_ref/dsh-subagent/lib/typert.host.js:315-323`：

```ts
export type ContentBlock = ContentBlockMap[ContentBlockType];
export interface ContentBlockMap {
    text: TextBlock;
    reasoning: ReasoningBlock;
    image: ImageBlock;
    file: FileBlock;
    'tool-call': ToolCallBlock;
    'tool-addition': ToolAdditionBlock;
    'tool-removal': ToolRemovalBlock;
}
```

**工具结果里实际有意义的只有三类**（blender 插件源码注释，`src/index.ts:633-635`，`[实证-成品]`）：
> 「宿主对 tool 结果只透传 **ContentBlock[]（text/image/file）**，没有 json block」

### 4.3 精确形状 `[源码]`（`probe/_ref/dsh-subagent/lib/typert.host.js`）

```ts
// :814-815
export interface TextBlock  { type: 'text';  text: string }

// :434-439  ★图片★
export interface ImageAttachmentRef {
    attachmentId: AttachmentId;
    mediaType: ImageMediaType;        // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    bytes: number;
    width: number;
    height: number;
    name?: string;
    originalDimensions?: { width: number; height: number };
}
export interface ImageBlock { type: 'image'; attachment: ImageAttachmentRef; offloaded?: true }

// :378-383  ★视频/音频/任意文件★
export interface FileAttachmentRef { attachmentId: AttachmentId; name: string; bytes: number }
export interface FileBlock { type: 'file'; attachment: FileAttachmentRef }
```

### 4.4 生产级实证代码（blender 插件，**正在桌面版跑着**）`[实证-成品]`

`dsh-blender-plugin\src\index.ts:598-626`：

```js
/** PNG → durable attachment（失败不再静默：返回 {ref} 或 {why}） */
async function toAttachment(ctx, data, name) {
  try {
    const attachments = ctx.get('attachments')
    if (!attachments) return { why: '宿主没有 attachments 服务（ctx.get("attachments") 为空）' }
    const mediaTypes = attachments.imageLimits?.mediaTypes ?? []
    if (!mediaTypes.includes('image/png')) return { why: '宿主 imageLimits.mediaTypes 不含 image/png（' + JSON.stringify(mediaTypes) + '）' }
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name })
    return {
      ref: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      },
    }
  } catch (e) {
    return { why: 'saveImage 失败：' + String((e && e.message) || e) }
  }
}

function renderOne(_args, value) {
  const blocks = [{ type: 'text', text: String((value && value.text) || '') }]
  if (value && value.image) blocks.push({ type: 'image', attachment: value.image })
  if (value && Array.isArray(value.images)) for (const im of value.images) blocks.push({ type: 'image', attachment: im })
  return blocks
}

// 注册时：
output: { schema: ANY_SCHEMA, render: renderOne },   // ANY_SCHEMA = { type: 'json' }  (:919)
```

**这就是"在真机上贴出过图片"的实证路径**（该插件是 desktop profile 的 `@dsh-external/dsh-blender-plugin`，`package.json:5`，**生产可用**，不是推断）。

### 4.5 ★可抄：`runninghub` 返回图片/视频★

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

const ANY_SCHEMA = { type: 'json' }   // 或写严格 schema；attachment 引用是普通 JSON 对象

/** Uint8Array → {type:'image'} block（失败返回 null + 原因，让回执能说明白） */
async function imageBlock(ctx, data, name, mediaType = 'image/png') {
  const attachments = ctx.get('attachments')
  if (!attachments) return { why: '宿主无 attachments 服务' }
  const ok = (attachments.imageLimits?.mediaTypes ?? []).includes(mediaType)
  if (!ok) return { why: `宿主不接受 ${mediaType}，可用：${JSON.stringify(attachments.imageLimits?.mediaTypes)}` }
  const ref = await attachments.saveImage({ data, mediaType, name })
  return { block: { type: 'image', attachment: {
    attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes,
    width: ref.width, height: ref.height, ...(ref.name === undefined ? {} : { name: ref.name }),
  } } }
}

/** Uint8Array → {type:'file'} block（视频/音频走这条） */
async function fileBlock(ctx, data, name) {
  const attachments = ctx.get('attachments')
  if (!attachments) return { why: '宿主无 attachments 服务' }
  const ref = await attachments.saveFile({ data, name })   // 原样字节，无准入限制
  return { block: { type: 'file', attachment: { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes } } }
}

// 在 task.wait / workflow.run 的 execute 里：
const png = await downloadToBytes(url)                 // 你自己的工作
const r = await imageBlock(ctx, png, `runninghub-${taskId}.png`)
return r.block
  ? { text: `任务 ${taskId} 完成`, images: [r.block] }
  : { text: `任务 ${taskId} 完成，但回传失败：${r.why}`, images: [] }

// render：
function renderResult(_args, value) {
  const blocks = [{ type: 'text', text: String(value?.text ?? '') }]
  for (const im of value?.images ?? []) blocks.push(im)      // 已是 {type:'image'|'file', attachment}
  return blocks
}
output: { schema: ANY_SCHEMA, render: renderResult }
```

### 4.6 ★视频的正确形状★

**没有 `video` block 类型**（`ContentBlockMap` 里没有）。视频只能走 **`file` block**：

```js
{ type: 'file', attachment: { attachmentId, name, bytes } }
```

- 由 `attachments.saveFile({ data: Uint8Array, name? })` 产出（`SaveFileAttachment` 定义见 `cordis_inspect_query(host/Service/attachments).referencedTypes`）。
- `saveFile` 的性质（service 描述原文）：**「Durably commit one file byte-for-byte… Files carry no admission limits: any byte content and length is accepted」** —— 视频不占图片配额。
- **`[推断]`**：聊天里是渲染成播放器还是文件卡片，我没实测。**这是唯一可用的文件形状**，不会报错。
- ⚠️ **红线**（DESIGN §7.7）：RH 的"隐写载图"输出，别 `saveImage` 完就当普通图片；按文件处理并提示。

### 4.7 `attachments` 服务的完整契约 `[源码]`

`cordis_inspect_query(host, Service, listService, {service:'attachments'})` 原始 JSON 摘录：

```json
{"name":"SaveImageAttachment","declaration":"export interface SaveImageAttachment {\n    data: Uint8Array;\n    mediaType: ImageMediaType;\n    name?: string;\n}"}
{"name":"SaveFileAttachment","declaration":"export interface SaveFileAttachment {\n    data: Uint8Array;\n    name?: string;\n}"}
{"name":"ImageMediaType","declaration":"export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';"}
{"name":"ImageAttachmentLimits","declaration":"export interface ImageAttachmentLimits {\n    maxImageBytes: number;\n    maxImagesPerMessage: number;\n    maxMessageImageBytes: number;\n    maxImagePixels: number;\n    maxImageDimension: number;\n    mediaTypes: readonly ImageMediaType[];\n}"}
```

访问方式（原始 JSON `access` 段）：
```json
{"optional":{"expression":"ctx.get(\"attachments\")","requiresUndefinedCheck":true},
 "hardDependency":{"inject":["attachments"],"expression":"ctx.attachments"}}
```

> **注意**：blender 插件**没有**把 `attachments` 写进 `inject`，而是 `ctx.get('attachments')` + 判空（`src/index.ts:178` `inject = ['tools']`，`:601` `ctx.get('attachments')`）。
> **建议**：优先 `ctx.get()` + 判空降级（attachments 缺失时工具仍可用，只回文字）—— 这符合 DESIGN §7.10「每一步都能独立降级」。

---

## 5. ★`ctx.jobs` 自定义 kind —— 实证跑通★

### 5.1 运行时真相 `[源码]` + `[实证]`

`probe/_ref/dsh-jobs-local/lib/index.js:412-422`（**全部校验就这两条**）：

```js
start(spec) {
    const owner = this.resolveOwner(spec.owner);
    if (!this.servesOwner(owner)) throw new Error("background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)");
    if (spec.kind.length === 0) throw new Error("invalid job kind: expected a non-empty string");
    if (spec.label.length === 0) throw new Error("invalid job label: expected a non-empty string");
    // …
    const count = (this.counters.get(spec.kind) ?? 0) + 1;
    this.counters.set(spec.kind, count);
    const id = JobId(`${spec.kind}-${count}`);
```

`JobKind = 'bash' | 'subagent'` 只是 **TypeScript 类型**（`JobKindMap`），**运行时零限制**。

### 5.2 原始运行日志 `[实证]`

`probe/jobs-probe.mjs`，命令：
```powershell
$env:ELECTRON_RUN_AS_NODE=1; & "D:\Program Files (x86)\deepseekharness\DeepSeek Harness.exe" probe\jobs-probe.mjs
```
输出（原样）：

```
### kind="" (应为失败) :: OK
抛错（符合源码 line 415）: invalid job kind: expected a non-empty string

### kind="bash" :: OK
id = bash-1

### kind="runninghub" (★核心★) :: OK
id = runninghub-1   ← 自定义 kind 被接受！

### ctx.jobs.list() :: OK
[ {"id":"bash-1","kind":"bash","label":"echo hi","status":"running","owner":null},
  {"id":"runninghub-1","kind":"runninghub","label":"workflow.run Qwen 文生图","status":"running","owner":null},
  {"id":"bash-2",…}, {"id":"runninghub-2",…} ]

### ctx.jobs.read(runninghub-1) :: OK
{"chunks":[{"at":0,"text":"submitted taskId=abc123\n"},{"at":24,"text":"task SUCCESS\n"}],
 "result":"{\"taskId\":\"abc123\",\"urls\":[\"https://example.com/a.png\"]}","lossy":false,"status":"completed"}
```

**活的旁证**：`dsh-mcp-panel@0.6.17` 生产代码就是用自定义 kind 的 —— `src/probe.ts:26` `export const PROBE_KIND = 'mcp-probe'`，`:299-304` `jobs.start({ kind: PROBE_KIND, label: …, run: () => probeJob(...) })`。

### 5.3 ★模型侧 `job_list`/`job_output` 可见性★ —— 精确规则

`probe/_ref/dsh-jobs-local/lib/index.js:493-566`（**这是权威**）：

```js
list(caller) {
    return [...this.store.values()]
      .filter((job) => job.owner === void 0 || job.owner.id === caller)   // ★
      .map((job) => this.view(job));
}
…
/** The isolation fence: a job with an owner is reachable only by callers … */
assertAccess(job, caller) {
    if (job.owner !== void 0 && job.owner.id !== caller) throw new Error(`job ${job.id} belongs to another session`);
}
```

`probe/_ref/dsh-tool-jobs/lib/index.js:362`（`job_list` 工具体）：
```js
const jobs = ctx.jobs.list(exec.agent?.id);       // ← 传当前会话 id，且【无 kind 过滤】
```

**结论表**：

| 我们的 `owner` | `job_list` / `job_output`（本会话） | 别的会话 | 完成通知 |
|---|---|---|---|
| **不传**（unowned） | ✅ 可见 | ✅ **也可见**（跨会话泄漏！） | ❌ 不注入（`dsh-tool-jobs:269` `event.job.owner === void 0` → return） |
| **`owner: exec.agent.id`** | ✅ 可见 | ❌ 抛 `job … belongs to another session` | ✅ **注入**（`:283-295`，idle 时 `followup`，否则 `inject`） |

**→ 所以 `workflow.run` 的 job 必须传 `owner: exec.agent.id`**：既拿到"跑完通知模型"（DESIGN §0.4 的诉求），又不会把 taskId/结果 URL 泄漏给别的会话。
**→ Lead 问的"要不要在回执里提示用 job_output 取进度"：要。** `job_list` 只会给 `runninghub-3 [runninghub] running — workflow.run Qwen 文生图` 这样一行（`dsh-tool-jobs:358`），进度细节靠 `job.updateProgress(line)` 写进 `JobView.progress`。

### 5.4 ★可直接抄：用 ctx.jobs 包一个自定义 kind★

```js
// host/core/runner.mjs 里，或在 host/index.mjs 的 apply 中
import { defineTool } from '@deepseek-ai/dsh-tools'

// ① 可选地扩类型（纯 TS 用途，运行时不生效，但能让 IDE 不报错）
//    declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { runninghub: 'runninghub' } }
export const RUNNINGHUB_KIND = 'runninghub'

// ② apply() 里：先挂 controller（必须在 start 之前）
ctx.inject(['jobs'], (scope) => {
  scope.effect(() => scope.jobs.attachController('dsh-runninghub-plugin'), 'dsh-runninghub-plugin: jobs controller')

  scope.effect(() => scope.tools.register(defineTool({
    name: 'runninghub_run',
    description: '…',
    parameters: { name: { type: 'string', required: true, description: '工作流名' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        taskId: { type: 'string', required: true },
        jobId:  { type: 'string', required: true },
        note:   { type: 'string', required: true },
      } },
      render: (_args, v) => [{ type: 'text',
        text: `已提交（本地任务 ${v.taskId}，后台作业 ${v.jobId}）。用 job_output("${v.jobId}") 或 runninghub_call({action:'task.wait',taskId}) 取结果。` }],
    },
    async execute(args, exec) {
      const taskId = await submitWorkflow(args.name)          // 你自己的提交逻辑，立刻返回
      const jobId = scope.jobs.start({
        kind: RUNNINGHUB_KIND,                                 // ★ 自定义 kind，运行时接受
        label: `workflow.run ${args.name}`,
        owner: exec.agent?.id,                                 // ★ 关键：会话级隔离 + 完成通知
        run: (job) => {
          // job: JobHandle { id, append(text, opts?), updateProgress(line) }
          job.append(`submitted taskId=${taskId}\n`)           // 进 output ring，job_output 读得到
          job.updateProgress('QUEUED')                          // 进 JobView.progress，job_list 看得到
          const controller = new AbortController()
          const done = pollUntilTerminal(taskId, controller.signal, (line, pct) => {
            job.append(line + '\n')
            job.updateProgress(`${pct}%`)                       // 每次调用覆盖，不追加
          }).then((out) => ({
            status: out.ok ? 'completed' : 'failed',            // 'completed'|'killed'|'failed'
            detail: out.ok ? undefined : out.reason,            // 可选一行
            result: out.ok ? JSON.stringify({ taskId, urls: out.urls }) : undefined,  // 可选 string
          }))
          return { cancel: (reason) => controller.abort(reason), done }   // JobHooks
        },
      })
      return { taskId, jobId, note: '后台运行中' }
    },
  })), 'dsh-runninghub-plugin: runninghub_run tool')
})
```

**形状速查**（`probe/_ref/dsh-jobs/lib/...` 的 `referencedTypes`，cordis Inspect 原始 JSON）：

```ts
export interface JobSpec {
    kind: JobKind;                      // 运行时任意非空字符串
    label: string;                      // 非空
    owner?: SessionId;                  // 省略 = unowned（全局可见 + 无完成通知）
    outputLimitBytes?: number;          // 可选，正整数
    output?: readonly JobOutputSource[];// 可选：外部拉取源
    run(job: JobHandle): JobHooks;      // ★同步★ 调用，必须立刻返回 hooks
}
export interface JobHandle { readonly id: JobId; append(text: string, options?: JobAppendOptions): void; updateProgress(line: string): void; }
export interface JobHooks  { cancel(reason?: string): void; done: Promise<JobOutcome>; }
export interface JobOutcome { status: 'completed' | 'killed' | 'failed'; detail?: string; result?: string; }
export type JobChannel = 'stdout' | 'stderr' | 'log';
export interface JobAppendOptions { channel?: JobChannel; gapBefore?: true; }
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
```

**踩坑点**：
- `run(job)` 是**同步**调用的（`probe/_ref/dsh-jobs-local/lib/index.js:437` `const hooks = spec.run(handle);`）→ 别在里面 `await`。
- `done` 必须 resolve 成 `JobOutcome`；reject 会被记成 `status:'failed'` 并 warn（`:472-478`）。
- `result` 是 **string**，塞不下附件 —— **图片/视频仍走 `task.wait` 工具回执**（Lead 的决策，正确）。
- 每个 kind 独立计数：`runninghub-1`、`runninghub-2`…
- `attachController` 必须在 `start` 之前挂好，否则 `servesOwner` 为假 → `background jobs unavailable: no job controller serves this agent`。
- `owner` 传了 SessionId 时，该 session 必须有 **live agent**，否则 `session "…" has no live agent`（`dsh-jobs-local:530-532`）。

---

## 6. `ctx.skills.register(...)` `[源码]`

出处：`probe/_ref/dsh-skill/lib/index.js:17-20, 193-215, 466-468, 504-510`。

```js
ctx.effect(() => ctx.skills.register({
  name: 'runninghub-workflow-setup',        // 必须匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/  （:17）
  description: '…',                         // 必填，非空（:467）
  content: skillMarkdown,                   // 必填，string（:488），就是 SKILL.md 全文
  whenToUse: '…',                           // 可选，string（:458）
  source: 'bundled',                        // 必填 string（:486）；只在诊断里显示
  invocation: { modelInvocable: true, userInvocable: true },   // 可选；两个字段都必须是 boolean
  // provider: 'runtime',                  // 可选；默认 'runtime'，不要覆盖
}), 'dsh-runninghub-plugin: skill')
```

- `register` 返回**正好是 `ctx.effect` 的 disposer**（`:209-214`）→ **不要再包 `ctx.effect`**（会双重注册；同名第二次会 warn 并返回 no-op，`:197-200`）。
- `invocation` 省略时默认 `{ modelInvocable: true, userInvocable: true }`（`:203-206`）—— **我们要的就是这个，可以省略**。
- `content` 读法：**相对 `import.meta.url`，不要用 cwd**（DESIGN §6）：
  ```js
  import { readFileSync } from 'node:fs'
  import { fileURLToPath } from 'node:url'
  const skillMarkdown = readFileSync(new URL('../skills/runninghub-workflow-setup/SKILL.md', import.meta.url), 'utf8')
  ```

---

## 7. `ctx.subagents` `[源码]` + `[实证-配置]`

### 7.1 真实 provider 名 = `spawn` / `fork` `[实证-配置]`

出处：`@deepseek-ai/dsh-base/cordis.patch.yml`（**正在加载的 base bundle**，已抽到 `probe/_ref/dsh-base/cordis.patch.yml`），原文：

```yaml
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- id: subagent-fork-in-process
  name: '@deepseek-ai/dsh-subagent-fork-in-process'
…
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn            # ★
    toolName: subagent
    backgroundMode: continuable
…
- id: tool-subagent-fork
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork             # ★
    toolName: subagent_fork
    backgroundMode: one-shot
```

- **provider 名是 `spawn` 和 `fork`**（不是包名！）。
- `spawn` 的 providerName 有默认值：`probe/_ref/dsh-subagent-spawn-in-process/lib/index.js:13` → `Config = z.object({ providerName: z.string().default("spawn") })`。
- **别硬编码**：运行期用 `ctx.subagents.list()`（返回 `string[]`）或 `ctx.subagents.getProvider(name)` 探测，缺失就降级（DESIGN §7.13）。

### 7.2 `spawn` 的能力集 `[源码]`

`probe/_ref/dsh-subagent-spawn-in-process/lib/index.js:15-30`：

```js
/** The spawn provider. Supports every start-time capability: depthLimit, outputSchema,
 *  agentOptions, and toolFilter/persona (scoped restrict() and a scoped shadowing
 *  persona section, applied in the child's creation window). */
capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true };
inheritsParentContext = false;
```

### 7.3 ★"无工具子代理"确实可行★ `[源码]`

三处证据链：

1. `ctx.subagents.start(name, request)`，`SubagentStartRequest`（`probe/_ref/dsh-subagent/lib/typert.host.js:778-787` 原始 JSON）：
   ```ts
   export interface SubagentStartRequest {
       readonly label?: string;
       readonly prompt: ContentBlock[];
       readonly parent: Agent;
       readonly signal: AbortSignal;
       readonly agentOptions?: AgentOptions;
       readonly outputSchema?: ObjectJsonSchema;
       readonly maxDepth?: number;
       readonly toolFilter?: ToolRestriction;
       readonly persona?: string;
   }
   ```
2. 能力门（`probe/_ref/dsh-subagent/lib/index.js:3176-3196`）：
   ```js
   { when: request.toolFilter !== void 0, cap: "toolFilter" }
   …
   for (const { when, cap } of needs) if (when && !provider.capabilities[cap])
       throw new SubagentError(`subagent provider "${provider.name}" does not support the "${cap}" capability`, "UNSUPPORTED_CAPABILITY");
   ```
   → `spawn` 的 `toolFilter: true`，**不会被拒**。
3. `ToolRestriction` 的语义（`probe/_ref/dsh-tools/lib/index.js:2642, 2895-2909`）：
   ```js
   for (const filter of this.restrictions.values())
       if (filter.allow !== void 0 && !filter.allow.has(name) || filter.deny !== void 0 && filter.deny.has(name)) return false;

   restrict(filter) {
       if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op: …");
       const compiled = { ...allow !== void 0 ? { allow: new Set(allow) } : {}, … };
       if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport …`);
       const known = this.view(scope).restrictableNames;
       const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
       if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool…`);
       …
   }
   ```
   - `allow: []` → `new Set([])` → `!allow.has(name)` 恒真 → **所有工具被隐藏**。
   - `allow: []` 里没有名字 → `unknown` 为空 → **不抛错**。✅

**→ `toolFilter: { allow: [] }` 是合法且正确的"无工具"写法。**

⚠️ 但**不能写 `toolFilter: {}`**（allow/deny 都缺）→ `tools.restrict({}) is a no-op` 报错。也不能在 allow/deny 里写不存在的工具名（`unknown global tool` 报错）。

### 7.4 可抄片段

```js
const SUBAGENT_PROVIDER = (() => {
  const list = ctx.get('subagents')?.list?.() ?? []
  for (const want of ['spawn', 'fork']) if (list.includes(want)) return want
  return undefined                                   // 缺失 → 降级，diagnostics 里点名
})()

if (SUBAGENT_PROVIDER !== undefined) {
  const run = await ctx.subagents.start(SUBAGENT_PROVIDER, {
    label: '提示词优化',
    prompt: [{ type: 'text', text: userRequest }],
    parent: exec.agent,                              // ★ 必须是发起调用的 Agent
    signal: exec.signal,
    persona: promptDocText,                          // ★ 文档当 persona（比塞进 prompt 更贴"系统提示词"语义）
    toolFilter: { allow: [] },                       // ★ 无工具
  })
  const result = await run.result                    // SubagentResult
  run.dispose()
}
```

- `start()` 返回 `SubagentRun { id, localAgent, result: Promise<SubagentResult>, dispose() }`。
- **`persona` vs `prompt`**：`persona` 是"人格/系统提示词"位（provider 会做成一个 shadowing prompt section）；文档内容放 persona 更符合 DESIGN §0.1 的"把该文档当系统提示词"。`[推断]`：persona 会被包进哪个 section 我没读到确证行，建议两边都试一次看模型回执。
- **`parent: exec.agent` 必须传**，`SubagentStartRequest.parent` 是必填。
- 输出 schema：`outputSchema` 可选（`ObjectJsonSchema`），spawn 支持。

---

## 8. `ctx.credentials` `[源码]`

出处：`cordis_inspect_query(host, Service, listService, {service:'credentials'})` 原始 JSON + `probe/_ref/dsh-credentials/lib/types/index.js:12-14, 20-25, 57-64`。

```ts
export type CredentialRef = Branded<'CredentialRef'>;     // 运行时就是一个 string
export type CredentialKey = Branded<'CredentialKey'>;
export interface ResolvedCredential { value: string; source: string }
export interface CredentialInfo { configured: boolean; source?: string; writable: boolean }
export interface CredentialRecordEntry { key: CredentialKey; kind: CredentialRecord['kind'] }
export type CredentialRecord = ApiKeyRecord | GrantRecord;
export interface ApiKeyRecord    { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string,string>> }
export interface GrantRecord     { readonly kind: 'grant';   readonly payload: unknown }
```

**两个 key 空间，回答两个不同的问题**（service 描述原文）：

| | `CredentialRef` | `CredentialKey` |
|---|---|---|
| 语义 | 「这个**环境变量名**背后是什么」 | 「这个插件为某个 id 持有什么凭据」 |
| 字符串格式 | `/^[A-Za-z_][A-Za-z0-9_]*$/`（POSIX 标识符，如 `RUNNINGHUB_API_KEY`） | `<scope>/<id>`，两段都匹配 `/^[a-z][a-z0-9-]*$/`，如 `dsh-runninghub-plugin/cn-1` |
| 构造 | `credentialRef(v)` | `credentialKey(scope, id)` / `parseCredentialKey('a/b')` |
| 分层 | 进程环境 → provider 管理库 → `.env`（**可被只读源遮蔽**） | 无分层，记录存在即全部事实 |
| 写 | `set(ref, value)` / `unset(ref)` | `modifyRecord(key, mutate)` —— **唯一写路径** |
| 枚举 | ❌ 无枚举（surfaces 从 settings schema 得知） | ✅ `listRecords()` |

**最小可用调用**：

```js
const credentials = ctx.get('credentials')
if (credentials) {
  // 单值：环境变量式
  const { credentialRef } = await import('@deepseek-ai/dsh-credentials')  // 或自己拼字符串
  await credentials.set(credentialRef('RUNNINGHUB_API_KEY'), 'rh_xxx')     // 空串会被拒（用 unset）
  const r = await credentials.resolve(credentialRef('RUNNINGHUB_API_KEY')) // → {value, source} | undefined
  await credentials.unset(credentialRef('RUNNINGHUB_API_KEY'))

  // 多值（我们的 Key 池）：一条记录一把 key
  const { credentialKey } = await import('@deepseek-ai/dsh-credentials')
  await credentials.modifyRecord(credentialKey('dsh-runninghub-plugin', 'cn-1'),
    async (cur) => ({ kind: 'api-key', key: 'rh_xxx', env: cur?.kind === 'api-key' ? cur.env : undefined }))
  const rec = await credentials.readRecord(credentialKey('dsh-runninghub-plugin', 'cn-1'))
  const all = await credentials.listRecords()      // [{key, kind}] —— 值不出现，天然可掩码
}
```

> **★给 Lead / rh-core 的设计建议★**：DESIGN §3.3 要"多 Key + 掩码列表"。**`CredentialRef` 一个 ref 只能一个值**，做多 Key 池要么 `RUNNINGHUB_API_KEY_1/_2/…`（丑，且无枚举），要么 **`CredentialKey` + `modifyRecord` + `listRecords()`**（干净、可枚举、天然掩码）。
> **建议**：`CredentialKey = dsh-runninghub-plugin/<keyId>`，`{kind:'api-key', key:'<明文>', env:{region:'cn'}}`。`env` 字段正好能塞地域元数据。
> **降级**：`ctx.get('credentials')` 为空 → 回退 `<dataDir>/secrets.json` 0600（DESIGN §3.3 已经这么定）。

---

## 9. `ctx.storageDomain.open(spec)` `[源码]`

出处：`probe/_ref/dsh-storage-domain/lib/index.js:355-392`，`cordis_inspect_query(host/Service/storageDomain)` 签名 `open<S extends DomainSpec>(spec: S): Promise<Domain<S>>`。

```js
const storageDomain = ctx.get('storageDomain')
if (storageDomain) {
  const domain = await storageDomain.open({
    name: 'dsh-runninghub-plugin',        // ★ 唯一：同名二次 open → DomainError("already-open")
    tables: {                              // 每张表一个 valueSchema（zod 风格 .parse()）
      workflows: { valueSchema: WorkflowSchema },
      tasks:     { valueSchema: TaskSchema },
      prompts:   { valueSchema: PromptSchema },
    },
    global: { schema: StateSchema, initial: { /* … */ } },   // 可选
    invalidRecords: 'backup-and-skip',     // 可选：坏记录备份后当不存在
  })
  ctx.effect(() => () => domain.close(), 'dsh-runninghub-plugin: storage domain')  // ★ CALLER 负责 close
}
```

- **生命周期**：service 描述原文 —— 「the CALLER owns the returned handle and closes it via `Domain.close()` (typically as its own `ctx.effect` disposer)」。
- 路由：`config.routes?.[spec.name] ?? config.backend`；后端必须有 `kv` facet，否则 `DomainError("facet-unsupported")`。
- 记录读取用 `tableSpec.valueSchema.parse(raw)`（`:371`）→ **zod 风格 `.parse()`**。

> **建议**：**v1 不要用 storageDomain**。DESIGN §3.1 已经定死 `<DSH_HOME>/runninghub` 目录 + 原子写 + 备份，那是**无依赖、可测试、可迁移**的方案；storageDomain 增加了一个可选依赖和 schema 迁移负担。放进 `diagnostics` 里报告可用性即可。

### 9.1 数据目录该用哪个 —— `DSH_HOME`，但**别自己拼** `[源码]` + `[实证]`

出处：`probe/_ref/dsh-home-paths/lib/index.js:11-15, 49-50, 64-76`（已抽到 `probe/_ref/dsh-home-paths/`）。
**实测**：`probe/home-paths-probe.mjs`（原始输出，2026-09-30）：

```
DSH_HOME_ENV                       = "DSH_HOME"
process.env.DSH_HOME               = "C:\\Users\\demo\\.dsh"
defaultDshHome()                   = "C:\\Users\\demo\\.dsh"
resolveDshHome()                   = "C:\\Users\\demo\\.dsh"
resolveDshHome("E:/custom/home")   = "E:\\custom\\home"
dshHomePath("runninghub")          = "C:\\Users\\demo\\.dsh\\runninghub"      ← ★ 正是 DESIGN §3.1 要的
dshCachePath("x")                  = "C:\\Users\\demo\\.dsh\\cache\\x"
resolveDshHome(undefined, {DSH_HOME:"   "}) = "C:\\Users\\demo\\.dsh"          ← 空白被当未设置，没落到 cwd
resolveDshHome("C:/explicit", {DSH_HOME:"C:/env"}) = "C:\\explicit"             ← 显式配置优先于环境变量
resolveDshHome("~/sub")            = "C:\\Users\\demo\\sub"                    ← ~ 正确展开
```

```js
const DSH_HOME_DIR_NAME = '.dsh'      // :11
const DSH_HOME_ENV = 'DSH_HOME'       // :15
function defaultDshHome() { return join(homedir(), DSH_HOME_DIR_NAME) }   // :49-50

/**
 * Precedence, highest first: an explicit configured path, `$DSH_HOME`, then `~/.dsh`.
 * … An empty or whitespace-only `$DSH_HOME` is treated as unset, so a blank override
 *   never resolves the home to the current working directory.
 */
function resolveDshHome(configured, env = process.env) { … }              // :73-76
```

**优先级（高 → 低）**：插件 config 的显式路径 → `$DSH_HOME` → `~/.dsh`。
**注意**：空串 / 纯空白的 `$DSH_HOME` 会被**当作未设置**（这是官方专门处理的边界，别自己写 `||` 会踩）。

**★推荐写法★**（照抄 DSH 自己的解析，不要手写 `process.env.DSH_HOME || '~/.dsh'`）：

```js
// 首选：直接用官方包，语义与 DSH 完全一致
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'   // 包在 app.asar 里，随 DSH 提供
const dataDir = config.dataDir ?? dshHomePath('runninghub')   // → <DSH_HOME>/runninghub

// 降级（包解析不到时）：等价实现
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
function resolveDshHome(configured, env = process.env) {
  const fromEnv = env.DSH_HOME
  const base = configured ?? (typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
  return resolve(base)
}
const dataDir = config.dataDir ?? join(resolveDshHome(), 'runninghub')
```

- **`dshHomePath(...segments)`** 是官方便捷函数（`dsh-home-paths/lib/index.js:82-83`），等价于 `join(resolveDshHome(), ...segments)`。
- 另有 **`dshCachePath(optionsOrSegment, ...segments)`** → `<DSH_HOME>/cache/...`（`:91-93`），语义是**可丢弃**的缓存。我们的 `logs/` 若算缓存可以用它；`keys.json` / `workflows/` 属于用户数据，**必须走 `runninghub`**。
- **DESIGN §3.1 的 `<dataDir>/` 布局与这个解析完全兼容**，只需把「`process.env.DSH_HOME`，兜底 `~/.dsh`」换成上面的 `dshHomePath('runninghub')`（顺带白捡了"空白环境变量"这个边界）。
- ⚠️ **`import '@deepseek-ai/dsh-home-paths'` 是裸说明符**：在真实 DSH 运行时能解析（DSH 自己就在用）；但**不要**把它写进 `inject` —— 那是 cordis **服务**名，不是包名。包解析失败时用上面的降级实现。



---

## 10. `ctx.systemPrompt.section / context` `[源码]`

出处：`probe/_ref/dsh-system-prompt/lib/index.js:10-48, 240-268`。

```js
// 静态文本段（"有提示词优化文档要读" 用这个）
ctx.effect(() => ctx.systemPrompt.section({
  name: 'runninghub:prompt-doc-hint',                          // 同 scope 内唯一；scoped 可 shadow 全局同名
  order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),        // ★ 用中央编排的 order
  text: '调用 runninghub 工具前，若 runninghub_search 返回 needsRead=true，必须先读提示词优化文档。',
}), 'dsh-runninghub-plugin: prompt section')

// 动态上下文（每次 assemble 现算）
ctx.effect(() => ctx.systemPrompt.context({
  name: 'runninghub:keys',
  order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
  /* text: () => ...   —— context 的字段形状我没读到确证行 [推断] */
}), '…')
```

- `section(section)` 只校验 `order` 是有限数（`:241`）；`name` 在同 layer 内重复会 throw（`layers.sections.insert`）。
- `getSectionOrder(name)` 返回中央编排值。**完整 name 表**（`:10-43`）：
  `HARNESS_IDENTITY:-1000`、`DEPLOYMENT_PERSONA_PREFIX:0`、`PLAN_POLICY:500`、`TEAM_POLICY:600`、`PTC_ONLY:800`、`FILE_REFERENCE:900`、`TOOL_BASH:1000`、`TOOL_PWSH:1010`、`TOOL_READ:1100`、`TOOL_WRITE:1200`、`TOOL_EDIT:1300`、`TOOL_GLOB:1400`、`TOOL_GREP:1500`、`TOOL_JOBS:1600`、`TOOL_PTY:1700`、`TOOL_WEB_SEARCH:2000`、`TOOL_WEB_FETCH:2100`、`TOOL_LSP:2200`、`TOOL_SESSION_QUERY:2300`、`TOOL_GOAL:2400`、`TOOL_WORKFLOW:2600`、`TOOL_RALPH:2700`、`TOOL_SUBAGENT:2800`、`TOOL_REPORT:2900`、`TOOL_COMPUTER_USE:3000`、`MCP_SERVERS:3100`、`TOOLS_SDK:5000`、`DELIVERABLE_FILE_REFERENCES:9000`、`STRUCTURED_OUTPUT:9900`、`HARNESS_SOURCE:10000`、`WEB_SURFACE:10100`、`DEPLOYMENT_PERSONA_SUFFIX:10200`
- `getContextOrder` 只有三个：`SANDBOX_POLICY:110`、`APPROVAL_POLICY:115`、`SUBAGENT_DELEGATION:120`。
- **`section` vs `context` 怎么选**：我们的提示是**静态规则**（"needsRead 时必须先读文档"）→ **`section`**。`context` 是"随组装现算"的动态事实（沙箱策略、审批策略这种）。**用 `section`**。
- `variable(name, provider)` / `suppressRuntimeContext()` 也存在（`:276, 297`），暂不需要。

---

## 11. ★host 侧 Remote（`host/rpc.mjs` 可直接落的骨架）★ `[实证]`

### 11.1 实证结论（原始日志）

`probe/remote-probe.mjs`：

```
### ctx.plugin(RunningHubRpc extends TypertRemoteService) :: OK
ctx.get('runninghub') = object; typertRemote={"service":"<obj>","serviceKey":"runninghub","namespace":"runninghub"}

### ctx.typert.register(TYPERT) :: OK
注册成功（未抛错）

### ctx.typert.local.get("runninghub/status") :: OK
命中: dsh-runninghub-plugin#runninghub/status

### invoke({namespace,method,args}) :: OK
{"ok":true,"line":"hello from host","at":1700000000000,
 "workflows":[{"name":"Qwen 文生图","outputKind":"image"}]}
```

**→ 纯 `.mjs`、无装饰器、无 TS、无 zod，完全可以跑通。**（且我连 `zod` 都没装，`create()` 返回 `{parse: fn}` 即可。）

### 11.2 `host/rpc.mjs` 骨架（可直接落）

```js
// host/rpc.mjs —— RunningHub 的 host↔client 数据面
//
// 三段：
//   ① 描述符（host 与 client 共享同一份对象 → 两侧 codec 不会漂移）
//   ② TypertRemoteService 子类（服务名 = Remote 命名空间）
//   ③ apply 挂载：ctx.plugin(Service) + ctx.typert.register(TYPERT)
//
// 证据：dsh-mcp-panel/src/{wire.ts,service.ts,typert.host.ts}（生产），
//       probe/remote-probe.mjs（实证跑通）

// ── ① codec：不需要 zod。只要 create() 返回带 .parse() 的对象 ──
// 证据 api-gateway/lib/index.js:1513  value = codec.create().parse(value)
const strictCodec = (typeSymbol, parseFn) => Object.freeze({
  mode: 'strict',           // 'strict' 是唯一被 loader 接受的 mode（typert-loader/index.js:208）
  typeSymbol,
  create: () => ({ parse: parseFn }),
})
const parseObject = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('expected object')
  return v
}
const parseString = (v) => { if (typeof v !== 'string') throw new TypeError('expected string'); return v }

const P = (name, wire, parse, sym) => Object.freeze({
  name, wire, source: 'json', codec: strictCodec(`dsh-runninghub-plugin/types#${sym}`, parse),
})
const INV = (method, parameters, parseResult, sym) => Object.freeze({
  id: `dsh-runninghub-plugin#runninghub/${method}`,
  service: 'runninghub', namespace: 'runninghub', method,
  invocation: Object.freeze({ kind: 'direct' }),        // 只有 'direct' / 'context' 两种
  parameters: Object.freeze(parameters),
  result: strictCodec(`dsh-runninghub-plugin/types#${sym}`, parseResult),
  sourceLocation: Object.freeze({ file: 'host/rpc.mjs', line: 1, column: 1 }),  // line/column 必须是正整数
})

export const RUNNINGHUB_INVOCATIONS = Object.freeze([
  INV('status', [], parseObject, 'Status'),
  INV('workflowList', [], parseObject, 'WorkflowList'),
  INV('workflowGet', [P('name', 'name', parseString, 'Name')], parseObject, 'WorkflowDetail'),
  INV('workflowSave', [P('name', 'name', parseString, 'Name'), P('patchJson', 'patchJson', parseString, 'PatchJson')], parseObject, 'SaveResult'),
])

// ── ② 服务：名字 = Remote 命名空间 ──
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export class RunningHubRpcService extends TypertRemoteService {
  static inject = []                       // 按需加；注意硬依赖缺失会导致整个 fiber 不激活
  constructor(ctx, runtime) {
    super(ctx, 'runninghub')               // ★ 第二个参数 = 服务键 = 命名空间
    this.rt = runtime                      // rh-core 的运行时
  }
  // 无装饰器、无 @Remote —— 描述符清单负责导出（mcp-panel 同款）
  status() {
    return this.rt.statusSnapshot()        // 必须返回纯 JSON（见 §11.4）
  }
  workflowList() {
    return this.rt.listWorkflows()         // { items: [...], total }
  }
  workflowGet(name) {
    const wf = this.rt.getWorkflow(name)
    if (wf === undefined) throw new Error(`WORKFLOW_NOT_FOUND: ${name}`)   // 见 §11.5 错误约定
    return wf
  }
  workflowSave(name, patchJson) {
    return this.rt.saveWorkflow(name, JSON.parse(patchJson))
  }
}

// ── ③ manifest（挂到包 ./typert，或在 apply 里手工注册）──
export const TYPERT = Object.freeze({
  package: 'dsh-runninghub-plugin',        // ★ 必须【严格等于】包名（typert-loader:80）
  face: 'host',                            // ★ 必须 'host'（:81）
  schemas: Object.freeze([]),              // 每个元素必须有 create() 工厂（:87）
  invocations: RUNNINGHUB_INVOCATIONS,
  model: Object.freeze({
    services: Object.freeze([]), events: Object.freeze([]), objects: Object.freeze([]),
  }),
})

// ── 在 host/index.mjs 的 apply 里 ──
/*
export async function apply(ctx, config) {
  const rt = createRuntime(config, ctx)
  const rpc = await ctx.plugin(RunningHubRpcService, rt)
  if (ctx.fiber.uid === null) return
  // 方式 A（推荐，与 mcp-panel 一致）：包声明 exports["./typert"] → dsh-typert-loader 自动发现
  // 方式 B（更可控）：手工注册，绕开 Loader 的包解析
  //   ctx.effect(() => ctx.typert.register(TYPERT), 'dsh-runninghub-plugin: typert')
}
*/
```

**方式 A（`./typert` 导出）**：`package.json` 加
```jsonc
"exports": { "./typert": { "default": "./host/typert.mjs" } }
```
`@deepseek-ai/dsh-typert-loader` 会扫每个已挂载 Loader entry 的包，自动 `import` 其 `./typert` 并 `ctx.typert.register(manifest)`（`probe/_ref/dsh-typert-loader/lib/index.js:39-40, 261-300`）。**没有该导出的包会被静默跳过**（README 原文）。

**方式 B（手工注册）**：`probe/_ref/dsh-typert-loader/lib/index.js:27-28` 注释原文：
> 「Manual `ctx.typert.register()` remains available for contributions that do not use a `./typert` artifact (hand-written wire schemas, …)」

**→ 我们的"不构建"约束下，方式 B 更省事**（不用管 Loader 的包解析、不用重启才生效）。但 `ctx.typert` 必须存在 → 用 `ctx.inject(['typert'], scope => scope.effect(() => scope.typert.register(TYPERT), '…'))` 包一层更稳。

### 11.2.1 ★前置条件：`@deepseek-ai/*` 必须能被解析到 —— 靠 `peerDependencies`★

`import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'` 是**裸说明符**。
插件装在 profile 里时，它能不能解析到、以及**拿到的和宿主是不是同一份实例**（`extends Service` 要求同实例），
由 DSH 的 **profile resolution interception** 决定 —— 规则是：

> **向上找 `node_modules` 位置时，只要某一层 `package.json` 的 `peerDependencies` 点了这个名字，
> 该导入就被路由到「运行时自己的那份」。**

出处（`[源码]`）：
- `dsh-app-boot/lib/index.js:1471-1485` `routeLinked()`：`if (ancestorSet.has(searchPath) && readPeerNames(directory).has(name)) → { kind: 'interception', entry: target }`
- `dsh-app-boot/lib/index.js:1223-1231` `readPeerNames()`：读 `<directory>/package.json` 的 `peerDependencies` 键
- `dsh-app-boot/README.md:134` 原文（Linked directories 段）

**所以 `package.json` 必须写**：
```jsonc
"peerDependencies": {
  "@deepseek-ai/dsh-typert-protocol": ">=0.2.0-rc.2 <0.3.0",
  "@deepseek-ai/dsh-tools":           ">=0.2.0-rc.2 <0.3.0"
}
```
- **只写 peer，不要写进 `dependencies`** —— 写进 dependencies 会让 pnpm 装一份物理副本，可能又变成两份实例。
- **版本范围必须匹配运行时版本**：`dsh-app-boot/lib/index.js:286-301` `evaluatePluginCompatibility()` 对每个
  `@deepseek-ai/dsh*` peer 做 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`；
  当前运行时是 **`0.2.0-rc.2`**。不匹配会报不兼容（可能跳过加载）。
- **生产先例**（都在同一个 desktop profile 里跑着）：
  - `dsh-blender-plugin` 是 **`link:` 安装**，`src/index.ts:28` 有裸导入 `import { defineTool } from '@deepseek-ai/dsh-tools'`，peer 里声明了 DSH 包 → **工作正常**。
  - `dsh-mcp-panel` peer 里声明 `@deepseek-ai/dsh-typert-protocol`，`class McpPanelService extends TypertRemoteService` → **Remote 生产可用**。
- **`[实证-成品]` + `[源码]`，非 `[实证]`**：我没装进 profile 重启验证过。详见 `EVIDENCE.md` §10.1。

### 11.3 过线规则 `[实证]`

`probe/remote-probe2.mjs` 原始输出：

```
### A. 带参数调用（string 参数走 json 通道）
  OK → {"greeting":"hi 中文 & ASCII","len":10}

### B. 参数类型校验（传 number 给声明为 string 的参数）
  被拒 → TypertGatewayError: typert gateway: runninghub/echoName: wire field "name" failed boundary validation
         | code=gateway/input-invalid | field=name

### C. 缺参数
  被拒 → gateway/arguments-invalid: typert gateway: runninghub/echoName: args fields do not match the descriptor: missing "name"

### D. 方法抛异常 → 过线形状
  {"name":"Error","code":null,"message":"RunningHub API 返回 805 余额不足","details":null,"cause":null}

### E. 非 lossless JSON 返回值（undefined / NaN / -0）
  返回 → {"nan":null,"neg":0}     ← undefined 键被丢弃、NaN→null、-0→0

### F. 体积上限
  count=10     → OK, 28.8 KiB
  count=200    → OK, 577.0 KiB
  count=1000   → OK, 2886.4 KiB
  count=3000   → OK, 8665.7 KiB
  count=10000  → OK, 28893.3 KiB   （28 MiB 无压力）
```

- **JSON only**。UTF-8 中文正常。`Uint8Array`/`Blob`/`Date` 不能直接过（日期请传 epoch 数字）。
- **体积**：实测 28 MiB 单次返回值无障碍。**但这不代表 WebSocket 载体也一样** —— 保守建议见 §11.6。
- **错误**：宿主侧 `invoke` **直接抛原始 Error**（`code=null`）。**Client 侧看到的是 `RemoteResult` 判别联合**（`{ok:false,error:{code,message}}`），由 api-gateway/remotes 的客户端半边包装 —— 所以 **client 侧必须 unwrap**（见 CLIENT-API.md §6.2）。
- **非 lossless JSON 被静默归一**（E）。这一层是宽容的；但**工具回执那一层是严格的**（`dsh-tools/lib/types/index.js:95` `output.<projector> returned non-lossless JSON`）—— 两层的严格度不同，别混淆（DESIGN §7.12 的 `losslessSanitize` 是针对**工具**层的）。

### 11.4 返回值必须遵守的规矩

1. **只返回纯 JSON**：没有 `undefined` 键（会被丢）、没有 `NaN`/`Infinity`、没有 `Date`/`Map`/`Set`/`BigInt`/函数、没有循环引用。
2. **不要返回 attachment 引用** —— 那是工具回执 ContentBlock 的东西，Remote 通道只过 JSON（attachment ref 本身是 JSON 对象，能过，但**聊天渲染不了**，因为渲染只看工具的 `output.render`）。**图片走工具回执，UI 展示走 Remote** —— 两条路别混。
3. **大 snapshot 拆开**：见 §11.6。

### 11.5 错误码约定（建议，与 DESIGN §5.2 对齐）

宿主侧方法**直接 throw**，并把稳定 code 编进 message 前缀；client 侧就着 `RemoteResult.error.code`（传输层码，如 `gateway/input-invalid`）和 `message` 做展示。

```js
// host 侧
throw new Error('WORKFLOW_NOT_FOUND: 没有名为 "qwen-t2i" 的工作流；先 runninghub_search 看看有哪些')
```

> `[推断]`：我没验证「业务码能否作为 `error.code` 过线」（`gateway` 层似乎用自己的 code）。**建议 v1 就用 message 前缀**，UI 用字符串包含判断，稳。

### 11.6 ★大体量数据的形状建议（给 Lead / rh-ui）★

实测 28 MiB 能过，但**不要**这么设计。建议：

```
Remote 命名空间 runninghub：
  读（少而稳）：status()                        → 概览（key 池、任务数、版本）
              workflowList()                   → 只返回概要项：{id,name,displayNameEn,outputKind,
                                                  description,nodeCount,roleSummary,promptOptimizer}
  读（按需）：workflowGet(name)                 → 单个工作流的完整 nodes[]（几十 KB，没问题）
  写：        workflowSave(name, patchJson)     → patchJson 是 string，避免 schema 递归
              workflowDelete(name)
              promptDocWrite(name, content)
              runWorkflow(name, payloadJson)   → {taskId}
```

**理由**：
- `workflowList` 若带上全部 `nodes[]`，10 个工作流就是 ~1.5 MiB、100 个就是 ~15 MiB —— 面板首屏不需要。
- **"一个大 snapshot + 若干写操作"** 是对的，但 snapshot 要**只在需要时**带重内容（`workflowGet` 单取）。这正是 DESIGN §0.2「默认不展开；点中某个工作流才展开它的节点」的天然映射。
- 写操作参数一律用 **`patchJson: string`**（mcp-panel 的 `previewPatch(opJson)` / `callTool(requestJson)` 就是这个套路，`src/client/remote.ts:28-32`）—— string 过线最不容易触发 schema 递归/深度限制。

---

## 11.7 ★双保险：HTTP 与 Remote 同时存在时，客户端怎么选★

### 为什么两条腿都要有

Lead 决策：`ctx.webServer.register({kind:'prefix', path:'/plugins/…'})` 可能与 client-modules 的 bundle 路由撞车（同 `(kind,path)` 重复会 throw），**撞了只有 warn，面板就没通道了**。所以：

| 通道 | 角色 | 挂载点 |
|---|---|---|
| **HTTP**（`ctx.webServer`） | **保底**，一定可用 | `host/rpc.mjs` → `registerHostRpc(ctx, rt)` |
| **Remote**（Typert） | **首选增强**，省一次网络往返、免自建鉴权 | `host/rpc-remote.mjs` → `registerRemoteBridge(ctx, rt, methods)` |

两条腿**共用同一张方法表**（`buildMethods(rt)`），所以数据形状完全一致。

### host 侧（已落地并实证）

```js
import { registerRemoteBridge } from './rpc-remote.mjs'

// apply() 里，两条腿各自 try/catch，谁挂了都不影响另一条
let disposeRemote = null
try {
  disposeRemote = await registerRemoteBridge(ctx, rt, methods)   // 失败返回 null，绝不抛
} catch (error) {
  rt.warn(`Remote 桥异常：${String(error)}`)                      // 兜底，理论上到不了
}
ctx.effect(() => () => disposeRemote?.(), 'dsh-runninghub-plugin: remote bridge')
// HTTP 腿照旧 registerHostRpc(ctx, rt)（Lead 的 host/rpc.mjs）
```

**实证**：`probe/rpc-remote-selftest.mjs` —— 20 项断言里 host 部分全绿；7/9/18 个方法名（含 `call` 通用桥）全部注册成功并可调用；`dispose()` 幂等；`methods` 为空、`ctx` 为空两条降级路径都**返回 `null` 且不抛**。

### ★★客户端：两层 `ok`，必须解两次★★

**这是 rh-ui 唯一必须改对的地方。**

`ctx.remote.runninghub.x(p)` 的返回值是**传输层包装**（`@deepseek-ai/dsh-api-gateway/lib/client.js:1785-1802`，结构性加的，宿主无法去掉）：

```js
// dsh-api-gateway/lib/client.js:1795-1802（原文）
if (!result.ok) return { ok: false, error: rebuiltFailure(result.error) };
return {
  ok: true,
  value: descriptor.result.mode === 'strict' && descriptor.result.decode !== void 0
    ? descriptor.result.decode(result.value) : result.value
};
```

而我们宿主方法自己返回 `{ok:true, data}` / `{ok:false, error:{code,message,hint}}`。于是：

```
ctx.remote.runninghub.status({})
   ↓  实际拿到
{ ok: true, value: { ok: true, keys: 2, tasks: 1 } }        ← 两层 ok
{ ok: false, error: { code: 'gateway/…', message: '…' } }   ← 传输层失败（第一层）
   ↓  若第一层 ok:true，第二层可能是业务失败
{ ok: true, value: { ok: false, error: { code:'NO_KEY', message:'…', hint:'…' } } }
```

### ★可直接抄的 client 代码（发给 rh-ui）★

```js
/**
 * 调 Remote 并解两层 ok。
 * @returns {Promise<any>} 宿主方法的原始返回对象（{ok:true,...} 或 {ok:false,error:{...}}）。
 * @throws {Error} 传输层失败（error.stage === 'transport'）
 */
async function callRemote(fn, params) {
  const transport = await fn(params)
  if (!transport || transport.ok !== true) {
    const code = transport?.error?.code ?? 'unknown'
    const message = transport?.error?.message ?? 'no detail'
    const err = new Error(`[remote transport] ${code}: ${message}`)
    err.stage = 'transport'
    err.code = code
    throw err
  }
  return transport.value            // ← 这就是宿主返回的 {ok:true,...} / {ok:false,error:{...}}
}

// 用法：业务层再判一次
const payload = await callRemote(scope.remote.runninghub.status, {})
if (payload.ok === false) {
  showError(`${payload.error.code}: ${payload.error.message}${payload.error.hint ? ' — ' + payload.error.hint : ''}`)
} else {
  render(payload)
}
```

### 传输层选路：先 Remote，失败落 HTTP

> ⚠️ **HTTP 的形状以 Lead 的 `host/rpc.mjs` 为准**（2026-09-30 由 `rh-ui` 校正）：
> **`POST /plugins/dsh-runninghub-plugin/api`**，body 是 **`{ method, params }`**，
> 宿主侧 `dispatch(rt, payload)` 读 `payload.method` / `payload.params`。
> **不是** `POST …/api/<method>` 那种 REST 风格。`rh-ui` 的 `tests/client/integration.test.mjs`
> 起真 http server 打真 `registerHostRpc` 跑通了全链路。
> 路径以插件 config 里的实际注册值为准（`ctx.webServer.register({ kind:'prefix', path:'/plugins/dsh-runninghub-plugin/api' })`）。

```js
/**
 * 传输层抽象：Remote 可用走 Remote；否则走 HTTP。
 * 两条路返回【同一种 shape】：宿主方法的原始对象 {ok:true,…} / {ok:false,error:{…}}。
 */
function createTransport(scope, httpEndpoint) {
  const remote = scope.remote?.runninghub
  const useRemote = remote !== undefined

  return {
    kind: useRemote ? 'remote' : 'http',
    async call(method, params = {}) {
      if (useRemote) {
        try {
          return await callRemote(remote[method], params)
        } catch (e) {
          // 传输层挂了：这一次落 HTTP（别整体切换，下一次仍优先试 Remote）
          if (e.stage !== 'transport') throw e
          return await callHttp(method, params)
        }
      }
      return await callHttp(method, params)
    },
  }
}

/**
 * HTTP 腿 —— 形状与 Lead 的 host/rpc.mjs 一致。
 * @param {string} httpEndpoint - 已注册的前缀路径，如 '/plugins/dsh-runninghub-plugin/api'
 */
async function callHttp(method, params, httpEndpoint) {
  const res = await fetch(httpEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: params ?? {} }),   // ★ {method, params}，不是路径参数
  })
  return await res.json()          // 宿主 HTTP 侧返回的就是同一个 {ok:…} 对象
}
```

**要点**：
1. **两层都要解**，别只 `if (r.ok)`。
2. **不要在三层里各写一份** —— 收敛成一个 `createTransport()`，UI 组件只认 `transport.call(method, params)` 的返回 shape。
3. **`useRemote` 的判定时机**：`scope.remote?.runninghub` 在 `$mount` 之后才存在，所以要在 `ctx.inject(['remote.runninghub'], scope => …)` 回调里创建 transport（不要提前建）。
4. **降级是 per-call 的**，不要因为一次失败就永久切 HTTP。
5. **Remote 的零参调用**：宿主描述符声明了 `acceptsUndefined: true`，所以 `remote.status()` 和 `remote.status({})` **都能用**（实证：`probe/rpc-remote-selftest.mjs` 的 "status 零参"、"status 显式 {}" 两项均通过）。建议统一传 `{}`，可读性更好。
6. **两条腿的 `params` 形状必须一致**：Remote 腿的参数 wire 字段名是 `params`（`acceptsUndefined: true`），HTTP 腿的 body 也是 `{method, params}` —— 都是**一个对象**。`rh-ui` 指出：如果 client 按"位置参数"写，Remote 那条腿会**静默失效**（参数对不上 `params` 字段）。

### 客户端的 `$mount` 形状（不变）

```js
// client/client.js 里
await ctx.remote.$mount({
  package: 'dsh-runninghub-plugin',
  descriptors: RUNNINGHUB_INVOCATIONS,   // 与 host 同一份清单
})
ctx.inject(['remote.runninghub'], (scope) => { /* 到这里 scope.remote.runninghub 才存在 */ })
```

> **关于 "描述符要不要与 host 逐字一致"**：`descriptors` 的 `id/service/namespace/method/parameters[].wire/result.mode` 必须与 host 一致，否则网关的客户端侧会解不出来。mcp-panel 的做法是两边 `import` 同一个 `wire.ts`；我们**无构建**，所以要么在 client bundle 里内联同一份对象（`probe/client-minimal/client/client.js` 就是这么做的），要么用一个**构建期无关的共享 JSON/JS 文件**由两边分别 `import`（推荐给正式插件）。

---

## 12. 装配：`package.json` + `cordis.patch.yml` `[实证-成品]`

`dsh-mcp-panel/cordis.patch.yml`（原文，可照抄结构）：

```yaml
- insert:
    - id: mcp-panel                       # patch id（profile 里唯一）
      name: dsh-mcp-panel                 # 包名，经 profile 的 node_modules 解析
      config:
        probeEnabled: true
        probeTimeoutMs: 10000
```

- 文件由 `dsh.bundle.patch` 指向：`package.json` → `"dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } }`。
- 顶层键是 `insert:`；`- id:` 是 patch id；**id-targeted 覆盖会替换整行 config**（mcp-panel 文件头注释原文：「An id-targeted override replaces the whole config row — restate every key when overriding.」）
- profile 侧（**Lead 的作用域**）：`$DSH_HOME/profiles/desktop\package.json` 的 `dependencies` + `dsh.profile.bundles`。

---

## 13. 未确认清单（**别当成已验证**）

| # | 事项 | 状态 | 建议 |
|---|---|---|---|
| 1 | `parameters` spec DSL 的完整 key 白名单（`enum`/`min`/`max`/数组/对象嵌套） | `[推断]` | 报错会点名"not supported by the value schema DSL"，按错调整 |
| 2 | `ctx.subagents.start` 真机跑通（我只证了 provider 名 + 能力门 + `allow:[]` 语义） | `[源码]` | 真机验收时用 `persona` 跑一次 |
| 3 | `systemPrompt.context` 的字段形状 | `[推断]` | 我们只用 `section`，无影响 |
| 4 | 业务错误码能否作为 `RemoteResult.error.code` 过线 | `[推断]` | 用 message 前缀 |
| 5 | `file` block（视频）在聊天里渲染成播放器还是文件卡 | `[推断]` | 真机跑一次就知道；不影响能不能用 |
| 6 | client 类 Inspect（Slots/Theme/Builtin）超时 | ✅ **已定性**：subagent 会话必然拿不到（`rh-ui` 独立复现），改用源码直读 | 详见 `EVIDENCE.md` §10.2 |
| 7 | `dsh.client` 的 `inject` 与 `external` 在真实加载图里的精确差异 | `[源码]` | 两个都写，最保险 |
| 8 | **`@deepseek-ai/*` 裸导入在 profile 里的解析** | ✅ **机制已确证**（`[源码]`+`[实证-成品]`）：靠 `peerDependencies` 触发 interception → 路由到运行时那份 | 见 §11.2.1；**真机未验证** |
| 9 | **HTTP 腿的确切形状** | ✅ **已校正**：`POST /plugins/dsh-runninghub-plugin/api` + body `{method, params}`（Lead 实装；`rh-ui` 有端到端测试作证） | 见 §11.7 |
| 10 | **Cordis Service 的 `#private` 字段** | ✅ **已实证会炸**，改用普通属性 | 见 §2.1 |
