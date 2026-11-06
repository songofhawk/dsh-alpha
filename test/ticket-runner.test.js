// Ticket 执行层：续接、steer、排队、离线等待、改归属、重启恢复（第 6.4 节）。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCatalog } = require("../src/lib/catalog.js");
const { createTaskStore } = require("../src/lib/task-store.js");
const { createApprovalBroker } = require("../src/lib/approvals.js");
const { createTaskEngine } = require("../src/lib/task-engine.js");
const { createTicketStore } = require("../src/lib/ticket-store.js");
const { createTicketEngine } = require("../src/lib/ticket-engine.js");
const { createTicketRunner } = require("../src/lib/ticket-runner.js");
const { buildCapabilitiesFor, probeAvailability } = require("../src/lib/adapters.js");
const { waitFor, tmpDir, cleanupDir } = require("./helpers.js");

// 可控 runtime：每个 turn 等测试放行，记录收到的 session / prompt / steer。
function scriptedAdapter(calls) {
  const adapter = {
    id: "scripted",
    async *runTurn(context) {
      const call = { session: context.session, prompt: context.message, requestApproval: context.requestApproval, steered: [] };
      call.done = new Promise((resolve) => { call.finish = resolve; });
      calls.push(call);
      yield { type: "runtime_session", payload: { runtime_session_id: context.session.runtime_session_id || `rt-${calls.length}` } };
      const outcome = await call.done;
      if (outcome?.error) throw new Error(outcome.error);
      yield { type: "complete", payload: { message: outcome?.text || `完成：${context.message}` } };
    },
    async cancelTurn() { calls.at(-1)?.finish({ error: "已取消" }); return {}; },
    async steerTurn({ session, message }) {
      calls.find((call) => call.session.id === session.id).steered.push(message);
      return {};
    }
  };
  return adapter;
}

function makeEnv(t, { continuity = { session_resume: true, steer: true }, dataDir = null, store: taskStore = null } = {}) {
  const dir = dataDir || tmpDir("alpha-runner-");
  if (!dataDir) t.after(() => cleanupDir(dir));
  const catalog = createCatalog({
    allowedRoots: [dir],
    adapterProvider: {
      capabilitiesFor: (provider) => ({ ...buildCapabilitiesFor(provider), session_resume: false, steer: false, ...continuity }),
      probeAvailability
    }
  });
  catalog.registerAgent({ provider: "mock" });
  const agentId = catalog.listAgents()[0].agentId;
  const tasks = taskStore || createTaskStore({ dataDir: dir });
  const interrupted = tasks.recoverInterrupted();
  const store = createTicketStore({ database: tasks.database });
  const approvals = createApprovalBroker({ store: tasks, persistence: store });
  approvals.recoverInterrupted();
  const calls = [];
  const engine = createTaskEngine({ catalog, store: tasks, approvals, adapterFor: () => scriptedAdapter(calls), defaults: { mode: "default" }, allowedRoots: [dir] });
  const deps = {};
  const tickets = createTicketEngine({ store, deps });
  const runner = createTicketRunner({ store, tickets, tasks, engine, catalog, approvals, pumpIntervalMs: 0 });
  Object.assign(deps, runner.stageDeps);
  t.after(() => { for (const call of calls) call.finish({}); runner.dispose(); });
  let eventId = 0;
  const message = (text, patch = {}) => ({ source: "web", sourceEventId: `m${++eventId}`, text, ...patch });
  return { dir, catalog, agentId, tasks, store, approvals, engine, tickets, runner, calls, message, interrupted };
}

const stage = (env, ticket) => env.tickets.stageOfTicket(ticket.id);

