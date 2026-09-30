# 审查与修复记录

审查日期：2026-09-30。重点检查了配置面板与宿主 RPC、Key 持久化、任务提交和恢复、结果保存、模型工具及维护脚本。本次改动保留现有结构，没有增加依赖。

原有 337 项测试全部通过，但缺少跨模块和并发场景的覆盖。首轮新增 26 项回归测试；后续 Key 与发布检查新增 17 项，合计新增 43 项。

P1 表示可能丢失数据或增加重复扣费风险；P2 表示功能失效、错误状态或配置不生效；P3 表示文档和维护问题。

## 已修复的问题

| 优先级 | 问题与触发条件 | 修复后的行为 | 主要位置 |
| --- | --- | --- | --- |
| P1 | 首次启动读到旧 `state.keys` 后先清理状态，却未保存到机密文件。没有后续 Key 操作时，第二次启动丢失 Key 池 | 先持久化并确认成功，再清理旧字段；写失败保留原数据。也能恢复此前不完整迁移留下的状态备份 | [runtime](../host/runtime.mjs)、[store](../host/core/store.mjs) |
| P1 | 旧清理脚本把任何 32–64 位字符串视为密钥，删除整个文件；工作流 ID、模型标识会被误删 | 只清理已知状态文件的 `keys` 字段和机密备份，保留工作流与其它状态。支持只读预览，不再生成新的明文回滚副本 | [清理脚本](../tools/scrub-legacy-secrets.mjs) |
| P1 | 两个任务向同一目录保存同名文件时，均在写锁外选中相同名称，后写的文件覆盖前一个 | 选名和写入共用目录锁，同名输出自动编号；失败时清理临时文件 | [store](../host/core/store.mjs) |
| P1 | 批量提交中途失败，回执丢掉之前已创建的任务及不确定提交记录，容易诱发整批重投 | 返回已提交 ID、失败序号和不确定记录；已提交部分继续由后台作业跟踪 | [call](../host/tools/call.mjs) |
| P1 | 提交收到 HTTP 5xx 时被归为普通服务错误，缺少“可能已经创建任务”的提示和本地记录 | 记为 `TRANSPORT_UNCERTAIN`，保留核对记录，停止换 Key 和重投 | [api](../host/core/api.mjs)、[runner](../host/core/runner.mjs) |
| P2 | 认证、额度或限流明确拒绝后，即使同地域有健康 Key，也不继续尝试 | 仅对明确拒绝的三类错误换同地域 Key；本地素材随新 Key 重新上传。不确定提交仍立即停止 | [runner](../host/core/runner.mjs)、[api](../host/core/api.mjs) |
| P2 | 轮询继续使用已失效、冷却、禁用或地域已变更的 Key；换 Key 后错误又计到旧 Key 上 | 检查 Key 可用性和地域，记录实际使用的 Key，再归属后续错误 | [runner](../host/core/runner.mjs) |
| P2 | `task.status` 按当前池任取 Key 和地域，而非任务记录；刷新成功状态时未下载结果 | 按任务记录查询，下载和保存结果后才公布成功。状态刷新、轮询和取消按任务串行处理 | [runner](../host/core/runner.mjs)、[call](../host/tools/call.mjs) |
| P2 | 本地跟踪超时后，提示用户查询，但刷新无法恢复 | `TIMEOUT`、`NO_KEY`、`POLL_CRASH` 可通过 `task.status` 再查；远端仍在运行则恢复跟踪，已完成则取回结果 | [runner](../host/core/runner.mjs) |
| P2 | `wait` 超时返回 `ok: true`，模型回执与后台作业据此显示“完成” | 明确显示仍在运行，给出继续取回结果的操作；后台等待超时不结算为完成 | [call](../host/tools/call.mjs)、[jobs](../host/jobs.mjs) |
| P2 | 保存目录和文件名只在提交后的内存 Map 中设置，可能晚于下载，并在重启后丢失 | 提交前传入保存设置并写入任务记录；重启恢复和手动取回均使用原设置 | [runner](../host/core/runner.mjs)、[call](../host/tools/call.mjs) |
| P2 | `outputDir` 被配置归一化丢弃，轮询间隔和等待预算也未传到任务执行器 | 三项配置均在运行时生效 | [index](../host/index.mjs)、[runtime](../host/runtime.mjs) |
| P2 | 文档保存传 `docId`，存储层却只识别 `id`，改名后新增文件，原工作流仍读旧正文 | 改名更新同一 ID，保留来源文件名，正确返回时间与字节数；删除失败不再返回成功 | [rpc](../host/rpc.mjs)、[store](../host/core/store.mjs) |
| P2 | 面板读写丢掉范围和候选值的来源；空范围转成数字零，原本的提示变成阻塞错误 | 保留来源；空范围表示不设约束；用户手动编辑后按用户设置校验 | [rpc](../host/rpc.mjs)、[workflow](../host/core/workflow.mjs)、[client](../client/client.js) |
| P2 | 面板中的默认值与目标提示词节点没有落实到提交参数 | 提交使用本地默认值，显式参数优先；提示词进入指定节点。目标失效时明确报错 | [workflow](../host/core/workflow.mjs) |
| P2 | 缺失的本地素材路径被当成服务端文件名发出；默认素材和按角色传入的素材未统一上传 | 显式本地路径不存在时阻止提交；使用实际生效的素材值上传；服务端文件名仍可直接使用 | [runner](../host/core/runner.mjs) |
| P2 | 任务列表调用传数字，存储层却需要选项对象；筛选和数量限制不一致 | 面板、搜索和执行工具均返回限制数量的最近匹配任务 | [rpc](../host/rpc.mjs)、[search](../host/tools/search.mjs)、[call](../host/tools/call.mjs) |
| P2 | `key.balance` 忽略指定的 ID，查询其它账户或地域 | 查询指定 Key 及其所属地域；不存在的 ID 明确报错 | [call](../host/tools/call.mjs) |
| P2 | 多次 Key 修改异步读写同一快照，成功回执早于落盘结果 | 持久化顺序执行；面板和模型工具等待写入结果，失败时说明修改未保存 | [runtime](../host/runtime.mjs)、[rpc](../host/rpc.mjs)、[call](../host/tools/call.mjs) |
| P2 | 结果文件写失败仍返回下载成功；隐写提示、文本输出或附件原始尺寸在后续处理时丢失 | 保留保存错误和远端 URL，模型回执及作业通知可见；保留隐写提示、文本和原始尺寸 | [runner](../host/core/runner.mjs)、[runtime](../host/runtime.mjs)、[call](../host/tools/call.mjs)、[jobs](../host/jobs.mjs) |
| P2 | 系统提示词模式仍把文档塞进用户消息；引用文档不存在时静默继续 | 文档传入子代理 `persona`，用户诉求单独传入；文档丢失明确报错 | [call](../host/tools/call.mjs) |
| P2 | 核心装配失败后，自检动作也被同一前置检查拦住；半成品装配过早标记就绪 | 自检可独立返回加载原因，必要模块全部装配后才标记就绪 | [runtime](../host/runtime.mjs)、[call](../host/tools/call.mjs) |
| P2 | 卸载与异步启动交错时可能重新开启轮询或留下桥；停止的执行器仍能提交付费任务 | 异步启动检查卸载状态并清理，停止后拒绝新任务；取消请求的异步异常被接住 | [index](../host/index.mjs)、[runner](../host/core/runner.mjs)、[jobs](../host/jobs.mjs) |
| P2 | 服务端回显的 Key 进入响应或网络错误文本 | 对响应值和异常信息中的当前 Key 脱敏，保留协议字段名 | [api](../host/core/api.mjs) |
| P3 | 工具说明声称省略 `background` 会一直等待，且没有作业服务时仍承诺自动通知 | 说明与 `waitMs` 的实际行为一致；缺少作业服务时提示主动取回结果 | [call](../host/tools/call.mjs) |
| P3 | README 大量重复保证、内部术语和排雷故事，部分说明与代码不符 | 改为安装、首次使用、调用示例、配置、失败处理和排障说明；去掉固定测试数量等易过期描述 | [README](../README.md)、[验收入口](../tools/accept.mjs) |

