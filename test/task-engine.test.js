const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createCatalog } = require("../src/lib/catalog.js");
const { createTaskStore } = require("../src/lib/task-store.js");
const { createApprovalBroker } = require("../src/lib/approvals.js");
const { createTaskEngine } = require("../src/lib/task-engine.js");
const { buildCapabilitiesFor, probeAvailability, ADAPTERS, createLocalAgentAdapter } = require("../src/lib/adapters.js");
const { createRecursiveAdapter } = require("../src/lib/recursive-adapter.js");
const { waitFor, tmpDir, cleanupDir } = require("./helpers.js");

function makeEnv(t, { providers = ["mock"], defaults = {}, available = {}, recursive = false, fakeProviders = false, adapterForOverride = null, workspaceService = null } = {}) {
  const dir = tmpDir("engine-");
  t.after(() => cleanupDir(dir));
  const catalog = createCatalog({
    allowedRoots: [dir],
    adapterProvider: { capabilitiesFor: buildCapabilitiesFor, probeAvailability }
  });
  for (const provider of providers) {
    catalog.registerAgent({ provider, checkAvailable: available[provider] !== false });
  }
  const store = createTaskStore({ dataDir: dir });
  const approvals = createApprovalBroker({ store });
  let engineRef = null;
  const engine = createTaskEngine({
    catalog,
    workspaces: workspaceService,
    store,
    approvals,
    allowedRoots: [dir],
    defaults,
    // recursive=true：dsh-master → 主控递归适配器；
    // fakeProviders=true：所有本机 agent 一律跑 mock runtime（避免真实 codex 连接悬挂）
    adapterFor: (agent) => {
      if (adapterForOverride) return adapterForOverride(agent);
      if (recursive && agent.provider === "dsh-master" && agent.machineId === catalog.machineId) {
        return createRecursiveAdapter({
          store,
          maxDepth: 3,
          dispatch: (options) => engineRef.dispatch(options)
        });
      }
      if (agent.machineId === catalog.machineId) {
        return createLocalAgentAdapter(fakeProviders ? "mock" : agent.provider);
      }
      return createLocalAgentAdapter("mock"); // 本 env 无远端通道，远端一律 mock 兜底
    }
  });
  engineRef = engine;
  if (recursive) catalog.registerAgent({ provider: "dsh-master", checkAvailable: false });
  return { catalog, store, approvals, engine, dir };
}

test("dispatch → mock 执行 → completed，事件回流、负载回落", async (t) => {
  const { catalog, store, engine } = makeEnv(t);
  const agentId = catalog.listAgents()[0].agentId;
  const { taskId } = engine.dispatch({ agentId, prompt: "完成 hello 任务" });

  await waitFor(() => store.getTask(taskId).status === "completed");
  const task = store.getTask(taskId);
  assert.equal(task.result, task.result.trim() ? task.result : "");
  assert.match(task.result, /接收任务：完成 hello 任务/);
  assert.equal(task.events[0].type, "activity");
  assert.ok(task.events.length >= 5);
  assert.equal(catalog.currentLoad(), 0);
  const status = engine.taskStatus(taskId);
  assert.equal(status.state, "completed");
  const result = engine.taskResult(taskId);
  assert.equal(result.taskId, taskId);
});

test("dispatch 保留图片附件并传给目标 Worker runtime", async (t) => {
  let received;
  const env = makeEnv(t, {
    adapterForOverride: () => ({
      async *runTurn(context) {
        received = context.attachments;
        yield { type: "complete", payload: { message: "图片已收到" } };
      },
      async cancelTurn() {}
    })
  });
  const { taskId } = env.engine.dispatch({
    prompt: "检查这张图",
    attachments: [{ path: "/worker/project/screenshot.png" }]
  });
  await waitFor(() => env.store.getTask(taskId).status === "completed");
  assert.deepEqual(received, [{ path: "/worker/project/screenshot.png" }]);
});

test("dispatchAndWait 由状态事件唤醒并直接返回受控 Agent 输出", async (t) => {
  const { engine } = makeEnv(t);
  const outcome = await engine.dispatchAndWait({ prompt: "直接返回结果" });
  assert.equal(outcome.status, "completed");
  assert.match(outcome.result, /直接返回结果/);
  assert.equal(typeof outcome.durationMs, "number");
});

