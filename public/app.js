// 扫码挪车 · 前端主逻辑（Worker 版）
import {
  api, getApiBase, hasApiBase, setApiBase,
  buildMoveUrl, buildQrUrl, qrImageUrl,
  saveOwnerToken, loadOwnerTokens, clearOwnerToken,
  saveAdminToken, loadAdminToken, clearAdminToken,
} from "./api.js";
import { createPlateInput } from "./plate-input.js";

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

// 简单模态（onOpen 在内容渲染后调用；onCancel 在未确认就关闭时调用）
let modalCancelHandler = null;
function openModal({ title, body, confirmText, danger, onConfirm, onOpen, onCancel }) {
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
  modalCancelHandler = typeof onCancel === "function" ? onCancel : null;
  ok.onclick = () => {
    modalCancelHandler = null; // 已确认，不再触发取消
    closeModal();
    onConfirm && onConfirm();
  };
  mask.classList.add("show");
  if (typeof onOpen === "function") { try { onOpen(); } catch (e) { console.error(e); } }
}
function closeModal() {
  $("#modalMask")?.classList.remove("show");
  const cb = modalCancelHandler;
  modalCancelHandler = null;
  if (cb) { try { cb(); } catch {} }
}

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
  notify_all: "一键通知",
  wechat_work: "企业微信",
  wechat: "微信通知",
  sms: "短信",
  privacy_call: "隐私拨号",
  direct_call: "直拨",
};
function channelPill(ch, ok) {
  const label = CHANNEL_LABELS[ch] || ch;
  return `<span class="pill ${ok ? "ok" : "off"}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

/* ---------------- 车主可见通道：只显示超级管理员已开通的 ---------------- */
function ownerOpenedChannels(vehicle) {
  const list = vehicle?.platformChannels;
  if (Array.isArray(list)) return list;
  // 后端未返回（旧版本）时回退为全部，避免误伤
  return ["wechat_work", "wechat", "sms", "privacy_call"];
}

function ownerChannelFields(vehicle) {
  const opened = new Set(ownerOpenedChannels(vehicle));
  const has = (c) => opened.has(c);
  const platformDirect = vehicle.global ? Boolean(vehicle.global.directCall) : true;
  const platformPrivacy = has("privacy_call");
  const platformSms = has("sms");
  const platformNotify = has("wechat_work") || has("wechat");
  if (!platformDirect && !platformPrivacy && !platformSms && !platformNotify) {
    return `<p class="muted" style="grid-column:1/-1">超级管理员尚未开通任何通知方式，请联系平台管理员在后台「通知渠道」中开启。</p>`;
  }
  const needPhone = platformSms || platformPrivacy || platformDirect;
  const privacy = Boolean(vehicle.privacyCallEnabled);
  const parts = [];
  const switchRow = (id, label, desc, checked) => `<div class="switch-row span-2">
        <div class="meta"><b>${label}</b><span>${desc}</span></div>
        <label class="switch"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}><span class="track"></span><span class="thumb"></span></label>
      </div>`;
  // 直拨（默认）：与隐私拨号互斥，仅作状态展示
  if (platformDirect || platformPrivacy) {
    parts.push(`<div class="switch-row span-2 ${privacy ? "is-off" : ""}" id="f_directRow">
        <div class="meta"><b>直拨车主（默认）</b><span id="f_directDesc">${privacy ? "已由「隐私拨号」接管，访客通过隐私号接通" : "访客直接拨打你的手机号；开启隐私拨号后自动关闭"}</span></div>
        <span class="pill ${privacy ? "off" : "ok"}" id="f_directState"><span class="dot"></span>${privacy ? "已关闭" : "使用中"}</span>
      </div>`);
  }
  if (platformPrivacy) {
    parts.push(switchRow("f_privacy", "隐私拨号", "通过隐私号接通，隐藏双方真实号码；开启后「直拨」自动关闭", privacy));
  }
  if (platformSms) {
    parts.push(switchRow("f_sms", "短信通知", "由平台短信通道下发到车主手机号", Boolean(vehicle.smsEnabled)));
  }
  if (platformNotify) {
    parts.push(switchRow("f_notify_all", "一键通知", "同时调用企业微信接口 + 微信公众号模板消息接口提醒你", Boolean(vehicle.notifyAllEnabled)));
  }
  if (has("wechat")) {
    parts.push(`<label class="span-2">微信接收 OpenID（可选）
        <input id="f_openid" placeholder="${vehicle.hasWechatOpenid ? "已设置（留空则保持不变）" : "留空则使用平台默认 OpenID"}" value="">
        <span class="field-hint">关注公众号后可获取；留空则使用超管配置的默认 OpenID。</span>
      </label>`);
  }
  if (needPhone) {
    parts.push(`<label class="span-2">车主手机号
        <input id="f_phone" inputmode="tel" placeholder="${vehicle.ownerPhoneMasked ? `当前：${escapeHtml(vehicle.ownerPhoneMasked)}（留空则不变）` : "用于短信 / 隐私拨号 / 直拨"}" value="">
      </label>`);
  }
  parts.push(`<button class="btn btn-primary span-2" id="saveChannels">保存渠道配置</button>`);
  return parts.join("");
}

/* ============================================================
   车主 · 创建挪车码（bind）
   ============================================================ */
function setupBindPage() {
  const form = $("#bindForm");
  const result = $("#bindResult");
  if (!form) return;
  // 后台预生成二维码的绑定模式：/index.html?c=<codeToken>
  const bindCode = new URLSearchParams(location.search).get("c") || "";
  if (bindCode) {
    const panel = form.closest(".panel");
    panel?.insertAdjacentHTML(
      "afterbegin",
      `<div class="notice" style="margin-bottom:14px">
         <b>📱 正在绑定这个挪车二维码</b>
         <div class="t" style="margin-top:6px">填写车牌与手机号即可完成绑定；绑定后任何人再扫这个码都会直接进入挪车界面。</div>
       </div>`
    );
    const title = document.querySelector(".hero-banner .hb-title");
    if (title) title.innerHTML = "绑定<br /><em>挪车二维码</em>";
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = "绑定并生成挪车码";
  }
  // 组件挂载成功后接管并隐藏原生 input，值始终同步回 input，保证任何情况下都能读到
  const plateInput = createPlateInput($("#plateNumberHost"), { input: $("#plateNumber"), allowTypeSwitch: true });

  // 与后台实时同步：后台未开通的通道，前台不显示
  const opened = { privacy_call: true, sms: true, notify_all: true, direct_call: true };
  const applyOpened = () => {
    const show = (name, on) => $$(`[data-channel="${name}"]`, form).forEach((el) => el.classList.toggle("hidden", !on));
    show("privacy_call", opened.privacy_call);
    show("sms", opened.sms);
    show("notify_all", opened.notify_all);
    show("direct_call", opened.direct_call);
    // 直拨为默认方式；只要有一种可用方式即可创建
    const anyMethod = opened.privacy_call || opened.sms || opened.notify_all || opened.direct_call;
    $("#noChannelNote")?.classList.toggle("hidden", anyMethod);
    const submit = $('button[type="submit"]', form);
    if (submit) submit.disabled = !anyMethod;
  };
  // 拉取后台通道开关状态：后台改开关后，前台回到本页即自动显示/隐藏
  const refreshChannels = async () => {
    try {
      const r = await api.publicChannels();
      const ch = r.channels || {};
      opened.privacy_call = ch.privacy_call === true;
      opened.sms = ch.sms === true;
      // 一键通知：企微或微信任一开通即可用
      opened.notify_all = Boolean(ch.wechat_work || ch.wechat);
      opened.direct_call = ch.direct_call !== false;
      applyOpened();
    } catch {}
  };
  // 直拨 / 隐私拨号 联动：开启隐私拨号 → 直拨自动关闭
  const syncCallMode = () => {
    const privacy = Boolean(form.privacyCallEnabled?.checked);
    const state = $("#directCallState", form);
    const desc = $("#directCallDesc", form);
    if (state) {
      state.className = `pill ${privacy ? "off" : "ok"}`;
      state.innerHTML = `<span class="dot"></span>${privacy ? "已关闭" : "使用中"}`;
    }
    if (desc) desc.textContent = privacy
      ? "已由「隐私拨号」接管，访客将通过隐私号接通"
      : "访客直接拨打你的手机号；开启隐私拨号后自动关闭";
    $("#directCallRow", form)?.classList.toggle("is-off", privacy);
  };
  form.privacyCallEnabled?.addEventListener("change", syncCallMode);
  syncCallMode();
  applyOpened();
  refreshChannels();
  // 后台改完通道后无需重开页面：切回本页 / 重新聚焦时自动同步
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshChannels(); });
  window.addEventListener("focus", refreshChannels);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const plate = normalizePlate($("#plateNumber")?.value ?? "");
    const ownerPhone = normalizePhone(form.ownerPhone.value);
    const privacyCallEnabled = form.privacyCallEnabled.checked;
    const smsEnabled = form.smsEnabled.checked;
    const notifyAllEnabled = form.notifyAllEnabled.checked;
    const ownerPin = form.ownerPin ? form.ownerPin.value.trim() : "";

    showResult(result, "正在创建…");
    try {
      if (plateInput && !plateInput.isValid()) throw new Error("请点选完整车牌（普通 7 位 / 新能源 8 位）。");
      validatePlate(plate);
      if (!isPhone(ownerPhone)) throw new Error("请填写有效手机号（录入车牌必填，用于通知与换号验证）。");
      if (ownerPin && !/^\d{4,12}$/.test(ownerPin)) throw new Error("管理密码请使用 4-12 位数字。");
      if (notifyAllEnabled && !opened.notify_all) throw new Error("平台尚未开通企业微信 / 微信通知。");
      if (smsEnabled && !opened.sms) throw new Error("平台尚未开通短信通知。");
      if (privacyCallEnabled && !opened.privacy_call) throw new Error("平台尚未开通隐私拨号。");
      if (!privacyCallEnabled && !smsEnabled && !notifyAllEnabled && !opened.direct_call) {
        throw new Error("平台尚未开通任何通知方式，请联系管理员。");
      }

      const payload = {
        plateNumber: plate,
        ownerPhone,
        privacyCallEnabled,
        smsEnabled,
        notifyAllEnabled,
        ownerPin,
      };
      const data = bindCode ? await api.qrBind(bindCode, payload) : await api.createVehicle(payload);
      saveOwnerToken(data.ownerToken, data.maskedPlate);

      const moveUrl = buildMoveUrl(data.vehicleToken);
      const ownerUrl = `${new URL("./owner.html", location.href).toString()}?token=${encodeURIComponent(data.ownerToken)}`;
      showResult(
        result,
        `<div class="fade-in qr-wrap">
          <div class="pill ok"><span class="dot"></span>${bindCode ? "二维码绑定成功" : "挪车码已生成"}</div>
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
      // 车牌重复：不再让重复录入，直接引导「找回」
      if (err.code === "plate_exists" || err.status === 409) {
        showResult(
          result,
          `<div class="notice">
             <b>该车牌已录入过</b>
             <div class="t" style="margin-top:6px">一个车牌只能录入一次。请用「车牌 + 管理密码」找回管理入口${err.maskedPlate ? `（${escapeHtml(err.maskedPlate)}）` : ""}。</div>
             <div class="grid-form" style="margin-top:10px">
               <label class="span-2">管理密码
                 <input id="dupPin" type="password" inputmode="numeric" placeholder="创建时设置的管理密码" autocomplete="current-password" />
               </label>
               <button type="button" class="btn btn-primary span-2" id="dupRecover">找回并进入管理后台</button>
             </div>
           </div>`
        );
        $("#dupRecover", result).onclick = async () => {
          const pin = ($("#dupPin", result)?.value || "").trim();
          if (!pin) return toast("请输入管理密码", "err");
          try {
            const r = await api.recoverOwner(plate, pin);
            saveOwnerToken(r.ownerToken, r.maskedPlate);
            toast("已找回，正在进入后台", "ok");
            location.href = `${new URL("./owner.html", location.href).toString()}?token=${encodeURIComponent(r.ownerToken)}`;
          } catch (e) {
            toast(e.message || "找回失败", "err");
          }
        };
        return;
      }
      showResult(result, escapeHtml(err.message || "创建失败"), true);
    }
  });
}

