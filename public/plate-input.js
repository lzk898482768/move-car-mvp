// 车牌点选输入组件（参考开源 uni-app 车牌键盘：格子 + 底部弹出键盘 + 遮罩）
// 渐进增强：原生 <input> 始终保留并在挂载成功后才隐藏，作为值载体与兜底
//   —— 即使本组件加载失败，原输入框依然可见可输入，不会出现"输入消失"
//
// 用法：
//   createPlateInput(host, { input, value, allowTypeSwitch, onChange })
//   -> { getValue, getType, isValid, setValue, clear, open, close }
//
// 牌照规则：
//   普通   7 位 = 省份简称 + 发牌机关字母 + 5 位序号（末位可为 挂/港/学/领/警）
//   新能源 8 位 = 省份简称 + 发牌机关字母 + 6 位序号（末位仅 数字 / D / F）

const PROVINCES = [
  "京", "津", "冀", "晋", "蒙", "辽", "吉", "黑", "沪", "苏",
  "浙", "皖", "闽", "赣", "鲁", "豫", "鄂", "湘", "粤", "桂",
  "琼", "渝", "川", "贵", "云", "藏", "陕", "甘", "青", "宁",
  "新", "港", "澳", "学", "使", "领",
];
// 序号可用字母（去除易与数字混淆的 I、O）
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ".split("");
const DIGITS = "0123456789".split("");
// 普通牌末位特殊字
const LAST_WORD = ["挂", "港", "学", "领", "警"];
// 新能源末位：数字 或 D(纯电)/F(非纯电)
const NEW_ENERGY_LAST = DIGITS.concat(["D", "F"]);

const REGULAR_LEN = 7;
const NEW_ENERGY_LEN = 8;

function isProvince(ch) { return PROVINCES.includes(ch); }
function isLetter(ch) { return LETTERS.includes(ch); }

function normalizeToChars(value) {
  if (!value) return [];
  const out = [];
  for (const ch of String(value).trim().toUpperCase()) {
    if (/[一-龥]/.test(ch)) out.push(ch);
    else if (/[A-Z0-9]/.test(ch)) out.push(ch);
  }
  return out;
}

// 某位置上允许输入的字符集合
function allowedAt(type, pos, len) {
  if (pos === 0) return PROVINCES;
  if (pos === 1) return LETTERS;
  if (pos === len - 1) return type === "new" ? NEW_ENERGY_LAST : DIGITS.concat(LETTERS, LAST_WORD);
  return DIGITS.concat(LETTERS);
}

/* ---------------- 全局共用的底部键盘层（懒创建，单例） ---------------- */
let kbLayer = null;
let kbActive = null; // 当前占用键盘的实例

function getKbLayer() {
  if (kbLayer) return kbLayer;
  const layer = document.createElement("div");
  layer.className = "plate-kb-layer";
  layer.id = "plateKbLayer";
  layer.innerHTML = `
    <div class="plate-kb-mask"></div>
    <div class="plate-kb-panel">
      <div class="plate-kb-head">
        <span class="plate-kb-title">输入车牌号</span>
        <span class="plate-kb-sub" id="plateKbSub"></span>
        <button type="button" class="plate-kb-close" aria-label="关闭">✕</button>
      </div>
      <div class="plate-kb-preview" id="plateKbPreview"></div>
      <div class="plate-kb-body" id="plateKbBody"></div>
      <div class="plate-kb-foot">
        <button type="button" class="kb-btn ghost" data-act="cancel">取消</button>
        <button type="button" class="kb-btn" data-act="del">删除</button>
        <button type="button" class="kb-btn primary" data-act="done">完成</button>
      </div>
    </div>`;
  document.body.appendChild(layer);
  layer.querySelector(".plate-kb-mask").addEventListener("click", () => kbActive && kbActive.close());
  layer.querySelector(".plate-kb-close").addEventListener("click", () => kbActive && kbActive.close());
  layer.querySelector('[data-act="cancel"]').addEventListener("click", () => kbActive && kbActive.close());
  layer.querySelector('[data-act="del"]').addEventListener("click", () => kbActive && kbActive.backspace());
  layer.querySelector('[data-act="done"]').addEventListener("click", () => kbActive && kbActive.close());
  kbLayer = layer;
  return layer;
}

