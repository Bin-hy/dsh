# 多代理编排研究笔记

> 研究对象：DeepSeek Harness（DSH）仓库 `/Users/binhy/Binhy-Projects/deepseekSearch/deepseek-harness`（只读）。
> 范围：subagent、workflow、jobs、schedule、goal、todo、plan、user-questions、workspace 九个编排相关子系统的
> 文档（`docs/subsystems/*.zh.md`）与源码（`packages/` 下对应包）。本笔记为教学博客的素材底稿，
> 所有论断均以源码为准，代码引用格式为 `文件路径:起始行`（行号为该文件内真实行号）。
> 注：仓库基于 vendored Cordis（插件框架），"一切皆插件"，`ctx.*` 服务通过插件注册。

---

## 1. 概念地图

### 1.1 编排栈的分层

DSH 的多代理编排不是单一系统，而是**在 agent loop 之上叠了七层可选能力**。理解顺序：

```
┌─────────────────────────────────────────────────────────────┐
│ 第 0 层：core —— agent loop 执行原语（必装，非可选）            │
│   Agent / Session / Inbox / 消息源 / turn/step 边界          │
├─────────────────────────────────────────────────────────────┤
│ 第 1 层：委托 seam —— subagent（可选能力，按名注册多 Provider） │
│   ctx.subagents：one-shot 前台委托 + 可继续后台子代理          │
├─────────────────────────────────────────────────────────────┤
│ 第 2 层：脚本编排 seam —— workflow（可选，单引擎）              │
│   ctx.workflowEngine：模型写 JS 脚本批量扇出子代理             │
├─────────────────────────────────────────────────────────────┤
│ 第 3 层：后台作业 seam —— jobs（可选，单实现）                 │
│   ctx.jobs：bash/subagent 等长任务的后台生命周期               │
├─────────────────────────────────────────────────────────────┤
│ 第 4 层：持久目标 seam —— goal（可选）                        │
│   ctx.goals：同会话长目标 + 自动续跑 round 循环                │
├─────────────────────────────────────────────────────────────┤
│ 第 5 层：协作状态 —— todo / plan（可选工具与模式）             │
│   todo_write 整表替换、plan mode 软指引                       │
├─────────────────────────────────────────────────────────────┤
│ 第 6 层：人机交互 —— user-questions / schedule / workspace    │
│   问用户、定时提醒、工作区归组                                │
└─────────────────────────────────────────────────────────────┘
```

关键判据：**不属于 agent loop 主干的可选能力，其类型定义就不放在 core 包，而是放在各自 seam 包里**
（`docs/subsystems/subagent.zh.md:5`："与 bash 一样，它是**一项可选能力**，不属于 agent loop，
因此其类型定义在此而非 core.md 中"）。

### 1.2 核心概念词表

| 概念 | 含义 | 出处（首现） |
|---|---|---|
| capability seam | 能力缝：Service Definition / Service Provider / Consumer 三角色的完整组合 | `packages/AGENTS.md` |
| Service Definition | 服务契约（抽象类 / 类型），声明 `ctx.*` 与事件 | `packages/subagent/subagent/src/index.ts:171` |
| Service Provider | 服务的具体实现/传输层，可多个共存（subagent）或单例（bash/jobs/workflow） | `packages/subagent/subagent/src/types.ts:285` |
| Consumer | 面向模型的工具层，把服务包装成 model 可见工具 | `packages/subagent/tool-subagent/src/index.ts:267` |
| one-shot run | 一次性前台委托：一个结果、可 dispose、不可续 | `packages/subagent/subagent/src/types.ts:249` |
| continuable child | 可继续子代理：持久 Session + 至多一个进程内 Activation | `packages/subagent/subagent/src/continuation.ts:191` |
| Activation | 一次"驻留纪元"：重建子 Agent 处于内存中的时段 | `packages/subagent/subagent/src/continuation.ts:159` |
| descriptor | 每个会话支撑子代理的持久身份（`subagent/descriptor` 事件） | `packages/subagent/subagent/src/descriptor.ts:47` |
| 事件溯源 | 会话日志是唯一持久真源，运行时可丢弃，折叠（fold）可重建 | `packages/goal/goal/src/fold.ts:313` |
| job | 后台任务：生产方拥有执行资源，运行时拥有身份/生命周期 | `packages/jobs/jobs/src/types.ts:46` |
| goal round | 一次自动续跑的模型轮次，带 `GoalMessageSource` 标注 | `packages/goal/goal/src/domain.ts:47` |
| pre-step | 每步请求前的水瀑布钩子（`agent/pre-step`），编排点 | `packages/plan/plan-mode/src/index.ts:205` |

### 1.3 三个"活体"系统的关系

- **subagent 委托**是原子委托原语（一个孩子一个任务或一个持久对话）；
- **workflow** 是"脚本化批量委托"（一个脚本扇出 N 个子代理，有并发/总量上限）；
- **jobs** 是"子代理/命令的后台化"（把 one-shot 委托包成可 `job_output`/`job_kill` 的后台任务）；
- **goal** 是"自动驾驶循环"（同会话内反复自主续跑，直到 blocked/complete）；
- **schedule** 是"定时器"（到期把提醒当普通用户消息推回原会话）；
- **todo/plan** 是"跨轮次协作状态"（整表/开关，事件溯源进日志）。

---

## 2. 模块与文件地图

### 2.1 subagent 包族（`packages/subagent/`）

| 文件 | 职责 |
|---|---|
| `subagent/src/index.ts` | Service Definition：`SubagentRuntime`，命名 Provider 注册表 + one-shot start + continuable 操作 |
| `subagent/src/types.ts` | 消费者侧契约：请求/结果/能力/Provider 接口 |
| `subagent/src/continuation.ts` | 可继续子代理管理器：Activation 准入、冷恢复、所有权图、子优先释放、结算通知 |
| `subagent/src/descriptor.ts` | 持久描述符（版本化 `subagent/descriptor` 事件）的 snapshot/fold |
| `subagent/src/descriptor-seed.ts` | 把描述符拼进子代理创建 seed |
| `subagent/src/child-agent.ts` | 进程内子代理公共组合：深度、会话 meta、persona/toolFilter、委托策略 |
| `subagent/src/depth.ts` | 委派深度记账（header `delegationDepth` + `AgentOptions.subagentDepth`） |
| `subagent/src/list-children.ts` | `listChildren`/`listDescendants`：live-preferred 枚举 + 三级身份阶梯 |
| `subagent/src/lifecycle.ts` | `subagent/start`/`subagent/end` 生命周期事件发射 |
| `subagent/src/run-settlement.ts` | `settleRun`：run 结果→JobOutcome 的映射 |
| `subagent-spawn-in-process/src/index.ts` | Provider `spawn`：全新子代理（无父上下文） |
| `subagent-fork-in-process/src/index.ts` | Provider `fork`：以父会话已完成轮次为 seed 的子代理 |
| `subagent-in-process-driver/src/index.ts` | spawn/fork 共享的 one-shot 驱动（建孩子、跑一轮、读结果） |
| `subagent-acp` / `subagent-codex` / `subagent-claude-code` / `subagent-dsh-sdk` | 进程外 Provider（ACP/Codex/Claude Code/SDK 传输） |
| `tool-subagent/src/index.ts` | Consumer：`subagent` 工具（前台/后台/continuable 三种模式） |
| `tool-subagent-control/src/index.ts` | Consumer：全局 `send_message`、`interrupt_agent` |
| `tool-subagent-control/src/list-agents.ts` | 可选插件：`list_agents`（children/descendants 作用域） |
| `tool-subagent-report/src/index.ts` | 可继续子代理 child 作用域内安装的 `report` 工具 |

### 2.2 workflow 包族（`packages/workflow/`）

