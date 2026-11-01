# Signs a published release so the app will take it as an update. Run on the
# maintainer's PC: the signing key must never go on GitHub, or taking over the
# account could push code to everyone who has the app.
#
#   powershell -File scripts\sign-release.ps1 v1.2.3

param([Parameter(Mandatory = $true)][string]$Tag)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$Repo = 'Deaeath/3dx-remote-play'
$Folder = Join-Path $env:APPDATA '3dx-remote-play-signing'
$Key = Join-Path $Folder 'update.key'
if (-not (Test-Path $Key)) { throw "No signing key in $Folder" }

$release = gh api "repos/$Repo/releases/tags/$Tag" | ConvertFrom-Json
$asset = $release.assets | Where-Object { $_.name -like '*setup.exe' } | Select-Object -First 1
if (-not $asset) { throw "$Tag has no installer" }

$work = Join-Path $env:TEMP ("3dx-sign-" + [guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
try {
  gh release download $Tag --repo $Repo --pattern $asset.name --dir $work
  $installer = Join-Path $work $asset.name
  $hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()
  if ($asset.digest -ne "sha256:$hash") { throw 'The installer does not match what GitHub says it published' }

  $sealed = [IO.File]::ReadAllBytes((Join-Path $Folder 'password.dpapi'))
  $password = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'CurrentUser'))
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password
  try {
    $root = Split-Path $PSScriptRoot -Parent
    Push-Location $root
    & cmd.exe /c npx tauri signer sign -f "`"$Key`"" "`"$installer`"" | Out-Null
    Pop-Location
  } finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    $password = $null
  }
  $signature = Join-Path $work ($asset.name + '.sig')
  if (-not (Test-Path $signature)) { throw 'The signer made no signature' }

  $manifest = [ordered]@{
    version  = $Tag.TrimStart('v')
    notes    = "See https://github.com/$Repo/releases/tag/$Tag"
    pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = @{ 'windows-x86_64' = @{ signature = (Get-Content $signature -Raw).Trim(); url = $asset.browser_download_url } }
  }
  $latest = Join-Path $work 'latest.json'
  [IO.File]::WriteAllText($latest, ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
  gh release upload $Tag $latest --repo $Repo --clobber
  "Signed $Tag"
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
