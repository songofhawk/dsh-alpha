import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAttribution, selectCandidates, ticketRefs, THRESHOLDS } from "../src/lib/attribution.mjs";
import ticketStoreModule from "../src/lib/ticket-store.js";
import ticketEngineModule from "../src/lib/ticket-engine.js";

const { createTicketStore } = ticketStoreModule;
const { createTicketEngine } = ticketEngineModule;

function env({ jev = null, router = null } = {}) {
  const database = new DatabaseSync(":memory:");
  const store = createTicketStore({ database });
  const tickets = createTicketEngine({ store });
  const attribution = createAttribution({ store, tickets, jev, router, workspaceName: (id) => id });
  let n = 0;
  const say = (text, patch = {}) => tickets.openTicket({ trigger: { source: "web", sourceEventId: `s${++n}`, text, ...patch }, title: text });
  const trigger = (text, patch = {}) => store.insertTrigger({
    id: `trg_${++n}`, source: "web", sourceEventId: `t${n}`, kind: "user_message", trust: "user", text, payload: {}, createdAt: 1_000 + n, ...patch
  }).trigger;
  return { store, tickets, attribution, say, trigger };
}

function answer(choice, { confidence = 0.9, probabilities } = {}) {
  return { type: "choice", choice, confidence, probabilities: probabilities || { [choice]: 0.95, other: 0.02 } };
}

test("ticketRefs 只认任务引用，不误认外部编号", () => {
  assert.deepEqual(ticketRefs("#12 再加个测试"), [12]);
  assert.deepEqual(ticketRefs("看下 #ticket/7"), [7]);
  assert.deepEqual(ticketRefs("修一下 issue #12"), []);
  assert.deepEqual(ticketRefs("PR #3 的 CI"), []);
  assert.deepEqual(ticketRefs("foo#12 和 C#9"), []);
  assert.deepEqual(ticketRefs("#3 和 #4 都看下"), [3, 4]);
});

test("T0：任务详情、回复、唯一 #引用 硬归属，不调模型", async () => {
  const calls = [];
  const h = env({ jev: { ask: async () => { calls.push(1); return {}; } } });
  const one = h.say("任务一");
  const two = h.say("任务二");
  const quoted = h.store.listTriggersOfTicket(two.id)[0];
  assert.equal((await h.attribution.attribute({ trigger: h.trigger("随便说"), ui: { ticketId: one.id } })).ticketId, one.id);
  assert.equal((await h.attribution.attribute({ trigger: h.trigger("回复"), ui: { replyTo: quoted.id } })).ticketId, two.id);
  const decision = await h.attribution.attribute({ trigger: h.trigger("#1 再加个测试") });
  assert.deepEqual([decision.tier, decision.action, decision.ticketId], [0, "attach", one.id]);
  assert.equal(calls.length, 0);
});

test("T0：#引用 多个或不存在时不硬归属", async () => {
  const h = env();
  h.say("任务一");
  h.say("任务二");
  assert.equal((await h.attribution.attribute({ trigger: h.trigger("#1 和 #2 都停") })).action, "router");
  assert.equal((await h.attribution.attribute({ trigger: h.trigger("#99 怎么样") })).action, "router");
});

test("T0：本条约束新建任务并作为硬范围", async () => {
  const h = env();
  h.say("已有任务");
  const decision = await h.attribution.attribute({
    trigger: h.trigger("跑一下构建"),
    ui: { constraints: { agentId: "m:codex", workspaceId: null, model: "gpt" } }
  });
  assert.equal(decision.action, "new");
  assert.deepEqual(decision.constraints, { agentId: "m:codex", model: "gpt" });
});

test("Jev 不可用时全部走 T2，并记录 Decision", async () => {
  const h = env();
  const trigger = h.trigger("随便一句");
  const decision = await h.attribution.attribute({ trigger });
  assert.deepEqual([decision.tier, decision.action, decision.reason], [2, "router", "jev_unavailable"]);
  const saved = h.store.latestDecisionOfTrigger(trigger.id);
  assert.deepEqual([saved.tier, saved.action], [2, "router"]);
});

test("Jev 超时或抛错绝不阻断对话", async () => {
  const empty = env({ jev: { ask: async () => null } });
  assert.equal((await empty.attribution.attribute({ trigger: empty.trigger("x") })).action, "router");
  const broken = env({ jev: { ask: async () => { throw new Error("boom"); } } });
  const decision = await broken.attribution.attribute({ trigger: broken.trigger("x") });
  assert.deepEqual([decision.action, decision.reason], ["router", "attribution_failed"]);
});

test("外部来源的内容不送 T1", async () => {
  let asked = 0;
  const h = env({ jev: { ask: async () => { asked += 1; return {}; } } });
  const decision = await h.attribution.attribute({ trigger: h.trigger("PR 评论", { trust: "external" }) });
  assert.deepEqual([decision.action, decision.reason, asked], ["router", "external", 0]);
});

