import SwiftUI

/// Home tab: saved PCs (with live status + reconnect), Wi-Fi discovery, and the
/// live device list when connected.
struct DevicesView: View {
    @ObservedObject private var client = GoonDropClient.shared
    @ObservedObject private var store = DeviceStore.shared
    @Binding var showSettings: Bool

    @State private var isScanning = false
    @State private var discovered: [DiscoveredServer] = []
    @State private var scanError: String?

    private let accent = Color(red: 0.0, green: 0.9, blue: 0.63)

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                if client.isConnected {
                    connectedCard
                    pairingCard
                    deviceList
                } else {
                    reconnectCard
                }

                myPCsSection
                discoveryCard
            }
            .padding()
        }
        .navigationTitle("Goon Drop")
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - My PCs

    private var myPCsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("My PCs")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(.secondary)
                Spacer()
                if !store.devices.isEmpty {
                    Button {
                        scan()
                    } label: {
                        Label(isScanning ? "Scanning…" : "Scan", systemImage: "magnifyingglass")
                            .font(.caption.weight(.medium))
                    }
                    .disabled(isScanning)
                }
            }

            if store.devices.isEmpty {
                Text("No saved PCs yet. Scan your Wi-Fi below to add one — after that Goon Drop reconnects on its own.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else {
                ForEach(store.devices) { device in
                    deviceRow(device)
                }
            }
        }
    }

    private func deviceRow(_ device: KnownDevice) -> some View {
        let state = linkState(for: device)
        return Button {
            client.connectToKnown(device)
        } label: {
            HStack(spacing: 12) {
                ZStack(alignment: .bottomTrailing) {
                    Image(systemName: "desktopcomputer")
                        .font(.title2)
                        .foregroundColor(accent)
                    Circle()
                        .fill(stateColor(state))
                        .frame(width: 10, height: 10)
                        .overlay(Circle().stroke(Color(.secondarySystemGroupedBackground), lineWidth: 1.5))
                }
                .frame(width: 34)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(device.name)
                            .font(.body.weight(.medium))
                            .foregroundColor(.primary)
                        if device.isDefault {
                            Text("Default")
                                .font(.system(size: 10, weight: .semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(accent.opacity(0.15))
                                .foregroundColor(accent)
                                .clipShape(Capsule())
                        }
                    }
                    Text("\(device.endpoint) · \(state.label)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("Last seen \(device.lastSeenText)")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }

                Spacer()

                if state == .connecting {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .contextMenu {
            if !device.isDefault {
                Button {
                    store.setDefault(id: device.id)
                } label: {
                    Label("Set as Default", systemImage: "star")
                }
            }
            Button(role: .destructive) {
                client.forgetDevice(device)
            } label: {
                Label("Forget", systemImage: "trash")
            }
        }
    }

    // MARK: - Reconnect banner

    @ViewBuilder
    private var reconnectCard: some View {
        if let target = store.defaultDevice {
            let state = linkState(for: target)
            VStack(spacing: 12) {
                HStack(spacing: 10) {
                    Circle()
                        .fill(stateColor(state))
                        .frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(state == .connecting ? "Reconnecting to \(target.name)…" : "\(target.name) is offline")
                            .font(.subheadline.weight(.semibold))
                        Text(target.endpoint)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    if state == .connecting {
                        ProgressView().controlSize(.small)
                    }
                }

                Button {
                    client.connectToKnown(target)
                } label: {
                    Label("Reconnect", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(accent)
            }
            .padding(16)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 16))
        }
    }

    // MARK: - Discovery

    private var discoveryCard: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(accent.opacity(0.15))
                    .frame(width: 90, height: 90)
                Image(systemName: "wifi")
                    .font(.system(size: 38, weight: .medium))
                    .foregroundColor(accent)
            }
            .padding(.top, 14)

            VStack(spacing: 6) {
                Text(store.devices.isEmpty ? "Find your PC on Wi-Fi" : "Find another PC")
                    .font(.title3.weight(.semibold))
                Text("Make sure the Goon Drop launcher is running on your PC and both are on the same network.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }

            Button {
                scan()
            } label: {
                HStack(spacing: 8) {
                    if isScanning {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "magnifyingglass")
                    }
                    Text(isScanning ? "Scanning…" : "Scan Wi-Fi Network")
                        .font(.headline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(accent)
            .disabled(isScanning)

            if !discovered.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Found \(discovered.count) PC(s)")
                        .font(.subheadline.weight(.semibold))
                    ForEach(discovered) { server in
                        Button {
                            client.applyAndConnect(server)
                            discovered = []
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "desktopcomputer")
                                    .font(.title3)
                                    .foregroundColor(accent)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(server.serverName)
                                        .font(.body.weight(.medium))
                                        .foregroundColor(.primary)
                                    Text("\(server.ip):\(server.port)")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            .padding(12)
                            .background(Color(.tertiarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }
                }
            }

            if let error = scanError {
                Text(error)
                    .font(.footnote)
                    .foregroundColor(.orange)
                    .multilineTextAlignment(.center)
            }

            Button("Manual server entry") {
                showSettings = true
            }
            .font(.subheadline)
        }
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18))
    }

    // MARK: - Connected cards

    private var connectedCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .font(.largeTitle)
                    .foregroundColor(accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(client.serverName.isEmpty ? "Windows PC" : client.serverName)
                        .font(.title3.weight(.semibold))
                    Text("Connected over local Wi-Fi")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18))
    }

    private var pairingCard: some View {
        HStack {
            Label("Pairing Code", systemImage: "key.horizontal.fill")
                .font(.subheadline.weight(.medium))
            Spacer()
            Text(client.pairingCode.isEmpty ? "—" : client.pairingCode)
                .font(.system(.title3, design: .monospaced).weight(.bold))
                .foregroundColor(accent)
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private var deviceList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Devices on your network")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.secondary)

            if client.devices.isEmpty {
                Text("No other devices connected right now.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 8)
            } else {
                ForEach(client.devices) { device in
                    HStack(spacing: 12) {
                        Image(systemName: deviceIcon(for: device))
                            .foregroundColor(device.connected ? accent : .secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.name)
                                .font(.body.weight(.medium))
                            Text(device.paired ? "Paired" : "Unpaired")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        Text(device.connected ? "Online" : "Offline")
                            .font(.caption)
                            .foregroundColor(device.connected ? .green : .secondary)
                    }
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    private func deviceIcon(for device: GoonDevice) -> String {
        let t = device.type.lowercased()
        if t.contains("iphone") || t.contains("ios") { return "iphone" }
        if t.contains("android") { return "smartphone" }
        if t.contains("windows") || t.contains("pc") { return "desktopcomputer" }
        return "questionmark.circle"
    }

    // MARK: - Helpers

    private func linkState(for device: KnownDevice) -> DeviceLinkState {
        let config = SharedConfig.shared
        if device.host == config.serverHost && device.port == config.serverPort {
            if client.isConnected { return .connected }
            if client.isPairing { return .connecting }
        }
        return .offline
    }

    private func stateColor(_ state: DeviceLinkState) -> Color {
        switch state {
        case .connected: return .green
        case .connecting: return .orange
        case .offline: return Color(.systemGray3)
        }
    }

    private func scan() {
        isScanning = true
        scanError = nil
        discovered = []
        Task {
            let results = await client.discoverServers()
            isScanning = false
            discovered = results
            if results.isEmpty {
                scanError = "No PC found. Check that Goon Drop is running on your PC and both devices are on the same Wi-Fi network."
            }
        }
    }
}
