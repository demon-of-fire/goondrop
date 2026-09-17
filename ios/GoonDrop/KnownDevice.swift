import Foundation

/// Connection state for a remembered PC.
enum DeviceLinkState: Equatable {
    case connected
    case connecting
    case offline

    var label: String {
        switch self {
        case .connected: return "Connected"
        case .connecting: return "Connecting…"
        case .offline: return "Offline"
        }
    }
}

/// A PC the user has paired with, remembered across launches so Goon Drop can
/// reconnect automatically (and the Share Sheet can show a target instantly).
struct KnownDevice: Codable, Identifiable, Equatable {
    /// Persistent id assigned by the server (survives reconnects).
    var id: String
    var name: String
    var host: String
    var port: Int
    var pairingCode: String
    var useHttps: Bool
    var token: String
    var certFingerprint: String?
    var lastSeen: Int
    var isDefault: Bool

    var endpoint: String { "\(host):\(port)" }

    var lastSeenText: String {
        guard lastSeen > 0 else { return "never" }
        let date = Date(timeIntervalSince1970: TimeInterval(lastSeen) / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
