@echo off&&cd /d %~dp0
Title AI Toolkit - 汉化桥
chcp 65001 >nul

REM AI Toolkit 汉化桥启动入口（Windows）
REM 流程：启动汉化桥代理(:8676) -> 打开中文页面 -> 前台运行原版启动链(更新+启动)
REM 原项目文件零改动；Ctrl+C 退出后，汉化桥会在原版 UI 关闭后约 30 秒自动退出。

set "BRIDGE_PORT=8676"

REM ---- 1. 找 Node.js（优先项目私有的 .node，找不到再用系统 PATH）----
set "NODE_EXE="
if exist "%~dp0.node\node.exe" set "NODE_EXE=%~dp0.node\node.exe"
if not defined NODE_EXE (
    where node >nul 2>&1
    if not errorlevel 1 for /f "delims=" %%P in ('where node') do set "NODE_EXE=%%P"
)
if not defined NODE_EXE (
    echo [zh-bridge] 未找到 Node.js。请先运行一次 run_windows.bat 完成依赖安装。
    pause
    exit /b 1
)

REM ---- 2. 劫持 Python webbrowser，阻止原链自动弹出英文页面 ----
REM    nop.cmd 收到 URL 参数后直接返回退出码 0，webbrowser 视为"已打开"。
set "BROWSER=%~dp0zh_bridge\nop.cmd"

REM ---- 3. 后台启动汉化桥 ----
start "zh-bridge" /min "%NODE_EXE%" "%~dp0zh_bridge\server.js"

REM ---- 4. 打开中文界面 ----
timeout /t 2 /nobreak >nul
start "" "http://localhost:%BRIDGE_PORT%"

echo.
echo   ============================================
echo    AI Toolkit 汉化桥
echo    中文界面: http://localhost:%BRIDGE_PORT%
echo    英文原版: http://localhost:8675
echo    两者数据完全相同，可随时切换。
echo   ============================================
echo.

REM ---- 5. 前台运行原版启动链（更新 + 启动，完整复用官方逻辑）----
call "%~dp0run_windows.bat"
