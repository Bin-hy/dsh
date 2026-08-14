# Web GUI 与 API 层研究笔记

> 研究对象：DeepSeek Harness（DSH）仓库 `/deepseek-harness`（只读）。
> 范围：Web GUI（apps/web + packages/client 浏览器侧）、API 网关（packages/api + packages/typert）、ACP（packages/acp）、SDK（packages/sdk）。
> 依据：docs/subsystems/web.zh.md、web-server.zh.md、client-modules.zh.md、session-projection.zh.md、docs/api-gateway.zh.md、web-styling.zh.md，以及全部相关源码（以下所有 `文件:行号` 均已亲自核对）。
> 用途：教学博客素材。引用一律为 `文件路径:起始行`。

## 0. 一句话总结

DSH 的 Web GUI 是"**插件化的浏览器 Cordis 应用**"：宿主的 `dsh web`（本质是 `dsh --profile web`）启动一个 node:http 服务器，把每个声明了 `dsh.client` 的包编译出的浏览器 bundle 组装成一张启动图注入 `window.__DSH_BOOT__`；浏览器端的"壳"（shell）只负责解析这张图、加载 bundle、用 vendored Cordis Loader 把每个 bundle 变成插件 fiber，然后在浏览器里跑起一个与宿主同构的 Cordis 容器。UI 由各 UI 插件通过 **slot 系统**（`ctx.slots.register`）组装；业务数据由**数据对象层**（runtime，零 React）持有——两条 WebSocket 下行流把 session 事件增量推到浏览器，`Session` 对象把事件窗口折叠成 `ConversationSnapshot`，React 通过 `useSyncExternalStore` 订阅快照渲染。API 网关是"**代码生成 + 运行时反射**"的 Typert RPC：Host 侧用 TypeScript Program 严格分析 `@Remote` 方法并生成 wire 描述符，Client 侧在浏览器里把描述符挂成 `ctx.remote.<namespace>.<method>` 具体函数，经 Connection 的 `/api` HTTP 桥发起调用；ACP 与 SDK 则是面向自动化/编程的两条并行出口（stdio JSON-RPC）。

---

## 1. 概念地图

### 1.1 全局分层（自底向上）

| 层 | 职责 | 所在包 |
|---|---|---|
| 传输载体 | node:http 服务器：具名路由注册表 + 回退席位 + index 转换 | `dsh-host-webserver`（packages/host/webserver） |
| SPA dist 服务 | 认领回退席位，serves 前端构建产物，每次 index 响应跑 index taps | `dsh-host-frontend-static`（packages/host/frontend-static） |
| Web 组合层 | `dsh --profile web` 的命令行解析、bundle patch（cordis.patch.yml）声明"web 表面"该挂哪些行 | `dsh-web-app`（packages/bundle/web-app） |
| Web 插件表 | 扫描 Loader entry 中声明 `dsh.client` 的包，组合 `window.__DSH_BOOT__` 图，serve `/plugins/<id>/client.js`，注入 index | `dsh-client-modules`（packages/client/modules，Node 半） |
| HMR | stat 轮询 bundle、经 SSE 广播 rebuilt 帧 | `dsh-client-hmr`（packages/client/hmr，Node 半） |
| 连接层（Host 半） | `/api` 路由 + 信任围栏、`/api/events.mux|host` WebSocket 下行、通用 RPC 通道注册表 | `dsh-client-connection`（packages/client/connection） |
| API 网关（Host） | 认领 `/api` 上的 Remote endpoint，解析 lookup/context，调用实时 Cordis 服务并校验边界 | `dsh-api-gateway`（packages/api/gateway） |
| Typert | `@Remote` 装饰器协议、构建期类型图生成、运行时注册表 | `dsh-typert-*`（packages/typert/） |
| API 组装（Host） | Agent/Session 身份策略（lookup resolver）、Remote 贡献挂载 | `dsh-api-remotes`（packages/api/remotes） |
| 浏览器壳 | 解析 boot manifest → 建模块表 → 挂 vendored Loader → 创建 entry → 全量 sweep → 渲染真 UI | `dsh-client-web`（packages/client/web）+ `apps/web`（Vite entry） |
| 客户端模块表 | 惰性 CJS 模块系统，实现 vendored Loader 的 `internal` 契约 | `dsh-client-modules/client`（packages/client/modules/src/client） |
| 渲染机制 | slot 渲染器、`SessionProvider`、uSES 适配 | `dsh-client-web-react`（packages/client/web-react） |
| 数据对象层 | ConnectionController → SessionManager → Session；会话列表、事件窗口、快照、notifier | `dsh-client-runtime`（packages/client/runtime） |
| 业务 UI 插件 | 每个功能一个浏览器包，只通过 `ctx.slots.register` 组合、`conversationEvents.register` 贡献会话节点 | packages/client/ui-* |
| 自动化出口 | Agent Client Protocol（stdio JSON-RPC NDJSON） | `dsh-acp`（packages/acp） |
| 编程出口 | JSON-RPC 协议 + 服务器 + TS client（spawn 子进程） | `dsh-sdk-*`（packages/sdk） |

### 1.2 关键机制词条

- **能力 seam**：`ctx.web`（搜索 + 抓取两项操作、一个服务）——Service Definition（dsh-web）+ Service Provider（web-search-exa 等）+ Consumer（dsh-tool-web）。docs/subsystems/web.zh.md:5。
- **`window.__DSH_BOOT__`**：宿主注入 `<head>` 第一个脚本的启动图（`WebBootGraph`），是"宿主组合决定"与"浏览器执行"的唯一 wire 边界。packages/client/modules/src/client/manifest.ts:63。
- **`internal` 契约**：vendored Cordis Loader 暴露的加载器钩子；浏览器里由 `ClientModuleSystem` 实现并挂在 `loader.internal` 上，Entry 的 `tree.import` 只通过它取模块。packages/client/modules/src/client/system.ts:1。
- **slot 系统**：`ctx.slots.register({name, children?, store?, inject?}, Component)` 是浏览器 UI 唯一的组合通道；slot 名镜像组合路径 `<domain>.<entry>.<hole>`；kind 分 `single|list|keyed|chain`。packages/client/ui-slots/src/index.ts:87。
- **keyed slot**：按条目的 `key` 分派——`ChatNodeSeat` 用 `renderSlot('conversation.chat.node', owner, { entryKey: node.kind })` 把业务节点分派给对应渲染器。packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx:48。
- **ConversationNodeDefinition**：一个业务领域贡献的"事件 → 节点"状态机（match/start/update/publication/buildViewNode），注册进 `conversationEvents`；这是**在浏览器端**做增量折叠的引擎（ConversationNodeAssembler），与 Host 端 session 日志正交。packages/client/runtime/src/client/contract/conversation.ts:171。
- **Typert Remote**：Host 业务方法上的 `@Remote`/`@RemoteScope` 装饰器 → 构建期生成 wire 描述符（严格 codec + schema）→ 运行时 Gateway 按 endpoint 分派；Client 端 `ctx.remote.<namespace>` 是"可追踪 Cordis 子服务"上的具体函数，无 Proxy。docs/api-gateway.zh.md:9。
- **lookup / context**：wire 上只有 id（`agentId`），Host 侧由 `ctx.typert.lookups`/`ctx.typert.contexts` 注册的 resolver 把 id 解析成 Host 对象或作用域 Context。packages/api/remotes/src/agent-lookup.ts:199。

### 1.3 数据流总览（一次对话回合）

```
用户输入 → ui-conversation 的 InputBar → Session.prompt() ──HTTP POST /api──▶ Host sessions.prompt
                                                                             │ agent loop 开始
  浏览器 ◀── WebSocket /api/events.mux ── session/event(assistant/chunk...) ◀─┘ (逐事件推送)
Session.handleMuxEnvelope() → appendLive() → ConversationNodeAssembler.append()
   → assistantDefinition.update() 折叠 chunk → 请求 'animation-frame' 发布
   → Notifier.markFrameDirty() → RAF 触发 flush() → ChatSnapshotBuilder.apply() 增量建快照
   → uSES getSnapshot 返回新引用 → ChatNodeSeat 重渲染该节点（增量，只动变化节点）
```

---

## 2. 模块与文件地图

### 2.1 apps/web —— 薄 Vite entry

| 文件 | 角色 |
|---|---|
| `apps/web/src/main.ts` | 10 行：找 `#root`，`new AppWebEntry(el).run()` |
| `apps/web/vite.config.ts` | 拒绝裸 Vite serve；workspace 包别名到 src；`process.versions.node` 等 define；vendor chunk 划分 |
| `apps/web/index.html` | 静态宿主页（`#root` 挂载点） |
| `apps/web/tests/*` | e2e / snapshot / perf / stress（三层 GUI 测试体系） |

### 2.2 packages/client/web —— 浏览器壳（shell）

