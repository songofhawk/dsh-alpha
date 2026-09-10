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

async function harness(t, selected, { dispatchError, outcome, waitTask } = {}) {
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
  ctx.provide("alphaCatalog", { listAgents: () => { calls.push("catalog"); return []; } });
  ctx.provide("alphaWorkspaces", { selection: () => selected, list: () => [] });
  ctx.provide("alphaApprovals", { listPending: () => [] });
  ctx.provide("alphaEngine", {
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
  assert.match((await h.send("", [{ type: "image", attachment: { attachmentId: "image-1" } }]))[0].text, /无法转发此附件类型/);
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
