# YouMi Tool Catalog for DSH · 安装说明（v0.2.0）

用途：为 DSH 增加「向量语义检索工具目录」：模型通过 `search_tools` 找到工具、`invoke` 调用，
`catalog_status` 查看健康状态。外部目录形态下可让请求头只保留 2 个元工具。

## 包内容

- `index.js`：插件运行时代码（ESM 单文件，`@deepseek-ai/*` 由宿主解析）
- `cordis.patch.yml`：bundle patch（插入 youmi-tool-catalog 条目）
- `locale/`、`icon.svg`、`docs/DETAIL.md`：插件市场显示元数据
- `sidecar/`：Python 检索服务（含 `launcher.py` 与 youmi 最小子集）
- `scripts/`：L1/L2/L3 自检脚本
- `README.md`：完整配置与协议文档

## 安装方式

### A. DSH 插件管理器（推荐）

1. 打开 DSH → **插件（Plugins）→ 添加插件**
2. 选择本目录（`youmi-dsh-tool-catalog-0.2.0`）
3. 安装后**重启 DSH Desktop**（bundle 以 link 安装，JS 模块在启动时加载）

### B. npm 包安装

```bash
npm install ./youmi-dsh-tool-catalog-0.2.0.tgz
```

## 运行时依赖（必须）

| 依赖 | 说明 |
|---|---|
| Python 3.10+ | 默认探测 `py -3` / `python` / `python3`，可用配置 `pythonCommand` 指定 |
| httpx、numpy | sidecar 基础依赖 |
| sentence-transformers + intfloat/multilingual-e5-small | 仅 `embedMode: real` 需要（模型约 130MB） |

```bash
pip install httpx numpy sentence-transformers>=2.2
```

无法安装模型时，在配置里显式设 `embedMode: keyword`（无向量，质量下降；不会静默降级）。

## 配置示例（profile 的 cordis.patch.yml）

```yaml
- id: youmi-tool-catalog
  name: "@youmi/dsh-tool-catalog"
  config:
    pythonCommand: ''          # 空 = 自动探测
    embedMode: real            # real | keyword
    mode: inject               # inject | declare
    catalogMode: registry      # registry | external
    externalCatalogPath: ''    # catalogMode=external 时填 JSONL 路径
    externalExecutor: mcp      # mcp（未实现会显式报错）| mock（仅评测）
    topK: 5
    minScore: 0.3
    failOpen: true
```

## 自检

```bash
python scripts/selfcheck_bundle.py --bundle . --output <可写目录>   # L1 静态
python scripts/selfcheck_sidecar.py --embed-mode real --tools 1000   # L2 协议
python scripts/verify_dsh_session.py --session <会话.jsonl.zstd>      # L3 端到端
```

## 版本与限制

- v0.2.0：检索按「查询语言 = 工具描述语言」设计（英文实测 19/19 top-1）
- `external` 形态的 mock 执行器仅供评测，无真实副作用
- 真实外部执行器（MCP）尚未实现