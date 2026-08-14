# 启动、组合与沙箱补遗：六个边角细节

> 消化 backlog A18。本篇覆盖六个小聚类：launcher 身份注入的现状、用户 patch 热重载的别名陷阱、Landlock 预编译矩阵、windows-acl 受限令牌子系统、presentAs 的 preset 组合路径、fs 意图瀑布的单槽语义。

## 1. Launcher 身份注入：契约存在，生产注入者缺席

`CONFIGURED_AGENT_IDENTITIES_KEY`（`packages/core/agent-loop/src/index.ts:211`）的 JSDoc 说"launcher 在 Loader 挂载前 `ctx.provide()` 注入"。全仓库搜索的结论：

- **消费方**：`agent-loop` 的 `applyLauncherIdentities`（唯一）
- **注入方**：只有测试 `config-session-id.spec.ts:41`
- **生产 launcher**（apps/web、python 运行时）：**当前树中不存在**

诚实的解读：这是 pre-release 状态下"契约先行"的 seam——JSDoc 完整定义了 launcher 契约（"只有 launcher 知道会话是否已存在"），等待未来的宿主（如桌面应用）使用。契约写在 `packages/core/agent-loop/README.md`（生成目录确认："not a service: launcher-provided boot-context value"）。

::: tip 面试要点
"契约完整但生产消费者缺席"是正常工程状态：接口先定义（并配测试作为参考注入者），宿主后接入。判断一个 seam 是否"过度设计"，看它是否有可证明的未来消费者；这里答案诚实：有文档化契约，无生产消费者。
:::

## 2. 用户 patch 热重载：为什么必须 structuredClone

`composeLive`（`apps/cli/src/profile-boot.ts:240`）的注释是别名陷阱的教科书：

```ts
// Fresh clones per generation: the include pushes `insert` rows into the
// mounted tree BY REFERENCE and later id-targeted patches mutate those
// objects in place. Reusing one parsed patch object across applications
// would bake a user override into the bundle's in-memory insert row, so
// removing the override could never revert the row to the bundle default.
const composeLive = (): PatchOptions[] => structuredClone([...])
```

机制链：**Include 把 `insert` 行按引用推进插件树 → 后续 id 定向 patch 原地改这些对象 → 重载时重新解析同一份 patch 对象会重复叠加**。热重载的正确性依赖"每次世代全新克隆"——这也是为什么 boot 调用也传 `structuredClone(allPatches(...))`（同一理由的第二个落点）。

配套的两个细节：

- `watchUserPatches` 每次刷新**重读 Include 的非 patch 配置**（`const { patches: _previousPatches, ...includeConfig } = entry.options.config`）——防止 patch 重载静默回退其他配置项
- 树整体 dispose 时 watcher 注册失败返回 **no-op disposer**（`INACTIVE_EFFECT` = "应用按要求退出了"，不是 watch 失败）

## 3. Landlock 预编译：按平台发布的"从不 import"的包

```text
native/landlock-run/packages/
├── entry/         C 源码（纯 C11 + 静态 musl）
├── linux-arm64/   预编译二进制包
└── linux-x64/     预编译二进制包
```

三个机制细节：

- 平台包声明 `os: ['linux'], cpu: ['x64']`——npm 按平台选包
- 描述明确："resolved as a file path by @deepseek-ai/node-addon-landlock-run, **never imported**"——二进制是文件路径资源，不是 JS 模块
- 每个平台包有 `prepack` 脚本 `verify-launcher-binary.mjs`——发布前验证二进制真实存在且可执行

`--probe` 契约（`main.c:16-28`）：**构建最大 ruleset 并报告内核是否真的强制执行**——"executor 的功能探测"。版本号探测会漏掉"有 syscall 但拒绝执行"的内核（第 03 章已讲），所以探测 = 真安装真执行。

## 4. windows-acl：2,530 行的受限令牌子系统

研究笔记当时存疑的"runner 本体"是一个完整的包（`packages/sandbox/sandbox-windows-acl/`）：

| 文件 | 职责 |
|---|---|
| `token.ts` | 受限令牌 |
| `acl.ts` / `grant.ts` | 写-SID 授予（workspace 白名单） |
| `spawn.ts` | `spawnSandboxed` / `spawnSandboxedInherited`、`quoteArg`、piped-stdio grandchild 处理 |
| `path-boundary.ts` | NTFS 硬链接边界 |
| `ffi.ts` / `win32-abi.ts` | Win32 ABI 绑定 |

包头的第一原则：**"a child is NEVER spawned unrestricted"**（`index.ts:21`）。runner 校验 argv 携带的模式字符串，每个 spawn 都经 `AclSandboxSpawnOptions`。这与 Linux 的 argv 包装哲学一致——只是 Windows 上"包装"意味着受限令牌 + SID 授予而不是 execve 前置。

## 5. presentAs：preset 只能拥有"呈现"

`dsh-agent-tool-presentation`（72 行）回答一个架构问题：**preset（每会话组合）能改工具注册表吗？**

答案：不能。工具注册表在 **host 平面**（调度器、API proxy 的 presenter、所有工具插件都是它的消费方，不能搬进 preset）。preset 能拥有的只有**呈现**：

```ts
// ctx.tools.presentAs() 为挂载 SCOPE 声明呈现形式
// preset 的 standing mount → 覆盖加入该 preset 的每个 agent
// Code Mode preset 与 native preset 在同一个进程里并存
```

两个设计细节：

- `mode` **必填而非默认**：不带这一行的 preset 已经拿到部署默认——省略值意味着"这行白组合了"
- Code 模式 `ctx.inject(['codeRuntime'])` 等待运行时——**在挂载时响亮失败**（preset 自己的激活审计点名该 id），而不是第一次 prompt 时炸

## 6. fs 意图瀑布：单槽决策的部署约定

`fs/write-intent`（`packages/fs/tool-fs/src/write.ts:111`）的注释写明语义：

```ts
// Single-slot decision: the policy plugin produces createIfAbsent/
// replaceIfVersion; the bare default is undefined (unconditional). No stat.
const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
```

- **单槽**：策略插件通过"返回而不调 `next()`"短路瀑布——第一个短路者赢
- **裸默认 = undefined**：无条件写（策略插件是可选部署，不改变 schema）
- 多插件冲突行为：文档承认"先到先得是部署约定，**而非强制不变式**"——两个策略插件都占槽时，注册序先者胜，后者永不执行

::: tip 面试要点：为什么这里不用 guard？
guard 只能拒绝，而 write-intent 要**产出决策**（createIfAbsent vs replaceIfVersion）——是"策略计算"，不是"允许/拒绝"。单槽瀑布 + 文档化的部署约定，是"一个策略位"的最小表达。
:::

## 7. 本篇消化的 backlog 项

- ✅ A18#1 launcher 身份注入（契约存在、生产注入者缺席——诚实结论）
- ✅ A18#2 watchUserPatches/composeLive 的 structuredClone 别名陷阱
- ✅ A18#3 Landlock prebuilds 矩阵（os/cpu 字段、never imported、prepack 验证）与 --probe 契约
- ✅ A18#4 windows-acl 受限令牌子系统（2,530 行，NEVER spawned unrestricted）
- ✅ A18#5 presentAs 的 preset 组合路径（host 平面 vs 呈现、mode 必填、codeRuntime 挂载等待）
- ✅ A18#6 fs/write-intent 单槽瀑布（短路占槽 + undefined 裸默认 + 部署约定非不变式）

下一篇预告：技能系统深入 / 前端渲染内核 / 调度命令 / 重试凭据（子代理研究中）。
