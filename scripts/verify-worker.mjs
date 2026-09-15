import worker from "../worker/src/index.js";

const originalFetch = globalThis.fetch;
let env;

async function main() {
  const db = new FakeD1();
  const sentWebhooks = [];
  env = testEnv(db);
  globalThis.fetch = mockFetch(sentWebhooks);

  try {
    const health = await call("GET", "/api/health");
    const healthText = JSON.stringify(health.body);
    assert(health.status === 200, "health should return 200");
    assert(health.body.status === "degraded", "health status should be degraded when optional production secrets are missing");
    assert(health.body.d1 === true, "health should report D1 binding");
    assert(health.body.encryption === true, "health should report encryption key presence");
    assert(Array.isArray(health.body.missing), "health should include missing config list");
    assert(health.body.missing.length === 2, "health should report missing Tencent OCR config in test env");
    assert(!healthText.includes("test-encryption-key"), "health must not leak secrets");

    const badOcrForm = new FormData();
    badOcrForm.set("image", new Blob(["not a plate image"], { type: "text/plain" }), "plate.txt");
    const badOcr = await callRequest(
      new Request("https://api.example.test/api/ocr/plate", {
        method: "POST",
        headers: new Headers({ "CF-Connecting-IP": "203.0.113.8" }),
        body: badOcrForm,
      })
    );
    assert(badOcr.status === 400, "invalid OCR upload should return 400");
    assert(badOcr.body.error === "invalid_image_type", "invalid OCR upload should return a typed error");

    const demoEnv = env;
    env = { ...env, OCR_DEMO_MODE: "true", OCR_DEMO_PLATE: "粤B54321" };
    const demoHealth = await call("GET", "/api/health");
    assert(demoHealth.body.status === "ok", "OCR demo mode should satisfy OCR health when Tencent secrets are missing");
    assert(demoHealth.body.ocrDemo === true, "health should report active OCR demo mode");
    const demoOcrForm = new FormData();
    demoOcrForm.set("image", new Blob(["fake image bytes"], { type: "image/jpeg" }), "plate.jpg");
    const demoOcr = await callRequest(
      new Request("https://api.example.test/api/ocr/plate", {
        method: "POST",
        headers: new Headers({ "CF-Connecting-IP": "203.0.113.8" }),
        body: demoOcrForm,
      })
    );
    assert(demoOcr.status === 200, "OCR demo mode should return 200 without Tencent secrets");
    assert(demoOcr.body.demo === true, "OCR demo response should be marked as demo");
    assert(demoOcr.body.plateNumber === "粤B54321", "OCR demo should return configured demo plate");

    env = { ...env, TENCENT_SECRET_ID: "test-secret-id", TENCENT_SECRET_KEY: "test-secret-key" };
    const realHealth = await call("GET", "/api/health");
    assert(realHealth.body.status === "ok", "Tencent OCR secrets should satisfy health even if OCR demo secret remains set");
    assert(realHealth.body.ocrDemo === false, "health should report OCR demo inactive when Tencent OCR is configured");
    const realOcrForm = new FormData();
    realOcrForm.set("image", new Blob(["fake image bytes"], { type: "image/jpeg" }), "plate.jpg");
    const realOcr = await callRequest(
      new Request("https://api.example.test/api/ocr/plate", {
        method: "POST",
        headers: new Headers({ "CF-Connecting-IP": "203.0.113.8" }),
        body: realOcrForm,
      })
    );
    assert(realOcr.status === 200, "Tencent OCR should be used when secrets are present");
    assert(realOcr.body.demo !== true, "Tencent OCR response should not be marked as demo");
    assert(realOcr.body.plateNumber === "粤B99999", "Tencent OCR mock should return OCR result");
    env = demoEnv;

    const invalidWebhook = await call("POST", "/api/vehicles", {
      plateNumber: "粤B12345",
      showdocWebhook: "ftp://showdoc.example/webhook",
    });
    assert(invalidWebhook.status === 400, "invalid webhook should return 400");
    assert(invalidWebhook.body.error === "invalid_showdoc_webhook", "invalid webhook should return a typed error");

    const missingChannel = await call("POST", "/api/vehicles", {
      plateNumber: "粤B12345",
    });
    assert(missingChannel.status === 400, "vehicle without notification channel should return 400");
    assert(missingChannel.body.error === "missing_notification_channel", "missing channel should return a typed error");

    const missingPhone = await call("POST", "/api/vehicles", {
      plateNumber: "粤B12345",
      showdocWebhook: "https://showdoc.example/webhook",
      smsEnabled: true,
    });
    assert(missingPhone.status === 400, "sms without phone should return 400");
    assert(missingPhone.body.error === "invalid_phone", "sms without phone should return a typed error");

    const created = await call("POST", "/api/vehicles", {
      plateNumber: "粤B12345",
      showdocWebhook: "https://showdoc.example/webhook",
      showdocToken: "private-showdoc-token",
      ownerPhone: "13800138000",
      smsEnabled: true,
      privacyCallEnabled: true,
    });
    assert(created.status === 201, "create vehicle should return 201");
    assert(created.body.vehicleToken.startsWith("veh_"), "vehicleToken should be returned");
    assert(created.body.ownerToken.startsWith("own_"), "ownerToken should be returned");

    const publicVehicle = await call("GET", `/api/vehicles/${created.body.vehicleToken}/public`);
    const publicText = JSON.stringify(publicVehicle.body);
    assert(publicVehicle.status === 200, "public vehicle should return 200");
    assert(publicVehicle.body.maskedPlate === "粤B***45", "public plate should be masked");
    assert(publicVehicle.body.availableChannels.includes("showdoc"), "showdoc should be available");
    assert(!publicText.includes("13800138000"), "public response must not leak phone");
    assert(!publicText.includes("private-showdoc-token"), "public response must not leak ShowDoc token");
    assert(!publicText.includes("https://showdoc.example"), "public response must not leak ShowDoc webhook");

    const wechatVehicle = await call("POST", "/api/vehicles", {
      plateNumber: "粤B54321",
      wechatWorkWebhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private-wechat-key",
    });
    assert(wechatVehicle.status === 201, "create vehicle with WeCom webhook should return 201");
    const wechatPublic = await call("GET", `/api/vehicles/${wechatVehicle.body.vehicleToken}/public`);
    const wechatPublicText = JSON.stringify(wechatPublic.body);
    assert(wechatPublic.body.availableChannels.includes("wechat_work"), "WeCom channel should be public as a channel only");
    assert(!wechatPublicText.includes("private-wechat-key"), "public response must not leak WeCom webhook");
    const wechatNotify = await call("POST", `/api/vehicles/${wechatVehicle.body.vehicleToken}/notify`, {});
    assert(wechatNotify.status === 200, "default notify should return 200 for WeCom vehicle");
    assert(wechatNotify.body.channel === "wechat_work", "default notify should prefer WeCom channel");
    assert(sentWebhooks.some((item) => item.kind === "wechat_work"), "WeCom webhook should be called once");

    const notify = await call("POST", `/api/vehicles/${created.body.vehicleToken}/notify`, { channel: "showdoc" });
    assert(notify.status === 200, "first notify should return 200");
    const showdocCalls = sentWebhooks.filter((item) => item.kind === "showdoc");
    assert(showdocCalls.length === 1, "ShowDoc webhook should be called once");
    assert(showdocCalls[0].token === "private-showdoc-token", "ShowDoc token should only be sent server-side");
    assert(showdocCalls[0].title === "扫码挪车提醒", "ShowDoc should receive a push title");
    assert(showdocCalls[0].content?.includes(created.body.maskedPlate), "ShowDoc should receive the masked plate in content");
    assert(showdocCalls[0].contentType.includes("application/x-www-form-urlencoded"), "ShowDoc should receive form-encoded data");

    const limited = await call("POST", `/api/vehicles/${created.body.vehicleToken}/notify`, { channel: "showdoc" });
    assert(limited.status === 429, "second notify should be rate limited");

    const owner = await call("GET", `/api/owner/${created.body.ownerToken}/vehicle`);
    const ownerText = JSON.stringify(owner.body);
    assert(owner.status === 200, "owner vehicle should return 200");
    assert(owner.body.vehicleToken === created.body.vehicleToken, "owner response should include vehicle token");
    assert(owner.body.recentNotifications.length === 1, "owner response should include notification log");
    assert(!ownerText.includes("13800138000"), "owner response must not echo raw phone");
    assert(!ownerText.includes("private-showdoc-token"), "owner response must not echo ShowDoc token");
    assert(!ownerText.includes("https://showdoc.example"), "owner response must not echo ShowDoc webhook");
    assert(!ownerText.includes("private-wechat-key"), "owner response must not echo WeCom webhook");

    const regenerated = await call("POST", `/api/owner/${created.body.ownerToken}/vehicle/regenerate-token`, {});
    assert(regenerated.status === 200, "regenerate vehicle token should return 200");
    assert(regenerated.body.vehicleToken.startsWith("veh_"), "regenerate should return a vehicle token");
    assert(regenerated.body.vehicleToken !== created.body.vehicleToken, "regenerate should rotate the public vehicle token");
    const oldPublicVehicle = await call("GET", `/api/vehicles/${created.body.vehicleToken}/public`);
    assert(oldPublicVehicle.status === 404, "old vehicle token should stop working after regeneration");
    const newPublicVehicle = await call("GET", `/api/vehicles/${regenerated.body.vehicleToken}/public`);
    assert(newPublicVehicle.status === 200, "new vehicle token should work after regeneration");

    const patch = await call("PATCH", `/api/owner/${created.body.ownerToken}/vehicle`, {
      smsEnabled: false,
      privacyCallEnabled: false,
    });
    assert(patch.status === 200, "owner patch should return 200");

    const deleted = await call("DELETE", `/api/owner/${created.body.ownerToken}/vehicle`);
    assert(deleted.status === 200, "owner delete should return 200");
    const deletedPublicVehicle = await call("GET", `/api/vehicles/${regenerated.body.vehicleToken}/public`);
    assert(deletedPublicVehicle.status === 404, "deleted vehicle token should stop working");
    const deletedOwner = await call("GET", `/api/owner/${created.body.ownerToken}/vehicle`);
    assert(deletedOwner.status === 404, "deleted owner token should stop working");
    assert(db.logs.every((item) => item.vehicle_id !== 1), "delete should remove notification logs for the vehicle");

    console.log("Worker verification passed.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testEnv(fakeDb) {
  return {
    DB: fakeDb,
    DATA_ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough",
    IP_HASH_SALT: "test-ip-salt",
    CORS_ORIGIN: "https://example.github.io",
  };
}

function mockFetch(webhookCalls) {
  return async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://showdoc.example/")) {
      const form = new URLSearchParams(String(init?.body || ""));
      webhookCalls.push({
        kind: "showdoc",
        title: form.get("title"),
        content: form.get("content"),
        token: form.get("token"),
        contentType: init?.headers?.["Content-Type"] || init?.headers?.get?.("Content-Type") || "",
      });
      return new Response(JSON.stringify({ error_code: 0, error_message: "ok" }), { status: 200 });
    }
    if (url.startsWith("https://qyapi.weixin.qq.com/")) {
      webhookCalls.push({ kind: "wechat_work", ...JSON.parse(init?.body || "{}") });
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    }
    if (url === "https://ocr.tencentcloudapi.com") {
      return new Response(JSON.stringify({ Response: { Number: "粤B99999", Color: "blue", RequestId: "ocr-test" } }), {
        status: 200,
      });
    }
    return originalFetch(input, init);
  };
}

