// 阶段 4 选项 2：lib/gateway-provider.js —— gateway 反向注册为 SubagentProvider。
// fake catalog/engine/store 验证：远端 auto-pick、prompt 契约、终态映射、
// 取消/中止传导、parent.cwd 透传策略。不启动真实 hub/worker。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createGatewaySubagentProvider, promptText } = require("../src/lib/gateway-provider.js");
const { tmpDir, cleanupDir } = require("./helpers.js");

function row(agentId, machineId, { online = true } = {}) {
  return { agentId, machineId, provider: agentId.split(":")[1], available: true, machine: { online } };
}

function makeEnv({ rows = [row("r1:codex", "r1")], statuses = ["completed"], result = "远端结果", error = null, allowedRoots = [] } = {}) {
  const dispatched = [];
  const cancelled = [];
  let cursor = 0;
  const store = {
    // 每次轮询推进一格，模拟 running → 终态
    getTask(taskId) {
      const status = statuses[Math.min(cursor, statuses.length - 1)];
      cursor += 1;
      const record = { id: taskId, status };
      if (status === "completed" || status === "cancelled") record.result = result;
      if (status === "failed") record.error = error || "远端执行失败";
      return record;
    }
  };
  const engine = {
    dispatch(options) {
      dispatched.push(options);
      return { taskId: "task-gw-1", agentId: options.agentId, status: "running" };
    },
    cancelTask(taskId) {
      cancelled.push(taskId);
      statuses.length = 0;
      statuses.push("cancelled");
      cursor = 0;
      return Promise.resolve({ taskId, status: "cancelled" });
    }
  };
  const catalog = { machineId: "master", rankAgents: () => rows };
  const provider = createGatewaySubagentProvider({ catalog, engine, store, allowedRoots, pollIntervalMs: 5 });
  return { provider, dispatched, cancelled };
}

function makeRequest({ text = "干活", cwd, signal = new AbortController().signal } = {}) {
  return {
    label: "t",
    prompt: [{ type: "text", text }],
    parent: { session: { id: "parent-1", header: cwd ? { cwd } : {} } },
    signal
  };
}

test("provider 表面契约：名字/能力广告/不继承 parent 上下文", () => {
  const { provider } = makeEnv();
  assert.equal(provider.name, "alpha-gateway");
  assert.deepEqual(provider.capabilities, {
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false
  });
  assert.equal(provider.inheritsParentContext, false);
});

test("auto-pick：跳过本机与心跳超时机器，落第一台在线远端 agent", async () => {
  const { provider, dispatched } = makeEnv({
    rows: [
      row("master:codex", "master"), // 本机：官方 provider 负责，不走此通道
      row("r0:kimi-code", "r0", { online: false }), // 心跳超时
      row("r1:codex", "r1")
    ],
    statuses: ["completed"]
  });
  const run = await provider.start(makeRequest());
  await run.result;
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].agentId, "r1:codex");
});

test("completed → SubagentResult completed，output 为任务结果文本", async () => {
  const { provider } = makeEnv({ statuses: ["running", "completed"], result: "hello from r1" });
  const run = await provider.start(makeRequest());
  assert.equal(run.localAgent, undefined, "远端 run 无本进程 agent");
  assert.ok(typeof run.id === "string" && run.id.length > 0, "run id 由 provider 自发");
  const result = await run.result;
  assert.equal(result.stopReason, "completed");
  assert.deepEqual(result.output, [{ type: "text", text: "hello from r1" }]);
});

test("failed → stopReason error，任务 error 进 diagnostic", async () => {
  const { provider } = makeEnv({ statuses: ["failed"], error: "远端 runtime 炸了" });
  const run = await provider.start(makeRequest());
  const result = await run.result;
  assert.equal(result.stopReason, "error");
  assert.match(result.diagnostic, /远端 runtime 炸了/);
});

test("cancelled 终态 → stopReason aborted", async () => {
  const { provider } = makeEnv({ statuses: ["cancelled"] });
  const run = await provider.start(makeRequest());
  const result = await run.result;
  assert.equal(result.stopReason, "aborted");
});

test("无在线远端 agent → 发布前拒绝（503），不触碰引擎", async () => {
  const { provider, dispatched } = makeEnv({ rows: [row("master:codex", "master")] });
  await assert.rejects(provider.start(makeRequest()), (error) => {
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /没有在线的远端 agent/);
    return true;
  });
  assert.equal(dispatched.length, 0);
});

test("prompt 原样转发 engine.dispatch", async () => {
  const { provider, dispatched } = makeEnv({ statuses: ["completed"] });
  await (await provider.start(makeRequest({ text: "写一句 hello" }))).result;
  assert.equal(dispatched[0].prompt, "写一句 hello");
});

test("parent cwd 在 allowedRoots 内 → 透传 projectPath；越界 → 不透传", async (t) => {
  const root = tmpDir("gw-roots-");
  const outside = tmpDir("gw-outside-");
  t.after(() => cleanupDir(root));
  t.after(() => cleanupDir(outside));

  const env = makeEnv({ statuses: ["completed"], allowedRoots: [root] });
  await (await env.provider.start(makeRequest({ cwd: root }))).result;
  assert.equal(env.dispatched[0].projectPath, root, "界内 cwd 应作为 projectPath 透传");

  await (await env.provider.start(makeRequest({ cwd: outside }))).result;
  assert.ok(!("projectPath" in env.dispatched[1]), "越界 cwd 不透传，交给引擎默认根");
});

test("发布前已 abort → 拒绝 start，不派发", async () => {
  const { provider, dispatched } = makeEnv();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.start(makeRequest({ signal: controller.signal })), /派发前请求已被取消/);
  assert.equal(dispatched.length, 0);
});

test("运行中 abort → engine.cancelTask 传导，结果以 aborted 收敛", async () => {
  const { provider, cancelled } = makeEnv({ statuses: ["running"] }); // 一直 running 直到取消
  const controller = new AbortController();
  const run = await provider.start(makeRequest({ signal: controller.signal }));
  controller.abort();
  const result = await run.result;
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(cancelled, ["task-gw-1"]);
});

test("dispose 未结算 → 取消并等待终态；dispose 幂等", async () => {
  const { provider, cancelled } = makeEnv({ statuses: ["running"] });
  const run = await provider.start(makeRequest());
  const disposal = run.dispose();
  const disposalAgain = run.dispose();
  assert.equal(disposal, disposalAgain, "dispose 应幂等");
  await disposal;
  assert.deepEqual(cancelled, ["task-gw-1"]);
  const result = await run.result; // 结算后 result 仍可安全 await
  assert.equal(result.stopReason, "aborted");
});

test("promptText：只接受非空 text 块", () => {
  assert.equal(promptText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.throws(() => promptText([]), /至少一个 text 块/);
  assert.throws(() => promptText([{ type: "tool_use" }]), /只接受 text 块/);
  assert.throws(() => promptText([{ type: "text", text: "   " }]), /不能为空/);
});