| 文件 | 职责 |
|---|---|
| `workflow/src/index.ts` | Service Definition：抽象 `WorkflowEngine` + `WorkflowError`（fatal 纪律） |
| `workflow/src/types.ts` | 浏览器安全词汇：`WorkflowMeta`/`WorkflowResult`/事件 payload |
| `workflow/src/runtime-types.ts` | Host 侧请求与活跃 run 句柄（含 Agent/AbortSignal） |
| `workflow-worker-thread/src/index.ts` | Provider：`WorkerThreadWorkflowEngine`（每 run 一个 worker 线程） |
| `workflow-worker-thread/src/host.ts` | 宿主侧 `WorkerRun`：worker 生命周期、子代理 RPC、取消/宽限期/终止 |
| `workflow-worker-thread/src/runtime.ts` | worker 内 `WorkflowExecution`：vm 上下文、`agent/parallel/pipeline/phase/log` 钩子、并发槽、caps |
| `workflow-worker-thread/src/session.ts` | worker 侧 MessagePort 会话与子代理 RPC 桥 |
| `workflow-worker-thread/src/protocol.ts` | host⇄worker 双向往返协议（闭枚举 + payload map） |
| `workflow-worker-thread/src/realm.ts` | vm realm 值 → 纯宿主 JSON 的物化（`materializeFromRealm`） |
| `workflow-worker-thread/src/meta.ts` | meta 数据块校验（绝不 eval 脚本取 meta） |
| `tool-workflow/src/index.ts` | Consumer：`workflow` 工具 + 持久 Chat 记录（`tool-workflow/run-*` 事件） |
| `tool-ralph/src/index.ts` | Ralph 循环工具：固定脚本逐轮 fresh 结构化子代理 |

### 2.3 jobs 包族（`packages/jobs/`）

| 文件 | 职责 |
|---|---|
| `jobs/src/index.ts` | Service Definition：抽象 `JobRegistry`（start/get/list/read/kill/wait/监听器/控制器） |
| `jobs/src/types.ts` | `JobStart`/`JobHooks`/`JobSnapshot`/`JobOutcome`/`JobKindMap` |
| `jobs-local/src/index.ts` | Provider：进程内 `LocalJobRegistry`（内存表、scope 分层、first-wins 结算） |
| `tool-jobs/src/index.ts` | Consumer：`job_output`/`job_list`/`job_kill` + 完成通知投递 |

### 2.4 goal 包族（`packages/goal/`）

| 文件 | 职责 |
|---|---|
| `goal/src/index.ts` | Service Definition：`GoalService`（CAS 变更、持久 `goal/change`、激活态） |
| `goal/src/types.ts` | 纯类型：`GoalRef`/`GoalSnapshot`/`GoalView`/`GoalPhase`/`GoalActivation` |
| `goal/src/domain.ts` | host 词汇：变更载荷、`GoalMessageSource`、`goal/changed` 事件 |
| `goal/src/fold.ts` | 严格回放折叠：解码 + 转换校验 + round 推进 |
| `goal/src/runtime.ts` | `GoalId` 品牌 + `GoalError` |
| `goal-round-driver/src/index.ts` | 续跑驱动：idle 时排队下一 round、pre-step 校验、blocked/checkpoint |
| `goal-round-driver/src/prompt.ts` | 目标轮提示词渲染 |
| `tool-goal/src/index.ts` | Consumer：`get_goal`/`create_goal`/`update_goal` |
| `tool-goal/src/authority.ts` | 执行期权威校验（direct-human vs goal-round） |
| `command-goal/src/index.ts` | `/goal` 命令（未细读） |

### 2.5 其余包

| 包 | 文件 | 职责 |
|---|---|---|
| todo | `packages/todo/tool-todo/src/index.ts` | `todo_write`：整表替换 + `todos` 投影 |
| plan | `packages/plan/plan-mode/src/index.ts` | `ctx.planMode`：`plan/mode` 日志状态、`exit_plan_mode`、`/plan` 命令 |
| interaction | `packages/interaction/user-questions/src/index.ts` + `./types.ts` | `ctx.userQuestions`：ask-user seam（单 Provider） |
| interaction | `packages/interaction/tool-ask-user/` | `ask_user_question` 工具（未细读，机制同上） |
| schedule | `packages/schedule/schedule/src/index.ts`、`runtime.ts`、`domain.ts`、`tools.ts`、`transaction.ts`、`persistence.ts` | 持久提醒 + 到期回推原会话 |
| workspace | `packages/workspace/workspace/src/types.ts`、`src/index.ts` | 工作区注册表（对模型不可见） |

---

## 3. 关键类型与接口（真实类型定义 + 文件:行号）

### 3.1 subagent 能力缝

**Provider 启动期能力旗标** —— 请求需要的能力提供方没有时，start 前显式拒绝（"fail loud，绝不接受后静默降级"）：

```ts
// packages/subagent/subagent/src/types.ts:86
export interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}
```

**单次启动请求**（`packages/subagent/subagent/src/types.ts:100`）：`label?`、`prompt`、`parent`（必填，派生 cwd/谱系/深度）、
`signal`（就绪前后唯一取消通道）、`outputSchema?`、`maxDepth?`、`toolFilter?`、`persona?`。

**Provider 约定**（`packages/subagent/subagent/src/types.ts:285`）：`name`（注册表名，如 `spawn`/`fork`/`acp`）、
`capabilities`、`inheritsParentContext`（描述性：fork=true、spawn/acp=false）、
`start(request): Promise<SubagentRun>`（一次性）、可选 `prepareContinuable?`（**方法存在即能力**，返回分离的创建 spec）。

**一次性 run 句柄**（`packages/subagent/subagent/src/types.ts:249`）：`id`（本地 run 必等于子会话 id）、
`localAgent?`（远程 Provider 为 undefined）、`result: Promise<SubagentResult>`（子代理失败 resolve 而非 reject）、
`dispose(): Promise<void>`（幂等）。

**结果与停止原因**（`packages/subagent/subagent/src/types.ts:219`、`200`）：`SubagentStopReasonMap` 是可合并扩展的 map
（`completed|aborted|error|max-tokens|refusal`），消费方对未知变体按失败处理。

**可继续子代理的激活**（`packages/subagent/subagent/src/continuation.ts:159`）：

```ts
type ActivationState = 'running' | 'waiting' | 'settled'
// running  —— Agent 有活跃准入/轮次/唤醒中的收件箱工作
// waiting  —— 已完全停稳但仍拥有未 dispose 的子 Activation
// settled  —— 停稳且所有子级已释放 → 管理器 dispose AgentHandle 并移除 Activation
```

Activation 结构（`packages/subagent/subagent/src/continuation.ts:191-240`）：
`childId`、`parentSession`（持久直接父，结算通知用）、`provider`、`handle: AgentHandle`、
`ancestry: WeakSet<Agent>`（物化时观察到的活体祖先）、`ownedChildren: Set<SessionId>`、
`observer`、`disposal?`（**存在即准入截止**）、`accepted: Set<MessageId>`（唤醒窗口记账）、`announced`、`poke`。

**中断权威**（`packages/subagent/subagent/src/continuation.ts:139`）：

```ts
type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }      // 人类客户端提供的持久直接父地址
  | { readonly kind: 'ancestor'; readonly agent: Agent }                 // 确切的在线祖先 Agent
```

**持久描述符**（`packages/subagent/subagent/src/descriptor.ts:47`）：`SUBAGENT_DESCRIPTOR_VERSION = 2`；
`SubagentDescriptorData = OneShotSubagentDescriptorData | ContinuableSubagentDescriptorData`（`descriptor.ts:86`）。
continuable 描述符额外快照 `agentProvider`/`agentModel`/`persona`/`toolFilter` 用于冷恢复；刻意**不**快照整个
`AgentOptions` 对象（无关扩展值不应破坏续跑），也不含 `outputSchema`（单次运行结果约定）与 `subagentDepth`
（冷恢复以持久 header 的 `delegationDepth` 为单调下界）。

