import SwiftUI

struct ContentView: View {
    @ObservedObject private var client = GoonDropClient.shared
    @ObservedObject private var config = SharedConfig.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSettings = false
    @State private var showOnboarding = false
    @State private var selectedTab = 0

    private let accent = Color(red: 0.0, green: 0.9, blue: 0.63)

    var body: some View {
        NavigationStack {
            TabView(selection: $selectedTab) {
                DevicesView(showSettings: $showSettings)
                    .tabItem { Label("Devices", systemImage: "iphone.radiowaves.left.and.right") }
                    .tag(0)

                SendView()
                    .tabItem { Label("Send", systemImage: "paperplane.fill") }
                    .tag(1)

                ClipboardView()
                    .tabItem { Label("Clipboard", systemImage: "doc.on.clipboard") }
                    .tag(2)

                HandoffView()
                    .tabItem { Label("Handoff", systemImage: "link") }
                    .tag(3)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                ConnectionHeader()
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 15, weight: .medium))
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
        }
        .tint(accent)
        .fullScreenCover(isPresented: $showOnboarding) {
            OnboardingView()
        }
        .onAppear {
            NotificationHelper.requestAuthorizationIfNeeded()
            if config.isConfigured && !client.isPairing && !client.isConnected {
                client.connect()
            }
            if !config.isConfigured {
                showOnboarding = true
            }
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                client.reconnectIfPossible()
            }
        }
    }
}

struct ConnectionHeader: View {
    @ObservedObject private var client = GoonDropClient.shared
    @ObservedObject private var config = SharedConfig.shared

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(client.isConnected ? Color.green : (client.isPairing ? Color.orange : Color.red))
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 1) {
                Text(statusText)
                    .font(.system(size: 13, weight: .semibold))
                Text(subText)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            if client.isPairing {
                ProgressView().controlSize(.small)
            } else if client.isConnected {
                Button {
                    client.disconnect()
                } label: {
                    Text("Disconnect")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)
            } else {
                Button("Scan") {
                    Task {
                        let found = await GoonDropClient.shared.discoverServers()
                        if let first = found.first {
                            GoonDropClient.shared.applyAndConnect(first)
                        }
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var statusText: String {
        if client.isConnected { return "Connected to \(client.serverName.isEmpty ? "PC" : client.serverName)" }
        if client.isPairing { return "Connecting…" }
        return "Not connected"
    }

    private var subText: String {
        if client.isPairing { return client.statusMessage ?? "\(config.serverHost):\(config.serverPort)" }
        if client.isConnected { return "\(config.serverHost):\(config.serverPort)" }
        return client.lastError ?? "Tap Scan to find your PC on Wi-Fi"
    }
}