async function call(method, path, body) {
  const headers = new Headers({ "CF-Connecting-IP": "203.0.113.8" });
  let requestBody;
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    requestBody = JSON.stringify(body);
  }
  const request = new Request(`https://api.example.test${path}`, { method, headers, body: requestBody });
  return callRequest(request);
}

async function callRequest(request) {
  const response = await worker.fetch(request, env);
  return { status: response.status, body: await response.json() };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class FakeD1 {
  constructor() {
    this.vehicles = [];
    this.logs = [];
    this.nextVehicleId = 1;
    this.nextLogId = 1;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO vehicles")) {
      const [
        vehicle_token,
        owner_token,
        plate_number_masked,
        plate_number_hash,
        owner_phone_encrypted,
        showdoc_webhook,
        showdoc_token_encrypted,
        wechat_work_webhook_encrypted,
        sms_enabled,
        privacy_call_enabled,
        created_at,
        updated_at,
      ] = this.values;
      this.db.vehicles.push({
        id: this.db.nextVehicleId++,
        vehicle_token,
        owner_token,
        plate_number_masked,
        plate_number_hash,
        owner_phone_encrypted,
        showdoc_webhook,
        showdoc_token_encrypted,
        wechat_work_webhook_encrypted,
        sms_enabled,
        privacy_call_enabled,
        created_at,
        updated_at,
      });
      return { success: true };
    }

    if (this.sql.startsWith("INSERT INTO notification_logs")) {
      const [vehicle_id, channel, status, error_summary, visitor_ip_hash, created_at] = this.values;
      this.db.logs.push({
        id: this.db.nextLogId++,
        vehicle_id,
        channel,
        status,
        error_summary,
        visitor_ip_hash,
        created_at,
      });
      return { success: true };
    }

    if (this.sql.startsWith("UPDATE vehicles SET")) {
      const id = this.values.at(-1);
      const vehicle = this.db.vehicles.find((item) => item.id === id);
      if (!vehicle) return { success: false };
      const assignments = this.sql.match(/UPDATE vehicles SET (.*) WHERE id = \?/)?.[1].split(", ") || [];
      assignments.forEach((assignment, index) => {
        const column = assignment.split(" = ")[0];
        vehicle[column] = this.values[index];
      });
      return { success: true };
    }

    if (this.sql === "DELETE FROM notification_logs WHERE vehicle_id = ?") {
      const [vehicleId] = this.values;
      this.db.logs = this.db.logs.filter((item) => item.vehicle_id !== vehicleId);
      return { success: true };
    }

    if (this.sql === "DELETE FROM vehicles WHERE id = ?") {
      const [id] = this.values;
      this.db.vehicles = this.db.vehicles.filter((item) => item.id !== id);
      return { success: true };
    }

    throw new Error(`Unhandled run SQL: ${this.sql}`);
  }

  async first() {
    if (this.sql === "SELECT * FROM vehicles WHERE vehicle_token = ?") {
      return this.db.vehicles.find((item) => item.vehicle_token === this.values[0]) || null;
    }
    if (this.sql === "SELECT * FROM vehicles WHERE owner_token = ?") {
      return this.db.vehicles.find((item) => item.owner_token === this.values[0]) || null;
    }
    if (this.sql.startsWith("SELECT id FROM notification_logs")) {
      const [vehicleId, visitorHash, cutoff] = this.values;
      return (
        this.db.logs
          .filter((item) => item.vehicle_id === vehicleId && item.visitor_ip_hash === visitorHash && item.created_at > cutoff)
          .sort((a, b) => b.id - a.id)[0] || null
      );
    }
    throw new Error(`Unhandled first SQL: ${this.sql}`);
  }

  async all() {
    if (this.sql.startsWith("SELECT channel, status, error_summary, created_at FROM notification_logs")) {
      const [vehicleId] = this.values;
      return {
        results: this.db.logs
          .filter((item) => item.vehicle_id === vehicleId)
          .sort((a, b) => b.id - a.id)
          .slice(0, 10)
          .map(({ channel, status, error_summary, created_at }) => ({ channel, status, error_summary, created_at })),
      };
    }
    throw new Error(`Unhandled all SQL: ${this.sql}`);
  }
}

await main();
