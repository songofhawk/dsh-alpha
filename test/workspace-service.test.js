const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWorkspaceService } = require("../src/lib/workspace-service");
const { tmpDir, cleanupDir } = require("./helpers");

const workspace = {
  workspaceId: "repo-ai-prd",
  name: "ai-prd",
  repoUrl: "github.com/acme/ai-prd",
  available: true,
  locations: [
    { machineId: "m1", path: "/work/ai-prd", online: true, providers: ["codex"] },
    { machineId: "m2", path: "/srv/ai-prd", online: true, providers: ["codex"] }
  ]
};

function catalog() {
  return {
    listWorkspaces: ({ query = "" } = {}) => !query || workspace.name.includes(query) ? [workspace] : [],
    listMachines: () => [
      { machineId: "m1", online: true },
      { machineId: "m2", online: true }
    ],
    getWorkspace: (id) => {
      if (id === workspace.workspaceId) return workspace;
      const error = new Error("missing");
      error.statusCode = 404;
      throw error;
    },
    getAgent: (id) => {
      if (id === "m2:codex") return { agentId: id, machineId: "m2" };
      const error = new Error("missing agent");
      error.statusCode = 404;
      throw error;
    }
  };
}

test("session 选择持久化并作为显式路由约束", (t) => {
  const dataDir = tmpDir("alpha-workspace-service-");
  t.after(() => cleanupDir(dataDir));
  const first = createWorkspaceService({ catalog: catalog(), dataDir });
  first.select("session-1", workspace.workspaceId);
  assert.equal(first.resolve({ sessionId: "session-1", prompt: "别的任务" }).source, "session");
  const second = createWorkspaceService({ catalog: catalog(), dataDir });
  assert.equal(second.selected("session-1").workspaceId, workspace.workspaceId);
  assert.equal(fs.statSync(second.controlCwd).isDirectory(), true);
  assert.equal(fs.statSync(second.file).mode & 0o777, 0o600);
});

test("未选择时不根据任务文本二次推断 workspace", (t) => {
  const dataDir = tmpDir("alpha-workspace-service-");
  t.after(() => cleanupDir(dataDir));
  const service = createWorkspaceService({ catalog: catalog(), dataDir });
  const automatic = service.resolve({ sessionId: "session-2", prompt: "处理 ai-prd 的接口" });
  assert.equal(automatic.source, "none");
  assert.equal(automatic.workspace, null);
  const explicit = service.resolve({ sessionId: "session-2", workspaceId: workspace.workspaceId, prompt: "处理 ai-prd 的接口" });
  assert.equal(explicit.source, "explicit");
  assert.equal(explicit.workspace.workspaceId, workspace.workspaceId);
  service.select("session-2", workspace.workspaceId);
  service.select("session-2", null);
  assert.equal(service.selected("session-2"), null);
});

test("工作机和工作区可以分别选择并持久化", (t) => {
  const dataDir = tmpDir("alpha-workspace-machine-selection-");
  t.after(() => cleanupDir(dataDir));
  const service = createWorkspaceService({ catalog: catalog(), dataDir });

  service.select("session-3", { workspaceId: workspace.workspaceId, machineId: "m2" });
  assert.equal(service.selection("session-3").machineId, "m2");
  assert.equal(service.selected("session-3").workspaceId, workspace.workspaceId);
  assert.equal(service.list({ machineId: "m2" })[0].locations[0].machineId, "m2");
  assert.equal(service.resolve({ sessionId: "session-3", prompt: "继续处理" }).machineId, "m2");
  assert.equal(service.resolve({ sessionId: "session-3", workspaceId: "model-guessed-workspace", prompt: "继续处理" }).workspace.workspaceId, workspace.workspaceId);

  const restored = createWorkspaceService({ catalog: catalog(), dataDir });
  assert.deepEqual(restored.selection("session-3"), {
    workspaceId: workspace.workspaceId,
    machineId: "m2",
    workspace
  });

  restored.select("session-3", { workspaceId: null, machineId: "m1" });
  assert.equal(restored.selected("session-3"), null);
  assert.equal(restored.selectedMachineId("session-3"), "m1");
});

