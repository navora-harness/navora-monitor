# Generate NSIS installer bitmaps + .ico from electron/assets/icon.png
# Sizes required by electron-builder / NSIS MUI2:
#   installerHeader.bmp  — 150 x 57
#   installerSidebar.bmp — 164 x 314

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $root 'electron\assets\icon.png'
$outDir = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (-not (Test-Path $srcPath)) {
  throw "Missing icon: $srcPath"
}

$teal = [System.Drawing.Color]::FromArgb(255, 10, 107, 99)       # #0a6b63
$tealDeep = [System.Drawing.Color]::FromArgb(255, 6, 72, 68)     # #064844
$tealSoft = [System.Drawing.Color]::FromArgb(255, 14, 130, 120)  # #0e8278
$ink = [System.Drawing.Color]::FromArgb(255, 232, 246, 244)      # soft white

# Prefer a CJK-capable UI font — Segoe UI cannot draw Chinese (shows as garbled boxes).
function Get-UiFont([float]$size, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular, [bool]$cjk = $false) {
  $candidates = if ($cjk) {
    @('Microsoft YaHei UI', 'Microsoft YaHei', 'Microsoft JhengHei UI', 'SimHei', 'SimSun', 'Segoe UI')
  } else {
    @('Segoe UI Semibold', 'Segoe UI', 'Microsoft YaHei UI', 'Arial')
  }
  if (-not $cjk -and ($style -band [System.Drawing.FontStyle]::Bold)) {
    $candidates = @('Segoe UI Semibold', 'Segoe UI', 'Microsoft YaHei UI', 'Arial')
  }
  foreach ($name in $candidates) {
    try {
      return New-Object System.Drawing.Font $name, $size, $style
    } catch {
      continue
    }
  }
  return New-Object System.Drawing.Font ([System.Drawing.FontFamily]::GenericSansSerif), $size, $style
}

# 局域网监控 / 录像 / 回放  (ASCII separators — avoid · glyph surprises)
$sidebarTagline = -join @(
  [char]0x5C40, [char]0x57DF, [char]0x7F51, [char]0x76D1, [char]0x63A7,
  ' / ',
  [char]0x5F55, [char]0x50CF,
  ' / ',
  [char]0x56DE, [char]0x653E
)
# 安装向导
$headerSubtitle = -join @([char]0x5B89, [char]0x88C5, [char]0x5411, [char]0x5BFC)

function New-SolidBitmap([int]$w, [int]$h, [System.Drawing.Color]$c) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear($c)
  $g.Dispose()
  return $bmp
}

function Save-Bmp24([System.Drawing.Bitmap]$bmp, [string]$path) {
  # Force 24-bpp BMP (NSIS MUI is picky)
  $clone = New-Object System.Drawing.Bitmap $bmp.Width, $bmp.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($clone)
  $g.DrawImage($bmp, 0, 0, $bmp.Width, $bmp.Height)
  $g.Dispose()
  $clone.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $clone.Dispose()
}

$icon = [System.Drawing.Image]::FromFile($srcPath)

# --- Sidebar 164x314 ---
$side = New-Object System.Drawing.Bitmap 164, 314, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$sg = [System.Drawing.Graphics]::FromImage($side)
$sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Vertical teal gradient
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
  (New-Object System.Drawing.Point 0, 0),
  (New-Object System.Drawing.Point 0, 314),
  $tealDeep,
  $tealSoft
)
$sg.FillRectangle($brush, 0, 0, 164, 314)
$brush.Dispose()

# Soft accent arc / vignette bar at bottom
$fade = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
  (New-Object System.Drawing.Point 0, 220),
  (New-Object System.Drawing.Point 0, 314),
  ([System.Drawing.Color]::FromArgb(0, 10, 107, 99)),
  ([System.Drawing.Color]::FromArgb(90, 0, 0, 0))
)
$sg.FillRectangle($fade, 0, 220, 164, 94)
$fade.Dispose()

# Center brand glyph
$glyphSize = 88
$gx = [int]((164 - $glyphSize) / 2)
$gy = 72
$sg.DrawImage($icon, $gx, $gy, $glyphSize, $glyphSize)

