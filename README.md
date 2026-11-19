# YouMi Tool Catalog Plugin — 配置与使用

## 概述

`@youmi/dsh-tool-catalog` 将 YouMi Agent 的工具向量检索 / 按需呈现方案接入 DSH 插件体系。

核心能力:
- **增量索引**: 监听 DSH tools 注册表变更，通过 Python sidecar 增量索引到向量数据库
- **语义检索**: 基于 sentence-transformers 本地 embedding（`multilingual-e5-small`）；检索质量按「查询语言 = 工具描述语言」设计（同语言实测 19/19 top-1），跨语言会明显退化，见「已知限制」
- **两个元工具**: `search_tools`（检索并返回紧凑签名）+ `invoke`（按名调用目录内工具），请求头里**永远只有这两个**
- **只追加、不改请求头**: 激活只更新 SessionState，检索结果（含紧凑签名）只作为 `search_tools` 的 tool 消息落在对话尾部，schema 不进请求头 → prefix cache 不失效（`mode: 'declare'` 才回到旧的 restrict 行为，仅作对照）

## 收益实测（真实模型 · 2026-11-19；成本口径于 2026-11-19 修订）

> 测试设置：`deepseek-chat` 真实 provider、真实 `multilingual-e5-small` 向量、24 条英文任务、5 组配置；
> 每次请求的 token 均为 **provider 回读 usage**；执行器为 mock（校验参数合法、无真实副作用），
> 因此成功率反映「协议 + 检索 + 参数校验」，不代表真实工具效果。
>
> **成本怎么来的**：token 结构是 `deepseek-chat` 实测的；成本是把这套 token 结构套在
> DeepSeek 官方价目（`deepseek-flash` / `deepseek-v4-pro` 各空闲与高峰档，元 / M token）上的**换算**，
> 不是在这些模型上实跑出来的账单。
>
> **成本口径修订（v0.2.1）**：早期版本按 $0.27 / $0.07 / $1.10 每 M token 换算，且把 provider 的
> `prompt_tokens`（**含**缓存命中）当成「未缓存输入」，导致命中部分被计两次、倍数虚高。
> 现改为：未缓存输入 = `prompt_tokens − cached_tokens`（与 provider 的 `prompt_cache_miss_tokens`
> 逐臂核对完全一致），价格按 DeepSeek 官方价目（元 / M token）。**旧的 4.4× / 16.9× / 84× 作废。**

### 每任务成本（24 任务平均，¥/任务）

| 工具规模 | 原生（全量声明）每任务 | 本方案（`search_tools` + `invoke`） | 倍数（flash 空闲） | 原生方案可行性 |
| ---: | ---: | ---: | ---: | --- |
| 50 | 0.00152 | 0.00171 | **0.9×（本方案反而略贵）** | 可行 |
| 200 | 0.00275 | 0.00171 | **1.6×** | 可行（本次 deepseek-chat 实测接受 200；官方未给出 tools 数量上限，换模型 / provider 需自行确认） |
| 1000 | 0.0092~0.0111（**线性外推，未实测**） | 0.00171 | **5.4~6.5×** | ⚠️ **未验证**：上下文放得下（1M 窗口 ≈ 123k token），但 API 是否接受 1000 个 tools 声明未实测；若被 tools 数量上限拒绝，就只能改为外部目录形态 |

四组价目全列（元 / M token；peak 是空闲的 2 倍，倍数不变）：

| 价目（未命中 / 命中 / 输出） | 原生@50 | 原生@200 | 原生@1000 外推 | 本方案（恒定） | 倍数 50 / 200 / 1000 |
| --- | ---: | ---: | ---: | ---: | --- |
| flash 空闲（1 / 0.02 / 4） | 0.00152 | 0.00275 | 0.0092~0.0111 | 0.00171~0.00174 | 0.89× / 1.61× / 5.4~6.5× |
| flash 高峰（2 / 0.04 / 8） | 0.00304 | 0.00550 | 0.0184~0.0222 | 0.00342~0.00348 | 同上 |
| v4-pro 空闲（4.5 / 0.15 / 13.5） | 0.00686 | 0.01454 | 0.0552~0.0636 | 0.00664~0.00674 | 1.03× / 2.19× / 8.3~9.6× |
| v4-pro 高峰（9 / 0.3 / 27） | 0.01371 | 0.02907 | 0.110~0.127 | 0.01327~0.01349 | 同上 |