test("首个 Run 保持用户原文，runtime 会话写回 Binding，下一条消息续接同一会话", async (t) => {
  const env = makeEnv(t);
  const ticket = env.runner.open({ trigger: env.message("修复登录 bug"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  assert.equal(env.calls[0].prompt, "修复登录 bug");
  assert.equal(env.calls[0].session.runtime_session_id, undefined);
  await waitFor(() => env.store.getTicket(ticket.id).binding.runtimeSessionId === "rt-1");
  assert.equal(stage(env, ticket), "working/running");

  env.calls[0].finish({ text: "修好了" });
  await waitFor(() => stage(env, ticket) === "idle/replied");
  assert.equal(env.store.getTicket(ticket.id).summary, "修好了");

  env.runner.submit(ticket.id, env.message("再加个回归测试"), { via: "jev" });
  await waitFor(() => env.calls.length === 2);
  assert.equal(env.calls[1].prompt, "再加个回归测试");
  assert.equal(env.calls[1].session.runtime_session_id, "rt-1");
  assert.equal(stage(env, ticket), "working/running");
});

test("运行中的 Run 支持 steer 时立即送达，不开第二个 Run", async (t) => {
  const env = makeEnv(t);
  const ticket = env.runner.open({ trigger: env.message("任务一"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  await waitFor(() => env.tasks.getTask(env.runner.activeRunOf(ticket.id)).status === "running");
  const { input } = env.runner.submit(ticket.id, env.message("顺便看下日志"));
  await waitFor(() => env.store.getInput(input.id).status === "delivered");
  assert.deepEqual(env.calls[0].steered, ["顺便看下日志"]);
  assert.equal(env.calls.length, 1, "同一 Ticket 不得并行第二个 Run");
});

test("不支持 steer 时排队，当前 Run 结束后合并成下一个 Run", async (t) => {
  const env = makeEnv(t, { continuity: { session_resume: true } });
  const ticket = env.runner.open({ trigger: env.message("任务一"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  env.runner.submit(ticket.id, env.message("补充一"));
  env.runner.submit(ticket.id, env.message("补充二"));
  assert.equal(env.store.pendingInputCount(ticket.id), 2);
  env.calls[0].finish({});
  await waitFor(() => env.calls.length === 2);
  assert.equal(env.calls[1].prompt, "补充一\n\n补充二");
  assert.equal(env.calls[1].session.runtime_session_id, "rt-1");
  assert.equal(stage(env, ticket), "working/running", "中间轮次不算已回复");
});

test("不支持 resume 时用任务记录重建上下文", async (t) => {
  const env = makeEnv(t, { continuity: {} });
  const ticket = env.runner.open({ trigger: env.message("写周报"), title: "周报", route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  env.calls[0].finish({ text: "周报初稿" });
  await waitFor(() => stage(env, ticket) === "idle/replied");
  env.runner.submit(ticket.id, env.message("改短一点"));
  await waitFor(() => env.calls.length === 2);
  assert.equal(env.calls[1].session.runtime_session_id, undefined);
  assert.match(env.calls[1].prompt, /周报/);
  assert.match(env.calls[1].prompt, /上次结果：\n周报初稿/);
  assert.match(env.calls[1].prompt, /新的输入：\n改短一点/);
});

test("resume 失败且无进展时回退到重建上下文，只重试一次", async (t) => {
  const env = makeEnv(t);
  const ticket = env.runner.open({ trigger: env.message("第一轮"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  env.calls[0].finish({ text: "第一轮结果" });
  await waitFor(() => stage(env, ticket) === "idle/replied");
  env.runner.submit(ticket.id, env.message("第二轮"));
  await waitFor(() => env.calls.length === 2);
  assert.equal(env.calls[1].session.runtime_session_id, "rt-1");
  env.calls[1].finish({ error: "thread not found" });
  await waitFor(() => env.calls.length === 3);
  assert.equal(env.calls[2].session.runtime_session_id, undefined);
  assert.match(env.calls[2].prompt, /新的输入：\n第二轮/);
  env.calls[2].finish({ error: "还是失败" });
  await waitFor(() => stage(env, ticket) === "person/blocked");
  assert.equal(env.calls.length, 3);
});

test("用户钉死的目标不可用时输入留在队列，恢复后由泵继续", async (t) => {
  const env = makeEnv(t);
  env.catalog.markAgentUnavailable(env.agentId, "离线");
  const ticket = env.runner.open({ trigger: env.message("等机器"), constraints: { agentId: env.agentId, source: "user" } });
  assert.equal(stage(env, ticket), "waiting/machine");
  assert.equal(env.calls.length, 0);
  env.catalog.getAgent(env.agentId).available = true;
  env.catalog.getAgent(env.agentId).unavailableReason = null;
  env.runner.pumpAll();
  await waitFor(() => env.calls.length === 1);
  assert.equal(env.store.getTicket(ticket.id).binding.pin, "user");
});

test("路由建议的目标不可用时自动改派其它可用 agent，不带走旧会话", async (t) => {
  const env = makeEnv(t);
  const suggested = env.agentId;
  env.catalog.markAgentUnavailable(suggested, "claude 不可用");
  const fallback = env.catalog.registerAgent({ provider: "codex", checkAvailable: false }).agentId;
  const ticket = env.runner.open({ trigger: env.message("做点事"), route: { agentId: suggested } });
  await waitFor(() => env.calls.length === 1);
  assert.equal(env.calls[0].session.provider, "codex");
  assert.equal(env.calls[0].session.runtime_session_id, undefined);
  assert.match(env.calls[0].prompt, /路由备注：建议的 .* 不可用，已改派其它可用 agent/);
  const binding = env.store.getTicket(ticket.id).binding;
  assert.equal(binding.agentId, fallback);
  assert.equal(binding.pin, "auto");
  assert.equal(binding.reroutedFrom.agentId, suggested);
  env.calls[0].finish({ text: "好了" });
  await waitFor(() => stage(env, ticket) === "idle/replied");
  // 后续消息续接改派后的 agent，不会回试旧目标
  env.runner.submit(ticket.id, env.message("继续"));
  await waitFor(() => env.calls.length === 2);
  assert.equal(env.calls[1].session.provider, "codex");
});

test("改派后也没有可用 agent 时输入留队列，恢复后继续且不再反复改派", async (t) => {
  const env = makeEnv(t);
  env.catalog.markAgentUnavailable(env.agentId, "离线");
  const ticket = env.runner.open({ trigger: env.message("做事"), route: { agentId: env.agentId } });
  assert.equal(env.calls.length, 0, "唯一 agent 不可用：改派没有落点，输入留在队列");
  assert.equal(env.store.pendingInputCount(ticket.id), 1);
  const binding = env.store.getTicket(ticket.id).binding;
  assert.equal(binding.agentId, null);
  assert.ok(binding.lastError);
  env.catalog.getAgent(env.agentId).available = true;
  env.catalog.getAgent(env.agentId).unavailableReason = null;
  env.runner.pumpAll();
  await waitFor(() => env.calls.length === 1);
  assert.equal(env.store.getTicket(ticket.id).binding.agentId, env.agentId);
});

test("人工换绑（binding.pin=user）后目标不可用时等待人工，不自动改派", async (t) => {
  const env = makeEnv(t);
  const ticket = env.runner.open({ trigger: env.message("先做"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  env.calls[0].finish({ text: "好了" });
  await waitFor(() => stage(env, ticket) === "idle/replied");
  // 模拟 update RPC 的人工换绑（ticket-service update 写入 pin:"user"）
  const other = env.catalog.registerAgent({ provider: "codex", checkAvailable: false }).agentId;
  const before = env.store.getTicket(ticket.id).binding;
  env.store.updateTicket(ticket.id, {
    binding: { ...before, agentId: other, pin: "user", runtimeSessionId: null }
  });
  env.catalog.markAgentUnavailable(other, "离线");
  env.runner.submit(ticket.id, env.message("继续"));
  assert.equal(env.calls.length, 1, "用户钉死的目标不可用：不派发，等人工");
  assert.equal(stage(env, ticket), "waiting/machine");
});

test("审批落库，任务停在 person/approval 不自动拒绝；批准后继续", async (t) => {
  const env = makeEnv(t);
  const ticket = env.runner.open({ trigger: env.message("改数据库"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  const decision = env.calls[0].requestApproval({ runtime_request_id: "ap-1", command: "drop table" });
  await waitFor(() => stage(env, ticket) === "person/approval");
  assert.equal(env.store.getApproval("ap-1").ticketId, ticket.id);
  assert.throws(() => env.runner.decideApproval("tkt_other", "ap-1", "approved"), /没有这条审批/);
  env.runner.decideApproval(ticket.id, "ap-1", "approved");
  assert.equal((await decision).status, "approved");
  assert.equal(env.store.getApproval("ap-1").status, "approved");
  assert.equal(stage(env, ticket), "working/running");
});

test("runtime 复用审批 ID 时，新审批不会被旧记录吞掉", async (t) => {
  const env = makeEnv(t);
  const first = env.runner.open({ trigger: env.message("任务一"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  const decision = env.calls[0].requestApproval({ runtime_request_id: "1" });
  await waitFor(() => stage(env, first) === "person/approval");
  env.runner.decideApproval(first.id, "1", "rejected");
  await decision;
  const second = env.runner.open({ trigger: env.message("任务二"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 2);
  const again = env.calls[1].requestApproval({ runtime_request_id: "1" });
  await waitFor(() => stage(env, second) === "person/approval");
  env.runner.decideApproval(second.id, "1", "approved");
  assert.equal((await again).status, "approved");
  assert.equal(env.store.getApproval("1").ticketId, second.id);
});

test("Run 结束时遗留审批收敛为 expired 且 fail-closed", async (t) => {
  const env = makeEnv(t);
  const ticket = env.runner.open({ trigger: env.message("任务"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  const decision = env.calls[0].requestApproval({ runtime_request_id: "ap-2" });
  await waitFor(() => stage(env, ticket) === "person/approval");
  env.calls[0].finish({ error: "worker 审批等待超时" });
  assert.equal((await decision).status, "rejected");
  await waitFor(() => stage(env, ticket) === "person/blocked");
  assert.equal(env.store.getApproval("ap-2").status, "expired");
});

test("叫停取消活动 Run、清掉排队输入，之后的消息不会重开", async (t) => {
  const env = makeEnv(t, { continuity: {} });
  const ticket = env.runner.open({ trigger: env.message("长任务"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  env.runner.submit(ticket.id, env.message("排队中"));
  await env.runner.stop(ticket.id);
  await waitFor(() => env.runner.activeRunOf(ticket.id) === null);
  assert.equal(env.store.pendingInputCount(ticket.id), 0);
  assert.equal(stage(env, ticket), "ended/stopped");
  assert.equal(env.runner.submit(ticket.id, env.message("继续")).rejected, "stopped");
  assert.equal(env.calls.length, 1);
});

test("验收结束后人的新消息重开任务并续接", async (t) => {
  const env = makeEnv(t);
  const ticket = env.runner.open({ trigger: env.message("任务"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 1);
  env.calls[0].finish({ text: "好了" });
  await waitFor(() => stage(env, ticket) === "idle/replied");
  await env.runner.close(ticket.id, { outcome: "done" });
  assert.equal(stage(env, ticket), "ended/done");
  env.runner.submit(ticket.id, env.message("还有个问题"));
  await waitFor(() => env.calls.length === 2);
  assert.equal(env.calls[1].session.runtime_session_id, "rt-1");
  assert.equal(env.store.getTicket(ticket.id).status, "open");
});

test("改归属：已送达的输入向原 Worker 发更正，并在目标任务重新送达", async (t) => {
  const env = makeEnv(t);
  const first = env.runner.open({ trigger: env.message("任务 A"), route: { agentId: env.agentId } });
  const second = env.runner.open({ trigger: env.message("任务 B"), route: { agentId: env.agentId } });
  await waitFor(() => env.calls.length === 2);
  await waitFor(() => env.tasks.getTask(env.runner.activeRunOf(first.id)).status === "running");
  await waitFor(() => env.tasks.getTask(env.runner.activeRunOf(second.id)).status === "running");
  const wrong = env.message("这句其实说的是 B");
  const { input } = env.runner.submit(first.id, wrong);
  await waitFor(() => env.store.getInput(input.id).status === "delivered");
  const decision = env.runner.reattribute(input.triggerId, { toTicketId: second.id });
  assert.equal(decision.ticketId, second.id);
  await waitFor(() => env.calls[0].steered.length === 2);
  assert.match(env.calls[0].steered[1], /^更正：.*不属于这个任务/);
  await waitFor(() => env.calls[1].steered.includes("这句其实说的是 B"));
  assert.deepEqual(env.store.listTriggersOfTicket(first.id).map((row) => row.text), ["任务 A"]);
});

test("主控重启：进行中的 Ticket 发起恢复 Run，带重启提示并续接；旧任务不恢复", async (t) => {
  const dir = tmpDir("alpha-restart-");
  t.after(() => cleanupDir(dir));
  const before = makeEnv(t, { dataDir: dir });
  const ticket = before.runner.open({ trigger: before.message("长任务"), route: { agentId: before.agentId } });
  await waitFor(() => before.calls.length === 1);
  await waitFor(() => before.store.getTicket(ticket.id).binding.runtimeSessionId === "rt-1");
  const pendingApproval = before.calls[0].requestApproval({ runtime_request_id: "ap-restart" });
  pendingApproval.catch(() => {});
  await waitFor(() => before.store.pendingApprovalCount(ticket.id) === 1);
  const legacy = before.tasks.createTask({ agentId: before.agentId, machineId: "x", provider: "mock", prompt: "旧任务", projectPath: dir, settings: {} });
  before.runner.dispose();
  before.tasks.close();

  const after = makeEnv(t, { dataDir: dir });
  assert.equal(after.tasks.getTask(legacy.id).status, "failed");
  assert.equal(after.store.pendingApprovalCount(ticket.id), 0, "上一进程的审批已无法送达");
  assert.equal(after.store.getApproval("ap-restart").status, "interrupted");
  after.runner.recover(after.interrupted);
  await waitFor(() => after.calls.length === 1);
  assert.equal(after.calls[0].session.runtime_session_id, "rt-1");
  assert.match(after.calls[0].prompt, /主控重启/);
  assert.match(after.calls[0].prompt, /长任务/);
  await waitFor(() => after.runner.activeRunOf(ticket.id) !== null);
  assert.equal(after.tickets.stageOfTicket(ticket.id), "working/running");
});
