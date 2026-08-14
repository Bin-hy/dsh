# 上游 Issue 素材包

> 第三季"源码考古"产出的可提交上游的 issue 清单。每个 issue 都经过：源码定位 → 最小复现/测试对照 → 影响面确认 → 修复建议。
> 提交时按仓库拆：`DisposableList` 与类型滞后 → `deepseek-ai/DeepSeek-Harness`（vendor/cordis）或 `cordiverse/cordis`；README 文档滞后 → `deepseek-ai/DeepSeek-Harness`。

## 已就绪（可直接提交）

### 1. [cordis] 非 global 的 `internal/update` prepend 注册崩溃（高价值 · 已运行时复现）

- **素材**：[issue-cordis-disposablelist-unshift.md](./issue-cordis-disposablelist-unshift.md)
- **证据**：vendored 4.0.0-rc.7（`events.ts:141-145` + `utils.ts`）+ 发布版 4.0.1（`lib/index.js:238`）同源确认；最小复现输出 `TypeError: ... is not a function`
- **严重性**：潜伏（当前无生产触发者），任何未来非 global prepend 注册者在插件加载期 TypeError，错误信息不指向根因
- **博客**：[考古① · §1](https://deepseek-docs.pages.dev/deep-dive/archaeology-1)

### 2. [cordis] `internal/listener` 类型声明落后于实现（低危 · 纯类型）

- **证据**：`events.ts:349` 声明 `prepend: boolean`，`:296` 实际分发 `EventOptions` 对象（`:290` 布尔归一化，`:140` 拦截器按对象解构）
- **严重性**：无运行时影响（两侧按对象一致），但类型系统对 `internal/listener` 拦截器的参数说了谎
- **修复**：声明改为 `options: EventOptions | boolean`
- **博客**：[考古④ · §1](https://deepseek-docs.pages.dev/deep-dive/archaeology-4)

### 3. [harness] `llm-retry` README 与实现不符："opens a retry turn"（文档 bug）

- **证据**：README.md:5/11 说 "closes the failed turn and opens a retry turn"；`agent.ts:339-371` 的 `while(true) continue` 与 `retry.spec.ts:795` 断言（step/start 仅 1 条）证明重试在同一 (turn, step) 内
- **修复**：README 改为 "retries the request within the same step: new `assistant/chunk` events are logged, failed attempts never enter the final message's `sourceEventSeqs`"
- **博客**：[考古① · §2](https://deepseek-docs.pages.dev/deep-dive/archaeology-1)

## 候选（需进一步验证后提交）

### 4. [harness] `SessionWriteBehind.pending` 无内存上界（真实缺口 · 中危）

- **证据**：`write-behind.ts:44-58` enqueue 无长度/字节检查；持续写失败 + 事件持续到达 → pending 线性增长
- **修复方向**：字节数上限 + 背压 + flush 显式报告
- **博客**：[考古③ · §2](https://deepseek-docs.pages.dev/deep-dive/archaeology-3)

### 5. [harness] skill-badge 默认 disabled 无注释（文档小债）

- **证据**：`packages/bundle/base/cordis.patch.yml:243-245` 无任何理由说明
- **博客**：[考古⑤ · §4](https://deepseek-docs.pages.dev/deep-dive/archaeology-5)

## 提交建议

1. **优先级**：#1 > #4 > #3 > #2 > #5
2. **仓库选择**：#1/#2 若提交 cordiverse/cordis，需先确认上游 master 是否已修复（vendor 4.0.0-rc.7 是旧版本）；提交 DSH 仓库时注明"vendored 源码 + 发布版 4.0.1 均复现"
3. **证据附件**：附最小复现脚本（本目录的复现输出已在 issue 素材中）
4. **提交后**：在对应博客文章底部加"已提交上游：issue #N"链接，形成闭环
