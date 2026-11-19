#!/usr/bin/env python3
"""
verify_dsh_session.py — T10.6 L3：DSH 端到端会话验证（需人工发起一次会话）

前提：已在 DSH GUI 中安装 youmi-tool-catalog 插件并发起一次需要工具的对话。

定位 `$DSH_HOME` 下最新 session JSONL，断言：
1. 出现 `search_tools` 调用
2. 出现 `invoke` 调用（`UNKNOWN_TOOL` = 0）
3. 无 `CATALOG_UNAVAILABLE` / `CATALOG_EMPTY`
4. 输出 `rounds_to_first_call` 与调用构成

用法::

    python scripts/verify_dsh_session.py
    python scripts/verify_dsh_session.py --dsh-home <path> --profile <name>
    python scripts/verify_dsh_session.py --session <path_to_jsonl>

输出 `experiments/REPORT_T10_L3.md`（+ 同名 .json）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def find_dsh_home() -> Path:
    """Determine DSH_HOME from env or defaults."""
    explicit = os.environ.get("DSH_HOME", "").strip()
    if explicit:
        return Path(explicit)
    # Windows default
    if sys.platform == "win32":
        userprofile = os.environ.get("USERPROFILE", "").strip()
        if userprofile:
            return Path(userprofile) / ".dsh"
    # Unix default
    home = os.environ.get("HOME", "").strip()
    if home:
        return Path(home) / ".dsh"
    return Path(".dsh")


def find_latest_session(dsh_home: Path, profile: str | None) -> Path | None:
    """Locate the most recently modified session JSONL under DSH_HOME.

    DSH sessions typically reside in:
      - $DSH_HOME/profiles/<profile>/sessions/*.jsonl
      - $DSH_HOME/profiles/<profile>/conversations/*.jsonl
      - $DSH_HOME/sessions/*.jsonl
    We search all common locations and return the newest file by mtime.
    """
    search_patterns = [
        # <dsh_home>/profiles/<profile>/sessions/*.jsonl
        "profiles/*/sessions/*.jsonl",
        "profiles/*/conversations/*.jsonl",
        "profiles/*/chats/*.jsonl",
        # <dsh_home>/sessions/*.jsonl
        "sessions/*.jsonl",
        # GUI data
        "profiles/*/data/messages/*.jsonl",
    ]

    candidates: list[Path] = []
    for pattern in search_patterns:
        if profile:
            # Replace wildcard with specific profile
            concrete = pattern.replace("profiles/*/", f"profiles/{profile}/")
            candidates.extend(dsh_home.glob(concrete))
        else:
            candidates.extend(dsh_home.glob(pattern))

    if not candidates:
        return None

    # Return most recently modified
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


def _iter_session_lines(jsonl_path: Path):
    """按行读取会话日志；支持 zstd 压缩的 ``.jsonl.zstd``（DSH 默认形态）。

    DSH 写出的会话是 ``session.vN.jsonl.zstd``，直接按文本打开会
    ``UnicodeDecodeError``。这里按文件头魔数判断，需要 ``zstandard``。
    """
    with open(jsonl_path, "rb") as raw_head:
        magic = raw_head.read(4)
    if jsonl_path.suffix == ".zstd" or magic == b"\x28\xb5\x2f\xfd":
        try:
            import zstandard
        except ImportError as exc:  # pragma: no cover - 环境缺失时明确报错
            raise SystemExit(
                "会话是 zstd 压缩的，需要先安装 zstandard：pip install zstandard",
            ) from exc
        import io

        with open(jsonl_path, "rb") as raw:
            with zstandard.ZstdDecompressor().stream_reader(raw) as reader:
                yield from io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
    else:
        with open(jsonl_path, encoding="utf-8", errors="replace") as handle:
            yield from handle


def parse_session(jsonl_path: Path) -> dict:
    """Parse a session JSONL and extract tool-call information."""
    tool_calls: list[dict] = []
    tool_results: list[dict] = []
    messages: list[dict] = []
    line_count = 0

    for line in _iter_session_lines(jsonl_path):
        line = line.strip()
        if not line:
            continue
        line_count += 1
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        event_type = event.get("type", "")
        messages.append(event)

        # Extract tool calls (various DSH event shapes)
        # DSH v4 事件把字段放在 ``data`` 下，归一化到顶层供断言使用
        if event_type == "tool/call":
            data = event.get("data") or {}
            entry = dict(event)
            entry["name"] = data.get("name")
            entry["arguments"] = data.get("arguments")
            entry["turn"] = data.get("turn")
            entry["step"] = data.get("step")
            entry["callId"] = data.get("callId")
            tool_calls.append(entry)
        elif event_type == "tool/result" or "tool-call" in str(event.get("role", "")):
            tool_results.append(event)

        # Also check in content blocks (model output)
        content = event.get("content", [])
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "tool-call":
                        tool_calls.append(block)
                    elif block.get("type") == "tool-result":
                        tool_results.append(block)

        # Check for parts format (some DSH versions)
        parts = event.get("parts", [])
        if isinstance(parts, list):
            for part in parts:
                if isinstance(part, dict):
                    if part.get("type") == "tool-call" or part.get("toolCall"):
                        tool_calls.append(part)

    return {
        "line_count": line_count,
        "messages": messages,
        "tool_calls": tool_calls,
        "tool_results": tool_results,
    }


