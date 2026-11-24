# Keeps the CRM server and the Cloudflare tunnel alive.
# Runs from Task Scheduler as SYSTEM: at boot and every 5 minutes.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = 'C:\PositiveVector'
$log = Join-Path $root 'watchdog.log'

if ((Test-Path $log) -and ((Get-Item $log).Length -gt 2MB)) {
  Move-Item -Force $log "$log.old"
}

function Write-Log([string]$message) {
  Add-Content -Path $log -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message) -Encoding UTF8
}

$started = @()

# --- CRM server (node server.ts) ---
$crm = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*server.ts*' }

if (-not $crm) {
  $task = Get-ScheduledTask -TaskName 'CRM-Auto-Start' -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq 'Running') {
    Write-Log 'CRM task is stuck in Running without a node process - stopping it'
    Stop-ScheduledTask -TaskName 'CRM-Auto-Start'
    Start-Sleep -Seconds 2
  }
  Write-Log 'CRM server is not running - starting CRM-Auto-Start'
  & schtasks /run /tn 'CRM-Auto-Start' | Out-Null
  $started += 'crm'
}

# --- Cloudflare tunnel ---
if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
  Write-Log 'cloudflared is not running - starting Cloudflared-Tunnel'
  & schtasks /run /tn 'Cloudflared-Tunnel' | Out-Null
  $started += 'tunnel'
}

if ($started.Count -gt 0) {
  Write-Log ('Started: ' + ($started -join ', '))
}
