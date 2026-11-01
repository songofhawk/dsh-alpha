// Outbox：先落库后投递（docs/superagent-design.md 第 5、6.1 节）。
// enqueue 先把记录写入 outbox 表（dedupe_key 唯一，重复写入幂等返回已有行），
// drain 再按 next_attempt_at 取出投递：成功写 done_at，失败 attempts+1 并指数退避。
// 因为先落库，进程崩溃后重建实例再 drain 即可从未完成记录恢复（重放）。

const crypto = require("node:crypto");
const { runMigrations } = require("./task-store.js");

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60 * 1_000;

function mapEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    doneAt: row.done_at,
    createdAt: row.created_at
  };
}

function createOutbox({ database, now = Date.now, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS }) {
  if (!database) throw new Error("createOutbox 需要注入共享的 database");
  // 幂等，保证单独构造本模块时 outbox 表已就绪。
  runMigrations(database);

  const statements = {
    insert: database.prepare(`
      INSERT INTO outbox(id, kind, dedupe_key, payload_json, attempts, next_attempt_at, done_at, created_at)
      VALUES (?, ?, ?, ?, 0, ?, NULL, ?)
      ON CONFLICT(dedupe_key) DO NOTHING
    `),
    byDedupeKey: database.prepare("SELECT * FROM outbox WHERE dedupe_key = ?"),
    due: database.prepare(`
      SELECT * FROM outbox
      WHERE done_at IS NULL AND next_attempt_at <= ?
      ORDER BY created_at, id
    `),
    markDone: database.prepare("UPDATE outbox SET done_at = ? WHERE id = ?"),
    markRetry: database.prepare("UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?"),
    pendingCount: database.prepare("SELECT COUNT(*) AS count FROM outbox WHERE done_at IS NULL")
  };

  // 幂等：同一 dedupeKey 只落一行；返回 { entry, created }。
  function enqueue({ kind, dedupeKey, payload = {} }) {
    if (!kind || !dedupeKey) throw new Error("enqueue 需要 kind 和 dedupeKey");
    const ts = now();
    const result = statements.insert.run(
      `out_${crypto.randomUUID()}`,
      String(kind),
      String(dedupeKey),
      JSON.stringify(payload),
      ts,
      ts
    );
    return { entry: mapEntry(statements.byDedupeKey.get(String(dedupeKey))), created: result.changes > 0 };
  }

  // 投递所有到期的未完成记录。deliver 可同步或返回 Promise；抛错视为失败，
  // 按 baseDelayMs * 2^(attempts-1)（封顶 maxDelayMs）安排下一次重试。
  // at 默认取当前时间，测试可注入固定时钟。
  async function drain(deliver, { at = null } = {}) {
    const ts = Number(at) || now();
    const rows = statements.due.all(ts);
    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      const entry = mapEntry(row);
      try {
        await deliver(entry);
        statements.markDone.run(ts, row.id);
        delivered += 1;
      } catch {
        const attempts = row.attempts + 1;
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempts - 1));
        statements.markRetry.run(attempts, ts + delay, row.id);
        failed += 1;
      }
    }
    return { delivered, failed, pending: pending() };
  }

  function pending() {
    return Number(statements.pendingCount.get().count);
  }

  return { enqueue, drain, pending };
}

module.exports = { createOutbox };
