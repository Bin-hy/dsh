# 上下文工程与技能系统研究笔记

> 研究对象：DeepSeek Harness（`deepseek-harness/`，只读）。
> 主题：提示词组装、session 投影（deriveMessages）、compaction（压缩）、spill（溢出存储）、token 计量、技能系统。
> 证据格式：所有代码引用均标注 `文件路径:起始行`，指向真实源码。文档依据 `docs/subsystems/*.zh.md`。
> 本笔记供撰写教学博客使用；观点标注为「设计解读」的是推理，其余为代码事实。

---

## 1. 概念地图

### 1.1 核心心智模型：一条日志、两层视图、一个请求

DSH 的上下文工程建立在一条铁律上：**会话日志（append-only event log）是唯一事实来源，模型看到的一切都必须能从日志重建**（AGENTS.md："Model-visible ⟺ logged"）。围绕它有三层结构：

```
┌────────────────────────────────────────────────────────────┐
│ ① append-only 会话日志（session log）                        │
│    所有事件：turn/start、user/message、assistant/chunk、     │
│    assistant/message、tool/result、request/header、          │
│    compaction/start|summary|end|prune …                      │
├────────────────────────────────────────────────────────────┤
│ ② surface（模型可见表层，派生视图）                           │
│    只保留三种"产消息"事件：user/message、assistant/message、  │
│    tool/result，按 surfaceOp 折叠；replace 会遮蔽旧节点       │
│    session.surface.nodes = 当前可见 seq 的有序列表            │
│    session.surface.replaceGeneration = 替换次数（单调）        │
├────────────────────────────────────────────────────────────┤
│ ③ 请求（GenerateOptions）                                    │
│    system（渲染后的提示词组装）+ tools（schema 列表）          │
│    + messages（deriveMessages() 从 surface 投影）             │
│    整体被深冻结，作为 request/header 快照写回日志              │
└────────────────────────────────────────────────────────────┘
```

- **日志**：`packages/core/session/src/types.ts:236`（`SessionEventMap`）、`:404`（`SessionEvent`）。
- **surface**：`packages/core/session/src/surface.ts:15`（三种 surface 事件类型）、`:372`（`SurfaceOp`，types.ts）。
- **请求**：`packages/llm/llm/src/types.ts:320`（`GenerateOptions`）。

### 1.2 上下文工程六条链路

1. **组装（assemble）**：`ctx.systemPrompt` 注册 sections / contexts / tools / variables，每次模型步骤前组装出 `PromptAssembly`，再渲染成 `system` 文本（`packages/core/system-prompt/src/index.ts:467`）。
2. **投影（project）**：`session.deriveMessages()` 把 surface 节点逐个投影为 `Message[]`，作为请求的 messages（`packages/core/session/src/index.ts:726`）。
3. **压缩（compact）**：压力或溢出触发时，把一段历史替换为一个摘要节点（`packages/compaction/compaction-basic/src/index.ts:258`）。
4. **剪枝（prune）**：模型无关地裁掉超大工具结果的中段，保留首尾（`packages/compaction/compaction-tool-result-pruner/src/index.ts:136`）。
5. **溢出存储（spill）**：超大纯文本工具结果保存到文件，模型只见定位符 + 检索提示（`packages/spill/spill-policy/src/index.ts:130`）。
6. **计量（measure）**：`ctx.tokenMeter.measure()` 用启发式 + provider usage 锚点估算请求压力（`packages/llm/token-meter/src/index.ts:116`）。

### 1.3 术语表

| 术语 | 含义 | 出处 |
|---|---|---|
| surface | 模型可见事件序列，由日志折叠而来 | `packages/core/session/src/surface.ts:137` |
| surfaceOp | 事件进入 surface 的方式：`append` 或 `{op:'replace',start,end}` | `packages/core/session/src/types.ts:372` |
| replaceGeneration | 已提交的位置替换计数（单调），压缩/剪枝每落地一次 +1 | `packages/core/session/src/surface.ts:141` |
| shadowed | 被 replace 遮蔽（从 surface 移除）的节点集合 | `packages/compaction/compaction/src/types.ts:37` |
| shadow price | 被遮蔽内容的启发式 token 价格，由紧邻的计量事件声明 | `packages/compaction/compaction/src/types.ts:81` |
| compaction checkpoint | 压缩生成的替换 user/message，带 `compact` 来源标记 | `packages/compaction/compaction/src/checkpoint.ts:19` |
| spill locator | spill 后端返回的面向模型不透明句柄 | `packages/spill/spill/src/types.ts:18` |
| runtime context | 动态上下文快照（`snapshot` form 的 user/message） | `packages/core/agent-loop/src/runtime-context.ts:13` |

---

## 2. 模块与文件地图

### 2.1 包一览

| 包（@deepseek-ai/dsh-…） | 角色 | 关键文件 |
|---|---|---|
| `core/session` | 日志 + surface + deriveMessages | `src/surface.ts`、`src/index.ts`、`src/types.ts` |
| `core/system-prompt` | 提示词组装注册表 | `src/index.ts` |
| `core/agent` | Agent 句柄、`agent/*` 事件、runMaintenance | `src/runtime-types.ts`、`src/index.ts` |
| `core/agent-loop` | 轮次/步骤驱动、请求拼装、runtime context | `src/agent.ts`、`src/runtime-context.ts` |
| `llm/llm` | Message/ContentBlock 词汇、StreamChunk、GenerateOptions、BlockAssembler | `src/types.ts`、`src/message.ts`、`src/assembler.ts`、`src/call-config.ts` |
| `llm/token-meter` | 启发式 token 计量 + usage 锚点 + 投影单元 | `src/index.ts`、`src/estimate.ts`、`src/surface-fold.ts`、`src/usage-projection.ts` |
| `compaction/compaction` | 压缩 Service Definition（`ctx.compaction`）+ 事件词汇 | `src/index.ts`、`src/types.ts`、`src/tool-pairing.ts`、`src/checkpoint.ts` |
| `compaction/compaction-basic` | 默认压缩后端（压力策略、保留尾部、摘要） | `src/index.ts`、`src/region.ts`、`src/summarizer.ts`、`src/config.ts` |
| `compaction/compaction-tool-result-pruner` | 模型无关工具结果剪枝（`ctx.toolResultPruner`） | `src/index.ts`、`src/config.ts` |
| `compaction/command-compact` | 用户侧 `/compact` 命令 | `src/index.ts` |
| `spill/spill` | spill Service Definition（`ctx.spillStore`） | `src/index.ts`、`src/types.ts` |
| `spill/spill-local` | 本地文件后端 | `src/store.ts`、`src/index.ts` |
| `spill/spill-policy` | `tools/post-execute` 溢出策略 | `src/index.ts` |
| `skill/skill` | 技能注册表（`ctx.skills`） | `src/index.ts` |
| `skill/skill-filesystem` | 本地 SKILL.md 发现/加载/watcher | `src/index.ts` |
| `skill/tool-skill` | 会话目录 + `skill` 工具 + `/name` 手势 | `src/index.ts` |
| `skill/skill-badge` | 随包徽章提供方（bundled rank 600） | `src/index.ts` |
| `context/agent-instructions` | 工作区 AGENTS.md 指令上下文 | `src/index.ts`、`src/render.ts`、`src/state.ts` |
| `context/time-context` | 时钟上下文（opt-in） | `src/index.ts` |
| `context/tmux-context` | tmux 位置上下文（opt-in） | `src/index.ts` |
| `context/session-reference` | 跨会话引用/回忆（recall form） | `src/index.ts` |

### 2.2 主线调用链速查（一次模型步骤）

