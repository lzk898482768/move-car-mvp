// 扫码挪车 · 前端主逻辑（Worker 版）
import {
  api, getApiBase, hasApiBase, setApiBase,
  buildMoveUrl, qrImageUrl,
  saveOwnerToken, loadOwnerTokens, clearOwnerToken,
  saveAdminToken, loadAdminToken, clearAdminToken,
} from "./api.js";

/* ---------------- 通用工具 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizePlate(value) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}
function validatePlate(value) {
  const plate = normalizePlate(value);
  if (!/^[一-龥A-Z0-9]{5,10}$/.test(plate)) throw new Error("请输入有效车牌号（如 粤A12345）。");
  return plate;
}
function normalizePhone(value) {
  return String(value || "").trim().replace(/[\s-]/g, "");
}
function isPhone(value) {
  return /^\+?\d[\d\s-]{6,19}$/.test(String(value || "").trim());
}
function maskPhone(value) {
  const p = String(value || "");
  if (p.length <= 5) return "****";
  return `${p.slice(0, 3)}****${p.slice(-2)}`;
}

let toastTimer;
function toast(msg, type = "") {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 2600);
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = document.createElement("textarea");
  input.value = text;
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
  return Promise.resolve();
}

function showResult(el, html, error = false) {
  if (!el) return;
  el.classList.remove("hidden", "error");
  if (error) el.classList.add("error");
  el.innerHTML = html;
}

function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString("zh-CN");
}

function downloadFile(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// 简单模态
function openModal({ title, body, confirmText, danger, onConfirm }) {
  let mask = $("#modalMask");
  if (!mask) {
    mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.id = "modalMask";
    mask.innerHTML = `<div class="modal">
      <h3 id="modalTitle"></h3>
      <div id="modalBody" class="modal-body"></div>
      <div class="actions row" style="margin-top:0">
        <button class="btn btn-ghost" id="modalCancel">取消</button>
        <button class="btn" id="modalOk"></button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    mask.addEventListener("click", (e) => { if (e.target === mask) closeModal(); });
    $("#modalCancel", mask).addEventListener("click", closeModal);
  }
  $("#modalTitle", mask).textContent = title;
  $("#modalBody", mask).innerHTML = body;
  const ok = $("#modalOk", mask);
  ok.textContent = confirmText || "确定";
  ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  ok.onclick = () => { closeModal(); onConfirm && onConfirm(); };
  mask.classList.add("show");
}
function closeModal() { $("#modalMask")?.classList.remove("show"); }

/* ---------------- 配置提示条 ---------------- */
function ensureConfigBanner() {
  if (hasApiBase()) return;
  const topbar = $(".topbar");
  if (!topbar || $("#configBanner")) return;
  const banner = document.createElement("div");
  banner.id = "configBanner";
  banner.className = "config-banner";
  banner.innerHTML = `
    <span>⚙️ 未配置后端地址（Worker API）。</span>
    <input id="apiBaseInput" placeholder="https://your-worker.workers.dev" />
    <button class="btn btn-sm btn-primary" id="saveApiBase">保存</button>`;
  topbar.insertAdjacentElement("afterend", banner);
  $("#saveApiBase", banner).addEventListener("click", () => {
    const v = $("#apiBaseInput", banner).value.trim();
    if (!v) return toast("请填写后端地址", "err");
    setApiBase(v);
    banner.remove();
    toast("已保存，正在加载…", "ok");
    location.reload();
  });
}