### 3.2 workflow 能力缝

**启动请求**（`packages/workflow/workflow/src/runtime-types.ts:19`）：`script`（纯 JS 正文）、`meta`（数据身份块）、
`args?`、`subagentProvider?`（本次运行引擎级覆盖，脚本不可见）、`maxTotalAgents?`、`parent`（每个子代理归属于它）、`signal?`。

**meta 块**（`packages/workflow/workflow/src/types.ts:46`）：`name`/`description` 必填，`whenToUse?`/`phases?`；
词汇与 Claude Code dynamic-workflows 一致；`phases` 仅进度展示，无执行语义。

**run 句柄**（`packages/workflow/workflow/src/runtime-types.ts:40`）：`result: Promise<WorkflowResult>`（**永不 reject**）、
`cancel(reason?)`、`dispose(): Promise<void>`（幂等，等待有界结算 + 子代理静默）。

**结果**（`packages/workflow/workflow/src/types.ts:72`）：`value`（宿主域 JSON，`undefined`→`null`）、
`stopReason: 'completed' | 'cancelled' | 'error'`（**闭联合**，引擎所有）、`error?`、`agentsStarted`。

**fatal 错误纪律**（`packages/workflow/workflow/src/index.ts:130`）：`WorkflowError extends HarnessError` 带 `fatal: boolean`；
`isFatalWorkflowError`（`index.ts:146`）用宿主 realm `instanceof` 判定——脚本 realm 伪造不了。

### 3.3 jobs 能力缝

```ts
// packages/jobs/jobs/src/types.ts:46
export interface JobStart {
  kind: JobKind              // 也是 id 前缀（`<kind>-N`）
  label: string
  outputLimitBytes?: number
  owner?: Agent              // 缺省 = 无主任务，任何人可访问
  run(): JobHooks            // 预检后同步调用；throw 则什么都不注册
}
// packages/jobs/jobs/src/types.ts:72
export interface JobHooks {
  cancel(reason?: string): void
  done: Promise<JobOutcome>   // 生产方**释放资源后**才 resolve
  readOutput?(): string       // 有 = 流式任务（每次读增量）；无 = 仅终态输出
}
// packages/jobs/jobs/src/types.ts:17
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
```

`JobSnapshot`（`jobs/src/types.ts:97`）是**每次新建的只读投影**，含 `reported` 记账位：
当 kill/read/wait/teardown 已宣告终态时，完成通知监听器抑制重复通知。

### 3.4 goal 领域

```ts
// packages/goal/goal/src/types.ts:19
export interface GoalRef { readonly id: GoalId; readonly revision: number }  // CAS 身份
// packages/goal/goal/src/types.ts:44
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'          // 持久阶段
// packages/goal/goal/src/types.ts:71
export type GoalActivation = 'armed' | 'disarmed'                             // 进程本地激活，绝不持久化
// packages/goal/goal/src/types.ts:74
export interface GoalView extends GoalSnapshot { roundsStarted; createdAt; updatedAt; activation }
// packages/goal/goal/src/domain.ts:47
export interface GoalMessageSource { kind: 'goal'; goalId; revision; round }  // 轮次标注，round 从 1 起
```

**持久变更**是 `goal/change` 会话事件（`packages/goal/goal/src/domain.ts:24`）：要么是完整快照
（`operation + goal + roundsStarted + createdAt + updatedAt`），要么是 clear 墓碑（`domain.ts:35`）。

### 3.5 协作状态类型

- `todo/write` 事件：`{ todos: TodoItem[] }`，整表快照（`packages/todo/tool-todo/src/index.ts:213`）。
- `plan/mode` 事件：`{ active: boolean }`，整值替换、仅日志、绝不进模型 transcript（`packages/plan/plan-mode/src/index.ts:53`）。
- `AskUserQuestionRequest`（`packages/interaction/user-questions/src/index.ts:28`）：`questions[]` + `agent?` + `signal?`；
  `AskUserQuestionItem` 带稳定 `id`、`options?`、`multiSelect?`、`intent?`（`plan-review` 意图指名 approve 标签，不靠选项顺序）。
- Schedule 持久记录：`AfterScheduleRecord | AtScheduleRecord | EveryScheduleRecord`
  （`docs/subsystems/schedule.zh.md` 定义于 `packages/schedule/schedule/src/types.ts`），`every` 间隔 ≥300 秒。

---

## 4. 执行流程

### 4.1 子代理派生

#### 4.1.1 一次性 spawn（全新孩子）

1. 模型调用 `subagent` 工具（`packages/subagent/tool-subagent/src/index.ts:369` `execute`），
   工具组装 `SubagentStartRequest`（label=description、prompt、parent=exec.agent、agentOptions/persona/toolFilter/maxDepth 按配置）。
2. `ctx.subagents.start(name, request)`（`packages/subagent/subagent/src/index.ts:414`）：
   - `expectProvider`（找不到 → `NO_PROVIDER`）；
   - `assertCapabilities`（`index.ts:481`）——请求的 outputSchema/maxDepth/toolFilter/persona 逐项对照提供方旗标；
   - `assertObjectJsonSchema` 校验 outputSchema；
   - `snapshotSubagentDescriptor({ mode: 'one-shot', provider, label? })` 铸造持久描述符；
   - 交给 `provider.start(resolved)`。
3. spawn Provider（`packages/subagent/subagent-spawn-in-process/src/index.ts:48`）→ `startInProcessRun`
   （`packages/subagent/subagent-in-process-driver/src/index.ts:102`）：
   - `resolveChildDepth(parent, maxDepth)`（`child-agent.ts:48`）= `delegationDepthOf(parent)+1`，超上限抛 `SubagentDepthError`；
   - `randomUUID()` 铸造 childId；`captureDelegatedPolicyOverrides(parent)` 在首个 await 前捕获委托策略；
   - `parent.ctx.agents.create({ sessionId, meta: childSessionMeta(...), agentOptions, signal, setup })`（`in-process-driver:132`）：
     - `childSessionMeta`（`child-agent.ts:102`）把 `cwd`、`parentSession`、`origin: 'subagent'`、`delegationDepth`、`seedLength` 写进持久 header；
     - setup 钩子（`in-process-driver:120`）在**未发布窗口**内：追加委托策略事件（`sandbox/mode`、`approval/policy`，
       见 `child-agent.ts:215`）→ `applyChildComposition`（persona 遮蔽 `deployment:persona`、`tools.restrict` toolFilter、
       注册 `subagent:delegation` 运行时上下文）→ 需要时挂结构化输出运行时 → `attachDescriptorAppend`；
     - `attachDescriptorAppend`（`in-process-driver:79`）注册 `agent/pre-step` 监听器：孩子**初始轮次内、首次请求前**追加 `subagent/descriptor` 事件。
4. `drivePublishedRun`（`in-process-driver:154`）：signal abort → `child.cancel({kind:'parent'})`；
   `child.followup(用户消息)` → `whenIdle()` → `readResult`（`in-process-driver:208`）从 `boundary`（seed 长度）之后的事件里
   取最后一个 `turn/end` 的 reason 映射 stopReason（`toStopReason`，`in-process-driver:48`），
   `finalAssistantOutput` 选最后非空 assistant 消息。
5. run 的 `dispose()`（`in-process-driver:195`）等待 `handle.dispose()` 与 `result` 双静默，且只上报 handle 释放失败。

#### 4.1.2 一次性 fork（继承父上下文）

