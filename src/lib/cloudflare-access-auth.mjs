import { createPublicKey, verify as verifySignature } from "node:crypto";

const REFRESH_MS = 5 * 60 * 1000;
const MAX_KEY_AGE_MS = 60 * 60 * 1000;

function accessHeader(headers) {
  if (headers instanceof Headers) return headers.get("cf-access-jwt-assertion");
  const value = headers?.["cf-access-jwt-assertion"];
  return typeof value === "string" ? value : null;
}

export function createCloudflareAccessVerifier({ issuer, audience, fetchImpl = fetch, now = Date.now }) {
  const origin = new URL(issuer);
  if (origin.protocol !== "https:" || !origin.hostname.endsWith(".cloudflareaccess.com")
    || origin.pathname !== "/" || origin.search || origin.hash || origin.origin !== issuer
    || !audience) {
    throw new Error("Cloudflare Access issuer 或 audience 配置无效");
  }
  let keys = new Map();
  let fetchedAt = 0;
  let refreshing = null;

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error(`Cloudflare Access certificates HTTP ${response.status}`);
      const jwks = await response.json();
      if (!Array.isArray(jwks?.keys)) throw new Error("Cloudflare Access certificates 格式无效");
      const next = new Map();
      for (const jwk of jwks.keys) {
        if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.kid) continue;
        next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      }
      if (!next.size) throw new Error("Cloudflare Access certificates 不含 RSA 公钥");
      keys = next;
      fetchedAt = now();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  function verify(request) {
    const token = accessHeader(request?.headers);
    if (!token || token.length > 32768 || now() - fetchedAt > MAX_KEY_AGE_MS) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    try {
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
      const key = keys.get(header.kid);
      if (!key) {
        void refresh().catch(() => {});
        return false;
      }
      if (!verifySignature("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key,
        Buffer.from(parts[2], "base64url"))) return false;
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      const seconds = now() / 1000;
      const audienceMatches = claims.aud === audience || Array.isArray(claims.aud) && claims.aud.includes(audience);
      return claims.iss === issuer && audienceMatches
        && Number.isFinite(claims.exp) && claims.exp > seconds
        && (claims.nbf === undefined || Number.isFinite(claims.nbf) && claims.nbf <= seconds)
        && (claims.iat === undefined || Number.isFinite(claims.iat) && claims.iat <= seconds + 60);
    } catch {
      return false;
    }
  }

  return { refresh, verify };
}

export function installCloudflareAccessAuth(ctx, { issuer, audience, fetchImpl, now } = {}) {
  if (!issuer && !audience) return;
  const verifier = createCloudflareAccessVerifier({ issuer, audience, fetchImpl, now });
  const logError = (error) => ctx.logger?.warn?.(`[dsh-alpha] Cloudflare Access 公钥刷新失败：${error.message}`);
  void verifier.refresh().catch(logError);
  const timer = setInterval(() => { void verifier.refresh().catch(logError); }, REFRESH_MS);
  timer.unref?.();
  ctx.effect(function* () { yield () => clearInterval(timer); }, "dsh-alpha:cloudflare-access-keys");

  ctx.inject(["connection"], (connectionCtx) => {
    const connection = connectionCtx.connection;
    if (typeof connection?.requestRejection !== "function" || typeof connection?.authorizeIndex !== "function") {
      ctx.logger?.warn?.("[dsh-alpha] 当前 DSH Connection 不支持 Access 接入，保留原有认证");
      return;
    }
    const originalRejection = connection.requestRejection;
    const originalAuthorizeIndex = connection.authorizeIndex;
    const requestRejection = function (request) {
      const rejection = originalRejection.call(this, request);
      return rejection === 401 && verifier.verify(request) ? undefined : rejection;
    };
    const authorizeIndex = function (request, response) {
      if (originalRejection.call(this, request) === 401 && verifier.verify(request)) return true;
      return originalAuthorizeIndex.call(this, request, response);
    };
    connection.requestRejection = requestRejection;
    connection.authorizeIndex = authorizeIndex;
    connectionCtx.effect(function* () {
      yield () => {
        if (connection.requestRejection === requestRejection) connection.requestRejection = originalRejection;
        if (connection.authorizeIndex === authorizeIndex) connection.authorizeIndex = originalAuthorizeIndex;
      };
    }, "dsh-alpha:cloudflare-access-auth");
  });
  return verifier;
}
