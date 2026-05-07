@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Run full local daily flow on Windows:
REM fetch news -> fetch market data -> verify yesterday -> analyze -> build

set "ROOT=%~dp0.."
pushd "%ROOT%" >nul

if not exist ".env" (
  echo [ERROR] .env file not found in project root.
  echo Create it first using: powershell -ExecutionPolicy Bypass -File .\scripts\setup-env.ps1
  popd >nul
  exit /b 1
)

REM Load .env into current shell (simple KEY=VALUE parser)
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  set "K=%%~A"
  set "V=%%~B"
  if defined K (
    if not "!K:~0,1!"=="#" (
      if not "!K!"=="" (
        set "!K!=!V!"
      )
    )
  )
)

set "NODE_OPTIONS=--max-old-space-size=384"

set "LOG_DIR=logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm-ss"') do set "STAMP=%%I"
set "LOG_FILE=%LOG_DIR%\run-%STAMP%.log"

> "%LOG_FILE%" echo ==================================================
>> "%LOG_FILE%" echo START %DATE% %TIME%
>> "%LOG_FILE%" echo Project: %CD%
>> "%LOG_FILE%" echo ==================================================
echo ==================================================
echo START %DATE% %TIME%
echo Project: %CD%
echo ==================================================

call :run "pnpm fetch-news" || goto :fail
call :run "pnpm fetch-market" || goto :fail
call :run "pnpm fetch-results" || goto :fail
call :run "pnpm fetch-policy" || goto :fail
call :run "pnpm verify" || goto :fail
call :run "pnpm analyze" || goto :fail
call :run "pnpm build" || goto :fail

echo.>> "%LOG_FILE%"
echo [SUCCESS] Full flow completed.>> "%LOG_FILE%"
echo.
echo [SUCCESS] Full flow completed.
echo Log: %LOG_FILE%
popd >nul
exit /b 0

:run
set "CMD=%~1"
echo.>> "%LOG_FILE%"
echo [RUN] %CMD%>> "%LOG_FILE%"
echo.
echo [RUN] %CMD%
cmd /c "%CMD%" >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo [ERROR] Command failed: %CMD%
  echo [ERROR] Command failed: %CMD%>> "%LOG_FILE%"
  exit /b 1
)
exit /b 0

:fail
echo.
echo [FAILED] Flow aborted. Check log: %LOG_FILE%
echo.>> "%LOG_FILE%"
echo [FAILED] Flow aborted.>> "%LOG_FILE%"
popd >nul
exit /b 1
