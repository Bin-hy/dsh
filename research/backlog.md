# 存疑项 Backlog：持续深挖清单

> 来自 `research/01~06-*.md` 各笔记第 7 节的 56 条存疑/待确认项，已按主题聚类。
> 每个聚类映射一篇计划中的新文章（编号沿用博客深度拆解序列）。
> 状态：`⬜ 未开始` / `🔬 研究中` / `✅ 已消化`。消化后请在对应笔记第 7 节更新状态。

## A09 · 会话持久化内核 ✅（已消化 → deep-dive/persistence-kernel）

- 持久化完整写路径：`write-behind.ts` 有界批量窗口之外还有哪些持久化点（dispose drain？）（01#3）
- `session-persistence-jsonl/format.ts` 的 `packChunkRuns` chunk 打包行编码细节（01#3）
- SQLite 后端的 `SCHEMA_VERSION` 迁移机制（01#3）
- 崩溃修复的 `interruptedTurnClosers`（repair.ts）（01#3）
- `session-projection-cache` 的消费语义：缓存行 + 持久化尾部回放、水位检查点（01#10）

## A10 · 进程外子代理与 ACP ✅（已消化 → deep-dive/out-of-process）

- `subagent-acp` / `subagent-codex` / `subagent-claude-code` / `subagent-dsh-sdk` 四个进程外 Provider 未逐行展开（04#3）
- 进程外传输的 run id 语义（`localAgent: undefined`）未经运行验证（04#3）
- ACP 服务器（packages/acp）与 approval 桥接的完整细节

## A11 · 作用域与事件内核 ✅（已消化 → deep-dive/scope-events）

- vendored Cordis `waterfall` 实现：`args.pop()` innermost next、dispatch thisArg 移位（01#1）
- scope carrier 的 `[Context.filter]` 与 waterfall 交互时序（01#1）
- `ScopedLayers.effect()` 与 Cordis effect 返回身份、HMR 重载层回收的精确行为（02#2）
- `whenIdle()` 的竞态面：活动退休前启动替代工作的窗口（01#2）
- listener snapshot 先于 log push 解析、回调后于提交运行的确切时序（01#1）

## A12 · 终端与 PTY ✅（已消化 → deep-dive/terminal-pty）

- `LocalPtySession` 的提示符检测、就绪推断、scrollback、持久会话所有权（02#8）
- `node-pty` spawn 与 UTF-8 传输、前台进程组、TERM→KILL 停稳细节（02#8）
- `terminal-bash` 的 sandbox 模式 fence 与 `terminal_*` 六工具族

## A13 · 技能系统深入 ⬜

- `skill-badge` 的具体行为（bundled rank 600 徽章提供方）（03#4）
- 技能目录与 compaction 的精确交互时序（目录被遮蔽后重建）（03#11）
- `agent-instructions` 的 `workspaceContextMessage` 渲染格式（state.ts）（03#7）

## A14 · 前端渲染内核 ⬜

- API Proxy 内部：`api-proxy.ts`、`src/fetch/`、Host 侧帧发射点（06#2）
- `session/subscribed.lastSeq` 与 history 尾页 `projections` 块的 Host 发射顺序（06#9）
- `web-react/scoped-slots.tsx`（909 行）渲染器完整实现（06#3）
- `ui-slots/store.ts` 的 `defineStore`/immer 快照引擎（06#4）
- vendored Cordis Loader 的 `tree.import`/`internal` 契约细节（06#5）
- Electron 路径（`file://` + IPC 桥）是否存在于仓库（06#7）

## A15 · 调度、命令与会话引用 ⬜

- `schedule/` 的 `domain.ts` 严格解码（decodeScheduleChange/foldScheduleEvents/resolveEveryOccurrence）（04#4）
- `command-goal`（/goal 命令）与 `commands` 包本体（04#7）
- `tool-ask-user` 与 `user-questions` 的交互细节（04#7）
- `session-reference`（recall form）的投影/预算算法（`retainReferencedSession`、`DEFAULT_MAX_REFERENCE_BYTES`）（03#5）

## A16 · 重试、凭据与 LLM 补遗 ⬜

- `llm-retry` 插件本体：与适配器级重试的分工边界、重试是否产生新 chunk（01#4）
- `tests/retry.spec.ts`：同 step 内非重试失败后新请求失败的语义、policyKey 代际（05#6）
- `credentials/updated` 事件只服务 UI 的设计（进程环境变化永不发事件）（05#8）
- `FIXME(call-config-shape)`：epoch 级字段的最终归属（05#2）
- `BlockAssembler.message()` 默认 source 与 loop 用法的区别（05#4）
- usage 分片"最多一次且必须在 finish 前"的 invariant 契约假设（05#9）

## A17 · 编排补遗 ✅（已消化 → deep-dive/orchestration-supplement）

- fork 可继续模式被刻意关闭（TODO fork-continuable-prefix-reuse + issue #2124）（04#1）
- `goal-round-driver/prompt.ts` 与 `tool-goal/wrapup.ts` 的渲染措辞（04#2）
- workflow 并发上限 `0 = min(16, max(1, cores-2))` 自动解析语义（04#5）
- subagent lifecycle.ts 与 workflow emitWorkflowEvent 的监听器隔离差异（04#6）
- `agent/inbox/spliced` 跨压缩/跨持久化的行为验证（04#8）

