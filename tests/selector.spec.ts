/**
 * Selector 单元测试
 *
 * 测试纯函数选择器: selectTools / extractToolNames / diffActivated
 */

import { describe, it, expect } from 'vitest'
import { selectTools, extractToolNames, diffActivated } from '../src/selector.js'
import type { SearchResult, PinnedSet, ActivatedSet } from '../src/types.js'

// ======================================================================
// 测试数据工厂
// ======================================================================

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    tool_name: 'test_tool',
    description: 'Test tool description',
    score: 0.8,
    summary: 'Test summary',
    risk_level: 'low',
    required_permissions: [],
    ...overrides,
  }
}

// ======================================================================
// selectTools 测试
// ======================================================================

describe('selectTools', () => {
  it('should return pinned tools first', () => {
    const pinned: PinnedSet = new Set(['pinned_a', 'pinned_b'])
    const activated: ActivatedSet = new Set()
    const results: SearchResult[] = []

    const selected = selectTools(results, pinned, activated)

    expect(selected).toContain('pinned_a')
    expect(selected).toContain('pinned_b')
    expect(selected[0]).toBe('pinned_a')
    expect(selected[1]).toBe('pinned_b')
  })

  it('should return activated tools after pinned', () => {
    const pinned: PinnedSet = new Set(['pinned_tool'])
    const activated: ActivatedSet = new Set(['activated_tool'])
    const results: SearchResult[] = []

    const selected = selectTools(results, pinned, activated)

    expect(selected[0]).toBe('pinned_tool')
    expect(selected[1]).toBe('activated_tool')
  })

  it('should add search results after pinned and activated', () => {
    const pinned: PinnedSet = new Set()
    const activated: ActivatedSet = new Set()
    const results: SearchResult[] = [
      makeResult({ tool_name: 'search_tool_1', score: 0.9 }),
      makeResult({ tool_name: 'search_tool_2', score: 0.7 }),
    ]

    const selected = selectTools(results, pinned, activated, { maxResults: 5 })

    expect(selected).toContain('search_tool_1')
    expect(selected).toContain('search_tool_2')
  })

  it('should deduplicate tools across all sources', () => {
    const pinned: PinnedSet = new Set(['shared_tool'])
    const activated: ActivatedSet = new Set(['shared_tool'])
    const results: SearchResult[] = [
      makeResult({ tool_name: 'shared_tool', score: 0.9 }),
    ]

    const selected = selectTools(results, pinned, activated)

    // shared_tool should appear only once
    const count = selected.filter(n => n === 'shared_tool').length
    expect(count).toBe(1)
  })

  it('should respect minScore filter', () => {
    const pinned: PinnedSet = new Set()
    const activated: ActivatedSet = new Set()
    const results: SearchResult[] = [
      makeResult({ tool_name: 'high_score', score: 0.9 }),
      makeResult({ tool_name: 'low_score', score: 0.1 }),
    ]

    const selected = selectTools(results, pinned, activated, { minScore: 0.5 })

    expect(selected).toContain('high_score')
    expect(selected).not.toContain('low_score')
  })

  it('should sort search results by score descending', () => {
    const pinned: PinnedSet = new Set()
    const activated: ActivatedSet = new Set()
    const results: SearchResult[] = [
      makeResult({ tool_name: 'low', score: 0.5 }),
      makeResult({ tool_name: 'high', score: 0.9 }),
      makeResult({ tool_name: 'mid', score: 0.7 }),
    ]

    const selected = selectTools(results, pinned, activated, { maxResults: 10 })

    // After pinned/activated (both empty), search results should be sorted
    expect(selected[0]).toBe('high')
    expect(selected[1]).toBe('mid')
    expect(selected[2]).toBe('low')
  })

  it('should respect maxResults limit', () => {
    const pinned: PinnedSet = new Set()
    const activated: ActivatedSet = new Set()
    const results: SearchResult[] = [
      makeResult({ tool_name: 'tool_1', score: 0.9 }),
      makeResult({ tool_name: 'tool_2', score: 0.8 }),
      makeResult({ tool_name: 'tool_3', score: 0.7 }),
    ]

    const selected = selectTools(results, pinned, activated, { maxResults: 2 })

    expect(selected.length).toBeLessThanOrEqual(2)
  })

  it('should exclude pinned from activated (no duplicate)', () => {
    const pinned: PinnedSet = new Set(['tool_a'])
    const activated: ActivatedSet = new Set(['tool_a', 'tool_b'])
    const results: SearchResult[] = []

    const selected = selectTools(results, pinned, activated)

    expect(selected).toEqual(['tool_a', 'tool_b'])
  })
})

// ======================================================================
// extractToolNames 测试
// ======================================================================

describe('extractToolNames', () => {
  it('should extract names from results above threshold', () => {
    const results: SearchResult[] = [
      makeResult({ tool_name: 'pass', score: 0.8 }),
      makeResult({ tool_name: 'fail', score: 0.1 }),
    ]

    const names = extractToolNames(results, 0.5)

    expect(names.has('pass')).toBe(true)
    expect(names.has('fail')).toBe(false)
  })

  it('should return empty set for empty results', () => {
    const names = extractToolNames([])
    expect(names.size).toBe(0)
  })

  it('should use default minScore 0.3', () => {
    const results: SearchResult[] = [
      makeResult({ tool_name: 'above', score: 0.4 }),
      makeResult({ tool_name: 'below', score: 0.2 }),
    ]

    const names = extractToolNames(results)

    expect(names.has('above')).toBe(true)
    expect(names.has('below')).toBe(false)
  })
})

// ======================================================================
// diffActivated 测试
// ======================================================================

describe('diffActivated', () => {
  it('should return tools not yet activated', () => {
    const results: SearchResult[] = [
      makeResult({ tool_name: 'new_tool', score: 0.9 }),
      makeResult({ tool_name: 'old_tool', score: 0.8 }),
    ]
    const activated: ActivatedSet = new Set(['old_tool'])

    const diff = diffActivated(results, activated)

    expect(diff).toContain('new_tool')
    expect(diff).not.toContain('old_tool')
  })

  it('should respect minScore', () => {
    const results: SearchResult[] = [
      makeResult({ tool_name: 'high', score: 0.9 }),
      makeResult({ tool_name: 'low', score: 0.1 }),
    ]
    const activated: ActivatedSet = new Set()

    const diff = diffActivated(results, activated, 0.5)

    expect(diff).toContain('high')
    expect(diff).not.toContain('low')
  })

  it('should return empty array when all activated', () => {
    const results: SearchResult[] = [
      makeResult({ tool_name: 'tool_a', score: 0.9 }),
    ]
    const activated: ActivatedSet = new Set(['tool_a'])

    const diff = diffActivated(results, activated)

    expect(diff).toEqual([])
  })
})
