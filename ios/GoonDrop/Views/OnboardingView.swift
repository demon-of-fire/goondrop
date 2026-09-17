import SwiftUI

/// First-run wizard: find the PC on Wi-Fi, pair, and explain the Share Sheet.
struct OnboardingView: View {
    @ObservedObject private var client = GoonDropClient.shared
    @ObservedObject private var config = SharedConfig.shared
    @Environment(\.dismiss) private var dismiss

    @State private var step = 0
    @State private var isScanning = false
    @State private var discovered: [DiscoveredServer] = []
    @State private var message: String?
    @State private var manualHost = ""
    @State private var manualPort = "3942"
    @State private var manualCode = ""

    private let accent = Color(red: 0.0, green: 0.9, blue: 0.63)

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer(minLength: 12)

                switch step {
                case 0: welcomeStep
                case 1: scanStep
                default: doneStep
                }

                Spacer()

                HStack {
                    if step > 0 {
                        Button("Back") { step -= 1 }
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    if step < 2 {
                        Button {
                            step += 1
                        } label: {
                            Text(step == 0 ? "Get started" : "Skip")
                                .fontWeight(.semibold)
                                .padding(.horizontal, 22)
                                .padding(.vertical, 12)
                                .background(accent)
                                .foregroundColor(.black)
                                .clipShape(Capsule())
                        }
                    } else {
                        Button {
                            finish()
                        } label: {
                            Text("Done")
                                .fontWeight(.semibold)
                                .padding(.horizontal, 22)
                                .padding(.vertical, 12)
                                .background(accent)
                                .foregroundColor(.black)
                                .clipShape(Capsule())
                        }
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Skip") { finish() }
                        .foregroundColor(.secondary)
                }
            }
        }
    }

    // MARK: - Steps

    private var welcomeStep: some View {
        VStack(spacing: 18) {
            Image(systemName: "iphone.gen3.radiowaves.left.and.right")
                .font(.system(size: 56))
                .foregroundColor(accent)
            Text("Goon Drop")
                .font(.largeTitle.bold())
            Text("Send photos, files, links and clipboard between your iPhone and your PC — over your own Wi-Fi, with no cloud in the middle.")
                .font(.callout)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
    }

    private var scanStep: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.router")
                .font(.system(size: 44))
                .foregroundColor(accent)
            Text("Find your PC")
                .font(.title2.bold())
            Text("Make sure the Goon Drop app is running on your PC and both devices are on the same Wi-Fi.")
                .font(.callout)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)

            Button {
                scan()
            } label: {
                HStack(spacing: 8) {
                    if isScanning { ProgressView().controlSize(.small) }
                    Text(isScanning ? "Scanning…" : "Scan Wi-Fi")
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .tint(accent)
            .disabled(isScanning)

            if !discovered.isEmpty {
                VStack(spacing: 8) {
                    ForEach(discovered) { server in
                        Button {
                            client.applyAndConnect(server)
                            message = "Connecting to \(server.serverName)…"
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { step = 2 }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "desktopcomputer").foregroundColor(accent)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(server.serverName).foregroundColor(.primary)
                                    Text("\(server.ip):\(server.port)")
                                        .font(.caption).foregroundColor(.secondary)
                                }
                                Spacer()
                            }
                            .padding(12)
                            .background(Color.secondary.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }
                }
                .padding(.horizontal, 24)
            }

            if let message = message {
                Text(message).font(.footnote).foregroundColor(.secondary)
            }

            DisclosureGroup("Enter details manually") {
                VStack(spacing: 8) {
                    TextField("PC IP (192.168.0.82)", text: $manualHost)
                        .keyboardType(.numbersAndPunctuation)
                        .autocapitalization(.none)
                    TextField("Pairing code (optional)", text: $manualCode)
                    Button("Connect") {
                        config.serverHost = manualHost.trimmingCharacters(in: .whitespaces)
                        if let p = Int(manualPort) { config.serverPort = p }
                        config.pairingCode = manualCode.trimmingCharacters(in: .whitespaces)
                        config.isConfigured = !config.serverHost.isEmpty
                        client.connect()
                        step = 2
                    }
                    .buttonStyle(.bordered)
                }
                .padding(.top, 6)
            }
            .font(.footnote)
            .padding(.horizontal, 24)
        }
    }

    private var doneStep: some View {
        VStack(spacing: 18) {
            Image(systemName: client.isConnected ? "checkmark.circle.fill" : "hourglass")
                .font(.system(size: 56))
                .foregroundColor(client.isConnected ? .green : .orange)
            Text(client.isConnected ? "You're connected" : "Almost there")
                .font(.title2.bold())
            Text(client.isConnected
                 ? "Your PC is paired. From now on it reconnects by itself when you're on this Wi-Fi."
                 : "Pairing may take a moment. You can check the Devices tab if it doesn't connect.")
                .font(.callout)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)

            VStack(alignment: .leading, spacing: 10) {
                Label("Share sheet: share from any app to send to your PC", systemImage: "square.and.arrow.up")
                Label("Clipboard: sync text both ways", systemImage: "doc.on.clipboard")
                Label("Handoff: open links on your PC browser", systemImage: "link")
            }
            .font(.footnote)
            .padding(.horizontal, 28)
        }
    }

    // MARK: - Actions

    private func scan() {
        isScanning = true
        message = nil
        discovered = []
        Task {
            let results = await client.discoverServers()
            isScanning = false
            discovered = results
            if results.isEmpty {
                message = "No PC found. Check the launcher is running, then try again."
            }
        }
    }

    private func finish() {
        if !config.isConfigured && config.serverHost.isEmpty {
            // Nothing chosen yet — leave discovery to the app.
        }
        dismiss()
    }
}

#Preview {
    OnboardingView()
}
