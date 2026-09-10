#!/usr/bin/env node
// 部署前读取 Alpha 的持久化任务状态。只输出非终态任务数量，绝不打印任务内容。

import fs from "node:fs";

const ACTIVE_STATES = new Set(["queued", "running", "blocked"]);

export function countActiveTasks(records) {
  if (!records || Array.isArray(records) || typeof records !== "object") {
    throw new Error("任务存储根节点必须是对象");
  }
  return Object.values(records).filter((record) => ACTIVE_STATES.has(record?.status)).length;
}

export function readActiveTaskCount(file) {
  try {
    return countActiveTasks(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function isDirectRun() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const file = process.argv[2];
  if (!file) throw new Error("用法：task-store-active-count.mjs <tasks.json>");
  process.stdout.write(`${readActiveTaskCount(file)}\n`);
}
