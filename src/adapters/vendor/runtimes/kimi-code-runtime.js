const fs = require("node:fs");
const path = require("node:path");
const { buildCapabilities } = require("../shared/capabilities");
const { KimiAcpClient } = require("./kimi-acp-client");

const DEFAULT_KIMI_MODELS = [
  "kimi-code/kimi-for-coding",
  "kimi-code/kimi-for-coding-highspeed",
  "kimi-code/k3",
  "kimi-code/k3-256k"
];
const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

function kimiModeForSettings(settings = {}) {
  if (settings.mode === "full-access") {
    return "yolo";
  }
  if (settings.mode === "auto-review" || settings.approval_policy === "never") {
    return "auto";
  }
  return "default";
}

function kimiThinkingForEffort(effort) {
  if (effort === "low") {
    return "low";
  }
  if (effort === "xhigh" || effort === "max") {
    return "max";
  }
  return "high";
}

function kimiModeOptions(configOptions = []) {
  const mode = configOptions.find((option) => option?.id === "mode");
  return mode?.options?.map((option) => String(option.value)) || [];
}

function kimiModelOptions(configOptions = []) {
  const model = configOptions.find((option) => option?.id === "model");
  return model?.options?.map((option) => String(option.value)) || [];
}

function kimiThinkingOptions(configOptions = []) {
  const thinking = configOptions.find((option) => option?.id === "thinking");
  return thinking?.options
    ?.map((option) => String(option.value || "").trim())
    .filter((value) => value && !["auto", "automatic", "default", "disabled", "enabled", "false", "off", "on", "true"].includes(value.toLowerCase())) || [];
}

function normalizeKimiModel(model, availableModels = []) {
  const requested = String(model || "").trim();
  if (!requested) {
    return null;
  }
  if (availableModels.includes(requested)) {
    return requested;
  }
  const fallback = DEFAULT_KIMI_MODELS.find((candidate) => requested.endsWith(candidate.split("/").pop()));
  if (fallback) {
    return availableModels.includes(fallback) ? fallback : fallback;
  }
  return requested;
}

function buildKimiPrompt(message, attachments = []) {
  const imagePaths = (attachments || [])
    .filter((attachment) => attachment?.path)
    .map((attachment) => String(attachment.path));
  if (!imagePaths.length) {
    return String(message || "");
  }
  return `${String(message || "")}\n\n附件图片路径：\n${imagePaths.map((imagePath) => `- ${imagePath}`).join("\n")}`;
}

