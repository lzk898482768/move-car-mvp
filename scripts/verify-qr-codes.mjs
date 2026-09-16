// 预生成二维码（批量出码 → 扫码绑定 → 再扫进挪车界面）端到端验证
// 用法：先启动 wrangler dev，再 node scripts/verify-qr-codes.mjs
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
const plate = `苏A${stamp}`;
const PHONE = "13700001234";

console.log("\n=== 1. 管理员登录 + 预置企微通道 ===");
const login = await call("POST", "/api/admin/login", { body: { username: "admin", password: "MoveCar@2026" } });
ok("登录成功", login.status === 200, JSON.stringify(login.data));
const token = login.data?.token;
if (!token) { console.log("无管理员令牌，终止"); process.exit(1); }
await call("PUT", "/api/admin/config", { token, body: { wechat_work_webhook: "https://example.com/wechat-work-hook" } });

console.log("\n=== 2. 批量生成二维码 ===");
const batchNo = `T${stamp}`;
const batch = await call("POST", "/api/admin/qr-codes/batch", { token, body: { count: 5, batchNo, note: "自动化测试" } });
ok("批量生成 201/200", batch.status === 200 || batch.status === 201, JSON.stringify(batch.data));
const codes = batch.data?.codes || [];
ok("返回 5 个令牌", codes.length === 5, JSON.stringify(codes));
ok("批次号正确", batch.data?.batchNo === batchNo, String(batch.data?.batchNo));
ok("令牌格式 qr_ 前缀", codes.every((c) => String(c).startsWith("qr_")), JSON.stringify(codes.slice(0, 2)));

const mainToken = codes[0];
const spareToken = codes[1];
const disableToken = codes[2];
const deleteToken = codes[3];
const bulkToken = codes[4];

console.log("\n=== 3. 扫码解析：未绑定 ===");
let res = await call("GET", `/api/qr/${mainToken}`);
ok("解析 200", res.status === 200, JSON.stringify(res.data));
ok("status = unbound", res.data?.status === "unbound", JSON.stringify(res.data));

console.log("\n=== 4. 车主扫码绑定 ===");
const bind = await call("POST", `/api/qr/${mainToken}/bind`, {
  body: { plateNumber: plate, ownerPhone: PHONE, notifyAllEnabled: true, ownerPin: "2468" },
});
ok("绑定 201", bind.status === 201, JSON.stringify(bind.data));
const vehicleToken = bind.data?.vehicleToken;
const ownerToken = bind.data?.ownerToken;
ok("返回 vehicleToken / ownerToken", Boolean(vehicleToken && ownerToken));

console.log("\n=== 5. 绑定后再次扫码 → 进入挪车界面 ===");
res = await call("GET", `/api/qr/${mainToken}`);
ok("status = bound", res.data?.status === "bound", JSON.stringify(res.data));
ok("返回 vehicleToken", res.data?.vehicleToken === vehicleToken, String(res.data?.vehicleToken));
ok("返回脱敏车牌", Boolean(res.data?.maskedPlate), String(res.data?.maskedPlate));
const pub = await call("GET", `/api/vehicles/${res.data.vehicleToken}/public`);
ok("挪车接口可用（200）", pub.status === 200, JSON.stringify(pub.data));
ok("挪车接口返回车牌", Boolean(pub.data?.maskedPlate));

console.log("\n=== 6. 同一码重复绑定被拒 ===");
const dupBind = await call("POST", `/api/qr/${mainToken}/bind`, {
  body: { plateNumber: `苏B${stamp}`, ownerPhone: PHONE },
});
ok("重复绑定 409", dupBind.status === 409, JSON.stringify(dupBind.data));
ok("错误码 qr_bound", dupBind.data?.error === "qr_bound", JSON.stringify(dupBind.data));

console.log("\n=== 7. 已绑定车牌不能再次绑定其它码 ===");
const dupPlate = await call("POST", `/api/qr/${spareToken}/bind`, {
  body: { plateNumber: plate, ownerPhone: PHONE },
});
ok("相同车牌绑定另一个码 → 409 plate_exists", dupPlate.status === 409 && dupPlate.data?.error === "plate_exists", JSON.stringify(dupPlate.data));

console.log("\n=== 8. 后台列表与统计 ===");
const list = await call("GET", `/api/admin/qr-codes?q=${encodeURIComponent(batchNo)}`, { token });
ok("列表 200", list.status === 200, JSON.stringify(list.data).slice(0, 120));
ok("命中本批 5 条", (list.data?.codes || []).length === 5, String((list.data?.codes || []).length));
const stats = list.data?.stats || {};
ok("统计 total >= 5", (stats.total || 0) >= 5, JSON.stringify(stats));
ok("统计 bound >= 1", (stats.bound || 0) >= 1, JSON.stringify(stats));
ok("统计 unbound >= 4", (stats.unbound || 0) >= 4, JSON.stringify(stats));
ok("批次列表含本批", (list.data?.batches || []).some((b) => b.batchNo === batchNo), JSON.stringify(list.data?.batches));
const boundRow = (list.data?.codes || []).find((c) => c.codeToken === mainToken);
ok("已绑定行带脱敏车牌", Boolean(boundRow?.maskedPlate), JSON.stringify(boundRow));

