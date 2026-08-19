const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { buildCapabilities } = require("../shared/capabilities");

const APPROVAL_MCP_SERVER_KEY = "agent_anywhere";
const APPROVAL_PROMPT_TOOL = `mcp__${APPROVAL_MCP_SERVER_KEY}__approval_prompt`;
const APPROVAL_MCP_SERVER_SCRIPT = path.join(__dirname, "claude-approval-mcp-server.js");
const DISPATCH_MCP_SERVER_KEY = "agent_anywhere_dispatch";
const DISPATCH_MCP_SERVER_SCRIPT = path.join(__dirname, "agent-dispatch-mcp-server.js");

const DEFAULT_CLAUDE_MODELS = [
  "sonnet",
  "opus",
  "claude-sonnet-4-6",
  "claude-opus-4-5"
];
const DEFAULT_CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh"];

function claudeExecutableCandidates() {
  const binaryName = process.platform === "win32" ? "claude.cmd" : "claude";
  return [
    path.join(__dirname, "..", "..", "node_modules", ".bin", binaryName),
    path.join(os.homedir(), ".claude", "local", binaryName)
  ];
}

function resolveClaudeExecutable(claudePathOverride = process.env.CLAUDE_CODE_CLI_PATH || process.env.CLAUDE_CLI_PATH) {
  if (claudePathOverride) {
    const resolved = path.resolve(claudePathOverride);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    const error = new Error(`CLAUDE_CODE_CLI_PATH 不可用：${claudePathOverride}`);
    error.statusCode = 500;
    throw error;
  }

  for (const candidate of claudeExecutableCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "claude";
}

function claudePermissionMode(settings = {}) {
  if (settings.mode === "full-access") {
    return "bypassPermissions";
  }
  if (settings.mode === "auto-review") {
    return "auto";
  }
  if (settings.approval_policy === "never") {
    return "dontAsk";
  }
  return "default";
}

function normalizeClaudeEffort(effort) {
  if (effort === "xhigh") {
    return "max";
  }
  return effort || "medium";
}

function buildClaudePrompt(message, attachments = []) {
  const imagePaths = (attachments || [])
    .filter((attachment) => attachment?.path)
    .map((attachment) => String(attachment.path));
  if (!imagePaths.length) {
    return String(message || "");
  }
  return `${String(message || "")}\n\n附件图片路径：\n${imagePaths.map((imagePath) => `- ${imagePath}`).join("\n")}`;
}

function shouldBridgeApprovals({ requestApproval, settings = {} } = {}) {
  if (typeof requestApproval !== "function") {
    return false;
  }
  return !["bypassPermissions", "dontAsk"].includes(claudePermissionMode(settings));
}

function buildClaudeArgs({ runtimeSessionId, message, attachments = [], settings = {}, approvalBridge = null }) {
  const args = [
    "-p",
    buildClaudePrompt(message, attachments),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    claudePermissionMode(settings)
  ];

  if (approvalBridge) {
    args.push("--mcp-config", approvalBridge.mcpConfigPath);
    if (approvalBridge.approvalEnabled !== false) {
      args.push("--permission-prompt-tool", APPROVAL_PROMPT_TOOL);
    }
  }
  if (runtimeSessionId) {
    args.push("--resume", runtimeSessionId);
  }
  if (settings.model) {
    args.push("--model", settings.model);
  }
  if (settings.reasoning_effort) {
    args.push("--effort", normalizeClaudeEffort(settings.reasoning_effort));
  }

  const imagePaths = (attachments || [])
    .filter((attachment) => attachment?.path)
    .map((attachment) => String(attachment.path));
  if (imagePaths.length) {
    args.push("--add-dir", ...uniqueDirectories(imagePaths));
  }

  return args;
}

function uniqueDirectories(files) {
  const dirs = [];
  for (const file of files) {
    const dir = path.dirname(file);
    if (!dirs.includes(dir)) {
      dirs.push(dir);
    }
  }
  return dirs;
}

function parseClaudeJsonLines(buffer, onObject) {
  const lines = String(buffer || "").split(/\r?\n/);
  const rest = lines.pop() || "";
  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    onObject(JSON.parse(text));
  }
  return rest;
}

function renderValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (Array.isArray(value.content)) {
      return renderValue(value.content);
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function usageFromClaudeResult(message = {}) {
  return message.usage || message.total_usage || message.cost_usd !== undefined || message.total_cost_usd !== undefined
    ? {
        usage: message.usage || message.total_usage || null,
        cost_usd: message.cost_usd ?? message.total_cost_usd ?? null
      }
    : null;
}

function extractSessionId(message = {}) {
  return message.session_id || message.sessionId || message.session?.id || null;
}

function toolInputFromBlock(block = {}) {
  return block.input || block.parameters || {};
}

function convertClaudeStreamEvent(message, state = {}) {
  const event = message.event || {};
  const eventType = event.type;

  if (eventType === "content_block_start") {
    const block = event.content_block || {};
    if (block.type === "tool_use") {
      state.currentToolUseId = block.id || null;
      state.currentToolInput = "";
      if (!state.seenToolUseIds) {
        state.seenToolUseIds = new Set();
      }
      if (block.id) {
        state.seenToolUseIds.add(block.id);
      }
      return [{
        type: "tool_use",
        payload: {
          tool_name: block.name || "tool",
          tool_input: toolInputFromBlock(block),
          tool_use_id: block.id || null
        }
      }];
    }
  }

  if (eventType === "content_block_delta") {
    const delta = event.delta || {};
    if (delta.type === "text_delta" && delta.text) {
      state.emittedText = true;
      return [{ type: "delta", payload: { text: delta.text } }];
    }
    if (delta.type === "input_json_delta" && state.currentToolUseId) {
      state.currentToolInput = `${state.currentToolInput || ""}${delta.partial_json || ""}`;
      return [];
    }
  }

  if (eventType === "content_block_stop" && state.currentToolUseId) {
    const content = state.currentToolInput || "";
    const toolUseId = state.currentToolUseId;
    state.currentToolUseId = null;
    state.currentToolInput = "";
    if (content) {
      return [{
        type: "activity",
        payload: {
          message: `工具参数：${content}`,
          kind: "tool_progress",
          tool_use_id: toolUseId
        }
      }];
    }
  }

  if (eventType === "message_delta" && event.usage) {
    return [{ type: "usage", payload: { usage: event.usage } }];
  }

  return [];
}

function convertClaudeAssistantMessage(message = {}, state = {}) {
  const events = [];
  for (const block of message.message?.content || message.content || []) {
    if (block?.type === "text" && block.text && !state.emittedText) {
      state.emittedText = true;
      events.push({ type: "delta", payload: { text: block.text } });
    } else if (block?.type === "tool_use" && !state.seenToolUseIds?.has(block.id)) {
      if (!state.seenToolUseIds) {
        state.seenToolUseIds = new Set();
      }
      if (block.id) {
        state.seenToolUseIds.add(block.id);
      }
      events.push({
        type: "tool_use",
        payload: {
          tool_name: block.name || "tool",
          tool_input: toolInputFromBlock(block),
          tool_use_id: block.id || null
        }
      });
    } else if (block?.type === "tool_result") {
      events.push({
        type: "tool_result",
        payload: {
          tool_use_id: block.tool_use_id || null,
          content: renderValue(block.content),
          is_error: Boolean(block.is_error)
        }
      });
    }
  }
  return events;
}

function convertClaudeEvent(message, state = {}) {
  if (!message || typeof message !== "object") {
    return [];
  }

  const events = [];
  const sessionId = extractSessionId(message);
  if (sessionId && !state.seenSessionIds?.has(sessionId)) {
    if (!state.seenSessionIds) {
      state.seenSessionIds = new Set();
    }
    state.seenSessionIds.add(sessionId);
    events.push({
      type: "runtime_session",
      payload: {
        runtime_session_id: sessionId,
        working_directory: state.workingDirectory || ""
      }
    });
  }

  if (message.type === "system") {
    if (message.subtype === "init") {
      return events.length ? events : [{ type: "activity", payload: { message: "Claude Code 初始化完成", kind: "status" } }];
    }
    if (message.subtype === "api_retry") {
      events.push({
        type: "activity",
        payload: {
          message: `Claude Code API 重试 ${message.attempt || "?"}/${message.max_retries || "?"}`,
          kind: "status"
        }
      });
      return events;
    }
    return events;
  }

  if (message.type === "stream_event") {
    events.push(...convertClaudeStreamEvent(message, state));
    return events;
  }

  if (message.type === "assistant") {
    events.push(...convertClaudeAssistantMessage(message, state));
    return events;
  }

  if (message.type === "result") {
    const usage = usageFromClaudeResult(message);
    if (usage) {
      events.push({ type: "usage", payload: usage });
    }
    if (message.subtype && message.subtype !== "success") {
      events.push({ type: "error", payload: { message: message.error || message.subtype } });
    } else if (message.result && !state.emittedText) {
      state.emittedText = true;
      events.push({ type: "delta", payload: { text: String(message.result) } });
    }
    return events;
  }

  if (message.type === "error") {
    events.push({ type: "error", payload: { message: message.message || "Claude Code 执行失败" } });
    return events;
  }

  return events;
}

function approvalSocketPath() {
  const token = randomUUID().slice(0, 13);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\agent-anywhere-approval-${token}`;
  }
  return path.join(os.tmpdir(), `aa-approval-${token}.sock`);
}

function describeToolPermission(request = {}) {
  let inputText = "";
  try {
    inputText = JSON.stringify(request.input ?? {});
  } catch {
    inputText = String(request.input);
  }
  if (inputText.length > 500) {
    inputText = `${inputText.slice(0, 500)}…`;
  }
  return `Claude 请求使用工具 ${request.tool_name || "tool"}：${inputText}`;
}

function dispatchMcpServerEnv({ session, env = process.env } = {}) {
  const controlUrl = String(env.AGENT_ANYWHERE_CONTROL_URL || "").trim();
  if (!controlUrl || !session?.id) {
    return null;
  }
  return {
    AGENT_ANYWHERE_CONTROL_URL: controlUrl,
    AGENT_ANYWHERE_GATEWAY_TOKEN: env.AGENT_ANYWHERE_GATEWAY_TOKEN || "",
    AGENT_ANYWHERE_PARENT_SESSION_ID: String(session.id)
  };
}

async function createApprovalBridge({
  requestApproval,
  settings = {},
  session = null,
  fsImpl = fs,
  netImpl = net,
  env = process.env
} = {}) {
  const approvalEnabled = shouldBridgeApprovals({ requestApproval, settings });
  const dispatchEnv = dispatchMcpServerEnv({ session, env });
  if (!approvalEnabled && !dispatchEnv) {
    return null;
  }
  let server = null;
  let socketPath = null;
  if (approvalEnabled) {
    ({ server, socketPath } = await createApprovalSocketServer({ requestApproval, netImpl }));
  }

  const servers = {};
  if (socketPath) {
    servers[APPROVAL_MCP_SERVER_KEY] = {
      command: process.execPath,
      args: [APPROVAL_MCP_SERVER_SCRIPT],
      env: { AGENT_ANYWHERE_APPROVAL_SOCKET: socketPath }
    };
  }
  if (dispatchEnv) {
    servers[DISPATCH_MCP_SERVER_KEY] = {
      command: process.execPath,
      args: [DISPATCH_MCP_SERVER_SCRIPT],
      env: dispatchEnv
    };
  }
  const mcpConfigPath = path.join(os.tmpdir(), `aa-approval-mcp-${randomUUID().slice(0, 13)}.json`);
  fsImpl.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: servers }));

  return {
    approvalEnabled,
    dispatchEnabled: Boolean(dispatchEnv),
    socketPath,
    mcpConfigPath,
    close() {
      server?.close();
      try {
        fsImpl.unlinkSync(mcpConfigPath);
      } catch {
        // Best effort cleanup.
      }
      if (socketPath && process.platform !== "win32") {
        try {
          fsImpl.unlinkSync(socketPath);
        } catch {
          // Socket file may already be gone.
        }
      }
    }
  };
}

async function createApprovalSocketServer({ requestApproval, netImpl = net } = {}) {
  const socketPath = approvalSocketPath();
  const server = netImpl.createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let reply;
      try {
        const request = JSON.parse(line);
        const decision = await requestApproval({
          kind: "tool_permission",
          command: describeToolPermission(request),
          tool_name: request.tool_name || "tool",
          tool_input: request.input || {},
          tool_use_id: request.tool_use_id || null,
          available_decisions: ["approved", "rejected"],
          raw: request
        });
        reply = decision?.decision === "approved"
          ? { behavior: "allow", updatedInput: request.input || {} }
          : { behavior: "deny", message: "用户拒绝了该操作。" };
      } catch (error) {
        reply = { behavior: "deny", message: `审批失败：${error.message}` };
      }
      try {
        socket.write(`${JSON.stringify(reply)}\n`);
      } catch {
        // The MCP server may have given up waiting; nothing else to do.
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { server, socketPath };
}

class AsyncEventQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;
  }

  push(item) {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  fail(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  complete() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true });
    }
  }

  next() {
    if (this.items.length) {
      return Promise.resolve({ value: this.items.shift(), done: false });
    }
    if (this.error) {
      return Promise.reject(this.error);
    }
    if (this.closed) {
      return Promise.resolve({ done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

class ClaudeCodeHeadlessRuntime {
  static activeProcesses = new Map();

  constructor({ claudePathOverride, cliPath, spawnImpl = spawn, provider = "claude-code" } = {}) {
    this.provider = provider;
    this.claudePathOverride = claudePathOverride || cliPath || process.env.CLAUDE_CODE_CLI_PATH || process.env.CLAUDE_CLI_PATH || undefined;
    this.spawnImpl = spawnImpl;
  }

  async *run({ session, project, message, attachments = [], settings = {}, requestApproval } = {}) {
    const claudePath = resolveClaudeExecutable(this.claudePathOverride);
    const approvalBridge = await createApprovalBridge({ requestApproval, settings, session });
    const args = buildClaudeArgs({
      runtimeSessionId: session?.runtime_session_id,
      message,
      attachments,
      settings,
      approvalBridge
    });
    const queue = new AsyncEventQueue();
    const state = {
      workingDirectory: project?.path || "",
      seenSessionIds: new Set()
    };
    const child = this.spawnImpl(claudePath, args, {
      cwd: project?.path || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdoutRest = "";
    let stderrText = "";

    const activeEntry = { child, cancelled: false };
    if (session?.id) {
      ClaudeCodeHeadlessRuntime.activeProcesses.set(session.id, activeEntry);
    }

    child.stdout.on("data", (chunk) => {
      try {
        stdoutRest = parseClaudeJsonLines(`${stdoutRest}${chunk}`, (event) => {
          for (const normalized of convertClaudeEvent(event, state)) {
            queue.push(normalized);
          }
        });
      } catch (error) {
        queue.fail(new Error(`Claude Code 输出不是合法 JSON：${error.message}`));
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrText += String(chunk);
      if (stderrText.length > 8000) {
        stderrText = stderrText.slice(-8000);
      }
    });

    child.on("error", (error) => queue.fail(error));
    child.on("close", (code, signal) => {
      try {
        const rest = stdoutRest.trim();
        if (rest) {
          const event = JSON.parse(rest);
          for (const normalized of convertClaudeEvent(event, state)) {
            queue.push(normalized);
          }
        }
      } catch (error) {
        queue.fail(new Error(`Claude Code 输出不是合法 JSON：${error.message}`));
        return;
      }
      if (activeEntry.cancelled) {
        queue.push({
          type: "cancelled",
          payload: { message: "Claude Code 已取消。" }
        });
        queue.complete();
        return;
      }
      if (signal) {
        queue.fail(new Error(`Claude Code 执行被信号中断：${signal}`));
        return;
      }
      if (code && code !== 0) {
        const suffix = stderrText.trim() || `退出码 ${code}${signal ? `，信号 ${signal}` : ""}`;
        queue.fail(new Error(`Claude Code 执行失败：${suffix}`));
        return;
      }
      queue.complete();
    });

    yield {
      type: "activity",
      payload: {
        message: `启动 Claude Code：${project?.path || ""}`,
        kind: "status"
      }
    };

    try {
      for await (const event of queue) {
        yield event;
      }
      yield {
        type: "complete",
        payload: {
          message: "Claude Code 执行完成。"
        }
      };
    } finally {
      if (session?.id) {
        ClaudeCodeHeadlessRuntime.activeProcesses.delete(session.id);
      }
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
      approvalBridge?.close();
    }
  }

  async discoverCapabilities() {
    return buildCapabilities(this.provider, {
      models: DEFAULT_CLAUDE_MODELS,
      default_model: "sonnet",
      input_modalities: ["text", "local_image"],
      reasoning_efforts: DEFAULT_CLAUDE_EFFORTS
    });
  }

  async cancelTurn({ session } = {}) {
    const active = session?.id ? ClaudeCodeHeadlessRuntime.activeProcesses.get(session.id) : null;
    if (!active) {
      const error = new Error("没有可取消的 Claude Code turn。");
      error.statusCode = 409;
      throw error;
    }
    active.cancelled = true;
    active.child.kill("SIGTERM");
    return {};
  }
}

module.exports = {
  APPROVAL_PROMPT_TOOL,
  DISPATCH_MCP_SERVER_KEY,
  ClaudeCodeHeadlessRuntime,
  buildClaudeArgs,
  buildClaudePrompt,
  claudeExecutableCandidates,
  claudePermissionMode,
  convertClaudeEvent,
  createApprovalBridge,
  dispatchMcpServerEnv,
  normalizeClaudeEffort,
  parseClaudeJsonLines,
  resolveClaudeExecutable,
  shouldBridgeApprovals
};