/* ---------------- 渠道文案 ---------------- */
const CHANNEL_LABELS = {
  wechat_work: "企业微信",
  showdoc: "ShowDoc",
  sms: "短信",
  privacy_call: "隐私号呼叫",
};
function channelPill(ch, ok) {
  const label = CHANNEL_LABELS[ch] || ch;
  return `<span class="pill ${ok ? "ok" : "off"}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

/* ============================================================
   车主 · 创建挪车码（bind）
   ============================================================ */
function setupBindPage() {
  const form = $("#bindForm");
  const result = $("#bindResult");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const plate = form.plateNumber.value;
    const wechatWorkWebhook = form.wechatWorkWebhook.value.trim();
    const showdocWebhook = form.showdocWebhook.value.trim();
    const showdocToken = form.showdocToken.value.trim();
    const ownerPhone = normalizePhone(form.ownerPhone.value);
    const smsEnabled = form.smsEnabled.checked;
    const privacyCallEnabled = form.privacyCallEnabled.checked;
    const ownerPin = form.ownerPin ? form.ownerPin.value.trim() : "";

    showResult(result, "正在创建…");
    try {
      validatePlate(plate);
      if (ownerPin && !/^\d{4,12}$/.test(ownerPin)) throw new Error("管理密码请使用 4-12 位数字。");
      const channels = [];
      if (wechatWorkWebhook) channels.push("企业微信");
      if (showdocWebhook) channels.push("ShowDoc");
      if (smsEnabled) {
        if (!isPhone(ownerPhone)) throw new Error("开启短信需填写有效手机号。");
        channels.push("短信");
      }
      if (privacyCallEnabled) {
        if (!isPhone(ownerPhone)) throw new Error("开启隐私号需填写有效手机号。");
        channels.push("隐私号");
      }
      if (!channels.length) throw new Error("请至少配置一种通知方式（企业微信 / ShowDoc / 短信 / 隐私号）。");

      const data = await api.createVehicle({
        plateNumber: plate,
        wechatWorkWebhook,
        showdocWebhook,
        showdocToken,
        ownerPhone,
        smsEnabled,
        privacyCallEnabled,
        ownerPin,
      });
      saveOwnerToken(data.ownerToken, data.maskedPlate);

      const moveUrl = buildMoveUrl(data.vehicleToken);
      const ownerUrl = `${new URL("./owner.html", location.href).toString()}?token=${encodeURIComponent(data.ownerToken)}`;
      showResult(
        result,
        `<div class="fade-in qr-wrap">
          <div class="pill ok"><span class="dot"></span>挪车码已生成</div>
          <div class="hero-plate"><div class="plate">${escapeHtml(data.maskedPlate)}</div></div>
          <div class="qr"><img src="${qrImageUrl(moveUrl)}" alt="挪车二维码" /></div>
          <div class="muted">访客扫码即可匿名通知你挪车</div>
          <div class="field-hint">访客链接</div>
          <div class="command" style="word-break:break-all">${escapeHtml(moveUrl)}</div>
          ${ownerPin
            ? `<div class="notice" style="margin-top:10px">🔑 已设置管理密码。以后在任何设备打开「管理后台」，用「车牌 + 管理密码」即可找回入口。</div>`
            : `<div class="notice" style="margin-top:10px">⚠️ 未设置管理密码 —— 换设备或清缓存后将无法找回管理入口，建议现在就设置。</div>`}
          <div class="actions">
            <button class="btn" id="copyMove">复制访客链接</button>
            <button class="btn btn-primary" id="goOwner">进入管理后台 →</button>
          </div>
        </div>`
      );
      $("#copyMove", result).onclick = async () => { await copyText(moveUrl); toast("链接已复制", "ok"); };
      $("#goOwner", result).onclick = () => (location.href = ownerUrl);
      result.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      showResult(result, escapeHtml(err.message || "创建失败"), true);
    }
  });
}

/* ============================================================
   访客 · 扫码通知（move）
   ============================================================ */
function setupMovePage() {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const vehicleEl = $("#publicVehicle");
  const resultEl = $("#contactResult");
  const channelsEl = $("#channelPicker");
  const notifyBtn = $("#notifyButton");

  if (!token) {
    showResult(vehicleEl, "二维码内容缺失，请重新生成挪车二维码。", true);
    if (notifyBtn) notifyBtn.disabled = true;
    return;
  }

  let selectedChannel = ""; // 空 = 后端默认

  async function load() {
    try {
      const v = await api.getPublicVehicle(token);
      const chs = v.availableChannels || [];
      showResult(
        vehicleEl,
        `<div class="plate-big">${escapeHtml(v.maskedPlate)}</div>
         <p class="privacy-note">为保护双方隐私，本次通知将采用 <b>${chs.length ? "匿名方式" : "平台通道"}</b> 送达车主，不会暴露你的号码。</p>`
      );
      if (chs.length === 0) {
        showResult(resultEl, "该车主暂未配置任何通知方式，请联系车主本人。", true);
        if (notifyBtn) notifyBtn.disabled = true;
        return;
      }
      if (channelsEl) {
        channelsEl.innerHTML = `<div class="channels">` +
          chs.map((c, i) =>
            `<span class="pill ${i === 0 ? "ok" : ""}" data-ch="${escapeHtml(c)}" style="cursor:pointer">${escapeHtml(CHANNEL_LABELS[c] || c)}</span>`
          ).join("") + `</div>`;
        $$(".pill", channelsEl).forEach((p) =>
          p.addEventListener("click", () => {
            $$(".pill", channelsEl).forEach((x) => x.classList.remove("ok"));
            p.classList.add("ok");
            selectedChannel = p.dataset.ch;
          })
        );
      }
      if (notifyBtn) notifyBtn.disabled = false;
    } catch (err) {
      showResult(vehicleEl, escapeHtml(err.message || "加载失败"), true);
      if (notifyBtn) notifyBtn.disabled = true;
    }
  }

  if (notifyBtn) {
    notifyBtn.addEventListener("click", async () => {
      notifyBtn.disabled = true;
      notifyBtn.classList.add("loading");
      showResult(resultEl, "正在通知车主…");
      try {
        const r = await api.notify(token, selectedChannel);
        showResult(
          resultEl,
          `<div class="notice" style="border-color:rgba(16,185,129,.4);background:rgba(16,185,129,.1);color:#047857">
             ✅ ${escapeHtml(r.message || "已通知车主，请耐心等待。")}
           </div>`
        );
        toast("已通知车主", "ok");
      } catch (err) {
        const isRate = err.code === "rate_limited";
        showResult(
          resultEl,
          `<div class="notice ${isRate ? "" : "error"}">${isRate ? "⏳ " : "⚠️ "}${escapeHtml(err.message || "通知失败")}</div>`,
          !isRate
        );
      } finally {
        if (notifyBtn) { notifyBtn.disabled = false; notifyBtn.classList.remove("loading"); }
      }
    });
  }

  load();
}

/* ============================================================
   车主 · 自适应管理后台（owner）
   ============================================================ */
async function resolveOwnerToken() {
  const params = new URLSearchParams(location.search);
  if (params.get("token")) return params.get("token");
  const map = loadOwnerTokens();
  const keys = Object.keys(map);
  if (keys.length === 1) return keys[0];
  return null; // 多个或无 → 交给页面处理
}

function renderTokenPicker() {
  const mount = $("#ownerMount");
  const map = loadOwnerTokens();
  const keys = Object.keys(map);
  showResult(
    mount,
    `<div class="card">
      <h2>选择要管理的车辆</h2>
      ${keys.length
        ? `<div class="log-list">` +
          keys
            .map(
              (k) =>
                `<button class="log-item" data-token="${escapeHtml(k)}" style="width:100%;text-align:left;cursor:pointer">
                   <span class="ch">${escapeHtml(map[k].maskedPlate || "车辆")}</span>
                   <span class="t">进入管理 →</span>
                 </button>`
            )
            .join("") +
          `</div>`
        : `<p class="muted">本机暂无已保存的管理入口。</p>`}
      <div class="actions">
        <button class="btn btn-ghost" id="pasteToken">粘贴管理链接 / Token</button>
      </div>
    </div>

    <div class="card">
      <h2>🔑 找回管理入口</h2>
      <p class="muted">换手机、换浏览器或清了缓存？用「车牌号 + 创建时设置的管理密码」即可重新进入。</p>
      <form id="recoverForm" class="grid-form" style="margin-top:12px">
        <label class="span-2">车牌号
          <input id="rcPlate" placeholder="例如 粤A12345" autocomplete="off" required />
        </label>
        <label class="span-2">管理密码
          <input id="rcPin" type="password" inputmode="numeric" placeholder="4-12 位数字" autocomplete="current-password" required />
        </label>
        <button type="submit" class="btn btn-primary span-2">找回并进入管理后台</button>
      </form>
      <div id="recoverResult" class="result hidden" style="margin-top:12px"></div>
    </div>`
  );
  $$(".log-item", mount).forEach((b) =>
    b.addEventListener("click", () => {
      const url = new URL(location.href);
      url.searchParams.set("token", b.dataset.token);
      location.href = url.toString();
    })
  );
  $("#pasteToken", mount)?.addEventListener("click", () => {
    openModal({
      title: "输入管理 Token",
      body: `<input id="tokenInput" placeholder="own_xxx" style="margin-top:8px" />`,
      confirmText: "进入",
      onConfirm: () => {
        const v = $("#tokenInput")?.value.trim();
        if (!v) return;
        const token = v.includes("token=") ? new URL(v).searchParams.get("token") : v;
        const url = new URL(location.href);
        url.searchParams.set("token", token);
        location.href = url.toString();
      },
    });
  });

  const rcForm = $("#recoverForm", mount);
  rcForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rcResult = $("#recoverResult", mount);
    const plate = $("#rcPlate", mount).value;
    const pin = $("#rcPin", mount).value.trim();
    showResult(rcResult, "正在验证…");
    try {
      const r = await api.recoverOwner(plate, pin);
      saveOwnerToken(r.ownerToken, r.maskedPlate);
      showResult(rcResult, `✅ 已找到 ${escapeHtml(r.maskedPlate)}，正在进入管理后台…`);
      setTimeout(() => {
        const url = new URL(location.href);
        url.searchParams.set("token", r.ownerToken);
        location.href = url.toString();
      }, 700);
    } catch (err) {
      showResult(rcResult, escapeHtml(err.message || "找回失败"), true);
    }
  });
}

function setupOwnerPage() {
  const mount = $("#ownerMount");
  if (!mount) return;

  resolveOwnerToken().then(async (token) => {
    if (!token) { renderTokenPicker(); return; }
    await renderDashboard(token);
  });
}

async function renderDashboard(ownerToken) {
  const mount = $("#ownerMount");
  showResult(mount, "正在加载管理后台…");

  let vehicle;
  try {
    vehicle = await api.getOwnerVehicle(ownerToken);
  } catch (err) {
    showResult(
      mount,
      `<div class="card error">${escapeHtml(err.message || "加载失败")}
        <div class="actions"><button class="btn btn-ghost" id="backPick">返回选择</button></div></div>`
    );
    $("#backPick", mount)?.addEventListener("click", () => { clearOwnerToken(ownerToken); location.href = new URL("./owner.html", location.href).toString(); });
    return;
  }

  const moveUrl = buildMoveUrl(vehicle.vehicleToken);
  const enabled = {
    wechat_work: Boolean(vehicle.wechatWorkEnabled),
    showdoc: Boolean(vehicle.showdocEnabled),
    sms: Boolean(vehicle.smsEnabled),
    privacy_call: Boolean(vehicle.privacyCallEnabled),
  };
  const activeChannels = Object.keys(enabled).filter((k) => enabled[k]);

  mount.innerHTML = `
  <div class="dash-grid fade-in">
    <!-- 车辆信息 + 二维码 -->
    <section class="card span-2">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h2 style="margin:0">车辆信息</h2>
        <span class="pill ok"><span class="dot"></span>${escapeHtml(vehicle.maskedPlate)}</span>
      </div>
      <div class="qr-wrap" style="margin-top:12px">
        <div class="qr"><img id="qrImg" src="${qrImageUrl(moveUrl)}" alt="挪车二维码" /></div>
        <div class="muted">访客扫码链接</div>
        <div class="command" style="word-break:break-all">${escapeHtml(moveUrl)}</div>
        <div class="actions row">
          <button class="btn btn-sm" id="copyMove">复制链接</button>
          <button class="btn btn-sm btn-ghost" id="regen">重新生成二维码</button>
          <button class="btn btn-sm btn-ghost" id="printCard">打印挪车卡</button>
        </div>
      </div>
    </section>

    <!-- 通知渠道配置 -->
    <section class="card">
      <h2>通知渠道</h2>
      <div class="channels" style="margin-bottom:14px">
        ${["wechat_work", "showdoc", "sms", "privacy_call"].map((c) => channelPill(c, enabled[c])).join("")}
      </div>
      <div class="grid-form">
        <label class="span-2">企业微信 Webhook
          <input id="f_wechat" placeholder="https://qyapi.weixin.qq.com/..." value="${escapeHtml(vehicle.wechatWorkWebhook || "")}">
          <span class="field-hint">${vehicle.wechatWorkEnabled ? "已配置（清空并保存可停用）" : "留空则使用平台默认通道（若管理员已配置）"}</span>
        </label>
        <label class="span-2">ShowDoc Webhook
          <input id="f_showdoc" placeholder="https://..." value="${escapeHtml(vehicle.showdocWebhook || "")}">
        </label>
        <label class="span-2">ShowDoc Token
          <input id="f_showdocToken" placeholder="${vehicle.hasShowdocToken ? "已设置（留空则保持不变）" : "可选"}" value="">
        </label>
        <label class="span-2">车主手机号（短信/隐私号需要）
          <input id="f_phone" inputmode="tel" placeholder="${vehicle.ownerPhoneMasked ? `当前：${escapeHtml(vehicle.ownerPhoneMasked)}（留空则不变）` : "用于短信与隐私号呼叫"}" value="">
        </label>
        <div class="switch-row span-2">
          <div class="meta"><b>短信通知</b><span>腾讯云短信下发到车主</span></div>
          <label class="switch"><input type="checkbox" id="f_sms" ${vehicle.smsEnabled ? "checked" : ""}><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="switch-row span-2">
          <div class="meta"><b>隐私号呼叫</b><span>通过隐私号服务呼叫，隐藏真实号码</span></div>
          <label class="switch"><input type="checkbox" id="f_privacy" ${vehicle.privacyCallEnabled ? "checked" : ""}><span class="track"></span><span class="thumb"></span></label>
        </div>
        <button class="btn btn-primary span-2" id="saveChannels">保存渠道配置</button>
      </div>
      <p class="form-note">仅提交你实际改动过的字段；留空的密钥类字段会保持原值不变。</p>
    </section>

    <!-- 管理密码 -->
    <section class="card">
      <h2>🔑 管理密码</h2>
      <p class="muted">${vehicle.hasPin
        ? "已设置管理密码。换设备时用「车牌 + 管理密码」即可找回管理入口。"
        : "尚未设置管理密码 —— 换设备或清缓存后将无法找回入口，建议现在设置。"}</p>
      <div class="grid-form" style="margin-top:12px">
        <label class="span-2">${vehicle.hasPin ? "修改管理密码" : "设置管理密码"}
          <input id="f_pin" type="password" inputmode="numeric" placeholder="4-12 位数字" autocomplete="new-password">
        </label>
        <button class="btn ${vehicle.hasPin ? "btn-ghost" : "btn-primary"} span-2" id="savePin">${vehicle.hasPin ? "更新管理密码" : "设置管理密码"}</button>
      </div>
    </section>

    <!-- 最近通知 -->
    <section class="card">
      <h2>最近通知</h2>
      <div id="logBox">
        ${(vehicle.recentNotifications && vehicle.recentNotifications.length)
          ? `<div class="log-list">` +
            vehicle.recentNotifications
              .map(
                (n) => `<div class="log-item">
                  <span class="ch">${escapeHtml(CHANNEL_LABELS[n.channel] || n.channel)}</span>
                  <span class="pill ${n.status === "sent" ? "ok" : "err"}"><span class="dot"></span>${n.status === "sent" ? "成功" : "失败"}</span>
                  <span class="t">${escapeHtml(new Date(n.created_at).toLocaleString("zh-CN"))}</span>
                </div>`
              )
              .join("") +
            `</div>`
          : `<p class="muted">暂无通知记录。</p>`}
      </div>
    </section>

    <!-- 危险操作 -->
    <section class="card span-2">
      <h2>危险操作</h2>
      <p class="muted">删除后该挪车码立即失效，且无法恢复。</p>
      <div class="actions row">
        <button class="btn btn-danger" id="deleteVehicle">删除绑定</button>
      </div>
    </section>
  </div>`;

  // 绑定交互
  $("#copyMove", mount).onclick = async () => { await copyText(moveUrl); toast("链接已复制", "ok"); };
  $("#printCard", mount).onclick = () => window.print();

  $("#regen", mount).onclick = async () => {
    try {
      const r = await api.regenerateToken(ownerToken);
      toast("二维码已重新生成", "ok");
      const newUrl = buildMoveUrl(r.vehicleToken);
      $("#qrImg", mount).src = qrImageUrl(newUrl);
      const cmd = $(".command", mount);
      if (cmd) cmd.textContent = newUrl;
    } catch (err) { toast(err.message || "生成失败", "err"); }
  };

  $("#saveChannels", mount).onclick = async () => {
    const wechat = $("#f_wechat", mount).value.trim();
    const showdoc = $("#f_showdoc", mount).value.trim();
    const showdocToken = $("#f_showdocToken", mount).value.trim();
    const phone = normalizePhone($("#f_phone", mount).value);
    const sms = $("#f_sms", mount).checked;
    const privacy = $("#f_privacy", mount).checked;

    // 只提交「实际改动过」的字段：文本清空=停用，留空=保持原值；开关始终提交明确状态
    const patch = {};
    if (wechat !== (vehicle.wechatWorkWebhook || "")) patch.wechatWorkWebhook = wechat;
    if (showdoc !== (vehicle.showdocWebhook || "")) patch.showdocWebhook = showdoc;
    if (showdocToken) patch.showdocToken = showdocToken;
    if (phone) patch.ownerPhone = phone;
    if (sms !== Boolean(vehicle.smsEnabled)) patch.smsEnabled = sms;
    if (privacy !== Boolean(vehicle.privacyCallEnabled)) patch.privacyCallEnabled = privacy;

    if (!Object.keys(patch).length) return toast("没有需要保存的改动", "");

    const willSms = "smsEnabled" in patch ? patch.smsEnabled : Boolean(vehicle.smsEnabled);
    const willPrivacy = "privacyCallEnabled" in patch ? patch.privacyCallEnabled : Boolean(vehicle.privacyCallEnabled);
    if ((willSms || willPrivacy) && !phone && !vehicle.hasPhone) {
      return toast("开启短信 / 隐私号需填写手机号", "err");
    }
    try {
      await api.patchOwnerVehicle(ownerToken, patch);
      toast("配置已更新", "ok");
      setTimeout(() => renderDashboard(ownerToken), 600);
    } catch (err) { toast(err.message || "保存失败", "err"); }
  };

  $("#savePin", mount).onclick = async () => {
    const pin = $("#f_pin", mount).value.trim();
    if (!/^\d{4,12}$/.test(pin)) return toast("管理密码请使用 4-12 位数字", "err");
    try {
      await api.patchOwnerVehicle(ownerToken, { ownerPin: pin });
      toast("管理密码已更新", "ok");
      setTimeout(() => renderDashboard(ownerToken), 600);
    } catch (err) { toast(err.message || "设置失败", "err"); }
  };

  $("#deleteVehicle", mount).onclick = () => {
    openModal({
      title: "确认删除绑定？",
      body: "删除后该挪车码立即失效，访客将无法再通知你，且无法恢复。",
      confirmText: "确认删除",
      danger: true,
      onConfirm: async () => {
        try {
          await api.deleteVehicle(ownerToken);
          clearOwnerToken(ownerToken);
          toast("绑定已删除", "ok");
          location.href = new URL("./owner.html", location.href).toString();
        } catch (err) { toast(err.message || "删除失败", "err"); }
      },
    });
  };
}

/* ============================================================
   超级管理员后台（admin）
   ============================================================ */
const ADMIN_GROUPS = [
  { title: "腾讯云 · 短信与 OCR", keys: ["tencent_secret_id", "tencent_secret_key", "tencent_sms_app_id", "tencent_sms_sign_name", "tencent_sms_template_id", "tencent_sms_region", "tencent_ocr_region"] },
  { title: "企业微信 · 默认通道", keys: ["wechat_work_webhook"] },
  { title: "隐私号呼叫", keys: ["privacy_call_webhook_url", "privacy_call_webhook_token"] },
  { title: "ShowDoc · 默认通道", keys: ["showdoc_webhook", "showdoc_token"] },
  { title: "其他", keys: ["default_phone_country_code", "ocr_demo_plate", "ocr_demo_mode"] },
  { title: "平台通道开关", keys: ["sms_enabled_global", "wechat_enabled_global", "privacy_enabled_global", "showdoc_enabled_global"] },
];
const BOOL_KEYS = new Set(["ocr_demo_mode", "sms_enabled_global", "wechat_enabled_global", "privacy_enabled_global", "showdoc_enabled_global"]);
const MASKED = "••••••";
// 广告位兜底列表（正常由后端 /api/admin/ads 返回，接口异常时仍可用）
const AD_POSITION_FALLBACK = [
  { key: "home_top", label: "首页 · 顶部横幅" },
  { key: "move_top", label: "访客页 · 车牌卡下方" },
  { key: "move_bottom", label: "访客页 · 底部推荐位" },
  { key: "owner_top", label: "车主后台 · 顶部" },
];

function setupAdminPage() {
  const mount = $("#adminMount");
  if (!mount) return;
  const token = loadAdminToken();
  if (token) renderAdminConsole(token);
  else renderAdminLogin();
}

function renderAdminLogin() {
  const mount = $("#adminMount");
  showResult(
    mount,
    `<div class="card">
      <h2>管理员登录</h2>
      <p class="muted">仅超级管理员可进入。首次登录使用部署时配置的引导账号。</p>
      <form id="adminLoginForm" class="grid-form" style="margin-top:12px">
        <label class="span-2">账号
          <input id="adUser" placeholder="管理员账号" autocomplete="username" required />
        </label>
        <label class="span-2">密码
          <input id="adPass" type="password" placeholder="密码" autocomplete="current-password" required />
        </label>
        <button type="submit" class="btn btn-primary span-2">登录</button>
      </form>
      <div id="adminLoginResult" class="result hidden" style="margin-top:12px"></div>
    </div>`
  );
  $("#adminLoginForm", mount).addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = $("#adminLoginResult", mount);
    showResult(result, "正在登录…");
    try {
      const r = await api.adminLogin($("#adUser", mount).value.trim(), $("#adPass", mount).value);
      saveAdminToken(r.token);
      toast("登录成功", "ok");
      renderAdminConsole(r.token);
    } catch (err) {
      showResult(result, escapeHtml(err.message || "登录失败"), true);
    }
  });
}

async function renderAdminConsole(token) {
  const mount = $("#adminMount");
  showResult(mount, "正在加载管理控制台…");
  let settings = [];
  let adPositions = [];
  let ads = [];
  try {
    const [r, adsRes] = await Promise.all([
      api.adminGetConfig(token),
      api.adminListAds(token).catch(() => ({ positions: [], ads: [] })),
    ]);
    settings = r.settings || [];
    adPositions = adsRes.positions || [];
    ads = adsRes.ads || [];
  } catch (err) {
    if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
    showResult(mount, `<div class="card error">${escapeHtml(err.message || "加载失败")}</div>`);
    return;
  }
  if (!adPositions.length) adPositions = AD_POSITION_FALLBACK;
  const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));

  mount.innerHTML = `
  <div class="dash-grid fade-in">
    <section class="card span-2" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div><h2 style="margin:0">🛡️ 超级管理员控制台</h2><p class="muted" style="margin:4px 0 0">车牌管理 · 全局通知渠道 · 广告位 · 车牌查手机号 · 账号管理</p></div>
      <div class="actions row" style="margin:0;gap:8px">
        <button class="btn btn-sm btn-ghost" id="adChangePwd">修改我的密码</button>
        <button class="btn btn-sm btn-ghost" id="adLogout">退出登录</button>
      </div>
    </section>

    <!-- 车牌管理 -->
    <section class="card span-2">
      <h2>🚗 车牌管理</h2>
      <p class="muted">集中管理所有挪车码绑定：新增 / 编辑 / 删除 / 批量导入导出，也可重置车主查看密码或直接进入其车主后台。</p>

      <div class="row-actions" style="margin-top:12px">
        <input id="vhSearch" placeholder="搜索车牌 / 手机号 / ID" style="flex:1;min-width:150px" />
        <button class="btn btn-sm" id="vhSearchBtn">查询</button>
        <button class="btn btn-sm btn-ghost" id="vhResetBtn">重置</button>
      </div>
      <div class="row-actions" style="margin-top:8px">
        <button class="btn btn-sm btn-primary" id="vhAdd">＋ 新增车牌</button>
        <button class="btn btn-sm btn-ghost" id="vhImportBtn">导入 CSV / JSON</button>
        <button class="btn btn-sm btn-ghost" id="vhExportBtn">导出 CSV</button>
        <input type="file" id="vhImportFile" accept=".csv,.json,text/csv,application/json" class="hidden" />
      </div>

      <div id="vhListBox" style="margin-top:12px"><p class="muted">正在加载…</p></div>
      <div id="vhResult" class="result hidden" style="margin-top:10px"></div>
      <details style="margin-top:12px">
        <summary class="muted" style="cursor:pointer">导入格式说明</summary>
        <p class="field-hint" style="margin-top:8px">支持 CSV 与 JSON。CSV 表头顺序：<b>车牌号,查看密码,手机号,短信通知,隐私号呼叫,企业微信Webhook,ShowDocWebhook</b>（表头行可省略；开关填「是/否」）。重复车牌会自动跳过，不会覆盖已有绑定。</p>
      </details>
    </section>

    <!-- 全局通知渠道 -->
    <section class="card span-2">
      <h2>全局通知渠道配置</h2>
      <p class="muted">此处配置的通道作为所有车主的默认通道；车主也可在自己的后台单独覆盖。密钥类字段显示为 ${MASKED}，保持不变即可，填写新值才会覆盖。</p>
      <form id="adminConfigForm">
        ${ADMIN_GROUPS.map((grp) => `
          <h3 class="group-title">${escapeHtml(grp.title)}</h3>
          <div class="grid-form">
            ${grp.keys.map((key) => {
              const s = byKey[key] || { key, label: key, value: "" };
              if (BOOL_KEYS.has(key)) {
                const on = s.value === "true";
                return `<div class="switch-row span-2">
                  <div class="meta"><b>${escapeHtml(s.label)}</b><span>${on ? "已启用" : "已关闭"}</span></div>
                  <label class="switch"><input type="checkbox" data-cfg="${escapeHtml(key)}" data-bool="1" ${on ? "checked" : ""}><span class="track"></span><span class="thumb"></span></label>
                </div>`;
              }
              return `<label class="span-2">${escapeHtml(s.label)}
                <input data-cfg="${escapeHtml(key)}" value="${escapeHtml(s.value || "")}" ${s.secret ? "autocomplete=\"off\"" : ""} />
                ${s.secret ? `<span class="field-hint">敏感字段，${MASKED} 表示已设置</span>` : ""}
              </label>`;
            }).join("")}
          </div>`).join("")}
        <div class="actions row">
          <button type="submit" class="btn btn-primary">保存全局配置</button>
        </div>
        <div id="adminCfgResult" class="result hidden" style="margin-top:10px"></div>
      </form>
    </section>

    <!-- 车牌查手机号 -->
    <section class="card">
      <h2>🔍 按车牌查车主电话</h2>
      <p class="muted">通知无法送达时，用于人工联系车主。查询行为仅限管理员账号。</p>
      <form id="adminLookupForm" class="grid-form" style="margin-top:12px">
        <label class="span-2">车牌号
          <input id="lkPlate" placeholder="例如 粤A12345" autocomplete="off" required />
        </label>
        <button type="submit" class="btn btn-primary span-2">查询</button>
      </form>
      <div id="adminLookupResult" class="result hidden" style="margin-top:12px"></div>
    </section>

    <!-- 广告位管理 -->
    <section class="card span-2">
      <h2>🖼️ 广告位管理</h2>
      <p class="muted">只需填写广告<strong>图片链接</strong>，无需上传图片。某个位置没有投放中的广告时，前端会自动隐藏该广告位，不会出现空白块。</p>
      <div id="adListBox" style="margin-top:12px"><p class="muted">正在加载…</p></div>
      <h3 class="group-title">新增广告</h3>
      <form id="adForm" class="grid-form">
        <label class="span-2">投放位置
          <select id="adPos">${adPositions.map((p) => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)}</option>`).join("")}</select>
        </label>
        <label class="span-2">广告图片链接（必填）
          <input id="adImg" placeholder="https://example.com/banner.jpg" autocomplete="off" required />
        </label>
        <label class="span-2">点击跳转链接（可选）
          <input id="adLink" placeholder="https://example.com" autocomplete="off" />
        </label>
        <label class="span-2">备注名（可选）
          <input id="adTitle" placeholder="便于后台辨认，如「双十一活动」" autocomplete="off" />
        </label>
        <label class="span-2">排序（数字越小越靠前）
          <input id="adSort" type="number" value="0" />
        </label>
        <button type="submit" class="btn btn-primary span-2">添加广告</button>
      </form>
      <div id="adResult" class="result hidden" style="margin-top:10px"></div>
    </section>

    <!-- 管理员账号 -->
    <section class="card">
      <h2>管理员账号</h2>
      <div id="adminAccountList"><p class="muted">正在加载…</p></div>
      <form id="adminAccountForm" class="grid-form" style="margin-top:14px">
        <label class="span-2">新账号
          <input id="acUser" placeholder="3-32 位字母数字下划线" autocomplete="off" required />
        </label>
        <label class="span-2">密码
          <input id="acPass" type="password" placeholder="至少 8 位" autocomplete="new-password" required />
        </label>
        <label class="span-2">角色
          <select id="acRole"><option value="admin">admin（配置 + 查询）</option><option value="super">super（含账号管理）</option></select>
        </label>
        <button type="submit" class="btn btn-ghost span-2">新增管理员</button>
      </form>
      <div id="adminAcctResult" class="result hidden" style="margin-top:10px"></div>
    </section>
  </div>`;

  $("#adLogout", mount).onclick = async () => {
    try { await api.adminLogout(token); } catch {}
    clearAdminToken();
    toast("已退出登录", "ok");
    renderAdminLogin();
  };

  // 广告位管理
  renderAdminAdsList(token, adPositions, ads);
  $("#adForm", mount).addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = $("#adResult", mount);
    showResult(result, "正在添加…");
    try {
      await api.adminCreateAd(token, {
        position: $("#adPos", mount).value,
        imageUrl: $("#adImg", mount).value.trim(),
        linkUrl: $("#adLink", mount).value.trim(),
        title: $("#adTitle", mount).value.trim(),
        sortOrder: Number($("#adSort", mount).value) || 0,
      });
      $("#adImg", mount).value = "";
      $("#adLink", mount).value = "";
      $("#adTitle", mount).value = "";
      $("#adSort", mount).value = "0";
      showResult(result, "✅ 广告已添加，前端刷新即可看到。");
      toast("广告已添加", "ok");
      await reloadAdminAds(token);
    } catch (err) {
      if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
      showResult(result, escapeHtml(err.message || "添加失败"), true);
    }
  });

  // 修改管理员自己的密码
  $("#adChangePwd", mount).onclick = () => openAdminPasswordModal(token);

  // 车牌管理
  reloadAdminVehicles(token, "");
  const doSearch = () => reloadAdminVehicles(token, $("#vhSearch", mount).value.trim());
  $("#vhSearchBtn", mount).onclick = doSearch;
  $("#vhSearch", mount).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSearch(); } });
  $("#vhResetBtn", mount).onclick = () => { $("#vhSearch", mount).value = ""; reloadAdminVehicles(token, ""); };
  $("#vhAdd", mount).onclick = () => openVehicleEditor(token, null);
  $("#vhImportBtn", mount).onclick = () => $("#vhImportFile", mount).click();
  $("#vhImportFile", mount).addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const result = $("#vhResult", mount);
    showResult(result, `正在导入 ${escapeHtml(file.name)}…`);
    try {
      const text = await file.text();
      const items = parseVehicleImport(text);
      if (!items.length) { showResult(result, "没有解析到有效数据，请检查文件格式。", true); return; }
      const r = await api.adminImportVehicles(token, items);
      const failLines = (r.failed || []).slice(0, 10).map((f) => `<div class="t">${escapeHtml(f.plateNumber || "?")}：${escapeHtml(f.reason)}</div>`).join("");
      showResult(result,
        `<div class="notice">
           ✅ ${escapeHtml(r.message || "导入完成")}
           ${(r.skipped || []).length ? `<div class="t" style="margin-top:6px">重复跳过：${escapeHtml(r.skipped.slice(0, 20).join("、"))}${r.skipped.length > 20 ? " …" : ""}</div>` : ""}
           ${(r.failed || []).length ? `<div class="t" style="margin-top:6px">失败明细：</div>${failLines}` : ""}
         </div>`);
      toast("导入完成", "ok");
      await reloadAdminVehicles(token, $("#vhSearch", mount).value.trim());
    } catch (err) {
      if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
      showResult(result, escapeHtml(err.message || "导入失败"), true);
    }
  });
  $("#vhExportBtn", mount).onclick = async () => {
    const result = $("#vhResult", mount);
    showResult(result, "正在导出…");
    try {
      const r = await api.adminExportVehicles(token);
      const list = r.vehicles || [];
      const rows = [["车牌号", "查看密码", "手机号", "短信通知", "隐私号呼叫", "企业微信Webhook", "ShowDocWebhook", "绑定ID", "创建时间"]];
      list.forEach((v) => rows.push([
        v.plateNumber, "", v.ownerPhone,
        v.smsEnabled ? "是" : "否", v.privacyCallEnabled ? "是" : "否",
        v.wechatWorkWebhook, v.showdocWebhook, v.id, fmtDate(v.createdAt),
      ]));
      const csv = rows
        .map((cells) => cells.map((c) => {
          const s = String(c ?? "");
          return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
        }).join(","))
        .join("\r\n");
      downloadFile(`move-car-vehicles-${new Date().toISOString().slice(0, 10)}.csv`, "\ufeff" + csv);
      showResult(result, `✅ 已导出 ${list.length} 条车牌记录（查看密码只存哈希，无法导出，导入时再填即可）。`);
      toast("已导出", "ok");
    } catch (err) {
      if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
      showResult(result, escapeHtml(err.message || "导出失败"), true);
    }
  };

  // 保存全局配置
  $("#adminConfigForm", mount).addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = $("#adminCfgResult", mount);
    const payload = {};
    $$("[data-cfg]", mount).forEach((el) => {
      const key = el.dataset.cfg;
      if (el.dataset.bool === "1") { payload[key] = el.checked ? "true" : "false"; return; }
      const v = el.value.trim();
      if (v === MASKED) return;           // 未修改的敏感字段不提交
      payload[key] = v;
    });
    showResult(result, "正在保存…");
    try {
      await api.adminPutConfig(token, payload);
      showResult(result, "✅ 全局配置已保存，立即对所有车主生效。");
      toast("全局配置已保存", "ok");
    } catch (err) {
      if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
      showResult(result, escapeHtml(err.message || "保存失败"), true);
    }
  });

  // 车牌查询
  $("#adminLookupForm", mount).addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = $("#adminLookupResult", mount);
    showResult(result, "正在查询…");
    try {
      const r = await api.adminLookup(token, $("#lkPlate", mount).value);
      if (!r.found) { showResult(result, escapeHtml(r.message || "未找到该车牌。"), true); return; }
      const logs = (r.recentNotifications || []).length
        ? `<div class="log-list" style="margin-top:8px">` + r.recentNotifications.map((n) =>
            `<div class="log-item"><span class="ch">${escapeHtml(CHANNEL_LABELS[n.channel] || n.channel)}</span>
             <span class="pill ${n.status === "sent" ? "ok" : "err"}"><span class="dot"></span>${n.status === "sent" ? "成功" : "失败"}</span>
             <span class="t">${escapeHtml(new Date(n.created_at).toLocaleString("zh-CN"))}</span></div>`).join("") + `</div>`
        : `<p class="muted" style="margin-top:8px">暂无通知记录</p>`;
      showResult(
        result,
        `<div class="stat-row">
           <div class="stat"><div class="n">${escapeHtml(r.maskedPlate || "-")}</div><div class="l">车牌</div></div>
           <div class="stat"><div class="n" style="font-size:18px">${r.phone ? escapeHtml(r.phone) : "未登记"}</div><div class="l">车主电话</div></div>
         </div>
         <p class="field-hint" style="margin-top:10px">可用通道：${(r.channels || []).map((c) => escapeHtml(CHANNEL_LABELS[c] || c)).join("、") || "无"} · 短信${r.smsEnabled ? "开" : "关"} · 隐私号${r.privacyCallEnabled ? "开" : "关"}</p>
         <p class="field-hint">创建时间：${escapeHtml(r.createdAt ? new Date(r.createdAt).toLocaleString("zh-CN") : "-")}</p>
         ${logs}`
      );
      if (r.phone) {
        const btn = document.createElement("button");
        btn.className = "btn btn-sm";
        btn.style.marginTop = "10px";
        btn.textContent = "复制车主电话";
        btn.onclick = async () => { await copyText(r.phone); toast("电话已复制", "ok"); };
        result.appendChild(btn);
      }
    } catch (err) {
      if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
      showResult(result, escapeHtml(err.message || "查询失败"), true);
    }
  });

  // 账号列表 + 新增
  loadAdminAccounts(token);
  $("#adminAccountForm", mount).addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = $("#adminAcctResult", mount);
    showResult(result, "正在创建…");
    try {
      await api.adminCreateAccount(token, {
        username: $("#acUser", mount).value.trim(),
        password: $("#acPass", mount).value,
        role: $("#acRole", mount).value,
      });
      $("#acUser", mount).value = ""; $("#acPass", mount).value = "";
      showResult(result, "✅ 管理员已创建。");
      toast("管理员已创建", "ok");
      loadAdminAccounts(token);
    } catch (err) {
      if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
      showResult(result, escapeHtml(err.message || "创建失败"), true);
    }
  });
}

