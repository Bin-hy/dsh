# 源码考古：所有权澄清、被绕过的 rev 与同步限制

> 第三季 · 第 10 期。四条审计：A14-2 的"session.seq 分配点"澄清为**客户端从不分配**（seq 是 Host 事实）；A14-4 的 rev 机制澄清为**启动锚点而非运行时缓存**（运行时靠 no-cache + rebuilt 帧）；A16-5 的不变量同步限制被注释确认；A13-8 的组合安全但未测试。

## 1. A14-2：客户端不分配 seq——存疑的前提错了

原存疑："`session.seq` 的分配点（客户端 Session 的序列号在哪里推进）？"

审计结果：**客户端 Session 没有 seq 分配逻辑**。seq 是 Host 事实，经 `session/event` 帧携带，客户端只做三件事：

```ts
// session.ts 的观测面
this.subscribedLastSeq = frame.lastSeq            // :479 基线水位
const tailSeq = this.windowTailSeq()              // 窗口自身尾部
if (subscribedLastSeq > tailSeq) → 尾页重拉        // :628-629
if (event.seq > tailSeq + 1) → buffer + repairGap  // :690-691
```

存疑的前提（"客户端在某处推进 seq"）不成立——这是考古系列第 8 次证伪，也是第一个"前提错误"型证伪。**审计时先验证存疑的前提，再验证存疑本身**；前提错了，问题就消失了。

## 2. A14-4：rev 是启动锚点，运行时它被绕过了

`packages/client/hmr/src/client/index.ts:154-159` 的 `graph` 帧处理：

```ts
case 'graph':
  // Connect-time snapshot, unused. The loader's cached graph rev
  // goes stale after rebuilds — harmless, since prefetch hits the
  // network anyway (host serves bundles no-cache); graph rev refresh
  // lands with the reconnect-handshake mechanism.
  break
```

rev 哈希的真实角色（对照第 07 章）：

- **启动期**：boot manifest 的 rev 是**一致性锚**——保证一次启动里的图与 bundle 版本互配
- **运行时**：**被绕过**——host 以 no-cache 提供 bundle，prefetch 永远打网络；`graph` 帧"unused"
- **热更新**：`rebuilt` 帧 → **串行化的 reload 队列**（注释：帧可以比 swap 快，交错 dispose/execute 会破坏单槽交接）→ removeOwnedStyles → `entry.refresh()` 重新物化工厂 → 重新挂插件 → 失败响亮（FAILED 状态可重试）

所以"rev 如何失效缓存"的答案：**它不失效缓存——缓存从一开始就不存在**（no-cache + 每次 prefetch 打网络）。rev 被降级为启动一致性锚。简单到极致的方案：开发通道的 bundle 不值得缓存。

## 3. A16-5：不变量的同步限制是文档化约束

`packages/credentials/credentials/src/invariant.ts:18-30`：

```ts
/**
 * ... The value relation itself (`describe` agreeing with `resolve`) is
 * asynchronous provider I/O and stays pinned by each provider's own suite.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('credentials/updated', (ref) => {
    if (ctx.get('credentials') === undefined) {
      fail(`credentials/updated for "${ref}" emitted without a live credentials service`)
    }
  })
}
```

审计确认两件事：

1. **不变量只查同步事实**（"事件发出时服务是否存活"）——异步关系（describe 与 resolve 的一致性）**刻意留给 provider 自己的测试套件**
2. 原因（第 16 章已写）：`INVARIANT` 的 rethrow 只从同步监听器到达调用方——挂在这类事件上的检查必须同步，异步检查的失败只能被包含记录

这不是疏漏，是**明确的设计边界**：不变量管"生命周期契约"（可同步判定），测试套件管"值关系"（异步 I/O）。两类正确性验证按"能否同步判定"分流。

## 4. A13-8：组合安全、组合未测

原存疑："压缩区间同时包住目录与剪枝节点的组合未单独测试。"

审计结果：

- **机制上安全（组合推理）**：剪枝只 replace 单个 `tool/result` 节点（从不碰目录消息）；压缩区间选择对 surface 节点一视同仁（工具配对平衡切点）；目录消息被 summary 遮蔽后由恢复协议重发布（tool-skill.spec.ts:588 有直接测试）
- **组合未测（事实）**：`compaction-basic` 的 pruner 测试与 tool-skill 的恢复测试各自存在，但"同区间同压"的组合没有集成测试

诚实分类：**组合性安全 + 覆盖缺口**。这类存疑的正确处置不是"写个测试"（那要改上游），而是**归档为候选 issue（低优先级）**并说明组合推理依据——如果上游想加，一句"compositionally safe, add an integration test"就是完整的 issue。

## 5. 本篇消化的 backlog 项

- ✅ A14-2 session.seq 分配点（**前提错误型证伪**：客户端只观测，Host 分配）
- ✅ A14-4 HMR rev 流程（启动锚点 + 运行时绕过 + 串行化 reload 队列）
- ✅ A16-5 invariant 同步限制（文档化设计边界：不变量管同步事实，测试管异步关系）
- ✅ A13-8 目录+剪枝同区间组合（组合性安全 + 覆盖缺口，低优先级 issue 候选）

## 6. 考古系列十期累计

```text
已消化 36/52 条：实证 bug ×2 · 证伪 ×8 · 缺口 ×2 · 设计债 ×2 · 归档 ×22
剩余 16 条：A13-4(已)…见 backlog
下一期候选：A14-3（conversation 折叠引擎）、A16-1/6/7/8、A15-2/3/4/5/6/10、A10-7/8/9
```

## 7. 下一期预告

考古⑪候选：A16-7（进程层热轮换边界）、A16-8（对称>复用的文化案例）、A15-10（事件命名无统一前缀）、A10-7/8/9（SDK 隔离边界/例外使用者/宽限配置来源）。
