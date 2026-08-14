# 核心循环与运行时研究笔记

> 研究对象：DeepSeek Harness（DSH）核心 agent 循环与运行时。仓库：`deepseek-harness/`（只读）。
> 方法：先读 `docs/architecture.zh.md`、`docs/agent-lifecycle.zh.md`、`docs/subsystems/{core,session,system-prompt}.zh.md` 建立框架，再逐包读源码（`packages/core/{agent,agent-loop,session,scope,system-prompt,tools}`、`packages/session/session-persistence*`、`packages/boot/app-boot`、`apps/cli`、`packages/host/webserver`、`packages/goal/goal-round-driver`、`packages/compaction/compaction-basic`、`vendor/cordis`）。
> 所有代码引用采用 `文件路径:起始行` 形式，行号以本笔记写作时仓库状态为准。
> 一句话结论：DSH 把"agent 循环"做成**可替换的插件**（默认实现 `dsh-agent-loop`），把"会话历史"做成**事件溯源的仅追加日志**（模型可见 ⟺ 已记录，由运行时不变式断言），把"扩展点"做成**作用域化（scope）的 Cordis 事件**（emit / serial / waterfall 三种分发模式），三者由 `ctx.agents` 上的进程内 initiator 归因机制串起来。

---

## 1. 概念地图（术语 + 一句话定义）

