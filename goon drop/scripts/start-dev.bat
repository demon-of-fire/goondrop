@echo off
echo ╭──────────────────────────────────────────╮
echo │         Goon Drop Developer Start          │
echo ╰──────────────────────────────────────────╯
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed. Please install Node.js 18+.
    pause
    exit /b 1
)

:: Install deps if needed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    cd frontend
    call npm install
    cd ..\backend
    call npm install
    cd ..
)

:: Start dev server
echo Starting Goon Drop in development mode...
echo Backend: http://localhost:3941
echo Frontend: http://localhost:5173
echo.
npm run dev
pause
