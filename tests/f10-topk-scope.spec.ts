/**
 * f10-topk-scope.spec.ts — F10.2（top_k 尊重）+ F10.3（跨作用域并集 + 检索过滤）
 *
 * 全程不依赖 DSH 运行时（红线 2），用假 sidecar + 假 ctx.tools 钉住插件层行为：
 *
 * F10.2：
 * - 假 sidecar **无视请求条数、恒返回 20 条**，验证插件自身把结果裁到 top_k；
 * - top_k = 3 / 8 / 15 各自 ≤ 请求值；top_k = 20 按上限 maxTopK=15 处理并 cappedAt=15；
 * - search_tools 文案：`Found 15 tool(s)` 且带 top_k 超限说明。
 *
 * F10.3：
 * - 交替同步 Team / 非 Team 作用域后，并集索引**只增不删**（indexed 不减）；
 * - 检索按当前 scope 可见集**真正裁剪**：非 Team 不返回 team_task_*，Team 能返回。
 */

import { describe, expect, it, vi } from 'vitest'
import { YoumiCatalogPlugin } from '../src/index.js'
import { buildSearchDefinition, OWN_TOOL_NAMES } from '../src/plugin-tools.js'
import type { SearchResult } from '../src/types.js'

const signal = new AbortController().signal

function makeResult(tool_name: string, score = 1): SearchResult {
  return {
    tool_name,
    description: '',
    score,
    summary: tool_name,
    risk_level: 'low',
    required_permissions: [],
  }
}

// ======================================================================
// F10.2 · top_k
// ======================================================================

// 假 sidecar 恒返回整个池子（无视 topK），用来证明裁剪发生在插件层而非依赖 sidecar
const POOL: string[] = Array.from({ length: 20 }, (_, i) => `tool_${String(i).padStart(2, '0')}`)

function makeTopKFixture(maxTopK?: number) {
  const sidecar = {
    ready: true,
    info: { interpreter: 'python', pid: 1, lastError: null },
    search: vi.fn(async () => POOL.map(n => makeResult(n))),
    listToolNames: vi.fn(async () => [...POOL]),
    stats: vi.fn(async () => ({ embed_mode: 'keyword', fingerprints: POOL.length })),
  }
  const config = maxTopK !== undefined
    ? { embedMode: 'keyword' as const, maxTopK }
    : { embedMode: 'keyword' as const }
  const plugin = new YoumiCatalogPlugin(config, OWN_TOOL_NAMES)
  ;(plugin as unknown as { _sidecar: unknown })._sidecar = sidecar
  ;(plugin as unknown as { _catalogNames: Set<string> })._catalogNames = new Set(POOL)
  plugin.status.passSelfCheck()
  return { plugin, sidecar }
}

describe('F10.2 search 尊重 top_k（硬上限，不自作主张放大）', () => {
  it('top_k = 3 / 8 / 15 → 返回条数 ≤ 请求值', async () => {
    const { plugin } = makeTopKFixture()
    expect((await plugin.search('anything', 3)).results).toHaveLength(3)
    expect((await plugin.search('anything', 8)).results).toHaveLength(8)
    expect((await plugin.search('anything', 15)).results).toHaveLength(15)
  })

  it('top_k = 20 超过 maxTopK(15) → 按 15 返回并 cappedAt=15', async () => {
    const { plugin } = makeTopKFixture()
    const { results, cappedAt } = await plugin.search('anything', 20)
    expect(results).toHaveLength(15)
    expect(cappedAt).toBe(15)
  })

  it('top_k ≤ maxTopK 时不封顶（cappedAt=null）', async () => {
    const { plugin } = makeTopKFixture()
    expect((await plugin.search('anything', 8)).cappedAt).toBeNull()
  })

  it('自定义 maxTopK=4 生效', async () => {
    const { plugin } = makeTopKFixture(4)
    const { results, cappedAt } = await plugin.search('anything', 10)
    expect(results).toHaveLength(4)
    expect(cappedAt).toBe(4)
  })

  it('search_tools 文案：Found N = 实际条数，超限附说明', async () => {
    const { plugin } = makeTopKFixture()
    const searchDef = buildSearchDefinition(plugin)
    const out = String(await searchDef.execute(
      { query: 'anything', top_k: 20 },
      { callId: 'c1', name: 'search_tools', arguments: {}, signal },
    ))
    expect(out).toContain('Found 15 tool(s)')
    expect(out).toMatch(/top_k=20 exceeds the catalog cap/)
    // 头部 N 必须等于列出的条目数（这里 15 行签名）
    const listed = out.split('\n').filter(line => /^\d+\.\s/.test(line)).length
    expect(listed).toBe(15)
  })

  it('search_tools top_k=8 → Found 8 且无超限说明', async () => {
    const { plugin } = makeTopKFixture()
    const searchDef = buildSearchDefinition(plugin)
    const out = String(await searchDef.execute(
      { query: 'anything', top_k: 8 },
      { callId: 'c2', name: 'search_tools', arguments: {}, signal },
    ))
    expect(out).toContain('Found 8 tool(s)')
    expect(out).not.toMatch(/exceeds the catalog cap/)
  })
})

