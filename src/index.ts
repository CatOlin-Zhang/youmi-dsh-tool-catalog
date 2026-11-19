/**
 * YouMi Tool Catalog Plugin — DSH 插件入口
 *
 * 将 YouMi 的向量检索 / 按需呈现方案接入 DSH:
 * - 监听 tools 注册表变更 → 增量索引到 Python catalog
 * - 提供 search_tools 工具 → Agent 主动检索
 * - 维护 session 状态 → activated + pinned + turnCache
 * - 选择器纯函数 → pinned ∪ activated ∪ search 合并呈现
 *
 * 用法::
 *
 *     import { YoumiCatalogPlugin } from '@youmi/dsh-tool-catalog'
 *
 *     const plugin = new YoumiCatalogPlugin({ dbPath: '.youmi/dsh-tools.db' })
 *     await plugin.start()
 *
 *     // 索引工具
 *     plugin.indexTool({ name: 'read_file', description: '读取文件' })
 *
 *     // 检索（F10：返回 { results, cappedAt }，top_k 是硬上限）
 *     const { results } = await plugin.search('读取文件')
 */

import { Sidecar } from './sidecar.js'
import type { ExternalToolEntry } from './sidecar.js'
import { Indexer } from './indexer.js'
import { SessionState } from './state.js'
import { selectTools, diffActivated } from './selector.js'
import { formatSearchResults, getSearchToolSchema } from './search-tool.js'
import { createInvokeTool, buildInvokeDeps } from './invoke-tool.js'
import type { DshToolsLike, InvokeDeps, InvokeToolDefinition } from './invoke-tool.js'
import { StatusTracker } from './status.js'
import type { CatalogStatus } from './status.js'
import { detectDshInfo, defaultDbPath } from './dsh-info.js'
import { buildSearchDefinition, buildInvokeToolDefinition, buildStatusDefinition, OWN_TOOL_NAMES } from './plugin-tools.js'
import type { CatalogApi } from './plugin-tools.js'
import { dispatchExternal } from './external.js'
import type { ContentBlock, ToolDefinition, ToolsService, ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import type { Context, StandardSchemaV1 } from '@deepseek-ai/cordis'
import { DEFAULT_CONFIG } from './types.js'
import type { YoumiCatalogConfig, DshToolItem, DshToolParameter, SearchResult, IndexResult, CatalogStats } from './types.js'

export { Sidecar } from './sidecar.js'
export { Indexer } from './indexer.js'
export { SessionState } from './state.js'
export { selectTools, extractToolNames, diffActivated } from './selector.js'
export { formatSearchResults, renderSignature, getSearchToolSchema } from './search-tool.js'
export { StatusTracker, summarizeStatus, embedderFixCommand } from './status.js'
export type { CatalogStatus, Readiness, SelfCheckState } from './status.js'
export { detectDshInfo, defaultDbPath } from './dsh-info.js'
export type { DshInfo } from './dsh-info.js'
export {
  candidateInterpreters,
  detectInterpreter,
  probeInterpreter,
  toArgv,
} from './detect.js'
export type { DetectResult, InterpreterProbe } from './detect.js'
export {
  buildSearchDefinition,
  buildInvokeToolDefinition,
  buildInvokeDefinition,
  buildStatusDefinition,
  unavailableText,
  SEARCH_TOOL_NAME,
  INVOKE_TOOL_NAME,
  STATUS_TOOL_NAME,
  OWN_TOOL_NAMES,
} from './plugin-tools.js'
export type { CatalogApi } from './plugin-tools.js'
export {
  createInvokeTool,
  buildInvokeDeps,
  dispatchInvoke,
  signatureFor,
  validateAgainstSchema,
  suggestNames,
  editDistance,
} from './invoke-tool.js'
export type {
  DshToolsLike,
  InvokeDeps,
  InvokeToolDefinition,
  InvokableToolDef,
  InvokeOutcome,
  InvokeExecContext,
} from './invoke-tool.js'
export {
  dispatchExternal,
  mockExecute,
  schemaFromEntry,
  signatureForEntry,
  briefsFromEntry,
  MOCK_EXECUTOR_NOTE,
  EXECUTOR_UNAVAILABLE,
} from './external.js'
export type { ExternalInvokeDeps } from './external.js'
export type { ExternalToolEntry, ExternalToolParam } from './sidecar.js'
export type {
  YoumiCatalogConfig,
  DshToolItem,
  DshToolParameter,
  SearchResult,
  SearchParamBrief,
  IndexResult,
  CatalogStats,
} from './types.js'
export type { SelectorOptions } from './selector.js'
export type { StateOptions } from './state.js'
export type { IndexerOptions } from './indexer.js'

/** JSON Schema 根 → sidecar 需要的参数简视图（与 Python `_param_brief` 对齐） */
function paramsFromSchema(schema: Record<string, unknown> | undefined): DshToolParameter[] {
  const props = schema?.properties
  if (props === null || typeof props !== 'object') return []
  const required = new Set(
    Array.isArray(schema?.required) ? (schema.required as unknown[]).map(String) : [],
  )
  return Object.entries(props as Record<string, Record<string, unknown>>).map(([name, p]) => ({
    name,
    type: typeof p.type === 'string' ? p.type : 'json',
    description: typeof p.description === 'string' ? p.description : undefined,
    required: required.has(name),
    ...(Array.isArray(p.enum) ? { enum: p.enum.filter((v): v is string => typeof v === 'string') } : {}),
  }))
}

/** 取描述首句作为 summary（与 search-tool.ts 的 oneSentence 同规则） */
function summaryOf(description: string): string {
  const match = /^[^.!?]*[.!?]?/.exec(description.trim())
  const body = (match ? match[0] : description).replace(/[.!?]$/, '').trim()
  const text = body.length > 0 ? body : description.trim()
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/**
 * 全局作用域哨兵：`ensureIndexed` / `_scopeEpochs` 用它代表「无 agent 的全局视图」。
 * ScopeKey（agent 对象）不可序列化，因此按对象引用记录新鲜度（F9.1.3）；
 * 全局同步没有 agent，用这个进程内唯一 symbol 兜底。
 */
const GLOBAL_SCOPE: unique symbol = Symbol('youmi-tool-catalog:global-scope')

/**
 * YouMi Tool Catalog Plugin 主类
 *
 * 封装 sidecar + indexer + state，提供统一 API。
 *
 * 核心不变量（F9.3，D9）：**检索视野 ≡ 派发视野**。
 * 同一 scope 下 `search_tools` 能返回的工具集合，必须等于 `invoke` 能成功
 * 派发的工具集合。落地（F10.3 后）：
 * - 索引侧是**并集**：`syncRegistry` 只增不删（F10.3 第 1 层），删除只在
 *   全局视图（启动对账）确认工具彻底消失时执行，作用域之间切换不再抖动；
 * - 检索侧按当前 scope 过滤（F10.3 第 2 层）：`search_tools` 返回前用
 *   `definitions(scope)` 的可见集裁剪结果，视野 ≡ 派发视野由过滤保证，
 *   不再由“索引恰好只含可见集”保证；
 * - `invoke` 的 `UNKNOWN_TOOL` vs `NOT_ADMITTED` 依据「当前 scope 可见集」区分。
 */
export class YoumiCatalogPlugin implements CatalogApi {
  private _sidecar: Sidecar
  private _indexer: Indexer
  private _state: SessionState
  private _config: YoumiCatalogConfig
  /** 目录内工具名缓存（invoke 拼写建议候选池），search 命中与显式刷新时更新 */
  private _catalogNames = new Set<string>()
  /**
   * F11.2：`catalogMode=external` 时载入的外部目录工具名（`ext_*`）。
   * registry 模式恒为空。检索侧的 exclude 裁剪必须保留这些名字——它们永远
   * 不在注册表可见集里，但它们**可派发**，删掉就破坏「检索视野 ≡ 派发视野」。
   */
  private _externalNames = new Set<string>()
  /** F11.2：外部条目 `get_tool` 回读缓存（sidecar 重启/重载入时失效） */
  private _externalEntries = new Map<string, ExternalToolEntry | null>()
  /** 健康状态（T10.3）：自检结果 + catalog_status 载荷的唯一来源 */
  private _status = new StatusTracker()
  /** DSH `ctx.tools`（注册表读 + 转发），由 apply() 注入 */
  private _tools: ToolsService | null = null
  /** 日志器（由 apply() 注入；单测下缺省用 console） */
  private _log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } | null = null
  /** 不索引进目录的工具名（插件自身元工具等，避免自我检索） */
  private _exclude: Set<string>
  /**
   * 每个 scope（agent 对象 / GLOBAL_SCOPE 哨兵）最近一次成功同步时的 epoch。
   * 与 `_syncEpoch` 相等 → 该 scope 目录新鲜；否则标脏，下个检索请求重扫（F9.2.3）。
   */
  private _scopeEpochs = new Map<unknown, number>()
  /** 全局脏标记：`tools/change` 时自增，使所有 scope 的新鲜度失效 */
  private _syncEpoch = 0
  /**
   * 每个已索引名字的“归属视图”（F10.3）：`global` = 曾在全局视图（无 scope）
   * 出现过，`agent` = 只在某个 agent 作用域出现过。删除只对 `global` 归属
   * 的名字生效——agent 视野里看不到某个工具 ≠ 它从注册表彻底消失。
   */
  private _toolOrigins = new Map<string, 'global' | 'agent'>()
  /** 已知作用域计数（F10.3，含 GLOBAL_SCOPE）：catalog_status.catalog.scopeCount */
  private readonly _knownScopes = new Set<unknown>()
  /** 同一 scope 并发检索共享的在飞同步 promise（避免重复索引） */
  private _syncInFlight = new Map<unknown, Promise<void>>()

  constructor(config: YoumiCatalogConfig = {}, excludeNames: Iterable<string> = []) {
    this._config = config
    this._sidecar = new Sidecar(config)
    this._indexer = new Indexer(this._sidecar)
    this._state = new SessionState()
    this._exclude = new Set(excludeNames)
  }

  /** 健康状态跟踪器（plugin-tools 读 readiness / reason） */
  get status(): StatusTracker {
    return this._status
  }

  /** 注入 DSH 注册表服务与日志器（`apply()` 里调用） */
  attach(
    tools: ToolsService,
    log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  ): void {
    this._tools = tools
    if (log !== undefined) this._log = log
  }

  private _info(message: string): void {
    if (this._log !== null) this._log.info(message)
    else console.info(`[youmi-tool-catalog] ${message}`)
  }

  private _warn(message: string): void {
    if (this._log !== null) this._log.warn(message)
    else console.warn(`[youmi-tool-catalog] ${message}`)
  }

  /** sidecar 是否就绪 */
  get ready(): boolean {
    return this._sidecar.ready
  }

  /** 获取 session 状态 */
  get state(): SessionState {
    return this._state
  }

  /** 获取 indexer */
  get indexer(): Indexer {
    return this._indexer
  }

  // -- 生命周期 --

  /** 启动插件（spawn sidecar） */
  async start(): Promise<void> {
    await this._sidecar.start()
  }

  /** 停止插件 */
  async stop(): Promise<void> {
    await this._sidecar.stop()
  }

  // -- 索引 --

  /** 索引单个工具 */
  indexTool(item: DshToolItem): void {
    this._catalogNames.add(item.name)
    this._indexer.notifyChange(item)
  }

  /** 批量索引工具 */
  indexTools(items: DshToolItem[]): void {
    for (const item of items) this._catalogNames.add(item.name)
    this._indexer.notifyChanges(items)
  }

  /** 立即 flush 索引队列 */
  async flushIndex(): Promise<IndexResult | null> {
    return this._indexer.flush()
  }

  /** 移除工具 */
  async removeTools(names: string[]): Promise<void> {
    for (const name of names) this._catalogNames.delete(name)
    await this._indexer.notifyRemove(names)
  }

  /** 从 sidecar 刷新目录名缓存（invoke 拼写建议候选池） */
  async refreshToolNames(): Promise<void> {
    const names = await this._sidecar.listToolNames()
    this._catalogNames = new Set(names)
    for (const n of names) {
      // 与启动对账同理：外部刷新不带视图信息，新出现的名字保守标 `agent`
      if (!this._toolOrigins.has(n)) this._toolOrigins.set(n, 'agent')
    }
  }

  // -- 检索 --

  /**
   * 搜索工具（带 turn 缓存；F10.2 尊重 top_k，F10.3 按 scope 过滤）
   *
   * @param query - 自然语言查询
   * @param topK - 返回数量（硬上限；超过 maxTopK 按 maxTopK 处理并在结果里标注）
   * @param minScore - 最低分数
   * @param opts - scope 可见集过滤（F10.3 第 2 层）：传入调用方 agent / toolSet
   *   时，用其可见集对结果做真正裁剪（不是只记日志）
   * @returns 搜索结果 + 是否被 maxTopK 封顶
   */
  async search(
    query: string,
    topK?: number,
    minScore?: number,
    opts?: { scope?: unknown; toolSet?: ResolvedToolSet },
  ): Promise<{ results: SearchResult[]; cappedAt: number | null }> {
    const requestedTopK = Math.max(1, Math.round(topK ?? this._config.defaultTopK ?? 5))
    const cap = this._config.maxTopK ?? DEFAULT_CONFIG.maxTopK
    const effectiveTopK = Math.min(requestedTopK, cap)
    const cappedAt = requestedTopK > cap ? cap : null

    // F10.3 第 2 层：当前 scope 看不见的工具不进检索结果（并集索引 → exclude 裁剪）
    let exclude: string[] = []
    if (opts !== undefined && this._tools !== null && this._sidecar.ready) {
      const visible = new Set<string>(
        this._tools.definitions(opts.scope, opts.toolSet).map(def => def.name),
      )
      // F11.2：ext_* 永远不在注册表可见集里（红线 3：请求头不得出现 ext_*），
      // 但它们可派发——exclude 裁剪必须保留它们，否则检索视野 ⊂ 派发视野。
      exclude = [...this._catalogNames]
        .filter(name => !visible.has(name) && !this._externalNames.has(name))
        .sort()
    }

    // 检查 turn 缓存
    const cacheKey = {
      query,
      topK: effectiveTopK,
      minScore: minScore ?? this._config.defaultMinScore ?? 0.3,
      exclude,
    }
    const cached = this._state.getCached(cacheKey)
    if (cached !== null) {
      return { results: cached, cappedAt }
    }

    // 调用 sidecar
    const results = await this._sidecar.search(
      query,
      cacheKey.topK,
      cacheKey.minScore,
      exclude,
    )

    // 写入缓存
    this._state.setCached(cacheKey, results)
    for (const r of results) {
      this._catalogNames.add(r.tool_name)
    }

    // 兼容性兜底：即使 sidecar 端未升级，返回条数也不越过请求的 top_k
    const clipped = results.length > effectiveTopK ? results.slice(0, effectiveTopK) : results
    return { results: clipped, cappedAt }
  }

  /**
   * 搜索并选择工具（合并 pinned + activated + results）
   *
   * @param query - 自然语言查询
   * @param topK - 返回数量
   * @returns 选中的工具名列表
   */
  async selectTools(query: string, topK?: number): Promise<string[]> {
    const { results } = await this.search(query, topK)

    // 计算需要新激活的工具
    const toActivate = diffActivated(results, this._state.activated)
    this._state.activate(toActivate)

    // 合并选择
    return selectTools(
      results,
      this._state.pinned,
      this._state.activated,
      { maxResults: topK },
    )
  }

  // -- 状态管理 --

  /** 推进到下一个 turn（清空缓存） */
  nextTurn(): void {
    this._state.nextTurn()
  }

  /** 设置 pinned 工具 */
  setPinned(names: string[]): void {
    this._state.setPinned(names)
  }

  /** 激活工具 */
  activate(names: string[]): void {
    this._state.activate(names)
  }

  // -- 可见性同步（T5） --

  /**
   * 按配置 mode 同步注册表可见性。
   *
   * - `inject`（默认）：**空操作**——激活只更新 SessionState，不调 restrict、
   *   不改注册表，请求头恒定（缓存不变量 1）
   * - `declare`（A/B 对照）：对未激活且未 pinned 的注册表工具执行
   *   `restrict({ deny })`，复现旧行为。restrict 必须在 agent 作用域调用
   *   （全局调用抛错，见 docs/notes/dsh-capability-probe.md）
   *
   * @param target - DSH `ctx.tools`（agent.ctx 作用域）的 restrict 入口
   * @param registryNames - 当前注册表全量工具名
   * @returns 是否实际调用了 restrict（inject 模式恒为 false）
   */
  syncVisibility(
    target: { restrict(restriction: { allow?: readonly string[]; deny?: readonly string[] }): unknown },
    registryNames: Iterable<string>,
  ): boolean {
    if ((this._config.mode ?? 'inject') !== 'declare') {
      return false
    }
    const deny = [...registryNames].filter(
      name => !this._state.activated.has(name) && !this._state.pinned.has(name),
    )
    target.restrict({ deny })
    this._status.noteRestrict()
    return true
  }

  // -- 诊断 --

  /** 获取统计信息 */
  async stats(): Promise<{
    catalog: CatalogStats
    indexer: { indexed: number; skipped: number; errors: number }
    state: {
      activated: number
      pinned: number
      turnCacheSize: number
      currentTurn: number
    }
  }> {
    const [catalog, state] = await Promise.all([
      this._sidecar.stats(),
      Promise.resolve(this._state.stats()),
    ])

    return {
      catalog,
      indexer: this._indexer.stats,
      state,
    }
  }

  /** 格式化搜索结果为文本 */
  formatResults(results: SearchResult[], catalogTotal?: number): string {
    return formatSearchResults(results, catalogTotal)
  }

  /** 获取 search_tools 工具 schema */
  getSearchToolSchema() {
    return getSearchToolSchema()
  }

  // -- invoke 元工具（T4，路径 B 核心） --

  /**
   * 构造 invoke 依赖：把 DSH `ctx.tools` 适配到本插件的目录名缓存。
   *
   * @param tools - DSH 的 `ctx.tools`（ToolRuntime 的 get/execute 子集）
   */
  buildInvokeDeps(tools: DshToolsLike): InvokeDeps {
    return buildInvokeDeps(tools, {
      has: name => this._catalogNames.has(name),
      names: () => this._catalogNames,
    })
  }

  /**
   * 构造 DSH 注册表就绪的 `invoke` 工具定义。
   * 用法（在 agent 作用域）：`ctx.tools.register(plugin.buildInvokeTool(ctx.tools))`
   */
  buildInvokeTool(tools: DshToolsLike): InvokeToolDefinition {
    return createInvokeTool(this.buildInvokeDeps(tools))
  }

  // -- 外部目录派发（F11.2，catalogMode=external） --

  /** 名字是否属于外部目录（`ext_*`）；registry 模式恒为 false */
  isExternalTool(toolName: string): boolean {
    return this._externalNames.has(toolName)
  }

  /** 外部目录工具名集合（只读快照；registry 模式恒为空集） */
  get externalToolNames(): ReadonlySet<string> {
    return this._externalNames
  }

  /** 当前生效的目录形态（catalog_status / 报告口径用） */
  get catalogMode(): 'registry' | 'external' {
    return this._config.catalogMode ?? 'registry'
  }

  /**
   * 把一次 `invoke` 派发到外部工具：sidecar `get_tool` 回读条目 → schema 校验
   * → `externalExecutor` 执行（mock 为评测期唯一实现，F11.2）。
   *
   * 失败语义与注册表路径一致：`UNKNOWN_TOOL` / `INVALID_ARGS` /（executor=mcp
   * 未实现时）`EXECUTOR_UNAVAILABLE`。ext_* 不进注册表、不发 restrict，
   * 请求头里永远看不到它们（红线 3）。
   */
  async invokeExternal(toolName: string, rawArgs: unknown): Promise<string> {
    return dispatchExternal(toolName, rawArgs, {
      getEntry: async name => {
        if (this._externalEntries.has(name)) return this._externalEntries.get(name) ?? null
        const entry = await this._sidecar.getTool(name)
        this._externalEntries.set(name, entry)
        return entry
      },
      executor: () => this._config.externalExecutor ?? 'mock',
      // 拼写建议候选池：外部条目名也在 _catalogNames 里（list_tool_names 返回全量）
      knownNames: () => this._catalogNames,
    })
  }

  // -- 注册表同步（T10.1：把 DSH 可见工具增量索引进目录） --

  /**
   * 全量对账一次注册表：新增/变更走指纹增量索引。
   *
   * F10.3 第 1 层：**带 scope 的同步只增不删**——某 agent 视野里看不到某个
   * 工具（未开 Team Mode 看不到 `team_task_*`）不等于它从注册表消失，早期
   * 实现据此删除会让索引在作用域之间抖动、embedding 反复重算。删除只在
   * 全局视图（`scope` 省略）且 `removeMissing` 显式打开时执行（启动对账）。
   *
   * sidecar 侧按指纹去重，重复调用只会 skipped；插件自身的元工具
   * （search_tools / invoke / catalog_status）不进了目录，避免自我检索。
   *
   * F9.1：枚举按作用域参数化——`scope` 传入 agent 时取其可见集（含内置工具），
   * 省略时保持全局视图行为（向后兼容）。`definitions(scope)` 的语义由 DSH
   * 宿主保证；本插件只负责把 scope 透传下去，**不硬编码工具名**（红线 1）。
   */
  async syncRegistry(
    scope?: unknown,
    toolSet?: ResolvedToolSet,
    opts?: { removeMissing?: boolean },
  ): Promise<IndexResult> {
    const tools = this._tools
    if (tools === null) throw new Error('plugin not attached to ctx.tools')
    if (!this._sidecar.ready) throw new Error('sidecar not ready')

    const isGlobalScope = scope === undefined
    const defs = tools.definitions(scope, toolSet)
    const items: DshToolItem[] = []
    const current = new Set<string>()
    for (const def of defs) {
      if (this._exclude.has(def.name)) continue
      current.add(def.name)
      items.push({
        name: def.name,
        description: def.description,
        summary: summaryOf(def.description),
        parameters: paramsFromSchema(def.parameters),
      })
    }

    // 只增不删（F10.3）：仅全局对账时回收“上次在全局视图里、这次消失”的名字
    if (isGlobalScope && opts?.removeMissing === true) {
      const justIndexed = new Set(items.map(item => item.name))
      const removed = [...this._catalogNames].filter(name =>
        !current.has(name) && !justIndexed.has(name)
        && !this._exclude.has(name) && this._toolOrigins.get(name) === 'global',
      )
      if (removed.length > 0) {
        try {
          await this._sidecar.removeTools(removed)
          for (const name of removed) {
            this._catalogNames.delete(name)
            this._toolOrigins.delete(name)
          }
        } catch (err) {
          this._warn(`catalog remove failed for ${removed.length} tool(s): ${String(err)}`)
        }
      }
    }

    const total: IndexResult = { indexed: 0, skipped: 0, errors: 0 }
    const BATCH = 100
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH)
      try {
        const r = await this._sidecar.indexTools(batch)
        total.indexed += r.indexed
        total.skipped += r.skipped
        total.errors += r.errors
        for (const item of batch) {
          this._catalogNames.add(item.name)
          // 归属记录：agent 视图不给“全局”身份降级；全局视图见到即升为全局
          if (isGlobalScope) this._toolOrigins.set(item.name, 'global')
          else if (!this._toolOrigins.has(item.name)) this._toolOrigins.set(item.name, 'agent')
        }
      } catch (err) {
        total.errors += batch.length
        this._warn(`batch index failed (${batch.length} tools): ${String(err)}`)
      }
    }
    return total
  }

  /**
   * `tools/change` 入口：只标脏，不立刻全扫（F9.2.3）。
   *
   * 注册表变更不带细节，无法判断影响了哪些 scope；把全局 epoch 自增使所有
   * scope 的新鲜度失效，下一个检索请求经 `ensureIndexed` 按自己的 scope 重扫。
   */
  onRegistryChanged(): void {
    this._syncEpoch += 1
  }

  /**
   * 按需把某个作用域的工具补索引（F9.2 关键）。
   *
   * 由 `search_tools` / `invoke` / `catalog_status` 的 execute 在派发前调用，
   * 传入 `exec.agent`：
   * - 该 scope 已同步且未标脏 → 直接返回（廉价）；
   * - 否则 `syncRegistry(agent)`；首次会多花几秒 embed 增量工具，之后靠幂等 skipped。
   *
   * fail-open（红线 3）：同步失败**不抛出**，只记日志；检索照常返回旧目录或
   * `CATALOG_UNAVAILABLE`，绝不让 `search_tools` 因补索引失败而崩。
   */
  async ensureIndexed(scope?: unknown, toolSet?: ResolvedToolSet): Promise<void> {
    if (this._tools === null || !this._sidecar.ready) return
    const key = scope ?? GLOBAL_SCOPE
    this._knownScopes.add(key)
    if (this._scopeEpochs.get(key) === this._syncEpoch) return
    const inFlight = this._syncInFlight.get(key)
    if (inFlight !== undefined) {
      await inFlight
      return
    }
    const pending = (async () => {
      try {
        await this.syncRegistry(scope, toolSet)
        this._scopeEpochs.set(key, this._syncEpoch)
        // F10.3：索引是作用域可见集的并集（只增不删），可见性由检索侧过滤保证
        this._status.noteScope('union')
      } catch (err) {
        this._warn(`ensureIndexed failed (fail-open, search unaffected): ${String(err)}`)
      } finally {
        this._syncInFlight.delete(key)
      }
    })()
    this._syncInFlight.set(key, pending)
    await pending
  }

  /** 注册表当前可见工具数（catalog_status.protocol.registryTools）；按 scope 取可见集 */
  registryToolCount(scope?: unknown, toolSet?: ResolvedToolSet): number {
    return this._tools?.definitions(scope, toolSet).length ?? 0
  }

  /** 已知作用域数（含全局视图哨兵）：catalog_status.catalog.scopeCount */
  get knownScopeCount(): number {
    return this._knownScopes.size
  }

  // -- CatalogApi（plugin-tools 需要的能力面） --

  /** 目录内工具总数（search 结果尾部的 "/ N in catalog"） */
  indexedCount(): number {
    return this._catalogNames.size
  }

  /** invoke 转发依赖（必须已 attach ctx.tools） */
  invokeDeps(): InvokeDeps {
    const tools = this._tools
    if (tools === null) throw new Error('plugin not attached to ctx.tools')
    return this.buildInvokeDeps(tools as unknown as DshToolsLike)
  }

  /**
   * 组装 catalog_status 快照（T10.3.2）。
   *
   * sidecar 活着时会现发一次 `stats` —— 这本身就是活性探测；拉不到就用
   * 上一次缓存并标记来源，不编造实时数据。
   */
  async statusSnapshot(scope?: unknown, toolSet?: ResolvedToolSet): Promise<CatalogStatus> {
    let stats: CatalogStats | null = null
    if (this._sidecar.ready) {
      try {
        stats = await this._sidecar.stats()
      } catch (err) {
        this._warn(`stats failed: ${String(err)}`)
      }
    }
    if (stats !== null) this._status.noteStats(stats)
    const dsh = detectDshInfo()
    return this._status.snapshot({
      sidecarInfo: this._sidecar.info,
      stats,
      dsh,
      registryTools: this.registryToolCount(scope, toolSet),
      knownScopes: this._knownScopes.size,
      embedMode: this._config.embedMode ?? 'real',
      presentationMode: this._config.mode ?? 'inject',
      catalogMode: this.catalogMode,
    })
  }

  // -- 启动自检（T10.3.1） --

  /**
   * 依次：spawn sidecar → initialize → stats → 全量索引注册表 → 刷新名字缓存。
   *
   * 任一步失败 → `degraded` + 原因（**不阻塞 DSH**，红线 4）；
   * `failOpen=false` 时重新抛出（只给单测用）。
   */
  async selfCheck(): Promise<{ ok: boolean; indexed: number; reason: string | null }> {
    if (this._selfChecking) {
      return { ok: this._status.readiness === 'ready', indexed: this._catalogNames.size, reason: this._status.reason }
    }
    this._selfChecking = true
    this._status.startSelfCheck()
    let indexed = 0
    try {
      await this._sidecar.start()
      this._status.markStep('spawn+initialize')
      this._status.setInterpreter(this._sidecar.info.interpreter)

      const stats = await this._sidecar.stats()
      this._status.noteStats(stats)
      this._status.markStep('stats')

      const res = await this.syncRegistry(undefined, undefined, { removeMissing: true })
      // 启动自检无 agent 可枚举 → 只同步了全局视图；标位供 catalog_status 区分
      // “已按 scope 补全”（F9.1.4），不因此判定失败。全局对账也是唯一允许
      // 删除的通道（F10.3）：只有全局视图确认消失的工具才从目录回收。
      this._status.noteScope('global_only')
      this._status.markStep('index_registry')
      indexed = res.indexed + res.skipped

      const names = await this._sidecar.listToolNames()
      this._catalogNames = new Set(names)
      for (const n of names) {
        // 启动时持久库里已有的名字：无法判断历史归属，保守标 `agent`（永不被
        // 自动删除）；后续任一次同步在对应视图里重新观察到都会升级归属。
        if (!this._toolOrigins.has(n)) this._toolOrigins.set(n, 'agent')
      }
      this._status.markStep('list_tool_names')

      // F11.1/F11.2：external 形态下回读外部目录名单，供检索保留 ext_* 与
      // invoke 拦截派发；同时作废条目缓存（重启 sidecar 后以新库为准）。
      if (this.catalogMode === 'external') {
        this._externalNames = new Set(await this._sidecar.listExternalNames())
        this._externalEntries.clear()
        this._status.markStep('list_external_names')
      }

      this._status.passSelfCheck()
      const summary = `self-check ok: indexed=${indexed} catalog=${this._catalogNames.size} `
        + `interpreter=${this._sidecar.info.interpreter ?? 'unknown'} `
        + `embedMode=${stats.embed_mode ?? '?'} vectorChannel=${stats.vector_channel ?? '?'}`
        + (this._externalNames.size > 0 ? ` external=${this._externalNames.size}` : '')
      this._info(summary)
      return { ok: true, indexed, reason: null }
    } catch (err) {
      if (this._config.failOpen === false) throw err
      const sidecarError = this._sidecar.info.lastError
      const message = err instanceof Error ? err.message : String(err)
      const reason = (message.length > 0 ? message : sidecarError ?? 'self-check failed without a message')
        + (this._status.embedderFix !== null ? ` | fix: ${this._status.embedderFix}` : '')
      this._status.failSelfCheck(reason)
      this._warn(`self-check failed (fail-open, DSH unaffected): ${reason}`)
      return { ok: false, indexed, reason }
    } finally {
      this._selfChecking = false
    }
  }

  private _selfChecking = false
}

