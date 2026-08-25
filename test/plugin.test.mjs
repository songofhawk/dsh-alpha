// plugin.mjs 主控插件：env/config 缺省回退 + Web-safe host 控制平面。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverResponseSchema } from "@deepseek-ai/dsh-host-apiproxy/api";
import { apply, registerWorkspaceRpc } from "../src/plugin.mjs";
import { waitFor } from "./helpers.js";

function fakeCtx() {
  const services = {};
  return {
    services,
    provide(key, value) {
      services[key] = value;
    },
    // 最小 cordis effect：立即执行生成器、收集清理闭包（测试内不触发 dispose）
    effect(execute) {
      const generator = execute();
      let step = generator.next();
      while (!step.done) step = generator.next();
      return () => {};
    }
  };
}

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
  test("Web RPC 只允许 alpha session 选择全局工作区", async () => {
    let handler;
    let registration;
    const selections = [];
    const workspaces = {
      selected: () => null,
      selection: () => ({ workspaceId: null, machineId: null, workspace: null }),
      machines: () => [{ machineId: "local-mac", online: true }],
      list: () => [{ workspaceId: "repo-1", name: "ai-prd", locations: [], available: true }],
      sessionTarget: () => ({ cwd: "/tmp/alpha-session-target", title: "worker · /work/ai-prd" }),
      select: (sessionId, selection) => {
        const workspaceId = typeof selection === "string" ? selection : selection?.workspaceId;
        if (workspaceId === "missing") {
          const error = new Error("全局工作区不存在：missing");
          error.statusCode = 404;
          throw error;
        }
        selections.push({ sessionId, workspaceId });
        return { sessionId, workspace: workspaceId ? { workspaceId } : null, machineId: selection?.machineId || null };
      }
    };
    registerWorkspaceRpc({
      inject(_deps, callback) {
        callback({
          sessions: {
            get: (id) => id === "cold-alpha-session"
              ? undefined
              : id === "event-alpha-session"
              ? { header: { agentPreset: "code" }, events: [{ type: "agent-preset/selected", data: { agentPreset: "alpha" } }] }
              : { header: { agentPreset: id === "alpha-session" ? "alpha" : "code" }, events: [] }
          },
          sessionPersistence: {
            inspect: async (id) => {
              if (id === "cold-alpha-session") {
                return { meta: { agentPreset: "code" }, events: [{ type: "agent-preset/selected", data: { agentPreset: "alpha" } }] };
              }
              throw new Error("session not found");
            }
          },
          connection: { rpc: { handle(channel, value, options) {
            handler = value;
            registration = { channel, options };
          } } }
        });
      }
    }, workspaces);
    assert.deepEqual(registration, {
      channel: "/dsh-alpha",
      options: { authority: "trusted-host" }
    });
    const list = await handler("workspace/list", { sessionId: "alpha-session" });
    assert.equal(list.ok, true);
    assert.equal(list.value.enabled, true);
    const target = await handler("workspace/session-target", {});
    assert.deepEqual(target, {
      ok: true,
      value: { cwd: "/tmp/alpha-session-target", title: "worker · /work/ai-prd" }
    });
    const selected = await handler("workspace/select", { sessionId: "alpha-session", workspaceId: "repo-1" });
    assert.equal(selected.ok, true);
    assert.deepEqual(selections, [{ sessionId: "alpha-session", workspaceId: "repo-1" }]);
    serverResponseSchema.parse({ type: "server-response", rpcId: "test", result: selected });
    const eventSelected = await handler("workspace/select", { sessionId: "event-alpha-session", workspaceId: "repo-1" });
    assert.equal(eventSelected.ok, true);
    assert.deepEqual(selections, [
      { sessionId: "alpha-session", workspaceId: "repo-1" },
      { sessionId: "event-alpha-session", workspaceId: "repo-1" }
    ]);
    serverResponseSchema.parse({ type: "server-response", rpcId: "test", result: eventSelected });
    const coldSelected = await handler("workspace/select", { sessionId: "cold-alpha-session", workspaceId: "repo-1" });
    assert.equal(coldSelected.ok, true);
    assert.deepEqual(selections, [
      { sessionId: "alpha-session", workspaceId: "repo-1" },
      { sessionId: "event-alpha-session", workspaceId: "repo-1" },
      { sessionId: "cold-alpha-session", workspaceId: "repo-1" }
    ]);
    serverResponseSchema.parse({ type: "server-response", rpcId: "test", result: coldSelected });
    const missing = await handler("workspace/select", { sessionId: "alpha-session", workspaceId: "missing" });
    assert.deepEqual(missing, {
      ok: false,
      error: {
        code: "workspace-not-found",
        message: "全局工作区不存在：missing",
        details: { workspaceId: "missing" }
      }
    });
    serverResponseSchema.parse({ type: "server-response", rpcId: "test", result: missing });
    const rejected = await handler("workspace/select", { sessionId: "code-session", workspaceId: "repo-1" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "bad-request");
    serverResponseSchema.parse({ type: "server-response", rpcId: "test", result: rejected });
  });

  test("Worker 能力 RPC 使用实时 Agent 目录并回写目录缓存", async () => {
    let handler;
    const agent = {
      agentId: "worker-1:codex",
      machineId: "worker-1",
      provider: "codex",
      model: "old-model",
      capabilities: { models: ["old-model"] },
      available: true,
      unavailableReason: null
    };
    const workspaces = {
      controlCwd: "/tmp/alpha-control",
      selection: () => ({ workspace: null, machineId: "worker-1" }),
      machines: () => [{ machineId: "worker-1", online: true }],
      list: () => [],
      select: () => ({ sessionId: "alpha-session", workspace: null, machineId: "worker-1" })
    };
    const catalog = {
      listAgents: () => [agent],
      getAgent: () => agent,
      updateAgentCapabilities: (_agentId, capabilities) => {
        agent.capabilities = capabilities;
        agent.model = capabilities.default_model;
      }
    };
    registerWorkspaceRpc({
      inject(_deps, callback) {
        callback({
          sessions: { get: () => ({ header: { agentPreset: "alpha" }, events: [] }) },
          sessionPersistence: { inspect: async () => ({ meta: { agentPreset: "alpha" }, events: [] }) },
          connection: { rpc: { handle(_channel, value) { handler = value; } } }
        });
      }
    }, workspaces, catalog, async () => ({
      models: ["live-model"],
      default_model: "live-model",
      reasoning_efforts: ["high"]
    }));

    const result = await handler("agent/capabilities", {
      sessionId: "alpha-session",
      agentId: "worker-1:codex"
    });
    assert.deepEqual(result.value.capabilities.models, ["live-model"]);
    assert.equal(agent.model, "live-model");
  });

  test("未设置 env 且无 config 时回退默认 providers 并注册各本机 agent", async () => {
    delete process.env.DSH_ALPHA_PROVIDERS;
    delete process.env.DSH_ALPHA_ALLOWED_ROOTS;
    delete process.env.DSH_ALPHA_DATA_DIR;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-plugin-"));
    try {
      const ctx = fakeCtx();
      apply(ctx, { dataDir, checkAvailability: false, discoverWorkspaces: false });
      const catalog = ctx.services.alphaCatalog;
      assert.ok(catalog, "应发布 alphaCatalog");
      const rows = catalog.listAgents();
      // 默认注册三个真实 provider + 阶段3 主控递归 dsh-master；mock 必须显式开启
      assert.equal(rows.length, 4, "默认注册 3 个真实 provider + dsh-master");
      assert.deepEqual(
        rows.map((r) => r.provider).sort(),
        ["claude-code", "codex", "dsh-master", "kimi-code"]
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
      apply(ctx, { dataDir, providers: [], allowedRoots: [process.cwd()], checkAvailability: false, discoverWorkspaces: false });
      const catalog = ctx.services.alphaCatalog;
      assert.equal(catalog.listAgents().length, 4); // 3 个真实 provider + dsh-master
      const machine = catalog.listAgents()[0].machine;
      assert.deepEqual(machine.allowedRoots, [process.cwd()]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("Web-safe：不向宿主注入第二套 DSH provider/tool runtime", () => {
  function seamEnv(t) {
    delete process.env.DSH_ALPHA_PROVIDERS;
    delete process.env.DSH_ALPHA_ALLOWED_ROOTS;
    delete process.env.DSH_ALPHA_GATEWAY_PORT;
    delete process.env.DSH_ALPHA_GATEWAY_TOKENS;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-seam-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const seam = fakeSeam();
    const ctx = fakeCtx();
    ctx.subagents = seam;
    return { ctx, seam, dataDir };
  }

  test("有 seam 也不注册/覆盖宿主 provider", async (t) => {
    const { ctx, seam, dataDir } = seamEnv(t);
    await apply(ctx, { dataDir, providers: ["codex", "mock"], allowedRoots: [dataDir], checkAvailability: false, discoverWorkspaces: false });
    assert.deepEqual(seam.list(), []);
    assert.ok(ctx.services.alphaEngine);
  });

  test("无 seam（fake ctx 不带 subagents）→ 跳过注册，插件照常发布服务", async (t) => {
    delete process.env.DSH_ALPHA_PROVIDERS;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-plugin-"));
    try {
      const ctx = fakeCtx(); // 无 subagents 属性
      await apply(ctx, { dataDir, providers: ["mock"], allowedRoots: [dataDir], checkAvailability: false, discoverWorkspaces: false });
      assert.ok(ctx.services.alphaEngine, "无 seam 也应发布 alphaEngine");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("本地 mock 走 vendor runtime，不触碰 seam", async (t) => {
    const { ctx, seam, dataDir } = seamEnv(t);
    await apply(ctx, { dataDir, providers: ["codex", "mock"], allowedRoots: [dataDir], checkAvailability: false, discoverWorkspaces: false });
    const engine = ctx.services.alphaEngine;
    const store = ctx.services.alphaTasks;
    const mockAgent = ctx.services.alphaCatalog.listAgents().find((a) => a.provider === "mock");

    const { taskId } = engine.dispatch({ agentId: mockAgent.agentId, prompt: "legacy mock", projectPath: dataDir });
    await waitFor(() => store.getTask(taskId).status === "completed");

    assert.equal(seam.runs.length, 0);
    assert.match(store.getTask(taskId).result, /接收任务：legacy mock/);
  });

  test("启用 gateway 只发布 alphaGateway 服务，不注册 subagent provider", async (t) => {
    const { ctx, seam, dataDir } = seamEnv(t);
    await apply(ctx, {
      dataDir,
      providers: ["mock"],
      allowedRoots: [dataDir],
      checkAvailability: false,
      discoverWorkspaces: false,
      gatewayPort: 0, // OS 分配临时端口
      gatewayTokens: "m1:tok-1"
    });
    t.after(() => ctx.services.alphaGateway.close());

    assert.ok(ctx.services.alphaGateway, "应发布 alphaGateway");
    assert.deepEqual(seam.list(), []);
  });

  test("启用 gateway 缺 token → 拒绝启动（认证是硬前提）", async (t) => {
    const { ctx, dataDir } = seamEnv(t);
    await assert.rejects(
      apply(ctx, { dataDir, providers: ["mock"], allowedRoots: [dataDir], checkAvailability: false, discoverWorkspaces: false, gatewayPort: 0 }),
      /DSH_ALPHA_GATEWAY_TOKENS/
    );
  });
});
