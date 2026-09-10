import test from "node:test";
import assert from "node:assert/strict";
import { countActiveTasks } from "../scripts/task-store-active-count.mjs";

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
