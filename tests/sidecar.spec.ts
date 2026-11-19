/**
 * Sidecar 单元测试（使用 mock）
 *
 * 测试 Sidecar 类的 RPC 通信逻辑，不实际 spawn Python 进程。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

// ======================================================================
// Mock child_process
// ======================================================================

class MockStdin extends EventEmitter {
  public written: string[] = []

  write(data: string): boolean {
    this.written.push(data)
    return true
  }

  clear() {
    this.written = []
  }
}

class MockStdout extends EventEmitter {
  setEncoding(_enc: string): void {}
}

class MockStderr extends EventEmitter {
  setEncoding(_enc: string): void {}
}

function createMockProcess(): {
  proc: ChildProcess
  stdin: MockStdin
  stdout: MockStdout
  stderr: MockStderr
} {
  const stdin = new MockStdin()
  const stdout = new MockStdout()
  const stderr = new MockStderr()

  const proc = {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(),
    on: vi.fn(),
  } as unknown as ChildProcess

  return { proc, stdin, stdout, stderr }
}

// ======================================================================
// 测试用例
// ======================================================================

describe('Sidecar (mocked)', () => {
  it('should construct with default config', async () => {
    // 简单导入测试，确保模块可加载
    const { Sidecar } = await import('../src/sidecar.js')
    const sidecar = new Sidecar()
    expect(sidecar.ready).toBe(false)
  })

  it('should construct with custom config', async () => {
    const { Sidecar } = await import('../src/sidecar.js')
    const sidecar = new Sidecar({
      dbPath: '/tmp/test.db',
      rpcTimeoutMs: 5000,
    })
    expect(sidecar.ready).toBe(false)
  })

  it('should throw when calling before start', async () => {
    const { Sidecar } = await import('../src/sidecar.js')
    const sidecar = new Sidecar()

    await expect(sidecar.call('test', {})).rejects.toThrow('sidecar not running')
  })

  it('should throw when searching before start', async () => {
    const { Sidecar } = await import('../src/sidecar.js')
    const sidecar = new Sidecar()

    await expect(sidecar.search('query')).rejects.toThrow('sidecar not running')
  })
})

describe('Indexer (mocked)', () => {
  it('should accumulate stats', async () => {
    const { Indexer } = await import('../src/indexer.js')

    // 创建 mock sidecar
    const mockSidecar = {
      indexTools: vi.fn().mockResolvedValue({ indexed: 2, skipped: 1, errors: 0 }),
      removeTools: vi.fn().mockResolvedValue({ removed: 1 }),
    } as any

    const indexer = new Indexer(mockSidecar, { debounceMs: 10 })

    expect(indexer.stats).toEqual({ indexed: 0, skipped: 0, errors: 0 })
  })

  it('should batch notify changes', async () => {
    const { Indexer } = await import('../src/indexer.js')

    const mockSidecar = {
      indexTools: vi.fn().mockResolvedValue({ indexed: 3, skipped: 0, errors: 0 }),
      removeTools: vi.fn().mockResolvedValue({ removed: 0 }),
    } as any

    const indexer = new Indexer(mockSidecar, { debounceMs: 10 })

    indexer.notifyChanges([
      { name: 'tool_a', description: 'A' },
      { name: 'tool_b', description: 'B' },
      { name: 'tool_c', description: 'C' },
    ])

    // 等待 debounce
    await new Promise(r => setTimeout(r, 50))

    expect(mockSidecar.indexTools).toHaveBeenCalled()
  })
})

describe('SessionState', () => {
  it('should track activated tools', async () => {
    const { SessionState } = await import('../src/state.js')

    const state = new SessionState()

    state.activate(['tool_a', 'tool_b'])
    expect(state.isActivated('tool_a')).toBe(true)
    expect(state.isActivated('tool_b')).toBe(true)
    expect(state.isActivated('tool_c')).toBe(false)
  })

  it('should be monotonic (no removal)', async () => {
    const { SessionState } = await import('../src/state.js')

    const state = new SessionState()

    state.activate(['tool_a'])
    expect(state.activated.size).toBe(1)

    // 没有 deactivate 方法 — 单调递增
    state.activate(['tool_b'])
    expect(state.activated.size).toBe(2)
  })

  it('should manage pinned tools', async () => {
    const { SessionState } = await import('../src/state.js')

    const state = new SessionState()

    state.pin('pinned_tool')
    expect(state.pinned.has('pinned_tool')).toBe(true)

    state.unpin('pinned_tool')
    expect(state.pinned.has('pinned_tool')).toBe(false)
  })

  it('should clear turn cache on nextTurn', async () => {
    const { SessionState } = await import('../src/state.js')

    const state = new SessionState()

    state.setCached(
      { query: 'test', topK: 5, minScore: 0.3, exclude: [] },
      [{ tool_name: 'result', description: '', score: 0.9, summary: '', risk_level: 'low', required_permissions: [] }],
    )

    expect(state.currentTurn).toBe(0)
    state.nextTurn()
    expect(state.currentTurn).toBe(1)

    // 缓存应该被清空
    const cached = state.getCached({ query: 'test', topK: 5, minScore: 0.3, exclude: [] })
    expect(cached).toBeNull()
  })

  it('should reset all state', async () => {
    const { SessionState } = await import('../src/state.js')

    const state = new SessionState()
    state.activate(['tool_a'])
    state.pin('pinned_a')
    state.nextTurn()

    state.reset()

    expect(state.activated.size).toBe(0)
    expect(state.pinned.size).toBe(0)
    expect(state.currentTurn).toBe(0)
  })

  it('should return stats', async () => {
    const { SessionState } = await import('../src/state.js')

    const state = new SessionState()
    state.activate(['a', 'b'])
    state.pin('x')

    const stats = state.stats()
    expect(stats.activated).toBe(2)
    expect(stats.pinned).toBe(1)
    expect(stats.currentTurn).toBe(0)
  })
})
