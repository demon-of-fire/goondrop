import Foundation
import UIKit
import Combine
import Network

/// Native WebSocket + pairing client for the Goon Drop PC server.
///
/// Handles the full lifecycle: connect (WSS over the local self-signed cert),
/// pair with the discovered/manual pairing code, keep the device list live,
/// sync the shared clipboard, and relay handoff links.
@MainActor
final class GoonDropClient: NSObject, ObservableObject {

    static let shared = GoonDropClient()

    @Published var isConnected = false
    @Published var isPairing = false
    @Published var serverName = ""
    @Published var pairingCode = ""
    @Published var devices: [GoonDevice] = []
    @Published var clipboardItems: [GoonClipboard] = []
    @Published var links: [GoonLink] = []
    @Published var statusMessage: String?
    @Published var lastError: String?

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var handshakeClientId: String?
    private var handshakeToken: String?
    private var pairFallback: DispatchWorkItem?
    private var pathMonitor: NWPathMonitor?
    private var didStartAutoReconnect = false

    override init() {
        super.init()
        startAutoReconnect()
    }

    // MARK: - Connection lifecycle

    func connect() {
        let config = SharedConfig.shared
        guard let url = config.wsURL else {
            lastError = "Invalid server address."
            return
        }
        connect(to: url, pairingCode: config.pairingCode)
    }

