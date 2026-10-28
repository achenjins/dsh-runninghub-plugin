---
name: runninghub-workflow-setup
description: 用提问的方式帮用户把一个 RunningHub 工作流配置进 dsh-runninghub-plugin —— 从官方接口拉工作流 JSON、识别每个节点是干什么的、逐项与用户确认后落盘，并按需配置提示词优化。
whenToUse: 用户说「配置工作流」「加一个工作流」「把 RunningHub 的工作流接进来」，或发来 RunningHub 工作流链接 / ID 要求接入时；不带筛选条件的 workflow.get 返回空列表、运行报错指向工作流配置缺失时也要读取。
---

# RunningHub 工作流配置（AI 辅助）

你正在帮用户把一个 **RunningHub 工作流**接入 `dsh-runninghub-plugin`。配置完成后，模型就能用
`runninghub_call` 查询并运行它；运行方法见 skill `runninghub-generate`。

不知道动作或参数时调用无参数的 `runninghub_search({})` 获取使用方式；已知时直接调用。
`runninghub_call` 只接收 `action` 和 `args`，动作参数统一放在 `args` 对象中。

> 接口字段**一切以 RunningHub 官方 API 文档为准**：<https://www.runninghub.cn/runninghub-api-doc-cn/>。
> 本 skill 只描述**流程与提问方式**。

**整体流程**：确认有可用 Key → 拿到工作流 ID → `workflow.probe` 拉取并推断节点 → 分组向用户确认 →
`workflow.configure` 保存 → `workflow.validate` 自检。**整个配置过程都不运行付费任务。**

---

## 0. 先决条件：至少有一把可用的 Key

调用 `runninghub_call({ action: "account.keys" })` 查看 Key 池。

- 一把都没有 → 请用户在 DSH 配置面板「Key 池管理」添加 Key，再查一次 `account.keys`。
  Key 可在 runninghub.cn / runninghub.ai 的「API 调用」页取得，**只在面板里填写，别让用户发到聊天里**。
- **国内（runninghub.cn）与海外（runninghub.ai）的 Key 不通用**，工作流也分属两个平台。面板添加 Key 时可以选地域或自动探测。
- 已有 Key 被标记失效时，可在面板点「重新验证」，或用本地 id 调用 `key.detect`；验证成功后恢复可用。

---

## 1. 拿到工作流 ID

向用户要 RunningHub 工作流的**链接**，从中取出数字 ID，并按域名确定地域：

| 用户给的 | 怎么处理 |
|---|---|
| `https://www.runninghub.cn/workflow/1988xxxxxxxxxxxxxxx` | 取最后的数字串，`region: "cn"` |
| `https://www.runninghub.cn/ai-detail/1988xxxxxxxxxxxxxxx` | 同上 |
| `runninghub.ai` 域名下的同类链接 | 取最后的数字串，`region: "overseas"` |
| `https://www.runninghub.cn/post/…` 或 `https://www.runninghub.ai/zh-cn/post/…`（作品分享页） | 请用户先在页面上点「运行工作流」，进入工作流后再保存为自己的工作流，然后发自己账号下那份工作流页面的网页链接（或 ID）。海外站保存后可在 <https://www.runninghub.ai/zh-cn/workspace?inviteCode=c1ooihmg> 找到 |
| 直接给一串数字 | 就是工作流 ID；地域不确定时可省略 `region`，插件会按可用 Key 推断 |

**一次只配一个工作流**。用户一次给多个就排队，配完一个再配下一个。

---

## 2. 拉取并识别节点（不要凭空猜）

```js
runninghub_call({ action: "workflow.probe", args: { workflowId: "<ID>", region: "cn" } })   // region 可省，插件会按可用 Key 推断
```

插件会调用官方接口 `/api/openapi/getJsonApiFormat` 拿到工作流 JSON，并**自动推断每个节点的角色**：

- 哪个是正向提示词、哪个是负向提示词
- 哪些是参考图 / 参考视频 / 参考音频的输入
- 哪些是可调数值（steps / cfg / seed / 宽 / 高 …）以及取值范围
- 输出类型（生图 / 生视频 / 生音频 / 3D …）

