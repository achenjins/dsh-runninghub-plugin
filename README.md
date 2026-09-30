# dsh-runninghub-plugin · DSH × RunningHub 工作流适配插件

让 **DSH 桌面版**里的模型直接**生图 / 生视频 / 生音频** —— 通过 RunningHub 工作流。

一句话说明它做了什么：

> 你说"帮我画一只在竹林里吃竹子的熊猫"，模型会自己找到合适的工作流、
> 按你的提示词规范把提示词写好、后台把任务提交出去、把生成的图**贴回聊天里**。
> 额度不够自动换 Key，国内和海外的 Key 分开管，不会互相踩。

---

## 目录

- [它长什么样](#它长什么样)
- [安装](#安装)
- [配置](#配置)
- [两个工具](#两个工具)
- [AI 辅助配置工作流](#ai-辅助配置工作流)
- [多 Key 与国内 / 海外](#多-key-与国内--海外)
- [提示词优化](#提示词优化)
- [配置面板](#配置面板)
- [数据都在哪](#数据都在哪)
- [设计取舍与已知边界](#设计取舍与已知边界)
- [开发与验收](#开发与验收)

---

## 它长什么样

模型侧只多 **两个工具**（与本地 `autocad` / `github` MCP 的 `search_tools` + `call_tool` 同构）：

| 工具 | 干什么 |
|---|---|
| `runninghub_search` | **发现**：本机配了哪些工作流（生图/生视频/生音频/3D）、每个要什么参数、运行前要不要先读提示词优化文档；顺带列任务、Key 池、文档库 |
| `runninghub_call` | **执行**：看工作流详情、拉取并推断节点、落盘配置、校验、**后台跑**、查任务、**取结果（图片直接显示在聊天里）**、查余额、管 Key、读/写优化文档、优化提示词、自检 |

外加一个**插件自带的 skill** `runninghub-workflow-setup`：模型读到它就知道怎么"问着问着"把
一个工作流配好。

---

## 安装

**本包零依赖、零构建步骤**（手写 ESM），所以从 GitHub 直接装即可，**不需要** pnpm 的
`allowBuilds` 授权 —— 那个坎只对"安装时要跑构建脚本"的包出现，我们刻意没有 `prepare`/`postinstall`。

### 推荐：用 DSH 官方的 `dsh plugin` 装

```sh
dsh plugin --profile desktop add github:achenjins/dsh-runninghub-plugin
```

它会把这个包链进 profile，并（因为它声明了 `dsh.bundle`）**自动追加进 `dsh.profile.bundles`** ——
装完插件会出现在左侧「插件」页面里。卸载：

```sh
dsh plugin --profile desktop remove dsh-runninghub-plugin
```

> 想锁定到某个 commit（防止后续推送悄悄改变实际运行的内容）：
> `dsh plugin --profile desktop add github:achenjins/dsh-runninghub-plugin#<sha>`

装完先不启动、只验证这一层：

```sh
dsh --profile desktop --dump-config    # 应能看到 "# == dsh-runninghub-plugin" 这一层
```

### ⚠️ 装完必须做的两件事

1. **重启 DSH**（装配在启动时完成）。
2. **刷新浏览器页面（Ctrl+R / F5）** —— 客户端半边要重新加载才会出现面板与聊天卡片。
   **这一步不能省**：只重启不刷新，页面会停在旧版本。

### 本地开发：从 checkout 装 + 我们的安装脚本

```powershell
node tools/install.mjs            # bundle 方式（默认）；会备份 profile 文件
node tools/install.mjs --dry-run  # 先看会改什么
node tools/install.mjs --uninstall
```

开发时更常见的是 **link 整个 checkout**，这样改代码不用重装：

```jsonc
// profile 的 package.json
{
  "dependencies": { "dsh-runninghub-plugin": "link:/path/to/dsh-runninghub-plugin" },
  "dsh": { "profile": { "bundles": [ /* …已有的… */, "dsh-runninghub-plugin" ] } }
}
```

然后**在该 profile 目录**跑一次 `pnpm install`（把 `link:` 写进锁文件），重启 + 刷新。

### 另一种：手工挂进 `cordis.patch.yml`

> ⚠️ **这种方式装完，左侧「插件」页面里看不到它** —— 手工 insert 只是一个 loader 条目，
> 不在 `dsh.profile.bundles` 清单里。功能全部正常，只是不可见、不能用 UI 启停。

把本包 `cordis.patch.yml` 里那段 `insert` 拷进 profile 的补丁层：

```yaml
- insert:
    - id: dsh-runninghub-plugin
      name: dsh-runninghub-plugin
      config: {}
```

> **两种方式不能同时用** —— 两个 fiber 会重复注册同名工具。

**为什么刻意没有构建步骤**：`main` 直接指向手写的 `host/index.mjs`，浏览器半边是手写的
`client/client.js`。DSH 升级时最怕的就是"构建产物坏掉 = 插件整体消失"，而
构建产物还意味着 **git 安装时要让用户在机器上跑这个包的代码**（pnpm `allowBuilds`）。
手写 ESM 把这两个问题一起去掉了。

---

## 配置

`cordis.patch.yml` 的 `config` 全部可选：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/runninghub` | 插件数据目录（工作流配置、文档、任务流水、结果文件） |
| `httpTimeoutMs` | `60000` | 单次 HTTP 请求超时 |
| `pollIntervalMs` | `3000` | 后台轮询任务的**起始**间隔（会退避到 15s） |
| `maxWaitMs` | `1800000` | 单个任务最长跟踪 30 分钟 |
| `registerSkill` | `true` | 是否注册 AI 辅助配置工作流的 skill |
| `exposeClientPanel` | `true` | 是否开配置面板的数据通道 |
| `baseUrls` | `{}` | 覆盖平台基址（`{cn, overseas}`），一般不用填；验收测试打本地 mock 时用 |

---

## 两个工具

### `runninghub_search`

```
runninghub_search({ kind: 'workflow' | 'task' | 'key' | 'prompt_doc' | 'all',
                    query?: string, status?: string, limit?: number })
```

回执里每个工作流都会标清：输出类型、节点数、提示词/参考图节点数、**运行前是否需要先读优化文档**。

### `runninghub_call`

```
runninghub_call({ action: '<动作>', ...载荷 })
```

| 动作 | 说明 |
|---|---|
| `workflow.get` / `workflow.probe` / `workflow.configure` / `workflow.update` / `workflow.delete` / `workflow.validate` | 工作流的看 / 拉取推断 / 落盘 / 改 / 删 / 校验 |
| `workflow.run` | **后台提交**，立刻返回 `taskId` + DSH 作业 id |
| `task.list` / `task.status` / `task.wait` / `task.cancel` | 任务流水；`task.wait` 成功会把图片/视频**作为附件返回**，直接显示在聊天里 |
| `account.balance` / `account.keys` | 余额 / Key 池（**只会是掩码**） |
| `key.add` / `key.update` / `key.remove` / `key.detect` / `key.balance` | Key 管理 |
| `prompt.doc_read` / `prompt.doc_write` / `prompt.optimize` | 提示词优化文档与优化执行 |
| `diagnostics` | 自检（协议层是否装载、数据目录、宿主 API 来源、告警） |

`action` 写错时会回**动作清单**，模型能自己纠回来。

---

## AI 辅助配置工作流

用户说"配置工作流" → 模型读 skill `runninghub-workflow-setup` → 走这条流程：

1. **确认有 Key**（`account.keys`）。没有就问用户要。
2. **要工作流链接**，从 URL 里取数字 ID。
3. `runninghub_call({action:'workflow.probe', workflowId})` ——
   插件按官方接口 `/api/openapi/getJsonApiFormat` 拉 JSON，**自动推断**每个节点是
   正向提示词 / 负向提示词 / 参考图 / 可调数值 / 输出，并给出**提案**。
4. **逐组提问确认**（身份 → 提示词 → 参考素材 → 可调参数 → 提示词优化）。
   skill 里写死了问法与分组，避免模型一口气问二十个问题。
5. `workflow.configure` 落盘 → `workflow.validate` 自检 → 告诉用户可以用了。

> 推断结果只当**提案**：模型必须逐项与用户确认，不会默默替你拍板。

---

## 多 Key 与国内 / 海外

**国内（`www.runninghub.cn`）与海外（`www.runninghub.ai`）的 Key 不通用**，插件把它们分成两个池。

- `key.add` 不填 `region` 时**自动探测**：分别打两个平台的 `accountStatus`，`code=0` 的那边就是它的归属。
- 选 Key 顺序：`priority` 升序 → 跳过冷却中/失效/禁用 → 同优先级里**最久没用过的先用**。
- 失败分类处理：

| 情况 | 处理 |
|---|---|
| 401 / 403（Key 无效） | 标记失效，换下一把 |
| 余额 / 额度不足 | 该 Key 进冷却（默认 10 分钟），换下一把 |
| 429 / 瞬时网络故障 | 同 Key 退避重试，超限再换 |
| **提交阶段结果未知** | **绝不自动重投**，任务标成 `UNCERTAIN`，让用户去 RunningHub 后台核对 |

- **跨池绝不回退**：国内池空了就直接报 `NO_KEY`，不会拿海外 Key 去撞 401 白花一次调用。
- **明文 Key 永远不出现在**日志、工具回执、面板数据里 —— 一律 `rh_****abcd`。

---

## 提示词优化

每个工作流可以挂一份**提示词优化文档**（txt / md，存在插件数据里）：

- `prompt.doc_write` 写入，`workflow.update` 的 `promptOptimizer.docId` 挂上，`enabled: true` 打开。
- 打开且挂了文档后，`runninghub_search` 会把该工作流标成 **`needsRead`**，
  并在回执里直接写明"运行前必须先读这份文档再优化提示词"。
- 还有第二个开关 `asSubagentSystemPrompt`：
  - **开** → 运行前调 `prompt.optimize`，插件把文档当系统提示词交给一个
    **无工具、极简模式**的子代理（`toolFilter: { allow: [] }`）去写提示词，主模型只拿结果，省上下文、风格稳；
  - **关** → 插件只把文档给你，由主模型自己改写。

---

## 配置面板

**在左侧「插件」页面里、本插件自己的那一页**（`插件` → `dsh-runninghub-plugin`）。
挂载点是 `plugins.bundle.config`，以**包名**为 key 注册 —— 这是 DSH 专门留给 bundle 放自有配置的位置。

- **顶部状态条**：数据目录、可用 Key 数（国内 x/y · 海外 x/y）、版本、自检按钮
- **Key 管理**：掩码列表 + 新增 / 编辑 / 删除 / 探测地域 / 查余额
- **工作流列表**：**默认全部折叠**，只显示一行摘要（名称 · 输出类型 · 节点数 · 提示词优化状态）；
  **点某一行才展开**它的节点表格，**同时只展开一个**（展开 B 自动收起 A）
- 展开后可编辑每个节点的角色 / 标签 / 必填 / 数值范围 / 枚举 / 分组
- **提示词优化**：总开关 · 选文档 · 子代理模式开关 · 目标节点 · 附加指令
- **文档库**：预览 / 编辑 / 另存 / 删除 / 上传 txt·md
- **任务流水**：最近任务状态与结果链接

插件列表里那一行还会显示**一行摘要**（可用 Key 数 · 工作流数 · 任务数），不用点进去就知道状态。

### 数据通道（两条，自动选）

| 通道 | 何时用 | 说明 |
|---|---|---|
| **Remote RPC**（`ctx.remote.runninghub`） | 首选 | 官方通道，走宿主已认证的连接。**需要在 `peerDependencies` 里声明 `@deepseek-ai/dsh-typert-protocol`** —— DSH 对 `link:` 进来的插件做 peer 感知的解析拦截，把导入路由到运行时自己那一份，`TypertRemoteService extends Service` 的基类身份才对得上 |
| HTTP 路由（`/plugins/dsh-runninghub-plugin/api`） | 兜底 | 零依赖。**desktop 组合里没有 `webServer` 服务**，所以这条腿在桌面版用不上；带 web server 的组合可用。只收 POST + JSON、带 `Origin` 时必须同源、回执里只有掩码 Key |

**面板打不开时怎么查**：先跑 `runninghub_call({action:"diagnostics"})` ——
回执里的 `配置面板通道` 字段会直接告诉你用的是哪条腿、有没有起来；
`warnings` 里也会点名是协议层没装载还是通道没起来。

---

## 数据都在哪

默认 `<DSH_HOME>/runninghub`（即 `C:\Users\<你>\.dsh\runninghub`）：

```
keys.json              非机密元数据（标签、地域、优先级、启用状态）
secrets.json           API Key 本体（0600；只在本机）
state.json             Key 冷却 / 上次使用时间
workflows/<id>.json    单个工作流配置（节点角色、范围、枚举、提示词优化设置）
prompts/<id>.md        提示词优化文档
tasks/<taskId>.json    任务流水（参数、状态、结果 URL、本地路径）
outputs/<taskId>/      下载回来的结果文件
```

写入是**原子的**（临时文件 + rename），覆盖前会备份（保留最近 5 份）。坏掉的 JSON 不会让插件崩，
只在自检里报出来。

---

## 设计取舍与已知边界

这些是刻意做的选择，不是没做完：

1. **没有构建步骤**。DSH 版本在漂移，"构建产物坏掉 = 两个工具凭空消失"是最难查的故障。
   代价是没有 TypeScript 类型，用 JSDoc 补。
2. **工具同步注册、装配放后台**。装配失败时工具仍然在，只是每次回执都告诉你
   `CORE_NOT_LOADED` 和原因 —— 而不是让工具静默消失。
3. **配置面板用 HTTP 路由与浏览器半边通信（Remote 描述符作为可选增强）**。
   DSH 的两套浏览器插件机制里，静态客户端包**没有**内置 `host.call`（那是动态浏览器半边的符号）；
   官方通道是 `ctx.remote.$mount` + Typert 描述符，而它要求 host 侧继承
   `TypertRemoteService extends Service`(cordis)，**基类身份必须与宿主是同一个模块实例**。
   为此本插件：
   - 在 `peerDependencies` 里声明了 `@deepseek-ai/dsh-typert-protocol` / `@deepseek-ai/dsh-tools`
     （DSH 对 `link:` 进来的插件做 peer 感知的解析拦截，会把导入路由到运行时自己那一份）；
   - **同时**内置一条零依赖的 `webServer` HTTP 路由 `/plugins/dsh-runninghub-plugin/api`。

   **实测结论（本机 DSH 桌面版，plugin 已装并生效）**：走 `node_modules` junction + profile 补丁层
   insert 这种装法时，peer 拦截**没有**生效，Remote 桥如实降级（`warn` + 返回 null），
   **HTTP 路由照常工作** —— 面板数据面 `POST /plugins/dsh-runninghub-plugin/api` 实测返回 200，
   浏览器半边的 tab 也已在设置页注册且 `active: true`。
   想要 Remote 也活起来，把插件按**方式 A**（profile 的 `dependencies` 里写 `link:` + `pnpm install`）
   装上即可 —— 两条通道都在，哪条通用哪条，**代码一行都不用改**。
   代价是 HTTP 路由要自己做同源与内容类型收敛（已做：只收 POST+JSON、带 `Origin` 时必须同源、
   不开 CORS、回执里只有掩码 Key）。
4. **付费提交绝不自动重试**。网络在提交返回前断了 = 结果未知，可能是已扣费。
   这时任务标成 `UNCERTAIN`，等你确认。
5. **上传两个接口都试**。`/openapi/v2/media/upload/binary` 的体积上限**比**旧接口
   `/task/openapi/upload` **更严**，只试一个会白白失败；两边都拒绝时会把两段原始报错都给你。
6. **枚举值不猜**。下拉选项必须来自工作流真实取值或用户提供；猜错会让任务跑失败还照样扣费。
7. **输出可能是"隐写载图"**：有些工作流把视频/音频藏在 PNG 里（社区叫"小黄鸭"）。
   本插件保留原图并如实说明，不假装它是普通图片。
8. **没有真实 Key 时无法端到端验证**。仓库内的测试全部走本地 mock server，
   不调用任何付费接口（见下）。

---

## 开发与验收

```powershell
# 离线装载自检（1 秒，不用重启 DSH）
node tools/loadcheck.mjs

# 协议层单测（API 客户端 / Key 池 / 存储 / 工作流解析 / 后台任务）
node --test "tests/core/*.test.mjs"

# 浏览器半边（ModuleLoader 工厂 + 手风琴展开行为）
node --test "tests/client/*.test.mjs"

# host 侧端到端（真实 core + 真实工具 + 本地 mock RunningHub）
node --test "tests/host/*.test.mjs"
```

文档：

- `docs/DESIGN.md` —— 团队契约（接口、写作用域、排雷清单）
- `docs/api/` —— 官方 API 文档的提取物（机读 `endpoints.json` + 人读 md）
- `docs/dsh/` —— DSH 插件 API 的源码级实证报告

**唯一优先标准**：<https://www.runninghub.cn/runninghub-api-doc-cn/>
