# Privacy and Security

This project is designed around a simple rule: visitors can notify the owner, but they must not learn the owner's private contact details.

## Public visitor surface

The visitor page may expose:

- A masked plate number such as `粤B***45`
- Available notification channels
- Notification success, failure, and rate-limit messages

It must not expose:

- Owner phone number
- WeChat identity
- ShowDoc webhook or token
- WeCom/WeChat Work robot webhook or key
- Full vehicle binding configuration
- Tencent Cloud credentials
- Privacy-call service token

## Stored sensitive data

The Cloudflare Worker stores sensitive fields server-side only:

- Owner phone number: encrypted before D1 storage
- ShowDoc token: encrypted before D1 storage
- WeCom/WeChat Work robot webhook: encrypted before D1 storage
- Full plate number: normalized and hashed; public responses use masked plate text
- Visitor IP: hashed with a salt for rate limiting

`DATA_ENCRYPTION_KEY` and `IP_HASH_SALT` must be set as Worker secrets and must never be committed to the repository.

## Tokens

- `vehicleToken` is public and only permits anonymous visitor notification.
- `ownerToken` is private and permits owner-side management of one vehicle binding.
- Regenerate tokens if a QR code or owner management link is leaked.

## Health check

`GET /api/health` returns only boolean configuration status and missing key names. It must not return secret values.

## Demo mode

GitHub Pages points to the deployed Cloudflare Worker. Browser demo mode can still be enabled locally by clearing `MOVE_CAR_API_BASE` and setting `MOVE_CAR_DEMO_MODE = true`; demo data is stored in browser `localStorage` and is not a production data store.

## Production checklist

- Set `DATA_ENCRYPTION_KEY` and `IP_HASH_SALT` via Wrangler secrets.
- Set `CORS_ORIGIN` to the GitHub Pages origin.
- Keep `public/config.js` free of secrets.
- Verify visitor APIs never return phone numbers, webhooks, tokens, or full owner configuration.
- Confirm notification rate limiting before production use.
