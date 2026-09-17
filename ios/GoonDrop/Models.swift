import Foundation

/// A device (PC / phone) connected to the Goon Drop server.
struct GoonDevice: Identifiable {
    let id: String
    var name: String
    var type: String
    var connected: Bool
    var lastSeen: Int
    var paired: Bool

    var isSelf: Bool {
        type == "ios" || type.lowercased() == "iphone"
    }
}

/// A clipboard entry synced from any device on the network.
struct GoonClipboard: Identifiable, Equatable {
    let text: String
    let timestamp: Int
    let sourceDeviceName: String
    let kind: String
    var hash: String = ""
    var pinned: Bool = false

    var id: String { "\(timestamp)-\(text.prefix(12))" }
}

/// A handoff link pushed between devices / the PC browser.
struct GoonLink: Identifiable, Equatable {
    let url: String
    let title: String
    let timestamp: Int
    let sourceDeviceName: String

    var id: String { url }
}

/// A Goon Drop server (Windows PC) discovered on the local Wi-Fi network.
struct DiscoveredServer: Codable, Identifiable, Equatable {
    let ip: String
    let port: Int
    let pairingCode: String
    let serverName: String

    var id: String { "\(ip):\(port)" }
}