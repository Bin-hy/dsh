# 08 · 持久化与工程化：如何管理 200+ 包的 monorepo

> 前面七章都在拆功能。这一章拆"怎么做"：monorepo 布局、双 face 构建（host/client）、Typert 类型图、测试体系、vendored Cordis 的本地修改日志、持久化后端。这些是"工业级 agent 项目"的必修课——也是面试中区分"看过 demo"与"参与过真项目"的部分。

## 1. Monorepo 布局：包名即角色

```text
vendor/       Vendored Cordis 源码（固定版本、可审计、可补丁）
packages/     @deepseek-ai/dsh-<pkg>，按 packages/<group>/<pkg>/ 组织
  core/        产品 API 脊柱（session/system-prompt/tools/agent/agent-loop/scope）
  api/         BFF 组装 + Typert RPC 网关
  typert/      类型图生成器、加载器、运行时注册表
  llm/         LLM 能力（Definition + Consumer + DeepSeek providers）
  shell/       bash 能力（Definition + local/pwsh providers + tool Consumer）
  subprocess/  subprocess 能力 + 本地进程树 provider
  fs/          文件系统能力 + 策略
  subagent/    子代理能力（Definition + providers + 委托 Consumer）
  workflow/    工作流能力 + worker-thread provider + tool Consumer
  ...
apps/         cli（dsh bin）、web（Vite 入口）
native/       Landlock launcher（C 源码）
python/       Python SDK + bundled runtime
examples/     可运行的 cordis.yml leaves
website/      VitePress 官方文档站
```

包名即角色：`dsh-shell`（Definition）、`dsh-bash-local`（Provider）、`dsh-tool-bash`（Consumer）——看名字就知道它在 seam 里的位置。这不是巧合，而是**命名规则**（见 `docs/cookbook/adding-a-package.md#name-the-role-that-exists`）：包名描述"存在的角色"，不超前描述。

## 2. 构建：双 face + tsc 项目引用 + tsdown

构建管线分两步（`tsdown.config.ts`）：

```text
pnpm run build:lib:host     tsc -b tsconfig.host.json（类型+JS 中间产物）+ tsdown 打包 host 面
pnpm run build:lib:client   tsc -b tsconfig.client.json + tsdown --env.DSH_BUILD_FACE client
pnpm run build:web          Vite 构建 Web 前端
```

关键概念：

- **host/client 两个编译面**：host 是 Node 运行时，client 是浏览器 bundle。`packages/client` 下的 UI 包在 client pass 里产出浏览器工件——**同一个包，两套编译目标，通过 package.json exports 区分**
- **源面与产物面分离**：静态检查（tsc/lint/test）通过 tsconfig paths 解析到 `src`；消费构建产物的 gate 显式声明依赖 `lib/`。两者从不混用
- **Typert 插件**：host 构建时 `typertPlugin` 从源码生成**类型图**（type graph）——这是下一节的 RPC 基础
- 每个包的 tsconfig 都 `rootDir: src, outDir: lib/types`，引用每个 workspace 依赖 + `runtime-diagnostics/invariants`

## 3. Typert：把类型变成运行时可消费的图

`packages/typert/` 是 DSH 最有特色的基础设施：**类型图生成器 + 加载器 + 运行时注册表**。

```text
tsc 编译 → JS 中间产物（lib/types）
typertPlugin → 从 JS + 类型元数据生成类型图（type graph）
运行时 → ctx.typert 注册表：查询 schema、反射元数据
API 网关 → ctx.typertGateway：把 Remote 描述符与实时 Cordis 服务关联
```

这解决了 monorepo 的经典问题：**浏览器与宿主进程之间怎么共享类型安全**。`api-gateway` 生成的 Remote 描述符与宿主服务关联，通过共享的 Connection RPC 载体提供一元调用——前端拿到的不是手写 API client，而是从类型图生成的、有运行时 schema 校验的调用描述符。

## 4. 持久化：同一套事件词汇，多个后端

`ctx.sessionPersistence` seam 的两个后端（`packages/session/`）：

| 后端 | 特性 |
|---|---|
| `session-persistence-jsonl` | JSONL 追加写；Windows 上经 koffi 调 `MoveFileExW` 做写透发布 |
| `session-persistence-sqlite` | SQLite，单调 `SCHEMA_VERSION` |

关键纪律（根 AGENTS.md）：

- **各后端持久化同一套 SessionEvent 词汇**——应用在组合时选择后端，事件不因后端而异
- 后端拒绝旧 on-disk 格式（pre-release 无兼容承诺）；SQLite 用单调 `SCHEMA_VERSION` 管理迁移
- `dsh-session` 的 `SESSION_FORMAT_VERSION` 保持 0：只有结构格式变化才 bump
- **`ignorable: true` 机制**：日志事件缺省"必须理解"——不认识的事件拒绝重建；只有带 ignorable 标记的事件允许旧版本跳过

配套的 `ctx.sessionQuery`（sqlite 全文检索、游标世代）与 `ctx.sessionProjections`（状态折叠单元 + 水位检查点 + 冷读取阶梯：缓存行 + 持久化尾部回放——**列表读取永远不需要加载完整日志**）。

## 5. 测试体系：分层分明

`package.json` 的测试脚本（结合 `docs/testing.md`）：

