import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installAlphaProfile, mergeManagedAlphaPatch } from "../scripts/install-alpha-profile.mjs";

const source = fs.readFileSync(new URL("../preset/alpha/profile.patch.yml", import.meta.url), "utf8");

test("发布包复用宿主 DSH runtime，不携带第二套 core 包", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies), ["@deepseek-ai/schemastery"]);
  const runner = fs.readFileSync(new URL("../src/runner.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(runner, /from ["']@deepseek-ai\/dsh-(?:agent|llm|session|tools)/);
  const client = fs.readFileSync(new URL("../src/client.js", import.meta.url), "utf8");
  assert.match(client, /sidebar\.footer\.action/);
  assert.match(client, /conversation\.hero\.workspace/);
  assert.match(client, /ReactDOM\.createPortal/);
  assert.match(client, /inventory\/overview/);
  assert.match(client, /alpha-inventory-page/);
  assert.match(client, /DSH_INVENTORY_STYLES/);
  assert.match(client, /var\(--dsw-alias-bg-base\)/);
  assert.match(client, /alpha-inventory-tabs/);
  assert.match(client, /state\.loading \? React\.createElement\("div", \{ className: "alpha-inventory-loading", role: "status"/);
  assert.match(client, /@keyframes alpha-inventory-spin/);
  assert.match(client, /const saved = await controller\.call\(`inventory\/update-\$\{kind\}`/);
  assert.doesNotMatch(client, /await controller\.call\(`inventory\/update-\$\{kind\}`[\s\S]{0,120}await load\(\)/);
  assert.match(client, /inventory\/directories/);
  assert.match(client, /选择目录/);
  assert.match(client, /controller\.call\("task\/list"/);
  assert.match(client, /createTaskPoller/);
  assert.match(client, /任务监控连接暂时中断/);
  assert.match(client, /controller\.call\("task\/cancel"/);
  assert.match(client, /Deep diving/);
  assert.match(client, /alpha-task-inline-panel/);
  assert.doesNotMatch(client, /alpha-task-monitor-trigger/);
  assert.match(client, /agentPreset: "alpha"/);
  assert.match(client, /workspaceId: controlWorkspace\.workspaceId/);
  assert.equal(manifest.exports["./client"], "./src/client.js");
  assert.equal(manifest.exports["./package.json"], "./package.json");
  assert.equal(manifest.dsh.client.platform, "web");
});

test("所有 bin 入口均可执行", () => {
  for (const relative of ["../scripts/alpha-cli.mjs", "../scripts/alpha-worker.mjs", "../scripts/alpha-worker-doctor.mjs"]) {
    const mode = fs.statSync(new URL(relative, import.meta.url)).mode;
    assert.notEqual(mode & 0o111, 0, `${relative} 缺少 executable bit`);
  }
});

test("common bundle 只挂控制平面，headless 行只存在于 alpha profile patch", () => {
  const common = fs.readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  assert.match(common, /id: dsh-alpha/);
  assert.match(common, /name: 'dsh-alpha'/);
  assert.doesNotMatch(common, /alpha-runner|headless-startup|code-runtime/);
  assert.match(source, /alpha-runner/);
  assert.match(source, /headless-startup/);
  assert.doesNotMatch(source, /id: dsh-alpha/);
});

test("managed alpha patch 替换空 patch、保留本地配置且幂等更新", () => {
  const empty = mergeManagedAlphaPatch("# generated\n[]\n", source);
  assert.match(empty, /managed-alpha-profile begin/);
  assert.doesNotMatch(empty, /^\[\]$/m);

  const local = "- id: local-row\n  config:\n    enabled: true\n";
  const merged = mergeManagedAlphaPatch(local, source);
  assert.match(merged, /id: local-row/);
  assert.match(merged, /id: alpha-runner/);
  const updated = mergeManagedAlphaPatch(merged, source.replace("default: alpha", "default: alpha-next"));
  assert.equal((updated.match(/managed-alpha-profile begin/g) || []).length, 1);
  assert.match(updated, /default: alpha-next/);
  assert.match(updated, /id: local-row/);
  assert.throws(() => mergeManagedAlphaPatch("# dsh-alpha:managed-alpha-profile begin\n", source), /标记不完整/);
});

test("installAlphaProfile 写入 patch 与 preset，并保留区块外配置", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-profile-install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profileDir = path.join(home, "profiles", "alpha");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), "- id: local-row\n  disabled: true\n");
  const result = installAlphaProfile({ dshHome: home });
  const installed = fs.readFileSync(result.patchFile, "utf8");
  assert.match(installed, /id: local-row/);
  assert.match(installed, /id: alpha-runner/);
  assert.equal(fs.existsSync(path.join(result.presetDir, "preset.yml")), true);
  assert.equal(fs.existsSync(path.join(result.presetDir, "agent.cordis.yml")), true);
});
