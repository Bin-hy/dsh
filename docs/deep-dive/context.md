# 04 · 上下文工程：组装、压缩、溢出、技能

> DSH 的上下文工程可以概括为一句话：**一条日志、两层视图、一个请求**。日志是唯一真源，surface 是模型可见视图，请求由两者重建。本章拆解 system prompt 组装、compaction（压缩）、spill（溢出）、token 计量与技能系统。

## 1. 心智模型：一条日志、两层视图、一个请求

```text
┌──────────────────────────────────────────────────────────┐
│ ① append-only 会话日志                                     │
│   turn/start、user/message、assistant/chunk/message、     │
│   tool/result、request/header、compaction/start…end …      │
├──────────────────────────────────────────────────────────┤
│ ② surface（模型可见表层，派生视图）                          │
│   只保留三种"产消息"事件：user/message、assistant/message、 │
│   tool/result，按 surfaceOp 折叠；replace 遮蔽旧节点        │
│   .nodes = 当前可见 seq 列表；.replaceGeneration = 替换次数  │
├──────────────────────────────────────────────────────────┤
│ ③ 请求（GenerateOptions）                                  │
│   system（渲染后提示词）+ tools（schema）+                  │
│   messages（deriveMessages() 投影），深冻结后写回日志        │
└──────────────────────────────────────────────────────────┘
```

六条链路：**组装**（system prompt）→ **投影**（deriveMessages）→ **压缩**（compact）→ **剪枝**（prune）→ **溢出**（spill）→ **计量**（token meter）。

## 2. System Prompt 组装

`ctx.systemPrompt` 注册表合并四种贡献（`packages/core/system-prompt/src/index.ts:467`）：

| 类型 | 语义 | 排序约定 |
|---|---|---|
| **section** | 静态/函数式提示词段落 | `order` 升序：-100 harness 身份、0 persona、100-199 工具指南 |
| **context** | 动态上下文（sandbox 策略、approval 策略等） | 渲染为空则不贡献 |
| **tools** | 工具 schema 列表 | `toolOrder` 配置或字典序 |
| **variable** | <code v-pre>{{name}}</code> 插值变量（provider/model/cwd） | 全局先填，最近 scope 覆盖 |

组装流程（9 步）：取 scope 链 → 抑制检查 → 变量解析 → sections/contexts 合并（scoped 同名遮蔽 global）→ 工具 schema 收集（`structuredClone` 脱离）→ order 排序（`complete: true` 的段成为唯一段）→ `toolOrder` 排序 → **`system-prompt/assemble` waterfall**（监听器可改写 assembly，返回值权威）→ complete 段恢复。

渲染细节：严格 <code v-pre>{{name}}</code> 语法，变量名匹配 `^[a-z][a-z0-9_]*$`，**未知引用直接抛错**（fail loud，不静默留空）。

::: tip 面试要点：为什么工具 schema 是"每次请求重新投影"而不是启动时快照？
因为 scope 化注册表是动态的（restriction、preset 变化、subagent 派生）。`wireSchemas(context.scope)` 在每次 assembly 时求值当前 scope 可见工具——schema 变化立即反映到下一次请求，无需重启。
:::

## 3. 运行时上下文快照（Runtime Context）

`RuntimeContextProjection.project()`（`packages/core/agent-loop/src/runtime-context.ts`）负责动态上下文（如本会话开头那些 `<system-reminder>`）：

- 与上次保留值比对，**相同则不追加**（不会无限堆叠）
- 快照头部固定句："This snapshot supersedes earlier runtime-context snapshots"
- compaction 遮蔽旧快照时置 null——旧的被新的取代

## 4. 压缩（Compaction）：追加而非删除

DSH 压缩的核心思想：**日志绝不删除**。压缩只是追加一个带 `surfaceOp: {op:'replace', start, end}` 的 `user/message`（摘要检查点），把一段历史从 surface 遮蔽掉——原文永远在日志里。

### 4.1 两个触发点

| 触发 | 挂载点 | 语义 |
|---|---|---|
| **pressure（压力）** | `agent/pre-step`，**在 next() 之前** | 计量超过 `contextWindow × 0.8` 阈值 |
| **context-overflow（溢出）** | `agent/request-error` | provider 确认 `CONTEXT_WINDOW_EXCEEDED` |

