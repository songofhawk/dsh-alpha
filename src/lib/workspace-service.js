// 全局工作区选择服务：目录来自 catalog，选择按 DSH session 持久化。

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { searchWorkspaces } = require("./workspaces");
const { normalizeRepoUrl } = require("../adapters/vendor/shared/repo-identity");
const { isInside, openOrCreateProjectPath } = require("../adapters/vendor/shared/path-policy");
const { createInventoryNotes, normalizeDescription } = require("./inventory-notes");
const { createDirectory: createDirectoryInRoots, listDirectories: listDirectoriesInRoots } = require("./directory-browser");

function readSelections(file) {
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`全局工作区选择存储损坏：${file}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`全局工作区选择存储格式错误：${file}`);
  }
  return parsed;
}

function normalizeSelection(value) {
  if (typeof value === "string" && value.trim()) {
    return { workspaceId: value.trim(), machineId: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const workspaceId = typeof value.workspaceId === "string" && value.workspaceId.trim()
    ? value.workspaceId.trim()
    : null;
  const machineId = typeof value.machineId === "string" && value.machineId.trim()
    ? value.machineId.trim()
    : null;
  const agentId = typeof value.agentId === "string" && value.agentId.trim()
    ? value.agentId.trim()
    : null;
  const mode = typeof value.mode === "string" && value.mode.trim()
    ? value.mode.trim()
    : null;
  const model = typeof value.model === "string" && value.model.trim()
    ? value.model.trim()
    : null;
  const reasoningEffort = typeof value.reasoningEffort === "string" && value.reasoningEffort.trim()
    ? value.reasoningEffort.trim()
    : null;
  if (!workspaceId && !machineId && !agentId && !mode && !model && !reasoningEffort) return null;
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(machineId ? { machineId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

function createWorkspaceService({ catalog, dataDir, notes = createInventoryNotes({ dataDir }), gateway = null }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const controlCwd = path.join(dataDir, "alpha-control");
  fs.mkdirSync(controlCwd, { recursive: true });
  const sessionWorkspaceRoot = path.join(dataDir, "alpha-session-workspaces");
  fs.mkdirSync(sessionWorkspaceRoot, { recursive: true });
  const file = path.join(dataDir, "workspace-selections.json");
  const selections = new Map(Object.entries(readSelections(file))
    .map(([sessionId, value]) => [sessionId, normalizeSelection(value)])
    .filter(([, value]) => value));

  function persist() {
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(Object.fromEntries(selections), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function decorateWorkspace(workspace) {
    if (!workspace) return workspace;
    const description = notes.workspaceDescription(workspace.workspaceId);
    return description ? { ...workspace, description } : workspace;
  }

  function customProjects() {
    const machineState = new Map((catalog.listMachines?.() || []).map((machine) => [machine.machineId, machine]));
    return notes.projectRecords().map((project) => {
      const locations = (project.locations || []).map((location) => ({
        ...location,
        online: machineState.has(location.machineId)
          ? machineState.get(location.machineId).online === true
          : location.online === true
      }));
      return decorateWorkspace({
        ...project,
        locations,
        available: locations.some((location) => location.online === true)
      });
    });
  }

  function list(options) {
    const { machineId = null, query = "", includeOffline = true } = options || {};
    const byId = new Map();
    for (const workspace of catalog.listWorkspaces({ includeOffline: true })) {
      byId.set(workspace.workspaceId, decorateWorkspace(workspace));
    }
    for (const workspace of customProjects()) {
      if (!byId.has(workspace.workspaceId)) byId.set(workspace.workspaceId, workspace);
    }
    let rows = [...byId.values()];
    const selectedMachineId = typeof machineId === "string" ? machineId.trim() : "";
    if (selectedMachineId) {
      rows = rows
      .map((workspace) => ({
        ...workspace,
        locations: (workspace.locations || []).filter((location) => location.machineId === selectedMachineId)
      }))
      .filter((workspace) => workspace.locations.length > 0);
    }
    if (!includeOffline) rows = rows.filter((workspace) => workspace.available);
    return searchWorkspaces(rows, query).map((row) => row.workspace);
  }

  function machines() {
    if (typeof catalog.listMachines !== "function") return [];
    const agents = typeof catalog.listAgents === "function" ? catalog.listAgents() : [];
    return catalog.listMachines()
      .map((machine) => {
        const machineAgents = agents.filter((agent) => agent.machineId === machine.machineId);
        const machineWorkspaces = list({ machineId: machine.machineId, includeOffline: true });
        const description = notes.machineDescription(machine.machineId);
        return {
          ...machine,
          ...(description ? { description } : {}),
          projects: machineWorkspaces,
          agentCount: machineAgents.length,
          onlineAgentCount: machineAgents.filter((agent) => agent.available === true).length,
          online: machine.online === true
        };
      })
      .sort((left, right) => Number(right.online) - Number(left.online) || left.machineId.localeCompare(right.machineId));
  }

  function get(workspaceId) {
    const workspace = list({ query: workspaceId }).find((row) => row.workspaceId === workspaceId);
    if (workspace) return workspace;
    return catalog.getWorkspace(workspaceId);
  }

  function inventory() {
    const agents = typeof catalog.listAgents === "function" ? catalog.listAgents() : [];
    const providers = new Set([...Object.keys(notes.defaults), ...agents.map((agent) => agent.provider)]);
    return {
      machines: machines(),
      workspaces: list({ includeOffline: true }),
      agents,
      agentTypes: [...providers].sort().map((provider) => ({
        provider,
        description: notes.agentDescription({ provider }),
        agents: agents.filter((agent) => agent.provider === provider)
      }))
    };
  }

  function updateMachineDescription(machineId, description) {
    if (!machineById(machineId)) {
      const error = new Error(`目录中不存在工作机：${machineId}`);
      error.statusCode = 404;
      throw error;
    }
    return { machineId, description: notes.updateMachine(machineId, description) };
  }

  function updateWorkspaceDescription(workspaceId, description) {
    const workspace = get(workspaceId);
    return { workspaceId, description: notes.updateWorkspace(workspace.workspaceId, description) };
  }

  function updateAgentDescription({ agentId = "", provider = "", description = "" } = {}) {
    const providerId = String(provider || "").trim();
    const agentIdValue = String(agentId || "").trim();
    if (providerId) {
      const agent = typeof catalog.listAgents === "function"
        ? catalog.listAgents().find((candidate) => candidate.provider === providerId)
        : null;
      if (!agent && !notes.defaults[providerId]) {
        const error = new Error(`目录中不存在 Agent 类型：${providerId}`);
        error.statusCode = 404;
        throw error;
      }
      return { provider: providerId, description: notes.updateAgent(providerId, description) };
    }
    const agent = typeof catalog.getAgent === "function" ? catalog.getAgent(agentIdValue) : null;
    if (!agent) {
      const error = new Error(`目录中不存在 agent：${agentIdValue}`);
      error.statusCode = 404;
      throw error;
    }
    return { agentId: agentIdValue, description: notes.updateAgent(agentIdValue, description) };
  }

  function machineById(machineId) {
    return (catalog.listMachines?.() || []).find((machine) => machine.machineId === String(machineId || "").trim()) || null;
  }

  async function listDirectories({ machineId, currentPath = null } = {}) {
    const id = String(machineId || "").trim();
    const machine = machineById(id);
    if (!machine) {
      const error = new Error(`目录中不存在工作机：${id || "（空）"}`);
      error.statusCode = 404;
      throw error;
    }
    if (id === catalog.machineId) {
      return { machineId: id, ...listDirectoriesInRoots({ allowedRoots: machine.allowedRoots, currentPath }) };
    }
    if (!gateway?.listDirectories) {
      const error = new Error(`远端工作机 ${id} 没有可用的目录浏览通道`);
      error.statusCode = 503;
      throw error;
    }
    return { machineId: id, ...(await gateway.listDirectories({ machineId: id, path: currentPath })) };
  }

  async function createDirectory({ machineId, parentPath, name } = {}) {
    const id = String(machineId || "").trim();
    const machine = machineById(id);
    if (!machine) {
      const error = new Error(`目录中不存在工作机：${id || "（空）"}`);
      error.statusCode = 404;
      throw error;
    }
    if (id === catalog.machineId) {
      return { machineId: id, entry: createDirectoryInRoots({ allowedRoots: machine.allowedRoots, parentPath, name }) };
    }
    if (!gateway?.createDirectory) {
      const error = new Error(`远端工作机 ${id} 没有可用的新建目录通道`);
      error.statusCode = 503;
      throw error;
    }
    return { machineId: id, entry: await gateway.createDirectory({ machineId: id, parentPath, name }) };
  }

  function machineAgentsFor(machineId) {
    return typeof catalog.listAgents === "function"
      ? catalog.listAgents().filter((agent) => agent.machineId === machineId)
      : [];
  }

  function createProject({ machineId, name, projectPath, repoUrl = null, branch = null, description = "" } = {}) {
    const targetMachineId = String(machineId || "").trim();
    const machine = machines().find((row) => row.machineId === targetMachineId);
    if (!machine) {
      const error = new Error(`目录中不存在工作机：${targetMachineId || "（空）"}`);
      error.statusCode = 404;
      throw error;
    }
    const rawPath = String(projectPath || "").trim();
    if (!rawPath) {
      const error = new Error("新建项目必须提供项目路径");
      error.statusCode = 400;
      throw error;
    }
    const normalizedRepo = normalizeRepoUrl(repoUrl || "");
    let normalizedPath;
    if (targetMachineId === catalog.machineId) {
      normalizedPath = openOrCreateProjectPath(rawPath, {
        create: true,
        allowedRoots: machine.allowedRoots || catalog.machine().allowedRoots
      });
    } else {
      normalizedPath = path.resolve(rawPath);
      const roots = (machine.allowedRoots || []).map((root) => path.resolve(root));
      if (!roots.some((root) => isInside(normalizedPath, root))) {
        const error = new Error(`项目路径不在工作机 ${targetMachineId} 的 allowed roots 内：${normalizedPath}`);
        error.statusCode = 400;
        throw error;
      }
    }
    const projectName = String(name || path.basename(normalizedPath)).trim();
    if (!projectName) {
      const error = new Error("新建项目必须提供项目名称");
      error.statusCode = 400;
      throw error;
    }
    const identity = `${targetMachineId}\0${normalizedPath}\0${normalizedRepo || projectName}`;
    const workspaceId = `project-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
    const existing = list({ includeOffline: true }).find((workspace) =>
      workspace.locations?.some((location) => location.machineId === targetMachineId && location.path === normalizedPath)
    );
    if (existing) {
      notes.updateWorkspace(existing.workspaceId, description);
      return get(existing.workspaceId);
    }
    const project = {
      workspaceId,
      name: projectName,
      ...(normalizedRepo ? { repoUrl: normalizedRepo } : {}),
      locations: [{
        machineId: targetMachineId,
        path: normalizedPath,
        online: machine.online === true,
        providers: machineAgentsFor(targetMachineId).map((agent) => agent.provider).filter(Boolean),
        ...(branch ? { branch: String(branch).trim() } : {})
      }],
      available: machine.online === true
    };
    notes.saveProject(project);
    notes.updateWorkspace(workspaceId, normalizeDescription(description));
    return get(workspaceId);
  }

  function selection(sessionId) {
    const value = selections.get(String(sessionId || ""));
    if (!value) return { workspaceId: null, machineId: null, workspace: null };
    let workspace = null;
    if (value.workspaceId) {
      try {
        workspace = get(value.workspaceId);
      } catch {
        // 保留 machineId，即使旧 workspace 已从目录消失，也不丢机器约束。
      }
    }
    return { ...value, workspace };
  }

  function selected(sessionId) {
    return selection(sessionId).workspace;
  }

  function selectedMachineId(sessionId) {
    return selection(sessionId).machineId;
  }

  function select(sessionId, selectionOrWorkspaceId = {}, legacyMachineId = null) {
    const id = String(sessionId || "").trim();
    if (!id) {
      const error = new Error("选择全局工作区必须提供 sessionId");
      error.statusCode = 400;
      throw error;
    }
    const selectionInput = typeof selectionOrWorkspaceId === "string"
      ? { workspaceId: selectionOrWorkspaceId, machineId: legacyMachineId }
      : (selectionOrWorkspaceId || {});
    if (selectionOrWorkspaceId === null) {
      selections.delete(id);
      persist();
      return { sessionId: id, workspace: null, machineId: null };
    }
    const normalizedWorkspaceId = typeof selectionInput.workspaceId === "string" ? selectionInput.workspaceId.trim() : "";
    const normalizedMachineId = typeof selectionInput.machineId === "string" ? selectionInput.machineId.trim() : "";
    const normalizedAgentId = typeof selectionInput.agentId === "string" ? selectionInput.agentId.trim() : "";
    const normalizedMode = typeof selectionInput.mode === "string" ? selectionInput.mode.trim() : "";
    const normalizedModel = typeof selectionInput.model === "string" ? selectionInput.model.trim() : "";
    const normalizedReasoningEffort = typeof selectionInput.reasoningEffort === "string" ? selectionInput.reasoningEffort.trim() : "";
    let workspace = null;
    if (normalizedWorkspaceId) {
      workspace = get(normalizedWorkspaceId);
      if (normalizedMachineId && !workspace.locations.some((location) => location.machineId === normalizedMachineId)) {
        const error = new Error(`工作区 ${workspace.name} 不在工作机 ${normalizedMachineId} 上`);
        error.statusCode = 409;
        throw error;
      }
    }
    if (!normalizedWorkspaceId && !normalizedMachineId && !normalizedAgentId && !normalizedMode && !normalizedModel && !normalizedReasoningEffort) {
      selections.delete(id);
      persist();
      return { sessionId: id, workspace: null, machineId: null };
    }
    if (normalizedAgentId) {
      const agent = typeof catalog.getAgent === "function" ? catalog.getAgent(normalizedAgentId) : null;
      if (!agent) {
        const error = new Error(`全局目录不存在 agent：${normalizedAgentId}`);
        error.statusCode = 404;
        throw error;
      }
      if (normalizedMachineId && agent.machineId !== normalizedMachineId) {
        const error = new Error(`agent ${normalizedAgentId} 不属于工作机 ${normalizedMachineId}`);
        error.statusCode = 409;
        throw error;
      }
      if (workspace && !workspace.locations.some((location) => location.machineId === agent.machineId)) {
        const error = new Error(`agent ${normalizedAgentId} 不在工作区 ${workspace.name} 的可选机器范围内`);
        error.statusCode = 409;
        throw error;
      }
    }
    selections.set(id, {
      ...(workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
      ...(normalizedMachineId ? { machineId: normalizedMachineId } : {}),
      ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
      ...(normalizedMode ? { mode: normalizedMode } : {}),
      ...(normalizedModel ? { model: normalizedModel } : {}),
      ...(normalizedReasoningEffort ? { reasoningEffort: normalizedReasoningEffort } : {})
    });
    persist();
    return {
      sessionId: id,
      workspace,
      machineId: normalizedMachineId || null,
      agentId: normalizedAgentId || null,
      mode: normalizedMode || null,
      model: normalizedModel || null,
      reasoningEffort: normalizedReasoningEffort || null
    };
  }

  function resolve({ sessionId, workspaceId, machineId }) {
    const saved = selection(sessionId);
    const effectiveMachineId = machineId === undefined
      ? saved.machineId
      : (typeof machineId === "string" && machineId.trim() ? machineId.trim() : null);
    if (saved.workspace) {
      return { ...saved, workspace: saved.workspace, machineId: effectiveMachineId, source: "session", ambiguous: [] };
    }
    if (workspaceId) {
      return {
        workspace: get(workspaceId),
        machineId: effectiveMachineId,
        ...(saved.agentId ? { agentId: saved.agentId } : {}),
        ...(saved.mode ? { mode: saved.mode } : {}),
        ...(saved.model ? { model: saved.model } : {}),
        ...(saved.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}),
        source: "explicit",
        ambiguous: []
      };
    }
    return {
      workspace: null,
      machineId: effectiveMachineId,
      ...(saved.agentId ? { agentId: saved.agentId } : {}),
      ...(saved.mode ? { mode: saved.mode } : {}),
      ...(saved.model ? { model: saved.model } : {}),
      ...(saved.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}),
      source: "none",
      ambiguous: []
    };
  }

  function sessionTarget({ machineId = null, workspaceId = null } = {}) {
    const normalizedMachineId = typeof machineId === "string" && machineId.trim() ? machineId.trim() : null;
    if (!normalizedMachineId && !workspaceId) {
      return { cwd: controlCwd, title: "Alpha 主控", machineId: null, workspaceId: null, targetPath: null };
    }
    const workspace = workspaceId ? get(workspaceId) : null;
    const location = workspace?.locations?.find((item) => item.machineId === normalizedMachineId)
      || workspace?.locations?.find((item) => item.online)
      || workspace?.locations?.[0]
      || null;
    const targetPath = location?.path || null;
    const targetMachineId = normalizedMachineId || location?.machineId || null;
    const identity = `${targetMachineId || "auto"}\0${targetPath || workspace?.workspaceId || "auto"}`;
    const suffix = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20);
    const cwd = path.join(sessionWorkspaceRoot, suffix);
    fs.mkdirSync(cwd, { recursive: true });
    const label = targetPath || workspace?.name || "自动工作目录";
    const title = `${targetMachineId || "自动选机"} · ${label}`.slice(0, 180);
    return {
      cwd,
      title,
      machineId: targetMachineId,
      workspaceId: workspace?.workspaceId || null,
      targetPath
    };
  }

  return {
    file,
    controlCwd,
    list,
    machines,
    get,
    selection,
    selected,
    selectedMachineId,
    select,
    resolve,
    sessionTarget,
    inventory,
    updateMachineDescription,
    updateWorkspaceDescription,
    updateAgentDescription,
    listDirectories,
    createDirectory,
    createProject,
    notes
  };
}

module.exports = { createWorkspaceService };
