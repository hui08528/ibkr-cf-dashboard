// 财报日历 —— 长桥 Calendar 主源，Alpha Vantage 兜底
//
// 长桥：无每日次数限制，带盘前/盘后（session）、重要性星级、预估 EPS。
// AV：长桥未覆盖/不可用时按 symbol 补；免费 key 每天 25 次。
// 缓存：单个 symbol 结果 + 长桥事件窗口，TTL 默认 24h（EARNINGS_CACHE_SECONDS）。

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { getSharedCalendarCtx } from "./lib/longbridge.js";
import { isLongbridgeConfigured } from "./lib/longbridge.js";
import { isFinnhubConfigured, fetchFinnhubEarnings } from "./lib/finnhub.js";

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const HORIZON_DAYS = 180; // 长桥查询窗口（财报确认日期通常在未来 1~2 个季度）
const LB_EVENT_CAP = 300; // 单次窗口事件上限（超出需分页，当前窗口足够）
const DEFAULT_LOOKBACK_DAYS = 7; // 财报发布后回看多少天，仍展示实际值与预期判定
const DEFAULT_EPS_TOL = 0.02; // EPS ±2% 内算符合预期
const DEFAULT_REV_TOL = 0.01; // 营收 ±1% 内算符合预期

const require = createRequire(import.meta.url);

let cachedBySymbol = new Map();
let lbEvents = null; // 长桥原始事件（已归一）
let lbEventsAt = 0;
let cachedCalendar = null;
let cachedCalendarAt = 0;

// 长桥单日事件进程内缓存：接口实测只返回 start 当天事件，历史日期数据不变，缓存 12h
const lbDayCache = new Map();
const LB_DAY_TTL_MS = 12 * 3600 * 1000;

// —— 预期快照：财报前把 Finnhub 预估（EPS/营收/财季/日期）落盘，
//    发布后 Finnhub 会滚动到下季度、长桥当天事件又常缺预估，快照用来补预期做 beat/miss 判定。
function estimateSnapshotFile(env) {
  return env.EARNINGS_ESTIMATES_FILE || "/data/earnings-estimates.json";
}

function loadEstimateSnapshot(env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(estimateSnapshotFile(env), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveEstimateSnapshot(snapshot, env) {
  try {
    const file = estimateSnapshotFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    console.warn(`[earnings] 预期快照落盘失败: ${error.message}`);
  }
}

// "111.32 B" / "2.53" / "1,234.5 M" → 数值（美元）；无法解析返回 null
function parseMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const match = String(value).trim().match(/^([\d,.]+)\s*([KMBT])?$/i);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, "": 1 }[(match[2] || "").toUpperCase()];
  return n * mult;
}

// 实际 vs 预期：beat 超预期 / meet 符合 / miss 未达；任一缺失返回 null（不硬贴标签）
function classifyBeat(actual, estimate, tolerance) {
  const a = parseMoney(actual);
  const e = parseMoney(estimate);
  if (a === null || e === null || e === 0) return null;
  const ratio = a / e;
  if (ratio >= 1 + tolerance) return "beat";
  if (ratio <= 1 - tolerance) return "miss";
  return "meet";
}

// 统一输出：带实际值即标记 reported 并判定，否则 upcoming
function finalizeRow(row, epsTol, revTol) {
  if (row.actualEps || row.actualRevenue) {
    return {
      ...row,
      status: "reported",
      epsBeat: classifyBeat(row.actualEps, row.estimate, epsTol),
      revenueBeat: classifyBeat(row.actualRevenue, row.estimateRevenue, revTol),
    };
  }
  return { ...row, status: "upcoming" };
}

