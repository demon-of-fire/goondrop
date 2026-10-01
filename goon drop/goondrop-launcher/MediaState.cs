using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace GoonDropLauncher;

/// <summary>
/// A snapshot of what the Windows machine is currently doing: the media session
/// the user is listening to plus the real mute/volume state of the speaker and
/// microphone endpoints. The Node backend polls this over the loopback control
/// port and relays it to phones, so the app can render a truthful play/pause
/// button and a "what's playing" card instead of guessing.
/// </summary>
public static class MediaState
{
    // QUERY_USER_NOTIFICATION_STATE
    private const int QUNS_NOT_IMPLEMENTED = 0;
    private const int QUNS_BUSY = 1;
    private const int QUNS_PLAYING = 2;
    private const int QUNS_PAUSED = 3;
    private const int QUNS_SILENT = 4;
    private const int QUNS_DO_NOT_DISTURB = 5;

    private const int eRender = 0;
    private const int eCapture = 1;
    private const int eConsole = 0;
    private const int CLSCTX_ALL = 23;

    private static readonly Guid IID_IAudioEndpointVolume = new("5CDF2C82-841E-4546-9722-0CF74078229A");
    private static readonly Guid CLSID_MMDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");

    /// <summary>
    /// Processes that host a media session, most-specific first. Windows exposes no
    /// cross-process "what is playing" API to a plain Win32 process, but every media
    /// client advertises the current track in its top-level window caption, so we
    /// prefer a caption belonging to one of these apps.
    /// </summary>
    private static readonly string[] MediaProcesses =
    {
        "Spotify", "SpotifyAB", "Music", "wmplayer", "Microsoft.Media.Player",
        "Microsoft.Music.MediaPlayer", "ApplicationFrameHost", "vlc", "VLC media player",
        "mpv", "foobar2000", "AIMP", "AIMP3", "foobar", "PotPlayerMini64", "PotPlayerMini",
        "MPC-HC", "mpc-hc64", "Kodi", "Deezer", "Tidal", "TIDAL", "Amazon Music",
        "YouTube Music", "Winamp", "Audacious", "Clementine", "MediaMonkey",
        "chrome", "msedge", "firefox", "brave", "opera", "Arc", "vivaldi"
    };

    /// <summary>Suffixes browsers append to the page title; strip them for a cleaner track name.</summary>
    private static readonly string[] TitleSuffixes =
    {
        " - Google Chrome", " - Microsoft Edge", " - Mozilla Firefox", " - Brave",
        " - Opera", " - Vivaldi", " - YouTube", " - YouTube Music", " - Spotify",
        " - Apple Music", " - VLC media player", " - WhatsApp", " - Discord"
    };

    public sealed class Snapshot
    {
        public bool available { get; set; }
        public bool playing { get; set; }
        public int notificationState { get; set; } = QUNS_NOT_IMPLEMENTED;
        public string title { get; set; } = "";
        public string appName { get; set; } = "";
        public double volume { get; set; } = -1;
        public bool volumeMuted { get; set; }
        public bool micMuted { get; set; }
        public double micVolume { get; set; } = -1;
        public long updatedAt { get; set; }
    }

