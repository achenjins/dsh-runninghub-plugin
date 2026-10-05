/**
 * host/remote-manifest.mjs —— RunningHub 的 Typert manifest 描述符（**两端共用**）
 *
 * 这里集中放「Remote 命名空间长什么样」，因为同一个 manifest 有**两个消费方**：
 *   1. `typert.host.mjs`（包根的 `./typert` 导出）→ `@deepseek-ai/dsh-typert-loader`
 *      在启动装配时**自动发现并注册**（这是官方路径，生产可用的 `dsh-mcp-panel` 就走这条）；
 *   2. `host/rpc-remote.mjs` → 手工 `ctx.typert.register(...)` 兜底
 *      （`typert-loader/lib/index.js:27` 注释明说这条路"remains available"）。
 *
 * 两处各写一份清单必然漂移，所以合并到这里。
 *
 * ## 为什么必须两条路都有（真机教训）
 * 只走手工注册时，真机上出现过：**`$mount` 报成功、但客户端 `remote.runninghub`
 * 命名空间一直不出现**（等 2s 超时），表现为面板 "NO_TRANSPORT"。
 * 官方 loader 路径是**生产验证过**的（mcp-panel 的 Remote 命名空间是活的），
 * 所以以它为主；手工注册只在 loader 没注册成功时兜底。
 *
 * ⚠️ 两条路**不能同时生效** —— typert 注册表对「重复的 package-face 身份」是
 * **整批拒绝**（`ctx.typert.register` 的文档："Duplicate package-face identities,
 * schemas, invocation ids, or endpoints reject the whole batch."）。
 * 所以 `rpc-remote.mjs` 在手工注册前会先查 `ctx.typert.getPackage(PKG)` 是否已存在。
 *
 * @module dsh-runninghub-plugin/host/remote-manifest
 */

/** 包名 —— 必须**严格等于** `package.json` 的 `name`（loader 会校验）。 */
export const REMOTE_PACKAGE = 'dsh-runninghub-plugin'

/** Remote 命名空间（= 宿主侧的服务键）。改它要同步改 client 侧。 */
export const REMOTE_NAMESPACE = 'runninghub'

/** 每个方法声明的唯一参数名（客户端只传一个对象）。 */
export const PARAMS_WIRE = 'params'

/**
 * 暴露成 Remote 方法的方法名清单。
 *
 * **必须与 `host/rpc.mjs` 的 `buildMethods(rt)` 的键集合一致** ——
 * `assertMethodListMatches()` 会在运行期核对，不一致只 warn 不抛（宁可少一个方法，
 * 也不要因为清单漂移把整条 Remote 通道打死）。
 */
export const REMOTE_METHODS = Object.freeze([
  'status',
  'listWorkflows',
  'saveWorkflow',
  'deleteWorkflow',
  'probeWorkflow',
  'keysAdd',
  'keysUpdate',
  'keysRemove',
  'keysDetect',
  'keysBalance',
  'docsList',
  'docsGet',
  'docsSave',
  'docsRemove',
  'tasksList',
  'tasksGet',
  'tasksRefresh',
  'tasksRetry',
  'tasksCancel',
  'tasksLimit',
  'diagnostics',
  // 通用桥：客户端在直连方法不可用时的后备（`{callJson}` 里再带 method/params）
  'call',
])

/**
 * 手写 strict codec —— 不需要 zod。
 *
 * 形状要求来自 `@deepseek-ai/dsh-api-gateway/lib/index.js:1510-1525`：
 *   `if (codec.mode === 'strict') value = codec.create().parse(value)`
 * 以及客户端 `requireStrictCodec()` 只校验 `codec.mode === 'strict'`。
 *
 * @param {string} typeSymbol 诊断用的类型标识
 * @param {(value: unknown) => unknown} parse 边界校验函数
 * @returns {{mode:'strict', typeSymbol:string, create:()=>({parse:Function})}}
 */
export function strictCodec(typeSymbol, parse) {
  return Object.freeze({ mode: 'strict', typeSymbol, create: () => ({ parse }) })
}