### 真实 token 结构

| 指标 | native@50 | native@200 | inject@50 | inject@200 | inject@1000 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 请求数 / 任务数 | 48 / 24 | 48 / 24 | 72 / 24 | 72 / 24 | 72 / 24 |
| prompt 峰值（回读，真实） | 6,455 | 24,859 | 973 | 971 | 977 |
| 未缓存输入 Σ | 15,691 | 27,236 | 15,305 | 15,976 | 15,910 |
| cache_read Σ | 286,208 | 1,158,400 | 35,959 | 35,200 | 35,200 |
| 缓存命中率 | 94.8% | 97.7% | 70.1% | 68.8% | 68.9% |
| 输出 Σ | 3,779 | 3,894 | 6,384 | 6,080 | 6,293 |
| 声明 token（首请求估算） | 6,234 | 25,258 | 212 | 212 | 212 |
| `rounds_to_first_correct_call` | 1 | 1 | 2 | 2 | 2 |
| 任务成功率（mock 校验） | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 |
| `arg_error_rate` | 0 | 0 | 0 | 0 | 0 |
| TTFT 均值 | 1.16s | 1.22s | 1.12s | 1.16s | 1.11s |

### 结论与边界

- **成本优势不在 50~200 档**：200 档只有 1.6×（flash）/ 2.2×（pro）；50 档基本打平（flash 下本方案反而高约 12%）。
- **真正的壁垒是规模上限而不是钱包**：1000 档原生是否可行取决于 API 的 tools 数量上限（**未实测**；
  上下文 1M 已不是瓶颈），而本方案在 1000 档仍只有恒定成本。成本只是 200 档以上的加分项。
- **命中价便宜时，"大前缀"并不贵**：flash 命中价只有未命中价的 2%，native@200 的 116 万命中 token 只值 ¥0.023；它贵在未缓存输入（¥0.027）和输出（¥0.016）。
- **本方案的成本项是输出**：约 60% 花在额外轮次的 output 上（每任务 3 次请求 vs 原生 2 次）。要放大性价比，应把 `search_tools` + `invoke` 压成一次调用。
- 代价仍是每任务多一轮（约 +1 s）；本方案 TTFT 反而略低（1.11~1.16 s vs 1.16~1.22 s）。
- **1000 规模未实测**：DSH 内与 API 侧均无法全量声明，表中为该区间按声明体量线性外推的参考值，**不能当作测量结果引用**。
- 单一模型（deepseek-chat）、24 任务、单次运行；执行器为 mock——真实工具副作用与更强模型下的表现需另行复测。

详见仓库内 `docs/` 与 DSH 侧评测报告（`REPORT_F11_*`）。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  DSH Agent                                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  @youmi/dsh-tool-catalog (TS plugin)                │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │    │
│  │  │ Indexer  │  │ Selector │  │   SessionState   │  │    │
│  │  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │    │
│  │       │              │                  │             │    │
│  │       └──────────────┼──────────────────┘             │    │
│  │                      │                                 │    │
│  │              ┌───────┴────────┐                       │    │
│  │              │    Sidecar     │ ← ndjson JSON-RPC 2.0 │    │
│  │              └───────┬────────┘                       │    │
│  └──────────────────────┼────────────────────────────────┘    │
│                         │ stdin/stdout                        │
│  ┌──────────────────────┴────────────────────────────────┐   │
│  │  Python Sidecar (youmi.mcp.stdio_server)              │   │
│  │  ┌────────────────────────────────────────────────┐   │   │
│  │  │  DshToolCatalog                                │   │   │
│  │  │  ┌──────────────┐  ┌────────────────────────┐  │   │   │
│  │  │  │ LocalEmbedder│  │      ToolStore         │  │   │   │
│  │  │  │ (sentence-   │  │ (SQLite + sqlite-vec)  │  │   │   │
│  │  │  │  transformers)│  └────────────────────────┘  │   │   │
│  │  │  └──────────────┘                               │   │   │
│  │  └────────────────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 安装

