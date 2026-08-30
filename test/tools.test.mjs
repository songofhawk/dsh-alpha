import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/tools.mjs";

function mountTools({ agents = [], workspaces = [], selection = null, dispatchAndWait = async () => ({}), agent = { id: "session-alpha" } } = {}) {
  const registered = new Map();
  const ctx = {
    systemPrompt: { section() {} },
    tools: { register(tool) { registered.set(tool.name, tool); } },
    alphaCatalog: { listAgents: () => agents },
    alphaWorkspaces: { list: () => workspaces, selection: () => selection || { workspace: null, machineId: null } },
    agent,
    alphaEngine: {
      dispatchAndWait,
      taskStatus() { return {}; },
      taskResult() { return {}; },
      decideApprovalAndWait() { return {}; },
      cancelTask() { return {}; }
    },
    alphaApprovals: { listPending: () => [] }
  };
  apply(ctx);
  return registered;
}

test("dispatch_task 事件驱动等待并把选机参数原样交给引擎", async () => {
  let received;
  const tools = mountTools({
    dispatchAndWait: async (options) => {
      received = options;
      return { taskId: "task-1", agentId: "remote:codex", status: "completed", result: "done" };
    }
  });
  const dispatch = tools.get("dispatch_task");

  assert.deepEqual(dispatch.parameters.required, ["prompt"]);
  await dispatch.execute({ prompt: "自动选择", repoUrl: "https://example.com/acme/repo.git" });
  assert.equal(received.agentId, undefined);
  assert.equal(received.prompt, "自动选择");
  assert.equal(received.repoUrl, "https://example.com/acme/repo.git");
  assert.equal(received.sessionId, "session-alpha");
  assert.match(dispatch.description, /等待完成/);
});

test("dispatch_task 每次执行都读取当前 session 身份", async () => {
  const agent = { id: "session-alpha" };
  const received = [];
  const tools = mountTools({
    agent,
    dispatchAndWait: async (options) => {
      received.push(options.sessionId);
      return { taskId: "task-1", agentId: "remote:codex", status: "completed", result: "done" };
    }
  });
  const dispatch = tools.get("dispatch_task");

  await dispatch.execute({ prompt: "第一次" });
  agent.id = "session-beta";
  await dispatch.execute({ prompt: "第二次" });
  assert.deepEqual(received, ["session-alpha", "session-beta"]);
});

test("dispatch_task 优先使用本次工具调用的 agent session", async () => {
  const received = [];
  const tools = mountTools({
    agent: { id: "stale-session" },
    dispatchAndWait: async (options) => {
      received.push(options.sessionId);
      return { taskId: "task-1", agentId: "remote:codex", status: "completed", result: "done" };
    }
  });
  const dispatch = tools.get("dispatch_task");

  await dispatch.execute({ prompt: "当前会话" }, { agent: { id: "live-session" } });
  assert.deepEqual(received, ["live-session"]);
});

test("dispatch_task 把宿主停止信号传给任务引擎", async () => {
  let receivedSignal;
  const controller = new AbortController();
  const dispatch = mountTools({
    dispatchAndWait: async (_options, control) => {
      receivedSignal = control.signal;
      return { taskId: "task-1", agentId: "remote:codex", status: "cancelled" };
    }
  }).get("dispatch_task");

  await dispatch.execute({ prompt: "可停止任务" }, { agent: { id: "live-session" }, signal: controller.signal });
  assert.equal(receivedSignal, controller.signal);
});

test("list_workspaces 返回多机聚合后的逻辑目录", async () => {
  const workspaces = [{ workspaceId: "repo-1", name: "ai-prd", available: true, locations: [] }];
  const list = mountTools({ workspaces }).get("list_workspaces");
  assert.deepEqual(await list.execute({}), workspaces);
});

test("界面已选择工作机和工作区时，目录工具只暴露选定范围", async () => {
  const selectedWorkspace = {
    workspaceId: "repo-ai-prd",
    name: "ai-prd",
    locations: [{ machineId: "ai-prd", path: "/var/www/ai-prd", online: true }]
  };
  const tools = mountTools({
    agents: [
      { agentId: "ai-prd:codex", machineId: "ai-prd", available: true },
      { agentId: "local-mac:claude-code", machineId: "local-mac", available: true }
    ],
    workspaces: [selectedWorkspace, { workspaceId: "repo-local", name: "local", locations: [] }],
    selection: { workspace: selectedWorkspace, machineId: "ai-prd" }
  });

  const listedWorkspaces = await tools.get("list_workspaces").execute({});
  const listedAgents = await tools.get("list_agents").execute({ online: true });
  assert.deepEqual(listedWorkspaces, [{
    ...selectedWorkspace,
    locations: [{ machineId: "ai-prd", path: "/var/www/ai-prd", online: true }]
  }]);
  assert.deepEqual(listedAgents.map((agent) => agent.agentId), ["ai-prd:codex"]);
});

test("list_agents 仅在 online=true 时过滤不可用项", async () => {
  const agents = [
    { agentId: "m1:codex", available: true },
    { agentId: "m2:kimi", available: false }
  ];
  const list = mountTools({ agents }).get("list_agents");

  assert.equal((await list.execute({})).length, 2);
  assert.equal((await list.execute({ online: false })).length, 2);
  assert.deepEqual((await list.execute({ online: true })).map((row) => row.agentId), ["m1:codex"]);
});
