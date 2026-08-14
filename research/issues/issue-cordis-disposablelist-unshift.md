# Issue 素材：非 global 的 `internal/update` prepend 注册在 DisposableList 上崩溃

> 状态：已运行时复现 ✅（本仓库 vendored 4.0.0-rc.7 与发布版 4.0.1 同源确认）
> 素材维护：dsh-blog 第三季"源码考古"。可直接改写提交到 deepseek-ai/DeepSeek-Harness 或 cordiverse/cordis。

## 标题（建议）

`cordis: TypeError when registering a non-global internal/update listener with prepend: true`

## 环境

- `vendor/cordis`（vendored 4.0.0-rc.7，`events.ts:141-145` + `utils.ts` DisposableList）
- 发布版 `@deepseek-ai/cordis@4.0.1`（`lib/index.js:238` 同模式）——两处均存在

## 复现

```js
import { Context } from '@deepseek-ai/cordis'
const root = new Context()
root.plugin({
  name: 'repro',
  apply(ctx) {
    // 崩溃：TypeError: this.fiber._hooks.internal/update[...] is not a function
    ctx.on('internal/update', () => {}, { prepend: true })
    // 对照：global 走普通 hooks 数组的 unshift，正常
    ctx.on('internal/update', () => {}, { global: true, prepend: true })
  },
})
```

实际输出：

```text
RESULT: CRASH -> TypeError: this.fiber._hooks.internal/update[(intermediate value)...] is not a function
RESULT: global internal/update prepend OK
```

## 根因

1. `events.ts:141-145` 的 `internal/listener` 拦截器把**非 global** 的 `internal/update` 监听器注册进 `fiber._hooks['internal/update']`（一个 `DisposableList`）：

```ts
if (name === 'internal/update' && !options.global) {
  const hooks = this.fiber._hooks['internal/update'] ??= new DisposableList()
  const method = options.prepend ? 'unshift' : 'push'
  return hooks[method](listener)      // ← prepend 时 hooks.unshift 为 undefined
}
```

2. `utils.ts` 的 `DisposableList` 只有 `push / delete / clear / 迭代器`，**没有 `unshift`**（类注释自称 "Ordered collection"，但排序只支持尾部追加）。
3. 普通 hooks 数组路径（`events.ts:255`）的 `prepend ? 'unshift' : 'push'` 是数组方法，天然可用——所以只有"非 global + internal/update + prepend"这个组合踩中。

## 影响

- 当前仓库内所有 `internal/update` 注册者都带 `global: true`（loader 写回钩子/日志钩子、events.ts 编排者），**没有生产触发者**——潜伏 bug。
- 任何未来插件/扩展在预设或用户 patch 里做"抢在默认 restart 前拦截更新"的非 global prepend 注册，会在**插件加载期**直接 TypeError，且错误信息不指向根因（"is not a function"）。

## 修复建议（三选一）

1. **最小**：`DisposableList` 增加 `unshift(value)`（负向 sn 序列或 `Map` 头部插入，保持 O(1) 删除语义），`events.ts` 无需改动。
2. **语义澄清**：若"internal/update 只允许 global prepend"是有意设计，则在拦截器里对非 global prepend **fail loud**（抛带说明的错误），而不是 TypeScript 都拦不住的运行时 TypeError。
3. **删除特判**：若非 global 的 internal/update 监听器本应走普通 hooks 数组，则移除该拦截分支（需评估 `fiber._hooks` 存在的原因——它在 `_unload` 从不清理，见下一条 issue 素材）。

## 关联发现

- `fiber._hooks` 在 `_unload` 从不清理（backlog A11-3）：Group 的 update 监听器跨重载存活。若修复本 bug 时顺带审视该生命周期语义，两个问题应一起评估。
