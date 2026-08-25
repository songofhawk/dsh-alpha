const { buildCapabilities } = require("../shared/capabilities");
const { OpenCodeAcpClient } = require("./opencode-acp-client");

class AsyncEventQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;
  }

  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  complete() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true });
  }

  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  hasPending() { return this.items.length > 0; }

  [Symbol.asyncIterator]() { return this; }
}

function renderText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(renderText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (value.content !== undefined) return renderText(value.content);
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  return String(value);
}

// opencode ACP 事件与 kimi ACP 结构兼容（均走 session/update notification）
function convertOpenCodeSessionUpdate(update = {}) {
  const kind = update.sessionUpdate;

  if (kind === "agent_message_chunk") {
    const text = renderText(update.content);
    return text ? [{ type: "delta", payload: { text } }] : [];
  }

  if (kind === "agent_thought_chunk") {
    const text = renderText(update.content);
    return text ? [{ type: "activity", payload: { message: text, kind: "agent" } }] : [];
  }

  if (kind === "tool_call") {
    return [{
      type: "tool_use",
      payload: {
        tool_name: update.title || update.kind || "tool",
        tool_input: update.rawInput && typeof update.rawInput === "object" ? update.rawInput : { kind: update.kind || "other" },
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
          content: renderText(update.content),
          is_error: status === "failed"
        }
      }];
    }
    return [{ type: "activity", payload: { message: "工具执行中", kind: "tool_progress" } }];
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
    const summary = entries.filter((e) => e?.content).map((e) => String(e.content)).join("\n");
    return summary ? [{ type: "activity", payload: { message: `计划：\n${summary}`, kind: "status" } }] : [];
  }

  return [];
}

class OpenCodeRuntime {
  static activeSessions = new Map();

  constructor({ pathOverride, clientFactory, provider = "opencode" } = {}) {
    this.provider = provider;
    this.pathOverride = pathOverride || process.env.OPENCODE_CLI_PATH || undefined;
    this.clientFactory = clientFactory || ((opts) => new OpenCodeAcpClient(opts));
  }

