# LLM 层与流式管道研究笔记

> 研究对象：DeepSeek Harness（DSH）的 LLM 能力层——provider 适配、流式管道、tool call 解析、凭据与用量。
> 代码路径：`deepseek-harness/packages/`（只读研究，未修改任何文件）。
> 参考文档：`docs/subsystems/llm-streaming.zh.md`、`docs/subsystems/credentials.zh.md`、`docs/subsystems/session-telemetry.zh.md`。
> 约定：所有代码引用格式为 `文件路径:起始行`（文件相对于 `deepseek-harness/` 仓库根）。

---

## 1. 概念地图

### 1.1 一句话总览

DSH 的 LLM 层是一条"提供方中立词汇表 → 适配器 seam → 会话日志"的单向管道：核心只认识一套与提供方无关的消息/流式类型（`Message`/`StreamChunk`），适配器负责把各家 wire 协议翻译成这套词汇表；循环（agent loop）把流式分片**逐条写入持久会话日志**（保证可重建性），同时喂给唯一的 `BlockAssembler` 组装出助手消息；失败被规范化为带 code 的 `LlmFailure` 交给 `agent/request-error` waterfall 决定重试；token 用量跟随 `assistant/message` 事件进入日志，由 token-meter 服务重放投影。

### 1.2 能力 seam 三角色（capability seam）

仓库把一类能力拆成三个角色（见 `docs/glossary.md#capability-seam` 与 `packages/AGENTS.md`）：

- **Service Definition（服务定义）**：声明抽象接口与事件词汇，是"契约"的所在地。LLM 能力的定义是 `LlmRuntime`（`ctx.llm`）与 `LlmAdapter` 抽象类、`StreamChunk`/`Message` 词汇表（`packages/llm/llm/`）。凭据能力的定义是 `CredentialProvider`（`ctx.credentials`，`packages/credentials/credentials/`）。
- **Service Provider（服务提供方）**：实现契约。LLM 的 provider 是 `DeepSeekAdapter`（`packages/llm/llm-deepseek/`）与 `PiAiAdapter`（`packages/llm/llm-pi-ai/`），它们通过 `ctx.llm.registerAdapter()` 注册路由。凭据的 provider 是 `LocalCredentialProvider`（`packages/credentials/credentials-local/`）。
- **Consumer（消费方）**：通过 `ctx.llm` / `ctx.credentials` 调用。主要消费方是 agent loop（`packages/core/agent-loop/`）、token-meter、重试插件（`packages/llm/llm-retry/`）、配置界面。

seam 规则：一个 seam 必须三者齐全才算完整；注册是"副作用"（effect），注册返回释放器，随 fiber 销毁。

### 1.3 三张"词汇表"

| 词汇表 | 位置 | 作用 |
|---|---|---|
| 内容块/消息词汇表 | `ContentBlockMap`、`Message`、`MessageSourceMap`（`packages/llm/llm/src/types.ts`、`message.ts`） | 请求、历史、日志共用一套不可变消息表示 |
| 流式协议词汇表 | `StreamChunk`（`packages/llm/llm/src/types.ts:291`） | 适配器与消费方之间的**原始**分片协议 |
| 失败词汇表 | `LlmFailure` + `HarnessError.code`（`packages/llm/llm/src/types.ts:40`、`error.ts:13`） | 提供方无关的机器可路由错误分类 |

三张表都是**可合并扩展**的（merge-extensible）：核心块/来源/结束原因通过 `interface Map` 声明合并，插件可以加新成员；未知值走文档默认分支，不允许 `assertNever` 拦截。

### 1.4 一次模型调用的角色分工（预览）

```
agent loop (Consumer)                    LlmRuntime (registry+waterfall)         LlmAdapter (Provider)
  buildRequest ── agent/request ──> prepareCall ── resolveModel/resolveCallConfig
  step() ── ctx.llm.stream(req) ──> llm/stream waterfall ──> adapterStream ──> adapter.stream()
  for await chunk:                    （invariant 校验包装）                        （fetch+SSE 翻译）
    session.append('assistant/chunk')  ───────────── 每个 chunk ──────────────┘
    assembler.push(chunk)
  finish → agent/request-error (retry?) → createAssistantMessage → append('assistant/message')
```

### 1.5 关键设计支柱

1. **可重建请求**：任何到达模型的请求都是会话日志的纯函数；loop 构建的请求被深度冻结并打 `markAgentLoopRequest` 标记，`llm/stream` 上的 invariant 会在运行期重算该等式（`packages/core/agent-loop/src/invariant.ts:19`）。
2. **原始分片入库**：`assistant/chunk` 事件逐条记录每个 `StreamChunk`，保证 token 级回放保真；`assistant/message` 引用这些 seq 作为 `sourceEventSeqs`（`packages/core/session/src/types.ts:266,273`）。
3. **适配器契约纪律**：一次适配器调用 = 一次提供方尝试（禁用库级重试）；usage 在 finish 前、finish 后无分片；工具参数全程保持原始 JSON 字符串；停顿受 idle watchdog 时限约束；上下文溢出只有一个规范 code（`docs/subsystems/llm-streaming.zh.md:210-218`）。
4. **凭据只存引用**：配置与 `cordis.yml` 里只有环境变量名（`CredentialRef`），值归 provider，消费方**每次操作**重新解析（`packages/credentials/credentials/src/index.ts:65-73`）。
5. **失败规范化 + 分层重试**：适配器边界的所有失败收敛为 `LlmFailure`；重试策略按 provider 路由注册时捕获（不可变），由 `llm-retry` 插件在 `agent/request-error` 扩展点执行，每次重试等待前先写入持久事件（`packages/llm/llm-retry/src/index.ts:150-153`）。

---

## 2. 模块与文件地图

### 2.1 packages/llm/（LLM 能力组）

```
packages/llm/
├── llm/                     # Service Definition：词汇表 + LlmRuntime + BlockAssembler
│   └── src/
│       ├── types.ts         # StreamChunk/ContentBlockMap/FinishReasonMap/TokenUsage/GenerateOptions
│       ├── message.ts       # Message/MessageSource/上下文 form 词汇/创建与冻结助手
│       ├── index.ts         # LlmRuntime（注册表+waterfall）、LlmAdapter、LlmError、PreparedLlmCall
│       ├── assembler.ts     # BlockAssembler：分片 → 块/消息的唯一折叠实现
│       ├── retry-policy.ts  # RetryPolicy 配置→不可变 ResolvedRetryPolicy
│       ├── adapter-failure.ts # 任意 throw → LlmFailure 的规范化
│       ├── error.ts         # HarnessError 基类 + code 常量 + 上下文溢出/配额文本分类器
│       ├── call-config.ts   # LlmCallConfig、deepFreeze、markAgentLoopRequest
│       ├── api-key.ts       # 合法 API key 判定（transport 不变量）
│       ├── attribution.ts   # AppIdentity/User-Agent 归属头
│       ├── brand.ts         # MessageId/CallId/ProviderRequestId/ReasoningEffortId
│       ├── content.ts       # contentHasImage 递归遍历
│       ├── invariant.ts     # 流式语法 invariant（validateStream 包装每个 provider 流）
│       └── never.ts         # assertNever
├── llm-deepseek/            # Provider：直连 fetch + SSE 的 DeepSeek 适配器
│   └── src/
│       ├── adapter.ts       # DeepSeekAdapter：stream()、idle watchdog、错误分类
│       ├── index.ts         # 插件 apply：registerAdapter + 每请求解析连接/凭据
│       ├── serialize.ts     # harness Message → chat/completions wire 请求体
│       ├── translate.ts     # SSE payload → StreamChunk（含 usage/空响应映射）
│       ├── sse.ts           # SSE 字节流 → data payload（[DONE] 哨兵）
│       └── types.ts         # wire 类型（OpenAI 兼容）
├── llm-pi-ai/               # Provider：库支撑的多 provider 适配器（pi-ai SDK）
│   └── src/
│       ├── adapter.ts       # PiAiAdapter：profile 快照 + stream()
│       ├── index.ts         # 插件 apply：目录注册/凭据解析/发现
│       ├── stream.ts        # pi-ai 事件流 → StreamChunk（工具参数重新序列化）
│       ├── provider.ts / catalog.ts / config.ts / discovery.ts / replay.ts / context.ts
├── llm-retry/               # 重试策略执行器（agent/request-error 扩展点）
│   └── src/
│       ├── index.ts         # backoff/jitter、持久 llm/retry 事件、always/normal 模式
│       ├── history.ts       # providerForOpenStep：从日志找当前 step 的 provider
│       ├── types.ts         # llm/retry、llm/retry-started 会话事件声明
│       ├── brand.ts         # RetryId
│       └── invariant.ts     # 重试事件与失败 payload 校验
└── token-meter/             # 用量/压力计量（ctx.tokenMeter）
    └── src/
        ├── index.ts         # TokenMeter：重放折叠 + measure() + 投影注册
        ├── estimate.ts      # 固定密度启发式定价（4 字符/token）
        ├── usage-projection.ts # tokenUsage / contextPressure 投影定义
        ├── surface-fold.ts / surface-projection.ts / breakdown-projection.ts / projection.ts
        └── types.ts         # TokenMeasurement/TokenMeasurementBaseline
```

