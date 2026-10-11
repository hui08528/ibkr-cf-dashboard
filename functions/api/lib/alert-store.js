// 告警规则持久化 —— 镜像 strategy-store.js：JSON 文件原子写（tmp+rename）。
// 存 env.ALERT_FILE（默认 /data/alerts.json，compose 挂卷 ./data:/data），容器重建不丢。
//
// 规则 schema：
// {
//   id, name, enabled,
//   kind: "premium_cross" | "price_cross" | "price_change_percent",
//   symbol,
//   params: { direction, ... },
//   severity: "info" | "warning" | "critical",
//   cooldownSeconds,
//   lastTriggeredAt: ISO 或 null
// }

import fs from "node:fs";
import path from "node:path";

export const ALERT_KINDS = ["premium_cross", "price_cross", "price_change_percent"];
export const SEVERITIES = ["info", "warning", "critical"];

const DIRECTIONS_BY_KIND = {
  premium_cross: ["above", "below"],
  price_cross: ["above", "below"],
  price_change_percent: ["up", "down"],
};

function alertFile(env = {}) {
  return env.ALERT_FILE || "/data/alerts.json";
}

// 读规则；文件不存在/损坏返回空数组（不自动落盘，等首次保存）
export function loadAlerts(env = {}) {
  try {
    const raw = fs.readFileSync(alertFile(env), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeAlert).filter(Boolean);
  } catch {
    return [];
  }
}

// 校验并存盘；校验失败抛错（含 message），调用方转 400
export function saveAlerts(alerts, env = {}) {
  if (!Array.isArray(alerts)) throw new Error("alerts must be an array");
  const normalized = alerts.map(normalizeAlert).filter(Boolean);
  const error = validateAlerts(normalized);
  if (error) throw new Error(error);

  const file = alertFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return normalized;
}

export function validateAlerts(alerts) {
  const seen = new Set();
  for (const alert of alerts) {
    if (!alert.id) return "规则缺少 id";
    if (seen.has(alert.id)) return `规则 id 重复: ${alert.id}`;
    seen.add(alert.id);
    const error = validateAlert(alert);
    if (error) return error;
  }
  return "";
}

export function validateAlert(alert) {
  if (!alert || typeof alert !== "object") return "规则不能为空";
  if (!ALERT_KINDS.includes(alert.kind)) return `不支持的告警类型: ${alert.kind}`;
  if (!alert.symbol || !String(alert.symbol).trim()) return "标的代码不能为空";

  const params = alert.params || {};
  const directions = DIRECTIONS_BY_KIND[alert.kind];
  if (!directions.includes(params.direction)) return `direction 非法: ${params.direction}`;

  if (alert.kind === "premium_cross" && !Number.isFinite(Number(params.value))) return "溢价阈值必须是数字";
  if (alert.kind === "price_cross" && (!Number.isFinite(Number(params.price)) || Number(params.price) <= 0)) {
    return "价格阈值必须是正数";
  }
  if (alert.kind === "price_change_percent" && !Number.isFinite(Number(params.changePct))) return "涨跌幅阈值必须是数字";

  if (!SEVERITIES.includes(alert.severity)) return `severity 非法: ${alert.severity}`;
  if (!Number.isFinite(Number(alert.cooldownSeconds)) || Number(alert.cooldownSeconds) < 0) return "cooldownSeconds 非法";
  return "";
}

// 容错归一：补齐字段、强制类型，兼容前端不完整提交
export function normalizeAlert(input) {
  if (!input || typeof input !== "object") return null;
  const params = input.params || {};
  const kind = String(input.kind || "");
  const normalized = {
    id: String(input.id || newUuid()),
    name: String(input.name || input.symbol || ""),
    enabled: input.enabled !== false,
    kind,
    symbol: String(input.symbol || "").trim(),
    params: { direction: String(params.direction || (kind === "price_change_percent" ? "up" : "above")) },
    severity: String(input.severity || "warning"),
    cooldownSeconds: Number(input.cooldownSeconds) || 3600,
    lastTriggeredAt: input.lastTriggeredAt ? String(input.lastTriggeredAt) : null,
  };
  if (kind === "premium_cross") normalized.params.value = Number(params.value);
  if (kind === "price_cross") normalized.params.price = Number(params.price);
  if (kind === "price_change_percent") normalized.params.changePct = Number(params.changePct);
  return normalized;
}

function newUuid() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
