# dsh-alpha 设计

> 简洁实用版（2026-08）。详细背景见 agent-anywhere `docs/metacontroller-design.md`。

## 1. 定位

一个 dsh 插件项目：**主控 agent 统一指挥多机多 agent**。

主控 agent 通过目录工具了解每个 agent 的**特点**（provider/模型/能力）、**机器环境**（OS/路径根/负载）、**可达性**（在线/心跳），据此用 LLM 决策把任务分派给最合适的 agent 执行，并回收事件流、审批和结果。

## 2. 架构

```text
主控 dsh 实例（唯一入口）
├─ 主控 agent preset「alpha」
│   ├─ 系统提示：分派策略（任务类型 → 候选 agent）
│   ├─ 工具：list_agents / dispatch_task / task_status /
│   │         task_result / agent_approve / agent_cancel
│   └─ 决策：LLM 读目录 JSON 决策（负载打分仅作排序信号）
├─ 目录服务：机器+agent 注册表（能力元数据 + 心跳 + 负载）
└─ 通道插件
    ├─ gateway hub：接收 worker 反向 WS（跨 NAT，主路径）
    └─ MCP 桥：dsh-mcp-client 直连外部 MCP server（快速验证）
              │ 反向 WS / MCP
      ┌────────┼─────────┐
      ▼        ▼         ▼
   worker A  worker B   worker C（每台目标机）
   claude    codex      kimi / dsh headless
```

两条通道并存：**Gateway**（反向连接，目标机无需公网 IP，阶段 1 起主路径）；**MCP**（零协议开发，阶段 0 验证用）。

## 3. 核心接口（工具契约）

```text
list_agents()
  → [{ agentId, machineId, provider, model, capabilities: [...],
       machine: { os, platform, allowedRoots, load, lastHeartbeatMs, online } }]

dispatch_task({ agentId, prompt, projectPath?, mode?, approvalPolicy? })
  → { taskId, agentId }

task_status({ taskId }) → { state, error? }
task_result({ taskId }) → { result, usage?, artifacts? }
agent_approve({ taskId, decision })   // 远端审批冒泡到主控会话
agent_cancel({ taskId })
```

数据模型复用 agent-anywhere 已验证结构：机器身份 + per-machine token、`provider_capabilities`、心跳 `active_turns/repos/load`、canonical repo URL、allowed roots 校验。

## 4. 分阶段任务（每阶段可验收）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| 0 | 单机主控闭环：`alpha` preset + 本机 MCP 包装 claude-code/codex/kimi + list/dispatch 原型工具 | 主控 agent 查询目录 → LLM 决策 → 派发 → 结果回流，真实跑通一次 |
| 1 | gateway 跨机通道：hub 插件 + 反向 WS + 心跳 + 目录注册 | 目标机无公网 IP 场景，主控能看到并派发到远端 agent |
| 2 | 任务协议：dispatch/status/result 事件回流主控会话 + 审批桥接 | 远端权限请求在主控会话审批，同意/拒绝正确传导 |
| 3 | 策略增强：负载感知排序、repo 身份选机、受 allowed roots 约束的按需 clone、主控可递归 | 任务能自动落到最空闲且有目标 repo 的机器；clone 后 repo 进入心跳广播 |
| 4 | 对齐 dsh 官方 SubagentProvider 与 plugin 安装 | 本地官方 provider、alpha-gateway provider、源码与 registry profile 均可挂载 |

## 5. 技术约束

- dsh 插件形态：Cordis plugin，经 profile `cordis.patch.yml` 挂载；主控 agent 是 agent preset。
- CommonJS、`node:http`、JSON 存储、`node --test`（沿用 agent-anywhere 风格）。
- 默认不引入新依赖；确需时先说明理由。
- 路径逻辑遵守 `AGENT_ANYWHERE_ALLOWED_ROOTS` 同款边界（远端各自校验）。

## 6. 安全边界

- **认证是硬前提**：dsh `/api` 信任栅栏不是认证；多机 + 远程访问前必须有认证层（主控入口登录 + worker token）。
- 审批：远端 agent 权限请求一律冒泡主控会话，故障默认 deny。
- 沙箱：主控与各 worker 各自执行自己的沙箱/路径策略。
- worker 只广播本机探测可用的 provider；收到任务后再次按 worker allowed roots 校验执行路径。
- repo canonical key 只用于身份比较；clone 保留可执行 URL。URL 不允许内嵌凭据，认证必须由目标机 Git credential/SSH 提供。
- token 优先通过 WebSocket header 传输；公网部署必须在 hub 前使用 TLS（`wss://`）和来源限制。
- 单条 WebSocket payload 上限为 8 MiB，超限连接直接关闭，避免已认证但失控的 worker 撑爆主控内存。

## 7. 目标目录结构

```text
dsh-alpha/
├─ docs/design.md            # 本文档
├─ src/
│   ├─ preset/               # alpha agent preset（分派策略提示词）
│   ├─ tools/                # list_agents / dispatch 工具实现
│   ├─ gateway-hub/          # 主控侧：反向 WS hub + 目录注册表
│   ├─ gateway-worker/       # 远端侧：连出主控的 worker
│   └─ adapters/             # codex / claude-code / kimi 适配（阶段 0 起）
└─ test/                     # node --test
```