| 术语 | 一句话定义 | 出处 |
|---|---|---|
| Cordis | DSH 底层的插件框架（vendored）：插件向共享 `Context` 贡献服务、类型化事件和可逆副作用；"一切都是插件"是 DSH 的第一原则 | docs/architecture.zh.md:9-13 |
| Profile / 组合包 | profile 是 Harness home 里具名的组装（列出叠放的组合包 + 用户 patch），组合包是"配置项 + 挂载代码"的分发格式，运行中的 `dsh` 就是一棵由多层 patch 叠加成的插件树 | docs/architecture.zh.md:15-37 |
| Session | 一份类型化 `SessionEvent` 的**仅追加日志**，完整交互历史的唯一真源；LLM 消息历史从日志*派生*，从不单独存储 | docs/subsystems/session.zh.md:5 |
| SessionEvent | 日志条目：`type`/`seq`/`time`/`data` 的可辨识联合；`seq = log.length` 保证连续 | `packages/core/session/src/types.ts:404` |
| SessionEventMap | 可合并扩展（declaration merging）的事件词表，`SessionEvent` 联合由 `keyof` 派生 | `packages/core/session/src/types.ts:236` |
| deriveMessages() | 按 surface 顺序把事件日志投影成模型看到的 `Message[]`；缓存的、冻结的、O(新节点) | `packages/core/session/src/index.ts:726` |
| Surface / SurfaceOp | "产生消息的事件"的有序投影；`append` 进尾部，`{op:'replace',start,end}` 遮蔽一段（压缩用） | `packages/core/session/src/types.ts:343`、`372` |
| 轮次 turn | 一次"用户/系统输入被处理"的完整生命周期：`turn/start` →（零或多个 step）→ `turn/end` | docs/architecture.zh.md:69 |
| 步骤 step | 一次模型请求 + 它调用的工具；`step/start`/`step/end` 包裹 | docs/architecture.zh.md:69 |
| Agent | 面向编程的活 agent 句柄：id、options、session、inbox、status、agent 作用域 ctx，以及 send/followup/steer/inject/cancel/whenIdle/runMaintenance | `packages/core/agent/src/runtime-types.ts:64` |
| AgentHandle | `{agent, dispose()}`：dispose 是能力（capability），只有持有着能拆掉这个 agent | `packages/core/agent/src/index.ts:172` |
| AgentRegistry（ctx.agents） | 活跃 agent 注册表 + 工厂委托 + 进程内 initiator 归因 | `packages/core/agent/src/index.ts:256` |
| AgentLoop（ctx.agentLoop） | 默认的工厂/驱动器服务（`dsh-agent-loop`），实现公开 `Agent` 约定；扩展插件只依赖 `agent` 包、绝不依赖 `agent-loop` | `packages/core/agent-loop/src/index.ts:296` |
| ReactLoopAgent | agent-loop 内部的具体驱动器实现（公开 `Agent` 约定的唯一实现） | `packages/core/agent-loop/src/agent.ts:64` |
| Inbox | agent 拥有的"待处理消息"投影，两条有序列表：`next-turn`（普通轮次）与 `next-step`（步骤边界输入） | `packages/core/agent/src/inbox.ts:25` |
| claim | 驱动器在步骤边界从 inbox 取出批次：全部 `next-step` 输入 + 轮次边界上的一条 `next-turn` 消息 | `packages/core/agent/src/inbox.ts:71` |
| steering / inject | `steer()` = 投递到 `next-step` 并唤醒（中途引导，最近步骤消费）；`inject()` = 投递到 `next-step` 不唤醒（模型可见上下文，下次获准请求消费） | `packages/core/agent/src/runtime-types.ts:133`、`143` |
| emit / serial / waterfall | Cordis 三种分发模式：emit=同步不等待、serial=顺序 await 直到 bail、waterfall=围绕最终 `next` 回调的中间件链（不调 `next()` 即否决） | `vendor/cordis/src/events.ts:32`、`194`、`204`、`234` |
| agent/* 事件 | 携带活跃 `Agent` 的实时事件域：inbox、步骤、状态、请求、验证、续跑；观察/拦截进行中的工作用它们 | docs/architecture.zh.md:60 |
| session/* 事件 | 持久事实的广播：`session/event`（append 后 fire-and-forget）、`session/created`、`session/disposed`、`session/flush`（并行持久化屏障） | `packages/core/session/src/index.ts:54-86` |
| Scope / Scoped\<T> | 作用域原语：`createScope` 铸造一个打标签的 Cordis context，`scopeTarget(base,key)` 铸造只用于路由的事件接收器 | `packages/core/scope/src/index.ts:137`、`170` |
| Initiator | 进程本地"发起 agent"归因：`withInitiator(agent, op)` 让异步驱动链继承 `currentInitiator()`；环境存在 ≠ 存活证明 ≠ 授权 | `packages/core/agent/src/index.ts:309`、`341` |
| EpochHeader | 记录进日志的请求信封：调用配置 + 适配器默认值标记 + 渲染后的 system prompt + 工具 schema | `packages/core/session/src/types.ts:201` |
| request/header 事件 | 把"下一次请求长什么样"作为会话状态写入日志（reason: initial/resume/change），请求成为日志的纯函数 | `packages/core/session/src/types.ts:304` |
| Branded ID | 结构上是字符串、类型上不可互换的品牌化 id（`SessionId`、`CallId`） | docs/subsystems/core.zh.md:302-317 |
| session/end-seed | 种子（恢复/fork/回放）后的第一条实时写入标记；`firstLiveSeq` 的持久投影 | `packages/core/session/src/types.ts:311` |
| fork | 从活会话的稳定前缀创建子会话：事件深克隆 + `parentSession`/`seedLength` 元数据 | `packages/core/session/src/index.ts:1081` |
| 模型可见即已记录 | 运行时不变式：抵达模型请求的一切必须能从日志重建（有配套插件断言） | docs/architecture.zh.md:100 |
| SessionForkError | fork 拒绝的类型化错误（SESSION_NOT_FOUND / OPEN_TURN / INVALID_BOUNDARY 等） | `packages/core/session/src/index.ts:771-784` |
| TurnEndReason | 轮次为何结束（completed/aborted/blocked/error/max-tokens/interrupted），可合并扩展 | `packages/core/session/src/types.ts:155` |
| AgentCancelCause | 取消的调用方意图（user/parent/hook/disposed），TypeScript 强制的同进程输入 | `packages/core/session/src/types.ts:143` |
| 持久化协调器 | session-persistence 的共享缓冲/串行化/修复/回收编排；后端只实现 `persist` 写与 `load` 读 | `packages/session/session-persistence/src/coordinator.ts:84` |

---

## 2. 模块与文件地图（包 → 职责 → 关键文件）

### 2.1 核心主干（一条轮次流经的六个包）

| 包 | 职责 | 关键文件 |
|---|---|---|
| `core/session` | 仅追加 `SessionEvent` 日志、内存 store（`ctx.sessions`）、surface 投影、fork、请求头折叠 | `src/index.ts`（Session/SessionStore）、`src/types.ts`（事件词表）、`src/surface.ts`（deriveMessages 的逐节点投影） |
| `core/system-prompt` | 提示词片段/动态上下文/工具 schema/变量的注册与组装（`ctx.systemPrompt`） | `src/index.ts`（`assemble()` 走 `system-prompt/assemble` waterfall） |
| `core/tools` | 作用域化工具注册表 + 受保护执行流水线（`ctx.tools`），`tools/{pre-execute,execute,post-execute,result}` | `src/index.ts`（ToolDefinition、调度器 `TOOL_RUNTIME_SCHEDULER`） |
| `core/agent` | `Agent` 接口、活跃注册表、inbox、dispatch、initiator（`ctx.agents`） | `src/index.ts`（AgentRegistry）、`src/runtime-types.ts`（接口+事件词表）、`src/inbox.ts`、`src/dispatch.ts`、`src/consumed-work.ts` |
| `core/agent-loop` | 实现公开 `Agent` 约定的具体驱动器（`ctx.agentLoop`），创建事务 + turn/step 状态机 + 工具调度 | `src/index.ts`（AgentLoop 工厂）、`src/agent.ts`（ReactLoopAgent 驱动器）、`src/tool-calls.ts`（并行工具调度）、`src/runtime-context.ts` |
| `core/scope` | 按 agent 划分作用域的注册原语（无 ctx 键的纯库） | `src/index.ts`（createScope/scopeTarget/bindScopeParent）、`src/store.ts`（ScopedLayers/NamedEntries） |

模块图关系（docs/subsystems/core.zh.md:20）：`scope/` 是唯一非服务包，位于 `session/` 与 `system-prompt/` 之下；`agent-loop` 是公开 `Agent` 约定的唯一实现；扩展插件依赖 `agent` 而绝不直接依赖 `agent-loop`，因此循环保持可替换。

### 2.2 会话持久化（packages/session）

| 包 | 职责 |
|---|---|
| `session-persistence` | 共享协调器：`SessionWriteBehind`（有界写批量，`maxDelayMs` 默认 200ms）、`SessionPreparations`（detached 准备缓存）、修复（`interruptedTurnClosers`） | 
| `session-persistence-jsonl` | JSONL 后端（`format.ts`：chunk 打包行等编码） |
| `session-persistence-sqlite` | SQLite 后端 |
| `session-checkpoint-policy` | 每次请求的持久化检查点（`session/flush` 屏障） |
| `session-projection(-cache)` / `session-telemetry(-otel)` / `session-title*` | 派生投影、遥测、标题生成（都消费 `session/event`） |

关键事实：`Session.append` 是同步热路径，**从不阻塞 I/O**——持久化插件订阅 `session/event` 异步缓冲，`session/flush` 是显式持久化屏障（`packages/core/session/src/index.ts:1022`）；`SessionWriteBehind.enqueue` 克隆事件、按固定窗口批量写（`packages/session/session-persistence/src/write-behind.ts:45`）。

JSONL 后端磁盘格式（`packages/session/session-persistence-jsonl/src/format.ts`）：一个会话 = 项目目录下的一行 header + 逐事件行，可整体 zstd 压缩（`.jsonl.zstd`，format.ts:24）；首行是 `{type:'session', version, id, createdAt, ...}` 标签（format.ts:33-64），阅读器靠它区分 header 与事件行；`SessionId` 是未校验的品牌化字符串，必须经 `encodeSegment`（`~XXXX` 转义全部不安全码元，含孤立代理项，format.ts:121-136）才能进路径；`projectKey`（format.ts:147）把 cwd 映射成人类可读目录名。存储约定（docs/subsystems/session.zh.md:603-605）：持久日志无损保存每个事件**包括** `assistant/chunk`，`seq` 必须连续因此不能过滤分片；后端可选择自己的存储编码，只要 `load` 返回与追加时完全一致的事件（JSONL 默认启用的 chunk 打包行 `packChunkRuns` 就是此类编码）。

### 2.3 启动与宿主

| 路径 | 职责 |
|---|---|
| `apps/cli/src/bin.ts` | `dsh` 二进制入口：按 mode 动态 import（profile / plugin / dump-config） |
| `apps/cli/src/profile-boot.ts` | profile 组装：bundle 层 + profile 的 `cordis.patch.yml` + home 层 + `--patch` overlay + 遥测开关，然后 `boot()` |
| `packages/boot/app-boot/src/index.ts` | 共享 boot 胶水：`.env` 分层加载、fail-loud、`boot()` 驱动 Cordis Loader 直到树 settle |
| `packages/boot/cmdline` | 命令行列快照（`ctx.cmdlineArgs`） |
| `packages/host/webserver/src/index.ts` | 宿主侧 HTTP 服务（`node:http` + 路由注册 + fallback），"不知道任何 harness 概念" |
| `packages/host/frontend-static` / `apiproxy` / `plugin-inventory` | 前端静态托管 / RPC 代理 / 插件清单 |

### 2.4 关键消费者（展示扩展点怎么用）

| 包 | 用途 |
|---|---|
| `goal/goal-round-driver` | 同会话目标续跑：监听 `agent/status`/`agent/inbox/*`/`session/event`，在 `agent/pre-step` 验证续跑消息的预约身份，`agent.followup(message)` 排队下一轮 |
| `compaction/compaction-basic` | 在 `agent/pre-step` 做步骤压力压缩，在 `agent/request-error` 处理 `CONTEXT_WINDOW_EXCEEDED` 并返回 `{kind:'retry'}` |
| `compaction/compaction-tool-result-pruner` | 用 `surfaceOp: {op:'replace'}` 剪枝工具结果 |
| `llm/llm` | 消息/流式词表与适配器 seam：`llm/stream` waterfall、`LlmCallConfig`、`StreamChunk`、`PreparedLlmCall.retryPolicy` |

---

## 3. 关键类型与接口

### 3.1 `Agent`：公开活 agent 句柄

源码：`packages/core/agent/src/runtime-types.ts:64`（精简注释）：

```ts
/** Public live-agent handle. */
interface Agent {
  readonly id: SessionId        // 与 session 共享的单一身份
  readonly options: AgentOptions // provider route + model + maxTokens
  readonly session: Session     // 驱动器驱动的活会话；其日志是持久真源
  readonly inbox: Inbox         // agent 拥有的持久待处理工作投影
  readonly status: AgentStatus  // 'idle' | 'running'，每次转换发 agent/status
  readonly ctx: Context         // agent 作用域 context；卸载时撤销，之后拒绝注册
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>     // 整个 agent 达到静止后 resolve
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void  // 排队普通轮次并唤醒
  steer(message: UserMessage): void     // 提交给最近步骤的中途引导
  inject(message: UserMessage): void    // 排队模型可见上下文，不唤醒
}
```

配套类型（同一文件）：

```ts
type AgentStatus = 'idle' | 'running'                 // runtime-types.ts:50
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] } // :53
type RequestErrorAction = { kind: 'retry' } | undefined // :58
type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact' // :61
interface AgentOptions { provider?: string; model?: string; maxTokens?: number } // :24
type InboxTarget = 'next-turn' | 'next-step'          // types.ts:10
```

### 3.2 `AgentRegistry`（ctx.agents）：注册表 + 工厂委托 + initiator

源码：`packages/core/agent/src/index.ts:256`。核心成员：

```ts
class AgentRegistry extends Service {
  private store = new Map<SessionId, AgentEntry>()          // :257 活跃 agent
  private factory: FactorySlot | undefined                  // :258 创建工厂（agent-loop 注入）
  private readonly initiators = new AsyncLocalStorage<Agent | undefined>() // :259
  private initiatorState: 'active' | 'closing' | 'disposed' = 'active'
  currentInitiator(): Agent | undefined                     // :309
  requireInitiator(): Agent                                 // :322
  withInitiator<T>(agent: Agent, operation: () => T): T     // :341（runWithInitiator :640）
  withoutInitiator<T>(operation: () => T): T                // :356
  setFactory(factory: AgentFactory): () => void             // :372
  create(options): Promise<AgentHandle>                     // :405 经工厂 createAgent
  resume(options): Promise<AgentHandle>                     // :424 经工厂 resume
  register(agent): () => void                               // :450 enter+announce 的复合 effect
  enter(agent, owner): () => void                           // :474 发布前插入（不 announce）
  announce(agent): void                                     // :549 发 agent/created
  get(id): Agent | undefined                                // :583
  isOwnedBy(id, owner): boolean                             // :595
  list(): Agent[] / roots(): Agent[]                        // :603 / :613
}
```

要点：`AgentEntry` 带 `owner`（运行时创建者 agent，与持久 lineage 无关）、`carrier`（`scopeTarget(agent, agent)`，事件作用域路由）；`register()` 返回的必须是 **Cordis effect 的精确 disposer**（复合 effect 要 yield 它以保证卸载顺序，`index.ts:441-449` 注释明确说明 identity 是承重的）。

`AgentFactory`（`index.ts:183`）：`createAgent(ownerCtx, options)` / `resume(ownerCtx, options)`——消费方（如 ACP 桥）只编程对 `ctx.agents`，不依赖具体 loop 包。

### 3.3 `Inbox`：双列表待处理消息投影

源码：`packages/core/agent/src/inbox.ts:25`：

```ts
class Inbox {
  private state: InboxState = { 'next-turn': [], 'next-step': [] }
  get nextTurn(): readonly UserMessage[]   // :43
  get nextStep(): readonly UserMessage[]   // :48
  get hasPending(): boolean                // :53
  clear(): void                            // :58  取消全部（先 next-step 后 next-turn）
  claim(target, turn): UserMessage[]       // :71  批次取出：全部 next-step +（target=next-turn 时）一条 next-turn
  append / prepend / replace / remove      // :86 / :96 / :109 / :121
  splice(target, start, deleteCount, inserted) // :139 标准 splice 语义并持久记录
}
```

每个变更都 `session.append('agent/inbox/spliced', splice)`（`inbox.ts:186`）——inbox 是**日志的增量投影**，构造时从 `session.header.seedLength` 起回放拼接事件（`inbox.ts:32`）。消息 id 全局唯一（跨两条列表），重复 pending 拒绝（`inbox.ts:203-218`）。

### 3.4 `Session` / `SessionStore`

源码：`packages/core/session/src/index.ts:425`（Session）、`:792`（SessionStore）。关键方法：

```ts
class Session {
  readonly header: SessionHeader        // 深冻结的存储元数据（不在日志里）
  readonly firstLiveSeq: number         // 本进程第一条 append 的 seq（种子长度）
  get events(): readonly SessionEvent[] // 不可变快照（复用直到下次 append）
  get seq(): number                     // 下一个 seq == log.length（连续性契约）
  append<T>(type, data, ...opts): SessionEvent<T>  // :604 热路径同步、不阻塞 I/O
  requestHeader(): EpochHeader | undefined          // :670 增量折叠 request/header
  requestContext(): RequestContext | undefined      // :691
  deriveMessages(): Message[]                       // :726 缓存、冻结、O(新节点)
  deriveEventMessage(event): Message | null         // :755 逐节点纯投影
  static create(id, seed?, header?)                 // :482
  static fromRestore(id, seed, header)              // :495 持久化所有权转移路径
}
```

`append()` 契约（`index.ts:604-655`）：data 必须无损 JSON 可序列化（`snapshotJsonValue` 单趟递归校验+拷贝，stateful getter 无法作弊）；surface 事件必须带 `SurfaceIntent`（`surfaceOp` + `sourceEventSeqs`），非 surface 事件编译期拒绝；**append 不可重入**（`entry.appending` 守卫）；提交前 `surfaceManager.validateNext(event)` 校验候选；推入日志后 `session/event` 观察者逐个 contain（失败只记日志）。

`SessionStore.fork`（`index.ts:1081`）：`fork(source, boundary?, childSessionId?)` → `_resolveForkSource`（:1140，必须是活 store 实例）→ `_forkSeed`（:1097，边界必须是连续存在的 seq，且所选前缀不得结束在开放轮次内 → `OPEN_TURN`）→ `create(child, {seed, meta:{parentSession, seedLength}})`。

### 3.5 事件词表：`SessionEventMap` 与 `SessionEvent`

源码：`packages/core/session/src/types.ts:236`（Map）、`:404`（联合）。核心 12 个核心事件：`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`request/header`、`request/context`，另有 `session/end-seed`（种子边界）与插件合并扩展（`agent/inbox/spliced` 来自 dsh-agent，`compaction/*` 来自 compaction）。

