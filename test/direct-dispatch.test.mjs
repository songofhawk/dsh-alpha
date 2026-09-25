import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { LlmRuntime, LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm";
import { apply } from "../src/tools.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalAttachmentStore } from "@deepseek-ai/dsh-attachment-local";
import { createCatalog } from "../src/lib/catalog.js";
import { createTaskStore } from "../src/lib/task-store.js";
import { createApprovalBroker } from "../src/lib/approvals.js";
import { createTaskEngine } from "../src/lib/task-engine.js";
import { createGatewayHub } from "../src/lib/gateway-hub.js";
import { runGatewayWorker } from "../src/lib/gateway-worker.js";
import { createLocalAgentAdapter } from "../src/lib/adapters.js";
import { waitFor } from "./helpers.js";

async function harness(t, selected, { dispatchError, outcome, waitTask, createEngine, catalogRows = [] } = {}) {
  const ctx = new Context();
  new SessionStore(ctx);
  new AgentRegistry(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  new ToolRuntime(ctx);
  new LlmRuntime(ctx);
  new AgentLoop(ctx, { agents: [] });
  const calls = [];
  class SpyAdapter extends LlmAdapter {
    async *stream() {
      calls.push("model");
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "主控处理" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "主控处理" } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  ctx.llm.registerAdapter(["spy"], new SpyAdapter());
  ctx.provide("alphaCatalog", { listAgents: () => { calls.push("catalog"); return catalogRows; } });
  ctx.provide("alphaWorkspaces", { selection: () => selected, list: () => [] });
  ctx.provide("alphaApprovals", { listPending: () => [] });
  ctx.provide("alphaEngine", createEngine ? createEngine(ctx) : {
    dispatch(args) {
      calls.push({ dispatch: args });
      if (dispatchError) throw new Error(dispatchError);
      return { taskId: "task-direct", agentId: selected.agentId, status: "running" };
    },
    async waitTask(id, control) {
      calls.push({ wait: id });
      if (waitTask) return waitTask(id, control);
      return outcome || { taskId: id, agentId: selected.agentId, status: "completed", result: "Worker 原始结果" };
    }
  });
  const handle = await ctx.agents.create({
    sessionId: "session-direct",
    agentOptions: { provider: "spy", model: "spy-model" },
    setup: async (agentCtx) => { apply(agentCtx); }
  });
  t.after(async () => { await handle.dispose(); });
  return {
    ctx, calls, agent: handle.agent,
    async send(text, content) {
      handle.agent.followup(createUserMessage({ source: { kind: "user" }, content: content || [{ type: "text", text }] }));
      await handle.agent.whenIdle();
      const events = handle.agent.session.events;
      const end = events.filter((event) => event.type === "turn/end").at(-1);
      assert.equal(end.data.reason.kind, "completed", JSON.stringify(end));
      return events.filter((event) => event.type === "assistant/message").at(-1).data.message.content;
    }
  };
}

test("真实宿主循环：机器和 Agent 已选、无项目时，原文派发到回显均不调用主控模型", async (t) => {
  const h = await harness(t, { machineId: "local-mac", agentId: "local-mac:codex" });
  const prompt = "  请处理这个文件\n保留原文和 https://example.com/doc。  ";
  assert.deepEqual(await h.send(prompt), [{ type: "text", text: "Worker 原始结果" }]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].dispatch.prompt, prompt);
  assert.equal(h.calls[0].dispatch.agentId, "local-mac:codex");
  assert.deepEqual(h.calls[1], { wait: "task-direct" });
  assert.deepEqual(h.agent.session.events.filter((e) => e.type === "tool/call").map((e) => e.data.name), ["dispatch_task", "wait_task"]);
});

test("原生多图/纯图片：宿主存储 → 无模型直派 → 真实 Gateway → Worker 本地文件", { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-image-e2e-"));
  let worker, workerLoop, hub;
  t.after(async () => {
    worker?.stop();
    if (workerLoop) await workerLoop;
    if (hub) await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const workerRoot = path.join(dir, "worker");
  fs.mkdirSync(workerRoot);
  const catalog = createCatalog({ allowedRoots: [dir] });
  const store = createTaskStore({ dataDir: path.join(dir, "tasks") });
  const approvals = createApprovalBroker({ store });
  const quiet = { log() {}, error() {}, warn() {} };
  hub = createGatewayHub({ catalog, tokens: { images: "test-images" }, port: 0, log: quiet });
  await hub.start();
  const received = [];
  worker = runGatewayWorker({
    hubUrl: `ws://127.0.0.1:${hub.address().port}/`, gatewayToken: "test-images", machineId: "images",
    providers: ["mock"], allowedRoots: [workerRoot], discoverWorkspaces: false, log: quiet,
    adapterFor: () => {
      const adapter = createLocalAgentAdapter("mock");
      adapter.runtime.run = async function* (context) {
        received.push({ prompt: context.message, files: context.attachments.map((item) => ({
          path: item.path, bytes: fs.readFileSync(item.path), mode: fs.statSync(item.path).mode & 0o777
        })) });
        yield { type: "complete", payload: { message: `收到 ${context.attachments.length} 张图片` } };
      };
      return adapter;
    }
  });
  workerLoop = worker.loop();
  await waitFor(() => catalog.listAgents().some((agent) => agent.agentId === "images:mock"));
  catalog.updateAgentCapabilities("images:mock", { input_modalities: ["image"], models: ["vision"], default_model: "vision" });
  const h = await harness(t, { machineId: "images", agentId: "images:mock" }, {
    createEngine(ctx) {
      new LocalAttachmentStore(ctx, { dshHome: path.join(dir, "master") });
      return createTaskEngine({
        catalog, store, approvals,
        readImage: (ref, signal) => ctx.attachments.readImage(ref, signal),
        adapterFor: (agent) => ({
          runTurn: (context) => hub.run({ machineId: agent.machineId, context }),
          cancelTurn: (context) => hub.cancelTurn({ machineId: agent.machineId, context })
        })
      });
    }
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==", "base64");
  const ref = await h.ctx.attachments.saveImage({ data: png, mediaType: "image/png", name: "../../照片.png" });
  const image = { type: "image", attachment: ref };
  assert.match((await h.send("", [image]))[0].text, /收到 1 张图片/);
  assert.match((await h.send("", [image, { type: "text", text: "比较两张图" }, image]))[0].text, /收到 2 张图片/);
  assert.deepEqual(received.map((item) => item.prompt), ["", "比较两张图"]);
  for (const { files } of received) for (const file of files) {
    assert.deepEqual(file.bytes, png);
    assert.equal(file.mode, 0o600);
    assert.ok(!file.path.startsWith(h.ctx.attachments.root));
    assert.equal(fs.existsSync(file.path), false, "完成后清理 Worker 临时图片");
  }
  assert.equal(h.calls.length, 0, "整个过程不调用主控模型或查询目录");
  const tasks = store.listTasks();
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0].attachments[0], { image: ref });
  assert.ok(!fs.readFileSync(store.file, "utf8").includes(png.toString("base64")), "任务日志不存 base64");
  assert.ok(!JSON.stringify(h.agent.session.events).includes(png.toString("base64")), "模型会话不存 base64");
});

test("完整选择及同一会话后续输入每轮只派发一次", async (t) => {
  const selected = { machineId: "remote", agentId: "remote:codex", workspaceId: "repo-1", workspace: { workspaceId: "repo-1" } };
  const h = await harness(t, selected);
  await h.send("第一轮");
  selected.agentId = "remote:kimi";
  await h.send("第二轮");
  const dispatches = h.calls.filter((call) => call.dispatch).map((call) => call.dispatch);
  assert.deepEqual(dispatches.map((call) => [call.agentId, call.workspaceId, call.prompt]), [
    ["remote:codex", "repo-1", "第一轮"], ["remote:kimi", "repo-1", "第二轮"]
  ]);
  assert.equal(new Set(dispatches.map((call) => call.dispatchKey)).size, 2);
  assert.ok(!h.calls.includes("model"));
});

test("未选 Agent 的会话仍由主控模型处理", async (t) => {
  const h = await harness(t, { machineId: "remote" });
  await h.send("请自动安排");
  assert.deepEqual(h.calls, ["model"]);
});

test("自动选择由 Jev 决策并沿用直派与等待工具链", async (t) => {
  const oldFlag = process.env.DSH_ALPHA_JEV_ROUTING;
  const oldKey = process.env.TYPESAFE_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DSH_ALPHA_JEV_ROUTING = "1";
  process.env.TYPESAFE_API_KEY = "test-only";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ answers: {
    target: { type: "choice", choice: "a0", confidence: 0.95, probabilities: { a0: 0.95, unsure: 0.05 } },
    workspace: { type: "choice", choice: "none", confidence: 0.95, probabilities: { none: 0.95, unsure: 0.05 } },
    needsShell: { type: "noul", noul: 0.1 }
  } }) });
  t.after(() => {
    if (oldFlag === undefined) delete process.env.DSH_ALPHA_JEV_ROUTING;
    else process.env.DSH_ALPHA_JEV_ROUTING = oldFlag;
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  });
  const h = await harness(t, { machineId: "remote" }, { catalogRows: [{
    agentId: "remote:codex", machineId: "remote", provider: "codex", available: true,
    capabilities: { models: [] }, machine: { repos: [], load: { active_turns: 0 } }
  }] });
  assert.deepEqual(await h.send("请自动安排"), [{ type: "text", text: "Worker 原始结果" }]);
  assert.equal(h.calls.find((call) => call.dispatch)?.dispatch.agentId, "remote:codex");
  assert.ok(!h.calls.includes("model"));
});

