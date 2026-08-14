# 05 · 多代理编排：Subagent、Workflow、Jobs、Goal

> DSH 的多代理编排不是单一系统，而是在 agent loop 之上叠的**七层可选能力**。每一层都是独立的 capability seam，各有 Service Definition / Provider / Consumer。本章拆解 subagent 委托、受限 JS workflow、后台 jobs、持久 goal 循环与协作状态（todo/plan）。

## 1. 七层编排栈

```text
第 0 层 core：agent loop 执行原语（必装）
第 1 层 subagent：委托 seam——one-shot 前台 + 可继续后台子代理
第 2 层 workflow：脚本编排 seam——模型写 JS 批量扇出子代理
第 3 层 jobs：后台作业 seam——长任务的后台生命周期
第 4 层 goal：持久目标 seam——同会话长目标 + 自动续跑循环
第 5 层 todo/plan：跨轮次协作状态
第 6 层 user-questions/schedule/workspace：人机交互与定时
```

关键判据：**不属于 agent loop 主干的可选能力，类型定义放在各自 seam 包里，不进 core**。

## 2. Subagent：命名 Provider 注册表

subagent 与 bash 的关键差异：bash 每上下文一个执行器，第二个加载即抛错；**subagent 是命名 Provider 注册表**（shape 镜像 LLM adapter registry）——传输层彼此正交：

| Provider | 传输 |
|---|---|
| `subagent-spawn-in-process` | 进程内全新子代理（**无父上下文**） |
| `subagent-fork-in-process` | 进程内 fork（**继承父会话已完成轮次**） |
| `subagent-acp` / `-codex` / `-claude-code` / `-dsh-sdk` | 进程外（把轮次委派给另一个产品） |

### 2.1 能力旗标：fail loud，绝不静默降级

```ts
// packages/subagent/subagent/src/types.ts:86
interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}
```

请求的 `outputSchema/maxDepth/toolFilter/persona` 逐项对照提供方旗标，越界在 start 前被 `UNSUPPORTED_CAPABILITY` 拒绝。

### 2.2 spawn vs fork：继承"对话"而非"能力"

- **spawn**：全新孩子。深度 = `delegationDepthOf(parent) + 1`（持久 header 记录），超上限抛 `SubagentDepthError`
- **fork**：`completedTurnPrefix(parent)` 取父会话 `[0, 最后一个 turn/end 的 seq+1]`——**平衡的已完成轮次前缀**，作为 `CreateAgentOptions.seed` 进入子会话。进行中的轮次不可回放为合法子会话

`inheritsParentContext`（fork=true）**只描述对话种子注入，不暗示工具/服务/权限继承**——工具文案据此诚实措辞（"子代理已看到本会话已完成轮次"）。

::: tip 面试要点：子代理的 toolFilter 是"可见性"还是"权限"？
是可见性：命名工具从孩子 prompt 消失**且拒绝执行**，二者一体，与不存在的工具无法区分。它不是权限系统（沙箱才是）。
:::

### 2.3 可继续子代理：Activation 作为"驻留纪元"

DSH 刻意把委托分成两种形态：

| | one-shot run | continuable child |
|---|---|---|
| 生命周期 | 可 dispose，一个结果 | 持久 Session + 至多一个进程内 Activation |
| 可否续聊 | 不可 | `send_message` 续聊 |
| 强制要求 | 无 | **session persistence**（冷恢复前提） |

核心设计（`packages/subagent/subagent/src/continuation.ts`）：

- **Agent inbox 是唯一队列**：续跑管理器不维护第二套执行状态机，`stateOf` 从 `Agent.status` + `ownedChildren` 推导
- **冷恢复不经 Provider**：`persistence.inspect → authorizeLineage（持久 parentSession 必须匹配）→ 折叠 descriptor → agents.resume`。Provider 只在首次创建时贡献分离的 spec（数据而非能力）
- **所有权图**：子 id 记入父 Activation 的 `ownedChildren`，父因此无法 settle；释放严格 child-first，取消自顶向下
- **描述符显式字段快照**而非整个 AgentOptions：无关扩展值不会让续跑失败，新增组合输入是一次有意的版本变更

### 2.4 interrupt 与 report

