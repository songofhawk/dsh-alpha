// 阶段 1/2：gateway worker —— 远端侧反向连出主控 hub。
//
// worker 在目标机上连出（目标机无需公网 IP），完成：
//   - 携带 per-machine token 握手，hello 注册机器 + 各 provider 能力
//   - 周期 heartbeat（load / repos）
//   - 消费 hub 的 run 请求，驱动本机 vendored runtime（与阶段 0 同契约），
//     把归一化事件流回传 STREAM_EVENT，终态回 STREAM_COMPLETE/STREAM_ERROR
//   - cancel_turn → 本机 runtime.cancelTurn
//   - 本机 runtime 的 requestApproval → approval_request 上行主控，
//     等 approval_decision 下行后以 {status, decision} 解析
//   - 断线指数退避重连（REST 无状态：机器身份由 token 绑定）

const { randomUUID, createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { GatewayMessageType, GatewayRequestMethod } = require("../adapters/vendor/shared/gateway-protocol");
const { connectWebSocket } = require("../adapters/vendor/shared/websocket");
const { normalizeRepoUrl } = require("../adapters/vendor/shared/repo-identity");
const { parseAllowedRoots, resolveProjectPath } = require("../adapters/vendor/shared/path-policy");
const { createLocalAgentAdapter, buildCapabilitiesFor, listDefaultAgentProviders, probeAvailability } = require("./adapters");
const { discoverGitWorkspaces } = require("./workspaces");

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RECONNECT_MIN_MS = 1_000;
// master 是按任务启动的短生命周期进程；worker 退避过久会错过 readiness 窗口。
const DEFAULT_RECONNECT_MAX_MS = 5_000;

function runGitClone(repoUrl, target, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["clone", "--", repoUrl, target], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone 失败（exit=${code}）：${stderr.trim().slice(-2000)}`));
    });
  });
}

// 默认按需 clone：目标固定落在首个 allowed root 的内部目录，URL 只作为 git 参数，
// 不参与路径拼接；同一 repo 的并发请求复用一个 promise。
function createGitRepoEnsurer({ clone = runGitClone } = {}) {
  const inflight = new Map();
  return async function ensureRepo(repoUrl, { roots } = {}) {
    const canonical = normalizeRepoUrl(repoUrl);
    if (!canonical) throw new Error(`repo URL 不合法：${repoUrl}`);
    const allowedRoots = Array.isArray(roots) ? roots.map((root) => path.resolve(root)) : [];
    if (!allowedRoots.length) throw new Error("按需 clone 必须配置至少一个 worker allowed root");

    const root = allowedRoots[0];
    fs.mkdirSync(root, { recursive: true });
    const basename = path.basename(canonical).replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
    const suffix = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
    const cloneBase = resolveProjectPath(path.join(root, ".dsh-alpha", "repos"), allowedRoots);
    const target = resolveProjectPath(path.join(cloneBase, `${basename}-${suffix}`), allowedRoots);
    const gitMarker = path.join(target, ".git");
    if (fs.existsSync(gitMarker)) return target;
    if (fs.existsSync(target)) throw new Error(`clone 目标已存在但不是 git 仓库：${target}`);

    if (inflight.has(canonical)) return inflight.get(canonical);
    const pending = (async () => {
      fs.mkdirSync(cloneBase, { recursive: true });
      await clone(repoUrl, target, { cwd: cloneBase });
      if (!fs.existsSync(gitMarker)) throw new Error(`git clone 未生成仓库：${target}`);
      return target;
    })();
    inflight.set(canonical, pending);
    try {
      return await pending;
    } finally {
      inflight.delete(canonical);
    }
  };
}

function buildWorkerHubUrl(rawUrl, { token, machineId } = {}) {
  let url;
  try {
    url = new URL(rawUrl || "ws://127.0.0.1:4310/");
  } catch {
    throw new Error(`DSH_ALPHA_HUB_URL 不合法：${rawUrl}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("DSH_ALPHA_HUB_URL 必须使用 ws:// 或 wss://");
  }
  if (machineId) url.searchParams.set("machine", machineId);
  if (!token && !url.searchParams.get("token")) {
    throw new Error("worker 必须通过 DSH_ALPHA_WORKER_TOKEN 或 HUB URL 的 token 参数配置认证");
  }
  return url.toString();
}

function terminalType(event) {
  return ["complete", "cancelled", "error"].includes(event?.type);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function reconnectDelayMs(failureCount, { minMs = DEFAULT_RECONNECT_MIN_MS, maxMs = DEFAULT_RECONNECT_MAX_MS } = {}) {
  const min = positiveInteger(minMs, DEFAULT_RECONNECT_MIN_MS);
  const max = Math.max(min, positiveInteger(maxMs, DEFAULT_RECONNECT_MAX_MS));
  return Math.min(max, min * (2 ** Math.max(0, failureCount - 1)));
}

// 可被 stop() 提前唤醒的等待：避免测试/关闭时悬挂
const wait = (ms, interruptable) => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    if (interruptable) interruptable.events.delete(done);
    resolve();
  }
  if (interruptable) {
    interruptable.events.add(done);
    interruptable.stop.then(() => {
      clearTimeout(timer);
      resolve();
    });
  }
});

