# 源码考古：最终处置、机制确认与两个文档建议

> 第三季 · 第 12 期。本期做六项"最终处置"：A10-8 的例外使用者确认（dsh-sdk 是唯一传输例外）、A11-3 的 `_hooks` 清理机制确认、A15-3 的"无消费者即无错误"、A15-5 的审计机制确认、A16-1/A16-6 两条文档建议归档。

## 1. A10-8：SDK 例外是唯一"传输例外"

全仓库直接使用 `child_process`（绕过 subprocess seam）的非测试文件：

```text
packages/host/directory-picker-native/   ← 平台 UI 对话框宿主（Windows）
packages/util/native-command/            ← 原生命令工具
packages/shell/tool-pwsh/                ← PowerShell 工具
packages/subprocess/subprocess-local/    ← seam 本体（不算例外）
```

结论：**dsh-sdk 是唯一绕过 seam 的 subagent 传输**。其余直接使用者是平台/工具场景，不是委派传输。例外清单 = 1 项，边界清晰。

## 2. A11-3：`_hooks` 清理的机制确认

`vendor/cordis/src/fiber.ts:675-694` 的 `_unload`：

```ts
private async _unload() {
  await Promise.all(this._disposables.clear().map(...))   // 只清 effect 链
  this.store = undefined
  ...
}
```

实证确认：

- `_unload` 清理 `_disposables`（effect 链），**从不清理 `_hooks`**
- `internal/listener` 拦截器路径**绕过 effect 系统**（第 11 章已读）——注册进 `fiber._hooks` 的监听器不随卸载自动回收
- 清理依赖调用方纪律：拦截器返回的 disposer（`push` 的 `() => this.map.delete(sn)`）由调用方持有——若调用方不 invoke，条目跨重载存活

"推断刻意"升级为"机制确认"：**map 存活于 unload；条目之死依赖个体 disposer 是否被调用**。这个设计在 HMR 场景是可辩护的（update 监听器要在重载决策期间仍可用），但代价是"调用方忘记 dispose = 幽灵监听器"。与 A11-2 同源（都是 `internal/update` 特判路径），建议上游在修 A11-2 时一并评估生命周期语义。

## 3. A15-3：无消费者即无错误

`packages/schedule/schedule/src/index.ts:44`：

```ts
ctx.on('agent/created', ({ agent }) => {
  if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return
  ...
})
```

- **只给 root agent 装 ScheduleRuntime**——owned child 永远拿不到
- owned child 的会话里若含 `schedule/change` 事件：**没有任何消费者读它**——是"休眠事实"，不是错误

原存疑问"谁负责拒绝/忽略"——答案是**结构保证**：运行时根本不存在于 child，事件自然无人消费。fork 的 seedLength 切片（第 15 章）进一步保证父的提醒不会被继承。三层（无运行时 + seed 切片 + 无拒绝路径）里，"无拒绝路径"不是缺口，是**"不可能发生"的另一种表达**。

## 4. A15-5：审计机制确认，政策未文档化

`packages/interaction/commands/src/index.ts:305-311`：

```ts
this.appendLifecycle(agent.session, 'command/run', {
  commandId,
  name: parsed.name,
  ...command.definition.recordInput === false ? {} : { args: parsed.rawInput },
  source: { kind: 'user' },
})
```

机制确认：`recordInput: false` 时，`args` 字段**整个省略**（不进日志）。审计只能依赖领域事件（如 feedback/record 类）。

未确认的部分：哪些命令用了 `recordInput: false`、审计缺口是否被接受——**包文档未展开**。诚实分类：机制已证、政策未注（第四类结局）。适合作为"文档建议"而不是 bug 报告。

## 5. A16-1：文档滞后项的最终处置

`llmRetryPolicyOf(stream)` 符号的最终状态：

- 全仓 grep 不存在 → 现实现是 `PreparedLlmCall.retryPolicy` 经 `agent/request-error` payload 传递
- 博客（第 16 章）已按代码书写
- **处置**：归档为"已解决（以代码为准）"+ 加入上游文档修正候选（docs/subsystems/llm-streaming.zh.md 应删除该过时符号引用）

## 6. A16-6：默认 source 的文档区分建议

两处 source 的差异（第 16 章笔记已确认）：

```ts
// BlockAssembler.message() 的默认（assembler.ts:161）——仅供独立消费方
{ kind: 'plugin', plugin: 'dsh-llm/assembler' }
// loop 实际使用（agent.ts:373-380）——带 provider/model 溯源
{ kind: 'model', provider, model }
```

**处置**：差异已在博客写明；建议上游在 assembler 的 JSDoc 加一句"默认 source 仅供独立消费方；agent-loop 用 `createAssistantMessage` 显式覆盖"，防止误读"组装器产生 plugin 来源消息"。

## 7. 本篇消化的 backlog 项

- ✅ A10-8 SDK 例外使用者（唯一传输例外，其余为平台/工具场景）
- ✅ A11-3 `_hooks` 清理（机制确认：map 存活于 unload，条目靠个体 disposer）
- ✅ A15-3 owned child 的 schedule 事件（结构保证：无运行时 = 无消费者）
- ✅ A15-5 recordInput 审计（机制已证、政策未注）
- ✅ A16-1 llmRetryPolicyOf（最终处置：归档 + 上游文档修正候选）
- ✅ A16-6 BlockAssembler 默认 source（文档区分建议归档）

## 8. 剩余 6 条（考古⑬ 收尾）

```text
A10-7 dsh-sdk 子进程隔离边界 · A11-4 whenIdle 收敛测试
A14-3 conversation 折叠引擎边界 · A15-2 commands 装配点
A15-4 时钟回拨补偿 · A15-6 goal 远程面消费方
```
