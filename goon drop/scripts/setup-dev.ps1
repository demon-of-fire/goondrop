# Goon Drop Development Setup Script (Windows)
# Run this script to install all dependencies and start development

Write-Host "╭──────────────────────────────────────────╮" -ForegroundColor Cyan
Write-Host "│         Goon Drop Setup Script             │" -ForegroundColor Cyan
Write-Host "│       Continuity Ecosystem Setup          │" -ForegroundColor Cyan
Write-Host "╰──────────────────────────────────────────╯" -ForegroundColor Cyan
Write-Host ""

# Check for Node.js
try {
    $nodeVersion = node --version
    Write-Host "✓ Node.js detected: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ Node.js is not installed. Please install Node.js 18+ from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Install root dependencies
Write-Host ""
Write-Host "Installing root dependencies..." -ForegroundColor Yellow
npm install

# Install backend dependencies
Write-Host ""
Write-Host "Installing backend dependencies..." -ForegroundColor Yellow
Set-Location -LiteralPath "backend"
npm install
Set-Location -LiteralPath ".."

# Install frontend dependencies
Write-Host ""
Write-Host "Installing frontend dependencies..." -ForegroundColor Yellow
Set-Location -LiteralPath "frontend"
npm install
Set-Location -LiteralPath ".."

# Generate icons
Write-Host ""
Write-Host "Checking icons..." -ForegroundColor Yellow
node scripts/generate-icons.js

Write-Host ""
Write-Host "╭──────────────────────────────────────────╮" -ForegroundColor Cyan
Write-Host "│       Setup Complete!                     │" -ForegroundColor Cyan
Write-Host "│                                          │" -ForegroundColor Cyan
Write-Host "│  To start development:                   │" -ForegroundColor Cyan
Write-Host "│    npm run dev                           │" -ForegroundColor Cyan
Write-Host "│                                          │" -ForegroundColor Cyan
Write-Host "│  Or start individually:                  │" -ForegroundColor Cyan
Write-Host "│    npm run dev:backend  (port 3941)      │" -ForegroundColor Cyan
Write-Host "│    npm run dev:frontend (port 5173)      │" -ForegroundColor Cyan
Write-Host "│                                          │" -ForegroundColor Cyan
Write-Host "│  For production build:                   │" -ForegroundColor Cyan
Write-Host "│    npm run build                         │" -ForegroundColor Cyan
Write-Host "│    npm start                             │" -ForegroundColor Cyan
Write-Host "╰──────────────────────────────────────────╯" -ForegroundColor Cyan
