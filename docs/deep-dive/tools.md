# 02 · 工具系统与执行管道

> 一次工具调用在 DSH 里要穿过一条九段流水线：materialize → pre-execute → guard → approval → execute(around) → 函数体 → post-execute → finalizeContent → result。每一段都是策略插件的挂载点。本章基于 `packages/core/tools/`（约 5,200 行）与 `packages/core/agent-loop/src/tool-calls.ts` 的真实源码。

## 1. 概念地图

DSH 工具系统三层：

1. **注册层**：`ctx.tools`（`ToolRuntime`）按 agent scope 分层注册/遮蔽/限制工具，并把面向模型的 schema 投影进 system prompt
2. **执行层**：pre-execute → guard → execute → post-execute → finalize → result 流水线，策略以 waterfall 事件挂载
3. **能力层**：工具本体不碰操作系统，消费抽象 seam（`ctx.shell`、`ctx.fs`、`ctx.subprocess`、`ctx.sandbox`）

核心术语：

| 术语 | 含义 |
|---|---|
| `ToolDefinition` | 已注册工具：schema + output 契约 + `execute` + 可选 `finalizeContent`/`presentCall`/`presentResult`/`timeoutMs`/`isConcurrencySafe` |
| `executionMode` | `parallel`（可与兄弟重叠）/ `exclusive`（独占屏障） |
| `ToolGuard` | 单调守卫：只能拒绝，**没有 allow 分支** |
| `ToolExecutionResult` | 结果闭集：Success `{isError:false, value, content, ...}` / Failure `{isError:true, error, content}` |
| canonical value | 工具函数体的返回值，**只活在执行期**；持久化只留 `content/error/meta` |
| Code Mode | `run_code` 保留传输：模型写程序，程序内工具调用重入完整流水线 |

## 2. 关键类型：ToolDefinition

```ts
// packages/core/tools/src/index.ts:222（研究笔记摘录）
interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition          // 必填：schema + render + presentationMeta
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  finalizeContent?(exec, result): ContentBlock[] | undefined
  timeoutMs?: number                              // 合作式超时预算，绝不下发给模型
  isConcurrencySafe?(args: unknown): boolean      // 纯同步分类器，只有精确 true 才并行
  presentCall?(args): ToolCallView | undefined    // UI 卡片的调用视图
  presentResult?(args, result): ToolResultView | undefined
}
```

四个关键设计：

1. **`execute` 返回 canonical value，`output.render` 投影成模型可见的 `ContentBlock[]`**——value 可无损 JSON 快照校验，渲染与执行解耦
2. **schema 白名单投影**：`schemaOf()` 只把 `{name, description, parameters}` 给模型；`timeoutMs`/`isConcurrencySafe` 是宿主元数据，永不泄漏（`index.ts:1256`）
3. **`finalizeContent` 在执行开始时就被快照**（WeakMap），对每个归一化结果恰好调用一次，只能改 content
4. **`isConcurrencySafe` 是"精确 true 才并行"**：未知/隐藏/抛异常一律 exclusive（fail-closed）

## 3. 完整执行流水线（execute 源码走读）

`ToolRuntime.execute(exec)` → `prepareExecution` → `completeScheduledExecution`，五阶段：

### 阶段 A：materialize（策略之前）

- 分配 token、快照+冻结 arguments（`snapshotJsonValue` + `deepFreeze`）
- **collapse 判定**：Code Mode 下模型直接调非 `run_code` → 在策略流水线**之前**确定性拒绝——pre-execute/approval/guard 永远看不到它
- 已取消 → `ABORTED_BEFORE_DISPATCH`

### 阶段 B：pre-execute + guard（策略前门）

```text
1. ctx.waterfall('tools/pre-execute', exec, () => allow)   ← 钩子/审批策略挂这里
2. ask → ctx.approval.request()                            ← 无服务/无 agent → deny
3. guard 链：每个守卫返回 reason 即拒绝，第一个生效       ← 只能减权限
```

### 阶段 C：around dispatch + 函数体

