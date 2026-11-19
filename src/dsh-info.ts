/**
 * dsh-info.ts — 宿主版本 / profile 的尽力探测（T10.3.2 `dsh` 字段）
 *
 * 0.2.2-rc.3 的插件 API **没有**暴露「我是哪个 DSH、跑在哪个 profile」的服务，
 * 因此这里只做可从环境事实推出的判断，并把来源一起报出去（`source`）；
 * 推不出来就写 `unknown` —— 绝不编造版本号（红线 3：不造假证据）。
 *
 * 依据（探测报告 §5 / desktop 运行时）：
 * - profile 目录恒为 `$DSH_HOME/profiles/<name>`，DSH 拉起时 cwd 就是该目录；
 * - `DSH_PROFILE` 环境变量若被显式设置，优先采用；
 * - 运行时包名固定为 `@deepseek-ai/dsh-desktop-runtime`（`app.asar/dsh/package.json`），
 *   若宿主的 node_modules 在本模块可解析范围内，就能读到版本。
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 本模块所在目录（不用 `import.meta.dirname`，避开 @types/node 版本差异） */
export function thisModuleDir(): string {
  return fileURLToPath(import.meta.url).replace(/[\\/][^\\/]+$/, '')
}

export interface DshInfo {
  version: string
  profile: string
  /** 每个字段的来源，便于判断可信度 */
  source: string
}

/** profile 名 = `<DSH_HOME>/profiles/<name>` 的最后一段 */
function profileFromCwd(cwd: string): string | null {
  const normalized = cwd.replace(/\\/g, '/')
  const match = /(?:^|\/)profiles\/([^/]+)\/?$/.exec(normalized)
  return match !== null ? match[1] : null
}

/** 尝试从宿主 node_modules 里读运行时包版本（向上找几层，失败即 null） */
function runtimeVersion(fromDir: string): string | null {
  let dir = fromDir
  for (let i = 0; i < 8; i++) {
    const cand = `${dir}/node_modules/@deepseek-ai/dsh/package.json`
    if (existsSync(cand)) {
      try {
        const pkg = JSON.parse(readFileSync(cand, 'utf-8')) as { version?: string }
        if (typeof pkg.version === 'string') return pkg.version
      } catch {
        return null
      }
    }
    const parent = dir.replace(/[\\/][^\\/]+$/, '')
    if (parent === dir || parent === '') break
    dir = parent
  }
  return null
}

/**
 * 探测宿主信息。
 *
 * @param env 环境变量映射（默认 process.env）
 * @param cwd 当前工作目录（DSH 拉起插件时是 profile 目录）
 * @param moduleDir 本模块所在目录（用于向上找宿主 node_modules）
 */
export function detectDshInfo(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  moduleDir: string = thisModuleDir(),
): DshInfo {
  const sources: string[] = []

  let profile = (env.DSH_PROFILE ?? '').trim()
  if (profile !== '') {
    sources.push('profile=$DSH_PROFILE')
  } else {
    profile = profileFromCwd(cwd) ?? 'unknown'
    sources.push(profile === 'unknown' ? 'profile=unknown(cwd not under <DSH_HOME>/profiles/)' : 'profile=from cwd')
  }

  const version = env.DSH_VERSION?.trim() || runtimeVersion(moduleDir) || 'unknown'
  sources.push(
    version === 'unknown'
      ? 'version=unknown(host package.json not resolvable)'
      : env.DSH_VERSION !== undefined && env.DSH_VERSION.trim() !== ''
        ? 'version=$DSH_VERSION'
        : 'version=@deepseek-ai/dsh package.json',
  )

  return { version, profile, source: sources.join('; ') }
}

/** 数据库默认路径：`<DSH_HOME>/youmi-catalog/dsh-tools.db`（配置留空时使用） */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = (env.DSH_HOME ?? '').trim()
    || (env.HOME ? `${env.HOME.replace(/\/+$/, '')}/.dsh` : '')
    || (env.USERPROFILE ? `${env.USERPROFILE.replace(/\\+$/, '')}/.dsh` : '')
    || '.dsh'
  const sep = home.includes('\\') ? '\\' : '/'
  return `${home}${sep}youmi-catalog${sep}dsh-tools.db`
}