`SessionEvent` 信封（types.ts:404）：

```ts
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    seq: number       // 日志内单调位置
    time: number      // epoch 毫秒
    data: SessionEventMap[K]
    ignorable?: true  // 缺失=必须可读：不认识的 required 事件必须拒绝重建
  } & (K extends SurfaceEventType ? {
    sourceEventSeqs?: number[]  // 引用的更早事件 seq（assistant/message 可携带显式空数组）
    surfaceOp?: SurfaceOp       // 'append' | {op:'replace',start,end}
  } : object)
}[T]
```

### 3.6 作用域原语

源码：`packages/core/scope/src/index.ts`：

```ts
type ScopeKey = object                          // :15 不透明、按身份比较
type Scoped<T extends object> = object & { readonly [ScopedBrand]: T } // :27 只路由不暴露属性
function bindScopeParent(key, parent): ScopeParentBinding  // :72 环检测
function scopeChainOf(key): ScopeKey[]          // :98 [key, parent, grandparent, …]
interface Scope { ctx; rawDispose; dispose() }  // :105
function createScope(ctx, key, options?): Scope // :137 铸造打标签的 context（ctx.plugin(scope)）
function scopeOf(ctx): ScopeKey | undefined     // :154
function scopeTarget<T>(base, key): Scoped<T>   // :170 路由接收器：未打标签的监听器全局接收，
                                                //       打标签的监听器接收匹配 key 或其祖先
```

`store.ts` 的 `ScopedLayers`（:159）：global 层 + 按 scope key 的覆盖层；`merge(scope, pick)`（:208）给出"全局 + 祖先链 + 本层，最近者胜"的有效表；`effect(ctx, action, label)`（:226）把一次注册挂到调用方 fiber 上（作用域可见性 + effect 所有权都由 ctx 决定）。

### 3.7 工具执行流水线（tools）

源码：`packages/core/tools/src/index.ts`：

```ts
interface ToolDefinition extends ToolSchema {   // :222
  output: ToolOutputDefinition                  // 规范化输出声明（schema + render + presentationMeta）
  execute(args, exec): Promise<unknown>         // 只返回规范化的无损 JSON 值
  finalizeContent?(exec, result)                // 材料化前的最后一步内容变换
  timeoutMs?: number                            // 协作式超时预算（绝不发给模型）
  isConcurrencySafe?(args): boolean             // 并行分组 opt-in
  presentCall? / presentResult?                 // 纯函数 UI 呈现
}
type ToolExecutionMode = { kind: 'parallel' } | { kind: 'exclusive' } // :344
interface ToolRuntimeScheduler {                // :451 调度器视图（非插件扩展点）
  prepare(exec): Promise<ScheduledToolPreparation>   // 有序 pre-execute/guard 门
  dispatch(exec): Promise<ScheduledToolDispatch>     // 只跑 around-dispatch/body
  finalize(exec, result): Promise<ToolExecutionResult> // post-execute + 内容终化
  finish(exec, result): ToolExecutionResult
}
export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('...') // :466
```

三个 waterfall 事件：`tools/pre-execute`（:152，allow/deny/ask）、`tools/execute`（:163，围绕 dispatch 的 timeout/retry/metrics 包装，只许换 signal）、`tools/post-execute`（:175，accept/replace/enrich/block）。`executionMode(exec)`（:1276）是纯同步分类器。

### 3.8 驱动器内部状态

源码：`packages/core/agent-loop/src/agent.ts:38`：

```ts
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort; lastTurn; wakeRequested }  // 非轮次维护任务
  | { kind: 'running'; abort; turn; step; wakeRequested }     // 驱动器排空区间
```

### 3.9 轮次结束原因与取消原因

源码：`packages/core/session/src/types.ts:143`、`:155`：

```ts
/** 活跃 agent 驱动器的取消原因——TypeScript 强制的同进程输入。 */
type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/** 轮次为何结束。可合并扩展的和类型。 */
interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  aborted: { kind: 'aborted'; reason: TurnEndCancelCause }  // 取消请求打断活轮次
  blocked: { kind: 'blocked' }
  error: { kind: 'error'; error: LlmFailure }  // 结构化失败：LlmError 事实原样，或 {message, code:'UNKNOWN'}
  'max-tokens': { kind: 'max-tokens' }         // 至少一步触顶；粘性：之后正常完成的步骤不降级
  interrupted: { kind: 'interrupted' }         // 崩溃恢复合成；loop 从不发出
}
```

注意 `max-tokens` 的**粘性**（agent.ts:285-290 的 `turnEnds` 合并逻辑）：只要轮次内任何一步以 `max-tokens` 结束，整轮就以 `max-tokens` 收尾，即使插件又继续了轮次——消费方因此能区分"正常停止"与"截断停止"。

### 3.10 请求信封 `EpochHeader` 与 `request/header` 事件

源码：`packages/core/session/src/types.ts:201`：

