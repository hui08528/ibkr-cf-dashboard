const demoData = {
  source: "demo",
  account: "U****1234",
  baseCurrency: "USD",
  positions: [
    { symbol: "AAPL", name: "Apple Inc.", type: "stock", qty: 150, cost: 165.30, price: 228.45, sector: "科技", region: "US" },
    { symbol: "MSFT", name: "Microsoft Corp.", type: "stock", qty: 80, cost: 320.00, price: 415.20, sector: "科技", region: "US" },
    { symbol: "NVDA", name: "NVIDIA Corp.", type: "stock", qty: 60, cost: 280.50, price: 132.80, sector: "科技", region: "US" },
    { symbol: "GOOGL", name: "Alphabet Inc.", type: "stock", qty: 45, cost: 125.00, price: 158.30, sector: "科技", region: "US" },
    { symbol: "AMZN", name: "Amazon.com Inc.", type: "stock", qty: 70, cost: 135.20, price: 192.75, sector: "消费", region: "US" },
    { symbol: "BRK.B", name: "Berkshire Hathaway", type: "stock", qty: 50, cost: 325.00, price: 462.10, sector: "金融", region: "US" },
    { symbol: "JPM", name: "JPMorgan Chase", type: "stock", qty: 65, cost: 138.50, price: 210.40, sector: "金融", region: "US" },
    { symbol: "VOO", name: "Vanguard S&P 500", type: "etf", qty: 100, cost: 380.00, price: 542.30, sector: "指数", region: "US" },
    { symbol: "QQQ", name: "Invesco QQQ Trust", type: "etf", qty: 80, cost: 350.00, price: 485.60, sector: "指数", region: "US" },
    { symbol: "TSLA", name: "Tesla Inc.", type: "stock", qty: 40, cost: 250.00, price: 215.80, sector: "汽车", region: "US" },
    { symbol: "BABA", name: "Alibaba Group", type: "stock", qty: 100, cost: 180.00, price: 82.50, sector: "消费", region: "CN" },
    { symbol: "TCEHY", name: "Tencent Holdings", type: "stock", qty: 200, cost: 45.00, price: 42.80, sector: "科技", region: "CN" },
  ],
  cash: { symbol: "USD", name: "美元现金", type: "cash", qty: 12500, cost: 1, price: 1, sector: "现金", region: "US" },
  transactions: [
    { date: "2026-09-28", type: "buy", symbol: "AAPL", name: "Apple Inc.", qty: 20, price: 225.40, amount: 4508.00 },
    { date: "2026-09-27", type: "sell", symbol: "TSLA", name: "Tesla Inc.", qty: 10, price: 218.20, amount: 2182.00 },
    { date: "2026-09-25", type: "dividend", symbol: "VOO", name: "Vanguard S&P 500", qty: 100, price: 1.52, amount: 152.00 },
    { date: "2026-09-24", type: "buy", symbol: "NVDA", name: "NVIDIA Corp.", qty: 15, price: 128.90, amount: 1933.50 },
    { date: "2026-09-22", type: "buy", symbol: "MSFT", name: "Microsoft Corp.", qty: 10, price: 410.15, amount: 4101.50 },
    { date: "2026-09-20", type: "fee", symbol: "-", name: "账户管理费", qty: 1, price: 10.00, amount: -10.00 },
    { date: "2026-09-18", type: "sell", symbol: "BABA", name: "Alibaba Group", qty: 30, price: 85.20, amount: 2556.00 },
    { date: "2026-09-15", type: "dividend", symbol: "JPM", name: "JPMorgan Chase", qty: 65, price: 1.25, amount: 81.25 },
    { date: "2026-09-12", type: "buy", symbol: "QQQ", name: "Invesco QQQ", qty: 20, price: 480.50, amount: 9610.00 },
    { date: "2026-09-10", type: "buy", symbol: "BRK.B", name: "Berkshire Hathaway", qty: 15, price: 455.00, amount: 6825.00 },
  ],
  navSeries: [
    { date: "2025-10-31", value: 210000 },
    { date: "2025-11-28", value: 214500 },
    { date: "2025-12-31", value: 221000 },
    { date: "2026-01-30", value: 218500 },
    { date: "2026-02-27", value: 226800 },
    { date: "2026-03-31", value: 232400 },
    { date: "2026-04-30", value: 229900 },
    { date: "2026-05-29", value: 238500 },
    { date: "2026-06-30", value: 242300 },
    { date: "2026-07-31", value: 245800 },
    { date: "2026-08-31", value: 247900 },
    { date: "2026-09-30", value: 251000 },
  ],
};

let portfolio = demoData;
let positions = [];
let cash = demoData.cash;
let txs = [];
let totals = {};
let earningsBySymbol = {};
let earningsStatus = "idle";
let popularEarningsBySymbol = {};
let popularEarningsStatus = "idle";
let marketQuotes = [];
let cnMarketQuotes = [];
let marketStatus = "idle";
let fearGreed = null;
let fearGreedStatus = "idle";
let benchmarkData = null;
let benchmarkStatus = "idle";
let monthlyReturnMode = "rate"; // 月度收益网格展示模式："rate"=收益率 / "amount"=收益额
let perfChart;
let sectorChart;
let assetClassChart;
let topHoldingsChart;
let benchmarkChart;
let dividendChart;

const navItems = document.querySelectorAll(".nav-item");
const sections = document.querySelectorAll(".section");
const pageTitle = document.getElementById("page-title");
const dataStatus = document.getElementById("data-status");
const accountId = document.querySelector(".account-id");
const titles = {
  overview: "投资组合概览",
  positions: "投资组合",
  transactions: "交易记录",
  analytics: "收益分析",
  insights: "市场洞察",
  framework: "投资框架",
  guide: "部署指南",
};

const popularCompanies = [
  { symbol: "AAPL", name: "Apple", nameCn: "苹果" },
  { symbol: "MSFT", name: "Microsoft", nameCn: "微软" },
  { symbol: "NVDA", name: "NVIDIA", nameCn: "英伟达" },
  { symbol: "GOOG", name: "Alphabet", nameCn: "谷歌母公司" },
  { symbol: "AMZN", name: "Amazon", nameCn: "亚马逊" },
  { symbol: "META", name: "Meta Platforms", nameCn: "Meta" },
  { symbol: "TSLA", name: "Tesla", nameCn: "特斯拉" },
  { symbol: "AVGO", name: "Broadcom", nameCn: "博通" },
  { symbol: "TSM", name: "Taiwan Semiconductor", nameCn: "台积电" },
  { symbol: "AMD", name: "AMD", nameCn: "超威半导体" },
  { symbol: "MU", name: "Micron Technology", nameCn: "美光" },
  { symbol: "NFLX", name: "Netflix", nameCn: "奈飞" },
  { symbol: "JPM", name: "JPMorgan Chase", nameCn: "摩根大通" },
  { symbol: "LLY", name: "Eli Lilly", nameCn: "礼来" },
];

const savedTheme = localStorage.getItem("theme");
if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);

init();

async function init() {
  wireNavigation();
  wireControls();
  wireFrameworkTopics();
  applyPortfolio(demoData, "正在连接 IBKR...");

  try {
    const liveData = await loadPortfolio();
    applyPortfolio(liveData, liveData.source === "ibkr-flex" ? "IBKR Flex 已同步" : "Demo Data");
  } catch (error) {
    console.warn(error);
    applyPortfolio(demoData, "未配置 IBKR，显示 Demo Data");
  }
}

function wireFrameworkTopics() {
  const modal = document.getElementById("framework-modal");
  const modalTitle = document.getElementById("framework-modal-title");
  const modalBody = document.getElementById("framework-modal-body");
  const closeModal = () => {
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
  };
  document.querySelectorAll("[data-framework-modal-close]").forEach((element) => element.addEventListener("click", closeModal));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && !modal.hidden) closeModal();
  });
  document.querySelectorAll("[data-framework-topic]").forEach((topic) => {
    const toggle = topic.querySelector(".framework-topic-toggle");
    const detail = topic.querySelector(".framework-detail");
    if (!toggle || !detail || !modal || !modalTitle || !modalBody) return;
    const openModal = () => {
      modalTitle.textContent = topic.querySelector("h3")?.textContent || "投资框架详情";
      modalBody.innerHTML = detail.innerHTML;
      modal.hidden = false;
      document.body.classList.add("modal-open");
    };
    toggle.addEventListener("click", openModal);
    topic.addEventListener("click", (event) => {
      if (event.target.closest(".framework-topic-toggle") || event.target.closest(".framework-detail")) return;
      openModal();
    });
  });
}

