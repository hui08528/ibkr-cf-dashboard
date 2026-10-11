// 告警规则 REST 接口 —— /api/alerts CRUD + 测试推送
//
// 持久化在 lib/alert-store.js（/data/alerts.json，原子写）；评估/推送在 lib/alert-engine.js。
// 路由注册见 server.js：GET /api/alerts、POST /api/alerts、
// PUT/DELETE /api/alerts/:id、POST /api/alerts/:id/test。
// 已受宿主 nginx Basic Auth 保护。

import { loadAlerts, saveAlerts, validateAlert, normalizeAlert } from "./lib/alert-store.js";
import { testAlert } from "./lib/alert-engine.js";

function send(res, status, body) {
  return res.status(status).json(body);
}

export async function listAlerts(req, res, env = process.env) {
  try {
    return send(res, 200, { alerts: loadAlerts(env) });
  } catch (error) {
    return send(res, 500, { error: "Failed to load alerts", message: error.message });
  }
}

export async function createAlert(req, res, env = process.env) {
  try {
    const alert = normalizeAlert({ ...req.body, id: undefined }); // 新规则重新生成 id
    const error = validateAlert(alert);
    if (error) return send(res, 400, { error, message: error });
    const alerts = loadAlerts(env);
    alerts.push(alert);
    saveAlerts(alerts, env);
    return send(res, 201, { alert });
  } catch (error) {
    return send(res, 400, { error: "Invalid alert", message: error.message });
  }
}

export async function updateAlert(req, res, env = process.env) {
  try {
    const id = req.params.id;
    const alerts = loadAlerts(env);
    const index = alerts.findIndex((rule) => rule.id === id);
    if (index === -1) return send(res, 404, { error: "Not found", message: `alert ${id} 不存在` });

    const merged = normalizeAlert({ ...alerts[index], ...req.body, id });
    const error = validateAlert(merged);
    if (error) return send(res, 400, { error, message: error });

    alerts[index] = merged;
    saveAlerts(alerts, env);
    return send(res, 200, { alert: merged });
  } catch (error) {
    return send(res, 400, { error: "Invalid alert", message: error.message });
  }
}

export async function deleteAlert(req, res, env = process.env) {
  try {
    const id = req.params.id;
    const alerts = loadAlerts(env);
    const next = alerts.filter((rule) => rule.id !== id);
    if (next.length === alerts.length) {
      return send(res, 404, { error: "Not found", message: `alert ${id} 不存在` });
    }
    saveAlerts(next, env);
    return send(res, 200, { ok: true });
  } catch (error) {
    return send(res, 500, { error: "Failed to delete alert", message: error.message });
  }
}

export async function testAlertEndpoint(req, res, env = process.env) {
  try {
    const id = req.params.id;
    const alerts = loadAlerts(env);
    const rule = alerts.find((item) => item.id === id);
    if (!rule) return send(res, 404, { error: "Not found", message: `alert ${id} 不存在` });

    const outcome = await testAlert(rule, env);
    return send(res, 200, outcome);
  } catch (error) {
    return send(res, 500, { error: "Test failed", message: error.message });
  }
}
