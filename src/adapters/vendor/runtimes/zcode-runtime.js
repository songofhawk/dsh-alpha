const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { buildCapabilities } = require("../shared/capabilities");

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MIN_NODE_VERSION = [22, 19, 0];

function assertZCodeNodeVersion(version = process.versions.node) {
  const parts = String(version || "").split(".").map((part) => Number.parseInt(part, 10));
  let comparison = 0;
  for (let index = 0; index < MIN_NODE_VERSION.length; index += 1) {
    const required = MIN_NODE_VERSION[index];
    const actual = Number.isFinite(parts[index]) ? parts[index] : 0;
    if (actual > required) {
      comparison = 1;
      break;
    }
    if (actual < required) {
      comparison = -1;
      break;
    }
  }
  if (comparison < 0) {
    const error = new Error(`ZCode runtime 需要 Node.js >= 22.19.0，当前为 ${version || "unknown"}`);
    error.statusCode = 500;
    throw error;
  }
}

function validateResolvedExecutable(executable) {
  if (path.extname(executable).toLowerCase() === ".cjs") assertZCodeNodeVersion();
  return executable;
}

function zcodeExecutableCandidates() {
  const home = os.homedir();
  const windowsAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const binaryName = process.platform === "win32" ? "zcode.cmd" : "zcode";
  return [
    path.join("/Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"),
    path.join(home, "Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"),
    path.join("/opt", "ZCode", "resources", "glm", "zcode.cjs"),
    path.join(home, ".local", "opt", "ZCode", "resources", "glm", "zcode.cjs"),
    path.join(windowsAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
    path.join(home, ".local", "bin", binaryName),
    path.join(home, ".npm-global", "bin", binaryName),
    path.join(__dirname, "..", "..", "node_modules", ".bin", binaryName)
  ];
}

function resolveZCodeExecutable(pathOverride = process.env.ZCODE_CLI_PATH || process.env.ZCODE_BIN) {
  if (pathOverride) {
    const resolved = path.resolve(pathOverride);
    if (fs.existsSync(resolved)) return validateResolvedExecutable(resolved);
    const error = new Error(`ZCODE_CLI_PATH 不可用：${pathOverride}`);
    error.statusCode = 500;
    throw error;
  }
  for (const candidate of zcodeExecutableCandidates()) {
    if (fs.existsSync(candidate)) return validateResolvedExecutable(candidate);
  }
  return "zcode";
}

// -- 模型目录发现 ----------------------------------------------------------
// zcode CLI 没有运行时列模型的对外通道（无子命令，app-server 协议也没有
// model/list；内部 listModelOptions 只喂 TUI）。权威可离线来源是随 App 安装
// 的 model-providers catalog（schema: zcode.model-providers.v1，文件名带日期，
// 随 App 版本更新），CLI bundle 内含同款 zod schema，属于官方认可的格式。
// 优先级：ZCODE_MODELS / DSH_ALPHA_ZCODE_MODELS 显式覆盖 > App catalog > 空
// （空列表保持现状：GUI 提示未公开目录，走手动输入）。default_model 恒为
// null：buildZCodeArgs 不向 CLI 传模型，运行时默认由 zcode 自行决定。

const ZCODE_CATALOG_SCHEMA = "zcode.model-providers.v1";
const ZCODE_CATALOG_ZAI_PROVIDER_IDS = new Set(["zai", "zai-coding-plan", "bigmodel", "bigmodel-coding-plan"]);
// 主机名锚定：z.ai.example.net 这类冒名 baseURL 不得命中
const ZCODE_CATALOG_ZAI_BASE_URL = /\/\/(api\.z\.ai|open\.bigmodel\.cn)([:/?#]|$)/i;

function configuredZcodeModels() {
  return String(process.env.ZCODE_MODELS || process.env.DSH_ALPHA_ZCODE_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveZcodeModelCatalogPath({ catalogOverride = process.env.ZCODE_MODEL_CATALOG } = {}) {
  const override = String(catalogOverride || "").trim();
  if (override) {
    // 显式指定的路径缺失时短路返回 null（不回扫安装目录），便于排障与 hermetic 测试
    const resolved = path.resolve(override);
    return fs.existsSync(resolved) ? resolved : null;
  }
  // 目录布局与 zcode 可执行文件同源：<install>/glm/zcode.cjs → <install>/model-providers/
  for (const candidate of zcodeExecutableCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const catalogDir = path.join(path.dirname(path.dirname(candidate)), "model-providers");
    if (!fs.existsSync(catalogDir)) continue;
    const files = fs.readdirSync(catalogDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => path.join(catalogDir, file))
      .filter((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } })
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    if (files.length) return files[0];
  }
  return null;
}

// 只认 z.ai / bigmodel 家族 provider：catalog 同时携带 moonshot/minimax 等
// 第三方 provider，但 zcode OAuth 会话只能路由到智谱端点。
function parseZcodeModelCatalog(raw) {
  if (!raw || raw.schemaVersion !== ZCODE_CATALOG_SCHEMA || !Array.isArray(raw.providers)) return null;
  const models = [];
  const modelInputModalities = {};
  const inputModalities = [];
  for (const provider of raw.providers) {
    const baseURL = String(provider?.endpoints?.baseURL || "");
    if (!ZCODE_CATALOG_ZAI_PROVIDER_IDS.has(provider?.id) && !ZCODE_CATALOG_ZAI_BASE_URL.test(baseURL)) continue;
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      const id = String(model?.id || "").trim();
      if (!id || models.includes(id)) continue;
      models.push(id);
      const inputs = Array.isArray(model?.modalities?.input)
        ? model.modalities.input.map((value) => String(value).toLowerCase().trim()).filter(Boolean)
        : [];
      if (inputs.length) modelInputModalities[id] = inputs;
      for (const modality of inputs) {
        if (!inputModalities.includes(modality)) inputModalities.push(modality);
      }
    }
  }
  if (!models.length) return null;
  return {
    models,
    input_modalities: inputModalities.length ? inputModalities : ["text"],
    model_input_modalities: modelInputModalities
  };
}

function loadZcodeModelCatalog() {
  const catalogPath = resolveZcodeModelCatalogPath();
  if (!catalogPath) return null;
  try {
    return parseZcodeModelCatalog(JSON.parse(fs.readFileSync(catalogPath, "utf8")));
  } catch {
    return null; // 目录文件缺失/损坏时安全降级为空列表，不影响会话派发
  }
}

function zcodeModeForSettings(settings = {}) {
  if (settings.mode === "full-access") return "yolo";
  if (settings.mode === "auto-review") return "edit";
  if (settings.approval_policy === "never") return "plan";
  return "build";
}

function attachmentPaths(attachments = []) {
  return attachments
    .filter((attachment) => attachment?.path)
    .map((attachment) => String(attachment.path));
}

function buildZCodeArgs({ runtimeSessionId, projectPath, message, attachments = [], settings = {} }) {
  const args = [
    "--prompt",
    String(message || ""),
    "--output-format",
    "stream-json",
    "--no-color",
    "--mode",
    zcodeModeForSettings(settings)
  ];
  if (projectPath) args.push("--cwd", projectPath);
  if (runtimeSessionId) args.push("--resume", runtimeSessionId);
  for (const filePath of attachmentPaths(attachments)) {
    args.push("--attach", filePath);
  }
  return args;
}

function zcodeSpawnCommand(executable, args) {
  if (path.extname(executable).toLowerCase() === ".cjs") {
    return { command: process.execPath, args: [executable, ...args] };
  }
  return { command: executable, args };
}

function parseZCodeJson(output) {
  const text = String(output || "").trim();
  if (!text) throw new Error("ZCode 没有返回 JSON 结果");
  try {
    return JSON.parse(text);
  } catch {
    const finalBrace = text.lastIndexOf("}");
    for (let index = text.lastIndexOf("{", finalBrace); index >= 0; index = text.lastIndexOf("{", index - 1)) {
      try {
        return JSON.parse(text.slice(index, finalBrace + 1));
      } catch {
        // 兼容诊断文本后跟多行 JSON；从内层花括号逐步回退到最外层。
      }
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // 某些版本会在 JSON 前打印诊断信息，继续向前找最后一个合法对象。
      }
    }
  }
  throw new Error("ZCode 输出不是合法 JSON");
}

function zcodeResultEvents(result = {}, { workingDirectory = "", includeDelta = true } = {}) {
  const errorValue = result.error || result.failure;
  if (errorValue) {
    const message = typeof errorValue === "string"
      ? errorValue
      : errorValue.message || JSON.stringify(errorValue);
    throw new Error(message || "ZCode 执行失败");
  }

  const response = result.response ?? result.result ?? result.text;
  if (typeof response !== "string" || !response) {
    throw new Error("ZCode JSON 结果缺少 response");
  }

  const events = [];
  const sessionId = result.sessionId || result.session_id || result.session?.id;
  if (sessionId) {
    events.push({
      type: "runtime_session",
      payload: { runtime_session_id: sessionId, working_directory: workingDirectory }
    });
  }
  if (result.usage && typeof result.usage === "object") {
    events.push({ type: "usage", payload: { usage: result.usage } });
  }
  if (includeDelta) events.push({ type: "delta", payload: { text: response } });
  events.push({
    type: "complete",
    payload: { message: response, usage: result.usage || null, artifacts: [] }
  });
  return events;
}

function renderZCodeValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(renderZCodeValue).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (value.content !== undefined) return renderZCodeValue(value.content);
    if (value.message !== undefined) return renderZCodeValue(value.message);
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  return String(value);
}

function zcodeStreamRecordEvents(record = {}) {
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};

  if (record.type === "model.streaming") {
    if (payload.kind === "text_delta" && typeof payload.delta === "string" && payload.delta) {
      return [{ type: "delta", payload: { text: payload.delta } }];
    }
    return [];
  }

  if (record.type === "turn.started") {
    return [{ type: "activity", payload: { message: "ZCode 开始执行任务", kind: "status" } }];
  }

  if (record.type === "turn.failed") {
    const message = renderZCodeValue(payload.error || payload.message || payload.reason) || "ZCode turn 执行失败";
    return [{ type: "error", payload: { message } }];
  }

  if (record.type === "permission.requested") {
    const toolName = payload.toolName || payload.tool_name || "操作";
    return [{
      type: "activity",
      payload: {
        message: `ZCode 正在处理权限请求：${toolName}`,
        kind: "tool_progress",
        tool_use_id: payload.toolCallId || payload.tool_call_id || null,
        tool_name: toolName
      }
    }];
  }

  if (record.type !== "tool.updated") return [];

  const kind = payload.kind;
  const toolName = payload.toolName || payload.tool_name || payload.name || "tool";
  const toolUseId = payload.toolCallId || payload.tool_call_id || payload.id || null;
  const toolInput = payload.input || payload.toolInput || payload.tool_input || {};
  if (kind === "scheduled") {
    return [{
      type: "activity",
      payload: { message: `准备调用工具：${toolName}`, kind: "tool_progress", tool_use_id: toolUseId, tool_name: toolName }
    }];
  }
  if (kind === "started") {
    return [{ type: "tool_use", payload: { tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId } }];
  }
  if (kind === "progress") {
    const detail = renderZCodeValue(payload.message || payload.progress || payload.delta || payload.output || payload.content);
    return [{
      type: "activity",
      payload: {
        message: detail ? `${toolName}：${detail}` : `${toolName} 执行中`,
        kind: "tool_progress",
        tool_use_id: toolUseId,
        tool_name: toolName
      }
    }];
  }
  if (kind === "result" || kind === "error") {
    const content = renderZCodeValue(
      kind === "error"
        ? payload.error || payload.message || payload.content
        : payload.result || payload.output || payload.content || payload.message
    );
    return [{
      type: "tool_result",
      payload: { tool_use_id: toolUseId, tool_name: toolName, content, is_error: kind === "error" }
    }];
  }
  return [];
}

