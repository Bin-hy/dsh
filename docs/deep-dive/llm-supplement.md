# 16 · 重试、凭据与 LLM 补遗：日志里的状态机

> 消化 backlog A16。DSH 把"重试"做成一个**状态全部住在仅追加会话日志里**的持久状态机，把"凭据热轮换"的正确性完全押在"每次操作解析"而不是事件上。本篇拆解 `llm-retry` 的完整决策链、退避公式、policyKey 代际，以及 `validateStream` 的七条流式不变量。

## 1. llm-retry 完整决策链

`agent/request-error` waterfall 里 `recover()` 的分支图（`packages/llm/llm-retry/src/index.ts:156-208`）：

```text
policy === undefined                     → next()（无提供方策略，如 NO_ADAPTER）
policy.mode === 'always'                 → 先跑下游恢复（下游专用恢复优先），否则自管兜底
normal 且 code 不可重试                    → next()（委托终态）
policyKey = retryPolicyKey(policy)        → 规范化 key
priorRetry = 日志 findLast 同 (turn, step, provider, policyKey) 的 llm/retry
normal 且 previousRetry >= maxRetries     → next()（预算耗尽）
delayMs = providerRetryAfterMs 优先（≤上限原样采用），否则指数退避
→ backoff：先 append llm/retry → cancellableDelay → append llm/retry-started → {kind:'retry'}
```

### 一个反直觉的组合语义

**normal 模式在"可重试且预算未耗尽"时直接短路下游**——比 llm-retry 注册更晚的恢复监听器根本不会执行。`always` 模式相反：**总是先让下游表态**，自己只当兜底。

为什么？normal 是"常规运维策略"——限速、超时这些 code 的恢复是 llm-retry 的专属职责，下游（如 compaction 的溢出恢复）不该抢；而 always 是"激进但可覆盖"的模式，愿意把决策权让给更专门的恢复器。

## 2. 退避公式：三重封顶

```ts
exponent    = Math.min(retry - 1, 1024)              // 防指数爆炸
exponential = Math.min(initialDelayMs * 2 ** exponent, maxDelayMs)
jitter      = 1 - jitterRatio + 2 * jitterRatio * random()   // 对称 jitter，均值 1
delayMs     = Math.min(exponential * jitter, maxDelayMs)
```

- 对称 jitter（均值 1）而不是 `1 - ratio + 2*ratio*rand` 的非对称——大量并发重试时**平均等待时间不漂移**，不会系统性提前或延后
- `providerRetryAfterMs`（Retry-After 头）**≤ maxDelayMs 时原样采用、不加 jitter**——尊重提供方的调度意图；超上限时 normal 放弃、always 用本地退避

## 3. 先持久化后等待：崩溃安全的预算

```text
1. append('llm/retry', {retryId, turn, step, provider, policyKey, retry, delayMs, failure})
2. await cancellableDelay(delayMs, fusedSignal)     ← 取消即返回 false、不写 started
3. append('llm/retry-started', {retryId, turn, step, retry})
4. return {kind:'retry'}
```

**调度先于等待**——崩溃/重启后日志里已有一条"已调度的重试"，`findLast` 计数不会因进程死亡而丢失或超发。`llm/retry` 记录调度，`retry-started` 标记"等待真的完成了"，后续 step/turn 事件确立成败。

### policyKey：策略代际

```ts
policyKey = [mode, maxRetries, 排序后的 codes, initialDelayMs, maxDelayMs, jitterRatio] 的规范化 JSON
```

策略的**全部行为字段**压成 key——策略一变，计数立即重置、retryId 换新链。这就是"重试计数按策略代际分组"的语义：换了策略就该从零开始数，旧链的预算不继承。

## 4. Loop 侧重试：同 step、新尝试

重试**不重开 step**（`agent.ts` 的 `while(true) continue`）：