| 层 | 命令 | 什么 |
|---|---|---|
| 单元 | `pnpm run test` | vitest，每文件 100% 覆盖率门（CI 用 `test:coverage`） |
| 快照 | `pnpm run test:snapshot` | **keyless ACP/headless 回放** vs 预期输出 |
| 真实 API | `pnpm run test:e2e` | 需 `DEEPSEEK_API_KEY`，无 key 自动跳过 |
| Web | `pnpm run test:web` | 构建后浏览器测试 + 快照 + 压力/性能配置 |
| Windows | `check:windows-wine` | Wine 跑 Windows 门（仅 CI 拥有该信号） |

核心纪律（`packages/AGENTS.md`）：

> **产品可见的插件必须有一个非平凡的 REAL-composition 测试**：通过 Loader 和真实 app/进程启动 test-only 的 `cordis.yml`，只 mock 外部服务与不确定输入，断言模型可见/持久/用户可见输出。手工 `ctx.plugin(...)` 套件不充分。

> **每个非平凡的产品可见行为变更都必须新增或更新一个 keyless snapshot**，通过真实可运行的 example 产生。包测试、e2e-only 断言、mock-only fixture 不能替代组装后的应用 transcript。

以及"测试描述行为，不是正确性"——改行为连同测试一起改，并解释为什么。

## 6. Vendored Cordis：拥有你的框架层

`vendor/README.md` 是最值得读的工程文档之一：9 个 vendored 包，**18 条本地修改日志**，每条都记录"改了什么 + 为什么 + 测试覆盖"。摘两条最有教育意义的：

- **`cordis/src/fiber.ts` 生命周期加固**（修改 #6）：修复三个重入式资源释放缺口——setup 内触发的 unload 必须等待 setup 与所有清理完成；异步 cleanup 在静默前保持 owner 可见；卸载期间拒绝创建 effect。这是"插件框架的 teardown 是地狱级并发问题"的活教材
- **Include 的串行化子树变更**（修改 #12）：两个并发 apply 交错导致 rollback 挂起同一 apply 造成死锁（exit 13 无诊断）——修法是**每个 Include 一个队列**串行化所有子树变更

为什么 vendor 而不是 npm 依赖？README 开头说得直白：**让 harness 完全拥有自己的框架层（可审计、可补丁、固定版本）**。全部重命名进 `@deepseek-ai` scope，`linkWorkspacePackages` 让保留的上游 semver 范围解析到这些固定 workspace。

## 7. 运行时不变量：把"宪法"写成代码

`packages/runtime-diagnostics/invariants` 提供 `ctx.invariants`：**包自有不变量注册表**。每个包注册 `./invariant` 检查：

- 检查**事件/数据关系**（如 agent-loop 的"请求 = 日志纯函数"），而不是服务/方法存在性
- 没有可检查关系的包必须给出"无运行时不变量的理由"，否则 fail
- 失败标注所属包

这是把 AGENTS.md 里的纪律（"模型可见 ⟺ 已记录"、"注册即副作用"）变成**执行的 gate**，而不是靠人肉 review。

## 8. 约定即生产力：值得抄进简历的纪律

从根 AGENTS.md 提炼最可迁移的几条：

1. **注册即副作用**：一切贡献走 `ctx.effect()`/`ctx.on()`，`register()` 返回 disposer
2. **fail loud**：错误配置在加载时自包含地报错，绝不静默跳过缺失的引用
3. **跨边界 id 品牌化**：`Branded<B>` 类型，绝不裸 string
4. **信任同进程类型边界，校验其余**：parser/config、queued、模型/工具 JSON、durable/file、worker、process、wire 七类边界必须运行时校验
5. **显式优于隐式**：defaulting 是 owning 实现里显式的 `resolve(request): Spec` 步骤，不是藏在 `run()` 里的 `?? default`
6. **无硬编码 tunable**：部署相关的选择必须是可 patch 的 Config 字段；协议常量、外部规范、安全不变量保持固定
7. **空 catch 必须说明吞掉什么**；try 保持单语句
8. **prefer symmetry**：并行值不对称通常意味着漏了提取
9. **Agent Note**：每个非平凡变更带一条决策记录（why + 放弃什么 + 验证要求），归档即冻结
10. **docs 是 tier 结构**：每个事实只有一个家，其余位置链接

## 9. 面试要点

::: tip 面试要点 1：219 个包怎么防依赖腐化？
knip（未用导出检测）+ 工作区约束 + 每包 invariant 注册 + 构建产物不变式检查 + 克隆检测（jscpd）。依赖是显式声明的，peer 关系被 machine gate 检查。
:::

::: tip 面试要点 2：为什么双编译面而不是两个包？
同一批 client 包要同时给 Node（SSR/测试）和浏览器用。tsdown 的 workspace 模式让 host pass 产 Node 入口、client pass 产浏览器工件，共享同一份源码与类型。
:::

::: tip 面试要点 3：为什么"产品可见插件必须 REAL-composition 测试"？
单元测试测的是孤立行为；agent 产品的正确性在**组装后的事件流**里。通过真实 Loader + 真实 app 进程跑 test-only cordis.yml，才能断言"模型可见输出"与"持久输出"。
:::

::: tip 面试要点 4：快照测试为什么 keyless？
真实 API 测试需要 key、不稳定、贵。keyless 回放（llm-replay provider）用固定模型输出重放 transcript，断言组装后的确定性输出——模型行为与产品行为分离测试。
:::

下一篇是[面试冲刺](/interview/patterns)：把八章的设计模式提炼成可迁移的手册。
