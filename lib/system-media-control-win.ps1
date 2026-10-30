param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Aumid = ""
)
$ErrorActionPreference = "Stop"
# NetEase desktop publishes no SMTC session; use its global media-key handling.
# Requires DSH and NetEase to run at the same integrity level (UIPI blocks lower -> higher input).
if ($Aumid -eq "cloudmusic.exe") {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NetEaseKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Tap(byte vk) {
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
  }
}
"@
  $vk = 0
  switch ($Action) {
    "playpause" { $vk = 0xB3 }
    "next" { $vk = 0xB0 }
    "previous" { $vk = 0xB1 }
  }
  if ($vk -eq 0) {
    '{"ok":false,"code":"ACTION"}'
    exit 0
  }
  [NetEaseKey]::Tap([byte]$vk)
  '{"ok":true,"code":"OK"}'
  exit 0
}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(5000)) { throw "timeout" }
  return $task.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session = $null
if ($Aumid -ne "") {
  try {
    foreach ($candidate in $manager.GetSessions()) {
      if ([string]$candidate.SourceAppUserModelId -eq $Aumid) {
        $session = $candidate
        break
      }
    }
  } catch { }
}
if ($null -eq $session) {
  $session = $manager.GetCurrentSession()
}
if ($null -eq $session) {
  '{"ok":false,"code":"NO_APP"}'
  exit 0
}
if ($Aumid -ne "" -and [string]$session.SourceAppUserModelId -ne $Aumid) {
  '{"ok":false,"code":"NO_APP"}'
  exit 0
}
switch ($Action) {
  'playpause' { $op = $session.TryTogglePlayPauseAsync() }
  'next' { $op = $session.TrySkipNextAsync() }
  'previous' { $op = $session.TrySkipPreviousAsync() }
  default {
    '{"ok":false,"code":"ACTION"}'
    exit 0
  }
}
$done = $false
try { $done = [bool](Await $op ([bool])) } catch { $done = $false }
if ($done) {
  '{"ok":true,"code":"OK"}'
} else {
  '{"ok":false,"code":"CONTROL_UNAVAILABLE"}'
}
