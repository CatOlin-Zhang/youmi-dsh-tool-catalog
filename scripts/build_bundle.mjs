/**
 * build_bundle.mjs — esbuild 单文件 ESM 构建（T10.1.2）
 *
 * 产物：index.js（bundle 根，随仓库提交）
 * 规则：
 * - format=esm, platform=node
 * - external: @deepseek-ai/*（红线 2：bundle 不打包宿主包）
 * - target=es2022（与 tsconfig 一致）
 *
 * 用法：node scripts/build_bundle.mjs
 */

import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundleRoot = resolve(here, '..')

await build({
  entryPoints: [resolve(bundleRoot, 'src/index.ts')],
  outfile: resolve(bundleRoot, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['@deepseek-ai/*'],
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: 'info',
})

console.log('✓ index.js built')
