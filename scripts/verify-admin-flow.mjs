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

console.log("\n=== 10.5 广告位（后台配置图片链接 + 公开读取） ===");
const adNoAuth = await call("GET", "/api/admin/ads");
ok("未授权读广告列表 → 401", adNoAuth.status === 401, String(adNoAuth.status));
const adNoAuthCreate = await call("POST", "/api/admin/ads", { body: { position: "move_top", imageUrl: "https://example.com/a.png" } });
ok("未授权创建广告 → 401", adNoAuthCreate.status === 401, String(adNoAuthCreate.status));

const adBadPos = await call("POST", "/api/admin/ads", { token: adminToken, body: { position: "nope", imageUrl: "https://example.com/a.png" } });
ok("非法广告位被拒", adBadPos.status === 400, String(adBadPos.status));
const adNoImg = await call("POST", "/api/admin/ads", { token: adminToken, body: { position: "move_top" } });
ok("缺图片链接被拒", adNoImg.status === 400, String(adNoImg.status));
const adBadImg = await call("POST", "/api/admin/ads", { token: adminToken, body: { position: "move_top", imageUrl: "not-a-url" } });
ok("非法图片链接被拒", adBadImg.status === 400, String(adBadImg.status));

const adCreated = await call("POST", "/api/admin/ads", {
  token: adminToken,
  body: { position: "move_top", imageUrl: "https://example.com/banner.png", linkUrl: "https://example.com/landing", title: "测试横幅", sortOrder: 1 },
});
ok("创建广告 201", adCreated.status === 201, JSON.stringify(adCreated.data));
const adId = adCreated.data?.id;
ok("返回广告 id", Boolean(adId));

const adList = await call("GET", "/api/admin/ads", { token: adminToken });
ok("后台列表含广告位定义", (adList.data?.positions || []).length >= 4, JSON.stringify(adList.data?.positions));
ok("后台列表含新广告", (adList.data?.ads || []).some((a) => a.id === adId));

const pubAds = await call("GET", "/api/ads?position=move_top");
ok("公开接口返回该位置广告", (pubAds.data?.ads || []).length === 1 && pubAds.data.ads[0].id === adId, JSON.stringify(pubAds.data));
const pubAdsOther = await call("GET", "/api/ads?position=home_top");
ok("其它位置为空", (pubAdsOther.data?.ads || []).length === 0, JSON.stringify(pubAdsOther.data));
const pubAdsAll = await call("GET", "/api/ads");
ok("不带位置返回全部启用广告", (pubAdsAll.data?.ads || []).length === 1);

const adUpd = await call("PUT", `/api/admin/ads/${adId}`, { token: adminToken, body: { title: "改过的横幅", sortOrder: 9 } });
ok("更新广告", adUpd.status === 200, JSON.stringify(adUpd.data));
const pubAds2 = await call("GET", "/api/ads?position=move_top");
ok("更新已生效", pubAds2.data?.ads?.[0]?.title === "改过的横幅" && pubAds2.data.ads[0].sort_order === 9, JSON.stringify(pubAds2.data));

const adOff = await call("PUT", `/api/admin/ads/${adId}`, { token: adminToken, body: { enabled: false } });
ok("停用广告", adOff.status === 200);
const pubAds3 = await call("GET", "/api/ads?position=move_top");
ok("停用后公开接口不再返回", (pubAds3.data?.ads || []).length === 0, JSON.stringify(pubAds3.data));

const adUpdMissing = await call("PUT", "/api/admin/ads/999999", { token: adminToken, body: { title: "x" } });
ok("更新不存在的广告 → 404", adUpdMissing.status === 404, String(adUpdMissing.status));

const adDel = await call("DELETE", `/api/admin/ads/${adId}`, { token: adminToken });
ok("删除广告", adDel.status === 200, JSON.stringify(adDel.data));
const adDelAgain = await call("DELETE", `/api/admin/ads/${adId}`, { token: adminToken });
ok("重复删除 → 404", adDelAgain.status === 404, String(adDelAgain.status));
const pubAds4 = await call("GET", "/api/ads?position=move_top");
ok("删除后公开接口为空", (pubAds4.data?.ads || []).length === 0);

