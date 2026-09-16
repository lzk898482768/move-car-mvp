// 扫码挪车 · Worker 后端（混合通知模型 + 超级管理员 + 车主PIN找回）
// 通知通道：车主可在创建时自带 webhook / 手机号；未配置时回退到管理后台在 D1 配置的全局通道。

// 统一禁用缓存：通道开关/配置改动后，前台与后台都要能立即看到最新状态
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate" };
const NOTIFY_COOLDOWN_SECONDS = 120;
const MAX_OCR_IMAGE_BYTES = 4 * 1024 * 1024;
const ADMIN_SESSION_DAYS = 7;
const RECOVER_MAX_ATTEMPTS = 5;
const RECOVER_WINDOW_SECONDS = 600;

/* ============================================================
   通知通道统一注册表
   —— 所有通知能力都在此声明：所属通道分组、是否开关、可选服务商、所需配置项
   ============================================================ */
const SMS_VENDOR_OPTIONS = [
  { value: "tencent", label: "腾讯云短信" },
  { value: "aliyun", label: "阿里云短信" },
  { value: "custom", label: "自定义短信 Webhook" },
];
const PRIVACY_VENDOR_OPTIONS = [
  { value: "custom", label: "自定义隐私号 Webhook" },
  { value: "tencent", label: "腾讯云号码保护" },
  { value: "aliyun", label: "阿里云号码隐私保护" },
];

// 通道分组（决定超管后台的分区与「是否开通」状态）
const CHANNEL_GROUPS = [
  { key: "wechat_work", label: "企业微信机器人", icon: "💬" },
  { key: "wechat", label: "微信通知（公众号模板消息）", icon: "📨" },
  { key: "sms", label: "短信通知", icon: "📱" },
  { key: "privacy_call", label: "隐私拨号", icon: "☎️" },
  { key: "direct_call", label: "直拨（默认）", icon: "📞" },
];

// 全局通知配置项的元数据。secret=true 的值在 D1 中以 AES-GCM 加密存储。
// type: "bool" 开关 / "select" 下拉；showIf: 仅当某配置项取值命中时才在后台显示
const GLOBAL_SETTINGS = [
  /* ---- 企业微信 ---- */
  { key: "wechat_enabled_global", secret: false, label: "启用企业微信通知", def: "true", group: "wechat_work", type: "bool" },
  { key: "wechat_work_webhook", secret: true, label: "企业微信默认 Webhook", group: "wechat_work" },

  /* ---- 微信通知：公众号模板消息（超管统一配置，车主仅开关） ---- */
  { key: "wechat_notify_enabled_global", secret: false, label: "启用微信通知", def: "true", group: "wechat", type: "bool" },
  { key: "wechat_mp_appid", secret: false, label: "公众号 AppID", group: "wechat" },
  { key: "wechat_mp_secret", secret: true, label: "公众号 AppSecret", group: "wechat" },
  { key: "wechat_mp_template_id", secret: false, label: "模板消息 ID（模板ID）", group: "wechat" },
  { key: "wechat_mp_openid", secret: false, label: "默认接收 OpenID（车主未单独填写时使用）", group: "wechat" },
  { key: "wechat_mp_template_title", secret: false, label: "模板首行文案（可选）", def: "您的爱车收到挪车提醒", group: "wechat" },
  { key: "wechat_mp_template_remark", secret: false, label: "模板备注文案（可选）", def: "请尽快前往挪车，感谢配合。", group: "wechat" },
  { key: "wechat_mp_url", secret: false, label: "模板点击跳转链接（可选）", group: "wechat" },

  /* ---- 短信：多平台 ---- */
  { key: "sms_enabled_global", secret: false, label: "启用短信通知", def: "true", group: "sms", type: "bool" },
  { key: "sms_vendor", secret: false, label: "短信服务商", def: "tencent", group: "sms", type: "select", options: SMS_VENDOR_OPTIONS },
  // 腾讯云短信
  { key: "tencent_secret_id", secret: true, label: "腾讯云 SecretId", group: "sms", showIf: { key: "sms_vendor", in: ["tencent"] } },
  { key: "tencent_secret_key", secret: true, label: "腾讯云 SecretKey", group: "sms", showIf: { key: "sms_vendor", in: ["tencent"] } },
  { key: "tencent_sms_app_id", secret: false, label: "短信 SmsSdkAppId", group: "sms", showIf: { key: "sms_vendor", in: ["tencent"] } },
  { key: "tencent_sms_sign_name", secret: false, label: "短信签名", group: "sms", showIf: { key: "sms_vendor", in: ["tencent"] } },
  { key: "tencent_sms_template_id", secret: false, label: "短信模板 ID", group: "sms", showIf: { key: "sms_vendor", in: ["tencent"] } },
  { key: "tencent_sms_region", secret: false, label: "短信地域", def: "ap-guangzhou", group: "sms", showIf: { key: "sms_vendor", in: ["tencent"] } },
  // 阿里云短信
  { key: "aliyun_access_key_id", secret: true, label: "阿里云 AccessKeyId", group: "sms", showIf: { key: "sms_vendor", in: ["aliyun"] } },
  { key: "aliyun_access_key_secret", secret: true, label: "阿里云 AccessKeySecret", group: "sms", showIf: { key: "sms_vendor", in: ["aliyun"] } },
  { key: "aliyun_sms_sign_name", secret: false, label: "短信签名", group: "sms", showIf: { key: "sms_vendor", in: ["aliyun"] } },
  { key: "aliyun_sms_template_code", secret: false, label: "短信模板 CODE", group: "sms", showIf: { key: "sms_vendor", in: ["aliyun"] } },
  { key: "aliyun_sms_region", secret: false, label: "短信地域", def: "cn-hangzhou", group: "sms", showIf: { key: "sms_vendor", in: ["aliyun"] } },
  // 自定义短信 Webhook
  { key: "sms_custom_webhook", secret: true, label: "短信 Webhook 地址", group: "sms", showIf: { key: "sms_vendor", in: ["custom"] } },
  { key: "sms_custom_token", secret: true, label: "短信 Webhook Token（可选）", group: "sms", showIf: { key: "sms_vendor", in: ["custom"] } },

  /* ---- 隐私号：多平台 ---- */
  { key: "privacy_enabled_global", secret: false, label: "启用隐私号呼叫", def: "true", group: "privacy_call", type: "bool" },
  { key: "privacy_vendor", secret: false, label: "隐私号服务商", def: "custom", group: "privacy_call", type: "select", options: PRIVACY_VENDOR_OPTIONS },
  // 自定义 Webhook（可对接任意平台 / 云函数中转）
  { key: "privacy_call_webhook_url", secret: true, label: "隐私号 Webhook 地址", group: "privacy_call", showIf: { key: "privacy_vendor", in: ["custom"] } },
  { key: "privacy_call_webhook_token", secret: true, label: "隐私号 Webhook Token（可选）", group: "privacy_call", showIf: { key: "privacy_vendor", in: ["custom"] } },
  // 腾讯云号码保护（AXB 绑定，Action/版本可自行调整）
  { key: "privacy_tencent_action", secret: false, label: "腾讯云号码保护 Action", def: "BindNumber", group: "privacy_call", showIf: { key: "privacy_vendor", in: ["tencent"] } },
  { key: "privacy_tencent_version", secret: false, label: "腾讯云号码保护 API 版本", def: "2021-02-22", group: "privacy_call", showIf: { key: "privacy_vendor", in: ["tencent"] } },
  { key: "privacy_tencent_pool_key", secret: false, label: "号码池 Key（PoolKey，可选）", group: "privacy_call", showIf: { key: "privacy_vendor", in: ["tencent"] } },
  // 阿里云号码隐私保护
  { key: "privacy_aliyun_action", secret: false, label: "阿里云号码保护 Action", def: "BindAxb", group: "privacy_call", showIf: { key: "privacy_vendor", in: ["aliyun"] } },
  { key: "privacy_aliyun_pool_key", secret: false, label: "号码池 Key（PoolKey，可选）", group: "privacy_call", showIf: { key: "privacy_vendor", in: ["aliyun"] } },

  /* ---- 直拨（隐私号不可用时的回退） ---- */
  {
    key: "direct_call_enabled_global",
    secret: false,
    label: "隐私号未开通时允许直拨",
    def: "true",
    group: "direct_call",
    type: "bool",
  },

  /* ---- 其他 ---- */
  { key: "tencent_ocr_region", secret: false, label: "OCR 地域", def: "ap-guangzhou", group: "other" },
  { key: "ocr_demo_mode", secret: false, label: "OCR 演示模式", def: "false", group: "other", type: "bool" },
  { key: "ocr_demo_plate", secret: false, label: "OCR 演示车牌", def: "粤B12345", group: "other" },
  { key: "default_phone_country_code", secret: false, label: "默认手机区号", def: "+86", group: "other" },
];
const SETTING_MAP = Object.fromEntries(GLOBAL_SETTINGS.map((s) => [s.key, s]));

// 广告位定义：后台可选的投放位置。仅存图片链接，不做图片上传。
const AD_POSITIONS = [
  { key: "home_top", label: "首页 · 顶部横幅" },
  { key: "move_top", label: "访客页 · 车牌卡下方" },
  { key: "move_bottom", label: "访客页 · 底部推荐位" },
  { key: "owner_top", label: "车主后台 · 顶部" },
];
const AD_POSITION_KEYS = AD_POSITIONS.map((p) => p.key);

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), env);
    try {
      const url = new URL(request.url);
      const route = matchRoute(request.method, url.pathname);
      if (!route) return json({ error: "not_found", message: "接口不存在。" }, 404, env);
      const context = { request, env, url, params: route.params };
      // 管理员接口强制鉴权（路由 guard 为 "admin" 时）
      if (route.guard === "admin") {
        assertConfig(env, ["DB"]);
        context.admin = await requireAdmin(context);
      }
      return cors(await route.handler(context), env);
    } catch (error) {
      if (error instanceof ConfigError) {
        return cors(json({ error: "config_error", message: error.message, missing: error.missing }, 503, env), env);
      }
      if (error instanceof AuthError) {
        return cors(json({ error: "unauthorized", message: error.message }, 401, env), env);
      }
      if (error instanceof NotFoundError) {
        return cors(json({ error: "not_found", message: error.message }, 404, env), env);
      }
      return cors(json({ error: "server_error", message: error.message || "服务异常。" }, 500, env), env);
    }
  },
};

function matchRoute(method, pathname) {
  const routes = [
    // 公开 / 访客
    ["GET", /^\/api\/health$/, handleHealth],
    ["POST", /^\/api\/ocr\/plate$/, handlePlateOcr],
    ["POST", /^\/api\/vehicles$/, handleCreateVehicle],
    ["GET", /^\/api\/vehicles\/([^/]+)\/public$/, handlePublicVehicle, ["vehicleToken"]],
    ["POST", /^\/api\/vehicles\/([^/]+)\/notify$/, handleNotify, ["vehicleToken"]],
    // 访客：直拨写拨号日志（直拨发生在客户端，需主动上报）
    ["POST", /^\/api\/vehicles\/([^/]+)\/call-log$/, handleVisitorCallLog, ["vehicleToken"]],
    // 预生成二维码：扫码解析 / 车主绑定（公开）
    ["POST", /^\/api\/qr\/([^/]+)\/bind$/, handleQrBind, ["codeToken"]],
    ["GET", /^\/api\/qr\/([^/]+)$/, handleQrResolve, ["codeToken"]],
    // 平台已开通的通知通道（公开，供车主端筛选）
    ["GET", /^\/api\/channels$/, handlePublicChannels],
    // 广告位（公开读取，仅返回已启用）
    ["GET", /^\/api\/ads$/, handlePublicAds],
    // 车主（ownerToken 或 车牌+PIN）
    ["POST", /^\/api\/owner\/recover$/, handleRecoverOwner],
    ["GET", /^\/api\/owner\/([^/]+)\/vehicle$/, handleOwnerVehicle, ["ownerToken"]],
    ["PATCH", /^\/api\/owner\/([^/]+)\/vehicle$/, handlePatchOwnerVehicle, ["ownerToken"]],
    ["DELETE", /^\/api\/owner\/([^/]+)\/vehicle$/, handleDeleteOwnerVehicle, ["ownerToken"]],
    ["POST", /^\/api\/owner\/([^/]+)\/vehicle\/regenerate-token$/, handleRegenerateVehicleToken, ["ownerToken"]],
    // 车主：更换手机号前下发短信验证码
    ["POST", /^\/api\/owner\/([^/]+)\/phone\/send-code$/, handleOwnerPhoneSendCode, ["ownerToken"]],
    // 超级管理员
    ["POST", /^\/api\/admin\/login$/, handleAdminLogin],
    ["POST", /^\/api\/admin\/logout$/, handleAdminLogout],
    ["GET", /^\/api\/admin\/config$/, handleAdminConfigGet, [], "admin"],
    ["PUT", /^\/api\/admin\/config$/, handleAdminConfigPut, [], "admin"],
    ["GET", /^\/api\/admin\/accounts$/, handleAdminListAccounts, [], "admin"],
    ["POST", /^\/api\/admin\/accounts$/, handleAdminCreateAccount, [], "admin"],
    ["DELETE", /^\/api\/admin\/accounts\/([^/]+)$/, handleAdminDeleteAccount, ["username"], "admin"],
    ["GET", /^\/api\/admin\/lookup$/, handleAdminLookup, [], "admin"],
    ["GET", /^\/api\/admin\/ads$/, handleAdminAdsList, [], "admin"],
    ["POST", /^\/api\/admin\/ads$/, handleAdminAdsCreate, [], "admin"],
    ["PUT", /^\/api\/admin\/ads\/(\d+)$/, handleAdminAdsUpdate, ["id"], "admin"],
    ["DELETE", /^\/api\/admin\/ads\/(\d+)$/, handleAdminAdsDelete, ["id"], "admin"],
    // 超级管理员：车牌（车辆绑定）管理
    ["GET", /^\/api\/admin\/vehicles$/, handleAdminVehiclesList, [], "admin"],
    ["POST", /^\/api\/admin\/vehicles$/, handleAdminVehicleCreate, [], "admin"],
    ["GET", /^\/api\/admin\/vehicles\/export$/, handleAdminVehicleExport, [], "admin"],
    ["POST", /^\/api\/admin\/vehicles\/import$/, handleAdminVehicleImport, [], "admin"],
    ["PUT", /^\/api\/admin\/vehicles\/(\d+)$/, handleAdminVehicleUpdate, ["id"], "admin"],
    ["DELETE", /^\/api\/admin\/vehicles\/(\d+)$/, handleAdminVehicleDelete, ["id"], "admin"],
    ["GET", /^\/api\/admin\/vehicles\/(\d+)\/owner-token$/, handleAdminVehicleOwnerToken, ["id"], "admin"],
    // 超级管理员：预生成二维码（批量出码 / 管理）
    ["GET", /^\/api\/admin\/qr-codes$/, handleAdminQrList, [], "admin"],
    ["POST", /^\/api\/admin\/qr-codes\/batch$/, handleAdminQrBatch, [], "admin"],
    ["POST", /^\/api\/admin\/qr-codes\/bulk-delete$/, handleAdminQrBulkDelete, [], "admin"],
    ["PATCH", /^\/api\/admin\/qr-codes\/(\d+)$/, handleAdminQrUpdate, ["id"], "admin"],
    ["DELETE", /^\/api\/admin\/qr-codes\/(\d+)$/, handleAdminQrDelete, ["id"], "admin"],
    // 超级管理员：拨号日志
    ["GET", /^\/api\/admin\/call-logs$/, handleAdminCallLogsList, [], "admin"],
    ["GET", /^\/api\/admin\/call-logs\/export$/, handleAdminCallLogsExport, [], "admin"],
    ["POST", /^\/api\/admin\/call-logs\/bulk-delete$/, handleAdminCallLogsBulkDelete, [], "admin"],
    ["POST", /^\/api\/admin\/password$/, handleAdminPasswordChange, [], "admin"],
  ];
  for (const [routeMethod, pattern, handler, keys = [], guard] of routes) {
    const match = pathname.match(pattern);
    if (method === routeMethod && match) {
      return {
        handler,
        params: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])),
        guard,
      };
    }
  }
  return null;
}

