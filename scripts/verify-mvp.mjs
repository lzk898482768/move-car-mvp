import { createMockServer } from "./mock-api.mjs";

const server = createMockServer();
const base = await listen(server);

try {
  const created = await post("/api/vehicles", {
    plateNumber: "粤B12345",
    showdocWebhook: "https://showdoc.example/webhook",
    showdocToken: "secret-showdoc-token",
    ownerPhone: "13800138000",
    smsEnabled: true,
    privacyCallEnabled: true,
  });
  assert(created.vehicleToken?.startsWith("veh_"), "vehicleToken should be returned");
  assert(created.ownerToken?.startsWith("own_"), "ownerToken should be returned");

  const publicVehicle = await get(`/api/vehicles/${created.vehicleToken}/public`);
  assert(publicVehicle.maskedPlate === "粤B***45", "public plate should be masked");
  assert(publicVehicle.availableChannels.includes("showdoc"), "showdoc channel should be public");
  assert(publicVehicle.availableChannels.includes("sms"), "sms channel should be public when configured");
  assert(!JSON.stringify(publicVehicle).includes("13800138000"), "public payload must not leak phone");
  assert(!JSON.stringify(publicVehicle).includes("secret-showdoc-token"), "public payload must not leak ShowDoc token");

  const notify = await post(`/api/vehicles/${created.vehicleToken}/notify`, { channel: "showdoc" });
  assert(notify.message.includes("Mock 已发送"), "first notify should succeed");

  const limited = await postRaw(`/api/vehicles/${created.vehicleToken}/notify`, { channel: "showdoc" });
  assert(limited.status === 429, "second notify should be rate limited");

  const owner = await get(`/api/owner/${created.ownerToken}/vehicle`);
  assert(owner.vehicleToken === created.vehicleToken, "owner endpoint should expose vehicle token");
  assert(owner.recentNotifications.length === 1, "owner endpoint should include notification log");
  assert(!JSON.stringify(owner).includes("13800138000"), "owner payload should not echo raw phone");
  assert(!JSON.stringify(owner).includes("secret-showdoc-token"), "owner payload should not echo ShowDoc token");

  console.log("MVP verification passed.");
} finally {
  server.close();
}

function listen(instance) {
  return new Promise((resolve) => {
    instance.listen(0, () => {
      const { port } = instance.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function get(path) {
  const res = await fetch(`${base}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function post(path, body) {
  const res = await postRaw(path, body);
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function postRaw(path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
