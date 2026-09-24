@echo off
REM Build Lumen MD Live (Win10/11 + WebView2)
cd /d "%~dp0apps\live"
call npm install
call npm run tauri build
echo.
echo Artifacts:
echo   apps\live\src-tauri\target\release\lumen-live.exe
echo   apps\live\src-tauri\target\release\bundle\
pause
