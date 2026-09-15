const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const NOTIFY_COOLDOWN_SECONDS = 120;
const MAX_OCR_IMAGE_BYTES = 4 * 1024 * 1024;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), env);
    try {
      const url = new URL(request.url);
      const route = matchRoute(request.method, url.pathname);
      if (!route) return json({ error: "not_found", message: "接口不存在。" }, 404, env);
      const context = { request, env, url, params: route.params };
      return cors(await route.handler(context), env);
    } catch (error) {
      if (error instanceof ConfigError) {
        return cors(json({ error: "config_error", message: error.message, missing: error.missing }, 503, env), env);
      }
      return cors(json({ error: "server_error", message: error.message || "服务异常。" }, 500, env), env);
    }
  },
};

function matchRoute(method, pathname) {
  const routes = [
    ["GET", /^\/api\/health$/, handleHealth],
    ["POST", /^\/api\/ocr\/plate$/, handlePlateOcr],
    ["POST", /^\/api\/vehicles$/, handleCreateVehicle],
    ["GET", /^\/api\/vehicles\/([^/]+)\/public$/, handlePublicVehicle, ["vehicleToken"]],
    ["POST", /^\/api\/vehicles\/([^/]+)\/notify$/, handleNotify, ["vehicleToken"]],
    ["GET", /^\/api\/owner\/([^/]+)\/vehicle$/, handleOwnerVehicle, ["ownerToken"]],
    ["PATCH", /^\/api\/owner\/([^/]+)\/vehicle$/, handlePatchOwnerVehicle, ["ownerToken"]],
    ["DELETE", /^\/api\/owner\/([^/]+)\/vehicle$/, handleDeleteOwnerVehicle, ["ownerToken"]],
    ["POST", /^\/api\/owner\/([^/]+)\/vehicle\/regenerate-token$/, handleRegenerateVehicleToken, ["ownerToken"]],
  ];
  for (const [routeMethod, pattern, handler, keys = []] of routes) {
    const match = pathname.match(pattern);
    if (method === routeMethod && match) {
      return {
        handler,
        params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])),
      };
    }
  }
  return null;
}

function handleHealth({ env }) {
  const missing = requiredConfig(env).filter((item) => !item.ok).map((item) => item.name);
  return json({
    status: missing.length ? "degraded" : "ok",
    d1: Boolean(env.DB),
    encryption: Boolean(env.DATA_ENCRYPTION_KEY),
    ocrDemo: usesOcrDemo(env),
    tencentOcr: hasTencentOcr(env),
    tencentSms: Boolean(
      env.TENCENT_SECRET_ID &&
        env.TENCENT_SECRET_KEY &&
        env.TENCENT_SMS_APP_ID &&
        env.TENCENT_SMS_SIGN_NAME &&
        env.TENCENT_SMS_TEMPLATE_ID
    ),
    privacyCall: Boolean(env.PRIVACY_CALL_WEBHOOK_URL),
    missing,
  });
}

function cors(response, env) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", env.CORS_ORIGIN || "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function handlePlateOcr({ request, env }) {
  const form = await request.formData();
  const image = form.get("image");
  const imageError = validateOcrImage(image, env);
  if (imageError) return json(imageError, 400);
  if (usesOcrDemo(env)) {
    return json({
      plateNumber: env.OCR_DEMO_PLATE || "粤B12345",
      candidates: [{ plateNumber: env.OCR_DEMO_PLATE || "粤B12345", color: "demo" }],
      demo: true,
    });
  }
  assertConfig(env, ["TENCENT_SECRET_ID", "TENCENT_SECRET_KEY"]);
  const bytes = new Uint8Array(await image.arrayBuffer());
  const imageBase64 = bytesToBase64(bytes);
  const result = await tencentApi(env, {
    service: "ocr",
    host: "ocr.tencentcloudapi.com",
    version: "2018-11-19",
    action: "LicensePlateOCR",
    region: env.TENCENT_OCR_REGION || "ap-guangzhou",
    payload: { ImageBase64: imageBase64 },
  });
  const plateNumber = result.Number || result.PlateNumber || result.LicensePlateInfos?.[0]?.Number || "";
  return json({
    plateNumber,
    candidates: plateNumber ? [{ plateNumber, color: result.Color || "" }] : [],
    rawRequestId: result.RequestId,
  });
}

function isOcrDemo(env) {
  return String(env.OCR_DEMO_MODE || "").toLowerCase() === "true";
}

function hasTencentOcr(env) {
  return Boolean(env.TENCENT_SECRET_ID && env.TENCENT_SECRET_KEY);
}

