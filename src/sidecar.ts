/**
 * Sidecar — Python sidecar 进程管理
 *
 * 职责:
 * - 探测/选用 Python 解释器，spawn `sidecar/launcher.py`（T10.2）
 * - ndjson JSON-RPC 2.0 通信（stdin/stdout）
 * - 分方法超时控制（initialize/index 比常规 RPC 宽松）+ 自动重启
 * - 优雅关闭；失败事实只记录不静默（供 catalog_status 展示）
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  YoumiCatalogConfig,
  IndexResult,
  SearchResult,
  CatalogStats,
  DshToolItem,
} from './types.js'
import { DEFAULT_CONFIG } from './types.js'
import { candidateInterpreters, detectInterpreter, toArgv, type DetectResult } from './detect.js'

export interface SidecarEvents {
  ready: () => void
  error: (err: Error) => void
  exit: (code: number | null) => void
  restart: (attempt: number) => void
}

/** sidecar 进程的可诊断事实（进 catalog_status.sidecar） */
export interface SidecarInfo {
  /** 实际执行的命令（argv + launcher + 参数，已脱敏：不含凭据） */
  command: string
  /** 解释器 argv */
  interpreter: string | null
  /** 解释器版本（探测得到，未知为 null） */
  interpreterVersion: string | null
  /** 解释器选择理由 / 降级说明 */
  detectReason: string | null
  /** 全部探测记录 */
  probes: DetectResult['probes']
  pid: number | null
  /** 最近一次失败原因（spawn 失败 / RPC 失败 / 非 0 退出） */
  lastError: string | null
}

/** launcher.py 缺失时的错误文本（bundle 打包事故，必须显式） */
const LAUNCHER_MISSING = 'sidecar launcher.py not found in the bundle'

/**
 * 从当前模块位置逐级向上找 bundle 根（含 `sidecar/launcher.py` 的那一层）。
 * `index.js`（构建产物，bundle 根）与 `src/sidecar.ts`（单测/开发）都能覆盖。
 */
function moduleDirs(): string[] {
  const here = typeof import.meta.url === 'string'
    ? fileURLToPath(import.meta.url).replace(/[\\/][^\\/]+$/, '')
    : process.cwd()
  const dirs: string[] = []
  let current = here
  for (let i = 0; i < 4; i++) {
    dirs.push(current)
    const parent = current.replace(/[\\/][^\\/]+$/, '')
    if (parent === current || parent === '') break
    current = parent
  }
  return dirs
}

/** sidecar `get_tool` 返回的参数条目（比 SearchParamBrief 多 description） */
export interface ExternalToolParam {
  name: string
  type?: string
  description?: string
  required?: boolean
  enum?: string[] | null
}

/** sidecar `get_tool` 返回的完整条目（F11.2 invoke 外部派发的校验数据源） */
export interface ExternalToolEntry {
  name: string
  description: string
  summary?: string
  provider_id?: string
  version?: string
  risk_level?: string
  parameters?: ExternalToolParam[]
}

export declare interface Sidecar {
  on<E extends keyof SidecarEvents>(event: E, listener: SidecarEvents[E]): this
  emit<E extends keyof SidecarEvents>(event: E, ...args: Parameters<SidecarEvents[E]>): boolean
}

/**
 * Python sidecar 进程管理器
 *
 * 通过 stdin/stdout ndjson JSON-RPC 2.0 与 Python catalog 服务通信。
 */
export class Sidecar extends EventEmitter {
  private _process: ChildProcess | null = null
  private _config: Required<Omit<YoumiCatalogConfig, 'launcherPath'>> & Pick<YoumiCatalogConfig, 'launcherPath'>
  private _nextId = 1
  private _pending = new Map<number | string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private _restartCount = 0
  private _buffer = ''
  private _ready = false
  private _info: SidecarInfo = {
    command: '',
    interpreter: null,
    interpreterVersion: null,
    detectReason: null,
    probes: [],
    pid: null,
    lastError: null,
  }

  constructor(config: YoumiCatalogConfig = {}) {
    super()
    this._config = { ...DEFAULT_CONFIG, ...config }
  }

  /** sidecar 是否已启动并就绪 */
  get ready(): boolean {
    return this._ready && this._process !== null && !this._process.killed
  }

  /** 可诊断事实（只读快照） */
  get info(): SidecarInfo {
    return { ...this._info, probes: [...this._info.probes] }
  }

