"""Emit in-memory PowerShell regression tests; never run the installer entrypoint.

python3 tests/operations/test_windows_kiosk_cart_lines.py --emit-powershell
Run the output in Windows PowerShell 5.1 (SCM and files are mocked).
"""
import base64
import hashlib
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'infra/windows/update-native-kiosk-cart-lines.ps1'
CASES = r'''
$script:cases=0
function Check([bool]$Value,[string]$Why){if(!$Value){throw $Why};$script:cases++}
function Rejects([scriptblock]$Run,[string]$Why){$bad=$false;try{& $Run|Out-Null}catch{$bad=$true};Check $bad $Why}
$a=@(@{scope='edge';checksum='hash';version='001.sql'})
$b=@([pscustomobject]@{version='001.sql';scope='edge';checksum='hash'})
Assert-KioskLedger $a $b;Check $true 'Ledger compares values independently of property order'
Rejects {Assert-KioskLedger @() $b} 'Missing ledger row'
Rejects {Assert-KioskLedger @(@{scope='cloud';checksum='hash';version='001.sql'}) $b} 'Wrong scope'
Rejects {Assert-KioskLedger @(@{scope='edge';checksum='changed';version='001.sql'}) $b} 'Changed checksum'
Assert-KioskRollback @{large=0};Check $true 'Compatible reader rollback'
Rejects {Assert-KioskRollback @{large=1}} 'Never roll back large orders'
$old=@{'node_modules/@pickchick/edge-fulfillment/dist/model.js'=@{sha256='3e15e2f4125f625c46abe65da229396fbd8f684277c2d6870986c03246a8dcea'};'node_modules/@pickchick/edge-fulfillment/dist/model.js.map'=@{sha256='2075b865c086b5c64b1c17e4b265292f8a6cebe9c3c0cc22bea414beab520b77'};'unchanged'=@{sha256='same'}}
$new=@{'node_modules/@pickchick/edge-fulfillment/dist/model.js'=@{sha256='ee226fe2add3545919d2101305471955b1f98f710c85b76ecfc276bc44aefffc'};'node_modules/@pickchick/edge-fulfillment/dist/model.js.map'=@{sha256='6c62d88d80c71e00a4f6c6ab8500b6c2deac4353e628c8d7ea5c49ceab23fc4e'};'unchanged'=@{sha256='same'}}
Assert-KioskRuntimeDelta $old $new;Check $true 'Only reviewed two-file delta'
$bad=$new.Clone();$bad['extra']=@{sha256='bad'};Rejects {Assert-KioskRuntimeDelta $old $bad} 'No extra files'
$bad=$new.Clone();$bad['unchanged']=@{sha256='bad'};Rejects {Assert-KioskRuntimeDelta $old $bad} 'No unrelated changes'
$bad=$new.Clone();$bad['node_modules/@pickchick/edge-fulfillment/dist/model.js']=@{sha256='bad'};Rejects {Assert-KioskRuntimeDelta $old $bad} 'Wrong reviewed bytes'
function Reset-Mock {
 $script:binding='old';$script:running=$true;$script:log=@();$script:failure='';$script:large=0;$script:dbError=$false;$script:ledger=$a
}
function Read-KioskWorkerXml([string]$Path){return $script:binding}
function Stop-KioskWorker {
 $script:log+='stop';$script:running=$false
 if($script:failure -ceq 'stop'){$script:failure='';throw 'Partial stop'}
}
function Replace-UnifiedXml([string]$Path,[string]$Before,[string]$After){
 if($script:failure -ceq 'foreign'){$script:binding='foreign';throw 'CAS conflict'}
 if($script:binding -cne $Before){throw 'Stale CAS'}
 $script:binding=$After;$script:log+='replace:'+ $After
 if($script:failure -ceq 'replace'){$script:failure='';throw 'Partial replace'}
}
function Start-KioskWorker([string]$App){
 $script:log+='start:'+ $App
 if($script:failure -ceq 'start'){$script:failure='';throw 'Failed candidate start'}
 $script:running=$true
}
function Read-KioskDatabaseState{if($script:dbError){throw 'DB unavailable'};return @{ledger=$a;large=$script:large}}
function Assert-KioskPreserved {if($script:failure -ceq 'preserved'){$script:failure='';throw 'Neighbor changed'}}
Reset-Mock;Invoke-KioskWorkerSwitch 'unused' 'old' 'new' 'oldApp' 'newApp'
Check ($script:running -and $script:binding -ceq 'new') 'Successful switch'
Check (($script:log -join ',') -ceq 'stop,replace:new,start:newApp') 'Only worker switches'
foreach($fault in @('stop','replace','start','preserved')){
 Reset-Mock;$script:failure=$fault
 Rejects {Invoke-KioskWorkerSwitch 'unused' 'old' 'new' 'oldApp' 'newApp'} ('Failure reported: '+$fault)
 Check ($script:running -and $script:binding -ceq 'old') ('Recovery after '+$fault)
}
foreach($condition in @('large','db-unavailable')){
 Reset-Mock;$script:failure='preserved'
 if($condition -ceq 'large'){$script:large=1}else{$script:dbError=$true}
 Rejects {Invoke-KioskWorkerSwitch 'unused' 'old' 'new' 'oldApp' 'newApp'} ('Failure retained: '+$condition)
 Check ($script:running -and $script:binding -ceq 'new') ('Compatible new reader retained: '+$condition)
}
Reset-Mock;$script:failure='foreign'
Rejects {Invoke-KioskWorkerSwitch 'unused' 'old' 'new' 'oldApp' 'newApp'} 'Foreign binding stops recovery'
Check ($script:binding -ceq 'foreign' -and !$script:running) 'No foreign binding overwritten or started'
Write-Output ('kiosk-cart-lines: '+$script:cases+' checks passed; mocked SCM, no installation')
'''


def powershell_tests():
    encoded = base64.b64encode(SOURCE.read_bytes()).decode()
    return r'''Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(''' + "'" + encoded + "'" + r'''))
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
$functions=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
. ([scriptblock]::Create(($functions.Extent.Text -join "`n")))
''' + CASES


class ReviewedHelperTests(unittest.TestCase):
    def test_imported_helper_bytes_are_pinned(self):
        pins = re.findall(r"Import-KioskFunctions \(Join-Path \$PSScriptRoot '([^']+)'\) '([a-f0-9]{64})'", SOURCE.read_text())
        self.assertEqual(len(pins), 3)
        for name, expected in pins:
            self.assertEqual(hashlib.sha256((SOURCE.parent / name).read_bytes()).hexdigest(), expected)


if __name__ == '__main__':
    if sys.argv[1:] == ['--emit-powershell']:
        print(powershell_tests())
    else:
        unittest.main()
