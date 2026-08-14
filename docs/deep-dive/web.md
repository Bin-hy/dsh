# 07 · Web GUI 与 API 层：插件化的浏览器应用

> DSH 的 Web GUI 是最能体现"一切皆插件"哲学的部分：**前端也是一个 Cordis 应用**。宿主把各包的浏览器 bundle 组装成启动图注入 `window.__DSH_BOOT__`，浏览器壳用 vendored Cordis Loader 把每个 bundle 变成插件 fiber，UI 从 slot 系统里"长"出来。本章拆解启动链路、事件推送、增量渲染与 Typert RPC 网关。

## 1. 启动链路：从 `dsh web` 到浏览器里的插件树

```text
dsh web（= dsh --profile web）
  → 宿主 Cordis 树挂载 webserver + connection + modules + api-gateway + 全部 ui-* 插件
  → ClientModuleRegistry 扫描 Loader entry 中声明 dsh.client 的包
  → 组合出 WebBootGraph {rev, entries:[{id, url, rev, inject}]}
  → 注入 index.html 的 <head> 第一个脚本：window.__DSH_BOOT__ = graph
浏览器加载
  → AppWebEntry 两阶段启动：
     ① 模块面：parseBootManifest → ClientModuleSystem（惰性 CJS 表）
     ② 插件面：vendored Cordis Loader 把每个 bundle 挂成插件 fiber
  → UI 从 'root' slot 渲染（整个布局挂在唯一 ctx 级 slot 上）
```

### 关键设计：为什么注入启动图而不是打包死？

- **宿主组合决定、浏览器执行**：页面壳是自足的（可以独立构建/缓存），插件组合是运行时的
- **`rev` 哈希一致性锚**：bundle URL 带 `?rev=<hash>`，内容变化即 URL 变化，缓存失效由哈希驱动
- **惰性 CJS 模块系统**：执行 bundle 只注册 factory，副作用（含 CSS 注入）在物化时才运行——启动快，且 HMR 可以 `invalidate(id)` 精确失效

前端也跑 vendored Cordis Loader——**与宿主同构**。插件依赖注入、slot 注册、作用域，浏览器里和 Node 里是同一套心智模型。

## 2. 事件推送：非对称双流

传输是非对称的：**WS 只下行，HTTP 负责上行**。

```text
浏览器 → Host：HTTP POST /api/<channel>/<endpoint>（unary 用 fetch，流用 WS async generator）
Host → 浏览器：两条 WebSocket
  /api/events.mux   会话事件流（session/event、approval、question、queue、jobs、projection）
  /api/events.host  宿主级事件流（session-added/removed、agent-error、remote-event）
```

每"代"连接做**严格握手**：`host.describe` 一元 RPC + 双流 onOpen + 超时护栏，失败指数退避重连（500ms 起、×2、上限 10s、加抖动）。

帧协议的设计要点：

- **带状态的帧都是全量快照**（`session/queue`、`session/jobs`、`session/projection` 是 whole-value，last-wins）——只有 `session/event` 是日志增量
- `session/subscribed` 是每代流的基线水位（`lastSeq`）——重连后从水位继续
- Host 侧 WS 泵只下行：**客户端发消息即 1008 关闭**

## 3. 增量渲染：浏览器端的"第二个折叠引擎"

浏览器里有一台与 Host 会话日志正交的增量折叠引擎：

```ts
// packages/client/runtime/src/client/contract/conversation.ts:171
interface ConversationNodeDefinition<State = unknown> {
  readonly kind: string
  match(event: SessionEvent): ConversationMatchResult | null
  start(context, match, reader): State
  update(context, match): State      // 按日志 seq 升序折叠
  publication?(match): 'none' | 'animation-frame' | 'immediate'
  buildViewNode?(context): ConversationViewNode | null
}
```

数据流（一次对话回合）：

```text
Session.handleMuxEnvelope() → appendLive()
  → ConversationNodeAssembler.append()      // 每个事件找到自己的 node definition
  → assistantDefinition.update() 折叠 chunk  // token 级增量进节点状态
  → 请求 'animation-frame' 发布
  → Notifier（微任务/RAF 节流）→ ChatSnapshotBuilder 增量建快照
  → uSES getSnapshot 返回新引用 → ChatNodeSeat 只重渲染变化节点
```

两个关键工程决策：

1. **数据对象层零 React**：`ConnectionController → SessionManager → Session` 全是纯 TS 类，React 经 `useSyncExternalStore` 订阅。可测试性、可复用性、渲染无关性三赢
2. **快照是缓存引用**：脏时在 flush 前重建；无监听时惰性重建。节流靠 notifier 的微任务/RAF 批量

