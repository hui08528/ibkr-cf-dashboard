// 外盘期货 —— 经国内云函数中转新浪 hf_ 行情（东京 VPS 直连新浪 403）
//
// 云函数端点：GET {origin}/futures?codes=NQ,ES，带 x-api-token
// （与 CN_PREMIUM_API_URL 同一服务，复用 PREMIUM_TOKEN；可用 CN_FUTURES_API_URL 单独覆盖）
// 内存缓存 60s；失败一律返回 null，调用方优雅降级（日报缺期货段不影响主体）。

const FUTURES_CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, data: null };

function futuresEndpoint(env) {
  const explicit = String(env.CN_FUTURES_API_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const premium = String(env.CN_PREMIUM_API_URL || "").trim();
  if (!premium) return "";
  // .../qdii-premium → .../futures
  return premium.replace(/\/qdii-premium\/?$/, "/futures");
}

// 返回 { NQ: {price, changePct, ...}, ES: {...} }，不可用时返回 null
export async function fetchFutures(env = process.env, codes = ["NQ", "ES"]) {
  const urlBase = futuresEndpoint(env);
  if (!urlBase) return null;

  const key = [...codes].sort().join(",");
  if (cache.data && Date.now() - cache.at < FUTURES_CACHE_TTL_MS && cache.key === key) {
    return cache.data;
  }

  try {
    const url = `${urlBase}?codes=${encodeURIComponent(codes.join(","))}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json", "x-api-token": env.CN_PREMIUM_API_TOKEN || "" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const futures = body?.futures;
    if (!futures || typeof futures !== "object") return null;
    cache = { at: Date.now(), data: futures, key };
    return futures;
  } catch {
    return null;
  }
}