test("waitTask 响应宿主 AbortSignal 时只解除等待，任务可用同一 taskId 续接", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = makeEnv(t, {
    adapterForOverride: () => ({
      async *runTurn() {
        yield { type: "activity", payload: { kind: "agent", message: "正在排查" } };
        await gate;
        yield { type: "complete", payload: { message: "恢复等待后完成" } };
      },
      async cancelTurn() {}
    })
  });
  const controller = new AbortController();
  const receipt = env.engine.dispatch({ sessionId: "session-alpha", prompt: "长任务" });
  const firstWait = env.engine.waitTask(receipt.taskId, { signal: controller.signal });
  await waitFor(() => env.store.getTask(receipt.taskId).status === "running");
  controller.abort();
  await assert.rejects(firstWait, { name: "AbortError" });
  assert.equal(env.store.getTask(receipt.taskId).status, "running");

  release();
  const outcome = await env.engine.waitTask(receipt.taskId);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.result, "恢复等待后完成");
});

test("停止长任务后，同一 Worker 可以立即接收下一个任务", async (t) => {
  let created = 0;
  const env = makeEnv(t, {
    adapterForOverride: () => {
      const runNumber = ++created;
      let cancelled = false;
      return {
        async *runTurn() {
          if (runNumber > 1) {
            yield { type: "complete", payload: { message: "第二个任务完成" } };
            return;
          }
          while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
          yield { type: "cancelled", payload: { message: "第一个任务已停止" } };
        },
        async cancelTurn() {
          cancelled = true;
        }
      };
    }
  });
  const first = env.engine.dispatch({ sessionId: "session-alpha", prompt: "第一个长任务" });
  await waitFor(() => env.store.getTask(first.taskId).status === "running");
  await env.engine.cancelTask(first.taskId);
  assert.equal((await env.engine.waitTask(first.taskId)).status, "cancelled");

  const second = await env.engine.dispatchAndWait({ sessionId: "session-alpha", prompt: "第二个任务" });
  assert.equal(second.status, "completed");
  assert.equal(second.result, "第二个任务完成");
});

test("taskFeed 只返回当前主控会话的可见过程与中间输出", async (t) => {
  const env = makeEnv(t, {
    adapterForOverride: () => ({
      async *runTurn() {
        yield { type: "activity", payload: { kind: "agent", message: "先检查" } };
        yield { type: "activity", payload: { kind: "agent", message: "配置" } };
        yield { type: "tool_use", payload: { tool_name: "read", tool_input: { path: "/tmp/a" }, tool_use_id: "tool-1" } };
        yield { type: "activity", payload: { kind: "tool_progress", message: "工具执行中", tool_use_id: "tool-1" } };
        yield { type: "activity", payload: { kind: "tool_progress", message: "工具执行中", tool_use_id: "tool-1" } };
        yield { type: "tool_result", payload: { tool_use_id: "tool-1", content: "", is_error: false } };
        yield { type: "delta", payload: { text: "中间结论" } };
        yield { type: "complete", payload: { message: "完成" } };
      },
      async cancelTurn() {}
    })
  });
  const own = await env.engine.dispatchAndWait({ sessionId: "session-alpha", prompt: "检查配置" });
  await env.engine.dispatchAndWait({ sessionId: "session-other", prompt: "其它会话" });

  const feed = env.engine.taskFeed("session-alpha");
  const stored = env.store.getTask(own.taskId);
  assert.equal(feed.length, 1);
  assert.equal(stored.events.filter((event) => event.payload?.kind === "tool_progress").length, 1);
  assert.equal(feed[0].taskId, own.taskId);
  assert.deepEqual(feed[0].events.map((event) => event.text), [
    "先检查配置",
    "调用工具：read\n{\"path\":\"/tmp/a\"}",
    "read 执行中",
    "read 执行完成",
    "中间结论",
    "完成"
  ]);
  assert.throws(() => env.engine.cancelSessionTask("session-other", own.taskId), { statusCode: 404 });
});

