# 06 · LLM 层与流式管道

> DSH 的 LLM 层是一条"提供方中立词汇表 → 适配器 seam → 会话日志"的单向管道。核心只认识一套与提供方无关的类型，适配器负责翻译 wire 协议，循环把流式分片逐条写进持久日志。本章拆解 provider 适配、StreamChunk 协议、BlockAssembler、重试与凭据。

## 1. 能力 Seam 三角色

| 角色 | LLM 能力 | 凭据能力 |
|---|---|---|
| Service Definition | `LlmRuntime`（`ctx.llm`）+ `LlmAdapter` 抽象类 + `StreamChunk`/`Message` 词汇表 | `CredentialProvider`（`ctx.credentials`） |
| Service Provider | `llm-deepseek`（直连 fetch+SSE）、`llm-pi-ai`（SDK 多 provider）、`llm-replay`（测试回放） | `credentials-local` |
| Consumer | agent loop、token-meter、llm-retry、配置界面 | `llm-deepseek`、`llm-pi-ai` |

注册新适配器的全部工作（`packages/llm/llm/src/index.ts:180`）：

```ts
export abstract class LlmAdapter {
  providerRetryPolicy(_provider): ResolvedRetryPolicy | undefined  // 默认 normal
  listModels(_provider): Promise<readonly LlmModelInfo[]>          // 参考目录
  resolveModel(provider, model, _signal?): Promise<LlmResolvedModelInfo>
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>  // 唯一必实现
}
```

## 2. 三张词汇表

| 词汇表 | 内容 | 扩展性 |
|---|---|---|
| 消息词汇表 | `Message {id, role, content, source}`、`ContentBlockMap`（text/reasoning/image/tool-call/tool-result） | **开放**（interface map，声明合并） |
| 流式协议 | `StreamChunk`（block-start/text-delta/tool-call-delta/block-end/usage/finish） | **封闭**（switch + assertNever） |
| 失败词汇 | `LlmFailure {message, code, status?}`，稳定机器路由码（`AUTH`/`RATE_LIMIT`/`CONTEXT_WINDOW_EXCEEDED`…） | code 常量 + 集中文本分类器 |

为什么流式协议封闭、消息词汇开放？**协议是"每个消费方都必须逐分支处理的内部契约"**——封闭 union 让新增变体变成编译期全量波及，绝无静默漏处理；消息/来源这类"随插件演化的领域词汇"保持开放，未知值按文档默认呈现。

```ts
// packages/llm/llm/src/types.ts:291（StreamChunk 封闭联合）
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }
```

关键设计：

- `index` 关联交错出现的块（文本/推理/多个工具调用）
- `block-end` 携带**完整组装好的块**——消费方不需要自己拼 delta
- 协议不变量：`usage` 必须在 `finish` 之前，finish 后无分片；工具 `arguments` **全程保持原始 JSON 字符串**

## 3. 一次模型调用的完整生命周期

### 3.1 构建请求（buildRequest）

```text
seedConfig → agent/request waterfall（插件可替换 provider/model/采样参数）
→ ctx.llm.prepareCall()：解析适配器注册，返回 PreparedLlmCall
  （config 深冻结 + retryPolicy 注册时捕获 + 一次性 stream）
→ canonicalHeader 与上次比较 → request/header 事件（initial/resume/change）
→ markAgentLoopRequest(deepFreeze(请求))
```

`PreparedLlmCall` 的 HMR 安全语义（`packages/llm/llm/src/index.ts:779`）：**配置解析与适配器注册在 prepare 时绑定**，之后路由被替换也不影响进行中的调用——不会把 A 适配器的上下文容量与 B 适配器的请求拼在一起。

### 3.2 流式循环：逐分片入库

```ts
// packages/core/agent-loop/src/agent.ts:345-351
const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
for await (const chunk of stream) {
  signal.throwIfAborted()
  chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
  assembler.push(chunk)
}
```

**每个 StreamChunk 都持久化为 `assistant/chunk` 事件**——token 级回放保真。`llm/stream` waterfall 上还有运行时不变量（`packages/core/agent-loop/src/invariant.ts`）：重算"请求 = 日志纯函数"等式——messages 必须等于 `session.deriveMessages()`、config 必须等于 header fold、必须冻结且带 sessionId。

### 3.3 BlockAssembler：唯一的分片折叠实现

`packages/llm/llm/src/assembler.ts`：

- 内部 `partials: Map<index, PartialBlock>` + `order`；delta 按 index 累加（工具参数 `argumentsDelta` 字符串拼接）
- 容忍只有 delta 没有 block-start/end 的协议（懒创建）；已关闭的块再收 delta 直接忽略（畸形流防护）
- **max-tokens 截断时丢弃 tool-call 块**——"无法安全执行的工具调用不进历史"

### 3.4 DeepSeek 适配器：SSE 翻译

`packages/llm/llm-deepseek/src/translate.ts` 是有状态翻译器：

