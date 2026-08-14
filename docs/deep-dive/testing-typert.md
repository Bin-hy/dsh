# 测试体系与 Typert 产物：Web 测试的 overlay 机制

> 消化 backlog A19。本篇拆三个此前存疑的点：apps/web 的 overlay 测试机制、`tools/execute` 包装器的真实全家桶（诚实答案：没有 retry/metrics）、Typert 发射器的产物形状。

## 1. Web 三层测试体系

`apps/web/tests/` 约 100 个文件，分四类（`vitest.web.config.ts` 的 include 只跑前两类）：

| 后缀 | 什么 | 特点 |
|---|---|---|
| `*.e2e.ts` | 真实宿主入口 + 回放式 keyless e2e | Linux PR CI 固定 `DSH_SNAPSHOT=replay` 与提交的金样比对；真实模型用例无 `DEEPSEEK_API_KEY` 自动跳过 |
| `*.snapshot.ts` | 构建后客户端交互快照 | 浏览器启动 + 真实模型轮次慢，**所有文件共享一个浏览器串行跑**（testTimeout 180s） |
| `*.perf.ts` | 性能场景 | 如 `complex-history.perf.ts` |
| `fixture/`、`support/` | 夹具与支撑 | `scaffold.ts` 是场景脚手架 |

## 2. overlay 机制：给测试打补丁的 cordis patch

`*.overlay.yml` 是 Web 测试体系最有意思的发明。看 `produced-files.overlay.yml` 的原文：

```yaml
# The summary test asserts the native-folder action without launching it. Pin
# the capability so headless Linux CI and desktop developer hosts expose the
# same UI branch; platform opener behavior belongs to the Host unit tests.
- id: api-gateway
  config:
    nativeOpen: true
```

机制：**每个测试可以带一个同名的 cordis patch overlay，在启动树时叠加**。它解决的问题是平台差异——headless CI 没有原生文件打开器，桌面宿主有；测试要断言的是 UI 分支，不是平台行为。overlay 把能力"钉"到同一分支，让两种环境跑同一断言；而真正的平台行为（opener）归宿主单元测试管。

这是"组合平面可 patch"（第 03 章 architecture）在测试层的直接运用：**测试 = 另一个 patch 层**，与用户 patch、bundle patch 走同一条组装路径。

## 3. `tools/execute` 包装器的诚实答案

研究笔记 02 曾存疑："文档提及 retry/metrics 包装器但仓库未定位"。全仓库搜索 `'tools/execute'` 监听者的结果是：

```text
packages/guard/timeout-policy/src/index.ts           ← deadline 包装（唯一"around"策略）
packages/session/session-checkpoint-policy/src/index.ts  ← 顶层工具副作用前的 flush 屏障
packages/extensions/tool-cordis/src/api-catalog.ts   ← cordis 工具目录（次要）
packages/core/tools/src/（invariant + 分发本体）
```

**retry/metrics 包装器在当前树中不存在**。文档描述的是扩展点的**可能性**（"添加截止时间、重试或指标收集"），不是已交付清单。这提醒我们：扩展点的文档语言（"you can…"）与已注册监听器（"is…"）是两层事实——**验证"谁真的挂了监听器"必须 grep，不能读文档**。

## 4. Typert 发射器：一个包两份产物

`packages/typert/generator/src/emitter.ts:104` 的 `emit(packageName)` 返回：

```ts
{
  package: packageName,
  face: this.face.face,                    // 'host' | 'client'
  exports: schemas.map(s => s.export.name),
  js,                                      // 可执行 JS（schema artifact）
  dts,                                     // 精确声明文件
  ...(face === 'host' && hasInvocations
    ? { remote: this.emitRemote(packageModel) }   // 仅 host 面：Remote 描述符贡献
    : {}),
}
```

关键事实：

- **Emitter 只消费 FaceModel**（analyzer 的编译无关模型）——模型驱动，输入输出都可审查
- **`remote` 只在 host 面、且包有 invocation 时发射**——这就是客户端 `mountContribution` 挂载的 `InvocationDescriptor` 列表（第 07 章 Typert 网关的产物端）
- `js + dts` 双产物：运行时的 schema codec + 编译期的类型——客户端拿到的不是手写 API client，而是**生成器产出的、带类型声明的调用面**

## 5. 面试要点

::: tip 面试要点 1：为什么 e2e 要 keyless 回放？
真实模型调用贵、慢、不稳定。`llm-replay` 用固定输出重放 transcript，断言的是**产品行为**（事件流、UI、持久化）而非模型行为——两者分离测试，CI 才能在无 key 环境跑完整 e2e。
:::

::: tip 面试要点 2：overlay 与 mock 的本质区别？
overlay 走**真实组装路径**（Loader + patch 层），mock 替换对象。overlay 只钉"能力差异"，不替换"被测对象"——测试的仍是真实插件树。这就是 REAL-composition 纪律的 Web 版。
:::

::: tip 面试要点 3：为什么浏览器测试串行共享一个浏览器？
浏览器 boot + 真实轮次是大开销；串行消除文件间干扰。代价是慢——所以快照测试与 e2e 分 lane，单测（vitest 默认 lane）根本不起浏览器。
:::

下一篇预告：技能系统深入 / 前端渲染内核 / 调度命令 / 重试凭据（子代理研究中）。
