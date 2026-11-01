// Jev（TypeSafe systemone）客户端：路由和归属共用一次有界的 Decision 请求。
// 失败、超时一律返回 null，由调用方降级；只有外层 signal 中止时才抛错。

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MIN_CONFIDENCE = 0.6;
export const MIN_PROBABILITY = 0.7;

function safeEndpoint(raw) {
  const url = new URL(raw);
  if (url.protocol === "https:") return url.href;
  throw new Error("Jev endpoint 必须使用 HTTPS");
}

export function acceptedChoice(answer, options, { preference = false, minConfidence = MIN_CONFIDENCE, minProbability = MIN_PROBABILITY } = {}) {
  return answer?.type === "choice" && Object.hasOwn(options, answer.choice)
    && Number.isFinite(answer.confidence) && (preference || answer.confidence >= minConfidence)
    && Number.isFinite(answer.probabilities?.[answer.choice])
    && answer.probabilities[answer.choice] > 0
    && (preference || answer.probabilities[answer.choice] >= minProbability);
}

export function createJevClient({ fetchImpl = globalThis.fetch,
  apiKey = process.env.TYPESAFE_API_KEY,
  endpoint = process.env.DSH_ALPHA_JEV_ENDPOINT || DEFAULT_ENDPOINT,
  timeoutMs = 3000 } = {}) {
  if (!apiKey) return null;
  const url = safeEndpoint(endpoint);
  return {
    async ask({ state, questions, signal }) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({ model: "jev-latest", state, questions }),
          signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeoutMs)])
        });
        if (!response.ok) {
          console.info(`[alpha-jev] fallback: HTTP ${response.status}`);
          return null;
        }
        return (await response.json()).answers || {};
      } catch (error) {
        if (signal?.aborted) throw error;
        console.info(`[alpha-jev] fallback: ${error?.name || "request failed"}`);
        return null;
      }
    }
  };
}
