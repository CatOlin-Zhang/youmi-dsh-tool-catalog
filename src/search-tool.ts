/**
 * Search Tool — search_tools 工具定义
 *
 * 注册到 DSH tools 系统，供 Agent 主动检索工具目录。
 */

import type { SearchParamBrief, SearchResult } from './types.js'

/**
 * search_tools 工具的参数定义
 */
export interface SearchToolsParams {
  /** 自然语言查询 */
  query: string
  /** 返回结果数量（默认 5） */
  top_k?: number
  /** 最低相似度阈值（默认 0.3） */
  min_score?: number
}

/**
 * search_tools 工具的结果格式
 */
export interface SearchToolsResult {
  tools: SearchResult[]
  total: number
}

// ======================================================================
// 紧凑签名渲染（T3）
// ======================================================================

/** 签名最多展示参数数（与 Python 侧 _MAX_SIGNATURE_PARAMS 一致） */
const MAX_SIGNATURE_PARAMS = 8
/** 签名最大长度（与 Python 侧 _MAX_SIGNATURE_LEN 一致） */
const MAX_SIGNATURE_LEN = 160

/** JSON Schema 类型缩写，控制签名长度 */
const TYPE_ABBR: Record<string, string> = {
  string: 'str',
  integer: 'int',
  number: 'num',
  boolean: 'bool',
  array: 'arr',
  object: 'obj',
}

function shortType(type: string): string {
  return TYPE_ABBR[type] ?? type
}

function renderParam(p: SearchParamBrief): string {
  return `${p.required ? p.name : `${p.name}?`}: ${shortType(p.type)}`
}

/**
 * 渲染单个检索结果的紧凑签名，如 `send_email(to: str, subject: str, cc?: str)`。
 *
 * - 优先由 `parameters` 渲染（必填在前、可选带 `?`、超 8 个加 `…`、总长 ≤ 160）
 * - `parameters` 缺失时回退 Python 侧预渲染的 `signature` 字段
 *
 * 导出供 T5（inject 模式下渲染激活提示）复用。
 */
export function renderSignature(result: SearchResult): string {
  const params = result.parameters
  if (!params || params.length === 0) {
    return result.signature ?? `${result.tool_name}()`
  }

  const required = params.filter((p) => p.required)
  const optional = params.filter((p) => !p.required)
  const ordered = [...required, ...optional]
  const truncated = ordered.length > MAX_SIGNATURE_PARAMS
  const shown = ordered.slice(0, MAX_SIGNATURE_PARAMS).map(renderParam)

  let rendered = shown.join(', ')
  if (truncated) {
    rendered = rendered ? `${rendered}, …` : '…'
  }
  let sig = `${result.tool_name}(${rendered})`
  if (sig.length > MAX_SIGNATURE_LEN) {
    sig = sig.slice(0, MAX_SIGNATURE_LEN - 1) + '…'
  }
  return sig
}

/** summary 截断为一句（≤ 60 字符） */
function oneSentence(text: string): string {
  const match = text.match(/^.[^。.!?]*[。.!?]?/)
  const first = (match ? match[0] : text).replace(/[。.!?]$/, '').trim()
  const body = first || text.trim()
  return body.length > 60 ? body.slice(0, 59) + '…' : body
}

/**
 * 格式化 search_tools 结果为紧凑文本（用于 LLM 呈现）
 *
 * 每行一条：`N. signature — 一句话说明; risk=level`。
 * 不展示分数、权限，summary 截断为一句（缓存友好、省 token）。
 *
 * F10.2：头部文案里的 N 恒等于实际返回条数（由 results.length 渲染）；
 * 调用方可传 `note`（如 top_k 被上限保护时的一行说明）附在头部之后。
 *
 * @param results 检索结果
 * @param catalogTotal 目录内工具总数（可选，展示为 `/ 1000 in catalog`）
 * @param note 可选一行补充说明（紧跟头部，如 `… (top-k cap applied)`）
 */
export function formatSearchResults(
  results: SearchResult[],
  catalogTotal?: number,
  note?: string,
): string {
  if (results.length === 0) {
    return 'No matching tools. Try a broader query or different wording.'
  }

  const totalSuffix = catalogTotal !== undefined ? ` / ${catalogTotal} in catalog` : ''
  const lines = results.map((r, i) => {
    const brief = oneSentence(r.summary || r.description)
    const tail = brief ? ` — ${brief}` : ''
    return `${i + 1}. ${renderSignature(r)}${tail}; risk=${r.risk_level}`
  })

  const header = `Found ${results.length} tool(s)${totalSuffix}:`
  return (note !== undefined && note !== '' ? `${header}\n${note}` : header) + `\n${lines.join('\n')}`
}

/**
 * 生成 search_tools 的 OpenAI function schema
 */
export function getSearchToolSchema(): {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required: string[]
    }
  }
} {
  return {
    type: 'function',
    function: {
      name: 'search_tools',
      description:
        'Search the tool catalog using natural language. ' +
        'Returns relevant tools with semantic similarity scores. ' +
        'Use this to discover tools available for a task.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language description of what you want to do',
          },
          top_k: {
            type: 'integer',
            description: 'Maximum number of results to return (default: 5)',
            default: 5,
          },
          min_score: {
            type: 'number',
            description: 'Minimum similarity score threshold (default: 0.3)',
            default: 0.3,
          },
        },
        required: ['query'],
      },
    },
  }
}
