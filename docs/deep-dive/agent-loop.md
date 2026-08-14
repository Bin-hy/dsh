# 01 · 核心循环：Agent Loop 状态机

> 本章拆解 DSH 的"心脏"：`agent-loop` 驱动器。全部结论基于 `packages/core/agent-loop/` 与 `packages/core/agent/`、`packages/core/session/` 的真实源码（驱动核心仅约 1,600 行）。

## 1. 概念地图

| 术语 | 含义 |
|---|---|
| **Agent** | 一个活跃会话的实时句柄：`id`、`options`、`session`、`inbox`、作用域上下文 `agent.ctx` |
| **驱动器（driver）** | 实现 Agent 行为的默认状态机（`ReactLoopAgent`），挂在 `ctx.agentLoop` |
| **turn（轮次）** | 一次对已接纳输入的排空过程；`turn/start` → 若干 step → `turn/end` |
| **step（步骤）** | 一次模型请求 + 其触发的工具执行；`step/start` → `step/end` |
| **inbox** | 持久化的输入队列投影，两个目标：`next-turn`（唤醒新轮次）与 `next-step`（下一步骤前领取） |
| **phase** | 驱动器自身状态：`idle` / `maintenance` / `running` |
| **surface** | 会话日志的"模型可见面"：只有 `user/message`、`assistant/message`、`tool/result` 三类事件投影为消息 |
| **BlockAssembler** | 把增量 chunk 聚合为最终消息块，并处理 tool call 参数增量 |

## 2. 模块与文件地图

```text
packages/core/agent/                 Agent 接口与注册表
  src/index.ts         Agent 接口、agent/* 事件域、注册表、withInitiator
  src/inbox.ts         Inbox：next-turn/next-step 队列 + 持久 splice 投影
  src/dispatch.ts      agentEvents：把 agent/* 事件绑定到具体 Agent
  src/consumed-work.ts 工作消费记账（哪些 turn 已被消费）
packages/core/agent-loop/            默认驱动器
  src/index.ts         AgentLoop 服务：工厂、生命周期所有权、create/resume
  src/agent.ts         ReactLoopAgent：turn/step 状态机（本章主角）
  src/tool-calls.ts    工具调度器：barrier + 滚动并发池
  src/runtime-context.ts 运行时上下文投影
packages/core/session/              会话日志
  src/index.ts         Session：append-only 日志、append、deriveMessages
  src/surface.ts       SurfaceManager：append/replace 折叠、事件→消息投影
packages/core/system-prompt/        prompt 组装（第 04 章详述）
packages/core/tools/                工具注册表与执行管道（第 02 章详述）
```

## 3. Agent 接口：四个入口方法

`Agent` 接口暴露四个改变输入队列的方法，语义差异是面试必考点：

```ts
// packages/core/agent-loop/src/agent.ts:122-132
followup(input: UserMessage): void {   // 普通用户消息
  this.send(input, 'next-turn', true)  // → next-turn 队列 + 唤醒
}
steer(input: UserMessage): void {      // 中途引导
  this.send(input, 'next-step', true)  // → next-step 队列 + 唤醒
}
inject(input: UserMessage): void {     // 注入上下文
  this.send(input, 'next-step', false) // → next-step 队列，不唤醒！
}
```

- **followup**：正常排队，开新轮次
- **steer**：插队到下一个 step 边界，立即唤醒
- **inject**：插队但不唤醒——**留在 inbox 里，等另一条消息把它唤醒**。这就是"注入的上下文在后续认领批次经过同一 waterfall"的机制

`cancel(cause, options)` 语义（`agent.ts:134-140`）：默认**清空 inbox** 并 abort 当前 phase 的 `AbortController`；`keepInbox: true` 保留队列。

## 4. 相位状态机

驱动器维护三个相位（`agent.ts:38-46`）：

```ts
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
```

- `status` 对外的只有两种：`idle` / `running`（maintenance 期间对外报 idle）
- `setPhase` 在状态变化时发射 `agent/status` 事件
- **每次新 turn 换一个新的 `AbortController`**（`agent.ts:325`）——取消是"每轮次"粒度的

### wakeDriver 的闩锁（latch）语义

