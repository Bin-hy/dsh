# 编排补遗：四个被砍掉的细节与三份逐字提示词

> 这是[多代理编排](/deep-dive/orchestration)的补遗篇，消化 backlog A17 的五条存疑项：fork 可继续模式为何被刻意关闭、goal 轮次提示词的逐字文本、workflow 并发上限的自动解析、两套事件发射隔离的差异、inbox 回放跨压缩的行为。全部结论基于源码实证。

## 1. fork 的可继续模式：一个被刻意关闭的能力

`subagent-fork-in-process` 的 `prepareContinuable` 存在且实现完整，但源码里有这样一段 TODO（`packages/subagent/subagent-fork-in-process/src/index.ts:79`）：

```ts
// TODO(fork-continuable-prefix-reuse): no shipped composition calls this —
// they bind fork to `backgroundMode: one-shot` because a continuable child's
// `report` tool and prompt section precede the inherited history, defeating
// the prefix reuse a fork exists for. Reopening needs a byte-identical child
// system prompt and tool schemas; see issue #2124
```

**为什么关闭**：fork 的全部价值在"前缀复用"——子代理继承父会话的已完成轮次前缀，提供方 KV cache 不失效。但可继续子代理会在**继承历史之前**插入自己的 `report` 工具与提示词段落。前缀变了，KV cache 复用收益就没了。

**重启的条件**（issue #2124）：需要字节级一致的子代理 system prompt 与工具 schema——即"继承的历史"与"自己的指令"必须严格有序且稳定。

**另一个事实**：fork 前缀在**创建时捕获一次**，成为子代理自己持久转录的一部分。之后冷恢复回放的是子代理自己的转录，**不会重新 fork 父代理更新的历史**（`fork-in-process/src/index.ts:86-88` 注释）。

::: tip 面试要点
"有实现但刻意不启用"是比"没实现"更强的工程信号：它说明团队理解了能力的代价（KV cache 前缀必须字节一致），并选择等待正确的组合形态而不是硬上。issue #2124 是"设计决策记录在代码里"的典范。
:::

## 2. Goal 轮次提示词：逐字拆解

### 2.1 轮次提示（`renderGoalRoundPrompt`，`packages/goal/goal-round-driver/src/prompt.ts`）

```text
<goal_round>
Objective: "<目标 JSON 转义>"
Round: 3/10

Continue working toward the objective in this same session. Treat the current
workspace, tool results, and durable session state as authoritative; inspect
them instead of assuming earlier narration is still current. Make concrete
progress and verify the result. Before claiming completion, gather evidence
that the whole objective is achieved, read the current goal, and mark it
complete. If work remains, leave the goal active for the next round. Follow
the configured goal-tool policy before reporting a blocker.
</goal_round>
```

值得注意的措辞设计：

- `Objective` 用 `JSON.stringify`——目标文本带引号转义，防止模型被目标内容里的标记欺骗
- "**Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current**"——这是本会话开头那段系统提醒的同源指令：对抗"模型相信自己的旧叙述"的幻觉
- "gather evidence that the whole objective is achieved"——完成前必须有证据，不是自我宣告

### 2.2 收尾提示（`renderWrapupContext`，`packages/goal/tool-goal/src/wrapup.ts`）

当自主轮次报告 `complete` 或 `blocked` 时，注入 `<goal_complete>` 或 `<goal_blocked>` 块（经 `deferContext()`，**取代了原来的硬性 turn 停止**，让模型在轮次结束前还能向用户说一次话）：

```text
<goal_blocked>
Objective: "..."
Blocked: "<验证过的阻塞说明>"

The goal is marked blocked and this autonomous run is ending. Write the closing
message to the user now: state what has been completed so far, describe the
concrete blocking condition and what you tried, and say exactly what you need
from the user to continue.
</goal_blocked>
```

两条共享的 **GROUNDING 纪律**：

> Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it.