```
agent.preStep()                          agent-loop/src/agent.ts:225
├─ inbox.claim()                         （领取唤醒消息）
├─ systemPrompt.assemble()               agent.ts:230 → system-prompt/index.ts:467
├─ renderContextSections/join            agent.ts:232-233
├─ runtimeContext.project()              runtime-context.ts:64（与上次快照比对，去重）
└─ waterfall 'agent/pre-step'            agent.ts:234
   ├─ compaction-basic: compactIfNeeded('pressure')  ← 在 next() 之前运行
   ├─ tool-skill: 技能目录 digest 比对 + 注入目录消息
   ├─ tool-skill: /name 手势 → skill 正文注入
   └─ agent-instructions: 工作区指令折叠进 messages
turn() → append 'turn/start'             agent.ts:255
  step() → append 'step/start'           agent.ts:279
    append user/message(decision.messages) agent.ts:283
    buildRequest():                      agent.ts:407
      ├─ systemPrompt 渲染 renderPrompt   agent.ts:337
      ├─ deriveMessages()                agent.ts:341 → session/index.ts:726
      ├─ prepareCall()（解析模型能力）     agent.ts:449
      ├─ append 'request/header'         agent.ts:466（system+tools+config 快照）
      ├─ append 'request/context'        agent.ts:482（provider/model/contextWindow）
      └─ 深冻结 GenerateOptions          agent.ts:486
    llm.stream() → assistant/chunk* → assistant/message  agent.ts:343-390
    executeToolCalls() → tool/result     （下一步骤循环）
  append 'step/end'                      agent.ts:292
append 'turn/end'                        agent.ts:319
```

---

## 3. 关键类型与接口

以下为真实类型定义片段（省略部分 JSDoc），均标注源码位置。

### 3.1 会话事件与 surface 词汇

**三种可上表事件**（`packages/core/session/src/surface.ts:15`）：

```ts
const SURFACE_EVENT_TYPES = new Set<string>([
  'user/message',
  'assistant/message',
  'tool/result',
])
```

**SurfaceOp**（`packages/core/session/src/types.ts:372`）：

```ts
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }
```

**SurfaceIntent**（`packages/core/session/src/types.ts:380`）：`surfaceOp` 必填 + 可选 `sourceEventSeqs`（被引用/被遮蔽的 seq 集合）。replace 事件要求 `sourceEventSeqs` 包含全部被遮蔽节点（surface.ts:239 校验）。

**SessionEvent**（`packages/core/session/src/types.ts:404`）：带 `seq`（单调）、`time`、`data` 的可辨识联合；仅 SurfaceEventType 事件可携带 `surfaceOp`/`sourceEventSeqs`（`:423-435`）。日志中事件 `ignorable` 标记缺省为「必须理解」——未知事件拒绝重建（`:412-422`）。

**Session.surface**（`packages/core/session/src/surface.ts:137`）：`{ nodes: readonly number[]; replaceGeneration: number }`，`SurfaceManager`（`:398`）增量维护。

### 3.2 提示词组装词汇（`packages/core/system-prompt/src/index.ts`）

**PromptSection**（`:53`）：

```ts
export interface PromptSection {
  readonly name: string          // 唯一名，重复注册抛错
  readonly order: number         // 升序拼接；约定 -100=harness 身份、0=persona、100-199=工具指南
  readonly text: string | ((context: AssembleContext) => string)
  readonly complete?: boolean    // 为 true 时成为唯一提示词段落
}
```

**PromptContext**（`:78`）：动态上下文贡献，`order` 升序，渲染为空文本则不贡献。

**PromptAssembly**（`:115`）：

```ts
export interface PromptAssembly {
  sections: AssembledSection[]   // 未插值
  contexts: AssembledContext[]
  tools: ToolSchema[]            // 已按规范顺序
  variables: Record<string, string | undefined>
}
```

**AssembleContext**（`:42`）：`{ scope?: ScopeKey; signal?: AbortSignal }`，可合并扩展，`dsh-agent` 增加 `agent` 字段（`assembleContextFor`）。

**ToolProviderResult**（`:104`）：`{ schemas: ToolSchema[]; knownNames?: string[] }`——knownNames 是限制前的名称全集，用于区分「拼写错误」与「有意隐藏」。

**renderPrompt / renderContextSnapshot / joinContextSections / renderContextSections**（`:212` / `:224` / `:236` / `:251`）：sections 按 `{{variable}}` 插值（`interpolate`，`:258`，未知/无值引用抛错）、去空、`\n\n` 拼接；runtime context 快照的头部是固定句 "Current runtime context. This snapshot supersedes earlier runtime-context snapshots."（`:239`）。

**Config**（`:186`）：`includeHarnessIdentity`（默认 true，注册 `harness:identity`，order -100）、`includeRuntimeContext`（默认 true）、`persona`（order 0 的部署人设模板）、`toolOrder`（含 `<unlisted-tools>` 占位，`TOOL_ORDER_REST`，`:140`）。

### 3.3 LLM 消息词汇（`packages/llm/llm/src/types.ts`、`message.ts`）

**ContentBlockMap**（types.ts:99）：`text | reasoning | image | tool-call | tool-result`，可合并扩展——新模态必须同时具备 adapter、UI、compaction 支持。

**Message**（message.ts:129）：`{ id, role: 'system'|'user'|'assistant', content: ContentBlock[], source: MessageSource }`，不可变且冻结。

**MessageSource / ContextForm**（message.ts:100 / :48）：source.kind 回答「谁产生」；`form` 回答「什么类型的信息」——`instructions | catalog | snapshot | notice | relay | recall`，语义性词汇，呈现由消费方决定。

**StreamChunk**（types.ts:291）：封闭可辨识联合（`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`），`index` 关联交错 delta。

**GenerateOptions**（types.ts:320）：provider/model/messages/system/tools/temperature/maxTokens/stop/signal/sessionId/purpose。`purpose?: 'compaction' | 'session-title'` 标记辅助模型调用（types.ts:355）。

**TokenUsage**（types.ts:135）：互不重叠的记账：`inputTokens` 仅未缓存输入；`cacheReadTokens`/`cacheWriteTokens` 单列；`reasoningTokens` 已含于 `outputTokens`。

**LlmCallConfig**（call-config.ts:23）：provider/model/reasoningEffort/temperature/maxTokens/stop——请求的「信封」，记录进 `EpochHeader`。

**EpochHeader**（`packages/core/session/src/types.ts:201`）：`{ config: LlmCallConfig; adapterDefaults?; system?; tools? }`——记录渲染后的完整 system 与工具列表，使请求可由日志重建。

### 3.4 压缩词汇（`packages/compaction/compaction/src/types.ts`）

