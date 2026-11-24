# Restarts the CRM server so a fresh build is served.
# Called detached by the "deploy from git" endpoint: the old process is killed
# after the HTTP response has been sent, then the scheduled task starts it again.
$ErrorActionPreference = 'SilentlyContinue'

$log = 'C:\PositiveVector\watchdog.log'
function Write-Log([string]$message) {
  Add-Content -Path $log -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message) -Encoding UTF8
}

Write-Log 'Deploy: restarting CRM server'
Start-Sleep -Seconds 3

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*server.ts*' } |
  ForEach-Object {
    Write-Log ('Deploy: stopping node PID {0}' -f $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force
  }

for ($i = 0; $i -lt 30; $i++) {
  if ((Get-ScheduledTask -TaskName 'CRM-Auto-Start').State -ne 'Running') { break }
  Start-Sleep -Seconds 1
}

& schtasks /run /tn 'CRM-Auto-Start' | Out-Null
Write-Log 'Deploy: CRM-Auto-Start triggered'