export async function onRequestGet({ env, request }) {
  const cacheTtlMs = Number(env.EARNINGS_CACHE_SECONDS || 86400) * 1000;
  const url = new URL(request.url);

  try {
    const symbols = parseSymbols(url.searchParams.get("symbols"));
    const forceRefresh = url.searchParams.get("refresh") === "1";
    if (symbols.length === 0) {
      return json(400, {
        error: "Missing symbols",
        message: "Pass a comma-separated symbols query parameter.",
      });
    }

    const lbReady = isLongbridgeConfigured(env);
    const apiKey = env.ALPHA_VANTAGE_API_KEY;
    const finnhubKey = isFinnhubConfigured(env) ? env.FINNHUB_API_KEY : "";
    if (!lbReady && !apiKey && !finnhubKey) {
      return json(503, {
        error: "Earnings source is not configured",
        message: "Set LONGBRIDGE_OAUTH_CLIENT_ID, ALPHA_VANTAGE_API_KEY or FINNHUB_API_KEY.",
      });
    }

    const results = await getEarningsForSymbols(symbols, {
      env: process.env,
      lbReady,
      apiKey,
      finnhubKey,
      forceRefresh,
      cacheTtlMs,
      epsTol: Number(process.env.EARNINGS_BEAT_TOL_EPS) || DEFAULT_EPS_TOL,
      revTol: Number(process.env.EARNINGS_BEAT_TOL_REVENUE) || DEFAULT_REV_TOL,
      lookbackDays: Number(process.env.EARNINGS_LOOKBACK_DAYS) || DEFAULT_LOOKBACK_DAYS,
    });

    const sources = new Set(Object.values(results).map((row) => row.source));
    return json(200, {
      source: sources.has("finnhub") ? "finnhub" : sources.has("longbridge") ? "longbridge" : "alpha-vantage",
      updatedAt: new Date().toISOString(),
      earnings: results,
    });
  } catch (error) {
    return json(502, {
      error: "Unable to load earnings calendar",
      message: error.message,
    });
  }
}

