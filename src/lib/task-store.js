// 任务存储：JSON 全量读写（沿用 agent-anywhere JsonStore 风格）。
// 记录字段：
//   id, agentId, machineId, provider, prompt, projectPath, settings,
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
  load();

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

  function createTask({ agentId, machineId, provider, prompt, projectPath, settings, repoUrl = null, repoCloneUrl = null, needsClone = false, recursion = null }) {
    const now = Date.now();
    const record = {
      id: createId(),
      agentId,
      machineId,
      provider,
      prompt,
      projectPath,
      settings,
      repoUrl,
      repoCloneUrl,
      needsClone,
      recursion,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      events: [],
      result: null,
      usage: null,
      artifacts: [],
      error: null
    };
    tasks[record.id] = record;
    save();
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

  function update(taskId, patch) {
    const record = getTask(taskId);
    Object.assign(record, patch, { updatedAt: Date.now() });
    save();
    return record;
  }

  function setStatus(taskId, status, extra = {}) {
    if (!TASK_STATES.has(status)) throw new Error(`非法任务状态：${status}`);
    return update(taskId, { status, ...extra });
  }

  function appendEvent(taskId, event) {
    const record = getTask(taskId);
    record.events.push({
      ...event,
      ts: Date.now()
    });
    record.updatedAt = Date.now();
    save();
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

  return {
    file,
    ids: Object.keys(tasks),
    createTask,
    getTask,
    listTasks,
    update,
    setStatus,
    appendEvent,
    setResult,
    recoverInterrupted
  };
}

module.exports = { createTaskStore, createId, TASK_STATES };