    func connect(to url: URL, pairingCode code: String) {
        disconnect()

        Self.flashPasteboard()

        self.pairingCode = code
        SharedConfig.shared.pairingCode = code

        let urlConfig = URLSessionConfiguration.default
        urlConfig.timeoutIntervalForRequest = 15
        // LANTrustSessionDelegate accepts the Goon Drop self-signed certificate.
        let session = URLSession(configuration: urlConfig, delegate: LANTrustSessionDelegate(), delegateQueue: .main)
        self.session = session

        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()

        isPairing = true
        isConnected = false
        lastError = nil
        statusMessage = "Connecting to \(url.host ?? "")…"

        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
            return
        }

        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                self?.sendHeartbeat()
            }
        }
    }

    func disconnect() {
        receiveTask?.cancel()
        heartbeatTask?.cancel()
        pairFallback?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session = nil
        isPairing = false
        isConnected = false
        devices = []
    }

    // MARK: - Remembered devices & auto-reconnect

    /// Watch the network and re-establish the connection whenever Wi-Fi returns
    /// or the app comes back to the foreground.
    func startAutoReconnect() {
        guard !didStartAutoReconnect else { return }
        didStartAutoReconnect = true
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            DispatchQueue.main.async { self?.reconnectIfPossible() }
        }
        monitor.start(queue: DispatchQueue(label: "com.goondrop.path"))
        pathMonitor = monitor
    }

    func reconnectIfPossible() {
        guard SharedConfig.shared.isConfigured else { return }
        guard !isConnected, !isPairing else { return }
        connect()
    }

    func connectToKnown(_ device: KnownDevice) {
        let config = SharedConfig.shared
        config.serverHost = device.host
        config.serverPort = device.port
        config.useHttps = device.useHttps
        config.pairingCode = device.pairingCode
        config.serverName = device.name
        config.isConfigured = true
        connect()
    }

    func forgetDevice(_ device: KnownDevice) {
        DeviceStore.shared.remove(id: device.id)
        let config = SharedConfig.shared
        if config.serverHost == device.host && config.serverPort == device.port {
            disconnect()
        }
    }

    private func receiveLoop() async {
        guard let task = task else { return }
        while task.state == .running {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    handleRawMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        handleRawMessage(text)
                    }
                @unknown default:
                    break
                }
            } catch {
                break
            }
        }
        isPairing = false
        isConnected = false
        statusMessage = "Disconnected from PC"
    }

    // MARK: - Wi-Fi discovery

    func discoverServers() async -> [DiscoveredServer] {
        await Task.detached(priority: .userInitiated) { () -> [DiscoveredServer] in
            LANDiscovery.discover(timeout: 2.5)
        }.value
    }

    func applyAndConnect(_ server: DiscoveredServer) {
        let config = SharedConfig.shared
        config.serverHost = server.ip
        config.serverPort = server.port
        config.useHttps = true
        config.pairingCode = server.pairingCode
        config.serverName = server.serverName
        config.isConfigured = true
        DeviceStore.shared.upsert(KnownDevice(
            id: "\(server.ip):\(server.port)",
            name: server.serverName,
            host: server.ip,
            port: server.port,
            pairingCode: server.pairingCode,
            useHttps: true,
            token: "",
            certFingerprint: nil,
            lastSeen: Int(Date().timeIntervalSince1970 * 1000),
            isDefault: false
        ))
        connect()
    }

    // MARK: - User actions

    func pushClipboard(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if isConnected {
            sendJSON(envelope("clipboard_push", ["text": trimmed]))
            statusMessage = "Sent to PC clipboard"
        } else {
            postClipboard(trimmed)
        }
    }

    func requestClipboard() {
        sendJSON(envelope("clipboard_request", [:]))
    }

    func clearClipboardHistory() {
        sendJSON(envelope("clipboard_clear", [:]))
        clipboardItems = []
        statusMessage = "Clipboard history cleared"
    }

    /// Pin/unpin a clipboard entry so it survives auto-trimming on the PC.
    func pinClipboard(_ item: GoonClipboard, pinned: Bool) {
        if let index = clipboardItems.firstIndex(where: { $0.id == item.id }) {
            clipboardItems[index].pinned = pinned
        }
        if !item.hash.isEmpty {
            sendJSON(envelope("clipboard_pin", ["hash": item.hash, "pinned": pinned]))
        }
        statusMessage = pinned ? "Pinned" : "Unpinned"
    }

    /// Put a past entry back onto the PC clipboard.
    func restoreClipboardToPC(_ item: GoonClipboard) {
        guard !item.hash.isEmpty, let url = SharedConfig.shared.apiClipboardRestoreURL else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let code = SharedConfig.shared.pairingCode
        if !code.isEmpty { request.setValue(code, forHTTPHeaderField: "x-goondrop-code") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["hash": item.hash])
        SharedConfig.makeLANSession().dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.statusMessage = "Copied to PC clipboard" }
        }.resume()
    }

    func sendLink(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("http") else {
            lastError = "Enter a full URL (http:// or https://)"
            return
        }
        if isConnected {
            sendJSON(envelope("link_send", ["url": trimmed, "title": trimmed]))
            statusMessage = "Opened on PC browser"
        } else {
            postLink(trimmed)
        }
    }

    /// Multipart upload to the PC's drop zone.
    func dropFile(data: Data, fileName: String, mimeType: String, completion: @escaping (Bool) -> Void) {
        guard let url = SharedConfig.shared.apiDropURL else {
            completion(false)
            return
        }
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let code = SharedConfig.shared.pairingCode
        if !code.isEmpty {
            request.setValue(code, forHTTPHeaderField: "x-goondrop-code")
        }

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        let session = SharedConfig.makeLANSession()
        let upload = session.uploadTask(with: request, from: body) { _, response, _ in
            let ok = (response as? HTTPURLResponse).map { (200...299).contains($0.statusCode) } ?? false
            DispatchQueue.main.async { completion(ok) }
        }
        upload.resume()
    }

    // MARK: - Message dispatch

    private func handleRawMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = obj["type"] as? String
        else { return }
        let payload = obj["payload"]

        switch type {
        case "handshake":
            if let p = payload as? [String: Any] {
                if let name = p["serverName"] as? String, !name.isEmpty { serverName = name }
                if let code = p["pairingCode"] as? String, !code.isEmpty { pairingCode = code }
                if let clientId = p["clientId"] as? String { handshakeClientId = clientId }
                if let token = p["token"] as? String { handshakeToken = token }
            }
            attemptPairing()

        case "paired":
            isPairing = false
            isConnected = true
            statusMessage = "Connected"
            pairFallback?.cancel()
            if let p = payload as? [String: Any] {
                if let name = p["serverName"] as? String, !name.isEmpty { serverName = name }
                if let devs = p["devices"] as? [[String: Any]] { devices = parseDevices(devs) }
                rememberCurrentDevice(from: p)
            }
            requestClipboard()

        case "init_state":
            if let p = payload as? [String: Any] {
                if let clips = p["clipboardHistory"] as? [[String: Any]] {
                    clipboardItems = parseClips(clips)
                }
                if let links = p["links"] as? [[String: Any]] {
                    self.links = parseLinks(links)
                }
            }

        case "device_list":
            if let devs = payload as? [[String: Any]] { devices = parseDevices(devs) }

        case "device_online", "device_offline":
            if let p = payload as? [String: Any], let id = p["deviceId"] as? String {
                let online = (p["online"] as? Bool) ?? (type == "device_online")
                if let index = devices.firstIndex(where: { $0.id == id }) {
                    devices[index].connected = online
                    devices[index].lastSeen = Int(Date().timeIntervalSince1970 * 1000)
                }
                if online { DeviceStore.shared.markSeen(id: id) }
            }

        case "clipboard_push":
            if let p = payload as? [String: Any], let text = p["text"] as? String {
                prependClip(from: p, text: text)
            }

        case "clipboard_history":
            if let clips = payload as? [[String: Any]] { clipboardItems = parseClips(clips) }

        case "clipboard_pinned":
            if let p = payload as? [String: Any], let hash = p["hash"] as? String {
                let pinned = p["pinned"] as? Bool ?? true
                if let index = clipboardItems.firstIndex(where: { $0.hash == hash }) {
                    clipboardItems[index].pinned = pinned
                }
            }

        case "clipboard_clear":
            clipboardItems = []

        case "link_send":
            if let p = payload as? [String: Any] { prependLink(from: p) }

        case "pairing_pending":
            isPairing = false
            statusMessage = "Waiting for approval on another device…"

        case "pair_rejected":
            isPairing = false
            isConnected = false
            statusMessage = "Pairing rejected"

        case "error":
            if let p = payload as? [String: Any], let message = p["message"] as? String {
                lastError = message
                statusMessage = message
            }
            isPairing = false

        default:
            break
        }
    }

    // MARK: - Pairing helpers

    /// Prefer silent re-authentication with a stored token; fall back to the
    /// pairing code if the PC no longer recognises this device.
    private func attemptPairing() {
        let config = SharedConfig.shared
        if let known = DeviceStore.shared.device(matchingHost: config.serverHost, port: config.serverPort),
           !known.token.isEmpty, !known.id.isEmpty {
            sendJSON(envelope("pair_confirm", [
                "deviceId": known.id,
                "token": known.token,
                "deviceName": UIDevice.current.name
            ]))
            schedulePairFallback()
        } else {
            sendPairRequest()
        }
    }

    private func sendPairRequest() {
        sendJSON(envelope("pair_request", [
            "deviceName": UIDevice.current.name,
            "deviceType": "ios",
            "pairingCode": pairingCode
        ]))
    }

    private func schedulePairFallback() {
        pairFallback?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, !self.isConnected else { return }
            self.sendPairRequest()
        }
        pairFallback = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: work)
    }

    private func rememberCurrentDevice(from payload: [String: Any]) {
        let config = SharedConfig.shared
        let deviceId = (payload["deviceId"] as? String) ?? handshakeClientId ?? ""
        guard !deviceId.isEmpty else { return }
        let token = (payload["token"] as? String) ?? handshakeToken ?? ""
        let device = KnownDevice(
            id: deviceId,
            name: serverName.isEmpty ? "PC" : serverName,
            host: config.serverHost,
            port: config.serverPort,
            pairingCode: pairingCode.isEmpty ? config.pairingCode : pairingCode,
            useHttps: config.useHttps,
            token: token,
            certFingerprint: nil,
            lastSeen: Int(Date().timeIntervalSince1970 * 1000),
            isDefault: false
        )
        DeviceStore.shared.upsert(device)
    }

    // MARK: - Parsers

    private func parseDevices(_ list: [[String: Any]]) -> [GoonDevice] {
        list.compactMap { dict in
            guard let id = dict["id"] as? String else { return nil }
            return GoonDevice(
                id: id,
                name: dict["name"] as? String ?? "Unknown",
                type: dict["type"] as? String ?? "unknown",
                connected: dict["connected"] as? Bool ?? false,
                lastSeen: dict["lastSeen"] as? Int ?? 0,
                paired: dict["paired"] as? Bool ?? false
            )
        }
    }

    private func parseClips(_ list: [[String: Any]]) -> [GoonClipboard] {
        list.compactMap { dict in
            guard let text = dict["text"] as? String else { return nil }
            return makeClip(dict, text: text)
        }
    }

    private func parseLinks(_ list: [[String: Any]]) -> [GoonLink] {
        list.compactMap { dict in
            guard let url = dict["url"] as? String else { return nil }
            return GoonLink(
                url: url,
                title: dict["title"] as? String ?? url,
                timestamp: dict["timestamp"] as? Int ?? now(),
                sourceDeviceName: dict["sourceDeviceName"] as? String ?? "PC"
            )
        }
    }

    private func makeClip(_ dict: [String: Any], text: String) -> GoonClipboard {
        GoonClipboard(
            text: text,
            timestamp: dict["timestamp"] as? Int ?? now(),
            sourceDeviceName: dict["sourceDeviceName"] as? String ?? "Device",
            kind: dict["type"] as? String ?? (text.hasPrefix("http") ? "url" : "text"),
            hash: dict["hash"] as? String ?? "",
            pinned: dict["pinned"] as? Bool ?? false
        )
    }

    private func prependClip(from dict: [String: Any], text: String) {
        if let first = clipboardItems.first, first.text == text { return }
        clipboardItems.insert(makeClip(dict, text: text), at: 0)
    }

    private func prependLink(from dict: [String: Any]) {
        guard let url = dict["url"] as? String else { return }
        let item = GoonLink(
            url: url,
            title: dict["title"] as? String ?? url,
            timestamp: dict["timestamp"] as? Int ?? now(),
            sourceDeviceName: dict["sourceDeviceName"] as? String ?? "PC"
        )
        links.insert(item, at: 0)
        if links.count > 50 { links.removeLast(links.count - 50) }
    }

    // MARK: - Transport helpers

    private func sendHeartbeat() {
        sendJSON(envelope("heartbeat", ["timestamp": now()]))
    }

    private func sendJSON(_ obj: [String: Any]) {
        guard let task = task, task.state == .running,
              let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { _ in }
    }

    private func envelope(_ type: String, _ payload: [String: Any]) -> [String: Any] {
        ["type": type, "payload": payload, "id": UUID().uuidString, "timestamp": now()]
    }

    private func now() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    private func postClipboard(_ text: String) {
        guard let url = SharedConfig.shared.apiClipboardURL else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let code = SharedConfig.shared.pairingCode
        if !code.isEmpty { request.setValue(code, forHTTPHeaderField: "x-goondrop-code") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text])
        Task {
            let session = SharedConfig.makeLANSession()
            _ = try? await session.data(for: request)
            statusMessage = "Sent to PC clipboard"
        }
    }

    private func postLink(_ raw: String) {
        guard let url = SharedConfig.shared.apiHandoffURL else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["url": raw])
        Task {
            let session = SharedConfig.makeLANSession()
            _ = try? await session.data(for: request)
            statusMessage = "Opened on PC browser"
        }
    }

    private static func flashPasteboard() {
        // Ensure UIPasteboard access is warmed on the main thread to avoid
        // "invalid mode 'kCFRunLoopCommonModes' provided" crashes when the
        // clipboard view first loads.
        _ = UIPasteboard.general.string
    }
}