test("complete 只有通用占位时，dispatchAndWait 返回 runtime delta 原文", async (t) => {
  const env = makeEnv(t, {
    adapterForOverride: () => ({
      async *runTurn() {
        yield { type: "delta", payload: { text: "abc123 最新提交" } };
        yield { type: "complete", payload: { message: "Kimi Code 执行完成。" } };
      },
      async cancelTurn() {}
    })
  });
  const outcome = await env.engine.dispatchAndWait({ prompt: "读取 git log" });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.result, "abc123 最新提交");
});

test("dispatchAndWait 遇审批先返回 blocked，批准后继续等待最终输出", async (t) => {
  const env = makeEnv(t, { defaults: { mode: "default", approval_policy: "on-request" } });
  const blocked = await env.engine.dispatchAndWait({ prompt: "需要权限确认的敏感操作" });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.pendingApprovals.length, 1);
  const completed = await env.engine.decideApprovalAndWait(blocked.pendingApprovals[0].id, "approved");
  assert.equal(completed.status, "completed");
  assert.match(completed.result, /敏感操作/);
});

test("审批冒泡：blocked → approve → completed", async (t) => {
  const env = makeEnv(t, { defaults: { mode: "default", approval_policy: "on-request" } });
  const { store, engine } = env;
  const agentId = env.catalog.listAgents()[0].agentId;
  const { taskId } = engine.dispatch({ agentId, prompt: "需要权限确认的敏感操作" });

  await waitFor(() => store.getTask(taskId).status === "blocked");
  const pending = env.approvals.listPending();
  assert.equal(pending.length, 1);
  const approvalId = pending[0].id;
  assert.equal(env.approvals.isPending(approvalId), true);

  engine.decideApproval(approvalId, "approved");
  await waitFor(() => store.getTask(taskId).status === "completed");
  const decision = store.getTask(taskId).events.find((e) => e.type === "approval_decision");
  assert.equal(decision.payload.decision, "approved");
  assert.match(store.getTask(taskId).result, /敏感操作/);
});

test("审批拒绝 → 任务 failed", async (t) => {
  const env = makeEnv(t, { defaults: { mode: "default", approval_policy: "on-request" } });
  const { store, engine } = env;
  const agentId = env.catalog.listAgents()[0].agentId;
  const { taskId } = engine.dispatch({ agentId, prompt: "这条触发权限确认" });

  await waitFor(() => store.getTask(taskId).status === "blocked");
  const approvalId = env.approvals.listPending()[0].id;
  engine.decideApproval(approvalId, "rejected");
  await waitFor(() => store.getTask(taskId).status === "failed");
  assert.match(store.getTask(taskId).error, /拒绝/);
});

test("等待审批时停止任务会清空待决审批并立即取消", async (t) => {
  const env = makeEnv(t, { defaults: { mode: "default", approval_policy: "on-request" } });
  const { taskId } = env.engine.dispatch({ sessionId: "session-alpha", prompt: "需要权限确认的敏感操作" });
  await waitFor(() => env.store.getTask(taskId).status === "blocked");
  assert.equal(env.approvals.listPending().length, 1);

  const stopped = await env.engine.cancelSessionTask("session-alpha", taskId);
  assert.equal(stopped.status, "cancelled");
  assert.equal(env.store.getTask(taskId).status, "cancelled");
  assert.equal(env.approvals.listPending().length, 0);
});

test("取消：进行中任务 cancel → cancelled", async (t) => {
  class SlowRuntime {
    constructor() {
      this.cancel = false;
    }
    cancelTurn() {
      this.cancel = true;
      return Promise.resolve({});
    }
    async *run() {
      yield { type: "activity", payload: { kind: "status", message: "start" } };
      while (!this.cancel) {
        await new Promise((r) => setTimeout(r, 20));
      }
      yield { type: "cancelled", payload: { message: "cancelled-by-test" } };
    }
  }
  ADAPTERS["test-slow"] = {
    id: "test-slow",
    kind: "local-process",
    createRuntime: () => new SlowRuntime(),
    resolveExecutable: () => "test-slow"
  };
  const env = makeEnv(t, { providers: ["test-slow"], available: { "test-slow": false } });
  const { store, engine } = env;
  const agentId = env.catalog.listAgents()[0].agentId;
  const { taskId } = engine.dispatch({ agentId, prompt: "跑很久" });

  await waitFor(() => store.getTask(taskId).status === "running");
  engine.cancelTask(taskId);
  await waitFor(() => store.getTask(taskId).status === "cancelled");
  assert.equal(env.catalog.currentLoad(), 0);
});

