#!/usr/bin/env node
// dsh-alpha 用户入口：Web 为默认交互面；headless run 仅在 Web Gateway 未占用时运行。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const webUrl = process.env.DSH_ALPHA_WEB_URL || "http://127.0.0.1:3080/";
const healthUrl = process.env.DSH_ALPHA_GATEWAY_HEALTH_URL || "http://127.0.0.1:4310/healthz";

function requestJson(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        let value = null;
        try { value = JSON.parse(body); } catch { /* non-JSON Web root */ }
        resolve({ reachable: true, status: response.statusCode || 0, value });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.on("error", () => resolve({ reachable: false, status: 0, value: null }));
  });
}

function loadGatewayEnv() {
  const file = process.env.DSH_ALPHA_GATEWAY_ENV || path.join(os.homedir(), ".config", "dsh-alpha", "gateway.env");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!(key in process.env)) process.env[key] = line.slice(index + 1);
  }
}

async function status() {
  const [web, gateway] = await Promise.all([requestJson(webUrl), requestJson(healthUrl)]);
  const workers = gateway.value?.connected_workers;
  process.stdout.write(`dsh-alpha ${pkg.version}\n`);
  process.stdout.write(`Web: ${web.reachable ? `running (${webUrl})` : "stopped"}\n`);
  process.stdout.write(`Gateway: ${gateway.reachable ? `healthy (${workers ?? "?"} workers)` : "stopped"}\n`);
  return { web, gateway };
}

function openWeb() {
  if (process.platform === "darwin") {
    const result = spawnSync("/usr/bin/open", [webUrl], { stdio: "inherit" });
    if (result.status === 0) return;
  }
  process.stdout.write(`${webUrl}\n`);
}

async function runTask(args) {
  const task = args.join(" ").trim();
  if (!task) throw new Error("用法：dsh-alpha run <任务>");
  const gateway = await requestJson(healthUrl);
  if (gateway.reachable) {
    throw new Error("Web master 正在占用 Gateway；请在 Web 中使用 alpha preset，或先停止 com.dsh-alpha.web 再运行 headless 任务");
  }
  loadGatewayEnv();
  const child = spawn("dsh", ["--profile", "alpha", task], { stdio: "inherit", env: process.env });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve(signal ? 1 : (exitCode ?? 1)));
  });
  process.exitCode = code;
}

function help() {
  process.stdout.write(`dsh-alpha ${pkg.version}\n\n`);
  process.stdout.write("用法：\n");
  process.stdout.write("  dsh-alpha status        查看 Web、Gateway 与 worker 状态\n");
  process.stdout.write("  dsh-alpha web           打开 DSH Web\n");
  process.stdout.write("  dsh-alpha run <任务>    Web 未运行时启动 headless master\n");
}

async function main() {
  const [command = "status", ...args] = process.argv.slice(2);
  if (command === "--version" || command === "-V") return process.stdout.write(`${pkg.version}\n`);
  if (command === "--help" || command === "-h" || command === "help") return help();
  if (command === "status") return status();
  if (command === "web") {
    const current = await status();
    if (!current.web.reachable) throw new Error("DSH Web 未运行；请先启动 com.dsh-alpha.web LaunchAgent 或运行 dsh-alpha-web");
    openWeb();
    return;
  }
  if (command === "run") return runTask(args);
  throw new Error(`未知命令：${command}（运行 dsh-alpha --help 查看用法）`);
}

main().catch((error) => {
  process.stderr.write(`dsh-alpha: ${error.message}\n`);
  process.exitCode = 1;
});
