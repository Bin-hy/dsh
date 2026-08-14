# 架构总览：一台由插件组装起来的机器

这篇文章把 DSH 的静态结构讲清楚：运行中的 dsh 如何被组装出来、核心包有哪些、事件如何流动、能力如何分层。读完你应该能画出完整的架构图。

## 1. 启动：一棵插件树的诞生

运行中的 `dsh` 是一棵**插件树**，由启动时按序叠加的各层组合而成：

```text
空条目列表
  ├─ 按 profile 顺序应用每个组合包（bundle）      ← dsh-base 永远第一层
  ├─ profile 自己的 cordis.patch.yml
  ├─ home 级的 cordis.patch.yml
  └─ --patch overlay（命令行覆盖）
```

两个关键概念：

- **profile**：存放在 Harness home 的具名组装。列出自己叠放的组合包、存放树外插件、保存用户的 `cordis.patch.yml`。`web` 和 `headless` 作为模板随发行版交付。
- **组合包（bundle）**：Cordis 配置项及其挂载代码的分发格式。它插入的内容**始终可被其上各层 patch**——这就是"没有特权内核"的结构保证。

内置组合包分工：

| 组合包 | 内容 |
|---|---|
| `dsh-base` | 模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测 —— **每个 profile 的第一层** |
| `dsh-web-app` | 浏览器应用（Web GUI） |
| `dsh-headless` | 一次性运行器，**完全不带服务器** |

查看你的机器实际启动的配置树：

```sh
dsh --profile web --dump-config
```

打印出的任何条目都可以由你自己的 patch 替换——这就是配置即组装。

## 2. 核心包：产品的 API 脊柱

以下包定义 DSH 的骨架（`docs/architecture.md` 官方表格）：

