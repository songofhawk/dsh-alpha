const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TERMINAL_METHODS = new Set([
  "terminal/create",
  "terminal/output",
  "terminal/wait_for_exit",
  "terminal/kill",
  "terminal/release"
]);
const DEFAULT_TERMINAL_OUTPUT_LIMIT = 4 * 1024 * 1024;
const MAX_TERMINAL_OUTPUT_LIMIT = 16 * 1024 * 1024;

const DEFAULT_CLIENT_INFO = {
  name: "agent_anywhere",
  version: "0.1.0"
};

function kimiExecutableCandidates() {
  const binaryName = process.platform === "win32" ? "kimi.cmd" : "kimi";
  return [
    path.join(os.homedir(), ".kimi-code", "bin", binaryName),
    path.join(__dirname, "..", "..", "node_modules", ".bin", binaryName)
  ];
}

function resolveKimiExecutable(kimiPathOverride = process.env.KIMI_CODE_CLI_PATH || process.env.KIMI_CLI_PATH) {
  if (kimiPathOverride) {
    const resolved = path.resolve(kimiPathOverride);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    const error = new Error(`KIMI_CODE_CLI_PATH 不可用：${kimiPathOverride}`);
    error.statusCode = 500;
    throw error;
  }

  for (const candidate of kimiExecutableCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "kimi";
}

/**
 * kimi acp 的 JSON-RPC stdio 客户端。
 *
 * 与 codex app-server 类似，kimi acp 在 stdin/stdout 上走 JSON-RPC 2.0：
 * - client -> agent：initialize / session/new / session/load / session/resume /
 *   session/prompt / session/cancel / session/close / session/list /
 *   session/set_config_option
 * - agent -> client 反向 request：session/request_permission（工具审批）、
 *   fs/read_text_file、fs/write_text_file 等，需通过 respond/respondError 回复
 * - agent -> client notification：session/update（agent_message_chunk、
 *   tool_call、tool_call_update、usage_update、plan 等）
 */
class KimiAcpClient extends EventEmitter {
  constructor({
    kimiPathOverride,
    spawnImpl = spawn,
    terminalSpawnImpl = spawn,
    terminalCwd = process.cwd(),
    clientInfo = DEFAULT_CLIENT_INFO
  } = {}) {
    super();
    this.kimiPathOverride = kimiPathOverride || process.env.KIMI_CODE_CLI_PATH || process.env.KIMI_CLI_PATH || undefined;
    this.spawnImpl = spawnImpl;
    this.terminalSpawnImpl = terminalSpawnImpl;
    this.terminalCwd = path.resolve(terminalCwd);
    this.clientInfo = clientInfo;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.process = null;
    this.reader = null;
    this.closed = false;
    this.terminals = new Map();
    this.nextTerminalId = 1;
  }

  start() {
    if (this.process) {
      return;
    }
    const kimiPath = resolveKimiExecutable(this.kimiPathOverride);
    this.process = this.spawnImpl(kimiPath, ["acp"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.reader = readline.createInterface({ input: this.process.stdout });
    this.reader.on("line", (line) => this.handleLine(line));
    this.process.on("error", (error) => this.failPending(error));
    this.process.on("exit", (code, signal) => {
      this.closed = true;
      const suffix = signal ? `signal ${signal}` : `code ${code}`;
      this.failPending(new Error(`kimi acp 已退出：${suffix}`));
      this.emit("exit", { code, signal });
    });
  }

  async initialize() {
    this.start();
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { terminal: true }
    });
    return result;
  }

  request(method, params = {}) {
    this.start();
    const id = String(this.nextRequestId++);
    const promise = new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
    });
    // 先注册 pending 再写入：mock/真实 server 可能在 stdin data 回调里同步
    // 写回响应，若 set 在 write 之后会错过同步响应。
    this.write({ jsonrpc: "2.0", method, id, params });
    return promise;
  }

  notify(method, params = {}) {
    this.start();
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id, result = {}) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, error) {
    this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code: error?.code || -32000,
        message: error?.message || String(error || "request failed")
      }
    });
  }

  close() {
    this.closed = true;
    for (const terminal of this.terminals.values()) {
      this.terminateTerminal(terminal);
    }
    this.terminals.clear();
    this.reader?.close();
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.failPending(new Error("kimi acp client closed"));
  }

  write(message) {
    if (!this.process || this.closed) {
      throw new Error("kimi acp client is not running");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("error", new Error(`kimi acp 输出不是合法 JSON：${error.message}`));
      return;
    }

    if (message && Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const pending = this.pendingRequests.get(String(message.id));
      if (!pending) {
        this.emit("unknownResponse", message);
        return;
      }
      this.pendingRequests.delete(String(message.id));
      if (message.error) {
        const error = new Error(message.error.message || `kimi acp 请求失败：${pending.method}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message && Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      if (TERMINAL_METHODS.has(message.method)) {
        this.handleTerminalRequest(message).then(
          (result) => this.respond(message.id, result),
          (error) => this.respondError(message.id, error)
        ).catch((error) => this.emit("error", error));
        return;
      }
      this.emit("request", message);
      return;
    }

    if (message?.method) {
      this.emit("notification", message);
      return;
    }

    this.emit("unknownMessage", message);
  }

  failPending(error) {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  async handleTerminalRequest(message) {
    const params = message?.params || {};
    if (message?.method === "terminal/create") {
      return this.createTerminal(params);
    }

    const terminal = this.getTerminal(params);
    if (message?.method === "terminal/output") {
      return this.terminalOutput(terminal);
    }
    if (message?.method === "terminal/wait_for_exit") {
      return terminal.exitPromise;
    }
    if (message?.method === "terminal/kill") {
      this.terminateTerminal(terminal);
      return {};
    }
    if (message?.method === "terminal/release") {
      this.terminateTerminal(terminal);
      this.terminals.delete(terminal.id);
      return {};
    }

    const error = new Error(`不支持的 ACP terminal 方法：${message?.method || "（空）"}`);
    error.code = -32601;
    throw error;
  }

  async createTerminal(params) {
    const command = String(params.command || "").trim();
    if (!command) {
      const error = new Error("terminal/create 缺少 command");
      error.code = -32602;
      throw error;
    }

    const cwd = path.resolve(params.cwd || this.terminalCwd);
    if (cwd !== this.terminalCwd && !cwd.startsWith(`${this.terminalCwd}${path.sep}`)) {
      const error = new Error(`ACP terminal cwd 越过工作区边界：${cwd}`);
      error.code = -32602;
      throw error;
    }

    const env = { ...process.env };
    for (const entry of Array.isArray(params.env) ? params.env : []) {
      if (entry && typeof entry.name === "string" && typeof entry.value === "string") {
        env[entry.name] = entry.value;
      }
    }

    const requestedLimit = Number(params.outputByteLimit);
    const outputLimit = Number.isSafeInteger(requestedLimit) && requestedLimit >= 0
      ? Math.min(requestedLimit, MAX_TERMINAL_OUTPUT_LIMIT)
      : DEFAULT_TERMINAL_OUTPUT_LIMIT;
    const id = `kimi-terminal-${this.nextTerminalId++}`;
    const detached = process.platform !== "win32";
    const child = this.terminalSpawnImpl(command, Array.isArray(params.args) ? params.args.map(String) : [], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      windowsHide: true
    });

    let resolveExit;
    const terminal = {
      id,
      sessionId: String(params.sessionId || ""),
      child,
      detached,
      output: Buffer.alloc(0),
      outputLimit,
      truncated: false,
      exitStatus: null,
      exitPromise: new Promise((resolve) => { resolveExit = resolve; }),
      resolveExit
    };
    this.terminals.set(id, terminal);

    const append = (chunk) => this.appendTerminalOutput(terminal, chunk);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("close", (code, signal) => this.finishTerminal(terminal, code, signal));

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.removeListener("error", onStartupError);
        resolve();
      };
      const onStartupError = (error) => {
        child.removeListener("spawn", onSpawn);
        this.terminals.delete(id);
        this.finishTerminal(terminal, null, null);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onStartupError);
    });

    return { terminalId: id };
  }

  getTerminal(params) {
    const id = String(params.terminalId || "");
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.sessionId !== String(params.sessionId || "")) {
      const error = new Error(`ACP terminal 不存在或不属于当前会话：${id || "（空）"}`);
      error.code = -32001;
      throw error;
    }
    return terminal;
  }

  appendTerminalOutput(terminal, chunk) {
    const next = Buffer.concat([terminal.output, Buffer.from(chunk)]);
    if (next.length <= terminal.outputLimit) {
      terminal.output = next;
      return;
    }

    terminal.truncated = true;
    if (terminal.outputLimit === 0) {
      terminal.output = Buffer.alloc(0);
      return;
    }
    let offset = next.length - terminal.outputLimit;
    while (offset < next.length && (next[offset] & 0xC0) === 0x80) {
      offset += 1;
    }
    terminal.output = next.subarray(offset);
  }

  terminalOutput(terminal) {
    return {
      output: terminal.output.toString("utf8"),
      truncated: terminal.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {})
    };
  }

  finishTerminal(terminal, code, signal) {
    if (terminal.exitStatus) {
      return;
    }
    terminal.exitStatus = {
      exitCode: Number.isInteger(code) && code >= 0 ? code : null,
      signal: signal ? String(signal) : null
    };
    terminal.resolveExit(terminal.exitStatus);
  }

  terminateTerminal(terminal) {
    if (!terminal || terminal.exitStatus) {
      return;
    }
    try {
      if (terminal.detached && Number.isInteger(terminal.child?.pid) && terminal.child.pid > 0) {
        process.kill(-terminal.child.pid, "SIGTERM");
      } else {
        terminal.child?.kill("SIGTERM");
      }
    } catch {
      try {
        terminal.child?.kill("SIGTERM");
      } catch {
        // Process already exited.
      }
    }
  }
}

module.exports = {
  DEFAULT_CLIENT_INFO,
  KimiAcpClient,
  TERMINAL_METHODS,
  kimiExecutableCandidates,
  resolveKimiExecutable
};