`wakeDriver()`（`agent.ts:172-193`）处理"唤醒到达时机器不在 idle"的竞态：

1. phase 为 `maintenance` 或已 abort 的活动：**不能立即投递，置 `wakeRequested = true` 闩锁**，收敛后重放
2. 已 dispose：**永不闩锁**——teardown 不等待任何模型轮次
3. idle：立即开 running phase 并 `kick()`

`kick()` 的循环（`agent.ts:210-223`）：

```ts
private async kick(): Promise<void> {
  try {
    while (await this.turn()) {}   // turn() 返回 true = 还有 pending 工作
  } catch (_error) { /* 失败已被 agent/error 上报，边界处吞掉 */ }
  finally {
    if (this.phase.kind === 'running') {
      this.setPhase({ kind: 'idle', lastTurn: turn })
      if (wakeRequested && this.inbox.hasPending) this.wakeDriver()  // 闩锁重放
    }
  }
}
```

## 5. turn()：轮次状态机（全源码精读）

`turn()`（`agent.ts:246-330`）是核心中的核心，逐段拆解：

### 5.1 开启轮次

```ts
const turn = phase.turn + 1
this.session.append('turn/start', { turn })   // 持久事件先行
let target: InboxTarget = 'next-turn'
```

### 5.2 步骤循环与三种"零成本"出口

```ts
while (true) {
  const step = phase.step + 1
  const decision = await this.preStep(target, { turn, step })
  if (decision.kind === 'reject') {
    turnEnds = { kind: 'blocked' }        // ① pre-step 拒绝 → blocked
    return false
  }
  if (turnEnds && decision.messages.length === 0) break        // ② 空 enter
  if (phase.step === 0 && decision.messages.length === 0) {
    turnEnds = { kind: 'completed' }      // ③ 首条被改写为空 → 无步骤轮次
    return false
  }
  ...
}
```

设计点：**被拒绝或改写为空的首次认领，仍然关闭一个持久轮次**——日志记录"这次尝试发生过"（auditability 优先）。

### 5.3 正常步骤

```ts
this.session.append('step/start', { turn, step })
for (const message of decision.messages) {
  this.session.append('user/message', message, { surfaceOp: 'append' })
}
const stepEnd = await this.step(decision.assembly)
if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
this.session.append('step/end', { turn, step })   // finally 保证
```

**max-tokens 是粘性的**：一旦某个步骤命中 token 上限，后续步骤正常完成也不能把轮次结果"降级"为 completed（`agent.ts:287-290`）。

### 5.4 轮次结束的六种原因

| 原因 | 触发 |
|---|---|
| `completed` | 模型无工具调用返回 |
| `max-tokens` | 命中输出上限（粘性） |
| `blocked` | pre-step 被拒绝 |
| `aborted` | 取消信号 |
| `error` | 结构化失败（`LlmError.failure` 或 `{message, code: 'UNKNOWN'}`） |
| （无步骤轮次） | 首条 enter 为空 |

所有失败先经 `agent/error` 上报（带 turn/step 坐标），再抛出到 `kick` 边界。

### 5.5 turn-stopping 检查点

```ts
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial('agent/turn-stopping', { turn, signal })
  if (turnEnds && this.inbox.nextStep.length === 0) break
}
target = 'next-step'
```

`agent/turn-stopping` 是 **serial 事件（无 next()）**：轮次即将结束前的最后一次拦截机会。注意条件检查了**两次**——监听器可能同步往 next-step 塞了消息，塞了就继续下一 step。

## 6. preStep：模型看到什么由这里决定

```ts
// packages/core/agent-loop/src/agent.ts:225-243
const claimed = this.inbox.claim(target, position.turn)
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
const sections = renderContextSections(assembly)
const context = this.runtimeContext.project(joinContextSections(sections), sections)
const decision = await this.dispatch.waterfall(
  'agent/pre-step', { messages: claimed, ...position, signal },
  () => Promise.resolve<PreStepDecision>({
    kind: 'enter',
    messages: context === undefined ? claimed : [...claimed, context],
  }),
)
```

