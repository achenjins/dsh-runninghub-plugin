# dsh-runninghub-plugin — 团队契约（Design Brief）

> 本文件是**唯一共享契约**。所有 teammate 开工前先读这里；接口以本文件为准，改接口必须先改这里。
> 根目录：`（本仓库）`

## 0. 目标（用户原话要点）

在 **DSH 桌面版**做一个插件，适配 **RunningHub 工作流**，让模型能**生图 / 生视频 / 生音频**。

1. **AI 辅助配置工作流**：用户说"配置工作流"→ LLM 读插件自带 **skill** → 按 skill 走官方 `getJsonApiFormat` 接口拿工作流 JSON → 识别节点 → **用提问方式**逐个确认接口 → 落盘配置。支持**提示词优化**（可挂 txt/md 文档，存在插件数据里），另有一个开关决定是否把该文档当系统提示词交给**无工具、极简模式子代理**写提示词。
2. **配置页简洁**：默认不展开；点中某个工作流才展开它的节点。
3. **工具两层**：`runninghub_search`（列本地已配置工作流概要：生图/生视频/…）+ `runninghub_call`（所有动作）。只在 search 之后模型才知道有哪些 call 动作 —— 与本地 `autocad` / `github` MCP 的 `search_tools` + `call_tool` 同构。
4. **运行必须后台化**：`workflow.run` 立即返回 taskId；完成后**把图片/视频回传并在聊天里展示**。
5. **多 Key + 智能调用**：单 key 额度不够时自动换 key；**国内 / 海外 key 分开、互不通用**。
6. 主动排雷（见 §7）。

**唯一优先标准**：RunningHub 官方 API 文档 <https://www.runninghub.cn/runninghub-api-doc-cn/>
参照实现：`RHStudio2`（Android，接口最全）、`runninghub-workflow-adapter` 与 `...\astrbot_plugin_runninghub_maimai`（Python）。
DSH 插件范本：`dsh-blender-plugin`（host 单文件）、`$DSH_HOME/profiles/desktop\node_modules\dsh-mcp-panel`（host + client 双半，**本插件的主要范本**）。

## 1. 不构建（No build step）——硬约束

DSH 版本在漂移，**构建产物坏掉 = 插件整体消失**。所以：

- **宿主半边**：手写 ESM，`package.json` 的 `main` 直接指向 `host/index.mjs`。**不写 TypeScript，不引 tsdown/rolldown。**
- **浏览器半边**：手写 `client/client.js`，格式是 DSH 的 ModuleLoader 工厂（无构建）：

```js
window.__ModuleLoader__.load({
  id: "dsh-runninghub-plugin",
  factory: (require) => {
    const React = require("react");
    const jsx = require("react/jsx-runtime");
    var module = { exports: {} }; var exports = module.exports;
    /* ... */
    return module.exports;
  },
});
```

`clientModules` 通过包 `exports["./client"].default` 找浏览器 bundle（见 `dsh-mcp-panel` 的 package.json：`"./client": { "default": "./lib/client.js" }`）。

只能 `require("react")` / `require("react/jsx-runtime")`；客户端内置符号另有 `ctx` / `host` / `styles` / `console`（Inspect: client/Builtin/listBuiltins）。

## 2. 目录与写作用域（advisory，但请遵守）

| 作用域 | 归属 | 内容 |
|---|---|---|
| `docs/api/**` | `rh-docs` | 官方 API 提取物（人读 md + 机读 json） |
| `docs/dsh/**`, `probe/**` | `dsh-api` | DSH 插件 API 实证报告 + 可跑探针 |
| `host/core/**`, `tests/core/**` | `rh-core` | 协议层：HTTP 客户端、Key 池、工作流解析、任务运行、数据存储 |
| `client/**`, `tests/client/**` | `rh-ui` | 浏览器半边（配置页） |
| `host/index.mjs`, `host/tools/**`, `host/skill.mjs`, `skills/**`, `package.json`, `cordis.patch.yml`, `docs/DESIGN.md`, `README.md` | **Lead** | 工具层、skill、装配、集成验收 |

