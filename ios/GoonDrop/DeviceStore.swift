import Foundation
import Combine

/// Persists the PCs the user has paired with. Lives in the shared App Group so
/// the Share Sheet extension can show the same target list as the app.
final class DeviceStore: ObservableObject {
    static let shared = DeviceStore()

    @Published private(set) var devices: [KnownDevice] = []

    private let storageKey = "goondrop_known_devices"

    private var defaults: UserDefaults {
        UserDefaults(suiteName: SharedConfig.appGroupName) ?? .standard
    }

    private init() {
        load()
    }

    // MARK: - Queries

    var defaultDevice: KnownDevice? {
        devices.first(where: { $0.isDefault }) ?? devices.first
    }

    func device(id: String) -> KnownDevice? {
        devices.first(where: { $0.id == id })
    }

    func device(matchingHost host: String, port: Int) -> KnownDevice? {
        devices.first(where: { $0.host == host && $0.port == port })
    }

    // MARK: - Mutations

    @discardableResult
    func upsert(_ incoming: KnownDevice) -> KnownDevice {
        var device = incoming
        if let index = devices.firstIndex(where: { d in
            d.id == device.id || (d.host == device.host && d.port == device.port)
        }) {
            device.isDefault = devices[index].isDefault
            devices[index] = device
        } else {
            device.isDefault = devices.isEmpty
            devices.append(device)
        }
        persist()
        return device
    }

    func markSeen(id: String) {
        guard let index = devices.firstIndex(where: { $0.id == id }) else { return }
        devices[index].lastSeen = Int(Date().timeIntervalSince1970 * 1000)
        persist()
    }

    func remove(id: String) {
        let wasDefault = devices.first(where: { $0.id == id })?.isDefault ?? false
        devices.removeAll { $0.id == id }
        if wasDefault, let first = devices.first {
            setDefault(id: first.id)
        } else {
            persist()
        }
    }

    func setDefault(id: String) {
        for index in devices.indices {
            devices[index].isDefault = (devices[index].id == id)
        }
        persist()
    }

    func rename(id: String, to name: String) {
        guard let index = devices.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        devices[index].name = trimmed.isEmpty ? devices[index].name : trimmed
        persist()
    }

    // MARK: - Persistence

    private func load() {
        guard let data = defaults.data(forKey: storageKey),
              let decoded = try? JSONDecoder().decode([KnownDevice].self, from: data) else {
            devices = []
            return
        }
        devices = decoded
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(devices) else { return }
        defaults.set(data, forKey: storageKey)
    }
}