function usesOcrDemo(env) {
  return isOcrDemo(env) && !hasTencentOcr(env);
}

function validateOcrImage(image, env) {
  if (!image || typeof image === "string") {
    return { error: "missing_image", message: "请上传车牌照片。" };
  }
  const maxBytes = Number(env.MAX_OCR_IMAGE_BYTES || MAX_OCR_IMAGE_BYTES);
  if (image.size > maxBytes) {
    return { error: "image_too_large", message: `图片不能超过 ${Math.floor(maxBytes / 1024 / 1024)}MB。` };
  }
  if (image.type && !image.type.startsWith("image/")) {
    return { error: "invalid_image_type", message: "请上传 JPG、PNG、HEIC 等图片文件。" };
  }
  return null;
}

async function handleCreateVehicle({ request, env }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const input = await readJson(request);
  const plateNumber = normalizePlate(input.plateNumber);
  const validationError = validateVehicleInput(input, { requireNotification: true });
  if (validationError) return json(validationError, 400);

  const vehicleToken = await token("veh");
  const ownerToken = await token("own");
  const now = nowIso();
  const encryptedPhone = input.ownerPhone ? await encryptText(env, normalizePhone(input.ownerPhone)) : null;
  const encryptedShowdocToken = input.showdocToken ? await encryptText(env, input.showdocToken) : null;
  const encryptedWechatWorkWebhook = input.wechatWorkWebhook ? await encryptText(env, normalizeHttpUrl(input.wechatWorkWebhook)) : null;

  await env.DB.prepare(
    `INSERT INTO vehicles (
      vehicle_token, owner_token, plate_number_masked, plate_number_hash,
      owner_phone_encrypted, showdoc_webhook, showdoc_token_encrypted,
      wechat_work_webhook_encrypted, sms_enabled, privacy_call_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      vehicleToken,
      ownerToken,
      maskPlate(plateNumber),
      await sha256Hex(plateNumber),
      encryptedPhone,
      input.showdocWebhook ? normalizeHttpUrl(input.showdocWebhook) : "",
      encryptedShowdocToken,
      encryptedWechatWorkWebhook,
      input.smsEnabled ? 1 : 0,
      input.privacyCallEnabled ? 1 : 0,
      now,
      now
    )
    .run();

  return json({ vehicleToken, ownerToken, maskedPlate: maskPlate(plateNumber) }, 201);
}

async function handlePublicVehicle({ env, params }) {
  assertConfig(env, ["DB"]);
  const vehicle = await getVehicleByToken(env, params.vehicleToken);
  if (!vehicle) return json({ error: "not_found", message: "车辆不存在。" }, 404);
  return json({
    maskedPlate: vehicle.plate_number_masked,
    availableChannels: availableChannels(vehicle),
  });
}

async function handleNotify({ request, env, params }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const input = await readJson(request);
  const vehicle = await getVehicleByToken(env, params.vehicleToken);
  if (!vehicle) return json({ error: "not_found", message: "车辆不存在。" }, 404);
  const channel = input.channel || defaultNotifyChannel(vehicle);
  if (!channel || !availableChannels(vehicle).includes(channel)) {
    return json({ error: "channel_unavailable", message: "该通知方式尚未配置。" }, 400);
  }

  const visitorHash = await visitorIpHash(request, env);
  const cutoff = new Date(Date.now() - NOTIFY_COOLDOWN_SECONDS * 1000).toISOString();
  const recent = await env.DB.prepare(
    `SELECT id FROM notification_logs
     WHERE vehicle_id = ? AND visitor_ip_hash = ? AND created_at > ?
     ORDER BY id DESC LIMIT 1`
  )
    .bind(vehicle.id, visitorHash, cutoff)
    .first();
  if (recent) return json({ error: "rate_limited", message: "已提醒车主，请勿频繁操作。" }, 429);

  const createdAt = nowIso();
  let status = "sent";
  let errorSummary = "";
  try {
    if (channel === "showdoc") await sendShowDoc(vehicle, env);
    if (channel === "wechat_work") await sendWechatWork(vehicle, env);
    if (channel === "sms") await sendTencentSms(vehicle, env);
    if (channel === "privacy_call") await startPrivacyCall(vehicle, env);
  } catch (error) {
    status = "failed";
    errorSummary = String(error.message || error).slice(0, 300);
  }

  await env.DB.prepare(
    `INSERT INTO notification_logs (vehicle_id, channel, status, error_summary, visitor_ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(vehicle.id, channel, status, errorSummary, visitorHash, createdAt)
    .run();

  if (status === "failed") return json({ error: "notify_failed", message: errorSummary || "通知发送失败。" }, 502);
  return json({ message: "已通知车主，请耐心等待。", channel });
}

async function handleOwnerVehicle({ env, params }) {
  assertConfig(env, ["DB"]);
  const vehicle = await getVehicleByOwnerToken(env, params.ownerToken);
  if (!vehicle) return json({ error: "not_found", message: "管理链接无效。" }, 404);
  const logs = await env.DB.prepare(
    `SELECT channel, status, error_summary, created_at
     FROM notification_logs WHERE vehicle_id = ?
     ORDER BY id DESC LIMIT 10`
  )
    .bind(vehicle.id)
    .all();
  return json({
    vehicleToken: vehicle.vehicle_token,
    maskedPlate: vehicle.plate_number_masked,
    showdocEnabled: Boolean(vehicle.showdoc_webhook),
    wechatWorkEnabled: Boolean(vehicle.wechat_work_webhook_encrypted),
    smsEnabled: Boolean(vehicle.sms_enabled),
    privacyCallEnabled: Boolean(vehicle.privacy_call_enabled),
    recentNotifications: logs.results || [],
  });
}

async function handlePatchOwnerVehicle({ request, env, params }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const vehicle = await getVehicleByOwnerToken(env, params.ownerToken);
  if (!vehicle) return json({ error: "not_found", message: "管理链接无效。" }, 404);
  const input = await readJson(request);
  const validationError = validateVehicleInput(input, { partial: true, hasStoredPhone: Boolean(vehicle.owner_phone_encrypted) });
  if (validationError) return json(validationError, 400);
  const updates = [];
  const values = [];
  if (input.showdocWebhook) {
    updates.push("showdoc_webhook = ?");
    values.push(normalizeHttpUrl(input.showdocWebhook));
  }
  if (input.showdocToken) {
    updates.push("showdoc_token_encrypted = ?");
    values.push(await encryptText(env, input.showdocToken));
  }
  if (input.wechatWorkWebhook) {
    updates.push("wechat_work_webhook_encrypted = ?");
    values.push(await encryptText(env, normalizeHttpUrl(input.wechatWorkWebhook)));
  }
  if (input.ownerPhone) {
    updates.push("owner_phone_encrypted = ?");
    values.push(await encryptText(env, normalizePhone(input.ownerPhone)));
  }
  if (typeof input.smsEnabled === "boolean") {
    updates.push("sms_enabled = ?");
    values.push(input.smsEnabled ? 1 : 0);
  }
  if (typeof input.privacyCallEnabled === "boolean") {
    updates.push("privacy_call_enabled = ?");
    values.push(input.privacyCallEnabled ? 1 : 0);
  }
  if (!updates.length) return json({ message: "没有需要更新的字段。" });
  updates.push("updated_at = ?");
  values.push(nowIso(), vehicle.id);
  await env.DB.prepare(`UPDATE vehicles SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ message: "配置已更新。" });
}

async function handleRegenerateVehicleToken({ env, params }) {
  assertConfig(env, ["DB"]);
  const vehicle = await getVehicleByOwnerToken(env, params.ownerToken);
  if (!vehicle) return json({ error: "not_found", message: "管理链接无效。" }, 404);
  const vehicleToken = await token("veh");
  await env.DB.prepare("UPDATE vehicles SET vehicle_token = ?, updated_at = ? WHERE id = ?")
    .bind(vehicleToken, nowIso(), vehicle.id)
    .run();
  return json({ vehicleToken, maskedPlate: vehicle.plate_number_masked });
}

async function handleDeleteOwnerVehicle({ env, params }) {
  assertConfig(env, ["DB"]);
  const vehicle = await getVehicleByOwnerToken(env, params.ownerToken);
  if (!vehicle) return json({ error: "not_found", message: "管理链接无效。" }, 404);
  await env.DB.prepare("DELETE FROM notification_logs WHERE vehicle_id = ?").bind(vehicle.id).run();
  await env.DB.prepare("DELETE FROM vehicles WHERE id = ?").bind(vehicle.id).run();
  return json({ message: "绑定已删除。" });
}

async function getVehicleByToken(env, vehicleToken) {
  return env.DB.prepare("SELECT * FROM vehicles WHERE vehicle_token = ?").bind(vehicleToken).first();
}

async function getVehicleByOwnerToken(env, ownerToken) {
  return env.DB.prepare("SELECT * FROM vehicles WHERE owner_token = ?").bind(ownerToken).first();
}

function availableChannels(vehicle) {
  const channels = [];
  if (vehicle.showdoc_webhook) channels.push("showdoc");
  if (vehicle.wechat_work_webhook_encrypted) channels.push("wechat_work");
  if (vehicle.sms_enabled && vehicle.owner_phone_encrypted) channels.push("sms");
  if (vehicle.privacy_call_enabled && vehicle.owner_phone_encrypted) channels.push("privacy_call");
  return channels;
}

function defaultNotifyChannel(vehicle) {
  const channels = availableChannels(vehicle);
  return ["wechat_work", "showdoc", "sms", "privacy_call"].find((channel) => channels.includes(channel)) || "";
}

async function sendShowDoc(vehicle, env) {
  const token = vehicle.showdoc_token_encrypted ? await decryptText(env, vehicle.showdoc_token_encrypted) : "";
  const body = new URLSearchParams({
    title: "扫码挪车提醒",
    content: `车辆 ${vehicle.plate_number_masked} 收到挪车提醒，请及时处理。`,
  });
  if (token) body.set("token", token);
  const res = await fetch(vehicle.showdoc_webhook, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body,
  });
  if (!res.ok) throw new Error(`ShowDoc 通知失败：${res.status}`);
  const data = await res.json().catch(() => null);
  if (data && typeof data.error_code !== "undefined" && Number(data.error_code) !== 0) {
    throw new Error(`ShowDoc 通知失败：${data.error_message || data.error_code}`);
  }
}

async function sendWechatWork(vehicle, env) {
  const webhook = await decryptText(env, vehicle.wechat_work_webhook_encrypted);
  const body = {
    msgtype: "text",
    text: {
      content: `扫码挪车提醒：车辆 ${vehicle.plate_number_masked} 收到挪车提醒，请及时处理。`,
    },
  };
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`企业微信通知失败：${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`企业微信通知失败：${data.errmsg || data.errcode}`);
  }
}

async function sendTencentSms(vehicle, env) {
  assertEnv(env, ["TENCENT_SECRET_ID", "TENCENT_SECRET_KEY", "TENCENT_SMS_APP_ID", "TENCENT_SMS_SIGN_NAME", "TENCENT_SMS_TEMPLATE_ID"]);
  const phone = await decryptText(env, vehicle.owner_phone_encrypted);
  const result = await tencentApi(env, {
    service: "sms",
    host: env.TENCENT_SMS_HOST || "sms.tencentcloudapi.com",
    version: "2021-01-11",
    action: "SendSms",
    region: env.TENCENT_SMS_REGION || "ap-guangzhou",
    payload: {
      SmsSdkAppId: env.TENCENT_SMS_APP_ID,
      SignName: env.TENCENT_SMS_SIGN_NAME,
      TemplateId: env.TENCENT_SMS_TEMPLATE_ID,
      TemplateParamSet: [vehicle.plate_number_masked],
      PhoneNumberSet: [toE164(phone, env.DEFAULT_PHONE_COUNTRY_CODE || "+86")],
    },
  });
  const status = result.SendStatusSet?.[0];
  if (status && status.Code !== "Ok") throw new Error(status.Message || status.Code);
}

async function startPrivacyCall(vehicle, env) {
  assertEnv(env, ["PRIVACY_CALL_WEBHOOK_URL"]);
  const phone = await decryptText(env, vehicle.owner_phone_encrypted);
  const res = await fetch(env.PRIVACY_CALL_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: env.PRIVACY_CALL_WEBHOOK_TOKEN ? `Bearer ${env.PRIVACY_CALL_WEBHOOK_TOKEN}` : "",
    },
    body: JSON.stringify({
      phone,
      maskedPlate: vehicle.plate_number_masked,
      vendor: "tencent",
      purpose: "move_car_privacy_call",
    }),
  });
  if (!res.ok) throw new Error(`隐私号呼叫失败：${res.status}`);
}