// ======================================================================
// Cordis 插件入口（T10.1.1）
//
// 四件套形状摄自同运行时里的官方插件 `@deepseek-ai/dsh-tool-web`：
//   `export const name` / `export const inject` / `export const Config` /
//   `export function apply(ctx, config)`（探测报告 §4）。
//
// 硬约束：这里**不得出现任何 `@deepseek-ai/*` 的运行时 import**（安装目录的
// node_modules 里没有宿主包，一旦引入就是 ERR_MODULE_NOT_FOUND）；上方那几个
// type-only import 编译期即擦除，构建后 `index.js` 靠 `--external:@deepseek-ai/*`
// 再兜一道。
// ======================================================================

/** Cordis 插件名（loader 诊断用） */
export const name = 'youmi-tool-catalog'

/** 依赖的服务：只需要 tools 注册表 */
export const inject = ['tools']

/** 插件配置（宿主校验前 = 原始值，字段均可选） */
export interface Config {
  pythonCommand?: string
  dbPath?: string
  embedModel?: string
  embedMode?: 'real' | 'keyword'
  mode?: 'inject' | 'declare'
  topK?: number
  minScore?: number
  failOpen?: boolean
  selfCheckOnStart?: boolean
  /** F11 目录形态：registry = 注册表目录；external = 外部超集（ext_* 不注册不声明） */
  catalogMode?: 'registry' | 'external'
  /** 外部目录 JSONL 路径（catalogMode=external 时必填） */
  externalCatalogPath?: string
  /** 外部执行器：mock = 评测期唯一实现；mcp = 后续工作，显式报 EXECUTOR_UNAVAILABLE */
  externalExecutor?: 'mock' | 'mcp'
  /** 外部目录载入上限（默认 1000） */
  externalLimit?: number
}

