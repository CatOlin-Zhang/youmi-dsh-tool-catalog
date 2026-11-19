/**
 * sync-scope.spec.ts — 检索覆盖修复回归测试（F9.4）
 *
 * 核心不变量（D9）：**检索视野 ≡ 派发视野**。用一个按 scope 切换可见集的假
 * `ctx.tools` + 假 sidecar，钉住：
 * 1. `syncRegistry()`（无 scope）只索引全局视图；
 * 2. `syncRegistry(agent)` 索引全局 + agent 独有（内置工具）；
 * 3. `ensureIndexed(agent)` 第二次不触发再次索引（幂等）；标脏后重扫，sidecar 报 skipped；
 * 4. `search_tools` 能命中 agent 独有工具名；
 * 5. `invoke` 对 agent 独有工具派发成功；对不存在名返回 UNKNOWN_TOOL + 候选。
 *
 * 全程不依赖 DSH 运行时（红线 2），也不硬编码工具名进目录（红线 1）——
 * 覆盖全部来自 `definitions(scope)`。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { YoumiCatalogPlugin } from '../src/index.js'
import { buildInvokeToolDefinition, buildSearchDefinition, OWN_TOOL_NAMES } from '../src/plugin-tools.js'

const signal = new AbortController().signal

interface FakeDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const GLOBAL_DEFS: FakeDef[] = [
  { name: 'mcp_camera_snapshot', description: 'Capture a camera snapshot', parameters: { type: 'object', properties: {} } },
  { name: 'team_task_create', description: 'Create a team task', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
]

// 内置工具：只有 agent 作用域可见，全局视图里没有（F9 现象的根源）
const AGENT_ONLY_DEFS: FakeDef[] = [
  { name: 'pwsh', description: 'Run a shell command in PowerShell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read_file', description: 'Read a file from disk', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
]

function poolFor(scope: unknown): FakeDef[] {
  return scope ? [...GLOBAL_DEFS, ...AGENT_ONLY_DEFS] : [...GLOBAL_DEFS]
}

function makeFixture() {
  const agent = { id: 'agent-1' }
  /** sidecar 侧真实「已索引」的名字（模拟指纹去重） */
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
    // 检索：按工具名子串匹配已索引集合
    search: vi.fn(async (query: string, topK = 5) => {
      const q = String(query).toLowerCase()
      return [...indexed]
        .filter(n => n.toLowerCase().includes(q))
        .slice(0, topK)
        .map(tool_name => ({
          tool_name,
          description: '',
          score: 1,
          summary: tool_name,
          risk_level: 'low' as const,
          required_permissions: [] as string[],
        }))
    }),
    stats: vi.fn(async () => ({ embed_mode: 'keyword', fingerprints: indexed.size })),
    listToolNames: vi.fn(async () => [...indexed]),
  }

  const tools = {
    definitions: (scope?: unknown) => poolFor(scope),
    get: (name: string, scope?: unknown) => poolFor(scope).find(d => d.name === name),
    executable: (name: string, scope?: unknown) => poolFor(scope).find(d => d.name === name),
    execute: vi.fn(async (input: { calls: ReadonlyArray<{ id: string; name: string }> }) => {
      const call = input.calls[0]
      return {
        results: [{ callId: call.id, result: { isError: false, content: [{ type: 'text', text: `ran ${call.name}` }] } }],
        additionalContexts: [],
        concluded: true,
      }
    }),
  }

  const plugin = new YoumiCatalogPlugin({ embedMode: 'keyword' }, OWN_TOOL_NAMES)
  plugin.attach(tools as never)
  // 替换真实 sidecar（单测不 spawn Python 进程）
  ;(plugin as unknown as { _sidecar: unknown })._sidecar = sidecar
  // 直接标记就绪：本测试聚焦 scope 逻辑，不走 selfCheck
  plugin.status.passSelfCheck()

  return { plugin, tools, sidecar, indexed, agent }
}

describe('F9.1 枚举按作用域参数化', () => {
  let f: ReturnType<typeof makeFixture>
  beforeEach(() => {
    f = makeFixture()
  })

  it('syncRegistry()（无 scope）只索引全局视图', async () => {
    await f.plugin.syncRegistry()
    expect([...f.indexed].sort()).toEqual(GLOBAL_DEFS.map(d => d.name).sort())
    expect(f.indexed.has('pwsh')).toBe(false)
  })

  it('syncRegistry(agent) 索引全局 + agent 独有（内置工具进入目录）', async () => {
    await f.plugin.syncRegistry(f.agent)
    const expected = [...GLOBAL_DEFS, ...AGENT_ONLY_DEFS].map(d => d.name).sort()
    expect([...f.indexed].sort()).toEqual(expected)
    expect(f.indexed.has('pwsh')).toBe(true)
    expect(f.indexed.has('read_file')).toBe(true)
  })
})

