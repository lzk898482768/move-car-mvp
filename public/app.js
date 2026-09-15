// 扫码挪车 · 前端主逻辑（Worker 版）
import {
  api, getApiBase, hasApiBase, setApiBase,
  buildMoveUrl, qrImageUrl,
  saveOwnerToken, loadOwnerTokens, clearOwnerToken,
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

// 简单模态
function openModal({ title, body, confirmText, danger, onConfirm }) {
  let mask = $("#modalMask");
  if (!mask) {
    mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.id = "modalMask";
    mask.innerHTML = `<div class="modal">
      <h3 id="modalTitle"></h3>
      <p id="modalBody"></p>
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
  return `<span class="pill ${ok ? "ok" : ""}"><span class="dot"></span>${escapeHtml(label)}</span>`;
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

    showResult(result, "正在创建…");
    try {
      validatePlate(plate);
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
      showResult(
        vehicleEl,
        `<div class="hero-plate">
           <div class="eyebrow">扫码联系车主</div>
           <div class="plate">${escapeHtml(v.maskedPlate)}</div>
           <div class="muted">需要车主挪车？点击下方按钮匿名通知</div>
         </div>`
      );
      const chs = v.availableChannels || [];
      if (chs.length === 0) {
        showResult(resultEl, "该车主暂未配置任何通知方式。", true);
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
        : `<p class="muted">暂无本地保存的管理链接。</p>`}
      <div class="actions">
        <button class="btn btn-ghost" id="pasteToken">粘贴管理链接 / Token</button>
      </div>
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
          <input id="f_wechat" placeholder="https://qyapi.weixin.qq.com/..." value="">
        </label>
        <label class="span-2">ShowDoc Webhook
          <input id="f_showdoc" placeholder="https://..." value="">
        </label>
        <label class="span-2">ShowDoc Token
          <input id="f_showdocToken" placeholder="可选" value="">
        </label>
        <label class="span-2">车主手机号（短信/隐私号需要）
          <input id="f_phone" inputmode="tel" placeholder="用于短信与隐私号呼叫">
        </label>
        <div class="switch-row span-2">
          <div class="meta"><b>短信通知</b><span>腾讯云短信下发到车主</span></div>
          <label class="switch"><input type="checkbox" id="f_sms"><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="switch-row span-2">
          <div class="meta"><b>隐私号呼叫</b><span>通过隐私号服务呼叫，隐藏真实号码</span></div>
          <label class="switch"><input type="checkbox" id="f_privacy"><span class="track"></span><span class="thumb"></span></label>
        </div>
        <button class="btn btn-primary span-2" id="saveChannels">保存渠道配置</button>
      </div>
      <p class="form-note">提示：出于隐私保护，手机号不会回显，如需启用请重新填写。</p>
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
    const patch = {
      wechatWorkWebhook: $("#f_wechat", mount).value.trim(),
      showdocWebhook: $("#f_showdoc", mount).value.trim(),
      showdocToken: $("#f_showdocToken", mount).value.trim(),
      ownerPhone: normalizePhone($("#f_phone", mount).value),
      smsEnabled: $("#f_sms", mount).checked,
      privacyCallEnabled: $("#f_privacy", mount).checked,
    };
    // 布尔值始终提交（含 false，用于关闭渠道）；仅跳过空字符串
    Object.keys(patch).forEach((k) => {
      if (typeof patch[k] === "string" && patch[k] === "") delete patch[k];
    });
    if (patch.smsEnabled && !patch.ownerPhone) return toast("开启短信需填写手机号", "err");
    if (patch.privacyCallEnabled && !patch.ownerPhone) return toast("开启隐私号需填写手机号", "err");
    try {
      await api.patchOwnerVehicle(ownerToken, patch);
      toast("配置已更新", "ok");
      setTimeout(() => renderDashboard(ownerToken), 600);
    } catch (err) { toast(err.message || "保存失败", "err"); }
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

/* ---------------- 启动 ---------------- */
ensureConfigBanner();

const page = document.body.dataset.page;
if (page === "bind") setupBindPage();
if (page === "move") setupMovePage();
if (page === "owner") setupOwnerPage();
if (page === "setup") setupSetupPage();
if (page === "demo") setupDemoPage();
