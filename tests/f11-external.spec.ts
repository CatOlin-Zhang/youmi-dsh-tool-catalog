/**
 * f11-external.spec.ts — F11.2 外部目录形态（catalogMode=external）
 *
 * 全程不依赖 DSH 运行时（红线 2），钉住三层行为：
 *
 * 纯逻辑层（external.ts）：
 * - mock 执行器返回确定性结构化结果（note 锚点，红线 1 的可识别性）；
 * - 失败语义与注册表路径一致：UNKNOWN_TOOL / INVALID_ARGS（附签名）/
 *   EXECUTOR_UNAVAILABLE（executor=mcp 不静默当 mock）；
 *
 * 插件层（YoumiCatalogPlugin + plugin-tools）：
 * - 检索 exclude 裁剪**保留 ext_***（红线 3：它们不在注册表可见集，但可派发）；
 * - invoke execute 对 ext_* 拦截走外部派发，**不查注册表、不转发注册表工具**；
 * - catalog_status 载荷带 catalogMode / externalCount / registryCount；
 *
 * 配置层（Cordis Config validate）：
 * - catalogMode=external 缺 externalCatalogPath → 拒绝（不静默空载入）；
 * - externalLimit 必须正整数；枚举字段非法值拒绝。
 */

import { describe, expect, it, vi } from 'vitest'
import { YoumiCatalogPlugin, Config } from '../src/index.js'
import { buildInvokeToolDefinition, OWN_TOOL_NAMES } from '../src/plugin-tools.js'
import {
  dispatchExternal,
  mockExecute,
  schemaFromEntry,
  signatureForEntry,
  briefsFromEntry,
  MOCK_EXECUTOR_NOTE,
  EXECUTOR_UNAVAILABLE,
} from '../src/external.js'
import type { ExternalInvokeDeps } from '../src/external.js'
import type { ExternalToolEntry } from '../src/sidecar.js'
import type { SearchResult } from '../src/types.js'

const signal = new AbortController().signal

const ENTRY: ExternalToolEntry = {
  name: 'ext_translate_text',
  description: 'Translate a block of text between natural languages.',
  risk_level: 'low',
  parameters: [
    { name: 'text', type: 'string', required: true },
    { name: 'target_lang', type: 'string', required: true, enum: ['en', 'zh'] },
    { name: 'tone', type: 'string', required: false },
  ],
}

function makeDeps(overrides: Partial<ExternalInvokeDeps> = {}): ExternalInvokeDeps {
  return {
    getEntry: async name => (name === ENTRY.name ? ENTRY : null),
    executor: () => 'mock',
    knownNames: () => [ENTRY.name],
    ...overrides,
  }
}

// ======================================================================
// 纯逻辑层：external.ts
// ======================================================================

describe('F11.2 schemaFromEntry / signatureForEntry / mockExecute', () => {
  it('parameters 列表 → JSON Schema object 根（required / enum 齐全）', () => {
    const schema = schemaFromEntry(ENTRY)
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['text', 'target_lang'])
    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(props.target_lang.enum).toEqual(['en', 'zh'])
  })

  it('缺 parameters 的条目 → 空 properties 的 object 根', () => {
    const schema = schemaFromEntry({ name: 'ext_no_params', description: 'x' })
    expect(schema.type).toBe('object')
    expect(schema.required).toBeUndefined()
  })

  it('签名渲染与注册表工具同一套规则（必填在前、可选带 ?）', () => {
    const sig = signatureForEntry(ENTRY)
    expect(sig.startsWith('ext_translate_text(')).toBe(true)
    expect(sig).toContain('text')
    expect(sig).toContain('target_lang')
    expect(sig).toContain('tone?')
  })

  it('briefsFromEntry(undefined) → []', () => {
    expect(briefsFromEntry(undefined)).toEqual([])
  })

  it('mock 执行器返回确定性结构化结果（note 锚点可识别评测形态）', () => {
    const parsed = JSON.parse(mockExecute('ext_translate_text', { text: 'hi' }))
    expect(parsed).toEqual({
      ok: true,
      tool: 'ext_translate_text',
      args_echo: { text: 'hi' },
      note: MOCK_EXECUTOR_NOTE,
    })
  })
})

