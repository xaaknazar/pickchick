$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../../infra/windows/reviewed-env-bytes.ps1')
$encoding = [Text.UTF8Encoding]::new($false, $true)
$script:count = 0
function Assert-Change([string]$Before, [string]$After, [switch]$Absent) {
  $inputBytes = $encoding.GetBytes($Before); $saved = [Convert]::ToBase64String($inputBytes)
  $actual = Update-ReviewedEnvBytes $inputBytes 'MODE' 'off' 'apply' -AllowAbsent:$Absent
  if ($actual -isnot [byte[]] -or [Convert]::ToBase64String($actual) -cne [Convert]::ToBase64String($encoding.GetBytes($After))) {
    throw 'The transformation changed bytes outside the reviewed value'
  }
  if ([Convert]::ToBase64String($inputBytes) -cne $saved) { throw 'Input buffer was mutated' }
  $script:count++
}
function Assert-Rejected([byte[]]$Bytes, [string]$Key = 'MODE', [string]$Prior = 'off', [string]$Next = 'apply', [switch]$Absent) {
  $rejected = $false
  try { $null = Update-ReviewedEnvBytes $Bytes $Key $Prior $Next -AllowAbsent:$Absent } catch {
    $rejected = $true
    if ($_.Exception.Message.Contains('SECRET_VALUE')) { throw 'Failure disclosed input data' }
  }
  if (-not $rejected) { throw 'Ambiguous input was accepted' }
  $script:count++
}
# Every placement of mixed separators, including target first/last and blank lines.
$unicode = [string][char]0x043C + [char]0x00E9 + [char]0xD83C + [char]0xDF57
foreach ($a in @("`n", "`r`n")) {
  foreach ($b in @("`n", "`r`n")) {
    foreach ($c in @("`n", "`r`n")) {
      Assert-Change ("MODE=off"+$a+"TOKEN=a=b"+$b+"LABEL="+$unicode+$c) ("MODE=apply"+$a+"TOKEN=a=b"+$b+"LABEL="+$unicode+$c)
      Assert-Change ("TOKEN=a=b"+$a+"MODE=off"+$b+"# keep"+$c) ("TOKEN=a=b"+$a+"MODE=apply"+$b+"# keep"+$c)
      Assert-Change ("TOKEN=a=b"+$a+$b+"MODE=off"+$c) ("TOKEN=a=b"+$a+$b+"MODE=apply"+$c)
      Assert-Change ("# keep"+$a+"TOKEN=a=b"+$b+"LABEL="+$unicode+$c) ("# keep"+$a+"TOKEN=a=b"+$b+"LABEL="+$unicode+$c+"MODE=apply"+$c) -Absent
    }
  }
}
# Reproduce the observed shape: 5 CRLF + 3 LF, key absent, final CRLF.
$mixed = "A=1`r`nB=2`nC=3`r`nD=4`nE=5`r`nF=6`nG=7`r`nH=8`r`n"
Assert-Change $mixed ($mixed+"MODE=apply`r`n") -Absent
foreach ($bad in @('', "MODE=off", "MODE=off`r", "MODE=off`rOTHER=x`n", "MODE=off`nMODE=off`r`n", "TOKEN=SECRET_VALUE`nTOKEN=x`r`nMODE=off`n", "export MODE=off`n", " MODE=off`n", "MODE =off`n", "mode=off`n", "MODE=on`n", "OTHER=SECRET_VALUE`n", ([char]0xFEFF+"MODE=off`n"), ("MODE=off"+[char]0+"`n"))) {
  Assert-Rejected $encoding.GetBytes($bad)
}
Assert-Rejected ([byte[]]@(77, 79, 68, 69, 61, 0xC0, 0xAF, 10))
foreach ($key in @('', 'mode', 'A-B', "MODE`nOTHER")) { Assert-Rejected $encoding.GetBytes("MODE=off`n") -Key $key -Absent }
foreach ($bad in @("apply`nOTHER=true", "apply`rOTHER=true", ("apply"+[char]0))) {
  Assert-Rejected $encoding.GetBytes("MODE=off`n") -Next $bad
  Assert-Rejected $encoding.GetBytes("MODE=off`n") -Prior $bad
}
# AllowAbsent never permits overriding a different existing value.
Assert-Rejected $encoding.GetBytes("MODE=on`r`nTOKEN=SECRET_VALUE`n") -Absent
"Reviewed environment byte checks passed: $script:count"