本包同时是**DSH bundle**（`dsh.bundle.patch`）与插件包，安装方式二选一：

### 方式 A · DSH 插件管理器（推荐）

1. 打开 **插件（Plugins）→ 添加插件**，选择本目录；
2. 或在有 `plugin_manager` 工具的环境里执行 `install_bundle`，`target` 指向本目录；
3. 安装后**重启 DSH Desktop**（bundle 以 link 方式安装时，JS 模块在启动时加载）。

### 方式 B · 手动挂载

把本目录加入 profile 的依赖，并在 profile 的 `cordis.patch.yml` 里插入：

```yaml
- insert:
    - id: youmi-tool-catalog
      name: '@youmi/dsh-tool-catalog'
      config: {}
```

### 运行时依赖（重要）

bundle **不自带**运行时，宿主需要满足：

| 依赖 | 说明 |
|---|---|
| Python 3.10+ | 默认自动探测 `py -3` / `python` / `python3`；也可用 `pythonCommand` 显式指定 |
| `httpx`、`numpy` | sidecar 基础依赖 |
| `sentence-transformers` + `intfloat/multilingual-e5-small` | **仅 `embedMode: real` 需要**（约 130MB 模型，首次可用后离线加载） |

```bash
pip install httpx numpy sentence-transformers>=2.2
```

无法安装模型时，可显式配置 `embedMode: keyword`（无向量，检索质量下降；**不会静默降级**）。

### 自检

bundle 内自带三层校验脚本（需用带 `pytest` 的 Python）：

```bash
# L1 静态校验（manifest / patch / locale / icon / files / sidecar 漂移）
python scripts/selfcheck_bundle.py --bundle . --output <可写目录>

# L2 sidecar 协议（真实 vector 模式）
python scripts/selfcheck_sidecar.py --embed-mode real --tools 1000

# L3 会话校验（需先有一次真实 DSH 会话）
python scripts/verify_dsh_session.py --session <session.jsonl.zstd>
```

## 配置

### cordis.yml 片段

```yaml
plugins:
  youmi-tool-catalog:
    # Python sidecar 命令（默认: python -m youmi.mcp.stdio_server）
    pythonCommand: python -m youmi.mcp.stdio_server

    # SQLite 数据库路径（默认: .youmi/dsh-tools.db）
    dbPath: .youmi/dsh-tools.db

    # sentence-transformers 模型（默认: intfloat/multilingual-e5-small）
    # 384 维，跨语言对齐好，专为检索训练
    embedModel: intfloat/multilingual-e5-small

    # RPC 超时毫秒数（默认: 30000）
    rpcTimeoutMs: 30000

    # 最大重启次数（默认: 3）
    maxRestarts: 3

    # 检索默认 top_k（默认: 5）
    defaultTopK: 5

    # 检索默认 min_score（默认: 0.3）
    defaultMinScore: 0.3

    # 呈现模式（默认: inject）
    #   inject  : 激活只改 SessionState，请求头恒定（search_tools + invoke），
    #             签名/提示只追加到对话尾部 —— prefix cache 不失效
    #   declare : 旧行为，对未激活工具调用 ctx.tools.restrict({deny})，
    #             每帧改写可见声明集；仅用于 A/B 对照与回滚
    mode: inject

    # 目录形态（默认: registry，见「目录形态」一节）
    #   registry: 目录 ≡ DSH 注册表（产品形态，索引的就是注册进去的工具）
    #   external: 超集评测形态 —— 从 JSONL 载入外部工具（ext_* 前缀），
    #             不注册、不声明，search → invoke 协议，请求头恒为 2 个元工具
    catalogMode: registry

    # external 形态：外部工具 JSONL 路径（catalogMode=external 时必填，缺失直接拒绝加载配置）
    externalCatalogPath: experiments/f11_catalog_1000.jsonl

    # external 形态：执行器（默认 mock；mcp 未实现 → 显式 EXECUTOR_UNAVAILABLE，不静默当 mock）
    externalExecutor: mock

    # external 形态：载入条数上限（默认 1000，超出部分 truncated=True）
    externalLimit: 1000
```

