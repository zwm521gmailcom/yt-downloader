@echo off
REM ---------------------------------------------------------------------------
REM  YouTube Downloader - start the local bridge
REM
REM  IMPORTANT: this file is saved in GBK (codepage 936), not UTF-8.
REM  cmd.exe parses .cmd files byte-by-byte using the console codepage, so a
REM  UTF-8 file read as GBK turns the Chinese lines below into garbage that
REM  cmd tries to execute ("... is not recognized as an internal or external
REM  command"). If you edit this file, keep it in GBK with CRLF line endings.
REM  Run:  node tools/fix-cmd-encoding.js
REM ---------------------------------------------------------------------------

setlocal
title YouTube Downloader Bridge
cd /d "%~dp0server"

REM Deliberately no "starting..." banner here: cmd.exe echoes this file's text
REM using the console codepage, which garbles Chinese before Node can set the
REM console to UTF-8. server.js prints the bilingual banner instead.

where node >nul 2>nul
if errorlevel 1 goto no_node

where yt-dlp >nul 2>nul
if errorlevel 1 call :warn_ytdlp

where ffmpeg >nul 2>nul
if errorlevel 1 call :warn_ffmpeg

node server.js
if errorlevel 1 goto node_failed

echo.
echo   The bridge has stopped.  /  本地服务已停止。
echo.
pause
endlocal
exit /b 0


:no_node
echo.
echo   [ERROR] Node.js was not found on your PATH.
echo   [错误] 未在 PATH 中找到 Node.js。
echo.
echo   Install Node.js 18 or newer from https://nodejs.org
echo   请从 https://nodejs.org 安装 Node.js 18 或更高版本，然后重新运行本脚本。
echo.
pause
endlocal
exit /b 1


:warn_ytdlp
echo   [WARN] yt-dlp was not found on your PATH.
echo   [警告] 未在 PATH 中找到 yt-dlp。
echo          Install with:  winget install yt-dlp.yt-dlp
echo.
exit /b 0


:warn_ffmpeg
echo   [WARN] ffmpeg was not found on your PATH.
echo   [警告] 未在 PATH 中找到 ffmpeg。
echo          High-resolution video and audio cannot be merged without it.
echo          缺少它时将无法合并高清视频与音频。
echo          Install with:  winget install Gyan.FFmpeg
echo.
exit /b 0


:node_failed
echo.
echo   The bridge exited with an error.  /  本地服务异常退出。
echo   Diagnose with:  cd server ^&^& node doctor.js
echo   可运行以下命令诊断：cd server ^&^& node doctor.js
echo.
pause
endlocal
exit /b 1
