# 工具系统与沙箱研究笔记

> 研究对象：DeepSeek Harness（DSH）的「工具系统、工具执行管道与沙箱」。
> 仓库：`deepseek-harness`（只读研究，未修改任何文件）。方法：先读中文文档（`docs/tool-execution-pipeline.zh.md`、`docs/subsystems/{tools,sandbox,subprocess,shell,approval,filesystem,permission-presets}.zh.md`、`docs/tool-catalog.zh.md`），再逐包深入源码。所有代码引用均为真实路径与行号，格式 `文件路径:起始行`。
> 本文面向教学博客写作，行文保留源码级证据，便于后续改写。

---

## 1. 概念地图

### 1.1 一句话定位

DSH 是一个 **"一切都是插件"**（基于 vendored Cordis）的 agent harness。工具系统由三层组成：

1. **注册层**：作用域化的 `ToolRuntime`（`packages/core/tools`），按 agent scope 分层注册/遮蔽/限制工具，并把面向模型的 schema 投影进 system prompt。
2. **执行层**：一条 **pre-execute → guard → execute(around) → post-execute → finalizeContent → result** 的流水线，策略以 waterfall 事件插件化挂载，调度以 executionMode 分类（exclusive barrier / parallel rolling pool）。
3. **能力层**：工具本体不直接碰操作系统，而是消费抽象 seam——`ctx.shell`（bash 执行）、`ctx.subprocess`（进程树/PTY）、`ctx.fs`（文件系统）、`ctx.sandbox`（argv 包装）——每个 seam 由 Service Definition / Service Provider / Consumer 三件套组成（capability-seam 惯例）。

沙箱是**进程沙箱**（与宿主共享内核与文件系统）：`ctx.sandbox.confine(argv, policy)` 把原始 argv 包装成 `runner + profile + -- + argv`，由消费方 spawn；Linux 上优先 bwrap，退化到自研 Landlock launcher（native C 二进制）；macOS 用 Seatbelt；Windows 用 ACL 受限令牌 runner。审批（`ctx.approval`）是独立 seam，`allowed-once` 是唯一放行结果。

### 1.2 分层全景

```text
模型 (LLM)
  │  工具调用 tool-call blocks（JSON arguments）
  ▼
System Prompt 组装（tools:sdk / 各工具 schema）      ← ctx.tools.schemas() / systemPrompt.tools()
  ▼
agent-loop 调度器 (packages/core/agent-loop/src/tool-calls.ts)
  │  executionMode(): parallel | exclusive → 分组（barrier / rolling pool）
  ▼
ToolRuntime.execute (packages/core/tools/src/index.ts)
  ├─ tools/pre-execute  waterfall   (允许/拒绝/询问；钩子、权限策略)
  ├─ ToolGuard          单调守卫      (只能拒绝，不能放行)
  ├─ ctx.approval       (ask 决策；allowed-once 才继续)
  ├─ tools/execute      waterfall   (around 包装：timeout/retry/metrics)
  │    └─ 工具函数体 tool.execute(args, exec)
  │         └─ 能力 seam：ctx.shell / ctx.fs / ctx.mcp / ctx.subprocess …
  │              └─ ctx.sandbox.confine(argv, policy)  → 包装 argv → spawn
  │              └─ ctx.subprocess.spawn / spawnTerminal（node-pty）
  │              └─ fs/write-intent、fs/edit-intent（观察策略）
  ├─ tools/post-execute waterfall  (accept / block / replace content|value)
  ├─ ToolDefinition.finalizeContent (定义自有、内容-only 的最后变换)
  └─ tools/result       同步通知（冻结的权威结果）→ 持久化 tool/result 事件 → 回给模型
```

### 1.3 核心概念词典

| 概念 | 含义 | 出处 |
| --- | --- | --- |
| `ToolDefinition` | 一个已注册工具：schema + `output` 契约 + `execute` + 可选 `finalizeContent`/`presentCall`/`presentResult`/`timeoutMs`/`isConcurrencySafe` | `packages/core/tools/src/index.ts:222` |
| `ToolExecutionInput` | 调用方对一次调用的描述（callId/name/arguments/agent/signal/parent） | `packages/core/tools/src/index.ts:314` |
| `ToolExecution` | 注册表物化后的流水线内执行对象（+ token、rootCallId） | `packages/core/tools/src/index.ts:379` |
| `ToolRunContext` | 传给工具函数体的运行时（+ `deferContext`/`concludeTurn`） | `packages/core/tools/src/index.ts:404` |
| `ToolExecutionToken` | 不透明 Symbol 调用身份，仅用于关联与 `parent` 嵌套标记 | `packages/core/tools/src/index.ts:307` |
| waterfall | Cordis 事件分发模式：监听器链依次调用 `next()` 委托，短路即决策 | `docs/cordis-primer.md` |
| `ToolGuard` | 单调守卫：返回 reason 即拒绝，无 allow 结果 | `packages/core/tools/src/index.ts:711` |
| executionMode | `parallel`（可与兄弟重叠）/ `exclusive`（独占屏障） | `packages/core/tools/src/index.ts:344` |
| 能力 seam | SD（Service Definition）+ SP（Provider）+ Consumer 三段 | `docs/glossary.md#capability-seam` |
| `SandboxMode` | `read-only` / `workspace-write` / `danger-full-access`（只管文件效果） | `packages/sandbox/sandbox/src/index.ts:29` |
| `ConfinedArgv` | `confine` 的返回：包装后 argv + enforcement + 方言化失败分类规则 | `packages/sandbox/sandbox/src/index.ts:95` |
| `ApprovalOutcome` | `allowed-once` / `rejected` / `cancelled` / `unavailable`（闭集，失败关闭） | `packages/interaction/user-approval/src/types.ts` |
| `FsWriteIntent` | `createIfAbsent` / `replaceIfVersion`，提供方原子守卫 | `packages/fs/fs/src/types.ts`（见 docs/subsystems/filesystem.zh.md:118） |
| `ToolPresentationMode` | `native` / `code` / `both`：工具如何呈现给模型 | `packages/core/tools/src/index.ts:651` |
| `ToolExecutionMode` | `{kind:'parallel'}` / `{kind:'exclusive'}`，调度分类 | `packages/core/tools/src/index.ts:344` |
| `CollectedOutput` | 一束捕获流：tail 文本 + truncated + spillPath | `packages/subprocess/subprocess/src/types.ts` |
| `scrubbedParentEnv` | 父环境去掉凭据形名与 `DSH_*` 后的基底 | `packages/subprocess/subprocess/src/index.ts:60` |
| `DshEnvironment` | 受管 `DSH_*` 命名空间快照（`${'DSH_'}${string}`） | `packages/subprocess/subprocess/src/types.ts:16` |

### 1.4 一次工具调用的端到端文字时序（以 bash 为例）

```text
T0  部署启动：dsh-tool-bash 插件 apply() → ctx.tools.register(defineTool({name:'bash', ...}))
    （packages/shell/tool-bash/src/index.ts:242）
T1  ctx.tools 构造时注册 ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
    （packages/core/tools/src/index.ts:832）→ 模型请求头里出现 bash 的 name/description/parameters。
T2  模型返回 assistant 消息，内含 tool-call block（bash, {"command": "ls"}）。
T3  agent-loop 解析 arguments（JSON.parse，失败保留原串）→ 构造 ToolExecutionInput（callId=block.id, agent=发起者, signal=步级 signal）
    （packages/core/agent-loop/src/tool-calls.ts:71）
T4  调度器查 ctx.tools.executionMode()（默认 exclusive→单独成组；parallel 进滚动池）
    （packages/core/agent-loop/src/tool-calls.ts:88）
T5  记录持久事件 tool/call（packages/core/agent-loop/src/tool-calls.ts:262）
T6  scheduler.prepare()：materialize 参数（lossless JSON 快照 + deepFreeze）、分配 token
    → tools/pre-execute waterfall（bash 的 sandbox/审批策略可能挂这里）
    → 若 ask → ctx.approval.request()（packages/core/tools/src/index.ts:1689）
    → guard 链（只减权限）
T7  scheduler.dispatch() → tools/execute waterfall（timeout-policy 包装替换 exec.signal，
    packages/guard/timeout-policy/src/index.ts:56）→ 工具体 execute：
    a. validateBashArgs + validateEscalationArgs（tool-bash/src/index.ts:55）
    b. resolveSandboxPolicy（ctx.sandboxPolicy.resolve({session})）
    c. ctx.shell.run(ctx.shell.resolve({command, signal, sandboxPolicy, dshEnv}))
       （tool-bash/src/index.ts:380）
T8  bash 执行器（bash-sandbox 覆写 run）：danger-full-access → 原样 spawn；
    否则 ctx.sandbox.confine(['bash','-c',command], policy)
    → 得到 [bwrap|landlock-run|sandbox-exec, ...profileArgs, '--', 'bash','-c',command]
    → spawn（bash-sandbox/src/index.ts:88；subprocess-local spawn）
T9  子进程层：detached 进程组、collect 模式收集 stdout/stderr（tail-keep + spill 文件）、
    超时/中止 → SIGTERM→grace→SIGKILL 升级（subprocess-local/src/spawn.ts:439）
T10 结果归因：runner 失败 > 命令失败；denial 分类按后端方言匹配 stderr
    （bash-sandbox/src/helpers.ts:81）
T11 工具体返回 canonical value {kind:'foreground', exitCode, stdout, stderr, sandbox,...}
    → 注册表 createSuccessResult：快照 value → 校验 output.schema → render 成 ContentBlock
    → tools/post-execute（可 block/替换）→ finalizeContent → materialize + freeze
T12 notifyResult → tools/result 同步观察者；scheduler.finalize 提交 tool/result 事件
    （agent-loop/tool-calls.ts:151）→ 模型收到结果消息；UI 经 presentResult 渲染 terminal 卡。
```

