param()
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture
[System.Threading.Thread]::CurrentThread.CurrentUICulture = [System.Globalization.CultureInfo]::InvariantCulture

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

$netEaseReady = $false
try {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
[Flags] public enum DeviceState { ACTIVE = 1, DISABLED = 2, NOTPRESENT = 4, UNPLUGGED = 8, ALL = 15 }
public enum AudioSessionState { Inactive = 0, Active = 1, Expired = 2 }

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(EDataFlow dataFlow, DeviceState stateMask, out IMMDeviceCollection devices);
  int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
  int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  int RegisterEndpointNotificationCallback(IntPtr client);
  int UnregisterEndpointNotificationCallback(IntPtr client);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
  int GetCount(out int count);
  int Item(int index, out IMMDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
  int OpenPropertyStore(int access, out IntPtr properties);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out DeviceState state);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
  int GetAudioSessionControl(ref Guid audioSessionGuid, int streamFlags, out IAudioSessionControl sessionControl);
  int GetSimpleAudioVolume(ref Guid audioSessionGuid, int streamFlags, out IntPtr audioVolume);
  int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
  int RegisterSessionNotification(IntPtr sessionNotification);
  int UnregisterSessionNotification(IntPtr sessionNotification);
  int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
  int UnregisterDuckNotification(IntPtr duckNotification);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
  int GetCount(out int sessionCount);
  int GetSession(int sessionCount, out IAudioSessionControl session);
}
[ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl {
  int GetState(out AudioSessionState state);
  int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
  int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
  int GetGroupingParam(out Guid groupingParam);
  int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
  int RegisterAudioSessionNotification(IntPtr client);
  int UnregisterAudioSessionNotification(IntPtr client);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
  int GetState(out AudioSessionState state);
  int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
  int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
  int GetGroupingParam(out Guid groupingParam);
  int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
  int RegisterAudioSessionNotification(IntPtr client);
  int UnregisterAudioSessionNotification(IntPtr client);
  int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetProcessId(out uint processId);
  int IsSystemSoundsSession();
  int SetDuckingPreference(bool optOut);
}
[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMeterInformation {
  int GetPeakValue(out float peak);
  int GetMeteringChannelCount(out int count);
  int GetChannelsPeakValues(int count, [Out] float[] peaks);
  int QueryHardwareSupport(out int mask);
}

public static class NetEaseProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);

  public static string FindWindow() {
    string found = null;
    EnumWindows((h, l) => {
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      if (cls.ToString() != "OrpheusBrowserHost") return true;
      var txt = new StringBuilder(1024);
      GetWindowText(h, txt, 1024);
      string title = txt.ToString();
      if (title.IndexOf(" - ", StringComparison.Ordinal) < 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      found = pid.ToString() + "|" + title;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static string Audio(uint target) {
    int bestState = 0;
    float bestPeak = 0f;
    try {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice device;
      if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device) != 0) return "0|0";
      Guid iid = typeof(IAudioSessionManager2).GUID;
      object obj;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out obj) != 0) return "0|0";
      var manager = (IAudioSessionManager2)obj;
      IAudioSessionEnumerator sessions;
      if (manager.GetSessionEnumerator(out sessions) != 0) return "0|0";
      int count;
      sessions.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IAudioSessionControl control;
        if (sessions.GetSession(i, out control) != 0 || control == null) continue;
        var control2 = control as IAudioSessionControl2;
        uint pid = 0;
        if (control2 != null) control2.GetProcessId(out pid);
        if (pid != target) continue;
        AudioSessionState state;
        control.GetState(out state);
        float peak = 0f;
        var meter = control as IAudioMeterInformation;
        if (meter != null) meter.GetPeakValue(out peak);
        if (peak > bestPeak) bestPeak = peak;
        if ((int)state > bestState) bestState = (int)state;
      }
    } catch { return "0|0"; }
    return bestState.ToString() + "|" + bestPeak.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture);
  }
}

