/**
 * search-tool.ts 紧凑渲染测试（T3）
 *
 * 覆盖：签名渲染、一句话 summary、无结果提示、总 token 上限。
 */

import { describe, expect, it } from 'vitest'
import { formatSearchResults, renderSignature } from '../src/search-tool.js'
import type { SearchResult } from '../src/types.js'

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    tool_name: 'send_email',
    description: '发送邮件通知',
    score: 0.8123,
    summary: '发送邮件通知',
    risk_level: 'medium',
    required_permissions: [],
    parameters: [
      { name: 'to', type: 'string', required: true },
      { name: 'subject', type: 'string', required: true },
      { name: 'body', type: 'string', required: true },
      { name: 'cc', type: 'string', required: false },
    ],
    ...overrides,
  }
}

describe('renderSignature', () => {
  it('必填在前、可选带 ?', () => {
    const sig = renderSignature(result())
    expect(sig).toBe('send_email(to: str, subject: str, body: str, cc?: str)')
  })

  it('参数超过 8 个只列前 8 个并加 …', () => {
    const params = Array.from({ length: 10 }, (_, i) => ({
      name: `p${i}`,
      type: 'string',
      required: i < 6,
    }))
    const sig = renderSignature(result({ parameters: params }))
    expect(sig).toContain('p7?: str, …)')
    expect(sig).not.toContain('p8')
  })

  it('超长签名截断到 160 字符', () => {
    const params = Array.from({ length: 8 }, (_, i) => ({
      name: `very_long_parameter_name_${i}_padding_padding`,
      type: 'string',
      required: true,
    }))
    const sig = renderSignature(result({ parameters: params }))
    expect(sig.length).toBeLessThanOrEqual(160)
    expect(sig.endsWith('…')).toBe(true)
  })

  it('无 parameters 时回退 Python 侧 signature 字段', () => {
    const sig = renderSignature(
      result({ parameters: undefined, signature: 'legacy_tool(a: string)' }),
    )
    expect(sig).toBe('legacy_tool(a: string)')
  })

  it('0 参数渲染为空括号', () => {
    expect(renderSignature(result({ parameters: [] }))).toBe('send_email()')
  })

  it('类型缩写映射', () => {
    const sig = renderSignature(
      result({
        parameters: [
          { name: 'n', type: 'integer', required: true },
          { name: 'b', type: 'boolean', required: true },
          { name: 'l', type: 'array', required: true },
          { name: 'o', type: 'object', required: true },
          { name: 'f', type: 'number', required: true },
        ],
      }),
    )
    expect(sig).toBe('send_email(n: int, b: bool, l: arr, o: obj, f: num)')
  })
})

describe('formatSearchResults', () => {
  it('无结果时提示改用更宽的查询', () => {
    expect(formatSearchResults([])).toBe(
      'No matching tools. Try a broader query or different wording.',
    )
  })

  it('渲染不含三位小数分数与 perms', () => {
    const out = formatSearchResults([result({ required_permissions: ['fs:read'] })])
    expect(out).not.toContain('0.812')
    expect(out).not.toContain('score')
    expect(out).not.toContain('perms')
  })

  it('带目录总数', () => {
    const out = formatSearchResults([result()], 1000)
    expect(out.startsWith('Found 1 tool(s) / 1000 in catalog:')).toBe(true)
  })

  it('summary 截断为一句', () => {
    const out = formatSearchResults([
      result({ summary: '发送邮件通知。多余的第二句话不会被展示' }),
    ])
    expect(out).toContain('— 发送邮件通知;')
    expect(out).not.toContain('多余的第二句话')
  })

  it('5 条结果渲染 ≤ 400 token（按 4 字符/token 粗估）', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      result({ tool_name: `tool_${i}_with_realistic_name` }),
    )
    const out = formatSearchResults(results, 1000)
    expect(out.length / 4).toBeLessThanOrEqual(400)
  })

  it('快照：完整输出格式', () => {
    const out = formatSearchResults(
      [
        result(),
        result({
          tool_name: 'notify_slack',
          summary: '向 Slack 频道推送',
          risk_level: 'low',
          parameters: [
            { name: 'channel', type: 'string', required: true },
            { name: 'text', type: 'string', required: true },
          ],
        }),
      ],
      1000,
    )
    expect(out.split('\n')).toEqual([
      'Found 2 tool(s) / 1000 in catalog:',
      '1. send_email(to: str, subject: str, body: str, cc?: str) — 发送邮件通知; risk=medium',
      '2. notify_slack(channel: str, text: str) — 向 Slack 频道推送; risk=low',
    ])
  })
})
