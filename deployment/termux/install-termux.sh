#!/data/data/com.termux/files/usr/bin/bash
export PATH=/data/data/com.termux/files/usr/bin:$PATH
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export TERM=xterm-256color
export LANG=en_US.UTF-8
export DEBIAN_FRONTEND=noninteractive

echo "=== PV Termux install script ==="
echo "PATH=$PATH"
echo "HOME=$HOME"

# Ensure directories
mkdir -p "$HOME/pv"
mkdir -p "$HOME/.ssh"

# Install nodejs + termux-tools + cloudflared if missing
echo "--- apt-get update"
/data/data/com.termux/files/usr/bin/apt-get update -qq
echo "--- apt-get install nodejs termux-tools cloudflared"
/data/data/com.termux/files/usr/bin/apt-get install -y -qq nodejs termux-tools cloudflared 2>&1 | tail -10

echo "--- versions"
/data/data/com.termux/files/usr/bin/node -v
/data/data/com.termux/files/usr/bin/npm -v
/data/data/com.termux/files/usr/bin/cloudflared --version 2>&1 || echo "cloudflared not found"

echo "=== PV Termux install script DONE ==="