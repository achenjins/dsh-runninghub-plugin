/**
 * `dsh-runninghub-plugin` 的 Typert host manifest（**官方自动发现入口**）。
 *
 * `@deepseek-ai/dsh-typert-loader` 在 profile 装配时扫描已启用条目，
 * 读取包 `exports["./typert"]` 指向的模块并要求它导出 `TYPERT`：
 *
 *   dsh-typert-loader/lib/index.js:261-267   rel = typertExportOf(manifestName, pkg.exports)
 *   dsh-typert-loader/lib/index.js:273       import(path).then(mod => validateTypertManifest(pkgName, mod.TYPERT))
 *   dsh-typert-loader/lib/index.js:300       registered.set(entryName, ctx.typert.register(manifest))
 *
 * 校验要求（validateTypertManifest，:77-135）：
 *   - `manifest.package` **严格等于** 包名；
 *   - `manifest.face === 'host'`；
 *   - `schemas` 是数组、`model` 是含 services/events/objects 三个数组的对象；
 *   - `invocations` 是数组且每项过 `requireInvocation`。
 *
 * ## 为什么要有这个文件（真机教训）
 * 之前只走「插件自己 `ctx.typert.register(...)`」的手工路径时，真机出现过：
 * **`$mount` 报成功、但客户端 `remote.runninghub` 命名空间始终不出现**（等 2s 超时）→
 * 面板 "NO_TRANSPORT"。而官方 loader 路径是**生产验证过**的
 * （`dsh-mcp-panel` 的 Remote 命名空间在桌面版里是活的，它就走 `exports["./typert"]`）。
 *
 * 所以：**官方路径为主，手工注册只在 loader 没成功时兜底**
 * （`host/rpc-remote.mjs` 会先查 `ctx.typert.getPackage(包名)` 再决定要不要手工注册 ——
 *  重复的 package-face 身份会被 typert 注册表**整批拒绝**，两条路不能同时生效）。
 *
 * @module dsh-runninghub-plugin/typert
 */

import { buildTypertManifest } from './host/remote-manifest.mjs'

/** 宿主半边的 Typert manifest。loader 要求导出名就叫 `TYPERT`。 */
export const TYPERT = buildTypertManifest()
