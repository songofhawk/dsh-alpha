// Alpha 主控的可编辑目录说明：与实时机器/工作区/Agent 状态分离保存。
// 说明会被目录工具和 Web 管理页共同读取，避免把 UI 文案硬编码在某一端。

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_AGENT_DESCRIPTIONS = Object.freeze({
  codex: "综合能力最强，支持文生图，适合复杂、跨领域和需要多步推理的任务。",
  "claude-code": "总体能力很强；Fable 5 模型更是第一，但可用额度很少，适合高价值复杂任务。",
  "kimi-code": "审美和中文表达非常好，适合视觉、内容、交互和中文产品任务。",
  dsh: "性价比很高；不是特别复杂的任务优先交给它，可以节省额度。",
  "dsh-master": "Alpha 主控的递归控制器，只用于拆分和转派控制任务，不直接执行普通项目任务。",
  opencode: "通用代码 Agent，适合常规开发和快速验证。",
  qoder: "通用代码 Agent，适合常规工程修改和实现。",
  workbuddy: "通用代码 Agent，适合中文场景下的日常工程任务。"
});

function normalizeDescription(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, 4_000);
}

function emptyState() {
  return { machines: {}, workspaces: {}, agents: {}, projects: {} };
}

function readState(file) {
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
    return {
      machines: parsed.machines && typeof parsed.machines === "object" ? parsed.machines : {},
      workspaces: parsed.workspaces && typeof parsed.workspaces === "object" ? parsed.workspaces : {},
      agents: parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {},
      projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {}
    };
  } catch (error) {
    throw new Error(`Alpha 主控目录说明存储损坏：${file}`, { cause: error });
  }
}

function createInventoryNotes({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "inventory-notes.json");
  const state = readState(file);

  function persist() {
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function get(kind, id) {
    return normalizeDescription(state[kind]?.[String(id)]);
  }

  function set(kind, id, description) {
    const key = String(id || "").trim();
    if (!key) {
      const error = new Error("目录说明必须提供稳定 ID");
      error.statusCode = 400;
      throw error;
    }
    const value = normalizeDescription(description);
    if (value) state[kind][key] = value;
    else delete state[kind][key];
    persist();
    return value;
  }

  function agentDescription({ agentId, provider }) {
    const custom = get("agents", agentId);
    if (custom) return custom;
    return get("agents", provider) || DEFAULT_AGENT_DESCRIPTIONS[String(provider || "").trim()] || "";
  }

  function projectRecords() {
    return Object.values(state.projects).map((project) => ({
      ...project,
      locations: Array.isArray(project.locations) ? project.locations.map((location) => ({ ...location })) : []
    }));
  }

  function saveProject(project) {
    const workspaceId = String(project?.workspaceId || "").trim();
    if (!workspaceId) {
      const error = new Error("新建项目必须提供 workspaceId");
      error.statusCode = 400;
      throw error;
    }
    state.projects[workspaceId] = JSON.parse(JSON.stringify(project));
    persist();
    return state.projects[workspaceId];
  }

  return {
    file,
    defaults: DEFAULT_AGENT_DESCRIPTIONS,
    machineDescription(machineId) {
      return get("machines", machineId);
    },
    workspaceDescription(workspaceId) {
      return get("workspaces", workspaceId);
    },
    agentDescription,
    updateMachine(machineId, description) {
      return set("machines", machineId, description);
    },
    updateWorkspace(workspaceId, description) {
      return set("workspaces", workspaceId, description);
    },
    updateAgent(agentId, description) {
      return set("agents", agentId, description);
    },
    projectRecords,
    saveProject,
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    }
  };
}

module.exports = { DEFAULT_AGENT_DESCRIPTIONS, createInventoryNotes, normalizeDescription };