- 新尝试留在同一 (turn, step)——新 `assistant/chunk` 照记
- **失败分片不进最终消息的 `sourceEventSeqs`**（retry.spec.ts:287 的边界）：只有成功尝试的 chunk 序列被最终消息引用
- `buildRequest` 每次重跑 header 变更检测——配置未变不写新快照，KV 缓存身份不变
- 非重试失败是 step 终态：同一步内不会再有新请求（所以 findLast 的"同 step"计数是良定义的）

## 5. 凭据热轮换：不靠事件

`credentials/updated` 事件**只服务 UI 徽标的推送失效**（`refreshIfLoaded` 仅在页面已加载后 refetch）。热轮换的正确性完全不依赖它：

- **正确性来源**：`resolve` 每次操作重新解析（deepseek 适配器每次 `stream()` 重取 key）——轮换后的值在紧接着的下一次请求生效
- **进程环境永不发事件**：launch 环境是**启动时不可变快照**，`process.env` 的任何后续变更都不可见——既然不可观测，发事件就是撒谎
- **UI 消费方**：徽标读 `describe` 快照（永不暴露值），`credentials/updated` 只是"提示你该刷新了"

::: tip 面试要点："事件只服务 UI"是一条架构纪律
事件是**已提交变更**的通知，不是正确性依赖。热轮换的正确性 = resolve-per-operation；事件 = 让 UI 少一次轮询。如果消费方把事件当"轮换信号"来缓存值，就会出现"事件丢失 = 旧 key 永存"的正确性 bug。DSH 的 JSDoc 把这个分工写死了。
:::

## 6. validateStream：七条流式语法不变量

`packages/llm/llm/src/invariant.ts:36-84` 用 `prepend: true` 包在每个 provider 流外面：

```text
1. usage 最多一次
2. usage 必须在 finish 之前
3. finish 后无任何分片
4. block-start / block-end 配对（同 index 的块先开后闭）
5. delta 必须落在已打开的块上
6. block-end 携带的块类型与 block-start 声明一致
7. finish 恰好一次（流必须正常终结）
```

违规 → 抛 `INVARIANT`。这不是"防御不可信 provider"——是**契约焊进执行**：适配器作者写流翻译时立刻收到语法错误，而不是等消费方静默出怪。

## 7. FIXME(call-config-shape) 的现状

研究确认：epoch 级（影响缓存复用：model、reasoningEffort）与采样级（temperature、maxTokens、stop）字段的分层**尚未实现**——当前全部字段按 epoch 级处理（任何变化都写新 `request/header`）。FIXME 的语义是"未来把采样字段移出 header 比较，减少无意义的快照"，现在写新快照只是**保守正确**（多写不坏正确性）。

## 8. 面试要点

::: tip 面试要点 1：为什么重试计数放日志里而不是内存里？
崩溃后预算必须准确——进程死了重试预算不能"回血"。`findLast` 同 (turn, step, provider, policyKey) 的 `llm/retry` 事件是权威计数。日志即状态机，重启不丢状态。
:::

::: tip 面试要点 2：Retry-After 为什么不加 jitter？
提供方的 Retry-After 是"调度意图"（它知道自己的限流窗口），客户端加 jitter 只会破坏意图。只有本地退避（不知道真实限流）才需要 jitter 防惊群。
:::

::: tip 面试要点 3：为什么失败分片不进 sourceEventSeqs？
`sourceEventSeqs` 是"最终消息由哪些分片组成"的精确血缘。失败的尝试没有产出最终消息——把它们排除，token-meter 的用量锚重放才精确对应"成功的那次调用"。
:::

::: tip 面试要点 4：流式不变量放 prepend 是为什么？
prepend = 在所有业务监听器之前。语法错误要在**任何消费方看到坏分片之前**炸出——如果等业务监听器（token-meter、UI）各自防御，错误就扩散成 N 份不一致的兜底。
:::

下一篇：前端渲染内核 / 调度命令（笔记已就绪）。
