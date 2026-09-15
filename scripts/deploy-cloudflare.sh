#!/usr/bin/env bash
# 非交互式 Cloudflare 全栈部署：Worker 后端 + D1 + 前端 Pages
# 适用：已重构为 Worker-only 的前端（public/config.js 由 MOVE_CAR_API_BASE 驱动）
#
# 用法：
#   export CLOUDFLARE_API_TOKEN=xxxx          # 必填：含 Workers Scripts:Edit + D1:Edit 权限
#   export CLOUDFLARE_ACCOUNT_ID=xxxx         # 必填
#   export D1_DATABASE_ID=xxxx                # 可选：覆盖 worker/wrangler.toml 里的 database_id
#   export WORKER_URL=https://move-car-api.<sub>.workers.dev   # 可选：不填则自动从部署输出解析
#   export PAGES_PROJECT=move-car             # 可选：Pages 项目名，默认 move-car
#   # 可选通知渠道（不填则后端可跑，但对应渠道不可用，可后续补）
#   export TENCENT_SECRET_ID= TENCENT_SECRET_KEY= TENCENT_SMS_APP_ID= TENCENT_SMS_SIGN_NAME= TENCENT_SMS_TEMPLATE_ID= PRIVACY_CALL_WEBHOOK_URL= PRIVACY_CALL_WEBHOOK_TOKEN=
#   bash scripts/deploy-cloudflare.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?请设置 CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?请设置 CLOUDFLARE_ACCOUNT_ID}"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

PAGES_PROJECT="${PAGES_PROJECT:-move-car}"

echo "== [1/6] 安装依赖 (wrangler) =="
npm install

# 可选：覆盖 D1 database_id（写回 wrangler.toml 本地文件）
if [ -n "${D1_DATABASE_ID:-}" ]; then
  echo "覆盖 wrangler.toml database_id -> $D1_DATABASE_ID"
  node -e "const fs=require('fs');const p='worker/wrangler.toml';let s=fs.readFileSync(p,'utf8');s=s.replace(/database_id = \".*\"/,'database_id = \"'+process.env.D1_DATABASE_ID+'\"');fs.writeFileSync(p,s);"
fi

echo "== [2/6] D1 数据库迁移 =="
npx wrangler d1 migrations apply move-car-db --config worker/wrangler.toml --remote

echo "== [3/6] 部署 Worker =="
DEPLOY_OUT=$(npx wrangler deploy --config worker/wrangler.toml 2>&1 | tee /dev/stderr)
WORKER_URL="${WORKER_URL:-$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)}"
if [ -z "$WORKER_URL" ]; then
  echo "⚠️ 无法自动解析 Worker URL，请手动设置 WORKER_URL 后重跑 [5][6] 步。"
  exit 1
fi
echo "Worker URL = $WORKER_URL"

echo "== [4/6] 设置 Worker 运行时 secrets（密钥不落盘） =="
gen() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('base64'))"; }
echo "${DATA_ENCRYPTION_KEY:-$(gen 32)}" | npx wrangler secret put DATA_ENCRYPTION_KEY --config worker/wrangler.toml
echo "${IP_HASH_SALT:-$(gen 24)}"        | npx wrangler secret put IP_HASH_SALT --config worker/wrangler.toml
[ -n "${TENCENT_SECRET_ID:-}" ]      && echo "$TENCENT_SECRET_ID"      | npx wrangler secret put TENCENT_SECRET_ID --config worker/wrangler.toml
[ -n "${TENCENT_SECRET_KEY:-}" ]     && echo "$TENCENT_SECRET_KEY"     | npx wrangler secret put TENCENT_SECRET_KEY --config worker/wrangler.toml
[ -n "${TENCENT_SMS_APP_ID:-}" ]     && echo "$TENCENT_SMS_APP_ID"     | npx wrangler secret put TENCENT_SMS_APP_ID --config worker/wrangler.toml
[ -n "${TENCENT_SMS_SIGN_NAME:-}" ]  && echo "$TENCENT_SMS_SIGN_NAME"  | npx wrangler secret put TENCENT_SMS_SIGN_NAME --config worker/wrangler.toml
[ -n "${TENCENT_SMS_TEMPLATE_ID:-}" ]&& echo "$TENCENT_SMS_TEMPLATE_ID"| npx wrangler secret put TENCENT_SMS_TEMPLATE_ID --config worker/wrangler.toml
[ -n "${PRIVACY_CALL_WEBHOOK_URL:-}" ] && echo "$PRIVACY_CALL_WEBHOOK_URL" | npx wrangler secret put PRIVACY_CALL_WEBHOOK_URL --config worker/wrangler.toml
[ -n "${PRIVACY_CALL_WEBHOOK_TOKEN:-}" ] && echo "$PRIVACY_CALL_WEBHOOK_TOKEN" | npx wrangler secret put PRIVACY_CALL_WEBHOOK_TOKEN --config worker/wrangler.toml

echo "== [5/6] 写入前端 API 地址 (public/config.js) =="
cat > public/config.js <<EOF
// 由 scripts/deploy-cloudflare.sh 自动生成
window.MOVE_CAR_API_BASE = "${WORKER_URL}";
window.MOVE_CAR_DEMO_MODE = false;
EOF

echo "== [6/6] 部署前端到 Cloudflare Pages =="
npx wrangler pages project create "$PAGES_PROJECT" --production-branch=main </dev/null 2>/dev/null || true
npx wrangler pages deploy public --project-name="$PAGES_PROJECT" --branch=main

echo ""
echo "✅ 部署完成"
echo "   前端:  https://${PAGES_PROJECT}.pages.dev"
echo "   后端:  ${WORKER_URL}"
echo "   体检:  ${WORKER_URL}/api/health"
