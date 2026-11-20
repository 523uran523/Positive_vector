# Setup script for CRM deployment

# 1. Install Node.js, Git, Cloudflared
Write-Host "Installing Node.js..."
Start-Process "msiexec" -ArgumentList "/i C:\Users\likve\Downloads\node.msi /qn /norestart" -Wait -NoNewWindow

Write-Host "Installing Git..."
Start-Process "C:\Users\likve\Downloads\git.exe" -ArgumentList "/VERYSILENT /NORESTART" -Wait -NoNewWindow

Write-Host "Installing Cloudflared..."
Start-Process "msiexec" -ArgumentList "/i C:\Users\likve\Downloads\cloudflared.msi /qn /norestart" -Wait -NoNewWindow

# 2. Clone repository
Write-Host "Cloning repository..."
git clone https://github.com/523uran523/Positive_vector.git C:\PositiveVector

# 3. Extract phone data
Write-Host "Extracting phone data..."
tar -xzf C:\Users\likve\Downloads\phone-data.tar.gz -C C:\PositiveVector

# 4. Install Node.js dependencies
Write-Host "Installing npm dependencies..."
cd C:\PositiveVector
npm ci

# 5. Build
Write-Host "Building project..."
npm run build

# 6. Create .env file
Write-Host "Creating .env file..."
@"
PORT=4173
DB_PATH=data/positive_vector.db
UPLOAD_DIR=uploads/
"@ | Out-File -FilePath C:\PositiveVector\.env -Encoding utf8

# 6. Set up scheduled task for auto-start
Write-Host "Setting up scheduled task..."
$action = New-ScheduledTaskAction -Execute "C:\PositiveVector\node.exe" -Argument "C:\PositiveVector\server.ts"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "CRM-Server" -Action $action -Trigger $trigger -RunLevel Highest -User "SYSTEM" -Force

# 6. Setup Cloudflare Tunnel
Write-Host "Setting up Cloudflare Tunnel..."
cloudflared tunnel create crm-production
cloudflared tunnel route dns crm-production crm.gulya-studio.ru
cloudflared tunnel run crm-production

Write-Host "Setup complete!"