test("Alpha 会话可以持久化 Worker Agent、权限模式和模型，并生成稳定目标分组目录", (t) => {
  const dataDir = tmpDir("alpha-worker-selection-");
  t.after(() => cleanupDir(dataDir));
  const service = createWorkspaceService({ catalog: catalog(), dataDir });

  service.select("session-4", {
    workspaceId: workspace.workspaceId,
    machineId: "m2",
    agentId: "m2:codex",
    mode: "full-access",
    model: "gpt-worker",
    reasoningEffort: "high"
  });
  assert.deepEqual(service.selection("session-4"), {
    workspaceId: workspace.workspaceId,
    machineId: "m2",
    agentId: "m2:codex",
    mode: "full-access",
    model: "gpt-worker",
    reasoningEffort: "high",
    workspace
  });
  assert.deepEqual(service.resolve({ sessionId: "session-4", prompt: "继续处理" }), {
    workspaceId: workspace.workspaceId,
    machineId: "m2",
    agentId: "m2:codex",
    mode: "full-access",
    model: "gpt-worker",
    reasoningEffort: "high",
    workspace,
    source: "session",
    ambiguous: []
  });

  const first = service.sessionTarget({ workspaceId: workspace.workspaceId, machineId: "m2" });
  const second = service.sessionTarget({ workspaceId: workspace.workspaceId, machineId: "m2" });
  assert.equal(first.cwd, second.cwd);
  assert.match(first.title, /^m2 · \/srv\/ai-prd$/);
  assert.equal(fs.statSync(first.cwd).isDirectory(), true);
});

test("主控目录支持新建项目并持久化机器、项目说明", (t) => {
  const dataDir = tmpDir("alpha-inventory-service-");
  t.after(() => cleanupDir(dataDir));
  const catalogRoot = path.join(dataDir, "projects");
  fs.mkdirSync(catalogRoot, { recursive: true });
  const machine = {
    machineId: "m-inventory",
    online: true,
    os: "linux",
    platform: "linux",
    allowedRoots: [catalogRoot],
    load: { active_turns: 1 },
    lastHeartbeatMs: Date.now()
  };
  const agent = { agentId: "m-inventory:codex", machineId: "m-inventory", provider: "codex", available: true };
  const inventoryCatalog = {
    machineId: machine.machineId,
    machine: () => machine,
    listMachines: () => [machine],
    listAgents: () => [agent],
    getAgent: (id) => id === agent.agentId ? agent : null,
    listWorkspaces: () => [],
    getWorkspace: () => { throw new Error("missing"); }
  };
  const service = createWorkspaceService({ catalog: inventoryCatalog, dataDir });
  const project = service.createProject({
    machineId: machine.machineId,
    name: "新项目",
    projectPath: path.join(catalogRoot, "new-project"),
    repoUrl: "https://github.com/acme/new-project.git",
    description: "优先交给 Codex，必须先跑测试。"
  });
  assert.equal(fs.statSync(project.locations[0].path).isDirectory(), true);
  assert.equal(project.description, "优先交给 Codex，必须先跑测试。");
  service.updateMachineDescription(machine.machineId, "GPU 机器，适合图像任务。");
  assert.equal(service.machines()[0].description, "GPU 机器，适合图像任务。");
  service.updateAgentDescription({ provider: "codex", description: "复杂任务优先使用。" });
  assert.equal(service.notes.snapshot().agents.codex, "复杂任务优先使用。");

  const restored = createWorkspaceService({ catalog: inventoryCatalog, dataDir });
  assert.equal(restored.list({ query: "新项目" })[0].description, "优先交给 Codex，必须先跑测试。");
  assert.equal(restored.machines()[0].description, "GPU 机器，适合图像任务。");
  assert.equal(fs.statSync(restored.notes.file).mode & 0o777, 0o600);
});

test("保存机器说明只校验机器身份，不重建完整工作区目录", (t) => {
  const dataDir = tmpDir("alpha-inventory-description-save-");
  t.after(() => cleanupDir(dataDir));
  let workspaceListCalls = 0;
  const measuredCatalog = {
    listMachines: () => [{ machineId: "m-fast", online: true }],
    listAgents: () => [],
    listWorkspaces: () => {
      workspaceListCalls += 1;
      return [];
    }
  };
  const service = createWorkspaceService({ catalog: measuredCatalog, dataDir });

  assert.deepEqual(service.updateMachineDescription("m-fast", "本机说明"), {
    machineId: "m-fast",
    description: "本机说明"
  });
  assert.equal(workspaceListCalls, 0);
  assert.equal(service.notes.snapshot().machines["m-fast"], "本机说明");
});
