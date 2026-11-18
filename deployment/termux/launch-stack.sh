#!/data/data/com.termux/files/usr/bin/bash
# Idempotent launcher for the phone stack. Safe to call from adb or from boot.
export PATH=/data/data/com.termux/files/usr/bin:$PATH
export HOME=/data/data/com.termux/files/home

if pgrep -f "pv/stack.sh" >/dev/null 2>&1; then
  exit 0
fi

cd "$HOME/pv" || exit 1
setsid nohup /data/data/com.termux/files/usr/bin/bash "$HOME/pv/stack.sh" \
  > "$HOME/pv/stack.out" 2>&1 &
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) launch-stack" >> "$HOME/pv/boot.log"
