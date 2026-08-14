# 源码考古：顺序即仲裁、有界滞后与一个被找回的符号

> 第三季 · 第 6 期。四条审计结局：A09-5 的"无版本仲裁"其实是**顺序仲裁**（cut → flush → put 的次序就是一致性协议）；A09-4 的搜索滞后是**有界陈旧读模型**（每次搜索先对账，扰动封顶两次重试）；A16-2 的 FIXME 是**进行时设计**；A14-1 的 `viewFor` 符号被找回——它在 host 侧，不在前端。

## 1. A09-5：顺序本身就是仲裁

原存疑："投影缓存回写无版本仲裁——putSoft 与并发恢复的竞态。"

`packages/session/session-projection-cache/src/index.ts:140-152` 的 `write()`：

```ts
const rows = this.ctx.sessionProjections.checkpoint(session)   // ① 先切检查点
this.markClean(session)
if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)  // ② 再 flush 日志
await this.put(session.id, identityOf(session.header), rows)   // ③ 最后落缓存
```

注释把仲裁协议写全了：

> Durability barrier: the checkpoint cut was taken above, so flushing AFTER it guarantees every event inside the cut is durably logged before the cache row lands — **a crash can leave the cache behind the log (longer tail replay) but never ahead of it (phantom values folded from events no stored log contains)**.

**顺序 = 仲裁**：①先切 → ②后 flush → ③再 put，保证不变量"缓存永不超前日志"。崩溃只造成"缓存落后"（代价是更长的尾部回放），绝不造成"幻影值"。残留的越界（detach 与 write 的竞态窗口）由冷读的 **anchored floor**（考古①/第 09 章的"减一锚点"）兜底——floor 从缓存水位出发回放，发现日志被截短就重读。

::: tip 方法论：找"仲裁在哪"而不是找"有没有仲裁"
版本号（CAS）只是仲裁的一种实现；**操作顺序 + 崩溃方向分析**是另一种。审计时先问"不变量是什么"（缓存 ≤ 日志），再问"什么顺序保证它"，最后问"破坏方向的后果是否被下游兜住"。三点都成立，就是完整的仲裁——哪怕没有一个 version 字段。
:::

## 2. A09-4：有界陈旧读模型

原存疑："搜索进行中发生写入的对账窗口。"

事实（`session-query-sqlite/src/index.ts`）：

- `_reconcile` 在**每次搜索前**执行（`:265/:293` 两个入口都先对账）
- 对账用 `listSnapshots`（轻量修订号），diff 出变化/删除并替换整行
- `STABLE_OBSERVATION_ATTEMPTS = 2`，注释原文："One transient source change gets a retry; **repeated churn fails rather than monopolizing the queue**"

结论：滞后窗口 = "对账快照之后、本次搜索执行之间"落地的写入，**下次搜索自愈**——这是有界陈旧读模型，不是缺口。真正值得欣赏的是 2 次重试的扰动封顶：持续写入的场景下不无限重试霸占队列，宁可返回一次陈旧结果。**陈旧读的成本（一次过期结果）与活锁的成本（搜索永远排不上）之间的权衡，答案选前者**。

## 3. A16-2：一个诚实的"进行时设计"

`packages/llm/llm/src/call-config.ts:14-15` 的 FIXME 原文：

```ts
// TODO(call-config-shape): Revisit which fields are epoch-level for cache reuse
// and where provider-specific request options belong.
```

现状（六个字段一律当 epoch 级）：

```ts
interface LlmCallConfig {
  provider: string; model: string; reasoningEffort?: ReasoningEffortId
  temperature?: number; maxTokens?: number; stop?: string[]
}
```

两个未决点的精确状态：

1. **哪些字段影响 KV 缓存复用**：provider/model/reasoningEffort 显然属于；temperature/maxTokens/stop 是否值得每次快照存疑——**现在全字段进 EpochHeader、全字段参与相等比较**（保守正确：多写快照不坏正确性）
2. **provider 特有选项住哪里**：现在住在**适配器自己的配置**（`ResolvedDeepSeekOptions` 的 thinking 模式等），经 `resolveCallFor` 物化为 `adapterDefaults` 标记——**不进 `LlmCallConfig`**

这是"进行时设计"的样本：TODO 记录了未决问题、现状是保守正确的、代价（多余快照）被量化承认。**FIXME 的存在本身是质量信号**——它把"我知道这里没做完"从口头变成代码里可检索的事实。

## 4. A14-1：viewFor 在 host 侧，被找回了

原存疑："viewFor 完整契约（slot 视图解析的边界语义）"——全仓库搜索的答案：

```text
packages/host/apiproxy/src/api-proxy.ts:744   ← 本体：ToolEventView 纯推导器
packages/client/connection/src/client/fixture.ts:722  ← 测试镜像
```

`fixture.ts:721` 的注释把契约写清了：

> Host-side viewFor mirror: **tool/call presents from its own args; tool/result back-scans the log for the paired call.**

契约要点：**纯推导、undefined = 无视图**。`tool/call` 用自身 args 走 `presentCall`；`tool/result` 反扫日志找配对的 call 再走 `presentResult`。它不在前端 slot 系统里——它服务于 `session/event` 帧的 `view` 字段（第 07 章 MuxFrame 里那个 `view?: ToolEventView`）。前端拿到的是**已算好的视图**，回放时由 fixture 镜像重算。

::: tip 方法论：符号失踪时的两问
第一问"它在哪个平面"（host vs client）——名字带"view"的符号容易想当然在前端，实际是 host 侧的帧装修。第二问"谁镜像它"——fixture 的镜像函数往往是契约的浓缩注释（"present from own args / back-scan for paired call"一句话就是全部语义）。
:::

## 5. 本篇消化的 backlog 项

- ✅ A09-5 投影缓存"无版本仲裁"（证伪：顺序仲裁 + 崩溃方向分析 + floor 兜底）
- ✅ A09-4 搜索对账滞后（有界陈旧读模型 + 2 次重试扰动封顶）
- ✅ A16-2 call-config FIXME（进行时设计：全字段 epoch 级保守正确，provider 选项住适配器配置）
- ✅ A14-1 viewFor 契约（host 侧纯推导器，fixture 镜像）

## 6. 下一期预告

考古⑦候选：A09-6（reserve 相位机覆盖）、A13-1（批次内目录命中场景）、A13-3（frozen-project-root TODO）、A10-4/5/6（ACP 能力声明、codex 通知放行窗口、claude 设置源省略）。
