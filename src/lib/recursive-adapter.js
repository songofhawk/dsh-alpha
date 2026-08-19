// 主控递归（阶段 3）：dsh-master 代理 —— 主控 agent 自己也可被更高层派发，
// 作为子控制器再把任务递归派给其它 agent，事件流与结果上卷到外层任务。
//
// 递归由 dispatch 的 recursion 载荷描述：
//   { delegate: agentId, prompt, depth }（depth 从 0 起，逐层 +1；
//   达到 maxDepth 时抛「递归深度超限」，外层任务失败 —— 防止失控自举）。

// 主控默认不接受递归 payload 直接当 prompt；载荷缺失时明确报错。
function createRecursiveAdapter({ store, dispatch, maxDepth = 3 }) {
  const pollIntervalMs = 25;
  let currentSubTaskId = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    id: "recursive",
    kind: "recursive",
    maxDepth,
    async *runTurn(context) {
      const schema = context?.recursion || {};
      const depth = Number.isFinite(Number(schema.depth)) ? Number(schema.depth) : 0;
      if (depth >= maxDepth) {
        throw new Error(`递归深度超限（maxDepth=${maxDepth}）`);
      }
      const delegate = schema.delegate;
      const prompt = String(schema.prompt || "");
      if (!delegate || !prompt.trim()) {
        throw new Error("主控递归载荷必须包含 delegate（子任务 agentId）与 prompt");
      }

      const sub = dispatch({
        agentId: delegate,
        prompt,
        projectPath: context?.project?.path || null,
        mode: context?.settings?.mode,
        approvalPolicy: context?.settings?.approval_policy,
        recursion: { ...schema, depth: depth + 1 }
      });

      // 子任务是异步运行的：轮询 store，把子任务事件流上卷给外层引擎
      const subTaskId = sub.taskId;
      currentSubTaskId = subTaskId;
      let seen = 0;
      let terminal = null;
      while (!terminal) {
        const subTask = store.getTask(subTaskId);
        const events = subTask.events || [];
        for (; seen < events.length; seen += 1) {
          const event = events[seen];
          if (["complete", "cancelled", "error"].includes(event.type)) {
            // 子任务终态不外泄：外层统一由封装终态收口，避免外层被过早终结
            terminal = event;
            break;
          }
          yield event;
        }
        if (!terminal) await sleep(pollIntervalMs);
      }

      // 外层任务以子任务结果收口；附子任务事件供审计
      const subTask = store.getTask(subTaskId);
      const ended = orderedPossible(terminal.type);
      if (ended === "complete") {
        yield {
          type: "complete",
          payload: {
            message: `子任务 ${subTaskId} → ${delegate} 已 ${ended}：\n${String(subTask.result || "")}`,
            subTaskId,
            subTaskResult: subTask.result || null,
            subTaskEvents: (subTask.events || []).map((e) => ({ type: e.type, payload: e.payload }))
          }
        };
      } else {
        const error = new Error(subTask.error || `子任务 ${subTaskId} 未完成：${ended}`);
        if (ended === "cancelled") error.statusCode = 409;
        throw error;
      }
    },
    async cancelTurn(context) {
      // 递归任务被取消 → 尽力取消当前子任务
      const target = currentSubTaskId || context?.session?.id;
      if (!target) return { ok: true };
      try {
        const status = store.getTask(target);
        if (status && ["queued", "running", "blocked"].includes(status.status)) {
          store.setStatus(target, "cancelled", { error: "主控递归已取消" });
        }
      } catch {
        /* 子任务已结束则忽略 */
      }
      return { ok: true };
    }
  };

  function orderedPossible(type) {
    if (type === "complete") return "complete";
    if (type === "cancelled") return "cancelled";
    return "error";
  }
}

module.exports = { createRecursiveAdapter };