// CNN Fear & Greed Index —— 恐慌与贪婪指数（0-100，7 个细分指标等权平均）
// 数据源：CNN Business 公开接口，无需 API Key，但需要浏览器 UA + 指定 Referer。
// 该指数每天收盘后更新一次，返回体约 170KB，因此做 1 小时内存缓存并只回传精简字段。
const CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";

const RATING_CN = {
  "extreme fear": "极度恐惧",
  fear: "恐惧",
  neutral: "中性",
  greed: "贪婪",
  "extreme greed": "极度贪婪",
};

// 与主指数口径一致的 7 项细分指标（动量采用 S&P 500 相对 125 日均线）
const COMPONENTS = [
  { key: "market_momentum_sp125", name: "股票价格动量", nameEn: "S&P 500 vs 125日均线" },
  { key: "stock_price_strength", name: "股票价格强度", nameEn: "NYSE 52周高低点" },
  { key: "stock_price_breadth", name: "股票价格广度", nameEn: "上涨/下跌成交量" },
  { key: "put_call_options", name: "看跌/看涨期权比", nameEn: "Put/Call Ratio" },
  { key: "market_volatility_vix", name: "市场波动率 VIX", nameEn: "CBOE Volatility" },
  { key: "junk_bond_demand", name: "垃圾债券需求", nameEn: "High-yield 利差" },
  { key: "safe_haven_demand", name: "避险资产需求", nameEn: "美债 vs 股票" },
];

let cached = null;
let cachedAt = 0;

export async function onRequestGet({ env }) {
  const cacheTtlMs = Number(env.FEAR_GREED_CACHE_SECONDS || 3600) * 1000;

  try {
    if (cached && Date.now() - cachedAt < cacheTtlMs) {
      return json(200, { ...cached, cached: true });
    }

    const response = await fetch(CNN_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Referer: "https://www.cnn.com/partners/fear-and-greed",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return json(502, {
        error: "CNN API unavailable",
        message: `CNN Fear & Greed API responded HTTP ${response.status}`,
      });
    }

    const body = await response.json();
    const payload = buildPayload(body);
    cached = payload;
    cachedAt = Date.now();
    return json(200, { ...payload, cached: false });
  } catch (error) {
    return json(502, {
      error: "Unable to load fear & greed index",
      message: error.message,
    });
  }
}

function buildPayload(body) {
  const fg = body.fear_and_greed || {};
  const components = COMPONENTS.map(({ key, name, nameEn }) => {
    const node = body[key] || {};
    const score = round1(node.score);
    return {
      key,
      name,
      nameEn,
      score,
      rating: node.rating || "",
      ratingCn: RATING_CN[node.rating] || node.rating || "",
    };
  }).filter((item) => item.score !== null);

  return {
    source: "cnn",
    updatedAt: fg.timestamp ? new Date(fg.timestamp).toISOString() : "",
    index: {
      score: round1(fg.score),
      rating: fg.rating || "",
      ratingCn: RATING_CN[fg.rating] || fg.rating || "",
      previousClose: round1(fg.previous_close),
      previous1Week: round1(fg.previous_1_week),
      previous1Month: round1(fg.previous_1_month),
      previous1Year: round1(fg.previous_1_year),
    },
    components,
  };
}

function round1(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : null;
}

function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=600",
    },
  });
}