```ts
interface EpochHeader {
  config: LlmCallConfig                    // 调用配置（provider、model、reasoning effort、采样标量）
  adapterDefaults?: LlmCallConfigAdapterDefaults  // 从确切 adapter 具体化的有效配置字段标记
  system?: string                          // 渲染后的系统提示词；无 system 的请求缺席
  tools?: ToolSchema[]                     // 组装的工具 schema；无工具的请求缺席
}
type RequestHeaderReason = 'initial' | 'resume' | 'change'   // types.ts:228
```

`request/header` 每次"请求信封发生变化"时追加完整快照（reason `change`），`foldRequestHeader(events)` 选最新快照重建（request-header.ts）；`request/context` 只在路由/容量变化时追加，且**不参与** header 相等性比较（`headerEquals` 是逐字段的重建约定，把容量折叠进去会让一次容量变化被登记为请求信封 change）。规范形式：空 system / 空 tools 表示为字段缺失。

### 3.11 Cordis 分发模式（事件语义的基石）

源码：`vendor/cordis/src/events.ts:32`：

```ts
type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'
// emit:      同步执行监听器、不等待返回值（events.ts:194）
// parallel:  全部并发、全部等待（:183）
// serial:    顺序 await，直到一个监听器返回 bail 值（isBailed: 非 null/false/undefined，:204）
// bail:      同步执行直到第一个 bail 值（:217）
// waterfall: 参数最后一位是 next 回调，监听器包裹其余链（:234）
```

`dispatch(type, args)`（:165）先做 `thisArg` 移位与 `Context.filter` 过滤，再返回绑定好 `this` 的回调数组——DSH 的 scope carrier（`scopeTarget`）正是通过 `[Context.filter]` 接入这里（scope/index.ts:170-185）。DSH 只用其中三种：emit（通知）、serial（`agent/turn-stopping`）、waterfall（一切决策点）。

---

## 4. 执行流程（turn/step 状态机 + 关键代码）

### 4.1 创建事务（AgentLoop.prepare → publish）

源码：`packages/core/agent-loop/src/index.ts:459`。`AgentLoop` 是 `AgentFactory` 的具体实现（`index.ts:296`），构造时向 `ctx.agents.setFactory(this)` 注册（`index.ts:350`），并注册 `provider`/`model`/`cwd` 三个提示词变量（`index.ts:351-353`）。

`prepare()` 的关键步骤（:459-578）：

1. 校验 `AgentOptions.maxTokens` 为正安全整数（`assertAgentOptions`，:142）。
2. **发布前**注册反向拆解（reverse teardown）：`abort` 控制器融合三个所有者——调用方的 `signal`、owner fiber 卸载、工厂 teardown（:474-487）。
3. `new ReactLoopAgent(loopCtx, id, options, session)`（:549）。
4. 返回 `PreparedAgent`：`publish(source)` 依次 `sessions.enter(session)` → `agents.enter(agent, ownerCtx.agent)` → `sessions.announce(session)` → `agents.announce(agent)` → `emitAgentEvent(agent/session-start)`，每步之间 `assertLive()`（:556-570）。

创建路径：`create()`（同步，:589）与 `createAgent(ownerCtx, options)`（异步，:606）都走 `SessionPreparation.create(sessions.prepare(...))` → `setupAndPublish`（:625）：先 `setup?.(agent.ctx)` 组装作用域世界（可选返回同步 `commit()`），再 `publish`；任何一步失败 → `prepared.dispose()` 回滚，两个 id 都不发布。`resume()`（:653）先 `persistence.prepare(id, fused)` 加载持久会话，再走同一 setup/publish 事务（source = 'resume'）。

`publish()` 的核心顺序（`packages/core/agent-loop/src/index.ts:556-570`）——注意每步之后的 `assertLive()`（fused abort 未触发）：

```ts
publish: (source) => {
  assertLive()
  detachSession = agent.ctx.sessions.enter(session)      // 先装 session 发布钩子
  detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent) // 再进 agent 注册表
  agent.ctx.sessions.announce(session)                   // session/created
  assertLive()
  loopCtx.agents.announce(agent)                         // agent/created
  assertLive()
  emitAgentEvent(loopCtx, agent, 'agent/session-start', { source }) // 第一个可驱动扩展点
  assertLive()
  return { agent, dispose }
}
```

配置驱动的声明式 agent：构造器遍历 `config.agents`（:355-381），`sessionId` 缺失时 mint `{id}-session-{uuid}`；有 `resumeSessionId` 或持久化存在时走 `resumeWith`；启动失败发 `agent-loop/config-start-failed`（:183）。

### 4.2 唤醒与驱动器生命周期（ReactLoopAgent）

源码：`packages/core/agent-loop/src/agent.ts`。

`send()`（:113）→ `inbox.splice(target, Infinity, 0, [message])` 插入（`Infinity` 即 append）→ `wakeDriver(wakingAfterAbort)`。`wakeDriver()`（:172-193）：

```ts
private wakeDriver(wakeAfterAbort = false): void {
  if (this.phase.kind !== 'idle') {
    // 维护或已中止的活动不能投递唤醒：锁存到收敛时重放；
    // 存活驱动器自己认领队列工作；disposed 永不锁存（teardown 不等模型轮次）。
    const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
    if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
      this.phase.wakeRequested = true
    }
    return
  }
  const driver = Promise.withResolvers<void>()
  this.activityDone = driver.promise
  this.setPhase({ kind: 'running', abort: new AbortController(), turn: this.phase.lastTurn, step: 0, wakeRequested: false })
  this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
}
```

`setPhase`（:104）只在跨 `idle ↔ running` 时 emit `agent/status`。`kick()`（:210-223）`while (await this.turn()) {}`，退出时回 idle 并检查 `wakeRequested && inbox.hasPending` 再唤醒（唤醒锁存重放）。`whenIdle()`（:195）循环等 `activityDone` 直到观察到的活动不再变化（覆盖"旧活动退休前已启动的替代工作"）。

### 4.3 turn 状态机

源码：`packages/core/agent-loop/src/agent.ts:246`：

```
turn()（返回 boolean：是否还有下一轮）
  phase.turn + 1 → session.append('turn/start', {turn})
  loop:
    signal.throwIfAborted()
    step = phase.step + 1
    decision = preStep(target, {turn, step})          // claim + assemble + agent/pre-step waterfall
    if decision.kind === 'reject'  → turnEnds = {kind:'blocked'}; return false
    if turnEnds && messages 为空   → break             // max-tokens 粘性后的空批次
    if phase.step === 0 && messages 为空 → turnEnds={kind:'completed'}; return false  // 无模型调用
    session.append('step/start', {turn, step})
    for message of decision.messages → session.append('user/message', message, {surfaceOp:'append'})
    stepEnd = step(assembly)                           // 模型请求 + 工具
    turnEnds = 合并（max-tokens 粘性优先）
    finally: session.append('step/end', {turn, step})
    if turnEnds && inbox.nextStep 为空 → await dispatch.serial('agent/turn-stopping', {turn, signal})
    if turnEnds && inbox.nextStep 为空 → break
    target = 'next-step'                               // 工具 continuation → 下一步
  catch: aborted → turnEnds={kind:'aborted', reason: signal.reason}
         其他 → turnEnds={kind:'error', error: LlmError.failure 或 {message: errorChain, code:'UNKNOWN'}}
  finally: session.append('turn/end', {turn, reason: turnEnds!})
  if !inbox.hasPending → return false
  否则重置 phase（新 AbortController、step=0、wakeRequested=false）→ return true
```

`preStep()`（:225-243）：

```ts
const claimed = this.inbox.claim(target, position.turn)   // 批次取出（持久纯删除 splice）
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
const sections = renderContextSections(assembly)
const context = this.runtimeContext.project(joinContextSections(sections), sections) // 动态上下文快照
const decision = await this.dispatch.waterfall(
  'agent/pre-step', { messages: claimed, ...position, signal },
  () => Promise.resolve({ kind: 'enter', messages: context === undefined ? claimed : [...claimed, context] }),
)
return decision.kind === 'reject' ? decision : { ...decision, assembly }
```

`agent/pre-step` 是请求推导前唯一的串行监听器链（docs/subsystems/core.zh.md:241）。**reject 不打开步骤**；首次领取被 reject 或被改写为空 → 关闭一个不含步骤的持久轮次（日志记录这次尝试）。

认领（claim）本身（`packages/core/agent/src/inbox.ts:71-78`）——纯删除 splice，不产生 discarded 通知：

```ts
claim(target: InboxTarget, turn: number): UserMessage[] {
  const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
  if (target === 'next-turn') {
    claimed.push(...this.mutate('next-turn', 0, 1, [], false))   // 轮次边界只取一条
  }
  for (const message of claimed) this.notifications.claimed(message, turn) // 逐条 agent/inbox/claimed
  return claimed
}
```

