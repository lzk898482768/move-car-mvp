param(
  [string]$Config = "worker/wrangler.toml",
  [string]$PagesConfigUrl = "https://nanan910.github.io/move-car-mvp/config.js",
  [string]$NpxPath = "npx",
  [string]$NodePath = "node"
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Resolve-CommandPath {
  param(
    [string]$Preferred,
    [string]$Fallback
  )
  if ($Fallback -and (Test-Path $Fallback)) { return $Fallback }
  if (Get-Command $Preferred -ErrorAction SilentlyContinue) {
    return (Get-Command $Preferred).Source
  }
  throw "$Preferred is required."
}

function Read-PublicWorkerUrl {
  $config = Get-Content public/config.js -Raw
  $match = [regex]::Match($config, 'MOVE_CAR_API_BASE\s*=\s*"([^"]+)"')
  if (-not $match.Success -or -not $match.Groups[1].Value) {
    throw "public/config.js does not contain a Worker API URL."
  }
  return $match.Groups[1].Value.TrimEnd("/")
}

$npx = Resolve-CommandPath $NpxPath "D:\nodejs\npx.cmd"
$node = Resolve-CommandPath $NodePath "D:\nodejs\node.exe"
$env:Path = "$(Split-Path $npx);" + $env:Path
$workerUrl = Read-PublicWorkerUrl

Write-Step "Checking local public config"
$publicConfig = Get-Content public/config.js -Raw
if ($publicConfig -notmatch 'MOVE_CAR_DEMO_MODE\s*=\s*false') {
  throw "public/config.js must set MOVE_CAR_DEMO_MODE = false for production."
}
Write-Host "Worker API: $workerUrl"

Write-Step "Checking GitHub Pages config.js"
try {
  $pagesConfig = (Invoke-WebRequest -Uri $PagesConfigUrl -UseBasicParsing -TimeoutSec 30).Content
  if ($pagesConfig -notmatch [regex]::Escape($workerUrl)) {
    throw "GitHub Pages config.js does not point to $workerUrl."
  }
  if ($pagesConfig -notmatch 'MOVE_CAR_DEMO_MODE\s*=\s*false') {
    throw "GitHub Pages config.js has not disabled demo mode."
  }
  Write-Host "GitHub Pages config points to the production Worker."
} catch {
  Write-Warning "Could not verify GitHub Pages config: $($_.Exception.Message)"
}

Write-Step "Checking Worker secrets"
$secretJson = & $npx wrangler secret list --config $Config
$secretNames = (($secretJson -join "`n") | ConvertFrom-Json).name
$requiredSecrets = @("DATA_ENCRYPTION_KEY", "IP_HASH_SALT")
$missingSecrets = $requiredSecrets | Where-Object { $secretNames -notcontains $_ }
if ($missingSecrets.Count) {
  Write-Warning "Missing Worker secrets: $($missingSecrets -join ', ')"
} else {
  Write-Host "Required Worker secrets are present."
}
if ($secretNames -contains "OCR_DEMO_MODE") {
  if ($secretNames -notcontains "TENCENT_SECRET_ID" -or $secretNames -notcontains "TENCENT_SECRET_KEY") {
    Write-Host "OCR_DEMO_MODE is set. Tencent OCR is optional and currently skipped."
  } else {
    Write-Host "OCR_DEMO_MODE is set, but Tencent OCR secrets are present; real Tencent OCR takes priority."
  }
} elseif ($secretNames -notcontains "TENCENT_SECRET_ID" -or $secretNames -notcontains "TENCENT_SECRET_KEY") {
  Write-Warning "Tencent OCR secrets are missing and OCR_DEMO_MODE is not set. Plate photo OCR will not work until one OCR mode is configured."
}

Write-Step "Checking D1 migrations"
& $npx wrangler d1 migrations list move-car-db --config $Config --remote

Write-Step "Checking Worker health endpoint"
$healthScript = @"
const url = "$workerUrl/api/health";
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await res.json();
  console.log(JSON.stringify({ status: res.status, body }, null, 2));
  if (!res.ok) process.exit(2);
  if (body.status !== "ok") process.exit(3);
} catch (error) {
  console.log(error.message || String(error));
  process.exit(4);
}
"@
$healthScript | & $node --input-type=module
if ($LASTEXITCODE -eq 3) {
  Write-Warning "Worker is reachable but degraded. Check missing items above."
} elseif ($LASTEXITCODE -ne 0) {
  Write-Warning "Could not verify Worker health from this network. Try opening $workerUrl/api/health in a browser."
} else {
  Write-Host "Worker health is ok."
}

Write-Host ""
Write-Host "Production check finished."
