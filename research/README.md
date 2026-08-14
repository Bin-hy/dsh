# 研究底稿

本目录保存博客文章的原始研究笔记。它们是子代理对 deepseek-harness 仓库做代码级研究时产出的底稿，全部代码引用采用 `文件路径:起始行` 格式，可回溯到 [deepseek-harness](https://github.com/deepseek-ai/DeepSeek-Harness) 对应源码。

## 笔记清单

| 笔记 | 主题 | 对应博客 |
|---|---|---|
| [01-core-loop.md](./01-core-loop.md) | 核心循环与运行时（Agent 接口、turn/step 状态机、inbox、事件域） | [核心循环：Agent Loop](https://bin-hy.github.io/dsh/deep-dive/agent-loop) |
| [02-tools-sandbox.md](./02-tools-sandbox.md) | 工具注册表、执行流水线、沙箱（Landlock）、审批 | [工具系统](https://bin-hy.github.io/dsh/deep-dive/tools) + [沙箱与权限](https://bin-hy.github.io/dsh/deep-dive/sandbox) |
| [03-context-skills.md](./03-context-skills.md) | 提示词组装、compaction、spill、token 计量、技能系统 | [上下文工程](https://bin-hy.github.io/dsh/deep-dive/context) |
| [04-orchestration.md](./04-orchestration.md) | subagent、workflow、jobs、goal、todo/plan | [多代理编排](https://bin-hy.github.io/dsh/deep-dive/orchestration) |
| [05-llm-streaming.md](./05-llm-streaming.md) | LLM 适配器 seam、流式协议、重试、凭据 | [LLM 层与流式管道](https://bin-hy.github.io/dsh/deep-dive/llm) |
| [06-web-gui.md](./06-web-gui.md) | 启动链路、事件推送、增量渲染、Typert RPC | [Web GUI 与 API 层](https://bin-hy.github.io/dsh/deep-dive/web) |

## 使用方式

- **学习**：博客是提炼后的成品；笔记含更多原始证据与细节，适合对照源码精读
- **纠错**：发现笔记或博客与源码不符，欢迎提 Issue/PR
- **深挖**：全部 56 条存疑/待确认项已整理为 [backlog.md](./backlog.md)，按 12 个文章聚类跟踪，逐个消化

> 注意：行号以研究时（deepseek-harness 0.1.0-rc.5）的仓库状态为准，上游更新后可能有偏移。