console.log("\n=== 10.6 车牌管理（增 / 改 / 删 / 导入 / 导出 / 取 ownerToken） ===");
const noAuthVh = await call("GET", "/api/admin/vehicles");
ok("未授权读车牌列表 → 401", noAuthVh.status === 401, String(noAuthVh.status));
const noAuthVhCreate = await call("POST", "/api/admin/vehicles", { body: { plateNumber: "沪B11111" } });
ok("未授权新增车牌 → 401", noAuthVhCreate.status === 401, String(noAuthVhCreate.status));
const noAuthVhExport = await call("GET", "/api/admin/vehicles/export");
ok("未授权导出 → 401", noAuthVhExport.status === 401, String(noAuthVhExport.status));

const vhBadPlate = await call("POST", "/api/admin/vehicles", { token: adminToken, body: { plateNumber: "bad!!" } });
ok("非法车牌被拒", vhBadPlate.status === 400, String(vhBadPlate.status));
const vhBadPin = await call("POST", "/api/admin/vehicles", { token: adminToken, body: { plateNumber: `沪B${stamp}1`, ownerPin: "12" } });
ok("非法查看密码被拒", vhBadPin.status === 400, String(vhBadPin.status));

const vhA = await call("POST", "/api/admin/vehicles", {
  token: adminToken,
  body: { plateNumber: `沪B${stamp}1`, ownerPhone: "13900000011", ownerPin: "1357", smsEnabled: true, wechatWorkWebhook: "https://example.com/w1" },
});
ok("新增车牌 201", vhA.status === 201, JSON.stringify(vhA.data));
const vhAId = vhA.data?.id;
ok("返回车辆 id", Boolean(vhAId));

const vhDup = await call("POST", "/api/admin/vehicles", { token: adminToken, body: { plateNumber: `沪B${stamp}1` } });
ok("重复车牌被拒（409）", vhDup.status === 409, String(vhDup.status));

const vhB = await call("POST", "/api/admin/vehicles", { token: adminToken, body: { plateNumber: `沪B${stamp}2`, ownerPhone: "13900000022" } });
ok("新增第二辆车", vhB.status === 201, JSON.stringify(vhB.data));
const vhBId = vhB.data?.id;

const vhList = await call("GET", "/api/admin/vehicles", { token: adminToken });
ok("列表返回", vhList.status === 200 && Array.isArray(vhList.data?.vehicles), JSON.stringify(vhList.data).slice(0, 120));
const rowA = (vhList.data?.vehicles || []).find((v) => v.id === vhAId);
ok("列表能还原明文车牌（非脱敏）", rowA?.plateNumber === `沪B${stamp}1`, String(rowA?.plateNumber));
ok("列表能还原手机号", rowA?.ownerPhone === "13900000011", String(rowA?.ownerPhone));
ok("列表能还原企业微信 Webhook", rowA?.wechatWorkWebhook === "https://example.com/w1", String(rowA?.wechatWorkWebhook));
ok("plateMissing = false", rowA?.plateMissing === false);

const searchPlate = await call("GET", `/api/admin/vehicles?q=${encodeURIComponent(`沪B${stamp}1`)}`, { token: adminToken });
ok("按车牌搜索命中", (searchPlate.data?.vehicles || []).some((v) => v.id === vhAId), JSON.stringify(searchPlate.data).slice(0, 120));
const searchPhone = await call("GET", "/api/admin/vehicles?q=13900000022", { token: adminToken });
ok("按手机号搜索命中", (searchPhone.data?.vehicles || []).some((v) => v.id === vhBId));
const searchId = await call("GET", `/api/admin/vehicles?q=${vhAId}`, { token: adminToken });
ok("按 ID 搜索命中", (searchId.data?.vehicles || []).some((v) => v.id === vhAId));

