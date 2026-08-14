# 03 · 沙箱与权限

> DSH 的沙箱是**进程沙箱**而非容器：与宿主共享内核和文件系统，靠"包装 argv + 内核安全机制 + 进程内策略 fence"三层实现。本章拆解 `packages/sandbox/`、`native/landlock-run/`（C 源码）与审批系统。

## 1. 总体设计：共享执行世界的沙箱

沙箱 seam 只有一个核心操作：

```ts
// packages/sandbox/sandbox/src/index.ts:158
abstract confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
```

消费方在 spawn 前交出**确切 argv**，提供方返回包装后的 argv（`runner + profile + -- + argv`）。三种模式只管**文件效果**：

| 模式 | 语义 |
|---|---|
| `read-only` | 只读，拒绝一切写 |
| `workspace-write` | workspace 根 + 平台临时区可写 |
| `danger-full-access` | 消费方直接裸 spawn，**根本不调 confine** |

平台链条（`sandbox-local/src/index.ts:159`）：

```text
linux:  bwrap → landlock（按序功能探测，bwrap 优先；不可用时退化到自研 Landlock launcher）
darwin: seatbelt（macOS Sandbox Profile Language）
win32:  windows-acl（受限令牌 runner）
```

::: tip 关键理解：沙箱是 argv 包装，不是环境
`ctx.sandbox` 只是把 `['bash','-c',cmd]` 变成 `[runner, ...profileArgs, '--', 'bash','-c',cmd]`。谁 spawn 谁负责调用 confine。这就是为什么"替换一个提供方，Bash、PTY、LSP 全跟着走"——它们共享同一个 `ctx.subprocess` 执行世界。
:::

## 2. Landlock：300 行 C 实现的无 root 自限制

`native/landlock-run/packages/entry/src/main.c` 是研究笔记里最精彩的发现。DSH 没有发明沙箱，而是**用内核已有的安全模块实现"自限制后 exec"**：

```text
landlock-run [--ro <path>]... [--rw <path>]... -- <argv>...
```

核心逻辑（`main.c:230` 的 `restrict_self`）：

```text
1. 协商 ABI（MAX_ABI=5）→ 建 ruleset
2. path-beneath 规则：--ro 挂只读，--rw 挂读写
3. prctl(PR_SET_NO_NEW_PRIVS)   ← 抑制 setuid 提权
4. landlock_restrict_self()     ← 规则在 execve 之后仍然继承
5. execvp(argv)                 ← 现在才真正执行命令
```

三个工程决策值得背下来：

1. **fail-closed**：内核不支持/不执行 Landlock → 打印 `landlock-run: ...` 退出 **125**，绝不裸 exec。退出码 125 是约定（`EXIT_LAUNCHER_FAILURE`）——命令本身不太可能用 125，executor 借此区分"launcher 失败"与"命令失败"
2. **`--probe` 真实安装最大 ruleset**：版本号探测会漏掉"有 syscall 但拒绝执行"的内核（如某些云厂商内核编译时禁用了 LSM）
3. **旧 ABI 部分执行**：stderr 报告 `partial enforcement (older Landlock ABI)` 但继续运行——enforcement 分 `full`/`partial` 上报

## 3. 失败分类：方言表

沙箱把"命令没跑起来"与"命令被拒"分得非常清楚：

```ts
// sandbox-local/src/index.ts:205（研究笔记摘录）
DENIAL_SIGNATURES = {
  bwrap: ['read-only file system'],
  landlock: ['permission denied'],
  seatbelt: ['operation not permitted'],
  'windows-acl': ['access is denied', ...],
}
RUNNER_FAILURE_RULES = {  // landlock: exit 125 + 致命行
  ...: exit 125 + 'landlock-run: ' 前缀
}
```

分类顺序：**退出码门控 → 去掉信息性行 → 逐行匹配致命签名**。关键原则：**退出状态本身永远不足以证明 runner 失败**。

每个后端带自己的 stderr 方言，消费方只按**本后端**签名分类——不会把 bwrap 的 EROFS 误判成 Landlock 的 EACCES。代价：每加一个后端都要维护方言表。

## 4. 审批（approval）与升级（escalation）

### 审批 seam

```ts
// packages/interaction/user-approval
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
type ApprovalPolicy  = 'ask' | 'never'
```

- `ctx.approval.request()` 通过 `approval/request` waterfall 分发；**应答者是监听器**（Web UI 弹窗、ACP 自动化桥接）
- 无应答者 → `unavailable`，**按拒绝处理**（fail-closed）
- `never` 策略在服务内部、waterfall 分发**之前**判定——后来 `prepend` 注册的应答者无法绕过
- 审计事件对 `approval/asked` → `approval/decided` **只进日志、不进模型 transcript**；模型通过 system prompt 上下文感知策略
- 前置条件：必须**在开放 turn 内**——否则崩溃尾会被回放丢弃

