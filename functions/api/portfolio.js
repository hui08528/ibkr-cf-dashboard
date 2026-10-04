import { XMLParser } from "fast-xml-parser";

const FLEX_BASE_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

let cachedPortfolio = null;
let cachedAt = 0;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  trimValues: true,
});

export async function onRequestGet({ env }) {
  const cacheTtlMs = Number(env.IBKR_FLEX_CACHE_SECONDS || 600) * 1000;

  try {
    if (cachedPortfolio && Date.now() - cachedAt < cacheTtlMs) {
      return json(200, { ...cachedPortfolio, cached: true, cachedAt: new Date(cachedAt).toISOString() });
    }

    const token = env.IBKR_FLEX_TOKEN;
    const queryId = env.IBKR_FLEX_QUERY_ID;

    if (!token || !queryId) {
      return json(503, {
        error: "IBKR Flex is not configured",
        message: "Set IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID in Cloudflare environment variables.",
      });
    }

    const referenceCode = await sendFlexRequest(token, queryId);
    const statementXml = await getFlexStatement(token, referenceCode);
    const portfolio = parseFlexStatement(statementXml);

    cachedPortfolio = {
      ...portfolio,
      source: "ibkr-flex",
      updatedAt: new Date().toISOString(),
    };
    cachedAt = Date.now();

    return json(200, cachedPortfolio);
  } catch (error) {
    return json(502, {
      error: "Unable to load IBKR Flex data",
      message: error.message,
    });
  }
}

async function sendFlexRequest(token, queryId) {
  const url = new URL(`${FLEX_BASE_URL}/SendRequest`);
  url.searchParams.set("t", token);
  url.searchParams.set("q", queryId);
  url.searchParams.set("v", "3");

  const responseText = await fetchText(url);
  const payload = parser.parse(responseText);
  const root = payload.FlexStatementResponse || payload.FlexQueryResponse || payload;

  const status = valueOf(root.Status || root.status);
  if (status && status.toLowerCase() !== "success") {
    const message = valueOf(root.ErrorMessage || root.errorMessage || root.Message || root.message);
    const code = valueOf(root.ErrorCode || root.errorCode);
    throw new Error(`IBKR SendRequest failed${code ? ` (${code})` : ""}: ${message || status}`);
  }

  const referenceCode = valueOf(root.ReferenceCode || root.referenceCode);
  if (!referenceCode) {
    throw new Error("IBKR SendRequest did not return a ReferenceCode.");
  }

  return referenceCode;
}

