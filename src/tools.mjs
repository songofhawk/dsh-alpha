// alpha preset 工具面：list_agents / dispatch_task / wait_task / task_status / task_result
// / agent_approve / agent_cancel（设计文档 §3 工具契约）+ 分派策略提示词。
//
// 该模块作为 agent 平面一行挂进 alpha preset；注入的 alpha* 服务由 host
// 平面的 dsh-alpha 插件提供。这里故意不 import @deepseek-ai/dsh-tools：Web
// 必须复用宿主唯一 ToolRuntime，避免模块私有 scheduler Symbol 的双包冲突。

export const name = "dsh-alpha-tools";
export const inject = ["tools", "systemPrompt", "alphaCatalog", "alphaEngine", "alphaApprovals", "alphaWorkspaces"];

const JSON_OBJECT_SCHEMA = { type: "object" };
const JSON_OBJECT_ARRAY_SCHEMA = { type: "array", items: { type: "object" } };

function defineAlphaTool(options) {
  const properties = {};
  const required = [];
  for (const [key, input] of Object.entries(options.parameters || {})) {
    const { required: isRequired, ...schema } = input;
    properties[key] = schema;
    if (isRequired) required.push(key);
  }
  return {
    ...options,
    parameters: {
      type: "object",
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {})
    }
  };
}

