// 调仓模型 —— 聚合多账户持仓，对照目标策略桶，结合信号生成行动清单
//
// 数据来源：IBKR Flex（美股）+ OKX（现货/赚币）+ 手动补录（国内 QDII）。
// 各数据源独立容错；计算纯函数式，输出供前端板块渲染。

import { onRequestGet as portfolioHandler } from "./portfolio.js";
import { onRequestGet as marketHandler } from "./market.js";
import { onRequestGet as benchmarkHandler } from "./benchmark.js";
import { onRequestGet as fearGreedHandler } from "./fear-greed.js";
import { fetchOkxAccount } from "./lib/okx.js";
import { loadStrategy } from "./lib/strategy-store.js";

// symbol → 默认策略桶与内嵌杠杆倍数；未命中归 individual（个股/其他）
// leverage 仅用于杠杆 ETF（如 TQQQ 3x）；综合敞口 = 市值 × 该倍数
const SYMBOL_META = {
  "159509": { bucket: "nasdaq-tech" },
  QQQ: { bucket: "nasdaq100" },
  QQQM: { bucket: "nasdaq100" },
  TQQQ: { bucket: "nasdaq100", leverage: 3 },
  QLD: { bucket: "nasdaq100", leverage: 2 },
  SQQQ: { bucket: "nasdaq100", leverage: -3 },
  "159941": { bucket: "nasdaq100" },
  "513100": { bucket: "nasdaq100" },
  "159659": { bucket: "nasdaq100" },
  "513300": { bucket: "nasdaq100" },
  VOO: { bucket: "sp500" },
  SMH: { bucket: "semiconductor" },
  DRAM: { bucket: "semiconductor" },
  TSMU: { bucket: "semiconductor", leverage: 2 },
};

function metaFor(symbol) {
  return SYMBOL_META[symbol] || { bucket: "individual", leverage: 1 };
}

