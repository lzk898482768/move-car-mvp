# Worker API Contract

Base URL is the deployed Cloudflare Worker URL. GitHub Pages reads it from `public/config.js`.

All responses are JSON. Visitor-facing APIs must never return owner phone numbers, ShowDoc webhook URLs, ShowDoc tokens, Tencent Cloud credentials, privacy-call tokens, or full owner configuration.

## `DELETE /api/owner/:ownerToken/vehicle`

Deletes one owner-managed vehicle binding and its notification logs. This is intended for owner cleanup and production smoke-test cleanup. The endpoint requires the `ownerToken`; a `vehicleToken` cannot delete or manage a binding.

Response:

```json
{
  "message": "绑定已删除。"
}
```

## `GET /api/health`

Checks backend configuration.

Response:

```json
{
  "status": "ok",
  "d1": true,
  "encryption": true,
  "ocrDemo": true,
  "tencentOcr": false,
  "tencentSms": false,
  "privacyCall": false,
  "missing": []
}
```

`missing` contains configuration names only, never secret values.

## `POST /api/ocr/plate`

Recognizes a plate from an uploaded image.

Request:

- `multipart/form-data`
- field `image`: image file, max 4MB by default

Response:

```json
{
  "plateNumber": "粤B12345",
  "candidates": [{ "plateNumber": "粤B12345", "color": "blue" }],
  "rawRequestId": "tencent-request-id"
}
```

Real Tencent OCR config, optional when `OCR_DEMO_MODE=true`:

- `TENCENT_SECRET_ID`
- `TENCENT_SECRET_KEY`

Temporary demo config:

- `OCR_DEMO_MODE=true`: returns a server-side demo plate only when Tencent Cloud OCR secrets are missing
- `OCR_DEMO_PLATE`: optional demo plate value, defaults to `粤B12345`

Validation errors:

- `missing_image`: no `image` field was uploaded
- `invalid_image_type`: uploaded file is not an image
- `image_too_large`: uploaded image is larger than `MAX_OCR_IMAGE_BYTES` or the default 4MB limit

When Tencent OCR secrets are configured, the Worker forwards the image to Tencent Cloud OCR and does not store the original photo in D1. When `OCR_DEMO_MODE=true` and Tencent OCR secrets are absent, the Worker returns a server-side demo plate so the binding and notification flow can still be demonstrated without paid OCR.

## `POST /api/vehicles`

Creates a vehicle binding and returns both the public visitor token and private owner token.

Request:

```json
{
  "plateNumber": "粤B12345",
  "showdocWebhook": "https://example.com/showdoc-webhook",
  "showdocToken": "optional-token",
  "wechatWorkWebhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
  "ownerPhone": "13800138000",
  "smsEnabled": false,
  "privacyCallEnabled": false
}
```

Response:

```json
{
  "vehicleToken": "veh_xxx",
  "ownerToken": "own_xxx",
  "maskedPlate": "粤B***45"
}
```

Validation:

- `plateNumber`: 5-10 Chinese/letter/digit characters
- At least one notification channel: `showdocWebhook`, `wechatWorkWebhook`, SMS, or privacy-call
- `showdocWebhook`: optional `http` or `https` URL
- `wechatWorkWebhook`: optional `http` or `https` URL
- `ownerPhone`: required when SMS or privacy-call is enabled

Required config:

- `DB`
- `DATA_ENCRYPTION_KEY`

## `GET /api/vehicles/:vehicleToken/public`

Returns anonymous visitor-safe vehicle data.

Response:

```json
{
  "maskedPlate": "粤B***45",
  "availableChannels": ["showdoc", "sms"]
}
```

This endpoint must not return:

- owner phone
- ShowDoc webhook
- ShowDoc token
- `ownerToken`
- full plate number

## `POST /api/vehicles/:vehicleToken/notify`

Sends a move-car notification.

Request:

```json
{
  "channel": "showdoc"
}
```

`channel` may be omitted. The Worker then chooses the first available channel in this order: `wechat_work`, `showdoc`, `sms`, `privacy_call`.

Valid channels:

- `wechat_work`
- `showdoc`
- `sms`
- `privacy_call`

Response:

```json
{
  "message": "已通知车主，请耐心等待。"
}
```

Rate limit:

- Same visitor IP hash and vehicle are limited for 120 seconds.
- Visitor IP is hashed before storage.

## `GET /api/owner/:ownerToken/vehicle`

Returns owner management data for one vehicle.

Response:

```json
{
  "vehicleToken": "veh_xxx",
  "maskedPlate": "粤B***45",
  "showdocEnabled": true,
  "smsEnabled": false,
  "privacyCallEnabled": false,
  "recentNotifications": []
}
```

This endpoint still must not echo raw phone numbers, ShowDoc webhook URLs, or ShowDoc tokens.

## `POST /api/owner/:ownerToken/vehicle/regenerate-token`

Rotates the public visitor `vehicleToken`. Old QR codes stop working immediately, and the owner page should display the newly generated visitor URL/QR code.

Response:

```json
{
  "vehicleToken": "veh_new",
  "maskedPlate": "粤B***45"
}
```

## `PATCH /api/owner/:ownerToken/vehicle`

Updates owner notification settings.

Request:

```json
{
  "showdocWebhook": "https://example.com/new-webhook",
  "showdocToken": "new-token",
  "ownerPhone": "13800138000",
  "smsEnabled": true,
  "privacyCallEnabled": false
}
```

All fields are optional. Phone is required when enabling SMS or privacy-call and no stored phone exists.

## Error Shape

Common errors:

```json
{
  "error": "invalid_phone",
  "message": "请填写有效手机号，或关闭短信/隐私号通知。"
}
```

Configuration errors:

```json
{
  "error": "config_error",
  "message": "后端配置不完整：DB, DATA_ENCRYPTION_KEY",
  "missing": ["DB", "DATA_ENCRYPTION_KEY"]
}
```

Configuration errors use HTTP `503`. Validation errors use HTTP `400`. Rate-limit errors use HTTP `429`.
