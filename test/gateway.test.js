// 阶段 1 验收：gateway 跨机通道 —— 反向 WS + 心跳 + 目录注册 + run 流回传。
// 全程真实 TCP loopback：master（catalog+engine+hub） ←   worker 连出 → 本机 mock runtime。
// 清理统一走 t.after：断言失败也必须关句柄，否则 node --test 会悬挂。

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createCatalog, defaultAllowedRoots } = require("../src/lib/catalog");
const { createTaskStore } = require("../src/lib/task-store");
const { createApprovalBroker } = require("../src/lib/approvals");
const { createTaskEngine } = require("../src/lib/task-engine");
const { createGatewayHub } = require("../src/lib/gateway-hub");
const { runGatewayWorker } = require("../src/lib/gateway-worker");
const { connectWebSocket } = require("../src/adapters/vendor/shared/websocket");

const quiet = { log() {}, warn() {}, error() {}, info() {}, ok() {} };

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body: JSON.parse(body) }));
    }).on("error", reject);
  });
}

const waitFor = async (fn, { timeoutMs = 5000, intervalMs = 25 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor 超时：未等到条件（${timeoutMs}ms）`);
};

// 启动单个 worker（loop 后台跑），登记 t.after 清理；hub 由 startCluster 统一清理
function startWorker(t, hub, { machineId, token, providers = ["mock"], repos = [], ensureRepo = null, probeProvider = undefined, allowedRoots = null }) {
  const worker = runGatewayWorker({
    hubUrl: `ws://127.0.0.1:${hub.address().port}/`,
    gatewayToken: token,
    machineId,
    providers,
    allowedRoots,
    repos,
    discoverWorkspaces: false,
    ensureRepo,
    probeProvider,
    heartbeatIntervalMs: 50,
    log: quiet
  });
  const loop = worker.loop();
  t.after(async () => {
    worker.stop();
    try {
      await loop;
    } catch {
      /* 停止路径异常可忽略 */
    }
  });
  return worker;
}

// 启动 hub + worker（worker loop 已后台跑），返回清理句柄
async function startCluster(t, { tokens = { remote1: "secret-1" }, providers = ["mock"], repos = [], ensureRepo = null, probeProvider = undefined, allowedRoots = null } = {}) {
  const catalog = createCatalog({
    allowedRoots: defaultAllowedRoots(),
    adapterProvider: { capabilitiesFor: () => ({}), probeAvailability: () => ({ available: true, reason: null }) }
  });
  const hub = createGatewayHub({ catalog, tokens, port: 0, log: quiet });
  const { port } = await hub.start();

  const worker = startWorker(t, hub, {
    machineId: "remote1",
    token: tokens.remote1,
    providers,
    repos,
    ensureRepo,
    probeProvider,
    allowedRoots
  });

  t.after(async () => {
    await hub.close();
  });

  return { catalog, hub, worker, port };
}

