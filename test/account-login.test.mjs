import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { createLoginService, hashPassword, installAccountLogin, validateAccount } from "../src/lib/account-login.mjs";

const password = "correct horse battery staple";
const account = { version: 1, username: "admin", passwordHash: await hashPassword(password) };
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-login-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function service(t, options = {}) {
  const sessionFile = path.join(temporary(t), "sessions.sqlite3");
  const instance = createLoginService({ account, sessionFile, ...options });
  t.after(() => instance.close());
  return instance;
}
function fixture(t) {
  const dataDir = temporary(t);
  fs.writeFileSync(path.join(dataDir, "login.json"), JSON.stringify(account));
  const routes = new Map();
  const cleanup = [];
  const server = new EventEmitter();
  const auth = { isAuthenticated: (request) => request.headers["x-launch-auth"] === "yes" };
  const originalVerify = auth.isAuthenticated;
  const connection = {
    browserAuth: auth,
    requestRejection(request) {
      if (request.headers.host !== "alpha.example" || request.headers.origin && request.headers.origin !== "https://alpha.example") return 403;
      if (request.headers["sec-fetch-site"] === "cross-site") return 403;
      return auth.isAuthenticated(request) ? undefined : 401;
    },
    // The API and socket handlers in newer DSH call admit rather than requestRejection.
    admit(request) {
      const rejection = this.requestRejection(request);
      return rejection ? { rejection } : { peer: { principal: { kind: "owner" } } };
    },
    admitConnection(request) { return this.admit(request); },
    authorizeIndex(request, response) {
      if (auth.isAuthenticated(request)) return true;
      response.writeHead(401); response.end("unauthorized"); return false;
    }
  };
  const ctx = {
    inject(_names, callback) { callback({
      connection,
      webServer: { server, protocol: "http:", register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
      effect(execute) { cleanup.push(execute().next().value); }
    }); },
    on() {}, logger: { warn() {} }
  };
  installAccountLogin(ctx, { dataDir, publicOrigin: "https://alpha.example" });
  t.after(() => { for (const dispose of cleanup) dispose(); assert.equal(auth.isAuthenticated, originalVerify); });
  const request = (cookie, extra = {}) => ({ method: "GET", url: "/", headers: { host: "alpha.example", ...(cookie ? { cookie } : {}), ...extra } });
  async function call(route, { method = "GET", body = "", headers = {} } = {}) {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { method, url: route, headers: { host: "alpha.example", origin: "https://alpha.example", "content-type": "application/x-www-form-urlencoded", ...headers }, socket: { remoteAddress: "127.0.0.1" } });
    const res = {
      headers: {}, setHeader(key, value) { this.headers[key] = value; },
      writeHead(status, values = {}) { this.status = status; Object.assign(this.headers, values); this.headersSent = true; },
      end(value = "") { this.body = value; }
    };
    await routes.get(route)(req, res);
    return res;
  }
  return { call, connection, request, server, routes };
}

test("password hashes are salted, validated, and never stored as plaintext", async () => {
  assert.notEqual(account.passwordHash, await hashPassword(password));
  assert.ok(!account.passwordHash.includes(password));
  await assert.rejects(hashPassword("short"), /12/);
  assert.throws(() => validateAccount({ ...account, passwordHash: "scrypt$1$1$1$bad$bad" }), /配置无效/);
});

test("wrong usernames and passwords receive the same error; repeated attempts are throttled", async (t) => {
  let time = Date.now();
  const login = service(t, { now: () => time });
  assert.equal((await login.login("unknown", password, "one")).status, 401);
  assert.equal((await login.login("admin", "wrong", "one")).status, 401);
  for (let i = 0; i < 8; i++) await login.login("admin", "wrong", "one");
  assert.equal((await login.login("admin", password, "one")).status, 429);
  time += 15 * 60 * 1000 + 1;
  assert.equal((await login.login("admin", password, "one")).status, 200);
});

