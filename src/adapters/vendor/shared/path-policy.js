const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function defaultAllowedRoots() {
  return [path.dirname(process.cwd())];
}

function parseAllowedRoots(raw) {
  const roots = raw
    ? raw.split(",").map((item) => item.trim()).filter(Boolean)
    : defaultAllowedRoots();
  return roots.map((root) => path.resolve(root));
}

function isInside(childPath, rootPath) {
  const relative = path.relative(rootPath, childPath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function expandHome(rawPath) {
  return rawPath.startsWith("~") ? path.join(os.homedir(), rawPath.slice(1)) : rawPath;
}

function nearestExistingAncestor(resolvedPath) {
  let current = resolvedPath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function realpathForPolicy(resolvedPath) {
  const existingAncestor = nearestExistingAncestor(resolvedPath);
  const realAncestor = fs.realpathSync.native(existingAncestor);
  const remainder = path.relative(existingAncestor, resolvedPath);
  return remainder ? path.resolve(realAncestor, remainder) : realAncestor;
}

function realAllowedRoots(allowedRoots) {
  return allowedRoots.map((root) => {
    const resolved = path.resolve(expandHome(root));
    return fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
  });
}

function rejectOutside(resolved) {
  const error = new Error(`项目路径不在允许根目录内：${resolved}`);
  error.statusCode = 400;
  throw error;
}

function resolveProjectPath(rawPath, allowedRoots = parseAllowedRoots(process.env.AGENT_ANYWHERE_ALLOWED_ROOTS)) {
  if (!rawPath || typeof rawPath !== "string") {
    const error = new Error("项目路径不能为空。");
    error.statusCode = 400;
    throw error;
  }

  const expanded = expandHome(rawPath);
  const resolved = path.resolve(expanded);
  const allowed = allowedRoots.some((root) => isInside(resolved, root));

  if (!allowed) {
    rejectOutside(resolved);
  }

  const realResolved = realpathForPolicy(resolved);
  const realAllowed = realAllowedRoots(allowedRoots).some((root) => isInside(realResolved, root));

  if (!realAllowed) {
    rejectOutside(resolved);
  }

  return resolved;
}

function openOrCreateProjectPath(rawPath, { create = false, allowedRoots } = {}) {
  const projectPath = resolveProjectPath(rawPath, allowedRoots);
  const exists = fs.existsSync(projectPath);

  if (create) {
    if (exists && !fs.statSync(projectPath).isDirectory()) {
      const error = new Error("目标路径已存在但不是目录。");
      error.statusCode = 400;
      throw error;
    }
    fs.mkdirSync(projectPath, { recursive: true });
    return projectPath;
  }

  if (!exists || !fs.statSync(projectPath).isDirectory()) {
    const error = new Error("项目目录不存在。");
    error.statusCode = 404;
    throw error;
  }

  return projectPath;
}

module.exports = {
  isInside,
  openOrCreateProjectPath,
  parseAllowedRoots,
  resolveProjectPath
};