// 编辑：改车牌 + 关短信 + 重置查看密码
const vhUpd = await call("PUT", `/api/admin/vehicles/${vhAId}`, {
  token: adminToken,
  body: { plateNumber: `沪B${stamp}9`, smsEnabled: false, ownerPin: "2468" },
});
ok("编辑车牌成功", vhUpd.status === 200, JSON.stringify(vhUpd.data));
const vhList2 = await call("GET", `/api/admin/vehicles?q=${encodeURIComponent(`沪B${stamp}9`)}`, { token: adminToken });
const rowA2 = (vhList2.data?.vehicles || []).find((v) => v.id === vhAId);
ok("新车牌已生效", rowA2?.plateNumber === `沪B${stamp}9`, String(rowA2?.plateNumber));
ok("短信已关闭", rowA2?.smsEnabled === false);
ok("手机号仍在（未传则不改）", rowA2?.ownerPhone === "13900000011", String(rowA2?.ownerPhone));
const recoverNewPin = await call("POST", "/api/owner/recover", { body: { plateNumber: `沪B${stamp}9`, ownerPin: "2468" } });
ok("车主可用新查看密码找回", recoverNewPin.status === 200, JSON.stringify(recoverNewPin.data));
const recoverOldPin = await call("POST", "/api/owner/recover", { body: { plateNumber: `沪B${stamp}9`, ownerPin: "1357" } });
ok("旧查看密码已失效", recoverOldPin.status === 404, String(recoverOldPin.status));

const vhUpdDup = await call("PUT", `/api/admin/vehicles/${vhAId}`, { token: adminToken, body: { plateNumber: `沪B${stamp}2` } });
ok("编辑成已占用车牌 → 409", vhUpdDup.status === 409, String(vhUpdDup.status));
const vhUpdMissing = await call("PUT", "/api/admin/vehicles/999999", { token: adminToken, body: { smsEnabled: true } });
ok("编辑不存在车辆 → 404", vhUpdMissing.status === 404, String(vhUpdMissing.status));

// 取 ownerToken 跳转车主后台
const vhTok = await call("GET", `/api/admin/vehicles/${vhAId}/owner-token`, { token: adminToken });
ok("取到 ownerToken", vhTok.status === 200 && String(vhTok.data?.ownerToken || "").startsWith("own_"), JSON.stringify(vhTok.data));
const enterOwner = await call("GET", `/api/owner/${vhTok.data.ownerToken}/vehicle`);
ok("该 ownerToken 可直接进车主后台", enterOwner.status === 200 && enterOwner.data?.plateNumber === `沪B${stamp}9`, JSON.stringify(enterOwner.data));

// 导入
const importRes = await call("POST", "/api/admin/vehicles/import", {
  token: adminToken,
  body: {
    items: [
      { plateNumber: `京A${stamp}1`, ownerPhone: "13800001111", ownerPin: "1122" },
      { plateNumber: `京A${stamp}2`, ownerPhone: "13800002222", smsEnabled: true },
      { plateNumber: `京A${stamp}1` },          // 重复
      { plateNumber: "bad!!" },                  // 非法车牌
      { plateNumber: `京A${stamp}3`, ownerPin: "1" }, // 非法密码
    ],
  },
});
ok("导入接口 200", importRes.status === 200, JSON.stringify(importRes.data).slice(0, 160));
ok("导入成功 2 条", (importRes.data?.created || []).length === 2, JSON.stringify(importRes.data?.created));
ok("重复跳过 1 条", (importRes.data?.skipped || []).length === 1, JSON.stringify(importRes.data?.skipped));
ok("失败 2 条（车牌非法 + 密码非法）", (importRes.data?.failed || []).length === 2, JSON.stringify(importRes.data?.failed));
const importEmpty = await call("POST", "/api/admin/vehicles/import", { token: adminToken, body: { items: [] } });
ok("空导入被拒", importEmpty.status === 400, String(importEmpty.status));