fork Provider（`packages/subagent/subagent-fork-in-process/src/index.ts:61`）：
- `completedTurnPrefix(parent)`（`fork:48`）：`parent.session.events` 里 `findLast(turn/end)`，取 `[0, lastEnd.seq+1]`——
  **平衡的已完成轮次前缀**（进行中的轮次不可回放为合法子会话）；
- `start()` 把该前缀作为 `CreateAgentOptions.seed` 传给同一个 `startInProcessRun`（`fork:68-75`）；
- seed 经 `AgentLoop.createAgent → ctx.sessions.prepare({ seed })` 进入子会话（`packages/core/agent-loop/src/index.ts:606-610`），
  与 `ctx.agents.resume()` 恢复使用同一原语（`agent-loop/src/index.ts:662` resumeWith → `persistence.prepare`）；
- `inheritsParentContext = true` 让工具文案如实告诉模型"子代理已看到本会话已完成轮次"（`tool-subagent/src/index.ts:211` `providerWording`）。

#### 4.1.3 可继续子代理（后台，`ctx.subagents.startContinuable`）

管理器 `SubagentContinuationManager`（`packages/subagent/subagent/src/continuation.ts:349`），`startContinuable`（`continuation.ts:403`）：

1. `assertAdmitting(parent)`（`continuation.ts:850`）——manager drain 或该父谱系 teardown 中则拒绝；
2. `requirePersistence()`（`continuation.ts:1470`）——**可继续子代理强制要求 session persistence**；
3. `SessionId(randomUUID())` 预留稳定子 id；`resolveChildDepth` 计算深度；
4. 铸造 continuable 描述符（快照 provider/label/agentProvider/agentModel/persona/toolFilter，`continuation.ts:415-423`）；
5. `host.prepareContinuable(provider, ...)`（`continuation.ts:428` → `SubagentRuntime.prepareContinuable` `index.ts:433`）：
   提供方只贡献**分离的创建 spec**（fork 传父历史 seed，spawn 传 `{}`）；
6. `seedDescriptorTurn`（`descriptor-seed.ts:23`）把「父历史前缀 + 一条 descriptor 事件」拼成 seed；
7. 在私有 activation-owner scope 上 `materialize`（`continuation.ts:966`）→ `materializeTracked`（`continuation.ts:986`）：
   - fresh：`ownerCtx.agents.create({ sessionId, meta, seed, agentOptions, setup })`（`continuation.ts:1016`）；
   - 恢复：`ownerCtx.agents.resume({ resumeSessionId, agentOptions, setup })`（`continuation.ts:1009`）；
   - setup 中：fresh 才追加委托策略事件（恢复回放持久事件），`applyChildComposition`，`setupRegistry.apply`（部署可注入的 child-scope 能力）；
   - 发布 start 生命周期边 `observer.start(handle.agent)`（`continuation.ts:1065`）；
   - `acquireOwnership(parent, childId)`（`continuation.ts:1100`）把子 id 记入父 Activation 的 `ownedChildren` —— **父代理因此无法 settle**；
8. `submitMaterialized`（`continuation.ts:943`）→ `submitAdmitted`（`continuation.ts:1181`）→ `submit`（`continuation.ts:1130`）：
   `agent.followup(message)` 入 inbox，返回 `{ childId, messageId }`（**不等轮次开始，不等消息落日志**）。
   此前任何失败以两个 id 都不返回 reject，并 rollback 掉已创建 handle、Activation 与所有权。

#### 4.1.4 冷恢复（cold resume）与 send_message

`followup(parent, childId, content, options)`（`continuation.ts:476`）按 Activation 驻留状态路由：

| 状态 | 行为 |
|---|---|
| `running` | 同一 Activation 内入队（`submitAdmitted`） |
| `waiting` | 唤醒同一 Agent |
| 无 Activation | `coldResume`（`continuation.ts:883`）：`persistence.inspect(childId)` → `authorizeLineage`（持久 header 的 `parentSession` 必须等于调用方，`continuation.ts:1211`）→ 只折叠 child 自身后缀（`seedLength` 之后）取 descriptor（`continuation.ts:905`）→ `agents.resume` 重建 Activation → 提交消息 |

**绝不**经由 Provider 分发冷恢复——管理器折叠通用描述符自己恢复。`send_message` 工具（`packages/subagent/tool-subagent-control/src/index.ts:26`）
是 `followup` 的薄适配器，source 用 `CoordinatorMessageSource`（`continuation.ts:58`，`{kind:'coordinator', form:'relay'}`）。

#### 4.1.5 interrupt 与 report

- `interrupt(targetSessionId, authority)`（`continuation.ts:528`）：同步鉴权（祖先必须是 registry 当前确切实例、不能自中断；
  `user` 权威核对持久 parentSession，`ancestor` 权威查 Activation 物化时记录的 `ancestry` WeakSet）→
  `activation.handle.agent.cancel(cause, { keepInbox: true })` → 不等待停稳即返回。
  `keepInbox: true` 保留未领取的待处理 inbox 工作；不存在的目标是**接受的 no-op**。
- `reportFrom(child, content, options)`（`continuation.ts:583`）：child 自己是权威凭证（不能指定接收方），
  从持久 `parentSession` 解析唯一接收方（`continuation.ts:616`），要求父必须在线；
  `delivery: 'wakeup'` 用 `parent.followup`，`'quiet'` 用 `parent.inject`（`continuation.ts:678-693`）；
  封装为 `subagent-report` 源（`continuation.ts:67`）。report 工具由 `tool-subagent-report` 的 `installReportTool`
  （`packages/subagent/tool-subagent-report/src/index.ts:49`）装进每个可继续子代理的未发布 scope。

#### 4.1.6 结算与父通知

`watchSettlement`（`continuation.ts:1233`）：`whenIdle()` 与 `poke` 竞速，静默后再进子锁复查 `stateOf() === 'settled'`，
同临界区内开启 disposal 事务。`finishDisposal`（`continuation.ts:1297`）：
自顶向下取消 → 子优先释放 → `flushFinalState`（best-effort `sessions.flush`，`continuation.ts:1457`）→
`notifySettlement`（`continuation.ts:1400`，**在释放所有权之前**投递，否则父 watcher 会以为自己已无子级而 dispose）→
`releaseOwnership` → `observer.settle`。

结算通知是运行时自己的记账（`subagent-settled` notice 源，`continuation.ts:82`），对每个拿到过 id 的孩子无条件投递；
父 idle 用 `followup` 开一轮，busy 用 `steer` 并入下一步（多个孩子同时结算只花一步）。

#### 4.1.7 枚举：listChildren / listDescendants

`listChildren(parentSessionId)`（`packages/subagent/subagent/src/index.ts:339` → `list-children.ts`）：
- 语料 = live session store 与可选 persistence 的 **live-preferred 合并**（`list-children.ts:119`）；
- 候选 = 持久 header 带 `origin: 'subagent'` 的直接 child；
- 身份 = 注册的 `subagent` projection unit 经**三级阶梯**：活体孩子用注册表水位快照（零日志读）；冷孩子先读可选的
  projection-cache（`cachedSnapshot`，带 own-suffix seq 门，`list-children.ts:360`）；否则一次
  `persistence.inspect()` 折叠（`list-children.ts:382`）；
- 折叠 last-wins，坏载荷 → `corrupt` diagnostic（`list-children.ts:268`），读失败 → `unavailable`（`list-children.ts:387`）；
- 绝不加载/恢复 Agent，不查 Activation map、Agent 注册表或 Provider 可用性。

`list_agents` 工具（`packages/subagent/tool-subagent-control/src/list-agents.ts:59`）把候选细化成
`running/idle/ready` 词汇（通过在线 Agent 注册表），**只保留 continuable 条目**（one-shot 不可 `send_message`），
`descendants` 作用域走 `listDescendants` 按稳定 pre-order 输出并附 `parentId`/`depth`。

### 4.2 workflow 脚本执行

