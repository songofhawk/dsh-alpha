// Ticket 引擎：SuperAgent R1 的任务核心（docs/superagent-design.md 第 6、7 节）。
// 只有归属管线能创建 Ticket（openTicket 只应由归属管线调用，本模块不做鉴权）。
// 状态（Stage）由 stageOf 纯函数按第 6.5 节的表从上到下推导，不由模型判断；
// 引擎只负责把 ticket 行 + 关联数据组装成 stageOf 需要的输入。
//
// stageOf 的输入（在 ticket 行字段之上补充的推导字段）：
//   pendingApproval  有待决审批
//   latestReport     { kind, at } | null，最近一次 Worker 报告的分类
//                    （report 是 kind="worker_report" 的 trigger，分类在 payload.classification）
//   lastHumanInputAt 最近一次 trust="user" 的 trigger 时间
//   pendingInputs    待送达输入数
//   machineOnline    目标机是否在线
//   hasActiveRun     是否有活动 Run
//   waitingSlot      是否在等待执行槽位

const { createId } = require("./ticket-store.js");

// 第 6.5 节的表：从上到下匹配，第一个命中者生效，互斥且完备。
function stageOf(ticket) {
  if (ticket.pendingApproval) return "person/approval";
  if (ticket.attention) return "person/answer";
  // 已结束的任务不再“需要我”：历史报告和残留输入都不能把它拉回看板上方。
  if (ticket.status === "ended") return `ended/${ticket.outcome || "done"}`;
  const report = ticket.latestReport || null;
  // 报告之后的人类输入表示人已经接手：不再待验收，也不再受阻。
  const answeredByHuman = report != null && ticket.lastHumanInputAt != null && ticket.lastHumanInputAt > report.at;
  if (report && (report.kind === "blocked" || report.kind === "failed") && !answeredByHuman) return "person/blocked";
  if (report && report.kind === "ready" && !answeredByHuman) return "person/review";
  if (Number(ticket.pendingInputs) > 0 && ticket.machineOnline === false) return "waiting/machine";
  if (!ticket.hasActiveRun && (Number(ticket.pendingInputs) > 0 || ticket.waitingSlot)) return "working/queued";
  if (ticket.hasActiveRun) return "working/running";
  return "idle";
}

// 看板分组顺序：需要我 → 待验收 → 进行中 → 等待中 → 已结束（与 6.5 表格一致）。
const STAGE_ORDER = [
  "person/approval", "person/answer", "person/blocked",
  "person/review",
  "working/queued", "working/running",
  "waiting/machine", "idle",
  "ended/done", "ended/dropped", "ended/stopped", "ended/merged"
];

function firstLine(text, fallback = "未命名任务") {
  const line = String(text || "").split("\n").map((part) => part.trim()).find(Boolean);
  return line ? line.slice(0, 50) : fallback;
}

