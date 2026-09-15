param(
  [string]$ApiBase = ""
)

$ErrorActionPreference = "Stop"

function Read-SecretText {
  param([string]$Prompt)
  $secure = Read-Host $Prompt -AsSecureString
  if ($secure.Length -eq 0) { return "" }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Read-PublicWorkerUrl {
  $config = Get-Content public/config.js -Raw
  $match = [regex]::Match($config, 'MOVE_CAR_API_BASE\s*=\s*"([^"]+)"')
  if (-not $match.Success -or -not $match.Groups[1].Value) {
    return "https://move-car-api.nanan910-move-car.workers.dev"
  }
  return $match.Groups[1].Value.TrimEnd("/")
}

function Invoke-Api {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body = $null
  )

  $uri = "$ApiBase$Path"
  $headers = @{ Accept = "application/json" }
  $params = @{
    Uri = $uri
    Method = $Method
    Headers = $headers
    UseBasicParsing = $true
    TimeoutSec = 30
  }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Compress -Depth 6)
  }

  try {
    $response = Invoke-WebRequest @params
    $json = if ($response.Content) { $response.Content | ConvertFrom-Json } else { @{} }
    return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $json; Raw = $response.Content }
  } catch {
    if ($_.Exception.Response) {
      $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      $content = $reader.ReadToEnd()
      $json = try { $content | ConvertFrom-Json } catch { [pscustomobject]@{ raw = $content } }
      return [pscustomobject]@{ Status = [int]$_.Exception.Response.StatusCode.value__; Body = $json; Raw = $content }
    }
    throw
  }
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Remove-TestBinding {
  param([string]$OwnerToken)
  if (-not $OwnerToken) { return }
  $encoded = [uri]::EscapeDataString($OwnerToken)
  $deleted = Invoke-Api "DELETE" "/api/owner/$encoded/vehicle"
  if ($deleted.Status -eq 200 -or $deleted.Status -eq 404) {
    Write-Host "Cleaned test binding $($OwnerToken.Substring(0, [Math]::Min(8, $OwnerToken.Length)))..."
  } else {
    Write-Warning "Could not clean test binding: HTTP $($deleted.Status) $($deleted.Raw)"
  }
}

function Test-Channel {
  param(
    [string]$Channel,
    [hashtable]$Payload
  )

  Write-Host "Creating $Channel test binding..."
  $created = Invoke-Api "POST" "/api/vehicles" $Payload
  $ownerToken = $created.Body.ownerToken
  try {
    Assert-True ($created.Status -eq 201) "$Channel binding failed: HTTP $($created.Status) $($created.Raw)"
    Assert-True ([bool]$created.Body.vehicleToken) "$Channel binding did not return vehicleToken."
    Assert-True ([bool]$ownerToken) "$Channel binding did not return ownerToken."

    $vehicleToken = [uri]::EscapeDataString($created.Body.vehicleToken)
    $publicVehicle = Invoke-Api "GET" "/api/vehicles/$vehicleToken/public"
    Assert-True ($publicVehicle.Status -eq 200) "$Channel public view failed: HTTP $($publicVehicle.Status)"
    Assert-True ($publicVehicle.Body.availableChannels -contains $Channel) "$Channel is not available in public view."

    Write-Host "Sending $Channel notification..."
    $notified = Invoke-Api "POST" "/api/vehicles/$vehicleToken/notify" @{ channel = $Channel }
    Assert-True ($notified.Status -eq 200) "$Channel notify failed: HTTP $($notified.Status) $($notified.Raw)"

    $limited = Invoke-Api "POST" "/api/vehicles/$vehicleToken/notify" @{ channel = $Channel }
    Assert-True ($limited.Status -eq 429) "$Channel second notify should be rate limited, got HTTP $($limited.Status)."
    Write-Host "$Channel notification ok and rate limit verified."
  } finally {
    Remove-TestBinding $ownerToken
  }
}

if (-not $ApiBase) { $ApiBase = Read-PublicWorkerUrl }

Write-Host "This will create disposable production test bindings and send real notifications."
Write-Host "Leave a field empty to skip that channel. Values are not written to the repository."
Write-Host ""

$showdocWebhook = Read-SecretText "SHOWDOC_WEBHOOK"
$showdocToken = Read-SecretText "SHOWDOC_TOKEN optional"
$wechatWorkWebhook = Read-SecretText "WECHAT_WORK_WEBHOOK"

if (-not $showdocWebhook -and -not $wechatWorkWebhook) {
  throw "Provide at least SHOWDOC_WEBHOOK or WECHAT_WORK_WEBHOOK."
}

Write-Host "Worker API: $ApiBase"
$health = Invoke-Api "GET" "/api/health"
Write-Host "Health: HTTP $($health.Status), status=$($health.Body.status), ocrDemo=$($health.Body.ocrDemo)"
Assert-True ($health.Status -eq 200) "Worker health endpoint must be reachable."

if ($wechatWorkWebhook) {
  Test-Channel "wechat_work" @{
    plateNumber = "TESTWX01"
    wechatWorkWebhook = $wechatWorkWebhook
  }
}

if ($showdocWebhook) {
  Test-Channel "showdoc" @{
    plateNumber = "TESTSD01"
    showdocWebhook = $showdocWebhook
    showdocToken = $showdocToken
  }
}

Write-Host "Production notification verification finished."