describe('F11.2 dispatchExternal 失败语义（与注册表路径一致）', () => {
  it('合法参数 → mock 结果 JSON', async () => {
    const out = await dispatchExternal('ext_translate_text', { text: 'hi', target_lang: 'zh' }, makeDeps())
    const parsed = JSON.parse(out)
    expect(parsed.ok).toBe(true)
    expect(parsed.args_echo).toEqual({ text: 'hi', target_lang: 'zh' })
  })

  it('条目不存在 → UNKNOWN_TOOL（sidecar 查不到 ≠ 执行成功，红线 1）', async () => {
    const out = await dispatchExternal('ext_ghost', {}, makeDeps())
    expect(out.startsWith('UNKNOWN_TOOL: ext_ghost')).toBe(true)
  })

  it('arguments 非对象 → INVALID_ARGS + 完整签名', async () => {
    const out = await dispatchExternal('ext_translate_text', 'oops', makeDeps())
    expect(out.startsWith('INVALID_ARGS:')).toBe(true)
    expect(out).toContain('Expected signature: ext_translate_text(')
  })

  it('缺必填参数 → INVALID_ARGS 指出参数名 + 签名', async () => {
    const out = await dispatchExternal('ext_translate_text', { text: 'hi' }, makeDeps())
    expect(out).toMatch(/INVALID_ARGS:.*target_lang/)
    expect(out).toContain('Expected signature:')
  })

  it('enum 违规 → INVALID_ARGS 列出候选值', async () => {
    const out = await dispatchExternal(
      'ext_translate_text', { text: 'hi', target_lang: 'fr' }, makeDeps(),
    )
    expect(out).toMatch(/INVALID_ARGS:.*target_lang.*\[en, zh\]/)
  })

  it('类型违规 → INVALID_ARGS（string 传了 number）', async () => {
    const out = await dispatchExternal(
      'ext_translate_text', { text: 123, target_lang: 'en' }, makeDeps(),
    )
    expect(out).toMatch(/INVALID_ARGS:.*text.*must be of type string/)
  })

  it('executor=mcp → EXECUTOR_UNAVAILABLE，绝不静默当 mock 跑', async () => {
    const out = await dispatchExternal(
      'ext_translate_text', { text: 'hi', target_lang: 'en' },
      makeDeps({ executor: () => 'mcp' }),
    )
    expect(out.startsWith(EXECUTOR_UNAVAILABLE)).toBe(true)
    expect(out).not.toContain(MOCK_EXECUTOR_NOTE)
  })
})

// ======================================================================
// 插件层：检索保留 ext_* / invoke 拦截 / catalog_status
// ======================================================================

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

const REG_VISIBLE = ['pwsh', 'read_file']
const REG_HIDDEN = ['team_task_create'] // 当前 scope 不可见的注册表工具
const EXT_NAMES = ['ext_translate_text', 'ext_search_flights']

function makeExternalFixture(executor: 'mock' | 'mcp' = 'mock') {
  const registryExecute = vi.fn(async () => ({
    results: [{
      callId: 'c:invoke',
      result: { isError: false, content: [{ type: 'text' as const, text: 'REGISTRY_FORWARDED' }] },
    }],
    additionalContexts: [],
    concluded: false,
  }))
  const tools = {
    // 当前 scope 可见集：只有注册表工具（ext_* 永远不在里面，红线 3）
    definitions: () => REG_VISIBLE.map(name => ({
      name,
      description: `desc of ${name}`,
      parameters: { type: 'object', properties: {} },
    })) as never,
    get: (name: string) => (
      [...REG_VISIBLE].includes(name)
        ? { name, parameters: { type: 'object', properties: {} } }
        : undefined
    ),
    execute: registryExecute,
  }
  const sidecar = {
    ready: true,
    info: { interpreter: 'python', pid: 1, lastError: null },
    indexTools: vi.fn(async (batch: Array<{ name: string }>) => ({
      indexed: 0, skipped: batch.length, errors: 0,
    })),
    removeTools: vi.fn(async (names: string[]) => ({ removed: names.length })),
    // 真实 sidecar 会按 exclude 裁剪，这里模拟该行为驱动「检索保留 ext_*」断言
    search: vi.fn(async (_q: string, topK = 5, _m?: number, exclude: string[] = []) => {
      const ex = new Set(exclude)
      return [...REG_VISIBLE, ...REG_HIDDEN, ...EXT_NAMES]
        .filter(n => !ex.has(n)).slice(0, topK).map(makeResult)
    }),
    listToolNames: vi.fn(async () => [...REG_VISIBLE, ...REG_HIDDEN, ...EXT_NAMES]),
    listExternalNames: vi.fn(async () => [...EXT_NAMES]),
    getTool: vi.fn(async (name: string) => (name === ENTRY.name ? ENTRY : null)),
    stats: vi.fn(async () => ({
      embed_mode: 'keyword',
      fingerprints: REG_VISIBLE.length + REG_HIDDEN.length + EXT_NAMES.length,
      external_count: EXT_NAMES.length,
      registry_count: REG_VISIBLE.length + REG_HIDDEN.length,
    })),
  }
  const plugin = new YoumiCatalogPlugin(
    { embedMode: 'keyword', catalogMode: 'external', externalCatalogPath: 'x.jsonl', externalExecutor: executor },
    OWN_TOOL_NAMES,
  )
  plugin.attach(tools as never)
  Object.assign(plugin as unknown as Record<string, unknown>, { _sidecar: sidecar })
  const internals = plugin as unknown as {
    _catalogNames: Set<string>
    _externalNames: Set<string>
    _tools: unknown
  }
  internals._catalogNames = new Set([...REG_VISIBLE, ...REG_HIDDEN, ...EXT_NAMES])
  internals._externalNames = new Set(EXT_NAMES)
  internals._tools = tools
  plugin.status.passSelfCheck()
  return { plugin, sidecar, tools, registryExecute }
}