`mutate`（inbox.ts:158-193）先把规范化 splice 写入日志（`session.append('agent/inbox/spliced', ...)`），**日志提交后才变更内存投影**——同步 `session/event` 观察者能看到 pre-splice 的列表，从而从规范化坐标重建被移除的消息；`discardRemoved=true`（普通删除/clear）时逐个发 `discarded` 通知。

### 4.4 step 状态机（模型请求 + 工具）

源码：`packages/core/agent-loop/src/agent.ts:332`（step）、`:407`（buildRequest）：

```
step(assembly):
  system = renderPrompt(assembly)
  while true:
    {request, preparedCall} = buildRequest(turn, step, tools, system, session.deriveMessages(), signal)
      // buildRequest：
      //   1) 从 request/header 折叠取持久化配置（首个请求用 agent options；之后 requestProposal 剥离 adapter 默认值）
      //   2) dispatch.waterfall('agent/request', ..., () => seedConfig)   // 插件可替换冻结配置
      //   3) llm.prepareCall(proposedConfig, signal) → 解析 adapter 默认值；NO_ADAPTER 容忍
      //   4) canonicalHeader(...) → 与上一条 request/header 比较（headerEquals），变化才 append（reason initial/resume/change）
      //   5) request/context 路由容量变化才 append
      //   6) request = markAgentLoopRequest(deepFreeze({...header.config, messages: boundaryMessages, ...}))
    stream = preparedCall?.stream(request) ?? ctx.llm.stream(request)
    for await chunk of stream:
      signal.throwIfAborted()
      chunkSeqs.push(session.append('assistant/chunk', {turn, step, chunk}).seq)
      assembler.push(chunk)
    finish = assembler.finish
    if finish.kind === 'error' | 'aborted':
      action = await dispatch.waterfall('agent/request-error', {failure, retryPolicy, signal}, () => undefined)
      if action?.kind !== 'retry' → throw LlmError(finish.failure)
      continue                                            // 重试同一 step（不重新开 step）
    session.append('assistant/message', {turn, step, message, usage?}, {surfaceOp:'append', sourceEventSeqs: chunkSeqs})
    if finish.kind === 'max-tokens' → return {kind:'max-tokens'}   // 粘性
    toolCalls = message.content.filter(block => block.type === 'tool-call')
    if toolCalls.length === 0 → return {kind:'completed'}
    {concluded} = executeToolCalls(ctx, turn, step, toolCalls, signal,
      context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]))
      // additionalContexts 投回 next-step 收件箱 → 下一步骤
    return concluded ? {kind:'completed'} : null           // 工具 continuation → while 再来一次
```

### 4.5 工具调度（tool-calls.ts）

源码：`packages/core/agent-loop/src/tool-calls.ts:59`（executeToolCalls）、`:121`（runGroup）：

- 输入：模型顺序的 `ToolCallBlock[]`；每个 call 构造 `ToolExecutionInput`（callId、解析后的 arguments、agent=initiator、signal）。
- 主循环：按当前 `executionMode(first).kind` 切分组——`exclusive` 是单例屏障，`parallel` 是滚动有界池（容量 `ctx.agentLoop.config.maxParallelToolCalls`，默认 `DEFAULT_MAX_PARALLEL_TOOL_CALLS`）。
- runGroup：`prepare`（有序 pre-execute/guard 门）→ 并发 `dispatch`（只有 body 重叠）→ `commitReady`（**按模型顺序**提交，绝不乱序：`committed` 只在连续槽位就绪时推进，:146-160）→ `finalize`/`finish`（post-execute + 内容终化）。
- 提交：`tool/call`（:262）与 `tool/result`（:268，`sourceEventSeqs: [callSeq]`）成对 append；`additionalContexts` 通过 `acceptContext` 投回 next-step 收件箱；`concludesTurn` 结果结束轮次。
- 中止：停止启动新调用，排空已启动调用，未启动的调用补写合成错误结果 `TOOL_ABORTED_BEFORE_DISPATCH`（:249-259）——**保证回放仍然有效**（每条 model 调用都有配对结果）。
- 调度器内部失败：保留已记录的 `tool/call`，不伪造结果，向上抛。

### 4.6 轮次停止检查点（agent/turn-stopping）

源码：`packages/core/agent-loop/src/agent.ts:295-299`：`if (turnEnds && this.inbox.nextStep.length === 0) await this.dispatch.serial('agent/turn-stopping', {turn, signal})`，然后 `if (turnEnds && this.inbox.nextStep.length === 0) break`。语义（runtime-types.ts:278 注释）：serial 事件没有 `next()`；监听器反对就 `agent.steer(...)`，机器重读收件箱——有新 steering 就再跑一个 step，没有就关轮次。**数据决定结果，监听器顺序改变不了结局**。反向控制（提前停工具循环）同样是数据：`tool/result` 携带 `concludesTurn` 在本 step 结束轮次；但已提交的 next-step 工作（同 step `additionalContexts` 或竞态 steering）不会被短路，收件箱排空才关轮次。

### 4.7 错误恢复与取消

- 请求失败：`agent/request-error` waterfall（agent.ts:354-370）。监听器负责恢复时返回 `{kind:'retry'}` 且不调 `next()`；默认 `undefined` 让失败保持终态 → 抛 `LlmError` → turn catch → `turn/end {kind:'error'}`。
- 上下文溢出恢复的规范实现（compaction-basic，`src/index.ts:179-223`）：只处理 `CONTEXT_WINDOW_EXCEEDED`；先做工具结果剪枝/摘要（生成 surface `replace`），只有当 `surface.replaceGeneration` 确实推进了才 `return {kind:'retry'}`（重试轮次从替换后的 surface 出发），否则 `next()` 保留原始错误。
- 持久层重试策略：`ResolvedRetryPolicy` 由适配器 `providerRetryPolicy` 提供，随 `PreparedLlmCall.retryPolicy` 暴露给 `agent/request-error`（llm/src/index.ts:159、387-392）。
- 取消：`cancel(cause, {keepInbox})`（agent.ts:134-140）——不清 inbox 的选项保留待处理工作；否则 `inbox.clear()`（持久 `agent/inbox/spliced` outcome:'canceled'）+ `phase.abort.abort(cause)`。**第一个 cause 赢**（AbortController 语义）；没有活跃活动时取消是 no-op，不会武装后续工作。`turn/end` 只持久化粗粒度 `{kind:'aborted', reason}`。
- 取消后唤醒锁存：`send()` 捕获 `wakingAfterAbort`（agent.ts:116），中止中的活动把唤醒锁存到收敛（wake latch，见 .agents/notes/implemented/bug-fix/2026-08-07-cancel-convergence-wake-latch.md）。
- 工作归因：`foldConsumedWork`（consumed-work.ts:68）从日志折叠"消费过工作"的轮次与未运行即被丢弃的输入——`agent/inbox/spliced` 的 `removedCount` + `outcome:'canceled'` 是唯一能区分"轮次认领了输入"与"工作未运行被丢弃"的持久事实。

### 4.8 续跑（continuation）的完整范例：goal-round-driver

源码：`packages/goal/goal-round-driver/src/index.ts`。它演示了"纯消费者"如何驱动 agent 循环（:138-205）：

1. `agent/status` 变 idle → `requestDrive`（:259-277）：`goal.activation === 'armed'` 且未超 `maxGoalRounds` → 渲染续跑提示 → `createUserMessage({source:{kind:'goal', goalId, revision, round}})` → **`agent.followup(message)`** 排队。
2. `agent/inbox/inserted/claimed/discarded` 跟踪自己消息的 phase（queued/claimed/admitted/cancelled，:284-305），`session/event` 里 `user/message` 出现自己的 id → admitted（:312-315）。
3. `agent/pre-step`（:349-414）是**验证关卡**：找到自己 source 的消息后 `validReservation` 校验"仍是活的精确修订、armed、round == roundsStarted+1"，不合法就 `restoreOtherClaimed`（把批次里其它消息 prepend 回 next-step）+ `{kind:'reject'}`——伪造的续跑消息永远进不了模型。
4. 用 `ctx.agents.withoutInitiator` 串行化自己的调度任务（:215），与 agent 驱动器区分归因。

---

## 5. 设计模式与权衡

### 5.1 事件溯源 + 派生投影（"模型可见即已记录"）

