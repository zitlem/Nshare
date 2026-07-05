<#
  install-cloudflared.ps1 - cloudflared installer for Windows

  Usage (from a PowerShell prompt in this folder):
      powershell -ExecutionPolicy Bypass -File .\install-cloudflared.ps1

  Detects CPU architecture and installs the cloudflared.exe binary so the
  NShare public-link (Cloudflare tunnel) feature works. Tries winget first,
  then falls back to a direct download from GitHub releases.
#>

$ErrorActionPreference = 'Stop'

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }

# Already installed?
$existing = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($existing) {
    Say "cloudflared already installed: $($existing.Source)"
    & cloudflared --version
    exit 0
}

# Try winget (cleanest, handles PATH for us)
$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) {
    Say "Installing via winget..."
    try {
        winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements -e
        Write-Host ""
        Say "Done. Open a NEW terminal (or restart the server) so PATH updates take effect."
        exit 0
    } catch {
        Say "winget install failed, falling back to direct download..."
    }
}

# Direct download fallback
switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { $arch = 'amd64' }
    'ARM64' { $arch = 'arm64' }
    'x86'   { $arch = '386'   }
    default { $arch = 'amd64' }
}

$url     = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe"
$destDir = Join-Path $env:LOCALAPPDATA 'cloudflared'
$destExe = Join-Path $destDir 'cloudflared.exe'

Say "Downloading cloudflared ($arch) to $destExe"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Invoke-WebRequest -Uri $url -OutFile $destExe

# Add install dir to the USER PATH (persists across sessions) if not already there.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $destDir })) {
    Say "Adding $destDir to your user PATH"
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $destDir } else { "$userPath;$destDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
}
# Make it usable in the current session too.
$env:Path = "$env:Path;$destDir"

Say "Done: $destExe"
& $destExe --version
Write-Host ""
Say "Open a NEW terminal (or restart the NShare server) so PATH updates take effect, then use the QR button."
Say "If PATH still isn't picked up (e.g. running as a service), set in config.json: `"cloudflared_path`": `"$($destExe -replace '\\','\\')`""
