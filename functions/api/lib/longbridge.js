// Longbridge（长桥）OpenAPI 行情模块 —— /api/market 的主行情源
//
// 凭证（OAuth 2.0 优先）：
//   LONGBRIDGE_OAUTH_CLIENT_ID + ~/.longbridge/openapi/tokens/<client_id> 缓存
//   首次授权：python scripts/generate_longbridge_oauth_token.py --client-id <id>
//   Docker/CI 无头环境：token 缓存 base64 后填 LONGBRIDGE_OAUTH_TOKEN_CACHE_B64
// 兼容 Legacy 三件套：LONGBRIDGE_APP_KEY / LONGBRIDGE_APP_SECRET / LONGBRIDGE_ACCESS_TOKEN
//
// 国内必须 LONGBRIDGE_REGION=cn：显式设置 *.longbridge.cn 接入点（国际站被墙）
// token 缺失/失效时拒绝交互授权，返回不可用 → 调用方回退 Alpha Vantage
//
// 注意：Node SDK（longbridge npm 包）是 NAPI-RS 原生绑定，构造方式是静态
//   QuoteContext.new(config)，不是 new QuoteContext(config)。

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const CONNECTION_ERRORS = ["client is closed", "context closed", "connection closed"];

const REGION_URLS = {
  cn: {
    LONGBRIDGE_HTTP_URL: "https://openapi.longbridge.cn",
    LONGBRIDGE_QUOTE_WS_URL: "wss://openapi-quote.longbridge.cn/v2",
    LONGBRIDGE_TRADE_WS_URL: "wss://openapi-trade.longbridge.cn/v2",
  },
  hk: {
    LONGBRIDGE_HTTP_URL: "https://openapi.longbridge.com",
    LONGBRIDGE_QUOTE_WS_URL: "wss://openapi-quote.longbridge.com/v2",
    LONGBRIDGE_TRADE_WS_URL: "wss://openapi-trade.longbridge.com/v2",
  },
};

let _lb = null; // longbridge 原生模块（懒加载，避免未安装时拖垮市场接口）
let _lbLoadError = null;
let _ctx = null; // QuoteContext 单例（懒初始化）
let _cooldownUntil = 0;

function env(key) {
  const v = process.env[key];
  return v === undefined ? "" : String(v).trim();
}

function getLb() {
  if (_lb !== null || _lbLoadError) return _lb;
  try {
    _lb = require("longbridge");
  } catch (e) {
    _lbLoadError = e;
    console.warn(`[longbridge] SDK 未安装或加载失败: ${e.message}`);
  }
  return _lb;
}

export function isLongbridgeConfigured() {
  return Boolean(
    env("LONGBRIDGE_OAUTH_CLIENT_ID") ||
      (env("LONGBRIDGE_APP_KEY") && env("LONGBRIDGE_APP_SECRET") && env("LONGBRIDGE_ACCESS_TOKEN"))
  );
}

function tokenCachePath(clientId) {
  return path.join(os.homedir(), ".longbridge", "openapi", "tokens", clientId);
}

