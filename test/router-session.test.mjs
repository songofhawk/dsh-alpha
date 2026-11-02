// R1 里程碑（docs/superagent-design.md 第 8.2 节）：真实宿主循环 + 真实任务引擎，
// 只替换 runtime（可控脚本）和两个模型（Jev、Router LLM）。
import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { LlmRuntime, LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm";
import { apply } from "../src/router-tools.mjs";
import { createCatalog } from "../src/lib/catalog.js";
import { createTaskStore } from "../src/lib/task-store.js";
import { createTicketStore } from "../src/lib/ticket-store.js";
import { createApprovalBroker } from "../src/lib/approvals.js";
import { createTaskEngine } from "../src/lib/task-engine.js";
import { createTicketService, reportText } from "../src/lib/ticket-service.mjs";
import { buildCapabilitiesFor, probeAvailability } from "../src/lib/adapters.js";
import { waitFor, tmpDir, cleanupDir } from "./helpers.js";

function scriptedAdapter(calls) {
  return {
    async *runTurn(context) {
      const call = { session: context.session, prompt: context.message, requestApproval: context.requestApproval, steered: [] };
      call.done = new Promise((resolve) => { call.finish = resolve; });
      calls.push(call);
      yield { type: "runtime_session", payload: { runtime_session_id: context.session.runtime_session_id || `rt-${calls.length}` } };
      const outcome = await call.done;
      if (outcome?.error) throw new Error(outcome.error);
      yield { type: "complete", payload: { message: outcome?.text || "完成" } };
    },
    async cancelTurn({ session }) { calls.find((call) => call.session.id === session.id)?.finish({ error: "已取消" }); return {}; },
    async steerTurn({ session, message }) { calls.find((call) => call.session.id === session.id).steered.push(message); return {}; }
  };
}

function toolCall(id, name, args) {
  const block = { type: "tool-call", id, name, arguments: JSON.stringify(args) };
  return [
    { type: "block-start", index: 0, blockType: block.type },
    { type: "tool-call-delta", index: 0, id, name, argumentsDelta: block.arguments },
    { type: "block-end", index: 0, block },
    { type: "finish", reason: { kind: "tool-calls" } }
  ];
}

function text(value) {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: value },
    { type: "block-end", index: 0, block: { type: "text", text: value } },
    { type: "finish", reason: { kind: "stop" } }
  ];
}

// Jev 脚本：按原文返回归属；没写的句子一律不确定，走 T2。
function scriptedJev(script) {
  const choice = (value) => ({ type: "choice", choice: value, confidence: 0.95, probabilities: { [value]: 0.95 } });
  return {
    async ask({ state, questions }) {
      const line = script(state.request, questions.ticket.criteria);
      if (!line) return { intent: choice("unsure"), ticket: choice("unsure") };
      return { intent: choice(line.intent || "work"), ticket: choice(line.ticket), selfContained: { type: "noul", noul: 0.9 } };
    }
  };
}

function keyOfTitle(criteria, title) {
  return Object.keys(criteria).find((key) => criteria[key]?.title === title);
}

