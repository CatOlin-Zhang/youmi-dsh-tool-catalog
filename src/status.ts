/**
 * status.ts — 插件健康状态与 `catalog_status` 载荷（T10.3）
 *
 * 设计原则（红线 3）：**只报事实，不粉饰**。
 * - 每个字段都来自可验证来源（sidecar `stats`、launcher 拉起记录、宿主 env）；
 * - 拿不到的信息写 `unknown` + `source` 说明，绝不猜；
 * - 自检失败进 `degraded`，`reason` 直接给修复命令。
 */

import type { SidecarInfo } from './sidecar.js'
import type { CatalogStats } from './types.js'

export type Readiness = 'starting' | 'ready' | 'degraded'
export type SelfCheckState = 'not-run' | 'running' | 'passed' | 'failed'

/** `catalog_status` 的结构化载荷（T10.3.2） */
export interface CatalogStatus {
  ok: boolean
  readiness: Readiness
  sidecar: {
    alive: boolean
    /** 实际拉起命令（解释器 + launcher + 参数） */
    command: string | null
    interpreter: string | null
    interpreterVersion: string | null
    /** 解释器选择理由 / 降级说明 */
    detectReason: string | null
    pid: number | null
    lastError: string | null
  }
  embedder: {
    mode: string | null
    model: string | null
    dimensions: number | null
    loaded: boolean | null
    /** 向量通道是否实际生效（embedMode=real 且模型加载成功） */
    vectorChannel: boolean | null
    error: string | null
    /** 修复命令（仅 embedMode=real 且 embedder 缺失时给出） */
    fix?: string
  }
  catalog: {
    dbPath: string | null
    indexed: number | null
    lastIndexedAt: string | null
    /**
     * 最近一次索引的作用域范围：
     * - `global_only`：只同步了全局视图（启动自检阶段，无 agent 可枚举）
     * - `per_agent`：历史值（F9，索引 ≡ 单 agent 可见集），已废弃不再写入
     * - `union`：索引是各作用域可见集的**并集**（F10.3，只增不删），
     *   检索结果另按当前 scope 过滤，`scopeCount` 记录已知 scope 数
     */
    syncScope: 'global_only' | 'per_agent' | 'union'
    /** 已知作用域数（含全局视图）；F10.3 并集同步的观测指标 */
    scopeCount: number | null
    /**
     * F11 目录形态：`registry` = 注册表目录（无缓存收益可言，工具在请求头里）；
     * `external` = 外部超集（ext_* 不注册不声明，请求头恒定，评测形态）
     */
    catalogMode: 'registry' | 'external'
    /** 已载入的 ext_* 工具数；sidecar 未上报时为 null（不填 0，红线 5） */
    externalCount: number | null
    /** 注册表归属的工具数（指纹总数剔除外部条目）；未上报时为 null */
    registryCount: number | null
  }
  protocol: {
    mode: string
    /** 本插件注册的元工具数（search_tools / invoke / catalog_status） */
    toolsRegistered: number
    /** 注册表全量可见工具数（= 目录应有的规模） */
    registryTools: number
    restrictCalls: number
  }
  dsh: {
    version: string
    profile: string
    /** 版本/ profile 的来源，便于判断是否可信 */
    source: string
  }
  selfCheck: {
    state: SelfCheckState
    /** 已完成的步骤名（spawn / initialize / stats / index_registry） */
    steps: string[]
    startedAt: string | null
    finishedAt: string | null
    durationMs: number | null
    reason: string | null
    /** 自检之外的降级事实（如工具名冲突），逐项列出不互相覆盖 */
    problems: string[]
  }
}

/** embedder 缺失时的修复命令（不静默降级，直接给可执行动作） */
export function embedderFixCommand(interpreter: string | null): string {
  const py = interpreter && interpreter.length > 0 ? interpreter : 'python'
  return `${py} -m pip install sentence-transformers`
}

/**
 * 状态跟踪器：插件生命周期内唯一的健康事实来源。
 *
 * `snapshot()` 会向 sidecar 发一次 `stats`（有 30s 超时保护），
 * 因此 `catalog_status` 调用本身就是一次活性探测。
 */