## 4. Slot 系统：UI 的唯一组合通道

```ts
// packages/client/ui-slots/src/index.ts:87
type SlotKind = 'single' | 'list' | 'keyed' | 'chain'
ctx.slots.register({name: 'conversation.chat.node', ...}, Component)
```

- slot 名镜像组合路径 `<domain>.<entry>.<hole>`（如 `conversation.chat.node`）
- **keyed slot** 按条目 `key` 分派——`ChatNodeSeat` 用 `entryKey: node.kind` 把业务节点分派给对应渲染器
- 组件 props 是四个 share 的交集：框架座（`useSession`/`sessionId`/`useProjection`）+ 声明的 children slot + store 工厂 + inject 面

这就是架构文档里"添加 Web Client Chat 节点 = 注册 `ConversationNodeDefinition` + keyed renderer"的实现。

## 5. Typert RPC 网关：代码生成 + 运行时反射

DSH 没有手写 API client。RPC 是**构建期类型图生成 + 运行时反射**双轨：

```text
Host 侧：业务方法上的 @Remote / @RemoteScope 装饰器
  → TS Program 严格分析（typert/generator/analyzer.ts）
  → 生成 InvocationDescriptor（strict codec + schema）
  → Gateway 按 endpoint 解析 lookup/context → 调用实时 Cordis 服务
Client 侧：ctx.remote.<namespace>.<method> 是具体函数（无 Proxy）
  → POST /api/<channel>/<endpoint>，rpcId 关联响应
```

关键点：

- **装饰器不启动 TS 分析**，只把方法名记进模块私有 WeakMap——严格反射是 Typert compiler 的职责（构建期）
- **wire 上只有 id**：`lookup`（如 `agentId` → Host 对象）与 `context`（作用域 Context）由注册的 resolver 解析——客户端永远不传 Host 对象
- **SRC 回退**：源码启动模式下从 `Function.prototype.toString` 解析参数名——开发体验与构建产物两条路都通

## 6. 信任围栏：Web 安全的实际做法

`/api` 的"鉴权"不是 session cookie——是**DNS-rebinding/跨站信任围栏**（`packages/client/connection/src/api-request-trust.ts`）：

- 校验请求的 Host 头与来源，拒绝跨站调用
- `PRIVILEGED_METHODS` 环回钉死

这是"localhost 上跑 agent 控制台"场景的真实安全需求：浏览器里的恶意网页不能借 DNS rebinding 打你 localhost 的 agent。

## 7. 三条并行出口

| 出口 | 面向 | 形态 |
|---|---|---|
| Web GUI | 人类 | 插件化浏览器 Cordis 应用 |
| ACP | 自动化 agent | stdio NDJSON JSON-RPC；只发已提交文本、一键权限 |
| SDK | 编程 | `initialize/prompt/shutdown` + 4 种事件通知；TS client spawn 子进程 |

有趣的事实：**ACP 的权限应答者就是 `approval/request` 的监听器**（`pkg_acp → svc_approval` 那条边）——自动化协议与人类 UI 在审批 seam 上平权。

## 8. 面试要点汇总

::: tip 面试要点 1：为什么前端也用插件架构？
与宿主同构：一套依赖注入、事件、作用域的心智模型贯穿前后端；UI 组合由部署决定（bundle patch 决定挂哪些 ui-* 行）；HMR 可热换插件而不重载页面。
:::

::: tip 面试要点 2：为什么"带状态帧全量快照 + session/event 增量"混合？
快照帧（queue/jobs/projection）是 last-wins 的派生状态，全量重发简单且自愈；日志帧是追加事实，只能增量。两者混在一个 mux 流里，靠帧类型区分语义。
:::

::: tip 面试要点 3：浏览器端为什么还有第二个折叠引擎？
Host 折叠的是"模型可见 surface"（三种事件）；浏览器折叠的是"UI 可见节点"（assistant chunk 流成消息卡片、tool call 流成终端卡）。两者的语义目标不同，折叠规则不能共享；但输入都来自同一事件流，保证最终一致。
:::

::: tip 面试要点 4：为什么要构建期生成 RPC 描述符而不是运行时 Proxy？
类型安全在构建期被 TS Program 强制验证；运行时只有描述符解析（快、可审计）；Client 端具体函数无 Proxy 魔法，调用栈清晰。
:::

下一篇：[08 · 持久化与工程化](/deep-dive/engineering)，看 56 包的 monorepo 如何自我管理。
