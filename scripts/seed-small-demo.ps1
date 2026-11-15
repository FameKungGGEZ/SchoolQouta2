param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot

if ($DryRun) {
  Push-Location $repositoryRoot
  try {
    & node .\scripts\seed-demo-data.mjs --small-demo --dry-run
    if ($LASTEXITCODE -ne 0) {
      throw "Demo seed dry-run failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
  return
}

$secureKey = Read-Host 'Supabase service-role key (input is hidden)' -AsSecureString
$hadPreviousKey = Test-Path Env:\SUPABASE_SERVICE_ROLE_KEY
$previousKey = $env:SUPABASE_SERVICE_ROLE_KEY

try {
  if ($secureKey.Length -eq 0) {
    throw 'A Supabase service-role key is required.'
  }
  $env:SUPABASE_SERVICE_ROLE_KEY = (New-Object System.Net.NetworkCredential('', $secureKey)).Password
  Push-Location $repositoryRoot
  try {
    & node .\scripts\seed-demo-data.mjs --small-demo
    if ($LASTEXITCODE -ne 0) {
      throw "Demo seed failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
} finally {
  if ($hadPreviousKey) {
    $env:SUPABASE_SERVICE_ROLE_KEY = $previousKey
  } else {
    Remove-Item Env:\SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
  }
  $secureKey.Dispose()
}
