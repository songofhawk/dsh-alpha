// 任务引擎：dispatch / status / result / cancel —— 本机 agent 的事件驱动力。
// 阶段 1 起，同一契约被 gateway 通道接管（跨机时引擎把任务转发给 hub）；
// 阶段 3 起：repo 身份选机 + 按需 clone 标记 + 主控递归（dsh-master 代理）。

const path = require("node:path");
const { buildCapabilities, normalizeAgentSettings } = require("../adapters/vendor/shared/capabilities");
const { isInside, resolveProjectPath } = require("../adapters/vendor/shared/path-policy");
const { normalizeRepoUrl } = require("../adapters/vendor/shared/repo-identity");
const { createLocalAgentAdapter } = require("./adapters");

const AUTH_ERROR_PATTERN = /authentication required|not logged in|unauthori[sz]ed|invalid credentials?|expired (?:token|credential)|oauth.*(?:expired|invalid)/i;

function markAuthenticationFailure(catalog, agent, message) {
  const text = String(message || "");
  if (!AUTH_ERROR_PATTERN.test(text)) return;
  catalog.markAgentUnavailable?.(agent.agentId, `认证不可用：${text}`);
}

function cloneableRepoUrl(raw, canonical) {
  const text = String(raw || "").trim();
  if (text.includes("://")) {
    const parsed = new URL(text);
    if (parsed.username || parsed.password) {
      const error = new Error("repo URL 不允许内嵌用户名、密码或 token；请使用本机 Git 凭据");
      error.statusCode = 400;
      throw error;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
      const error = new Error(`repo URL 协议不支持 clone：${parsed.protocol}`);
      error.statusCode = 400;
      throw error;
    }
    return text;
  }
  // scp-like SSH（git@host:owner/repo.git）本身即可 clone；canonical key 则补成 HTTPS。
  if (/^([^/@\s]+@)?[A-Za-z0-9][\w.-]*(?::\d+)?:[^:\s].*$/.test(text)) return text;
  return `https://${canonical}.git`;
}