/* ============================================================
   中间件：管理员鉴权
   ============================================================ */
async function requireAdmin(context) {
  const token = getAdminToken(context.request);
  if (!token) throw new AuthError("缺少管理员身份，请先登录。");
  const session = await context.env.DB.prepare("SELECT username, expires_at FROM admin_sessions WHERE token = ?")
    .bind(token)
    .first();
  if (!session) throw new AuthError("会话无效或已过期，请重新登录。");
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await context.env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
    throw new AuthError("会话已过期，请重新登录。");
  }
  return session.username;
}

function getAdminToken(request) {
  const auth = request.headers.get("Authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers.get("X-Admin-Token") || "";
}

/* ============================================================
   健康检查
   ============================================================ */
async function handleHealth({ env }) {
  const g = await loadGlobal(env);
  const tencentOcr = Boolean(g.tencent_secret_id && g.tencent_secret_key);
  const smsReady = channelOpened(g, "sms");
  const privacyReady = channelOpened(g, "privacy_call");
  const wechatWorkGlobal = channelOpened(g, "wechat_work");
  const wechatNotifyGlobal = channelOpened(g, "wechat");
  return json({
    status: "ok",
    d1: Boolean(env.DB),
    encryption: Boolean(env.DATA_ENCRYPTION_KEY),
    ocrDemo: usesOcrDemo(env, g),
    tencentOcr,
    smsVendor: g.sms_vendor || "tencent",
    privacyVendor: g.privacy_vendor || "custom",
    // 兼容旧字段名
    tencentSms: smsReady,
    privacyCall: privacyReady,
    sms: smsReady,
    privacy_call: privacyReady,
    wechatWorkGlobal,
    wechatNotifyGlobal,
    directCall: isOn(g.direct_call_enabled_global),
    channels: Object.fromEntries(CHANNEL_GROUPS.map((c) => [c.key, channelOpened(g, c.key)])),
    globalConfigured: Boolean(smsReady || privacyReady || wechatWorkGlobal || wechatNotifyGlobal),
  });
}

/* ============================================================
   工具：CORS / JSON
   ============================================================ */
function cors(response, env) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", env.CORS_ORIGIN || "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, Authorization");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/* ============================================================
   OCR
   ============================================================ */
async function handlePlateOcr({ request, env }) {
  const g = await loadGlobal(env);
  const form = await request.formData();
  const image = form.get("image");
  const imageError = validateOcrImage(image, env);
  if (imageError) return json(imageError, 400);
  if (usesOcrDemo(env, g)) {
    return json({
      plateNumber: g.ocr_demo_plate || "粤B12345",
      candidates: [{ plateNumber: g.ocr_demo_plate || "粤B12345", color: "demo" }],
      demo: true,
    });
  }
  assertConfig(env, ["DATA_ENCRYPTION_KEY"]);
  if (!g.tencent_secret_id || !g.tencent_secret_key) {
    return json({ error: "config_error", message: "未配置腾讯云 OCR 密钥，且未开启演示模式。" }, 503);
  }
  const bytes = new Uint8Array(await image.arrayBuffer());
  const imageBase64 = bytesToBase64(bytes);
  const result = await tencentApi(g, {
    secretId: g.tencent_secret_id,
    secretKey: g.tencent_secret_key,
    service: "ocr",
    host: "ocr.tencentcloudapi.com",
    version: "2018-11-19",
    action: "LicensePlateOCR",
    region: g.tencent_ocr_region || "ap-guangzhou",
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
function usesOcrDemo(env, g) {
  return (isOcrDemo(env) || g.ocr_demo_mode === "true") && !(g.tencent_secret_id && g.tencent_secret_key);
}

function validateOcrImage(image, env) {
  if (!image || typeof image === "string") return { error: "missing_image", message: "请上传车牌照片。" };
  const maxBytes = Number(env.MAX_OCR_IMAGE_BYTES || MAX_OCR_IMAGE_BYTES);
  if (image.size > maxBytes) return { error: "image_too_large", message: `图片不能超过 ${Math.floor(maxBytes / 1024 / 1024)}MB。` };
  if (image.type && !image.type.startsWith("image/")) return { error: "invalid_image_type", message: "请上传 JPG、PNG、HEIC 等图片文件。" };
  return null;
}

/* ============================================================
   创建挪车码（车主）
   ============================================================ */
async function handleCreateVehicle({ request, env }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const input = await readJson(request);
  const validationError = validateVehicleInput(input, { requireNotification: true, requirePhone: true });
  if (validationError) return json(validationError, 400);
  // 一个车牌只能录入一次：重复录入引导到「找回」
  const plateHash = await sha256Hex(normalizePlate(input.plateNumber));
  const exists = await env.DB.prepare("SELECT id, plate_number_masked, owner_pin_hash FROM vehicles WHERE plate_number_hash = ?")
    .bind(plateHash)
    .first();
  if (exists) {
    return json(
      {
        error: "plate_exists",
        message: "该车牌已录入过，一个车牌只能录入一次。请用「车牌 + 管理密码」找回管理入口。",
        maskedPlate: normalizePlate(input.plateNumber),
        canRecover: Boolean(exists.owner_pin_hash),
      },
      409
    );
  }
  // 车主只能使用平台已开通的通知方式；「直拨」为默认方式，只要平台允许直拨即可创建
  const g = await loadGlobal(env);
  const bundleOn = Boolean(input.notifyAllEnabled || input.wechatEnabled || input.wechatWorkEnabled);
  const wanted = [];
  if (bundleOn) { wanted.push("wechat_work"); wanted.push("wechat"); }
  if (input.smsEnabled) wanted.push("sms");
  if (input.privacyCallEnabled) wanted.push("privacy_call");
  const usable = wanted.filter((c) => channelOpened(g, c));
  const directAvailable = isOn(g.direct_call_enabled_global);
  // 明确选了通道但平台一个都没开 → 拒绝（避免静默降级让车主误以为已开启）
  if (wanted.length && !usable.length) {
    return json(
      { error: "no_available_channel", message: "所选通知方式平台尚未开通，请到超级管理员后台开通后再试。" },
      400
    );
  }
  // 未选任何通道时默认走直拨，平台连直拨都没开才拒绝
  if (!wanted.length && !directAvailable) {
    return json(
      { error: "no_available_channel", message: "平台尚未开通任何通知方式，请联系管理员开通后再试。" },
      400
    );
  }
  const created = await insertVehicleRecord(env, input);
  return json({ vehicleToken: created.vehicleToken, ownerToken: created.ownerToken, maskedPlate: created.maskedPlate }, 201);
}

// 车主创建 / 管理员新增 / 批量导入 共用的写入逻辑
async function insertVehicleRecord(env, input) {
  const plateNumber = normalizePlate(input.plateNumber);
  const vehicleToken = await token("veh");
  const ownerToken = await token("own");
  const now = nowIso();
  // 一键通知：同时开启企微 + 微信模板消息
  const bundleOn = Boolean(input.notifyAllEnabled || input.wechatEnabled || input.wechatWorkEnabled);
  const res = await env.DB.prepare(
    `INSERT INTO vehicles (
      vehicle_token, owner_token, plate_number_masked, plate_number_hash, plate_number_encrypted,
      owner_phone_encrypted, showdoc_webhook,
      wechat_work_webhook_encrypted, wechat_work_enabled, wechat_enabled,
      sms_enabled, privacy_call_enabled, owner_pin_hash, wechat_openid,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      vehicleToken,
      ownerToken,
      maskPlate(plateNumber),
      await sha256Hex(plateNumber),
      await encryptText(env, plateNumber),
      input.ownerPhone ? await encryptText(env, normalizePhone(input.ownerPhone)) : null,
      "",
      null,
      bundleOn ? 1 : 0,
      bundleOn ? 1 : 0,
      input.smsEnabled ? 1 : 0,
      input.privacyCallEnabled ? 1 : 0,
      input.ownerPin ? await sha256Hex(`pin:${input.ownerPin}`) : null,
      input.wechatOpenid ? await encryptText(env, String(input.wechatOpenid).trim()) : null,
      now,
      now
    )
    .run();
  return {
    id: res.meta?.last_row_id ?? null,
    vehicleToken,
    ownerToken,
    maskedPlate: maskPlate(plateNumber),
  };
}

/* ============================================================
   访客：公开车辆信息
   ============================================================ */
async function handlePublicVehicle({ env, params }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const g = await loadGlobal(env);
  const vehicle = await getVehicleByToken(env, params.vehicleToken);
  if (!vehicle) return json({ error: "not_found", message: "车辆不存在。" }, 404);
  const channels = availableChannels(vehicle, g);
  // 拨打方式：隐私拨号优先；未开启隐私拨号则为「直拨」（默认），需管理员开启直拨 + 车主登记号码
  const callMode = resolveCallMode(vehicle, g, channels);
  let directCall = null;
  if (callMode === "direct") {
    try {
      directCall = { enabled: true, phone: await decryptText(env, vehicle.owner_phone_encrypted) };
    } catch {
      directCall = null;
    }
  }
  return json({
    maskedPlate: await plateDisplay(env, vehicle),
    availableChannels: channels,
    callMode,
    directCall,
    directCallEnabled: isOn(g.direct_call_enabled_global),
  });
}

/* ============================================================
   访客：通知车主
   ============================================================ */
async function handleNotify({ request, env, params }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const input = await readJson(request);
  const g = await loadGlobal(env);
  const vehicle = await getVehicleByToken(env, params.vehicleToken);
  if (!vehicle) return json({ error: "not_found", message: "车辆不存在。" }, 404);
  const channel = input.channel || defaultNotifyChannel(vehicle, g);
  if (!channel || !availableChannels(vehicle, g).includes(channel)) {
    return json({ error: "channel_unavailable", message: "该通知方式尚未配置。" }, 400);
  }

  const visitorHash = await visitorIpHash(request, env);
  const cutoff = new Date(Date.now() - NOTIFY_COOLDOWN_SECONDS * 1000).toISOString();
  const recent = await env.DB.prepare(
    `SELECT id FROM notification_logs WHERE vehicle_id = ? AND visitor_ip_hash = ? AND created_at > ? ORDER BY id DESC LIMIT 1`
  )
    .bind(vehicle.id, visitorHash, cutoff)
    .first();
  if (recent) return json({ error: "rate_limited", message: "已提醒车主，请勿频繁操作。" }, 429);

  const createdAt = nowIso();
  let status = "sent";
  let errorSummary = "";
  let virtualNumber = "";
  try {
    const out = (await dispatchNotify(vehicle, g, env, channel, input)) || {};
    virtualNumber = out.virtualNumber || "";
  } catch (error) {
    status = "failed";
    errorSummary = String(error.message || error).slice(0, 300);
  }

  // 隐私拨号：写入拨号日志（记录拨号方与被叫方）
  if (channel === "privacy_call") {
    const callee = vehicle.owner_phone_encrypted ? await decryptText(env, vehicle.owner_phone_encrypted).catch(() => "") : "";
    await recordCallLog(env, {
      vehicle,
      channel: "privacy_call",
      callerNumber: input.callerNumber ? normalizePhone(input.callerNumber) : "",
      calleeNumber: callee,
      virtualNumber,
      status: status === "sent" ? "success" : "failed",
      errorSummary,
      visitorIpHash: visitorHash,
    }).catch(() => {});
  }

  await env.DB.prepare(
    `INSERT INTO notification_logs (vehicle_id, channel, status, error_summary, visitor_ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(vehicle.id, channel, status, errorSummary, visitorHash, createdAt)
    .run();

  if (status === "failed") return json({ error: "notify_failed", message: errorSummary || "通知发送失败。" }, 502);
  return json({ message: "已通知车主，请耐心等待。", channel });
}

async function dispatchNotify(vehicle, g, env, channel, input = {}) {
  // 通知内容统一使用完整车牌（不再打码）
  vehicle.plateDisplay = await plateDisplay(env, vehicle);
  if (channel === "notify_all") {
    // 一键通知：企业微信 + 微信公众号模板消息同时送达（任一失败不影响另一个，只要有一个成功即算成功）
    const results = await Promise.allSettled([
      sendWechatWorkChannel(vehicle, g, env),
      sendWechatTemplate(vehicle, g, env),
    ]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    if (!okCount) {
      const err = results.find((r) => r.status === "rejected")?.reason;
      throw new Error(err?.message || "一键通知发送失败");
    }
    return {};
  }
  if (channel === "wechat") {
    await sendWechatTemplate(vehicle, g, env);
  } else if (channel === "wechat_work") {
    await sendWechatWorkChannel(vehicle, g, env);
  } else if (channel === "sms") {
    await sendSms(vehicle, env, g);
  } else if (channel === "privacy_call") {
    return { virtualNumber: await startPrivacyCall(vehicle, env, g, input) };
  } else {
    throw new Error("未知通知渠道");
  }
  return {};
}

async function sendWechatWorkChannel(vehicle, g, env) {
  const webhook = vehicle.wechat_work_webhook_encrypted ? await decryptText(env, vehicle.wechat_work_webhook_encrypted) : g.wechat_work_webhook;
  if (!webhook) throw new Error("企业微信未配置");
  await sendWechatWork(webhook, vehicle);
}

async function sendWechatWork(webhook, vehicle) {
  const body = {
    msgtype: "text",
    text: { content: `扫码挪车提醒：车辆 ${vehicle.plateDisplay} 收到挪车提醒，请及时处理。` },
  };
  const res = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`企业微信通知失败：${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data.errcode && data.errcode !== 0) throw new Error(`企业微信通知失败：${data.errmsg || data.errcode}`);
}

// 微信通知：调用「公众号模板消息」接口（先取 access_token，再发模板消息），
// 不再使用 Webhook。接收人 OpenID 取「车主单独填写」优先，否则用超管配置的默认 OpenID。
async function sendWechatTemplate(vehicle, g, env) {
  if (!wechatMpReady(g)) throw new Error("微信通知（公众号模板消息）未配置，请到超管后台补全 AppID / AppSecret / 模板ID");
  let openid = g.wechat_mp_openid || "";
  if (vehicle.wechat_openid) {
    try { openid = await decryptText(env, vehicle.wechat_openid); } catch {}
  }
  if (!openid) throw new Error("微信通知缺少接收 OpenID（车主未填写且超管未配置默认 OpenID）");

  const token = await getWechatAccessToken(env, g);
  const data = {
    first: { value: g.wechat_mp_template_title || "您的爱车收到挪车提醒" },
    keyword1: { value: vehicle.plateDisplay },
    keyword2: { value: formatCnTime(new Date()) },
    remark: { value: g.wechat_mp_template_remark || "请尽快前往挪车，感谢配合。" },
  };
  const payload = { touser: openid, template_id: g.wechat_mp_template_id, data };
  if (g.wechat_mp_url) payload.url = g.wechat_mp_url;

  const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || (out.errcode && out.errcode !== 0)) {
    throw new Error(`微信模板消息失败：${out.errmsg || out.errcode || res.status}`);
  }
}

// 获取公众号 access_token，并用 Cache API 缓存（有效期 7200s，提前 5 分钟过期）
async function getWechatAccessToken(env, g) {
  const cacheKey = `https://wechat-token.internal/${encodeURIComponent(g.wechat_mp_appid)}`;
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const body = await cached.json();
      if (body && body.access_token) return body.access_token;
    }
  } catch {}

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(g.wechat_mp_appid)}&secret=${encodeURIComponent(g.wechat_mp_secret)}`;
  const res = await fetch(url);
  const out = await res.json().catch(() => ({}));
  if (!out.access_token) throw new Error(`获取微信 access_token 失败：${out.errmsg || out.errcode || res.status}`);
  try {
    await caches.default.put(
      cacheKey,
      new Response(JSON.stringify({ access_token: out.access_token }), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${Math.max(60, (out.expires_in || 7200) - 300)}` },
      })
    );
  } catch {}
  return out.access_token;
}

function formatCnTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- 短信：按服务商分发 ---------- */
async function sendSms(vehicle, env, g) {
  const vendor = g.sms_vendor || "tencent";
  if (!smsVendorReady(g)) throw new Error(`短信通道未配置（服务商：${vendor}，请到超级管理员后台补全参数）`);
  if (vendor === "aliyun") return sendAliyunSms(vehicle, env, g);
  if (vendor === "custom") return sendCustomSms(vehicle, env, g);
  return sendTencentSms(vehicle, env, g);
}

async function sendAliyunSms(vehicle, env, g) {
  const phone = await decryptText(env, vehicle.owner_phone_encrypted);
  const result = await aliyunApi(
    {
      accessKeyId: g.aliyun_access_key_id,
      accessKeySecret: g.aliyun_access_key_secret,
      regionId: g.aliyun_sms_region || "cn-hangzhou",
    },
    {
      Action: "SendSms",
      Version: "2017-05-25",
      PhoneNumbers: toE164(phone, g.default_phone_country_code || "+86").replace("+", ""),
      SignName: g.aliyun_sms_sign_name,
      TemplateCode: g.aliyun_sms_template_code,
      TemplateParam: JSON.stringify({ code: vehicle.plateDisplay, plate: vehicle.plateDisplay }),
    }
  );
  if (result.Code && result.Code !== "OK") throw new Error(result.Message || result.Code);
}

// 自定义短信 Webhook：把发短信这件事交给任意第三方 / 云函数，参数通用
async function sendCustomSms(vehicle, env, g) {
  const phone = await decryptText(env, vehicle.owner_phone_encrypted);
  const res = await fetch(g.sms_custom_webhook, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(g.sms_custom_token ? { Authorization: `Bearer ${g.sms_custom_token}` } : {}),
    },
    body: JSON.stringify({
      phone,
      maskedPlate: vehicle.plateDisplay,
      templateVar: vehicle.plateDisplay,
      purpose: "move_car_notify",
      vendor: "custom",
    }),
  });
  if (!res.ok) throw new Error(`自定义短信 Webhook 失败：${res.status}`);
  const data = await res.json().catch(() => null);
  if (data && data.error) throw new Error(`自定义短信 Webhook 失败：${data.error}`);
  if (data && typeof data.error_code !== "undefined" && Number(data.error_code) !== 0) {
    throw new Error(`自定义短信 Webhook 失败：${data.error_message || data.error_code}`);
  }
}

async function sendTencentSms(vehicle, env, g) {
  if (!g.tencent_secret_id || !g.tencent_secret_key || !g.tencent_sms_app_id || !g.tencent_sms_sign_name || !g.tencent_sms_template_id) {
    throw new Error("短信通道未配置（缺少腾讯云短信密钥）");
  }
  const phone = await decryptText(env, vehicle.owner_phone_encrypted);
  const result = await tencentApi(g, {
    secretId: g.tencent_secret_id,
    secretKey: g.tencent_secret_key,
    service: "sms",
    host: "sms.tencentcloudapi.com",
    version: "2021-01-11",
    action: "SendSms",
    region: g.tencent_sms_region || "ap-guangzhou",
    payload: {
      SmsSdkAppId: g.tencent_sms_app_id,
      SignName: g.tencent_sms_sign_name,
      TemplateId: g.tencent_sms_template_id,
      TemplateParamSet: [vehicle.plateDisplay],
      PhoneNumberSet: [toE164(phone, g.default_phone_country_code || "+86")],
    },
  });
  const status = result.SendStatusSet?.[0];
  if (status && status.Code !== "Ok") throw new Error(status.Message || status.Code);
}

/* ---------- 隐私号：按服务商分发（返回平台分配的中间号，用于写拨号日志） ---------- */
// 各平台返回中间号的字段名不同，统一尝试读取
function pickVirtualNumber(data) {
  if (!data || typeof data !== "object") return "";
  const keys = ["virtualNumber", "virtual_number", "bindNumber", "bind_number", "middleNumber", "xNumber", "x_number", "numberX", "NumberX", "secretNo", "SecretNo", "number", "Number"];
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

async function startPrivacyCall(vehicle, env, g, input = {}) {
  const vendor = g.privacy_vendor || "custom";
  if (!privacyVendorReady(g)) throw new Error(`隐私号通道未配置（服务商：${vendor}，请到超级管理员后台补全参数）`);
  if (vendor === "tencent") return startTencentPrivacyCall(vehicle, env, g, input);
  if (vendor === "aliyun") return startAliyunPrivacyCall(vehicle, env, g, input);
  return startCustomPrivacyCall(vehicle, env, g, input);
}

// 自定义 Webhook：可对接任意平台（腾讯云/阿里云/第三方均可经云函数中转）
async function startCustomPrivacyCall(vehicle, env, g, input = {}) {
  const phone = await decryptText(env, vehicle.owner_phone_encrypted);
  const res = await fetch(g.privacy_call_webhook_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(g.privacy_call_webhook_token ? { Authorization: `Bearer ${g.privacy_call_webhook_token}` } : {}),
    },
    body: JSON.stringify({
      phone,
      callerNumber: input.callerNumber || "",
      maskedPlate: vehicle.plateDisplay,
      vendor: "custom",
      purpose: "move_car_privacy_call",
    }),
  });
  if (!res.ok) throw new Error(`隐私号呼叫失败：${res.status}`);
  const data = await res.json().catch(() => null);
  return pickVirtualNumber(data);
}

// 腾讯云号码保护（AXB 绑定）：沿用 TC3 签名，Action / 版本可在后台调整
async function startTencentPrivacyCall(vehicle, env, g, input = {}) {
  const phone = await decryptText(env, vehicle.owner_phone_encrypted);
  const payload = {
    PhoneNumber: toE164(phone, g.default_phone_country_code || "+86"),
    ...(input.callerNumber ? { CallerNumber: toE164(input.callerNumber, g.default_phone_country_code || "+86") } : {}),
    ...(g.privacy_tencent_pool_key ? { PoolKey: g.privacy_tencent_pool_key } : {}),
  };
  const result = await tencentApi(g, {
    secretId: g.tencent_secret_id,
    secretKey: g.tencent_secret_key,
    service: "npp",
    host: "npp.tencentcloudapi.com",
    version: g.privacy_tencent_version || "2021-02-22",
    action: g.privacy_tencent_action || "BindNumber",
    region: g.tencent_sms_region || "ap-guangzhou",
    payload,
  });
  if (result?.Error) throw new Error(result.Error.Message || "腾讯云号码保护调用失败");
  return pickVirtualNumber(result);
}

// 阿里云号码隐私保护：标准 RPC 签名，Action 可在后台调整
async function startAliyunPrivacyCall(vehicle, env, g, input = {}) {
  const phone = await decryptText(env, vehicle.owner_phone_encrypted);
  const result = await aliyunApi(
    {
      accessKeyId: g.aliyun_access_key_id,
      accessKeySecret: g.aliyun_access_key_secret,
      regionId: g.aliyun_sms_region || "cn-hangzhou",
    },
    {
      Action: g.privacy_aliyun_action || "BindAxb",
      Version: "2017-05-25",
      PhoneNoA: toE164(phone, g.default_phone_country_code || "+86").replace("+", ""),
      ...(input.callerNumber ? { PhoneNoB: toE164(input.callerNumber, g.default_phone_country_code || "+86").replace("+", "") } : {}),
      ...(g.privacy_aliyun_pool_key ? { PoolKey: g.privacy_aliyun_pool_key } : {}),
    }
  );
  if (result?.Code && result.Code !== "OK") throw new Error(result.Message || result.Code);
  return pickVirtualNumber(result);
}

