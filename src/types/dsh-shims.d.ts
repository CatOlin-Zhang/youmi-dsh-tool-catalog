/**
 * dsh-shims.d.ts — 0.2.2-rc.3 宿主接口的**手写摘录**（仅供 `tsc --noEmit`）
 *
 * 非权威：本文件按 `docs/notes/t10-capability-probe.md` 里逐行核对过的
 * `app.asar/dsh/node_modules/@deepseek-ai/{cordis,dsh-tools,dsh-llm}` 声明手工
 * 摘录本插件真正用到的成员，不是官方 `.d.ts` 的拷贝，也不随 `index.js` 分发
 * （构建时只作为类型存在，运行时零引用）。
 *
 * 之所以要手写：bundle 不声明任何 `@deepseek-ai/*` 依赖（红线 2 / 探测报告 §5），
 * 安装目录的 `node_modules` 里也解析不到这些包，`tsc` 无法从真实类型取签名。
 *
 * 若 DSH 升级导致接口变化，本文件与 `tsc --noEmit` 会先报错 —— 这正是想要的
 * 行为（编译期发现，而不是运行时静默错位）。
 */

// ======================================================================
// @deepseek-ai/cordis：插件入口四件套用到的 ctx / 事件表 / Standard Schema
// ======================================================================

declare module '@deepseek-ai/cordis' {
  /**
   * Context 是代理对象，服务成员由核心包通过声明合并挂上来；
   * 这里只声明本插件用到的 `tools` / `logger` / `effect` / `on`。
   *
   * 来源（0.2.2-rc.3）：
   * - `effect`：`cordis/src/fiber.ts:10`（`Context extends Pick<Fiber,'effect'>`）
   * - `on`：`cordis/src/events.ts:96`（随 fiber 自动回收，返回移除函数）
   * - `logger(name)`：`cordis/src/context.ts:27`
   */
  export interface Context {
    /** 注册随 fiber 卸载自动回收的副作用；body 可返回 dispose 函数 */
    effect(fn: () => void | Promise<void> | (() => void | Promise<void>), label?: string): void
    /** 注册随 fiber 自动回收的事件监听器，返回显式移除函数 */
    on<K extends keyof Events>(name: K, listener: Events[K]): () => boolean
    /** 命名日志器：`ctx.logger('youmi-tool-catalog')` */
    logger(name: string): Logger
    // `tools` 服务成员通过文件末尾的跨模块声明合并加入 Context
  }

  /** 宿主事件表中本插件用到的部分：注册表变更通知（无参数） */
  export interface Events {
    'tools/change'(): void
  }

  export interface Logger {
    debug(message: string, ...args: unknown[]): void
    info(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
  }

  /**
   * 宿主用 `runtime.Config['~standard'].validate(config)` **同步**校验插件配置，
   * 异步结果直接抛 `TypeError('Async config validation is not supported')`，
   * 有 `issues` 抛 `ValidationError`，否则取 `result.value`（`cordis/src/fiber.ts:50-62`）。
   */
  export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly '~standard': StandardSchemaV1.Props<Input, Output>
  }

  export namespace StandardSchemaV1 {
    export interface Props<Input = unknown, Output = Input> {
      readonly version: 1
      readonly vendor: string
      readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>
      readonly types?: Types<Input, Output>
    }
    export type Result<Output> = SuccessResult<Output> | FailureResult
    export interface SuccessResult<Output> {
      readonly value: Output
      readonly issues?: undefined
    }
    export interface FailureResult {
      readonly issues: readonly Issue[]
    }
    export interface Issue {
      readonly message: string
      readonly path?: ReadonlyArray<PropertyKey | PathSegment>
    }
    export interface PathSegment {
      readonly key: PropertyKey
    }
    export interface Types<Input = unknown, Output = Input> {
      readonly input: Input
      readonly output: Output
    }
  }
}

// ======================================================================
// @deepseek-ai/dsh-tools：注册表与批量派发（本插件用到的成员）
// ======================================================================

declare module '@deepseek-ai/dsh-tools' {
  /** 模型产出的原始调用块：`arguments` 是**未解析的 JSON 字符串**（`dsh-llm/src/types.ts:111-119`） */
  export interface ToolCallBlock {
    readonly type: 'tool-call'
    readonly id: string
    readonly name: string
    readonly arguments: string
  }

