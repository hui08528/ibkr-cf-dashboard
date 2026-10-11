// 场内 QDII · A 股溢价率。
// 生产环境优先从国内云函数读取腾讯/新浪数据，避免东京 VPS 直连国内行情源。
// 未配置 CN_PREMIUM_API_URL 时，才使用本地/开发环境的腾讯 + 新浪直连兜底。

const GBK = new TextDecoder("gbk");
const navCache = new Map();
const NAV_CACHE_TTL_MS = 3600 * 1000;
const runtimeEnv = globalThis.process?.env || {};

const REMOTE_PREMIUM_URL = String(runtimeEnv.CN_PREMIUM_API_URL || "").trim();
const REMOTE_PREMIUM_TOKEN = String(runtimeEnv.CN_PREMIUM_API_TOKEN || "").trim();

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function emptyInfo() {
  return { premiumRate: null, iopv: null, nav: null, scale: null, navDate: "" };
}

async function fetchRemoteInfo(code) {
  if (!REMOTE_PREMIUM_URL || !REMOTE_PREMIUM_TOKEN) {
    throw new Error("CN premium remote source is not configured");
  }

  const url = new URL(REMOTE_PREMIUM_URL);
  url.searchParams.set("codes", code);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "x-api-token": REMOTE_PREMIUM_TOKEN,
    },
  });

  if (!response.ok) throw new Error(`remote premium HTTP ${response.status}`);

  const body = await response.json();
  const row = body?.[code];
  if (!row || typeof row !== "object") throw new Error(`remote premium missing ${code}`);

  return {
    premiumRate: numOrNull(row.premiumRate),
    iopv: numOrNull(row.iopv),
    nav: numOrNull(row.nav),
    scale: numOrNull(row.scale),
    navDate: row.navDate || "",
  };
}

let proxyDispatcherPromise;
function getProxyDispatcher() {
  if (!proxyDispatcherPromise) {
    proxyDispatcherPromise = (async () => {
      const proxyUrl = runtimeEnv.CN_HTTP_PROXY;
      if (!proxyUrl) return null;
      try {
        const { ProxyAgent } = await import("undici");
        return new ProxyAgent(proxyUrl);
      } catch {
        return null;
      }
    })();
  }
  return proxyDispatcherPromise;
}

async function fetchTencentInfo(code) {
  const market = /^[569]/.test(code) ? "sh" : "sz";
  const init = { headers: { "User-Agent": "Mozilla/5.0" } };
  const dispatcher = await getProxyDispatcher();
  if (dispatcher) init.dispatcher = dispatcher;

  const response = await fetch(`https://qt.gtimg.cn/q=${market}${code}`, init);
  if (!response.ok) throw new Error(`tencent HTTP ${response.status}`);

  const text = GBK.decode(new Uint8Array(await response.arrayBuffer()));
  const match = text.match(/"([^\"]*)"/);
  if (!match) throw new Error("tencent empty response");

  const fields = match[1].split("~");
  return {
    iopv: numOrNull(fields[78]),
    nav: numOrNull(fields[81]),
    premiumRate: numOrNull(fields[77]),
    scale: numOrNull(fields[44]),
    navDate: "",
  };
}

async function fetchSinaInfo(code) {
  const init = {
    headers: {
      Referer: "https://finance.sina.com.cn/",
      "User-Agent": "Mozilla/5.0",
    },
  };
  const dispatcher = await getProxyDispatcher();
  if (dispatcher) init.dispatcher = dispatcher;

  const response = await fetch(`https://hq.sinajs.cn/list=f_${code}`, init);
  if (!response.ok) throw new Error(`sina HTTP ${response.status}`);

  const text = GBK.decode(new Uint8Array(await response.arrayBuffer()));
  const match = text.match(/"([^\"]*)"/);
  if (!match) throw new Error("sina empty response");

  const fields = match[1].split(",");
  return {
    iopv: null,
    nav: numOrNull(fields[1]),
    premiumRate: null,
    scale: null,
    navDate: fields[4] || "",
  };
}

async function fetchDirectInfo(code) {
  const [tencent, sina] = await Promise.all([
    fetchTencentInfo(code).catch(() => null),
    fetchSinaInfo(code).catch(() => null),
  ]);

  if (tencent) return { ...tencent, navDate: sina?.navDate || tencent.navDate };
  if (sina) return sina;
  return null;
}

export async function fetchQdiiPremium(code, price) {
  if (!price || price <= 0) return emptyInfo();

  let info = navCache.get(code);
  if (!info || info.expiresAt <= Date.now()) {
    // 配置云函数后，生产环境只走云函数，不再从东京 VPS 直连腾讯/新浪。
    info = REMOTE_PREMIUM_URL
      ? await fetchRemoteInfo(code).catch(() => null)
      : await fetchDirectInfo(code);

    if (info) {
      navCache.set(code, { ...info, expiresAt: Date.now() + NAV_CACHE_TTL_MS });
    }
  }

  if (!info) return emptyInfo();

  let premiumRate = info.premiumRate;
  if (premiumRate === null) {
    const base = info.iopv || info.nav;
    premiumRate = base ? Math.round(((price - base) / base) * 10000) / 100 : null;
  }

  return {
    premiumRate,
    iopv: info.iopv,
    nav: info.nav,
    scale: info.scale ?? null,
    navDate: info.navDate || "",
  };
}
