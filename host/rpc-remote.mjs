/**
 * host/rpc-remote.mjs —— RunningHub 的 Remote 桥（首选增强通道）
 *
 * 把 `host/rpc.mjs` 的方法表暴露成 Typert Remote 命名空间 `runninghub`，
 * 供浏览器半边 `ctx.remote.runninghub.<method>(params)` 调用。
 *
 * ## 设计红线（Lead 指定）
 * - **起不来就返回 `null`，绝不抛**。调用方只 `warn`，HTTP 通道仍然可用。
 * - 命名空间固定 `runninghub`。
 * - 每个方法**恰好一个 `params` 参数**（对象），方法内部自行解构。
 * - 返回值**原样过线**（Lead 的 `{ok:true,...}` / `{ok:false,error:{...}}` 不做任何包装）。
 *
 * ## ★客户端的双层 ok★（实测确认，务必转告 rh-ui）
 * Remote 传输层会**额外**包一层，`ctx.remote.runninghub.x(p)` 实际返回：
 *
 *     { ok: true,  value: <宿主方法的原始返回值> }      // 传输成功
 *     { ok: false, error: { code, message } }           // 传输失败
 *
 * 所以宿主返回 `{ok:true, data}` 时客户端拿到 `{ok:true, value:{ok:true, data}}` —— **两层 ok**。
 * 这一层是 `@deepseek-ai/dsh-api-gateway` 的客户端半边结构性加的，**宿主侧无法去掉**：
 *   证据 `@deepseek-ai/dsh-api-gateway/lib/client.js:1795-1802`
 *        if (!result.ok) return { ok:false, error: rebuiltFailure(result.error) };
 *        return { ok:true, value: descriptor.result.mode === 'strict' && descriptor.result.decode !== void 0
 *                                  ? descriptor.result.decode(result.value) : result.value };
 *   （我们的 codec 不提供 `decode`，所以 `value` 就是宿主返回值本身。）
 *
 * ## 为什么不构建也能跑（实证）
 * 纯 `.mjs`、无装饰器、无 TS、无 zod：
 *   - `@deepseek-ai/dsh-typert-protocol` 的 `TypertRemoteService` 是普通 class，
 *     `constructor(ctx, serviceKey)` 里自己 `bindTypertRemote()`（lib/index.js:159-172）。
 *   - 描述符清单负责导出方法（mcp-panel `src/service.ts:280-283` 注释：
 *     "no method decorator, so the built bundle stays plain ESM"）。
 *   - codec 只需 `{ mode:'strict', typeSymbol, create(): { parse(v) } }` ——
 *     宿主只做 `codec.create().parse(value)`（api-gateway/lib/index.js:1513）。
 *   - 跑通日志见 `probe/remote-probe.mjs` / `probe/remote-probe2.mjs`，报告见
 *     `docs/dsh/PLUGIN-API.md` §11。
 *
 * @module dsh-runninghub-plugin/rpc-remote
 */

/**
 * 描述符 / codec 的**权威定义**搬到 `host/remote-manifest.mjs` ——
 * 同一个 manifest 有两个消费方（包根 `./typert` 导出走官方 loader 自动发现；
 * 这里走手工兜底注册），两处各写一份必然漂移。
 * 下面保留同名薄封装，避免大改本文件。
 */
import {
  REMOTE_NAMESPACE as SHARED_NS,
  REMOTE_PACKAGE as SHARED_PKG,
  descriptorFor as sharedDescriptorFor,
  buildTypertManifest,
  diffMethodList,
} from './remote-manifest.mjs'

/** Remote 命名空间（= 服务键）。已定死，改它要同步改 client 侧。 */
export const REMOTE_NAMESPACE = 'runninghub'

/** Typert manifest 归属的包名 —— 必须严格等于 package.json 的 name。 */
export const REMOTE_PACKAGE = 'dsh-runninghub-plugin'

/** 每个方法声明的唯一参数名。 */
const PARAMS_WIRE = 'params'

