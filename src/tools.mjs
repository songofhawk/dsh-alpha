// alpha preset 工具面：list_agents / dispatch_task / task_status / task_result
// / agent_approve / agent_cancel（设计文档 §3 工具契约）+ 分派策略提示词。
//
// 该模块作为 agent 平面一行挂进 alpha preset；注入的 alpha* 服务由 host
// 平面的 dsh-alpha 插件提供。

import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-alpha-tools";
export const inject = ["tools", "systemPrompt", "alphaCatalog", "alphaEngine", "alphaApprovals"];

const STRATEGY_PROMPT = `你是 alpha 主控 agent：统一指挥多机多 agent 完成用户任务。

分派流程：
1. 先调用 list_agents 查看目录：每个 agent 的 provider / 模型 / 机器环境、负载与持有的 repo。
2. 根据任务类型与各 agent 特点做 LLM 决策，选择最合适的 agent；
   machine.load.active_turns 只作排序信号，不要机械按负载选机。
3. 任务涉及特定仓库时用 repoUrl 参数：优先派给「持有该 repo」的机器（repo 身份选机），
   无人持有则落到最空闲机器由远端按需 clone。
4. 调用 dispatch_task 派发任务（agentId 可省略 —— 按上述策略自动选机），得到 taskId 后轮询 task_status。
5. 任务完成后用 task_result 取回结果与事件流并汇总给用户。
6. 若 task_status 显示 blocked（存在待决审批），用 agent_approve 审批，
   或说明拒绝理由；故障时审批默认拒绝。
7. 任务长时间无进展可用 agent_cancel 取消。
8. 主控可递归：你自己也是目录里的 dsh-master agent，更高层控制器可向你派发，
   你负责把子任务拆给其它 agent 并把结果上卷；普通任务不要选择 dsh-master，
   它只接受控制器生成的 recursion 载荷，也不会参与自动选机。

派发参数建议：
- approvalPolicy=never / mode=auto-review：自动化场景，减轻频繁审批；
- mode=default 且 policy=on-request：需要人工审视危险操作的场景本项目默认。
`;

function renderListAgents(agents) {
  if (!Array.isArray(agents) || agents.length === 0) return "（目录为空：没有可派发的 agent）";
  const lines = agents.map((agent) => {
    const machine = agent.machine || {};
    const load = machine.load?.active_turns ?? 0;
    const statusLine = agent.available
      ? `在线（负载 ${load}）`
      : `不可用：${agent.unavailableReason || "未知"}`;
    const repos = Array.isArray(machine.repos) && machine.repos.length
      ? machine.repos.map((r) => r.repo_url || r.url).join(", ")
      : "（无）";
    return [
      `- ${agent.agentId}（provider=${agent.provider}，模型=${agent.model || "默认"}）`,
      `  ${statusLine}`,
      `  机器 ${machine.platform || "?"}/${machine.os || "?"}，allowedRoots=[${(machine.allowedRoots || []).join(", ")}]`,
      `  能力：models=[${(agent.capabilities?.models || []).join(", ")}] modes=[${(agent.capabilities?.modes || []).join(", ")}]`,
      `  持有 repo：${repos}`
    ].join("\n");
  });
  return `已发现 ${agents.length} 个 agent：\n${lines.join("\n")}`;
}

function renderTaskStatus(status) {
  let text = `任务 ${status.taskId}：${status.state}${status.error ? `（${status.error}）` : ""}`;
  if (status.pendingApprovals?.length) {
    text += `\n待决审批：${status.pendingApprovals.map((a) => `${a.id}（${a.kind}：${a.reason || a.command || "无说明"}）`).join("；")}\n`;
    text += "调用 agent_approve 决策，或说明拒绝理由。";
  }
  return text;
}