async function* readZCodeLines(stdout) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let stdoutBytes = 0;
  for await (const chunk of stdout) {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_STDOUT_BYTES) throw new Error("ZCode 输出超过 16 MiB 安全上限");
    pending += decoder.write(chunk);
    let newlineIndex;
    while ((newlineIndex = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newlineIndex).replace(/\r$/, "").trim();
      pending = pending.slice(newlineIndex + 1);
      if (line) yield line;
    }
  }
  pending += decoder.end();
  const finalLine = pending.trim();
  if (finalLine) yield finalLine;
}

function trackProcess(child) {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve({ ...value, stderr });
    };
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr) > MAX_STDERR_BYTES) {
        stderr = stderr.slice(-MAX_STDERR_BYTES);
      }
    });
    child.on("error", (error) => finish({ error }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

class ZCodeRuntime {
  static activeProcesses = new Map();

  constructor({ pathOverride, spawnImpl = spawn, provider = "zcode" } = {}) {
    this.provider = provider;
    this.pathOverride = pathOverride || process.env.ZCODE_CLI_PATH || process.env.ZCODE_BIN || undefined;
    this.spawnImpl = spawnImpl;
  }

  async *run({ session, project, message, attachments = [], settings = {} } = {}) {
    const workingDirectory = project?.path || process.cwd();
    let executable;
    let child;
    try {
      executable = resolveZCodeExecutable(this.pathOverride);
      const args = buildZCodeArgs({
        runtimeSessionId: session?.runtime_session_id,
        projectPath: workingDirectory,
        message,
        attachments,
        settings
      });
      const invocation = zcodeSpawnCommand(executable, args);
      child = this.spawnImpl(invocation.command, invocation.args, {
        cwd: workingDirectory,
        env: { ...process.env, PWD: workingDirectory },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      yield { type: "error", payload: { message: `ZCode 启动失败：${error.message}` } };
      return;
    }

    const activeEntry = { child, cancelled: false };
    if (session?.id) ZCodeRuntime.activeProcesses.set(session.id, activeEntry);
    // 必须在首个 yield 前订阅 stdout/close；极短任务可能在调用方拉取下一帧前退出。
    const outcomePromise = trackProcess(child);

    yield {
      type: "activity",
      payload: { message: `启动 ZCode Agent：${workingDirectory}`, kind: "status" }
    };

    try {
      let finalResult = null;
      let streamedText = false;
      let runtimeSessionId = null;
      const diagnostics = [];
      for await (const line of readZCodeLines(child.stdout)) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          diagnostics.push(line);
          if (diagnostics.length > 3) diagnostics.shift();
          continue;
        }
        const discoveredSessionId = record.sessionId || record.session_id || record.session?.id;
        if (discoveredSessionId && discoveredSessionId !== runtimeSessionId) {
          runtimeSessionId = discoveredSessionId;
          yield {
            type: "runtime_session",
            payload: { runtime_session_id: discoveredSessionId, working_directory: workingDirectory }
          };
        }
        if (record.type === "result") {
          finalResult = record;
          continue;
        }
        for (const event of zcodeStreamRecordEvents(record)) {
          if (event.type === "delta") streamedText = true;
          yield event;
        }
      }
      const outcome = await outcomePromise;
      if (outcome.error) throw outcome.error;
      if (activeEntry.cancelled) {
        yield { type: "cancelled", payload: { message: "ZCode Agent 已取消。" } };
        return;
      }
      if (outcome.signal) {
        yield { type: "error", payload: { message: `ZCode 执行被信号中断：${outcome.signal}` } };
        return;
      }
      if (outcome.code !== 0) {
        const detail = outcome.stderr.trim() || `退出码 ${outcome.code}`;
        yield { type: "error", payload: { message: `ZCode 执行失败：${detail}` } };
        return;
      }
      if (!finalResult) {
        const detail = diagnostics.at(-1);
        throw new Error(detail ? `ZCode stream 未返回 result；最后输出：${detail}` : "ZCode stream 未返回 result");
      }
      for (const event of zcodeResultEvents(finalResult, { workingDirectory, includeDelta: !streamedText })) {
        if (event.type === "runtime_session" && event.payload.runtime_session_id === runtimeSessionId) continue;
        yield event;
      }
    } catch (error) {
      if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
      yield { type: "error", payload: { message: `ZCode 执行失败：${error.message}` } };
    } finally {
      if (session?.id) ZCodeRuntime.activeProcesses.delete(session.id);
      if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
    }
  }

  async discoverCapabilities() {
    const envModels = configuredZcodeModels();
    const catalog = envModels.length
      ? { models: envModels, input_modalities: ["text"], model_input_modalities: {} }
      : loadZcodeModelCatalog();
    return buildCapabilities(this.provider, {
      models: catalog?.models || [],
      default_model: null,
      input_modalities: catalog?.input_modalities || ["text"],
      ...(catalog?.model_input_modalities && Object.keys(catalog.model_input_modalities).length
        ? { model_input_modalities: catalog.model_input_modalities }
        : {})
    });
  }

  async cancelTurn({ session } = {}) {
    const active = session?.id ? ZCodeRuntime.activeProcesses.get(session.id) : null;
    if (!active) {
      const error = new Error("没有可取消的 ZCode turn。");
      error.statusCode = 409;
      throw error;
    }
    active.cancelled = true;
    active.child.kill("SIGTERM");
    return {};
  }
}

module.exports = {
  ZCodeRuntime,
  assertZCodeNodeVersion,
  attachmentPaths,
  buildZCodeArgs,
  configuredZcodeModels,
  loadZcodeModelCatalog,
  parseZCodeJson,
  parseZcodeModelCatalog,
  resolveZCodeExecutable,
  resolveZcodeModelCatalogPath,
  zcodeExecutableCandidates,
  zcodeModeForSettings,
  zcodeResultEvents,
  zcodeStreamRecordEvents,
  zcodeSpawnCommand
};
