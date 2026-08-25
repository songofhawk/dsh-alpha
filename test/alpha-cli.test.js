const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const manifest = require("../package.json");

const cli = path.resolve("scripts/alpha-cli.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_ALPHA_WEB_URL: "http://127.0.0.1:1/",
      DSH_ALPHA_GATEWAY_HEALTH_URL: "http://127.0.0.1:1/healthz",
      ...env
    },
    encoding: "utf8"
  });
}

test("dsh-alpha CLI 暴露版本、帮助与离线状态", () => {
  const version = run(["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), manifest.version);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /dsh-alpha status/);
  assert.match(help.stdout, /dsh-alpha web/);
  const status = run(["status"]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /Web: stopped/);
  assert.match(status.stdout, /Gateway: stopped/);
});

test("dsh-alpha CLI 对未知命令和空 run 失败", () => {
  const unknown = run(["wat"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /未知命令/);
  const empty = run(["run"]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /run <任务>/);
});

test("dsh-alpha CLI 状态检查支持 HTTPS Web 地址", () => {
  const status = run(["status"], {
    DSH_ALPHA_WEB_URL: "https://127.0.0.1:1/"
  });
  assert.equal(status.status, 0);
  assert.match(status.stdout, /Web: stopped/);
  assert.doesNotMatch(status.stderr, /Protocol "https:" not supported/);
});