test("直派目标不可用时回显错误，不调用模型改选或重复派发", async (t) => {
  const h = await harness(t, { agentId: "remote:codex" }, { dispatchError: "所选 Agent 离线" });
  assert.match((await h.send("执行"))[0].text, /所选 Agent 离线/);
  assert.equal(h.calls.length, 1);
});

test("Worker 审批阻塞后才调用主控模型", async (t) => {
  const h = await harness(t, { agentId: "remote:codex" }, {
    outcome: { taskId: "task-direct", status: "blocked", pendingApprovals: [{ id: "approval-1" }] }
  });
  await h.send("执行");
  assert.equal(h.calls[0].dispatch.prompt, "执行");
  assert.deepEqual(h.calls[1], { wait: "task-direct" });
  assert.equal(h.calls[2], "model");
});

test("直派等待期间的用户补充在下一步继续原文派发，不会被结果回显吞掉", async (t) => {
  let h;
  let waits = 0;
  h = await harness(t, { agentId: "remote:codex" }, {
    waitTask: async () => {
      if (++waits === 1) h.agent.steer(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "补充要求" }] }));
      return { taskId: "task-direct", status: "completed", result: "完成" };
    }
  });
  await h.send("原始要求");
  assert.deepEqual(h.calls.filter((call) => call.dispatch).map((call) => call.dispatch.prompt), ["原始要求", "补充要求"]);
  assert.equal(waits, 2);
  assert.ok(!h.calls.includes("model"));
});

