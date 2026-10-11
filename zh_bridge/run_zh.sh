#!/usr/bin/env bash
# AI Toolkit 汉化桥启动入口（Linux / macOS）
# 流程：后台启动汉化桥代理(:8676) -> (桌面环境)打开中文页面 -> 前台运行原版启动链
# 原项目文件零改动；原版 UI 关闭后，汉化桥约 30 秒内自动退出。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BRIDGE_PORT="${ZH_BRIDGE_PORT:-8676}"

# ---- 1. 找 Node.js（优先项目私有的 .node，找不到再用系统 PATH）----
NODE_EXE=""
if [[ -x "$ROOT_DIR/.node/bin/node" ]]; then
    NODE_EXE="$ROOT_DIR/.node/bin/node"
elif command -v node >/dev/null 2>&1; then
    NODE_EXE="$(command -v node)"
fi
if [[ -z "$NODE_EXE" ]]; then
    echo "[zh-bridge] 未找到 Node.js。请先运行一次 ./run_linux.sh 完成依赖安装。" >&2
    exit 1
fi

# ---- 2. 阻止原链自动弹出英文页面（webbrowser 调 /bin/true 视为已打开）----
export BROWSER=true

# ---- 3. 后台启动汉化桥（日志写入 zh_bridge.log 便于排查）----
nohup "$NODE_EXE" "$SCRIPT_DIR/server.js" >> "$SCRIPT_DIR/zh_bridge.log" 2>&1 &
echo "[zh-bridge] 汉化桥已在后台启动 (PID $!)，日志: zh_bridge/zh_bridge.log"

# ---- 4. 打开中文页面（仅桌面环境；headless 服务器手动访问即可）----
if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v xdg-open >/dev/null 2>&1; then
    (sleep 3; xdg-open "http://localhost:$BRIDGE_PORT" >/dev/null 2>&1) &
fi

echo ""
echo "  ============================================"
echo "   AI Toolkit 汉化桥"
echo "   中文界面: http://localhost:$BRIDGE_PORT"
echo "   英文原版: http://localhost:8675"
echo "   headless 服务器: http://<本机IP>:$BRIDGE_PORT"
echo "   两者数据完全相同，可随时切换。"
echo "  ============================================"
echo ""

# ---- 5. 前台运行原版启动链（更新 + 启动，完整复用官方逻辑）----
if [[ "$(uname)" == "Darwin" ]]; then
    exec zsh "$ROOT_DIR/run_mac.zsh"
else
    exec bash "$ROOT_DIR/run_linux.sh"
fi
