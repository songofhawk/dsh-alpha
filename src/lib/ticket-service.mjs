// Ticket 服务（host 平面）：把归属管线、执行层、报告回流收拢成一个入口，
// Router 工具、快路径和任务视图 RPC 都只和这里打交道。
//
//   消息 → Trigger（幂等落库）→ attribute → 建任务 / 送输入 / 交给 Router LLM
//   Run 结束 → noteReport → outbox → 以 dsh-alpha 消息来源投递到主会话

import { randomUUID } from "node:crypto";
import { createAttribution, firstLine } from "./attribution.mjs";
import ticketStoreModule from "./ticket-store.js";
import ticketEngineModule from "./ticket-engine.js";
import ticketRunnerModule from "./ticket-runner.js";
import outboxModule from "./outbox.js";

const { createId } = ticketStoreModule;
const { createTicketEngine } = ticketEngineModule;
const { createTicketRunner } = ticketRunnerModule;
const { createOutbox } = outboxModule;

const MAIN_SESSION_KEY = "mainSessionId";
const REPORT_INLINE_CHARS = 600;
const UNDECIDED_WINDOW_MS = 10 * 60 * 1000;
const BOARD_SNAPSHOT_TICKETS = 20;
const BOARD_SNAPSHOT_CHARS = 2_000;
const CATEGORY_CHARS = 12;
const QUOTE_TTL_MS = 5 * 60 * 1000;
const TEXT_PAGE_CHARS = 4_000;
const LIST_PAGE_SIZE = 20;
const TIMELINE_LIMIT = 200;
const RELAY_INTERVAL_MS = 5_000;
// 闲置话题自动收起：没有人需要处理、也没有在跑，超过这个时间没动静就收起；
// 有新消息会自动展开。环境变量 DSH_ALPHA_ARCHIVE_DAYS 可调，0 表示不自动收起。
const ARCHIVE_SWEEP_MS = 60 * 60 * 1000;
const DEFAULT_ARCHIVE_DAYS = 7;
const MAX_DISCUSS_EXTRAS = 5;
const LOOSE_WINDOW_MS = 6 * 3600 * 1000;
const IDLE_STAGES = new Set(["idle/replied", "idle/discussing", "idle"]);

function archiveAfterMs(env = process.env) {
  const days = env.DSH_ALPHA_ARCHIVE_DAYS === undefined ? DEFAULT_ARCHIVE_DAYS : Number(env.DSH_ALPHA_ARCHIVE_DAYS);
  return Number.isFinite(days) && days > 0 ? days * 24 * 3600 * 1000 : 0;
}
const FEED_LIMIT = 200;
const PENDING_DISPLAY_MS = 2 * 60 * 1000;

export const STAGE_LABELS = Object.freeze({
  "person/approval": "待审批",
  "person/answer": "待回答",
  "person/blocked": "受阻",
  "waiting/machine": "等机器",
  "working/queued": "排队中",
  "working/running": "进行中",
  "idle/replied": "有回复",
  "idle/discussing": "讨论中",
  idle: "空闲",
  "ended/done": "已收起",
  "ended/dropped": "已收起",
  "ended/stopped": "已叫停",
  "ended/merged": "已合并"
});

const REPORT_LABELS = { ready: "已回复", question: "需要你回答", blocked: "受阻", failed: "失败" };
const QUIET_REPORTS = new Set(["progress", "done_no_action"]);

function page(text, cursor) {
  const start = Math.max(0, Number(cursor) || 0);
  const end = start + TEXT_PAGE_CHARS;
  return { text: text.slice(start, end), ...(end < text.length ? { nextCursor: String(end) } : {}) };
}

export function reportText(ticket, report) {
  const body = String(report.text || "");
  const head = `#${ticket.seq} ${ticket.title}：${REPORT_LABELS[report.kind] || report.kind}`;
  if (!body) return head;
  if (body.length <= REPORT_INLINE_CHARS) return `${head}\n${body}`;
  return `${head}\n${body.slice(0, REPORT_INLINE_CHARS)}…\n（完整内容在话题详情）`;
}