### 2.2 packages/credentials/

```
packages/credentials/
├── credentials/             # Service Definition：CredentialProvider 抽象 seam
│   └── src/
│       ├── index.ts         # CredentialProvider（resolve/describe/set/unset）+ credentialRef 构造
│       ├── types.ts         # CredentialRef brand + credentials/updated 事件
│       └── invariant.ts     # credentials/updated 只能发生在服务存活期
└── credentials-local/       # Provider：$DSH_HOME/.credentials.yaml + 环境分层
    └── src/
        └── index.ts         # LocalCredentialProvider：四层来源、写锁、0600、watcher 热更新
```

### 2.3 packages/guard/

```
packages/guard/
├── repeat-tool-reminder/    # 循环卫生：连续重复工具调用检测（观察而非否决）
│   └── src/index.ts         # tools/post-execute 计数、agent/pre-step 重置、提醒注入
└── timeout-policy/          # 工具超时：declared timeoutMs → deadline → TOOL_TIMEOUT 结果
    └── src/index.ts         # tools/execute 包装、信号替换与还原
```

### 2.4 关键消费方（不属于 packages/llm 但构成闭环）

```
packages/core/agent-loop/src/agent.ts      # ReactLoopAgent：step() 消费流、组装、重试边界
packages/core/agent-loop/src/tool-calls.ts # 工具调用调度：参数解析、并发分组、tool/call+tool/result 日志
packages/core/agent-loop/src/invariant.ts  # loop 构建请求 = 日志纯函数（运行期重算）
packages/core/agent/src/runtime-types.ts   # agent/request、agent/request-error 等扩展点声明
packages/core/session/src/types.ts         # SessionEventMap：assistant/chunk、assistant/message、tool/call…
packages/core/session/src/index.ts         # Session.append：JSON 校验 + surface 契约 + sourceEventSeqs
packages/core/tools/src/schema.ts          # defineTool/validateArgs：参数 JSON Schema 校验
packages/session/session-telemetry/src/coordinator.ts # 遥测：每 (turn,step) 只透传第一条 chunk
```

---

## 3. 关键类型与接口（真实类型定义片段 + 文件:行号）

> 片段直接摘自源码（只删减 JSDoc 注释），行号指向定义起点。

### 3.1 `StreamChunk`：原始流式协议（封闭联合）

`packages/llm/llm/src/types.ts:291`

```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
    type: 'finish'
    reason: FinishReason
    replayState?: unknown
  }
```

要点：
- `index` 把交错出现的多个块（文本/推理/多个工具调用）关联到各自块；`block-end` 携带**完整组装好的** `ContentBlock`，消费方不需要自己拼接 delta。
- 这是**封闭**联合：对 `type` 的 switch 以 `assertNever` 收尾，新增变体会在每个必须处理它的消费方触发编译错误（`packages/llm/llm/src/never.ts`）。
- 协议约束（适配器契约）：`usage` 必须在 `finish` 之前，`finish` 后不再有任何分片；工具 `arguments` 全程保持原始 JSON 字符串（`packages/llm/llm/src/types.ts:283-303` 的 JSDoc）。

### 3.2 内容块与消息词汇表

`packages/llm/llm/src/types.ts:99`（可合并扩展的块表）

```ts
export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}
export type ContentBlockType = keyof ContentBlockMap
export type ContentBlock = ContentBlockMap[ContentBlockType]
```

工具块的关键字段（`packages/llm/llm/src/types.ts:77-93`）：`ToolCallBlock` = `{ type:'tool-call'; id: CallId; name: string; arguments: string }`（arguments 是**原始 JSON 字符串**）；`ToolResultBlock` = `{ type:'tool-result'; toolCallId: CallId; content: ContentBlock[]; isError?: boolean }`。

`packages/llm/llm/src/message.ts:128`（三种表示共用的不可变消息）

```ts
export interface Message {
  readonly id: MessageId
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource
}
```

- 消息身份 `MessageId` 是品牌类型（`packages/llm/llm/src/brand.ts:16`），跨越 inbox、日志、模型请求边界保持稳定。
- 来源也是可合并的和类型（`packages/llm/llm/src/message.ts:100`）：`user` / `plugin` / `model` / `tool`；`kind` 回答"谁产生的"，可选的 `form` 回答"是什么信息"（instructions/catalog/snapshot/notice/relay/recall），两个轴独立（`message.ts:32-60`）。
- assistant 消息的来源携带 provider/model 溯源与适配器私有回放状态（`message.ts:8-19`）：
  ```ts
  export interface AssistantProvenance {
    provider: string
    model: string
    replayState?: unknown   // Lossless-JSON，仅当同一适配器实例同时拥有历史 provider 与目标 provider 时才传给目标适配器
  }
  ```
- 不可变由 `createMessage`/`freezeMessage` 强制：构造时 `crypto.randomUUID()` 赋 id 并 `deepFreeze(structuredClone(...))`（`message.ts:169-185`）。

### 3.3 `FinishReason` 与 `TokenUsage`

`packages/llm/llm/src/types.ts:116`（可合并扩展的结束原因）

```ts
export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}
```

`packages/llm/llm/src/types.ts:135`（逐调用 token 记账，计数互不重叠）

