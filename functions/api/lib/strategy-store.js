// 调仓模型策略配置持久化
//
// 配置含：策略桶目标权重/带宽、信号阈值、手动补录持仓（国内 QDII）。
// 存 JSON 到服务器文件（compose 挂卷 ./data:/data），容器重建不丢。
// 原子写：先写临时文件再 rename，避免写一半进程崩掉导致 JSON 损坏。

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_STRATEGY = {
  version: 1,
  sleeves: [
    { id: "nasdaq-tech", name: "纳指科技", target: 20, band: 5 },
    { id: "nasdaq100", name: "纳指100", target: 45, band: 5 },
    { id: "sp500", name: "标普500", target: 10, band: 5 },
    { id: "semiconductor", name: "半导体", target: 10, band: 5 },
    { id: "individual", name: "个股/其他", target: 5, band: 5 },
    { id: "crypto", name: "加密资产", target: 0, band: 5 },
    { id: "cash", name: "现金", target: 10, band: 5 },
  ],
  params: {
    drawdownNormal: -10, // 常规调整阈值（%）
    drawdownBear: -20, // 熊市/系统性危机阈值（%）
    drawdownLeverage: -7, // 回调≥7% 且利空不可持续 → 可启用融资（纳指框架·回撤篇）
    premiumCheap: 2, // QDII 溢价便宜线（%）
    premiumFair: 5, // 溢价合理线（%）
    premiumExpensive: 20, // 溢价昂贵线（%）
    topPremium: 8, // 顶部信号：场内纳指100 溢价线（%）
    rallyDays: 5, // 顶部信号：加速上涨观察天数
    rallyDailyGain: 1, // 顶部信号：近 N 日日均涨幅线（%）
    leverageWarn: 2.5, // 杠杆警示倍数
    leverageDanger: 3, // 杠杆危险倍数
    fgExtremeFear: 25, // 恐慌贪婪极端恐惧线
    fgExtremeGreed: 75, // 极端贪婪线
    smaTrendDays: 200, // 趋势均线天数
    cnyUsd: 0.14, // 人民币→美元估算汇率（手动持仓估值用）
  },
  manualPositions: [],
};

function filePath(env = {}) {
  return env.STRATEGY_FILE || "/data/strategy.json";
}

// 读配置；文件不存在/损坏时返回内置默认（不自动落盘，等首次保存）
export function loadStrategy(env = {}) {
  try {
    const raw = fs.readFileSync(filePath(env), "utf8");
    const parsed = JSON.parse(raw);
    return normalizeStrategy(parsed);
  } catch {
    return structuredClone(DEFAULT_STRATEGY);
  }
}

// 校验并存盘；校验失败抛错（含 message），调用方转 400
export function saveStrategy(input, env = {}) {
  const strategy = normalizeStrategy(input);
  const error = validateStrategy(strategy);
  if (error) throw new Error(error);

  const file = filePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(strategy, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return strategy;
}

export function validateStrategy(strategy) {
  if (!Array.isArray(strategy.sleeves) || strategy.sleeves.length === 0) {
    return "策略桶不能为空";
  }
  const ids = new Set();
  for (const sleeve of strategy.sleeves) {
    if (!sleeve.id || ids.has(sleeve.id)) return `策略桶 id 非法或重复：${sleeve.id}`;
    ids.add(sleeve.id);
    if (!Number.isFinite(sleeve.target) || sleeve.target < 0 || sleeve.target > 100) {
      return `目标权重须在 0–100：${sleeve.name}`;
    }
    if (!Number.isFinite(sleeve.band) || sleeve.band < 0 || sleeve.band > 100) {
      return `带宽须在 0–100：${sleeve.name}`;
    }
  }
  const sum = strategy.sleeves.reduce((acc, sleeve) => acc + sleeve.target, 0);
  if (Math.abs(sum - 100) > 0.01) return `目标权重合计须为 100%，当前为 ${round(sum)}%`;

  const p = strategy.params;
  const thresholdFields = [
    "drawdownNormal",
    "drawdownBear",
    "drawdownLeverage",
    "premiumCheap",
    "premiumFair",
    "premiumExpensive",
    "topPremium",
    "rallyDays",
    "rallyDailyGain",
    "leverageWarn",
    "leverageDanger",
    "fgExtremeFear",
    "fgExtremeGreed",
    "smaTrendDays",
    "cnyUsd",
  ];
  for (const field of thresholdFields) {
    if (!Number.isFinite(Number(p[field]))) return `参数非法：${field}`;
  }
  if (!Array.isArray(strategy.manualPositions)) return "手动持仓格式非法";
  for (const row of strategy.manualPositions) {
    if (!row.symbol || !Number.isFinite(Number(row.qty)) || Number(row.qty) <= 0) {
      return "手动持仓须包含代码和正数量";
    }
  }
  return "";
}

// 容错归一：补齐缺失字段、强制类型，兼容旧版/前端不完整提交
function normalizeStrategy(input) {
  const fallback = DEFAULT_STRATEGY;
  const sleeves = (Array.isArray(input?.sleeves) && input.sleeves.length ? input.sleeves : fallback.sleeves).map(
    (sleeve) => ({
      id: String(sleeve.id),
      name: String(sleeve.name ?? sleeve.id),
      target: Number(sleeve.target),
      band: Number(sleeve.band),
    })
  );
  const params = { ...fallback.params, ...(input?.params || {}) };
  for (const key of Object.keys(params)) params[key] = Number(params[key]);

  const manualPositions = (Array.isArray(input?.manualPositions) ? input.manualPositions : []).map((row) => ({
    symbol: String(row.symbol || "").trim(),
    qty: Number(row.qty),
    cost: Number(row.cost) || 0,
    note: String(row.note || ""),
  }));

  return { version: 1, sleeves, params, manualPositions };
}

function round(value) {
  return Math.round(value * 100) / 100;
}
