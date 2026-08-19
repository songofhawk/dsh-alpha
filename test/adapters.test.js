const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ADAPTERS,
  createLocalAgentAdapter,
  listLocalAgentProviders,
  probeAvailability,
  buildCapabilitiesFor
} = require("../src/lib/adapters.js");

test("provider 别名归一（claude → claude-code）", () => {
  const adapter = createLocalAgentAdapter("claude");
  assert.equal(adapter.id, "claude-code");
});

test("未知 provider 抛 400", () => {
  assert.throws(() => createLocalAgentAdapter("not-a-provider"), { statusCode: 400 });
});

test("mock 始终可用；其他 provider 走 resolver 探测", () => {
  assert.deepEqual(probeAvailability("mock"), { available: true, reason: null });
  const result = probeAvailability("codex");
  assert.equal(typeof result.available, "boolean");
  if (!result.available) assert.equal(typeof result.reason, "string");
});

test("buildCapabilitiesFor 渲染能力结构", () => {
  const caps = buildCapabilitiesFor("kimi-code");
  assert.deepEqual(caps.providers, ["kimi-code"]);
  assert.ok(caps.modes.length >= 3);
  assert.ok(caps.models.length > 0);
});

test("mock runtime 事件流归一化（runTurn）", async () => {
  const adapter = createLocalAgentAdapter("mock");
  const events = [];
  for await (const event of adapter.runTurn({
    session: { id: "s1", provider: "mock" },
    project: { path: "/tmp" },
    message: "hello",
    settings: { mode: "auto-review", approval_policy: "never", model: "x", reasoning_effort: "high" }
  })) {
    events.push(event);
  }
  assert.equal(events[0].type, "activity");
  assert.ok(events.some((e) => e.type === "tool_use"));
  assert.ok(events.some((e) => e.type === "delta"));
  assert.equal(events[events.length - 1].type, "complete");
  assert.match(events[events.length - 1].payload.message, /hello/);
});

test("providers 注册表覆盖阶段 0 目标", () => {
  for (const name of ["codex", "claude-code", "kimi-code", "mock"]) {
    assert.ok(ADAPTERS[name], `缺少 ${name}`);
  }
  assert.equal(listLocalAgentProviders().length, Object.keys(ADAPTERS).length);
});