/* ---------------- 广告位（后台） ---------------- */
async function reloadAdminAds(token) {
  try {
    const r = await api.adminListAds(token);
    renderAdminAdsList(token, r.positions || [], r.ads || []);
  } catch (err) {
    if (err.status === 401) { clearAdminToken(); renderAdminLogin(); }
  }
}

function renderAdminAdsList(token, positions, ads) {
  const box = $("#adListBox");
  if (!box) return;
  if (!ads.length) {
    box.innerHTML = `<p class="muted">暂无广告。添加后会自动显示在对应位置。</p>`;
    return;
  }
  const posLabel = Object.fromEntries(positions.map((p) => [p.key, p.label]));
  const groups = {};
  ads.forEach((a) => { (groups[a.position] = groups[a.position] || []).push(a); });

  box.innerHTML = Object.keys(groups).map((pos) => `
    <h3 class="group-title">${escapeHtml(posLabel[pos] || pos)}</h3>
    <div class="log-list">
      ${groups[pos].map((a) => `
        <div class="log-item" style="flex-wrap:wrap">
          <img class="ad-thumb" src="${escapeHtml(a.image_url)}" alt="" referrerpolicy="no-referrer" />
          <div style="flex:1;min-width:140px">
            <div class="ch">${escapeHtml(a.title || "未命名广告")}</div>
            <div class="t" style="word-break:break-all">#${a.id} · 排序 ${a.sort_order}${a.link_url ? " · 含跳转" : ""}</div>
          </div>
          <span class="pill ${a.enabled ? "ok" : "err"}"><span class="dot"></span>${a.enabled ? "投放中" : "已停用"}</span>
          <div class="actions row" style="margin:0;gap:6px">
            <button class="btn btn-sm btn-ghost" data-ad-toggle="${a.id}">${a.enabled ? "停用" : "启用"}</button>
            <button class="btn btn-sm btn-ghost" data-ad-edit="${a.id}">编辑</button>
            <button class="btn btn-sm btn-ghost" data-ad-del="${a.id}">删除</button>
          </div>
        </div>`).join("")}
    </div>`).join("");

  const find = (id) => ads.find((x) => String(x.id) === String(id));

  $$("[data-ad-toggle]", box).forEach((b) =>
    b.addEventListener("click", async () => {
      const ad = find(b.dataset.adToggle);
      if (!ad) return;
      try {
        await api.adminUpdateAd(token, ad.id, { enabled: !ad.enabled });
        toast(ad.enabled ? "已停用" : "已启用", "ok");
        await reloadAdminAds(token);
      } catch (err) { toast(err.message || "操作失败", "err"); }
    })
  );

  $$("[data-ad-del]", box).forEach((b) =>
    b.addEventListener("click", () => {
      const ad = find(b.dataset.adDel);
      if (!ad) return;
      openModal({
        title: "删除这条广告？",
        body: `将删除 <b>${escapeHtml(ad.title || "未命名广告")}</b>（#${ad.id}），删除后该位置不再展示。`,
        confirmText: "确认删除",
        danger: true,
        onConfirm: async () => {
          try {
            await api.adminDeleteAd(token, ad.id);
            toast("广告已删除", "ok");
            await reloadAdminAds(token);
          } catch (err) { toast(err.message || "删除失败", "err"); }
        },
      });
    })
  );

  $$("[data-ad-edit]", box).forEach((b) =>
    b.addEventListener("click", () => {
      const ad = find(b.dataset.adEdit);
      if (!ad) return;
      openModal({
        title: `编辑广告 #${ad.id}`,
        body: `
          <div class="grid-form" style="margin-top:6px">
            <label class="span-2">投放位置
              <select id="edPos">${positions.map((p) => `<option value="${escapeHtml(p.key)}" ${p.key === ad.position ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("")}</select>
            </label>
            <label class="span-2">图片链接
              <input id="edImg" value="${escapeHtml(ad.image_url)}" />
            </label>
            <label class="span-2">跳转链接（可空）
              <input id="edLink" value="${escapeHtml(ad.link_url || "")}" />
            </label>
            <label class="span-2">备注名
              <input id="edTitle" value="${escapeHtml(ad.title || "")}" />
            </label>
            <label class="span-2">排序
              <input id="edSort" type="number" value="${Number(ad.sort_order) || 0}" />
            </label>
          </div>`,
        confirmText: "保存",
        onConfirm: async () => {
          try {
            await api.adminUpdateAd(token, ad.id, {
              position: $("#edPos").value,
              imageUrl: $("#edImg").value.trim(),
              linkUrl: $("#edLink").value.trim(),
              title: $("#edTitle").value.trim(),
              sortOrder: Number($("#edSort").value) || 0,
            });
            toast("广告已更新", "ok");
            await reloadAdminAds(token);
          } catch (err) { toast(err.message || "更新失败", "err"); }
        },
      });
    })
  );
}

/* ---------------- 车牌管理（后台） ---------------- */
async function reloadAdminVehicles(token, q) {
  const box = $("#vhListBox");
  if (box) box.innerHTML = `<p class="muted">正在加载…</p>`;
  try {
    const r = await api.adminListVehicles(token, q);
    renderAdminVehiclesList(token, r.vehicles || []);
  } catch (err) {
    if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
    if (box) box.innerHTML = `<p class="muted">${escapeHtml(err.message || "加载失败")}</p>`;
  }
}

function renderAdminVehiclesList(token, vehicles) {
  const box = $("#vhListBox");
  if (!box) return;
  if (!vehicles.length) {
    box.innerHTML = `<p class="muted">没有匹配的车牌记录。</p>`;
    return;
  }
  box.innerHTML = `<div class="log-list">` + vehicles.map((v) => `
      <div class="log-item" style="flex-wrap:wrap;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:170px">
          <div class="ch" style="font-size:15px">
            ${escapeHtml(v.plateNumber)}
            ${v.plateMissing ? `<span class="pill warn"><span class="dot"></span>待补全</span>` : ""}
          </div>
          <div class="t">#${v.id} · ${v.ownerPhone ? escapeHtml(v.ownerPhone) : "未登记手机号"} · ${v.hasPin ? "已设查看密码" : "未设查看密码"}</div>
          <div class="t">创建 ${escapeHtml(fmtDate(v.createdAt))}</div>
        </div>
        <div class="channels" style="flex:1 1 100%">
          ${channelPill("wechat_work", Boolean(v.wechatWorkWebhook))}
          ${channelPill("showdoc", Boolean(v.showdocWebhook))}
          ${channelPill("sms", Boolean(v.smsEnabled))}
          ${channelPill("privacy_call", Boolean(v.privacyCallEnabled))}
        </div>
        <div class="actions row" style="margin:0;gap:6px;flex:1 1 100%">
          <button class="btn btn-sm btn-ghost" data-vh-edit="${v.id}">编辑</button>
          <button class="btn btn-sm btn-ghost" data-vh-pin="${v.id}">改密码</button>
          <button class="btn btn-sm btn-primary" data-vh-enter="${v.id}">进入车主后台</button>
          <button class="btn btn-sm btn-ghost" data-vh-del="${v.id}">删除</button>
        </div>
      </div>`).join("") + `</div>`;

  const find = (id) => vehicles.find((x) => String(x.id) === String(id));
  const refresh = () => reloadAdminVehicles(token, $("#vhSearch")?.value.trim() || "");

  $$("[data-vh-edit]", box).forEach((b) =>
    b.addEventListener("click", () => openVehicleEditor(token, find(b.dataset.vhEdit)))
  );
  $$("[data-vh-pin]", box).forEach((b) =>
    b.addEventListener("click", () => openVehiclePinEditor(token, find(b.dataset.vhPin)))
  );
  $$("[data-vh-enter]", box).forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const r = await api.adminVehicleOwnerToken(token, b.dataset.vhEnter);
        const url = `${new URL("./owner.html", location.href).toString()}?token=${encodeURIComponent(r.ownerToken)}`;
        window.open(url, "_blank", "noopener");
        toast("已在新标签页打开车主后台", "ok");
      } catch (err) {
        if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
        toast(err.message || "打开失败", "err");
      }
    })
  );
  $$("[data-vh-del]", box).forEach((b) =>
    b.addEventListener("click", () => {
      const v = find(b.dataset.vhDel);
      if (!v) return;
      openModal({
        title: "删除该车牌绑定？",
        body: `将删除 <b>${escapeHtml(v.plateNumber)}</b>（#${v.id}）的挪车码与全部通知记录，二维码立即失效且无法恢复。`,
        confirmText: "确认删除",
        danger: true,
        onConfirm: async () => {
          try {
            await api.adminDeleteVehicle(token, v.id);
            toast("已删除", "ok");
            await refresh();
          } catch (err) { toast(err.message || "删除失败", "err"); }
        },
      });
    })
  );
}