- **问题**：模型请求的输入（消息历史、system、tools）若单独存储，回放、fork、恢复、UI、遥测各自存一份，必然漂移。
- **方案**：会话 = 仅追加 `SessionEvent` 日志（唯一真源）。请求输入全部是日志的纯函数：`deriveMessages()` 从 surface 投影历史，`request/header` 记录请求信封，`foldRequestHeader` 重建。日志连 `assistant/chunk` 原样保存（token 级回放保真）。运行时不变式（`agent-loop/src/invariant.ts:19-54`）在 `llm/stream` 上断言：loop 构建的请求必须冻结、携带 sessionId、`JSON.stringify(options.messages) === JSON.stringify(session.deriveMessages())`、且与折叠出的 header 逐字段一致（`log-reconstruction desync` 即 fail）。
- **代价**：日志是 append-only 的，改写必须用 surface `replace`（遮蔽）而非删改——压缩语义复杂；每加一种模型可见输入就要加一种事件类型（词表膨胀）；`seq = log.length` 的连续性契约让所有后端都必须存完整事件（不能过滤 chunk）。

### 5.2 瀑布式拦截链（waterfall）作为唯一串行扩展点

- **问题**：多插件都要"在模型请求前/后"做策略（压缩、验证、steering 校验），顺序敏感的 hook 如何组合而不互相踩踏？
- **方案**：Cordis `waterfall`——事件参数最后一个位置是 `next` 回调，监听器像中间件一样包裹其余链；**不调 `next()` 即否决**（vendor/cordis/src/events.ts:234-243）。DSH 把关键决策点都做成 waterfall：`agent/pre-step`（进不进步骤、进什么消息）、`agent/request`（换不换请求配置）、`agent/request-error`（要不要重试）、`system-prompt/assemble`、`tools/{pre-execute,execute,post-execute}`。返回值是权威的：`agent/pre-step` 返回 `PreStepDecision`，包装 `next()` 的监听器保留下游消息。
- **代价**：监听器必须纪律性地调 `next()`（忘记调用 = 静默短路，是常见 bug 源，AGENTS.md 特意强调）；`agent/request-error` 的"谁负责恢复"要靠返回值约定（返回 `retry` 且不调 next = 拥有恢复权），多恢复方并存时需要编排。

### 5.3 作用域注册 + carrier 事件路由（scope）

- **问题**：多 agent 并存，一个插件（如 compaction、goal）要只看到自己 agent 的事件/注册，还要让"父组合"观察所有子 agent——全局事件总线做不到。
- **方案**：`dsh-scope` 两层设计。(1) 注册侧：`createScope(ctx, key)` 铸造打标签的 context，`ctx.agent` 是 agent 作用域（`agent.ts:95` `this.scope.ctx.extend({agent: this})`）；凡经 `agent.ctx` 的注册（工具、提示词段、监听器、`restrict()`）都进该 scope 的层，卸载即撤销（`scope/store.ts:226` `ScopedLayers.effect`）。(2) 路由侧：`scopeTarget(base, key)` 铸造 carrier，dispatch 时按监听器 ctx 的 scope tag 过滤；未打标签的全局监听器收所有事件，打标签的监听器收**匹配 key 或其祖先**的事件（`scope/index.ts:170-185`）——事件只沿作用域链**向上**流动，这让一个 standing 组合能观察其下所有 agent。`agentEvents(ctx, agent, carrier)`（dispatch.ts:107）把 subject 注入与 carrier 熔合成一个派发器，"scope key 与 payload.agent 不可能分叉"。
- **代价**：作用域链是全局 WeakMap（`scopeParents`），需环检测（`linkScopeParent` :54-59）；`rebind` 只能由原 binder 持有的 `ScopeParentBinding` 执行；概念负担重（注册作用域、事件作用域、filter、carrier 四件事要一起理解）。

### 5.4 收件箱即持久投影（inbox 是日志的可重放增量投影）

- **问题**：待处理消息是"排队状态"，若只放内存，进程重启/恢复后队列消失；若单独持久化，又和日志脱节。
- **方案**：每条 inbox 变更都 `session.append('agent/inbox/spliced', {target, start, removedCount?, inserted, outcome?})`（inbox.ts:186）；`Inbox` 构造时从 seed 边界回放拼接（inbox.ts:32），之后增量消费。UI 整体队列消费方按持久 splice 重建 `nextTurn`/`nextStep`；跟踪单条消息的消费方用 `agent/inbox/{inserted,claimed,discarded}` 精确通知。claim 是"纯删除 splice"（不产生 discarded 通知，loop 另行逐条发 claimed），因此**认领与丢弃在日志里可区分**（consumed-work.ts 依赖这一点）。
- **代价**：每条 append/prepend/remove 都是一次日志写入（写放大）；splice 校验严格（坐标、唯一 id）；"模型可见 ⟺ 已记录"要求任何新入队消息类型都必须同时是可 JSON 序列化的 `UserMessage`。

### 5.5 三个事件域分层：持久事实 / 实时控制 / 能力 seam

- **问题**：UI 回放需要"确定性事实"，实时控制需要"活引用 + 拦截"，两者混在一起会让回放依赖不可重放的状态。
- **方案**（docs/architecture.zh.md:57-63）：**会话事件**（`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*`、`agent/inbox/spliced`）是持久事实，经 `session/event` 广播；**agent 事件**（`agent/*`）携带活跃 `Agent` 引用（inbox 通知、状态、pre-step、request、request-error、turn-stopping、session-start、error），是实时协调接口；**能力事件**（`fs/*`、`tools/*`、`telemetry/*`）不引入导入环即可附加策略。轮次/步骤边界是持久事件而不是 agent emit——回放不依赖活进程。
- **代价**：学习者要在三个域之间切换心智模型；事件映射（event-producer-consumer.md）成为必须的导航文档。

### 5.6 创建即事务：setup → enter → announce，失败全回滚

- **问题**：agent + session 两个 id 要原子发布；中途失败不能留下半配置的可见世界；owner fiber 卸载必须按顺序拆（loop 的收尾事件先落日志，再摘注册）。
- **方案**：`prepare/enter/announce` 三段式（agent/src/index.ts:474-576、session/src/index.ts:863-996）：`setup` 在**未发布**的 `agent.ctx` 上组装作用域世界（可选同步 `commit()` 在发布前一刻校验）；`enter` 插入不 announce（返回精确 disposer，复合 effect yield 它以获得卸载顺序）；`announce` 发创建事件（同步 throw 否决发布并配对 `disposed`）。`AgentLoop.prepare` 在**任何资源存在前**注册反向拆解（agent-loop/src/index.ts:474-520），dispose = disposed 原因取消 → whenIdle → 摘作用域 → 摘注册，memoized 保证多个 racing owner 只等一次 quiescence。
- **代价**：接口复杂度高（`prepare`/`enter`/`announce` 是公开跨包原语，要求调用方理解顺序）；`detachRequested` 延迟语义（创建 dispatch 期间请求的 detach 要等 dispatch unwind）是个隐蔽的时序约束。

### 5.7 取消语义：first-cause-wins + 唤醒锁存

- **问题**：多个来源（用户、父 agent、hook、dispose）同时取消；取消后又有新消息到达，谁赢？中止中的驱动器何时能接新活？
- **方案**：`AbortController` 首次 abort 的 reason 即最终 cause（`AgentCancelCause`，TypeScript 强制的同进程输入；跨进程只持久化粗粒度 `aborted`）；`cancel()` 若不清 inbox 则待处理工作留给后续轮次；中止中的唤醒被**锁存**（`phase.wakeRequested`），驱动器收敛到 idle 时重放（agent.ts:172-193、kick 的 finally :217-221）；`disposed` 永不锁存，teardown 不等待模型轮次。`agent/request-error` 在失败步骤关闭后、轮次关闭前运行（失败轮次的 signal 仍存活，可修复持久状态）。
- **代价**：`whenIdle()` 只保证"整个 agent 无活动"，不保证特定消息已结算——调用方必须自己界定"从回执到空闲"的区间（followup 不返回句柄的决策 docs/subsystems/core.zh.md:159）；协作式取消要求所有工具遵守 `exec.signal`（无法硬杀同进程代码）。

### 5.8 surface replace + replaceGeneration 缓存失效

- **问题**：压缩要"遮蔽"旧消息但保留日志字节；增量消费者（UI、缓存）怎么知道是尾部增长还是历史重写？
- **方案**：`SurfaceOp = 'append' | {op:'replace', start, end}`；`SessionSurface.replaceGeneration` 每次提交替换递增；`deriveMessages` 缓存以 generation 为版本，变了就整体重建（session/src/index.ts:726-747）。`sourceEventSeqs` 必须覆盖所有被遮蔽节点（surface.ts:211-243 `assertProvenance`），且 `tool/result` 的替换只能改 content（`assertToolResultRewrite` :287-318）——重写被严格限制。
- **代价**：replace 的合法性校验（范围必须存在于当前 surface、provenance 完整）让压缩实现复杂；"人类 transcript"不能读 surface（被遮蔽内容对用户可见），必须读 append-origin 事件（surface.ts:40-55）。

