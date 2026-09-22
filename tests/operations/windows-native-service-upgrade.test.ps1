# Portable pure-boundary tests only; actual Windows SCM/NTFS execution is separate.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$path=Join-Path $PSScriptRoot '../../infra/windows/update-native-service.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count) {throw ($errors | Out-String)}
foreach($name in @('Assert-BackupRecord','Quote-UpdateArgument','Read-UpdateXml','Assert-PreservedData')) {
    $func=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false)
    . ([scriptblock]::Create($func.Extent.Text))
}
function Rejected([scriptblock]$Run) {try {& $Run;throw 'EXPECTED_REJECTION'} catch {if($_.Exception.Message -eq 'EXPECTED_REJECTION') {throw}}}
$branch='10000000-0000-4000-8000-000000000001';$cluster='1234567890123456789'
$counts=[ordered]@{local_orders='0';checkout_quotes='0';schema_migrations='9'}
for($i=0;$i -lt 27;$i++) {$counts['synthetic_'+$i]='0'}
$backup=[pscustomobject]@{format='pickchick-native-backup-v1';branchId=$branch;systemIdentifier=$cluster;sourceDatabase='pickchick_edge';backupVerified=$true;restoreVerified=$true;rehearsalDropped=$true;completed=$true;sha256=('a'*64);archiveBytes=100;tableCounts=[pscustomobject]$counts}
Assert-BackupRecord $backup $branch $cluster
foreach($field in @('backupVerified','restoreVerified','rehearsalDropped','completed')) {$bad=$backup | ConvertTo-Json -Depth 4 | ConvertFrom-Json;$bad.$field=$false;Rejected {Assert-BackupRecord $bad $branch $cluster}}
Rejected {Assert-BackupRecord $backup 'other' $cluster};Rejected {Assert-BackupRecord $backup $branch 'other'}
$bad=$backup | ConvertTo-Json -Depth 4 | ConvertFrom-Json;$bad.tableCounts.local_orders='1';Rejected {Assert-BackupRecord $bad $branch $cluster}
foreach($arg in @("a`nb","a`rb",('a'+[char]0+'b'))) {Rejected {Quote-UpdateArgument $arg}}
if((Quote-UpdateArgument 'C:\folder with space\') -cne '"C:\folder with space\\"') {throw 'CRT trailing slash quoting differs.'}
$app=Join-Path ([IO.Path]::GetTempPath()) 'pickchick-old-app';$node=Join-Path ([IO.Path]::GetTempPath()) 'node.exe';$envFile=Join-Path ([IO.Path]::GetTempPath()) 'edge.env';$logs=Join-Path ([IO.Path]::GetTempPath()) 'logs'
$escape={param($value) [Security.SecurityElement]::Escape($value)}
$main=Join-Path $app 'dist\main.js'
$xml=@"
<service><id>PickChickEdge</id><name>PickChick Edge</name><description>Local PickChick foundation. Restaurant provisioning is separate.</description><executable>$(& $escape $node)</executable><arguments>--env-file="$(& $escape $envFile)" "$(& $escape $main)"</arguments><workingdirectory>$(& $escape $app)</workingdirectory><serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount><startmode>Automatic</startmode><delayedAutoStart>true</delayedAutoStart><depend>PickChickPostgres</depend><stoptimeout>30 sec</stoptimeout><onfailure action="restart" delay="5 sec"/><onfailure action="restart" delay="15 sec"/><onfailure action="restart" delay="60 sec"/><resetfailure>1 hour</resetfailure><logpath>$(& $escape $logs)</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log></service>
"@
$doc=Read-UpdateXml $xml $node $envFile $app $logs
if($doc.service.id -ne 'PickChickEdge') {throw 'XML return binding differs.'}
foreach($badXml in @($xml.Replace('LocalService','LocalSystem'),$xml.Replace('delay="5 sec"','delay="0 sec"'),$xml.Replace('</service>','<env name="NODE_OPTIONS" value="bad"/></service>'),('<!DOCTYPE service [<!ENTITY bad "bad">]>'+$xml))) {Rejected {Read-UpdateXml $badXml $node $envFile $app $logs}}
# Catch accidental PowerShell tuple flattening before physical extraction.
$appPlan=[Collections.Generic.List[object]]::new();$appPlan.Add([pscustomobject]@{Target='a'});$appPlan.Add([pscustomobject]@{Target='b'})
$toolsPlan=[Collections.Generic.List[object]]::new();$toolsPlan.Add([pscustomobject]@{Target='c'})
$seen=@();foreach($pair in @(@($appPlan,'ReadAndExecute'),@($toolsPlan,''))) {foreach($item in $pair[0]) {$seen+=($item.Target+':'+$pair[1])}}
if(($seen -join ',') -cne 'a:ReadAndExecute,b:ReadAndExecute,c:') {throw 'Extraction pair shape differs.'}
$helper=Join-Path $PSScriptRoot '../../infra/windows/native-service-upgrade-db.mjs';$hash=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
if(-not $ast.Extent.Text.Contains("`$databaseHelperSha='$hash'")) {throw 'Database helper pin is stale.'}

$script:branch=$branch;$script:state=[pscustomobject]@{before=[pscustomobject]@{fingerprints=[pscustomobject]@{branch_config='same'}}}
foreach($version in 9..14) {$valid=[pscustomobject]@{branchId=$branch;migrations=$version;serviceMode='payment_required';orderingEnabled=$false;fingerprints=[pscustomobject]@{branch_config='same'}};Assert-PreservedData $valid -Partial;if($version -eq 14) {Assert-PreservedData $valid} else {Rejected {Assert-PreservedData $valid}}}
foreach($field in @('branchId','serviceMode')) {$bad=$valid | ConvertTo-Json -Depth 4 | ConvertFrom-Json;$bad.$field='wrong';Rejected {Assert-PreservedData $bad -Partial}}
$bad=$valid | ConvertTo-Json -Depth 4 | ConvertFrom-Json;$bad.fingerprints.branch_config='changed';Rejected {Assert-PreservedData $bad -Partial}
if(-not $ast.Extent.Text.Contains("Read-UpdateDatabase 'progress'")) {throw 'Missing interrupted migration checkpoint verification.'}
[pscustomobject]@{migrationCheckpoints=6;parser='pass';backupRejections=7;argumentRejections=3;xmlRejections=4;extractionTuples='pass';helperPin='pass';windowsScmAndNtfs='not tested'} | ConvertTo-Json
