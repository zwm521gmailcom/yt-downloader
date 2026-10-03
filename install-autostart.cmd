@echo off
REM ---------------------------------------------------------------------------
REM  Register (or remove) the ytdl:// protocol used by the extension's
REM  "Start bridge" button, plus optional automatic startup at logon.
REM
REM  ASCII-only on purpose: see start-bridge.cmd.utf8 for the reasoning.
REM
REM    install-autostart.cmd            register the protocol + start at logon
REM    install-autostart.cmd protocol   register the protocol only
REM    install-autostart.cmd remove     undo both
REM    install-autostart.cmd status     show current state
REM ---------------------------------------------------------------------------

setlocal
set "TASKNAME=YouTubeDownloaderLauncher"
set "ROOT=%~dp0"
set "HIDDEN=%ROOT%start-launcher-hidden.vbs"
set "LAUNCHER_HIDDEN=%ROOT%start-launcher-hidden.vbs"
set "TOKENFILE=%ROOT%server\.start-token"

if /i "%~1"=="remove" goto remove
if /i "%~1"=="status" goto status
if /i "%~1"=="protocol" goto protocol
goto install


:install
call :check
call :make_token
call :register_protocol
if errorlevel 1 goto failed
call :register_task
if errorlevel 1 goto partial
call :start_now
echo.
echo   Done.  /  完成。
echo.
echo   Start the bridge straight from the extension:
echo   open the popup or the settings page and click "Start bridge".
echo.
echo   以后可以直接在扩展里启动服务：
echo   打开扩展弹窗或设置页，点击「启动服务」即可。
echo.
echo   The launcher also starts automatically when you sign in, so the button
echo   normally shows "already running" rather than starting anything.
echo   启动器也会随登录自动运行，因此按钮通常会直接显示已连接。
if /i "%STARTUP_MODE%"=="shortcut" (
  echo   ^(registered via a Startup folder shortcut^)  /  ^(通过启动文件夹快捷方式注册^)
)
echo.
echo   Stop everything with:  stop-bridge.cmd
echo   可用 stop-bridge.cmd 停止服务。
echo.
pause
exit /b 0


:start_now
REM Bring the launcher up immediately so the extension button works without
REM signing out first.
REM
REM `start "" /b` runs it with no new window. Without /b, Windows creates a
REM console for wscript's child even though the VBS itself is GUI-subsystem,
REM which is what produced the stray black flash.
echo.
echo   Starting the launcher now...
echo   正在立即启动启动器...
start "" /b wscript.exe "%LAUNCHER_HIDDEN%"
timeout /t 2 >nul
netstat -ano | findstr ":8766" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (
  echo   [WARN] The launcher did not come up yet.
  echo   [警告] 启动器尚未就绪。
  echo          It will start at your next sign-in.
  echo          下次登录时会自动启动。
) else (
  echo   Launcher is ready.  /  启动器已就绪。
)
exit /b 0


:partial
REM The protocol is registered but the logon task is not, so do NOT claim that
REM the bridge starts automatically - it would be wrong and confusing.
echo.
echo   PARTIALLY INSTALLED  /  部分安装完成
echo.
echo   [OK]   ytdl:// protocol registered.
echo   [OK]   ytdl:// 协议已注册 - the extension button will work.
echo         扩展里的「启动服务」按钮可以正常使用。
echo.
echo   [FAIL] Could not register automatic startup.
echo   [失败] 未能注册开机自启。
echo.
echo   Windows refused to create the scheduled task. This usually means the
echo   task scheduler is unavailable or policy-restricted.
echo   Windows 拒绝创建计划任务，通常是任务计划程序不可用或被策略限制。
echo.
echo   Options:  /  可选方案：
echo     1. Run this file as Administrator and try again.
echo        以管理员身份重新运行本文件。
echo     2. Just use the extension's "Start bridge" button each time.
echo        直接使用扩展里的「启动服务」按钮。
echo     3. Add a shortcut to start-bridge-hidden.vbs here:
echo        把 start-bridge-hidden.vbs 的快捷方式放进这个文件夹：
echo        %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
echo.
pause
exit /b 0


:protocol
call :check
call :make_token
call :register_protocol
if errorlevel 1 goto failed
echo.
echo   Protocol registered.  /  协议已注册。
echo   The bridge will NOT start automatically at logon.
echo   服务不会随开机自动启动。
echo.
pause
exit /b 0


:failed
echo.
echo   [ERROR] Setup did not complete.  /  安装未完成。
echo   Try running this file as Administrator.
echo   请尝试以管理员身份运行本文件。
echo.
pause
exit /b 1


REM --- helpers ---------------------------------------------------------------

:check
if not exist "%HIDDEN%" (
  echo   [ERROR] Missing "%HIDDEN%"
  echo   [错误] 缺少启动包装脚本。
  echo.
  pause
  exit /b 1
)
if not exist "%ROOT%launcher\launcher.js" (
  echo   [ERROR] Missing "%ROOT%launcher\launcher.js"
  echo   [错误] 缺少启动器脚本。
  echo.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js was not found on your PATH.
  echo   [错误] 未在 PATH 中找到 Node.js。
  echo.
  pause
  exit /b 1
)
exit /b 0


