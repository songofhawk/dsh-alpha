const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createCatalog, commandExists } = require("../src/lib/catalog.js");

const FAKE_ADAPTERS = {
  capabilitiesFor: (provider) => ({
    provider,
    default_model: provider + "-model",
    models: [provider + "-model", "extra"]
  }),
  probeAvailability: (provider) => (provider === "mock"
    ? { available: true, reason: null }
    : { available: false, reason: `${provider} 未安装` })
};

const root = path.resolve("/", "tmp", "alpha-test-root");

test("registerAgent 产出设计契约形状", () => {
  const catalog = createCatalog({ allowedRoots: [root], adapterProvider: FAKE_ADAPTERS });
  catalog.registerAgent({ provider: "mock", checkAvailable: true });
  const [row] = catalog.listAgents();
  assert.equal(row.agentId, `${catalog.machineId}:mock`);
  assert.equal(row.machineId, catalog.machineId);
  assert.equal(row.provider, "mock");
  assert.equal(row.model, "mock-model");
  assert.equal(row.available, true);
  assert.equal(row.machine.os, process.platform);
  assert.deepEqual(row.machine.allowedRoots, [root]);
  assert.equal(typeof row.machine.load.active_turns, "number");
  assert.equal(row.machine.online, true);
  assert.equal(typeof row.machine.lastHeartbeatMs, "number");
});

test("目录内置 Agent 选择说明，并支持自定义说明解析器", () => {
  const catalog = createCatalog({ allowedRoots: [root], adapterProvider: FAKE_ADAPTERS });
  catalog.registerAgent({ provider: "codex", checkAvailable: false });
  assert.match(catalog.listAgents()[0].description, /文生图/);
  catalog.setAgentDescriptionResolver((agent) => agent.provider === "codex" ? "只处理复杂后端任务" : "");
  assert.equal(catalog.listAgents()[0].description, "只处理复杂后端任务");
  catalog.setMachineDescriptionResolver(() => "GPU 机器优先图像任务");
  assert.equal(catalog.listAgents()[0].machine.description, "GPU 机器优先图像任务");
});

test("可用性探测纳入目录；list_agents 可过滤", () => {
  const catalog = createCatalog({ allowedRoots: [root], adapterProvider: FAKE_ADAPTERS });
  catalog.registerAgent({ provider: "mock", checkAvailable: true });
  catalog.registerAgent({ provider: "codex", checkAvailable: true });
  const all = catalog.listAgents();
  assert.equal(all.length, 2);
  const online = catalog.listAgents({ includeUnavailable: false });
  assert.equal(online.length, 1);
  assert.equal(online[0].provider, "mock");
  assert.match(all[1].unavailableReason, /未安装/);
});

test("getAgent 未知抛 404；touchLoad 累计运行计数", () => {
  const catalog = createCatalog({ allowedRoots: [root], adapterProvider: FAKE_ADAPTERS });
  catalog.registerAgent({ provider: "mock", checkAvailable: true });
  assert.throws(() => catalog.getAgent("nope:nope"), { statusCode: 404 });
  const agentId = catalog.listAgents()[0].agentId;
  catalog.touchLoad(agentId, 1);
  catalog.touchLoad(agentId, 1);
  assert.equal(catalog.currentLoad(), 2);
  const [row] = catalog.listAgents();
  assert.equal(row.machine.load.active_turns, 2);
  catalog.touchLoad(agentId, -5); // 不为负
  assert.equal(catalog.currentLoad(), 0);
});

test("commandExists：PATH 中命令为 true，随机命令为 false", () => {
  assert.equal(commandExists("sh"), true);
  assert.equal(commandExists("dsh-alpha-definitely-not-a-real-command-xyz"), false);
  assert.equal(commandExists("/absolute/path/not/exists"), false);
});

test("阶段3 rankAgents：repo 身份优先 → 负载升序 → 心跳新优先", async () => {
  const catalog = createCatalog({ allowedRoots: [root], adapterProvider: FAKE_ADAPTERS });
  // 两个远端机器：m1 持有 repo 且负载 2；m2 无 repo 但负载 0
  catalog.registerRemoteAgent({
    machineId: "m1",
    provider: "mock",
    capabilities: { default_model: "m", models: ["m"] },
    machine: { allowedRoots: ["/m1"], repos: [{ repo_url: "git@github.com:acme/site.git", path: "/m1/site" }] }
  });
  catalog.registerRemoteAgent({
    machineId: "m2",
    provider: "mock",
    capabilities: { default_model: "m", models: ["m"] },
    machine: { allowedRoots: ["/m2"], repos: [] }
  });
  catalog.heartbeatRemote({ machineId: "m1", load: { active_turns: 2 }, repos: [{ repo_url: "git@github.com:acme/site.git", path: "/m1/site" }] });
  catalog.heartbeatRemote({ machineId: "m2", load: { active_turns: 0 }, repos: [] });

  // 带 repoUrl：m1 先排（尽管更忙）——「最空闲且有目标 repo」
  const withRepo = catalog.rankAgents({ repoUrl: "https://github.com/acme/site.git" });
  assert.equal(withRepo.length, 2);
  assert.equal(withRepo[0].machineId, "m1");
  assert.equal(withRepo[0].repoPath, "/m1/site");
  assert.equal(withRepo[1].repoPath, null); // 无 repo 的放在后面

  // 不带 repoUrl：负载升序 → m2 最空闲排第一
  const byLoad = catalog.rankAgents();
  assert.equal(byLoad[0].machineId, "m2");
  assert.equal(byLoad[0].activeTurns, 0);

  // 离线机器不进候选
  catalog.markMachineOffline("m2");
  const onlineOnly = catalog.rankAgents();
  assert.ok(!onlineOnly.some((row) => row.machineId === "m2"));
});

test("阶段3 machineRepoPath：canonical 化匹配（scp/ https 等价）", () => {
  const catalog = createCatalog({ allowedRoots: [root], adapterProvider: FAKE_ADAPTERS });
  catalog.registerRemoteAgent({
    machineId: "m1",
    provider: "mock",
    capabilities: { default_model: "m", models: ["m"] },
    machine: { allowedRoots: ["/m1"], repos: [{ repo_url: "git@github.com:acme/site.git", path: "/m1/site" }] }
  });
  const row = catalog.listAgents().find((a) => a.machineId === "m1");
  assert.equal(catalog.machineRepoPath(row, "https://github.com/acme/site"), "/m1/site");
  assert.equal(catalog.machineRepoPath(row, "git@github.com:acme/site.git"), "/m1/site");
  assert.equal(catalog.machineRepoPath(row, "github.com/acme/other"), null);
});

test("全局工作区目录聚合本机和远端同一 repo", () => {
  const catalog = createCatalog({
    allowedRoots: [root],
    workspaces: [{ name: "site", repo_url: "github.com/acme/site", path: path.join(root, "site") }],
    adapterProvider: FAKE_ADAPTERS
  });
  catalog.registerAgent({ provider: "mock", checkAvailable: true });
  catalog.registerRemoteAgent({
    machineId: "m1",
    provider: "mock",
    capabilities: {},
    machine: {
      allowedRoots: ["/m1"],
      workspaces: [{ name: "site", repo_url: "git@github.com:acme/site.git", path: "/m1/site" }]
    }
  });
  const rows = catalog.listWorkspaces({ query: "site" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].locations.length, 2);
  assert.deepEqual(rows[0].locations.map((location) => location.machineId).sort(), ["m1", catalog.machineId].sort());
  assert.equal(catalog.getWorkspace(rows[0].workspaceId).name, "site");
});
