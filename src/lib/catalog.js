// 目录服务：机器 + agent 注册表（阶段 0 为本机单机形态）。
// 数据模型贴合设计文档 §3 list_agents 契约：
//   [{ agentId, machineId, provider, model, capabilities, machine: { os, platform, allowedRoots, load, lastHeartbeatMs, online } }]

const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { normalizeRepoUrl } = require("../adapters/vendor/shared/repo-identity");
const { aggregateWorkspaces, searchWorkspaces } = require("./workspaces");

// repo URL canonical 化（本文件内的短路引用）
function normalizeMachineRepoUrl(raw) {
  return normalizeRepoUrl(raw);
}

// -- 本地机器 -------------------------------------------------------------

function localMachineId() {
  return process.env.DSH_ALPHA_MACHINE_ID || os.hostname() || "local";
}

function defaultAllowedRoots() {
  // 与 agent-anywhere 同款缺省：cwd 的父目录
  return [path.resolve(path.dirname(process.cwd()))];
}

// -- 可执行文件探测 --------------------------------------------------------

function commandExists(command) {
  if (!command || typeof command !== "string") return false;
  if (command.includes(path.sep) || path.isAbsolute(command)) return false; // 交给 vendor resolver 处理
  const result = spawnSync("sh", ["-c", `command -v "${command.replace(/"/g, '\\"')}" >/dev/null 2>&1`]);
  return result.status === 0;
}

// 远端机器心跳超时：超过该时长未收到 heartbeat 视为离线
const REMOTE_HEARTBEAT_TIMEOUT_MS = 60_000;

