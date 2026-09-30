# DSH RunningHub 插件

在 DSH 中调用 RunningHub 工作流，生成图片、视频、音频或其它文件。可以让 AI 帮你配置工作流，也可以在插件面板中管理 Key、节点参数和提示词文档。

需要 DSH 桌面版、RunningHub API Key，以及可通过 API 调用的工作流。国内和海外平台的 Key 分开使用，运行费用由 RunningHub 收取。

## 安装

```sh
dsh plugin --profile desktop add github:achenjins/dsh-runninghub-plugin
```

安装后重启 DSH，再刷新浏览器页面。配置面板位于「插件」→「dsh-runninghub-plugin」。

卸载：

```sh
dsh plugin --profile desktop remove dsh-runninghub-plugin
```

需要固定版本时，可以在安装地址后加上 `#<commit>`。插件没有构建步骤，无需额外批准安装脚本。

本地开发可以在仓库目录运行：

```sh
node tools/install.mjs --dry-run
node tools/install.mjs
```

脚本会备份修改前的 profile 文件。使用 `node tools/install.mjs --uninstall` 撤销安装。也可以将仓库以 `link:` 依赖加入 profile，并将包名加入 `dsh.profile.bundles`；随后在 profile 目录运行 `pnpm install`。

不要同时使用 bundle 安装和手工添加 `cordis.patch.yml` 的方式，否则会重复注册工具。

## 第一次使用

1. 在插件面板添加 API Key。地域可以选国内、海外，或让插件自动探测。
2. 把 RunningHub 工作流链接发给 AI，例如：「帮我配置这个工作流：……」。
3. AI 会读取工作流，与你确认提示词、参考素材和可调参数，然后保存配置。
4. 配置完成后，可以说：「用这个工作流画一只在竹林里的熊猫」。

工作流里的节点角色由插件推断，保存前需要确认。参考素材可以使用本地文件路径，也可以使用已上传到 RunningHub 的文件名。

任务提交后会返回任务 ID。宿主提供后台作业服务时，可以查看进度并收到完成通知；调用 `task.wait` 可以取回结果，图片以附件显示在聊天中。

## 配置面板

面板中可以管理 Key、编辑工作流节点、上传提示词文档，以及查看或取消任务。工作流列表默认折叠，点击名称展开。

节点的角色、默认值、必填项、数值范围和候选值均可编辑。插件推断的常见数值范围用于提示；手动设置的范围会参与运行前校验。

## 工具调用

插件向模型提供两个工具：`runninghub_search` 用于发现，`runninghub_call` 用于执行。

查看已配置的工作流：

```js
runninghub_search({ kind: "workflow" })
```

提交任务：

```js
runninghub_call({
  action: "workflow.run",
  name: "我的文生图",
  prompt: "一只在竹林里吃竹子的熊猫",
  background: true
})
```

查询和取回结果：

```js
runninghub_call({ action: "task.status", taskId: "任务 ID" })
runninghub_call({ action: "task.wait", taskId: "任务 ID" })
```

传入参考图或覆盖参数：

```js
runninghub_call({
  action: "workflow.run",
  name: "我的图像编辑",
  prompt: "把背景换成星空",
  images: { "470": "E:/images/reference.png" },
  params: { "3:steps": 30 },
  saveDir: "生成结果",
  fileName: "星空"
})
```

`images` 中的键是素材节点 ID；`params` 推荐使用 `节点 ID:字段名`，避免同名字段匹配错节点。也支持按节点传入多个字段，例如 `{ "3": { "seed": 123, "steps": 30 } }`。

`saveDir` 可以是绝对路径，也可以相对于会话工作目录。省略时优先使用插件的 `outputDir`；没有设置时，保存到会话工作目录下的 `runninghub-output`。宿主没有提供工作目录时，使用插件数据目录下的 `outputs/<taskId>`。同名文件会自动加序号。

`repeat` 可以一次提交 1–20 个独立任务。`waitMs` 可以让提交调用额外等待一段时间；默认立即返回，`background: true` 时也立即返回。等待超时不会取消任务，可以稍后继续查询。

| 动作 | 用途 |
| --- | --- |
| `workflow.get` / `probe` / `configure` / `update` / `delete` / `validate` | 查看、配置和校验工作流；删除需传 `confirm: true` |
| `workflow.run` | 提交一个或多个任务 |
| `task.list` / `status` / `wait` / `cancel` | 查询任务、取回结果或取消任务 |
| `account.keys` / `balance` / `queue` | 查看 Key 池、余额和队列 |
| `key.add` / `update` / `remove` / `detect` / `balance` | 管理 Key；单 Key 余额查询使用 `id` |
| `prompt.doc_read` / `doc_write` / `optimize` | 管理提示词文档和优化提示词 |
| `diagnostics` | 查看装配状态、数据目录和面板通道 |

