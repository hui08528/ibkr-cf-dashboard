import { fetchQuote as fetchLongbridgeQuote, isLongbridgeConfigured } from "./lib/longbridge.js";

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

let cachedQuotes = null;
let cachedSource = null;
let cachedAt = 0;

const instruments = [
  { symbol: "QQQ", name: "Invesco QQQ Trust", nameCn: "纳斯达克100 ETF" },
];

export async function onRequestGet({ env }) {
  const cacheTtlMs = Number(env.MARKET_CACHE_SECONDS || 300) * 1000;

  try {
    if (cachedQuotes && Date.now() - cachedAt < cacheTtlMs) {
      return json(200, {
        source: cachedSource,
        updatedAt: new Date(cachedAt).toISOString(),
        quotes: cachedQuotes,
        cached: true,
      });
    }

    const apiKey = env.ALPHA_VANTAGE_API_KEY;
    const lbConfigured = isLongbridgeConfigured();

    if (!lbConfigured && !apiKey) {
      return json(503, {
        error: "No market data source configured",
        message: "Set LONGBRIDGE_OAUTH_CLIENT_ID or ALPHA_VANTAGE_API_KEY.",
      });
    }

    const quotes = [];
    let avCalls = 0; // 限制 Alpha Vantage 免费额度（调用间至少间隔 1.2s）
    for (const instrument of instruments) {
      const quote = await loadQuote(instrument, { lbConfigured, apiKey, avCalls });
      if (quote.source === "alpha-vantage") avCalls += 1;
      quotes.push(quote);
    }

    if (quotes.some((quote) => quote.available)) {
      cachedQuotes = quotes;
      cachedAt = Date.now();
      cachedSource = quotes.some((quote) => quote.source === "longbridge") ? "longbridge" : "alpha-vantage";
    }
    return json(200, {
      source: cachedSource || "alpha-vantage",
      updatedAt: new Date(cachedAt || Date.now()).toISOString(),
      quotes,
    });
  } catch (error) {
    return json(502, {
      error: "Unable to load market quotes",
      message: error.message,
    });
  }
}

// 长桥主源 → Alpha Vantage 兜底
async function loadQuote(instrument, { lbConfigured, apiKey, avCalls }) {
  if (lbConfigured) {
    const lbQuote = await fetchLongbridgeQuote(instrument.symbol, instrument);
    if (lbQuote.available) return lbQuote;
    if (!apiKey) return lbQuote; // 无 AV key：保留长桥的错误信息
  }

  if (apiKey) {
    if (avCalls > 0) await wait(1200);
    return await fetchAlphaQuote(instrument, apiKey);
  }

  return {
    ...instrument,
    displaySymbol: instrument.displaySymbol || instrument.symbol,
    price: null,
    previousClose: null,
    change: null,
    changePercent: null,
    tradingDay: "",
    source: "longbridge",
    available: false,
    error: "Longbridge 与 Alpha Vantage 均未配置",
  };
}

async function fetchAlphaQuote(instrument, apiKey) {
  const url = new URL(ALPHA_VANTAGE_URL);
  url.searchParams.set("function", "GLOBAL_QUOTE");
  url.searchParams.set("symbol", instrument.symbol);
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "IBKR-Portfolio-Dashboard/1.0" },
  });
  const text = await response.text();

  if (!response.ok) {
    return { ...instrument, displaySymbol: instrument.displaySymbol || instrument.symbol, source: "alpha-vantage", error: `HTTP ${response.status}` };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ...instrument, displaySymbol: instrument.displaySymbol || instrument.symbol, source: "alpha-vantage", error: "Invalid response" };
  }

  const quote = body["Global Quote"] || {};
  const price = number(quote["05. price"]);
  const previousClose = number(quote["08. previous close"]);

  return {
    ...instrument,
    displaySymbol: instrument.displaySymbol || instrument.symbol,
    price,
    previousClose,
    change: number(quote["09. change"]),
    changePercent: parsePercent(quote["10. change percent"]),
    tradingDay: quote["07. latest trading day"] || "",
    available: price > 0 || previousClose > 0,
    source: "alpha-vantage",
    error: body.Note || body.Information || body["Error Message"] || "",
  };
}

function parsePercent(value) {
  return number(String(value || "").replace("%", ""));
}

function number(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