返回的 `config` 是一份**待确认的配置提案**，节点都在 `config.nodes` 里；`warnings` 是识别时发现的问题，要转告用户。
素材槽默认可选，只有确认后才设 `required: true`。低置信度提示词、布尔开关和单值枚举需要核对；`overridable` 仅是 RH 界面标记，不限制 API 覆盖。素材节点的 `targets` 标明真实远端输入（例如 image_6），图序不能按节点 ID 排大小；需要完整连线时加 `includeGraph: true`，要看隐藏内部记录加 `includeInternal: true`。`fetchedAt/cacheId/cacheHit` 记录本次远端读取状态，当前每次都会重取。已有同 RH ID/地域配置时附 `comparisons`，只列节点增删和变化字段，不重复整份旧配置。
probe 报 `NO_KEY` 或取不到 JSON 时，多半是地域不对，或这把 Key 无权读取该工作流：回到第 0、1 步核对。

**推断只是提案，必须逐项向用户确认。** 不要默默接受，也不要把"推断出的"说成"读取到的"。

---

## 3. 分组向用户确认（这一步是重点）

按下面的顺序**分组提问**：每次只问一组，不要一口气把所有问题都抛给用户。
用 `ask_user_question` 工具提问时尽量给出**选项**，并把推断结果作为默认选项，别让用户手打。

### 第 1 组 · 基本信息
1. 这个工作流叫什么名字？（给个中文名；可以顺便定一个英文标识 `displayNameEn`）
   - 定下名字后先用 `workflow.get`（`args: { name }`）查一下：**已有同名工作流时，问用户是覆盖还是改名**。
     `workflow.configure` 遇到同名不同 id 会返回 NAME_CONFLICT；已有同 id 的配置会返回 WORKFLOW_EXISTS，用户明确确认后传 overwrite:true 才覆盖。
2. 输出是什么？`生图` / `生视频` / `生音频` / `3D` / `文本` / `混合`
3. 一句话说明它是干什么的。这句话会出现在 `workflow.get` 的简介列表里，模型靠它挑工作流，要写清适用场景。
4. 用国内还是海外的 Key？（一般与工作流所在平台一致）

### 第 2 组 · 提示词
5. 哪个节点是**正向提示词**？（给出推断的节点和其它候选让用户选）
6. 有没有**负向提示词**节点？没有就跳过。

### 第 3 组 · 参考素材
7. 需不需要用户提供**参考图 / 视频 / 音频**？分别对应哪个节点？
8. 每个素材是必填还是可选？（同类素材通常只有第一个必填）

### 第 4 组 · 可调参数
9. 哪些参数希望每次运行都能调整？（例如画幅、步数、种子）其余的保持工作流里的值即可。
   - 用户不打算调的节点可以从 `config.nodes` 中删掉：运行时不再提交这些节点，沿用工作流里保存的值，读取节点配置时也更简短。
10. 对保留下来的数值参数，逐个确认**默认值和范围**：
    - 宽 / 高：常见 512–2048，步长 8 或 64
    - steps：常见 1–50
    - cfg：常见 1–20
    - seed：按该工作流的节点配置设置，不要统一套用 `-1`
    - 用户确认过的范围，把该节点的 `boundsSource` 设为 `"user"`，运行前才会强制校验；
      保留 `"heuristic"` 的范围只是插件给的常见区间，越界只警告、不拦截。
11. 有没有**下拉选项**类参数（画幅比例、采样器、调度器）？
    - ⚠️ **只填工作流真正支持的值**。插件不会猜服务端允许的枚举值 —— 拿不准就让用户从 RunningHub 页面上照抄，或者留空当普通文本。
    - 用户提供了候选清单时，设 `valueType: "enum"`、填 `options`，并把 `optionsSource` 设为 `"user"`，运行前才会按清单校验。

### 第 5 组 · 提示词优化（可选，但用户很在意）
12. 要不要开**提示词优化**？
13. 开的话，有没有一份**规范文档**（txt / md）要挂上？有就让用户给出文件内容或路径，
    用 `runninghub_call({ action: "prompt.doc_write", args: { name: "<文档名>", content: "<正文>" } })` 存进插件数据，
    记下返回的 `docId`。
14. **要不要用子代理模式？**
    - `true` → 运行前把这份文档当作系统提示词，交给一个**无工具、极简模式**的子代理去写提示词（省主模型上下文，风格更稳定）
    - `false` → 由主模型自己读文档、改写提示词

    跟用户说清两者的区别，让用户选。

---

## 4. 保存配置

