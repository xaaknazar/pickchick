# Windows PowerShell 5.1 on a real NTFS volume: the file replacement of
# update-kitchen-lan-clients.ps1. Functions and the replacement statement are taken from the
# script's AST; the script itself never runs. Only a disposable folder under the temporary
# directory is touched: no service, firewall rule, registry or system ACL.
#
# [IO.File]::Replace(source, target, $null) works in PowerShell 7 and fails in Windows
# PowerShell 5.1, which hands $null to a string parameter as an empty string. The first real
# stage 2 run stopped on exactly that in September 2026 (infra/windows/native-services.md). The
# LAN client list script carried the same call until 12.11.2026: on the server it would have
# stopped the gateway and then failed its own rollback. The PowerShell 7 tests on Linux cannot
# see the difference, so this file runs only where the scripts really run.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Windows PowerShell 5.1 is required.'
}
$windows=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../infra/windows')).Path
$script:count=0
function Assert-True($Condition,[string]$Message) {
    if (-not $Condition) {throw "FAILED: $Message"}
    $script:count++
}
function Read-ScriptAst([string]$Path) {
    $tokens=$null;$parseErrors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$parseErrors)
    if ($parseErrors.Count) {throw ("Parse errors in $Path`n"+($parseErrors | Out-String))}
    return $ast
}
function Get-TopFunction($Ast,[string]$Name) {
    $all=@($Ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false))
    $found=@($all | Where-Object {$_.Name -ceq $Name})
    if ($found.Count -ne 1) {throw "Expected exactly one top-level function $Name."}
    return $found[0].Extent.Text
}
# Every static call [IO.File]::Replace(...) of a script, inside functions too.
function Get-FileReplaceCalls($Ast) {
    $calls=@($Ast.FindAll({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst]},$true))
    return @($calls | Where-Object {
        $_.Static -and
        $_.Member -is [Management.Automation.Language.StringConstantExpressionAst] -and $_.Member.Value -ceq 'Replace' -and
        $_.Expression -is [Management.Automation.Language.TypeExpressionAst] -and $_.Expression.TypeName.FullName -match '^(System\.)?IO\.File$'
    })
}
function Read-Bytes([string]$Path) {return ,[IO.File]::ReadAllBytes($Path)}
function Test-SameBytes([byte[]]$Left,[byte[]]$Right) {return [Convert]::ToBase64String($Left) -ceq [Convert]::ToBase64String($Right)}
# The access rules of a file as comparable text: who, which rights, allow or deny, own or inherited.
function Get-AccessText([string]$Path) {
    $rules=(Get-Acl -LiteralPath $Path).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    $lines=@($rules | ForEach-Object {'{0}|{1}|{2}|{3}' -f $_.IdentityReference.Value,[int]$_.FileSystemRights,$_.AccessControlType,$_.IsInherited})
    return (@($lines | Sort-Object) -join ';')
}

