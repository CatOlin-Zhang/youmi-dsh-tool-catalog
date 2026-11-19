/**
 * mode 开关与可见性同步测试（T5）
 *
 * 核心验收：默认 inject 下 restrict() 调用次数为 0；declare 可复现旧行为。
 */

import { describe, expect, it, vi } from 'vitest'
import { YoumiCatalogPlugin } from '../src/index.js'
import { selectTools } from '../src/selector.js'
import { DEFAULT_CONFIG } from '../src/types.js'
import type { SearchResult } from '../src/types.js'

function makeResult(tool_name: string, score = 0.8): SearchResult {
  return {
    tool_name,
    description: '',
    score,
    summary: '',
    risk_level: 'low',
    required_permissions: [],
  }
}

describe('mode 配置', () => {
  it('默认 mode 为 inject', () => {
    expect(DEFAULT_CONFIG.mode).toBe('inject')
    expect(new YoumiCatalogPlugin().syncVisibility({ restrict: vi.fn() }, ['a'])).toBe(false)
  })
})

describe('syncVisibility', () => {
  const registry = ['tool_a', 'tool_b', 'tool_c', 'pinned_x']

  it('inject（默认）：restrict 调用次数为 0', () => {
    const plugin = new YoumiCatalogPlugin()
    const restrict = vi.fn()
    plugin.activate(['tool_a'])
    plugin.setPinned(['pinned_x'])

    const called = plugin.syncVisibility({ restrict }, registry)

    expect(restrict).toHaveBeenCalledTimes(0)
    expect(called).toBe(false)
  })

  it('declare：deny = 全量 − activated − pinned', () => {
    const plugin = new YoumiCatalogPlugin({ mode: 'declare' })
    const restrict = vi.fn()
    plugin.activate(['tool_a'])
    plugin.setPinned(['pinned_x'])

    const called = plugin.syncVisibility({ restrict }, registry)

    expect(called).toBe(true)
    expect(restrict).toHaveBeenCalledTimes(1)
    expect(restrict.mock.calls[0][0]).toEqual({ deny: ['tool_b', 'tool_c'] })
  })

  it('declare：激活集为空时 deny 覆盖全量', () => {
    const plugin = new YoumiCatalogPlugin({ mode: 'declare' })
    const restrict = vi.fn()
    plugin.syncVisibility({ restrict }, registry)
    expect(restrict.mock.calls[0][0]).toEqual({ deny: registry })
  })
})

describe('selectTools 配额（T5-5 修正）', () => {
  it('pinned 与 activated 不占用 maxResults 配额', () => {
    const pinned = new Set(['p1'])
    const activated = new Set(['a1', 'a2'])
    const results = [
      makeResult('s1', 0.9),
      makeResult('s2', 0.8),
      makeResult('s3', 0.7),
    ]

    const selected = selectTools(results, pinned, activated, { maxResults: 2 })

    // pinned + activated 始终保留，检索结果按配额补足 2 条
    expect(selected).toEqual(['p1', 'a1', 'a2', 's1', 's2'])
  })

  it('activated 满时检索结果仍可获得配额（旧 bug：全被挤掉）', () => {
    const activated = new Set(['a1', 'a2', 'a3', 'a4', 'a5'])
    const results = [makeResult('s1', 0.9)]

    const selected = selectTools(results, new Set(), activated, { maxResults: 2 })

    expect(selected).toContain('s1')
  })

  it('同一输入产出确定顺序：pinned 插入序 → activated 插入序 → 分数降序', () => {
    const pinned = new Set(['p2', 'p1'])
    const activated = new Set(['a2', 'a1'])
    const results = [makeResult('s2', 0.6), makeResult('s1', 0.95)]
    const opts = { maxResults: 5 }

    const first = selectTools(results, pinned, activated, opts)
    const second = selectTools(results, new Set(pinned), new Set(activated), opts)

    expect(second).toEqual(first)
    expect(first).toEqual(['p2', 'p1', 'a2', 'a1', 's1', 's2'])
  })
})