  /** initialize 的返回值（embedMode / vectorChannel / dimensions / indexed） */
  get initResult(): Record<string, unknown> | null {
    return this._initResult
  }

  private _initResult: Record<string, unknown> | null = null

  /** 启动 sidecar 进程 */
  async start(): Promise<void> {
    if (this._process !== null) {
      return
    }

    const launcher = this._resolveLauncherPath()
    if (launcher === null) {
      const err = `${LAUNCHER_MISSING}: ${this._config.launcherPath ?? '(unresolved)'}`
      this._info.lastError = err
      throw new Error(err)
    }

    // 解释器：显式配置优先，空则按候选顺序探测（与 L2 自检同一套规则）
    let detected: DetectResult
    if (this._config.pythonCommand.trim() !== '') {
      const argv = toArgv(this._config.pythonCommand)
      detected = { argv, reason: `explicit pythonCommand: ${argv.join(' ')}`, probes: [] }
    } else {
      detected = await detectInterpreter(this._config.embedMode, candidateInterpreters())
    }
    this._info.interpreter = detected.argv?.join(' ') ?? null
    this._info.detectReason = detected.reason
    this._info.probes = detected.probes
    const probed = detected.probes.find(p => p.argv === detected.argv?.join(' '))
    this._info.interpreterVersion = probed?.version ?? null

    if (detected.argv === null) {
      const err = `no usable Python interpreter (${detected.reason})`
      this._info.lastError = err
      throw new Error(err)
    }

    const args = [
      launcher,
      '--db-path', this._config.dbPath,
      '--embed-model', this._config.embedModel,
      '--embed-mode', this._config.embedMode,
    ]
    const [cmd, ...cmdArgs] = detected.argv
    this._info.command = [...detected.argv, ...args].join(' ')

    this._process = spawn(cmd, [...cmdArgs, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
    this._info.pid = this._process.pid ?? null

    this._process.stdout!.setEncoding('utf-8')
    this._process.stdout!.on('data', (chunk: string) => this._onStdout(chunk))

    this._process.stderr!.setEncoding('utf-8')
    this._process.stderr!.on('data', (chunk: string) => {
      // Python 日志输出到 stderr，转发到 console.debug
      console.debug(`[sidecar:stderr] ${chunk.trimEnd()}`)
    })

    this._process.on('exit', (code) => this._onExit(code))
    this._process.on('error', (err) => this._onError(err))

    // 等待 initialize 成功（首启要加载 embedding 模型，用专用超时）。
    // F11.1：external 模式下把外部目录参数透传给 sidecar，initialize 内先载入。
    const mode = this._config.catalogMode ?? 'registry'
    const initParams: Record<string, unknown> = mode === 'external'
      ? {
          catalogMode: 'external',
          externalCatalogPath: this._config.externalCatalogPath,
          externalLimit: this._config.externalLimit,
        }
      : {}
    this._initResult = (await this._callWithRetry(
      'initialize', initParams, 2, this._config.initTimeoutMs,
    )) as Record<string, unknown>
    this._ready = true
    this.emit('ready')
  }

  /** 停止 sidecar 进程 */
  async stop(): Promise<void> {
    this._ready = false
    if (this._process === null) {
      return
    }

    try {
      await this.call('shutdown', {})
    } catch {
      // 忽略关闭时的错误
    }

    this._process.kill('SIGTERM')
    this._process = null
    this._info.pid = null
    this._rejectAllPending('sidecar stopped')
  }

  /** 通用 RPC 调用（timeoutMs 缺省用 rpcTimeoutMs） */
  async call<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (!this._process || this._process.killed) {
      throw new Error('sidecar not running')
    }

    const limit = timeoutMs ?? this._config.rpcTimeoutMs
    const id = this._nextId++
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        this._noteError(`RPC timeout: ${method} (${limit}ms)`)
        reject(new Error(`RPC timeout: ${method} (${limit}ms)`))
      }, limit)