# ---- The real functions and the real statement on a real NTFS folder ----
$updateAst=Read-ScriptAst (Join-Path $windows 'update-kitchen-lan-clients.ps1')
$foundationAst=Read-ScriptAst (Join-Path $windows 'install-native-foundation.ps1')
. ([scriptblock]::Create((Get-TopFunction $foundationAst 'Assert-LocalNtfsPath')))
foreach ($name in @('Write-LanNewFile','Set-LanFile','Get-LanFileSha256')) {
    . ([scriptblock]::Create((Get-TopFunction $updateAst $name)))
}
$base=if ($env:RUNNER_TEMP) {$env:RUNNER_TEMP} else {$env:TEMP}
$root=Join-Path (Get-Item -LiteralPath $base).FullName ('pickchick-lan-files-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
try {
    $utf8=[Text.UTF8Encoding]::new($false)
    $first=$utf8.GetBytes('{"clients":[{"address":"192.168.2.70","profile":"kitchen"}]}')
    $second=$utf8.GetBytes('{"clients":[{"address":"192.168.2.70","profile":"kitchen"},{"address":"192.168.2.71","profile":"pos"}]}')
    $target=Join-Path $root 'gateway.json'

    # A file that does not exist yet is moved into place.
    Set-LanFile $target $first '20261112T100000Z' 'new'
    Assert-True (Test-SameBytes (Read-Bytes $target) $first) 'a new file holds the written bytes'
    Assert-True (@(Get-ChildItem -LiteralPath $root -Force).Count -eq 1) 'no temporary file stays after the first write'

    # The target carries its own access rule, as the gateway config does on the server (the
    # service account may read it). Replacing must keep that rule: delete and move would not.
    $acl=Get-Acl -LiteralPath $target
    $service=[Security.Principal.SecurityIdentifier]::new('S-1-5-19')
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($service,'ReadAndExecute','Allow'))
    Set-Acl -LiteralPath $target -AclObject $acl
    $before=Get-AccessText $target
    Assert-True ($before -match 'S-1-5-19\|\d+\|Allow\|False') 'the target has its own service rule before the replacement'

    # An existing file is replaced in place: the branch that failed in Windows PowerShell 5.1.
    Set-LanFile $target $second '20261112T100001Z' 'new'
    Assert-True (Test-SameBytes (Read-Bytes $target) $second) 'an existing file is replaced with the new bytes'
    Assert-True ((Get-AccessText $target) -ceq $before) 'the replacement keeps the access rules of the target'
    Assert-True (@(Get-ChildItem -LiteralPath $root -Force).Count -eq 1) 'no temporary and no backup file stays after the replacement'
    $sha=[Security.Cryptography.SHA256]::Create()
    try {$expected=[BitConverter]::ToString($sha.ComputeHash($second)).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
    Assert-True ((Get-LanFileSha256 $target) -ceq $expected) 'the installed file hash is the hash of the new bytes'

    # The rollback writes the saved bytes back through the same function.
    Set-LanFile $target $first '20261112T100002Z' 'rollback'
    Assert-True (Test-SameBytes (Read-Bytes $target) $first) 'the rollback restores the previous bytes'
    Assert-True ((Get-AccessText $target) -ceq $before) 'the rollback keeps the access rules'

    # The statement that swaps the gateway config right after the service stops is not inside a
    # function. Run its own text with the variable names it uses.
    $inline=@((Get-FileReplaceCalls $updateAst) | Where-Object {$_.Extent.Text.Contains('$newConfigPath') -and $_.Extent.Text.Contains('$configPath')})
    Assert-True ($inline.Count -eq 1) 'the script swaps the gateway config with one File.Replace statement'
    $configPath=$target
    $newConfigPath="$target.new-20261112T100003Z"
    Write-LanNewFile $newConfigPath $second
    . ([scriptblock]::Create($inline[0].Extent.Text))
    Assert-True (Test-SameBytes (Read-Bytes $configPath) $second) 'the config swap statement installs the new config'
    Assert-True (-not [IO.File]::Exists($newConfigPath)) 'the config swap consumes the prepared file'
    Assert-True ((Get-AccessText $configPath) -ceq $before) 'the config swap keeps the access rules'
    Assert-True (@(Get-ChildItem -LiteralPath $root -Force).Count -eq 1) 'the folder holds the config and nothing else'

    # A path with a data stream is refused before anything is written.
    $refused=$false
    try {Set-LanFile ($target+':stream') $first '20261112T100004Z' 'new'} catch {$refused=$true}
    Assert-True $refused 'an alternate data stream is refused'
    Assert-True (Test-SameBytes (Read-Bytes $target) $second) 'a refused write changes nothing'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}

# ---- No Windows script may pass $null as the backup path of File.Replace ----
$scanned=0
foreach ($file in @(Get-ChildItem -LiteralPath $windows -Filter '*.ps1' | Sort-Object Name)) {
    foreach ($call in (Get-FileReplaceCalls (Read-ScriptAst $file.FullName))) {
        Assert-True ($call.Arguments.Count -eq 3) "$($file.Name): File.Replace takes source, target and backup"
        $backup=$call.Arguments[2].Extent.Text
        Assert-True ($backup -cne '$null') "$($file.Name): `$null as the backup path is an empty string in Windows PowerShell 5.1: $($call.Extent.Text)"
        $scanned++
    }
}
Assert-True ($scanned -ge 15) "the scan reads the File.Replace calls of the Windows scripts (found $scanned)"
Write-Output "LAN_FILE_REPLACEMENT_OK checks=$script:count replaceCalls=$scanned"
