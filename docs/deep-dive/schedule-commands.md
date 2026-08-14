# 15 · 调度、命令与会话引用：三个"不打扰循环"的机制

> 消化 backlog A15。本篇拆三个此前只蜻蜓点水的子系统：schedule 的严格解码与交付循环、人类命令注册表（含"不成为模型消息"的三重机械保证）、`ask_user_question` 的暂停语义与会话引用（recall）的预算算法。

## 1. Schedule：O(1) 跳过积压的定时器

### 1.1 严格解码 + fold 重放

`schedule/change` 三操作（after/at/every）经 `domain.ts:575` 严格解码、`foldScheduleEvents` 重放——与 goal/todo 同一套事件溯源纪律。`every` 的 occurrence 解析（`domain.ts:519`）：

```ts
// 到期次数 = floor((acceptedAt - target) / interval)——O(1) 跳过积压
```

进程休眠 8 小时后醒来，不用补跑 960 次——**一次除法**定位到"现在该是哪一期"。

### 1.2 三处校验

`every` 间隔 ≥300 秒的约束在**三个边界**各自校验：工具层（模型参数）、创建层（域校验）、持久解码层（防手改文件注入非法记录）——"校验在边界，不信任中间"的又一例证。

### 1.3 交付：runMaintenance + followup，绝不 steer

到期交付走 `agent.runMaintenance`（抢占空闲相位）+ `followup`（正常排队开轮次）——**绝不 steer、绝不中断当前轮次**。提醒是"新消息"，不是"插入当前工作"。入队成功后才追加 dispatch 事件（至少一次语义：入队后崩溃可能重复提醒，但绝不丢）。

## 2. 人类命令：不成为模型消息的三重保证

命令（`/goal`、`/plan`）与工具的本质区别：**命令输出不属于模型 transcript**。DSH 用三重机械机制保证：

1. **surface 类型白名单**（`surface.ts:15`）：只有 `user/message`、`assistant/message`、`tool/result` 能进模型可见面——命令事件（`command/run`、`command/done`）天然进不去
2. **`deriveEventMessage` 的 default 分支返回 null**：未知/非表面事件投影为空
3. **append 的条件类型**：命令事件的类型上根本没有 `surfaceOp` 字段，编译器拒绝给它加表面标记

三重机制互为冗余：**白名单是运行时事实，投影 null 是语义事实，条件类型是编译期事实**。命令生命周期是配对的 `command/run → command/done`（含取消），注册走"注册即 effect + ScopedLayers 遮蔽"——与工具注册表同构。

### /goal 的授权对照

`/goal` 人类命令靠 `source=user` 直接执行（域层 assertLive + CAS ref 授权）；模型工具 `update_goal` 走 direct-human/goal-round 授权。**两条缝互不替代**：命令是人类的直接意图，工具是模型在自主循环里的动作——同一领域状态，两个入口，各自的权威规则。

## 3. ask_user_question：暂停 = await 一个 promise

`ctx.userQuestions.ask()` 的暂停语义极其朴素：**工具 execute 挂在一个由 UI 提供方 resolve 的 promise 上**。

- `DELEGATED_CALLER` 拒绝子代理提问——owned child 无人可答会永久阻塞（第 05 章已讲）
- `plan-review` 意图的 approve 标签按**标签相等**判定，不靠选项顺序——`BAD_INTENT` 在 asker 处校验
- 稳定 `id` 回显（本会话开头那次 ask_user_question 的 id 就是它）——选项重排不破坏人类回答的匹配

::: tip 面试要点：为什么"暂停"不用协程/生成器/状态机？
因为工具执行本来就 async——`await ask()` 就是天然的暂停点。事件溯源日志不需要记录"暂停中"状态：工具调用在日志里就是一个 `tool/call` 等它的 `tool/result`，人类思考的时间只是两者之间的墙钟间隔。**持久化模型不需要知道"暂停"这个概念**。
:::

## 4. Session Reference（recall）：两阶段预算

把当前表层的有界对话快照投影为"可被引用"的消息上下文，预算算法（`retainReferencedSession`）：

```text
阶段 1：整体超预算 → 丢弃整条（不截一半的历史）
阶段 2：单条超上限（65KB）→ 二分找最长可保留前缀 + 省略提示
```

- 投影只留 user/assistant **文本**（工具结果、chunk 不进去——那是可再检索的，不是"当前对话事实"）
- 提及语法归 `session-reference/src/uri.ts`（host 侧调用点不在当前 checkout——诚实存疑）

**"丢整条"是刻意选择**：一半的对话比没有对话更危险——模型会以为中间没发生过的事"没发生"。要么给完整（可验证的）上下文，要么明确说不给。

## 5. 面试要点

::: tip 面试要点 1：为什么提醒"绝不 steer"？
steer 是"插入当前步骤边界"——提醒不该打断正在执行的工具链。followup 排队 = "有空了再说"。schedule 的定位是"有人想起来了"，不是"有人插队"。
:::

::: tip 面试要点 2：为什么命令事件的类型上没有 surfaceOp？
"不能进模型"如果只靠运行时过滤，就会有人绕过；写在类型里，绕过需要同时骗过编译器、投影器、白名单。**不变量分层设防，最便宜的那层最先设**。
:::

::: tip 面试要点 3：为什么"丢整条"比"截断"安全？
截断制造"中间状态看起来连续"的假象。模型读到一个不完整的对话片段，会把缺失当作"没发生"。预算算法宁可明确给省略提示，也不伪造连续性。
:::

至此 backlog 12 个主聚类全部消化完毕（仅剩 20 条第二轮存疑项）。下一轮计划：验证 A11-2 的潜在 bug 线索（DisposableList 无 unshift），或按第二轮存疑继续。

::: tip 相关考古
调度器的墙钟-only 语义与 commands 装配点见[考古⑬](/deep-dive/archaeology-13)。
:::