/** schemastery 填完默认值后的配置（apply 拿到的就是这个形状） */
export type ResolvedCatalogConfig = Required<Omit<Config, 'pythonCommand'>> & Pick<Config, 'pythonCommand'>

/** 默认值与类型守卫集中在这里，validate 与文档共用同一份事实 */
const CONFIG_FIELDS: {
  [K in keyof Required<Config>]: { defaults: Config[K]; kind: 'string' | 'number' | 'boolean' | 'enum'; enum?: readonly string[] }
} = {
  pythonCommand: { defaults: '', kind: 'string' },
  dbPath: { defaults: '', kind: 'string' },
  embedModel: { defaults: DEFAULT_CONFIG.embedModel, kind: 'string' },
  embedMode: { defaults: 'real', kind: 'enum', enum: ['real', 'keyword'] },
  mode: { defaults: 'inject', kind: 'enum', enum: ['inject', 'declare'] },
  topK: { defaults: 5, kind: 'number' },
  minScore: { defaults: 0.3, kind: 'number' },
  failOpen: { defaults: true, kind: 'boolean' },
  selfCheckOnStart: { defaults: true, kind: 'boolean' },
  catalogMode: { defaults: 'registry', kind: 'enum', enum: ['registry', 'external'] },
  externalCatalogPath: { defaults: '', kind: 'string' },
  externalExecutor: { defaults: 'mock', kind: 'enum', enum: ['mock', 'mcp'] },
  externalLimit: { defaults: 1000, kind: 'number' },
}

