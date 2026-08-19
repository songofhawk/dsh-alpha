const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildCapabilities, codexPolicyForMode } = require("../shared/capabilities");

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const modelCatalogCache = new Map();

async function loadCodexSdk() {
  try {
    return await import("@openai/codex-sdk");
  } catch (error) {
    const wrapped = new Error(`无法加载 @openai/codex-sdk：${error.message}`);
    wrapped.statusCode = 500;
    wrapped.cause = error;
    throw wrapped;
  }
}

function detectDesktopCodexExecutable() {
  if (process.platform !== "darwin") {
    return null;
  }
  // 会话与 Codex 桌面端共用 ~/.codex，优先使用桌面端自带二进制，避免版本漂移导致会话无法落盘/桌面端不可见
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex"
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveCodexExecutable(codexPathOverride = process.env.CODEX_CLI_PATH) {
  if (codexPathOverride) {
    const resolved = path.resolve(codexPathOverride);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    const error = new Error(`CODEX_CLI_PATH 不可用：${codexPathOverride}`);
    error.statusCode = 500;
    throw error;
  }

  const desktopBinary = detectDesktopCodexExecutable();
  if (desktopBinary) {
    return desktopBinary;
  }

  const localBinary = path.join(__dirname, "..", "..", "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
  if (fs.existsSync(localBinary)) {
    return localBinary;
  }
  return "codex";
}

function buildCodexThreadOptions({ projectPath, settings }) {
  const policy = codexPolicyForMode(settings.mode);
  const approvalPolicy = settings.approval_policy || "on-request";
  return {
    model: settings.model,
    sandboxMode: policy.sandbox,
    workingDirectory: projectPath,
    skipGitRepoCheck: true,
    modelReasoningEffort: settings.reasoning_effort,
    networkAccessEnabled: policy.networkAccess,
    approvalPolicy
  };
}

function parseCodexModelCatalog(catalog) {
  const rows = Array.isArray(catalog?.models)
    ? catalog.models
    : Array.isArray(catalog?.data)
      ? catalog.data
      : [];
  const visibleRows = rows
    .filter((row) => row && typeof row === "object")
    .filter((row) => row.hidden !== true && row.visibility !== "hidden");
  const sortedRows = visibleRows.slice().sort((a, b) => {
    const left = Number.isFinite(a.priority) ? a.priority : Number.MAX_SAFE_INTEGER;
    const right = Number.isFinite(b.priority) ? b.priority : Number.MAX_SAFE_INTEGER;
    return left - right;
  });
  const models = [];
  const reasoningEfforts = [];
  for (const row of sortedRows) {
    const model = String(row.slug || row.model || row.id || "").trim();
    if (model && !models.includes(model)) {
      models.push(model);
    }
    const efforts = row.supported_reasoning_levels || row.supportedReasoningEfforts || [];
    for (const effortRow of efforts) {
      const effort = String(effortRow.effort || effortRow.reasoningEffort || "").trim();
      if (effort && !reasoningEfforts.includes(effort)) {
        reasoningEfforts.push(effort);
      }
    }
  }
  return {
    models,
    reasoning_efforts: reasoningEfforts
  };
}

function parseJsonObject(stdout) {
  const text = String(stdout || "").trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw error;
  }
}

function runCodexDebugModels({ codexPathOverride, timeoutMs = 5000, execFileImpl = execFile } = {}) {
  const codexPath = resolveCodexExecutable(codexPathOverride);
  return new Promise((resolve, reject) => {
    execFileImpl(codexPath, ["debug", "models"], {
      env: process.env,
      maxBuffer: 50 * 1024 * 1024,
      timeout: timeoutMs
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).slice(-4000)));
        return;
      }
      try {
        resolve(parseJsonObject(stdout));
      } catch (parseError) {
        reject(new Error(`Codex 模型目录不是合法 JSON：${parseError.message}`));
      }
    });
  });
}

