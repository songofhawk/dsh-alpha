import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadClientExports() {
  const source = fs.readFileSync(new URL("../src/client.js", import.meta.url), "utf8");
  let definition;
  const context = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    AbortController,
    setTimeout,
    clearTimeout,
    crypto
  };
  vm.runInNewContext(source, context);
  return definition.factory((name) => name === "react" ? {} : {});
}

const { createTaskPoller } = loadClientExports();

test("task poller 在一次 524 后退避重试并恢复数据", async () => {
  let calls = 0;
  const errors = [];
  let poller;
  const restored = new Promise((resolve) => {
    poller = createTaskPoller({
      call: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transport failure for /dsh-alpha/task/list: HTTP 524");
        return [{ taskId: "task-1", status: "running" }];
      },
      onData: resolve,
      onError: (error, meta) => errors.push({ error, meta }),
      intervalMs: 50,
      timeoutMs: 50,
      backoffMs: [1, 2, 5]
    });
    poller.pollNow();
  });

  assert.deepEqual(await restored, [{ taskId: "task-1", status: "running" }]);
  poller.stop();
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].meta.retryInMs, 1);
});

test("task poller 会中止悬挂请求并继续下一次轮询", async () => {
  let calls = 0;
  let poller;
  const restored = new Promise((resolve) => {
    poller = createTaskPoller({
      call: (signal) => {
        calls += 1;
        if (calls > 1) return Promise.resolve([{ taskId: "task-2", status: "completed" }]);
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
      onData: resolve,
      onError() {},
      intervalMs: 50,
      timeoutMs: 5,
      backoffMs: [1]
    });
    poller.pollNow();
  });

  assert.deepEqual(await restored, [{ taskId: "task-2", status: "completed" }]);
  poller.stop();
  assert.equal(calls, 2);
});

test("task poller 查询失败时不会清空上一次成功数据", async () => {
  let calls = 0;
  let visible = [];
  let poller;
  const failedAfterData = new Promise((resolve) => {
    poller = createTaskPoller({
      call: async () => {
        calls += 1;
        if (calls === 1) return [{ taskId: "task-3", status: "running" }];
        throw new Error("HTTP 524");
      },
      onData: (tasks) => { visible = tasks; },
      onError: resolve,
      intervalMs: 1,
      timeoutMs: 50,
      backoffMs: [50]
    });
    poller.pollNow();
  });

  await failedAfterData;
  poller.stop();
  assert.deepEqual(visible, [{ taskId: "task-3", status: "running" }]);
});