async function loadPortfolio() {
  const response = await fetch("/api/portfolio", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Portfolio API failed with ${response.status}`);
  }
  return response.json();
}

async function loadEarningsForPositions() {
  const symbols = uniqueEarningsSymbols(positions);
  if (symbols.length === 0) {
    earningsBySymbol = {};
    earningsStatus = "empty";
    renderPositionsTable(currentPositionFilter(), currentPositionSearch());
    return;
  }

  earningsStatus = "loading";
  renderPositionsTable(currentPositionFilter(), currentPositionSearch());

  try {
    const response = await fetch(`/api/earnings?symbols=${encodeURIComponent(symbols.join(","))}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `Earnings API failed with ${response.status}`);
    }
    const body = await response.json();
    earningsBySymbol = body.earnings || {};
    earningsStatus = "ready";
  } catch (error) {
    console.warn(error);
    earningsBySymbol = {};
    earningsStatus = "unavailable";
  }

  renderPositionsTable(currentPositionFilter(), currentPositionSearch());
}

async function loadPopularEarnings(forceRefresh = false) {
  popularEarningsStatus = "loading";
  renderInsightsTable();

  try {
    const symbols = popularCompanies.map((company) => company.symbol).join(",");
    const refreshParam = forceRefresh ? "&refresh=1" : "";
    const response = await fetch(`/api/earnings?symbols=${encodeURIComponent(symbols)}${refreshParam}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `Earnings API failed with ${response.status}`);
    }
    const body = await response.json();
    popularEarningsBySymbol = body.earnings || {};
    popularEarningsStatus = "ready";
  } catch (error) {
    console.warn(error);
    popularEarningsBySymbol = {};
    popularEarningsStatus = "unavailable";
  }

  renderInsightsTable();
}

function renderInsights() {
  renderFearGreed();
  renderInsightsTable();
  renderMarketSnapshot();
  if (popularEarningsStatus === "idle" || popularEarningsStatus === "unavailable") {
    loadPopularEarnings();
  }
  if (marketStatus === "idle" || marketStatus === "unavailable") {
    loadMarketSnapshot();
  }
  if (fearGreedStatus === "idle" || fearGreedStatus === "unavailable") {
    loadFearGreed();
  }
}

async function loadFearGreed() {
  fearGreedStatus = "loading";
  renderFearGreed();

  try {
    const response = await fetch("/api/fear-greed", { headers: { Accept: "application/json" } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `Fear & Greed API failed with ${response.status}`);
    }
    const body = await response.json();
    fearGreed = body;
    fearGreedStatus = "ready";
  } catch (error) {
    console.warn(error);
    fearGreed = null;
    fearGreedStatus = "unavailable";
  }

  renderFearGreed();
}

function renderFearGreed() {
  const body = document.getElementById("fear-greed-body");
  const status = document.getElementById("fear-greed-status");
  if (!body) return;

  if (status) {
    const statusText = {
      idle: "",
      loading: "正在加载指数...",
      ready: "CNN 已更新",
      unavailable: "指数暂不可用",
    };
    if (fearGreedStatus === "ready" && fearGreed?.updatedAt) {
      const updated = new Date(fearGreed.updatedAt);
      if (!Number.isNaN(updated.getTime())) {
        statusText.ready = `更新于 ${updated.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
      }
    }
    status.textContent = statusText[fearGreedStatus] || "";
  }

  if (fearGreedStatus === "loading") {
    body.innerHTML = `<div class="empty-cell">正在加载恐慌与贪婪指数...</div>`;
    return;
  }
  if (fearGreedStatus === "unavailable" || !fearGreed?.index) {
    body.innerHTML = `<div class="empty-cell">恐慌与贪婪指数暂不可用，请稍后刷新。</div>`;
    return;
  }

  const idx = fearGreed.index;
  const components = Array.isArray(fearGreed.components) ? fearGreed.components : [];
  const score = clampScore(idx.score);
  const gauge = buildFearGreedGauge(score);
  const trend = buildFearGreedTrend(score, idx);
  const rows = components.map((item) => buildFearGreedComponent(item)).join("");

  body.innerHTML = `
    <div class="fg-layout">
      <div class="fg-gauge-wrap">${gauge}</div>
      <div class="fg-main">
        <div class="fg-score-row">
          <span class="fg-score">${escapeHtml(fearGreedScoreLabel(idx.score))}</span>
          <span class="fg-rating fg-zone-${zoneKey(idx.rating)}">${escapeHtml(idx.ratingCn || idx.rating || "—")}</span>
        </div>
        <div class="fg-trend">${trend}</div>
        <div class="fg-scale">0 极度恐惧 · 50 中性 · 100 极度贪婪</div>
      </div>
    </div>
    <div class="fg-components">
      <div class="fg-components-head">
        <h4>7 项细分指标（等权平均）</h4>
        <span class="muted-note">每项指标按相对历史均值的偏离标准化到 0–100</span>
      </div>
      <div class="fg-components-list">${rows || `<div class="empty-cell">暂无细分指标</div>`}</div>
    </div>
  `;
}

// —— 恐慌与贪婪仪表盘：半圆 0-100，左恐惧右贪婪，针指向当前分数 ——
function buildFearGreedGauge(score) {
  const cx = 120;
  const cy = 126;
  const radius = 92;
  const band = 22;
  const zones = [
    { from: 0, to: 25, cls: "fg-zone-xfear" },
    { from: 25, to: 45, cls: "fg-zone-fear" },
    { from: 45, to: 55, cls: "fg-zone-neutral" },
    { from: 55, to: 75, cls: "fg-zone-greed" },
    { from: 75, to: 100, cls: "fg-zone-xgreed" },
  ];
  const paths = zones
    .map((zone) => `<path d="${fgArcPath(cx, cy, radius, zone.from, zone.to)}" class="${zone.cls}" />`)
    .join("");
  const needleDeg = (score - 50) * 1.8;
  const needleLength = radius - band / 2 - 8;
  return `
    <svg viewBox="0 0 240 150" role="img" aria-label="恐慌与贪婪指数 ${fearGreedScoreLabel(score)}">
      ${paths}
      <g class="fg-needle" transform="rotate(${needleDeg} ${cx} ${cy})">
        <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - needleLength}" />
      </g>
      <circle cx="${cx}" cy="${cy}" r="15" class="fg-hub" />
    </svg>
  `;
}