    // ─── Core Audio ───────────────────────────────────────────────────────────

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out object devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice? endpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        int OpenPropertyStore(int stgmAccess, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr notify);
        int UnregisterControlChangeNotify(IntPtr notify);
        int GetChannelCount(out uint count);
        int SetMasterVolumeLevel(float levelDb, ref Guid ctx);
        int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
        int GetMasterVolumeLevel(out float levelDb);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint ch, float levelDb, ref Guid ctx);
        int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
        int GetChannelVolumeLevel(uint ch, out float levelDb);
        int GetChannelVolumeLevelScalar(uint ch, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    private static IAudioEndpointVolume? GetEndpointVolume(int dataFlow)
    {
        try
        {
            var enumeratorType = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator);
            if (enumeratorType == null) return null;
            var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(enumeratorType)!;
            enumerator.GetDefaultAudioEndpoint(dataFlow, eConsole, out var device);
            if (device == null) return null;
            var iid = IID_IAudioEndpointVolume;
            var hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out var instance);
            if (hr != 0 || instance == null) return null;
            return (IAudioEndpointVolume)instance;
        }
        catch
        {
            return null;
        }
    }

    private static bool TryReadEndpoint(int dataFlow, out double volume, out bool muted)
    {
        volume = -1;
        muted = false;
        var endpoint = GetEndpointVolume(dataFlow);
        if (endpoint == null) return false;
        try
        {
            var ctx = Guid.Empty;
            if (endpoint.GetMasterVolumeLevelScalar(out float level) == 0) volume = level;
            if (endpoint.GetMute(out bool isMuted) == 0) muted = isMuted;
            return volume >= 0;
        }
        catch
        {
            return false;
        }
    }

    private static bool TrySetMute(int dataFlow, bool mute)
    {
        var endpoint = GetEndpointVolume(dataFlow);
        if (endpoint == null) return false;
        try
        {
            var ctx = Guid.Empty;
            return endpoint.SetMute(mute, ref ctx) == 0;
        }
        catch
        {
            return false;
        }
    }

    public static bool GetMicMute(out bool muted)
    {
        if (TryReadEndpoint(eCapture, out _, out muted)) return true;
        muted = false;
        return false;
    }

    public static bool SetMicMute(bool mute)
    {
        return TrySetMute(eCapture, mute);
    }

    public static bool GetSpeakerMute(out bool muted)
    {
        if (TryReadEndpoint(eRender, out _, out muted)) return true;
        muted = false;
        return false;
    }

    public static bool SetSpeakerMute(bool mute)
    {
        return TrySetMute(eRender, mute);
    }

    // ─── Media session discovery ──────────────────────────────────────────────

    [DllImport("shell32.dll")]
    private static extern int SHQueryUserNotificationState(out int state);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLengthW(IntPtr hWnd);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    private static string WindowTitle(IntPtr hWnd)
    {
        var buffer = new StringBuilder(512);
        GetWindowTextW(hWnd, buffer, buffer.Capacity);
        return buffer.ToString().Trim();
    }

    private static string ProcessName(uint pid)
    {
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return process.ProcessName;
        }
        catch
        {
            return "";
        }
    }

    /// <summary>Strip the trailing " - AppName" segments browsers and players append.</summary>
    private static string CleanTitle(string raw, string appName)
    {
        var title = raw;
        var changed = true;
        while (changed)
        {
            changed = false;
            foreach (var suffix in TitleSuffixes)
            {
                if (title.Length > suffix.Length && title.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                {
                    title = title.Substring(0, title.Length - suffix.Length).Trim();
                    changed = true;
                }
            }
            if (title.EndsWith(" - " + appName, StringComparison.OrdinalIgnoreCase))
            {
                title = title.Substring(0, title.Length - appName.Length - 3).Trim();
                changed = true;
            }
        }
        return title.Length == 0 ? raw : title;
    }

    private static int ScoreApp(string processName)
    {
        if (processName.Length == 0) return -1;
        for (int i = 0; i < MediaProcesses.Length; i++)
        {
            if (string.Equals(processName, MediaProcesses[i], StringComparison.OrdinalIgnoreCase)) return i;
        }
        return -1;
    }

    private sealed class Candidate
    {
        public string Title = "";
        public string App = "";
        public int Score = int.MaxValue;
    }

    /// <summary>
    /// Best-effort "what is playing" lookup. Windows has no public cross-process
    /// media-session API for a classic Win32 app, but every media client puts the
    /// current track in its window caption, so we pick the best media-ish caption
    /// on screen and fall back to whatever is in the foreground.
    /// </summary>
    private static (string title, string app) DiscoverNowPlaying()
    {
        var best = new Candidate();
        var foreground = GetForegroundWindow();
        var foregroundTitle = foreground == IntPtr.Zero ? "" : WindowTitle(foreground);
        var foregroundApp = foreground == IntPtr.Zero ? "" : ProcessName(GetWindowThreadProcessId(foreground, out var fgPid));

        EnumWindows((hWnd, _) =>
        {
            try
            {
                if (GetWindowTextLengthW(hWnd) <= 0) return true;
                var title = WindowTitle(hWnd);
                if (title.Length == 0 || title.Length > 300) return true;
                GetWindowThreadProcessId(hWnd, out var pid);
                var app = ProcessName(pid);
                if (app.Length == 0) return true;
                if (string.Equals(app, "explorer", StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(app, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)
                    && !title.Contains("Music", StringComparison.OrdinalIgnoreCase)) return true;

                var score = ScoreApp(app);
                if (score < 0) return true;
                if (score < best.Score)
                {
                    best.Score = score;
                    best.Title = title;
                    best.App = app;
                }
            }
            catch
            {
                // A window can vanish mid-enumeration; just skip it.
            }
            return true;
        }, IntPtr.Zero);

        if (best.Score < int.MaxValue) return (CleanTitle(best.Title, best.App), best.App);
        if (foregroundTitle.Length > 0) return (CleanTitle(foregroundTitle, foregroundApp), foregroundApp);
        return ("", "");
    }

    public static Snapshot Capture()
    {
        var snapshot = new Snapshot { updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };

        try
        {
            if (SHQueryUserNotificationState(out int state) == 0)
            {
                snapshot.notificationState = state;
                snapshot.playing = state == QUNS_PLAYING;
            }
            else
            {
                snapshot.notificationState = QUNS_NOT_IMPLEMENTED;
            }
        }
        catch
        {
            snapshot.notificationState = QUNS_NOT_IMPLEMENTED;
        }

        TryReadEndpoint(eRender, out double speaker, out bool speakerMuted);
        snapshot.volume = speaker;
        snapshot.volumeMuted = speakerMuted;

        TryReadEndpoint(eCapture, out double mic, out bool micMuted);
        snapshot.micVolume = mic;
        snapshot.micMuted = micMuted;

        try
        {
            var (title, app) = DiscoverNowPlaying();
            snapshot.title = title;
            snapshot.appName = app;
        }
        catch
        {
            snapshot.title = "";
            snapshot.appName = "";
        }

        // Only claim to be "playing" when the shell agrees there is a media
        // session in progress; a media window being open is not enough.
        if (snapshot.playing && snapshot.title.Length == 0)
        {
            snapshot.playing = false;
        }

        snapshot.available = true;
        return snapshot;
    }
}