test("T1 attach：满足三项阈值才归属，state 带最近消息及归属", async () => {
  let seen;
  const jev = {
    ask: async (request) => {
      seen = request;
      return {
        intent: answer("work"),
        ticket: answer("t0", { confidence: 0.9, probabilities: { t0: 0.9, t1: 0.05 } }),
        selfContained: { type: "noul", noul: 0.2 }
      };
    }
  };
  const h = env({ jev });
  const login = h.say("修复登录 bug");
  const decision = await h.attribution.attribute({ trigger: h.trigger("再加个回归测试") });
  assert.deepEqual([decision.tier, decision.action, decision.ticketId], [1, "attach", login.id]);
  assert.equal(seen.state.request, "再加个回归测试");
  assert.deepEqual(seen.state.recent, [{ text: "修复登录 bug", ticket: "修复登录 bug" }]);
  assert.equal(seen.questions.ticket.criteria.t0.title, "修复登录 bug");
  assert.equal(seen.questions.ticket.criteria.t0.stage, "idle");
  assert.ok(Math.abs(decision.margin - 0.85) < 1e-9);
});

test("T1 attach：置信度、概率或差距任一不足都交给 T2", async () => {
  const cases = [
    { confidence: THRESHOLDS.attach.confidence - 0.01, probabilities: { t0: 0.95, t1: 0.01 } },
    { confidence: 0.9, probabilities: { t0: THRESHOLDS.attach.probability - 0.01, t1: 0.05 } },
    { confidence: 0.9, probabilities: { t0: 0.85, t1: 0.65 } }
  ];
  for (const shape of cases) {
    const h = env({ jev: { ask: async () => ({ intent: answer("work"), ticket: answer("t0", shape), selfContained: { type: "noul", noul: 1 } }) } });
    h.say("候选");
    const decision = await h.attribution.attribute({ trigger: h.trigger("这个") });
    assert.deepEqual([decision.tier, decision.action, decision.reason], [2, "router", "attach_below_threshold"]);
  }
});

test("T1 new：要自足且能路由，否则交给 T2", async () => {
  const route = { agentId: "m:codex", workspaceId: "repo" };
  const router = { prepare: () => ({ questions: { target: {} }, decode: () => route }) };
  const ask = (noul) => async () => ({
    intent: answer("work"),
    ticket: answer("new"),
    selfContained: { type: "noul", noul }
  });
  const ok = env({ jev: { ask: ask(0.9) }, router });
  const decision = await ok.attribution.attribute({ trigger: ok.trigger("修复 A 项目登录 bug\n细节略") });
  assert.deepEqual([decision.action, decision.route, decision.title], ["new", route, "修复 A 项目登录 bug"]);

  const elliptical = env({ jev: { ask: ask(0.1) }, router });
  assert.equal((await elliptical.attribution.attribute({ trigger: elliptical.trigger("那个也改下") })).reason, "new_needs_context");

  const noRoute = env({ jev: { ask: ask(0.9) }, router: { prepare: () => null } });
  assert.equal((await noRoute.attribution.attribute({ trigger: noRoute.trigger("修 bug") })).reason, "new_no_route");
});

test("非 work 意图一律交给 T2：stop / status / chat / multiple", async () => {
  for (const [intent, ticket, reason] of [["stop", "t0", "intent_stop"], ["status", "unsure", "intent_status"], ["chat", "new", "intent_chat"], ["work", "multiple", "multiple"]]) {
    const h = env({ jev: { ask: async () => ({ intent: answer(intent), ticket: answer(ticket), selfContained: { type: "noul", noul: 1 } }) } });
    h.say("候选");
    const decision = await h.attribution.attribute({ trigger: h.trigger("现在怎样") });
    assert.deepEqual([decision.action, decision.reason], ["router", reason]);
  }
});

test("候选预筛：open 优先、排除叫停和已合并、14 天外的结束任务不进候选", () => {
  const now = 100 * 24 * 3600 * 1000;
  const day = 24 * 3600 * 1000;
  const row = (id, patch) => ({ id, status: "open", title: id, workspaceId: null, lastActivityAt: now - day, ...patch });
  const rows = selectCandidates({
    tickets: [
      row("recent-done", { status: "ended", outcome: "done", endedAt: now - day, lastActivityAt: now }),
      row("old-done", { status: "ended", outcome: "done", endedAt: now - 20 * day }),
      row("stopped", { status: "ended", outcome: "stopped", endedAt: now - day }),
      row("merged", { status: "ended", outcome: "merged", endedAt: now - day }),
      row("open-old", { lastActivityAt: now - 3 * day }),
      row("open-new", { lastActivityAt: now - day })
    ],
    contextOf: (ticket) => ticket,
    now
  });
  assert.deepEqual(rows.map(({ ticket }) => ticket.id), ["open-new", "open-old", "recent-done"]);
  const many = Array.from({ length: 40 }, (_, index) => row(`t${index}`, { lastActivityAt: now - index }));
  assert.equal(selectCandidates({ tickets: many, contextOf: (ticket) => ticket, now }).length, 30);
});
