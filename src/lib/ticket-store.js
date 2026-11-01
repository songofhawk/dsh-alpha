// Ticket 数据访问层：SuperAgent R1 新表（tickets / triggers / ticket_triggers /
// decisions / ticket_inputs / subscriptions / approvals）的纯 CRUD。
// 与 task-store 共享同一个 DatabaseSync（同一个 tasks.sqlite3），保证 Ticket 和
// Run（tasks 表）能同事务写入；所有写入按唯一约束幂等，可安全重试。
// outbox 表的访问封装在 outbox.js，不在本模块。

const crypto = require("node:crypto");
const { runMigrations } = require("./task-store.js");

function createId(prefix) {
  return `${prefix || "row"}_${crypto.randomUUID()}`;
}

function mapTicket(row) {
  if (!row) return null;
  return {
    id: row.id,
    seq: row.seq,
    status: row.status,
    outcome: row.outcome,
    title: row.title,
    summary: row.summary,
    origin: row.origin,
    workspaceId: row.workspace_id,
    category: row.category,
    categorySource: row.category_source,
    binding: row.binding_json ? JSON.parse(row.binding_json) : null,
    attention: row.attention_json ? JSON.parse(row.attention_json) : null,
    mergedInto: row.merged_into,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    endedAt: row.ended_at
  };
}

function mapTrigger(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    sourceEventId: row.source_event_id,
    threadKey: row.thread_key,
    actor: row.actor,
    kind: row.kind,
    trust: row.trust,
    text: row.text,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at
  };
}

function mapDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    triggerId: row.trigger_id,
    tier: row.tier,
    action: row.action,
    ticketId: row.ticket_id,
    confidence: row.confidence,
    probability: row.probability,
    margin: row.margin,
    candidates: row.candidates_json ? JSON.parse(row.candidates_json) : null,
    reason: row.reason,
    overriddenBy: row.overridden_by,
    createdAt: row.created_at
  };
}

function mapInput(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    triggerId: row.trigger_id,
    status: row.status,
    runId: row.run_id,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at
  };
}

function mapApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    ticketId: row.ticket_id,
    status: row.status,
    record: JSON.parse(row.record_json),
    createdAt: row.created_at,
    decidedAt: row.decided_at
  };
}

const TICKET_PATCH_COLUMNS = {
  status: "status",
  outcome: "outcome",
  title: "title",
  summary: "summary",
  workspaceId: "workspace_id",
  category: "category",
  categorySource: "category_source",
  mergedInto: "merged_into",
  updatedAt: "updated_at",
  lastActivityAt: "last_activity_at",
  endedAt: "ended_at"
};

