// 阶段 4 本地执行收敛：主控引擎 local 分支 → rc.8 官方 subagent provider。
// 把 ctx.subagents.start() 的 one-shot run 包装成任务引擎的 runTurn 事件契约
// （activity → complete/cancelled/error），引擎无需感知 seam 细节。
//
// 收敛面（rc.8 源码实证，packages/subagent/subagent-{codex,claude-code,acp}）：
//  - out-of-process 官方 provider 只从 request 读 prompt / signal 与
//    request.parent.session.header.cwd（子进程工作区）；run id 由 provider 自发。
//  - 均为 one-shot、无人值守：审批一律自动 deny、无中间事件。需要人工审批的
//    执行走 gateway 通道（worker 保留 vendor runtime + 审批冒泡）。
//  - 因此每次派发构造一个最小 parent，把任务的 projectPath 注入为子进程 cwd，
//    保住 repo 身份选机 / 按任务工作区定位（官方语义里 parent 是真 agent，
//    其生命周期事件按 scope key 路由；这里只为取 cwd，事件路由不到任何
//    scoped 监听器亦无副作用——引擎直接 await run.result 拿终态）。

const SEAM_PROVIDER_NAMES = {
  codex: "codex",
  "claude-code": "claude-code",
  // dsh-subagent-acp 实例，由 plugin.mjs 以 kimi-code 名注册（spawn `kimi acp`）
  "kimi-code": "kimi-code",
  // opencode ACP provider（spawn `opencode acp`，与 kimi-code 同协议）
  opencode: "opencode",
  // qoder headless provider（spawn `qoder --print`，与 claude-code 接口兼容）
  qoder: "qoder",
  // workbuddy MCP bridge provider（spawn `workbuddy mcp create`）
  workbuddy: "workbuddy"
};

// ContentBlock[] → 纯文本（只取 text 块）
function outputText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block && block.type === "text")
    .map((block) => block.text || "")
    .join("");
}

// 引擎 adapter 契约：{ id, kind, runTurn(context), cancelTurn(context) }
function createSubagentBackedAdapter({ provider, subagents }) {
  const seamName = SEAM_PROVIDER_NAMES[provider];
  if (!seamName) {
    const error = new Error(`provider ${provider} 无对应官方 subagent provider`);
    error.statusCode = 400;
    throw error;
  }
  const active = new Map(); // session.id(taskId) -> { controller, run }

  return {
    id: provider,
    kind: "local-process",
    async *runTurn(context) {
      const sessionId = context.session?.id;
      const cwd = context.project?.path || process.cwd();
      // 最小 parent：官方 provider 只读 session.header.cwd（见文件头收敛面说明）
      const parent = { session: { id: `alpha-${sessionId || "task"}`, header: { cwd } } };
      const controller = new AbortController();
      const handle = { controller, run: null };
      if (sessionId) active.set(sessionId, handle);

      let run;
      try {
        run = await subagents.start(seamName, {
          label: `alpha:${sessionId || "task"}`,
          prompt: [{ type: "text", text: String(context.message || "") }],
          parent,
          signal: controller.signal
        });
      } catch (error) {
        if (sessionId) active.delete(sessionId);
        yield { type: "error", payload: { message: `官方 provider 启动失败：${error.message}` } };
        return;
      }
      handle.run = run;
      yield {
        type: "activity",
        payload: { kind: "status", message: `${provider} one-shot 子代理已启动（rc.8 官方 provider，无人值守）` }
      };

      let result;
      try {
        // 契约：子任务失败不 reject（stopReason=error）；reject 仅缝级基础设施故障
        result = await run.result;
      } catch (error) {
        if (sessionId) active.delete(sessionId);
        await run.dispose().catch(() => {});
        yield { type: "error", payload: { message: error.message } };
        return;
      }
      await run.dispose().catch(() => {});
      if (sessionId) active.delete(sessionId);

      const text = outputText(result.output);
      if (result.stopReason === "completed") {
        yield { type: "complete", payload: { message: text, usage: null, artifacts: [] } };
      } else if (result.stopReason === "aborted") {
        yield { type: "cancelled", payload: { message: text || "已取消" } };
      } else {
        const detail = [result.stopReason, result.diagnostic].filter(Boolean).join("：");
        yield { type: "error", payload: { message: detail + (text ? `\n${text}` : "") } };
      }
    },
    async cancelTurn(context) {
      const handle = context?.session?.id ? active.get(context.session.id) : null;
      // 引擎 cancelTurn 携带 session.id；兜底（如 gateway 断连清理）中止全部在跑
      const targets = handle ? [handle] : [...active.values()];
      for (const target of targets) target.controller.abort();
      return {};
    }
  };
}

module.exports = { SEAM_PROVIDER_NAMES, createSubagentBackedAdapter, outputText };
