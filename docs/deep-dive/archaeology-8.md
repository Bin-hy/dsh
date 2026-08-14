# 源码考古：进程外子代理的三个"刻意省略"

> 第三季 · 第 8 期。四条审计全部落在"省略"上：ACP 客户端宣告**空能力集**（父进程什么都不提供）、Codex 用**缓冲重放**处理早到通知、Claude Code 刻意**省略 settingSources**、agent-instructions 的辅助函数**从不落盘**。共同的结论：省略不是缺失——每个省略都有一句注释或一条测试在守护它。

## 1. A10-4：空能力集 = 边界的声明

`packages/subagent/subagent-acp/src/run.ts:296-301`：

```ts
await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  // Advertise NO optional client capabilities (no fs, no terminal): the
  // child self-serves in its own process.
  clientCapabilities: {},
})
```

`clientCapabilities: {}` 不是"忘了填"——注释明说：**父进程不向子进程提供任何可选能力，子进程在自己进程里自给自足**。

这与 ACP 的权限桥（第 10 章：请求权限时自动应答、不暴露给人类）是一条边界的两面：父进程对子进程既不给能力、也不替它做决定。空能力集的影响面：若子进程经 ACP 协商 fs/terminal 能力，拿到的答复是"没有"——它必须自带。**省略 = 边界声明**。

## 2. A10-5：早到通知不是窗口，是缓冲重放

`packages/subagent/subagent-codex/src/wire.ts:268-277` 的 `commitTurnId`：

```ts
private commitTurnId(id: string): void {
  if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
    throw new Error('subagent-codex: turn/start response did not match the active turn')
  }
  this.turnId = id
  const notifications = this.earlyTurnNotifications.splice(0)
  for (const notification of notifications) {
    this.handleNotification(notification.method, notification.params)
  }
}
```

原存疑担心"早到通知的放行窗口"。实际机制是**三段防御**：

1. `observePendingTurnId`：早到通知暂存 `earlyTurnNotifications`（不丢弃、不用错 id 处理）
2. `commitTurnId`：turn/start 响应到达时**严格校验**响应 id 与 pending id 一致，不一致抛错
3. 校验通过后才**按序重放**缓冲的通知

再叠加 `validateRunIds` 拒绝跨线程/跨轮次的引用。结论：**没有"放行窗口"，只有"缓冲 + 校验 + 重放"**——存疑证伪，且这个模式值得直接抄（协议层消息乱序的教科书解法）。

## 3. A10-6：省略 settingSources 是"读宿主的常规设置"

`packages/subagent/subagent-claude-code/src/run.ts:177-195` 的 `claudeQueryOptions`：

```ts
return {
  abortController: controller,
  cwd: spec.cwd,
  pathToClaudeCodeExecutable: spec.executable,
  env: { ...scrubbedParentEnv(), ...spec.env },
  persistSession: false,
  disallowedTools: ['AskUserQuestion'],
  spawnClaudeCodeProcess: ...,   // 进程树归 subprocess seam
  // 没有 settingSources / canUseTool / elicitation / 对话回调
}
```

刻意省略清单与理由（Agent Note 记录）：

- **settingSources 省略**：SDK 相对于父会话 cwd 读宿主的常规用户/项目/本地设置——不复制、不过滤、不创建登录状态
- **canUseTool/elicitation/对话回调省略**：无人值守交互经 SDK 失败而非等待 UI
- **persistSession: false**：一次性委派不留会话

省略的语义是"**继承宿主的设置文化，但不继承宿主的交互能力**"。子代理用 Claude CLI 的常规设置（用户的 ~/.claude），但任何需要人类参与的时刻直接失败——这正是"无人值守委派"的诚实定义。

## 4. A13-2：一个从不落盘的辅助函数

`packages/context/agent-instructions/src/index.ts:162`：

```ts
const baselineContent = workspaceContextMessage(instructions.rendered.text).content
...
authorityMessages.push(createUserMessage({
  content: baselineContent,
  source: { kind: 'agent-instructions', form: 'instructions', baseline: true, ... },
}))
```

`workspaceContextMessage` 产出 `{kind:'plugin'}` source 的消息，但调用方**只取 `.content`**，再用权威 source 重建。所以它的 plugin source 永不落盘——辅助函数的"保留动机"：它给了中间态一个合法的 Message 形状（冻结、带 id），而最终消息必须带 `baseline: true` 等权威字段。

审计结论：**机制完全清楚；"为什么不用更轻的内联构造"没有注释说明**（推断是测试复用 + 形状便利）。这是"事实清楚、动机未注"的第四类结局——不阻塞，记一笔即可。

## 5. 本篇消化的 backlog 项

- ✅ A10-4 ACP 空能力集（注释明说：子进程自给自足，边界声明）
- ✅ A10-5 codex 早到通知（**证伪**：缓冲 + 严格校验 + 按序重放，三段防御）
- ✅ A10-6 claude settingSources 省略（继承宿主设置文化、不继承交互能力）
- ✅ A13-2 workspaceContextMessage（机制清楚，动机未注的第四类结局）

## 6. 下一期预告

考古⑨候选：A13-5（pre-step 18 个注册文件的完整清单）、A13-6（time-context prepend 顺序）、A13-7（目录宽容跳过与不变式的张力）、A10-1（ACP max-turns 归一）。
