#!/data/data/com.termux/files/usr/bin/bash
# Positive Vector supervisor: keeps CRM + cloudflared alive, self-tests public URL.
export PATH=/data/data/com.termux/files/usr/bin:$PATH
export HOME=/data/data/com.termux/files/home
cd "$HOME/pv" || exit 1

TID=778ca0e4-f20d-449d-996f-ed9fdb112912
CFG="$HOME/.cloudflared/config.yml"
EDGE_IP=104.21.25.42
LOG="$HOME/pv/supervise.log"
TUN="$HOME/pv/tunnel.log"
HOST=crm.gulya-studio.ru

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

counters_str() {
  curl -s -m 4 http://127.0.0.1:20241/metrics 2>/dev/null \
    | awk '/^cloudflared_tunnel_ha_connections /{h=$2} /^cloudflared_tunnel_total_requests /{r=$2} END{printf "ha=%s req=%s", h+0, r+0}'
}

start_cloudflared() {
  if [ -f "$TUN" ] && [ "$(stat -c%s "$TUN" 2>/dev/null || echo 0)" -gt 2000000 ]; then
    mv "$TUN" "$TUN.old"
  fi
  echo "===== start $(date -u +%Y-%m-%dT%H:%M:%SZ) =====" >> "$TUN"
  nohup cloudflared tunnel --config "$CFG" \
    --protocol http2 --edge-ip-version 4 --ha-connections 4 --retries 20 \
    run "$TID" >> "$TUN" 2>&1 &
  log "cloudflared started pid=$!"
  for i in $(seq 1 30); do
    grep -q "Registered tunnel connection" "$TUN" 2>/dev/null && break
    sleep 2
  done
  sleep 2
}

start_node() {
  nohup node server.ts >> "$HOME/pv/server.log" 2>&1 &
  log "node started pid=$!"
  sleep 4
}

local_ok() { [ "$(curl -s -m 6 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health)" = "200" ]; }
public_ok() { [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' --resolve "$HOST:443:$EDGE_IP" "https://$HOST/api/health")" = "200" ]; }

termux-wake-lock 2>/dev/null

log "supervisor boot"

pgrep -f "node server.ts" >/dev/null 2>&1 || start_node
pgrep -f "cloudflared tunnel" >/dev/null 2>&1 || start_cloudflared

node_fail=0
pub_fail=0
last_restart=0

while true; do
  now=$(date +%s)
  state=$(counters_str)
  ha=$(echo "$state" | sed -n 's/.*ha=\([0-9]*\).*/\1/p')
  reqs=$(echo "$state" | sed -n 's/.*req=\([0-9]*\).*/\1/p')

  # --- node ---
  if pgrep -f "node server.ts" >/dev/null 2>&1 && local_ok; then
    node_fail=0
  else
    node_fail=$((node_fail+1))
    [ "$node_fail" -ge 2 ] && { log "node unhealthy -> restart"; pkill -9 -f "node server.ts" 2>/dev/null; sleep 1; start_node; node_fail=0; }
  fi

  # --- cloudflared ---
  if ! pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    log "cloudflared missing -> start"
    start_cloudflared
    pub_fail=0
    last_restart=$now
  elif local_ok; then
    if public_ok; then
      pub_fail=0
    else
      pub_fail=$((pub_fail+1))
      log "public FAIL ($pub_fail/3) $state"
      if [ "$pub_fail" -ge 3 ] && [ $((now-last_restart)) -ge 45 ]; then
        log "public dead -> recycle tunnel"
        pkill -9 -f "cloudflared tunnel" 2>/dev/null
        sleep 2
        start_cloudflared
        pub_fail=0
        last_restart=$now
      fi
    fi
  fi

  echo "$(date -u +%H:%M:%S) ha=${ha:-0} req=${reqs:-0} pubfail=$pub_fail nodefail=$node_fail" >> "$HOME/pv/health.log"
  tail -n 300 "$HOME/pv/health.log" > "$HOME/pv/health.log.tmp" 2>/dev/null && mv "$HOME/pv/health.log.tmp" "$HOME/pv/health.log"
  sleep 15
done
