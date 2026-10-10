#Requires -Version 5.1
# Pure byte transformation for an operator's already-reviewed environment file.
# The caller owns the maintenance lease, ACL checks, expected-hash CAS, backup,
# atomic replacement, bounded service restart and post-change verification.
function Update-ReviewedEnvBytes {
  param(
    [byte[]]$Bytes,
    [string]$Key,
    [AllowEmptyString()][string]$Prior,
    [AllowEmptyString()][string]$Next,
    [switch]$AllowAbsent
  )
  if ($Key -cnotmatch '^[A-Z][A-Z0-9_]*$' -or $Prior -match '[\x00\r\n]' -or $Next -match '[\x00\r\n]') {
    throw 'Invalid reviewed environment change'
  }
  if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 239 -and $Bytes[1] -eq 187 -and $Bytes[2] -eq 191) {
    throw 'UTF8 BOM is not part of the reviewed environment'
  }
  $encoding = [Text.UTF8Encoding]::new($false, $true)
  try { $text = $encoding.GetString($Bytes) } catch { throw 'Reviewed environment must be valid UTF8' }
  if ($text.Contains([char]0) -or -not $text.EndsWith("`n") -or $text -match "`r(?!`n)") {
    throw 'Reviewed environment must contain LF or CRLF terminated lines'
  }
  # Retain each delimiter independently. Choosing a file-wide newline would
  # rewrite unrelated bytes or reject a valid mixed-CRLF/LF Windows file.
  $lines = [regex]::Matches($text, '([^\r\n]*)(\r\n|\n)')
  $seen = @{}; $target = $null
  foreach ($line in $lines) {
    $content = $line.Groups[1].Value
    if ($content -eq '' -or $content.StartsWith('#')) { continue }
    $assignment = [regex]::Match($content, '^([A-Z][A-Z0-9_]*)=(.*)$')
    if (-not $assignment.Success -or $seen.ContainsKey($assignment.Groups[1].Value)) {
      throw 'Ambiguous environment assignment'
    }
    $name = $assignment.Groups[1].Value; $seen[$name] = $true
    if ($name -ceq $Key) {
      if ($assignment.Groups[2].Value -cne $Prior) { throw 'Target value differs from the reviewed previous value' }
      $target = @{ offset = $line.Index + $name.Length + 1; length = $assignment.Groups[2].Length }
    }
  }
  if ($null -eq $target) {
    if (-not $AllowAbsent) { throw 'Expected environment key is absent' }
    # Append using the existing final delimiter; do not normalize the prefix.
    $text += $Key + '=' + $Next + $lines[$lines.Count - 1].Groups[2].Value
  } else {
    $text = $text.Substring(0, $target.offset) + $Next + $text.Substring($target.offset + $target.length)
  }
  return ,$encoding.GetBytes($text)
}
