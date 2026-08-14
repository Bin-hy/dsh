# 10 · 进程外子代理与 ACP：四种跨进程传输

> 消化 backlog A10。DSH 把"子代理"抽象成**具名传输注册表**：进程内与进程外只是两种传输实现。本章拆解四种进程外 Provider（ACP / Codex / Claude Code / DSH SDK）、ACP 服务器、以及"发布边界"这个跨进程容错的核心契约。

## 1. 传输全景

```text
ctx.subagents.start(name, request) → provider.start(resolved)
  ├─ acp:        spawn 任意 ACP agent → ACP SDK ClientSideConnection
  ├─ codex:      spawn `codex app-server --stdio` → 私有 JSON-RPC 适配器
  ├─ claude-code: 官方 @anthropic-ai/claude-agent-sdk query() → SDK spawn 真实 CLI
  └─ dsh-sdk:    HarnessClient spawn 完整第二个 harness 运行时 → SDK stdio JSON-RPC
```

一个漂亮的对称：**ACP 服务端与 ACP 客户端是"方向反转的孪生体"**——`acp/acp` 把 harness 暴露成 ACP agent 给机器客户端；`subagent-acp` 把 harness 变成 ACP client 驱动子进程。`dsh-sdk` 更彻底：子代理是**递归同构**的完整 harness（有自己的 cordis.yml、持久化、工具）。

## 2. 能力旗标：fail-loud 的极致

四个进程外 Provider 的能力全部为 `NO_START_CAPABILITIES`（全 false，出处唯一：`packages/subagent/subagent/src/out-of-process.ts:25`），进程内 spawn/fork 则全 true。

```ts
interface SubagentCapabilities {
  readonly outputSchema: boolean   // 结构化输出
  readonly depthLimit: boolean     // 委派深度
  readonly toolFilter: boolean     // 工具过滤
  readonly persona: boolean        // 人格定制
}
```

请求需要而提供方不具备 → 在 `start()` 运行前抛 `UNSUPPORTED_CAPABILITY`。**绝不"接受后静默忽略"**——父进程无法向子进程强制这些启动特性（子进程有自己的环境），所以诚实地说"做不到"。

::: tip 面试要点：为什么"零能力"是诚实而不是缺陷？
进程外子代理 = 全新环境、会话、模型、工具，共享零 Cordis 上下文。父进程能控制的只有：spawn 参数（argv/cwd/env）与协议消息。能力旗标的作用是**把"父进程能强制什么"显式化**——这比"文档里说支持、运行时悄悄丢"安全得多。
:::

## 3. 发布边界：result 永不 reject

进程外传输的容错核心契约（`docs/subsystems/subagent.zh.md:437`）：

```text
provider.start() fulfill 之前：失败 = reject（未发布资源已清理，不 emit 事件对）
provider.start() fulfill 之后：失败 = resolve 成 stopReason（子代理级失败不是异常）
```

`SubagentResult = { output, structured?, stopReason }`，`stopReason` 是判别联合（`completed/aborted/error/max-tokens/refusal`），消费方把非 `completed` 映射为 `isError` 结果**并附部分输出**——"部分输出绝不冒充成功"。

设计动机：**失败是要喂回给模型的材料**。父 agent 需要看到子代理的部分成果 + 失败原因来决策（换策略？重试？放弃？）。reject 把失败变成异常流，模型永远看不到中间态。

`settleRunResult`（`out-of-process.ts:156`）保证这个契约在四种传输里统一：取消 → `aborted`、失败 → `error` + 诊断汇（`onError` 先记 warn 再拍平）。

## 4. 四种传输的协议细节

### 4.1 ACP：启动事务 + 自动应答权限

```text
spawn 子进程 → race(initialize+newSession, spawnFailed, cancelSettled) → prompt → chunk* → stopReason
```

- **spawnFailed 竞速**："干净退出永不赢得竞速"——子进程没说话就退出时，防止被误判为启动成功
- **取消是本地结算**：abort 一到就 settle，不等子进程合作（best-effort 发 `conn.cancel`）
- **权限自动应答**：`requestPermission` 按策略选 `allow_once/allow_always`，否则 `cancelled`——**不把任何权限提示暴露给人类**（无人值守委派）
- `max_turn_requests` → `error`：ACP 没有对等语义，任务未完成不能伪装成完成

