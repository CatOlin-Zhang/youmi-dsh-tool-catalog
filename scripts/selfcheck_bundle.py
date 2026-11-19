#!/usr/bin/env python3
"""
selfcheck_bundle.py — T10.6 L1 静态校验（无需 DSH）

校验内容：
- package.json 必填字段（name, version, type, main, exports, files, dsh.bundle.patch）
- index.js 存在（构建产物随包提交）
- cordis.patch.yml 可解析且结构正确
- locale/en.json + locale/zh.json 键齐全（meta.title / meta.description / meta.detail）
- icon.svg 存在且为合法 SVG
- files 覆盖索引（声明的文件确实存在于 bundle 目录）
- sidecar/launcher.py 存在
- sidecar/youmi/ 含 Python 文件

用法：
    python scripts/selfcheck_bundle.py --bundle <bundle_dir> [--output <report_dir>]

退出码：
    0 = 全部通过
    1 = 存在失败项
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


# ======================================================================
# 工具函数
# ======================================================================

def load_json(path: Path) -> tuple[Any, str | None]:
    """加载 JSON 文件，返回 (data, error_message)。"""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), None
    except FileNotFoundError:
        return None, f"file not found: {path}"
    except json.JSONDecodeError as e:
        return None, f"invalid JSON in {path.name}: {e}"
    except Exception as e:
        return None, f"cannot read {path.name}: {e}"


def try_parse_yaml(path: Path) -> tuple[Any, str | None]:
    """尝试解析 YAML（需要 pyyaml），失败时返回手动验证结果。"""
    try:
        import yaml  # type: ignore
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return data, None
    except ImportError:
        # 无 pyyaml：做基本文本验证
        try:
            text = path.read_text(encoding="utf-8")
            if "- insert:" in text and "id:" in text:
                return text, None  # 降级：标记为通过（文本级验证）
            return None, "pyyaml not installed and basic text validation failed"
        except FileNotFoundError:
            return None, f"file not found: {path}"
    except FileNotFoundError:
        return None, f"file not found: {path}"
    except Exception as e:
        return None, f"cannot parse {path.name}: {e}"


def is_valid_svg(path: Path) -> tuple[bool, str | None]:
    """验证 SVG 文件存在且格式基本合法。"""
    if not path.exists():
        return False, f"icon.svg not found at {path}"
    size = path.stat().st_size
    if size > 256 * 1024:
        return False, f"icon.svg exceeds 256 KiB ({size} bytes)"
    try:
        content = path.read_text(encoding="utf-8")
    except Exception as e:
        return False, f"cannot read icon.svg: {e}"
    if "<svg" not in content:
        return False, "icon.svg does not contain <svg root element"
    if "xmlns" not in content:
        return False, "icon.svg missing xmlns attribute"
    return True, None


# ======================================================================
# 检查项
# ======================================================================

class CheckResult:
    def __init__(self, name: str, passed: bool, detail: str = ""):
        self.name = name
        self.passed = passed
        self.detail = detail

    def to_dict(self) -> dict:
        return {"name": self.name, "passed": self.passed, "detail": self.detail}


def check_package_json(bundle: Path) -> list[CheckResult]:
    """验证 package.json 必填字段。"""
    results: list[CheckResult] = []
    pkg_path = bundle / "package.json"
    pkg, err = load_json(pkg_path)
    if err:
        results.append(CheckResult("package.json exists", False, err))
        return results
    results.append(CheckResult("package.json exists and parseable", True))

    # Required fields
    for field in ("name", "version", "type", "main"):
        val = pkg.get(field)
        if val is None:
            results.append(CheckResult(f"package.json.{field}", False, "missing"))
        else:
            results.append(CheckResult(f"package.json.{field}", True, str(val)))

    # type must be "module"
    if pkg.get("type") != "module":
        results.append(CheckResult("package.json.type=module", False, f"got: {pkg.get('type')}"))

    # main points to index.js
    if pkg.get("main") != "./index.js":
        results.append(CheckResult("package.json.main=./index.js", False, f"got: {pkg.get('main')}"))

    # exports
    exports = pkg.get("exports", {})
    if "." not in exports:
        results.append(CheckResult("package.json exports[.]", False, "missing"))
    else:
        results.append(CheckResult("package.json exports[.]", True, exports["."]))

    # dsh.bundle.patch
    dsh_cfg = pkg.get("dsh", {}).get("bundle", {}).get("patch")
    if dsh_cfg is None:
        results.append(CheckResult("package.json dsh.bundle.patch", False, "missing"))
    else:
        results.append(CheckResult("package.json dsh.bundle.patch", True, dsh_cfg))

    # files array
    files = pkg.get("files")
    if not isinstance(files, list) or len(files) == 0:
        results.append(CheckResult("package.json files[]", False, "missing or empty"))
    else:
        results.append(CheckResult("package.json files[]", True, f"{len(files)} entries"))

    # No workspace: protocol in any dependency
    deps = {}
    for section in ("dependencies", "devDependencies", "peerDependencies"):
        deps.update(pkg.get(section, {}))
    workspace_deps = [k for k, v in deps.items() if isinstance(v, str) and v.startswith("workspace:")]
    if workspace_deps:
        results.append(CheckResult("no workspace: protocol deps", False, str(workspace_deps)))
    else:
        results.append(CheckResult("no workspace: protocol deps", True))

    return results


def check_index_js(bundle: Path) -> list[CheckResult]:
    """验证构建产物 index.js 存在。"""
    idx = bundle / "index.js"
    if not idx.exists():
        return [CheckResult("index.js exists", False, f"not found: {idx}")]
    size = idx.stat().st_size
    if size < 100:
        return [CheckResult("index.js non-trivial", False, f"too small: {size} bytes")]
    return [CheckResult("index.js exists", True, f"{size} bytes")]


def check_cordis_patch(bundle: Path) -> list[CheckResult]:
    """验证 cordis.patch.yml。"""
    results: list[CheckResult] = []
    patch_path = bundle / "cordis.patch.yml"
    data, err = try_parse_yaml(patch_path)
    if err:
        results.append(CheckResult("cordis.patch.yml parseable", False, err))
        return results
    results.append(CheckResult("cordis.patch.yml parseable", True))

    # Structure: list with one item having 'insert' key
    if isinstance(data, str):
        # Text fallback validation already passed
        results.append(CheckResult("cordis.patch.yml structure (text-level)", True))
        return results

    if not isinstance(data, list):
        results.append(CheckResult("cordis.patch.yml is a list", False, f"got: {type(data).__name__}"))
        return results

    first = data[0] if data else {}
    insert_list = first.get("insert", []) if isinstance(first, dict) else []
    if not insert_list:
        results.append(CheckResult("cordis.patch.yml has insert[]", False))
        return results

    entry = insert_list[0] if isinstance(insert_list, list) else {}
    if entry.get("id") != "youmi-tool-catalog":
        results.append(CheckResult("cordis.patch.yml id", False, f"got: {entry.get('id')}"))
    else:
        results.append(CheckResult("cordis.patch.yml id", True))

    config = entry.get("config", {})
    expected_keys = {"embedMode", "mode", "topK", "minScore", "failOpen", "selfCheckOnStart"}
    missing = expected_keys - set(config.keys())
    if missing:
        results.append(CheckResult("cordis.patch.yml config keys", False, f"missing: {missing}"))
    else:
        results.append(CheckResult("cordis.patch.yml config keys", True))

    return results


def check_locale(bundle: Path) -> list[CheckResult]:
    """验证 locale/en.json 和 locale/zh.json。"""
    results: list[CheckResult] = []
    for lang in ("en", "zh"):
        locale_path = bundle / "locale" / f"{lang}.json"
        data, err = load_json(locale_path)
        if err:
            results.append(CheckResult(f"locale/{lang}.json", False, err))
            continue
        meta = data.get("meta", {}) if isinstance(data, dict) else {}
        for key in ("title", "description", "detail"):
            if key not in meta:
                results.append(CheckResult(f"locale/{lang}.json meta.{key}", False, "missing"))
            else:
                results.append(CheckResult(f"locale/{lang}.json meta.{key}", True, meta[key][:60]))
    return results


def check_icon(bundle: Path) -> list[CheckResult]:
    """验证 icon.svg。"""
    ok, err = is_valid_svg(bundle / "icon.svg")
    if err:
        return [CheckResult("icon.svg valid", False, err)]
    return [CheckResult("icon.svg valid", True)]


def check_files_coverage(bundle: Path) -> list[CheckResult]:
    """验证 package.json files[] 声明的路径确实存在。"""
    results: list[CheckResult] = []
    pkg_path = bundle / "package.json"
    pkg, err = load_json(pkg_path)
    if err:
        results.append(CheckResult("files coverage (skip: no package.json)", False, err))
        return results

    files = pkg.get("files", [])
    # Pattern entries (containing * or /**) — just verify the base dir exists
    for pattern in files:
        if "*" in pattern:
            # Extract base directory
            base = pattern.split("*")[0].rstrip("/")
            if base:
                p = bundle / base
                if p.exists():
                    results.append(CheckResult(f"files glob '{pattern}'", True, f"base dir exists: {base}"))
                else:
                    results.append(CheckResult(f"files glob '{pattern}'", False, f"base dir missing: {base}"))
            else:
                results.append(CheckResult(f"files glob '{pattern}'", True, "root-level glob"))
        else:
            p = bundle / pattern
            if p.exists():
                results.append(CheckResult(f"files '{pattern}'", True))
            else:
                results.append(CheckResult(f"files '{pattern}'", False, "NOT FOUND"))
    return results


def check_sidecar(bundle: Path) -> list[CheckResult]:
    """验证 sidecar 目录结构。"""
    results: list[CheckResult] = []
    launcher = bundle / "sidecar" / "launcher.py"
    if launcher.exists():
        results.append(CheckResult("sidecar/launcher.py", True))
    else:
        results.append(CheckResult("sidecar/launcher.py", False, "missing"))

    youmi_dir = bundle / "sidecar" / "youmi"
    if youmi_dir.exists() and youmi_dir.is_dir():
        py_files = list(youmi_dir.rglob("*.py"))
        if py_files:
            results.append(CheckResult("sidecar/youmi/ Python files", True, f"{len(py_files)} files"))
        else:
            results.append(CheckResult("sidecar/youmi/ Python files", False, "no .py files found"))
    else:
        results.append(CheckResult("sidecar/youmi/ directory", False, "missing"))

    # Check key modules exist
    key_modules = [
        "sidecar/youmi/mcp/stdio_server.py",
        "sidecar/youmi/mcp/dsh_catalog.py",
    ]
    for mod in key_modules:
        p = bundle / mod
        results.append(CheckResult(mod, p.exists(), "" if p.exists() else "missing"))

    return results


def check_packaging(bundle: Path) -> list[CheckResult]:
    """发布打包检查：files 覆盖脚本、sidecar 与根包不漂移、README 写明运行时依赖。"""
    results: list[CheckResult] = []
    pkg, err = load_json(bundle / "package.json")
    if err:
        results.append(CheckResult("packaging: package.json", False, err))
        return results

    files = pkg.get("files") or []
    results.append(CheckResult(
        "files includes scripts/**",
        any(str(item).startswith("scripts") for item in files),
        f"files={files}",
    ))
    results.append(CheckResult(
        "scripts/selfcheck_bundle.py shipped",
        (bundle / "scripts" / "selfcheck_bundle.py").exists(),
        "",
    ))

    # sidecar 与根包漂移：以 sync_sidecar.py --check 为权威（subset 是导入图子集，
    # 根包存在但未进 bundle 的模块属预期，不能按"逐个文件比对"判定）。
    repo_root = bundle.parents[1] if len(bundle.parents) >= 2 else None
    sync_script = bundle / "scripts" / "sync_sidecar.py"
    has_repo = repo_root is not None and (repo_root / "youmi").is_dir()
    if has_repo and sync_script.exists():
        try:
            proc = subprocess.run(
                [sys.executable, str(sync_script), "--check"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=180,
            )
            out = (proc.stdout or "") + (proc.stderr or "")
            passed = "(up to date)" in out
            detail = "in sync" if passed else "; ".join(
                line.strip() for line in out.splitlines() if line.strip().startswith(("copy ", "stub "))
            ) or out.strip()[-300:]
            results.append(CheckResult("sidecar in sync with repo youmi/mcp", passed, detail))
        except Exception as exc:  # noqa: BLE001
            results.append(CheckResult("sidecar in sync with repo youmi/mcp", False, f"check failed: {exc}"))
    else:
        results.append(CheckResult("sidecar drift check", True, "skipped (no repo checkout)"))

    readme = bundle / "README.md"
    text = readme.read_text(encoding="utf-8") if readme.exists() else ""
    results.append(CheckResult(
        "README documents runtime deps",
        "sentence-transformers" in text and "Python 3" in text,
        "",
    ))
    return results


# ======================================================================
# 主流程
# ======================================================================

def run_selfcheck(bundle: Path) -> list[CheckResult]:
    """执行所有检查项。"""
    if not bundle.is_dir():
        return [CheckResult("bundle directory", False, f"not a directory: {bundle}")]

    checks: list[CheckResult] = []
    checks.extend(check_package_json(bundle))
    checks.extend(check_index_js(bundle))
    checks.extend(check_cordis_patch(bundle))
    checks.extend(check_locale(bundle))
    checks.extend(check_icon(bundle))
    checks.extend(check_files_coverage(bundle))
    checks.extend(check_sidecar(bundle))
    checks.extend(check_packaging(bundle))
    return checks


def write_report(results: list[CheckResult], output_dir: Path) -> None:
    """输出 Markdown 和 JSON 报告。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    md_path = output_dir / "REPORT_T10_L1.md"
    json_path = output_dir / "REPORT_T10_L1.json"

    passed = sum(1 for r in results if r.passed)
    failed = sum(1 for r in results if not r.passed)
    total = len(results)

    # Markdown report
    lines = [
        "# T10.6 L1 — Bundle Static Validation Report",
        "",
        f"**Result: {'PASS' if failed == 0 else 'FAIL'}** ({passed}/{total} checks passed, {failed} failed)",
        "",
        "| # | Check | Status | Detail |",
        "|---|-------|--------|--------|",
    ]
    for i, r in enumerate(results, 1):
        status = "✅" if r.passed else "❌"
        detail = r.detail.replace("|", "\\|").replace("\n", " ") if r.detail else ""
        lines.append(f"| {i} | {r.name} | {status} | {detail} |")

    lines.append("")
    lines.append(f"Generated by `scripts/selfcheck_bundle.py`")
    md_path.write_text("\n".join(lines), encoding="utf-8")

    # JSON report
    json_data = {
        "suite": "T10.6_L1",
        "passed": passed,
        "failed": failed,
        "total": total,
        "ok": failed == 0,
        "checks": [r.to_dict() for r in results],
    }
    json_path.write_text(json.dumps(json_data, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"Report written: {md_path}")
    print(f"JSON written:   {json_path}")


def main():
    parser = argparse.ArgumentParser(description="T10.6 L1 bundle static validation")
    parser.add_argument("--bundle", type=Path, required=True, help="Path to the bundle directory")
    parser.add_argument("--output", type=Path, default=None, help="Report output directory (default: <repo>/experiments/)")
    args = parser.parse_args()

    bundle = args.bundle.resolve()
    print(f"Validating bundle: {bundle}")
    print("=" * 60)

    results = run_selfcheck(bundle)

    # Console output
    for r in results:
        mark = "✓" if r.passed else "✗"
        detail = f"  ({r.detail})" if r.detail else ""
        print(f"  [{mark}] {r.name}{detail}")

    print("=" * 60)
    passed = sum(1 for r in results if r.passed)
    failed = sum(1 for r in results if not r.passed)
    print(f"Result: {passed} passed, {failed} failed, {len(results)} total")

    # Write report
    output_dir = args.output if args.output else Path(__file__).resolve().parent.parent.parent.parent / "experiments"
    write_report(results, output_dir)

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
