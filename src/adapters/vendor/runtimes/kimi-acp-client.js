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
    clientInfo = DEFAULT_CLIENT_INFO
  } = {}) {
    super();
    this.kimiPathOverride = kimiPathOverride || process.env.KIMI_CODE_CLI_PATH || process.env.KIMI_CLI_PATH || undefined;
    this.spawnImpl = spawnImpl;
    this.clientInfo = clientInfo;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.process = null;
    this.reader = null;
    this.closed = false;
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
      clientCapabilities: {}
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
  KimiAcpClient,
  kimiExecutableCandidates,
  resolveKimiExecutable
};