## A18 · 启动、组合与沙箱补遗 ✅（已消化 → deep-dive/boot-sandbox-supplement）

- launcher 身份注入点：谁实际 `ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY)`（01#5）
- `watchUserPatches` 与 `composeLive` 的 HMR 热重载、structuredClone 别名陷阱（01#6）
- Landlock prebuilds 矩阵、`--probe` 输出契约（02#4）
- `windows-acl` runner 本体（runner.ts/lib/runner.js 选择与 argv 契约）（02#7）
- `dsh-agent-tool-presentation` 的 presentAs/preset 组合路径（02#5）
- `fs/write-intent` 单槽瀑布多监听器的先到先得冲突行为（02#6）

## A19 · 测试体系与 Typert 产物 ⬜

- `apps/web` 三层 GUI 测试体系与 `produced-files.overlay.yml` overlay 机制（06#8）
- `typert.generator` 的 `emitter.ts`/`renderer.ts` 产物形状（06#6）
- `tools/execute` 包装器全家桶：文档提及 retry/metrics 但仓库未定位（02#3）

## A20 · compaction 与计量补遗 ✅（已消化 → deep-dive/compaction-meter-supplement）

- compaction 在 pre-step 瀑布内嵌套 `ctx.llm.stream()` 的重入语义（是否绕过 deriveMessages 不变式）（01#8）
- `compaction/end` flush 失败（persistence）路径的 error 字段持久化（03#6）
- `/compact` 命令与 goal 轮次的并发交互（03#9）
- `estimateHeader` 是否计入 ROLE_OVERHEAD 的计费口径一致性（03#2）
- `renderPrompt` 的 `{{` 字面散文分支边界（03#12）

## 附：已消化/已解决的项

- `llmRetryPolicyOf(stream)` 文档滞后 → 以代码为准（`preparedCall.retryPolicy`），已写入博客（05#1）
- pi-ai 错误分类脆弱性 → 已作为"脆弱性圈在适配器边界"写入博客（05#3）
- `attributionHeaders` user-agent 小写 → 协议约定非疏漏，已写入博客（05#7）
- timeout-policy 改名 FIXME → 纯命名问题，不阻塞（05#5）
- fs/subprocess/shell types.ts 行号 → 已交叉核对 docs type-equiv（02#1）
- TokenMeasurement 字段名 → 已与 measure() 返回值交叉验证（03#1）
- compaction-basic README 完整措辞 → 依据 config.ts 默认值已写（03#3）

---

**消化规则**：每消化一个聚类，新增/更新对应博客文章并在其文末"存疑与深入方向"打勾，然后独立 commit 推送。

## 第二轮存疑（消化过程中新发现的）

> A09 消化时新发现的 7 条（源自 `research/07-persistence.md` §7），暂归 A09 附属，后续可并入新聚类：

- ⬜ A09-1 积压（pending）无内存上界：高频事件流下 write-behind 的 pending 数组可无限增长
- ⬜ A09-2 串行化链尾清理：按 id 的 promise 链在会话退役后是否及时释放
- ⬜ A09-3 JSONL 全量解析放大：无 `loadStoredFrom` 的后端冷读必须解析全量再切片
- ⬜ A09-4 索引搜索时对账滞后：搜索进行中发生写入的对账窗口
- ⬜ A09-5 缓存回写无版本仲裁：投影缓存 putSoft 与并发恢复的竞态
- ⬜ A09-6 reserve 相位机覆盖：preparations.ts 状态机的全部转换是否被测试覆盖
- ⬜ A09-7 跨进程并发写未防御：两进程同时写同一 JSONL 会话的行为

> A10 消化时新发现的 9 条（源自 `research/08-outofproc.md` §7）：

- ⬜ A10-1 ACP `max_turn_requests` 与 `max-tokens` 的归一关系是否完整
- ⬜ A10-2 不对称映射：codex `interrupted → error` vs ACP `cancelled → aborted`——是否有意
- ⬜ A10-3 SDK 无线上取消：超时/dispose 只本地结算，服务器侧轮次继续跑的语义
- ⬜ A10-4 ACP 客户端 initialize 声明的 clientCapabilities 为空对象的影响面
- ⬜ A10-5 codex turn/completed 早到通知的 commitTurnId 放行窗口
- ⬜ A10-6 claude-code SDK 流消费中 `settingSources` 故意省略的宿主设置语义
- ⬜ A10-7 dsh-sdk 子进程的持久化/cordis.yml 与父进程的隔离边界
- ⬜ A10-8 subprocess seam 的"SDK 托管传输"例外是否还有第二个使用者
- ⬜ A10-9 四传输 dispose 宽限默认值的配置来源与调优依据

> A11 消化时新发现的 4 条（源自 `research/09-scope-events.md` §7）：

- ⬜ A11-1 `internal/listener` 类型声明落后：声明 `prepend: boolean`，实际分发传 `EventOptions` 对象（events.ts:349 vs :296）
- ⬜ A11-2 潜在崩溃路径：`DisposableList` 无 `unshift`——非 global 的 `ctx.on('internal/update', fn, {prepend:true})` 会走 fiber._hooks 的 unshift 而崩溃（utils.ts:5-40）
- ⬜ A11-3 `fiber._hooks` 在 `_unload` 从不清理：Group 的 update 监听器跨重载存活（推断刻意，未实证）
- ⬜ A11-4 `whenIdle` 收敛为推演证明，未见穷举并发测试
