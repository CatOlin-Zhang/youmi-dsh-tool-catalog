/**
 * 共享类型定义 — DSH Tool Catalog Plugin
 *
 * JSON-RPC 2.0 协议类型、工具条目类型、插件配置类型。
 */

// ======================================================================
// JSON-RPC 2.0 协议
// ======================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id: number | string | null
  result?: T
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// ======================================================================
// 工具条目（DSH 注册表格式）
// ======================================================================

export interface DshToolItem {
  name: string
  description: string
  parameters?: DshToolParameter[]
  summary?: string
  version?: string
  risk_level?: 'low' | 'medium' | 'high' | 'critical'
  required_permissions?: string[]
  provider_id?: string
}

export interface DshToolParameter {
  name: string
  type?: string
  description?: string
  required?: boolean
  enum?: string[]
  default?: unknown
}

// ======================================================================
// 索引 / 检索结果
// ======================================================================

export interface IndexResult {
  indexed: number
  skipped: number
  errors: number
}

/** 检索结果中的参数精简视图（与 Python 侧 `_param_brief` 对齐，不带 description） */
export interface SearchParamBrief {
  name: string
  type: string
  required: boolean
  enum?: string[] | null
}

export interface SearchResult {
  tool_name: string
  description: string
  score: number
  summary: string
  risk_level: string
  required_permissions: string[]
  /** 参数精简视图（T1 起由 sidecar 返回） */
  parameters?: SearchParamBrief[]
  /** Python 侧预渲染的紧凑签名；缺省时 TS 侧由 parameters 渲染 */
  signature?: string
}

export interface CatalogStats {
  initialized: boolean
  db_path?: string
  embed_model?: string
  embedding_dim?: number
  embedder_loaded?: boolean
  embedder_dimensions?: number | null
  /** 向量通道模式（`real` / `keyword`），由 sidecar 报告 */
  embed_mode?: 'real' | 'keyword'
  /** 向量通道是否实际生效（embedMode=real 时为 true） */
  vector_channel?: boolean
  /** embedder 加载失败原因（成功时为 null；不静默降级的证据） */
  embedder_error?: string | null
  fingerprints?: number
  /** 外部目录（F11.1）归属的工具数 */
  external_count?: number
  /** 注册表归属的工具数（fingerprints − external） */
  registry_count?: number
  last_indexed_at?: string | null
  store?: Record<string, unknown>
}

// ======================================================================
// 插件配置
// ======================================================================

export interface YoumiCatalogConfig {
  /**
   * Python 解释器命令（空格分隔，如 `py -3`）。
   * 空 / 缺省 = 自动探测（见 `src/detect.ts`，规则与 scripts/selfcheck_sidecar.py 一致）。
   * 实际拉起的是 `sidecar/launcher.py`，本命令只提供解释器 argv。
   */
  pythonCommand?: string
  /** sidecar 入口（默认 `<bundle>/sidecar/launcher.py`，随包解析） */
  launcherPath?: string
  /** 数据库路径（空 = `<DSH_HOME>/youmi-catalog/dsh-tools.db`） */
  dbPath?: string
  /** Embedding 模型名（默认: intfloat/multilingual-e5-small） */
  embedModel?: string
  /**
   * 向量通道模式（T10.2）：
   * - `real`（默认）：必须加载 sentence-transformers 模型，缺失即显式报错
   * - `keyword`：显式关闭向量通道，只走关键词检索
   */
  embedMode?: 'real' | 'keyword'
  /** RPC 超时毫秒数（默认: 30000） */
  rpcTimeoutMs?: number
  /** `initialize` 专用超时（默认: 120000，覆盖首启加载模型） */
  initTimeoutMs?: number
  /** `index_tools` 专用超时（默认: 300000，覆盖 1000 工具首次全量 embed） */
  indexTimeoutMs?: number
  /** 最大重启次数（默认: 3） */
  maxRestarts?: number
  /** 检索默认 top_k（默认: 5） */
  defaultTopK?: number
  /**
   * top_k 的保护性上限（默认: 15，与 sidecar `max_k` 默认一致，F10.2）。
   * 请求超过它时按本值处理并在返回文案里说明；自适应截断只会向下收敛。
   */
  maxTopK?: number
  /** 检索默认 min_score（默认: 0.3） */
  defaultMinScore?: number
  /**
   * 呈现模式（T5）：
   * - `'inject'`（默认）：激活只更新 SessionState，不调 restrict、不改注册表，
   *   请求头恒定；激活信息仅用于渲染标注与排序提示
   * - `'declare'`：保留 restrict 行为（改注册表可见集），仅用于 A/B 对照
   */
  mode?: 'inject' | 'declare'
  /**
   * sidecar 不可用时是否让插件继续活着（红线 4，恒为 true）。
   * false 只用于测试：拉起失败直接抛出。
   */
  failOpen?: boolean
  /** 启动时是否跑自检（spawn → initialize → stats → 全量索引注册表） */
  selfCheckOnStart?: boolean
  /**
   * 目录形态（F11.1）：
   * - `'registry'`（默认）：目录 ≡ 注册表（现有行为，无缓存收益）
   * - `'external'`：外部目录超集形态（评测形态）——sidecar 从
   *   `externalCatalogPath` 载入 JSONL 工具，不注册、不声明，只供
   *   search → invoke；请求头恒定只有本插件元工具 + DSH 基础工具
   */
  catalogMode?: 'registry' | 'external'
  /** 外部目录 JSONL 路径（catalogMode=external 时必填，F11.1） */
  externalCatalogPath?: string
  /**
   * 外部工具执行器（F11.2）：
   * - `'mock'`（默认，评测专用）：不执行真实动作，按 schema 校验后回显
   *   `{ok, tool, args_echo, note}`；真实执行器（MCP/HTTP 转发）是后续工作
   */
  externalExecutor?: 'mock' | 'mcp'
  /** 外部目录载入条数上限（默认: 1000，F11.1） */
  externalLimit?: number
}

export const DEFAULT_CONFIG: Required<Omit<YoumiCatalogConfig, 'launcherPath'>> &
  Pick<YoumiCatalogConfig, 'launcherPath'> = {
  pythonCommand: '',
  launcherPath: undefined,
  dbPath: '',
  embedModel: 'intfloat/multilingual-e5-small',
  embedMode: 'real',
  rpcTimeoutMs: 30_000,
  initTimeoutMs: 120_000,
  indexTimeoutMs: 300_000,
  maxRestarts: 3,
  defaultTopK: 5,
  maxTopK: 15,
  defaultMinScore: 0.3,
  mode: 'inject',
  failOpen: true,
  selfCheckOnStart: true,
  catalogMode: 'registry',
  externalCatalogPath: '',
  // 产品安全默认：mcp 执行器未实现时会显式返回 EXECUTOR_UNAVAILABLE，
  // 避免 external 形态静默走 mock（mock 仅供评测，需显式配置）。
  externalExecutor: 'mcp',
  externalLimit: 1000,
}

// ======================================================================
// Session 状态
// ======================================================================

/** 激活集 — 单调递增（只增不减，直到 session 结束） */
export type ActivatedSet = Set<string>

/** pinned 工具 — 始终呈现 */
export type PinnedSet = Set<string>

/** Turn 级缓存 key */
export interface TurnCacheKey {
  query: string
  topK: number
  minScore: number
  exclude: string[]
}

/** Turn 级缓存 entry */
export interface TurnCacheEntry {
  results: SearchResult[]
  timestamp: number
}