### 最小配置

```yaml
plugins:
  youmi-tool-catalog: {}
```

## 使用

### 编程接口

```typescript
import { YoumiCatalogPlugin } from '@youmi/dsh-tool-catalog'

// 创建插件实例
const plugin = new YoumiCatalogPlugin({
  dbPath: '.youmi/dsh-tools.db',
})

// 启动（spawn Python sidecar）
await plugin.start()

// 索引工具
plugin.indexTool({
  name: 'read_file',
  description: '读取文件内容到内存',
  parameters: [
    { name: 'path', type: 'string', description: '文件路径', required: true },
  ],
})

// 批量索引
plugin.indexTools([
  { name: 'write_file', description: '将内容写入文件' },
  { name: 'send_email', description: '发送电子邮件通知' },
])

// 立即 flush 索引队列
await plugin.flushIndex()

// 语义检索
const results = await plugin.search('文件操作', 5)
console.log(results)
// [
//   { tool_name: 'read_file', score: 0.87, summary: '读取文件内容到内存', ... },
//   { tool_name: 'write_file', score: 0.82, summary: '将内容写入文件', ... },
// ]

// 搜索并选择（合并 pinned + activated + results）
const selected = await plugin.selectTools('发送邮件', 3)
console.log(selected) // ['send_email', ...]

// 推进 turn（清空缓存）
plugin.nextTurn()

// 设置 pinned 工具（始终呈现）
plugin.setPinned(['read_file', 'write_file'])

// 诊断
const stats = await plugin.stats()
console.log(stats)

// 停止
await plugin.stop()
```

### 与 DSH 集成

在 DSH 插件的 `apply` 函数中:

```typescript
import type { Context } from '@deepseek-ai/cordis'
import { YoumiCatalogPlugin } from '@youmi/dsh-tool-catalog'

export const name = 'my-dsh-plugin'
export const inject = ['tools']

export async function apply(ctx: Context): Promise<void> {
  const catalog = new YoumiCatalogPlugin(ctx.config.youmiCatalog)
  await catalog.start()

  // 监听工具注册
  ctx.tools.on('register', (def) => {
    catalog.indexTool({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    })
  })

  // 注册 search_tools 工具
  ctx.tools.register({
    name: 'search_tools',
    description: 'Search the tool catalog using natural language.',
    parameters: {
      query: { type: 'string', required: true },
      top_k: { type: 'integer' },
    },
    async execute(args) {
      const results = await catalog.search(args.query, args.top_k)
      // 默认 inject 模式：只更新 SessionState，不动注册表 → 请求头恒定
      catalog.activate(results.map(r => r.tool_name))
      return catalog.formatResults(results)
    },
  })

  // 注册 invoke 元工具（路径 B 核心：按名调用目录内工具，schema 不进请求头）
  // 必须在 agent 作用域内注册，bind 到 agent.ctx
  ctx.tools.register(catalog.buildInvokeTool(agent.ctx.tools))

  // declare 模式（对照/回滚开关）才需要同步注册表可见性：
  //   catalog.syncVisibility(agent.ctx.tools, registryNames)
  // inject 模式下恒为 false，不会调用 restrict
}
```

## 目录形态：registry vs external（F11）

插件支持两种目录形态，由 `catalogMode` 切换：

| | `registry`（默认） | `external`（超集评测形态） |
|---|---|---|
| 目录来源 | DSH 注册表（监听 register/unregister） | 注册表 + JSONL 外部目录（`ext_*` 前缀） |
| 工具是否注册/声明 | 是（目录 ≡ 注册表） | **否**：`ext_*` 不进注册表、永远不进请求头 |
| 调用路径 | `search_tools` 激活 → 直接调用 | `search_tools` → `invoke(tool, arguments)` |
| 参数校验 | DSH schema 原生 | sidecar `get_tool` 回读 schema → 插件侧校验，`INVALID_ARGS` 回显签名 |
| 执行器 | DSH 本体 | `externalExecutor`：`mock`（仅评测）/ `mcp`（未实现） |

`external` 形态下的关键不变量（与 D9/D10 一致）：

