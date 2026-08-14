# 为什么研究 DeepSeek Harness

面试官问你"研究过什么开源项目"时，你需要一个**能讲出深度**的答案。DSH 是我选择的答案，这篇文章说明理由，也帮你建立学习它的动机框架。

## DSH 是什么

[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 是一个**插件化的 agent harness**（智能体基座/运行时），类比 Claude Code、Codex CLI、Cursor Agent 的底层引擎。它解决的核心问题是：

> 如何把一个 LLM 变成可编程、可审计、可扩展的自主 agent？

它的答案浓缩在仓库根 `AGENTS.md` 的第一句话：

> DeepSeek Harness is a plugin-based agent harness on vendored Cordis: **everything is a plugin**.

**一切皆插件。** 包括你以为属于"框架内核"的部分：

| 你以为的内核 | 在 DSH 里其实 |
|---|---|
| 模型适配器 | 注册在 `ctx.llm` 上的插件（`llm-deepseek`、`llm-pi-ai`、`llm-replay`） |
| 工具注册表 | `ctx.tools` 服务 + 各 `tool-*` 插件 |
| 会话存储 | `ctx.sessionPersistence` seam，jsonl/sqlite 两个可替换后端 |
| **Agent Loop 本身** | `agent-loop` 插件，挂载在 `ctx.agentLoop` 上 |
| 沙箱 | `ctx.sandbox` seam，Landlock / 本地 / E2B 远程三种后端 |

不存在需要打补丁的特权内核。扩展 dsh 的方式是把插件挂到其他插件旁边，而所有注册都是**可逆副作用**——插件卸载时自动撤销。

## 为什么值得深度研究（面试视角）

### 1. 它把 agent 工程的"共识最佳实践"全部落地了

读一个 DSH ≈ 读完一份 agent 系统的设计白皮书：

- **事件溯源（Event Sourcing）会话日志**：`SessionEvent` 是唯一真源，模型历史、UI 回放、fork、恢复、遥测全部从同一日志派生
- **Turn / Step 状态机**：轮次（turn）排空输入队列，步骤（step）= 一次模型请求 + 其触发的工具执行
- **中间件式拦截链**：waterfall 事件让策略监听器（审批、沙箱、压缩）在不改循环代码的前提下包裹每个环节
- **能力 seam 架构**：Service Definition / Provider / Consumer 三角色解耦，替换一个提供方即改变整个产品行为
- **上下文工程**：compaction（压缩）、spill（溢出）、token 计量、技能系统
- **多代理编排**：subagent、受限 JS workflow 引擎、后台 jobs、持久 goal 循环

### 2. 每个子系统都能讲出"为什么这样设计"

面试考察的不是"背架构图"，而是**权衡**。DSH 的官方文档（`docs/`，约 1.5 万行）把每个机制的触发条件、失败语义、代价都写清楚了。举几个例子：

- 为什么 compaction 在 `agent/pre-step` 做，而不是循环里硬编码？—— 因为它是策略，不是流程
- 为什么工具结果要先剪枝再摘要？—— 剪枝是无模型的确定性改写，摘要需要花钱花时间
- 为什么 workflow 用受限 JS 脚本而不是自由代码？—— 编排脚本的权限边界 = agent 的权限边界
- 为什么"模型可见即已记录"是一条运行时不变量？—— 否则回放、审计、fork 全部失效

### 3. 技术栈贴近现代前端+后端 agent 岗位

| 技术 | 在 DSH 中的角色 |
|---|---|
| TypeScript strict + ESM | 全仓库语言（仅 native 部分用 Rust/C） |
| Cordis（vendored） | 插件框架：依赖注入、类型化事件、可逆副作用 |
| Zod / Typert | 工具 schema、RPC 类型图运行时 |
| pnpm monorepo + tsdown | 219+ 包的工程化管理 |
| Vite + React | Web GUI（`apps/web` + `packages/client`） |
| node:http / WebSocket | 事件流推送 |
| SQLite / JSONL | 持久化 |
| Landlock（Linux 内核安全模块） | 无 root 沙箱 |

### 4. 它是真实的工业级工程，不是玩具 demo

- CI 覆盖 Windows/macOS/Linux 全平台（甚至用 Wine 测 Windows）
- 每文件 100% 覆盖率门槛、快照测试、克隆检测
- 双语文档（英/中）由生成器 + 配对流程维护
- 事件与类型的交叉校验（`@mode` 标签、`verify-type-equiv`）自动防漂移

## 阅读源码的地图

整个仓库的入口是 `docs/architecture.md`。建议阅读顺序：

```text
docs/cordis-primer.md      → 插件框架 5 个核心概念（必读）
docs/architecture.md       → 组装、核心包、事件、轮次流程（必读）
docs/glossary.md           → 术语表：seam / scope / turn / step / goal
docs/agent-lifecycle.md    → 时序图（核心）
docs/tool-execution-pipeline.md → 工具执行管道流程图（核心）
docs/capability-seams.md   → 全部服务的注册地图（查表用）
docs/subsystems/*.md       → 每个子系统的参考文档（遇到再看）
docs/cookbook/*.md         → 扩展实战（加工具/包/适配器）
```

源码结构在根 `AGENTS.md` 有布局图，本资料后续每篇都会给出对应模块的文件地图。

## 一个贯穿全程的心智模型

把这句"咒语"刻在脑子里，后文所有内容都是它的展开：

```text
事件流 + 可逆副作用 = DSH 的全部控制流。

1. 事实（发生了什么）→ 会话事件，追加到日志，可回放
2. 实时协调（现在该怎么办）→ agent/* 事件，waterfall 可拦截
3. 能力（能做什么）→ 服务 seam，注册表 + 提供方可替换
4. 策略（允不允许做）→ 监听器挂在 2 和 3 的事件上，可拆卸
```

下一篇：[核心概念速览](/guide/concepts)，我们把 Cordis、事件、seam、会话日志、turn/step 这些术语逐个讲透。
