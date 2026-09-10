import { randomUUID } from "node:crypto";

function* toolStream(callId, name, args) {
  const block = { type: "tool-call", id: callId, name, arguments: JSON.stringify(args) };
  yield { type: "block-start", index: 0, blockType: block.type };
  yield { type: "tool-call-delta", index: 0, id: callId, name, argumentsDelta: block.arguments };
  yield { type: "block-end", index: 0, block };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

function* textStream(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}

// 在宿主的模型流接缝返回确定性的工具调用，仍由唯一 ToolRuntime 执行、
// 记录和取消任务。既不改写会话事件，也不把“立即派发”交给模型判断。
export function installDirectDispatch(ctx, { selection, sessionId, renderOutcome }) {
  const turns = new WeakMap();
  let activeState;
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    const messages = payload.messages.filter((message) => message.source?.kind === "user");
    if (!messages.length) return decision;
    turns.delete(payload.signal);
    const selected = selection(payload.agent.session.id);
    if (!selected.agentId) return decision;
    const blocks = messages.flatMap((message) => message.content);
    activeState = {
      sessionId: payload.agent.session.id,
      args: {
        agentId: selected.agentId,
        ...(selected.workspaceId ? { workspaceId: selected.workspaceId } : {}),
        prompt: blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n")
      },
      // 现有 Worker 附件契约只接收目标机路径。不可丢掉宿主 image ref
      // 或把主控附件路径冒充目标机路径，更不能因此恢复模型自动选机。
      error: blocks.some((block) => block.type !== "text")
        ? "当前直派通道无法转发此附件类型，请提供目标机可访问的文件路径后重试。"
        : selected.workspaceId && !selected.workspace
          ? "所选工作区已不可用，请重新选择项目后重试。"
          : null,
      dispatchCallId: `alpha-direct-${randomUUID()}`,
      waitCallId: `alpha-wait-${randomUUID()}`,
      stage: "dispatch"
    };
    turns.set(payload.signal, activeState);
    return decision;
  });

  ctx.on("llm/stream", async function* (options, next) {
    const state = turns.get(options.signal);
    // llm/stream 是共享服务事件：必须同时绑定本轮 signal 和精确 session，
    // 避免截获其它会话或插件内部的模型请求。
    if (!state || options.sessionId !== state.sessionId || options.sessionId !== sessionId()) {
      yield* next();
      return;
    }
    options.signal.throwIfAborted();
    if (state.error) {
      yield* textStream(`派发失败：${state.error}`);
      return;
    }
    if (state.stage === "dispatch") {
      state.stage = "dispatching";
      yield* toolStream(state.dispatchCallId, "dispatch_task", state.args);
    } else if (state.stage === "wait") {
      state.stage = "waiting";
      yield* toolStream(state.waitCallId, "wait_task", { taskId: state.outcome.taskId });
    } else if (state.stage === "dispatching" || state.stage === "waiting") {
      // 工具可能在执行前被宿主权限/参数检查拒绝；不能循环生成派发。
      yield* textStream("直派工具未成功执行，请查看本轮工具错误后重试。");
    } else if (state.outcome?.status === "blocked") {
      // 审批仍走已有主控审查与页面审批流程；到这里 Worker 已经收到任务。
      turns.delete(options.signal);
      yield* next();
    } else {
      yield* textStream(state.outcome?.status === "completed"
        ? state.outcome.result || "（Worker 已完成，无文本输出）"
        : renderOutcome(state.outcome));
    }
  });

  return async function execute(executeTool, args, exec) {
    // ToolRuntime 可包装 signal；以宿主 callId 关联结果，不依赖 signal 身份。
    const state = activeState;
    const owned = state && exec && (exec.callId === state.dispatchCallId || exec.callId === state.waitCallId);
    try {
      const outcome = await executeTool(args, exec);
      if (owned) {
        state.outcome = outcome;
        state.stage = exec.callId === state.dispatchCallId ? "wait" : "result";
      }
      return outcome;
    } catch (error) {
      if (owned) state.error = error.message || String(error);
      throw error;
    }
  };
}
