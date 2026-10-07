// 财报日历 —— 长桥 Calendar 主源，Alpha Vantage 兜底
//
// 长桥：无每日次数限制，带盘前/盘后（session）、重要性星级、预估 EPS。
// AV：长桥未覆盖/不可用时按 symbol 补；免费 key 每天 25 次。
// 缓存：单个 symbol 结果 + 长桥事件窗口，TTL 默认 24h（EARNINGS_CACHE_SECONDS）。

import { createRequire } from "node:module";
import { getSharedCalendarCtx } from "./lib/longbridge.js";
import { isLongbridgeConfigured } from "./lib/longbridge.js";
import { isFinnhubConfigured, fetchFinnhubEarnings } from "./lib/finnhub.js";

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const HORIZON_DAYS = 180; // 长桥查询窗口（财报确认日期通常在未来 1~2 个季度）
const LB_EVENT_CAP = 300; // 单次窗口事件上限（超出需分页，当前窗口足够）

const require = createRequire(import.meta.url);

let cachedBySymbol = new Map();
let lbEvents = null; // 长桥原始事件（已归一）
let lbEventsAt = 0;
let cachedCalendar = null;
let cachedCalendarAt = 0;

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
      lbReady,
      apiKey,
      finnhubKey,
      forceRefresh,
      cacheTtlMs,
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

async function getEarningsForSymbols(symbols, { lbReady, apiKey, finnhubKey, forceRefresh, cacheTtlMs }) {
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

  // 0) Finnhub：美股标的优先（财报期 + 预估EPS + 预估营收）。
  //    批量按月开窗、批内共享；未命中/异常不中断，归入 lbUnresolved 走长桥/AV。
  let lbUnresolved = missing;
  if (finnhubKey) {
    const usSymbols = missing.filter(isUsSymbol);
    const nonUs = missing.filter((symbol) => !isUsSymbol(symbol));
    try {
      const found = await fetchFinnhubEarnings(usSymbols, finnhubKey);
      for (const [symbol, value] of found) {
        cachedBySymbol.set(symbol, { value, cachedAt: Date.now() });
        results[symbol] = value;
      }
      lbUnresolved = [...nonUs, ...usSymbols.filter((symbol) => !found.has(symbol))];
    } catch (error) {
      console.warn(`[earnings] Finnhub 失败，回退长桥/AV: ${error.message}`);
      lbUnresolved = missing;
    }
  }
  if (lbUnresolved.length === 0) return results;

  // 1) 长桥：整窗口事件拉一次，只处理 Finnhub 未命中的（lbUnresolved），
  //    避免覆盖已由 Finnhub 命中（含财报期）的美股结果。
  if (lbReady) {
    const events = await getLongbridgeEvents(forceRefresh, cacheTtlMs).catch((error) => {
      console.warn(`[earnings] 长桥日历失败，回退 AV: ${error.message}`);
      return null;
    });
    if (events) {
      const stillUnresolved = [];
      for (const symbol of lbUnresolved) {
        const value = findNextLbEvent(events, symbol);
        if (value) {
          cachedBySymbol.set(symbol, { value, cachedAt: Date.now() });
          results[symbol] = value;
        } else {
          stillUnresolved.push(symbol); // 长桥窗口内没有 → 交给 AV
        }
      }
      lbUnresolved = stillUnresolved;
    }
  }

  // 2) Alpha Vantage 兜底
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

  return results;
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
        estimateRevenue: "",
        actualEps: "",
        actualRevenue: "",
      }
    : emptyEarnings(symbol);
}

function emptyEarnings(symbol) {
  return {
    symbol,
    reportDate: "",
    fiscalDateEnding: "",
    estimate: "",
    currency: "USD",
    session: "",
    star: 0,
    source: "none",
    estimateRevenue: "",
    actualEps: "",
    actualRevenue: "",
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
