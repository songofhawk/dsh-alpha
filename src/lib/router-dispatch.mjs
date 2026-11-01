// alpha-router 的快路径（docs/superagent-design.md 第 6.3 节）：
// 在 agent/pre-step 逐条归属用户消息；已归属的消息经 llm/stream 接缝返回一行确认后
// 结束 turn，不调用模型，也不等待 Worker。只有未决消息才进入 Router LLM。
//
// 系统提示在 pre-step 之前就组装好了，所以未决消息的 triggerId 不能放进 prompt
// section，这里用自有来源的上下文消息带给模型（宿主自己的运行时上下文也走这条路）。

import { randomUUID } from "node:crypto";

function* textStream(text) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}

function textOf(message) {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function constraintsOf(selected) {
  const constraints = {};
  for (const key of ["agentId", "machineId", "workspaceId", "model", "reasoningEffort", "mode"]) {
    if (selected?.[key]) constraints[key] = selected[key];
  }
  return constraints;
}

function routerNote({ undecided, handled }) {
  const lines = [];
  if (undecided.length) {
    lines.push("待路由的消息，逐条用 ticket_route 决定：");
    for (const trigger of undecided) lines.push(`- ${trigger.id}：${trigger.text.slice(0, 500)}`);
  }
  if (handled.length) {
    lines.push("以下内容已由程序处理，不要重复处理：");
    for (const line of handled) lines.push(`- ${line}`);
  }
  return {
    id: randomUUID(),
    role: "user",
    source: { kind: "dsh-alpha", role: "router-note" },
    content: [{ type: "text", text: lines.join("\n") }]
  };
}

export function installRouterDispatch(ctx, { service, selection, clearSelection }) {
  const turns = new WeakMap();

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    service.bindAgent(payload.agent);
    const users = payload.messages.filter((message) => message.source?.kind === "user");
    const reports = payload.messages.filter((message) => message.source?.kind === "dsh-alpha" && message.source.role === "worker-report");
    if (!users.length && !reports.length) return decision;

    const sessionId = payload.agent.session.id;
    const selected = selection(sessionId);
    const constraints = constraintsOf(selected);
    const lines = reports.map(textOf);
    const routed = [];
    for (const message of users) {
      // 输入框的选择是“本条约束”：对同一批里的每一条都生效，处理完清空。
      if (message.content.some((block) => !["text", "image"].includes(block.type))) {
        lines.push("这条消息带了暂不支持转发的附件类型，没有派发。");
        continue;
      }
      if (constraints.workspaceId && !selected.workspace) {
        lines.push("所选工作区已不可用，请重新选择项目后重试。");
        continue;
      }
      const outcome = await service.intake({
        messageId: message.id,
        text: textOf(message),
        attachments: message.content.filter((block) => block.type === "image").map((block) => ({ image: block.attachment })),
        ui: { constraints, selected },
        signal: payload.signal
      });
      if (outcome.router) routed.push(outcome.trigger);
      else lines.push(outcome.ack);
    }
    if (users.length && Object.keys(constraints).length) clearSelection(sessionId);

    // 第一步之后的消息是 Router 工作途中插进来的：不能用确认行截断它正在做的事。
    if (routed.length || payload.step > 1) {
      if (!routed.length && !lines.length) return decision;
      return { ...decision, messages: [...decision.messages, routerNote({ undecided: routed, handled: lines })] };
    }
    if (lines.length) turns.set(payload.signal, { sessionId, text: lines.join("\n") });
    return decision;
  });

  ctx.on("llm/stream", async function* (options, next) {
    const state = turns.get(options.signal);
    // llm/stream 是共享服务事件：必须同时绑定本轮 signal 和精确 session。
    if (!state || options.sessionId !== state.sessionId) {
      yield* next();
      return;
    }
    turns.delete(options.signal);
    options.signal.throwIfAborted();
    yield* textStream(state.text);
  });
}