async function harness(t, { dir = null, jev = null, llm = null, sessionId = "session-main", calls = [] } = {}) {
  const dataDir = dir || tmpDir("alpha-router-");
  if (!dir) t.after(() => cleanupDir(dataDir));
  const ctx = new Context();
  new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  new AgentRegistry(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  new ToolRuntime(ctx);
  new LlmRuntime(ctx);
  new AgentLoop(ctx, AgentLoop.Config({ agents: [] }));
  const modelCalls = [];
  class SpyAdapter extends LlmAdapter {
    async *stream(options) {
      modelCalls.push(options);
      yield* (llm ? llm(options, modelCalls.length) : text("主控回复"));
    }
  }
  ctx.llm.registerAdapter(["spy"], new SpyAdapter());

  const catalog = createCatalog({
    allowedRoots: [dataDir],
    adapterProvider: { capabilitiesFor: (provider) => ({ ...buildCapabilitiesFor(provider), session_resume: true, steer: true }), probeAvailability }
  });
  catalog.registerAgent({ provider: "mock" });
  const agentId = catalog.listAgents()[0].agentId;
  const tasks = createTaskStore({ dataDir });
  const interrupted = tasks.recoverInterrupted();
  const store = createTicketStore({ database: tasks.database });
  const approvals = createApprovalBroker({ store: tasks, persistence: store });
  const engine = createTaskEngine({ catalog, store: tasks, approvals, adapterFor: () => scriptedAdapter(calls), defaults: { mode: "default" }, allowedRoots: [dataDir] });
  const selections = new Map();
  const workspaces = {
    selection: (id) => selections.get(id) || {},
    select: (id, value) => { if (value === null) selections.delete(id); else selections.set(id, value); },
    list: () => [],
    get: () => null,
    resolve: () => ({ workspace: null, source: "none", ambiguous: [] })
  };
  const route = { agentId };
  const service = createTicketService({
    store, tasks, engine, catalog, approvals, workspaces, jev,
    router: jev ? { prepare: () => ({ immediate: route }) } : null,
    pumpIntervalMs: 0, relayIntervalMs: 0
  });
  service.start(interrupted);
  ctx.provide("alphaCatalog", catalog);
  ctx.provide("alphaWorkspaces", workspaces);
  ctx.provide("alphaTickets", service);
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: "spy", model: "spy-model" },
    setup: async (agentCtx) => { apply(agentCtx); }
  });
  const dispose = async () => {
    service.dispose();
    await handle.dispose();
  };
  t.after(dispose);
  const assistantText = () => handle.agent.session.snapshotEvents()
    .filter((event) => event.type === "assistant/message")
    .map((event) => event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
  return {
    ctx, calls, modelCalls, agent: handle.agent, service, store, tasks, agentId, workspaces, selections, dataDir, assistantText, interrupted, dispose,
    async say(value) {
      handle.agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: value }] }));
      await handle.agent.whenIdle();
      return assistantText().at(-1);
    },
    ticket: (seq) => store.getTicketBySeq(seq),
    stage: (seq) => service.tickets.stageOfTicket(store.getTicketBySeq(seq).id)
  };
}

