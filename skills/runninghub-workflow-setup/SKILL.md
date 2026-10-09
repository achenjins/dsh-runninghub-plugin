---
name: runninghub-workflow-setup
description: 用提问的方式帮用户把一个 RunningHub 工作流配置进 dsh-runninghub-plugin —— 从官方接口拉工作流 JSON、识别每个节点是干什么的、逐项与用户确认后落盘，并配置提示词优化与多 Key。
whenToUse: 用户说「配置工作流」「加一个工作流」「把 RunningHub 的工作流接进来」「这个工作流怎么用」，或者未带筛选的 workflow.get 返回空列表、或者运行的报错指向工作流配置缺失时。
---

# RunningHub 工作流配置（AI 辅助）

你正在帮用户把一个 **RunningHub 工作流**接入 `dsh-runninghub-plugin`。配置完以后，模型就能
用 `runninghub_call` 查询并运行它，并且生成的图 / 视频会直接回到聊天里。

开始前调用无参数的 `runninghub_search({})` 获取 `runninghub_call` 各动作的使用方式。
工作流、生成记录和其它业务数据都通过 `call` 的对应动作查询。

> **唯一优先标准**是 RunningHub 官方 API 文档 <https://www.runninghub.cn/runninghub-api-doc-cn/>。
> 本 skill 只描述**流程与提问方式**；接口字段一切以官方文档为准。

---

## 0. 先决条件：至少有一把可用的 Key

调用 `runninghub_call({ action: "account.keys" })` 看一眼。

- 一把都没有 → 请用户在 DSH 配置面板「Key 池管理」添加 Key，再查一次 `account.keys`。
  Key 可在 runninghub.cn / runninghub.ai 的「API 调用」页取得，明文只填到面板，别让用户发到聊天里。
- **国内（runninghub.cn）与海外（runninghub.ai）的 Key 不通用**。面板可以选择地域或自动探测。
- 已有 Key 被标记失效时，可在面板点「重新验证」，或通过本地 id 调用 `key.detect`；验证成功后恢复可用状态。

---

## 1. 拿到工作流 ID

问用户要有 RunningHub 工作流的**链接**，从中取数字 ID：

| 链接形态 | 取哪一段 |
|---|---|
| `https://www.runninghub.cn/ai-detail/1988xxxxxxxxxxxxxxx` | 最后的数字串 |
| `https://www.runninghub.cn/workflow/1988xxxxxxxxxxxxxxx` | 最后的数字串 |
| 直接给一串数字 | 就是它 |

**一次只配一个工作流**。用户一次给多个就排队，配完一个再配下一个。

---

## 2. 拉取并识别节点（不要凭空猜）

```js
runninghub_call({ action: "workflow.probe", workflowId: "<ID>", region: "cn" })   // region 可省，插件会按可用 Key 推断
```

插件会调官方接口 `/api/openapi/getJsonApiFormat` 拿到工作流 JSON，并**自动推断每个节点的角色**：

- 哪个是正向提示词、哪个是负向提示词
- 哪些是参考图 / 参考视频 / 参考音频
- 哪些是可调数值（steps / cfg / seed / 宽 / 高 …）以及取值范围
- 输出类型（生图 / 生视频 / 生音频 / 3D）

**推断只是提案，必须逐项向用户确认。** 不要默默接受，也不要把"推断"说成"读取到的"。

返回的 `config` 是待确认的配置，节点只在 `config.nodes` 中出现一次。修改后直接把 `config` 传给 `workflow.configure`；`warnings` 是识别过程中发现的问题。

---

## 3. 用提问的方式逐项确认（这一步是重点）

按下面的顺序问，**每组问题一次问完，不要一口气问二十个**。
用 `ask_user_question` 工具问时给出**选项**，别让用户手打。

### 第 1 组 · 身份
1. 这个工作流在我们这边叫什么名字？（给个中文名）
2. 输出是什么？`生图` / `生视频` / `生音频` / `3D` / `混合`
3. 一句话说明它是干什么的（会出现在 `workflow.get` 的概览列表里，模型靠它选工作流）
4. 用国内还是海外的 Key？

### 第 2 组 · 提示词
5. 哪个节点是**正向提示词**？（给出推断的节点 + 其它候选让用户选）
6. 有没有**负向提示词**节点？没有就跳过。
7. 提示词里的哪些参数希望每次都能改？（例如镜头、光照、画幅）