function openVehicleEditor(token, vehicle) {
  const isEdit = Boolean(vehicle);
  openModal({
    title: isEdit ? `编辑车牌 #${vehicle.id}` : "新增车牌绑定",
    body: `<div class="grid-form" style="margin-top:6px">
        <label class="span-2">车牌号
          <input id="vePlate" value="${escapeHtml(vehicle?.plateNumber || "")}" placeholder="例如 粤A12345" />
        </label>
        <label class="span-2">车主手机号（短信 / 隐私号需要）
          <input id="vePhone" value="${escapeHtml(vehicle?.ownerPhone || "")}" placeholder="11 位手机号" />
        </label>
        <label class="span-2">企业微信 Webhook
          <input id="veWechat" value="${escapeHtml(vehicle?.wechatWorkWebhook || "")}" placeholder="https://qyapi.weixin.qq.com/..." />
        </label>
        <label class="span-2">ShowDoc Webhook
          <input id="veShowdoc" value="${escapeHtml(vehicle?.showdocWebhook || "")}" placeholder="https://..." />
        </label>
        <div class="switch-row span-2">
          <div class="meta"><b>短信通知</b><span>需填手机号 + 平台短信通道</span></div>
          <label class="switch"><input type="checkbox" id="veSms" ${vehicle?.smsEnabled ? "checked" : ""}><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="switch-row span-2">
          <div class="meta"><b>隐私号呼叫</b><span>需填手机号 + 平台隐私号通道</span></div>
          <label class="switch"><input type="checkbox" id="vePrivacy" ${vehicle?.privacyCallEnabled ? "checked" : ""}><span class="track"></span><span class="thumb"></span></label>
        </div>
        <label class="span-2">${isEdit ? "重置查看密码（留空则不变）" : "查看密码（可选，4-12 位数字）"}
          <input id="vePin" placeholder="4-12 位数字" />
        </label>
        <p class="field-hint" style="grid-column:1/-1">车主用「车牌 + 查看密码」在管理后台找回入口。</p>
      </div>`,
    confirmText: isEdit ? "保存修改" : "创建绑定",
    onConfirm: async () => {
      const payload = {
        plateNumber: $("#vePlate").value.trim(),
        ownerPhone: $("#vePhone").value.trim(),
        wechatWorkWebhook: $("#veWechat").value.trim(),
        showdocWebhook: $("#veShowdoc").value.trim(),
        smsEnabled: $("#veSms").checked,
        privacyCallEnabled: $("#vePrivacy").checked,
      };
      const pin = $("#vePin").value.trim();
      if (pin) payload.ownerPin = pin;
      if (payload.smsEnabled || payload.privacyCallEnabled) {
        if (!payload.ownerPhone && !vehicle?.ownerPhone) return toast("开启短信/隐私号需填写手机号", "err");
      }
      try {
        const r = isEdit
          ? await api.adminUpdateVehicle(token, vehicle.id, payload)
          : await api.adminCreateVehicle(token, payload);
        toast(r.message || (isEdit ? "已保存" : "已创建"), "ok");
        await reloadAdminVehicles(token, $("#vhSearch")?.value.trim() || "");
      } catch (err) {
        if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
        toast(err.message || "保存失败", "err");
      }
    },
  });
}