// 从 LONGBRIDGE_OAUTH_TOKEN_CACHE_B64 恢复 token 缓存（Docker/CI 无头环境）
function restoreTokenCache(clientId) {
  const raw = env("LONGBRIDGE_OAUTH_TOKEN_CACHE_B64");
  if (!raw) return false;
  let payload;
  try {
    payload = Buffer.from(raw.replace(/\s+/g, ""), "base64");
  } catch {
    return false;
  }
  if (!payload.length) return false;
  const file = tokenCachePath(clientId);
  try {
    if (fs.existsSync(file) && fs.readFileSync(file).equals(payload)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// 校验 token 缓存文件存在且是合法 JSON（避免无头环境误触发交互授权）
function isValidTokenCache(clientId) {
  const file = tokenCachePath(clientId);
  if (!fs.existsSync(file)) return false;
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8").trim();
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    return Boolean(data && typeof data === "object");
  } catch {
    return false;
  }
}

// 清理空字符串 URL 类变量并套用 REGION 接入点（空串 ≠ 未设置，会让 SDK 用空白地址连不上）
function sanitizeEnv() {
  for (const key of [
    "LONGBRIDGE_HTTP_URL",
    "LONGBRIDGE_QUOTE_WS_URL",
    "LONGBRIDGE_TRADE_WS_URL",
    "LONGBRIDGE_REGION",
    "LONGBRIDGE_ENABLE_OVERNIGHT",
    "LONGBRIDGE_PUSH_CANDLESTICK_MODE",
    "LONGBRIDGE_PRINT_QUOTE_PACKAGES",
  ]) {
    if (env(key) === "" && process.env[key] !== undefined) delete process.env[key];
  }
  if (process.env.LONGBRIDGE_PRINT_QUOTE_PACKAGES === undefined) {
    process.env.LONGBRIDGE_PRINT_QUOTE_PACKAGES = "false"; // 应用默认静默，不开详细行情包日志
  }
  const region = env("LONGBRIDGE_REGION").toLowerCase();
  if (region) {
    if (!process.env.LONGPORT_REGION) process.env.LONGPORT_REGION = region; // SDK 兼容旧变量名
    for (const [key, url] of Object.entries(REGION_URLS[region] || {})) {
      if (url && env(key) === "") process.env[key] = url;
    }
  }
}

function isConnectionError(error) {
  const msg = String((error && error.message) || error || "").toLowerCase();
  return CONNECTION_ERRORS.some((s) => msg.includes(s));
}

function markCooldown(error) {
  _ctx = null;
  const sec = Number(env("LONGBRIDGE_CONNECTION_COOLDOWN_SECONDS")) || 15;
  _cooldownUntil = Date.now() + sec * 1000;
  console.warn(`[longbridge] 连接异常，进入 ${sec}s 冷却: ${error.message}`);
}

async function getCtx() {
  if (_ctx) return _ctx;
  if (!isLongbridgeConfigured()) return null;
  if (_cooldownUntil > Date.now()) return null;
  _cooldownUntil = 0;

  const lb = getLb();
  if (!lb) return null;

  try {
    sanitizeEnv();
    let config = null;

    const clientId = env("LONGBRIDGE_OAUTH_CLIENT_ID");
    if (clientId) {
      restoreTokenCache(clientId);
      if (isValidTokenCache(clientId)) {
        const oauth = await lb.OAuth.build(clientId, (_err, url) => {
          // 无头运行不启动交互授权：抛错让上层降级到 Alpha Vantage
          throw new Error(
            "Longbridge OAuth token 已失效，无头环境无法授权；请重新运行 scripts/generate_longbridge_oauth_token.py"
          );
        });
        config = lb.Config.fromOAuth(oauth);
      } else {
        console.warn(`[longbridge] OAuth client 已配置但 token 缓存缺失或非法: ${tokenCachePath(clientId)}`);
      }
    }

    if (!config) {
      const appKey = env("LONGBRIDGE_APP_KEY");
      const appSecret = env("LONGBRIDGE_APP_SECRET");
      const accessToken = env("LONGBRIDGE_ACCESS_TOKEN");
      if (appKey && appSecret && accessToken) {
        config = lb.Config.fromApikey(appKey, appSecret, accessToken);
      }
    }

    if (!config) {
      _cooldownUntil = Date.now() + 30000; // 30s 内不重试，避免刷日志
      return null;
    }
    _ctx = lb.QuoteContext.new(config);
    return _ctx;
  } catch (error) {
    console.warn(`[longbridge] 初始化失败: ${error.message}`);
    _cooldownUntil = Date.now() + 30000;
    return null;
  }
}

// WS 订阅复用同一个 QuoteContext 单例
export async function getSharedCtx() {
  return getCtx();
}

function num(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object" && typeof value.toNumber === "function") return num(value.toNumber());
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 与 DSA data_provider 契约一致：AAPL → AAPL.US；4-5 位纯数字视为港股 → 0700.HK
function toLongbridgeSymbol(code) {
  const s = String(code || "").trim().toUpperCase();
  if (!s) return "";
  if (s.endsWith(".US") || s.endsWith(".HK")) return s;
  if (/^\d{4,5}$/.test(s)) return `${s.padStart(4, "0")}.HK`;
  return `${s}.US`;
}

// 量比 / 换手率 / PE / PB / 振幅 —— 一次调用，失败不致命
async function fetchCalcIndex(ctx, symbol) {
  const lb = getLb();
  const out = {
    volumeRatio: null,
    turnoverRate: null,
    peRatio: null,
    pbRatio: null,
    amplitude: null,
    changeRate: null,
    dividendRatioTtm: null,
    ytdChangeRate: null,
    totalMarketValue: null,
  };
  if (!lb) return out;
  try {
    const rows = await ctx.calcIndexes(
      [symbol],
      [
        lb.CalcIndex.ChangeRate,
        lb.CalcIndex.TurnoverRate,
        lb.CalcIndex.Amplitude,
        lb.CalcIndex.VolumeRatio,
        lb.CalcIndex.PeTtmRatio,
        lb.CalcIndex.PbRatio,
        lb.CalcIndex.DividendRatioTtm,
        lb.CalcIndex.YtdChangeRate,
        lb.CalcIndex.TotalMarketValue,
      ]
    );
    const row = rows && rows[0];
    if (row) {
      out.changeRate = num(row.changeRate);
      out.turnoverRate = num(row.turnoverRate);
      out.amplitude = num(row.amplitude);
      out.volumeRatio = num(row.volumeRatio);
      out.peRatio = num(row.peTtmRatio);
      out.pbRatio = num(row.pbRatio);
      out.dividendRatioTtm = num(row.dividendRatioTtm);
      out.ytdChangeRate = num(row.ytdChangeRate);
      out.totalMarketValue = num(row.totalMarketValue);
    }
  } catch {
    // 增强字段失败不致命，保留 null
  }
  return out;
}

export async function fetchQuote(code, meta = {}) {
  const ctx = await getCtx();
  const base = {
    ...meta,
    displaySymbol: meta.displaySymbol || meta.symbol || code,
    price: null,
    previousClose: null,
    change: null,
    changePercent: null,
    volume: null,
    turnover: null,
    volumeRatio: null,
    turnoverRate: null,
    peRatio: null,
    pbRatio: null,
    amplitude: null,
    dividendRatioTtm: null,
    ytdChangeRate: null,
    totalMarketValue: null,
    open: null,
    high: null,
    low: null,
    tradingDay: "",
    source: "longbridge",
    available: false,
    error: "",
  };
  if (!ctx) return { ...base, error: "Longbridge 未配置或不可用" };

  const symbol = meta.longbridgeSymbol || toLongbridgeSymbol(code);
  if (!symbol) return { ...base, error: `无法转换代码 ${code}` };

  try {
    const quotes = await ctx.quote([symbol]);
    const q = quotes && quotes[0];
    if (!q) return { ...base, error: "长桥无该标的行情" };

    const price = num(q.lastDone);
    const previousClose = num(q.prevClose);
    if (!price || price <= 0) return { ...base, error: "长桥返回无效价格" };

    const open = num(q.open);
    const high = num(q.high);
    const low = num(q.low);
    const volume = typeof q.volume === "number" ? q.volume : num(q.volume);
    const turnover = num(q.turnover);
    const change = previousClose ? Math.round((price - previousClose) * 10000) / 10000 : null;
    const changePercent = previousClose ? Math.round(((price - previousClose) / previousClose) * 10000) / 100 : null;

    const calc = await fetchCalcIndex(ctx, symbol);

    let name = meta.name || "";
    let nameCn = meta.nameCn || "";
    try {
      const infos = await ctx.staticInfo([symbol]);
      const info = infos && infos[0];
      if (info) {
        name = info.nameEn || name;
        nameCn = info.nameCn || nameCn;
      }
    } catch {
      // 名称失败不致命
    }

    return {
      ...meta,
      displaySymbol: meta.displaySymbol || meta.symbol || symbol,
      name,
      nameCn,
      price,
      previousClose,
      change,
      changePercent,
      volume: volume > 0 ? volume : null,
      turnover,
      volumeRatio: calc.volumeRatio,
      turnoverRate: calc.turnoverRate,
      peRatio: calc.peRatio,
      pbRatio: calc.pbRatio,
      amplitude: calc.amplitude,
      dividendRatioTtm: calc.dividendRatioTtm,
      ytdChangeRate: calc.ytdChangeRate,
      totalMarketValue: calc.totalMarketValue,
      open,
      high,
      low,
      tradingDay: q.timestamp ? new Date(q.timestamp).toISOString().slice(0, 10) : "",
      source: "longbridge",
      available: true,
      error: "",
    };
  } catch (error) {
    if (isConnectionError(error)) markCooldown(error);
    return { ...base, error: error.message };
  }
}

// 日K序列（benchmark 用）：返回 [{ date, close }]，失败返回 null 让上层回退 Alpha Vantage
export async function fetchDailyCandlesticks(code, count = 750) {
  const ctx = await getCtx();
  if (!ctx) return null;
  const symbol = toLongbridgeSymbol(code);
  const lb = getLb();
  if (!symbol || !lb) return null;
  try {
    const bars = await ctx.candlesticks(symbol, lb.Period.Day, count, lb.AdjustType.ForwardAdjust, lb.TradeSessions.Intraday);
    if (!bars || !bars.length) return null;
    return bars
      .map((bar) => ({
        date: new Date(bar.timestamp).toISOString().slice(0, 10),
        close: num(bar.close),
      }))
      .filter((point) => point.date && point.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (error) {
    if (isConnectionError(error)) markCooldown(error);
    console.warn(`[longbridge] 日K获取失败 ${symbol}: ${error.message}`);
    return null;
  }
}