```
dsh-runninghub-plugin/
├── package.json            main=./host/index.mjs, exports["./client"].default=./client/client.js
├── cordis.patch.yml        dsh.bundle.patch，insert 一行
├── host/
│   ├── index.mjs           插件入口：export name / inject / Config / apply()
│   ├── skill.mjs           注册 skill（bundled）
│   ├── core/               ← rh-core
│   │   ├── api.mjs         RunningHub 全部 HTTP 端点（无第三方依赖，用 globalThis.fetch）
│   │   ├── keys.mjs        Key 池、地域判定、轮换、额度/冷却
│   │   ├── store.mjs       插件数据目录读写（原子写 + 备份）
│   │   ├── workflow.mjs    工作流 JSON → 参数模型（节点角色推断）
│   │   ├── runner.mjs      后台任务：提交/轮询/下载/落盘
│   │   └── promptdoc.mjs   提示词优化文档
│   ├── tools/
│   │   ├── search.mjs      runninghub_search
│   │   └── call.mjs        runninghub_call（全动作分发）
│   └── types.d.ts          （可选）JSDoc 类型，供 IDE
├── client/client.js        配置页（浏览器半边）
├── skills/runninghub-workflow-setup/SKILL.md
└── tests/                  node:test（`node --test`），无第三方依赖
```

## 3. 数据与配置

### 3.1 数据目录

默认 `<DSH_HOME>/runninghub`（`process.env.DSH_HOME`，兜底 `~/.dsh`，可用插件 config `dataDir` 覆盖）。

```
<dataDir>/
├── keys.json          非机密元数据：[{id,label,region,baseUrl,enabled,priority,note,createdAt}]
├── secrets.json       API Key 本体（0600；见 §3.3）
├── state.json         key 冷却 / 上次用量快照
├── workflows/<id>.json  单个工作流配置（见 §3.2）
├── prompts/<id>.md      提示词优化文档（用户上传的 txt/md 原样存）
├── prompts/<id>.meta.json {name, sourceFilename, updatedAt, bytes}
├── tasks/<taskId>.json  任务流水（提交参数、状态、结果 URL、本地文件路径）
└── logs/
```

**原子写**：先写 `*.tmp` 再 `fs.rename`；覆盖前先备份到 `<name>.bak-<ts>`（保留最近 5 份）。

### 3.2 工作流配置（`workflows/<id>.json`）

```jsonc
{
  "id": "wf_xxx",                     // 本地 id（默认 = rhWorkflowId）
  "name": "Qwen 文生图",               // 用户可见名
  "displayNameEn": "qwen-t2i",         // 工具里用的稳定 slug（search 返回它）
  "rhWorkflowId": "1988...",           // RunningHub 工作流 ID
  "region": "cn" | "overseas",         // 用哪一池 key（工作流本身不分地域，但 key 分）
  "outputKind": "image" | "video" | "audio" | "3d" | "text" | "mixed",
  "tags": ["文生图", "qwen"],
  "description": "一句话说明（给模型看）",
  "instanceType": "default" | "plus" | "ultra",
  "nodes": [                            // 归一化后的节点（见 §4）
    {
      "nodeId": "6",
      "classType": "CLIPTextEncode",
      "title": "CLIP Text Encode (Prompt)",
      "role": "prompt" | "negative_prompt" | "image" | "video" | "audio" | "number"
              | "select" | "boolean" | "seed" | "other",
      "fieldName": "text",
      "label": "正向提示词",
      "required": true,
      "default": "…",
      "valueType": "string" | "number" | "boolean" | "enum",
      "min": 0, "max": 100, "step": 1,        // number 才有
      "options": ["16:9", "9:16"],             // enum 才有（**用户配置，不猜**）
      "group": "画面",                          // UI 折叠用
      "note": ""
    }
  ],
  "promptOptimizer": {
    "enabled": false,
    "docId": null,                 // → prompts/<docId>.md
    "asSubagentSystemPrompt": false, // true=用无工具极简子代理写提示词
    "targetNodeId": null,          // 优化结果写到哪个 prompt 节点
    "extraInstruction": ""
  },
  "createdAt": 0, "updatedAt": 0, "schemaVersion": 1
}
```

### 3.3 机密存储（Lead 决策）