```ts
export interface TokenUsage {
  inputTokens: number          // 仅未缓存输入
  outputTokens: number         // 含 reasoningTokens（reasoning 只是信息性细节，不得再相加）
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

`LlmFailure`（`packages/llm/llm/src/types.ts:40`）：`{ message; code; status?; providerRetryAfterMs?; requestId? }`。`code` 是稳定、提供方无关的机器路由码（如 `AUTH`、`RATE_LIMIT`、`TIMEOUT`、`CONTEXT_WINDOW_EXCEEDED`、`EMPTY_RESPONSE`、`INVALID_CREDENTIAL`，常量定义在 `packages/llm/llm/src/error.ts:25-48`）。

### 3.4 请求与适配器 seam

`packages/llm/llm/src/types.ts:320`（一次完全组装的模型调用）

```ts
export interface GenerateOptions {
  provider: string          // 路由键，选择已注册的适配器实例
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>   // loop 盖章，用于请求路由/重放游标
  purpose?: 'compaction' | 'session-title'
}
```

`ToolSchema`（`packages/llm/llm/src/types.ts:312`）是发送给模型的协议类型：`{ name; description; parameters: Record<string, unknown> }`（JSON Schema），声明在 dsh-llm 而非 dsh-tools，因为它是每次组装请求的一部分。

`LlmAdapter` 抽象基类（`packages/llm/llm/src/index.ts:180`）——Provider 侧唯一必须实现的是 `stream()`：

```ts
export abstract class LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo            // 默认 {id,name}=provider
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined  // 默认 undefined → normal 默认
  listModels(_provider: string): Promise<readonly LlmModelInfo[]>          // 参考目录，默认空
  resolveModel(provider, model, _signal?): Promise<LlmResolvedModelInfo>   // 精确模型元数据
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>    // 唯一必实现
}
```

### 3.5 `LlmRuntime` 注册与流式 API（`ctx.llm`）

`packages/llm/llm/src/index.ts:284`。核心状态是三个 Map：`adapters`（路由→注册）、`directory`（可配置 provider 目录）、`discoveries`（配置界面模型发现）。

关键方法（`packages/llm/llm/src/index.ts`）：

```ts
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle   // :338
listProviders(): LlmProviderInfo[]                                                     // :419
registerConfigurableProviders(entries): DirectoryRegistrationHandle                    // :431
listModels(provider): Promise<LlmModelInfo[]>                                          // :581
resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>              // :619
resolveCallConfig(config, signal?): Promise<LlmCallConfig>                             // :730
prepareCall(config, signal?): Promise<PreparedLlmCall>                                 // :779
stream(options): AsyncIterable<StreamChunk>                                            // :913
```

`AdapterRegistrationHandle`（`packages/llm/llm/src/index.ts:239`）＝ 释放器 + 原子路由替换：`handle.replace(providers)` 先整体校验候选集、再在一个同步区间内换路由，任何请求都观察不到空洞；已释放后调用抛 `REGISTRATION_DISPOSED`。

`PreparedLlmCall`（`packages/llm/llm/src/index.ts:155`）＝ 一次"配置解析与适配器注册绑定"的结果：`config`（深度冻结）、`retryPolicy`（注册时捕获的不可变策略）、`context?`、`adapterDefaults`，以及一次性 `stream(options)`——该流入口穿过 `llm/stream` waterfall，但**固定使用 prepare 时捕获的注册**，HMR 无法把 A 适配器的能力结果与 B 适配器的分发拼在一起；重复分发或 config 不匹配抛 `INVALID_PREPARED_CALL`（`index.ts:800-812`）。

### 3.6 `BlockAssembler`：唯一的分片折叠实现

`packages/llm/llm/src/assembler.ts:36`

```ts
export class BlockAssembler {
  push(chunk: StreamChunk): void          // 增量喂入，幂等
  blocks(): ContentBlock[]                // 流序输出；finish 为 max-tokens 时丢弃未执行的 tool-call 块
  get usage(): TokenUsage | undefined
  get finish(): FinishReason              // 无 finish 分片时默认 {kind:'stop'}
  get replayState(): unknown
  message(source?): Message               // 默认 source = {kind:'plugin', plugin:'dsh-llm/assembler'}
}
```

实现要点（`assembler.ts:47-118`）：
- 内部 `partials: Map<number, PartialBlock>` + `order: number[]`；`text-delta`/`reasoning-delta`/`tool-call-delta` 各自累加（工具参数 `argumentsDelta` 字符串拼接，`assembler.ts:67-74`）。
- 容忍只有 delta、没有 block-start/end 的协议（`ensure()` 懒创建块，`assembler.ts:96-104`）；对已被 `block-end` 关闭的 index 再来的 delta 直接忽略（畸形流防护，防内存膨胀，`assembler.ts:63,69`）。
- `block-end` 先到先得；开放块在读取时用累积 delta 组装，未知块类型从未被 `block-end` 关闭则抛错（`assembler.ts:117`）。
- `max-tokens` 截断时丢弃 tool-call 块——"无法安全执行的工具调用不进历史"（`assembler.ts:136-138`）。

### 3.7 凭据 seam 类型

`packages/credentials/credentials/src/types.ts:13`：`type CredentialRef = Branded<'CredentialRef'>`（POSIX 环境变量名，构造时校验 `^[A-Za-z_][A-Za-z0-9_]*$`，`packages/credentials/credentials/src/index.ts:16-28`）。

`packages/credentials/credentials/src/index.ts:31,39`：

```ts
export interface ResolvedCredential {
  value: string          // 非空秘密值
  source: string         // 提供方定义的来源层（本地 provider: env/file/project-env/user-env）
}
export interface CredentialInfo {   // 面向配置界面，绝不暴露值
  configured: boolean
  source?: string
  writable: boolean
}
```

抽象 seam 四个操作（`packages/credentials/credentials/src/index.ts:60-99`）：`resolve(ref)`、`describe(ref)`、`set(ref, value)`、`unset(ref)`。seam 级规则：**空的存储值在任何地方都视为不存在**。

### 3.8 重试策略类型

`packages/llm/llm/src/retry-policy.ts:79`

```ts
export type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy
// normal: { mode:'normal'; maxRetries; retryableCodes; initialDelayMs; maxDelayMs; jitterRatio }
// always: { mode:'always'; initialDelayMs; maxDelayMs; jitterRatio }   // 无上限
```

默认值：`maxRetries=2`、`initialDelayMs=500`、`maxDelayMs=10_000`、`jitterRatio=0.1`；默认可重试 code：`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`（`retry-policy.ts:14-24`）。解析在路由注册时完成并 `Object.freeze`（`retry-policy.ts:145-190`）。

### 3.9 会话事件（用量/流式在日志中的家）

`packages/core/session/src/types.ts:236`（`SessionEventMap`，可合并扩展）：

```ts
'assistant/chunk': { turn; step; chunk: StreamChunk }                 // :266 原始分片，token 级回放保真
'assistant/message': { turn; step; message: AssistantMessage; usage?: TokenUsage } // :273 组装消息+用量同行
'tool/call': { turn; step; callId; name; arguments: string }          // :279 arguments 是模型产出的原始 JSON 字符串（未解析）
'tool/result': { turn; step; message: ToolResultMessage; error?; meta? } // :291
'request/header': { header: EpochHeader; reason: 'initial'|'resume'|'change' } // :304
'request/context': RequestContext                                      // :309 provider/model/contextWindow
```

`EpochHeader`（`types.ts:201`）= `{ config: LlmCallConfig; adapterDefaults?; system?; tools? }`——最新快照即可重建下一次请求。表面事件（携带 `surfaceOp`/`sourceEventSeqs`）只有三种：`user/message`、`assistant/message`、`tool/result`（`types.ts:343-347`）。

`Session.append` 的强制校验（`packages/core/session/src/index.ts:604-655`）：data 与 surface 元数据必须是 lossless JSON（BigInt/undefined/循环引用等直接拒绝）；`sourceEventSeqs` 引用必须唯一且更早；表面事件必须声明 `surfaceOp`。**事件日志是持久真相，坏事件在 append 处失败而不是后端 flush 时**。

---

## 4. 执行流程（一次模型调用的完整流式生命周期）

以 DeepSeek 直连适配器为主线，串起一条完整链路。

### 4.1 阶段 0：插件启动，注册路由

`llm-deepseek` 插件 `apply()`（`packages/llm/llm-deepseek/src/index.ts:200-276`）：

1. 建立 `options()` 闭包：`config` 来源可被 `installSettingsSection` 替换（用户设置热更新），每次解析出一份 `ResolvedDeepSeekOptions`（端点、`apiKeyEnv` 引用、thinking 默认、maxTokens、目录、`streamIdleTimeoutMs`、已解析 retryPolicy）；无效快照保留最后一份好的并报错一次（`index.ts:204-222`）。
2. 建立 `resolveApiKey(connection)`：优先走 `ctx.get('credentials')` 的 `credentials.resolve(ref)`，无 seam 时回退 launch-environment；拿到值后 `assertUsableApiKey` 校验（`index.ts:225-246`）。
3. `new DeepSeekAdapter({ options, resolveApiKey, resolveUserId })`，然后 `ctx.llm.registerConfigurableProviders([...])`（声明配置界面可见的休眠 provider）与 `ctx.llm.registerAdapter(['deepseek-official'], adapter)`（`index.ts:250-256`）。
4. retryPolicy 变化时用 `registration.replace([PROVIDER])` 原地换注册（原子，不发布空路由集，`index.ts:258-268`）。

注册内部：`prepareRoutes` 校验候选集（空名、重复、元数据不合法抛错，**全部通过才写入**），逐路由捕获 `retryPolicy`（`packages/llm/llm/src/index.ts:374-396`）；`commitRoutes` 在一个同步区间内删除旧路由、写入新路由并 `emitAdaptersUpdated()`（`index.ts:405-413`）。

### 4.2 阶段 1：loop 构建请求（`buildRequest`）

`packages/core/agent-loop/src/agent.ts:407-495`：

1. 从会话日志取当前 `requestHeader()`（header fold），决定 `reasoningEffort` 是否沿用（若该 effort 是适配器默认值则让位给重新解析，`agent.ts:417-426`）。
2. 生成 `seedConfig` 后派发 **`agent/request` waterfall**（`agent.ts:438-441`）——插件可替换 provider/model/采样参数；waterfall 前已移除标记为适配器默认值的字段（`requestProposal`，`agent.ts:55-61`）。
3. `ctx.llm.prepareCall(proposedConfig, signal)`（`agent.ts:449`）——一次解析出 `PreparedLlmCall`（注册绑定 + 冻结 config + retryPolicy + 上下文容量）。`NO_ADAPTER` 错误被吞掉（中间件可能 serve 未注册路由，最终分发仍会失败，`agent.ts:451-455`）。
4. 组装 `canonicalHeader({ config, adapterDefaults, system, tools })` 并与上次比较，变化或首次时 `session.append('request/header', ...)`（`agent.ts:458-470`）；provider/model/contextWindow 变化时 append `request/context`（`agent.ts:472-483`）。
5. `markAgentLoopRequest(deepFreeze({...header.config, messages, system?, tools?, sessionId, signal}))`（`agent.ts:486-493`）——冻结的请求对象打上进程本地标记，`llm/stream` 的 invariant 据此重算"请求 = 日志纯函数"（`packages/core/agent-loop/src/invariant.ts:21-54`：必须冻结、必须带 sessionId、messages 必须等于 `session.deriveMessages()`、config 必须等于 header fold）。

### 4.3 阶段 2：流式调用（`ctx.llm.stream` → waterfall → 适配器）

`step()`（`packages/core/agent-loop/src/agent.ts:332-401`）：

```ts
const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)   // :345
for await (const chunk of stream) {
  signal.throwIfAborted()
  chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq) // :349 逐分片入日志
  assembler.push(chunk)                                                             // :350 同步喂组装器
}
```

`stream()` 内部（`packages/llm/llm/src/index.ts:913-927`）：`ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))`——所有 listener 都调 `next()` 才会到达终端 continuation（适配器查找发生在终端，listener 可以短路或改路由）。`llm/stream` 事件签名见 `index.ts:64`。

`adapterStream`（`packages/llm/llm/src/index.ts:843-900`）是最终适配器边界，负责错误规范化：

- 选择注册 → 解析 `resolvedConfig` → `adapter.stream(this.forAdapter(resolvedOptions, adapter))`（`index.ts:849-866`）。
- `forAdapter`（`index.ts:823-836`）：剥离历史 assistant 消息中**不属于当前适配器实例**的 `replayState`（仅当同一实例同时拥有历史 provider 与目标 provider 才保留）——回放状态归适配器所有，绝不跨适配器泄漏。
- 适配器选择/分发/迭代失败统一 `yield adapterFailureChunk(error, options.signal)` 变成终端 `finish {kind:'error'|'aborted'}`（`index.ts:867-885,931-939`）；**middleware/消费方自身的失败保持抛出**（`finally` 里 `iterator.return()` 清理，`index.ts:894-899`）。

DeepSeek 适配器 `stream()`（`packages/llm/llm-deepseek/src/adapter.ts:214-269`）：

1. 每次 stream 调用只解析一次连接快照 + 凭据（`adapter.ts:220-221`）——"端点与密钥永远来自同一配置代"，进行中的流持有起始快照。
2. 融合 `options.signal` 与内部 consumer 信号，`using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')`（`adapter.ts:223-227`）——watchdog 只在 `iterator.next()` 未完成时计时（消费方思考时间不算 provider 空闲），`pulse()` 在收到 SSE comment 时重装（`adapter.ts:234`）。
3. `request()`（`adapter.ts:271-345`）：`serializeRequest` 组装请求体 → `fetch(\`${baseURL}/chat/completions\`)`，header 含 `authorization: Bearer <key>`、`attributionHeaders()`、`x-deepseek-harness-user-id`（匿名 id）、可选的 session-id/purpose 头（`adapter.ts:283-295`）；传输失败包装成 `LlmError('TRANSPORT', {cause})`（`adapter.ts:307-319`）；非 2xx 解析错误体 → `httpErrorCode(status, error)`（401/403→AUTH、429→RATE_LIMIT、400+上下文溢出→CONTEXT_WINDOW_EXCEEDED、500+→SERVER，`adapter.ts:138-149`），并携带 `retry-after`（秒或 HTTP 日期，`adapter.ts:117-125`）与 `x-request-id`/`x-deepseek-request-id`（`adapter.ts:127-130`）。
4. `yield* translate(parseSse(response.body, onComment))`（`adapter.ts:344`）。

