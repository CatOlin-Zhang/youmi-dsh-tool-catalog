/**
 * plugin-tools.ts — 注册到 DSH 注册表的三个工具定义（T10.1 / T10.3）
 *
 * 三个工具都直接产出**模型可读文本**（`output.schema = { type: 'string' }`），
 * 因为宿主对注册期产物做强校验（探测报告 §3：缺 `output.render` 直接抛
 * TypeError），而本插件不 import 宿主包（红线 2），只能自带形状兼容的定义。
 *
 * 失败语义（T10.3.3，全部可自愈或可诊断，不静默）：
 * - sidecar 未就绪 → `CATALOG_UNAVAILABLE: <原因>`；`invoke` 回 `NOT_ADMITTED`
 * - embedder 缺失且 embedMode=real → 同上，并附修复命令，**不回退关键词**
 * - 目录为空 → `CATALOG_EMPTY: 尚未索引到工具`
 */

import { createInvokeTool } from './invoke-tool.js'
import type { InvokeDeps } from './invoke-tool.js'
import { formatSearchResults } from './search-tool.js'
import { summarizeStatus } from './status.js'
import type { CatalogStatus, StatusTracker } from './status.js'
import type { SearchResult } from './types.js'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** 宿主注册名保留（`run_code` 不可占用），本插件只用这三个 */
export const SEARCH_TOOL_NAME = 'search_tools'
export const INVOKE_TOOL_NAME = 'invoke'
export const STATUS_TOOL_NAME = 'catalog_status'

/** 插件自身注册的元工具名（索引导入时要从目录里排除，避免自我检索） */
export const OWN_TOOL_NAMES: readonly string[] = [
  SEARCH_TOOL_NAME, INVOKE_TOOL_NAME, STATUS_TOOL_NAME,
]

/** 把文本结果渲染成宿主要求的 ContentBlock 数组 */
function renderText(_args: unknown, value: string) {
  return [{ type: 'text' as const, text: value }]
}

/**
 * `invoke` 定义 = 纯逻辑产物（`createInvokeTool`）+ 宿主需要的 `output` 校验。
 *
 * `createInvokeTool` 的 `output.render` 已经存在，这里只是把类型对齐到宿主的
 * `ToolDefinition`，让 `ctx.tools.register()` 的入参在 `tsc --noEmit` 下也成立。
 */
export function buildInvokeDefinition(deps: InvokeDeps): ToolDefinition {
  const tool = createInvokeTool(deps)
  return tool satisfies ToolDefinition
}

/** 目录侧对插件暴露的能力面（由 YoumiCatalogPlugin 实现） */
export interface CatalogApi {
  /**
   * 语义检索；sidecar 未就绪时抛错。
   * F10.2：实现必须尊重 topK（返回条数 ≤ topK，超上限时以 cappedAt 说明）；
   * F10.3：传入 opts.scope/toolSet 时按当前可见集裁剪结果。
   */
  search(
    query: string,
    topK?: number,
    minScore?: number,
    opts?: { scope?: unknown; toolSet?: unknown },
  ): Promise<{ results: SearchResult[]; cappedAt?: number | null }>
  /** 目录内工具总数（渲染 "/ N in catalog"） */
  indexedCount(): number
  /** invoke 转发依赖（含注册表 get/execute 接线） */
  invokeDeps(): InvokeDeps
  /**
   * F11.2：名字是否属于外部目录（`ext_*`，catalogMode=external）。
   * registry 形态缺省不存在 → 可选方法，调用侧用 `?.` 兜底。
   */
  isExternalTool?(name: string): boolean
  /** F11.2：把一次 invoke 转发给外部派发器（schema 校验 + mock 执行器） */
  invokeExternal?(name: string, rawArgs: unknown): Promise<string>
  /** 组装一次 catalog_status 快照（按调用方 scope 取可见集） */
  statusSnapshot(scope?: unknown, toolSet?: unknown): Promise<CatalogStatus>
  /**
   * 按调用方作用域补索引（F9.2）：检索视野 ≡ 派发视野。
   * 三个工具的 execute 在动作前用它传入 `exec.agent` / `exec.toolSet`；fail-open。
   */
  ensureIndexed(scope?: unknown, toolSet?: unknown): Promise<void>
  /** 健康状态跟踪器（读 readiness / reason） */
  readonly status: StatusTracker
}