---

## 2. 模块与文件地图

### 2.1 包总览（按角色）

| 包 | 角色 | 一句话职责 | 关键文件 |
| --- | --- | --- | --- |
| `packages/core/tools` | 注册表+流水线 | `ctx.tools`：作用域化注册、schema 投影、pre/guard/around/post/result 管道、executionMode、Code Mode 传输 | `src/index.ts`（1946 行）、`src/schema.ts`、`src/json-schema.ts`、`src/code-mode.ts` |
| `packages/core/agent-loop` | 调度器 | `tool-calls.ts` 把 tool-call 块按 executionMode 分成 barrier / rolling pool 执行并提交结果 | `src/tool-calls.ts` |
| `packages/core/system-prompt` | 组装 | `systemPrompt.tools()` 收集各 scope 的 ToolProviderResult；工具 section/context 有序渲染 | `src/index.ts:104,424` |
| `packages/core/scope` | 作用域 | `ScopedLayers`：global + 每 scope overlay 链；waterfall 按 agent 路由 | `src/store.ts:159` |
| `packages/sandbox/sandbox` | SD | `SandboxProvider.confine` 抽象、SandboxMode 词汇、escalation 词汇（`approveEscalation`）、writableRoots | `src/index.ts`、`src/escalation.ts`、`src/roots.ts` |
| `packages/sandbox/sandbox-local` | SP | 平台 runner 链：bwrap→landlock（Linux）、seatbelt（macOS）、windows-acl（Windows）；探针+缓存+失败分类表 | `src/index.ts`、`src/profiles.ts` |
| `packages/sandbox/sandbox-policy` | 策略 | `ctx.sandboxPolicy`：默认 mode/root、session 覆盖（`sandbox/mode` 事件折叠）、逐调用 resolve、system prompt context | `src/index.ts`、`src/session-mode.ts` |
| `packages/sandbox/sandbox-windows-acl` | SP 细节 | Windows ACL 受限令牌 runner | - |
| `native/landlock-run` | native | Landlock 自限制后 exec 的 C launcher（静态 musl），按平台发布 | `packages/entry/src/main.c` |
| `packages/shell/shell` | SD | `ShellExecutor`（resolve/run/start）、共享退出状态标记词法 | `src/types.ts`、`src/index.ts:65` |
| `packages/shell/bash-local` | SP | 本地 bash 执行器：默认值补全、deadline/原因分类、ENV_OVERRIDES、后台句柄 | `src/index.ts` |
| `packages/shell/bash-sandbox` | SP | 沙箱化执行器：覆写 run/start，走 `ctx.sandbox.confine`，做 runner/denial 分类 | `src/index.ts`、`src/helpers.ts` |
| `packages/shell/tool-bash` | Consumer | 面向模型的 `bash` 工具：schema、escalation、渲染、后台任务适配 | `src/index.ts`、`src/render.ts`、`src/background.ts` |
| `packages/shell/shell-env` | 环境 | `ctx.shellEnv`：收集受管 `DSH_*` 事实 | `src/index.ts:89` |
| `packages/subprocess/subprocess` | SD | `SubprocessRuntime`：spawn/spawnTerminal/resolveExecutable；`scrubbedParentEnv`、`CollectedOutput` | `src/index.ts:60`、`src/types.ts` |
| `packages/subprocess/subprocess-local` | SP | detached 进程树、tail-keep 收集+spill、树级 SIGTERM→SIGKILL、node-pty 终端 | `src/index.ts`、`src/spawn.ts`、`src/terminal.ts` |
| `packages/fs/fs` | SD | `FileSystem`：resolve/stat/read/write/edit + `fs/*` 事件 | `src/index.ts:86` |
| `packages/fs/fs-local` | SP | 本地磁盘后端（原子写、版本 token） | - |
| `packages/fs/fs-sandbox` | SP | 沙箱化 fs：进程内 policy fence（containment，非内核边界） | `src/index.ts:59` |
| `packages/fs/fs-observation-policy` | 策略插件 | 先读后写/编辑：WeakMap 观测状态 + 单槽意图瀑布决策 | `src/index.ts:21` |
| `packages/fs/tool-fs` | Consumer | read/write/edit/read_image 工具；分发意图事件、emit fs/observed | `src/write.ts`、`src/edit.ts` |
| `packages/interaction/user-approval` | SD | `ctx.approval`：policy（ask/never）、`approval/request` waterfall、审计事件对 | `src/index.ts:192` |
| `packages/interaction/permission-presets` | 组合 | 把 sandbox mode + approval policy 绑成预设，经各自 setter 写入 | `src/index.ts:159` |
| `packages/guard/timeout-policy` | 策略 | `tools/execute` 包装器：声明式 `timeoutMs` 合作式超时 | `src/index.ts:56` |
| `packages/mcp/mcp-client` | 桥接 | MCP server 工具 → `mcp__server__name` 注册进 `ctx.tools` | `src/index.ts:140`、`src/tools.ts:128` |
| `packages/terminal/*` | PTY | `terminal-bash` 后端经 `ctx.subprocess.spawnTerminal`（node-pty）建持久会话 | `terminal-bash/src/index.ts:102` |

### 2.2 依赖链（seam 分层）

```text
tool-bash ──> ctx.shell (ShellExecutor)
                  │  bash-sandbox 继承 bash-local，注入 ['subprocess','sandbox','sandboxPolicy']
                  ▼
             ctx.subprocess (SubprocessRuntime)  ──> node:child_process / node-pty
                  │
             ctx.sandbox (SandboxProvider) ──> sandbox-local: bwrap/landlock-run/seatbelt/windows-acl
```

关键原则：**Consumer 不依赖 Provider 实现**；策略（sandbox/approval/fs-observation）通过事件或独立服务挂接，替换后端不改变工具 schema。

---

## 3. 关键类型与接口（真实类型定义片段）

### 3.1 `ToolDefinition` 与输出契约

```ts
/** A registered tool: its schema plus the execution function. */
interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition          // 必填规范输出声明
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  timeoutMs?: number                              // 合作式超时预算，绝不下发给模型
  isConcurrencySafe?(args: unknown): boolean      // 纯同步分类器，只有精确 true 才并行
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```
（`packages/core/tools/src/index.ts:222`；`output` 定义见同文件 `:212`）

关键语义：
- `execute` 只返回 **canonical lossless-JSON value**；`output.render` 把它投影成模型可见的 `ContentBlock[]`。`value` 只存在于执行期，持久化只留 `content/error/meta`（`index.ts:370` 注释与 `materializeFinalResult`）。
- `finalizeContent` 在**执行开始时就被快照**（`contentFinalizers` WeakMap，`index.ts:810`），对每个归一化结果（含流水线失败）恰好调用一次，只能替换 content。
- `timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult` 是宿主元数据，`schemas()` 白名单只投影 `name/description/parameters`（`schemaOf`，`index.ts:1256`）。

### 3.2 schema DSL 与类型推导

```ts
type ValueSchemaSpec =
  | StringValueSchemaSpec | NumberValueSchemaSpec | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec | NullValueSchemaSpec | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec | JsonValueSchemaSpec | OneOfValueSchemaSpec
```
（`packages/core/tools/src/schema.ts:85`）

