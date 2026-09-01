<#
.SYNOPSIS
    Serves the web/ folder over http://localhost:<port>/ for local testing.

.DESCRIPTION
    Once the plugin is running it serves web/ itself, so this script is only for
    working on the client with the game shut (mock feed mode). It binds to
    localhost only, which needs no administrator rights and no urlacl.

    Serving over http:// rather than opening index.html as a file matters:
    browsers refuse IndexedDB on file:// origins, so the map image would not be
    remembered across reloads.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\serve.ps1
    powershell -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 9000
#>
[CmdletBinding()]
param(
    [int]    $Port = 8099,
    [string] $Root
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
    # $PSScriptRoot is not always populated depending on how we were launched.
    $here = $PSScriptRoot
    if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $Root = Join-Path $here '..\web'
}

$Root = (Resolve-Path $Root).ProviderPath
if (-not (Test-Path (Join-Path $Root 'index.html'))) {
    throw "No index.html under '$Root'."
}

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.webp' = 'image/webp'
    '.gif'  = 'image/gif'
    '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

Write-Host "Serving $Root"
Write-Host "  http://localhost:$Port/"
Write-Host "Ctrl+C to stop."

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $res = $ctx.Response
        try {
            $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
            if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }

            $full = Join-Path $Root $rel
            $resolved = $null
            if (Test-Path $full) { $resolved = (Resolve-Path $full).ProviderPath }

            # Refuse anything that escapes the web root. Compare against the
            # root plus a separator, or a sibling like 'web2\' would pass the
            # prefix test.
            $rootPrefix = $Root.TrimEnd('\') + '\'
            if ($resolved -and -not $resolved.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                $resolved = $null
            }

            if ($resolved -and (Test-Path $resolved -PathType Leaf)) {
                $ext = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
                $type = $mime[$ext]
                if (-not $type) { $type = 'application/octet-stream' }

                $bytes = [System.IO.File]::ReadAllBytes($resolved)
                $res.StatusCode    = 200
                $res.ContentType   = $type
                $res.ContentLength64 = $bytes.Length
                $res.Headers.Add('Cache-Control', 'no-store')
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
            else {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 $rel")
                $res.StatusCode  = 404
                $res.ContentType = 'text/plain; charset=utf-8'
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }

            Write-Host ("{0} {1} {2}" -f $res.StatusCode, $ctx.Request.HttpMethod, $rel)
        }
        catch {
            Write-Warning $_.Exception.Message
            try { $res.StatusCode = 500 } catch { }
        }
        finally {
            try { $res.OutputStream.Close() } catch { }
        }
    }
}
finally {
    $listener.Stop()
    $listener.Close()
}