test("非 Alpha 会话共享同一个 LLM 服务时不被直派拦截", async (t) => {
  const h = await harness(t, { agentId: "remote:codex" });
  const other = await h.ctx.agents.create({ sessionId: "ordinary", agentOptions: { provider: "spy", model: "spy-model" } });
  t.after(async () => { await other.dispose(); });
  other.agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "普通消息" }] }));
  await Promise.all([other.agent.whenIdle(), h.send("直派消息")]);
  assert.equal(h.calls.filter((call) => call === "model").length, 1);
  assert.deepEqual(h.calls.filter((call) => call.dispatch).map((call) => call.dispatch.prompt), ["直派消息"]);
});

test("Worker 被停止或失败时直接展示结果，不让主控重试", async (t) => {
  for (const status of ["cancelled", "failed"]) {
    await t.test(status, async (t) => {
      const h = await harness(t, { agentId: "remote:codex" }, { outcome: { taskId: "task-direct", status, error: "原始原因" } });
      assert.match((await h.send("执行"))[0].text, /原始原因/);
      assert.equal(h.calls.length, 2);
    });
  }
});

test("失效项目与无法转发的附件明确报错，不丢内容或自动改派", async (t) => {
  const h = await harness(t, { agentId: "remote:codex", workspaceId: "gone", workspace: null });
  assert.match((await h.send("执行"))[0].text, /所选工作区已不可用/);
  assert.equal(h.calls.length, 0);
  assert.match((await h.send("", [{ type: "unsupported-file", name: "unknown" }]))[0].text, /无法转发此附件类型/);
  assert.equal(h.calls.length, 0);
});

test("等待中的宿主停止信号传到工具，停止后不会触发主控调用", async (t) => {
  let waiting;
  const started = new Promise((resolve) => { waiting = resolve; });
  const h = await harness(t, { agentId: "remote:codex" }, {
    waitTask: async (_id, { signal }) => {
      waiting();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { taskId: "task-direct", status: "running" };
    }
  });
  h.agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "执行" }] }));
  await started;
  h.agent.cancel("user");
  await h.agent.whenIdle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.agent.status, "idle");
});