- 优先用 DSH 的 `ctx.credentials`（`dsh-api` 负责给出实证的 ref 形状）；不可用时回退到 `<dataDir>/secrets.json`，文件权限 0600 并在 UI 红字说明。
- **日志、工具回执、UI 快照里永远只出现掩码 key**（`rh_****abcd`）。这是硬边界，任何模块都不得把明文 key 写进返回值。

### 3.4 多 Key 与地域（**这件事必须先定死**）

- 国内基址：`https://www.runninghub.cn`；海外基址：`https://www.runninghub.ai`。
- **判定**：key 的归属由**运行时探测**决定，不靠用户声明也不靠字符串猜——
  对每个候选基址调 `POST /uc/openapi/accountStatus`，`code=0` 的那个就是它所属地域；
  两边都失败 → key 无效。结果缓存在 `state.json`，`region='auto'` 时重新探测。
- **两池互不通用**：选 key 时先按工作流/请求的 region 过滤；该池空了**直接报错**，绝不跨池回退（跨池只会得到 401，浪费一次付费调用）。
- 轮换策略：`priority` 升序 → 冷却未到期跳过 → 同优先级按 `lastUsedAt` 最旧优先 → 失败分类处理：
  - 401/403 / `APIKEY_INVALID` → 该 key 标记失效，换下一个；
  - 额度类（余额不足 / `code=805` / `INSUFFICIENT`）→ 该 key 进冷却（默认 10 分钟），换下一个；
  - 429 / 网络瞬时故障 → 重试同 key（指数退避，最多 2 次）后换下一个；
  - **提交类 POST 在"结果未知"时绝不自动重试**（可能已经扣费）——返回"状态不确定"，让模型/用户显式决定。

## 4. 工作流 JSON → 参数模型（`host/core/workflow.mjs`）

输入：官方 `getJsonApiFormat` 返回的 `data.prompt`（**字符串**，需 `JSON.parse`），形状为 ComfyUI API 格式：
`{ "<nodeId>": { "class_type": "…", "inputs": { … }, "_meta": { "title": "…" } }, … }`

角色推断规则（**推断结果必须可被用户/AI 覆盖**，`overwrite` 标志）：

1. `class_type` 含 `CLIPTextEncode` / `TextEncode` / `Prompt` → 文本候选；其中 `inputs.text` 为空串或 title 含 `negative` → `negative_prompt`，否则 `prompt`。
2. `class_type` 含 `LoadImage` / `ImageLoader` / `VHS_LoadVideo` / `LoadAudio` → `image` / `video` / `audio`，字段通常是 `image` / `video` / `audio`。
3. `inputs` 里某字段的值是 `{"__value__": [false, true]}`（RH 的"可编辑"标记）→ 该字段可覆盖；据其值类型定为 `boolean`/`number`/`string`。
4. `KSampler` 系（`KSampler*`/`SamplerCustom*`）→ `seed`（`inputs.seed`）、`number`（`steps`/`cfg`）。
5. `EmptyLatentImage` / `EmptySD3LatentImage` / 宽高字段 → `number`，带 `min/max` 合理默认（width/height 64–4096，step 8）。
6. 明显是下拉的值（`sampler_name`、`scheduler`、`ckpt_name`）→ `enum`，但 **options 只从工作流里已有取值提示，不编造**。
7. 其余进 `other`，UI 里默认折叠。

同时对**输出侧**做推断：`SaveImage`/`PreviewImage` → image；`SaveVideo`/`VHS_VideoCombine` → video；`SaveAudio` → audio；`SaveAnimatedWEBP` → image。汇总成 `outputKind`。

## 5. 工具契约（模型看到的面）

只注册 **2 个**工具，命名与 MCP 的 `search_tools` / `call_tool` 同构。

### 5.1 `runninghub_search`

```
{ kind?: 'workflow'|'task'|'key'|'prompt_doc'|'all',   // 默认 'workflow'
  query?: string,           // 模糊匹配 name/displayNameEn/tags
  status?: string,          // kind='task' 时过滤
  limit?: number }          // 默认 20
```