function openVehiclePinEditor(token, vehicle) {
  if (!vehicle) return;
  openModal({
    title: `修改 ${vehicle.plateNumber} 的查看密码`,
    body: `<div class="grid-form" style="margin-top:6px">
        <label class="span-2">新的查看密码
          <input id="vpPin" placeholder="4-12 位数字，留空则清除密码" />
        </label>
        <p class="field-hint" style="grid-column:1/-1">清空后，车主将只能凭原管理链接进入后台，无法用「车牌 + 密码」找回。</p>
      </div>`,
    confirmText: "保存",
    onConfirm: async () => {
      const pin = $("#vpPin").value.trim();
      if (pin && !/^\d{4,12}$/.test(pin)) return toast("查看密码需为 4-12 位数字", "err");
      try {
        await api.adminUpdateVehicle(token, vehicle.id, { ownerPin: pin });
        toast(pin ? "查看密码已更新" : "已清除查看密码", "ok");
        await reloadAdminVehicles(token, $("#vhSearch")?.value.trim() || "");
      } catch (err) {
        if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
        toast(err.message || "保存失败", "err");
      }
    },
  });
}

function openAdminPasswordModal(token) {
  openModal({
    title: "修改我的登录密码",
    body: `<div class="grid-form" style="margin-top:6px">
        <label class="span-2">当前密码
          <input id="apCur" type="password" autocomplete="current-password" />
        </label>
        <label class="span-2">新密码（至少 8 位）
          <input id="apNew" type="password" autocomplete="new-password" />
        </label>
        <label class="span-2">确认新密码
          <input id="apNew2" type="password" autocomplete="new-password" />
        </label>
        <p class="field-hint" style="grid-column:1/-1">修改成功后所有管理员会话会立即失效，需要重新登录。</p>
      </div>`,
    confirmText: "确认修改",
    onConfirm: async () => {
      const cur = $("#apCur").value;
      const nw = $("#apNew").value;
      if (nw.length < 8) return toast("新密码至少 8 位", "err");
      if (nw !== $("#apNew2").value) return toast("两次输入的新密码不一致", "err");
      try {
        await api.adminChangePassword(token, cur, nw);
        clearAdminToken();
        toast("密码已修改，请重新登录", "ok");
        renderAdminLogin();
      } catch (err) {
        toast(err.message || "修改失败", "err");
      }
    },
  });
}