export function createTicketService({
  store,
  tasks,
  engine,
  catalog,
  approvals,
  workspaces,
  jev = null,
  router = null,
  classifyReport = null,
  pumpIntervalMs,
  relayIntervalMs = RELAY_INTERVAL_MS,
  archiveIntervalMs = ARCHIVE_SWEEP_MS,
  archiveAfter = archiveAfterMs(),
  now = Date.now,
  log = console
}) {
  const deps = {};
  const tickets = createTicketEngine({ store, deps, now });
  const outbox = createOutbox({ database: store.database, now });
  const runner = createTicketRunner({
    store, tickets, tasks, engine, catalog, approvals, classifyReport, pumpIntervalMs, log,
    onReport: ({ ticket, report }) => {
      if (QUIET_REPORTS.has(report.kind)) return;
      say({
        role: "worker",
        kind: report.kind,
        ticketId: ticket.id,
        runId: report.runId,
        text: reportText(ticket, report),
        dedupeKey: `report:${report.runId || ticket.id}:${report.kind}`
      });
      outbox.enqueue({
        kind: "ticket_report",
        dedupeKey: `report:${report.runId || ticket.id}:${report.kind}`,
        payload: { ticketId: ticket.id, runId: report.runId, kind: report.kind, text: reportText(ticket, report) }
      });
      relay();
    }
  });
  Object.assign(deps, runner.stageDeps);

  const workspaceName = (workspaceId) => {
    if (!workspaceId) return null;
    try { return workspaces.get?.(workspaceId)?.name || null; } catch { return null; }
  };
  const attribution = createAttribution({ store, tickets, jev, router, workspaceName, now });

  let liveAgent = null;
  let relaying = false;
  let relayTimer = null;
  let archiveTimer = null;

  // ---- 主会话与报告回流 ----

  function mainSessionId() {
    return store.getMeta(MAIN_SESSION_KEY);
  }

  function setMainSession(sessionId) {
    store.setMeta(MAIN_SESSION_KEY, sessionId);
    return sessionId;
  }

  // 每个主控一个主会话：第一个跑起来的 alpha-router 会话成为主会话。
  function bindAgent(agent) {
    const sessionId = agent?.session?.id;
    if (!sessionId) return;
    if (!mainSessionId()) setMainSession(sessionId);
    if (mainSessionId() !== sessionId || liveAgent === agent) return;
    liveAgent = agent;
    relay();
  }

  // 主会话没有活动 agent 时报告留在 outbox，不算投递失败。
  async function relay() {
    if (!liveAgent || relaying) return;
    relaying = true;
    try {
      await outbox.drain(async (entry) => {
        liveAgent.send({
          id: randomUUID(),
          role: "user",
          source: { kind: "dsh-alpha", role: "worker-report", ticketId: entry.payload.ticketId, runId: entry.payload.runId },
          content: [{ type: "text", text: entry.payload.text }]
        }, "next-turn", true);
      });
    } catch (error) {
      log.error?.("[alpha-ticket] 报告投递失败:", error.message);
    } finally {
      relaying = false;
    }
  }

  // ---- 归属 ----

  function labelOf(ticket) {
    return `#${ticket.seq} ${ticket.title}`;
  }

  function viaOf(decision) {
    if (decision.tier === 1) return "jev";
    if (decision.tier === 2) return "router";
    return decision.reason === "ui_ticket" ? "ui" : "t0";
  }

  function applyDecision(trigger, decision) {
    if (decision.action === "attach") {
      const result = runner.submit(decision.ticketId, trigger.id, { via: viaOf(decision) });
      if (result.rejected) {
        const ack = `${labelOf(result.ticket)} 已叫停，这句话没有送达。要继续请直接说要做什么。`;
        say({ role: "router", kind: "notice", triggerId: trigger.id, ticketId: result.ticket.id, text: ack });
        return { trigger, ack };
      }
      // 对话里要有回音：用户发完话不能只看到一个归属标签，不知道有没有人在做。
      const stage = tickets.stageOfTicket(result.ticket.id);
      if (stage === "idle/discussing") {
        say({ role: "router", kind: "ack", triggerId: trigger.id, ticketId: result.ticket.id, text: `已记入 #${result.ticket.seq} 的讨论。想让 Worker 动手时，点话题里的“开始做”，或直接告诉我。`, dedupeKey: `ack:${trigger.id}` });
        return { trigger, ticket: result.ticket, ack: `→ ${labelOf(result.ticket)}（讨论中）` };
      }
      const doing = stage === "working/running" ? "Worker 正在做，这句话已追加进去" : stage === "waiting/machine" ? "目标机器暂时离线，上线后会送达" : "Worker 马上接手";
      say({ role: "router", kind: "ack", triggerId: trigger.id, ticketId: result.ticket.id, text: `已转给 #${result.ticket.seq}，${doing}。有结果我告诉你。`, dedupeKey: `ack:${trigger.id}` });
      return { trigger, ticket: result.ticket, ack: `→ ${labelOf(result.ticket)}` };
    }
    if (decision.action === "new") {
      const ticket = runner.open({
        trigger: trigger.id,
        title: decision.title,
        route: decision.route,
        constraints: decision.constraints,
        via: viaOf(decision)
      });
      store.setDecisionTicket(decision.id, ticket.id);
      say({ role: "router", kind: "ack", triggerId: trigger.id, ticketId: ticket.id, text: `已开话题 #${ticket.seq}「${ticket.title}」，Worker 开始处理。有结果我告诉你。`, dedupeKey: `ack:${trigger.id}` });
      return { trigger, ticket, ack: `→ 新话题 ${labelOf(ticket)}` };
    }
    return { trigger, router: true };
  }

  async function intake({ messageId, text, attachments = [], ui = {}, source = "web", signal }) {
    const { trigger, created } = store.insertTrigger({
      id: createId("trg"),
      source,
      sourceEventId: String(messageId),
      kind: "user_message",
      trust: "user",
      actor: "owner",
      text: String(text || ""),
      payload: attachments.length ? { attachments } : {},
      createdAt: now()
    });
    if (!created) return { trigger, ack: "（这条消息已处理过）" };
    return applyDecision(trigger, await attribution.attribute({ trigger, ui, signal }));
  }

  function ticketByRef(ref) {
    const text = String(ref ?? "").replace(/^#/, "").trim();
    const ticket = store.getTicket(text) || (/^\d+$/.test(text) ? store.getTicketBySeq(Number(text)) : null);
    if (!ticket) throw new Error(`话题不存在：${ref}`);
    return ticket;
  }

  function assertConstraints(constraints) {
    if (constraints?.agentId) catalog.getAgent(constraints.agentId);
    if (constraints?.workspaceId) workspaces.get?.(constraints.workspaceId);
  }

  function writeDecision(triggerId, action, ticketId, reason) {
    return store.insertDecision({ id: createId("dec"), triggerId, tier: 2, action, ticketId, reason, createdAt: now() });
  }

  async function routeItem(item) {
    const trigger = store.getTrigger(item.triggerId);
    if (!trigger) throw new Error(`Trigger 不存在：${item.triggerId}`);
    const ticketRef = item.ticketId ? ticketByRef(item.ticketId) : null;
    const previous = store.listDecisionsOfTrigger(trigger.id).filter((row) => row.tier === 2 && row.action !== "router");
    const note = item.note ? String(item.note).slice(0, 30) : null;
    switch (item.kind) {
      case "accept": {
        if (ticketRef?.binding?.discussion) {
          // 讨论中的话题被确认要做：这条消息归入话题，话题升级交给 Worker。
          assertConstraints(item.constraints);
          const done = previous.find((row) => row.action === "attach" && row.ticketId === ticketRef.id);
          if (!done) {
            const result = runner.submit(ticketRef.id, trigger.id, { via: "router", note });
            if (result.rejected) throw new Error(`${labelOf(ticketRef)} 已叫停，不能再接收输入`);
            writeDecision(trigger.id, "attach", ticketRef.id, note);
          }
          promoteTicket(ticketRef.id, { constraints: item.constraints, title: item.title, category: item.category, by: "router" });
          return { triggerId: trigger.id, ok: true, ticketId: ticketRef.id, seq: ticketRef.seq, promoted: true };
        }
        const done = previous.find((row) => row.action === "new");
        if (done) return { triggerId: trigger.id, ok: true, duplicate: true, ticketId: done.ticketId };
        assertConstraints(item.constraints);
        const ticket = runner.open({
          trigger: trigger.id,
          title: item.title || firstLine(trigger.text),
          constraints: item.constraints,
          via: "router",
          note
        });
        writeDecision(trigger.id, "new", ticket.id, note);
        const category = item.category ? label(ticket.id, item.category) : null;
        return { triggerId: trigger.id, ok: true, ticketId: ticket.id, seq: ticket.seq, title: ticket.title, ...(category ? { category } : {}) };
      }
      case "discuss": {
        // 还没决定要做的事：把相关的几句话圈成一个“讨论中”的话题（不派发）。
        // 给了讨论话题的 ticketId 就是追加，等同 attach。
        if (ticketRef) return routeItem({ ...item, kind: "attach" });
        const done = previous.find((row) => row.action === "new");
        if (done) return { triggerId: trigger.id, ok: true, duplicate: true, ticketId: done.ticketId };
        const extras = (Array.isArray(item.withTriggerIds) ? item.withTriggerIds : []).slice(0, MAX_DISCUSS_EXTRAS)
          .map((id) => store.getTrigger(String(id)))
          .filter((row) => row && row.id !== trigger.id && row.trust === "user" && !store.listLinksOfTrigger(row.id).length);
        const ordered = [...extras, trigger].sort((a, b) => a.createdAt - b.createdAt);
        const ticket = runner.open({
          trigger: ordered[0].id,
          title: item.title || firstLine(ordered[0].text),
          via: "router",
          note: ordered[0].id === trigger.id ? note : null,
          discussion: true
        });
        for (const row of ordered.slice(1)) runner.submit(ticket.id, row.id, { via: "router", note: row.id === trigger.id ? note : null });
        writeDecision(trigger.id, "new", ticket.id, note);
        const category = item.category ? label(ticket.id, item.category) : null;
        return { triggerId: trigger.id, ok: true, ticketId: ticket.id, seq: ticket.seq, title: ticket.title, discussion: true, ...(category ? { category } : {}) };
      }
      case "attach": {
        if (!ticketRef) throw new Error("attach 需要 ticketId");
        if (previous.some((row) => row.action === "attach" && row.ticketId === ticketRef.id)) {
          return { triggerId: trigger.id, ok: true, duplicate: true, ticketId: ticketRef.id };
        }
        const result = runner.submit(ticketRef.id, trigger.id, { via: "router", note });
        if (result.rejected) throw new Error(`${labelOf(ticketRef)} 已叫停，不能再接收输入`);
        writeDecision(trigger.id, "attach", ticketRef.id, note);
        return { triggerId: trigger.id, ok: true, ticketId: ticketRef.id, seq: ticketRef.seq };
      }
      case "stop": {
        if (!ticketRef) throw new Error("stop 需要 ticketId");
        await runner.stop(ticketRef.id, { by: "router" });
        store.linkTrigger(ticketRef.id, trigger.id, "router");
        writeDecision(trigger.id, "stop", ticketRef.id, note);
        return { triggerId: trigger.id, ok: true, ticketId: ticketRef.id, seq: ticketRef.seq };
      }
      case "ignore":
        if (!previous.some((row) => row.action === "ignore")) writeDecision(trigger.id, "ignore", null, note);
        return { triggerId: trigger.id, ok: true };
      default:
        throw new Error(`未知的路由动作：${item.kind}`);
    }
  }

  // 批量路由。单项失败不影响其它项，错误原样返回给 Router。
  async function route(items) {
    const results = [];
    for (const item of items) {
      try {
        results.push(await routeItem(item));
      } catch (error) {
        results.push({ triggerId: item.triggerId, ok: false, error: error.message });
      }
    }
    return results;
  }

  function undecided() {
    return store.undecidedTriggers({ since: now() - UNDECIDED_WINDOW_MS });
  }


  // ---- 类型：没有预设清单，由已有任务长出来 ----

  function normalizeCategory(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, CATEGORY_CHARS);
  }

  // 已有的类型及其任务数（含已结束的），常用的在前；Router 和界面都只从这里取候选。
  function categories() {
    const counts = new Map();
    for (const ticket of store.listTickets()) {
      if (ticket.category) counts.set(ticket.category, (counts.get(ticket.category) || 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
  }

  // Router 自动打标签：人改过的类型不覆盖。返回最终生效的类型。
  function label(ticketRef, category) {
    const ticket = ticketByRef(ticketRef);
    const name = normalizeCategory(category);
    if (!name) return null;
    tickets.updateTicket(ticket.id, { category: name, categorySource: "router" });
    return store.getTicket(ticket.id).category;
  }

  // 改名即合并：目标名已存在时两类并成一类。这是人的操作，来源记为 user。
  function renameCategory(from, to) {
    const source = normalizeCategory(from);
    const target = normalizeCategory(to);
    if (!source) throw new Error("需要指定要改名的类型");
    let moved = 0;
    for (const ticket of store.listTickets()) {
      if (ticket.category !== source) continue;
      tickets.updateTicket(ticket.id, { category: target, categorySource: "user" });
      moved += 1;
    }
    return { moved };
  }

  // 引用：用户在界面上引用了某个任务的消息，紧接着发出的下一批消息直接归到该任务。
  // 讨论升级为工作。由 Router（accept 带讨论话题的 ticketId）或界面按钮触发。
  function promoteTicket(ticketRef, { constraints = null, title, category, by = "user" } = {}) {
    const ticket = ticketByRef(ticketRef);
    if (constraints) assertConstraints(constraints);
    const result = runner.promote(ticket.id, { constraints });
    if (result.rejected) throw new Error(result.rejected === "stopped" ? `${labelOf(ticket)} 已叫停` : `${labelOf(ticket)} 已收起，先在话题里说一句再开始`);
    if (result.already) return viewOf(store.getTicket(ticket.id));
    if (title !== undefined || category !== undefined) {
      tickets.updateTicket(ticket.id, {
        title: title || undefined,
        category: category ? normalizeCategory(category) : undefined,
        categorySource: by === "router" ? "router" : "user"
      });
    }
    say({ role: "router", kind: "ack", ticketId: ticket.id, text: `#${ticket.seq}「${store.getTicket(ticket.id).title}」已交给 Worker，开始处理。有结果我告诉你。`, dedupeKey: `promote:${ticket.id}` });
    return viewOf(store.getTicket(ticket.id));
  }

  // 找出一条对话消息背后的 trigger 与它已归属的话题。
  function resolveMessage(messageId) {
    const id = String(messageId || "");
    const trigger = store.getTrigger(id);
    if (trigger) return { trigger, ticketId: store.listLinksOfTrigger(trigger.id)[0]?.ticketId || null };
    const message = store.recentFeed(500).find((row) => row.id === id);
    if (!message) throw new Error("找不到要引用的消息");
    const source = message.triggerId ? store.getTrigger(message.triggerId) : null;
    const ticketId = message.ticketId || (source ? store.listLinksOfTrigger(source.id)[0]?.ticketId : null) || null;
    return { trigger: source, ticketId };
  }

  // 引用任意一条消息：它已有话题就用那个话题，没有就把这条消息圈成一个“讨论中”的话题。
  function quoteMessage(messageId) {
    const { trigger, ticketId } = resolveMessage(messageId);
    if (ticketId) {
      const ticket = store.getTicket(ticketId);
      if (ticket?.status === "ended" && (ticket.outcome === "stopped" || ticket.outcome === "merged")) throw new Error(`#${ticket.seq} 已${ticket.outcome === "stopped" ? "叫停" : "合并"}，不能再引用`);
      return { ...setQuote(ticketId), seq: ticket?.seq ?? null, created: false };
    }
    if (!trigger) throw new Error("这条消息没有可引用的来源");
    const ticket = runner.open({ trigger: trigger.id, title: firstLine(trigger.text), via: "ui", discussion: true });
    return { ...setQuote(ticket.id), seq: ticket.seq, created: true };
  }

  let quote = null;
  function setQuote(ticketRef) {
    quote = ticketRef ? { ticketId: ticketByRef(ticketRef).id, at: now() } : null;
    return { ticketId: quote?.ticketId || null };
  }
  function takeQuote() {
    const current = quote;
    quote = null;
    return current && now() - current.at <= QUOTE_TTL_MS ? current.ticketId : null;
  }

  // ---- IM 对话流 ----

  // 系统一侧的发言（Worker 汇报、Router 回复、程序提示）。用户消息本来就在 triggers 表。
  function say({ role, kind, text, ticketId = null, triggerId = null, runId = null, dedupeKey = null }) {
    const body = String(text || "").trim();
    if (!body) return false;
    return store.insertFeed({
      id: createId("msg"), role, kind, ticketId, triggerId, runId, text: body, dedupeKey, createdAt: now()
    });
  }

  function tagOf(ticketId, cache) {
    if (!ticketId) return null;
    if (!cache.has(ticketId)) {
      const ticket = store.getTicket(ticketId);
      cache.set(ticketId, ticket ? { id: ticket.id, seq: ticket.seq, title: ticket.title, stage: tickets.stageOf(tickets.contextOf(ticket)) } : null);
    }
    const tag = cache.get(ticketId);
    return tag ? { ...tag, stageLabel: STAGE_LABELS[tag.stage] || tag.stage } : null;
  }

  function attributionOf(trigger, cache) {
    const link = store.listLinksOfTrigger(trigger.id)[0];
    if (link) return { state: "routed", via: link.via, ticket: tagOf(link.ticketId, cache) };
    const decision = store.latestDecisionOfTrigger(trigger.id);
    if (decision?.action === "ignore") return { state: "none" };
    // 没有 Decision，或只有等 Router LLM 处理的 router 类 Decision：还在判断中。
    // Router 直接回答而没调用 ticket_route 时不会再有后续，超时后按“不属于任何任务”显示。
    return { state: now() - trigger.createdAt < PENDING_DISPLAY_MS ? "pending" : "none" };
  }

  // 一条按时间升序的对话流 + 现在需要用户处理的事。
  function feed({ limit = FEED_LIMIT } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || FEED_LIMIT, 500));
    const cache = new Map();
    const items = [
      // Worker 汇报也会以 trigger 记在任务时间线里，对话流里它们由 feed_messages 表达。
      ...store.recentTriggers(size).filter((trigger) => trigger.kind !== "worker_report").reverse().map((trigger) => ({
        id: trigger.id,
        role: trigger.trust === "user" ? "user" : "external",
        kind: trigger.kind,
        source: trigger.source,
        actor: trigger.actor,
        triggerId: trigger.id,
        text: trigger.text,
        attachments: Array.isArray(trigger.payload?.attachments) ? trigger.payload.attachments.length : 0,
        attribution: attributionOf(trigger, cache),
        createdAt: trigger.createdAt
      })),
      ...store.recentFeed(size).reverse().map((message) => ({
        id: message.id,
        role: message.role,
        kind: message.kind,
        triggerId: message.triggerId,
        text: message.text,
        ticket: tagOf(message.ticketId, cache),
        createdAt: message.createdAt
      }))
    ].sort((a, b) => a.createdAt - b.createdAt).slice(-size);
    const approvals = store.listApprovals({ status: "pending" }).map((row) => ({
      id: row.id,
      ticket: tagOf(row.ticketId, cache),
      kind: row.record.kind,
      command: row.record.command,
      cwd: row.record.cwd,
      reason: row.record.reason,
      createdAt: row.createdAt
    })).filter((row) => row.ticket);
    const { needsMe, attention } = board();
    return { items, approvals, needsMe, attention };
  }

  // ---- 读取 ----

  function viewOf(ticket) {
    const context = tickets.contextOf(ticket);
    const stage = tickets.stageOf(context);
    return {
      id: ticket.id,
      seq: ticket.seq,
      title: ticket.title,
      summary: ticket.summary,
      status: ticket.status,
      outcome: ticket.outcome,
      stage,
      stageLabel: STAGE_LABELS[stage] || stage,
      origin: ticket.origin,
      workspaceId: ticket.workspaceId,
      workspaceName: workspaceName(ticket.workspaceId),
      category: ticket.category,
      categorySource: ticket.categorySource,
      agentId: ticket.binding?.agentId || ticket.binding?.constraints?.agentId || ticket.binding?.route?.agentId || null,
      machineId: ticket.binding?.machineId || ticket.binding?.constraints?.machineId || ticket.binding?.route?.machineId || null,
      lastError: ticket.binding?.lastError || null,
      attention: ticket.attention,
      mergedInto: ticket.mergedInto,
      pendingInputs: context.pendingInputs,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      lastActivityAt: ticket.lastActivityAt,
      endedAt: ticket.endedAt
    };
  }

  const NEEDS_ME = new Set(["person/approval", "person/answer", "person/blocked"]);

  function board({ groupBy = "stage", filter = {}, limit = 0 } = {}) {
    const groups = tickets.board({ groupBy, filter, limit }).map(({ key, tickets: rows }) => ({
      key,
      label: groupBy === "stage" ? STAGE_LABELS[key] || key : groupBy === "workspace" ? workspaceName(key) || "未绑定项目" : key || "未分类",
      tickets: rows.map((row) => viewOf(store.getTicket(row.id)))
    }));
    const rows = groups.flatMap((group) => group.tickets);
    const attention = rows.filter((row) => NEEDS_ME.has(row.stage));
    return {
      groups,
      categories: categories(),
      needsMe: rows.filter((row) => NEEDS_ME.has(row.stage)).length,
      attention: attention.slice(0, 5).map(({ id, seq, title, stage, stageLabel }) => ({ id, seq, title, stage, stageLabel }))
    };
  }

  // Router 每步看到的看板快照：最多 20 个 open 任务、2000 字符。
  // 最近还没归到任何话题的用户消息：Router 判断“是不是在聊同一件事”时的依据。
  function looseMessagesLine() {
    const cutoff = now() - LOOSE_WINDOW_MS;
    const loose = store.recentUserTriggers(12)
      .filter((row) => row.createdAt >= cutoff && !store.listLinksOfTrigger(row.id).length)
      .slice(0, 6).reverse();
    return loose.length ? `\n最近未归属的消息（可 discuss 圈成话题）：\n${loose.map((row) => `- ${row.id}：${row.text.replace(/\s+/g, " ").slice(0, 60)}`).join("\n")}` : "";
  }

  function boardSnapshot() {
    return `${boardLines()}${looseMessagesLine()}`;
  }

  function boardLines() {
    const open = store.listTickets().filter((ticket) => ticket.status === "open")
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const known = categories();
    const categoryLine = known.length
      ? `已有类型：${known.slice(0, 12).map((item) => `${item.name}(${item.count})`).join("、")}`
      : "还没有任何类型";
    if (!open.length) return `当前没有进行中的话题。\n${categoryLine}`;
    const lines = [];
    let size = 0;
    for (const ticket of open.slice(0, BOARD_SNAPSHOT_TICKETS)) {
      const view = viewOf(ticket);
      const line = `#${view.seq} ${view.title}｜${view.stageLabel}${view.workspaceName ? `｜${view.workspaceName}` : ""}｜类型：${view.category || "未定"}`;
      if (size + line.length > BOARD_SNAPSHOT_CHARS) break;
      lines.push(line);
      size += line.length + 1;
    }
    const hidden = open.length - lines.length;
    return `${lines.join("\n")}${hidden > 0 ? `\n（另有 ${hidden} 个，用 ticket_list 查看）` : ""}\n${categoryLine}`;
  }

  function timeline(ticketId, { limit = TIMELINE_LIMIT } = {}) {
    tickets.stageOfTicket(ticketId);
    return store.listTriggersOfTicket(ticketId).slice(-limit).map((trigger) => {
      const decision = store.latestDecisionOfTrigger(trigger.id);
      return {
        triggerId: trigger.id,
        kind: trigger.kind,
        trust: trigger.trust,
        text: trigger.text,
        via: trigger.via,
        createdAt: trigger.createdAt,
        classification: trigger.payload?.classification || null,
        runId: trigger.payload?.runId || null,
        decision: decision ? { tier: decision.tier, action: decision.action, confidence: decision.confidence, overridden: Boolean(decision.overriddenBy) } : null
      };
    });
  }

  function detail(ticketId, { eventLimit = 160 } = {}) {
    const ticket = ticketByRef(ticketId);
    const runIds = runner.runsOf(ticket.id).map((task) => task.id);
    const runs = engine.runFeed(runIds.slice(0, 10), { eventLimit });
    const approvalsOfTicket = store.listApprovals({ ticketId: ticket.id, status: "pending" }).map((row) => ({
      id: row.id,
      taskId: row.taskId,
      kind: row.record.kind,
      command: row.record.command,
      cwd: row.record.cwd,
      reason: row.record.reason,
      createdAt: row.createdAt
    }));
    return { ticket: viewOf(ticket), timeline: timeline(ticket.id), runs, approvals: approvalsOfTicket };
  }

  // Router 的读工具：摘要 + 关联 ID + 续读游标（Inline & Spill）。
  function list({ filter = "open", cursor = null } = {}) {
    const all = store.listTickets()
      .filter((ticket) => filter === "all" || (filter === "ended" ? ticket.status === "ended" : ticket.status === "open"))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const start = Math.max(0, Number(cursor) || 0);
    const rows = all.slice(start, start + LIST_PAGE_SIZE).map(viewOf);
    return { rows, ...(start + LIST_PAGE_SIZE < all.length ? { nextCursor: String(start + LIST_PAGE_SIZE) } : {}) };
  }

  function read({ ref, cursor = null }) {
    const [kind, ...rest] = String(ref || "").split("/");
    const id = rest.join("/");
    if (kind === "ticket") {
      const { ticket, timeline: rows, runs } = detail(id, { eventLimit: 1 });
      const body = [
        `#${ticket.seq} ${ticket.title}（${ticket.stageLabel}）`,
        ticket.workspaceName ? `项目：${ticket.workspaceName}` : "",
        ticket.agentId ? `Agent：${ticket.agentId}` : "",
        ticket.summary ? `摘要：${ticket.summary}` : "",
        ...rows.map((row) => `[${row.kind}] trigger/${row.triggerId}：${row.text}`),
        ...runs.map((run) => `run/${run.taskId}：${run.status}`)
      ].filter(Boolean).join("\n");
      return page(body, cursor);
    }
    if (kind === "run") {
      const task = tasks.getTask(id);
      const refs = task.ticketId ? `ticket/${task.ticketId}` : "";
      return page([`状态：${task.status}`, refs, `指令：${task.prompt}`, task.error ? `错误：${task.error}` : "", `结果：${task.result || "（无）"}`].filter(Boolean).join("\n"), cursor);
    }
    if (kind === "trigger") {
      const trigger = store.getTrigger(id);
      if (!trigger) throw new Error(`Trigger 不存在：${id}`);
      const links = store.listLinksOfTrigger(id).map((link) => `ticket/${link.ticketId}`);
      return page([`来源：${trigger.source}`, ...links, trigger.text].join("\n"), cursor);
    }
    throw new Error(`未知引用：${ref}（应为 ticket/<id>、run/<id> 或 trigger/<id>）`);
  }

  // ---- 任务视图操作 ----

  async function send(ticketId, { clientEventId, text, attachments = [] }) {
    const ticket = ticketByRef(ticketId);
    if (!String(text || "").trim() && !attachments.length) throw new Error("消息不能为空");
    return intake({
      messageId: clientEventId || randomUUID(),
      text,
      attachments,
      source: "web-ticket",
      ui: { ticketId: ticket.id }
    });
  }

  async function update(ticketId, { title, category, outcome, agentId } = {}) {
    const ticket = ticketByRef(ticketId);
    if (outcome) await runner.close(ticket.id, { outcome });
    if (title !== undefined || category !== undefined) {
      tickets.updateTicket(ticket.id, { title, category: category === undefined ? undefined : normalizeCategory(category) });
    }
    if (agentId) {
      // 换 agent 就换 Binding：旧 runtime 会话不能带过去，由任务记录重建上下文。
      const agent = catalog.getAgent(agentId);
      const binding = store.getTicket(ticket.id).binding || {};
      tickets.updateTicket(ticket.id, {
        binding: {
          ...binding,
          agentId: agent.agentId,
          machineId: agent.machineId,
          constraints: { ...(binding.constraints || {}), agentId: agent.agentId, machineId: agent.machineId },
          runtimeSessionId: null,
          hold: false
        }
      });
      runner.pump(ticket.id);
    }
    return viewOf(store.getTicket(ticket.id));
  }

  function stop(ticketId) {
    return runner.stop(ticketByRef(ticketId).id).then(viewOf);
  }

  function merge(fromRef, intoRef) {
    return runner.merge(ticketByRef(fromRef).id, ticketByRef(intoRef).id).then(viewOf);
  }

  function decideApproval(ticketId, approvalId, decision) {
    return runner.decideApproval(ticketByRef(ticketId).id, String(approvalId), String(decision));
  }

  function reattribute(triggerId, { toTicketId = null, newTicket = false, none = false } = {}) {
    return runner.reattribute(String(triggerId), {
      ...(toTicketId ? { toTicketId: ticketByRef(toTicketId).id } : {}),
      ...(newTicket ? { newTicket } : {}),
      ...(none ? { none } : {})
    });
  }

  // 把闲置太久的话题收起。只收“有回复/空闲”的：需要人处理的、在跑的、在等机器的都不动。
  async function sweepIdle() {
    if (!archiveAfter) return [];
    const cutoff = now() - archiveAfter;
    const archived = [];
    for (const ticket of store.listTickets()) {
      if (ticket.status !== "open" || ticket.lastActivityAt > cutoff) continue;
      if (!IDLE_STAGES.has(tickets.stageOfTicket(ticket.id))) continue;
      await runner.close(ticket.id, { outcome: "done", by: "auto" });
      archived.push(ticket.id);
    }
    return archived;
  }

  function start(interrupted = []) {
    approvals.recoverInterrupted?.();
    runner.recover(interrupted);
    runner.start();
    if (archiveIntervalMs && archiveAfter && !archiveTimer) {
      sweepIdle().catch((error) => log.info?.(`[alpha-ticket] 自动收起失败：${error.message}`));
      archiveTimer = setInterval(() => {
        sweepIdle().catch((error) => log.info?.(`[alpha-ticket] 自动收起失败：${error.message}`));
      }, archiveIntervalMs);
      archiveTimer.unref?.();
    }
    if (relayIntervalMs && !relayTimer) {
      relayTimer = setInterval(() => { relay(); }, relayIntervalMs);
      relayTimer.unref?.();
    }
  }

  function dispose() {
    runner.dispose();
    if (relayTimer) clearInterval(relayTimer);
    relayTimer = null;
    if (archiveTimer) clearInterval(archiveTimer);
    archiveTimer = null;
    liveAgent = null;
  }

  return {
    store,
    tickets,
    runner,
    attribution,
    outbox,
    mainSessionId,
    setMainSession,
    bindAgent,
    relay,
    intake,
    say,
    feed,
    route,
    undecided,
    board,
    boardSnapshot,
    sweepIdle,
    categories,
    label,
    renameCategory,
    setQuote,
    takeQuote,
    quoteMessage,
    promote: promoteTicket,
    list,
    read,
    detail,
    timeline,
    send,
    update,
    stop,
    merge,
    decideApproval,
    reattribute,
    start,
    dispose
  };
}
