$dirs = Get-ChildItem C:\ -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*PositiveVector*' }
Write-Output "Found: $($dirs.Name -join ', ')"
if ($dirs) {
    Write-Output "Path: $($dirs.FullName)"
    Write-Output "Exists: $($dirs.Exists)"
}