test("projectPath 越界拒绝（allowed roots 校验）", (t) => {
  const env = makeEnv(t);
  const agentId = env.catalog.listAgents()[0].agentId;
  assert.throws(
    () => env.engine.dispatch({ agentId, prompt: "x", projectPath: "/etc" }),
    /允许根目录|allowed roots|越界|outside/i
  );
});

test("不可用 agent 拒派发（fail fast）", (t) => {
  const env = makeEnv(t, { providers: ["codex"] });
  const codex = env.catalog.listAgents().find((a) => a.provider === "codex");
  if (codex.available) {
    return; // 本机装了 codex：跳过 fail-fast 分支
  }
  assert.throws(() => env.engine.dispatch({ agentId: codex.agentId, prompt: "x" }), { statusCode: 503 });
});

test("认证错误触发 agent 熔断，后续派发立即拒绝直到重新注册", async (t) => {
  const env = makeEnv(t, {
    providers: ["mock"],
    adapterForOverride: () => ({
      async *runTurn() {
        throw new Error("Authentication required");
      },
      async cancelTurn() {}
    })
  });
  env.catalog.registerRemoteAgent({
    machineId: "auth-host",
    provider: "mock",
    capabilities: {},
    machine: { allowedRoots: ["/remote/work"], repos: [] }
  });
  const agentId = "auth-host:mock";
  const { taskId } = env.engine.dispatch({ agentId, prompt: "认证测试" });
  await waitFor(() => env.store.getTask(taskId).status === "failed");
  assert.equal(env.catalog.getAgent(agentId).available, false);
  assert.match(env.catalog.getAgent(agentId).unavailableReason, /认证不可用/);
  assert.throws(() => env.engine.dispatch({ agentId, prompt: "不要重试" }), { statusCode: 503 });
});

test("参数校验：缺 prompt / 未知 agent / 无可用 agent", (t) => {
  const env = makeEnv(t);
  assert.throws(() => env.engine.dispatch({ agentId: "a" }), /prompt/);
  assert.throws(() => env.engine.dispatch({ agentId: "nope:x", prompt: "x" }), { statusCode: 404 });
  // agentId 阶段 3 起可选（auto-pick），因此旧有的「缺 agentId」不再抛错
  assert.doesNotThrow(() => env.engine.dispatch({ prompt: "x" }));
});

test("task_status/task_result 基础契约", async (t) => {
  const env = makeEnv(t);
  const agentId = env.catalog.listAgents()[0].agentId;
  const { taskId } = env.engine.dispatch({ agentId, prompt: "y" });
  await waitFor(() => env.store.getTask(taskId).status === "completed");
  const status = env.engine.taskStatus(taskId);
  assert.equal(status.state, "completed");
  assert.equal(status.agentId, agentId);
  const result = env.engine.taskResult(taskId);
  assert.equal(typeof result.result, "string");
  assert.ok(Array.isArray(result.events));
  // 工具层要求：返回值必须可无损耗 JSON 往返（undefined 属性会破坏往返）
  for (const value of [status, result]) {
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value,
      "taskStatus/taskResult 返回值应可无损耗 JSON 往返");
  }
});

test("task_status/task_result 空字段不出显式 undefined（失败/进行中任务亦保持无损）", async (t) => {
  const env = makeEnv(t);
  const agentId = env.catalog.listAgents()[0].agentId;
  const { taskId } = env.engine.dispatch({ agentId, prompt: "y" });
  const pending = env.engine.taskStatus(taskId); // 完成前的快照，可能无 error
  assert.deepEqual(JSON.parse(JSON.stringify(pending)), pending, "pending 状态也应无损");
  const result = env.engine.taskResult(taskId); // 完成前的快照，可能无 result
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, "pending 结果也应无损");
  for (const key of ["result", "usage", "artifacts", "events", "error"]) {
    assert.ok(!(key in pending) || pending[key] !== undefined, `pending.${key} 不应为显式 undefined`);
    assert.ok(!(key in result) || result[key] !== undefined, `result.${key} 不应为显式 undefined`);
  }
});
// ---- 阶段 3：auto-pick / repo 身份 / 按需 clone 标记 / 主控递归 ----

