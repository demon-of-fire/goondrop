import SwiftUI

/// Home tab: Wi-Fi discovery when disconnected, live device list when connected.
struct DevicesView: View {
    @ObservedObject private var client = GoonDropClient.shared
    @Binding var showSettings: Bool

    @State private var isScanning = false
    @State private var discovered: [DiscoveredServer] = []
    @State private var scanError: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                if client.isConnected {
                    connectedCard
                    pairingCard
                    deviceList
                } else {
                    discoveryCard
                }
            }
            .padding()
        }
        .navigationTitle("Goon Drop")
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Discovery

    private var discoveryCard: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(Color(red: 0.0, green: 0.9, blue: 0.63).opacity(0.15))
                    .frame(width: 110, height: 110)
                Image(systemName: "wifi")
                    .font(.system(size: 46, weight: .medium))
                    .foregroundColor(Color(red: 0.0, green: 0.9, blue: 0.63))
            }
            .padding(.top, 18)

            VStack(spacing: 6) {
                Text("Find your PC on Wi-Fi")
                    .font(.title3.weight(.semibold))
                Text("Make sure the Goon Drop launcher is running on your PC and both are on the same network. No website, no QR code.")
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
            .tint(Color(red: 0.0, green: 0.9, blue: 0.63))
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
                                    .foregroundColor(Color(red: 0.0, green: 0.9, blue: 0.63))
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
                            .background(Color(.secondarySystemGroupedBackground))
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
                    .foregroundColor(Color(red: 0.0, green: 0.9, blue: 0.63))
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
                .foregroundColor(Color(red: 0.0, green: 0.9, blue: 0.63))
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
                            .foregroundColor(device.connected ? Color(red: 0.0, green: 0.9, blue: 0.63) : .secondary)
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

    // MARK: - Actions

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