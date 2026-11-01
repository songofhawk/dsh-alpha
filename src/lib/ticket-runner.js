// Ticket 执行层：把 Ticket 的输入变成 Run，并让多个 Run 接成一条连续的工作
// （docs/superagent-design.md 第 6.4 节）。
//
//   有活动 Run + 支持 steer   → 追加进当前 turn；失败时留在队列
//   有活动 Run + 不支持 steer → 排队，当前 Run 结束后合并成下一个 Run
//   空闲 + 支持 resume        → 新 Run，带 runtime_session_id 续接
//   空闲 + 不支持 resume      → 新 Run，用“标题 + 摘要 + 上次结果 + 新输入”重建
//   目标机离线                → 输入留在队列，上线后由定时泵继续
//
// 一个 Ticket 同一时刻最多一个活动 Run，这条不变量由 activeRuns 保证。
// 用户原文不被改写：首个 Run 的 prompt 就是原文，续接时只在前面加必要的说明。

const { createId } = require("./ticket-store.js");

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_STATES = new Set(["queued", "running", "blocked"]);
const RESULT_CONTEXT_CHARS = 4_000;
const SUMMARY_CHARS = 200;
const DEFAULT_PUMP_INTERVAL_MS = 5_000;

const RECOVERY_NOTE = "主控重启打断了上一轮工作。继续之前先检查工作目录和 git 状态，确认哪些已经完成，不要重复已做过的外部操作。";