### 第 3 组 · 参考素材
8. 这个工作流需不需要**用户提供参考图 / 视频 / 音频**？分别是哪个节点？
9. 是必填还是可选？

### 第 4 组 · 可调参数
10. 列出推断出的数值参数，逐个问：**要不要暴露给用户调？范围是多少？**
    - 宽 / 高：常见 512–2048，步长 8 或 64
    - steps：常见 1–50
    - cfg：常见 1–20
    - seed：按选定工作流的节点配置设置，不要统一套用 `-1`
11. 有没有**下拉选项**类参数（画幅比例、采样器、调度器）？
    ⚠️ **只填工作流真的支持的值**。插件不会猜服务端允许的枚举值 —— 拿不准就让用户从 RunningHub 页面上照抄，或者留空当普通文本。

### 第 5 组 · 提示词优化（可选，但用户很在意）
12. 要不要开**提示词优化**？
13. 开的话，有没有一份**规范文档**（txt / md）要挂上？有就让用户给文件内容或路径 ——
    用 `runninghub_call({ action: "prompt.doc_write", name: "<文档名>", content: "<正文>" })` 存进插件数据，
    再把返回的 `docId` 记下来。
14. **要不要用子代理模式？**
    - `true` → 运行前会把这个文档当系统提示词交给一个**无工具、极简模式**的子代理去写提示词（省主模型上下文，风格更稳定）
    - `false` → 主模型自己按文档改写提示词
    跟用户说清区别，让用户选。

---

## 4. 落盘

```js
runninghub_call({
  action: "workflow.configure",
  name: "<中文名>",
  workflowId: "<RH 工作流 ID>",
  region: "cn",
  config: {
    outputKind: "image",
    description: "……",
    tags: ["文生图"],
    instanceType: "default",
    nodes: [ /* 第 2–4 组确认后的节点，直接改 workflow.probe 给的提案 */ ],
    promptOptimizer: {
      enabled: true,
      docId: "<prompt.doc_write 返回的 docId>",
      asSubagentSystemPrompt: true,
      targetNodeId: "<正向提示词节点 id>",
      extraInstruction: ""
    }
  }
})
```

节点对象至少要填：`nodeId` / `classType` / `title` / `role` / `fieldName` / `label` / `required` /
`valueType` / `default`，数值再加 `min` / `max` / `step`，枚举再加 `options`。

---

## 5. 自检并交付

```js
runninghub_call({ action: "workflow.validate", name: "<中文名>", prompt: "<本次提示词>", params: {}, images: {} })
```

- 有 `NO_KEY` → 回第 0 步，该地域还没有 Key。
- 按运行时相同的规则检查本次输入；需要素材或参数时一并传入，无提示词节点的工作流也可使用。
- 有 `NODE_MISSING` → 根据返回的节点和字段补齐本次输入，或修正必填配置。
- 全绿 → 告诉用户：

> 「配置好了。以后你说要生成什么，我会用 `workflow.get` 选工作流并读取节点配置，按你的优化文档
> 把提示词写到位，然后后台跑、把图贴回来。」

**别自己偷偷跑一次付费任务来"验证配置"** —— 除非用户明确同意。

---

## 6. 运行时怎么用（配完之后）

```
runninghub_search({})                               ← 获取全部动作的使用方式
  ↓
runninghub_call({action:"workflow.get"})               ← 从简短介绍中选工作流；可加 query 模糊筛选
  ↓
runninghub_call({action:"workflow.get", name:"…"})  ← 看节点细节（哪个字段是提示词、范围多少）
  ↓
（若选定工作流的详情要求先读提示词优化文档）
runninghub_call({action:"prompt.doc_read", name:"…"})     ← 读优化文档
runninghub_call({action:"prompt.optimize", name:"…", userRequest:"用户想要什么"})
       ↳ 开了子代理模式 → 插件调无工具子代理按文档写提示词并返回
       ↳ 没开 → 返回文档，让你自己改写
  ↓
runninghub_call({action:"workflow.run", name:"…", prompt:"…", params:{…}, images:{…}})   ← 立刻返回 taskId
  ↓
runninghub_call({action:"task.wait", taskId:"…", timeoutMs:600000})                      ← 图/视频直接出现在聊天里
```

