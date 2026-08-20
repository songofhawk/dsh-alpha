// 阶段 4 本地执行收敛：lib/subagent-adapters.js 单测。
// 用 fake seam（记录 start 调用、可编程返回 SubagentResult）验证
// 「引擎 adapter 契约 ↔ ctx.subagents one-shot run」的映射，不触碰真实子进程。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SEAM_PROVIDER_NAMES, createSubagentBackedAdapter, outputText } = require("../src/lib/subagent-adapters.js");
const { tmpDir, cleanupDir } = require("./helpers.js");

// fake seam：记录每次 start(name, request)；run.result 由测试编程注入
function makeSeam() {
  const calls = [];
  const subagents = {
    providers: new Map(),
    registerProvider(provider) {
      this.providers.set(provider.name, provider);
      return () => this.providers.delete(provider.name);
    },
    getProvider(name) {
      return this.providers.get(name);
    },
    list() {
      return [...this.providers.keys()];
    },
    start(name, request) {
      const call = { name, request, disposed: false };
      calls.push(call);
      call.run = {
        result: call.resultPromise || Promise.resolve(call.result || { output: [], stopReason: "completed" }),
        dispose: async () => {
          call.disposed = true;
        }
      };
      return Promise.resolve(call.run);
    }
  };
  return { subagents, calls };
}

function makeContext({ id = "t1", path = "/tmp/dsh-alpha-fake-project", message = "干活" } = {}) {
  return { session: { id, provider: "codex" }, project: { path }, message };
}

