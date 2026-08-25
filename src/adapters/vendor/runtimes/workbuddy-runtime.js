const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { buildCapabilities } = require("../shared/capabilities");

// 腾讯 WorkBuddy（https://www.workbuddy.ai/）是 CodeBuddy 生态中的
// 全场景 AI Agent 桌面工作台，无独立 npm 包；CLI 二进制名为 codebuddy，
// 随 WorkBuddy 桌面应用一起安装（内部包名 @genie/agent-cli）。
// 接口：codebuddy -p "..." --output-format stream-json -y
// 与 claude-code headless stream-json 格式兼容。
// 认证：登录桌面应用后 CLI 自动持有凭证；
//      或通过 CODEBUDDY_API_KEY / CODEBUDDY_AUTH_TOKEN 环境变量注入。
// 配置：WORKBUDDY_CLI_PATH 可覆盖二进制路径。

function workbuddyPermissionMode(settings = {}) {
  if (settings.mode === "full-access") return "bypassPermissions";
  if (settings.mode === "auto-review") return "auto";
  if (settings.approval_policy === "never") return "dontAsk";
  return "default";
}

function workbuddyExecutableCandidates() {
  const binaryName = process.platform === "win32" ? "codebuddy.cmd" : "codebuddy";
  const home = os.homedir();
  const appRoot = "Contents/Resources/app.asar.unpacked";
  return [
    // macOS：系统 /Applications — "WorkBuddy AI.app"（实测安装路径，cli/bin/ 子目录）
    path.join("/Applications", "WorkBuddy AI.app", appRoot, "cli", "bin", binaryName),
    // macOS：用户 ~/Applications — "WorkBuddy AI.app"
    path.join(home, "Applications", "WorkBuddy AI.app", appRoot, "cli", "bin", binaryName),
    // 旧版候选：app 名为 "WorkBuddy.app"，二进制在 sidecar/
    path.join(home, "Applications", "WorkBuddy.app", appRoot, "sidecar", binaryName),
    path.join(home, "Applications", "WorkBuddy.app", appRoot, "dist", "sidecar", binaryName),
    path.join("/Applications", "WorkBuddy.app", appRoot, "sidecar", binaryName),
    path.join("/Applications", "WorkBuddy.app", appRoot, "dist", "sidecar", binaryName),
    // 保留：用户若手动将 codebuddy 软链至 npm-global
    path.join(home, ".npm-global", "bin", binaryName)
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
  return "codebuddy";
}

function buildWorkBuddyArgs({ runtimeSessionId, message, settings = {} }) {
  const args = [
    "-p",
    message || "",
    "--output-format", "stream-json",
    "-y",
    "--permission-mode", workbuddyPermissionMode(settings)
  ];
  if (runtimeSessionId) {
    args.push("--resume", runtimeSessionId);
  }
  if (settings.model) {
    args.push("--model", settings.model);
  }
  return args;
}

// codebuddy stream-json 与 claude-code 格式兼容
function convertWorkBuddyEvent(message, state = {}) {
  if (!message || typeof message !== "object") return [];
  const events = [];

  const sessionId = message.session_id || message.sessionId || message.session?.id || null;
  if (sessionId && !state.seenSessionIds?.has(sessionId)) {
    if (!state.seenSessionIds) state.seenSessionIds = new Set();
    state.seenSessionIds.add(sessionId);
    events.push({
      type: "runtime_session",
      payload: { runtime_session_id: sessionId, working_directory: state.workingDirectory || "" }
    });
  }

  if (message.type === "system") {
    if (message.subtype === "init") {
      return events.length ? events : [{ type: "activity", payload: { message: "WorkBuddy（codebuddy）初始化完成", kind: "status" } }];
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
    events.push({ type: "error", payload: { message: message.message || "WorkBuddy 执行失败" } });
    return events;
  }

  return events;
}

class WorkBuddyRuntime {
  static activeSessions = new Map();

  constructor({ pathOverride, provider = "workbuddy" } = {}) {
    this.provider = provider;
    this.pathOverride = pathOverride || process.env.WORKBUDDY_CLI_PATH || undefined;
  }

  async *run({ session, project, message, settings = {} } = {}) {
    const execPath = resolveWorkBuddyExecutable(this.pathOverride);
    const args = buildWorkBuddyArgs({ runtimeSessionId: session?.runtime_session_id, message, settings });
    const spawnEnv = { ...process.env };
    if (project?.path) spawnEnv.PWD = project.path;

    yield { type: "activity", payload: { message: `启动 WorkBuddy codebuddy：${project?.path || ""}`, kind: "status" } };

    const child = spawn(execPath, args, {
      cwd: project?.path || process.cwd(),
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (session?.id) WorkBuddyRuntime.activeSessions.set(session.id, child);

    const state = { workingDirectory: project?.path || "" };
    const rl = readline.createInterface({ input: child.stdout });
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
        for (const event of convertWorkBuddyEvent(obj, state)) {
          yield event;
        }
      }

      if (exitCode !== 0 && exitCode !== null) {
        yield { type: "error", payload: { message: stderrText.trim() || `WorkBuddy 退出码：${exitCode}` } };
        return;
      }
      yield { type: "complete", payload: { message: "WorkBuddy 执行完成。" } };
    } catch (error) {
      yield { type: "error", payload: { message: error.message || "WorkBuddy 执行失败" } };
    } finally {
      rl.close();
      if (!child.killed) child.kill();
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
  convertWorkBuddyEvent,
  workbuddyExecutableCandidates,
  resolveWorkBuddyExecutable
};