  /** 内容块（只用到 text，其余以可选字段兜住） */
  export interface ContentBlock {
    type: string
    text?: string
    [key: string]: unknown
  }

  /** 单次调用的运行时上下文（`ToolRunContext` 中本插件用到的子集，`contracts.ts:245`） */
  export interface ToolRunContext {
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    readonly signal: AbortSignal
    readonly agent?: unknown
    /** 外层调用的步骤准入集；invoke 转发必须透传，否则带 `when` 的目标读作 UNKNOWN_TOOL */
    readonly toolSet?: ResolvedToolSet
  }

  /** 步骤准入集（`ctx.tools.resolve()` 产物，`contracts.ts:128-137`） */
  export interface ResolvedToolSet {
    dispose(): void
    view(scope: unknown): ReadonlyMap<string, ToolDefinition>
  }

  /** 批量派发入参（0.2.2 起 `execute` 的唯一形态，`executor.ts:19-48`） */
  export interface ToolBatchInput {
    readonly calls: readonly ToolCallBlock[]
    readonly signal: AbortSignal
    readonly maxParallelToolCalls?: number
    readonly agent?: unknown
    readonly toolSet?: ResolvedToolSet
    /** 传了才把根 tool/call、tool/result 写进会话；插件拿不到权威 turn/step */
    readonly log?: { readonly turn: number; readonly step: number }
  }

  export interface ToolCallResult {
    readonly callId: string
    readonly result: ToolExecutionResult
  }

  /** 批量派发结果（`executor.ts:57-61`） */
  export interface ToolBatchResult {
    readonly results: readonly ToolCallResult[]
    readonly additionalContexts: readonly unknown[]
    readonly concluded: boolean
  }

  export interface ToolExecutionSuccess {
    readonly isError: false
    readonly content: readonly ContentBlock[]
    readonly value?: unknown
  }

  export interface ToolExecutionFailure {
    readonly isError: true
    readonly content: readonly ContentBlock[]
    readonly error?: { message: string; info?: { name: string; code: string; reason?: string } }
  }

  export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure

  /** 注册期强校验的产物声明：缺 `render` 直接抛 TypeError（`index.ts:130-136`） */
  export interface ToolOutputDefinition {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: any): readonly ContentBlock[]
    presentationMeta?(args: unknown, value: any): unknown
  }

  export interface ToolDefinition {
    readonly name: string
    readonly description: string
    /** 编译后的原始 JSON Schema（`dsh-llm/src/types.ts:517-528`） */
    readonly parameters: Record<string, unknown>
    readonly output: ToolOutputDefinition
    readonly timeoutMs?: number
    execute(args: any, exec: ToolRunContext): Promise<unknown>
  }

  /** 带 `when` 的注册在无 toolSet 时读作不可执行（探测报告 §2） */
  export interface ToolActivationContext {
    readonly agent: unknown
    readonly modelSelection: unknown
    readonly signal: AbortSignal
  }

  export interface ToolRegistrationOptions {
    readonly when?: (context: ToolActivationContext) => boolean | Promise<boolean>
  }

  export interface ToolRestriction {
    readonly allow?: readonly string[]
    readonly deny?: readonly string[]
  }

  /**
   * `ctx.tools` 的真实形状（`ToolsService`，`dsh-tools/src/index.ts`）。
   * cordis 侧的 `Context['tools']` 通过下方的跨模块声明合并引用它。
   */
  export interface ToolsService {
    register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void
    /** 要求 agent 作用域上下文，全局调用抛错（`index.ts:162-166`） */
    restrict(filter: ToolRestriction): () => void
    get(name: string, scope?: unknown, toolSet?: ResolvedToolSet): ToolDefinition | undefined
    executable(name: string, scope?: unknown, toolSet?: ResolvedToolSet): ToolDefinition | undefined
    /** 全量可见定义（用于启动全量索引）；缺省为全局视图 */
    definitions(scope?: unknown, toolSet?: ResolvedToolSet): readonly ToolDefinition[]
    execute(input: ToolBatchInput): Promise<ToolBatchResult>
  }
}

// 跨模块声明合并：`ctx.tools` 取 dsh-tools 的 ToolsService 形状。
// （ambient module 块内部不能再嵌套 declare module，故写在顶层。）
declare module '@deepseek-ai/cordis' {
  import type { ToolsService as DshToolsService } from '@deepseek-ai/dsh-tools'
  interface Context {
    tools: DshToolsService
  }
}
