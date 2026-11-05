$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Functions of the LAN client scripts, loaded from their AST without running the scripts.
# Driven by tests/operations/kitchen-lan.test.mjs, which starts synthetic gateways on loopback
# and checks every file this suite writes with the real gateway and app validators.
$windows = Join-Path $PSScriptRoot '../../infra/windows'
function Get-ScriptFunctions([string]$Path) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw "Parse errors in $Path" }
  $map = [ordered]@{}
  foreach ($node in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($map.Contains($node.Name)) { throw "Duplicate function $($node.Name) in $Path" }
    $map[$node.Name] = $node.Extent.Text
  }
  return $map
}
$kitchen = Get-ScriptFunctions (Join-Path $windows 'install-kitchen-client.ps1')
$pos = Get-ScriptFunctions (Join-Path $windows 'install-pos-client.ps1')
$update = Get-ScriptFunctions (Join-Path $windows 'update-kitchen-lan-clients.ps1')
$installer = Get-ScriptFunctions (Join-Path $windows 'install-kitchen-lan.ps1')
$script:count = 0
function Assert-True($Condition, [string]$Message) {
  if (-not $Condition) { throw "FAILED: $Message" }
  $script:count++
}
function Assert-Throws([scriptblock]$Block, [string]$Pattern, [string]$Message) {
  $thrown = $null
  try { $null = & $Block } catch { $thrown = $_.Exception.Message }
  if ($null -eq $thrown -or -not $thrown.Contains($Pattern)) { throw "FAILED: $Message (expected $Pattern, got [$thrown])" }
  $script:count++
}
$shared = @('Test-LanIPv4', 'Test-LanText', 'ConvertFrom-LanJsonObject', 'Read-LanPublicConfig', 'Read-LanDerLength', 'Get-LanSanIPv4', 'Get-LanCertificate', 'Assert-LanCertificate', 'Invoke-LanProbe', 'Test-LanClientProfile', 'Write-LanJsonFile', 'Get-LanAppVersion', 'Set-LanAutostart', 'Get-LanAutostart')
foreach ($name in $shared) { Assert-True ($kitchen.Contains($name) -and $pos.Contains($name) -and $kitchen[$name] -ceq $pos[$name]) "$name is the same in both client installers" }
foreach ($name in @('Test-LanIPv4', 'Test-LanText')) { Assert-True ($update[$name] -ceq $kitchen[$name]) "$name is the same in the update script" }
Assert-True ($update['Test-LanIPv4'] -ceq $installer['Test-LanIPv4']) 'Test-LanIPv4 is the installer one'
Assert-True ($update['Assert-LanAcl'] -ceq $installer['Assert-LanAcl']) 'Assert-LanAcl is the installer one'
foreach ($text in $kitchen.Values) { . ([scriptblock]::Create($text)) }
foreach ($name in @('New-PosPrinter', 'New-PosClientConfig')) { . ([scriptblock]::Create($pos[$name])) }
foreach ($name in @('Read-LanClients', 'ConvertTo-LanJsonString', 'New-LanGatewayConfig', 'Get-LanProfileCounts')) { . ([scriptblock]::Create($update[$name])) }

$utf8 = [Text.UTF8Encoding]::new($false)
$out = $env:LAN_TEST_OUT
$hostAddress = $env:LAN_TEST_HOST
$pem = [IO.File]::ReadAllText($env:LAN_TEST_CERT)
$otherPem = [IO.File]::ReadAllText($env:LAN_TEST_OTHER_CERT)
$sha = $env:LAN_TEST_CERT_SHA
$ports = $env:LAN_TEST_PORTS | ConvertFrom-Json
$id = '10000000-0000-4000-8000-000000000011'
$otherId = '10000000-0000-4000-8000-000000000012'
$label = -join [char[]](0x0422, 0x043E, 0x0447, 0x043A, 0x0430)
function Json([object]$Value) { return $utf8.GetBytes(($Value | ConvertTo-Json -Depth 5 -Compress)) }

# ---- Addresses ----
foreach ($good in @('10.0.1.2', '172.16.0.1', '172.31.255.254', '192.168.77.10')) { Assert-True (Test-LanIPv4 $good) "$good is private" }
foreach ($bad in @('127.0.0.1', '0.0.0.0', '8.8.8.8', '172.32.0.1', '10.01.1.2', '10', '::1', 'localhost', '', '192.168.1.1 ')) { Assert-True (-not (Test-LanIPv4 $bad)) "$bad is refused" }

