# dsh-alpha 设计

> 简洁实用版（2026-08）。详细背景见 agent-anywhere `docs/metacontroller-design.md`。

## 1. 定位

一个 dsh 插件项目：**主控 agent 统一指挥多机多 agent**。

主控 agent 通过目录工具了解每个 agent 的**特点**（provider/模型/能力）、**机器环境**（OS/路径根/负载）、**可达性**（在线/心跳），据此用 LLM 决策把任务分派给最合适的 agent 执行，并回收事件流、审批和结果。

主控机本地目录不是项目真相。每个 worker 只在自己的 `allowedRoots` 内发现或显式登记 workspace；主控按 canonical repo identity 聚合为全局逻辑工作区，再把选中的逻辑项目解析为目标机器自己的物理路径。

Web 侧由独立 `Alpha 主控` 入口先完成全局工作区选择，再创建会话。DSH 自身仍要求会话归属一个本机 Workspace，因此插件为明确的目标机+目标目录创建稳定的本地主控分组目录；没有目标选择时才使用中性的 `alpha-control`。这些本地主控目录只用于侧栏分组和会话承载，不会被当作目标项目执行。

## 2. 架构

```text
主控 dsh 实例（唯一入口）
├─ 主控 agent preset「alpha」
│   ├─ 系统提示：分派策略（任务类型 → 候选 agent）
│   ├─ 工具：list_workspaces / list_agents / dispatch_task / wait_task / task_status /
│   │         task_result / agent_approve / agent_cancel
│   └─ 决策：LLM 读目录 JSON 决策（负载打分仅作排序信号）
├─ 目录服务：机器+agent 注册表（能力元数据 + 心跳 + 负载）
├─ 工作区服务：多机 workspace inventory → 逻辑项目聚合 → session 选择
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
list_workspaces({ query?, machineId? })
  → [{ workspaceId, name, repoUrl?, locations:[{machineId,path,online,providers}] }]

Web workspace selection:
  machineId? + workspaceId? → session-scoped target constraints
  agentId? + mode? + model? + reasoningEffort? → per-turn Worker settings
  machineId omitted → scheduler auto-picks a machine
  workspaceId omitted → prompt/workspace matching remains automatic

  agentId omitted → scheduler auto-picks an Agent in the selected scope
  any selected scope → overrides an LLM-provided agentId

Alpha 主控目录页：左下角 Alpha 主控入口打开完整机器视图；机器行展示在线状态、负载、Agent 和项目，机器详情可编辑说明并查看项目；选定机器后可在其 allowed roots 下浏览、选择或新建目录，直接登记为新的工作区；项目可编辑说明。Agent 说明在独立标签页按 provider 维护，不随机器重复。目录说明持久化在 `DSH_ALPHA_DATA_DIR/inventory-notes.json`，同时进入 `list_workspaces` / `list_agents` 的模型可见输出，作为后续自动选机、选项目和选 Agent 的路由参考。

Selected Alpha sessions are grouped by `<machineId> · <targetPath>` when the
target is explicit. The session's selected `agentId`, `mode`, `model`, and
`reasoningEffort` are also persisted per session; missing values remain
automatic and are resolved by the master for each dispatch turn. Target
selection is exposed only on the blank/new-session surface; active turns do
not change the machine or project.

list_agents()
  → [{ agentId, machineId, provider, model, capabilities: [...],
       machine: { os, platform, allowedRoots, load, lastHeartbeatMs, online } }]

dispatch_task({ workspaceId?, agentId?, prompt, mode?, approvalPolicy? }) → { taskId, status }
wait_task({ taskId }) → 任务终态或 blocked
  → 等待终态 → { taskId, agentId, status, result?, error?, pendingApprovals? }

task_status({ taskId }) → { state, error? }                 // 仅故障恢复
task_result({ taskId }) → { result, usage?, artifacts? }    // 仅故障恢复
agent_approve({ taskId, decision })   // 远端审批冒泡到主控会话
agent_cancel({ taskId })
```

数据模型复用 agent-anywhere 已验证结构：机器身份 + per-machine token、`provider_capabilities`、心跳 `active_turns/repos/load`、canonical repo URL、allowed roots 校验。

正常会话不轮询：`dispatch_task` 创建任务后立即返回持久化 `taskId`，随后 `wait_task` 订阅任务状态事件。等待调用被会话中断时只解除订阅，不取消 Worker 任务；恢复后用同一 `taskId` 继续等待。只有审批阻塞才提前返回，`agent_approve` 决策后继续等待同一任务。

## 4. 分阶段任务（每阶段可验收）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| 0 | 单机主控闭环：`alpha` preset + 本机 MCP 包装 claude-code/codex/kimi + list/dispatch 原型工具 | 主控 agent 查询目录 → LLM 决策 → 派发 → 结果回流，真实跑通一次 |
| 1 | gateway 跨机通道：hub 插件 + 反向 WS + 心跳 + 目录注册 | 目标机无公网 IP 场景，主控能看到并派发到远端 agent |
| 2 | 任务协议：dispatch/status/result 事件回流主控会话 + 审批桥接 | 远端权限请求在主控会话审批，同意/拒绝正确传导 |
| 3 | 策略增强：负载感知排序、repo 身份选机、受 allowed roots 约束的按需 clone、主控可递归 | 任务能自动落到最空闲且有目标 repo 的机器；clone 后 repo 进入心跳广播 |
| 4 | 对齐 dsh 官方 SubagentProvider 与 plugin 安装 | 本地官方 provider、alpha-gateway provider、源码与 registry profile 均可挂载 |
| 5 | 全局逻辑工作区：worker inventory、repo 聚合、Web 选择器、表述解析、路径约束 | 主控机没有项目目录时仍可选择远端 workspace；同 repo 多路径聚合；任务只在选中项目的位置或其受控 clone 中执行 |

## 5. 技术约束

- dsh 插件形态：通用 bundle 只挂控制平面，可安全进入 Web/TUI/headless；一次性 runner 由 alpha profile 的托管 `cordis.patch.yml` 区块挂载。主控 agent 是 agent preset。
- 发布包保持单一 DSH runtime：只把 Schemastery 作为运行时依赖，工具通过宿主 `ctx.tools` 注册，Agent/Session/ToolRuntime 服务全部由 profile 提供。不得在 Web profile 内安装第二份 DSH core；`dsh-tools` 的 scheduler 使用模块私有 identity，双包会把 `tool/call` 与 `tool/result` 链路拆开。
- CommonJS、`node:http`、JSON 存储、`node --test`（沿用 agent-anywhere 风格）。
- 默认不引入新依赖；确需时先说明理由。
- 路径逻辑遵守 `AGENT_ANYWHERE_ALLOWED_ROOTS` 同款边界（远端各自校验）。
- `allowedRoots` 是权限边界，不是工作区列表；自动发现最多检查 root 本身和直属 Git 仓库，普通目录只有显式登记后才可见。

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