为什么挂在这两个点：

- pre-step 时无新消息落地、请求未构建，替换旧表层**不影响本轮**；且每个请求前都有机会检查压力
- 溢出只有 provider 报错那一刻才知道，此时需要"恢复有进展"的证明才能重试

### 4.2 压力压缩的决策序列

```text
1. tokenMeter.measure() < threshold？ → 不压缩
2. 先剪枝（pruneSession）再重测     ← 模型无关的确定性缩减先行
3. 仍超阈值 → selectCompactableRange → compactRegion → 重测
4. 最多 compactionRetries + 1 次，仍超 → 抛错
```

### 4.3 范围选择：工具配对平衡

`selectCompactableRange`（`packages/compaction/compaction-basic/src/region.ts:98`）：

1. 从尾向前累计 token，**保留至少 retainTokens 的近期尾部**
2. 向前回退到最近一个**工具配对平衡**的切点——绝不切开 `assistant tool-call ↔ tool/result` 配对

配对平衡算法：增量折叠每个切点两侧的未完成 tool-call 数（assistant/message +N、tool/result −1），按 `replaceGeneration` 缓存。

### 4.4 摘要事务：日志事件即锁

单次压缩的完整事务（`region.ts:152`）：

```text
compaction/start   ← 锁！此后其它入口被 busy 拒绝
  → 摘要调用（复用会话前缀，KV cache 对齐）
  → compaction/summary（含 provider/model/usage/rawOutput）
  → user/message（checkpoint，surfaceOp: replace）← 唯一 surface 变更
compaction/end
```

三个工程细节：

1. **崩溃自检**：锁不是内存标志而是日志配对——"有 start 无 end" = 崩溃遗留锁，后续入口抛 `busy`；`session/end-seed` 之前的遗留 start 视为旧生命周期残留
2. **摘要必须更小**：`estimateMessage(checkpoint) < shadowedTokenCount` 否则抛错——防止"压缩反而变大"
3. **稳定性检查**：自动压缩要求整个 surface 在摘要期间不变（`isDeepStrictEqual` 比较 nodes）；手动压缩只要求所选 span 不变

### 4.5 溢出恢复：replaceGeneration 作为"进展证明"

```ts
// agent/request-error listener（compaction-basic/src/index.ts:179-223 逻辑）
const generation = agent.session.surface.replaceGeneration
compactIfNeeded(agent, 'context-overflow', signal)  // 溢出模式：跳过阈值、retainTokens=0
if (agent.session.surface.replaceGeneration > generation) return { kind: 'retry' }
```

**即使摘要阶段抛异常，只要剪枝的 replace 落地了（generation 前进），就返回 retry**——剪枝本身是"durable reduction"的充分证据。用日志状态而非内存状态判断恢复进展，这是本系统最漂亮的决策之一。

### 4.6 工具结果剪枝：模型无关的确定性缩减

`pruneSession`（`compaction-tool-result-pruner/src/index.ts:136`）：

- 超 `thresholdChars`（默认 8192）的 `tool/result` 内容 → 保留首 4096 + 尾 1024，中段替换为 `[... tool result middle pruned ...]`
- 剪切按 Unicode code point（不劈开 surrogate pair）
- 每个替换先追加 `compaction/prune` **影子价格事件**（声明被遮蔽内容的价格），紧接 replace 事件——纯消费方读到计量事件就减去价格，无需保留每节点状态

**为什么剪枝在摘要之前**：剪枝确定性、无模型调用、"必赢"；摘要可能失败（网络、max-tokens、变小校验）。先落地必赢的缩减，再让模型处理剩余部分。

### 4.7 摘要调用：KV cache 对齐

摘要请求 = **会话自己的 system + tools + 被遮蔽消息 + 压缩指令作为最后一条 user 消息**（`summarizer.ts:146`）：

- 这是上次真实请求的**前缀**，提供方前缀缓存不失效
- 指令是最后一条 user 消息而非独立 system prompt——保持"真实请求前缀"性质
- `purpose: 'compaction'` 标记辅助调用

## 5. Spill：工具输出溢出到文件

与剪枝的分工：**剪枝是日志内**（截断+marker），**spill 是跨请求持久**（全文进文件，模型只见定位符）。

