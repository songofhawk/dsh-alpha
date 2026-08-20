// 阶段 4 选项 2：gateway 反向注册为 rc.8 SubagentProvider。
//
// seam 生态（rc.8 的 subagent/subagent_fork 工具等）由此获得跨机派发能力：
//   start() → 目录 auto-pick 一台在线远端 agent（rankAgents，负载感知）
//           → engine.dispatch（引擎远端分支经 gateway hub 代理到 worker）
//           → 轮询任务终态 → 映射 SubagentResult。
//
// 分工与边界：
//  - 审批不改道：远端冒泡的 approval_request 仍入 alphaApprovals broker，
//    由主控会话经 agent_approve 决策（缝本身没有审批通道，seam 契约下任务
//    只是"等得久一点"）。
//  - 选机/指定 repo/mode/approval_policy 的完整控制仍在 dispatch_task；
//    本 provider 是免参数入口，只做远端 auto-pick。
//  - 只挑远端 agent：本机执行已有官方 provider（阶段 4 选项 1），此通道
//    的差异化就是跨机。
//  - one-shot、无中継事件：与官方 provider 同语义，seam 消费方零特殊处理。

const { randomUUID } = require("node:crypto");
const { SessionId } = require("@deepseek-ai/dsh-session");
const { NO_START_CAPABILITIES } = require("@deepseek-ai/dsh-subagent");
const { resolveProjectPath } = require("../adapters/vendor/shared/path-policy");

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

// 远端 vendor runtime 只吃纯文本 message；与官方 textTask 同口径（fail loud）
function promptText(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw new Error("alpha-gateway: 任务必须包含至少一个 text 块");
  }
  const texts = [];
  for (const block of prompt) {
    if (!block || block.type !== "text") {
      throw new Error("alpha-gateway: 远端任务只接受 text 块");
    }
    texts.push(block.text || "");
  }
  if (texts.every((text) => text.trim().length === 0)) {
    throw new Error("alpha-gateway: 任务文本不能为空");
  }
  return texts.join("\n");
}

function resultOf(task) {
  const output = task.result ? [{ type: "text", text: String(task.result) }] : [];
  if (task.status === "completed") return { output, stopReason: "completed" };
  if (task.status === "cancelled") return { output, stopReason: "aborted" };
  // failed：error 文案进 diagnostic（provider 署名、与 output 分列）
  const result = { output, stopReason: "error" };
  if (task.error) result.diagnostic = String(task.error);
  return result;
}

function createGatewaySubagentProvider({
  name = "alpha-gateway",
  catalog,
  engine,
  store,
  allowedRoots = [],
  pollIntervalMs = 100
} = {}) {
  // 目录排序后只留在线远端 agent；心跳超时的机器行 online=false，一并排除
  // （hub.run 也会二次校验，这里先 fail fast，拒绝发生在发布前）
  function pickRemoteAgent() {
    const ranked = catalog
      .rankAgents({})
      .filter((row) => row.machineId !== catalog.machineId && row.machine?.online !== false);
    if (!ranked.length) {
      const error = new Error("alpha-gateway: 没有在线的远端 agent（检查 worker 是否已连上 gateway）");
      error.statusCode = 503;
      throw error;
    }
    return ranked[0];
  }

  return {
    name,
    // 远端子进程无法履行 parent 强制的启动期特性 → 全 false，缝在 start 前拒绝
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,

    async start(request) {
      if (request.signal.aborted) {
        throw new Error("alpha-gateway: 派发前请求已被取消");
      }
      const text = promptText(request.prompt);
      const agent = pickRemoteAgent();

      const dispatchOptions = { agentId: agent.agentId, prompt: text };
      // parent 会话工作区：落在本机 allowedRoots 内才作为 projectPath 透传，
      // 越界则交给引擎默认根（远端 repo 定位仍由 dispatch_task 的 repoUrl 通道负责）
      const parentCwd = request.parent?.session?.header?.cwd;
      if (parentCwd) {
        try {
          dispatchOptions.projectPath = resolveProjectPath(parentCwd, allowedRoots);
        } catch {
          // 越界：不透传
        }
      }

      const { taskId } = engine.dispatch(dispatchOptions);

      const onAbort = () => {
        engine.cancelTask(taskId).catch(() => {});
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort(); // dispatch 与挂监听之间的竞态兜底

      let settled = false;
      const result = (async () => {
        try {
          for (;;) {
            const task = store.getTask(taskId);
            if (TERMINAL_STATES.has(task.status)) return resultOf(task);
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, pollIntervalMs);
              timer.unref?.();
            });
          }
        } finally {
          settled = true;
          request.signal.removeEventListener("abort", onAbort);
        }
      })();
      result.catch(() => {}); // 消费方未 await 时避免 unhandled rejection

      let disposal;
      return {
        // 远端 provider 自发 run id（parent 命名空间内唯一即可，见 seam 契约）
        id: SessionId(randomUUID()),
        localAgent: undefined,
        result,
        dispose() {
          if (disposal !== undefined) return disposal;
          if (!settled) onAbort();
          disposal = result.then(() => {}, () => {});
          return disposal;
        }
      };
    }
  };
}

module.exports = { createGatewaySubagentProvider, promptText };
