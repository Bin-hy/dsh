---
layout: home

hero:
  name: "DSH 深度拆解"
  text: "DeepSeek Harness 源码级学习资料"
  tagline: 从 Cordis 插件框架到 Agent Loop 状态机 —— 一份面向 Agent 开发岗位的完整拆解
  actions:
    - theme: brand
      text: 开始学习
      link: /guide/why-dsh
    - theme: alt
      text: 核心概念速览
      link: /guide/concepts
    - theme: alt
      text: 面试题库
      link: /interview/qa

features:
  - icon: 🧩
    title: 一切皆插件
    details: DSH 建立在 vendored Cordis 之上：模型适配器、工具注册表、会话日志，甚至 Agent Loop 本身都是插件，可被配置替换。
  - icon: 📜
    title: 事件溯源式会话日志
    details: 追加式 SessionEvent 日志是唯一真源。模型可见即已记录，回放、fork、恢复、遥测全部派生自同一事件流。
  - icon: 🔁
    title: Turn / Step 状态机
    details: 轮次排空 inbox，步骤是一次模型请求 + 工具执行。waterfall 事件让策略监听器在不动循环代码的前提下拦截一切。
  - icon: 🛠️
    title: 能力 Seam 架构
    details: Service Definition / Provider / Consumer 三角色。替换一个提供方（如把 bash 指向远程沙箱），产品整体行为随之改变。
  - icon: 🌊
    title: 流式端到端
    details: provider 流 → llm/stream waterfall → assistant/chunk 持久事件 → Web GUI 增量渲染。每个环节都可拦截、可回放。
  - icon: 🏗️
    title: 多代理编排
    details: subagent 能力 seam、受限 JS workflow 引擎、后台 jobs、持久 goal 循环、Ralph 全新代理迭代——全部是工具，不是特权内核。

footer: MIT Licensed · 基于 deepseek-harness 0.1.0-rc.5 源码
---

## 这份资料是什么

这是对 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 的一次**源码级深度拆解**。DSH 是一个生产级 Agent Harness：插件化架构、事件溯源会话日志、完整的工具执行管道、多代理编排系统、Web GUI。它同时是我（本资料作者）研究 agent 系统的第一个深度案例。

资料分四条主线：

- **[导读](/guide/why-dsh)**：为什么要研究这个项目，核心概念与术语，架构总览
- **[深度拆解](/deep-dive/agent-loop)**：8 篇文章，逐子系统拆解核心循环、工具管道、沙箱、上下文工程、编排、LLM 层、Web GUI、持久化与工程化
- **[面试冲刺](/interview/patterns)**：可迁移的设计模式手册 + 高频面试题
- **[实战](/practice/extend)**：跟着 cookbook 亲手给 DSH 加一个工具

## 学习路线建议

```text
第 1 天：导读 3 篇 —— 建立心智模型（Cordis、事件、seam）
第 2 天：核心循环 + 工具系统 —— 理解 Agent 的"心跳"
第 3 天：上下文工程 + 多代理编排 —— 理解 agent 的"记忆"与"协作"
第 4 天：LLM 层 + Web GUI —— 理解数据如何流动
第 5 天：面试冲刺 + 实战扩展 —— 输出自己的理解
```

每篇拆解文章都包含：概念地图 → 模块与文件地图 → 关键类型定义 → 执行流程 → 设计权衡 → 面试要点。

## 持续更新中 🔬

深度拆解系列在持续更新。已完成 8 篇（01~08），新一轮深挖正在进行：

```text
✅ 01 核心循环    ✅ 02 工具系统    ✅ 03 沙箱权限   ✅ 04 上下文工程
✅ 05 多代理编排  ✅ 06 LLM 流式    ✅ 07 Web GUI    ✅ 08 持久化与工程化
✅ 09 会话持久化内核（write-behind / 崩溃修复 / 冷读取阶梯）
✅ 10 进程外子代理与 ACP（四种跨进程传输）
✅ 11 作用域与事件内核（vendored Cordis waterfall 逐行拆解）
✅ 12 终端与 PTY（node-pty / 提示符检测 / 持久会话）
✅ 编排补遗 · 压缩与计量补遗 · 启动与沙箱补遗 · 测试与 Typert
✅ 13 技能深入  ✅ 14 前端渲染内核  ✅ 15 调度命令  ✅ 16 重试凭据
✅ 启动与沙箱补遗 · 测试与 Typert
—— 12 个主聚类全部消化（共 26 篇）——
⬜ 第二轮存疑 20 条（A09/A10/A11 消化中新发现，见 backlog）
```

完整路线图见 [research/backlog.md](https://github.com/Bin-hy/dsh/blob/main/research/backlog.md)（56 条存疑项 → 12 个文章聚类）。

## 核心结论预览

> DSH 的设计哲学可以浓缩为一句话：**用事件流和可逆副作用取代硬编码的控制流**。
> 循环本身没有特权——策略（审批、沙箱、压缩、遥测）以监听器身份挂在事件上，
> 能力（LLM、bash、文件系统、子代理）以提供方身份挂在服务 seam 上。
> 换掉一个插件，产品就换了一种行为；而会话日志保证每一步都可回放、可审计。

<small>说明：本文档为学习笔记，大量内容整理自 DSH 官方文档与源码；源码路径以 `packages/...` 形式给出，对应仓库根目录。关联项目：[github.com/Bin-hy/dsh](https://github.com/Bin-hy/dsh)</small>
