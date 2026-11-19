#!/usr/bin/env python3
"""
launcher.py — YouMi tool catalog sidecar 的 bundle 内入口

为什么需要它：`youmi/` 子集就放在本文件旁边（`sidecar/youmi/…`），但
`sys.path[0]` 默认是解释器脚本所在目录的**上级**或调用方的 cwd，DSH 拉起
子进程时 cwd 是 profile 目录，直接 `python -m youmi.mcp.stdio_server`
解析不到本包。因此这里把 `sidecar/` 插到 `sys.path[0]`，再转
``youmi.mcp.stdio_server.main()``。

约束（T10.2 / 红线 3、5）:
- stdout **只**写 JSON-RPC；日志一律走 stderr（由 stdio_server 配置）；
- 不读任何凭据，只透传环境变量；
- 只做兼容性环境变量兜底（conda 的 OpenMP 重复加载会直接终止进程），
  不静默掩盖任何功能故障 —— 模型缺失等问题仍由 stdio_server 显式报错。

用法::

    python launcher.py --db-path <path> --embed-model <name> --embed-mode real|keyword
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parent


def _hf_cache_has(model: str) -> bool:
    """本地 HF 缓存里是否已有该模型（决定能否强制离线）"""
    if not model:
        return False
    base = os.environ.get("HF_HOME") or str(Path.home() / ".cache" / "huggingface")
    hub = Path(base) / "hub"
    org, _, name = model.partition("/")
    dirname = f"models--{org}--{name}" if name else f"models--{model}"
    return (hub / dirname).is_dir()


def _embed_model_arg() -> str:
    """从 --embed-model 取模型名（launcher 只做环境兜底，不解析业务参数）"""
    argv = sys.argv
    for index, arg in enumerate(argv):
        if arg == "--embed-model" and index + 1 < len(argv):
            return argv[index + 1]
    return ""


def _prepare_env() -> list[str]:
    """补齐运行环境，返回本次实际设置过的变量（供诊断展示）"""
    adjusted: list[str] = []
    # conda / Anaconda 在 Windows 上常见 libiomp5md 重复加载：不设置该变量时
    # torch 导入会直接终止进程（OMP: Error #15），sidecar 无从报错。
    if sys.platform == "win32" and "KMP_DUPLICATE_LIB_OK" not in os.environ:
        os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
        adjusted.append("KMP_DUPLICATE_LIB_OK=TRUE")
    # 模型已在本地缓存时强制离线：企业网络下 huggingface_hub 的 etag 校验会被
    # TLS 中间设备阻断，initialize 会一路重试到 rpc 超时（30s）后整条链路失败。
    # 仅当缓存存在才设置，避免首次使用（需要下载）时把网络也关掉。
    if _hf_cache_has(_embed_model_arg()):
        for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
            if key not in os.environ:
                os.environ[key] = "1"
                adjusted.append(f"{key}=1")
    # tensorflow / transformers 的启动噪声走 stderr，会干扰诊断日志可读性
    for key, value in (("TF_CPP_MIN_LOG_LEVEL", "3"), ("TRANSFORMERS_VERBOSITY", "error")):
        if key not in os.environ:
            os.environ[key] = value
            adjusted.append(f"{key}={value}")
    # Windows 默认控制台编码不是 UTF-8，日志里的中文会显示成乱码（协议走字节写入，不受影响）
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        adjusted.append("stderr=utf-8")
    except (AttributeError, ValueError):
        pass
    return adjusted


def main() -> int:
    if str(SIDECAR_DIR) not in sys.path:
        sys.path.insert(0, str(SIDECAR_DIR))
    adjusted = _prepare_env()
    if adjusted:
        print(
            f"[launcher] env adjusted: {', '.join(adjusted)}",
            file=sys.stderr,
        )
    try:
        from youmi.mcp import stdio_server
    except Exception as exc:  # noqa: BLE001 — 子集残缺必须显式失败（不静默降级）
        print(f"[launcher] FATAL: cannot import youmi.mcp.stdio_server: {exc!r}", file=sys.stderr)
        return 2
    stdio_server.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
