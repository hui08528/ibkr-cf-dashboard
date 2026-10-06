// OKX（欧易）V5 账户 adapter —— 把现货/赚币持仓归一为统一持仓结构
//
// 接入范围（2026-10）：现货（统一交易账户）+ 资金账户 + 简单赚币；不接合约/期权。
// 鉴权：HMAC-SHA256 签名（OK-ACCESS-* 四头），只读 Key + IP 白名单。
// 归桶：稳定币 → cash（现金等价）；其余币种 → crypto（加密资产）。
//
// 各账户端点独立 try/catch：某个产品没用或字段变化不拖垮整体。
// 无原生美元值的余额（资金账户/赚币）：稳定币按面值，其余走公开 ticker 估 USDT。

import crypto from "node:crypto";

const STABLES = new Set(["USDT", "USDC", "USDG", "DAI", "USDP", "TUSD", "FDUSD", "BUSD", "USDE", "PYUSD"]);
const CACHE_TTL_MS = 120 * 1000;
const DUST_USD = 1;

let cachedAccount = null;
let cachedAt = 0;
const tickerCache = new Map(); // ccy -> { price, expiresAt }

function envOf(env, key) {
  const value = env[key];
  return value === undefined ? "" : String(value).trim();
}

export function isOkxConfigured(env = {}) {
  return Boolean(envOf(env, "OKX_API_KEY") && envOf(env, "OKX_API_SECRET") && envOf(env, "OKX_API_PASSPHRASE"));
}

function baseUrl(env) {
  return envOf(env, "OKX_BASE_URL") || "https://www.okx.com";
}

// —— 签名请求 ——
async function signedRequest(env, method, requestPath) {
  const timestamp = new Date().toISOString();
  const prehash = `${timestamp}${method}${requestPath}`;
  const sign = crypto
    .createHmac("sha256", envOf(env, "OKX_API_SECRET"))
    .update(prehash)
    .digest("base64");

  const response = await fetch(`${baseUrl(env)}${requestPath}`, {
    headers: {
      "OK-ACCESS-KEY": envOf(env, "OKX_API_KEY"),
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": envOf(env, "OKX_API_PASSPHRASE"),
      "Content-Type": "application/json",
    },
  });
  const body = await response.json();
  if (body.code !== "0") throw new Error(`OKX ${requestPath} code=${body.code} msg=${body.msg || ""}`);
  return body.data || [];
}

// 公开 ticker：CCY-USDT 最新价，10 分钟缓存
async function getUsdtPrice(ccy) {
  const now = Date.now();
  const hit = tickerCache.get(ccy);
  if (hit && hit.expiresAt > now) return hit.price;

  // USDT 自身≈1 美元，不发请求
  if (ccy === "USDT") return 1;
  try {
    const response = await fetch(`${baseUrl({})}/api/v5/market/ticker?instId=${ccy}-USDT`);
    const body = await response.json();
    const price = Number(body?.data?.[0]?.last);
    const result = Number.isFinite(price) && price > 0 ? price : null;
    tickerCache.set(ccy, { price: result, expiresAt: now + 10 * 60 * 1000 });
    return result;
  } catch {
    tickerCache.set(ccy, { price: null, expiresAt: now + 60 * 1000 });
    return null;
  }
}

// 数量 + 币种 → 美元估值；返回 null 表示估不出来
async function toUsd(ccy, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (STABLES.has(ccy)) return amount; // 稳定币按 1:1
  const price = await getUsdtPrice(ccy);
  return price === null ? null : amount * price;
}

export async function fetchOkxAccount(env = {}) {
  if (!isOkxConfigured(env)) return null;
  if (cachedAccount && Date.now() - cachedAt < CACHE_TTL_MS) return cachedAccount;

  // ccy -> { usd, qty, accounts:Set }，各账户统一折算成美元后并入
  const usdByCoin = new Map();
  const addUsd = (ccy, qty, usd, account) => {
    if (!ccy || usd <= 0) return;
    const row = usdByCoin.get(ccy) || { usd: 0, qty: 0, accounts: new Set() };
    row.usd += usd;
    row.qty += qty;
    row.accounts.add(account);
    usdByCoin.set(ccy, row);
  };

  try {
    const data = await signedRequest(env, "GET", "/api/v5/account/balance");
    for (const detail of data[0]?.details || []) {
      const ccy = String(detail.ccy || "");
      const qty = Number(detail.eq);
      let usd = Number(detail.eqUsd);
      if (!Number.isFinite(usd) || usd <= 0) usd = (await toUsd(ccy, qty)) || 0;
      addUsd(ccy, qty, usd, "交易");
    }
  } catch (error) {
    console.warn(`[okx] 交易账户获取失败: ${error.message}`);
  }

  // 2) 资金账户（无美元字段，自行估值）
  try {
    const data = await signedRequest(env, "GET", "/api/v5/asset/balances");
    for (const row of data || []) {
      const ccy = String(row.ccy || "");
      const qty = Number(row.bal);
      const usd = (await toUsd(ccy, qty)) || 0;
      addUsd(ccy, qty, usd, "资金");
    }
  } catch (error) {
    console.warn(`[okx] 资金账户获取失败: ${error.message}`);
  }

  // 3) 简单赚币（活期）：字段随产品形态可能不同，防御性读取
  try {
    const data = await signedRequest(env, "GET", "/api/v5/finance/simple-earn/balances");
    for (const row of data || []) {
      const ccy = String(row.ccy || row.investCcy || "");
      const qty = Number(row.amt ?? row.latestAmt ?? row.bal ?? row.investAmt);
      let usd = Number(row.eqUsd);
      if (!Number.isFinite(usd) || usd <= 0) usd = (await toUsd(ccy, qty)) || 0;
      addUsd(ccy, qty, usd, "赚币");
    }
  } catch (error) {
    console.warn(`[okx] 简单赚币获取失败: ${error.message}`);
  }

  if (usdByCoin.size === 0) return null;

  const minUsd = Number(env.OKX_CRYPTO_MIN_USD) || DUST_USD;
  const holdings = [];
  let nav = 0;
  for (const [ccy, row] of usdByCoin) {
    if (row.usd < minUsd) continue;
    const isStable = STABLES.has(ccy);
    holdings.push({
      symbol: ccy,
      name: ccy,
      type: isStable ? "cash" : "crypto",
      qty: row.qty,
      price: row.qty ? row.usd / row.qty : 0,
      marketValue: Math.round(row.usd * 100) / 100,
      unrealizedPnl: 0,
      bucket: isStable ? "cash" : "crypto",
      currency: "USD",
      accounts: [...row.accounts],
      source: "okx",
    });
    nav += row.usd;
  }

  if (holdings.length === 0) return null;
  cachedAccount = {
    source: "okx",
    nav: Math.round(nav * 100) / 100,
    holdings,
    updatedAt: new Date().toISOString(),
  };
  cachedAt = Date.now();
  return cachedAccount;
}
