// 阶段 1/2：gateway hub —— 主控侧反向 WS 中继。
//
// 接收 worker 连出的 WebSocket（跨 NAT 主路径），完成：
//   - 认证（per-machine token，硬前提，见 design §6）
//   - hello 握手 → 把远端机器 + 各 provider 广告注册进目录服务
//   - heartbeat → 刷新 machine 行 load / repos / online
//   - run / cancel_turn / approval_decision 请求转发
//   - stream_event / stream_complete / stream_error 按 request_id 汇聚回 run() 生成器
//   - 远端 approval_request → 主控侧批准 broker → decision 回传 worker（审批桥接）
//
// 协议：vendored gateway-protocol.js（常量）+ hello/hello_ack/approval_request 扩展。
// 与本机引擎的接缝：hub.run() 返回 async generator，与 createLocalAgentAdapter.runTurn
// 同形，因此 task-engine 对远端 agent 与本地 agent 走同一套事件驱动。

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { GatewayMessageType, GatewayRequestMethod } = require("../adapters/vendor/shared/gateway-protocol");
const { upgradeToWebSocket, rejectUpgrade } = require("../adapters/vendor/shared/websocket");

const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function unavailableError(machineId, reason = "机器未连接") {
  const error = new Error(`远端机器 ${machineId} 不可达：${reason}`);
  error.statusCode = 503;
  return error;
}

function unavailable(machineId, reason = "机器未连接") {
  throw unavailableError(machineId, reason);
}

function parseMachineTokens(value) {
  const tokens = {};
  for (const pair of String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const separator = pair.indexOf(":");
    if (separator <= 0) continue;
    const machineId = pair.slice(0, separator).trim();
    const token = pair.slice(separator + 1).trim();
    if (machineId && token) tokens[machineId] = token;
  }
  return tokens;
}

