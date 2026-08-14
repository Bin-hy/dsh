# 设计模式手册：从 DSH 提炼的可迁移模式

> 面试官问"研究 DSH 学到了什么"时，最好的回答是**能迁移的设计模式**。这 12 个模式每一条都能脱离 DSH 用在其他 agent/后端/前端项目里。每条格式：模式 → 解决的问题 → 做法 → 代价 → 面试话术。

## 1. 事件溯源会话日志（Event-Sourced Session Log）

**问题**：agent 的对话历史、UI 回放、fork、恢复、遥测各需要一份数据，维护多份状态必然漂移。

**做法**：append-only 事件日志是唯一真源；所有派生视图（模型历史 `deriveMessages`、UI 快照、计量、标题）都是日志的纯函数折叠。修改被建模为"追加 + 遮蔽"（`surfaceOp: replace`），日志永不删除。

**代价**：日志体积膨胀；折叠逻辑要正确处理"位置替换"（`shadowedRange` 是位置跨度而非数值区间）。

**话术**："DSH 的会话日志是事件溯源：模型历史是从 `SessionEvent` 日志投影出来的视图，而不是独立维护的消息数组。'模型可见即已记录'是一条运行时不变量——任何到达模型请求的内容都能从日志重建。这解决了审计、崩溃恢复、fork 的一致性三难题。"

## 2. 能力 Seam（Capability Seam）

**问题**：可替换能力（LLM、文件系统、沙箱、子代理）如何做到"换实现不换接口、消费方零改动"？

**做法**：每个能力 = Service Definition（抽象类 + 词汇类型，拥有 `ctx.<key>`）+ 多个 Provider（可替换实现）+ Consumer（面向模型工具）。**单一角色不是 seam**。

**代价**：包数量多、层级深；要防止"一个 Consumer 说了算的服务契约"（逆味）。

**话术**："DSH 把每个能力拆成三角色。文件系统和进程提供方共享同一个执行世界，所以把两者指向远程沙箱，Bash、PTY、LSP 全部跟着搬过去，没有任何提供方专用 fork。这是依赖倒置在 agent 运行时上的完整落地。"

## 3. 可扩展瀑布 + 单调守卫（Waterfall + Monotonic Guard）

**问题**：策略拦截既要"可组合、可询问用户"（审批），又要"不可绕过"（安全规则）。一套机制做不到两者。

**做法**：双轨。`tools/pre-execute` waterfall 允许 allow/deny/ask 且顺序敏感；`ToolGuard` 只能返回拒绝 reason，**没有 allow 分支**，顺序无法翻案。owner 策略（沙箱模式检查）放守卫。

**话术**："DSH 把'可扩展'与'不可撤销'拆成两条轨道：瀑布式监听器可以做任意决策甚至询问用户，但顺序敏感；单调守卫只能拒绝，注册后顺序无法把拒绝翻回放行。安全策略走守卫，产品策略走瀑布。"

## 4. 中间件化的 Agent Loop（Loop as Event Middleware）

**问题**：agent 循环里的每一步（请求构造、流式输出、工具执行、轮次停止）都需要被观测/拦截，但不能硬编码策略。

**做法**：循环只做状态机（turn/step/inbox），所有决策点都是 waterfall 事件：`agent/pre-step`（决定模型看到什么）、`agent/request`（改写请求）、`llm/stream`（包装流）、`tools/*`（策略三段）、`agent/turn-stopping`（终止检查点）。**压缩、审批、沙箱、遥测全部是监听器，不是循环代码**。

**话术**："DSH 的循环本身没有特权：它只是把输入排空的状态机，每个决策点都发出 waterfall 事件。压缩挂在 pre-step、审批挂在 tools/pre-execute、超时包装 tools/execute——策略即插件，加新策略不改循环。"

## 5. 模型可见 ⟺ 已记录（Model-Visible ⟺ Logged）

**问题**：agent 审计的最强形式是什么？答案是"请求可以被日志重建"。

**做法**：新增模型可见输入必须新增会话事件；`request/header` 快照 system+tools+config；`assistant/chunk` 逐分片入库；**运行时不变量重算等式**（请求的 messages 必须等于 `deriveMessages()`）。

**话术**："DSH 把'可审计'做成机器可证的：`llm/stream` 上的运行时不变量重算'请求 = 日志纯函数'。新增模型可见输入而不加日志事件，构建就失败。这在金融级 agent 场景就是审计合规的基础。"

## 6. 先剪枝后摘要（Deterministic-First Cost Ladder）

**问题**：上下文超限时的恢复路径，模型调用（摘要）可能失败，怎么办？

**做法**：成本阶梯。计量（启发式，零成本）→ 剪枝（确定性、无模型调用、"必赢"）→ 摘要（模型调用，可能失败）→ spill（溢出到文件）。**先落地必赢的缩减，再让模型处理剩余**。恢复是否有进展用 `replaceGeneration` 是否前进判断——日志状态而非内存状态。

**话术**："DSH 的压缩是阶梯式的：超限先做模型无关的工具结果剪枝（保首尾、换中段），重测仍超才调模型摘要。因为剪枝是确定性的，即使摘要失败，恢复也已经有了持久进展——`agent/request-error` 靠 surface 替换代数是否前进决定要不要重试。"

