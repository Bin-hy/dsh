# 09 · 会话持久化内核：热路径零 I/O 与崩溃修复

> 消化 backlog A09。DSH 把持久化做成挂在 `Session` 热路径之外的**异步有界批量 + 显式屏障**两级调度。本章拆解写路径全景、两个后端的崩溃模型、`interruptedTurnClosers` 修复与投影缓存的冷读阶梯。

## 1. 核心契约：热路径从不阻塞 I/O

`Session.append` 是同步热路径，它的 I/O 契约直接写在源码里（`packages/core/session/src/index.ts:570-575`）：

```text
append → log.push（提交）→ 同步广播 session/event（fire-and-forget）
```

持久化插件订阅 `session/event` **异步**入队——观察者失败被兜住，**不会改变 append 的返回值**。这是整个持久化设计的原点：**事件日志的提交与磁盘的持久化是两个时间平面**，中间隔着有界缓冲。

## 2. 有界合并：为什么不是防抖

`SessionWriteBehind`（`write-behind.ts`，159 行即全部逻辑）：

```text
第一个待处理事件 → armTimer(200ms 固定窗口)
后续事件 → 只 push，不重置计时器        ← 关键差异
窗口到期 → startWrite(整批 pending)
```

**有界合并 vs 防抖**（决策 Agent Note 2026-08-08）：防抖会被连续流式响应**无限推迟首次写入**——每个新 chunk 都重置计时器，流不停就永远不落盘。固定窗口保证"首事件到达后 200ms 内必有一次写入尝试"，批大小有上界。

失败语义：

- 后台写失败 → 完整批次**恢复到 pending 最前（保序）**、暂停自动重试、记 warn
- 新事件到来重新开窗；显式 `flush` 立即重试并**把失败暴露给调用方**
- 同一会话同时最多一个活跃写；窗口在活跃写期间到期只置 `deadlineExpired`，写完后立即续写

## 3. 持久化点全景：不止批量窗口

除了 200ms 窗口与 `session/flush` 屏障，还有七个持久化点（coordinator.ts 逐一）：

| 时机 | 行为 |
|---|---|
| 会话创建 | 种子事件不发 `session/event`，必须创建时直接落盘一次 |
| HMR 采纳 | 截断撕裂尾 + 持久化 live 后缀（**不合成闭合器**——live Session 仍是权威） |
| `session/flush` | 共享 barrier：取消计时器 → 等活跃写 → 循环排空 |
| **checkpoint-policy** | 三个 fail-closed 屏障：`llm/stream` 前置（模型请求前缀未持久化就不向适配器分发）、顶层 `tools/execute` 前置、`agent/pre-step` 前置 |
| 会话退役 | `session/disposed` → flush + 串行删除记账 |
| dispose | 最终排空：flush 所有活跃会话 → 等串行链 settle → 关后端 |
| load 活跃会话 | 隐式 flush 再取快照 |

::: tip 面试要点：为什么"模型请求前必须 flush"？
审计一致性：日志是"模型可见即已记录"的持久真源。如果请求已发出但前缀事件还没落盘，崩溃后恢复的日志就少了"模型看到过的东西"——所以 `llm/stream` 前置 flush 是 **fail-closed** 的：写不进去就不发请求。
:::

## 4. 两个后端的共同崩溃模型

后端只实现极小契约（`PersistenceBackend`：loadStored / readStoredRevision / appendBatch / commitRepair / list），**批调度、失败保留、串行化、修复排序全是协调器的事**。

共同的崩溃模型：

```text
已提交区（有 turn/end 收尾的连续前缀）→ 绝不重写、绝不断言损坏
撕裂尾部（崩溃留下的不完整最终记录）→ 只截断/补齐，容忍
```

- **JSONL**：每批一个独立 zstd 帧（带 checksum），帧边界 = 批边界 = 崩溃恢复最小单元。撕裂帧可部分恢复（`ZSTD_e_flush` 解出已有明文）；修复 = 截断到 `truncateTo` + 重写
- **SQLite**：`SCHEMA_VERSION=15` 单调版本，不匹配即拒（不做就地迁移）；`scanRows` 找最后一个有效 `turn/end`，其后的洞/seq 断点 = 未提交撕裂尾 → `DELETE FROM events WHERE seq >= tornFrom` + 补齐
- **物化并发安全**：JSONL 用 `link(tmp, final)` 而非 `rename()`——link 遇 EEXIST 失败，两进程并发物化同一 id 不会互相覆盖；追加失败**截断回原尺寸再抛**（留半截字节会造重复 seq）

