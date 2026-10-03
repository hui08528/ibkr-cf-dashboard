const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

let cachedBenchmark = null;
let cachedAt = 0;

const BENCHMARK_SYMBOL = "QQQ";
const MAX_POINTS = 750;

export async function onRequestGet({ env }) {
  const cacheTtlMs = Number(env.BENCHMARK_CACHE_SECONDS || 86400) * 1000;

  try {
    const apiKey = env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) {
      return json(503, {
        error: "Alpha Vantage is not configured",
        message: "Set ALPHA_VANTAGE_API_KEY in Cloudflare environment variables.",
      });
    }

    if (cachedBenchmark && Date.now() - cachedAt < cacheTtlMs) {
      return json(200, {
        source: "alpha-vantage",
        updatedAt: new Date(cachedAt).toISOString(),
        benchmark: cachedBenchmark,
        cached: true,
      });
    }

    const benchmark = await fetchBenchmarkSeries(apiKey);
    if (benchmark.points.length) {
      cachedBenchmark = benchmark;
      cachedAt = Date.now();
    }
    return json(200, {
      source: "alpha-vantage",
      updatedAt: new Date(cachedAt || Date.now()).toISOString(),
      benchmark,
    });
  } catch (error) {
    return json(502, {
      error: "Unable to load benchmark series",
      message: error.message,
    });
  }
}

async function fetchBenchmarkSeries(apiKey) {
  const url = new URL(ALPHA_VANTAGE_URL);
  url.searchParams.set("function", "TIME_SERIES_DAILY_ADJUSTED");
  url.searchParams.set("symbol", BENCHMARK_SYMBOL);
  url.searchParams.set("outputsize", "full");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "IBKR-Portfolio-Dashboard/1.0" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Alpha Vantage HTTP ${response.status}: ${text.slice(0, 200)}`);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Alpha Vantage returned an invalid response.");
  }
  if (body["Error Message"]) throw new Error(body["Error Message"]);
  if (body.Note || body.Information) throw new Error(body.Note || body.Information);

  const series = body["Time Series (Daily)"] || {};
  const points = Object.entries(series)
    .map(([date, values]) => ({ date, close: number(values["4. close"]) }))
    .filter((point) => point.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-MAX_POINTS);

  return { symbol: BENCHMARK_SYMBOL, name: "Invesco QQQ Trust", nameCn: "纳斯达克100 ETF", points };
}

function number(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
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