function createTicketStore({ database }) {
  if (!database) throw new Error("createTicketStore 需要注入共享的 database");
  // 幂等，保证单独构造本模块时新表也已就绪。
  runMigrations(database);

  const statements = {
    insertTicket: database.prepare(`
      INSERT INTO tickets(
        id, seq, status, outcome, title, summary, origin, workspace_id,
        category, category_source, binding_json, attention_json, merged_into,
        created_at, updated_at, last_activity_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getTicket: database.prepare("SELECT * FROM tickets WHERE id = ?"),
    getTicketBySeq: database.prepare("SELECT * FROM tickets WHERE seq = ?"),
    listTickets: database.prepare("SELECT * FROM tickets ORDER BY seq"),
    nextTicketSeq: database.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM tickets"),

    insertTrigger: database.prepare(`
      INSERT INTO triggers(id, source, source_event_id, thread_key, actor, kind, trust, text, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, source_event_id) DO NOTHING
    `),
    getTrigger: database.prepare("SELECT * FROM triggers WHERE id = ?"),
    getTriggerBySource: database.prepare("SELECT * FROM triggers WHERE source = ? AND source_event_id = ?"),

    linkTrigger: database.prepare(`
      INSERT OR IGNORE INTO ticket_triggers(ticket_id, trigger_id, via) VALUES (?, ?, ?)
    `),
    unlinkTrigger: database.prepare(`
      DELETE FROM ticket_triggers WHERE ticket_id = ? AND trigger_id = ?
    `),
    listLinksOfTrigger: database.prepare(`
      SELECT ticket_id, trigger_id, via FROM ticket_triggers WHERE trigger_id = ?
    `),
    listTriggersOfTicket: database.prepare(`
      SELECT t.*, tt.via AS link_via
      FROM ticket_triggers tt JOIN triggers t ON t.id = tt.trigger_id
      WHERE tt.ticket_id = ?
      ORDER BY t.created_at, t.rowid
    `),

    // 用户最近的消息及其归属，供 Jev 判断“再加个测试”这类省略句。
    recentUserTriggers: database.prepare(`
      SELECT * FROM triggers WHERE trust = 'user' ORDER BY created_at DESC, rowid DESC LIMIT ?
    `),
    lastUserTextOfTicket: database.prepare(`
      SELECT t.text FROM ticket_triggers tt JOIN triggers t ON t.id = tt.trigger_id
      WHERE tt.ticket_id = ? AND t.trust = 'user'
      ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1
    `),
    // 归属未决：只有 router 类 Decision，等 Router LLM 用 ticket_route 处理。
    undecidedTriggers: database.prepare(`
      SELECT t.* FROM triggers t
      WHERE t.created_at >= ?
        AND EXISTS (SELECT 1 FROM decisions d WHERE d.trigger_id = t.id AND d.action = 'router')
        AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.trigger_id = t.id AND d.action <> 'router')
      ORDER BY t.created_at, t.rowid
      LIMIT ?
    `),

    getMeta: database.prepare("SELECT value FROM alpha_meta WHERE key = ?"),
    setMeta: database.prepare(`
      INSERT INTO alpha_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),

    insertDecision: database.prepare(`
      INSERT INTO decisions(
        id, trigger_id, tier, action, ticket_id, confidence, probability,
        margin, candidates_json, reason, overridden_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `),
    getDecision: database.prepare("SELECT * FROM decisions WHERE id = ?"),
    latestDecisionOfTrigger: database.prepare(`
      SELECT * FROM decisions WHERE trigger_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `),
    markDecisionOverridden: database.prepare(`
      UPDATE decisions SET overridden_by = ? WHERE id = ?
    `),
    setDecisionTicket: database.prepare(`
      UPDATE decisions SET ticket_id = ? WHERE id = ?
    `),

    insertInput: database.prepare(`
      INSERT INTO ticket_inputs(id, ticket_id, trigger_id, status, run_id, created_at, delivered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `),
    getInput: database.prepare("SELECT * FROM ticket_inputs WHERE id = ?"),
    pendingInputCount: database.prepare(`
      SELECT COUNT(*) AS count FROM ticket_inputs WHERE ticket_id = ? AND status = 'pending'
    `),

    addSubscription: database.prepare(`
      INSERT OR IGNORE INTO subscriptions(ticket_id, thread_key, role, created_at) VALUES (?, ?, ?, ?)
    `),
    removeSubscription: database.prepare(`
      DELETE FROM subscriptions WHERE ticket_id = ? AND thread_key = ?
    `),
    listSubscriptions: database.prepare(`
      SELECT ticket_id, thread_key, role, created_at FROM subscriptions WHERE ticket_id = ?
    `),

    insertApproval: database.prepare(`
      INSERT INTO approvals(id, task_id, ticket_id, status, record_json, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        ticket_id = excluded.ticket_id,
        status = excluded.status,
        record_json = excluded.record_json,
        created_at = excluded.created_at,
        decided_at = excluded.decided_at
      WHERE approvals.status <> 'pending'
    `),
    getApproval: database.prepare("SELECT * FROM approvals WHERE id = ?"),
    pendingApprovalCount: database.prepare(`
      SELECT COUNT(*) AS count FROM approvals WHERE ticket_id = ? AND status = 'pending'
    `)
  };

  // 单连接上的显式事务；与 task-store 共用连接时，本事务可跨两边写入。
  // 不可重入：调用方不得在回调里再开事务。
  function transact(callback) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* 保留原始数据库异常 */ }
      throw error;
    }
  }

  function insertTicket(ticket) {
    statements.insertTicket.run(
      ticket.id,
      ticket.seq,
      ticket.status,
      ticket.outcome ?? null,
      ticket.title,
      ticket.summary ?? "",
      ticket.origin,
      ticket.workspaceId ?? null,
      ticket.category ?? null,
      ticket.categorySource ?? null,
      ticket.binding ? JSON.stringify(ticket.binding) : null,
      ticket.attention ? JSON.stringify(ticket.attention) : null,
      ticket.mergedInto ?? null,
      ticket.createdAt,
      ticket.updatedAt,
      ticket.lastActivityAt,
      ticket.endedAt ?? null
    );
    return getTicket(ticket.id);
  }

  function getTicket(id) {
    return mapTicket(statements.getTicket.get(id));
  }

  function getTicketBySeq(seq) {
    return mapTicket(statements.getTicketBySeq.get(seq));
  }

  function listTickets() {
    return statements.listTickets.all().map(mapTicket);
  }

  // 只更新白名单字段；binding / attention 走 JSON 列。
  function updateTicket(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(TICKET_PATCH_COLUMNS)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    if (patch.binding !== undefined) {
      sets.push("binding_json = ?");
      values.push(patch.binding ? JSON.stringify(patch.binding) : null);
    }
    if (patch.attention !== undefined) {
      sets.push("attention_json = ?");
      values.push(patch.attention ? JSON.stringify(patch.attention) : null);
    }
    if (!sets.length) return getTicket(id);
    database.prepare(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return getTicket(id);
  }

  function nextTicketSeq() {
    return Number(statements.nextTicketSeq.get().seq);
  }

  // 幂等：按 (source, sourceEventId) 去重，重复写入返回已存在的行。
  function insertTrigger(trigger) {
    const result = statements.insertTrigger.run(
      trigger.id,
      trigger.source,
      trigger.sourceEventId,
      trigger.threadKey ?? null,
      trigger.actor ?? null,
      trigger.kind,
      trigger.trust,
      trigger.text ?? "",
      JSON.stringify(trigger.payload ?? {}),
      trigger.createdAt
    );
    return {
      trigger: mapTrigger(statements.getTriggerBySource.get(trigger.source, trigger.sourceEventId)),
      created: result.changes > 0
    };
  }

  function getTrigger(id) {
    return mapTrigger(statements.getTrigger.get(id));
  }

  function linkTrigger(ticketId, triggerId, via) {
    statements.linkTrigger.run(ticketId, triggerId, via);
  }

  function unlinkTrigger(ticketId, triggerId) {
    statements.unlinkTrigger.run(ticketId, triggerId);
  }

  function listLinksOfTrigger(triggerId) {
    return statements.listLinksOfTrigger.all(triggerId).map((row) => ({
      ticketId: row.ticket_id,
      triggerId: row.trigger_id,
      via: row.via
    }));
  }

  // 任务时间线：返回 trigger 行并附上归属路径 via。
  function listTriggersOfTicket(ticketId) {
    return statements.listTriggersOfTicket.all(ticketId).map((row) => ({
      ...mapTrigger(row),
      via: row.link_via
    }));
  }

  function recentUserTriggers(limit = 3) {
    return statements.recentUserTriggers.all(limit).map(mapTrigger);
  }

  function lastUserTextOfTicket(ticketId) {
    return statements.lastUserTextOfTicket.get(ticketId)?.text || "";
  }

  function undecidedTriggers({ since = 0, limit = 10 } = {}) {
    return statements.undecidedTriggers.all(since, limit).map(mapTrigger);
  }

  function getMeta(key) {
    return statements.getMeta.get(key)?.value ?? null;
  }

  function setMeta(key, value) {
    statements.setMeta.run(key, String(value));
  }

  function listDecisionsOfTrigger(triggerId) {
    return database.prepare("SELECT * FROM decisions WHERE trigger_id = ? ORDER BY created_at, rowid").all(triggerId).map(mapDecision);
  }

  function insertDecision(decision) {
    statements.insertDecision.run(
      decision.id,
      decision.triggerId,
      decision.tier,
      decision.action,
      decision.ticketId ?? null,
      decision.confidence ?? null,
      decision.probability ?? null,
      decision.margin ?? null,
      decision.candidates ? JSON.stringify(decision.candidates) : null,
      decision.reason ?? null,
      decision.overriddenBy ?? null,
      decision.createdAt
    );
    return getDecision(decision.id);
  }

  function getDecision(id) {
    return mapDecision(statements.getDecision.get(id));
  }

  function latestDecisionOfTrigger(triggerId) {
    return mapDecision(statements.latestDecisionOfTrigger.get(triggerId));
  }

  function markDecisionOverridden(id, overriddenBy) {
    statements.markDecisionOverridden.run(overriddenBy, id);
  }

  // new 类 Decision 落库时任务还没建，建好后补上。
  function setDecisionTicket(id, ticketId) {
    statements.setDecisionTicket.run(ticketId, id);
  }

  function insertInput(input) {
    statements.insertInput.run(
      input.id,
      input.ticketId,
      input.triggerId,
      input.status ?? "pending",
      input.runId ?? null,
      input.createdAt,
      input.deliveredAt ?? null
    );
    return getInput(input.id);
  }

  function getInput(id) {
    return mapInput(statements.getInput.get(id));
  }

  const INPUT_PATCH_COLUMNS = {
    ticketId: "ticket_id",
    status: "status",
    runId: "run_id",
    deliveredAt: "delivered_at"
  };

  function updateInput(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(INPUT_PATCH_COLUMNS)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    if (!sets.length) return getInput(id);
    database.prepare(`UPDATE ticket_inputs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return getInput(id);
  }

  function listInputs({ ticketId = null, status = null, triggerId = null } = {}) {
    const conditions = [];
    const values = [];
    if (ticketId) { conditions.push("ticket_id = ?"); values.push(ticketId); }
    if (status) { conditions.push("status = ?"); values.push(status); }
    if (triggerId) { conditions.push("trigger_id = ?"); values.push(triggerId); }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return database.prepare(`SELECT * FROM ticket_inputs${where} ORDER BY created_at, rowid`).all(...values).map(mapInput);
  }

  function pendingInputCount(ticketId) {
    return Number(statements.pendingInputCount.get(ticketId).count);
  }

  function addSubscription({ ticketId, threadKey, role = "own", createdAt = Date.now() }) {
    statements.addSubscription.run(ticketId, threadKey, role, createdAt);
  }

  function removeSubscription(ticketId, threadKey) {
    statements.removeSubscription.run(ticketId, threadKey);
  }

  function listSubscriptions({ ticketId }) {
    return statements.listSubscriptions.all(ticketId).map((row) => ({
      ticketId: row.ticket_id,
      threadKey: row.thread_key,
      role: row.role,
      createdAt: row.created_at
    }));
  }

  // 审批 ID 来自 runtime，不同 Run 可能重复：已决的旧记录让位给新审批，
  // 否则新审批落不了库，任务进不了 person/approval。待决记录仍幂等。
  function insertApproval(approval) {
    statements.insertApproval.run(
      approval.id,
      approval.taskId,
      approval.ticketId ?? null,
      approval.status ?? "pending",
      JSON.stringify(approval.record ?? {}),
      approval.createdAt,
      approval.decidedAt ?? null
    );
    return getApproval(approval.id);
  }

  function getApproval(id) {
    return mapApproval(statements.getApproval.get(id));
  }

  function updateApproval(id, patch) {
    const sets = [];
    const values = [];
    if (patch.status !== undefined) { sets.push("status = ?"); values.push(patch.status); }
    if (patch.ticketId !== undefined) { sets.push("ticket_id = ?"); values.push(patch.ticketId); }
    if (patch.decidedAt !== undefined) { sets.push("decided_at = ?"); values.push(patch.decidedAt); }
    if (patch.record !== undefined) { sets.push("record_json = ?"); values.push(JSON.stringify(patch.record)); }
    if (!sets.length) return getApproval(id);
    database.prepare(`UPDATE approvals SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return getApproval(id);
  }

  function listApprovals({ ticketId = null, status = null } = {}) {
    const conditions = [];
    const values = [];
    if (ticketId) { conditions.push("ticket_id = ?"); values.push(ticketId); }
    if (status) { conditions.push("status = ?"); values.push(status); }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return database.prepare(`SELECT * FROM approvals${where} ORDER BY created_at, rowid`).all(...values).map(mapApproval);
  }

  function pendingApprovalCount(ticketId) {
    return Number(statements.pendingApprovalCount.get(ticketId).count);
  }

  return {
    database,
    transact,
    nextTicketSeq,
    insertTicket,
    getTicket,
    getTicketBySeq,
    listTickets,
    updateTicket,
    insertTrigger,
    getTrigger,
    linkTrigger,
    unlinkTrigger,
    listLinksOfTrigger,
    listTriggersOfTicket,
    recentUserTriggers,
    lastUserTextOfTicket,
    undecidedTriggers,
    getMeta,
    setMeta,
    listDecisionsOfTrigger,
    insertDecision,
    getDecision,
    latestDecisionOfTrigger,
    markDecisionOverridden,
    setDecisionTicket,
    insertInput,
    getInput,
    updateInput,
    listInputs,
    pendingInputCount,
    addSubscription,
    removeSubscription,
    listSubscriptions,
    insertApproval,
    getApproval,
    updateApproval,
    listApprovals,
    pendingApprovalCount
  };
}

module.exports = { createTicketStore, createId };