/** `search_tools`：自然语言检索目录，返回紧凑签名清单 */
export function buildSearchDefinition(catalog: CatalogApi): ToolDefinition {
  return {
    name: SEARCH_TOOL_NAME,
    description:
      'Search the tool catalog by natural language to find a tool you can call with `invoke`. '
      + 'Returns numbered lines like `name(param: str, opt?: int) — what it does; risk=low`. '
      + 'Use it when the tools already in this request cannot do the task.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What you want to accomplish, in a few words',
        },
        top_k: {
          type: 'integer',
          description: 'Maximum number of results to return (default: 5)',
        },
        min_score: {
          type: 'number',
          description: 'Minimum similarity threshold (default: 0.3)',
        },
      },
      required: ['query'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    execute: async (args: unknown, exec?: ToolRunContext): Promise<string> => {
      const raw = (args ?? {}) as { query?: unknown; top_k?: unknown; min_score?: unknown }
      const query = typeof raw.query === 'string' ? raw.query.trim() : ''
      if (query === '') {
        return 'INVALID_ARGS: "query" must be a non-empty string.'
      }
      const rawTopK = typeof raw.top_k === 'number' && Number.isFinite(raw.top_k) && raw.top_k > 0
        ? Math.floor(raw.top_k)
        : undefined
      if (catalog.status.readiness !== 'ready') {
        return unavailableText(catalog)
      }
      // F9.2：先按调用方 agent 作用域补索引，让内置工具进入检索视野（fail-open）
      await catalog.ensureIndexed(exec?.agent, exec?.toolSet)
      let outcome: { results: SearchResult[]; cappedAt?: number | null }
      try {
        // F10.3 第 2 层：把调用方作用域传进检索，不可见的工具不进结果
        outcome = await catalog.search(
          query,
          rawTopK,
          typeof raw.min_score === 'number' ? raw.min_score : undefined,
          { scope: exec?.agent, toolSet: exec?.toolSet },
        )
      } catch (err) {
        return unavailableText(catalog, String(err))
      }
      const results = outcome.results
      if (results.length === 0 && catalog.indexedCount() === 0) {
        return 'CATALOG_EMPTY: no tools indexed yet. The registry is usually still empty at session start; '
          + 'call search_tools again after tools have been registered.'
      }
      // F10.2：top_k 超过目录上限时按上限处理，并在文案里说明（N 恒等于实际条数）
      const cappedAt = outcome.cappedAt ?? null
      const note = cappedAt !== null && rawTopK !== undefined && cappedAt < rawTopK
        ? `Note: requested top_k=${rawTopK} exceeds the catalog cap; returning at most ${cappedAt}.`
        : undefined
      return formatSearchResults(results, catalog.indexedCount(), note)
    },
  }
}

/** `invoke`：按名字直接调用目录里的工具（走宿主完整审批/审计管线） */
export function buildInvokeToolDefinition(catalog: CatalogApi): ToolDefinition {
  const deps = catalog.invokeDeps()
  const def = buildInvokeDefinition({
    ...deps,
    // sidecar/目录未就绪时，转发本身没有意义：给可自愈的提示而非静默失败
    forward: (name, args, exec) => {
      if (catalog.status.readiness !== 'ready') {
        return Promise.resolve({ ok: false, text: unavailableText(catalog) })
      }
      return deps.forward(name, args, exec)
    },
  })
  // F9.2 + F9.3：派发前先按调用方作用域补索引，使 UNKNOWN_TOOL / NOT_ADMITTED
  // 的判定基于「当前 scope 可见集」——与 search_tools 的检索视野保持一致。
  const inner = def.execute.bind(def)
  return {
    ...def,
    execute: async (args: unknown, exec: ToolRunContext): Promise<string> => {
      if (catalog.status.readiness === 'ready') {
        // F11.2：命中外部目录（ext_*）时走外部派发，不查注册表、不补索引——
        // ext_* 不在注册表里是形态前提（红线 3：请求头不得出现 ext_*），
        // 落到 inner 会被判成 UNKNOWN_TOOL，派发视野就丢了检索侧给过的工具。
        const raw = (args ?? {}) as { tool?: unknown; arguments?: unknown }
        const toolName = typeof raw.tool === 'string' ? raw.tool : ''
        if (toolName !== '' && catalog.isExternalTool?.(toolName) === true
          && catalog.invokeExternal !== undefined) {
          return catalog.invokeExternal(toolName, raw.arguments ?? {})
        }
        await catalog.ensureIndexed(exec?.agent, exec?.toolSet)
      }
      return (await inner(args, exec)) as string
    },
  }
}

/** `catalog_status`：健康检测载荷（模型可调 + 人可看） */
export function buildStatusDefinition(catalog: CatalogApi): ToolDefinition {
  return {
    name: STATUS_TOOL_NAME,
    description:
      'Report tool-catalog health: sidecar process, Python interpreter, embedder channel, ' +
      'index size, presentation mode and the start-up self-check. ' +
      'Use it when search_tools keeps failing to decide whether the catalog is usable.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: renderText,
    },
    execute: async (_args: unknown, exec?: ToolRunContext): Promise<string> => {
      // F9.1.4 / F9.2：catalog_status 也按调用方作用域补索引，让 indexed/registry
      // 反映 agent 可见工具数（而不是只有全局视图）。
      await catalog.ensureIndexed(exec?.agent, exec?.toolSet)
      const status = await catalog.statusSnapshot(exec?.agent, exec?.toolSet)
      return `${summarizeStatus(status)}\n${JSON.stringify(status, null, 2)}`
    },
  }
}

/** 统一的「目录不可用」文本：带原因，embedder 缺失时附修复命令 */
export function unavailableText(catalog: CatalogApi, detail?: string): string {
  const tracker = catalog.status
  const reason = detail ?? tracker.reason ?? 'sidecar not ready'
  const fix = tracker.embedderFix
  return `CATALOG_UNAVAILABLE: ${reason}`
    + (fix !== null ? `\nFix: ${fix}` : '')
    + '\nTool search is disabled while the catalog is unavailable; it does NOT fall back to keyword matching.'
    + ' Call catalog_status for full diagnostics and continue without catalog tools.'
}
