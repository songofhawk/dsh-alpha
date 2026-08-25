#!/usr/bin/env node
// 将当前 commit 打包并部署到一个远端 DSH master/worker 节点。
// GitHub Actions 与本地手工部署都调用这个入口；凭据只通过环境变量传入。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function required(name) {
  const value = env(name);
  if (!value) throw new Error(`缺少部署配置：${name}`);
  return value;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run(command, args, options = {}) {
  const displayArgs = [...args];
  for (let index = 0; index < displayArgs.length; index += 1) {
    if (displayArgs[index] === "-i" && displayArgs[index + 1]) displayArgs[index + 1] = "<ssh-key>";
    if (displayArgs[index].startsWith("UserKnownHostsFile=")) displayArgs[index] = "UserKnownHostsFile=<known-hosts>";
  }
  const display = [command, ...displayArgs].join(" ");
  console.log(`==> ${display}`);
  return execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options
  });
}

function output(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options
  }).trim();
}

function sshArgs() {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  const knownHosts = env("DEPLOY_SSH_KNOWN_HOSTS_FILE");
  if (knownHosts) {
    args.push("-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`);
  } else {
    // 本地临时部署可接受新主机；CI 应设置 DEPLOY_SSH_KNOWN_HOSTS_FILE 固定主机指纹。
    args.push("-o", "StrictHostKeyChecking=accept-new");
  }
  const keyFile = required("DEPLOY_SSH_KEY_FILE");
  args.push("-i", keyFile);
  return args;
}

function remoteScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

release="\${DEPLOY_REMOTE_RELEASE}"
expected_sha="\${DEPLOY_ARTIFACT_SHA256}"
actual_sha="\$(sha256sum "\$release" | awk '{print \$1}')"
if [[ "\$actual_sha" != "\$expected_sha" ]]; then
  echo "错误: 远端发布包 SHA256 不匹配。" >&2
  exit 1
fi

pnpm_bin="\$(command -v pnpm || true)"
if [[ -z "\$pnpm_bin" ]]; then
  echo "错误: 远端未找到 pnpm。" >&2
  exit 1
fi

install_package() {
  local root="\$1"
  [[ -n "\$root" && -f "\$root/package.json" ]] || return 0
  echo "==> 更新 dsh-alpha：\$root"
  cd "\$root"
  "\$pnpm_bin" remove dsh-alpha >/dev/null 2>&1 || true
  "\$pnpm_bin" add "file:\$release" --save-exact --offline
  grep -q 'workspace-not-found' "\$root/node_modules/dsh-alpha/src/plugin.mjs"
}

install_package "\${DEPLOY_MASTER_PROFILE}"
install_package "\${DEPLOY_WORKER_ROOT}"

restart_service() {
  local service="\$1"
  [[ -n "\$service" ]] || return 0
  echo "==> 重启服务：\$service"
  systemctl restart "\$service"
  systemctl is-active --quiet "\$service"
}

restart_service "\${DEPLOY_MASTER_SERVICE}"
restart_service "\${DEPLOY_WORKER_SERVICE}"

if [[ -n "\${DEPLOY_HEALTH_URL}" ]]; then
  status=""
  for _ in \$(seq 1 30); do
    status="\$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "\${DEPLOY_HEALTH_URL}" || true)"
    [[ "\$status" == "200" ]] && break
    sleep 1
  done
  if [[ "\$status" != "200" ]]; then
    echo "错误: 健康检查失败，HTTP \$status。" >&2
    exit 1
  fi
fi

echo "==> 远端部署完成：\${DEPLOY_COMMIT}"
`;
}

function main() {
  const host = required("DEPLOY_TARGET_HOST");
  const user = env("DEPLOY_TARGET_USER", "root");
  const commit = output("git", ["rev-parse", "--short=12", "HEAD"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const packageName = manifest.name;
  const version = manifest.version;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-deploy-"));
  const packCache = path.join(tempRoot, "npm-cache");
  const plainArtifact = `${packageName}-${version}.tgz`;
  const artifactName = `${packageName}-${version}-${commit}.tgz`;
  const plainArtifactPath = path.join(tempRoot, plainArtifact);
  const artifactPath = path.join(tempRoot, artifactName);

  try {
    run("npm", ["--cache", packCache, "pack", "--pack-destination", tempRoot]);
    if (!fs.existsSync(plainArtifactPath)) throw new Error(`npm pack 未生成 ${plainArtifact}`);
    fs.renameSync(plainArtifactPath, artifactPath);

    const artifactSha = output("shasum", ["-a", "256", artifactPath]).split(/\s+/, 1)[0];
    const remoteRoot = env("DEPLOY_REMOTE_ROOT", "/opt/dsh-alpha-worker");
    const remoteRelease = path.posix.join(remoteRoot, "releases", artifactName);
    const masterProfile = env("DEPLOY_MASTER_PROFILE");
    const workerRoot = env("DEPLOY_WORKER_ROOT");
    if (!masterProfile && !workerRoot) throw new Error("至少配置 DEPLOY_MASTER_PROFILE 或 DEPLOY_WORKER_ROOT");
    const target = `${user}@${host}`;
    const commonSshArgs = sshArgs();

    run("ssh", [...commonSshArgs, target, `mkdir -p ${shellQuote(path.posix.dirname(remoteRelease))}`]);
    run("scp", [...commonSshArgs, artifactPath, `${target}:${remoteRelease}`]);

    const values = {
      DEPLOY_REMOTE_RELEASE: remoteRelease,
      DEPLOY_ARTIFACT_SHA256: artifactSha,
      DEPLOY_COMMIT: commit,
      DEPLOY_MASTER_PROFILE: masterProfile,
      DEPLOY_WORKER_ROOT: workerRoot,
      DEPLOY_MASTER_SERVICE: env("DEPLOY_MASTER_SERVICE"),
      DEPLOY_WORKER_SERVICE: env("DEPLOY_WORKER_SERVICE"),
      DEPLOY_HEALTH_URL: env("DEPLOY_HEALTH_URL", "http://127.0.0.1:3080/")
    };
    const assignments = Object.entries(values)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    run("ssh", [...commonSshArgs, target, `${assignments} bash -s`], {
      input: remoteScript(),
      stdio: ["pipe", "inherit", "inherit"]
    });
    console.log(`部署成功：${commit} → ${target}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
