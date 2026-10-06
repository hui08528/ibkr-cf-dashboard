import { fetchDailyCandlesticks, isLongbridgeConfigured } from "./lib/longbridge.js";

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

let cachedBenchmark = null;
let cachedSource = null;
let cachedAt = 0;

const BENCHMARK_SYMBOL = "QQQ";
const MAX_POINTS = 750;

export async function onRequestGet({ env }) {
  const cacheTtlMs = Number(env.BENCHMARK_CACHE_SECONDS || 86400) * 1000;

  try {
    const apiKey = env.ALPHA_VANTAGE_API_KEY;
    const lbConfigured = isLongbridgeConfigured();

    if (!lbConfigured && !apiKey) {
      return json(503, {
        error: "No benchmark data source configured",
        message: "Set LONGBRIDGE_OAUTH_CLIENT_ID or ALPHA_VANTAGE_API_KEY.",
      });
    }

    if (cachedBenchmark && Date.now() - cachedAt < cacheTtlMs) {
      return json(200, {
        source: cachedSource,
        updatedAt: new Date(cachedAt).toISOString(),
        benchmark: cachedBenchmark,
        cached: true,
      });
    }

    let benchmark = null;
    let source = "alpha-vantage";

    // 长桥日K优先（前复权），失败时回退 Alpha Vantage
    if (lbConfigured) {
      const points = await fetchDailyCandlesticks(BENCHMARK_SYMBOL, MAX_POINTS);
      if (points && points.length) {
        benchmark = {
          symbol: BENCHMARK_SYMBOL,
          name: "Invesco QQQ Trust",
          nameCn: "纳斯达克100 ETF",
          points,
        };
        source = "longbridge";
      } else if (!apiKey) {
        // 无 AV key：保留长桥的失败原因，避免静默返回空数据
        return json(502, {
          error: "Longbridge benchmark unavailable",
          message: "长桥日K获取失败且未配置 Alpha Vantage 兜底。",
        });
      }
    }

    if (!benchmark && apiKey) {
      benchmark = await fetchBenchmarkSeries(apiKey);
      source = "alpha-vantage";
    }

    if (benchmark.points.length) {
      cachedBenchmark = benchmark;
      cachedSource = source;
      cachedAt = Date.now();
    }
    return json(200, {
      source,
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
