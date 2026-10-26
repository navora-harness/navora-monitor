param(
  [Parameter(Mandatory = $true)]
  [string]$CachePath,
  [Parameter(Mandatory = $true)]
  [string]$RecordingsPath
)
$ErrorActionPreference = 'Stop'
$cache = (Resolve-Path -LiteralPath $CachePath).Path
$archive = (Resolve-Path -LiteralPath $RecordingsPath).Path
$rows = @(foreach ($channel in Get-ChildItem -LiteralPath $cache -Directory) {
  foreach ($source in Get-ChildItem -LiteralPath $channel.FullName -File) {
    if ($source.Extension -notin @('.ts', '.mp4', '.mkv')) { continue }
    $target = Join-Path (Join-Path $archive $channel.Name) $source.Name
    $destination = Get-Item -LiteralPath $target -ErrorAction SilentlyContinue
    $category = 'archive_missing'
    if ($destination) {
      if ($destination.Length -eq 0 -and $source.Length -gt 0) { $category = 'archive_empty_conflict' }
      elseif ($destination.Length -eq $source.Length) { $category = 'same_size_unverified' }
      else { $category = 'different_size_conflict' }
    }
    [pscustomobject]@{
      Channel = $channel.Name; File = $source.Name; CacheBytes = $source.Length
      ArchiveBytes = $(if ($destination) { $destination.Length } else { $null })
      Category = $category; CacheModified = $source.LastWriteTime.ToString('s')
    }
  }
})
$output = Join-Path ([Environment]::GetFolderPath('Desktop')) ('navora-cache-diagnosis-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.csv')
$rows | Export-Csv -LiteralPath $output -NoTypeInformation -Encoding UTF8
$rows | Group-Object Category | Select-Object Name, Count | Format-Table -AutoSize
Write-Output "Cache bytes: $(($rows | Measure-Object CacheBytes -Sum).Sum)"
Write-Output "Report: $output"
Write-Output 'Read-only check completed. No recordings were moved or deleted. Same size does not prove identical content.'