// 导出
const exp = await call("GET", "/api/admin/vehicles/export", { token: adminToken });
ok("导出 200", exp.status === 200, String(exp.status));
ok("导出含新增车牌", (exp.data?.vehicles || []).some((v) => v.plateNumber === `京A${stamp}1`), JSON.stringify(exp.data?.vehicles || []).slice(0, 160));
ok("导出含明文手机号", (exp.data?.vehicles || []).some((v) => v.ownerPhone === "13800001111"));

// 删除
const vhDel = await call("DELETE", `/api/admin/vehicles/${vhBId}`, { token: adminToken });
ok("删除车牌", vhDel.status === 200, JSON.stringify(vhDel.data));
const vhDelAgain = await call("DELETE", `/api/admin/vehicles/${vhBId}`, { token: adminToken });
ok("重复删除 → 404", vhDelAgain.status === 404, String(vhDelAgain.status));

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

console.log("\n=== 12.5 管理员修改自己的密码 ===");
const reLogin = await call("POST", "/api/admin/login", { body: { username: "admin", password: "MoveCar@2026" } });
ok("重新登录取得会话", reLogin.status === 200 && Boolean(reLogin.data?.token), JSON.stringify(reLogin.data));
const pwTok = reLogin.data.token;
const pwWrongCur = await call("POST", "/api/admin/password", { token: pwTok, body: { currentPassword: "wrong-one", newPassword: "NewSecret123" } });
ok("当前密码错误被拒", pwWrongCur.status === 400, String(pwWrongCur.status));
const pwWeak = await call("POST", "/api/admin/password", { token: pwTok, body: { currentPassword: "MoveCar@2026", newPassword: "123" } });
ok("新密码过短被拒", pwWeak.status === 400, String(pwWeak.status));
const pwNoAuth = await call("POST", "/api/admin/password", { body: { currentPassword: "MoveCar@2026", newPassword: "NewSecret123" } });
ok("未授权改密 → 401", pwNoAuth.status === 401, String(pwNoAuth.status));

const pwOk = await call("POST", "/api/admin/password", { token: pwTok, body: { currentPassword: "MoveCar@2026", newPassword: "NewSecret123" } });
ok("改密成功", pwOk.status === 200, JSON.stringify(pwOk.data));
const pwOldTok = await call("GET", "/api/admin/config", { token: pwTok });
ok("改密后旧会话失效 → 401", pwOldTok.status === 401, String(pwOldTok.status));
const loginOldPw = await call("POST", "/api/admin/login", { body: { username: "admin", password: "MoveCar@2026" } });
ok("旧密码无法登录 → 401", loginOldPw.status === 401, String(loginOldPw.status));
const loginNewPw = await call("POST", "/api/admin/login", { body: { username: "admin", password: "NewSecret123" } });
ok("新密码可登录", loginNewPw.status === 200 && Boolean(loginNewPw.data?.token), JSON.stringify(loginNewPw.data));

// 还原密码，保证脚本可重复运行
const pwRestore = await call("POST", "/api/admin/password", { token: loginNewPw.data.token, body: { currentPassword: "NewSecret123", newPassword: "MoveCar@2026" } });
ok("还原初始密码", pwRestore.status === 200, JSON.stringify(pwRestore.data));
const loginRestored = await call("POST", "/api/admin/login", { body: { username: "admin", password: "MoveCar@2026" } });
ok("还原后可登录", loginRestored.status === 200);

console.log("\n=== 13. 清理 ===");
const del2 = await call("DELETE", `/api/owner/${ownerToken}/vehicle`);
ok("删除车辆", del2.status === 200, JSON.stringify(del2.data));
const cleanupTok = loginRestored.data.token;
const allVh = await call("GET", "/api/admin/vehicles", { token: cleanupTok });
const cleanupIds = (allVh.data?.vehicles || []).map((v) => v.id);
for (const id of cleanupIds) await call("DELETE", `/api/admin/vehicles/${id}`, { token: cleanupTok });
ok(`清理测试车牌 ${cleanupIds.length} 条`, cleanupIds.length >= 0);

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail ? 1 : 0);
