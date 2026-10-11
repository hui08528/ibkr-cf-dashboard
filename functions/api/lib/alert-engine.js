// 告警引擎 —— 后台评估 + 冷却 + 钉钉派发
//
// 数据来源全部复用现有模块：
// - premium_cross：cn-premium.fetchQdiiPremium(symbol, price)（自带 1h 净值缓存，
//   生产走国内云函数，东京 VPS 不直连腾讯/新浪）
// - price_cross / price_change_percent：quote-stream.getLatest（长桥 WS 实时价），
//   无 WS 值时回退 market 快照价
// 评估频率由 server.js 的 setInterval 控制（默认 45s，ALERT_INTERVAL_SECONDS 可调）。
// 冷却：单条规则 lastTriggeredAt + cooldownSeconds 防轰炸；冷却状态落盘到 /data/alerts.json。

import { loadAlerts, saveAlerts } from "./alert-store.js";
import { fetchQdiiPremium } from "./cn-premium.js";
import { getLatest } from "./quote-stream.js";
import { sendToDingtalk } from "./dingtalk.js";
import { usInstruments, cnInstruments } from "../market.js";

const NAME_BY_SYMBOL = new Map();
const LONG_BRIDGE_BY_SYMBOL = new Map();
for (const instrument of [...usInstruments, ...cnInstruments]) {
  NAME_BY_SYMBOL.set(instrument.symbol, instrument.nameCn || instrument.name || instrument.symbol);
  const lbSymbol = instrument.longbridgeSymbol || `${instrument.symbol}.US`;
  LONG_BRIDGE_BY_SYMBOL.set(instrument.symbol, lbSymbol);
}