:make_token
REM A shared secret so that only the extension (which reads this file) can
REM trigger a launch. Any other web page guessing ytdl://start is rejected.
if exist "%TOKENFILE%" exit /b 0
powershell -NoProfile -Command ^
  "$t=-join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) });" ^
  "Set-Content -Path '%TOKENFILE%' -Value $t -NoNewline -Encoding ascii" >nul 2>nul
if not exist "%TOKENFILE%" (
  echo   [WARN] Could not create the launch token; the protocol will accept
  echo          unauthenticated launches.  /  未能创建启动令牌。
)
exit /b 0


:register_protocol
echo.
echo   Registering the ytdl:// protocol...
echo   正在注册 ytdl:// 协议...
REM HKCU needs no administrator rights.
REM
REM The handler is a .vbs, NOT a .cmd. Windows runs batch files through cmd.exe,
REM which always creates a console window, so a .cmd protocol handler flashes a
REM black window every time the button is clicked. wscript.exe is a GUI-subsystem
REM host and shows nothing.
if not exist "%ROOT%ytdl-handler.vbs" (
  echo   [ERROR] Missing "%ROOT%ytdl-handler.vbs"
  echo   [错误] 缺少协议处理脚本。
  exit /b 1
)
reg add "HKCU\Software\Classes\ytdl" /ve /d "URL:Video Downloader Bridge" /f >nul 2>nul
reg add "HKCU\Software\Classes\ytdl" /v "URL Protocol" /d "" /f >nul 2>nul
reg add "HKCU\Software\Classes\ytdl\shell\open\command" /ve ^
  /d "wscript.exe \"%ROOT%ytdl-handler.vbs\" \"%%1\"" /f >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0


:register_task
echo   Registering automatic startup...
echo   正在注册开机自启...

schtasks /query /tn "%TASKNAME%" >nul 2>nul
if not errorlevel 1 schtasks /delete /tn "%TASKNAME%" /f >nul 2>nul

REM Preferred: a scheduled task, which runs hidden with no window.
schtasks /create /tn "%TASKNAME%" /tr "wscript.exe \"%HIDDEN%\"" /sc onlogon /rl limited /f >nul 2>nul
if not errorlevel 1 (
  set "STARTUP_MODE=task"
  exit /b 0
)
REM Some systems reject /rl; retry without it.
schtasks /create /tn "%TASKNAME%" /tr "wscript.exe \"%HIDDEN%\"" /sc onlogon /f >nul 2>nul
if not errorlevel 1 (
  set "STARTUP_MODE=task"
  exit /b 0
)

REM Fallback: a shortcut in the Startup folder. This needs no Task Scheduler
REM access and behaves the same for a per-user logon launch.
call :register_startup_shortcut
if errorlevel 1 exit /b 1
set "STARTUP_MODE=shortcut"
exit /b 0


:register_startup_shortcut
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if not exist "%STARTUP%" exit /b 1
set "LNK=%STARTUP%\YouTube Downloader Bridge.lnk"
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');" ^
  "$s.TargetPath='wscript.exe';" ^
  "$s.Arguments='\"%HIDDEN%\"';" ^
  "$s.WorkingDirectory='%ROOT%';" ^
  "$s.Description='Start the YouTube Downloader bridge';" ^
  "$s.Save()" >nul 2>nul
if not exist "%LNK%" exit /b 1
exit /b 0


:remove
echo.
echo   Removing...
echo   正在移除...
reg delete "HKCU\Software\Classes\ytdl" /f >nul 2>nul
schtasks /delete /tn "%TASKNAME%" /f >nul 2>nul
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\YouTube Downloader Bridge.lnk"
if exist "%LNK%" del "%LNK%" >nul 2>nul
del "%TOKENFILE%" >nul 2>nul
echo   Done. The ytdl:// protocol and automatic startup are removed.
echo   完成。ytdl:// 协议与开机自启已移除。
echo.
echo   A bridge that is already running is unaffected; stop it with stop-bridge.cmd
echo   已在运行的服务不受影响，可用 stop-bridge.cmd 停止。
echo.
pause
exit /b 0


:status
echo.
echo   Protocol:  /  协议：
reg query "HKCU\Software\Classes\ytdl\shell\open\command" >nul 2>nul
if errorlevel 1 (echo     NOT registered  /  未注册) else (echo     registered  /  已注册)

echo   Autostart: /  开机自启：
schtasks /query /tn "%TASKNAME%" >nul 2>nul
if not errorlevel 1 (
  echo     registered as a scheduled task  /  已注册为计划任务
) else (
  set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\YouTube Downloader Bridge.lnk"
  if exist "%LNK%" (
    echo     registered via the Startup folder  /  已注册为启动文件夹快捷方式
  ) else (
    echo     NOT registered  /  未注册
  )
)

echo   Token:     /  令牌：
if exist "%TOKENFILE%" (echo     present  /  已生成) else (echo     missing  /  缺失)

echo   Running:   /  运行状态：
netstat -ano | findstr ":8765" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (echo     bridge is NOT running  /  本地服务未运行) else (echo     bridge IS running  /  本地服务正在运行)
echo.
pause
exit /b 0