## 7. 日志事件即锁（Log Events as Locks）

**问题**：分布式/崩溃场景下，并发互斥的锁放在内存里会怎样？崩溃后死锁。

**做法**：`compaction/start`…`compaction/end` 配对就是锁。"有 start 无 end" = 崩溃遗留锁 → 后续入口拒绝（busy）；旧生命周期的遗留 start 按 `end-seed` 边界识别为残留。**并发协议也记录在日志里**。

**话术**："DSH 的压缩互斥不靠内存标志，靠日志事件配对。崩溃留下的'有 start 无 end'可检测，这是事件溯源顺理成章的延伸——协议即日志。"

## 8. 有界委托 + 受限脚本（Bounded Delegation）

**问题**：模型生成代码（workflow 脚本）怎么跑才安全？

**做法**：**containment 而非 security**——worker 线程（防同步阻塞、可 force-terminate）+ vm 上下文只注入 6 个钩子（无 fs/网络/timer）+ 值离 realm 必物化纯 JSON + fatal 判定用宿主 realm `instanceof`（脚本伪造不了）。**信任边界在进程/线程边界，不依赖模型代码的善意**。

**话术**："DSH 的 workflow 引擎让模型写 JS 编排脚本，但脚本跑在 worker 线程的受限 vm 里，只有 agent/pipeline/parallel 等六个钩子。'代理干活，脚本只编排'——信任边界放在线程边界，模型代码崩溃也崩不坏宿主。"

## 9. 失败的类型化（Failures as Discriminated Unions）

**问题**：agent 系统的失败有几十种，字符串错误码 + try/catch 会失控。

**做法**：失败是判别联合。`SubagentResult.stopReason`、`ToolExecutionResult {isError, error:{name, code}}`、`WorkflowResult.stopReason`、`LlmFailure.code` 稳定机器路由码。消费方 switch 已知分支、default 按失败处理。**把失败做成类型系统可表达的联合**。

**话术**："DSH 把失败建模成判别联合而不是异常流：工具结果是 `isError` 布尔 + 结构化 error code 的联合，workflow 的 fatal 与逐项 null 用类型区分。消费方穷尽分支、未知变体默认失败——AI 系统的错误处理应该向编译器借力。"

## 10. 作用域化注册（Scoped Registration）

**问题**：多个 agent（含子代理）共用一个进程，工具/提示词/监听器怎么隔离？

**做法**：两层扁平作用域：全局 or 属于恰好一个 scope key（活跃 agent 即自身 scope 的 key）。scoped 注册遮蔽全局同名；restriction 只过滤继承面，**本 scope 自己的注册不受限**（子代理保留回报工具）。**不向下继承**——子树行为用 lineage 数据表达。

**话术**："DSH 的工具注册表按 agent 作用域分层：子代理默认看不到父代理的作用域注册，但父的 restriction 过滤不了子自己的注册——所以子代理总能保留自己的回报工具。shadowing 机制让同名工具可以在不同 agent 上有不同变体。"

## 11. 凭据只存引用（Credentials as References）

**问题**：密钥如何做到热轮换、不进日志/模型上下文、不被误持久化？

**做法**：配置里只有环境变量名（`CredentialRef`）；**每次操作重新解析**；key 只出现在传输层 header；错误只点名 ref 不回显值；遮蔽可拒绝（写会被环境遮蔽时直接报错）。

**话术**："DSH 的凭据系统只存引用不存值：配置和 cordis.yml 里是环境变量名，适配器在传输层才解析。热轮换、密钥与模型上下文物理隔离、'表面写入成功但被环境遮蔽'直接拒绝——三条纪律一条不少。"

## 12. 组合优于继承的构建面（Faces over Monoliths）

**问题**：同一批代码要给 Node 与浏览器两个运行时，怎么组织构建？

**做法**：host/client 双编译面；tsc 项目引用产出中间产物，tsdown 按 workspace 打包；类型图（Typert）在构建期生成，供 RPC 网关运行时反射。**源面与产物面从不混用**。

**话术**："DSH 的 monorepo 用双编译面解决 Node/浏览器同构：同一批 client 包产两份工件，RPC 描述符由 Typert 在构建期从 TS Program 生成——类型安全在构建期验证，运行时只有描述符解析。"

---

## 附：DSH 与 Claude Code 的架构差异（研究笔记提炼）

| 维度 | DSH | Claude Code |
|---|---|---|
| 会话真源 | append-only `SessionEvent` 日志，模型历史是投影 | 消息数组（JSONL 持久化） |
| 扩展点 | 类型化 Cordis 事件（waterfall/serial/emit）+ seam | hooks + MCP + skills |
| 工具策略 | pre/guard/around/post 四段 + 单调守卫 | 权限规则 + hooks |
| 循环 | 可替换插件（`agent-loop` 是默认实现） | 固化循环 + hooks 拦截 |
| 前端 | 插件化浏览器 Cordis（slot 系统） | 相对单体 React 应用 |
| 多代理 | 命名 Provider 注册表（进程内/ACP/Codex） | task 工具 + subagent |

下一篇：[高频面试题](/interview/qa)——50+ 题带答案要点。