function symbolName(symbol) {
  return NAME_BY_SYMBOL.get(symbol) || symbol;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(value) {
  const n = num(value);
  return n === null ? "-" : `${n >= 0 ? "+" : ""}${Math.round(n * 100) / 100}%`;
}

function fmtNum(value, digits = 4) {
  const n = num(value);
  return n === null ? "-" : String(Math.round(n * 10 ** digits) / 10 ** digits);
}

function nowLabel() {
  return new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

// 取实时行情：优先长桥 WS 内存价；无 WS 值时回退长桥一次性 REST 查询（自备超时）。
// 返回 { price, previousClose, changePercent } 或 null。派生涨跌幅（quote-stream 不直接给）。
function resolveLatest(symbol) {
  try {
    const quote = getLatest(symbol);
    if (!quote) return null;
    const price = num(quote.price);
    const previousClose = num(quote.previousClose);
    const changePercent = price && previousClose ? ((price - previousClose) / previousClose) * 100 : null;
    return { price, previousClose, changePercent };
  } catch {
    return null;
  }
}

async function resolveQuote(symbol, env) {
  const live = resolveLatest(symbol);
  if (live) return live;

  // WS 未启动/未覆盖该标的：一次性 REST 兜底（用 instrument 的长桥代码，如 513100.SH）
  try {
    const { fetchQuote } = await import("./longbridge.js");
    const meta = { symbol, longbridgeSymbol: LONG_BRIDGE_BY_SYMBOL.get(symbol) || `${symbol}.US` };
    const quote = await fetchQuote(symbol, meta);
    const price = num(quote.price);
    const previousClose = num(quote.previousClose);
    if (!price || price <= 0) return null;
    const changePercent = previousClose ? ((price - previousClose) / previousClose) * 100 : null;
    return { price, previousClose, changePercent };
  } catch {
    return null;
  }
}

// 评估单条规则 → { triggered, skipped, observedValue, detail, reason }
export async function evaluateRule(rule, env = {}) {
  const { kind, symbol, params } = rule;

  if (kind === "premium_cross") {
    const live = await resolveQuote(symbol, env);
    const price = live?.price || null;
    if (!price || price <= 0) return { triggered: false, skipped: true, reason: "无实时价格" };
    const info = await fetchQdiiPremium(symbol, price).catch(() => null);
    if (!info || info.premiumRate === null || info.premiumRate === undefined) {
      return { triggered: false, skipped: true, reason: "溢价率不可用" };
    }
    const value = Number(params.value);
    const triggered =
      params.direction === "above" ? info.premiumRate >= value : info.premiumRate <= value;
    return {
      triggered,
      observedValue: info.premiumRate,
      detail: { price, iopv: info.iopv, nav: info.nav, navDate: info.navDate },
    };
  }

  if (kind === "price_cross") {
    const live = await resolveQuote(symbol, env);
    const price = live?.price;
    if (!price || price <= 0) return { triggered: false, skipped: true, reason: "无实时价格" };
    const target = Number(params.price);
    const triggered = params.direction === "above" ? price >= target : price <= target;
    return { triggered, observedValue: price };
  }

  if (kind === "price_change_percent") {
    const live = await resolveQuote(symbol, env);
    const changePercent = live?.changePercent;
    if (changePercent === null || changePercent === undefined) {
      return { triggered: false, skipped: true, reason: "无涨跌幅" };
    }
    const threshold = Math.abs(Number(params.changePct));
    const triggered = params.direction === "up" ? changePercent >= threshold : changePercent <= -threshold;
    return { triggered, observedValue: changePercent };
  }

  return { triggered: false, skipped: true, reason: `未知类型 ${kind}` };
}

function buildMessage(rule, result) {
  const name = symbolName(rule.symbol);
  const icon =
    rule.severity === "critical" ? "🚨" : rule.severity === "warning" ? "⚠️" : "🔔";
  const lines = [];

  if (rule.kind === "premium_cross") {
    const direction = rule.params.direction === "above" ? "上穿" : "跌破";
    lines.push(`### ${icon} ${rule.symbol} 溢价告警`);
    lines.push(`- ${name}`);
    lines.push(
      `- 当前溢价：${fmtPct(result.observedValue)}` +
        (result.detail?.iopv ? `（IOPV ${fmtNum(result.detail.iopv)}）` : "")
    );
    lines.push(`- 阈值：${direction} ${Number(rule.params.value)}%`);
  } else if (rule.kind === "price_cross") {
    const direction = rule.params.direction === "above" ? "上穿" : "跌破";
    lines.push(`### ${icon} ${rule.symbol} 价格告警`);
    lines.push(`- ${name}`);
    lines.push(`- 当前价：${fmtNum(result.observedValue)}`);
    lines.push(`- 阈值：${direction} ${Number(rule.params.price)}`);
  } else if (rule.kind === "price_change_percent") {
    const direction = rule.params.direction === "up" ? "上涨" : "下跌";
    lines.push(`### ${icon} ${rule.symbol} 涨跌幅告警`);
    lines.push(`- ${name}`);
    lines.push(`- 当前涨跌：${fmtPct(result.observedValue)}`);
    lines.push(`- 阈值：${direction} ≥ ${Number(rule.params.changePct)}%`);
  }

  lines.push(`- 时间：${nowLabel()}`);
  return lines.join("\n");
}

// A 股交易时段（北京时间，UTC+8，无夏令时）：周一至周五 9:30-11:30 / 13:00-15:00
export function isCnTradingHours(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
}

/**
 * 后台评估一轮：评估全部启用规则 → 触发且过冷却 → 钉钉推送 → 更新 lastTriggeredAt 落盘。
 * 单条规则异常只记日志，不影响其他规则；整个周期绝不抛出（server.js 的 setInterval 兜底）。
 * @returns {Promise<{evaluated: number, triggered: number, notified: number, reason?: string}>}
 */
export async function runAlertCycle(env = process.env) {
  if (String(env.ALERT_ENABLED || "true").toLowerCase() === "false") {
    return { evaluated: 0, triggered: 0, notified: 0, reason: "ALERT_ENABLED=false" };
  }

  const all = loadAlerts(env);
  const enabled = all.filter((rule) => rule.enabled);
  if (!enabled.length) return { evaluated: 0, triggered: 0, notified: 0 };

  if (String(env.ALERT_TRADING_HOURS_ONLY || "false").toLowerCase() === "true" && !isCnTradingHours()) {
    return { evaluated: 0, triggered: 0, notified: 0, reason: "非交易时段" };
  }

  const now = Date.now();
  let triggered = 0;
  let notified = 0;
  let dirty = false;

  for (const rule of enabled) {
    try {
      const result = await evaluateRule(rule, env);
      if (!result.triggered) continue;
      triggered += 1;

      // 冷却：距上次触发不足 cooldownSeconds 则跳过推送（仍计入 triggered）
      if (rule.lastTriggeredAt) {
        const last = new Date(rule.lastTriggeredAt).getTime();
        if (Number.isFinite(last) && now - last < rule.cooldownSeconds * 1000) continue;
      }

      const message = buildMessage(rule, result);
      const sent = await sendToDingtalk(message, `${rule.symbol} 告警`, env);
      if (sent.ok) {
        rule.lastTriggeredAt = new Date(now).toISOString();
        dirty = true;
        notified += 1;
      }
    } catch (error) {
      console.warn(`[alert-engine] 规则 ${rule.symbol}/${rule.kind} 评估失败: ${error.message}`);
    }
  }

  if (dirty) {
    try {
      saveAlerts(all, env); // all 与 enabled 共享对象引用，冷却状态随对象更新
    } catch (error) {
      console.warn(`[alert-engine] 冷却状态落盘失败: ${error.message}`);
    }
  }
  return { evaluated: enabled.length, triggered, notified };
}

/**
 * 测试推送：立即评估一次并强制发送（无论是否触发），供"测试"接口/按钮使用。
 * @returns {Promise<{evaluated: object, sent: {ok: boolean, errors?: string[]}}>}
 */
export async function testAlert(rule, env = process.env) {
  const result = await evaluateRule(rule, env);
  const message = `${buildMessage(rule, result)}\n> 测试推送（未计入冷却）`;
  const sent = await sendToDingtalk(message, `${rule.symbol} 测试`, env);
  return { evaluated: result, sent };
}
