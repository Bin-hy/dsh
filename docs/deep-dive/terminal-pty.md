# 12 · 终端与 PTY：把"机制"与"策略"拆开的四层分权

> 消化 backlog A12。DSH 的终端子系统回答一个问题：**agent 需要真正的交互式终端，而不是一次性的 `bash -c`**。本章拆解四层分权、三层就绪推断、提示符 marker 协议与 TERM→KILL 全树停稳。

## 1. 为什么普通 spawn 不够

一次性 `bash -c` 的问题：cwd、导出的变量、venv 激活、作业控制、交互子进程（gdb 单步、REPL 探索、中断前台命令后继续）——**全部随调用结束而消失**。状态活在终端里。

`spawnTerminal` 是 subprocess seam 的**唯一非管道进程原语**，源码注释（`packages/subprocess/subprocess/src/types.ts:229`）给出它必须是"深原语"的理由：

> 终端分配、前台进程组检查/发信号、会话树清理三者，"none can be reconstructed from ordinary piped stdio without substrate-specific process control"。

管道的行缓冲、无控制终端、无作业控制、无 tpgid——永远模拟不出交互式 shell。

## 2. 四层分权：机制归提供方，策略归消费方

| 层 | 管什么 |
|---|---|
| **提供方** `subprocess-local` | 终端机制：node-pty 分配、UTF-8 文本传输、前台组检查/发信号、TERM→KILL 全停稳 |
| **注册表** `dsh-terminal` | per-agent id 铸造、授权（`FOREIGN_SESSION`）、发布、清理（含未发布 spawn） |
| **后端** `dsh-terminal-bash` | 提示符检测、就绪推断、scrollback、sandbox 策略、owner-aware 生命周期 |
| **消费方** `tool-terminal` | 六个模型面工具、后台任务接入 `ctx.jobs`、结果字节终审 |

最关键的一句话（`docs/subsystems/subprocess.zh.md:243`）：**提供方只给"基底事实"**——`SubprocessTerminalForeground = { processGroupId, inputWaiting }`（"该进程组是否在等待 stdin"）。提示符长什么样、静默多久算就绪，全是后端策略。

### 为什么提示符检测不放在 subprocess 层？

决策记录（AgentNote:29/149）给出三个理由：

1. **基底事实与策略的边界**：pgid/inputWaiting 是平台可观测事实；`PS1`/`PROMPT_COMMAND` 是 bash 专属协议。换 shell、换 REPL，策略全变而原语不变
2. **"把 TerminalIdleDetector 做成可替换注册表"被明确否决**——那是制造第二个公共契约；真正的扩展点是**执行世界替换**（把整个 subprocess 指向远程沙箱）
3. **避免契约通胀**：提供方若理解每个 shell 的提示协议，每加一个交互程序都要改提供方。现状是提供方永不升级，Tier A/B/C 全部在 `session.ts` 一个文件内演进

::: tip 面试要点："少一个抽象"
这是"何时不该抽象"的正面教材：当扩展需求是"换平台/换执行世界"而不是"换检测算法"时，检测算法就应该留在消费方私有实现里，而不是变成可替换服务。
:::

## 3. 就绪推断：三层阶梯 + 绝对超时

`terminal_send` 的结算靠 `pollReadiness`（`session.ts:423-476`，每 50ms 一轮）：

```text
Tier A  精确提示符：prompt marker + 静默 ≥ pollInterval + 前台组 == shellPgid → stdin_read
Tier B  Linux syscall 探针：startupHasOutput + 进程组真实地在等 stdin → stdin_read
Tier C  静默推断：startupHasOutput + 静默 ≥ idleSilenceMs + handoffGrace → inferred_idle
Tier D  绝对超时 → timeout
```

两个语义锚点：

- **`waitReason` 与 `sessionStatus` 正交**：`inferred_idle`/`timeout` 从不代表命令退出；`session_exit` 只指**顶层 shell** 退出。system prompt 直接把这个事实教给模型："An inferred_idle or timeout result does not prove the foreground command exited"
- **结果类型显式携带不确定性**：模型拿到的不是布尔"就绪"，而是带置信度的 `waitReason`——**精确 vs 推断是调度赌注，不是可解竞态**，赌注胜负交给配置（`handoffGraceMs` 默认 500ms，校验强制 ≥ 一个轮询周期）

### 提示符 marker 协议

后端注入受控环境（`terminal-bash/src/index.ts:62`）：

```text
PS1 = 'dsh> '
PROMPT_COMMAND = printf "\033]133;D;%s\007" "$?"   ← 每次提示前发 OSC 私有 marker
```

`TerminalSanitizer` 流式剥离 CSI/OSC 转义，识别 `133;D;` marker 后跟踪 `promptTail`——**必须精确等于 `dsh> `** 才算 `promptTextSeen`。一旦回声输入或后续输出混入，精确匹配失败——"拒绝被延迟的旧提示符结算当前发送"。