/**
 * 手写 strict codec —— 不需要 zod。
 *
 * 形状要求来自 `@deepseek-ai/dsh-api-gateway/lib/index.js:1510-1525`：
 *   `if (codec.mode === 'strict') value = codec.create().parse(value)`
 * 与 `@deepseek-ai/dsh-typert-loader/lib/index.js:206-212`（mode 必须是 'strict'，
 * 且必须有 `create()` 工厂）。
 *
 * @param {string} typeSymbol - 诊断用的类型标识。
 * @param {(value: unknown) => unknown} parse - 边界校验函数。
 * @returns {{ mode: 'strict', typeSymbol: string, create: () => { parse: (value: unknown) => unknown } }}
 */
function strictCodec(typeSymbol, parse) {
  return Object.freeze({ mode: 'strict', typeSymbol, create: () => ({ parse }) })
}

/**
 * `params` 的边界校验：接受对象，也接受**缺省**（`undefined`/`null` → `{}`）。
 *
 * 为什么允许缺省：`api-gateway/lib/index.js:1502-1503` 的 `assertExactArguments`
 * 只在 `acceptsUndefined === true`（或 codec 是 src-json）时才允许缺字段；
 * 我们的 codec 是 `strict`，所以显式声明 `acceptsUndefined: true` 才能让
 * `ctx.remote.runninghub.status()` 这种零参调用成立。
 *
 * @param {unknown} value - 线上传来的值。
 * @returns {Record<string, unknown>} 参数对象。
 * @throws {TypeError} 传了非对象、非空值时。
 */
function parseParams(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`params must be a plain object (got ${Array.isArray(value) ? 'array' : typeof value})`)
  }
  return value
}

/** 结果 codec：恒等，让 Lead 的原始对象原样过线（含 `{ok:false,error}`）。 */
const parseAny = (value) => value

/**
 * 为一个方法名造描述符。
 *
 * 形状出处：`dsh-mcp-panel/src/wire.ts:316-325`（无参）/ `:345-359`（带参），
 * 校验规则出处：`@deepseek-ai/dsh-typert-loader/lib/index.js:153-212`。
 *
 * @param {string} method - 宿主方法名，同时是 Remote 端点 `<namespace>/<method>` 的后半段。
 * @returns {Readonly<object>} 冻结的描述符。
 */
function descriptorFor(method) {
  // 委托给共享定义（`host/remote-manifest.mjs`）—— 保证与包根 `./typert` 导出
  // 送给官方 loader 的那份**同形**。这样"官方路径"与"手工兜底路径"
  // 不可能因为两处各写一份而漂移（这正是本次真机故障的教训之一）。
  return sharedDescriptorFor(method)
}

/**
 * 取一个 warn 函数，绝不因为日志本身抛错。
 *
 * @param {unknown} rt - rh-core 的运行时（`host/core/**`）。
 * @returns {(message: string) => void} 记录函数。
 */
function warnOf(rt) {
  const candidates = [
    rt && typeof rt.warn === 'function' ? rt.warn.bind(rt) : undefined,
    rt && rt.logger && typeof rt.logger.warn === 'function' ? rt.logger.warn.bind(rt.logger) : undefined,
    typeof console !== 'undefined' && typeof console.warn === 'function' ? console.warn.bind(console) : undefined,
  ]
  for (const candidate of candidates) if (candidate !== undefined) return candidate
  return () => {}
}

/**
 * 把方法表挂成 Remote 命名空间 `runninghub`。
 *
 * **失败一律返回 `null`**（import 不到、`ctx.plugin` 抛错、描述符被拒 …），
 * 调用方据此降级到 HTTP 通道。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文（必须在插件 fiber 内）。
 * @param {unknown} rt - rh-core 运行时；只用于诊断日志。
 * @param {Record<string, (params: Record<string, unknown>) => unknown>} methods -
 *   Lead 的 `buildMethods(rt)` 方法表；方法**同步返回或返回 Promise 均可**。
 * @returns {Promise<(() => void) | null>} 卸载函数；起不来时为 `null`。
 */
