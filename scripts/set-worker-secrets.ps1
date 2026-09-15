param(
  [string]$Config = "worker/wrangler.toml",
  [string]$NpxPath = "npx"
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. Install Node.js/npm first, then run npm install."
  }
}

function Resolve-Npx {
  param([string]$Preferred)
  if (Get-Command $Preferred -ErrorAction SilentlyContinue) {
    return (Get-Command $Preferred).Source
  }
  $dDriveNpx = "D:\nodejs\npx.cmd"
  if (Test-Path $dDriveNpx) { return $dDriveNpx }
  throw "npx is required. Install Node.js/npm first, then run npm install."
}

function New-RandomSecret {
  param([int]$Bytes = 32)
  $buffer = New-Object byte[] $Bytes
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try {
    $rng.GetBytes($buffer)
    return [Convert]::ToBase64String($buffer)
  } finally {
    $rng.Dispose()
  }
}

function Read-SecretValue {
  param(
    [string]$Name,
    [switch]$Optional,
    [string]$DefaultValue
  )

  if ($DefaultValue) {
    $useDefault = Read-Host "${Name}: press Enter to auto-generate, or type your own value"
    if (-not $useDefault) { return $DefaultValue }
    return $useDefault
  }

  $value = Read-Host "$Name" -AsSecureString
  if ($value.Length -eq 0 -and $Optional) { return $null }
  if ($value.Length -eq 0) { throw "$Name is required." }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Set-WorkerSecret {
  param(
    [string]$Name,
    [string]$Value
  )
  if (-not $Value) { return }
  Write-Host "Setting $Name..."
  $Value | & $script:Npx wrangler secret put $Name --config $Config
}

$script:Npx = Resolve-Npx $NpxPath
$env:Path = "$(Split-Path $script:Npx);" + $env:Path

if (-not (Test-Path $Config)) {
  throw "Wrangler config not found: $Config"
}

Write-Host "This script sends secrets to Cloudflare via wrangler. Values are not written to the repository."
Write-Host ""

$secrets = [ordered]@{
  DATA_ENCRYPTION_KEY = Read-SecretValue "DATA_ENCRYPTION_KEY" -DefaultValue (New-RandomSecret 32)
  IP_HASH_SALT = Read-SecretValue "IP_HASH_SALT" -DefaultValue (New-RandomSecret 24)
  TENCENT_SECRET_ID = Read-SecretValue "TENCENT_SECRET_ID"
  TENCENT_SECRET_KEY = Read-SecretValue "TENCENT_SECRET_KEY"
  TENCENT_SMS_APP_ID = Read-SecretValue "TENCENT_SMS_APP_ID" -Optional
  TENCENT_SMS_SIGN_NAME = Read-SecretValue "TENCENT_SMS_SIGN_NAME" -Optional
  TENCENT_SMS_TEMPLATE_ID = Read-SecretValue "TENCENT_SMS_TEMPLATE_ID" -Optional
  PRIVACY_CALL_WEBHOOK_URL = Read-SecretValue "PRIVACY_CALL_WEBHOOK_URL" -Optional
  PRIVACY_CALL_WEBHOOK_TOKEN = Read-SecretValue "PRIVACY_CALL_WEBHOOK_TOKEN" -Optional
}

foreach ($entry in $secrets.GetEnumerator()) {
  Set-WorkerSecret $entry.Key $entry.Value
}

Write-Host ""
Write-Host "Worker secrets setup finished."
Write-Host "Open setup.html and call /api/health after deploying the Worker."
