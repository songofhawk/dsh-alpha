// 任务存储：SQLite/WAL。任务快照按行更新，事件逐条插入并按数量/体积保留窗口；
// 首次启动自动迁移旧版 tasks.json。
// 记录字段：
//   id, sessionId, agentId, machineId, provider, prompt, projectPath, settings,
//   status(queued|running|blocked|completed|failed|cancelled),
//   createdAt, updatedAt, events[], result, usage, artifacts[], error

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const TASK_STATES = new Set(["queued", "running", "blocked", "completed", "failed", "cancelled"]);
const ACTIVE_TASK_STATES = new Set(["queued", "running", "blocked"]);
const DEFAULT_LIMITS = Object.freeze({
  eventStringBytes: 32 * 1024,
  eventBytes: 64 * 1024,
  activeEventCount: 500,
  activeEventBytes: 1024 * 1024,
  terminalEventCount: 120,
  terminalEventBytes: 256 * 1024,
  streamTextBytes: 2 * 1024 * 1024,
  resultBytes: 2 * 1024 * 1024,
  promptBytes: 256 * 1024
});

function sliceUtf8(value, maxBytes, fromEnd = false) {
  const source = Buffer.from(String(value || ""));
  if (source.length <= maxBytes) return source.toString("utf8");
  const chunk = fromEnd ? source.subarray(source.length - maxBytes) : source.subarray(0, maxBytes);
  return chunk.toString("utf8").replace(fromEnd ? /^\uFFFD/ : /\uFFFD$/, "");
}

function truncateUtf8(value, maxBytes, label = "内容") {
  const text = String(value || "");
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return text;
  const marker = `\n…[${label}已截断，原始 ${bytes} bytes]`;
  return `${sliceUtf8(text, Math.max(0, maxBytes - Buffer.byteLength(marker)))}${marker}`;
}

function appendBoundedUtf8(current, addition, maxBytes) {
  const combined = `${current || ""}${addition || ""}`;
  if (Buffer.byteLength(combined) <= maxBytes) return combined;
  const marker = "\n…[中间输出已截断]…\n";
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(marker));
  const headBytes = Math.floor(remaining / 2);
  return `${sliceUtf8(combined, headBytes)}${marker}${sliceUtf8(combined, remaining - headBytes, true)}`;
}

function compactValue(value, limits, depth = 0) {
  if (typeof value === "string") return truncateUtf8(value, limits.eventStringBytes);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[结构过深，已截断]";
  if (Array.isArray(value)) {
    const rows = value.slice(0, 64).map((item) => compactValue(item, limits, depth + 1));
    if (value.length > rows.length) rows.push(`[另有 ${value.length - rows.length} 项已截断]`);
    return rows;
  }
  const out = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, 64)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    out[key] = compactValue(item, limits, depth + 1);
  }
  if (entries.length > 64) out.__truncated_keys__ = entries.length - 64;
  return out;
}

function compactEvent(event, limits) {
  const compacted = compactValue(event && typeof event === "object" ? event : { type: "activity", payload: event }, limits);
  const bytes = Buffer.byteLength(JSON.stringify(compacted));
  if (bytes <= limits.eventBytes) return compacted;

  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const summary = {};
  for (const key of ["kind", "tool_use_id", "tool_name", "is_error", "exit_code", "reason", "decision", "status"]) {
    if (payload[key] !== undefined) summary[key] = compactValue(payload[key], limits);
  }
  const textKey = ["content", "text", "message", "command"].find((key) => typeof payload[key] === "string");
  if (textKey) summary[textKey] = truncateUtf8(payload[textKey], Math.floor(limits.eventBytes / 2), "事件内容");
  summary.truncated = true;
  summary.originalBytes = bytes;
  const summarized = {
    type: typeof event?.type === "string" ? event.type : "activity",
    payload: summary,
    ...(event?.ts !== undefined ? { ts: event.ts } : {})
  };
  if (Buffer.byteLength(JSON.stringify(summarized)) <= limits.eventBytes) return summarized;
  return {
    type: typeof event?.type === "string" ? truncateUtf8(event.type, 32) : "activity",
    payload: { truncated: true, originalBytes: bytes },
    ...(event?.ts !== undefined ? { ts: event.ts } : {})
  };
}

function createId(prefix) {
  return `${prefix || "task"}-${crypto.randomUUID()}`;
}

