# Compaction 与计量补遗：重入、持久化失败与三个插值分支

> 消化 backlog A20 的全部五项存疑：摘要调用的重入语义、flush 失败的锁定状态、`/compact` 与 goal 轮次的交互、计量口径的不对称、双花括号插值的三个分支。全部基于源码逐行实证。

## 1. 摘要调用：瀑布内的"旁路请求"

压力压缩挂在 `agent/pre-step` waterfall 内、`next()` 之前。它发起模型调用（摘要）——这是否绕过"模型可见即已记录"的不变量？

源码答案（`packages/compaction/compaction-basic/src/index.ts:226-245`）：

```ts
/**
 * Summarize the replayed conversation region through a direct one-shot
 * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
 * prompt, tools, and messages so the provider's KV cache is not invalidated.
 */
protected async summarize(input, agent, signal): Promise<SummaryResult> {
  return summarizeWithLlm(this.ctx, config, input, agent, signal)
}
```

**摘要调用是直连 `ctx.llm.stream()` 的一次性调用，完全不经过 agent loop 的 `buildRequest`**：

- loop 的不变量（`markAgentLoopRequest` + `llm/stream` 上的运行时断言）只作用于 loop 构建的请求——摘要请求没有该标记，不参与"请求=日志纯函数"等式
- 摘要请求的完整信封（provider/model/usage/rawOutput）由 `compaction/summary` 会话事件单独记录——**它有自己的一条可重建路径**，不借用 deriveMessages
- 调用在瀑布内同步进行（阻塞当前 step），这就是"压缩失败只告警不阻断轮次"设计存在的原因之一：这个旁路请求是压缩策略自己的事，失败不能让主循环停摆

::: tip 面试要点
"旁路请求"与"主循环请求"分属两套可重建契约：主请求由 `request/header` + surface 重建；辅助请求（摘要、标题生成）由各自的事件（`compaction/summary`、`purpose: 'compaction'` 标记）重建。**审计覆盖度没有因为旁路而打折——只是换了条路**。
:::

## 2. Flush 失败：锁已正常关闭

手动 `/compact` 的 flush（持久化检查点）失败时，日志处于什么状态？

`packages/compaction/compaction-basic/src/region.ts:240-248`：

```ts
if (failure !== undefined) { ... }
if (flushFailure !== undefined) {
  throw new ManualCompactionError(
    'persistence',
    'manual compaction durability checkpoint failed',
    { cause: flushFailure },
  )
}
```

关键顺序：`compaction/start → summary → replace → compaction/end` 四连已经在 commit body 里追加完毕，flush 失败是**之后**单独抛出的。

所以：**锁已正常关闭**（start/end 配对完整），崩溃检测的"有 start 无 end"机制不会被持久化故障污染——失败是 durability 层面的（"写盘没成功"），不是协议层面的（"事务没结束"）。错误分类 `cancelled/changed/summary/commit/persistence` 里的 `persistence` 正是这个语义。

## 3. `/compact` 与 Goal 轮次：maintenance 闩锁的又一次登场

手动压缩走 `agent.runMaintenance()`（agent 必须空闲，否则同步抛 `busy`）。与 goal 轮次的交互：

- `runMaintenance` 进入 maintenance 相位；**`agent.status` 在 maintenance 期间对外仍报 `idle`**（`packages/core/agent-loop/src/agent.ts:99-101`）
- 若此时 goal-round-driver 排队了下一轮消息（`followup`），`wakeDriver` 检测到非 idle 相位 → **置 `maintenance.wakeRequested = true` 闩锁**（`agent.ts:172-181`）
- maintenance 结束后，`finally` 块检查闩锁：`if (wakeRequested && this.inbox.hasPending) this.wakeDriver()`（`agent.ts:156-159`）

结论：goal 轮次消息在 `/compact` 期间安静排队，压缩完成后自动接力——**排空语义完整，且"维护优先于轮次"的顺序是显式的**。

## 4. 计量口径：一个刻意的不对称

`packages/llm/token-meter/src/estimate.ts` 的计费表：

| 对象 | 公式 | 语义 |
|---|---|---|
| 消息 | `estimateContent(content) + ROLE_OVERHEAD(4)` | 每条消息加角色框架开销 |
| system | `len/4 + ROLE_OVERHEAD` | **按消息计**——system 在 wire 上就是一条消息 |
| tools | `JSON.stringify(tools).length/4 + BLOCK_OVERHEAD(4)` | **按块计**——tools 是 schema 块，不是消息 |

研究笔记当时的疑问（"system 计 ROLE、tools 计 BLOCK，口径是否一致"）答案：**一致**。system 与 tools 在 wire 协议里地位本就不同（一个是 message role，一个是 schema 字段），启发式如实反映了这个差异。

同一文件头部的注释点明了这条纪律的动机：

> Fixed-density heuristic token pricing shared by the meter service and the pure context-breakdown projection, **so both surfaces price identical content to identical numbers**.

计量服务与投影单元必须**同价**——否则 UI 显示的数字与压缩判断的数字对不上，debug 时就是灵异事件。

## 5. 双花括号插值的三个分支

`packages/core/system-prompt/src/index.ts:258-295` 的 `interpolate` 对双花括号开头的文本有三条路径：

```text
① {{name}} 完整组：
   - 名字不匹配 ^[a-z][a-z0-9_]*$ → malformed 抛错
   - 未注册名（Object.hasOwn 防原型链）→ unknown variable 抛错（附全部已注册名）
   - 已注册但值为 undefined → "has no value for this assembly" 抛错
② 孤立 {{ 后面还有 }}  → malformed 抛错
③ 孤立 {{ 后面没有 }}  → 字面散文，原样保留
```

设计逻辑：**只有"显然想引用变量但写错了"才抛错**；"显然就是字面量"（没有配对右括号）不打扰。配合"未知引用 fail loud"——提示词组装错误在启动/首次组装时就炸出来，而不是静默发一个残缺提示词给模型。

## 6. 本篇消化的 backlog 项

- ✅ A20#8 摘要调用重入语义（直连 stream、独立重建路径、不经过 loop 不变量）
- ✅ A20#6 flush 失败时锁已正常关闭（persistence 错误独立于协议锁）
- ✅ A20#9 /compact 与 goal 轮次（maintenance 闩锁 + 排空接力）
- ✅ A20#2 estimateHeader 口径（system=消息价、tools=块价，刻意不对称）
- ✅ A20#12 双花括号插值三分支（malformed / unknown / 字面散文）

A20 全部消化完毕。下一篇预告：会话持久化内核 / 进程外子代理与 ACP / 作用域与事件内核 / 终端与 PTY（子代理研究中）。