async function getEarningsForSymbols(symbols, options) {
  const {
    env = process.env,
    lbReady,
    apiKey,
    finnhubKey,
    forceRefresh,
    cacheTtlMs,
    epsTol = DEFAULT_EPS_TOL,
    revTol = DEFAULT_REV_TOL,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
  } = options;
  const results = {};
  const missing = [];

  for (const symbol of symbols) {
    const cached = cachedBySymbol.get(symbol);
    if (!forceRefresh && cached && Date.now() - cached.cachedAt < cacheTtlMs) {
      results[symbol] = { ...cached.value, cached: true };
    } else {
      missing.push(symbol);
    }
  }

  if (missing.length === 0) return results;

  const snapshot = loadEstimateSnapshot(env);
  let snapshotDirty = false;
  const rememberEstimate = (symbol, value) => {
    if (!value.estimate && !value.estimateRevenue) return;
    const prev = snapshot[symbol] || {};
    const next = {
      fiscalPeriod: value.fiscalPeriod || prev.fiscalPeriod || "",
      estimate: value.estimate || prev.estimate || "",
      estimateRevenue: value.estimateRevenue || prev.estimateRevenue || "",
      currency: value.currency || prev.currency || "USD",
      reportDate: value.reportDate || prev.reportDate || "",
      savedAt: new Date().toISOString(),
    };
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      snapshot[symbol] = next;
      snapshotDirty = true;
    }
  };

  // 长桥过去 N 天事件池（单日接口+进程缓存）：Finnhub 已滚动到下季度时，
  // 用它恢复"刚发布的实际值"；也供 Finnhub 未命中的标的复用。
  let pastEvents = [];
  if (lbReady) {
    for (let i = 1; i <= lookbackDays; i += 1) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const dayEvents = await getLbDayEvents(isoDate(d)).catch(() => []);
      pastEvents.push(...dayEvents);
    }
  }

  // 0) Finnhub：美股标的优先（财报期 + 预估EPS + 预估营收）。
  //    批量按月开窗、批内共享；但若长桥回看窗口内已有"刚发布"事件，以已发布为准。
  let lbUnresolved = missing;
  if (finnhubKey) {
    const usSymbols = missing.filter(isUsSymbol);
    const nonUs = missing.filter((symbol) => !isUsSymbol(symbol));
    try {
      const found = await fetchFinnhubEarnings(usSymbols, finnhubKey);
      for (const [symbol, value] of found) {
        const justReported = findReportedLbEvent(pastEvents, symbol, lookbackDays);
        if (justReported) {
          // Finnhub 已滚动到下季度，但最近 N 天内有实际财报 → 优先展示已发布
          const finalized = assembleLbValue(symbol, justReported, snapshot[symbol], epsTol, revTol);
          cachedBySymbol.set(symbol, { value: finalized, cachedAt: Date.now() });
          results[symbol] = finalized;
          continue;
        }
        const finalized = finalizeRow(value, epsTol, revTol);
        cachedBySymbol.set(symbol, { value: finalized, cachedAt: Date.now() });
        results[symbol] = finalized;
        if (finalized.status === "upcoming") rememberEstimate(symbol, finalized); // 留住预期，发布后用于判定
      }
      lbUnresolved = [...nonUs, ...usSymbols.filter((symbol) => !found.has(symbol))];
    } catch (error) {
      console.warn(`[earnings] Finnhub 失败，回退长桥/AV: ${error.message}`);
      lbUnresolved = missing;
    }
  }
  if (lbUnresolved.length === 0) {
    if (snapshotDirty) saveEstimateSnapshot(snapshot, env);
    return results;
  }

  // 1) 长桥：今天事件（含盘前已发布的实际值）+ 回看窗口内的已发布事件。
  if (lbReady) {
    // 今天（HORIZON 窗口实测只返回 start 当天）
    const todayEvents = await getLongbridgeEvents(forceRefresh, cacheTtlMs).catch((error) => {
      console.warn(`[earnings] 长桥今日日历失败，回退 AV: ${error.message}`);
      return null;
    });

    if (todayEvents || pastEvents.length) {
      const stillUnresolved = [];
      for (const symbol of lbUnresolved) {
        // 优先：今天/未来事件（发财报当天 actual 已出 → reported）
        const upcoming = todayEvents ? findNextLbEvent(todayEvents, symbol) : null;
        const reported = findReportedLbEvent(pastEvents, symbol, lookbackDays);

        if (upcoming) {
          const value = assembleLbValue(symbol, upcoming, snapshot[symbol], epsTol, revTol);
          cachedBySymbol.set(symbol, { value, cachedAt: Date.now() });
          results[symbol] = value;
          if (value.status === "upcoming") rememberEstimate(symbol, value);
        } else if (reported) {
          const value = assembleLbValue(symbol, reported, snapshot[symbol], epsTol, revTol);
          cachedBySymbol.set(symbol, { value, cachedAt: Date.now() });
          results[symbol] = value;
        } else {
          stillUnresolved.push(symbol); // 长桥窗口内没有 → 交给 AV
        }
      }
      lbUnresolved = stillUnresolved;
    }
  }

  // 2) Alpha Vantage 兜底（仅未来财报）
  if (lbUnresolved.length && apiKey) {
    const calendar = await getCalendar(apiKey, forceRefresh, cacheTtlMs);
    for (const symbol of lbUnresolved) {
      const value = findNextEarnings(calendar, symbol);
      cachedBySymbol.set(symbol, { value, cachedAt: Date.now() });
      results[symbol] = value;
    }
  } else {
    for (const symbol of lbUnresolved) {
      results[symbol] = emptyEarnings(symbol);
    }
  }

  if (snapshotDirty) saveEstimateSnapshot(snapshot, env);
  return results;
}

// 长桥单日事件（接口只返回 start 当天），进程内缓存 12h（历史数据不变）
async function getLbDayEvents(dateStr) {
  const cached = lbDayCache.get(dateStr);
  if (cached && Date.now() - cached.at < LB_DAY_TTL_MS) return cached.events;

  const calCtx = await getSharedCalendarCtx();
  if (!calCtx) return [];
  const lb = require("longbridge");
  const res = await calCtx.financeCalendar(
    lb.CalendarCategory.Report,
    dateStr,
    dateStr,
    null,
    LB_EVENT_CAP
  );
  const events = res.list.flatMap((day) => day.infos.map(normalizeLbEvent));
  lbDayCache.set(dateStr, { events, at: Date.now() });
  return events;
}

