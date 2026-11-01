const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createTaskStore, runMigrations, SCHEMA_VERSION } = require("../src/lib/task-store.js");
const { tmpDir, cleanupDir } = require("./helpers.js");

function userVersionOf(database) {
  return Number(database.prepare("PRAGMA user_version").get().user_version);
}

test("迁移可重复执行：user_version 不变且不报错，新表齐全", () => {
  const dir = tmpDir("ticket-migrations-");
  const store = createTaskStore({ dataDir: dir });
  assert.equal(userVersionOf(store.database), SCHEMA_VERSION);

  // 直接再跑两遍迁移函数：幂等，版本号不动
  runMigrations(store.database);
  runMigrations(store.database);
  assert.equal(userVersionOf(store.database), SCHEMA_VERSION);

  // 重建 store（构造时又会跑一遍迁移）也不应报错或改变版本
  const again = createTaskStore({ dataDir: dir });
  assert.equal(userVersionOf(again.database), SCHEMA_VERSION);

  for (const table of ["tickets", "triggers", "ticket_triggers", "decisions", "ticket_inputs", "subscriptions", "outbox", "approvals"]) {
    assert.ok(
      again.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      `缺少新表：${table}`
    );
  }
  store.close();
  again.close();
  cleanupDir(dir);
});

test("无新表的老 tasks.sqlite3 迁移后数据保留", () => {
  const dir = tmpDir("ticket-migrations-legacy-");
  const file = path.join(dir, "tasks.sqlite3");

  // 手工造一个 WP1 之前的老库：只有 tasks / task_events，user_version 为 0
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      event_json TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  legacy.prepare("INSERT INTO tasks(id, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?)")
    .run("legacy-run", "completed", 1, 2, JSON.stringify({ id: "legacy-run", prompt: "历史任务", result: "done" }));
  legacy.prepare("INSERT INTO task_events(task_id, event_json, byte_size, created_at) VALUES (?, ?, ?, ?)")
    .run("legacy-run", JSON.stringify({ type: "activity", payload: {} }), 32, 2);
  assert.equal(userVersionOf(legacy), 0);
  legacy.close();

  const store = createTaskStore({ dataDir: dir });
  assert.equal(userVersionOf(store.database), SCHEMA_VERSION);
  const record = store.getTask("legacy-run");
  assert.equal(record.status, "completed");
  assert.equal(record.prompt, "历史任务");
  assert.equal(record.result, "done");
  assert.equal(record.events.length, 1);
  // record_json 新字段以缺省值补齐，旧数据无需回填
  assert.equal(record.ticketId, null);
  assert.deepEqual(record.inputIds, []);
  assert.equal(record.runtimeSessionId, null);
  assert.ok(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tickets'").get());
  store.close();
  cleanupDir(dir);
});

test("允许注入共享 DatabaseSync，且 close 不关闭注入的连接", () => {
  const dir = tmpDir("ticket-migrations-shared-");
  const file = path.join(dir, "tasks.sqlite3");
  const shared = new DatabaseSync(file);
  const store = createTaskStore({ dataDir: dir, database: shared });
  assert.equal(store.database, shared);
  store.createTask({ agentId: "a", provider: "mock", prompt: "p", projectPath: "/x", settings: {} });
  // 注入连接上能看到迁移后的新表与 tasks 写入，具备同事务前提
  assert.ok(shared.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outbox'").get());
  store.close();
  // 注入的连接由调用方负责，store.close 后仍可用
  assert.equal(shared.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
  shared.close();
  cleanupDir(dir);
});

test("共享连接上 Ticket 与 Run 可同事务写入（回滚同时生效）", () => {
  const dir = tmpDir("ticket-migrations-tx-");
  const store = createTaskStore({ dataDir: dir });
  const { createTicketStore } = require("../src/lib/ticket-store.js");
  const tickets = createTicketStore({ database: store.database });

  store.database.exec("BEGIN IMMEDIATE");
  const task = store.createTask({ agentId: "a", provider: "mock", prompt: "p", projectPath: "/x", settings: {} });
  tickets.insertTicket({
    id: "tkt_tx", seq: 1, status: "open", outcome: null, title: "t", summary: "",
    origin: "user", workspaceId: null, category: null, categorySource: null,
    binding: null, attention: null, mergedInto: null,
    createdAt: 1, updatedAt: 1, lastActivityAt: 1, endedAt: null
  });
  store.database.exec("ROLLBACK");

  // task-store 有内存快照，回滚结果以库内行为准：tasks 表与 tickets 表都没有落库
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id = ?").get(task.id).count, 0);
  assert.equal(tickets.getTicket("tkt_tx"), null);
  store.close();
  cleanupDir(dir);
});
