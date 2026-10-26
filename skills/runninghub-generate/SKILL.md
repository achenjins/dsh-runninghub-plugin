---
name: runninghub-generate
description: 用 dsh-runninghub-plugin 运行 RunningHub 工作流生成图片、视频、音频的操作手册 —— 选工作流、写提示词、传参考素材、提交任务、把结果取回聊天，以及排队、待核对等状态的处理。用户一要生成内容，就先读这份再调用 runninghub_call。
whenToUse: 用户要求生图、画图、出图、改图、换背景、抠图，生成视频、音频或 3D，或要求运行某个 RunningHub 工作流时，在第一次调用 runninghub_call 之前立即读取。
---

# 用 RunningHub 工作流生成图片 / 视频 / 音频

用户要生成内容时，按下面的顺序调用 `runninghub_call`。不确定某个动作的参数时，调用无参数的 `runninghub_search({})` 查用法。

`runninghub_call` 只接收 `action` 和 `args`，动作参数统一放在 `args` 对象中。

---

## 1. 选工作流

```js
runninghub_call({ action: "workflow.get" })                              // 列出已配置工作流的简介
runninghub_call({ action: "workflow.get", args: { query: "视频" } })      // 按名称、英文名、描述或标签筛选
runninghub_call({ action: "workflow.get", args: { name: "<工作流名>" } })  // 读取选定工作流的完整节点配置
```

- 按简介里的输出类型和描述挑最合适的工作流；有几个都合适、拿不准时问用户。
- **列表为空**说明还没有配置任何工作流：改读 skill `runninghub-workflow-setup`，先帮用户配置一个。
- 提交前**必须**传 `name` 读一次节点配置，看清提示词节点、参考素材节点的 `nodeId`、参数的字段名、取值范围和下拉选项。不要凭简介猜节点 ID。

---

## 2. 写提示词

看 `workflow.get` 详情里「提示词优化」那一行：

| 详情显示 | 做法 |
|---|---|
| 未开启 | 直接把用户的要求整理成提示词 |
| 已开启 · **子代理模式** | 调用 `prompt.optimize`（`args: { name, userRequest: "用户的原始要求" }`），把返回的 `prompt` 用于提交；不必先读文档 |
| 已开启（不是子代理模式） | 先调用 `prompt.doc_read`（`args: { name }`），按文档自己改写提示词 |

---

## 3. 提交任务

```js
runninghub_call({
  action: "workflow.run",
  args: {
    name: "<工作流名>",
    prompt: "<提示词>",
    images: { "<nodeId>": "<本地绝对路径或 RunningHub 文件名>" }, // 需要参考素材时才传
    params: { "<nodeId>:<字段名>": "<值>" }                        // 只覆盖用户要求改的参数
  }
})
```

- 参考素材传**本地绝对路径**（或已上传过的 RunningHub 文件名），插件会用提交任务的同一把 Key 自动上传本地文件；拿不到路径时请用户提供。
  单个文件不超过 128 MiB；上传失败会如实报错，不要换别的方式绕过。
- `params` 推荐用 `"节点ID:字段名"` 精确指定；下拉参数只能填 `workflow.get` 列出的选项，数值不要超出给出的范围。
- 一次要出多张时传 `repeat`（1–20），不要连续调用多次 `workflow.run`。
- 需要时用 `saveDir` / `fileName` 指定保存位置和文件名；不传时保存到会话工作目录下的 `runninghub-output/`。
- 拿不准参数时，可先用 `workflow.validate`（参数与 `workflow.run` 相同）预检，它不提交任务、不扣费。

提交方式三选一：

| 方式 | 加在 args 里 | 适用场景 |
|---|---|---|
| 默认 | 不传 `waitMs` / `background` | 立即返回任务 ID，接着用 `task.wait` 取结果 |
| 同步等待 | `waitMs: 120000` | 用户就在等这一个结果；完成时直接返回附件 |
| 后台 | `background: true` | 用户还要你做别的事，或一次要出很多张 |

---

## 4. 取回结果

```js
runninghub_call({ action: "task.wait", args: { taskId: "<任务 ID>" } })
```

- `task.wait` 会把图片 / 视频作为附件直接放进聊天，用户就是这样看到结果的。**提交后一定要取回结果**，不要只把任务 ID 丢给用户。
- 后台任务完成时，宿主会往会话里注入一条完成通知，但通知里只有本地路径；要让用户在聊天里看到图，仍需调用一次 `task.wait`。
- 等待超时不等于失败，任务还在 RunningHub 上跑：再调用 `task.wait` 或 `task.status` 即可，**不要重新提交**。
- 下载或附件失败时，用 `task.retry`（`args: { taskId }`）补取，不会重新生成；文件已在本地、只想再发一遍附件时加 `resend: true`。

---

## 5. 特殊状态（务必遵守）

| 回执里出现 | 含义 | 你该做的 |
|---|---|---|
| `LOCAL_QUEUED`（本地排队） | 并发已满或机器不足，RunningHub 还没受理，没有扣费 | 告诉用户正在排队，插件会自动重投；**不要再提交一次** |
| `UNCERTAIN` / `TRANSPORT_UNCERTAIN`（待核对） | 提交时网络中断，任务可能已经创建并扣费 | **不要重试**。请用户到 RunningHub 后台按提交时间、工作流 ID 核对：找到了用 `task.adopt`（`taskId` + `remoteTaskId`）接回，确认没有就用 `task.dismiss` 结案 |
| `NO_KEY` | 该地域没有可用的 Key | 请用户在配置面板「Key 池管理」添加 Key；国内与海外的 Key 不通用 |
| `VALIDATION_FAILED` / `NODE_MISSING` | 缺少必填输入，或参数不合规 | 按提示补齐或修正后再提交 |
| `WORKFLOW_NOT_FOUND` | 工作流名称不对 | 用 `workflow.get` 重新确认名称 |
| 用户要视频，结果却是 PNG | 可能是 RunningHub 的「隐写载图」格式（视频藏在 PNG 里） | 如实告诉用户，不要当成普通图片 |

---

## 6. 不要做的事

- **不要自动重投付费任务**。`workflow.run` 一旦提交就可能扣费；除非用户明确要求，不要因为慢、超时或报错就再跑一次。
- 不要猜节点 ID、字段名或下拉选项，一切以 `workflow.get` 返回的配置为准。
- 不要让用户把 API Key 发到聊天里，Key 只能在配置面板添加。
- 用户只是在提问时，不要为了"演示"擅自运行付费任务。

---

## 示例

用户：「用文生图工作流画一只在竹林里吃竹子的熊猫」

1. `workflow.get` → 在简介里找到「我的文生图」
2. `workflow.get`（`name: "我的文生图"`）→ 提示词节点是 `6`，提示词优化未开启
3. `workflow.run`（`name: "我的文生图"`，`prompt: "一只在竹林里吃竹子的熊猫，……"`）→ 拿到任务 ID
4. `task.wait`（`taskId`）→ 图片出现在聊天里，再告诉用户文件保存在哪