test("阶段3 auto-pick：未指定 agentId 时自动落在最空闲 agent 上", async (t) => {
  // codex / claude-code 无 real 可执行文件，用 checkAvailable:false 显式信任可用；
  // fakeProviders=true 让它们也跑 mock runtime（避免真实 codex 连接悬挂）
  const env = makeEnv(t, {
    providers: ["mock", "codex", "claude-code"],
    available: { codex: false, "claude-code": false },
    fakeProviders: true
  });
  const { store, engine } = env;
  const mockId = env.catalog.listAgents().find((a) => a.provider === "mock").agentId;
  env.catalog.touchLoad(mockId, 3); // mock 最忙 → auto-pick 应避开它

  const { taskId } = engine.dispatch({ prompt: "自动选机测试" });
  const task = store.getTask(taskId);
  assert.notEqual(task.agentId, mockId, "auto-pick 应避开负载 3 的 mock");
  assert.ok(["codex", "claude-code"].includes(task.agentId.split(":")[1]), "应落在同负载的其它空闲 agent");
  await waitFor(() => store.getTask(taskId).status === "completed");
});

test("阶段3 repo 身份：远端机器持有 repo → 直接落到该机器并拿到本机路径", async (t) => {
  const env = makeEnv(t, { providers: ["mock"] });
  const { catalog, store, engine } = env;
  // 注册一个持有 /work/acme-site 的远端机器 agent（本机 local:mock 也有 repo 则本地路径优先，
  // 这里本机无 repo，走远端）
  catalog.registerRemoteAgent({
    machineId: "rm1",
    provider: "mock",
    capabilities: { default_model: "m", models: ["m"] },
    machine: { allowedRoots: ["/work"], repos: [{ repo_url: "git@github.com:acme/site.git", path: "/work/acme-site" }] }
  });
  catalog.heartbeatRemote({ machineId: "rm1", load: { active_turns: 0 }, repos: [{ repo_url: "git@github.com:acme/site.git", path: "/work/acme-site" }] });
  const remoteId = catalog.listAgents().find((a) => a.machineId === "rm1").agentId;

  const { taskId } = engine.dispatch({
    agentId: remoteId,
    prompt: "看看这个仓库",
    repoUrl: "https://github.com/acme/site"
  });
  const task = store.getTask(taskId);
  assert.equal(task.repoUrl, "github.com/acme/site"); // canonical
  assert.equal(task.repoCloneUrl, "https://github.com/acme/site");
  assert.equal(task.needsClone, false, "远端已持有 repo，无需按需 clone");
  assert.equal(task.projectPath, "/work/acme-site");
  await waitFor(() => store.getTask(taskId).status === "completed");
});

test("全局逻辑 workspace 把任务约束到持有该项目的机器路径", async (t) => {
  const logical = {
    workspaceId: "repo-ai-prd",
    name: "ai-prd",
    repoUrl: "github.com/acme/ai-prd",
    available: true,
    locations: [{ machineId: "workspace-host", path: "/workspace-host/ai-prd", online: true, providers: ["mock"] }]
  };
  const workspaceService = {
    resolve: ({ workspaceId }) => ({ workspace: workspaceId === logical.workspaceId ? logical : null, source: "explicit", ambiguous: [] })
  };
  const env = makeEnv(t, { providers: ["mock"], workspaceService });
  env.catalog.registerRemoteAgent({
    machineId: "workspace-host",
    provider: "mock",
    capabilities: {},
    machine: {
      allowedRoots: ["/workspace-host"],
      workspaces: [{ name: "ai-prd", repo_url: logical.repoUrl, path: "/workspace-host/ai-prd" }],
      repos: [{ repo_url: logical.repoUrl, path: "/workspace-host/ai-prd" }]
    }
  });
  const result = env.engine.dispatch({ workspaceId: logical.workspaceId, sessionId: "session-alpha", prompt: "修改登录" });
  const task = env.store.getTask(result.taskId);
  assert.equal(task.agentId, "workspace-host:mock");
  assert.equal(task.projectPath, "/workspace-host/ai-prd");
  assert.equal(task.workspaceId, logical.workspaceId);
  await waitFor(() => env.store.getTask(result.taskId).status === "completed");
});