// 主控侧 engine（事件回流 + 审批桥接的对象），返回 store/approvals/engine + 清理句柄
function startEngine({ catalog, hub }, { defaults = { mode: "auto-review", approval_policy: "never" } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-gw-engine-"));
  const store = createTaskStore({ dataDir });
  store.recoverInterrupted();
  const approvals = createApprovalBroker({ store, defaultTimeoutMs: 60_000 });
  const engine = createTaskEngine({
    catalog,
    store,
    approvals,
    allowedRoots: defaultAllowedRoots(),
    defaults,
    adapterFor: (agent) => {
      assert.equal(agent.machineId, "remote1");
      return {
        id: "gateway",
        kind: "gateway",
        async *runTurn(context) {
          yield* hub.run({ machineId: agent.machineId, context });
        },
        async cancelTurn(context) {
          return hub.cancelTurn({ machineId: agent.machineId, context });
        }
      };
    }
  });
  return {
    store,
    approvals,
    engine,
    cleanup() {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

describe("gateway hub", () => {
  test("hub 拒绝未认证连接（token 不匹配 → 403）", async (t) => {
    const { hub } = await startCluster(t);
    await assert.rejects(
      connectWebSocket(`ws://127.0.0.1:${hub.address().port}/?token=wrong`),
      /403|upgrade failed/
    );
  });

  test("worker hello → 目录注册远端 agent（机器身份=认证身份）", async (t) => {
    const { catalog } = await startCluster(t);
    await waitFor(() => catalog.listAgents().length > 0);
    const row = catalog.listAgents()[0];
    assert.equal(row.machineId, "remote1");
    assert.equal(row.provider, "mock");
    assert.equal(row.available, true);
    assert.ok(row.machine.allowedRoots.length > 0); // 默认广播受控根，clone/路径策略可执行
    assert.equal(catalog.machineFor("remote1").online, true);
  });

  test("Worker 目录浏览和新建目录严格受 allowed roots 限制", async (t) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-remote-directory-"));
    t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
    const { hub } = await startCluster(t, { allowedRoots: [workDir] });
    await waitFor(() => hub.connections().length === 1);

    const roots = await hub.listDirectories({ machineId: "remote1" });
    assert.equal(roots.entries[0].path, workDir);
    const created = await hub.createDirectory({ machineId: "remote1", parentPath: workDir, name: "remote-project" });
    assert.equal(created.path, path.join(workDir, "remote-project"));
    assert.equal(fs.statSync(created.path).isDirectory(), true);
    await assert.rejects(
      hub.listDirectories({ machineId: "remote1", path: path.dirname(workDir) }),
      /不在允许根目录内/
    );
  });

  test("healthz 只暴露健康状态与连接数量", async (t) => {
    const { hub } = await startCluster(t);
    await waitFor(() => hub.connections().length === 1);
    const result = await getJson(`http://127.0.0.1:${hub.address().port}/healthz`);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { status: "ok", connected_workers: 1 });
  });

  test("waitForConnections 在 worker 连入时就绪，无连接时按超时返回", async (t) => {
    const catalog = createCatalog({
      allowedRoots: defaultAllowedRoots(),
      adapterProvider: { capabilitiesFor: () => ({}), probeAvailability: () => ({ available: true, reason: null }) }
    });
    const hub = createGatewayHub({ catalog, tokens: { late: "late-token" }, port: 0, log: quiet });
    await hub.start();
    t.after(() => hub.close());

    const waiting = hub.waitForConnections({ timeoutMs: 1_000 });
    startWorker(t, hub, { machineId: "late", token: "late-token" });
    assert.deepEqual(await waiting, { ready: true, connectedWorkers: 1 });

    const emptyCatalog = createCatalog({
      allowedRoots: defaultAllowedRoots(),
      adapterProvider: { capabilitiesFor: () => ({}), probeAvailability: () => ({ available: true, reason: null }) }
    });
    const emptyHub = createGatewayHub({ catalog: emptyCatalog, tokens: { none: "none" }, port: 0, log: quiet });
    await emptyHub.start();
    t.after(() => emptyHub.close());
    assert.deepEqual(await emptyHub.waitForConnections({ timeoutMs: 10 }), { ready: false, connectedWorkers: 0 });
  });

  test("expectedConnections 等于 token 清单设备数", async (t) => {
    const catalog = createCatalog({
      allowedRoots: defaultAllowedRoots(),
      adapterProvider: { capabilitiesFor: () => ({}), probeAvailability: () => ({ available: true, reason: null }) }
    });
    const hub = createGatewayHub({ catalog, tokens: { one: "t1", two: "t2" }, port: 0, log: quiet });
    await hub.start();
    t.after(() => hub.close());
    assert.equal(hub.expectedConnections(), 2);
  });

  test("worker 只广播探测可用的 provider", async (t) => {
    const { catalog } = await startCluster(t, {
      providers: ["mock", "codex"],
      probeProvider: (provider) => provider === "mock"
        ? { available: true, reason: null }
        : { available: false, reason: "测试环境无 CLI" }
    });
    await waitFor(() => catalog.listAgents().length > 0);
    assert.deepEqual(catalog.listAgents().map((row) => row.provider), ["mock"]);
  });

  test("完整链路：主控 engine 派发到远端 agent → 事件流回传 → completed + 结果", async (t) => {
    const { catalog, hub } = await startCluster(t);
    const { store, engine, cleanup } = startEngine({ catalog, hub });
    try {
      await waitFor(() => catalog.listAgents().length > 0);
      const agentId = catalog.listAgents()[0].agentId; // remote1:mock
      const { taskId } = engine.dispatch({ agentId, prompt: "说一句 hello" });
      const task = await waitFor(() => {
        const current = store.getTask(taskId);
        return current.status === "completed" ? current : null;
      });
      assert.equal(task.status, "completed");
      assert.ok(String(task.result || "").length > 0, "应有结果文本");
      assert.equal(task.machineId, "remote1");
      assert.ok(task.events.length > 0);
      const terminal = task.events.find((e) => ["complete", "cancelled", "error"].includes(e.type));
      assert.equal(terminal?.type, "complete");
      await waitFor(() => catalog.machineFor("remote1").load.active_turns === 0);
    } finally {
      cleanup();
    }
  });

  test("审批桥接：远端 approval_request → 主控 broker 挂起 → decide approved → 远端恢复完成", async (t) => {
    const { catalog, hub } = await startCluster(t);
    const { store, approvals, engine, cleanup } = startEngine({ catalog, hub });
    try {
      await waitFor(() => catalog.listAgents().length > 0);
      const agentId = catalog.listAgents()[0].agentId;
      const { taskId } = engine.dispatch({
        agentId,
        prompt: "执行一个需要权限确认的操作",
        mode: "default",
        approvalPolicy: "on-request"
      });

      // 远端 runtime 的权限请求必须冒泡到主控 broker 挂起
      const approval = await waitFor(() => approvals.listPending()[0] || null);
      assert.equal(approval.kind, "command_execution");
      assert.equal(approval.decision, undefined); // 仍在挂起
      const blocked = await waitFor(() => {
        const current = store.getTask(taskId);
        return current.status === "blocked" ? current : null;
      });
      assert.equal(blocked.status, "blocked");

      // 主控 commit approve → decision 回传远端 → runtime 恢复 → 任务完成
      approvals.decide(approval.id, "approved");
      const task = await waitFor(() => {
        const current = store.getTask(taskId);
        return current.status === "completed" ? current : null;
      });
      assert.equal(task.status, "completed");
      const decisions = task.events.filter((e) => e.type === "approval_decision");
      assert.ok(decisions.length >= 1, "任务事件中应有 approval_decision");
      assert.equal(decisions.at(-1).payload.decision, "approved");
    } finally {
      cleanup();
    }
  });

  test("审批拒绝对远端生效：decide rejected → runtime 403 → 任务 failed", async (t) => {
    const { catalog, hub } = await startCluster(t);
    const { store, approvals, engine, cleanup } = startEngine({ catalog, hub });
    try {
      await waitFor(() => catalog.listAgents().length > 0);
      const agentId = catalog.listAgents()[0].agentId;
      const { taskId } = engine.dispatch({
        agentId,
        prompt: "执行一个需要权限确认的操作",
        mode: "default",
        approvalPolicy: "on-request"
      });
      const approval = await waitFor(() => approvals.listPending()[0] || null);
      approvals.decide(approval.id, "rejected");

      // runtime 看到 rejected → 抛 403 → 主控任务 failed
      const task = await waitFor(() => {
        const current = store.getTask(taskId);
        return current.status === "failed" ? current : null;
      });
      assert.match(task.error, /拒绝/);
      const decision = task.events.find((e) => e.type === "approval_decision");
      assert.equal(decision?.payload.decision, "rejected");
    } finally {
      cleanup();
    }
  });

  test("worker 断线 → 远端 agent 置不可用；hub.close 幂等", async (t) => {
    const { catalog, hub } = await startCluster(t);
    await waitFor(() => catalog.listAgents().length > 0);
    assert.equal(catalog.listAgents()[0].available, true);

    // 拆 hub：worker 侧的 close 事件应触发 markMachineOffline
    await hub.close();
    await waitFor(() => catalog.listAgents()[0].available === false, { timeoutMs: 2000 });
    assert.equal(catalog.listAgents()[0].unavailableReason, "gateway 连接断开");
    // 幂等：再次 close 不应抛错或悬挂
    await hub.close();
  });

  test("运行中的 worker 断线 → active run 收敛为 failed，不抛未捕获异常", async (t) => {
    const { catalog, hub, worker } = await startCluster(t);
    const { store, engine, cleanup } = startEngine({ catalog, hub });
    try {
      await waitFor(() => catalog.listAgents().length > 0);
      const agentId = catalog.listAgents()[0].agentId;
      const { taskId } = engine.dispatch({
        agentId,
        prompt: "执行一个需要权限确认的操作",
        mode: "default",
        approvalPolicy: "on-request"
      });
      await waitFor(() => store.getTask(taskId).status === "blocked");
      worker.stop();
      const failed = await waitFor(() => {
        const task = store.getTask(taskId);
        return task.status === "failed" ? task : null;
      });
      assert.match(failed.error, /连接断开|不再可用/);
    } finally {
      cleanup();
    }
  });

  test("阶段3 repo 广播 + repo 身份选机：auto-pick 首选持有目标 repo 的 worker", async (t) => {
    const tokens = { remote1: "s1", remote2: "s2" };
    const catalog = createCatalog({
      allowedRoots: defaultAllowedRoots(),
      adapterProvider: { capabilitiesFor: () => ({}), probeAvailability: () => ({ available: true, reason: null }) }
    });
    const hub = createGatewayHub({ catalog, tokens, port: 0, log: quiet });
    const { port } = await hub.start();
    t.after(async () => hub.close());

    startWorker(t, hub, {
      machineId: "remote1",
      token: tokens.remote1,
      repos: [{ repo_url: "git@github.com:acme/site.git", path: "/r1/acme-site" }],
      allowedRoots: ["/r1"]
    });
    startWorker(t, hub, { machineId: "remote2", token: tokens.remote2, repos: [] });
    await waitFor(() => catalog.listAgents().length === 2);

    const { store, engine, cleanup } = startEngine({ catalog, hub });
    try {
      // 不指定 agentId：auto-pick 应落在唯一持有目标 repo 的 remote1
      const { taskId } = engine.dispatch({
        prompt: "在 acme/site 上做点事",
        repoUrl: "https://github.com/acme/site.git"
      });
      const task = store.getTask(taskId);
      assert.equal(task.agentId, "remote1:mock", "应优先选持有目标 repo 的机器");
      assert.equal(task.projectPath, "/r1/acme-site");
      assert.equal(task.needsClone, false);
      await waitFor(() => store.getTask(taskId).status === "completed");
    } finally {
      cleanup();
    }
  });

  test("阶段3 按需 clone：worker 无目标 repo → ensureRepo 落地后照常运行", async (t) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-clone-"));
    const clonedPath = path.join(workDir, "acme-site");
    let cloned = null;
    const { catalog, hub } = await startCluster(t, {
      repos: [],
      allowedRoots: [workDir],
      ensureRepo: async (repoUrl, opts) => {
        assert.match(repoUrl, /acme/);
        cloned = { repoUrl, roots: opts && opts.roots };
        fs.mkdirSync(clonedPath, { recursive: true });
        return clonedPath;
      }
    });

    const { store, engine, cleanup } = startEngine({ catalog, hub });
    try {
      await waitFor(() => catalog.listAgents().length > 0);
      const agentId = catalog.listAgents()[0].agentId; // remote1:mock
      const { taskId } = engine.dispatch({
        agentId,
        prompt: "在克隆出的仓库里看看",
        repoUrl: "https://github.com/acme/site",
        allowClone: true
      });
      const task = await waitFor(() => {
        const current = store.getTask(taskId);
        if (current.status === "failed") throw new Error(current.error);
        return current.status === "completed" ? current : null;
      });
      assert.equal(task.status, "completed");
      assert.ok(cloned, "worker 应触发按需 clone");
      // runtime 拿到的 project.path 就是落地出的克隆目录（第一帧 activity 会带它）
      const activity = task.events.find((e) => e.type === "activity");
      assert.match(String(activity?.payload?.message || ""), /acme-site/);
    } finally {
      cleanup();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
