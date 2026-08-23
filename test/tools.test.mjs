import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/tools.mjs";

function mountTools({ agents = [], dispatch = async () => ({}) } = {}) {
  const registered = new Map();
  const ctx = {
    systemPrompt: { section() {} },
    tools: { register(tool) { registered.set(tool.name, tool); } },
    alphaCatalog: { listAgents: () => agents },
    alphaEngine: {
      dispatch,
      taskStatus() { return {}; },
      taskResult() { return {}; },
      decideApproval() { return {}; },
      cancelTask() { return {}; }
    },
    alphaApprovals: { listPending: () => [] }
  };
  apply(ctx);
  return registered;
}

test("dispatch_task 的 agentId 可省略并原样交给引擎自动选机", async () => {
  let received;
  const tools = mountTools({
    dispatch: async (options) => {
      received = options;
      return { taskId: "task-1", agentId: "remote:codex", status: "queued" };
    }
  });
  const dispatch = tools.get("dispatch_task");

  assert.deepEqual(dispatch.parameters.required, ["prompt"]);
  await dispatch.execute({ prompt: "自动选择", repoUrl: "https://example.com/acme/repo.git" });
  assert.equal(received.agentId, undefined);
  assert.equal(received.prompt, "自动选择");
  assert.equal(received.repoUrl, "https://example.com/acme/repo.git");
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
