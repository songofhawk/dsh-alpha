// 审批 broker：远端 agent 权限请求冒泡到主控会话，故障默认 deny。
// 阶段 0：请求挂起一个 pending record，由主控会话经 agent_approve 决策；
// 故障/超时默认 reject。阶段 2 起与事件回流、跨机通道联动。

function createApprovalBroker({ store, defaultTimeoutMs = 10 * 60 * 1000 } = {}) {
  const pendings = new Map(); // approvalId -> { taskId, resolve, reject, record, timer }

  function resumeTaskWhenClear(taskId) {
    if ([...pendings.values()].some((pending) => pending.taskId === taskId)) return;
    const task = store.getTask(taskId);
    if (task.status === "blocked") store.setStatus(taskId, "running");
  }

  async function request(taskId, payload = {}) {
    const approvalId = payload.runtime_request_id || `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (pendings.has(approvalId)) {
      return pendings.get(approvalId).promise;
    }
    const record = {
      id: approvalId,
      taskId,
      kind: payload.kind || "command_execution",
      command: payload.command || null,
      cwd: payload.cwd || null,
      reason: payload.reason || null,
      available_decisions: payload.available_decisions || ["approved", "rejected"],
      status: "pending",
      createdAt: Date.now()
    };
    store.appendEvent(taskId, { type: "approval_request", payload: { ...record } });

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendings.delete(approvalId);
        store.appendEvent(taskId, { type: "approval_decision", payload: { approvalId, decision: "rejected", reason: "timeout" } });
        resumeTaskWhenClear(taskId);
        reject(Object.assign(new Error(`审批超时（默认拒绝）：${approvalId}`), { statusCode: 403, approvalId }));
      }, defaultTimeoutMs);
      if (timer.unref) timer.unref();
      pendings.set(approvalId, { taskId, resolve, reject, record, timer, promise: null });
    });
    pendings.get(approvalId).promise = promise;
    return promise;
  }

  function decide(approvalId, decision) {
    const pending = pendings.get(approvalId);
    if (!pending) {
      const error = new Error(`不存在待决审批：${approvalId}`);
      error.statusCode = 404;
      throw error;
    }
    const resolved = normalizeDecision(decision);
    clearTimeout(pending.timer);
    pendings.delete(approvalId);
    store.appendEvent(pending.taskId, { type: "approval_decision", payload: { approvalId, decision: resolved } });
    resumeTaskWhenClear(pending.taskId);

    if (resolved === "approved") {
      pending.resolve({ status: "approved", decision: "approved" });
    } else if (resolved === "cancel" || resolved === "cancelled") {
      pending.resolve({ status: "cancelled", decision: "cancel" });
    } else {
      pending.resolve({ status: "rejected", decision: "rejected" });
    }
    return { approvalId, decision: resolved };
  }

  function listPending() {
    return [...pendings.values()].map(({ record }) => record);
  }

  function isPending(approvalId) {
    return pendings.has(approvalId);
  }

  return { request, decide, listPending, isPending };
}

function normalizeDecision(decision) {
  const value = String(decision || "").trim().toLowerCase();
  if (["cancel", "cancelled"].includes(value)) return "cancel";
  if (value === "reject" || value === "rejected" || value === "deny" || value === "denied" || value === "false") return "rejected";
  if (["approve", "approved", "allow", "allow_once", "true"].includes(value)) return "approved";
  // 安全边界必须 fail closed：空值、拼写错误和未来新增但尚未识别的值都不能放行。
  return "rejected";
}

module.exports = { createApprovalBroker, normalizeDecision };
