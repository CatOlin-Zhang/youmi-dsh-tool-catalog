/**
 * Indexer — 增量索引协调器
 *
 * 监听 DSH tools 注册表变更，通过 sidecar 增量索引到 Python catalog。
 * 指纹去重在 Python 侧完成，此处仅负责事件驱动 + 批量合并。
 */

import type { Sidecar } from './sidecar.js'
import type { DshToolItem, IndexResult } from './types.js'

export interface IndexerOptions {
  /** 批量索引 debounce 间隔（毫秒，默认 200） */
  debounceMs?: number
  /** 单次批量最大条目数（默认 100） */
  batchSize?: number
}

const DEFAULT_INDEXER_OPTIONS: Required<IndexerOptions> = {
  debounceMs: 200,
  batchSize: 100,
}

/**
 * 增量索引器
 *
 * 收集工具变更事件，debounce 后批量发送给 sidecar。
 */
export class Indexer {
  private _sidecar: Sidecar
  private _options: Required<IndexerOptions>
  private _pending = new Map<string, DshToolItem>()
  private _timer: ReturnType<typeof setTimeout> | null = null
  private _totalIndexed = 0
  private _totalSkipped = 0
  private _totalErrors = 0

  constructor(sidecar: Sidecar, options: IndexerOptions = {}) {
    this._sidecar = sidecar
    this._options = { ...DEFAULT_INDEXER_OPTIONS, ...options }
  }

  /** 累计索引统计 */
  get stats(): { indexed: number; skipped: number; errors: number } {
    return {
      indexed: this._totalIndexed,
      skipped: this._totalSkipped,
      errors: this._totalErrors,
    }
  }

  /**
   * 通知工具变更（新增 / 更新）
   *
   * 调用后不会立即索引，而是加入 pending 队列，debounce 后批量发送。
   */
  notifyChange(item: DshToolItem): void {
    this._pending.set(item.name, item)
    this._scheduleFlush()
  }

  /**
   * 通知多个工具变更
   */
  notifyChanges(items: DshToolItem[]): void {
    for (const item of items) {
      this._pending.set(item.name, item)
    }
    this._scheduleFlush()
  }

  /**
   * 通知工具移除
   */
  async notifyRemove(names: string[]): Promise<void> {
    if (names.length === 0) return
    try {
      await this._sidecar.removeTools(names)
    } catch (err) {
      console.warn('[indexer] remove failed:', err)
    }
  }

  /**
   * 立即 flush pending 队列（跳过 debounce）
   */
  async flush(): Promise<IndexResult | null> {
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
    return this._doFlush()
  }

  private _scheduleFlush(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer)
    }
    this._timer = setTimeout(() => {
      this._timer = null
      this._doFlush().catch(err => {
        console.warn('[indexer] flush failed:', err)
      })
    }, this._options.debounceMs)
  }

  private async _doFlush(): Promise<IndexResult | null> {
    if (this._pending.size === 0) {
      return null
    }

    // 分批发送
    const allItems = Array.from(this._pending.values())
    this._pending.clear()

    let totalResult: IndexResult = { indexed: 0, skipped: 0, errors: 0 }

    for (let i = 0; i < allItems.length; i += this._options.batchSize) {
      const batch = allItems.slice(i, i + this._options.batchSize)
      try {
        const result = await this._sidecar.indexTools(batch)
        totalResult.indexed += result.indexed
        totalResult.skipped += result.skipped
        totalResult.errors += result.errors
      } catch (err) {
        console.warn('[indexer] batch index failed:', err)
        totalResult.errors += batch.length
      }
    }

    // 累计统计
    this._totalIndexed += totalResult.indexed
    this._totalSkipped += totalResult.skipped
    this._totalErrors += totalResult.errors

    return totalResult
  }
}