#### 4.2.1 启动与预校验

`workflow` 工具（`packages/workflow/tool-workflow/src/index.ts:272`）→ `ctx.workflowEngine.start(request)`：
- `validateMeta`（`workflow-worker-thread/src/meta.ts:76`）——按字段名校验数据（**绝不 eval 脚本取 meta**）；
- `assertBodyParses`（`workflow-worker-thread/src/index.ts:64`）——host 侧先解析一次同样的 wrapper 包装，
  保持 `SCRIPT_PARSE` 同步抛错；检测 `export const meta` 语句给出专门提示；
- `resolveSubagentProvider`（`index.ts:77`）与 `resolveMaxTotalAgents`（`index.ts:92`，不能超过引擎天花板）；
- 并发上限默认 0 = 自动解析为 `min(16, max(1, cores-2))`（`index.ts:150-157`）。

#### 4.2.2 worker 线程执行

- 每 run 一个 `Worker`（`host.ts:149`），workerData 结构化克隆 `{ meta, body, args, limits }`；
- worker 内 `runWorkerSession`（`session.ts:143`）：先 `Ready`，等 host `Go` 才执行正文（取消可与启动竞速，
  取消可顶替 Go 直接进 cancelled drive）；`WorkflowExecution`（`runtime.ts:64`）编译 `(async () => { body })()`（`runtime.ts:90`）；
- vm 上下文只注入 6 个全局（`runtime.ts:100-113`）：`agent`、`parallel`、`pipeline`、`phase`、`log`、`args`；
  **没有 fs/网络/timer/Node API**——"代理干活，脚本只编排"；
- host⇄worker 双向往返协议（`protocol.ts:14-101`）：
  - worker→host：`ready/phase/log/agent-start/agent-end/child-start/child-dispose/result`；
  - host→worker：`go/cancel/child-started/child-start-error/child-settled/child-failed/child-disposed`；
- `agent()` 钩子（`runtime.ts:250`）：校验 prompt 非空 → 校验 options（只认 `label/phase/schema/provider/model`，
  明列拒绝 `effort/isolation/agentType`，`runtime.ts:39-41`）→ 总量 cap → 并发槽（FIFO，`acquireSlot` `runtime.ts:227`）→
  经 `ChildRpcBridge`（`session.ts:68`）发 child-start RPC；host 侧 `startChild`（`host.ts:349`）
  用 run 级共享 AbortController 调 `ctx.subagents.start(provider, ...)`；
  - 有 `schema` 且 completed 且 `structured` 缺失 → 该 child 记为 failed（返回 null）；completed 无 schema → 返回文本；
    子代理失败 → **resolve `null`**；子代理 result **reject**（基础设施故障）→ 抛 fatal `AGENT_RESULT`；
- `parallel(thunks)`（`runtime.ts:401`）：`Promise.all`，普通 throw 项 → `null`，**fatal 错误 rethrow**；
- `pipeline(items, ...stages)`（`runtime.ts:428`）：每项独立走完所有 stage（**无跨 stage barrier**），
  普通 stage throw 只丢该项（`null`），fatal 杀全脚本；
- `drive()`（`runtime.ts:162`）**永不 reject**：完成 → `materializeResult`（`runtime.ts:208`，违反纯 JSON → `RESULT_UNSERIALIZABLE`）；
  取消 → `cancelled`；其他 → `error`。
- 值离开 realm 前经 `materializeFromRealm`（`realm.ts:66`）物化为纯宿主 JSON（拒绝非有限数/bigint/函数/symbol/
  循环/稀疏数组/奇形原型/符号键，`realm.ts:78-151`）。

#### 4.2.3 取消、宽限期与终止

- `cancel(reason)`（`host.ts:180`）：post `Cancel`（worker 内所有钩子下一次调用即抛 `CANCELLED`，`runtime.ts:133`）→
  共享 controller abort 所有子代理 → 起 `disposeGraceMs`（默认 5000ms）定时器；宽限到期强制结算 `cancelled` 并
  `worker.terminate()`（`host.ts:191-201`），timer unref 不撑进程；
- `dispose()`（`host.ts:221`）：幂等事务，`Promise.race([result+childQuiescence, sleep(grace)])` 后无条件 terminate，
  再 reap 残余子代理；
- worker 死亡（`onWorkerDeath`，`host.ts:519`）：首信号关闭消息准入；`endStrandedAgents`（`host.ts:578`）为
  已启动未配对的 agent 合成 `cancelled` 的 `workflow/agent-end` —— 保证每个 `agent-start` 恰有一个 `agent-end`；
- 所有 `workflow/*` 事件（`workflow/start|phase|log|agent-start|agent-end|end`）都是**只读观察**，payload 是
  `WorkflowRunInfo`（id+meta）快照而非活 run，`workflow/end` 刻意不带 result value（`workflow/src/index.ts:175` 监听器隔离）。

### 4.3 goal 循环

#### 4.3.1 创建与 CAS 变更

- `create_goal` 工具（`packages/goal/tool-goal/src/index.ts:207`）要求 `requireDirectHuman`（`authority.ts:90`，
  本 turn 内必须有 `source.kind === 'user'` 的根代理输入）；`ctx.goals.create`（`goal/src/index.ts:251`）：
  解析默认 `maxGoalRounds`（配置默认 256，`index.ts:187`）→ 已存在非 complete 目标 → `GOAL_ALREADY_EXISTS` →
  铸造 `GoalId('goal-<uuid>')` revision 1 phase `active` → `commitSnapshot(..., 'armed')`。
- `commit`（`index.ts:542`）：先设 `pendingActivation`（目标 seq 上的激活意图）→ `session.append('goal/change', change)` →
  `sync`（`index.ts:437` 增量折叠新事件，且只有 pendingActivation 命中该 seq 才保留激活态，否则复位 disarmed）→
  发 `goal/changed`（scope-filtered，按 agent）。
- 所有变更带 `GoalRef` CAS：`expectCurrent`（`index.ts:401`）id+revision 不符 → `GOAL_STALE_REVISION`。
- 转换约束：`pause` 仅 `active→paused`；`resume` 允许 `active/paused/blocked→active` 且预算未耗尽（`index.ts:311-328`）；
  `complete` 允许 `active/paused/blocked`；`block` 仅 `active`（`index.ts:355`）；`clear` 留墓碑（`index.ts:377`）。

#### 4.3.2 round 循环（goal-round-driver）

`goal-round-driver`（`packages/goal/goal-round-driver/src/index.ts:76`）是**消费方**，监听：
- `agent/status` → `idle`（`index.ts:259`）：清 competingQueued；若 attempt 处于 queued/claimed/cancelled 且目标仍
  active+armed → 先 `pause`（放弃的轮次不白跑）；再 `requestDrive`；
- `goal/changed`（`index.ts:278`）：置 `needsCheckpoint=true` 并 requestDrive；
- `agent/inbox/inserted`（`index.ts:284`）：不是自己的轮次消息 → `competingQueued=true`（**竞态护栏**：人类消息抢跑时
  自动续跑必须让路，且自己的 queued attempt 标 stale）；
- `agent/pre-step`（`index.ts:349`）：对带 goal 源的消息做 `validReservation`（`index.ts:334`）——
  fiber ACTIVE、attempt 处于 claimed、未 stale、内容一致、目标仍 active+armed、`round === roundsStarted+1`；
  无效 → reject 该步并把其他已 claim 消息放回 inbox（`restoreOtherClaimed`，`index.ts:127`）；
  下游 reject → 把目标 block（`code: 'prompt-rejected'`，`index.ts:393`）。

