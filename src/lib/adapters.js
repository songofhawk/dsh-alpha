// 本机 agent adapter：vendorized agent-anywhere runtimes 之上的薄选择层。
// provider：codex / claude-code / kimi-code / mock。
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
const { MockRuntime } = require("../adapters/vendor/runtimes/mock-runtime");
const { resolveCodexExecutable } = require("../adapters/vendor/runtimes/codex-runtime");
const { resolveClaudeExecutable } = require("../adapters/vendor/runtimes/claude-code-headless-runtime");
const { resolveKimiExecutable } = require("../adapters/vendor/runtimes/kimi-acp-client");
const { commandExists } = require("./catalog");

const ADAPTERS = {
  codex: {
    id: "codex",
    kind: "local-process",
    createRuntime: () => new CodexAppServerRuntime({ provider: "codex" }),
    resolveExecutable: () => resolveCodexExecutable()
  },
  "claude-code": {
    id: "claude-code",
    kind: "local-process",
    createRuntime: () => new ClaudeCodeHeadlessRuntime({ provider: "claude-code" }),
    resolveExecutable: () => resolveClaudeExecutable()
  },
  "kimi-code": {
    id: "kimi-code",
    kind: "local-process",
    createRuntime: () => new KimiCodeRuntime({ provider: "kimi-code" }),
    resolveExecutable: () => resolveKimiExecutable()
  },
  mock: {
    id: "mock",
    kind: "local-process",
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
      return buildCapabilities(this.id);
    },
    async *runTurn(context) {
      yield* runtime.run(context);
    },
    async cancelTurn(context) {
      if (typeof runtime.cancelTurn !== "function") return {};
      return runtime.cancelTurn(context);
    }
  };
}

function listLocalAgentProviders() {
  return Object.keys(ADAPTERS);
}

function buildCapabilitiesFor(provider) {
  const definition = resolveAdapter(provider);
  return buildCapabilities(definition.id, { providers: [definition.id] });
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
  probeAvailability,
  buildCapabilitiesFor
};