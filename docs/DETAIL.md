# YouMi Tool Catalog — 插件详情

## 是什么

YouMi Tool Catalog 为 DSH 提供**基于向量语义检索的工具发现层**：

- 监听 DSH 工具注册表变更，自动增量索引所有可见工具的名称、描述和参数签名；
- 向模型暴露三个元工具（`search_tools`、`invoke`、`catalog_status`），让模型通过一次额外轮次即可访问注册表中的全部工具，无论它们是否已出现在当前请求的工具列表中；
- 后台运行一个 Python sidecar 进程负责 embedding 计算和相似度检索。

## 怎么用

安装后无需额外操作。插件在每次 DSH 启动时：

1. 自动探测可用的 Python 解释器（或遵循 `pythonCommand` 配置）；
2. 拉起 sidecar 进程并加载 embedding 模型；
3. 对当前注册表中的工具执行全量索引（首次可能需要数十秒）；
4. 注册 `search_tools` / `invoke` / `catalog_status` 三个工具。

模型使用流程：
- 当请求中已有工具无法完成任务时，模型调用 `search_tools(query)` 检索目录；
- 从返回的签名列表中选择目标，调用 `invoke(name, arguments)` 转发执行；
- 遇到检索异常时，调用 `catalog_status` 获取完整诊断信息。

## 配置项

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `pythonCommand` | `""` (自动探测) | Python 解释器命令（空格分隔 argv） |
| `dbPath` | `""` (DSH_HOME 下) | 向量数据库路径 |
| `embedModel` | `intfloat/multilingual-e5-small` | Embedding 模型名 |
| `embedMode` | `real` | `real`=向量检索；`keyword`=仅关键词 |
| `mode` | `inject` | 呈现模式：`inject` 不改注册表；`declare` 做 restrict |
| `topK` | `5` | 检索默认返回数 |
| `minScore` | `0.3` | 相似度阈值 |
| `failOpen` | `true` | sidecar 失败不阻塞 DSH |
| `selfCheckOnStart` | `true` | 启动时执行自检 |

## 限制

1. **`invoke` 不产生内层 `tool/call` 事件**：模型可见信息已由外层 `invoke` 调用与其结果完整落盘（回放无损），缺的只是内层调用的审计粒度。
2. **sidecar 依赖宿主 Python 环境**：bundle 只做探测与报错，不代装 Python 包；首次索引需加载 embedding 模型，1000 工具约需数十秒。
3. **`search_tools` 多一轮对话**：模型必须先搜索再调用，相比工具直接在请求列表中多一次 round-trip。
4. **不静默降级**：`embedMode=real` 且 sentence-transformers 缺失时直接报错并给出修复命令，不会回退关键词匹配。

## 健康检测

调用 `catalog_status` 返回结构化 JSON，包含：
- sidecar 进程状态与实际拉起命令
- Python 解释器版本和探测理由
- embedder 加载状态和修复命令（仅在需要时给出）
- 目录索引规模和最近索引时间
- 自检生命周期和失败原因

## 失败语义

| 情况 | 行为 |
|------|------|
| sidecar 未就绪 | `search_tools` → `CATALOG_UNAVAILABLE: <原因>`; `invoke` → 同; DSH 不受影响 |
| embedder 缺失 (`embedMode=real`) | 报错 + 修复命令; 不回退关键词 |
| 目录为空 | `CATALOG_EMPTY: 尚未索引到工具` |