- `inbox.claim`：领取 next-step 全部 + next-turn 一条
- 组装 prompt 片段 + 运行时上下文（system-reminder 一类）
- `agent/pre-step` waterfall 的**默认行为**：enter，消息 = 认领消息 + 上下文
- 监听器可返回 `{kind: 'reject'}` 拒绝，或返回改写后的 `messages`
- **compaction 就挂在这里**（第 04 章详述）

## 7. step()：一次模型请求的完整生命周期

### 7.1 构建请求（buildRequest）

```ts
// packages/core/agent-loop/src/agent.ts:438-441
const proposedConfig = await this.dispatch.waterfall(
  'agent/request', { turn, step, signal },
  () => Promise.resolve(seedConfig),
)
```

- `agent/request` waterfall：**任何插件可改写整个请求配置**（模型路由、temperature、maxTokens）
- `ctx.llm.prepareCall(config)`：解析适配器注册（无适配器抛 `NO_ADAPTER`）
- **request/header 持久化**（`agent.ts:458-470`）：首次 `initial`，配置变化时 `change`，用 `headerEquals` 比较——历史配置快照进日志
- **request/context 变更检测**（`agent.ts:478-483`）：provider/model/contextWindow 变化才追加新事件——上下文窗口大小（contextWindow）也被持久化

### 7.2 流式循环（BlockAssembler 模式）

```ts
const assembler = new BlockAssembler()
const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
for await (const chunk of stream) {
  chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
  assembler.push(chunk)
}
```

**每个增量 chunk 都持久化为 `assistant/chunk` 事件**——这就是"原始 chunk 保证回放和 UI 保真"的实现。BlockAssembler 把增量聚合成块（文本块、tool-call 块、usage）。

### 7.3 失败与重试（agent/request-error waterfall）

```ts
if (finish.kind === 'error' || finish.kind === 'aborted') {
  const action = await this.dispatch.waterfall('agent/request-error', {...}, () => undefined)
  if (action?.kind !== 'retry') throw new LlmError(...)
  continue   // retry → 重跑 while(true) 循环
}
```

**compaction 的第二个挂接点**：`agent/request-error` 用于规范化的上下文溢出（context overflow）——先剪枝/摘要，再决定是否重试（详见第 04 章）。

### 7.4 提交 assistant/message

```ts
const message = createAssistantMessage({
  content: assembler.blocks(),
  source: { provider, model, ... },
})
this.session.append('assistant/message', { turn, step, message, usage }, {
  surfaceOp: 'append', sourceEventSeqs: chunkSeqs,
})
```

- 空内容也记录（承载 usage 与 max-tokens 事实），但**不进入派生历史**（surface.ts:99-105 跳过空消息）
- `sourceEventSeqs` 精确列出对应的 chunk 事件——结果与来源可追溯

## 8. 工具调度器：barrier + 滚动并发池

`executeToolCalls`（`packages/core/agent-loop/src/tool-calls.ts`）是 DSH 工具执行编排最精彩的部分：

### 8.1 按 executionMode 分组

```ts
const mode = ctx.tools.executionMode(first.exec).kind
const group = mode === 'parallel' ? planned.slice(next) : [first]
```

- **exclusive 工具**：单独成组 = **屏障（barrier）**，等待此前所有工具排空
- **parallel 工具**：一组，受 `maxParallelToolCalls`（默认值见 `constants.ts`，用户可通过 settings 改）上限约束
- **每次 start 前重新分类**：注册表变化（工具被替换）影响尚未开始的调用

### 8.2 三个不变量

1. **提交按模型顺序**：`commitReady` 只在**连续槽位**就绪时推进（`tool-calls.ts:146-160`）——工具 1 比工具 2 慢时，结果 2 必须等结果 1 提交
2. **结果上下文 FIFO**：`additionalContexts` 经 `acceptContext` 进入 next-step inbox，保证与结果相邻（对应文档"active-batch additionalContexts FIFO"）
3. **中止时合成结果**：被跳过（未启动）的调用追加合成结果 `tool call aborted before dispatch`（`tool-calls.ts:249-259`）——**回放才能保持合法**，否则日志里 tool/call 没有 tool/result 配对

### 8.3 失败语义的分层

- 工具执行失败 → 仍是合法结果（`isError`），轮次继续
- **调度器自身失败** → 停止新分发、排空已启动调用、**不伪造结果**、以首个失败 reject
- 取消 → 排空已启动、合成剩余、带着仍处于 aborted 状态的信号返回

