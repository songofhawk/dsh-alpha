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
    sessionId: "session-alpha",
    agentId: "a:mock",
    machineId: "a",
    provider: "mock",
    prompt: "hello",
    projectPath: "/x",
    settings: { mode: "auto-review" }
  });
  assert.equal(task.status, "queued");
  assert.equal(task.sessionId, "session-alpha");
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

test("dispatchKey 按 session 持久化并可恢复同一任务", () => {
  const dir = tmpDir("task-store-");
  const store = createTaskStore({ dataDir: dir });
  const task = store.createTask({
    sessionId: "session-alpha",
    dispatchKey: "call-1",
    agentId: "a",
    provider: "mock",
    prompt: "p",
    projectPath: "/x",
    settings: {}
  });

  const reloaded = createTaskStore({ dataDir: dir });
  assert.equal(reloaded.findByDispatchKey("session-alpha", "call-1")?.id, task.id);
  assert.equal(reloaded.findByDispatchKey("session-other", "call-1"), null);
  cleanupDir(dir);
});

test("任务心跳时间持久化并可独立刷新", () => {
  const dir = tmpDir("task-store-");
  const store = createTaskStore({ dataDir: dir });
  const task = store.createTask({ agentId: "a", provider: "mock", prompt: "p", projectPath: "/x", settings: {} });
  store.touchHeartbeat(task.id, 12345);

  const reloaded = createTaskStore({ dataDir: dir });
  assert.equal(reloaded.getTask(task.id).lastHeartbeatAt, 12345);
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

test("损坏的任务存储显式报错，不静默清空历史", (t) => {
  const dir = tmpDir("task-store-corrupt-");
  t.after(() => cleanupDir(dir));
  fs.writeFileSync(path.join(dir, "tasks.json"), "{broken json");
  assert.throws(() => createTaskStore({ dataDir: dir }), /读取任务存储失败/);
  assert.equal(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"), "{broken json");
});

test("保存采用原子替换且不遗留临时文件", (t) => {
  const dir = tmpDir("task-store-atomic-");
  t.after(() => cleanupDir(dir));
  const store = createTaskStore({ dataDir: dir });
  store.createTask({ agentId: "a", provider: "mock", prompt: "p", projectPath: "/x", settings: {} });
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(store.file, "utf8")));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["tasks.json"]);
});

test("任务更新通过订阅事件即时通知，不需要轮询文件", (t) => {
  const store = makeStore(t);
  const task = store.createTask({ agentId: "a", provider: "mock", prompt: "p", projectPath: "/x", settings: {} });
  const states = [];
  const dispose = store.subscribe(task.id, (record) => states.push(record.status));
  store.setStatus(task.id, "running");
  store.setStatus(task.id, "completed");
  dispose();
  store.setStatus(task.id, "failed");
  assert.deepEqual(states, ["running", "completed"]);
});
