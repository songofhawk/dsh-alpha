// Outbox 测试：幂等写入、崩溃重放、指数退避重试。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTaskStore } = require("../src/lib/task-store.js");
const { createOutbox } = require("../src/lib/outbox.js");
const { tmpDir, cleanupDir } = require("./helpers.js");

function makeOutbox(t, { baseDelayMs = 100 } = {}) {
  const dir = tmpDir("outbox-");
  const store = createTaskStore({ dataDir: dir });
  let current = 1_000_000;
  const outbox = createOutbox({ database: store.database, now: () => current, baseDelayMs });
  t.after(() => {
    store.close();
    cleanupDir(dir);
  });
  return {
    outbox,
    database: store.database,
    tick: (ms) => { current += ms; return current; },
    now: () => current
  };
}

test("enqueue 幂等：同 dedupe_key 不重复落库、不重复投递", async (t) => {
  const { outbox, database } = makeOutbox(t);
  const first = outbox.enqueue({ kind: "report", dedupeKey: "run-1", payload: { text: "done" } });
  const second = outbox.enqueue({ kind: "report", dedupeKey: "run-1", payload: { text: "done" } });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM outbox").get().count, 1);

  const delivered = [];
  const summary = await outbox.drain((entry) => delivered.push(entry));
  assert.equal(summary.delivered, 1);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].payload, { text: "done" });

  // 成功后写 done_at，再次 drain 不再投递
  assert.ok(database.prepare("SELECT done_at FROM outbox WHERE id = ?").get(first.entry.id).done_at);
  const again = await outbox.drain((entry) => delivered.push(entry));
  assert.equal(again.delivered, 0);
  assert.equal(delivered.length, 1);
});

test("崩溃重放：enqueue 后重建实例，drain 从未完成记录恢复", async (t) => {
  const dir = tmpDir("outbox-replay-");
  t.after(() => cleanupDir(dir));
  const store = createTaskStore({ dataDir: dir });
  const outbox = createOutbox({ database: store.database, baseDelayMs: 100 });
  outbox.enqueue({ kind: "report", dedupeKey: "run-9", payload: { seq: 9 } });
  outbox.enqueue({ kind: "report", dedupeKey: "run-10", payload: { seq: 10 } });
  // 模拟崩溃：不 drain 直接关闭
  store.close();

  const revivedStore = createTaskStore({ dataDir: dir });
  const revived = createOutbox({ database: revivedStore.database, baseDelayMs: 100 });
  assert.equal(revived.pending(), 2);
  const delivered = [];
  const summary = await revived.drain((entry) => delivered.push(entry.payload.seq));
  assert.equal(summary.delivered, 2);
  assert.deepEqual(delivered.sort((a, b) => a - b), [9, 10]);
  assert.equal(revived.pending(), 0);
  revivedStore.close();
});

test("失败按指数退避重试，成功后写 done_at", async (t) => {
  const { outbox, database, tick, now } = makeOutbox(t, { baseDelayMs: 100 });
  const { entry } = outbox.enqueue({ kind: "report", dedupeKey: "run-2", payload: {} });
  const t0 = now();

  let fail = true;
  const deliver = () => { if (fail) throw new Error("投递失败"); };

  // 第 1 次失败：attempts=1，退避 100ms
  let summary = await outbox.drain(deliver);
  assert.equal(summary.failed, 1);
  let row = database.prepare("SELECT attempts, next_attempt_at, done_at FROM outbox WHERE id = ?").get(entry.id);
  assert.equal(row.attempts, 1);
  assert.equal(row.next_attempt_at, t0 + 100);
  assert.equal(row.done_at, null);

  // 未到重试时间：drain 不动它
  tick(50);
  summary = await outbox.drain(deliver);
  assert.deepEqual([summary.delivered, summary.failed], [0, 0]);

  // 第 2 次失败：attempts=2，退避 200ms
  tick(50);
  summary = await outbox.drain(deliver);
  assert.equal(summary.failed, 1);
  row = database.prepare("SELECT attempts, next_attempt_at FROM outbox WHERE id = ?").get(entry.id);
  assert.equal(row.attempts, 2);
  assert.equal(row.next_attempt_at, t0 + 100 + 200);

  // 第 3 次失败：attempts=3，退避 400ms
  tick(200);
  summary = await outbox.drain(deliver);
  assert.equal(summary.failed, 1);
  row = database.prepare("SELECT attempts, next_attempt_at FROM outbox WHERE id = ?").get(entry.id);
  assert.equal(row.attempts, 3);
  assert.equal(row.next_attempt_at, t0 + 100 + 200 + 400);

  // 恢复后投递成功
  fail = false;
  tick(400);
  summary = await outbox.drain(deliver);
  assert.equal(summary.delivered, 1);
  row = database.prepare("SELECT done_at FROM outbox WHERE id = ?").get(entry.id);
  assert.equal(row.done_at, now());
});

test("deliver 抛错不影响同批其它记录", async (t) => {
  const { outbox } = makeOutbox(t);
  outbox.enqueue({ kind: "a", dedupeKey: "k1", payload: {} });
  outbox.enqueue({ kind: "b", dedupeKey: "k2", payload: {} });
  const delivered = [];
  const summary = await outbox.drain((entry) => {
    if (entry.kind === "a") throw new Error("bad");
    delivered.push(entry.kind);
  });
  assert.equal(summary.delivered, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(delivered, ["b"]);
});