# Product wordmark under glyph
$fontTitle = Get-UiFont 11 ([System.Drawing.FontStyle]::Bold) $false
$fontSub = Get-UiFont 7.5 ([System.Drawing.FontStyle]::Regular) $true
$titleBrush = New-Object System.Drawing.SolidBrush $ink
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sg.DrawString('Navora', $fontTitle, $titleBrush, (New-Object System.Drawing.RectangleF 8, 176, 148, 22), $sf)
$sg.DrawString('Monitor', $fontTitle, $titleBrush, (New-Object System.Drawing.RectangleF 8, 196, 148, 22), $sf)
$dimBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 200, 230, 226))
$sg.DrawString($sidebarTagline, $fontSub, $dimBrush, (New-Object System.Drawing.RectangleF 6, 268, 152, 32), $sf)
$fontTitle.Dispose()
$fontSub.Dispose()

$sg.Dispose()
Save-Bmp24 $side (Join-Path $outDir 'installerSidebar.bmp')
$side.Dispose()

# --- Header 150x57 ---
$header = New-Object System.Drawing.Bitmap 150, 57, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$hg = [System.Drawing.Graphics]::FromImage($header)
$hg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$hg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$hg.Clear([System.Drawing.Color]::White)

$bar = New-Object System.Drawing.SolidBrush $teal
$hg.FillRectangle($bar, 0, 0, 4, 57)
$bar.Dispose()

$hg.DrawImage($icon, 14, 10, 36, 36)
$hTitle = Get-UiFont 10 ([System.Drawing.FontStyle]::Bold) $false
$hSub = Get-UiFont 7.5 ([System.Drawing.FontStyle]::Regular) $true
$darkBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 28, 40, 48))
$mutedBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 90, 110, 118))
$hg.DrawString('Navora Monitor', $hTitle, $darkBrush, 58, 12)
$hg.DrawString($headerSubtitle, $hSub, $mutedBrush, 58, 32)
$hTitle.Dispose()
$hSub.Dispose()

$hg.Dispose()
Save-Bmp24 $header (Join-Path $outDir 'installerHeader.bmp')
$header.Dispose()

# --- Multi-size ICO for installer / uninstaller ---
function Save-Icon([System.Drawing.Image]$src, [string]$path, [int[]]$sizes) {
  $ms = New-Object System.IO.MemoryStream
  # Build ICO manually: header + entries + PNG payloads (Vista+ style)
  $pngChunks = @()
  foreach ($sz in $sizes) {
    $frame = New-Object System.Drawing.Bitmap $sz, $sz, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $fg = [System.Drawing.Graphics]::FromImage($frame)
    $fg.Clear([System.Drawing.Color]::Transparent)
    $fg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $fg.DrawImage($src, 0, 0, $sz, $sz)
    $fg.Dispose()
    $pngMs = New-Object System.IO.MemoryStream
    $frame.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
    $frame.Dispose()
    $pngChunks += , @($sz, $pngMs.ToArray())
    $pngMs.Dispose()
  }

  $bw = New-Object System.IO.BinaryWriter $ms
  $count = $pngChunks.Count
  $bw.Write([uint16]0)      # reserved
  $bw.Write([uint16]1)      # type icon
  $bw.Write([uint16]$count)

  $offset = 6 + (16 * $count)
  foreach ($chunk in $pngChunks) {
    $sz = [int]$chunk[0]
    $bytes = [byte[]]$chunk[1]
    $bw.Write([byte]$(if ($sz -ge 256) { 0 } else { $sz }))
    $bw.Write([byte]$(if ($sz -ge 256) { 0 } else { $sz }))
    $bw.Write([byte]0)  # colors
    $bw.Write([byte]0)  # reserved
    $bw.Write([uint16]1) # planes
    $bw.Write([uint16]32) # bitcount
    $bw.Write([uint32]$bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $bytes.Length
  }
  foreach ($chunk in $pngChunks) {
    $bw.Write([byte[]]$chunk[1])
  }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($path, $ms.ToArray())
  $bw.Dispose()
  $ms.Dispose()
}

Save-Icon $icon (Join-Path $outDir 'icon.ico') @(16, 32, 48, 256)
Copy-Item -Force $srcPath (Join-Path $outDir 'icon.png')

$icon.Dispose()
Write-Host "[installer-assets] wrote build/installerSidebar.bmp, installerHeader.bmp, icon.ico"
