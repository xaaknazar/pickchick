#Requires -Version 5.1
# Read-only observation. Does not start, stop, configure or probe customer orders.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Read-ServicePolicy([string]$Name) {
    $service = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
    if ($null -eq $service) { return [ordered]@{ name=$Name; installed=$false } }
    $registry = Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\'+$Name)
    $delayed = $registry.PSObject.Properties['DelayedAutoStart']
    $failureFlag = $registry.PSObject.Properties['FailureActionsOnNonCrashFailures']
    $sc = Join-Path $env:SystemRoot 'System32\sc.exe'
    # qfailure contains recovery policy only, never service arguments/env/key files.
    $failure = @(& $sc qfailure $Name 2>&1 | ForEach-Object { $_.ToString() })
    if ($LASTEXITCODE -ne 0) { throw 'Cannot observe SCM failure actions.' }
    return [ordered]@{
        name=$Name; installed=$true; state=$service.State; startMode=$service.StartMode
        delayedAutoStart=($null -ne $delayed -and $delayed.Value -eq 1)
        recoverNonCrashFailures=($null -ne $failureFlag -and $failureFlag.Value -eq 1)
        exitCode=$service.ExitCode; serviceSpecificExitCode=$service.ServiceSpecificExitCode
        processId=$service.ProcessId
        dependencies=@((Get-Service -Name $Name).ServicesDependedOn | ForEach-Object {$_.Name})
        failureActions=$failure
    }
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows observation required.' }
$names=@('PickChickPostgres','PickChickEdge','PickChickKitchenLink','PickChickFulfillmentTunnel','PickChickFulfillmentWorker')
$services=@($names | ForEach-Object { Read-ServicePolicy $_ })
$ready=$false
try {
    $response=Invoke-RestMethod -Uri 'http://127.0.0.1:3101/health/ready' -TimeoutSec 3
    $ready=($response.ready -eq $true)
} catch { $ready=$false }
$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in @(55433,3101,43100)} | Select-Object LocalAddress,LocalPort,OwningProcess)
[ordered]@{
    format='pickchick-connection-observation-v1'; observedAt=[DateTime]::UtcNow.ToString('o')
    lastBootAt=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    localEdgeReady=$ready; services=$services; listeners=$listeners
    rebootTested=$false; wanLossTested=$false
} | ConvertTo-Json -Depth 6
