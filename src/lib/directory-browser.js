// 受控目录浏览：所有路径必须落在对应机器广播的 allowed roots 内。

const fs = require("node:fs");
const path = require("node:path");
const { isInside, resolveProjectPath } = require("../adapters/vendor/shared/path-policy");

function normalizedRoots(allowedRoots) {
  return (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots])
    .filter(Boolean)
    .map((root) => path.resolve(String(root)));
}

function invalid(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function ensureDirectory(rawPath, roots, { createRoot = false } = {}) {
  const resolved = path.resolve(String(rawPath || ""));
  const isRoot = roots.includes(resolved);
  if (createRoot && isRoot) fs.mkdirSync(resolved, { recursive: true });
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    invalid(`目录不存在：${resolved}`, 404);
  }
  return resolveProjectPath(resolved, roots);
}

function listDirectories({ allowedRoots, currentPath = null } = {}) {
  const roots = normalizedRoots(allowedRoots);
  if (!roots.length) invalid("机器没有配置 allowed roots", 409);
  if (!currentPath) {
    return {
      currentPath: null,
      parentPath: null,
      entries: roots.map((root) => ({ name: path.basename(root) || root, path: root, isRoot: true }))
    };
  }
  const current = ensureDirectory(currentPath, roots, { createRoot: true });
  const root = roots.find((candidate) => candidate === current || isInside(current, candidate));
  const parentPath = root && current !== root ? path.dirname(current) : null;
  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: path.join(current, entry.name), isRoot: false }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    invalid(`无法读取目录：${current}（${error.message}）`, 403);
  }
  return { currentPath: current, parentPath, entries };
}

function createDirectory({ allowedRoots, parentPath, name } = {}) {
  const roots = normalizedRoots(allowedRoots);
  if (!roots.length) invalid("机器没有配置 allowed roots", 409);
  const directoryName = String(name || "").trim();
  if (!directoryName || directoryName === "." || directoryName === ".." || path.basename(directoryName) !== directoryName) {
    invalid("目录名称只能包含一个安全的目录名");
  }
  const parent = ensureDirectory(parentPath || roots[0], roots, { createRoot: true });
  const target = resolveProjectPath(path.join(parent, directoryName), roots);
  if (fs.existsSync(target)) invalid(`目录已存在：${target}`, 409);
  fs.mkdirSync(target);
  return { name: directoryName, path: target, isRoot: false };
}

module.exports = { createDirectory, listDirectories };
