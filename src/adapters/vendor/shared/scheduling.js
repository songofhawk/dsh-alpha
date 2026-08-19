const { normalizeProviderName } = require("./providers");
const { normalizeRepoUrl } = require("./repo-identity");

const MAX_MACHINE_REPOS = 200;

function compactMachineLoad(load = {}) {
  const activeTurns = Number.parseInt(load.active_turns, 10);
  return {
    active_turns: Number.isFinite(activeTurns) && activeTurns >= 0 ? activeTurns : 0
  };
}

function compactMachineRepos(repos = []) {
  const compacted = [];
  const seen = new Set();
  for (const item of Array.isArray(repos) ? repos : []) {
    const repoUrl = normalizeRepoUrl(item?.repo_url || item?.url);
    const repoPath = String(item?.path || "").trim();
    if (!repoUrl || !repoPath) {
      continue;
    }
    const key = `${repoUrl}\n${repoPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    compacted.push({ repo_url: repoUrl, path: repoPath });
    if (compacted.length >= MAX_MACHINE_REPOS) {
      break;
    }
  }
  return compacted;
}

function machineSupportsProvider(machine, provider) {
  if (!provider) {
    return true;
  }
  const requested = normalizeProviderName(provider);
  const providers = Array.isArray(machine.capabilities?.providers) ? machine.capabilities.providers : [];
  return providers.some((name) => normalizeProviderName(name) === requested);
}

function machineRepoPath(machine, projects, repoUrl) {
  for (const project of projects) {
    if (project.machine_id === machine.id && normalizeRepoUrl(project.repo_url) === repoUrl) {
      return project.path;
    }
  }
  for (const repo of machine.repos || []) {
    if (normalizeRepoUrl(repo.repo_url) === repoUrl) {
      return repo.path;
    }
  }
  return null;
}

function machineActiveTurns(machine, sessions) {
  if (Number.isFinite(machine.load?.active_turns)) {
    return machine.load.active_turns;
  }
  return sessions.filter(
    (session) => session.machine_id === machine.id && ["running", "blocked"].includes(session.status)
  ).length;
}

function lastRepoUseAt(machine, projects, sessions, repoUrl) {
  const repoProjectIds = new Set(
    projects
      .filter((project) => project.machine_id === machine.id && normalizeRepoUrl(project.repo_url) === repoUrl)
      .map((project) => project.id)
  );
  let latest = "";
  for (const session of sessions) {
    if (session.machine_id !== machine.id || !repoProjectIds.has(session.project_id)) {
      continue;
    }
    const updatedAt = String(session.updated_at || "");
    if (updatedAt > latest) {
      latest = updatedAt;
    }
  }
  return latest;
}

function selectMachine({ machines = [], projects = [], sessions = [], provider, repoUrl } = {}) {
  const repoKey = normalizeRepoUrl(repoUrl);
  const reasons = [];
  const candidates = [];

  for (const machine of machines) {
    if (machine.status !== "online") {
      reasons.push({ machine_id: machine.id, reason: "机器离线" });
      continue;
    }
    if (!machineSupportsProvider(machine, provider)) {
      reasons.push({ machine_id: machine.id, reason: `不支持 provider：${normalizeProviderName(provider)}` });
      continue;
    }
    let repoPath = null;
    if (repoKey) {
      repoPath = machineRepoPath(machine, projects, repoKey);
      if (!repoPath) {
        reasons.push({ machine_id: machine.id, reason: `没有 repo：${repoKey}` });
        continue;
      }
    }
    candidates.push({
      machine,
      repo_path: repoPath,
      active_turns: machineActiveTurns(machine, sessions),
      last_seen_at: String(machine.last_seen_at || ""),
      last_repo_use_at: repoKey ? lastRepoUseAt(machine, projects, sessions, repoKey) : ""
    });
  }

  candidates.sort((a, b) =>
    (a.active_turns - b.active_turns) ||
    b.last_seen_at.localeCompare(a.last_seen_at) ||
    b.last_repo_use_at.localeCompare(a.last_repo_use_at)
  );

  const best = candidates[0] || null;
  return {
    machine: best?.machine || null,
    repo_path: best?.repo_path || null,
    candidates: candidates.map((candidate) => ({
      machine_id: candidate.machine.id,
      active_turns: candidate.active_turns
    })),
    reasons
  };
}

module.exports = {
  MAX_MACHINE_REPOS,
  compactMachineLoad,
  compactMachineRepos,
  machineActiveTurns,
  selectMachine
};