function createInterrupt() {
  let release;
  return {
    stop: new Promise((resolve) => { release = resolve; }),
    events: new Set(),
    release() {
      release();
      for (const done of this.events) done();
      this.events.clear();
    }
  };
}

function runGatewayWorker({
  hubUrl, // ws://host:port/alpha?token=...
  machineId = process.env.DSH_ALPHA_WORKER_MACHINE_ID || os.hostname() || "worker",
  providers = (process.env.DSH_ALPHA_WORKER_PROVIDERS || "").split(",").map((s) => s.trim()).filter(Boolean),
  allowedRoots = null,
  workspaces = null, // [{ name?, repo_url?, path }] · 全局工作区 inventory
  repos = null, // [{ repo_url, path }] · 本机已持有的 repo（目录/repo 身份选机用）
  discoverWorkspaces = process.env.DSH_ALPHA_WORKER_DISCOVER_WORKSPACES !== "0",
  ensureRepo = null, // async (repoUrl, { roots }) => Promise<path|null> · 按需 clone
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  reconnectMinMs = DEFAULT_RECONNECT_MIN_MS,
  reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
  log = console,
  connect = connectWebSocket,
  disconnect = async () => {},
  isStopped = () => false,
  onConnected = async () => {},
  onDisconnected = async () => {},
  probeProvider = probeAvailability,
  gatewayToken = null
}) {
  const providerCandidates = providers.length ? providers : listDefaultAgentProviders();
  const providerList = providerCandidates.filter((provider) => {
    try {
      const probe = probeProvider(provider);
      if (probe?.available) return true;
      log.warn?.(`[alpha-worker] 跳过不可用 provider ${provider}：${probe?.reason || "探测失败"}`);
      return false;
    } catch (error) {
      log.warn?.(`[alpha-worker] 跳过不可用 provider ${provider}：${error.message}`);
      return false;
    }
  });
  // worker 始终广播并执行自己的目录边界；未显式配置时沿用路径策略的 cwd 父目录。
  let roots = allowedRoots;
  if (!roots && process.env.DSH_ALPHA_WORKER_ALLOWED_ROOTS) {
    roots = process.env.DSH_ALPHA_WORKER_ALLOWED_ROOTS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (!roots) roots = parseAllowedRoots();
  let repoList = repos;
  if (!repoList && process.env.DSH_ALPHA_WORKER_REPOS) {
    try {
      repoList = JSON.parse(process.env.DSH_ALPHA_WORKER_REPOS);
    } catch {
      repoList = null;
    }
  }
  if (repoList && !Array.isArray(repoList)) {
    repoList = Object.entries(repoList).map(([repo_url, repoPath]) => ({ repo_url, path: repoPath }));
  }
  if (!Array.isArray(repoList)) repoList = [];
  let explicitWorkspaces = workspaces;
  if (!explicitWorkspaces && process.env.DSH_ALPHA_WORKER_WORKSPACES) {
    try {
      explicitWorkspaces = JSON.parse(process.env.DSH_ALPHA_WORKER_WORKSPACES);
    } catch {
      explicitWorkspaces = null;
    }
  }
  if (explicitWorkspaces && !Array.isArray(explicitWorkspaces)) {
    explicitWorkspaces = Object.entries(explicitWorkspaces).map(([name, value]) => typeof value === "string"
      ? { name, path: value }
      : { name, ...value });
  }
  const workspaceList = discoverGitWorkspaces(roots, {
    explicit: [...repoList, ...(Array.isArray(explicitWorkspaces) ? explicitWorkspaces : [])],
    scan: discoverWorkspaces
  });
  repoList = workspaceList.filter((workspace) => workspace.repo_url);
  const ensureRepoImpl = ensureRepo || createGitRepoEnsurer();

  const activeTurns = new Map(); // session.id -> adapter handle
  const pendingApprovals = new Map(); // runtime_request_id -> { resolve, reject, timer }
  let currentSocket = null;

  function helloPayload() {
    return {
      machineId,
      os: process.platform,
      platform: process.platform,
      allowedRoots: roots,
      providers: providerList.map((provider) => ({
        provider,
        capabilities: buildCapabilitiesFor(provider)
      })),
      load: { active_turns: activeTurns.size },
      workspaces: workspaceList,
      repos: repoList
    };
  }

  // 本机 repo 身份：canonical 比对，命中返回本机路径
  function localRepoPath(repoUrl) {
    if (!repoUrl) return null;
    const key = normalizeRepoUrl(repoUrl);
    if (!key) return null;
    for (const repo of workspaceList) {
      if (normalizeRepoUrl(repo.repo_url || repo.url) === key && repo.path) return repo.path;
    }
    return null;
  }

  function send(socket, message) {
    if (socket.closed || socket.socket?.destroyed) return false;
    try {
      socket.sendJson(message);
      return true;
    } catch {
      return false;
    }
  }

  // 远端审批冒泡：把一个请求挂起等主控 decision
  function remoteRequestApproval(socket, requestId) {
    return (payload) => {
      const runtimeRequestId = payload?.runtime_request_id || payload?.id || randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingApprovals.delete(runtimeRequestId);
          // 审批超时：故障默认拒绝
          resolve({ status: "rejected", decision: "rejected", reason: "审批超时" });
        }, 30 * 60 * 1000);
        pendingApprovals.set(runtimeRequestId, { resolve, reject, timer });
        if (!send(socket, {
          type: GatewayMessageType.APPROVAL_REQUEST,
          request_id: requestId,
          payload: { ...payload, runtime_request_id: runtimeRequestId }
        })) {
          clearTimeout(timer);
          pendingApprovals.delete(runtimeRequestId);
          reject(new Error("gateway 连接已断开"));
        }
      });
    };
  }

  async function handleRun(socket, requestId, payload) {
    const session = payload?.session || {};
    const sessionId = session.id;
    const adapter = createLocalAgentAdapter(session.provider);
    const handle = { adapter, context: null, cancelled: false };
    if (sessionId) activeTurns.set(sessionId, handle);
    try {

    // 阶段 3 repo 身份：payload.repoUrl 时优先用本机已有 repo 的路径；
    // needsClone 且本机无 repo → 按需 clone（洞则报错，不让 runtime 拿到空路径）
    let runContext = payload;
    if (payload?.repoUrl) {
      const localPath = localRepoPath(payload.repoUrl);
      if (localPath) {
        runContext = { ...runContext, project: { ...(payload.project || {}), path: localPath } };
      } else if (payload.needsClone) {
        const clonedPath = await ensureRepoImpl(payload.repoUrl, { roots, machineId });
        if (!clonedPath) {
          send(socket, {
            type: GatewayMessageType.STREAM_ERROR,
            request_id: requestId,
            payload: { error: `按需 clone 失败（repo=${payload.repoUrl}）` }
          });
          return;
        }
        if (!localRepoPath(payload.repoUrl)) {
          const repoKey = normalizeRepoUrl(payload.repoUrl);
          const discovered = {
            name: path.basename(repoKey || clonedPath),
            repo_url: repoKey,
            path: clonedPath
          };
          workspaceList.push(discovered);
          repoList.push(discovered);
        }
        runContext = { ...runContext, project: { ...(payload.project || {}), path: clonedPath } };
      } else {
        send(socket, {
          type: GatewayMessageType.STREAM_ERROR,
          request_id: requestId,
          payload: { error: `本机没有 repo：${payload.repoUrl}` }
        });
        return;
      }
    }

    if (runContext?.project?.path) {
      runContext = {
        ...runContext,
        project: {
          ...runContext.project,
          path: resolveProjectPath(runContext.project.path, roots)
        }
      };
    }

    const context = {
      ...runContext,
      requestApproval: remoteRequestApproval(socket, requestId)
    };
    handle.context = context;
    let terminal = null;
    try {
      for await (const event of adapter.runTurn(context)) {
        if (!send(socket, {
          type: GatewayMessageType.STREAM_EVENT,
          request_id: requestId,
          payload: event
        })) {
          // 连接断开：尽力取消本机 runtime
          await adapter.cancelTurn(context).catch(() => {});
          break;
        }
        if (terminalType(event)) {
          terminal = event.type;
          break;
        }
      }
    } catch (error) {
      send(socket, {
        type: GatewayMessageType.STREAM_ERROR,
        request_id: requestId,
        payload: { error: error.message }
      });
      return;
    }

    if (terminal === "cancelled" || terminal === "complete") {
      send(socket, {
        type: GatewayMessageType.STREAM_COMPLETE,
        request_id: requestId,
        payload: { terminal_status: terminal === "cancelled" ? "cancelled" : "completed" }
      });
    } else {
      send(socket, {
        type: GatewayMessageType.STREAM_ERROR,
        request_id: requestId,
        payload: { error: terminal ? `远端流意外终结于 ${terminal}` : "runtime 流意外结束" }
      });
    }
    } finally {
      if (sessionId) activeTurns.delete(sessionId);
    }
  }

  async function handleRequest(socket, message) {
    const { request_id: requestId, method, payload } = message;
    if (method === GatewayRequestMethod.CANCEL_TURN) {
      const sessionId = payload?.session?.id;
      const handle = sessionId && activeTurns.get(sessionId);
      try {
        await handle?.adapter.cancelTurn(payload || {});
        send(socket, { type: GatewayMessageType.RESPONSE, request_id: requestId, payload: { ok: true } });
      } catch (error) {
        send(socket, { type: GatewayMessageType.RESPONSE, request_id: requestId, payload: { error: error.message } });
      }
      return;
    }
    if (method === "approval_decision") {
      const runtimeRequestId = payload?.runtime_request_id;
      const pending = runtimeRequestId && pendingApprovals.get(runtimeRequestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingApprovals.delete(runtimeRequestId);
        pending.resolve({ status: payload?.status, decision: payload?.decision });
      }
      send(socket, { type: GatewayMessageType.RESPONSE, request_id: requestId, payload: { ok: true } });
      return;
    }
    if (method === GatewayRequestMethod.RUN) {
      handleRun(socket, requestId, payload).catch((error) => {
        send(socket, {
          type: GatewayMessageType.STREAM_ERROR,
          request_id: requestId,
          payload: { error: error.message }
        });
      });
      return;
    }
    send(socket, { type: GatewayMessageType.RESPONSE, request_id: requestId, payload: { error: "unknown method" } });
  }

  function handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      log.error?.("[alpha-worker] 收到非法 gateway JSON，已忽略");
      return;
    }
    if (message.type === GatewayMessageType.REQUEST) {
      log.log(`[alpha-worker] 收到请求: ${message.method} (${message.request_id})`);
      handleRequest(currentSocket, message).catch((error) => log.error?.("[alpha-worker] 请求处理失败:", error.message));
    } else if (message.type === GatewayMessageType.HELLO_ACK) {
      log.log(`[alpha-worker] ${machineId} 已在主控注册`);
    }
  }

  async function connectOnce(wsUrl) {
    const headers = {};
    if (gatewayToken) headers["X-Alpha-Gateway-Token"] = gatewayToken;
    if (machineId) headers["X-Alpha-Gateway-Machine"] = machineId;
    const socket = await connect(wsUrl, { headers });
    currentSocket = socket;
    const heartbeatTimer = setInterval(() => {
      send(socket, {
        type: GatewayMessageType.HEARTBEAT,
        payload: { load: { active_turns: activeTurns.size }, workspaces: workspaceList, repos: repoList }
      });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    socket.on("message", (raw) => handleMessage(raw));
    socket.on("error", (error) => log.error?.("[alpha-worker] 连接错误:", error.message));
    socket.on("close", () => {
      clearInterval(heartbeatTimer);
      currentSocket = null;
      // 断线：所有在跑权限请求按拒绝/失败扼收
      for (const [, pending] of pendingApprovals) {
        clearTimeout(pending.timer);
        pending.resolve({ status: "rejected", decision: "rejected", reason: "连接断开" });
      }
      pendingApprovals.clear();
      for (const [, handle] of activeTurns) {
        handle.adapter?.cancelTurn?.(handle.context || {}).catch(() => {});
      }
      activeTurns.clear();
      onDisconnected?.();
    });

    send(socket, { type: GatewayMessageType.HELLO, payload: helloPayload() });
    await onConnected?.();
    return socket;
  }

  let stopped = false;
  const interrupt = createInterrupt();

  async function loop() {
    let failureCount = 0;
    while (!stopped && !isStopped()) {
      let connected = false;
      try {
        const wsUrl = typeof hubUrl === "function" ? hubUrl() : hubUrl;
        const socket = await connectOnce(wsUrl);
        connected = true;
        failureCount = 0;
        log.log(`[alpha-worker] ${machineId} 已连上主控`);
        // 维持连接直到断线；stop() 会关 socket → close 事件 → 退出等待
        await new Promise((resolve) => socket.once("close", () => resolve()));
      } catch (error) {
        if (stopped || isStopped()) {
          log.log("[alpha-worker] 已停止");
          break;
        }
        failureCount += 1;
        log.error?.("[alpha-worker] 连接失败:", error.message);
        await disconnect?.();
      }
      if (connected) await disconnect?.();
      if (stopped || isStopped()) break;
      await wait(reconnectDelayMs(failureCount, { minMs: reconnectMinMs, maxMs: reconnectMaxMs }), interrupt);
    }
  }

  function stop() {
    stopped = true;
    interrupt.release();
    currentSocket?.close();
  }

  return { loop, stop, get machineId() { return machineId; } };
}

module.exports = {
  runGatewayWorker,
  reconnectDelayMs,
  terminalType,
  createGitRepoEnsurer,
  runGitClone,
  buildWorkerHubUrl
};
