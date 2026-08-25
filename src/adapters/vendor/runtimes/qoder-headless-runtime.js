const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { buildCapabilities } = require("../shared/capabilities");

// qoder --permission-mode 与 claude-code 相同（snake_case 变体）
function qoderPermissionMode(settings = {}) {
  if (settings.mode === "full-access") return "bypass_permissions";
  if (settings.mode === "auto-review") return "auto";
  if (settings.approval_policy === "never") return "dont_ask";
  return "default";
}

function qoderExecutableCandidates() {
  const binaryName = process.platform === "win32" ? "qoder.cmd" : "qoder";
  return [
    path.join(os.homedir(), ".npm-global", "bin", binaryName),
    path.join(__dirname, "..", "..", "node_modules", ".bin", binaryName)
  ];
}

function resolveQoderExecutable(pathOverride = process.env.QODER_CLI_PATH) {
  if (pathOverride) {
    const resolved = path.resolve(pathOverride);
    if (fs.existsSync(resolved)) return resolved;
    const error = new Error(`QODER_CLI_PATH 不可用：${pathOverride}`);
    error.statusCode = 500;
    throw error;
  }
  for (const candidate of qoderExecutableCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "qoder";
}

function buildQoderArgs({ runtimeSessionId, message, settings = {} }) {
  const args = [
    "--print",
    message || "",
    "--output-format", "stream-json",
    "--permission-mode", qoderPermissionMode(settings)
  ];
  if (runtimeSessionId) {
    args.push("--resume", runtimeSessionId);
  }
  if (settings.model) {
    args.push("--model", settings.model);
  }
  if (settings.reasoning_effort) {
    args.push("--reasoning-effort", settings.reasoning_effort);
  }
  return args;
}

function configuredQoderModels() {
  return String(process.env.QODER_MODELS || process.env.DSH_ALPHA_QODER_MODELS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function renderValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(renderValue).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) return renderValue(value.content);
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  return String(value);
}

// qoder stream-json 与 claude stream-json 格式兼容
function convertQoderEvent(message, state = {}) {
  if (!message || typeof message !== "object") return [];

  const events = [];

  const sessionId = message.session_id || message.sessionId || null;
  if (sessionId && !state.seenSessionIds?.has(sessionId)) {
    if (!state.seenSessionIds) state.seenSessionIds = new Set();
    state.seenSessionIds.add(sessionId);
    events.push({ type: "runtime_session", payload: { runtime_session_id: sessionId, working_directory: state.workingDirectory || "" } });
  }

  if (message.type === "system") {
    if (message.subtype === "init") {
      return events.length ? events : [{ type: "activity", payload: { message: "Qoder 初始化完成", kind: "status" } }];
    }
    return events;
  }

  if (message.type === "stream_event") {
    const event = message.event || {};
    if (event.type === "content_block_delta") {
      const delta = event.delta || {};
      if (delta.type === "text_delta" && delta.text) {
        state.emittedText = true;
        events.push({ type: "delta", payload: { text: delta.text } });
      }
    } else if (event.type === "content_block_start") {
      const block = event.content_block || {};
      if (block.type === "tool_use") {
        state.currentToolUseId = block.id || null;
        events.push({ type: "tool_use", payload: { tool_name: block.name || "tool", tool_input: block.input || {}, tool_use_id: block.id || null } });
      }
    }
    return events;
  }

  if (message.type === "assistant") {
    for (const block of message.message?.content || message.content || []) {
      if (block?.type === "text" && block.text && !state.emittedText) {
        state.emittedText = true;
        events.push({ type: "delta", payload: { text: block.text } });
      } else if (block?.type === "tool_use") {
        events.push({ type: "tool_use", payload: { tool_name: block.name || "tool", tool_input: block.input || {}, tool_use_id: block.id || null } });
      }
    }
    return events;
  }

  if (message.type === "result") {
    const usage = message.usage || message.total_usage;
    if (usage) events.push({ type: "usage", payload: { usage } });
    if (message.subtype && message.subtype !== "success") {
      events.push({ type: "error", payload: { message: message.error || message.subtype } });
    } else if (message.result && !state.emittedText) {
      state.emittedText = true;
      events.push({ type: "delta", payload: { text: String(message.result) } });
    }
    return events;
  }

  if (message.type === "error") {
    events.push({ type: "error", payload: { message: message.message || "Qoder 执行失败" } });
    return events;
  }

  return events;
}

class QoderRuntime {
  static activeSessions = new Map();

  constructor({ pathOverride, provider = "qoder" } = {}) {
    this.provider = provider;
    this.pathOverride = pathOverride || process.env.QODER_CLI_PATH || undefined;
  }

  async *run({ session, project, message, settings = {} } = {}) {
    const qoderPath = resolveQoderExecutable(this.pathOverride);
    const args = buildQoderArgs({ runtimeSessionId: session?.runtime_session_id, message, settings });
    const spawnEnv = { ...process.env };
    if (project?.path) spawnEnv.PWD = project.path;

    yield { type: "activity", payload: { message: `启动 Qoder：${project?.path || ""}`, kind: "status" } };

    const child = spawn(qoderPath, args, {
      cwd: project?.path || process.cwd(),
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (session?.id) QoderRuntime.activeSessions.set(session.id, child);

    const state = {};
    const rl = readline.createInterface({ input: child.stdout });
    const events = [];
    let exitCode = null;
    let stderrText = "";

    child.stderr?.on("data", (chunk) => { stderrText += String(chunk); });
    child.on("exit", (code) => { exitCode = code; });

    try {
      for await (const line of rl) {
        const text = line.trim();
        if (!text) continue;
        let obj;
        try { obj = JSON.parse(text); } catch { continue; }
        for (const event of convertQoderEvent(obj, state)) {
          yield event;
        }
      }

      if (exitCode !== 0 && exitCode !== null) {
        yield { type: "error", payload: { message: stderrText.trim() || `Qoder 退出码：${exitCode}` } };
        return;
      }
      yield { type: "complete", payload: { message: "Qoder 执行完成。" } };
    } catch (error) {
      yield { type: "error", payload: { message: error.message || "Qoder 执行失败" } };
    } finally {
      rl.close();
      if (!child.killed) child.kill();
      if (session?.id) QoderRuntime.activeSessions.delete(session.id);
    }
  }

  async discoverCapabilities() {
    const models = configuredQoderModels();
    return buildCapabilities(this.provider, {
      models,
      default_model: models[0] || null
    });
  }

  async cancelTurn({ session } = {}) {
    const child = session?.id ? QoderRuntime.activeSessions.get(session.id) : null;
    if (!child) {
      const error = new Error("没有可取消的 Qoder turn。");
      error.statusCode = 409;
      throw error;
    }
    child.kill("SIGTERM");
    return {};
  }
}

module.exports = {
  QoderRuntime,
  buildQoderArgs,
  convertQoderEvent,
  qoderExecutableCandidates,
  resolveQoderExecutable
};
