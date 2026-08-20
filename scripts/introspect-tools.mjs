// 无模型验收脚本：boot alpha profile 的组合（dsh-base + dsh-alpha），创建一个
// 挂载 alpha preset 的 agent，但不发起任何模型调用，直接内省该 agent scope 下的
// 工具视图，用于验证 dsh-alpha 的 list_agents 与 RC.8 dsh-base 内置全局
// list_agents（dsh-tool-subagent-control/list-agents）撞名时的实际表现。
//
// 用法见 scripts/introspect-overlay.yml（--patch 覆盖：禁用 alpha-runner，插入本行）。
//
// 判读：
//  - 若 preset 挂载抛 "already registered" → 同层冲突（硬失败）。
//  - 若挂载成功且 agent scope 的 list_agents 描述以「查询主控目录」开头 → 我方
//    scoped 注册 shadow 了全局内置版（预期）。
//  - 若描述是 "List your continuable background subagents..." → 全局内置版胜出。

import { randomUUID } from "node:crypto";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "dsh-alpha-introspect";
export const inject = ["agents", "agentPresets", "agentDefaultModel", "tools", "subagents", "appExit"];

function brief(text, n = 90) {
  return String(text || "").replace(/\s+/g, " ").slice(0, n);
}

async function run(ctx) {
  await ctx.get("loader")?.await();
  const agents = ctx.get("agents");
  const agentPresets = ctx.get("agentPresets");
  const defaultModel = ctx.get("agentDefaultModel");
  const tools = ctx.get("tools");
  if (agents === undefined || agentPresets === undefined || defaultModel === undefined || tools === undefined) {
    throw new Error("缺少必需服务（agents/agentPresets/agentDefaultModel/tools）");
  }

  const selection = defaultModel.currentSelection();
  const diag = (line) => process.stderr.write(`[diag] ${line}\n`);
  diag(`selection: ${selection.provider}/${selection.model}`);
  // 捕获 agent 的 scoped context；之后通过 agentCtx.tools（traceable，rebind 到
  // 运行时自己的 dsh-scope 副本）内省，避免本插件自带 dsh-scope 副本的 kScope
  // Symbol 与运行时不一致（dual-package hazard）。
  let agentCtx;
  const handle = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (ctx) => {
      installModelSelection(ctx, { current: selection, assembled: undefined });
      const preset = await agentPresets.mount(ctx, "alpha");
      diag(`mount resolved: id=${preset?.id}`);
      agentCtx = ctx;
    }
  });
  const agent = handle.agent;
  await agent.whenIdle();
  if (agentCtx === undefined) throw new Error("setup 未执行，无法内省 agent scope");

  // kScope 是运行时 dsh-scope 副本的模块级 Symbol；本插件自带副本的 Symbol 不同
  // （dual-package hazard），只能按 description 从 agentCtx 自身把 key 捞出来。
  let scopeHolder = agentCtx;
  let scopeSym;
  while (scopeHolder) {
    scopeSym = Object.getOwnPropertySymbols(scopeHolder)
      .find((s) => String(s.description ?? s).includes("dsh.scope"));
    if (scopeSym) break;
    scopeHolder = Object.getPrototypeOf(scopeHolder);
  }
  const scope = scopeSym ? scopeHolder[scopeSym] : undefined;
  const out = [`agent scope key: ${String(scope)}${scopeSym ? "" : "（未找到 kScope symbol）"}`];

  const agentView = tools.get("list_agents", scope);
  const globalView = tools.get("list_agents");
  out.push(`agent-scope list_agents: ${agentView ? "present" : "ABSENT"} | ${agentView ? brief(agentView.description) : "-"}`);
  out.push(`global    list_agents: ${globalView ? "present" : "ABSENT"} | ${globalView ? brief(globalView.description) : "-"}`);

  if (agentView) {
    const ours = agentView.description.includes("主控目录");
    out.push(`winner in agent scope: ${ours ? "DSH-ALPHA (查询主控目录)" : "RC.8 BUILTIN (continuable subagents)"}`);
  }

  const names = tools.schemas(scope).map((s) => s.name).sort();
  out.push(`agent-scope tool count: ${names.length}`);
  out.push(`agent-scope tools: ${names.join(", ")}`);
  for (const key of ["dispatch_task", "task_status", "task_result", "agent_approve", "agent_cancel", "list_agents", "subagent", "subagent_fork"]) {
    out.push(`  has ${key}: ${names.includes(key)}`);
  }

  // 阶段 4：root seam 上应看到 dsh-base 自带 provider + dsh-alpha 动态注册的
  // 三个官方产品 provider（codex / claude-code / kimi-code）
  const subagents = ctx.get("subagents");
  if (subagents) {
    const providerNames = subagents.list();
    out.push(`root subagents providers (${providerNames.length}): ${providerNames.join(", ")}`);
    for (const key of ["codex", "claude-code", "kimi-code"]) {
      out.push(`  official provider ${key}: ${subagents.getProvider(key) ? "present" : "ABSENT"}`);
    }
  } else {
    out.push("root subagents seam: ABSENT");
  }

  process.stdout.write(out.join("\n") + "\n");
}

export function apply(ctx) {
  const exit = ctx.get("appExit");
  if (exit === undefined) throw new Error("dsh-alpha-introspect: launcher 未提供 appExit");
  run(ctx).then(
    () => exit(0),
    (error) => {
      process.stderr.write(`introspect: ${error instanceof Error ? (error.stack || error.message) : String(error)}\n`);
      exit(1);
    }
  );
}