### 4.2 Codex：私有 JSON-RPC + 严格 id 校验

- 固定 argv `codex app-server --stdio`（Windows 走 `cmd.exe /d /s /c`，无 shell 注入面）
- `validateRunIds` 拒绝引用其他线程/轮次的服务器消息；`commitTurnId` 在 turn/start 响应后才放行早到的通知——**协议层的消息归属校验**
- 无人值守审批：`cancel` 优先、否则 `decline`，不授予任何权限、不等待 UI
- `contextWindowExceeded` → `max-tokens`；本版本无原生拒绝态 → 不产生 `refusal`

### 4.3 Claude Code：官方 SDK + spawn 投影

- `ctx.subprocess.resolveExecutable('claude')` 从宿主 PATH 解析**真实 CLI**——SDK 使用启动 DSH 的原生产品而非自带 optionalDependency
- SDK 的 `spawnClaudeCodeProcess` hook 投影成 `SubprocessSpawnSpec`——**进程树仍归 dsh-subprocess seam 独占**（`kill()` 路由到树作用域 `terminate()`）
- Options 刻意收窄：`persistSession: false`、`disallowedTools: ['AskUserQuestion']`、不设对话回调——无人值守交互经 SDK 失败而非等待 UI
- 只有 `subtype:'success' && is_error:false && 非空 result` 才 `completed`；**不产生 max-tokens/refusal**（SDK 的轮次/预算限制不代表 token 窗口耗尽）

### 4.4 DSH SDK：递归同构

- 唯一不经 `ctx.subprocess.spawn` 的后端（subprocess seam 文档记载的"SDK 托管传输"例外）——`HarnessClient` 直接 spawn 完整第二个 harness
- content blocks **逐字过线**（不序列化重解）；客户端等 inbox 回执（`agent/inbox/spliced` 含 messageId）+ `session.status idle` 才算轮次完成
- 终止原因取事件流最后一条 `turn/end`：`completed/max-tokens/aborted` 直通，其余 → `error`
- **无线上取消**：协议没有取消方法，超时与 dispose 都只本地结算，服务器侧轮次继续跑到进程清理

## 5. 进程树阶梯式 teardown

四种传输的 dispose 是同一个四阶梯（`disposeRuntimeProcess`）：

```text
1. stdin EOF（合作：子进程窗口 flush 持久化与回收自身后代）
2. 宽限（默认数秒）
3. terminate()（SIGTERM → grace → SIGKILL）
4. waitForExit()（整树退出证明）
```

先合作、再温和、再暴力、最后**证明整树退出**——这是 DSH 进程管理哲学的浓缩（第 03/12 章同款）。dispose 幂等 memoize，所有失败聚合可独立观察。

## 6. 三个教学价值最高的设计

1. **能力旗标 fail-loud**：把"父进程能强制什么"从文档挪进类型——`UNSUPPORTED_CAPABILITY` 在 start 前炸出，而不是运行中悄悄降级
2. **发布边界 + result 永不 reject**：失败是数据不是异常——部分输出 + stopReason 喂回模型，让父 agent 做出知情决策
3. **协议选择由传输形态决定**：api-gateway 的 Typert Remote 只处理"单请求单结果"；进程外子代理需要**双向流式 + 进程生命周期管理**，所以四个后端都走专用进程协议——不是所有 RPC 都该走同一个网关

## 7. 面试要点

::: tip 面试要点 1：为什么子代理失败要 resolve 而不是 reject？
失败是要喂回模型的数据：父 agent 根据 stopReason + 部分输出决策（重试/换策略/放弃）。异常流里模型永远看不到中间态。
:::

::: tip 面试要点 2：跨进程取消为什么"本地结算优先"？
子进程可能不合作（卡死、协议不实现取消）。父进程的取消语义不能依赖子进程的善意——本地立即 settle 为 aborted，协议级 cancel 是 best-effort，进程拆除（SIGKILL）才是权威。
:::

::: tip 面试要点 3：无人值守委派为什么自动应答权限？
子代理是父 agent 的工具，不是新的人类会话。把权限提示暴露给人类 = 委派失去"无人值守"语义。策略（allow/reject）在配置层决定，提示在传输层消化。
:::

下一篇：作用域与事件内核（研究中）。
