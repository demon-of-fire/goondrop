import SwiftUI
import Foundation

/// Diagnostics: what the app is connected to, the trust-on-first-use certificate
/// fingerprint, and a one-tap health check for the LAN server.
struct DiagnosticsView: View {
    @ObservedObject private var client = GoonDropClient.shared
    @ObservedObject private var config = SharedConfig.shared

    @State private var results: [DiagnosticResult] = []
    @State private var isRunning = false

    private struct DiagnosticResult: Identifiable {
        let id = UUID()
        let title: String
        let ok: Bool
        let detail: String
    }

    private var scheme: String { config.useHttps ? "https" : "http" }
    private var transport: String { config.useHttps ? "wss" : "ws" }
    private var endpoint: String { "\(config.serverHost):\(config.serverPort)" }
    private var fingerprint: String? {
        ServerCertStore.knownFingerprint(host: config.serverHost, port: config.serverPort)
    }

    var body: some View {
        Form {
            Section("Connection") {
                row("State", client.isConnected ? "Connected" : (client.isPairing ? "Pairing…" : "Disconnected"),
                    ok: client.isConnected)
                row("PC", client.serverName.isEmpty ? config.serverName : client.serverName,
                    ok: !client.serverName.isEmpty)
                row("Endpoint", "\(scheme)://\(endpoint)", ok: config.isConfigured)
                row("Transport", transport.uppercased(), ok: true)
                if let device = DeviceStore.shared.defaultDevice {
                    row("Device ID", device.id, ok: true)
                    row("Token", device.token.isEmpty ? "none" : "stored", ok: !device.token.isEmpty)
                }
                if let error = client.lastError, !error.isEmpty {
                    row("Last error", error, ok: false)
                }
            }

            Section {
                if let fingerprint = fingerprint {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Certificate fingerprint")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Text(fingerprint)
                            .font(.system(.caption2, design: .monospaced))
                            .lineLimit(3)
                            .textSelection(.enabled)
                    }
                } else {
                    Text("No certificate recorded yet. Connect once over HTTPS to pin it.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            } header: {
                Text("Trust")
            } footer: {
                Text("Goon Drop remembers the first certificate it saw for this PC. If the PC regenerates its certificate, reconnect once to re-trust it.")
            }

            Section {
                Button {
                    runChecks()
                } label: {
                    HStack(spacing: 8) {
                        if isRunning { ProgressView().controlSize(.small) }
                        Label(isRunning ? "Running…" : "Run connectivity checks", systemImage: "stethoscope")
                    }
                }
                .disabled(isRunning || !config.isConfigured)

                ForEach(results) { result in
                    HStack(spacing: 10) {
                        Image(systemName: result.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundColor(result.ok ? .green : .red)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(result.title).font(.system(size: 14, weight: .medium))
                            Text(result.detail)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            } header: {
                Text("Checks")
            }
        }
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ title: String, _ value: String, ok: Bool) -> some View {
        HStack(alignment: .top) {
            Text(title)
            Spacer()
            Text(value)
                .foregroundColor(ok ? .secondary : .orange)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }

    private func runChecks() {
        isRunning = true
        results = []
        Task {
            var collected: [DiagnosticResult] = []

            let health = await probe(SharedConfig.shared.apiHealthURL)
            collected.append(.init(title: "Server reachable",
                                   ok: health.ok,
                                   detail: health.detail))

            if let qrURL = URL(string: "\(config.useHttps ? "https" : "http")://\(endpoint)/api/qrcode") {
                let qr = await probe(qrURL)
                collected.append(.init(title: "Pairing endpoint",
                                       ok: qr.ok, detail: qr.detail))
            }

            if let clipURL = SharedConfig.shared.apiClipboardURL {
                let clip = await probe(clipURL)
                collected.append(.init(title: "Clipboard endpoint",
                                       ok: clip.ok, detail: clip.detail))
            }

            collected.append(.init(title: "WebSocket",
                                   ok: client.isConnected,
                                   detail: client.isConnected ? "Handshake complete on port \(config.serverPort)"
                                                              : "Not connected"))

            await MainActor.run {
                results = collected
                isRunning = false
            }
        }
    }

    private func probe(_ url: URL?) async -> (ok: Bool, detail: String) {
        guard let url = url else { return (false, "No URL") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        if !config.pairingCode.isEmpty { request.setValue(config.pairingCode, forHTTPHeaderField: "x-goondrop-code") }
        do {
            let (_, response) = try await SharedConfig.makeLANSession().data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            return ((200...299).contains(code), "HTTP \(code)")
        } catch {
            return (false, error.localizedDescription)
        }
    }
}

#Preview {
    NavigationStack { DiagnosticsView() }
}