function clip(text, limit) {
  const value = String(text || "").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function createTicketRunner({
  store,
  tickets,
  tasks,
  engine,
  catalog,
  approvals,
  classifyReport = null, // async ({ ticket, text, signal }) => { kind, question? } | null
  onReport = null, // ({ ticket, report }) => void
  pumpIntervalMs = DEFAULT_PUMP_INTERVAL_MS,
  log = console
}) {
  const activeRuns = new Map(); // ticketId -> taskId
  const watchers = new Map(); // taskId -> dispose
  const steering = new Set(); // 正在 steer 的 ticketId，保证输入按序送达
  let timer = null;

  function agentOf(agentId) {
    if (!agentId) return null;
    try { return catalog.getAgent(agentId); } catch { return null; }
  }

  function agentUsable(agent) {
    if (!agent?.available) return false;
    if (agent.machineId === catalog.machineId) return true;
    return catalog.machineFor(agent.machineId).online !== false;
  }

  // 目标：Binding 里已绑定的 agent 优先，其次是路由结果和用户约束。
  function targetOf(ticket) {
    const binding = ticket.binding || {};
    const constraints = binding.constraints || {};
    const route = binding.route || {};
    return {
      agentId: binding.agentId || constraints.agentId || route.agentId || null,
      machineId: binding.machineId || constraints.machineId || route.machineId || null,
      workspaceId: ticket.workspaceId || constraints.workspaceId || route.workspaceId || null,
      model: constraints.model || route.model || null,
      reasoningEffort: constraints.reasoningEffort || route.reasoningEffort || null,
      mode: constraints.mode || route.mode || null
    };
  }

  function machineOnline(ticket) {
    const target = targetOf(ticket);
    if (target.agentId) return agentUsable(agentOf(target.agentId));
    if (target.machineId) {
      if (target.machineId === catalog.machineId) return true;
      try { return catalog.machineFor(target.machineId).online !== false; } catch { return false; }
    }
    return true;
  }

  const stageDeps = {
    machineOnline,
    hasActiveRun: (ticket) => activeRuns.has(ticket.id),
    waitingForSlot: () => false
  };

  function patchBinding(ticketId, patch) {
    const ticket = store.getTicket(ticketId);
    return store.updateTicket(ticketId, { binding: { ...(ticket.binding || {}), ...patch } });
  }

  function triggerText(trigger, notes = {}, inputId = null) {
    const note = inputId && notes[inputId];
    return note ? `${trigger.text}\n（路由备注：${note}）` : trigger.text;
  }

  function buildPrompt(ticket, inputs, { resumed }) {
    const binding = ticket.binding || {};
    const notes = binding.inputNotes || {};
    const texts = inputs.map((input) => triggerText(store.getTrigger(input.triggerId), notes, input.id));
    const corrections = binding.corrections || [];
    const body = [...corrections.map((text) => `更正：${text}`), ...texts].join("\n\n");
    if (resumed || !binding.lastRunId) return body;
    // 无法续接 runtime 会话，也不是首个 Run：用任务记录重建上下文。
    const lastRun = lastRunOf(ticket);
    return [
      `这是任务“${ticket.title}”的后续工作。Worker 上一轮的上下文已不可用，以下是任务记录。`,
      ticket.summary ? `任务摘要：${ticket.summary}` : "",
      lastRun?.result ? `上次结果：\n${clip(lastRun.result, RESULT_CONTEXT_CHARS)}` : "",
      lastRun?.error ? `上次错误：${clip(lastRun.error, RESULT_CONTEXT_CHARS)}` : "",
      `新的输入：\n${body}`
    ].filter(Boolean).join("\n\n");
  }

  function lastRunOf(ticket) {
    const runId = ticket.binding?.lastRunId;
    if (!runId) return null;
    try { return tasks.getTask(runId); } catch { return null; }
  }

  function watchRun(ticketId, taskId) {
    activeRuns.set(ticketId, taskId);
    let settled = false;
    const inspect = (record) => {
      const ticket = store.getTicket(ticketId);
      if (record.runtimeSessionId && ticket && ticket.binding?.runtimeSessionId !== record.runtimeSessionId) {
        patchBinding(ticketId, { runtimeSessionId: record.runtimeSessionId });
      }
      if (settled || !TERMINAL_STATES.has(record.status)) return;
      settled = true;
      // 通知发生在任务引擎的写入路径上，收尾必须等 runTask 释放负载和句柄之后。
      setImmediate(() => {
        settleRun(ticketId, record).catch((error) => log.error?.("[alpha-ticket] 收尾失败:", error.message));
      });
    };
    watchers.set(taskId, tasks.subscribe(taskId, inspect));
    inspect(tasks.getTask(taskId));
  }

  function startRun(ticket, inputs) {
    const binding = ticket.binding || {};
    if (binding.hold) return false;
    const target = targetOf(ticket);
    const agent = agentOf(target.agentId);
    // 已绑定的目标离线时等待，不改派：换 agent 是人的决定。
    if (target.agentId && !agentUsable(agent)) return false;

    const resumeId = binding.runtimeSessionId && agent?.capabilities?.session_resume === true
      ? binding.runtimeSessionId
      : null;
    const prompt = buildPrompt(ticket, inputs, { resumed: Boolean(resumeId) });
    const attachments = inputs.flatMap((input) => store.getTrigger(input.triggerId).payload?.attachments || []);
    let receipt;
    try {
      receipt = engine.dispatch({
        agentId: target.agentId,
        workspaceId: target.workspaceId,
        ...(target.machineId ? { machineId: target.machineId } : {}),
        // 用独立的会话键，避免读到主会话当前的界面选择。
        sessionId: `ticket:${ticket.id}`,
        prompt,
        model: target.model,
        reasoningEffort: target.reasoningEffort,
        mode: target.mode,
        attachments,
        ticketId: ticket.id,
        inputIds: inputs.map((input) => input.id),
        session: resumeId ? { runtime_session_id: resumeId } : null
      });
    } catch (error) {
      if (Number(error.statusCode) === 503) {
        // 暂时没有可用目标：输入留在队列，定时泵重试。
        patchBinding(ticket.id, { lastError: error.message });
        return false;
      }
      // 配置类错误重试没有意义，停下来等人处理。
      patchBinding(ticket.id, { hold: true, lastError: error.message });
      tickets.noteReport(ticket.id, {
        kind: "blocked",
        text: `无法启动：${error.message}`,
        sourceEventId: `dispatch-error:${inputs[0].id}`
      });
      return false;
    }

    const task = tasks.getTask(receipt.taskId);
    const delivered = Date.now();
    store.transact(() => {
      for (const input of inputs) store.updateInput(input.id, { status: "delivered", runId: task.id, deliveredAt: delivered });
      const notes = { ...(binding.inputNotes || {}) };
      for (const input of inputs) delete notes[input.id];
      store.updateTicket(ticket.id, {
        workspaceId: ticket.workspaceId || task.workspaceId || null,
        binding: {
          ...binding,
          agentId: task.agentId,
          machineId: task.machineId,
          provider: task.provider,
          projectPath: task.projectPath,
          lastRunId: task.id,
          lastError: null,
          corrections: [],
          inputNotes: notes,
          resumedRun: Boolean(resumeId)
        }
      });
    });
    watchRun(ticket.id, task.id);
    tickets.touchStage(ticket.id);
    return true;
  }

  async function steerInputs(ticketId, taskId) {
    if (steering.has(ticketId)) return;
    steering.add(ticketId);
    try {
      for (const input of store.listInputs({ ticketId, status: "pending" })) {
        const trigger = store.getTrigger(input.triggerId);
        // 图片要走文件落地，steer 只追加文字；带附件的输入排到下一个 Run。
        if (trigger.payload?.attachments?.length) return;
        const notes = store.getTicket(ticketId).binding?.inputNotes || {};
        const { accepted } = await engine.steerTask(taskId, { message: triggerText(trigger, notes, input.id) });
        if (!accepted) return;
        // steer 是异步的，期间用户可能已把这句话改归属到别的任务。
        const current = store.getInput(input.id);
        if (current.status !== "pending" || current.ticketId !== ticketId) continue;
        store.updateInput(input.id, { status: "delivered", runId: taskId, deliveredAt: Date.now() });
        const task = tasks.getTask(taskId);
        tasks.update(taskId, { inputIds: [...task.inputIds, input.id] });
      }
    } finally {
      steering.delete(ticketId);
      tickets.touchStage(ticketId);
    }
  }

  function pump(ticketId) {
    const ticket = store.getTicket(ticketId);
    if (!ticket || ticket.status !== "open") return;
    const inputs = store.listInputs({ ticketId, status: "pending" });
    if (!inputs.length) return;
    const runId = activeRuns.get(ticketId);
    if (runId) {
      steerInputs(ticketId, runId).catch((error) => log.error?.("[alpha-ticket] steer 失败:", error.message));
      return;
    }
    startRun(ticket, inputs);
  }

  function pumpAll() {
    const ticketIds = new Set(store.listInputs({ status: "pending" }).map((input) => input.ticketId));
    for (const ticketId of ticketIds) pump(ticketId);
  }

  // resume 失败且 Worker 没做任何事：会话多半已过期，换成重建上下文再试一次。
  function retryWithoutResume(ticket, task) {
    const binding = ticket.binding || {};
    const progressed = (task.events || []).some((event) => ["delta", "tool_use", "tool_result"].includes(event.type));
    if (task.status !== "failed" || !binding.resumedRun || binding.resumeRetried || progressed) return false;
    store.transact(() => {
      for (const inputId of task.inputIds) store.updateInput(inputId, { status: "pending", runId: null, deliveredAt: null });
      store.updateTicket(ticket.id, {
        binding: { ...binding, runtimeSessionId: null, resumedRun: false, resumeRetried: true }
      });
    });
    return true;
  }

  async function reportOf(ticket, task) {
    if (task.status === "failed") return { kind: "failed", text: task.error || "任务失败" };
    if (task.status === "cancelled") return { kind: "blocked", text: task.error || "任务已取消" };
    const text = String(task.result || "");
    // 同一任务还有新输入等着，这一轮不算交付，继续做完再请人验收。
    if (store.pendingInputCount(ticket.id) > 0) return { kind: "progress", text };
    let judged = null;
    try {
      judged = classifyReport ? await classifyReport({ ticket, text }) : null;
    } catch (error) {
      log.info?.(`[alpha-ticket] 报告分类回退：${error.message}`);
    }
    return { kind: judged?.kind || "ready", text, question: judged?.question || null };
  }

  async function settleRun(ticketId, record) {
    activeRuns.delete(ticketId);
    watchers.get(record.id)?.();
    watchers.delete(record.id);
    const ticket = store.getTicket(ticketId);
    if (!ticket) return;
    if (ticket.status === "ended") {
      tickets.touchStage(ticketId);
      return;
    }
    if (retryWithoutResume(ticket, record)) {
      pump(ticketId);
      return;
    }
    if (!store.getTicket(ticketId).binding?.resumedRun || record.status === "completed") {
      patchBinding(ticketId, { resumeRetried: false });
    }
    const report = await reportOf(ticket, record);
    const noted = tickets.noteReport(ticketId, {
      kind: report.kind,
      runId: record.id,
      text: report.text,
      question: report.question || (report.kind === "question" ? clip(report.text, 300) : null),
      sourceEventId: `report:${record.id}`
    });
    store.updateTicket(ticketId, { summary: clip(report.text, SUMMARY_CHARS) });
    if (report.kind !== "progress") onReport?.({ ticket: store.getTicket(ticketId), report: noted });
    pump(ticketId);
  }

  // ---- 对外操作：归属管线、Router 工具和 RPC 都走这里 ----

  function open({ trigger, title, route, constraints, origin = "user", via = "t0", note = null }) {
    const ticket = tickets.openTicket({ trigger, title, route, constraints, origin, via });
    const triggerId = typeof trigger === "string" ? trigger : store.listTriggersOfTicket(ticket.id)[0].id;
    return submit(ticket.id, triggerId, { via, note, linked: true }).ticket;
  }

  // 送达一条输入。stopped 任务不能重开，返回 rejected，由调用方告诉用户。
  function submit(ticketId, triggerRef, { via = "ui", note = null } = {}) {
    const ticket = store.getTicket(ticketId);
    if (ticket?.status === "ended" && ticket.outcome === "stopped") {
      return { rejected: "stopped", ticket };
    }
    const input = tickets.submitInput(ticketId, triggerRef, { via });
    const current = store.getTicket(ticketId);
    const trigger = store.getTrigger(input.triggerId);
    const patch = {};
    if (trigger.trust === "user" && current.binding?.hold) patch.hold = false;
    if (note) patch.inputNotes = { ...(current.binding?.inputNotes || {}), [input.id]: clip(note, 30) };
    if (Object.keys(patch).length) patchBinding(ticketId, patch);
    if (trigger.trust === "user" && current.attention) tickets.resolveAttention(ticketId, null);
    pump(ticketId);
    tickets.touchStage(ticketId);
    return { input, ticket: store.getTicket(ticketId) };
  }

  function dropPendingInputs(ticketId) {
    for (const input of store.listInputs({ ticketId, status: "pending" })) {
      store.updateInput(input.id, { status: "moved" });
    }
  }

  async function cancelActiveRun(ticketId) {
    const runId = activeRuns.get(ticketId);
    if (runId) await engine.cancelTask(runId);
  }

  async function stop(ticketId, { by = "user" } = {}) {
    const ticket = tickets.stopTicket(ticketId, { by });
    dropPendingInputs(ticketId);
    await cancelActiveRun(ticketId);
    tickets.touchStage(ticketId);
    return ticket;
  }

  async function close(ticketId, { outcome = "done", by = "user" } = {}) {
    const ticket = tickets.closeTicket(ticketId, { outcome, by });
    dropPendingInputs(ticketId);
    await cancelActiveRun(ticketId);
    tickets.touchStage(ticketId);
    return ticket;
  }

  async function merge(fromId, intoId) {
    await cancelActiveRun(fromId);
    const merged = tickets.mergeTickets(fromId, intoId);
    pump(intoId);
    return merged;
  }

  // 改归属：未送达的输入由 ticket-engine 直接搬走；已送达的还要告诉原 Worker
  // 这句话作废。运行中能 steer 就立刻说，否则放到下一个 Run 开头（第 6.2 节）。
  function reattribute(triggerId, target) {
    const trigger = store.getTrigger(triggerId);
    if (!trigger) throw new Error(`Trigger 不存在：${triggerId}`);
    const deliveredTo = new Set();
    for (const link of store.listLinksOfTrigger(triggerId)) {
      const delivered = store.listInputs({ ticketId: link.ticketId, triggerId })
        .some((input) => input.status === "delivered");
      if (delivered) deliveredTo.add(link.ticketId);
    }
    const decision = tickets.reattribute(triggerId, target);
    const correction = `上一条输入“${clip(trigger.text, 80)}”不属于这个任务，请忽略并撤回基于它的改动。`;
    for (const ticketId of deliveredTo) {
      if (ticketId === decision.ticketId) continue;
      const runId = activeRuns.get(ticketId);
      const fallback = () => {
        const binding = store.getTicket(ticketId).binding || {};
        patchBinding(ticketId, { corrections: [...(binding.corrections || []), correction] });
      };
      if (!runId) {
        fallback();
        continue;
      }
      engine.steerTask(runId, { message: `更正：${correction}` })
        .then(({ accepted }) => { if (!accepted) fallback(); })
        .catch(fallback);
    }
    if (decision.ticketId) pump(decision.ticketId);
    return decision;
  }

  function decideApproval(ticketId, approvalId, decision) {
    const pending = store.getApproval(approvalId);
    if (!pending || pending.ticketId !== ticketId) {
      const error = new Error(`任务 ${ticketId} 没有这条审批：${approvalId}`);
      error.statusCode = 404;
      throw error;
    }
    const decided = approvals.decide(approvalId, decision);
    tickets.touchStage(ticketId);
    return decided;
  }

  // 主控重启：interrupted 是 task-store 收敛掉的 Run。为仍 open 的 Ticket 补一条
  // 系统输入发起恢复 Run；目标机尚未连上时由定时泵等待。
  function recover(interrupted = []) {
    for (const task of interrupted) {
      if (!task.ticketId) continue;
      const ticket = store.getTicket(task.ticketId);
      if (!ticket || ticket.status !== "open") continue;
      if (task.runtimeSessionId && ticket.binding?.runtimeSessionId !== task.runtimeSessionId) {
        patchBinding(ticket.id, { runtimeSessionId: task.runtimeSessionId });
      }
      tickets.submitInput(ticket.id, {
        id: createId("trg"),
        source: "system",
        sourceEventId: `recover:${task.id}`,
        kind: "system_note",
        trust: "system",
        text: `${RECOVERY_NOTE}\n\n被打断的指令：\n${task.prompt}`
      }, { via: "t0" });
    }
    // 重启后的活动 Run 只可能来自本进程，这里没有需要接管的句柄。
    pumpAll();
  }

  function activeRunOf(ticketId) {
    return activeRuns.get(ticketId) || null;
  }

  function runsOf(ticketId) {
    return tasks.listTasks().filter((task) => task.ticketId === ticketId);
  }

  function start() {
    if (timer || !pumpIntervalMs) return;
    timer = setInterval(() => {
      try { pumpAll(); } catch (error) { log.error?.("[alpha-ticket] 定时泵失败:", error.message); }
    }, pumpIntervalMs);
    timer.unref?.();
  }

  function stopTimers() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const dispose of watchers.values()) dispose();
    watchers.clear();
  }

  return {
    stageDeps,
    open,
    submit,
    stop,
    close,
    merge,
    reattribute,
    decideApproval,
    recover,
    pump,
    pumpAll,
    activeRunOf,
    runsOf,
    start,
    dispose: stopTimers
  };
}

module.exports = { createTicketRunner, ACTIVE_STATES };
