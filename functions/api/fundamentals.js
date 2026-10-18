const FMP_BASE = "https://financialmodelingprep.com/stable";
const cache = new Map();

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
  if (!/^[A-Z.]{1,10}$/.test(symbol)) return json(400, { error: "Invalid symbol" });
  if (!env.FMP_API_KEY) return json(503, { error: "FMP_API_KEY is not configured" });

  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return json(200, cached.data);

  try {
    const [ratios, income, treasury, policyRate] = await Promise.all([
      fmp("ratios-ttm", { symbol }, env.FMP_API_KEY),
      fmp("income-statement", { symbol, period: "quarter", limit: "5" }, env.FMP_API_KEY),
      fmp("treasury-rates", { limit: "90" }, env.FMP_API_KEY),
      fmp("economic-indicators", { name: "federalFunds", limit: "12" }, env.FMP_API_KEY),
    ]);
    const row = Array.isArray(ratios) ? ratios[0] : null;
    if (!row) return json(404, { error: "No valuation data available" });
    const latest = Array.isArray(income) ? income[0] : null;
    const yearAgo = Array.isArray(income) ? income.find((item) => item.fiscalYear === Number(latest?.fiscalYear) - 1 && item.period === latest?.period) || income[4] : null;
    const growth = (current, previous) => Number.isFinite(current) && Number.isFinite(previous) && previous !== 0 ? ((current / previous) - 1) * 100 : null;
    const treasurySeries = Array.isArray(treasury) ? treasury : [];
    const policySeries = Array.isArray(policyRate) ? policyRate : [];
    const treasuryLatest = treasurySeries[0] || null;
    const treasuryOld = treasurySeries.at(-1) || null;
    const policyLatest = policySeries[0] || null;
    const policyOld = policySeries.at(-1) || null;
    const data = {
      symbol,
      pe: row.priceToEarningsRatioTTM ?? null,
      forwardPe: null,
      peg: row.priceToEarningsGrowthRatioTTM ?? null,
      forwardPeg: row.forwardPriceToEarningsGrowthRatioTTM ?? null,
      revenueGrowthYoY: growth(latest?.revenue, yearAgo?.revenue),
      epsGrowthYoY: growth(latest?.epsDiluted ?? latest?.eps, yearAgo?.epsDiluted ?? yearAgo?.eps),
      incomePeriod: latest ? `${latest.fiscalYear} ${latest.period}` : null,
      incomeDate: latest?.date ?? null,
      federalFundsRate: policyLatest?.value ?? null,
      federalFundsDate: policyLatest?.date ?? null,
      federalFundsChange: policyLatest && policyOld ? Number(policyLatest.value) - Number(policyOld.value) : null,
      federalFundsStartDate: policyOld?.date ?? null,
      treasury10Year: treasuryLatest?.year10 ?? null,
      treasuryDate: treasuryLatest?.date ?? null,
      treasury10YearChange: treasuryLatest && treasuryOld ? Number(treasuryLatest.year10) - Number(treasuryOld.year10) : null,
      treasuryStartDate: treasuryOld?.date ?? null,
      source: "Financial Modeling Prep",
      updatedAt: new Date().toISOString(),
    };
    cache.set(symbol, { at: Date.now(), data });
    return json(200, data);
  } catch {
    return json(502, { error: "Unable to load valuation data" });
  }
}

async function fmp(path, params, apiKey) {
  const endpoint = new URL(`${FMP_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, value);
  endpoint.searchParams.set("apikey", apiKey);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`FMP ${path} returned ${response.status}`);
  return response.json();
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
