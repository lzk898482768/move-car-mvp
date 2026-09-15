// 本地端到端验证：管理员后台 + 车主 PIN 找回 + 混合通知通道
// 用法：先启动 `wrangler dev`（默认 http://127.0.0.1:8799），再执行
//   node scripts/verify-admin-flow.mjs
const BASE = process.env.BASE_URL || "http://127.0.0.1:8799";
let pass = 0;
let fail = 0;

function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["X-Admin-Token"] = token;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const stamp = Date.now().toString().slice(-6);
const plate = `京A${stamp}`;
const pin = "2468";
const adminUser = `t${stamp}`;

console.log("\n=== 1. 创建挪车码（含管理密码 + 企业微信/短信） ===");
const created = await call("POST", "/api/vehicles", {
  body: {
    plateNumber: plate,
    wechatWorkWebhook: "https://example.com/wechat-hook",
    ownerPhone: "13800000001",
    smsEnabled: true,
    privacyCallEnabled: false,
    ownerPin: pin,
  },
});
ok("返回 201", created.status === 201, JSON.stringify(created.data));
const ownerToken = created.data?.ownerToken;
const vehicleToken = created.data?.vehicleToken;
ok("拿到 ownerToken / vehicleToken", Boolean(ownerToken && vehicleToken));

console.log("\n=== 2. 车主后台读取（验证配置回填） ===");
const ownerGet = await call("GET", `/api/owner/${ownerToken}/vehicle`);
ok("返回 200", ownerGet.status === 200, JSON.stringify(ownerGet.data));
ok("回填企业微信 Webhook", ownerGet.data?.wechatWorkWebhook === "https://example.com/wechat-hook", String(ownerGet.data?.wechatWorkWebhook));
ok("回填手机号（脱敏）", ownerGet.data?.ownerPhoneMasked === "138****01", String(ownerGet.data?.ownerPhoneMasked));
ok("smsEnabled = true", ownerGet.data?.smsEnabled === true);
ok("hasPin = true", ownerGet.data?.hasPin === true);

console.log("\n=== 3. 修改配置并重新读取（验证「保存生效」） ===");
const patched = await call("PATCH", `/api/owner/${ownerToken}/vehicle`, {
  body: { wechatWorkWebhook: "https://example.com/wechat-hook-v2", smsEnabled: false },
});
ok("PATCH 200", patched.status === 200, JSON.stringify(patched.data));
const ownerGet2 = await call("GET", `/api/owner/${ownerToken}/vehicle`);
ok("Webhook 已更新", ownerGet2.data?.wechatWorkWebhook === "https://example.com/wechat-hook-v2", String(ownerGet2.data?.wechatWorkWebhook));
ok("smsEnabled 已关闭（不再被误重置为开）", ownerGet2.data?.smsEnabled === false, String(ownerGet2.data?.smsEnabled));
ok("手机号仍保留（留空不改）", ownerGet2.data?.ownerPhoneMasked === "138****01", String(ownerGet2.data?.ownerPhoneMasked));

console.log("\n=== 4. 车牌 + 管理密码 找回管理入口 ===");
const rec = await call("POST", "/api/owner/recover", { body: { plateNumber: plate, ownerPin: pin } });
ok("找回成功", rec.status === 200 && rec.data?.ownerToken === ownerToken, JSON.stringify(rec.data));
const recBad = await call("POST", "/api/owner/recover", { body: { plateNumber: plate, ownerPin: "0000" } });
ok("错误密码被拒绝（404）", recBad.status === 404, String(recBad.status));

console.log("\n=== 5. 管理员鉴权（未登录应 401） ===");
const noAuth = await call("GET", "/api/admin/config");
ok("未带令牌 → 401", noAuth.status === 401, String(noAuth.status));
const badCfg = await call("GET", "/api/admin/config", { token: "adm_fake" });
ok("伪造令牌 → 401", badCfg.status === 401, String(badCfg.status));
const noAuthLookup = await call("GET", `/api/admin/lookup?plate=${encodeURIComponent(plate)}`);
ok("未授权查询车牌 → 401", noAuthLookup.status === 401, String(noAuthLookup.status));

console.log("\n=== 6. 管理员登录（首次引导账号） ===");
const login = await call("POST", "/api/admin/login", { body: { username: "admin", password: "MoveCar@2026" } });
ok("登录成功", login.status === 200 && Boolean(login.data?.token), JSON.stringify(login.data));
const adminToken = login.data?.token;
const loginBad = await call("POST", "/api/admin/login", { body: { username: "admin", password: "wrong" } });
ok("错误密码 → 401", loginBad.status === 401, String(loginBad.status));