# ---- Public config ----
$public = [ordered]@{ edgeHost = $hostAddress; edgePort = 3443; edgeCertificatePem = $pem; terminalId = $id; branchLabel = $label }
$read = Read-LanPublicConfig (Json $public)
Assert-True ($read.edgeHost -ceq $hostAddress -and $read.edgePort -eq 3443 -and $read.edgePort -is [int]) 'public config address'
Assert-True ($read.edgeCertificatePem -ceq ($pem.Trim() + "`n") -and $read.branchLabel -ceq $label) 'public config certificate and label'
Assert-True (-not $read.Contains('terminalId')) 'the public terminalId is never used'
$bom = [byte[]](@(0xEF, 0xBB, 0xBF) + (Json $public))
Assert-True ((Read-LanPublicConfig $bom).edgeHost -ceq $hostAddress) 'a BOM is accepted'
Assert-Throws { Read-LanPublicConfig (Json ([ordered]@{ edgeHost = $hostAddress; edgePort = 3443; edgeCertificatePem = $pem; extra = 1 })) } 'LAN_PUBLIC_CONFIG_INVALID' 'unexpected key'
Assert-Throws { Read-LanPublicConfig (Json ([ordered]@{ edgeHost = $hostAddress; edgePort = 3443 })) } 'LAN_PUBLIC_CONFIG_INVALID' 'missing certificate'
Assert-Throws { Read-LanPublicConfig (Json ([ordered]@{ edgeHost = '8.8.8.8'; edgePort = 3443; edgeCertificatePem = $pem })) } 'LAN_PUBLIC_CONFIG_INVALID' 'public address'
Assert-Throws { Read-LanPublicConfig (Json ([ordered]@{ edgeHost = $hostAddress; edgePort = '3443'; edgeCertificatePem = $pem })) } 'LAN_PUBLIC_CONFIG_INVALID' 'port as text'
Assert-Throws { Read-LanPublicConfig (Json ([ordered]@{ edgeHost = $hostAddress; edgePort = 80; edgeCertificatePem = $pem })) } 'LAN_PUBLIC_CONFIG_INVALID' 'privileged port'
Assert-Throws { Read-LanPublicConfig $utf8.GetBytes('[1]') } 'LAN_JSON_INVALID' 'array'
Assert-Throws { Read-LanPublicConfig ([byte[]](0x7B, 0xC0, 0xAF, 0x7D)) } 'LAN_JSON_INVALID' 'invalid UTF-8'
Assert-Throws { Read-LanPublicConfig ([byte[]]::new(0)) } 'LAN_JSON_INVALID' 'empty'

# ---- Certificate ----
$certificate = Get-LanCertificate $pem
Assert-True ($certificate.Sha256 -ceq $sha) 'the DER SHA-256 of the certificate'
Assert-True (@($certificate.IPv4) -ccontains $hostAddress) 'the IP SAN'
Assert-LanCertificate $certificate $sha.ToUpperInvariant() $hostAddress (Get-Date); $script:count++
Assert-Throws { Assert-LanCertificate $certificate ('0' * 64) $hostAddress (Get-Date) } 'LAN_CERTIFICATE_SHA256_MISMATCH' 'another pin'
$other = Get-LanCertificate $otherPem
Assert-Throws { Assert-LanCertificate $other $other.Sha256 $hostAddress (Get-Date) } 'LAN_CERTIFICATE_IP_MISMATCH' 'a certificate of another IP'
Assert-Throws { Assert-LanCertificate $certificate $sha $hostAddress ((Get-Date).AddDays(30)) } 'LAN_CERTIFICATE_NOT_VALID_NOW' 'expired'
Assert-Throws { Assert-LanCertificate $certificate $sha $hostAddress ((Get-Date).AddDays(-30)) } 'LAN_CERTIFICATE_NOT_VALID_NOW' 'not yet valid'
Assert-Throws { Get-LanCertificate ($pem + $pem) } 'LAN_CERTIFICATE_INVALID' 'two certificates'
Assert-Throws { Get-LanCertificate "-----BEGIN PRIVATE KEY-----`nAAAA`n-----END PRIVATE KEY-----" } 'LAN_CERTIFICATE_INVALID' 'a key'
# subjectAltName: DNS name, IPv4, IPv6 (only the IPv4 counts), short and long DER lengths.
$san = [byte[]](0x30, 0x1D, 0x82, 0x03, 0x61, 0x2E, 0x62, 0x87, 0x04, 10, 20, 0, 1, 0x87, 0x10) + [byte[]]::new(16)
Assert-True ((@(Get-LanSanIPv4 $san) -join ',') -ceq '10.20.0.1') 'SAN IPv4 only'
$long = [byte[]](0x30, 0x81, 0x06, 0x87, 0x04, 192, 168, 7, 9)
Assert-True ((@(Get-LanSanIPv4 $long) -join ',') -ceq '192.168.7.9') 'SAN long-form length'
Assert-Throws { Get-LanSanIPv4 ([byte[]](0x30, 0x06, 0x87, 0x04, 10, 20)) } 'LAN_CERTIFICATE_INVALID' 'truncated SAN'
Assert-Throws { Get-LanSanIPv4 ([byte[]](0x31, 0x00)) } 'LAN_CERTIFICATE_INVALID' 'not a SEQUENCE'

