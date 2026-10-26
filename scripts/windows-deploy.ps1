[CmdletBinding(SupportsShouldProcess)]
param(
  [ValidateSet('Install','Validate','Register','Start','Stop','Remove','AllowLanFirewall')][string]$Action = 'Install',
  [string]$Payload,
  [string]$InstallRoot = "$env:ProgramFiles\Navora Monitor",
  [string]$DataRoot = "$env:ProgramData\Navora Monitor",
  [switch]$RegisterService,
  [string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
$serviceName = 'NavoraMonitor'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$DataRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
$exe = Join-Path $InstallRoot 'navora.exe'
$files = @('navora.exe', 'README.txt', 'LICENSE', 'MEDIA-BUILDINFO.json', '安装更新说明.md', 'windows-deploy.ps1', 'ffmpeg\ffmpeg.exe', 'ffmpeg\ffprobe.exe', 'ffmpeg\LICENSE.txt')
if ($Action -eq 'Install' -or $Action -eq 'Validate') {
  if (!$Payload) { throw '必须指定 -Payload 安装载荷目录' }
  $Payload = [IO.Path]::GetFullPath($Payload)
  $manifest = Get-Content -LiteralPath (Join-Path $Payload 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($ExpectedVersion -and $manifest.version -ne $ExpectedVersion) { throw '安装载荷版本不匹配' }
  foreach ($name in $files) {
    $key = $name.Replace('\','/')
    $expected = $manifest.sha256.$key
    if (!$expected -or (Get-FileHash -LiteralPath (Join-Path $Payload $name) -Algorithm SHA256).Hash -ne $expected) {
      throw "安装载荷校验失败：$name"
    }
  }
  if ($Action -eq 'Validate') { Write-Output "载荷校验通过：$($manifest.version)"; return }
}
if (-not $PSCmdlet.ShouldProcess($InstallRoot, "$Action Navora Monitor")) { return }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请以管理员身份运行，或先使用 -WhatIf 查看操作。'
}
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$registered = $null
if ($service) {
  $registered = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
  # Keep the registered data location when upgrading a legacy installation.
  if ($registered.PathName -match '--data(?:=|\s+)(?:"([^"]+)"|(\S+))') {
    $existingData = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    if (![IO.Path]::IsPathRooted($existingData)) { throw '旧服务使用相对数据路径，无法安全判断旧配置位置。请先将服务 --data 改为已确认的绝对数据路径。' }
    $DataRoot = [IO.Path]::GetFullPath($existingData)
  }
}
function Stop-NavoraService {
  $current = Get-Service $serviceName -ErrorAction SilentlyContinue
  if ($current -and $current.Status -ne 'Stopped') {
    if ($current.Status -ne 'StopPending') { Stop-Service -Name $serviceName }
    $current.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(40))
  }
}
function Set-NavoraServicePath([string]$ImagePath, [bool]$Create = $false) {
  # Bypass Windows PowerShell 5 native argument rewriting: preserve ImagePath quotes.
  $mode = if ($Create) { 'create' } else { 'config' }
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $env:SystemRoot 'System32\sc.exe'
  $info.Arguments = $mode+' '+$serviceName+' binPath= "'+$ImagePath.Replace('"','\"')+'"'
  if ($Create) { $info.Arguments += ' start= delayed-auto obj= "NT AUTHORITY\LocalService" DisplayName= "Navora Monitor"' }
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($info)
  try {
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw '服务注册或路径更新失败' }
  } finally { $process.Dispose() }
}
function Set-NavoraService {
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw '找不到安装后的 navora.exe' }
  $programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  $allowed = [IO.Path]::GetFullPath($programFiles).TrimEnd('\')+'\'
  if (!$InstallRoot.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) {
    throw '系统服务的程序目录必须位于 Program Files 内，避免普通用户替换系统权限执行文件。'
  }
  $image = '"' + $exe + '" --data "' + $DataRoot + '"'
  if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
    Set-NavoraServicePath $image
  } else {
    Set-NavoraServicePath $image $true
  }
  & sc.exe description $serviceName 'Navora Monitor recording and playback service'
  if ($LASTEXITCODE -ne 0) { throw '设置服务说明失败' }
}
function Start-NavoraService {
  Start-Service $serviceName
  (Get-Service $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  $port = 8780
  $settings = Join-Path $DataRoot 'settings.json'
  if (Test-Path -LiteralPath $settings) {
    $config = Get-Content -LiteralPath $settings -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.remotePort) { $port = [int]$config.remotePort }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try {
      $status = Invoke-RestMethod "http://127.0.0.1:$port/api/status" -TimeoutSec 2
      if ($status.name -eq 'Navora Monitor' -and (!$ExpectedVersion -or $status.version -eq $ExpectedVersion)) {
        Write-Output "服务已就绪：http://127.0.0.1:$port/"
        return
      }
    } catch { }
    Start-Sleep -Milliseconds 300
  } while ([DateTime]::UtcNow -lt $deadline)
  throw '服务已启动但健康检查未通过，请检查端口、日志和配置。'
}
function Initialize-NavoraData {
  $windowsRoot = [IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\')
  if ($DataRoot -eq $windowsRoot -or $DataRoot.StartsWith($windowsRoot+'\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '配置数据目录不能位于 Windows 系统目录，请先迁移并明确指定独立数据目录。'
  }
  if ($registered -and !(Test-Path -LiteralPath (Join-Path $DataRoot 'settings.json') -PathType Leaf)) {
    throw "旧服务配置缺失：$DataRoot\settings.json。已停止初始化，请先恢复备份或明确建立新配置；不会自动覆盖。"
  }
  $newData = !(Test-Path -LiteralPath $DataRoot)
  New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
  if ($newData) {
    & icacls.exe $DataRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '设置配置目录权限失败' }
  }
  $settingsPath = Join-Path $DataRoot 'settings.json'
  if (!(Test-Path -LiteralPath $settingsPath)) {
    $initial = @{
      recordingsPath = Join-Path $DataRoot 'recordings'
      savedClipsPath = Join-Path $DataRoot 'saved'
      snapshotsPath = Join-Path $DataRoot 'snapshots'
      recordCachePath = Join-Path $DataRoot 'cache'
      remoteEnabled = $false
    } | ConvertTo-Json
    [IO.File]::WriteAllText($settingsPath, $initial, (New-Object Text.UTF8Encoding($false)))
  }
  & $exe --data $DataRoot --init-only
  if ($LASTEXITCODE -ne 0) { throw '初始化账户失败' }
}
function Set-NavoraLanFirewall([string]$Program, [int]$Port) {
  if ($Port -lt 1024 -or $Port -gt 65535) { throw '局域网端口无效' }
  $ruleName = 'NavoraMonitor-LAN'
  $existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
  if ($existing) {
    $existing | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $Program | Out-Null
    $existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port | Out-Null
    $existing | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet | Out-Null
    Set-NetFirewallRule -Name $ruleName -Direction Inbound -Action Allow -Enabled True -Profile Any | Out-Null
  } else {
    New-NetFirewallRule -Name $ruleName -DisplayName 'Navora Monitor LAN' -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -LocalPort $Port -Program $Program -RemoteAddress LocalSubnet | Out-Null
  }
  Write-Output "已配置局域网访问：TCP $Port，仅限本地子网和 $Program"
}
switch ($Action) {
  'AllowLanFirewall' {
    $firewallExe = $exe
    if ($registered -and $registered.PathName -match '^(?:"([^"]+)"|(\S+))') {
      $firewallExe = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    }
    if (!(Test-Path -LiteralPath $firewallExe -PathType Leaf)) { throw '找不到服务使用的 navora.exe' }
    $config = Get-Content -LiteralPath (Join-Path $DataRoot 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$config.remoteEnabled) { throw '请先在设置中允许局域网设备访问并保存。' }
    $lanPort = if ($config.remotePort) { [int]$config.remotePort } else { 8780 }
    if ($registered -and $registered.PathName -match '--port(?:=|\s+)(\d+)') { $lanPort = [int]$Matches[1] }
    if ($lanPort -lt 1024 -or $lanPort -gt 65535) { throw '配置端口无效' }
    Set-NavoraLanFirewall -Program $firewallExe -Port $lanPort
    return
  }
  'Stop' { Stop-NavoraService; return }
  'Start' { Start-NavoraService; return }
  'Remove' {
    if ($registered -and $registered.PathName -match '^(?:"([^"]+)"|(\S+))') {
      $registeredExe = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
      if ([IO.Path]::GetFullPath($registeredExe) -ne $exe) {
        throw '现有服务指向其他安装目录，请从当前安装目录管理或卸载。'
      }
    }
    Stop-NavoraService
    $busy = Get-CimInstance Win32_Process -Filter "Name='navora.exe'" | Where-Object {
      $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $exe
    }
    if ($busy) { throw '请先退出此安装目录中的前台程序，再卸载。' }
    if ($service) {
      & sc.exe delete $serviceName
      if ($LASTEXITCODE -ne 0) { throw '移除服务失败' }
    }
    Write-Output '服务已移除；配置和录像保留。'
    return
  }
  'Register' {
    Initialize-NavoraData
    $networkConfig = Get-Content -LiteralPath (Join-Path $DataRoot 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $networkPort = if ($networkConfig.remotePort) { [int]$networkConfig.remotePort } else { 8780 }
    Set-NavoraLanFirewall -Program $exe -Port $networkPort
    Set-NavoraService
    Write-Output '服务已注册；使用 -Action Start 启动。'
    return
  }
}
if (!$Payload -or !(Test-Path -LiteralPath (Join-Path $Payload 'navora.exe'))) { throw '缺少有效安装载荷' }
$Payload = [IO.Path]::GetFullPath($Payload)
if ($Payload -eq $InstallRoot -or $Payload.StartsWith($InstallRoot+'\', [StringComparison]::OrdinalIgnoreCase)) {
  throw '安装载荷必须放在程序目录之外，避免更新时移动自身输入文件。'
}
foreach ($name in $files) {
  if (!(Test-Path -LiteralPath (Join-Path $Payload $name) -PathType Leaf)) { throw "安装载荷不完整：$name" }
}
if ($DataRoot -eq $InstallRoot -or $DataRoot.StartsWith($InstallRoot+'\', [StringComparison]::OrdinalIgnoreCase)) {
  throw '正式安装的数据目录必须在程序目录之外；旧绿色版请先迁移数据目录再注册服务。'
}
$windowsRoot = [IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\')
if ($DataRoot -eq $windowsRoot -or $DataRoot.StartsWith($windowsRoot+'\', [StringComparison]::OrdinalIgnoreCase)) {
  throw '配置数据目录不能位于 Windows 系统目录，请先迁移并明确指定独立数据目录。'
}
if ($registered -and !(Test-Path -LiteralPath (Join-Path $DataRoot 'settings.json') -PathType Leaf)) {
  throw "旧服务配置缺失：$DataRoot\settings.json。未停止服务、未替换程序，请先恢复配置备份。"
}
if (Test-Path -LiteralPath (Join-Path $DataRoot 'settings.json') -PathType Leaf) {
  $null = Get-Content -LiteralPath (Join-Path $DataRoot 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
}
$wasRunning = $service -and $service.Status -ne 'Stopped'
$backup = Join-Path $InstallRoot ('.rollback-' + [Guid]::NewGuid().ToString('N'))
$changed = New-Object 'System.Collections.Generic.List[string]'
$hadFile = @{}
$createdService = $false
try {
  Stop-NavoraService
  $busy = Get-CimInstance Win32_Process -Filter "Name='navora.exe'" | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $exe
  }
  if ($busy) { throw '请先正常退出正在运行的前台程序，再重新安装。' }
  if (Test-Path -LiteralPath (Join-Path $DataRoot 'settings.json') -PathType Leaf) {
    $configBackup = Join-Path $DataRoot ('config-backups\' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $configBackup -Force | Out-Null
    foreach ($configName in @('settings.json','channels.json','auth.json','recording-session.json','layout.json')) {
      $configSource = Join-Path $DataRoot $configName
      if (Test-Path -LiteralPath $configSource -PathType Leaf) {
        Copy-Item -LiteralPath $configSource -Destination (Join-Path $configBackup $configName)
      }
    }
    Write-Output "配置备份：$configBackup"
  }
  New-Item -ItemType Directory -Force -Path $InstallRoot, $backup | Out-Null
  foreach ($name in $files) {
    $target = Join-Path $InstallRoot $name
    $old = Join-Path $backup $name
    New-Item -ItemType Directory -Force -Path (Split-Path $target), (Split-Path $old) | Out-Null
    $hadFile[$name] = Test-Path -LiteralPath $target
    if ($hadFile[$name]) { Move-Item -LiteralPath $target -Destination $old }
    $changed.Add($name)
    Copy-Item -LiteralPath (Join-Path $Payload $name) -Destination $target
  }
  # Never initialize a service invisibly: return the one-time password to the installer.
  Initialize-NavoraData
  $networkConfig = Get-Content -LiteralPath (Join-Path $DataRoot 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $networkPort = if ($networkConfig.remotePort) { [int]$networkConfig.remotePort } else { 8780 }
  # The listener remains loopback-only until enabled in settings. Register the
  # scoped rule now so that enabling access later does not need elevation.
  Set-NavoraLanFirewall -Program $exe -Port $networkPort
  if ($service -or $RegisterService) {
    $createdService = !$service
    Set-NavoraService
    if ($wasRunning -or $RegisterService) { Start-NavoraService }
  }
  Write-Output "安装完成。数据目录：$DataRoot"
  $port = 8780
  $savedSettings = Get-Content -LiteralPath (Join-Path $DataRoot 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($savedSettings.remotePort) { $port = [int]$savedSettings.remotePort }
  [IO.File]::WriteAllText((Join-Path $InstallRoot 'Navora Monitor.url'), "[InternetShortcut]`r`nURL=http://127.0.0.1:$port/`r`n", (New-Object Text.UTF8Encoding($false)))
  Write-Output "旧程序备份：$backup"
} catch {
  $failure = $_
  try {
    Stop-NavoraService
    foreach ($name in $changed) {
      $target = Join-Path $InstallRoot $name
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
      if ($hadFile[$name]) { Move-Item -LiteralPath (Join-Path $backup $name) -Destination $target }
    }
    if ($createdService) { & sc.exe delete $serviceName | Out-Null }
    elseif ($registered) {
      Set-NavoraServicePath $registered.PathName
      if ($wasRunning) { $ExpectedVersion = ''; Start-NavoraService }
    }
  } catch { Write-Warning "自动恢复未完成，请保留备份并手工恢复：$_" }
  throw $failure
}