export async function onRequestGet({ env }) {
  const strategy = loadStrategy(env);

  // —— 并行拉取四个现有 API（复用各自缓存），单点失败不影响整体 ——
  const [portfolio, market, benchmark, fearGreed, okx] = await Promise.all([
    callJson(portfolioHandler, env),
    callJson(marketHandler, env),
    callJson(benchmarkHandler, env),
    callJson(fearGreedHandler, env),
    fetchOkxAccount(env).catch(() => null),
  ]);

  const cnyUsd = Number(strategy.params.cnyUsd);
  const holdings = [];
  const missingPrices = [];

  // 1) IBKR 证券持仓（cash 类型单独处理）
  const ibkrCash = Number(portfolio?.cash?.qty || 0);
  for (const row of portfolio?.positions || []) {
    if (row.type === "cash") continue;
    holdings.push({
      symbol: row.symbol,
      name: row.name,
      source: "ibkr",
      type: row.type,
      qty: row.qty,
      price: row.price,
      marketValue: row.marketValue,
      ...metaFor(row.symbol),
    });
  }

  // 2) 手动补录国内 QDII：人民币现价 × 汇率 → 美元
  const cnQuotes = market?.cnQuotes || [];
  for (const manual of strategy.manualPositions) {
    const quote = cnQuotes.find((item) => item.symbol === manual.symbol);
    const priceCny = Number(quote?.price);
    if (!priceCny || priceCny <= 0) {
      missingPrices.push(manual.symbol);
      continue;
    }
    holdings.push({
      symbol: manual.symbol,
      name: quote.nameCn || manual.symbol,
      source: "manual",
      type: "etf",
      qty: manual.qty,
      price: Math.round(priceCny * cnyUsd * 10000) / 10000,
      marketValue: Math.round(manual.qty * priceCny * cnyUsd * 100) / 100,
      ...metaFor(manual.symbol),
      premiumRate: quote.premiumRate ?? null,
    });
  }

  // 3) OKX 归一持仓（稳定币 bucket=cash）
  for (const row of okx?.holdings || []) {
    holdings.push({ ...row, leverage: 1 });
  }

  // —— 桶聚合 ——
  const bucketValues = new Map();
  const addBucket = (id, value) => bucketValues.set(id, (bucketValues.get(id) || 0) + value);
  for (const row of holdings) addBucket(row.bucket, row.marketValue);
  addBucket("cash", ibkrCash); // IBKR 现金（可负=融资）

  const ibkrNav = Number(portfolio?.summary?.netAssetValue) || 0;
  const manualValue = holdings.filter((row) => row.source === "manual").reduce((sum, row) => sum + row.marketValue, 0);
  const nav = round2(ibkrNav + manualValue + (okx?.nav || 0));

  const sleeves = strategy.sleeves.map((sleeve) => {
    const value = round2(bucketValues.get(sleeve.id) || 0);
    const actual = nav ? (value / nav) * 100 : 0;
    const diff = round2(actual - sleeve.target);
    const status = Math.abs(diff) <= sleeve.band ? "ok" : diff < 0 ? "under" : "over";
    return {
      ...sleeve,
      actual: round2(actual),
      diff,
      status,
      value,
      tradeToTarget: round2(((sleeve.target - actual) / 100) * nav),
    };
  });

  // —— 信号 ——
  const points = benchmark?.benchmark?.points || [];
  const drawdown = buildDrawdown(points, strategy.params);
  const trend = buildTrend(points, strategy.params);
  const leverage = buildLeverage(holdings, ibkrCash, nav);
  const signals = {
    drawdown,
    trend,
    fearGreed: buildFearGreedSignal(fearGreed, strategy.params),
    premium: buildPremiumSignals(cnQuotes),
    leverage,
    cash: buildCash(ibkrCash, okx),
    margin: buildMarginSignal(drawdown, leverage, strategy.params),
    recovery: buildRecoverySwitch(holdings, drawdown, trend, strategy.params),
    top: buildTopSignal(points, cnQuotes, strategy.params),
  };

  const actions = buildActions(sleeves, signals, strategy.params, holdings);

  return json(200, {
    updatedAt: new Date().toISOString(),
    nav,
    cnyUsd,
    baseCurrency: "USD",
    sources: [
      { source: "ibkr", nav: ibkrNav, available: Boolean(portfolio) },
      { source: "okx", nav: okx?.nav || 0, available: Boolean(okx) },
      { source: "manual", nav: round2(manualValue), available: manualValue > 0 },
    ],
    sleeves,
    signals,
    actions,
    holdings: holdings.map(({ accounts, ...row }) => ({ ...row, accounts: accounts || [] })),
    missingPrices,
  });
}