# ---- Probes against the synthetic gateways (one per client profile) ----
$k = Test-LanClientProfile $hostAddress $ports.kitchen $sha 'kitchen' '127.0.0.1' 3
Assert-True ($k.Health -eq 200 -and $k.Reached -eq 401 -and $k.Blocked -eq 404) 'kitchen profile'
$d = Test-LanClientProfile $hostAddress $ports.display $sha 'display' '127.0.0.1' 3
Assert-True ($d.Reached -eq 200 -and $d.Blocked -eq 404) 'display profile'
$p = Test-LanClientProfile $hostAddress $ports.pos $sha 'pos' '127.0.0.1' 3
Assert-True ($p.Reached -eq 401 -and $p.Blocked -eq 404) 'pos profile'
Assert-Throws { Test-LanClientProfile $hostAddress $ports.kitchen $sha 'pos' '127.0.0.1' 3 } 'LAN_PROFILE_MISMATCH' 'a kitchen IP is not a cash desk'
Assert-Throws { Test-LanClientProfile $hostAddress $ports.kitchen $sha 'display' '127.0.0.1' 3 } 'LAN_PROFILE_MISMATCH' 'a kitchen IP is not the board'
Assert-Throws { Test-LanClientProfile $hostAddress $ports.pos $sha 'kitchen' '127.0.0.1' 3 } 'LAN_PROFILE_MISMATCH' 'a desk IP is not a kitchen screen'
Assert-Throws { Test-LanClientProfile $hostAddress $ports.display $sha 'kitchen' '127.0.0.1' 3 } 'LAN_PROFILE_MISMATCH' 'the board IP is not a kitchen screen'
Assert-Throws { Test-LanClientProfile $hostAddress $ports.unlisted $sha 'kitchen' '127.0.0.1' 3 } 'LAN_CLIENT_NOT_LISTED' 'an unlisted IP'
Assert-Throws { Invoke-LanProbe $hostAddress $ports.kitchen $other.Sha256 '/healthz' '127.0.0.1' } 'LAN_PROBE_CERTIFICATE_MISMATCH' 'another certificate pin'
Assert-Throws { Invoke-LanProbe $hostAddress $ports.closed $sha '/healthz' '127.0.0.1' 2000 } 'LAN_PROBE_UNREACHABLE' 'nothing listens'