/* ---------------- 组件 ---------------- */
export function createPlateInput(host, opts = {}) {
  // host 缺失（例如 HTML 与 JS 版本不一致）时，自动在 input 后创建，绝不抛错中断页面
  let hostEl = host || null;
  const input = opts.input || null;
  if (!hostEl) {
    if (!input) { console.warn("[plate-input] 缺少 host 与 input，跳过挂载"); return null; }
    hostEl = document.createElement("div");
    hostEl.className = "plate-input-host";
    input.insertAdjacentElement("afterend", hostEl);
  }

  const allowTypeSwitch = opts.allowTypeSwitch !== false;
  const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};

  let type =
    opts.type === "new"
      ? "new"
      : (opts.value ?? input?.value) && normalizeToChars(opts.value ?? input?.value).length === NEW_ENERGY_LEN
      ? "new"
      : "regular";
  let chars = normalizeToChars(opts.value ?? input?.value ?? "");
  const maxLen = () => (type === "new" ? NEW_ENERGY_LEN : REGULAR_LEN);
  if (chars.length > maxLen()) chars = chars.slice(0, maxLen());
  let active = chars.length < maxLen() ? chars.length : maxLen() - 1;

  /* ---------- 状态操作 ---------- */
  function getValue() { return chars.join(""); }
  function getType() { return type; }
  function isValid() {
    return chars.length === maxLen() && isProvince(chars[0]) && isLetter(chars[1]);
  }
  function sync() {
    if (input) {
      input.value = getValue();
      try { input.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
    }
    try { onChange(getValue(), type); } catch {}
  }

  function setType(next) {
    if (type === next) return;
    const wasLen = maxLen();
    type = next;
    if (chars.length > maxLen()) chars = chars.slice(0, maxLen());
    if (maxLen() > wasLen && chars.length < maxLen()) active = chars.length;
    if (active >= maxLen()) active = maxLen() - 1;
    renderBoxes();
    renderKeyboard();
    sync();
  }

  function focus(pos) {
    active = pos < chars.length ? pos : Math.min(chars.length, maxLen() - 1);
    renderBoxes();
    renderKeyboard();
  }

  function inputChar(ch) {
    const allowed = allowedAt(type, active, maxLen());
    if (!allowed.includes(ch) || active >= maxLen()) return;
    chars[active] = ch;
    if (active < maxLen() - 1) active += 1;
    renderBoxes();
    renderKeyboard();
    sync();
  }

  function backspace() {
    if (!chars.length) return;
    if (active >= chars.length) active = chars.length - 1;
    if (active < 0) return;
    chars.splice(active, 1);
    active = Math.min(active, Math.max(0, chars.length));
    renderBoxes();
    renderKeyboard();
    sync();
  }

  function clearAll() {
    chars = [];
    active = 0;
    renderBoxes();
    renderKeyboard();
    sync();
  }

  function setValue(v) {
    chars = normalizeToChars(v);
    if (chars.length > maxLen()) chars = chars.slice(0, maxLen());
    active = chars.length < maxLen() ? chars.length : maxLen() - 1;
    renderBoxes();
    if (kbActive === api) renderKeyboard();
    sync();
  }

  /* ---------- 渲染：格子 + 类型切换（页面内联，始终可见） ---------- */
  function buildShell() {
    hostEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "plate-picker";
    hostEl.appendChild(wrap);

    if (allowTypeSwitch) {
      const tg = document.createElement("div");
      tg.className = "plate-type";
      tg.innerHTML =
        '<span class="plate-type-label">牌照类型</span>' +
        '<div class="seg">' +
        '<button type="button" class="seg-btn" data-t="regular">普通（7位）</button>' +
        '<button type="button" class="seg-btn" data-t="new">新能源（8位）</button>' +
        "</div>";
      tg.querySelectorAll(".seg-btn").forEach((b) =>
        b.addEventListener("click", (e) => { e.preventDefault(); setType(b.dataset.t); })
      );
      wrap.appendChild(tg);
    }

    const disp = document.createElement("div");
    disp.className = "plate-display";
    disp.setAttribute("role", "button");
    disp.tabIndex = 0;
    disp.title = "点击输入车牌号";
    disp.addEventListener("click", () => open());
    disp.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    wrap.appendChild(disp);

    const hint = document.createElement("div");
    hint.className = "plate-picker-hint";
    wrap.appendChild(hint);
    return wrap;
  }

  const wrapEl = buildShell();
  const dispEl = wrapEl.querySelector(".plate-display");
  const hintEl = wrapEl.querySelector(".plate-picker-hint");
  const segBtns = [...wrapEl.querySelectorAll(".seg-btn")];

  function renderBoxes() {
    const len = maxLen();
    dispEl.innerHTML = "";
    for (let i = 0; i < len; i++) {
      const box = document.createElement("div");
      box.className =
        "plate-box" +
        (chars[i] ? " filled" : " empty") +
        (i === active ? " active" : "") +
        (type === "new" && i === len - 1 ? " last-new" : "");
      box.textContent = chars[i] || "";
      box.dataset.index = String(i);
      dispEl.appendChild(box);
    }
    segBtns.forEach((b) => b.classList.toggle("on", b.dataset.t === type));
    hintEl.textContent = chars.length
      ? `已输入 ${chars.length} / ${len} 位` + (isValid() ? "" : " · 还需继续点选")
      : "点击上方车牌框，使用专用键盘点选输入";
  }

  /* ---------- 渲染：底部键盘（弹出层） ---------- */
  function renderKeyboard() {
    if (kbActive !== api) return;
    const layer = getKbLayer();
    const body = layer.querySelector("#plateKbBody");
    const sub = layer.querySelector("#plateKbSub");
    const preview = layer.querySelector("#plateKbPreview");
    const len = maxLen();

    sub.textContent = type === "new" ? "新能源 · 8 位" : "普通 · 7 位";

    // 键盘顶部实时预览（键盘会遮住页面上的格子）
    preview.innerHTML = "";
    for (let i = 0; i < len; i++) {
      const b = document.createElement("span");
      b.className = "kb-prev" + (chars[i] ? " filled" : "") + (i === active ? " active" : "");
      b.textContent = chars[i] || "";
      b.dataset.index = String(i);
      b.addEventListener("click", () => focus(i));
      preview.appendChild(b);
    }

    const allowed = allowedAt(type, active, len);
    body.innerHTML = "";
    body.className = "plate-kb-body " + (allowed === PROVINCES ? "kb-province" : "kb-alnum");
    allowed.forEach((ch) => {
      const k = document.createElement("button");
      k.type = "button";
      k.className = "plate-key";
      k.textContent = ch;
      k.addEventListener("click", (e) => { e.preventDefault(); inputChar(ch); });
      body.appendChild(k);
    });
  }

  function open() {
    const layer = getKbLayer();
    kbActive = api;
    renderKeyboard();
    layer.classList.add("show");
    document.body.classList.add("kb-open");
  }
  function close() {
    kbActive = null;
    kbLayer?.classList.remove("show");
    document.body.classList.remove("kb-open");
    renderBoxes();
  }

  const api = { getValue, getType, isValid, setValue, clear: clearAll, open, close, backspace, el: hostEl, input };

  /* ---------- 初始化：隐藏原生 input（仅挂载成功后才隐藏，保证兜底） ---------- */
  if (input) {
    input.classList.add("plate-carrier");
    input.setAttribute("readonly", "readonly"); // JS 可用时禁止系统输入法
    input.removeAttribute("required");           // 隐藏后 required 会导致表单无法提交
  }
  renderBoxes();
  sync();
  return api;
}