返回紧凑文本（给模型看）+ 结构化 `items`。工作流条目必须带上：
`name` / `displayNameEn` / `outputKind` / `description` / `nodeCount` / 角色摘要（有几个 prompt、几个 image、几个可选项） / `promptOptimizer.enabled` + `asSubagentSystemPrompt` / `needsRead`（true = 必须先读提示词优化文档）。

> `needsRead=true` 时，回执里直接写明"运行前必须先用 `runninghub_call({action:'prompt.doc_read'})` 读该文档再优化提示词"。这是用户要的"会在 llm 调用 rh_workflowget 时显示需要阅读该文件优化提示词"。

### 5.2 `runninghub_call`

```
{ action: string, ...payload }
```

| action | 载荷 | 说明 |
|---|---|---|
| `workflow.get` | `{ name }` | 工作流详情：每个节点的 role/字段/范围/默认值/枚举；提示词优化设置 |
| `workflow.probe` | `{ workflowId, region? }` | 调官方接口取 JSON，返回**推断后的节点提案**供 LLM 与用户确认（不落盘） |
| `workflow.configure` | `{ name, ...patch }` | 落盘一个工作流配置（AI 辅助配置的终点） |
| `workflow.update` | `{ name, patch }` | 局部更新（节点覆盖、枚举、开关） |
| `workflow.delete` | `{ name }` | 删除配置（不删 RH 侧工作流） |
| `workflow.validate` | `{ name }` | 干跑校验：必填项缺不缺、region 池有没有可用 key |
| `workflow.run` | `{ name, prompt?, negativePrompt?, params?, images?, region?, instanceType?, waitMs? }` | **后台化**：提交后立刻返回 `taskId`。`waitMs` 给了才等到完成（≤ 上限），默认 0 = 纯后台 |
| `task.list` | `{ status?, limit? }` | 本地任务流水 |
| `task.status` | `{ taskId }` | 查 RH 侧 + 本地状态 |
| `task.wait` | `{ taskId, timeoutMs? }` | 等到终态；成功则**下载结果并作为附件返回**（图片在聊天里直接显示） |
| `task.cancel` | `{ taskId }` | 取消 |
| `account.balance` | `{ region? }` | 余额 / 当前任务数 / 账号类型 |
| `account.keys` | `{}` | Key 列表（**掩码**）+ 地域 + 冷却状态 |
| `prompt.doc_read` | `{ name \| docId }` | 读提示词优化文档全文 |
| `prompt.doc_write` | `{ name, content, filename? }` | 写文档（也供 UI 用） |
| `prompt.optimize` | `{ name, userRequest }` | 若开了子代理→调无工具极简子代理写提示词；否则返回"需要主模型自己按文档优化" |
| `diagnostics` | `{}` | 自检：数据目录、key 池、版本、加载到的宿主 API 版本（范本见 blender 插件 `doctor`） |

**错误约定**：不抛异常给模型看堆栈，而是返回 `{ ok:false, error:{code,message,hint} }`，`code` 稳定可判（`NO_KEY` / `KEY_EXHAUSTED` / `WORKFLOW_NOT_FOUND` / `NODE_MISSING` / `UPLOAD_FAILED` / `TASK_FAILED` / `TRANSPORT_UNCERTAIN` / …）。

### 5.3 runninghub_run 的后台化实现

**Lead 决策**：不依赖 `ctx.jobs` 的自定义 kind（`JobKind` 只声明了 `bash`/`subagent`，有被拒风险）。
自建 `host/core/runner.mjs`：

- `submit()` → 记 `tasks/<taskId>.json`（`status:'QUEUED'`），返回 taskId，**立刻 return**。
- 插件内一个串行轮询器（可 `unref()` 的 timer）在后台按 3s→5s→10s 退避查 `/task/openapi/outputs`（或 `/openapi/v2/query`），写回流水。
- **`task.wait`**（或 `workflow.run` 带 `waitMs`）才阻塞等待，并在成功时 `download → attachments.saveImage/saveFile → 返回 image/file content block`，这样图片直接在聊天里渲染。
- `dsh-api` 负责实证 `ctx.jobs` 是否接受自定义 kind；**若可接受且标准 `job_list`/`job_output` 能读到**，Lead 再补一层可选桥接（不阻塞主线）。

## 6. Skill（`skills/runninghub-workflow-setup/SKILL.md`）