表中省略的动作前缀与每行第一个动作相同，例如 `workflow.probe`、`task.wait`。传入未知动作时，工具会返回完整清单。

## Key 和提交失败

Key 按优先级选择，数值越小越先使用；同优先级下优先选择较久未使用的 Key。失效、禁用和冷却中的 Key 不参与新任务提交。

- 认证失败：标记 Key 失效，尝试同地域的下一把。
- 额度不足：冷却 10 分钟，尝试同地域的下一把。
- 限流：查询请求退避重试；提交被明确拒绝时尝试下一把 Key。
- 提交时断线、超时或收到服务端错误：记录为 `UNCERTAIN`，不自动重投。任务可能已创建，需要到 RunningHub 后台核对。

批量提交途中失败时，回执会保留已提交的任务 ID。不要直接重跑整批，以免重复生成和扣费。国内池没有可用 Key 时，不会使用海外 Key。

## 提示词文档

在面板的文档库中上传或编写规范，再在工作流的「提示词优化」中选择该文档。

普通模式下，主模型读取文档后改写提示词。开启子代理模式后，`prompt.optimize` 会调用宿主的子代理服务生成提示词；该子代理不使用工具。是否有子代理服务取决于 DSH 的配置。

## 插件配置和数据

以下字段可以放在插件的 `config` 中：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `dataDir` | `<DSH_HOME>/runninghub` | 工作流、文档、任务和 Key 的存储目录 |
| `outputDir` | 空 | 默认结果目录；单次调用的 `saveDir` 优先 |
| `httpTimeoutMs` | `60000` | HTTP 请求超时，单位毫秒；提交请求至少等待 60 秒 |
| `pollIntervalMs` | `3000` | 起始轮询间隔，逐步增加到最多 15 秒 |
| `maxWaitMs` | `1800000` | 单次等待和后台任务跟踪的上限，单位毫秒 |
| `registerSkill` | `true` | 注册工作流配置引导 |
| `exposeClientPanel` | `true` | 启用配置面板通道 |
| `baseUrls` | `{}` | 覆盖国内、海外接口地址，通常只在测试或代理场景使用 |

没有设置 `DSH_HOME` 时，数据目录默认是用户主目录下的 `.dsh/runninghub`。

```text
secrets.json          API Key 和 Key 池状态
state.json            非机密状态
workflows/*.json      工作流配置
prompts/*.md          提示词文档
prompts/*.meta.json   文档信息
tasks/*.json          任务记录，包括结果路径
outputs/<taskId>/     默认结果目录
```

API Key 明文存放在本机的 `secrets.json` 中，工具回执、面板和日志会脱敏。写入时会尝试设置仅当前用户可读写的权限；Windows 上的实际访问权限由文件系统 ACL 决定。

建议将数据目录放在仓库之外。分享数据目录前，要移除 `secrets.json` 及其副本；旧版状态文件也可能含 Key。写入成功后会清理旧的机密备份和临时文件，损坏文件副本会保留供恢复。

工作流和文档覆盖前保留最近五份备份，机密文件不生成常规备份。重启插件后会继续查询未结束的任务。

## 排查问题

- **面板没有出现**：确认已重启 DSH 并刷新页面，且没有同时安装两份插件。
- **面板无法连接**：调用 `runninghub_call({ action: "diagnostics" })`。面板优先使用宿主 Remote 通道；有 webServer 服务时也支持 HTTP 通道。
- **没有可用 Key**：检查地域、启用状态、余额和冷却时间。
- **任务等待超时**：使用 `task.status` 查询。若只是本地跟踪超时，查询可以恢复跟踪或取回已完成的结果，无需再次提交。
- **结果下载失败**：任务记录中仍保留结果 URL 和失败原因，可以直接下载。再次 `task.wait` 会读取已有记录。
- **视频或音频返回 PNG**：可能是 RunningHub 的隐写载图。插件保留原文件并给出提示；目前不负责提取其中的媒体。

## 开发与验证

插件运行要求 Node.js 20 或更新版本。下面的开发验收使用 Node.js 24，同时需要 Git 和 npm。

```sh
npm test
node tools/loadcheck.mjs
npm run check:release
node tools/accept.mjs --json
```

`accept` 会依次执行发布检查、离线装载和全部测试。发布检查扫描工作区、Git 暂存区、本地已有引用的历史，以及 npm 安装包清单；检查凭据、意外打包的数据文件和缺失入口。发现问题时只报告位置，不打印密钥。

离线装载和测试使用临时数据目录及本地模拟接口，不读取真实 profile，也不会调用真实 RunningHub 或扣费。通过离线测试说明本地逻辑和模拟链路正常，真实平台、宿主版本差异及设备行为仍需要单独验证。

更详细的接口和设计记录见 [docs/DESIGN.md](docs/DESIGN.md) 与 [docs/dsh/PLUGIN-API.md](docs/dsh/PLUGIN-API.md)。

MIT License。
