// Finnhub OpenAPI 财报日历 —— /api/earnings 的美股优先源
//
// 免费档 60 calls/min。注意：/calendar/earnings 必须带 from/to 窗口，
// 单次响应上限 1500 条（长窗口会截断丢标的），因此批量按月开窗、
// 批内共享窗口，命中的 symbol 立即移除，直到全部解析或到达 horizon。
// 输出归一为 earnings.js 结果结构，含财报期 fiscalPeriod（如 2027Q3）。
// 纯 HTTPS fetch，无新增依赖；请求/解析失败向上抛错，调用方 fail-open 回退长桥/AV。

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const REQUEST_TIMEOUT_MS = 10000;
const WINDOW_GAP_MS = 300; // 窗口请求间隔，远离 60/min 限流

export function isFinnhubConfigured(env) {
  return Boolean(env?.FINNHUB_API_KEY);
}

// symbols: Array<string> → Map<symbol, 归一结果>（未来最近一场财报）
export async function fetchFinnhubEarnings(symbols, apiKey, { horizonDays = 365 } = {}) {
  const results = new Map();
  if (!apiKey || symbols.length === 0) return results;

  const pending = new Set(symbols);
  const today = startOfTodayDate();
  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + horizonDays);

  let cursor = new Date(today);
  while (pending.size > 0 && cursor < horizon) {
    const from = isoDate(cursor);
    const next = new Date(cursor);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const to = isoDate(next < horizon ? next : horizon);

    const events = await fetchWindow(from, to, apiKey);
    for (const e of events) {
      if (!pending.has(e.symbol)) continue;
      const row = normalizeEvent(e);
      // 只接受今天及以后、且日期有效的事件
      if (row.reportDate && parseDateValue(row.reportDate) >= startOfToday()) {
        results.set(e.symbol, { ...row, source: "finnhub" });
        pending.delete(e.symbol);
      }
    }
    cursor = next;
    if (pending.size > 0 && cursor < horizon) await wait(WINDOW_GAP_MS);
  }

  return results;
}

async function fetchWindow(from, to, apiKey) {
  const url = new URL(`${FINNHUB_BASE_URL}/calendar/earnings`);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("token", apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "IBKR-Portfolio-Dashboard/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Finnhub HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body?.earningsCalendar) ? body.earningsCalendar : [];
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEvent(e) {
  return {
    symbol: valueOf(e.symbol),
    reportDate: normalizeDate(e.date),
    fiscalPeriod: fiscalPeriodOf(e.year, e.quarter),
    estimate: numberValue(e.epsEstimate),
    estimateRevenue: compactMoney(e.revenueEstimate),
    actualEps: numberValue(e.epsActual),
    actualRevenue: compactMoney(e.revenueActual),
    session: /^(bmo|pre|盘前)/i.test(valueOf(e.hour)) ? "pre"
      : /^(amc|post|盘后)/i.test(valueOf(e.hour)) ? "post"
      : "",
    currency: "USD",
    star: 0,
    fiscalDateEnding: "",
  };
}

// 金额紧凑化，与长桥日历格式对齐：111.32 B / 18.04 M / 520 K
function compactMoney(value) {
  const n = numberValue(value);
  if (n === "") return "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)} B`;
  if (abs >= 1e6) return `${trim(n / 1e6)} M`;
  if (abs >= 1e3) return `${trim(n / 1e3)} K`;
  return String(n);
}

function trim(value) {
  return String(Number(value.toFixed(2)));
}

// 财报期文本：year + quarter → "2027Q3"；任一缺失返回空串（前端显示 "-"，不编造）
function fiscalPeriodOf(year, quarter) {
  const y = valueOf(year);
  const q = valueOf(quarter);
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(q)) return "";
  return `${y}Q${q}`;
}

function normalizeDate(value) {
  if (!value || /^(none|null|n\/a)$/i.test(String(value))) return "";
  const match = String(value).match(/(\d{4})[./-]?(\d{2})[./-]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function parseDateValue(value) {
  const normalized = normalizeDate(value);
  return normalized ? Date.parse(`${normalized}T00:00:00Z`) : NaN;
}

function startOfTodayDate() {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function startOfToday() {
  return startOfTodayDate().getTime();
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}

function valueOf(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