describe('F11.2 检索视野 ≡ 派发视野（exclude 裁剪保留 ext_*）', () => {
  it('scope 可见集不含 ext_*，但检索结果仍含 ext_*；不可见注册表工具被裁掉', async () => {
    const { plugin, sidecar } = makeExternalFixture()
    const { results } = await plugin.search('anything', 20, 0, { scope: undefined })
    const names = results.map(r => r.tool_name)
    expect(names).toContain('ext_translate_text')
    expect(names).toContain('ext_search_flights')
    expect(names).not.toContain('team_task_create')
    // exclude 里不得出现 ext_*（否则 sidecar 把它们裁掉，派发却仍可命中 → 反向破坏不变量）
    const exclude = sidecar.search.mock.calls[0]?.[3] ?? []
    for (const n of EXT_NAMES) expect(exclude).not.toContain(n)
    expect(exclude).toContain('team_task_create')
  })

  it('registry 模式（_externalNames 为空）下行为与 F10.3 一致：不可见即裁剪', async () => {
    const { plugin, sidecar } = makeExternalFixture()
    ;(plugin as unknown as { _externalNames: Set<string> })._externalNames = new Set()
    await plugin.search('anything', 20, 0, { scope: undefined })
    const exclude = sidecar.search.mock.calls[0]?.[3] ?? []
    expect(exclude).toContain('ext_translate_text')
  })
})

describe('F11.2 invoke 外部派发拦截（plugin-tools execute 层）', () => {
  it('ext_* 命中 → mock JSON 结果，不发注册表转发、不补索引', async () => {
    const { plugin, sidecar, registryExecute } = makeExternalFixture()
    const invokeDef = buildInvokeToolDefinition(plugin)
    const out = String(await invokeDef.execute(
      { tool: 'ext_translate_text', arguments: { text: 'hi', target_lang: 'zh' } },
      { callId: 'c', name: 'invoke', arguments: {}, signal },
    ))
    expect(JSON.parse(out)).toEqual({
      ok: true,
      tool: 'ext_translate_text',
      args_echo: { text: 'hi', target_lang: 'zh' },
      note: MOCK_EXECUTOR_NOTE,
    })
    expect(registryExecute).not.toHaveBeenCalled()
    expect(sidecar.indexTools).not.toHaveBeenCalled()
    expect(sidecar.getTool).toHaveBeenCalledWith('ext_translate_text')
  })

  it('ext_* 参数违规 → INVALID_ARGS（arg_error_rate 的可判定来源）', async () => {
    const { plugin } = makeExternalFixture()
    const invokeDef = buildInvokeToolDefinition(plugin)
    const out = String(await invokeDef.execute(
      { tool: 'ext_translate_text', arguments: { text: 'hi' } },
      { callId: 'c', name: 'invoke', arguments: {}, signal },
    ))
    expect(out).toMatch(/^INVALID_ARGS:.*target_lang/)
  })

  it('executor=mcp → EXECUTOR_UNAVAILABLE，评测成功率不会被假 mock 抬高', async () => {
    const { plugin } = makeExternalFixture('mcp')
    const invokeDef = buildInvokeToolDefinition(plugin)
    const out = String(await invokeDef.execute(
      { tool: 'ext_translate_text', arguments: { text: 'hi', target_lang: 'zh' } },
      { callId: 'c', name: 'invoke', arguments: {}, signal },
    ))
    expect(out.startsWith(EXECUTOR_UNAVAILABLE)).toBe(true)
  })

  it('注册表工具不受拦截影响：仍走补索引 + 注册表转发', async () => {
    const { plugin, sidecar, registryExecute } = makeExternalFixture()
    const invokeDef = buildInvokeToolDefinition(plugin)
    const out = String(await invokeDef.execute(
      { tool: 'pwsh', arguments: {} },
      { callId: 'c', name: 'invoke', arguments: {}, signal },
    ))
    expect(out).toContain('REGISTRY_FORWARDED')
    expect(registryExecute).toHaveBeenCalled()
    expect(sidecar.indexTools).toHaveBeenCalled()
  })

  it('非外部且不在注册表 → 原语义 UNKNOWN_TOOL（拦截不放水）', async () => {
    const { plugin } = makeExternalFixture()
    const invokeDef = buildInvokeToolDefinition(plugin)
    const out = String(await invokeDef.execute(
      { tool: 'no_such_tool', arguments: {} },
      { callId: 'c', name: 'invoke', arguments: {}, signal },
    ))
    expect(out.startsWith('UNKNOWN_TOOL: no_such_tool')).toBe(true)
  })
})