通过 `ctx.skills.register({ name, description, content, source:'bundled', invocation:{modelInvocable:true, userInvocable:true} })` 注册，`content` 在 `apply()` 里从包内读文件（相对 `import.meta.url`，不要用 cwd）。

Skill 要写清的流程：
1. 问用户要 RunningHub 工作流链接/ID（`https://www.runninghub.cn/ai-detail/<id>` 或 `/workflow/<id>`）。
2. `runninghub_call({action:'workflow.probe', workflowId})`。
3. 拿回节点提案后**逐项用提问确认**（提示词节点、负向、参考图节点、可选参数范围、输出类型、工作流显示名、region）。
4. 问是否开启提示词优化 / 是否挂文档 / 是否用子代理模式。
5. `runninghub_call({action:'workflow.configure', ...})` 落盘；再 `workflow.validate` 自检。
6. 运行时：`runninghub_search` 找回工作流 → 若 `needsRead` 先 `prompt.doc_read` → 优化提示词 → `workflow.run` → `task.wait` 取结果。

## 7. 主动排雷清单（用户没提，但我们必须处理）

1. **海外/国内 base 不同且 key 不通用** → §3.4 运行时探测，绝不跨池回退。
2. **付费提交的幂等性**：提交返回前网络断了 = 状态未知，**不能自动重发**。流水里记 `TRANSPORT_UNCERTAIN`，让用户核对。
3. **上传体积上限按 key 类型定**，新接口 `/openapi/v2/media/upload/binary` 上限比旧接口 `/task/openapi/upload` **更严**（RHStudio2 实测）→ 两个都试，并把两边的真实错误都回给用户。
4. **上传有效期**：RH 侧文件会过期，跨天复用要重传。
5. **工作流 JSON 的 `prompt` 是字符串**（不是对象），要 JSON.parse。
   **成功码（2026-09-30 由 rh-docs 对 40 个官方页面逐条核对后修正）**：
   - 13 个 `/openapi/v2/*` 端点里，**body 成功码只有 `0`，没有任何一处是 `200`**；
   - `POST /openapi/v2/query`、模型提交型端点、`price-preview` 的**响应体根本没有 `code` 字段**，
     要读 `status` / `errorCode`；
   - 👉 实现口径：`code===0` 判成功；**没有 `code` 字段时读 `status`**；
     同时**宽容接受 `200`** —— 参照实现 RHStudio2 在真机上见过 `/openapi/v2/media/upload/binary`
     返回 `200`，与文档不符，宽容比严格安全（严格会把成功判成失败）。
   - 详见 `docs/api/ERROR-CODES.md`、`docs/api/task-status.md`。
6. **节点值形状**：`inputs.text` 可能是 `{"__value__":[<值>, <是否可编辑>]}` 包装
   （官方全文只出现 `{"__value__":[false,true]}` 一个样例，**第 0 位是裸值**）。
   写值时要还原成裸值，并且**格式不合预期时不能崩**。
7. **`/uc/openapi/accountStatus` 的 body 字段是 `apikey`（全小写）**，其它 A 族接口才是 `apiKey`。
8. **`instanceType` 的合法值是小写 `default|plus|ultra`**（官方 schema 带 enum），不是 `Standard/Plus/Ultra`。
7. **图片输出可能是"隐写载图"**（视频/音频藏在 PNG 里，社区叫"小黄鸭"）→ 保留原图并提示可由 RHStudio2 提取；我们至少**不假装它是普通图片**。
8. **并发额度**：RH 账号有任务数上限，`accountStatus.currentTaskCounts` 要显示，超了要提前告知。
9. **数据目录与日志里不出现明文 key**。
10. **插件加载失败 = 工具整体消失**（blender 插件的血泪教训）：`apply()` 里每一步都要能独立降级；缺 `skills`/`subagents`/`credentials` 服务时不能抛，只记 warn 并在 `diagnostics` 里点名。
11. **DSH 版本漂移**：`schemastery`/`cordis` 有 scope / 无 scope 两种包名，用 `createRequire` 双名解析（照抄 blender 插件 §168-175）。
12. **工具返回值必须是 lossless JSON**：undefined 键、NaN、-0 都会被宿主拒收并打死整条通道 → 统一过一遍 `losslessSanitize`（照抄 blender 插件 §67-130）。
13. **子代理无工具**：`ctx.subagents.start(provider, { toolFilter: { allow: [] }, persona, prompt, parent, signal })`；provider 名要运行时探测（`ctx.subagents.list()`），别硬编码。
14. 工作流名冲突、重复配置、改名 → 用 `displayNameEn` 做稳定 slug，重名时明确报错而不是覆盖。

