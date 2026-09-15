// 通知通道统一管理 · 端到端验证
// 用法：先启动 wrangler dev（http://127.0.0.1:8799），再 node scripts/verify-notification-channels.mjs
const BASE = process.env.BASE_URL || "http://127.0.0.1:8799";
let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n} ${extra}`)); };

let ch; // 通道状态（各小节复用）
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
const adminUser = `n${stamp}`;
const createdIds = [];

console.log("\n=== 1. 管理员登录（本地 dev 默认账号） ===");
let login = await call("POST", "/api/admin/login", { body: { username: "admin", password: "MoveCar@2026" } });
ok("管理员登录成功", login.status === 200, JSON.stringify(login.data));
const token = login.data?.token;
if (!token) { console.log("无法取得管理员令牌，终止"); process.exit(1); }

console.log("\n=== 1.5 重置为干净配置（避免历史密钥干扰） ===");
const reset = await call("PUT", "/api/admin/config", {
  token,
  body: {
    tencent_secret_id: "", tencent_secret_key: "", tencent_sms_app_id: "", tencent_sms_sign_name: "", tencent_sms_template_id: "",
    aliyun_access_key_id: "", aliyun_access_key_secret: "", aliyun_sms_sign_name: "", aliyun_sms_template_code: "",
    sms_custom_webhook: "", sms_custom_token: "",
    privacy_call_webhook_url: "", privacy_call_webhook_token: "",
    sms_vendor: "tencent", privacy_vendor: "custom",
    sms_enabled_global: "true", privacy_enabled_global: "true", direct_call_enabled_global: "true",
  },
});
ok("清空各服务商参数", reset.status === 200);
ch = await call("GET", "/api/channels");
ok("干净状态下 sms / privacy 均未开通", ch.data.channels.sms === false && ch.data.channels.privacy_call === false, JSON.stringify(ch.data.channels));

console.log("\n=== 2. 平台通道查询（公开接口） ===");
ch = await call("GET", "/api/channels");
ok("/api/channels 200", ch.status === 200);
ok("返回 5 个通道状态", ["wechat_work", "showdoc", "sms", "privacy_call", "direct_call"].every((k) => typeof ch.data.channels[k] === "boolean"), JSON.stringify(ch.data.channels));
ok("企业微信默认开通（开关默认 true）", ch.data.channels.wechat_work === true);
ok("返回通道分组元信息", Array.isArray(ch.data.groups) && ch.data.groups.length === 5);

console.log("\n=== 3. 短信：切换服务商 + 开关 ===");
// 3.1 关闭短信 → 未开通
let r = await call("PUT", "/api/admin/config", { token, body: { sms_enabled_global: "false" } });
ok("保存 sms_enabled_global=false", r.status === 200);
ch = await call("GET", "/api/channels");
ok("关闭后 sms 未开通", ch.data.channels.sms === false);

// 3.2 开启但参数不全 → 仍未开通
await call("PUT", "/api/admin/config", { token, body: { sms_enabled_global: "true", sms_vendor: "custom" } });
ch = await call("GET", "/api/channels");
ok("开启但缺参数 → sms 仍未开通", ch.data.channels.sms === false);

// 3.3 自定义 Webhook 补全 → 开通
await call("PUT", "/api/admin/config", { token, body: { sms_custom_webhook: "https://example.com/sms-hook" } });
ch = await call("GET", "/api/channels");
ok("自定义短信 Webhook 补全 → sms 开通", ch.data.channels.sms === true, JSON.stringify(ch.data.channels));

// 3.4 切到腾讯云（参数不全）→ 又变未开通
await call("PUT", "/api/admin/config", { token, body: { sms_vendor: "tencent" } });
ch = await call("GET", "/api/channels");
ok("切腾讯云且无密钥 → sms 未开通", ch.data.channels.sms === false);

// 3.5 切到阿里云并填参数 → 开通
await call("PUT", "/api/admin/config", {
  token,
  body: {
    sms_vendor: "aliyun",
    aliyun_access_key_id: "LTAI-test",
    aliyun_access_key_secret: "secret-test",
    aliyun_sms_sign_name: "测试签名",
    aliyun_sms_template_code: "SMS_123456",
  },
});
ch = await call("GET", "/api/channels");
ok("阿里云参数齐全 → sms 开通", ch.data.channels.sms === true, JSON.stringify(ch.data.channels));

// 恢复为自定义 Webhook（便于后续断言）
await call("PUT", "/api/admin/config", { token, body: { sms_vendor: "custom", sms_custom_webhook: "https://example.com/sms-hook" } });

console.log("\n=== 4. 隐私号：多平台 ===");
await call("PUT", "/api/admin/config", { token, body: { privacy_enabled_global: "true", privacy_vendor: "custom", privacy_call_webhook_url: "https://example.com/privacy-hook" } });
ch = await call("GET", "/api/channels");
ok("自定义隐私号 Webhook → privacy_call 开通", ch.data.channels.privacy_call === true, JSON.stringify(ch.data.channels));

await call("PUT", "/api/admin/config", { token, body: { privacy_vendor: "tencent" } });
ch = await call("GET", "/api/channels");
ok("切腾讯云隐私号且无密钥 → 未开通", ch.data.channels.privacy_call === false);

console.log("\n=== 5. 车主只能用已开通的通道 ===");
// 先关闭短信，尝试用短信创建 → 应被拒
await call("PUT", "/api/admin/config", { token, body: { sms_enabled_global: "false" } });
const badPlate = `沪B${stamp}`;
let bad = await call("POST", "/api/vehicles", {
  body: { plateNumber: badPlate, ownerPhone: "13900000001", smsEnabled: true },
});
ok("平台未开通短信 → 创建被拒 400", bad.status === 400, JSON.stringify(bad.data));
ok("错误码 no_available_channel", bad.data?.error === "no_available_channel", JSON.stringify(bad.data));

// 开通短信后创建 → 成功
await call("PUT", "/api/admin/config", { token, body: { sms_enabled_global: "true" } });
const goodPlate = `沪C${stamp}`;
const good = await call("POST", "/api/vehicles", {
  body: { plateNumber: goodPlate, ownerPhone: "13900000002", smsEnabled: true, privacyCallEnabled: true, ownerPin: "1357" },
});
ok("开通后创建成功", good.status === 201, JSON.stringify(good.data));
const ownerToken = good.data?.ownerToken;
const vehicleToken = good.data?.vehicleToken;

console.log("\n=== 6. 车主后台只看到已开通通道 ===");
const ov = await call("GET", `/api/owner/${ownerToken}/vehicle`);
ok("车主接口 200", ov.status === 200);
ok("返回 platformChannels", Array.isArray(ov.data.platformChannels), JSON.stringify(ov.data.platformChannels));
ok("platformChannels 含短信", ov.data.platformChannels.includes("sms"), JSON.stringify(ov.data.platformChannels));
ok("platformChannels 不含隐私号（未配置）", !ov.data.platformChannels.includes("privacy_call"), JSON.stringify(ov.data.platformChannels));
ok("返回 channelMeta 元信息", Array.isArray(ov.data.channelMeta) && ov.data.channelMeta.length === 5);

console.log("\n=== 7. 访客页：隐私号未开通 → 直拨回退 ===");
// 关闭隐私号通道，模拟「未开通隐私拨号」
await call("PUT", "/api/admin/config", { token, body: { privacy_enabled_global: "false" } });
const pv = await call("GET", `/api/vehicles/${vehicleToken}/public`);
ok("访客接口 200", pv.status === 200);
ok("可用通道不含隐私号", !(pv.data.availableChannels || []).includes("privacy_call"), JSON.stringify(pv.data.availableChannels));
ok("返回 directCall 且带号码", Boolean(pv.data.directCall?.enabled && pv.data.directCall.phone), JSON.stringify(pv.data.directCall));
ok("directCallEnabled=true", pv.data.directCallEnabled === true);

// 关闭直拨 → 不再返回号码
await call("PUT", "/api/admin/config", { token, body: { direct_call_enabled_global: "false" } });
const pv2 = await call("GET", `/api/vehicles/${vehicleToken}/public`);
ok("关闭直拨后 directCall 为 null", pv2.data.directCall === null, JSON.stringify(pv2.data.directCall));

console.log("\n=== 8. 健康检查暴露通道状态 ===");
const h = await call("GET", "/api/health");
ok("健康检查含 channels", typeof h.data.channels === "object", JSON.stringify(h.data.channels));
ok("健康检查含服务商", typeof h.data.smsVendor === "string" && typeof h.data.privacyVendor === "string", `${h.data.smsVendor}/${h.data.privacyVendor}`);

console.log("\n=== 9. 清理 ===");
await call("PUT", "/api/admin/config", { token, body: { direct_call_enabled_global: "true", privacy_vendor: "custom", privacy_call_webhook_url: "https://example.com/privacy-hook" } });
for (const id of createdIds) await call("DELETE", `/api/admin/vehicles/${id}`, { token });
const del = await call("DELETE", `/api/owner/${ownerToken}/vehicle`);
ok("删除测试车辆", del.status === 200);

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
