"""
DSH 工具目录服务（LocalEmbedder + ToolStore 封装）

为 DSH 插件提供工具向量检索能力:
- ``LocalEmbedder``: sentence-transformers 本地 embedding（鸭子类型兼容 EmbeddingClient）
- ``DshToolCatalog``: 封装 ToolStore + LocalEmbedder，提供增量索引 / 锥形检索 / 统计

用法::

    from youmi.mcp.dsh_catalog import DshToolCatalog

    catalog = DshToolCatalog(
        db_path=".youmi/dsh-tools.db",
        embed_model="intfloat/multilingual-e5-small",
    )
    await catalog.initialize()

    # 增量索引 DSH 注册表工具
    result = await catalog.index_tools([
        {"name": "read_file", "description": "读取文件内容", "parameters": [...]},
    ])

    # 锥形检索
    hits = await catalog.search("读取文件", top_k=5)

模型使用 E5 前缀约定：
- 文档侧（索引）: ``"passage: <text>"``
- 查询侧（检索）: ``"query: <text>"``

调用方无需关心前缀 —— ``DshToolCatalog`` 在索引与检索路径上分别切换
``LocalEmbedder.mode``，由 embedder 内部自动拼接。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from youmi._vec_utils import cosine_similarity_python as _cosine_similarity

logger = logging.getLogger(__name__)


EmbedMode = Literal["index", "search"]

#: 向量通道开关：``real`` 必须有可用的 sentence-transformers 模型，
#: ``keyword`` 必须显式选择（关闭向量通道，仅关键词召回）。见 T10 红线 3：
#: 不得静默降级 —— real 模式下模型加载失败一律抛错。
EmbedProviderMode = Literal["real", "keyword"]

#: real 模式下模型不可用时给用户的修复命令
EMBED_INSTALL_HINT = "py -m pip install sentence-transformers"

#: 外部目录条目的 provider 标识（F11.1）。注册表工具默认是
#: ``dsh-registry``，两路进来的工具靠这个字段区分归属（externalCount /
#: registryCount）；``origin`` 列两边都是 ``external``（版本链语义，不能挪用）。
EXTERNAL_PROVIDER_ID = "external-catalog"


class LocalEmbedder:
    """sentence-transformers 本地 embedding 客户端

    鸭子类型兼容 ``EmbeddingClient``：提供 ``embed`` / ``embed_one`` /
    ``similarity`` 三个异步方法，可直接传给 ``ToolStore(embedding_client=…)``。

    Args:
        model_name: HuggingFace 模型标识（默认 ``intfloat/multilingual-e5-small``，
            384 维，跨语言对齐好，专为检索训练）。
        prefix_index: 索引侧前缀（默认 ``"passage: "``）。
        prefix_search: 查询侧前缀（默认 ``"query: "``）。
        required: ``True`` 时模型加载失败直接抛
            :class:`EmbeddingUnavailableError`（不降级）；``False`` 时仅记录
            warning，检索退化为关键词通道（供离线实验 / 单测使用）。
    """

    def __init__(
        self,
        model_name: str = "intfloat/multilingual-e5-small",
        prefix_index: str = "passage: ",
        prefix_search: str = "query: ",
        required: bool = False,
    ) -> None:
        self._model_name = model_name
        self._prefix_index = prefix_index
        self._prefix_search = prefix_search
        self._required = required
        self._mode: EmbedMode = "search"
        self._model: Any = None
        self._dimensions: int | None = None
        self._load_error: Exception | None = None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def load(self) -> None:
        """加载模型（幂等）。首次调用触发模型下载/加载，可能耗时 1–3 秒。

        ``required=True`` 时加载失败抛 :class:`EmbeddingUnavailableError`，
        错误信息携带修复命令；否则仅记录 warning（调用方自行决定是否降级）。
        """
        if self._model is not None:
            return
        if self._load_error is not None:
            if self._required:
                raise self._wrap_load_error(self._load_error)
            return
        try:
            self._model = await asyncio.to_thread(self._load_sync)
            self._dimensions = self._model.get_sentence_embedding_dimension()
            logger.info(
                "LocalEmbedder: loaded model %r (dim=%s)",
                self._model_name, self._dimensions,
            )
        except Exception as exc:  # noqa: BLE001 — 任何加载失败都需记录
            self._load_error = exc
            if self._required:
                wrapped = self._wrap_load_error(exc)
                logger.error("LocalEmbedder: %s", wrapped)
                raise wrapped from exc
            logger.warning(
                "LocalEmbedder: failed to load model %r, will degrade to "
                "keyword search: %s", self._model_name, exc,
            )

    def _wrap_load_error(self, exc: BaseException) -> EmbeddingUnavailableError:
        """把加载失败包装成携带修复命令的显式错误（不静默降级）"""
        return EmbeddingUnavailableError(
            f"embedding model {self._model_name!r} unavailable: {exc}. "
            f"Fix: `{EMBED_INSTALL_HINT}` (or set embedMode='keyword' explicitly "
            f"to run without the vector channel)."
        )

    def _load_sync(self) -> Any:
        # 延迟导入：sentence-transformers 是可选依赖
        from sentence_transformers import SentenceTransformer  # type: ignore[import-not-found]
        return SentenceTransformer(self._model_name)

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def required(self) -> bool:
        return self._required

    @property
    def load_error(self) -> BaseException | None:
        return self._load_error

    @property
    def dimensions(self) -> int | None:
        return self._dimensions

    @property
    def mode(self) -> EmbedMode:
        return self._mode

    def set_mode(self, mode: EmbedMode) -> None:
        """切换前缀模式：``'index'`` 用 passage 前缀，``'search'`` 用 query 前缀。"""
        self._mode = mode

    # ------------------------------------------------------------------
    # 核心方法（鸭子类型兼容 EmbeddingClient）
    # ------------------------------------------------------------------

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """批量生成文本向量（索引侧，自动加 ``passage:`` 前缀）

        注意：``embed`` 始终按"文档"语义加 passage 前缀，用于
        ``ToolVault.add_tools_from_provider`` 等批量入库路径。
        单条查询请用 ``embed_one``（按当前 mode 选前缀）。
        """
        if not texts:
            return []
        await self.load()
        if self._model is None:
            raise EmbeddingUnavailableError(
                f"model {self._model_name!r} not loaded: {self._load_error}"
            )
        prefixed = [self._prefix_index + t for t in texts]
        vectors = await asyncio.to_thread(
            lambda: self._model.encode(
                prefixed,
                convert_to_numpy=False,
                show_progress_bar=False,
            )
        )
        return [list(map(float, v)) for v in vectors]

    async def embed_one(self, text: str) -> list[float]:
        """单条文本生成向量（按当前 mode 选前缀）

        - ``mode='search'``（默认）：加 ``query:`` 前缀，用于 ``ToolStore.search_cone``
        - ``mode='index'``：加 ``passage:`` 前缀，用于 ``ToolStore._generate_embedding``
        """
        await self.load()
        if self._model is None:
            raise EmbeddingUnavailableError(
                f"model {self._model_name!r} not loaded: {self._load_error}"
            )
        prefix = (
            self._prefix_index if self._mode == "index" else self._prefix_search
        )
        result = await asyncio.to_thread(
            lambda: self._model.encode(
                prefix + text,
                convert_to_numpy=False,
                show_progress_bar=False,
            )
        )
        return [float(x) for x in result]

    async def similarity(
        self, query_vec: list[float], candidates: list[list[float]],
    ) -> list[float]:
        """批量计算查询向量与候选向量列表的余弦相似度"""
        return [_cosine_similarity(query_vec, c) for c in candidates]

    async def close(self) -> None:
        """释放模型引用（下次调用会重新加载）"""
        self._model = None

    async def __aenter__(self) -> "LocalEmbedder":
        await self.load()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    def __repr__(self) -> str:
        status = (
            f"dim={self._dimensions}" if self._model is not None
            else f"err={self._load_error!r}" if self._load_error is not None
            else "not-loaded"
        )
        return (
            f"<LocalEmbedder model={self._model_name!r} mode={self._mode!r} {status}>"
        )


class EmbeddingUnavailableError(Exception):
    """本地 embedding 不可用（模型加载失败或编码异常）"""
    pass


# ======================================================================
# DshToolCatalog — 封装 ToolStore + LocalEmbedder
# ======================================================================

# 默认向量维度（multilingual-e5-small = 384）
_DEFAULT_EMBED_DIM = 384


def _fingerprint(item: dict[str, Any]) -> str:
    """计算工具条目的内容指纹（用于增量索引差量）

    指纹 = sha256(name + description + canonical(params))
    只要名称/描述/参数结构不变，指纹就不变。
    """
    name = item.get("name", "")
    desc = item.get("description", "")
    params = item.get("parameters", [])
    # 参数规范化: 仅取 name/type/description/required 四元组，按 name 排序
    canonical_params = json.dumps(
        sorted(
            [
                {
                    "name": p.get("name", ""),
                    "type": p.get("type", "string"),
                    "description": p.get("description", ""),
                    "required": p.get("required", False),
                }
                for p in params
            ],
            key=lambda p: p["name"],
        ),
        sort_keys=True,
        ensure_ascii=False,
    )
    raw = f"{name}:{desc}:{canonical_params}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


_MAX_SIGNATURE_PARAMS = 8
_MAX_SIGNATURE_LEN = 160


def _format_param(p: Any) -> str:
    """单个参数渲染为 ``name: type`` / ``name?: type``（可选参数带 ``?``）"""
    optional = not getattr(p, "required", False)
    name = f"{p.name}?" if optional else p.name
    return f"{name}: {p.type}"


def _render_signature(tool_name: str, params: list[Any]) -> str:
    """渲染紧凑签名: ``send_email(to: str, subject: str, body: str, cc?: str)``

    规则（见 docs/tool-catalog-cache-friendly-plan.md T1）:
    - 必填参数在前，可选参数（``?``）在后，各自保持声明顺序
    - 参数超过 8 个时只列前 8 个，末尾加 ``…``
    - 整体长度超过 160 字符时截断并加 ``…``
    """
    required = [p for p in params if getattr(p, "required", False)]
    optional = [p for p in params if not getattr(p, "required", False)]
    ordered = required + optional

    truncated_params = len(ordered) > _MAX_SIGNATURE_PARAMS
    shown = ordered[:_MAX_SIGNATURE_PARAMS]
    rendered = ", ".join(_format_param(p) for p in shown)
    if truncated_params:
        rendered = f"{rendered}, …" if rendered else "…"

    sig = f"{tool_name}({rendered})"
    if len(sig) > _MAX_SIGNATURE_LEN:
        sig = sig[: _MAX_SIGNATURE_LEN - 1] + "…"
    return sig


def _param_brief(p: Any) -> dict[str, Any]:
    """参数精简视图: name/type/required/enum（不带 description，省 token）"""
    return {
        "name": p.name,
        "type": p.type,
        "required": bool(getattr(p, "required", False)),
        "enum": list(p.enum) if getattr(p, "enum", None) else None,
    }


_TAG_PREFIXES = {"领域": "domain", "动作": "action", "对象": "object"}


def _tags_to_triple(tags: list[str] | None) -> dict[str, str]:
    """从形如 ``["领域:通知", "动作:发送", "对象:邮件"]`` 的 tags 提取三元组，缺字段留空"""
    triple = {"domain": "", "action": "", "object": ""}
    for t in tags or []:
        for zh, key in _TAG_PREFIXES.items():
            if t.startswith(f"{zh}:"):
                triple[key] = t.split(":", 1)[1].strip()
    return triple


def _embed_text(item: dict[str, Any]) -> str:
    """拼接用于 embedding 的结构化文本（T2-3）

    把 ``领域/动作/对象`` 拼进前缀，例如::

        领域: 通知 | 动作: 发送 | 对象: 邮件 | send_email: 发送邮件通知

    - ``tags`` 里带 ``领域:/动作:/对象:`` 前缀时优先取用
    - 缺字段时从 ``name`` 拆词补齐（``-``/``_``/空格分词，第一段当动作，
      其余拼成对象），``领域`` 拆不出来就留空，不编造
    """
    name = item.get("name", "")
    desc = item.get("description", "")
    summary = item.get("summary") or desc[:80]

    triple = _tags_to_triple(item.get("tags"))
    domain, action, obj = triple["domain"], triple["action"], triple["object"]
    if not (domain or action or obj):
        tokens = [t for t in re.split(r"[_\-\s]+", name.lower()) if t]
        action = tokens[0] if tokens else ""
        obj = " ".join(tokens[1:]) if len(tokens) > 1 else ""

    parts = []
    if domain:
        parts.append(f"领域: {domain}")
    if action:
        parts.append(f"动作: {action}")
    if obj:
        parts.append(f"对象: {obj}")
    prefix = " | ".join(parts)
    body = f"{name}: {summary}"
    return f"{prefix} | {body}" if prefix else body


def _item_to_tool_entry(item: dict[str, Any]) -> Any:
    """将 DSH 注册表 JSON 条目转换为 ToolEntry

    Args:
        item: DSH 工具条目 (name, description, parameters, ...)

    Returns:
        ToolEntry 实例
    """
    from youmi.core.tool import ToolDefinition, ToolParameter
    from youmi.mcp.models import ToolEntry

    # 解析参数列表
    params: list[ToolParameter] = []
    for p in item.get("parameters", []):
        params.append(ToolParameter(
            name=p.get("name", ""),
            type=p.get("type", "string"),
            description=p.get("description", ""),
            required=p.get("required", False),
            enum=p.get("enum"),
            default=p.get("default"),
        ))

    # 构建 ToolDefinition
    defn = ToolDefinition(
        name=item["name"],
        description=item.get("description", ""),
        parameters=params,
        version=item.get("version", "1.0.0"),
        risk_level=item.get("risk_level", "low"),
        required_permissions=item.get("required_permissions", []),
    )

    # 构建 ToolEntry
    summary = item.get("summary") or item.get("description", "")[:80]
    return ToolEntry(
        tool_name=item["name"],
        definition=defn,
        summary=summary,
        essential=False,
        provider_id=item.get("provider_id", "dsh-registry"),
        version=item.get("version", "1.0.0"),
        origin="external",
        risk_level=item.get("risk_level", "low"),
        required_permissions=item.get("required_permissions", []),
        lineage_id=item["name"],
    )


class DshToolCatalog:
    """DSH 工具目录服务 — 封装 ToolStore + LocalEmbedder

    为 DSH 插件侧提供:
    - 增量索引: 基于内容指纹差量，仅 re-embed 变更工具
    - 锥形检索: 委托 ToolStore.search_cone（语义 + 风险 + tag 边界）
    - 统计诊断: 返回索引规模 / embedder 状态

    Args:
        db_path: SQLite 数据库路径（默认 ``.youmi/dsh-tools.db``）
        embed_model: sentence-transformers 模型名（默认 ``intfloat/multilingual-e5-small``）
        embedding_dim: 向量维度（默认 384，与上述模型匹配）
        embed_mode: 向量通道模式（默认 ``"real"``）
            - ``"real"``: 必须加载模型，失败即抛错（**不降级**）
            - ``"keyword"``: 显式关闭向量通道，不加载模型、不写向量
    """

    def __init__(
        self,
        db_path: str = ".youmi/dsh-tools.db",
        embed_model: str = "intfloat/multilingual-e5-small",
        embedding_dim: int = _DEFAULT_EMBED_DIM,
        embed_mode: EmbedProviderMode = "real",
    ) -> None:
        if embed_mode not in ("real", "keyword"):
            raise ValueError(f"embed_mode must be 'real' or 'keyword', got {embed_mode!r}")
        self._db_path = db_path
        self._embed_model = embed_model
        self._embedding_dim = embedding_dim
        self._embed_mode: EmbedProviderMode = embed_mode

        self._embedder: LocalEmbedder | None = None
        self._store: Any = None  # ToolStore 实例（延迟导入）
        self._fingerprints: dict[str, str] = {}  # tool_name → fingerprint
        #: 外部目录（F11.1）载入过的工具名集合；启动时按 provider_id 从库里恢复
        self._external_names: set[str] = set()
        self._initialized = False
        self._last_indexed_at: str | None = None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """初始化 catalog: 加载 embedder + 建表 + 恢复指纹缓存

        幂等: 多次调用仅首次生效。

        ``embed_mode='real'`` 下模型加载失败直接抛出
        :class:`EmbeddingUnavailableError`（错误信息含修复命令），catalog 进入
        未初始化状态；``embed_mode='keyword'`` 不加载模型，向量通道关闭。
        """
        if self._initialized:
            return

        # 1. 向量通道：real = 必加载（失败即抛）；keyword = 不建 embedder
        if self._embed_mode == "real":
            self._embedder = LocalEmbedder(model_name=self._embed_model, required=True)
            await self._embedder.load()
        else:
            self._embedder = None
            logger.info(
                "DshToolCatalog: vector channel disabled (embed_mode='keyword')",
            )

        # 2. 创建 ToolStore（独立 DB 路径，不干扰主 youmi 工具库）
        from youmi.mcp.tool_store import ToolStore

        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._store = ToolStore(
            db_path=self._db_path,
            embedding_client=self._embedder,
            embedding_dim=self._embedding_dim,
        )
        await self._store.initialize()

        # 3. 恢复指纹缓存: 从 DB 读取已有工具的指纹
        await self._restore_fingerprints()

        self._initialized = True
        logger.info(
            "DshToolCatalog initialized: db=%r, model=%r, dim=%d, mode=%r, tools=%d",
            self._db_path, self._embed_model, self._embedding_dim,
            self._embed_mode, len(self._fingerprints),
        )

    async def _restore_fingerprints(self) -> None:
        """从 DB 重建指纹缓存

        指纹不持久化（仅内存），启动时从现有工具定义重新计算。
        """
        if self._store is None:
            return
        try:
            entries = await self._store.list_tools()
            for entry in entries:
                item = {
                    "name": entry.tool_name,
                    "description": entry.definition.description,
                    "parameters": [
                        {
                            "name": p.name,
                            "type": p.type,
                            "description": p.description,
                            "required": p.required,
                        }
                        for p in entry.definition.parameters
                    ],
                }
                self._fingerprints[entry.tool_name] = _fingerprint(item)
                # F11.1：外部目录归属跟着 provider_id 走，重启后 externalCount 不归零
                if entry.provider_id == EXTERNAL_PROVIDER_ID:
                    self._external_names.add(entry.tool_name)
        except Exception as exc:
            logger.warning("DshToolCatalog: failed to restore fingerprints: %s", exc)

    async def close(self) -> None:
        """关闭 catalog，释放资源"""
        if self._store is not None:
            await self._store.close()
            self._store = None
        if self._embedder is not None:
            await self._embedder.close()
            self._embedder = None
        self._fingerprints.clear()
        self._external_names.clear()
        self._initialized = False

    async def __aenter__(self) -> "DshToolCatalog":
        await self.initialize()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    # ------------------------------------------------------------------
    # 增量索引
    # ------------------------------------------------------------------

    async def index_tools(
        self, items: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """增量索引 DSH 注册表工具

        对每个条目计算内容指纹:
        - 指纹未变 → 跳过（不 re-embed）
        - 指纹变化 / 新工具 → 生成 embedding 并 upsert

        Args:
            items: DSH 工具条目列表，每项含 name/description/parameters 等

        Returns:
            统计信息 ``{"indexed": N, "skipped": M, "errors": K}``
        """
        if not self._initialized:
            raise RuntimeError("DshToolCatalog not initialized")

        # real 模式下向量通道必须可用（不得静默写入无向量的行）
        self._require_vector_channel()

        indexed = 0
        skipped = 0
        errors = 0

        # 切换 embedder 到索引模式（passage 前缀）
        if self._embedder is not None:
            self._embedder.set_mode("index")

        try:
            for item in items:
                name = item.get("name", "")
                if not name:
                    errors += 1
                    continue

                fp = _fingerprint(item)
                if self._fingerprints.get(name) == fp:
                    skipped += 1
                    continue

                try:
                    entry = _item_to_tool_entry(item)

                    # 生成 embedding（结构化文本：领域/动作/对象前缀 + name: summary）
                    if self._embedder is not None and self._embedder.loaded:
                        self._embedder.set_mode("index")
                        try:
                            vec = await self._embedder.embed_one(
                                _embed_text(item)
                            )
                            entry = entry.model_copy(update={"embedding": vec})
                        except Exception as exc:
                            if self._embed_mode == "real":
                                # 不静默降级：real 模式下单条 embed 失败直接抛出
                                raise EmbeddingUnavailableError(
                                    f"embedding failed for '{name}': {exc}"
                                ) from exc
                            logger.warning(
                                "DshToolCatalog: embed failed for '%s': %s", name, exc,
                            )

                    # upsert 到 ToolStore
                    await self._store.upsert_tool(entry)
                    # tags（领域:/动作:/对象:）落 tool_tags 表，
                    # 供锥形 tag 边界与 search_by_tags 使用
                    for tag in item.get("tags") or []:
                        try:
                            await self._store.add_tag(name, tag)
                        except Exception as exc:
                            logger.warning(
                                "DshToolCatalog: add_tag failed for '%s' (%s): %s",
                                name, tag, exc,
                            )
                    self._fingerprints[name] = fp
                    indexed += 1

                except EmbeddingUnavailableError:
                    # real 模式下的向量故障不得转成 errors 计数（会造出假证据）
                    raise
                except Exception as exc:
                    logger.warning(
                        "DshToolCatalog: index failed for '%s': %s", name, exc,
                    )
                    errors += 1
        finally:
            # 恢复为搜索模式
            if self._embedder is not None:
                self._embedder.set_mode("search")

        logger.info(
            "DshToolCatalog.index_tools: indexed=%d, skipped=%d, errors=%d",
            indexed, skipped, errors,
        )
        if indexed:
            self._last_indexed_at = datetime.now(timezone.utc).isoformat()
        return {"indexed": indexed, "skipped": skipped, "errors": errors}

    async def remove_tools(self, names: list[str]) -> int:
        """从索引中移除工具

        Args:
            names: 工具名称列表

        Returns:
            成功移除的数量
        """
        if not self._initialized:
            raise RuntimeError("DshToolCatalog not initialized")

        removed = 0
        for name in names:
            try:
                ok = await self._store.delete_tool(name)
                if ok:
                    self._fingerprints.pop(name, None)
                    self._external_names.discard(name)
                    removed += 1
            except Exception as exc:
                logger.warning("DshToolCatalog: remove failed for '%s': %s", name, exc)

        return removed

    # ------------------------------------------------------------------
    # 外部目录（F11.1：超集形态的载入路径）
    # ------------------------------------------------------------------

    async def load_external_catalog(
        self, path: str, limit: int = 1000,
    ) -> dict[str, Any]:
        """从 JSONL 文件载入外部工具目录（评测形态，F11.1）

        一行一条 JSON，字段与 DSH 注册表条目兼容
        （name/description/summary/parameters/tags/version/risk_level）。
        解析后复用 :meth:`index_tools` 的指纹幂等写入，并把
        ``provider_id`` 改写为 :data:`EXTERNAL_PROVIDER_ID` 标记归属。

        不删除既有条目：外部目录与注册表索引共存（并集），调用方切回
        ``registry`` 模式无需重建库。

        Args:
            path: JSONL 文件路径
            limit: 载入条数上限（超出部分不读，返回 truncated=True）

        Returns:
            ``{"indexed", "skipped", "errors", "total", "parse_errors",
            "truncated", "source"}``；重复载入同内容全部 skipped。

        Raises:
            FileNotFoundError: 文件不存在（不静默空载入）
        """
        if not self._initialized:
            raise RuntimeError("DshToolCatalog not initialized")
        file = Path(path)
        if not file.is_file():
            raise FileNotFoundError(f"external catalog not found: {path}")

        items: list[dict[str, Any]] = []
        loaded_names: list[str] = []
        parse_errors = 0
        truncated = False
        with file.open("r", encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                text = line.strip()
                if not text:
                    continue
                if len(items) >= limit:
                    truncated = True
                    break
                try:
                    raw = json.loads(text)
                except json.JSONDecodeError as exc:
                    logger.warning(
                        "load_external_catalog: %s line %d invalid JSON: %s",
                        file.name, line_no, exc,
                    )
                    parse_errors += 1
                    continue
                if not isinstance(raw, dict) or not raw.get("name") or not raw.get("description"):
                    logger.warning(
                        "load_external_catalog: %s line %d missing name/description, skipped",
                        file.name, line_no,
                    )
                    parse_errors += 1
                    continue
                raw["provider_id"] = EXTERNAL_PROVIDER_ID
                items.append(raw)
                loaded_names.append(str(raw["name"]))

        result = await self.index_tools(items)
        self._external_names.update(loaded_names)
        result.update({
            "total": len(items),
            "parse_errors": parse_errors,
            "truncated": truncated,
            "source": str(file),
        })
        logger.info(
            "DshToolCatalog.load_external_catalog: %s -> indexed=%d skipped=%d "
            "errors=%d parse_errors=%d truncated=%s",
            file.name, result["indexed"], result["skipped"], result["errors"],
            parse_errors, truncated,
        )
        return result

    @property
    def external_names(self) -> set[str]:
        """已载入的外部目录工具名（F11.2 检索侧保留 ext_* 的依据）"""
        return set(self._external_names)

    async def get_tool(self, name: str) -> dict[str, Any] | None:
        """按名回读完整条目（含参数 schema），供插件侧 invoke 校验外部工具

        Returns:
            JSON 友好的条目 dict；不存在时 None。
        """
        if not self._initialized:
            raise RuntimeError("DshToolCatalog not initialized")
        entry = await self._store.get_tool(name)
        if entry is None:
            return None
        defn = entry.definition
        return {
            "name": entry.tool_name,
            "description": defn.description,
            "summary": entry.summary,
            "provider_id": entry.provider_id,
            "version": entry.version,
            "risk_level": entry.risk_level,
            "parameters": [
                {
                    "name": p.name,
                    "type": p.type,
                    "description": p.description,
                    "required": bool(p.required),
                    "enum": list(p.enum) if p.enum else None,
                }
                for p in defn.parameters
            ],
        }

    # ------------------------------------------------------------------
    # 向量通道
    # ------------------------------------------------------------------

    def _require_vector_channel(self) -> None:
        """real 模式下确认向量可用，不可用则抛错（**不回退关键词检索**）

        keyword 模式下为空操作（调用方已显式选择不用向量）。
        """
        if self._embed_mode != "real":
            return
        if self._embedder is None or not self._embedder.loaded:
            detail = self._embedder.load_error if self._embedder is not None else "no embedder"
            raise EmbeddingUnavailableError(
                f"vector search unavailable: model {self._embed_model!r} not loaded ({detail}). "
                f"Fix: `{EMBED_INSTALL_HINT}",
            )

    # ------------------------------------------------------------------
    # 检索
    # ------------------------------------------------------------------

    async def _resolve_parameters(self, r: Any) -> list[Any]:
        """取结果的参数列表；``definition`` 缺失时按名回读一次完整定义

        ``index_level='l2'`` 场景下 L3 schema 不随命中结果一并返回
        （``ToolSearchResult.definition`` 可能为 ``None``），此时回退到
        ``ToolStore.get_tool(name)`` 取完整定义，仍取不到则返回空列表。
        """
        if r.definition is not None:
            return list(r.definition.parameters)
        try:
            entry = await self._store.get_tool(r.tool_name)
        except Exception as exc:  # noqa: BLE001 — 回读失败不应影响本次检索返回
            logger.warning(
                "DshToolCatalog: get_tool fallback failed for '%s': %s",
                r.tool_name, exc,
            )
            return []
        if entry is None:
            return []
        return list(entry.definition.parameters)

    def _adaptive_truncate(
        self,
        results: list[Any],
        min_score: float,
        gap: float,
        max_k: int,
    ) -> list[Any]:
        """分数断崖截断：相邻分差 > gap 或低于 min_score 即停，上限 max_k

        F10.2：自适应截断**只能向下收敛**——本方法只负责在 ``max_k`` 保护内
        按断崖/阈值继续收缩，不会把结果数放大到调用请求之外。
        """
        kept = results[:max_k]
        for i in range(1, len(kept)):
            prev, curr = kept[i - 1], kept[i]
            if curr.score < min_score:
                return kept[:i]
            if prev.score - curr.score > gap:
                return kept[:i]
        return kept

    async def search(
        self,
        query: str,
        top_k: int = 5,
        min_score: float = 0.3,
        exclude: set[str] | None = None,
        adaptive_k: bool = True,
        gap: float = 0.08,
        max_k: int = 15,
    ) -> list[dict[str, Any]]:
        """锥形语义检索（携带紧凑签名，供模型一次往返即可调用）

        委托 ToolStore.search_cone，返回 JSON 可序列化的结果列表。

        Args:
            query: 自然语言查询
            top_k: 期望返回结果数量
            min_score: 最低相似度阈值
            exclude: 排除的工具名称集合
            adaptive_k: 是否启用分数断崖截断（默认 True）。开启时先取
                ``top_k*3`` 候选，再按断崖/阈值收敛；**只向下收敛，不会越过
                top_k 返回更多结果**（F10.2）。``max_k`` 仅作上限保护：
                ``top_k > max_k`` 时按 ``max_k`` 处理（返回条数 ≤ max_k，
                由调用方在文案里说明上限）
            gap: 相邻候选分差断崖阈值（超过则截断）
            max_k: 自适应截断的条数上限（保护性封顶，不作为放大目标）

        Returns:
            搜索结果列表，每项含 tool_name/description/score/summary/
            risk_level/required_permissions/parameters/signature
        """
        if not self._initialized:
            raise RuntimeError("DshToolCatalog not initialized")

        # real 模式：向量不可用时直接报错，不返回“看似正常”的关键词结果
        self._require_vector_channel()

        # 切换 embedder 到搜索模式（query 前缀）
        if self._embedder is not None:
            self._embedder.set_mode("search")

        # F10.2：top_k 是硬上限，max_k 只是保护性封顶——effective 取两者较小，
        # 自适应截断在此之上只做向下收敛，绝不把结果数放大回 max_k。
        effective_k = min(top_k, max_k) if adaptive_k else top_k
        fetch_k = effective_k * 3 if adaptive_k else effective_k
        try:
            results = await self._store.search_cone(
                query,
                top_k=fetch_k,
                min_score=min_score,
                exclude=exclude,
            )
        except Exception as exc:
            if self._embed_mode == "real":
                # 不静默降级：把失败原样上抛，由调用侧给出 CATALOG_UNAVAILABLE
                logger.error("DshToolCatalog: search failed (embed_mode=real): %s", exc)
                raise
            logger.warning("DshToolCatalog: search failed: %s", exc)
            return []

        if adaptive_k:
            results = self._adaptive_truncate(results, min_score, gap, effective_k)
        else:
            results = results[:effective_k]

        # 序列化为 JSON 友好格式（每项补齐 parameters / signature）
        out: list[dict[str, Any]] = []
        for r in results:
            params = await self._resolve_parameters(r)
            out.append({
                "tool_name": r.tool_name,
                "description": r.definition.description if r.definition else "",
                "score": round(r.score, 4),
                "summary": r.summary,
                "risk_level": r.risk_level,
                "required_permissions": r.required_permissions,
                "parameters": [_param_brief(p) for p in params],
                "signature": _render_signature(r.tool_name, params),
            })
        return out


    # ------------------------------------------------------------------
    # 诊断
    # ------------------------------------------------------------------

    async def stats(self) -> dict[str, Any]:
        """返回 catalog 统计信息"""
        if not self._initialized:
            return {"initialized": False}

        store_stats = await self._store.stats() if self._store else {}
        return {
            "initialized": True,
            "db_path": self._db_path,
            "embed_mode": self._embed_mode,
            "vector_channel": self._embed_mode == "real",
            "embed_model": self._embed_model,
            "embedding_dim": self._embedding_dim,
            "embedder_loaded": self._embedder.loaded if self._embedder else False,
            "embedder_dimensions": self._embedder.dimensions if self._embedder else None,
            "embedder_error": (
                str(self._embedder.load_error)
                if self._embedder is not None and self._embedder.load_error is not None
                else None
            ),
            "fingerprints": len(self._fingerprints),
            # F11.1：外部目录/注册表两路归属的实时计数（catalog_status 透传）
            "external_count": len(self._external_names),
            "registry_count": len(self._fingerprints) - len(
                self._external_names & set(self._fingerprints)
            ),
            "last_indexed_at": self._last_indexed_at,
            "store": store_stats,
        }

    @property
    def embed_mode(self) -> EmbedProviderMode:
        """当前向量通道模式（``real`` / ``keyword``）"""
        return self._embed_mode

    @property
    def tool_names(self) -> list[str]:
        """已索引的工具名称列表"""
        return sorted(self._fingerprints.keys())

    def __repr__(self) -> str:
        status = (
            f"tools={len(self._fingerprints)}" if self._initialized
            else "not-initialized"
        )
        return (
            f"<DshToolCatalog db={self._db_path!r} "
            f"model={self._embed_model!r} {status}>"
        )
