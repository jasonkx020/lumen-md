@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/2] Win7 绿包构建（请使用 rustc 1.77.2）...
rustup run 1.77.2 cargo build -p lumen-cli --release
if errorlevel 1 (
  echo 若未安装 1.77.2: rustup install 1.77.2
  exit /b 1
)

if not exist "dist" mkdir dist
copy /Y "target\release\lumen.exe" "dist\lumen.exe" >nul

echo.
echo 完成: dist\lumen.exe
echo 系统: Win7 SP1+ / 10 / 11 x64
echo 用法: 粘贴文件夹路径 → 进入 → 打开 .md
echo.
dir dist\lumen.exe
