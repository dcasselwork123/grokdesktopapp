@echo off
setlocal
title Grok Desktop
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js is not installed or not on PATH.
  echo Install from https://nodejs.org then try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo npm install failed.
    echo.
    pause
    exit /b 1
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo Electron still missing after install.
  echo.
  pause
  exit /b 1
)

echo Starting Grok Desktop...
echo If a window does not appear, read any error below.
echo.

REM Run in this console so errors are visible (not a flash-and-gone start)
"node_modules\electron\dist\electron.exe" . 1>"%TEMP%\grok-desktop-out.log" 2>"%TEMP%\grok-desktop-err.log"
set EXITCODE=%ERRORLEVEL%

if %EXITCODE% neq 0 (
  echo.
  echo Grok Desktop exited with code %EXITCODE%.
  echo.
  if exist "%TEMP%\grok-desktop-err.log" type "%TEMP%\grok-desktop-err.log"
  if exist "%TEMP%\grok-desktop-out.log" type "%TEMP%\grok-desktop-out.log"
  echo.
  pause
  exit /b %EXITCODE%
)

REM Electron closed normally (user closed the window)
exit /b 0
