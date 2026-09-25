import test from "node:test";
import assert from "node:assert/strict";
import { createJevRouter } from "../src/lib/jev-router.mjs";

const agents = [
  { agentId: "mac:codex", machineId: "mac", provider: "codex", available: true,
    description: "复杂代码", capabilities: { models: ["fast", "strong"], default_model: "fast" },
    machine: { repos: [{ repo_url: "https://example.com/app.git" }], load: { active_turns: 1 } } },
  { agentId: "linux:kimi", machineId: "linux", provider: "kimi", available: true,
    description: "文案", capabilities: { models: ["quick"], default_model: "quick" },
    machine: { repos: [], load: { active_turns: 0 } } },
  { agentId: "mac:workbuddy", machineId: "mac", provider: "workbuddy", available: true,
    description: "日常工程任务", capabilities: { models: [] },
    machine: { repos: [{ repo_url: "https://example.com/app.git" }], load: { active_turns: 0 } } }
];
const projects = [{ workspaceId: "app", name: "app", repoUrl: "https://example.com/app.git",
  locations: [{ machineId: "mac", online: true }] }];

function fixture(answer, { selection = {}, fetchImpl, workspaceRows = projects, agentRows = agents } = {}) {
  let request;
  const route = createJevRouter({
    enabled: true, apiKey: "test-key", endpoint: "https://api.typesafe.ai/v1/systemone",
    catalog: { machineId: "mac", listAgents: () => agentRows },
    workspaces: { list: () => workspaceRows },
    fetchImpl: fetchImpl || (async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ answers: { needsShell: { type: "noul", noul: 0.1 }, ...answer } }) };
    })
  });
  return { route, selection, request: () => request };
}

const choice = (key, options) => ({ type: "choice", choice: key, confidence: 0.9,
  probabilities: Object.fromEntries(options.map((option) => [option, option === key ? 0.9 : 0.1 / (options.length - 1)])) });

test("Jev 一次请求选择项目、Agent 和模型，返回已验证的目标 ID", async () => {
  const f = fixture({ target: choice("a0", ["a0", "a1", "a2", "unsure"]),
    workspace: choice("w0", ["none", "unsure", "w0"]),
    model_0: choice("m0", ["default", "m0"]) });
  assert.deepEqual(await f.route({ prompt: "修复登录代码" }),
    { agentId: "mac:codex", workspaceId: "app", model: "strong" });
  assert.equal(f.request().model, "jev-latest");
  assert.equal(f.request().questions.target.type, "choice");
  assert.equal(f.request().questions.workspace.type, "choice");
  assert.equal(f.request().questions.model_0.type, "choice");
});

test("已选机器限制候选；项目不确定、非法目标和服务失败交回主控", async () => {
  const f = fixture({ target: choice("a3", ["a0", "a2", "a3"]),
    workspace: choice("none", ["none", "unsure", "w0"]) });
  const selected = { machineId: "mac" };
  assert.equal(await f.route({ prompt: "写代码", selected }), null, "未知候选 ID 不能执行");
  assert.equal(Object.keys(f.request().questions.target.criteria).length, 3);
  const low = fixture({ target: choice("a0", ["a0", "a1", "a2", "unsure"]),
    workspace: { ...choice("w0", ["none", "unsure", "w0"]), confidence: 0.1 } });
  assert.equal(await low.route({ prompt: "修复登录" }), null);
  const wrongHost = fixture({ target: choice("a1", ["a0", "a1", "a2", "unsure"]),
    workspace: choice("w0", ["none", "unsure", "w0"]) }, { workspaceRows: [{
    workspaceId: "local-dir", name: "local-dir", locations: [{ machineId: "mac", online: true }]
  }] });
  assert.equal(await wrongHost.route({ prompt: "处理目录" }), null);
  const down = fixture(null, { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(await down.route({ prompt: "修复 app" }), null);
});

test("模型判断不确定时仍可按 Agent 默认模型派发", async () => {
  const f = fixture({ target: choice("a0", ["a0", "a1", "a2", "unsure"]),
    workspace: choice("w0", ["none", "unsure", "w0"]),
    model_0: { ...choice("m0", ["default", "m0"]), confidence: 0.1 } });
  assert.deepEqual(await f.route({ prompt: "修复 app 代码" }),
    { agentId: "mac:codex", workspaceId: "app" });
});

test("明确项目先按位置缩小候选，Jev 只接收精简 Agent 信息", async () => {
  const f = fixture({ target: { type: "choice", choice: "a0", confidence: 0.1,
    probabilities: { a0: 0.55, unsure: 0.45 } } });
  assert.deepEqual(await f.route({ prompt: "查看 app 项目版本" }),
    { agentId: "mac:codex", workspaceId: "app" });
  assert.deepEqual(Object.keys(f.request().questions), ["target", "needsShell", "model_0"]);
  assert.deepEqual(Object.keys(f.request().questions.target.criteria), ["a0", "a1"]);
  assert.equal("repos" in f.request().questions.target.criteria.a0, false);
});

test("git 日志请求由 Jev 识别命令需求，跳过缺少 Bash 权限的 WorkBuddy", async () => {
  const f = fixture({
    needsShell: { type: "noul", noul: 0.94 },
    target: { type: "choice", choice: "a1", confidence: 0.2,
      probabilities: { a0: 0.35, a1: 0.65 } }
  });
  assert.deepEqual(await f.route({ prompt: "看一下 app 项目的最新提交日志" }),
    { agentId: "mac:codex", workspaceId: "app" });
  assert.equal(f.request().questions.target.criteria.a1.shellCommands,
    "当前自动审批环境不能执行 shell 命令");
});

test("界面工作区和模型是硬约束，唯一合法目标直接派发", async () => {
  const f = fixture({ target: choice("a0", ["a0", "unsure"]) }, { agentRows: agents.slice(0, 2) });
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
