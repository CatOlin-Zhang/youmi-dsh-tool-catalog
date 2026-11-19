/**
 * invoke-tool.ts 单元测试（T4）
 *
 * 覆盖错误语义表三种失败（UNKNOWN_TOOL / INVALID_ARGS / NOT_ADMITTED）
 * 与两条兜底分支（tool 名为空、目标工具报错且无 content）、以及成功转发；
 * 全部使用 fake deps，不依赖 DSH 运行时。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildInvokeDeps,
  createInvokeTool,
  dispatchInvoke,
  editDistance,
  signatureFor,
  suggestNames,
  validateAgainstSchema,
} from '../src/invoke-tool.js'
import type { InvokeDeps, InvokableToolDef } from '../src/invoke-tool.js'

const signal = new AbortController().signal

function fakeDeps(overrides: Partial<InvokeDeps> = {}): InvokeDeps {
  const defs = new Map<string, InvokableToolDef>()
  return {
    getTool: name => defs.get(name),
    forward: async (name, args) => ({ ok: true, text: `called ${name} with ${JSON.stringify(args)}` }),
    isInCatalog: () => false,
    knownNames: () => ['send_email', 'read_file', 'notify_slack'],
    ...overrides,
  }
}

function withDef(deps: InvokeDeps, def: InvokableToolDef): InvokeDeps {
  const orig = deps.getTool
  return {
    ...deps,
    getTool: name => (name === def.name ? def : orig(name)),
  }
}

describe('editDistance / suggestNames', () => {
  it('编辑距离基本用例', () => {
    expect(editDistance('send_email', 'send_email')).toBe(0)
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(editDistance('', 'abc')).toBe(3)
  })

  it('拼写变体给出候选（距离 ≤2，按距离升序，最多 3 个）', () => {
    const s = suggestNames('send_emial', ['send_email', 'read_file', 'notify_slack'])
    expect(s[0]).toBe('send_email')
    expect(s.length).toBeLessThanOrEqual(3)
  })

  it('完全不相似时返回空', () => {
    expect(suggestNames('xyz', ['send_email'])).toEqual([])
  })
})

describe('validateAgainstSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      to: { type: 'string' },
      count: { type: 'integer' },
      mode: { type: 'string', enum: ['overwrite', 'append'] },
    },
    required: ['to'],
  }

  it('缺必填参数', () => {
    expect(validateAgainstSchema(schema, {})).toEqual(['missing required argument: to'])
  })

  it('类型不符', () => {
    expect(validateAgainstSchema(schema, { to: 123 })).toEqual(['argument "to" must be of type string'])
  })

  it('enum 越界', () => {
    expect(validateAgainstSchema(schema, { to: 'a', mode: 'x' })).toEqual([
      'argument "mode" must be one of [overwrite, append]',
    ])
  })

  it('合法参数通过', () => {
    expect(validateAgainstSchema(schema, { to: 'a@b.c', count: 2, mode: 'append' })).toEqual([])
  })
})

describe('signatureFor', () => {
  it('由原始 JSON Schema 渲染紧凑签名', () => {
    expect(
      signatureFor('send_email', {
        type: 'object',
        properties: { to: { type: 'string' }, cc: { type: 'string' } },
        required: ['to'],
      }),
    ).toBe('send_email(to: str, cc?: str)')
  })

  it('无 schema 时回退空括号形式', () => {
    expect(signatureFor('mystery')).toBe('mystery()')
  })
})

describe('dispatchInvoke 错误语义', () => {
  it('tool 为空或非字符串 → INVALID_ARGS（不查表）', async () => {
    const deps = fakeDeps()
    const getTool = vi.fn(deps.getTool)
    const out = await dispatchInvoke({ tool: '   ', arguments: {} }, { ...deps, getTool }, { signal })
    expect(out).toContain('INVALID_ARGS: "tool" must be a non-empty string')
    expect(out).toContain('search_tools')
    expect(getTool).not.toHaveBeenCalled()

    const nonString = await dispatchInvoke({ tool: 42, arguments: {} }, { ...deps, getTool }, { signal })
    expect(nonString).toContain('INVALID_ARGS: "tool" must be a non-empty string')
  })

  it('工具不存在 → UNKNOWN_TOOL + 候选名', async () => {
    const out = await dispatchInvoke(
      { tool: 'send_emial', arguments: {} },
      fakeDeps(),
      { signal },
    )
    expect(out).toContain('UNKNOWN_TOOL: send_emial')
    expect(out).toContain('Did you mean: send_email?')
  })

  it('目录里有但注册表不可见 → NOT_ADMITTED（不要重试）', async () => {
    const deps = fakeDeps({ isInCatalog: name => name === 'hidden_tool' })
    const out = await dispatchInvoke({ tool: 'hidden_tool', arguments: {} }, deps, { signal })
    expect(out).toContain('NOT_ADMITTED: hidden_tool')
    expect(out).toContain('Do not retry')
  })

  it('when 准入被拒 → NOT_ADMITTED', async () => {
    const deps = withDef(
      fakeDeps({ isAdmitted: name => name !== 'gated_tool' }),
      { name: 'gated_tool', parameters: { type: 'object', properties: {} } },
    )
    const out = await dispatchInvoke({ tool: 'gated_tool', arguments: {} }, deps, { signal })
    expect(out).toContain('NOT_ADMITTED: gated_tool')
  })

  it('参数校验失败 → INVALID_ARGS + 完整签名', async () => {
    const deps = withDef(fakeDeps(), {
      name: 'send_email',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' } },
        required: ['to', 'subject'],
      },
    })
    const out = await dispatchInvoke({ tool: 'send_email', arguments: { to: 'a@b.c' } }, deps, { signal })
    expect(out).toContain('INVALID_ARGS: missing required argument: subject')
    expect(out).toContain('Expected signature: send_email(to: str, subject: str)')
  })

  it('arguments 非对象 → INVALID_ARGS + 签名', async () => {
    const deps = withDef(fakeDeps(), { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } })
    const out = await dispatchInvoke({ tool: 'read_file', arguments: 'not-an-object' as unknown }, deps, { signal })
    expect(out).toContain('INVALID_ARGS')
    expect(out).toContain('Expected signature: read_file(path: str)')
  })
})

describe('dispatchInvoke 转发', () => {
  it('成功时原样返回转发内容', async () => {
    const forward = vi.fn().mockResolvedValue({ ok: true, text: 'RESULT-BODY' })
    const deps = withDef(fakeDeps({ forward }), { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } })
    const out = await dispatchInvoke({ tool: 'read_file', arguments: { path: '/tmp/a' } }, deps, { signal })
    expect(out).toBe('RESULT-BODY')
    expect(forward).toHaveBeenCalledWith('read_file', { path: '/tmp/a' }, { signal })
  })

  it('一次 search + 一次 invoke 即可完成调用（端到端最小链路）', async () => {
    const forward = vi.fn().mockResolvedValue({ ok: true, text: 'sent' })
    const deps = withDef(fakeDeps({ forward }), {
      name: 'send_email',
      parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    })
    // 模型从 search 结果拿到签名 send_email(to: str)，直接构造 invoke
    const out = await dispatchInvoke({ tool: 'send_email', arguments: { to: 'root@example.com' } }, deps, { signal })
    expect(forward).toHaveBeenCalledTimes(1)
    expect(out).toBe('sent')
  })

  it('转发失败时带回错误文本（不吞错）', async () => {
    const deps = withDef(
      fakeDeps({ forward: async () => ({ ok: false, text: 'Error: permission denied' }) }),
      { name: 'run_cmd', parameters: { type: 'object', properties: {} } },
    )
    const out = await dispatchInvoke({ tool: 'run_cmd', arguments: {} }, deps, { signal })
    expect(out).toBe('Error: permission denied')
  })

  it('signal 已 abort 时抛出（取消语义由上层处理）', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const deps = withDef(fakeDeps(), { name: 't', parameters: { type: 'object', properties: {} } })
    await expect(dispatchInvoke({ tool: 't', arguments: {} }, deps, { signal: aborted.signal })).rejects.toThrow()
  })
})

describe('createInvokeTool / buildInvokeDeps', () => {
  it('产出 DSH 注册表就绪的工具定义', () => {
    const tool = createInvokeTool(fakeDeps())
    expect(tool.name).toBe('invoke')
    expect(tool.parameters.required).toEqual(['tool', 'arguments'])
    expect(tool.output.schema).toEqual({ type: 'string' })
    expect(tool.output.render({}, 'hello')).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('buildInvokeDeps 适配 ctx.tools：execute 入参与 content 扁平化（批量形）', async () => {
    const execute = vi.fn().mockResolvedValue({
      results: [{
        callId: 'call-9:invoke',
        result: { isError: false, content: [{ type: 'text', text: 'line1' }, { type: 'image', text: undefined }] },
      }],
      additionalContexts: [],
      concluded: true,
    })
    const deps = buildInvokeDeps(
      { get: () => ({ name: 'x' }), execute },
      { has: () => true, names: () => [] },
    )
    const outcome = await deps.forward('x', { a: 1 }, { signal, callId: 'call-9', agent: undefined })
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toBe('line1\n[image content]')
    // 批量入参：calls[0].id / name / arguments（原始 JSON 字符串）
    const input = execute.mock.calls[0][0]
    expect(input.calls[0].id).toBe('call-9:invoke')
    expect(input.calls[0].name).toBe('x')
    expect(JSON.parse(input.calls[0].arguments)).toEqual({ a: 1 })
    expect(input.signal).toBe(signal)
  })

  it('目标工具报错且无 content → ok=false + TOOL_ERROR 兜底文本', async () => {
    const deps = buildInvokeDeps(
      {
        get: () => ({ name: 'x' }),
        execute: async () => ({
          results: [{ callId: 'c', result: { isError: true, content: [] } }],
          additionalContexts: [],
          concluded: true,
        }),
      },
      { has: () => true, names: () => [] },
    )
    const outcome = await deps.forward('x', {}, { signal })
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toBe('TOOL_ERROR: failed with empty content')
    // 兜底文本经 dispatch 原样带回，模型不会收到空字符串
    const withDef = fakeDeps({
      getTool: () => ({ name: 'x', parameters: { type: 'object', properties: {} } }),
      forward: async () => outcome,
    })
    expect(await dispatchInvoke({ tool: 'x', arguments: {} }, withDef, { signal }))
      .toBe('TOOL_ERROR: failed with empty content')
  })
})
