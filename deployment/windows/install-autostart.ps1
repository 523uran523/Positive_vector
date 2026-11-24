# Registers Windows scheduled tasks so the CRM server and the Cloudflare tunnel
# start automatically after a reboot and recover if they crash.
#
# Run as Administrator on the CRM server:
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\PositiveVector\deployment\windows\install-autostart.ps1

$ErrorActionPreference = 'Stop'
$root = 'C:\PositiveVector'

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

# --- 1. CRM server ---------------------------------------------------------
$crmAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\PositiveVector\start-crm.ps1' `
  -WorkingDirectory $root
$crmTrigger = New-ScheduledTaskTrigger -AtStartup
$crmTrigger.Delay = 'PT30S'

Register-ScheduledTask -TaskName 'CRM-Auto-Start' `
  -Action $crmAction -Trigger $crmTrigger -Settings $settings -Principal $principal -Force | Out-Null

# --- 2. Cloudflare tunnel --------------------------------------------------
$cfAction = New-ScheduledTaskAction -Execute 'C:\Program Files (x86)\cloudflared\cloudflared.exe' `
  -Argument '--config "C:\Users\likve\.cloudflared\config.yml" --protocol http2 --edge-ip-version 4 tunnel --logfile "C:\Users\likve\.cloudflared\crm-tunnel-vpn-20261120-193001.log" run e3efae46-829a-46b6-8805-c81249e37b57'
$cfTrigger = New-ScheduledTaskTrigger -AtStartup
$cfTrigger.Delay = 'PT2M'

Register-ScheduledTask -TaskName 'Cloudflared-Tunnel' `
  -Action $cfAction -Trigger $cfTrigger -Settings $settings -Principal $principal -Force | Out-Null

# --- 3. Watchdog: every 5 minutes, restarts whatever died ------------------
$wdAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\PositiveVector\watchdog.ps1' `
  -WorkingDirectory $root
$wdTrigger = New-ScheduledTaskTrigger -AtStartup
$wdTrigger.Delay = 'PT3M'
$wdTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

Register-ScheduledTask -TaskName 'PV-Watchdog' `
  -Action $wdAction -Trigger $wdTrigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host 'Tasks registered: CRM-Auto-Start, Cloudflared-Tunnel, PV-Watchdog'

# --- Start now -------------------------------------------------------------
Start-ScheduledTask -TaskName 'Cloudflared-Tunnel'
Start-ScheduledTask -TaskName 'CRM-Auto-Start'

Start-Sleep -Seconds 10

$port = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
$tunnel = Get-Process cloudflared -ErrorAction SilentlyContinue

Write-Host ('Port 4173 listening: {0}' -f [bool]$port)
Write-Host ('cloudflared running: {0}' -f [bool]$tunnel)

Get-ScheduledTask -TaskName 'CRM-Auto-Start', 'Cloudflared-Tunnel', 'PV-Watchdog' |
  ForEach-Object {
    $info = $_ | Get-ScheduledTaskInfo
    Write-Host ('{0}: State={1} LastResult={2}' -f $_.TaskName, $_.State, $info.LastTaskResult)
  }
