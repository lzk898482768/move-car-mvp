const DEFAULT_WORKER_URL = "https://move-car-api.nanan910-move-car.workers.dev";

async function main() {
  const apiBase = (process.env.MOVE_CAR_API_BASE || DEFAULT_WORKER_URL).replace(/\/+$/, "");
  const showdocWebhook = process.env.SHOWDOC_WEBHOOK || "";
  const showdocToken = process.env.SHOWDOC_TOKEN || "";
  const wechatWorkWebhook = process.env.WECHAT_WORK_WEBHOOK || "";

  if (!showdocWebhook && !wechatWorkWebhook) {
    throw new Error("Set SHOWDOC_WEBHOOK and/or WECHAT_WORK_WEBHOOK before running this verifier.");
  }

  console.log(`Worker API: ${apiBase}`);

  const health = await request(apiBase, "GET", "/api/health");
  console.log(`Health: HTTP ${health.status}, status=${health.body.status}, ocrDemo=${health.body.ocrDemo}`);
  assert(health.status === 200, "Worker health endpoint must be reachable.");

  if (showdocWebhook && wechatWorkWebhook) {
    await verifyCombinedPublicView(apiBase, { showdocWebhook, showdocToken, wechatWorkWebhook });
  }
  if (wechatWorkWebhook) {
    await verifyChannel(apiBase, "wechat_work", {
      plateNumber: "TESTWX01",
      wechatWorkWebhook,
    });
  }
  if (showdocWebhook) {
    await verifyChannel(apiBase, "showdoc", {
      plateNumber: "TESTSD01",
      showdocWebhook,
      showdocToken,
    });
  }

  console.log("Production notification verification finished.");
}

async function verifyCombinedPublicView(apiBase, payload) {
  console.log("Creating combined ShowDoc + WeChat test binding...");
  const created = await request(apiBase, "POST", "/api/vehicles", {
    plateNumber: "TESTALL1",
    ...payload,
  });

  try {
    assert(created.status === 201, `Combined binding should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);
    assert(created.body.vehicleToken && created.body.ownerToken, "Combined binding should return both public and owner tokens.");

    const publicVehicle = await request(apiBase, "GET", `/api/vehicles/${encodeURIComponent(created.body.vehicleToken)}/public`);
    assert(publicVehicle.status === 200, `Public vehicle should return 200, got ${publicVehicle.status}`);
    const text = JSON.stringify(publicVehicle.body);
    assert(publicVehicle.body.availableChannels.includes("wechat_work"), "Public view should expose the WeChat channel name.");
    assert(publicVehicle.body.availableChannels.includes("showdoc"), "Public view should expose the ShowDoc channel name.");
    assert(!text.includes(payload.wechatWorkWebhook), "Public view must not leak the WeChat webhook.");
    assert(!text.includes(payload.showdocWebhook), "Public view must not leak the ShowDoc webhook.");
    if (payload.showdocToken) assert(!text.includes(payload.showdocToken), "Public view must not leak the ShowDoc token.");
    console.log(`Combined binding ok. Owner link token starts with: ${created.body.ownerToken.slice(0, 8)}...`);
  } finally {
    await cleanupBinding(apiBase, created.body?.ownerToken);
  }
}

async function verifyChannel(apiBase, channel, payload) {
  console.log(`Creating ${channel} test binding...`);
  const created = await request(apiBase, "POST", "/api/vehicles", payload);

  try {
    assert(created.status === 201, `${channel} binding should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);

    const publicVehicle = await request(apiBase, "GET", `/api/vehicles/${encodeURIComponent(created.body.vehicleToken)}/public`);
    assert(publicVehicle.status === 200, `${channel} public view should return 200.`);
    assert(publicVehicle.body.availableChannels.includes(channel), `${channel} should be available on public view.`);

    console.log(`Sending ${channel} notification...`);
    const notified = await request(apiBase, "POST", `/api/vehicles/${encodeURIComponent(created.body.vehicleToken)}/notify`, { channel });
    assert(notified.status === 200, `${channel} notify should return 200, got ${notified.status}: ${JSON.stringify(notified.body)}`);
    assert(notified.body.channel === channel, `${channel} notify response should echo the selected channel.`);

    const limited = await request(apiBase, "POST", `/api/vehicles/${encodeURIComponent(created.body.vehicleToken)}/notify`, { channel });
    assert(limited.status === 429, `${channel} second notify should be rate limited, got ${limited.status}.`);
    console.log(`${channel} notification ok and rate limit verified.`);
  } finally {
    await cleanupBinding(apiBase, created.body?.ownerToken);
  }
}

async function cleanupBinding(apiBase, ownerToken) {
  if (!ownerToken) return;
  const deleted = await request(apiBase, "DELETE", `/api/owner/${encodeURIComponent(ownerToken)}/vehicle`);
  if (deleted.status === 200 || deleted.status === 404) {
    console.log(`Cleaned test binding ${ownerToken.slice(0, 8)}...`);
    return;
  }
  console.warn(`Could not clean test binding ${ownerToken.slice(0, 8)}...: HTTP ${deleted.status}`);
}

async function request(apiBase, method, path, body) {
  const init = { method, headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
