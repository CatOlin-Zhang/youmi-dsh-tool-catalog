/**
 * external.ts — 外部目录派发（F11.2，评测形态）
 *
 * `catalogMode=external` 时，`ext_*` 工具**不注册进 DSH 注册表**（形态前提，
 * 红线 3：请求头里不得出现 `ext_*`）。`invoke` 命中外部工具时不走注册表
 * 转发，而是：
 *
 * 1. 用 sidecar `get_tool` 回读条目（含参数 schema）；
 * 2. 按 schema 校验参数（失败语义与注册表路径一致：`INVALID_ARGS` + 完整签名，
 *    这是评测里 `arg_error_rate` 的来源）；
 * 3. 交给执行器执行。`externalExecutor=mock`（评测期唯一实现）不执行真实
 *    动作，返回确定性结构化结果：
 *
 *       {"ok": true, "tool": "...", "args_echo": {...}, "note": "mock executor (evaluation only)"}
 *
 * `externalExecutor=mcp` 属于后续工作（真实外部执行器），此处显式报错、
 * 不静默回落到 mock——那样评出来的「成功率」就没有可信的落点了。
 *
 * 本文件无 DSH 运行时依赖，可独立单测。
 */

import { renderSignature } from './search-tool.js'
import { validateAgainstSchema } from './invoke-tool.js'
import type { ExternalToolEntry, ExternalToolParam } from './sidecar.js'
import type { SearchParamBrief } from './types.js'

/** mock 执行器回给模型的 note（报告/日志里识别评测形态的锚点） */
export const MOCK_EXECUTOR_NOTE = 'mock executor (evaluation only)'

/** 外部执行器未实现的显式错误文本（不得静默当成 mock 跑） */
export const EXECUTOR_UNAVAILABLE = 'EXECUTOR_UNAVAILABLE'

/** 参数条目 → 精简视图（与 sidecar `_param_brief` / SearchParamBrief 对齐） */
export function briefsFromEntry(params: ExternalToolParam[] | undefined): SearchParamBrief[] {
  return (params ?? []).map(p => ({
    name: p.name,
    type: typeof p.type === 'string' ? p.type : 'string',
    required: p.required === true,
    enum: Array.isArray(p.enum) ? p.enum.filter((v): v is string => typeof v === 'string') : null,
  }))
}

/** 渲染外部工具的紧凑签名（与注册表工具同一套 renderSignature 规则） */
export function signatureForEntry(entry: ExternalToolEntry): string {
  return renderSignature({
    tool_name: entry.name,
    description: '',
    score: 0,
    summary: '',
    risk_level: entry.risk_level ?? 'low',
    required_permissions: [],
    parameters: briefsFromEntry(entry.parameters),
  } as never)
}

/**
 * 外部条目的 parameters → JSON Schema（object 根）。
 *
 * 交给 `invoke-tool.ts::validateAgainstSchema` 校验，规则与注册表路径完全
 * 一致（必填 / 基础类型 / enum），保证两个臂的 `arg_error_rate` 可比。
 */
export function schemaFromEntry(entry: ExternalToolEntry): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const p of entry.parameters ?? []) {
    const spec: Record<string, unknown> = { type: p.type ?? 'string' }
    if (typeof p.description === 'string' && p.description !== '') spec.description = p.description
    if (Array.isArray(p.enum) && p.enum.length > 0) spec.enum = p.enum
    properties[p.name] = spec
    if (p.required === true) required.push(p.name)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

/** mock 执行器：不回环任何真实副作用，只回显结构化结果 */
export function mockExecute(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    ok: true,
    tool: name,
    args_echo: args,
    note: MOCK_EXECUTOR_NOTE,
  })
}

/** `invokeExternal` 的依赖注入面（单测用假实现，真机由 YoumiCatalogPlugin 提供） */
export interface ExternalInvokeDeps {
  /** 按名回读外部条目；不存在返回 null → UNKNOWN_TOOL */
  getEntry(name: string): Promise<ExternalToolEntry | null>
  /** 配置的执行器（'mock' 评测期唯一实现；'mcp' 显式报未实现） */
  executor(): 'mock' | 'mcp'
  /** 拼写建议候选池（与注册表路径共用目录名缓存） */
  knownNames(): Iterable<string>
}

/**
 * 执行一次外部工具派发，返回给模型的纯文本结果。
 *
 * 失败语义（F11.2，与注册表路径一致）：
 * - 条目不存在 → `UNKNOWN_TOOL` + 编辑距离候选（由调用侧文本给出）
 * - 参数非法 → `INVALID_ARGS` + 完整签名
 * - executor=mcp → `EXECUTOR_UNAVAILABLE`（不静默当 mock）
 */
export async function dispatchExternal(
  name: string,
  rawArgs: unknown,
  deps: ExternalInvokeDeps,
): Promise<string> {
  const entry = await deps.getEntry(name)
  if (entry === null) {
    // 理论上到这里说明名字在 _externalNames 里但 sidecar 查不到（库被清理）；
    // 与注册表路径同语义：UNKNOWN_TOOL，绝不当成执行成功
    return `UNKNOWN_TOOL: ${name}\nUse search_tools to discover available tools.`
  }
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    return `INVALID_ARGS: "arguments" must be an object mapping parameter names to values.\n`
      + `Expected signature: ${signatureForEntry(entry)}`
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>
  // 校验复用注册表路径同一实现，错误文本格式保持一致（INVALID_ARGS: 原因 + 签名）
  const violations = validateAgainstSchema(schemaFromEntry(entry), args)
  if (violations.length > 0) {
    return `INVALID_ARGS: ${violations.join('; ')}\nExpected signature: ${signatureForEntry(entry)}`
  }
  if (deps.executor() !== 'mock') {
    return `${EXECUTOR_UNAVAILABLE}: externalExecutor="${deps.executor()}" is not implemented `
      + '(real MCP/HTTP forwarding is out of F11 scope; use "mock" for evaluation).'
  }
  return mockExecute(name, args)
}
