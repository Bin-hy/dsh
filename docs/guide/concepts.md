# 核心概念速览

这篇文章把 DSH 的领域词汇逐个讲透。建议配合官方 [glossary](https://github.com/deepseek-ai/DeepSeek-Harness/blob/main/docs/glossary.md) 阅读——面试时能准确使用这些术语，本身就是"研究过"的证据。

## 1. Cordis：五句话理解插件框架

DSH 底层是 [vendored Cordis](https://github.com/deepseek-ai/DeepSeek-Harness/blob/main/docs/cordis-primer.md)（上游 Koishi 生态的插件框架，vendor 方式固定版本引入）。五句话：

1. **插件是实现 Service 的对象**。一个函数带可选 `inject` 和 `apply(ctx)`，或一个 `Service` 子类。
2. **上下文（ctx）是服务的容器**。一个服务占据稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`）；其他插件**通过 key 查找服务，而非 import 具体实现**。
3. **用 `inject` 声明服务依赖**。插件声明所需服务后等待它们就绪才启动——加载顺序由依赖表达，不需要手动编排启动序列。
4. **类型化事件用于通信**。服务通过 TS 声明合并（declaration merging）注册事件名，以四种模式分发（见下）。
5. **注册是可逆副作用**。通过 `ctx.effect()` / `ctx.on()` 安装，插件卸载时自动撤销。

```ts
// 插件的最小形态（示意，非源码）
export const myPlugin = {
  name: 'my-plugin',
  inject: ['ctx.tools'],          // 声明依赖：等 ctx.tools 就绪
  apply(ctx) {
    // 注册副作用，返回 disposer
    ctx.effect(() => {
      const unregister = ctx.tools.register(myToolDef)
      return () => unregister()     // 卸载时执行
    })
  },
}
```

### 四种事件分发模式

这是 DSH 里最重要的概念之一。每个事件有且只有一种分发模式：

| 模式 | await？ | 顺序 | 返回值 | 用途 |
|---|---|---|---|---|
| `emit` | 否 | 按注册顺序观察 | 无 | 广播事实 |
| `waterfall` | 否 | 监听器包裹下游 | **有** | 拦截/改写链（核心！） |
| `parallel` | 是 | 并行扇出 | 无 | 独立观察者 |
| `serial` | 是 | 按序执行 | 有 | 终止性检查点 |

**Waterfall 语义**（必须烂熟于心，面试高频）：

```ts
ctx.waterfall('agent/pre-step', value, async (value, next) => {
  // 处理 value...
  const downstream = await next(value)  // 执行下游监听器
  // 包装下游返回值...
  return downstream
})
```

- 调用 `next()` = 委托给下游，**返回值可以被本层包装后继续向外返回**
- 不调 `next()` 直接 return = **短路**，下游监听器不再执行
- 对单决策事件，短路是设计意图：策略监听器"拥有决策权"时直接返回；纯观察者**必须委托**

## 2. 会话日志：唯一真源（Single Source of Truth）

`packages/core/session` 拥有**仅追加（append-only）**的 `SessionEvent` 日志。所有持久事实都写进这个日志，通过 `session/event` 广播。

关键不变量（DSH 的"宪法"之一）：

> **模型可见即已记录。** 抵达模型请求的一切都必须能从日志重建，由一项运行时不变量断言。新增模型可见输入 = 必须新增一个会话事件类型。

由此派生的推论：

- 模型历史 = `deriveMessages()` 从日志**投影**出来的（日志是源，消息列表是视图）
- fork、恢复、transcript、遥测、UI 回放 = 同一事件流的**不同消费方**
- 原始 `assistant/chunk` 事件保证回放和 UI 保真（增量级，不只是最终文本）

### 三类事件域（架构决策第一问）

新增行为时，第一个决定是"事件属于哪个域"：

| 事件域 | 例子 | 特点 | 何时用 |
|---|---|---|---|
| **会话事件** | `turn/start`、`step/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result` | 追加到日志 + 广播，持久事实 | 事实必须在重载后仍存在 |
| **Agent 事件** | `agent/pre-step`、`agent/request`、`agent/status`、`agent/inbox/*` | 携带活跃 `Agent` 的实时协调 | 观察/拦截进行中的工作 |
| **能力事件** | `fs/*`、`tools/*`、`telemetry/*` | 无 import 循环地向 seam 挂策略 | 给某项能力附加策略和适配器 |

## 3. 能力 Seam：三角色

**seam**（接缝）是 DSH 的可替换能力单元，包含三种角色：

- **Service Definition**：拥有自己的 `ctx.<key>` 和词汇类型的 Cordis Service（抽象类或注册表，**绝不是 TS interface**）
- **Service Provider**：实现它的插件
- **Consumer**：注入该服务的插件（通常是面向模型的工具）

规范范例 `packages/shell`：

```text
dsh-shell          Service Definition   → ctx.shell
dsh-bash-local     Provider（本地执行）
dsh-bash-sandbox   Provider（沙箱包装执行）
dsh-tool-bash      Consumer（面向模型的 bash 工具）
```

**为什么 seam 如此重要**：替换一个提供方 = 改变整个产品。文件系统与进程提供方共享同一个执行世界——把它们指向远程沙箱（E2B），Bash、PTY、LSP 全部跟着搬过去，**无需提供方专用 fork**。subagent 提供方同样千差万别：从新建一个进程内子 agent，到把轮次委派给 Claude Code / Codex / ACP 服务器。

完整服务地图见官方 [capability-seams](https://github.com/deepseek-ai/DeepSeek-Harness/blob/main/docs/capability-seams.md) 文档，本资料[架构总览](/guide/architecture)有整理版。

## 4. Agent 与作用域（Scope）

**scope**：按 agent 划分的注册单位。一项贡献（工具、提示词片段、变量、监听器）要么**全局**，要么属于恰好一个 scope key。

- 只有两层、扁平结构：**带作用域的注册不会向下继承给 subagent**（子树行为用 lineage 数据表达，而非 scope 结构）
- **活跃 agent 就是其自身 scope 的 key**
- **agent 上下文（`agent.ctx`）**：通过它注册的东西既作用域可见，生命周期又绑定到该 scope
- **shadowing**：最具体者胜出——带作用域的工具/片段仅在 scope 内替换同名的全局项（按 agent 定制 persona 的机制）
- **restriction**：`tools.restrict` 为单个 scope 过滤全局工具集合；被过滤掉的工具"与不存在无法区分"

## 5. Turn / Step / Round

三个容易混淆的循环层级，面试必考：

| 术语 | 定义 |
|---|---|
| **轮次（turn）** | 会话中一次对已接纳输入的**排空过程**：在领取首条输入前打开，在模型及工具不再欠任何工作时关闭 |
| **步骤（step）** | **一次模型请求 + 由模型响应引发的工具执行**；一个轮次包含零个或多个步骤 |
| **Round** | 承载一个轮次的外层策略迭代（如 Goal Round、Ralph Round）；计数器归策略所有，**不统计会话中的每个轮次** |

用大白话：用户发消息 → 开一个 turn → agent 循环调用模型，每次调用+工具执行是一个 step → 所有事做完（或策略叫停）→ 关 turn。Goal Round / Ralph Round 是外层"来一轮"的调度单位。

## 6. 目标、命令、Ralph

- **目标（goal）**：附着在现有会话上的单个持久完成目标，阶段 `active / paused / blocked / complete`，带修订号与 Round 上限。**目标是状态，不是调度器**；会话日志仍是真源。
- **人类命令（command）**：以 `/` 开头的指令（如 `/goal`、`/plan`），由 `ctx.commands` 解释执行，**不成为模型消息**。不同于面向模型的工具。
- **Ralph 循环**：面向不可变目标的**前台全新 agent** 迭代。每个 Ralph Round 是一个全新子会话，**不继承父会话对话种子**，靠共享工作区 + 有界交接报告传递状态。

## 7. 三个必须记住的设计公理

DSH 的 `AGENTS.md` 和架构文档反复强调的纪律，也是面试时最能体现理解深度的部分：

1. **注册即副作用**：一切贡献走 `ctx.effect()` / `ctx.on()`，`register()` 返回 disposer。
2. **模型可见 ⟺ 已记录**：新模型可见输入必须伴随新的会话事件。
3. **插件，不改循环**：新行为挂在文档化的扩展点上；改 `agent-loop` 需要同步更新 `docs/architecture.md`。

## 下一步

概念就绪。下一篇[架构总览](/guide/architecture)看完整的组装方式（profile/bundle）、核心包地图、轮次流程与事件映射。