// 过去 N 天内最新一条带实际 EPS 的事件
function findReportedLbEvent(events, symbol, lookbackDays) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - lookbackDays);
  return (
    events
      .filter((row) => row.symbol === symbol && row.actualEps)
      .filter((row) => parseDateValue(row.reportDate) >= since.getTime())
      .sort((a, b) => parseDateValue(b.reportDate) - parseDateValue(a.reportDate))[0] || null
  );
}

// 长桥事件组装：有实际值 → reported + beat/miss（预期取事件自带或快照）；否则 upcoming
function assembleLbValue(symbol, event, snapshot = {}, epsTol, revTol) {
  if (event.actualEps || event.actualRevenue) {
    const estimate = event.estimate || snapshot.estimate || "";
    const estimateRevenue = event.estimateRevenue || snapshot.estimateRevenue || "";
    return {
      symbol,
      source: "longbridge",
      status: "reported",
      reportDate: event.reportDate,
      fiscalPeriod: snapshot.fiscalPeriod || "",
      session: event.session,
      star: event.star,
      currency: event.currency,
      estimate,
      estimateRevenue,
      actualEps: event.actualEps,
      actualRevenue: event.actualRevenue,
      epsBeat: classifyBeat(event.actualEps, estimate, epsTol),
      revenueBeat: classifyBeat(event.actualRevenue, estimateRevenue, revTol),
    };
  }
  return { symbol, fiscalDateEnding: "", ...event, source: "longbridge", status: "upcoming" };
}

// —— 长桥 ——

async function getLongbridgeEvents(forceRefresh, cacheTtlMs) {
  if (!forceRefresh && lbEvents && Date.now() - lbEventsAt < cacheTtlMs) return lbEvents;

  const calCtx = await getSharedCalendarCtx();
  if (!calCtx) throw new Error("长桥 CalendarContext 不可用");
  const lb = require("longbridge");

  const start = isoDate(new Date());
  const end = isoDate(addDays(new Date(), HORIZON_DAYS));
  const res = await calCtx.financeCalendar(
    lb.CalendarCategory.Report,
    start,
    end,
    null, // 不限市场
    LB_EVENT_CAP
  );

  lbEvents = res.list.flatMap((day) => day.infos.map(normalizeLbEvent));
  lbEventsAt = Date.now();
  return lbEvents;
}

function normalizeLbEvent(e) {
  const kvByType = new Map((e.dataKv || []).map((kv) => [kv.valueType, kv]));
  const pick = (type) => {
    const kv = kvByType.get(type);
    const value = valueOf(kv?.value);
    return value && value !== "--" && value !== "TBA" ? value : "";
  };
  return {
    symbol: normalizeLbSymbol(e.symbol),
    reportDate: normalizeDate(e.date),
    // 盘前/盘后：dateType 可能随节点地域返回 Pre/Post 或中文
    session: /pre|盘前/i.test(e.dateType) ? "pre" : /post|盘后/i.test(e.dateType) ? "post" : "",
    star: Number(e.star) || 0,
    estimate: pick("estimate_eps"),
    estimateRevenue: pick("estimate_revenue"),
    actualEps: pick("actual_eps"),
    actualRevenue: pick("actual_revenue"),
    currency: valueOf(e.currency) || "USD",
  };
}

// AAPL.US→AAPL；BRK.B.US→BRK-B；700.HK→700
function normalizeLbSymbol(value) {
  const raw = valueOf(value).toUpperCase().replace(/\.(US|HK|CN|SG|JP)$/i, "");
  return raw.replace(/\./g, "-");
}

function findNextLbEvent(events, symbol) {
  const target = normalizeSymbol(symbol);
  const next = events
    .filter((row) => row.symbol === target)
    .filter((row) => row.reportDate && parseDateValue(row.reportDate) >= startOfToday())
    .sort((a, b) => parseDateValue(a.reportDate) - parseDateValue(b.reportDate))[0];
  return next ? { symbol, fiscalDateEnding: "", ...next, source: "longbridge" } : null;
}

// —— Alpha Vantage（兜底）——

async function getCalendar(apiKey, forceRefresh, cacheTtlMs) {
  if (!forceRefresh && cachedCalendar && Date.now() - cachedCalendarAt < cacheTtlMs) {
    return cachedCalendar;
  }

  cachedCalendar = await fetchAlphaVantageEarnings(apiKey);
  cachedCalendarAt = Date.now();
  return cachedCalendar;
}