/* ---------- 拨号日志 ---------- */
async function recordCallLog(env, { vehicle, channel, callerNumber = "", calleeNumber = "", virtualNumber = "", status = "success", errorSummary = "", visitorIpHash = "" }) {
  const enc = (v) => (v ? encryptText(env, v) : Promise.resolve(null));
  const last4 = (v) => (v ? String(v).slice(-4) : null);
  await env.DB.prepare(
    `INSERT INTO call_logs (vehicle_id, channel, caller_number_enc, caller_last4, callee_number_enc, callee_last4,
      virtual_number_enc, virtual_last4, status, error_summary, visitor_ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      vehicle.id,
      channel,
      await enc(callerNumber),
      last4(callerNumber),
      await enc(calleeNumber),
      last4(calleeNumber),
      await enc(virtualNumber),
      last4(virtualNumber),
      status,
      String(errorSummary || "").slice(0, 300),
      visitorIpHash || "",
      nowIso()
    )
    .run();
}

// 阿里云开放 API 通用签名（RPC 风格，AccessKeyId + HMAC-SHA1）
async function aliyunApi({ accessKeyId, accessKeySecret, regionId }, params) {
  const common = {
    AccessKeyId: accessKeyId,
    Format: "JSON",
    RegionId: regionId || "cn-hangzhou",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: `${Date.now()}${Math.random().toString(36).slice(2, 10)}`,
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: params.Version || "2017-05-25",
  };
  const all = { ...params, ...common };
  const canonical = Object.keys(all)
    .sort()
    .map((k) => `${aliyunEncode(k)}=${aliyunEncode(all[k])}`)
    .join("&");
  const stringToSign = `POST&${aliyunEncode("/")}&${aliyunEncode(canonical)}`;
  const signature = bytesToBase64(await hmacRaw(`${accessKeySecret}&`, stringToSign));
  const body = new URLSearchParams({ ...all, Signature: signature });
  const res = await fetch("https://dysmsapi.aliyuncs.com/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.Code === "InvalidAccessKeyId") {
    throw new Error(data.Message || `阿里云接口调用失败：${res.status}`);
  }
  return data;
}
function aliyunEncode(value) {
  return encodeURIComponent(String(value ?? ""))
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

async function tencentApi(g, { secretId, secretKey, service, host, version, action, region, payload }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const hashedPayload = await sha256Hex(body);
  const canonicalRequest = ["POST", "/", "", `host:${host}\n`, "host", hashedPayload].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = ["TC3-HMAC-SHA256", timestamp, credentialScope, hashedCanonicalRequest].join("\n");
  const secretDate = await hmac(`TC3${secretKey}`, date);
  const secretService = await hmac(secretDate, service);
  const secretSigning = await hmac(secretService, "tc3_request");
  const signature = bytesToHex(await hmac(secretSigning, stringToSign));
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=host, Signature=${signature}`;
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
  if (!res.ok || data.Response?.Error) throw new Error(data.Response?.Error?.Message || `腾讯云 ${action} 调用失败：${res.status}`);
  return data.Response;
}

/* ============================================================
   车主：管理后台数据 / 修改 / 删除 / 重生成
   ============================================================ */
async function handleOwnerVehicle({ env, params }) {
  assertConfig(env, ["DB"]);
  const g = await loadGlobal(env);
  const vehicle = await getVehicleByOwnerToken(env, params.ownerToken);
  if (!vehicle) return json({ error: "not_found", message: "管理链接无效。" }, 404);
  const logs = await env.DB.prepare(
    `SELECT channel, status, error_summary, created_at FROM notification_logs WHERE vehicle_id = ? ORDER BY id DESC LIMIT 10`
  )
    .bind(vehicle.id)
    .all();
  // 回填当前配置（车主本人可见自己的配置），修复「改了不生效 / 打开时开关被重置」的问题
  let ownerPhoneMasked = "";
  let plateNumber = "";
  try {
    if (vehicle.owner_phone_encrypted) ownerPhoneMasked = maskPhone(await decryptText(env, vehicle.owner_phone_encrypted));
  } catch {}
  try {
    if (vehicle.plate_number_encrypted) plateNumber = await decryptText(env, vehicle.plate_number_encrypted);
  } catch {}
  let wechatOpenid = "";
  try {
    if (vehicle.wechat_openid) wechatOpenid = await decryptText(env, vehicle.wechat_openid);
  } catch {}
  return json({
    vehicleToken: vehicle.vehicle_token,
    maskedPlate: plateNumber || vehicle.plate_number_masked,
    plateNumber: plateNumber || vehicle.plate_number_masked,
    // 一键通知：企微 + 微信模板消息（两者同开同关）
    notifyAllEnabled: Boolean(vehicle.wechat_work_enabled && vehicle.wechat_enabled),
    wechatWorkEnabled: Boolean(vehicle.wechat_work_enabled),
    wechatEnabled: Boolean(vehicle.wechat_enabled),
    smsEnabled: Boolean(vehicle.sms_enabled),
    privacyCallEnabled: Boolean(vehicle.privacy_call_enabled),
    // 隐私拨号未开启 → 直拨（默认）
    directCallEnabled: !vehicle.privacy_call_enabled && channelOpened(g, "direct_call"),
    hasPin: Boolean(vehicle.owner_pin_hash),
    ownerPhoneMasked,
    hasPhone: Boolean(vehicle.owner_phone_encrypted),
    wechatOpenid,
    hasWechatOpenid: Boolean(vehicle.wechat_openid),
    // 平台已开通的通道：车主后台只展示这些，未开通的不出现
    platformChannels: platformChannels(g),
    channelMeta: CHANNEL_GROUPS.map((c) => ({
      key: c.key,
      label: c.label,
      icon: c.icon,
      opened: channelOpened(g, c.key),
    })),
    global: {
      sms: channelOpened(g, "sms"),
      wechat: channelOpened(g, "wechat_work"),
      wechatNotify: channelOpened(g, "wechat"),
      privacy: channelOpened(g, "privacy_call"),
      directCall: channelOpened(g, "direct_call"),
    },
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
  // 显式传 null / 空字符串表示清除；传值表示设置。支持把 webhook 清空。
  // 一键通知：企微 + 微信模板消息同开同关
  if ("notifyAllEnabled" in input && typeof input.notifyAllEnabled === "boolean") {
    const v = input.notifyAllEnabled ? 1 : 0;
    updates.push("wechat_work_enabled = ?"); values.push(v);
    updates.push("wechat_enabled = ?"); values.push(v);
  }
  if ("wechatWorkEnabled" in input && typeof input.wechatWorkEnabled === "boolean") {
    updates.push("wechat_work_enabled = ?"); values.push(input.wechatWorkEnabled ? 1 : 0);
  }
  if ("wechatEnabled" in input && typeof input.wechatEnabled === "boolean") {
    updates.push("wechat_enabled = ?"); values.push(input.wechatEnabled ? 1 : 0);
  }
  if ("wechatOpenid" in input) {
    if (input.wechatOpenid) { updates.push("wechat_openid = ?"); values.push(await encryptText(env, String(input.wechatOpenid).trim())); }
    else { updates.push("wechat_openid = ?"); values.push(null); }
  }
  if ("wechatWorkWebhook" in input) {
    if (input.wechatWorkWebhook) { updates.push("wechat_work_webhook_encrypted = ?"); values.push(await encryptText(env, normalizeHttpUrl(input.wechatWorkWebhook))); }
    else { updates.push("wechat_work_webhook_encrypted = ?"); values.push(null); }
  }
  if ("ownerPhone" in input) {
    const next = normalizePhone(input.ownerPhone);
    const current = vehicle.owner_phone_encrypted ? await decryptText(env, vehicle.owner_phone_encrypted).catch(() => "") : "";
    const changed = next !== current;
    // 更换手机号必须通过验证：短信验证码 或 管理密码
    if (changed && current) {
      const verified = await verifyPhoneChange({ env, g: await loadGlobal(env), vehicle, input });
      if (!verified.ok) return json({ error: verified.error, message: verified.message }, verified.status || 400);
    }
    if (next) { updates.push("owner_phone_encrypted = ?"); values.push(await encryptText(env, next)); }
    else if (!changed) { updates.push("owner_phone_encrypted = ?"); values.push(null); }
  }
  if (typeof input.smsEnabled === "boolean") { updates.push("sms_enabled = ?"); values.push(input.smsEnabled ? 1 : 0); }
  if (typeof input.privacyCallEnabled === "boolean") { updates.push("privacy_call_enabled = ?"); values.push(input.privacyCallEnabled ? 1 : 0); }
  if ("ownerPin" in input && input.ownerPin) { updates.push("owner_pin_hash = ?"); values.push(await sha256Hex(`pin:${input.ownerPin}`)); }
  if (!updates.length) return json({ message: "没有需要更新的字段。" });
  updates.push("updated_at = ?");
  values.push(nowIso(), vehicle.id);
  await env.DB.prepare(`UPDATE vehicles SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ message: "配置已更新。" });
}

/* ============================================================
   车主：更换手机号需验证（短信验证码 或 管理密码）
   ============================================================ */
async function verifyPhoneChange({ env, g, vehicle, input }) {
  const v = input.phoneVerify || {};
  if (v.method === "pin") {
    if (!vehicle.owner_pin_hash) {
      return { ok: false, error: "pin_unavailable", message: "未设置管理密码，请改用短信验证码。", status: 400 };
    }
    if (!isPin(v.pin)) return { ok: false, error: "invalid_pin", message: "请输入正确的管理密码。", status: 400 };
    if ((await sha256Hex(`pin:${v.pin}`)) !== vehicle.owner_pin_hash) {
      return { ok: false, error: "pin_mismatch", message: "管理密码不正确。", status: 403 };
    }
    return { ok: true, method: "pin" };
  }
  if (v.method === "sms") {
    if (!isOn(g.sms_enabled_global) || !smsVendorReady(g)) {
      return { ok: false, error: "sms_unavailable", message: "平台未开通短信通道，请改用管理密码验证。", status: 400 };
    }
    if (!/^\d{6}$/.test(String(v.code || ""))) {
      return { ok: false, error: "invalid_code", message: "请输入 6 位短信验证码。", status: 400 };
    }
    const now = nowIso();
    const row = await env.DB.prepare(
      `SELECT id, attempts FROM phone_verify_codes
       WHERE vehicle_id = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY id DESC LIMIT 1`
    )
      .bind(vehicle.id, await sha256Hex(`code:${v.code}`), now)
      .first();
    if (!row) return { ok: false, error: "code_invalid", message: "验证码无效或已过期。", status: 403 };
    if (Number(row.attempts) >= 5) return { ok: false, error: "code_locked", message: "验证码尝试次数过多，请重新获取。", status: 429 };
    await env.DB.prepare("UPDATE phone_verify_codes SET consumed_at = ? WHERE id = ?").bind(now, row.id).run();
    return { ok: true, method: "sms" };
  }
  return {
    ok: false,
    error: "verification_required",
    message: "更换手机号需要验证：请提交短信验证码（phoneVerify.method=sms）或管理密码（phoneVerify.method=pin）。",
    status: 403,
  };
}

// 下发换号验证码到「当前手机号」
async function handleOwnerPhoneSendCode({ request, env, params }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const g = await loadGlobal(env);
  const vehicle = await getVehicleByOwnerToken(env, params.ownerToken);
  if (!vehicle) return json({ error: "not_found", message: "管理链接无效。" }, 404);
  if (!vehicle.owner_phone_encrypted) {
    return json({ error: "no_phone", message: "当前未登记手机号，无需验证可直接设置。" }, 400);
  }
  if (!isOn(g.sms_enabled_global) || !smsVendorReady(g)) {
    return json({ error: "sms_unavailable", message: "平台未开通短信通道，请使用管理密码验证。" }, 400);
  }
  // 60 秒内只发一次
  const recent = await env.DB.prepare(
    "SELECT id FROM phone_verify_codes WHERE vehicle_id = ? AND created_at > ? ORDER BY id DESC LIMIT 1"
  )
    .bind(vehicle.id, new Date(Date.now() - 60_000).toISOString())
    .first();
  if (recent) return json({ error: "too_soon", message: "验证码已发送，请稍候再试（60 秒）。" }, 429);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = nowIso();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO phone_verify_codes (vehicle_id, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)`
  )
    .bind(vehicle.id, await sha256Hex(`code:${code}`), expires, now)
    .run();

  const phone = await decryptText(env, vehicle.owner_phone_encrypted);
  try {
    await sendRawSms(env, g, phone, `【扫码挪车】您正在更换绑定手机号，验证码 ${code}（10 分钟内有效）。`);
  } catch (error) {
    return json({ error: "sms_failed", message: `验证码短信发送失败：${error.message}` }, 502);
  }
  return json({ message: `验证码已发送至当前手机号（${maskPhone(phone)}）。`, expiresIn: 600 });
}

// 直接发送一条自定义内容的短信（换号验证用，不写入通知日志）
async function sendRawSms(env, g, phone, text) {
  const vendor = g.sms_vendor || "tencent";
  if (!smsVendorReady(g)) throw new Error("短信通道未配置");
  const target = toE164(phone, g.default_phone_country_code || "+86");
  if (vendor === "aliyun") {
    const result = await aliyunApi(
      { accessKeyId: g.aliyun_access_key_id, accessKeySecret: g.aliyun_access_key_secret, regionId: g.aliyun_sms_region || "cn-hangzhou" },
      {
        Action: "SendSms",
        Version: "2017-05-25",
        PhoneNumbers: target.replace("+", ""),
        SignName: g.aliyun_sms_sign_name,
        TemplateCode: g.aliyun_sms_template_code,
        TemplateParam: JSON.stringify({ code: (text.match(/\d{6}/) || [""])[0] }),
      }
    );
    if (result.Code && result.Code !== "OK") throw new Error(result.Message || result.Code);
    return;
  }
  if (vendor === "custom") {
    const res = await fetch(g.sms_custom_webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(g.sms_custom_token ? { Authorization: `Bearer ${g.sms_custom_token}` } : {}) },
      body: JSON.stringify({ phone, text, purpose: "phone_change_verify", vendor: "custom" }),
    });
    if (!res.ok) throw new Error(`自定义短信 Webhook 失败：${res.status}`);
    return;
  }
  // 腾讯云：验证码类短信复用模板，验证码作为模板参数
  const result = await tencentApi(g, {
    secretId: g.tencent_secret_id,
    secretKey: g.tencent_secret_key,
    service: "sms",
    host: "sms.tencentcloudapi.com",
    version: "2021-01-11",
    action: "SendSms",
    region: g.tencent_sms_region || "ap-guangzhou",
    payload: {
      SmsSdkAppId: g.tencent_sms_app_id,
      SignName: g.tencent_sms_sign_name,
      TemplateId: g.tencent_sms_template_id,
      TemplateParamSet: [(text.match(/\d{6}/) || [""])[0]],
      PhoneNumberSet: [target],
    },
  });
  const status = result.SendStatusSet?.[0];
  if (status && status.Code !== "Ok") throw new Error(status.Message || status.Code);
}

/* ============================================================
   访客：直拨上报（拨号日志）
   —— 直拨由客户端 tel: 发起，服务端无法感知，因此需要访客页主动上报
   ============================================================ */
async function handleVisitorCallLog({ request, env, params }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const vehicle = await getVehicleByToken(env, params.vehicleToken);
  if (!vehicle) return json({ error: "not_found", message: "车辆不存在。" }, 404);
  if (!vehicle.owner_phone_encrypted) return json({ error: "no_phone", message: "车主未登记手机号。" }, 400);
  const input = await readJson(request);
  const callee = await decryptText(env, vehicle.owner_phone_encrypted).catch(() => "");
  const visitorHash = await visitorIpHash(request, env);
  await recordCallLog(env, {
    vehicle,
    channel: "direct_call",
    callerNumber: input.callerNumber ? normalizePhone(input.callerNumber) : "",
    calleeNumber: callee,
    status: "success",
    visitorIpHash: visitorHash,
  });
  return json({ message: "已记录直拨日志。" });
}

async function handleRegenerateVehicleToken({ env, params }) {
  assertConfig(env, ["DB"]);
  const vehicle = await getVehicleByOwnerToken(env, params.ownerToken);
  if (!vehicle) return json({ error: "not_found", message: "管理链接无效。" }, 404);
  const vehicleToken = await token("veh");
  await env.DB.prepare("UPDATE vehicles SET vehicle_token = ?, updated_at = ? WHERE id = ?").bind(vehicleToken, nowIso(), vehicle.id).run();
  return json({ vehicleToken, maskedPlate: await plateDisplay(env, vehicle) });
}

async function handleDeleteOwnerVehicle({ env, params }) {
  assertConfig(env, ["DB"]);
  const vehicle = await getVehicleByOwnerToken(env, params.ownerToken);
  if (!vehicle) return json({ error: "not_found", message: "管理链接无效。" }, 404);
  await env.DB.prepare("DELETE FROM notification_logs WHERE vehicle_id = ?").bind(vehicle.id).run();
  await env.DB.prepare("DELETE FROM vehicles WHERE id = ?").bind(vehicle.id).run();
  await releaseQrForVehicle(env, vehicle.id);
  return json({ message: "绑定已删除。" });
}

/* ============================================================
   车主：车牌 + 管理密码 找回 ownerToken
   ============================================================ */
async function handleRecoverOwner({ request, env }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const input = await readJson(request);
  const plate = normalizePlate(input.plateNumber);
  if (!isPlate(plate)) return json({ error: "invalid_plate", message: "请填写有效车牌号。" }, 400);
  if (!input.ownerPin) return json({ error: "missing_pin", message: "请填写管理密码。" }, 400);

  const ipHash = await visitorIpHash(request, env);
  const plateHash = await sha256Hex(plate);
  const rlKey = `recover:${ipHash}:${plateHash}`;
  if (!(await checkRateLimit(env, rlKey, RECOVER_MAX_ATTEMPTS, RECOVER_WINDOW_SECONDS))) {
    return json({ error: "rate_limited", message: "尝试次数过多，请稍后再试。" }, 429);
  }
  const pinHash = await sha256Hex(`pin:${input.ownerPin}`);
  const vehicle = await env.DB.prepare("SELECT * FROM vehicles WHERE plate_number_hash = ? AND owner_pin_hash = ?")
    .bind(plateHash, pinHash)
    .first();
  if (!vehicle) return json({ error: "not_found", message: "未找到匹配的车辆，请确认车牌与管理密码。" }, 404);
  return json({ ownerToken: vehicle.owner_token, maskedPlate: await plateDisplay(env, vehicle) });
}

/* ============================================================
   超级管理员：登录 / 登出 / 账号管理
   ============================================================ */
async function handleAdminLogin({ request, env }) {
  assertConfig(env, ["DB"]);
  const input = await readJson(request);
  const username = String(input.username || "").trim();
  const password = String(input.password || "");
  if (!username || !password) return json({ error: "invalid_input", message: "请填写账号与密码。" }, 400);

  let admin = await env.DB.prepare("SELECT * FROM admins WHERE username = ?").bind(username).first();
  // 首次引导：当没有任何管理员且配置了 ADMIN_BOOTSTRAP 时，用引导账号初始化
  if (!admin) {
    const bootstrap = env.ADMIN_BOOTSTRAP || "";
    if (bootstrap && (await env.DB.prepare("SELECT COUNT(*) AS c FROM admins").first()).c === 0) {
      const [bUser, bPass] = bootstrap.split(":");
      if (username === bUser && password === bPass) {
        admin = await createAdmin(env, username, password, "super");
      }
    }
    if (!admin) return json({ error: "unauthorized", message: "账号或密码错误。" }, 401);
  }
  if (!(await verifyPassword(password, admin.salt, admin.password_hash))) {
    return json({ error: "unauthorized", message: "账号或密码错误。" }, 401);
  }
  const tokenStr = await token("adm");
  const expires = new Date(Date.now() + ADMIN_SESSION_DAYS * 86400000).toISOString();
  await env.DB.prepare("INSERT INTO admin_sessions (token, username, expires_at) VALUES (?, ?, ?)").bind(tokenStr, username, expires).run();
  return json({ token: tokenStr, username, role: admin.role, expiresAt: expires });
}

async function handleAdminLogout({ request, env }) {
  const tokenStr = getAdminToken(request);
  if (tokenStr) await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(tokenStr).run();
  return json({ message: "已退出登录。" });
}

async function handleAdminListAccounts({ env }) {
  const rows = await env.DB.prepare("SELECT username, role, created_at FROM admins ORDER BY created_at ASC").all();
  return json({ accounts: rows.results || [] });
}

async function handleAdminCreateAccount({ request, env, params, url }) {
  const input = await readJson(request);
  const username = String(input.username || "").trim();
  const password = String(input.password || "");
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) return json({ error: "invalid_username", message: "账号为 3-32 位字母数字或下划线。" }, 400);
  if (password.length < 8) return json({ error: "weak_password", message: "密码至少 8 位。" }, 400);
  const exists = await env.DB.prepare("SELECT username FROM admins WHERE username = ?").bind(username).first();
  if (exists) return json({ error: "exists", message: "该账号已存在。" }, 400);
  await createAdmin(env, username, password, input.role === "super" ? "super" : "admin");
  return json({ message: "账号已创建。" }, 201);
}