def analyze_session(data: dict) -> dict:
    """Analyze parsed session for T10.6 L3 assertions."""
    tool_calls = data["tool_calls"]
    tool_results = data["tool_results"]

    # Find search_tools calls
    search_calls = [c for c in tool_calls if c.get("name") == "search_tools" or "search_tools" in str(c)]
    # Find invoke calls
    invoke_calls = [c for c in tool_calls if c.get("name") == "invoke" or '"tool"' in str(c.get("arguments", ""))]
    # Find catalog_status calls
    status_calls = [c for c in tool_calls if c.get("name") == "catalog_status"]

    # Check for failure text in results
    all_text = json.dumps(tool_results)
    has_unavailable = "CATALOG_UNAVAILABLE" in all_text
    has_empty = "CATALOG_EMPTY" in all_text
    has_unknown_tool = "UNKNOWN_TOOL" in all_text

    # Count rounds to first catalog call: 用 tool/call 上的 step 计算（DSH v4 没有 role 字段）
    rounds_to_first_call = None
    catalog_call_steps = [
        c.get("step") for c in (search_calls + invoke_calls + status_calls)
        if isinstance(c.get("step"), int)
    ]
    if catalog_call_steps:
        rounds_to_first_call = min(catalog_call_steps)

    return {
        "search_tools_calls": len(search_calls),
        "invoke_calls": len(invoke_calls),
        "catalog_status_calls": len(status_calls),
        "has_catalog_unavailable": has_unavailable,
        "has_catalog_empty": has_empty,
        "has_unknown_tool": has_unknown_tool,
        "rounds_to_first_call": rounds_to_first_call,
        "total_tool_calls": len(tool_calls),
        "total_tool_results": len(tool_results),
    }


def render_report(analysis: dict, session_path: Path, passed: bool) -> str:
    lines = [
        "# T10.6 L3 · DSH 端到端会话验证",
        "",
        f"- 结论：**{'PASS' if passed else 'FAIL'}**",
        f"- 会话文件：`{session_path}`",
        f"- 验证时间：{datetime.now().isoformat()}",
        "",
        "## 断言",
        "",
        "| 断言 | 结果 | 值 |",
        "|---|---|---|",
    ]

    checks = get_checks(analysis)
    for name, ok, detail in checks:
        mark = "✅" if ok else "❌"
        lines.append(f"| {name} | {mark} | {detail} |")

    lines += [
        "",
        "## 调用统计",
        "",
        "```json",
        json.dumps(analysis, indent=2, ensure_ascii=False),
        "```",
        "",
    ]
    return "\n".join(lines)


def get_checks(analysis: dict) -> list[tuple[str, bool, str]]:
    return [
        ("出现 search_tools 调用", analysis["search_tools_calls"] > 0,
         f"count={analysis['search_tools_calls']}"),
        ("出现 invoke 调用", analysis["invoke_calls"] > 0,
         f"count={analysis['invoke_calls']}"),
        ("无 UNKNOWN_TOOL 错误", not analysis["has_unknown_tool"],
         f"found={analysis['has_unknown_tool']}"),
        ("无 CATALOG_UNAVAILABLE", not analysis["has_catalog_unavailable"],
         f"found={analysis['has_catalog_unavailable']}"),
        ("无 CATALOG_EMPTY", not analysis["has_catalog_empty"],
         f"found={analysis['has_catalog_empty']}"),
        ("rounds_to_first_call 有值", analysis["rounds_to_first_call"] is not None,
         f"rounds={analysis['rounds_to_first_call']}"),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="T10.6 L3 DSH session verification")
    parser.add_argument("--dsh-home", type=Path, default=None, help="DSH_HOME path")
    parser.add_argument("--profile", default=None, help="DSH profile name")
    parser.add_argument("--session", type=Path, default=None, help="Direct path to session JSONL")
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "experiments" / "REPORT_T10_L3.md")
    args = parser.parse_args()

    # Locate session
    session_path = args.session
    if session_path is None:
        dsh_home = args.dsh_home or find_dsh_home()
        session_path = find_latest_session(dsh_home, args.profile)
        if session_path is None:
            print(f"[L3] SKIP: no session JSONL found under {dsh_home}")
            print("  L3 requires a manual DSH session with tool usage.")
            print("  Use --session <path> to specify directly.")
            print("  Use --dsh-home <path> to override DSH_HOME.")
            # Write a skip report
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(
                "# T10.6 L3 · DSH 端到端会话验证\n\n"
                "- 结论：**SKIP**（未找到会话文件）\n"
                f"- DSH_HOME: `{dsh_home}`\n"
                f"- 需要人工在 DSH GUI 中发起一次需要工具的会话后重新运行\n",
                encoding="utf-8",
            )
            return 0  # Skip is not a failure

    if not session_path.exists():
        print(f"[L3] FAIL: session file not found: {session_path}")
        return 1

    print(f"[L3] Analyzing session: {session_path}")
    data = parse_session(session_path)
    analysis = analyze_session(data)

    checks = get_checks(analysis)
    passed = all(ok for _, ok, _ in checks)

    print(f"  search_tools calls: {analysis['search_tools_calls']}")
    print(f"  invoke calls: {analysis['invoke_calls']}")
    print(f"  rounds_to_first_call: {analysis['rounds_to_first_call']}")
    for name, ok, detail in checks:
        print(f"  [{'ok ' if ok else 'FAIL'}] {name}: {detail}")

    # Write reports
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render_report(analysis, session_path, passed), encoding="utf-8")
    json_path = args.out.with_suffix(".json")
    json_path.write_text(
        json.dumps({"layer": "L3", "session": str(session_path), "passed": passed, **analysis},
                   indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"\n[L3] {'PASS' if passed else 'FAIL'} → {args.out}")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
