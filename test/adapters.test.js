const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ADAPTERS,
  createLocalAgentAdapter,
  listLocalAgentProviders,
  probeAvailability,
  buildCapabilitiesFor
} = require("../src/lib/adapters.js");
const { normalizeAgentSettings } = require("../src/adapters/vendor/shared/capabilities.js");

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
  assert.deepEqual(caps.models, []);
});

test("非 Codex provider 不误广告 GPT 模型，未指定模型时交给各 CLI 默认值", () => {
  const codex = buildCapabilitiesFor("codex");
  const claude = buildCapabilitiesFor("claude-code");
  const kimi = buildCapabilitiesFor("kimi-code");
  assert.ok(codex.models.includes("gpt-5.5"));
  assert.deepEqual(claude.models, []);
  assert.deepEqual(kimi.models, []);
  assert.equal(normalizeAgentSettings({}, {}, claude).model, null);
  assert.equal(normalizeAgentSettings({}, {}, kimi).model, null);
  assert.equal(normalizeAgentSettings({ model: "sonnet" }, {}, claude).model, "sonnet");
  assert.throws(() => normalizeAgentSettings({ model: "not-a-codex-model" }, {}, codex), /model 只能是/);
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

test("providers 注册表覆盖阶段 0 目标及新增 provider", () => {
  for (const name of ["codex", "claude-code", "kimi-code", "opencode", "qoder", "workbuddy", "mock"]) {
    assert.ok(ADAPTERS[name], `缺少 ${name}`);
  }
  assert.equal(listLocalAgentProviders().length, Object.keys(ADAPTERS).length);
});
