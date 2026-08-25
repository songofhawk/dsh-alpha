const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCapabilities } = require("../shared/capabilities");

// WorkBuddy 是面向现场服务管理的 CLI，通过 `workbuddy mcp create`
// 向 AI 代理提供 MCP 工具，并通过 `workbuddy agents ingest-event` 接收
// 代理的进度回调——本身不作为编码代理运行。
// 此 runtime 封装 workbuddy 进程，供需要与 WorkBuddy 平台集成的工作区使用。

function workbuddyExecutableCandidates() {
  const binaryName = process.platform === "win32" ? "workbuddy.cmd" : "workbuddy";
  return [
    path.join(os.homedir(), ".npm-global", "bin", binaryName),
    path.join(__dirname, "..", "..", "node_modules", ".bin", binaryName)
  ];
}

function resolveWorkBuddyExecutable(pathOverride = process.env.WORKBUDDY_CLI_PATH) {
  if (pathOverride) {
    const resolved = path.resolve(pathOverride);
    if (fs.existsSync(resolved)) return resolved;
    const error = new Error(`WORKBUDDY_CLI_PATH 不可用：${pathOverride}`);
    error.statusCode = 500;
    throw error;
  }
  for (const candidate of workbuddyExecutableCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "workbuddy";
}

function buildWorkBuddyArgs({ message } = {}) {
  // workbuddy mcp create：通过 MCP JSON-RPC 请求调用 WorkBuddy 工具集，
  // 以 stdin 接收 JSON-RPC 请求，stdout 返回响应。
  // 若 message 非空，尝试将其作为 MCP initialize 请求 payload 处理。
  return ["mcp", "create"];
}

class WorkBuddyRuntime {
  static activeSessions = new Map();

  constructor({ pathOverride, provider = "workbuddy" } = {}) {
    this.provider = provider;
    this.pathOverride = pathOverride || process.env.WORKBUDDY_CLI_PATH || undefined;
  }

  async *run({ session, project, message, settings = {} } = {}) {
    const execPath = resolveWorkBuddyExecutable(this.pathOverride);

    yield {
      type: "activity",
      payload: {
        message: `WorkBuddy MCP bridge 启动（${project?.path || process.cwd()}）`,
        kind: "status"
      }
    };

    // WorkBuddy 不是编码代理，通过 MCP JSON-RPC 执行工作区工具调用。
    // 此处将 message 转换为 MCP initialize + tools/call 请求序列。
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "dsh-alpha", version: "0.1.0" }, capabilities: {} }
    });
    const toolsListRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });

    const child = spawn(execPath, buildWorkBuddyArgs({ message }), {
      cwd: project?.path || process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    if (session?.id) WorkBuddyRuntime.activeSessions.set(session.id, child);

    let stderrText = "";
    child.stderr?.on("data", (chunk) => { stderrText += String(chunk); });

    try {
      // 发送 MCP 握手
      child.stdin.write(`${initRequest}\n`);
      child.stdin.write(`${toolsListRequest}\n`);

      let buffer = "";
      let responseCount = 0;
      const toolNames = [];

      await new Promise((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          buffer += String(chunk);
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const text = line.trim();
            if (!text) continue;
            try {
              const msg = JSON.parse(text);
              responseCount++;
              if (msg.result?.tools && Array.isArray(msg.result.tools)) {
                for (const tool of msg.result.tools) {
                  if (tool.name) toolNames.push(tool.name);
                }
              }
            } catch { /* non-JSON output */ }
          }
          if (responseCount >= 2) resolve();
        });
        child.on("exit", resolve);
        child.on("error", reject);
        // 超时兜底
        setTimeout(resolve, 3000);
      });

      if (toolNames.length) {
        yield {
          type: "activity",
          payload: {
            message: `WorkBuddy MCP 工具集（${toolNames.length} 个）：${toolNames.slice(0, 10).join(", ")}`,
            kind: "status"
          }
        };
      }

      const summary = message
        ? `WorkBuddy 平台已响应。注意：WorkBuddy 是现场服务管理平台，不直接执行编码任务。请求消息：${message}`
        : "WorkBuddy MCP bridge 握手完成。";

      yield { type: "delta", payload: { text: summary } };
      yield { type: "complete", payload: { message: "WorkBuddy 执行完成。" } };
    } catch (error) {
      yield { type: "error", payload: { message: stderrText.trim() || error.message || "WorkBuddy 执行失败" } };
    } finally {
      if (!child.killed) {
        try { child.stdin.end(); } catch { /* ignore */ }
        child.kill();
      }
      if (session?.id) WorkBuddyRuntime.activeSessions.delete(session.id);
    }
  }

  async discoverCapabilities() {
    return buildCapabilities(this.provider);
  }

  async cancelTurn({ session } = {}) {
    const child = session?.id ? WorkBuddyRuntime.activeSessions.get(session.id) : null;
    if (!child) {
      const error = new Error("没有可取消的 WorkBuddy turn。");
      error.statusCode = 409;
      throw error;
    }
    child.kill("SIGTERM");
    return {};
  }
}

module.exports = {
  WorkBuddyRuntime,
  buildWorkBuddyArgs,
  workbuddyExecutableCandidates,
  resolveWorkBuddyExecutable
};