把 `workflow.probe` 给的 `config` 按确认结果修改后，原样传给 `workflow.configure`：

```js
runninghub_call({
  action: "workflow.configure",
  args: {
    name: "<中文名>",
    workflowId: "<RH 工作流 ID>",
    region: "cn",
    config: {
      displayNameEn: "<英文标识，可省>",
      outputKind: "image",
      description: "……",
      tags: ["文生图"],
      instanceType: "default",
      nodes: [ /* 第 2–4 组确认后的节点，直接在 workflow.probe 的提案上修改 */ ],
      promptOptimizer: {
        enabled: true,
        docId: "<prompt.doc_write 返回的 docId>",
        asSubagentSystemPrompt: true,
        targetNodeId: "<正向提示词节点 id>",
        extraInstruction: ""
      }
    }
  }
})
```

节点对象至少要有：`nodeId` / `classType` / `title` / `role` / `fieldName` / `label` / `required` /
`valueType` / `default`；数值再加 `min` / `max` / `step`（及 `boundsSource`），枚举再加 `options`（及 `optionsSource`）。

保存后若还要改个别字段，用 `workflow.update`（`args: { name, patch }`），`patch` 的对象字段可只写要改的部分；数组（尤其 nodes）会整体替换，必须先读取完整数组，保留每条完整 nodeId、fieldName、role、valueType 后再修改并提交，不可只传一个节点的零散字段。

刷新已保存工作流时，可用 `workflow.update` 的 `mergeNodes:true`：按完整 `nodeId+fieldName` 只刷新原先选中节点的连线、类型和标题，保留人工 label/options/范围/默认值，不自动新增或删除节点。先加 `dryRun:true` 看差异，再去掉它保存。需要调整节点选择或人工字段时按普通 patch 更新。`workflow.configure` 也支持 `dryRun:true` 只预览，不写盘。

---

## 5. 自检并交付

```js
runninghub_call({ action: "workflow.validate", args: { name: "<中文名>", prompt: "<示例提示词>", params: {}, images: {} } })
```

`workflow.validate` 按运行时的规则检查输入：需要素材或参数时一并传入；没有提示词节点的工作流也可以用它预检。它不上传素材、不提交任务、不扣费。

- 有 `NO_KEY` → 回第 0 步，该地域还没有可用的 Key。
- 有 `NODE_MISSING` → 根据返回的节点和字段补齐本次输入，或修正必填配置。
- 全部通过 → 告诉用户：

> 「配置好了。以后你说要生成什么，我会选好工作流、按你的优化文档写好提示词，提交后把结果取回到聊天里。」

**别自己偷偷跑一次付费任务来"验证配置"** —— 除非用户明确同意。

---

## 6. 配完之后

用户要生成内容时，按 skill `runninghub-generate` 的流程操作：`workflow.get` 选工作流并读取节点配置 →
按需优化提示词 → `workflow.run` 提交 → `task.wait` 把结果取回聊天。

---

## 7. 踩坑提醒（配置阶段最容易出错的地方）

1. **Key 不通用**：国内 Key 调海外接口只会拿到 401，白费一次调用。地域不确定就在面板探测，或对已有 Key 调用 `key.detect`。
2. **覆盖需明确确认**：`workflow.configure` 会拒绝同名不同 id；已有同 id 需明确 overwrite:true，保存前一定先查重并问用户（见第 1 组）。改名用 `workflow.rename {name,newName}`，复制配置用 `workflow.clone {name,newName}`；name 可用稳定本地 ID。
3. **别猜枚举值**：下拉选项必须来自工作流的真实取值或用户提供；猜错会让任务失败，而且照样扣费。
4. **工作流 JSON 里的 `prompt` 字段是字符串**而不是对象，插件已经处理；你自己看原始 JSON 时别踩坑。
5. **节点输入可能是 `{"__value__": [false, true]}` 这种包装**（RunningHub 用它标记"可编辑"）。写值时要还原成裸值，插件已处理。
6. **有些工作流把视频藏在 PNG 里**（社区叫"小黄鸭"格式）。确认输出类型时问清用户真正要的是视频还是图片，别想当然。
7. **文档选择要明确**：先 `prompt.doc_list` 列文档，按 `docId` 或文档名称 `name` 读取；按工作流取关联文档时用 `workflow`。保存配置后的 warnings 包含文档、提示词目标及枚举来源问题，应处理后再运行。