### 4.4 阶段 3：SSE 解码与 wire→StreamChunk 翻译

`parseSse`（`packages/llm/llm-deepseek/src/sse.ts:28-40`）：`TextDecoderStream` + `eventsource-parser`，逐条 yield `data`，`[DONE]` 作为最后一个值返回；EOF 前没有 `[DONE]` 抛 `STREAM_CLOSED`（截断响应不可信）。

`translate`（`packages/llm/llm-deepseek/src/translate.ts:86-185`）是有状态翻译器：

- 维护最多三个开放块：一个 `textBlock`、一个 `reasoningBlock`、`toolBlocks: Map<index, OpenBlock>`；`nextIndex` 递增分配 harness 块 index（`translate.ts:87-99`）。
- reasoning 先于文本处理（thinking 模式交错）；**空字符串首分片不开放块**（`translate.ts:130-140`）。
- tool_calls 增量：`delta.tool_calls[i].index` 关联块；首分片带 `id`/`function.name`，`arguments` 片段直接字符串累加并逐片发 `tool-call-delta`（`translate.ts:152-170`）。
- `block-end`、`usage`、`finish` 全部**推迟到 `[DONE]` 哨兵**统一发出（`translate.ts:102-117`）——覆盖"usage 挂在 finish 分片上"与"尾部 usage-only 分片"两种形态，同时保证 finish 后无分片的协议不变量。
- `stop`（或无 finish）且没有任何块 → 映射为 `EMPTY_RESPONSE` 的 error finish（`translate.ts:110-115`），可重试。
- `mapUsage`（`translate.ts:53-62`）：DeepSeek 的 `prompt_tokens` 已含缓存命中，按 harness 的**不相交**约定扣减：`inputTokens = prompt_tokens - cacheRead`，`cacheReadTokens`/`reasoningTokens` 仅在有值时附带。
- `mapFinishReason`（`translate.ts:31-43`）：`stop`/`tool_calls`/`length`→stop/tool-calls/max-tokens；未知值（content_filter 等）→ error finish，code 为大写原值。

