# 源码考古：类型声明滞后、顺序介质读放大与单写者假设

> 第三季 · 第 4 期。本期审计三条：`internal/listener` 的类型声明落后于实现（类型 bug 候选）、JSONL 冷读的全量解析放大（规模缺口）、跨进程并发写的单写者假设（防御深度缺口）。三个都是"小但真实"——把它们与各自的缓解边界一起讲清楚。

## 1. A11-1：声明说 boolean，实现传对象

`vendor/cordis/src/events.ts` 的两行对照：

```ts
// :349 —— Events 词表里的类型声明（落后）
'internal/listener'(this: Context, name: string, listener: any, prepend: boolean): void

// :296 —— 实际分发（现状）
const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
```

实际调用链：`on()` 把布尔简写归一化成对象（`:290` `options = { prepend: options }`），拦截器（`:140`）也按 `EventOptions` 对象解构。只有词表声明还停留在"prepend: boolean"时代。

影响面：**纯类型问题**——运行时双方都按对象处理，没有运行时崩溃。但任何按声明类型写 `internal/listener` 拦截器的插件，会拿到一个"类型是 boolean、实际是对象"的参数，类型系统在这里说了谎。这是 vendored cordis 的一个小类型滞后，适合作为低优先级 issue 提交。

::: tip 方法论：类型滞后 vs 运行时 bug
`internal/listener` 的声明滞后不影响运行时（两侧都按对象走）；而 A11-2 的 DisposableList 缺 unshift 是运行时崩溃。审计顺序：先问"运行时事实是什么"（读分发点），再问"类型声明与之一致吗"。**类型说谎但运行时不炸，是"低危"；类型正确但运行时会炸，是"高危"。**
:::

## 2. A09-3：JSONL 的"顺序介质读放大"

`packages/session/session-persistence/src/coordinator.ts:867-869`：

```ts
// Sequential fallback: contiguous seqs from 0 make the suffix an index slice.
return { meta: whole.meta, events: whole.events.slice(fromSeq) }
```

SQLite 有 `loadStoredFrom`（`SELECT ... WHERE seq >= fromSeq`，按 seq 寻址）；JSONL 是顺序介质，没有这个 hook——**冷读"最后 10 个事件"要解析全部 10 万个事件再切片**。

这是"顺序介质的诚实代价"：JSONL 用文件布局换取简单性（可 zstd、可部分恢复、人类可读），代价是随机访问 = 全量扫描。缓解边界：

- 投影缓存的冷读阶梯（第 09 章）把"需要读日志尾部"的频率降到最低
- `list()` 只读第一行（列表不随日志大小伸缩）
- 但单会话冷读（恢复/检查）的放大是**结构性的**——100k 事件的会话恢复就是 100k 解析

结论：规模缺口，非 bug。选 JSONL 就是选了这个代价；文档把 fallback 语义写进了代码注释，算交代了一半（另一半是"为什么不做索引文件"——会引入第二真源与一致性难题，DSH 显然不愿意）。

## 3. A09-7：跨进程并发写是"单写者假设"

物化路径有并发防御（`:546`）：

```ts
// concurrently cannot clobber each other. rename() would silently overwrite.
```

`link(tmp, final)` 的 EEXIST 语义保证两进程并发物化同一 id 不会互覆。

但**追加路径没有跨进程锁**：追加协议是"stat 前尺寸 → writeFile → 失败截断回原尺寸"——这套回滚在单写者下正确（协调器的按 id 串行化），双写者下会互相踩：A 的失败回滚可能截掉 B 已写的数据。

缓解边界：**会话的所有权**——一个 session id 同一时刻只有一个 agent-loop 进程持有（HMR 采纳/退役有完整的交接协议，第 09 章）。跨进程同写同一 session 意味着两个进程都认为自己是 owner，这是更上层的 bug。所以"未防御"是**单写者假设**，不是无保护的并发写——假设本身有所有权协议背书，只是没有防御深度（没有文件锁做最后一道保险）。

::: tip 方法论：区分"裸假设"与"有背书的假设"
单写者假设如果有所有权协议背书（owner 交接是持久化协调器的一等公民），就是工程上可接受的；如果只是"没人想到会并发"，就是缺口。审计时找**背书在哪**：协调器的串行化 + 退役协议 + HMR 采纳 = 背书链完整。结论：不加固，但应文档化"跨进程并发写不在支持范围"。
:::

## 4. 本篇消化的 backlog 项

- ✅ A11-1 `internal/listener` 类型声明滞后（纯类型问题，运行时按对象一致）
- ✅ A09-3 JSONL 顺序介质读放大（结构性代价，非 bug）
- ✅ A09-7 跨进程并发写单写者假设（有所有权协议背书，缺防御深度）

## 5. 考古系列方法论小结（①~④ 共通）

```text
第 1 步  存疑（读码时的诚实"没看透"）
第 2 步  读码（定位两行矛盾的代码）
第 3 步  最小复现（能跑就真的跑崩/跑通）
第 4 步  影响面（谁触发、谁不触发、有没有逃生门）
第 5 步  分类：bug / 缺口 / 选择——按"运行时是否炸 + 违反自己纪律吗 + 逃生门在哪"三问
第 6 步  归档：issue 素材（可提交）+ 博客（可讲）
```

下一步预告：把 ①② 里已实证的两个 issue（DisposableList unshift 崩溃、internal/listener 类型滞后、README 文档滞后）整理成可直接提交的完整清单，并继续消化剩余 ~39 条存疑。