function createCatalog({ allowedRoots = defaultAllowedRoots(), adapterProvider = null, workspaces = [] } = {}) {
  const localMachineIdValue = localMachineId();
  const agents = new Map(); // agentId -> record
  const machines = new Map(); // machineId -> 远端机器行（本机不在此表）

  const localMachine = () => ({
    machineId: localMachineIdValue,
    os: process.platform,
    platform: process.platform,
    allowedRoots: Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots],
    workspaces: Array.isArray(workspaces) ? workspaces : [],
    repos: (Array.isArray(workspaces) ? workspaces : []).filter((workspace) => workspace.repo_url),
    load: { active_turns: currentLoad() },
    lastHeartbeatMs: Date.now(),
    online: true
  });

  function currentLoad() {
    // 本机负载 = 本机 agent 的在跑轮数；远端机器负载由各自 heartbeat 上报
    let turns = 0;
    for (const agent of agents.values()) {
      if (agent.machineId === localMachineIdValue) turns += agent.runningTurns;
    }
    return turns;
  }

  // 本机 machine()（引擎 resolveRoots 用）；agent 的机器视图走 machineFor(record.machineId)
  const machine = () => localMachine();

  // agent 所属机器的目录行：远端表或本机实时行
  function machineFor(machineId) {
    if (!machineId || machineId === localMachineIdValue) return localMachine();
    const row = machines.get(machineId);
    if (!row) {
      return {
        os: null,
        platform: null,
        allowedRoots: [],
        workspaces: [],
        repos: [],
        load: { active_turns: 0 },
        lastHeartbeatMs: 0,
        online: false
      };
    }
    row.online = Date.now() - row.lastHeartbeatMs < REMOTE_HEARTBEAT_TIMEOUT_MS;
    return row;
  }

  // 远端机器行（worker hello / heartbeat 写入）
  function upsertMachine({ machineId, os: osKind, platform, allowedRoots: machineRoots, workspaces: machineWorkspaces, repos = [], load = { active_turns: 0 } }) {
    let row = machines.get(machineId);
    if (!row) {
      row = { machineId };
      machines.set(machineId, row);
    }
    if (osKind) row.os = osKind;
    if (platform) row.platform = platform;
    if (machineRoots) row.allowedRoots = Array.isArray(machineRoots) ? machineRoots : [machineRoots];
    if (Array.isArray(machineWorkspaces)) row.workspaces = machineWorkspaces;
    else if (Array.isArray(repos)) row.workspaces = repos;
    if (Array.isArray(repos)) row.repos = repos;
    if (!row.allowedRoots) row.allowedRoots = [];
    if (!row.os) row.os = null;
    if (!row.platform) row.platform = null;
    row.repos = row.repos || [];
    row.workspaces = row.workspaces || row.repos;
    row.load = { active_turns: Number(load?.active_turns) || 0 };
    row.lastHeartbeatMs = Date.now();
    row.online = true;
    return row;
  }

  function heartbeatRemote({ machineId, load, workspaces: machineWorkspaces, repos }) {
    const row = upsertMachine({ machineId, load, workspaces: machineWorkspaces, repos });
    // 心跳仅维持在线；离线判定交给 machineFor（按超时）
    return row;
  }

  function registerAgent({ provider, checkAvailable = true, reason = null, machineId = localMachineIdValue }) {
    // 递归子控制器（dsh-master）等非 runtime provider 没有能力表：容错，能力视为空
    let capabilities = {};
    try {
      capabilities = adapterProvider.capabilitiesFor(provider) || {};
    } catch {
      /* 无能力表的 provider（如 dsh-master） */
    }
    // checkAvailable=false：跳过探测，视为可用（如测试注入的 provider / 用户显式信任）
    let available = true;
    let unavailableReason = null;
    if (checkAvailable) {
      const probe = adapterProvider.probeAvailability(provider);
      available = probe.available;
      unavailableReason = probe.reason || null;
    }
    if (reason && !available) unavailableReason = reason;
    const agentId = `${machineId}:${provider}`;
    const record = {
      agentId,
      machineId,
      provider,
      model: capabilities.default_model || null,
      capabilities,
      available,
      unavailableReason,
      runningTurns: 0
    };
    agents.set(agentId, record);
    return record;
  }

  // 远端 worker 广告自己的能力 → 注册远端 agent（视为可用，reachability 由心跳维护）
  function registerRemoteAgent({ machineId, provider, capabilities, machine: remoteMachine }) {
    upsertMachine({ machineId, ...remoteMachine });
    const record = {
      agentId: `${machineId}:${provider}`,
      machineId,
      provider,
      model: capabilities.default_model || null,
      capabilities,
      available: true,
      unavailableReason: null,
      runningTurns: 0
    };
    agents.set(record.agentId, record);
    return record;
  }

  // worker 掉线：把该机器上的远端 agent 标为不可用
  function markMachineOffline(machineId) {
    for (const record of agents.values()) {
      if (record.machineId !== machineId) continue;
      record.available = false;
      record.unavailableReason = "gateway 连接断开";
    }
    const row = machines.get(machineId);
    if (row) {
      row.online = false;
      row.lastHeartbeatMs = 0;
    }
  }

  function markAgentUnavailable(agentId, reason = "runtime 不可用") {
    const record = getAgent(agentId);
    record.available = false;
    record.unavailableReason = reason;
    return record;
  }

  function getAgent(agentId) {
    const record = agents.get(agentId);
    if (!record) {
      const error = new Error(`目录中不存在 agent：${agentId}`);
      error.statusCode = 404;
      throw error;
    }
    return record;
  }

  function listAgents({ includeUnavailable = true } = {}) {
    const rows = [];
    for (const record of agents.values()) {
      if (!includeUnavailable && !record.available) continue;
      rows.push({
        agentId: record.agentId,
        machineId: record.machineId,
        provider: record.provider,
        model: record.model,
        capabilities: record.capabilities,
        available: record.available,
        unavailableReason: record.unavailableReason,
        machine: machineFor(record.machineId)
      });
    }
    return rows;
  }

  function listMachines() {
    return [localMachine(), ...[...machines.keys()].map((machineId) => ({ machineId, ...machineFor(machineId) }))];
  }

  function listWorkspaces({ query = "", includeOffline = true } = {}) {
    const rows = aggregateWorkspaces(listMachines(), listAgents());
    const filtered = includeOffline ? rows : rows.filter((workspace) => workspace.available);
    return searchWorkspaces(filtered, query).map((row) => row.workspace);
  }

  function getWorkspace(workspaceId) {
    const workspace = listWorkspaces().find((row) => row.workspaceId === workspaceId);
    if (!workspace) {
      const error = new Error(`全局工作区不存在：${workspaceId}`);
      error.statusCode = 404;
      throw error;
    }
    return workspace;
  }

  // 阶段 3：repo 身份 —— 某 agent 所在机器是否已持有目标 repo（canonical 比对）
  function machineRepoPath(row, repoUrl) {
    const normalized = normalizeMachineRepoUrl(repoUrl);
    if (!normalized) return null;
    const repos = Array.isArray(row.machine?.repos) ? row.machine.repos : [];
    for (const repo of repos) {
      if (normalizeMachineRepoUrl(repo.repo_url || repo.url) === normalized && repo.path) {
        return repo.path;
      }
    }
    return null;
  }

  // 阶段 3：负载感知排序 —— 可用在前 → 有目标 repo 优先 → 负载升序 → 心跳新优先。
  // 仅作排序信号：LLM 仍按目录信息做最终决策。
  function rankAgents({ provider = null, repoUrl = null } = {}) {
    const repoKey = normalizeMachineRepoUrl(repoUrl);
    const rows = listAgents({ includeUnavailable: false }).map((row) => {
      const repoPath = repoKey ? machineRepoPath(row, repoKey) : null;
      return {
        ...row,
        repoPath,
        activeTurns: Number(row.machine?.load?.active_turns) || 0
      };
    });
    const filtered = provider
      ? rows.filter((row) => row.provider === provider || row.agentId.split(":")[1] === provider)
      : rows;
    filtered.sort((a, b) =>
      (b.repoPath ? 1 : 0) - (a.repoPath ? 1 : 0) ||
      a.activeTurns - b.activeTurns ||
      (Number(b.machine?.lastHeartbeatMs) || 0) - (Number(a.machine?.lastHeartbeatMs) || 0) ||
      a.agentId.localeCompare(b.agentId)
    );
    return filtered;
  }

  function touchLoad(agentId, delta) {
    const record = agents.get(agentId);
    if (record) record.runningTurns = Math.max(0, record.runningTurns + delta);
  }

  function heartbeat(source = null) {
    // 阶段 1 起由 gateway/远端来源刷新机器状态；本机直接返回当前机器
    return machine();
  }

  return {
    machineId: localMachineIdValue,
    registerAgent,
    registerRemoteAgent,
    heartbeatRemote,
    markMachineOffline,
    markAgentUnavailable,
    getAgent,
    listAgents,
    listMachines,
    listWorkspaces,
    getWorkspace,
    rankAgents,
    machineRepoPath,
    touchLoad,
    heartbeat,
    currentLoad,
    machine,
    machineFor
  };
}

module.exports = { createCatalog, localMachineId, defaultAllowedRoots, commandExists };
