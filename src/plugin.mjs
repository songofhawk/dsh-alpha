// dsh-alpha 主控插件（host 平面）：
// 在 root realm 发布 alphaCatalog / alphaTasks / alphaApprovals / alphaEngine
// 四个服务，供 alpha preset 的工具行（agent 平面）注入消费。
//
// 挂载行：见 cordis.patch.yml 的 `dsh-alpha` row。

import path from "node:path";
import os from "node:os";
import z from "@deepseek-ai/schemastery";
import * as codexSubagent from "@deepseek-ai/dsh-subagent-codex";
import * as claudeCodeSubagent from "@deepseek-ai/dsh-subagent-claude-code";
import * as acpSubagent from "@deepseek-ai/dsh-subagent-acp";
import { createCatalog, defaultAllowedRoots, localMachineId } from "./lib/catalog.js";
import { createTaskStore } from "./lib/task-store.js";
import { createApprovalBroker } from "./lib/approvals.js";
import { createTaskEngine } from "./lib/task-engine.js";
import { createRecursiveAdapter } from "./lib/recursive-adapter.js";
import { listLocalAgentProviders, probeAvailability, buildCapabilitiesFor, createLocalAgentAdapter } from "./lib/adapters.js";
import { SEAM_PROVIDER_NAMES, createSubagentBackedAdapter } from "./lib/subagent-adapters.js";
import { createGatewaySubagentProvider } from "./lib/gateway-provider.js";
import { resolveKimiExecutable } from "./adapters/vendor/runtimes/kimi-acp-client.js";
import { createGatewayHub, parseMachineTokens } from "./lib/gateway-hub.js";

export const name = "dsh-alpha";
// 阶段 4：本地执行收敛需要 ctx.subagents 缝（dsh-base 提供）。声明 inject 既
// 满足 cordis「未声明不得取属性」的访问约束，也让 loader 按依赖排序挂载。
export const inject = ["subagents"];

export const Config = z.object({
  dataDir: z.string(),
  providers: z.array(z.string()),
  allowedRoots: z.array(z.string()),
  defaultMode: z.string().default("auto-review"),
  defaultApprovalPolicy: z.string().default("on-request"),
  defaultModel: z.string(),
  checkAvailability: z.boolean().default(true),
  gatewayPort: z.number(),
  gatewayTokens: z.string(),
  gatewayHost: z.string(),
  recursive: z.boolean().default(true), // 主控可递归：注册 dsh-master 子控制器
  maxRecursionDepth: z.number().default(3)
});

function resolveHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function splitProviders(envValue) {
  return String(envValue || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// [] 是 truthy：先取长度，再回退默认
function firstOr(list, fallback) {
  return list && list.length ? list : fallback;
}

export async function apply(ctx, config) {
  const dataDir = config.dataDir
    || process.env.DSH_ALPHA_DATA_DIR
    || path.join(resolveHome(), "storages", "dsh-alpha");
  const providers = firstOr(config.providers,
    firstOr(splitProviders(process.env.DSH_ALPHA_PROVIDERS), listLocalAgentProviders()));
  const allowedRoots = firstOr(config.allowedRoots,
    firstOr(splitProviders(process.env.DSH_ALPHA_ALLOWED_ROOTS), defaultAllowedRoots()));

  const defaults = {
    mode: config.defaultMode || process.env.DSH_ALPHA_DEFAULT_MODE || "auto-review",
    approval_policy: config.defaultApprovalPolicy || process.env.DSH_ALPHA_APPROVAL_POLICY || "on-request",
    model: config.defaultModel || process.env.DSH_ALPHA_DEFAULT_MODEL || undefined
  };

  const catalog = createCatalog({
    allowedRoots,
    adapterProvider: {
      capabilitiesFor: buildCapabilitiesFor,
      probeAvailability
    }
  });

  // 注册本机各 provider agent
  for (const provider of providers) {
    catalog.registerAgent({
      provider,
      checkAvailable: config.checkAvailability ?? true
    });
  }

  // 阶段 3 主控可递归：dsh-master 子控制器也是一种本机 agent（无需可执行文件探测）
  if (config.recursive !== false) {
    catalog.registerAgent({ provider: "dsh-master", checkAvailable: false, reason: "主控递归" });
  }

  // 阶段 1：gateway hub（配置了 port 才启用；token 是硬前提）
  // port 0 = OS 分配临时端口（测试/dev）；未配置 = 不启用
  let gatewayHub = null;
  const gatewayPortRaw = config.gatewayPort ?? process.env.DSH_ALPHA_GATEWAY_PORT;
  const gatewayPort = gatewayPortRaw === undefined || gatewayPortRaw === null || gatewayPortRaw === ""
    ? null
    : Number(gatewayPortRaw);
  if (gatewayPort !== null) {
    const machineTokens = parseMachineTokens(config.gatewayTokens || process.env.DSH_ALPHA_GATEWAY_TOKENS);
    const tokenIds = Object.keys(machineTokens);
    if (!tokenIds.length) {
      throw new Error("启用 gateway 必须先配置 DSH_ALPHA_GATEWAY_TOKENS（machineId:token,...），认证是硬前提");
    }
    gatewayHub = createGatewayHub({
      catalog,
      tokens: machineTokens,
      port: gatewayPort,
      host: config.gatewayHost || process.env.DSH_ALPHA_GATEWAY_HOST || "127.0.0.1"
    });
    const { port: boundPort } = await gatewayHub.start();
    ctx.provide("alphaGateway", gatewayHub);
    // hub 生命周期挂进本 row 的 effect scope：应用树 dispose 时关掉监听。
    // 否则 dsh 退出走「dispose 完成后等事件循环自然耗尽」路径，残留的
    // listening server 会让进程永久悬挂。
    ctx.effect(function* () {
      yield () => gatewayHub.close();
    }, "dsh-alpha:gateway-hub");
    ctx.logger?.info?.(`[dsh-alpha] gateway hub 监听 :${boundPort}（接受 ${tokenIds.length} 台机器）`);
  }

  // 阶段 4：本地执行收敛 —— 把 rc.8 官方产品 subagent provider 注册到 ctx.subagents 缝。
  // 主控引擎 local 分支委托它们（one-shot、无人值守）；gateway worker 保留 vendor
  // runtime（审批冒泡是差异化通道，官方 provider 一律自动 deny）。
  // 无 seam 的组合（如单测 fake ctx）→ local 分支自动回退 vendor runtime。
  const subagents = ctx.subagents;
  if (subagents?.registerProvider) {
    codexSubagent.apply(ctx, codexSubagent.Config({}));
    claudeCodeSubagent.apply(ctx, claudeCodeSubagent.Config({}));
    try {
      // kimi-code 走通用 ACP provider：spawn `kimi acp`（与 vendor kimi runtime 同协议）
      acpSubagent.apply(ctx, acpSubagent.Config({
        providerName: "kimi-code",
        command: resolveKimiExecutable(),
        args: ["acp"]
      }));
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-alpha] kimi-code 官方 provider 未注册：${error.message}`);
    }
  }

  const store = createTaskStore({ dataDir });
  store.recoverInterrupted();

  const approvals = createApprovalBroker({ store });
  let engineRef = null;
  const engine = createTaskEngine({
    catalog,
    store,
    approvals,
    allowedRoots,
    defaults,
    // dsh-master → 主控递归；远端 agent → gateway 通道；本机 agent → 本地 runtime
    adapterFor: (agent) => {
      if (agent.provider === "dsh-master" && agent.machineId === catalog.machineId) {
        return createRecursiveAdapter({
          store,
          maxDepth: Math.max(1, Number(config.maxRecursionDepth) || 3),
          dispatch: (options) => {
            if (!engineRef) {
              const error = new Error("主控引擎尚未就绪");
              error.statusCode = 503;
              throw error;
            }
            return engineRef.dispatch(options);
          }
        });
      }
      if (agent.machineId !== catalog.machineId) {
        if (!gatewayHub) {
          const error = new Error(`agent ${agent.agentId} 是远端 agent，但本实例未启用 gateway hub`);
          error.statusCode = 503;
          throw error;
        }
        return {
          id: "gateway",
          kind: "gateway",
          async *runTurn(context) {
            yield* gatewayHub.run({ machineId: agent.machineId, context });
          },
          async cancelTurn(context) {
            return gatewayHub.cancelTurn({ machineId: agent.machineId, context });
          }
        };
      }
      // 本机（阶段 4 收敛）：委托 ctx.subagents 上的官方 provider。
      // 回退 vendor runtime：mock（无官方对应）/ 无 seam / provider 未注册 /
      // DSH_ALPHA_LOCAL_LEGACY=1（回滚开关，对比验证用）。
      const seamName = SEAM_PROVIDER_NAMES[agent.provider];
      if (subagents && seamName && process.env.DSH_ALPHA_LOCAL_LEGACY !== "1" && subagents.getProvider?.(seamName)) {
        return createSubagentBackedAdapter({ provider: agent.provider, subagents });
      }
      return createLocalAgentAdapter(agent.provider);
    }
  });
  engineRef = engine;

  // 阶段 4 选项 2：gateway 反向注册为 SubagentProvider —— rc.8 生态（subagent
  // 工具等）由此直接获得跨机派发能力：远端 auto-pick → engine.dispatch（经
  // gateway hub 代理）→ 审批仍走 alphaApprovals。仅在启用 gateway 时注册。
  if (gatewayHub && subagents?.registerProvider) {
    subagents.registerProvider(createGatewaySubagentProvider({
      catalog,
      engine,
      store,
      allowedRoots
    }));
  }

  ctx.provide("alphaMachineId", localMachineId());
  ctx.provide("alphaCatalog", catalog);
  ctx.provide("alphaTasks", store);
  ctx.provide("alphaApprovals", approvals);
  ctx.provide("alphaEngine", engine);
}