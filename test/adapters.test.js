const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ADAPTERS,
  createLocalAgentAdapter,
  listDefaultAgentProviders,
  listLocalAgentProviders,
  probeAvailability,
  buildCapabilitiesFor
} = require("../src/lib/adapters.js");
const { normalizeAgentSettings, supportsImageInput } = require("../src/adapters/vendor/shared/capabilities.js");
const { KimiCodeRuntime, convertKimiSessionUpdate, kimiModeForSettings } = require("../src/adapters/vendor/runtimes/kimi-code-runtime.js");
const { convertOpenCodeSessionUpdate } = require("../src/adapters/vendor/runtimes/opencode-runtime.js");

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

test("Worker 默认使用 auto-review，Kimi 映射为 auto 且保留按需审批", () => {
  const settings = normalizeAgentSettings({}, {}, buildCapabilitiesFor("kimi-code"));
  assert.equal(settings.mode, "auto-review");
  assert.equal(settings.approval_policy, "on-request");
  assert.equal(kimiModeForSettings(settings), "auto");
});

test("非 Codex provider 不误广告 GPT 模型，未指定模型时交给各 CLI 默认值", () => {
  const codex = buildCapabilitiesFor("codex");
  const claude = buildCapabilitiesFor("claude-code");
  const kimi = buildCapabilitiesFor("kimi-code");
  const zcode = buildCapabilitiesFor("zcode");
  assert.ok(codex.models.includes("gpt-5.5"));
  assert.deepEqual(claude.models, []);
  assert.deepEqual(kimi.models, []);
  assert.deepEqual(zcode.models, []);
  assert.equal(normalizeAgentSettings({}, {}, claude).model, null);
  assert.equal(normalizeAgentSettings({}, {}, kimi).model, null);
  assert.equal(normalizeAgentSettings({ model: "sonnet" }, {}, claude).model, "sonnet");
  assert.throws(() => normalizeAgentSettings({ model: "not-a-codex-model" }, {}, codex), /model 只能是/);
});

test("图片能力按目标模型的 input modalities 判断，并兼容旧 local_image 标记", () => {
  const capabilities = {
    input_modalities: ["text"],
    model_input_modalities: {
      "worker-vision": ["text", "image"],
      "worker-local-image": ["text", "local_image"]
    }
  };
  assert.equal(supportsImageInput(capabilities, "worker-vision"), true);
  assert.equal(supportsImageInput(capabilities, "worker-local-image"), true);
  assert.equal(supportsImageInput(capabilities, "text-only"), false);
});

test("Kimi 能力目录来自 Agent API 的 session/new configOptions", async () => {
  let closed = false;
  const client = {
    async initialize() {},
    async request(method, payload) {
      assert.equal(method, "session/new");
      assert.equal(payload.cwd, "/worker/project");
      return {
        configOptions: [
          { id: "model", options: [{ value: "kimi-live-model" }] },
          { id: "thinking", options: [{ value: "medium" }, { value: "max" }] }
        ]
      };
    },
    close() {
      closed = true;
    }
  };
  const runtime = new KimiCodeRuntime({ clientFactory: () => client });
  const capabilities = await runtime.discoverCapabilities({ cwd: "/worker/project" });
  assert.deepEqual(capabilities.models, ["kimi-live-model"]);
  assert.equal(capabilities.default_model, "kimi-live-model");
  assert.deepEqual(capabilities.reasoning_efforts, ["medium", "max"]);
  assert.equal(closed, true);
});

test("ACP 工具进度保留工具身份和可见详情", () => {
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    title: "读取 nginx 配置",
    status: "in_progress",
    content: { text: "正在读取 /etc/nginx/nginx.conf" }
  };
  for (const convert of [convertKimiSessionUpdate, convertOpenCodeSessionUpdate]) {
    assert.deepEqual(convert(update), [{
      type: "activity",
      payload: {
        message: "读取 nginx 配置：正在读取 /etc/nginx/nginx.conf",
        kind: "tool_progress",
        tool_use_id: "tool-1",
        tool_name: "读取 nginx 配置"
      }
    }]);
  }
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
  for (const name of ["codex", "claude-code", "kimi-code", "opencode", "qoder", "workbuddy", "zcode", "mock"]) {
    assert.ok(ADAPTERS[name], `缺少 ${name}`);
  }
  assert.equal(listLocalAgentProviders().length, Object.keys(ADAPTERS).length);
  assert.equal(listDefaultAgentProviders().includes("zcode"), false, "ZCode 必须由 worker 显式启用");
});