- **ext_* 不进请求头**：请求头恒为 `search_tools` + `invoke` 两个元工具声明；
- **检索视野 ≡ 派发视野**：`ext_*` 永远不在注册表可见集里，但可派发 —— 因此
  `search` 的作用域裁剪（D10 的 exclude 过滤）必须放行 `_externalNames` 中的名字；
- **并集共存**：切回 `registry` 模式不删除已载入的 `ext_*` 条目（指纹幂等，
  重复 `initialize` 全 skipped）；外部归属由 `provider_id="external-catalog"` 标记，
  重启后从库中恢复，`catalog_status` 的 `externalCount` / `registryCount` 分路计数。

评测用法（双臂矩阵 harness，指标只从会话日志聚合）：

```bash
python scripts/gen_f11_data.py --check        # 生成/校验 1000 工具 + 24 任务（固定种子可复现）
python scripts/run_f11_arm.py --all           # native@{50,200} + inject@{50,200,1000}
python scripts/run_f11_arm.py --arm inject --scale 200   # 单组合一键复跑
python scripts/run_f11_arm.py --reports-only  # 离线重放聚合，不重跑会话
```

产物：`experiments/REPORT_F11_DSH.md`（会话指标）与 `experiments/REPORT_F11_BENEFIT.md`
（收益对比）。结论前提见其 §6：`registry` 形态（目录≡注册表）无缓存收益，
`external` 形态的收益成立前提是接真实执行器。

## 命令行

Python sidecar 可独立运行:

```bash
# 默认参数
python -m youmi.mcp.stdio_server

# 自定义参数
python -m youmi.mcp.stdio_server \
  --db-path /path/to/dsh-tools.db \
  --embed-model intfloat/multilingual-e5-small \
  --log-level DEBUG
```

或通过 pip 安装后的命令:

```bash
youmi-dsh-catalog --db-path .youmi/dsh-tools.db
```

## 协议

TS 插件与 Python sidecar 通过 stdin/stdout ndjson JSON-RPC 2.0 通信:

### 请求格式

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

### 响应格式

```json
{"jsonrpc":"2.0","id":1,"result":{"status":"ok"}}
```

### 支持的方法

| 方法 | 参数 | 返回值 |
|------|------|--------|
| `initialize` | `{}`；F11 可选 `{"catalogMode": "external", "externalCatalogPath": "...", "externalLimit": 1000}` | `{"status": "ok", "catalogMode", "externalCount", "registryCount", "load"?, ...}` |
| `index_tools` | `{"items": [...]}` | `{"indexed": N, "skipped": M, "errors": K}` |
| `load_external_catalog` | `{"path": "...", "limit": 1000}` | `{"indexed", "skipped", "errors", "total", "parse_errors", "truncated", "source"}`（F11.1，指纹幂等；文件不存在抛错） |
| `get_tool` | `{"name": "..."}` | 完整条目 dict（含 `parameters`）/ `null`（F11.2：invoke 校验外部工具的数据源） |
| `list_external_names` | `{}` | `["ext_...", ...]`（已排序；插件检索侧保留 ext_* 的依据） |
| `search` | `{"query": "...", "top_k": 5, "min_score": 0.3, "exclude": [...]}` | `[{"tool_name", "score", "summary", "risk_level", "parameters": [...], "signature": "name(a: str, b?: str)", ...}]` |
| `remove_tools` | `{"names": [...]}` | `{"removed": N}` |
| `list_tool_names` | `{}` | `["tool_a", ...]`（invoke 拼写建议的候选池） |
| `stats` | `{}` | `{"initialized": true, "fingerprints": N, ...}` |
| `shutdown` | `{}` | `{"status": "shutdown"}` |

> `search` 的 `parameters` / `signature` 是 T1 为"一次往返即可调用"加的：模型拿到紧凑签名就能直接填参，
> 不需要再走一轮读 schema。签名规则（必填在前、可选带 `?`、>8 个加 `…`、总长 ≤ 160）与 TS 侧
> `renderSignature` 一致，两侧都有用例钉住。

## 设计决策

### D1: 默认 `inject`，`restrict` 降级为对照开关

