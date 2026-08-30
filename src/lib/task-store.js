// 任务存储：JSON 全量读写（沿用 agent-anywhere JsonStore 风格）。
// 记录字段：
//   id, sessionId, agentId, machineId, provider, prompt, projectPath, settings,
//   status(queued|running|blocked|completed|failed|cancelled),
//   createdAt, updatedAt, events[], result, usage, artifacts[], error

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TASK_STATES = new Set(["queued", "running", "blocked", "completed", "failed", "cancelled"]);

function createId(prefix) {
  return `${prefix || "task"}-${crypto.randomUUID()}`;
}

function createTaskStore({ dataDir }) {
  const file = path.join(dataDir, "tasks.json");
  let tasks = {};
  const listeners = new Map(); // taskId -> Set<(record) => void>
  load();

  function notify(record) {
    for (const listener of listeners.get(record.id) || []) {
      try { listener(record); } catch { /* 观察者不能破坏任务落库 */ }
    }
  }

  function load() {
    try {
      tasks = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!tasks || Array.isArray(tasks) || typeof tasks !== "object") {
        throw new Error("任务存储根节点必须是对象");
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        const wrapped = new Error(`读取任务存储失败：${file}：${error.message}`);
        wrapped.cause = error;
        throw wrapped;
      }
      tasks = {};
    }
  }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(tasks, null, 2));
      fs.renameSync(temp, file);
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  function createTask({ sessionId = null, dispatchKey = null, agentId, machineId, provider, prompt, projectPath, settings, attachments = [], repoUrl = null, repoCloneUrl = null, needsClone = false, recursion = null, workspaceId = null, workspaceName = null, workspaceSource = "none" }) {
    const now = Date.now();
    const record = {
      id: createId(),
      sessionId: sessionId ? String(sessionId) : null,
      dispatchKey: dispatchKey ? String(dispatchKey) : null,
      agentId,
      machineId,
      provider,
      prompt,
      projectPath,
      settings,
      attachments: Array.isArray(attachments) ? attachments : [],
      repoUrl,
      repoCloneUrl,
      needsClone,
      recursion,
      workspaceId,
      workspaceName,
      workspaceSource,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      events: [],
      result: null,
      usage: null,
      artifacts: [],
      error: null
    };
    tasks[record.id] = record;
    save();
    notify(record);
    return record;
  }

  function getTask(taskId) {
    const record = tasks[taskId];
    if (!record) {
      const error = new Error(`任务不存在：${taskId}`);
      error.statusCode = 404;
      throw error;
    }
    return record;
  }

  function listTasks() {
    return Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
  }

  function findByDispatchKey(sessionId, dispatchKey) {
    const session = sessionId ? String(sessionId) : null;
    const key = dispatchKey ? String(dispatchKey) : null;
    if (!key) return null;
    return Object.values(tasks).find((task) => task.sessionId === session && task.dispatchKey === key) || null;
  }

  function update(taskId, patch) {
    const record = getTask(taskId);
    Object.assign(record, patch, { updatedAt: Date.now() });
    save();
    notify(record);
    return record;
  }

  function setStatus(taskId, status, extra = {}) {
    if (!TASK_STATES.has(status)) throw new Error(`非法任务状态：${status}`);
    return update(taskId, { status, ...extra });
  }

  function appendEvent(taskId, event) {
    const record = getTask(taskId);
    const now = Date.now();
    record.events.push({
      ...event,
      ts: now
    });
    record.updatedAt = now;
    record.lastHeartbeatAt = now;
    save();
    notify(record);
    return record;
  }

  function touchHeartbeat(taskId, at = Date.now()) {
    const record = getTask(taskId);
    record.lastHeartbeatAt = Number(at) || Date.now();
    save();
    notify(record);
    return record;
  }

  function setResult(taskId, { message, usage = null, artifacts = [] }) {
    return update(taskId, { result: message, usage, artifacts });
  }

  // 进程重启后把残留的进行中任务收敛为 failed（沿用 agent-anywhere recoverInterruptedRuns）
  function recoverInterrupted() {
    let changed = false;
    for (const record of Object.values(tasks)) {
      if (record.status === "queued" || record.status === "running" || record.status === "blocked") {
        record.status = "failed";
        record.error = "进程重启导致任务中断";
        record.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) save();
  }

  function subscribe(taskId, listener) {
    getTask(taskId);
    let taskListeners = listeners.get(taskId);
    if (!taskListeners) {
      taskListeners = new Set();
      listeners.set(taskId, taskListeners);
    }
    taskListeners.add(listener);
    return () => {
      taskListeners.delete(listener);
      if (!taskListeners.size) listeners.delete(taskId);
    };
  }

  return {
    file,
    ids: Object.keys(tasks),
    createTask,
    getTask,
    listTasks,
    findByDispatchKey,
    update,
    setStatus,
    appendEvent,
    touchHeartbeat,
    setResult,
    subscribe,
    recoverInterrupted
  };
}

module.exports = { createTaskStore, createId, TASK_STATES };
