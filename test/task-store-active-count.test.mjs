import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countActiveTasks, readActiveTaskCount } from "../scripts/task-store-active-count.mjs";

test("部署排空检查只计算非终态任务", () => {
  assert.equal(countActiveTasks({
    queued: { status: "queued" },
    running: { status: "running" },
    blocked: { status: "blocked" },
    completed: { status: "completed" },
    failed: { status: "failed" },
    cancelled: { status: "cancelled" }
  }), 3);
});

test("部署排空检查拒绝损坏的任务存储结构", () => {
  assert.throws(() => countActiveTasks([]), /根节点必须是对象/);
});

test("部署排空检查优先读取 SQLite 状态列并兼容旧 JSON 参数", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-store-count-"));
  const file = path.join(dir, "tasks.sqlite3");
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO tasks(id, status) VALUES (?, ?)");
  for (const [id, status] of [["q", "queued"], ["r", "running"], ["b", "blocked"], ["c", "completed"]]) {
    insert.run(id, status);
  }
  database.close();
  assert.equal(readActiveTaskCount(path.join(dir, "tasks.json")), 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SQLite 尚未迁移时排空检查回退读取同目录旧 JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-store-count-json-"));
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify({ running: { status: "running" } }));
  assert.equal(readActiveTaskCount(path.join(dir, "tasks.sqlite3")), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