async function handleAdminDeleteAccount({ env, params }) {
  const rows = await env.DB.prepare("SELECT COUNT(*) AS c FROM admins").first();
  if (rows.c <= 1) return json({ error: "last_admin", message: "至少保留一个管理员账号。" }, 400);
  const res = await env.DB.prepare("DELETE FROM admins WHERE username = ?").bind(params.username).run();
  if (changedRows(res) === 0) return json({ error: "not_found", message: "账号不存在。" }, 404);
  await env.DB.prepare("DELETE FROM admin_sessions WHERE username = ?").bind(params.username).run();
  return json({ message: "账号已删除。" });
}

async function createAdmin(env, username, password, role) {
  const salt = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await sha256Hex(`${salt}:${password}`);
  await env.DB.prepare("INSERT INTO admins (username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(username, hash, salt, role, nowIso())
    .run();
  return { username, salt, password_hash: hash, role };
}

async function verifyPassword(password, salt, expectedHash) {
  const hash = await sha256Hex(`${salt}:${password}`);
  return hash === expectedHash;
}

/* ============================================================
   超级管理员：全局通知配置
   ============================================================ */
async function handleAdminConfigGet({ env }) {
  const g = await loadGlobal(env);
  const settings = GLOBAL_SETTINGS.map((s) => ({
    key: s.key,
    label: s.label,
    secret: s.secret,
    group: s.group || "other",
    type: s.type || "text",
    options: s.options || null,
    showIf: s.showIf || null,
    value: s.secret ? (g[s.key] ? "••••••" : "") : (g[s.key] ?? s.def ?? ""),
  }));
  return json({
    settings,
    groups: CHANNEL_GROUPS,
    // 每个通道的开通状态，便于后台直接展示「已开通 / 未开通」
    channelStatus: Object.fromEntries(CHANNEL_GROUPS.map((c) => [c.key, channelOpened(g, c.key)])),
    // 开关状态 + 开关已开但仍缺哪些参数（后台据此提示「还缺什么」）
    channelEnabled: Object.fromEntries(CHANNEL_GROUPS.map((c) => [c.key, channelEnabled(g, c.key)])),
    channelMissing: Object.fromEntries(CHANNEL_GROUPS.map((c) => [c.key, channelMissingParams(g, c.key)])),
  });
}

/* ============================================================
   公开：平台已开通的通知通道（车主后台 / 创建页据此筛选可选项）
   ============================================================ */
async function handlePublicChannels({ env }) {
  const g = await loadGlobal(env);
  const opened = platformChannels(g);
  return json({
    channels: Object.fromEntries(CHANNEL_GROUPS.map((c) => [c.key, channelOpened(g, c.key)])),
    available: opened,
    groups: CHANNEL_GROUPS.map((c) => ({ key: c.key, label: c.label, icon: c.icon })),
  });
}

async function handleAdminConfigPut({ request, env }) {
  assertConfig(env, ["DATA_ENCRYPTION_KEY"]);
  const input = await readJson(request);
  const updated = [];
  for (const [key, value] of Object.entries(input)) {
    const meta = SETTING_MAP[key];
    if (!meta) continue;
    const str = value === null || value === undefined ? "" : String(value);
    const stored = meta.secret ? await encryptText(env, str) : str;
    await env.DB.prepare(
      `INSERT INTO global_config (key, value, is_secret, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, is_secret=excluded.is_secret, updated_at=excluded.updated_at`
    )
      .bind(key, stored, meta.secret ? 1 : 0, nowIso())
      .run();
    updated.push(key);
  }
  return json({ message: "全局配置已保存。", updated });
}

/* ============================================================
   超级管理员：拨号日志（筛选 / 导出 / 批量删除）
   ============================================================ */
const CALL_LOG_LIMIT = 200;

async function buildCallLogQuery(url) {
  const q = (url.searchParams.get("q") || "").trim();          // 车牌（完整或片段）
  const channel = (url.searchParams.get("channel") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const from = (url.searchParams.get("from") || "").trim();     // YYYY-MM-DD
  const to = (url.searchParams.get("to") || "").trim();
  const last4 = (url.searchParams.get("last4") || "").trim();   // 号码后 4 位
  const vehicleId = (url.searchParams.get("vehicleId") || "").trim();

  const where = [];
  const binds = [];
  if (channel) { where.push("c.channel = ?"); binds.push(channel); }
  if (status) { where.push("c.status = ?"); binds.push(status); }
  if (vehicleId) { where.push("c.vehicle_id = ?"); binds.push(Number(vehicleId)); }
  if (from) { where.push("c.created_at >= ?"); binds.push(from.includes("T") ? from : `${from}T00:00:00.000Z`); }
  if (to) { where.push("c.created_at <= ?"); binds.push(to.includes("T") ? to : `${to}T23:59:59.999Z`); }
  if (q) {
    // 脱敏串只保留首尾，完整车牌需按哈希精确匹配；同时保留片段模糊匹配
    if (isPlate(q)) {
      where.push("(v.plate_number_masked LIKE ? OR v.plate_number_hash = ?)");
      binds.push(`%${q}%`, await sha256Hex(normalizePlate(q)));
    } else {
      where.push("(v.plate_number_masked LIKE ? OR v.plate_number_masked LIKE ?)");
      binds.push(`%${q}%`, `%${q.toUpperCase()}%`);
    }
  }
  if (last4) {
    where.push("(c.caller_last4 = ? OR c.callee_last4 = ? OR c.virtual_last4 = ?)");
    binds.push(last4, last4, last4);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, binds };
}

async function queryCallLogs(env, url, { limit = CALL_LOG_LIMIT, offset = 0 } = {}) {
  const { whereSql, binds } = await buildCallLogQuery(url);
  const rows = await env.DB.prepare(
    `SELECT c.*, v.plate_number_masked, v.plate_number_encrypted
     FROM call_logs c LEFT JOIN vehicles v ON v.id = c.vehicle_id
     ${whereSql} ORDER BY c.id DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, limit, offset)
    .all();
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM call_logs c LEFT JOIN vehicles v ON v.id = c.vehicle_id ${whereSql}`
  )
    .bind(...binds)
    .first();
  return { rows: rows.results || [], total: Number(count?.n || 0) };
}

async function callLogToView(env, row) {
  const dec = async (v) => (v ? await decryptText(env, v).catch(() => "") : "");
  let plate = row.plate_number_masked || "";
  if (row.plate_number_encrypted) plate = (await dec(row.plate_number_encrypted)) || plate;
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    plateNumber: plate,
    maskedPlate: plate,
    channel: row.channel,
    callerNumber: await dec(row.caller_number_enc),
    callerLast4: row.caller_last4 || "",
    calleeNumber: await dec(row.callee_number_enc),
    calleeLast4: row.callee_last4 || "",
    virtualNumber: await dec(row.virtual_number_enc),
    virtualLast4: row.virtual_last4 || "",
    status: row.status,
    errorSummary: row.error_summary || "",
    createdAt: row.created_at,
  };
}

async function handleAdminCallLogsList({ env, url }) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, CALL_LOG_LIMIT);
  const offset = Number(url.searchParams.get("offset")) || 0;
  const { rows, total } = await queryCallLogs(env, url, { limit, offset });
  const logs = [];
  for (const r of rows) logs.push(await callLogToView(env, r));
  return json({ logs, total, limit, offset });
}

async function handleAdminCallLogsExport({ env, url }) {
  const { rows } = await queryCallLogs(env, url, { limit: 5000, offset: 0 });
  const logs = [];
  for (const r of rows) logs.push(await callLogToView(env, r));
  return json({ logs, exportedAt: nowIso() });
}

