#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077
app_dir="${PV_APP_DIR:-$HOME/pv}"
prefix="${PREFIX:-/data/data/com.termux/files/usr}"
cd "$app_dir"
test -f dist/index.html || { echo 'Build the verified release first'; exit 1; }
test -f .env || { echo 'Create a private .env with NODE_ENV=production, HOST=127.0.0.1, COOKIE_SECURE=true and a random SESSION_SECRET'; exit 1; }
node --input-type=module -e "import 'dotenv/config'; if(process.env.NODE_ENV!=='production'||process.env.HOST!=='127.0.0.1'||process.env.COOKIE_SECURE!=='true'||(process.env.SESSION_SECRET||'').length<32) process.exit(1)"
command -v sv >/dev/null || { echo 'Install termux-services, then restart Termux'; exit 1; }
mkdir -p "$prefix/var/service/pv-crm/log" "$HOME/.termux/boot" "$HOME/.local/state/pv-crm"
printf '#!%s/bin/sh\ncd "%s" || exit 1\nexec 2>&1\nexec %s/bin/node server.ts\n' "$prefix" "$app_dir" "$prefix" > "$prefix/var/service/pv-crm/run"
printf '#!%s/bin/sh\nexec svlogd -tt "%s/.local/state/pv-crm"\n' "$prefix" "$HOME" > "$prefix/var/service/pv-crm/log/run"
chmod 700 "$prefix/var/service/pv-crm/run" "$prefix/var/service/pv-crm/log/run"
printf '#!%s/bin/sh\ntermux-wake-lock\n. "%s/etc/profile.d/start-services.sh"\n' "$prefix" "$prefix" > "$HOME/.termux/boot/start-pv"
chmod 700 "$HOME/.termux/boot/start-pv"
sv up "$prefix/var/service/pv-crm"
echo 'CRM service prepared. Verify local health and first administrator before enabling the public tunnel.'
