// Ticket 引擎核心流转测试（docs/superagent-design.md 第 6、7 节）。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTaskStore } = require("../src/lib/task-store.js");
const { createTicketStore } = require("../src/lib/ticket-store.js");
const { createTicketEngine } = require("../src/lib/ticket-engine.js");
const { tmpDir, cleanupDir } = require("./helpers.js");

function makeEngine(t, deps = {}) {
  const dir = tmpDir("ticket-engine-");
  const taskStore = createTaskStore({ dataDir: dir });
  const store = createTicketStore({ database: taskStore.database });
  let current = 1_000_000;
  const engine = createTicketEngine({ store, deps, now: () => current });
  const events = [];
  for (const name of ["ticket.created", "ticket.stage", "ticket.report", "ticket.ended"]) {
    engine.on(name, (payload) => events.push({ name, payload }));
  }
  t.after(() => {
    taskStore.close();
    cleanupDir(dir);
  });
  return { engine, store, taskStore, events, tick: (ms = 1) => { current += ms; return current; } };
}

function userTrigger(id, text) {
  return { source: "web", sourceEventId: id, kind: "user_message", trust: "user", text };
}

test("openTicket 建任务：seq 递增、trigger 幂等落库、发 ticket.created", (t) => {
  const { engine, store, events } = makeEngine(t);
  const t1 = engine.openTicket({ trigger: userTrigger("m1", "修复 A 项目登录 bug") });
  assert.equal(t1.seq, 1);
  assert.equal(t1.status, "open");
  assert.equal(t1.origin, "user");
  assert.equal(t1.title, "修复 A 项目登录 bug");
  assert.equal(engine.stageOfTicket(t1.id), "idle");

  const t2 = engine.openTicket({ trigger: userTrigger("m2", "看下 CI"), title: "B 项目 CI" });
  assert.equal(t2.seq, 2);
  assert.equal(t2.title, "B 项目 CI");
  assert.equal(events.filter((e) => e.name === "ticket.created").length, 2);
  // 创建瞬间只发 ticket.created，不重复发 ticket.stage
  assert.equal(events.filter((e) => e.name === "ticket.stage").length, 0);

  // 同一来源事件重复进来：trigger 按 (source, source_event_id) 幂等
  engine.openTicket({ trigger: userTrigger("m1", "修复 A 项目登录 bug") });
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM triggers WHERE source = 'web' AND source_event_id = 'm1'").get().count,
    1
  );
});

test("核心流转：open → submitInput → stop 后不可重开，done 后人可重开", (t) => {
  const { engine, store, events, tick } = makeEngine(t);
  const ticket = engine.openTicket({ trigger: userTrigger("m1", "修登录 bug") });
  tick();
  const input = engine.submitInput(ticket.id, userTrigger("m2", "再加个回归测试"), { via: "t0" });
  assert.equal(input.status, "pending");
  assert.equal(engine.stageOfTicket(ticket.id), "working/queued");
  assert.deepEqual(
    store.listLinksOfTrigger(input.triggerId).map((l) => [l.ticketId, l.via]),
    [[ticket.id, "t0"]]
  );
  assert.ok(events.some((e) => e.name === "ticket.stage" && e.payload.to === "working/queued"));

  // 用户叫停：ended/stopped，发 ticket.ended
  tick();
  const stopped = engine.stopTicket(ticket.id, { by: "user" });
  assert.equal(stopped.status, "ended");
  assert.equal(stopped.outcome, "stopped");
  assert.equal(events.filter((e) => e.name === "ticket.ended").length, 1);
  // 叫停是幂等的，重复 stop 不再发事件
  engine.stopTicket(ticket.id, { by: "user" });
  assert.equal(events.filter((e) => e.name === "ticket.ended").length, 1);

  // 用户叫停过的任务，人的新消息也不能重开
  tick();
  engine.submitInput(ticket.id, userTrigger("m3", "继续搞"));
  assert.equal(store.getTicket(ticket.id).status, "ended");
  assert.equal(store.getTicket(ticket.id).outcome, "stopped");

  // 正常结束的任务：系统消息不能重开，人的新消息可以
  tick();
  store.updateTicket(ticket.id, { status: "ended", outcome: "done", endedAt: tick() });
  tick();
  engine.submitInput(ticket.id, { source: "worker", sourceEventId: "sys-1", kind: "worker_report", trust: "system", text: "ci ok" });
  assert.equal(store.getTicket(ticket.id).status, "ended");
  tick();
  engine.submitInput(ticket.id, userTrigger("m4", "再改一版"));
  const reopened = store.getTicket(ticket.id);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.outcome, null);
  assert.equal(reopened.endedAt, null);
});