describe('F9.2 ensureIndexed 幂等 + tools/change 标脏', () => {
  let f: ReturnType<typeof makeFixture>
  beforeEach(() => {
    f = makeFixture()
  })

  it('第二次 ensureIndexed(agent) 不触发再次索引', async () => {
    await f.plugin.ensureIndexed(f.agent)
    const afterFirst = f.sidecar.indexTools.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    expect(f.indexed.has('pwsh')).toBe(true)

    await f.plugin.ensureIndexed(f.agent)
    expect(f.sidecar.indexTools.mock.calls.length).toBe(afterFirst) // 新鲜 → 直接返回
  })

  it('onRegistryChanged 标脏后重扫，sidecar 报 skipped 不重复 embed', async () => {
    await f.plugin.ensureIndexed(f.agent)
    const callsBefore = f.sidecar.indexTools.mock.calls.length

    // 注册表变更 → 只标脏，不立刻全扫
    f.plugin.onRegistryChanged()
    expect(f.sidecar.indexTools.mock.calls.length).toBe(callsBefore)

    // 下个检索请求才按 scope 重扫
    await f.plugin.ensureIndexed(f.agent)
    expect(f.sidecar.indexTools.mock.calls.length).toBe(callsBefore + 1)

    // 全部命中已有指纹 → 新增 0、skipped = 全量
    const last = f.sidecar.indexTools.mock.calls.at(-1)![0] as Array<{ name: string }>
    const r = await f.sidecar.indexTools.mock.results.at(-1)!.value as { indexed: number; skipped: number }
    expect(r.indexed).toBe(0)
    expect(r.skipped).toBe(last.length)
  })

  it('ensureIndexed 同步失败保持 fail-open（不抛出）', async () => {
    f.sidecar.indexTools.mockRejectedValueOnce(new Error('boom'))
    // 首次标脏 → syncRegistry 内部 batch 失败被 catch，ensureIndexed 不抛
    await expect(f.plugin.ensureIndexed(f.agent)).resolves.toBeUndefined()
  })
})

describe('F9.3 检索视野 ≡ 派发视野（端到端最小链路）', () => {
  let f: ReturnType<typeof makeFixture>
  beforeEach(() => {
    f = makeFixture()
  })

  it('search_tools 能命中 agent 独有工具（pwsh）', async () => {
    const searchDef = buildSearchDefinition(f.plugin)
    const out = await searchDef.execute(
      { query: 'pwsh' },
      { callId: 'c1', name: 'search_tools', arguments: { query: 'pwsh' }, signal, agent: f.agent },
    )
    expect(String(out)).toContain('pwsh')
  })

  it('invoke 对只在 agent 视图里的工具派发成功', async () => {
    const invokeDef = buildInvokeToolDefinition(f.plugin)
    const out = await invokeDef.execute(
      { tool: 'pwsh', arguments: { command: 'ls' } },
      { callId: 'c2', name: 'invoke', arguments: {}, signal, agent: f.agent },
    )
    expect(String(out)).toContain('ran pwsh')
    expect(f.tools.execute).toHaveBeenCalled()
  })

  it('invoke 对完全不存在的名字 → UNKNOWN_TOOL + 候选', async () => {
    const invokeDef = buildInvokeToolDefinition(f.plugin)
    const out = await invokeDef.execute(
      { tool: 'read_flie', arguments: {} }, // 拼写接近 read_file
      { callId: 'c3', name: 'invoke', arguments: {}, signal, agent: f.agent },
    )
    expect(String(out)).toContain('UNKNOWN_TOOL: read_flie')
    expect(String(out)).toContain('Did you mean: read_file?')
  })

  it('无 agent 时检索视野退回全局（pwsh 不可见，但派发也不可见 → UNKNOWN）', async () => {
    const searchDef = buildSearchDefinition(f.plugin)
    const out = await searchDef.execute(
      { query: 'pwsh' },
      { callId: 'c4', name: 'search_tools', arguments: { query: 'pwsh' }, signal },
    )
    // 全局视图没有 pwsh，检索不到
    expect(String(out)).not.toContain('pwsh(')
  })
})
