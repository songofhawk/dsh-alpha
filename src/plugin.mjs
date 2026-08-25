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
import { listDefaultAgentProviders, probeAvailability, buildCapabilitiesFor, createLocalAgentAdapter } from "./lib/adapters.js";
import { createGatewayHub, parseMachineTokens } from "./lib/gateway-hub.js";
import { discoverGitWorkspaces } from "./lib/workspaces.js";
import { createWorkspaceService } from "./lib/workspace-service.js";

export const name = "dsh-alpha";
// Web-safe 控制平面不向宿主 subagent registry 注入第二套 DSH provider；
// alpha 工具统一经本引擎的 vendor adapter / Gateway 路由。
export const inject = [];

export const Config = z.object({
  dataDir: z.string(),
  providers: z.array(z.string()),
  allowedRoots: z.array(z.string()),
  defaultMode: z.string().default("auto-review"),
  defaultApprovalPolicy: z.string().default("on-request"),
  defaultModel: z.string(),
  checkAvailability: z.boolean().default(true),
  discoverWorkspaces: z.boolean().default(true),
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

function parseWorkspaceEnv(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed).map(([name, item]) => typeof item === "string"
        ? { name, path: item }
        : { name, ...item });
    }
  } catch {
    /* 非法配置由空目录安全降级，不把 Web 整体拖垮 */
  }
  return [];
}

function rpcFailure(error, { workspaceId } = {}) {
  const id = workspaceId === null || workspaceId === undefined ? "" : String(workspaceId).trim();
  const missingWorkspace = Number(error?.statusCode) === 404 && id;
  return {
    ok: false,
    error: {
      // RpcErrorCode 没有通用的 not-found/conflict；必须返回已声明的
      // 分支，否则浏览器会在解析响应时先报 invalid_union。
      code: missingWorkspace ? "workspace-not-found" : "bad-request",
      message: error instanceof Error ? error.message : String(error),
      details: missingWorkspace ? { workspaceId: id } : { issues: [] }
    }
  };
}

function sessionAgentPreset(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "agent-preset/selected") return event.data?.agentPreset;
  }
  return session?.header?.agentPreset;
}

async function resolveSessionAgentPreset(connectionCtx, sessionId) {
  const live = sessionId ? connectionCtx.sessions.get(sessionId) : undefined;
  const livePreset = sessionAgentPreset(live);
  if (livePreset !== undefined) return livePreset;
  const inspect = connectionCtx.sessionPersistence?.inspect;
  if (typeof inspect !== "function" || !sessionId) return livePreset;
  try {
    const persisted = await inspect.call(connectionCtx.sessionPersistence, sessionId);
    return sessionAgentPreset({
      header: persisted?.meta || persisted?.header,
      events: persisted?.events
    });
  } catch {
    return livePreset;
  }
}

export function registerWorkspaceRpc(ctx, workspaces) {
  if (typeof ctx.inject !== "function") return;
  ctx.inject(["connection", "sessions", "sessionPersistence"], (connectionCtx) => {
    connectionCtx.connection.rpc.handle("/dsh-alpha", async (endpoint, payload) => {
      try {
        const sessionId = String(payload?.sessionId || "");
        const enabled = await resolveSessionAgentPreset(connectionCtx, sessionId) === "alpha";
        if (endpoint === "workspace/list") {
          return {
            ok: true,
            value: {
              enabled,
              controlCwd: workspaces.controlCwd,
              selectedWorkspaceId: workspaces.selected(sessionId)?.workspaceId || null,
              workspaces: workspaces.list({ query: payload?.query || "" })
            }
          };
        }
        if (endpoint === "workspace/select") {
          if (!enabled) {
            const error = new Error("只有 alpha 主控会话可以选择全局工作区");
            error.statusCode = 409;
            throw error;
          }
          return { ok: true, value: workspaces.select(sessionId, payload?.workspaceId ?? null) };
        }
        const error = new Error(`未知 dsh-alpha RPC：${endpoint}`);
        error.statusCode = 404;
        throw error;
      } catch (error) {
        return rpcFailure(error, {
          workspaceId: endpoint === "workspace/select" ? payload?.workspaceId : undefined
        });
      }
    // 该通道只读目录或写入当前 alpha session 的逻辑工作区选择；部署到
    // Cloudflare Access 后必须允许 DSH 已声明的 trusted host。Host 仍只
    // 监听 loopback，且未通过 Access 的公网请求到不了这里。
    }, { authority: "trusted-host" });
  });
}

export async function apply(ctx, config) {
  const dataDir = config.dataDir
    || process.env.DSH_ALPHA_DATA_DIR
    || path.join(resolveHome(), "storages", "dsh-alpha");
  const providers = firstOr(config.providers,
    firstOr(splitProviders(process.env.DSH_ALPHA_PROVIDERS), listDefaultAgentProviders()));
  const allowedRoots = firstOr(config.allowedRoots,
    firstOr(splitProviders(process.env.DSH_ALPHA_ALLOWED_ROOTS), defaultAllowedRoots()));
  const localWorkspaces = discoverGitWorkspaces(allowedRoots, {
    explicit: parseWorkspaceEnv(process.env.DSH_ALPHA_WORKSPACES),
    scan: config.discoverWorkspaces !== false
  });

  const defaults = {
    mode: config.defaultMode || process.env.DSH_ALPHA_DEFAULT_MODE || "auto-review",
    approval_policy: config.defaultApprovalPolicy || process.env.DSH_ALPHA_APPROVAL_POLICY || "on-request",
    model: config.defaultModel || process.env.DSH_ALPHA_DEFAULT_MODEL || undefined
  };

  const catalog = createCatalog({
    allowedRoots,
    workspaces: localWorkspaces,
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

  const store = createTaskStore({ dataDir });
  store.recoverInterrupted();
  const workspaceService = createWorkspaceService({ catalog, dataDir });
  registerWorkspaceRpc(ctx, workspaceService);

  const approvals = createApprovalBroker({ store });
  let engineRef = null;
  const engine = createTaskEngine({
    catalog,
    workspaces: workspaceService,
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
      // 本机与 worker 使用同一套已验证 vendor runtime；避免 Web profile 安装
      // 第二份 DSH provider/tool 包造成私有 Symbol 与宿主运行时不一致。
      return createLocalAgentAdapter(agent.provider);
    }
  });
  engineRef = engine;

  ctx.provide("alphaMachineId", localMachineId());
  ctx.provide("alphaCatalog", catalog);
  ctx.provide("alphaWorkspaces", workspaceService);
  ctx.provide("alphaTasks", store);
  ctx.provide("alphaApprovals", approvals);
  ctx.provide("alphaEngine", engine);
}
