using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace GoonDropLauncher;

public partial class Form1 : Form
{
    private Process? serverProcess;
    private string serverUrl = "http://localhost:3941";
    private string networkUrl = "";
    private string pairingCode = "";
    private string lastClipboardText = "";
    private System.Windows.Forms.Timer clipboardTimer = null!;
    private readonly string backendDir;
    private readonly string rootDir;

    // Controls
    private Button btnStart = null!;
    private Button btnStop = null!;
    private Button btnBrowser = null!;
    private Button btnHideToTray = null!;
    private Button btnToggleWidget = null!;
    private TextBox txtOutput = null!;
    private Label lblStatus = null!;
    private Label lblUrl = null!;
    private Label lblPairing = null!;
    private CheckBox chkAutoStart = null!;
    private CheckBox chkStartMinimized = null!;
    private System.Windows.Forms.Timer pollTimer = null!;

    // Integration Controls (System Tray & Startup)
    private NotifyIcon notifyIcon = null!;
    private ContextMenuStrip trayMenu = null!;
    private ToolStripMenuItem menuStart = null!;
    private ToolStripMenuItem menuStop = null!;
    private ToolStripMenuItem menuStartup = null!;
    private ToolStripMenuItem menuWidget = null!;

    // Widget Dragging State
    private bool isWidgetMode = false;
    private bool isDragging = false;
    private Point dragCursorPoint;
    private Point dragFormPoint;

    private bool IsServerRunning
    {
        get
        {
            try
            {
                return serverProcess != null && !serverProcess.HasExited;
            }
            catch
            {
                return false;
            }
        }
    }