默认 **不调用** `ctx.tools.restrict()`：激活只写 SessionState，请求头恒定（`search_tools` + `invoke` 两个 schema）。
可变信息全部落在**对话尾部** —— 紧凑签名就是 `search_tools` 的 tool 消息内容（`formatSearchResults`），
`activated` 集只用于渲染标注与排序提示，不产生任何请求头变化，
从而避免"从第一个变化的 schema token 起整个前缀缓存失效"。

`tools.restrict({ deny })` + `step/end` 发布时机保留在 `mode: 'declare'` 下，仅用于 A/B 对照与一键回滚
（restrict 必须在 `agent.ctx` 作用域调用，全局调用抛错；见 `docs/notes/dsh-capability-probe.md`）。

### D2: 单调激活集（但不进请求头）

session 内 activated 集仍只增不减，避免工具反复加载/卸载带来的判定抖动；差别在于它**只用于渲染标注与排序提示**，
不再作为可见工具声明的来源 —— 因此"只增不减"不再等于"每帧改写请求头"。

### D3: 同 turn 结果缓存

同一 turn 内相同查询不重复调用 sidecar，减少 IPC 开销。

### D4: 私有 ndjson JSON-RPC sidecar

Python 进程通过 stdin/stdout 通信，日志输出到 stderr，不干扰协议。

### D5: 索引 DSH 自身注册表

插件索引 DSH tools 系统的注册表，而非 YouMi 的 ToolVault。

### D6: 本地 embedding

使用 sentence-transformers 加载 `intfloat/multilingual-e5-small`，无需外部服务。

### D7: fail-open 语义

sidecar 不可用时，降级为 DSH 默认工具呈现，不阻塞 Agent。

### D8: 与 PTC 互补，不再"检测到就自动禁用"

PTC（把工具定义放进 `run_code` 里调用）与本方案目标一致 —— **schema 不进请求头**。
`invoke` 只是把同一件事从"写代码"降到"一次结构化调用"，因此两者不冲突，
**不做自动禁用**：插件不再因为检测到 PTC 就关掉自己。

真正需要避让的只有 `declare` 模式（它改写注册表可见集），所以禁用条件与 `mode` 挂钩，
而不是与 PTC 挂钩。

### D9: 检索视野 ≡ 派发视野

**不变量**：同一 scope 下，`search_tools` 能返回的工具集合，必须等于 `invoke` 能成功
派发的工具集合。

DSH 的内置工具（read/write/edit/glob/grep/pwsh/job_*/skill/subagent…）注册在 **agent
preset 作用域**，不在全局视图；只有 MCP / `team_task_*` 是全局注册。早期版本枚举用
`tools.definitions()`（省略 scope = 全局视图），于是目录只索引到全局那一小部分，
而 `invoke` 却走调用方 agent 作用域能调到 `pwsh` —— 检索视野与派发视野不一致。

修复：
- 枚举统一走 `definitions(scope)`，`scope` 由调用方 `exec.agent` 提供；
- `search_tools` / `invoke` / `catalog_status` 的 execute 在动作前 `await ensureIndexed(exec.agent)`
  补齐当前作用域（该 scope 已同步且未标脏则直接返回，幂等且廉价）；
- `tools/change` 只**标脏**（全局 epoch 自增），不再立刻全扫；下个检索请求按 scope 重扫；
- `invoke` 的 `UNKNOWN_TOOL`（完全不存在，给候选）vs `NOT_ADMITTED`（目录里有但当前不可调用）
  依据「当前 scope 可见集」区分。

补索引是 **fail-open** 的：`ensureIndexed` 失败只记日志，绝不让 `search_tools` 抛错。

> 已知限制：首次检索（新会话或注册表刚变更）会触发一次按 agent 作用域的补索引，
> 真实向量 embed 增量工具可能多花几秒；之后靠 sidecar 指纹去重保持廉价。
> `catalog_status` 的 `catalog.syncScope` 字段：`global_only`（仅启动自检的全局视图）
> 与 `union`（已按调用方作用域补全；索引是各作用域可见集的并集）。
> 历史值 `per_agent`（索引 ≡ 单一 agent 可见集）已废弃、不再写入，见 D10。

### D10: 并集索引 + 检索侧作用域过滤（F10.3）