| 文件 | 角色 |
|---|---|
| `src/boot.tsx` | `AppWebEntry`：两阶段启动内核（模块面 → 插件面） |
| `src/AppRoot.tsx` | 启动门：加载页 →（settled）→ 真 UI 一次切换 |
| `src/app-shell.ts` | app-shell 伪 entry：安装 slot 渲染器、提供 `appShell.renderApp` |
| `src/app.tsx` | `buildRenderApp`：整个布局挂在 `'root'` slot 上（唯一 ctx 级 renderSlot 调用） |
| `src/seed.ts` / `src/platform.ts` | 模块表静态种子 / 平台单例（PLATFORM_MODULES） |
| `src/loader-status.ts` | 启动状态投影（loading/failed/active）与信号 |

### 2.3 packages/client/modules —— 客户端模块系统（Node 半 + 浏览器半）

| 文件 | 角色 |
|---|---|
| `src/index.ts` | Node 半：`ClientModuleRegistry`（扫描、组合、bundle 路由、index tap） |
| `src/client/manifest.ts` | wire 类型 + `parseBootManifest` + `ClientModuleLoader` 契约 + `DshWindow` |
| `src/client/system.ts` | `ClientModuleSystem` 实现（惰性 CJS 表） |

### 2.4 packages/client/connection —— 连接层（传输 + RPC + 事件流）

| 文件 | 角色 |
|---|---|
| `src/index.ts` | Host 插件：`/api` 前缀路由 + 信任围栏 + 两条 WS 下行 + PRIVILEGED_METHODS 环回钉死 |
| `src/api-path.ts` | `/api`、`/api/events.mux`、`/api/events.host` 三个常量 |
| `src/api-request-trust.ts` | 浏览器信任围栏（DNS rebinding + 跨站防御） |
| `src/rpc-host.ts` | `HostConnectionService`：RPC 通道注册 + 共享 `/api` interceptor 分发 |
| `src/websocket-downlink.ts` | Host 侧 WebSocket 泵（只下行，客户端发消息即 1008 关闭） |
| `src/client/index.ts` | 浏览器插件：选 Fixture/真实 API，提供 `ctx.connection`（ConnectionHandle） |
| `src/client/connection.ts` | `ConnectionController`：双流泵 + 指数退避重连 + 严格握手 |
| `src/client/web-api-client.ts` | `WebApiClient`：unary 走 fetch，mux/host 走 WS async generator |
| `src/client/rpc.ts` | `createWebConnectionRpc`：POST `/api/<channel>/<endpoint>`，rpcId 关联 |
| `src/client/api.ts` | 契约再导出 + `resultOf` |

### 2.5 packages/client/runtime —— 数据对象层（零 React）

| 文件 | 角色 |
|---|---|
| `src/client/index.ts` | runtime 插件 `apply`：装配 SessionRuntime/WorkspaceRuntime，把 ConnectionController sinks 接到管理器 |
| `src/client/sessions/session.ts` | `Session`：事件窗口、open/resync、mux 帧分派、快照、uSES 入口 |
| `src/client/sessions/manager.ts` | `SessionManager`：实例簇 + 帧入口 + 会话列表 |
| `src/client/sessions/service.ts` | `SessionRuntime`：list 快照、Agent 作用域树、provide 通道 |
| `src/client/sessions/notifier.ts` | 微任务/RAF 批量通知原语 |
| `src/client/sessions/conversation-assembler.ts` | `ConversationNodeAssembler`：增量折叠引擎 |
| `src/client/sessions/projection-store.ts` | session 投影值存储（push 模型，higher-seq-wins） |
| `src/client/conversation/*` | Definition/View/事件注册表 |
| `src/client/contract/*` | 类型契约（conversation/session/sessions/store） |
| `src/client/slots.ts` | `SlotRegistry` 纯核（slot 注册/声明合并） |

### 2.6 packages/client/web-react + ui-slots —— 渲染机制

| 文件 | 角色 |
|---|---|
| `web-react/src/bind.ts` | 唯一的 hook 构造器：裸 observable → uSES selector hook |
| `web-react/src/session-provider.tsx` | `SessionProvider`/`SessionMaybeProvider`、`useProjection` 座 |
| `web-react/src/scoped-slots.tsx` | slot 渲染器实现（outlet、作用域解析、keyed 分派） |
| `ui-slots/src/index.ts` | `SlotMap` 声明合并表、`SlotKind`/`SlotScope`、`register` 类型 |
| `ui-slots/src/store.ts` | `defineStore`（zustand/immer）快照存储引擎 |

### 2.7 packages/api + packages/typert —— 网关

| 文件 | 角色 |
|---|---|
| `api/gateway/src/index.ts` | Host `TypertGatewayService`：endpoint 认领、invoke、SRC 回退 |
| `api/gateway/src/client/index.ts` | Client `ctx.remote`：$mount、namespace 服务、invoke 调用 |
| `api/remotes/src/agent-lookup.ts` | `createApiRemoteAgentResolver`：agent/session lookup 策略 |
| `api/remotes/src/client/index.ts` | 显式挂载被选业务包的 `/remote` 贡献 |
| `typert/protocol/src/index.ts` | `@Remote`/`@RemoteScope`/`TypertRemoteService`/`bindTypertRemote` |
| `typert/registry/src/service.ts` | `ctx.typert`：descriptor store、lookup/context store |
| `typert/generator/src/analyzer.ts` | TS Program 严格分析 → 编译器无关模型 |
| `typert/generator/src/emitter.ts` / `renderer.ts` | Host/Client 产物发射 |

### 2.8 packages/acp + packages/sdk —— 自动化与编程出口

| 文件 | 角色 |
|---|---|
| `acp/acp/src/index.ts` | ACP 服务器（AgentSideConnection over stdio） |
| `acp/acp/src/codec.ts` | ACP prompt ↔ 文本、turnEnd → stopReason 转换 |
| `sdk/protocol/src/transport.ts` | NDJSON JSON-RPC 2.0 传输 |
| `sdk/protocol/src/types.ts` | SDK 运行时协议 wire 类型 |
| `sdk/server/src/server.ts` | `HarnessSdkJsonRpcServer`（initialize/prompt/shutdown + 4 种通知） |
| `sdk/client/src/client.ts` / `api.ts` | `HarnessClient`（spawn 子进程）+ `DeepSeekHarness` 高层 API |

### 2.9 组合真相源

| 文件 | 角色 |
|---|---|
| `packages/bundle/web-app/cordis.patch.yml` | Web 表面的完整行清单（webserver/web-runtime/connection/modules/client-hmr/全部 ui-*） |
| `apps/cli/src/args.ts:66,162` | `dsh --profile web` 命令入口 |
| `scripts/dev-web.ts` | 开发期 client-plugin 的 tsdown watch（HMR 的构建侧） |

---

## 3. 关键类型与接口

### 3.1 启动图（wire 边界）

```ts
// packages/client/modules/src/client/manifest.ts:50
/** One composed client entry pushed by the host (a graph row). */
interface WebBootEntry {
  id: string            // Entry name == package name
  url: string           // Bundle endpoint, '/plugins/<id>/client.js?rev=<rev>'
  rev: string           // Bundle content hash (cache-busting consistency anchor)
  inject?: string[]     // Package-name dependency edges, informational
  immediately?: boolean // Stage-one prefetch mark
}

// packages/client/modules/src/client/manifest.ts:63
interface WebBootGraph {
  rev: string           // Consistency anchor over the whole graph
  entries: WebBootEntry[]
}

// packages/client/modules/src/client/manifest.ts:92 — 一次解析出两个视图
interface BootManifest {
  rev: string
  modules: BootModuleRow[]   // 模块表消费
  plugins: BootPluginRow[]   // entry 组合消费
}
```

解析器 `parseBootManifest` 对缺失/畸形图**大声抛错**（无有效 manifest 的页面无法启动）：`packages/client/modules/src/client/manifest.ts:108`。

### 3.2 模块表契约（vendored Loader 的 internal）

```ts
// packages/client/modules/src/client/manifest.ts:190
interface ClientModuleLoader {
  version: 'client'
  loadCache: Map<string, ClientModuleRecord>
  import(specifier: string, parentURL: string, attrs: Record<string, unknown>): Promise<unknown>
  registerStatic(id: string, module: unknown): void
  prefetch(id: string): Promise<void>
  invalidate(id: string): void   // HMR 失效钩子
}
```

惰性 CJS 模型：执行 bundle 只**注册** factory（`window.__ModuleLoader__.load({id, factory})`），所有副作用（含 CSS 注入）都在 factory 闭包内、于**物化**（materialize）时运行；`require` 的解析分支顺序：seed → static → 缓存记录 → 已注册 factory（递归物化）→ 图行（fetch+物化）→ 抛错。`packages/client/modules/src/client/system.ts:142`。

### 3.3 WebServer 路由