test("报告驱动 stage：blocked / question / ready 与 ticket.report 事件", (t) => {
  const { engine, store, events, tick } = makeEngine(t);
  const ticket = engine.openTicket({ trigger: userTrigger("m1", "做功能 X") });

  tick();
  engine.noteReport(ticket.id, { kind: "blocked", runId: "run-1", text: "卡在依赖安装" });
  assert.equal(engine.stageOfTicket(ticket.id), "person/blocked");
  assert.ok(events.some((e) => e.name === "ticket.report"));
  assert.ok(events.some((e) => e.name === "ticket.stage" && e.payload.to === "person/blocked"));

  // 人回复后离开 blocked
  tick();
  engine.submitInput(ticket.id, userTrigger("m2", "用镜像源再试"));
  assert.equal(engine.stageOfTicket(ticket.id), "working/queued");

  // question 报告写入 attention → person/answer；resolveAttention 后回落
  tick();
  engine.noteReport(ticket.id, { kind: "question", runId: "run-1", question: "选 A 还是 B？", sourceEventId: "run-1-q1" });
  assert.equal(engine.stageOfTicket(ticket.id), "person/answer");
  assert.equal(store.getTicket(ticket.id).attention.question, "选 A 还是 B？");
  tick();
  const resolved = engine.resolveAttention(ticket.id, null);
  assert.equal(resolved.attention, null);
  assert.equal(engine.stageOfTicket(ticket.id), "working/queued");

  // ready → idle/replied（压过排队输入）
  tick();
  engine.noteReport(ticket.id, { kind: "ready", runId: "run-1", sourceEventId: "run-1-ready" });
  assert.equal(engine.stageOfTicket(ticket.id), "idle/replied");
});

test("stage 上下文由 deps 注入：离线 → waiting/machine，活动 Run → working/running", (t) => {
  let online = false;
  let activeRun = false;
  const { engine } = makeEngine(t, {
    machineOnline: () => online,
    hasActiveRun: () => activeRun
  });
  const ticket = engine.openTicket({ trigger: userTrigger("m1", "部署一下") });
  engine.submitInput(ticket.id, userTrigger("m2", "先等等"));
  assert.equal(engine.stageOfTicket(ticket.id), "waiting/machine");
  online = true;
  assert.equal(engine.stageOfTicket(ticket.id), "working/queued");
  activeRun = true;
  assert.equal(engine.stageOfTicket(ticket.id), "working/running");
});

test("reattribute：移动 / 拆新 / 标无关，并标记原 Decision overridden_by", (t) => {
  const { engine, store, tick } = makeEngine(t);
  const t1 = engine.openTicket({ trigger: userTrigger("m1", "任务一") });
  const t2 = engine.openTicket({ trigger: userTrigger("m2", "任务二") });
  tick();
  const input = engine.submitInput(t1.id, userTrigger("m3", "这句其实属于任务二"), { via: "jev" });
  const triggerId = input.triggerId;
  store.insertDecision({ id: "dec-old", triggerId, tier: 1, action: "attach", ticketId: t1.id, createdAt: tick() });

  // 移动到 t2：链接与 pending 输入都搬过去，原 Decision 被标记
  tick();
  const decision = engine.reattribute(triggerId, { toTicketId: t2.id });
  assert.equal(decision.action, "attach");
  assert.equal(decision.ticketId, t2.id);
  assert.deepEqual(store.listLinksOfTrigger(triggerId).map((l) => l.ticketId), [t2.id]);
  assert.equal(store.getInput(input.id).ticketId, t2.id);
  assert.equal(store.getInput(input.id).status, "pending");
  assert.equal(store.getDecision("dec-old").overriddenBy, decision.id);

  // 已送达的输入：原输入标 moved，目标任务补一条 pending
  tick();
  store.updateInput(input.id, { status: "delivered", deliveredAt: tick() });
  tick();
  const t3 = engine.openTicket({ trigger: userTrigger("m4", "任务三") });
  tick();
  const decision2 = engine.reattribute(triggerId, { toTicketId: t3.id });
  assert.equal(store.getInput(input.id).status, "moved");
  const pendingOnT3 = store.listInputs({ ticketId: t3.id, status: "pending" });
  assert.equal(pendingOnT3.length, 1);
  assert.equal(pendingOnT3[0].triggerId, triggerId);
  assert.equal(store.getDecision(decision.id).overriddenBy, decision2.id);

  // 拆成新任务
  tick();
  const decision3 = engine.reattribute(triggerId, { newTicket: { title: "拆出去的任务" } });
  assert.equal(decision3.action, "new");
  const created = store.getTicket(decision3.ticketId);
  assert.equal(created.title, "拆出去的任务");
  assert.deepEqual(store.listLinksOfTrigger(triggerId).map((l) => l.ticketId), [created.id]);

  // 标为无关：链接移除，pending 输入标 moved
  tick();
  const decision4 = engine.reattribute(triggerId, { none: true });
  assert.equal(decision4.action, "none");
  assert.equal(decision4.ticketId, null);
  assert.deepEqual(store.listLinksOfTrigger(triggerId), []);
  assert.deepEqual(store.listInputs({ triggerId, status: "pending" }), []);

  // 参数校验：去向必须且只能一个
  assert.throws(() => engine.reattribute(triggerId, {}), /去向/);
  assert.throws(() => engine.reattribute(triggerId, { toTicketId: t1.id, none: true }), /去向/);
});

