import test from "node:test";
import assert from "node:assert/strict";
import { createJevRouter } from "../src/lib/jev-router.mjs";

const agents = [
  { agentId: "mac:codex", machineId: "mac", provider: "codex", available: true,
    description: "复杂代码", capabilities: { models: ["fast", "strong"], default_model: "fast" },
    machine: { repos: [{ repo_url: "https://example.com/app.git" }], load: { active_turns: 1 } } },
  { agentId: "linux:kimi", machineId: "linux", provider: "kimi", available: true,
    description: "文案", capabilities: { models: ["quick"], default_model: "quick" },
    machine: { repos: [], load: { active_turns: 0 } } }
];
const projects = [{ workspaceId: "app", name: "app", repoUrl: "https://example.com/app.git",
  locations: [{ machineId: "mac", online: true }] }];

function fixture(answer, { selection = {}, fetchImpl, workspaceRows = projects } = {}) {
  let request;
  const route = createJevRouter({
    enabled: true, apiKey: "test-key", endpoint: "https://api.typesafe.ai/v1/systemone",
    catalog: { machineId: "mac", listAgents: () => agents },
    workspaces: { list: () => workspaceRows },
    fetchImpl: fetchImpl || (async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ answers: answer }) };
    })
  });
  return { route, selection, request: () => request };
}

const choice = (key, options) => ({ type: "choice", choice: key, confidence: 0.9,
  probabilities: Object.fromEntries(options.map((option) => [option, option === key ? 0.9 : 0.1 / (options.length - 1)])) });

test("Jev 一次请求选择项目、Agent 和模型，返回已验证的目标 ID", async () => {
  const f = fixture({ target: choice("a0", ["a0", "a1", "unsure"]),
    workspace: choice("w0", ["none", "unsure", "w0"]),
    model_0: choice("m0", ["default", "m0"]) });
  assert.deepEqual(await f.route({ prompt: "修复 app 登录代码" }),
    { agentId: "mac:codex", workspaceId: "app", model: "strong" });
  assert.equal(f.request().model, "jev-latest");
  assert.equal(f.request().questions.target.type, "choice");
  assert.equal(f.request().questions.workspace.type, "choice");
  assert.equal(f.request().questions.model_0.type, "choice");
});

test("已选机器限制候选；低置信、跨机普通工作区和服务失败交回主控", async () => {
  const f = fixture({ target: choice("a3", ["a0", "a3"]),
    workspace: choice("none", ["none", "unsure", "w0"]) });
  const selected = { machineId: "mac" };
  assert.equal(await f.route({ prompt: "写代码", selected }), null, "未知候选 ID 不能执行");
  assert.equal(Object.keys(f.request().questions.target.criteria).length, 2);
  const low = fixture({ target: { ...choice("a0", ["a0", "a1", "unsure"]), confidence: 0.1 },
    workspace: choice("w0", ["none", "unsure", "w0"]) });
  assert.equal(await low.route({ prompt: "修复 app" }), null);
  const wrongHost = fixture({ target: choice("a1", ["a0", "a1", "unsure"]),
    workspace: choice("w0", ["none", "unsure", "w0"]) }, { workspaceRows: [{
    workspaceId: "local-dir", name: "local-dir", locations: [{ machineId: "mac", online: true }]
  }] });
  assert.equal(await wrongHost.route({ prompt: "处理 local-dir" }), null);
  const down = fixture(null, { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(await down.route({ prompt: "修复 app" }), null);
});

test("模型判断不确定时仍可按 Agent 默认模型派发", async () => {
  const f = fixture({ target: choice("a0", ["a0", "a1", "unsure"]),
    workspace: choice("w0", ["none", "unsure", "w0"]),
    model_0: { ...choice("m0", ["default", "m0"]), confidence: 0.1 } });
  assert.deepEqual(await f.route({ prompt: "修复 app 代码" }),
    { agentId: "mac:codex", workspaceId: "app" });
});

test("界面工作区和模型是硬约束，唯一合法目标直接派发", async () => {
  const f = fixture({ target: choice("a0", ["a0", "unsure"]) });
  const selected = { machineId: "mac", workspaceId: "app", workspace: projects[0], model: "strong" };
  assert.deepEqual(await f.route({ prompt: "修复登录", selected }),
    { agentId: "mac:codex", workspaceId: "app", model: "strong" });
  assert.equal(f.request(), undefined);
});

test("未配置官方密钥时不启用 Jev；不接受外部明文 HTTP", () => {
  assert.equal(createJevRouter({ enabled: true, apiKey: "", catalog: {}, workspaces: {} }), null);
  assert.throws(() => createJevRouter({ enabled: true, apiKey: "x", endpoint: "http://example.com/v1/systemone",
    catalog: {}, workspaces: {} }), /HTTPS/);
});