`drive`（`index.ts:138`）每个驱动回合：
1. `needsCheckpoint` → `ctx.sessions.flush(agent.session)`（持久化 barrier）；
2. 目标须 `active && armed`；`roundsStarted >= maxGoalRounds` → `block(code:'round-limit')`（`index.ts:166`）；
3. `round = roundsStarted+1`，`renderGoalRoundPrompt` 渲染提示，`createUserMessage` 带
   `{kind:'goal', goalId, revision, round}` 源（`index.ts:174-179`）；
4. `agent.followup(message)` 入队；失败且目标未变 → `block(code:'queue-failed')`。

`session/event` 监听（`index.ts:307`）：`user/message` 命中自己 attempt 的 messageId → `admitted`；
`turn/end` max-tokens → disarm；aborted 且 attempt 已 claimed/admitted → 标记 cancelled 下次 idle 时 pause。
`roundsStarted` 的推进**只在严格回放折叠里发生**：`applyGoalEvent`（`goal/src/fold.ts:313`）遇到 goal 源 `user/message`
校验其是"当前活动目标的下一个轮次"（`fold.ts:321-331`），然后 `state.roundsStarted = source.round`。

#### 4.3.3 工具侧权威与 blocked 门槛

`update_goal`（`tool-goal/src/index.ts:234`）：`edit/pause/resume` 必须 `requireDirectHuman`；
`complete/blocked` 用 `completionAuthority`（`authority.ts:101`）——direct-human 或**当前目标本轮**皆可；
`blocked` 在 goal-round 权威下要求 `roundsStarted >= blockedAfterConsecutiveRounds`（默认 3，`tool-goal/src/index.ts:33`），
否则抛 `GOAL_TOOL_BLOCK_THRESHOLD`（`index.ts:299-306`）。

### 4.4 jobs 生命周期

1. 生产方（如 tool-subagent 的后台分支，`tool-subagent/src/index.ts:406-422`）`jobs.start(spec)`：
   `servesOwner`（`jobs-local/src/index.ts:132`，必须有 attached controller 服务该 owner，否则拒绝）→
   校验 kind/label/outputLimitBytes → 每 owner 活跃数上限（默认 10，`jobs-local/src/index.ts:28`）→
   `spec.run()` 同步返回 hooks → 铸 `JobId('<kind>-N')` → 注册表记录 `running` → `hooks.done.then(settle)`（`jobs-local:178`）。
2. `read`（`jobs-local/src/index.ts:205`）：流式任务调 `readOutput()` 拿**自上次读以来的增量**；非流式任务
   running 时返回空、settled 后返回幂等的终态 output；终态读置 `reported=true`。
3. `kill`（`jobs-local:215`）：先 `job.cancel(reason)`（throw 则状态不动）→ `stopping` + `reported=true`。
4. `wait`（`jobs-local:230`）：deadline 区分超时与取消（`TASK_WAIT_TIMEOUT`）；settlement 释放全部 waiter。
5. `settle`（`jobs-local:416`）**first-wins**：只记录第一个终态 → 释放 waiter → `markSettled` →
   `notifyChanged` → **最后**通知 `onJobDone` 监听器（`jobs-local:429-439`，reporter 可能同步开模型轮次，
   所以必须等所有其他观察者先看到已提交记录）。
6. 完成通知（`tool-jobs/src/index.ts:279`）：owner idle + `wakeup` 投递 + 连续唤醒预算（默认 3，`tool-jobs:45`）
   内 → `owner.followup`；否则 `owner.inject`；`agent/inbox/claimed` 用户消息重置预算（`tool-jobs:225`）。
7. teardown：owner dispose → `disposeOwned`（`jobs-local:467`，取消→等 settled→删记录→通知）；服务 dispose →
   `disposeAll`（`jobs-local:481`，先关 listeners 防 teardown 层各花一次模型请求）。teardown 取消一律 `reported=true`。

### 4.5 todo / plan / ask-user 如何融入日志

- `todo_write`（`packages/todo/tool-todo/src/index.ts:149`）：整表替换；校验非空唯一 content、单活跃约束
  （除非 `allowParallelInProgress`）；`exec.agent.session.append('todo/write', { todos })`（`index.ts:213`）；
  可组合 `todos` 投影（`index.ts:135-148`）：last-wins 整表，`turn/start` 清空。
- plan mode（`packages/plan/plan-mode/src/index.ts`）：`set(agent, active)`（`index.ts:425`）——
  无 open turn 直接 `session.append('plan/mode', {active})`（committed）；open turn 内进 `pendingIntents`（queued），
  由 `agent/pre-step`（`index.ts:205`）在**下一个被接受的轮内 pre-step** 追加；`plan:policy` 段落
  （order 50，`index.ts:225`）只在激活时渲染部署指引；`exit_plan_mode`（`index.ts:305`）经
  `ctx.userQuestions.ask` 走 `plan-review` 意图评审，批准后静默 queued 退出，**计划指引在 assistant 当前这批工具调用剩余部分继续生效**；
  `/plan [off|message]` 命令（`index.ts:269`）。
- ask-user（`packages/interaction/user-questions/src/index.ts:92`）：工具/权限插件要人回答时 `ctx.userQuestions.ask`；
  单 Provider 注册绑定 effect；agent 参数必须是 registry 确切实例且是运行时根（`DELEGATED_CALLER` 拒绝子代理提问）；
  错误带稳定 code（`EMPTY_QUESTIONS`/`NO_PROVIDER`/`ASK_ABORTED` 等）。

### 4.6 schedule 交付循环

- `apply`（`packages/schedule/schedule/src/index.ts:40`）只为**加载后创建的 root agent** 装 `ScheduleRuntime`
  （不扫持久会话、不收养已发布 root、不 wake cold session）。
- `driveOnce`（`packages/schedule/schedule/src/runtime.ts:231`）：先等共享持久化 barrier（`flushSchedulePersistence`）
  → 折叠 `schedule/change` 事件（带 `seedLength` 边界，fork 不继承父提醒）→ `dueDecision`（`runtime.ts:35`）：
  到期一次性提醒优先（每次一个），无一次性时所有 overdue 的 Every 记录组成一批 → 否则 arm 下一个 timer 段
  （`MAX_TIMER_DELAY_MS` 封顶，`runtime.ts:22`）。
- 到期时 `agent.runMaintenance`（`runtime.ts:256`，必须抢到 idle maintenance phase）→ 重新折叠、采样判断时刻 →
  `renderReminderFraming` 构造完整提示 → `agent.followup(message)`（**绝不 steer、绝不中断当前轮次**）→
  同步入队成功后才 `session.append('schedule/change', dispatch)`（`runtime.ts:284-298`）→ 再等一次 barrier。
- 语义：`session-local` 交付（无外部通知渠道）；best-effort 至少一次（入队后、dispatch 持久化前的崩溃窗口可能重复）。

---

## 5. 设计模式与权衡（最有教学价值的 5 个设计）

### 5.1 能力缝三角色（Service Definition / Provider / Consumer）与"多 Provider 共存"注册表

subagent 与 bash 的关键差异：**bash 每上下文一个执行器，第二个加载即抛错；subagent 是命名 Provider 注册表**
（`packages/subagent/subagent/src/index.ts:1-10`，shape 镜像 LLM adapter registry）。理由：
传输层（进程内 spawn/fork、ACP、Codex、Claude Code、SDK）彼此正交，一次部署可同时启用多个，
工具层按配置选名。权衡：能力差异必须显式化——`SubagentCapabilities` 旗标 + `prepareContinuable` 方法存在性，
请求越界能力在 start 前被 `UNSUPPORTED_CAPABILITY` 拒绝（`index.ts:481`），**绝不接受后静默忽略**。
Provider 生命周期事件（`subagent/provider-added|removed`，`index.ts:140-146`）让工具层"等 Provider 出现再挂载"，
HMR 安全（移除 Provider 只挡新 start，不撤销已接受的 run）。

### 5.2 事件溯源：会话日志是唯一真源，一切状态可折叠重建