test("R1 全流程：多任务并行、省略句归属、问进度、审批、续接、改归属、重启恢复", { timeout: 20_000 }, async (t) => {
  const dir = tmpDir("alpha-r1-");
  t.after(() => cleanupDir(dir));
  const jev = scriptedJev((request, criteria) => ({
    "修复 A 项目登录 bug": { ticket: "new" },
    "看下 B 项目 CI 为什么挂了": { ticket: "new" },
    "登录那个再加个回归测试": { ticket: keyOfTitle(criteria, "修复 A 项目登录 bug") },
    "现在都什么进度": { intent: "status", ticket: "unsure" },
    "CI 那个顺便把缓存也清了": { ticket: keyOfTitle(criteria, "修复 A 项目登录 bug") }
  })[request]);
  const llm = (options) => {
    const last = options.messages.at(-1);
    const note = JSON.stringify(last);
    const match = note.match(/(trg_[0-9a-f-]+)：现在都什么进度/);
    if (match) return toolCall(`route-${match[1]}`, "ticket_route", { items: [{ triggerId: match[1], kind: "ignore" }] });
    return text("#1 进行中，#2 进行中。");
  };
  const h = await harness(t, { dir, jev, llm });

  // 1. 新任务：确认一行、无模型调用、输入框立即可用（turn 已结束）。
  assert.equal(await h.say("修复 A 项目登录 bug"), "→ 新任务 #1 修复 A 项目登录 bug");
  assert.equal(h.modelCalls.length, 0);
  await waitFor(() => h.calls.length === 1);
  assert.equal(h.calls[0].prompt, "修复 A 项目登录 bug", "用户原文不被改写");

  // 2. 不等结果发第二件事，两者并行。
  assert.equal(await h.say("看下 B 项目 CI 为什么挂了"), "→ 新任务 #2 看下 B 项目 CI 为什么挂了");
  await waitFor(() => h.calls.length === 2);
  await waitFor(() => h.stage(1) === "working/running" && h.stage(2) === "working/running");

  // 3. 省略句归属到第一个任务，送达运行中的 Worker。
  await waitFor(() => h.tasks.getTask(h.service.runner.activeRunOf(h.ticket(1).id)).status === "running");
  assert.equal(await h.say("登录那个再加个回归测试"), "→ #1 修复 A 项目登录 bug");
  await waitFor(() => h.calls[0].steered.length === 1);
  assert.deepEqual(h.calls[0].steered, ["登录那个再加个回归测试"]);
  assert.equal(h.modelCalls.length, 0, "已归属消息全程不经过 Router LLM");

  // 4. 问进度进 Router，不派发新任务。
  assert.equal(await h.say("现在都什么进度"), "#1 进行中，#2 进行中。");
  assert.equal(h.modelCalls.length, 2);
  assert.equal(h.calls.length, 2);
  const system = JSON.stringify(h.modelCalls[0].messages[0]);
  assert.match(system, /#1 修复 A 项目登录 bug｜进行中/, "看板快照进了 system prompt");
  assert.equal(h.service.undecided().length, 0, "ignore 之后不再待路由");

  // 5. 第二个任务请求审批：看板“需要我”为 1，批准后继续。
  const approval = h.calls[1].requestApproval({ runtime_request_id: "ap-ci", command: "rm -rf cache", reason: "清缓存" });
  await waitFor(() => h.service.board().needsMe === 1);
  assert.equal(h.stage(2), "person/approval");
  assert.deepEqual(h.service.detail(h.ticket(2).id).approvals.map((row) => row.command), ["rm -rf cache"]);
  h.service.decideApproval(h.ticket(2).id, "ap-ci", "approved");
  assert.equal((await approval).status, "approved");
  assert.equal(h.service.board().needsMe, 0);

  // 6. 第一个任务完成后报告回流到主会话；追问时带上下文继续。
  h.calls[0].finish({ text: "登录已修复并加了回归测试" });
  await waitFor(() => h.stage(1) === "person/review");
  await waitFor(() => h.assistantText().some((line) => line.includes("登录已修复")));
  await h.agent.whenIdle();
  const reports = h.agent.session.snapshotEvents().filter((event) => event.type === "user/message" && event.data.source.kind === "dsh-alpha" && event.data.source.role === "worker-report");
  assert.equal(reports.length, 1, "报告以自有来源落库，不冒充用户消息");
  assert.equal(h.modelCalls.length, 2, "短报告由程序转述，不调用模型");
  assert.equal(await h.say("#1 为什么要这样修"), "→ #1 修复 A 项目登录 bug");
  await waitFor(() => h.calls.length === 3);
  assert.equal(h.calls[2].session.runtime_session_id, "rt-1", "续接原 Worker 会话而不是从头开始");

  // 7. 归错的一句话用“改归属”纠正，时间线和 Decision 都更新。
  await waitFor(() => h.tasks.getTask(h.service.runner.activeRunOf(h.ticket(2).id)).status === "running");
  await waitFor(() => h.tasks.getTask(h.service.runner.activeRunOf(h.ticket(1).id)).status === "running");
  assert.equal(await h.say("CI 那个顺便把缓存也清了"), "→ #1 修复 A 项目登录 bug");
  const wrong = h.store.listTriggersOfTicket(h.ticket(1).id).find((row) => row.text.startsWith("CI 那个"));
  await waitFor(() => h.calls[2].steered.length === 1);
  await waitFor(() => h.store.listInputs({ ticketId: h.ticket(1).id, triggerId: wrong.id })[0].status === "delivered");
  const before = h.store.latestDecisionOfTrigger(wrong.id);
  const fixed = h.service.reattribute(wrong.id, { toTicketId: h.ticket(2).id });
  assert.equal(fixed.ticketId, h.ticket(2).id);
  assert.equal(h.store.getDecision(before.id).overriddenBy, fixed.id, "更正进入评测数据");
  assert.ok(!h.service.timeline(h.ticket(1).id).some((row) => row.triggerId === wrong.id));
  assert.ok(h.service.timeline(h.ticket(2).id).some((row) => row.triggerId === wrong.id));
  await waitFor(() => h.calls[1].steered.includes("CI 那个顺便把缓存也清了"));
  await waitFor(() => h.calls[2].steered.some((line) => line.startsWith("更正：")));

  // 8. 重启主控：两个任务的状态恢复，各自发起恢复 Run。
  await h.dispose();
  h.tasks.close();
  const after = await harness(t, { dir, jev, llm, calls: [] });
  await waitFor(() => after.calls.length === 2);
  assert.deepEqual(after.calls.map((call) => call.session.runtime_session_id).sort(), ["rt-1", "rt-2"]);
  assert.ok(after.calls.every((call) => /主控重启/.test(call.prompt)));
  assert.equal(after.stage(1), "working/running");
  assert.equal(after.stage(2), "working/running");
  assert.equal(after.assistantText().length, 0);
});

test("Jev 不可用时全部消息进 Router，ticket_route 建任务且幂等", async (t) => {
  let trigger = null;
  const llm = (options, count) => {
    const match = JSON.stringify(options.messages.at(-1)).match(/(trg_[0-9a-f-]+)：/);
    if (count === 1) {
      trigger = match[1];
      return toolCall("route-1", "ticket_route", {
        items: [
          { triggerId: trigger, kind: "accept", title: "修支付", note: "优先看回调", constraints: { agentId: "local-unknown:mock" } },
          { triggerId: trigger, kind: "accept", title: "修支付" }
        ]
      });
    }
    return text("已建 #1。");
  };
  const h = await harness(t, { llm });
  assert.equal(await h.say("修一下支付回调"), "已建 #1。");
  assert.equal(h.modelCalls.length, 2);
  const results = JSON.parse(JSON.stringify(h.agent.session.snapshotEvents().filter((event) => event.type === "tool/result").at(-1).data));
  assert.match(JSON.stringify(results), /不存在|未知/, "幻觉 Agent 被拒绝，不会把任务卡在等机器");
  assert.equal(h.store.listTickets().length, 1);
  await waitFor(() => h.calls.length === 1);
  assert.equal(h.calls[0].prompt, "修一下支付回调");
  assert.deepEqual(await h.service.route([{ triggerId: trigger, kind: "accept" }]).then((rows) => rows[0].duplicate), true);
  assert.equal(h.store.listTickets().length, 1);
});

test("alpha-router 工具面没有执行与审批能力", async (t) => {
  const h = await harness(t);
  const names = [...h.ctx.tools.list?.() || []].map((tool) => tool.name);
  for (const forbidden of ["dispatch_task", "wait_task", "agent_approve", "agent_cancel", "task_result", "task_status"]) {
    assert.ok(!names.includes(forbidden), forbidden);
  }
  await h.say("随便一句");
  const tools = h.modelCalls[0].tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, ["list_agents", "list_workspaces", "ticket_label", "ticket_list", "ticket_read", "ticket_route"]);
});

