// 本机 agent adapter：vendorized agent-anywhere runtimes 之上的薄选择层。
// provider：codex / claude-code / kimi-code / dsh / opencode / qoder / workbuddy / zcode / mock。
//
// 阶段 4 收敛后，主控引擎 local 分支优先走 ctx.subagents 上的官方 provider
// （见 lib/subagent-adapters.js）；本文件保留给：
//  - gateway worker（远端执行保留 vendor runtime：审批冒泡是差异化通道）；
//  - mock（无官方对应 provider）；
//  - 回退路径：无 seam / provider 未注册 / DSH_ALPHA_LOCAL_LEGACY=1。

const path = require("node:path");
const { buildCapabilities } = require("../adapters/vendor/shared/capabilities");
const { normalizeProviderName } = require("../adapters/vendor/shared/providers");
const { CodexAppServerRuntime } = require("../adapters/vendor/runtimes/codex-app-server-runtime");
const { ClaudeCodeHeadlessRuntime } = require("../adapters/vendor/runtimes/claude-code-headless-runtime");
const { KimiCodeRuntime } = require("../adapters/vendor/runtimes/kimi-code-runtime");
const { DshHeadlessRuntime, resolveDshExecutable } = require("../adapters/vendor/runtimes/dsh-headless-runtime");
const { OpenCodeRuntime } = require("../adapters/vendor/runtimes/opencode-runtime");
const { QoderRuntime } = require("../adapters/vendor/runtimes/qoder-headless-runtime");
const { WorkBuddyRuntime } = require("../adapters/vendor/runtimes/workbuddy-runtime");
const { ZCodeRuntime, resolveZCodeExecutable } = require("../adapters/vendor/runtimes/zcode-runtime");
const { MockRuntime } = require("../adapters/vendor/runtimes/mock-runtime");
const { resolveCodexExecutable } = require("../adapters/vendor/runtimes/codex-runtime");
const { resolveClaudeExecutable } = require("../adapters/vendor/runtimes/claude-code-headless-runtime");
const { resolveKimiExecutable } = require("../adapters/vendor/runtimes/kimi-acp-client");
const { resolveOpenCodeExecutable } = require("../adapters/vendor/runtimes/opencode-acp-client");
const { resolveQoderExecutable } = require("../adapters/vendor/runtimes/qoder-headless-runtime");
const { resolveWorkBuddyExecutable } = require("../adapters/vendor/runtimes/workbuddy-runtime");
const { commandExists } = require("./catalog");
const { materializeImages } = require("./image-attachments");

// 续接能力由 adapter 声明，主控不靠 provider 名字判断（docs/superagent-design.md 第 6.4 节）：
// session_resume：能用 session.runtime_session_id 续接已有 runtime 会话；
// steer：能把输入追加进运行中的 turn。
const ADAPTERS = {
  codex: {
    id: "codex",
    kind: "local-process",
    continuity: { session_resume: true, steer: true },
    createRuntime: () => new CodexAppServerRuntime({ provider: "codex" }),
    resolveExecutable: () => resolveCodexExecutable()
  },
  "claude-code": {
    id: "claude-code",
    kind: "local-process",
    continuity: { session_resume: true },
    createRuntime: () => new ClaudeCodeHeadlessRuntime({ provider: "claude-code" }),
    resolveExecutable: () => resolveClaudeExecutable()
  },
  "kimi-code": {
    id: "kimi-code",
    kind: "local-process",
    continuity: { session_resume: true },
    createRuntime: () => new KimiCodeRuntime({ provider: "kimi-code" }),
    resolveExecutable: () => resolveKimiExecutable()
  },
  dsh: {
    id: "dsh",
    kind: "local-process",
    createRuntime: () => new DshHeadlessRuntime(),
    resolveExecutable: () => resolveDshExecutable()
  },
  opencode: {
    id: "opencode",
    kind: "local-process",
    continuity: { session_resume: true },
    createRuntime: () => new OpenCodeRuntime({ provider: "opencode" }),
    resolveExecutable: () => resolveOpenCodeExecutable()
  },
  qoder: {
    id: "qoder",
    kind: "local-process",
    continuity: { session_resume: true },
    createRuntime: () => new QoderRuntime({ provider: "qoder" }),
    resolveExecutable: () => resolveQoderExecutable()
  },
  workbuddy: {
    id: "workbuddy",
    kind: "local-process",
    continuity: { session_resume: true },
    createRuntime: () => new WorkBuddyRuntime({ provider: "workbuddy" }),
    resolveExecutable: () => resolveWorkBuddyExecutable()
  },
  zcode: {
    id: "zcode",
    kind: "local-process",
    continuity: { session_resume: true },
    createRuntime: () => new ZCodeRuntime({ provider: "zcode" }),
    resolveExecutable: () => resolveZCodeExecutable()
  },
  mock: {
    id: "mock",
    kind: "local-process",
    continuity: { session_resume: true, steer: true },
    createRuntime: () => new MockRuntime({ delayMs: 10 }),
    resolveExecutable: () => "mock"
  }
};