- `interrupt_agent`：同步鉴权（祖先必须是注册表当前确切实例）+ `cancel(cause, { keepInbox: true })`，**fire-and-return 不等待停稳**；不存在的目标是接受的 no-op
- `report` 工具装在可继续子代理的未发布 scope 里：child 自己是权威凭证，从持久 `parentSession` 解析唯一接收方；`wakeup` 用 `followup`、`quiet` 用 `inject`
- **子代理不能 ask 用户**：`ctx.userQuestions.ask` 要求调用方是运行时根（`DELEGATED_CALLER` 拒绝）——owned child 无人可答会永久阻塞

## 3. Workflow：受限 JS 编排沙箱

`workflow` 工具让模型写一个 JS 脚本，在 worker 线程的 vm 里运行，批量扇出子代理：

```js
// 脚本只有 6 个全局钩子：agent / pipeline / parallel / phase / log / args
return await pipeline(files, async (file) => {
  return agent(`审查 ${file}`, { label: 'review', schema: {...} })
})
```

### 3.1 为什么是 worker 线程 + vm，而不是直接 eval？

源码明说：**"the vm is not a security boundary. The worker provides host-loop isolation and forced termination"**——这是 containment，不是 security：

1. **线程隔离**防同步脚本阻塞 host（sync timeout 5000ms）
2. **强制终止**兜底"永不结算的脚本"：cancel → 钩子开始抛 CANCELLED → grace 5s → force-settle → `worker.terminate()`
3. **脚本 realm 只有 6 个钩子**，无 fs/网络/timer——"**代理干活，脚本只编排**"
4. 值离开 realm 一律物化为纯 JSON（拒绝非有限数/bigint/函数/symbol/循环引用）
5. `meta` 身份块走**数据校验，绝不 eval 脚本取 meta**

### 3.2 fatal 错误纪律：什么杀脚本，什么变 null

```text
fatal（杀整个脚本）：拼错选项（effort/isolation 被明列拒绝）、触总量上限、取消、基础设施故障
逐项 null：子代理失败、普通 stage 错误 → .filter(Boolean) 约定
```

`isFatalWorkflowError` 用**宿主 realm 的 instanceof** 判定——脚本 realm 伪造不了 fatal，也不能把致命错误消融成 null。

### 3.3 pipeline vs parallel

- `pipeline(items, ...stages)`：每项独立走完所有 stage，**无跨 stage barrier**（流水线优先吞吐）
- `parallel(thunks)`：`Promise.all` 并发等待全部（真正的屏障）

### 3.4 崩溃一致性

worker 死亡时 `endStrandedAgents` 为已启动未配对的 agent 合成 `cancelled` 的 `workflow/agent-end`——**保证每个 agent-start 恰有一个 agent-end**。所有 `workflow/*` 事件都是只读观察快照，`workflow/end` 刻意不带 result value（监听器隔离）。

## 4. Jobs：后台作业生命周期

```ts
// packages/jobs/jobs/src/types.ts:46
interface JobStart {
  kind: JobKind              // 也是 id 前缀（<kind>-N）
  label: string
  owner?: Agent              // 缺省 = 无主任务，任何人可访问
  run(): JobHooks            // 预检后同步调用；throw 则什么都不注册
}
interface JobHooks {
  cancel(reason?): void
  done: Promise<JobOutcome>   // 生产方释放资源后才 resolve
  readOutput?(): string       // 有 = 流式任务（每次读增量）
}
```

设计要点：

- **controller 门禁**：`start` 拒绝"没有 controller 服务该 owner"的请求——生产方不能启动 owner 收集不了的工作
- **first-wins 结算**：只记录第一个终态；`reported` 记账位抑制重复完成通知
- **完成通知最后投递**：settle 的顺序是"先提交记录 → 通知其他观察者 → 最后通知 onJobDone"——因为 reporter 可能同步开模型轮次
- `job_output` 的流式读 = "自上次读以来的增量"（这就是本次会话里你看到的 `[status: ...]` 语义）

## 5. Goal：持久目标与自动续跑

本会话正在运行的系统（我在第 10 轮 goal round 里）。核心设计：

### 5.1 持久 phase 与进程内 activation 分离

