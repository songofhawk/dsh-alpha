const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createApprovalBroker, normalizeDecision } = require("../src/lib/approvals.js");
const { createTaskStore } = require("../src/lib/task-store.js");
const { tmpDir, cleanupDir } = require("./helpers.js");

function makeBroker(t, { timeout = 50 } = {}) {
  const dir = tmpDir("approvals-");
  t.after(() => cleanupDir(dir));
  const store = createTaskStore({ dataDir: dir });
  const task = store.createTask({ agentId: "a:mock", provider: "mock", prompt: "p", projectPath: "/x", settings: {} });
  const broker = createApprovalBroker({ store, defaultTimeoutMs: timeout });
  return { broker, store, task };
}

test("request → decide approved 解析为 {status:approved}", async (t) => {
  const { broker, store, task } = makeBroker(t);
  const promise = broker.request(task.id, { runtime_request_id: "r1", kind: "command_execution", command: "ls" });
  assert.equal(broker.isPending("r1"), true);
  assert.equal(broker.listPending().length, 1);
  broker.decide("r1", "approved");
  const result = await promise;
  assert.deepEqual(result, { status: "approved", decision: "approved" });
  assert.equal(broker.isPending("r1"), false);
  const events = store.getTask(task.id).events;
  assert.equal(events.filter((e) => e.type === "approval_request").length, 1);
  assert.equal(events.filter((e) => e.type === "approval_decision").length, 1);
});

test("decide rejected / cancel 传导", async (t) => {
  const { broker, task } = makeBroker(t);
  const p1 = broker.request(task.id, { runtime_request_id: "r-reject" });
  broker.decide("r-reject", "rejected");
  assert.deepEqual(await p1, { status: "rejected", decision: "rejected" });

  const p2 = broker.request(task.id, { runtime_request_id: "r-cancel" });
  broker.decide("r-cancel", "cancel");
  assert.deepEqual(await p2, { status: "cancelled", decision: "cancel" });
});

test("超时默认拒绝（故障 deny）", async (t) => {
  const { broker, store, task } = makeBroker(t, { timeout: 30 });
  const promise = broker.request(task.id, { runtime_request_id: "r-timeout" });
  await assert.rejects(promise, { statusCode: 403 });
  assert.equal(broker.isPending("r-timeout"), false);
  const decision = store.getTask(task.id).events.find((e) => e.type === "approval_decision");
  assert.ok(decision);
  assert.equal(decision.payload.decision, "rejected");
});

test("重复请求与未知决策抛错", async (t) => {
  const { broker, task } = makeBroker(t);
  broker.request(task.id, { runtime_request_id: "r1" });
  await assert.rejects(async () => broker.request(task.id, { runtime_request_id: "r1" }), { statusCode: 409 });
  assert.throws(() => broker.decide("nope", "approved"), { statusCode: 404 });
});

test("normalizeDecision 别名归一", () => {
  assert.equal(normalizeDecision("allow"), "approved");
  assert.equal(normalizeDecision("approve"), "approved");
  assert.equal(normalizeDecision("approved"), "approved");
  assert.equal(normalizeDecision("allow_once"), "approved");
  assert.equal(normalizeDecision("true"), "approved");
  assert.equal(normalizeDecision("reject"), "rejected");
  assert.equal(normalizeDecision("deny"), "rejected");
  assert.equal(normalizeDecision("false"), "rejected");
  assert.equal(normalizeDecision("cancel"), "cancel");
  assert.equal(normalizeDecision("cancelled"), "cancel");
});

test("normalizeDecision 未知值与空值故障关闭", () => {
  assert.equal(normalizeDecision("typo-approve"), "rejected");
  assert.equal(normalizeDecision(""), "rejected");
  assert.equal(normalizeDecision(null), "rejected");
});
