# Positive Vector relay supervisor (PC side).
#
# Why this exists: the phone's own network path (RU ISP, direct) drops
# Cloudflare tunnel streams a few seconds after registration, so the connector
# cannot live on the phone. The PC keeps a working route, so it runs the
# connector and forwards to the phone over the home LAN.
#
# Origin services on the phone: CRM on :3000, protected console on :7681.

$ErrorActionPreference = "Continue"

$root     = Join-Path $env:LOCALAPPDATA "pv-relay"
$log      = Join-Path $root "relay.log"
$cfg      = Join-Path $root "config.yml"
$creds    = Join-Path $root "creds.json"
$exe      = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$tunnelId = "778ca0e4-f20d-449d-996f-ed9fdb112912"
$crmPort  = 3000
$termPort = 7681

# Preferred phone address; if DHCP hands out a different one, discovery fixes it.
$script:phoneIp = "192.168.1.112"

New-Item -ItemType Directory -Force -Path $root | Out-Null

function Write-Log([string]$msg) {
  $line = "{0} {1}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $msg
  Add-Content -Path $log -Value $line
}

function Test-Origin([string]$ip, [int]$port, [int]$timeoutSec = 3) {
  try {
    $r = Invoke-WebRequest -Uri "http://${ip}:${port}/api/health" -TimeoutSec $timeoutSec -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Find-Phone {
  $candidates = @($script:phoneIp)
  try {
    $arp = (arp -a) -join "`n"
    foreach ($m in [regex]::Matches($arp, "(\d{1,3}(?:\.\d{1,3}){3})")) {
      $ip = $m.Groups[1].Value
      if ($ip -like "192.168.1.*" -and $candidates -notcontains $ip) { $candidates += $ip }
    }
  } catch {}

  foreach ($ip in $candidates) {
    if (Test-Origin $ip $crmPort 2) {
      if ($ip -ne $script:phoneIp) { Write-Log "phone moved: $($script:phoneIp) -> $ip" }
      $script:phoneIp = $ip
      return $true
    }
  }
  return $false
}

function Write-RelayConfig {
  $body = @"
tunnel: $tunnelId
credentials-file: $creds

protocol: http2

ingress:
  - hostname: crm.gulya-studio.ru
    service: http://$($script:phoneIp):$crmPort
  - hostname: dev.gulya-studio.ru
    service: http://$($script:phoneIp):$termPort
  - service: http_status:404
"@
  Set-Content -Path $cfg -Value $body -Encoding ascii
}

if (-not (Test-Path $creds)) {
  $seed = Join-Path $env:TEMP "opencode\pv-main-creds.json"
  if (-not (Test-Path $seed)) {
    Write-Log "FATAL: tunnel credentials missing ($creds)"
    exit 1
  }
  Copy-Item $seed $creds -Force
}

if ((Test-Path $log) -and ((Get-Item $log).Length -gt 2000000)) {
  Move-Item $log "$log.old" -Force
}

Write-Log "relay supervisor start (pid $PID)"

while ($true) {
  $origin = Find-Phone
  Write-Log ("phone origin reachable=" + $origin + " ip=" + $script:phoneIp)

  Write-RelayConfig
  Write-Log "starting cloudflared"

  $p = Start-Process -FilePath $exe -ArgumentList @(
    "tunnel", "--config", $cfg, "--protocol", "http2", "--edge-ip-version", "4",
    "--retries", "50", "run", $tunnelId
  ) -RedirectStandardOutput (Join-Path $root "cloudflared.out") `
    -RedirectStandardError  (Join-Path $root "cloudflared.err") `
    -WindowStyle Hidden -PassThru

  # Watchdog: public health is the only signal that matters. A connector can
  # stay "connected" while the edge silently stops routing to it, so process
  # liveness alone is not enough.
  $deadSince = $null
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 15

    $publicOk = $false
    try {
      $r = Invoke-WebRequest -Uri "https://crm.gulya-studio.ru/api/health" -TimeoutSec 10 -UseBasicParsing
      $publicOk = ($r.StatusCode -eq 200)
    } catch { $publicOk = $false }

    if ($publicOk) {
      if ($null -ne $deadSince) { Write-Log "public health recovered" }
      $deadSince = $null
      continue
    }

    if ($null -eq $deadSince) {
      $deadSince = Get-Date
      Write-Log "public health failed, watching"
      continue
    }

    $downSec = [int]((Get-Date) - $deadSince).TotalSeconds
    if ($downSec -ge 90) {
      Write-Log "public health failed for ${downSec}s -> restarting connector"
      try { $p.Kill() } catch {}
      break
    }

    if (-not (Find-Phone)) {
      Write-Log "phone unreachable from PC; will retry"
    }
  }

  try {
    Write-Log ("cloudflared exited code=" + $p.ExitCode)
  } catch {
    Write-Log "cloudflared stopped"
  }
  Start-Sleep -Seconds 5
}
