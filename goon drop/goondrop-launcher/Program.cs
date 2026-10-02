using System;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace GoonDropLauncher;

static class Program
{
    // Held for the lifetime of the process. Without this, every autostart,
    // double-click and self-update copy leaves another launcher running; only
    // one can own the 3945 control port, so the rest are silent ghosts that
    // serve stale media state to the phone.
    private static Mutex? _singleInstance;

    [STAThread]
    static void Main(string[] args)
    {
        // Handle "Send To" integration if a file path is passed
        if (args.Length > 0 && System.IO.File.Exists(args[0]))
        {
            try
            {
                using var client = new HttpClient();
                var payload = new { filePath = args[0] };
                var json = System.Text.Json.JsonSerializer.Serialize(payload);
                var content = new StringContent(json, Encoding.UTF8, "application/json");

                // Read active self-healed server port dynamically!
                int activePort = 3941;
                try
                {
                    string? portFile = FindPortFile();
                    if (portFile != null && System.IO.File.Exists(portFile))
                    {
                        activePort = int.Parse(System.IO.File.ReadAllText(portFile).Trim());
                    }
                }
                catch { }
                
                // Send file to local Goon Drop server using explicit IPv4 loopback
                var response = client.PostAsync($"http://127.0.0.1:{activePort}/api/internal/send-file", content).Result;
                
                if (response.IsSuccessStatusCode)
                {
                    MessageBox.Show($"Successfully sent '{System.IO.Path.GetFileName(args[0])}' to Goon Drop!", "Goon Drop", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else
                {
                    MessageBox.Show("Goon Drop server rejected the file. Make sure the server is running.", "Goon Drop Error", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not connect to Goon Drop. Please ensure the Goon Drop server is running in your system tray.\n\nError: " + ex.Message, "Goon Drop Not Running", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
return; // Exit immediately, do not start a new server instance
        }

        // Second instance: the tray icon already exists, so bring it forward
        // rather than starting a competing server and control-port owner.
        _singleInstance = new Mutex(initiallyOwned: true, @"Local\GoonDropLauncherSingleton", out bool isFirst);
        if (!isFirst)
        {
            NotifyExistingInstance();
            _singleInstance.Dispose();
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new Form1());
        _singleInstance.ReleaseMutex();
        _singleInstance.Dispose();
    }

    /// Ask an already-running launcher to surface itself. A named event is the
    /// cheapest signal available without pulling in IPC plumbing.
    static void NotifyExistingInstance()
    {
        try
        {
            using var ready = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\GoonDropLauncherShow");
            ready.Set();
        }
        catch { }
    }

    // Locate goondrop-port.txt next to the exe or in the project root (works
    // when the launcher is copied into the Startup folder).
    static string? FindPortFile()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string local = System.IO.Path.Combine(baseDir, "goondrop-port.txt");
        if (System.IO.File.Exists(local)) return local;

        var dir = new System.IO.DirectoryInfo(baseDir);
        while (dir != null)
        {
            foreach (var candidate in new[]
            {
                System.IO.Path.Combine(dir.FullName, "goondrop-port.txt"),
                System.IO.Path.Combine(dir.FullName, "goon drop", "goondrop-port.txt"),
                System.IO.Path.Combine(dir.FullName, "backend", "goondrop-port.txt")
            })
            {
                if (System.IO.File.Exists(candidate)) return candidate;
            }
            dir = dir.Parent;
        }
        return null;
    }
}