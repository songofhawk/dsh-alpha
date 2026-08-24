// 全局工作区选择服务：目录来自 catalog，选择按 DSH session 持久化。

const fs = require("node:fs");
const path = require("node:path");
const { resolveWorkspaceFromPrompt } = require("./workspaces");

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

function createWorkspaceService({ catalog, dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const controlCwd = path.join(dataDir, "alpha-control");
  fs.mkdirSync(controlCwd, { recursive: true });
  const file = path.join(dataDir, "workspace-selections.json");
  const selections = new Map(Object.entries(readSelections(file)).filter(([, value]) => typeof value === "string"));

  function persist() {
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(Object.fromEntries(selections), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function list(options) {
    return catalog.listWorkspaces(options);
  }

  function get(workspaceId) {
    return catalog.getWorkspace(workspaceId);
  }

  function selected(sessionId) {
    const workspaceId = selections.get(String(sessionId || ""));
    if (!workspaceId) return null;
    try {
      return get(workspaceId);
    } catch {
      return null;
    }
  }

  function select(sessionId, workspaceId) {
    const id = String(sessionId || "").trim();
    if (!id) {
      const error = new Error("选择全局工作区必须提供 sessionId");
      error.statusCode = 400;
      throw error;
    }
    if (workspaceId === null || workspaceId === undefined || workspaceId === "") {
      selections.delete(id);
      persist();
      return { sessionId: id, workspace: null };
    }
    const workspace = get(String(workspaceId));
    selections.set(id, workspace.workspaceId);
    persist();
    return { sessionId: id, workspace };
  }

  function resolve({ sessionId, workspaceId, prompt }) {
    if (workspaceId) return { workspace: get(workspaceId), source: "explicit", ambiguous: [] };
    const chosen = selected(sessionId);
    if (chosen) return { workspace: chosen, source: "session", ambiguous: [] };
    const automatic = resolveWorkspaceFromPrompt(list({ includeOffline: false }), prompt);
    return {
      workspace: automatic.workspace,
      source: automatic.workspace ? "prompt" : "none",
      ambiguous: automatic.ambiguous
    };
  }

  return { file, controlCwd, list, get, selected, select, resolve };
}

module.exports = { createWorkspaceService };
