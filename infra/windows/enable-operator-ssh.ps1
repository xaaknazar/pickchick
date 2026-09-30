#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PublicKeyFile)
$ErrorActionPreference='Stop'
$ProgressPreference='Continue'
Write-Host '[1/5] Checking Windows OpenSSH component...'
$operatorKey=(Get-Content -LiteralPath $PublicKeyFile -Raw).Trim()
if($operatorKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$'){throw 'A single Ed25519 public key is required.'}
$capability=Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
if($capability.State -ne 'Installed'){Write-Host 'Installing OpenSSH. Windows may download it; please leave this window open.';$null=Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'}
Write-Host '[2/5] Configuring the SSH service...'
$sshRoot=Join-Path $env:ProgramData 'ssh'
# Restrict the standard rule before Windows creates its host keys.
$initialRule=Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if($initialRule){$initialRule | Set-NetFirewallRule -Enabled False}
Start-Service sshd
$sshConfig=Join-Path $sshRoot 'sshd_config'
$original=Get-Content -LiteralPath $sshConfig -Raw
$backup=$sshConfig+'.pickchick-backup-'+(Get-Date -Format 'yyyyMMddHHmmss')
Copy-Item -LiteralPath $sshConfig -Destination $backup
$marker='# PickChick operator access: public key only'
if(-not $original.StartsWith($marker)){
 $updated=$marker+"`r`nPasswordAuthentication no`r`nPubkeyAuthentication yes`r`n"+$original
 [IO.File]::WriteAllText($sshConfig,$updated,[Text.UTF8Encoding]::new($false))
}
Write-Host '[3/5] Installing the public operator key...'
$keysFile=Join-Path $sshRoot 'administrators_authorized_keys'
$lines=@()
if(Test-Path -LiteralPath $keysFile){$lines=@(Get-Content -LiteralPath $keysFile)}
if($lines -notcontains $operatorKey){$lines+= $operatorKey}
[IO.File]::WriteAllText($keysFile,($lines -join "`r`n")+"`r`n",[Text.UTF8Encoding]::new($false))
# SID-based ACLs work on Russian/Kazakh/English Windows alike.
$acl=[Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
foreach($sidText in @('S-1-5-32-544','S-1-5-18')){
 $sid=[Security.Principal.SecurityIdentifier]::new($sidText)
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
}
$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
Set-Acl -LiteralPath $keysFile -AclObject $acl
# Older Windows OpenSSH configurations use the user's file even for administrators.
$userSsh=Join-Path $env:USERPROFILE '.ssh'
$null=New-Item -ItemType Directory -Force -Path $userSsh
$userKeys=Join-Path $userSsh 'authorized_keys'
$userLines=@()
if(Test-Path -LiteralPath $userKeys){$userLines=@(Get-Content -LiteralPath $userKeys)}
if($userLines -notcontains $operatorKey){$userLines+=$operatorKey}
[IO.File]::WriteAllText($userKeys,($userLines -join "`r`n")+"`r`n",[Text.UTF8Encoding]::new($false))
$userAcl=[Security.AccessControl.FileSecurity]::new()
$userAcl.SetAccessRuleProtection($true,$false)
$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($sid in @($currentSid,[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
 $userAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
}
$userAcl.SetOwner($currentSid)
Set-Acl -LiteralPath $userKeys -AclObject $userAcl
Write-Host '[4/5] Validating configuration...'
$sshd=Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
& $sshd -t
if($LASTEXITCODE -ne 0){Copy-Item -LiteralPath $backup -Destination $sshConfig -Force;throw 'SSH configuration check failed; previous configuration restored.'}
Write-Host '[5/5] Limiting access to the local subnet...'
$rule=Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if($rule){$rule | Set-NetFirewallRule -Enabled True -Profile Any -RemoteAddress LocalSubnet}
else{New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH LAN operator access' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress LocalSubnet -Profile Any | Out-Null}
Set-Service -Name sshd -StartupType Automatic
Restart-Service sshd
Write-Host 'READY - SSH uses a public key and is limited to the local subnet.'
Write-Host ('WINDOWS USER: '+$env:USERNAME)
Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'} | Select-Object InterfaceAlias,IPAddress
$hostKey=Join-Path $sshRoot 'ssh_host_ed25519_key.pub'
if(Test-Path -LiteralPath $hostKey){& (Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe') -lf $hostKey}
