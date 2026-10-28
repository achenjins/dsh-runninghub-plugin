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
| 已开启（不是子代理模式） | 先调用 `prompt.doc_read`（`args: { workflow: name }`），按文档及工作流 extraInstruction 自己改写提示词 |

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
| 同步等待 | `waitMs: 120000`（整批共享预算，最多 1500000 毫秒） | 用户就在等这一个结果；完成时直接返回附件 |
| 后台 | `background: true` | 立即交还会话，完成后由后台作业通知；模型可继续对话或结束本轮回复等待通知 |

启用后台运行的示例：

```js
runninghub_call({ action: "workflow.run", args: { name: "<工作流名>", prompt: "<提示词>", background: true } })
```

后台回执确认已安排完成通知后，继续处理会话中的其它事项；没有其它事项时，告诉用户任务已在后台运行，然后结束本轮回复等待通知。**不要为了等待而立即调用 task.wait，也不要循环查询 task.status。** 收到完成通知后，若结果尚未在聊天中展示，再调用一次 task.wait 取回附件。若回执明确没有后台通知能力，则按提示主动取回结果。

---

## 4. 取回结果

```js
runninghub_call({ action: "task.wait", args: { taskId: "<任务 ID>" } })
```

- `task.wait` 会把图片 / 视频作为附件直接放进聊天。默认提交模式应接着取回结果；显式后台模式先继续会话或结束本轮回复，收到完成通知后再取回尚未展示的结果。
- 仅显式 background:true 或同步等待超时才挂后台通知。收到通知后，若尚未取回附件，再调用 task.wait；已经展示过的结果不要重复调用。
- 等待超时不等于失败，任务还在 RunningHub 上跑：再调用 `task.wait` 或 `task.status` 即可，**不要重新提交**。
- `ABORTED` / `STOPPED` 表示本地停止等待，远端状态以已有任务记录或后续查询为准。费用只认回执中的 `consumeCoins`；费用未返回时如实说明，不能用钱包余额差估算。
- 提交中途停止不会新增后台通知；部分提交失败也只在明确启用 background:true 时跟踪已成功提交的任务。按返回的任务 ID 继续查询，不能整批重投。
- 结果中的分辨率、时长、帧率、音轨及字节数来自上游记录或本地测量。缺失字段表示未知；validate 的提交字段预览不能预测远端表达式造成的时长量化。
- 下载或附件失败时，用 `task.retry`（`args: { taskId }`）补取，不会重新生成；文件已在本地、只想再发一遍附件时加 `resend: true`。

---

## 5. 特殊状态（务必遵守）

| 回执里出现 | 含义 | 你该做的 |
|---|---|---|
| `LOCAL_QUEUED`（本地排队） | 并发已满或机器不足，RunningHub 还没受理，没有扣费 | 告诉用户正在排队，插件会自动重投；**不要再提交一次** |
| `UNCERTAIN` / `TRANSPORT_UNCERTAIN`（待核对） | 提交时网络中断，任务可能已经创建并扣费 | **不要重试**。请用户到 RunningHub 后台按提交时间、工作流 ID 核对：找到了用 `task.adopt`（`taskId` + `remoteTaskId`）接回，确认没有就用 `task.dismiss` 结案 |
| `NO_KEY` | 该地域当前没有可用的 Key | 先读具体原因：冷却时等待，余额不足时补充额度；池为空时再添加 Key。国内与海外的 Key 不通用 |
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

工具等待上限为25分钟（1500000ms），批量任务共享总截止时间。用户停止只结束本地等待，不会擅自取消或重投远端付费任务。