- `ctx.waterfall('tools/execute', mutableExec, () => dispatchToolBody)`——超时策略（`packages/guard/timeout-policy`）就是这里的包装器：读 `timeoutMs` → 造 deadline → **临时替换 `exec.signal`** → `next()`
- 注册表用 `fuseToolSignals(callerSignal, wrapperSignal)` 把两者融合再进函数体：**包装层无法脱离调用方取消**
- 函数体期间 `deferContext()` 收集的上下文合并进结果的 `additionalContexts`

### 阶段 D：post-execute + finalize

- `tools/post-execute` waterfall：`accept` / `accept+value`（重校验重渲染）/ `accept+content`（换内容保 value）/ `block`（变 isError，feedback 即 content）；**value 与 content 不能同时替换**（显式抛 TypeError）
- `materializeFinalResult`（lossless 快照 + freeze，失败→isError）→ `applyFinalContent`（快照的 finalizeContent）→ 再 materialize

### 阶段 E：tools/result（冻结的权威结果）

- 先 `Object.freeze(exec)`，再同步 emit `tools/result`；**观察者异常被隔离，不能变换结果**

::: tip 面试要点：为什么"value 只活在执行期"？
持久化只留 `content/error/meta`。审计日志与回放依赖的是模型可见的内容（content），canonical value 是内部协议。把 value 持久化会导致"模型看到的"与"日志记录的"出现第二真源。这是"模型可见 ⟺ 已记录"不变量在工具层的投影。
:::

## 4. 双轨策略：waterfall + 单调守卫

DSH 把"可扩展"与"不可撤销"分得非常清楚（`docs/subsystems/tools.zh.md:313`）：

| | `tools/pre-execute` waterfall | `ToolGuard` |
|---|---|---|
| 决策 | allow / deny / **ask** | 只能返回拒绝 reason |
| 顺序 | 敏感（监听器顺序影响结果） | 无关（谁先拒绝都一样） |
| 可组合 | 是（可多层包裹） | 否（扁平链） |
| 用途 | 钩子、审批策略 | **owner 策略**（沙箱模式检查等不可绕过的规则） |

为什么需要两套？因为 waterfall 的顺序可以把一个拒绝"翻案"成放行（外层监听器先返回 allow 就短路了）。守卫没有 allow 分支，**注册后顺序无法把拒绝翻回放行**。

## 5. schema DSL：类型安全的工具定义

`defineTool()`（`packages/core/tools/src/schema.ts:545`）是 DSH 最精巧的 API 之一：

```ts
defineTool({
  name: 'bash',
  parameters: {
    command: StringSchemaSpec.required(),        // 必填
    timeoutMs: IntegerValueSchemaSpec,           // 可选
    workdir: StringValueSchemaSpec,
  },
  output: { schema: ..., render: (value) => ContentBlock[] },
  execute: async (args, exec) => { ... },        // args 类型由 parameters 推导！
})
```

- `InferValue<S>` 精确推导到 **16 层容器**后回退 `JsonValue`，避免类型实例化栈耗尽
- 编译是**栈安全的任务图**（防深递归/循环 schema）
- 原始 JSON Schema 只支持 `type/oneOf/properties/required/additionalProperties/items/enum/const` 子集；**不支持的关键字直接拒绝，不静默放行**

::: tip 面试要点：schema 校验发生在哪些边界？
DSH 的校验哲学（根 AGENTS.md）：**信任 TypeScript 的同进程边界，在解析/配置/模型输出/持久化/worker/进程/网络边界做运行时校验**。工具参数来自模型 = 不可信边界，所以有完整的 schema 编译+校验+`INVALID_ARGS` 结构化错误。
:::

## 6. 调度器回顾（与第 01 章联动）

上一章的 `executeToolCalls` 细节在此补全（`packages/core/agent-loop/src/tool-calls.ts`）：

- `executionMode()` 分类：只有 `isConcurrencySafe(args) === true` 才 parallel
- **reclassify**：`fillPool` 每次启动前重读后续调用 mode——注册表/守卫在提交过程中可能变化，后调用变 exclusive 则当前池排空后停在屏障
- exclusive = 顺序屏障；parallel = 滚动池（容量 `maxParallelToolCalls`）
- 模型序提交（`commitReady` 只推进连续前缀槽位）