console.log("\n=== 7. 全局通知渠道配置 ===");
const putCfg = await call("PUT", "/api/admin/config", {
  token: adminToken,
  body: {
    wechat_work_webhook: "https://example.com/global-wechat",
    tencent_secret_id: "AKIDxxxx",
    tencent_secret_key: "SECRETyyyy",
    tencent_sms_app_id: "1400000000",
    tencent_sms_sign_name: "扫码挪车",
    tencent_sms_template_id: "123456",
    sms_enabled_global: "true",
  },
});
ok("保存全局配置", putCfg.status === 200, JSON.stringify(putCfg.data));
const getCfg = await call("GET", "/api/admin/config", { token: adminToken });
const cfgMap = Object.fromEntries((getCfg.data?.settings || []).map((s) => [s.key, s]));
ok("读取全局配置", getCfg.status === 200 && Object.keys(cfgMap).length > 10);
ok("敏感字段已脱敏回显", cfgMap.tencent_secret_key?.value === "••••••", String(cfgMap.tencent_secret_key?.value));
ok("非敏感字段明文回显", cfgMap.tencent_sms_sign_name?.value === "扫码挪车", String(cfgMap.tencent_sms_sign_name?.value));

console.log("\n=== 8. 健康检查反映全局通道已配置 ===");
const health = await call("GET", "/api/health");
ok("globalConfigured = true", health.data?.globalConfigured === true, JSON.stringify(health.data));
ok("tencentSms = true", health.data?.tencentSms === true);

console.log("\n=== 9. 管理员按车牌查车主电话 ===");
const lookup = await call("GET", `/api/admin/lookup?plate=${encodeURIComponent(plate)}`, { token: adminToken });
ok("查询命中", lookup.status === 200 && lookup.data?.found === true, JSON.stringify(lookup.data));
ok("返回明文手机号", lookup.data?.phone === "13800000001", String(lookup.data?.phone));
const lookupMiss = await call("GET", "/api/admin/lookup?plate=%E4%BA%ACZ99999", { token: adminToken });
ok("未命中返回 found:false", lookupMiss.data?.found === false);

console.log("\n=== 10. 管理员账号管理 ===");
const mk = await call("POST", "/api/admin/accounts", { token: adminToken, body: { username: adminUser, password: "Passw0rd123", role: "admin" } });
ok("创建管理员", mk.status === 201, JSON.stringify(mk.data));
const list = await call("GET", "/api/admin/accounts", { token: adminToken });
ok("账号列表含新账号", (list.data?.accounts || []).some((a) => a.username === adminUser));
const dup = await call("POST", "/api/admin/accounts", { token: adminToken, body: { username: adminUser, password: "Passw0rd123" } });
ok("重复账号被拒", dup.status === 400, String(dup.status));
const del = await call("DELETE", `/api/admin/accounts/${adminUser}`, { token: adminToken });
ok("删除管理员", del.status === 200, JSON.stringify(del.data));
const weak = await call("POST", "/api/admin/accounts", { token: adminToken, body: { username: `w${stamp}`, password: "123" } });
ok("弱密码被拒", weak.status === 400, String(weak.status));

console.log("\n=== 11. 访客通道解析（混合模型） ===");
// 步骤 3 已关闭短信，这里重新开启，验证「车主开关 + 全局密钥」组合生效
const reEnable = await call("PATCH", `/api/owner/${ownerToken}/vehicle`, { body: { smsEnabled: true } });
ok("重新开启短信", reEnable.status === 200, JSON.stringify(reEnable.data));
const pub = await call("GET", `/api/vehicles/${vehicleToken}/public`);
ok("访客可见通道", pub.status === 200 && Array.isArray(pub.data?.availableChannels), JSON.stringify(pub.data));
ok("含企业微信（车主自带）", (pub.data?.availableChannels || []).includes("wechat_work"));
ok("含短信（车主开关 + 全局密钥）", (pub.data?.availableChannels || []).includes("sms"), JSON.stringify(pub.data?.availableChannels));
ok("不含隐私号（未配置全局隐私号）", !(pub.data?.availableChannels || []).includes("privacy_call"));

console.log("\n=== 12. 管理员登出后令牌失效 ===");
const logout = await call("POST", "/api/admin/logout", { token: adminToken });
ok("登出 200", logout.status === 200);
const afterLogout = await call("GET", "/api/admin/config", { token: adminToken });
ok("登出后 → 401", afterLogout.status === 401, String(afterLogout.status));

console.log("\n=== 13. 清理 ===");
const del2 = await call("DELETE", `/api/owner/${ownerToken}/vehicle`);
ok("删除车辆", del2.status === 200, JSON.stringify(del2.data));

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