public enum AUDCLNT_SHAREMODE { SHARED = 0, EXCLUSIVE = 1 }
[Flags] public enum AUDCLNT_STREAMFLAGS : uint { LOOPBACK = 0x00020000 }

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public struct WAVEFORMATEX {
  public ushort wFormatTag;
  public ushort nChannels;
  public uint nSamplesPerSec;
  public uint nAvgBytesPerSec;
  public ushort nBlockAlign;
  public ushort wBitsPerSample;
  public ushort cbSize;
}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
  int Initialize(AUDCLNT_SHAREMODE shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
  int GetBufferSize(out uint frames);
  int GetStreamLatency(out long latency);
  int GetCurrentPadding(out uint padding);
  int IsFormatSupported(AUDCLNT_SHAREMODE shareMode, IntPtr format, out IntPtr closest);
  int GetMixFormat(out IntPtr format);
  int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
  int Start();
  int Stop();
  int Reset();
  int SetEventHandle(IntPtr handle);
  int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient {
  int GetBuffer(out IntPtr data, out uint frames, out uint flags, out long devicePosition, out long qpcPosition);
  int ReleaseBuffer(uint frames);
  int GetNextPacketSize(out uint frames);
}

public static class LoopbackSpectrum {
  static IAudioClient client;
  static IAudioCaptureClient capture;
  static int channels = 2;
  static int sampleRate = 48000;
  static bool ready;
  const int FftSize = 1024;
  static readonly float[] samples = new float[FftSize];
  static int sampleCount;
  static readonly double[] smooth = new double[24];
  static readonly float[] re = new float[FftSize];
  static readonly float[] im = new float[FftSize];

  public static bool Ensure() {
    if (ready) return true;
    try {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice device;
      if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device) != 0) return false;
      Guid iid = typeof(IAudioClient).GUID;
      object obj;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out obj) != 0) return false;
      client = (IAudioClient)obj;
      IntPtr fmt;
      if (client.GetMixFormat(out fmt) != 0) return false;
      var wf = (WAVEFORMATEX)Marshal.PtrToStructure(fmt, typeof(WAVEFORMATEX));
      channels = Math.Max(1, (int)wf.nChannels);
      sampleRate = (int)wf.nSamplesPerSec;
      if (wf.wBitsPerSample != 32) return false;
      if (client.Initialize(AUDCLNT_SHAREMODE.SHARED, 0x00020000u, 10000000, 0, fmt, IntPtr.Zero) != 0) return false;
      Guid capIid = typeof(IAudioCaptureClient).GUID;
      object capObj;
      if (client.GetService(ref capIid, out capObj) != 0) return false;
      capture = (IAudioCaptureClient)capObj;
      if (client.Start() != 0) return false;
      ready = true;
      return true;
    } catch { ready = false; return false; }
  }

  public static string Read() {
    if (!Ensure()) return "";
    try {
      uint packet;
      while (capture.GetNextPacketSize(out packet) == 0 && packet > 0) {
        IntPtr data;
        uint frames, flags;
        long devPos, qpcPos;
        if (capture.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos) != 0) break;
        int total = (int)frames * channels;
        if (total > 0) {
          var buffer = new float[total];
          Marshal.Copy(data, buffer, 0, total);
          for (int f = 0; f < frames && sampleCount < FftSize; f++) {
            float sum = 0f;
            for (int c = 0; c < channels; c++) sum += buffer[f * channels + c];
            samples[sampleCount++] = sum / channels;
          }
        }
        capture.ReleaseBuffer(frames);
      }
      if (sampleCount < FftSize) return "";
      for (int i = 0; i < FftSize; i++) {
        double window = 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (FftSize - 1));
        re[i] = (float)(samples[i] * window);
        im[i] = 0f;
      }
      FFT(re, im);
      sampleCount = 0;
      var parts = new string[24];
      double max = 1e-9;
      for (int b = 0; b < 24; b++) {
        double low = 40.0 * Math.Pow(400.0, b / 24.0);
        double high = 40.0 * Math.Pow(400.0, (b + 1) / 24.0);
        int from = Math.Max(1, (int)(low * FftSize / sampleRate));
        int to = Math.Max(from + 1, (int)(high * FftSize / sampleRate));
        to = Math.Min(to, FftSize / 2);
        if (to <= from) { smooth[b] *= 0.82; continue; }
        double sum = 0;
        for (int i = from; i < to; i++) sum += Math.Sqrt(re[i] * re[i] + im[i] * im[i]);
        double value = sum / (to - from);
        smooth[b] = Math.Max(value, smooth[b] * 0.82);
        if (smooth[b] > max) max = smooth[b];
      }
      for (int b = 0; b < 24; b++) {
        double v = Math.Pow(smooth[b] / max, 0.7);
        if (v < 0.04) v = 0.04;
        parts[b] = v.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture);
      }
      return string.Join(",", parts);
    } catch { return ""; }
  }

  static void FFT(float[] re, float[] im) {
    int n = re.Length;
    for (int i = 1, j = 0; i < n; i++) {
      int bit = n >> 1;
      for (; (j & bit) != 0; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { float t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (int len = 2; len <= n; len <<= 1) {
      double ang = -2 * Math.PI / len;
      float wRe = (float)Math.Cos(ang), wIm = (float)Math.Sin(ang);
      for (int i = 0; i < n; i += len) {
        float curRe = 1f, curIm = 0f;
        for (int j = 0; j < len / 2; j++) {
          int a = i + j, b = i + j + len / 2;
          float uRe = re[a], uIm = im[a];
          float vRe = re[b] * curRe - im[b] * curIm;
          float vIm = re[b] * curIm + im[b] * curRe;
          re[a] = uRe + vRe; im[a] = uIm + vIm;
          re[b] = uRe - vRe; im[b] = uIm - vIm;
          float nextRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nextRe;
        }
      }
    }
  }
}
"@
  $netEaseReady = $true
} catch {
  $netEaseReady = $false
}

$manager = $null
$failures = 0
$lastRows = @()
$lastNetease = $null
$tick = 0
while ($true) {
  $line = '{"ok":false}'
  try {
    if ($null -eq $manager) {
      $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }
    if (($tick % 20) -eq 0 -or $lastRows.Count -eq 0) {
      $rows = @()
      try {
        $sessions = $manager.GetSessions()
      foreach ($s in $sessions) {
        try {
          $status = [string]$s.GetPlaybackInfo().PlaybackStatus
          $title = ""
          $artist = ""
          $album = ""
          try {
            $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            if ($null -ne $props) {
              $title = [string]$props.Title
              $artist = [string]$props.Artist
              $album = [string]$props.AlbumTitle
            }
          } catch { }
          if ([string]::IsNullOrWhiteSpace($title)) { continue }
          $duration = 0.0
          $position = 0.0
          try {
            $timeline = $s.GetTimelineProperties()
            $duration = [math]::Round(($timeline.EndTime - $timeline.StartTime).TotalSeconds, 2)
            $position = [math]::Round($timeline.Position.TotalSeconds, 2)
          } catch { }
          $rows += [ordered]@{
            source = "smtc"
            aumid = [string]$s.SourceAppUserModelId
            status = $status
            title = $title
            artist = $artist
            album = $album
            duration = $duration
            position = $position
          }
        } catch { }
      }
    } catch { }

    $neteaseRow = $null
    if ($netEaseReady) {
      $hit = $null
      try { $hit = [NetEaseProbe]::FindWindow() } catch { $hit = $null }
      if ($hit) {
        $parts = $hit -split '\|', 2
        $targetPid = [uint32]$parts[0]
        $windowTitle = $parts[1]
        if ($windowTitle.EndsWith(" - 网易云音乐")) { $windowTitle = $windowTitle.Substring(0, $windowTitle.Length - 8) }
        $song = $windowTitle
        $artist = ""
        $split = $windowTitle.LastIndexOf(" - ")
        if ($split -gt 0) {
          $song = $windowTitle.Substring(0, $split)
          $artist = $windowTitle.Substring($split + 3)
        }
        $peak = 0.0
        try {
          $audio = [NetEaseProbe]::Audio($targetPid)
          $audioParts = $audio -split '\|', 2
          $peak = [double]::Parse($audioParts[1], [System.Globalization.CultureInfo]::InvariantCulture)
        } catch { }
        $playing = $peak -gt 0.001
        $neteaseRow = [ordered]@{
          ok = $true
          session = $true
          source = "netease"
          aumid = "cloudmusic.exe"
          status = $(if ($playing) { "Playing" } else { "Paused" })
          title = $song
          artist = $artist
          album = ""
          duration = 0
          position = 0
        }
      }
    }
      $lastRows = $rows
      $lastNetease = $neteaseRow
    } else {
      $rows = $lastRows
      $neteaseRow = $lastNetease
    }
    $tick++

    $spectrum = ""
    $specError = ""
    try { $spectrum = [LoopbackSpectrum]::Read() } catch { $spectrum = ""; $specError = $_.Exception.Message }
    try { Add-Content -Path "C:\\Users\\huans\\Documents\\deepseek-harness\\default-workspace\\_scratch\\spec-host.log" -Value ("len=" + $spectrum.Length + " err=" + $specError) } catch { }
    if ($neteaseRow -and $spectrum) { $neteaseRow.album = "SP:" + $spectrum }
    if ($neteaseRow) { $rows = @($neteaseRow) + $rows }
    $seen = @{}
    $unique = @()
    foreach ($r in $rows) {
      $key = [string]$r.aumid
      if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; $unique += $r }
    }
    $rows = $unique
    if ($rows.Count -gt 5) { $rows = $rows[0..4] }

    $primary = $null
    foreach ($r in $rows) { if ($r.status -eq "Playing") { $primary = $r; break } }
    if ($null -eq $primary -and $rows.Count -gt 0) { $primary = $rows[0] }
    if ($null -ne $primary) {
      $row = [ordered]@{
        ok = $true
        session = $true
        sources = @($rows)
        spectrum = $spectrum
        source = $primary.source
        aumid = $primary.aumid
        status = $primary.status
        title = $primary.title
        artist = $primary.artist
        album = $primary.album
        duration = $primary.duration
        position = $primary.position
      }
      $line = $row | ConvertTo-Json -Compress -Depth 6
    } else {
      $line = '{"ok":true,"session":false}'
    }
    $failures = 0
  } catch {
    $failures += 1
    if ($failures -ge 5) { $manager = $null; $failures = 0 }
  }
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 66
}
