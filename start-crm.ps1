$ErrorActionPreference = 'Continue'
Set-Location 'C:\PositiveVector'

$env:PORT = '4173'
$env:DB_PATH = 'data/positive_vector.db'
$env:UPLOAD_DIR = 'uploads/'

$tsx = 'C:\PositiveVector\node_modules\.bin\tsx.cmd'
$log = 'C:\PositiveVector\server.log'

if (-not (Test-Path $tsx)) {
  Add-Content -Path $log -Value ('{0} ERROR: tsx not found at {1} (run npm ci)' -f (Get-Date -Format 's'), $tsx)
  exit 1
}

Add-Content -Path $log -Value ('{0} Starting CRM on port {1}' -f (Get-Date -Format 's'), $env:PORT)

& $tsx server.ts *>> $log
