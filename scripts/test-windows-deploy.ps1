$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot
$testRoot = Join-Path $workspace ('.navora-dev-data\deploy-test-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $testRoot 'payload'
New-Item -ItemType Directory -Force -Path (Join-Path $payload 'ffmpeg') | Out-Null
$files = @('navora.exe','README.txt','LICENSE','MEDIA-BUILDINFO.json','安装更新说明.md','windows-deploy.ps1','ffmpeg/ffmpeg.exe','ffmpeg/ffprobe.exe','ffmpeg/LICENSE.txt')
$hashes = @{}
foreach ($name in $files) {
  $path = Join-Path $payload $name
  [IO.File]::WriteAllText($path, 'isolated test fixture: '+$name)
  $hashes[$name] = (Get-FileHash -LiteralPath $path).Hash
}
$manifest = @{version='test';sha256=$hashes} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $payload 'manifest.json'), $manifest)
$deploy = Join-Path $PSScriptRoot 'windows-deploy.ps1'
& $deploy -Action Validate -Payload $payload -ExpectedVersion test
$install = Join-Path $testRoot 'uninstalled'
& $deploy -Action Install -Payload $payload -InstallRoot $install -WhatIf
& $deploy -Action AllowLanFirewall -InstallRoot $install -WhatIf
if (Test-Path -LiteralPath $install) { throw 'WhatIf modified the target' }
[IO.File]::AppendAllText((Join-Path $payload 'navora.exe'), 'tampered')
$rejected = $false
try { & $deploy -Action Validate -Payload $payload -ExpectedVersion test } catch {
  if ($_.Exception.Message -like '*navora.exe*') { $rejected = $true } else { throw }
}
if (!$rejected) { throw 'Tampered payload was accepted' }
Write-Output '部署脚本回归通过：载荷校验、篡改拒绝、预览不改动系统。'

# Exercise only the extracted rule function with command mocks; no real system
# firewall command is invoked and no administrator rights are needed.
& {
  $tokens = $null; $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($deploy, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors) { throw 'Firewall script syntax error' }
  $functionAst = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Set-NavoraLanFirewall' }, $true)
  if (!$functionAst) { throw 'Firewall helper missing' }
  $script:mockExistingRule = $false
  $script:mockRule = $null
  function Get-NetFirewallRule { [CmdletBinding()]param($Name) if ($script:mockExistingRule) { [pscustomobject]@{Name=$Name} } }
  function New-NetFirewallRule { param($Name,$DisplayName,$Direction,$Action,$Enabled,$Profile,$Protocol,$LocalPort,$Program,$RemoteAddress)
    $script:mockRule = @{Name=$Name;Program=$Program;Port=$LocalPort;Remote=$RemoteAddress;Profile=$Profile;Action=$Action;Enabled=$Enabled}
  }
  function Get-NetFirewallApplicationFilter { process { $_ } }
  function Get-NetFirewallPortFilter { process { $_ } }
  function Get-NetFirewallAddressFilter { process { $_ } }
  function Set-NetFirewallApplicationFilter { param($Program) process { $script:mockRule.Program=$Program } }
  function Set-NetFirewallPortFilter { param($Protocol,$LocalPort) process { $script:mockRule.Port=$LocalPort } }
  function Set-NetFirewallAddressFilter { param($RemoteAddress) process { $script:mockRule.Remote=$RemoteAddress } }
  function Set-NetFirewallRule { param($Name,$Direction,$Action,$Enabled,$Profile) $script:mockRule.Profile=$Profile; $script:mockRule.Action=$Action; $script:mockRule.Enabled=$Enabled }
  . ([scriptblock]::Create($functionAst.Extent.Text))
  Set-NavoraLanFirewall -Program 'C:\Program Files\Navora Monitor\navora.exe' -Port 8780
  if ($script:mockRule.Remote -ne 'LocalSubnet' -or $script:mockRule.Profile -ne 'Any' -or $script:mockRule.Port -ne 8780 -or $script:mockRule.Action -ne 'Allow') { throw 'New LAN firewall rule scope incorrect' }
  $script:mockExistingRule=$true
  Set-NavoraLanFirewall -Program 'C:\Program Files\Navora Monitor Updated\navora.exe' -Port 8790
  if ($script:mockRule.Port -ne 8790 -or $script:mockRule.Program -notlike '*Updated*' -or $script:mockRule.Enabled -ne 'True') { throw 'Existing LAN rule was not updated' }
  Write-Output '局域网规则回归通过：创建和更新匹配程序、端口、本地子网与所有网络配置文件；使用模拟命令，未修改系统防火墙。'
}
