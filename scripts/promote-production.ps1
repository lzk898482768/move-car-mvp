param(
  [string]$Config = "worker/wrangler.toml",
  [string]$NpxPath = "npx",
  [switch]$KeepOcrDemoMode,
  [switch]$SkipCheck
)

$ErrorActionPreference = "Stop"

function Resolve-Npx {
  param([string]$Preferred)
  if (Get-Command $Preferred -ErrorAction SilentlyContinue) {
    return (Get-Command $Preferred).Source
  }
  $dDriveNpx = "D:\nodejs\npx.cmd"
  if (Test-Path $dDriveNpx) { return $dDriveNpx }
  throw "npx is required. Install Node.js/npm first."
}

function Read-SecretText {
  param([string]$Name)
  $value = Read-Host $Name -AsSecureString
  if ($value.Length -eq 0) { throw "$Name is required." }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if (-not (Test-Path $Config)) {
  throw "Wrangler config not found: $Config"
}

$npx = Resolve-Npx $NpxPath
$env:Path = "$(Split-Path $npx);" + $env:Path

Write-Host "This promotes the Worker from OCR demo mode to real Tencent Cloud OCR."
Write-Host "Tencent credentials are sent to Cloudflare Worker secrets and are not written to the repository."
Write-Host ""

$secretId = Read-SecretText "TENCENT_SECRET_ID"
$secretKey = Read-SecretText "TENCENT_SECRET_KEY"

$secretId | & $npx wrangler secret put TENCENT_SECRET_ID --config $Config
$secretKey | & $npx wrangler secret put TENCENT_SECRET_KEY --config $Config

if (-not $KeepOcrDemoMode) {
  Write-Host "Removing OCR_DEMO_MODE..."
  & $npx wrangler secret delete OCR_DEMO_MODE --config $Config --force
}

Write-Host "Deploying Worker..."
& $npx wrangler deploy --config $Config

if (-not $SkipCheck) {
  Write-Host ""
  powershell -ExecutionPolicy Bypass -File scripts\check-production.ps1 -Config $Config -NpxPath $npx
}

Write-Host ""
Write-Host "Production promotion finished."
