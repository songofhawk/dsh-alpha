const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createGitRepoEnsurer, buildWorkerHubUrl, reconnectDelayMs } = require("../src/lib/gateway-worker");
const { tmpDir, cleanupDir } = require("./helpers");

test("默认 repo ensurer 把仓库克隆到 allowed root 内并幂等复用", async (t) => {
  const root = tmpDir("dsh-alpha-worker-root-");
  t.after(() => cleanupDir(root));
  let clones = 0;
  const ensure = createGitRepoEnsurer({
    clone: async (_url, target) => {
      clones += 1;
      fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    }
  });

  const repoUrl = "https://github.com/acme/site.git";
  const first = await ensure(repoUrl, { roots: [root] });
  const second = await ensure(repoUrl, { roots: [root] });
  assert.equal(first, second);
  assert.equal(clones, 1);
  assert.equal(path.relative(root, first).startsWith(".."), false);
  assert.equal(fs.existsSync(path.join(first, ".git")), true);
});

test("repo ensurer 拒绝非法 URL 与缺失 allowed root", async () => {
  const ensure = createGitRepoEnsurer({ clone: async () => {} });
  await assert.rejects(() => ensure("not-a-repo", { roots: ["/tmp"] }), /repo URL 不合法/);
  await assert.rejects(() => ensure("https://github.com/acme/site.git", { roots: [] }), /allowed root/);
});

test("worker hub URL 校验独立 token、保留 machine 且拒绝无认证或错误协议", () => {
  const value = buildWorkerHubUrl("ws://master.example:4310/alpha", {
    token: "secret",
    machineId: "work-1"
  });
  const url = new URL(value);
  assert.equal(url.searchParams.get("token"), null);
  assert.equal(url.searchParams.get("machine"), "work-1");
  assert.throws(() => buildWorkerHubUrl("ws://master.example:4310/"), /必须.*token/);
  assert.throws(() => buildWorkerHubUrl("https://master.example/", { token: "secret" }), /ws:\/\//);
});

test("worker 默认重连退避上限适合短生命周期 master，且可覆盖", () => {
  assert.equal(reconnectDelayMs(20), 5000);
  assert.equal(reconnectDelayMs(20, { minMs: 100, maxMs: 2000 }), 2000);
});
