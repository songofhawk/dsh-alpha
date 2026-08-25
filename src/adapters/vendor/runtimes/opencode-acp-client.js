const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_CLIENT_INFO = {
  name: "agent_anywhere",
  version: "0.1.0"
};

function opencodeExecutableCandidates() {
  const binaryName = process.platform === "win32" ? "opencode.cmd" : "opencode";
  return [
    "/opt/homebrew/bin/opencode",
    path.join(os.homedir(), ".local", "bin", binaryName),
    path.join(__dirname, "..", "..", "node_modules", ".bin", binaryName)
  ];
}

function resolveOpenCodeExecutable(pathOverride = process.env.OPENCODE_CLI_PATH) {
  if (pathOverride) {
    const resolved = path.resolve(pathOverride);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    const error = new Error(`OPENCODE_CLI_PATH 不可用：${pathOverride}`);
    error.statusCode = 500;
    throw error;
  }

  for (const candidate of opencodeExecutableCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "opencode";
}

/**
 * opencode acp 的 JSON-RPC stdio 客户端（ACP = Agent Client Protocol）。
 * 协议结构与 kimi acp 一致：initialize / session/new / session/load /
 * session/prompt / session/cancel / session/close / session/list。
 */
class OpenCodeAcpClient extends EventEmitter {
  constructor({
    pathOverride,
    spawnImpl = spawn,
    clientInfo = DEFAULT_CLIENT_INFO
  } = {}) {
    super();
    this.pathOverride = pathOverride || process.env.OPENCODE_CLI_PATH || undefined;
    this.spawnImpl = spawnImpl;
    this.clientInfo = clientInfo;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.process = null;
    this.reader = null;
    this.closed = false;
  }

  start() {
    if (this.process) return;
    const execPath = resolveOpenCodeExecutable(this.pathOverride);
    this.process = this.spawnImpl(execPath, ["acp"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.reader = readline.createInterface({ input: this.process.stdout });
    this.reader.on("line", (line) => this.handleLine(line));
    this.process.on("error", (error) => this.failPending(error));
    this.process.on("exit", (code, signal) => {
      this.closed = true;
      const suffix = signal ? `signal ${signal}` : `code ${code}`;
      this.failPending(new Error(`opencode acp 已退出：${suffix}`));
      this.emit("exit", { code, signal });
    });
  }

  async initialize() {
    this.start();
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {}
    });
  }

  request(method, params = {}) {
    this.start();
    const id = String(this.nextRequestId++);
    const promise = new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
    });
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
    this.reader?.close();
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.failPending(new Error("opencode acp client closed"));
  }

  write(message) {
    if (!this.process || this.closed) {
      throw new Error("opencode acp client is not running");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("error", new Error(`opencode acp 输出不是合法 JSON：${error.message}`));
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
        const error = new Error(message.error.message || `opencode acp 请求失败：${pending.method}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message && Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
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
}

module.exports = {
  DEFAULT_CLIENT_INFO,
  OpenCodeAcpClient,
  opencodeExecutableCandidates,
  resolveOpenCodeExecutable
};