贯穿全仓库的硬规则：**"Model-visible ⟺ logged"**（`packages/AGENTS.md`：任何进入模型请求的东西必须能从会话日志重建）。
编排层全部遵守：
- subagent 描述符是日志事件（`subagent/descriptor`），枚举身份靠投影折叠而非运行时缓存；
- goal 的 phase/revision/roundsStarted 全部由 `goal/change` + goal 源 `user/message` 事件重放得出
  （`goal/src/fold.ts:313`），激活态（armed/disarmed）是**唯一不持久化**的部分——因为它是"这个进程要不要自动续跑"
  的运行时事实，重启后由人/模型重新 resume 授予；
- plan 模式是 `plan/mode` 的纯折叠（`plan-mode/src/index.ts:129`），恢复/fork/压缩无需实时镜像；
- todo 是 `todo/write` last-wins 折叠。

权衡：折叠需要严格解码器（`decodeGoalChange`、`foldSubagentDescriptor`），**格式错误 = 损坏，fail loud**
（版本不认识的载荷折叠为 null 哨兵视同无值——描述符枚举侧，见 `list-children.ts` 文档注释）。
换来的是：没有旁路数据库、没有镜像一致性难题、任何时刻可从日志重建、fork/压缩天然正确。

### 5.3 一次性 run 与可继续对话的二分：Activation 作为"驻留纪元"

DSH 刻意把委托分成两种形态（`packages/subagent/subagent/src/continuation.ts:1-20`）：
- one-shot run：可 dispose 的前台委托，一个结果，无 steering 无恢复；
- continuable child：持久 Session + **至多一个**进程内 Activation；Activation 不是请求/结果/取消/Task 边界，
  可执行多个 FIFO 轮次，只要它创建的后代还在跑就一直驻留。

权衡与收益：
- **Agent inbox 是唯一队列**（`agent-loop/src/agent.ts:122` `followup` → `send('next-turn')`），
  续跑管理器不维护第二套执行状态机（`stateOf` 从 `Agent.status` + `ownedChildren` 推导，`continuation.ts:870`）；
- 冷恢复 = 折叠描述符 + `agents.resume()`，**不经 Provider**——Provider 只在首次创建时贡献分离 spec（数据而非能力）；
- 所有权图：子 id 记入父 Activation 的 `ownedChildren`，父无法 settle；释放严格 child-first，取消自顶向下
  （`finishDisposal`，`continuation.ts:1297`）；
- 代价是并发控制的精细度：`ChildLock`（`continuation.ts:320`）按 child 串行化"投递 vs 结算"，`accepted` 集合
  覆盖 followup 到 microtask 准入之间的窗口，`disposal` 事务"存在即截止"。

### 5.4 workflow 的受限 JS 沙箱：containment 而非 security

worker 线程 + vm 上下文（`packages/workflow/workflow-worker-thread/src/realm.ts:1-9` 明说
"the vm is not a security boundary. The worker provides host-loop isolation and forced termination"）：
- **线程隔离**防同步脚本阻塞 host（sync timeout 5000ms，`index.ts:42`）；
- **强制终止**能力兜底"永不结算的脚本"（cancel → grace 5000ms → `worker.terminate()`）；
- 脚本 realm 只有 6 个钩子，无 fs/网络/timer——**代理干活，脚本只编排**；
- 值离开 realm 一律物化为纯 JSON（`materializeFromRealm`），协议双向往返全 JSON（structured clone）；
- `isFatalWorkflowError` 用宿主 realm `instanceof`（`workflow/src/index.ts:146`）——脚本伪造不了 fatal，
  也不能把致命错误消融成 null。

权衡：放弃了脚本的通用能力（不能直接读写文件/发请求），换取"模型写出来的编排代码崩溃也崩不坏宿主进程"
和可审计性。这是教学上极好的案例：**信任边界放在进程/线程边界，而不是依赖模型代码的善意**。

### 5.5 错误语义的分层纪律：null vs fatal vs stopReason

- subagent：`SubagentResult.stopReason` 枚举化终态，工具层把非 `completed` 映射为 `isError` 结果并附部分输出
  （`tool-subagent/src/index.ts:123-155`），**部分输出绝不冒充成功**；
- workflow：`WorkflowError.fatal` 决定组合器行为——fatal（拼错选项/触上限/基础设施故障）**杀脚本**；
  子代理失败/普通 stage 错误 → 逐项 `null`（`.filter(Boolean)` 约定）（`workflow-worker-thread/src/runtime.ts:401-458`）；
- jobs：`JobOutcome.status` 三态 + `reported` 记账，settlement first-wins；
- goal：错误码全 kebab-case 机器可路由（`GOAL_STALE_REVISION` 等），blocked 带 `{code, message}`。

共同哲学：**把"失败"做成类型系统可表达的判别联合，而不是裸异常**；消费方 switch 已知分支、default 当失败。
这是"AI 系统的错误处理"教学中反复出现的主线。

### 5.6 其他值得讲的权衡（简列）

- **toolFilter 是"可见性"而非"权限"**：命名工具从孩子的 prompt 消失且拒绝执行，二者一体（`subagent.zh.md:82-86`）；
- **fork 继承的是"对话"，不是"能力"**：`inheritsParentContext` 只描述对话种子注入，不暗示工具/服务/权限继承
  （`types.ts:291-295`），工具文案因此诚实；
- **描述符显式字段快照而非整个 AgentOptions**（`descriptor.ts:8-19`）：无关扩展值不会让续跑失败，
  新增组合输入是一次有意的版本变更（`SUBAGENT_DESCRIPTOR_VERSION = 2`）；
- **goal 的持久 phase 与进程内 activation 分离**：blocked/complete 是持久事实，armed/disarmed 是本地意愿；
  session-start 自动 disarm（`goal/src/index.ts:198`），恢复后须人/模型显式 resume——防止"旧目标在新会话里偷偷续跑"；
- **jobs 的 controller 门禁**：`start` 拒绝"没有 controller 服务该 owner"的请求（`jobs-local/src/index.ts:132`），
  生产方不能启动 owner 收集不了/停不掉的工作；
- **完成通知最后投递**（jobs）与**结算通知先于所有权释放**（subagent）——两处都体现了
  "reporter 可能同步开模型轮次"这一观察对时序的苛刻要求。

---

## 6. 面试要点

1. **capability seam 是什么？为什么 subagent 允许多 Provider 而 bash/workflow/jobs 只允许单实现？**
   → 三角色定义（SD/Provider/Consumer）；传输层多样性与执行层单例性的差异（`subagent/src/index.ts:1-10`）。

2. **subagent 与 subagent_fork 的区别？**
   → spawn 全新孩子（无父上下文）；fork 以父会话"平衡的已完成轮次前缀"为 seed（`subagent-fork-in-process/src/index.ts:48`），
   seed 经 `CreateAgentOptions.seed → sessions.prepare`（`agent-loop/src/index.ts:606-610`）；`inheritsParentContext`
   驱动工具文案（`tool-subagent/src/index.ts:211`）。

3. **可继续子代理如何冷恢复？**
   → `persistence.inspect` → 鉴权（持久 parentSession 必须匹配）→ 折叠 child 自身后缀的 descriptor →
   `ctx.agents.resume`（`continuation.ts:883-932`）；不经 Provider。

4. **send_message 的 FIFO 语义如何保证？**
   → Agent inbox 是唯一队列（`agent-loop/src/agent.ts:122`）；`followup` 按 Activation 驻留状态路由
   （running 入队 / waiting 唤醒 / 无 Activation 冷恢复），已接受的轮次不可被后续消息改写（`continuation.ts:476-505`）。

