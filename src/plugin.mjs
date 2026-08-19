// dsh-alpha 主控插件（host 平面）：
// 在 root realm 发布 alphaCatalog / alphaTasks / alphaApprovals / alphaEngine
// 四个服务，供 alpha preset 的工具行（agent 平面）注入消费。
//
// 挂载行：见 cordis.patch.yml 的 `dsh-alpha` row。

import path from "node:path";
import os from "node:os";
import z from "@deepseek-ai/schemastery";
import { createCatalog, defaultAllowedRoots, localMachineId } from "./lib/catalog.js";
import { createTaskStore } from "./lib/task-store.js";
import { createApprovalBroker } from "./lib/approvals.js";
import { createTaskEngine } from "./lib/task-engine.js";
import { createRecursiveAdapter } from "./lib/recursive-adapter.js";
import { listLocalAgentProviders, probeAvailability, buildCapabilitiesFor, createLocalAgentAdapter } from "./lib/adapters.js";
import { createGatewayHub, parseMachineTokens } from "./lib/gateway-hub.js";

export const name = "dsh-alpha";

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
  let gatewayHub = null;
  const gatewayPort = config.gatewayPort || Number(process.env.DSH_ALPHA_GATEWAY_PORT) || 0;
  if (gatewayPort) {
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
    ctx.logger?.info?.(`[dsh-alpha] gateway hub 监听 :${boundPort}（接受 ${tokenIds.length} 台机器）`);
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
      return createLocalAgentAdapter(agent.provider);
    }
  });
  engineRef = engine;

  ctx.provide("alphaMachineId", localMachineId());
  ctx.provide("alphaCatalog", catalog);
  ctx.provide("alphaTasks", store);
  ctx.provide("alphaApprovals", approvals);
  ctx.provide("alphaEngine", engine);
}