### 5.9 与 Claude Code / 其他 agent 框架的架构差异点

以下对比基于我对 Claude Code 公开文档/架构的既有认知与对 DSH 源码的直接阅读，属"已知差异"而非逐行源码比对，措辞上尽量保守：

1. **"循环即插件" vs "循环即产品内核"**：DSH 里 agent 循环本身是 `dsh-agent-loop` 这个可替换插件（`ctx.agents.setFactory` 注册，docs/subsystems/core.zh.md:20）；Claude Code 的 agent 主循环（hook 系统之外的 turn/step 驱动）是产品固定行为。DSH 因此能出现 goal-round-driver 这样的"第三方驱动器"在同一接口上编排轮次，而 Claude Code 的扩展主要局限在 hook（PreToolUse/PostToolUse/Stop/SessionStart 等）。
2. **事件溯源 vs 命令式会话状态**：DSH 的会话是仅追加事件日志，模型历史由 `deriveMessages()` 派生、请求信封由 `request/header` 记录、`sourceEventSeqs` 给出消息血缘；Claude Code 以 JSONL transcript 记录交互，但模型上下文（system prompt、工具 schema、消息序列）的"可重建性"不是同等级的运行时不变式。DSH 把"模型可见即已记录"做成 `llm/stream` 上的运行时断言（agent-loop/invariant.ts:19-54），这一层在多数框架里没有。
3. **Hook 桥接是二等公民**：DSH 的 hooks 包（`packages/hooks`）把 Claude Code/Codex 的 hook 协议桥接成 DSH 自己的事件词汇（`UserPromptSubmit`→ 轮次内的 `user/message`、`PreToolUse`→`tools/pre-execute` 等，docs/subsystems/session.zh.md:601）；即 DSH 认为"Claude Code 式 hook"是它的事件体系的一个适配面，而不是顶层抽象。
4. **作用域（scope）体系**：多 agent 并存时，DSH 用 scope 让注册与事件路由按 agent 隔离且可嵌套（父组合观察子 agent）；Claude Code 的单 agent + subagent 模型里没有等价的"注册可见性分层"概念，subagent 之间的能力继承靠显式传递而非作用域链。
5. **Waterfall 中间件范式**：DSH 的拦截点全部是"必须调用 `next()` 委托"的 waterfall（不调即短路），与 Node/Express 中间件同构，多监听器按注册序包裹；Claude Code hook 是"返回 decision 对象"（allow/deny/ask）的命令式约定，顺序语义与组合方式不同。
6. **可回放/可恢复的强约束**：DSH 的 `session/end-seed`、`firstLiveSeq`、fork 的 `OPEN_TURN` 拒绝、崩溃修复只关"确实开放的尾部轮次"（persistence.md）表明"日志即状态机"被当作第一公民设计；大多数 agent 框架的会话恢复是"把 JSON 历史塞回上下文"，不具备这种格式级的不变量。
7. **归属（initiator）而非授权**：`ctx.agents.currentInitiator()` 只做进程内因果归因，文档明确"环境存在 ≠ 存活证明 ≠ 授权"（agent/src/index.ts:250-254）；身份在 worker/进程/持久化/线边界仍是显式字段——这与某些框架把"当前 agent"隐式当作授权主体的做法相反，更接近 Rust 的"显式 ownership"哲学。

### 5.10 一个端到端的"最小循环"阅读路径

给读者的建议阅读顺序（按依赖关系）：`vendor/cordis/src/events.ts`（分发模式）→ `core/scope/src/index.ts` + `store.ts`（作用域）→ `core/session/src/types.ts` + `surface.ts`（日志与投影）→ `core/agent/src/inbox.ts`（收件箱）→ `core/agent-loop/src/agent.ts`（驱动器）→ `core/agent-loop/src/tool-calls.ts`（工具调度）→ `goal/goal-round-driver/src/index.ts`（消费者视角的完整用例）。读完后用 `dsh --profile headless "task"` 跑一个真实任务，把 `--dump-config` 与 `session/event` 订阅日志对照看，效果最好。

---

## 6. 面试要点（每点附代码证据）

1. **"模型可见即已记录"不是口头承诺，是运行时断言**：`agent-loop/src/invariant.ts:19-54` 在 `llm/stream` 上比较请求消息与 `session.deriveMessages()`（JSON 深度相等）及折叠 header。可答："新增模型可见输入必须新增会话事件"的完整理由链（docs/architecture.zh.md:100）。
2. **Waterfall 语义一句话**：事件参数最后一位是 `next`，监听器包裹其余链，不调 `next()` 即否决（vendor/cordis/src/events.ts:234-243）。`agent/pre-step` 返回 `PreStepDecision` 是权威值（runtime-types.ts:53、agent.ts:234-242）。
3. **turn/step 边界是持久事件，控制是 agent 事件**：`turn/start`/`turn/end`/`step/start`/`step/end` 进会话日志（session/types.ts:243-256），`agent/status`/`agent/pre-step` 等是实时扩展点（runtime-types.ts:146-291）。可展开"回放不依赖活进程"。
4. **inbox 双队列 + claim 规则**：`claim(target, turn)` = 全部 next-step + 轮次边界一条 next-turn（inbox.ts:71-78）；每次变更持久化为 `agent/inbox/spliced`（inbox.ts:186）；认领与丢弃可区分（consumed-work.ts:68）。
5. **创建事务的失败回滚**：`setupAndPublish`（agent-loop/src/index.ts:625-645）setup → commit → publish，任何失败 `prepared.dispose()` 回滚；`enter`/`announce` 分离让同步 throw 的创建监听器也能配对 `disposed`（agent/src/index.ts:549-576）。
6. **取消的 first-cause-wins**：`AbortController` reason 即 `AgentCancelCause`（agent.ts:134-140）；`turn/end` 只持久化粗粒度 `{kind:'aborted'}`（session/types.ts:155-174）；唤醒锁存（agent.ts:172-193）。
7. **工具并行调度的有序性**：dispatch 可以重叠，但 `commitReady` 严格按模型顺序提交（tool-calls.ts:146-160）；中止时为未启动调用补合成结果保证回放配对完整（tool-calls.ts:249-259）。
8. **fork 语义**：`fork(source, boundary?, childId?)`，拒绝结束在开放轮次内的前缀（`OPEN_TURN`，session/src/index.ts:1097-1138）；子会话带 `parentSession`/`seedLength`/继承 cwd 元数据。
9. **Initiator 归因**：`withInitiator(agent, op)` 用 `AsyncLocalStorage` 让驱动链继承 `currentInitiator()`（agent/src/index.ts:640-670）；`requireInitiator()` 在 `executeToolCalls` 里恢复 agent（tool-calls.ts:67）；"环境存在 ≠ 授权"。
10. **"注册即副作用"**：所有注册走 `ctx.effect`/`ctx.on`，注册表 `register()` 返回精确 disposer（agent/src/index.ts:450-457 注释强调 identity 承重）；作用域注册用 `ScopedLayers.effect`（scope/store.ts:226）。
11. **缓存投影**：`deriveMessages` 每个 surface 节点只投影一次、O(新节点)、generation 变更重建（session/src/index.ts:726-747）；`requestHeader`/`requestContext` 是增量折叠（:670-699）。
12. **可替换循环**：消费方只依赖 `ctx.agents`（工厂经 `setFactory` 注册），`AgentLoop` 是唯一具体实现，但接口上可整体替换（agent/src/index.ts:372-394、docs/subsystems/core.zh.md:20）。
13. **"认领与丢弃可区分"这一隐藏事实**：`agent/inbox/spliced` 的 `removedCount` + `outcome:'canceled'` 让日志能回答"轮次认领了输入但没跑"（blocked/error/aborted）与"输入未运行被取消"（droppedUnrun）的区别（consumed-work.ts:18-31、68-107）——这是 UI 显示"工作是否被消费"的持久依据。
14. **请求是日志的纯函数**：`request/header`（reason initial/resume/change）+ `foldRequestHeader` 重建请求信封，`request/context` 记录路由容量且不参与 header 相等性（session/types.ts:201-228、request-header.ts）——可答"为什么每个请求都要落一条 header"。
15. **surface 缓存的三元组**：`derived`（缓存数组）+ `derivedNodes`（已投影节点数）+ `derivedGeneration`（surface 重写代次），代次不匹配整体重建（session/src/index.ts:701-747）——可展开"增量投影如何对重写失效"。

