# 源码考古：复制即冻结、对称的注脚与命名其实统一

> 第三季 · 第 11 期。四条审计：A16-7 的进程环境"无可轮换"源于**构造时复制**；A16-8 的对称设计有 **jscpd 忽略注脚**为证；A15-10 的"命名不统一"是**观察错误**（第 9 次证伪——前缀一律是包干名）；A10-9 的宽限默认值来自共享常量。

## 1. A16-7：复制即冻结——"无可轮换"而非"轮换无通知"

`packages/util/launch-environment/src/index.ts:79-80`：

```ts
// Copy every layer so later mutations cannot change the snapshot. Fold names
// on Windows so case variants cannot split precedence; POSIX remains exact.
```

`createLaunchEnvironmentSnapshot` 在**构造时把每一层复制进 Map**——之后任何 `process.env` 变更对快照不可见。所以"进程层热轮换"的精确语义：

- 不是"轮换了但没通知"（那是个缺陷）
- 而是"**无可轮换**"——快照模型里进程层在启动后就不存在可变性

审计结论与原笔记 §7-7 的表述一致。顺带一个值得注意的细节：Windows 上名字折叠（case variants 不拆散优先级）、POSIX 保持精确——快照连平台差异都处理了。

## 2. A16-8：对称是有注脚的

`packages/credentials/credentials/src/index.ts:101`：

```ts
/* jscpd:ignore-start -- deliberate symmetry with the settings seam's commit
...
/* jscpd:ignore-end */
```

`notifyUpdated`（credentials）与 `emitAdaptersUpdated`（llm）是同一"contained fan-out + INVARIANT rethrow"形态——克隆检测工具 jscpd 会把它们标成重复代码，而仓库用 **ignore 注脚**声明"这是刻意对称"。

注脚的存在就是证据：**对称在这里是被审查、被承认、被文档化的选择，不是漏掉的重构**。提取公共助手曾被否决（会耦合两个 seam 的事件语义）——"对称 > 复用"是这条注脚传达的仓库文化：两个 seam 的相似性是巧合性的（现在恰好同形），强制合并会让未来的独立演进互相牵制。

::: tip 方法论：找注脚
重复代码的"是不是债"，答案经常在工具注脚里：`jscpd:ignore`、`oxlint-disable`、`v8 ignore` 每一条都是作者留下的"我看到了，这是有意的"签名。考古时先 grep 注脚——它比代码本身更接近设计意图。
:::

## 3. A15-10：命名其实统一——第 9 次证伪

原存疑："调度用 `schedule/change`、目标用 `goal/change`、命令用 `command/run|done`——没有统一前缀约定。"

`known-event-types.ts` 的完整事件清单给出的答案：

```text
approval/asked · approval/decided · approval/policy
command/done · command/run
compaction/end · compaction/prune · compaction/start · compaction/summary
goal/change
llm/retry · llm/retry-started
permission/preset
plan/mode
sandbox/mode
schedule/change
subagent/descriptor
todo/write
```

**约定是统一的：`<包干名>/<名词>`**。schedule 包 → `schedule/change`；goal 包 → `goal/change`；plan-mode 包 → `plan/mode`（去 -mode）；commands 包 → `command/run`（去 -s）。原笔记的"不对称"观察本身是错的——三组例子恰好都是同一规则下的产物。

**为什么这次证伪值得记**：观察错误与真实缺陷在存疑清单里长得一样。靠枚举全集（而不是三组例子）才能发现"其实有规则"。这就是清单审计的价值：**例子会骗人，全集不会**。

## 4. A10-9：宽限默认值的来源

四个进程外传输的 dispose 宽限（grep 证据）：

```text
subagent-acp:        disposeGraceMs: default(DEFAULT_DISPOSE_GRACE_MS)
subagent-codex:      disposeGraceMs: default(DEFAULT_DISPOSE_GRACE_MS)
subagent-claude-code: disposeGraceMs: default(DEFAULT_DISPOSE_GRACE_MS)
subagent-dsh-sdk:    disposeGraceMs: default(DEFAULT_DISPOSE_GRACE_MS)
                      + shutdownTimeoutMs: default(DEFAULT_SHUTDOWN_TIMEOUT_MS)
```

来源 = **out-of-process 共享词汇的常量**（第 10 章讲过的公共一半），各 provider 的 Config schema 暴露同名的可配置字段。调优依据（`run.ts:91` 注释）："Default POSIX grace between SIGTERM and SIGKILL on dispose"——它是 TERM→KILL 阶梯里的宽限参数，语义统一、来源统一、可配置性统一。存疑闭环。

## 5. 本篇消化的 backlog 项

- ✅ A16-7 进程层热轮换边界（复制即冻结，"无可轮换"）
- ✅ A16-8 对称 > 复用（jscpd ignore 注脚为证）
- ✅ A15-10 事件命名（**证伪**：`<包干名>/<名词>` 统一约定，原观察错误）
- ✅ A10-9 dispose 宽限配置（共享 out-of-process 常量，语义统一）

## 6. 考古系列十一期累计

```text
已消化 40/52 条：实证 bug ×2 · 证伪 ×9 · 缺口 ×2 · 设计债 ×2 · 归档 ×25
剩余 12 条
下一期候选：A14-3、A16-1/6、A15-2/3/4/5/6、A10-7/8、A13-4(已归档)
```

## 7. 下一期预告

考古⑫候选：A16-1（llmRetryPolicyOf 文档滞后的最终处置）、A16-6（BlockAssembler 默认 source 的文档区分）、A15-5（recordInput:false 审计缺口）、A15-6（goal 远程面消费方）。
