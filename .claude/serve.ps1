# Simple static file server (for environments without Python/Node)
# Usage: powershell -ExecutionPolicy Bypass -File .claude/serve.ps1 -Port 8080
param([int]$Port = 8080)

$root = Split-Path -Parent $PSScriptRoot
$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".gif"  = "image/gif"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
  ".webmanifest" = "application/manifest+json"
  ".md"   = "text/plain; charset=utf-8"
  ".txt"  = "text/plain; charset=utf-8"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "Serving $root at http://localhost:$Port/"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $reqPath = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
  if ($reqPath.EndsWith("/")) { $reqPath = $reqPath + "index.html" }
  $file = Join-Path $root ($reqPath -replace "/", "\")
  $fullRoot = (Resolve-Path $root).Path
  try {
    $fullFile = [System.IO.Path]::GetFullPath($file)
    if ($fullFile.StartsWith($fullRoot) -and (Test-Path $fullFile -PathType Leaf)) {
      $ext = [System.IO.Path]::GetExtension($fullFile).ToLower()
      $type = $mime[$ext]
      if (-not $type) { $type = "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($fullFile)
      $ctx.Response.ContentType = $type
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }
  } catch {
    try { $ctx.Response.StatusCode = 500 } catch {}
  }
  $ctx.Response.Close()
}
