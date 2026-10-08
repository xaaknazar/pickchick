# Read-only tests: parse the complete installer and invoke only its CI proof validator.
param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$CiProof)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Installer,[ref]$tokens,[ref]$errors)
if($errors.Count) {throw 'Installer parse failed.'}
$function=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-KioskCiProof'},$false))
if($function.Count -ne 1) {throw 'CI validator missing.'}
. ([scriptblock]::Create($function[0].Extent.Text))
$original=[IO.File]::ReadAllText($CiProof)
$proof=$original | ConvertFrom-Json
Assert-KioskCiProof $proof $proof.run.head_sha
$mutations=@(
 {param($p) $p.run.head_sha='0'*40},
 {param($p) $p.run.conclusion='failure'},
 {param($p) $p.run.path='unrelated.yml'},
 {param($p) $p.run.head_repository.full_name='other/repo'},
 {param($p) $p.jobs.jobs[0].head_sha='0'*40},
 {param($p) $p.jobs.jobs[0].conclusion='skipped'},
 {param($p) $p.jobs.jobs=@($p.jobs.jobs | Select-Object -Skip 1)},
 {param($p) $p.jobs.total_count=100},
 {param($p) $p.jobs.jobs[0].name=$p.jobs.jobs[1].name}
)
foreach($change in $mutations) {
 $bad=$original | ConvertFrom-Json
 & $change $bad
 $rejected=$false
 try {Assert-KioskCiProof $bad $proof.run.head_sha} catch {$rejected=$true}
 if(-not $rejected) {throw 'Unsafe CI proof accepted.'}
}
'PASS: native PowerShell parsing and 10 CI proof cases; no installer execution.'
