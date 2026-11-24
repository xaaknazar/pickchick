# Installs PickChick «Маркировка» on this Windows computer (run as administrator).
# Copies the exe to C:\PickChickLabels, keeps an existing data folder, lets local users write
# their products/journal, and puts shortcuts on the public desktop and in the Start menu.
# Usage: powershell -NoProfile -File infra\install.ps1 -Exe <path to PickChickLabels.exe>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Target = 'C:\PickChickLabels'
)
$ErrorActionPreference = 'Stop'
$data = Join-Path $Target 'data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$dest = Join-Path $Target 'PickChickLabels.exe'
if (Test-Path $dest) {
  $stamp = Get-Date -Format 'yyyyMMddTHHmmss'
  Copy-Item $dest "$dest.bak-$stamp"
}
Copy-Item $Exe $dest -Force
# *S-1-5-32-545 = local Users group (name differs by Windows language).
& icacls $data /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null

$shell = New-Object -ComObject WScript.Shell
$places = @(
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'PickChick')
)
foreach ($dir in $places) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Маркировка.lnk'))
  $lnk.TargetPath = $dest
  $lnk.WorkingDirectory = $Target
  $lnk.IconLocation = "$dest,0"
  $lnk.Description = 'PickChick — маркировка продуктов'
  $lnk.Save()
}
Get-Item $dest | Select-Object FullName, Length, LastWriteTime
(Get-FileHash $dest -Algorithm SHA256).Hash