export class StatusTracker {
  private _readiness: Readiness = 'starting'
  private _selfCheckState: SelfCheckState = 'not-run'
  private _steps: string[] = []
  private _startedAt: string | null = null
  private _finishedAt: string | null = null
  private _durationMs: number | null = null
  private _reason: string | null = null
  private _problems: string[] = []
  private _interpreter: string | null = null
  private _registered = 0
  private _restrictCalls = 0
  private _lastStats: CatalogStats | null = null
  /** 最近一次索引的作用域范围；F10.3 后 per-agent 同步写入 `union`（并集不删） */
  private _syncScope: 'global_only' | 'per_agent' | 'union' = 'global_only'
  /** 已知作用域数（由 snapshot 入参刷新） */
  private _scopeCount: number | null = null

  /** 记录最近一次同步的作用域范围（selfCheck 标 global_only，ensureIndexed 标 union） */
  noteScope(scope: 'global_only' | 'per_agent' | 'union'): void {
    this._syncScope = scope
  }

  get readiness(): Readiness {
    return this._readiness
  }

  get selfCheckState(): SelfCheckState {
    return this._selfCheckState
  }

  /** 最近一次可读的失败/降级原因（search_tools 的 CATALOG_UNAVAILABLE 用它） */
  get reason(): string | null {
    return this._reason
  }

  /**
   * 组合失败文本：自检 reason + 附加 problems，供 snapshot().sidecar.lastError 兜底。
   * 无失败、无 problem 时返回 null。
   */
  get failureText(): string | null {
    const parts: string[] = []
    if (this._reason !== null) parts.push(this._reason)
    for (const p of this._problems) {
      if (!parts.includes(p)) parts.push(p)
    }
    return parts.length > 0 ? parts.join('; ') : null
  }

  /**
   * embedder 缺失时的修复命令（仅 embedMode=real 且侧车报未加载时给出）。
   * 这就是「不静默降级」的落点：失败文本里直接带可执行命令。
   */
  get embedderFix(): string | null {
    const stats = this._lastStats
    if (stats === null) return null
    if (stats.embed_mode !== 'real' || stats.embedder_loaded !== false) return null
    return embedderFixCommand(this._interpreter)
  }

  /** 记录选中的解释器 argv（供 embedder 缺失时拼修复命令） */
  setInterpreter(interpreter: string | null): void {
    this._interpreter = interpreter
  }

  get registeredTools(): number {
    return this._registered
  }

  /**
   * 登记一条降级事实（不覆盖自检原因，也不清 readiness）。
   * 用于「自检成功但工具名被占用」这类并存问题，避免后到的状态抹掉先到的。
   */
  annotate(problem: string): void {
    if (!this._problems.includes(problem)) this._problems.push(problem)
  }

  get problems(): readonly string[] {
    return this._problems
  }

  startSelfCheck(): void {
    this._selfCheckState = 'running'
    this._steps = []
    this._startedAt = new Date().toISOString()
    this._finishedAt = null
    this._durationMs = null
    this._reason = null
  }

  markStep(step: string): void {
    if (!this._steps.includes(step)) this._steps.push(step)
  }

  passSelfCheck(): void {
    this._selfCheckState = 'passed'
    this._readiness = 'ready'
    this._reason = null
    this._finish()
  }

  /** 任一步失败：置 degraded + 记录原因，**不抛错、不阻塞 DSH**（红线 4） */
  failSelfCheck(reason: string): void {
    this._selfCheckState = 'failed'
    this._readiness = 'degraded'
    this._reason = reason
    this._finish()
  }

  private _finish(): void {
    this._finishedAt = new Date().toISOString()
    if (this._startedAt !== null) {
      const ms = Date.parse(this._finishedAt) - Date.parse(this._startedAt)
      this._durationMs = Number.isFinite(ms) ? ms : null
    }
  }

  /** 记录本插件成功注册到注册表的工具数 */
  setRegistered(count: number): void {
    this._registered = count
  }

  /** declare 模式下每调用一次 restrict 记一次（inject 模式恒为 0） */
  noteRestrict(): void {
    this._restrictCalls += 1
  }

  /** 缓存最近一次 stats（snapshot() 拿不到实时数据时兜底） */
  noteStats(stats: CatalogStats): void {
    this._lastStats = stats
  }