function renderKimiText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderKimiText(item)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (value.content !== undefined) {
      return renderKimiText(value.content);
    }
    if (Array.isArray(value.content)) {
      return renderKimiText(value.content);
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function toolInputFromCall(toolCall = {}) {
  if (toolCall.rawInput && typeof toolCall.rawInput === "object") {
    return toolCall.rawInput;
  }
  return { kind: toolCall.kind || "other" };
}

function usageFromKimiUpdate(update = {}) {
  if (!update || update.sessionUpdate !== "usage_update") {
    return null;
  }
  const usage = {};
  if (Number.isFinite(update.used)) {
    usage.used = update.used;
  }
  if (Number.isFinite(update.size)) {
    usage.size = update.size;
  }
  if (update.cost && Number.isFinite(update.cost.amount)) {
    usage.cost_usd = update.cost.amount;
    usage.currency = update.cost.currency || "USD";
  }
  return Object.keys(usage).length ? { usage } : null;
}

function convertKimiSessionUpdate(update = {}) {
  const kind = update.sessionUpdate;

  if (kind === "agent_message_chunk") {
    const text = renderKimiText(update.content);
    return text ? [{ type: "delta", payload: { text } }] : [];
  }

  if (kind === "agent_thought_chunk") {
    const text = renderKimiText(update.content);
    return text ? [{ type: "activity", payload: { message: text, kind: "agent" } }] : [];
  }

  if (kind === "tool_call") {
    return [{
      type: "tool_use",
      payload: {
        tool_name: update.title || update.kind || "tool",
        tool_input: toolInputFromCall(update),
        tool_use_id: update.toolCallId || null
      }
    }];
  }

  if (kind === "tool_call_update") {
    const status = update.status || "in_progress";
    if (status === "completed" || status === "failed") {
      return [{
        type: "tool_result",
        payload: {
          tool_use_id: update.toolCallId || null,
          tool_name: update.title || update.kind || null,
          content: renderKimiText(update.content),
          is_error: status === "failed"
        }
      }];
    }
    const detail = renderKimiText(update.content);
    const toolName = update.title || update.kind || null;
    const message = detail
      ? (toolName && detail !== toolName ? `${toolName}：${detail}` : detail)
      : (toolName ? `${toolName} 执行中` : "工具执行中");
    return [{
      type: "activity",
      payload: {
        message,
        kind: "tool_progress",
        tool_use_id: update.toolCallId || null,
        tool_name: toolName
      }
    }];
  }

  if (kind === "usage_update") {
    return [{
      type: "usage",
      payload: {
        usage: {
          ...(Number.isFinite(update.used) ? { used: update.used } : {}),
          ...(Number.isFinite(update.size) ? { size: update.size } : {}),
          ...(update.cost && Number.isFinite(update.cost.amount)
            ? { cost_usd: update.cost.amount, currency: update.cost.currency || "USD" }
            : {})
        }
      }
    }];
  }

  if (kind === "plan") {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const summary = entries
      .filter((entry) => entry?.content)
      .map((entry) => String(entry.content))
      .join("\n");
    return summary ? [{ type: "activity", payload: { message: `计划：\n${summary}`, kind: "status" } }] : [];
  }

  if (kind === "session_info_update") {
    return [{ type: "activity", payload: { message: "Kimi Code 会话信息已更新", kind: "status" } }];
  }

  return [];
}

function describeKimiPermission(params = {}) {
  const toolCall = params.toolCall || {};
  let inputText = "";
  try {
    inputText = JSON.stringify(toolCall.rawInput ?? toolCall.kind ?? {});
  } catch {
    inputText = String(toolCall.kind);
  }
  if (inputText.length > 500) {
    inputText = `${inputText.slice(0, 500)}…`;
  }
  const content = renderKimiText(toolCall.content);
  return `Kimi 请求执行操作：${toolCall.title || "tool"}${inputText ? `（${inputText}）` : ""}${content ? `\n${content}` : ""}`;
}

function readImageAsDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[ext] || "image/png";
  const data = fs.readFileSync(filePath).toString("base64");
  return { data, mimeType };
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

  hasPending() {
    return this.items.length > 0;
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

function collectKimiTurnEvents(events) {
  const turns = [];
  let current = null;
  const flush = () => {
    if (current && current.text) {
      turns.push({ role: "assistant", text: current.text });
    }
    current = null;
  };
  for (const event of events) {
    if (event.type === "delta") {
      if (!current) {
        current = { text: "" };
      }
      current.text += event.payload?.text || "";
    } else if (event.type === "tool_use" || event.type === "tool_result") {
      flush();
    }
  }
  flush();
  return turns;
}

class KimiCodeRuntime {
  static activeSessions = new Map();

  constructor({ kimiPathOverride, cliPath, clientFactory, provider = "kimi-code" } = {}) {
    this.provider = provider;
    this.kimiPathOverride = kimiPathOverride || cliPath || process.env.KIMI_CODE_CLI_PATH || process.env.KIMI_CLI_PATH || undefined;
    this.clientFactory = clientFactory || ((options) => new KimiAcpClient(options));
  }

  async *run({ session, project, message, attachments = [], settings = {}, requestApproval } = {}) {
    const client = this.clientFactory({
      kimiPathOverride: this.kimiPathOverride,
      terminalCwd: project?.path || process.cwd()
    });
    let activeSessionId = null;
    const state = {
      seenToolCallIds: new Set(),
      currentToolCallId: null,
      emittedText: false
    };

    const emitQueue = new AsyncEventQueue();
    let suppressNotifications = false;
    const onUpdate = (update) => {
      if (suppressNotifications) {
        return;
      }
      for (const normalized of convertKimiSessionUpdate(update)) {
        if (normalized.type === "delta" && normalized.payload?.text) {
          state.emittedText = true;
        }
        emitQueue.push(normalized);
      }
    };
    const onNotification = (msg) => {
      const params = msg.params || {};
      if (params.update) {
        onUpdate(params.update);
      }
    };
    const onRequest = (msg) => {
      if (msg.method === "session/request_permission") {
        handlePermissionRequest(msg, client, requestApproval);
      }
    };

    client.on("notification", onNotification);
    client.on("request", onRequest);

    yield {
      type: "activity",
      payload: {
        message: `启动 Kimi Code：${project?.path || ""}`,
        kind: "status"
      }
    };

    try {
      await client.initialize();

      // session/load 会回放历史 session/update，需要抑制，避免混入当前 turn。
      suppressNotifications = true;
      let sessionId;
      let configOptions = [];
      if (session?.runtime_session_id) {
        try {
          const loaded = await client.request("session/load", {
            sessionId: session.runtime_session_id,
            cwd: project?.path || process.cwd(),
            mcpServers: []
          });
          sessionId = loaded.sessionId || session.runtime_session_id;
          configOptions = loaded.configOptions || [];
        } catch (error) {
          const created = await client.request("session/new", {
            cwd: project?.path || process.cwd(),
            mcpServers: []
          });
          sessionId = created.sessionId;
          configOptions = created.configOptions || [];
        }
      } else {
        const created = await client.request("session/new", {
          cwd: project?.path || process.cwd(),
          mcpServers: []
        });
        sessionId = created.sessionId;
        configOptions = created.configOptions || [];
      }
      suppressNotifications = false;
      activeSessionId = sessionId;

      yield {
        type: "runtime_session",
        payload: {
          runtime_session_id: sessionId,
          working_directory: project?.path || ""
        }
      };

      const activeEntry = { client, sessionId, cancelled: false, promptRequestId: null };
      if (session?.id) {
        KimiCodeRuntime.activeSessions.set(session.id, activeEntry);
      }

      suppressNotifications = true;
      await applyKimiConfig(client, sessionId, configOptions, settings);
      suppressNotifications = false;

      const imagePaths = (attachments || [])
        .filter((attachment) => attachment?.path)
        .map((attachment) => String(attachment.path));
      const promptBlocks = [];
      if (imagePaths.length) {
        promptBlocks.push({ type: "text", text: String(message || "") });
        for (const imagePath of imagePaths) {
          promptBlocks.push({ type: "image", ...readImageAsDataUri(imagePath) });
        }
      } else {
        promptBlocks.push({ type: "text", text: String(message || "") });
      }

      // 预取请求 id：cancelTurn 通过 $/cancel_request 取消 prompt。
      const promptRequestId = String(client.nextRequestId);
      activeEntry.promptRequestId = promptRequestId;
      const promptPromise = client.request("session/prompt", {
        sessionId,
        prompt: promptBlocks
      });

      const iterator = emitQueue[Symbol.asyncIterator]();
      let promptResult = null;
      let promptSettled = false;
      const promptSettledPromise = promptPromise.then((result) => {
        promptSettled = true;
        promptResult = result;
      });
      let pendingNext = iterator.next();
      while (true) {
        const winner = await Promise.race([
          pendingNext.then((r) => ({ kind: "event", r })),
          promptSettledPromise.then(() => ({ kind: "prompt" }))
        ]);
        if (winner.kind === "event") {
          if (winner.r.done) {
            break;
          }
          yield winner.r.value;
          pendingNext = iterator.next();
        } else {
          // prompt 已完成：先同步消费已缓冲事件（如 usage_update），
          // 队列空闲后再等待一个短窗口捕获可能迟到的尾事件。
          while (true) {
            if (emitQueue.hasPending()) {
              const buffered = await iterator.next();
              if (buffered.done) {
                break;
              }
              yield buffered.value;
              continue;
            }
            const tail = await Promise.race([
              pendingNext.then((r) => ({ kind: "event", r })),
              new Promise((resolve) => setTimeout(() => resolve({ kind: "idle" }), 150))
            ]);
            if (tail.kind === "idle" || tail.r?.done) {
              break;
            }
            yield tail.r.value;
            pendingNext = iterator.next();
          }
          break;
        }
      }

      if (activeEntry.cancelled) {
        yield {
          type: "cancelled",
          payload: { message: "Kimi Code 已取消。" }
        };
        yield { type: "complete", payload: { message: "Kimi Code 执行完成（已取消）。" } };
        return;
      }
      if (promptResult?.stopReason === "cancelled") {
        yield {
          type: "cancelled",
          payload: { message: "Kimi Code turn 被取消。" }
        };
      }
      yield {
        type: "complete",
        payload: { message: "Kimi Code 执行完成。" }
      };
    } catch (error) {
      if (error?.code === -32800 || /cancelled/i.test(error?.message || "")) {
        yield {
          type: "cancelled",
          payload: { message: "Kimi Code 已取消。" }
        };
        yield { type: "complete", payload: { message: "Kimi Code 执行完成（已取消）。" } };
        return;
      }
      yield { type: "error", payload: { message: error.message || "Kimi Code 执行失败" } };
    } finally {
      emitQueue.complete();
      if (activeSessionId && !client.closed) {
        try {
          await client.request("session/close", { sessionId: activeSessionId });
        } catch {
          // Best effort close.
        }
      }
      if (session?.id) {
        KimiCodeRuntime.activeSessions.delete(session.id);
      }
      client.close();
    }
  }

  async discoverCapabilities({ cwd = process.cwd() } = {}) {
    const client = this.clientFactory({ kimiPathOverride: this.kimiPathOverride });
    try {
      await client.initialize();
      const created = await client.request("session/new", {
        cwd,
        mcpServers: []
      });
      const configOptions = created.configOptions || [];
      const models = kimiModelOptions(configOptions);
      const thinkingOptions = kimiThinkingOptions(configOptions);
      const capabilities = buildCapabilities(this.provider, {
        models,
        default_model: models[0] || null,
        input_modalities: ["text", "local_image"],
        reasoning_efforts: thinkingOptions
      });
      // session/new configOptions 是当前 Kimi Agent API 的权威目录；不回退到
      // 插件内的静态候选，避免把过期模型伪装成可选项。
      capabilities.models = models;
      capabilities.default_model = models[0] || null;
      capabilities.reasoning_efforts = thinkingOptions;
      return capabilities;
    } finally {
      client.close();
    }
  }

  async cancelTurn({ session } = {}) {
    const active = session?.id ? KimiCodeRuntime.activeSessions.get(session.id) : null;
    if (!active) {
      const error = new Error("没有可取消的 Kimi Code turn。");
      error.statusCode = 409;
      throw error;
    }
    active.cancelled = true;
    // kimi 0.34 未实现 session/cancel（返回 -32601），按 ACP 规范用
    // $/cancel_request notification 取消对应的 prompt 请求。
    if (active.promptRequestId) {
      try {
        active.client.notify("$/cancel_request", { requestId: active.promptRequestId });
      } catch {
        // 连接可能已关闭，忽略。
      }
    } else {
      try {
        await active.client.request("session/cancel", { sessionId: active.sessionId });
      } catch {
        active.client.close();
      }
    }
    return {};
  }

  async listRuntimeSessions({ project, limit = 50 } = {}) {
    const client = this.clientFactory({ kimiPathOverride: this.kimiPathOverride });
    try {
      await client.initialize();
      const result = await client.request("session/list", {});
      const sessions = (result.sessions || []).filter((sessionItem) => {
        if (!project?.path) {
          return true;
        }
        return sessionItem.cwd === project.path;
      });
      return sessions.slice(0, Number(limit) || 50).map((sessionItem) => ({
        id: sessionItem.sessionId,
        runtime_session_id: sessionItem.sessionId,
        title: sessionItem.title || sessionItem.sessionId,
        provider: this.provider,
        working_directory: sessionItem.cwd || "",
        created_at: sessionItem.createdAt || null,
        updated_at: sessionItem.updatedAt || null
      }));
    } finally {
      client.close();
    }
  }

  async readRuntimeSession({ runtimeSessionId, includeTurns = true } = {}) {
    if (!runtimeSessionId) {
      const error = new Error("缺少 runtime_session_id。");
      error.statusCode = 400;
      throw error;
    }
    const client = this.clientFactory({ kimiPathOverride: this.kimiPathOverride });
    const events = [];
    try {
      await client.initialize();
      const loaded = await new Promise((resolve, reject) => {
        const collected = [];
        const onUpdate = (msg) => {
          const update = msg.params?.update;
          if (update) {
            collected.push(update);
          }
        };
        client.on("notification", onUpdate);
        client.request("session/load", {
          sessionId: runtimeSessionId,
          cwd: process.cwd(),
          mcpServers: []
        }).then((result) => {
          client.removeListener("notification", onUpdate);
          resolve({ result, collected });
        }).catch((error) => {
          client.removeListener("notification", onUpdate);
          reject(error);
        });
      });

      for (const update of loaded.collected) {
        events.push(...convertKimiSessionUpdate(update));
      }

      const thread = {
        id: runtimeSessionId,
        runtime_session_id: runtimeSessionId,
        title: loaded.result?.title || runtimeSessionId,
        preview: events.find((event) => event.type === "delta")?.payload?.text || null,
        provider: this.provider,
        created_at: loaded.result?.createdAt || null,
        updated_at: loaded.result?.updatedAt || null
      };

      return {
        thread,
        turns: includeTurns ? collectKimiTurnEvents(events) : [],
        events: includeTurns ? events : []
      };
    } finally {
      client.close();
    }
  }
}

async function handlePermissionRequest(msg, client, requestApproval) {
  const params = msg.params || {};
  const toolCall = params.toolCall || {};
  const optionId = (params.options || [])[0]?.optionId;

  if (typeof requestApproval !== "function" || !optionId) {
    client.respond(msg.id, {
      outcome: { outcome: "selected", optionId: optionId || "approve_once" }
    });
    return;
  }

  try {
    const decision = await requestApproval({
      kind: "tool_permission",
      command: describeKimiPermission(params),
      tool_name: toolCall.title || toolCall.kind || "tool",
      tool_input: toolInputFromCall(toolCall),
      tool_use_id: toolCall.toolCallId || null,
      available_decisions: ["approved", "rejected"],
      raw: params
    });
    const outcome = decision?.decision === "approved" ? "approve_once" : "reject";
    client.respond(msg.id, {
      outcome: { outcome: "selected", optionId: outcome }
    });
  } catch (error) {
    client.respond(msg.id, {
      outcome: { outcome: "cancelled" }
    });
  }
}

async function applyKimiConfig(client, sessionId, configOptions, settings = {}) {
  const modelOptions = kimiModelOptions(configOptions);
  const modeOptions = kimiModeOptions(configOptions);
  const thinkingOptions = kimiThinkingOptions(configOptions);

  const desiredModel = normalizeKimiModel(settings.model, modelOptions);
  if (desiredModel && modelOptions.includes(desiredModel)) {
    await client.request("session/set_config_option", {
      sessionId,
      configId: "model",
      value: desiredModel
    });
  }

  if (settings.reasoning_effort) {
    const thinking = kimiThinkingForEffort(settings.reasoning_effort);
    if (thinkingOptions.includes(thinking)) {
      await client.request("session/set_config_option", {
        sessionId,
        configId: "thinking",
        value: thinking
      });
    }
  }

  if (settings.mode) {
    const mode = kimiModeForSettings(settings);
    if (modeOptions.includes(mode)) {
      await client.request("session/set_config_option", {
        sessionId,
        configId: "mode",
        value: mode
      });
    }
  }
}

module.exports = {
  DEFAULT_KIMI_MODELS,
  KimiCodeRuntime,
  applyKimiConfig,
  buildKimiPrompt,
  collectKimiTurnEvents,
  convertKimiSessionUpdate,
  describeKimiPermission,
  kimiExecutableCandidates: require("./kimi-acp-client").kimiExecutableCandidates,
  kimiModeForSettings,
  kimiModeOptions,
  kimiModelOptions,
  kimiThinkingForEffort,
  kimiThinkingOptions,
  normalizeKimiModel,
  readImageAsDataUri,
  renderKimiText,
  resolveKimiExecutable: require("./kimi-acp-client").resolveKimiExecutable,
  toolInputFromCall
};