另外，存储队列和任务操作锁会在完成后移除，避免长时间运行时积累无用条目。

## Key 与 Git／安装包补查

检查了当前工作区、Git 暂存区、本地所有引用可达的历史内容，以及 npm 的打包清单。没有发现真实 Key；代码中的已知长字符串凭据均来自测试假值。本地检查不包含尚未获取的远端历史。

| 优先级 | 问题与触发条件 | 修复后的行为 | 主要位置 |
| --- | --- | --- | --- |
| P1 | 脱敏主要依赖单个 HTTP 响应中的当前 Key，Remote、模型工具信封、其它 Key 和嵌套 JSON 仍可能回显凭据 | API、工具、RPC 和日志共用脱敏；捕获修改前的 Key，覆盖更新或删除后的异常，同时保留任务字段和结果签名链接 | [security](../host/security.mjs)、[api](../host/core/api.mjs)、[rpc](../host/rpc.mjs)、[shared](../host/shared.mjs) |
| P1 | 浏览器直接记录网关／代理的错误正文，截断可能留下部分 Key，随后显示在控制台和通道诊断 | 使用本次请求的凭据先脱敏再截断；保留业务错误标记，不因此重复提交 | [client](../client/client.js) |
| P1 | 损坏 JSON 的解析异常可能包含源文本，机密文件或旧状态里的 Key 随诊断进入日志 | 解析失败只报告文件和错误类型；损坏副本尝试收紧权限后保留供恢复 | [store](../host/core/store.mjs)、[清理脚本](../tools/scrub-legacy-secrets.mjs) |
| P1 | 通用 JSON 写入口允许为 `secrets.json` 生成备份或使用普通权限；写入失败及崩溃遗留临时副本 | 机密文件强制禁止备份并使用 0600；失败时删除本次临时文件，成功后清理已知旧机密临时副本 | [store](../host/core/store.mjs) |
| P1 | Git 忽略规则只保护根目录的机密文件，缺少旧回滚副本、环境文件和私钥文件规则 | 保护任意层级的已知机密与副本，同时保留 `.github/workflows` 的正常跟踪 | [.gitignore](../.gitignore) |
| P1 | npm 打包整个 `host`／`client` 目录，放在其中的运行数据或备份可能随安装包分发 | 改为源文件和必要资源白名单；测试确认嵌套机密、运行数据、环境文件和备份不会入包 | [package.json](../package.json) |
| P2 | 离线装载脚本使用默认 DSH 数据目录，检查安装时可能读取或迁移真实 Key | 使用隔离的临时目录，并在退出时清理；加入真实 profile 不被读取或修改的回归用例 | [loadcheck](../tools/loadcheck.mjs) |
| P2 | 缺少发布检查；只检查工作区也会漏过已暂存但后来从工作区删除的凭据，以及历史提交和缺失打包依赖 | 增加发布检查并接入验收：分别读取工作区、索引和可达历史，核对实际 npm 清单、入口及静态相对依赖；报告不回显值 | [check-release](../tools/check-release.mjs)、[accept](../tools/accept.mjs) |