test("单独选择工作机时，冲突的显式 agent 必须报错而非静默改派", async (t) => {
  const logical = {
    workspaceId: "repo-machine-choice",
    name: "machine-choice",
    repoUrl: "github.com/acme/machine-choice",
    available: true,
    locations: [
      { machineId: "machine-a", path: "/machine-a/repo", online: true, providers: ["mock"] },
      { machineId: "machine-b", path: "/machine-b/repo", online: true, providers: ["mock"] }
    ]
  };
  const workspaceService = {
    resolve: () => ({ workspace: logical, machineId: "machine-b", source: "session", ambiguous: [] })
  };
  const env = makeEnv(t, { providers: ["mock"], workspaceService });
  for (const machineId of ["machine-a", "machine-b"]) {
    env.catalog.registerRemoteAgent({
      machineId,
      provider: "mock",
      capabilities: {},
      machine: {
        allowedRoots: [`/${machineId}`],
        repos: [{ repo_url: logical.repoUrl, path: `/${machineId}/repo` }]
      }
    });
    env.catalog.heartbeatRemote({
      machineId,
      load: { active_turns: machineId === "machine-a" ? 0 : 3 },
      repos: [{ repo_url: logical.repoUrl, path: `/${machineId}/repo` }]
    });
  }

  const localAgentId = env.catalog.listAgents().find((agent) => agent.machineId === env.catalog.machineId).agentId;
  assert.throws(() => env.engine.dispatch({
    agentId: localAgentId,
    workspaceId: logical.workspaceId,
    sessionId: "session-machine",
    prompt: "只在所选机器执行"
  }), /不在已明确选择的机器或工作区范围内/);
  const result = env.engine.dispatch({ workspaceId: logical.workspaceId, sessionId: "session-machine", prompt: "只在所选机器执行" });
  const task = env.store.getTask(result.taskId);
  assert.equal(task.machineId, "machine-b");
  assert.equal(task.projectPath, "/machine-b/repo");
  await waitFor(() => env.store.getTask(result.taskId).status === "completed");
});

test("已选范围内的显式 provider 选择仍然生效", async (t) => {
  const logical = {
    workspaceId: "repo-provider-choice",
    name: "provider-choice",
    repoUrl: "github.com/acme/provider-choice",
    available: true,
    locations: [{ machineId: "provider-host", path: "/provider-host/repo", online: true, providers: ["codex"] }]
  };
  const workspaceService = {
    resolve: () => ({ workspace: logical, machineId: "provider-host", source: "session", ambiguous: [] })
  };
  const env = makeEnv(t, { providers: ["mock"] , workspaceService });
  env.catalog.registerRemoteAgent({
    machineId: "provider-host",
    provider: "codex",
    capabilities: {},
    machine: { allowedRoots: ["/provider-host"], repos: [{ repo_url: logical.repoUrl, path: "/provider-host/repo" }] }
  });
  env.catalog.heartbeatRemote({
    machineId: "provider-host",
    load: { active_turns: 0 },
    repos: [{ repo_url: logical.repoUrl, path: "/provider-host/repo" }]
  });

  const result = env.engine.dispatch({
    agentId: "provider-host:codex",
    workspaceId: "model-guessed-other-workspace",
    sessionId: "session-provider",
    prompt: "使用已选范围内的 Codex"
  });
  const task = env.store.getTask(result.taskId);
  assert.equal(task.agentId, "provider-host:codex");
  await waitFor(() => env.store.getTask(result.taskId).status === "completed");
});

test("prompt 自动匹配的 workspace 不得覆盖 dispatch_task 显式 agent", async (t) => {
  const env = makeEnv(t, {
    providers: ["mock"],
    workspaceService: {
      resolve: () => ({
        workspace: {
          workspaceId: "prompt-local",
          name: "dsh-alpha",
          repoUrl: null,
          locations: [{ machineId: "local-mac", path: "/local/dsh-alpha", online: true }]
        },
        source: "prompt",
        ambiguous: []
      })
    }
  });
  env.catalog.registerRemoteAgent({
    machineId: "ali-claw",
    provider: "mock",
    capabilities: {},
    machine: { allowedRoots: ["/ali-claw/work"], repos: [] }
  });

  const result = env.engine.dispatch({ agentId: "ali-claw:mock", prompt: "检查 dsh-alpha" });
  const task = env.store.getTask(result.taskId);
  assert.equal(task.agentId, "ali-claw:mock");
  assert.equal(task.machineId, "ali-claw");
  assert.equal(task.workspaceId, null);
  assert.equal(task.workspaceSource, "none");
  await waitFor(() => env.store.getTask(result.taskId).status === "completed");
});

