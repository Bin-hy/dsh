# 高频面试题：Agent 框架方向

> 按四类组织：概念题（考理解）、源码题（考深度）、系统设计题（考迁移）、场景题（考实战）。每题给答案要点，括号里标注证据来源章节。

## 一、概念题

### Q1. DSH 说"一切皆插件"，Agent Loop 本身也是插件，怎么理解？
**要点**：loop 是挂在 `ctx.agentLoop` 的默认实现（`ReactLoopAgent`）；扩展包依赖 `dsh-agent` 的事件与服务而非该包；组合包 `dsh-base` 只是第一层 patch，其上任何条目都可被覆盖。**没有需要打补丁的特权内核**。

### Q2. turn 和 step 的区别？一个 turn 里没有 step 可能吗？
**要点**：turn 是排空已接纳输入的过程，step 是一次模型请求+工具执行。可能——`agent/pre-step` 拒绝或首次 enter 改写为空时，仍关闭一个无步骤的持久轮次，日志记录这次尝试。

### Q3. waterfall 事件的 `next()` 语义？
**要点**：环绕中间件。调 `next()` 委托下游、返回值可被本层包装；不调直接 return = 短路（单决策事件的设计意图）。纯观察者必须委托。

### Q4. 会话事件、Agent 事件、能力事件三个域怎么选？
**要点**：事实必须重载后仍存在 → 会话事件（追加日志+广播）；观察/拦截进行中工作 → `agent/*`；给 seam 挂策略避免 import 循环 → `fs/*`、`tools/*`。架构决策第一问。

### Q5. "模型可见即已记录"是什么？为什么重要？
**要点**：到达模型请求的一切必须能从日志重建，运行时不变量断言。否则回放、审计、fork、恢复全部失效。新增模型可见输入 = 必须新增会话事件。

### Q6. 能力 seam 的三个角色？为什么"单一角色不是 seam"？
**要点**：Service Definition（抽象类+词汇，非 TS interface）/ Provider / Consumer。只有一半会导致"一个 Consumer 说了算的服务契约"或无人可替换的假抽象。

### Q7. sandbox 的三种模式管什么？为什么 SandboxPolicy 不含 danger-full-access？
**要点**：只管文件效果：read-only / workspace-write / danger-full-access。danger-full-access 语义是"消费方根本不调 confine"——把它当策略值会造成"沙箱包装空操作"的假象。

### Q8. goal 的 phase 与 activation 为什么分离？
**要点**：phase（active/paused/blocked/complete）是持久事实；activation（armed/disarmed）是进程本地意愿。session-start 自动 disarm——旧目标不会在新会话里偷偷续跑，必须显式 resume。

## 二、源码题

### Q9. 工具执行流水线的完整顺序？
**要点**：materialize（快照+冻结+collapse 判定）→ `tools/pre-execute`（allow/deny/ask）→ guard 链（只减权限）→ approval（allowed-once）→ `tools/execute`（around：timeout 替换 signal）→ 函数体 → `tools/post-execute`（accept/block/替换）→ `finalizeContent`（快照回调，只改 content）→ materialize+freeze → `tools/result`（同步观察，不可改写）。

### Q10. 工具并发调度：exclusive barrier 和 parallel rolling pool 是什么？为什么"提交前重分类"？
**要点**：executionMode 分类（只有 `isConcurrencySafe(args)===true` 才并行）；exclusive 单组成屏障；parallel 进容量 `maxParallelToolCalls` 的滚动池。reclassify 让注册表/守卫在提交间隙的变更即时生效。提交按模型顺序（`commitReady` 只推进连续前缀）。

### Q11. 取消时为什么给未启动的工具合成"aborted before dispatch"结果？
**要点**：日志不变量：每个 `tool/call` 必须配对 `tool/result`。合成结果让取消后的日志依然完整合法——回放器、UI、deriveMessages 都依赖配对。

### Q12. compaction 的锁如何实现？崩溃后如何恢复？
**要点**：`compaction/start`…`compaction/end` 日志配对即锁；"有 start 无 end" = 崩溃遗留锁 → busy；`session/end-seed` 之前的遗留 start 视为旧生命周期残留。

### Q13. 溢出恢复为什么看 `surface.replaceGeneration` 是否前进？
**要点**：replaceGeneration = 已提交位置替换的持久计数。剪枝或摘要的 replace 落地（代数前进）→ 重试从新表层出发；否则盲目重放同样溢出的旧请求。**用日志状态而非内存状态证明进展**。

### Q14. 摘要调用如何省 KV cache？
**要点**：请求 = 会话自己的 system + tools + 被遮蔽消息 + 压缩指令作为最后一条 user 消息——上次真实请求的**前缀**，提供方前缀缓存不失效。

### Q15. workflow 的 fatal 错误怎么区分？为什么脚本伪造不了？
**要点**：`WorkflowError.fatal` 布尔；`isFatalWorkflowError` 用**宿主 realm 的 instanceof** 判定——脚本 realm 的类无法通过宿主的 instanceof。fatal 杀脚本，普通错误逐项 null。