// 子调用超时兜底：容错只 catch 报错，不处理"永不返回"。任一数据源挂起时按缺失
// 处理（返回 null），避免拖死整个 /api/rebalance。冷启动 IBKR 可能 10s+，给到 15s。
const SUB_CALL_TIMEOUT_MS = 15_000;
async function callJson(handler, env) {
  try {
    let timer;
    const response = await Promise.race([
      handler({ env, request: { url: "http://localhost/" } }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("sub-call timeout")), SUB_CALL_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    return await response.json();
  } catch {
    return null;
  }
}

// —— 信号构造 ——

function buildDrawdown(points, params) {
  if (!points.length) return { available: false };
  let peak = 0;
  for (const point of points) peak = Math.max(peak, Number(point.close));
  const last = Number(points.at(-1).close);
  const dd = peak ? (last / peak - 1) * 100 : 0;
  const level = dd <= params.drawdownBear ? "bear" : dd <= params.drawdownNormal ? "normal" : "none";
  return { available: true, dd: round2(dd), last, peak, level };
}

function buildTrend(points, params) {
  if (points.length < 2) return { available: false };
  const days = Math.min(Number(params.smaTrendDays), points.length);
  const window = points.slice(-days);
  const sma = window.reduce((sum, point) => sum + Number(point.close), 0) / window.length;
  const last = Number(points.at(-1).close);
  return { available: true, sma: round2(sma), last, direction: last >= sma ? "up" : "down" };
}

function buildFearGreedSignal(fearGreed, params) {
  const score = Number(fearGreed?.index?.score);
  if (!Number.isFinite(score)) return { available: false };
  const zone =
    score <= params.fgExtremeFear ? "xfear" : score >= params.fgExtremeGreed ? "xgreed" : "normal";
  return {
    available: true,
    score,
    rating: fearGreed.index.ratingCn || fearGreed.index.rating,
    zone,
  };
}

function buildPremiumSignals(cnQuotes) {
  const rows = cnQuotes
    .filter((quote) => quote.premiumRate !== null && quote.premiumRate !== undefined)
    .map((quote) => ({
      symbol: quote.symbol,
      name: quote.nameCn || quote.symbol,
      group: quote.premiumGroup || "",
      premiumRate: Number(quote.premiumRate),
      iopv: quote.iopv ?? null,
      navDate: quote.navDate || "",
    }));
  const groupMin = new Map();
  for (const row of rows) {
    if (!row.group) continue;
    groupMin.set(row.group, Math.min(groupMin.get(row.group) ?? Infinity, row.premiumRate));
  }
  return rows.map((row) => ({ ...row, groupMin: groupMin.get(row.group) ?? row.premiumRate }));
}

function buildLeverage(holdings, ibkrCash, nav) {
  if (!nav) return { available: false };
  // 证券市值 = 所有非现金桶持仓（IBKR 证券 + 手动 + OKX 非稳定币）
  const securities = holdings
    .filter((row) => row.bucket !== "cash")
    .reduce((sum, row) => sum + row.marketValue, 0);
  // 综合敞口：融资杠杆 + 杠杆 ETF 内嵌倍数（反向 ETF 按绝对值计）
  const grossExposure = holdings
    .filter((row) => row.bucket !== "cash")
    .reduce((sum, row) => sum + row.marketValue * Math.abs(row.leverage || 1), 0);
  const marginLeverage = securities / nav;
  const effectiveLeverage = grossExposure / nav;
  return {
    available: true,
    securities: round2(securities),
    grossExposure: round2(grossExposure),
    marginLeverage: round2(marginLeverage),
    leverage: round2(effectiveLeverage), // 综合杠杆（行动判断口径）
    wipeoutDrop: effectiveLeverage > 0 ? round2((1 / effectiveLeverage) * 100) : null,
  };
}

function buildCash(ibkrCash, okx) {
  const stables = (okx?.holdings || [])
    .filter((row) => row.bucket === "cash")
    .reduce((sum, row) => sum + row.marketValue, 0);
  return {
    available: true,
    ibkrCash: round2(ibkrCash),
    debt: round2(Math.max(0, -ibkrCash)),
    availableCash: round2(Math.max(0, ibkrCash) + stables),
    stables: round2(stables),
  };
}

// 回调≥7% 启用融资信号（PDF 回撤篇）：指数自峰值回撤超阈值、未演变成系统性危机、
// 且当前杠杆偏低有加杠杆空间时 ready。定性部分（"利空变量不可持续"）留给行动文案提示。
const MARGIN_HEADROOM_MAX = 1.5; // 启用融资前提：综合杠杆低于该值（避免高位加杠杆）
export function buildMarginSignal(drawdown, leverage, params) {
  if (!drawdown.available) return { available: false };
  const dd = drawdown.dd;
  const lev = Number(leverage?.leverage) || 0;
  const ready =
    dd <= params.drawdownLeverage && // 回调已超阈值（回撤 ≥7%）
    dd > params.drawdownBear && // 尚未演变成系统性危机
    lev < MARGIN_HEADROOM_MAX; // 当前杠杆低，有加杠杆空间
  return { available: true, ready, dd: round2(dd), leverage: round2(lev) };
}

// 熊市低位切换杠杆 ETF 收益修复（PDF 回撤篇）：熊市（深度回撤）或熊转牛拐点
// （回调超阈值后趋势转上）时，把持有的 QQQ/QQQM 切换为 QLD/TQQQ，利用杠杆ETF
// 在修复阶段超额上涨抵消先前回撤损失。需已持有非杠杆纳指ETF 且未持有杠杆ETF。
export function buildRecoverySwitch(holdings, drawdown, trend, params) {
  if (!drawdown.available) return { available: false };
  const qqq = holdings.filter((row) => row.source === "ibkr" && (row.symbol === "QQQ" || row.symbol === "QQQM"));
  if (!qqq.length) return { available: false, eligible: false };
  const hasLeverageEtf = holdings.some((row) => row.source === "ibkr" && ["QLD", "TQQQ"].includes(row.symbol));
  const dd = drawdown.dd;
  const deepBear = dd <= params.drawdownBear; // 熊市/系统性危机
  const turning = dd <= params.drawdownLeverage && trend?.direction === "up"; // 大幅回调后趋势转上（熊转牛拐点）
  const eligible = (deepBear || turning) && !hasLeverageEtf;
  const target = dd <= -30 ? "TQQQ" : "QLD"; // 极端回撤用3x，一般熊市用2x
  const amount = qqq.reduce((sum, row) => sum + Number(row.marketValue || 0), 0);
  return { available: true, eligible, dd: round2(dd), deepBear, turning, target, amount: round2(amount) };
}

// 顶部信号（PDF 顶部底部信号体系·可选条件）：场内纳指100 溢价≥8%，或指数
// 加速上涨（近 N 日日均涨幅 ≥1%）。两个可量化因子任一命中即触发；"叙事疯狂"等
// 定性因子暂不量化。
export function buildTopSignal(points, cnQuotes, params) {
  const factors = [];
  let fastRally = false;
  if (points.length >= params.rallyDays + 1) {
    const window = points.slice(-(params.rallyDays + 1));
    let total = 0;
    for (let i = 1; i < window.length; i++) {
      const prev = Number(window[i - 1].close);
      const cur = Number(window[i].close);
      if (prev > 0) total += (cur / prev - 1) * 100;
    }
    const avgDaily = total / params.rallyDays;
    if (avgDaily >= params.rallyDailyGain) {
      fastRally = true;
      factors.push(`近${params.rallyDays}日日均涨幅 ${avgDaily.toFixed(1)}%`);
    }
  }
  let topPremium = null;
  const ndx = (cnQuotes || []).filter((q) => q.premiumGroup === "NDX" && Number.isFinite(Number(q.premiumRate)));
  if (ndx.length) {
    topPremium = Math.max(...ndx.map((q) => Number(q.premiumRate)));
    if (topPremium >= params.topPremium) factors.push(`场内纳指100溢价 ${topPremium.toFixed(1)}%`);
  }
  return { available: true, triggered: factors.length > 0, fastRally, topPremium, factors };
}

// —— 行动清单 ——

function buildActions(sleeves, signals, params, holdings) {
  const actions = [];
  const heldManual = new Set(
    holdings.filter((row) => row.source === "manual").map((row) => row.symbol)
  );
  const push = (priority, type, title, detail = "", amount = null) =>
    actions.push({ priority, type, title, detail, amount });

  for (const sleeve of sleeves) {
    if (sleeve.status === "over") {
      push(
        70 + Math.min(20, Math.abs(sleeve.diff)),
        "reduce",
        `减仓 ${sleeve.name}`,
        `超配 ${Math.abs(sleeve.diff).toFixed(1)} 个百分点，建议卖出约 \$${formatK(Math.abs(sleeve.tradeToTarget))}`,
        sleeve.tradeToTarget
      );
    } else if (sleeve.status === "under") {
      push(
        60 + Math.min(20, Math.abs(sleeve.diff)),
        "add",
        `加仓 ${sleeve.name}`,
        `低配 ${Math.abs(sleeve.diff).toFixed(1)} 个百分点，建议买入约 \$${formatK(sleeve.tradeToTarget)}`,
        sleeve.tradeToTarget
      );
    }
  }

  // 杠杆纪律（综合杠杆 = 融资 + 杠杆 ETF 内嵌敞口）
  const lev = signals.leverage;
  if (lev.available) {
    if (lev.leverage >= params.leverageDanger) {
      push(
        95,
        "leverage",
        `综合杠杆 ${lev.leverage} 倍，降到 2 倍以内`,
        `融资杠杆 ${lev.marginLeverage} 倍；估算再跌 ${lev.wipeoutDrop}% 净资产接近归零`
      );
    } else if (lev.leverage >= params.leverageWarn) {
      push(
        80,
        "leverage",
        `综合杠杆 ${lev.leverage} 倍，偏高`,
        `融资杠杆 ${lev.marginLeverage} 倍；估算再跌 ${lev.wipeoutDrop}% 净资产接近归零`
      );
    }
  }

  // 熊市低位切换杠杆 ETF 做收益修复（PDF：熊市或熊转牛拐点，把 QQQ 切换为 QLD/TQQQ）
  const recovery = signals.recovery;
  if (recovery.available && recovery.eligible && recovery.amount > 0) {
    const targetLabel = recovery.target === "TQQQ" ? "TQQQ（3x）" : "QLD（2x）";
    push(
      68,
      "switch",
      `熊市低位：QQQ 切换 ${recovery.target} 做收益修复`,
      `指数回撤 ${recovery.dd}%，将 QQQ/QQQM（约 \$${formatK(recovery.amount)}）切换为 ${targetLabel}，利用杠杆ETF修复回撤；须能扛 20% 回撤、资金 2 年内不动`,
      recovery.amount
    );
  }

  // 同类 QDII 溢价切换：标的溢价昂贵且组内有明显更低者
  for (const row of signals.premium) {
    if (heldManual.has(row.symbol) && row.premiumRate > params.premiumFair && row.premiumRate - row.groupMin >= 3) {
      push(
        55,
        "switch",
        `${row.symbol} 溢价切换`,
        `${row.symbol} 溢价 ${row.premiumRate}%，同组最低 ${row.groupMin}%，考虑换到同类低溢价标的`
      );
    }
  }

  // 回调≥7% 且利空不可持续 → 可启用融资（PDF 回撤篇：指数回调超 7% 后适当启用融资）
  const margin = signals.margin;
  if (margin.available && margin.ready) {
    push(
      52,
      "margin",
      `回调 ${margin.dd}%：可启用融资分批加仓`,
      `指数自峰值回撤已超阈值，当前综合杠杆 ${margin.leverage}x、尚未到危险区。若判断利空变量不可持续，可启用融资（利率<6%、期限≥2年、能扛20%回撤）逐步加仓`
    );
  }

  // 恐慌贪婪 + 现金
  const fg = signals.fearGreed;
  const cash = signals.cash;
  if (fg.available) {
    if (fg.zone === "xfear" && cash.availableCash > 0) {
      push(50, "opportunity", "极度恐惧，分批加仓", `可动用现金约 \$${formatK(cash.availableCash)}`);
    } else if (fg.zone === "xgreed" && sleeves.some((sleeve) => sleeve.status === "over")) {
      push(45, "trim", "极度贪婪且有超配桶", "考虑止盈");
    }
  }

  // 顶部信号：场内溢价≥8% / 加速上涨日均≥1%（PDF 顶部底部信号体系）
  const top = signals.top;
  if (top.available && top.triggered && holdings.length > 0) {
    push(
      42,
      "trim",
      "顶部信号：考虑分批止盈/降杠杆",
      `触发：${top.factors.join("、")}。若持仓已有盈利或杠杆偏高，考虑分批止盈、降低杠杆，避免高位追入`
    );
  }

  // 回撤级别提示
  if (signals.drawdown.available && signals.drawdown.level === "bear") {
    push(30, "risk", "处于熊市回撤区", "不追高，等利空出尽再分批布局");
  }

  return actions.sort((a, b) => b.priority - a.priority);
}

function formatK(value) {
  const abs = Math.abs(value);
  return abs >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(0);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    },
  });
}
