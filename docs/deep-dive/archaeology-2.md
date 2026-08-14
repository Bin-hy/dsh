# 源码考古：一条 fault 级错误与两个"未文档化的有意选择"

> 第三季 · 第 2 期。本期实证三条：A15-7 的 schedule fault 严重性（一条日志错误让整个 runtime 停摆）、A16-9 的 STREAM_CLOSED 不可重试（测试证明是终态）、A10-2 的停止原因映射不对称（codex interrupted→error vs ACP cancelled→aborted，有语义可辩护但文档未言明）。

## 1. A15-7：fold 时抛错 = 整个 schedule runtime 停摆

`packages/schedule/schedule/src/domain.ts:595-604`：

```ts
case 'dispatch': {
  const record = active.get(change.id)
  if (record === undefined) {
    throw new ScheduleLogError(`schedule dispatch targets inactive id ${...}`)
  }
  ...
}
```

关键问题：这个 `ScheduleLogError` 在**严格回放折叠**里抛出——而折叠发生在交付循环（`driveOnce`）的每一轮。一条非法/竞态产生的 `schedule/change` 事件会让**整个 runtime fault，直到重载**。

研究笔记当时的判断（A15-7）：

> 串行化事务下该竞态不可达，但 faulted 的严重性（整个 runtime 停摆直到重载）值得留意。

验证结论：竞态确实在串行化事务下不可达（`dispatch` 与 `delete` 都经同一条串行链），但**严重性设计值得商榷**——"防御不可达状态"用了"整个子系统停摆"作为响应。对照 DSH 自己的纪律（"fail loud" 只用于真正损坏的数据），这里抛错而非"跳过 + 告警"的选择意味着：**宁可停摆，不静默丢提醒**。提醒是有承诺的（"至少一次"），静默跳过会造成"该响的没响"——比停摆更难排查。这是可辩护的，但严重性应该在文档里明说。

## 2. A16-9：STREAM_CLOSED 是"不可重试的终态"

测试名（`packages/llm/llm-retry/tests/transport-recovery.spec.ts:174`）就是结论：

```ts
it('exposes a clean partial EOF as non-default-retryable STREAM_CLOSED', ...)
```

断言（`:191-199`）：

```ts
expect(server.requests).toHaveLength(1)          // 不重试
expect(...'llm/retry').toBe(false)               // 无重试事件
expect(agent.session.events.at(-1)).toMatchObject({
  type: 'turn/end',
  data: { reason: { kind: 'error', error: { code: 'STREAM_CLOSED' } } },
})                                               // 终态错误
```

干净的部分 EOF（流到一半连接关闭）→ **终态失败**。注意对比：脏截断（无 `[DONE]` 且帧不完整）同样映射 STREAM_CLOSED；而 `TRANSPORT`（连接建立失败）在默认可重试 codes 里。

为什么"干净 EOF 不重试"是合理选择（推断，源码未明说）：

- **部分输出已经被流式交付**：chunk 已进日志（该测试断言 3 条 chunk），用户可能已经看到了内容。重试会产生"两次半截输出"的歧义
- **EOF 是上游的决定**：干净关闭 ≠ 网络抖动，重试大概率复现同一行为
- **幂等性**：不能证明该请求无副作用时，自动重试是危险的

::: tip 方法论：怎么区分"未文档化的 bug"与"未文档化的选择"
三问：① 有测试钉住这个行为吗？（有 → 大概率有意）② 换个行为会破坏什么不变量？（重试会破坏"部分输出已交付"的语义 → 有意）③ 违反它的人会立刻踩坑吗？（不会静默出错 → 有意）。三问都是"是"，归为"选择"，只缺文档。
:::

## 3. A10-2：停止原因映射的不对称

| 传输 | 远端终态 | 映射到 | 代码 |
|---|---|---|---|
| Codex | `turn/completed` status `interrupted` | **error**（throw → settleRunResult 拍平） | `subagent-codex/src/wire.ts:192-196` |
| ACP | `cancelled` | **aborted** | `subagent-acp/src/run.ts:143-144` |

Codex 侧：

```ts
if (status !== 'completed') {
  const detail = status === 'failed' ? `: ${JSON.stringify(terminal.error)}` : ''
  throw new Error(`subagent-codex: Codex turn ended with status ${status}${detail}`)
}
```

`interrupted` 与 `failed` 一样走 throw → `error`。ACP 侧的 `cancelled` 则直接映射 `aborted`。

**为什么这个不对称是可辩护的**（语义推断）：

- `aborted` 在 subagent 词汇里的语义是"**父方取消**"（parent-driven）——ACP 的 `cancelled` 正是父方的 cancel 意图传到子端，语义对得上
- Codex 的 `interrupted` 是**子端自己的中断**（或协议层中断），父方没有取消——任务确实没完成且不是父方叫停，归 `error`（"没做完，不是被叫停"）
- 结论：映射不对称是**两个词的本义不同**，不是 bug。但"interrupted 没有独立 stopReason 成员"意味着父模型无法区分"子端自我中断"与"真错误"——这个信息丢失才是真正的可改进点

## 4. 本篇消化的 backlog 项

- ✅ A15-7 严格折叠的 fault 严重性（可辩护但文档应明说"宁可停摆不静默丢提醒"）
- ✅ A16-9 STREAM_CLOSED 不可重试（测试钉住 + "部分输出已交付"语义推断）
- ✅ A10-2 codex interrupted→error vs ACP cancelled→aborted（词义本不同；信息丢失点是真正可改进项）

## 5. 下一期预告

考古③候选：A15-9（ask() 无超时挂起）、A09-1（pending 无内存上界）、A10-3（SDK 无线上取消的语义）。