async function handleAdminCallLogsBulkDelete({ request, env, url }) {
  const input = await readJson(request);
  const ids = Array.isArray(input.ids) ? input.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  // 支持「按筛选条件清空」：传 { all: true } 且带筛选参数
  if (!ids.length && input.all === true) {
    const { whereSql, binds } = await buildCallLogQuery(url);
    if (!whereSql) return json({ error: "no_filter", message: "未提供筛选条件，拒绝清空全部日志。" }, 400);
    const res = await env.DB.prepare(`DELETE FROM call_logs WHERE id IN (SELECT c.id FROM call_logs c LEFT JOIN vehicles v ON v.id = c.vehicle_id ${whereSql})`).bind(...binds).run();
    return json({ message: `已按筛选条件删除 ${res.meta?.changes ?? 0} 条日志。`, deleted: res.meta?.changes ?? 0 });
  }
  if (!ids.length) return json({ error: "no_ids", message: "请选择要删除的日志。" }, 400);
  if (ids.length > 2000) return json({ error: "too_many", message: "单次最多删除 2000 条。" }, 400);
  const ph = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(`DELETE FROM call_logs WHERE id IN (${ph})`).bind(...ids).run();
  return json({ message: `已删除 ${res.meta?.changes ?? 0} 条日志。`, deleted: res.meta?.changes ?? 0 });
}

/* ============================================================
   超级管理员：按车牌查车主手机号
   ============================================================ */
async function handleAdminLookup({ env, url }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const plate = normalizePlate(url.searchParams.get("plate"));
  if (!plate) return json({ error: "missing_plate", message: "请提供车牌号。" }, 400);
  const plateHash = await sha256Hex(plate);
  const vehicle = await env.DB.prepare("SELECT * FROM vehicles WHERE plate_number_hash = ?").bind(plateHash).first();
  if (!vehicle) return json({ found: false, message: "未找到该车牌绑定的挪车码。" });
  const g = await loadGlobal(env);
  let phone = null;
  try { phone = vehicle.owner_phone_encrypted ? await decryptText(env, vehicle.owner_phone_encrypted) : null; } catch {}
  const logs = await env.DB.prepare(
    `SELECT channel, status, created_at FROM notification_logs WHERE vehicle_id = ? ORDER BY id DESC LIMIT 5`
  ).bind(vehicle.id).all();
  return json({
    found: true,
    maskedPlate: await plateDisplay(env, vehicle),
    phone,
    channels: availableChannels(vehicle, g),
    smsEnabled: Boolean(vehicle.sms_enabled),
    privacyCallEnabled: Boolean(vehicle.privacy_call_enabled),
    createdAt: vehicle.created_at,
    recentNotifications: logs.results || [],
  });
}

/* ============================================================
   广告位：公开读取（仅返回已启用）
   ============================================================ */
async function handlePublicAds({ env, url }) {
  assertConfig(env, ["DB"]);
  const position = String(url.searchParams.get("position") || "").trim();
  const sql = position
    ? "SELECT id, position, title, image_url, link_url, sort_order FROM ads WHERE enabled = 1 AND position = ? ORDER BY sort_order ASC, id DESC"
    : "SELECT id, position, title, image_url, link_url, sort_order FROM ads WHERE enabled = 1 ORDER BY position ASC, sort_order ASC, id DESC";
  const rows = position
    ? await env.DB.prepare(sql).bind(position).all()
    : await env.DB.prepare(sql).all();
  return json({ ads: rows.results || [] });
}

/* ============================================================
   广告位：超级管理员增 / 改 / 删 / 查
   ============================================================ */
async function handleAdminAdsList({ env }) {
  const rows = await env.DB.prepare("SELECT * FROM ads ORDER BY position ASC, sort_order ASC, id DESC").all();
  return json({ positions: AD_POSITIONS, ads: rows.results || [] });
}