/* ============================================================
   访客 · 扫码通知（move）
   ============================================================ */
function setupMovePage() {
  const params = new URLSearchParams(location.search);
  const codeToken = params.get("c");          // 后台预生成的二维码
  const vehicleTokenParam = params.get("token"); // 直接带车辆令牌（旧链接）
  const vehicleEl = $("#publicVehicle");
  const resultEl = $("#contactResult");
  const channelsEl = $("#channelPicker");
  const notifyBtn = $("#notifyButton");

  if (!codeToken && !vehicleTokenParam) {
    showResult(vehicleEl, "二维码内容缺失，请重新生成或扫描挪车二维码。", true);
    if (notifyBtn) notifyBtn.disabled = true;
    return;
  }

  let selectedChannel = ""; // 空 = 后端默认
  let token = vehicleTokenParam || "";

  // 后台预生成码：未绑定时引导车主绑定
  function renderBindPrompt() {
    if (notifyBtn) { notifyBtn.disabled = true; notifyBtn.classList.add("hidden"); }
    $("#directCallButton")?.classList.add("hidden");
    $("#directCallNote")?.classList.add("hidden");
    $("#callerBox")?.classList.add("hidden");
    if (channelsEl) channelsEl.innerHTML = "";
    const bindUrl = (() => {
      const u = new URL("./index.html", location.href);
      u.searchParams.set("c", codeToken);
      return u.toString();
    })();
    showResult(
      resultEl,
      `<div class="notice" style="text-align:left">
         <b>这个挪车码还没有绑定车辆</b>
         <div class="t" style="margin-top:6px">如果你是车主：点下面的按钮，填好车牌和手机号即可完成绑定。绑定后任何人再扫这个码，都会直接进入挪车界面。</div>
         <a class="btn btn-primary" style="margin-top:12px;display:block;text-align:center" href="${escapeHtml(bindUrl)}">车主：绑定此二维码</a>
       </div>`
    );
    showResult(vehicleEl, `<div class="qr-state">待绑定</div><p class="privacy-note">此二维码尚未绑定车辆，暂时无法呼叫车主。</p>`);
  }

  function renderQrError(msg) {
    if (notifyBtn) { notifyBtn.disabled = true; notifyBtn.classList.add("hidden"); }
    $("#directCallButton")?.classList.add("hidden");
    $("#callerBox")?.classList.add("hidden");
    showResult(vehicleEl, escapeHtml(msg || "二维码无效。"), true);
    showResult(resultEl, "如二维码损坏，请联系车主或平台重新补发。");
  }

  async function load() {
    // 预生成码：先解析（已绑定 → 拿到车辆令牌进挪车界面；未绑定 → 引导车主绑定）
    if (!token && codeToken) {
      showResult(vehicleEl, "正在读取二维码…");
      try {
        const r = await api.qrResolve(codeToken);
        if (r.status === "bound" && r.vehicleToken) token = r.vehicleToken;
        else { renderBindPrompt(); return; }
      } catch (err) {
        renderQrError(err.message);
        return;
      }
    }
    try {
      const v = await api.getPublicVehicle(token);
      const chs = v.availableChannels || [];
      showResult(
        vehicleEl,
        `<div class="plate-big">${escapeHtml(v.maskedPlate)}</div>
         <p class="privacy-note">${v.callMode === "direct"
            ? "该车主使用 <b>直拨</b>（默认方式）：点击下方按钮直接拨打车主号码。"
            : `为保护双方隐私，本次通知将采用 <b>${chs.length ? "匿名方式" : "平台通道"}</b> 送达车主，不会暴露你的号码。`}</p>`
      );
      // 拨打方式：隐私拨号（隐私号接通）或 直拨（默认，直接拨打车主号码）
      const directBtn = $("#directCallButton");
      const directNote = $("#directCallNote");
      const dc = v.directCall;
      if (directBtn && dc?.enabled && dc.phone) {
        directBtn.href = `tel:${dc.phone}`;
        directBtn.classList.remove("hidden");
        // 直拨为默认方式 → 设为主要操作，并把它排到最前
        directBtn.classList.add("btn-primary");
        if (notifyBtn) {
          notifyBtn.textContent = "通知车主（短信 / 消息）";
          notifyBtn.classList.remove("btn-primary");
          notifyBtn.classList.add("btn-ghost");
          directBtn.parentElement?.insertBefore(directBtn, notifyBtn);
        }
        // 说明文案：呼号按钮已置顶，这里只在需要时补充提示
        if (directNote) {
          directNote.textContent = "点击将调用手机拨号盘直接拨打车主号码。";
          directNote.classList.remove("hidden");
        }
      }
      if (chs.length === 0 && !(dc?.enabled && dc.phone)) {
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
      // 直拨前上报拨号日志（直拨由客户端发起，服务端无法感知）
      const dcBtn = $("#directCallButton");
      if (dcBtn) {
        dcBtn.addEventListener("click", () => {
          const caller = $("#callerNumber")?.value?.trim() || "";
          api.reportDirectCall(token, caller).catch(() => {});
        });
      }
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
        const r = await api.notify(token, selectedChannel, $("#callerNumber")?.value?.trim() || "");
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
          <input id="rcPlate" placeholder="例如 粤A12345" autocomplete="off" />
          <div id="rcPlateHost" class="plate-input-host"></div>
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
  const rcPlateInput = createPlateInput($("#rcPlateHost", mount), { input: $("#rcPlate", mount), allowTypeSwitch: true });
  rcForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rcResult = $("#recoverResult", mount);
    const plate = normalizePlate($("#rcPlate", mount)?.value ?? "");
    if (rcPlateInput && !rcPlateInput.isValid()) { showResult(rcResult, "请点选完整车牌（普通 7 位 / 新能源 8 位）。", true); return; }
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
  let currentToken = "";

  resolveOwnerToken().then(async (token) => {
    if (!token) { renderTokenPicker(); return; }
    currentToken = token;
    await renderDashboard(token);
  });

  // 后台改了通道开关后，切回本页自动同步（若正在填写表单则不打断）
  const syncOnReturn = () => {
    if (document.hidden || !currentToken) return;
    const typing = $$("input, textarea", mount).some(
      (el) => el.type !== "checkbox" && String(el.value || "").trim()
    );
    if (typing) return;
    renderDashboard(currentToken);
  };
  document.addEventListener("visibilitychange", syncOnReturn);
  window.addEventListener("focus", syncOnReturn);
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
  // 当前生效的通知方式（直拨为默认；开启隐私拨号后由隐私拨号接管）
  const pills = [];
  if (vehicle.notifyAllEnabled) pills.push(channelPill("notify_all", true));
  if (vehicle.smsEnabled) pills.push(channelPill("sms", true));
  if (vehicle.privacyCallEnabled) pills.push(channelPill("privacy_call", true));
  else if (vehicle.global?.directCall) pills.push(channelPill("direct_call", true));

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
      <h2>通知方式</h2>
      <div class="channels" style="margin-bottom:14px">
        ${pills.length ? pills.join("") : `<span class="pill off"><span class="dot"></span>平台暂未开通任何通知方式</span>`}
      </div>
      <div class="grid-form">
        ${ownerChannelFields(vehicle)}
      </div>
      <p class="form-note">仅展示平台已开通的通知方式；仅提交你实际改动过的字段，留空的密钥类字段保持原值。</p>
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

  // 更换手机号 → 先做身份验证（短信验证码 / 管理密码）
  function requestPhoneVerification(vehicle) {
    return new Promise((resolve) => {
      const smsOk = Boolean(vehicle.global?.sms);
      let method = smsOk ? "sms" : "pin";
      openModal({
        title: "验证身份以更换手机号",
        body: `<div class="grid-form" style="margin-top:6px">
          <p class="field-hint" style="grid-column:1/-1">更换绑定手机号需要验证身份，请选择验证方式：</p>
          <div class="span-2" style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm ${smsOk ? "btn-primary" : "btn-ghost"}" id="pvTabSms" ${smsOk ? "" : "disabled"}>短信验证码</button>
            <button type="button" class="btn btn-sm ${smsOk ? "btn-ghost" : "btn-primary"}" id="pvTabPin" ${vehicle.hasPin ? "" : "disabled"}>管理密码</button>
          </div>
          ${smsOk ? "" : `<p class="field-hint" style="grid-column:1/-1">平台未开通短信通道，只能使用管理密码验证。</p>`}
          ${vehicle.hasPin ? "" : `<p class="field-hint" style="grid-column:1/-1">未设置管理密码，只能使用短信验证码。</p>`}
          <label class="span-2" id="pvLabel">短信验证码
            <div style="display:flex;gap:8px">
              <input id="pvInput" inputmode="numeric" placeholder="6 位验证码" style="flex:1" />
              <button type="button" class="btn btn-sm" id="pvSend" style="white-space:nowrap">发送验证码</button>
            </div>
          </label>
        </div>`,
        confirmText: "验证并保存",
        onOpen: () => {
          const input = $("#pvInput");
          const label = $("#pvLabel");
          const sendBtn = $("#pvSend");
          const tabSms = $("#pvTabSms");
          const tabPin = $("#pvTabPin");
          const apply = () => {
            const isSms = method === "sms";
            if (label) label.childNodes[0].nodeValue = isSms ? "短信验证码" : "管理密码";
            if (input) { input.placeholder = isSms ? "6 位验证码" : "管理密码"; input.value = ""; input.type = isSms ? "text" : "password"; }
            if (sendBtn) sendBtn.classList.toggle("hidden", !isSms);
            tabSms?.classList.toggle("btn-primary", isSms);
            tabSms?.classList.toggle("btn-ghost", !isSms);
            tabPin?.classList.toggle("btn-primary", !isSms);
            tabPin?.classList.toggle("btn-ghost", isSms);
          };
          tabSms?.addEventListener("click", () => { if (!smsOk) return; method = "sms"; apply(); });
          tabPin?.addEventListener("click", () => { if (!vehicle.hasPin) return; method = "pin"; apply(); });
          sendBtn?.addEventListener("click", async () => {
            sendBtn.disabled = true;
            try {
              const r = await api.sendPhoneVerifyCode(ownerToken);
              toast(r.message || "验证码已发送", "ok");
            } catch (err) {
              toast(err.message || "发送失败", "err");
            } finally {
              sendBtn.disabled = false;
            }
          });
          apply();
        },
        onConfirm: () => resolve({ method, value: ($("#pvInput")?.value || "").trim() }),
        onCancel: () => resolve(null),
      });
    });
  }

  // 隐私拨号 ↔ 直拨 状态联动
  const privacyBox = $("#f_privacy", mount);
  if (privacyBox) {
    privacyBox.addEventListener("change", () => {
      const privacy = privacyBox.checked;
      const row = $("#f_directRow", mount);
      const state = $("#f_directState", mount);
      const desc = $("#f_directDesc", mount);
      row?.classList.toggle("is-off", privacy);
      if (state) {
        state.className = `pill ${privacy ? "off" : "ok"}`;
        state.innerHTML = `<span class="dot"></span>${privacy ? "已关闭" : "使用中"}`;
      }
      if (desc) desc.textContent = privacy
        ? "已由「隐私拨号」接管，访客通过隐私号接通"
        : "访客直接拨打你的手机号；开启隐私拨号后自动关闭";
    });
  }

  $("#saveChannels", mount).onclick = async () => {
    // 未开通的通道字段不会渲染，取值时做空值兜底
    const chk = (id) => ($(`#${id}`, mount) ? $("#" + id, mount).checked : false);
    const txt = (id) => ($(`#${id}`, mount) ? $("#" + id, mount).value.trim() : "");
    const phone = normalizePhone(txt("f_phone"));
    const openid = txt("f_openid");
    const sms = chk("f_sms");
    const privacy = chk("f_privacy");
    const notifyAll = chk("f_notify_all");

    // 只提交「实际改动过」的开关与手机号
    const patch = {};
    if (notifyAll !== Boolean(vehicle.notifyAllEnabled)) patch.notifyAllEnabled = notifyAll;
    if (sms !== Boolean(vehicle.smsEnabled)) patch.smsEnabled = sms;
    if (privacy !== Boolean(vehicle.privacyCallEnabled)) patch.privacyCallEnabled = privacy;
    if (openid) patch.wechatOpenid = openid;
    if (phone) patch.ownerPhone = phone;

    if (!Object.keys(patch).length) return toast("没有需要保存的改动", "");

    const willSms = "smsEnabled" in patch ? patch.smsEnabled : Boolean(vehicle.smsEnabled);
    const willPrivacy = "privacyCallEnabled" in patch ? patch.privacyCallEnabled : Boolean(vehicle.privacyCallEnabled);
    if ((willSms || willPrivacy) && !phone && !vehicle.hasPhone) {
      return toast("开启短信 / 隐私拨号需填写手机号", "err");
    }
    // 换号必验证：短信验证码 或 管理密码
    if (phone) {
      const v = await requestPhoneVerification(vehicle);
      if (!v) return; // 用户取消
      if (!v.value) return toast(v.method === "sms" ? "请输入短信验证码" : "请输入管理密码", "err");
      if (v.method === "sms") patch.phoneVerify = { method: "sms", code: v.value };
      else patch.phoneVerify = { method: "pin", pin: v.value };
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
// 通道分组兜底（正常由后端 /api/admin/config 返回 groups）
const CHANNEL_GROUPS_FALLBACK = [
  { key: "wechat_work", label: "企业微信机器人", icon: "💬" },
  { key: "wechat", label: "微信通知（公众号模板消息）", icon: "📨" },
  { key: "sms", label: "短信通知", icon: "📱" },
  { key: "privacy_call", label: "隐私拨号", icon: "☎️" },
  { key: "direct_call", label: "直拨（默认回退）", icon: "📞" },
];

/* ---------------- 统一通知配置面板渲染 ---------------- */
// 按「通道分组」渲染：每通道一个开关 + 服务商下拉 + 条件显示的字段
function renderChannelConfig(settings, groups, status = {}, enabled = {}, missing = {}) {
  const byKey = Object.fromEntries((settings || []).map((s) => [s.key, s]));
  const valOf = (key) => String(byKey[key]?.value ?? "").trim();

  const fieldHtml = (s) => {
    const wrap = (inner, extraAttrs = "") =>
      `<label class="span-2 cfg-field" ${extraAttrs}>${inner}</label>`;
    if (s.type === "bool") {
      const on = valOf(s.key) !== "false";
      return `<div class="switch-row span-2 cfg-field" data-cfg-switch="${escapeHtml(s.key)}">
        <div class="meta"><b>${escapeHtml(s.label)}</b><span class="cfg-state">${on ? "已开通" : "已关闭"}</span></div>
        <label class="switch"><input type="checkbox" data-cfg="${escapeHtml(s.key)}" data-bool="1" ${on ? "checked" : ""}><span class="track"></span><span class="thumb"></span></label>
      </div>`;
    }
    if (s.type === "select") {
      const opts = (s.options || []).map(
        (o) => `<option value="${escapeHtml(o.value)}" ${valOf(s.key) === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`
      ).join("");
      return wrap(`${escapeHtml(s.label)}<select data-cfg="${escapeHtml(s.key)}">${opts}</select>`, depAttrs(s));
    }
    return wrap(
      `${escapeHtml(s.label)}
       <input data-cfg="${escapeHtml(s.key)}" value="${escapeHtml(s.value || "")}" ${s.secret ? "autocomplete=\"off\"" : ""} />
       ${s.secret ? `<span class="field-hint">敏感字段，${MASKED} 表示已设置，留空则保持不变</span>` : ""}`,
      depAttrs(s)
    );
  };

  const depAttrs = (s) =>
    s.showIf ? `data-dep="${escapeHtml(s.showIf.key)}" data-dep-in="${escapeHtml((s.showIf.in || []).join("|"))}"` : "";

  const groupHtml = (grp) => {
    const items = (settings || []).filter((s) => (s.group || "other") === grp.key && s.type !== "bool");
    const bools = (settings || []).filter((s) => (s.group || "other") === grp.key && s.type === "bool");
    const opened = Boolean(status[grp.key]);
    const on = enabled[grp.key] === undefined ? opened : Boolean(enabled[grp.key]);
    const miss = missing[grp.key] || [];
    // 开关已开但还缺参数 → 明确告诉管理员「还缺什么」，避免「开了开关前台却没有」
    const badge = opened
      ? `<span class="pill ok"><span class="dot"></span>已开通</span>`
      : (on && miss.length
          ? `<span class="pill warn"><span class="dot"></span>缺参数</span>`
          : `<span class="pill off"><span class="dot"></span>未开通</span>`);
    const missLine = (!opened && on && miss.length)
      ? `<div class="cfg-missing">开关已打开，但要生效还需填写：<b>${miss.map((m) => escapeHtml(m)).join("、")}</b></div>`
      : (!opened && !on ? `<div class="cfg-missing muted-line">通道已关闭，前台不会显示该通知方式</div>` : "");
    return `<div class="chan-card ${opened ? "on" : "off"}">
      <div class="chan-head">
        <span class="chan-ic">${escapeHtml(grp.icon || "🔔")}</span>
        <div class="chan-meta">
          <b>${escapeHtml(grp.label)}</b>
          <span class="field-hint">${CHANNEL_HINTS[grp.key] || ""}</span>
        </div>
        ${badge}
      </div>
      ${missLine}
      <div class="grid-form">
        ${bools.map(fieldHtml).join("")}
        ${items.map(fieldHtml).join("")}
      </div>
    </div>`;
  };

  const otherGroup = (settings || []).filter((s) => (s.group || "other") === "other");
  return (
    groups.map(groupHtml).join("") +
    (otherGroup.length
      ? `<div class="chan-card">
           <div class="chan-head"><span class="chan-ic">⚙️</span><div class="chan-meta"><b>其他设置</b><span class="field-hint">OCR 与号码格式等</span></div></div>
           <div class="grid-form">${otherGroup.map(fieldHtml).join("")}</div>
         </div>`
      : "")
  );
}

const CHANNEL_HINTS = {
  wechat_work: "超管统一配置企微机器人 Webhook；车主侧仅一个开关",
  wechat: "调用公众号模板消息接口（AppID + AppSecret + 模板ID），非 Webhook",
  sms: "支持腾讯云 / 阿里云 / 自定义 Webhook 三家服务商",
  privacy_call: "支持自定义 Webhook / 腾讯云号码保护 / 阿里云号码保护",
  direct_call: "隐私拨号未开启时的默认方式：访客直接拨打车主真实号码",
};

// 服务商下拉联动：只显示当前服务商需要的字段
function syncConfigVisibility(form) {
  if (!form) return;
  $$("[data-dep]", form).forEach((el) => {
    const key = el.dataset.dep;
    const allowed = (el.dataset.depIn || "").split("|");
    const cur = ($(`[data-cfg="${key}"]`, form)?.value ?? "").trim();
    el.classList.toggle("hidden", !allowed.includes(cur));
  });
  $$("[data-cfg-switch]", form).forEach((row) => {
    const box = $("[data-bool]", row);
    const state = $(".cfg-state", row);
    if (!box || !state) return;
    const on = box.checked;
    state.textContent = on ? "已开通" : "已关闭";
    row.closest(".chan-card")?.classList.toggle("on", on);
    row.closest(".chan-card")?.classList.toggle("off", !on);
  });
}
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
  let channelGroups = CHANNEL_GROUPS_FALLBACK;
  let channelStatus = {};
  let channelEnabled = {};
  let channelMissing = {};
  try {
    const [r, adsRes] = await Promise.all([
      api.adminGetConfig(token),
      api.adminListAds(token).catch(() => ({ positions: [], ads: [] })),
    ]);
    settings = r.settings || [];
    channelGroups = (r.groups && r.groups.length) ? r.groups : CHANNEL_GROUPS_FALLBACK;
    channelStatus = r.channelStatus || {};
    channelEnabled = r.channelEnabled || {};
    channelMissing = r.channelMissing || {};
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
  <div class="fade-in">
    <section class="card admin-topbar" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div><h2 style="margin:0">🛡️ 超级管理员控制台</h2><p class="muted" style="margin:4px 0 0">按标签页分区管理，告别单页堆叠</p></div>
      <div class="actions row" style="margin:0;gap:8px">
        <button class="btn btn-sm btn-ghost" id="adChangePwd">修改我的密码</button>
        <button class="btn btn-sm btn-ghost" id="adLogout">退出登录</button>
      </div>
    </section>

    <nav class="admin-tabs" id="adminTabs">
      <button type="button" class="admin-tab active" data-tab="vehicles">🚗 车牌管理</button>
      <button type="button" class="admin-tab" data-tab="qr">📱 二维码</button>
      <button type="button" class="admin-tab" data-tab="channels">🔔 通知渠道</button>
      <button type="button" class="admin-tab" data-tab="lookup">🔍 查车主电话</button>
      <button type="button" class="admin-tab" data-tab="calls">📞 拨号日志</button>
      <button type="button" class="admin-tab" data-tab="ads">🖼️ 广告位</button>
      <button type="button" class="admin-tab" data-tab="account">👤 账号管理</button>
    </nav>

    <!-- 车牌管理 -->
    <div class="admin-tab-panel" data-panel="vehicles">
    <section class="card">
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
        <p class="field-hint" style="margin-top:8px">支持 CSV 与 JSON。CSV 表头顺序：<b>车牌号,查看密码,手机号,短信通知,隐私拨号,一键通知,微信OpenID</b>（表头行可省略；开关填「是/否」；未开启任何方式则为「直拨」）。重复车牌会自动跳过，不会覆盖已有绑定。</p>
      </details>
    </section>
    </div>

    <!-- 预生成二维码 -->
    <div class="admin-tab-panel hidden" data-panel="qr">
    <section class="card">
      <h2>📱 二维码批量生成</h2>
      <p class="muted">批量出码 → 打印贴到车上 → 车主扫码绑定 → 绑定后任何人再扫都进入挪车界面。未绑定的码被扫到时会提示车主先绑定。</p>

      <div class="qr-stats" id="qrStats"></div>

      <form id="qrBatchForm" class="grid-form" style="margin-top:12px">
        <label>生成数量（1-200）
          <input id="qrCount" type="number" min="1" max="200" value="20" />
        </label>
        <label>批次号（可选）
          <input id="qrBatchNo" placeholder="留空自动按日期生成" />
        </label>
        <label class="span-2">备注（可选）
          <input id="qrNote" placeholder="如：第 1 批贴纸" />
        </label>
        <button type="submit" class="btn btn-primary span-2">批量生成二维码</button>
      </form>
      <div id="qrBatchResult" class="result hidden" style="margin-top:10px"></div>

      <div id="qrBatchPreviewWrap" class="hidden" style="margin-top:16px">
        <div class="qr-preview-head">
          <b>本批二维码</b><span class="muted" id="qrBatchPreviewMeta"></span>
        </div>
        <div class="row-actions" style="margin-top:8px">
          <button type="button" class="btn btn-sm btn-primary" id="qrPrint">🖨️ 打印本批</button>
          <button type="button" class="btn btn-sm btn-ghost" id="qrDownloadCsv">导出链接 CSV</button>
        </div>
        <div id="qrBatchGrid" class="qr-grid"></div>
      </div>
    </section>

    <section class="card">
      <h2>二维码列表</h2>
      <div class="grid-form" style="margin-top:8px">
        <label>状态
          <select id="qrStatus">
            <option value="">全部</option>
            <option value="unbound">未绑定</option>
            <option value="bound">已绑定</option>
            <option value="disabled">已停用</option>
          </select>
        </label>
        <label>批次
          <select id="qrBatchFilter"><option value="">全部</option></select>
        </label>
        <label class="span-2">搜索
          <input id="qrSearch" placeholder="令牌 / 批次 / 备注 / 车牌" />
        </label>
      </div>
      <div class="row-actions" style="margin-top:10px">
        <button class="btn btn-sm btn-primary" id="qrSearchBtn">查询</button>
        <button class="btn btn-sm btn-ghost" id="qrResetBtn">重置</button>
        <button class="btn btn-sm btn-danger" id="qrDeleteSel">删除所选（未绑定）</button>
      </div>
      <div id="qrListBox" style="margin-top:12px"><p class="muted">正在加载…</p></div>
      <div id="qrListResult" class="result hidden" style="margin-top:10px"></div>
    </section>
    </div>

    <!-- 统一通知通道配置 -->
    <div class="admin-tab-panel hidden" data-panel="channels">
    <section class="card">
      <h2>🔔 通知渠道</h2>
      <p class="muted">所有通知接口都在这里配置与开关。<b>开关打开 + 参数齐全</b>才算「已开通」，前台（创建页 / 车主后台 / 访客页）只显示已开通的通道。密钥字段显示为 ${MASKED}，保持不变即可，填写新值才会覆盖。</p>
      <form id="adminConfigForm">
        <div id="adminChannelConfigHost">${renderChannelConfig(settings, channelGroups, channelStatus, channelEnabled, channelMissing)}</div>
        <div class="actions row">
          <button type="submit" class="btn btn-primary">保存通知配置</button>
        </div>
        <div id="adminCfgResult" class="result hidden" style="margin-top:10px"></div>
      </form>
    </section>
    </div>

    <!-- 车牌查手机号 -->
    <div class="admin-tab-panel hidden" data-panel="lookup">
    <section class="card">
      <h2>🔍 按车牌查车主电话</h2>
      <p class="muted">通知无法送达时，用于人工联系车主。查询行为仅限管理员账号。</p>
      <form id="adminLookupForm" class="grid-form" style="margin-top:12px">
        <label class="span-2">车牌号
          <input id="lkPlate" placeholder="例如 粤A12345" autocomplete="off" />
          <div id="lkPlateHost" class="plate-input-host"></div>
        </label>
        <button type="submit" class="btn btn-primary span-2">查询</button>
      </form>
      <div id="adminLookupResult" class="result hidden" style="margin-top:12px"></div>
    </section>
    </div>

    <!-- 拨号日志 -->
    <div class="admin-tab-panel hidden" data-panel="calls">
    <section class="card">
      <h2>📞 拨号日志</h2>
      <p class="muted">隐私拨号与直拨都会记录（含拨号方 / 被叫 / 隐私中间号）。支持按条件筛选、批量导出与批量删除。</p>

      <div class="grid-form" id="clFilterForm" style="margin-top:12px">
        <label>车牌（模糊）
          <input id="clQ" placeholder="如 粤B 或 完整车牌" />
        </label>
        <label>号码后 4 位
          <input id="clLast4" placeholder="如 5678" inputmode="numeric" />
        </label>
        <label>拨号方式
          <select id="clChannel">
            <option value="">全部</option>
            <option value="privacy_call">隐私拨号</option>
            <option value="direct_call">直拨</option>
          </select>
        </label>
        <label>状态
          <select id="clStatus">
            <option value="">全部</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
          </select>
        </label>
        <label>开始日期
          <input id="clFrom" type="date" />
        </label>
        <label>结束日期
          <input id="clTo" type="date" />
        </label>
      </div>
      <div class="row-actions" style="margin-top:10px">
        <button class="btn btn-sm btn-primary" id="clSearch">查询</button>
        <button class="btn btn-sm btn-ghost" id="clReset">重置</button>
        <button class="btn btn-sm btn-ghost" id="clExport">导出筛选结果 CSV</button>
        <button class="btn btn-sm btn-ghost" id="clExportAll">导出全部 CSV</button>
        <button class="btn btn-sm btn-danger" id="clDeleteSel">删除所选</button>
        <button class="btn btn-sm btn-danger" id="clDeleteFiltered">按筛选条件清空</button>
      </div>
      <div class="row-actions" style="margin-top:8px">
        <label class="switch" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="clSelectAll" /><span class="track"></span><span class="thumb"></span>
          <span class="muted" style="font-size:13px">全选本页</span>
        </label>
        <span class="muted" id="clCount" style="font-size:13px"></span>
      </div>
      <div id="clListBox" style="margin-top:12px"><p class="muted">正在加载…</p></div>
      <div id="clResult" class="result hidden" style="margin-top:10px"></div>
    </section>
    </div>

    <!-- 广告位管理 -->
    <div class="admin-tab-panel hidden" data-panel="ads">
    <section class="card">
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
    </div>

    <!-- 管理员账号 -->
    <div class="admin-tab-panel hidden" data-panel="account">
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
    </div>
  </div>`;

  // 标签页切换（一次只显示一个区块，避免单页堆叠）
  $$(".admin-tab", mount).forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      $$(".admin-tab", mount).forEach((b) => b.classList.toggle("active", b === btn));
      $$(".admin-tab-panel", mount).forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab));
      try { localStorage.setItem("adminTab", tab); } catch {}
    });
  });
  try {
    const last = localStorage.getItem("adminTab");
    if (last) $(`.admin-tab[data-tab="${last}"]`, mount)?.click();
  } catch {}

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
      const rows = [["车牌号", "查看密码", "手机号", "短信通知", "隐私拨号", "一键通知", "微信OpenID", "绑定ID", "创建时间"]];
      list.forEach((v) => rows.push([
        v.plateNumber, "", v.ownerPhone,
        v.smsEnabled ? "是" : "否", v.privacyCallEnabled ? "是" : "否",
        v.notifyAllEnabled ? "是" : "否", v.wechatOpenid || "", v.id, fmtDate(v.createdAt),
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
  const cfgForm = $("#adminConfigForm", mount);
  syncConfigVisibility(cfgForm); // 初始：按当前服务商显示对应字段
  cfgForm.addEventListener("change", () => syncConfigVisibility(cfgForm));
  cfgForm.addEventListener("submit", async (e) => {
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
      showResult(result, "✅ 通知配置已保存，立即对所有车主生效（前台会自动同步）。");
      toast("通知配置已保存", "ok");
      // 用后端最新状态重渲染通道卡片（开通状态 / 还缺哪些参数 均由后端计算）
      try {
        const fresh = await api.adminGetConfig(token);
        settings = fresh.settings || settings;
        channelGroups = (fresh.groups && fresh.groups.length) ? fresh.groups : channelGroups;
        channelStatus = fresh.channelStatus || {};
        channelEnabled = fresh.channelEnabled || {};
        channelMissing = fresh.channelMissing || {};
        const host = $("#adminChannelConfigHost", mount);
        if (host) host.innerHTML = renderChannelConfig(settings, channelGroups, channelStatus, channelEnabled, channelMissing);
        syncConfigVisibility(cfgForm);
      } catch {}
    } catch (err) {
      if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
      showResult(result, escapeHtml(err.message || "保存失败"), true);
    }
  });

  // 预生成二维码
  setupAdminQrCodes(token, mount);

  // 拨号日志
  setupCallLogs(token, mount);

  // 车牌查询
  const lkPlateInput = createPlateInput($("#lkPlateHost", mount), { input: $("#lkPlate", mount), allowTypeSwitch: true });
  $("#adminLookupForm", mount).addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = $("#adminLookupResult", mount);
    const lkPlate = normalizePlate($("#lkPlate", mount)?.value ?? "");
    if (lkPlateInput && !lkPlateInput.isValid()) { showResult(result, "请点选完整车牌（普通 7 位 / 新能源 8 位）。", true); return; }
    showResult(result, "正在查询…");
    try {
      const r = await api.adminLookup(token, lkPlate);
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
          ${channelPill("notify_all", Boolean(v.notifyAllEnabled))}
          ${channelPill("sms", Boolean(v.smsEnabled))}
          ${v.privacyCallEnabled ? channelPill("privacy_call", true) : channelPill("direct_call", true)}
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

/* ---------------- 拨号日志（后台） ---------------- */
const CALL_CHANNEL_LABELS = { privacy_call: "隐私拨号", direct_call: "直拨" };

function collectCallLogFilters(mount) {
  const v = (id) => ($(`#${id}`, mount)?.value ?? "").trim();
  const params = {};
  if (v("clQ")) params.q = v("clQ");
  if (v("clLast4")) params.last4 = v("clLast4");
  if (v("clChannel")) params.channel = v("clChannel");
  if (v("clStatus")) params.status = v("clStatus");
  if (v("clFrom")) params.from = v("clFrom");
  if (v("clTo")) params.to = v("clTo");
  return params;
}

async function reloadCallLogs(token, mount) {
  const box = $("#clListBox", mount);
  const result = $("#clResult", mount);
  const count = $("#clCount", mount);
  if (box) box.innerHTML = `<p class="muted">正在加载…</p>`;
  const filters = collectCallLogFilters(mount);
  try {
    const r = await api.adminListCallLogs(token, { ...filters, limit: 100 });
    renderCallLogs(token, mount, r.logs || [], r.total || 0);
    if (count) count.textContent = `共 ${r.total || 0} 条` + (Object.keys(filters).length ? "（已筛选）" : "");
  } catch (err) {
    if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
    if (box) box.innerHTML = `<p class="muted">${escapeHtml(err.message || "加载失败")}</p>`;
  }
}

function renderCallLogs(token, mount, logs, total) {
  const box = $("#clListBox", mount);
  if (!box) return;
  if (!logs.length) {
    box.innerHTML = `<p class="muted">没有符合条件的拨号记录。</p>`;
    return;
  }
  box.innerHTML = `<div class="log-list">` + logs.map((l) => `
      <div class="log-item" style="flex-wrap:wrap;align-items:flex-start;gap:8px">
        <label class="switch" style="flex:none"><input type="checkbox" data-cl-id="${l.id}" /><span class="track"></span><span class="thumb"></span></label>
        <div style="flex:1;min-width:180px">
          <div class="ch" style="font-size:15px">${escapeHtml(l.plateNumber || l.maskedPlate || "-")} · ${escapeHtml(CALL_CHANNEL_LABELS[l.channel] || l.channel)}</div>
          <div class="t">拨号方：${l.callerNumber ? escapeHtml(l.callerNumber) : "<span class='muted'>未提供</span>"}</div>
          <div class="t">被叫（车主）：${l.calleeNumber ? escapeHtml(l.calleeNumber) : "-"}${l.virtualNumber ? ` · 中间号：${escapeHtml(l.virtualNumber)}` : ""}</div>
          <div class="t">${escapeHtml(fmtDate(l.createdAt))}${l.errorSummary ? ` · ${escapeHtml(l.errorSummary)}` : ""}</div>
        </div>
        <span class="pill ${l.status === "success" ? "ok" : "err"}"><span class="dot"></span>${l.status === "success" ? "成功" : "失败"}</span>
      </div>`).join("") + `</div>`;

  const selAll = $("#clSelectAll", mount);
  if (selAll) {
    selAll.checked = false;
    selAll.onchange = () => $$("[data-cl-id]", box).forEach((c) => (c.checked = selAll.checked));
  }
}

function selectedCallLogIds(mount) {
  return $$("[data-cl-id]", mount).filter((c) => c.checked).map((c) => Number(c.dataset.clId));
}

function setupCallLogs(token, mount) {
  const result = $("#clResult", mount);
  const search = () => reloadCallLogs(token, mount);
  $("#clSearch", mount).onclick = search;
  $("#clReset", mount).onclick = () => {
    ["clQ", "clLast4", "clChannel", "clStatus", "clFrom", "clTo"].forEach((id) => { const el = $(`#${id}`, mount); if (el) el.value = ""; });
    search();
  };

  const downloadCsv = async (all) => {
    showResult(result, "正在导出…");
    try {
      const filters = all ? {} : collectCallLogFilters(mount);
      const r = await api.adminExportCallLogs(token, filters);
      const list = r.logs || [];
      const rows = [["日志ID", "车牌号", "拨号方式", "拨号方号码", "被叫车主号码", "隐私中间号", "状态", "失败原因", "时间"]];
      list.forEach((l) => rows.push([
        l.id, l.plateNumber || l.maskedPlate || "", CALL_CHANNEL_LABELS[l.channel] || l.channel,
        l.callerNumber || "", l.calleeNumber || "", l.virtualNumber || "",
        l.status === "success" ? "成功" : "失败", l.errorSummary || "", fmtDate(l.createdAt),
      ]));
      const csv = rows.map((cells) => cells.map((c) => {
        const s = String(c ?? "");
        return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
      }).join(",")).join("\r\n");
      downloadFile(`move-car-call-logs-${new Date().toISOString().slice(0, 10)}.csv`, "\ufeff" + csv);
      showResult(result, `✅ 已导出 ${list.length} 条拨号日志。`);
      toast("已导出", "ok");
    } catch (err) {
      if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
      showResult(result, escapeHtml(err.message || "导出失败"), true);
    }
  };
  $("#clExport", mount).onclick = () => downloadCsv(false);
  $("#clExportAll", mount).onclick = () => downloadCsv(true);

  $("#clDeleteSel", mount).onclick = async () => {
    const ids = selectedCallLogIds(mount);
    if (!ids.length) return toast("请先勾选要删除的日志", "err");
    openModal({
      title: "删除所选拨号日志？",
      body: `将删除 <b>${ids.length}</b> 条拨号记录，删除后不可恢复。`,
      confirmText: "确认删除",
      danger: true,
      onConfirm: async () => {
        try {
          const r = await api.adminBulkDeleteCallLogs(token, {}, { ids });
          toast(r.message || "已删除", "ok");
          await reloadCallLogs(token, mount);
        } catch (err) { toast(err.message || "删除失败", "err"); }
      },
    });
  };

  $("#clDeleteFiltered", mount).onclick = () => {
    const filters = collectCallLogFilters(mount);
    if (!Object.keys(filters).length) return toast("请先设置筛选条件，避免误删全部日志", "err");
    openModal({
      title: "按筛选条件清空日志？",
      body: `将删除符合当前筛选条件的<b>全部</b>拨号记录（不只是本页），删除后不可恢复。<br/><span class="muted">条件：${escapeHtml(JSON.stringify(filters))}</span>`,
      confirmText: "确认清空",
      danger: true,
      onConfirm: async () => {
        try {
          const r = await api.adminBulkDeleteCallLogs(token, filters, { all: true });
          toast(r.message || "已删除", "ok");
          await reloadCallLogs(token, mount);
        } catch (err) { toast(err.message || "删除失败", "err"); }
      },
    });
  };

  reloadCallLogs(token, mount);
}

/* ---------------- 预生成二维码（后台） ---------------- */
const QR_STATUS_LABEL = { unbound: "未绑定", bound: "已绑定", disabled: "已停用" };

function printQrCodes(codes, batchNo) {
  const w = window.open("", "_blank");
  if (!w) return toast("浏览器拦截了打印窗口，请允许弹窗后重试", "err");
  const items = codes
    .map((c, i) => `<div class="p-item">
      <img src="${qrImageUrl(buildQrUrl(c.codeToken), 240)}" alt="挪车二维码" />
      <div class="p-title">扫码绑定 · 挪车码</div>
      <div class="p-no">${escapeHtml(batchNo || c.batchNo || "")} · ${String(i + 1).padStart(3, "0")}</div>
    </div>`)
    .join("");
  w.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>挪车二维码 ${escapeHtml(batchNo || "")}</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 10px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .p-item { border: 1px dashed #cbd5e1; border-radius: 10px; padding: 10px 6px; text-align: center; page-break-inside: avoid; }
  .p-item img { width: 100%; max-width: 200px; height: auto; }
  .p-title { font-size: 13px; font-weight: 700; color: #16a34a; margin-top: 4px; }
  .p-no { font-size: 11px; color: #64748b; }
</style></head>
<body><div class="grid">${items}</div>
<script>window.onload=function(){setTimeout(function(){window.print();},500);};<\/script>
</body></html>`);
  w.document.close();
  return undefined;
}

function setupAdminQrCodes(token, mount) {
  const statsEl = $("#qrStats", mount);
  const listBox = $("#qrListBox", mount);
  const listResult = $("#qrListResult", mount);
  const batchResult = $("#qrBatchResult", mount);
  const gridEl = $("#qrBatchGrid", mount);
  const previewWrap = $("#qrBatchPreviewWrap", mount);
  const previewMeta = $("#qrBatchPreviewMeta", mount);
  if (!statsEl || !listBox) return;

  const filter = { status: "", batch: "", q: "" };
  let lastBatch = [];
  let lastBatchNo = "";
  const selected = new Set();

  const pill = (s) =>
    `<span class="pill ${s === "bound" ? "ok" : s === "disabled" ? "off" : "warn"}"><span class="dot"></span>${QR_STATUS_LABEL[s] || s}</span>`;

  const renderStats = (stats = {}) => {
    statsEl.innerHTML = `
      <div class="qr-stat"><b>${stats.total || 0}</b><span>总数</span></div>
      <div class="qr-stat"><b>${stats.unbound || 0}</b><span>未绑定</span></div>
      <div class="qr-stat"><b>${stats.bound || 0}</b><span>已绑定</span></div>
      <div class="qr-stat"><b>${stats.disabled || 0}</b><span>已停用</span></div>`;
  };

  const renderList = () => {
    const rows = listBox.__codes || [];
    if (!rows.length) {
      listBox.innerHTML = `<p class="muted">没有符合条件的二维码。</p>`;
      return;
    }
    listBox.innerHTML = `<div class="qr-list">` +
      rows
        .map(
          (c) => `<div class="qr-row">
            <label class="qr-check"><input type="checkbox" data-qr-sel="${c.id}" ${c.status === "bound" ? "disabled" : ""} ${selected.has(c.id) ? "checked" : ""}></label>
            <img class="qr-thumb" src="${qrImageUrl(buildQrUrl(c.codeToken), 120)}" alt="二维码" loading="lazy" />
            <div class="qr-meta">
              <div class="qr-line1">${pill(c.status)} <span class="muted">#${c.id}</span> ${c.maskedPlate ? `<span class="pill ok"><span class="dot"></span>${escapeHtml(c.maskedPlate)}</span>` : ""}</div>
              <div class="t muted" style="font-size:12px">批次 ${escapeHtml(c.batchNo || "-")}${c.note ? ` · ${escapeHtml(c.note)}` : ""}</div>
              <div class="t muted" style="font-size:11px;word-break:break-all">${escapeHtml(c.codeToken)}</div>
            </div>
            <div class="qr-actions">
              ${c.status === "unbound" ? `<button class="btn btn-xs btn-ghost" data-qr-disable="${c.id}">停用</button>` : ""}
              ${c.status === "disabled" ? `<button class="btn btn-xs btn-ghost" data-qr-enable="${c.id}">启用</button>` : ""}
              ${c.status !== "bound" ? `<button class="btn btn-xs btn-danger" data-qr-del="${c.id}">删除</button>` : ""}
            </div>
          </div>`
        )
        .join("") +
      `</div>`;

    $$("[data-qr-sel]", listBox).forEach((box) =>
      box.addEventListener("change", () => {
        const id = Number(box.dataset.qrSel);
        box.checked ? selected.add(id) : selected.delete(id);
      })
    );
    $$("[data-qr-disable]", listBox).forEach((btn) =>
      btn.addEventListener("click", () => setStatus(Number(btn.dataset.qrDisable), "disabled"))
    );
    $$("[data-qr-enable]", listBox).forEach((btn) =>
      btn.addEventListener("click", () => setStatus(Number(btn.dataset.qrEnable), "unbound"))
    );
    $$("[data-qr-del]", listBox).forEach((btn) =>
      btn.addEventListener("click", () => removeOne(Number(btn.dataset.qrDel)))
    );
  };

  const renderBatchOptions = (batches) => {
    const sel = $("#qrBatchFilter", mount);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">全部</option>` +
      (batches || []).map((b) => `<option value="${escapeHtml(b.batchNo)}">${escapeHtml(b.batchNo)}（${b.count}）</option>`).join("");
    if (cur) sel.value = cur;
  };

  async function reload() {
    listBox.innerHTML = `<p class="muted">正在加载…</p>`;
    try {
      const r = await api.adminListQrCodes(token, { ...filter, limit: 200 });
      listBox.__codes = r.codes || [];
      listBox.dataset.loaded = "1";
      selected.clear();
      renderStats(r.stats || {});
      renderBatchOptions(r.batches || []);
      renderList();
    } catch (err) {
      if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
      listBox.innerHTML = `<p class="muted">加载失败：${escapeHtml(err.message || "")}</p>`;
    }
  }

  async function setStatus(id, status) {
    try {
      const r = await api.adminUpdateQrCode(token, id, { status });
      toast(r.message || "已更新", "ok");
      await reload();
    } catch (err) { toast(err.message || "操作失败", "err"); }
  }

  async function removeOne(id) {
    try {
      await api.adminDeleteQrCode(token, id);
      toast("已删除", "ok");
      await reload();
    } catch (err) { toast(err.message || "删除失败", "err"); }
  }

  // 批量生成
  $("#qrBatchForm", mount)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const count = Number($("#qrCount", mount).value) || 0;
    if (count < 1 || count > 200) return toast("生成数量需在 1-200 之间", "err");
    showResult(batchResult, "正在生成…");
    try {
      const r = await api.adminBatchQrCodes(token, {
        count,
        batchNo: $("#qrBatchNo", mount).value.trim(),
        note: $("#qrNote", mount).value.trim(),
      });
      lastBatch = (r.codes || []).map((t) => ({ codeToken: t }));
      lastBatchNo = r.batchNo || "";
      previewWrap.classList.remove("hidden");
      previewMeta.textContent = `批次 ${lastBatchNo} · 共 ${lastBatch.length} 个`;
      gridEl.innerHTML = lastBatch
        .map(
          (c, i) => `<div class="qr-card">
            <img src="${qrImageUrl(buildQrUrl(c.codeToken), 200)}" alt="二维码" />
            <div class="qr-card-no">${String(i + 1).padStart(3, "0")}</div>
          </div>`
        )
        .join("");
      showResult(batchResult, `✅ ${escapeHtml(r.message || "已生成")} 可点击下方「打印本批」直接打印贴纸。`);
      toast("二维码已生成", "ok");
      await reload();
    } catch (err) {
      if (err.status === 401) { clearAdminToken(); renderAdminLogin(); return; }
      showResult(batchResult, escapeHtml(err.message || "生成失败"), true);
    }
  });

  $("#qrPrint", mount)?.addEventListener("click", () => {
    if (!lastBatch.length) return toast("请先生成二维码", "err");
    printQrCodes(lastBatch, lastBatchNo);
  });

  $("#qrDownloadCsv", mount)?.addEventListener("click", () => {
    if (!lastBatch.length) return toast("请先生成二维码", "err");
    const rows = [["序号", "批次", "二维码链接"]];
    lastBatch.forEach((c, i) => rows.push([String(i + 1), lastBatchNo, buildQrUrl(c.codeToken)]));
    const csv = rows.map((r) => r.map((x) => (/[",\n]/.test(String(x)) ? `"${String(x).replaceAll('"', '""')}"` : x)).join(",")).join("\r\n");
    downloadFile(`move-car-qr-${lastBatchNo || "batch"}.csv`, "\ufeff" + csv);
  });

  $("#qrSearchBtn", mount)?.addEventListener("click", () => {
    filter.status = $("#qrStatus", mount).value;
    filter.batch = $("#qrBatchFilter", mount).value;
    filter.q = $("#qrSearch", mount).value.trim();
    reload();
  });
  $("#qrResetBtn", mount)?.addEventListener("click", () => {
    $("#qrStatus", mount).value = "";
    $("#qrBatchFilter", mount).value = "";
    $("#qrSearch", mount).value = "";
    filter.status = ""; filter.batch = ""; filter.q = "";
    reload();
  });
  $("#qrSearch", mount)?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#qrSearchBtn", mount).click(); }
  });
  $("#qrDeleteSel", mount)?.addEventListener("click", () => {
    const ids = [...selected];
    if (!ids.length) return toast("请先勾选要删除的二维码", "err");
    openModal({
      title: `删除所选 ${ids.length} 个二维码？`,
      body: "仅未绑定 / 已停用的码会被删除，已绑定的会自动跳过。删除后这些码将失效。",
      confirmText: "确认删除",
      danger: true,
      onConfirm: async () => {
        try {
          const r = await api.adminBulkDeleteQrCodes(token, ids);
          toast(r.message || "已删除", "ok");
          await reload();
        } catch (err) { toast(err.message || "删除失败", "err"); }
      },
    });
  });

  reload();
}

function openVehicleEditor(token, vehicle) {
  const isEdit = Boolean(vehicle);
  let vePlateInput;
  openModal({
    title: isEdit ? `编辑车牌 #${vehicle.id}` : "新增车牌绑定",
    body: `<div class="grid-form" style="margin-top:6px">
        <label class="span-2">车牌号
          <input id="vePlate" value="${escapeHtml(vehicle?.plateNumber || "")}" placeholder="例如 粤A12345" />
          <div id="vePlateHost" class="plate-input-host"></div>
        </label>
        <label class="span-2">车主手机号（短信 / 隐私拨号 / 直拨需要）
          <input id="vePhone" value="${escapeHtml(vehicle?.ownerPhone || "")}" placeholder="11 位手机号" />
        </label>
        <div class="switch-row span-2">
          <div class="meta"><b>一键通知</b><span>同时调用企业微信接口 + 微信公众号模板消息接口</span></div>
          <label class="switch"><input type="checkbox" id="veNotifyAll" ${vehicle?.notifyAllEnabled ? "checked" : ""}><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="switch-row span-2">
          <div class="meta"><b>短信通知</b><span>需填手机号 + 平台短信通道</span></div>
          <label class="switch"><input type="checkbox" id="veSms" ${vehicle?.smsEnabled ? "checked" : ""}><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="switch-row span-2">
          <div class="meta"><b>隐私拨号</b><span>需填手机号 + 平台隐私号通道；关闭则为直拨（默认）</span></div>
          <label class="switch"><input type="checkbox" id="vePrivacy" ${vehicle?.privacyCallEnabled ? "checked" : ""}><span class="track"></span><span class="thumb"></span></label>
        </div>
        <label class="span-2">微信接收 OpenID（可选，留空用平台默认）
          <input id="veOpenid" value="${escapeHtml(vehicle?.wechatOpenid || "")}" placeholder="关注公众号后获取的 OpenID" />
        </label>
        <label class="span-2">${isEdit ? "重置查看密码（留空则不变）" : "查看密码（可选，4-12 位数字）"}
          <input id="vePin" placeholder="4-12 位数字" />
        </label>
        <p class="field-hint" style="grid-column:1/-1">车主用「车牌 + 查看密码」在管理后台找回入口。</p>
      </div>`,
    confirmText: isEdit ? "保存修改" : "创建绑定",
    onOpen: () => {
      vePlateInput = createPlateInput($("#vePlateHost"), {
        input: $("#vePlate"),
        value: vehicle?.plateNumber,
        allowTypeSwitch: true,
      });
    },
    onConfirm: async () => {
      const payload = {
        plateNumber: normalizePlate($("#vePlate")?.value ?? ""),
        ownerPhone: $("#vePhone").value.trim(),
        notifyAllEnabled: $("#veNotifyAll").checked,
        smsEnabled: $("#veSms").checked,
        privacyCallEnabled: $("#vePrivacy").checked,
        wechatOpenid: $("#veOpenid").value.trim(),
      };
      const pin = $("#vePin").value.trim();
      if (pin) payload.ownerPin = pin;
      if (vePlateInput && !vePlateInput.isValid()) return toast("请点选完整车牌（普通 7 位 / 新能源 8 位）", "err");
      if (payload.smsEnabled || payload.privacyCallEnabled) {
        if (!payload.ownerPhone && !vehicle?.ownerPhone) return toast("开启短信/隐私拨号需填写手机号", "err");
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
const IMPORT_HEADERS = ["车牌号", "查看密码", "手机号", "短信通知", "隐私拨号", "一键通知", "微信OpenID"];

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
    privacyCallEnabled: truthyFlag(raw.privacyCallEnabled ?? raw["隐私拨号"] ?? raw["隐私号呼叫"]),
    notifyAllEnabled: truthyFlag(raw.notifyAllEnabled ?? raw["一键通知"]),
    wechatOpenid: String(raw.wechatOpenid ?? raw["微信OpenID"] ?? raw["微信Openid"] ?? "").trim(),
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
      notifyAllEnabled: cells[5],
      wechatOpenid: cells[6],
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