function fgArcPath(cx, cy, radius, fromScore, toScore) {
  const start = fgPointOnArc(cx, cy, radius, fromScore);
  const end = fgPointOnArc(cx, cy, radius, toScore);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${end.x} ${end.y}`;
}

function fgPointOnArc(cx, cy, radius, score) {
  const radians = ((180 - score * 1.8) * Math.PI) / 180;
  return {
    x: +(cx + radius * Math.cos(radians)).toFixed(2),
    y: +(cy - radius * Math.sin(radians)).toFixed(2),
  };
}

function buildFearGreedTrend(current, idx) {
  const refs = [
    { label: "前日", value: idx.previousClose },
    { label: "1周", value: idx.previous1Week },
    { label: "1月", value: idx.previous1Month },
    { label: "1年", value: idx.previous1Year },
  ];
  return refs
    .map((ref) => {
      const refScore = clampScore(ref.value);
      const delta = current - refScore;
      const arrow = delta >= 0 ? "▲" : "▼";
      const cls = delta >= 0 ? "fg-up" : "fg-down";
      return `<span class="${cls}" title="${escapeHtml(ref.label)}相对当前">${escapeHtml(ref.label)} ${fearGreedScoreLabel(ref.value)} ${arrow}</span>`;
    })
    .join("");
}

function buildFearGreedComponent(item) {
  const zone = zoneKey(item.rating);
  const width = clampScore(item.score);
  return `
    <div class="fg-component">
      <div class="fg-comp-head">
        <span class="fg-comp-name">${escapeHtml(item.name)}</span>
        <span class="fg-comp-rating fg-zone-${zone}">${escapeHtml(item.ratingCn || item.rating || "—")}</span>
        <span class="fg-comp-score">${fearGreedScoreLabel(item.score)}</span>
      </div>
      <div class="fg-comp-track"><div class="fg-comp-fill fg-zone-${zone}" style="width: ${width}%"></div></div>
    </div>
  `;
}

function zoneKey(rating) {
  const map = { "extreme fear": "xfear", fear: "fear", neutral: "neutral", greed: "greed", "extreme greed": "xgreed" };
  return map[String(rating || "").toLowerCase()] || "neutral";
}

function clampScore(value) {
  const num = number(value);
  return Math.min(Math.max(num, 0), 100);
}

function fearGreedScoreLabel(value) {
  const num = number(value);
  return Number.isFinite(num) ? num.toFixed(1) : "—";
}

function renderInsightsTable() {
  const tbody = document.getElementById("popular-earnings-body");
  if (!tbody) return;

  if (popularEarningsStatus === "loading") {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">正在加载财报日历...</td></tr>`;
    return;
  }

  if (popularEarningsStatus === "unavailable") {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">财报日历暂不可用，请检查 Alpha Vantage 配置。</td></tr>`;
    return;
  }

  const rows = [...popularCompanies].sort((a, b) => {
    const aDate = popularEarningsBySymbol[a.symbol]?.reportDate || "";
    const bDate = popularEarningsBySymbol[b.symbol]?.reportDate || "";
    if (!aDate && !bDate) return a.symbol.localeCompare(b.symbol);
    if (!aDate) return 1;
    if (!bDate) return -1;
    return aDate.localeCompare(bDate);
  });

  tbody.innerHTML = rows.map((company) => {
    const item = popularEarningsBySymbol[company.symbol] || {};
    const reportDate = item.reportDate ? formatDateLabel(item.reportDate) : "暂无日期";
    const fiscalDate = item.fiscalDateEnding ? formatDateLabel(item.fiscalDateEnding) : "-";

    return `
      <tr>
        <td class="symbol-cell">${escapeHtml(company.symbol)}</td>
        <td>
          <div class="company-name">${escapeHtml(company.nameCn)}</div>
          <div class="company-subname">${escapeHtml(company.name)}</div>
        </td>
        <td>${reportDate}</td>
        <td>${fiscalDate}</td>
      </tr>
    `;
  }).join("");
}

async function loadMarketSnapshot() {
  marketStatus = "loading";
  renderMarketSnapshot();

  try {
    const response = await fetch("/api/market", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `Market API failed with ${response.status}`);
    }
    const body = await response.json();
    marketQuotes = body.quotes || [];
    cnMarketQuotes = body.cnQuotes || [];
    marketStatus = "ready";
  } catch (error) {
    console.warn(error);
    marketQuotes = [];
    marketStatus = "unavailable";
  }

  renderMarketSnapshot();
}

function renderMarketSnapshot() {
  const grid = document.getElementById("market-grid");
  const cnGrid = document.getElementById("cn-market-grid");
  const status = document.getElementById("market-status");
  if (!grid) return;

  if (status) {
    const statusText = {
      idle: "等待加载",
      loading: "正在加载行情...",
      ready: "行情已更新",
      unavailable: "行情暂不可用",
    };
    status.textContent = statusText[marketStatus] || "";
  }

  if (marketStatus === "loading") {
    grid.innerHTML = `<div class="empty-cell">正在加载行情...</div>`;
    if (cnGrid) cnGrid.innerHTML = "";
    return;
  }

  if (marketStatus === "unavailable") {
    grid.innerHTML = `<div class="empty-cell">行情暂不可用，请检查 Alpha Vantage 配置或额度。</div>`;
    if (cnGrid) cnGrid.innerHTML = "";
    return;
  }

  grid.innerHTML = marketQuotes.length
    ? marketQuotes.map(renderQuoteCard).join("")
    : `<div class="empty-cell">暂无行情数据</div>`;

  if (cnGrid) {
    cnGrid.innerHTML = cnMarketQuotes.length ? cnMarketQuotes.map(renderQuoteCard).join("") : "";
  }
}

function renderQuoteCard(quote) {
  const available = quote.available && quote.price;
  const change = number(quote.change);
  const pct = number(quote.changePercent);
  const up = change >= 0;

  return `
    <div class="market-item">
      <div class="market-symbol">${escapeHtml(quote.displaySymbol || quote.symbol)}</div>
      <div class="market-name">${escapeHtml(quote.nameCn || quote.name || quote.symbol)}</div>
      <div class="market-subname">${escapeHtml(quote.name || "")}</div>
      <div class="market-price">${available ? formatPlainPrice(quote.price) : "暂无数据"}</div>
      <div class="market-change ${available ? (up ? "up" : "down") : "market-unavailable"}">
        ${available ? `${up ? "+" : ""}${change.toFixed(2)} (${up ? "+" : ""}${pct.toFixed(2)}%)` : marketErrorLabel(quote.error)}
      </div>
    </div>
  `;
}

function marketErrorLabel(error) {
  const text = String(error || "");
  if (/1 request per second|rate limit|25 requests per day/i.test(text)) return "额度限制";
  if (/invalid|not found|Error Message/i.test(text)) return "代码不支持";
  return "等待行情";
}

function applyPortfolio(nextPortfolio, statusText) {
  portfolio = normalizePortfolio(nextPortfolio);
  positions = portfolio.positions;
  cash = portfolio.cash;
  txs = portfolio.transactions;
  totals = computeTotals(positions, cash);
  earningsBySymbol = {};
  earningsStatus = "idle";

  if (dataStatus) dataStatus.textContent = statusText;
  if (accountId) accountId.textContent = portfolio.account || "IBKR";

  renderOverview();
  renderFrameworkAnalysis();
  renderMonthlyReturnGrid();
  renderPerformanceChart(currentChartDays());
  renderSectorChart();
  renderTopMovers();
  renderPositionsTable(currentPositionFilter(), currentPositionSearch());
  renderTxTable(currentTxFilter());
  renderAllocationCharts();
  showSection(currentSection());
  loadEarningsForPositions();
}

function normalizePortfolio(input) {
  return {
    source: input?.source || demoData.source,
    updatedAt: input?.updatedAt || "",
    account: input?.account || demoData.account,
    baseCurrency: input?.baseCurrency || demoData.baseCurrency,
    summary: input?.summary || {},
    positions: (Array.isArray(input?.positions) && input.positions.length ? input.positions : demoData.positions).map(normalizePosition),
    cash: normalizePosition(input?.cash || demoData.cash),
    transactions: (Array.isArray(input?.transactions) ? input.transactions : demoData.transactions).map(normalizeTransaction),
    navSeries: Array.isArray(input?.navSeries) ? input.navSeries : [],
    cashflow: normalizeCashflow(input?.cashflow),
  };
}

function normalizeCashflow(input) {
  const dividends = input?.dividends || {};
  const fees = input?.fees || {};
  const flows = input?.flows || {};
  return {
    dividends: {
      total: number(dividends.total),
      byMonth: Array.isArray(dividends.byMonth) ? dividends.byMonth : [],
      bySymbol: Array.isArray(dividends.bySymbol) ? dividends.bySymbol : [],
    },
    fees: {
      total: number(fees.total),
      byMonth: Array.isArray(fees.byMonth) ? fees.byMonth : [],
    },
    flows: {
      total: number(flows.total),
      byMonth: Array.isArray(flows.byMonth) ? flows.byMonth : [],
    },
  };
}