/* ---------------- 导入解析（CSV / JSON） ---------------- */
const IMPORT_HEADERS = ["车牌号", "查看密码", "手机号", "短信通知", "隐私号呼叫", "企业微信Webhook", "ShowDocWebhook"];

function truthyFlag(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "是", "y", "yes", "开", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function normalizeImportItem(raw) {
  return {
    plateNumber: String(raw.plateNumber ?? raw["车牌号"] ?? raw.plate ?? "").trim(),
    ownerPin: String(raw.ownerPin ?? raw["查看密码"] ?? raw["管理密码"] ?? raw.pin ?? "").trim(),
    ownerPhone: String(raw.ownerPhone ?? raw["手机号"] ?? raw.phone ?? "").trim(),
    smsEnabled: truthyFlag(raw.smsEnabled ?? raw["短信通知"]),
    privacyCallEnabled: truthyFlag(raw.privacyCallEnabled ?? raw["隐私号呼叫"]),
    wechatWorkWebhook: String(raw.wechatWorkWebhook ?? raw["企业微信Webhook"] ?? "").trim(),
    showdocWebhook: String(raw.showdocWebhook ?? raw["ShowDocWebhook"] ?? "").trim(),
  };
}

function parseVehicleImport(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const data = JSON.parse(trimmed);
    const arr = Array.isArray(data) ? data : (data.items || data.vehicles || []);
    return arr.map(normalizeImportItem).filter((x) => x.plateNumber);
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const start = /车牌|plate/i.test(lines[0]) ? 1 : 0;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (!cells[0]) continue;
    out.push(normalizeImportItem({
      plateNumber: cells[0],
      ownerPin: cells[1],
      ownerPhone: cells[2],
      smsEnabled: cells[3],
      privacyCallEnabled: cells[4],
      wechatWorkWebhook: cells[5],
      showdocWebhook: cells[6],
    }));
  }
  return out.filter((x) => x.plateNumber);
}

