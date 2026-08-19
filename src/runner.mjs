// alpha-runner：一次任务直驱驱动（照抄 dsh-headless，额外挂载 alpha preset）。
// 从 headlessStartup 服务拿到 CLI positional 任务，创建一个挂载 alpha preset
// 的 agent，驱动到静止、flush 会话、打印最终文本、按 outcome 退出。

import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "alpha-runner";
export const inject = ["agentDefaultModel", "agents", "sessions", "agentPresets"];

export const Config = z.object({
  task: z.string().required(),
  preset: z.string().default("alpha")
});

const internals = {
  stdout: process.stdout,
  stderr: process.stderr
};

function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
  io.exit(1);
}

async function run(ctx, config, io) {
  await ctx.get("loader")?.await();
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  const agentPresets = ctx.get("agentPresets");
  if (agents === undefined || defaultModel === undefined || sessions === undefined || agentPresets === undefined) {
    return;
  }
  const selection = defaultModel.currentSelection();
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: selection.provider,
      model: selection.model
    },
    setup: async (agentCtx) => {
      installModelSelection(agentCtx, {
        current: selection,
        assembled: undefined
      });
      await agentPresets.mount(agentCtx, config.preset);
    }
  });
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(createUserMessage({
    content: [{
      type: "text",
      text: config.task
    }],
    source: { kind: "user" }
  }));
  await agent.whenIdle();
  await sessions.flush(agent.session);
  const outcome = summarize(agent.session.events, firstSeq);
  io.stdout.write(`${outcome.text}\n`);
  if (outcome.reason?.kind === "error") {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
  }
  io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
}

export function apply(ctx, config) {
  const exit = ctx.get("appExit");
  if (exit === undefined) {
    throw new Error("alpha-runner: the launcher must provide ctx.appExit before the tree mounts");
  }
  const io = {
    stdout: internals.stdout,
    stderr: internals.stderr,
    exit
  };
  run(ctx, config, io).catch((error) => {
    fail(io, error);
  });
}