### 升级（escalation）——本次会话的活教材

当模型在 read-only 沙箱里写文件被拒，流程是：

```text
1. 命令失败，stderr 带 [sandbox: file access denied under read-only mode]
2. 模型用相同命令 + sandbox_permissions: ['workspace-write'] + justification 重试
3. 工具层在【执行前】调 approveEscalation：
   - 严格变宽检查（WIDER_MODES 表）——非变宽请求绝不打扰人类
   - ctx.approval → allowed-once 才授权【本次调用】
4. granted mode 只盖到本次调用的 policy，不写入会话
```

`allowed-once` 防重放：每次 `request` 新发 `ApprovalRequestId`，只授权所问的那一个操作。

## 5. 权限预设（permission presets）

`ctx.permissionPresets` 把两个 knob 绑成面向用户的预设：

```ts
{ name: 'workspace-write',    sandbox: 'workspace-write', approval: 'ask' }
{ name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' }
```

- 一次切换写一个**仅日志**的 `permission/preset` 事件，再经各 knob 的规范 setter 写入（`setSandboxMode` + `setApprovalPolicy`）
- 生效预设是**派生值**：折叠沙箱 mode（会话覆盖→默认）与 approval policy（会话覆盖→默认→ask）
- `permission/preset` 不进 transcript，回放只需折叠最后一条

## 6. 文件系统侧：进程内 fence 与"先读后编辑"

### fs-sandbox（containment，不是内核边界）

`packages/fs/fs-sandbox` 在**进程内**做 policy fence：`writeText/editText` 覆写为 `checkedTarget`——`read-only` 拒绝；`workspace-write` 对**当前规范路径**做 `writableRoots` containment（重新 resolve 捕获并发替换的 symlink 祖先）。文档明言：**这是 trusted-code containment，不是内核安全边界**——真正的边界在内核（Landlock），进程内 fence 是"第二道防线 + 精确错误报告"。

### fs-observation-policy（先读后写/编辑）

```text
read → emit fs/observed {kind:'present', version}
write → fs/write-intent waterfall（单槽决策）
  未观测 → createIfAbsent
  已观测 → replaceIfVersion（版本守卫在提供方原子临界区内执行）
  陈旧   → FS_STALE_VERSION
```

观测状态是 `WeakMap<owner, Map<targetKey, FsObservation>>`——每 agent 一份，不跨会话泄漏。**没有该策略插件时，意图瀑布默认 undefined = 裸写**——策略是可选插件，不改变 schema。

## 7. 设计权衡总结

| 决策 | 权衡 |
|---|---|
| 进程沙箱而非容器 | 轻量、零镜像、共享执行世界；代价是文件系统是唯一隔离维度，网络/CPU 不管 |
| 自研 Landlock launcher | 无 root、无依赖、fail-closed；代价是仅支持启用 Landlock 的 Linux（ABI 从 1 起协商），且要自己维护 UAPI |
| 方言化失败分类 | 分类准确；代价是每后端一份手工契约 |
| escalation 只授权本次调用 | 无持久提权；代价是模型每次重试都要重新审批 |
| fs fence 进程内 + 内核双边界 | 精确错误报告；代价是"看起来是边界"的误导风险（文档明确标注） |

## 8. 面试要点

::: tip 面试要点 1：为什么 SandboxPolicy 不包含 danger-full-access？
`ConfinedSandboxMode` 排除之：只有前两种模式发给提供方。danger-full-access 的语义是"消费方根本不调 confine"，把它当策略值会造成"沙箱在包装空操作"的假象。
:::

::: tip 面试要点 2：Landlock launcher 为什么退出 125？
launcher 失败与命令失败的区分信号。executor 的结构化规则（退出码门控 + 致命行匹配）据此把失败归类为 `SANDBOX_UNAVAILABLE` 而不是命令失败。
:::

::: tip 面试要点 3：审批为什么"必须在开放 turn 内"？
审计对 `approval/asked`→`approval/decided` 必须被 turn 包裹——否则崩溃恢复后回放会丢弃无主的审计事件，出现"有决定没提问"的脏状态。
:::

::: tip 面试要点 4：为什么模型能看到沙箱策略？
通过 system prompt 上下文（`sandbox:policy` section）。模型知道自己被限制才能正确重试/升级——把策略暴露给模型是 agent 沙箱的独特设计，与"对模型隐藏实现"的传统安全思路相反。
:::

下一篇：[04 · 上下文工程](/deep-dive/context)——compaction 如何在不动循环的前提下"压缩"模型历史。
