#!/usr/bin/env node
// Stdio MCP server injected into agent runtimes. It exposes cross-machine
// dispatch tools that forward to the Agent Anywhere Control Server API.

const SERVER_INFO = { name: "agent-anywhere-dispatch", version: "1.0.0" };

function dispatchEnvironment(env = process.env) {
  return {
    controlUrl: String(env.AGENT_ANYWHERE_CONTROL_URL || "").replace(/\/+$/, ""),
    token: env.AGENT_ANYWHERE_GATEWAY_TOKEN || "",
    parentSessionId: env.AGENT_ANYWHERE_PARENT_SESSION_ID || ""
  };
}

const DISPATCH_TOOLS = [
  {
    name: "list_machines",
    description: "列出 Agent Anywhere 中的机器：在线状态、providers、拥有的 repos 和当前负载。",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "dispatch_task",
    description: "把一个子任务派发到拥有指定 repo 的机器上执行（异步）。返回 session_id，用 task_status / task_result 跟进。",
    inputSchema: {
      type: "object",
      properties: {
        repo_url: { type: "string", description: "目标 repo，如 github.com/me/demo" },
        prompt: { type: "string", description: "子任务的完整指令，需自包含" },
        machine_id: { type: "string", description: "可选，指定机器；缺省自动调度" },
        provider: { type: "string", description: "可选，子会话 provider" },
        mode: { type: "string", description: "可选，子会话模式" }
      },
      required: ["repo_url", "prompt"]
    }
  },
  {
    name: "task_status",
    description: "查询已派发子任务的运行状态、待审批数量和最近事件。",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"]
    }
  },
  {
    name: "task_result",
    description: "读取已派发子任务的最终回复文本（未完成时返回运行状态）。",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"]
    }
  }
];

async function callControlApi(toolName, args, {
  environment = dispatchEnvironment(),
  fetchImpl = fetch
} = {}) {
  if (!environment.controlUrl) {
    return { error: "缺少 AGENT_ANYWHERE_CONTROL_URL，dispatch 工具不可用。" };
  }
  const headers = {
    "Content-Type": "application/json",
    "x-agent-anywhere-gateway-token": environment.token
  };
  let response;
  if (toolName === "list_machines") {
    response = await fetchImpl(`${environment.controlUrl}/api/machines`, { headers });
  } else if (toolName === "dispatch_task") {
    response = await fetchImpl(`${environment.controlUrl}/api/dispatch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        parent_session_id: environment.parentSessionId,
        repo_url: args.repo_url,
        prompt: args.prompt,
        machine_id: args.machine_id,
        provider: args.provider,
        mode: args.mode
      })
    });
  } else if (toolName === "task_status" || toolName === "task_result") {
    const kind = toolName === "task_status" ? "status" : "result";
    response = await fetchImpl(
      `${environment.controlUrl}/api/dispatch/${encodeURIComponent(String(args.session_id || ""))}/${kind}`,
      { headers }
    );
  } else {
    return { error: `未知 dispatch 工具：${toolName}` };
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { error: payload.error || `dispatch 请求失败（HTTP ${response.status}）`, details: payload.details };
  }
  return payload;
}

async function handleMcpMessage(message, options = {}) {
  if (!message || message.jsonrpc !== "2.0") {
    return null;
  }
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      }
    };
  }
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: { tools: DISPATCH_TOOLS } };
  }
  if (message.method === "tools/call") {
    const toolName = message.params?.name;
    const args = message.params?.arguments || {};
    let payload;
    try {
      payload = await callControlApi(toolName, args, options);
    } catch (error) {
      payload = { error: `dispatch 调用异常：${error.message}` };
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        ...(payload?.error ? { isError: true } : {})
      }
    };
  }
  if (message.id !== undefined && message.id !== null) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `不支持的方法：${message.method}` }
    };
  }
  return null;
}

function main() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      handleMcpMessage(message).then((response) => {
        if (response) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      }).catch(() => {});
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (require.main === module) {
  main();
}

module.exports = {
  DISPATCH_TOOLS,
  callControlApi,
  dispatchEnvironment,
  handleMcpMessage
};