const CONFIG_KEYS = Object.keys(CONFIG_FIELDS)

/**
 * 手写 Standard Schema（探测报告 §4：无需引入 `@deepseek-ai/schemastery`）。
 *
 * 宿主校验三个硬要求：同步、返回 `value`、有 `issues` 就拒。本实现同时做到：
 * - 每个声明字段都补默认值（apply 里拿到的是 `Required` 形状）；
 * - **未知键不静默丢弃**，而是原样透传并在 `~unknownKeys` 里列出来 ——
 *   catalog_status 会把它当作配置健康问题报出去（红线 3）。
 */
export const Config: StandardSchemaV1<unknown, ResolvedCatalogConfig> = {
  '~standard': {
    version: 1,
    vendor: 'youmi-tool-catalog',
    validate(value: unknown): StandardSchemaV1.Result<ResolvedCatalogConfig> {
      const raw = (value ?? {}) as Record<string, unknown>
      const issues: StandardSchemaV1.Issue[] = []
      const out: Record<string, unknown> = {}
      const unknownKeys: string[] = []

      for (const key of Object.keys(raw)) {
        if (!CONFIG_KEYS.includes(key)) unknownKeys.push(key)
      }

      for (const key of CONFIG_KEYS) {
        const spec = CONFIG_FIELDS[key as keyof Required<Config>]
        const given = raw[key]
        if (given === undefined || given === null) {
          out[key] = spec.defaults
          continue
        }
        if (spec.kind === 'string') {
          if (typeof given !== 'string') {
            issues.push({ message: `config.${key} must be a string (got ${typeof given})`, path: [key] })
            out[key] = spec.defaults
          } else {
            out[key] = given.trim()
          }
          continue
        }
        if (spec.kind === 'number') {
          if (typeof given !== 'number' || !Number.isFinite(given)) {
            issues.push({ message: `config.${key} must be a finite number (got ${JSON.stringify(given)})`, path: [key] })
            out[key] = spec.defaults
          } else {
            out[key] = given
          }
          continue
        }
        if (spec.kind === 'boolean') {
          if (typeof given !== 'boolean') {
            issues.push({ message: `config.${key} must be a boolean (got ${JSON.stringify(given)})`, path: [key] })
            out[key] = spec.defaults
          } else {
            out[key] = given
          }
          continue
        }
        if (!(spec.enum as readonly string[]).includes(given as string)) {
          issues.push({
            message: `config.${key} must be one of [${spec.enum?.join(', ')}] (got ${JSON.stringify(given)})`,
            path: [key],
          })
          out[key] = spec.defaults
        } else {
          out[key] = given
        }
      }

      if (typeof out.topK === 'number' && (!Number.isInteger(out.topK) || out.topK < 1)) {
        issues.push({ message: 'config.topK must be a positive integer', path: ['topK'] })
        out.topK = CONFIG_FIELDS.topK.defaults
      }
      if (typeof out.minScore === 'number' && (out.minScore < 0 || out.minScore > 1)) {
        issues.push({ message: 'config.minScore must be within [0, 1]', path: ['minScore'] })
        out.minScore = CONFIG_FIELDS.minScore.defaults
      }
      if (typeof out.externalLimit === 'number' && (!Number.isInteger(out.externalLimit) || out.externalLimit < 1)) {
        issues.push({ message: 'config.externalLimit must be a positive integer', path: ['externalLimit'] })
        out.externalLimit = CONFIG_FIELDS.externalLimit.defaults
      }
      // F11.2 配置校验：external 形态没有目录路径就拒绝启动（不静默空载入）
      if (out.catalogMode === 'external' && (typeof out.externalCatalogPath !== 'string' || out.externalCatalogPath === '')) {
        issues.push({
          message: 'config.externalCatalogPath is required when catalogMode="external"',
          path: ['externalCatalogPath'],
        })
      }
      if (issues.length > 0) {
        return { issues: [...issues, ...unknownKeys.map(key => ({ message: `unknown config key "${key}" (ignored by the plugin; check the spelling)`, path: [key] as const }))] }
      }
      if (unknownKeys.length > 0) out['~unknownKeys'] = unknownKeys
      return { value: out as unknown as ResolvedCatalogConfig }
    },
  },
}