function createTaskEngine({
  catalog,
  workspaces = null,
  store,
  approvals,
  allowedRoots = null,
  defaults = {},
  adapterFor = null // (agent) => { runTurn, cancelTurn }；缺省用本机 adapter
}) {
  const running = new Map(); // taskId -> { adapter, cancelRequested }

  // 远端 agent（阶段 1）：adapterFor 由 host 平面按 agent.machineId 路由 gateway
  const resolveAdapter = adapterFor || ((agent) => createLocalAgentAdapter(agent.provider));

  function resolveRoots() {
    return allowedRoots || catalog.machine().allowedRoots;
  }

  function resolveRemoteProjectPath(agent, requestedPath) {
    const roots = (catalog.machineFor(agent.machineId).allowedRoots || []).map((root) => path.resolve(root));
    if (!roots.length) {
      const error = new Error(`远端机器 ${agent.machineId} 未广播 allowed roots`);
      error.statusCode = 409;
      throw error;
    }
    const resolved = path.resolve(requestedPath || roots[0]);
    if (!roots.some((root) => isInside(resolved, root))) {
      const error = new Error(`远端项目路径不在机器 ${agent.machineId} 的允许根目录内：${resolved}`);
      error.statusCode = 400;
      throw error;
    }
    // 远端文件系统的 realpath 只能由 worker 校验；主控这里只做广播边界的词法预检。
    return resolved;
  }

  // 阶段 3 auto-pick：未指定 agentId 时按目录排序自动选机
  function pickAgent({ provider = null, repoUrl = null, machineIds = [], restrictMachines = false }) {
    const dispatchable = (rows) => rows.filter((row) => provider === "dsh-master" || row.provider !== "dsh-master");
    const allowedMachines = new Set(machineIds);
    const inScope = (row) => !machineIds.length || allowedMachines.has(row.machineId);
    const ranked = dispatchable(catalog.rankAgents({ provider, repoUrl })).filter(inScope);
    // rankAgents 含不带 repo 的机器（仅排序）；只有第一名持有 repo 才算 repo 命中
    if (ranked.length && ranked[0].repoPath) {
      const pick = catalog.getAgent(ranked[0].agentId);
      return { agent: pick, needsClone: false };
    }
    // 无人持有目标 repo 且允许按需 clone：退回最空闲的在线 agent，标记按需 clone
    const all = dispatchable(catalog.rankAgents({ provider })).filter(inScope);
    const preferred = all;
    if (preferred.length) {
      const pick = catalog.getAgent(preferred[0].agentId);
      return { agent: pick, needsClone: Boolean(repoUrl && normalizeRepoUrl(repoUrl)) };
    }
    if (restrictMachines || machineIds.length) {
      const error = new Error(machineIds.length ? "所选工作机当前没有可用 Agent" : "所选全局工作区当前没有可用 Agent");
      error.statusCode = 503;
      throw error;
    }
    if (all.length) {
      const pick = catalog.getAgent(all[0].agentId);
      return { agent: pick, needsClone: Boolean(repoUrl && normalizeRepoUrl(repoUrl)) };
    }
    const error = new Error(`没有可用 agent${provider ? `（provider=${provider}）` : ""}`);
    error.statusCode = 503;
    throw error;
  }

  function dispatch({ agentId = null, provider = null, workspaceId = null, sessionId = null, repoUrl = null, prompt, projectPath, model, mode, approvalPolicy, recursion = null, allowClone = true }) {
    if (!prompt || !String(prompt).trim()) throw new Error("prompt 必填");
    const workspaceResolution = workspaces?.resolve({ sessionId, workspaceId, prompt }) || { workspace: null, source: "none", ambiguous: [] };
    if (workspaceResolution.ambiguous?.length) {
      const choices = workspaceResolution.ambiguous.map((workspace) => `${workspace.name}（${workspace.workspaceId}）`).join("、");
      const error = new Error(`任务描述匹配到多个全局工作区，请明确选择：${choices}`);
      error.statusCode = 409;
      throw error;
    }
    const workspace = workspaceResolution.workspace;
    const selectedMachineId = workspaceResolution.machineId || null;
    const effectiveRepoUrl = workspace?.repoUrl || repoUrl;
    const workspaceMachines = workspace?.locations?.filter((location) => location.online).map((location) => location.machineId) || [];
    const machineIds = selectedMachineId ? [selectedMachineId] : workspaceMachines;
    const selectedAgentId = workspaceResolution.agentId || null;
    const requestedAgentId = selectedAgentId || agentId;
    // 用户在 Web 中选定了工作机/工作区后，选择范围优先于 LLM 可能自行填写的 agentId；
    // 越界 agentId 不能绕过已选 Worker，但范围内的 provider 选择仍应保留。
    const hasSelectionScope = Boolean(selectedMachineId || workspace || selectedAgentId);
    const explicitAgent = requestedAgentId ? catalog.getAgent(requestedAgentId) : null;
    const explicitAgentInScope = explicitAgent && (!machineIds.length || machineIds.includes(explicitAgent.machineId)) &&
      (!workspace || workspace.repoUrl || workspace.locations.some((location) => location.machineId === explicitAgent.machineId));
    const useExplicitAgent = explicitAgent && (selectedAgentId || !hasSelectionScope || explicitAgentInScope);
    const picked = useExplicitAgent
      ? { agent: explicitAgent, needsClone: false }
      : pickAgent({
        provider,
        repoUrl: effectiveRepoUrl,
        machineIds,
        restrictMachines: Boolean(selectedMachineId || (workspace && !workspace.repoUrl))
      });
    const agent = picked.agent;
    if (selectedMachineId && agent.machineId !== selectedMachineId) {
      const error = new Error(`所选工作机为 ${selectedMachineId}，但指定 agent 属于 ${agent.machineId}`);
      error.statusCode = 409;
      throw error;
    }
    if (!agent.available) {
      const error = new Error(`agent ${agent.agentId} 不可用：${agent.unavailableReason || "未探测"}`);
      error.statusCode = 503;
      throw error;
    }
    if (agent.provider === "dsh-master" && !recursion) {
      const error = new Error("dsh-master 只接受带 recursion.delegate/prompt/depth 的控制器任务，不能执行普通派发");
      error.statusCode = 400;
      throw error;
    }
    const workspaceLocation = workspace?.locations?.find((location) => location.machineId === agent.machineId) || null;
    if (workspace && !workspace.repoUrl && !workspaceLocation) {
      const error = new Error(`agent ${agent.agentId} 所在机器没有工作区 ${workspace.name}`);
      error.statusCode = 409;
      throw error;
    }

    const settings = normalizeAgentSettings(
      {
        model: workspaceResolution.model || model,
        mode: workspaceResolution.mode || mode,
        approval_policy: workspaceResolution.approvalPolicy || approvalPolicy
      },
      defaults,
      agent.capabilities
    );

    // repo 身份：任务带 repoUrl 时优先落到持有该 repo 的机器，路径由机器本地解析；
    // 云端/远端无 repo 时置 needsClone，worker 侧按需 clone。
    const repoKey = effectiveRepoUrl ? normalizeRepoUrl(effectiveRepoUrl) : null;
    if (effectiveRepoUrl && !repoKey) {
      const error = new Error(`repo URL 不合法：${effectiveRepoUrl}`);
      error.statusCode = 400;
      throw error;
    }
    const repoCloneUrl = repoKey ? cloneableRepoUrl(effectiveRepoUrl, repoKey) : null;
    let projectPathResolved = null;
    let needsClone = false;
    if (workspaceLocation) {
      projectPathResolved = workspaceLocation.path;
    } else if (repoKey) {
      const targetMachine = agent.machineId === catalog.machineId ? catalog.machine() : catalog.machineFor(agent.machineId);
      const targetRepoPath = catalog.machineRepoPath({ machine: targetMachine }, repoKey);
      if (targetRepoPath) {
        projectPathResolved = targetRepoPath;
      } else if (allowClone && (picked.needsClone || agent.machineId !== catalog.machineId)) {
        // 远端机器无 repo 且允许按需 clone：把 repoUrl 交给 worker 落地
        needsClone = true;
      } else {
        // 未启用按需 clone 且机器无 repo：拒绝派发
        const error = new Error(`agent ${agent.agentId} 所在机器没有 repo：${repoKey}`);
        error.statusCode = 409;
        throw error;
      }
    } else {
      projectPathResolved = agent.machineId === catalog.machineId
        ? resolveProjectPath(projectPath || resolveRoots()[0] || path.dirname(process.cwd()), resolveRoots())
        : resolveRemoteProjectPath(agent, projectPath);
    }

    const task = store.createTask({
      agentId: agent.agentId,
      machineId: agent.machineId,
      provider: agent.provider,
      prompt,
      projectPath: projectPathResolved,
      settings,
      repoUrl: repoKey,
      repoCloneUrl,
      needsClone,
      recursion,
      workspaceId: workspace?.workspaceId || null,
      workspaceName: workspace?.name || null,
      workspaceSource: workspaceResolution.source
    });

    // 底层任务异步执行；模型工具走 dispatchAndWait，由 store 订阅事件唤醒而非轮询。
    runTask(task.id).catch(() => {});
    return {
      taskId: task.id,
      agentId: agent.agentId,
      status: "running",
      ...(workspace ? { workspaceId: workspace.workspaceId, workspaceName: workspace.name, projectPath: projectPathResolved } : {})
    };
  }

  async function runTask(taskId) {
    const task = store.getTask(taskId);
    const agent = catalog.getAgent(task.agentId);
    if (!agent.available) {
      store.setStatus(taskId, "failed", { error: `agent ${agent.agentId} 不可用：${agent.unavailableReason || "未探测"}` });
      return;
    }
    store.setStatus(taskId, "running");
    catalog.touchLoad(task.agentId, 1);

    const adapter = resolveAdapter(agent);
    const session = { id: taskId, provider: agent.provider };
    const project = { path: task.projectPath };
    const runtimeSettings = {
      ...task.settings,
      model: task.settings.model || agent.model
    };
    const handle = { adapter, cancelRequested: false };
    running.set(taskId, handle);

    // 阶段 3：把 repo 身份 / 按需 clone 标记 / 主控递归载荷透传给 adapter（远端即 worker）
    const forwarding = {};
    if (task.repoUrl) forwarding.repoUrl = task.repoCloneUrl || task.repoUrl;
    if (task.needsClone) forwarding.needsClone = true;
    if (task.projectPath) forwarding.projectPath = task.projectPath;
    if (task.recursion) forwarding.recursion = task.recursion;

    const requestApproval = async (payload) => {
      try {
        const decision = approvals.request(taskId, payload);
        store.setStatus(taskId, "blocked");
        return await decision;
      } catch (error) {
        // 超时/重复等异常按拒绝传导
        return { status: "rejected", decision: "rejected" };
      }
    };

    try {
      for await (const event of adapter.runTurn({
        session,
        project,
        message: task.prompt,
        attachments: [],
        settings: runtimeSettings,
        requestApproval,
        ...forwarding
      })) {
        const handled = applyEvent(taskId, event, { handle, agent });
        if (!handled) break; // 终态事件或取消请求已响应
      }
      // 流自然结束且无终态事件：按取消/异常兜底
      const current = store.getTask(taskId);
      if (current.status === "running") {
        if (handle.cancelRequested) store.setStatus(taskId, "cancelled", { error: "已取消" });
        else store.setStatus(taskId, "failed", { error: "runtime 流意外结束" });
      }
    } catch (error) {
      markAuthenticationFailure(catalog, agent, error.message);
      if (handle.cancelRequested && /cancel/i.test(error.message || "")) {
        store.setStatus(taskId, "cancelled", { error: error.message });
      } else {
        store.setStatus(taskId, "failed", { error: error.message });
      }
    } finally {
      catalog.touchLoad(task.agentId, -1);
      running.delete(taskId);
    }
  }

  function outcomeFor(taskId, receipt = {}) {
    const task = store.getTask(taskId);
    const outcome = {
      taskId,
      agentId: task.agentId,
      status: task.status,
      durationMs: Math.max(0, task.updatedAt - task.createdAt),
      ...receipt.workspaceId ? { workspaceId: receipt.workspaceId } : {},
      ...receipt.workspaceName ? { workspaceName: receipt.workspaceName } : {},
      ...receipt.projectPath ? { projectPath: receipt.projectPath } : {}
    };
    if (task.result !== null && task.result !== undefined) outcome.result = task.result;
    if (task.error) outcome.error = task.error;
    if (task.usage) outcome.usage = task.usage;
    if (Array.isArray(task.artifacts) && task.artifacts.length) outcome.artifacts = task.artifacts;
    if (task.status === "blocked") {
      outcome.pendingApprovals = approvals.listPending()
        .filter((approval) => approval.taskId === taskId)
        .map((approval) => ({
          id: approval.id,
          taskId: approval.taskId,
          kind: approval.kind,
          command: approval.command,
          reason: approval.reason
        }));
    }
    return outcome;
  }

  function waitForTask(taskId, { includeBlocked = true, ignoreCurrentBlocked = false, timeoutMs = 30 * 60 * 1000 } = {}) {
    const terminal = new Set(["completed", "failed", "cancelled"]);
    let progressedPastBlocked = !ignoreCurrentBlocked || store.getTask(taskId).status !== "blocked";
    return new Promise((resolve, reject) => {
      let settled = false;
      let dispose = () => {};
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        dispose();
        callback(value);
      };
      const inspect = (task) => {
        if (task.status !== "blocked") progressedPastBlocked = true;
        if (terminal.has(task.status) || includeBlocked && task.status === "blocked" && progressedPastBlocked) {
          finish(resolve, task);
        }
      };
      const timer = setTimeout(() => {
        const error = new Error(`等待远端任务超时：${taskId}`);
        error.statusCode = 504;
        finish(reject, error);
      }, Math.max(1, Number(timeoutMs) || 1));
      timer.unref?.();
      dispose = store.subscribe(taskId, inspect);
      inspect(store.getTask(taskId));
    });
  }

  async function dispatchAndWait(options) {
    const receipt = dispatch(options);
    await waitForTask(receipt.taskId, { includeBlocked: true });
    return outcomeFor(receipt.taskId, receipt);
  }

  async function decideApprovalAndWait(approvalId, decision) {
    const pending = approvals.listPending().find((approval) => approval.id === approvalId);
    if (!pending) return decideApproval(approvalId, decision);
    const decided = decideApproval(approvalId, decision);
    await waitForTask(pending.taskId, { includeBlocked: true, ignoreCurrentBlocked: true });
    return { ...decided, ...outcomeFor(pending.taskId) };
  }

  // 返回 false 表示流应立即结束
  function applyEvent(taskId, event, { handle, agent }) {
    const { type, payload } = event;
    switch (type) {
      case "complete":
        // 部分 runtime（如 Kimi ACP）把真实最终文本只放在 delta 流里，
        // complete.message 只是“执行完成”的通用占位。优先收敛已落库的 delta，
        // 让受控 Agent 的原始输出直接成为当前 dispatch_task 的 tool result。
        const streamedText = store.getTask(taskId).events
          .filter((item) => item.type === "delta" && item.payload?.text)
          .map((item) => item.payload.text)
          .join("");
        store.setResult(taskId, {
          message: streamedText || payload?.message || event.text || "",
          usage: payload?.usage || null,
          artifacts: payload?.artifacts || []
        });
        store.appendEvent(taskId, { type, payload });
        store.setStatus(taskId, "completed");
        return false;
      case "cancelled":
        store.appendEvent(taskId, { type, payload });
        store.setStatus(taskId, "cancelled", { error: payload?.message || null });
        return false;
      case "error":
        markAuthenticationFailure(catalog, agent, payload?.message || String(payload));
        store.appendEvent(taskId, { type, payload });
        store.setStatus(taskId, "failed", { error: payload?.message || String(payload) });
        return false;
      case "approval_request":
        // 已在 broker.request 落库；这里只保状态同步
        store.setStatus(taskId, "blocked");
        return true;
      case "approval_decision":
        store.setStatus(taskId, "running");
        store.appendEvent(taskId, { type, payload });
        return true;
      default:
        store.appendEvent(taskId, { type, payload });
        return true;
    }
  }

  async function cancelTask(taskId) {
    const task = store.getTask(taskId);
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      return { taskId, status: task.status };
    }
    const handle = running.get(taskId);
    if (!handle) {
      store.setStatus(taskId, "cancelled", { error: "未开始执行" });
      return { taskId, status: "cancelled" };
    }
    handle.cancelRequested = true;
    try {
      await handle.adapter.cancelTurn({ session: { id: taskId, provider: task.provider } });
    } catch (error) {
      store.appendEvent(taskId, { type: "activity", payload: { kind: "status", message: `取消失败：${error.message}` } });
    }
    return { taskId, status: task.status };
  }

  // 工具层要求返回值可无损耗 JSON 往返；显式 undefined 值会被 JSON.stringify 丢弃 → 以条件属性避免
  function taskStatus(taskId) {
    const task = store.getTask(taskId);
    const out = {
      taskId,
      agentId: task.agentId,
      state: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    };
    if (task.error) out.error = task.error;
    return out;
  }

  function taskResult(taskId) {
    const task = store.getTask(taskId);
    const out = { taskId };
    if (task.result !== undefined && task.result !== null) out.result = task.result;
    if (task.usage) out.usage = task.usage;
    if (Array.isArray(task.artifacts) && task.artifacts.length) out.artifacts = task.artifacts;
    if (Array.isArray(task.events) && task.events.length) out.events = task.events;
    return out;
  }

  function decideApproval(approvalId, decision) {
    return approvals.decide(approvalId, decision);
  }

  function listRuntimeTasks() {
    return store.listTasks().map((task) => ({
      taskId: task.id,
      agentId: task.agentId,
      provider: task.provider,
      prompt: task.prompt.slice(0, 120),
      status: task.status
    }));
  }

  return {
    dispatch,
    dispatchAndWait,
    waitForTask,
    cancelTask,
    taskStatus,
    taskResult,
    decideApproval,
    decideApprovalAndWait,
    listRuntimeTasks
  };
}

module.exports = { createTaskEngine };