function renderTaskResult(result) {
  const lines = [`任务 ${result.taskId} 结果：`];
  if (result.result) lines.push(String(result.result));
  if (result.usage) lines.push(`usage: ${JSON.stringify(result.usage)}`);
  if (result.artifacts?.length) lines.push(`artifacts: ${JSON.stringify(result.artifacts)}`);
  const deltas = (result.events || []).filter((e) => e.type === "delta" || e.type === "complete");
  if (deltas.length) {
    const tail = deltas.slice(-20).map((e) => e.payload?.text || e.payload?.message || "").filter(Boolean).join("");
    lines.push(`事件流末尾：${tail.slice(0, 2000)}`);
  }
  return lines.join("\n");
}

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: "dsh-alpha:strategy",
    order: 20,
    text: STRATEGY_PROMPT
  });

  const catalog = ctx.alphaCatalog;
  const engine = ctx.alphaEngine;
  const approvals = ctx.alphaApprovals;

  ctx.tools.register(defineTool({
    name: "list_agents",
    description: "查询主控目录：返回所有可用 agent 及其 provider、模型、机器环境、负载与能力。分派前必须先调用本工具。",
    parameters: {
      online: {
        type: "boolean",
        description: "仅列出在线 agent（默认列出全部）。"
      }
    },
    output: {
      schema: { type: "json" },
      render: (args, value) => [{ type: "text", text: renderListAgents(value) }]
    },
    execute: async (args) => {
      const rows = catalog.listAgents();
      return args.online === true ? rows.filter((r) => r.available === true) : rows;
    }
  }));

  ctx.tools.register(defineTool({
    name: "dispatch_task",
    description: "把任务派发给目录中某个 agent 执行。返回 taskId，随后用 task_status / task_result 轮询。",
    parameters: {
      agentId: {
        type: "string",
        description: "目标 agent ID（来自 list_agents，可选；省略时由引擎按 repo 与负载自动选择）。"
      },
      prompt: {
        type: "string",
        required: true,
        description: "派发给该 agent 的任务文本（原样传给远端 agent 的 LLM）。"
      },
      projectPath: {
        type: "string",
        description: "工作目录（可选，默认主控当前目录；远端按各自 allowed roots 校验）。"
      },
      repoUrl: {
        type: "string",
        description: "目标 repo URL（可选）：优先派给持有该 repo 的机器（repo 身份选机）；若无人持有且允许按需 clone，则落到最空闲机器由远端按需 clone。"
      },
      mode: {
        type: "string",
        enum: ["default", "auto-review", "full-access"],
        description: "执行模式：auto-review 自动审查（默认）、default 需远端确认、full-access 完全放行。"
      },
      approvalPolicy: {
        type: "string",
        enum: ["never", "on-request"],
        description: "审批策略：on-request 需要时审批（默认）、never 永不审批。"
      }
    },
    output: {
      schema: { type: "json" },
      render: (args, value) => [{
        type: "text",
        text: `已派发任务 ${value.taskId} → ${value.agentId}，当前状态 ${value.status}。`
      }]
    },
    execute: async (args) => engine.dispatch({
      agentId: args.agentId,
      prompt: args.prompt,
      projectPath: args.projectPath,
      repoUrl: args.repoUrl,
      mode: args.mode,
      approvalPolicy: args.approvalPolicy
    })
  }));

  ctx.tools.register(defineTool({
    name: "task_status",
    description: "查询任务状态（queued/running/blocked/completed/failed/cancelled）；blocked 时附带待决审批信息。",
    parameters: {
      taskId: { type: "string", required: true, description: "dispatch_task 返回的 taskId。" }
    },
    output: {
      schema: { type: "json" },
      render: (args, value) => [{ type: "text", text: renderTaskStatus(value) }]
    },
    execute: async (args) => {
      const base = engine.taskStatus(args.taskId);
      const pending = approvals.listPending()
        .filter((a) => a.taskId === args.taskId)
        .map((a) => ({ id: a.id, taskId: a.taskId, kind: a.kind, command: a.command, reason: a.reason }));
      return { ...base, pendingApprovals: pending };
    }
  }));

  ctx.tools.register(defineTool({
    name: "task_result",
    description: "取回已完成/失败任务的最终结果、usage、artifacts 与事件流。",
    parameters: {
      taskId: { type: "string", required: true, description: "dispatch_task 返回的 taskId。" }
    },
    output: {
      schema: { type: "json" },
      render: (args, value) => [{ type: "text", text: renderTaskResult(value) }]
    },
    execute: async (args) => engine.taskResult(args.taskId)
  }));

  ctx.tools.register(defineTool({
    name: "agent_approve",
    description: "审批远端 agent 冒泡上来的权限请求（批准/拒绝/取消）。故障时默认拒绝。",
    parameters: {
      approvalId: {
        type: "string",
        required: true,
        description: "待决审批 ID（来自 task_status 的 pendingApprovals）。"
      },
      decision: {
        type: "string",
        enum: ["approved", "rejected", "cancel"],
        required: true,
        description: "approved 放行 / rejected 拒绝 / cancel 取消该任务。"
      }
    },
    output: {
      schema: { type: "json" },
      render: (args, value) => [{ type: "text", text: `审批 ${args.approvalId} → ${value.decision}` }]
    },
    execute: async (args) => engine.decideApproval(args.approvalId, args.decision)
  }));

  ctx.tools.register(defineTool({
    name: "agent_cancel",
    description: "取消一个进行中的任务。",
    parameters: {
      taskId: { type: "string", required: true }
    },
    output: {
      schema: { type: "json" },
      render: (args, value) => [{ type: "text", text: `任务 ${args.taskId} → ${value.status}` }]
    },
    execute: async (args) => engine.cancelTask(args.taskId)
  }));
}