describe('F11.2 catalog_status 载荷（catalogMode / externalCount / registryCount）', () => {
  it('external 模式：形态与两路计数如实上报', async () => {
    const { plugin } = makeExternalFixture()
    const snap = await plugin.statusSnapshot()
    expect(snap.catalog.catalogMode).toBe('external')
    expect(snap.catalog.externalCount).toBe(EXT_NAMES.length)
    expect(snap.catalog.registryCount).toBe(REG_VISIBLE.length + REG_HIDDEN.length)
  })

  it('sidecar 未上报 ext 计数 → null，不填 0（红线 5）', async () => {
    const { plugin, sidecar } = makeExternalFixture()
    sidecar.stats = vi.fn(async () => ({ embed_mode: 'keyword', fingerprints: 3 }))
    const snap = await plugin.statusSnapshot()
    expect(snap.catalog.externalCount).toBeNull()
    expect(snap.catalog.registryCount).toBeNull()
  })

  it('registry 模式恒报 catalogMode=registry', async () => {
    const { plugin } = makeExternalFixture()
    ;(plugin as unknown as { _config: Record<string, unknown> })._config.catalogMode = 'registry'
    const snap = await plugin.statusSnapshot()
    expect(snap.catalog.catalogMode).toBe('registry')
  })
})

// ======================================================================
// 配置层：Cordis Config validate
// ======================================================================

function validate(value: unknown): { value?: Record<string, unknown>; issues?: ReadonlyArray<{ message: string }> } {
  return (Config['~standard'].validate(value) ?? {}) as never
}

describe('F11.2 配置校验', () => {
  it('默认值：registry / mock / 1000 / 空路径', () => {
    const r = validate({})
    expect(r.issues).toBeUndefined()
    expect(r.value?.catalogMode).toBe('registry')
    expect(r.value?.externalCatalogPath).toBe('')
    expect(r.value?.externalExecutor).toBe('mock')
    expect(r.value?.externalLimit).toBe(1000)
  })

  it('external + 路径 → 通过并保留', () => {
    const r = validate({ catalogMode: 'external', externalCatalogPath: 'experiments/f11_catalog_1000.jsonl' })
    expect(r.issues).toBeUndefined()
    expect(r.value?.catalogMode).toBe('external')
  })

  it('external 缺路径 → 拒绝（不静默空载入）', () => {
    const r = validate({ catalogMode: 'external' })
    expect(r.issues?.some(i => /externalCatalogPath is required/.test(i.message))).toBe(true)
  })

  it('externalLimit 非正整数 → 拒绝', () => {
    const zero = validate({ externalLimit: 0 })
    expect(zero.issues?.some(i => /externalLimit/.test(i.message))).toBe(true)
    const frac = validate({ externalLimit: 2.5 })
    expect(frac.issues?.some(i => /externalLimit/.test(i.message))).toBe(true)
  })

  it('枚举字段非法值 → 拒绝', () => {
    const badMode = validate({ catalogMode: 'superset' })
    expect(badMode.issues?.some(i => /catalogMode/.test(i.message))).toBe(true)
    const badExec = validate({ externalExecutor: 'http' })
    expect(badExec.issues?.some(i => /externalExecutor/.test(i.message))).toBe(true)
  })
})