  async *run({ session, project, message, settings = {}, requestApproval } = {}) {
    const client = this.clientFactory({ pathOverride: this.pathOverride });
    let activeSessionId = null;
    const emitQueue = new AsyncEventQueue();
    let suppressNotifications = false;

    const onNotification = (msg) => {
      if (suppressNotifications) return;
      const update = msg.params?.update;
      if (!update) return;
      for (const event of convertOpenCodeSessionUpdate(update)) {
        emitQueue.push(event);
      }
    };

    const onRequest = (msg) => {
      if (msg.method === "session/request_permission") {
        const params = msg.params || {};
        const optionId = (params.options || [])[0]?.optionId;
        if (typeof requestApproval !== "function" || !optionId) {
          client.respond(msg.id, { outcome: { outcome: "selected", optionId: optionId || "approve_once" } });
          return;
        }
        requestApproval({
          kind: "tool_permission",
          command: `opencode 请求执行操作：${params.toolCall?.title || "tool"}`,
          tool_name: params.toolCall?.title || "tool",
          tool_input: params.toolCall?.rawInput || {},
          tool_use_id: params.toolCall?.toolCallId || null,
          available_decisions: ["approved", "rejected"],
          raw: params
        }).then((decision) => {
          const outcome = decision?.decision === "approved" ? "approve_once" : "reject";
          client.respond(msg.id, { outcome: { outcome: "selected", optionId: outcome } });
        }).catch(() => {
          client.respond(msg.id, { outcome: { outcome: "cancelled" } });
        });
      }
    };

    client.on("notification", onNotification);
    client.on("request", onRequest);

    yield { type: "activity", payload: { message: `启动 opencode：${project?.path || ""}`, kind: "status" } };

    try {
      await client.initialize();

      suppressNotifications = true;
      let sessionId;
      if (session?.runtime_session_id) {
        try {
          const loaded = await client.request("session/load", {
            sessionId: session.runtime_session_id,
            cwd: project?.path || process.cwd(),
            mcpServers: []
          });
          sessionId = loaded.sessionId || session.runtime_session_id;
        } catch {
          const created = await client.request("session/new", { cwd: project?.path || process.cwd(), mcpServers: [] });
          sessionId = created.sessionId;
        }
      } else {
        const created = await client.request("session/new", { cwd: project?.path || process.cwd(), mcpServers: [] });
        sessionId = created.sessionId;
      }
      suppressNotifications = false;
      activeSessionId = sessionId;

      yield { type: "runtime_session", payload: { runtime_session_id: sessionId, working_directory: project?.path || "" } };

      const activeEntry = { client, sessionId, cancelled: false, promptRequestId: null };
      if (session?.id) OpenCodeRuntime.activeSessions.set(session.id, activeEntry);

      const promptRequestId = String(client.nextRequestId);
      activeEntry.promptRequestId = promptRequestId;
      const promptPromise = client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: String(message || "") }]
      });

      const iterator = emitQueue[Symbol.asyncIterator]();
      let promptSettled = false;
      const promptSettledPromise = promptPromise.then(() => { promptSettled = true; });
      let pendingNext = iterator.next();
      while (true) {
        const winner = await Promise.race([
          pendingNext.then((r) => ({ kind: "event", r })),
          promptSettledPromise.then(() => ({ kind: "prompt" }))
        ]);
        if (winner.kind === "event") {
          if (winner.r.done) break;
          yield winner.r.value;
          pendingNext = iterator.next();
        } else {
          while (true) {
            if (emitQueue.hasPending()) {
              const buffered = await iterator.next();
              if (buffered.done) break;
              yield buffered.value;
              continue;
            }
            const tail = await Promise.race([
              pendingNext.then((r) => ({ kind: "event", r })),
              new Promise((resolve) => setTimeout(() => resolve({ kind: "idle" }), 150))
            ]);
            if (tail.kind === "idle" || tail.r?.done) break;
            yield tail.r.value;
            pendingNext = iterator.next();
          }
          break;
        }
      }

      if (activeEntry.cancelled) {
        yield { type: "cancelled", payload: { message: "opencode 已取消。" } };
        yield { type: "complete", payload: { message: "opencode 执行完成（已取消）。" } };
        return;
      }
      yield { type: "complete", payload: { message: "opencode 执行完成。" } };
    } catch (error) {
      if (error?.code === -32800 || /cancelled/i.test(error?.message || "")) {
        yield { type: "cancelled", payload: { message: "opencode 已取消。" } };
        yield { type: "complete", payload: { message: "opencode 执行完成（已取消）。" } };
        return;
      }
      yield { type: "error", payload: { message: error.message || "opencode 执行失败" } };
    } finally {
      emitQueue.complete();
      if (activeSessionId && !client.closed) {
        try { await client.request("session/close", { sessionId: activeSessionId }); } catch { /* best effort */ }
      }
      if (session?.id) OpenCodeRuntime.activeSessions.delete(session.id);
      client.close();
    }
  }

  async discoverCapabilities() {
    return buildCapabilities(this.provider);
  }

  async cancelTurn({ session } = {}) {
    const active = session?.id ? OpenCodeRuntime.activeSessions.get(session.id) : null;
    if (!active) {
      const error = new Error("没有可取消的 opencode turn。");
      error.statusCode = 409;
      throw error;
    }
    active.cancelled = true;
    if (active.promptRequestId) {
      try { active.client.notify("$/cancel_request", { requestId: active.promptRequestId }); } catch { /* ignore */ }
    } else {
      try { await active.client.request("session/cancel", { sessionId: active.sessionId }); } catch { active.client.close(); }
    }
    return {};
  }
}

module.exports = {
  OpenCodeRuntime,
  convertOpenCodeSessionUpdate,
  resolveOpenCodeExecutable: require("./opencode-acp-client").resolveOpenCodeExecutable,
  opencodeExecutableCandidates: require("./opencode-acp-client").opencodeExecutableCandidates
};
