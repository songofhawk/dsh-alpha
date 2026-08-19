const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTaskStore, createId } = require("../src/lib/task-store.js");
const { tmpDir, cleanupDir } = require("./helpers.js");

function makeStore(t) {
  const dir = tmpDir("task-store-");
  t.after(() => cleanupDir(dir));
  return createTaskStore({ dataDir: dir });
}

test("createTask 初始 queued，getTask 未知抛 404", (t) => {
  const store = makeStore(t);
  const task = store.createTask({
    agentId: "a:mock",
    machineId: "a",
    provider: "mock",
    prompt: "hello",
    projectPath: "/x",
    settings: { mode: "auto-review" }
  });
  assert.equal(task.status, "queued");
  assert.equal(store.getTask(task.id).id, task.id);
  assert.throws(() => store.getTask("nope"), { statusCode: 404 });
});

test("setStatus / appendEvent / setResult 持久化到 JSON", () => {
  const dir = tmpDir("task-store-");
  const store = createTaskStore({ dataDir: dir });
  const task = store.createTask({ agentId: "a", provider: "mock", prompt: "p", projectPath: "/x", settings: {} });
  store.appendEvent(task.id, { type: "delta", payload: { text: "hi" } });
  store.setStatus(task.id, "completed");
  store.setResult(task.id, { message: "done", usage: { in: 1 }, artifacts: ["a"] });

  const reloaded = createTaskStore({ dataDir: dir });
  const got = reloaded.getTask(task.id);
  assert.equal(got.status, "completed");
  assert.equal(got.result, "done");
  assert.equal(got.events.length, 1);
  assert.equal(got.usage.in, 1);
  assert.deepEqual(got.artifacts, ["a"]);
  cleanupDir(dir);
});

test("非法状态与状态集校验", (t) => {
  const store = makeStore(t);
  const task = store.createTask({ agentId: "a", provider: "mock", prompt: "p", projectPath: "/x", settings: {} });
  assert.throws(() => store.setStatus(task.id, "exploded"));
});

test("recoverInterrupted 把进行中任务收敛为 failed", () => {
  const dir = tmpDir("task-store-");
  const store = createTaskStore({ dataDir: dir });
  store.createTask({ agentId: "a", provider: "mock", prompt: "p", projectPath: "/x", settings: {} });
  store.update(Object.values(store.listTasks())[0].id, { status: "running" });
  const gone = createTaskStore({ dataDir: dir });
  gone.recoverInterrupted();
  assert.equal(Object.values(gone.listTasks())[0].status, "failed");
  assert.match(Object.values(gone.listTasks())[0].error, /重启/);
  cleanupDir(dir);
});

test("createId 带前缀且唯一", () => {
  assert.match(createId("task-"), /^task-/);
  assert.notEqual(createId(), createId());
});

test("fs 依赖检查：store 文件存在", (t) => {
  const store = makeStore(t);
  store.createTask({ agentId: "a", provider: "mock", prompt: "p", projectPath: "/x", settings: {} });
  assert.equal(fs.existsSync(store.file), true);
  assert.equal(fs.existsSync(path.dirname(store.file)), true);
});