console.log("\n=== 9. 停用 / 启用 ===");
const boundRowId = boundRow?.id;
const disableRow = (list.data?.codes || []).find((c) => c.codeToken === disableToken);
const off = await call("PATCH", `/api/admin/qr-codes/${disableRow.id}`, { token, body: { status: "disabled" } });
ok("停用 200", off.status === 200, JSON.stringify(off.data));
const offResolve = await call("GET", `/api/qr/${disableToken}`);
ok("停用后扫码 → 410", offResolve.status === 410, String(offResolve.status));
ok("错误码 qr_disabled", offResolve.data?.error === "qr_disabled", JSON.stringify(offResolve.data));
const on = await call("PATCH", `/api/admin/qr-codes/${disableRow.id}`, { token, body: { status: "unbound" } });
ok("重新启用 200", on.status === 200, JSON.stringify(on.data));
const offResolve2 = await call("GET", `/api/qr/${disableToken}`);
ok("启用后可再次扫码", offResolve2.status === 200 && offResolve2.data?.status === "unbound", JSON.stringify(offResolve2.data));
const badStatus = await call("PATCH", `/api/admin/qr-codes/${disableRow.id}`, { token, body: { status: "bound" } });
ok("非法状态被拒 400", badStatus.status === 400, String(badStatus.status));
const boundStatus = await call("PATCH", `/api/admin/qr-codes/${boundRowId}`, { token, body: { status: "disabled" } });
ok("已绑定的码不能改状态 400", boundStatus.status === 400, JSON.stringify(boundStatus.data));

console.log("\n=== 10. 删除规则 ===");
const deleteRow = (list.data?.codes || []).find((c) => c.codeToken === deleteToken);
const delBound = await call("DELETE", `/api/admin/qr-codes/${boundRowId}`, { token });
ok("删除已绑定 → 400", delBound.status === 400, JSON.stringify(delBound.data));
const delUnbound = await call("DELETE", `/api/admin/qr-codes/${deleteRow.id}`, { token });
ok("删除未绑定 → 200", delUnbound.status === 200, JSON.stringify(delUnbound.data));
const delAgain = await call("DELETE", `/api/admin/qr-codes/${deleteRow.id}`, { token });
ok("重复删除 → 404", delAgain.status === 404, String(delAgain.status));
const afterDel = await call("GET", `/api/qr/${deleteToken}`);
ok("被删码扫码 → 404", afterDel.status === 404, String(afterDel.status));

const bulkRow = (list.data?.codes || []).find((c) => c.codeToken === bulkToken);
const bulkDel = await call("POST", "/api/admin/qr-codes/bulk-delete", { token, body: { ids: [bulkRow.id, boundRowId] } });
ok("批量删除 200", bulkDel.status === 200, JSON.stringify(bulkDel.data));
const bulkGone = await call("GET", `/api/qr/${bulkToken}`);
ok("批量删除后 404", bulkGone.status === 404, String(bulkGone.status));
const boundStill = await call("GET", `/api/qr/${mainToken}`);
ok("已绑定的码未被误删", boundStill.status === 200 && boundStill.data?.status === "bound", JSON.stringify(boundStill.data));

console.log("\n=== 11. 车位删除后二维码退回未绑定 ===");
const del = await call("DELETE", `/api/owner/${ownerToken}/vehicle`);
ok("删除车辆 200", del.status === 200, JSON.stringify(del.data));
const afterVehicleDel = await call("GET", `/api/qr/${mainToken}`);
ok("车辆删除后该码退回 unbound", afterVehicleDel.status === 200 && afterVehicleDel.data?.status === "unbound", JSON.stringify(afterVehicleDel.data));

console.log("\n=== 12. 参数校验 ===");
const badCount = await call("POST", "/api/admin/qr-codes/batch", { token, body: { count: 0 } });
ok("数量 0 → 自动纠正为 1", badCount.status === 200 && badCount.data?.count === 1, JSON.stringify(badCount.data));
const badBind = await call("POST", `/api/qr/${spareToken}/bind`, { body: { plateNumber: "bad!!", ownerPhone: PHONE } });
ok("非法车牌被拒 400", badBind.status === 400, JSON.stringify(badBind.data));
const noPhoneBind = await call("POST", `/api/qr/${spareToken}/bind`, { body: { plateNumber: `苏C${stamp}` } });
ok("缺手机号被拒 400", noPhoneBind.status === 400 && noPhoneBind.data?.error === "invalid_phone", JSON.stringify(noPhoneBind.data));
const noAuth = await call("GET", "/api/admin/qr-codes");
ok("未授权访问管理接口 → 401", noAuth.status === 401, String(noAuth.status));

console.log("\n=== 13. 清理 ===");
const finalList = await call("GET", `/api/admin/qr-codes?q=${encodeURIComponent(batchNo)}`, { token });
const cleanupIds = (finalList.data?.codes || []).filter((c) => c.status !== "bound").map((c) => c.id);
if (cleanupIds.length) await call("POST", "/api/admin/qr-codes/bulk-delete", { token, body: { ids: cleanupIds } });
ok("清理本批测试码", true);

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
