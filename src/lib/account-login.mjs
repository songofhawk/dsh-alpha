import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { loginPage } from "./login-page.mjs";

const derive = promisify(scrypt);
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const header = (request, name) => request.headers instanceof Headers
  ? request.headers.get(name) : request.headers?.[name];

export async function hashPassword(password) {
  if (typeof password !== "string" || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024) {
    throw new Error("密码须为 12–1024 字节");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt}$${hash.toString("hex")}`;
}

export function validateAccount(account) {
  if (account?.version !== 1 || typeof account.username !== "string" || !account.username.trim()
    || account.username.length > 64 || /[\x00-\x1f\x7f]/.test(account.username)
    || !/^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(account.passwordHash)) {
    throw new Error("登录配置无效，请运行 dsh-alpha login-setup 重新设置");
  }
  return account;
}

export function createLoginService({ account, sessionFile, now = Date.now }) {
  validateAccount(account);
  const [, , , , salt, encoded] = account.passwordHash.split("$");
  const credentialId = digest(`${account.username}\0${account.passwordHash}`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(sessionFile);
  fs.chmodSync(sessionFile, 0o600);
  db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS login_sessions (token TEXT PRIMARY KEY, authority TEXT NOT NULL, expires INTEGER NOT NULL, credential TEXT NOT NULL)");
  db.prepare("DELETE FROM login_sessions WHERE credential != ? OR expires <= ?").run(credentialId, now());
  const attempts = new Map();
  let verifying = false;

  function cookieName(authority) { return `dsh_alpha_login_${digest(authority).slice(0, 16)}`; }
  function cookieToken(request, authority) {
    const prefix = `${cookieName(authority)}=`;
    const raw = String(header(request, "cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
    const value = raw?.slice(prefix.length);
    return /^[a-f0-9]{64}$/.test(value || "") ? value : null;
  }
  function verify(request, authority) {
    const token = cookieToken(request, authority);
    if (!token) return false;
    return !!db.prepare("SELECT 1 FROM login_sessions WHERE token = ? AND authority = ? AND credential = ? AND expires > ?")
      .get(digest(token), authority, credentialId, now());
  }
  function cookie(authority, token, secure, age = SESSION_MS / 1000) {
    return `${cookieName(authority)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
  }
  function revoke(request, authority) {
    const token = cookieToken(request, authority);
    if (token) db.prepare("DELETE FROM login_sessions WHERE token = ?").run(digest(token));
  }
  async function login(username, password, client) {
    for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
    // Global budget also bounds password hashing behind proxies and across source IPs.
    const keys = ["global", `ip:${client}`];
    if (verifying || keys.some((key) => (attempts.get(key)?.count || 0) >= (key === "global" ? 50 : 10)) || attempts.size > 2048) {
      return { status: 429 };
    }
    for (const key of keys) {
      const state = attempts.get(key) || { until: now() + WINDOW_MS, count: 0 };
      state.count += 1;
      attempts.set(key, state);
    }
    if (typeof username !== "string" || username.length > 64 || typeof password !== "string" || Buffer.byteLength(password) > 1024) return { status: 401 };
    verifying = true;
    let valid;
    try {
      const candidate = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      valid = timingSafeEqual(candidate, Buffer.from(encoded, "hex")) && username === account.username;
    } finally { verifying = false; }
    if (!valid) return { status: 401 };
    attempts.delete(`ip:${client}`);
    return { status: 200 };
  }
  function issue(authority, secure) {
    const token = randomBytes(32).toString("hex");
    db.prepare("DELETE FROM login_sessions WHERE expires <= ?").run(now());
    db.prepare("DELETE FROM login_sessions WHERE token IN (SELECT token FROM login_sessions ORDER BY expires DESC LIMIT -1 OFFSET 127)").run();
    db.prepare("INSERT INTO login_sessions VALUES (?, ?, ?, ?)").run(digest(token), authority, now() + SESSION_MS, credentialId);
    return cookie(authority, token, secure);
  }
  return { login, verify, issue, revoke, cookie, close: () => db.close(), username: account.username };
}