5. **interrupt_agent 为什么是"fire-and-return"？**
   → 同步鉴权 + `cancel(cause, { keepInbox: true })`，不等待停稳（`continuation.ts:528`）；保留未领取 inbox 工作、
   不重新入队已 claim 的工作、不存在的目标为 no-op。

6. **list_agents 的 running/idle/ready 词汇与 running/inactive 有何区别？**
   → 服务层只给逻辑存活（`list-children.ts`）；工具层叠加在线 Agent 注册表细化
   （`tool-subagent-control/src/list-agents.ts:59-63`），ready = 仅存于存储、可恢复而非终态。

7. **workflow 脚本为什么跑在 worker 线程 + vm 里？为什么不直接 eval？**
   → 防同步阻塞、可强制终止、值边界物化、`args` 结构化克隆隔离、meta 走数据校验不 eval（`meta.ts:1-7`）；
   明确定位为 containment 而非 security 边界。

8. **workflow 的 fatal 错误纪律：什么错误杀脚本，什么错误变 null？**
   → 拼错选项/未知 schema/触 cap/取消/基础设施故障 = fatal（`WorkflowError.fatal`）；子代理失败与普通 stage
   错误 = 逐项 null（`runtime.ts:401-458`）。

9. **取消后脚本永不结算怎么办？**
   → cancel → 钩子开始抛 CANCELLED → grace 到期 force-settle `cancelled` → `worker.terminate()` →
   `endStrandedAgents` 补配 agent-end（`host.ts:180-204, 578-582`）。

10. **job 的 `reported` 位解决什么问题？**
    → 一次结算只通知一轮、避免重复完成通知；kill/read/wait/teardown 先行宣告后，完成监听器抑制冗余投递
    （`jobs/src/types.ts:130-138`；`jobs-local/src/index.ts:416-440`）。

11. **goal 为什么把 activation 与 phase 分开？**
    → phase 是持久事实（跨重启存在），activation 是"本进程要不要自动续跑"的本地意愿；session-start 自动 disarm，
    resume 必须由人/模型显式授予（`goal/src/index.ts:198-200, 311-328`）。

12. **goal round 如何被校验为"确切的下一轮"？**
    → 严格回放折叠只接受 `round === roundsStarted+1` 且 revision 匹配的 goal 源消息（`goal/src/fold.ts:321-331`）；
    driver 的 pre-step 还要求目标仍 active+armed 且不是 stale 的 reservation（`goal-round-driver/src/index.ts:334-347`）。

13. **todo_write 为什么是"整表替换"？**
    → 事件溯源下 last-write-wins 才无并发合并歧义；"模型每次发全量"使日志回放即最终列表（`tool-todo/src/index.ts:45-49`）。

14. **plan mode 为什么是"软指引"？**
    → 只改提示词段落（`plan:policy` order 50），不施加沙箱/审批强制；退出工具保持注册保证工具目录稳定
    （`plan-mode/src/index.ts:225-233, 305`）。

15. **子代理为何不能 ask 用户？**
    → `ctx.userQuestions.ask` 要求调用方是运行时根（`DELEGATED_CALLER`），owned child 无人可答会永久阻塞
    （`user-questions/src/index.ts:107-112`）。

---

## 7. 存疑/待确认

1. **fork 的可继续模式被刻意关闭**：`subagent-fork-in-process/src/index.ts:77-82` 有 `TODO(fork-continuable-prefix-reuse)`，
   说明目前 shipped 组合都把 fork 绑在 `backgroundMode: one-shot`——因为可继续子代理的 report 工具与提示段会
   插在继承历史之前，破坏 fork 前缀复用的收益（issue #2124；`fork-children-stay-one-shot` Agent Note）。
   本笔记对 fork 的 `prepareContinuable`（`fork:83-89`）只按代码现状描述，未验证该路径端到端行为。

2. **`packages/goal/goal-round-driver/src/prompt.ts`（`renderGoalRoundPrompt`）与 `tool-goal/src/wrapup.ts`
   （`renderWrapupContext`）未逐行精读**：只确认了它们被调用（`goal-round-driver/src/index.ts:175`、
   `tool-goal/src/index.ts:314-318`），提示词/上下文包装的具体措辞以 README 为准。

3. **ACP/Codex/Claude Code/SDK 四个进程外 Provider 只读了目录结构与入口**（`subagent-acp/src/index.ts` 等未逐行展开），
   笔记中 one-shot 细节均以进程内 spawn/fork + 共享 driver 为准；进程外传输的 run id 语义（`SubagentRun.id` 在
   parent 命名空间内唯一、`localAgent: undefined`）取自 `types.ts:249-275` 的类型注释，未经运行验证。

4. **`packages/schedule/schedule/src/domain.ts` 的严格解码细节**（`decodeScheduleChange`、`foldScheduleEvents`、
   `resolveEveryOccurrence`）只从文档（`docs/subsystems/schedule.zh.md`）与 `runtime.ts` 调用点推断，
   未逐行核对 domain.ts 内部实现。

5. **并发上限的自动解析**：`maxConcurrentAgents: 0 → min(16, max(1, cores-2))`（`workflow-worker-thread/src/index.ts:150-157`）
   是配置语义而非硬编码常量——但"0 即自动"这一层在文档里未显式声明，属代码行为推断。

6. **事件发射隔离的实现差异**：subagent 生命周期发射器（`lifecycle.ts`）与 workflow 的 `emitWorkflowEvent`
   （`workflow/src/index.ts:175`）都做 listener 隔离，但代码路径不同（前者含 scope-filtered carrier），
   本笔记未对比两者在异常传播上的全部细节。

7. **`command-goal`（`/goal` 命令）与 `tool-ask-user`、`commands` 包未细读**：仅确认存在与入口行号，
   教学博客如需展开需另行补充。

8. **core 的 `agent/inbox/spliced` 持久事件与 `Inbox` 回放**：`inbox.ts:32-39` 显示 inbox 从日志事件重放
   （fork 只回放 `seedLength` 之后的拼接），本笔记未验证跨压缩/跨持久化后的具体行为。

---

## 附：本文引用到的核心源码索引（速查）

- 子代理服务：`packages/subagent/subagent/src/index.ts`、`types.ts`、`continuation.ts`、`descriptor.ts`、`list-children.ts`
- 子代理 Provider：`packages/subagent/subagent-spawn-in-process/src/index.ts`、`subagent-fork-in-process/src/index.ts`、
  `subagent-in-process-driver/src/index.ts`
- 子代理工具：`packages/subagent/tool-subagent/src/index.ts`、`tool-subagent-control/src/{index,list-agents}.ts`、
  `tool-subagent-report/src/index.ts`
- 核心 Agent/Inbox：`packages/core/agent/src/index.ts`、`packages/core/agent/src/inbox.ts`、
  `packages/core/agent-loop/src/agent.ts`、`packages/core/agent-loop/src/index.ts`
- 工作流：`packages/workflow/workflow/src/{index,types,runtime-types}.ts`、
  `packages/workflow/workflow-worker-thread/src/{index,host,runtime,session,protocol,realm,meta}.ts`、
  `packages/workflow/tool-workflow/src/index.ts`
- 作业：`packages/jobs/jobs/src/{index,types}.ts`、`packages/jobs/jobs-local/src/index.ts`、`packages/jobs/tool-jobs/src/index.ts`
- 目标：`packages/goal/goal/src/{index,types,domain,fold,runtime}.ts`、`packages/goal/goal-round-driver/src/index.ts`、
  `packages/goal/tool-goal/src/{index,authority}.ts`
- 协作状态：`packages/todo/tool-todo/src/index.ts`、`packages/plan/plan-mode/src/index.ts`
- 交互：`packages/interaction/user-questions/src/index.ts`
- 定时：`packages/schedule/schedule/src/{index,runtime}.ts`
- 工作区：`packages/workspace/workspace/src/types.ts`
