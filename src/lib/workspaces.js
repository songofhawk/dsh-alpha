// 多机全局工作区目录：
// - allowedRoots 只表示权限边界，不直接当作工作区；
// - 自动发现只检查 root 本身和直属子目录中的 Git 仓库；
// - 同一 canonical repo 在不同机器上的路径聚合为一个逻辑 workspace。

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { normalizeRepoUrl } = require("../adapters/vendor/shared/repo-identity");
const { isInside, resolveProjectPath } = require("../adapters/vendor/shared/path-policy");

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function repoName(repoUrl, workspacePath) {
  const canonical = normalizeRepoUrl(repoUrl);
  const raw = canonical ? canonical.split("/").at(-1) : path.basename(workspacePath || "");
  return String(raw || "workspace").replace(/\.git$/i, "") || "workspace";
}

function gitValue(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000
  });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function inspectGitWorkspace(candidate, roots) {
  let resolved;
  try {
    resolved = resolveProjectPath(candidate, roots);
  } catch {
    return null;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
  const top = gitValue(resolved, ["rev-parse", "--show-toplevel"]);
  if (!top || fs.realpathSync.native(top) !== fs.realpathSync.native(resolved)) return null;
  const remote = gitValue(resolved, ["remote", "get-url", "origin"]);
  const canonical = normalizeRepoUrl(remote);
  if (!canonical) return null;
  const branch = gitValue(resolved, ["branch", "--show-current"]);
  return {
    name: repoName(canonical, resolved),
    path: resolved,
    repo_url: canonical,
    ...(branch ? { branch } : {})
  };
}

function normalizeExplicitWorkspace(record, roots) {
  if (!record || typeof record !== "object" || !record.path) return null;
  let workspacePath;
  try {
    workspacePath = resolveProjectPath(String(record.path), roots);
  } catch {
    return null;
  }
  const canonical = normalizeRepoUrl(record.repo_url || record.repoUrl || record.url);
  const name = String(record.name || repoName(canonical, workspacePath)).trim();
  if (!name) return null;
  return {
    name,
    path: workspacePath,
    ...(canonical ? { repo_url: canonical } : {}),
    ...(record.branch ? { branch: String(record.branch) } : {})
  };
}

function dedupeWorkspaces(records) {
  const byPath = new Map();
  for (const record of records) {
    if (!record?.path) continue;
    const key = path.resolve(record.path);
    const previous = byPath.get(key);
    byPath.set(key, previous?.repo_url && !record.repo_url ? previous : { ...previous, ...record });
  }
  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

function discoverGitWorkspaces(allowedRoots, { explicit = [], scan = true } = {}) {
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots])
    .filter(Boolean)
    .map((root) => path.resolve(root));
  const records = [];
  for (const record of Array.isArray(explicit) ? explicit : []) {
    const normalized = normalizeExplicitWorkspace(record, roots);
    if (normalized) records.push(normalized);
  }
  if (!scan) return dedupeWorkspaces(records);
  for (const root of roots) {
    const rootWorkspace = inspectGitWorkspace(root, roots);
    if (rootWorkspace) records.push(rootWorkspace);
    let children = [];
    try {
      children = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith(".")) continue;
      const workspace = inspectGitWorkspace(path.join(root, child.name), roots);
      if (workspace) records.push(workspace);
    }
  }
  return dedupeWorkspaces(records);
}

function normalizeRemoteWorkspaces(records, { machineId, allowedRoots }) {
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : []).map((root) => path.resolve(root));
  const normalized = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.path) continue;
    const workspacePath = path.resolve(String(record.path));
    if (!roots.some((root) => isInside(workspacePath, root))) continue;
    const canonical = normalizeRepoUrl(record.repo_url || record.repoUrl || record.url);
    const name = String(record.name || repoName(canonical, workspacePath)).trim();
    if (!name) continue;
    normalized.push({
      machineId,
      name,
      path: workspacePath,
      ...(canonical ? { repo_url: canonical } : {}),
      ...(record.branch ? { branch: String(record.branch) } : {})
    });
  }
  return dedupeWorkspaces(normalized);
}

function aggregateWorkspaces(machineRows, agents) {
  const groups = new Map();
  const providersByMachine = new Map();
  for (const agent of agents || []) {
    if (!agent.available) continue;
    const providers = providersByMachine.get(agent.machineId) || new Set();
    providers.add(agent.provider);
    providersByMachine.set(agent.machineId, providers);
  }
  for (const machine of machineRows || []) {
    const machineId = machine.machineId;
    const records = normalizeRemoteWorkspaces(machine.workspaces || machine.repos, {
      machineId,
      allowedRoots: machine.allowedRoots
    });
    for (const record of records) {
      const repoKey = normalizeRepoUrl(record.repo_url);
      const key = repoKey ? `repo:${repoKey}` : `path:${machineId}:${record.path}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          workspaceId: repoKey ? `repo-${shortHash(repoKey)}` : `path-${shortHash(key)}`,
          name: record.name,
          ...(repoKey ? { repoUrl: repoKey } : {}),
          locations: []
        };
        groups.set(key, group);
      }
      group.locations.push({
        machineId,
        path: record.path,
        online: machine.online === true,
        providers: [...(providersByMachine.get(machineId) || [])].sort(),
        ...(record.branch ? { branch: record.branch } : {})
      });
    }
  }
  return [...groups.values()]
    .map((workspace) => ({
      ...workspace,
      available: workspace.locations.some((location) => location.online),
      locations: workspace.locations.sort((a, b) => Number(b.online) - Number(a.online) || a.machineId.localeCompare(b.machineId))
    }))
    .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
}

function workspaceSearchScore(workspace, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 1;
  const name = workspace.name.toLowerCase();
  const repo = String(workspace.repoUrl || "").toLowerCase();
  if (q === workspace.workspaceId.toLowerCase()) return 1_000;
  if (q === name) return 200;
  if (repo && q === repo) return 190;
  if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(name)}([^a-z0-9]|$)`, "i").test(q)) return 150;
  if (q.includes(name)) return 120;
  if (name.includes(q)) return 90;
  if (repo.includes(q)) return 70;
  return 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchWorkspaces(workspaces, query) {
  return (workspaces || [])
    .map((workspace) => ({ workspace, score: workspaceSearchScore(workspace, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.workspace.name.localeCompare(b.workspace.name));
}

function resolveWorkspaceFromPrompt(workspaces, prompt) {
  const ranked = searchWorkspaces(workspaces, prompt);
  if (!ranked.length || ranked[0].score < 120) return { workspace: null, ambiguous: [] };
  const tied = ranked.filter((row) => row.score === ranked[0].score);
  if (tied.length !== 1) return { workspace: null, ambiguous: tied.map((row) => row.workspace) };
  return { workspace: ranked[0].workspace, ambiguous: [] };
}

module.exports = {
  aggregateWorkspaces,
  discoverGitWorkspaces,
  normalizeRemoteWorkspaces,
  resolveWorkspaceFromPrompt,
  searchWorkspaces,
  workspaceSearchScore
};