function createTicketEngine({ store, deps = {}, now = Date.now }) {
  if (!store) throw new Error("createTicketEngine 需要注入 ticket-store");
  const listeners = new Map(); // 事件名 -> Set<fn>
  const lastStages = new Map(); // ticketId -> 上次推导出的 stage

  function on(name, fn) {
    if (typeof fn !== "function") throw new TypeError("监听器必须是函数");
    let bucket = listeners.get(name);
    if (!bucket) {
      bucket = new Set();
      listeners.set(name, bucket);
    }
    bucket.add(fn);
    return () => {
      bucket.delete(fn);
      if (!bucket.size) listeners.delete(name);
    };
  }

  function emit(name, payload) {
    for (const fn of listeners.get(name) || []) {
      try { fn(payload); } catch { /* 观察者不能破坏引擎写入 */ }
    }
  }

  // 组装 stageOf 需要的全部上下文。机器在线、活动 Run、槽位这些运行期信号
  // 由 deps 注入（WP2/WP8 提供真实实现），缺省视为在线、无活动 Run、不等槽位。
  function contextOf(ticket) {
    let latestReport = null;
    let lastHumanInputAt = null;
    for (const trigger of store.listTriggersOfTicket(ticket.id)) {
      if (trigger.kind === "worker_report") {
        const classification = trigger.payload?.classification;
        if (classification && (!latestReport || trigger.createdAt >= latestReport.at)) {
          latestReport = { kind: classification, at: trigger.createdAt };
        }
      }
      if (trigger.trust === "user" && (lastHumanInputAt === null || trigger.createdAt > lastHumanInputAt)) {
        lastHumanInputAt = trigger.createdAt;
      }
    }
    return {
      ...ticket,
      pendingApproval: store.pendingApprovalCount(ticket.id) > 0,
      latestReport,
      lastHumanInputAt,
      pendingInputs: store.pendingInputCount(ticket.id),
      machineOnline: deps.machineOnline ? !!deps.machineOnline(ticket) : true,
      hasActiveRun: deps.hasActiveRun ? !!deps.hasActiveRun(ticket) : false,
      waitingSlot: deps.waitingForSlot ? !!deps.waitingForSlot(ticket) : false
    };
  }

  function stageOfTicket(ticketId) {
    return stageOf(contextOf(store.getTicket(ticketId)));
  }

  // 每次变更后重算 stage，变化时发 ticket.stage。首次计算只记录不发送
  // （创建事件已由 ticket.created 表达）。
  function touchStage(ticketId) {
    const ticket = store.getTicket(ticketId);
    if (!ticket) return;
    const stage = stageOf(contextOf(ticket));
    const previous = lastStages.get(ticketId);
    lastStages.set(ticketId, stage);
    if (previous !== undefined && previous !== stage) {
      emit("ticket.stage", { ticket, from: previous, to: stage });
    }
  }

  function requireTicket(ticketId) {
    const ticket = store.getTicket(ticketId);
    if (!ticket) {
      const error = new Error(`任务不存在：${ticketId}`);
      error.statusCode = 404;
      throw error;
    }
    return ticket;
  }

  // trigger 可以是已落库的 id，也可以是待写入的对象（幂等）。
  function ensureTrigger(triggerRef) {
    if (typeof triggerRef === "string") {
      const trigger = store.getTrigger(triggerRef);
      if (!trigger) {
        const error = new Error(`Trigger 不存在：${triggerRef}`);
        error.statusCode = 404;
        throw error;
      }
      return trigger;
    }
    const ts = now();
    return store.insertTrigger({
      id: triggerRef.id || createId("trg"),
      source: triggerRef.source,
      sourceEventId: triggerRef.sourceEventId,
      threadKey: triggerRef.threadKey ?? null,
      actor: triggerRef.actor ?? null,
      kind: triggerRef.kind || "user_message",
      trust: triggerRef.trust || "user",
      text: triggerRef.text ?? "",
      payload: triggerRef.payload ?? {},
      createdAt: Number(triggerRef.createdAt) || ts
    }).trigger;
  }

  function openTicket({ trigger, title, route, constraints, origin = "user", via = null }) {
    const persisted = ensureTrigger(trigger);
    const ts = now();
    const ticket = store.transact(() => {
      const record = {
        id: createId("tkt"),
        seq: store.nextTicketSeq(),
        status: "open",
        outcome: null,
        title: title || firstLine(persisted.text),
        summary: "",
        origin,
        workspaceId: route?.workspaceId ?? constraints?.workspaceId ?? null,
        category: null,
        categorySource: null,
        binding: { route: route ?? null, constraints: constraints ?? null },
        attention: null,
        mergedInto: null,
        createdAt: ts,
        updatedAt: ts,
        lastActivityAt: ts,
        endedAt: null
      };
      store.insertTicket(record);
      store.linkTrigger(record.id, persisted.id, via || persisted.payload?.via || "ui");
      return store.getTicket(record.id);
    });
    emit("ticket.created", { ticket });
    touchStage(ticket.id);
    return ticket;
  }

  function submitInput(ticketId, triggerRef, { via = "ui" } = {}) {
    const ticket = requireTicket(ticketId);
    const trigger = ensureTrigger(triggerRef);
    const ts = now();
    const input = store.transact(() => {
      store.linkTrigger(ticketId, trigger.id, via);
      // 人的新消息可重开 ended 任务，但用户叫停（stopped）的除外；
      // bot / CI（trust != "user"）不能重开。merged 任务被重开时清掉 mergedInto，
      // 重新成为独立任务（into 方已搬走的归属不回退）。
      const patch = { updatedAt: ts, lastActivityAt: ts };
      if (ticket.status === "ended" && trigger.trust === "user" && ticket.outcome !== "stopped") {
        patch.status = "open";
        patch.outcome = null;
        patch.endedAt = null;
        patch.mergedInto = null;
      }
      store.updateTicket(ticketId, patch);
      return store.insertInput({
        id: createId("inp"),
        ticketId,
        triggerId: trigger.id,
        status: "pending",
        runId: null,
        createdAt: ts,
        deliveredAt: null
      });
    });
    touchStage(ticketId);
    return input;
  }

  function stopTicket(ticketId, { by = "user" } = {}) {
    const ticket = requireTicket(ticketId);
    if (ticket.status === "ended") return ticket;
    const ts = now();
    const stopped = store.updateTicket(ticketId, {
      status: "ended",
      outcome: "stopped",
      updatedAt: ts,
      lastActivityAt: ts,
      endedAt: ts
    });
    emit("ticket.ended", { ticket: stopped, by });
    touchStage(ticketId);
    return stopped;
  }

  // 验收或放弃：与 stopTicket 的区别是任务已没有在跑的工作要叫停，
  // 人的新消息仍可重开（第 6.4 节）。
  function closeTicket(ticketId, { outcome = "done", by = "user" } = {}) {
    if (!["done", "dropped"].includes(outcome)) throw new Error(`非法结局：${outcome}`);
    const ticket = requireTicket(ticketId);
    if (ticket.status === "ended") return ticket;
    const ts = now();
    const closed = store.updateTicket(ticketId, {
      status: "ended",
      outcome,
      attention: null,
      updatedAt: ts,
      lastActivityAt: ts,
      endedAt: ts
    });
    emit("ticket.ended", { ticket: closed, by });
    touchStage(ticketId);
    return closed;
  }

  // 人在任务视图里的修改。类型一旦由人改过，category_source=user，自动分类不得覆盖。
  function updateTicket(ticketId, { title, category, binding } = {}) {
    requireTicket(ticketId);
    const patch = { updatedAt: now() };
    if (title !== undefined) {
      const text = String(title).trim();
      if (!text) throw new Error("任务标题不能为空");
      patch.title = text.slice(0, 120);
    }
    if (category !== undefined) {
      patch.category = category || null;
      patch.categorySource = category ? "user" : null;
    }
    if (binding !== undefined) patch.binding = binding;
    const ticket = store.updateTicket(ticketId, patch);
    touchStage(ticketId);
    return ticket;
  }

  function resolveAttention(ticketId, answerTriggerId) {
    requireTicket(ticketId);
    const ts = now();
    const ticket = store.transact(() => {
      if (answerTriggerId) {
        ensureTrigger(answerTriggerId);
        store.linkTrigger(ticketId, answerTriggerId, "ui");
      }
      return store.updateTicket(ticketId, {
        attention: null,
        updatedAt: ts,
        lastActivityAt: ts
      });
    });
    touchStage(ticketId);
    return ticket;
  }

  // Worker 提问（结构化 attention）。WP2 由报告分类驱动调用。
  function setAttention(ticketId, attention) {
    requireTicket(ticketId);
    const ts = now();
    const ticket = store.updateTicket(ticketId, { attention, updatedAt: ts, lastActivityAt: ts });
    touchStage(ticketId);
    return ticket;
  }

  // 记录一次 Worker 报告：落库为 kind="worker_report" 的 trigger（供 stageOf
  // 与任务时间线使用），question 类报告同时写入 attention。
  function noteReport(ticketId, { kind, runId = null, text = "", question = null, sourceEventId = null, at = null }) {
    const ticket = requireTicket(ticketId);
    const ts = Number(at) || now();
    const report = { kind, runId, text, question, at: ts };
    store.transact(() => {
      const trigger = ensureTrigger({
        source: "worker",
        sourceEventId: sourceEventId || `report:${runId || createId("run")}:${kind}`,
        kind: "worker_report",
        trust: "system",
        text,
        payload: { classification: kind, runId, question },
        createdAt: ts
      });
      store.linkTrigger(ticketId, trigger.id, "t0");
      const patch = { updatedAt: now(), lastActivityAt: ts };
      if (kind === "question" && question) {
        patch.attention = { question, runId, askedAt: ts };
      }
      store.updateTicket(ticketId, patch);
      return trigger;
    });
    emit("ticket.report", { ticket: store.getTicket(ticketId), report });
    touchStage(ticketId);
    return report;
  }

  // 把一条 trigger 的归属改到别的任务 / 拆成新任务 / 标为无关（6.2 纠错）。
  // 未送达的 Input 直接移动；已送达的标为 moved 并在目标任务上补一条 pending
  // （向原 Worker 的更正在 WP2/WP4 的派发层完成）。同时记录 Decision，并把
  // 该 trigger 之前的 Decision 标记 overridden_by。
  function reattribute(triggerId, { toTicketId = null, newTicket = null, none = false } = {}) {
    const trigger = ensureTrigger(triggerId);
    const chosen = [toTicketId, newTicket, none].filter(Boolean).length;
    if (chosen !== 1) throw new Error("reattribute 需要且只能给一个去向：toTicketId | newTicket | none");
    const ts = now();

    const result = store.transact(() => {
      let target = null;
      if (toTicketId) {
        target = requireTicket(toTicketId);
      } else if (newTicket) {
        const record = {
          id: createId("tkt"),
          seq: store.nextTicketSeq(),
          status: "open",
          outcome: null,
          title: (typeof newTicket === "object" && newTicket.title) || firstLine(trigger.text),
          summary: "",
          origin: (typeof newTicket === "object" && newTicket.origin) || "user",
          workspaceId: (typeof newTicket === "object" && newTicket.workspaceId) || null,
          category: null,
          categorySource: null,
          binding: null,
          attention: null,
          mergedInto: null,
          createdAt: ts,
          updatedAt: ts,
          lastActivityAt: ts,
          endedAt: null
        };
        store.insertTicket(record);
        target = store.getTicket(record.id);
      }

      const affected = new Set();
      for (const link of store.listLinksOfTrigger(trigger.id)) {
        affected.add(link.ticketId);
        for (const input of store.listInputs({ ticketId: link.ticketId, triggerId: trigger.id })) {
          if (input.status === "pending" && target) {
            store.updateInput(input.id, { ticketId: target.id });
          } else if (input.status === "pending") {
            store.updateInput(input.id, { status: "moved" });
          } else {
            store.updateInput(input.id, { status: "moved" });
            if (target) {
              store.insertInput({
                id: createId("inp"),
                ticketId: target.id,
                triggerId: trigger.id,
                status: "pending",
                runId: null,
                createdAt: ts,
                deliveredAt: null
              });
            }
          }
        }
        store.unlinkTrigger(link.ticketId, trigger.id);
      }
      if (target) {
        store.linkTrigger(target.id, trigger.id, "user_fix");
        store.updateTicket(target.id, { updatedAt: ts, lastActivityAt: ts });
        affected.add(target.id);
      }

      const previous = store.latestDecisionOfTrigger(trigger.id);
      const decision = store.insertDecision({
        id: createId("dec"),
        triggerId: trigger.id,
        tier: 0,
        action: none ? "none" : (newTicket ? "new" : "attach"),
        ticketId: target ? target.id : null,
        confidence: 1,
        reason: "user_fix",
        createdAt: ts
      });
      if (previous) store.markDecisionOverridden(previous.id, decision.id);
      return { decision, affected, created: newTicket ? target : null };
    });

    if (result.created) emit("ticket.created", { ticket: result.created });
    for (const affectedId of result.affected) touchStage(affectedId);
    return result.decision;
  }

  // 合并任务：时间线、输入、订阅全部搬到 into，from 记为 ended/merged。
  function mergeTickets(fromId, intoId) {
    if (fromId === intoId) throw new Error("不能合并到任务自身");
    const from = requireTicket(fromId);
    requireTicket(intoId);
    const ts = now();
    const merged = store.transact(() => {
      for (const trigger of store.listTriggersOfTicket(fromId)) {
        store.linkTrigger(intoId, trigger.id, trigger.via || "user_fix");
        store.unlinkTrigger(fromId, trigger.id);
      }
      for (const input of store.listInputs({ ticketId: fromId })) {
        store.updateInput(input.id, { ticketId: intoId });
      }
      for (const subscription of store.listSubscriptions({ ticketId: fromId })) {
        store.addSubscription({
          ticketId: intoId,
          threadKey: subscription.threadKey,
          role: subscription.role,
          createdAt: subscription.createdAt
        });
        store.removeSubscription(fromId, subscription.threadKey);
      }
      store.updateTicket(intoId, { updatedAt: ts, lastActivityAt: ts });
      return store.updateTicket(fromId, {
        status: "ended",
        outcome: "merged",
        mergedInto: intoId,
        updatedAt: ts,
        endedAt: ts
      });
    });
    emit("ticket.ended", { ticket: merged, by: "merge", intoId });
    touchStage(fromId);
    touchStage(intoId);
    return merged;
  }

  // 看板：同一份数据按 stage（默认）/ 项目 / 类型 / 机器分组投影。
  // filter 支持 status / origin / workspaceId / category / stage 精确匹配；
  // limit 限制每组返回的任务数（0 表示不限）。返回 [{ key, tickets }]。
  function board({ groupBy = "stage", filter = {}, limit = 0 } = {}) {
    const keyOf = {
      stage: (entry) => entry.stage,
      workspace: (entry) => entry.ticket.workspaceId || "",
      category: (entry) => entry.ticket.category || "",
      machine: (entry) => entry.ticket.binding?.route?.machineId || entry.ticket.binding?.constraints?.machineId || ""
    }[groupBy];
    if (!keyOf) throw new Error(`未知的分组维度：${groupBy}`);

    const groups = new Map();
    for (const ticket of store.listTickets()) {
      if (filter.status && ticket.status !== filter.status) continue;
      if (filter.origin && ticket.origin !== filter.origin) continue;
      if (filter.workspaceId && ticket.workspaceId !== filter.workspaceId) continue;
      if (filter.category && ticket.category !== filter.category) continue;
      const stage = stageOf(contextOf(ticket));
      lastStages.set(ticket.id, stage);
      if (filter.stage && stage !== filter.stage) continue;
      const entry = { ticket, stage };
      const key = keyOf(entry);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }

    const order = groupBy === "stage"
      ? (a, b) => {
          const rank = (key) => {
            const index = STAGE_ORDER.indexOf(key);
            return index === -1 ? STAGE_ORDER.length : index;
          };
          return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
        }
      : (a, b) => (a < b ? -1 : a > b ? 1 : 0);

    return [...groups.entries()]
      .sort(([a], [b]) => order(a, b))
      .map(([key, entries]) => ({
        key,
        tickets: entries
          .sort((a, b) => b.ticket.lastActivityAt - a.ticket.lastActivityAt)
          .slice(0, limit > 0 ? limit : entries.length)
          .map((entry) => ({ ...entry.ticket, stage: entry.stage }))
      }));
  }

  return {
    on,
    openTicket,
    submitInput,
    stopTicket,
    closeTicket,
    updateTicket,
    resolveAttention,
    setAttention,
    noteReport,
    reattribute,
    mergeTickets,
    stageOf,
    stageOfTicket,
    contextOf,
    touchStage,
    board
  };
}

module.exports = { createTicketEngine, stageOf, STAGE_ORDER };