/**
 * `params` 的边界校验：接受对象，也接受**缺省**（`undefined`/`null` → `{}`）。
 *
 * 允许缺省的原因：`api-gateway/lib/index.js:1502-1503` 的 `assertExactArguments`
 * 只在 `acceptsUndefined === true`（或 codec 是 src-json）时才允许缺字段；
 * 我们的 codec 是 `strict`，所以必须显式声明 `acceptsUndefined: true`，
 * 否则 `ctx.remote.runninghub.status()` 这种零参调用会被拒。
 *
 * @param {unknown} value 线上传来的值
 * @returns {Record<string, unknown>} 参数对象
 * @throws {TypeError} 传了非对象、非空值时
 */
export function parseParams(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`params must be a plain object (got ${Array.isArray(value) ? 'array' : typeof value})`)
  }
  return value
}

/** 结果 codec：恒等，让宿主返回值原样过线（含 `{ok:false,error}`）。 */
export const parseAny = (value) => value

/**
 * 为一个方法名造 invocation 描述符。
 *
 * 形状出处：`dsh-mcp-panel/src/wire.ts:316-325`（无参）/ `:345-359`（带参）；
 * 校验规则出处：`@deepseek-ai/dsh-typert-loader/lib/index.js:77-135`（validateTypertManifest）
 * 与 `dsh-api-gateway/lib/client.js` 的 `requireStrictInputs` / `validateContribution`。
 *
 * @param {string} method 宿主方法名（也是 Remote 端点 `<namespace>/<method>` 的后半段）
 * @returns {Readonly<object>} 冻结的描述符
 */
export function descriptorFor(method) {
  return Object.freeze({
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method,
    // 只有 'direct' / 'context' 两种（typert-loader/lib/index.js:167）
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze([
      Object.freeze({
        name: PARAMS_WIRE,
        wire: PARAMS_WIRE,
        source: 'json',
        acceptsUndefined: true,
        codec: strictCodec(`${REMOTE_PACKAGE}/types#${method}Params`, parseParams),
      }),
    ]),
    result: strictCodec(`${REMOTE_PACKAGE}/types#${method}Result`, parseAny),
    // line/column 必须是正整数（typert-loader/lib/index.js:203）
    sourceLocation: Object.freeze({ file: 'host/remote-manifest.mjs', line: 1, column: 1 }),
  })
}

/**
 * 造完整的 Typert manifest（`TypertContribution`）。
 *
 * @param {readonly string[]} [methods] 方法名清单，默认 {@link REMOTE_METHODS}
 * @returns {Readonly<object>} 可直接交给 `ctx.typert.register(...)` 或作为 `TYPERT` 导出
 */
export function buildTypertManifest(methods = REMOTE_METHODS) {
  return Object.freeze({
    package: REMOTE_PACKAGE,
    face: 'host',
    schemas: Object.freeze([]),
    invocations: Object.freeze(methods.map(descriptorFor)),
    model: Object.freeze({
      services: Object.freeze([]),
      events: Object.freeze([]),
      objects: Object.freeze([]),
    }),
  })
}

/**
 * 核对方法清单与运行时方法表是否一致（**只 warn，不抛**）。
 *
 * 清单漂移的后果很隐蔽：客户端会调一个"描述符里没有"的方法，
 * 而报错长这样 —— `gateway/internal: unknown endpoint runninghub/xxx`，
 * 看起来像通道坏了，其实是清单少写一行。
 *
 * @param {Record<string, unknown>} methods `host/rpc.mjs` 的 `buildMethods(rt)` 结果
 * @returns {{missing: string[], extra: string[]}} 差异（都为空表示一致）
 */
export function diffMethodList(methods) {
  const actual = new Set(Object.keys(methods || {}))
  const declared = new Set(REMOTE_METHODS)
  return {
    missing: [...actual].filter((m) => !declared.has(m)),
    extra: [...declared].filter((m) => !actual.has(m)),
  }
}