// 单消费者异步队列：hub.run 的生成器逐条消费远端流
class AsyncEventQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;
  }

  push(kind, value) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ kind, value });
      return;
    }
    this.items.push({ kind, value });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    this.items.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  shift() {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    if (this.closed) return Promise.reject(this.error || new Error("queue closed"));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function createGatewayHub({
  catalog,
  tokens, // { machineId: token }
  port = 0,
  host = "127.0.0.1",
  log = console,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
}) {
  const machineTokens = tokens || {};
  const expectedWorkerCount = Object.keys(machineTokens).length;
  const connections = new Map(); // machineId -> { peer, machineId }
  const activeRuns = new Map(); // requestId -> { machineId, queue, brokerApproval }
  const pendingRequests = new Map(); // 双向请求 requestId -> { resolve, reject, timer }
  const connectionWaiters = new Set(); // headless 启动时等待常驻 worker 重连

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      const body = JSON.stringify({ status: "ok", connected_workers: connections.size });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store"
      });
      res.end(body);
      return;
    }
    res.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("alpha gateway: websocket upgrade only");
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token") || req.headers["x-alpha-gateway-token"];
    const machineIdCandidate = url.searchParams.get("machine") || req.headers["x-alpha-gateway-machine"] || null;

    // 认证：token 必须匹配已知机器（machineId 直配或 token 反查）
    const machineId = machineIdCandidate && machineTokens[machineIdCandidate] === token
      ? machineIdCandidate
      : Object.keys(machineTokens).find((id) => machineTokens[id] === token);
    if (!machineId) {
      log.warn?.(`[alpha-gateway] 认证失败${token ? "" : "（无 token）"}`);
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    attach(upgradeToWebSocket(req, socket), machineId);
  });

  function attach(peer, machineId) {
    peer.on("message", (raw) => handleMessage(machineId, raw, peer));
    peer.on("error", (error) => log.error?.("[alpha-gateway] peer error:", error.message));
    peer.on("close", () => {
      if (connections.get(machineId)?.peer === peer) {
        connections.delete(machineId);
        catalog.markMachineOffline(machineId);
        log.log(`[alpha-gateway] ${machineId} 断开`);
        for (const run of activeRuns.values()) {
          if (run.machineId === machineId) run.connected = false;
        }
      }
    });
    connections.set(machineId, { peer, machineId });
    for (const waiter of [...connectionWaiters]) {
      if (connections.size < waiter.min) continue;
      clearTimeout(waiter.timer);
      connectionWaiters.delete(waiter);
      waiter.resolve({ ready: true, connectedWorkers: connections.size });
    }
    log.log(`[alpha-gateway] ${machineId} 已连接`);
  }

  function waitForConnections({ min = 1, timeoutMs = 2_000 } = {}) {
    const required = Math.max(1, Number.parseInt(min, 10) || 1);
    const timeout = Math.max(0, Number.parseInt(timeoutMs, 10) || 0);
    if (connections.size >= required) {
      return Promise.resolve({ ready: true, connectedWorkers: connections.size });
    }
    if (timeout === 0) {
      return Promise.resolve({ ready: false, connectedWorkers: connections.size });
    }
    return new Promise((resolve) => {
      const waiter = { min: required, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        connectionWaiters.delete(waiter);
        resolve({ ready: false, connectedWorkers: connections.size });
      }, timeout);
      connectionWaiters.add(waiter);
    });
  }

  function sendRequest(peer, method, payload, { timeoutMs = requestTimeoutMs } = {}) {
    const requestId = randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`请求超时：${method}`));
      }, timeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timer });
    });
    try {
      peer.sendJson({
        type: GatewayMessageType.REQUEST,
        request_id: requestId,
        method,
        payload
      });
    } catch (error) {
      const pending = pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(requestId);
        pending.reject(error);
      }
    }
    return promise;
  }

  function handleMessage(machineId, raw, peer) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      peer.sendJson({ type: GatewayMessageType.ERROR, error: "invalid json" });
      return;
    }
    const { type, request_id: requestId } = message;
    const payload = message.payload;

    switch (type) {
      case GatewayMessageType.HELLO: {
        const hello = payload || {};
        // 机器身份一律以认证结果为准（hello.machineId 仅展示用，不可伪造注册身份）
        for (const row of hello.providers || []) {
          catalog.registerRemoteAgent({
            machineId,
            provider: row.provider,
            capabilities: row.capabilities || {},
            machine: {
              os: hello.os,
              platform: hello.platform,
              allowedRoots: hello.allowedRoots,
              workspaces: hello.workspaces,
              repos: hello.repos
            }
          });
        }
        catalog.heartbeatRemote({ machineId, load: hello.load, workspaces: hello.workspaces, repos: hello.repos });
        for (const run of activeRuns.values()) {
          if (run.machineId !== machineId) continue;
          run.connected = true;
          for (const message of run.pendingMessages.splice(0)) peer.sendJson(message);
        }
        log.log(`[alpha-gateway] ${machineId} 注册 ${(hello.providers || []).length} 个 provider`);
        peer.sendJson({ type: GatewayMessageType.HELLO_ACK, machine_id: machineId });
        break;
      }
      case GatewayMessageType.HEARTBEAT: {
        catalog.heartbeatRemote({ machineId, load: payload?.load, workspaces: payload?.workspaces, repos: payload?.repos });
        const at = Date.now();
        for (const run of activeRuns.values()) {
          if (run.machineId === machineId) run.queue.push("event", { type: "heartbeat", payload: { at, machineId } });
        }
        break;
      }
      case GatewayMessageType.APPROVAL_REQUEST: {
        const run = activeRuns.get(requestId);
        if (!run?.brokerApproval) {
          // 没有可用的审批回调：故障默认拒绝
          peer.sendJson({
            type: GatewayMessageType.REQUEST,
            request_id: `approval-${requestId}`,
            method: "approval_decision",
            payload: {
              runtime_request_id: payload?.runtime_request_id || payload?.id || null,
              status: "rejected",
              decision: "rejected",
              reason: "无审批回调"
            }
          });
          return;
        }
        Promise.resolve()
          .then(() => run.brokerApproval(payload))
          .then(
            (result) => ({
              status: result?.status || "rejected",
              decision: result?.decision || "rejected"
            }),
            () => ({ status: "rejected", decision: "rejected" }) // 故障默认拒绝
          )
          .then((decision) => {
            const decisionMessage = {
              type: GatewayMessageType.REQUEST,
              request_id: `approval-${requestId}-${decision.decision}`,
              method: "approval_decision",
              payload: {
                runtime_request_id: payload?.runtime_request_id || payload?.id || null,
                ...decision
              }
            };
            const current = connections.get(machineId)?.peer;
            if (current) current.sendJson(decisionMessage);
            else run.pendingMessages.push(decisionMessage);
          });
        break;
      }
      case GatewayMessageType.STREAM_EVENT:
      case GatewayMessageType.STREAM_COMPLETE:
      case GatewayMessageType.STREAM_ERROR: {
        const run = activeRuns.get(requestId);
        const sequence = Number(message.sequence) || 0;
        const acknowledge = (abandoned = false) => {
          if (!sequence) return;
          peer.sendJson({
            type: GatewayMessageType.STREAM_ACK,
            request_id: requestId,
            task_id: message.task_id || run?.taskId || null,
            sequence,
            payload: { abandoned }
          });
        };
        if (!run || run.machineId !== machineId) {
          acknowledge(true);
          return;
        }
        if (sequence && sequence <= run.lastSequence) {
          acknowledge();
          return;
        }
        if (sequence && sequence !== run.lastSequence + 1) {
          acknowledge(true);
          run.queue.fail(new Error(`远端事件序列不连续：期望 ${run.lastSequence + 1}，收到 ${sequence}`));
          activeRuns.delete(requestId);
          return;
        }
        if (sequence) run.lastSequence = sequence;
        acknowledge();
        if (type === GatewayMessageType.STREAM_ERROR) {
          run.queue.fail(new Error(payload?.error || "远端 run 错误"));
        } else if (type === GatewayMessageType.STREAM_COMPLETE) {
          run.queue.push("complete", payload?.terminal_status || "completed");
        } else {
          run.queue.push("event", payload);
        }
        break;
      }
      case GatewayMessageType.RESPONSE: {
        const pending = pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(requestId);
          if (payload?.error) pending.reject(new Error(payload.error));
          else pending.resolve(payload || { ok: true });
        }
        break;
      }
      case GatewayMessageType.ERROR: {
        const run = activeRuns.get(requestId);
        if (run) run.queue.fail(new Error(payload?.error || "远端错误"));
        break;
      }
      default:
        break;
    }
  }

  // async generator：与本地 adapter.runTurn(context) 同形 → 引擎零改动接远端
  async function* run({ machineId, context }) {
    const connection = connections.get(machineId);
    if (!connection) unavailable(machineId);
    if (catalog.machineFor(machineId).online === false) unavailable(machineId, "心跳超时");

    const requestId = randomUUID();
    const queue = new AsyncEventQueue();
    const runRecord = {
      machineId,
      queue,
      taskId: context?.session?.id || null,
      lastSequence: 0,
      connected: true,
      pendingMessages: [],
      // 主控侧任务 broker 的审批回调；远端 approval_request 由 handleMessage 转交
      brokerApproval: context?.requestApproval || null
    };
    activeRuns.set(requestId, runRecord);

    try {
      connection.peer.sendJson({
        type: GatewayMessageType.REQUEST,
        request_id: requestId,
        method: GatewayRequestMethod.RUN,
        payload: context
      });

      while (true) {
        const item = await queue.shift();
        if (item.kind === "complete") return;
        yield item.value; // STREAM_EVENT（含 approval_request / delta / complete / ...）
      }
    } finally {
      activeRuns.delete(requestId);
    }
  }

  async function cancelTurn({ machineId, context }) {
    const connection = connections.get(machineId);
    if (!connection) {
      const taskId = context?.session?.id || null;
      const run = [...activeRuns.values()].find((item) => item.machineId === machineId && item.taskId === taskId);
      if (!run) unavailable(machineId);
      run.pendingMessages.push({
        type: GatewayMessageType.REQUEST,
        request_id: `cancel-${randomUUID()}`,
        method: GatewayRequestMethod.CANCEL_TURN,
        payload: context
      });
      return { ok: true, queued: true };
    }
    return sendRequest(connection.peer, GatewayRequestMethod.CANCEL_TURN, context, { timeoutMs: 30_000 });
  }

  async function discoverCapabilities({ machineId, provider, cwd, force = false } = {}) {
    const connection = connections.get(machineId);
    if (!connection) unavailable(machineId);
    return sendRequest(connection.peer, GatewayRequestMethod.DISCOVER_CAPABILITIES, {
      provider,
      ...(cwd ? { cwd } : {}),
      ...(force ? { force: true } : {})
    }, { timeoutMs: 30_000 });
  }

  async function listDirectories({ machineId, path: currentPath = null } = {}) {
    const connection = connections.get(machineId);
    if (!connection) unavailable(machineId);
    return sendRequest(connection.peer, GatewayRequestMethod.LIST_DIRECTORIES, {
      ...(currentPath ? { path: currentPath } : {})
    }, { timeoutMs: 30_000 });
  }

  async function createDirectory({ machineId, parentPath, name } = {}) {
    const connection = connections.get(machineId);
    if (!connection) unavailable(machineId);
    return sendRequest(connection.peer, GatewayRequestMethod.CREATE_DIRECTORY, {
      parentPath,
      name
    }, { timeoutMs: 30_000 });
  }

  function start() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve({ host, port: server.address().port });
      });
    });
  }

  let serverClosed = false;
  function close() {
    if (serverClosed) return Promise.resolve();
    serverClosed = true;
    for (const [, { peer }] of connections) {
      peer.close();
    }
    connections.clear();
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("hub 关闭"));
    }
    pendingRequests.clear();
    for (const run of activeRuns.values()) {
      run.queue.fail(new Error("hub 关闭"));
    }
    activeRuns.clear();
    for (const waiter of connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ready: false, connectedWorkers: 0, closed: true });
    }
    connectionWaiters.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    start,
    close,
    run,
    cancelTurn,
    discoverCapabilities,
    listDirectories,
    createDirectory,
    waitForConnections,
    expectedConnections: () => expectedWorkerCount,
    address: server.address.bind(server),
    connections: () => [...connections.keys()]
  };
}

module.exports = {
  createGatewayHub,
  parseMachineTokens
};
