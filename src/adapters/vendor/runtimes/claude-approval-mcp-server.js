#!/usr/bin/env node
// Stdio MCP server used as `claude -p --permission-prompt-tool` target.
// Each tools/call is forwarded over a local socket to the Agent Anywhere
// runtime, which raises an approval_request and returns the user decision.

const net = require("node:net");

const APPROVAL_TOOL_NAME = "approval_prompt";
const SERVER_INFO = { name: "agent-anywhere-approval", version: "1.0.0" };
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

function denyResult(message) {
  return { behavior: "deny", message: message || "Agent Anywhere 审批不可用，已拒绝。" };
}

function requestApprovalDecision(payload, {
  socketPath = process.env.AGENT_ANYWHERE_APPROVAL_SOCKET,
  timeoutMs = APPROVAL_TIMEOUT_MS
} = {}) {
  return new Promise((resolve) => {
    if (!socketPath) {
      resolve(denyResult("缺少审批 socket 配置。"));
      return;
    }
    const socket = net.connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(denyResult("审批等待超时，已拒绝。")), timeoutMs);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      try {
        finish(JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(denyResult("审批响应不是合法 JSON。"));
      }
    });
    socket.on("error", (error) => finish(denyResult(`审批通道错误：${error.message}`)));
    socket.on("close", () => finish(denyResult("审批通道已关闭。")));
  });
}

async function handleMcpMessage(message, { requestDecision = requestApprovalDecision } = {}) {
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
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: APPROVAL_TOOL_NAME,
          description: "把 Claude Code 权限请求转发给 Agent Anywhere 审批。",
          inputSchema: {
            type: "object",
            properties: {
              tool_name: { type: "string" },
              input: { type: "object" },
              tool_use_id: { type: "string" }
            },
            required: ["tool_name", "input"]
          }
        }]
      }
    };
  }
  if (message.method === "tools/call") {
    const args = message.params?.arguments || {};
    let decision;
    if (message.params?.name !== APPROVAL_TOOL_NAME) {
      decision = denyResult(`未知审批工具：${message.params?.name}`);
    } else {
      decision = await requestDecision({
        tool_name: args.tool_name || "tool",
        input: args.input || {},
        tool_use_id: args.tool_use_id || null
      });
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(decision) }]
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
  APPROVAL_TOOL_NAME,
  handleMcpMessage,
  requestApprovalDecision
};
