/**
 * Invoke Tool — `invoke` 元工具（T4，路径 B 核心）
 *
 * 让模型用一次 `search_tools` + 一次 `invoke(tool, arguments)` 完成原本
 * 需要"激活 → 重发请求头 → 再调用"的往返：目标工具不进入请求头，调用由
 * `ctx.tools.execute()` 直接转发（走完整审批/审计管线）。
 *
 * 本文件不含任何 DSH 运行时依赖（仅结构兼容的本地接口 + type import），
 * 可独立单测；与 DSH 注册表的接线通过 {@link buildInvokeDeps} 注入。
 *
 * 已知取舍（见 docs/notes/dsh-capability-probe.md T0-1）：
 * `ctx.tools.execute()` 不产生 session 级 `tool/call` / `tool/result` 事件
 * （那由 agent-loop 的 tool-calls.ts 落盘），GUI 回放/审计需上层自行补记。
 */

import { renderSignature } from './search-tool.js'
import type { SearchParamBrief, SearchResult } from './types.js'

// ======================================================================
// 依赖接口（由 DSH 接线方实现）
// ======================================================================

/** 目标工具定义的最小投影（DSH `ToolDefinition` 结构兼容） */
export interface InvokableToolDef {
  name: string
  description?: string
  /** 编译后的原始 JSON Schema（object 根） */
  parameters?: Record<string, unknown>
}

/** 转发调用的扁平化结果 */
export interface InvokeOutcome {
  ok: boolean
  /** 已扁平化为文本的结果内容（成功为工具输出，失败为错误消息） */
  text: string
}

/** invoke 执行时传入的调用方上下文（DSH `ToolRunContext` 结构兼容子集） */
export interface InvokeExecContext {
  signal: AbortSignal
  agent?: unknown
  /** 外层调用的步骤准入集；转发时必须透传，否则带 `when` 的目标会被当成 UNKNOWN_TOOL */
  toolSet?: unknown
  /** 外层 invoke 调用的 callId，用于派生子调用 id */
  callId?: string
}

/** 注入给 invoke 的运行时依赖 */
export interface InvokeDeps {
  /**
   * 按名取目标工具定义；不可见（未注册/被 restrict 隐藏）时返回 undefined。
   * `exec` 带上外层调用的 `toolSet`/`agent`，接线方应用它解析步骤准入
   * （否则带 `when` 的目标会被当成 UNKNOWN_TOOL）。
   */
  getTool(name: string, exec?: InvokeExecContext): InvokableToolDef | undefined
  /** 转发一次调用（内部应走 `ctx.tools.execute`，保留审批/审计管线） */
  forward(name: string, args: Record<string, unknown>, exec: InvokeExecContext): Promise<InvokeOutcome>
  /** 名字是否在目录（catalog）中——区分 UNKNOWN_TOOL 与 NOT_ADMITTED */
  isInCatalog(name: string): boolean
  /** 拼写建议的候选名池 */
  knownNames(): Iterable<string>
  /** 可选：工具的 when/准入判定；返回 false → NOT_ADMITTED（不要重试） */
  isAdmitted?(name: string): boolean
}

// ======================================================================
// 拼写建议（编辑距离）
// ======================================================================

/** Levenshtein 编辑距离（行滚动 DP） */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const curr = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = curr.slice()
  }
  return prev[b.length]
}

/** 从候选池中找编辑距离 ≤ maxDistance 的前 maxResults 个名字（按距离升序） */
export function suggestNames(
  name: string,
  pool: Iterable<string>,
  maxDistance = 2,
  maxResults = 3,
): string[] {
  const scored: Array<{ name: string; dist: number }> = []
  for (const cand of pool) {
    if (cand === name) continue
    const dist = editDistance(name, cand)
    if (dist <= maxDistance) scored.push({ name: cand, dist })
  }
  scored.sort((x, y) => x.dist - y.dist || x.name.localeCompare(y.name))
  return scored.slice(0, maxResults).map(s => s.name)
}

// ======================================================================
// 原始 JSON Schema → 签名 / 校验
// ======================================================================

const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

/** 从编译后的参数 JSON Schema 提取精简视图（与 sidecar `_param_brief` 对齐） */
export function briefsFromSchema(schema: Record<string, unknown> | undefined): SearchParamBrief[] {
  const props = schema?.properties as Record<string, Record<string, unknown>> | undefined
  if (!props || typeof props !== 'object') return []
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : [])
  return Object.entries(props).map(([name, p]) => ({
    name,
    type: typeof p.type === 'string' ? p.type : 'json',
    required: required.has(name),
    enum: Array.isArray(p.enum) ? (p.enum as unknown[]).filter(v => typeof v === 'string') : null,
  }))
}