（对照：`PiAiAdapter` 走 pi-ai SDK 事件流，`toStreamChunks`（`packages/llm/llm-pi-ai/src/stream.ts:124-208`）把 `text_start/delta/end`、`thinking_*`、`toolcall_*` 事件映射为同套分片；工具参数 pi-ai 给的是**已解析对象**，block-end 时 `JSON.stringify` 还原成原始字符串（`stream.ts:174-187`）；pi-ai 失败以流内 `error` 事件到达 → 映射为 error/aborted finish 分片（`stream.ts:196-201`）——这正是协议允许的第二条错误路径。）

### 4.5 阶段 4：finish 处理与重试边界

`packages/core/agent-loop/src/agent.ts:353-371`：

- `finish.kind === 'error' | 'aborted'` → 派发 **`agent/request-error` waterfall**（`agent.ts:355-365`），payload 含 `turn/step/provider/failure/retryPolicy/signal`；listener 返回 `{kind:'retry'}` 表示接管恢复，否则默认 `undefined`（终态）。
- 返回 retry → `continue` 重新 `buildRequest`（新一轮尝试是**新的持久化 step**，`agent.ts:370`）；否则把 `finish.failure` 原样抛成 `LlmError`（`agent.ts:368`）→ 冒泡为轮次错误（`turn/end {kind:'error'}`，`agent.ts:307-315`）。
- 注意：**一次适配器调用 = 一次提供方尝试**；适配器层禁用库重试，重试完全由 `llm-retry` 插件在 loop 扩展点上驱动（见 4.7）。

### 4.6 阶段 5：组装助手消息 + 用量入日志

`packages/core/agent-loop/src/agent.ts:373-399`：

```ts
const message = createAssistantMessage({
  content: assembler.blocks(),
  source: { provider: request.provider, model: request.model,
            ...(assembler.replayState !== undefined ? { replayState } : {}) },
})
this.session.append('assistant/message',
  { turn, step, message, ...(assembler.usage !== undefined ? { usage: assembler.usage } : {}) },
  { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })   // 用量与输出同行，无独立 usage 记录
if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }
const toolCalls = message.content.filter(block => block.type === 'tool-call')
if (toolCalls.length === 0) return { kind: 'completed' }
await executeToolCalls(this.loopCtx, turn, step, toolCalls, signal, acceptContext)
```

`sourceEventSeqs` 把组装消息与其原始分片 seq 绑定：token-meter 靠它精确重放 provider 输出做"用量锚"，遥测靠它知道内容在 `assistant/message` 已完整。

### 4.7 阶段 6：工具调用解析、校验、调度、回填

`packages/core/agent-loop/src/tool-calls.ts`：

1. **参数解析**（`tool-calls.ts:104-110`）：`parseArguments(raw)` = `raw ? JSON.parse(raw) : {}`，解析失败保留原始字符串（容错，交给 schema 校验判 invalid）。
2. **调度**（`tool-calls.ts:59-101`）：按 `ctx.tools.executionMode` 分 exclusive 屏障 / parallel 池，池上限 `maxParallelToolCalls`（默认 10，`packages/core/agent-loop/src/constants.ts`，可配置 `index.ts:250-252`）；结果与上下文**按模型顺序**提交（`commitReady` 只推进连续已就绪槽位，`tool-calls.ts:146-160`）。
3. **schema 校验发生在工具侧**：`defineTool` 把 `execute` 包装为"先 `validateArgs(args)`（编译后的 JSON Schema），有违规抛 `ToolArgsError(INVALID_ARGS)`，否则执行"（`packages/core/tools/src/schema.ts:545-590`；`validateArgs` 定义 `schema.ts:478-480`）。模型参数是 `unknown`，工具自己收窄。
4. **日志回填**（`tool-calls.ts:262-289`）：启动即 append `tool/call`（原始 arguments 字符串，`tool/result` 事件引用其 seq）；完成后 append `tool/result`（`createToolResultMessage` → `{role:'user', content:[ToolResultBlock]}`，`source:{kind:'tool', callId}`，`packages/llm/llm/src/message.ts:231-241`）；abort 时为未启动的调用补合成错误结果（`TOOL_ABORTED_BEFORE_DISPATCH`，`tool-calls.ts:249-259`）保证重放有效。
5. `concludesTurn` 结果（或 tool-call 为空）结束 step；否则 loop 带着工具结果上下文进入下一个 step（`agent.ts:391-399`）。

### 4.8 阶段 7：重试执行器（`llm-retry`）

`packages/llm/llm-retry/src/index.ts`：

- 监听 `agent/request-error`（`index.ts:210-219`）：策略来自失败 payload 里**注册时捕获**的 `retryPolicy`；`policy.mode === 'always'` 或 `failure.code ∈ retryableCodes` 才考虑重试，否则 `next()` 委托（`index.ts:160-179`）。
- **从会话日志找先前重试**：`findLast` 同 (turn, step, provider, policyKey) 的 `llm/retry` 事件，`previousRetry >= maxRetries` 则放弃（`index.ts:181-190`）——重试计数是持久的，进程重启也不会超限。
- 退避：指数增长（`initialDelayMs * 2^(retry-1)`）封顶 `maxDelayMs`，对称 jitter `1 - jitterRatio + 2*jitterRatio*random()`（`index.ts:58-63`）；provider 的 `providerRetryAfterMs` 优先（超过策略上限则 normal 模式放弃，`index.ts:194-205`）。
- **先持久后等待**：`backoff()` 先 `agent.session.append('llm/retry', eventData)`（含 delayMs 与完整 failure），再 `cancellableDelay`，醒来后 append `llm/retry-started` 才返回 `{kind:'retry'}`（`index.ts:150-153`）。等待可被 `AbortSignal.any([signal, lifetime.signal])` 取消（`index.ts:124`）。
- 事件声明在 `packages/llm/llm-retry/src/types.ts:6-13`（`llm/retry`、`llm/retry-started` 是会话事件，随日志持久化）。provider 归属由 `history.ts` 从日志的 `request/header` fold 解析（`packages/llm/llm-retry/src/history.ts:14-33`）。

### 4.9 阶段 8：用量计量（token-meter）与遥测