  /**
   * 组装一次完整快照。
   *
   * @param sidecarInfo 拉起事实（解释器、pid、lastError）
   * @param stats 实时 stats（sidecar 未就绪时传 null，回退缓存）
   * @param dsh 版本 / profile 探测结果
   * @param registryTools 注册表可见工具数
   * @param knownScopes 已知作用域数（F10.3 并集同步观测，可选）
   * @param embedMode 配置的向量通道模式
   * @param presentationMode 配置的呈现模式（inject / declare）
   * @param catalogMode F11 目录形态（registry / external）
   */
  snapshot(args: {
    sidecarInfo: SidecarInfo | null
    stats: CatalogStats | null
    dsh: { version: string; profile: string; source: string }
    registryTools: number
    knownScopes?: number
    embedMode: 'real' | 'keyword'
    presentationMode: 'inject' | 'declare'
    catalogMode?: 'registry' | 'external'
  }): CatalogStatus {
    const stats = args.stats ?? this._lastStats
    const info = args.sidecarInfo
    if (typeof args.knownScopes === 'number') this._scopeCount = args.knownScopes
    const alive = args.stats !== null || (info?.pid != null && this._readiness === 'ready')
    const loaded = stats ? stats.embedder_loaded ?? null : null
    const embedError = stats?.embedder_error ?? null
    const needsFix = args.embedMode === 'real' && stats !== null && loaded === false

    return {
      ok: this._readiness === 'ready',
      readiness: this._readiness,
      sidecar: {
        alive,
        command: info?.command ?? null,
        interpreter: info?.interpreter ?? null,
        interpreterVersion: info?.interpreterVersion ?? null,
        detectReason: info?.detectReason ?? null,
        pid: info?.pid ?? null,
        lastError: info?.lastError ?? this.failureText,
      },
      embedder: {
        mode: stats?.embed_mode ?? args.embedMode,
        model: stats?.embed_model ?? null,
        dimensions: stats?.embedder_dimensions ?? null,
        loaded,
        vectorChannel: stats?.vector_channel ?? null,
        error: embedError,
        ...(needsFix ? { fix: embedderFixCommand(info?.interpreter ?? null) } : {}),
      },
      catalog: {
        dbPath: stats?.db_path ?? null,
        indexed: stats?.fingerprints ?? null,
        lastIndexedAt: stats?.last_indexed_at ?? null,
        syncScope: this._syncScope,
        scopeCount: this._scopeCount,
        catalogMode: args.catalogMode ?? 'registry',
        externalCount: stats?.external_count ?? null,
        registryCount: stats?.registry_count ?? null,
      },
      protocol: {
        mode: args.presentationMode,
        toolsRegistered: this._registered,
        registryTools: args.registryTools,
        restrictCalls: this._restrictCalls,
      },
      dsh: {
        version: args.dsh.version,
        profile: args.dsh.profile,
        source: args.dsh.source,
      },
      selfCheck: {
        state: this._selfCheckState,
        steps: [...this._steps],
        startedAt: this._startedAt,
        finishedAt: this._finishedAt,
        durationMs: this._durationMs,
        reason: this._reason,
        problems: [...this._problems],
      },
    } satisfies CatalogStatus
  }
}

/** `catalog_status` 的人类可读一行摘要（结构化 JSON 之外给人看的） */
export function summarizeStatus(status: CatalogStatus): string {
  const { sidecar, embedder, catalog, selfCheck } = status
  const parts = [
    `readiness=${status.ok ? 'ready' : status.readiness}`,
    `sidecar=${sidecar.alive ? `alive(pid=${sidecar.pid ?? '?'})` : 'down'}`,
    `interpreter=${sidecar.interpreter ?? 'unknown'}`,
    `embed=${embedder.mode}/${embedder.loaded === true ? 'loaded' : 'not-loaded'}`,
    `indexed=${catalog.indexed ?? '?'}`,
    `registry=${status.protocol.registryTools}`,
  ]
  // F11：external 形态是评测前提，摘要里把形态与 ext_* 规模显式带出来，
  // 避免把外部目录的载入数误读成注册表规模。
  if (catalog.catalogMode === 'external') {
    parts.push(`mode=external(ext=${catalog.externalCount ?? '?'},registry=${catalog.registryCount ?? '?'})`)
  }
  if (selfCheck.state === 'failed' && selfCheck.reason !== null) {
    parts.push(`reason=${selfCheck.reason}`)
  }
  return parts.join(' | ')
}