**为什么这样设计**：策略（pre/guard）必须保序且可等待；函数体可以重叠（LLM 一次发多个并行调用）；reclassify 让策略变更即时生效而不是僵化地按第一眼分类。

## 7. 取消语义的分层

| 场景 | 结果 |
|---|---|
| body 未启动就取消 | `ABORTED_BEFORE_DISPATCH` |
| body 已启动后取消 | 排空到 quiescence 后，成功结果被 `ABORTED` 替换 |
| 已启动的失败 | 保留工具自有结构化错误（`ToolFailure.info` 带 `{name, code}`） |
| 调度器自身失败 | 停止新分发、排空已启动、**不伪造结果**、reject 首个失败 |

关键承认（写在 JSDoc 里）：**注册表无法硬杀同进程代码**。超时只能靠工具合作转发 `exec.signal`。这也是文件系统 IO 刻意不设超时的原因——本地 `fsync`/`rename` 无法被强制中止，超时会是 seam 无法执行的空头支票。

## 8. 工具目录速览

按 Consumer 归族（完整目录见 `docs/tool-catalog.md`）：

| 族 | 工具 | 背后 seam |
|---|---|---|
| 执行 | `bash`、`pwsh`、`run_code` | `ctx.shell` / `ctx.codeRuntime` |
| 文件 | `read`/`write`/`edit`/`read_image`、`glob`/`grep` | `ctx.fs` / `ctx.subprocess` |
| 委派 | `subagent`/`subagent_fork`/`interrupt_agent`/`list_agents`/`send_message`、`workflow`、`ralph` | `ctx.subagents` / `ctx.workflowEngine` |
| 交互 | `ask_user_question`、`exit_plan_mode`、`create_goal`/`get_goal`/`update_goal` | `ctx.userQuestions` / `ctx.goals` |
| 状态 | `todo_write`、`job_kill`/`job_list`/`job_output`、`terminal_*` | `ctx.jobs` / `ctx.terminals` |
| 检索 | `web_search`/`web_fetch`、`lsp`、`session_*`、`skill` | `ctx.web` / `ctx.lsp` |
| 外部 | `mcp__<server>__<tool>` | MCP 桥接 |

## 9. MCP 桥接：外部工具的"一等公民化"

`packages/mcp/mcp-client`：每实例连一个 MCP server（stdio / streamable-http），`tools/list` 发现 → 生成 `ToolDefinition`（公共名 `mcp__<server>__<raw>`，超长/非法字符附 SHA-256 哈希去碰撞）→ 原子换代注册。**MCP 工具走完整流水线**——同样可以被审批、沙箱、守卫管到。这就是"一切皆插件"的威力：外部协议工具与本机工具在策略层面完全平等。

## 10. 面试要点汇总

::: tip 面试要点 1：pre-execute 与 guard 的区别？
瀑布可 allow/deny/ask 且可组合；守卫只能拒绝、顺序无法翻案。owner 策略放守卫。
:::

::: tip 面试要点 2：如何做到 per-agent 工具隔离？
`ScopedLayers`（global + 每 scope 层）+ restriction（`allow`/`deny`）只过滤**继承面**（全局+祖先），**本 scope 自己的注册不受限**——子 agent 保留回报工具靠的就是这个。
:::

::: tip 面试要点 3：给所有工具加审计怎么做？
监听 `tools/pre-execute` 或 `tools/result`（scope 过滤按 agent），**不动 agent-loop**。
:::

::: tip 面试要点 4：为什么工具结果要"freeze 后同步通知"？
`tools/result` 观察者拿到的是冻结的权威结果，异常被隔离。观察者不能改写结果 = 审计与回放确定性。任何想改结果的策略必须回到 post-execute。
:::

下一篇：[03 · 沙箱与权限](/deep-dive/sandbox)，看 Landlock 自限制 launcher 如何用 300 行 C 实现无 root 进程沙箱。