function findNextEarnings(rows, symbol) {
  const targetSymbol = normalizeSymbol(symbol);
  const next = rows
    .map(normalizeEarningsRow)
    .filter((row) => normalizeSymbol(row.symbol) === targetSymbol)
    .filter((row) => row.reportDate && parseDateValue(row.reportDate) >= startOfToday())
    .sort((a, b) => parseDateValue(a.reportDate) - parseDateValue(b.reportDate))[0] || null;

  return next
    ? {
        ...next,
        session: "",
        star: 0,
        source: "alpha-vantage",
        status: "upcoming",
        estimateRevenue: "",
        actualEps: "",
        actualRevenue: "",
        epsBeat: null,
        revenueBeat: null,
      }
    : emptyEarnings(symbol);
}

function emptyEarnings(symbol) {
  return {
    symbol,
    reportDate: "",
    fiscalDateEnding: "",
    fiscalPeriod: "",
    estimate: "",
    currency: "USD",
    session: "",
    star: 0,
    source: "none",
    status: "upcoming",
    estimateRevenue: "",
    actualEps: "",
    actualRevenue: "",
    epsBeat: null,
    revenueBeat: null,
  };
}

async function fetchAlphaVantageEarnings(apiKey) {
  const url = new URL(ALPHA_VANTAGE_URL);
  url.searchParams.set("function", "EARNINGS_CALENDAR");
  url.searchParams.set("horizon", "12month");
  url.searchParams.set("datatype", "csv");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url, {
    headers: { Accept: "text/csv,*/*", "User-Agent": "IBKR-Portfolio-Dashboard/1.0" },
  });
  const text = await response.text();

  if (!response.ok) throw new Error(`Alpha Vantage HTTP ${response.status}: ${text.slice(0, 200)}`);
  if (text.trimStart().startsWith("{")) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("Alpha Vantage returned an invalid response.");
    }
    throw new Error(body.Note || body.Information || body["Error Message"] || "Alpha Vantage returned no CSV data.");
  }
  if (/thank you for using alpha vantage|standard api call frequency/i.test(text)) {
    throw new Error("Alpha Vantage rate limit reached.");
  }
  if (/invalid api call|demo api key/i.test(text)) {
    throw new Error("Alpha Vantage API key or request is invalid.");
  }

  return parseCsv(text);
}

function normalizeEarningsRow(row) {
  return {
    symbol: normalizeSymbol(row.symbol),
    reportDate: normalizeDate(valueOf(row.reportDate)),
    fiscalDateEnding: valueOf(row.fiscalDateEnding),
    estimate: valueOf(row.estimate),
    currency: valueOf(row.currency) || "USD",
  };
}

function normalizeSymbol(symbol) {
  return valueOf(symbol).toUpperCase().replace(/\./g, "-");
}

// 美股/非美股分流：明确非美后缀或纯数字（4-5 位，港股代码）视为非美股，其余字母开头算美股。
// 注意 symbol 是 parseSymbols 原始输出，点号保留（BRK.B、0700.HK），传给 Finnhub 时同样用点号格式。
function isUsSymbol(symbol) {
  const s = valueOf(symbol).toUpperCase();
  if (/\.(HK|CN|SG|JP)$/.test(s)) return false;
  if (/^\d{4,5}$/.test(s)) return false;
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(s);
}

function normalizeDate(value) {
  if (!value || /^(none|null|n\/a)$/i.test(value)) return "";
  const match = value.match(/(\d{4})[./-]?(\d{2})[./-]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function parseDateValue(value) {
  const normalized = normalizeDate(value);
  return normalized ? Date.parse(`${normalized}T00:00:00Z`) : NaN;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((header) => header.replace(/^﻿/, ""));
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = values[index] || "";
      return row;
    }, {});
  });
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

function parseSymbols(value) {
  return [...new Set(valueOf(value)
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))
    .slice(0, 30))];
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function startOfToday() {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function valueOf(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=300",
    },
  });
}
