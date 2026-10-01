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

/// Ground truth about the PC's media session, read by the Windows launcher and
/// relayed over the WebSocket. This is what lets the play/pause button show the
/// right icon and the now-playing card show a real track instead of a guess.
struct GoonMediaState: Equatable {
    var available: Bool = false
    var playing: Bool = false
    var title: String = ""
    var appName: String = ""
    /// 0...1, or -1 when the endpoint could not be read.
    var volume: Double = -1
    var volumeMuted: Bool = false
    var micMuted: Bool = false
    var micVolume: Double = -1
    var updatedAt: Int = 0

    /// Nothing recognisable is loaded, so the UI should not claim a track.
    var hasTrack: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static let unknown = GoonMediaState()
}

/// A message in the LAN-wide encrypted chat room.
struct GoonChatMessage: Identifiable, Equatable {
    let text: String
    let timestamp: Int
    let sourceDeviceId: String
    let sourceDeviceName: String

    var id: String { "\(timestamp)-\(sourceDeviceId)-\(text.prefix(8))" }

    /// Whether this message was sent from this phone, given the id the server
    /// assigned us at pairing time.
    func isMine(deviceId: String) -> Bool {
        !deviceId.isEmpty && sourceDeviceId == deviceId
    }
}

/// A quick text note pushed to every other paired device.
struct GoonNote: Identifiable, Equatable {
    let text: String
    let timestamp: Int
    let sourceDeviceName: String

    var id: String { "\(timestamp)-\(text.prefix(12))" }
}

/// One item on the shared to-do checklist.
struct GoonChecklistItem: Identifiable, Equatable {
    var id: String
    var text: String
    var done: Bool

    init(id: String = UUID().uuidString, text: String, done: Bool = false) {
        self.id = id
        self.text = text
        self.done = done
    }

    /// The web client sends checklist rows as loosely-typed objects, so accept
    /// either a real id or derive a stable one from the text.
    init?(dictionary: [String: Any]) {
        let text = dictionary["text"] as? String ?? dictionary["title"] as? String ?? ""
        guard !text.isEmpty else { return nil }
        self.text = text
        self.done = dictionary["done"] as? Bool ?? dictionary["completed"] as? Bool ?? false
        self.id = dictionary["id"] as? String ?? text
    }
}

