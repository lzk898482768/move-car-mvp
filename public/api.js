// Worker API 客户端（零依赖）
// window.MOVE_CAR_API_BASE 取值：
//   - "same-origin"：同源模式，走 Pages Functions 服务绑定（推荐，配置见 functions/api/）
//   - "https://..."：直连 Worker 地址
//   - 留空：回退到 localStorage 中用户手动填入的地址。

const STORAGE_KEY = "move_car_api_base";
const SAME_ORIGIN = "same-origin";

export function normalizeBase(v) {
  return v ? String(v).trim().replace(/\/+$/, "") : "";
}

function isSameOrigin() {
  return (window.MOVE_CAR_API_BASE || "") === SAME_ORIGIN;
}

export function getApiBase() {
  if (isSameOrigin()) return "";
  const fromConfig = window.MOVE_CAR_API_BASE || "";
  if (fromConfig) return normalizeBase(fromConfig);
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return normalizeBase(stored);
  } catch {}
  return "";
}

export function setApiBase(value) {
  try {
    localStorage.setItem(STORAGE_KEY, normalizeBase(value));
  } catch {}
}

export function hasApiBase() {
  return isSameOrigin() || Boolean(getApiBase());
}

// 统一请求封装（支持自定义 headers，如管理员令牌）
async function request(path, { method = "GET", body, headers: extraHeaders } = {}) {
  const base = getApiBase();
  if (!base && !isSameOrigin()) {
    const err = new Error("未配置后端地址（API Base）。");
    err.code = "NO_API_BASE";
    throw err;
  }
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (extraHeaders) Object.assign(headers, extraHeaders);
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error("网络错误，无法连接后端：" + (e.message || ""));
    err.code = "NETWORK";
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {}

  if (!res.ok) {
    const err = new Error(
      data?.message || (data?.error ? `请求失败：${data.error}` : `请求失败（${res.status}）`)
    );
    err.code = data?.error || "error";
    err.status = res.status;
    throw err;
  }
  return data;
}

// 管理员令牌本地缓存
const ADMIN_KEY = "move_car_admin_token";
export function saveAdminToken(token) { try { localStorage.setItem(ADMIN_KEY, token); } catch {} }
export function loadAdminToken() { try { return localStorage.getItem(ADMIN_KEY) || ""; } catch { return ""; } }
export function clearAdminToken() { try { localStorage.removeItem(ADMIN_KEY); } catch {} }

