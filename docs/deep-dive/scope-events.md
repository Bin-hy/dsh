# 11 · 作用域与事件内核：拆到框架源码的 waterfall

> 消化 backlog A11。这一篇下探到 vendored Cordis 的事件系统源码：`dispatch()` 的 thisArg 移位、waterfall 的洋葱组合、作用域过滤为何是"carrier 单方面的插件行为"、以及 `session.append` 的两段式提交。

## 1. 事件总线：五种分发，一个 dispatch

`vendor/cordis/src/events.ts` 的五种模式（其中 `bail` 是 `serial` 的同步版，DSH 上层只用前四种）：

```ts
export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'
```

`emit` 的实现有一处值得背下来的细节（`events.ts:194-196`）：

```ts
emit(...args: any[]) {
  this.dispatch('emit', args).map(cb => cb(...args))   // Array.map：同步逐个执行
}
```

**一个监听器 throw 会饿死后面的监听器**——这就是为什么 `session/event` 这类 fire-and-forget 广播必须在消费者侧重写包含（try/catch + 异步 rejection catch），框架层不兜底。

## 2. dispatch()：thisArg 移位 + 符号过滤

```ts
// vendor/cordis/src/events.ts:165-175
dispatch(type: string, args: any[]) {
  const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
  const name: string = args.shift()
  if (!name.startsWith('internal/')) {
    this.emit('internal/dispatch', type, name, args, thisArg)   // 分发前诊断
  }
  const filter = thisArg?.[Context.filter]
  return (this._hooks[name] || [])
    .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))
    .map(hook => hook.callback.bind(thisArg))
}
```

三个步骤依次：

1. **thisArg 移位**：第一参数是对象/函数就移出当 `this`——作用域载体（carrier）由此进入分发
2. **`internal/dispatch` 诊断**：非 internal 事件在过滤前广播——`session` 的不变量借此做"提交前校验"
3. **过滤 + 绑定**：`hook.global` 直接放行；否则若 thisArg 带 `[Context.filter]`（**只有 carrier 才有**），用 `filter.call(thisArg, hook.ctx)` 询问

**Cordis 完全不知道 dsh-scope 的存在**。作用域过滤是 carrier 对象单方面实现的插件行为——事件总线只认一个符号键。这是"零耦合扩展"的教科书案例。

## 3. waterfall：同步洋葱的三个步骤

```ts
// vendor/cordis/src/events.ts:234-243
waterfall(...args: any[]) {
  const cbs = this.dispatch('waterfall', args)   // ① 移位/过滤/绑定，消费掉 thisArg 与事件名
  const inner = args.pop()                       // ② 调用方传入的最后一个参数 = 最内层 next
  const next = () => {
    const cb = cbs.shift() ?? inner              // ③ 注册序出队，队空回落到默认行为
    return cb(...args)
  }
  args.push(next)
  return next()                                  // 从最外层监听器开始
}
```

一个"包装层拿到下游返回值"的最小例子：

```ts
ctx.on('demo/wrap', function (x, next) {
  const inner = next()      // 调下游
  return inner * 2          // 包装返回值
})
ctx.on('demo/wrap', function (x, next) {
  return next() + 1
})
ctx.waterfall('demo/wrap', 10, () => 100)
// === 202：inner(100) → B(+1 → 101) → A(×2 → 202)
// A 不调 next() 直接 return 'DENIED'：链断，B 与默认行为永不执行
```

### 为什么 waterfall 不 await？

组合是**同步的**：`next()` 闭包就是普通函数调用，返回值沿洋葱上传。深层原因在 `internal/get`/`internal/set`——它们挂在 **Proxy 陷阱**里（`reflect.ts:153`），陷阱不能是 async。waterfall 必须是同步的才能服务反射层。异步只是"监听器自己 `await next()`"。

### internal/update 的否决链（HMR 拒绝重载靠它）

`Fiber.update` 把 fiber 本地监听器串成子链：**任何一个不调 `_next()` 即否决整个更新**。这就是配置热重载时"插件可以拒绝"的机制落点。

## 4. 作用域过滤：四条规则

`scopeTarget(base, key)` 的过滤函数（`packages/core/scope/src/index.ts:170-185`）：

| 规则 | 实现 |
|---|---|
| 无标签监听器放行（全局观察者） | `if (tag === undefined) return true` |
| 标签在 carrier 键的**父链**上放行（事件向上流、不向下流） | `for (cursor = key; ...; cursor = scopeParents.get(cursor))` |
| 标签在键之下的**被排除**（子 agent 收不到父的事件） | 循环跑完 → false |
| 无主体 carrier（key=undefined）排除一切有标签监听器 | 循环不跑 → false |
| 保留 base 的既有过滤（Service 隔离过滤叠加） | `baseFilter` 先查 |
| carrier 键 ≠ 载荷主体 → 运行时不变式失败 | `scope/invariant.ts` + 生成的 `scoped-events.generated.ts` |

