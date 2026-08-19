const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { EventEmitter } = require("node:events");
const { resolveCodexExecutable } = require("./codex-runtime");

const DEFAULT_CLIENT_INFO = {
  name: "agent_anywhere",
  title: "Agent Anywhere",
  version: "0.1.0"
};

class CodexAppServerClient extends EventEmitter {
  constructor({
    codexPathOverride,
    spawnImpl = spawn,
    clientInfo = DEFAULT_CLIENT_INFO
  } = {}) {
    super();
    this.codexPathOverride = codexPathOverride || process.env.CODEX_CLI_PATH || undefined;
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
    const codexPath = resolveCodexExecutable(this.codexPathOverride);
    this.process = this.spawnImpl(codexPath, ["app-server"], {
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"]
    });

    this.reader = readline.createInterface({ input: this.process.stdout });
    this.reader.on("line", (line) => this.handleLine(line));
    this.process.on("error", (error) => this.failPending(error));
    this.process.on("exit", (code, signal) => {
      this.closed = true;
      const suffix = signal ? `signal ${signal}` : `code ${code}`;
      this.failPending(new Error(`codex app-server 已退出：${suffix}`));
      this.emit("exit", { code, signal });
    });
  }

  async initialize() {
    this.start();
    const result = await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized", {});
    return result;
  }

  request(method, params = {}) {
    this.start();
    const id = this.nextRequestId++;
    this.write({ method, id, params });
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
    });
  }

  notify(method, params = {}) {
    this.start();
    this.write({ method, params });
  }

  respond(id, result = {}) {
    this.write({ id, result });
  }

  respondError(id, error) {
    this.write({
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
    this.failPending(new Error("codex app-server client closed"));
  }

  write(message) {
    if (!this.process || this.closed) {
      throw new Error("codex app-server client is not running");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("error", new Error(`codex app-server 输出不是合法 JSON：${error.message}`));
      return;
    }

    if (message && Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        this.emit("unknownResponse", message);
        return;
      }
      this.pendingRequests.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || `codex app-server 请求失败：${pending.method}`);
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
  CodexAppServerClient,
  DEFAULT_CLIENT_INFO
};
