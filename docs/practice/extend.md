# 实战：给 DSH 加一个工具、一个技能

> 学完理论必须动手。这一篇是"跟着 cookbook 走一遍"的实操指南：加一个 `weather` 工具（完整五步验证）+ 加一个自定义技能。所有约定以官方 cookbook（`docs/cookbook/adding-a-tool.zh.md`、`adding-a-package.zh.md`）为准。

## 1. 加一个工具：`weather`

### 1.1 最小形态（官方模板改版）

`packages/<group>/<pkg>/src/index.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-tool-weather'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'weather',
    description: 'Query current weather for a city.',   // 模型看到的
    parameters: {
      city: { type: 'string', required: true, description: 'City name' },
      unit: { type: 'string' },                          // 可选，缺省 optional
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      // args 类型由 schema 推导：{ city: string; unit?: string }
      return fetchWeather(args.city, args.unit, exec.signal)  // 返回规范 JSON 值
    },
  }))
}
```

三个"立刻生效"的事实：

1. **注册即副作用**：dispose 插件 fiber 即注销工具，无需手动 unregister
2. **schema 自动流入 system prompt**：下一次模型请求就能看到 weather 工具
3. **args 已为你校验**：`defineTool` 在 execute 前按 `ParameterSchemaSpec` 校验模型参数（类型/必填/联合分支）；schema DSL 无法表达的约束（非空字符串、跨字段规则）需要你在 execute 里手动检查

### 1.2 必须遵守的 execute() 八条约定

| # | 约定 | 反例 |
|---|---|---|
| 1 | 参数已校验，args 匹配 InferArgs | 自己再写一遍类型检查 |
| 2 | 注册借用你的只读定义 | 注册后改 schema 或换回调 |
| 3 | 执行身份受保护（args 冻结、token 不透明） | 把 args 当可变输入 |
| 4 | 返回规范 JSON 值，不返回内容块 | 自己渲染 markdown |
| 5 | 抛异常 = isError；不理想领域结果写进规范值 | 进程退出码非零就抛异常 |
| 6 | 遵守 `exec.signal` | 忽略取消 |
| 7 | 可选 `presentationMeta` 派生可回放卡片数据 | 把 UI 数据塞进规范值 |
| 8 | 用 `exec.agent.inject()` 发异步通知（不唤醒） | 从工具里直接 followup |

### 1.3 展示（UI 卡片）是独立关注点

`output.render` 管模型可见内容；UI 卡片由 `presentCall` / `presentResult` 声明。**两条硬规则**：

- **纯函数**：live 流与日志回放都会调它们——不做 I/O、不读会话状态、不用时钟/随机数
- **UI 格式不进模型结果**：```console` 围栏、diff、相对路径都别进规范值

没有展示方法的工具回退到通用卡片（标题=工具名，raw args 作为输入）。

### 1.4 包创建清单（逐文件）

```text
packages/weather/tool-weather/
  package.json     # 从 packages/core/tools 复制改 name/description/deps
                   # 不变式：private、version=根、type:module、cordis peer+dev
  tsconfig.json    # extends tsconfig.base.json、rootDir src、outDir lib/types、
                   # references: vendor/cordis (+ 每个 dsh 依赖)
  src/index.ts     # 上面的插件
  README.md        # 服务 API + Model Experience 格式 + Known Limitations
```

根配置注册（`docs/cookbook/adding-a-package.zh.md` 第 2 节）：

- `tsconfig.host.json` 的 references 加 `{ "path": "./packages/weather/tool-weather" }`——**普通包恰好属于一个 aggregate**
- 其余（workspaces、tsdown、oxlint、constraints）由 glob 自动覆盖

### 1.5 验证五步

```sh
pnpm install                     # 注册 workspace
pnpm run doc-sync
pnpm run constraints && pnpm run typecheck && pnpm run lint
pnpm run build && pnpm run hygiene
pnpm run test                    # 行为专项测试 + 覆盖率
```

别忘了仓库铁律（`packages/AGENTS.md`）：

- **产品可见插件必须 REAL-composition 测试**：test-only `cordis.yml` 经 Loader + 真实 app 进程启动
- **面向模型的行为变更必须 keyless snapshot**：通过真实 runnable example 产生
- README 的 Model Experience 段按规范格式（What the model sees / Token effect / KV Cache effect）

## 2. 加一个技能（Skill）

技能比工具更轻——它是**按需注入上下文的 prompt 包**，不需要代码。

### 2.1 技能文件

```text
<project>/.agents/skills/my-skill/SKILL.md
```

```markdown
---
name: my-skill
description: 一句话描述技能何时使用
---
# 技能正文

完整的指令正文，模型通过 skill 工具加载后注入上下文。
```

### 2.2 生效机制（对照第 04 章）

1. `skill-filesystem` 按 6 类根目录 rank 扫描（`.dsh/skills` 100 → bundled 600），解析 frontmatter
2. **目录只发 name + description**（截断 500 字符）——正文不占上下文
3. 模型看到 `<available_skills>` 目录 → 调 `skill({name:'my-skill'})` 工具加载正文
4. 或用户直接 `/my-skill` 手势注入
5. `fs/observed` 事件让修改后的技能文件立即失效重扫

### 2.3 技能 vs 工具的选择

| 场景 | 选技能 | 选工具 |
|---|---|---|
| 指令/流程知识，需要时读 | ✅ | |
| 需要系统能力（执行、IO） | | ✅ |
| 跨会话复用提示词 | ✅ | |
| 结构化输入输出、策略拦截 | | ✅ |

## 3. 更进一步的路线图

按难度递增，作为"把 DSH 吃透"的完整实践路线：

1. **加工具**（本章）：理解 defineTool/流水线/作用域
2. **加技能**（本章）：理解技能注册表/目录/注入
3. **加一个 `tools/pre-execute` 策略插件**：给某个工具加审批——理解 waterfall 拦截
4. **加 LLM 适配器**：对接一个本地模型——理解 seam 与流式协议（`docs/cookbook/adding-an-llm-adapter.md`）
5. **加 Conversation Node**：给 Web GUI 加一种聊天节点——理解浏览器端折叠引擎
6. **写一个 agent preset**：用 cordis.yml 给特定会话组装专属能力集
7. **读 postmortem**：`docs/postmortem/` 四个事故报告是"工程判断力"的最佳教材

## 4. 收尾：把整个学习闭环

```text
读（docs 15k 行 + 源码）→ 拆（本资料 8 章）→ 练（本章）→ 讲（面试话术）
```

最终检验标准：**能否不看资料，画出"用户消息 → turn/start → pre-step → 请求 → 流式 → 工具 → turn/end"的完整时序，并解释每个事件为什么存在。**能做到，你就有资格说"我深度研究过一个 agent harness"。