async function loadAdminAccounts(token) {
  const box = $("#adminAccountList");
  if (!box) return;
  try {
    const r = await api.adminListAccounts(token);
    const list = r.accounts || [];
    box.innerHTML = list.length
      ? `<div class="log-list">` + list.map((a) =>
          `<div class="log-item">
             <span class="ch">${escapeHtml(a.username)}</span>
             <span class="pill ${a.role === "super" ? "warn" : ""}"><span class="dot"></span>${escapeHtml(a.role)}</span>
             <button class="btn btn-sm btn-ghost" data-del="${escapeHtml(a.username)}">删除</button>
           </div>`).join("") + `</div>`
      : `<p class="muted">暂无账号。</p>`;
    $$("[data-del]", box).forEach((b) =>
      b.addEventListener("click", () => {
        openModal({
          title: "删除管理员？",
          body: `将删除账号 <b>${escapeHtml(b.dataset.del)}</b> 及其所有登录会话。`,
          confirmText: "确认删除",
          danger: true,
          onConfirm: async () => {
            try { await api.adminDeleteAccount(token, b.dataset.del); toast("已删除", "ok"); loadAdminAccounts(token); }
            catch (err) { toast(err.message || "删除失败", "err"); }
          },
        });
      })
    );
  } catch (err) {
    box.innerHTML = `<p class="muted">${escapeHtml(err.message || "加载失败")}</p>`;
  }
}

