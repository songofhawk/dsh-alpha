#!/usr/bin/env node
// 只读部署前检查：不连接 hub、不打印 token、不创建目录。

import fs from "node:fs";
import path from "node:path";
import gatewayWorker from "../src/lib/gateway-worker.js";
import adapters from "../src/lib/adapters.js";

const { buildWorkerHubUrl } = gatewayWorker;
const { listDefaultAgentProviders, probeAvailability } = adapters;

function nearestExistingAncestor(input) {
  let current = path.resolve(input);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function check() {
  const errors = [];
  const warnings = [];
  const machineId = process.env.DSH_ALPHA_WORKER_MACHINE_ID || null;
  const token = process.env.DSH_ALPHA_WORKER_TOKEN || null;
  const rawUrl = process.env.DSH_ALPHA_HUB_URL || "ws://127.0.0.1:4310/";
  let hubUrl = null;
  try {
    hubUrl = buildWorkerHubUrl(rawUrl, { token, machineId });
    const parsed = new URL(hubUrl);
    parsed.searchParams.delete("token");
    hubUrl = parsed.toString();
    if (parsed.protocol === "ws:" && !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
      warnings.push("非本机 ws:// 链路未加密；公网或不可信网络应使用 wss://");
    }
  } catch (error) {
    errors.push(error.message);
  }

  const roots = String(process.env.DSH_ALPHA_WORKER_ALLOWED_ROOTS || "")
    .split(",")
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));
  if (!roots.length) {
    errors.push("必须显式配置 DSH_ALPHA_WORKER_ALLOWED_ROOTS，生产 worker 不应依赖 cwd 默认值");
  }
  const rootChecks = roots.map((root) => {
    const ancestor = nearestExistingAncestor(root);
    let writable = true;
    try {
      fs.accessSync(ancestor, fs.constants.W_OK);
    } catch {
      writable = false;
      errors.push(`allowed root 的现存祖先不可写：${root}`);
    }
    return { root, exists: fs.existsSync(root), writableAncestor: writable };
  });

  const requestedProviders = String(process.env.DSH_ALPHA_WORKER_PROVIDERS || "")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  const providers = requestedProviders.length ? requestedProviders : listDefaultAgentProviders();
  const providerChecks = providers.map((provider) => {
    try {
      const result = probeAvailability(provider);
      if (!result.available) errors.push(`provider ${provider} 不可用：${result.reason || "探测失败"}`);
      return { provider, ...result };
    } catch (error) {
      errors.push(`provider ${provider} 不可用：${error.message}`);
      return { provider, available: false, reason: error.message };
    }
  });

  if (!machineId) warnings.push("未显式设置 machine ID，将回退 hostname；建议配置稳定 ID");
  return {
    ok: errors.length === 0,
    machineId: machineId || "(hostname fallback)",
    hubUrl,
    tokenConfigured: Boolean(token || (() => {
      try { return new URL(rawUrl).searchParams.get("token"); } catch { return false; }
    })()),
    roots: rootChecks,
    providers: providerChecks,
    warnings,
    errors
  };
}

const result = check();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;

export { check };