**问题**：`syncRegistry(agent)` 早期会删除「该 agent 视野里看不到」的工具。未开
Team Mode 的会话看不到 `team_task_*`，同步时就把它们从目录删掉；下次开 Team Mode
又加回来 —— 索引在作用域之间抖动、embedding 反复重算，且同一时刻的结果取决于
「最后一次同步是谁」。

**做法（两层）**：

1. **索引侧只增不删（并集）**：带 `scope` 的 `syncRegistry` 只做增量索引，绝不因
   「某 scope 看不到」而 `remove_tools`；删除只在**全局对账**（启动自检
   `selfCheck` → `syncRegistry(undefined, undefined, { removeMissing: true })`）确认工具
   从全局注册表彻底消失时执行。按名字记录归属视图（`global` / `agent`），删除只对
   `global` 归属生效。
2. **检索侧按当前 scope 过滤**：`search_tools` 返回前，用调用方 `definitions(exec.agent)`
   的可见集裁剪结果（不可见的名字进 `exclude` 传给 sidecar），**真正丢弃**而非只记日志。

这样「检索视野 ≡ 派发视野」（D9）由**过滤**保证，而不再由「索引恰好只含可见集」保证，
既不让索引抖动，也不违反不变量。`catalog_status.catalog.syncScope` 记为 `union`，
`scopeCount` 给出已知作用域数。

## 已知限制

- **语言假设（F10.4）**：检索质量按「**查询语言 = 工具描述语言**」设计（实测英文
  19/19 top-1，见 `docs/notes/f10-ranking-and-scope.md` §0 与 `experiments/REPORT_F10_RANKING.md`）。
  跨语言（如中文查询英文工具）会明显退化（`"执行命令"` 下 `pwsh` 排第 15）；
  需要跨语言时请显式开启双语索引或查询扩写（本版本未提供），或让工具描述与提问
  保持同语言。
- **`top_k` 有上限保护**：`search_tools` 的 `top_k` 是硬上限，但目录对单次返回封顶
  `maxTopK`（默认 15）。`top_k > maxTopK` 时按 `maxTopK` 处理，并在返回文案里附一行
  说明（`Found N tool(s)` 的 N 恒等于实际条数）。
- **`external` 形态的 mock 执行器仅用于评测（F11，红线 1）**：`externalExecutor: mock`
  返回 `args_echo` + note 锚点，**没有真实副作用**，其成功率/轮数只反映协议合规与
  检索排序质量，不代表真实工具效果；`externalExecutor: mcp` 尚未实现，配置后会显式
  返回 `EXECUTOR_UNAVAILABLE`（不静默降级成 mock）。真实外部工具执行是后续工作。
- **`external` 形态不产生产品能力**：它解决的是「目录是注册表超集」这一评测形态下
  的收益度量；生产形态（`registry`）下目录工具本来就注册在 DSH 里，收益口径不同，
  不能拿 F11 报告的外推当 `registry` 形态的缓存收益证明。

## 测试

### Python 测试

```bash
pytest tests/test_dsh_catalog.py -v

# F11 外部目录（keyword 模式，不加载 sentence-transformers，无需联网）
pytest tests/test_f11_external_catalog.py -q
```

> 离线/无网环境需要显式关掉 HF Hub 的联网校验，否则 `intfloat/multilingual-e5-small`
> 即使已在本地缓存也会因 etag 校验被 SSL 打断而加载失败：
>
> ```bash
> HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 pytest tests/test_dsh_catalog.py -q
> ```
>
> Windows + Anaconda 下若 `import torch` 触发 `OMP: Error #15`，另加
> `KMP_DUPLICATE_LIB_OK=TRUE`。

### TS 测试

```bash
cd dsh-plugins/youmi-tool-catalog
pnpm test
# 只跑 F11 外部目录用例：
npx vitest run tests/f11-external.spec.ts
```