function createTaskStore({ dataDir, limits: limitOverrides = {} }) {
  const file = path.join(dataDir, "tasks.sqlite3");
  const legacyJsonFile = path.join(dataDir, "tasks.json");
  const legacyBackupFile = `${legacyJsonFile}.pre-sqlite-v1.bak`;
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  let tasks = {};
  const listeners = new Map(); // taskId -> Set<(record) => void>
  const eventSizes = new WeakMap();
  let closed = false;

  fs.mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(file, { timeout: 5_000 });
  fs.chmodSync(file, 0o600);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      event_json TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS task_events_task_id_id
      ON task_events(task_id, id);
  `);

  const statements = {
    taskCount: database.prepare("SELECT COUNT(*) AS count FROM tasks"),
    listTasks: database.prepare("SELECT id, status, record_json FROM tasks ORDER BY created_at DESC"),
    listEvents: database.prepare("SELECT event_json FROM task_events WHERE task_id = ? ORDER BY id"),
    upsertTask: database.prepare(`
      INSERT INTO tasks(id, status, created_at, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `),
    insertEvent: database.prepare(`
      INSERT INTO task_events(task_id, event_json, byte_size, created_at)
      VALUES (?, ?, ?, ?)
    `),
    pruneEventCount: database.prepare(`
      DELETE FROM task_events
      WHERE task_id = ?
        AND id NOT IN (
          SELECT id FROM task_events
          WHERE task_id = ?
          ORDER BY id DESC
          LIMIT ?
        )
    `),
    pruneEventBytes: database.prepare(`
      DELETE FROM task_events
      WHERE task_id = ?
        AND id IN (
          SELECT id FROM (
            SELECT id, SUM(byte_size) OVER (ORDER BY id DESC) AS running_bytes
            FROM task_events
            WHERE task_id = ?
          )
          WHERE running_bytes > ?
        )
    `)
  };

  try {
    migrateLegacyJson();
    load();
  } catch (error) {
    database.close();
    throw error;
  }

  function notify(record) {
    for (const listener of listeners.get(record.id) || []) {
      try { listener(record); } catch { /* 观察者不能破坏任务落库 */ }
    }
  }

  function withTransaction(callback) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* 保留原始数据库异常 */ }
      throw error;
    }
  }

  function normalizeRecord(record, fallbackId = null) {
    const now = Date.now();
    record.id = String(record.id || fallbackId || createId());
    record.status = TASK_STATES.has(record.status) ? record.status : "failed";
    record.createdAt = Number(record.createdAt) || now;
    record.updatedAt = Number(record.updatedAt) || record.createdAt;
    if (record.lastHeartbeatAt !== null && record.lastHeartbeatAt !== undefined) {
      record.lastHeartbeatAt = Number(record.lastHeartbeatAt) || record.updatedAt;
    }
    compactTask(record);
    return record;
  }

  function serializeRecord(record) {
    const { events: _events, streamedText: _streamedText, ...snapshot } = record;
    return JSON.stringify(snapshot);
  }

  function persistRecord(record) {
    statements.upsertTask.run(
      record.id,
      record.status,
      record.createdAt,
      record.updatedAt,
      serializeRecord(record)
    );
  }

  function insertEvent(taskId, event) {
    const serialized = JSON.stringify(event);
    statements.insertEvent.run(
      taskId,
      serialized,
      Buffer.byteLength(serialized),
      Number(event.ts) || Date.now()
    );
  }

  function prunePersistedEvents(record) {
    const active = ACTIVE_TASK_STATES.has(record.status);
    const countLimit = active ? limits.activeEventCount : limits.terminalEventCount;
    const byteLimit = active ? limits.activeEventBytes : limits.terminalEventBytes;
    statements.pruneEventCount.run(record.id, record.id, countLimit);
    statements.pruneEventBytes.run(record.id, record.id, byteLimit);
  }

  function migrateLegacyJson() {
    if (Number(statements.taskCount.get().count) > 0 || !fs.existsSync(legacyJsonFile)) return;
    try {
      fs.copyFileSync(legacyJsonFile, legacyBackupFile, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(legacyBackupFile, 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    let records;
    try {
      records = JSON.parse(fs.readFileSync(legacyJsonFile, "utf8"));
      if (!records || Array.isArray(records) || typeof records !== "object") {
        throw new Error("任务存储根节点必须是对象");
      }
    } catch (error) {
      const wrapped = new Error(`读取任务存储失败：${legacyJsonFile}：${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    }

    withTransaction(() => {
      for (const [taskId, source] of Object.entries(records)) {
        const record = normalizeRecord(source, taskId);
        persistRecord(record);
        for (const event of record.events) insertEvent(record.id, event);
      }
    });
    fs.unlinkSync(legacyJsonFile);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  function load() {
    tasks = {};
    try {
      for (const row of statements.listTasks.all()) {
        const record = normalizeRecord(JSON.parse(row.record_json), row.id);
        record.status = row.status;
        record.events = statements.listEvents.all(row.id).map((eventRow) => {
          const event = compactEvent(JSON.parse(eventRow.event_json), limits);
          eventSizes.set(event, Buffer.byteLength(JSON.stringify(event)));
          return event;
        });
        trimEvents(record);
        tasks[record.id] = record;
      }
    } catch (error) {
      const wrapped = new Error(`读取任务存储失败：${file}：${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  function assertWritable() {
    if (closed) throw new Error("任务存储已关闭");
  }

  function trimEvents(record) {
    if (!Array.isArray(record.events)) record.events = [];
    const active = ACTIVE_TASK_STATES.has(record.status);
    const countLimit = active ? limits.activeEventCount : limits.terminalEventCount;
    const byteLimit = active ? limits.activeEventBytes : limits.terminalEventBytes;
    let totalBytes = 0;
    let keepFrom = record.events.length;
    for (let index = record.events.length - 1; index >= 0; index -= 1) {
      const event = record.events[index];
      const bytes = eventSizes.get(event) || Buffer.byteLength(JSON.stringify(event));
      eventSizes.set(event, bytes);
      if (record.events.length - index > countLimit || totalBytes + bytes > byteLimit) break;
      totalBytes += bytes;
      keepFrom = index;
    }
    if (keepFrom > 0) {
      record.eventsDropped = Math.max(0, Number(record.eventsDropped) || 0) + keepFrom;
      record.events.splice(0, keepFrom);
    }
  }

  function compactTask(record) {
    if (!record || typeof record !== "object") return;
    record.prompt = truncateUtf8(record.prompt, limits.promptBytes, "任务描述");
    if (typeof record.result === "string") record.result = truncateUtf8(record.result, limits.resultBytes, "任务结果");
    if (typeof record.error === "string") record.error = truncateUtf8(record.error, limits.eventStringBytes, "错误信息");
    if (typeof record.streamedText === "string") {
      record.streamedText = appendBoundedUtf8("", record.streamedText, limits.streamTextBytes);
    }
    if (Array.isArray(record.events)) {
      for (let index = 0; index < record.events.length; index += 1) {
        const compacted = compactEvent(record.events[index], limits);
        eventSizes.set(compacted, Buffer.byteLength(JSON.stringify(compacted)));
        record.events[index] = compacted;
      }
    } else {
      record.events = [];
    }
    trimEvents(record);
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
    persistRecord(record);
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
    assertWritable();
    const record = getTask(taskId);
    Object.assign(record, patch, { updatedAt: Date.now() });
    compactTask(record);
    withTransaction(() => {
      persistRecord(record);
      prunePersistedEvents(record);
    });
    notify(record);
    return record;
  }

  function setStatus(taskId, status, extra = {}) {
    if (!TASK_STATES.has(status)) throw new Error(`非法任务状态：${status}`);
    return update(taskId, { status, ...extra });
  }

  function appendEvent(taskId, event) {
    assertWritable();
    const record = getTask(taskId);
    const now = Date.now();
    if (event?.type === "delta" && typeof event.payload?.text === "string") {
      record.streamedText = appendBoundedUtf8(record.streamedText, event.payload.text, limits.streamTextBytes);
    }
    const compacted = compactEvent({
      ...event,
      ts: now
    }, limits);
    eventSizes.set(compacted, Buffer.byteLength(JSON.stringify(compacted)));
    record.events.push(compacted);
    trimEvents(record);
    record.updatedAt = now;
    record.lastHeartbeatAt = now;
    withTransaction(() => {
      persistRecord(record);
      insertEvent(record.id, compacted);
      prunePersistedEvents(record);
    });
    notify(record);
    return record;
  }

  function touchHeartbeat(taskId, at = Date.now()) {
    assertWritable();
    const record = getTask(taskId);
    record.lastHeartbeatAt = Number(at) || Date.now();
    // 重启后所有非终态任务都会被 recoverInterrupted 收敛；因此心跳只需服务
    // 当前进程的租约判断，不需要产生一次 SQLite 写事务。
    notify(record);
    return record;
  }

  function setResult(taskId, { message, usage = null, artifacts = [] }) {
    return update(taskId, { result: message, usage, artifacts, streamedText: null });
  }

  // 进程重启后把残留的进行中任务收敛为 failed（沿用 agent-anywhere recoverInterruptedRuns）
  function recoverInterrupted() {
    const interrupted = Object.values(tasks).filter((record) => ACTIVE_TASK_STATES.has(record.status));
    if (!interrupted.length) return;
    withTransaction(() => {
      for (const record of interrupted) {
        record.status = "failed";
        record.error = "进程重启导致任务中断";
        record.updatedAt = Date.now();
        compactTask(record);
        persistRecord(record);
        prunePersistedEvents(record);
      }
    });
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

  function flush() {
    assertWritable();
    database.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  function close() {
    if (closed) return;
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close();
    closed = true;
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
    recoverInterrupted,
    flush,
    close
  };
}

module.exports = { createTaskStore, createId, TASK_STATES, DEFAULT_LIMITS };