### carrier 的 key 从哪来：traceable 机制

session 的 carrier 在 `enter()` 时铸造：`scopeTarget(session, scopeOf(this.ctx))`。`this.ctx` 不是 store 的注册上下文——Service 基类打了 `tracker = {associate:'sessions', property:'ctx'}` 标记，`ctx.sessions` 经 `getTraceable` 变成代理，代理的 `get('ctx')` 返回**访问它的上下文**。所以 agent-loop 用 `agent.ctx.sessions.enter(session)` 时，carrier 的 key 自动就是那个 agent——**session 的 carrier 天生按"谁进入它"路由**。

## 5. ScopedLayers.effect：注册即 effect

```ts
// packages/core/scope/src/store.ts:226-266（语义提炼）
effect(ctx, action, options): () => void {
  const dispose = ctx.effect(function* () {
    const layer = scopeOf(ctx) ? 惰性创建或取 scoped 层 : global 层
    const undo = action(layer)          // 同步变更，返回撤销
    yield () => {
      undo()
      if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)  // 空层回收
      if (notify) this.onChange()
    }
  }, options.label)
  return dispose                        // 返回 ctx.effect() 的精确 disposer
}
```

- **空层回收**：某 scope 层的最后一次注册撤销后，层全空则从 Map 删除——HMR 重载依赖这个（插件重载时全部注册逆序撤销，层自动清空，不泄漏）
- 返回的 disposer 就是 `ctx.effect()` 返回的那个——身份可追踪，插件卸载时精确回收

## 6. session.append：两段式提交

```text
1. snapshotJsonValue 校验 + 深拷贝 → deepFreeze
2. surfaceManager.validateNext 校验 surface 契约
3. log.push(event)                 ← 提交
4. 同步调用 session/event 观察者   ← 快照在 push 前解析，回调在提交后运行
```

**观察者快照先于 log push 解析**——同步观察者看到的是"push 前的事件列表 + 新事件已在日志里"的一致视图；回调失败被兜住，**不改变 append 的返回值**（第 09 章持久化的根基）。

`internal/dispatch` 是这套时序的"提交前 stage"：`session` 的不变量在分发前校验事件合法性，能在坏事件进日志前炸出。

## 7. whenIdle 的收敛性

```ts
async whenIdle(): Promise<void> {
  let activity: Promise<void>
  do {
    await (activity = this.activityDone)
  } while (activity !== this.activityDone)   // 双重检查
}
```

收敛证明的要点：`activityDone` **在活动开始前赋值、结束后 resolve**。若旧活动退休前启动了替代工作，`activityDone` 已经指向新的 promise——循环重读发现身份变化，继续等。同步语义下没有竞态窗口（赋值与读取都在 JS 单线程内）。

## 8. 面试要点

::: tip 面试要点 1：作用域过滤为什么用 thisArg 而不是参数？
`thisArg` 是语言内置的"接收者"通道：JS 函数调用天然携带 `this`，不需要在事件签名里为每个事件加 scope 参数。加上 `bind(thisArg)`，监听器内部还能正常用 `this`。零协议成本。
:::

::: tip 面试要点 2：为什么"事件向上流、不向下流"？
子 agent 是父的委派工具，父需要观察子（结算通知、遥测）；子不能收到父的事件——否则子代理会看到它不该知道的全局状态。scopeParents 链恰好表达这个方向性。
:::

::: tip 面试要点 3：traceable 代理解决什么问题？
服务方法的 `this.ctx` 语义：注册上下文（谁提供）vs 访问上下文（谁调用）。作用域归属必须按**调用方**判定，traceable 让 `this.ctx` 返回访问者的上下文——一行代理机制，省掉了所有"显式传 scope 参数"的样板。
:::

::: tip 面试要点 4：waterfall 同步组合的代价是什么？
监听器不能依赖"框架帮我 await"；异步监听器必须自己 `await next()` 且不能逃逸（上游不会自动等）。但换来的是 Proxy 陷阱可用、调用栈可读、短路语义确定——对一个被高频调用的框架内核来说，同步是正确选择。
:::

下一篇预告：A13~A19 剩余聚类（技能深入 / 前端渲染内核 / 调度命令 / 重试凭据 / 编排已结 / 启动组合沙箱补遗 / 测试与 Typert）。