## 8. 验收（Lead 最终负责）

**实际结果见 `docs/ACCEPTANCE.md`**（含原始证据）。摘要：

- ✅ `node --test` 三个套件全绿：`tests/core` 177 · `tests/client` 35 · `tests/host` 7 = **219 项 0 失败**。
- ✅ `node tools/loadcheck.mjs` 全绿（离线装载自检，不依赖 DSH）。
- ✅ **真机验收已完成**（插件已装进 `$DSH_HOME/profiles/desktop` 并在**运行中**的 DSH 桌面版里生效）：
  - 模型侧 `runninghub_search` / `runninghub_call` **已出现**；
  - `diagnostics` → `coreReady:true`、宿主 API 解析成功、数据目录正确；
  - 面板数据面 `POST /plugins/dsh-runninghub-plugin/api` → **HTTP 200**；
  - 浏览器半边 tab 在 client Slots 里 `registrant: dsh-runninghub-plugin, active: true`；
  - **真实 RunningHub 接口连通已验证**（无效 Key → 正确报 `AUTH`；直连复验两个平台均回 `code:806 APIKEY_USER_NOT_FOUND`）。
- ⏳ **未做**：用**有效 Key** 真跑一次付费生成（需要用户提供 Key，见 `ACCEPTANCE.md` §5）。
- 安装/卸载：`node tools/install.mjs [--profile X] [--dry-run] [--uninstall]`（幂等、带备份、拒绝误删别人的补丁段）。

## 9. 团队与写作用域

| 成员 | 任务 | 写作用域 |
|---|---|---|
| **Lead** | 工具层、skill、装配、集成、验收 | `host/index.mjs` `host/runtime.mjs` `host/shared.mjs` `host/jobs.mjs` `host/rpc.mjs` `host/skill.mjs` `host/tools/**` `skills/**` `package.json` `cordis.patch.yml` `README.md` `docs/DESIGN.md` `docs/ACCEPTANCE.md` `tools/**` |
| `rh-docs` | 官方 API 全量提取 + **独立核验** | `docs/api/**` |
| `dsh-api` | DSH 插件 API 实证 + 探针 | `docs/dsh/**` `probe/**` `host/rpc-remote.mjs` |
| `rh-core` | 协议层 | `host/core/**` `tests/core/**` |
| `rh-ui` | 浏览器半边 | `client/**` `tests/client/**` |

**不要动别人的作用域**；接口要变先改本文件并在消息里说清。

### 9.1 为什么让 `rh-docs` 去核验 `rh-core`（task-5）

写文档的人和写代码的人**不是同一个**，让前者用官方原文去核对后者的实现，是这里唯一一次真正的第三方核验。
它抓到了一个**P0**：`AUTH_HINTS` 里包含裸子串 `'apikey'`，会命中官方 12 个含 `APIKEY` 的标识
（803/804/805/807/808/809/813…）—— 用户配错一个 `nodeId`（803）就会被判成 `AUTH`，
进而把一把**完全健康**的 Key 永久标记为失效（且无自动过期）。核验脚本给出的最小复现：

```bash
node -e "import('…/host/core/api.mjs').then(m=>console.log(m.classifyBusiness(803,'APIKEY_INVALID_NODE_INFO')))"
# 修复前 AUTH → 修复后 BUSINESS
```

**教训（写进契约）**：错误分类里的关键词匹配必须**先查数值码表、再做词匹配，且词要 `\b` 锚定**；
否则一个宽泛的裸子串就能把一整类业务错误误判成认证失败，而认证失败的处置是"废弃 Key"——
**误判的代价是不可逆的**。这类"分类器的假阳性"比"分类不出来"危险得多。