## 4. 沙箱：spawn 期包装 + 运行期降级拦截

PTY 进程本身被 `ctx.sandbox.confine` 包装（不只启动命令）：

```ts
// terminal-bash/src/index.ts:71-80
const argv = [config.shellPath, ...config.shellArgs]
if (policy.mode === 'danger-full-access') return argv      // 显式无约束选择
return sandbox.confine(argv, { ...policy, mode: policy.mode }).argv
```

运行期还有第二道 fence：`ensureSandboxModeFence` 监听 `sandbox/mode` 事件——若真实降级且 `hasOwnerActivity(owner)` 为真（**覆盖未发布 spawn 到关闭的全区间，无空窗**），直接抛错拒绝事件写入："cannot change sandbox mode while persistent terminal sessions are open or being created"。

## 5. 清理：PID 身份围栏 + TERM→KILL 全树验证

`LocalTerminalHandle.closeOnce`（`subprocess-local/src/terminal.ts:236`）的关闭序列：

```text
1. stopDescendants：捕获子进程集 → SIGTERM 全体 → graceMs 轮询 → 重扫（防 fork 逃逸）→ SIGKILL → 等
2. stopShell：SIGTERM → race(done, grace) → 未退 SIGKILL → 仍活抛"surviving pid"
3. 二次 stopDescendants：验证每个非僵尸后代都离开进程表
```

**PID 身份围栏**（`{pid, started}` 启动身份）：只有"数字根 pid 仍携带 shell 启动身份"时才收养新扫描的成员——**shell 死后 pid 被回收，不得把无关进程捐给本会话发信号**。Linux 僵尸（`Z` 状态）无可执行工作，算静默。

还有一条安全线：`SIGKILL && foreground.processGroupId === shell.pid` 时**拒绝执行**——"refusing to SIGKILL the terminal shell"（杀顶层 shell 用 `terminal_close`）。

## 6. 有界性：三层字节上界

"Apply bounds to the complete result"（仓库纪律）在终端系统体现得最完整：

| 层 | 上界 |
|---|---|
| 后端 | scrollback 双界（行数 10_000 + 字节 4MiB，超限保尾部）+ 单页 `maxReadBytes` |
| 工具层 | `maxResultBytes`（默认 256KiB）经 `finalizeContent` **终审**——覆盖错误、元数据、分页标记等全部后缀 |
| 任务层 | `outputLimitBytes` 上到 job 快照，`job_output`/完成通知同限 |

`utf8Tail` 按 code point 从尾向前累计——绝不在 UTF-8 多字节序列中间切断。

## 7. 三个设计权衡

| 决策 | 权衡 |
|---|---|
| 一次 send 独占（`SEND_ACTIVE` 双护栏） | 输出与取消不跨操作所有权；取消的 reservation 保留到在途前台信号结算为止——后继发送不会成为在途 SIGINT 的靶子 |
| 平台退化是显式契约 | macOS 无 syscall 探针（Tier B 缺席，静默推断对任何前台组生效）；Windows 直接 throw（ConPTY 整体延后）。**退化是声明，不是 bug** |
| 持久性边界 | 原始终端字节是**有界进程内状态**，不自造会话事件；模型可见的每段文本都走 `tool/call`/`tool/result` 路径——"跨工具调用持久，不跨进程重启持久" |

## 8. 面试要点

::: tip 面试要点 1：为什么 spawnTerminal 是"深原语"而不是 spawn + 参数组合？
控制终端的三个语义（终端分配、前台组、会话树清理）都无法用管道 stdio 重建。提供方把三者封装成一个不可再分的原语，消费方才不会拼出看似可行实则残缺的组合。
:::

::: tip 面试要点 2：就绪检测为什么是三层阶梯？
精确 marker（bash 专属）→ Linux syscall 探针（平台精确）→ 静默推断（启发式）。每层是上层的退化，且结果类型携带精确/推断之别。设计哲学：**把不确定性交给类型，把竞态胜负交给配置**。
:::

::: tip 面试要点 3：PID 身份围栏解决什么问题？
pid 复用误杀：shell 死了、pid 被回收、新进程占了旧 pid——若只按数字 pid 清树，会 SIGKILL 无关进程。`{pid, started}` 启动身份保证"数字根 pid 仍携带 shell 身份"才收养成员。
:::

::: tip 面试要点 4：为什么 PTY 会话必须 per-agent 身份？
终端是可写副作用资源——向 PTY 写入等于向任意进程的 stdin 键入命令。授权比较的是**确切的 Agent 实例**（不是名称/id），清理绑定 owner 的 ctx effect（agent 销毁即关全部会话）。
:::

下一篇：会话持久化内核 / 进程外子代理与 ACP / 作用域与事件内核（研究中）。