这些保护不会加密本机的 `secrets.json`。损坏副本可能仍含私人数据，保留是为了恢复，不能连同数据目录一起公开。

## 验证

回归用例位于 [tests/host/regressions.test.mjs](../tests/host/regressions.test.mjs) 和 [tests/host/security-release.test.mjs](../tests/host/security-release.test.mjs)。对两项旧测试也作了行为修正：停止后提交应失败，缺失的显式本地素材路径也应失败。

执行 `node tools/accept.mjs --json`，检查发布文件、离线装载和全部单元／集成测试。测试使用临时目录、模拟响应和本地模拟接口，不访问真实账户，也不发起收费任务。

本次在 Windows、Node.js 24.19.0 下完成验收：发布检查、离线装载和 380 项测试全部通过，失败 0、跳过 0；`git diff --check` 无报错。

另实际生成 npm 安装包并解包到临时目录，确认包内 29 个文件可以独立完成 host 装配、两个模型工具注册、Typert manifest 导入和 client 入口加载。Git 检查覆盖 54 个索引条目及 72 个历史内容对象。安装包验证不依赖仓库中的测试、开发脚本或本地抓取资料。

## 还需要在实际环境验证

- DSH 面板加载、热重载、后台作业通知，以及子代理 `persona` 的实际处理。
- 国内与海外 Key 的认证、额度不足时换 Key，以及平台对其它 Key 查询既有任务的权限。
- 大文件上传、慢 CDN 下载、取消任务和跨进程重启恢复。
- 不同工作流的节点约束及隐写输出。插件当前保留载图，不负责提取藏在其中的视频或音频。

这些项目需要实际宿主或账户，离线测试不能替代。旧清理脚本若已经删除工作流文件，本次修复也无法凭空恢复，需从原有备份或 RunningHub 重新导入。