/** 由注册表定义渲染签名；definition 缺失参数时回退工具名形式 */
export function signatureFor(name: string, schema?: Record<string, unknown>): string {
  return renderSignature({
    tool_name: name,
    description: '',
    score: 0,
    summary: '',
    risk_level: 'low',
    required_permissions: [],
    parameters: briefsFromSchema(schema),
  } as SearchResult)
}

/** 校验 arguments 是否满足目标工具的参数 schema；返回违规说明（空数组 = 通过） */
export function validateAgainstSchema(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): string[] {
  if (!schema || schema.type !== 'object' || !schema.properties) return []
  const props = schema.properties as Record<string, Record<string, unknown>>
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  const violations: string[] = []

  for (const key of required) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      violations.push(`missing required argument: ${key}`)
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    const p = props[key]
    if (!p) continue // 隐式开放根：多余键交给目标工具自己处理
    const expected = p.type
    if (typeof expected === 'string' && PRIMITIVE_TYPES.has(expected)) {
      const actual = Array.isArray(value) ? 'array' : typeof value
      const ok = expected === 'integer'
        ? actual === 'number' && Number.isInteger(value)
        : actual === expected
      if (!ok) violations.push(`argument "${key}" must be of type ${expected}`)
    }
    if (Array.isArray(p.enum) && !p.enum.includes(value)) {
      violations.push(`argument "${key}" must be one of [${p.enum.join(', ')}]`)
    }
  }
  return violations
}

// ======================================================================
// 核心分发
// ======================================================================

/** 错误前缀常量（模型据此自愈，见改造方案 T4 错误语义表） */
export const UNKNOWN_TOOL = 'UNKNOWN_TOOL'
export const INVALID_ARGS = 'INVALID_ARGS'
export const NOT_ADMITTED = 'NOT_ADMITTED'

/**
 * 执行一次 invoke 分发，返回给模型的纯文本结果。
 *
 * 失败路径（都能自愈）：
 * - 工具不存在 → `UNKNOWN_TOOL: <name>` + ≤3 个编辑距离 ≤2 的候选名
 * - 目录里有但注册表不可见 / `isAdmitted` 拒绝 → `NOT_ADMITTED: <name>`（不要重试）
 * - 参数校验失败 → `INVALID_ARGS: <原因>` + 完整签名
 */
