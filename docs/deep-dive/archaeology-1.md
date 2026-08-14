# 源码考古：一条潜伏崩溃路径与两处文档滞后

> 第三季 · 第 1 期。这一期把三条第二轮存疑项从"推断"变成"实证"：A11-2 的 DisposableList 崩溃路径（已运行时复现）、A16-3 的 README 文档滞后（已对照测试断言）、A15-8 的 plan 状态张力（已读源码注释）。这也是"源码考古"系列的方法论示范：**存疑 → 读码 → 最小复现 → 证据归档**。

## 1. A11-2：一条潜伏的 TypeError（bug 实证）

### 1.1 存疑的来源

第一轮研究笔记（`research/09-scope-events.md` §7）注意到一个可疑组合：

> `DisposableList` 无 `unshift`——非 global 的 `ctx.on('internal/update', fn, {prepend:true})` 会崩溃（潜伏路径）

### 1.2 读码：两行代码的矛盾

`vendor/cordis/src/events.ts:141-145` 的 `internal/listener` 拦截器：

```ts
if (name === 'internal/update' && !options.global) {
  const hooks = this.fiber._hooks['internal/update'] ??= new DisposableList()
  const method = options.prepend ? 'unshift' : 'push'
  return hooks[method](listener)      // prepend → hooks.unshift
}
```

而 `utils.ts` 的 `DisposableList` 只有 `push / delete / clear / 迭代器`——**没有 `unshift`**。矛盾成立：`hooks.unshift` 是 `undefined`。

### 1.3 最小复现：运行时实锤

```js
import { Context } from '@deepseek-ai/cordis'
const root = new Context()
root.plugin({
  name: 'repro',
  apply(ctx) {
    ctx.on('internal/update', () => {}, { prepend: true })       // ← 崩溃点
    ctx.on('internal/update', () => {}, { global: true, prepend: true })  // 对照正常
  },
})
```

```text
RESULT: CRASH -> TypeError: this.fiber._hooks.internal/update[...] is not a function
RESULT: global internal/update prepend OK
```

### 1.4 影响面与诚实边界

- **vendored 4.0.0-rc.7 与发布版 `@deepseek-ai/cordis@4.0.1` 同源确认**（`lib/index.js:238` 同模式）——不是仓库本地修改引入的
- 当前仓库内所有 `internal/update` 注册者都带 `global: true`（loader 写回钩子/日志钩子、events.ts 编排者），**没有生产触发者**——这是"潜伏 bug"而非"现存事故"
- 任何未来插件想"抢在默认 restart 前拦截更新"（非 global prepend），会在插件加载期直接 TypeError，且错误信息不指向根因

完整 issue 素材（含三种修复建议）在 [research/issues/issue-cordis-disposablelist-unshift.md](https://github.com/Bin-hy/dsh/blob/main/research/issues/issue-cordis-disposablelist-unshift.md)。

::: tip 方法论：存疑如何变成实证
① 笔记记录"可疑组合"（读码阶段的诚实存疑）→ ② 定位两行矛盾代码 → ③ **最小复现**（不是"看代码推断会崩"，而是真的跑崩给你看）→ ④ 确认影响面（谁触发、谁不触发）→ ⑤ 归档为可提交的 issue 素材。五步里最容易被跳过的是 ③——但只有运行时崩溃才能区分"我以为会崩"和"它真的崩了"。
:::

## 2. A16-3：README 说"开新轮次"，实测是"同一步骤"

### 2.1 文档怎么说

`packages/llm/llm-retry/README.md:5`：

> every retry opens a fresh numbered turn

`:11` 更明确：

> The loop then closes the failed turn and opens a retry turn over the same durable history.

### 2.2 代码与测试怎么说

loop 的 `step()` 里是 `while (true) { ... continue }`（`agent.ts:339-371`）——重试**不离开当前 step 调用**。测试断言（`retry.spec.ts:795`）：

```ts
expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
```

**一次 step/start，零个新 turn/start**。重试是在同一 (turn, step) 内的新请求尝试。

### 2.3 结论

README 的"closes the failed turn and opens a retry turn"与实现/测试不符——**文档滞后**。正确表述（本系列第 16 篇已采用）："重试 = 同一 (turn, step) 内的新请求尝试，产生新的 `assistant/chunk` 事件（失败的尝试也留日志），不产生新的 `assistant/message`（除非成功）"。

这类"文档 vs 测试"的冲突，判定标准很简单：**测试是机器执行的当前事实，文档是人工维护的滞后描述**——以测试为准，并把文档修正作为 issue 素材归档。

## 3. A15-8：plan 的"进程内意图"与日志真相的张力

`plan-mode` 的 `set()`（`packages/plan/plan-mode/src/index.ts:425`）：

```ts
if (hasOpenTurn(session.events)) {
  this.pendingIntents.set(session, { active, narrate: true })
  return foldPlanMode(session.events) === active ? 'cancelled' : 'queued'
}
// No open turn: commit now.
```

开 turn 期间的用户选择**只进内存 Map**（pendingIntents），等下一个被接受的 pre-step 才追加 `plan/mode` 事件。张力在于：**进程在 pending 期间崩溃 → 选择丢失**——与"日志是唯一真相"的纪律冲突。源码注释（:431 附近）自己承认了这一点。

为什么还这样设计？合理推断（未在注释确认）：plan 模式切换必须落在**轮次边界**，而"记录用户选择"与"落日志"之间如果加一个立即 flush，会破坏"open turn 内不追加状态事件"的语义。这是一个**有意的取舍**：崩溃窗口内的选择丢失，换取轮次语义的干净。张力被承认、被局限在最小窗口，但没有在文档里把代价讲透——这正是第二轮存疑的价值：不是找 bug，而是把"文档没讲透的代价"挖出来。

## 4. 本篇消化的 backlog 项

- ✅ A11-2 DisposableList 无 unshift 崩溃路径（运行时复现 + 影响面确认 + issue 素材归档）
- ✅ A11-3 附带确认：`fiber._hooks` 在 `_unload` 从不清理（与 A11-2 同源，建议一并评估）
- ✅ A16-3 README "opens a retry turn" 文档滞后（对照 retry.spec.ts:795 断言确认）
- ✅ A15-8 plan pendingIntents 进程内状态与日志真相的张力（源码注释承认）

## 5. 下一期预告

源码考古第 2 期候选：A15-7（every 批量 faulted 严重性）、A16-9（STREAM_CLOSED 不可重试的未决语义）、A10-2（codex/ACP 停止原因映射的不对称是否有意）。
