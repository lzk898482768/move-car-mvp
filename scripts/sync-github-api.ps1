param(
  [string]$Repo = "nanan910/move-car-mvp",
  [string]$Branch = "main",
  [Parameter(Mandatory = $true)]
  [string]$Message,
  [Parameter(Mandatory = $true)]
  [string[]]$Files
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI 'gh' is required."
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$normalizedFiles = @($Files) + @($args) |
  ForEach-Object { $_ -split "," } |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ }

foreach ($path in $normalizedFiles) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "File not found: $path"
  }

  $resolved = Resolve-Path -LiteralPath $path
  $repoPath = $path.Replace("\", "/")
  Write-Step "Uploading $repoPath"

  $sha = $null
  try {
    $shaOutput = & gh api "repos/$Repo/contents/$repoPath" --jq ".sha" 2>$null
    if ($LASTEXITCODE -eq 0) { $sha = $shaOutput }
  } catch {
    $sha = $null
  }

  $base64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($resolved))
  $body = [ordered]@{
    message = $Message
    content = $base64
    branch = $Branch
  }
  if ($sha) { $body.sha = $sha }

  $tmp = Join-Path $env:TEMP ("move-car-upload-" + [guid]::NewGuid().ToString() + ".json")
  [System.IO.File]::WriteAllText($tmp, ($body | ConvertTo-Json -Depth 4 -Compress), $utf8NoBom)
  try {
    gh api "repos/$Repo/contents/$repoPath" --method PUT --input $tmp | Out-Null
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "GitHub API sync finished."