- 维护最多三个开放块（text/reasoning/toolBlocks），`nextIndex` 递增分配 harness 块 index
- tool_calls 增量按 `delta.tool_calls[i].index` 关联，`arguments` 片段直接字符串累加
- **`block-end`、`usage`、`finish` 全部推迟到 `[DONE]` 哨兵统一发出**——覆盖"usage 挂在 finish 上"与"尾部 usage-only"两种形态
- EOF 前没有 `[DONE]` 抛 `STREAM_CLOSED`——截断响应不可信
- `mapUsage` 按不相交约定扣减：`inputTokens = prompt_tokens - cacheRead`（DeepSeek 的 prompt_tokens 已含缓存命中）
- idle watchdog：只在 `iterator.next()` 未完成时计时——**消费方思考时间不算 provider 空闲**

### 3.5 失败收敛与重试

两条错误路径收敛为一个规范：

```text
路径 1：适配器 throw（传输/协议错误）
路径 2：流内 error 事件（无法中途抛异常的 SDK 事件流）
两者都在 adapterStream 边界归一化为终端 finish {kind:'error'|'aborted', failure}
```

消费方只按 `code` 路由，绝不解析提供方文本。上下文溢出统一为 `CONTEXT_WINDOW_EXCEEDED`，配额统一为 `QUOTA`——文本分类器集中在 `llm/src/error.ts`，把脆弱性圈在适配器边界内。

**一次适配器调用 = 一次提供方尝试**（禁用库级重试）。重试由 `llm-retry` 插件在 `agent/request-error` 扩展点执行：

```text
策略：注册时捕获的不可变 retryPolicy（normal: 可重试 code + maxRetries=2 / always: 无上限）
计数：从会话日志 findLast 同 (turn, step, provider, policyKey) 的 llm/retry 事件
      —— 重试计数是持久的，进程重启也不会超限
退避：指数 + 对称 jitter；providerRetryAfterMs 优先
关键：先持久化 llm/retry 事件，再等待，醒来 append llm/retry-started 才返回 retry
      —— 崩溃安全：任何一次尝试都可从日志重建
```

### 3.6 提交与用量

```ts
this.session.append('assistant/message',
  { turn, step, message, usage },
  { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
```

- **用量与输出同行**——没有独立 usage 记录
- `sourceEventSeqs` 绑定组装消息与其原始分片——token-meter 靠它精确重放 provider 输出做"用量锚"
- `TokenUsage` 不相交记账：`inputTokens` 仅未缓存输入；`reasoningTokens` 已含于 `outputTokens`，**不得再相加**

## 4. 凭据：只存引用

配置与 `cordis.yml` 里只有**环境变量名**（`CredentialRef`，POSIX 命名校验）。四条防泄漏纪律：

1. **每次操作重新解析，绝不跨操作缓存**——热轮换立即生效
2. **key 只进传输层 `authorization` 头**；`GenerateOptions` 无凭据字段；错误/日志只点名 ref 绝不回显值
3. **四层分层**：进程环境（只读优先）> `$DSH_HOME/.credentials.yaml`（可写，0600）> 项目 `.env` > 用户 `.env`
4. **遮蔽可拒绝**：`set` 写会被环境遮蔽时直接拒绝——避免"表面成功、解析仍是旧值"

## 5. Guard：循环卫生

- **repeat-tool-reminder（观察而非否决）**：在 `tools/post-execute` 按（工具名，深排序 canonical 参数串）计数连续重复，命中阈值注入提醒消息；用户消息重置。**用"模型可见的提示"打破循环，保持 loop 自由度**，而不是硬性 veto
- **timeout-policy（合作式超时）**：工具声明 `timeoutMs` 并承诺尊重 `exec.signal`；包装器替换信号分发、finally 还原；`timeoutOf(signal, code)` 用能力自有 code 区分"自己的定时器赢了"还是"外层嵌套 deadline 先触发"——只有前者才替换结果为结构化 `TOOL_TIMEOUT`

## 6. 面试要点汇总

::: tip 面试要点 1：为什么流式分片要逐条入库而不是记录最终消息？
三个收益：token 级回放保真；first-token 边界统一定义；token-meter 的用量锚按 `sourceEventSeqs` 精确重放。代价是日志膨胀——用"增量记录 + 引用折叠"换可重建性，这是 DSH 最核心的取舍。
:::

::: tip 面试要点 2：为什么"一次适配器调用 = 一次尝试"？
让幂等/副作用推理简单：失败 step 不提交 assistant 消息与工具副作用。重试是新的一轮持久化 step，任何一次尝试都可从日志重建；崩溃不会丢重试进度也不会超限。
:::

::: tip 面试要点 3：为什么凭据每次操作重新解析？
热轮换（改了文件下一次请求立即生效）+ 密钥与模型上下文/日志物理隔离。代价是每次请求一次 I/O 解析（可缓存于调用方一次调用内）。
:::

::: tip 面试要点 4：prepared call 为什么绑定注册？
HMR 安全：卸载重装不会把 A 适配器的能力结果与 B 适配器的分发拼在一起。配 deepFreeze + 运行期 invariant 重算，"模型可见 ⟺ 已记录"变成机器可证的等式。
:::

::: tip 面试要点 5：BlockAssembler 为什么是"唯一"的折叠实现？
块重组不应该是各消费方各自的问题（消费方自己拼 delta 必然漂移）。`block-end` 携带完整块 + 唯一 assembler，回放、UI、计量全部共享同一语义。
:::

下一篇：[07 · Web GUI 与 API 层](/deep-dive/web)——前端如何用同样的插件架构消费事件流。