/**
 * 插件启动：注册三个工具 + 拉起 sidecar + 启动自检。
 *
 * 规则（T10.1.1）：
 * - 所有注册包在 `ctx.effect()` 里，卸载即回收；
 * - `apply` 返回前**不阻塞自检**（自检异步跑，结果落到 `catalog_status`）；
 * - fail-open：单个工具注册冲突只记录降级，不得让 DSH 启动失败。
 */
export function apply(ctx: Context, config: ResolvedCatalogConfig): void {
  const catalogConfig: YoumiCatalogConfig = {
    pythonCommand: config.pythonCommand ?? '',
    dbPath: config.dbPath.trim() !== '' ? config.dbPath.trim() : defaultDbPath(),
    embedModel: config.embedModel,
    embedMode: config.embedMode,
    mode: config.mode,
    defaultTopK: config.topK,
    defaultMinScore: config.minScore,
    failOpen: config.failOpen,
    selfCheckOnStart: config.selfCheckOnStart,
    catalogMode: config.catalogMode,
    externalCatalogPath: config.externalCatalogPath,
    externalExecutor: config.externalExecutor,
    externalLimit: config.externalLimit,
  }
  const plugin = new YoumiCatalogPlugin(catalogConfig, OWN_TOOL_NAMES)
  plugin.attach(ctx.tools, ctx.logger(name))

  const registered: ToolDefinition[] = [
    buildSearchDefinition(plugin),
    buildInvokeToolDefinition(plugin),
    buildStatusDefinition(plugin),
  ]

  // 自检必须跑在注册之后（invokeDeps/statusSnapshot 依赖 attach 已完成）
  ctx.effect(() => {
    void plugin.selfCheck().catch(err => {
      // selfCheck 内部已 fail-open；走到这里只能是她自身都抛了，同样不得影响宿主
      ctx.logger(name).error(`self-check escaped its own guard: ${String(err)}`)
    })
    return () => { void plugin.stop() }
  }, 'youmi-tool-catalog: lifecycle')

  // fail-open 的注册：名字被别的插件占用了就只降级这一个能力
  let ok = 0
  for (const definition of registered) {
    try {
      ctx.effect(() => ctx.tools.register(definition), `tools.register(${definition.name})`)
      ok += 1
    } catch (err) {
      plugin.status.failSelfCheck(`cannot register ${definition.name}: ${String(err)}`)
      ctx.logger(name).warn(`register ${definition.name} skipped (fail-open): ${String(err)}`)
    }
  }
  plugin.status.setRegistered(ok)
  if (ok < registered.length) return

  // 注册表变更 → 增量重索引（tools/change 不带细情，只能全量重扫 + 指纹去重）
  ctx.effect(
    () => { ctx.on('tools/change', () => plugin.onRegistryChanged()) },
    'ctx.on("tools/change")',
  )
}

/** 把工具文本输出渲染成宿主要求的 ContentBlock（导出供单测/下游复用） */
export function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}
