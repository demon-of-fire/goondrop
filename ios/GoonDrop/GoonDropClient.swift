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
    /// The id the server assigned this phone; used to tell our own chat
    /// messages and device-management actions apart from other devices'.
    @Published private(set) var deviceId: String = ""
    @Published var devices: [GoonDevice] = []
    @Published var clipboardItems: [GoonClipboard] = []
    @Published var links: [GoonLink] = []
    @Published var transfers: [FileTransferOut] = []
    @Published var incomingFiles: [IncomingFile] = []
    @Published var statusMessage: String?
    @Published var lastError: String?

    // Media / audio (ground truth read from the Windows launcher)
    @Published var mediaState = GoonMediaState.unknown
    /// Optimistic play/pause state used for the few ms between tapping and the
    /// launcher's read-back arriving, so the button never looks unresponsive.
    @Published var mediaPendingCommand = false

    // Shared workspace state
    @Published var chatMessages: [GoonChatMessage] = []
    @Published var notes: [GoonNote] = []
    @Published var checklist: [GoonChecklistItem] = []
    @Published var deviceBattery: [String: Int] = [:]

    // Global events that need an explicit acknowledgement
    @Published var pendingWipeAlert = false
    @Published var pingPhoneAlert = false

    private var uploaders: [String: Uploader] = [:]
    private var batteryTask: Task<Void, Never>?
    private var mediaPollTask: Task<Void, Never>?

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
            // AppContext encrypts both url and title before sending link_send.
            let key = SharedConfig.shared.encryptionKey
            sendJSON(envelope("link_send",
                              ["url": E2EECipher.encrypt(trimmed, key: key),
                               "title": E2EECipher.encrypt(trimmed, key: key)]))
            statusMessage = "Opened on PC browser"
        } else {
            postLink(trimmed)
        }
    }

    /// Stream a file from disk to the PC's drop zone, reporting live progress and
    /// resuming a partial upload when the PC already holds some of the bytes.
    func dropFile(url: URL, fileName: String, mimeType: String, completion: @escaping (Bool) -> Void) {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
        beginUpload(fileURL: url, data: nil, fileName: fileName, mimeType: mimeType,
                    size: size, completion: completion)
    }

    /// In-memory variant (photos, small payloads).
    func dropFile(data: Data, fileName: String, mimeType: String, completion: @escaping (Bool) -> Void) {
        beginUpload(fileURL: nil, data: data, fileName: fileName, mimeType: mimeType,
                    size: Int64(data.count), completion: completion)
    }

    func cancelTransfer(id: String) {
        uploaders[id]?.cancel()
        uploaders[id] = nil
        if let index = transfers.firstIndex(where: { $0.id == id }) {
            transfers.remove(at: index)
        }
    }

    private func beginUpload(fileURL: URL?, data: Data?, fileName: String, mimeType: String,
                             size: Int64, completion: @escaping (Bool) -> Void) {
        guard let url = SharedConfig.shared.apiDropURL else { completion(false); return }
        let transferId = UUID().uuidString
        let transfer = FileTransferOut(id: transferId, fileName: fileName,
                                       bytesSent: 0, totalBytes: size, state: .waiting)
        transfers.append(transfer)

        // For anything sizeable, ask the PC how many bytes it already has so we
        // only re-send the remainder (lets a dropped Wi-Fi connection resume).
        let shouldResume = size > 1_000_000
        resumeOffset(for: fileName, size: size, enabled: shouldResume) { [weak self] offset in
            guard let self = self else { return }
            guard let index = self.transfers.firstIndex(where: { $0.id == transferId }) else { return }
            self.transfers[index].state = .uploading

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.setValue(fileName, forHTTPHeaderField: "x-filename")
            // The server would otherwise label every phone upload "iPhone" from a
            // fixed shortcut id, so the real device identity travels with the bytes.
            request.setValue(UIDevice.current.name, forHTTPHeaderField: "x-goondrop-device")
            if !deviceId.isEmpty {
                request.setValue(deviceId, forHTTPHeaderField: "x-goondrop-device-id")
            }
            let code = SharedConfig.shared.pairingCode
            if !code.isEmpty { request.setValue(code, forHTTPHeaderField: "x-goondrop-code") }

            var uploadData = data
            var uploadFile = fileURL
            if offset > 0 && offset < size {
                if size > 0 { request.setValue(String(size), forHTTPHeaderField: "x-total-size") }
                request.setValue("true", forHTTPHeaderField: "x-resume")
                if let fileURL = fileURL {
                    uploadFile = self.tailTempFile(of: fileURL, from: offset)
                    uploadData = nil
                } else if let data = data {
                    uploadData = data.subdata(in: Int(offset)..<data.count)
                    uploadFile = nil
                }
            }
            _ = mimeType

            let uploader = Uploader()
            self.uploaders[transferId] = uploader
            uploader.start(request: request, fromFile: uploadFile, fromData: uploadData, onProgress: { _, sent, _ in
                DispatchQueue.main.async {
                    guard let index = self.transfers.firstIndex(where: { $0.id == transferId }) else { return }
                    self.transfers[index].bytesSent = offset + sent
                }
            }, onComplete: { ok, errorText in
                DispatchQueue.main.async {
                    self.uploaders[transferId] = nil
                    if let index = self.transfers.firstIndex(where: { $0.id == transferId }) {
                        if ok {
                            self.transfers[index].state = .done
                            self.transfers[index].bytesSent = self.transfers[index].totalBytes
                        } else {
                            self.transfers[index].state = .failed(errorText ?? "Failed")
                        }
                    }
                    if ok { self.statusMessage = "\(fileName) sent to PC" }
                    completion(ok)
                    if ok { self.clearTransferLater(id: transferId) }
                }
            })
        }
    }

    /// Bytes the PC already holds for a partial upload of this file.
    private func resumeOffset(for fileName: String, size: Int64, enabled: Bool,
                              completion: @escaping (Int64) -> Void) {
        guard enabled, let base = SharedConfig.shared.apiDropResumeURL else { completion(0); return }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "filename", value: fileName)]
        guard let url = components?.url else { completion(0); return }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        let code = SharedConfig.shared.pairingCode
        if !code.isEmpty { request.setValue(code, forHTTPHeaderField: "x-goondrop-code") }
        SharedConfig.makeLANSession().dataTask(with: request) { data, _, _ in
            var received: Int64 = 0
            if let data = data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let value = obj["received"] as? NSNumber {
                received = value.int64Value
            }
            DispatchQueue.main.async { completion(received < size ? received : 0) }
        }.resume()
    }

    private func tailTempFile(of source: URL, from offset: Int64) -> URL? {
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent("goondrop-resume-\(UUID().uuidString)-\(source.lastPathComponent)")
        FileManager.default.createFile(atPath: dest.path, contents: nil)
        guard let readHandle = try? FileHandle(forReadingFrom: source),
              let writeHandle = try? FileHandle(forWritingTo: dest) else { return nil }
        defer { try? readHandle.close(); try? writeHandle.close() }
        try? readHandle.seek(toOffset: UInt64(offset))
        while true {
            let chunk = try? readHandle.read(upToCount: 1 << 20)
            guard let data = chunk, !data.isEmpty else { break }
            writeHandle.write(data)
        }
        return dest
    }

    private func clearTransferLater(id: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            self.transfers.removeAll { $0.id == id }
        }
    }

    // MARK: - PC remote control

    private func sendControl(_ type: String, _ payload: [String: Any] = [:]) -> Bool {
        guard isConnected else {
            statusMessage = "Connect to your PC first"
            return false
        }
        sendJSON(envelope(type, payload))
        return true
    }

    /// Relative mouse movement (dx/dy are a fraction of the touchpad size).
    func mouseMove(dx: Double, dy: Double) {
        _ = sendControl("mouse_move", ["dx": dx, "dy": dy])
    }

    func mouseClick(left: Bool) {
        if sendControl("mouse_click", ["clickType": left ? "left" : "right"]) {
            statusMessage = left ? "Clicked" : "Right-clicked"
        }
    }

    static let mediaCommands: [String: String] = [
        "volume_up": "Volume up",
        "volume_down": "Volume down",
        "volume_mute": "Mute",
        "volume_mute_toggle": "Toggle mute",
        "mic_toggle": "Toggle mic",
        "mic_mute": "Mute mic",
        "mic_unmute": "Unmute mic",
        "media_play": "Play / pause",
        "media_next": "Next track",
        "media_prev": "Previous track"
    ]

    @discardableResult
    func mediaCommand(_ command: String) -> Bool {
        guard sendControl("media_command", ["command": command]) else { return false }
        statusMessage = GoonDropClient.mediaCommands[command] ?? command
        return true
    }

    // MARK: - Media transport & mic

    /// One button that plays or pauses depending on what the PC is actually
    /// doing right now. The icon follows the real reported state, and the
    /// optimistic flip is reverted as soon as the launcher's read-back lands.
    func togglePlayPause() {
        let willPlay = !mediaState.playing
        mediaState.playing = willPlay
        mediaPendingCommand = true
        SoundPlayer.shared.play(.ack)
        if !mediaCommand("media_play") {
            revertOptimisticPlayState()
        }
        scheduleMediaReadback()
    }

    private func revertOptimisticPlayState() {
        mediaPendingCommand = false
        mediaState.playing = !mediaState.playing
    }

    func skipNext() { mediaCommand("media_next"); scheduleMediaReadback() }
    func skipPrevious() { mediaCommand("media_prev"); scheduleMediaReadback() }
    func volumeUp() { mediaCommand("volume_up"); scheduleMediaReadback(after: 0.25) }
    func volumeDown() { mediaCommand("volume_down"); scheduleMediaReadback(after: 0.25) }

    /// Toggle the PC's microphone and confirm audibly on the phone — the phone
    /// has no way to hear the PC, so the sound is the only honest feedback.
    func toggleMicMute() {
        let willMute = !mediaState.micMuted
        mediaState.micMuted = willMute
        SoundPlayer.shared.play(willMute ? .micMuted : .micUnmuted)
        if !mediaCommand("mic_toggle") {
            mediaState.micMuted = !willMute
            return
        }
        statusMessage = willMute ? "PC mic muted" : "PC mic live"
        UINotificationFeedbackGenerator().notificationOccurred(willMute ? .warning : .success)
        scheduleMediaReadback(after: 0.35)
    }

    func setMicMute(_ muted: Bool) {
        guard mediaState.micMuted != muted else { return }
        toggleMicMute()
    }

    func toggleSpeakerMute() {
        let willMute = !mediaState.volumeMuted
        mediaState.volumeMuted = willMute
        SoundPlayer.shared.play(willMute ? .micMuted : .micUnmuted)
        if !mediaCommand("volume_mute_toggle") {
            mediaState.volumeMuted = !willMute
            return
        }
        scheduleMediaReadback(after: 0.35)
    }

    func requestMediaState() {
        sendJSON(envelope("media_state_request", [:]))
    }

    /// Ask the launcher to re-report. The backend also pushes state on change,
    /// but an explicit read-back right after a command keeps the UI honest even
    /// if a push was missed.
    private func scheduleMediaReadback(after delay: TimeInterval = 0.6) {
        mediaPollTask?.cancel()
        mediaPollTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.requestMediaState()
        }
    }

    /// HTTP fallback so the media card is populated even before the WebSocket
    /// finishes pairing.
    func refreshMediaStateOverHTTP() {
        guard let url = SharedConfig.shared.apiMediaStateURL else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        let code = SharedConfig.shared.pairingCode
        if !code.isEmpty { request.setValue(code, forHTTPHeaderField: "x-goondrop-code") }
        Task {
            let session = SharedConfig.makeLANSession()
            guard let (data, _) = try? await session.data(for: request),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let available = (obj["available"] as? Bool), available else { return }
            applyMediaState(obj)
        }
    }

    // MARK: - Shared workspace: chat, notes, checklist

    func sendChat(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // Chat text is encrypted by the web client before it hits the wire, so
        // match that here or the browser shows ciphertext.
        sendJSON(envelope("chat_message",
                          ["text": E2EECipher.encrypt(trimmed, key: SharedConfig.shared.encryptionKey)]))
        // The server excludes the sender from its own broadcast, so echo the
        // message locally to keep the thread in order.
        chatMessages.append(GoonChatMessage(text: trimmed, timestamp: now(),
                                            sourceDeviceId: deviceId,
                                            sourceDeviceName: UIDevice.current.name))
        trimChat()
    }

    func requestChatHistory() {
        sendJSON(envelope("chat_history_request", [:]))
    }

    private func trimChat() {
        if chatMessages.count > 200 {
            chatMessages.removeFirst(chatMessages.count - 200)
        }
    }

    /// Push a note to the PC and every other device. Used for quick snippets
    /// ("here's the wifi password") without touching the clipboard.
    func sendNote(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if sendControl("text_note",
                        ["text": E2EECipher.encrypt(trimmed, key: SharedConfig.shared.encryptionKey)]) {
            notes.insert(GoonNote(text: trimmed, timestamp: now(),
                                  sourceDeviceName: UIDevice.current.name), at: 0)
            if notes.count > 50 { notes.removeLast(notes.count - 50) }
            statusMessage = "Note sent to PC"
        } else {
            postNote(trimmed)
        }
    }

    private func postNote(_ text: String) {
        guard let url = SharedConfig.shared.apiNoteURL else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let code = SharedConfig.shared.pairingCode
        if !code.isEmpty { request.setValue(code, forHTTPHeaderField: "x-goondrop-code") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text])
        Task { _ = try? await SharedConfig.makeLANSession().data(for: request) }
    }

    // MARK: - Shared checklist

    func addChecklistItem(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        checklist.append(GoonChecklistItem(text: trimmed))
        publishChecklist()
    }

    func toggleChecklistItem(_ item: GoonChecklistItem) {
        guard let index = checklist.firstIndex(where: { $0.id == item.id }) else { return }
        checklist[index].done.toggle()
        publishChecklist()
    }

    func removeChecklistItem(_ item: GoonChecklistItem) {
        checklist.removeAll { $0.id == item.id }
        publishChecklist()
    }

    func clearChecklist() {
        checklist = []
        publishChecklist()
    }

    private func publishChecklist() {
        // The web app treats the checklist payload as a bare array (see
        // TextNotes.tsx sendMessage and AppContext's checklist_update case), so
        // send an array rather than an {items: ...} envelope.
        let key = SharedConfig.shared.encryptionKey
        let payload: [[String: Any]] = checklist.map { item in
            var row: [String: Any] = ["id": item.id, "done": item.done]
            row["text"] = E2EECipher.encrypt(item.text, key: key)
            return row
        }
        sendJSON(envelope("checklist_update", arrayPayload: payload))
        statusMessage = "Checklist updated"
    }

    // MARK: - Device management

    func renameDevice(_ device: GoonDevice, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, device.id != deviceId else { return }
        sendJSON(envelope("rename_device", ["deviceId": device.id, "name": trimmed]))
        if let index = devices.firstIndex(where: { $0.id == device.id }) {
            devices[index].name = trimmed
        }
        statusMessage = "Renamed to \(trimmed)"
    }

    func unpairDevice(_ device: GoonDevice) {
        guard device.id != deviceId else { return }
        sendJSON(envelope("unpair_device", ["deviceId": device.id]))
        devices.removeAll { $0.id == device.id }
        statusMessage = "Removed \(device.name)"
    }

    /// Clear every shared artefact on the PC and every paired device.
    func triggerNuclearWipe() {
        sendJSON(envelope("nuclear_wipe", [:]))
        chatMessages = []
        notes = []
        checklist = []
        statusMessage = "Everything wiped"
    }

    func acknowledgeWipe() { pendingWipeAlert = false }
    func acknowledgePing() { pingPhoneAlert = false }

    // MARK: - Battery reporting

    private func startBatteryReporting() {
        batteryTask?.cancel()
        batteryTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.reportBattery()
                try? await Task.sleep(nanoseconds: 120_000_000_000)
            }
        }
    }

    private func reportBattery() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let raw = UIDevice.current.batteryLevel
        guard raw >= 0 else { return }
        let level = Int((raw * 100).rounded())
        deviceBattery[UIDevice.current.name] = level
        sendJSON(envelope("battery_report", [
            "level": level,
            "charging": UIDevice.current.batteryState == .charging
        ]))
    }

    /// Type text on the PC as if typed at its keyboard.
    func typeOnPC(_ text: String) {
        guard !text.isEmpty else { return }
        if sendControl("keyboard_type", ["text": text]) {
            statusMessage = "Typed on PC"
        }
    }

    func lockPC() {
        if sendControl("lock_pc") { statusMessage = "PC locked" }
    }

    func sleepPC() {
        if sendControl("sleep_pc") { statusMessage = "PC going to sleep" }
    }

    func restartPC() {
        if sendControl("restart_pc") { statusMessage = "PC restarting" }
    }

    func shutdownPC() {
        if sendControl("shutdown_pc") { statusMessage = "PC shutting down" }
    }

    /// Find My PC — makes the machine beep and show a balloon so you can locate it.
    func pingPC() {
        if sendControl("ping_pc") { statusMessage = "Pinging PC…" }
    }

    func openWindowsUpdate() {
        if sendControl("update_pc") { statusMessage = "Opening Windows Update" }
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
            requestMediaState()
            startBatteryReporting()

        case "init_state":
            if let p = payload as? [String: Any] {
                if let clips = p["clipboardHistory"] as? [[String: Any]] {
                    clipboardItems = parseClips(clips)
                }
                if let links = p["links"] as? [[String: Any]] {
                    self.links = parseLinks(links)
                }
                if let items = p["checklist"] as? [[String: Any]] {
                    let key = SharedConfig.shared.encryptionKey
                    checklist = items.compactMap { row -> GoonChecklistItem? in
                        guard var item = GoonChecklistItem(dictionary: row) else { return nil }
                        item.text = E2EECipher.decrypt(item.text, key: key)
                        return item
                    }
                }
                if let history = p["chatHistory"] as? [[String: Any]] {
                    chatMessages = parseChat(history)
                }
            }

        case "media_state":
            if let p = payload as? [String: Any] {
                applyMediaState(p)
            }

        case "battery_info":
            if let p = payload as? [String: Any],
               let name = p["deviceName"] as? String,
               let level = (p["level"] as? NSNumber)?.intValue {
                deviceBattery[name] = level
            }

        case "chat_message":
            if let p = payload as? [String: Any] {
                appendChat(p)
            }

        case "chat_history":
            if let history = payload as? [[String: Any]] {
                chatMessages = parseChat(history)
            }

        case "text_note":
            if let p = payload as? [String: Any], let raw = p["text"] as? String, !raw.isEmpty {
                let text = E2EECipher.decrypt(raw, key: SharedConfig.shared.encryptionKey)
                notes.insert(GoonNote(text: text,
                                      timestamp: p["timestamp"] as? Int ?? now(),
                                      sourceDeviceName: p["sourceDeviceName"] as? String ?? "PC"), at: 0)
                if notes.count > 50 { notes.removeLast(notes.count - 50) }
                UIPasteboard.general.string = text
                statusMessage = "Note from PC copied to your clipboard"
            }

        case "checklist_update":
            // The web client broadcasts the array directly as the payload; older
            // builds wrapped it in { items: [...] }, so accept either shape.
            var rows: [[String: Any]] = []
            if let direct = payload as? [[String: Any]] {
                rows = direct
            } else if let wrapped = payload as? [String: Any] {
                rows = (wrapped["items"] as? [[String: Any]]) ?? []
            }
            if !rows.isEmpty || payload is [[String: Any]] {
                let key = SharedConfig.shared.encryptionKey
                checklist = rows.compactMap { row in
                    guard var item = GoonChecklistItem(dictionary: row) else { return nil }
                    item.text = E2EECipher.decrypt(item.text, key: key)
                    return item
                }
            }

        case "ping_phone":
            pingPhoneAlert = true
            SoundPlayer.shared.play(.success)
            UINotificationFeedbackGenerator().notificationOccurred(.success)

        case "nuclear_wipe":
            clipboardItems = []
            chatMessages = []
            notes = []
            checklist = []
            links = []
            pendingWipeAlert = true
            statusMessage = "Everything was wiped from Goon Drop"

        case "device_list":
            if let devs = payload as? [[String: Any]] { devices = parseDevices(devs) }

        case "device_update", "device_renamed":
            if let p = payload as? [String: Any],
               let id = p["deviceId"] as? String ?? (p["id"] as? String),
               let index = devices.firstIndex(where: { $0.id == id }) {
                if let name = p["name"] as? String, !name.isEmpty { devices[index].name = name }
                if let online = p["online"] as? Bool { devices[index].connected = online }
            }

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
            if let p = payload as? [String: Any], let raw = p["text"] as? String {
                let text = E2EECipher.decrypt(raw, key: SharedConfig.shared.encryptionKey)
                guard !text.isEmpty else { return }
                receiveClipboard(from: p, text: text)
            }

        case "clipboard_history":
            if let clips = payload as? [[String: Any]] {
                clipboardItems = parseClips(clips)
                // The server's history is newest-first. Replaying the current
                // clipboard after reconnect makes a missed launcher send useful
                // instead of leaving it trapped in this screen.
                if let newest = clips.first,
                   let raw = newest["text"] as? String, !raw.isEmpty {
                    let text = E2EECipher.decrypt(raw, key: SharedConfig.shared.encryptionKey)
                    UIPasteboard.general.string = text
                    statusMessage = "Latest PC text copied to your clipboard"
                }
            }

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
            if let p = payload as? [String: Any] {
                let key = SharedConfig.shared.encryptionKey
                var link = p
                // Decrypt on arrival so the history shows a readable URL. An
                // unencrypted link (no passcode) passes through untouched.
                if let url = link["url"] as? String {
                    link["url"] = E2EECipher.decrypt(url, key: key)
                }
                if let title = link["title"] as? String {
                    link["title"] = E2EECipher.decrypt(title, key: key)
                }
                prependLink(from: link)
            }

        case "file_meta":
            if let p = payload as? [String: Any] { registerIncomingFile(p) }

        case "file_complete":
            if let p = payload as? [String: Any] { completeIncomingFile(p) }

        case "file_cancel":
            if let p = payload as? [String: Any], let id = p["fileId"] as? String,
               let index = incomingFiles.firstIndex(where: { $0.id == id }) {
                incomingFiles[index].status = .declined
            }

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
        self.deviceId = deviceId
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

    /// Fold a launcher-reported snapshot into the published state, keeping the
    /// optimistic play/pause flag honest once the real answer arrives.
    private func applyMediaState(_ dict: [String: Any]) {
        guard let available = dict["available"] as? Bool, available else {
            mediaState = .unknown
            mediaPendingCommand = false
            return
        }
        mediaState = GoonMediaState(
            available: true,
            playing: dict["playing"] as? Bool ?? false,
            title: dict["title"] as? String ?? "",
            appName: dict["appName"] as? String ?? "",
            volume: (dict["volume"] as? NSNumber)?.doubleValue ?? -1,
            volumeMuted: dict["volumeMuted"] as? Bool ?? false,
            micMuted: dict["micMuted"] as? Bool ?? false,
            micVolume: (dict["micVolume"] as? NSNumber)?.doubleValue ?? -1,
            updatedAt: (dict["updatedAt"] as? NSNumber)?.intValue ?? now()
        )
        mediaPendingCommand = false
    }

    private func parseChat(_ list: [[String: Any]]) -> [GoonChatMessage] {
        let key = SharedConfig.shared.encryptionKey
        return list.compactMap { dict in
            guard let raw = dict["text"] as? String, !raw.isEmpty else { return nil }
            return GoonChatMessage(
                text: E2EECipher.decrypt(raw, key: key),
                timestamp: dict["timestamp"] as? Int ?? now(),
                sourceDeviceId: dict["sourceDeviceId"] as? String ?? "",
                sourceDeviceName: dict["sourceDeviceName"] as? String ?? "Device"
            )
        }
    }

    private func appendChat(_ dict: [String: Any]) {
        guard let raw = dict["text"] as? String, !raw.isEmpty else { return }
        let message = GoonChatMessage(
            text: E2EECipher.decrypt(raw, key: SharedConfig.shared.encryptionKey),
            timestamp: dict["timestamp"] as? Int ?? now(),
            sourceDeviceId: dict["sourceDeviceId"] as? String ?? "",
            sourceDeviceName: dict["sourceDeviceName"] as? String ?? "Device"
        )
        if let last = chatMessages.last, last.text == message.text,
           last.sourceDeviceId == message.sourceDeviceId { return }
        chatMessages.append(message)
        trimChat()
    }

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
        // The web client encrypts clipboard text before it goes on the wire, so
        // history arriving from the server is ciphertext when a passcode is set.
        let key = SharedConfig.shared.encryptionKey
        return list.compactMap { dict in
            guard let raw = dict["text"] as? String else { return nil }
            return makeClip(dict, text: E2EECipher.decrypt(raw, key: key))
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

    private func receiveClipboard(from dict: [String: Any], text: String) {
        prependClip(from: dict, text: text)
        // Unlike the web PWA, the native app can update UIPasteboard directly.
        // This is the expected continuity behavior: launcher text is immediately
        // available to paste anywhere on the phone while Goon Drop is active.
        UIPasteboard.general.string = text
        statusMessage = "Text copied to your iPhone clipboard"
    }

    private func prependLink(from dict: [String: Any]) {
        guard let url = dict["url"] as? String, !url.isEmpty else { return }
        let title = dict["title"] as? String
        let item = GoonLink(
            url: url,
            title: (title?.isEmpty == false) ? title! : url,
            timestamp: dict["timestamp"] as? Int ?? now(),
            sourceDeviceName: dict["sourceDeviceName"] as? String ?? "PC"
        )
        links.insert(item, at: 0)
        if links.count > 50 { links.removeLast(links.count - 50) }
    }

    // MARK: - Incoming files

    private func registerIncomingFile(_ payload: [String: Any]) {
        guard let id = payload["fileId"] as? String,
              let name = payload["fileName"] as? String,
              !id.isEmpty, !name.isEmpty else { return }
        guard incomingFiles.firstIndex(where: { $0.id == id }) == nil else { return }
        let size = (payload["fileSize"] as? NSNumber)?.int64Value ?? 0
        incomingFiles.insert(IncomingFile(
            id: id,
            fileName: name,
            fileSize: size,
            mimeType: payload["mimeType"] as? String ?? "application/octet-stream",
            sourceDeviceName: payload["sourceDeviceName"] as? String ?? "Windows PC",
            status: .offered,
            downloadURL: nil,
            localURL: nil,
            errorMessage: nil
        ), at: 0)
        statusMessage = "\(name) is ready to accept"
    }

    private func completeIncomingFile(_ payload: [String: Any]) {
        guard let id = payload["fileId"] as? String,
              let relativeURL = payload["downloadUrl"] as? String,
              let url = URL(string: relativeURL, relativeTo: URL(string: SharedConfig.shared.baseURLString))?.absoluteURL,
              let index = incomingFiles.firstIndex(where: { $0.id == id }) else { return }
        incomingFiles[index].downloadURL = url
        incomingFiles[index].status = .waitingForFile
        statusMessage = "\(incomingFiles[index].fileName) is ready to download"
    }

    func acceptIncomingFile(_ file: IncomingFile) {
        guard file.status == .offered else { return }
        if let index = incomingFiles.firstIndex(where: { $0.id == file.id }) {
            incomingFiles[index].status = .waitingForFile
        }
        sendJSON(envelope("file_accept", ["fileId": file.id]))
    }

    func declineIncomingFile(_ file: IncomingFile) {
        if let index = incomingFiles.firstIndex(where: { $0.id == file.id }) {
            incomingFiles[index].status = .declined
        }
        sendJSON(envelope("file_decline", ["fileId": file.id]))
    }

    func downloadIncomingFile(_ file: IncomingFile) {
        guard let remoteURL = file.downloadURL,
              let index = incomingFiles.firstIndex(where: { $0.id == file.id }) else { return }
        incomingFiles[index].status = .downloading
        Task {
            do {
                let (data, response) = try await SharedConfig.makeLANSession().data(from: remoteURL)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                let directory = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
                                                            appropriateFor: nil, create: true)
                    .appendingPathComponent("GoonDrop Received", isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let safeName = file.fileName.replacingOccurrences(of: "/", with: "_")
                let destination = directory.appendingPathComponent(safeName)
                try? FileManager.default.removeItem(at: destination)
                try data.write(to: destination, options: .atomic)
                if let updated = incomingFiles.firstIndex(where: { $0.id == file.id }) {
                    incomingFiles[updated].localURL = destination
                    incomingFiles[updated].status = .ready
                    statusMessage = "Saved \(file.fileName) in GoonDrop Received"
                }
            } catch {
                if let updated = incomingFiles.firstIndex(where: { $0.id == file.id }) {
                    incomingFiles[updated].status = .failed
                    incomingFiles[updated].errorMessage = error.localizedDescription
                }
                lastError = "Could not download \(file.fileName)"
            }
        }
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

    /// The web client sends the checklist as a bare array rather than an object,
    /// so this variant is needed to keep the payload type honest.
    private func envelope(_ type: String, arrayPayload: [[String: Any]]) -> [String: Any] {
        ["type": type, "payload": arrayPayload, "id": UUID().uuidString, "timestamp": now()]
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