// ======================================================================
// F10.3 · 跨作用域并集 + 检索过滤
// ======================================================================

interface FakeDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const BASE: string[] = ['mcp_camera_snapshot', 'pwsh', 'read_file']
const TEAM: string[] = ['team_task_create', 'team_task_list']

function toDef(name: string): FakeDef {
  return { name, description: `desc of ${name}`, parameters: { type: 'object', properties: {} } }
}

const teamAgent = { id: 'team-agent' }
const plainAgent = { id: 'plain-agent' }

// 全局视图与 Team 会话可见 team_task_*；未开 Team Mode 的 agent 看不到
function poolFor(scope: unknown): FakeDef[] {
  if (scope === plainAgent) return BASE.map(toDef)
  return [...BASE, ...TEAM].map(toDef)
}

function makeScopeFixture() {
  const indexed = new Set<string>()
  const sidecar = {
    ready: true,
    info: { interpreter: 'python', pid: 1, lastError: null },
    indexTools: vi.fn(async (batch: Array<{ name: string }>) => {
      let added = 0
      let skipped = 0
      for (const it of batch) {
        if (indexed.has(it.name)) skipped += 1
        else {
          indexed.add(it.name)
          added += 1
        }
      }
      return { indexed: added, skipped, errors: 0 }
    }),
    removeTools: vi.fn(async (names: string[]) => {
      for (const n of names) indexed.delete(n)
      return { removed: names.length }
    }),
    // 真实 sidecar 会按 exclude 裁剪；这里模拟该行为以驱动 F10.3 第 2 层过滤
    search: vi.fn(async (_q: string, topK = 5, _minScore?: number, exclude: string[] = []) => {
      const ex = new Set(exclude)
      return [...indexed].filter(n => !ex.has(n)).slice(0, topK).map(makeResult)
    }),
    listToolNames: vi.fn(async () => [...indexed]),
    stats: vi.fn(async () => ({ embed_mode: 'keyword', fingerprints: indexed.size })),
  }
  const tools = { definitions: (scope?: unknown) => poolFor(scope) }
  const plugin = new YoumiCatalogPlugin({ embedMode: 'keyword' }, OWN_TOOL_NAMES)
  plugin.attach(tools as never)
  ;(plugin as unknown as { _sidecar: unknown })._sidecar = sidecar
  plugin.status.passSelfCheck()
  return { plugin, indexed, sidecar, tools }
}

describe('F10.3 跨作用域同步只增不删（并集）', () => {
  it('交替同步 Team / 非 Team 后 indexed 不减（team_task_* 保留）', async () => {
    const { plugin, indexed } = makeScopeFixture()
    await plugin.syncRegistry(teamAgent)
    expect(indexed.has('team_task_create')).toBe(true)

    // 未开 Team Mode 的会话再同步：视野里没有 team_task_*，但不得删除
    await plugin.syncRegistry(plainAgent)
    expect(indexed.has('team_task_create')).toBe(true)
    expect(indexed.has('team_task_list')).toBe(true)
    expect([...indexed].sort()).toEqual([...BASE, ...TEAM].sort())

    // 再切回 Team 会话也不应重复膨胀
    await plugin.syncRegistry(teamAgent)
    expect(indexed.size).toBe(BASE.length + TEAM.length)
  })

  it('带 scope 的同步从不调用 removeTools（删除只走全局对账）', async () => {
    const { plugin, sidecar } = makeScopeFixture()
    await plugin.syncRegistry(teamAgent)
    await plugin.syncRegistry(plainAgent)
    expect(sidecar.removeTools).not.toHaveBeenCalled()
  })
})

describe('F10.3 检索按当前 scope 过滤（视野 ≡ 派发视野）', () => {
  it('非 Team 会话搜索不返回 team_task_*；Team 会话能返回', async () => {
    const { plugin } = makeScopeFixture()
    await plugin.syncRegistry(teamAgent) // 并集索引含 team_task_*

    const plain = await plugin.search('team_task', 10, 0, { scope: plainAgent })
    const plainNames = plain.results.map(r => r.tool_name)
    expect(plainNames).not.toContain('team_task_create')
    expect(plainNames).not.toContain('team_task_list')

    const team = await plugin.search('team_task', 10, 0, { scope: teamAgent })
    const teamNames = team.results.map(r => r.tool_name)
    expect(teamNames).toContain('team_task_create')
    expect(teamNames).toContain('team_task_list')
  })

  it('ensureIndexed 标记 syncScope=union 并记录已知作用域数', async () => {
    const { plugin } = makeScopeFixture()
    await plugin.ensureIndexed(teamAgent)
    await plugin.ensureIndexed(plainAgent)
    const snap = await plugin.statusSnapshot(teamAgent)
    expect(snap.catalog.syncScope).toBe('union')
    expect(snap.catalog.scopeCount).toBeGreaterThanOrEqual(2)
  })
})
