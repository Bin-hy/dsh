# 源码考古：两条"有测试"的证伪与一条设计债

> 第三季 · 第 7 期。三条审计都是"去测试目录里找答案"的示范：A09-6 的 reserve 相位机有专属 spec（~10 个用例）；A13-1 的批次内目录命中分支有专属测试（tool-skill.spec.ts:366）；A13-3 的 frozen-project-root 是**已被 TODO 承认的设计债**。共同方法论：**存疑的终点往往是测试文件——先 grep `tests/` 再下结论**。

## 1. A09-6：reserve 相位机覆盖——证伪

原存疑："preparations.ts 状态机的全部转换是否被测试覆盖？"

答案：`packages/session/session-persistence/tests/preparations.spec.ts` 是它的专属 spec：

```text
inspection 组（7 个用例）：
  共享 in-flight 后失效 / 首个观察者取消时共享 load 存活 /
  就绪前全部取消则驱逐 / 失败与失效的 in-flight 移除 /
  throw 早于返回 promise 的 load 移除 / 驱逐 ready 不动 reserved /
  只弃精确的 ready 源且保留独占 reservation
reservation 组（3+ 个用例）：
  等待既有 reservation、重发布精确 Session、attach 一次 /
  可中止的等待不取消被持有的 reservation /
  失败 commit 移除并以 invalidated 唤醒另一等待者
```

相位机的三个相位（loading → ready → committing → reserved）与失败/取消路径都有直接断言。存疑证伪——**测试覆盖比笔记推断的更完整**。

::: tip 方法论：先 grep tests/ 再问"有没有测"
研究笔记写存疑时往往只读了实现文件。审计的第一步应该是 `ls packages/<pkg>/tests/` + `grep 'it('`——很多"未验证"的存疑其实是被测试钉住的。这一步把"我以为没测"与"真的没测"分开，前者一分钟证伪。
:::

## 2. A13-1：批次内目录命中分支——证伪

原存疑："`existing`（当前决策里已有 skill-catalog 消息）的命中场景未验证。"

答案：`packages/skill/tool-skill/tests/tool-skill.spec.ts:366`：

```text
it('deduplicates or replaces a catalog already proposed for the same step', ...)
```

该分支的**去重/替换行为**有专属单元测试。顺带一个更重要的发现——同文件 `:588`：

```text
it('re-establishes the current catalog after compaction hides its durable message', ...)
```

**A13 的核心机制（遮蔽后重发布完整目录）在仓库里有直接测试**——第 13 章文章讲的那条恢复协议，不是文档推断，是被测试钉住的当前事实。

剩余的诚实边界：`existing` 分支在**真实生产**中的触发者（被拒步骤的重提/子代理续传/外部种子）没有集成测试——但分支行为本身已测。存疑从"行为未验证"降级为"触发场景未穷举"。

## 3. A13-3：frozen-project-root——被承认的设计债

`packages/context/agent-instructions/src/state.ts:265-266`：

```ts
// TODO(frozen-project-root): retain the baseline root for the loop instance;
// recomputing it after marker edits reinterprets the existing relative scope keys.
```

债的本体：scope 键是 `目录\u0000候选文件名`，**从 project root 派生**。project root 变化（marker 文件如 `.git` 被编辑/移动）后重算 root，会让既有的相对 scope 键被重新解释——旧缓存键与新路径错位。

现状（`:263-268`）：`cwd = session.header.cwd ?? process.cwd()`，`projectRoot = options.projectRoot ?? findProjectRoot(...)`——没有"冻结基线 root"。TODO 承认了债，但给出了两个缓解事实：普通 agent 带绝对 cwd（`v8 ignore` 注释），且发现是逐次调用的。

结论：**真实设计债**，影响面是"marker 编辑 + 相对 scope 键"的组合场景，TODO 已承认。适合作为低优先级 issue（附 TODO 的精确语义）。

## 4. 本篇消化的 backlog 项

- ✅ A09-6 reserve 相位机覆盖（**证伪**：专属 spec ~10 用例 + coordinator contract）
- ✅ A13-1 批次内目录命中（**部分证伪**：分支有专属测试，触发场景未穷举）
- ✅ A13-3 frozen-project-root（设计债确认，TODO 已承认，低优先级 issue 候选）

## 5. 考古系列七期累计

```text
已消化 24/52 条：证伪 5 条、实证 bug 2 个、缺口 2 个、选择归档 6 个、测试已覆盖 2 个、设计债 2 个、边界确认 5 个
剩余 28 条：A09-1(已)…详见 backlog
下一期候选：A10-4/5/6（ACP 能力声明、codex 通知窗口、claude 设置源）、A13-2/5/6/7/8
```

## 6. 下一期预告

考古⑧候选：A10-4（ACP clientCapabilities 空对象影响）、A10-5（codex commitTurnId 放行窗口）、A10-6（claude settingSources 省略语义）、A13-2（workspaceContextMessage 保留动机）。