function normalizePosition(position) {
  const qty = number(position.qty);
  const price = number(position.price);
  return {
    symbol: position.symbol || "-",
    name: position.name || position.symbol || "-",
    type: position.type || "stock",
    qty,
    cost: number(position.cost) || price || 1,
    price,
    marketValue: number(position.marketValue) || qty * price,
    unrealizedPnl: number(position.unrealizedPnl),
    sector: position.sector || "其他",
    region: position.region || "US",
    currency: position.currency || portfolio.baseCurrency || "USD",
  };
}

function normalizeTransaction(tx) {
  return {
    date: tx.date || "",
    type: tx.type || "buy",
    symbol: tx.symbol || "-",
    name: tx.name || tx.symbol || "-",
    qty: number(tx.qty),
    price: number(tx.price),
    amount: number(tx.amount),
  };
}

function computeTotals(positionRows, cashRow) {
  const computedMarket = positionRows.reduce((sum, position) => sum + positionMarketValue(position), 0);
  const cost = positionRows.reduce((sum, position) => sum + position.qty * position.cost, 0);
  const computedCashValue = number(cashRow.qty) * number(cashRow.price || 1);
  const market = number(portfolio.summary?.securitiesMarketValue) || computedMarket;
  const cashValue = nonZeroNumber(portfolio.summary?.cash, computedCashValue);
  const totalMarket = number(portfolio.summary?.netAssetValue) || market + cashValue;
  const totalCost = cost + cashValue;
  const totalPnl = totalMarket - totalCost;
  const totalReturn = totalCost ? (totalPnl / totalCost) * 100 : 0;
  const dayPnl = positionRows.reduce((sum, position) => sum + number(position.unrealizedPnl), 0) || totalMarket * 0.0025;
  return { market, computedMarket, cost, cashValue, totalMarket, totalCost, totalPnl, totalReturn, dayPnl };
}

function wireNavigation() {
  navItems.forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      const target = item.dataset.target;
      showSection(target);
      history.replaceState(null, "", `#${target}`);
      document.querySelector(".sidebar")?.classList.remove("open");
    });
  });
}

function wireControls() {
  document.querySelector(".mobile-menu-btn")?.addEventListener("click", () => {
    document.querySelector(".sidebar")?.classList.toggle("open");
  });

  document.querySelectorAll("#perf-tabs .chart-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#perf-tabs .chart-tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      renderPerformanceChart(currentChartDays());
    });
  });

  document.querySelectorAll("#bench-tabs .chart-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#bench-tabs .chart-tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      renderBenchmarkChart(benchmarkDays());
    });
  });

  document.querySelectorAll("#monthly-mode-tabs .chart-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#monthly-mode-tabs .chart-tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      monthlyReturnMode = tab.dataset.mode === "amount" ? "amount" : "rate";
      renderMonthlyReturnGrid();
    });
  });

  document.getElementById("pos-filter")?.addEventListener("change", () => {
    renderPositionsTable(currentPositionFilter(), currentPositionSearch());
  });
  document.getElementById("pos-search")?.addEventListener("input", () => {
    renderPositionsTable(currentPositionFilter(), currentPositionSearch());
  });
  document.getElementById("tx-filter")?.addEventListener("change", () => renderTxTable(currentTxFilter()));
  document.getElementById("earnings-refresh-btn")?.addEventListener("click", () => loadPopularEarnings(true));

  document.getElementById("period-select")?.addEventListener("change", (event) => {
    document.querySelectorAll("#perf-tabs .chart-tab").forEach((item) => item.classList.toggle("active", item.dataset.range === event.target.value));
    renderPerformanceChart(currentChartDays());
  });

  document.getElementById("refresh-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("refresh-btn");
    btn.classList.add("spinning");
    try {
      const liveData = await loadPortfolio();
      applyPortfolio(liveData, "IBKR Flex 已同步");
    } catch (error) {
      console.warn(error);
      if (dataStatus) dataStatus.textContent = "同步失败，继续显示当前数据";
    } finally {
      setTimeout(() => btn.classList.remove("spinning"), 500);
    }
  });

  const themeToggle = document.getElementById("theme-toggle");
  themeToggle.textContent = (savedTheme === "dark" ? "☀️" : "🌙") + " 主题";
  themeToggle?.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    themeToggle.textContent = next === "dark" ? "☀️ 主题" : "🌙 主题";
    renderPerformanceChart(currentChartDays());
    renderSectorChart();
    renderAllocationCharts();
    renderBenchmarkChart(benchmarkDays());
    renderDividendChart();
  });
}

function showSection(name) {
  const target = titles[name] ? name : "overview";
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.target === target));
  sections.forEach((section) => section.classList.toggle("active", section.id === `section-${target}`));
  pageTitle.textContent = titles[target] || "";
  if (target === "positions") {
    renderAllocationCharts();
    renderMonthlyReturnGrid();
    renderPositionsTable(currentPositionFilter(), currentPositionSearch());
  }
  if (target === "framework") renderFrameworkAnalysis();
  if (target === "transactions") renderTxTable(currentTxFilter());
  if (target === "analytics") renderAnalytics();
  if (target === "insights") renderInsights();
}

function renderFrameworkAnalysis() {
  const summary = portfolio.summary || {};
  const securities = number(summary.securitiesMarketValue) || positions.reduce((sum, position) => sum + positionMarketValue(position), 0);
  const nav = number(summary.netAssetValue) || totals.totalMarket || 0;
  const cashValue = summary.cash !== undefined && summary.cash !== null ? number(summary.cash) : number(totals.cashValue);
  const debt = Math.max(0, -cashValue);
  const totalAssets = securities + Math.max(0, cashValue);
  const leverage = nav > 0 ? totalAssets / nav : 0;
  const debtRatio = nav > 0 ? debt / nav : 0;
  const largest = [...positions].map((position) => positionMarketValue(position)).sort((a, b) => b - a)[0] || 0;
  const concentration = securities > 0 ? largest / securities : 0;
  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  setText("framework-nav", formatCurrency(nav));
  setText("framework-securities", formatCurrency(securities));
  setText("framework-debt", formatCurrency(debt));
  setText("framework-leverage", nav > 0 ? `${leverage.toFixed(2)} 倍` : "—");
  setText("framework-debt-ratio", nav > 0 ? percent(debt, nav) : "—");
  setText("framework-concentration", securities > 0 ? percent(concentration * securities, securities) : "—");
  renderLeverageScale(leverage);
  const status = document.getElementById("framework-account-status");
  if (status) status.textContent = portfolio.source === "ibkr-flex" ? `IBKR Flex · ${portfolio.updatedAt ? new Date(portfolio.updatedAt).toLocaleString("zh-CN") : "已同步"}` : "Demo 数据";
  const alert = document.getElementById("framework-risk-alert");
  if (!alert) return;
  const messages = [];
  const actions = [];
  if (debt > 0) messages.push(`当前存在融资余额 ${formatCurrency(debt)}。`);
  if (leverage > 2) {
    messages.push(`账户杠杆约 ${leverage.toFixed(2)} 倍，已超过框架中建议的 2 倍以内。`);
    actions.push("暂缓新增融资和杠杆 ETF，优先制定分阶段降杠杆计划，目标回到 2 倍以内。");
  } else if (leverage > 1.5) {
    messages.push(`账户杠杆约 ${leverage.toFixed(2)} 倍，处于需要重点关注的区间。`);
    actions.push("暂不继续提高杠杆，先完成至少 20% 回撤压力测试，并确认融资期限和利率能承受长期持有。");
  }
  if (debt > 0) {
    actions.push("核对实际融资利率、到期日、维持担保比例和强平线；融资成本最好控制在 6% 以下，并保留还款缓冲。");
  }
  if (concentration >= 0.5) {
    messages.push(`最大单一持仓占证券市值 ${percent(concentration * securities, securities)}，集中度较高。`);
    actions.push("新增资金优先补充其他资产或宽基仓位，避免继续放大单一标的风险；不要仅因短期波动一次性追涨杀跌。");
  }
  if (!messages.length) {
    messages.push("当前未发现融资或高集中度提示。");
    actions.push("继续按长期计划投入，普通回调不做频繁择时；每次加仓前复核资金期限和 20% 回撤承受能力。");
  }
  alert.hidden = false;
  alert.innerHTML = `<strong>风险提示：</strong>${messages.join(" ")}<br><strong>操作建议：</strong><ul>${actions.map((action) => `<li>${action}</li>`).join("")}</ul><span class="framework-risk-source">建议依据：PDF 中的 2 倍杠杆、6% 融资利率、至少 2 年资金期限和 20% 回撤压力测试原则。</span>`;
}

