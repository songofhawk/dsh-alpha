const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createCatalog } = require("../src/lib/catalog");
const { createGatewayHub } = require("../src/lib/gateway-hub");
const { waitFor, tmpDir, cleanupDir } = require("./helpers");

const quiet = { log() {}, warn() {}, error() {}, info() {} };

test("正式 alpha-worker 入口用 header token 注册并可优雅退出", async (t) => {
  const root = tmpDir("dsh-alpha-entry-root-");
  t.after(() => cleanupDir(root));
  const catalog = createCatalog({
    allowedRoots: [root],
    adapterProvider: { capabilitiesFor: () => ({}), probeAvailability: () => ({ available: true, reason: null }) }
  });
  const hub = createGatewayHub({ catalog, tokens: { entry1: "entry-secret" }, port: 0, log: quiet });
  await hub.start();
  t.after(() => hub.close());

  const child = spawn(process.execPath, [path.resolve("scripts/alpha-worker.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_ALPHA_HUB_URL: `ws://127.0.0.1:${hub.address().port}/`,
      DSH_ALPHA_WORKER_TOKEN: "entry-secret",
      DSH_ALPHA_WORKER_MACHINE_ID: "entry1",
      DSH_ALPHA_WORKER_PROVIDERS: "mock",
      DSH_ALPHA_WORKER_ALLOWED_ROOTS: root,
      DSH_ALPHA_WORKER_HEARTBEAT_MS: "50"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitFor(() => catalog.listAgents().some((row) => row.agentId === "entry1:mock"));
  assert.equal(catalog.getAgent("entry1:mock").available, true);
  child.kill("SIGTERM");
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, output);
  assert.match(output, /已连上主控|已在主控注册/);
  assert.equal(fs.existsSync(root), true);
});