```ts
type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'   // 持久，进日志
type GoalActivation = 'armed' | 'disarmed'                        // 进程本地，绝不持久化
```

**phase 是持久事实，activation 是本地意愿**。session-start 自动 disarm——恢复/fork 后旧目标不会偷偷续跑，必须由人（`/goal`）或模型工具显式 resume。这就是你在会话恢复后看到 "activation: armed" 提示的原因。

### 5.2 事件溯源折叠

- goal 的 phase/revision/roundsStarted 全部由 `goal/change` + goal 源 `user/message` 事件**重放折叠**得出
- 所有变更带 CAS（`GoalRef {id, revision}`），id+revision 不符 → `GOAL_STALE_REVISION`
- **round 推进只在严格回放折叠里发生**：goal 源消息必须是"当前活动目标的下一个轮次"（`round === roundsStarted+1`）

### 5.3 round-driver：消费方模式

`goal-round-driver` 是 goal 服务的**消费方**（不拥有状态），监听四个事件：

```text
agent/status → idle     → requestDrive（排下一轮）
goal/changed            → needsCheckpoint + requestDrive
agent/inbox/inserted    → competingQueued = true（人类消息抢跑时让路）
agent/pre-step          → validReservation 校验（无效则 reject 并放回其他消息）
```

驱动回合：flush 持久化 → 检查 active+armed → round 上限 → 渲染 round prompt → `followup` 入队。

### 5.4 工具侧权威

- `edit/pause/resume` 要求 **direct-human**（本 turn 内必须有根代理的用户输入）
- `complete/blocked` 允许 direct-human **或当前目标本轮**
- `blocked` 在 goal-round 权威下要求连续 ≥3 轮同条件（`blockedAfterConsecutiveRounds` 默认 3）

::: tip 面试要点：goal 是状态还是调度器？
是**状态**。会话日志仍是真源；goal 的 armed/disarmed 是进程本地激活，round-driver 是把它转成轮次的消费方。Goal Round 是"一次为当前目标接纳的续行周期"，同一会话中无关的人类轮次不消耗上限。
:::

## 6. Todo 与 Plan：协作状态如何融入日志

- `todo_write`：**整表替换**（`todo/write` 事件 + `todos` 投影 last-wins）。事件溯源下 last-write-wins 才无并发合并歧义——模型每次发全量，日志回放即最终列表
- plan mode：`plan/mode` 事件（仅日志，绝不进 transcript）+ `plan:policy` 提示词段落（order 50）。**软指引**——只改提示词，不施加沙箱/审批强制。`exit_plan_mode` 走 `ctx.userQuestions.ask` 的 `plan-review` 意图评审

## 7. 面试要点汇总

::: tip 面试要点 1：为什么 subagent 允许多 Provider 而 bash/workflow/jobs 只允许单实现？
传输层多样（进程内/ACP/Codex/Claude Code 彼此正交）vs 执行层单例。能力差异用旗标显式化，越界在 start 前拒绝。
:::

::: tip 面试要点 2：fork 继承什么？
"平衡的已完成轮次前缀"作为 seed。继承的是**对话**，不是工具/权限/能力。`inheritsParentContext` 只驱动诚实措辞。
:::

::: tip 面试要点 3：可继续子代理冷恢复为什么不经 Provider？
Provider 只在首次创建时贡献分离 spec（数据而非能力）；恢复 = 折叠 descriptor + `agents.resume`。管理器折叠通用描述符自己恢复，Provider 不必在线。
:::

::: tip 面试要点 4：workflow 的信任边界在哪？
进程/线程边界：worker 隔离阻塞、force-terminate 兜底、realm 值物化、fatal instanceof 宿主导出。**不依赖模型代码的善意**。
:::

::: tip 面试要点 5：为什么完成通知要"最后投递"？
reporter（tool-jobs）可能同步开模型轮次。settle 必须先让所有其他观察者看到已提交记录，再通知 reporter——否则会出现"通知者看到旧状态开新轮次"的竞态。subagent 的结算通知同理：在释放所有权**之前**投递。
:::

下一篇：[06 · LLM 层与流式管道](/deep-dive/llm)——provider 适配器 seam、token 级流式记录、凭据只存引用。
