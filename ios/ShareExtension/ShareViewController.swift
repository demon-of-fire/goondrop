import UIKit
import Social
import UniformTypeIdentifiers

class ShareViewController: UIViewController {
    
    // UI Elements
    private let cardView = UIView()
    private let iconImageView = UIImageView()
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private let previewImageView = UIImageView()
    private let statusLabel = UILabel()
    private let progressView = UIProgressView(progressViewStyle: .default)
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let actionButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    
    private var isSending = false
    private let config = SharedConfig.shared
    
    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        processSharedItems()
    }
    
    private func setupUI() {
        view.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        
        // Card container
        cardView.translatesAutoresizingMaskIntoConstraints = false
        cardView.backgroundColor = .secondarySystemBackground
        cardView.layer.cornerRadius = 20
        cardView.layer.shadowColor = UIColor.black.cgColor
        cardView.layer.shadowOpacity = 0.25
        cardView.layer.shadowOffset = CGSize(width: 0, height: 10)
        cardView.layer.shadowRadius = 20
        cardView.clipsToBounds = true
        view.addSubview(cardView)
        
        // App Icon
        iconImageView.translatesAutoresizingMaskIntoConstraints = false
        iconImageView.image = UIImage(systemName: "paperplane.circle.fill")
        iconImageView.tintColor = .systemBlue
        iconImageView.contentMode = .scaleAspectFit
        cardView.addSubview(iconImageView)
        
        // Title
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.text = "Goon Drop"
        titleLabel.font = .systemFont(ofSize: 18, weight: .bold)
        titleLabel.textAlignment = .center
        cardView.addSubview(titleLabel)
        
        // Subtitle (Target PC)
        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false
        subtitleLabel.text = targetSummary()
        subtitleLabel.font = .systemFont(ofSize: 13, weight: .regular)
        subtitleLabel.textColor = .secondaryLabel
        subtitleLabel.textAlignment = .center
        cardView.addSubview(subtitleLabel)
        
        // Preview Image (for photos)
        previewImageView.translatesAutoresizingMaskIntoConstraints = false
        previewImageView.contentMode = .scaleAspectFill
        previewImageView.clipsToBounds = true
        previewImageView.layer.cornerRadius = 12
        previewImageView.backgroundColor = .tertiarySystemBackground
        previewImageView.isHidden = true
        cardView.addSubview(previewImageView)
        
        // Status label
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.text = "Preparing item..."
        statusLabel.font = .systemFont(ofSize: 14, weight: .medium)
        statusLabel.textColor = .label
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        cardView.addSubview(statusLabel)
        
        // Progress view
        progressView.translatesAutoresizingMaskIntoConstraints = false
        progressView.progress = 0.0
        progressView.isHidden = true
        cardView.addSubview(progressView)
        
        // Activity indicator
        activityIndicator.translatesAutoresizingMaskIntoConstraints = false
        activityIndicator.hidesWhenStopped = true
        activityIndicator.startAnimating()
        cardView.addSubview(activityIndicator)
        
        // Cancel button
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
        cancelButton.tintColor = .secondaryLabel
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cardView.addSubview(cancelButton)
        
        // Layout Constraints
        NSLayoutConstraint.activate([
            cardView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cardView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            cardView.widthAnchor.constraint(equalToConstant: 320),
            cardView.heightAnchor.constraint(greaterThanOrEqualToConstant: 240),
            
            iconImageView.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 20),
            iconImageView.centerXAnchor.constraint(equalTo: cardView.centerXAnchor),
            iconImageView.widthAnchor.constraint(equalToConstant: 44),
            iconImageView.heightAnchor.constraint(equalToConstant: 44),
            
            titleLabel.topAnchor.constraint(equalTo: iconImageView.bottomAnchor, constant: 8),
            titleLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 16),
            titleLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -16),
            
            subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
            subtitleLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 16),
            subtitleLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -16),
            
            previewImageView.topAnchor.constraint(equalTo: subtitleLabel.bottomAnchor, constant: 12),
            previewImageView.centerXAnchor.constraint(equalTo: cardView.centerXAnchor),
            previewImageView.widthAnchor.constraint(equalToConstant: 100),
            previewImageView.heightAnchor.constraint(equalToConstant: 100),
            
            statusLabel.topAnchor.constraint(equalTo: previewImageView.bottomAnchor, constant: 12),
            statusLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -16),
            
            progressView.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 10),
            progressView.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 24),
            progressView.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -24),
            progressView.heightAnchor.constraint(equalToConstant: 4),
            
            activityIndicator.topAnchor.constraint(equalTo: progressView.bottomAnchor, constant: 10),
            activityIndicator.centerXAnchor.constraint(equalTo: cardView.centerXAnchor),
            
            cancelButton.topAnchor.constraint(equalTo: activityIndicator.bottomAnchor, constant: 12),
            cancelButton.centerXAnchor.constraint(equalTo: cardView.centerXAnchor),
            cancelButton.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -16)
        ])
    }
    
    @objc private func cancelTapped() {
        extensionContext?.cancelRequest(withError: NSError(domain: "GoonDrop", code: -1, userInfo: [NSLocalizedDescriptionKey: "User cancelled"]))
    }
    
    private func finishSuccessfully() {
        DispatchQueue.main.async {
            self.activityIndicator.stopAnimating()
            self.progressView.isHidden = true
            self.statusLabel.text = "Sent to PC!"
            self.iconImageView.image = UIImage(systemName: "checkmark.circle.fill")
            self.iconImageView.tintColor = .systemGreen
            
            // Haptic feedback
            let feedback = UINotificationFeedbackGenerator()
            feedback.notificationOccurred(.success)
            
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            }
        }
    }
    
    private func finishWithError(_ message: String) {
        DispatchQueue.main.async {
            self.activityIndicator.stopAnimating()
            self.statusLabel.text = message
            self.iconImageView.image = UIImage(systemName: "exclamationmark.circle.fill")
            self.iconImageView.tintColor = .systemRed
            self.cancelButton.setTitle("Close", for: .normal)
        }
    }
    
    // MARK: - Process Items
    
    private func processSharedItems() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem], !items.isEmpty else {
            finishWithError("No items found to share")
            return
        }
        
        for item in items {
            guard let attachments = item.attachments else { continue }
            
            for provider in attachments {
                // 1. Check for URL (Safari links, YouTube, Twitter)
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] (data, error) in
                        guard let self = self else { return }
                        if let url = data as? URL {
                            self.sendURL(url)
                        } else {
                            self.finishWithError("Could not read URL")
                        }
                    }
                    return
                }
                
                // 2. Check for Image
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { [weak self] (item, error) in
                        guard let self = self else { return }
                        if let imageURL = item as? URL {
                            if let data = try? Data(contentsOf: imageURL) {
                                self.showThumbnail(data: data)
                                self.uploadFile(data: data, fileName: imageURL.lastPathComponent, mimeType: "image/jpeg")
                            }
                        } else if let image = item as? UIImage {
                            if let data = image.jpegData(compressionQuality: 0.9) {
                                self.showThumbnail(data: data)
                                let fileName = "airdrop_\(Int(Date().timeIntervalSince1970)).jpg"
                                self.uploadFile(data: data, fileName: fileName, mimeType: "image/jpeg")
                            }
                        } else if let data = item as? Data {
                            self.showThumbnail(data: data)
                            let fileName = "airdrop_\(Int(Date().timeIntervalSince1970)).jpg"
                            self.uploadFile(data: data, fileName: fileName, mimeType: "image/jpeg")
                        } else {
                            self.finishWithError("Could not process image")
                        }
                    }
                    return
                }
                
                // 3. Check for Movie / Video
                if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.movie.identifier, options: nil) { [weak self] (item, error) in
                        guard let self = self else { return }
                        if let movieURL = item as? URL {
                            if let data = try? Data(contentsOf: movieURL) {
                                self.uploadFile(data: data, fileName: movieURL.lastPathComponent, mimeType: "video/mp4")
                            }
                        } else {
                            self.finishWithError("Could not read video")
                        }
                    }
                    return
                }
                
                // 4. Check for Document / File / PDF
                if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.data.identifier, options: nil) { [weak self] (item, error) in
                        guard let self = self else { return }
                        if let fileURL = item as? URL {
                            if let data = try? Data(contentsOf: fileURL) {
                                self.uploadFile(data: data, fileName: fileURL.lastPathComponent, mimeType: "application/octet-stream")
                            }
                        } else if let data = item as? Data {
                            let fileName = "file_\(Int(Date().timeIntervalSince1970)).bin"
                            self.uploadFile(data: data, fileName: fileName, mimeType: "application/octet-stream")
                        } else {
                            self.finishWithError("Could not read file data")
                        }
                    }
                    return
                }
                
                // 5. Check for Plain Text
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [weak self] (item, error) in
                        guard let self = self else { return }
                        if let text = item as? String {
                            // Check if text is a URL
                            if text.hasPrefix("http://") || text.hasPrefix("https://"), let url = URL(string: text) {
                                self.sendURL(url)
                            } else {
                                self.sendClipboardText(text)
                            }
                        } else {
                            self.finishWithError("Could not read text")
                        }
                    }
                    return
                }
            }
        }
        
        finishWithError("No supported item found to share")
    }
    
    private func showThumbnail(data: Data) {
        DispatchQueue.main.async {
            self.previewImageView.image = UIImage(data: data)
            self.previewImageView.isHidden = false
        }
    }
    
    // MARK: - Networking

    private struct TargetServer {
        let host: String
        let port: Int
        let pairingCode: String
    }

    /// Where to send the item. Prefers the saved config (App Group, when signed
    /// with one) and falls back to live UDP discovery so the share sheet works
    /// even when sideloaded without an App Group (free Apple ID / SideStore).
    private func resolveTargetAsync(completion: @escaping (TargetServer?) -> Void) {
        if config.isConfigured && !config.serverHost.isEmpty && config.serverHost != "192.168.1.100" {
            completion(TargetServer(host: config.serverHost, port: config.serverPort, pairingCode: config.pairingCode))
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let server = LANDiscovery.discover(timeout: 1.5).first
            DispatchQueue.main.async {
                completion(server.map { TargetServer(host: $0.ip, port: $0.port, pairingCode: $0.pairingCode) })
            }
        }
    }

    private func targetSummary() -> String {
        if config.isConfigured && !config.serverHost.isEmpty && config.serverHost != "192.168.1.100" {
            return "PC: \(config.serverHost):\(config.serverPort)"
        }
        return "Searching for your PC..."
    }

    private func endpoint(_ target: TargetServer, _ path: String) -> URL? {
        let scheme = config.useHttps ? "https" : "http"
        return URL(string: "\(scheme)://\(target.host):\(target.port)\(path)")
    }

    private func sendURL(_ url: URL) {
        DispatchQueue.main.async {
            self.statusLabel.text = "Searching for your PC..."
        }
        resolveTargetAsync { [weak self] target in
            guard let self = self else { return }
            guard let target = target, let endpoint = self.endpoint(target, "/api/handoff") else {
                self.finishWithError("No Goon Drop PC found")
                return
            }
            
            DispatchQueue.main.async {
                self.subtitleLabel.text = "PC: \(target.host):\(target.port)"
                self.statusLabel.text = "Handoff to PC..."
            }
            
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if !target.pairingCode.isEmpty {
                request.setValue(target.pairingCode, forHTTPHeaderField: "x-goondrop-code")
            }
            
            let payload = ["url": url.absoluteString]
            request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
            
            let session = SharedConfig.makeLANSession()
            session.dataTask(with: request) { (data, response, error) in
                if let error = error {
                    self.finishWithError("Transfer failed: \(error.localizedDescription)")
                    return
                }
                if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                    self.finishSuccessfully()
                } else {
                    self.finishWithError("PC rejected request")
                }
            }.resume()
        }
    }
    
    private func sendClipboardText(_ text: String) {
        DispatchQueue.main.async {
            self.statusLabel.text = "Searching for your PC..."
        }
        resolveTargetAsync { [weak self] target in
            guard let self = self else { return }
            guard let target = target, let endpoint = self.endpoint(target, "/api/clipboard") else {
                self.finishWithError("No Goon Drop PC found")
                return
            }
            
            DispatchQueue.main.async {
                self.subtitleLabel.text = "PC: \(target.host):\(target.port)"
                self.statusLabel.text = "Copying to PC clipboard..."
            }
            
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if !target.pairingCode.isEmpty {
                request.setValue(target.pairingCode, forHTTPHeaderField: "x-goondrop-code")
            }
            
            let payload = ["text": text]
            request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
            
            let session = SharedConfig.makeLANSession()
            session.dataTask(with: request) { (data, response, error) in
                if let error = error {
                    self.finishWithError("Transfer failed: \(error.localizedDescription)")
                    return
                }
                self.finishSuccessfully()
            }.resume()
        }
    }
    
    private func uploadFile(data: Data, fileName: String, mimeType: String) {
        DispatchQueue.main.async {
            self.statusLabel.text = "Searching for your PC..."
        }
        resolveTargetAsync { [weak self] target in
            guard let self = self else { return }
            guard let target = target, let endpoint = self.endpoint(target, "/api/drop") else {
                self.finishWithError("No Goon Drop PC found")
                return
            }
            
            DispatchQueue.main.async {
                self.subtitleLabel.text = "PC: \(target.host):\(target.port)"
                self.statusLabel.text = "Dropping to PC: \(fileName)"
                self.progressView.isHidden = false
                self.progressView.progress = 0.2
            }
            
            let boundary = "Boundary-\(UUID().uuidString)"
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            if !target.pairingCode.isEmpty {
                request.setValue(target.pairingCode, forHTTPHeaderField: "x-goondrop-code")
            }
            
            var body = Data()
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
            body.append(data)
            body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
            
            let session = SharedConfig.makeLANSession()
            let task = session.uploadTask(with: request, from: body) { (data, response, error) in
                if let error = error {
                    self.finishWithError("Drop failed: \(error.localizedDescription)")
                    return
                }
                if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                    self.finishSuccessfully()
                } else {
                    self.finishWithError("PC server error (\((response as? HTTPURLResponse)?.statusCode ?? 0))")
                }
            }
            task.resume()
        }
    }
}