export async function dispatchInvoke(
  raw: { tool?: unknown; arguments?: unknown },
  deps: InvokeDeps,
  exec: InvokeExecContext,
): Promise<string> {
  const name = typeof raw.tool === 'string' ? raw.tool.trim() : ''
  if (!name) {
    return `${INVALID_ARGS}: "tool" must be a non-empty string. Use search_tools first to find a tool name.`
  }

  const def = deps.getTool(name, exec)
  if (def === undefined) {
    if (deps.isInCatalog(name)) {
      return `${NOT_ADMITTED}: ${name} is indexed but not callable in the current view. `
        + 'Do not retry it; call search_tools for an alternative.'
    }
    const suggestions = suggestNames(name, deps.knownNames())
    const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(', ')}?` : ''
    return `${UNKNOWN_TOOL}: ${name}${hint}\nUse search_tools to discover available tools.`
  }

  if (deps.isAdmitted && !deps.isAdmitted(name)) {
    return `${NOT_ADMITTED}: ${name} is not admitted for the current step. `
      + 'Do not retry it; call search_tools for an alternative.'
  }

  const args = (raw.arguments !== undefined && raw.arguments !== null ? raw.arguments : {}) as Record<string, unknown>
  if (typeof raw.arguments !== 'object' || raw.arguments === null || Array.isArray(raw.arguments)) {
    return `${INVALID_ARGS}: "arguments" must be an object mapping parameter names to values.\n`
      + `Expected signature: ${signatureFor(name, def.parameters)}`
  }

  const violations = validateAgainstSchema(def.parameters, args)
  if (violations.length > 0) {
    return `${INVALID_ARGS}: ${violations.join('; ')}\nExpected signature: ${signatureFor(name, def.parameters)}`
  }

  exec.signal.throwIfAborted()
  const outcome = await deps.forward(name, args, exec)
  if (!outcome.ok) {
    // 转发失败：原样带回错误文本，让模型自行决定重试/换工具
    return outcome.text
  }
  return outcome.text
}

// ======================================================================
// 工具定义（DSH 注册表结构兼容，不经 defineTool 以便零运行时依赖）
// ======================================================================

/** createInvokeTool 返回值的结构（与 `@deepseek-ai/dsh-tools` ToolDefinition 兼容） */
export interface InvokeToolDefinition {
  name: 'invoke'
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: { type: 'string' }
    render(args: unknown, value: string): Array<{ type: 'text'; text: string }>
  }
  execute(
    args: { tool?: unknown; arguments?: unknown },
    exec: InvokeExecContext,
  ): Promise<string>
}

/**
 * 构造 `invoke` 工具定义，供调用方 `ctx.tools.register(createInvokeTool(deps))`。
 *
 * 形状与 DSH `defineTool()` 产物一致（parameters/output 为编译后原始 schema），
 * 但保持本模块无 DSH 运行时依赖。
 */
export function createInvokeTool(deps: InvokeDeps): InvokeToolDefinition {
  return {
    name: 'invoke',
    description:
      'Call a catalog tool by name. Arguments are validated against the tool schema; '
      + 'on failure the correct signature is returned.',
    parameters: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Exact tool name from search_tools results.',
        },
        arguments: {
          type: 'object',
          description: 'Arguments object for the target tool: keys are parameter names, values follow each parameter type.',
        },
      },
      required: ['tool', 'arguments'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    execute: (args, exec) => dispatchInvoke(args, deps, exec),
  }
}

// ======================================================================
// DSH 接线助手
// ======================================================================

/**
 * 真实 `ctx.tools`（ToolsService）的最小投影。
 *
 * 0.2.2-rc.3 起 `execute` **只有批量形态**（探测报告 §1）：
 * 入参 `ToolBatchInput{ calls, signal, agent?, toolSet?, log? }`，
 * `calls[].arguments` 是模型产出的**原始 JSON 字符串**，结果取 `results[0].result`。
 */
export interface DshToolsLike {
  get(name: string, scope?: unknown, toolSet?: unknown): InvokableToolDef | undefined
  execute(input: {
    calls: ReadonlyArray<{ type: 'tool-call'; id: string; name: string; arguments: string }>
    signal: AbortSignal
    agent?: unknown
    toolSet?: unknown
  }): Promise<{
    results: ReadonlyArray<{ callId: string; result: {
      isError: boolean
      content: ReadonlyArray<{ type: string; text?: string }>
      error?: { message: string }
    } }>
    additionalContexts: readonly unknown[]
    concluded: boolean
  }>
}

/** 把批量结果里的一个 outcome 扁平化为 { ok, text } */
function flattenOutcome(result: {
  isError: boolean
  content: ReadonlyArray<{ type: string; text?: string }>
  error?: { message: string }
}): InvokeOutcome {
  const text = result.content
    .map(block => block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type} content]`)
    .join('\n')
  if (!result.isError) return { ok: true, text }
  const message = text.length > 0 ? text : (result.error?.message ?? '')
  return { ok: false, text: message.length > 0 ? message : `TOOL_ERROR: failed with empty content` }
}

/**
 * 把 DSH `ctx.tools` 适配为 {@link InvokeDeps}。
 *
 * - `ToolCallId` 品牌是编译期断言（`dsh-llm/src/brand.ts` 原样返回字符串），
 *   运行时直接传字符串即可。
 * - 子调用 id：`<invoke 的 callId>:invoke`，无 callId 时合成 `invoke-<ts>`。
 * - **不传 `log`**：插件拿不到本 turn/step 的权威值，因此内层调用不产生
 *   session 级 `tool/call`、`tool/result` 事件（交付限制 1，源码已确认）。
 */
export function buildInvokeDeps(
  tools: DshToolsLike,
  catalog: { has(name: string): boolean; names(): Iterable<string> },
): InvokeDeps {
  return {
    // 透传外层 toolSet / agent：带 `when` 的注册只有步骤准入集里才可执行
    getTool: (name, exec) => tools.get(name, exec?.agent, exec?.toolSet),
    isInCatalog: name => catalog.has(name),
    knownNames: () => catalog.names(),
    async forward(name, args, exec) {
      const callId = exec.callId !== undefined ? `${exec.callId}:invoke` : `invoke-${Date.now()}`
      const batch = await tools.execute({
        calls: [{
          type: 'tool-call',
          id: callId,
          name,
          // 批量入参要求原始 JSON 字符串（batch.ts 内 parseArguments 再解析）
          arguments: JSON.stringify(args),
        }],
        signal: exec.signal,
        ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
        ...(exec.toolSet !== undefined ? { toolSet: exec.toolSet } : {}),
      })
      const settled = batch.results.find(r => r.callId === callId) ?? batch.results[0]
      if (settled === undefined) {
        return { ok: false, text: `TOOL_ERROR: ${name} returned no batch result` }
      }
      return flattenOutcome(settled.result)
    },
  }
}