test("输入框选择是本条约束：新建任务、作为硬范围、发送后清空", async (t) => {
  const h = await harness(t);
  h.selections.set("session-main", { agentId: h.agentId, model: "mock-1" });
  const ack = await h.say("跑一下构建");
  assert.equal(ack, "→ 新任务 #1 跑一下构建");
  assert.equal(h.modelCalls.length, 0);
  assert.equal(h.selections.has("session-main"), false);
  await waitFor(() => h.calls.length === 1);
  assert.equal(h.ticket(1).binding.constraints.model, "mock-1");
});

test("报告在主会话离线时留在 outbox，主会话上线后补投", async (t) => {
  const h = await harness(t);
  await h.service.intake({ messageId: "m1", text: "#1 不存在", ui: { constraints: { agentId: h.agentId } } });
  await waitFor(() => h.calls.length === 1);
  h.calls[0].finish({ text: "x".repeat(1_000) });
  await waitFor(() => h.stage(1) === "person/review");
  assert.equal(h.service.outbox.pending(), 1, "还没有 agent 进入过 pre-step");
  await h.say("#1 看一下");
  await waitFor(() => h.service.outbox.pending() === 0);
  await h.agent.whenIdle();
  const relayed = h.assistantText().find((line) => line.includes("待验收"));
  assert.ok(relayed.length < 700, "长结果只转述开头，完整内容在任务详情");
  assert.match(relayed, /完整内容在任务详情/);
});

