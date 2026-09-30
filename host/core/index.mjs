/**
 * `host/core/index.mjs` —— 协议层**唯一入口**（桶文件）
 *
 * 契约：把 6 个契约模块 + 内部底座 `util.mjs` 的导出**原样 re-export**，
 * 让集成方 `import * as core from './core/index.mjs'` 一次拿全（少一次路径解析）。
 *
 * 设计约束（都是被教训换来的）：
 *   - **零副作用**：本文件只做 re-export，不在模块顶层建目录、读文件、发请求或注册任何东西。
 *     所以 `node tools/loadcheck.mjs` 可以在没有 DSH、没有 key、没有数据目录的环境里安全 import。
 *   - **不 import 任何 DSH 包**：DSH 能力（attachments / credentials / jobs / subagents）全部由
 *     `host/tools/**` 注入（依赖倒置）。
 *   - **写作用域**：`host/core/**` 归 rh-core。本文件由 rh-core 维护。
 *
 * 模块速查：
 * | 模块 | 职责 | 主要入口 |
 * |---|---|---|
 * | `api.mjs` | RunningHub 全部 HTTP 端点 + 错误分类 | `RunningHubApi` / `BASE_URLS` / `ERR` |
 * | `keys.mjs` | 多 Key 池、地域探测、轮换、冷却 | `KeyPool` / `detectRegion` |
 * | `store.mjs` | 数据目录（原子写 + 备份 + 串行化） | `Store` / `resolveDataDir` |
 * | `workflow.mjs` | 工作流 JSON → 参数模型 | `analyzeWorkflow` / `buildNodeInfoList` / `validateRun` |
 * | `runner.mjs` | 后台提交 / 轮询 / 下载 / 通知 | `TaskRunner` |
 * | `promptdoc.mjs` | 提示词优化文档 | `renderForModel` / `needsReadBadge` / `PromptDocs` |
 * | `util.mjs` | 内部底座（掩码 / lossless / slug / sleep） | `maskKey` / `losslessSanitize` |
 *
 * @module dsh-runninghub-plugin/host/core
 */

export * from './util.mjs'
export * from './api.mjs'
export * from './keys.mjs'
export * from './store.mjs'
export * from './workflow.mjs'
export * from './runner.mjs'
export * from './promptdoc.mjs'

/**
 * ⚠️ **必须显式消歧的名字**。
 *
 * ESM 的规则：`export *` 遇到**两个模块导出同名但不同绑定**时，会**静默地把这个名字丢掉**
 * （不报错、不警告）—— 这是最阴的一类"少了一个导出"。
 * `slugify` 同时由 `util.mjs`（内部底座）和 `promptdoc.mjs`（契约导出）提供，正好撞上这条规则。
 * 契约以 `promptdoc.mjs` 为准，所以在这里显式挑明。
 * `tests/core/index.test.mjs` 里有一条"逐个模块比对"的测试会守住这件事。
 */
export { slugify } from './promptdoc.mjs'

/**
 * `coreSelfCheck()` 用到的具名引用。
 * **`export *` 不会把名字带进本地作用域**，所以这里必须显式 import 一份命名空间。
 * （这也是为什么下面用 `NS.xxx` 而不是裸标识符：一眼看得出它来自哪个模块。）
 */
import * as NS_API from './api.mjs'
import * as NS_KEYS from './keys.mjs'
import * as NS_STORE from './store.mjs'
import * as NS_WORKFLOW from './workflow.mjs'
import * as NS_RUNNER from './runner.mjs'
import * as NS_PROMPTDOC from './promptdoc.mjs'

/** 协议层版本（诊断里报出来，便于一眼区分"跑的是哪一代 lib"）。 */
export const CORE_VERSION = '0.1.0'

/** 自检要核对的「模块 → 关键导出名」。 */
const SELF_CHECK_MATRIX = {
  api: { ns: NS_API, names: ['RunningHubApi', 'BASE_URLS', 'ERR', 'STATUS', 'normalizeStatus', 'classifyResponse', 'maskKey'] },
  keys: { ns: NS_KEYS, names: ['KeyPool', 'detectRegion', 'COOLDOWNS'] },
  store: { ns: NS_STORE, names: ['Store', 'resolveDataDir', 'safeName'] },
  workflow: { ns: NS_WORKFLOW, names: ['analyzeWorkflow', 'buildNodeInfoList', 'validateRun', 'summarizeRoles'] },
  runner: { ns: NS_RUNNER, names: ['TaskRunner', 'projectTask', 'describeOutput', 'pollDelay'] },
  promptdoc: { ns: NS_PROMPTDOC, names: ['renderForModel', 'needsReadBadge', 'PromptDocs', 'slugify'] },
}

/**
 * 协议层自检（**不联网、不写盘**）：确认 6 个模块的关键导出都在。
 * `host/tools/diagnostics` 可以直接把它挂进回执。
 * @returns {{ok:boolean,version:string,modules:object,missing:string[]}} 自检结果
 */
export function coreSelfCheck() {
  const modules = {}
  const missing = []
  for (const [mod, spec] of Object.entries(SELF_CHECK_MATRIX)) {
    const present = []
    for (const n of spec.names) {
      if (spec.ns[n] !== undefined) present.push(n)
      else missing.push(mod + '.' + n)
    }
    modules[mod] = { exports: spec.names.length, present }
  }
  return { ok: missing.length === 0, version: CORE_VERSION, modules, missing }
}