`workflow.get` 不传 `name` 时只返回 `name`、`displayNameEn`、`description`、`outputKind`、`tags`；
`query` 按名称、英文名、描述或标签模糊筛选。传 `name` 才返回选定工作流的完整节点配置。

> **`images` 填什么**：`{"<nodeId>": "<本地绝对路径 或 RunningHub 文件名>"}`。
> 本地路径（如 `E:\refs\a.png`）**插件会自动上传**，用的是和提交同一把 Key；
> 已经是 RH 文件名的值（如 `openapi/a.png`）原样使用，不会重复上传。
> 上传失败会**如实报错**（含新/旧两个上传接口的原文），不会把本地路径发给 RunningHub。
> 节点 id 与字段名看 `runninghub_call({action:"workflow.get", name:"…"})` 返回的「输入素材」节点，不要从概览列表猜。

### 前台 vs 后台（生图动辄一两分钟，选对了才不浪费时间）

| 模式 | 用法 | 什么时候用 |
|---|---|---|
| **提交（默认）** | `workflow.run({name, prompt})` | 立即取得任务 ID，随后用 `task.wait` 取结果 |
| **同步等待** | `workflow.run({name, prompt, waitMs:120000})` | 等待至多两分钟；超时后用 `task.wait` 继续取结果 |
| **后台** | `workflow.run({name, prompt, background:true})` | **用户还要你干别的**、或者要一次跑好几张 —— 提交后立刻返回，你能继续做别的事 |

后台模式下：

```
🚀 后台生图中 · 1 个 · Qwen 图像编辑 · 作业 runninghub-3
  · 2105211607457161218
跑完会自动通知（含本地路径）。
```

- 跑完宿主会**自动往这个会话注入一条完成通知**，里面带**本地文件路径**；
- 通知里只有路径（作业注入的是文本）—— **要在聊天里真的看到图，再调一次 `task.wait`**；
- 用标准 `job_list` / `job_output` 随时看进度，不用学新工具。

**默认存到哪**：优先使用插件配置的 `outputDir`；未配置时存到会话工作目录下的 `runninghub-output/`（自动新建）。
拿不到会话工作目录时，使用数据目录下的 `outputs/<taskId>/`。
想改就传 `saveDir:"角色素材"`（相对名按工作目录解析）或 `saveDir:"E:\\素材"`；
想指定文件名就传 `fileName:"黑龙骑士_三视图"`（可省扩展名，多张自动去重成 `_2`/`_3`）。

---

## 7. 踩坑提醒（配置阶段最容易出错的地方）

1. **Key 不通用**：国内 Key 打海外接口只会拿到 401，白费一次调用。地域不确定就在面板探测，或对已有 Key 调用 `key.detect`。
2. **提交不等于免费**：`workflow.run` 一旦提交就可能扣费。**不要自动重试**；回执里出现 `TRANSPORT_UNCERTAIN` 时，让用户去 RunningHub 后台按提交时间 / 工作流 ID 核对任务到底建没建成，别重投：找到了用 `task.adopt`（`taskId` + `remoteTaskId`）接回，确认没有用 `task.dismiss` 结案。回执里是 `LOCAL_QUEUED`（本地排队）时，说明并发已满、还没提交也没扣费，插件会自动重投，**不要**再提交一次。
3. **插件单文件上传上限为 128 MiB**，平台或 Key 档位还可能有更低的限制。新、旧上传接口都失败时，回执会保留两边的原因。
4. **上传的文件会过期**，跨天复用参考图要重传。
5. **工作流 JSON 里的 `prompt` 字段是字符串**不是对象，插件已经处理；你自己看原始 JSON 时别踩。
6. **节点输入可能是 `{"__value__": [false, true]}` 这种包装**（RunningHub 用它标记"可编辑"）。写值时要还原成裸值，插件已处理。
7. **有些工作流把视频藏在 PNG 里**（社区叫"小黄鸭"格式）。如果输出是 PNG 但用户要的是视频，先说清这个可能，别假装它是普通图片。
8. **别猜枚举值**。下拉选项必须来自工作流真实取值或用户提供；猜错会让任务跑失败还照样扣费。
9. **同名工作流会冲突**。用户给的名字若已存在，明确告诉用户"已存在"，问是覆盖还是改名，**不要静默覆盖**。
