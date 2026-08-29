param([int]$Port = 8127, [string]$Root = (Join-Path $PSScriptRoot "public"))

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $Root on http://localhost:$Port/"

$mime = @{
  '.html' = 'text/html'; '.js' = 'application/javascript'; '.css' = 'text/css';
  '.json' = 'application/json'; '.png' = 'image/png'; '.svg' = 'image/svg+xml';
  '.ico' = 'image/x-icon';
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $path = $req.Url.LocalPath
    if ($path -eq '/') { $path = '/index.html' }
    $filePath = Join-Path $Root ($path.TrimStart('/'))
    if (Test-Path $filePath -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($filePath)
      $ct = $mime[$ext]
      if (-not $ct) { $ct = 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $res.ContentType = $ct
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $buf = [System.Text.Encoding]::UTF8.GetBytes("Not found")
      $res.OutputStream.Write($buf, 0, $buf.Length)
    }
  } catch {
  } finally {
    $res.OutputStream.Close()
  }
}