- **写入侧**：流式过程中 `usage` chunk 作为 `assistant/chunk` 事件逐条入库（`agent.ts:349`），最终 `assistant/message` 携带同一 `TokenUsage`（`agent.ts:387`）。
- **读取侧**：`TokenMeter.measure(session, requestHeader?)`（`packages/llm/token-meter/src/index.ts:116-147`）重放会话日志（增量 fold，`_sync`/`_foldEvent`，`index.ts:160-270`）：最新一次成功的 `assistant/message` 若其请求 header 与当前一致，则用**提供方用量**作基线（`{kind:'usage'}`），否则全部启发式计价（`{kind:'estimated'}`，`estimate.ts:13-19`：4 字符/token + 结构开销）；当前表面相对基线算 `surfaceDeltaTokens`。`_estimateProviderAssistant`（`index.ts:277-310`）用 `sourceEventSeqs` 逐条重放 `assistant/chunk` 喂 `BlockAssembler`，重新算出 provider 输出 token——"用量锚"语义保守：`providerTokens >= 启发式总价` 才采用用量（`index.ts:246-248`）。
- **投影**：`tokenUsageProjectionDefinition`（`packages/llm/token-meter/src/usage-projection.ts:107-140`）累计四个桶（uncachedInput/output/cacheRead/cacheWrite），同一 (turn,step) 的重复样本**替换**而不是重复计数（`addReplacing`，`usage-projection.ts:44-53`）；`contextPressureProjectionDefinition`（`usage-projection.ts:163-206`）输出 `pressureTokens`（prompt 侧：input+cache）与 `projectedTokens`（样本+表面自采样以来的移动量，回答"下一次请求"的占用）。
- **遥测**（可选能力，不进 loop 主干）：`SessionTelemetryCoordinator` 对每个 (turn,step) 只透传**第一条** `assistant/chunk`（流开始信号；内容在 `assistant/message` 已完整），其余分片在捕获时丢弃（`packages/session/session-telemetry/src/coordinator.ts:180-190`）；游标标记"已交接"而非"已送达"（`coordinator.ts:218-221`），接收端按 `(session.id, event.seq)` 去重。导出前过 `session-telemetry/record` 脱敏 waterfall（`coordinator.ts:213-215`），权威日志永不改写。

---

## 5. 设计模式与权衡

### 5.1 模式：可合并扩展的和类型（merge-extensible maps）+ 封闭协议联合

- **现象**：`ContentBlockMap`/`MessageSourceMap`/`FinishReasonMap`/`ModelModalityMap` 都是 `interface Map`（TS 声明合并天然可扩展）；而 `StreamChunk` 是**封闭** union（switch 以 `assertNever` 收尾）。
- **权衡**：消息/来源/结束原因这类"会随插件演化的领域词汇"保持开放，未知值按文档默认呈现（不透明内容）；流式协议这种"每个消费方都必须逐分支处理的内部契约"保持封闭，新增变体 = 编译期全量波及，绝无静默漏处理。两者各取所需，避免了"开放 union 到处 fallthrough 漏分支"与"封闭 union 无法扩展"两个极端。

### 5.2 模式：原始分片逐条入库 + 单一 BlockAssembler 组装（不做整包记录）

- **现象**：`assistant/chunk` 事件记录每个 `StreamChunk`（含 `usage`、`finish`），`assistant/message` 携带 `sourceEventSeqs` 与最终块。
- **收益**：
  1. **回放保真**：持久日志可逐 token 重建响应；块重组不是各消费方各自的问题（`block-end` 携带完整块 + 唯一 assembler）。
  2. **first-token 边界**：`isTokenDelta`（`packages/llm/llm/src/message.ts:251-261`）让客户端 step 计时与 sessionStats 共享同一"首个可见 token"定义。
  3. **token-meter 用量锚**：按 `sourceEventSeqs` 精确重放分片算出 provider 输出量（`token-meter/src/index.ts:277-310`）。
  4. **失败不丢进度**：usage 分片独立于 finish，尾随 usage-only 形态也能被记录。
- **代价**：日志膨胀（每 token 一行事件）→ 遥测只透传每个 (turn,step) 的第一条 chunk（`session-telemetry/src/coordinator.ts:184-190`）；会话加载需按需 fold（`requestHeader()` 增量 fold，`core/session/src/index.ts:670-680`）。**用"增量记录 + 引用折叠"换"可重建性"**，这是该仓库最核心的取舍（配套 invariant：loop 请求必须等于日志纯函数，`core/agent-loop/src/invariant.ts:39-52`）。

### 5.3 模式：凭据只存引用（CredentialRef），每次操作解析

- **现象**：配置/`cordis.yml` 里只有环境变量名；`resolve()` 每次调用重新解析，绝不跨操作缓存（`credentials/src/index.ts:65-73`）；`credentials/updated` 事件只服务配置界面徽标，消费方不依赖它（`credentials/src/types.ts:16-30`）。
- **收益**：
  1. **热轮换**：改了 `.credentials.yaml`/环境，下一次请求立即生效，无需重启（`credentials-local/src/index.ts:309-317` 的分层：进程环境 > `$DSH_HOME/.credentials.yaml` > 项目 `.env` > 用户 `.env`）。
  2. **密钥不进模型上下文/日志**：`GenerateOptions` 没有凭据字段；适配器在传输层才把 key 放进 `authorization` 头（`llm-deepseek/src/adapter.ts:283-295`）；`assertUsableApiKey` 报错只点名 `ref` 绝不回显 key（`llm/src/index.ts:137-152`）；凭据文档解析错误只报 code/行列、不引原文（`credentials-local/src/index.ts:154-186`）；`attributionHeaders` 无任何秘密（`llm/src/attribution.ts:19-44`）。
  3. **遮蔽可拒绝**：环境层只读且优先——`set` 写会被环境遮蔽时直接拒绝（`assertUnshadowed`，`credentials-local/src/index.ts:410-417`），避免"表面成功、解析仍是旧值"。
- **代价**：每次请求一次 I/O 解析（可缓存于调用方一次调用内）；进程环境变化不可观测，永远不发事件（`credentials/src/index.ts:115-135` 只广播已提交变更）；需要 brand 类型防字符串混用。

### 5.4 模式：一次适配器调用 = 一次尝试；重试上移到 agent 层并持久化

- **现象**：适配器禁用库重试；重试由 `llm-retry` 在 `agent/request-error` 扩展点上执行，且**等待前先落盘** `llm/retry` 事件、从日志恢复已重试次数（`llm-retry/src/index.ts:150-153,181-191`）。
- **收益**：
  1. 重试是**新的一轮持久化 step**，任何一次尝试都可从日志重建；崩溃/重启不会丢掉重试进度也不会超限重试。
  2. 策略归属 provider 路由、注册时捕获为不可变值，之后释放/替换路由不影响进行中失败的重试语义（`docs/subsystems/llm-streaming.zh.md:220-222`）。
  3. 一次调用 = 一次尝试让"幂等/副作用"推理简单：失败 step 不提交 assistant 消息与工具副作用（`docs/subsystems/llm-streaming.zh.md:212`）。
- **代价**：重试语义散落在 loop 扩展点与两个持久事件里，比"适配器内部重试"重；直接调用 `ctx.llm.stream()` 的消费方只有一次尝试（契约明确）。

### 5.5 模式：双错误路径收敛为 `LlmFailure` + code 路由

- **现象**：适配器可以 throw（传输/协议错误），也可以以 `finish {kind:'error'|'aborted'}` 结束流（无法中途抛异常的适配器，如 pi-ai 的事件流）；`adapterStream` 把前者也归一化为终端 finish 分片（`llm/src/index.ts:867-885,931-939`）；消费方只按 `code` 路由，绝不解析提供方文本（上下文溢出统一 `CONTEXT_WINDOW_EXCEEDED`，`llm-deepseek/src/adapter.ts:138-149`；`isContextWindowExceededError`/`isQuotaExceededError` 文本分类器集中在 `llm/src/error.ts:80-100`）。
- **权衡**：单一规范错误词汇使重试策略、UI、遥测全部依赖稳定 code；但"按文本分类"本身是脆弱层（pi-ai 的 `classifyPiAiError` 被迫 pattern-match 被上游拍扁的错误消息，`llm-pi-ai/src/stream.ts:31-62` 有 XXX 注释）——用集中分类器把脆弱性圈在适配器边界内。

