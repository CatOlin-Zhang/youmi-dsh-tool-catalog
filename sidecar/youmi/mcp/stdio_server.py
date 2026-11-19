"""
ndjson JSON-RPC 2.0 sidecar 服务

TS 插件通过 stdio 与本进程通信:
- stdin: 逐行 JSON-RPC 2.0 请求
- stdout: 逐行 JSON-RPC 2.0 响应
- stderr: 日志（不干扰协议）

协议::

    → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
    ← {"jsonrpc":"2.0","id":1,"result":{"status":"ok"}}

    → {"jsonrpc":"2.0","id":2,"method":"index_tools","params":{"items":[...]}}
    ← {"jsonrpc":"2.0","id":2,"result":{"indexed":3,"skipped":1,"errors":0}}

    → {"jsonrpc":"2.0","id":3,"method":"search","params":{"query":"读取文件","top_k":5}}
    ← {"jsonrpc":"2.0","id":3,"result":[{"tool_name":"read_file","score":0.87,...}]}

支持的方法:
- ``initialize``: 初始化 catalog（加载模型 + 建表）；可选 params
  ``{"catalogMode": "external", "externalCatalogPath": "...", "externalLimit": 1000}``
  —— external 模式下先载入外部目录再返回（F11.1）
- ``index_tools``: 增量索引工具
- ``load_external_catalog``: 从 JSONL 载入外部目录（F11.1，幂等）
- ``search``: 锥形语义检索
- ``get_tool``: 按名回读完整条目（含参数 schema，F11.2 invoke 校验用）
- ``list_external_names``: 已载入的外部目录工具名
- ``remove_tools``: 移除工具
- ``stats``: 统计诊断
- ``shutdown``: 关闭并退出

用法::

    python -m youmi.mcp.stdio_server [--db-path PATH] [--embed-model NAME] [--embed-mode real|keyword]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from typing import Any

from youmi.mcp.dsh_catalog import DshToolCatalog

logger = logging.getLogger("youmi.mcp.stdio_server")


# ---------------------------------------------------------------------------
# JSON-RPC 2.0 协议
# ---------------------------------------------------------------------------

def _make_response(id: Any, result: Any) -> str:
    """构造 JSON-RPC 2.0 成功响应"""
    return json.dumps(
        {"jsonrpc": "2.0", "id": id, "result": result},
        ensure_ascii=False,
    )


def _make_error(id: Any, code: int, message: str, data: Any = None) -> str:
    """构造 JSON-RPC 2.0 错误响应"""
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return json.dumps(
        {"jsonrpc": "2.0", "id": id, "error": error},
        ensure_ascii=False,
    )


# 标准 JSON-RPC 2.0 错误码
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


# ---------------------------------------------------------------------------
# RPC 方法分发
# ---------------------------------------------------------------------------

class RpcDispatcher:
    """JSON-RPC 方法分发器"""

    def __init__(self, catalog: DshToolCatalog) -> None:
        self._catalog = catalog
        self._methods: dict[str, Any] = {
            "initialize": self._initialize,
            "index_tools": self._index_tools,
            "load_external_catalog": self._load_external_catalog,
            "search": self._search,
            "get_tool": self._get_tool,
            "list_external_names": self._list_external_names,
            "remove_tools": self._remove_tools,
            "list_tool_names": self._list_tool_names,
            "stats": self._stats,
            "shutdown": self._shutdown,
        }

    async def dispatch(self, request: dict[str, Any]) -> str:
        """分发一个 JSON-RPC 请求，返回响应行"""
        req_id = request.get("id")
        method = request.get("method", "")
        params = request.get("params", {})

        if not method:
            return _make_error(req_id, INVALID_REQUEST, "missing 'method'")

        handler = self._methods.get(method)
        if handler is None:
            return _make_error(req_id, METHOD_NOT_FOUND, f"unknown method: {method}")

        try:
            result = await handler(params or {})
            return _make_response(req_id, result)
        except Exception as exc:
            logger.exception("RPC method '%s' failed", method)
            return _make_error(req_id, INTERNAL_ERROR, str(exc))

    # -- 方法实现 --

    async def _initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        await self._catalog.initialize()
        # F11.1：external 模式下 initialize 先载入外部目录（幂等，重复调用全 skipped）
        mode = str(params.get("catalogMode") or params.get("catalog_mode") or "registry")
        load: dict[str, Any] | None = None
        if mode == "external":
            path = str(params.get("externalCatalogPath") or params.get("external_catalog_path") or "")
            if not path:
                raise ValueError("catalogMode=external requires 'externalCatalogPath'")
            limit = int(params.get("externalLimit") or params.get("external_limit") or 1000)
            load = await self._catalog.load_external_catalog(path, limit)
        stats = await self._catalog.stats()
        result: dict[str, Any] = {
            "status": "ok",
            "embedMode": stats.get("embed_mode"),
            "vectorChannel": stats.get("vector_channel"),
            "dimensions": stats.get("embedder_dimensions"),
            "indexed": stats.get("fingerprints"),
            "catalogMode": mode,
            "externalCount": stats.get("external_count"),
            "registryCount": stats.get("registry_count"),
        }
        if load is not None:
            result["load"] = load
        return result

    async def _index_tools(self, params: dict[str, Any]) -> dict[str, Any]:
        items = params.get("items", [])
        if not isinstance(items, list):
            raise ValueError("'items' must be a list")
        return await self._catalog.index_tools(items)

    async def _load_external_catalog(self, params: dict[str, Any]) -> dict[str, Any]:
        """外部目录载入 RPC（F11.1）：与 initialize 自动载入同一条路径（--tools 等价能力）"""
        path = str(params.get("path") or "")
        if not path:
            raise ValueError("'path' is required")
        limit = int(params.get("limit") or 1000)
        return await self._catalog.load_external_catalog(path, limit)

    async def _get_tool(self, params: dict[str, Any]) -> dict[str, Any] | None:
        """按名回读完整条目（F11.2：插件侧对 ext_* 做 schema 校验的数据源）"""
        name = str(params.get("name") or "")
        if not name:
            raise ValueError("'name' is required")
        return await self._catalog.get_tool(name)

    async def _list_external_names(self, params: dict[str, Any]) -> list[str]:
        """已载入的外部目录工具名（插件检索侧保留 ext_* 的依据）"""
        return sorted(self._catalog.external_names)

    async def _search(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        query = params.get("query", "")
        if not query:
            raise ValueError("'query' is required")
        top_k = params.get("top_k", 5)
        min_score = params.get("min_score", 0.3)
        exclude = params.get("exclude")
        if exclude is not None:
            exclude = set(exclude)
        adaptive_k = params.get("adaptive_k", True)
        return await self._catalog.search(
            query, top_k=top_k, min_score=min_score, exclude=exclude,
            adaptive_k=adaptive_k,
        )

    async def _remove_tools(self, params: dict[str, Any]) -> dict[str, Any]:
        names = params.get("names", [])
        if not isinstance(names, list):
            raise ValueError("'names' must be a list")
        removed = await self._catalog.remove_tools(names)
        return {"removed": removed}

    async def _list_tool_names(self, params: dict[str, Any]) -> list[str]:
        """全部已索引工具名（invoke 元工具拼写建议的候选名池）"""
        return sorted(self._catalog.tool_names)

    async def _stats(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self._catalog.stats()

    async def _shutdown(self, params: dict[str, Any]) -> dict[str, Any]:
        await self._catalog.close()
        return {"status": "shutdown"}


# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------


def serve(
    db_path: str = ".youmi/dsh-tools.db",
    embed_model: str = "intfloat/multilingual-e5-small",
    embed_mode: str = "real",
) -> None:
    """启动 stdio JSON-RPC 服务

    从 stdin 逐行读取 JSON-RPC 请求，处理后写入 stdout。
    stderr 用于日志输出。

    实现细节：
    - I/O 采用同步 readline/write（避免 Windows ProactorEventLoop 的 pipe 句柄问题）
    - 业务逻辑保持 async，通过独立事件循环驱动

    Args:
        db_path: SQLite 数据库路径
        embed_model: sentence-transformers 模型名
        embed_mode: ``real``（向量通道必需，失败即报错）/ ``keyword``
            （显式关闭向量通道）
    """
    catalog = DshToolCatalog(
        db_path=db_path, embed_model=embed_model, embed_mode=embed_mode,  # type: ignore[arg-type]
    )
    dispatcher = RpcDispatcher(catalog)

    # 创建事件循环用于驱动 async 方法（不用于 stdio）
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    logger.info(
        "stdio_server started: db=%r, model=%r, embed_mode=%r",
        db_path, embed_model, embed_mode,
    )

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    try:
        while True:
            raw = stdin.readline()
            if not raw:
                break  # EOF
            text = raw.decode("utf-8").strip()
            if not text:
                continue

            # 解析 JSON
            try:
                request = json.loads(text)
            except json.JSONDecodeError as exc:
                resp = _make_error(None, PARSE_ERROR, f"invalid JSON: {exc}")
                stdout.write((resp + "\n").encode("utf-8"))
                stdout.flush()
                continue

            # 分发处理
            resp = loop.run_until_complete(dispatcher.dispatch(request))
            stdout.write((resp + "\n").encode("utf-8"))
            stdout.flush()

            # 检查是否 shutdown
            if request.get("method") == "shutdown":
                break
    finally:
        # 清理
        try:
            loop.run_until_complete(catalog.close())
        except Exception:
            pass
        loop.close()
        logger.info("stdio_server stopped")


def main() -> None:
    """CLI 入口"""
    parser = argparse.ArgumentParser(
        description="DSH Tool Catalog sidecar (ndjson JSON-RPC 2.0)",
    )
    parser.add_argument(
        "--db-path",
        default=".youmi/dsh-tools.db",
        help="SQLite 数据库路径 (默认: .youmi/dsh-tools.db)",
    )
    parser.add_argument(
        "--embed-model",
        default="intfloat/multilingual-e5-small",
        help="sentence-transformers 模型名 (默认: intfloat/multilingual-e5-small)",
    )
    parser.add_argument(
        "--embed-mode",
        default="real",
        choices=["real", "keyword"],
        help="向量通道模式: real = 必需加载模型(失败即报错), keyword = 显式关闭向量通道 (默认: real)",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="日志级别 (默认: INFO)",
    )

    args = parser.parse_args()

    # 日志输出到 stderr（不干扰 stdio 协议）
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )

    # Windows 下连接 stdin 管道需要 ProactorEventLoop（必须在建 loop 前设定）
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    serve(
        db_path=args.db_path, embed_model=args.embed_model, embed_mode=args.embed_mode,
    )


if __name__ == "__main__":
    main()
