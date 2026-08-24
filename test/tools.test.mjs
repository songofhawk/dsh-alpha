import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/tools.mjs";

function mountTools({ agents = [], workspaces = [], dispatchAndWait = async () => ({}) } = {}) {
  const registered = new Map();
  const ctx = {
    systemPrompt: { section() {} },
    tools: { register(tool) { registered.set(tool.name, tool); } },
    alphaCatalog: { listAgents: () => agents },
    alphaWorkspaces: { list: () => workspaces },
    agent: { id: "session-alpha" },
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

test("list_workspaces 返回多机聚合后的逻辑目录", async () => {
  const workspaces = [{ workspaceId: "repo-1", name: "ai-prd", available: true, locations: [] }];
  const list = mountTools({ workspaces }).get("list_workspaces");
  assert.deepEqual(await list.execute({}), workspaces);
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
