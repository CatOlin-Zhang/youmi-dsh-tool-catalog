/**
 * detect.ts — Python 解释器探测（T10.2.3）
 *
 * 规则与 `scripts/selfcheck_sidecar.py` 完全一致（两边互为对照，谁改了另一边
 * 就必须跟着改，L2 自检会暴露漂移）：
 *
 * - 显式配置优先：`pythonCommand` 非空 → 只用它，不探测；
 * - 候选顺序：Windows `py -3` → `python` → `python3`；其他平台 `python3` → `python`；
 * - 探测内容：版本 + `httpx` / `numpy` / `pydantic` / `sentence_transformers`
 *   是否**可解析**（用 `importlib.util.find_spec`，不真导入，避免拉起 torch）；
 * - `embedMode=real` 时优先选「基础依赖齐 + 有 sentence-transformers」的解释器；
 *   找不到就退回第一个基础依赖齐的 —— 让 sidecar 在加载模型时**显式报错**并给出
 *   修复命令（红线 3：不静默降级，宁可失败也不伪造证据）。
 */

import { spawn } from 'node:child_process'

/** 探测一个解释器得到的事实（写进 catalog_status，供人诊断） */
export interface InterpreterProbe {
  /** 实际执行的 argv（空格拼接展示） */
  argv: string
  found: boolean
  version: string | null
  packages: Record<string, boolean>
  /** 探测本身的失败原因（解释器不存在 / 超时 / 输出不可解析） */
  error: string | null
}

export interface DetectResult {
  /** 选中的解释器 argv；null = 没有可用解释器 */
  argv: string[] | null
  /** 人类可读的选中说明（含「为何不用更强解释器」这类降级理由） */
  reason: string
  /** 全部探测记录，按尝试顺序 */
  probes: InterpreterProbe[]
}

/** sidecar 必需的基础第三方依赖（stdio_server + catalog 的静态闭包） */
const BASE_PACKAGES = ['httpx', 'numpy', 'pydantic'] as const

/** 向量通道依赖：embedMode=real 时需要，缺失不降级为 keyword */
const EMBED_PACKAGE = 'sentence_transformers'

/** 探测脚本：只查 spec，不导入重型包 */
const PROBE_CODE = [
  'import json, platform, importlib.util as u;',
  "names = ('httpx', 'numpy', 'pydantic', 'sentence_transformers');",
  'pkgs = {n: u.find_spec(n) is not None for n in names};',
  "print(json.dumps({'version': platform.python_version(), 'packages': pkgs}))",
].join('')

/** 候选解释器 argv（`YOUMI_PYTHON` 环境变量优先，与自检脚本同一入口） */
export function candidateInterpreters(env: NodeJS.ProcessEnv = process.env): string[][] {
  const fromEnv = (env.YOUMI_PYTHON ?? '').trim()
  if (fromEnv) return [[fromEnv]]
  if (process.platform === 'win32') return [['py', '-3'], ['python'], ['python3']]
  return [['python3'], ['python']]
}

/** 把配置里的 `pythonCommand` 字符串切成 argv（空格分隔，不支持引号转义） */
export function toArgv(pythonCommand: string): string[] {
  return pythonCommand.trim().split(/\s+/).filter(Boolean)
}

/** 运行一次解释器探测；不抛异常，失败信息落在 probe.error */
export function probeInterpreter(
  argv: string[],
  timeoutMs = 30_000,
): Promise<InterpreterProbe> {
  const info: InterpreterProbe = {
    argv: argv.join(' '),
    found: false,
    version: null,
    packages: {},
    error: null,
  }
  return new Promise<InterpreterProbe>(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], [...argv.slice(1), '-c', PROBE_CODE], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      info.error = String(err)
      resolve(info)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(info)
    }
    const timer = setTimeout(() => {
      info.error = `probe timed out after ${timeoutMs}ms`
      child.kill()
      finish()
    }, timeoutMs)

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (err: Error) => {
      info.error = `${err.name}: ${err.message}`
      finish()
    })
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        const tail = (stderr.trim() || stdout.trim()).split('\n').pop() ?? ''
        info.error = `exit ${code}: ${tail}`
        finish()
        return
      }
      const last = stdout.trim().split('\n').pop() ?? ''
      try {
        const payload = JSON.parse(last) as { version?: string; packages?: Record<string, boolean> }
        info.found = true
        info.version = payload.version ?? null
        info.packages = payload.packages ?? {}
      } catch (err) {
        info.error = `unparseable probe output: ${String(err)}`
      }
      finish()
    })
  })
}

function hasAll(packages: Record<string, boolean>, names: readonly string[]): boolean {
  return names.every(name => packages[name] === true)
}

/**
 * 按顺序探测解释器并选出要用的那个。
 *
 * @param embedMode `real` 时要求向量通道依赖，缺失不降级为关键词检索
 * @param candidates 覆盖候选列表（测试用）
 */
export async function detectInterpreter(
  embedMode: 'real' | 'keyword' = 'real',
  candidates: string[][] = candidateInterpreters(),
): Promise<DetectResult> {
  const probes: InterpreterProbe[] = []
  let fallback: string[] | null = null
  let fallbackReason = ''

  for (const argv of candidates) {
    const probe = await probeInterpreter(argv)
    probes.push(probe)
    if (!probe.found) continue
    if (!hasAll(probe.packages, BASE_PACKAGES)) {
      // 基础依赖都不齐：只能作为最后的候选（让 sidecar 报出 ImportError）
      if (fallback === null) {
        fallback = argv
        fallbackReason = `missing base deps (${BASE_PACKAGES.filter(p => probe.packages[p] !== true).join(', ')}) in ${probe.argv}`
      }
      continue
    }
    if (embedMode === 'real' && probe.packages[EMBED_PACKAGE] !== true) {
      if (fallback === null) {
        fallback = argv
        fallbackReason = `no ${EMBED_PACKAGE} in ${probe.argv}; embedMode=real will fail loudly`
      }
      continue
    }
    return {
      argv,
      reason: `selected ${probe.argv} (Python ${probe.version})`,
      probes,
    }
  }

  if (fallback !== null) {
    return { argv: fallback, reason: fallbackReason, probes }
  }
  return {
    argv: null,
    reason: `no usable Python interpreter among: ${probes.map(p => p.argv).join(', ') || '(no candidates)'}`,
    probes,
  }
}
