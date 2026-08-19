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

const { randomUUID } = require("node:crypto");
const os = require("node:os");
const { GatewayMessageType, GatewayRequestMethod } = require("../adapters/vendor/shared/gateway-protocol");
const { connectWebSocket } = require("../adapters/vendor/shared/websocket");
const { createLocalAgentAdapter, buildCapabilitiesFor, listLocalAgentProviders } = require("./adapters");

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

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
    if (interruptable) interruptable.events.add(done);
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
  repos = null, // [{ repo_url, path }] · 本机已持有的 repo（目录/repo 身份选机用）
  ensureRepo = null, // async (repoUrl, { roots }) => Promise<path|null> · 按需 clone
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  log = console,
  connect = connectWebSocket,
  disconnect = async () => {},
  isStopped = () => false,
  onConnected = async () => {},
  onDisconnected = async () => {}
}) {
  const providerList = providers.length ? providers : listLocalAgentProviders();
  // 允许访问目录受限时只广播本机根；默认不广播（远端各自校验）
  let roots = allowedRoots;
  if (!roots && process.env.DSH_ALPHA_WORKER_ALLOWED_ROOTS) {
    roots = process.env.DSH_ALPHA_WORKER_ALLOWED_ROOTS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  let repoList = repos;
  if (!repoList && process.env.DSH_ALPHA_WORKER_REPOS) {
    try {
      repoList = JSON.parse(process.env.DSH_ALPHA_WORKER_REPOS);
    } catch {
      repoList = null;
    }
  }

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
      repos: Array.isArray(repoList) ? repoList : []
    };
  }

  // 本机 repo 身份：canonical 比对，命中返回本机路径
  function localRepoPath(repoUrl) {
    if (!repoUrl || !Array.isArray(repoList)) return null;
    const { normalizeRepoUrl } = require("../adapters/vendor/shared/repo-identity");
    const key = normalizeRepoUrl(repoUrl);
    if (!key) return null;
    for (const repo of repoList) {
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
    const handle = { adapter, cancelled: false };
    if (sessionId) activeTurns.set(sessionId, handle);

    // 阶段 3 repo 身份：payload.repoUrl 时优先用本机已有 repo 的路径；
    // needsClone 且本机无 repo → 按需 clone（洞则报错，不让 runtime 拿到空路径）
    let runContext = payload;
    if (payload?.repoUrl) {
      const localPath = localRepoPath(payload.repoUrl);
      if (localPath) {
        runContext = { ...runContext, project: { ...(payload.project || {}), path: localPath } };
      } else if (payload.needsClone) {
        if (typeof ensureRepo !== "function") {
          send(socket, {
            type: GatewayMessageType.STREAM_ERROR,
            request_id: requestId,
            payload: { error: `按需 clone 未启用（repo=${payload.repoUrl}）` }
          });
          return;
        }
        const clonedPath = await ensureRepo(payload.repoUrl, { roots, machineId });
        if (!clonedPath) {
          send(socket, {
            type: GatewayMessageType.STREAM_ERROR,
            request_id: requestId,
            payload: { error: `按需 clone 失败（repo=${payload.repoUrl}）` }
          });
          return;
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

    const context = {
      ...runContext,
      requestApproval: remoteRequestApproval(socket, requestId)
    };
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
    const message = JSON.parse(raw);
    if (message.type === GatewayMessageType.REQUEST) {
      log.log(`[alpha-worker] 收到请求: ${message.method} (${message.request_id})`);
      handleRequest(currentSocket, message).catch((error) => log.error?.("[alpha-worker] 请求处理失败:", error.message));
    } else if (message.type === GatewayMessageType.HELLO_ACK) {
      log.log(`[alpha-worker] ${machineId} 已在主控注册`);
    }
  }

  async function connectOnce(wsUrl) {
    const socket = await connect(wsUrl);
    currentSocket = socket;
    const heartbeatTimer = setInterval(() => {
      send(socket, {
        type: GatewayMessageType.HEARTBEAT,
        payload: { load: { active_turns: activeTurns.size }, repos: Array.isArray(repoList) ? repoList : [] }
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
        handle.adapter?.cancelTurn?.({}).catch(() => {});
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
      await wait(reconnectDelayMs(failureCount), interrupt);
    }
  }

  function stop() {
    stopped = true;
    interrupt.release();
    currentSocket?.close();
  }

  return { loop, stop, get machineId() { return machineId; } };
}

module.exports = { runGatewayWorker, reconnectDelayMs, terminalType };