### 5.6 模式：prepared call 绑定注册（HMR 安全）

- `prepareCall` 返回一次性 `stream()`，注册、能力解析、header 记录、分发全程同一注册；HMR 卸载重装不会把 A 适配器的上下文容量与 B 适配器的请求拼在一起（`llm/src/index.ts:779-814`）。配 `deepFreeze`（迭代防环、跳过 AbortSignal，`llm/src/call-config.ts:88-116`）与 `markAgentLoopRequest` 标记，`llm/stream` 上的 invariant 可对 loop 请求做全量运行期校验（`core/agent-loop/src/invariant.ts:19-54`）。

### 5.7 guard 的设计取舍

- **repeat-tool-reminder：观察而非否决**。在 `tools/post-execute` 计数（denied 调用也计数，`guard/repeat-tool-reminder/src/index.ts:189-207`），把提醒作为 `additionalContexts` 注入（block 决定也保留提醒，`index.ts:213-224`），用户消息插入即重置链（`agent/pre-step`，`index.ts:229-232`）；参数比较用**深排序 canonical 字符串**忽略属性顺序（`index.ts:89-105`），提醒文案截断到 `argumentsPreviewChars`（默认 500）防止大参数本身制造循环（`index.ts:42,118-121`）。**用"模型可见的提示"而非硬性 veto 打破循环，保持 loop 自由度**。
- **timeout-policy：cooperative 超时 + 代码作用域**。工具声明 `timeoutMs` 并承诺尊重 `exec.signal`；包装器 `deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)` 替换 `exec.signal` 分发、finally 还原（`guard/timeout-policy/src/index.ts:55-80`）；`timeoutOf(signal, TOOL_TIMEOUT)` 用**能力自有 code** 区分"自己的定时器赢了"还是"外层嵌套 deadline 先触发"（`index.ts:19-25`），只有前者才替换结果为结构化 `TOOL_TIMEOUT` 错误（`index.ts:41-48,73-75`）。绝不 race/遗弃工具 promise——工具自己负责按 signal 停止。

### 5.8 遥测/计量的"复制品洁癖"

- 脱敏只作用于导出副本，权威会话日志永不改写（`docs/subsystems/session-telemetry.zh.md:126`）；`session-telemetry/record` waterfall 自带零规则（`coordinator.ts:213-215`），导出多干净取决于部署挂的规则，fail-closed 扣单条。
- token-meter 的用量锚**保守**：只有"用量 ≥ 启发式全价"才信用量（`token-meter/src/index.ts:246-248`），避免启发式低估导致 UI 显示负数。

---

## 6. 面试要点

> 每个问题附"一句话答案 + 关键代码证据"。

### Q1. LLM 能力 seam：Service Definition/Consumer/Provider 角色如何划分？如何注册新模型适配器？

- **划分**：Service Definition = `LlmRuntime`（`ctx.llm`，注册表+waterfall，`llm/src/index.ts:284`）+ 抽象 `LlmAdapter`（`llm/src/index.ts:180`）+ 词汇表（`llm/src/types.ts`）；Provider = 具体适配器（`llm-deepseek`/`llm-pi-ai`）；Consumer = agent loop、token-meter、重试、配置界面。
- **注册新适配器**：继承 `LlmAdapter` 实现 `stream(options): AsyncIterable<StreamChunk>`（唯一必实现，`llm/src/index.ts:232`），可选 `providerInfo/providerRetryPolicy/listModels/resolveModel`；插件 `apply()` 里 `ctx.llm.registerAdapter([routeKeys], adapter)`（全有或全无，重复路由抛 `DUPLICATE_ADAPTER`，`llm/src/index.ts:338-367`），另用 `registerConfigurableProviders` 声明配置界面可见的休眠 provider（`llm/src/index.ts:431-484`）。示例：`llm-deepseek/src/index.ts:250-256`。
- **路由选择**：`GenerateOptions.provider` 选适配器实例；模型 id 不要求在启动时注册，目录仅供参考（适配器可接受未列出模型）。

### Q2. 消息词汇表与 StreamChunk 词汇表如何编码 delta 与工具调用增量？

- `Message` = `{id, role, content: ContentBlock[], source}`（`llm/src/message.ts:128`），不可变、三种表示（inbox/日志/请求）共用。
- `StreamChunk` 封闭联合（`llm/src/types.ts:291`）：`block-start(index, blockType)` 开块；`text-delta`/`reasoning-delta` 按 `index` 关联累加；`tool-call-delta(index, id, name?, argumentsDelta)` 的 `argumentsDelta` 是**原始 JSON 字符串片段**，跨分片拼接；`block-end(index, block)` 携带完整组装块；`usage` 在 `finish` 前；`finish(reason, replayState?)` 终结。
- 编码证据：DeepSeek 侧 `translate.ts:130-170`（首个非空 delta 开块、tool_calls 按 `delta.tool_calls[i].index` 关联）；pi-ai 侧 `stream.ts:154-187`（解析对象在 block-end 时 `JSON.stringify` 还原）。工具参数协议约定"全程原始 JSON 字符串"（`llm/src/types.ts:283-303`）。

### Q3. 流式管道如何把 provider 流转换为 StreamChunk 并写入会话日志？重试与错误语义？

- 管道：`ctx.llm.stream(options)` → `llm/stream` waterfall（`llm/src/index.ts:64,913-927`）→ 终端 `adapterStream`（错误归一化，`llm/src/index.ts:843-900`）→ `adapter.stream()` → SSE 解码/事件翻译 → StreamChunk。
- 写日志：loop `step()` 逐分片 `session.append('assistant/chunk', {turn,step,chunk})` 并同步 `assembler.push(chunk)`（`core/agent-loop/src/agent.ts:347-351`）。
- 错误语义：适配器 throw 或流内 error finish 都收敛为终端 `finish {kind:'error'|'aborted', failure}`；loop 在 `agent/request-error` waterfall 上决定重试（`agent.ts:353-371`），默认失败终态且不提交该尝试的 assistant 消息/工具副作用；重试等待先落盘 `llm/retry` 事件（`llm-retry/src/index.ts:150-153`）。

### Q4. 模型返回的 tool call 如何被解析、增量聚合、与参数 schema 校验？

- **增量聚合**：SSE 中 `delta.tool_calls[i]` 按 `index` 累加 `arguments` 片段（`llm-deepseek/src/translate.ts:152-170`）→ `tool-call-delta` → `BlockAssembler` 拼接出 `ToolCallBlock.arguments`（原始 JSON 字符串，`llm/src/assembler.ts:67-74`）。
- **解析**：loop 过滤 `message.content` 中 `type==='tool-call'` 的块（`agent.ts:393`）→ `executeToolCalls` 里 `parseArguments`：`JSON.parse`，失败保留原始串（`core/agent-loop/src/tool-calls.ts:104-110`）。
- **schema 校验在工具侧**：`defineTool` 包装 `execute`，先 `validateArgs`（编译后 JSON Schema），违规抛 `ToolArgsError`（code `INVALID_ARGS`，`core/tools/src/schema.ts:460-480,545-590`）。
- **日志**：`tool/call`（原始 arguments）+ `tool/result`（`ToolResultMessage`，`tool-calls.ts:262-289`）；abort 补合成错误结果保重放。

### Q5. 凭据引用机制、env/.env provider、如何避免把密钥发给模型/写入日志？

