<#
.SYNOPSIS
    Builds LiveMap.dll using the in-box .NET Framework C# compiler.

.DESCRIPTION
    Deliberately avoids needing the .NET SDK, Visual Studio or MSBuild -- the
    csc.exe shipped with .NET Framework 4.8 is enough for a library this size.
    That does mean C# 5 syntax only (no string interpolation, no ?., no
    expression-bodied members).

    You need ScriptHookVDotNet3.dll to compile against. Pass -Shvdn3 with its
    path, or let the script find it in a default Steam install.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File plugin\build.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File plugin\build.ps1 `
        -Shvdn3 "D:\Games\GTAV\ScriptHookVDotNet3.dll" -Deploy
#>
[CmdletBinding()]
param(
    # Path to ScriptHookVDotNet3.dll.
    [string] $Shvdn3,

    # Game folder, used to find the reference DLL and as the deploy target.
    [string] $GameDir = 'D:\SteamLibrary\steamapps\common\Grand Theft Auto V Enhanced',

    # Copy the built DLL into <GameDir>\scripts\ afterwards.
    [switch] $Deploy
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }

$src = Join-Path $here 'src'
$out = Join-Path $here 'bin'

# --- locate the compiler -------------------------------------------------
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    throw "csc.exe not found at '$csc'. Is .NET Framework 4.x installed?"
}

# --- locate the reference assembly ---------------------------------------
if (-not $Shvdn3) {
    $candidate = Join-Path $GameDir 'ScriptHookVDotNet3.dll'
    if (Test-Path $candidate) {
        $Shvdn3 = $candidate
    }
}

if (-not $Shvdn3 -or -not (Test-Path $Shvdn3)) {
    throw @"
ScriptHookVDotNet3.dll not found.

Install ScriptHookVDotNetEnhanced into the game folder first, or pass the path:
    build.ps1 -Shvdn3 "C:\path\to\ScriptHookVDotNet3.dll"
"@
}

$Shvdn3 = (Resolve-Path $Shvdn3).ProviderPath
Write-Host "Reference: $Shvdn3"

# --- compile -------------------------------------------------------------
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

$dll = Join-Path $out 'LiveMap.dll'
$sources = Get-ChildItem $src -Filter '*.cs' -Recurse | ForEach-Object { $_.FullName }

if (-not $sources) { throw "No .cs files found under '$src'." }

$cscArgs = @(
    '/nologo'
    '/target:library'
    '/platform:x64'
    '/langversion:5'
    '/optimize+'
    '/warnaserror-'
    "/out:$dll"
    "/reference:$Shvdn3"
    '/reference:System.dll'
    '/reference:System.Core.dll'
    '/reference:System.Drawing.dll'
    '/reference:System.Windows.Forms.dll'
) + $sources

Write-Host "Compiling $($sources.Count) file(s)..."
& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "Compilation failed (exit $LASTEXITCODE)." }

Write-Host "Built $dll" -ForegroundColor Green

# --- optional deploy -----------------------------------------------------
if ($Deploy) {
    $scripts = Join-Path $GameDir 'scripts'
    if (-not (Test-Path $scripts)) { New-Item -ItemType Directory -Path $scripts | Out-Null }

    Copy-Item $dll $scripts -Force
    Write-Host "Deployed to $scripts" -ForegroundColor Green

    $ini = Join-Path $scripts 'LiveMap.ini'
    if (-not (Test-Path $ini)) {
        Copy-Item (Join-Path $here 'LiveMap.ini.example') $ini
        Write-Host "Wrote default $ini"
    }

    # The client is served from web_root, default <scripts>\LiveMapWeb.
    $webSrc = Join-Path (Split-Path -Parent $here) 'web'
    $webDst = Join-Path $scripts 'LiveMapWeb'
    if (Test-Path $webSrc) {
        if (-not (Test-Path $webDst)) { New-Item -ItemType Directory -Path $webDst | Out-Null }
        Copy-Item (Join-Path $webSrc '*') $webDst -Recurse -Force
        Write-Host "Copied web client to $webDst" -ForegroundColor Green
    }
}
