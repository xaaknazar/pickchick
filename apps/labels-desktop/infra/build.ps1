# Builds PickChickLabels.exe with the C# compiler that ships with .NET Framework 4.x on Windows.
# Usage: powershell -NoProfile -File infra\build.ps1 [-Out <folder>]
param([string]$Out = (Join-Path $PSScriptRoot '..\dist'))
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe (.NET Framework 4) not found' }
$src = Resolve-Path (Join-Path $PSScriptRoot '..\src')
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$exe = Join-Path $Out 'PickChickLabels.exe'
& $csc /nologo /target:winexe /optimize+ /codepage:65001 "/out:$exe" "/win32icon:$src\app.ico" `
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll `
  "$src\Program.cs"
if ($LASTEXITCODE -ne 0) { throw "csc failed with $LASTEXITCODE" }
Get-Item $exe | Select-Object FullName, Length
(Get-FileHash $exe -Algorithm SHA256).Hash
