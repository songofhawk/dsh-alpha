#!/usr/bin/env node
// 把 alpha preset 装进 ~/.dsh/.agent-presets/alpha/（preset.yml + agent.cordis.yml）。
//
// preset 文件由 agent-presets 服务做文件系统发现，不随 `dsh plugin add` 的
// profile 层分发；Web 安装后补跑本脚本即可。alpha headless profile 应改跑
// install-alpha-profile.mjs（它会同时安装本 preset 与专用 profile patch）：
//
//   node ~/.dsh/profiles/web/node_modules/dsh-alpha/scripts/install-preset.mjs
//
// 源目录相对本脚本自身位置解析，仓库 checkout 内直接跑同样有效
// （npm run setup 的 preset 步骤即复用本模块）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 复制 preset/alpha 到 <dshHome>/.agent-presets/alpha/，幂等覆盖。
 * @param {object} [options]
 * @param {string} [options.source] preset 目录（默认取包内 preset/alpha）
 * @param {string} [options.dshHome] dsh home（默认 $DSH_HOME 或 ~/.dsh）
 * @returns {string} 目标 preset 目录
 */
export function copyAlphaPreset({ source = path.join(packageRoot, "preset", "alpha"), dshHome } = {}) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const target = path.join(home, ".agent-presets", "alpha");
  fs.mkdirSync(target, { recursive: true });
  for (const file of ["preset.yml", "agent.cordis.yml"]) {
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
  return target;
}

function isDirectRun() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const target = copyAlphaPreset();
  console.log(`[dsh-alpha] alpha preset 已安装：${target}`);
}
