# Goon Drop Quick Start for Windows
# Run this script to build and start the production server

param(
    [switch]$Dev,
    [switch]$Build
)

$rootDir = Split-Path -Parent $PSScriptRoot

Write-Host "╭──────────────────────────────────────────╮" -ForegroundColor Cyan
Write-Host "│         Goon Drop Quick Start              │" -ForegroundColor Cyan
Write-Host "╰──────────────────────────────────────────╯" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVer = node --version
    Write-Host "✓ Node.js $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "✗ Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Check if dependencies are installed
$depsMissing = $false
if (-not (Test-Path "$rootDir\node_modules")) { $depsMissing = $true }
if (-not (Test-Path "$rootDir\frontend\node_modules")) { $depsMissing = $true }
if (-not (Test-Path "$rootDir\backend\node_modules")) { $depsMissing = $true }

if ($depsMissing) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    Set-Location -LiteralPath $rootDir
    npm install
    Set-Location -LiteralPath "$rootDir\frontend"
    npm install
    Set-Location -LiteralPath "$rootDir\backend"
    npm install
    Set-Location -LiteralPath $rootDir
}

if ($Dev) {
    # Start development mode
    Write-Host ""
    Write-Host "Starting in development mode..." -ForegroundColor Yellow
    Write-Host "  Backend:  http://localhost:3941" -ForegroundColor Cyan
    Write-Host "  Frontend: http://localhost:5173" -ForegroundColor Cyan
    npm run dev
} else {
    # Always build before starting: serving an old dist folder hides source fixes.
    Write-Host "Building current production version..." -ForegroundColor Yellow
    Set-Location -LiteralPath $rootDir
    npm run build

    # Start production server
    Write-Host ""
    Write-Host "Starting production server..." -ForegroundColor Yellow
    npm start
}
