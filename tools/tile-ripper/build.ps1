<#
.SYNOPSIS
    Builds the tile ripper, fetching and building CodeWalker.Core first.

.DESCRIPTION
    The ripper reads GTA V's encrypted .rpf archives, which needs CodeWalker's
    file-format code. CodeWalker is NOT vendored in this repository: its
    Notice.txt asserts copyright without granting a licence, and it contains a
    GPL component. So we build it from source on your machine and reference the
    result locally, exactly as the plugin references ScriptHookVDotNet3.dll.

    Requires the .NET SDK (winget install Microsoft.DotNet.SDK.8).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\tile-ripper\build.ps1

.EXAMPLE
    # build and immediately rip
    powershell -ExecutionPolicy Bypass -File tools\tile-ripper\build.ps1 `
        -Game "D:\SteamLibrary\steamapps\common\Grand Theft Auto V Enhanced" `
        -Out "$env:USERPROFILE\Pictures\gtav-map"
#>
[CmdletBinding()]
param(
    # Where to clone/build CodeWalker. Reused if already present.
    [string] $CodeWalkerDir = (Join-Path $env:USERPROFILE 'Tools\CodeWalker-src'),

    # Run the ripper after building, against this GTA V install.
    [string] $Game,

    # Output folder for the ripper.
    [string] $Out = 'map-out',

    # Also write the individual tiles alongside the composite.
    [switch] $KeepTiles
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Require-Command($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name not found. $hint" }
}

Require-Command 'dotnet' 'Install it with: winget install Microsoft.DotNet.SDK.8'
Require-Command 'git'    'Install Git for Windows.'

# ---------------------------------------------------------------- CodeWalker
if (-not (Test-Path (Join-Path $CodeWalkerDir '.git'))) {
    Write-Host "Cloning CodeWalker into $CodeWalkerDir ..."
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $CodeWalkerDir) | Out-Null
    git clone --depth 1 https://github.com/dexyfex/CodeWalker.git $CodeWalkerDir
    if ($LASTEXITCODE -ne 0) { throw 'git clone failed.' }
} else {
    Write-Host "Using existing CodeWalker clone at $CodeWalkerDir"
}

# CodeWalker's legacy WinForms .resx files hold binary resources, which the
# .NET SDK's MSBuild only accepts through the pre-serialized path. This changes
# how resources are packed, not what the code does.
$props = Join-Path $CodeWalkerDir 'Directory.Build.props'
if (-not (Test-Path $props)) {
    Write-Host 'Adding Directory.Build.props (resource compatibility shim)...'
    @'
<Project>
  <PropertyGroup>
    <GenerateResourceUsePreserializedResources>true</GenerateResourceUsePreserializedResources>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="System.Resources.Extensions" Version="8.0.0" />
  </ItemGroup>
</Project>
'@ | Set-Content -Path $props -Encoding utf8
}

$coreProj = Join-Path $CodeWalkerDir 'CodeWalker.Core\CodeWalker.Core.csproj'
if (-not (Test-Path $coreProj)) { throw "CodeWalker.Core project not found at '$coreProj'." }

Write-Host 'Building CodeWalker.Core...'
dotnet build $coreProj -c Release -v quiet
if ($LASTEXITCODE -ne 0) { throw 'CodeWalker.Core build failed.' }

$corePath = Join-Path $CodeWalkerDir 'CodeWalker.Core\bin\Release\netstandard2.0\CodeWalker.Core.dll'
if (-not (Test-Path $corePath)) { throw "Built, but CodeWalker.Core.dll not found at '$corePath'." }
Write-Host "  $corePath" -ForegroundColor DarkGray

# ---------------------------------------------------------------- our tool
Write-Host 'Building TileRipper...'
$proj = Join-Path $here 'TileRipper.csproj'
dotnet build $proj -c Release -v quiet "-p:CodeWalkerCorePath=$corePath"
if ($LASTEXITCODE -ne 0) { throw 'TileRipper build failed.' }

$exe = Join-Path $here 'bin\Release\net48\TileRipper.exe'
Write-Host "Built $exe" -ForegroundColor Green

# ---------------------------------------------------------------- optional run
if ($Game) {
    Write-Host ''
    $ripArgs = @('--game', $Game, '--out', $Out)
    if ($KeepTiles) { $ripArgs += '--keep-tiles' }
    & $exe $ripArgs
    if ($LASTEXITCODE -ne 0) { throw "TileRipper exited with $LASTEXITCODE." }
} else {
    Write-Host ''
    Write-Host 'Run it with:'
    Write-Host "  $exe --game `"<GTA V folder>`" --out map-out"
}
