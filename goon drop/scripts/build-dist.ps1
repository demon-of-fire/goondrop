# Build a distributable Goon Drop package for sharing
# Output: goondrop-dist.zip in the project root

param(
    [string]$OutputDir = "."
)

$root = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $root "goondrop-dist"
$frontendDir = Join-Path $root "frontend"
$backendDir = Join-Path $root "backend"

Write-Host "Building Goon Drop distribution package..." -ForegroundColor Cyan

# Build frontend
Write-Host "`nBuilding frontend..." -ForegroundColor Yellow
Set-Location $frontendDir
npm run build
if (-not $?) { Write-Host "Frontend build failed!" -ForegroundColor Red; exit 1 }

# Build backend
Write-Host "`nBuilding backend..." -ForegroundColor Yellow
Set-Location $backendDir
npm run build
if (-not $?) { Write-Host "Backend build failed!" -ForegroundColor Red; exit 1 }

# Clean dist directory
if (Test-Path $distDir) { Remove-Item -Recurse -Force $distDir }
New-Item -ItemType Directory -Path $distDir | Out-Null
New-Item -ItemType Directory -Path "$distDir\backend" | Out-Null
New-Item -ItemType Directory -Path "$distDir\frontend" | Out-Null

# Copy backend
Write-Host "Copying backend..." -ForegroundColor Yellow
Copy-Item "$backendDir\dist" "$distDir\backend\dist" -Recurse
Copy-Item "$backendDir\node_modules" "$distDir\backend\node_modules" -Recurse
Copy-Item "$backendDir\package.json" "$distDir\backend\"

# Copy frontend build
Write-Host "Copying frontend..." -ForegroundColor Yellow
Copy-Item "$frontendDir\dist" "$distDir\frontend\dist" -Recurse

# Copy start script
Copy-Item "$root\start-server.bat" "$distDir\"
Copy-Item "$root\README.md" "$distDir\"

# Create README.txt for distribution
@"
Goon Drop - Windows + iPhone Continuity Ecosystem
=================================================

HOW TO USE:
1. Make sure Node.js is installed (https://nodejs.org)
2. Double-click start-server.bat
3. Open http://localhost:3941 on your laptop
4. Open the HTTPS Network IP shown (e.g. https://192.168.0.24:3942) on your iPhone Safari
5. Tap Share > Add to Home Screen for best experience

REQUIREMENTS:
- Windows 10/11
- Node.js 18+ (free from https://nodejs.org)
- Wi-Fi network (all devices on same network)
- iPhone with Safari

FIREWALL:
If devices can't connect, run in Command Prompt (Admin):
  netsh advfirewall firewall add rule name="Goon Drop HTTPS" dir=in protocol=tcp localport=3942 action=allow

All data stays on your local network. No cloud, no accounts, no tracking.
"@ | Out-File -FilePath "$distDir\README.txt" -Encoding utf8

Write-Host "`n✅ Distribution package created at: $distDir" -ForegroundColor Green
Write-Host "   Size: $(("{0:N2}" -f ((Get-ChildItem $distDir -Recurse | Measure-Object Length -Sum).Sum / 1MB))) MB" -ForegroundColor Green
Write-Host "`nZip this folder and share with anyone!" -ForegroundColor Cyan