test("会话级 Worker Agent、模型和权限模式覆盖主控侧派发参数", async (t) => {
  const selected = "worker-settings:mock";
  const workspaceService = {
    resolve: () => ({
      workspace: null,
      machineId: null,
      agentId: selected,
      mode: "full-access",
      model: "worker-model",
      reasoningEffort: "xhigh",
      source: "session",
      ambiguous: []
    })
  };
  const env = makeEnv(t, { providers: ["mock"], workspaceService });
  env.catalog.registerRemoteAgent({
    machineId: "worker-settings",
    provider: "mock",
    capabilities: {
      models: ["worker-model"],
      default_model: "worker-model",
      reasoning_efforts: ["high", "xhigh"],
      modes: ["default", "full-access"]
    },
    machine: { allowedRoots: ["/worker-settings"], repos: [] }
  });
  const localAgent = env.catalog.listAgents().find((agent) => agent.machineId === env.catalog.machineId);
  assert.throws(() => env.engine.dispatch({
    agentId: localAgent.agentId,
    model: "host-model",
    mode: "default",
    prompt: "使用 Worker 的设置执行"
  }), /界面已选择 agent/);
  const result = env.engine.dispatch({ model: "host-model", mode: "default", prompt: "使用 Worker 的设置执行" });
  const task = env.store.getTask(result.taskId);
  assert.equal(task.agentId, selected);
  assert.equal(task.settings.model, "worker-model");
  assert.equal(task.settings.mode, "full-access");
  assert.equal(task.settings.reasoning_effort, "xhigh");
  await waitFor(() => env.store.getTask(result.taskId).status === "completed");
});

test("非 Git 全局 workspace 不允许静默派到其它机器", (t) => {
  const logical = {
    workspaceId: "path-private",
    name: "private-dir",
    available: true,
    locations: [{ machineId: "only-host", path: "/only/private", online: true, providers: [] }]
  };
  const env = makeEnv(t, {
    workspaceService: { resolve: () => ({ workspace: logical, source: "session", ambiguous: [] }) }
  });
  assert.throws(() => env.engine.dispatch({ prompt: "处理 private-dir" }), /没有可用 Agent/);
});

test("远端无 repo 时默认使用远端首个 root，并拒绝越过远端广播边界", async (t) => {
  const env = makeEnv(t, { providers: ["mock"] });
  const { catalog, store, engine } = env;
  catalog.registerRemoteAgent({
    machineId: "rm-path",
    provider: "mock",
    capabilities: { default_model: "m", models: ["m"] },
    machine: { allowedRoots: ["/remote/work"], repos: [] }
  });
  catalog.heartbeatRemote({ machineId: "rm-path", load: { active_turns: 0 }, repos: [] });
  const remoteId = catalog.listAgents().find((row) => row.machineId === "rm-path").agentId;

  const { taskId } = engine.dispatch({ agentId: remoteId, prompt: "使用远端默认目录" });
  assert.equal(store.getTask(taskId).projectPath, "/remote/work");
  await waitFor(() => store.getTask(taskId).status === "completed");

  assert.throws(
    () => engine.dispatch({ agentId: remoteId, prompt: "越界", projectPath: "/etc" }),
    (error) => error.statusCode === 400 && /远端项目路径/.test(error.message)
  );
});

test("阶段3 本机无 repo 的本地 agent 带 repoUrl → 拒绝派发（409）", (t) => {
  const env = makeEnv(t, { providers: ["mock"] });
  const agentId = env.catalog.listAgents()[0].agentId;
  assert.throws(
    () => env.engine.dispatch({ agentId, prompt: "x", repoUrl: "https://github.com/acme/site" }),
    (error) => error.statusCode === 409 && /没有 repo/.test(error.message)
  );
});

