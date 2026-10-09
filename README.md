# DSH RunningHub 插件

<p align="left">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js"></a>
  <a href="https://github.com/achenjins/dsh-runninghub-plugin"><img src="https://img.shields.io/badge/DSH-Plugin-007ACC" alt="DSH Plugin"></a>
  <a href="https://www.runninghub.cn"><img src="https://img.shields.io/badge/RunningHub-ComfyUI-FF6B6B" alt="RunningHub"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
</p>

在 DSH 中调用 RunningHub 工作流，生成图片、视频、音频或其它文件。

支持由 AI 对话自动解析并配置工作流，也可在浏览器面板中直观调整节点参数、管理 Key 池与维护提示词规范文档。

> [!NOTE]
> **平台入口与准备工作**：
> - **国内站**：[RunningHub 国内](https://www.runninghub.cn?inviteCode=8cq8uhl8) ｜ [获取国内 API Key](https://www.runninghub.cn/enterprise-api/consumerApi?inviteCode=8cq8uhl8)
> - **海外站**：[RunningHub 海外](https://www.runninghub.ai?inviteCode=bvhsaqdr) ｜ [获取海外 API Key](https://www.runninghub.ai/enterprise-api/consumerApi?inviteCode=bvhsaqdr)
>
> 💎 **通过上述邀请链接注册，可获得 500 RH 币**（平台积分，可用于运行工作流）。
>
> 使用前需要准备：DSH 桌面版、RunningHub API Key，以及支持 API 调用的工作流。国内平台（`.cn`）与海外平台（`.ai`）的账号和 Key 分开使用、互不通用，运行费用由 RunningHub 按平台标准收取。

---

## 安装

```sh
# 安装到 DSH 桌面端
dsh plugin --profile desktop add github:achenjins/dsh-runninghub-plugin
```

安装后**重启 DSH 并刷新页面**。配置面板位于「插件」→「dsh-runninghub-plugin」。

卸载：

```sh
dsh plugin --profile desktop remove dsh-runninghub-plugin
```

- **锁定版本**：可在安装地址后追加 `#<commit>`。
- **免构建**：纯手写原生代码，安装时无需额外批准执行脚本。

<details>
<summary><b>本地开发安装</b></summary>

在仓库根目录执行：

```sh
node tools/install.mjs             # 安装到 profile（自动备份配置）
node tools/install.mjs --uninstall # 撤销安装
```
</details>

---

## 主要功能

- **提示词深度优化（核心功能）**
  - **规范文档库**：在面板上传或编写提示词规范（Markdown / 纯文本），随时挂载到指定工作流。
  - **两种优化模式**：支持主模型读取文档后自行改写；也可开启**「独立子代理」模式**，将文档作为系统设定交由极简子代理专职润色，不占用主模型对话上下文，出词风格更统一。
- **AI 辅助工作流配置**
  - 把 RunningHub 工作流链接直接发给 AI，AI 自动读取 ComfyUI 节点结构，推断提示词、参考图、采样步数等角色，用提问方式确认后自动保存配置。
- **节点可视化精细调优**
  - 提供开箱即用的浏览器配置面板，支持逐项调整节点角色、默认值、必填项、数值范围及下拉枚举选项，未保存的修改拥有草稿保护。
- **多 Key 轮换与资产保护**
  - 支持添加多把 Key 并自动识别所属地域。
  - **物理隔离**：国内池与海外池互不混用，避免无谓调用浪费。
  - **余额不足自动换号**：某把 Key 余额不足时标记为「余额不足」并轮换下一把可用 Key；充值后自动（或在面板点「查余额」）恢复，不会每隔几分钟拿没钱的 Key 再试一次。
  - **并发已满自动排队**：账号并发上限（1520）或独占机器不足（415）时，任务在本地排队、按 30s → 60s → 120s 退避自动重投；前面的任务结束时会提前唤醒。这两种情况 RunningHub 都没有受理、不扣费，Key 也不会被冷却。
  - **防止重复扣费**：网络超时或异常时严格记录为 `UNCERTAIN`（待核对），绝不盲目重投；核对后可用 `task.adopt` 接回远端任务，或用 `task.dismiss` 结案。
- **异步后台生成与结果直达聊天**
  - 任务提交后秒级返回任务 ID，后台静默轮询。支持作业系统通知，调用 `task.wait` 即可将生成的图片/视频作为附件直接渲染在聊天中。
  - 若远端已生成完毕但本地因网络波动下载中断，支持随时一键补下载，无需重新运行。

---

## 快速上手

只需要三步即可跑通：

1. **获取并添加 Key**：
   - 登录对应平台的 API 页面复制专属 API Key：
     - 国内站：[打开国内 API 页面](https://www.runninghub.cn/enterprise-api/consumerApi?inviteCode=8cq8uhl8)
     - 海外站：[打开海外 API 页面](https://www.runninghub.ai/enterprise-api/consumerApi?inviteCode=bvhsaqdr)
   - 在 DSH 打开配置面板「Key 池管理」添加 API Key（地域可选国内、海外，或直接选自动探测）。
2. **让 AI 配置工作流**：
   把你的 RunningHub 工作流链接发给 AI 辅助配置。

   > [!TIP]
   > **推荐体验工作流**：
   > 可以体验我的国内平台qwen image2.1工作流 [【Qwen Image 2.1】万能输入工作流](https://www.runninghub.cn/post/2103013637228154881/?inviteCode=8cq8uhl8)。进入页面后点击**保存为自己的工作流**，然后将你账号下保存后的工作流链接（或 ID）发给 AI。

   向 AI 发送指令，例如：
   > “帮我配置这个工作流：https://www.runninghub.cn/workflow/xxxxxxxxxxxxxxxxxxx”
   
   AI 会读取节点结构，向你确认提示词节点、参考图输入和常用参数，确认后自动保存。该工作流建议让 AI 只保留**一个提示词输入节点、6 个图片输入节点和画幅比例调节节点**。

   RunningHub 的画幅比例与分辨率参数通常以下列格式显示，可直接复制发给ai辅助配置或在面板编辑该节点时直接填入枚举选项（options）：
   - `1:1 (Square)`
   - `2:3 (Portrait Photo)`
   - `3:2 (Photo)`
   - `3:4 (Portrait Standard)`
   - `4:3 (Standard)`
   - `9:16 (Portrait Widescreen)`
   - `16:9 (Widescreen)`
   - `21:9 (Ultrawide)`
3. **开始生图**：配置完成后，直接向 AI 发送指令：
   
   > “用刚才配置的文生图工作流，画一只在竹林里吃竹子的熊猫”

任务提交后会立刻返回任务 ID。调用 `task.wait` 即可将结果图片取回并直接展示在聊天气泡中。

---

## 配置面板与节点配置详解

打开 DSH「插件」→「dsh-runninghub-plugin」即可进入配置面板。点击任意工作流展开，即可进入**节点配置详情页**：

### 1. 工作流基本信息区
- **名称与英文标识**：支持设置直观的中文名称，以及供大模型内部识别的稳定英文标识（`displayNameEn`）。
- **地域选择**：指定该工作流默认使用国内池还是海外池的 Key。
- **输出类型**：指定生成类型，支持 `image`（图片）、`video`（视频）、`audio`（音频）、`3d`、`text`、`mixed`。
- **描述（给模型看）**：向模型说明该工作流的适用场景。大模型在寻找合适工具时会参考此处的描述。
- **查看 JSON**：支持随时一键展开/收起底层原始 JSON 配置，便于技术排查。

### 2. 节点表格与自动分组（8 列清晰呈现）
工作流导入后，插件会自动将底层 ComfyUI 节点按功能分类（如画面、采样器、模型、提示词等），支持按分组折叠。表格清晰呈现 8 项核心属性：

| 列名 | 说明 |
| :--- | :--- |
| **节点** | ComfyUI 内部原生数字 ID（如 `6`、`9`） |
| **类型** | 节点 ClassType（如 `CLIPTextEncode`、`KSampler`、`LoadImage`） |
| **角色** | 当前赋予的语义角色（如提示词、参考素材、参数等） |
| **字段** | 对应的内部字段名（如 `text`、`image`、`seed`、`steps`） |
| **默认值** | 运行未显式传参时使用的缺省值 |
| **范围 / 枚举** | 数值步长限制，或下拉候选列表 |
| **必填** | 标注该输入是否必须提供 |
| **操作** | 点击展开/收起该节点的内联编辑面板 |

### 3. 节点内联编辑功能
点击任意节点右侧的「编辑」，即可在下方展开表单进行精细调节：
- **角色重指派（role）**：提供 10 种标准角色：
  - 正向提示词（`prompt`）、负向提示词（`negative_prompt`）
  - 参考图（`image`）、参考视频（`video`）、参考音频（`audio`）
  - 数值（`number`）、下拉选择（`select`）、布尔开关（`boolean`）、随机种子（`seed`）、其他（`other`）
  若自动推断有偏差，可随时手动修正。
- **显示名与字段名（label / fieldName）**：自定义展示给界面的友好标签与内部提交字段。
- **自定义分组（group）**：可自由调整该节点所属的分组，方便梳理庞大复杂的节点图。
- **值类型与默认值（valueType / defaultValue）**：
  - 支持 `string`、`number`、`boolean`、`enum`。
  - 设定默认值后，若用户或模型调用时未指定该参数，系统会自动带上默认值提交。
- **数值范围硬校验（min / max / step）**：
  - 系统内置的推断范围仅作建议提示；
  - **用户手动设置的数值范围会在调用前强制校验**。若参数越界将直接拦截，防止把错误参数发给云端导致任务失败。
- **枚举候选值列表（options）**：
  - 支持按行编辑画幅比例、采样器等下拉列表。配置后，前端与模型只能选择预设值，杜绝随意填错。
- **必填项与备注（required / note）**：勾选必填后，参数缺失将阻止发起调用；备注用于记录特殊调整心得。

### 4. 提示词优化联动配置
在节点表格下方，可直接配置该工作流专用的提示词增强链路：
- **启用开关**：一键开启或关闭优化。
- **绑定规范文档**：从已上传的文档库中下拉挑选对应的规范指南（如《人像生成提示词指南.md》）。
- **指定写入目标节点**：可指定优化后的提示词写入哪个正向提示词节点（默认自动寻找）。
- **极简子代理模式**：勾选后，运行前会将规范文档作为系统设定，唤起一个专注的极简子代理来润色提示词。
- **附加指令**：支持配置固定补充指令（如“画质优先，画面不要出现文字”）。

### 5. 草稿保护与确认机制
- **草稿保护**：修改任意参数后，即便折叠手风琴或切换查看其他工作流，当前修改都会暂存在面板中，不会意外丢失。
- **放弃修改**：可随时点击「放弃修改」一键复原到已保存状态。
- **首次配置确认**：新导入的工作流在初次保存前，需要勾选“我已确认节点角色、默认值和输出类型”，防止误操作。

---

## 面板其他模块

- **Key 池管理**：增删 Key、查询单 Key 余额、切换国内/海外节点、启用/禁用与优先级设置。
- **文档库**：在线上传或直接编辑提示词规范 Markdown 文档，供工作流挂载。
- **任务流水看板**：
  - 查看任务历史，支持按状态筛选。
  - 面板展开且页面在前台时，有正在执行的任务会自动每 3 秒刷新进度。
  - 任务卡片上直接提供**「补下载 / 补附件」**按钮：若远端已生成完毕但本地文件没下完整，点击即可直接补拉，无需重新跑图。

---

## 模型工具调用参考

插件向大模型注册两个工具：`runninghub_search` 无参数，只返回 `runninghub_call` 各动作的使用方式；`runninghub_call` 执行查询、配置和生成。工作流、生成记录等数据都要通过 `call` 的对应动作查询。

### 1. 查动作，再选择工作流
```js
runninghub_search({}) // 获取全部动作的使用方式，无需传参数
runninghub_call({ action: "workflow.get" }) // 列出已配置工作流的简短介绍
runninghub_call({ action: "workflow.get", query: "文生图" }) // 按名称、英文名、描述或标签筛选
runninghub_call({ action: "workflow.get", name: "我的文生图" }) // 选定后读取完整节点配置
```

不传 `name` 时，`workflow.get` 只返回 `name`、`displayNameEn`、`description`、`outputKind` 和 `tags`。先根据这些介绍选工作流，再传 `name` 查看输入节点、参数范围及提示词优化要求。

接入新工作流时，`workflow.probe` 返回一份待确认的 `config`，节点在 `config.nodes` 中。确认并修改后，把它传给 `workflow.configure` 保存。

### 2. 提交生成任务
```js
runninghub_call({
  action: "workflow.run",
  name: "我的文生图",
  prompt: "一只在竹林里吃竹子的熊猫",
  background: true // 推荐后台模式：立即返回 taskId，不阻塞聊天对话
})
```

### 3. 查询进度与取回结果
```js
runninghub_call({ action: "task.status", taskId: "任务 ID" }) // 仅查询状态
runninghub_call({ action: "task.status", taskId: "任务 ID", details: true }) // 排查时读取详情
runninghub_call({ action: "task.wait", taskId: "任务 ID" })   // 等待完成并取回附件
```

### 4. 补取文件或附件（无需重复生成）
```js
runninghub_call({ action: "task.retry", taskId: "任务 ID" })
```
> 若文件已在本地，只需在聊天中重新发一遍图片，可传 `{ resend: true }`。

生成、等待和补取结果的回执只带任务 ID、状态和结果。附件直接显示，结果摘要包含本地路径、最近 24 小时的在线链接及下载或附件失败原因，不重复返回提示词、节点参数或 Key 信息。`task.status` 默认只返回状态和错误摘要；排查时传 `details: true` 读取详情。完整请求信息保存在本地任务记录中。

### 5. 传入参考图与自定义参数
```js
runninghub_call({
  action: "workflow.run",
  name: "我的图像编辑",
  prompt: "把背景换成星空",
  images: { "470": "E:/images/reference.png" }, // 节点 ID: 本地文件绝对路径或云端文件名
  params: { "3:steps": 30 },                   // 推荐 "节点 ID:字段名" 精确覆盖
  saveDir: "生成结果",                         // 本地保存目录（相对会话目录或绝对路径）
  fileName: "星空"                             // 自定义保存文件名（同名自动加序号）
})
```

- **保存目录规则**：缺省时优先使用配置的 `outputDir`；未配置时保存在会话工作目录下的 `runninghub-output` 中。
- **批量提交**：支持传 `repeat: 1~20` 一次提交多条独立任务。
- **素材上传**：同次调用中，重复节点和批量任务会复用未变化素材的上传结果。复用限于同一 Key 和地域，提交结束后释放，不跨调用缓存。

提交前可用 `workflow.validate` 预检，传入与运行时相同的 `prompt`、`negativePrompt`、`params` 和 `images`。它检查输入参数与可用 Key，不上传素材、不提交任务；本地文件在运行上传时检查。

查最近的生成记录：`runninghub_call({ action: "task.list", limit: 20 })`。每条记录只有本地 `id` 和在线结果 `links`，没有提示词或工作流详情。查询过滤超过 24 小时的链接；本地文件和任务记录仍可在面板查看、补发。

### 6. 处理「待核对」任务

提交时网络中断，任务会记为 `UNCERTAIN`（待核对）。到 RunningHub 后台按**提交时间、工作流 ID、所用 Key**（面板上都有显示）核对：

```js
// 后台找到了：把远端任务 ID 接回来，插件会继续轮询并下载结果
runninghub_call({ action: "task.adopt", taskId: "uncertain-xxxx", remoteTaskId: "1904152026220003329" })

// 确认后台没有创建：结案，不再占用待核对名额
runninghub_call({ action: "task.dismiss", taskId: "uncertain-xxxx", reason: "后台没有这个任务" })
```

`task.adopt` 会先用同地域的 Key 查一次远端任务；查不到（ID 写错或属于另一个地域）时直接报错，原记录保持不变。面板的任务卡片上也有「关联远端任务」和「确认未创建并结案」两个按钮。

### 常用 Action 清单

| 分类 | 动作 | 说明 |
| :--- | :--- | :--- |
| **工作流** | `workflow.get` / `probe` / `configure` / `update` / `delete` / `validate` | `get` 不传 `name` 时列出介绍，可用 `query` 筛选；传 `name` 才返回完整节点配置。其余动作用于探测、保存、更新、删除（需带 `confirm: true`）与预检 |
| **任务** | `workflow.run` / `task.status` / `task.wait` / `task.retry` / `task.cancel` / `task.list` / `task.adopt` / `task.dismiss` | 提交任务、查询进度、取回结果、断点补取、取消任务（含撤销本地排队）、接回或结案待核对任务；历史查询只返回最近 24 小时的本地 ID 和在线结果链接 |
| **Key 与账户** | `account.keys` / `account.balance` / `key.detect` / `key.balance` | 查 Key 池、查余额、探测地域、单 Key 查额度；添加、修改和删除 Key 在面板操作 |
| **提示词** | `prompt.doc_read` / `prompt.doc_write` / `prompt.optimize` | 读取规范文档、编写文档、调用优化润色 |
| **诊断** | `diagnostics` | 检查核心装配状态、数据目录及宿主通信通道 |

---

## Key 策略与安全保障

- **优先级与轮换**：优先使用优先级数值较小的 Key；相同优先级下，优先使用较久未使用的 Key。
- **自动熔断与换号**：
  - **认证失败**：标记该 Key 失效，自动切换同地域下一把 Key。修正配置后，可在面板点「重新验证」，通过后恢复使用。
  - **余额不足**：标记为「余额不足」，切换同地域下一把 Key。余额不会随时间自己回来，所以插件不再定时放行：提交前会对这类 Key 复查余额（每把至多每分钟一次），有余额才恢复；面板 Key 列表显示最近一次查到的余额和查询时间。余额查询本身失败时，才按旧策略在 10 分钟后放行。
  - **并发已满 / 机器不足**（1520 / 415）：不是 Key 的问题，不冷却 Key。多把 Key 时先换下一把试；都满了就在本地排队（状态 `LOCAL_QUEUED`），按 30s → 60s → 120s 退避重投，本地有任务结束时提前唤醒；排队超过 `maxWaitMs` 记为 `CAPACITY_TIMEOUT`。排队期间可以取消，不扣费。
  - **物理隔离**：国内池为空时直接报错，绝不挪用海外 Key。
- **资金防重复扣费**：
  提交过程中若遭遇网络断开、超时或服务端 5xx 异常，任务将记录为 `UNCERTAIN`，**插件绝不自动重试**，防止重复扣费。确认云端状态后，用 `task.adopt` 接回已创建的任务，或用 `task.dismiss` 结案再重跑。

---

## 插件配置与本地数据

可在 DSH 配置文件中指定以下参数：

| 字段 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `dataDir` | `<DSH_HOME>/runninghub` | 数据存储根目录（默认 `~/.dsh/runninghub`） |
| `outputDir` | 空 | 默认生成文件保存目录；单次调用时的 `saveDir` 优先 |
| `httpTimeoutMs` | `60000` | HTTP 超时时间（毫秒）；提交任务至少等待 60 秒 |
| `pollIntervalMs` | `3000` | 轮询起始间隔；退避递增，上限 15 秒 |
| `maxWaitMs` | `1800000` | 单次等待最长时间（毫秒，默认 30 分钟） |
| `maxTasks` | `10` | 保留最近已完成任务数；`0` 为不限制。待恢复与待核对任务拥有独立的缓冲上限（$\max(20, 2N)$） |
| `registerSkill` | `true` | 是否注册工作流配置的引导 Skill |
| `exposeClientPanel` | `true` | 是否开启前端配置面板通道 |
| `fakeIpHosts` | `[]` | TUN / fake-IP 代理兼容：**追加**允许解析到 fake-IP 的结果域名（精确主机名，不支持通配） |
| `fakeIpRanges` | `[]` | 代理的 fake-IP 网段（IPv4 CIDR）；留空即 `198.18.0.0/15`，改过 `fake-ip-range` 的填同样的值 |

### 数据目录结构

```text
secrets.json          API Key 明文与池状态（不保留明文备份）
state.json            非机密运行时状态（冷却时间、用量快照）
workflows/*.json      已配置的工作流参数
prompts/*.md          提示词规范文档
tasks/*.json          任务流水与本地结果映射
outputs/<taskId>/     缺省保存目录
```

> [!IMPORTANT]
> API Key 明文存放在本机的 `secrets.json` 中。请在面板添加，不要发到聊天里。工具回执、面板列表和日志会脱敏，但这不能清除已经发送的聊天记录。在分享插件数据目录前，请移除 `secrets.json`。Unix 系统使用 `0600` 文件权限；Windows 的访问范围由目录和文件的 ACL 决定，`chmod(0600)` 不提供同等隔离。

本地输入只接受可识别的图片、视频和音频，单个文件上限 128 MiB；插件机密和内部配置文件不能作为素材上传。结果按流写入临时文件，完成后再保存，单个下载上限 512 MiB。上传、下载和附件读取共用两个并发槽；超过 64 MiB 的结果保留本地文件与下载链接，不自动复制成聊天附件。

结果下载会拒绝本机和非公开网络地址，并逐次检查重定向。兼容 TUN 代理的 fake-IP DNS：只有 RunningHub 官方结果域名（`rh-images.xiaoyaoyou.com`、`rh-images-tos.xiaoyaoyou.com`、`rh-images-1252422369.cos.ap-beijing.myqcloud.com`，以及 `fakeIpHosts` 里追加的）在 HTTPS 默认端口、主机名精确匹配时，才允许使用 fake-IP 网段（默认 `198.18.0.0/15`，可用 `fakeIpRanges` 修改）的地址；本机、链路本地（含云元数据地址）与组播段不能被配置成 fake-IP 网段，其他内网地址仍拒绝。被拒时错误信息会写明主机名、解析到的地址和该改哪项设置。面板的 HTTP 通道使用宿主的连接鉴权。

---

## 常见问题排查

<details>
<summary><b>面板没有出现</b></summary>

确认已重启 DSH 并刷新了客户端页面；检查是否在多处 profile 重复安装了插件。
</details>

<details>
<summary><b>面板显示无法连接</b></summary>

在聊天中调用 `runninghub_call({ action: "diagnostics" })` 查看自检信息。面板优先走宿主 Remote 通道，若宿主未导出该协议，会自动退回本地 HTTP 路由。
</details>

<details>
<summary><b>提示没有可用 Key</b></summary>

检查对应地域池中是否有启用的 Key。状态为「余额不足」的 Key 充值后在面板点「查余额」即可恢复（下次提交前插件也会自动复查）；「冷却」只来自短时限流或网络异常，会自动到期。
</details>

<details>
<summary><b>任务一直显示「本地排队」</b></summary>

说明账号并发已满或平台独占机器不足，任务还没有提交到 RunningHub、没有扣费。插件会自动重投；可以在面板取消排队，或调用 `account.queue` 查看并发占用。
</details>

<details>
<summary><b>任务提示等待超时</b></summary>

调用 `task.status` 重新查询。若只是本地等待超时，重新查询即可恢复后台跟踪或取回已完成的结果，无需重复提交。
</details>

<details>
<summary><b>生图成功但聊天中没有图片 / 下载中断</b></summary>

可能是网络波动。直接在面板对应任务卡片上点击「补下载 / 补附件」，或调用 `task.retry`；已保存成功的文件不会重复下载，亦不会重新发起工作流扣费。
</details>

<details>
<summary><b>视频或音频生成后返回的是 PNG 图片</b></summary>

可能是命中 RunningHub 的隐写载图（媒体文件隐藏在 PNG 中）。插件会完整保留原文件并给出提示。
</details>

---

## 开发与测试

本地开发要求 Node.js ≥ 20（推荐 Node.js 24）。

```sh
# 完整发布验收（含敏感凭据扫描、离线沙箱装载自检与 450+ 项全量串行测试）
node tools/accept.mjs --json

# 仅运行单元与集成测试
npm test

# 快速入口自检
npm run loadcheck
```

测试均基于本地模拟接口与临时目录，不会发起真实网络请求，不会扣费。

---

## 开源协议

[MIT License](LICENSE)