function renderLeverageScale(leverage) {
  const levelEl = document.getElementById("framework-leverage-level");
  const marker = document.getElementById("framework-leverage-marker");
  const markerLabel = document.getElementById("framework-leverage-marker-label");
  const scale = document.getElementById("framework-leverage-scale");
  if (!levelEl || !marker || !markerLabel || !scale || !leverage) return;
  const levels = [
    { max: 1, label: "很安全：无负债" },
    { max: 1.5, label: "安全：合理负债" },
    { max: 2, label: "较安全：适当负债" },
    { max: 2.5, label: "略高风险：高杠杆" },
    { max: 3, label: "偏高风险：建议降到 2 倍以内" },
    { max: Infinity, label: "极高风险：极高杠杆" },
  ];
  const current = levels.find((level) => leverage <= level.max) || levels.at(-1);
  levelEl.textContent = current.label;
  markerLabel.textContent = `${leverage.toFixed(2)} 倍`;
  const scalePoints = [1, 1.5, 2, 2.5, 3, 5];
  const scalePositions = scalePoints.map((_, index) => (index + 0.5) / scalePoints.length * 100);
  const cappedLeverage = Math.min(Math.max(leverage, scalePoints[0]), scalePoints.at(-1));
  let markerPosition = scalePositions[0];
  for (let index = 1; index < scalePoints.length; index += 1) {
    if (cappedLeverage <= scalePoints[index]) {
      const segmentStart = scalePoints[index - 1];
      const segmentRatio = (cappedLeverage - segmentStart) / (scalePoints[index] - segmentStart);
      markerPosition = scalePositions[index - 1] + segmentRatio * (scalePositions[index] - scalePositions[index - 1]);
      break;
    }
  }
  marker.style.left = `${markerPosition}%`;
  scale.querySelectorAll(".leverage-level").forEach((item) => {
    const itemLevel = Number(item.dataset.level);
    item.classList.toggle("active", leverage <= itemLevel && (itemLevel === 1 || leverage > Number(item.previousElementSibling?.dataset.level || 0)));
  });
}

function currentSection() {
  return location.hash.replace("#", "") || "overview";
}

function renderOverview() {
  document.getElementById("total-value").textContent = formatCurrency(totals.totalMarket);
  document.querySelector(".change-amount").textContent = signedCurrency(totals.totalPnl);
  document.querySelector(".change-pct").textContent = `(${signedPercent(totals.totalReturn)})`;
  setValueWithClass("day-pnl", signedCurrency(totals.dayPnl), totals.dayPnl);
  setValueWithClass("total-pnl", signedCurrency(totals.totalPnl), totals.totalPnl);
  setValueWithClass("total-return", signedPercent(totals.totalReturn), totals.totalReturn);
  document.getElementById("market-value").textContent = formatCurrency(totals.market);
  document.getElementById("cash-value").textContent = formatCurrency(totals.cashValue);
  document.getElementById("pos-count").textContent = positions.length;
  document.getElementById("trade-count").textContent = countTodayTrades();
}

function setValueWithClass(id, text, value) {
  const element = document.getElementById(id);
  element.textContent = text;
  element.className = `meta-value ${value >= 0 ? "up" : "down"}`;
}