test("cookies are origin-bound, persistent, expiring, and revoked on logout", (t) => {
  let time = Date.now();
  const sessionFile = path.join(temporary(t), "sessions.sqlite3");
  let login = createLoginService({ account, sessionFile, now: () => time });
  const fullCookie = login.issue("https://alpha.example", true);
  assert.match(fullCookie, /HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
  assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
  const cookie = fullCookie.split(";", 1)[0];
  const request = { headers: { cookie } };
  assert.equal(login.verify(request, "https://alpha.example"), true);
  assert.equal(login.verify(request, "https://elsewhere.example"), false);
  assert.equal(login.verify({ headers: { cookie: `${cookie}00` } }, "https://alpha.example"), false);
  login.close();
  login = createLoginService({ account, sessionFile, now: () => time });
  t.after(() => login.close());
  assert.equal(login.verify(request, "https://alpha.example"), true);
  login.revoke(request, "https://alpha.example");
  assert.equal(login.verify(request, "https://alpha.example"), false);
  const second = { headers: { cookie: login.issue("https://alpha.example", true).split(";", 1)[0] } };
  time += 7 * 24 * 60 * 60 * 1000 + 1;
  assert.equal(login.verify(second, "https://alpha.example"), false);
});

test("changing account credentials invalidates previous sessions", async (t) => {
  const sessionFile = path.join(temporary(t), "sessions.sqlite3");
  let login = createLoginService({ account, sessionFile });
  const cookie = login.issue("https://alpha.example", true).split(";", 1)[0];
  login.close();
  login = createLoginService({ account: { ...account, passwordHash: await hashPassword("a different secure password") }, sessionFile });
  t.after(() => login.close());
  assert.equal(login.verify({ headers: { cookie } }, "https://alpha.example"), false);
});

test("login protects index, API and socket admission while retaining Host/Origin checks", async (t) => {
  const { call, connection, request } = fixture(t);
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end() {} };
  assert.equal(connection.authorizeIndex(request(), res), false);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, "/login");
  assert.equal(connection.requestRejection(request()), 401);
  const page = await call("/login");
  assert.equal(page.status, 200);
  assert.equal(page.headers["referrer-policy"], "same-origin");
  assert.match(page.body, /autocomplete="current-password"/);
  assert.doesNotMatch(page.body, /注册|cloudflare/i);
  assert.equal((await call("/login", { method: "POST", body: "username=admin&password=wrong" })).status, 401);
  const loggedIn = await call("/login", { method: "POST", body: new URLSearchParams({ username: "admin", password }).toString() });
  assert.equal(loggedIn.status, 303);
  assert.equal(loggedIn.headers.location, "/");
  const cookie = loggedIn.headers["set-cookie"].split(";", 1)[0];
  assert.equal(connection.requestRejection(request(cookie)), undefined);
  assert.ok(connection.admit(request(cookie)).peer);
  assert.ok(connection.admitConnection(request(cookie)).peer);
  assert.equal(connection.authorizeIndex(request(cookie), {}), true);
  assert.equal(connection.requestRejection(request(cookie, { host: "attacker.example" })), 403);
  assert.equal(connection.requestRejection(request(cookie, { origin: "https://attacker.example" })), 403);
  assert.equal((await call("/login", { headers: { cookie } })).headers.location, "/");
  assert.equal(connection.requestRejection(request(null, { "x-launch-auth": "yes" })), undefined);
  assert.equal(connection.requestRejection(request(null, { "cf-access-jwt-assertion": "anything" })), 401);
});

test("logout revokes the cookie and closes account sockets; CSRF and unsafe forms are rejected", async (t) => {
  const { call, connection, request, server } = fixture(t);
  const body = new URLSearchParams({ username: "admin", password }).toString();
  assert.equal((await call("/login", { method: "POST", body, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/login", { method: "POST", body, headers: { origin: "" } })).status, 403);
  assert.equal((await call("/login", { method: "POST", body, headers: { origin: "null" } })).status, 403);
  assert.equal((await call("/login", { method: "POST", body, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await call("/login", { method: "POST", body: "a".repeat(8193) })).status, 413);
  assert.equal((await call("/logout")).status, 405);
  const response = await call("/login", { method: "POST", body });
  const cookie = response.headers["set-cookie"].split(";", 1)[0];
  const socket = new EventEmitter();
  socket.destroy = () => { socket.destroyed = true; socket.emit("close"); };
  server.emit("upgrade", request(cookie), socket);
  assert.equal((await call("/logout", { method: "POST", headers: { cookie, origin: "https://evil.example" } })).status, 403);
  assert.equal(connection.requestRejection(request(cookie)), undefined);
  const logout = await call("/logout", { method: "POST", headers: { cookie } });
  assert.equal(logout.status, 303);
  assert.match(logout.headers["set-cookie"], /Max-Age=0/);
  assert.equal(socket.destroyed, true);
  assert.equal(connection.requestRejection(request(cookie)), 401);
});

test("external links can open the login document without relaxing API or POST trust", async (t) => {
  const { call, connection, request } = fixture(t);
  const navigation = {
    "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
    "sec-fetch-user": "?1", referer: "https://chatgpt.com/"
  };
  assert.equal((await call("/login", { headers: { ...navigation, origin: "" } })).status, 200);
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end() {} };
  assert.equal(connection.authorizeIndex(request(null, navigation), response), false);
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, "/login");
  assert.equal(connection.requestRejection(request(null, navigation)), 403);
  assert.equal((await call("/login", { headers: { ...navigation, host: "evil.example" } })).status, 403);
  assert.equal((await call("/login", { headers: { ...navigation, origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/login", { headers: { ...navigation, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } })).status, 403);
  assert.equal((await call("/login", { method: "POST", headers: navigation, body: "username=admin&password=wrong" })).status, 403);
});

test("missing config retains DSH authentication; invalid config and unsupported hosts fail explicitly", (t) => {
  const dataDir = temporary(t);
  installAccountLogin({ inject() { assert.fail("no login account configured"); } }, { dataDir });
  fs.writeFileSync(path.join(dataDir, "login.json"), "{}");
  assert.throws(() => installAccountLogin({}, { dataDir }), /配置无效/);
  fs.writeFileSync(path.join(dataDir, "login.json"), JSON.stringify(account));
  assert.throws(() => installAccountLogin({ inject(_names, callback) { callback({ connection: {}, webServer: {} }); } }, { dataDir }), /先升级 DSH/);
});