# ---- Client list of the gateway ----
$bind = '10.20.0.1'
$clients = @(
  [ordered]@{ address = '10.20.0.11'; profile = 'kitchen'; label = $label },
  [ordered]@{ address = '10.20.0.12'; profile = 'display' },
  [ordered]@{ address = '10.20.0.21'; profile = 'pos'; label = 'Desk "1" \ A' },
  [ordered]@{ address = '10.20.0.22'; profile = 'pos' }
)
$list = @(Read-LanClients (Json $clients) $bind)
Assert-True ($list.Count -eq 4 -and $list[0].label -ceq $label -and -not $list[1].Contains('label')) 'clients are read'
$counts = Get-LanProfileCounts $list
Assert-True ($counts.kitchen -eq 1 -and $counts.display -eq 1 -and $counts.pos -eq 2) 'profile counts'
$single = @(Read-LanClients $utf8.GetBytes('[{"address":"10.20.0.11","profile":"kitchen"}]') $bind -Legacy)
Assert-True ($single.Count -eq 1 -and $single[0].address -ceq '10.20.0.11') 'one legacy kitchen client'
Assert-Throws { Read-LanClients (Json $clients) $bind -Legacy } 'LAN_CLIENTS_LEGACY_KITCHEN_ONLY' 'legacy has kitchen screens only'
$many = @(1..33 | ForEach-Object { [ordered]@{ address = "10.20.1.$_"; profile = 'kitchen' } })
Assert-Throws { Read-LanClients (Json $many) $bind } 'LAN_CLIENTS_INVALID' '33 clients'
Assert-True (@(Read-LanClients (Json ($many[0..31])) $bind).Count -eq 32) '32 clients'
Assert-Throws { Read-LanClients (Json ($many[0..20])) $bind -Legacy } 'LAN_CLIENTS_INVALID' '21 legacy clients'
foreach ($bad in @(
    '[]', '{"address":"10.20.0.11","profile":"kitchen"}', '[{"address":"10.20.0.11"}]',
    '[{"address":"10.20.0.11","profile":"Kitchen"}]', '[{"address":"10.20.0.11","profile":"owner"}]',
    '[{"address":"10.20.0.011","profile":"kitchen"}]', '[{"address":"8.8.8.8","profile":"kitchen"}]',
    '[{"address":"10.20.0.1","profile":"kitchen"}]', '[{"address":167772171,"profile":"kitchen"}]',
    '[{"address":"10.20.0.11","profile":"kitchen"},{"address":"10.20.0.11","profile":"pos"}]',
    '[{"address":"10.20.0.11","profile":"kitchen","extra":1}]', '[{"address":"10.20.0.11","profile":"kitchen","label":""}]',
    ('[{"address":"10.20.0.11","profile":"kitchen","label":"' + ('x' * 61) + '"}]'), '[{"address":"10.20.0.11","profile":"kitchen","label":"a\nb"}]', '[1]')) {
  Assert-Throws { Read-LanClients $utf8.GetBytes($bad) $bind } 'LAN_CLIENTS' "clients file $bad"
}