function renderPerformanceChart(days = 365) {
  const { labels, data } = navSeriesForRange(days);
  const ctx = document.getElementById("performance-chart").getContext("2d");
  const colors = chartColors();
  if (perfChart) perfChart.destroy();

  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, "rgba(37, 99, 235, 0.25)");
  gradient.addColorStop(1, "rgba(37, 99, 235, 0)");

  perfChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "资产净值",
        data,
        borderColor: "#2563eb",
        backgroundColor: gradient,
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: "#2563eb",
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(0,0,0,0.85)",
          padding: 12,
          callbacks: { label: (item) => ` ${formatCurrency(item.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { color: colors.grid, drawBorder: false }, ticks: { color: colors.text, maxTicksLimit: 8, font: { size: 11 } } },
        y: {
          grid: { color: colors.grid, drawBorder: false },
          ticks: { color: colors.text, font: { size: 11 }, callback: (value) => `$${(value / 1000).toFixed(0)}k` },
        },
      },
    },
  });
}

function renderSectorChart() {
  const sectorData = groupByValue(positions, (position) => position.sector, positionMarketValue);
  const colors = chartColors();
  if (sectorChart) sectorChart.destroy();

  sectorChart = new Chart(document.getElementById("sector-chart"), {
    type: "doughnut",
    data: {
      labels: Object.keys(sectorData),
      datasets: [{
        data: Object.values(sectorData),
        backgroundColor: ["#2563eb", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4"],
        borderWidth: 0,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      plugins: {
        legend: { position: "right", labels: { color: colors.text, boxWidth: 12, padding: 12, font: { size: 12 } } },
        tooltip: { callbacks: { label: (item) => ` ${item.label}: ${formatCurrency(item.parsed)} (${percent(item.parsed, totals.market)})` } },
      },
    },
  });
}

function renderTopMovers() {
  const movers = positions
    .map((position) => ({ ...position, pnl: position.unrealizedPnl || positionMarketValue(position) - position.qty * position.cost }))
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
    .slice(0, 6);

  document.getElementById("top-movers").innerHTML = movers.map((item) => {
    const up = item.pnl >= 0;
    return `
      <div class="mover-item">
        <div class="mover-left">
          <span class="mover-symbol">${escapeHtml(item.symbol)}</span>
          <span class="mover-name">${escapeHtml(item.name)}</span>
        </div>
        <div class="mover-right">
          <div class="mover-price">${formatCurrency(item.price)}</div>
          <div class="mover-change ${up ? "up" : "down"}">${up ? "+" : ""}${percent(item.pnl, item.qty * item.cost)}</div>
        </div>
      </div>
    `;
  }).join("");
}

function renderPositionsTable(filter = "all", search = "") {
  const tbody = document.getElementById("positions-body");
  let rows = [...positions, cash];
  const query = search.trim().toLowerCase();
  if (filter !== "all") rows = rows.filter((position) => position.type === filter);
  if (query) rows = rows.filter((position) => position.symbol.toLowerCase().includes(query) || position.name.toLowerCase().includes(query));
  rows.sort((a, b) => pnlRateForPosition(b) - pnlRateForPosition(a));

  tbody.innerHTML = rows.map((position) => {
    const mv = positionMarketValue(position);
    const cost = position.qty * position.cost;
    const pnl = position.type === "cash" ? 0 : (position.unrealizedPnl || mv - cost);
    const typeLabels = { stock: "股票", etf: "ETF", option: "期权", cash: "现金" };
    const pnlClass = pnl >= 0 ? "pnl-up" : "pnl-down";

    return `
      <tr>
        <td class="symbol-cell">${escapeHtml(position.symbol)}</td>
        <td>${escapeHtml(position.name)}</td>
        <td><span class="type-badge">${typeLabels[position.type] || escapeHtml(position.type)}</span></td>
        <td class="num">${formatNumber(position.qty)}</td>
        <td class="num">${formatCurrency(position.cost)}</td>
        <td class="num">${formatCurrency(position.price)}</td>
        <td class="num">${formatCurrency(mv)}</td>
        <td class="num ${pnlClass}">${signedCurrency(pnl)}</td>
        <td class="num ${pnlClass}">${pnl >= 0 ? "+" : ""}${percent(pnl, cost)}</td>
        <td>${earningsCell(position)}</td>
      </tr>
    `;
  }).join("");
}

function renderAllocationCharts(force = false) {
  if (!force && !document.getElementById("section-positions").classList.contains("active")) return;

  const typeData = groupByValue([...positions, cash], (position) => ({ stock: "股票", etf: "ETF", option: "期权", cash: "现金" }[position.type] || position.type), positionMarketValue);
  const allocationBase = number(portfolio.summary?.securitiesMarketValue) || positions.reduce((sum, position) => sum + positionMarketValue(position), 0);
  const holdingRows = [...positions]
    .map((position) => ({ ...position, marketValue: positionMarketValue(position) }))
    .sort((a, b) => b.marketValue - a.marketValue);
  const majorHoldings = holdingRows.filter((position) => allocationBase > 0 && position.marketValue / allocationBase >= 0.1);
  const minorHoldingsValue = holdingRows
    .filter((position) => allocationBase <= 0 || position.marketValue / allocationBase < 0.1)
    .reduce((sum, position) => sum + position.marketValue, 0);
  const holdingMix = Object.fromEntries(majorHoldings.map((position) => [position.symbol, position.marketValue]));
  if (minorHoldingsValue > 0) holdingMix["其他"] = minorHoldingsValue;
  const colors = chartColors();

  if (assetClassChart) assetClassChart.destroy();
  if (topHoldingsChart) topHoldingsChart.destroy();
  assetClassChart = pieChart("asset-class-chart", typeData, ["#2563eb", "#8b5cf6", "#10b981", "#f59e0b"], colors);
  topHoldingsChart = pieChart(
    "top-holdings-chart",
    holdingMix,
    ["#2563eb", "#ef4444", "#10b981", "#8b5cf6", "#f59e0b", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1"],
    colors,
    true,
    allocationBase,
  );
  renderTopHoldings(holdingRows);
}

function pieChart(id, data, backgroundColor, colors, showWeights = false, weightBase = totals.totalMarket) {
  return new Chart(document.getElementById(id), {
    type: "pie",
    plugins: [pieSliceLabelsPlugin],
    data: { labels: Object.keys(data), datasets: [{ data: Object.values(data), backgroundColor, borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: colors.text,
            padding: 15,
            font: { size: 12 },
            ...(showWeights ? {
              generateLabels(chart) {
                const dataset = chart.data.datasets[0];
                return chart.data.labels.map((label, index) => ({
                  text: `${label} 权重 ${percent(dataset.data[index], weightBase)}`,
                  fillStyle: dataset.backgroundColor[index],
                  strokeStyle: dataset.backgroundColor[index],
                  hidden: false,
                  index,
                }));
              },
            } : {}),
          },
        },
        pieSliceLabels: { weightBase },
        tooltip: { callbacks: { label: (item) => ` ${item.label}: ${formatCurrency(item.parsed)}（权重 ${percent(item.parsed, weightBase)}）` } },
      },
    },
  });
}

const pieSliceLabelsPlugin = {
  id: "pieSliceLabels",
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    const dataset = chart.data.datasets[0];
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 11px sans-serif";
    meta.data.forEach((arc, index) => {
      const angle = arc.endAngle - arc.startAngle;
      if (angle < 0.18) return;
      const point = arc.getCenterPoint();
      const label = chart.data.labels[index];
      const weight = percent(dataset.data[index], chart.options.plugins?.pieSliceLabels?.weightBase || totals.totalMarket);
      const shortLabel = label.length > 22 ? `${label.slice(0, 20)}…` : label;
      ctx.fillText(shortLabel, point.x, point.y - 7);
      ctx.font = "11px sans-serif";
      ctx.fillText(weight, point.x, point.y + 9);
      ctx.font = "600 11px sans-serif";
    });
    ctx.restore();
  },
};

function renderTopHoldings(holdingRows = [...positions].map((position) => ({ ...position, marketValue: positionMarketValue(position) })).sort((a, b) => b.marketValue - a.marketValue)) {
  const topHoldings = holdingRows.slice(0, 10).sort((a, b) => pnlRateForPosition(b) - pnlRateForPosition(a));
  const maxMv = topHoldings[0]?.marketValue || 1;
  document.getElementById("top-holdings").innerHTML = topHoldings.map((position, index) => `
    <div class="holding-row">
      <div class="holding-rank">${index + 1}</div>
      <div class="holding-info">
        <div class="holding-name">${escapeHtml(companyChineseName(position.symbol, position.name))}</div>
        <div class="holding-sym">${escapeHtml(position.symbol)}</div>
        <div class="holding-name holding-name-en">${escapeHtml(position.name)}</div>
      </div>
      <div class="holding-number">${formatNumber(position.qty)}</div>
      <div class="holding-number">${formatCurrency(position.cost)}</div>
      <div class="holding-number">${formatCurrency(position.price)}</div>
      <div class="holding-number holding-market-value">${formatCurrency(position.marketValue)}</div>
      <div class="holding-bar-wrap"><div class="holding-bar" style="width: ${(position.marketValue / maxMv) * 100}%"></div></div>
      <div class="holding-number ${position.unrealizedPnl >= 0 ? "pnl-up" : "pnl-down"}">${signedCurrency(position.unrealizedPnl || position.marketValue - position.qty * position.cost)}</div>
      <div class="holding-number ${pnlRateForPosition(position) >= 0 ? "pnl-up" : "pnl-down"}">${signedPercent(pnlRateForPosition(position) * 100)}</div>
      <div class="holding-pct">${percent(position.marketValue, totals.totalMarket)}</div>
    </div>
  `).join("");
}

function companyChineseName(symbol, fallback = "") {
  const names = {
    DRAM: "Roundhill 内存 ETF",
    DXJ: "WisdomTree 日本对冲股票基金",
    GGLL: "Direxion 做多谷歌 2 倍 ETF",
    GOOG: "谷歌 A 类股",
    IBKR: "盈透证券",
    MSFT: "微软",
    NVDA: "英伟达",
    SPCX: "太空探索科技",
    TQQQ: "ProShares 纳指 100 三倍 ETF",
    TSMU: "GraniteShares 台积电 2 倍 ETF",
  };
  return names[String(symbol || "").toUpperCase()] || fallback;
}

function renderTxTable(filter = "all") {
  const tbody = document.getElementById("tx-body");
  const rows = filter === "all" ? txs : txs.filter((tx) => tx.type === filter);
  const typeLabels = { buy: "买入", sell: "卖出", dividend: "股息", fee: "费用" };

  tbody.innerHTML = rows.map((tx) => `
    <tr>
      <td>${escapeHtml(tx.date)}</td>
      <td><span class="tx-badge ${tx.type}">${typeLabels[tx.type] || escapeHtml(tx.type)}</span></td>
      <td class="symbol-cell">${escapeHtml(tx.symbol)}</td>
      <td>${escapeHtml(tx.name)}</td>
      <td class="num">${formatNumber(tx.qty)}</td>
      <td class="num">${formatCurrency(tx.price)}</td>
      <td class="num ${tx.type === "sell" || tx.type === "dividend" ? "pnl-up" : tx.type === "buy" || tx.type === "fee" ? "pnl-down" : ""}">
        ${tx.type === "buy" || tx.type === "fee" ? "-" : "+"}${formatCurrency(Math.abs(tx.amount))}
      </td>
    </tr>
  `).join("");
}

function renderAnalytics() {
  renderMonthlyReturns();
  renderDividends();
  renderFees();
  if (benchmarkStatus === "idle" || benchmarkStatus === "unavailable") {
    loadBenchmark();
  } else {
    renderBenchmarkChart(benchmarkDays());
  }
}

async function loadBenchmark() {
  benchmarkStatus = "loading";
  renderBenchmarkChart(benchmarkDays());
  try {
    const response = await fetch("/api/benchmark", { headers: { Accept: "application/json" } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `Benchmark API failed with ${response.status}`);
    }
    const body = await response.json();
    benchmarkData = body.benchmark || null;
    benchmarkStatus = "ready";
  } catch (error) {
    console.warn(error);
    benchmarkData = null;
    benchmarkStatus = "unavailable";
  }
  renderBenchmarkChart(benchmarkDays());
}

function renderBenchmarkChart(days) {
  const canvas = document.getElementById("benchmark-chart");
  if (!canvas) return;
  const statusEl = document.getElementById("benchmark-status");
  if (benchmarkChart) benchmarkChart.destroy();
  benchmarkChart = null;

  const statusText = {
    idle: "",
    loading: "正在加载基准行情...",
    ready: "",
    unavailable: "基准行情暂不可用（未配置 Alpha Vantage）",
  };
  if (statusEl) statusEl.textContent = statusText[benchmarkStatus] || "";
  if (benchmarkStatus === "loading") return;

  const portfolioSeries = portfolio.navSeries
    .map((row) => ({ date: String(row.date || "").slice(0, 10), value: number(row.value) }))
    .filter((row) => row.value > 0 && validDate(row.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  const benchmarkPoints = (Array.isArray(benchmarkData?.points) ? benchmarkData.points : []).filter((point) => validDate(point.date));

  if (portfolioSeries.length < 2 || benchmarkPoints.length < 2) {
    if (statusEl) statusEl.textContent = "数据不足（组合净值或基准行情不可用）";
    return;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const inRange = (date) => new Date(`${date}T00:00:00Z`).getTime() >= cutoff;
  const portfolioInRange = portfolioSeries.filter((point) => inRange(point.date));
  const benchInRange = benchmarkPoints.filter((point) => inRange(point.date));
  if (portfolioInRange.length < 2 || benchInRange.length < 2) return;

  // 两端都归一到 100，按日期对齐（缺失点由 spanGaps 连接）
  const p0 = portfolioInRange[0].value;
  const b0 = benchInRange[0].close;
  const normalize = (value, base) => (base ? (value / base) * 100 : 100);
  const pMap = new Map(portfolioInRange.map((point) => [point.date, point.value]));
  const bMap = new Map(benchInRange.map((point) => [point.date, point.close]));
  const allDates = [...new Set([...pMap.keys(), ...bMap.keys()])].sort();

  const colors = chartColors();
  const ctx = canvas.getContext("2d");
  benchmarkChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: allDates.map((date) => new Date(`${date}T00:00:00Z`).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })),
      datasets: [
        {
          label: "组合净值",
          data: allDates.map((date) => (pMap.has(date) ? normalize(pMap.get(date), p0) : null)),
          borderColor: "#2563eb",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          spanGaps: true,
        },
        {
          label: "QQQ",
          data: allDates.map((date) => (bMap.has(date) ? normalize(bMap.get(date), b0) : null)),
          borderColor: "#10b981",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: colors.text } },
        tooltip: { callbacks: { label: (item) => ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)}` } },
      },
      scales: {
        x: { grid: { color: colors.grid, drawBorder: false }, ticks: { color: colors.text, maxTicksLimit: 8, font: { size: 11 } } },
        y: { grid: { color: colors.grid, drawBorder: false }, ticks: { color: colors.text, font: { size: 11 }, callback: (value) => value.toFixed(0) } },
      },
    },
  });
}