> 本包声明了 `@deepseek-ai/cordis` 等 `workspace:` 协议的对等依赖，
> 因此**只能在 DSH 的 pnpm workspace 内安装**；在 workspace 之外直接
> `pnpm install` 会报 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`（不要为此改 `dsh/pnpm-workspace.yaml`）。
> 只想跑单测时的最小办法：`src/` 与 `tests/` 对 DSH 只有 `import type`，
> 单独准备一个 vitest（放在仓库外，例如临时目录），把本目录的 `node_modules`
> 做成指向它的 junction，再执行 `node <vitest>/vitest.mjs run`。
> `node_modules/` 已在 `.gitignore` 中，不要提交。

### 缓存友好度 A/B 度量（T8）

```bash
# 离线机制验证：只验采集链路与不变量，不产出结论（usage 一律 n/a）
pytest tests/test_tool_catalog_cache_ab.py -q

# 真实调用 A/B（需本地 Ollama 起来），产出 experiments/REPORT_TOOLCAT.md
YOUMI_CACHE_AB=1 YOUMI_CACHE_AB_TOOLS=100 pytest tests/test_tool_catalog_cache_ab.py -k TestT8RealUsage -s
```

三臂配置：`native`（全量声明）/ `inject`（默认，请求头恒定）/ `declare`（restrict 对照）。
指标只从真实响应回读的 usage 取值，provider 没给的字段一律显示 `n/a`。

功能验收口径（2026-11-18 裁决修正，见 `docs/notes/cloud-eval-adjudication.md`）：
`arg_error_rate ≤ 10%` + `excess_rounds = rounds_abs − 协议下限 ≤ 0.5`。
原 `rounds_to_first_correct_call ≤ 1.2` **已作废**——inject 协议必然「第 1 轮 `search_tools`
→ 第 2 轮 `invoke`」，绝对轮数下限就是 2.0，拿它判达标是口径缺陷而非实现缺陷。
计数逻辑没变（`rounds_abs` 仍在报告里，只作跨臂观测）。

换云端强模型复测：

```bash
export YOUMI_EVAL_BASE_URL=https://<provider>/v1
export YOUMI_EVAL_MODEL=<model>
export YOUMI_EVAL_API_KEY=<key>

# 1) 哈希召回（默认）：快、确定，但无语义，会虚增往返 → 只用于归因对照
YOUMI_EVAL_REPORT=experiments/REPORT_TOOLCAT_CLOUD_HASH1000.md \
  python scripts/cloud_eval_tool_catalog.py --tools 1000 --arms inject

# 2) 真实召回：作结论用（模型已在本地缓存时靠离线开关跳过联网校验）
YOUMI_EVAL_EMBED=real HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  YOUMI_EVAL_REPORT=experiments/REPORT_TOOLCAT_CLOUD_REALEMBED.md \
  python scripts/cloud_eval_tool_catalog.py --tools 1000 --arms inject

python scripts/cloud_eval_tool_catalog.py --dry-run   # 无凭据时只验链路，不产出结论
```

> `YOUMI_EVAL_EMBED=real` 走 `youmi/mcp/dsh_catalog.py` 的 `LocalEmbedder`；
> 模型加载失败会**直接报错**而不是悄悄降级成关键词检索——那样跑出来的
> “真实召回”是假的。
> `--tools` 由 `_pool()` 断言把关：池子建不足当场报错，不会再交出一份规模对不上
> 的报告（曾经 `--tools 1000` 只建出 504 条）。
> `YOUMI_EVAL_REPORT` 缺省落 `experiments/REPORT_TOOLCAT_CLOUD.md`，做对照实验时
> 务必各指定文件名，别让后一跑覆盖前一跑；索引库默认按后端分开
> （`hash` → `.youmi/eval-cloud.db`，其余 → `.youmi/eval-cloud-<embed>.db`）。

## 故障排查

### sidecar 启动失败

检查 Python 环境:

```bash
python -c "from youmi.mcp.dsh_catalog import DshToolCatalog; print('OK')"
```

### 模型加载缓慢

首次运行会下载模型（约 130MB），后续使用本地缓存。已有本地缓存但网络受限时，设 `HF_HUB_OFFLINE=1`（配合 `TRANSFORMERS_OFFLINE=1`）跳过联网校验。

### 检索结果为空

1. 确认工具已索引: `await plugin.stats()`
2. 降低 min_score: `await plugin.search('query', 5, 0.1)`
3. 检查日志: `--log-level DEBUG`

## License

MIT