export const api = {
  health: () => request("/api/health"),

  createVehicle: (input) =>
    request("/api/vehicles", { method: "POST", body: input }),

  getPublicVehicle: (token) =>
    request(`/api/vehicles/${encodeURIComponent(token)}/public`),

  notify: (token, channel) =>
    request(`/api/vehicles/${encodeURIComponent(token)}/notify`, {
      method: "POST",
      body: channel ? { channel } : {},
    }),

  getOwnerVehicle: (ownerToken) =>
    request(`/api/owner/${encodeURIComponent(ownerToken)}/vehicle`),

  patchOwnerVehicle: (ownerToken, patch) =>
    request(`/api/owner/${encodeURIComponent(ownerToken)}/vehicle`, {
      method: "PATCH",
      body: patch,
    }),

  regenerateToken: (ownerToken) =>
    request(`/api/owner/${encodeURIComponent(ownerToken)}/vehicle/regenerate-token`, {
      method: "POST",
    }),

  deleteVehicle: (ownerToken) =>
    request(`/api/owner/${encodeURIComponent(ownerToken)}/vehicle`, {
      method: "DELETE",
    }),

  // 车主：车牌 + 管理密码 找回 ownerToken
  recoverOwner: (plateNumber, ownerPin) =>
    request("/api/owner/recover", { method: "POST", body: { plateNumber, ownerPin } }),

  // 超级管理员
  adminLogin: (username, password) =>
    request("/api/admin/login", { method: "POST", body: { username, password } }),

  adminLogout: (token) =>
    request("/api/admin/logout", {
      method: "POST",
      headers: { "X-Admin-Token": token },
    }),

  adminGetConfig: (token) =>
    request("/api/admin/config", { headers: { "X-Admin-Token": token } }),

  adminPutConfig: (token, settings) =>
    request("/api/admin/config", {
      method: "PUT",
      headers: { "X-Admin-Token": token },
      body: settings,
    }),

  adminListAccounts: (token) =>
    request("/api/admin/accounts", { headers: { "X-Admin-Token": token } }),

  adminCreateAccount: (token, payload) =>
    request("/api/admin/accounts", {
      method: "POST",
      headers: { "X-Admin-Token": token },
      body: payload,
    }),

  adminDeleteAccount: (token, username) =>
    request(`/api/admin/accounts/${encodeURIComponent(username)}`, {
      method: "DELETE",
      headers: { "X-Admin-Token": token },
    }),

  adminLookup: (token, plate) =>
    request(`/api/admin/lookup?plate=${encodeURIComponent(plate)}`, {
      headers: { "X-Admin-Token": token },
    }),

  // 广告位：公开读取（仅已启用）
  listAds: (position) =>
    request(`/api/ads${position ? `?position=${encodeURIComponent(position)}` : ""}`),

  // 广告位：管理员
  adminListAds: (token) =>
    request("/api/admin/ads", { headers: { "X-Admin-Token": token } }),

  adminCreateAd: (token, payload) =>
    request("/api/admin/ads", {
      method: "POST",
      headers: { "X-Admin-Token": token },
      body: payload,
    }),

  adminUpdateAd: (token, id, payload) =>
    request(`/api/admin/ads/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "X-Admin-Token": token },
      body: payload,
    }),

  adminDeleteAd: (token, id) =>
    request(`/api/admin/ads/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Admin-Token": token },
    }),

  // 车牌（车辆绑定）管理
  adminListVehicles: (token, q) =>
    request(`/api/admin/vehicles${q ? `?q=${encodeURIComponent(q)}` : ""}`, {
      headers: { "X-Admin-Token": token },
    }),

  adminCreateVehicle: (token, payload) =>
    request("/api/admin/vehicles", {
      method: "POST",
      headers: { "X-Admin-Token": token },
      body: payload,
    }),

  adminUpdateVehicle: (token, id, payload) =>
    request(`/api/admin/vehicles/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "X-Admin-Token": token },
      body: payload,
    }),

  adminDeleteVehicle: (token, id) =>
    request(`/api/admin/vehicles/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Admin-Token": token },
    }),

  adminImportVehicles: (token, items) =>
    request("/api/admin/vehicles/import", {
      method: "POST",
      headers: { "X-Admin-Token": token },
      body: { items },
    }),

  adminExportVehicles: (token) =>
    request("/api/admin/vehicles/export", { headers: { "X-Admin-Token": token } }),

  adminVehicleOwnerToken: (token, id) =>
    request(`/api/admin/vehicles/${encodeURIComponent(id)}/owner-token`, {
      headers: { "X-Admin-Token": token },
    }),

  // 管理员修改自己的登录密码
  adminChangePassword: (token, currentPassword, newPassword) =>
    request("/api/admin/password", {
      method: "POST",
      headers: { "X-Admin-Token": token },
      body: { currentPassword, newPassword },
    }),
};

// 生成访客页链接（基于当前前端所在域名，与后端地址解耦）
export function buildMoveUrl(vehicleToken) {
  const url = new URL("./move.html", location.href);
  url.searchParams.set("token", vehicleToken);
  return url.toString();
}

export function qrImageUrl(text) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(text)}`;
}

// ownerToken 本地存储（用于后台自动登录）
const OWNER_KEY = "move_car_owner_tokens";

export function saveOwnerToken(ownerToken, maskedPlate) {
  try {
    const map = JSON.parse(localStorage.getItem(OWNER_KEY) || "{}");
    map[ownerToken] = { maskedPlate, savedAt: Date.now() };
    localStorage.setItem(OWNER_KEY, JSON.stringify(map));
  } catch {}
}

export function loadOwnerTokens() {
  try {
    return JSON.parse(localStorage.getItem(OWNER_KEY) || "{}");
  } catch {
    return {};
  }
}

export function clearOwnerToken(ownerToken) {
  try {
    const map = JSON.parse(localStorage.getItem(OWNER_KEY) || "{}");
    delete map[ownerToken];
    localStorage.setItem(OWNER_KEY, JSON.stringify(map));
  } catch {}
}
