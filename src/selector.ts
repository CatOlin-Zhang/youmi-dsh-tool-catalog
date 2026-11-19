/**
 * Selector — 纯函数：pinned + activated 合并
 *
 * 无状态，根据当前 session 的 pinned 集和 activated 集，
 * 决定哪些工具应该呈现给 LLM。
 */

import type { SearchResult, PinnedSet, ActivatedSet } from './types.js'

export interface SelectorOptions {
  /** 检索结果最大数量（默认 5） */
  maxResults?: number
  /** 最低相似度阈值（默认 0.3） */
  minScore?: number
  /** 是否包含 pinned 工具（默认 true） */
  includePinned?: boolean
  /** 是否包含 activated 工具（默认 true） */
  includeActivated?: boolean
}

const DEFAULT_SELECTOR_OPTIONS: Required<SelectorOptions> = {
  maxResults: 5,
  minScore: 0.3,
  includePinned: true,
  includeActivated: true,
}

/**
 * 合并 pinned + activated + 检索结果，返回最终呈现列表
 *
 * 优先级: pinned > activated > search results (by score desc)
 *
 * @param searchResults - 向量检索返回的结果列表
 * @param pinned - pinned 工具名集合（始终呈现）
 * @param activated - 已激活工具名集合（本 turn 使用过的）
 * @param options - 选择器选项
 * @returns 去重 + 排序后的工具名列表
 */
export function selectTools(
  searchResults: SearchResult[],
  pinned: PinnedSet,
  activated: ActivatedSet,
  options: SelectorOptions = {},
): string[] {
  const opts = { ...DEFAULT_SELECTOR_OPTIONS, ...options }
  const seen = new Set<string>()
  const result: string[] = []

  // 1. pinned 工具优先（始终呈现）
  if (opts.includePinned) {
    for (const name of pinned) {
      if (!seen.has(name)) {
        seen.add(name)
        result.push(name)
      }
    }
  }

  // 2. activated 工具次之（本 session 使用过的）
  if (opts.includeActivated) {
    for (const name of activated) {
      if (!seen.has(name) && !pinned.has(name)) {
        seen.add(name)
        result.push(name)
      }
    }
  }

  // 3. 检索结果按分数降序补充
  //    maxResults 只约束"本轮新增检索结果"的配额；pinned / activated 不占额度
  //    （旧实现 `result.length >= maxResults + pinned.size` 在 activated 进入
  //    result 后会把检索结果全部挤掉，属缓存无关的呈现 bug）
  const filtered = searchResults
    .filter(r => r.score >= opts.minScore)
    .sort((a, b) => b.score - a.score)

  let added = 0
  for (const r of filtered) {
    if (added >= opts.maxResults) {
      break
    }
    if (!seen.has(r.tool_name)) {
      seen.add(r.tool_name)
      result.push(r.tool_name)
      added++
    }
  }

  return result
}

/**
 * 从检索结果中提取工具名集合（不做合并）
 *
 * @param results - 检索结果
 * @param minScore - 最低分数阈值
 * @returns 工具名 Set
 */
export function extractToolNames(
  results: SearchResult[],
  minScore = 0.3,
): Set<string> {
  return new Set(
    results
      .filter(r => r.score >= minScore)
      .map(r => r.tool_name),
  )
}

/**
 * 计算需要新激活的工具（在 results 中但不在 activated 中的）
 *
 * @param results - 检索结果
 * @param activated - 当前激活集
 * @param minScore - 最低分数阈值
 * @returns 需要新激活的工具名列表
 */
export function diffActivated(
  results: SearchResult[],
  activated: ActivatedSet,
  minScore = 0.3,
): string[] {
  return results
    .filter(r => r.score >= minScore && !activated.has(r.tool_name))
    .map(r => r.tool_name)
}
