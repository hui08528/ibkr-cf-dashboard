const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

let cachedBySymbol = new Map();
let cachedCalendar = null;
let cachedCalendarAt = 0;

export async function onRequestGet({ env, request }) {
  const cacheTtlMs = Number(env.EARNINGS_CACHE_SECONDS || 86400) * 1000;
  const url = new URL(request.url);

  try {
    const apiKey = env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) {
      return json(503, {
        error: "Alpha Vantage is not configured",
        message: "Set ALPHA_VANTAGE_API_KEY in Cloudflare environment variables.",
      });
    }

    const symbols = parseSymbols(url.searchParams.get("symbols"));
    const forceRefresh = url.searchParams.get("refresh") === "1";
    if (symbols.length === 0) {
      return json(400, {
        error: "Missing symbols",
        message: "Pass a comma-separated symbols query parameter.",
      });
    }

    const results = await getEarningsForSymbols(symbols, apiKey, forceRefresh, cacheTtlMs);

    return json(200, {
      source: "alpha-vantage",
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

async function getEarningsForSymbols(symbols, apiKey, forceRefresh = false, cacheTtlMs = 0) {
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

  const calendar = await getCalendar(apiKey, forceRefresh, cacheTtlMs);
  for (const symbol of missing) {
    const value = findNextEarnings(calendar, symbol);
    cachedBySymbol.set(symbol, { value, cachedAt: Date.now() });
    results[symbol] = value;
  }

  return results;
}

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

  return next || { symbol, reportDate: "", fiscalDateEnding: "", estimate: "", currency: "USD" };
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

function normalizeDate(value) {
  if (!value || /^(none|null|n\/a)$/i.test(value)) return "";
  const match = value.match(/(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function parseDateValue(value) {
  const normalized = normalizeDate(value);
  return normalized ? Date.parse(`${normalized}T00:00:00Z`) : NaN;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((header) => header.replace(/^\uFEFF/, ""));
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
    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      index += 1;
    } else if (char === "\"") {
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
