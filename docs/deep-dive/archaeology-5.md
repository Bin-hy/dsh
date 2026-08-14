# 源码考古：一条被证伪的存疑与三条确认的边界

> 第三季 · 第 5 期。考古系列第一次出现"存疑被证伪"——A09-2 的串行化链尾清理其实存在。加上 always 模式的委托语义、session-reference 的消费方缺位、badge 默认关闭的无解释，构成四种典型的审计结局：**证伪 / 已文档化 / 缺口确认 / 事实确认但理由缺失**。

## 1. A09-2：串行化链尾会清理（存疑证伪）

原存疑："按 id 的 promise 链在会话退役后是否及时释放？"

`packages/session/session-persistence/src/coordinator.ts:1004-1033` 的 `serialize` 实现：

```ts
const tail = next.then(() => undefined, () => undefined)
this.chains.set(id, tail)
// Settled tails carry no serialization value. Delete only the exact tail
// installed above: a later operation may already have replaced it.
void tail.then(() => {
  if (this.chains.get(id) === tail) this.chains.delete(id)
})
```

**链尾在结算后被删除**——且用"只删自己安装的那个 tail"的精确身份比较，避免误删后来者。注释把并发语义写全了：settled tail 不携带值，`next`（真实 rejection）只给调用方。

::: tip 方法论：证伪也是结果
考古不是"找 bug 比赛"。把一条存疑证伪（"其实有清理"）与证成（"其实会崩"）同等有价值——前者让 backlog 变短，后者产出 issue。**两条都写进文章，读者才能相信其余存疑也经过了同样严格的两面检验。**
:::

## 2. A16-4：always 模式的"委托然后兜底"是文档化设计

`packages/llm/llm-retry/src/index.ts:156-180` 的 always 分支：

```ts
const downstream = await settleDownstream(next)   // 先让下游恢复器表态
if (fusedSignal.aborted) return
if (downstream.type === 'error') {
  ctx.logger.warn('llm-retry: provider "..." always policy ignored a downstream recovery failure')
}
if (downstream.type === 'decision' && downstream.decision?.kind === 'retry') {
  return downstream.decision                    // 下游决策优先
}
// 否则落到自己的兜底重试
```

注释点明了语义：**"The loop and plugin lifetime stay open until delegated recovery settles"**——下游恢复器不结算，重试就不继续。这不是"未定义行为"，而是"委托优先 + 生命周期陪绑"的明示契约。测试（retry.spec.ts:799-837）展示了排水语义：取消时先排空活跃的委托恢复再应用中止。

原存疑说"未定义注册顺序行为"——精确化之后：**组合语义（谁优先）是文档化的；注册顺序只决定多个下游之间的先后（标准 waterfall 规则）**。存疑的"未定义"部分其实很小。

## 3. A15-1：session-reference 的生产消费方不在本 checkout

全仓库搜索 `parseSessionReferenceText / sessionReferenceResolver / listCandidates` 的非测试调用方：

```text
packages/extensions/tool-cordis/src/api-catalog.ts   ← 唯一的目录条目
（host / web GUI 侧的生产调用点：不在本 checkout）
```

结论确认：**seam 有完整定义 + 测试 + 目录条目，但生产消费方（把用户输入里的提及文本解析成引用的那一端）在仓库外**。这是 monorepo 边界诚实性的一个例子：`uri.ts` 的提及语法归 session-reference 所有，但"何时调用 prepare"是宿主产品的事。

对学习者的提示：**读不到调用方的 seam，只能确认"契约存在"与"测试覆盖"，不能确认"生产路径的正确性"**——这类存疑的正确答案就是"边界在哪"。

## 4. A13-4：badge 默认关闭，无解释

`packages/bundle/base/cordis.patch.yml:243-245`：

```yaml
   - id: skill-badge
     name: '@deepseek-ai/dsh-skill-badge'
     disabled: true
```

事实确认：默认关闭、preset 可一行开启（第 13 章已讲机制）。**为什么默认关，没有任何注释或文档**——合理推断是产品洁癖（不是每个部署都想要"powered by dsh"徽章技能出现在目录里），但推断不是证据。

::: tip 方法论：默认值理由缺失是最常见的文档债
配置默认值的"为什么"最容易被略过——因为写 patch 的人觉得显而易见。但对使用者，"为什么默认关"决定了"我该不该开"。审计结论：**建议上游补一行注释**（第四类：事实确认但理由缺失）。
:::

## 5. 本篇消化的 backlog 项

- ✅ A09-2 串行化链尾清理（**证伪**：tail 结算后精确删除，无泄漏）
- ✅ A16-4 always 模式下游组合（文档化：委托优先 + 生命周期陪绑；测试有排水语义）
- ✅ A15-1 session-reference 生产消费方缺位（确认：仓库外，契约+测试在，生产路径不可验证）
- ✅ A13-4 skill-badge 默认关闭无理由（确认：事实在，理由缺，建议上游补注释）

## 6. 下一期预告

考古⑥候选：A09-4（搜索对账滞后窗口）、A09-5（投影缓存回写无版本仲裁）、A16-2（call-config epoch 字段未决）、A14-1（viewFor 契约）。
