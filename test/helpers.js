// waitFor helper：轮询直到条件满足或超时（node --test 共用）
async function waitFor(fn, { timeout = 5000, interval = 10 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitFor 超时（${timeout}ms）`);
}

function tmpDir(prefix) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || `dsh-alpha-`));
  return dir;
}

function cleanupDir(dir) {
  const fs = require("node:fs");
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

module.exports = { waitFor, tmpDir, cleanupDir };