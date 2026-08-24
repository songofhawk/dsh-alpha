const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { aggregateWorkspaces, discoverGitWorkspaces, resolveWorkspaceFromPrompt, searchWorkspaces } = require("../src/lib/workspaces");
const { tmpDir, cleanupDir } = require("./helpers");

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("自动发现只收集 allowed root 本身与直属 Git workspace", (t) => {
  const root = tmpDir("alpha-workspaces-");
  t.after(() => cleanupDir(root));
  const repo = path.join(root, "ai-prd");
  const ordinary = path.join(root, "downloads");
  fs.mkdirSync(repo);
  fs.mkdirSync(ordinary);
  git(repo, ["init", "-q"]);
  git(repo, ["remote", "add", "origin", "git@github.com:acme/ai-prd.git"]);

  const rows = discoverGitWorkspaces([root]);
  assert.deepEqual(rows.map((row) => row.name), ["ai-prd"]);
  assert.equal(rows[0].repo_url, "github.com/acme/ai-prd");
  assert.equal(rows[0].path, repo);
});

test("同一 repo 的多机路径聚合成一个逻辑 workspace", () => {
  const machines = [{
    machineId: "mac",
    allowedRoots: ["/Users/me/repos"],
    online: true,
    workspaces: [{ name: "ai-prd", repo_url: "git@github.com:acme/ai-prd.git", path: "/Users/me/repos/ai-prd" }]
  }, {
    machineId: "linux",
    allowedRoots: ["/work"],
    online: true,
    workspaces: [{ repo_url: "https://github.com/acme/ai-prd", path: "/work/ai-prd" }]
  }];
  const agents = [{ machineId: "mac", provider: "codex", available: true }, { machineId: "linux", provider: "claude-code", available: true }];
  const rows = aggregateWorkspaces(machines, agents);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "ai-prd");
  assert.equal(rows[0].locations.length, 2);
  assert.deepEqual(rows[0].locations.map((row) => row.machineId), ["linux", "mac"]);
});

test("工作区搜索支持显式查询与任务文本唯一匹配", () => {
  const rows = [{ workspaceId: "repo-a", name: "ai-prd", repoUrl: "github.com/acme/ai-prd", available: true, locations: [] }, {
    workspaceId: "repo-b", name: "dsh-alpha", repoUrl: "github.com/acme/dsh-alpha", available: true, locations: []
  }];
  assert.equal(searchWorkspaces(rows, "ai-prd")[0].workspace.workspaceId, "repo-a");
  assert.equal(resolveWorkspaceFromPrompt(rows, "修复 ai-prd 登录问题").workspace.workspaceId, "repo-a");
  assert.equal(resolveWorkspaceFromPrompt(rows, "写一句 hello").workspace, null);
});
