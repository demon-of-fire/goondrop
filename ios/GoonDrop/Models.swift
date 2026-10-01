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

/// A file offered to or received by this iPhone from the paired Windows PC.
struct IncomingFile: Identifiable, Equatable {
    let id: String
    let fileName: String
    let fileSize: Int64
    let mimeType: String
    let sourceDeviceName: String
    var status: Status
    var downloadURL: URL?
    var localURL: URL?
    var errorMessage: String?

    enum Status: String, Equatable {
        case offered
        case waitingForFile
        case downloading
        case ready
        case declined
        case failed
    }
}

/// A Goon Drop server (Windows PC) discovered on the local Wi-Fi network.
struct DiscoveredServer: Codable, Identifiable, Equatable {
    let ip: String
    let port: Int
    let pairingCode: String
    let serverName: String

    var id: String { "\(ip):\(port)" }
}
