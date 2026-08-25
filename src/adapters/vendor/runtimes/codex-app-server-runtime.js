const { EventEmitter } = require("node:events");
const { buildCapabilities, codexPolicyForMode } = require("../shared/capabilities");
const { CodexAppServerClient } = require("./codex-app-server-client");

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

  [Symbol.asyncIterator]() {
    return this;
  }
}

function appServerApprovalPolicy(settings = {}) {
  return settings.approval_policy || "on-request";
}

function appServerApprovalsReviewer(settings = {}) {
  return settings.mode === "auto-review" ? "auto_review" : null;
}

function appServerSandboxMode(mode) {
  const policy = codexPolicyForMode(mode);
  if (policy.sandbox === "read-only") {
    return "read-only";
  }
  if (policy.sandbox === "danger-full-access") {
    return "danger-full-access";
  }
  return "workspace-write";
}

function appServerSandboxPolicy({ projectPath, settings }) {
  const policy = codexPolicyForMode(settings.mode);
  if (policy.sandbox === "read-only") {
    return {
      type: "readOnly",
      networkAccess: false
    };
  }
  if (policy.sandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [projectPath],
    networkAccess: Boolean(policy.networkAccess),
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function appServerTextInput(text) {
  return {
    type: "text",
    text: String(text || ""),
    text_elements: []
  };
}

function appServerLocalImageInput(image = {}) {
  return {
    type: "localImage",
    path: String(image.path || "")
  };
}

function appServerInputItems(message, attachments = []) {
  const items = [appServerTextInput(message)];
  for (const image of attachments || []) {
    if (image?.path) {
      items.push(appServerLocalImageInput(image));
    }
  }
  return items;
}

function buildThreadStartParams({ projectPath, settings }) {
  const approvalsReviewer = appServerApprovalsReviewer(settings);
  return {
    model: settings.model,
    cwd: projectPath,
    approvalPolicy: appServerApprovalPolicy(settings),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    sandbox: appServerSandboxMode(settings.mode),
    serviceName: "agent_anywhere"
  };
}

function buildThreadResumeParams({ runtimeSessionId, projectPath, settings }) {
  const approvalsReviewer = appServerApprovalsReviewer(settings);
  return {
    threadId: runtimeSessionId,
    model: settings.model,
    cwd: projectPath,
    approvalPolicy: appServerApprovalPolicy(settings),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    sandbox: appServerSandboxMode(settings.mode),
    serviceName: "agent_anywhere"
  };
}

function buildTurnStartParams({ threadId, projectPath, message, attachments = [], settings }) {
  const approvalsReviewer = appServerApprovalsReviewer(settings);
  return {
    threadId,
    input: appServerInputItems(message, attachments),
    cwd: projectPath,
    approvalPolicy: appServerApprovalPolicy(settings),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    sandboxPolicy: appServerSandboxPolicy({ projectPath, settings }),
    model: settings.model,
    effort: settings.reasoning_effort
  };
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

function extractThreadId(result) {
  return result?.thread?.id || result?.threadId || result?.id || null;
}

function extractTurnId(result) {
  return result?.turn?.id || result?.turnId || result?.id || null;
}

function extractTurnStatus(params = {}) {
  return params.turn?.status || params.status || null;
}

async function settleThreadHistory(client, threadId) {
  if (!threadId) {
    return;
  }
  try {
    await client.request("thread/read", {
      threadId,
      includeTurns: true
    });
  } catch {
    // Best-effort: the live turn already completed, so history settling must not
    // turn a successful user-visible run into a failure.
  }
}

function extractTurnError(params = {}) {
  return params.turn?.error?.message || params.error?.message || params.error || null;
}

function convertThreadItem(item = {}, lifecycle) {
  const itemId = item.id || null;
  const itemType = item.type;
  const status = item.status || (lifecycle === "completed" ? "completed" : "inProgress");

  if (itemType === "agentMessage") {
    if (lifecycle !== "completed") {
      return [];
    }
    const text = String(item.text || "");
    return text ? [{ type: "delta", payload: { text } }] : [];
  }

  if (itemType === "reasoning") {
    const text = renderValue(item.summary || item.content);
    return text ? [{ type: "activity", payload: { message: text, kind: "agent" } }] : [];
  }

  if (itemType === "commandExecution") {
    if (lifecycle === "started") {
      return [{
        type: "tool_use",
        payload: {
          tool_name: "exec_command",
          tool_input: { cmd: item.command || "", cwd: item.cwd || null },
          tool_use_id: itemId
        }
      }];
    }
    if (lifecycle === "completed") {
      return [{
        type: "tool_result",
        payload: {
          tool_use_id: itemId,
          content: String(item.aggregatedOutput || ""),
          is_error: status === "failed" || (Number.isInteger(item.exitCode) && item.exitCode !== 0)
        }
      }];
    }
    return [{ type: "activity", payload: { message: "命令执行中", kind: "tool_progress" } }];
  }

  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    const toolName = item.tool || itemType;
    if (lifecycle === "started") {
      return [{
        type: "tool_use",
        payload: {
          tool_name: toolName,
          tool_input: item.arguments || {},
          tool_use_id: itemId
        }
      }];
    }
    if (lifecycle === "completed") {
      return [{
        type: "tool_result",
        payload: {
          tool_use_id: itemId,
          content: item.error?.message || renderValue(item.result?.content || item.contentItems || item.result),
          is_error: status === "failed" || Boolean(item.error) || item.success === false
        }
      }];
    }
  }

  if (itemType === "webSearch") {
    if (lifecycle === "started") {
      return [{
        type: "tool_use",
        payload: {
          tool_name: "web_search",
          tool_input: { query: item.query || "" },
          tool_use_id: itemId
        }
      }];
    }
    if (lifecycle === "completed") {
      return [{
        type: "tool_result",
        payload: {
          tool_use_id: itemId,
          content: `搜索完成：${item.query || ""}`,
          is_error: false
        }
      }];
    }
  }

  if (itemType === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const summary = changes
      .map((change) => `${change.type || "update"} ${change.path || change.move_path || ""}`.trim())
      .filter(Boolean)
      .join(", ");
    return [{
      type: "activity",
      payload: {
        message: status === "failed"
          ? `文件修改失败${summary ? `：${summary}` : ""}`
          : `文件修改${lifecycle === "started" ? "开始" : "完成"}${summary ? `：${summary}` : ""}`,
        kind: "tool_progress"
      }
    }];
  }

  return [];
}

function convertAppServerNotification(message, state = {}) {
  const method = message?.method;
  const params = message?.params || {};
  if (method === "thread/started") {
    const threadId = params.thread?.id || params.threadId || null;
    return [{
      type: "runtime_session",
      payload: {
        runtime_session_id: threadId,
        working_directory: params.thread?.cwd || params.cwd || ""
      }
    }];
  }

  if (method === "turn/started") {
    return [{ type: "activity", payload: { message: "Codex app-server 开始处理任务", kind: "status" } }];
  }

  if (method === "item/agentMessage/delta") {
    if (params.itemId) {
      state.deltaItemIds?.add(params.itemId);
    }
    return [{ type: "delta", payload: { text: params.delta || "" } }];
  }

  if (method === "item/started") {
    return convertThreadItem(params.item, "started");
  }

  if (method === "item/completed") {
    if (params.item?.type === "agentMessage" && state.deltaItemIds?.has(params.item.id)) {
      return [];
    }
    return convertThreadItem(params.item, "completed");
  }

  if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
    return params.delta
      ? [{
        type: "activity",
        payload: {
          message: params.delta,
          kind: "tool_progress",
          tool_use_id: params.itemId || params.item?.id || null
        }
      }]
      : [];
  }

  if (method === "turn/completed") {
    const events = [];
    if (params.usage || params.turn?.usage) {
      events.push({ type: "usage", payload: { usage: params.usage || params.turn.usage } });
    }
    const status = extractTurnStatus(params);
    events.push({
      type: status === "interrupted" ? "cancelled" : "complete",
      payload: {
        message: status === "interrupted" ? "Codex 执行已取消。" : "Codex 执行完成。",
        status: status || "completed"
      }
    });
    return events;
  }

  if (method === "turn/failed" || method === "error") {
    return [{ type: "error", payload: { message: extractTurnError(params) || params.message || "Codex app-server 执行失败" } }];
  }

  if (method === "serverRequest/resolved") {
    return [{ type: "activity", payload: { message: "权限请求已处理", kind: "status" } }];
  }

  if (method === "thread/status/changed") {
    const status = params.status || params.thread?.status || "unknown";
    return [{ type: "activity", payload: { message: `Codex thread 状态：${status}`, kind: "status" } }];
  }

  return [];
}

function convertApprovalRequest(message) {
  const params = message?.params || {};
  if (message?.method === "item/commandExecution/requestApproval") {
    return {
      type: "approval_request",
      payload: {
        runtime_request_id: message.id,
        kind: params.networkApprovalContext ? "network_access" : "command_execution",
        thread_id: params.threadId,
        turn_id: params.turnId,
        item_id: params.itemId,
        approval_id: params.approvalId || null,
        reason: params.reason || "",
        command: params.command || "",
        cwd: params.cwd || "",
        available_decisions: ["approved", "rejected"],
        runtime_available_decisions: ["accept", "acceptForSession", "decline", "cancel"],
        raw: params
      }
    };
  }
  if (message?.method === "item/fileChange/requestApproval") {
    return {
      type: "approval_request",
      payload: {
        runtime_request_id: message.id,
        kind: "file_change",
        thread_id: params.threadId,
        turn_id: params.turnId,
        item_id: params.itemId,
        reason: params.reason || "",
        command: params.grantRoot ? `允许写入 ${params.grantRoot}` : "批准文件修改",
        cwd: "",
        available_decisions: ["approved", "rejected"],
        runtime_available_decisions: ["accept", "acceptForSession", "decline", "cancel"],
        raw: params
      }
    };
  }
  if (message?.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const command = questions
      .map((question) => question.question || question.header || question.id)
      .filter(Boolean)
      .join("\n");
    return {
      type: "approval_request",
      payload: {
        runtime_request_id: message.id,
        kind: "tool_user_input",
        thread_id: params.threadId,
        turn_id: params.turnId,
        item_id: params.itemId,
        reason: "工具需要用户确认或输入",
        command: command || "工具需要用户确认或输入",
        cwd: "",
        available_decisions: ["approved", "rejected"],
        runtime_available_decisions: questions.map((question) => ({
          id: question.id,
          options: Array.isArray(question.options) ? question.options.map((option) => option.label) : []
        })),
        questions,
        raw: params
      }
    };
  }
  return null;
}

function approvalDecisionForAppServer(decision) {
  if (decision === "approved" || decision === "approve" || decision === "accept") {
    return "accept";
  }
  if (decision === "cancel") {
    return "cancel";
  }
  return "decline";
}

function selectToolUserInputAnswer(question, decision) {
  const labels = (Array.isArray(question?.options) ? question.options : [])
    .map((option) => String(option.label || "").trim())
    .filter(Boolean);
  const lowerDecision = String(decision || "").toLowerCase();
  const preferred = lowerDecision === "approved" || lowerDecision === "approve" || lowerDecision === "accept"
    ? labels.find((label) => /^(accept|approve|allow|yes|ok)$/i.test(label)) || labels[0]
    : lowerDecision === "cancel"
      ? labels.find((label) => /cancel/i.test(label))
      : labels.find((label) => /^(decline|reject|deny|no)$/i.test(label)) || labels.find((label) => /decline|reject|deny/i.test(label));
  return preferred || (lowerDecision === "cancel" ? "Cancel" : lowerDecision === "approved" ? "Accept" : "Decline");
}

function approvalResponseForAppServer(request, approvalResult) {
  const decision = approvalResult?.decision || approvalResult?.status;
  if (request?.method === "item/tool/requestUserInput") {
    const answers = {};
    for (const question of request.params?.questions || []) {
      if (!question?.id) {
        continue;
      }
      answers[question.id] = {
        answers: [selectToolUserInputAnswer(question, decision)]
      };
    }
    return { answers };
  }
  return {
    decision: approvalDecisionForAppServer(decision)
  };
}

class CodexAppServerRuntime extends EventEmitter {
  static activeTurns = new Map();

  constructor({ codexPathOverride, clientFactory, provider = "codex-app-server" } = {}) {
    super();
    this.provider = provider;
    this.codexPathOverride = codexPathOverride || process.env.CODEX_CLI_PATH || undefined;
    this.clientFactory = clientFactory || (() => new CodexAppServerClient({
      codexPathOverride: this.codexPathOverride
    }));
  }

  createClient() {
    return this.clientFactory();
  }

  async *run({ session, project, message, attachments = [], settings, requestApproval } = {}) {
    const client = this.createClient();
    const queue = new AsyncEventQueue();
    const state = {
      deltaItemIds: new Set(),
      runtimeSessionId: null
    };

    client.on("notification", (notification) => {
      if (
        notification.method === "thread/started" &&
        state.runtimeSessionId &&
        extractThreadId(notification.params) === state.runtimeSessionId
      ) {
        return;
      }
      for (const event of convertAppServerNotification(notification, state)) {
        queue.push(event);
      }
      if (notification.method === "turn/completed") {
        const status = extractTurnStatus(notification.params);
        if (status === "failed") {
          queue.fail(new Error(extractTurnError(notification.params) || "Codex app-server 执行失败"));
          return;
        }
        queue.complete();
      }
      if (notification.method === "turn/failed" || notification.method === "error") {
        queue.fail(new Error(extractTurnError(notification.params) || notification.params?.message || "Codex app-server 执行失败"));
      }
    });

    client.on("request", async (request) => {
      const approval = convertApprovalRequest(request);
      if (!approval) {
        client.respondError(request.id, new Error(`暂不支持 app-server request：${request.method}`));
        return;
      }
      try {
        let approvalResult;
        if (requestApproval) {
          approvalResult = await requestApproval(approval.payload);
        } else {
          queue.push(approval);
          approvalResult = { decision: "rejected" };
        }
        client.respond(request.id, approvalResponseForAppServer(request, approvalResult));
      } catch (error) {
        client.respondError(request.id, error);
        queue.fail(error);
      }
    });

    client.on("error", (error) => queue.fail(error));

    try {
      await client.initialize();
      const threadResult = session?.runtime_session_id
        ? await client.request("thread/resume", buildThreadResumeParams({
          runtimeSessionId: session.runtime_session_id,
          projectPath: project.path,
          settings
        }))
        : await client.request("thread/start", buildThreadStartParams({
          projectPath: project.path,
          settings
        }));
      const threadId = extractThreadId(threadResult);
      if (!threadId) {
        throw new Error("codex app-server 未返回 thread id");
      }
      state.runtimeSessionId = threadId;
      yield {
        type: "runtime_session",
        payload: {
          runtime_session_id: threadId,
          working_directory: project.path
        }
      };

      const turnResult = await client.request("turn/start", buildTurnStartParams({
        threadId,
        projectPath: project.path,
        message,
        attachments,
        settings
      }));
      const turnId = extractTurnId(turnResult);
      if (!turnId) {
        throw new Error("codex app-server 未返回 turn id");
      }
      if (session?.id) {
        CodexAppServerRuntime.activeTurns.set(session.id, { client, threadId, turnId });
      }

      for await (const event of queue) {
        yield event;
      }
      await settleThreadHistory(client, threadId);
    } finally {
      if (session?.id) {
        CodexAppServerRuntime.activeTurns.delete(session.id);
      }
      client.close();
    }
  }

  async discoverCapabilities() {
    const client = this.createClient();
    try {
      await client.initialize();
      const result = await client.request("model/list", { limit: 100, includeHidden: false });
      const rows = Array.isArray(result?.data) ? result.data : [];
      const models = [];
      const reasoningEfforts = [];
      const inputModalities = [];
      let defaultModel = null;
      for (const row of rows.filter((item) => item?.hidden !== true)) {
        const model = String(row.model || row.id || "").trim();
        if (model && !models.includes(model)) {
          models.push(model);
        }
        if (model && row.isDefault === true) {
          defaultModel = model;
        }
        for (const modality of row.inputModalities || []) {
          const value = String(modality || "").trim();
          if (value && !inputModalities.includes(value)) {
            inputModalities.push(value);
          }
        }
        for (const effortRow of row.supportedReasoningEfforts || []) {
          const effort = String(effortRow.reasoningEffort || "").trim();
          if (effort && !reasoningEfforts.includes(effort)) {
            reasoningEfforts.push(effort);
          }
        }
      }
      const capabilities = buildCapabilities(this.provider, {
        models,
        default_model: defaultModel,
        input_modalities: inputModalities,
        reasoning_efforts: reasoningEfforts
      });
      // Live Agent API is authoritative. Do not silently replace an empty
      // response with the shared legacy Codex fallback list.
      capabilities.models = models;
      capabilities.default_model = defaultModel || models[0] || null;
      capabilities.reasoning_efforts = reasoningEfforts;
      return capabilities;
    } finally {
      client.close();
    }
  }

  async cancelTurn({ session, threadId, turnId }) {
    const active = session?.id ? CodexAppServerRuntime.activeTurns.get(session.id) : null;
    if (active) {
      await active.client.request("turn/interrupt", {
        threadId: active.threadId,
        turnId: active.turnId
      });
      return {};
    }
    if (threadId && turnId) {
      const client = this.createClient();
      try {
        await client.initialize();
        await client.request("turn/interrupt", { threadId, turnId });
        return {};
      } finally {
        client.close();
      }
    }
    const error = new Error("没有可取消的 Codex app-server turn。");
    error.statusCode = 409;
    throw error;
  }

  async steerTurn({ session, threadId, turnId, message, attachments = [] }) {
    const active = session?.id ? CodexAppServerRuntime.activeTurns.get(session.id) : null;
    if (active) {
      return active.client.request("turn/steer", {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        input: appServerInputItems(message, attachments)
      });
    }
    if (threadId && turnId) {
      const client = this.createClient();
      try {
        await client.initialize();
        return await client.request("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: appServerInputItems(message, attachments)
        });
      } finally {
        client.close();
      }
    }
    const error = new Error("没有可追加输入的 Codex app-server turn。");
    error.statusCode = 409;
    throw error;
  }

  async listRuntimeSessions({ project, limit = 50 } = {}) {
    const client = this.createClient();
    try {
      await client.initialize();
      const result = await client.request("thread/list", {
        limit,
        cwd: project?.path || null
      });
      return Array.isArray(result?.data) ? result.data : [];
    } finally {
      client.close();
    }
  }

  async readRuntimeSession({ runtimeSessionId, includeTurns = true } = {}) {
    if (!runtimeSessionId) {
      const error = new Error("runtimeSessionId 不能为空。");
      error.statusCode = 400;
      throw error;
    }
    const client = this.createClient();
    try {
      await client.initialize();
      return await client.request("thread/read", {
        threadId: runtimeSessionId,
        includeTurns
      });
    } finally {
      client.close();
    }
  }
}

module.exports = {
  AsyncEventQueue,
  CodexAppServerRuntime,
  appServerApprovalPolicy,
  appServerApprovalsReviewer,
  appServerInputItems,
  appServerSandboxPolicy,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  convertAppServerNotification,
  convertApprovalRequest,
  approvalDecisionForAppServer,
  approvalResponseForAppServer
};
