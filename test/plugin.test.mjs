// plugin.mjs 主控插件：env/config 缺省回退 + host 平面服务发布 + 阶段 4 seam 收敛。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../src/plugin.mjs";
import { waitFor } from "./helpers.js";

function fakeCtx() {
  const services = {};
  return {
    services,
    provide(key, value) {
      services[key] = value;
    }
  };
}

// fake ctx.subagents 缝：记录官方 provider 注册与 start 调用。
// start 一律返回 completed 的假结果，用于验证「本地派发走 seam」的闭环。
function fakeSeam() {
  const providers = new Map();
  const runs = [];
  return {
    providers,
    runs,
    registerProvider(provider) {
      providers.set(provider.name, provider);
      return () => providers.delete(provider.name);
    },
    getProvider(name) {
      return providers.get(name);
    },
    list() {
      return [...providers.keys()];
    },
    async start(name, request) {
      const run = { name, request, disposed: false };
      runs.push(run);
      return {
        id: `fake-${runs.length}`,
        result: Promise.resolve({
          output: [{ type: "text", text: `seam:${name} 完成：${request.prompt[0].text}` }],
          stopReason: "completed"
        }),
        dispose: async () => {
          run.disposed = true;
        }
      };
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

describe("阶段 4：本地执行收敛到官方 subagent provider", () => {
  function seamEnv(t) {
    delete process.env.DSH_ALPHA_PROVIDERS;
    delete process.env.DSH_ALPHA_ALLOWED_ROOTS;
    delete process.env.DSH_ALPHA_LOCAL_LEGACY;
    // 确定性的 kimi 可执行文件：指向 node 本体（只用于注册，不会真 spawn）
    const prevKimi = process.env.KIMI_CODE_CLI_PATH;
    process.env.KIMI_CODE_CLI_PATH = process.execPath;
    t.after(() => {
      if (prevKimi === undefined) delete process.env.KIMI_CODE_CLI_PATH;
      else process.env.KIMI_CODE_CLI_PATH = prevKimi;
      delete process.env.DSH_ALPHA_LOCAL_LEGACY;
    });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-seam-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const seam = fakeSeam();
    const ctx = fakeCtx();
    ctx.subagents = seam;
    return { ctx, seam, dataDir };
  }

  test("有 seam → 动态注册 codex / claude-code / kimi-code 三个官方 provider", async (t) => {
    const { ctx, seam, dataDir } = seamEnv(t);
    await apply(ctx, { dataDir, providers: ["codex", "mock"], allowedRoots: [dataDir], checkAvailability: false });
    assert.deepEqual(seam.list().sort(), ["claude-code", "codex", "kimi-code"]);
    // kimi-code 是 dsh-subagent-acp 实例：command 取 resolveKimiExecutable()
    const kimi = seam.getProvider("kimi-code");
    assert.equal(kimi.name, "kimi-code");
    assert.equal(kimi.config.command, process.execPath);
    assert.deepEqual(kimi.config.args, ["acp"]);
  });

  test("无 seam（fake ctx 不带 subagents）→ 跳过注册，插件照常发布服务", async (t) => {
    delete process.env.DSH_ALPHA_PROVIDERS;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-plugin-"));
    try {
      const ctx = fakeCtx(); // 无 subagents 属性
      await apply(ctx, { dataDir, providers: ["mock"], allowedRoots: [dataDir], checkAvailability: false });
      assert.ok(ctx.services.alphaEngine, "无 seam 也应发布 alphaEngine（local 分支回退 vendor）");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("本地 codex 派发走 seam：one-shot 完成，parent.cwd = 任务 projectPath", async (t) => {
    const { ctx, seam, dataDir } = seamEnv(t);
    await apply(ctx, { dataDir, providers: ["codex", "mock"], allowedRoots: [dataDir], checkAvailability: false });
    const engine = ctx.services.alphaEngine;
    const store = ctx.services.alphaTasks;
    const codexAgent = ctx.services.alphaCatalog.listAgents().find((a) => a.provider === "codex");

    const { taskId } = engine.dispatch({ agentId: codexAgent.agentId, prompt: "hello seam", projectPath: dataDir });
    await waitFor(() => store.getTask(taskId).status === "completed");

    assert.equal(seam.runs.length, 1, "本地 codex 派发应恰好走一次 seam");
    const run = seam.runs[0];
    assert.equal(run.name, "codex");
    assert.deepEqual(run.request.prompt, [{ type: "text", text: "hello seam" }]);
    assert.equal(run.request.parent.session.header.cwd, dataDir, "任务 projectPath 注入子进程 cwd");
    assert.equal(run.disposed, true, "引擎收尾必须 dispose run");
    assert.match(store.getTask(taskId).result, /seam:codex 完成：hello seam/);
  });

  test("mock 无官方 provider → 仍走 vendor runtime，不触碰 seam", async (t) => {
    const { ctx, seam, dataDir } = seamEnv(t);
    await apply(ctx, { dataDir, providers: ["codex", "mock"], allowedRoots: [dataDir], checkAvailability: false });
    const engine = ctx.services.alphaEngine;
    const store = ctx.services.alphaTasks;
    const mockAgent = ctx.services.alphaCatalog.listAgents().find((a) => a.provider === "mock");

    const { taskId } = engine.dispatch({ agentId: mockAgent.agentId, prompt: "legacy mock", projectPath: dataDir });
    await waitFor(() => store.getTask(taskId).status === "completed");

    assert.equal(seam.runs.length, 0, "mock 不在 SEAM_PROVIDER_NAMES，必须走 vendor runtime");
    assert.match(store.getTask(taskId).result, /接收任务：legacy mock/);
  });
});