# ---- Gateway config text (the Node test runs the gateway --check on both files) ----
foreach ($text in @('plain', 'quote " and \ back', ("tab`tnew`n"), $label, ([string][char]0xD83C + [char]0xDF57))) {
  Assert-True ((ConvertFrom-Json -InputObject ('{"v":' + (ConvertTo-LanJsonString $text) + '}')).v -ceq $text) "JSON string round trip"
}
$current = ConvertFrom-Json -InputObject (@{ bindAddress = $bind; port = 3443; clientAddresses = @('10.20.0.11'); edgePort = 3101; pfxPath = $env:LAN_TEST_PFX; passphrase = $env:LAN_TEST_PASSPHRASE } | ConvertTo-Json -Compress)
$profiled = New-LanGatewayConfig $current $list
Assert-True ($profiled -cmatch '^[\x20-\x7e]+$' -and $profiled.Contains('\' + 'u0422')) 'the gateway config is ASCII JSON'
$parsed = ConvertFrom-Json -InputObject $profiled
Assert-True (@($parsed.PSObject.Properties.Name) -join ',' -ceq 'bindAddress,port,clients,maxConnections,edgePort,pfxPath,passphrase') 'gateway config keys'
Assert-True (@($parsed.clients).Count -eq 4 -and $parsed.clients[2].label -ceq 'Desk "1" \ A' -and $parsed.maxConnections -eq 64 -and $parsed.passphrase -ceq $env:LAN_TEST_PASSPHRASE) 'gateway clients'
[IO.File]::WriteAllText((Join-Path $out 'gateway-clients.json'), $profiled, $utf8)
$legacy = New-LanGatewayConfig $current $single -Legacy
$parsed = ConvertFrom-Json -InputObject $legacy
Assert-True ((@($parsed.PSObject.Properties.Name) -join ',') -ceq 'bindAddress,port,clientAddresses,edgePort,pfxPath,passphrase' -and @($parsed.clientAddresses).Count -eq 1) 'legacy gateway config'
[IO.File]::WriteAllText((Join-Path $out 'gateway-legacy.json'), $legacy, $utf8)
$withExtra = ConvertFrom-Json -InputObject '{"bindAddress":"10.20.0.1","port":3443,"edgePort":3101,"pfxPath":"x","passphrase":"0123456789abcdef0123456789abcdef","owner":1}'
Assert-Throws { New-LanGatewayConfig $withExtra $list } 'LAN_CONFIG_INVALID' 'unknown key in the installed config'
$short = ConvertFrom-Json -InputObject '{"bindAddress":"10.20.0.1","port":3443,"edgePort":3101,"pfxPath":"x","passphrase":"short"}'
Assert-Throws { New-LanGatewayConfig $short $list } 'LAN_CONFIG_INVALID' 'short passphrase'

# ---- Kitchen client config (the Node test validates every file with kitchen-desktop) ----
$publicRead = Read-LanPublicConfig (Json $public)
function Save([string]$Name, $Config) { [IO.File]::WriteAllText((Join-Path $out $Name), ($Config | ConvertTo-Json -Depth 5 -Compress), $utf8) }
$fresh = New-KitchenClientConfig $null $publicRead 'prep' ([guid]::Empty)
Assert-True ($fresh.terminalMode -ceq 'prep' -and $fresh.edgeHost -ceq $hostAddress -and $fresh.branchLabel -ceq $label -and -not $fresh.Contains('terminalId')) 'fresh paired kitchen screen'
Save 'kitchen-prep.json' $fresh
Save 'kitchen-display.json' (New-KitchenClientConfig $null $publicRead 'display' ([guid]::Empty))
$staffExisting = ConvertFrom-Json -InputObject ('{"edgePort":3101,"branchLabel":"Old","terminalId":"' + $id + '"}')
$staff = New-KitchenClientConfig $staffExisting $publicRead 'staff' ([guid]::Empty)
Assert-True ($staff.terminalId -ceq $id -and $staff.branchLabel -ceq 'Old' -and $staff.edgePort -eq 3443 -and -not $staff.Contains('terminalMode')) 'staff screen keeps its terminal and label'
Save 'kitchen-staff.json' $staff
Assert-Throws { New-KitchenClientConfig $staffExisting $publicRead 'staff' ([guid]$otherId) } 'KITCHEN_TERMINAL_CHANGE' 'another terminal'
Assert-True ((New-KitchenClientConfig $staffExisting $publicRead 'staff' ([guid]$otherId) -Replace).terminalId -ceq $otherId) 'terminal change with -Replace'
Assert-Throws { New-KitchenClientConfig $staffExisting $publicRead 'prep' ([guid]::Empty) } 'KITCHEN_MODE_CHANGE' 'staff to paired'
$paired = ConvertFrom-Json -InputObject '{"terminalMode":"prep"}'
Assert-Throws { New-KitchenClientConfig $paired $publicRead 'display' ([guid]::Empty) } 'KITCHEN_MODE_CHANGE' 'another paired mode'
Assert-True ((New-KitchenClientConfig $paired $publicRead 'display' ([guid]::Empty) -Replace).terminalMode -ceq 'display') 'mode change with -Replace'
Assert-Throws { New-KitchenClientConfig $paired $publicRead 'staff' ([guid]$id) } 'KITCHEN_MODE_CHANGE' 'paired to staff'
Assert-Throws { New-KitchenClientConfig $null $publicRead 'staff' ([guid]::Empty) } 'KITCHEN_TERMINAL_REQUIRED' 'staff without terminal'
Assert-Throws { New-KitchenClientConfig $null $publicRead 'prep' ([guid]$id) } 'KITCHEN_TERMINAL_UNUSED' 'paired with terminal'
Assert-Throws { New-KitchenClientConfig (ConvertFrom-Json -InputObject '{"proxy":"x"}') $publicRead 'prep' ([guid]::Empty) } 'KITCHEN_CONFIG_INVALID' 'unknown key'

# ---- POS client config (the Node test validates every file with pos-desktop) ----
$posExisting = ConvertFrom-Json -InputObject ('{"edgePort":3101,"branchLabel":"' + $label + '","categories":{"' + $otherId + '":"Combo"},"terminalId":"' + $id + '","pinLength":4,"printer":{"mode":"windows-driver","deviceName":"Old queue"}}')
$escpos = New-PosPrinter '' '10.20.0.50' 9100 $true
$posConfig = New-PosClientConfig $posExisting $publicRead ([guid]::Empty) $escpos
Assert-True ($posConfig.terminalId -ceq $id -and $posConfig.edgeHost -ceq $hostAddress -and $posConfig.edgePort -eq 3443 -and $posConfig.pinLength -eq 4 -and $posConfig.printer.mode -ceq 'escpos-tcp' -and $posConfig.printer.drawerKick -eq $true) 'desk config keeps its keys'
Save 'pos-escpos.json' $posConfig
$kept = New-PosClientConfig $posExisting $publicRead ([guid]::Empty) (New-PosPrinter '' '' 9100 $false)
Assert-True ($kept.printer.deviceName -ceq 'Old queue') 'no printer argument keeps the printer'
Save 'pos-kept.json' $kept
$freshPos = New-PosClientConfig $null $publicRead ([guid]$id) (New-PosPrinter ' Receipt 80 ' '' 9100 $false)
Assert-True ($freshPos.terminalId -ceq $id -and $freshPos.branchLabel -ceq $label -and $freshPos.printer.deviceName -ceq 'Receipt 80') 'fresh desk config'
Save 'pos-fresh.json' $freshPos
Assert-Throws { New-PosClientConfig $null $publicRead ([guid]::Empty) $null } 'POS_TERMINAL_REQUIRED' 'desk without terminal'
Assert-Throws { New-PosClientConfig $posExisting $publicRead ([guid]$otherId) $null } 'POS_TERMINAL_CHANGE' 'another terminal'
Assert-True ((New-PosClientConfig $posExisting $publicRead ([guid]$otherId) $null -Replace).terminalId -ceq $otherId) 'terminal change with -Replace'
Assert-Throws { New-PosClientConfig (ConvertFrom-Json -InputObject ('{"terminalId":"' + $id + '","pinLength":5}')) $publicRead ([guid]::Empty) $null } 'POS_CONFIG_INVALID' 'pinLength'
Assert-Throws { New-PosClientConfig (ConvertFrom-Json -InputObject ('{"terminalId":"' + $id + '","edgeUrl":"x"}')) $publicRead ([guid]::Empty) $null } 'POS_CONFIG_INVALID' 'unknown key'
Assert-Throws { New-PosPrinter 'Queue' '10.20.0.50' 9100 $false } 'POS_PRINTER_INVALID' 'two printers'
Assert-Throws { New-PosPrinter 'Queue' '' 9100 $true } 'POS_PRINTER_INVALID' 'drawer kick on the driver'
Assert-Throws { New-PosPrinter '' '' 9100 $true } 'POS_PRINTER_INVALID' 'drawer kick without a printer'
Assert-Throws { New-PosPrinter '' '8.8.8.8' 9100 $false } 'POS_PRINTER_INVALID' 'public printer address'

# ---- Files, versions, autostart guard ----
$file = Join-Path $out 'written.json'
Write-LanJsonFile $file '{"a":1}' 'S1'
Write-LanJsonFile $file '{"a":2}' 'S2'
$bytes = [IO.File]::ReadAllBytes($file)
Assert-True ($bytes[0] -eq 0x7B -and $utf8.GetString($bytes) -ceq '{"a":2}' -and [IO.File]::ReadAllText("$file.bak-S2") -ceq '{"a":1}') 'atomic write keeps the previous file, no BOM'
Assert-True (-not (Test-Path -LiteralPath "$file.new-S2")) 'no temporary file is left'
Assert-Throws { Get-LanAppVersion (Join-Path $out 'missing.exe') } 'LAN_APP_MISSING' 'app not installed'
Assert-Throws { Set-LanAutostart 'PickChickPOS' (Join-Path $out 'missing.exe') 'On' ([datetime]'2026-11-19') ([datetime]'2026-11-18T23:59:00') } 'LAN_AUTOSTART_TOO_EARLY' 'autostart before the cutover day'
"LAN client script checks passed: $script:count"