**compaction/* 会话事件**（`:16-89`，声明合并进 `SessionEventMap`，全部仅写日志、不上 surface）：

- `compaction/start`：`{ compactionId, turn: number | null }`——锁的起点；`turn` 数字=自动轮次内，`null`=独立手动事务（`:23`）。
- `compaction/summary`：`{ summary, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens?, usage?, rawOutput?, llmStreamCall? }`（`:33-66`）。
- `compaction/end`：`{ compactionId, turn, error? }`——释放锁（`:71`）。
- `compaction/prune`：剪枝的影子价格事件，声明被遮蔽节点价格，必须与紧随其后的 replace 同步相邻（`:81-88`）。

**CompactionResult**（`:93-119`）：`compactionId / startSeq / summarySeq / endSeq / summary / shadowedRange / shadowedSeqs / shadowedTokenCount`。`shadowedRange` 是**位置跨度**而非数值区间——替换后新节点 seq 可能大于其位置之后的旧节点 seq（`:107-113`）。

**CompactionTrigger**（index.ts:25）：`'pressure' | 'context-overflow'`。
**ManualCompactionErrorCode**（index.ts:28）：`busy | cancelled | changed | summary | commit | persistence`。

**PrunedEntry / PruneResult**（`packages/compaction/compaction-tool-result-pruner/src/types.ts:21/35`）：单条替换的原始/替换 seq、callId、字符数前后；整体字符削减量。

### 3.5 Token 计量词汇（`packages/llm/token-meter/src/types.ts`）

**TokenMeasurement**（types.ts:13 附近，文档 token-meter.zh.md:12-27）：`{ logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes: TokenSurfaceNode[] }`。
**TokenSurfaceNode**（types.ts:35）：`{ seq, tokens }`——按位置定价的 surface 节点，深克隆返回，O(surface)。
**baseline**：`{kind:'usage'|'estimated'|'none'}`——见 §4.6。

### 3.6 技能词汇（`packages/skill/skill/src/index.ts`）

```ts
export interface SkillProvider {                       // :248
  readonly name: string
  readonly list: (options: SkillLookupOptions) =>
    Promise<readonly SkillCandidate[] | SkillProviderObservation>
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) =>
    Promise<SkillDefinition | undefined>
}
export interface SkillProviderControl {                // :271
  readonly signal: AbortSignal
  readonly invalidate: () => void
}
export interface SkillCandidate extends SkillSummary { // :74
  readonly rank: number        // 层内重名时 rank 小者胜
  readonly locator: unknown    // 提供方私有句柄
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}
export interface SkillSummary {                        // :56
  name: string; description: string; whenToUse?: string
  invocation: SkillInvocationPolicy
  source: SkillSource; provider: string; resourceBase?: SkillResourceBase
}
export interface SkillInvocationPolicy {               // :48
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}
```

**SkillSource**（`:39`）：`'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled'`——提示可见的元数据，本身不决定优先级。
**renderSkillContent**（`:171`）：渲染 `<skill_content name=…>` + `<skill_resources>` + `<skill_instructions>` 的规范形状，工具结果与用户手势注入共用。
**SkillRegistry**（`:357`）：`registerProvider`（`:391`，同步注册进调用方 scope 层）、`register`（`:440`，runtime 技能）、`list/snapshot/get`（`:471/:482/:501`）。

### 3.7 spill 词汇（`packages/spill/spill/src/types.ts`、`index.ts`）

- `SpillStore`（index.ts:45）：唯一抽象方法 `saveText(input): Promise<SpillRef>`；保存失败必须 reject，由调用方决定降级。
- `SaveTextSpill`（types.ts:56）：`{ owner: {sessionId}, source: {toolName, callId, label}, suggestedName, content }`。
- `SpillRef`（types.ts:69）：`{ locator: SpillLocator, bytes, retrievalHint }`——消费方按 `retrievalHint` 渲染，不解析 locator。

---

## 4. 执行流程

### 4.1 提示词组装（assemble）流程

`SystemPrompt.assemble()`（`packages/core/system-prompt/src/index.ts:467-542`）的步骤：

1. **取 scope 链**：`this.layers.chainLayers(scope)`（`:469`），global 层 + 观察 scope 的祖先链。
2. **运行时上下文抑制检查**：任一层的 `runtimeContextSuppressors` 非空则 contexts 置空（`:470-471`）。
3. **变量解析**：global 变量先填，再按「最远祖先 → 最近」覆盖，最近者胜（`:473-482`）。
4. **合并 sections/contexts**：`this.layers.merge(scope, …)`——scoped 条目同名遮蔽 global（`:484-485`）。
5. **工具 schema 收集**：global + scope 链上所有 tool provider 依次求值；`parameters` 用 `structuredClone` 脱离（`:487-503`）；knownNames 合并用于 toolOrder 校验。
6. **排序与 complete 处理**：sections 按 `order` 升序；`complete === true` 的段多于一个则抛错（`:504-508`）。
7. **工具排序**：`orderTools()`（`:164-178`）——配置了 `toolOrder` 则按列表排放，未列出的在 `<unlisted-tools>` 处按字典序插入；未配置则纯字典序（`compareToolNames`，`:181`）。
8. **跑组装瀑布**：`ctx.waterfall(scopeTarget(this, scope), 'system-prompt/assemble', assembly, context, …)`（`:532-535`）——listener 可改写 assembly，返回值权威。
9. **complete 段恢复**：waterfall 之后若存在 effective complete section，则把它恢复为唯一 sections（`:536-541`）；若有 runtime 抑制，contexts 强制为空。

**渲染**：`renderPrompt(assembly)`（`:212-217`）逐个 `interpolate`（`:258-295`）——严格 `{{name}}` 语法，变量名必须匹配 `^[a-z][a-z0-9_]*$`，未知引用直接抛错（fail loud，而非静默留空）；`{{` 后无 `}}` 视为字面散文。

**工具 schema 注入**：`dsh-tools` 的注册表构造时注册 `ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))`（`packages/core/tools/src/index.ts:832`），每个 assembly 时求值当前 scope 可见的工具 schema。工具自身的指南段落以 order 100-199 的 section 注册（tools/src/index.ts:834-836 的 `collapseSection`/`sdkSection` 示例）。

**在 loop 中的调用点**：`agent.preStep()` 第 230 行 `await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))`，随后渲染 runtime context 快照（`:232-233`），再进入 `agent/pre-step` 瀑布（`:234`）。

### 4.2 deriveMessages：从日志投影模型历史

**surface fold**（`packages/core/session/src/surface.ts`）：

- 折叠规则：事件带 `surfaceOp: 'append'` 则 push 到 `nodes` 尾部；带 `{op:'replace',start,end}` 则把 `[startIdx, endIdx]` 区间替换为自身 seq，`replaceGeneration += 1`（`:362-379`）。
- 校验：replace 的 start/end 必须是当前 surface 节点；`sourceEventSeqs` 必须包含每个被遮蔽节点（`:239-243`）；`tool/result` 替换只能改 content（`assertToolResultRewrite`，`:287-318`）。
- `foldSurface(events)` 全量重建（`:387`）；`SurfaceManager` 增量维护（`:398-459`），`nodes`/`replaceGeneration` 为惰性增量读取。

**每节点投影规则** `deriveEventMessage`（`surface.ts:83-114`）：

- `user/message` → `event.data`（原样，不含任何附加框架——框架由生产者烤进 content，见 `:89-95` 注释）；
- `assistant/message` → 空 content 返回 `null`（仅承载 max-tokens usage 的步骤不得进入历史），否则 `event.data.message`（`:99-105`）；
- `tool/result` → `event.data.message`（`:106-108`）；
- 其余（chunk、边界、日志型）→ `null`（`:109-113`）。

**缓存**（`packages/core/session/src/index.ts:726-747`）：每个 surface 节点只投影一次；`replaceGeneration` 变化（任何 replace 落地）才整体重建缓存；返回新数组但共享冻结的 Message 对象。因此 deriveMessages 的均摊成本是 O(新节点)。

**哪些进入 / 哪些被剪枝**：进入 = 三种 surface 事件（且 assistant 非空）。被剪枝 = (a) 非 surface 事件天然不进；(b) compaction/prune 的 `tool/result` replace 把旧节点遮蔽；(c) compaction 的 `user/message` replace 把整段历史遮蔽为摘要节点；(d) 空 content 的 assistant/message 被投影为 null。

### 4.3 compaction 时序

#### 4.3.1 pressure 触发：agent/pre-step（串行、先于请求推导）

`BasicCompactionEngine._registerAutomaticCompaction()`（`packages/compaction/compaction-basic/src/index.ts:137-165`）注册 `agent/pre-step` listener，**在调用 `next()` 之前**执行 `compactIfNeeded(agent, 'pressure', signal)`——即压缩先于其它 listener 的决策与请求推导（agent.ts:234 瀑布中，谁先注册谁先跑，但压缩自身不依赖决策结果）。失败仅告警（`TargetPressureConfigError` 只警告一次），绝不让压缩故障中断轮次（`:155-162`）。

**压力判定**（`compactIfNeeded`，index.ts:258-332）：

1. `routedTarget(session)`：取最近一次持久化 `request/header` 的 provider/model（`:52-60`）；无则返回 null（不压缩）。
2. 解析目标模型的策略 `resolveTargetPolicy`（config.ts:105），并从 `ctx.llm.resolveModelInfo()` 取 `contextWindow`（index.ts:293）；无 contextWindow 抛 `TargetPressureConfigError`（要求配置 adapter 的 contextWindow）。
3. `resolveCompactSpec(policy, contextWindow)`（config.ts:133-167）：`thresholdTokens = floor(window × thresholdRatio)`，`retainTokens = floor(window × retainRatio)` 或绝对 `retainTokens`。
4. `measurement.totalTokens < thresholdTokens` → 不压缩（index.ts:304）。
5. **先剪枝再重测**：若 `ctx.get('toolResultPruner')` 存在，先 `pruneSession()` 落地模型无关剪枝，再 `measure()`（index.ts:308-311）；仍低于阈值则返回。
6. 循环 `selectCompactableRange(agent.session, measurement, spec.retainTokens)` → `compactRegion(...)` → 重测；最多 `compactionRetries + 1` 次（index.ts:315-326）；仍超阈值则抛错（`:328-331`）。

**范围选择** `selectCompactableRange`（`region.ts:98-134`）：

- 校验 meter 的 surface 与 session.surface 一致（`:106-110`）。
- 从尾向前累计 token，保留至少 `retainTokens` 的近期尾部（`:112-119`）。
- 向前回退到最近一个**工具配对平衡**的切点（`:122-127`），保证不切开 `assistant tool-call ↔ tool/result` 配对。
- 返回 `[首节点, cutoff]` 位置跨度（`:130-133`）。

**配对平衡** `toolPairingBalancedBefore/After`（`packages/compaction/compaction/src/tool-pairing.ts:117/129`）：增量折叠每个 surface 切点两侧的未完成 tool-call 数（`assistant/message` +N 个 tool-call，`tool/result` -1，`:29-38`），按 `replaceGeneration` 缓存（`:77-97`）。

#### 4.3.2 context-overflow 触发：agent/request-error

`agent/request-error` listener（index.ts:179-223）：

1. 仅当 `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` 且未取消（`:183`）；记录 `overflowAgents`（session→agent）。
2. 取 `routedTarget` 与策略；`maxOverflowRetries` 耗尽则放弃（`:185-189`）。
3. 记录当前 `agent.session.surface.replaceGeneration`（`:191`）。
4. 调 `compactIfNeeded(agent, 'context-overflow', signal)`——溢出模式**不检查阈值**、`retainTokens = 0`，强制一次有用的平衡缩减（index.ts:283-291：先剪枝 → 重测 → 选范围 → compactRegion）。
5. 判定「surface replacement generation 前进」：`agent.session.surface.replaceGeneration > generation` 时返回 `{ kind: 'retry' }`（`:218-222`）——压缩真的替换了表层才值得重试请求；即使剪枝落地后摘要阶段抛异常，只要 replaceGeneration 前进就仍返回 retry（`:197-208` 注释：模型无关剪枝本身就是「durable reduction」的充分证据）。取消永远优先。
6. 成功的 assistant 消息或 agent 回到 idle 会重置重试计数（`:167-177`）。

失败步骤的恢复顺序：loop 在 `step()` 中 `finish.kind === 'error'|'aborted'` 时派发 `agent/request-error`（agent.ts:354-371），返回 `{kind:'retry'}` 则 `continue` 重新 buildRequest。

#### 4.3.3 compactNow：手动 /compact（空闲维护）

`command-compact`（`packages/compaction/command-compact/src/index.ts:58-78`）调 `ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)`。

`compactNow`（compaction-basic/index.ts:368-420）：

- `agent.runMaintenance(...)`（agent 能力，runtime-types.ts:104）——agent 必须空闲；同步抛 `busy`（index.ts:413-419）。
- 不检查压力阈值，直接 `selectCompactableRange(session, measure, 0)`（`:379-384`）。
- `compactSurfaceRegion(..., { owner: null, stability: 'selected-span', flush: sessions.flush })`（`:385-400`）——owner null = 独立手动事务（`turn: null` 标记对）；提交后 flush 持久化。
- 失败分类为 `ManualCompactionError`：`cancelled` / `changed` / `summary` / `commit` / `persistence`（`throwManualFailure`，region.ts:257-277）。

`runMaintenance` 的语义：同步占用空闲相位，后续唤醒输入留在 inbox 直到维护任务结束（runtime-types.ts:95-104）——手动压缩期间排队的提示词按 FIFO 在其后开始。

#### 4.3.4 compactSurfaceRegion 事务（region.ts:152-254）

单次压缩的完整事务，日志事件即锁：

1. `validateSurfaceRegion`（`:315-336`）：start/end 必须是当前 surface 节点、顺序正确、前后切点都工具配对平衡。
2. `inspectCompactionEntryState`（`:517-549`）：倒扫日志找出 open turn、未匹配的 `compaction/start`、最新 `session/end-seed` seq。
3. `assertCompactionInactive`（`:286-298`）：存在未匹配 start 且其 seq 晚于 end-seed → 抛 `busy`（锁已激活）；end-seed 之前的未匹配 start 是旧生命周期残留，忽略。
4. 追加 `compaction/start`（`:189`）——**这是锁**：此后任何异步摘要期间，其它入口都会被 busy 拒绝。
5. `prepareCompaction`（`:339-357`）：meter 重测、切片 selectedNodes、计算 `shadowedTokenCount`、`buildSummarizationInput`（`:498-514`：`request/header` 的 system+tools + 被遮蔽 seq 逐个 `deriveEventMessage` 的消息，作为摘要调用的前缀）。
6. `summarizeCompaction`（`:360-384`）：调 summarizer；构造 checkpoint user message（`compactCheckpointSource(compactionId)`）；**校验摘要比被遮蔽内容小**（`estimateMessage(checkpoint) < shadowedTokenCount`，否则抛错——防止「压缩反而变大」）。
7. 稳定性检查（`:190-192` + `:386-424`）：`whole-surface`（自动）要求整个 surface 与摘要前一致（`isDeepStrictEqual` 比较 nodes）；`selected-span`（手动）只要求所选 span 仍是同一组连续、等价、平衡的替换目标——摘要期间注入的无关上下文不失效。
8. `commitCompactionBody`（`:427-478`）：同步追加 `compaction/summary`（含 provider/model/maxTokens/usage/rawOutput）→ 立即追加 `user/message`（checkpoint，`surfaceOp:{op:'replace',start,end}`，`sourceEventSeqs:[startSeq, summarySeq, ...shadowedSeqs]`）——**这是唯一 surface 变更**。
9. 追加 `compaction/end`（`:215`）；失败路径也追加带 `error` 的 `compaction/end`（`:220-228`），保证「有 start 无 end」= 崩溃遗留锁，可检测。
10. 手动模式可选 flush（持久化检查点，`:231-237`）。

**可重建性**：`compaction/summary` 记录 provider/model/maxTokens/usage 与 `llmStreamCall: true` 标记（带完整 `rawOutput`）——摘要调用可由日志+代码重建（types.ts:33-66）。

#### 4.3.5 工具结果剪枝（pruneSession）

`ToolResultPruner.pruneSession(session)`（`packages/compaction/compaction-tool-result-pruner/src/index.ts:136-184`）：

1. 对当前 surface 快照中每个 `tool/result` 事件，取 `message.content[0]` 的 content 测字符数（Unicode code point，非 UTF-16 单元，`:68-74`）。
2. 超 `thresholdChars`（默认 8192）则 `pruneContent`（`:83-122`）：保留 `headChars`（默认 4096）首部 + `tailChars`（默认 1024）尾部，中段替换为 `PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'`（config.ts:7）；非文本块原样保留、顺序不变；剪切按 code point 保证不劈开 surrogate pair。
3. 每个替换先追加 `compaction/prune` 影子价格事件（`shadowedTokenCount = tokenMeter.estimateMessage(原消息)`，`:162-166`），**紧接着**追加 `tool/result` replace 事件（`:167-173`）——影子价格协议：纯消费方可「前一个计量事件减去被遮蔽价格」而无需保留每节点状态（types.ts:81-88）。
4. 替换只能改 content（surface 层的 `assertToolResultRewrite` 兜底校验，surface.ts:287-318）。
5. 返回 `PruneResult { pruned, charsRemoved }`；中途失败时已提交的替换保持持久（index.ts:180-182）。

**为什么剪枝在摘要之前**：见 §5.3。剪枝是纯确定性操作（无模型调用），先落地一个「必赢」的缩减，再让摘要处理剩余部分——模型调用失败也不至于一事无成。

#### 4.3.6 摘要生成（summarizeWithLlm）

`summarizer.ts:121-182`：

- 目标解析：`summarizationProvider/Model` 配置 → 最近路由的 provider/model → agent options（`:128-138`）。
- **KV cache 复用**：请求 = 会话自己的 `system` + `tools` + 被压缩区域的消息 + 作为**最后一条 user 消息**的 `COMPACTION_INSTRUCTION`（`:146-163`）——因为这是上次真实请求的**前缀**，提供方缓存不失效（summarizer.ts:24-30 注释）。
- `purpose: 'compaction'` 标记辅助调用（`:161`）；`maxTokens` 由配置（默认 8192）。
- 结果：`BlockAssembler` 组装 → `summaryText` 仅保留 text 块、拒绝图像（`:217-224`）→ `SummaryResult` 带 `rawOutput` 与 `llmStreamCall: true`。
- 指令模板（`:31-66`）：8 节 Markdown 结构（Primary Request / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context）；已有 `<compacted-summary>` 块时合并而非原样复制（`:65`）。
- 替换消息的框架（`frameSummary`，`:189-195`）：`CHECKPOINT_PREAMBLE`（"automatically generated checkpoint… treat as established background"）+ `<compacted-summary>` 标签包裹摘要文本。

#### 4.3.7 「surface replacement generation」的含义

`session.surface.replaceGeneration` 是日志中**已提交位置替换的次数**（surface.ts:141，`SurfaceManager` 每次 replace +1）。在 `agent/request-error` 恢复中它被当作「这次恢复是否真的改变了表层」的持久证据（compaction-basic/index.ts:191/201/219）：摘要调用可能失败，但只要剪枝或摘要的 replace 落地了（generation 前进），重试请求就从新表层出发，而不是盲目重放同样会溢出的旧请求。这回答了「失败恢复怎么证明进展」——用日志状态而非内存状态。

### 4.4 spill：工具输出溢出到文件

**触发**（`packages/spill/spill-policy/src/index.ts:190-209`）：`tools/post-execute` 瀑布（prepend 注册），仅处理 `accept` 且无 `value` 替换的纯文本结果；跳过 `read` 工具（避免 read→spill→read 循环，`:197`）。

1. `flattenPlainText(content)`：任何非文本块 → 不处理（`:80-87`）。
2. `totalBytes > maxInlineBytes`（UTF-8 字节）→ `spillReplacement`（`:130-188`）：
   - 无 agent/session owner 或未加载 `ctx.spillStore` → 保留原样并告警（`:138-146`）。
   - `ctx.spillStore.saveText({ owner:{sessionId}, source:{toolName,callId,label}, suggestedName:'<tool>.txt', content: 全文 })`（`:147-155`）。
   - **预算预留**：先用「最坏情况 omission 数字」估出 notice 字节数 + 2 字节换行，从 cap 中扣除后再分配 head/tail 预览预算（`:171-173`）——保证「预览+notice」整体不超 cap。
   - 替换 = `预览(head/tail)` + `\n\n` + `spillNotice`（含 locator 与 retrievalHint，如「使用 read 或 grep 读取该路径」，spill-local 后端提供）。
   - 若 notice 本身超 cap（极小 cap 或超长路径）→ 保留内联（`:183-186`）；**保存失败 → 保留原始内联结果，绝不把成功调用变成 isError**（`:156-161`，best-effort）。
3. 替换结果作为 `{kind:'accept', content:[text]}` 返回（`:207-208`）——模型只见预览+引用，完整文本躺在文件里。

**本地后端**（`packages/spill/spill-local/src/store.ts`）：

- `privateRoot()`：OS tmpdir 下 `mkdtemp('dsh-spill-')`，0700（`:27-30`）。
- `sessionDir(root, sessionId)`：`sha256(sessionId)` 前 12 位 → `session-<hash>` 子目录（`:73-76`）。
- `saveTextFile`：文件名 = 6 字节随机 hex + 经 `encodeSegment` 消毒的 suggestedName（`:107-119`）；`open(path, 'wx', 0o600)` 排他+仅属主可写，防符号链接植入（store.ts:96-106 注释）。
- `encodeSegment`（`:48-63`）：单射的路径段编码（`~XXXX` 转义），中和 `../`、绝对路径、NUL。

**第二个臂**：`tools/code-dispatch-log` 瀑布把 `tool/code-dispatch` 事件中 `run_code` 子调用的超大结果副本也替换为预览+定位符（`:217-231`）——程序返回值不受影响，仅日志副本变薄，replay/UI 经 spill 产物读全文。

### 4.5 技能系统流程

#### 4.5.1 注册与发现

- `skill-filesystem` 插件在 `apply()` 中 `ctx.skills.registerProvider(control => new FileSystemSkillProvider(...))`（`packages/skill/skill-filesystem/src/index.ts:130-135`）——注册是同步 effect，disposer 随 fiber 卸载。
- **root 表**（`roots()`，:241-261）：`<projectRoot>/.dsh/skills`(rank 100)、`<projectRoot>/.agents/skills`(200)、`customSkillDirs`(300)、`$DSH_HOME/skills`(400, 跳过 `.system`)、`$AGENTS_HOME/skills`(500)、`bundledSkillDir`(600)。`findProjectRoot` 向上找含 `.git` 的祖先，优先走 `ctx.fs` 服务（:937-947）。
- **发现**（`list()`，:182-198）：逐 root `discoverRoot`（:719-747）——目录包 `<name>/SKILL.md` 与扁平 `<name>.md` 都接受；`parseSkillFile`（:793-835）解析 YAML frontmatter（`---` 包裹，:909-921），缺 name/description 的忽略并告警。
- **调用策略**（`parseInvocationPolicy`，:992-1002）：frontmatter 键 `disable-model-invocation` 与 `user-invocable`，缺省均 true。
- **watcher**：Chokidar 监视（depth 1，稳定阈值 200ms），缺失根从最近祖先逐段跟踪（:436-450）；`fs/observed`（模型 write/edit 工具）同步失效目录（:139-142）。

#### 4.5.2 注册表合并

`SkillRegistry.collect`（`packages/skill/skill/src/index.ts:520-550`）：

- 缓存键 = `{cwd, scope链, revision}`（:644-646）——scope 链参与键，空会话重组无需注册表变更即可被看到。
- `collectFresh`（:552-566）：global 层先行，再按「最远祖先 → 最近」叠加，`merged.set(name, entry)`——**最近层的同名条目直接胜出**；rank 只裁决层内重名。
- `collectLayer`（:568-583）：层内排序 `rank → providerOrder → localOrder`（`compareIndexedCandidates`，:807-811），同名前缀忽略。
- 不完整观测（provider.list 抛错或并发目录修订）：`cacheable=false`，结果可用但**不缓存**（:585-620）；代次变化重试一次（`MAX_COLLECT_ATTEMPTS=2`，:534-539）。
- `get(name)`（:501-518）：重新校验 kebab-case → 取获胜候选 → `provider.get(candidate)`（带 abort race）→ 校验定义 → 名称与候选不符则失效该条目。

#### 4.5.3 目录发布与注入（tool-skill）

`dsh-tool-skill` 注册两个 `agent/pre-step` listener（`packages/skill/tool-skill/src/index.ts`）：

**目录 listener**（:213-251）：

1. 校验本插件的 `skill` 工具定义在当前 scope 仍可见（`ctx.tools.get(...) === skillTool`，:220）——被遮蔽/受限则不发目录。
2. `ctx.skills.snapshot({cwd, signal, scope: agent})`（:222）；不完整快照保留上一份视图（:225）。
3. 过滤 `isModelInvocable`，条目只含 `name` + 规范化、XML 转义、截断到 500 字符的 `description`（:227，`catalogDescription`，:391-394）。
4. **digest 比对**：`digestCatalogEntries` = 每个条目 `JSON.stringify([name, description])` 逐行 sha256（:328-335）——对**条目**而不是渲染文本做指纹，因为框架文案变化不该触发重发。
5. 与「日志中最新一条仍可见的目录消息」比对（`catalogHistory`，:361-377，只认 surface 上仍可见的 seq）：digest 相同 → 若当前步骤决策里已有该目录消息则移除（不重复占用上下文）；不同 → 注入持久**完整替换目录**（`renderCatalogUpdate`，:279-311，显式声明"replaces every earlier list"）或首次发布（`renderCatalogMessage`，:254-277，`<system-reminder>` + `<available_skills>`）。
6. 空目录且从未发布过 → 不发任何内容（:237-241）。

目录消息的 source 是 `{kind:'skill-catalog', form:'catalog', entries}`（:34-41）——结构化条目与模型可见文本并存，UI 不必重解析 `<available_skills>`。

**`skill` 工具**（:81-161）：`skill({name})` → `isSkillName` 校验 → `list().find` 找摘要 → `isModelInvocable` 检查 → `get()` 重新加载完整定义（每次调用都重读正文，注册表不缓存定义）→ **加载后再次检查策略**（:145-147）→ 返回 `{name, provider, resourceBase, content}`，render 输出 `renderSkillContent` 的 `<skill_content>` 块。未知/不可加载 → 报错。

**`/name` 用户手势**（:177-204）：仅扫描 `source.kind === 'user'` 的消息中的 `/([a-z0-9]+(?:-[a-z0-9]+)*)` 词边界 token（`SKILL_GESTURE`，:409）；命中 user-invocable skill 则把渲染正文作为 `{kind:'skill-invocation', form:'instructions'}` 的注入消息**追加在所有其它注入之后**（:203）——「背景在前，要执行的材料最后、离回答最近」。未知名或 user 禁用 → 保持普通散文。

**与 compaction 的交互**：若压缩遮蔽了全部历史目录消息，下一份完整快照重新建立目录（skills.zh.md:233）；目录消息是会话历史（user/message 表面事件），不是 World State。

### 4.6 token 计量流程

**`TokenMeter.measure(session, requestHeader?)`**（`packages/llm/token-meter/src/index.ts:116-147`）：

1. `_sync`（:160-181）：把每会话 ReplayState 折叠到日志尾部——只处理增量事件（`consumedEvents` 游标），均摊 O(新事件)。
2. `_foldEvent`（:188-270）：
   - `request/header` → 更新 `state.header`（canonical 化，:194-195）。
   - `step/start`/`step/end` → 维护 step 边界（:197-212），记录 `stepStart.surfaceTokens`。
   - `isSurfaceEvent` → `foldSurfaceTokens`（surface-fold.ts:42-64）——append 增价、replace 按位置切掉被遮蔽价格并换入新价格，返回 signed `deltaTokens`（:217-219）。
   - `assistant/message` + 有 usage + 有 header → 计算锚点：provider 真实 usage（`usageTokens` 求和，input+cacheRead+cacheWrite+output，:44-49）与完整启发式锚点比较；**真实 usage ≥ 启发式锚点才使用 `kind:'usage'` 基线**，否则退回 `estimated`（:229-260）——保证后续「有符号 delta」不会低估。
   - 无 usage → 纯启发式锚点（:250-259）。
3. 输出（:139-146）：`baseline.tokens + surfaceDeltaTokens` 得 `totalTokens`（请求+响应压力）；`surfaceTokens` 是表层启发式总和；`nodes` 深克隆（O(surface)）。

**启发式**（`estimate.ts`）：`CHARS_PER_TOKEN = 4`、每块结构开销 `BLOCK_OVERHEAD = 4`、每消息角色开销 `ROLE_OVERHEAD = 4`（:13-19）。`estimateContent` 递归计价（text/reasoning 按长度；tool-call 按 name+arguments；tool-result 递归；未知块按 JSON 序列化长度，:26-49）。`estimateHeader` = system + tools 的 JSON（:85-87）。

**计量在哪里用**：

- compaction 的压力判定与保留尾部预算（compaction-basic/index.ts:267、:304-324）；
- pruner 的影子价格（pruner/index.ts:165）；
- 摘要「必须更小」校验（region.ts:373-378）；
- 投影单元：`tokenUsage` / `contextPressure` / `contextBreakdown` 三个 `sessionProjections` 单元（token-meter/index.ts:87-91），向客户端推送「当前占用/预计」数值（usage-projection.ts:163-206：`projectedTokens = pressureTokens + surfaceTokens − sampledSurfaceTokens`，让 UI 预判下一次请求的占用，而不是展示上一次的）。

**为什么用启发式而不是真实 tokenizer**：真实 tokenizer 需要把每条消息完整序列化并按模型分词，成本高、且模型路由变化时锚点失效；4 字符/token 的固定密度 + provider usage 校准在"足够保守"的前提下把计量做成 O(增量日志) 的纯折叠，还能进入持久投影（O(1) 状态）。

---

## 5. 设计模式与权衡

### 5.1 append-only 日志 + 派生 surface（可重建性优先）

日志绝不删除：压缩/剪枝只**追加** `user/message`（带 `surfaceOp: replace`）与记账事件，旧事件（含完整原文）永远在日志里。surface 是纯函数折叠（`foldSurface` / `SurfaceManager`）。这带来：

- **可重建性**：任何模型请求 = `request/header`（system+tools+config）+ surface 投影消息，纯日志函数（agent.ts:458-493 构造 header 并写回，AGENTS.md "Model-visible ⟺ logged"）。
- **可审计/可恢复**：剪枝后仍可从日志重放原文（`sourceEventSeqs` 引用被遮蔽 seq）；崩溃遗留锁可检测。
- **代价**：日志无限增长（内存/磁盘），所以必须配套 compaction；surface 折叠必须对"位置替换"正确（seq 非单调）。

权衡：把「修改」建模为「追加+遮蔽」换取了不可变性，代价是日志体积与折叠复杂度（`shadowedRange` 是位置跨度而非数值区间的设计正源于此，types.ts:107-113）。

### 5.2 压缩放在 pre-step（先于请求推导）

`agent/pre-step` 串行 listener 中、`next()` 之前执行 `compactIfNeeded`（compaction-basic/index.ts:147-165）。理由：

- **时机安全**：此刻尚无新 user/message 落地、尚未构建请求；压缩替换旧表层不影响本轮要处理的输入（claim 在 preStep 开始处已发生，agent.ts:229）。
- **不打断轮次**：压缩失败只告警继续（index.ts:155-162），压力压缩绝不阻断对话。
- **每次请求前都有机会**：pre-step 每步都跑，压缩点与"模型将要消费上下文"的位置相邻，压力以最新 request header 定价（routedTarget）。

权衡：每次步骤多一次 `tokenMeter.measure()`（O(增量)）与阈值比较；模型无关剪枝每步都可能落地（有字符预算兜底，不会无谓剪）。

### 5.3 结果剪枝在摘要之前（model-free 先行，模型调用殿后）

`compactIfNeeded` 中压力合格后：先 `pruneSession()` → 重测 → 仍超阈值才选范围 → 摘要（index.ts:306-326）。溢出路径同样先剪枝再选范围（:283-291）。这是本系统最有教学价值的设计之一：

- **剪枝是确定性的**：无模型调用、无失败模式（除了日志校验），"必赢"的缩减先落地。
- **摘要可能失败**（网络、max-tokens、拒绝变小的校验）：剪枝先行保证即使摘要抛异常，表层也已经变小——`agent/request-error` 恢复逻辑正是靠 `replaceGeneration` 前进来判断"恢复有进展"（index.ts:191-221）。
- **剪枝是保守的**：只裁剪超大工具结果的中间段（head/tail 保留），不动语义负载高的首尾；摘要则"概括"整段，两者职责互补。

### 5.4 摘要调用复用会话前缀（KV cache 对齐）

摘要请求 = 上次真实请求的 system + tools + 被遮蔽消息 + 追加的压缩指令（summarizer.ts:146-163），`purpose:'compaction'` 标记。这样：

- 提供方前缀 KV cache 不失效，摘要调用便宜；
- 摘要"看到"与主对话完全一致的指令环境，产出更一致；
- 指令作为最后一条 user 消息而非独立 system prompt——保持"真实请求的前缀"这一性质。

权衡：受限于"前缀复用"，摘要无法引入独立的自定义摘要 system prompt；且被压缩区域越长，摘要调用本身越长（不过它正在变短——因为只喂被遮蔽部分）。

### 5.5 启发式计量 + usage 锚点（不做真实 tokenize）

见 §4.6。核心权衡：**精度换成本与可组合性**。固定密度（4 char/token）低估风险由「usage 锚点只接受 ≥ 启发式锚点的真实值」对冲（token-meter/index.ts:246-248）——有符号 delta 永远从"足够保守"的基线出发；provider 无 usage 时退回纯启发式。同时计量被设计成纯日志折叠，可持久化为 O(1) 投影单元（usage-projection.ts:163-206），UI 都能看到"下一次请求预计占用"。

### 5.6 日志事件即锁（崩溃自检）

压缩的并发互斥不靠内存标志，而靠日志中的 `compaction/start`…`compaction/end` 配对（region.ts:189/215/220-228）："有 start 无 end"= 崩溃遗留锁，后续入口抛 `busy`；`session/end-seed` 之前的遗留 start 被识别为旧生命周期残留而忽略（:286-298）。手动/自动用 `turn: null` vs `turn: n` 区分归属。这是"模型可见 ⟺ 已记录"哲学的极致延伸：**并发协议也记录在日志里**。

### 5.7 影子价格协议（shadow-price protocol）

`compaction/prune` 与 `compaction/summary` 紧邻其后的 replace 事件声明被遮蔽内容的启发式价格（compaction/types.ts:81-88；pruner/index.ts:162-166；region.ts:447-465）。纯消费方（UI、投影单元）无需保留每节点价格，直接"读到计量事件就减去价格"即可维持上下文占用估算——把"压缩导致占用下降多少"变成 O(1) 的日志读取，而不是重放折叠。

### 5.8 技能目录 digest 去重 + 目录最小化

- 目录只发布 `name` + 规范化 description（截断 500 字符），**绝不发布正文、路径、frontmatter 元数据**（tool-skill/index.ts:227；skills.zh.md:94）——技能正文按需经 `skill` 工具加载，避免把所有技能塞进上下文。
- digest 基于结构化条目而非渲染文本（tool-skill/index.ts:328-335）——框架文案变化不触发重发；digest 不变时**从本轮决策中移除**旧目录消息，防止上下文里堆叠多份目录。
- 目录作为 `catalog`-form 的 user/message 持久进会话历史（可被 compaction 遮蔽，下一份完整快照重建）。

权衡：模型必须"先看到目录、再决定调用 skill 工具"，多一轮工具调用延迟；换来的是上下文里只有摘要级信息，且目录随注册表变化自动收敛。

### 5.9 spill 的 best-effort 降级

溢出策略所有失败路径都保留原始内联结果（spill-policy/index.ts:156-161、:183-186）：保存失败、无后端、无 owner、notice 超 cap——一律"回到原样"，绝不把成功工具调用标记为 isError。这是"宁可多占上下文，不可丢失信息或破坏调用语义"的明确取舍；配合预算预留（:171-173）保证替换产物恒不超 cap。

### 5.10 缓存安全与幂等注入

- runtime context 快照：`RuntimeContextProjection.project()` 与上次保留值比对，相同则返回 undefined（不追加）；compaction 遮蔽旧快照时置 null（runtime-context.ts:46-55）——"snapshot 形式的上下文，后来的快照取代早先的"（ContextForm 语义）。
- `deriveMessages` 按节点缓存、按 replaceGeneration 失效（session/index.ts:726-747）。
- 技能目录与工作区指令（agent-instructions）都在 pre-step 幂等比对，重复内容从 inbox/决策中移除（tool-skill/index.ts:230-241；agent-instructions/index.ts:224-248）。
- 系统提示词 assembly 是纯函数 + waterfall，每个请求重算但只把变化写回日志。

---

## 6. 面试要点

**Q1：DSH 如何保证"模型看到的都能从日志重建"？**
答：日志 append-only 存所有事件；`request/header` 快照记录渲染后的 system+tools+config（session/types.ts:201、:304）；messages 由 `deriveMessages()` 从 surface 折叠（session/index.ts:726；surface.ts:83）；压缩的摘要调用信封也写进 `compaction/summary`（含 provider/model/usage/rawOutput，compaction/types.ts:33-66）。重建 = 日志 + 代码。

**Q2：surface 是什么？append 与 replace 的区别？**
答：surface 是模型可见事件序列（user/message、assistant/message、tool/result）。`append` 进尾部；`replace` 把一段位置跨度替换为新节点并 `replaceGeneration+1`（session/types.ts:372；surface.ts:362-379）。压缩与剪枝都通过 replace 实现"删旧"——旧事件仍在日志。

**Q3：为什么压缩要在 agent/pre-step 里做，而不是别的时机？**
答：pre-step 串行且先于请求推导（compaction-basic/index.ts:147-165）：此时无新消息落地、请求未构建，替换旧表层不影响本轮；失败只告警不阻断；每个请求前都有机会按最新 header 定价。溢出恢复则在 `agent/request-error` 里做（index.ts:179-223），因为只有此刻才知道 provider 确认了上下文溢出。

**Q4：工具结果剪枝为什么在摘要之前？**
答：剪枝确定性、无模型调用、必赢（pruner/index.ts:136）；摘要可能失败。先剪枝再重测，若仍超阈值才调模型摘要（compaction-basic/index.ts:306-326）。`agent/request-error` 靠 `replaceGeneration` 是否前进判断恢复是否有进展——剪枝落地本身就是可重试的证据（index.ts:191-221）。

**Q5：token 计量为什么不用真实 tokenizer？**
答：真实分词要完整序列化消息、成本高且路由变化失效；DSH 用固定密度（4 字符/token，estimate.ts:13）+ 结构开销 + provider usage 锚点（只接受 ≥ 启发式锚点的真实值，token-meter/index.ts:246-248）做纯日志折叠，O(增量) 可持久化为投影单元，UI 能显示"下一次请求预计占用"（usage-projection.ts:198-204）。

**Q6：compaction 的锁怎么实现的？崩溃了会怎样？**
答：锁 = 日志中的 `compaction/start`…`compaction/end` 配对（region.ts:189/215）。崩溃留下"有 start 无 end"，后续入口抛 `busy`；`session/end-seed` 之前的遗留 start 视为旧生命周期残留而忽略（region.ts:286-298）。

**Q7：摘要调用如何省钱？**
答：复用会话自己的 system+tools+消息作为前缀，只追加压缩指令（summarizer.ts:146-163）——真实请求的前缀，KV cache 不失效；`purpose:'compaction'` 标记（llm/types.ts:355）。

**Q8：技能系统怎么做到"上下文里只放摘要"？**
答：catalog 只发 name+description（截断 500 字符），正文按需经 `skill` 工具加载（tool-skill/index.ts:227、:81-161）；目录按条目 digest 去重，digest 不变就从当前决策移除（:230-241、:328-335）；`/name` 用户手势直接注入正文（:177-204）。

**Q9：技能注册表如何解决多来源重名？**
答：分层注册（scope 链），最近层同名直接胜出；层内按 rank → provider 注册序 → 本地序（skill/index.ts:568-583、:807-811）。发现缓存键含 scope 链，空会话重组无需注册表变更（:644-646）。

**Q10：spill 与 compaction 剪枝的分工？**
答：spill 是**跨请求持久**地把超大工具输出放文件、模型只见定位符+检索提示（spill-policy/index.ts:130-188）；剪枝是**日志内**把超大工具结果的中间段替换为 marker（pruner/index.ts:83-122）。spill 不删日志内容（文件在日志外），剪枝保留 head/tail 语义。

**Q11：runtime context 快照为什么不会无限堆叠？**
答：`RuntimeContextProjection.project()` 与上次保留值比对，相同不发；compaction 遮蔽旧快照时置 null（runtime-context.ts:46-55）；快照头部固定句声明"supersedes earlier snapshots"（system-prompt/index.ts:239）。

**Q12：`shadowedRange.start > end` 可能吗？**
答：可能。replace 落地的摘要节点 seq 是新的大数，但位置在旧区间——按数值区间读会得出 start>end。所以 DSH 把 `shadowedSeqs` 作为权威集合、`shadowedRange` 只是位置跨度（compaction/types.ts:107-113）。

**Q13：系统提示词的 order 约定是什么？**
答：升序拼接：-100 harness 身份、0 部署 persona（`PERSONA_ORDER`，system-prompt/index.ts:128-131）、100-199 工具指南；`complete: true` 的段成为唯一提示词（:504-508、:536-541）。

**Q14：`agent/request-error` 返回 retry 的充分条件？**
答：`failure.code === CONTEXT_WINDOW_EXCEEDED` 且压缩后 `surface.replaceGeneration` 前进（compaction-basic/index.ts:183、:218-222）；重试次数受 `maxOverflowRetries` 限制；取消优先。

**Q15：上下文工程的"压力信号"有哪些？**
答：① `tokenMeter.measure()` 的启发式 totalTokens 对 thresholdTokens（contextWindow×0.8）；② provider 确认的 `CONTEXT_WINDOW_EXCEEDED`（溢出强制缩减，跳过阈值）；③ 摘要"不比被遮蔽内容小"的拒绝（region.ts:373-378）作为质量信号。

---

## 7. 存疑/待确认

以下为本轮阅读中未能完全核实或属于文档-源码缝隙的点，写作博客前建议二次确认：

1. **`TokenMeasurement` 具体字段名**：`types.ts` 中 `TokenMeasurement`/`TokenSurfaceNode` 的精确字段（本文依据 docs/subsystems/token-meter.zh.md:12-41 与 `measure()` 返回值 `index.ts:139-146` 交叉验证，未逐字读取 `packages/llm/token-meter/src/types.ts` 全文）。
2. **`estimateHeader` 是否计入 ROLE_OVERHEAD**：`estimate.ts:85-87` 中 system 计 `ROLE_OVERHEAD`、tools 计 `BLOCK_OVERHEAD`——两者相加与"消息 + 角色"计费口径的一致性未在测试中验证。
3. **compaction-basic 的 README 细节**（保留策略、溢出上限的完整措辞）未读；本文依据 `config.ts` 与 types.ts 的默认值（threshold 0.8 / retain 0.16 / maxTokens 8192 / retries 1）。
4. **`skill-badge` 的具体行为**：只读了文档（skills.zh.md:79），未读 `packages/skill/skill-badge/src/index.ts` 源码；其 `BUNDLED_SKILL_RANK=600` 常量在 skill/index.ts:27 已确认。
5. **`session-reference`（recall）**：仅读了包头注释与文档中的 `recall` form 定义（llm/message.ts:48 附近），未追踪其投影/预算算法（`retainReferencedSession`、`DEFAULT_MAX_REFERENCE_BYTES`）。
6. **`compaction/end` 失败时 `error` 字段的持久化细节**：region.ts:220-228 显示失败路径追加带 `error` 的 end；但"flush 失败（persistence）"路径（:244-249）是否也写 `compaction/end` 的 error 字段未逐行确认——代码看 `flushFailure` 独立抛出，end 已正常写入。
7. **`agent-instructions` 的 `workspaceContextMessage` 渲染格式**（state.ts）未逐行读取，仅依据 render.ts 的 `<system-reminder>` 框架与 index.ts 的注入时序。
8. **`EpochHeader` 中 `adapterDefaults` 的用途**：agent.ts:458-463 把它写进 header；token-meter 的 `optionalHeaderEquals` 用 `headerEquals`（含 adapterDefaults 吗？）——`headerEquals` 的实现未核实（在 session 包 request-header.ts）。
9. **`/compact` 命令与 goal 轮次的交互**：`runMaintenance` 只保证 agent 空闲，goal 系统的轮次调度与其并发的细节未验证。
10. **spill 产物的清理**：文档明确"spill seam 不定义逐会话清理策略；保留期清理可连同旧会话产物使旧定位符失效"（spill.zh.md:41）——具体 retention 插件在哪实现未追踪。
11. **技能目录与 compaction 的精确交互时序**：目录消息被遮蔽后"下一份完整快照重新建立目录"（skills.zh.md:233）依赖 `catalogHistory` 只认 surface 可见 seq（tool-skill/index.ts:361-377），已读源码但未跑集成测试验证。
12. **`renderPrompt` 的 `{{` 字面散文分支**（system-prompt/index.ts:268-276）："孤立 `{{` 无 `}}` 视为字面"与"`{{}}` 空名走 malformed"的分支边界仅凭代码推断，未见专门测试断言。

---

## 附：给博客作者的写作建议（素材索引）

- **教学主线 A（数据流）**：日志 → surface → 请求。用 §4.2 的投影规则做例子，讲"为什么消息框架要由生产者烤进 content"（surface.ts:89-95 注释）与"为什么压缩是追加而非删除"。
- **教学主线 B（成本控制分层）**：计量（§4.6）→ 剪枝（§4.3.5）→ 摘要（§4.3.6）→ spill（§4.4）。这是一个"从零成本到有模型调用"的阶梯，每层解决一层问题。
- **教学主线 C（协议即日志）**：影子价格（§5.7）、锁即事件（§5.6）、可重建请求（§5.1）——DSH 把"基础设施"也建模成可重放的事件。
- **可对比话题**：启发式 vs 真实 tokenizer；KV cache 对齐摘要；技能目录 digest；best-effort spill 降级；`replaceGeneration` 作为"恢复进展"证据。
