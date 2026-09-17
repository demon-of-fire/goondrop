import UIKit
import Social
import UniformTypeIdentifiers
import UserNotifications

/// AirDrop-style share sheet: shows the remembered PC as a destination, lists
/// every shared item with a live status, and sends them all with progress.
final class ShareViewController: UIViewController {

    // MARK: - Model

    private enum ItemKind {
        case url, text, image, movie, file
    }

    private enum ItemStatus {
        case waiting
        case sending(Double)
        case sent
        case failed(String)

        var text: String {
            switch self {
            case .waiting: return "Waiting"
            case .sending(let p): return p > 0 ? "Sending \(Int(p * 100))%" : "Sending…"
            case .sent: return "Sent"
            case .failed(let reason): return "Failed · \(reason)"
            }
        }

        var color: UIColor {
            switch self {
            case .waiting: return .secondaryLabel
            case .sending: return .systemOrange
            case .sent: return .systemGreen
            case .failed: return .systemRed
            }
        }
    }

    private final class SharedItem {
        let provider: NSItemProvider
        let kind: ItemKind
        var name: String
        var status: ItemStatus = .waiting

        init(provider: NSItemProvider, kind: ItemKind, name: String) {
            self.provider = provider
            self.kind = kind
            self.name = name
        }
    }

    private enum Payload {
        case url(URL)
        case text(String)
        case file(Data, String, String) // data, filename, mime
    }

    private struct Target {
        let name: String
        let host: String
        let port: Int
        let code: String
        let useHttps: Bool
    }

    // MARK: - State

    private let config = SharedConfig.shared
    private var target: Target?
    private var items: [SharedItem] = []
    private var currentTask: URLSessionTask?
    private var progressTimer: Timer?
    private var isSending = false
    private var sentCount = 0

    // MARK: - UI

