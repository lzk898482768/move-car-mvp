param(
  [string]$NodePath = "node"
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $FilePath $($Arguments -join ' ')"
  }
}

Write-Step "Checking required project files"
$required = @(
  "public/index.html",
  "public/owner.html",
  "public/move.html",
  "public/app.js",
  "public/config.js",
  "worker/src/index.js",
  "worker/migrations/0001_initial.sql",
  "worker/wrangler.toml",
  ".github/workflows/pages.yml",
  ".github/workflows/worker.yml",
  "README.md"
)

foreach ($path in $required) {
  if (-not (Test-Path $path)) {
    throw "Missing required file: $path"
  }
}

Write-Step "Running JavaScript syntax checks"
Invoke-Checked $NodePath @("--check", "public/app.js")
Invoke-Checked $NodePath @("--check", "public/config.js")
Invoke-Checked $NodePath @("--check", "worker/src/index.js")
Invoke-Checked $NodePath @("--check", "scripts/serve-public.mjs")
Invoke-Checked $NodePath @("--check", "scripts/mock-api.mjs")
Invoke-Checked $NodePath @("--check", "scripts/verify-mvp.mjs")
Invoke-Checked $NodePath @("--check", "scripts/verify-worker.mjs")
Invoke-Checked $NodePath @("--check", "scripts/verify-production-notifications.mjs")

Write-Step "Running MVP verification"
Invoke-Checked $NodePath @("scripts/verify-mvp.mjs")

Write-Step "Running Worker privacy/rate-limit verification"
Invoke-Checked $NodePath @("scripts/verify-worker.mjs")

Write-Step "Checking PowerShell helper script syntax"
$powerShellScripts = @(
  "scripts/configure-cloudflare.ps1",
  "scripts/set-worker-secrets.ps1",
  "scripts/set-ocr-secrets.ps1",
  "scripts/promote-production.ps1",
  "scripts/verify-production-notifications.ps1",
  "scripts/check-production.ps1"
)
foreach ($script in $powerShellScripts) {
  [scriptblock]::Create((Get-Content -Path $script -Raw)) | Out-Null
}

Write-Step "Checking deployment placeholders"
$wrangler = Get-Content worker/wrangler.toml -Raw
if ($wrangler -match "replace-with-your-d1-database-id") {
  Write-Warning "worker/wrangler.toml still has a placeholder D1 database_id. Replace it after creating the D1 database."
}

$config = Get-Content public/config.js -Raw
if ($config -match 'MOVE_CAR_API_BASE\s*=\s*""') {
  if ($config -match 'MOVE_CAR_DEMO_MODE\s*=\s*true') {
    Write-Host "public/config.js has no Worker API URL; browser demo mode is enabled."
  } else {
    Write-Warning "public/config.js has an empty Worker API URL. Fill it before final GitHub Pages deployment."
  }
}

Write-Host ""
Write-Host "Preflight passed."
