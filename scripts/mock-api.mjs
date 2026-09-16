import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(process.cwd(), "public");
const port = Number(process.env.PORT || 8787);
const vehicles = new Map();
const notificationLogs = [];
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function createMockServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (error) {
      return sendJson(res, 500, { error: "server_error", message: error.message || "Mock 服务异常。" });
    }
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      status: "ok",
      d1: true,
      encryption: true,
      tencentOcr: false,
      tencentSms: false,
      privacyCall: false,
      missing: [],
      mock: true,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/ocr/plate") {
    await readBody(req);
    return sendJson(res, 200, {
      plateNumber: process.env.MOCK_PLATE || "粤B12345",
      candidates: [{ plateNumber: process.env.MOCK_PLATE || "粤B12345", color: "blue" }],
      mock: true,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/vehicles") {
    const input = await readJson(req);
    if (!input.plateNumber) return sendJson(res, 400, { error: "missing_plate", message: "请确认车牌号。" });
    if (!input.showdocWebhook) return sendJson(res, 400, { error: "missing_showdoc", message: "请填写 ShowDoc Webhook。" });
    const vehicleToken = token("veh");
    const ownerToken = token("own");
    const vehicle = {
      id: vehicles.size + 1,
      vehicleToken,
      ownerToken,
      maskedPlate: maskPlate(input.plateNumber),
      phonePrivate: input.ownerPhone || "",
      showdocPrivate: input.showdocWebhook || "",
      showdocTokenPrivate: input.showdocToken || "",
      wechatWorkWebhook: input.wechatWorkWebhook || "",
      smsEnabled: Boolean(input.smsEnabled),
      privacyCallEnabled: Boolean(input.privacyCallEnabled),
      createdAt: new Date().toISOString(),
    };
    vehicles.set(vehicleToken, vehicle);
    vehicles.set(ownerToken, vehicle);
    return sendJson(res, 201, { vehicleToken, ownerToken, maskedPlate: vehicle.maskedPlate });
  }

  const publicMatch = url.pathname.match(/^\/api\/vehicles\/([^/]+)\/public$/);
  if (req.method === "GET" && publicMatch) {
    const vehicle = vehicles.get(decodeURIComponent(publicMatch[1]));
    if (!vehicle) return sendJson(res, 404, { error: "not_found", message: "车辆不存在。" });
    return sendJson(res, 200, publicVehicle(vehicle));
  }

  const notifyMatch = url.pathname.match(/^\/api\/vehicles\/([^/]+)\/notify$/);
  if (req.method === "POST" && notifyMatch) {
    const vehicle = vehicles.get(decodeURIComponent(notifyMatch[1]));
    if (!vehicle) return sendJson(res, 404, { error: "not_found", message: "车辆不存在。" });
    const input = await readJson(req);
    const channel = input.channel || "showdoc";
    if (!publicVehicle(vehicle).availableChannels.includes(channel)) {
      return sendJson(res, 400, { error: "channel_unavailable", message: "该通知方式尚未配置。" });
    }
    const visitorHash = hash(req.socket.remoteAddress || "local");
    const recent = notificationLogs.find(
      (log) => log.vehicleToken === vehicle.vehicleToken && log.visitorHash === visitorHash && Date.now() - log.time < 120000
    );
    if (recent) return sendJson(res, 429, { error: "rate_limited", message: "已提醒车主，请勿频繁操作。" });
    notificationLogs.push({ vehicleToken: vehicle.vehicleToken, visitorHash, channel, status: "sent", time: Date.now() });
    return sendJson(res, 200, { message: `Mock 已发送 ${channel} 通知。` });
  }

  const ownerMatch = url.pathname.match(/^\/api\/owner\/([^/]+)\/vehicle$/);
  if (ownerMatch) {
    const vehicle = vehicles.get(decodeURIComponent(ownerMatch[1]));
    if (!vehicle) return sendJson(res, 404, { error: "not_found", message: "管理链接无效。" });
    if (req.method === "GET") {
      return sendJson(res, 200, {
        vehicleToken: vehicle.vehicleToken,
        maskedPlate: vehicle.maskedPlate,
        showdocEnabled: Boolean(vehicle.showdocPrivate),
        smsEnabled: vehicle.smsEnabled,
        privacyCallEnabled: vehicle.privacyCallEnabled,
        recentNotifications: notificationLogs
          .filter((log) => log.vehicleToken === vehicle.vehicleToken)
          .map(({ channel, status, time }) => ({ channel, status, created_at: new Date(time).toISOString() })),
      });
    }
    if (req.method === "PATCH") {
      const input = await readJson(req);
      if (input.showdocWebhook) vehicle.showdocPrivate = input.showdocWebhook;
      if (input.showdocToken) vehicle.showdocTokenPrivate = input.showdocToken;
      if (input.wechatWorkWebhook) vehicle.wechatWorkWebhook = input.wechatWorkWebhook;
      if (input.ownerPhone) vehicle.phonePrivate = input.ownerPhone;
      if (typeof input.smsEnabled === "boolean") vehicle.smsEnabled = input.smsEnabled;
      if (typeof input.privacyCallEnabled === "boolean") vehicle.privacyCallEnabled = input.privacyCallEnabled;
      return sendJson(res, 200, { message: "配置已更新。" });
    }
    if (req.method === "DELETE") {
      vehicles.delete(vehicle.vehicleToken);
      vehicles.delete(vehicle.ownerToken);
      return sendJson(res, 200, { message: "绑定已删除。" });
    }
  }

  const regenMatch = url.pathname.match(/^\/api\/owner\/([^/]+)\/vehicle\/regenerate-token$/);
  if (req.method === "POST" && regenMatch) {
    const vehicle = vehicles.get(decodeURIComponent(regenMatch[1]));
    if (!vehicle) return sendJson(res, 404, { error: "not_found", message: "管理链接无效。" });
    const newToken = token("veh");
    vehicles.delete(vehicle.vehicleToken);
    vehicles.set(newToken, { ...vehicle, vehicleToken: newToken });
    return sendJson(res, 200, { vehicleToken: newToken, maskedPlate: vehicle.maskedPlate });
  }

  return sendJson(res, 404, { error: "not_found", message: "接口不存在。" });
}

async function serveStatic(_req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(root, pathname));
  if (!filePath.startsWith(root)) return send(res, 403, "Forbidden");
  try {
    const body = await readFile(filePath);
    return send(res, 200, body, types[extname(filePath)] || "application/octet-stream");
  } catch {
    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

function publicVehicle(vehicle) {
  const availableChannels = ["showdoc"];
  if (vehicle.wechatWorkWebhook) availableChannels.push("wechat_work");
  if (vehicle.smsEnabled && vehicle.phonePrivate) availableChannels.push("sms");
  if (vehicle.privacyCallEnabled && vehicle.phonePrivate) availableChannels.push("privacy_call");
  return { maskedPlate: vehicle.maskedPlate, availableChannels };
}

function sendJson(res, status, body) {
  return send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": contentType,
  });
  res.end(body);
}

async function readJson(req) {
  const body = await readBody(req);
  return body ? JSON.parse(body) : {};
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function token(prefix) {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function maskPlate(value) {
  // 全站车牌完整显示（不再用 * 打码）
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createMockServer().listen(port, () => {
    console.log(`Mock app: http://localhost:${port}`);
    console.log("Use the same URL as API address in the front-end forms.");
  });
}