      this._pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      const line = JSON.stringify(request) + '\n'
      this._process!.stdin!.write(line)
    })
  }

  // -- 高层方法 --

  /** 增量索引工具（首次全量 embed 很慢，用 indexTimeoutMs） */
  async indexTools(items: DshToolItem[]): Promise<IndexResult> {
    return this.call<IndexResult>('index_tools', { items }, this._config.indexTimeoutMs)
  }

  /** 语义检索 */
  async search(
    query: string,
    topK?: number,
    minScore?: number,
    exclude?: string[],
  ): Promise<SearchResult[]> {
    return this.call<SearchResult[]>('search', {
      query,
      top_k: topK ?? this._config.defaultTopK,
      min_score: minScore ?? this._config.defaultMinScore,
      exclude,
    })
  }

  /** 移除工具 */
  async removeTools(names: string[]): Promise<{ removed: number }> {
    return this.call<{ removed: number }>('remove_tools', { names })
  }

  /** 全部已索引工具名（invoke 元工具拼写建议候选池） */
  async listToolNames(): Promise<string[]> {
    return this.call<string[]>('list_tool_names', {})
  }

  /** 从 JSONL 载入外部目录（F11.1；与 initialize 自动载入同一条 RPC 路径） */
  async loadExternalCatalog(path: string, limit?: number): Promise<{
    indexed: number; skipped: number; errors: number
    total: number; parse_errors: number; truncated: boolean; source: string
  }> {
    return this.call('load_external_catalog', {
      path,
      limit: limit ?? this._config.externalLimit,
    }, this._config.indexTimeoutMs)
  }

  /** 已载入的外部目录工具名（F11.2：检索侧保留 ext_* 的依据） */
  async listExternalNames(): Promise<string[]> {
    return this.call<string[]>('list_external_names', {})
  }

  /** 按名回读完整条目（含参数 schema）；不存在时 sidecar 返回 null（F11.2） */
  async getTool(name: string): Promise<ExternalToolEntry | null> {
    return this.call<ExternalToolEntry | null>('get_tool', { name })
  }

  /** 获取统计信息 */
  async stats(): Promise<CatalogStats> {
    return this.call<CatalogStats>('stats', {})
  }

  // -- 内部方法 --

  /** 随包解析 launcher.py（构建产物 index.js 与 src/*.ts 都能定位到 bundle 根） */
  private _resolveLauncherPath(): string | null {
    if (this._config.launcherPath) {
      return existsSync(this._config.launcherPath) ? this._config.launcherPath : null
    }
    for (const base of moduleDirs()) {
      const cand = `${base}/sidecar/launcher.py`
      if (existsSync(cand)) return cand
    }
    return null
  }

  private _noteError(reason: string): void {
    this._info.lastError = reason
  }

  private async _callWithRetry(
    method: string,
    params: Record<string, unknown>,
    retries: number,
    timeoutMs?: number,
  ): Promise<unknown> {
    let lastError: Error | null = null
    for (let i = 0; i <= retries; i++) {
      try {
        return await this.call(method, params, timeoutMs)
      } catch (err) {
        lastError = err as Error
        this._noteError(`${method}: ${String(err)}`)
        if (i < retries) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)))
        }
      }
    }
    throw lastError
  }

  private _onStdout(chunk: string): void {
    this._buffer += chunk
    const lines = this._buffer.split('\n')
    this._buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const response: JsonRpcResponse = JSON.parse(line)
        this._handleResponse(response)
      } catch (err) {
        console.warn('[sidecar] failed to parse response:', line, err)
      }
    }
  }

  private _handleResponse(response: JsonRpcResponse): void {
    const id = response.id
    if (id === null || id === undefined) {
      return // notification
    }

    const pending = this._pending.get(id)
    if (!pending) {
      return // stale response
    }

    this._pending.delete(id)
    clearTimeout(pending.timer)

    if (response.error) {
      this._noteError(`RPC ${response.error.code}: ${response.error.message}`)
      pending.reject(new Error(`RPC error ${response.error.code}: ${response.error.message}`))
    } else {
      pending.resolve(response.result)
    }
  }

  private _onExit(code: number | null): void {
    this._ready = false
    this._process = null
    this._info.pid = null
    this._noteError(`sidecar exited with code ${code}`)
    this._rejectAllPending(`sidecar exited with code ${code}`)
    this.emit('exit', code)

    // 自动重启（如果未达到上限）
    if (code !== 0 && this._restartCount < this._config.maxRestarts) {
      this._restartCount++
      this.emit('restart', this._restartCount)
      setTimeout(() => this.start().catch(err => this._noteError(`restart failed: ${String(err)}`)), 2000)
    }
  }

  private _onError(err: Error): void {
    this._noteError(`spawn error: ${err.message}`)
    this.emit('error', err)
  }

  private _rejectAllPending(reason: string): void {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this._pending.clear()
  }
}
