/**
 * State — session 级 activated + turnCache
 *
 * 管理单个 session 的生命周期状态:
 * - activated 集（单调递增）
 * - pinned 集（配置驱动）
 * - turn 级结果缓存（同 turn 相同查询不重复检索）
 */

import type { ActivatedSet, PinnedSet, TurnCacheKey, TurnCacheEntry, SearchResult } from './types.js'

export interface StateOptions {
  /** turn 缓存 TTL（毫秒，默认 30000） */
  turnCacheTtlMs?: number
}

const DEFAULT_STATE_OPTIONS: Required<StateOptions> = {
  turnCacheTtlMs: 30_000,
}

/**
 * Session 级状态管理器
 */
export class SessionState {
  private _options: Required<StateOptions>
  private _activated: ActivatedSet = new Set()
  private _pinned: PinnedSet = new Set()
  private _turnCache = new Map<string, TurnCacheEntry>()
  private _currentTurn = 0

  constructor(options: StateOptions = {}) {
    this._options = { ...DEFAULT_STATE_OPTIONS, ...options }
  }

  // -- activated 集 --

  /** 获取当前激活集（只读视图） */
  get activated(): Readonly<ActivatedSet> {
    return this._activated
  }

  /** 激活工具（单调递增，不会移除） */
  activate(names: string[]): void {
    for (const name of names) {
      this._activated.add(name)
    }
  }

  /** 检查工具是否已激活 */
  isActivated(name: string): boolean {
    return this._activated.has(name)
  }

  // -- pinned 集 --

  /** 获取 pinned 集（只读视图） */
  get pinned(): Readonly<PinnedSet> {
    return this._pinned
  }

  /** 设置 pinned 工具 */
  setPinned(names: string[]): void {
    this._pinned = new Set(names)
  }

  /** 添加工具到 pinned */
  pin(name: string): void {
    this._pinned.add(name)
  }

  /** 从 pinned 移除工具 */
  unpin(name: string): void {
    this._pinned.delete(name)
  }

  // -- turn 管理 --

  /** 推进到下一个 turn（清空 turn 缓存） */
  nextTurn(): void {
    this._currentTurn++
    this._turnCache.clear()
  }

  /** 当前 turn 编号 */
  get currentTurn(): number {
    return this._currentTurn
  }

  // -- turn 缓存 --

  /** 生成缓存 key */
  private _cacheKey(key: TurnCacheKey): string {
    return JSON.stringify({
      q: key.query,
      k: key.topK,
      s: key.minScore,
      e: key.exclude.sort(),
    })
  }

  /** 查询 turn 缓存 */
  getCached(key: TurnCacheKey): SearchResult[] | null {
    const k = this._cacheKey(key)
    const entry = this._turnCache.get(k)
    if (!entry) return null

    // 检查 TTL
    if (Date.now() - entry.timestamp > this._options.turnCacheTtlMs) {
      this._turnCache.delete(k)
      return null
    }

    return entry.results
  }

  /** 写入 turn 缓存 */
  setCached(key: TurnCacheKey, results: SearchResult[]): void {
    const k = this._cacheKey(key)
    this._turnCache.set(k, {
      results,
      timestamp: Date.now(),
    })
  }

  // -- 统计 --

  /** 返回状态摘要 */
  stats(): {
    activated: number
    pinned: number
    turnCacheSize: number
    currentTurn: number
  } {
    return {
      activated: this._activated.size,
      pinned: this._pinned.size,
      turnCacheSize: this._turnCache.size,
      currentTurn: this._currentTurn,
    }
  }

  /** 重置状态（新 session） */
  reset(): void {
    this._activated.clear()
    this._pinned.clear()
    this._turnCache.clear()
    this._currentTurn = 0
  }
}
