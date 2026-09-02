<#
.SYNOPSIS
    Sends the ScriptHookVDotNet reload key to GTA V, so a rebuilt plugin can be
    loaded without alt-tabbing and pressing Insert by hand.

.DESCRIPTION
    SHVDN reloads every script in the scripts folder when its ReloadKeyBinding
    is pressed (Insert by default, set in ScriptHookVDotNet.ini). That key has
    to reach the game window, so this brings GTA V to the foreground first.

    It will steal focus. That is unavoidable — the game only sees the key if it
    is focused — but the script refuses to send anything unless GTA V really is
    the foreground window, so a stray Insert cannot land in whatever you were
    typing in.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\reload-plugin.ps1

.EXAMPLE
    # a different key, if you changed ReloadKeyBinding
    powershell -ExecutionPolicy Bypass -File tools\reload-plugin.ps1 -Key "{F9}"
#>
[CmdletBinding()]
param(
    # SendKeys form of SHVDN's ReloadKeyBinding.
    [string] $Key = '{INSERT}',

    # Process to target. Enhanced and Legacy use different executable names.
    [string[]] $ProcessNames = @('GTA5_Enhanced', 'GTA5')
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Fg {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@

$proc = $null
foreach ($name in $ProcessNames) {
    $proc = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) { break }
}

if (-not $proc) {
    Write-Error "GTA V does not appear to be running (looked for: $($ProcessNames -join ', '))."
    exit 1
}

if ($proc.MainWindowHandle -eq [IntPtr]::Zero) {
    Write-Error "Found $($proc.ProcessName) but it has no main window yet. Is the game still loading?"
    exit 1
}

Write-Host "Focusing $($proc.ProcessName) (pid $($proc.Id))..."
$shell = New-Object -ComObject WScript.Shell
$shell.AppActivate($proc.Id) | Out-Null
Start-Sleep -Milliseconds 500

# Only send once the game genuinely has focus. Without this the key would go to
# whatever window did — Insert is harmless in most places, but "most" is not a
# good enough reason to fire keystrokes blind.
$fg = [Fg]::GetForegroundWindow()
if ($fg -ne $proc.MainWindowHandle) {
    Write-Error "Could not bring GTA V to the foreground, so nothing was sent. Press $Key in game yourself."
    exit 1
}

[System.Windows.Forms.SendKeys]::SendWait($Key)
Write-Host "Sent $Key to GTA V. Scripts should reload." -ForegroundColor Green
