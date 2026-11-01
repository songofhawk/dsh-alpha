// WP2：steer 经真实反向 WS 打通 hub → worker，断线时明确失败以便降级排队；
// session_resume / steer 能力随 hello 上报，runtime_session_id 透传到 Worker。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCatalog } = require("../src/lib/catalog");
const { createGatewayHub } = require("../src/lib/gateway-hub");
const { runGatewayWorker } = require("../src/lib/gateway-worker");
const { buildCapabilitiesFor } = require("../src/lib/adapters");
const { waitFor, tmpDir, cleanupDir } = require("./helpers");

const quiet = { log() {}, warn() {}, error() {}, info() {} };

async function cluster(t, { steerTurn } = {}) {
  const dir = tmpDir("alpha-steer-");
  const catalog = createCatalog({ allowedRoots: [dir] });
  const hub = createGatewayHub({ catalog, tokens: { w1: "secret" }, port: 0, log: quiet });
  await hub.start();
  const runs = [];
  const steered = [];
  const adapter = {
    async *runTurn(context) {
      const run = { context };
      run.done = new Promise((resolve) => { run.finish = resolve; });
      runs.push(run);
      await run.done;
      yield { type: "complete", payload: { message: "ok" } };
    },
    async cancelTurn() { runs.at(-1)?.finish(); return {}; },
    ...(steerTurn === false ? {} : { steerTurn: async (context) => { steered.push(context); return { accepted: true }; } })
  };
  const worker = runGatewayWorker({
    hubUrl: `ws://127.0.0.1:${hub.address().port}/`, gatewayToken: "secret", machineId: "w1",
    providers: ["mock"], allowedRoots: [dir], discoverWorkspaces: false, heartbeatIntervalMs: 50,
    log: quiet, adapterFor: () => adapter
  });
  const loop = worker.loop();
  t.after(async () => {
    for (const run of runs) run.finish();
    worker.stop();
    await loop;
    await hub.close();
    cleanupDir(dir);
  });
  await waitFor(() => catalog.listAgents().some((agent) => agent.agentId === "w1:mock"));
  return { dir, catalog, hub, worker, runs, steered };
}

async function startRun(env, session) {
  const stream = env.hub.run({ machineId: "w1", context: { session, project: { path: env.dir }, message: "任务", settings: {} } });
  (async () => { for await (const event of stream) void event; })().catch(() => {});
  await waitFor(() => env.runs.length === 1);
}

test("Worker 上报 session_resume / steer 能力", async (t) => {
  const env = await cluster(t);
  const { capabilities } = env.catalog.getAgent("w1:mock");
  assert.equal(capabilities.session_resume, true);
  assert.equal(capabilities.steer, true);
  assert.equal(buildCapabilitiesFor("dsh").session_resume, undefined, "dsh 不支持 resume");
  assert.equal(buildCapabilitiesFor("claude-code").session_resume, true);
  assert.equal(buildCapabilitiesFor("claude-code").steer, undefined);
  assert.equal(buildCapabilitiesFor("codex").steer, true);
});

test("steer 经 hub 送达运行中的 turn，runtime_session_id 透传", async (t) => {
  const env = await cluster(t);
  await startRun(env, { id: "task-1", provider: "mock", runtime_session_id: "thread-9" });
  assert.equal(env.runs[0].context.session.runtime_session_id, "thread-9");
  const result = await env.hub.steerTurn({ machineId: "w1", context: { session: { id: "task-1", provider: "mock" }, message: "补充", attachments: [] } });
  assert.equal(result.ok, true);
  assert.equal(env.steered[0].message, "补充");
});

test("没有运行中的 turn 或 runtime 不支持时 steer 明确失败", async (t) => {
  const env = await cluster(t, { steerTurn: false });
  await assert.rejects(
    env.hub.steerTurn({ machineId: "w1", context: { session: { id: "ghost" }, message: "x" } }),
    /没有运行中的 turn/
  );
  await startRun(env, { id: "task-2", provider: "mock" });
  await assert.rejects(
    env.hub.steerTurn({ machineId: "w1", context: { session: { id: "task-2" }, message: "x" } }),
    /不支持追加输入/
  );
});

test("断线时 steer 抛错，调用方据此降级为排队", async (t) => {
  const env = await cluster(t);
  await assert.rejects(env.hub.steerTurn({ machineId: "no-such", context: {} }), /不可达/);
});