const STRATEGY_PROMPT = `你是 alpha 主控 agent：统一指挥多机多 agent 完成用户任务。

分派流程：
1. 如果界面已经同时选定工作机和工作区，跳过 list_workspaces/list_agents，直接调用 dispatch_task；不要自行判断、改项目或改 agent。
   界面选择是用户的硬路由指令，任务必须交给对应 Worker。
2. 如果只选定了工作机，直接调用 dispatch_task；由调度器在该机器上处理任务。
3. 用户未选择时，才调用 list_workspaces，根据任务表述由你决定 workspace：唯一明确命中时使用它；多个候选时先询问用户；与项目无关的任务可不绑定 workspace。
4. 未选定范围时，再调用 list_agents 查看 provider / 模型 / 机器环境、负载与持有的 repo，并做 LLM 决策。
   machine.load.active_turns 只作排序信号，不要机械按负载选机。
   目录返回的机器、项目和 Agent 选择说明是用户配置的路由原则，应作为选择时的高优先级参考。
5. 用户未在界面选择目标时，调用 dispatch_task 必须明确传入你决定的 agentId；项目任务同时传入 workspaceId。调度器不会再根据 prompt 二次推断目标。
   只有界面已明确选择工作机/工作区/Agent 时，agentId/workspaceId 才可省略，由调度器沿用界面选择；
   Git workspace 在目标机不存在时可按需 clone，绝不要把一台机器的绝对路径直接传给另一台。
6. dispatch_task 只负责创建任务并立即返回 taskId；随后必须调用一次 wait_task，事件驱动地等待最终输出，禁止轮询 task_status/task_result。
7. 只有 wait_task 返回 blocked（存在待决审批）时才调用 agent_approve；agent_approve 同样会继续等待并返回最终输出。
   无法决定审批时向用户说明，故障时默认拒绝。
8. 任务长时间无进展可用 agent_cancel 取消。
9. wait_task 或 agent_cancel 返回 cancelled，表示用户已经停止；禁止自动重试、改派或继续调用工具，应立即结束当前 turn，把输入权还给用户。
10. 主控可递归：你自己也是目录里的 dsh-master agent，更高层控制器可向你派发，
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
      `  机器说明：${machine.description || "（未填写）"}`,
      `  选择说明：${agent.description || "（未填写）"}`,
      `  能力：models=[${(agent.capabilities?.models || []).join(", ")}] modes=[${(agent.capabilities?.modes || []).join(", ")}]`,
      `  持有 repo：${repos}`
    ].join("\n");
  });
  return `已发现 ${agents.length} 个 agent：\n${lines.join("\n")}`;
}

function currentSelection(workspaces, sessionId) {
  return typeof workspaces.selection === "function"
    ? workspaces.selection(sessionId)
    : { workspace: null, machineId: null };
}

function selectedMachineIds(selection) {
  if (selection?.machineId) return [selection.machineId];
  return [...new Set((selection?.workspace?.locations || [])
    .filter((location) => location.online)
    .map((location) => location.machineId))];
}

function selectedWorkspaceView(selection) {
  if (!selection?.workspace) return null;
  if (!selection.machineId) return selection.workspace;
  return {
    ...selection.workspace,
    locations: selection.workspace.locations.filter((location) => location.machineId === selection.machineId)
  };
}

function renderTaskStatus(status) {
  let text = `任务 ${status.taskId}：${status.state}${status.error ? `（${status.error}）` : ""}`;
  if (status.pendingApprovals?.length) {
    text += `\n待决审批：${status.pendingApprovals.map((a) => `${a.id}（${a.kind}：${a.reason || a.command || "无说明"}）`).join("；")}\n`;
    text += "调用 agent_approve 决策，或说明拒绝理由。";
  }
  return text;
}

function renderDispatchOutcome(value) {
  const target = `${value.agentId || "未知 agent"}${value.workspaceName ? ` @ ${value.workspaceName}` : ""}`;
  if (value.status === "completed") {
    return `远端任务已完成（${target}，${value.durationMs || 0}ms）：\n${value.result || "（无文本输出）"}`;
  }
  if (value.status === "blocked") {
    const pending = (value.pendingApprovals || []).map((approval) =>
      `${approval.id}（${approval.kind}：${approval.reason || approval.command || "无说明"}）`
    ).join("；");
    return `远端任务等待审批（${target}）：${pending || "审批详情暂不可用"}`;
  }
  if (value.status === "failed" || value.status === "cancelled") {
    return `远端任务${value.status === "failed" ? "失败" : "已取消"}（${target}）：${value.error || "无错误详情"}`;
  }
  return `远端任务 ${value.taskId} 当前状态：${value.status}`;
}

function renderWorkspaces(workspaces) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return "（全局工作区目录为空）";
  return workspaces.map((workspace) => {
    const locations = workspace.locations.map((location) =>
      `${location.machineId}:${location.path}${location.online ? "（在线）" : "（离线）"}`
    ).join("；");
    return `- ${workspace.name} [${workspace.workspaceId}]${workspace.repoUrl ? ` repo=${workspace.repoUrl}` : ""}\n  选择说明：${workspace.description || "（未填写）"}\n  ${locations}`;
  }).join("\n");
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
  const workspaces = ctx.alphaWorkspaces;
  // 工具注册可能早于会话恢复或 preset 切换；不能把当时的 agent/session
  // 身份闭包化，否则 UI 后续选择的 workspace 会落不到本次 dispatch。
  const currentSessionId = (exec) => exec?.agent?.session?.id || exec?.agent?.id || ctx.agent?.session?.id || ctx.agent?.id || null;

  ctx.tools.register(defineAlphaTool({
    name: "list_workspaces",
    description: "查询所有机器汇总出的全局逻辑工作区。同一 Git repo 的不同机器路径会聚合在一个 workspace 下；分派项目任务前先调用。",
    parameters: {
      query: { type: "string", description: "按项目名、workspaceId 或 repo URL 搜索；省略时列出全部。" },
      online: { type: "boolean", description: "为 true 时只返回至少有一个在线位置的 workspace。" }
    },
    output: {
      schema: JSON_OBJECT_ARRAY_SCHEMA,
      render: (args, value) => [{ type: "text", text: renderWorkspaces(value) }]
    },
    execute: async (args, exec) => {
      const selection = currentSelection(workspaces, currentSessionId(exec));
      const selectedWorkspace = selectedWorkspaceView(selection);
      if (selectedWorkspace) return [selectedWorkspace];
      return workspaces.list({
        query: args.query || "",
        includeOffline: args.online !== true,
        machineId: selection.machineId || null
      });
    }
  }));

  ctx.tools.register(defineAlphaTool({
    name: "list_agents",
    description: "查询主控目录：返回所有可用 agent 及其 provider、模型、机器环境、负载与能力。分派前必须先调用本工具。",
    parameters: {
      online: {
        type: "boolean",
        description: "仅列出在线 agent（默认列出全部）。"
      }
    },
    output: {
      schema: JSON_OBJECT_ARRAY_SCHEMA,
      render: (args, value) => [{ type: "text", text: renderListAgents(value) }]
    },
    execute: async (args, exec) => {
      const selection = currentSelection(workspaces, currentSessionId(exec));
      const machineIds = selectedMachineIds(selection);
      const rows = catalog.listAgents().filter((row) => !machineIds.length || machineIds.includes(row.machineId));
      return args.online === true ? rows.filter((r) => r.available === true) : rows;
    }
  }));

  ctx.tools.register(defineAlphaTool({
    name: "dispatch_task",
    description: "把任务派发给某个 Agent 并立即返回持久化 taskId；随后调用 wait_task 等待完成。",
    parameters: {
      agentId: {
        type: "string",
        description: "目标 agent ID（来自 list_agents，可选；但界面已选择工作机或工作区时，以界面选择范围为准，不会绕过已选 Worker）。"
      },
      prompt: {
        type: "string",
        required: true,
        description: "派发给该 agent 的任务文本（原样传给远端 agent 的 LLM）。"
      },
      workspaceId: {
        type: "string",
        description: "全局逻辑工作区 ID（来自 list_workspaces）。界面已选择时可省略；未选择但任务涉及项目时应明确传入。"
      },
      projectPath: {
        type: "string",
        description: "工作目录（可选，默认主控当前目录；远端按各自 allowed roots 校验）。"
      },
      repoUrl: {
        type: "string",
        description: "目标 repo URL（可选）：优先派给持有该 repo 的机器（repo 身份选机）；若无人持有且允许按需 clone，则落到最空闲机器由远端按需 clone。"
      },
      model: {
        type: "string",
        description: "目标 Worker 模型（可选）；界面已选模型时以界面选择为准。"
      },
      reasoningEffort: {
        type: "string",
        description: "目标 Worker 的推理强度（可选）；界面已选强度时以界面选择为准。"
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
      },
      attachments: {
        type: "array",
        description: "可选图片附件路径；是否能处理由目标 Worker 的图片能力决定。",
        items: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    output: {
      schema: JSON_OBJECT_SCHEMA,
      render: (args, value) => [{
        type: "text",
        text: renderDispatchOutcome(value)
      }]
    },
    execute: async (args, exec) => engine.dispatch({
      agentId: args.agentId,
      workspaceId: args.workspaceId,
      sessionId: currentSessionId(exec),
      prompt: args.prompt,
      projectPath: args.projectPath,
      repoUrl: args.repoUrl,
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      mode: args.mode,
      approvalPolicy: args.approvalPolicy,
      attachments: args.attachments
    })
  }));

  ctx.tools.register(defineAlphaTool({
    name: "wait_task",
    description: "事件驱动地等待已有任务完成；等待被中断只解除当前等待，不取消 Worker 任务，可使用同一 taskId 重新等待。",
    parameters: {
      taskId: { type: "string", required: true, description: "dispatch_task 返回的持久化任务 ID。" }
    },
    output: {
      schema: JSON_OBJECT_SCHEMA,
      render: (args, value) => [{ type: "text", text: renderDispatchOutcome(value) }]
    },
    execute: async (args, exec) => engine.waitTask(args.taskId, { signal: exec?.signal })
  }));

  ctx.tools.register(defineAlphaTool({
    name: "task_status",
    description: "故障诊断用：一次性查询已有任务状态。正常流程使用 wait_task，不要轮询本工具。",
    parameters: {
      taskId: { type: "string", required: true, description: "dispatch_task 返回的 taskId。" }
    },
    output: {
      schema: JSON_OBJECT_SCHEMA,
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

  ctx.tools.register(defineAlphaTool({
    name: "task_result",
    description: "故障恢复用：重新读取已有任务已经落库的结果。正常流程使用 wait_task。",
    parameters: {
      taskId: { type: "string", required: true, description: "dispatch_task 返回的 taskId。" }
    },
    output: {
      schema: JSON_OBJECT_SCHEMA,
      render: (args, value) => [{ type: "text", text: renderTaskResult(value) }]
    },
    execute: async (args) => engine.taskResult(args.taskId)
  }));

  ctx.tools.register(defineAlphaTool({
    name: "agent_approve",
    description: "审批远端 agent 冒泡上来的权限请求（批准/拒绝/取消）。故障时默认拒绝。",
    parameters: {
      approvalId: {
        type: "string",
        required: true,
        description: "待决审批 ID（来自 wait_task 返回的 pendingApprovals）。"
      },
      decision: {
        type: "string",
        enum: ["approved", "rejected", "cancel"],
        required: true,
        description: "approved 放行 / rejected 拒绝 / cancel 取消该任务。"
      }
    },
    output: {
      schema: JSON_OBJECT_SCHEMA,
      render: (args, value) => [{ type: "text", text: value.taskId ? renderDispatchOutcome(value) : `审批 ${args.approvalId} → ${value.decision}` }]
    },
    execute: async (args) => engine.decideApprovalAndWait(args.approvalId, args.decision)
  }));

  ctx.tools.register(defineAlphaTool({
    name: "agent_cancel",
    description: "取消一个进行中的任务。",
    parameters: {
      taskId: { type: "string", required: true }
    },
    output: {
      schema: JSON_OBJECT_SCHEMA,
      render: (args, value) => [{ type: "text", text: `任务 ${args.taskId} → ${value.status}` }]
    },
    execute: async (args) => engine.cancelTask(args.taskId)
  }));
}
