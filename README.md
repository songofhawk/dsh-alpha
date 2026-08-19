# dsh-metacontroller

主控 agent 统一编排：一个 dsh 插件项目，让**主控 agent** 根据各 agent 特点、机器环境与可达性，把任务智能分派给多台机器上的多个 agent（Codex / Claude Code / Kimi / dsh headless）执行。

- 设计文档：[docs/design.md](docs/design.md)
- 背景与完整推演：agent-anywhere 仓库 `docs/metacontroller-design.md`

## 状态

- [ ] 阶段 0：单机主控闭环（MCP 包装外部 agent + list/dispatch 工具原型）
- [ ] 阶段 1：gateway 跨机通道（反向 WS + 心跳 + 目录注册）
- [ ] 阶段 2：任务协议与审批桥接
- [ ] 阶段 3：负载 / repo 选机 / 按需 clone

## 快速开始（阶段 0）

待实现后补充：如何挂载 preset、如何配置 MCP 桥、如何发起第一次分派。

## 技术栈

Node.js 原生风格（CommonJS、`node:http`、JSON 存储、`node --test`），dsh（DeepSeek Harness）插件形态。
