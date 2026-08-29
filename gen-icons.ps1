Add-Type -AssemblyName System.Drawing

# Same "S" mark as the in-app topbar badge, gradient background, so the
# home-screen icon matches the app's own branding rather than introducing a
# separate glyph.
$text = "S"
$fontFamily = "Arial"

# Measure the true ink bounding box of the text (not the font's nominal line
# box, which reserves asymmetric ascent/descent space and makes vertical
# centering via StringFormat look visually off-center). Render at a
# reference size once, scan for non-background pixels, then scale the
# resulting bearings for each final icon size. Same technique used for
# price-watch's icon (see that repo's gen-icons.ps1).
$refSize = 80
$canvasW = 300
$canvasH = 300
$originX = 20
$originY = 20

$refFont = New-Object System.Drawing.Font($fontFamily, $refSize, [System.Drawing.FontStyle]::Bold)
$measureBmp = New-Object System.Drawing.Bitmap($canvasW, $canvasH)
$mg = [System.Drawing.Graphics]::FromImage($measureBmp)
$mg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$mg.Clear([System.Drawing.Color]::White)
$mg.DrawString($text, $refFont, [System.Drawing.Brushes]::Black, $originX, $originY)
$mg.Dispose()

$minX = $canvasW; $maxX = 0; $minY = $canvasH; $maxY = 0
for ($y = 0; $y -lt $canvasH; $y++) {
  for ($x = 0; $x -lt $canvasW; $x++) {
    $p = $measureBmp.GetPixel($x, $y)
    if ($p.R -lt 250) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
$measureBmp.Dispose()

$inkW = $maxX - $minX
$inkH = $maxY - $minY
$leftBearing = $minX - $originX
$topBearing = $minY - $originY

Write-Host "Ink box at ref size $refSize : W=$inkW H=$inkH leftBearing=$leftBearing topBearing=$topBearing"

function New-Icon($size, $path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $c1 = [System.Drawing.ColorTranslator]::FromHtml("#5b8cff")
  $c2 = [System.Drawing.ColorTranslator]::FromHtml("#8b5cf6")
  $fg = [System.Drawing.Color]::White

  $radius = [int]($size * 0.22)
  $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $bgPath.AddArc(0, 0, $d, $d, 180, 90)
  $bgPath.AddArc($size - $d, 0, $d, $d, 270, 90)
  $bgPath.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $bgPath.AddArc(0, $size - $d, $d, $d, 90, 90)
  $bgPath.CloseFigure()

  $gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    $c1, $c2
  )
  $g.FillPath($gradBrush, $bgPath)

  # Constrain the glyph by BOTH width and height against a conservative 42%
  # box and take whichever is smaller — sizing by one axis alone risks the
  # other axis blowing past the safe zone maskable icons need (found the
  # hard way on price-watch's £ glyph, which is tall/narrow).
  $targetInk = $size * 0.42
  $fontSizeByW = $refSize * ($targetInk / $inkW)
  $fontSizeByH = $refSize * ($targetInk / $inkH)
  $finalFontSize = [Math]::Min($fontSizeByW, $fontSizeByH)
  $scale = $finalFontSize / $refSize

  $font = New-Object System.Drawing.Font($fontFamily, $finalFontSize, [System.Drawing.FontStyle]::Bold)
  $fgBrush = New-Object System.Drawing.SolidBrush($fg)

  $scaledInkW = $inkW * $scale
  $scaledInkH = $inkH * $scale
  $drawX = (($size - $scaledInkW) / 2) - ($leftBearing * $scale)
  $drawY = (($size - $scaledInkH) / 2) - ($topBearing * $scale)

  $g.DrawString($text, $font, $fgBrush, $drawX, $drawY)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

New-Icon 192 "C:\Users\jakem\projects\stock-screener\icon-192.png"
New-Icon 512 "C:\Users\jakem\projects\stock-screener\icon-512.png"
New-Icon 180 "C:\Users\jakem\projects\stock-screener\apple-touch-icon.png"

Write-Host "Icons generated."