async function handleAdminAdsCreate({ request, env }) {
  const input = await readJson(request);
  const error = validateAdInput(input);
  if (error) return json(error, 400);
  let imageUrl;
  try { imageUrl = normalizeHttpUrl(input.imageUrl); }
  catch { return json({ error: "invalid_image_url", message: "广告图片链接必须是 http 或 https 地址。" }, 400); }
  let linkUrl = "";
  if (input.linkUrl) {
    try { linkUrl = normalizeHttpUrl(input.linkUrl); }
    catch { return json({ error: "invalid_link_url", message: "跳转链接必须是 http 或 https 地址。" }, 400); }
  }
  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO ads (position, title, image_url, link_url, sort_order, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(input.position, String(input.title || "").trim(), imageUrl, linkUrl, Number(input.sortOrder) || 0, input.enabled === false ? 0 : 1, now, now)
    .run();
  return json({ message: "广告已创建。", id: res.meta?.last_row_id ?? null }, 201);
}

async function handleAdminAdsUpdate({ request, env, params }) {
  const input = await readJson(request);
  const id = Number(params.id);
  const exists = await env.DB.prepare("SELECT id FROM ads WHERE id = ?").bind(id).first();
  if (!exists) return json({ error: "not_found", message: "广告不存在。" }, 404);
  const updates = [];
  const values = [];
  if ("position" in input) {
    if (!AD_POSITION_KEYS.includes(input.position)) return json({ error: "invalid_position", message: "广告位不合法。" }, 400);
    updates.push("position = ?"); values.push(input.position);
  }
  if ("title" in input) { updates.push("title = ?"); values.push(String(input.title || "").trim()); }
  if ("imageUrl" in input) {
    try { updates.push("image_url = ?"); values.push(normalizeHttpUrl(input.imageUrl)); }
    catch { return json({ error: "invalid_image_url", message: "广告图片链接必须是 http 或 https 地址。" }, 400); }
  }
  if ("linkUrl" in input) {
    const v = String(input.linkUrl || "").trim();
    if (!v) { updates.push("link_url = ?"); values.push(""); }
    else {
      try { updates.push("link_url = ?"); values.push(normalizeHttpUrl(v)); }
      catch { return json({ error: "invalid_link_url", message: "跳转链接必须是 http 或 https 地址。" }, 400); }
    }
  }
  if ("sortOrder" in input) { updates.push("sort_order = ?"); values.push(Number(input.sortOrder) || 0); }
  if ("enabled" in input) { updates.push("enabled = ?"); values.push(input.enabled ? 1 : 0); }
  if (!updates.length) return json({ message: "没有需要更新的字段。" });
  updates.push("updated_at = ?");
  values.push(nowIso(), id);
  await env.DB.prepare(`UPDATE ads SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ message: "广告已更新。" });
}

async function handleAdminAdsDelete({ env, params }) {
  const res = await env.DB.prepare("DELETE FROM ads WHERE id = ?").bind(Number(params.id)).run();
  if (changedRows(res) === 0) return json({ error: "not_found", message: "广告不存在。" }, 404);
  return json({ message: "广告已删除。" });
}

// D1 把受影响行数放在 meta.changes（顶层没有 changes 字段）
function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function validateAdInput(input) {
  if (!AD_POSITION_KEYS.includes(input.position)) return { error: "invalid_position", message: "请选择有效的广告位。" };
  if (!input.imageUrl || !String(input.imageUrl).trim()) return { error: "missing_image_url", message: "请填写广告图片链接。" };
  return null;
}

/* ============================================================
   超级管理员：车牌（车辆绑定）管理
   ============================================================ */
// 后台展示用的车辆视图（解密车牌/手机号/企业微信 Webhook）
async function adminVehicleView(env, v) {
  let plateNumber = v.plate_number_masked;
  let ownerPhone = "";
  let wechatOpenid = "";
  try { if (v.plate_number_encrypted) plateNumber = await decryptText(env, v.plate_number_encrypted); } catch {}
  try { if (v.owner_phone_encrypted) ownerPhone = await decryptText(env, v.owner_phone_encrypted); } catch {}
  try { if (v.wechat_openid) wechatOpenid = await decryptText(env, v.wechat_openid); } catch {}
  return {
    id: v.id,
    plateNumber,
    maskedPlate: plateNumber,
    plateMissing: !v.plate_number_encrypted,
    ownerPhone,
    wechatOpenid,
    notifyAllEnabled: Boolean(v.wechat_work_enabled && v.wechat_enabled),
    wechatWorkEnabled: Boolean(v.wechat_work_enabled),
    wechatEnabled: Boolean(v.wechat_enabled),
    smsEnabled: Boolean(v.sms_enabled),
    privacyCallEnabled: Boolean(v.privacy_call_enabled),
    hasPin: Boolean(v.owner_pin_hash),
    vehicleToken: v.vehicle_token,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

async function handleAdminVehiclesList({ env, url }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const q = String(url.searchParams.get("q") || "").trim();
  const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
  const rows = await env.DB.prepare("SELECT * FROM vehicles ORDER BY id DESC LIMIT ?").bind(limit).all();
  const list = [];
  for (const v of rows.results || []) list.push(await adminVehicleView(env, v));
  let filtered = list;
  if (q) {
    const qq = q.toLowerCase();
    filtered = list.filter(
      (v) =>
        String(v.plateNumber || "").toLowerCase().includes(qq) ||
        String(v.maskedPlate || "").toLowerCase().includes(qq) ||
        String(v.ownerPhone || "").includes(q) ||
        String(v.id) === q
    );
    // 老数据可能超出 limit，用哈希做一次精确补齐
    const plate = normalizePlate(q);
    if (isPlate(plate)) {
      const hit = await env.DB.prepare("SELECT * FROM vehicles WHERE plate_number_hash = ?").bind(await sha256Hex(plate)).first();
      if (hit && !filtered.some((x) => x.id === hit.id)) filtered.unshift(await adminVehicleView(env, hit));
    }
  }
  return json({ vehicles: filtered, total: filtered.length, scanned: list.length });
}

async function handleAdminVehicleCreate({ request, env }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const input = await readJson(request);
  const plate = normalizePlate(input.plateNumber);
  if (!isPlate(plate)) return json({ error: "invalid_plate", message: "请填写有效车牌号。" }, 400);
  // 一个车牌只能绑定一次：重复先拦截（避免被后面的必填校验抢先拦截）
  const dup = await env.DB.prepare("SELECT id FROM vehicles WHERE plate_number_hash = ?").bind(await sha256Hex(plate)).first();
  if (dup) return json({ error: "duplicate_plate", message: `车牌 ${plate} 已存在绑定（#${dup.id}），请直接编辑该记录。` }, 409);
  // 手机号必填：直接绑定到车牌
  if (!isPhone(input.ownerPhone)) return json({ error: "invalid_phone", message: "手机号必填，且需为有效号码。" }, 400);
  if (input.ownerPin && !isPin(input.ownerPin)) return json({ error: "invalid_pin", message: "管理密码需为 4-12 位数字。" }, 400);
  if (input.wechatWorkWebhook && !isHttpUrl(input.wechatWorkWebhook)) return json({ error: "invalid_wechat_work_webhook", message: "企业微信 Webhook 必须是 http 或 https 地址。" }, 400);
  const created = await insertVehicleRecord(env, { ...input, plateNumber: plate });
  return json({ message: `已新增 ${plate} 的挪车码绑定。`, ...created }, 201);
}

async function handleAdminVehicleUpdate({ request, env, params }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const id = Number(params.id);
  const vehicle = await env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(id).first();
  if (!vehicle) return json({ error: "not_found", message: "车辆不存在。" }, 404);
  const input = await readJson(request);
  const updates = [];
  const values = [];

  if ("plateNumber" in input) {
    const plate = normalizePlate(input.plateNumber);
    if (!isPlate(plate)) return json({ error: "invalid_plate", message: "请填写有效车牌号。" }, 400);
    const hash = await sha256Hex(plate);
    const dup = await env.DB.prepare("SELECT id FROM vehicles WHERE plate_number_hash = ? AND id <> ?").bind(hash, id).first();
    if (dup) return json({ error: "duplicate_plate", message: `车牌 ${plate} 已被其它绑定占用（#${dup.id}）。` }, 409);
    updates.push("plate_number_hash = ?", "plate_number_masked = ?", "plate_number_encrypted = ?");
    values.push(hash, maskPlate(plate), await encryptText(env, plate));
  }
  if ("ownerPhone" in input) {
    if (input.ownerPhone) {
      if (!isPhone(input.ownerPhone)) return json({ error: "invalid_phone", message: "手机号格式不正确。" }, 400);
      updates.push("owner_phone_encrypted = ?"); values.push(await encryptText(env, normalizePhone(input.ownerPhone)));
    } else { updates.push("owner_phone_encrypted = ?"); values.push(null); }
  }
  if ("notifyAllEnabled" in input && typeof input.notifyAllEnabled === "boolean") {
    const v = input.notifyAllEnabled ? 1 : 0;
    updates.push("wechat_work_enabled = ?"); values.push(v);
    updates.push("wechat_enabled = ?"); values.push(v);
  }
  if ("wechatWorkEnabled" in input && typeof input.wechatWorkEnabled === "boolean") { updates.push("wechat_work_enabled = ?"); values.push(input.wechatWorkEnabled ? 1 : 0); }
  if ("wechatEnabled" in input && typeof input.wechatEnabled === "boolean") { updates.push("wechat_enabled = ?"); values.push(input.wechatEnabled ? 1 : 0); }
  if ("wechatOpenid" in input) {
    if (input.wechatOpenid) { updates.push("wechat_openid = ?"); values.push(await encryptText(env, String(input.wechatOpenid).trim())); }
    else { updates.push("wechat_openid = ?"); values.push(null); }
  }
  if (typeof input.smsEnabled === "boolean") { updates.push("sms_enabled = ?"); values.push(input.smsEnabled ? 1 : 0); }
  if (typeof input.privacyCallEnabled === "boolean") { updates.push("privacy_call_enabled = ?"); values.push(input.privacyCallEnabled ? 1 : 0); }
  if ("ownerPin" in input) {
    if (!input.ownerPin) { updates.push("owner_pin_hash = ?"); values.push(null); }
    else {
      if (!isPin(input.ownerPin)) return json({ error: "invalid_pin", message: "管理密码需为 4-12 位数字。" }, 400);
      updates.push("owner_pin_hash = ?"); values.push(await sha256Hex(`pin:${input.ownerPin}`));
    }
  }
  if (!updates.length) return json({ message: "没有需要更新的字段。" });
  updates.push("updated_at = ?");
  values.push(nowIso(), id);
  await env.DB.prepare(`UPDATE vehicles SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ message: "车辆信息已更新。" });
}

async function handleAdminVehicleDelete({ env, params }) {
  assertConfig(env, ["DB"]);
  const id = Number(params.id);
  const vehicle = await env.DB.prepare("SELECT id FROM vehicles WHERE id = ?").bind(id).first();
  if (!vehicle) return json({ error: "not_found", message: "车辆不存在。" }, 404);
  await env.DB.prepare("DELETE FROM notification_logs WHERE vehicle_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM vehicles WHERE id = ?").bind(id).run();
  await releaseQrForVehicle(env, id);
  return json({ message: "该车牌绑定已删除。" });
}

// 车辆被删后，把绑定到它的二维码退回「未绑定」，便于重新贴到别的车上
async function releaseQrForVehicle(env, vehicleId) {
  await env.DB.prepare(
    "UPDATE qr_codes SET status = 'unbound', vehicle_id = NULL, bound_at = NULL, updated_at = ? WHERE vehicle_id = ?"
  ).bind(nowIso(), vehicleId).run().catch(() => {});
}

async function handleAdminVehicleOwnerToken({ env, params }) {
  assertConfig(env, ["DB"]);
  const v = await env.DB.prepare("SELECT id, owner_token, plate_number_masked, plate_number_encrypted FROM vehicles WHERE id = ?").bind(Number(params.id)).first();
  if (!v) return json({ error: "not_found", message: "车辆不存在。" }, 404);
  return json({ ownerToken: v.owner_token, maskedPlate: await plateDisplay(env, v) });
}

async function handleAdminVehicleImport({ request, env }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const input = await readJson(request);
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) return json({ error: "empty_import", message: "没有可导入的数据。" }, 400);
  if (items.length > 500) return json({ error: "too_many", message: "单次最多导入 500 条。" }, 400);
  const created = [];
  const skipped = [];
  const failed = [];
  for (const item of items) {
    const plate = normalizePlate(item.plateNumber);
    if (!isPlate(plate)) { failed.push({ plateNumber: String(item.plateNumber || ""), reason: "车牌格式无效" }); continue; }
    const dup = await env.DB.prepare("SELECT id FROM vehicles WHERE plate_number_hash = ?").bind(await sha256Hex(plate)).first();
    if (dup) { skipped.push(plate); continue; }
    if (item.ownerPhone && !isPhone(item.ownerPhone)) { failed.push({ plateNumber: plate, reason: "手机号格式不正确" }); continue; }
    if (item.ownerPin && !isPin(item.ownerPin)) { failed.push({ plateNumber: plate, reason: "管理密码需 4-12 位数字" }); continue; }
    if (item.wechatWorkWebhook && !isHttpUrl(item.wechatWorkWebhook)) { failed.push({ plateNumber: plate, reason: "企业微信 Webhook 非法" }); continue; }
    try {
      await insertVehicleRecord(env, { ...item, plateNumber: plate });
      created.push(plate);
    } catch (error) {
      failed.push({ plateNumber: plate, reason: String(error.message || error).slice(0, 120) });
    }
  }
  return json({
    message: `导入完成：成功 ${created.length} 条，跳过重复 ${skipped.length} 条，失败 ${failed.length} 条。`,
    created,
    skipped,
    failed,
  });
}

async function handleAdminVehicleExport({ env }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const rows = await env.DB.prepare("SELECT * FROM vehicles ORDER BY id ASC LIMIT 2000").all();
  const vehicles = [];
  for (const v of rows.results || []) vehicles.push(await adminVehicleView(env, v));
  return json({ vehicles, exportedAt: nowIso(), count: vehicles.length });
}

/* ============================================================
   预生成二维码：后台批量出码 → 扫码绑定 → 再扫即挪车界面
   ============================================================ */
const QR_STATUS = ["unbound", "bound", "disabled"];

async function handleAdminQrBatch({ request, env }) {
  assertConfig(env, ["DB"]);
  const input = await readJson(request);
  const count = Math.min(Math.max(Number(input.count) || 0, 1), 200);
  const batchNo = String(input.batchNo || "").trim().slice(0, 40)
    || `B${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  const note = String(input.note || "").trim().slice(0, 100);
  const now = nowIso();
  const codes = [];
  const stmts = [];
  for (let i = 0; i < count; i++) {
    const codeToken = await token("qr");
    stmts.push(
      env.DB.prepare(
        `INSERT INTO qr_codes (code_token, batch_no, status, note, created_at, updated_at)
         VALUES (?, ?, 'unbound', ?, ?, ?)`
      ).bind(codeToken, batchNo, note, now, now)
    );
    codes.push(codeToken);
  }
  await env.DB.batch(stmts);
  return json({ message: `已生成 ${count} 个二维码（批次 ${batchNo}）。`, batchNo, count, codes });
}

async function handleAdminQrList({ env, url }) {
  assertConfig(env, ["DB"]);
  const status = String(url.searchParams.get("status") || "").trim();
  const batch = String(url.searchParams.get("batch") || "").trim();
  const q = String(url.searchParams.get("q") || "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const where = [];
  const vals = [];
  if (status && QR_STATUS.includes(status)) { where.push("c.status = ?"); vals.push(status); }
  if (batch) { where.push("c.batch_no = ?"); vals.push(batch); }
  if (q) {
    where.push("(c.code_token LIKE ? OR c.batch_no LIKE ? OR c.note LIKE ? OR v.plate_number_masked LIKE ?)");
    vals.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await env.DB.prepare(
    `SELECT c.*, v.plate_number_masked AS masked_plate, v.plate_number_encrypted AS encrypted_plate, v.vehicle_token AS vehicle_token
     FROM qr_codes c LEFT JOIN vehicles v ON v.id = c.vehicle_id
     ${clause} ORDER BY c.id DESC LIMIT ? OFFSET ?`
  ).bind(...vals, limit, offset).all();
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM qr_codes c LEFT JOIN vehicles v ON v.id = c.vehicle_id ${clause}`
  ).bind(...vals).first();
  const stats = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'unbound' THEN 1 ELSE 0 END) AS unbound,
            SUM(CASE WHEN status = 'bound' THEN 1 ELSE 0 END) AS bound,
            SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled
     FROM qr_codes`
  ).first();
  const batchRows = await env.DB.prepare(
    `SELECT batch_no, COUNT(*) AS n FROM qr_codes WHERE batch_no <> '' GROUP BY batch_no ORDER BY batch_no DESC LIMIT 50`
  ).all();

  const codes = [];
  for (const r of rows.results || []) {
    codes.push({
      id: r.id,
      codeToken: r.code_token,
      batchNo: r.batch_no,
      status: r.status,
      note: r.note,
      maskedPlate: await plateDisplay(env, { plate_number_masked: r.masked_plate, plate_number_encrypted: r.encrypted_plate }),
      vehicleToken: r.vehicle_token || "",
      boundAt: r.bound_at,
      createdAt: r.created_at,
    });
  }

  return json({
    codes,
    total: totalRow?.n || 0,
    stats: {
      total: stats?.total || 0,
      unbound: stats?.unbound || 0,
      bound: stats?.bound || 0,
      disabled: stats?.disabled || 0,
    },
    batches: (batchRows.results || []).map((b) => ({ batchNo: b.batch_no, count: b.n })),
  });
}

async function handleAdminQrUpdate({ request, env, params }) {
  assertConfig(env, ["DB"]);
  const id = Number(params.id);
  const input = await readJson(request);
  const status = String(input.status || "").trim();
  if (!["unbound", "disabled"].includes(status)) {
    return json({ error: "invalid_status", message: "状态只能设为启用或停用。" }, 400);
  }
  const row = await env.DB.prepare("SELECT * FROM qr_codes WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "not_found", message: "二维码不存在。" }, 404);
  if (row.status === "bound") return json({ error: "already_bound", message: "已绑定的二维码不能改状态。" }, 400);
  await env.DB.prepare("UPDATE qr_codes SET status = ?, updated_at = ? WHERE id = ?").bind(status, nowIso(), id).run();
  return json({ message: status === "disabled" ? "二维码已停用。" : "二维码已启用。" });
}

async function handleAdminQrDelete({ env, params }) {
  assertConfig(env, ["DB"]);
  const id = Number(params.id);
  const row = await env.DB.prepare("SELECT * FROM qr_codes WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "not_found", message: "二维码不存在。" }, 404);
  if (row.status === "bound") {
    return json({ error: "already_bound", message: "该二维码已绑定车辆，请先在「车牌管理」删除对应车牌。" }, 400);
  }
  await env.DB.prepare("DELETE FROM qr_codes WHERE id = ?").bind(id).run();
  return json({ message: "二维码已删除。" });
}

async function handleAdminQrBulkDelete({ request, env }) {
  assertConfig(env, ["DB"]);
  const input = await readJson(request);
  const ids = Array.isArray(input.ids) ? input.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return json({ error: "empty_selection", message: "请先选择要删除的二维码。" }, 400);
  const placeholders = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `DELETE FROM qr_codes WHERE id IN (${placeholders}) AND status <> 'bound'`
  ).bind(...ids).run();
  return json({ message: `已删除 ${changedRows(res)} 个未绑定二维码（已绑定的已自动跳过）。` });
}

// 公开：扫码解析（未绑定 → 引导绑定；已绑定 → 返回车辆令牌进挪车界面）
async function handleQrResolve({ env, params }) {
  assertConfig(env, ["DB"]);
  const row = await env.DB.prepare("SELECT * FROM qr_codes WHERE code_token = ?").bind(params.codeToken).first();
  if (!row) return json({ error: "qr_not_found", message: "二维码无效或已被删除。" }, 404);
  if (row.status === "disabled") return json({ error: "qr_disabled", message: "该二维码已被停用。" }, 410);
  if (row.status === "bound" && row.vehicle_id) {
    const v = await env.DB.prepare("SELECT vehicle_token, plate_number_masked, plate_number_encrypted FROM vehicles WHERE id = ?")
      .bind(row.vehicle_id).first();
    if (v) return json({ status: "bound", vehicleToken: v.vehicle_token, maskedPlate: await plateDisplay(env, v) });
    return json({ status: "unbound" }); // 车辆已被删除 → 退回未绑定
  }
  return json({ status: "unbound" });
}

// 公开：车主扫码后绑定该二维码到自己的车牌
async function handleQrBind({ request, env, params }) {
  assertConfig(env, ["DB", "DATA_ENCRYPTION_KEY"]);
  const row = await env.DB.prepare("SELECT * FROM qr_codes WHERE code_token = ?").bind(params.codeToken).first();
  if (!row) return json({ error: "qr_not_found", message: "二维码无效或已被删除。" }, 404);
  if (row.status === "disabled") return json({ error: "qr_disabled", message: "该二维码已被停用。" }, 410);
  if (row.status === "bound") {
    return json({ error: "qr_bound", message: "该二维码已绑定车辆，直接扫码即可使用。" }, 409);
  }
  const input = await readJson(request);
  const validationError = validateVehicleInput(input, { requirePhone: true });
  if (validationError) return json(validationError, 400);

  const plate = normalizePlate(input.plateNumber);
  const plateHash = await sha256Hex(plate);
  const exists = await env.DB.prepare(
    "SELECT id, plate_number_masked, owner_pin_hash FROM vehicles WHERE plate_number_hash = ?"
  ).bind(plateHash).first();
  if (exists) {
    return json(
      {
        error: "plate_exists",
        message: "该车牌已录入过，一个车牌只能录入一次。请用「车牌 + 管理密码」找回管理入口。",
        maskedPlate: plate,
        canRecover: Boolean(exists.owner_pin_hash),
      },
      409
    );
  }

  const g = await loadGlobal(env);
  const bundleOn = Boolean(input.notifyAllEnabled || input.wechatEnabled || input.wechatWorkEnabled);
  const wanted = [];
  if (bundleOn) { wanted.push("wechat_work"); wanted.push("wechat"); }
  if (input.smsEnabled) wanted.push("sms");
  if (input.privacyCallEnabled) wanted.push("privacy_call");
  const usable = wanted.filter((c) => channelOpened(g, c));
  if (wanted.length && !usable.length) {
    return json({ error: "no_available_channel", message: "所选通知方式平台尚未开通，请联系管理员开通后再试。" }, 400);
  }
  if (!wanted.length && !isOn(g.direct_call_enabled_global)) {
    return json({ error: "no_available_channel", message: "平台尚未开通任何通知方式，请联系管理员开通后再试。" }, 400);
  }

  const created = await insertVehicleRecord(env, { ...input, plateNumber: plate });
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE qr_codes SET status = 'bound', vehicle_id = ?, bound_at = ?, updated_at = ? WHERE id = ?"
  ).bind(created.id, now, now, row.id).run();
  return json({ message: "绑定成功，此二维码已生效。", ...created }, 201);
}

/* ============================================================
   超级管理员：修改自己的登录密码
   ============================================================ */
async function handleAdminPasswordChange({ request, env, admin }) {
  assertConfig(env, ["DB"]);
  const input = await readJson(request);
  const current = String(input.currentPassword || "");
  const next = String(input.newPassword || "");
  if (next.length < 8) return json({ error: "weak_password", message: "新密码至少 8 位。" }, 400);
  const row = await env.DB.prepare("SELECT * FROM admins WHERE username = ?").bind(admin).first();
  if (!row) return json({ error: "not_found", message: "账号不存在。" }, 404);
  if (!(await verifyPassword(current, row.salt, row.password_hash))) {
    return json({ error: "invalid_password", message: "当前密码不正确。" }, 400);
  }
  const salt = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await sha256Hex(`${salt}:${next}`);
  await env.DB.prepare("UPDATE admins SET password_hash = ?, salt = ? WHERE username = ?").bind(hash, salt, admin).run();
  // 改密后强制所有会话失效（含当前会话），前端需重新登录
  await env.DB.prepare("DELETE FROM admin_sessions WHERE username = ?").bind(admin).run();
  return json({ message: "密码已修改，请使用新密码重新登录。" });
}

/* ============================================================
   数据读取 / 通道解析
   ============================================================ */
async function getVehicleByToken(env, vehicleToken) {
  return env.DB.prepare("SELECT * FROM vehicles WHERE vehicle_token = ?").bind(vehicleToken).first();
}
async function getVehicleByOwnerToken(env, ownerToken) {
  return env.DB.prepare("SELECT * FROM vehicles WHERE owner_token = ?").bind(ownerToken).first();
}

async function loadGlobal(env) {
  const rows = await env.DB.prepare("SELECT key, value, is_secret FROM global_config").all();
  const map = {};
  for (const s of GLOBAL_SETTINGS) if (s.def !== undefined) map[s.key] = s.def;
  for (const r of rows.results || []) {
    map[r.key] = r.is_secret ? await decryptText(env, r.value) : r.value;
  }
  return map;
}

function isOn(value, def = true) {
  const v = String(value ?? (def ? "true" : "false")).trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off" && v !== "no";
}

// 短信服务商参数是否配置完整
function smsVendorReady(g) {
  const v = g.sms_vendor || "tencent";
  if (v === "tencent") return !!(g.tencent_secret_id && g.tencent_secret_key && g.tencent_sms_app_id && g.tencent_sms_sign_name && g.tencent_sms_template_id);
  if (v === "aliyun") return !!(g.aliyun_access_key_id && g.aliyun_access_key_secret && g.aliyun_sms_sign_name && g.aliyun_sms_template_code);
  if (v === "custom") return !!g.sms_custom_webhook;
  return false;
}
// 隐私号服务商参数是否配置完整
function privacyVendorReady(g) {
  const v = g.privacy_vendor || "custom";
  if (v === "custom") return !!g.privacy_call_webhook_url;
  if (v === "tencent") return !!(g.tencent_secret_id && g.tencent_secret_key);
  if (v === "aliyun") return !!(g.aliyun_access_key_id && g.aliyun_access_key_secret);
  return false;
}
// 微信公众号模板消息参数是否配置完整
function wechatMpReady(g) {
  return !!(g.wechat_mp_appid && g.wechat_mp_secret && g.wechat_mp_template_id);
}

// 通道「启用开关」状态（超管后台的开关）
function channelEnabled(g, ch) {
  if (ch === "wechat_work") return isOn(g.wechat_enabled_global);
  if (ch === "wechat") return isOn(g.wechat_notify_enabled_global);
  if (ch === "sms") return isOn(g.sms_enabled_global);
  if (ch === "privacy_call") return isOn(g.privacy_enabled_global);
  if (ch === "direct_call") return isOn(g.direct_call_enabled_global);
  return false;
}

// 开关打开后仍缺少的服务商参数（返回中文标签，供后台提示「还缺什么」）
function channelMissingParams(g, ch) {
  const miss = [];
  if (ch === "wechat_work") {
    if (!g.wechat_work_webhook) miss.push("企业微信默认 Webhook");
  } else if (ch === "wechat") {
    if (!g.wechat_mp_appid) miss.push("公众号 AppID");
    if (!g.wechat_mp_secret) miss.push("公众号 AppSecret");
    if (!g.wechat_mp_template_id) miss.push("模板消息 ID");
  } else if (ch === "sms") {
    const v = g.sms_vendor || "tencent";
    if (v === "tencent") {
      if (!g.tencent_secret_id) miss.push("腾讯云 SecretId");
      if (!g.tencent_secret_key) miss.push("腾讯云 SecretKey");
      if (!g.tencent_sms_app_id) miss.push("短信 SmsSdkAppId");
      if (!g.tencent_sms_sign_name) miss.push("短信签名");
      if (!g.tencent_sms_template_id) miss.push("短信模板 ID");
    } else if (v === "aliyun") {
      if (!g.aliyun_access_key_id) miss.push("阿里云 AccessKeyId");
      if (!g.aliyun_access_key_secret) miss.push("阿里云 AccessKeySecret");
      if (!g.aliyun_sms_sign_name) miss.push("短信签名");
      if (!g.aliyun_sms_template_code) miss.push("短信模板 CODE");
    } else if (v === "custom") {
      if (!g.sms_custom_webhook) miss.push("短信 Webhook 地址");
    } else {
      miss.push("短信服务商");
    }
  } else if (ch === "privacy_call") {
    const v = g.privacy_vendor || "custom";
    if (v === "custom") {
      if (!g.privacy_call_webhook_url) miss.push("隐私号 Webhook 地址");
    } else if (v === "tencent") {
      if (!g.tencent_secret_id) miss.push("腾讯云 SecretId");
      if (!g.tencent_secret_key) miss.push("腾讯云 SecretKey");
    } else if (v === "aliyun") {
      if (!g.aliyun_access_key_id) miss.push("阿里云 AccessKeyId");
      if (!g.aliyun_access_key_secret) miss.push("阿里云 AccessKeySecret");
    } else {
      miss.push("隐私号服务商");
    }
  }
  return miss;
}

// 管理员是否在后台真正「开通」了某通道 = 开关打开 + 服务商参数齐全
function channelOpened(g, ch) {
  return channelEnabled(g, ch) && channelMissingParams(g, ch).length === 0;
}

// 平台已开通的通道（供车主后台 / 创建页筛选可选项）
function platformChannels(g) {
  return ["wechat_work", "wechat", "sms", "privacy_call"].filter((c) => channelOpened(g, c));
}

// 访客可用的通知通道。
// 「一键通知」= 同时调用企业微信接口 + 微信公众号模板消息接口；
// 当两者都可用时合成一个 notify_all 通道，让访客一键同时送达，避免二选一。
function availableChannels(vehicle, g) {
  const list = [];
  const workOn = channelOpened(g, "wechat_work") && Boolean(vehicle.wechat_work_enabled);
  const wechatOn = channelOpened(g, "wechat") && Boolean(vehicle.wechat_enabled);
  if (workOn && wechatOn) list.push("notify_all");
  else {
    if (workOn) list.push("wechat_work");
    if (wechatOn) list.push("wechat");
  }
  if (channelOpened(g, "sms") && vehicle.sms_enabled && vehicle.owner_phone_encrypted) list.push("sms");
  if (channelOpened(g, "privacy_call") && vehicle.privacy_call_enabled && vehicle.owner_phone_encrypted) list.push("privacy_call");
  return list;
}

// 访客拨打方式：隐私拨号优先；未开启隐私拨号则为直拨（默认）。返回 privacy / direct / none
function resolveCallMode(vehicle, g, channels) {
  if ((channels || availableChannels(vehicle, g)).includes("privacy_call")) return "privacy";
  if (isOn(g.direct_call_enabled_global) && vehicle.owner_phone_encrypted) return "direct";
  return "none";
}

function defaultNotifyChannel(vehicle, g) {
  const channels = availableChannels(vehicle, g);
  return ["notify_all", "wechat_work", "wechat", "sms", "privacy_call"].find((c) => channels.includes(c)) || "";
}

/* ============================================================
   限流计数
   ============================================================ */
async function checkRateLimit(env, key, max, windowSeconds) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, expires_at FROM rate_logs WHERE key = ?").bind(key).first();
  if (row && new Date(row.expires_at).getTime() > now) {
    if (row.count >= max) return false;
    await env.DB.prepare("UPDATE rate_logs SET count = count + 1 WHERE key = ?").bind(key).run();
    return true;
  }
  const expires = new Date(now + windowSeconds * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO rate_logs (key, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = 1, expires_at = excluded.expires_at`
  ).bind(key, expires).run();
  return true;
}

/* ============================================================
   输入校验 / 工具
   ============================================================ */
async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function assertConfig(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) throw new ConfigError(`后端配置不完整：${missing.join(", ")}`, missing);
}

class ConfigError extends Error {
  constructor(message, missing) { super(message); this.name = "ConfigError"; this.missing = missing; }
}
class AuthError extends Error {
  constructor(message) { super(message); this.name = "AuthError"; }
}
class NotFoundError extends Error {
  constructor(message) { super(message); this.name = "NotFoundError"; }
}

async function token(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `${prefix}_${bytesToBase64Url(bytes)}`;
}
function nowIso() { return new Date().toISOString(); }
function normalizePlate(value) { return String(value || "").trim().replace(/\s+/g, "").toUpperCase(); }
function normalizeHttpUrl(value) { return new URL(String(value || "").trim()).toString(); }
function normalizePhone(value) { return String(value || "").trim().replace(/[\s-]/g, ""); }

function validateVehicleInput(input, { requireNotification = false, requirePhone = false, partial = false, hasStoredPhone = false } = {}) {
  if (partial) {
    const requiresPhone = Boolean(input.smsEnabled || input.privacyCallEnabled);
    if ((requiresPhone && !hasStoredPhone) || (input.ownerPhone && String(input.ownerPhone).length)) {
      if (!isPhone(input.ownerPhone)) return { error: "invalid_phone", message: "请填写有效手机号，或关闭短信/隐私号通知。" };
    }
    if (input.wechatWorkWebhook && !isHttpUrl(input.wechatWorkWebhook)) return { error: "invalid_wechat_work_webhook", message: "企业微信机器人 Webhook 必须是 http 或 https 地址。" };
    return null;
  }
  const plate = normalizePlate(input.plateNumber);
  if (!isPlate(plate)) return { error: "invalid_plate", message: "请填写有效车牌号。" };
  if (input.ownerPin && !isPin(input.ownerPin)) return { error: "invalid_pin", message: "管理密码需为 4-12 位数字。" };
  // 手机号在录入车牌时为必填（直接绑定到车牌）
  if (requirePhone && !isPhone(input.ownerPhone)) {
    return { error: "invalid_phone", message: "请填写有效手机号（录入车牌时必填，用于短信 / 隐私号通知与换号验证）。" };
  }
  // 通知方式不再强制：未开启任何通道时默认走「直拨」（由创建接口按平台开关兜底校验）
  if (input.wechatWorkWebhook && !isHttpUrl(input.wechatWorkWebhook)) return { error: "invalid_wechat_work_webhook", message: "企业微信机器人 Webhook 必须是 http 或 https 地址。" };
  const requiresPhone = Boolean(input.smsEnabled || input.privacyCallEnabled);
  if ((requiresPhone && !hasStoredPhone) || input.ownerPhone) {
    if (!isPhone(input.ownerPhone)) return { error: "invalid_phone", message: "请填写有效手机号，或关闭短信/隐私号通知。" };
  }
  return null;
}

function isHttpUrl(value) {
  try { const url = new URL(String(value || "").trim()); return ["http:", "https:"].includes(url.protocol); } catch { return false; }
}
function isPhone(value) { return /^\+?\d[\d\s-]{6,19}$/.test(String(value || "").trim()); }
function isPlate(value) { return /^[\u4e00-\u9fa5A-Z0-9]{5,10}$/.test(String(value || "").trim()); }
function isPin(value) { return /^\d{4,12}$/.test(String(value || "").trim()); }
// 全站车牌完整显示（不再用 * 打码）：保留函数名兼容旧调用点，直接返回完整车牌
function maskPlate(value) {
  return normalizePlate(value);
}
// 车牌完整显示（全站不再用 * 打码）：优先解密，老数据没有密文时退回原值
async function plateDisplay(env, row) {
  if (!row) return "";
  if (row.plateDisplay) return row.plateDisplay;
  if (row.plate_number_encrypted) {
    try {
      const full = await decryptText(env, row.plate_number_encrypted);
      if (full) return full;
    } catch {}
  }
  return row.plate_number_masked || "";
}
function maskPhone(value) {
  const p = String(value || "");
  if (p.length <= 5) return "****";
  return `${p.slice(0, 3)}****${p.slice(-2)}`;
}
async function visitorIpHash(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown";
  return sha256Hex(`${env.IP_HASH_SALT || "move-car"}:${ip}`);
}

/* ============================================================
   加密 / 哈希
   ============================================================ */
async function encryptText(env, value) {
  assertConfig(env, ["DATA_ENCRYPTION_KEY"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env.DATA_ENCRYPTION_KEY);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}
async function decryptText(env, value) {
  assertConfig(env, ["DATA_ENCRYPTION_KEY"]);
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
  const cryptoKey = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}
// 阿里云 RPC 签名需要 HMAC-SHA1
async function hmacRaw(key, value) {
  const cryptoKey = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}
function bytesToHex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function bytesToBase64(bytes) { let s = ""; bytes.forEach((b) => (s += String.fromCharCode(b))); return btoa(s); }
function bytesToBase64Url(bytes) { return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function base64UrlToBytes(value) {
  const base64 = String(value || "").replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function toE164(phone, countryCode) {
  const trimmed = String(phone || "").trim();
  if (trimmed.startsWith("+")) return trimmed;
  return `${countryCode}${trimmed.replace(/^0+/, "")}`;
}