test("mergeTickets：时间线 / 输入 / 订阅搬到 into，from 记 ended/merged", (t) => {
  const { engine, store, events, tick } = makeEngine(t);
  const t1 = engine.openTicket({ trigger: userTrigger("m1", "重复任务 A") });
  tick();
  const t2 = engine.openTicket({ trigger: userTrigger("m2", "重复任务 B") });
  tick();
  engine.submitInput(t1.id, userTrigger("m3", "A 的补充"));
  store.addSubscription({ ticketId: t1.id, threadKey: "thread-1", role: "own" });
  tick();
  const merged = engine.mergeTickets(t1.id, t2.id);
  assert.equal(merged.status, "ended");
  assert.equal(merged.outcome, "merged");
  assert.equal(merged.mergedInto, t2.id);
  assert.equal(engine.stageOfTicket(t1.id), "ended/merged");

  const texts = store.listTriggersOfTicket(t2.id).map((tr) => tr.text);
  assert.ok(texts.includes("重复任务 A") && texts.includes("A 的补充") && texts.includes("重复任务 B"));
  assert.deepEqual(store.listInputs({ ticketId: t1.id }), []);
  assert.equal(store.listInputs({ ticketId: t2.id }).length, 1);
  assert.deepEqual(store.listSubscriptions({ ticketId: t2.id }).map((s) => s.threadKey), ["thread-1"]);
  assert.ok(events.some((e) => e.name === "ticket.ended" && e.payload.by === "merge"));
  assert.throws(() => engine.mergeTickets(t2.id, t2.id), /自身/);
});

test("board：按 stage 分组排序，支持 filter 与 limit", (t) => {
  const { engine, store, tick } = makeEngine(t);
  const a = engine.openTicket({ trigger: userTrigger("m1", "需要审批的任务") });
  tick();
  const b = engine.openTicket({ trigger: userTrigger("m2", "跑着的任务") });
  tick();
  const c = engine.openTicket({ trigger: userTrigger("m3", "闲着的任务") });
  tick();
  const d = engine.openTicket({ trigger: userTrigger("m4", "完成的任务") });
  store.insertApproval({ id: "apr-1", taskId: "task-1", ticketId: a.id, record: {}, createdAt: tick() });
  tick();
  engine.submitInput(b.id, userTrigger("m5", "b 的补充"));
  tick();
  store.updateTicket(d.id, { status: "ended", outcome: "done", endedAt: tick() });

  const rows = engine.board();
  assert.deepEqual(rows.map((r) => r.key), ["person/approval", "working/queued", "idle", "ended/done"]);
  assert.equal(rows[0].tickets[0].id, a.id);
  assert.equal(rows[0].tickets[0].stage, "person/approval");

  assert.deepEqual(engine.board({ filter: { stage: "idle" } })[0].tickets.map((tk) => tk.id), [c.id]);
  assert.equal(engine.board({ filter: { status: "open" } }).some((r) => r.key.startsWith("ended/")), false);

  tick();
  const e = engine.openTicket({ trigger: userTrigger("m6", "又一个闲任务") });
  const idleGroup = engine.board({ limit: 1 }).find((r) => r.key === "idle");
  assert.equal(idleGroup.tickets.length, 1);
  // 组内按 lastActivityAt 降序，新任务在前
  assert.equal(idleGroup.tickets[0].id, e.id);

  store.updateTicket(c.id, { workspaceId: "ws-1" });
  store.updateTicket(e.id, { workspaceId: "ws-1" });
  const byWorkspace = engine.board({ groupBy: "workspace", filter: { status: "open" } });
  assert.equal(byWorkspace.find((r) => r.key === "ws-1").tickets.length, 2);
});
