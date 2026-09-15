param(
  [Parameter(Mandatory = $true)]
  [string]$RepoName,

  [ValidateSet("public", "private")]
  [string]$Visibility = "public",

  [string]$CommitMessage = "Initial move car MVP"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git is not available. Install Git for Windows first, then rerun this script."
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI is not available. Install gh first, then rerun this script."
}

gh auth status | Out-Null

if (-not (Test-Path ".git")) {
  git init
}

git add .
git commit -m $CommitMessage

$visibilityFlag = if ($Visibility -eq "private") { "--private" } else { "--public" }
gh repo create $RepoName $visibilityFlag --source=. --remote=origin --push

Write-Host ""
Write-Host "Published to GitHub repository: $RepoName"
Write-Host "Next: enable GitHub Pages with GitHub Actions, then share the static site URL."
