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
  navSeries: [],
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
let marketStatus = "idle";
let perfChart;
let sectorChart;
let assetClassChart;
let regionChart;

const navItems = document.querySelectorAll(".nav-item");
const sections = document.querySelectorAll(".section");
const pageTitle = document.getElementById("page-title");
const dataStatus = document.getElementById("data-status");
const accountId = document.querySelector(".account-id");
const titles = {
  overview: "投资组合概览",
  positions: "持仓明细",
  allocation: "资产配置",
  transactions: "交易记录",
  insights: "市场洞察",
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
  applyPortfolio(demoData, "正在连接 IBKR...");

  try {
    const liveData = await loadPortfolio();
    applyPortfolio(liveData, liveData.source === "ibkr-flex" ? "IBKR Flex 已同步" : "Demo Data");
  } catch (error) {
    console.warn(error);
    applyPortfolio(demoData, "未配置 IBKR，显示 Demo Data");
  }
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
  renderInsightsTable();
  renderMarketSnapshot();
  if (popularEarningsStatus === "idle" || popularEarningsStatus === "unavailable") {
    loadPopularEarnings();
  }
  if (marketStatus === "idle" || marketStatus === "unavailable") {
    loadMarketSnapshot();
  }
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
    return;
  }

  if (marketStatus === "unavailable") {
    grid.innerHTML = `<div class="empty-cell">行情暂不可用，请检查 Alpha Vantage 配置或额度。</div>`;
    return;
  }

  if (!marketQuotes.length) {
    grid.innerHTML = `<div class="empty-cell">暂无行情数据</div>`;
    return;
  }

  grid.innerHTML = marketQuotes.map((quote) => {
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
  }).join("");
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
    account: input?.account || demoData.account,
    baseCurrency: input?.baseCurrency || demoData.baseCurrency,
    summary: input?.summary || {},
    positions: (Array.isArray(input?.positions) && input.positions.length ? input.positions : demoData.positions).map(normalizePosition),
    cash: normalizePosition(input?.cash || demoData.cash),
    transactions: (Array.isArray(input?.transactions) ? input.transactions : demoData.transactions).map(normalizeTransaction),
    navSeries: Array.isArray(input?.navSeries) ? input.navSeries : [],
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

  document.querySelectorAll(".chart-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".chart-tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      renderPerformanceChart(currentChartDays());
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
    document.querySelectorAll(".chart-tab").forEach((item) => item.classList.toggle("active", item.dataset.range === event.target.value));
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
  });
}

function showSection(name) {
  const target = titles[name] ? name : "overview";
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.target === target));
  sections.forEach((section) => section.classList.toggle("active", section.id === `section-${target}`));
  pageTitle.textContent = titles[target] || "";
  if (target === "allocation") renderAllocationCharts();
  if (target === "positions") renderPositionsTable(currentPositionFilter(), currentPositionSearch());
  if (target === "transactions") renderTxTable(currentTxFilter());
  if (target === "insights") renderInsights();
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
  if (!force && !document.getElementById("section-allocation").classList.contains("active")) return;

  const typeData = groupByValue([...positions, cash], (position) => ({ stock: "股票", etf: "ETF", option: "期权", cash: "现金" }[position.type] || position.type), positionMarketValue);
  const regionData = groupByValue([...positions, cash], (position) => ({ US: "美国", CN: "中国", HK: "香港", EU: "欧洲" }[position.region] || position.region), positionMarketValue);
  const colors = chartColors();

  if (assetClassChart) assetClassChart.destroy();
  if (regionChart) regionChart.destroy();
  assetClassChart = pieChart("asset-class-chart", typeData, ["#2563eb", "#8b5cf6", "#10b981", "#f59e0b"], colors);
  regionChart = pieChart("region-chart", regionData, ["#2563eb", "#ef4444", "#10b981", "#8b5cf6"], colors);
  renderTopHoldings();
}

function pieChart(id, data, backgroundColor, colors) {
  return new Chart(document.getElementById(id), {
    type: "pie",
    data: { labels: Object.keys(data), datasets: [{ data: Object.values(data), backgroundColor, borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: colors.text, padding: 15, font: { size: 12 } } },
        tooltip: { callbacks: { label: (item) => ` ${item.label}: ${formatCurrency(item.parsed)} (${percent(item.parsed, totals.totalMarket)})` } },
      },
    },
  });
}

function renderTopHoldings() {
  const topHoldings = [...positions].map((position) => ({ ...position, mv: positionMarketValue(position) })).sort((a, b) => b.mv - a.mv).slice(0, 8);
  const maxMv = topHoldings[0]?.mv || 1;
  document.getElementById("top-holdings").innerHTML = topHoldings.map((position, index) => `
    <div class="holding-row">
      <div class="holding-rank">${index + 1}</div>
      <div class="holding-info">
        <div class="holding-sym">${escapeHtml(position.symbol)}</div>
        <div class="holding-name">${escapeHtml(position.name)}</div>
      </div>
      <div class="holding-bar-wrap"><div class="holding-bar" style="width: ${(position.mv / maxMv) * 100}%"></div></div>
      <div class="holding-pct">${percent(position.mv, totals.market)}</div>
    </div>
  `).join("");
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
  const activeRange = document.querySelector(".chart-tab.active")?.dataset.range || document.getElementById("period-select")?.value || "1Y";
  return { "1D": 1, "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365, ALL: 730 }[activeRange] || 365;
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
  return number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