::: tip 面试要点：为什么"容忍撕裂尾、绝不断言已提交区"？
崩溃恢复的黄金法则：**宁可不读，不可误读**。已提交区出现洞 = 存储真的坏了（磁盘翻转、外部篡改），必须 fail loud；最后一批没写完 = 正常崩溃场景，截掉即可。两种失败的可信度不同，处理强度必须不同。
:::

## 5. 崩溃修复：interruptedTurnClosers

崩溃时日志可能停在"turn 开着、tool/call 没有 result"。`repair.ts` 的扫描状态机合成闭合器：

```text
对每个 pending tool-call：
  已记录开始但结果未知 → tool/result(TOOL_OUTCOME_UNKNOWN, sourceEventSeqs 引用 callSeq)
  从未记录开始         → tool/result(TOOL_NOT_STARTED)
step 仍开 → step/end
→ turn/end { reason: { kind: 'interrupted' } }
```

三个语义细节：

1. **`interrupted` 是唯一不由循环发出的 turn 结束原因**——只由持久化后端在崩溃修复时合成（`types.ts:155`）
2. seq 从 `last.seq + 1` 续、复用 `last.time`——**确定性，不发明"未来时间"**
3. **只对冷会话 commit**：活跃会话的 load 拒绝（open turn 直接抛错）；HMR 只截断不闭合

## 6. 投影缓存的冷读阶梯

投影缓存（`session-projection-cache`）回答"列表页怎么不加载完整日志"：

```text
1. 零 I/O 档   cachedSnapshot：内存态直接命中（identity 匹配 + ver 匹配）
2. 冷读档      restoreFloor(cached) → persistence.readFrom(floor) 尾部回放 → restore 重折叠
3. 回写        putSoft 更新检查点，下次冷读从更近处起步（fail-soft）
```

**那个"减一"**（`restoreFloor` 取全单元最小水位再减一作为锚点）是承重设计：空尾读从锚点出发得到低于所有水位的 end，从而能发现"日志被崩溃修复截短了"。

水位写入：`turn/end` 与 `session/disposed` 是**强制点**；先 `ctx.sessions.flush` 再 `put`——"缓存绝不会超前于日志"。

## 7. 全文检索：可抛弃的派生索引

`session-query-sqlite` 的 FTS5 索引是**可抛弃读模型**：

- schema 版本不符直接 DROP 重建；`openAt:'never'` 连 node:sqlite 都不加载
- **查询文本永远是数据而非 FTS 语法**：整段查询包成单个双引号短语——模型/用户输入不能注入 FTS 查询语法
- 游标 = base64url 编码的 `{fingerprint(规范化请求), generation, offset}`——**指纹绑定**保证游标只能用于同一规范化请求，防串页；世代不符抛 `SESSION_QUERY_STALE_CURSOR`
- 每次搜索前先对账：用 `listSnapshots`（轻量修订号）diff 出变化/删除，替换整行并分配新世代

## 8. 设计权衡总结

| 决策 | 权衡 |
|---|---|
| 热路径零 I/O | 事件提交永不阻塞；代价是崩溃窗口内的尾部丢失——用显式屏障（checkpoint-policy）把窗口压到"语义安全点" |
| 有界合并非防抖 | 首写延迟有上界；代价是低流量时 200ms 空窗等待 |
| 后端最小契约 | 换存储 = 实现 5 个方法；代价是协调器成为单点复杂度（1361 行） |
| 惰性物化 | 创建后从未 append 的会话不留痕迹；代价是物化与首批必须原子（单事务） |
| 只截断不重写 | 修复安全、简单；代价是已提交区损坏无法自愈（fail loud 交给人工） |

## 9. 面试要点

::: tip 面试要点 1：逐事件写盘为什么不行？
每事件 = 1 帧/1 事务/1 fsync。流式响应一秒几十个 chunk，200ms 窗口把 20 次写合并成 1 次。固定窗口（非防抖）保证上限。
:::

::: tip 面试要点 2：为什么修复合成 `interrupted` 而不是 `aborted`？
`aborted` 语义是"取消信号导致"；崩溃没有取消信号，是持久化层主动闭合。给循环之外的原因一个专属词表成员，回放/UI/统计才能区分"用户取消了"与"上次崩溃了"。
:::

::: tip 面试要点 3：投影缓存为什么 fail-soft？
缓存是优化不是正确性。`putSoft` 失败只记 warn——陈旧缓存只贵在更长的回放，绝不错误；而 flush 屏障保证它绝不超前于日志。
:::

下一篇：进程外子代理与 ACP / 作用域与事件内核（研究中）。

::: tip 相关考古
持久化的后续审计见[考古⑥](/deep-dive/archaeology-6)（投影缓存的"顺序即仲裁"）与[考古③](/deep-dive/archaeology-3)（write-behind pending 无内存上界的真实缺口）。
:::