function renderMonthlyReturns() {
  const tbody = document.getElementById("monthly-returns-body");
  if (!tbody) return;
  const nav = portfolio.navSeries;
  if (!Array.isArray(nav) || nav.length < 2) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">净值历史数据不足（需至少 2 个净值点）</td></tr>`;
    return;
  }

  const byMonth = new Map();
  for (const row of nav) {
    const date = String(row.date || "").slice(0, 10);
    if (!validDate(date)) continue;
    byMonth.set(date.slice(0, 7), number(row.value)); // nav 升序，后者即月末值
  }
  // 当月用实时总资产，与持仓页月度网格保持同一口径
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  byMonth.set(currentKey, number(totals.totalMarket));

  const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const benchKeys = benchmarkMonthKeys();
  const flowMap = new Map((portfolio.cashflow?.flows?.byMonth || []).map((row) => [row.month, number(row.amount)]));

  const rows = [];
  for (let index = 1; index < months.length; index += 1) {
    const prev = months[index - 1][1];
    const current = months[index][1];
    if (!prev || !current) continue;
    const netFlow = flowMap.get(months[index][0]) || 0;
    rows.push({
      month: months[index][0],
      endNav: current,
      ret: ((current - prev - netFlow) / prev) * 100,
      qqq: benchmarkMonthReturn(benchKeys, months[index][0]),
    });
  }

  tbody.innerHTML = rows
    .slice(-12)
    .reverse()
    .map((row) => {
      const qqq = row.qqq;
      const qqqCell = qqq === null ? "-" : `<span class="${qqq >= 0 ? "pnl-up" : "pnl-down"}">${qqq >= 0 ? "+" : ""}${qqq.toFixed(2)}%</span>`;
      return `
        <tr>
          <td>${formatMonthLabel(row.month)}</td>
          <td class="num">${formatCurrency(row.endNav)}</td>
          <td class="num ${row.ret >= 0 ? "pnl-up" : "pnl-down"}">${row.ret >= 0 ? "+" : ""}${row.ret.toFixed(2)}%</td>
          <td class="num">${qqqCell}</td>
        </tr>
      `;
    })
    .join("");
}

// 月度收益序列：月末净值环比 − 当月净入金（净入金不是收益，须剔除），返回收益率(%)与收益额
function monthlyReturnRows() {
  const monthEnds = new Map();
  for (const row of portfolio.navSeries) {
    const date = String(row.date || "").slice(0, 10);
    if (!validDate(date)) continue;
    monthEnds.set(date.slice(0, 7), number(row.value)); // nav 升序，后者即月末值
  }

  // 当月用实时总资产覆盖，得到本月初至今的收益
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  monthEnds.set(currentKey, number(totals.totalMarket));

  const flowMap = new Map((portfolio.cashflow?.flows?.byMonth || []).map((row) => [row.month, number(row.amount)]));

  const months = [...monthEnds.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const rows = [];
  for (let index = 1; index < months.length; index += 1) {
    const start = months[index - 1][1];
    const end = months[index][1];
    if (!start || !end) continue;
    const netFlow = flowMap.get(months[index][0]) || 0;
    const amount = end - start - netFlow;
    rows.push({ month: months[index][0], amount, ret: (amount / start) * 100 });
  }
  return rows;
}

function renderMonthlyReturnGrid() {
  const grid = document.getElementById("monthly-return-grid");
  if (!grid) return;

  const summaryEl = document.getElementById("monthly-grid-summary");
  const rows = monthlyReturnRows();
  if (rows.length === 0) {
    grid.innerHTML = `<div class="empty-cell">净值历史数据不足（需至少 2 个净值点）</div>`;
    if (summaryEl) summaryEl.textContent = "—";
    return;
  }

  // 当前自然年 1-12 月，固定 12 格、按顺序排列；无数据月份显示 "—"
  const now = new Date();
  const year = now.getFullYear();
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  const cells = [];
  for (let month = 1; month <= 12; month += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    cells.push({ key, row: byMonth.get(key) || null });
  }

  const withData = cells.filter((cell) => cell.row);
  const positive = withData.filter((cell) => cell.row.ret > 0).length;
  if (summaryEl) summaryEl.textContent = withData.length ? `${positive}/${withData.length} 个上涨月 · ${year}年` : `${year}年暂无数据`;

  grid.innerHTML = cells.map(({ key, row }) => {
    const label = `${Number(key.slice(5, 7))}月`;
    if (!row) {
      return `
        <div class="month-cell">
          <span class="month-label">${label}</span>
          <strong class="month-ret month-empty">—</strong>
        </div>
      `;
    }
    const value =
      monthlyReturnMode === "amount"
        ? formatCompactSigned(row.amount)
        : `${row.ret >= 0 ? "+" : ""}${row.ret.toFixed(1)}%`;
    return `
      <div class="month-cell">
        <span class="month-label">${label}</span>
        <strong class="month-ret ${row.ret >= 0 ? "pnl-up" : "pnl-down"}">${value}</strong>
      </div>
    `;
  }).join("");
}

function formatCompactSigned(value) {
  const num = number(value);
  const sign = num >= 0 ? "+" : "-";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: portfolio.baseCurrency || "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Math.abs(num));
  return `${sign}${formatted}`;
}

function benchmarkMonthKeys() {
  if (!Array.isArray(benchmarkData?.points)) return null;
  const map = new Map();
  for (const point of benchmarkData.points) {
    if (!validDate(point.date)) continue;
    map.set(point.date.slice(0, 7), number(point.close)); // 升序，后者即月末值
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function benchmarkMonthReturn(keys, month) {
  if (!keys) return null;
  const index = keys.findIndex(([key]) => key === month);
  if (index <= 0) return null;
  const prev = keys[index - 1][1];
  const current = keys[index][1];
  if (!prev || !current) return null;
  return ((current - prev) / prev) * 100;
}

function renderDividends() {
  const tbody = document.getElementById("dividends-body");
  if (!tbody) return;
  const dividends = portfolio.cashflow?.dividends;
  if (!dividends || !dividends.total) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-cell">暂无股息记录</td></tr>`;
    renderDividendChart();
    return;
  }
  const bySymbol = Array.isArray(dividends.bySymbol) ? dividends.bySymbol : [];
  tbody.innerHTML =
    bySymbol
      .map((row) => `
        <tr>
          <td class="symbol-cell">${escapeHtml(row.symbol || "-")}</td>
          <td>${escapeHtml(row.name || "-")}</td>
          <td class="num">${formatCurrency(row.amount)}</td>
        </tr>
      `)
      .join("") +
    `<tr class="total-row"><td>合计</td><td></td><td class="num">${formatCurrency(dividends.total)}</td></tr>`;
  renderDividendChart();
}

function renderDividendChart() {
  const canvas = document.getElementById("dividend-chart");
  if (!canvas) return;
  if (dividendChart) dividendChart.destroy();
  dividendChart = null;
  const byMonth = Array.isArray(portfolio.cashflow?.dividends?.byMonth) ? portfolio.cashflow.dividends.byMonth : [];
  if (!byMonth.length) return;
  const colors = chartColors();
  dividendChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: byMonth.map((row) => formatMonthLabel(row.month)),
      datasets: [{ label: "股息", data: byMonth.map((row) => row.amount), backgroundColor: "#10b981", borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => ` ${formatCurrency(item.parsed.y)}` } },
      },
      scales: {
        x: { grid: { color: colors.grid, drawBorder: false }, ticks: { color: colors.text, font: { size: 11 } } },
        y: { grid: { color: colors.grid, drawBorder: false }, ticks: { color: colors.text, font: { size: 11 }, callback: (value) => formatCurrency(value) } },
      },
    },
  });
}