/* ============================================================
   使用说明（setup）· 检查后端
   ============================================================ */
function setupSetupPage() {
  const form = $("#setupCheckForm");
  const health = $("#healthResult");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!hasApiBase()) { showResult(health, "请先在顶部填入后端地址。", true); return; }
    showResult(health, "正在检查后端…");
    try {
      const h = await api.health();
      const rows = [
        ["状态", h.status === "ok" ? `<span class="pill ok"><span class="dot"></span>正常</span>` : `<span class="pill warn"><span class="dot"></span>降级</span>`],
        ["数据库 D1", h.d1 ? "✅" : "❌"],
        ["数据加密", h.encryption ? "✅" : "❌"],
        ["腾讯云 OCR", h.tencentOcr ? "✅" : (h.ocrDemo ? "演示模式" : "未配置")],
        ["腾讯云短信", h.tencentSms ? "✅" : "❌"],
        ["隐私号呼叫", h.privacyCall ? "✅" : "❌"],
      ];
      const missing = (h.missing || []).length ? h.missing.join(", ") : "无";
      showResult(
        health,
        `<div class="stat-row">` +
          rows.map(([l, v]) => `<div class="stat"><div class="n">${v}</div><div class="l">${escapeHtml(l)}</div></div>`).join("") +
          `</div>
          <p class="field-hint" style="margin-top:10px">缺失配置：${escapeHtml(missing)}</p>`
      );
    } catch (err) {
      showResult(health, escapeHtml(err.message || "检查失败"), true);
    }
  });
}

/* ============================================================
   流程演示（demo）
   ============================================================ */
function setupDemoPage() {
  const flow = $("#demoFlow");
  const replay = $("#replayDemoButton");
  if (!flow || !replay) return;
  const play = () => {
    $$(".step", flow).forEach((el, i) => {
      el.classList.remove("fade-in");
      void el.offsetWidth; // 重启动画
      el.style.animationDelay = `${i * 0.8}s`;
      el.classList.add("fade-in");
    });
  };
  replay.addEventListener("click", play);
  play();
}

/* ============================================================
   广告位渲染（图片链接由超级管理员在后台配置，无广告则整块隐藏）
   ============================================================ */
async function renderAdSlots() {
  const slots = $$("[data-ad-position]");
  if (!slots.length) return;
  await Promise.all(
    slots.map(async (slot) => {
      const position = slot.dataset.adPosition;
      try {
        const r = await api.listAds(position);
        const ads = r.ads || [];
        if (!ads.length) { slot.classList.add("hidden"); return; }
        slot.classList.remove("hidden");
        slot.innerHTML =
          `<div class="ad-label">推广</div><div class="ad-list">` +
          ads
            .map((ad) => {
              const img = `<img src="${escapeHtml(ad.image_url)}" alt="${escapeHtml(ad.title || "推广")}" loading="lazy" referrerpolicy="no-referrer" />`;
              return ad.link_url
                ? `<a class="ad-item" href="${escapeHtml(ad.link_url)}" target="_blank" rel="noopener noreferrer sponsored">${img}</a>`
                : `<div class="ad-item">${img}</div>`;
            })
            .join("") +
          `</div>`;
      } catch {
        slot.classList.add("hidden");
      }
    })
  );
}

/* ---------------- 启动 ---------------- */
ensureConfigBanner();
renderAdSlots();

const page = document.body.dataset.page;
if (page === "bind") setupBindPage();
if (page === "move") setupMovePage();
if (page === "owner") setupOwnerPage();
if (page === "admin") setupAdminPage();
if (page === "setup") setupSetupPage();
if (page === "demo") setupDemoPage();
