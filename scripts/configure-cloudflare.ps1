param(
  [string]$Repository = "nanan910/move-car-mvp"
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required but was not found."
  }
}

function Read-Required {
  param([string]$Prompt)
  $value = Read-Host $Prompt
  if (-not $value) { throw "$Prompt is required." }
  return $value.Trim()
}

Require-Command gh

$auth = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "GitHub CLI is not logged in. Run gh auth login --with-token first."
}

$accountId = Read-Required "Cloudflare Account ID"
$apiToken = Read-Required "Cloudflare API Token"
$databaseId = Read-Required "Cloudflare D1 database_id"
$workerUrl = Read-Required "Cloudflare Worker API URL"

Write-Host ""
Write-Host "Setting GitHub Actions secrets..."
$accountId | gh secret set CLOUDFLARE_ACCOUNT_ID --repo $Repository
$apiToken | gh secret set CLOUDFLARE_API_TOKEN --repo $Repository

Write-Host "Updating worker/wrangler.toml..."
$wranglerPath = "worker/wrangler.toml"
$wrangler = Get-Content $wranglerPath -Raw
$wrangler = $wrangler -replace 'database_id = ".*"', "database_id = `"$databaseId`""
Set-Content -Path $wranglerPath -Value $wrangler -Encoding UTF8

Write-Host "Updating public/config.js..."
$normalizedWorkerUrl = $workerUrl.TrimEnd("/")
$config = @"
window.MOVE_CAR_API_BASE = "$normalizedWorkerUrl";
window.MOVE_CAR_DEMO_MODE = false;
"@
Set-Content -Path "public/config.js" -Value $config -Encoding UTF8

Write-Host ""
Write-Host "Configuration updated locally."
Write-Host "Next:"
Write-Host "1. Commit README/config changes."
Write-Host "2. Set Worker runtime secrets with wrangler secret put."
Write-Host "3. Trigger the Deploy Cloudflare Worker workflow."