    private let cardView = UIView()
    private let titleLabel = UILabel()
    private let targetIcon = UIImageView()
    private let targetNameLabel = UILabel()
    private let targetDetailLabel = UILabel()
    private let targetStatusDot = UIView()
    private let itemsStack = UIStackView()
    private let statusLabel = UILabel()
    private let progressView = UIProgressView(progressViewStyle: .default)
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let primaryButton = UIButton(type: .system)
    private let secondaryButton = UIButton(type: .system)

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        collectItems()
        resolveTargetAndBegin()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        progressTimer?.invalidate()
    }

    // MARK: - Setup

    private func setupUI() {
        view.backgroundColor = UIColor.black.withAlphaComponent(0.45)

        cardView.translatesAutoresizingMaskIntoConstraints = false
        cardView.backgroundColor = .secondarySystemBackground
        cardView.layer.cornerRadius = 22
        cardView.clipsToBounds = true
        view.addSubview(cardView)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.text = "Goon Drop"
        titleLabel.font = .systemFont(ofSize: 18, weight: .bold)
        titleLabel.textAlignment = .center
        cardView.addSubview(titleLabel)

        // Target row (the PC, like an AirDrop recipient)
        targetIcon.translatesAutoresizingMaskIntoConstraints = false
        targetIcon.image = UIImage(systemName: "desktopcomputer")
        targetIcon.tintColor = .systemBlue
        targetIcon.contentMode = .scaleAspectFit
        cardView.addSubview(targetIcon)

        targetStatusDot.translatesAutoresizingMaskIntoConstraints = false
        targetStatusDot.backgroundColor = .systemGray3
        targetStatusDot.layer.cornerRadius = 5
        cardView.addSubview(targetStatusDot)

        targetNameLabel.translatesAutoresizingMaskIntoConstraints = false
        targetNameLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        targetNameLabel.text = "Searching for your PC…"
        cardView.addSubview(targetNameLabel)

        targetDetailLabel.translatesAutoresizingMaskIntoConstraints = false
        targetDetailLabel.font = .systemFont(ofSize: 12, weight: .regular)
        targetDetailLabel.textColor = .secondaryLabel
        targetDetailLabel.text = "Looking on Wi-Fi"
        cardView.addSubview(targetDetailLabel)

        itemsStack.translatesAutoresizingMaskIntoConstraints = false
        itemsStack.axis = .vertical
        itemsStack.spacing = 6
        cardView.addSubview(itemsStack)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .systemFont(ofSize: 13, weight: .medium)
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        cardView.addSubview(statusLabel)

        progressView.translatesAutoresizingMaskIntoConstraints = false
        progressView.progress = 0
        progressView.isHidden = true
        cardView.addSubview(progressView)

        activityIndicator.translatesAutoresizingMaskIntoConstraints = false
        activityIndicator.hidesWhenStopped = true
        activityIndicator.startAnimating()
        cardView.addSubview(activityIndicator)

        primaryButton.translatesAutoresizingMaskIntoConstraints = false
        primaryButton.setTitle("Send", for: .normal)
        primaryButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        primaryButton.addTarget(self, action: #selector(primaryTapped), for: .touchUpInside)
        cardView.addSubview(primaryButton)

        secondaryButton.translatesAutoresizingMaskIntoConstraints = false
        secondaryButton.setTitle("Cancel", for: .normal)
        secondaryButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
        secondaryButton.tintColor = .secondaryLabel
        secondaryButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cardView.addSubview(secondaryButton)

        NSLayoutConstraint.activate([
            cardView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cardView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            cardView.widthAnchor.constraint(equalToConstant: 330),
            cardView.heightAnchor.constraint(lessThanOrEqualTo: view.heightAnchor, multiplier: 0.85),

            titleLabel.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 18),
            titleLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 16),
            titleLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -16),

            targetIcon.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 14),
            targetIcon.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 18),
            targetIcon.widthAnchor.constraint(equalToConstant: 30),
            targetIcon.heightAnchor.constraint(equalToConstant: 30),

            targetStatusDot.widthAnchor.constraint(equalToConstant: 10),
            targetStatusDot.heightAnchor.constraint(equalToConstant: 10),
            targetStatusDot.centerYAnchor.constraint(equalTo: targetNameLabel.centerYAnchor),
            targetStatusDot.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -18),

            targetNameLabel.topAnchor.constraint(equalTo: targetIcon.topAnchor),
            targetNameLabel.leadingAnchor.constraint(equalTo: targetIcon.trailingAnchor, constant: 10),
            targetNameLabel.trailingAnchor.constraint(lessThanOrEqualTo: targetStatusDot.leadingAnchor, constant: -8),

            targetDetailLabel.topAnchor.constraint(equalTo: targetNameLabel.bottomAnchor, constant: 2),
            targetDetailLabel.leadingAnchor.constraint(equalTo: targetNameLabel.leadingAnchor),
            targetDetailLabel.trailingAnchor.constraint(lessThanOrEqualTo: cardView.trailingAnchor, constant: -18),

            itemsStack.topAnchor.constraint(equalTo: targetDetailLabel.bottomAnchor, constant: 14),
            itemsStack.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 18),
            itemsStack.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -18),

            statusLabel.topAnchor.constraint(equalTo: itemsStack.bottomAnchor, constant: 12),
            statusLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -16),

            progressView.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 8),
            progressView.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 24),
            progressView.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -24),
            progressView.heightAnchor.constraint(equalToConstant: 4),

            activityIndicator.topAnchor.constraint(equalTo: progressView.bottomAnchor, constant: 10),
            activityIndicator.centerXAnchor.constraint(equalTo: cardView.centerXAnchor),

            primaryButton.topAnchor.constraint(equalTo: activityIndicator.bottomAnchor, constant: 10),
            primaryButton.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 20),
            primaryButton.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -20),

            secondaryButton.topAnchor.constraint(equalTo: primaryButton.bottomAnchor, constant: 8),
            secondaryButton.centerXAnchor.constraint(equalTo: cardView.centerXAnchor),
            secondaryButton.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -16)
        ])
    }

    private func setTarget(_ target: Target) {
        self.target = target
        targetNameLabel.text = target.name
        targetDetailLabel.text = "\(target.host):\(target.port)"
        targetStatusDot.backgroundColor = .systemGreen
    }

    // MARK: - Collect shared items

    private func collectItems() {
        let inputItems = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        for item in inputItems {
            guard let attachments = item.attachments else { continue }
            for provider in attachments {
                let kind = classify(provider)
                let name = provider.suggestedName ?? defaultName(for: kind)
                items.append(SharedItem(provider: provider, kind: kind, name: name))
            }
        }

        if items.isEmpty {
            statusLabel.text = "No supported items to share."
            activityIndicator.stopAnimating()
            primaryButton.isHidden = true
            return
        }

        for item in items {
            itemsStack.addArrangedSubview(makeRow(for: item))
        }
        statusLabel.text = items.count == 1 ? "1 item ready" : "\(items.count) items ready"
    }

    private func classify(_ provider: NSItemProvider) -> ItemKind {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) { return .url }
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) { return .image }
        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) { return .movie }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) { return .text }
        return .file
    }

    private func defaultName(for kind: ItemKind) -> String {
        let stamp = Int(Date().timeIntervalSince1970)
        switch kind {
        case .image: return "image_\(stamp).jpg"
        case .movie: return "video_\(stamp).mp4"
        case .url: return "Link"
        case .text: return "Text"
        case .file: return "file_\(stamp).bin"
        }
    }

    private func makeRow(for item: SharedItem) -> UIView {
        let row = UIView()
        row.translatesAutoresizingMaskIntoConstraints = false

        let icon = UIImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.contentMode = .scaleAspectFit
        icon.tintColor = .systemBlue
        icon.image = UIImage(systemName: iconName(for: item.kind))

        let nameLabel = UILabel()
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        nameLabel.font = .systemFont(ofSize: 13, weight: .medium)
        nameLabel.text = item.name
        nameLabel.lineBreakMode = .byTruncatingMiddle

        let status = UILabel()
        status.translatesAutoresizingMaskIntoConstraints = false
        status.font = .systemFont(ofSize: 12, weight: .regular)
        status.textAlignment = .right
        status.text = item.status.text
        status.textColor = item.status.color

        row.addSubview(icon)
        row.addSubview(nameLabel)
        row.addSubview(status)

        NSLayoutConstraint.activate([
            row.heightAnchor.constraint(equalToConstant: 34),
            icon.leadingAnchor.constraint(equalTo: row.leadingAnchor),
            icon.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 22),
            icon.heightAnchor.constraint(equalToConstant: 22),
            nameLabel.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
            nameLabel.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            status.leadingAnchor.constraint(greaterThanOrEqualTo: nameLabel.trailingAnchor, constant: 8),
            status.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            status.centerYAnchor.constraint(equalTo: row.centerYAnchor)
        ])
        // remember the status label so we can refresh it
        statusInRows[ObjectIdentifier(item)] = status
        return row
    }

    private var statusInRows: [ObjectIdentifier: UILabel] = [:]

    private func iconName(for kind: ItemKind) -> String {
        switch kind {
        case .url: return "link"
        case .text: return "text.alignleft"
        case .image: return "photo"
        case .movie: return "film"
        case .file: return "doc"
        }
    }

    private func update(item: SharedItem, status: ItemStatus) {
        item.status = status
        DispatchQueue.main.async {
            self.statusInRows[ObjectIdentifier(item)]?.text = status.text
            self.statusInRows[ObjectIdentifier(item)]?.textColor = status.color
        }
    }

    // MARK: - Target resolution

    private func resolveTargetAndBegin() {
        statusLabel.text = "Finding your PC…"
        resolveTarget { [weak self] target in
            guard let self = self else { return }
            guard let target = target else {
                self.activityIndicator.stopAnimating()
                self.statusLabel.text = "No Goon Drop PC found. Open the Goon Drop app once on this Wi-Fi."
                self.targetNameLabel.text = "No PC found"
                self.targetDetailLabel.text = "Scan the app to pair"
                self.primaryButton.setTitle("Retry", for: .normal)
                return
            }
            self.setTarget(target)
            if self.config.autoSend {
                self.statusLabel.text = "Sending to \(target.name)…"
                self.startSending()
            } else {
                self.activityIndicator.stopAnimating()
                self.statusLabel.text = "Ready to send to \(target.name)"
                self.primaryButton.setTitle("Send to \(target.name)", for: .normal)
            }
        }
    }

    private func resolveTarget(completion: @escaping (Target?) -> Void) {
        if let device = DeviceStore.shared.defaultDevice {
            completion(Target(name: device.name, host: device.host, port: device.port,
                              code: device.pairingCode, useHttps: device.useHttps))
            return
        }
        if config.isConfigured && !config.serverHost.isEmpty && config.serverHost != "192.168.1.100" {
            let name = config.serverName.isEmpty ? "PC" : config.serverName
            completion(Target(name: name, host: config.serverHost, port: config.serverPort,
                              code: config.pairingCode, useHttps: config.useHttps))
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let server = LANDiscovery.discover(timeout: 1.5).first
            DispatchQueue.main.async {
                completion(server.map {
                    Target(name: $0.serverName, host: $0.ip, port: $0.port, code: $0.pairingCode, useHttps: true)
                })
            }
        }
    }

    // MARK: - Actions

    @objc private func primaryTapped() {
        if target == nil {
            resolveTargetAndBegin()
            return
        }
        if items.contains(where: { if case .failed = $0.status { return true } else { return false } }) {
            for item in items { update(item, status: .waiting) }
        }
        startSending()
    }

    @objc private func cancelTapped() {
        currentTask?.cancel()
        extensionContext?.cancelRequest(withError: NSError(domain: "GoonDrop", code: -1,
            userInfo: [NSLocalizedDescriptionKey: "User cancelled"]))
    }

    // MARK: - Sending

    private func startSending() {
        guard !isSending, !items.isEmpty, let _ = target else { return }
        isSending = true
        sentCount = 0
        primaryButton.isHidden = true
        progressView.isHidden = false
        progressView.progress = 0
        activityIndicator.startAnimating()
        sendItem(at: 0)
    }

    private func sendItem(at index: Int) {
        guard index < items.count else {
            finishSending()
            return
        }
        let item = items[index]
        update(item, status: .sending(0))
        DispatchQueue.main.async { self.statusLabel.text = "Sending \(item.name)…" }

        loadPayload(for: item) { [weak self] payload in
            guard let self = self else { return }
            guard let payload = payload else {
                self.update(item, status: .failed("Unreadable"))
                self.sendItem(at: index + 1)
                return
            }
            self.deliver(payload, item: item) { ok, errorText in
                if ok {
                    self.sentCount += 1
                    self.update(item, status: .sent)
                } else {
                    self.update(item, status: .failed(errorText ?? "Failed"))
                }
                self.sendItem(at: index + 1)
            }
        }
    }

    private func finishSending() {
        isSending = false
        stopProgressTimer()
        DispatchQueue.main.async { self.applyFinishedState() }
    }

    private func applyFinishedState() {
        progressView.isHidden = true
        activityIndicator.stopAnimating()

        let total = items.count
        let allSent = sentCount == total
        let targetName = target?.name ?? "PC"

        statusLabel.text = allSent
            ? (total == 1 ? "Sent to \(targetName)" : "Sent \(total) items to \(targetName)")
            : "\(sentCount) of \(total) sent to \(targetName)"
        primaryButton.isHidden = !allSent
        if !allSent { primaryButton.setTitle("Retry failed", for: .normal) }

        let feedback = UINotificationFeedbackGenerator()
        feedback.notificationOccurred(allSent ? .success : .error)

        notifyCompletion(sent: sentCount, total: total, device: targetName)

        if allSent {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            }
        }
    }

    // MARK: - Payload loading

    private func loadPayload(for item: SharedItem, completion: @escaping (Payload?) -> Void) {
        let provider = item.provider
        switch item.kind {
        case .url:
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { data, _ in
                var url: URL?
                if let u = data as? URL { url = u }
                else if let s = data as? String { url = URL(string: s) }
                else if let d = data as? Data, let s = String(data: d, encoding: .utf8) { url = URL(string: s) }
                completion(url.map { .url($0) })
            }
        case .text:
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { data, _ in
                if let s = data as? String { completion(.text(s)) }
                else if let d = data as? Data, let s = String(data: d, encoding: .utf8) { completion(.text(s)) }
                else { completion(nil) }
            }
        case .image:
            loadFileData(provider: provider, type: UTType.image.identifier) { data in
                guard let data = data else { completion(nil); return }
                completion(.file(data, item.name, "image/jpeg"))
            }
        case .movie:
            loadFileData(provider: provider, type: UTType.movie.identifier) { data in
                guard let data = data else { completion(nil); return }
                completion(.file(data, item.name, "video/mp4"))
            }
        case .file:
            loadFileData(provider: provider, type: UTType.data.identifier) { data in
                guard let data = data else { completion(nil); return }
                completion(.file(data, item.name, "application/octet-stream"))
            }
        }
    }

    private func loadFileData(provider: NSItemProvider, type: String, completion: @escaping (Data?) -> Void) {
        provider.loadItem(forTypeIdentifier: type, options: nil) { data, _ in
            if let url = data as? URL, let contents = try? Data(contentsOf: url) {
                completion(contents)
            } else if let image = data as? UIImage, let contents = image.jpegData(compressionQuality: 0.9) {
                completion(contents)
            } else if let contents = data as? Data {
                completion(contents)
            } else {
                completion(nil)
            }
        }
    }

    // MARK: - Delivery

    private func endpoint(_ target: Target, _ path: String) -> URL? {
        let scheme = target.useHttps ? "https" : "http"
        return URL(string: "\(scheme)://\(target.host):\(target.port)\(path)")
    }

    private func deliver(_ payload: Payload, item: SharedItem, completion: @escaping (Bool, String?) -> Void) {
        guard let target = target else { completion(false, "No PC"); return }
        switch payload {
        case .url(let url):
            postJSON(target, "/api/handoff", ["url": url.absoluteString], completion)
        case .text(let text):
            postJSON(target, "/api/clipboard", ["text": text], completion)
        case .file(let data, let name, let mime):
            postMultipart(target, data: data, fileName: name, mimeType: mime, completion)
        }
    }

    private func postJSON(_ target: Target, _ path: String, _ body: [String: Any],
                          _ completion: @escaping (Bool, String?) -> Void) {
        guard let url = endpoint(target, path) else { completion(false, "Bad URL"); return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !target.code.isEmpty { request.setValue(target.code, forHTTPHeaderField: "x-goondrop-code") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let task = SharedConfig.makeLANSession().dataTask(with: request) { _, response, error in
            if let error = error { completion(false, error.localizedDescription); return }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            completion((200...299).contains(code), code == 0 ? "No response" : "HTTP \(code)")
        }
        currentTask = task
        startProgressTimer()
        task.resume()
    }

    private func postMultipart(_ target: Target, data: Data, fileName: String, mimeType: String,
                               _ completion: @escaping (Bool, String?) -> Void) {
        guard let url = endpoint(target, "/api/drop") else { completion(false, "Bad URL"); return }
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if !target.code.isEmpty { request.setValue(target.code, forHTTPHeaderField: "x-goondrop-code") }

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        let task = SharedConfig.makeLANSession().uploadTask(with: request, from: body) { _, response, error in
            if let error = error { completion(false, error.localizedDescription); return }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            completion((200...299).contains(code), code == 0 ? "No response" : "HTTP \(code)")
        }
        currentTask = task
        startProgressTimer()
        task.resume()
    }

    // MARK: - Progress

    private func startProgressTimer() {
        stopProgressTimer()
        DispatchQueue.main.async {
            self.progressTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
                guard let self = self, let task = self.currentTask else { return }
                let fraction = task.progress.fractionCompleted
                if fraction > 0 {
                    self.progressView.setProgress(Float(fraction), animated: true)
                    if let item = self.items.first(where: { if case .sending = $0.status { return true } else { return false } }) {
                        self.update(item, status: .sending(fraction))
                    }
                }
            }
        }
    }

    private func stopProgressTimer() {
        DispatchQueue.main.async {
            self.progressTimer?.invalidate()
            self.progressTimer = nil
        }
    }

    // MARK: - Notification

    private func notifyCompletion(sent: Int, total: Int, device: String) {
        let content = UNMutableNotificationContent()
        if sent == total {
            content.title = "Sent to \(device)"
            content.body = total == 1 ? "Your item was delivered." : "\(total) items delivered."
        } else {
            content.title = "Send incomplete"
            content.body = "\(sent) of \(total) items delivered to \(device)."
        }
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }
}
