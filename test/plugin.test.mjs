// plugin.mjs 主控插件：env/config 缺省回退 + host 平面服务发布。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../src/plugin.mjs";

function fakeCtx() {
  const services = {};
  return {
    services,
    provide(key, value) {
      services[key] = value;
    }
  };
}

describe("dsh-alpha plugin", () => {
  test("未设置 env 且无 config 时回退默认 providers 并注册各本机 agent", async () => {
    delete process.env.DSH_ALPHA_PROVIDERS;
    delete process.env.DSH_ALPHA_ALLOWED_ROOTS;
    delete process.env.DSH_ALPHA_DATA_DIR;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-plugin-"));
    try {
      const ctx = fakeCtx();
      apply(ctx, { dataDir, checkAvailability: false });
      const catalog = ctx.services.alphaCatalog;
      assert.ok(catalog, "应发布 alphaCatalog");
      const rows = catalog.listAgents();
      // 默认注册 codex/claude-code/kimi-code/mock + 阶段3 主控递归 dsh-master
      assert.equal(rows.length, 5, "默认注册 4 个本机 provider + dsh-master");
      assert.deepEqual(
        rows.map((r) => r.provider).sort(),
        ["claude-code", "codex", "dsh-master", "kimi-code", "mock"]
      );
      assert.ok(rows.every((r) => r.available), "checkAvailability=false 视为可用");
      assert.ok(ctx.services.alphaTasks, "应发布 alphaTasks");
      assert.ok(ctx.services.alphaApprovals, "应发布 alphaApprovals");
      assert.ok(ctx.services.alphaEngine, "应发布 alphaEngine");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("config.providers=[] 同样回退默认（[] 是 truthy，_old fallback 会漏掉）", async () => {
    delete process.env.DSH_ALPHA_PROVIDERS;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-plugin-"));
    try {
      const ctx = fakeCtx();
      apply(ctx, { dataDir, providers: [], allowedRoots: [process.cwd()], checkAvailability: false });
      const catalog = ctx.services.alphaCatalog;
      assert.equal(catalog.listAgents().length, 5); // 4 本机 + dsh-master
      const machine = catalog.listAgents()[0].machine;
      assert.deepEqual(machine.allowedRoots, [process.cwd()]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});