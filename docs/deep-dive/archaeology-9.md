# 源码考古：完整清单、最外层包装与"严格而非宽容"

> 第三季 · 第 9 期。四条审计：A13-5 的 pre-step 完整参与者清单（14 个真实注册者）、A13-6 的 time-context 顺序机制（**最外层包装器**的语义精确定位）、A13-7 的目录解析（原判断"宽容跳过"被修正为"严格校验 + 降级"）、A10-1 的 ACP 停止原因归一。

## 1. A13-5：pre-step 的 14 个真实注册者

全仓库 `agent/pre-step` 注册清单（排除声明文件与测试）：

```text
context/      tmux-context · agent-instructions · time-context
core/         agent-loop（瀑布起点，不算"注册者"）
skill/        tool-skill（目录 + /name 手势，2 个 listener）
plan/         plan-mode（pending 意图落日志）
compaction/   compaction-basic（压力压缩——唯一 next() 前工作者）
extensions/   tool-cordis（×2 文件）
hooks/        hooks-claude-code · hooks-codex（hook 桥）
guard/        repeat-tool-reminder（循环计数重置）
subagent/     subagent-in-process-driver（child 描述符追加）
goal/         goal-round-driver（续跑校验）
session/      session-checkpoint-policy（flush 屏障）
```

14 个真实注册者 + 1 个瀑布起点。原存疑的"18 个注册文件"包含 2 个声明文件与 grep 噪声——修正后的精确数字是 14。

这个清单本身就是一个教学素材：**agent 每走一步，有 14 类策略在观察或拦截它**——而循环代码对此一无所知。第 01 章说"循环没有特权"，这张表就是证据。

## 2. A13-6：time-context 是"最外层包装器"

`packages/context/time-context/src/index.ts:170-208` 的监听器：

```ts
ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
  const decision = await next()        // ① 先委托下游
  if (decision.kind === 'reject' || signal.aborted) return decision
  ...
  return { kind: 'enter', messages: [...decision.messages, 时间快照消息] }  // ② 追加
}, { prepend: true })                  // ③ 注册在链头
```

水瀑布的三段语义拼起来：

- `{prepend: true}` = 注册在链头 = **最外层**
- 先 `await next()` 再追加 = **包装模式**（wrap-and-append）
- 结论：time-context 的快照落在**所有下游注入者产出之后**——"wrap everything, append last"

原存疑的"最终顺序是推理"精确化为：**机制上，time-context 恒在尾部（除非有更早注册的 prepend 包装它）；跨 bundle 的精确先后是组合事实（base bundle patch 顺序），不是不变式**。存疑从"未验证"降级为"机制已证、组合顺序为部署事实"。

## 3. A13-7：是"严格"，不是"宽容"

`packages/skill/tool-skill/src/index.ts:348-359` 的 `readCatalogEntries`：

```ts
for (const entry of entries as readonly unknown[]) {
  if (typeof entry !== 'object' || entry === null) return undefined
  const { name, description } = entry as { ... }
  if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
  readable.push({ name, description })
}
```

**任何一条坏记录 → 整个目录返回 undefined**——不是"宽容跳过坏条目"。注释把姿态写明了：坏目录按"不是本插件的目录"处理（与 replaced-content digest 的姿态一致），**而不是在 step 监听器里抛错**（那会让该会话后续每个 turn 都失败）。

测试钉住这个语义（tool-skill.spec.ts:546）：

```text
it('treats a malformed durable catalog as unrecognizable instead of failing the step', ...)
```

与"模型可见 ⟺ 已记录"的张力如何解：**严格校验保证不重解释坏数据**（宁可整个目录不可识别），**降级而非抛错保证一个坏目录不拖垮会话**。张力通过"校验严格、失败温和"的二分消解——比原笔记的"宽容跳过"判断更精确。

## 4. A10-1：ACP 的停止原因归一

`packages/subagent/subagent-acp/src/run.ts:135-157` 的映射表（此前已读）：

```text
end_turn → completed · max_tokens → max-tokens · refusal → refusal
cancelled → aborted · max_turn_requests → error（无对等语义，任务未完成）
未知 → error
```

原存疑"max_turn_requests 与 max-tokens 的归一关系"：答案在映射的注释里——`max_turn_requests` 是 ACP 的"轮次请求数上限"，DSH 词汇里没有对等成员；**任务未完成不能伪装成完成**，归 `error` 是唯一诚实的选项。而 `max_tokens` 有对等成员（模型真命中 token 上限）。归一原则一句话：**有对等语义直通，无对等语义按"未完成"处理**。

## 5. 本篇消化的 backlog 项

- ✅ A13-5 pre-step 完整参与者清单（14 个真实注册者，修正原 18 的计数）
- ✅ A13-6 time-context 顺序（最外层包装器机制已证；跨 bundle 顺序为部署事实）
- ✅ A13-7 目录解析（修正为"严格校验 + 降级"，测试钉住）
- ✅ A10-1 ACP max_turn_requests 归一（无对等语义 → error，诚实原则）

## 6. 考古系列九期累计

```text
已消化 32/52 条：实证 bug ×2 · 证伪 ×7 · 缺口 ×2 · 设计债 ×2 · 选择/边界归档 ×19
剩余 20 条
下一期候选：A13-8（压缩区间同包目录+剪枝）、A14-2/3/4、A16-1/5/6/7/8、A09-1 已消化…见 backlog
```

## 7. 下一期预告

考古⑩候选：A14-2（session.seq 分配点）、A14-3（conversation 折叠引擎完整状态机）、A14-4（HMR rev 流程）、A16-5（invariant 同步限制）。
