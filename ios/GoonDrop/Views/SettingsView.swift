import SwiftUI

/// Settings: Wi-Fi server discovery + manual connection details.
struct SettingsView: View {
    @ObservedObject private var config = SharedConfig.shared
    @ObservedObject private var client = GoonDropClient.shared
    @Environment(\.dismiss) private var dismiss

    @State private var host = ""
    @State private var port = ""
    @State private var code = ""
    @State private var useHttps = true
    @State private var isScanning = false
    @State private var discovered: [DiscoveredServer] = []
    @State private var scanMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        scan()
                    } label: {
                        HStack(spacing: 8) {
                            if isScanning {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "wifi.router")
                            }
                            Text(isScanning ? "Scanning Wi-Fi…" : "Find my PC on Wi-Fi")
                                .font(.headline)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(isScanning)

                    if !discovered.isEmpty {
                        ForEach(discovered) { server in
                            Button {
                                client.applyAndConnect(server)
                                scanMessage = "Connected to \(server.serverName)"
                                discovered = []
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "desktopcomputer")
                                        .foregroundColor(Color(red: 0.0, green: 0.9, blue: 0.63))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(server.serverName)
                                            .foregroundColor(.primary)
                                        Text("\(server.ip):\(server.port)")
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                    }
                                    Spacer()
                                    if !server.pairingCode.isEmpty {
                                        Text(server.pairingCode)
                                            .font(.caption.monospaced())
                                            .foregroundColor(.secondary)
                                    }
                                }
                            }
                        }
                    }

                    if let message = scanMessage {
                        Text(message)
                            .font(.footnote)
                            .foregroundColor(.secondary)
                    }
                } header: {
                    Text("Auto-discovery")
                } footer: {
                    Text("The PC launcher broadcasts itself on UDP 3943. Make sure both devices are on the same Wi-Fi network and the launcher is running.")
                }

                Section("Manual server") {
                    HStack {
                        Text("PC IP address")
                        Spacer()
                        TextField("192.168.1.100", text: $host)
                            .multilineTextAlignment(.trailing)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .keyboardType(.numbersAndPunctuation)
                    }
                    HStack {
                        Text("Port")
                        Spacer()
                        TextField("3942", text: $port)
                            .multilineTextAlignment(.trailing)
                            .keyboardType(.numberPad)
                    }
                    HStack {
                        Text("Pairing code")
                        Spacer()
                        TextField("Optional", text: $code)
                            .multilineTextAlignment(.trailing)
                            .autocapitalization(.allCharacters)
                    }
                    Toggle("Use HTTPS", isOn: $useHttps)

                    Button("Save & Connect") {
                        save()
                    }
                    .font(.headline)
                }

                Section("Share Sheet") {
                    Text("Your photos, files, links and text shared from any app go straight to this PC (\(config.serverHost):\(config.serverPort)).")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.medium)
                }
            }
            .onAppear {
                host = config.serverHost
                port = String(config.serverPort)
                useHttps = config.useHttps
                code = config.pairingCode
            }
        }
    }

    private func scan() {
        isScanning = true
        scanMessage = nil
        discovered = []
        Task {
            let results = await client.discoverServers()
            isScanning = false
            discovered = results
            if results.isEmpty {
                scanMessage = "No PC found. Check that Goon Drop is running on your PC and both are on the same Wi-Fi."
            }
        }
    }

    private func save() {
        if !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            config.serverHost = host
            config.isConfigured = true
        }
        if let p = Int(port.trimmingCharacters(in: .whitespaces)), p > 0 {
            config.serverPort = p
        }
        config.useHttps = useHttps
        config.pairingCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        client.connect()
        dismiss()
    }
}

#Preview {
    SettingsView()
}