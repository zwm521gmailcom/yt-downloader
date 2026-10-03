@echo off
REM ---------------------------------------------------------------------------
REM  Start the launcher service, which lets the extension start the bridge.
REM
REM  ASCII-only on purpose: see start-bridge.cmd.utf8 for the reasoning.
REM
REM  If a launcher is already listening, this exits immediately so that double
REM  clicking it (or the logon task running twice) never starts a second one.
REM ---------------------------------------------------------------------------

setlocal
set "ROOT=%~dp0"
set "ENTRY=%ROOT%launcher\launcher.js"

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js was not found on your PATH.
  echo   [ERROR] Install Node.js 18 or newer from https://nodejs.org
  pause
  exit /b 1
)

if not exist "%ENTRY%" (
  echo   [ERROR] Missing "%ENTRY%"
  pause
  exit /b 1
)

REM Already running? Then there is nothing to do.
netstat -ano | findstr ":8766" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 exit /b 0

node "%ENTRY%"
endlocal