function renderFees() {
  const tbody = document.getElementById("fees-body");
  if (!tbody) return;
  const fees = portfolio.cashflow?.fees;
  if (!fees || !fees.total) {
    tbody.innerHTML = `<tr><td colspan="2" class="empty-cell">暂无费用记录</td></tr>`;
    return;
  }
  const byMonth = Array.isArray(fees.byMonth) ? fees.byMonth : [];
  tbody.innerHTML =
    byMonth
      .map((row) => `
        <tr>
          <td>${formatMonthLabel(row.month)}</td>
          <td class="num">${formatCurrency(row.amount)}</td>
        </tr>
      `)
      .join("") +
    `<tr class="total-row"><td>合计</td><td class="num">${formatCurrency(fees.total)}</td></tr>`;
}

function formatMonthLabel(month) {
  if (!month || month.length < 7) return "-";
  return `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
}

function validDate(date) {
  return !Number.isNaN(new Date(`${date}T00:00:00Z`).getTime());
}

function navSeriesForRange(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const actual = portfolio.navSeries
    .filter((row) => new Date(row.date).getTime() >= cutoff)
    .map((row) => ({ label: new Date(row.date).toLocaleDateString("zh-CN", { month: "short", day: "numeric" }), value: number(row.value) }));
  if (actual.length >= 2) return { labels: actual.map((row) => row.label), data: actual.map((row) => row.value) };
  return syntheticNavSeries(days, totals.totalMarket);
}

function syntheticNavSeries(days, endValue) {
  const labels = [];
  const data = [];
  const points = Math.min(days, 180);
  const startValue = endValue * 0.88;
  for (let i = points; i >= 0; i -= 1) {
    const progress = (points - i) / Math.max(points, 1);
    const date = new Date();
    date.setDate(date.getDate() - i);
    labels.push(date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" }));
    data.push(startValue + (endValue - startValue) * progress + Math.sin(progress * Math.PI * 8) * endValue * 0.008);
  }
  return { labels, data };
}

function groupByValue(rows, keyFn, valueFn) {
  return rows.reduce((result, row) => {
    const key = keyFn(row) || "其他";
    result[key] = (result[key] || 0) + valueFn(row);
    return result;
  }, {});
}

function currentChartDays() {
  const activeRange = document.querySelector("#perf-tabs .chart-tab.active")?.dataset.range || document.getElementById("period-select")?.value || "1Y";
  return { "1D": 1, "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365, ALL: 730 }[activeRange] || 365;
}

function benchmarkDays() {
  const activeRange = document.querySelector("#bench-tabs .chart-tab.active")?.dataset.range || "1Y";
  return { "3M": 90, "6M": 180, "1Y": 365, ALL: 730 }[activeRange] || 365;
}

function currentPositionFilter() {
  return document.getElementById("pos-filter")?.value || "all";
}

function currentPositionSearch() {
  return document.getElementById("pos-search")?.value || "";
}

function currentTxFilter() {
  return document.getElementById("tx-filter")?.value || "all";
}

function pnlRateForPosition(position) {
  if (position.type === "cash") return Number.NEGATIVE_INFINITY;
  const mv = positionMarketValue(position);
  const cost = position.qty * position.cost;
  const pnl = position.unrealizedPnl || mv - cost;
  return cost ? pnl / cost : Number.NEGATIVE_INFINITY;
}

function uniqueEarningsSymbols(positionRows) {
  return [...new Set(positionRows
    .filter((position) => position.type !== "cash")
    .map((position) => normalizeEarningsSymbol(position.symbol))
    .filter(Boolean))];
}

function normalizeEarningsSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase().replace(/\./g, "-");
}

function earningsCell(position) {
  if (position.type === "cash") return "-";
  if (earningsStatus === "loading") return "加载中";
  if (earningsStatus === "unavailable") return "未配置";

  const symbol = normalizeEarningsSymbol(position.symbol);
  const item = earningsBySymbol[symbol] || earningsBySymbol[position.symbol];
  if (!item?.reportDate) return "-";

  return formatDateLabel(item.reportDate);
}

function formatDateLabel(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return escapeHtml(dateText);
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

function countTodayTrades() {
  const today = new Date().toISOString().slice(0, 10);
  return txs.filter((tx) => tx.date === today).length;
}

function positionMarketValue(position) {
  return number(position.marketValue) || number(position.qty) * number(position.price);
}

function chartColors() {
  const styles = getComputedStyle(document.documentElement);
  return { text: styles.getPropertyValue("--text-muted").trim(), grid: styles.getPropertyValue("--border").trim() };
}

function formatCurrency(value) {
  return number(value).toLocaleString("en-US", { style: "currency", currency: portfolio.baseCurrency || "USD", minimumFractionDigits: 2 });
}

function formatPlainPrice(value) {
  // 至少2位（美股习惯补零），最多3位（A股ETF/指数常见3位小数，需完整显示）
  return number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function signedCurrency(value) {
  const num = number(value);
  return `${num >= 0 ? "+" : ""}${formatCurrency(num)}`;
}

function signedPercent(value) {
  const num = number(value);
  return `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`;
}

function percent(value, base) {
  const result = number(base) ? (number(value) / number(base)) * 100 : 0;
  return `${result.toFixed(1)}%`;
}

function formatNumber(value) {
  return number(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonZeroNumber(value, fallback = 0) {
  const parsed = number(value);
  return parsed !== 0 ? parsed : fallback;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}