## 9. 生命周期与取消：工厂所有权模型

`AgentLoop` 服务的 `prepare()`（`index.ts:459-578`）体现了 DSH 对并发生命周期问题的一丝不苟：

- **三源融合的 abort**：调用方 signal + 宿主 fiber 卸载 + 工厂 teardown，三个拥有者各有自己的 reason（`index.ts:479-487`）
- **反向 teardown memoized**：stop machine → `whenIdle()` 静默 → scope 展开 → 离开注册表 → 记账清理；所有竞速拥有者 await 同一静默过程
- **注册在资源存在之前**：disposer 先注册到可变槽位，setup 中途卸载也能找到可用的 disposer（防泄漏）
- `whenIdle()` 用双重检查循环等待活动收敛（`agent.ts:195-200`）

## 10. deriveMessages 与 surface：日志 → 模型历史

`Session.deriveMessages()` 折叠 surface：

- 只有三类事件投影消息：`user/message`（原样）、`assistant/message`（空内容→null）、`tool/result`（其 message）
- `surfaceOp: 'append'` = 追加到尾部；`surfaceOp: 'replace'` = **遮蔽一个区间**——压缩正是用 replace 改写模型历史而不动日志（第 04 章）
- **人类 transcript 用 append 源事件，模型历史用遮蔽后的 surface**——被替换掉的内容用户已经看过，不能从 transcript 消失

## 11. 设计权衡与面试要点

::: tip 面试要点 1：为什么"模型历史从日志派生"而不是直接维护消息数组？
日志是唯一真源：回放、fork、恢复、遥测、UI 都消费同一事件流。直接维护消息数组会产生"第二真源"漂移。代价：每次请求都要投影（用增量折叠 + replaceGeneration 摊薄成本）。
:::

::: tip 面试要点 2：为什么 pre-step 默认"enter 且附加上下文"，而不是无条件进模型？
上下文注入（agent-instructions 的 `<system-reminder>`）与 steering 走同一通道：它默认追加，但任何策略监听器都能改写或拒绝。**循环代码里没有一处硬编码"什么能进模型"**。
:::

::: tip 面试要点 3：取消的粒度为什么是"每轮次一个 AbortController"？
轮次是排空单位，取消语义天然对齐"停止当前轮次"。新轮次新 controller 意味着取消是幂等且可恢复的。`abort.reason` 必须携带结构化原因（disposed/用户取消），teardown 据此决定是否闩锁重放。
:::

::: tip 面试要点 4：工具并发为什么是"滚动池 + 模型序提交"而不是全并行？
模型序提交保证**结果上下文与调用相邻**（模型按顺序看到结果）；滚动池保证并行度有界且 exclusive 工具形成屏障。两全其美：调度并行、策略与结果保持模型序。
:::

::: tip 面试要点 5：为什么"中止时要合成失败结果"？
会话日志不变量：每个 `tool/call` 必须有 `tool/result`。回放器、UI、deriveMessages 都依赖配对。合成结果（`TOOL_ABORTED_BEFORE_DISPATCH`）让取消后的日志依然完整合法。
:::

::: tip 面试要点 6：AgentLoop 为什么是"服务 + 工厂"，而不是直接 new 驱动器？
配置驱动（cordis.yml 声明 agents）+ 可编程（SDK createAgent）+ 可恢复（resume）三条入口汇入同一个 `prepare()`。工厂统一持有所有权（liveAgents 集合、startup 任务、teardown 静默等待），保证配置热重载/卸载时所有 agent 优雅关闭。
:::

## 12. 存疑与深入方向

- `runtime-context.ts` 的 RuntimeContextProjection 与第 04 章 prompt 组装联动，本章只看了调用点
- `consumed-work.ts` 的记账语义（哪些 turn 已被消费）未展开——与 resume 后的 turn 编号连续性相关
- `request/header` 的 `headerEquals` 完整字段集（哪些字段变化触发 `change` 事件）值得对着 `canonicalHeader` 源码核对

下一篇：[02 · 工具系统与执行管道](/deep-dive/tools)，看一次工具调用如何在策略瀑布中穿行。