流程（`packages/spill/spill-policy/src/index.ts:130`，挂在 `tools/post-execute`）：

```text
1. 纯文本结果 && bytes > maxInlineBytes？
2. ctx.spillStore.saveText({owner, source, suggestedName, content: 全文})
3. 预算预留：先估算 notice 字节数，从 cap 扣除后再分配 head/tail 预览
4. 替换 = 预览 + spillNotice（locator + 检索提示："用 read/grep 读该路径"）
```

安全细节：本地后端 `mkdtemp('dsh-spill-')` 0700；`open(path, 'wx', 0o600)` 排他写防符号链接植入；文件名经单射编码中和 `../`。

**best-effort 降级**：保存失败/无后端/notice 超 cap → 一律保留原始内联结果，**绝不把成功调用变成 isError**。宁可多占上下文，不可丢信息或破坏调用语义。

## 6. Token 计量：启发式 + usage 锚点

不用真实 tokenizer（成本高、路由变化失效），而是：

```text
启发式：4 字符/token + 块结构开销 4 + 消息角色开销 4
锚点：provider 真实 usage（input+cacheRead+cacheWrite+output）
规则：真实 usage ≥ 启发式锚点才采用 usage 基线，否则退回 estimated
```

- 纯日志折叠，O(增量事件) 均摊
- 有符号 delta 永远从"足够保守"的基线出发——不会低估
- 持久化为三个投影单元：`tokenUsage` / `contextPressure` / `contextBreakdown`
- UI 展示的是**"下一次请求预计占用"**（projectedTokens）而非上一次的实际值

## 7. 技能系统：上下文里只放摘要

分层注册表（`ctx.skills`）+ 本地文件发现 + 目录 digest 去重：

| 机制 | 实现 |
|---|---|
| 发现 | 6 类根目录按 rank 扫描（`.dsh/skills` 100 → bundled 600），`<name>/SKILL.md` 或 `<name>.md` |
| 重名 | scope 链最近层直接胜出；层内按 rank → 注册序 |
| 目录发布 | 只发 `name + description`（截断 500 字符），**绝不发正文** |
| 去重 | 按条目 digest（sha256）比对；digest 不变则从当前决策移除旧目录 |
| 正文加载 | `skill` 工具按需加载；`/name` 用户手势直接注入 |
| 生命周期 | `fs/observed` 事件同步失效；watcher 深度 1 监听 |

本会话开头的技能目录（`<available_skills>`）就是这么来的：目录 message 是 `form: 'catalog'` 的 user/message，结构化条目与模型可见文本并存。

::: tip 面试要点：目录为什么用"条目 digest"而不是文本 digest？
框架文案变化（比如改措辞）不该触发重发；条目级指纹（name+description 的 JSON sha256）只对内容敏感。digest 不变时把旧目录从当前步骤决策中移除——防止上下文堆叠多份目录。
:::

## 8. 面试要点汇总

::: tip 面试要点 1：surface 的 append 与 replace 各是什么？
append 进尾部；replace 把一段位置跨度换成新节点并 `replaceGeneration+1`。压缩/剪枝 = 追加 replace 事件，旧事件仍在日志——"修改"被建模为"追加+遮蔽"。
:::

::: tip 面试要点 2：为什么"影子价格协议"存在？
`compaction/prune` 事件紧邻 replace 声明被遮蔽内容的价格，纯消费方（UI/投影单元）读到就减去，无需保留每节点价格——把"压缩导致占用下降多少"变成 O(1) 日志读取。
:::

::: tip 面试要点 3：`shadowedRange.start > end` 可能吗？
可能。replace 落地的摘要节点 seq 是新的大数，但位置在旧区间。所以 `shadowedSeqs` 是权威集合，`shadowedRange` 只是位置跨度——按数值区间读会得出荒谬结论。
:::

::: tip 面试要点 4：压缩失败为什么只告警不阻断轮次？
压缩是策略不是流程（pressure 触发在 pre-step）。策略失败不能让对话中断——fail-loud 留给"摘要比原内容还大"这类配置错误（此时抛错），而 transient 失败（网络）保持 degrade。
:::

下一篇：[05 · 多代理编排](/deep-dive/orchestration)——subagent 提供方、受限 JS workflow、后台 jobs、持久 goal 循环。
