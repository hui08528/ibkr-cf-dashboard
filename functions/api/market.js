import { fetchQuote as fetchLongbridgeQuote, isLongbridgeConfigured } from "./lib/longbridge.js";

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

let cachedQuotes = null; // 美股
let cachedCnQuotes = null; // A 股
let cachedSource = null;
let cachedAt = 0;

// 美股核心 ETF 与指数
const usInstruments = [
  // NDXTMC：纳指100 科技板块市值加权指数
  { symbol: "NDXTMC", name: "NASDAQ 100 Technology Sector Market-Cap Index", nameCn: "纳指100科技市值加权指数", longbridgeSymbol: ".NDXTMC.US" },
  // NDX 是指数不是证券，长桥代码需前置点号：.NDX.US
  { symbol: "NDX", name: "NASDAQ-100 Index", nameCn: "纳斯达克100 指数", longbridgeSymbol: ".NDX.US" },
  { symbol: "QQQ", name: "Invesco QQQ Trust", nameCn: "纳斯达克100 ETF" },
  { symbol: "VOO", name: "Vanguard S&P 500 ETF", nameCn: "标普500 ETF" },
  { symbol: "SMH", name: "VanEck Semiconductor ETF", nameCn: "半导体 ETF" },
  { symbol: "VGT", name: "Vanguard Information Technology ETF", nameCn: "信息科技 ETF" },
];

// 场内 QDII（追踪同一批海外指数的国内 ETF）
const cnInstruments = [
  // 159509.SZ：景顺长城纳斯达克科技 ETF，追踪 NDXTMC
  { symbol: "159509", displaySymbol: "159509.SZ", name: "Invesco Great Wall Nasdaq-100 Technology Sector Market-Cap Weighted ETF (QDII)", nameCn: "景顺长城纳斯达克科技ETF(QDII)", longbridgeSymbol: "159509.SZ" },
  // 以下均追踪纳斯达克100（NDX）
  { symbol: "159941", displaySymbol: "159941.SZ", name: "广发纳指100ETF", nameCn: "广发纳指100ETF", longbridgeSymbol: "159941.SZ" },
  { symbol: "513100", displaySymbol: "513100.SH", name: "国泰纳斯达克100(QDII-ETF)", nameCn: "国泰纳斯达克100ETF(QDII)", longbridgeSymbol: "513100.SH" },
  { symbol: "159659", displaySymbol: "159659.SZ", name: "招商纳斯达克100ETF(QDII)", nameCn: "招商纳斯达克100ETF(QDII)", longbridgeSymbol: "159659.SZ" },
  { symbol: "513300", displaySymbol: "513300.SH", name: "华夏纳斯达克100ETF(QDII)", nameCn: "华夏纳斯达克100ETF(QDII)", longbridgeSymbol: "513300.SH" },
];

export async function onRequestGet({ env }) {
  const cacheTtlMs = Number(env.MARKET_CACHE_SECONDS || 300) * 1000;

  try {
    if (cachedQuotes && cachedCnQuotes && Date.now() - cachedAt < cacheTtlMs) {
      return json(200, {
        source: cachedSource,
        updatedAt: new Date(cachedAt).toISOString(),
        quotes: cachedQuotes,
        cnQuotes: cachedCnQuotes,
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

    // avCalls 在两组建共享：限制 Alpha Vantage 免费额度（调用间至少间隔 1.2s）
    const state = { lbConfigured, apiKey, avCalls: 0 };
    const quotes = await loadGroup(usInstruments, state);
    const cnQuotes = await loadGroup(cnInstruments, state);

    if ([...quotes, ...cnQuotes].some((quote) => quote.available)) {
      cachedQuotes = quotes;
      cachedCnQuotes = cnQuotes;
      cachedAt = Date.now();
      cachedSource = [...quotes, ...cnQuotes].some((quote) => quote.source === "longbridge")
        ? "longbridge"
        : "alpha-vantage";
    }
    return json(200, {
      source: cachedSource || "alpha-vantage",
      updatedAt: new Date(cachedAt || Date.now()).toISOString(),
      quotes,
      cnQuotes,
    });
  } catch (error) {
    return json(502, {
      error: "Unable to load market quotes",
      message: error.message,
    });
  }
}

async function loadGroup(instruments, state) {
  const quotes = [];
  for (const instrument of instruments) {
    const quote = await loadQuote(instrument, state);
    if (quote.source === "alpha-vantage") state.avCalls += 1;
    quotes.push(quote);
  }
  return quotes;
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
