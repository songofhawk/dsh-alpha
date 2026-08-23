const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tmpDir, cleanupDir } = require("./helpers");

function runDoctor(env) {
  return spawnSync(process.execPath, [path.resolve("scripts/alpha-worker-doctor.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
}

test("worker doctor 对完整 mock 部署配置通过且不输出 token", (t) => {
  const root = tmpDir("worker-doctor-");
  t.after(() => cleanupDir(root));
  const result = runDoctor({
    DSH_ALPHA_HUB_URL: "ws://127.0.0.1:4310/",
    DSH_ALPHA_WORKER_TOKEN: "doctor-secret",
    DSH_ALPHA_WORKER_MACHINE_ID: "doctor-1",
    DSH_ALPHA_WORKER_PROVIDERS: "mock",
    DSH_ALPHA_WORKER_ALLOWED_ROOTS: root
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.includes("doctor-secret"), false);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.tokenConfigured, true);
});

test("worker doctor 对缺 token/roots 的部署配置失败", () => {
  const result = runDoctor({
    DSH_ALPHA_HUB_URL: "ws://127.0.0.1:4310/",
    DSH_ALPHA_WORKER_TOKEN: "",
    DSH_ALPHA_WORKER_ALLOWED_ROOTS: "",
    DSH_ALPHA_WORKER_PROVIDERS: "mock"
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /token/.test(error)));
  assert.ok(report.errors.some((error) => /ALLOWED_ROOTS/.test(error)));
});
