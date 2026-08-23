#!/usr/bin/env node
// 阶段 1：被控机 gateway worker 入口 —— 反向连出主控 hub，无需公网 IP。
//
// 用法：
//   DSH_ALPHA_HUB_URL=ws://<master>:4310/ \
//   DSH_ALPHA_WORKER_MACHINE_ID=work1 \
//   DSH_ALPHA_WORKER_TOKEN=<master 上 DSH_ALPHA_GATEWAY_TOKENS 里 work1 的 token> \
//   [DSH_ALPHA_WORKER_PROVIDERS=codex,claude-code,kimi-code,mock] \
//   [DSH_ALPHA_WORKER_ALLOWED_ROOTS=...] \
//   node scripts/alpha-worker.mjs
//
// 默认 providers：本机所有阶段 0 provider；默认连接 127.0.0.1:4310。

import gatewayWorker from "../src/lib/gateway-worker.js";
const { runGatewayWorker, buildWorkerHubUrl } = gatewayWorker;

// token 可单独走环境变量，避免出现在进程参数/复制的 URL 中；兼容 URL 已带 token。
const hubUrl = buildWorkerHubUrl(process.env.DSH_ALPHA_HUB_URL || "ws://127.0.0.1:4310/", {
  token: process.env.DSH_ALPHA_WORKER_TOKEN,
  machineId: process.env.DSH_ALPHA_WORKER_MACHINE_ID
});

// repos：{ "repo_url": path } 或 [{ repo_url, path }]（阶段 3 repo 身份广播 / 按需 clone 已持有路径）
let envRepos = null;
if (process.env.DSH_ALPHA_WORKER_REPOS) {
  try {
    const parsed = JSON.parse(process.env.DSH_ALPHA_WORKER_REPOS);
    envRepos = Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed).map(([repo_url, path]) => ({ repo_url, path }));
  } catch {
    console.error("[alpha-worker] DSH_ALPHA_WORKER_REPOS 不是合法 JSON，忽略 repos 广播");
  }
}

const worker = runGatewayWorker({
  hubUrl,
  gatewayToken: process.env.DSH_ALPHA_WORKER_TOKEN,
  machineId: process.env.DSH_ALPHA_WORKER_MACHINE_ID,
  heartbeatIntervalMs: Number(process.env.DSH_ALPHA_WORKER_HEARTBEAT_MS) || 15000,
  reconnectMinMs: Number(process.env.DSH_ALPHA_WORKER_RECONNECT_MIN_MS) || 1000,
  reconnectMaxMs: Number(process.env.DSH_ALPHA_WORKER_RECONNECT_MAX_MS) || 5000,
  repos: envRepos
});

let stopping = false;
const loopPromise = worker.loop();

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[alpha-worker] ${signal}：退出`);
  worker.stop();
  let timeoutId;
  const timeout = new Promise((resolve) => { timeoutId = setTimeout(resolve, 5_000); });
  await Promise.race([loopPromise.catch(() => {}), timeout]);
  clearTimeout(timeoutId);
  process.exitCode = 0;
}
process.on("SIGINT", () => { shutdown("SIGINT").catch((error) => console.error(error)); });
process.on("SIGTERM", () => { shutdown("SIGTERM").catch((error) => console.error(error)); });

loopPromise.catch((error) => {
  if (stopping) return;
  console.error("[alpha-worker] 循环异常退出:", error);
  process.exitCode = 1;
});
