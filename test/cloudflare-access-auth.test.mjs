import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { createCloudflareAccessVerifier, installCloudflareAccessAuth } from "../src/lib/cloudflare-access-auth.mjs";

const issuer = "https://example.cloudflareaccess.com";
const audience = "dsh-alpha-app";
const now = 1_780_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256" };

function token(overrides = {}, key = privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: [audience], exp: now / 1000 + 300, iat: now / 1000, ...overrides
  })).toString("base64url");
  const body = `${header}.${payload}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
}

function fetchCertificates() {
  return Promise.resolve({ ok: true, json: async () => ({ keys: [jwk] }) });
}

test("仅接受签名、签发者、受众与有效期都正确的 Access JWT", async () => {
  const verifier = createCloudflareAccessVerifier({ issuer, audience, fetchImpl: fetchCertificates, now: () => now });
  await verifier.refresh();
  const request = (value) => ({ headers: { "cf-access-jwt-assertion": value } });
  assert.equal(verifier.verify(request(token())), true);
  assert.equal(verifier.verify(request(token({ aud: ["other-app"] }))), false);
  assert.equal(verifier.verify(request(token({ iss: "https://other.cloudflareaccess.com" }))), false);
  assert.equal(verifier.verify(request(token({ exp: now / 1000 - 1 }))), false);
  assert.equal(verifier.verify(request(token({ nbf: now / 1000 + 100 }))), false);
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.equal(verifier.verify(request(token({}, otherKey))), false);
  assert.equal(verifier.verify(request(null)), false);
});

test("Access JWT 只替代原认证的 401，不绕过 Host/Origin 拒绝", async () => {
  const connection = {
    requestRejection(request) { return request.headers.host === "dsh-alpha.showme.talk" ? 401 : 403; },
    authorizeIndex(_request, response) { response.status = 401; return false; }
  };
  const effects = [];
  const ctx = {
    inject(_names, callback) { callback({ connection, effect: (_fn, name) => effects.push(name) }); },
    effect(_fn, name) { effects.push(name); },
    logger: { warn() {} }
  };
  const verifier = installCloudflareAccessAuth(ctx, { issuer, audience, fetchImpl: fetchCertificates, now: () => now });
  await verifier.refresh();
  const headers = { host: "dsh-alpha.showme.talk", "cf-access-jwt-assertion": token() };
  assert.equal(connection.requestRejection({ headers }), undefined);
  assert.equal(connection.authorizeIndex({ headers }, {}), true);
  assert.equal(connection.requestRejection({ headers: { ...headers, host: "attacker.test" } }), 403);
  assert.equal(connection.authorizeIndex({ headers: { ...headers, host: "attacker.test" } }, {}), false);
  assert.equal(connection.requestRejection({ headers: { host: "dsh-alpha.showme.talk" } }), 401);
  assert.deepEqual(effects, ["dsh-alpha:cloudflare-access-keys", "dsh-alpha:cloudflare-access-auth"]);
});