export async function registerRemoteBridge(ctx, rt, methods) {
  const warn = warnOf(rt)
  const fail = (stage, error) => {
    warn(`[runninghub] Remote 桥未启用（${stage}）：${error instanceof Error ? error.message : String(error)}；面板将退回 HTTP 通道`)
    return null
  }

  if (ctx === undefined || ctx === null) return fail('参数', new Error('ctx 缺失'))
  if (methods === undefined || methods === null || typeof methods !== 'object') {
    return fail('参数', new Error('methods 表缺失'))
  }

  const names = Object.keys(methods).filter((key) => typeof methods[key] === 'function')
  if (names.length === 0) return fail('参数', new Error('methods 表里没有任何函数'))

  try {
    // ── ① 取 TypertRemoteService（唯一的外部依赖，且解析不到就整条降级）──
    let TypertRemoteService
    try {
      const mod = await import('@deepseek-ai/dsh-typert-protocol')
      TypertRemoteService = mod?.TypertRemoteService
    } catch (error) {
      return fail('import @deepseek-ai/dsh-typert-protocol', error)
    }
    if (typeof TypertRemoteService !== 'function') {
      return fail('TypertRemoteService 形状', new Error('模块导出里没有 TypertRemoteService class'))
    }

    // ── ② 服务类：服务键 = Remote 命名空间 = 'runninghub' ──
    //    方法动态安装 —— 方法表由 Lead 提供，这里不需要知道具体名字。
    class RunningHubRemoteService extends TypertRemoteService {
      constructor(inner) {
        super(inner, REMOTE_NAMESPACE)
      }
    }
    for (const name of names) {
      Object.defineProperty(RunningHubRemoteService.prototype, name, {
        value: async function remoteMethod(params) {
          // params 可能被宿主解码成 undefined（零参调用）；统一兜成 {}
          return await methods[name](params ?? {})
        },
        writable: true,
        configurable: true,
        enumerable: false,
      })
    }

    // ── ③ 挂服务 ──
    let fiber
    try {
      fiber = await ctx.plugin(RunningHubRemoteService)
    } catch (error) {
      return fail('ctx.plugin(RunningHubRemoteService)', error)
    }
    // await 之后 fiber 可能已被销毁 —— 再注册任何东西都是 INACTIVE_EFFECT
    // （mcp-panel src/index.ts:108-113 的 A02 处理）
    if (ctx.fiber === undefined || ctx.fiber.uid === null) {
      return fail('fiber 生命周期', new Error('ctx.plugin 返回时本 fiber 已被销毁'))
    }
    if (ctx.get(REMOTE_NAMESPACE) === undefined) {
      return fail('服务可见性', new Error(`服务 '${REMOTE_NAMESPACE}' 挂载后仍不可见`))
    }

    // ── ④ 注册描述符清单 ──
    //
    // ⚠️ **优先用官方 loader 路径**：包根的 `./typert` 导出（`typert.host.mjs`）会被
    // `@deepseek-ai/dsh-typert-loader` 在装配时自动发现并注册（`lib/index.js:261-300`）。
    // 只有它**没注册成功**时，我们才手工兜底 —— 因为 typert 注册表对
    // 「重复的 package-face 身份」是**整批拒绝**：
    //   "Duplicate package-face identities, schemas, invocation ids, or endpoints
    //    reject the whole batch."（`ctx.typert.register` 的服务文档原文）
    // 两条路同时生效 → 第二条抛错 → 反而把整条 Remote 通道判死。
    const loaderRegistered = (() => {
      try {
        const typert = ctx.get('typert')
        return !!(typert && typeof typert.getPackage === 'function' && typert.getPackage(REMOTE_PACKAGE) !== undefined)
      } catch {
        return false
      }
    })()

    const manifest = buildTypertManifest(names)

    // 清单漂移自检（只 warn）：客户端调一个描述符里没有的方法会报
    // `gateway/internal: unknown endpoint runninghub/xxx`，看起来像通道坏了。
    try {
      const diff = diffMethodList(methods)
      if (diff.missing.length > 0 || diff.extra.length > 0) {
        warn(
          `[runninghub] Remote 方法清单与运行时方法表不一致：运行时多出 [${diff.missing.join(', ')}]，清单多出 [${diff.extra.join(', ')}] —— ` +
            '云端会以 gateway/internal: unknown endpoint 报错。请同步 host/remote-manifest.mjs 的 REMOTE_METHODS。',
        )
      }
    } catch {
      /* 自检失败不影响主流程 */
    }

    // 用 ctx.inject 兜住 "typert 服务晚于本插件出现" 的情况：
    // 服务一出现就注册，服务消失自动撤销。
    // ⚠️ ctx.inject 的回调不保证同步执行，所以可用性判断要看 ctx.get('typert')，
    //    不能用回调里置的标志位（那会误报）。
    let detachManifest = () => {}
    if (loaderRegistered) {
      // 官方 loader 已经注册过 → 绝不能再注册一次
      // 同时留个记号给 diagnostics
      try {
        if (rt && typeof rt === 'object') rt.remoteManifestVia = 'typert-loader'
      } catch {
        /* 只用于诊断 */
      }
    } else {
      try {
        detachManifest = ctx.inject(['typert'], (scope) => scope.effect(
          () => {
            // 回调可能晚于 loader 生效 → 进回调时再查一次，避免重复注册
            try {
              const t = scope.get ? scope.get('typert') : undefined
              if (t && typeof t.getPackage === 'function' && t.getPackage(REMOTE_PACKAGE) !== undefined) {
                try {
                  if (rt && typeof rt === 'object') rt.remoteManifestVia = 'typert-loader'
                } catch {
                  /* 只用于诊断 */
                }
                return () => {}
              }
            } catch {
              /* 查不到就按"没注册"处理 */
            }
            try {
              if (rt && typeof rt === 'object') rt.remoteManifestVia = 'manual'
            } catch {
              /* 只用于诊断 */
            }
            return scope.typert.register(manifest)
          },
          `${REMOTE_PACKAGE}: typert manifest (${names.length} methods)`,
        ))
      } catch (error) {
        // ⚠️ 「重复注册被拒」**不是失败**：那通常意味着官方 loader 刚刚也注册了同一份清单
        // （typert 注册表对重复的 package-face 身份整批拒绝）。这种情况当作"已就绪"继续，
        // 否则会把一条本来能用的 Remote 通道误判成坏的 —— 而兜底 HTTP 在 desktop 上必然 405。
        const nowRegistered = (() => {
          try {
            const t = ctx.get('typert')
            return !!(t && typeof t.getPackage === 'function' && t.getPackage(REMOTE_PACKAGE) !== undefined)
          } catch {
            return false
          }
        })()
        if (!nowRegistered) return fail('ctx.typert.register', error)
        warn(`[runninghub] 手工注册被拒但本包已在 typert 中（多半是官方 loader 已注册）→ 继续使用：${String((error && error.message) || error)}`)
      }
    }

    if (!loaderRegistered && ctx.get('typert') === undefined) {
      // typert 服务此刻不在组合里：不算失败（可能晚点到，ctx.inject 会补注册），但要如实告警。
      warn(`[runninghub] ctx.typert 当前不可用，Remote 命名空间 '${REMOTE_NAMESPACE}' 已挂载但描述符未注册；面板请用 HTTP 通道`)
    }
    // ⚠️ 这里**不再**报"Remote 可用"。`ctx.plugin` 成功 + 描述符注册成功
    // 都**不能证明**客户端能挂上命名空间 —— 真机上出现过「$mount 报成功、
    // 但 remote.runninghub 始终不出现」。可用性以客户端实测为准（见 diagnostics 的 clientCalls）。

    // ── ⑤ 返回组合卸载函数 ──
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      try {
        detachManifest()
      } catch {
        /* 卸载期失败不再抛出 */
      }
      try {
        if (fiber && typeof fiber.dispose === 'function') void fiber.dispose()
      } catch {
        /* 同上 */
      }
    }
  } catch (error) {
    // 兜底：任何漏网的异常都不能冒泡出去
    return fail('未预期的异常', error)
  }
}

/**
 * 自检：报告本模块是否具备挂载条件（供 `diagnostics` 动作调用）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @returns {Promise<{ available: boolean, reason?: string, namespace: string }>}
 */
export async function probeRemoteBridge(ctx) {
  try {
    const mod = await import('@deepseek-ai/dsh-typert-protocol')
    if (typeof mod?.TypertRemoteService !== 'function') {
      return { available: false, reason: 'TypertRemoteService 未导出', namespace: REMOTE_NAMESPACE }
    }
    if (ctx?.get?.('typert') === undefined) {
      return { available: false, reason: 'ctx.typert 不在当前组合里', namespace: REMOTE_NAMESPACE }
    }
    return { available: true, namespace: REMOTE_NAMESPACE }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      namespace: REMOTE_NAMESPACE,
    }
  }
}
