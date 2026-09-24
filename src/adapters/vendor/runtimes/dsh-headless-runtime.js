const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildCapabilities } = require("../shared/capabilities");

function resolveDshExecutable(override = process.env.DSH_CLI_PATH) {
  if (override) {
    const resolved = path.resolve(override);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`DSH_CLI_PATH 不可用：${override}`);
  }
  const command = process.platform === "win32" ? "dsh.cmd" : "dsh";
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  const bundled = path.resolve(__dirname, "../../../../node_modules/.bin/dsh");
  return fs.existsSync(bundled) ? bundled : command;
}

class DshHeadlessRuntime {
  constructor({ pathOverride, spawnImpl = spawn, provider = "dsh" } = {}) {
    this.pathOverride = pathOverride;
    this.spawnImpl = spawnImpl;
    this.provider = provider;
    this.activeSessions = new Map();
  }

  async discoverCapabilities() {
    return buildCapabilities(this.provider, { input_modalities: ["text"] });
  }

  async *run({ session, project, message, attachments = [] } = {}) {
    const cwd = project?.path || process.cwd();
    const imagePaths = attachments.filter((item) => item?.path).map((item) => item.path);
    const prompt = imagePaths.length
      ? `${String(message || "")}\n\n附件图片路径：\n${imagePaths.map((item) => `- ${item}`).join("\n")}`
      : String(message || "");
    const executable = resolveDshExecutable(this.pathOverride);
    yield { type: "activity", payload: { kind: "status", message: `启动 DSH：${cwd}` } };

    const child = this.spawnImpl(executable, ["--profile", "headless", prompt], {
      cwd,
      env: { ...process.env, PWD: cwd },
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (session?.id) this.activeSessions.set(session.id, child);
    let stdout = "";
    let stderr = "";
    const limit = 1024 * 1024;
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-limit); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-limit); });

    try {
      const outcome = await new Promise((resolve) => {
        child.once("error", (error) => resolve({ error }));
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      if (outcome.error) {
        yield { type: "error", payload: { message: outcome.error.message } };
      } else if (outcome.signal) {
        yield { type: "cancelled", payload: { message: "DSH 任务已取消" } };
      } else if (outcome.code !== 0) {
        yield { type: "error", payload: { message: stderr.trim() || stdout.trim() || `DSH 退出码：${outcome.code}` } };
      } else {
        yield { type: "complete", payload: { message: stdout.trim() } };
      }
    } finally {
      if (session?.id) this.activeSessions.delete(session.id);
    }
  }

  async cancelTurn({ session } = {}) {
    const child = session?.id ? this.activeSessions.get(session.id) : null;
    if (child) child.kill("SIGTERM");
    return {};
  }
}

module.exports = { DshHeadlessRuntime, resolveDshExecutable };