function send(response, status, body = "", headers = {}) {
  response.writeHead(status, { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", ...headers });
  response.end(body);
}

async function readForm(request) {
  if (String(header(request, "content-type") || "").split(";", 1)[0] !== "application/x-www-form-urlencoded") {
    throw Object.assign(new Error("unsupported form"), { status: 415 });
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) throw Object.assign(new Error("form too large"), { status: 413 });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function installAccountLogin(ctx, { dataDir, accountFile = process.env.DSH_ALPHA_LOGIN_FILE || path.join(dataDir, "login.json"), publicOrigin = process.env.DSH_ALPHA_LOGIN_ORIGIN } = {}) {
  let account;
  try { account = validateAccount(JSON.parse(fs.readFileSync(accountFile, "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  let origin;
  if (publicOrigin) {
    origin = new URL(publicOrigin);
    if (origin.origin !== publicOrigin || origin.protocol !== "https:") throw new Error("DSH_ALPHA_LOGIN_ORIGIN 必须为 HTTPS origin，不带路径或末尾斜杠");
  }
  ctx.inject(["connection", "webServer"], (connectionCtx) => {
    const { connection, webServer } = connectionCtx;
    // Hook the common browser credential verifier: both legacy requestRejection
    // and newer admit/admitConnection paths then retain DSH's Host/Origin fence.
    const auth = connection.browserAuth;
    if (typeof auth?.isAuthenticated !== "function" || typeof connection.authorizeIndex !== "function"
      || typeof connection.requestRejection !== "function") {
      throw new Error("账号登录需要支持浏览器会话鉴权的 DSH（0.2.1-rc.5 或更新版本）；请先升级 DSH");
    }
    const service = createLoginService({ account, sessionFile: path.join(dataDir, "login-sessions.sqlite3") });
    function authority(request) {
      const host = header(request, "host");
      if (!host || /[\s/@\\?#]/.test(host)) return null;
      if (origin) return host.toLowerCase() === origin.host.toLowerCase() ? origin.origin : null;
      try {
        const value = new URL(`${webServer.protocol || "http:"}//${host}`);
        const local = value.hostname === "localhost" || value.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(value.hostname);
        return value.protocol === "https:" || local ? value.origin : null;
      } catch { return null; }
    }
    const originalVerify = auth.isAuthenticated;
    const originalIndex = connection.authorizeIndex;
    const verify = function (request, ...args) {
      const target = authority(request);
      return !!target && service.verify(request, target) || originalVerify.call(this, request, ...args);
    };
    const authorizeIndex = function (request, response) {
      const rejection = connection.requestRejection(request);
      if (rejection === 403) { send(response, 403, "forbidden"); return false; }
      if (rejection === 401 && !new URL(request.url || "/", "http://local").searchParams.has("token")) {
        send(response, 303, "", { location: "/login" });
        return false;
      }
      return originalIndex.call(this, request, response);
    };
    auth.isAuthenticated = verify;
    connection.authorizeIndex = authorizeIndex;
    const disposers = [];
    // The shared verifier runs once at upgrade. Retire account-authenticated
    // sockets as soon as their cookie is revoked or expires, including other tabs.
    const sockets = new Map();
    const onUpgrade = (request, socket) => {
      const target = authority(request);
      if (target && service.verify(request, target)) {
        sockets.set(socket, { request, target });
        socket.once("close", () => sockets.delete(socket));
      }
    };
    const retireSockets = () => {
      for (const [socket, { request, target }] of sockets) if (!service.verify(request, target)) { socket.destroy(); sockets.delete(socket); }
    };
    webServer.server?.prependListener("upgrade", onUpgrade);
    const timer = setInterval(retireSockets, 30_000);
    timer.unref();
    const handler = async (request, response) => {
      try {
        const rejection = connection.requestRejection(request);
        const target = authority(request);
        if (!target || rejection === 403) return send(response, 403, "forbidden");
        const url = new URL(request.url, target);
        const secure = target.startsWith("https:");
        const render = (status = 200, error = "") => send(response, status, loginPage({ error }), {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
        });
        if (request.method === "GET" && url.pathname === "/login") {
          return service.verify(request, target) ? send(response, 303, "", { location: "/" }) : render();
        }
        if (request.method !== "POST") return send(response, 405, "method not allowed", { allow: url.pathname === "/login" ? "GET, POST" : "POST" });
        // Require the browser's exact Origin for login and logout; forwarded
        // headers never select the authority or weaken this CSRF check.
        if (header(request, "origin") !== target || header(request, "sec-fetch-site") === "cross-site") return send(response, 403, "forbidden");
        if (url.pathname === "/logout") {
          service.revoke(request, target);
          retireSockets();
          return send(response, 303, "", { location: "/login", "set-cookie": service.cookie(target, "", secure, 0) });
        }
        const form = await readForm(request);
        const result = await service.login(form.get("username"), form.get("password"), request.socket?.remoteAddress || "unknown");
        if (result.status === 429) {
          response.setHeader("retry-after", "900");
          return render(429, "尝试次数过多，请稍后再试。");
        }
        if (result.status !== 200) return render(401, "用户名或密码不正确。");
        service.revoke(request, target);
        return send(response, 303, "", { location: "/", "set-cookie": service.issue(target, secure) });
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-alpha] 登录请求失败（${error.status || 500}）`);
        if (!response.headersSent) send(response, error.status || 500, "登录请求失败，请重试。");
      }
    };
    for (const route of ["/login", "/logout"]) disposers.push(webServer.register({ kind: "exact", path: route, handler }));
    ctx.on("webserver/index-inject", (table) => table.push({ kind: "global", name: "__DSH_ALPHA_LOGIN__", value: true }));
    connectionCtx.effect(function* () {
      yield () => {
        for (const dispose of disposers) dispose();
        clearInterval(timer);
        webServer.server?.removeListener("upgrade", onUpgrade);
        for (const socket of sockets.keys()) socket.destroy();
        if (auth.isAuthenticated === verify) auth.isAuthenticated = originalVerify;
        if (connection.authorizeIndex === authorizeIndex) connection.authorizeIndex = originalIndex;
        service.close();
      };
    }, "dsh-alpha:account-login");
  });
}