```ts
// packages/host/webserver/src/index.ts:24
type WebRouteKind = 'exact' | 'prefix'
interface WebRoute {
  kind: WebRouteKind
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

匹配顺序固定：exact 表 → 最长前缀 → 回退席位（唯一所有者）；`registerUpgrade` 管 WebSocket 升级；`tapIndex` 注册 index.html 转换（client-modules 用它注入 boot manifest）。`packages/host/webserver/src/index.ts:94,109,125,139,242`。

### 3.4 Connection（浏览器侧）

```ts
// packages/client/connection/src/client/index.ts:60
interface ConnectionHandle {
  readonly api: IApiClient
  readonly isLoopback: boolean
  readonly hostDescription: HostDescriptionSource
  readonly rpc: ClientConnectionRpc
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

// packages/client/connection/src/client/connection.ts:44
interface ConnectionSinks {
  onMuxEnvelope?: (envelope: RpcRequest<MuxFrame>) => void
  onHostEnvelope?: (envelope: RpcRequest<HostFrame>) => void
  onConnected?: (description: HostDescription) => void
  onStateChange?: (state: ConnectionState) => void
}
```

`ConnectionController` 每次"代"（generation）打开两条流：`api.events.mux` 与 `api.events.host`，严格就绪握手 = `host.describe` 一元 RPC + 双流 onOpen + 超时护栏，失败后指数退避重连（500ms 起、2 倍、上限 10s、加抖动）。`packages/client/connection/src/client/connection.ts:107`。

### 3.5 帧类型（wire 协议核心）

```ts
// packages/host/apiproxy/src/api/events.ts:69
export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | { type: 'approval/requested'; ... }
  | { type: 'approval/resolved'; ... }
  | { type: 'question/requested'; ... }
  | { type: 'question/resolved'; ... }
  | { type: 'session/queue'; sessionId: SessionId; items: QueuedInboxItem[] }
  | { type: 'session/jobs'; sessionId: SessionId; jobs: JobView[] }
  | { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: RpcError }

// packages/host/apiproxy/src/api/events.ts:127
export type HostFrame =
  | { type: 'host/session-added'; ... }
  | { type: 'host/session-removed'; sessionId: SessionId }
  | { type: 'host/session-status'; sessionId: SessionId; running: boolean }
  | { type: 'host/agent-error'; ... }
  | { type: 'host/workspace-changed'; ... }
  | { type: 'host/remote-event'; event: string; args: JsonValue[] }  // 白名单事件原样转发
  | { type: 'stream/error'; ... }
```

设计要点：**带状态的帧都是全量快照**（`session/queue`、`session/jobs`、`session/projection` 是 whole-value，last-wins），只有 `session/event` 是日志增量；`session/subscribed` 是每代流的基线水位。`packages/host/apiproxy/src/api/events.ts:76,98,107`。

### 3.6 SessionEvent（Host 会话日志）

`SessionEventMap` 是 merge-extensible 的追加式日志类型表：`turn/start|end`、`step/start|end`、`user/message`、`assistant/chunk`（原始 token 级流块，replay 保真）、`assistant/message`（聚合消息 + usage）、`tool/call|result` 等。`packages/core/session/src/types.ts:236`。`assistant/chunk` 载荷 `{ turn, step, chunk: StreamChunk }`（chunk 是 `block-start|text-delta|reasoning-delta|tool-call-delta|block-end|usage|finish` 判别联合）。`packages/core/session/src/types.ts:266`。

### 3.7 Session 快照与订阅（React 的数据入口）

```ts
// packages/client/runtime/src/client/sessions/session.ts:65 — 类声明
export class Session implements SessionFace {
  // uSES 直连
  subscribe(listener: () => void): () => void          // :447
  getSnapshot(): ConversationSnapshot                   // :455
  // 帧分派（manager 转发）
  handleMuxEnvelope(rpcId: RpcId, frame: MuxFrame)     // :467
  // 操作
  prompt(content, mode: 'queue' | 'steer')             // :190
  open() / loadOlder() / resync() / cancel() / rename()
}
```

快照是**缓存引用**：脏时在 flush 前重建，`getSnapshot` 在无监听时惰性重建（`ensureFresh`）。`packages/client/runtime/src/client/sessions/session.ts:731`（buildSnapshot 返回 `ConversationSnapshot`：`chat`/`nodes`/`pending`/`queue`/`running`/`composerPhase`…）。

### 3.8 ConversationNodeDefinition（浏览器端业务状态机）

```ts
// packages/client/runtime/src/client/contract/conversation.ts:171
interface ConversationNodeDefinition<State = unknown> {
  readonly kind: string
  readonly target?: string          // 唯一视图目标（如 'chat'）
  match(event: SessionEvent): ConversationMatchResult | null   // 只读当前事件
  start(context, match, reader): State
  update(context, match): State     // 按日志 seq 升序折叠
  publication?(match): ConversationPublication   // 'none' | 'animation-frame' | 'immediate'
  buildLocationData?(context, scope): ConversationLocationData | null
  buildViewNode?(context): ConversationViewNode | null
}
```

配套：`ConversationViewDefinition`（`target` + `create(): ConversationViewBuilder`）与增量 `ConversationViewBuilder`（`replace` 全量 / `apply` 只应用变化的节点）。`packages/client/runtime/src/client/contract/conversation.ts:236,260`。Context 键由 `conversationContextKey(kind, id)`（`kind.length:kind + id`）保证无碰撞。`packages/client/runtime/src/client/contract/conversation.ts:272`。

### 3.9 槽位系统

```ts
// packages/client/ui-slots/src/index.ts:87
type SlotKind = 'single' | 'list' | 'keyed' | 'chain'
type SlotScope = 'root' | 'session-maybe' | 'session'
```

组件 props 是四个 share 的交集：`PropsRuntime<K>`（框架座：`useSession`/`sessionId`/`useProjection`/`useSessions`/`useWorkspaces`）+ `PropsRenderSlots<S>`（声明的 children 键）+ `PropsStore<H>`（store 工厂）+ inject 面。`packages/client/runtime/src/client/index.ts:124`（SessionStandardProps 声明合并）。

### 3.10 Typert 协议面

```ts
// packages/typert/protocol/src/index.ts:89
interface TypertGatewayBinding<Service extends object = object> {
  readonly service: Service
  readonly serviceKey: string
  readonly namespace: string
}
// :168 Remote 装饰器；:204 RemoteScope(key, exportName?)
// :147 abstract class TypertRemoteService extends Service { readonly typertRemote: TypertGatewayBinding<this> }
// :126 markers = new WeakMap<object, Map<string, StoredRemoteMethodMarker>>()  ← 标准装饰器初始化器写入
```

装饰器**不启动 TS 分析**，只把方法名/调用模式记进模块私有 WeakMap；严格反射是 Typert compiler 的职责；SRC（源码启动）回退则从运行中函数的 `Function.prototype.toString` 解析参数名。`packages/api/gateway/src/index.ts:542`（methodParameterNames）。

### 3.11 InvocationDescriptor 与 Typert 运行时注册表面

```ts
// packages/typert/protocol/src/types.ts:139 — 参数/结果的边界 codec
export type TypertCodec =
  | { readonly mode: 'strict'; readonly typeSymbol: string; readonly schema: TypertSchema }
  | { readonly mode: 'src-json' }

// packages/typert/protocol/src/types.ts:173 — 一次导出的方法调用的载体无关描述
export interface InvocationDescriptor {
  readonly id: string
  readonly service: string        // Cordis service key
  readonly namespace: string
  readonly method: string
  readonly implementation?: string  // exportName 与实现方法名不同时
  readonly invocation: { kind: 'direct' } | { kind: 'context'; context: string; wire: string; codec: TypertCodec }
  readonly scope?: { context: string; wire: string }   // 消费方 Context 投影
  readonly parameters: readonly InvocationParameterDescriptor[]  // 见 :150：name/wire/source('json'|'lookup')/codec
  readonly cancellation?: { parameter: 'signal' }      // Host 末位 AbortSignal，不进 wire args
  readonly result: TypertCodec
}

// packages/typert/protocol/src/types.ts:214 — Client 显式选择的挂载单元
export interface TypertRemoteContribution {
  readonly package: string
  readonly descriptors: readonly InvocationDescriptor[]
}

// packages/typert/protocol/src/types.ts:262 — lookup 提供方（parameter/wire/hostTypeSymbol/wireTypeSymbol/resolve）
// packages/typert/protocol/src/types.ts:332 — TypertLocalRegistry：get/hasSeen/list/subscribe
// packages/typert/protocol/src/types.ts:480 — TypertRegistryContract：local/remotes/lookups/contexts 四张表
```

类型级关联用 `unique symbol` 字段的 branded 接口实现（`TypertLookup<Host, Wire>`，:14），`TypertLookupMap`/`TypertContextMap`/`TypertRemoteMap` 都是 merge-extensible 空接口（:34,:37,:40），业务包通过 `declare module` 合并注入具体 key。

### 3.12 Web 能力类型（ctx.web）

```ts
// packages/web/web/src/types.ts:15
export interface WebSearchRequest { readonly query: string; readonly maxResults?: number }
// packages/web/web/src/types.ts:34
export interface WebSearchResult { readonly content?: string; readonly sources: readonly WebSearchSource[]; readonly truncated: boolean }
// packages/web/web/src/types.ts:73
export interface WebFetchResult { readonly url: string; readonly statusCode: number; readonly body: WebFetchBody; readonly truncated: boolean }
// packages/web/web/src/types.ts:93 — CLOSED 判别联合，新增 kind 是协调变更而非插件扩展
export type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }
// packages/web/web/src/types.ts:101 / :113 — 提供方注册面
export interface WebSearchProvider { readonly id: string; available(): boolean; search(req, signal?): Promise<WebSearchResult> }
export interface WebFetchProvider { readonly id: string; available(): boolean; fetch(req, signal?): Promise<WebFetchResult> }
// packages/web/web/src/types.ts:129
export class WebError extends HarnessError {}   // code: string 开放联合（WEB_PROVIDER_* / WEB_FETCH_*）
```

`WebRuntime.search` 在执行时按固定规则解析提供方（配置 id → 唯一可用 → 多可用 `WEB_PROVIDER_AMBIGUOUS` → 无可用），并在返回时强制 `maxResults` 截断 + 置 `truncated`：`packages/web/web/src/index.ts:140,172`。消费方 `dsh-tool-web` 只拥有模型面（schema、prompt、上限、展示），`searchMaxResults` 默认 8、fetch 输出上限 200k 字符、超时预算 30s：`packages/web/tool-web/src/index.ts:42,80`。

### 3.13 SessionProvideChannel（标准 props 提供通道）

```ts
// packages/client/runtime/src/client/sessions/provide.ts:30
export class SessionProvideChannel {
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>  // :44 原子当前投影
  provide(descriptor: SessionProvideDescriptor): () => void             // :81 名册变更即重建
  publishCurrent(): void                                                 // :106 选择/名册变化发布
}
```

通道是"会话标准座"（`useSession`/`sessionId`/`useProjection`/`useSessions`）的唯一物化点：runtime 自身先注册 `hooks:['session']`（:52），各 UI 插件再 `sessions.provide({hooks, props, resolve})` 贡献自己的座；`BindingContext`/`SessionProvider` 消费的 `provideInfo` 就是这个通道的 `currentProvideInfo`。materialize 规则"fail-loud on undeclared/missing/duplicate"，注册失败回滚名册（:81）。

### 3.14 会话列表快照

```ts
// packages/client/runtime/src/client/sessions/manager.ts:43
export interface SessionListSnapshot {
  items: readonly SessionListEntry[]
  current: SessionId | undefined        // 对 items 校验过；会话离线时掩为 undefined
  state: 'idle' | 'loading' | 'error'   // 拉取活动轴
  phase: SessionListPhase               // 'pending' → 'ready' 单调（空数组≠不存在）
  error: RpcError | null
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>
  currentAddress: SubagentAddress | undefined
}
```

列表数据**不进 zustand**：manager 持有真值，`SessionRuntime.list` 是 `createSnapshotStore` 投影（service.ts:302），React 经 `useSessions`（bindSnapshotSelector）订阅；entry 身份按值缓存（`entryCache`，manager.ts:157）保证 wire 刷新不破坏 memo。

### 3.15 SDK 协议

```ts
// packages/sdk/protocol/src/types.ts:93
interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}
interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}
```

传输：NDJSON JSON-RPC 2.0（`{jsonrpc,id,method,params}` 一行一帧；带 id+method 是请求、仅 id 是响应、仅 method 是通知；畸形行忽略；handler 失败回 `-32603`）。`packages/sdk/protocol/src/transport.ts:62,201`。

---

## 4. 执行流程

### 4.1 启动链路：`dsh web` → 浏览器 → 真 UI

**Step 1：命令行与组合。** `dsh web` 即 `dsh --profile web`（apps/cli/src/args.ts:66），加载 `@deepseek-ai/dsh-web-app` bundle 的 patch 层（packages/bundle/web-app/cordis.patch.yml）。patch 声明：`webserver`（host/port 来自 `webStartup` 提供者，默认 127.0.0.1:3080，cordis.patch.yml:115）、`web-runtime`（解析 dist、打印 URL 行，:130）、`client-hmr`（:142）、`modules`（:151）、`connection`（:156）、`api-remotes`（:165）、`client-runtime`（:168）与全部 `ui-*` 行。命令行 `--host/--port/--trusted-host` 由 `web-startup` 解析并提供 `webStartup` 服务（packages/bundle/web-app/src/startup.ts:65）。

**Step 2：服务器与 dist。** `WebServer[Service.init]` 立即 `listen`（失败 = FAILED fiber），提供 `webServer.register/registerUpgrade/registerFallback/tapIndex`（packages/host/webserver/src/index.ts:148）。`web-runtime` 插件 resolve 出 dist 路径（`@deepseek-ai/dsh-web-frontend/dist/index.html`，packages/bundle/web-app/src/index.ts:116），mount `FrontendStatic` 认领回退席位（:139）：SPA 语义——遍历 403、未命中 200 回退 index.html、未知扩展 octet-stream、非 GET/HEAD 405（packages/host/frontend-static/src/index.ts:56）。`client-modules` Node 半注册 `/plugins` 前缀路由并 `tapIndex(injectBootManifest)`（packages/client/modules/src/index.ts:241）。

**Step 3：注入 boot manifest。** `injectBootManifest` 把 `window.__DSH_BOOT__ = {rev, entries}` 作为 `<head>` 第一个 `<script>` 注入，`<` 全部转义为 `\u003c` 防 script 逃逸（packages/client/modules/src/index.ts:168）。刷新页面时每次都重算，所以总是对"实时组合"启动（packages/client/modules/src/index.ts:57 注释）。

**Step 4：浏览器加载。** `apps/web` 的 Vite 产物（`apps/web/src/main.ts:10`）调用 `new AppWebEntry(el).run()`。Vite 配置把 `@deepseek-ai/dsh-client-web` 别名到 `packages/client/web/src/boot.tsx`（apps/web/vite.config.ts:142），并把 `process.versions.node` define 成 `"0.0.0"`、`process.execArgv` 为 `[]`，让 vendored Loader 的 Node 探测落空、走浏览器分支（apps/web/vite.config.ts:151）。

**Step 5：AppWebEntry.run() 两阶段。**
1. **模块面**：`parseBootManifest((globalThis as DshWindow).__DSH_BOOT__)`（packages/client/web/src/boot.tsx:98）→ `new ClientModuleSystem({modules, staticModules})`（:100）→ `registerStatic(APP_SHELL_ID, AppShell)`（:105）→ `registerStatic(MODULES_ID, ModulesClient)` 并挂 `__DSH_MODULES__` 交接槽（:111）→ `createRoot` 渲染 `AppRoot` 加载页（:114）。
2. **插件面**：`ctx.plugin(Loader)`（vendored Cordis Loader，:163）→ `loader.internal = this.modules`（**在任一 entry 存在前注入 internal 契约**，:168）→ 订阅 `internal/status` 投影 fiber 状态（:173）→ 等待 `immediately` 档预取（:183）→ 创建 entry：`[MODULES_ID, ...plugin rows, APP_SHELL_ID]` 并发 `loader.create({name})`（:189,:196）→ `loader.await()` + `assertEntriesActive()` 全量 sweep（:206,:216）。

**Step 6：settled 切换。** sweep 全部 ACTIVE 后 `settled.set(true)`；`AppRoot` 一次切换到 `renderApp()`（packages/client/web/src/AppRoot.tsx:35）；`renderApp` 由 app-shell entry 提供（packages/client/web/src/app-shell.ts:44），即 `ctx.slots.renderSlot('root', {})`（packages/client/web/src/app.tsx:41）——整个 UI 树从根 slot 长出来，ui-layout 的 AppFrame 注册在那里。

**Step 7：runtime 装配。** 浏览器 Cordis 容器里，`client-runtime` 插件 `apply`（packages/client/runtime/src/client/index.ts:188）：`new SlotRegistry(ctx)` → `ConversationEventRegistry`/`ConversationViewRegistry` → `new SessionRuntime(ctx, connection.api, ctx.remote, conversation)` → `ctx.typert.contexts.registerClient('agent', ...)` → `connection.start({onMuxEnvelope, onHostEnvelope, onConnected, onStateChange})` 把流接到管理器。**React 从不直接碰这些对象**——web-react 层负责绑定。

### 4.2 事件流推送：Host → 浏览器

**Host 侧生成。** API Proxy（`dsh-host-apiproxy`）提供 `EventsApi`：`events.mux` / `events.host` 两个 AsyncIterable（packages/host/apiproxy/src/api/events.ts:47）。`client-connection` Host 插件注册：
- `/api` 前缀路由，先过 `isTrustedApiRequest`（信任围栏），再 `bridge` 到共享 FetchHandler（packages/client/connection/src/index.ts:161）；
- `MUX_EVENTS_PATH`/`HOST_EVENTS_PATH` 两个 WebSocket upgrade 路由（packages/client/connection/src/index.ts:193），由 `WebSocketDownlinks` 把 `events.mux/host` 迭代器逐帧 `send`（`serverRequest` 包成 `{type:'server-request', rpcId, method, payload}`，packages/client/connection/src/websocket-downlink.ts:14,118）。客户端向下行流发消息会被 1008 关闭（"downlink only"，:109）——**上行一律走 HTTP，下行走 WS**。

**信任围栏。** `isTrustedApiRequest` 三道检查：Host 头必须是 loopback 或 trustedHosts 权威（DNS rebinding 防线）→ `sec-fetch-site` 非 cross-site → Origin 若存在必须同权威（packages/client/connection/src/api-request-trust.ts:96）。`PRIVILEGED_METHODS`（settings/credentials/agentPreset/llm.discoverModels 等）进一步用空信任列表钉死为环回（packages/client/connection/src/index.ts:89）。

**浏览器侧读取。** `WebApiClient.openMux/openHost` 打开 WS 并返回 async generator：`readWebSocket` 用 `serverRequestSchema` + `muxFrameSchema`/`hostFrameSchema` 逐帧校验，畸形帧丢弃并告警，帧入 inbox 队列，`for await` 消费（packages/client/connection/src/client/web-api-client.ts:34）。`ConnectionController.pumpStream` 把每个 envelope 喂给 sink，`stream/error` 视为断流（packages/client/connection/src/client/connection.ts:178）。

**分派。** runtime 的 `onMuxEnvelope` → `sessions.handleMuxEnvelope`（manager 先做列表级投影：`session/projection` 落 store、`session/jobs` last-wins、pending 状态跟踪、未实例化会话的应答帧缓冲；再转发给实例，packages/client/runtime/src/client/sessions/manager.ts:683）。`Session.handleMuxEnvelope` 是帧分派 switch：`session/event → acceptLiveEvent`、`session/queue → queueMirror.replace`、`session/subscribed → lastSeq 基线`、`approval/question requested/resolved → pending 生命周期`（packages/client/runtime/src/client/sessions/session.ts:467）。`onHostEnvelope` 处理会话列表：`host/session-added|removed|status|agent-error` 与 workspace 帧（manager.ts:795）。重连时：`onStateChange('reconnecting') → sessions.handleDisconnected()`（清代级状态），新代建立后 `onConnected → sessions.handleConnected()`（对已打开会话 resync：清窗口重 open，基线重放覆盖缝隙；session.ts:416）。

### 4.3 流式渲染：chunk → 增量快照 → 局部重渲染

1. **窗口维护**：`acceptLiveEvent` 用 seq 保序：open/repair 期间进 `liveBuffer`；`event.seq > tailSeq+1` 视为缝隙 → 缓冲 + `repairGap()` 重拉尾页拼接；重叠 seq 丢弃（packages/client/runtime/src/client/sessions/session.ts:684）。
2. **折叠**：`appendLive` → `conversation.append({event, view})`（session.ts:675）。`ConversationNodeAssembler.append` 只处理**当前事件**：先按事件类型更新 location 索引（`turn/start` 等边界立即发布），再 `matchInput` 让每个 Definition 的 `match()` 判定归属，命中则入脏集；`update()` 折叠状态；最后按 `publication` 请求发布节奏（`'none'|'animation-frame'|'immediate'` 取最大，conversation-assembler.ts:47,194）。
3. **节流发布**：`Session.scheduleConversation` 把 'immediate' → `notifier.markDirty()`（微任务批）、'animation-frame' → `notifier.markFrameDirty()`（RAF 批，每帧最多一次）——**流式 chunk 走 RAF 累积**，结构变化走微任务（session.ts:700；notifier.ts:37）。assistant 节点的 `publication` 明确：`assistant/chunk` 的 text/reasoning/tool-call delta → `'animation-frame'`，`usage|finish` → `'none'`（packages/client/ui-conversation/src/client/conversation-nodes/assistant.ts:278）。
4. **flush 物化**：`notifier.flush()` 先重建快照再通知监听器（uSES 要求 getSnapshot 引用稳定）；`ConversationNodeAssembler.flush()` 对脏 Context 调 `buildViewNode`，把 upsert 节点交给每个视图 builder 的 `apply()`（conversation-assembler.ts:263）。
5. **增量建快照**：`ChatSnapshotBuilder.apply` 只 upsert 变化的节点：结构变化（新增/移动/可见性）才重建 `order` 与 location 索引，内容变化只 `touch` 索引；返回新 `ChatSnapshot`（packages/client/ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts:404）。
6. **React 订阅**：`ChatNodeSeat`（memo 组件）`useSession(snapshot => snapshot.chat.nodes.get(nodeKey))`——**一个节点一个订阅，不观察兄弟节点**；uSES selector 相等性默认 Object.is，节点引用未变就不重渲染（packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx:19）。
7. **keyed 分派**：`renderSlot('conversation.chat.node', owner, { entryKey: routedNode.kind, hookContext: nodeKey, fallback })`——按节点的判别字段（kind）找到对应 keyed 渲染器（user/steering/context/assistant-step/command/compaction/turn-error/…），未注册 key 走 `JsonBlock` fallback（ChatNodeSeat.tsx:48；渲染器注册见 register-node-renderers.ts:17）。

### 4.4 API 网关：Remote 调用全链路

**生成期。** 根构建按 `build:lib:host → build:lib:client → build:web` 有序执行（docs/api-gateway.zh.md:97）。Host tsdown 阶段，Typert generator 以 Host aggregate 为唯一 `ts.Program` 种子，`WorkspaceAnalyzer` 严格分析 `@Remote` 签名（公开、非静态、非泛型、参数为具名必填简单标识符；可 JSON 类型生成 strict schema，复杂对象须有 `TypertLookupMap` 声明；packages/typert/generator/src/analyzer.ts:1）。每个贡献包把产物写进自己的 `lib/`：`typert.host.js|d.ts`（Host Loader）、`typert.remote-client.js|d.ts`（Client 挂载，含 runtime codec），`api-remotes` 是唯一拆 TypeScript face 的包（tsconfig.host.json / tsconfig.client.json）。

**Host 注册。** Loader 注册 `typert.host.js` → `ctx.typert`（`TypertRegistry`）：descriptor store 按 endpoint 唯一（重复注册抛错，`packages/typert/registry/src/service.ts:120`）。业务服务继承 `TypertRemoteService(ctx, 'goals')` 显式绑定 service key 与 namespace（packages/typert/protocol/src/index.ts:147）。

**Gateway 认领。** `TypertGatewayService` 构造时 `connection.rpc.intercept('/api', endpoint => this.claimsEndpoint(endpoint), dispatchRpc, {authority:'trusted-host'})`（packages/api/gateway/src/index.ts:104）。`claimsEndpoint` 只认领两段式 endpoint（`<namespace>/<method>`）且存在严格描述符或活跃 SRC marker（:114）。未认领的请求回退到 API Proxy。

**调用。** Client 侧 `ctx.remote.$mount(contribution)` 挂载贡献（packages/api/remotes/src/client/index.ts:105），每个 namespace 是注册为 `remote.<namespace>` 的可追踪 Cordis 子服务（packages/api/gateway/src/client/index.ts:294）；方法用 `Object.defineProperty` getter 装成具体函数（非 Proxy，:475）。调用：`connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)`（client/index.ts:406）→ `createWebConnectionRpc` POST JSON `{type:'client-request', rpcId, method, payload:{args}}` 并校验响应 envelope 的 rpcId 回显（packages/client/connection/src/client/rpc.ts:19）→ Host `rpcFetchHandler` 校验 content-type/JSON/envelope/method-endpoint 一致性（rpc-host.ts:144）→ Gateway `dispatchRpc`：`assertExactArguments`（字段集合与描述符完全一致，:586）→ codec 校验 wire 值 → lookup/context 解析（`resolveParameter`/`resolveReceiverContext`）→ `Reflect.apply` 调用实时服务 → 返回值经 result codec 校验（:145）。

**鉴权与身份。** lookup 按 key 配置：`api-remotes` 的 `createApiRemoteAgentResolver` 提供 `agent`/`session` 标准语义——live Agent 复用、普通冷会话每身份一次恢复（`resumes` Map 去重）、subagent routing 拥有的 identity 拒绝（`ApiRemoteSubagentSessionOwnership` → 既有 `agent-busy` 错误原样返回，不折叠为 internal），并 `ctx.typert.lookups.configure('agent'|'session')` + `contexts.configureHost('agent')`（packages/api/remotes/src/agent-lookup.ts:121,199）。HTTP 层鉴权即 4.2 的信任围栏（不是认证，是 DNS-rebinding/跨站防线）。

**SRC 回退。** 源码启动（`node --import tsx/esm`）不跑 Typert 编译插件：Gateway 从运行中函数 `toString` 解析参数名构造弱描述符（无 schema，`src-json` codec，:237）；Client 端拒绝挂载无严格 codec 的 SRC 描述符（packages/api/gateway/src/client/index.ts:549）——**Client 的约定永远来自最近一次生成的 lib 产物**。

### 4.5 HMR：client-plugin 热更新

完整链路 = **构建侧** + **注册表侧** + **浏览器侧**：

1. `pnpm run dev:web` 跑 `scripts/dev-web.ts`：按声明发现所有 `dsh.client`(platform web) 包，用 tsdown JS API 起 watch 构建，源码变化重写各包的 `lib/client.js`（scripts/dev-web.ts:36,54）。
2. `client-hmr` Node 半对图中每个 bundle 做 stat 轮询（默认 500ms；网络挂载无 inotify 事件所以选轮询），变化时调 `clientModules.rebuilt(id)`（重哈希、rev 变才重组图并通知），再经 `/plugins/events` SSE 广播 `{type:'rebuilt', id, rev}` 帧（packages/client/hmr/src/index.ts:57,99,148）。
3. 浏览器半（它自己也是图里的一行 entry）用 `EventSource('/plugins/events')` 订阅；rebuilt 帧触发 `reload(id)`：`modules.invalidate(id)`（删旧 factory+记录）→ `prefetch(id)`（加载并注册新 factory）→ registry-first teardown（先 `registry.delete` 再 drain 旧 fiber，避开 vendored Loader 的 self-dispose 陷阱）→ 移除旧 `<style data-plugin>` 标签 → `entry.refresh()` 重新 import/apply（惰性 CJS 保证执行纯注册、副作用在物化时发生，所以热替换安全）（packages/client/hmr/src/client/index.ts:104）。下游依赖靠 vendored fiber 的 provider-uid 级联自动重启，零 HMR 簿记（:11 注释）。失败策略：**不回滚**，下次 rebuilt 帧重试。

### 4.6 ACP：自动化出口

`dsh-acp` 是"仅自动化"的 Agent Client Protocol 服务器，跑在 stdio 的 NDJSON 上（`AgentSideConnection(makeAgent, stream)`，packages/acp/acp/src/index.ts:349）。要点：
- `newSession`：`agents.create({sessionId: randomUUID(), meta:{cwd}, agentOptions})` 新建 Agent（:251）。
- `prompt`：文本转 user message → `agent.followup(message)`，用 `whenIdle()` 判定回合结束（`turn/end` 先记录 `endReason`，whole-agent idle 才 settle；max-tokens 映射为 `end_turn`）（:277）。
- **只发已提交的 assistant 文本**：订阅 `session/event`，`assistant/message` 的 text block 逐个发 `agent_message_chunk`；原始 chunk、reasoning、工具、plan 都不上自动化线（:152,155）。
- 权限：`approval/request` waterfall 桥接成 `requestPermission`（仅 allow-once/reject-once 两个选项，机器策略通道，:215）。
- 关闭：`conn.closed → quiesce`——取消所有 agent、先 child-first 排干 continuable 子代理再 dispose 顶层（:355）。

### 4.7 SDK：JSON-RPC 编程出口

`HarnessSdkJsonRpcServer` 在一个已启动的 harness Context 上订阅 `session/event`、`agent/status`、`session/created`、`subagent/end` 并转成 4 种通知（packages/sdk/server/src/server.ts:71）；`initialize` 配置 provider/model/maxTokens（未注册 deepseek-official 时动态挂 adapter，:111）；`session/prompt` 按 sessionId 惰性建 agent+session 后 `followup`（:203）；`shutdown` 排干并 dispose。TS client：`HarnessClient` `spawn(command, args)` 起子进程（packages/sdk/client/src/client.ts:206），`DeepSeekHarness` 高层 API 提供 `session()`/`run()`/`close()`（`await using` 支持，packages/sdk/client/src/api.ts:22），会话句柄 `HarnessSession.run` 发送 prompt 并在 agent 下次 idle 时 settle（api.ts:88）。

### 4.8 web 能力执行流（搜索/抓取）

`web_search`/`web_fetch` 工具（Consumer 侧）调用 `ctx.web.search/fetch`（Service Definition 侧）：
1. `dsh-tool-web` 的 `apply` 按配置注册工具（schema 只有 `query` / `url` 两个模型面参数），并附 `timeoutMs` 交给 tool-timeout 策略执行（packages/web/tool-web/src/index.ts:80）。
2. `WebRuntime.search` 执行时解析提供方（选择语义见 3.12；`available()` 是廉价本地检查，禁止网络调用，docs/subsystems/web.zh.md:122），转发 `AbortSignal`，返回前 `capSources` 截断到 `maxResults`（packages/web/web/src/index.ts:140）。
3. 提供方（exa/perplexity/deepseek 搜索、http 抓取）各自把外部 API 归一化到 `WebSearchResult`/`WebFetchResult`；`WebFetchBody` 是 CLOSED 联合，Consumer `switch` 后以 `assertNever` 收尾。抓取的非 2xx 是结果不是错误（`statusCode` 属于被抓资源状态，docs/subsystems/web.zh.md:84）。
4. 模型拿到的工具结果在会话日志里作为 `tool/result` 事件，浏览器侧 tool 节点渲染（`ToolEventView` 信封注解）展示。

### 4.9 会话投影推送链路（元数据成品值）

Host 端 `SessionProjectionRegistry` 订阅一次 `session/event`，把每个已提交事件折叠进各领域的 `ProjectionDefinition`（`init/apply/view/stateVersion` 纯同步单元，docs/subsystems/session-projection.zh.md:22）；值变更时载体（dsh-host-apiproxy）以 `session/projection` 帧推送（events.ts:107）。浏览器侧：
1. `SessionManager.handleMuxEnvelope` 拦截 `session/projection`，落进**驻留的** `ProjectionValueStore`（`higher-seq-wins`；未实例化的会话也能收，列表行的 `title` 键因此可用）：`packages/client/runtime/src/client/sessions/manager.ts:696`。
2. 历史尾页的 `projections` 块做冷启动种子（`installWindow` → `this.projections.seed(projections)`，session.ts:660）。
3. 渲染侧 `useProjection(key)` 框架座：`projectionHook` 从 provideInfo 解析 per-session 的 `faceOf(key)` observable 并绑定 selector hook（packages/client/web-react/src/session-provider.tsx:96）。`session/subscribed` 帧到达时按 `lastSeq` `truncate`（重连后丢弃越过基线的陈旧值，manager.ts:714）。

### 4.10 远程事件转发（Host cordis 事件 → 浏览器 `ctx.remote.$on`）

Host 白名单（`API_REMOTE_FORWARDED_EVENTS`，满足"无 Scope 绑定 + 返回 void"的 `TypertForwardableEvent` 形状门，packages/api/remotes/src/index.ts:41）内的事件以 `host/remote-event {event, args}` 帧转发。浏览器 runtime 是 host 帧 sink 的拥有者：`frame.type === 'host/remote-event' → ctx.remote.$dispatch(frame.event, frame.args)`（packages/client/runtime/src/client/index.ts:216）；`$dispatch` 按注册顺序隔离派发（packages/api/gateway/src/client/index.ts:135），订阅方用 `ctx.remote.$on(event, listener)`（:110）。

### 4.11 provide 通道与 SessionProvider 绑定（会话级 props 如何到达组件）

`SessionRuntime` 为每个会话按需 mint 一个 Agent 作用域 Context（`mintScope` 模式：无操作插件 Fiber + `ctx.extend` scope tag；session id === agent id，service.ts:1 注释）；`Session.bindScope(actx)` 单向绑定（session.ts:172）。`SessionProvider`（React 侧）订阅 `host.sessions.provideInfo`（SessionRuntime.currentProvideInfo）→ 得到 `SessionMaybeProvideInfo` → `key={sessionId}` 强制会话切换重挂载子树（web-react/src/session-provider.tsx:150）；`useSession`/`useProjection` 等座由通道物化进 `BindingContext`。列表订阅触发 `followCurrent`（staging：跟随 `list.current` 的开窗信号）与 `provideChannel.publishCurrent()`（service.ts:316）。

---

## 5. 设计模式与权衡

### 5.1 为什么前端也用插件架构（而不是一个大 React 应用）

**动机**：DSH 本体就是"一切皆插件"（vendored Cordis），agent 的能力集由 cordis.yml 组合决定。如果 GUI 是单体 React 应用，那么：(a) UI 能力与宿主能力无法同构对齐——一个工具包既要贡献 `ctx.web` 的工具 schema 又要贡献它的渲染卡片，拆成 host 插件 + client 插件两个面、由同一组合文件声明，才能保证"宿主有、浏览器也有"；(b) HMR 无法做到"换一个 UI 插件不动其它"。于是 browser 侧干脆**跑一个与 Host 同构的 Cordis 容器**：同一份 `dsh.client` 声明、同一个 Loader、同样的 fiber/inject 语义，只是模块来源从 node_modules 换成惰性 CJS 表。代价是三层职责分离的纪律（数据对象层零 React、渲染机制 shell-only、业务组件纯 props）被写成硬性规则（packages/client/AGENTS.md）。

**权衡**：获得"组合即配置、热插拔、与 Host 对称"；付出"浏览器包体积与加载复杂度、slot 系统的类型体操（declare merging）、两套代码面（Node/browser）需要严格 export 纪律（bundle purity gate：插件间禁止 value import）"。

### 5.2 为什么窗口注入 `window.__DSH_BOOT__` 而不是 API 拉取

**动机**：启动图必须在**任何代码运行前**可用——壳（shell）要能独立于"插件系统本身是否可用"而工作（shell 自足原则：插件全挂也要能显示加载失败页）。如果靠 fetch 拉 manifest，会引入"先有鸡还是先有蛋"：拉取代码自身就是 bundle。注入 `<head>` 第一个 script 使 manifest 成为 HTML 的一部分，语义上是"页面配置"，且 `rev` 随内容哈希变化天然缓存失效。`<` 转义防 script 逃逸，安全地让插件可控字符串进不了代码区（packages/client/modules/src/index.ts:168）。

**权衡**：每次刷新都重算图（成本可忽略）；manifest 与 bundle 是两个请求（图先到、bundle 惰性拉），但 `immediately` 档预取把关键基础设施行提前到 entry 创建前（boot.tsx:151）；浏览器无法在无 manifest 时启动（刻意大声失败）。

### 5.3 为什么事件用"WS 下行 + HTTP 上行"非对称传输

**动机**：(a) 事件流是 Host → 浏览器单向、高频、可丢失重连恢复的；WS 全双工能力用不上；(b) 所有上行（RPC）需要请求关联、取消（AbortSignal）、统一的信任围栏与 envelope 校验——这些在 HTTP 上更自然（rpcId 回显校验、`signal` 透传 fetch）；(c) WS 下行是"服务器到浏览器推送"，天然只有一端说话，协议更简单（客户端发消息直接 1008 关闭）。文档称连接层拥有传输/RPC id/envelope/取消，Gateway 只拥有 Remote 数据协议（docs/api-gateway.zh.md:123）——未来换 carrier（如 SSE）不影响业务层。

**权衡**：两条 WS + 一条 HTTP 复用同一 `/api` 前缀与信任围栏；重连语义复杂（generation 概念、subscribed 基线、liveBuffer 缝隙修补、pending 帧重放）——这是全系统状态管理最重的一块。

### 5.4 为什么"模型可见 ⟺ 已记录"（日志是全量真相）

`assistant/chunk` 是**原始 token 级增量**事件（session/types.ts:266），UI 显示的全部内容都可以从日志重建（重放模式 snapshot 测试就是基于此）。tool 的渲染意图（`ToolEventView`）是**信封级注解**，不持久化、可每次重算——session 日志只存事件，UI 表现是派生值。这带来"重放确定性"与"日志即测试夹具"两大红利，代价是 event 类型膨胀与折叠逻辑必须可重放（客户端 ConversationNode 的 update 是纯函数、按 seq 升序、`match` 只读当前事件）。

### 5.5 为什么 Typert 用"构建期代码生成 + 运行时反射"双轨

**动机**：严格模式（生成）给两端完整类型安全：Host 签名 → wire schema → Client 类型链（declaration map 让编辑器从 `ctx.remote.goals.create` 跳到 Host 实现）；运行时反射（SRC）则让 `dsh` 源码启动（tsx ESM）不必跑编译插件就能开发调试。两条轨道共享 `ctx.typert` 注册表与 Gateway 分发，差异只在描述符强度：严格描述符有 schema 与类型 symbol 校验，SRC 只做 JSON-safe 检查（docs/api-gateway.zh.md:131）。

**权衡**：生成流水线复杂（Host/Client 两个 ts.Program、`api-remotes` 拆 face、`DSH_BUILD_FACE` 驱动双 tsdown）；"约定改变必须重跑有序构建"是开发者心智负担；换来的是**零运行时 Proxy、无动态生成**的朴素可审计调用路径（Client 端方法就是普通函数，错误栈可读）。

### 5.6 其它值得教的权衡

- **全量快照帧 vs 增量帧**：`session/queue`、`session/jobs`、`session/projection` 都推全量（last-wins、重连自愈、多标签页收敛），只有日志走增量——"每次状态转移足够廉价，每个被供给的值自描述"（docs/subsystems/session-projection.zh.md:57）。
- **客户端折叠 vs 服务端投影**：会话内容（大、高频、可重放）由浏览器端 ConversationNode 折叠；会话元数据（标题、统计等小、低频值）由 Host 端投影（`sessionProjections`）折叠成成品值推送——切分依据是"谁的计算便宜/谁需要重放"。
- **惰性 CJS 模块表 vs ESM**：浏览器 bundle 以 CJS factory 形式注册，副作用推迟到物化——这是 HMR 原子热替换的基石（换 bundle 前旧 fiber 仍在服务）。
- **命名路由 + 单一回退席位**：WebServer 不知道任何 harness 概念，路由冲突即组合错误（重复注册抛异常），回退席位只有一个所有者——职责边界清晰、组合可预期。

### 5.7 网关与连接层的责任切分（可替换性设计）

`Connection` 拥有**传输**（HTTP 桥/WS/SSE、rpcId 关联、响应 envelope、请求取消、信任围栏），Gateway 只拥有 **Remote 数据协议与业务分发**（descriptor 解析、lookup/context 解析、schema 校验、调用实时服务）。两者的接缝是 `ConnectionRpcHandler(endpoint, payload, signal) → RpcResult` 这一薄签名（rpc-host.ts:144、gateway/src/index.ts:104 的 `intercept`）。收益：换 carrier（例如将来用 SSE 或 WebTransport 替 WS）不动任何 Remote 描述符与 Client 编程接口（docs/api-gateway.zh.md:123）；未认领的 endpoint 静默回退到 API Proxy，新旧协议同前缀共存（gateway/src/index.ts:79）。代价：`/api` 前缀上存在两条分发路径（Typert interceptor 与 API Proxy fallback），端点认领必须精确（两段式 + 严格描述符或 SRC marker，:114），否则会串线。

### 5.8 为什么会话内容在浏览器折叠、元数据在 Host 投影

- **会话内容**（user/assistant/tool 事件）量大、高频、需逐 token 保真——客户端折叠（ConversationNode）把"日志窗口"变成"渲染快照"，且折叠是**纯增量**（append 只处理当前事件、update 按 seq 单调、发布按 cadence 节流），重放（snapshot 测试、断线重连、历史翻页 prepend）与实况共用同一引擎。
- **会话元数据**（标题、统计、计划、goal 等）是小而低频的"成品值"——Host 投影（`sessionProjections`）在宿主侧折叠一次，浏览器只做 `higher-seq-wins` 的存储与订阅，**客户端零领域折叠逻辑**（docs/subsystems/session-projection.zh.md:5）；新领域加投影只需 Host 侧注册 unit + wire 一个 `session/projection` 帧类型，UI 用 `useProjection(key)` 直接读。
- 切分判据：**谁的计算更便宜 + 谁需要重放保真**。日志（model-visible ⟺ logged）永远只存事件，投影值/渲染意图都是派生值、可从日志重算。

### 5.9 可观测性与失败哲学

- **启动大声失败**：boot manifest 缺失/畸形即抛；entry 导入失败/非 ACTIVE/PENDING 在 sweep 里列出"谁/什么/哪个服务"（boot.tsx:216）；客户端模块表对未知 specifier 抛"运行时镜像的 bundle purity gate"（system.ts:151）。
- **订阅者隔离**：notifier flush、projection notify、`$dispatch`、HMR 广播全部对监听器异常做 containment——一个抛错的订阅者不能饿死后续订阅者（modules/src/index.ts:281、provide.ts:110、gateway/client/index.ts:135）。
- **失败不回滚（HMR）**：import 失败留 fiberless、apply 失败留 FAILED 状态，下次 rebuilt 帧从零重试——开发通道的一致性由"下次通知"收敛（hmr/client/index.ts:60）。
- **拒绝静默降级**：严格 endpoint 被撤回后不降级到 SRC 推断（docs/api-gateway.zh.md:129）；`WEB_PROVIDER_AMBIGUOUS` 宁抛不选最先注册者（web/web/src/index.ts:191）。

---

## 6. 面试要点

### 6.1 概念题

1. **`dsh web` 的完整启动链路**（从命令到 UI）：profile 组合 → webserver listen → client-modules 扫描并注入 `__DSH_BOOT__` → 浏览器 AppWebEntry 两阶段（模块面 → 插件面）→ vendored Loader + internal 契约 → entry 创建与 sweep → settled 后从 `'root'` slot 渲染整棵树。
2. **为什么 boot manifest 要注入窗口**：壳自足、先于一切 bundle 可用、rev 哈希缓存失效、`<` 转义防逃逸。
3. **事件如何从 Host 到 React**：session 日志事件 → mux WS 帧（server-request envelope）→ ConnectionController 泵 → SessionManager 分派 → Session.handleMuxEnvelope → 折叠（ConversationNodeAssembler + Definition）→ notifier（微任务/RAF）→ 快照缓存 → uSES → ChatNodeSeat 局部重渲染。
4. **流式 chunk 为什么走 RAF 而不是每帧重渲染**：`publication: 'animation-frame'` + `markFrameDirty`，每帧最多一次累积发布，uSES 快照引用稳定保证 memo 生效。
5. **slot 系统与"四 share props"**：组合即 `ctx.slots.register`；children 声明即渲染授权；组件不碰 ctx，数据只走框架座/owner props/store/inject。
6. **ConversationNodeDefinition 是什么**：浏览器端"事件 → 节点"增量状态机（match/start/update/publication/buildViewNode），注册进 `conversationEvents`；`conversation.chat.node` 是 keyed slot，按节点 kind 分派渲染器。
7. **Typert RPC 与普通 RPC 框架的区别**：无 Proxy、无运行时 schema 推导；构建期 TS Program 分析生成严格描述符；运行时 Gateway 按 endpoint 解析 lookup/context 后调用实时 Cordis 服务；SRC 回退支持源码开发。
8. **lookup vs context**：lookup 把 wire id 解析成 Host 对象参数（如 `agentId` → `Agent`）；context 把 id 解析成作用域 Context 再取服务调用（`@RemoteScope`）。两者都按 key 配置，`api-remotes` 拥有 `agent`/`session` 标准策略（live 复用、冷会话恢复去重、subagent ownership 拒绝）。
9. **信任模型**：不是认证而是 DNS-rebinding/跨站防线（Host 头 + sec-fetch-site + Origin）；特权方法钉死环回；`--trusted-host` 显式授权 LAN 暴露。
10. **ACP 与 SDK 的定位差异**：ACP = 面向自动化 agent 的交互协议（会话、prompt、逐段文本、一键权限）；SDK = 面向编程的 JSON-RPC（初始化、提示、事件通知、子代理生命周期）。两者都"新建并拥有 Agent"、都只发已提交内容。

### 6.2 深度题

1. 重连时如何保证会话窗口不错乱？——generation + subscribed 基线 + liveBuffer + repairGap 重拉 + 事件去重按 seq。
2. 为什么 `session/queue`/`session/jobs` 用全量快照而会话内容用增量日志？
3. HMR 为什么用轮询而不是 fs.watch？为什么"invalidate → prefetch → registry-first teardown → refresh"顺序不能乱？
4. 客户端折叠与 Host 投影的边界怎么划（什么数据进日志、什么只做信封注解）？
5. 为什么 Client Remote 拒绝 SRC 描述符、约定永远来自生成产物？
6. `assertExactArguments` 的"参数集合必须与描述符完全一致"如何保证向前兼容（新参数必须重新生成）？
7. `session/projection` 帧与历史尾页 `projections` 块如何用 `higher-seq-wins` 收敛（陈旧基线不能覆盖新推送帧）？
8. 会话实例为何"驻留"（resident）而不随导航销毁？——未选中会话继续消费 mux 帧、pending 交互可应答、`pendingBuffers`/`projectionStores` 与实例生命周期解耦（manager.ts:108,125,751）。

### 6.3 易错点

- `dsh web` 不是独立 Vite 应用（vite.config 直接拒绝 serve），必须有 Host 注入 manifest。
- 浏览器 Cordis 里插件间禁止 value import（bundle purity）；跨插件协作走 slot/服务。
- entry 创建顺序无语义，激活顺序由 fiber inject 等待决定；`dsh.client.inject` 边是信息性的，不是顺序控制。
- `stream/error` 帧在 Controller 收敛，业务层看不到。
- HMR 行只存在于开发图；生产图没有 HMR。

---

## 7. 存疑/待确认

1. **`session/event` 的 `view`（ToolEventView）生成时机**：文档说"注册于发射时、从不持久化"，但未深入 `dsh-tools/presentation` 的 presenter 注册与回放路径（本次只确认了 envelope 结构 `packages/host/apiproxy/src/api/events.ts:32`）。
2. **API Proxy（dsh-host-apiproxy）的内部**：本次只读了它的 api/ 契约层（events.ts、rpc 相关），未细读 `api-proxy.ts` 与各业务域 handler（sessions/history 尾页、`session/subscribed.lastSeq` 的 Host 侧发射点、`session/projection` 帧的推送端）。`packages/host/apiproxy/src/api-proxy.ts` 与 `src/fetch/` 待续。
3. **web-react `scoped-slots.tsx`（909 行）**：只看了入口契约与 `ChatNodeSeat` 的用法，渲染器的完整实现（outlet 缓存、作用域解析、`hookContext` 传递、keyed 分派内部）未逐行核对。
4. **ui-slots `store.ts`（defineStore/immer 快照引擎）**：确认了存在与 `createSnapshotStore` 用法（service.ts:284），未细读其实现。
5. **vendored Cordis Loader**（vendor/ 目录）的 `tree.import`/`internal` 契约细节只通过注释与 `loader.internal` 赋值点（boot.tsx:168）间接确认，未读 vendor 源码；AGENTS.md 提到的 `vendor/cordis/src/fiber.ts _refresh` 级联机制依赖注释转述。
6. **`typert.generator` 的 `emitter.ts`/`renderer.ts`** 只读了 `index.ts` 导出与 analyzer 头部；Host/Client 两个产物的具体发射格式（`typert.remote-client.js` 的 contribution 形状）由 Client 挂载代码（gateway/client/index.ts:174 mountContribution）反推，未直接读生成样例。
7. **Electron 路径**：webserver 文档提到 Electron 走 `file://` + IPC 桥（docs/subsystems/web-server.zh.md:5），本次未在仓库中找到 Electron 宿主代码（可能在 packages/host 之外的桌面工程里，未确认）。
8. **`apps/web/tests/produced-files.overlay.yml` 等 overlay 测试机制**与三层 GUI 测试体系（docs/testing.md + AGENTS.md 提及）未展开，若博客涉及测试可另起一篇。
9. **`session/subscribed` 帧的 `lastSeq` 与 history 尾页 `projections` 块的 Host 发射顺序**：从客户端 `installWindow` 的缝隙检测逻辑（session.ts:627）与 `session/subscribed` 语义注释（events.ts:71）推断为先 subscribed 后快照，未在 Host 端源码逐行验证。

