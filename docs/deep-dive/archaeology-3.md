# 源码考古：三个"没有上界"的诚实审计

> 第三季 · 第 3 期。本期审计三条"资源上界缺失"：ask() 没有问题过期时间、write-behind 的 pending 没有内存上界、SDK 协议没有线上取消方法。共同结论：**每个"没有上界"背后都有一个可辩护的设计或一个诚实的缺口——把它们区分开是源码考古的核心技能。**

## 1. A15-9：ask() 挂起到什么时候？

`packages/interaction/user-questions/src/index.ts:92` 的 `ask()` 校验链：

```ts
if (request.signal?.aborted) throw ... 'ASK_ABORTED'
if (request.questions.length === 0) throw ... 'EMPTY_QUESTIONS'
const agent = request.agent
if (agent !== undefined) { ... DELEGATED_CALLER 拒绝 ... }
```

之后就是 `provider.ask(...)`——**没有超时、没有过期、没有"用户已离开"检测**。

但有一个此前笔记没写透的缓解：工具执行时把 `exec.signal` 传进去（`tool-ask-user/src/index.ts:81` 的 `await ctx.userQuestions.ask({ signal: exec.signal, ... })`）——**轮次级取消会传导到问题**。所以"挂起"的真实语义是：

```text
UI 卡死 + 无人取消轮次 → 模型回合无限挂起
用户按取消 → signal abort → ASK_ABORTED，回合恢复
```

结论：**没有"问题级"过期，但有"轮次级"逃生门**。缺口的真实大小比笔记原判断小一档——挂起有界于"用户对轮次的耐心"。这提醒我们：审计"无超时"时，要把**所有传入的 AbortSignal** 都算进逃生路径，而不是只看有没有 timeout 参数。

## 2. A09-1：pending 无内存上界——一个真实缺口

`packages/session/session-persistence/src/write-behind.ts:44-58` 的 `enqueue`：

```ts
enqueue(event: SessionEvent): void {
  const wasEmpty = this.pending.length === 0
  this.pending.push(structuredClone(event))   // ← 没有任何长度检查
  ...
}
```

正常运行时，200ms 固定窗口保证 pending 有界（窗口到期即排空）。但**持续写失败**的场景：

```text
后端磁盘故障 → 写失败 → 批次恢复 pending 最前 + automaticPaused
新事件继续到来 → enqueue 继续 push + 重新 armTimer 重试
重试继续失败 → 批次继续恢复 pending
```

**pending 随事件率线性增长，无上限**。流式响应一秒几十个 chunk，磁盘故障一小时 = 数十万条结构化克隆的事件驻留内存。

这是**真实缺口**（不是可辩护的设计）：写失败是预期内场景（磁盘满、权限变更），而"失败期间内存无限增长"是次生事故。对照 DSH 自己的纪律——"Apply bounds to the complete result"（第 12 章终端的三层字节上界）——写缓冲的**内存**上界恰恰被漏掉了。修复方向很常规：pending 字节数上限 + 超限时暂停接受新事件（背压），并让 flush 显式报告。

::: tip 方法论：区分"缺口"与"选择的边界"
对比本期三条：ask() 的"无超时"有轮次级逃生门（选择）；pending 的"无上界"在失败场景下无任何逃生门且直接违反仓库自己的"bounded"纪律（缺口）；SDK 的"无取消"（下节）是协议极简主义（选择）。判据：**逃生门是否存在 + 是否违反自己的纪律**。
:::

## 3. A10-3：SDK 没有线上取消——协议极简主义

`packages/sdk/protocol/src/types.ts:101-104` 的请求表只有三项：

```ts
'initialize' | 'session/prompt' | 'shutdown'
```

没有 `session/cancel`。语义后果（第 10 章已写）：超时与 dispose 都只本地结算，服务器侧轮次继续跑到进程清理。

为什么这是"选择"而非"缺口"：

- **进程清理是权威取消**：SDK 后端的父方握着整个子进程——EOF→SIGTERM→SIGKILL 阶梯（第 10 章）比任何协议级 cancel 都更可靠
- **协议极小化**：三个方法就够"启动/干活/退出"。加 cancel 意味着要定义"cancel 的确认语义"（cancel 后还要不要等收尾？），协议复杂度翻倍
- 代价是"取消后进程清理前的空转"——服务器侧轮次继续跑，消耗子进程的 token 预算。这是**为极简付出的明确代价**，写进 Agent Note 即算交代

## 4. 本篇消化的 backlog 项

- ✅ A15-9 ask() 无问题级超时（轮次级逃生门确认，缺口大小修正）
- ✅ A09-1 pending 无内存上界（持续写失败场景确认为真实缺口 + 修复方向）
- ✅ A10-3 SDK 无线上取消（协议极简主义的选择，代价明确）

## 5. 下一期预告

考古④候选：A09-3（JSONL 无 loadStoredFrom 的全量解析放大）、A09-7（跨进程并发写未防御）、A11-1（internal/listener 类型声明落后于实现——类型 bug 候选）。