async function getFlexStatement(token, referenceCode) {
  const url = new URL(`${FLEX_BASE_URL}/GetStatement`);
  url.searchParams.set("t", token);
  url.searchParams.set("q", referenceCode);
  url.searchParams.set("v", "3");

  let lastText = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await wait(1500);

    lastText = await fetchText(url);
    const payload = parser.parse(lastText);

    if (payload.FlexQueryResponse) return lastText;

    const root = payload.FlexStatementResponse || payload;
    const status = valueOf(root.Status || root.status);
    const message = valueOf(root.ErrorMessage || root.errorMessage || root.Message || root.message);

    if (status && status.toLowerCase() === "success") return lastText;
    if (message && /generat|progress|try again/i.test(message)) continue;

    if (message || status) {
      const code = valueOf(root.ErrorCode || root.errorCode);
      throw new Error(`IBKR GetStatement failed${code ? ` (${code})` : ""}: ${message || status}`);
    }
  }

  return lastText;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/xml,text/xml,*/*",
      "User-Agent": "IBKR-Portfolio-Dashboard/1.0",
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  return text;
}

function parseFlexStatement(xml) {
  const payload = parser.parse(xml);
  const statements = toArray(payload.FlexQueryResponse?.FlexStatements?.FlexStatement);
  const statement = statements[0] || {};
  const summary = parseSummary(statement);

  return {
    account: maskAccount(valueOf(statement.accountId || statement.accountAlias || statement.AccountId)),
    baseCurrency: valueOf(statement.currency || statement.baseCurrency) || "USD",
    summary,
    positions: parsePositions(statement),
    cash: parseCash(statement),
    transactions: parseTrades(statement),
    navSeries: parseNavSeries(statement),
    cashflow: parseCashflow(statement),
  };
}

function parseCashflow(statement) {
  const cashTxs = toArray(statement.CashTransactions?.CashTransaction);
  const dividends = [];
  const fees = [];
  const flows = [];

  for (const row of cashTxs) {
    const description = valueOf(row.description || row.type) || "";
    const date = formatDate(row.dateTime || row.reportDate || row.date);
    const month = date ? date.slice(0, 7) : "";
    const amount = num(row.amount);

    // 入金/出金（外部资金流），amount 正=入金、负=出金；与股息/费用分开统计
    if (/deposit|withdrawal|funds received|funds disbursed|cash receipt|cash disbursement/i.test(description)) {
      flows.push({ month, name: description, amount });
      continue;
    }
    if (!/dividend|fee|commission|regulatory|interest|withholding/i.test(description)) continue;
    if (/dividend/i.test(description)) {
      dividends.push({ month, symbol: valueOf(row.symbol), name: description, amount });
    } else {
      fees.push({ month, name: description, amount });
    }
  }

  return {
    dividends: {
      total: dividends.reduce((sum, row) => sum + row.amount, 0),
      byMonth: aggregateCashflowByMonth(dividends),
      bySymbol: aggregateCashflowBySymbol(dividends),
    },
    fees: {
      total: fees.reduce((sum, row) => sum + row.amount, 0),
      byMonth: aggregateCashflowByMonth(fees),
    },
    flows: {
      total: flows.reduce((sum, row) => sum + row.amount, 0),
      byMonth: aggregateCashflowByMonth(flows),
    },
  };
}

function aggregateCashflowByMonth(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.month) continue;
    grouped.set(row.month, (grouped.get(row.month) || 0) + row.amount);
  }
  return [...grouped.entries()]
    .map(([month, amount]) => ({ month, amount }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function aggregateCashflowBySymbol(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const symbol = row.symbol || "其他";
    grouped.set(symbol, {
      symbol,
      name: row.name || symbol,
      amount: (grouped.get(symbol)?.amount || 0) + row.amount,
    });
  }
  return [...grouped.values()].sort((a, b) => b.amount - a.amount);
}

function parseSummary(statement) {
  const navRows = [
    ...toArray(statement.NetAssetValues?.NetAssetValue),
    ...toArray(statement.EquitySummaryInBase?.EquitySummaryByReportDateInBase),
    ...toArray(statement.EquitySummaryByReportDateInBase),
    ...toArray(statement.ChangeInNAV?.ChangeInNAVRow),
  ];
  const latest = navRows.at(-1) || {};

  return {
    netAssetValue: firstNumber(latest.total, latest.totalNav, latest.nav, latest.endingValue, latest.netAssetValue),
    securitiesMarketValue: firstNumber(
      latest.stock,
      latest.stockValue,
      latest.longStockValue,
      latest.securitiesGrossPositionValue,
      latest.grossPositionValue
    ),
    cash: firstNumber(latest.cash, latest.totalCash, latest.endingCash),
  };
}

function parsePositions(statement) {
  const rawRows = toArray(statement.OpenPositions?.OpenPosition)
    .filter((row) => num(row.quantity || row.position) !== 0);
  const summaryRows = rawRows.filter((row) => {
    const detail = valueOf(row.levelOfDetail || row.levelOfDetailCode || row.positionLevel).toUpperCase();
    return detail === "SUMMARY" || detail === "SUMMARY_BY_SYMBOL";
  });
  const sourceRows = summaryRows.length ? summaryRows : rawRows;

  const rows = sourceRows
    .map((row) => {
      const qty = num(row.quantity || row.position);
      const marketValue = num(row.positionValue || row.marketValue);
      const price = num(row.markPrice || row.marketPrice || row.closePrice) || safeDiv(marketValue, qty) || 0;
      const cost = num(row.costBasisPrice || row.averageCost || row.avgCost) || price;

      return {
        symbol: valueOf(row.symbol || row.underlyingSymbol || row.description) || "-",
        name: valueOf(row.description || row.symbol || row.underlyingSymbol) || "-",
        type: normalizeAssetType(row.assetCategory || row.securityType),
        qty,
        cost,
        price,
        marketValue: marketValue || qty * price,
        unrealizedPnl: num(row.fifoPnlUnrealized || row.unrealizedPnl),
        sector: valueOf(row.sector || row.assetCategory || row.securityType) || "其他",
        region: normalizeRegion(row.countryOfIssue || row.listingExchange || row.currency),
        currency: valueOf(row.currency) || "USD",
      };
    });

  return aggregatePositions(rows);
}

function aggregatePositions(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const key = [row.symbol, row.name, row.type, row.currency].join("|");
    const current = grouped.get(key) || {
      ...row,
      qty: 0,
      marketValue: 0,
      unrealizedPnl: 0,
      costValue: 0,
    };

    current.qty += row.qty;
    current.marketValue += row.marketValue;
    current.unrealizedPnl += row.unrealizedPnl;
    current.costValue += row.qty * row.cost;
    current.price = current.qty ? current.marketValue / current.qty : row.price;
    current.cost = current.qty ? current.costValue / current.qty : row.cost;
    grouped.set(key, current);
  }

  return [...grouped.values()].map(({ costValue, ...row }) => row);
}

function parseCash(statement) {
  const rows = [
    ...toArray(statement.CashReport?.CashReportCurrency),
    ...toArray(statement.CashReport?.CashReport),
  ];

  if (rows.length === 0) {
    return { symbol: "USD", name: "现金", type: "cash", qty: 0, cost: 1, price: 1, sector: "现金", region: "US" };
  }

  const baseCurrency = valueOf(statement.currency || statement.baseCurrency);
  const preferred =
    rows.find((row) => valueOf(row.currency) === baseCurrency) ||
    rows.find((row) => valueOf(row.currency).toUpperCase() === "BASE_SUMMARY") ||
    rows[0];
  const amount = num(
    preferred.endingCash ||
    preferred.totalCash ||
    preferred.cash ||
    preferred.settledCash ||
    preferred.total
  );
  const currency = valueOf(preferred.currency || statement.currency || statement.baseCurrency) || "USD";

  return {
    symbol: currency,
    name: `${currency} 现金`,
    type: "cash",
    qty: amount,
    cost: 1,
    price: 1,
    sector: "现金",
    region: normalizeRegion(currency),
    currency,
  };
}

function parseTrades(statement) {
  const trades = toArray(statement.Trades?.Trade);
  const cashTxs = toArray(statement.CashTransactions?.CashTransaction);

  const tradeRows = trades.map((row) => {
    const buySell = valueOf(row.buySell || row.transactionType).toUpperCase();
    const qty = Math.abs(num(row.quantity));
    const price = num(row.tradePrice || row.price);
    const amount = Math.abs(num(row.proceeds || row.amount || qty * price));

    return {
      date: formatDate(row.tradeDate || row.dateTime || row.date),
      type: buySell === "SELL" || buySell === "SLD" ? "sell" : "buy",
      symbol: valueOf(row.symbol || row.underlyingSymbol) || "-",
      name: valueOf(row.description || row.symbol) || "-",
      qty,
      price,
      amount,
    };
  });

  const cashRows = cashTxs
    .filter((row) => /dividend|fee|commission|regulatory|interest|withholding/i.test(valueOf(row.type || row.description)))
    .map((row) => {
      const description = valueOf(row.description || row.type) || "现金交易";
      const amount = num(row.amount);
      const isDividend = /dividend/i.test(description);
      return {
        date: formatDate(row.dateTime || row.reportDate || row.date),
        type: isDividend ? "dividend" : "fee",
        symbol: valueOf(row.symbol) || "-",
        name: description,
        qty: 1,
        price: Math.abs(amount),
        amount,
      };
    });

  return [...tradeRows, ...cashRows]
    .filter((row) => row.date)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 100);
}

function parseNavSeries(statement) {
  const rows = [
    ...toArray(statement.NetAssetValues?.NetAssetValue),
    ...toArray(statement.ChangeInNAV?.ChangeInNAVRow),
    // EquitySummaryByReportDateInBase 是按报告日期的净值历史（很多 Flex 查询用这个段）
    ...toArray(statement.EquitySummaryInBase?.EquitySummaryByReportDateInBase),
  ];

  const points = rows
    .map((row) => ({
      date: formatDate(row.date || row.reportDate),
      value: num(row.total || row.totalNav || row.nav || row.endingValue),
    }))
    .filter((row) => row.date && row.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  // 去掉账户尚未入金时的近零值（相对最大值 <0.1%），避免月度收益出现天文数字
  const maxValue = points.reduce((max, point) => Math.max(max, point.value), 0);
  return points.filter((point) => point.value >= maxValue * 0.001);
}

function normalizeAssetType(value) {
  const raw = valueOf(value).toLowerCase();
  if (raw.includes("cash")) return "cash";
  if (raw.includes("opt")) return "option";
  if (raw.includes("fund") || raw.includes("etf")) return "etf";
  return "stock";
}

function normalizeRegion(value) {
  const raw = valueOf(value).toUpperCase();
  if (["USD", "US", "NYSE", "NASDAQ", "ARCA", "AMEX"].some((item) => raw.includes(item))) return "US";
  if (["HKD", "HK", "SEHK"].some((item) => raw.includes(item))) return "HK";
  if (["CNY", "CN", "SSE", "SZSE"].some((item) => raw.includes(item))) return "CN";
  if (["EUR", "LSE", "IBIS", "FWB", "EU"].some((item) => raw.includes(item))) return "EU";
  return raw || "US";
}

function maskAccount(account) {
  const raw = valueOf(account);
  if (!raw) return "IBKR";
  if (raw.length <= 4) return raw;
  return `${raw.slice(0, 1)}****${raw.slice(-4)}`;
}

function formatDate(value) {
  const raw = valueOf(value);
  if (!raw) return "";
  const match = raw.match(/\d{4}-?\d{2}-?\d{2}/);
  if (!match) return raw.slice(0, 10);
  const compact = match[0].replaceAll("-", "");
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function valueOf(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function num(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = num(value);
    if (parsed !== 0) return parsed;
  }
  return 0;
}

function safeDiv(a, b) {
  return b ? a / b : 0;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