async function collectEvents(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

test("SEAM_PROVIDER_NAMES：三个产品 provider 与官方包一一对应", () => {
  assert.deepEqual(SEAM_PROVIDER_NAMES, {
    codex: "codex",
    "claude-code": "claude-code",
    "kimi-code": "kimi-code" // dsh-subagent-acp 实例，以 kimi-code 名注册
  });
});

test("outputText：只拼接 text 块，忽略其它块", () => {
  assert.equal(outputText([{ type: "text", text: "a" }, { type: "tool" }, { type: "text", text: "b" }]), "ab");
  assert.equal(outputText(undefined), "");
  assert.equal(outputText([]), "");
});

test("未知 provider（如 mock）→ 构造即抛 400", () => {
  const { subagents } = makeSeam();
  assert.throws(
    () => createSubagentBackedAdapter({ provider: "mock", subagents }),
    (error) => error.statusCode === 400 && /无对应官方 subagent provider/.test(error.message)
  );
});

test("completed → complete 事件：输出文本落 message、dispose 被调、active 清理", async () => {
  const { subagents, calls } = makeSeam();
  calls.result = undefined;
  const adapter = createSubagentBackedAdapter({ provider: "codex", subagents });
  subagents.start = (name, request) => {
    const call = { name, request, disposed: false };
    calls.push(call);
    call.run = {
      result: Promise.resolve({
        output: [{ type: "text", text: "结果A" }, { type: "text", text: "结果B" }],
        stopReason: "completed"
      }),
      dispose: async () => {
        call.disposed = true;
      }
    };
    return Promise.resolve(call.run);
  };

  const events = await collectEvents(adapter.runTurn(makeContext()));
  assert.deepEqual(events.map((e) => e.type), ["activity", "complete"]);
  assert.equal(events[1].payload.message, "结果A结果B");
  const call = calls.at(-1);
  assert.equal(call.disposed, true, "完成后必须 dispose（官方契约：quiescence）");
  // active 已清理：再取消不会 abort 任何东西
  await adapter.cancelTurn({ session: { id: "t1" } });
  assert.equal(call.request.signal.aborted, false);
});

test("start 入参契约：seamName / prompt 文本 / parent.cwd / label", async (t) => {
  const dir = tmpDir("seam-adapter-");
  t.after(() => cleanupDir(dir));
  const { subagents, calls } = makeSeam();
  const adapter = createSubagentBackedAdapter({ provider: "kimi-code", subagents });
  await collectEvents(adapter.runTurn(makeContext({ id: "task-42", path: dir, message: "写一句诗" })));

  assert.equal(calls.length, 1);
  const { name, request } = calls[0];
  assert.equal(name, "kimi-code", "kimi-code 按 SEAM_PROVIDER_NAMES 映射");
  assert.deepEqual(request.prompt, [{ type: "text", text: "写一句诗" }]);
  // 收敛面：官方 provider 只从 parent 读 session.header.cwd
  assert.equal(request.parent.session.header.cwd, dir, "任务 projectPath 注入为子进程 cwd");
  assert.equal(request.parent.session.id, "alpha-task-42");
  assert.equal(request.label, "alpha:task-42");
  assert.ok(request.signal instanceof AbortSignal);
});

test("无 project.path 时 cwd 回退 process.cwd()", async () => {
  const { subagents, calls } = makeSeam();
  const adapter = createSubagentBackedAdapter({ provider: "codex", subagents });
  await collectEvents(adapter.runTurn({ session: { id: "t1" }, message: "x" }));
  assert.equal(calls[0].request.parent.session.header.cwd, process.cwd());
});

test("error stopReason → error 事件：stopReason 与 diagnostic 进 message", async () => {
  const { subagents } = makeSeam();
  subagents.start = () => Promise.resolve({
    result: Promise.resolve({
      output: [{ type: "text", text: "部分输出" }],
      stopReason: "error",
      diagnostic: "Product subagent failure (stage: turn)"
    }),
    dispose: async () => {}
  });
  const adapter = createSubagentBackedAdapter({ provider: "claude-code", subagents });
  const events = await collectEvents(adapter.runTurn(makeContext()));
  assert.deepEqual(events.map((e) => e.type), ["activity", "error"]);
  assert.match(events[1].payload.message, /error/);
  assert.match(events[1].payload.message, /Product subagent failure/);
  assert.match(events[1].payload.message, /部分输出/);
});

test("aborted stopReason → cancelled 事件", async () => {
  const { subagents } = makeSeam();
  subagents.start = () => Promise.resolve({
    result: Promise.resolve({ output: [], stopReason: "aborted" }),
    dispose: async () => {}
  });
  const adapter = createSubagentBackedAdapter({ provider: "codex", subagents });
  const events = await collectEvents(adapter.runTurn(makeContext()));
  assert.deepEqual(events.map((e) => e.type), ["activity", "cancelled"]);
  assert.equal(events[1].payload.message, "已取消");
});

test("start 拒绝 → 单个 error 事件（官方 provider 启动失败）", async () => {
  const { subagents } = makeSeam();
  subagents.start = () => Promise.reject(new Error("no working directory"));
  const adapter = createSubagentBackedAdapter({ provider: "codex", subagents });
  const events = await collectEvents(adapter.runTurn(makeContext()));
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  assert.match(events[0].payload.message, /官方 provider 启动失败：no working directory/);
});

test("run.result 拒绝（缝级基础设施故障）→ error 事件且 dispose", async () => {
  const { subagents } = makeSeam();
  let disposed = false;
  subagents.start = () => Promise.resolve({
    result: Promise.reject(new Error("seam infra fault")),
    dispose: async () => {
      disposed = true;
    }
  });
  const adapter = createSubagentBackedAdapter({ provider: "codex", subagents });
  const events = await collectEvents(adapter.runTurn(makeContext()));
  assert.deepEqual(events.map((e) => e.type), ["activity", "error"]);
  assert.match(events[1].payload.message, /seam infra fault/);
  assert.equal(disposed, true);
});

test("cancelTurn(session) → abort 传递到 seam signal，任务以 cancelled 收尾", async () => {
  const { subagents, calls } = makeSeam();
  // run.result 挂起，直到 signal abort 才以 aborted 结算（模拟真实 provider 行为）
  subagents.start = (name, request) => {
    const call = { name, request, disposed: false };
    calls.push(call);
    call.run = {
      result: new Promise((resolve) => {
        request.signal.addEventListener("abort", () => {
          resolve({ output: [{ type: "text", text: "中途输出" }], stopReason: "aborted" });
        }, { once: true });
      }),
      dispose: async () => {
        call.disposed = true;
      }
    };
    return Promise.resolve(call.run);
  };
  const adapter = createSubagentBackedAdapter({ provider: "codex", subagents });
  const generator = adapter.runTurn(makeContext({ id: "long-task" }));
  const first = await generator.next();
  assert.equal(first.value.type, "activity");

  await adapter.cancelTurn({ session: { id: "long-task" } });
  assert.equal(calls[0].request.signal.aborted, true, "cancelTurn 必须 abort 传给 seam 的 signal");

  const rest = [];
  for await (const event of generator) rest.push(event);
  assert.deepEqual(rest.map((e) => e.type), ["cancelled"]);
  assert.equal(rest[0].payload.message, "中途输出");
  assert.equal(calls[0].disposed, true);
});

test("cancelTurn 只命中对应 session；无 session.id 时兜底中止全部", async () => {
  const { subagents, calls } = makeSeam();
  subagents.start = (name, request) => {
    const call = { name, request };
    calls.push(call);
    call.run = {
      result: new Promise((resolve) => {
        request.signal.addEventListener("abort", () => {
          resolve({ output: [], stopReason: "aborted" });
        }, { once: true });
      }),
      dispose: async () => {}
    };
    return Promise.resolve(call.run);
  };
  const adapter = createSubagentBackedAdapter({ provider: "codex", subagents });
  const genA = adapter.runTurn(makeContext({ id: "taskA" }));
  const genB = adapter.runTurn(makeContext({ id: "taskB" }));
  await genA.next();
  await genB.next();

  await adapter.cancelTurn({ session: { id: "taskA" } });
  assert.equal(calls[0].request.signal.aborted, true);
  assert.equal(calls[1].request.signal.aborted, false, "不应误伤其它任务");

  await adapter.cancelTurn({}); // 兜底：全部中止
  assert.equal(calls[1].request.signal.aborted, true);
  for (const gen of [genA, genB]) {
    for await (const _event of gen) { /* drain */ }
  }
});