### Q16. 凭据如何防泄漏？四层分层是什么？
**要点**：配置只存环境变量名；每次操作解析；key 只进传输层 authorization 头；错误只点名 ref。分层：进程环境 > `$DSH_HOME/.credentials.yaml`(0600) > 项目 `.env` > 用户 `.env`。

### Q17. 前端为什么"带状态帧全量快照 + session/event 增量"混合？
**要点**：queue/jobs/projection 是 last-wins 派生状态，全量重发自愈；日志帧是追加事实只能增量。`session/subscribed` 携带基线水位支持重连。

## 三、系统设计题

### Q18. 设计一个 agent 的会话持久化，要点？
**要点**（DSH 答案）：append-only 事件日志唯一真源；派生视图是纯函数折叠；修改=追加+遮蔽（surfaceOp: replace）；请求信封（system+tools+config）写 `request/header`；运行时不变量重算"请求=日志纯函数"；未知事件 fail-loud 拒绝重建；备份后端换实现不换事件词汇。

### Q19. 设计 agent 的工具权限系统，要点？
**要点**：双轨策略（可扩展瀑布 allow/deny/ask + 单调守卫只减权限）；fail-closed（未知工具=exclusive、无审批通道=拒绝、沙箱缺失=不裸跑）；升级严格变宽+allowed-once 单次授权；策略对模型可见（模型知道限制才能正确重试）。

### Q20. 设计上下文压缩，要点？
**要点**：成本阶梯（计量→剪枝→摘要→spill）；触发点选 pre-step（策略不打断流程）与 request-error（溢出恢复）；切点工具配对平衡；摘要必须更小（校验）；剪枝先行的确定性收益；恢复进展用持久代数证明。

### Q21. 设计多代理编排，要点？
**要点**：委托原语（one-shot）+ 可继续对话（Activation 驻留纪元，inbox 唯一队列）；冷恢复折叠描述符不经 Provider；所有权图 child-first 释放；脚本编排跑受限 vm（containment 非 security）；失败类型化（fatal vs null vs stopReason）；子代理不能问用户（无人可答会永久阻塞）。

### Q22. 设计一个浏览器端 agent 控制台，要点？
**要点**：非对称传输（HTTP 上行+WS 下行）；帧协议"快照帧全量+日志帧增量"；数据对象层零 React（uSES 订阅）；增量折叠引擎（node definition 状态机）；slot 系统组合 UI；信任围栏（DNS rebinding）；启动图注入+rev 哈希缓存失效。

## 四、场景题

### Q23. 模型在只读沙箱写文件被拒，如何设计完整重试闭环？
**要点**：拒绝标记带模式名 → 模型同命令+sandbox_permissions+justification 重试 → 工具层执行前 approveEscalation（严格变宽检查→审批→allowed-once 授权本次调用）→ granted mode 只盖本次 policy 不写入会话。

### Q24. 给所有工具加审计日志，动哪里？
**要点**：监听 `tools/pre-execute` / `tools/result`（scope 过滤），**不动 agent-loop**。这就是"插件，不改循环"。

### Q25. 如何给子代理只开放部分工具？
**要点**：父 scope `tools.restrict({allow: [...]})`——只滤继承面；子自己的注册不受限（回报工具还在）。toolFilter 是可见性（prompt 消失+拒绝执行一体）。

### Q26. 发现 agent 陷入重复工具调用循环，怎么破？
**要点**：观察而非否决——`repeat-tool-reminder` 在 post-execute 计数（canonical 参数串），命中阈值注入提醒（additionalContexts），用户消息重置。保持 loop 自由度，用模型可见提示打破循环。

### Q27. 一个长任务需要后台执行并随时读取进度，怎么设计？
**要点**：jobs seam——生产方注册（controller 门禁）；`readOutput()` 增量语义；first-wins 结算 + `reported` 记账位防重复通知；完成通知最后投递（reporter 可能同步开轮次）；teardown 取消一律标 reported。

### Q28. 如果让你给 DSH 加一个 `weather` 工具，完整步骤？
**要点**（详见[实战篇](/practice/extend)）：新包 `dsh-tool-weather` → `defineTool`（schema+output+execute）→ 插件 apply 里 `ctx.tools.register` → system prompt 自动注入 schema → REAL-composition 测试 + keyless snapshot → README Model Experience 格式。

---

## 冲刺建议

1. **每章选 2 个"源码题"讲出代码级细节**（事件名、类型、行号级理解），这比背概念杀伤力大得多
2. **每个模式准备一句"话术"**（见[设计模式手册](/interview/patterns)），面试时自然抛出
3. **准备 3 个"权衡故事"**：为什么剪枝先于摘要、为什么 vm 是 containment 不是 security、为什么 goal 的 activation 不持久化——这类"为什么"是最能体现深度的回答
4. 面试前把[核心概念](/guide/concepts)的术语表过一遍，准确使用 seam/scope/turn/step/surface 这些词本身就是信号
