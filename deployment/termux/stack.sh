#!/data/data/com.termux/files/usr/bin/bash
# Positive Vector: phone-side stack supervisor.
# Keeps CRM, the protected console, MeWeb and the phone-side tunnel alive.

export PATH=/data/data/com.termux/files/usr/bin:$PATH
export HOME=/data/data/com.termux/files/home
cd "$HOME/pv" || exit 1

LOG="$HOME/pv/stack.log"
CRED="$HOME/pv/.console_cred"
TTYD="$HOME/pv/ttyd"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 2000000 ]; then
  mv "$LOG" "$LOG.old"
fi

termux-wake-lock >/dev/null 2>&1 || true

start_node() {
  log "starting node"
  nohup node server.ts >> "$HOME/pv/server.log" 2>&1 &
}

start_ttyd() {
  [ -f "$CRED" ] && [ -x "$TTYD" ] || return 0
  log "starting ttyd"
  nohup "$TTYD" -p 7681 -i 0.0.0.0 -c "$(cat "$CRED")" \
    -t fontSize=15 -t scrollback=5000 \
    bash -l >> "$HOME/pv/ttyd.log" 2>&1 &
}

start_site() {
  [ -f "$HOME/pv-site/tools/serve.cjs" ] || return 0
  log "starting site"
  (cd "$HOME/pv-site" && PORT=4173 nohup node tools/serve.cjs >> "$HOME/pv-site/site.log" 2>&1 &)
}

start_tunnel() {
  [ -f "$HOME/.cloudflared/config.yml" ] || return 0
  log "starting cloudflared"
  nohup cloudflared tunnel --config "$HOME/.cloudflared/config.yml" run pv-main >> "$HOME/pv/cf-phone.log" 2>&1 &
}

health_ok() {
  curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/health 2>/dev/null | grep -q "^200$"
}

log "stack supervisor start (pid $$)"
fails=0

while true; do
  pgrep -f "node server.ts" >/dev/null 2>&1 || start_node
  pgrep -f "ttyd -p 7681" >/dev/null 2>&1 || start_ttyd
  pgrep -f "node tools/serve.cjs" >/dev/null 2>&1 || start_site
  pgrep -f "cloudflared tunnel --config" >/dev/null 2>&1 || start_tunnel

  if health_ok; then
    if [ "$fails" -gt 0 ]; then log "health recovered after $fails failures"; fi
    fails=0
  else
    fails=$((fails + 1))
    log "health check failed ($fails)"
    if [ "$fails" -ge 3 ]; then
      log "restarting node after 3 failed health checks"
      pkill -f "node server.ts" 2>/dev/null
      sleep 2
      start_node
      fails=0
    fi
  fi

  sleep 30
done