## 附二：设计决策 Agent Notes 索引（教学博客的"为什么"素材）

DSH 把每个非平凡设计决策写进 `.agents/notes/implemented/`（`implemented/` 下的笔记以现在时描述已落地的现实）。以下是与核心循环直接相关、且本笔记多处引用其结论的笔记（路径相对仓库根）：

| 笔记 | 主题 |
|---|---|
| `architecture/2026-06-11-event-sourced-sessions.md` | 事件溯源会话的根基决策（为什么历史派生而非存储） |
| `architecture/2026-06-11-microkernel-event-taxonomy.md` | 微内核事件分类（三个事件域的依据） |
| `architecture/2026-06-18-session-surface.md` | surface 机制（surfaceOp / 派生历史唯一来源） |
| `architecture/2026-07-15-agent-initiator-scope.md` | initiator 作用域（环境存在 ≠ 授权） |
| `architecture/2026-07-30-followup-enqueue-and-owned-runs.md` | followup 不返回句柄 / owned-runs 语义 |
| `architecture/2026-08-10-session-log-version-mechanism.md` | 日志格式版本机制（SESSION_FORMAT_VERSION、ignorable 守卫） |
| `feature/2026-06-30-hook-bridges.md` | Claude Code/Codex hook 桥接的事件映射 |
| `feature/2026-07-10-parallel-tool-call-execution.md` | 并行工具调用契约（isConcurrencySafe、有序提交） |
| `bug-fix/2026-08-07-cancel-convergence-wake-latch.md` | 取消收敛唤醒锁存（wake latch） |
| `simplification/2026-07-20-unwrap-injected-content-envelopes.md` | 注入内容解包：投影是逐字透传，framing 归生产方 |
| `simplification/2026-07-28-remove-synthetic-log-only-turns.md` | 移除合成纯日志轮次（执行封闭与独立事件） |

---

## 7. 存疑 / 待确认（诚实列出没看透的地方）

1. **Cordis 的 `waterfall` 实现细节**：`vendor/cordis/src/events.ts:234-243` 中 `args.pop()` 取 innermost `next`、`dispatch` 里 `thisArg` 的移位处理（events.ts:165-175），与 dsh-scope carrier 的 `[Context.filter]` 交互（scope/index.ts:170-185）我读了实现但没跑过事件轨迹；"listener snapshot 先于 log push 解析、回调后于提交运行"（session/src/index.ts:640-647）的确切时序值得用单测验证。
2. **`whenIdle()` 的竞态面**：`activityDone` 循环（agent.ts:195-200）"观察到的活动不再变化"的收敛性，在"旧活动退休前启动替代工作"的窗口里是否有极小概率漏等——注释声称覆盖，但我没有穷举并发证明。
3. **持久化后端的完整写路径**：我只读了 `coordinator.ts` 头部与 `write-behind.ts`；`session-persistence-jsonl/format.ts` 的 chunk 打包行编码（`packChunkRuns`）、SQLite 的 SCHEMA_VERSION、崩溃修复的 `interruptedTurnClosers`（repair.ts）细节未逐行读，写路径的"有界批量窗口 + 显式 flush 屏障"之外是否还有别的持久化点（如 dispose drain）没确认。
4. **`llm-retry` 包**：我看到了 `ResolvedRetryPolicy`/`resolveRetryPolicy`（llm/src/retry-policy.ts:145）和 `PreparedLlmCall.retryPolicy`，但没读 `llm-retry` 插件本身——适配器级自动重试与 loop 级 `agent/request-error` 重试的分工边界（谁在什么条件下重试、重试是否产生新的 `assistant/chunk`）需要再确认。
5. **配置驱动 agent 的 launcher 身份机制**：`CONFIGURED_AGENT_IDENTITIES_KEY` / `configuredAgentIdentities`（agent-loop/src/index.ts:160-211）由 launcher 在 Loader 挂载前 `ctx.provide()` 注入，我只看了消费方（`applyLauncherIdentities` :221），没看任何 launcher（如 apps/web）的实际注入点。
6. **HMR 与用户 patch 热重载**：`watchUserPatches`（app-boot/src/index.ts:232-265）与 profile-boot 的 `composeLive`（profile-boot.ts:240-245）机制我读了，但"组合物插入行按引用共享导致必须 structuredClone"这类别名陷阱只在注释里见过，没有实测验证。
7. **`agent/request` waterfall 与 `llm.prepareCall` 的配置冻结**：`buildRequest` 中"middleware 可服务未注册路由、terminal dispatch 仍需 adapter"（agent.ts:448-455）的 `NO_ADAPTER` 容忍路径，与 `request/header` 的 `adapterDefaults` 标记在 resume 场景下的还原逻辑（agent.ts:417-437）是我推演的，未用真实会话验证。
8. **compaction 与 pre-step 的耦合**：`compaction-basic` 在 `agent/pre-step` 做压力压缩（compaction-basic/src/index.ts:147-165）——如果压缩本身要产生模型调用（summarize），它是在 pre-step 瀑布内发起嵌套 `ctx.llm.stream()`（:236-246），这条"瀑布内嵌套请求"的并发/重入语义我没深挖（它有没有绕过 agent 的 deriveMessages 不变式？`summarizeWithLlm` 直接构造输入，应该是独立于 loop 不变式的）。
9. **web 前端/API 网关面**：任务要求聚焦核心循环，`packages/api`（RPC BFF）、`packages/sdk`、`apps/web`、Typert 网关只在 `ctx.agents`/`ctx.sessions` 的 Typert lookup 注册处（agent/src/index.ts:268-281）瞥见，未展开。
10. **`session-projection-cache` 与 telemetry adoption**：文档提到消费方"把日志回放当作发布替代品"（firstLiveSeq 注释，session/src/index.ts:450-471），但具体投影/遥测插件的消费语义未读源码。

---

## 附：核心代码速查索引（按主题）

| 主题 | 文件:起始行 |
|---|---|
| Agent 接口 | `packages/core/agent/src/runtime-types.ts:64` |
| agent/* 事件词表 | `packages/core/agent/src/runtime-types.ts:146` |
| AgentRegistry（ctx.agents） | `packages/core/agent/src/index.ts:256` |
| Inbox（claim/splice） | `packages/core/agent/src/inbox.ts:25` |
| 事件派发器（agentEvents） | `packages/core/agent/src/dispatch.ts:107` |
| 工作归因（consumed-work） | `packages/core/agent/src/consumed-work.ts:68` |
| AgentLoop 工厂/创建事务 | `packages/core/agent-loop/src/index.ts:296` |
| ReactLoopAgent 驱动器 | `packages/core/agent-loop/src/agent.ts:64` |
| turn 状态机 | `packages/core/agent-loop/src/agent.ts:246` |
| step 状态机 | `packages/core/agent-loop/src/agent.ts:332` |
| buildRequest（request/header 折叠） | `packages/core/agent-loop/src/agent.ts:407` |
| 工具调度 | `packages/core/agent-loop/src/tool-calls.ts:59` |
| 请求重建不变式 | `packages/core/agent-loop/src/invariant.ts:19` |
| SessionEventMap | `packages/core/session/src/types.ts:236` |
| SessionEvent 信封 | `packages/core/session/src/types.ts:404` |
| Session.append | `packages/core/session/src/index.ts:604` |
| deriveMessages | `packages/core/session/src/index.ts:726` |
| SessionStore.fork | `packages/core/session/src/index.ts:1081` |
| surface 逐节点投影 | `packages/core/session/src/surface.ts:83` |
| scope 原语 | `packages/core/scope/src/index.ts:137` |
| ScopedLayers | `packages/core/scope/src/store.ts:159` |
| 提示词组装 waterfall | `packages/core/system-prompt/src/index.ts:467` |
| 工具流水线事件 | `packages/core/tools/src/index.ts:142` |
| Cordis 分发模式 | `vendor/cordis/src/events.ts:32` |
| 续跑消费者（goal） | `packages/goal/goal-round-driver/src/index.ts:76` |
| 压缩/重试消费者 | `packages/compaction/compaction-basic/src/index.ts:137` |
| CLI 入口 | `apps/cli/src/bin.ts:27` |
| profile 组装 | `apps/cli/src/profile-boot.ts:207` |
| boot() | `packages/boot/app-boot/src/index.ts:757` |
| 宿主 web 服务 | `packages/host/webserver/src/index.ts:59` |
| 持久化写后批量 | `packages/session/session-persistence/src/write-behind.ts:22` |
