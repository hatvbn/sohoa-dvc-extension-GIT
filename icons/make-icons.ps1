# Tao icon 16/32/48/128 tu logo goc "logo-src.png" (canh ben, PNG co nen trong).
# Chay: powershell -ExecutionPolicy Bypass -File make-icons.ps1
Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcPath = Join-Path $dir 'logo-src.png'
if (-not (Test-Path $srcPath)) { throw "Thieu anh goc: $srcPath" }

function New-Icon([int]$size, [string]$outFile, $src) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  # Ve toan khung (logo vuong), dung ImageAttributes de khong lem vien.
  $attr = New-Object System.Drawing.Imaging.ImageAttributes
  $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
  $dest = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $g.DrawImage($src, $dest, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
  $bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $attr.Dispose()
}

$src = [System.Drawing.Image]::FromFile($srcPath)
foreach ($sz in 16, 32, 48, 128) {
  New-Icon $sz (Join-Path $dir "icon$sz.png") $src
  Write-Host "Da tao icon$sz.png"
}
$src.Dispose()
