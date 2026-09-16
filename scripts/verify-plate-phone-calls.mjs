// 车牌唯一 / 手机号必填 / 换号验证 / 拨号日志 端到端验证
// 用法：先启动 wrangler dev（http://127.0.0.1:8799），再 node scripts/verify-plate-phone-calls.mjs
const BASE = process.env.BASE_URL || "http://127.0.0.1:8799";
let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n} ${extra}`)); };

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["X-Admin-Token"] = token;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const stamp = Date.now().toString().slice(-6);
const plate = `鲁A${stamp}`;
const PHONE1 = "13500000001";
const PHONE2 = "13500000002";
const pin = "2468";

console.log("\n=== 1. 管理员登录 ===");
const login = await call("POST", "/api/admin/login", { body: { username: "admin", password: "MoveCar@2026" } });
ok("登录成功", login.status === 200, JSON.stringify(login.data));
const adminToken = login.data?.token;
if (!adminToken) { console.log("无管理员令牌，终止"); process.exit(1); }

console.log("\n=== 2. 手机号必填 ===");
const noPhone = await call("POST", "/api/vehicles", { body: { plateNumber: `鲁B${stamp}`, wechatWorkWebhook: "https://example.com/w" } });
ok("缺手机号 → 400", noPhone.status === 400, String(noPhone.status));
ok("错误码 invalid_phone", noPhone.data?.error === "invalid_phone", JSON.stringify(noPhone.data));

console.log("\n=== 3. 车牌唯一：首次录入成功 ===");
const created = await call("POST", "/api/vehicles", {
  body: { plateNumber: plate, ownerPhone: PHONE1, wechatWorkWebhook: "https://example.com/w", ownerPin: pin },
});
ok("首次录入 201", created.status === 201, JSON.stringify(created.data));
const ownerToken = created.data?.ownerToken;
const vehicleToken = created.data?.vehicleToken;

console.log("\n=== 4. 重复录入 → 只能找回 ===");
const dup = await call("POST", "/api/vehicles", { body: { plateNumber: plate, ownerPhone: PHONE1, wechatWorkWebhook: "https://example.com/w" } });
ok("重复录入 409", dup.status === 409, String(dup.status));
ok("错误码 plate_exists", dup.data?.error === "plate_exists", JSON.stringify(dup.data));
ok("返回脱敏车牌", Boolean(dup.data?.maskedPlate), JSON.stringify(dup.data));
ok("提示可找回 canRecover", dup.data?.canRecover === true, JSON.stringify(dup.data));
// 找回路径可用
const rec = await call("POST", "/api/owner/recover", { body: { plateNumber: plate, ownerPin: pin } });
ok("车牌+管理密码可找回", rec.status === 200 && Boolean(rec.data?.ownerToken), JSON.stringify(rec.data));

console.log("\n=== 5. 换号必须验证 ===");
const noVerify = await call("PATCH", `/api/owner/${ownerToken}/vehicle`, { body: { ownerPhone: PHONE2 } });
ok("未验证直接换号 → 403", noVerify.status === 403, String(noVerify.status));
ok("错误码 verification_required", noVerify.data?.error === "verification_required", JSON.stringify(noVerify.data));

// 错误的管理密码
const badPin = await call("PATCH", `/api/owner/${ownerToken}/vehicle`, {
  body: { ownerPhone: PHONE2, phoneVerify: { method: "pin", pin: "0000" } },
});
ok("错误管理密码 → 403", badPin.status === 403, String(badPin.status));
ok("错误码 pin_mismatch", badPin.data?.error === "pin_mismatch", JSON.stringify(badPin.data));

// 正确的管理密码
const goodPin = await call("PATCH", `/api/owner/${ownerToken}/vehicle`, {
  body: { ownerPhone: PHONE2, phoneVerify: { method: "pin", pin } },
});
ok("管理密码正确 → 换号成功", goodPin.status === 200, JSON.stringify(goodPin.data));
const afterChange = await call("GET", `/api/owner/${ownerToken}/vehicle`);
ok("新手机号已生效", afterChange.data?.ownerPhoneMasked === "135****02", afterChange.data?.ownerPhoneMasked);

// 非法验证码
const badCode = await call("PATCH", `/api/owner/${ownerToken}/vehicle`, {
  body: { ownerPhone: PHONE1, phoneVerify: { method: "sms", code: "123" } },
});
ok("非法验证码 → 400/403", badCode.status === 400 || badCode.status === 403, String(badCode.status));

console.log("\n=== 6. 短信验证码下发（未开通道时拒绝） ===");
// 先确保短信通道关闭
await call("PUT", "/api/admin/config", { token: adminToken, body: { sms_enabled_global: "false" } });
const sendClosed = await call("POST", `/api/owner/${ownerToken}/phone/send-code`);
ok("短信未开通 → 400 sms_unavailable", sendClosed.status === 400 && sendClosed.data?.error === "sms_unavailable", JSON.stringify(sendClosed.data));

console.log("\n=== 7. 拨号日志：直拨 ===");
const direct = await call("POST", `/api/vehicles/${vehicleToken}/call-log`, { body: { callerNumber: "13900001111" } });
ok("直拨上报 200", direct.status === 200, JSON.stringify(direct.data));

console.log("\n=== 8. 拨号日志：隐私拨号 ===");
// 配置自定义隐私号 webhook（本地不可达，用于验证失败也记日志）
await call("PUT", "/api/admin/config", {
  token: adminToken,
  body: { privacy_enabled_global: "true", privacy_vendor: "custom", privacy_call_webhook_url: "https://127.0.0.1:1/privacy" },
});
// 车主需先开启隐私号（不改手机号，无需验证）
await call("PATCH", `/api/owner/${ownerToken}/vehicle`, { body: { privacyCallEnabled: true } });
const notif = await call("POST", `/api/vehicles/${vehicleToken}/notify`, { body: { channel: "privacy_call", callerNumber: "13900002222" } });
ok("隐私拨号请求已受理（webhook 不可达会失败，但应记日志）", notif.status === 200 || notif.status === 502, `${notif.status} ${JSON.stringify(notif.data)}`);

console.log("\n=== 9. 管理员查看 / 筛选 / 导出 / 批量删除 ===");
const list = await call("GET", `/api/admin/call-logs?limit=50`, { token: adminToken });
ok("日志列表 200", list.status === 200, JSON.stringify(list.data).slice(0, 200));
ok("含直拨记录", (list.data.logs || []).some((l) => l.channel === "direct_call"), JSON.stringify((list.data.logs || []).map((l) => l.channel)));
ok("直拨记录了拨号方号码", (list.data.logs || []).some((l) => l.channel === "direct_call" && l.callerNumber === "13900001111"));
ok("记录了被叫车主号码", (list.data.logs || []).some((l) => l.calleeNumber === PHONE2), JSON.stringify((list.data.logs || []).map((l) => l.calleeNumber)));
ok("含隐私拨号记录", (list.data.logs || []).some((l) => l.channel === "privacy_call"));

// 按通道筛选
const filtered = await call("GET", `/api/admin/call-logs?channel=direct_call`, { token: adminToken });
ok("按通道筛选生效", (filtered.data.logs || []).every((l) => l.channel === "direct_call"), JSON.stringify((filtered.data.logs || []).map((l) => l.channel)));

// 按号码后4位筛选
const byLast4 = await call("GET", `/api/admin/call-logs?last4=1111`, { token: adminToken });
ok("按号码后4位筛选生效", (byLast4.data.logs || []).length >= 1 && (byLast4.data.logs || []).every((l) => l.callerLast4 === "1111" || l.calleeLast4 === "1111" || l.virtualLast4 === "1111"), JSON.stringify(byLast4.data.logs?.length));

// 按车牌筛选
const byPlate = await call("GET", `/api/admin/call-logs?q=${encodeURIComponent(plate)}`, { token: adminToken });
ok("按车牌筛选生效", (byPlate.data.logs || []).length >= 1, String(byPlate.data.total));

// 导出
const exp = await call("GET", `/api/admin/call-logs/export`, { token: adminToken });
ok("导出接口 200", exp.status === 200 && Array.isArray(exp.data.logs), JSON.stringify(exp.data).slice(0, 120));

// 勾选删除
const ids = (list.data.logs || []).slice(0, 1).map((l) => l.id);
const del = await call("POST", `/api/admin/call-logs/bulk-delete`, { token: adminToken, body: { ids } });
ok("批量删除（按 id）", del.status === 200 && del.data?.deleted >= 0, JSON.stringify(del.data));

// 无筛选条件拒绝清空
const delAll = await call("POST", `/api/admin/call-logs/bulk-delete`, { token: adminToken, body: { all: true } });
ok("无筛选条件拒绝清空全部", delAll.status === 400 && delAll.data?.error === "no_filter", JSON.stringify(delAll.data));

// 按筛选清空
const delFiltered = await call("POST", `/api/admin/call-logs/bulk-delete?q=${encodeURIComponent(plate)}`, { token: adminToken, body: { all: true } });
ok("按筛选条件清空", delFiltered.status === 200, JSON.stringify(delFiltered.data));
const after = await call("GET", `/api/admin/call-logs?q=${encodeURIComponent(plate)}`, { token: adminToken });
ok("清空后该车日志为 0", (after.data.total || 0) === 0, String(after.data.total));

console.log("\n=== 10. 清理 ===");
await call("PUT", "/api/admin/config", { token: adminToken, body: { sms_enabled_global: "true", privacy_enabled_global: "false" } });
const delV = await call("DELETE", `/api/owner/${ownerToken}/vehicle`);
ok("删除测试车辆", delV.status === 200);

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