- 机制：`CredentialRef`（POSIX 环境变量名 brand，`credentials/src/types.ts:13`）；`resolve/describe/set/unset` 四操作（`credentials/src/index.ts:60-99`）；消费方每次操作解析。
- 本地 provider 分层：进程环境（只读优先）> `$DSH_HOME/.credentials.yaml`（可写，0600）> 项目 `.env` > 用户 `.env`（`credentials-local/src/index.ts:1-36,309-317`）；写操作持跨进程锁、读改写保注释、watcher 热发布（`credentials-local/src/index.ts:383-403`）；环境遮蔽写直接拒绝（`credentials-local/src/index.ts:410-417`）。
- 防泄漏：key 只进传输层 `authorization` 头（`llm-deepseek/src/adapter.ts:283-295`），`GenerateOptions` 无凭据字段；`assertUsableApiKey` 报错只提 ref（`llm/src/index.ts:137-152`）；凭据文档解析错误不回引值（`credentials-local/src/index.ts:154-186`）；模型发现的一次性 `apiKey` 不落库（`llm/src/types.ts:210-211`）。

### Q6. usage/token 计量如何记录、计费数据如何进入会话日志？

- 写入：`usage` 分片以 `assistant/chunk` 事件逐条入库；最终 `assistant/message` 携带同一 `TokenUsage`（`agent.ts:349,387`；`core/session/src/types.ts:266,273`）——"模型输出与其记账同行，没有独立 usage 记录"。
- 不相交计数：`inputTokens` 仅未缓存输入，缓存单独报（`llm/src/types.ts:127-141`）；DeepSeek 的 `prompt_tokens` 含缓存命中，`mapUsage` 扣减（`llm-deepseek/src/translate.ts:53-62`）；reasoning 已含在 output 内。
- 读取：`TokenMeter`（`ctx.tokenMeter`）重放日志做测量（`token-meter/src/index.ts:116-147`），投影 `tokenUsage`/`contextPressure`（`token-meter/src/usage-projection.ts:107-206`）；session-stats 也从 `assistant/message.usage` 取 outputTokens 统计（`session/session-stats/src/projection.ts:82-84,132`）。

### Q7. guard 包：loop 卫生与工具超时如何实现？

- loop 卫生：`repeat-tool-reminder` 在 `tools/post-execute` 按 (工具名, 参数 canonical 串) 计数连续重复，命中阈值（默认 3/5/8）注入温和/详细提醒消息（`guard/repeat-tool-reminder/src/index.ts:63-79,189-224`），用户消息重置（`index.ts:229-232`）；观察不否决。另有 agent-loop 自身的 max-tokens sticky、`concludesTurn` 数据式停转（`core/agent-loop/src/agent.ts:391-399`）。
- 工具超时：`timeout-policy` 包装 `tools/execute`，`deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)` 替换分发信号、finally 还原，`timeoutOf` 按 code 确认自己的定时器赢了才替换结果为 `TOOL_TIMEOUT`（`guard/timeout-policy/src/index.ts:55-80`）。共享原语在 `packages/util/timeout/src/index.ts`（`deadline`/`idleWatchdog`/`timeoutOf`，仅通过 AbortSignal 通知，机制归各能力）。

### Q8. 最有教学价值的 3-5 个设计（详见第 5 章）

1. 原始分片逐条入库 + 单一 BlockAssembler + sourceEventSeqs 引用（可重建性优先于日志紧凑）。
2. 凭据只存引用、每次操作解析（热轮换 + 密钥与模型上下文/日志物理隔离 + 遮蔽拒绝）。
3. 一次适配器调用 = 一次尝试，重试上移 agent 层且等待前先持久化（崩溃安全、幂等推理简单）。
4. 封闭 StreamChunk 协议 + 开放领域 map 的双联合策略（编译期穷尽 vs 插件可扩展）。
5. prepared call 注册绑定 + deepFreeze + 运行期 invariant 重算（HMR 安全 + "model-visible ⟺ logged"机器可证）。

---

## 7. 存疑/待确认

1. **`llmRetryPolicyOf(stream)`**：`docs/subsystems/llm-streaming.zh.md:222` 提到"调用选定该注册后，`llmRetryPolicyOf(stream)` 返回为该调用服务的注册所捕获的值"，但 `grep` 全仓未找到该符号——当前实现是 loop 把 `preparedCall.retryPolicy` 直接放进 `agent/request-error` payload（`core/agent-loop/src/agent.ts:355-365`）。可能是文档滞后于代码（旧 API 名），写博客时应以代码为准。

2. **`FIXME(call-config-shape)`**（`llm/src/call-config.ts:15-16`）：哪些字段属于 epoch 级（影响缓存复用）尚未最终敲定，`model` 与模型持有的推理强度明确属于，采样标量暂时保留在 header 里。

3. **pi-ai 错误分类的脆弱性**：`llm-pi-ai/src/stream.ts:31-62` 的 `classifyPiAiError` 被迫对上游拍扁后的错误文本做正则匹配（XXX 注释），若 pi-ai 未来透传原始 Error 应改用 `code`/`cause` 分类。教学上可作为"适配器边界集中脆弱性"的案例。

4. **`BlockAssembler.message()` 的默认 source** 是 `{kind:'plugin', plugin:'dsh-llm/assembler'}`（`llm/src/assembler.ts:161`），而 loop 实际用 `createAssistantMessage` 带 `{kind:'model', provider, model}`（`core/agent-loop/src/agent.ts:373-380`）——默认值仅供独立消费方；两者行为需在文档中区分，避免误读。

5. **`timeout-policy` 的包名 FIXME**（`guard/timeout-policy/src/index.ts:6-9`）：计划改名为 `dsh-timeout-guard` 以对齐 `guard/` 归属，未定。

6. **重试计数与 step 的绑定**：`llm-retry` 的重试按 (turn, step, provider, policyKey) 从日志查找先前 `llm/retry` 事件（`llm-retry/src/index.ts:182-190`）。若同一 step 内先发生非重试的失败后又有新请求失败，语义如何（`policyKey` 区分策略代际）建议读 `tests/retry.spec.ts` 再确认，本笔记未逐行核对测试。

7. **`attributionHeaders` 的 "user-agent" 小写头名**（`llm/src/attribution.ts:64-68`）：HTTP 头大小写不敏感，`fetch` 会正常发送；文档称有意不支持 OpenRouter 特有归属头（`docs/subsystems/llm-streaming.zh.md:226`），教学时注意这是协议约定而非疏漏。

8. **凭证事件与热更新边界**：`credentials/updated` 只在"提供方管理的来源"发生已提交变更时发出；进程环境自身变化不可观测、永不发事件（`credentials/src/types.ts:16-30`），配置界面徽标依赖它，但消费方不依赖——这个"事件只服务 UI"的设计值得在博客中单独强调。

9. **usage 分片也可能被 invariant 约束**：`llm/src/invariant.ts:70-73` 规定 `usage` 最多一次且必须在 finish 前（`validateStream` 包装每个 provider 流，`invariant.ts:36-84`）。若某 provider 在流中途发多次 usage（如分批计费），会被判违规——目前仅 DeepSeek/pi-ai 两个适配器，均为单次，属契约内假设。

---

*（完）研究范围：`packages/llm/`、`packages/credentials/`、`packages/guard/` 全部源码，以及 `packages/core/agent-loop/`、`packages/core/agent/`、`packages/core/session/`、`packages/core/tools/`、`packages/session/session-telemetry/`、`packages/util/timeout/` 中与 LLM 管道直接相关的部分；三份中文子系统文档为入口。所有行号基于研究时仓库状态，如有变动以最新代码为准。*