| 包 | 职责 | `ctx` 键 |
|---|---|---|
| `core/session` | 仅追加的 `SessionEvent` 日志和内存存储 | `ctx.sessions` |
| `core/system-prompt` | 提示词片段与工具 schema 的组装 | `ctx.systemPrompt` |
| `core/tools` | 作用域化工具注册表 + 带把关的执行流水线 | `ctx.tools` |
| `core/agent` | `Agent` 接口、活跃 agent 注册表、`agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 实现该接口的**默认驱动器**（唯一具体循环插件） | `ctx.agentLoop` |
| `core/scope` | 按 agent 划分作用域的注册原语 | 库，无 ctx 键 |
| `llm/llm` | 消息与流式词汇表、适配器 seam | `ctx.llm` |

注意 `agent-loop` 的定位：它只是**默认实现**。扩展包依赖 `dsh-agent` 的事件和服务，而不依赖此包——理论上整条循环都可以被替换。

## 3. 服务地图：40+ 服务的全景

官方 `capability-seams` 文档给出了完整注册图。按领域归类（`ctx` 键 → 所属包 → 提供方实现）：

### 模型与流式

| 服务 | 定义包 | 提供方实现 |
|---|---|---|
| `ctx.llm` | `llm` | `llm-deepseek`、`llm-pi-ai`、`llm-replay`（测试回放） |
| `ctx.tokenMeter` | `token-meter` | —（按会话隔离的回放折叠区） |
| `ctx.toolResultPruner` | `compaction-tool-result-pruner` | — |
| `ctx.agentDefaultModel` | `agent-default-model` | — |

### 会话与存储

| 服务 | 定义包 | 提供方实现 |
|---|---|---|
| `ctx.sessions` | `session` | —（内存，唯一） |
| `ctx.sessionPersistence` | `session-persistence` | `-jsonl`、`-sqlite` |
| `ctx.sessionQuery` | `session-query` | `-sqlite` |
| `ctx.sessionProjections` | `session-projection` | —（状态折叠单元） |
| `ctx.sessionTitle` | `session-title` | `-first-prompt-llm`、`-all-prompts-llm` |
| `ctx.sessionTelemetry` | `session-telemetry` | `-otel`（输出离进程） |
| `ctx.storage` | `storage` | `storage-json`、`storage-sqlite` |
| `ctx.workspaceRegistry` | `workspace` | — |

### 执行世界（共享同一个"执行世界"的三个 seam）

| 服务 | 定义包 | 提供方实现 |
|---|---|---|
| `ctx.subprocess` | `subprocess` | `subprocess-local`、`subprocess-e2b` |
| `ctx.shell` | `shell` | `bash-local`、`bash-sandbox`、`pwsh-local` |
| `ctx.terminals` | `terminal` | `terminal-bash`（持久 PTY） |
| `ctx.fs` | `fs` | `fs-local`、`fs-sandbox`、`fs-e2b` |
| `ctx.sandbox` | `sandbox` | `sandbox-local`（+ native Landlock） |
| `ctx.codeRuntime` | `code-runtime` | `code-runtime-worker`（Code Mode） |
| `ctx.lsp` | `lsp` | `lsp-local` |

> 关键设计：**fs 与 subprocess 提供方共享同一执行世界**。把它们指向远程沙箱，Bash、PTY、LSP 一并搬走，无需提供方专用 fork。这是 seam 架构最漂亮的证明。

### 策略与交互

| 服务 | 定义包 | 提供方实现 |
|---|---|---|
| `ctx.approval` | `approval` | `acp`（自动化桥接） |
| `ctx.permissionPresets` | `permission-presets` | —（`workspace-write` / `danger-full-access`） |
| `ctx.sandboxPolicy` | `sandbox-policy` | —（统一部署默认模式与工作区根） |
| `ctx.userQuestions` | `user-questions` | UI 前端提供人工回答方 |
| `ctx.commands` | `commands` | —（`/goal`、`/plan` 等人类命令） |
| `ctx.planMode` | `plan-mode` | —（已记录的计划状态） |

### 上下文与技能

| 服务 | 定义包 | 提供方实现 |
|---|---|---|
| `ctx.systemPrompt` | `system-prompt` | —（片段组装注册表） |
| `ctx.compaction` | `compaction` | `compaction-basic` |
| `ctx.spillStore` | `spill` | `spill-local` |
| `ctx.skills` | `skill` | `skill-filesystem`、`skill-badge` |

### 编排

| 服务 | 定义包 | 提供方实现 |
|---|---|---|
| `ctx.subagents` | `subagent` | `-spawn-in-process`、`-fork-in-process`、`-acp`、`-codex`、`-claude-code`、`-dsh-sdk` |
| `ctx.workflowEngine` | `workflow` | `workflow-worker-thread` |
| `ctx.jobs` | `jobs` | `jobs-local` |
| `ctx.goals` | `goal` | — |

### Web 与外部接口

| 服务 | 定义包 | 提供方实现 |
|---|---|---|
| `ctx.web` | `web` | `web-search-exa/-perplexity/-deepseek`、`web-fetch-http` |
| `ctx.webServer` | `webserver` | —（node:http 路由注册） |
| `ctx.clientModules` | `modules` | —（`__DSH_BOOT__` 客户端插件图） |
| `ctx.apiProxy` | `apiproxy` | —（传输无关的 Host 网关） |
| `ctx.typert` | `typert-registry` | —（运行时类型注册表） |
| `ctx.typertGateway` | `api-gateway` | —（RPC 调用网关） |

## 4. 轮次流程（Turn Flow）

架构文档给出的权威描述：

```text
turn/start
  claim next-step input plus one queued message          ← 领取 inbox
  assemble prompt sections + tool schemas                ← 组装提示词
  -> agent/pre-step          waterfall: reject | enter(messages)
     reject, 或首个 enter 被改写为空 → 关闭无步骤轮次
     step/start
     append entered messages as user/message             ← 写入日志
     derive model history from the log                   ← 从日志投影历史
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping        serial（无 next() 的终止检查点）
turn/end
```

事件分类要点：

- **持久会话事件**：`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*`
- **实时扩展点**（waterfall）：`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`
- **serial 终止检查点**：`agent/turn-stopping`（无 `next()`，表示"轮次即将停止"）

### inbox：输入如何到达驱动器

输入通过同一个 **inbox** 到达驱动器：

- 有些消息**立即唤醒**驱动器
- 注入的上下文（`agent.inject()`）**留在 inbox 里**，直到另一条消息将其唤醒——这就是"steering 与注入上下文在后续认领批次经过同一 waterfall"的机制
- `agent/pre-step` 决定模型看到什么：监听器可以改写已领取的消息，也可以**直接拒绝**它们；被拒绝的批次也会关闭一个**无步骤的持久轮次**，保证日志记录这次尝试

## 5. 能力 seam 的完整形态

回顾三个角色，并补两个细节：

- **单一角色不是 seam**。添加一项能力 = 同时设计 Service Definition、Provider、Consumer 三者
- **一个包可合并多个角色**：`dsh-llm` 同时承担 Service Definition 和 Consumer
- seam 拥有自身 `ctx.<key>` 的 Service 必须是**抽象类或具体注册表，绝不是 TS interface**——因为它要承载生命周期与事件

## 6. 新行为放哪里（速查表）

这是官方"扩展点决策表"的整理版，面试被问"如果我想加 X 该怎么做"时直接查：

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 注册适配器 |
| 添加面向模型的能力 | 在 `ctx.tools` 注册；schema 加入提示词组装 |
| 让某个会话拥有不同能力集合 | 组装 agent preset；服务行需要 `isolate` realm |
| 添加 shell 执行 | 注册 `ctx.shell` 后端；本地后端经 `ctx.subprocess` spawn |
| 添加持久终端 | 注册 `ctx.terminals` 后端 + `dsh-tool-terminal` |
| 添加用户命令 | 在 `ctx.commands` 注册；无需模型轮次即可分派 |
| 添加后台工作 | 在 `ctx.jobs` 注册；`job_*` 工具收集/停止 |
| 添加文件系统访问或策略 | 注册 `ctx.fs` 提供方，或监听 `fs/*` 事件 |
| 限制所启动的进程 | 使用 `ctx.sandbox` 后端；消费方在 spawn 前包装 argv |
| 拦截请求/工具/轮次 | 使用 `agent/*` 或 `tools/*` 事件 |
| 添加模型可见上下文 | 调用 `agent.inject()` |
| 添加 UI 集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加 Web Chat 节点 | 注册 `ConversationNodeDefinition` + keyed renderer |
| 添加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染和回放 |
| fork 活跃会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 将注册项限定到单个 agent | 使用该 agent 的 `agent.ctx` |

## 7. 心智图：三个平面

DSH 的全部逻辑可以压成三个平面：

```text
┌─────────────────────────────────────────────────────┐
│ 组合平面：profile + bundle + patch = 插件树（静态）      │
├─────────────────────────────────────────────────────┤
│ 运行平面：turn/step 状态机 + 事件瀑布（动态）            │
│   agent/*   实时协调（可拦截、不可回放）                 │
│   session/* 持久事实（可回放、不可改写）                 │
├─────────────────────────────────────────────────────┤
│ 能力平面：seam = Definition + Provider + Consumer      │
│   替换 Provider = 改变产品行为，Consumer 零改动          │
└─────────────────────────────────────────────────────┘
```

下一篇进入[深度拆解 01：核心循环](/deep-dive/agent-loop)，看驱动器如何把这套骨架跑起来。
