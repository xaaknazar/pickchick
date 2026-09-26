#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$PackageDirectory,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
 [Parameter(Mandatory=$true)][string]$ConfigFile,
 [Parameter(Mandatory=$true)][string]$FoundationScript
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$operator=[Security.Principal.WindowsIdentity]::GetCurrent().User
if((Get-FileHash -LiteralPath $FoundationScript -Algorithm SHA256).Hash.ToLowerInvariant() -cne '6addec134f3c5aa548406286ccf061722360cc968dee1d34743365ad61d62af5'){throw 'Reviewed foundation helpers required'}
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($FoundationScript,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid helper source'}
foreach($name in @('Assert-LocalNtfsPath','Open-VerifiedFile','New-ProtectedDirectory','Assert-ProtectedDirectory')) {
 $found=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false)
 if(@($found).Count -ne 1){throw 'Missing helper'}
 . ([scriptblock]::Create($found[0].Extent.Text))
}
# Foundation helper uses this exact variable for the trusted operator SID.
$script:OperatorSid=$operator
$program=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PickChick'
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PickChick'
$serviceRoot=Join-Path $program 'KitchenLink'
$dataRoot=Join-Path $data 'KitchenLink'
$foundation=Join-Path $program 'Edge\edge-0186902'
$node=Join-Path $foundation 'node\node.exe'
$winsw=Join-Path $foundation 'PickChickEdge.exe'
Assert-ProtectedDirectory $program
Assert-ProtectedDirectory $data
Assert-ProtectedDirectory $PackageDirectory
if((Get-Service PickChickKitchenLink -ErrorAction SilentlyContinue) -or (Test-Path $serviceRoot) -or (Test-Path $dataRoot)){throw 'Existing installation must be preserved and reviewed'}
if((Get-Service PickChickEdge).Status -ne 'Running' -or (& $node --version).Trim() -ne 'v24.21.0'){throw 'Verified edge and Node required'}
$manifestPath=Join-Path $PackageDirectory 'agent-package.json'
$manifestHandle=Open-VerifiedFile $manifestPath $ManifestSha256
$reader=[IO.StreamReader]::new($manifestHandle)
try{$manifest=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
$required=@('infra/kitchen-portal/agent.mjs','infra/kitchen-portal/link.mjs','apps/kitchen/server.mjs')
$names=@($manifest.files.PSObject.Properties|ForEach-Object {$_.Name})
if(@(Compare-Object $required $names).Count){throw 'Unexpected agent package paths'}
$config=Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8|ConvertFrom-Json
if($config.origin -cne 'https://pickchick.185.129.51.103.nip.io' -or $config.key -cnotmatch '^[a-f0-9]{64}$'){throw 'Invalid protected link config'}
$stage=Get-Content (Join-Path $data 'EdgeTools\edge-0186902\foundation-stage1.json') -Raw -Encoding UTF8|ConvertFrom-Json
$handles=[Collections.Generic.List[IDisposable]]::new()
function Copy-Stream([IO.Stream]$From,[string]$To){$null=Assert-LocalNtfsPath $To;$s=[IO.File]::Open($To,'CreateNew','Write','None');try{$From.Position=0;$From.CopyTo($s);$s.Flush($true)}finally{$s.Dispose()}}
try{
 $sources=@{}
 foreach($name in $required){$h=Open-VerifiedFile (Join-Path $PackageDirectory $name) $manifest.files.$name;$handles.Add($h);$sources[$name]=$h}
 $wrapper=Open-VerifiedFile $winsw $stage.winSwSha256;$handles.Add($wrapper)
 New-ProtectedDirectory $serviceRoot 'ReadAndExecute'
 New-ProtectedDirectory $dataRoot
 New-ProtectedDirectory (Join-Path $dataRoot 'private') 'ReadAndExecute'
 New-ProtectedDirectory (Join-Path $dataRoot 'logs') 'Modify'
 foreach($dir in @('infra','infra\kitchen-portal','apps','apps\kitchen')){New-ProtectedDirectory (Join-Path $serviceRoot $dir) 'ReadAndExecute'}
 foreach($name in $required){Copy-Stream $sources[$name] (Join-Path $serviceRoot $name)}
 $serviceExe=Join-Path $serviceRoot 'PickChickKitchenLink.exe';Copy-Stream $wrapper $serviceExe
 $configPath=Join-Path $dataRoot 'private\agent.json'
 [IO.File]::WriteAllText($configPath,(@{origin=$config.origin;key=$config.key;edgePort=3101}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 $agent=Join-Path $serviceRoot 'infra\kitchen-portal\agent.mjs'
 $esc={param($v)[Security.SecurityElement]::Escape($v)}
 $xml=@"
<service>
 <id>PickChickKitchenLink</id><name>PickChick Kitchen Link</name>
 <description>Outgoing HTTPS connection for authenticated kitchen screens.</description>
 <executable>$(& $esc $node)</executable>
 <arguments>&quot;$(& $esc $agent)&quot; &quot;$(& $esc $configPath)&quot;</arguments>
 <workingdirectory>$(& $esc $serviceRoot)</workingdirectory>
 <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
 <startmode>Automatic</startmode><delayedAutoStart>true</delayedAutoStart><depend>PickChickEdge</depend>
 <stoptimeout>15 sec</stoptimeout>
 <onfailure action="restart" delay="5 sec"/><onfailure action="restart" delay="15 sec"/><onfailure action="restart" delay="60 sec"/>
 <resetfailure>1 hour</resetfailure><logpath>$(& $esc (Join-Path $dataRoot 'logs'))</logpath>
 <log mode="roll-by-size"><sizeThreshold>5120</sizeThreshold><keepFiles>2</keepFiles></log>
</service>
"@
 [IO.File]::WriteAllText((Join-Path $serviceRoot 'PickChickKitchenLink.xml'),$xml,[Text.UTF8Encoding]::new($false))
 & $serviceExe install
 if($LASTEXITCODE -ne 0){throw 'Service registration failed'}
 Start-Service PickChickKitchenLink
 (Get-Service PickChickKitchenLink).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
 $svc=Get-CimInstance Win32_Service -Filter "Name='PickChickKitchenLink'"
 if($svc.StartName -ne 'NT AUTHORITY\LocalService' -or $svc.StartMode -ne 'Auto'){throw 'Service identity mismatch'}
 [IO.File]::WriteAllText((Join-Path $dataRoot 'installation.json'),(@{manifestSha256=$ManifestSha256;installedAt=[DateTime]::UtcNow.ToString('o');service='PickChickKitchenLink'}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 Write-Output 'KITCHEN_LINK_SERVICE_INSTALLED'
}finally{foreach($h in $handles){$h.Dispose()}}
