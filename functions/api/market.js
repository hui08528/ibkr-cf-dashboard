const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

let cachedQuotes = null;
let cachedAt = 0;

const instruments = [
  { symbol: "QQQ", name: "Invesco QQQ Trust", nameCn: "纳斯达克100 ETF" },
];

export async function onRequestGet({ env }) {
  const cacheTtlMs = Number(env.MARKET_CACHE_SECONDS || 300) * 1000;

  try {
    const apiKey = env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) {
      return json(503, {
        error: "Alpha Vantage is not configured",
        message: "Set ALPHA_VANTAGE_API_KEY in Cloudflare environment variables.",
      });
    }

    if (cachedQuotes && Date.now() - cachedAt < cacheTtlMs) {
      return json(200, { source: "alpha-vantage", updatedAt: new Date(cachedAt).toISOString(), quotes: cachedQuotes, cached: true });
    }

    const quotes = [];
    for (let index = 0; index < instruments.length; index += 1) {
      if (index > 0) await wait(1200);
      const instrument = instruments[index];
      quotes.push(await fetchQuote(instrument, apiKey));
    }

    if (quotes.some((quote) => quote.available)) {
      cachedQuotes = quotes;
      cachedAt = Date.now();
    }
    return json(200, { source: "alpha-vantage", updatedAt: new Date(cachedAt || Date.now()).toISOString(), quotes });
  } catch (error) {
    return json(502, {
      error: "Unable to load market quotes",
      message: error.message,
    });
  }
}

async function fetchQuote(instrument, apiKey) {
  const url = new URL(ALPHA_VANTAGE_URL);
  url.searchParams.set("function", "GLOBAL_QUOTE");
  url.searchParams.set("symbol", instrument.symbol);
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "IBKR-Portfolio-Dashboard/1.0" },
  });
  const text = await response.text();

  if (!response.ok) {
    return { ...instrument, displaySymbol: instrument.displaySymbol || instrument.symbol, error: `HTTP ${response.status}` };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ...instrument, displaySymbol: instrument.displaySymbol || instrument.symbol, error: "Invalid response" };
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
