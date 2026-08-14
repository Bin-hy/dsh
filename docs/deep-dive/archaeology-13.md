# 源码考古：收官——最后六条的诚实处置

> 第三季 · 第 13 期（收官）。52 条第二轮存疑至此全部消化。本期处置最后六条：SDK 子进程的完整隔离、whenIdle 的覆盖层级、conversation 折叠引擎的机制边界、commands 装配点、墙钟-only 的调度器、goal 远程面。

## 1. A10-7：SDK 子进程是"完整第二个 harness"

`packages/subagent/subagent-dsh-sdk/src/index.ts:3` 与 `run.ts:26`：

```ts
// index.ts:3 —— 包级注释
// Harness runtime in its own process — own `cordis.yml`-decided composition,
// own persistence, own tools.
// run.ts:26
/** Arguments passed to {@link command} (typically the child's `cordis.yml` path). */
```

隔离边界三层：**组合**（自己的 cordis.yml 决定插件树）、**持久化**（自己的存储）、**工具**（自己的注册表）。与父进程的共享面只有：wire 协议（3 请求 + 4 通知）与 spawn 参数。这不是"沙箱隔离"，是**结构隔离**——子进程什么都不继承，连接越窄，隔离越强。

## 2. A11-4：whenIdle 的覆盖层级

`whenIdle` 出现在 agent-loop 的 3 个测试文件、17 个 idle 相关用例中（request-error、contract-regressions、agent-initiator）。诚实结论：

- **间接覆盖**：有——生命周期测试大量经过 whenIdle（取消、dispose、重试都依赖静默等待）
- **穷举并发证明**：没有——双重检查循环的正确性仍是**推演证明**（第 11 章的"赋值先于启动、resolve 后于结束"论证）

层级划分：机制正确性（推理可证）+ 集成正确性（17 用例间接覆盖）+ 形式化穷举（不存在，也不该期待——DSH 的测试哲学是"行为描述"，不是"并发穷举"）。

## 3. A14-3：折叠引擎的机制边界

conversation 折叠引擎（`ConversationNodeAssembler`）与 Host 日志的边界，在第 07/14 章已覆盖机制层面：

```text
Host：SessionEvent 日志（append-only、surface 折叠）——模型真相
浏览器：ConversationNodeDefinition 状态机（match/start/update/publication）——UI 真相
共享：同一事件流（WS 帧携带 seq），保证最终一致
差异：Host 折叠三种 surface 事件；浏览器折叠 UI 节点（chunk 流成卡片）
```

"完整状态机枚举"（每个 node kind 的转移表）是一个可以再写一篇的选题——但作为**存疑处置**，机制边界已清楚，枚举留给未来的选题清单。诚实收口。

## 4. A15-2：commands 的装配点

`dsh-commands` 挂载在 **base bundle**（`packages/bundle/base/cordis.patch.yml`），并有组装级 e2e 覆盖（`shipped-composition.e2e.ts`、`goal-command-presentation.e2e.ts`）。`@Remote` 方法的 Typert 挂载经 shipped-composition 测试间接验证。存疑闭环：装配点在 base 层，与第 07 章 Typert 网关的挂载机制一致。

## 5. A15-4：墙钟-only 的调度器

`packages/schedule/schedule/src/runtime.ts` 三处时间读取全部是 `Date.now()`（墙钟）：

```ts
acceptedAt: new Date(now).toISOString()   // :56
const wakeNow = Date.now()                // :246
const decisionNow = Date.now()            // :260
```

无单调时钟、无回拨补偿。兜底语义（第 15 章）：`resolveEveryOccurrence` 的 latest-due 锚定让"醒来重查墙钟"天然收敛——**回拨的最坏结果是提醒延后到下一个 driveOnce，而不是错乱**。诚实结论：补偿缺席、语义兜底、文档未明言——第四类结局（机制清楚、政策未注）。

## 6. A15-6：goal 的远程面

`packages/goal/goal/src/index.ts:276-336` 的 `@Remote('edit'/'pause'/'resume'/'complete'...)` 存在——远程面是**服务的一部分**（Typert 导出），但消费方（host goal 面板）在仓库外。与 A15-1（session-reference）同型：**契约 + 测试在仓库内，生产消费方在仓库外**。这是 DSH 的边界诚实性：seam 的完整定义在仓库里，宿主产品的组装在外。

## 7. 第三季总结

```text
✅ 52/52 条第二轮存疑全部消化
   实证 bug ×2（DisposableList 崩溃、internal/listener 类型滞后）
   证伪 ×9（含前提错误型、观察错误型、"其实有测试"型、"其实有清理"型）
   缺口 ×2（pending 无内存上界、组合测试缺口）
   设计债 ×2（frozen-project-root、A11-3 生命周期语义）
   选择/边界归档 ×37
✅ 考古系列 ①~⑬（13 篇）
✅ 上游 issue 素材：5 个候选（1 个已运行时复现）+ 文档修正建议 2 条
✅ 博客累计 47 篇
```

**方法论遗产**（六步法 + 证伪四型 + 找注脚 + 清单审计）已沉淀在 ①~⑪ 各期。

第三季目标达成。剩余的自然延伸：提交上游 issue（需要你的 GitHub 登录）、把"conversation 折叠引擎完整状态机"列为新选题、或开启第四季（把考古发现反哺回 26 篇主文章的修正）。