test("reportText 只在短结果时完整转述", () => {
  const ticket = { seq: 3, title: "修复" };
  assert.equal(reportText(ticket, { kind: "failed", text: "超时" }), "#3 修复：失败\n超时");
  assert.equal(reportText(ticket, { kind: "ready", text: "" }), "#3 修复：完成，待验收");
});

test("对话流：用户消息带归属标签，Router 回复和 Worker 汇报按时间进同一条流", async (t) => {
  const llm = () => text("这个我直接答你：一切正常。");
  const h = await harness(t, { llm });
  await h.service.intake({ messageId: "m1", text: "跑一下构建", ui: { constraints: { agentId: h.agentId } } });
  await waitFor(() => h.calls.length === 1);
  await h.say("随便聊聊");

  let feed = h.service.feed();
  assert.deepEqual(feed.items.map((item) => `${item.role}:${item.kind || ""}`), ["user:user_message", "router:ack", "user:user_message", "router:reply"]);
  const [first, ack, second, reply] = feed.items;
  assert.match(ack.text, /已建任务 #1「跑一下构建」/, "新任务有回音");
  assert.equal(ack.ticket.seq, 1);
  assert.equal(first.attribution.state, "routed");
  assert.equal(first.attribution.ticket.seq, 1);
  assert.equal(second.attribution.state, "pending", "Router 还没给出归属");
  assert.equal(reply.kind, "reply");
  assert.equal(reply.text, "这个我直接答你：一切正常。");

  h.calls[0].finish({ text: "构建通过" });
  await waitFor(() => h.service.feed().items.some((item) => item.role === "worker"));
  feed = h.service.feed();
  const report = feed.items.at(-1);
  assert.equal(report.role, "worker");
  assert.equal(report.kind, "ready");
  assert.equal(report.ticket.seq, 1);
  assert.match(report.text, /构建通过/);
  assert.equal(feed.needsMe, 0);

  // 转给已有任务也有回音，不是只有一个归属标签。
  await h.say("#1 再看一眼");
  const routers = h.service.feed().items.filter((item) => item.role === "router");
  assert.deepEqual(routers.map((item) => item.kind), ["ack", "reply", "ack"]);
  assert.match(routers.at(-1).text, /已转给 #1/);
});

test("对话流：重复汇报按幂等键去重，limit 取最近的若干条", async (t) => {
  const h = await harness(t);
  assert.equal(h.service.say({ role: "worker", kind: "ready", text: "甲", dedupeKey: "k1" }), true);
  assert.equal(h.service.say({ role: "worker", kind: "ready", text: "甲", dedupeKey: "k1" }), false);
  assert.equal(h.service.say({ role: "router", kind: "notice", text: "  " }), false);
  for (let index = 0; index < 5; index += 1) h.service.say({ role: "router", kind: "notice", text: `n${index}` });
  const items = h.service.feed({ limit: 3 }).items;
  assert.deepEqual(items.map((item) => item.text), ["n2", "n3", "n4"]);
});

test("对话流：Worker 汇报 trigger 不当作用户一侧的消息重复出现", async (t) => {
  const h = await harness(t);
  await h.service.intake({ messageId: "m1", text: "跑一下构建", ui: { constraints: { agentId: h.agentId } } });
  const ticket = h.ticket(1);
  const report = h.store.insertTrigger({
    id: "trg-report", source: "dsh-alpha", sourceEventId: "r1", kind: "worker_report", trust: "system",
    text: "内部汇报记录", payload: { classification: "ready" }, createdAt: Date.now()
  }).trigger;
  h.store.linkTrigger(ticket.id, report.id, "runner");
  assert.deepEqual(h.service.feed().items.map((item) => item.text), ["跑一下构建", "已建任务 #1「跑一下构建」，Worker 开始处理。有结果我告诉你。"]);
});

test("类型没有预设：Router 建任务时给类型，看板快照列出已有类型供沿用，人改过的不被覆盖", async (t) => {
  const h = await harness(t);
  assert.equal(h.service.boardSnapshot(), "当前没有进行中的任务。\n还没有任何类型");
  await h.service.route([{ triggerId: h.store.insertTrigger({ id: "trg-a", source: "web", sourceEventId: "a", kind: "user_message", trust: "user", actor: "owner", text: "整理周报", payload: {}, createdAt: Date.now() }).trigger.id, kind: "accept", title: "写周报", category: "周报  整理", constraints: { agentId: h.agentId } }]);
  const ticket = h.ticket(1);
  assert.equal(ticket.category, "周报 整理");
  assert.equal(ticket.categorySource, "router");
  assert.deepEqual(h.service.categories(), [{ name: "周报 整理", count: 1 }]);
  assert.match(h.service.boardSnapshot(), /类型：周报 整理/);
  assert.match(h.service.boardSnapshot(), /已有类型：周报 整理\(1\)/);
  assert.equal(h.service.board().categories[0].name, "周报 整理");

  h.service.label("#1", "日报");
  assert.equal(h.ticket(1).category, "日报", "Router 可以改自己打的标签");
  await h.service.update("#1", { category: "汇报" });
  assert.equal(h.ticket(1).categorySource, "user");
  assert.equal(h.service.label("#1", "别的"), "汇报", "人改过的类型不被 Router 覆盖");

  assert.deepEqual(h.service.renameCategory("汇报", "报告"), { moved: 1 });
  assert.equal(h.ticket(1).category, "报告");
  assert.equal(h.ticket(1).categorySource, "user");
  assert.throws(() => h.service.renameCategory("", "x"), /类型/);
});

test("引用：引用任务消息后紧接着发的消息直接归到该任务，只生效一次", async (t) => {
  const h = await harness(t);
  const trigger = h.store.insertTrigger({ id: "trg-q", source: "web", sourceEventId: "q", kind: "user_message", trust: "user", actor: "owner", text: "改支付", payload: {}, createdAt: Date.now() }).trigger;
  const [opened] = await h.service.route([{ triggerId: trigger.id, kind: "accept", title: "改支付", constraints: { agentId: h.agentId } }]);
  assert.equal(opened.ok, true);
  assert.deepEqual(h.service.setQuote("#1"), { ticketId: opened.ticketId });
  assert.equal(h.service.takeQuote(), opened.ticketId);
  assert.equal(h.service.takeQuote(), null, "只用一次");
  h.service.setQuote("#1");
  h.service.setQuote(null);
  assert.equal(h.service.takeQuote(), null, "可以取消引用");
  assert.throws(() => h.service.setQuote("#99"), /不存在/);

  h.service.setQuote("#1");
  const reply = await h.say("再补一句，别动测试");
  assert.ok(reply);
  const message = h.store.recentUserTriggers(1)[0];
  assert.equal(h.store.listLinksOfTrigger(message.id)[0]?.ticketId, opened.ticketId, "引用让这句话归到被引用的任务");
  assert.equal(h.store.latestDecisionOfTrigger(message.id)?.reason, "ui_ticket");
});
