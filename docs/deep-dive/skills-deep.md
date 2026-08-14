# 13 · 技能系统深入：badge、遮蔽恢复与注入秩序

> 消化 backlog A13。本篇补完技能系统的三个此前存疑的细节：`skill-badge` 的随包分发、技能目录被 compaction 遮蔽后的精确恢复、以及多个"上下文注入者"在 pre-step 瀑布里的秩序。

## 1. 核心心智模型：上下文是视图，不是堆

四个包（skill 提供方、注册表、tool-skill、agent-instructions）围绕一条纪律运转：

> **每个注入者只拥有自己那一类 source kind 的消息；对"自己上次发布的内容"做幂等比对；内容变了就发布一份完整替换而非追加补丁；历史被 compaction 遮蔽了就重新发布。**

三条子纪律：

1. **只追加、不互删**：注入者通过返回 `{kind:'enter', messages}` 把自己的消息加进决策，没有任何注入者去删别人的消息
2. **source kind 即命名空间**：`'skill-catalog'`、`'agent-instructions'`、`'skill-invocation'`、`'plugin'`（runtime-context）互不重叠——每个注入者找"自己上次的发布"时只看自己的 kind
3. **比对 = 结构化事实，而非模型文本**：目录比条目 digest，工作区指令比 `content+source` 深度相等——框架文案变化永远不会触发重发

## 2. skill-badge：发布物即技能仓库

`dsh-skill-badge` 全包只有一个 60 行的插件文件 + 两个 asset：

```ts
// packages/skill/skill-badge/src/index.ts:18-38（语义提炼）
const CANDIDATE: SkillCandidate = {
  name: 'dsh-badge',
  description: 'Add the official "powered by dsh" badge…',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: 'dsh-badge', source: 'bundled',
  resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../assets/', import.meta.url)) },
  rank: BUNDLED_SKILL_RANK,   // = 600
  locator: new URL('../assets/dsh-badge.md', import.meta.url),
}
```

三个机制细节：

- **技能正文与 PNG 作为 npm 包的一部分发布**（`files` 字段显式含 `"assets"`）——发布物即技能仓库，无需文件系统配置
- **`import.meta.url` 相对解析**：构建后 `lib/index.js` 旁边的 `assets/` 依然存在
- **base bundle 默认 `disabled: true`**，preset 一行开启——徽章技能是"opt-in 的随包能力"，不污染每个部署的目录

`get()` 用 `readFile` 现场读正文——不缓存、不 watch、无配置。一个提供方 = 一个候选 = 一个文件，这就是"最小技能提供方"的完整形态。

## 3. 目录 × compaction：遮蔽后的精确恢复

`catalogHistory(agent)`（`tool-skill/src/index.ts:361`）返回 `{ visibleDigest?: string; published: boolean }`：

- **倒扫日志，只认 surface.nodes 仍可见的 seq**——`published`（曾经发过）与可见性**解耦**
- 全被遮蔽 → `visibleDigest = undefined` → 下一份完整快照以**替换目录形态**重新发布（"This complete catalog replaces every earlier list"）

::: tip 面试要点：为什么目录消息可以被 compaction 放心遮蔽？
因为恢复协议是"**遮蔽 → 重发布完整快照**"。目录本来就是无状态全量（不是增量），被压缩掉只损失一次发布动作，不损失信息——下一个 pre-step 检测到 visibleDigest 缺失，用 update form 补一份完整目录。这与 runtime-context 快照的 `retained = null`（被遮蔽）语义完全同构：**上下文是日志的视图，视图可以被重建，所以可以放心压**。
:::

## 4. agent-instructions：三级幂等闸门

工作区指令（AGENTS.md 链）的注入走三条幂等闸：

| 闸门 | 实现 |
|---|---|
| 快路径 | `InstructionVersionCache`：`{path, version(FsVersion), digest, trimmedDigest}`——**只缓存元数据不缓存正文**，正文从磁盘按需读 |
| 幂等比对 | `content + source` 深度相等才不发 |
| 原子提交 | 状态迁移（set/replace/remove）合成一条带 `changes` 数组的消息，原子落库 |

三个渲染细节：

- `<system-reminder>` 框架由 **producer 烤进 content**，结束标签转义——投影层（deriveEventMessage）保持纯透传
- **发现链**：`$DSH_HOME/AGENTS.md` 全局 + 项目根 → cwd 逐层候选，从宽到窄渲染（本会话开头那份 AGENTS.md 就是这么进来的）
- `workspaceContextMessage()` 是"取内容"的辅助函数，它的 `{kind:'plugin'}` source **从不落盘**——真正的落库 source 是 `{kind:'agent-instructions', baseline?, changes}`

## 5. pre-step 注入秩序：谁是基底，谁在前

瀑布里的完整秩序（含示例骨架与 base bundle 的真实装配）：

```text
driver：runtime-context 快照 → 基底决策（enter 默认 = claimed + context）
  ↓ waterfall
compaction-basic：在 next() 之前工作   ← 压缩副作用恒先于注入者读取
agent-instructions：next() 之后工作
tool-skill 目录 listener：next() 之后工作
tool-skill /name 手势：最后，追加在所有其它注入之后
```

两条显式契约：

1. **"注册顺序 = 渲染顺序"**（示例骨架注释原文）：`ctx.plugin(workspaceContext)` 必须在 `ctx.plugin(toolSkill)` 之前——"so workspace instructions must precede the skill catalog"。装配顺序本身就是 API
2. **所有注入者"先 next() 后工作"，只有 compaction"next() 前工作"**——压缩必须先于任何注入者读取 surface，否则注入者可能读到即将被遮蔽的旧状态

::: tip 面试要点：为什么"背景在前，执行材料最后"？
`/name` 手势注入被设计为"追加在所有其它注入之后"——工作区指令、技能目录是背景，用户点名要的技能正文是**要执行的材料**，放在离回答最近的位置。这是提示词工程里的"信息新鲜度排序"。
:::

## 6. 面试要点汇总

::: tip 面试要点 1：为什么目录比对用条目 digest 而不是渲染文本？
框架文案（`<available_skills>` 的措辞）变化不该触发重发；条目级指纹（name+description 的 JSON sha256）只对**事实**敏感。digest 不变时把旧目录从当前步骤决策中移除——上下文里永远只有一份目录。
:::

::: tip 面试要点 2：为什么指令缓存只存元数据？
正文会变、会大、会被其它消费者改；元数据（版本令牌 + SHA-1）够做快路径判定。`version` 用 `ctx.fs` 的新鲜度令牌——文件系统 seam 的版本机制（第 03 章 fs-observation-policy）在这里被复用，而不是再发明一套 mtime 比较。
:::

::: tip 面试要点 3：注入者为什么"只追加不互删"？
每个注入者拥有自己的 source kind 命名空间，互不干涉是**可组合性**的前提。如果允许互删，注入顺序就成了正确性契约——而现在顺序只是**渲染顺序**（风格问题），不是正确性问题。
:::

下一篇：前端渲染内核 / 调度命令 / 重试凭据（笔记已就绪，陆续发布）。

::: tip 相关考古
目录解析的"严格校验 + 降级"修正见[考古⑨](/deep-dive/archaeology-9)。
:::
