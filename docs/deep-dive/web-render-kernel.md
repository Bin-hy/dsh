# 14 · 前端渲染内核：slot 引擎与 RPC 切帧契约

> 消化 backlog A14。本篇拆浏览器端的四个内核：API Proxy 的 RPC 路由与帧顺序、`scoped-slots` 渲染器、`defineStore` 快照引擎、vendored Loader 的浏览器契约。并给出一个诚实的否定结论：Electron 路径不存在。

## 1. RPC 路由与帧顺序：四象限同步切

**方法名即 POST 路径段**：`UNARY_ROUTES` 把 `/api/<channel>/<endpoint>` 分派到业务 handler（`handler.ts:90`）。mux 流打开的帧顺序是一份契约：

```text
1. session/subscribed { lastSeq = seq-1 }   ← 先发基线水位
2. session/event 帧                          ← 再发增量
```

history 尾页的投影块与事件**同步切**——`asOfSeq` 与 `lastSeq` 同约定（`session-projection/index.ts:254`）。客户端的缝隙检测（`session.ts:627`）正是依赖这套顺序：如果收到事件帧时没有先收到 subscribed，就知道错过了前缀，触发 resync。

::: tip 面试要点：为什么"先基线后增量"必须是协议而不是实现巧合？
因为丢帧检测需要它。客户端不可能主动知道"我少收了哪些帧"，只能靠"水位 + 连续 seq"推导。把顺序写进实现、把依赖写进客户端检测逻辑，中间态（断开重连、慢订阅）才有一个可判定的恢复语义。
:::

## 2. scoped-slots 渲染器：身份缓存与 keyed 分派

`scoped-slots.tsx`（909 行）的四个机制：

- **outlet 按 entry 身份缓存**（WeakMap）：同一个 slot 声明的多次渲染共享绑定，entry 身份变化才重建
- **keyed 分派**：`opts.entryKey` 在 `entriesOfSlot` 投影里找 cell（`scoped-slots.tsx:766`）——ChatNodeSeat 的 `entryKey: node.kind` 就是这么路由到对应 renderer 的
- **hookContext 传递**：函数型 slot 钩子经 `ContextualEntry` 拿到上下文（`scoped-slots.tsx:448`）——组件的 hooks 能力由"它被挂在哪"决定
- 附带三件套：chain selector 路由、list 遮蔽（同名上层 slot 遮蔽下层）、session-maybe 收养、**entry 级错误边界**（一个坏组件不炸整个会话视图）

## 3. defineStore：zustand + immer + RAF 批处理

`createSnapshotStore` = zustand vanilla + immer `produce` + `rafBatch` + 手写持久化：

- **组件只读**：经 `props.useStore`（唯一的 uSES 桥，`bind.ts:18`）订阅快照；**写入走 `props.actions`**——读写分离在类型层
- **实例缓存**：按 `handle × scopeKey` 缓存（`slots.ts:423`）——同一个会话的多个组件共享同一个 store 实例
- **手写持久化**而不是 zustand/persist：持久化语义（何时 checkpoint）是领域决策，不能委托给通用库

::: tip 面试要点：为什么"数据对象层零 React"能成立？
因为 store 与 Session 都是纯 TS 类，React 只是订阅者。这带来三个收益：可以在 worker/测试环境用同一状态机、渲染层可以整个换掉（如换 Solid）、快照语义（last-wins、增量）在框架外被明确定义。
:::

## 4. Loader 的浏览器契约

`ClientModuleLoader` 四个钩子（`manifest.ts:190`）：

```ts
import(specifier, parentURL, attrs)   // 惰性物化
registerStatic(id, module)            // 静态种子
prefetch(id)                          // 预取
invalidate(id)                        // HMR 失效
```

`tree.import` **优先走 `internal.import`**（`tree.ts:154`）——vendored Loader 的插件树加载在浏览器里被 `ClientModuleSystem` 接管，Node 与浏览器共享同一份 Loader 源码，只有"模块解析"这一层被替换。

## 5. 诚实的否定：Electron 路径不存在

研究笔记 06 曾存疑"Electron 走 file:// + IPC 桥"。全仓库搜索结论：**不存在**——无依赖、无 IPC 代码、apps/web 零提及，只有 `webserver/src/index.ts:7` 一行"Web shape only"注释预留说明。文档提到它只是"设计上预留了形状"，当前树没有任何实现。

## 6. 面试要点

::: tip 面试要点 1：为什么 slot 是"声明即授权"？
组件通过 `ctx.slots.register({name, children?})` 声明它渲染哪些子 slot——**未声明的 slot 渲染调用是类型错误**。组合关系在类型层显式化，运行时不存在"任意组件挖任意洞"。
:::

::: tip 面试要点 2：为什么浏览器测试串行共享浏览器？（接第 A19 篇）
slot 渲染的 keyed 分派、快照缓存、RAF 批处理都是**有状态**的——文件级并行会让快照互相污染。串行是"确定性优先于速度"的又一次出现。
:::

下一篇：调度、命令与会话引用。