async function tencentApi(env, { service, host, version, action, region, payload }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const hashedPayload = await sha256Hex(body);
  const canonicalRequest = ["POST", "/", "", `host:${host}\n`, "host", hashedPayload].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = ["TC3-HMAC-SHA256", timestamp, credentialScope, hashedCanonicalRequest].join("\n");
  const secretDate = await hmac(`TC3${env.TENCENT_SECRET_KEY}`, date);
  const secretService = await hmac(secretDate, service);
  const secretSigning = await hmac(secretService, "tc3_request");
  const signature = bytesToHex(await hmac(secretSigning, stringToSign));
  const authorization = `TC3-HMAC-SHA256 Credential=${env.TENCENT_SECRET_ID}/${credentialScope}, SignedHeaders=host, Signature=${signature}`;

  const res = await fetch(`https://${host}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: host,
      "X-TC-Action": action,
      "X-TC-Version": version,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Region": region,
      Authorization: authorization,
    },
    body,
  });
  const data = await res.json();
  if (!res.ok || data.Response?.Error) {
    throw new Error(data.Response?.Error?.Message || `腾讯云 ${action} 调用失败：${res.status}`);
  }
  return data.Response;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function assertEnv(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) throw new Error(`缺少环境变量：${missing.join(", ")}`);
}

function requiredConfig(env) {
  return [
    { name: "DB", ok: Boolean(env.DB) },
    { name: "DATA_ENCRYPTION_KEY", ok: Boolean(env.DATA_ENCRYPTION_KEY) },
    { name: "TENCENT_SECRET_ID", ok: usesOcrDemo(env) || Boolean(env.TENCENT_SECRET_ID) },
    { name: "TENCENT_SECRET_KEY", ok: usesOcrDemo(env) || Boolean(env.TENCENT_SECRET_KEY) },
  ];
}

function assertConfig(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    throw new ConfigError(`后端配置不完整：${missing.join(", ")}`, missing);
  }
}

class ConfigError extends Error {
  constructor(message, missing) {
    super(message);
    this.name = "ConfigError";
    this.missing = missing;
  }
}

async function token(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `${prefix}_${bytesToBase64Url(bytes)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePlate(value) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

function normalizeHttpUrl(value) {
  return new URL(String(value || "").trim()).toString();
}

function normalizePhone(value) {
  return String(value || "").trim().replace(/[\s-]/g, "");
}

function validateVehicleInput(input, { requireNotification = false, partial = false, hasStoredPhone = false } = {}) {
  const plate = normalizePlate(input.plateNumber);
  if (!partial && !/^[\u4e00-\u9fa5A-Z0-9]{5,10}$/.test(plate)) {
    return { error: "invalid_plate", message: "请填写有效车牌号。" };
  }
  if (requireNotification && !input.showdocWebhook && !input.wechatWorkWebhook && !input.smsEnabled && !input.privacyCallEnabled) {
    return { error: "missing_notification_channel", message: "请至少配置 ShowDoc、微信、短信或隐私号中的一种通知方式。" };
  }
  if (input.showdocWebhook) {
    if (!isHttpUrl(input.showdocWebhook)) {
      return { error: "invalid_showdoc_webhook", message: "ShowDoc Webhook 必须是 http 或 https 地址。" };
    }
  }
  if (input.wechatWorkWebhook && !isHttpUrl(input.wechatWorkWebhook)) {
    return { error: "invalid_wechat_work_webhook", message: "企业微信机器人 Webhook 必须是 http 或 https 地址。" };
  }
  const requiresPhone = Boolean(input.smsEnabled || input.privacyCallEnabled);
  if ((requiresPhone && !hasStoredPhone) || input.ownerPhone) {
    if (!isPhone(input.ownerPhone)) {
      return { error: "invalid_phone", message: "请填写有效手机号，或关闭短信/隐私号通知。" };
    }
  }
  return null;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function isPhone(value) {
  return /^\+?\d[\d\s-]{6,19}$/.test(String(value || "").trim());
}

function maskPlate(value) {
  const plate = normalizePlate(value);
  if (plate.length <= 3) return "***";
  return `${plate.slice(0, 2)}***${plate.slice(-2)}`;
}

async function visitorIpHash(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown";
  return sha256Hex(`${env.IP_HASH_SALT || "move-car"}:${ip}`);
}

async function encryptText(env, value) {
  assertEnv(env, ["DATA_ENCRYPTION_KEY"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env.DATA_ENCRYPTION_KEY);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

async function decryptText(env, value) {
  assertEnv(env, ["DATA_ENCRYPTION_KEY"]);
  const [ivText, cipherText] = String(value).split(".");
  const iv = base64UrlToBytes(ivText);
  const cipher = base64UrlToBytes(cipherText);
  const key = await encryptionKey(env.DATA_ENCRYPTION_KEY);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(decrypted);
}

async function encryptionKey(secret) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sha256Hex(value) {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return bytesToHex(new Uint8Array(digest));
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value) {
  const base64 = String(value || "").replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toE164(phone, countryCode) {
  const trimmed = String(phone || "").trim();
  if (trimmed.startsWith("+")) return trimmed;
  return `${countryCode}${trimmed.replace(/^0+/, "")}`;
}
