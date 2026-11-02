import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const client = readFileSync(path.join(root, "src/client.js"), "utf8");

test("client bundle 的版本标记与 package.json 版本一致", () => {
  const match = /const ALPHA_PLUGIN_VERSION = "([^"]+)";/.exec(client);
  assert.ok(match, "src/client.js 缺少 ALPHA_PLUGIN_VERSION 常量");
  assert.equal(match[1], pkg.version, "发布新版本时忘记同步 client bundle 的版本标记");
});

test("侧边栏 Alpha 项渲染版本标记而不是写死文本", () => {
  assert.ok(client.includes('className: "alpha-launcher-version"'), "侧边栏未渲染 alpha-launcher-version");
  assert.ok(client.includes("`v${ALPHA_PLUGIN_VERSION}`"), "版本标记应取自常量，避免与 package.json 漂移");
  assert.ok(!/alpha-launcher-version[^}]*\}\s*\)\s*,\s*"v\d/.test(client), "版本标记不应写死为字面量");
});
