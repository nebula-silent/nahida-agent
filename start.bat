@echo off
cd /d %~dp0
title nahida

rem ============ First run: install dependencies ============
if not exist node_modules (
  echo [nahida] node_modules not found, running npm install...
  call npm install --ignore-scripts
  if errorlevel 1 (
    echo [nahida] npm install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

rem ============ Ensure Electron binary is present ============
if not exist "node_modules\electron\dist\electron.exe" (
  echo [nahida] Electron binary missing, downloading via npmmirror...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  pushd node_modules\electron
  node install.js
  popd
  if not exist "node_modules\electron\dist\electron.exe" (
    echo [nahida] WARNING: Electron binary download failed. Check network and retry.
    pause
    exit /b 1
  )
  echo [nahida] Electron binary ready.
)

rem ============ Menu ============
echo.
echo  ================================
echo   nahida launcher
echo   [1] Dev mode (Vite hot reload)
echo   [2] Production (build, then run)
echo   [3] Build only, do not start
echo  ================================
set /p choice=Select [1/2/3] (Enter = 1):
if "%choice%"=="" set choice=1

if "%choice%"=="1" (
  echo [nahida] Starting dev mode... press Ctrl+C to stop.
  call npm run dev
  goto end
)
if "%choice%"=="2" (
  echo [nahida] Building...
  call npm run build
  if errorlevel 1 (
    echo [nahida] Build failed.
    pause
    exit /b 1
  )
  echo [nahida] Starting production...
  call npm start
  goto end
)
if "%choice%"=="3" (
  call npm run build
  goto end
)
echo [nahida] Invalid choice.

:end
pause
