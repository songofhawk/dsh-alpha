#!/usr/bin/env node
// 安装 alpha preset，并把 alpha 专用 headless 行作为托管区块合并进
// ~/.dsh/profiles/alpha/cordis.patch.yml。区块外的机器本地配置原样保留。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { copyAlphaPreset } from "./install-preset.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BEGIN = "# dsh-alpha:managed-alpha-profile begin";
const END = "# dsh-alpha:managed-alpha-profile end";

function managedBlock(source) {
  return `${BEGIN}\n${String(source).trim()}\n${END}`;
}

function isCommentOnlyEmptyPatch(text) {
  const semantic = String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("#"));
  return semantic.length === 0 || (semantic.length === 1 && semantic[0] === "[]");
}

export function mergeManagedAlphaPatch(existing, source) {
  const current = String(existing || "");
  const block = managedBlock(source);
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new Error("alpha profile patch 的 dsh-alpha 托管区块标记不完整，拒绝覆盖");
  }
  if (start >= 0 && end >= start) {
    return `${current.slice(0, start)}${block}${current.slice(end + END.length)}`.trimEnd() + "\n";
  }
  if (isCommentOnlyEmptyPatch(current)) return `${block}\n`;
  return `${current.trimEnd()}\n\n${block}\n`;
}

export function installAlphaProfile({ dshHome, source } = {}) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const profileDir = path.join(home, "profiles", "alpha");
  const patchFile = path.join(profileDir, "cordis.patch.yml");
  const patchSource = source || fs.readFileSync(path.join(packageRoot, "preset", "alpha", "profile.patch.yml"), "utf8");
  fs.mkdirSync(profileDir, { recursive: true });
  let existing = "[]\n";
  try {
    existing = fs.readFileSync(patchFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.writeFileSync(patchFile, mergeManagedAlphaPatch(existing, patchSource));
  const presetDir = copyAlphaPreset({ dshHome: home });
  return { patchFile, presetDir };
}

function isDirectRun() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const result = installAlphaProfile();
  console.log(`[dsh-alpha] alpha profile patch 已安装：${result.patchFile}`);
  console.log(`[dsh-alpha] alpha preset 已安装：${result.presetDir}`);
}