test("repo identity 与 clone URL 分离；canonical 输入补 HTTPS，内嵌凭据拒绝", (t) => {
  const env = makeEnv(t, { providers: ["mock"] });
  const { taskId } = env.engine.dispatch({ prompt: "clone", repoUrl: "github.com/acme/site" });
  const task = env.store.getTask(taskId);
  assert.equal(task.repoUrl, "github.com/acme/site");
  assert.equal(task.repoCloneUrl, "https://github.com/acme/site.git");
  assert.throws(
    () => env.engine.dispatch({ prompt: "secret", repoUrl: "https://user:token@github.com/acme/private.git" }),
    (error) => error.statusCode === 400 && /不允许内嵌/.test(error.message)
  );
  assert.throws(
    () => env.engine.dispatch({ prompt: "invalid", repoUrl: "not-a-repo" }),
    (error) => error.statusCode === 400 && /URL 不合法/.test(error.message)
  );
});

test("阶段3 auto-pick 带 repoUrl：没有机器持有 repo → 退到最空闲并标 needsClone", async (t) => {
  const env = makeEnv(t, { providers: ["mock"] });
  const { taskId } = env.engine.dispatch({ prompt: "x", repoUrl: "https://github.com/acme/site" });
  const task = env.store.getTask(taskId);
  assert.equal(task.needsClone, true, "auto-pick 无 repo 机器时应标记按需 clone");
  assert.equal(task.repoUrl, "github.com/acme/site");
});

test("阶段3 主控递归：dispatch 到 dsh-master → 子任务派给 mock → 结果上卷", async (t) => {
  const env = makeEnv(t, { providers: ["mock"], recursive: true });
  const { store, engine } = env;
  const master = env.catalog.listAgents().find((a) => a.provider === "dsh-master");
  assert.ok(master, "dsh-master 应作为主控递归 agent 存在");
  const mockId = env.catalog.listAgents().find((a) => a.provider === "mock").agentId;

  const { taskId } = engine.dispatch({
    agentId: master.agentId,
    prompt: "聚合子任务结果",
    mode: "default",
    approvalPolicy: "never",
    recursion: { delegate: mockId, prompt: "递归子任务：数到三", depth: 0 }
  });

  await waitFor(() => store.getTask(taskId).status === "completed");
  const task = store.getTask(taskId);
  assert.match(task.result, /递归子任务|子任务/);
  // 外层事件流包含子任务事件（上卷）
  const deltas = task.events.filter((e) => e.type === "delta" || e.type === "complete");
  assert.ok(deltas.length >= 2, "外层事件流应包含子任务事件");
  // 子任务本身也完成（外层 complete 事件在末尾，带 subTaskId）
  const completeEvents = task.events.filter((e) => e.type === "complete");
  const wrapper = completeEvents.find((e) => e.payload?.subTaskId);
  assert.ok(wrapper, "外层 complete 事件应带 subTaskId");
  assert.equal(store.getTask(wrapper.payload.subTaskId).status, "completed");
});

test("dsh-master 不参与普通 auto-pick，显式普通派发也立即拒绝", (t) => {
  const env = makeEnv(t, { providers: ["mock"], recursive: true });
  const master = env.catalog.listAgents().find((row) => row.provider === "dsh-master");
  assert.throws(
    () => env.engine.dispatch({ agentId: master.agentId, prompt: "普通任务" }),
    (error) => error.statusCode === 400 && /只接受.*recursion/.test(error.message)
  );

  env.catalog.getAgent(env.catalog.listAgents().find((row) => row.provider === "mock").agentId).available = false;
  assert.throws(() => env.engine.dispatch({ prompt: "不能落到 master" }), /没有可用 agent/);
});

test("阶段3 递归深度超限 → 外层任务 failed", async (t) => {
  const env = makeEnv(t, { providers: ["mock"], recursive: true });
  const master = env.catalog.listAgents().find((a) => a.provider === "dsh-master");
  const mockId = env.catalog.listAgents().find((a) => a.provider === "mock").agentId;

  const { taskId } = env.engine.dispatch({
    agentId: master.agentId,
    prompt: "深递归",
    recursion: {
      delegate: master.agentId, // 自己派自己 → 无限递归
      prompt: "继续递归",
      depth: 10 // 超过默认 maxDepth=3
    }
  });
  await waitFor(() => env.store.getTask(taskId).status === "failed");
  assert.match(env.store.getTask(taskId).error, /递归深度超限/);
});
