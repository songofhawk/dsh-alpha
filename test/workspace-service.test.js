const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

test("session 选择持久化并优先于 prompt 自动解析", (t) => {
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

test("未选择时从用户表述唯一解析；清空后恢复自动模式", (t) => {
  const dataDir = tmpDir("alpha-workspace-service-");
  t.after(() => cleanupDir(dataDir));
  const service = createWorkspaceService({ catalog: catalog(), dataDir });
  const automatic = service.resolve({ sessionId: "session-2", prompt: "处理 ai-prd 的接口" });
  assert.equal(automatic.source, "prompt");
  assert.equal(automatic.workspace.workspaceId, workspace.workspaceId);
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