- 参数根是**隐式开放对象**：`ParameterSchemaSpec = { [key]: ValueSchemaSpec & { required?: true } }`（`schema.ts:103`）。
- `InferValue<S>` 精确推导到 **16 层容器**后回退 `JsonValue`，避免类型实例化栈耗尽（`schema.ts:153`）。
- `defineTool()`（`schema.ts:545`）：编译参数/输出 schema、绑定 `validateArgs`（`ToolArgsError`/`INVALID_ARGS`）、推导 `execute` 返回类型；`presentCall`/`presentResult`/`isConcurrencySafe` 用**软校验**（回放旧日志参数时失败→回退 generic，不抛错，`schema.ts:598`）。
- 编译是**栈安全**的任务图（防深递归/循环 schema，`runSchemaCompiler`，`schema.ts:275`）。
- 原始 JSON Schema 子集由 `assertSupportedJsonSchema`/`validateJsonSchemaValue` 强制执行（`packages/core/tools/src/json-schema.ts:385,654`）：只支持 `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解；不支持的关键字直接拒绝（不静默放行）。

### 3.3 执行对象族

```ts
interface ToolExecutionInput {          // 调用方拥有
  readonly callId: CallId
  readonly rootCallId?: CallId
  readonly name: string
  readonly arguments: unknown           // 须可 lossless JSON 序列化
  readonly agent?: Agent
  readonly parent?: ToolExecutionToken  // 嵌套分派标记（Code Mode 子调用）
  readonly signal: AbortSignal          // 调用方取消
}
interface ToolExecution extends ToolExecutionInput {  // 注册表物化
  readonly rootCallId: CallId
  readonly token: ToolExecutionToken    // Symbol，仅身份比较
}
interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void  // 上下文挂到本次执行自己的结果上
  concludeTurn(): void                      // 标记成功结果终止当前 turn
}
```
（`packages/core/tools/src/index.ts:314,379,404`）

- `createExecution`（`index.ts:1364`）在策略之前物化参数：`snapshotJsonValue` + `deepFreeze`；非法输入→结构化错误结果。
- `ToolDispatchExecution`（`index.ts:391`）是 `tools/execute` 包装层看到的视图：**可以替换 signal，但不能移除**；注册表在函数体前用 `fuseToolSignals`（`index.ts:1889`）把调用方 signal 与包装 signal 融合，包装层无法脱离调用方取消。

### 3.4 决策与结果类型

```ts
type PreToolDecision =
  | { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
```
（`index.ts:588,597,711`）

- `PostToolDecision` 不能同时替换 value 与 content（`postExecute` 显式抛 TypeError，`index.ts:1757`）。
- 结果闭集：`ToolExecutionSuccess { isError:false, value, content, meta?, additionalContexts?, concludesTurn? }` / `ToolExecutionFailure { isError:true, error: ToolFailure, content, ... }`（`index.ts:556,569`）。
- `ToolFailure.info` 携带 `{ name, code }`（HarnessError），让重试/沙箱/回放按 code 分支（如 `UNKNOWN_TOOL`、`INVALID_TOOL_OUTPUT`、`ABORTED`、`ABORTED_BEFORE_DISPATCH`，`index.ts:469,494,513`）。

### 3.5 沙箱词汇

```ts
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
interface SandboxExecutionPolicy { mode: SandboxMode; workspaceRoot: string; sessionId?: SessionId }
interface SandboxPolicy extends SandboxExecutionPolicy { mode: ConfinedSandboxMode } // 只发受约束模式给提供方
interface ConfinedArgv {
  argv: string[]                    // runner + profile + '--' + 原始 argv
  enforcement: SandboxEnforcement   // 'full' | 'partial'
  denialSignatures: readonly string[]       // 本后端拒绝时的 stderr 方言
  runnerFailureRules: readonly RunnerFailureRule[]  // runner 在命令前失败的结构化证据
}
abstract confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
```
（`packages/sandbox/sandbox/src/index.ts:29,39,69,95,158`）

- `RunnerFailureRule`：`allowedExitCodes?` + `fatalSignatures` + `informationalLines?`（`sandbox/src/index.ts:81`）。分类顺序：退出码门控 → 去掉信息性行 → 逐行匹配致命签名；**退出状态本身永远不足以证明 runner 失败**。
- 升级词汇（`sandbox/src/escalation.ts`）：`WIDER_MODES = { 'read-only': ['workspace-write','danger-full-access'], 'workspace-write': ['danger-full-access'] }`（`:28`）；`approveEscalation`（`:157`）在**任何事执行前**检查严格变宽→审批通道→结果映射，非变宽请求绝不打扰人类。

### 3.6 shell / subprocess 词汇

```ts
interface ShellExecRequest { command; workdir?; timeoutMs?; stdoutMaxBytes?; signal?; stdin?; env?; dshEnv?; sandboxPolicy? }
interface ShellExecSpec   { command; workdir; timeoutMs; stdoutMaxBytes; signal?; stdin?; env?; dshEnv?; sandboxPolicy }
interface ShellRunResult  { exitCode: number|null; signal; timedOut; aborted; timeoutMs; stdout; stderr; sandbox? }
```
（`packages/shell/shell/src/types.ts`，见 docs/subsystems/shell.zh.md:17,68,109）

- **正交结果独立报告**：`timedOut`/`aborted`/`signal`/`exitCode` 各自为字段——进程可以超时且退出码 0（捕获了信号），调用方不会把中断误读为成功（docs/subsystems/shell.zh.md:105）。
- `CollectedOutput { text; truncated; spillPath? }`：截断时 `text` 是**尾部**，完整流溢出到私有文件（`packages/subprocess/subprocess/src/types.ts`，见 docs/subsystems/subprocess.zh.md:27）。
- `SubprocessHandle`：`terminate()` 是唯一终止动词（SIGTERM→grace→SIGKILL，树级）；`waitForExit()` 观察整棵树；collect 模式 reader 是**基于全流字节偏移、不消费**的（多个 reader 不会抢增量，docs/subsystems/subprocess.zh.md:132,176）。
- 环境：`scrubbedParentEnv()` 去掉 `KEY|PASSWORD|SECRET|TOKEN` 与所有 `DSH_*` 后作为基底（`packages/subprocess/subprocess/src/index.ts:44,60`）；显式 `env` 后合并；`dshEnv`（受管 `DSH_*` 快照）最后合并，显式 `undefined` 是删除 tombstone。

### 3.7 审批词汇

```ts
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'  // 闭集，unavailable 也失败关闭
type ApprovalPolicy  = 'ask' | 'never'   // never = 确定性拒绝，不问任何人
interface ApprovalRequest { agent: Agent; toolName: string; callId?: CallId; reason?: string; signal?: AbortSignal }
```
（`packages/interaction/user-approval/src/index.ts:94,153`；Outcome 在 `src/types.ts`）

- 服务 `request()` 前置条件：**必须在开放 turn 内**（审计对 `approval/asked`→`approval/decided` 必须被 turn 包裹，否则崩溃尾会被回放丢弃，`index.ts:127,257`）。
- `never` 策略在服务内部、waterfall 分发之前判定（`index.ts:312`），因此后来 `prepend` 注册的应答者无法绕过。
- 审计事件只进日志、不进模型 transcript；模型通过 runtime-context 快照（system prompt context `approval:policy`，`index.ts:204`）感知策略。

### 3.8 fs 词汇

```ts
type FsWriteIntent =
  | { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }  // 省略=无条件覆盖
type FsObservation =
  | { kind: 'present'; version: FsVersion } | { kind: 'absent' }
```
（docs/subsystems/filesystem.zh.md:118,187；`packages/fs/fs/src/index.ts:58,66,76` 事件声明）

- 三个 `fs/*` 事件：`fs/write-intent`、`fs/edit-intent`（**单槽决策 waterfall**，策略插件占据且不调用 `next()`）、`fs/observed`（同步副作用记录，工具不捕获其异常，监听方必须不抛）。
- `FsErrorCode` 稳定枚举：`FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`FS_SANDBOX_DENIED`（进程内 fence 的策略拒绝，区别于宿主的 `FS_PERMISSION_DENIED`）等（docs/subsystems/filesystem.zh.md:248）。

### 3.9 `ToolSchema` 与 UI 呈现词法

```ts
// 面向模型的最小 schema（llm 包声明）：只有这三字段会进模型请求。
interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>   // 原始 JSON Schema（对象根）
}
```
（`packages/core/tools/src/index.ts:11` 引入；`schemaOf` 投影见 `index.ts:1256`）

- `ToolResult { content: ContentBlock[]; isError: boolean; meta?: JsonValue }`（`index.ts:291`）是 `presentResult` 收到的持久化投影——不含 canonical value。
- 呈现词法（`packages/core/tools/src/presentation.ts`）是 **card 标签的渲染意图联合**：`ToolCallView` = `generic | terminal | diff`；`ToolResultView` = `generic | terminal | diff | search | read | web`。工具自描述 UI，host/client 各自投影；`presentCall/presentResult` 必须是 `args` 的纯函数（直播流与回放都会调）。
- `ToolCallKind`（`'read'|'edit'|'delete'|'move'|'search'|'execute'|'fetch'|'other'`）、`FileLocation`、`FileDiff`、`ReadFileLine` 是共享卡片词法（docs/subsystems/tools.zh.md:459）。

### 3.10 subprocess / terminal 类型细节

```ts
type SubprocessStdinMode  = 'ignore' | 'pipe' | { readonly data: string }   // batch 形状：写完即关
type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect
interface SubprocessCollect { maxBytes: number; spill?: { maxBytes: number } }  // 省略 spill = 只留内存 tail（诊断形状）
interface SubprocessStdio  { stdin; stdout; stderr }   // 全显式，seam 不套默认
interface SubprocessSpawnSpec { argv; cwd; stdio; graceMs; signal?; env? }     // argv 绝不 shell 解释
interface SubprocessOutcome { exitCode: number | null; signal: NodeJS.Signals | null }  // 无原因分类、无输出
```
（`packages/subprocess/subprocess/src/types.ts`，见 docs/subsystems/subprocess.zh.md:39-134）

- 终端原语：`spawnTerminal(spec)` 分配真实控制终端，句柄暴露 `pid/输出/done/write/inspectForeground/signalForeground/terminate`（docs/subsystems/subprocess.zh.md:241）；本地实现经 `node-pty`（`subprocess-local/src/index.ts:161`），提供方负责 UTF-8 传输、前台进程组、信号与 TERM→KILL 全会话停稳；提示符检测/scrollback/持久会话策略归 PTY 消费方（`packages/terminal`）。
- `SubprocessOutputReader.readFrom(fromByte)`：整流字节坐标、不消费、`lossy` 标志 + spill 路径（docs/subsystems/subprocess.zh.md:176）。

### 3.11 工具目录家族速览（tool-catalog 侧写）

`docs/tool-catalog.zh.md` 是**生成**目录（启动真实插件读 `ctx.tools.schemas()`，因为 schema 有运行时展开：枚举、拼接描述、配置决定名称）。按 Consumer 归族：

| 族 | 工具名 | 背后 seam |
| --- | --- | --- |
| 执行 | `bash`（tool-bash）、`pwsh`、`run_code`（Code Mode 传输） | `ctx.shell` / `ctx.codeRuntime` |
| 文件 | `read`/`write`/`edit`/`read_image`（tool-fs）、`str_replace_editor`、`glob`/`grep`（tool-fs-search，spawn 随包的 ripgrep） | `ctx.fs` / `ctx.subprocess` |
| 委派 | `subagent`/`subagent_fork`/`report`/`interrupt_agent`/`list_agents`/`send_message`、`workflow`、`ralph` | `ctx.subagents` / `ctx.workflowEngine` |
| 交互 | `ask_user_question`（tool-ask-user）、`exit_plan_mode`、`create_goal`/`get_goal`/`update_goal` | `ctx.userQuestions` / `ctx.goals` |
| 状态 | `todo_write`、`job_kill`/`job_list`/`job_output`、`schedule_*`、`terminal_*` | `ctx.jobs` / `ctx.terminals` |
| 检索 | `web_search`/`web_fetch`、`lsp`、`session_*`（session-query）、`skill` | `ctx.web` / `ctx.lsp` / `ctx.sessionQuery` |
| 元能力 | `cordis_*`（自引用 cordis 工具集，需显式启用） | `ctx.dynamicCordisRunner` |
| 外部 | `mcp__<server>__<raw>`（每 MCP 实例动态注册） | `ctx.tools` 桥接 |

（表头摘自 docs/tool-catalog.zh.md:26 起的包映射表；`subagent` 与 `subagent_fork` 的 schema 因 `backgroundMode` 配置不同而不同——同包多实例注册不同名。）

### 3.12 作用域路由：`Scoped<T>` 与 `scopeTarget`

- `ScopeKey = object`：agent 对象本身即是作用域键（`packages/core/scope/src/index.ts:15`）。
- 事件/瀑布按作用域路由：`scopeTarget(service, agent)` 产生带 scope 标记的载体；agent-scoped 监听器只收到自己 agent 的调用（`tools/pre-execute` 等事件 JSDoc 标注 `Scope-filtered dispatch (@deepseek-ai/dsh-scope)`）。
- `ScopedLayers`（`store.ts:159`）：`global` 层 + 按需创建的 scope 层；`chainLayers` 沿 `scopeChainOf` 祖先链取现有层（最近者最后）；`effect()` 用 Cordis effect 托管注册生命周期，层空即回收（HMR 安全）。

---

## 4. 执行流程

### 4.1 注册 → 可见性解析 → 进入 system prompt

**注册**（`ToolRuntime.register`，`index.ts:1037`）：
1. 校验 `output { schema, render, presentationMeta? }` 齐全（`index.ts:1040`）、`assertSupportedJsonSchema(output.schema)`、`timeoutMs` 为正有限数。
2. `run_code` 名字全局保留，任何 scope 都不可注册/遮蔽（`index.ts:1054`）。
3. 通过 `ScopedLayers.effect`（`packages/core/scope/src/store.ts:226`）写层：全局 ctx → global 层；agent ctx（`scopeOf(ctx)`）→ 该 agent 的 scoped 层；返回精确 disposer（HMR 安全）。

**作用域可见性**（`view(scope)`，`index.ts:1152`）：
- `chainLayers(scope)` = 全局 + scope 祖先链上的各层（最近者胜，同名遮蔽）。
- `ToolRestriction`（`allow`/`deny`，`index.ts:680`）只过滤**继承面**（全局 + 祖先），**本 scope 自己的注册不受限**——这是委派子 agent 保留回报工具的机制（`index.ts:1137` 注释）。
- 限制取**交集**（链上每层都 `admits` 才可见）。
- Code Mode：`modeFor(scope) !== 'native'` 时，可见表追加保留的 `run_code` 传输（`index.ts:1189`）。

**schema 投影与 prompt**：
- 构造时 `ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))`（`index.ts:832`）；`wireSchemas`（`index.ts:980`）按模式投影：native → 全部 schema；code → 只留 `run_code`；both → 全量 + `run_code`。
- `schemaOf`（`index.ts:1256`）白名单 `{name, description, parameters}`，参数深拷贝快照——回调与 `timeoutMs` 永不泄漏到模型。
- system prompt 侧：`systemPrompt.tools()` 注册 provider（`packages/core/system-prompt/src/index.ts:424`），`ToolProviderResult { schemas, knownNames }`（`:104`）；工具还可注册 section（如 bash 的 `tool:bash` order 105，tool-bash/src/index.ts:236）与 context（如 sandbox:policy order 110、approval:policy order 115）。
- 配置校验：`toolOrder` 里出现 code 模式下不存在的 native 名会失败（knownNames 用途）。

### 4.2 完整执行流水线（`execute` 源码走读）

`ToolRuntime.execute(exec)`（`index.ts:1342`）→ `prepareExecution` → `completeScheduledExecution`。

**阶段 A：materialize（`createExecution`，`index.ts:1364`）**
- 分配 token、解析 `rootCallId`、快照+冻结 arguments。
- **collapse 判定**：`mode === 'code'` 且模型直接调非 `run_code` → 在策略流水线**之前**确定性拒绝（`ToolNotFoundError` 带路由提示），pre-execute/approval/guard 永不看到它（`index.ts:1373` 注释）。已取消则给 `ABORTED_BEFORE_DISPATCH`。
- 捕获 `finalizeContent` 快照（参数 getter 可能在 materialize 中替换回调，先捕获保真）。

**阶段 B：pre-execute + guard（`prepareExecution`，`index.ts:1463`）**
1. 调用方已取消 → `ABORTED_BEFORE_DISPATCH`。
2. `ctx.waterfall('tools/pre-execute', exec, () => allow)`（按 agent scope 路由，`scopeTarget`）。
3. `ask` → `serviceAsk`（`index.ts:1689`）：`ctx.get('approval')` 可选消费——无 approval 服务/无 agent → deny（可区分文案）；outcome 一对一映射。
4. `guardReason`（`index.ts:1119`）：全局层 + 该 agent 链上每层守卫，第一个 reason 即拒绝；守卫**没有 allow 分支**，顺序无法把拒绝翻回放行。
5. 拒绝 → `post-result`（仍走 post-execute，内容 `Error: <reason>`）；通过 → `dispatch`。

**阶段 C：around dispatch + 函数体（`dispatchScheduledExecution`，`index.ts:1569`）**
1. `ctx.waterfall('tools/execute', mutableExec, () => dispatchToolBody)`。
2. `dispatchToolBody`（`index.ts:1532`）：`fuseToolSignals(callerSignal, wrapperSignal)` → 命中已取消则不启动函数体；`resolveExecution`（name 可见性 + collapse 判定）→ `tool.execute(args, exec)` → `createSuccessResult`（快照 value → `validateJsonSchemaValue(output.schema)` → `output.render` → 快照 content → 顶层调用时 `presentationMeta`）。
3. 函数体期间 `deferContext` 收集到 `deferredContexts`；结果合并进 `additionalContexts`（`index.ts:1578`）。
4. 包装层返回非 canonical 结果时 `normalizeDispatchResult`（`index.ts:1826`）重新走输出契约校验。

**阶段 D：post-execute + finalize（`finalizeScheduledExecution`，`index.ts:1609`）**
1. `ctx.waterfall('tools/post-execute', exec, result, () => accept)`（`postExecute`，`index.ts:1742`）：block → 变 `isError`（feedback 即 content）；accept+value → 重校验重渲染；accept+content → 保留 canonical value 换 content；可附加 `additionalContexts`。
2. `finishScheduledExecution`（`index.ts:1631`）：`materializeFinalResult`（lossless 快照 + deepFreeze，失败→isError）→ `applyFinalContent`（快照的 finalizeContent，只换 content）→ 再 materialize → `notifyResult`。

**阶段 E：tools/result（`notifyResult`，`index.ts:1657`）**
- 先 `Object.freeze(exec)`，再同步分发 `tools/result` emit；观察者异常被隔离（仅日志），**不能变换结果**。

**取消语义**：body 未启动 → `ABORTED_BEFORE_DISPATCH`；body 已启动 → 排空到 quiescence 后用 `ABORTED` 替换成功结果（`cancellationResult`，`index.ts:1518`）；已启动的失败保留工具自有结构化错误。

### 4.3 调度器：exclusive barrier / bounded rolling pool / reclassify

`executeToolCalls`（`packages/core/agent-loop/src/tool-calls.ts:59`）：
- 对每个 pending call 调 `ctx.tools.executionMode(exec)`（`index.ts:1276`）：只有 `isConcurrencySafe(args) === true` 才 parallel；未知/隐藏/抛异常 → exclusive（fail-closed）。
- **exclusive 形成顺序屏障**（`group = [first]`）；**parallel 进滚动池**，容量 `ctx.agentLoop.config.maxParallelToolCalls`（`tool-calls.ts:132`）。
- **reclassify（重分类）**：`fillPool` 每次启动前重读后续调用的 mode（`tool-calls.ts:203`）——注册表/守卫在提交过程中可能变化，若某个后调用变成 exclusive，则当前池排空后停在屏障处，等下一轮 group（`tool-calls.ts:204`）。
- **模型顺序提交**：`commitReady` 只推进连续的前缀槽位（`tool-calls.ts:146`），dispatch 可重叠，但结果与附加上下文按模型顺序写日志/注入。
- 取消：停止补池 → 排空已启动 → 为未启动调用写合成 `ABORTED_BEFORE_DISPATCH` 结果（保证回放完整，`tool-calls.ts:237,249`）。

**为什么这样设计**：策略（pre/guard）必须保序且可等待，函数体可以重叠（LLM 一次发多个并行调用）；滚动池限制了并发上限（bounded）；reclassify 使策略在提交间隙的变更也能即时生效，而不是僵化地按第一眼分类。

### 4.4 bash：模型调用 → 进程 → 结果回模型

1. **schema**：`defineTool({name:'bash', parameters:{command, description, timeoutMs, workdir, run_in_background?, sandbox_permissions?, justification?}, output: oneOf[background|foreground]})`（`tool-bash/src/index.ts:242`）；沙箱字段只有在**沙箱化执行器**存在时才出现（`escalationModes` 非空，`index.ts:193,259`）。
2. **execute**（`index.ts:330`）：
   - `validateBashArgs` + `validateEscalationArgs`（`sandbox_permissions` 必须配 `justification`，非空句）。
   - 若请求升级：`approveBashEscalation` → `approveEscalation`（严格变宽 + `ctx.approval`，`index.ts:213`）→ 把 granted mode 盖到**本次调用**的 policy 上。
   - `resolveSandboxPolicy`：`ctx.sandboxPolicy.resolve({session})`（`index.ts:199`）——会话 cwd 即 workspace 边界。
   - `ctx.shellEnv.collect(exec)` 收集 `DSH_*` 快照。
   - 后台：`ctx.jobs.start(...)`，`run` 内 `ctx.shell.start(ctx.shell.resolve(request))`，返回 `{kind:'background', jobId}`（`index.ts:349`）。
   - 前台：`ctx.shell.run(ctx.shell.resolve({...request, signal: exec.signal}))`（`index.ts:380`）；`result.aborted` → 抛 `TOOL_ABORTED` 结构化错误（body 已启动的取消路径）。
3. **executor 侧**（bash-sandbox 覆写，`bash-sandbox/src/index.ts:88`）：
   - `danger-full-access` → `super.run` 原样 spawn。
   - 受限模式 → `this.confine(command, policy)` = `ctx.sandbox.confine(['bash','-c',command], policy)`（`:177`）→ `runArgv` spawn 包装 argv。
   - spawn 拒绝分类：`isRunnerSpawnFailure`（ENOENT/EACCES + error.path===argv[0] + cwd 可用）→ 抛 `SANDBOX_UNAVAILABLE`（runner 缺失，命令没跑）。
   - 结算分类（`onProcessDone`，`:150`）：runner 失败 > denial；denial 按本后端 `denialSignatures` 匹配非零退出的 stderr。
4. **渲染回模型**（`tool-bash/src/render.ts:28`）：`renderResult` = stdout + `[stderr]` 标记段 + 标记行（`[sandbox: file access denied under <mode> mode]`、`[timed out after Nms]`、`[killed by signal: X]`、`[exit code: N]`）；非零退出**不**视为错误（模型自己决定反应），只有基础设施失败（spawn 失败/abort）才是 `isError`。截断时追加 `[output truncated; full output: <spillPath>]`。
5. **UI**：`presentCall` → terminal 卡；`presentResult` 用 `parseExitStatus` 把 `[exit code: N]` 拆成退出状态 pill（`tool-bash/src/index.ts:124`，词法归 `dsh-shell` 所有，pwsh 复用）。

### 4.5 沙箱决策点与 argv 包装

`sandbox-local`（`packages/sandbox/sandbox-local/src/index.ts`）：
1. **平台链**：`PLATFORM_CHAINS = { linux: ['bwrap','landlock'], darwin: ['seatbelt'], win32: ['windows-acl'] }`（`:159`）。
2. **选择**：单一候选**不探测**直接用（执行时拒绝仍 fail-closed）；多候选按序**功能探测**（`defaultProbeBwrap`/`defaultProbeLandlock`/`defaultProbeSeatbelt`，`:68,85,100`）——探测结果缓存于 provider 生命周期（`:265`）。
3. **包装**（`confine`，`:316`）：`bwrapProfileArgs`（`--ro-bind / / + --dev /dev --proc /proc --die-with-parent`，workspace-write 加 `--tmpfs /tmp --bind <root> <root>`，`profiles.ts:16`）；`landlockProfileArgs`（`--ro /` + `--rw /dev/null[/tmp,workspace]`，`profiles.ts:30`）；`seatbeltProfileArgs`（SBPL：`(deny file-write*)` + 白名单 subpath，根来自共享 `writableRoots`，`profiles.ts:51`）。
4. **enforcement 报告**：bwrap/seatbelt 恒 `full`（构造性）；landlock 由探针区分 ABI（`full`/`partial`）；windows-acl 恒 `partial`（Everyone 限制 + NTFS 硬链接边界，`:177`）。
5. **失败分类方言**：`DENIAL_SIGNATURES = { bwrap:['read-only file system'], landlock:['permission denied'], seatbelt:['operation not permitted'], 'windows-acl':['access is denied',...] }`（`:205`）；`RUNNER_FAILURE_RULES`（landlock：exit 125 + `landlock-run: ` 致命行，`:231`）。

**Landlock launcher**（`native/landlock-run/packages/entry/src/main.c`）：
- 纯 C11 + 静态 musl，自包含 Landlock UAPI（`:58`）；`landlock-run [--ro <path>]... [--rw <path>]... -- <argv>...`。
- `restrict_self`（`:230`）：协商 ABI（MAX_ABI=5）→ 建 ruleset → path-beneath 规则（文件路径只保留文件兼容位）→ `PR_SET_NO_NEW_PRIVS`（抑制 setuid 提权）→ `landlock_restrict_self` → `execvp`。规则集跨 `execve` 继承，所以**命令及其全部后代**都被限制，而宿主进程不受影响。
- **fail-closed**：内核不支持/不执行 Landlock → 打印 `landlock-run: ...` 退出 125，**绝不裸 exec**（`:235`）；旧 ABI 部分执行 → stderr 报告 `partial enforcement (older Landlock ABI)`（`:292`）但继续运行。
- `--probe`（`:269`）在短命进程里真实安装最大 ruleset——「版本号探测」会漏掉有 syscall 但拒绝执行的核。

**fs 侧 fence**（`packages/fs/fs-sandbox/src/index.ts:59`）：`writeText/editText` 覆写为 `checkedTarget`（`:126`）：`read-only` 拒绝；`workspace-write` 对**当前**规范路径做 `writableRoots` containment（重新 resolve 捕获并发替换的 symlink 祖先，`:136`）；拒绝抛 `FS_SANDBOX_DENIED`（无需文本推断——进程内 fence 精确知道拒绝了什么）。文档明言这是 **trusted-code containment，不是内核安全边界**（`:10`）。

### 4.6 审批与升级

- `ctx.approval.request`（`user-approval/src/index.ts:257`）：检查开放 turn → 追加 `approval/asked` → `decide`（`never` 直接 rejected；否则 `ctx.waterfall('approval/request', req, () => 'unavailable')`，异常/非法返回值归一为 `unavailable`；signal abort → `cancelled` 且丢弃迟到答案）→ 追加 `approval/decided` → 返回。
- 应答者（UI、ACP 自动化）通过监听 `approval/request` 实现：负责任则返回 outcome，否则 `next()` 委托；第一个应答占据唯一决策槽。
- 消费方约定：非 `allowed-once` 一律拒绝（tools 的 `serviceAsk`、bash 的 `approveBashEscalation` 均如此）。
- **升级（escalation）**是沙箱特有路径：模型被拒后带 `sandbox_permissions + justification` 重试同一命令 → 工具层在**执行前**调 `approveEscalation`（严格变宽检查 → 审批 → `allowed-once` 才授权本次调用）；拒绝/取消/无通道都抛对应错误文案进 `isError`。权限预设（`permission-presets`）把 mode+policy 绑成 `workspace-write`/`danger-full-access` 预设，`set()` 经各自规范 setter 写入（docs/subsystems/permission-presets.zh.md:64）。

### 4.7 fs seam：意图瀑布与观测

`tool-fs` write 路径（`packages/fs/tool-fs/src/write.ts`）：
1. `sandbox.resolvePolicy('write', args, exec)`（升级可把 policy 盖宽）。
2. `ctx.fs.resolve(filePath, ...)` → `FsTarget`。
3. `ctx.waterfall('fs/write-intent', target, exec, () => undefined)`（`:111`）——策略插件（fs-observation-policy）占据单槽，返回 `FsWriteIntent`（未观测/缺失→`createIfAbsent`；已观测→`replaceIfVersion`，`fs-observation-policy/src/index.ts:65`）。
4. `ctx.fs.writeText(target, content, intent, exec.signal, sandboxPolicy)`（`:114`）——提供方在**原子变更临界区**内做版本守卫/无覆盖检查（陈旧→`FS_STALE_VERSION`）。
5. 成功后 `ctx.emit('fs/observed', target, {kind:'present', version}, exec)`（`:122`）；读取路径在返回前 emit 观测（read.ts:162），缺失在报 `FS_NOT_FOUND` 前 emit `absent`（read-target.ts:27）——观测状态是 `WeakMap<owner, Map<targetKey, FsObservation>>`，owner 从事件 actor 的 `agent.session` 推导（`:36`）。
6. 没有该策略插件时，意图瀑布默认 `undefined` = 裸提供方无条件写——**策略是可选插件，不改变 schema**（docs/subsystems/filesystem.zh.md:7）。

### 4.8 MCP 桥接

`mcp-client`（`packages/mcp/mcp-client/src/index.ts:140`）：每实例连一个 MCP server（stdio / streamable-http），`tools/list` 发现 → `syncTools`（`src/tools.ts:128`）两阶段：先取全量生成 `ToolDefinition`（公共名 `mcp__<serverName>__<rawName>`，超 64 字符/非法字符时附 SHA-256 哈希去碰撞，`:96`），再原子换代注册（冲突回滚）。`execute` 把参数发 `tools/call`（raw name，带 `exec.signal` + timeout），结果映射 `{content, structuredContent}` 进 canonical output；MCP `isError:true` → throw → 注册表转成 isError 结果。MCP 工具同样走完整流水线（可被审批/沙箱/守卫管到）。

### 4.9 超时与取消的 deadline 机制（`dsh-timeout`）

bash 前台与工具超时共用同一套 deadline 库：
- `deadline(signal, timeoutMs, code)` 把「调用方取消」与「执行器超时」融合成一个 deadline；`timeoutOf(signal, code)` 用它自己的 code 判定**是不是本层超时**（`bash-local/src/index.ts:225` 的 `runArgv`：`using d = deadline(...)` 语法确保清理 timer）。
- 原因分类单点：`timedOut` = 本执行器 timeout code 命中；`aborted` = deadline aborted 且非本层超时——两者互斥（docs/subsystems/shell.zh.md:109 的 first-cause 约定）。
- 工具级超时（`timeout-policy`，`packages/guard/timeout-policy/src/index.ts:56`）是 `tools/execute` 包装器：读 `ctx.tools.get(name).timeoutMs`（无则 `next()` 直通）→ 造 deadline → **临时替换 `exec.signal`** → `next()`（函数体看到的是 deadline）→ 恢复上游 signal（post-execute 监听者绝不看到 timeout 已中止的 signal）→ 若本层 code 命中，用 `TOOL_TIMEOUT` 结构化结果替换返回值。合作式：工具必须转发 `exec.signal` 才能在超时后到达 quiescence——注册表**无法硬杀同进程代码**（`ToolDefinition.execute` JSDoc）。
- 文件系统 IO **刻意不设超时**：`fs.read/write/edit` 不接受 `timeoutMs`，因为本地系统调用无法被超时强制中止（`fsync`/`rename` 进行中），超时会是 seam 无法执行的截止时间（docs/subsystems/filesystem.zh.md:272）。这一不对称本身就是「显式优于隐式」的注脚：不承诺无法强制的东西。

### 4.10 Code Mode：`run_code` 子分派如何重入流水线

- `createRunCodeTool`（`packages/core/tools/src/code-mode.ts:24`）构造保留传输 `run_code`：schema 的 description/parameters 随 `ctx.codeRuntime.language` 变化（`peekRuntime`，`index.ts:928`）。
- 模型直接调用 `run_code` → 传输 execute 启动一个程序（worker 线程 runtime）；程序内经生成 SDK（`renderToolsSdk`/`renderToolsSdkPy`）binding 每个可见工具。
- SDK 子调用 = 一次**嵌套分派**：带 `parent` token（外层执行的 token，`index.ts:327` 注释）→ `ctx.tools.execute` 走**完整** pre/guard/around/post 流水线；`rootCallId` 保持外层根调用。
- 嵌套调用的语义差异：只带 parent 的子调用不受 collapse 限制（`collapses(name, scope, nested)`，`index.ts:1324`——`nested=true` 时不做 code 折叠）；`presentationMeta` 只对**直接顶层**调用计算（`index.ts:1806`）。
- 结果记录：每个子分派写 `tool/code-dispatch-start` + `tool/code-dispatch` 事件对；`tools/code-dispatch-log` waterfall（`index.ts:189`）允许**只改持久副本**的 content（如 spill 策略把超大结果换成预览+定位），程序拿到的 `value` 与模型可见内容都不受影响；监听者抛异常 → 回退原 content（`shapeDispatchLog`，`index.ts:1296`）。
- 子分派并发遵守原生契约：`isConcurrencySafe` 分类 + `maxParallelSubCalls`（默认 10，`index.ts:774`）滚动池。

### 4.11 PTY 持久终端流程（`packages/terminal`）

- `tool-terminal` 六个工具（`terminal_open/read/send/signal/list/close`）是**可选启用**的持久会话补充（docs/tool-catalog.zh.md 包映射表）。
- `terminal-bash` 后端（`packages/terminal/terminal-bash/src/index.ts:102`）：`spawn` 时先 `ensureSandboxModeFence`（`ctx.sandboxPolicy.resolve({session})` 解析 policy）→ `spawnArgv`（沙箱化时经 `ctx.sandbox.confine` 包装 argv，`:123`）→ `ctx.subprocess.spawnTerminal({argv, cwd: policy.workspaceRoot, env, rows, cols, graceMs, signal})`（`:125`）→ `LocalPtySession`（`initialize` 等就绪）。
- 子进程层 `spawnTerminal`（`subprocess-local/src/index.ts:161`）：`nodePty.spawn(file, args, {name:'dumb', rows, cols, cwd, env: childEnv(...)})`；句柄经 `LocalTerminalHandle` 暴露写/前台检查/信号/TERM→KILL。
- 分权：**提供方管终端分配与文本传输**（UTF-8、前台进程组、信号、全会话停稳），**消费方管提示符检测、就绪推断、scrollback、沙箱策略与持久会话所有权**（docs/subsystems/subprocess.zh.md:241）。后台 `terminal_send` 同样注册 `ctx.jobs`。

### 4.12 权限预设切换流程（permission-presets）

1. 预设表 `{ name: PresetSpec { sandbox: SandboxMode; approval: ApprovalPolicy; name?; description? } }`，默认含 `workspace-write`（workspace-write+ask）与 `danger-full-access`（danger-full-access+never）（docs/subsystems/permission-presets.zh.md:13）。
2. `current(events)` **派生**生效预设：折叠生效 sandbox mode（会话覆盖→执行器默认）与生效 approval policy（会话覆盖→服务默认→ask），优先仍匹配的已记录选择，否则第一个匹配表项，否则 `custom`（派生值，非切换目标，不进事件 payload）。
3. `set(session, name)`：解析预设（未知抛错）→ 若尚未生效则追加**仅日志** `permission/preset` 事件（保住两个预设共享同一 knob 组合时的用户意图）→ 经各 knob 规范 setter 写入（`ctx.sandboxPolicy` 的 `setSandboxMode` + `ctx.approval` 的 `setApprovalPolicy`），仅当该 knob 生效值变化才写。
4. 模型可见后果由 knob 事件经各自消费方承担（system prompt 的 `sandbox:policy` / `approval:policy` context）；`permission/preset` 本身不进 transcript，回放只需折叠最后一条。

---

## 5. 设计模式与权衡

### 5.1 可扩展 waterfall + 单调 guard 双轨策略
- **模式**：策略分两类。`tools/pre-execute` 是可重排、可 short-circuit 的瀑布（`allow/deny/ask`），钩子与审批策略挂这里；`ToolGuard` 是注册后**只能拒绝**的单调守卫，弥补「瀑布顺序可能把拒绝翻回放行」的缺陷（docs/subsystems/tools.zh.md:313）。
- **权衡**：瀑布灵活（可 ask、可组合）但顺序敏感；守卫僵硬但不可绕过（owner 策略如沙箱模式检查放守卫）。代价是两套机制并存，心智负担略高；收益是「可扩展」与「不可撤销」分得很清楚。

### 5.2 能力 seam 三段式（SD / SP / Consumer）
- **模式**：每个能力 = Service Definition（抽象类 + 类型词汇）+ Service Provider（平台实现）+ Consumer（模型工具）。bash 有三个包（`shell`/`bash-local`/`tool-bash`），沙箱同样三件。
- **权衡**：替换后端（本地→E2B/容器/microVM）不动工具 schema；代价是包多、层级深，调试要跨包跳。DSH 仓库规则明确禁止「一个 Consumer 说了算的服务契约」。

### 5.3 显式优于隐式：request/spec 拆分
- **模式**：`ShellExecRequest`（模型/插件视角，可选字段）→ `ctx.shell.resolve()` → `ShellExecSpec`（完全解析、必填、已封顶）。`SubprocessSpawnSpec` 更是零默认值（每个 disposition/limit 显式给出，docs/subsystems/subprocess.zh.md:89）。
- **权衡**：调用方配置自己说了算，没有隐藏默认值；代价是每个消费方必须自己调 `resolve`（代码多几行），并且容易漏调——DSH 用类型（`run` 只收 spec）强制该约定。

### 5.4 无损 JSON 物化边界与不可变快照
- **模式**：参数过 `snapshotJsonValue` + `deepFreeze` 一次（策略前）；函数体返回值快照+校验+渲染；最终结果再 materialize + freeze 后才给 `tools/result` 观察者（`index.ts:1847`）。canonical `value` 只活在执行期，持久化只有 content/error/meta。
- **权衡**：杜绝了钩子改写参数/结果造成的审计漂移与回放不一致（「模型可见 ⟺ 已记录」）；代价是额外快照拷贝的开销与「展示投影必须纯函数」（回放可重算）。

### 5.5 fail-closed 无处不在
- 无沙箱后端 → `SANDBOX_UNAVAILABLE`，**绝不裸跑**（`SandboxUnavailableError` 文案直接教用户装 bwrap，`sandbox/src/index.ts:131`）；Landlock 内核不执行 → 退出 125 不 exec（`main.c:235`）；无审批通道 → `unavailable` 按拒绝处理；`isConcurrencySafe` 非精确 true → exclusive；`executionMode` 抛异常 → exclusive；`runnerFailureSignatures` 缺配置 → 加载即报错。
- **权衡**：安全侧保守，代价是可用性侧偶发「该通的没通」（如隔离缺失时危险模式请求被拒），需要清晰的错误文案让模型学会重试/升级。

### 5.6 方言化的失败分类（denialSignatures / runnerFailureRules）
- **模式**：每个后端带自己的 stderr 方言（bwrap 的 EROFS、Landlock 的 EACCES、Seatbelt 的 EPERM），消费方只按**本后端**签名分类，而不是跨后端并集（`ConfinedArgv.denialSignatures` 注释，`sandbox/src/index.ts:100`）；runner 失败用结构化规则（退出码门控 + 致命行 + 信息行排除）与 denial 区分。
- **权衡**：分类准确（不会把 bwrap 的 EROFS 误判成 Landlock 的 EACCES），但每个新后端都要维护自己的方言表与规则（`RUNNER_FAILURE_RULES` 就是三份手工契约）。

### 5.7 作用域层（ScopedLayers）与委派
- **模式**：注册表按 `ScopeKey`（agent 对象）分层，`chainLayers` 祖先链合并；restriction 只滤继承面、不滤自己的注册——委派子 agent 保留回报工具；`tools/change` 全局通知让每个 scope 的下一次组装都重算。
- **权衡**：per-agent 隔离精确（子 agent 看不到父的工具，除非继承），代价是「可见性解析」是每次 O(层数) 的遍历，且层模型（global/ancestor/own）需要仔细的注释才能讲清（`index.ts:1137` 那段长注释本身就是复杂度证据）。

### 5.8 取消信号融合（fuseToolSignals）
- **模式**：around 包装层可以替换 `exec.signal`（如 timeout 的 deadline），但注册表把调用方 signal 与包装 signal **融合**后再进函数体，取消后包装层**无法脱离调用方取消**；且从不放弃已启动的 promise（排空到 quiescence）。
- **权衡**：保证「调用方 abort 一定生效」的强契约，代价是融合逻辑（`AbortController` 转发 + 一次性监听）与「不能硬杀同进程代码」的承认——超时只能靠工具合作（`exec.signal`）。

### 5.9 Code Mode：一种「演示层」而非第二种工具系统
- **模式**：`run_code` 是保留传输，模型只能直接调它；其他工具经生成的 SDK（TS/Python 渲染器，`ts-types.ts`/`py-types.ts`）在程序内以子分派调用，子分派**重新进入完整流水线**（`parent` token 标记 + `tool/code-dispatch` 事件），concurrency 契约照旧（`maxParallelSubCalls`）。
- **权衡**：让模型写程序而非逐次调工具（token 效率/上下文优势），代价是 prompt 组装复杂度（collapse section + SDK section）与「collapse 判定必须与提示文案同一谓词」的一致性要求（`collapses` 与 `CODE_ONLY_INSTRUCTION`）。

### 5.10 「模型可见 ⟺ 已记录」：日志即真相
- **模式**：任何进入模型请求的输入必须能从 session log 重建（AGENTS.md 惯例）；工具参数在 `tool/call` 记录后才进策略（`prepare` 之前，agent-loop/tool-calls.ts:167 与 index.ts 流水线顺序）；canonical value 不持久化，但 `content/error/meta` 与展示投影全部落 `tool/result`，回放可重建 UI 卡片。
- **权衡**：审计与回放完美，代价是「参数不可改写」——`PreToolDecision` 明确排除输入重写（docs/subsystems/tools.zh.md:402），因为改写会破坏历史/审计/UI/执行四者一致；需要改写的策略只能 block 后用 `additionalContexts` 引导模型重试。

### 5.11 策略状态用「事件折叠」而非可变全局
- **模式**：会话级覆盖（`sandbox/mode`、`approval/policy`、`permission/preset`）都是**追加进 session log 的事件**，读取时从尾部折叠（`effectiveSandboxMode`/`effectiveApprovalPolicy`，`sandbox-policy/src/session-mode.ts`、`user-approval/src/index.ts:112`）。回放日志即重放状态，无需追赶机制；策略切换不动稳定 system prompt 缓存前缀（追加新的 runtime-context 快照）。
- **权衡**：单一事实源、HMR/回放安全；代价是每次读取都要折叠（O(事件数) 最坏），且「最后一条事件」语义要求写入必须经规范 setter（`setApprovalPolicy` 是唯一写路径，`user-approval/src/index.ts:142`）。

### 5.12 工具结果「双投影」：canonical value 与 model content 分离
- **模式**：`execute` 返回结构化 canonical value；`output.render(args, value)` 是纯函数投影成 `ContentBlock[]`；`presentationMeta` 是另一份仅供 UI 的投影。策略可替换 content（展示层）或 value（会重校验重渲染），但不能同时（`index.ts:1757`）。
- **权衡**：模型拿到的是经过 schema 校验+渲染的稳定文本，程序化数据不泄给模型；代价是 render 必须对**任意** value 全函数（含错误路径），且替换 value 要重走一遍校验——post-execute 的 value 替换被有意限制为成功结果（`index.ts:1765`）。

---

## 6. 面试要点

### 6.1 概念题
1. DSH 工具注册表如何做到 per-agent 隔离？（ScopedLayers + restriction 只滤继承面 + scoped 注册遮蔽全局；`view()` 一次遍历产出 visible/knownNames/restrictableNames。）
2. `tools/pre-execute` 与 `ToolGuard` 的区别？（瀑布可 allow/deny/ask 且可组合；守卫只能返回拒绝 reason，顺序无法翻案；owner 策略放守卫。）
3. `executionMode` 三要素？（exclusive barrier / parallel rolling pool / 提交间隙 reclassify；只有 `isConcurrencySafe(args)===true` 才并行，其余 fail-closed。）
4. 沙箱三模式语义？（只管文件效果：read-only / workspace-write（workspace 根 + 平台临时区）/ danger-full-access（消费方直接裸 spawn，不调 confine）。）
5. 为什么 `SandboxPolicy` 不包含 `danger-full-access`？（`ConfinedSandboxMode` 排除之；只有前两种模式发给提供方，见 docs/subsystems/sandbox.zh.md:23。）

### 6.2 源码题
1. 工具结果如何回模型？（canonical value → `output.render` → ContentBlock → post-execute → finalizeContent → materialize+freeze → `tool/result` 事件 → agent-loop `createToolResultMessage` 注入会话。）
2. `[exit code: N]` 标记在哪生成/解析？（`dsh-shell` 拥有词法 `parseExitStatus`；`tool-bash/render.ts:28` 生成，`presentResult` 解析成 pill。）
3. Landlock launcher 为什么退出 125？（`EXIT_LAUNCHER_FAILURE`，命令本身不太可能用 125，executor 借此区分 launcher 失败与命令失败；`main.c:112`。）
4. 审批「allowed-once」如何防重放？（每次 `request` 新发 `ApprovalRequestId`，只授权所问的那一个操作；工具层把 granted mode 只盖到本次调用 policy，不写入会话。）
5. 先读后写如何实现？（fs-observation-policy 的 WeakMap 观测 + `fs/write-intent` 单槽瀑布返回 `createIfAbsent`/`replaceIfVersion`；版本守卫在提供方原子临界区内执行，陈旧→`FS_STALE_VERSION`。）

### 6.3 场景题
1. 模型在 read-only 沙箱里写文件被拒，如何设计重试？（拒绝标记 `[sandbox: file access denied under read-only mode]` + 升级提示 → 同命令带 `sandbox_permissions`（枚举 `['workspace-write','danger-full-access']`）+ `justification` 重试 → 工具层先验严格变宽再走审批，`allowed-once` 才执行。）
2. 如何给所有工具加「每次调用审计日志」？（`tools/pre-execute` 或 `tools/result` 监听器，scope 过滤按 agent；不要动 agent-loop。）
3. 子 agent 被委派后如何只给它部分工具？（在子 agent 的 scope（或委派预设的 agent.ctx）里 `ctx.tools.restrict({allow:[...]})`——限制只滤**继承面**（全局+祖先），子自己的注册不受限，所以它的回报/结构化输出工具还在；restrict 要求 scoped context，全局 context 上调用会抛错。）
4. 新平台加沙箱后端要动哪里？（`PLATFORM_CHAINS` + `STATIC_ENFORCEMENT` + `DENIAL_SIGNATURES` + `RUNNER_FAILURE_RULES` + `probeRunner`，消费方零改动。）
5. `danger-full-access` 模式为什么也要先 `resolve()` 出 policy？（策略是逐调用完整解析的，包含该模式；消费方一次解析后再决定绕过或约束，root 总带着走——见 `SandboxExecutionPolicy` 注释，sandbox/src/index.ts:34。）
6. 为什么 `finalizeContent` 收 `unknown` 类型参数而 `execute` 收推导类型？（非法输入与流水线失败也会到达 finalizer，它不能假设参数已通过 schema——`defineTool` 的 finalizeContent 签名就是 `Readonly<ToolExecution>`，见 schema.ts:522。）
7. `tools/result` 观察者为什么不能改结果？（结果已在分发后 materialize + freeze（`notifyResult` 前 `Object.freeze(exec)`，index.ts:1657）；观察者失败被隔离仅记日志，避免「观察者把已提交结果改坏」。）

### 6.4 追问链示例（博客可用的进阶问题）

1. 「工具 A 与工具 B 并行，但 B 想等 A 的结果」→ 不能靠调度器；`isConcurrencySafe` 只承诺**不互斥**，组合语义要自己实现（或把 B 分类为 exclusive 形成屏障）。
2. 「如何统计每次工具调用的耗时」→ `tools/execute` 包装器包一圈计时（around 模式），比 `tools/pre-execute` + `tools/result` 两处更精确，且不碰 agent-loop。
3. 「审批被拒后模型看到什么」→ `serviceAsk` 产出不同文案（rejected/cancelled/unavailable 各有独立句子，index.ts:1713），模型能区分「人说不」与「没有通道」。
4. 「沙箱 denial 与命令失败如何区分」→ 非零退出 + 本后端 denial 方言 stderr 匹配 → `denied`；runner 先失败（exit 125 + `landlock-run: ` 行）→ `runnerFailed`/`SANDBOX_UNAVAILABLE`；两者都不会把普通命令失败误判为沙箱问题。

---

## 7. 存疑/待确认

1. **`git` 状态未确认**：仓库 `packages/fs/fs/src/types.ts` 等文件的精确行号部分引用自中文文档的 `ts type-equiv` 块（文档标注「生成目录」），与源码可能微差；写笔记时优先引用了 `docs/` 与已读源码交叉一致的锚点。若需发布级准确，应对 `packages/fs/fs/src/types.ts`、`packages/subprocess/subprocess/src/types.ts`、`packages/shell/shell/src/types.ts` 逐一补读核对行号。
2. **`ScopedLayers` 与 Cordis effect 语义**：`store.ts:226` 的 `effect()` 用 generator 让渡 dispose 逻辑，其与 `ctx.effect()` 返回身份、HMR 重载时层回收的精确行为只从注释推断，未跑测试验证。
3. **`tools/execute` 包装层数量与顺序**：timeout-policy 是唯一读到的一等包装器；retry/metrics 等其它包装器在仓库中未见实现（文档提及但未定位），若博客要展开「around 模式全家桶」需再搜 `packages/` 下其它 `ctx.on('tools/execute'`。
4. **Landlock 二进制发布矩阵**：`native/landlock-run/packages/{linux-arm64,linux-x64}` 只有 prebuilds 元数据，未核实 `prebuilds.json` 内容与 `scripts/build.ts` 的交叉编译细节；`--probe` 输出 `printf("landlock: %s\n", ...)` 与 entry 包 `probe` 解析的精确契约在 `docs/cli-contract.md`，未逐字核对。
5. **`presentAs` 与 preset 组合**：`modeFor` 沿 scope 链取最近声明，但「preset 的 standing declaration 覆盖其下所有 agent」的组合路径（`dsh-agent-tool-presentation`）只读到注释，未读该包源码。
6. **`fs/write-intent` 单槽瀑布的「先到先得」**：文档称「按注册顺序先到先得——由策略插件占据是部署约定，而非强制不变式」（filesystem.zh.md:185），即若多个插件监听会产生歧义；仓库当前只有 observation-policy 一个占用者，未验证冲突行为。
7. **`windows-acl` runner 的 `lib/runner.js` 与 `src/runner.ts` 选择**：`windowsAclRunnerInvocation`（sandbox-local/src/index.ts:557）按构建产物存在性选择入口，未读 runner 本体（`packages/sandbox/sandbox-windows-acl`）验证其 argv 契约。
8. **PTY 会话（`tool-terminal`/`terminal-bash`）**：本文只覆盖到 `ctx.subprocess.spawnTerminal`（node-pty 分配）与 sandbox 模式 fence（terminal-bash/src/index.ts:121），`LocalPtySession` 的提示符检测/scrollback/持久会话所有权未展开，属 `packages/terminal` 专项范围。
9. **`approval/request` 应答者实现**：UI 应答者（`apps/web` 侧）与 ACP 自动应答者的具体监听/claim 逻辑未读（只在 `docs/subsystems/approval.zh.md` 有语义描述）；`ask_user_question`（user-questions seam）与审批是**两套独立交互**，本文未展开 user-questions。
10. **`tool-fs` 的 `read` 渲染细节**：`read-render.ts` 的行窗口/字节上限交互（`truncatedByBytes` 时 `totalLines` 仍精确）只从文档确认（filesystem.zh.md:222），未逐行读实现。
11. **`dsh-shell` 的 `parseExitStatus` 确切正则**：只见 re-export 与用法（render.ts:103），词法本体的边界（如信号名白名单）未读 `packages/shell/shell/src` 具体文件。

---

## 附 A：博客写作线索（基于本笔记）

1. **标题候选**：《一个工具从模型调用到进程执行的 12 步》《DSH 工具流水线：可扩展瀑布与单调守卫的双轨策略》《把 bash 关进 Landlock：argv 包装的工程细节》。
2. **主线叙事**：用 1.4 的时序做骨架，每步配一个源码锚点；先讲「注册→schema→prompt」建立直觉，再讲「一次调用走完瀑布」，最后用沙箱/审批做「策略如何插进来」的实例。
3. **最出彩的三个点**：① waterfall+guard 双轨（可组合 vs 不可撤销）；② fail-closed 的层层设计（Landlock 退出 125、无后端抛 `SANDBOX_UNAVAILABLE`、`isConcurrencySafe` 非 true 即 exclusive）；③ 「canonical value 不落地、展示双投影」——模型只见渲染，程序只见结构化数据。
4. **图建议**：1.2 的分层图 + 4.2 的阶段状态机（prepare/dispatch/finalize 三态）+ 4.5 的 argv 包装示意（`bwrap --ro-bind / / ... -- bash -c cmd`）。
5. **避坑**：不要把 `ctx.approval` 与 `ask_user_question` 混为一谈；不要把 `SandboxMode` 说成「沙箱」——它只管文件效果，网络/进程可见性不在词汇内（sandbox/src/index.ts:24 注释）。

---

## 附 B：本笔记的主要证据锚点速查

| 主题 | 首选引用 |
| --- | --- |
| 流水线总览 | `packages/core/tools/src/index.ts:1342`（execute） |
| pre-execute/ask/guard | `packages/core/tools/src/index.ts:1463,1689,1119` |
| around + body + cancel | `packages/core/tools/src/index.ts:1532,1569,1889` |
| post-execute/finalize/result | `packages/core/tools/src/index.ts:1609,1631,1657,1742` |
| 调度（barrier/pool/reclassify） | `packages/core/agent-loop/src/tool-calls.ts:59,121,198` |
| schema DSL/defineTool | `packages/core/tools/src/schema.ts:85,153,545` |
| 沙箱 SD/词汇 | `packages/sandbox/sandbox/src/index.ts:29,95,158` |
| 平台链/探针/方言 | `packages/sandbox/sandbox-local/src/index.ts:159,205,231,492` |
| Landlock C launcher | `native/landlock-run/packages/entry/src/main.c:230,264` |
| bash 工具执行 | `packages/shell/tool-bash/src/index.ts:242,330` |
| bash 沙箱消费方 | `packages/shell/bash-sandbox/src/index.ts:88,150` |
| 子进程/收集/spill | `packages/subprocess/subprocess-local/src/spawn.ts:104,326,439` |
| 审批服务 | `packages/interaction/user-approval/src/index.ts:257,304` |
| fs 意图瀑布/观测 | `packages/fs/fs-observation-policy/src/index.ts:65,106`；`packages/fs/tool-fs/src/write.ts:111` |
| fs 沙箱 fence | `packages/fs/fs-sandbox/src/index.ts:84,126` |
| MCP 桥 | `packages/mcp/mcp-client/src/tools.ts:96,128,228` |
| 超时包装 | `packages/guard/timeout-policy/src/index.ts:56` |
| 作用域层 | `packages/core/scope/src/store.ts:159,226` |