**为什么"取代硬停止"是个好设计**：原来的行为是目标终态后直接停 turn——用户看到的是戛然而止。现在模型用一次总结性发言收尾（"目标已完成/受阻，做了 X，验证方式是 Y，你需要 Z"），自主循环与人类体验无缝衔接。

## 3. Workflow 并发上限的"0 = 自动"

```ts
// packages/workflow/workflow-worker-thread/src/index.ts:150
maxConcurrentAgents: this.config.maxConcurrentAgents === 0
  ? Math.min(16, Math.max(1, availableParallelism() - 2))
  : this.config.maxConcurrentAgents,
```

- 配置为 0 = 自动解析为 `min(16, max(1, 逻辑核数 - 2))`——留两个核给宿主
- 上限 16 封顶；单核机器下限 1
- 这是配置语义而非硬编码：部署方可以显式覆盖

注意：研究笔记当时标注"文档未显式声明"——这提醒我们**默认值语义必须读代码**，文档不一定覆盖。

## 4. 两套事件发射隔离：同目标、两实现

`workflow/*` 与 `subagent/*` 生命周期事件都做监听器隔离（一个监听器抛错不能影响其他监听器），但实现是两套：

**workflow 版**（`packages/workflow/workflow/src/index.ts:171`）：一个 protected 辅助方法，手动 `dispatch('emit')` 循环 + try/catch + 异步 rejection catch + `renderListenerError` 兜底（连 String 强转都包一层）。

**subagent 版**（`packages/subagent/subagent/src/lifecycle.ts`，269 行）：一个完整模块 + 包私有的 `ActivationObserver`。`start/capture/settle` 三步顺序是**包内契约**：

```text
start(child)   —— 纪元驻留后发布 start 边
capture(child) —— 在 child 仍注册时快照终态事实（dispose 会注销它！）
settle()       —— 解析并发布终态边
```

`capture` 的存在理由值得背下来：**handle 释放会把 child 从注册表注销**，而消费方要读 child 自己的日志和 scope 来渲染终态——所以必须在释放前快照。内部控制接口刻意不发布给插件（只给同包调用方）。

::: tip 面试要点
"同目标、两实现"不是重复劳动：workflow 只有一次性 run，一个隔离循环就够；subagent 的 continuable 孩子需要跨越 activation 纪元的 start/end 配对 + 释放前快照，复杂度是问题本身带来的。**对称性的破例必须有解释**（DSH 仓库纪律原话）。
:::

## 5. Inbox 回放跨压缩/持久化的行为

研究笔记 04#8 的疑问：`agent/inbox/spliced` 跨压缩、跨持久化后行为如何？源码给出确定答案：

- `Inbox` 构造时从 `session.events.slice(session.header.seedLength ?? 0)` 重放全部 spliced 事件（`packages/core/agent/src/inbox.ts:32-39`）
- spliced 是**非 surface 日志事件**——compaction 只遮蔽三种 surface 事件（user/message、assistant/message、tool/result），**spliced 永远不会被压缩掉**
- 持久化后端无损保存全部事件（含 `assistant/chunk`），所以跨重启重放与内存重放等价
- fork 只回放 `seedLength` 之后的 splice——父代理的未决 inbox 工作**不会**遗传给 fork 孩子

结论：inbox 队列的持久化不依赖任何"队列快照"，它就是日志投影——**事件溯源连"待办队列"都不放过**。

## 6. 本篇消化的 backlog 项

- ✅ A17#1 fork 可继续模式被刻意关闭（TODO + issue #2124 + 前缀捕获一次语义）
- ✅ A17#2 goal-round-driver prompt.ts 与 tool-goal wrapup.ts 逐字渲染
- ✅ A17#5 workflow 并发上限 `0 = min(16, max(1, cores-2))` 自动解析
- ✅ A17#6 subagent lifecycle vs workflow emit 的监听器隔离差异
- ✅ A17#8 inbox spliced 跨压缩/持久化行为（非 surface 事件永不被遮蔽）

下一篇预告：会话持久化内核 / 进程外子代理与 ACP / 作用域与事件内核 / 终端与 PTY（研究中）。
