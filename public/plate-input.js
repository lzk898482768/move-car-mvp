// 车牌点选输入组件（替代系统输入法）
// 用法：import { createPlateInput } from "./plate-input.js";
//   const pi = createPlateInput(hostEl, { value, allowTypeSwitch, onChange });
//   pi.getValue() -> "粤B12345" / "粤B12345D"
//   pi.getType()  -> "regular" | "new"
//   pi.isValid()  -> 是否点选完整且格式合规
// 规则：
//   普通车牌 7 位 = 省份简称 + 发牌机关字母 + 5 位序号
//   新能源车牌 8 位 = 省份简称 + 发牌机关字母 + 6 位序号（末位仅 数字 / D / F）

const PROVINCES = [
  "京", "津", "冀", "晋", "蒙", "辽", "吉", "黑", "沪", "苏",
  "浙", "皖", "闽", "赣", "鲁", "豫", "鄂", "湘", "粤", "桂",
  "琼", "渝", "川", "贵", "云", "藏", "陕", "甘", "青", "宁",
  "新", "港", "澳", "学", "使", "领",
];

// 序号可用字母（去除易与数字混淆的 I、O）
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ".split("");
const DIGITS = "0123456789".split("");
// 新能源最后一位：数字 或 D(纯电)/F(非纯电)
const NEW_ENERGY_LAST = DIGITS.concat(["D", "F"]);

const REGULAR_LEN = 7; // 省份 + 6 位
const NEW_ENERGY_LEN = 8; // 省份 + 7 位

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

// 返回某位置上允许输入的字符集合
function allowedAt(type, pos, len) {
  if (pos === 0) return PROVINCES;
  if (pos === 1) return LETTERS;
  if (pos === len - 1 && type === "new") return NEW_ENERGY_LAST;
  return DIGITS.concat(LETTERS);
}

export function createPlateInput(host, opts = {}) {
  if (!host) throw new Error("createPlateInput: host 元素不存在");

  const allowTypeSwitch = opts.allowTypeSwitch !== false;
  let type =
    opts.type === "new"
      ? "new"
      : opts.value && normalizeToChars(opts.value).length === NEW_ENERGY_LEN
      ? "new"
      : "regular";
  let chars = opts.value ? normalizeToChars(opts.value) : [];
  const maxLen = () => (type === "new" ? NEW_ENERGY_LEN : REGULAR_LEN);
  if (chars.length > maxLen()) chars = chars.slice(0, maxLen());
  let active = chars.length < maxLen() ? chars.length : maxLen() - 1;
  const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};

  function emit() { try { onChange(getValue(), type); } catch {} }
  function lenOf() { return maxLen(); }

  function setType(next) {
    if (type === next) return;
    const wasLen = maxLen();
    type = next;
    if (chars.length > maxLen()) chars = chars.slice(0, maxLen());
    if (maxLen() > wasLen && chars.length < maxLen()) active = chars.length; // 扩位后光标跳到新增位
    if (active >= maxLen()) active = maxLen() - 1;
    render();
    emit();
  }

  function focus(pos) {
    // 点击已填格子 -> 覆盖该位；点击空位 -> 定位到下一个待填
    active = pos < chars.length ? pos : Math.min(chars.length, maxLen() - 1);
    render();
  }

  function inputChar(ch) {
    const allowed = allowedAt(type, active, lenOf());
    if (!allowed.includes(ch) || active >= maxLen()) return;
    chars[active] = ch;
    if (active < maxLen() - 1) active += 1;
    render();
    emit();
  }

  function backspace() {
    if (!chars.length) return;
    if (active >= chars.length) active = chars.length - 1;
    if (active < 0) return;
    chars.splice(active, 1);
    active = Math.min(active, Math.max(0, chars.length));
    render();
    emit();
  }

  function clearAll() {
    chars = [];
    active = 0;
    render();
    emit();
  }

  function getValue() { return chars.join(""); }
  function getType() { return type; }
  function isValid() {
    return chars.length === maxLen() && isProvince(chars[0]) && isLetter(chars[1]);
  }
  function setValue(v) {
    chars = normalizeToChars(v);
    if (chars.length > maxLen()) chars = chars.slice(0, maxLen());
    active = chars.length < maxLen() ? chars.length : maxLen() - 1;
    render();
    emit();
  }

  function render() {
    const len = lenOf();
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "plate-picker";

    if (allowTypeSwitch) {
      const tg = document.createElement("div");
      tg.className = "plate-type";
      tg.innerHTML =
        '<span class="plate-type-label">牌照类型</span>' +
        '<div class="seg">' +
        '<button type="button" class="seg-btn ' + (type === "regular" ? "on" : "") + '" data-t="regular">普通（7位）</button>' +
        '<button type="button" class="seg-btn ' + (type === "new" ? "on" : "") + '" data-t="new">新能源（8位）</button>' +
        "</div>";
      tg.querySelectorAll(".seg-btn").forEach((b) => (b.onclick = () => setType(b.dataset.t)));
      wrap.appendChild(tg);
    }

    const disp = document.createElement("div");
    disp.className = "plate-display";
    for (let i = 0; i < len; i++) {
      const box = document.createElement("div");
      box.className = "plate-box" + (chars[i] ? " filled" : "") + (i === active ? " active" : "") + (type === "new" && i === len - 1 ? " last-new" : "");
      box.textContent = chars[i] || "";
      box.onclick = () => focus(i);
      disp.appendChild(box);
    }
    wrap.appendChild(disp);

    const kb = document.createElement("div");
    kb.className = "plate-kb";
    const allowed = allowedAt(type, active, len);
    const hint = document.createElement("div");
    hint.className = "plate-kb-hint";
    hint.textContent =
      active === 0
        ? "请选择省份 / 地区简称"
        : active === 1
        ? "请输入发牌机关字母"
        : "请输入剩余字符" + (type === "new" && active === len - 1 ? "（末位为数字或 D / F）" : "");
    kb.appendChild(hint);

    const grid = document.createElement("div");
    grid.className = "plate-kb-grid" + (allowed.length > 20 ? " wrap-many" : "");
    allowed.forEach((ch) => {
      const k = document.createElement("button");
      k.type = "button";
      k.className = "plate-key";
      k.textContent = ch;
      k.onclick = () => inputChar(ch);
      grid.appendChild(k);
    });
    kb.appendChild(grid);

    const acts = document.createElement("div");
    acts.className = "plate-kb-acts";
    acts.innerHTML =
      '<button type="button" class="plate-key wide">⌫ 删除</button>' +
      '<button type="button" class="plate-key wide ghost">清空</button>';
    acts.querySelector(".wide").onclick = backspace;
    acts.querySelector(".ghost").onclick = clearAll;
    kb.appendChild(acts);

    wrap.appendChild(kb);
    host.appendChild(wrap);
  }

  render();

  return { getValue, getType, isValid, setValue, clear: clearAll, el: host };
}