---

## 附：本次核实过的关键源码清单（供博客引用）

- 启动：`apps/web/src/main.ts:10`、`apps/web/vite.config.ts:7,142,151`、`packages/client/web/src/boot.tsx:97,161,216`
- 模块系统：`packages/client/modules/src/client/manifest.ts:50,108,190`、`src/client/system.ts:77,113,142,158`
- 注册表与注入：`packages/client/modules/src/index.ts:168,218,241,421`
- 服务器：`packages/host/webserver/src/index.ts:94,148,242`、`packages/host/frontend-static/src/index.ts:56,93`
- 组合：`packages/bundle/web-app/cordis.patch.yml:115,130,142,151,156`、`packages/bundle/web-app/src/index.ts:116,135`
- 连接：`packages/client/connection/src/index.ts:89,130,161,193`、`src/api-request-trust.ts:96`、`src/websocket-downlink.ts:14,99`、`src/client/connection.ts:61,107,178`、`src/client/web-api-client.ts:34`、`src/client/rpc.ts:19`
- 运行时：`packages/client/runtime/src/client/index.ts:188`、`src/client/sessions/session.ts:190,467,614,684,731`、`src/client/sessions/manager.ts:683,795`、`src/client/sessions/notifier.ts:37`、`src/client/sessions/conversation-assembler.ts:194,263`
- 会话节点：`packages/client/runtime/src/client/contract/conversation.ts:171,236,260`、`packages/client/ui-conversation/src/client/conversation-nodes/assistant.ts:244,278`、`src/client/conversation-nodes/chat-snapshot-builder.ts:404,449`、`src/client/chat/ChatNodeSeat.tsx:48`、`src/client/chat/register-node-renderers.ts:17`
- 渲染绑定：`packages/client/web-react/src/bind.ts:18`、`src/session-provider.tsx:150`
- 网关：`packages/api/gateway/src/index.ts:104,145,237,586`、`src/client/index.ts:294,406,549`、`packages/typert/protocol/src/index.ts:126,147,168`、`packages/typert/registry/src/service.ts:120,196`、`packages/api/remotes/src/agent-lookup.ts:121,199`、`src/client/index.ts:105`
- 帧与日志：`packages/host/apiproxy/src/api/events.ts:47,69,127`、`packages/core/session/src/types.ts:236,266`
- HMR：`packages/client/hmr/src/index.ts:57,99,148`、`src/client/index.ts:104`、`scripts/dev-web.ts:36,54`
- ACP：`packages/acp/acp/src/index.ts:155,215,251,277,349`
- SDK：`packages/sdk/protocol/src/transport.ts:62,201`、`packages/sdk/protocol/src/types.ts:93`、`packages/sdk/server/src/server.ts:71,111,190`、`packages/sdk/client/src/api.ts:22`