function resolveAdapter(provider) {
  const normalized = normalizeProviderName(provider);
  const definition = ADAPTERS[normalized];
  if (!definition) {
    const error = new Error(`不支持的 provider：${provider}`);
    error.statusCode = 400;
    throw error;
  }
  return definition;
}

function createLocalAgentAdapter(provider) {
  const definition = resolveAdapter(provider);
  const runtime = definition.createRuntime();
  return {
    id: definition.id,
    kind: definition.kind,
    runtime,
    getCapabilities() {
      return { ...buildCapabilities(this.id), ...definition.continuity };
    },
    async discoverCapabilities(options = {}) {
      if (typeof runtime.discoverCapabilities === "function") {
        return { ...await runtime.discoverCapabilities(options), ...definition.continuity };
      }
      return this.getCapabilities();
    },
    async *runTurn(context) {
      const images = materializeImages(context.attachments);
      try {
        yield* runtime.run({ ...context, attachments: images.attachments });
      } finally {
        images.dispose();
      }
    },
    async cancelTurn(context) {
      if (typeof runtime.cancelTurn !== "function") return {};
      return runtime.cancelTurn(context);
    },
    async steerTurn(context) {
      if (definition.continuity?.steer !== true || typeof runtime.steerTurn !== "function") {
        const error = new Error(`${definition.id} 不支持向运行中的 turn 追加输入`);
        error.statusCode = 409;
        throw error;
      }
      return runtime.steerTurn(context);
    }
  };
}

function listLocalAgentProviders() {
  return Object.keys(ADAPTERS);
}

// 默认扫描所有真实 runtime；调用方再用 probeAvailability 筛出本机可执行的 Agent。
function listDefaultAgentProviders() {
  return Object.keys(ADAPTERS).filter((provider) => provider !== "mock");
}

function buildCapabilitiesFor(provider) {
  const definition = resolveAdapter(provider);
  return { ...buildCapabilities(definition.id, { providers: [definition.id] }), ...definition.continuity };
}

// 可用性探测：resolver 返回绝对路径时查存在性，返回裸命令名（PATH 回退）时查 PATH
function probeAvailability(provider) {
  const definition = resolveAdapter(provider);
  try {
    const executable = definition.resolveExecutable();
    if (executable === "mock") return { available: true, reason: null };
    if (path.isAbsolute(executable)) {
      const { existsSync } = require("node:fs");
      return existsSync(executable)
        ? { available: true, reason: null }
        : { available: false, reason: `${executable} 不存在` };
    }
    return commandExists(executable)
      ? { available: true, reason: null }
      : { available: false, reason: `${executable} 不在 PATH 中` };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

module.exports = {
  ADAPTERS,
  createLocalAgentAdapter,
  listLocalAgentProviders,
  listDefaultAgentProviders,
  probeAvailability,
  buildCapabilitiesFor
};