async function verifyCodexHealth({ codexPathOverride, timeoutMs = 8000 } = {}) {
  const codexPath = resolveCodexExecutable(codexPathOverride);
  const version = await new Promise((resolve, reject) => {
    execFile(codexPath, ["--version"], { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        reject(new Error(`无法执行 ${codexPath} --version：${error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
  // 模型目录读取失败通常意味着二进制与 ~/.codex 缓存格式不兼容，会话将无法创建
  await runCodexDebugModels({ codexPathOverride: codexPath, timeoutMs });
  return { codexPath, version };
}

async function discoverCodexCapabilities({
  codexPathOverride,
  timeoutMs = 5000,
  force = false,
  runDebugModels = runCodexDebugModels,
  provider = "codex"
} = {}) {
  const cacheKey = codexPathOverride || process.env.CODEX_CLI_PATH || "default";
  const nowMs = Date.now();
  const cached = modelCatalogCache.get(cacheKey);
  if (!force && cached && nowMs - cached.updatedAt < MODEL_CACHE_TTL_MS) {
    return cached.capabilities;
  }

  const catalog = await runDebugModels({ codexPathOverride, timeoutMs });
  const parsed = parseCodexModelCatalog(catalog);
  const capabilities = buildCapabilities(provider, parsed);
  modelCatalogCache.set(cacheKey, {
    capabilities,
    updatedAt: nowMs
  });
  return capabilities;
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

function fileChangeMessage(item) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (!changes.length) {
    return item.status === "failed" ? "文件修改失败" : "文件修改完成";
  }
  const summary = changes
    .map((change) => `${change.kind || "update"} ${change.path || ""}`.trim())
    .join(", ");
  return item.status === "failed" ? `文件修改失败：${summary}` : `文件修改完成：${summary}`;
}

function convertThreadItemEvent(event) {
  const item = event.item || {};
  const itemStatus = item.status || (event.type === "item.completed" ? "completed" : "in_progress");

  if (item.type === "agent_message") {
    if (event.type !== "item.completed") {
      return [];
    }
    const text = String(item.text || "").trim();
    return text ? [{ type: "delta", payload: { text } }] : [];
  }

  if (item.type === "reasoning") {
    const text = String(item.text || "").trim();
    return text ? [{ type: "activity", payload: { message: text, kind: "agent" } }] : [];
  }

  if (item.type === "command_execution") {
    if (event.type === "item.started") {
      return [
        {
          type: "tool_use",
          payload: {
            tool_name: "exec_command",
            tool_input: { cmd: item.command || "" },
            tool_use_id: item.id || null
          }
        }
      ];
    }
    if (event.type === "item.completed") {
      return [
        {
          type: "tool_result",
          payload: {
            tool_use_id: item.id || null,
            content: String(item.aggregated_output || ""),
            is_error: itemStatus === "failed" || (Number.isInteger(item.exit_code) && item.exit_code !== 0)
          }
        }
      ];
    }
    return [{ type: "activity", payload: { message: "命令执行中", kind: "tool_progress" } }];
  }

  if (item.type === "mcp_tool_call") {
    if (event.type === "item.started") {
      return [
        {
          type: "tool_use",
          payload: {
            tool_name: item.tool || "mcp_tool",
            tool_input: item.arguments || {},
            tool_use_id: item.id || null
          }
        }
      ];
    }
    if (event.type === "item.completed") {
      const content = item.error?.message || renderValue(item.result?.content || item.result);
      return [
        {
          type: "tool_result",
          payload: {
            tool_use_id: item.id || null,
            content,
            is_error: itemStatus === "failed" || Boolean(item.error)
          }
        }
      ];
    }
    return [{ type: "activity", payload: { message: `调用工具：${item.tool || "mcp_tool"}`, kind: "tool_progress" } }];
  }

  if (item.type === "web_search") {
    if (event.type === "item.started") {
      return [
        {
          type: "tool_use",
          payload: {
            tool_name: "web_search",
            tool_input: { query: item.query || "" },
            tool_use_id: item.id || null
          }
        }
      ];
    }
    if (event.type === "item.completed") {
      return [
        {
          type: "tool_result",
          payload: {
            tool_use_id: item.id || null,
            content: `搜索完成：${item.query || ""}`,
            is_error: false
          }
        }
      ];
    }
  }

  if (item.type === "file_change") {
    return [{ type: "activity", payload: { message: fileChangeMessage(item), kind: "tool_progress" } }];
  }

  if (item.type === "todo_list") {
    const todos = Array.isArray(item.items) ? item.items : [];
    const completed = todos.filter((todo) => todo.completed).length;
    return [{ type: "activity", payload: { message: `计划进度：${completed}/${todos.length}`, kind: "status" } }];
  }

  if (item.type === "error") {
    return [{ type: "error", payload: { message: item.message || "Codex 事件错误" } }];
  }

  return [];
}

function convertCodexEvent(event) {
  if (!event || typeof event !== "object") {
    return [];
  }

  if (event.type === "thread.started") {
    return [
      {
        type: "runtime_session",
        payload: {
          runtime_session_id: event.thread_id || null,
          working_directory: ""
        }
      }
    ];
  }

  if (event.type === "turn.started") {
    return [{ type: "activity", payload: { message: "Codex 开始处理任务", kind: "status" } }];
  }

  if (event.type === "turn.completed") {
    return [{ type: "usage", payload: { usage: event.usage || null } }];
  }

  if (event.type === "turn.failed") {
    return [{ type: "error", payload: { message: event.error?.message || "Codex 执行失败" } }];
  }

  if (event.type === "error") {
    return [{ type: "error", payload: { message: event.message || "Codex 事件错误" } }];
  }

  if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
    return convertThreadItemEvent(event);
  }

  return [];
}

class CodexRuntime {
  constructor({ codexPathOverride, cliPath, sdk, provider = "codex" } = {}) {
    this.provider = provider;
    this.codexPathOverride = codexPathOverride || cliPath || process.env.CODEX_CLI_PATH || undefined;
    this.sdk = sdk || null;
  }

  async createClient() {
    const sdk = this.sdk || await loadCodexSdk();
    return new sdk.Codex({
      codexPathOverride: this.codexPathOverride,
      config: {
        show_raw_agent_reasoning: false
      }
    });
  }

  async *run({ session, project, message, attachments = [], settings }) {
    const threadOptions = buildCodexThreadOptions({
      projectPath: project.path,
      settings
    });
    const client = await this.createClient();
    const thread = session.runtime_session_id
      ? client.resumeThread(session.runtime_session_id, threadOptions)
      : client.startThread(threadOptions);

    yield {
      type: "activity",
      payload: {
        message: `启动 Codex SDK：${project.path}`,
        kind: "status"
      }
    };

    const images = attachments.filter((image) => image?.path);
    const input = images.length
      ? [{ type: "text", text: message }, ...images.map((image) => ({ type: "local_image", path: image.path }))]
      : message;
    const { events } = await thread.runStreamed(input);
    for await (const event of events) {
      if (event.type === "turn.failed") {
        const error = new Error(event.error?.message || "Codex 执行失败");
        error.statusCode = 500;
        throw error;
      }
      if (event.type === "error") {
        const error = new Error(event.message || "Codex 事件错误");
        error.statusCode = 500;
        throw error;
      }
      for (const normalized of convertCodexEvent(event)) {
        yield normalized;
      }
    }

    yield {
      type: "complete",
      payload: {
        message: "Codex 执行完成。"
      }
    };
  }

  async discoverCapabilities() {
    return discoverCodexCapabilities({ codexPathOverride: this.codexPathOverride, provider: this.provider });
  }
}

module.exports = {
  CodexRuntime,
  buildCodexThreadOptions,
  convertCodexEvent,
  detectDesktopCodexExecutable,
  discoverCodexCapabilities,
  parseCodexModelCatalog,
  resolveCodexExecutable,
  runCodexDebugModels,
  verifyCodexHealth
};
