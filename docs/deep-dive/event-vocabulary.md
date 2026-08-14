# 会话事件词表：45 个持久事实的全清单

> 本篇是参考型文章：`KNOWN_SESSION_EVENT_TYPES`（生成物，`packages/core/session/src/known-event-types.ts`）的 45 个事件成员全清单，按域组织、每个一句话语义。用途：面试速查 + 理解"日志即真相"的完整边界。

## 1. 为什么这张清单重要

`KNOWN_SESSION_EVENT_TYPES` 是"本构建认识的会话事件全集"，它的纪律（第 09 章）：

- **词表外且非 `ignorable` 的事件 → 持久化读路径拒绝解读**（"可能是更新的 harness 写的"）
- 静默跳过一条必需事件 = 重建出错误的会话——所以 fail loud
- 仓库外插件的自定义事件**不在这张清单里**（注册面推迟到有消费者为止）

清单本身是**生成物**（`gen-persistence-catalog.ts` 生成、`verify-persistence-catalog` 校验新鲜度）——与 tool-catalog 一样，"手写会漂移的东西交给生成器"。

## 2. 循环与消息（9）

| 事件 | 语义 |
|---|---|
| `turn/start` / `turn/end` | 轮次边界；`turn/end.reason` 是六种结束原因的判别联合 |
| `step/start` / `step/end` | 步骤边界（一次模型请求 + 工具执行） |
| `user/message` | 模型可见用户消息（surface 事件，含 `surfaceOp`） |
| `assistant/chunk` | 流式分片（token 级回放保真，可 packChunkRuns 打包） |
| `assistant/message` | 组装后的助手消息 + usage 同行（surface 事件） |
| `tool/call` / `tool/result` | 工具调用与结果配对（surface 事件；结果引用调用 seq） |
| `agent/inbox/spliced` | inbox 队列的持久 splice（队列本身也是日志投影） |

## 3. 请求信封（2）

| 事件 | 语义 |
|---|---|
| `request/header` | 请求快照（config + adapterDefaults + system + tools），reason: initial/resume/change |
| `request/context` | provider/model/contextWindow 变化记录 |

## 4. 压缩与计量（5）

| 事件 | 语义 |
|---|---|
| `compaction/start` / `compaction/end` | 压缩事务的锁配对（有 start 无 end = 崩溃遗留锁） |
| `compaction/summary` | 摘要调用信封（provider/model/usage/rawOutput，可重建） |
| `compaction/prune` | 剪枝的影子价格事件（紧邻 replace） |
| `llm/retry` / `llm/retry-started` | 重试的调度与执行转移（先持久化后等待） |

## 5. 协作状态与目标（5）

| 事件 | 语义 |
|---|---|
| `todo/write` | 待办整表替换（last-wins 折叠） |
| `plan/mode` | plan 模式开关（仅日志，不进 transcript） |
| `goal/change` | 目标状态迁移（快照或墓碑，CAS 修订） |
| `agent-preset/selected` | 会话所选的 agent preset 组合记录 |
| `schedule/change` | 定时提醒的创建/触发/删除 |

## 6. 权限与审计（5）

| 事件 | 语义 |
|---|---|
| `approval/asked` / `approval/decided` | 审批审计对（必须被 turn 包裹） |
| `approval/policy` | 审批策略变更（ask/never） |
| `sandbox/mode` | 沙箱模式变更（PTY 运行期降级拦截盯的就是它） |
| `permission/preset` | 权限预设切换（仅日志，回放折叠最后一条） |

## 7. 委派与工作流（6）

| 事件 | 语义 |
|---|---|
| `subagent/descriptor` | 子代理持久身份（版本化，冷恢复折叠它） |
| `tool-workflow/run-start` / `run-end` | workflow 脚本运行生命周期（只读观察快照） |
| `tool-workflow/agent-start` / `agent-end` | 脚本扇出的子代理配对（崩溃时补配 agent-end） |
| `tool/code-dispatch-start` / `tool/code-dispatch` | Code Mode 子分派事件对（spill 可替换其持久副本 content） |

## 8. 命令、钩子与反馈（5）

| 事件 | 语义 |
|---|---|
| `command/run` / `command/done` | 人类命令生命周期配对（recordInput:false 时省略 args） |
| `hook/invoked` / `hook/result` | Claude Code/Codex hook 桥的调用与结果 |
| `feedback/record` | 逐 assistant 消息的反馈（不进历史与遥测） |

## 9. 会话元数据（4）

| 事件 | 语义 |
|---|---|
| `session/end-seed` | 构造种子结束标记（区分父历史与子工作） |
| `session/title` | 日志背书的会话标题（确定性回退折叠） |
| `session/title-llm-request` | 标题生成的辅助 LLM 调用信封（与 compaction/summary 同模式） |
| `web/deepseek-search-llm-request` | DeepSeek 搜索工具的辅助 LLM 调用信封 |

## 10. 三个跨域观察

1. **辅助 LLM 调用是显式事件**：`compaction/summary`、`session/title-llm-request`、`web/deepseek-search-llm-request` 三个"旁路请求"各有自己的信封事件——旁路不牺牲可重建性（第 20 篇的"独立重建路径"在词表层面可见）
2. **配对模式是主流**：start/end、asked/decided、run/start-run/end、invoked/result、call/result——"有开必有合"是可回放性的结构保证
3. **`*/*` 命名统一**：`<包干名>/<名词>` 无一例外（考古⑪的证伪在 45 个成员上再次成立）

## 11. 面试用法

- 被问"DSH 的会话日志里有什么"→ 按本篇九域作答，每域挑 2 个事件讲语义
- 被问"为什么 XX 也是事件"→ 用第 10 节的三条观察（旁路信封、配对模式、命名统一）
- 被问"新增模型可见输入怎么做"→ "扩展 SessionEventMap + 从日志渲染"（架构文档原话），这张清单就是扩展的现状全集