    private static string FindProjectRoot()
    {
        var baseDir = AppDomain.CurrentDomain.BaseDirectory;
        var dir = new DirectoryInfo(baseDir);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "backend", "dist", "index.js")))
            {
                return dir.FullName;
            }
            if (File.Exists(Path.Combine(dir.FullName, "goon drop", "backend", "dist", "index.js")))
            {
                return Path.Combine(dir.FullName, "goon drop");
            }
            dir = dir.Parent;
        }

        var candidates = new[]
        {
            baseDir,
            Path.Combine(baseDir, ".."),
            Path.Combine(baseDir, "..", ".."),
            Path.Combine(baseDir, "..", "..", ".."),
            Path.Combine(baseDir, "..", "..", "..", "..")
        };

        foreach (var c in candidates)
        {
            try
            {
                var full = Path.GetFullPath(c);
                if (File.Exists(Path.Combine(full, "backend", "dist", "index.js"))) return full;
                if (File.Exists(Path.Combine(full, "goon drop", "backend", "dist", "index.js"))) return Path.Combine(full, "goon drop");
            }
            catch { }
        }

        return baseDir;
    }

    public Form1()
    {
        rootDir = FindProjectRoot();
        backendDir = Path.Combine(rootDir, "backend");

        KeyPreview = true;
        SetupUI();
        SetupTray();
        CheckNodeJs();
        StartLocalListener();
        StartUdpMouseListener();
        
        // Auto-start server on launch
        BtnStart_Click(null, EventArgs.Empty);

        // Start handoff poller AFTER initial launch
        StartHandoffTimer();

        // Start minimized if previously enabled
        try
        {
            string cfgPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "goondrop-launcher.cfg");
            if (File.Exists(cfgPath))
            {
                var cfg = File.ReadAllText(cfgPath).Trim();
                if (cfg.Contains("startMinimized=true"))
                {
                    chkStartMinimized.Checked = true;
                    HideWindow();
                }
            }
        }
        catch { }
    }

    private void SetupUI()
    {
        Text = "Goon Drop Server Control";
        Size = new Size(600, 480);
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        FormClosing += Form1_FormClosing;
        BackColor = Color.FromArgb(15, 15, 15);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10);
        Icon = CreateApplicationIcon();

        // Mouse Drag Handlers for Widget Mode
        MouseDown += Widget_MouseDown;
        MouseMove += Widget_MouseMove;
        MouseUp += Widget_MouseUp;

        // Enable drag-and-drop on the form (for widget dropping!)
        AllowDrop = true;
        DragEnter += Form1_DragEnter;
        DragDrop += Form1_DragDrop;

        // Title
        var lblTitle = new Label
        {
            Text = "Goon Drop -- Windows + iPhone Continuity",
            Font = new Font("Segoe UI", 14, FontStyle.Bold),
            ForeColor = Color.FromArgb(0, 229, 160),
            Location = new Point(20, 15),
            Size = new Size(560, 30),
            TextAlign = ContentAlignment.MiddleLeft,
            AccessibleName = "Application Title",
            AccessibleDescription = "Goon Drop application title bar",
            TabStop = false
        };
        lblTitle.MouseDown += Widget_MouseDown;
        lblTitle.MouseMove += Widget_MouseMove;
        lblTitle.MouseUp += Widget_MouseUp;

        // Status
        lblStatus = new Label
        {
            Text = "Status: Stopped",
            Font = new Font("Segoe UI", 11, FontStyle.Bold),
            ForeColor = Color.FromArgb(255, 92, 92),
            Location = new Point(20, 55),
            Size = new Size(400, 25),
            AccessibleName = "Server Status",
            AccessibleDescription = "Indicates whether the Goon Drop server is running or stopped",
            TabStop = false
        };
        lblStatus.MouseDown += Widget_MouseDown;
        lblStatus.MouseMove += Widget_MouseMove;
        lblStatus.MouseUp += Widget_MouseUp;

        // URL display
        lblUrl = new Label
        {
            Text = "Local: not running",
            Location = new Point(20, 85),
            Size = new Size(560, 20),
            ForeColor = Color.FromArgb(200, 200, 200),
            AccessibleName = "Server URL",
            AccessibleDescription = "Displays the local and network URLs of the Goon Drop server",
            TabStop = false
        };
        lblUrl.MouseDown += Widget_MouseDown;

        // Pairing code
        lblPairing = new Label
        {
            Text = "Pairing Code: ---",
            Location = new Point(20, 108),
            Size = new Size(560, 20),
            ForeColor = Color.FromArgb(200, 200, 200),
            AccessibleName = "Pairing Code",
            AccessibleDescription = "Displays the current pairing code for connecting devices",
            TabStop = false
        };
        lblPairing.MouseDown += Widget_MouseDown;
        lblPairing.MouseMove += Widget_MouseMove;
        lblPairing.MouseUp += Widget_MouseUp;

        // Output box
        txtOutput = new TextBox
        {
            Location = new Point(20, 140),
            Size = new Size(545, 210),
            Multiline = true,
            ReadOnly = true,
            BackColor = Color.FromArgb(10, 10, 10),
            ForeColor = Color.FromArgb(0, 229, 160),
            Font = new Font("Consolas", 9),
            BorderStyle = BorderStyle.FixedSingle,
            ScrollBars = ScrollBars.Vertical,
            TabIndex = 0,
            AccessibleName = "Server Log Output",
            AccessibleDescription = "Displays server log messages and notifications"
        };

         // Start button with mnemonic
         btnStart = new Button
         {
             Text = "&Start Server",
             Location = new Point(20, 370),
             Size = new Size(130, 44),
             BackColor = Color.FromArgb(0, 229, 160),
             ForeColor = Color.Black,
             Font = new Font("Segoe UI", 10, FontStyle.Bold),
             FlatStyle = FlatStyle.Flat,
             FlatAppearance = { BorderSize = 0 },
             TabIndex = 1,
             AccessibleName = "Start Server",
             AccessibleDescription = "Starts the Goon Drop backend server"
         };
        btnStart.Click += BtnStart_Click;

        // Stop button with mnemonic
        btnStop = new Button
        {
            Text = "S&top Server",
            Location = new Point(160, 370),
            Size = new Size(130, 44),
            BackColor = Color.FromArgb(60, 60, 60),
            ForeColor = Color.Gray,
            Font = new Font("Segoe UI", 10, FontStyle.Bold),
            FlatStyle = FlatStyle.Flat,
            FlatAppearance = { BorderSize = 0 },
            Enabled = false,
            TabIndex = 2,
            AccessibleName = "Stop Server",
            AccessibleDescription = "Stops the Goon Drop backend server"
        };
        btnStop.Click += BtnStop_Click;

        // Hide to Tray button with mnemonic
        btnHideToTray = new Button
        {
            Text = "Send to &Tray",
            Location = new Point(300, 370),
            Size = new Size(130, 44),
            BackColor = Color.FromArgb(40, 40, 40),
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 10),
            FlatStyle = FlatStyle.Flat,
            FlatAppearance = { BorderSize = 0 },
            TabIndex = 3,
            AccessibleName = "Send to Tray",
            AccessibleDescription = "Minimizes the application to the system tray"
        };
        btnHideToTray.Click += (s, e) => HideWindow();

        // Desktop Widget toggle button
        btnToggleWidget = new Button
        {
            Text = "&Widget Mode",
            Location = new Point(440, 370),
            Size = new Size(125, 44),
            BackColor = Color.FromArgb(40, 40, 40),
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 10),
            FlatStyle = FlatStyle.Flat,
            FlatAppearance = { BorderSize = 0 },
            TabIndex = 4,
            AccessibleName = "Toggle Widget Mode",
            AccessibleDescription = "Switches between normal window mode and compact desktop widget mode"
        };
        btnToggleWidget.Click += (s, e) => ToggleWidgetMode();

        // Auto-start on sign in checkbox with mnemonic
        chkAutoStart = new CheckBox
        {
            Text = "&Auto-start on sign in",
            Location = new Point(20, 422),
            Size = new Size(160, 24),
            ForeColor = Color.FromArgb(0, 229, 160),
            Font = new Font("Segoe UI", 9),
            BackColor = Color.Transparent,
            FlatStyle = FlatStyle.Flat,
            TabIndex = 7,
            TabStop = true,
            AccessibleName = "Auto-start on sign in",
            AccessibleDescription = "When checked, Goon Drop Launcher starts automatically when you sign in to Windows"
        };
        chkAutoStart.Checked = IsStartupEnabled();
        chkAutoStart.CheckedChanged += (s, e) => ToggleStartup(chkAutoStart.Checked);

        // Start minimized to tray checkbox with mnemonic
        chkStartMinimized = new CheckBox
        {
            Text = "Start &minimized to tray",
            Location = new Point(190, 422),
            Size = new Size(180, 24),
            ForeColor = Color.FromArgb(200, 200, 200),
            Font = new Font("Segoe UI", 9),
            BackColor = Color.Transparent,
            FlatStyle = FlatStyle.Flat,
            TabIndex = 8,
            TabStop = true,
            AccessibleName = "Start minimized to tray",
            AccessibleDescription = "When checked, Goon Drop starts minimized to the system tray instead of showing the window"
        };
        chkStartMinimized.CheckedChanged += (s, e) => {
            try
            {
                string cfgPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "goondrop-launcher.cfg");
                File.WriteAllText(cfgPath, $"startMinimized={chkStartMinimized.Checked.ToString().ToLower()}");
            }
            catch { }
        };

        // Ping Phones button with mnemonic
        var btnPingPhones = new Button
        {
            Text = "&Ping Phones",
            Location = new Point(20, 315),
            Size = new Size(130, 36),
            BackColor = Color.FromArgb(30, 30, 30),
            ForeColor = Color.FromArgb(0, 229, 160),
            Font = new Font("Segoe UI", 9, FontStyle.Bold),
            FlatStyle = FlatStyle.Flat,
            FlatAppearance = { BorderSize = 1, BorderColor = Color.FromArgb(0, 229, 160) },
            TabIndex = 5,
            AccessibleName = "Ping Phones",
            AccessibleDescription = "Sends a push notification to all connected phones to get their attention"
        };
        btnPingPhones.Click += async (s, e) => {
            try {
                using var client = new System.Net.Http.HttpClient();
                await client.PostAsync($"{serverUrl}/api/internal/ping-phones", null);
            } catch { }
        };

        // Browser link button with mnemonic
        btnBrowser = new Button
        {
            Text = "&Web UI",
            Location = new Point(480, 15),
            Size = new Size(85, 30),
            BackColor = Color.FromArgb(30, 30, 30),
            ForeColor = Color.FromArgb(0, 229, 160),
            Font = new Font("Segoe UI", 9, FontStyle.Bold),
            FlatStyle = FlatStyle.Flat,
            FlatAppearance = { BorderSize = 1, BorderColor = Color.FromArgb(0, 229, 160) },
            TabIndex = 6,
            AccessibleName = "Open Web UI",
            AccessibleDescription = "Opens the Goon Drop web interface in your default browser"
        };
        btnBrowser.Click += (_, _) => OpenBrowser(serverUrl);

        // Poll timer to fetch pairing info
        pollTimer = new System.Windows.Forms.Timer { Interval = 2000 };
        pollTimer.Tick += PollTimer_Tick;

        // Add controls
        Controls.AddRange(new Control[]
        {
            lblTitle, lblStatus, lblUrl, lblPairing,
            txtOutput, btnStart, btnStop, btnHideToTray, btnToggleWidget, btnBrowser, btnPingPhones,
            chkAutoStart, chkStartMinimized
        });

        Log($"Goon Drop Launcher v1.2 - Kernel Integration Mode");
        Log($"Project root: {rootDir}");
        Log($"Backend: {backendDir}");
        Log($"Node.js: {GetNodeVersion()}");
    }

    private void SetupTray()
    {
        // Context Menu
        trayMenu = new ContextMenuStrip();
        trayMenu.Opening += TrayMenu_Opening;

        // Rebuild initial tray menu
        RebuildTrayMenu();

        // Notify Icon
        notifyIcon = new NotifyIcon
        {
            Text = "Goon Drop (AirDrop/Handoff LAN)",
            Icon = CreateApplicationIcon(),
            ContextMenuStrip = trayMenu,
            Visible = true
        };

        notifyIcon.DoubleClick += (s, e) => OpenBrowser(serverUrl);
        
        // Native Balloon Tip Click Handler -> instantly opens the Web Client!
        notifyIcon.BalloonTipClicked += (s, e) => OpenBrowser(serverUrl);
    }

    private void TrayMenu_Opening(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        RebuildTrayMenu();
    }

    private void RebuildTrayMenu()
    {
        if (trayMenu == null) return;
        trayMenu.Items.Clear();

        var menuOpen = new ToolStripMenuItem("&Open Control Panel", null, (s, e) => ShowWindow());
        menuOpen.Font = new Font(trayMenu.Font, FontStyle.Bold);
        menuOpen.AccessibleDescription = "Shows the Goon Drop control panel window";

        var menuWeb = new ToolStripMenuItem("Open &Web Client", null, (s, e) => OpenBrowser(serverUrl));
        menuWeb.AccessibleDescription = "Opens the Goon Drop web interface in your default browser";
        
        trayMenu.Items.AddRange(new ToolStripItem[] {
            menuOpen,
            menuWeb,
            new ToolStripSeparator()
        });

        // Dynamically fetch and display clipboard history from local server
        try
        {
            using var client = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
            var response = client.GetAsync($"{serverUrl}/api/internal/clipboard-history").GetAwaiter().GetResult();
            if (response.IsSuccessStatusCode)
            {
                var json = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                var items = JsonSerializer.Deserialize<ClipboardHistoryItem[]>(json);
                if (items != null && items.Length > 0)
                {
                    var clipboardHeader = new ToolStripMenuItem("Recent Synced Clips:");
                    clipboardHeader.Enabled = false;
                    clipboardHeader.ForeColor = Color.FromArgb(0, 229, 160);
                    clipboardHeader.AccessibleDescription = "Header for recently synced clipboard items";
                    trayMenu.Items.Add(clipboardHeader);

                    foreach (var item in items)
                    {
                        var display = item.text.Length > 30 ? item.text.Substring(0, 28) + "..." : item.text;
                        display = display.Replace("\r", " ").Replace("\n", " ");
                        
                        var menuClip = new ToolStripMenuItem($"  {display}", null, (s, e) => {
                            try {
                                Clipboard.SetText(item.text);
                                notifyIcon.ShowBalloonTip(1500, "Goon Drop", "Copied to Windows Clipboard!", ToolTipIcon.Info);
                            } catch { }
                        });
                        menuClip.ToolTipText = item.text;
                        trayMenu.Items.Add(menuClip);
                    }
                    trayMenu.Items.Add(new ToolStripSeparator());
                }
            }
        }
        catch { /* Server might not be running yet */ }

        menuStart = new ToolStripMenuItem("&Start Server", null, BtnStart_Click);
        menuStop = new ToolStripMenuItem("S&top Server", null, BtnStop_Click);
        menuStop.Enabled = IsServerRunning;
        menuStart.Enabled = !menuStop.Enabled;
        menuStart.AccessibleDescription = "Starts the Goon Drop backend server";
        menuStop.AccessibleDescription = "Stops the Goon Drop backend server";

        menuWidget = new ToolStripMenuItem("Show &Desktop Widget", null, (s, e) => ToggleWidgetMode());
        menuWidget.Checked = isWidgetMode;
        menuWidget.AccessibleDescription = "Toggles between normal window mode and compact desktop widget mode";

        menuStartup = new ToolStripMenuItem("Start with &Windows", null, ToggleStartupClick);
        menuStartup.Checked = IsStartupEnabled();
        menuStartup.AccessibleDescription = "When checked, Goon Drop Launcher starts automatically when you sign in to Windows";

        var menuSendTo = new ToolStripMenuItem("Add to 'Send &To' Context Menu", null, ToggleSendToClick);
        menuSendTo.Checked = IsSendToEnabled();
        menuSendTo.AccessibleDescription = "Adds Goon Drop to the Windows 'Send To' right-click context menu for files";

        var menuShell = new ToolStripMenuItem("Add 'Send with &Goon Drop' to Explorer Menu", null, ToggleShellExtensionClick);
        menuShell.Checked = IsShellExtensionEnabled();
        menuShell.AccessibleDescription = "Adds a 'Send with Goon Drop' option to the Windows Explorer right-click menu";

        var menuPing = new ToolStripMenuItem("Ping Connected &Phones", null, async (s, e) => {
            try {
                using var client = new System.Net.Http.HttpClient();
                await client.PostAsync($"{serverUrl}/api/internal/ping-phones", null);
            } catch { }
        });

        var menuExit = new ToolStripMenuItem("Exit", null, (s, e) => {
            StopServer();
            try { localListener?.Stop(); } catch { }
            try { udpMouseListener?.Close(); } catch { }
            notifyIcon.Visible = false;
            Application.Exit();
        });

        trayMenu.Items.AddRange(new ToolStripItem[] {
            menuStart,
            menuStop,
            menuWidget,
            menuStartup,
            menuSendTo,
            menuShell,
            menuPing,
            new ToolStripSeparator(),
            menuExit
        });
    }

    private class ClipboardHistoryItem
    {
        public string text { get; set; } = "";
        public long timestamp { get; set; }
        public string sourceDeviceName { get; set; } = "";
    }

    private void ToggleWidgetMode()
    {
        isWidgetMode = !isWidgetMode;
        menuWidget.Checked = isWidgetMode;

        if (isWidgetMode)
        {
            // Turn into mini floating window
            FormBorderStyle = FormBorderStyle.None;
            Size = new Size(220, 220);
            TopMost = true; // Always-on-top!
            Opacity = 0.90; // Sleek transparent style
            AllowDrop = true; // ⚠️ CRITICAL UI FIX: Re-enforce AllowDrop since handle re-creation resets it!
            
            // Re-arrange layout for mini-mode
            txtOutput.Visible = false;
            btnStart.Visible = false;
            btnStop.Visible = false;
            btnHideToTray.Visible = false;
            btnBrowser.Visible = false;
            chkAutoStart.Visible = false;
            chkStartMinimized.Visible = false;
            btnToggleWidget.Text = "&Normal UI";
            btnToggleWidget.Size = new Size(180, 30);
            btnToggleWidget.Location = new Point(20, 170);

            lblUrl.Visible = false;
            lblPairing.Location = new Point(20, 130);
            lblStatus.Location = new Point(20, 95);
            
            Log("Switched to desktop PiP widget mode.");
        }
        else
        {
            // Restore Normal UI
            FormBorderStyle = FormBorderStyle.FixedSingle;
            Size = new Size(600, 480);
            TopMost = false;
            Opacity = 1.0;
            AllowDrop = true; // ⚠️ CRITICAL UI FIX: Re-enforce AllowDrop since handle re-creation resets it!

            txtOutput.Visible = true;
            btnStart.Visible = true;
            btnStop.Visible = true;
            btnHideToTray.Visible = true;
            btnBrowser.Visible = true;
            chkAutoStart.Visible = true;
            chkStartMinimized.Visible = true;
            btnToggleWidget.Text = "&Widget Mode";
            btnToggleWidget.Size = new Size(125, 44);
            btnToggleWidget.Location = new Point(440, 370);

            lblUrl.Visible = true;
            lblPairing.Location = new Point(20, 108);
            lblStatus.Location = new Point(20, 55);
            
            Log("Restored normal control panel layout.");
        }
    }

    // Draggable Borderless Form support
    private void Widget_MouseDown(object? sender, MouseEventArgs e)
    {
        if (isWidgetMode && e.Button == MouseButtons.Left)
        {
            isDragging = true;
            dragCursorPoint = Cursor.Position;
            dragFormPoint = this.Location;
        }
    }

    private void Widget_MouseMove(object? sender, MouseEventArgs e)
    {
        if (isDragging)
        {
            Point dif = Point.Subtract(Cursor.Position, new Size(dragCursorPoint));
            this.Location = Point.Add(dragFormPoint, new Size(dif));
        }
    }

    private void Widget_MouseUp(object? sender, MouseEventArgs e)
    {
        isDragging = false;
    }

    private void HideWindow()
    {
        Visible = false;
        ShowInTaskbar = false;
        notifyIcon.ShowBalloonTip(3000, "Goon Drop Background Agent", "Goon Drop is running. Drag files to 'Send To' menu, use Ctrl+Shift+G, or copy clipboard items.", ToolTipIcon.Info);
    }

    private void ShowWindow()
    {
        Visible = true;
        ShowInTaskbar = true;
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private Icon CreateApplicationIcon()
    {
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using var brush = new SolidBrush(Color.FromArgb(0, 229, 160));
            
            Point[] points = {
                new Point(16, 2),
                new Point(27, 20),
                new Point(24, 28),
                new Point(8, 28),
                new Point(5, 20)
            };
            g.FillPolygon(brush, points);
        }
        return Icon.FromHandle(bitmap.GetHicon());
    }

    private void CheckNodeJs()
    {
        try
        {
            var psi = new ProcessStartInfo("node", "--version")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var p = Process.Start(psi);
            if (p == null) throw new Exception("Node.js not found");
            var ver = p.StandardOutput.ReadToEnd().Trim();
            Log($"Node.js version: {ver}");
        }
        catch
        {
            Log("ERROR: Node.js is not installed!");
            Log("Download from: https://nodejs.org");
            btnStart.Enabled = false;
        }
    }

    private string GetNodeVersion()
    {
        try
        {
            var psi = new ProcessStartInfo("node", "--version")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var p = Process.Start(psi);
            return p?.StandardOutput.ReadToEnd().Trim() ?? "not found";
        }
        catch { return "not found"; }
    }

    private void BtnStart_Click(object? sender, EventArgs e)
    {
        if (IsServerRunning)
        {
            Log("Server is already running.");
            return;
        }

        Log("Starting server...");
        SetServerState(true);

        Process? proc = null;
        try
        {
            var indexPath = Path.Combine(backendDir, "dist", "index.js");
            if (!File.Exists(indexPath))
            {
                Log($"ERROR: Backend entry point not found at: {indexPath}");
                Log($"Looked in project root: {rootDir}");
                SetServerState(false);
                return;
            }

            var psi = new ProcessStartInfo("node")
            {
                Arguments = "dist/index.js",
                WorkingDirectory = backendDir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            psi.EnvironmentVariables["NODE_ENV"] = "production";
            psi.EnvironmentVariables["PORT"] = "3941";

            proc = new Process { StartInfo = psi };
            proc.OutputDataReceived += (_, args) =>
            {
                if (args.Data != null)
                {
                    var line = args.Data;
                    if (this.IsHandleCreated && !this.IsDisposed)
                    {
                        try { Invoke(() => Log(line)); } catch { }
                    }

                    if (line.Contains("Network:"))
                    {
                        var idx = line.IndexOf("http");
                        if (idx >= 0) networkUrl = line.Substring(idx).Trim();
                    }
                    if (line.Contains("Local:"))
                    {
                        var idx = line.IndexOf("http");
                        if (idx >= 0) {
                            serverUrl = line.Substring(idx).Trim();
                            if (this.IsHandleCreated && !this.IsDisposed)
                            {
                                try
                                {
                                    Invoke(() => {
                                        pollTimer.Stop();
                                        pollTimer.Start();
                                    });
                                } catch { }
                            }
                        }
                    }
                    if (line.Contains("Pairing Code:"))
                    {
                        var idx = line.IndexOf("Code:") + 6;
                        pairingCode = line.Substring(idx).Trim();
                        if (this.IsHandleCreated && !this.IsDisposed)
                        {
                            try { Invoke(() => UpdateInfo()); } catch { }
                        }
                    }
                    if (line.Contains("[NOTIFY]"))
                    {
                        var idx = line.IndexOf("[NOTIFY]") + 8;
                        var msg = line.Substring(idx).Trim();
                        if (this.IsHandleCreated && !this.IsDisposed)
                        {
                            try
                            {
                                Invoke(() => {
                                    notifyIcon.ShowBalloonTip(3000, "Goon Drop", msg, ToolTipIcon.Info);
                                });
                            } catch { }
                        }
                    }
                }
            };
            proc.ErrorDataReceived += (_, args) =>
            {
                if (args.Data != null && this.IsHandleCreated && !this.IsDisposed)
                {
                    try { Invoke(() => Log($"[ERR] {args.Data}")); } catch { }
                }
            };

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            serverProcess = proc;
            pollTimer.Start();
            Log("Server agent initialized.");
        }
        catch (Exception ex)
        {
            proc?.Dispose();
            serverProcess = null;
            Log($"Error starting server: {ex.Message}");
            SetServerState(false);
        }
    }

    private void BtnStop_Click(object? sender, EventArgs e)
    {
        StopServer();
    }

    private void StopServer()
    {
        try
        {
            if (IsServerRunning)
            {
                Log("Stopping server...");
                serverProcess?.Kill(entireProcessTree: true);
                serverProcess?.Dispose();
            }
        }
        catch (Exception ex)
        {
            Log($"Note during server stop: {ex.Message}");
        }
        finally
        {
            serverProcess = null;
            pollTimer.Stop();
            SetServerState(false);
            Log("Server stopped.");
        }
    }

    private void SetServerState(bool running)
    {
        btnStart.Enabled = !running;
        btnStart.BackColor = running ? Color.FromArgb(60, 60, 60) : Color.FromArgb(0, 229, 160);
        btnStart.ForeColor = running ? Color.Gray : Color.Black;

        btnStop.Enabled = running;
        btnStop.BackColor = running ? Color.FromArgb(220, 50, 50) : Color.FromArgb(60, 60, 60);
        btnStop.ForeColor = running ? Color.White : Color.Gray;

        if (menuStart != null) menuStart.Enabled = !running;
        if (menuStop != null) menuStop.Enabled = running;

        lblStatus.Text = running ? "Status: Running" : "Status: Stopped";
        lblStatus.ForeColor = running ? Color.FromArgb(0, 229, 160) : Color.FromArgb(255, 92, 92);
        
        if (notifyIcon != null)
        {
            notifyIcon.Text = running ? $"Goon Drop (Online - {pairingCode})" : "Goon Drop (Stopped)";
        }
    }

    private void UpdateInfo()
    {
        if (!string.IsNullOrEmpty(networkUrl))
        {
            lblUrl.Text = $"Local: {serverUrl}   |   Network: {networkUrl}";
        }
        lblPairing.Text = $"Pairing Code: {pairingCode}";
        lblPairing.ForeColor = string.IsNullOrEmpty(pairingCode) || pairingCode == "---"
            ? Color.FromArgb(200, 200, 200)
            : Color.FromArgb(0, 229, 160);
            
        if (notifyIcon != null)
        {
            notifyIcon.Text = $"Goon Drop (Online - {pairingCode})";
        }
    }

    private async void PollTimer_Tick(object? sender, EventArgs e)
    {
        if (!IsServerRunning) return;
        try
        {
            using var client = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var json = await client.GetStringAsync($"{serverUrl}/api/qrcode");
            var data = JsonSerializer.Deserialize<QrResponse>(json);
            if (data != null)
            {
                pairingCode = data.pairingCode;
                networkUrl = data.pairingUrl;
                if (this.IsHandleCreated && !this.IsDisposed)
                {
                    try { Invoke(() => UpdateInfo()); } catch { }
                }
                pollTimer.Stop();
            }
        }
        catch { }
    }

    private void OpenBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Log($"Could not open browser: {ex.Message}");
        }
    }

    private void Log(string message)
    {
        var timestamp = DateTime.Now.ToString("HH:mm:ss");
        txtOutput.AppendText($"[{timestamp}] {message}\r\n");
        txtOutput.SelectionStart = txtOutput.TextLength;
        txtOutput.ScrollToCaret();
    }

    private void Form1_FormClosing(object? sender, FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            HideWindow();
        }
    }

    // Windows Startup Shortcut Handling
    private bool IsStartupEnabled()
    {
        string startupFolder = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        string shortcutPath = Path.Combine(startupFolder, "GoonDropLauncher.lnk");
        return File.Exists(shortcutPath);
    }

    private void ToggleStartupClick(object? sender, EventArgs e)
    {
        bool current = IsStartupEnabled();
        ToggleStartup(!current);
        menuStartup.Checked = !current;
    }

    private void ToggleStartup(bool enable)
    {
        string startupFolder = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        string shortcutPath = Path.Combine(startupFolder, "GoonDropLauncher.lnk");

        if (enable)
        {
            try
            {
                Type? mshell = Type.GetTypeFromProgID("WScript.Shell");
                if (mshell != null)
                {
                    object? shell = Activator.CreateInstance(mshell);
                    if (shell != null)
                    {
                        object shortcut = mshell.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath })!;
                        // ⚠️ CRITICAL BUG FIX: Use Environment.ProcessPath so it doesn't point to AppData\Local\Temp on single-file publish!
                        mshell.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { Environment.ProcessPath ?? "" });
                        mshell.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { AppDomain.CurrentDomain.BaseDirectory });
                        mshell.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { "Start Goon Drop Server" });
                        mshell.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
                    }
                }
                Log("Goon Drop registered to launch automatically on Windows boot.");
            }
            catch (Exception ex)
            {
                Log($"Could not create Windows boot shortcut: {ex.Message}");
            }
        }
        else
        {
            if (File.Exists(shortcutPath))
            {
                File.Delete(shortcutPath);
                Log("Goon Drop removed from Windows boot shortcuts.");
            }
        }
    }

    // Native Windows Send To Integration
    private bool IsSendToEnabled()
    {
        string sendToFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\SendTo");
        string shortcutPath = Path.Combine(sendToFolder, "Goon Drop.lnk");
        return File.Exists(shortcutPath);
    }

    private void ToggleSendToClick(object? sender, EventArgs e)
    {
        bool current = IsSendToEnabled();
        ToggleSendTo(!current);
        if (sender is ToolStripMenuItem item) item.Checked = !current;
    }

    private void ToggleSendTo(bool enable)
    {
        string sendToFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\SendTo");
        string shortcutPath = Path.Combine(sendToFolder, "Goon Drop.lnk");

        if (enable)
        {
            try
            {
                Type? mshell = Type.GetTypeFromProgID("WScript.Shell");
                if (mshell != null)
                {
                    object? shell = Activator.CreateInstance(mshell);
                    if (shell != null)
                    {
                        object shortcut = mshell.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath })!;
                        // ⚠️ CRITICAL BUG FIX: Use Environment.ProcessPath so it doesn't point to AppData\Local\Temp on single-file publish!
                        mshell.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { Environment.ProcessPath ?? "" });
                        mshell.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { AppDomain.CurrentDomain.BaseDirectory });
                        mshell.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { "Send file via Goon Drop" });
                        mshell.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
                    }
                }
                Log("Goon Drop added to Windows 'Send To' context menu.");
            }
            catch (Exception ex)
            {
                Log($"Could not create SendTo shortcut: {ex.Message}");
            }
        }
        else
        {
            if (File.Exists(shortcutPath))
            {
                File.Delete(shortcutPath);
                Log("Goon Drop removed from Windows 'Send To' context menu.");
            }
        }
    }

    // Native Windows Registry Right-Click Context Menu ("Send with Goon Drop")
    private bool IsShellExtensionEnabled()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Classes\*\shell\Goon Drop");
            return key != null;
        }
        catch { return false; }
    }

    private void ToggleShellExtensionClick(object? sender, EventArgs e)
    {
        bool current = IsShellExtensionEnabled();
        ToggleShellExtension(!current);
        if (sender is ToolStripMenuItem item) item.Checked = !current;
    }

    private void ToggleShellExtension(bool enable)
    {
        try
        {
            if (enable)
            {
                using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Classes\*\shell\Goon Drop");
                key.SetValue("", "Send with Goon Drop");
                // Use the executable's path as the icon!
                key.SetValue("Icon", Environment.ProcessPath ?? "");
                using var cmdKey = key.CreateSubKey("command");
                cmdKey.SetValue("", $"\"{Environment.ProcessPath ?? ""}\" \"%1\"");
                Log("Goon Drop added to top-level Windows right-click menu.");
            }
            else
            {
                Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\*\shell\Goon Drop", false);
                Log("Goon Drop removed from top-level Windows right-click menu.");
            }
        }
        catch (Exception ex)
        {
            Log($"Could not update Registry shell extension: {ex.Message}");
        }
    }

    // Drag and Drop File Handlers (For Desktop Widget Dropping!)
    private void Form1_DragEnter(object? sender, DragEventArgs e)
    {
        if (e.Data != null && e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            e.Effect = DragDropEffects.Copy;
        }
    }

    private void Form1_DragDrop(object? sender, DragEventArgs e)
    {
        if (e.Data?.GetData(DataFormats.FileDrop) is string[] files && files.Length > 0)
        {
            SendFileNatively(files[0]);
        }
    }

    private async void SendFileNatively(string filePath)
    {
        if (File.Exists(filePath))
        {
            try
            {
                using var client = new System.Net.Http.HttpClient();
                // ⚠️ CRITICAL BUG FIX: Use JsonSerializer to handle path escaping flawlessly!
                var payload = new { filePath = filePath };
                var json = JsonSerializer.Serialize(payload);
                var content = new System.Net.Http.StringContent(json, Encoding.UTF8, "application/json");
                // ⚠️ CRITICAL NETWORKING FIX: Use serverUrl dynamically so that desktop widget drops never break when port self-heals!
                var response = await client.PostAsync($"{serverUrl}/api/internal/send-file", content);
                if (response.IsSuccessStatusCode)
                {
                    Log($"Direct Drag-Drop Shared file: {Path.GetFileName(filePath)}");
                    notifyIcon.ShowBalloonTip(3000, "Goon Drop Share", $"Beaming file: {Path.GetFileName(filePath)}", ToolTipIcon.Info);
                }
            }
            catch (Exception ex)
            {
                Log($"Drag-drop file send failed: {ex.Message}");
            }
        }
    }

    // Native Win32 Active Window, Process & UIAutomation Handoff integration!
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto, SetLastError = true)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool LockWorkStation();

    [System.Runtime.InteropServices.DllImport("powrprof.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool SetSuspendState(
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] bool hibernate,
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] bool forceCritical,
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] bool disableWakeEvent);

    // Native Win32 Mouse & Media Control integration!
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);

    private const int MOUSEEVENTF_MOVE = 0x0001;
    private const int MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const int MOUSEEVENTF_LEFTUP = 0x0004;
    private const int MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const int MOUSEEVENTF_RIGHTUP = 0x0010;

    private const byte VK_VOLUME_MUTE = 0xAD;
    private const byte VK_VOLUME_DOWN = 0xAE;
    private const byte VK_VOLUME_UP = 0xAF;
    private const byte VK_MEDIA_NEXT_TRACK = 0xB0;
    private const byte VK_MEDIA_PREV_TRACK = 0xB1;
    private const byte VK_MEDIA_PLAY_PAUSE = 0xB3;

    public void MoveMouse(int dx, int dy)
    {
        // Move mouse relatively
        mouse_event(MOUSEEVENTF_MOVE, dx, dy, 0, 0);
    }

    public void ClickMouse(string type)
    {
        if (type == "left")
        {
            mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
        }
        else if (type == "right")
        {
            mouse_event(MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
        }
    }

    public void SendMediaCommand(string command)
    {
        byte vk = 0;
        if (command == "volume_up") vk = VK_VOLUME_UP;
        else if (command == "volume_down") vk = VK_VOLUME_DOWN;
        else if (command == "volume_mute") vk = VK_VOLUME_MUTE;
        else if (command == "media_play") vk = VK_MEDIA_PLAY_PAUSE;
        else if (command == "media_next") vk = VK_MEDIA_NEXT_TRACK;
        else if (command == "media_prev") vk = VK_MEDIA_PREV_TRACK;

        if (vk != 0)
        {
            keybd_event(vk, 0, 0, 0); // Key Down
            keybd_event(vk, 0, 2, 0); // Key Up (0x0002 = KEYEVENTF_KEYUP)
        }
    }

    // Native Windows Clipboard & Hotkey Integration
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool AddClipboardFormatListener(IntPtr hwnd);

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, int fsModifiers, int vk);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int HOTKEY_ID = 9000;
    private bool isHandlingClipboard = false;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        AddClipboardFormatListener(this.Handle);
        RegisterHotKey(this.Handle, HOTKEY_ID, 0x0006, 0x47);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape && isWidgetMode)
        {
            ToggleWidgetMode();
            e.Handled = true;
            e.SuppressKeyPress = true;
        }
        base.OnKeyDown(e);
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        RemoveClipboardFormatListener(this.Handle);
        UnregisterHotKey(this.Handle, HOTKEY_ID);
        base.OnHandleDestroyed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x031D) // WM_CLIPBOARDUPDATE
        {
            HandleClipboardChange();
        }
        else if (m.Msg == 0x0312) // WM_HOTKEY
        {
            if (m.WParam.ToInt32() == HOTKEY_ID)
            {
                OpenBrowser(serverUrl);
            }
        }
        base.WndProc(ref m);
    }

    private async void HandleClipboardChange()
    {
        if (isHandlingClipboard) return;
        isHandlingClipboard = true;
        try 
        {
            await Task.Delay(150); // give other apps time to release clipboard lock
            if (Clipboard.ContainsText())
            {
                var text = Clipboard.GetText();
                if (text != lastClipboardText && !string.IsNullOrEmpty(text))
                {
                    lastClipboardText = text;
                    // Post to local API silently
                    using var client = new System.Net.Http.HttpClient();
                    var payload = new { text = text };
                    var json = JsonSerializer.Serialize(payload);
                    var content = new System.Net.Http.StringContent(json, Encoding.UTF8, "application/json");
                    // ⚠️ CRITICAL NETWORKING FIX: Use serverUrl dynamically so that clipboard sync never breaks when the port self-heals!
                    await client.PostAsync($"{serverUrl}/api/internal/clipboard", content);
                }
            }
        } catch { }
        isHandlingClipboard = false;
    }

    // Local HTTP server for zero-latency command interface (Mouse, Volume, Keyboard, and Hardware Telemetry!)
    private HttpListener? localListener;

    // Active Browser Tab Handoff Poller (New!)
    private System.Windows.Forms.Timer handoffTimer = null!;
    private string lastHandoffUrl = "";
    private bool handoffScanning = false;

    private void StartHandoffTimer()
    {
        handoffTimer = new System.Windows.Forms.Timer { Interval = 3000 };
        handoffTimer.Tick += HandoffTimer_Tick;
        handoffTimer.Start();
    }

    private async void HandoffTimer_Tick(object? sender, EventArgs e)
    {
        if (handoffScanning) return; // don't overlap ticks while a scan is in flight
        handoffScanning = true;
        try
        {
            if (!IsServerRunning) return;

            var hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return;

            GetWindowThreadProcessId(hwnd, out uint pid);
            if (pid == 0) return;

            string procName;
            try
            {
                using var proc = Process.GetProcessById((int)pid);
                // 🔒 FIX: accessing ProcessName internally calls HasExited and can throw
                // "No process is associated with this object" if the foreground app
                // (browser) exits between GetForegroundWindow and this read.
                procName = proc.ProcessName.ToLowerInvariant();
            }
            catch
            {
                return; // process exited mid-read or is otherwise unreachable — skip this tick
            }

            if (procName == "chrome" || procName == "msedge" || procName == "brave")
            {
                var sb = new StringBuilder(256);
                GetWindowText(hwnd, sb, 256);
                var title = sb.ToString();

                // Extract active tab URL in a non-blocking background task
                var url = await Task.Run(() => GetActiveBrowserUrl(hwnd, procName));

                if (!string.IsNullOrEmpty(url) && url.StartsWith("http") && url != lastHandoffUrl)
                {
                    lastHandoffUrl = url;
                    using var client = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(2) };
                    var payload = new {
                        url = url,
                        title = title.Replace(" - Google Chrome", "")
                                     .Replace(" - Microsoft Edge", "")
                                     .Replace(" - Brave", "")
                    };
                    var json = JsonSerializer.Serialize(payload);
                    var content = new System.Net.Http.StringContent(json, Encoding.UTF8, "application/json");
                    await client.PostAsync($"{serverUrl}/api/internal/handoff", content);
                }
            }
        }
        catch { /* Guard against any async void exception crash */ }
        finally
        {
            handoffScanning = false;
        }
    }

    private string GetActiveBrowserUrl(IntPtr hwnd, string processName)
    {
        try
        {
            // Use native Windows UIAutomation to read Chrome/Edge/Brave address bar dynamically!
            var element = System.Windows.Automation.AutomationElement.FromHandle(hwnd);
            if (element == null) return "";

            var edit = element.FindFirst(System.Windows.Automation.TreeScope.Descendants,
                new System.Windows.Automation.PropertyCondition(System.Windows.Automation.AutomationElement.ControlTypeProperty, System.Windows.Automation.ControlType.Edit));
            
            if (edit != null)
            {
                var pattern = edit.GetCurrentPattern(System.Windows.Automation.ValuePattern.Pattern) as System.Windows.Automation.ValuePattern;
                if (pattern != null)
                {
                    return pattern.Current.Value;
                }
            }
        }
        catch { }
        return "";
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
    private class MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
        public MEMORYSTATUSEX()
        {
            this.dwLength = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        }
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto, SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx([System.Runtime.InteropServices.In, System.Runtime.InteropServices.Out] MEMORYSTATUSEX lpBuffer);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool GetSystemTimes(out FILETIME lpIdleTime, out FILETIME lpKernelTime, out FILETIME lpUserTime);

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    private ulong lastIdleTime = 0;
    private ulong lastKernelTime = 0;
    private ulong lastUserTime = 0;

    private int GetCpuUsage()
    {
        try
        {
            // ⚠️ CRITICAL PERFORMANCE FIX: Use native Win32 GetSystemTimes to query true, overall laptop CPU load!
            // This is completely asynchronous, uses near-0% CPU, has 0ms blocking, and represents your true laptop performance.
            if (GetSystemTimes(out FILETIME idle, out FILETIME kernel, out FILETIME user))
            {
                ulong idleTime = ((ulong)idle.dwHighDateTime << 32) | idle.dwLowDateTime;
                ulong kernelTime = ((ulong)kernel.dwHighDateTime << 32) | kernel.dwLowDateTime;
                ulong userTime = ((ulong)user.dwHighDateTime << 32) | user.dwLowDateTime;

                if (lastIdleTime != 0)
                {
                    ulong diffIdle = idleTime - lastIdleTime;
                    ulong diffKernel = kernelTime - lastKernelTime;
                    ulong diffUser = userTime - lastUserTime;
                    ulong diffTotal = diffKernel + diffUser;

                    if (diffTotal > 0)
                    {
                        ulong activeTime = diffTotal - diffIdle;
                        int cpuUsage = (int)((activeTime * 100) / diffTotal);
                        
                        lastIdleTime = idleTime;
                        lastKernelTime = kernelTime;
                        lastUserTime = userTime;

                        return Math.Min(100, Math.Max(5, cpuUsage));
                    }
                }

                lastIdleTime = idleTime;
                lastKernelTime = kernelTime;
                lastUserTime = userTime;
            }
        }
        catch { }
        return 15; // Safe fallback
    }

    private int GetRamUsage()
    {
        try
        {
            var memStatus = new MEMORYSTATUSEX();
            if (GlobalMemoryStatusEx(memStatus))
            {
                return (int)memStatus.dwMemoryLoad;
            }
        }
        catch { }
        return 45;
    }

    private void StartLocalListener()
    {
        Task.Run(() => {
            try {
                localListener = new HttpListener();
                // ⚠️ CRITICAL NETWORKING FIX: Bind to 127.0.0.1 explicitly to bypass slow/buggy Windows DNS localhost queries!
                localListener.Prefixes.Add("http://127.0.0.1:3945/control/");
                localListener.Start();
                
                while (localListener.IsListening)
                {
                    var ctx = localListener.GetContext();
                    var req = ctx.Request;
                    var resp = ctx.Response;
                    
                    resp.Headers.Add("Access-Control-Allow-Origin", "*");
                    resp.Headers.Add("Access-Control-Allow-Headers", "Content-Type");
                    resp.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

                    if (req.HttpMethod == "OPTIONS")
                    {
                        resp.StatusCode = 200;
                        resp.Close();
                        continue;
                    }

                    if (req.Url!.PathAndQuery.Contains("/control/stats") && req.HttpMethod == "GET")
                    {
                        var stats = new {
                            cpu = GetCpuUsage(),
                            ram = GetRamUsage(),
                            battery = (int)(SystemInformation.PowerStatus.BatteryLifePercent * 100)
                        };
                        var json = JsonSerializer.Serialize(stats);
                        var buffer = Encoding.UTF8.GetBytes(json);
                        resp.ContentType = "application/json";
                        resp.ContentLength64 = buffer.Length;
                        resp.OutputStream.Write(buffer, 0, buffer.Length);
                    }
                    else if (req.Url!.PathAndQuery.Contains("/control/processes") && req.HttpMethod == "GET")
                    {
                        var procList = new System.Collections.Generic.List<object>();
                        foreach (var p in Process.GetProcesses())
                        {
                            try {
                                if (!string.IsNullOrEmpty(p.MainWindowTitle))
                                {
                                    procList.Add(new {
                                        id = p.Id,
                                        name = p.ProcessName,
                                        title = p.MainWindowTitle.Length > 40 ? p.MainWindowTitle.Substring(0, 38) + "..." : p.MainWindowTitle,
                                        memory = p.WorkingSet64 / 1024 / 1024
                                    });
                                }
                            } catch { }
                        }
                        var json = JsonSerializer.Serialize(procList);
                        var buffer = Encoding.UTF8.GetBytes(json);
                        resp.ContentType = "application/json";
                        resp.ContentLength64 = buffer.Length;
                        resp.OutputStream.Write(buffer, 0, buffer.Length);
                    }
                    else if (req.Url!.PathAndQuery.Contains("/control/prompt") && req.HttpMethod == "POST")
                    {
                        using var reader = new StreamReader(req.InputStream, req.ContentEncoding);
                        var body = reader.ReadToEnd();
                        var data = JsonSerializer.Deserialize<PromptPacket>(body);
                        if (data != null) {
                            HandleNotificationPrompt(data.title, data.message, data.actionType, data.payloadId);
                        }
                        resp.StatusCode = 200;
                        resp.Close();
                        continue;
                    }
                    else if (req.Url!.PathAndQuery.Contains("/control/kill") && req.HttpMethod == "POST")
                    {
                        using var reader = new StreamReader(req.InputStream, req.ContentEncoding);
                        var body = reader.ReadToEnd();
                        using var doc = JsonDocument.Parse(body);
                        if (doc.RootElement.TryGetProperty("id", out var idProp))
                        {
                            var pid = idProp.GetInt32();
                            var p = Process.GetProcessById(pid);
                            p.Kill();
                            Log($"Killed frozen application natively: {p.ProcessName} (PID: {pid})");
                        }
                    }
                    else if (req.HttpMethod == "POST")
                    {
                        using var reader = new StreamReader(req.InputStream, req.ContentEncoding);
                        var body = reader.ReadToEnd();
                        var data = JsonSerializer.Deserialize<ControlPacket>(body);
                        if (data != null)
                        {
                            // ⚠️ THREAD-SAFETY FIX: Prevent ObjectDisposedException on form closure
                            if (this.IsHandleCreated && !this.IsDisposed)
                            {
                                Invoke((Action)(() => {
                                    if (data.type == "mouse_move") {
                                        MoveMouse(data.dx, data.dy);
                                    } else if (data.type == "mouse_click") {
                                        ClickMouse(data.clickType);
                                    } else if (data.type == "media") {
                                        SendMediaCommand(data.command);
                                    } else if (data.type == "keyboard") {
                                        try {
                                            // ⚠️ CRITICAL INPUT FIX: Escape special SendKeys formatting characters natively!
                                            SendKeys.SendWait(EscapeSendKeysText(data.command));
                                        } catch { }
                                    } else if (data.type == "lock_pc") {
                                        LockWorkStation();
                                    } else if (data.type == "sleep_pc") {
                                        // ⚠️ CRITICAL POWER FIX: Call powrprof.dll directly to force a clean 1-second system sleep, bypassing BIOS hibernation overrides!
                                        SetSuspendState(false, true, false);
                                    } else if (data.type == "shutdown_pc") {
                                        try { Process.Start("shutdown.exe", "/s /t 3 /c \"Goon Drop: shutdown from your iPhone\""); } catch { }
                                    } else if (data.type == "restart_pc") {
                                        try { Process.Start("shutdown.exe", "/r /t 3 /c \"Goon Drop: restart from your iPhone\""); } catch { }
                                    } else if (data.type == "update_pc") {
                                        try { Process.Start("cmd.exe", "/c start ms-settings:windowsupdate-action"); } catch { }
                                    } else if (data.type == "ping_pc") {
                                        // 🔍 Find My PC — loud audible beeps + tray balloon so you can locate your machine!
                                        try {
                                            for (int beepIdx = 0; beepIdx < 3; beepIdx++) {
                                                Console.Beep(1300, 350);
                                                System.Threading.Thread.Sleep(220);
                                            }
                                            System.Media.SystemSounds.Exclamation.Play();
                                        } catch { }
                                        try { notifyIcon.ShowBalloonTip(5000, "Goon Drop — Find My PC", "I'm right here! 🗣️ Your iPhone is pinging this PC.", ToolTipIcon.Warning); } catch { }
                                    }
                                }));
                            }
                        }
                    }
                    
                    resp.StatusCode = 200;
                    resp.Close();
                }
            }
            catch (Exception ex)
            {
                // Log listener bind/loop failures instead of swallowing them silently.
                // A second launcher instance (or a leftover process) holding port 3945
                // used to crash silently at startup here.
                if (this.IsHandleCreated && !this.IsDisposed)
                {
                    try { Invoke(() => Log($"Local control listener stopped: {ex.Message}")); } catch { }
                }
            }
        });
    }

// Zero-latency native UDP Mouse and Click Receiver on port 3944! (Omega latency bypass)
      private System.Net.Sockets.UdpClient? udpMouseListener;

      private void StartUdpMouseListener()
      {
        Task.Run(() => {
          try {
            udpMouseListener = new System.Net.Sockets.UdpClient(3944);
            IPEndPoint remoteEP = new IPEndPoint(IPAddress.Any, 0);
            while (true) {
              byte[] data = udpMouseListener.Receive(ref remoteEP);
              string json = Encoding.UTF8.GetString(data);
              try {
                var packet = JsonSerializer.Deserialize<ControlPacket>(json);
                if (packet != null) {
                  Invoke(() => {
                    if (packet.type == "mouse_move") MoveMouse(packet.dx, packet.dy);
                    else if (packet.type == "mouse_click") ClickMouse(packet.clickType);
                  });
                }
              } catch { }
            }
          }
          catch (Exception ex)
          {
            if (this.IsHandleCreated && !this.IsDisposed)
            {
              try { Invoke(() => Log($"UDP mouse listener unavailable: {ex.Message}")); } catch { }
            }
          }
        });
      }

    private void StartClipboardPolling()
    {
      clipboardTimer = new System.Windows.Forms.Timer { Interval = 500 };
      clipboardTimer.Tick += (s, e) => {
        try {
          string currentText = Clipboard.GetText();
          if (!string.IsNullOrEmpty(currentText) && currentText != lastClipboardText) {
            lastClipboardText = currentText;
            using var client = new System.Net.Http.HttpClient();
            var payload = new { text = currentText };
            var content = new System.Net.Http.StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            client.PostAsync($"{serverUrl}/api/internal/clipboard", content).ConfigureAwait(false);
          }
        } catch { }
      };
      clipboardTimer.Start();
    }
    
    private string EscapeSendKeysText(string text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        if (text == "{BACKSPACE}" || text == "{ENTER}") return text; // Preserve our native control commands!

        // Escape special SendKeys formatting characters natively: +, ^, %, ~, (, ), {, }, [, ]
        var sb = new StringBuilder();
        foreach (char c in text)
        {
            if ("+^%~(){}[]".Contains(c))
            {
                sb.Append("{" + c + "}");
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.ToString();
    }

    private class UdpMousePacket
    {
        public string type { get; set; } = "";
        public int dx { get; set; }
        public int dy { get; set; }
        public string clickType { get; set; } = "";
    }

    private class ControlPacket
    {
        public string type { get; set; } = "";
        public int dx { get; set; }
        public int dy { get; set; }
        public string clickType { get; set; } = "";
        public string command { get; set; } = "";
    }

    private class PromptPacket
    {
        public string title { get; set; } = "";
        public string message { get; set; } = "";
        public string actionType { get; set; } = "";
        public string payloadId { get; set; } = "";
    }

    private void HandleNotificationPrompt(string title, string message, string actionType, string payloadId)
    {
        if (!this.IsHandleCreated || this.IsDisposed) return;
        
        this.Invoke((Action)(() => {
            DialogResult result = MessageBox.Show(
                $"{message}\n\nDo you want to {actionType} this?", 
                title, 
                MessageBoxButtons.YesNo, 
                MessageBoxIcon.Question
            );

            if (result == DialogResult.Yes) {
                Task.Run(async () => {
                    try {
                        using var client = new System.Net.Http.HttpClient();
                        var body = new { action = actionType, deviceId = "local-windows-pc", payloadId = payloadId };
                        var content = new System.Net.Http.StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
                        await client.PostAsync($"{serverUrl}/api/push/action", content);
                    } catch { }
                });
            }
        }));
    }

    private class QrResponse
    {
        public string pairingCode { get; set; } = "";
        public string pairingUrl { get; set; } = "";
        public string qrCode { get; set; } = "";
    }
}
