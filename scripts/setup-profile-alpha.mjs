#!/usr/bin/env node
// 安装 alpha profile 与用户级 alpha preset：
//   ~/.dsh/profiles/alpha/          （bundles: dsh-base + dsh-alpha，file: 链接本仓库）
//   ~/.dsh/.agent-presets/alpha/    （preset.yml + agent.cordis.yml，从仓库 preset/alpha 复制）
// 之后即可：dsh --profile alpha "<task>"

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { copyAlphaPreset } from "./install-preset.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const profileDir = path.join(dshHome, "profiles", "alpha");
const presetDir = path.join(dshHome, ".agent-presets", "alpha");

const PROFILE_PACKAGE = {
  name: "dsh-profile-alpha",
  private: true,
  dependencies: {
    // 不需要真实安装：见 main() 中的符号链接，@deepseek-ai/* 从仓库自身 node_modules 解析
    "dsh-alpha": `file:${repoRoot}`
  },
  dsh: {
    profile: {
      bundles: ["@deepseek-ai/dsh-base", "dsh-alpha"]
    }
  }
};

const CORDIS_ROOT = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]\n`;

const CORDIS_PATCH = `# Your patch layer for this profile, applied after every bundle layer:
# dsh-alpha's own bundle patch (host control plane + one-shot runner) is
# already applied via the bundle. Add machine-local overrides here.
[]\n`;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function main() {
  console.log(`dsh-alpha setup`);
  console.log(`  repo     : ${repoRoot}`);
  console.log(`  dshHome  : ${dshHome}`);

  // 1) profile 目录
  fs.mkdirSync(profileDir, { recursive: true });
  writeJson(path.join(profileDir, "package.json"), PROFILE_PACKAGE);
  fs.writeFileSync(path.join(profileDir, "cordis.yml"), CORDIS_ROOT);
  fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), CORDIS_PATCH);
  console.log(`  profile  : ${profileDir}（写 package.json/cordis.yml/cordis.patch.yml）`);

  // 2) 用户级 alpha preset（与 dsh plugin 安装流程共用同一投递实现）
  copyAlphaPreset({ dshHome });
  console.log(`  preset   : ${presetDir}（复制 preset.yml/agent.cordis.yml）`);

  // 3) node_modules/dsh-alpha → 本仓库符号链接（开发态；正式发布可用 pnpm install file:）
  const link = path.join(profileDir, "node_modules", "dsh-alpha");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(repoRoot, link, "dir");
    console.log(`  link     : ${link} → ${repoRoot}`);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log(`  link     : ${link} 已存在`);
  }

  console.log(`完成。验收运行：dsh --profile alpha "<任务>"`);
}

main();