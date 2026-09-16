import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Send tab: photos, files, text, and links — all dropped straight onto the PC.
struct SendView: View {
    @ObservedObject private var client = GoonDropClient.shared

    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showFileImporter = false
    @State private var textToSend = ""
    @State private var urlToSend = ""
    @State private var isSending = false
    @State private var sendStatus: String?
    @State private var sentCount = 0
    @State private var totalCount = 0

    var body: some View {
        Form {
            if !client.isConnected {
                Section {
                    HStack(spacing: 10) {
                        Image(systemName: "wifi.exclamationmark")
                            .foregroundColor(.orange)
                        Text("Not connected to a PC. Go to the Devices tab and scan your Wi-Fi network first.")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                    }
                }
            }

            Section("Photos") {
                PhotosPicker(selection: $selectedPhotos, maxSelectionCount: 30, matching: .images) {
                    Label("Pick photos to drop", systemImage: "photo.on.rectangle.angled")
                }
                if !selectedPhotos.isEmpty && client.isConnected {
                    Button("Send \(selectedPhotos.count) photo(s)") {
                        sendPhotos()
                    }
                    .disabled(isSending)
                }
            }

            Section("Files") {
                Button {
                    showFileImporter = true
                } label: {
                    Label("Pick files to drop", systemImage: "folder")
                }
                .fileImporter(
                    isPresented: $showFileImporter,
                    allowedContentTypes: [.item],
                    allowsMultipleSelection: true
                ) { result in
                    handleFiles(result)
                }
            }

            Section("Text to PC clipboard") {
                TextField("Paste or type text…", text: $textToSend, axis: .vertical)
                    .lineLimit(1...4)
                Button("Send text") {
                    sendText()
                }
                .disabled(isSending || !client.isConnected)
            }

            Section("Link to PC browser") {
                TextField("https://example.com", text: $urlToSend)
                    .keyboardType(.URL)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                Button("Open on PC") {
                    sendLink()
                }
                .disabled(isSending || !client.isConnected)
            }

            if isSending || sendStatus != nil {
                Section {
                    HStack {
                        if isSending {
                            ProgressView().controlSize(.small)
                        }
                        Text(sendStatus ?? "")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Send")
    }

    // MARK: - Photos

    private func sendPhotos() {
        let items = selectedPhotos
        guard !items.isEmpty, client.isConnected else { return }
        startBatch(count: items.count, label: "Preparing…")
        Task {
            for (index, item) in items.enumerated() {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    let name = "photo_\(Int(Date().timeIntervalSince1970))_\(index).jpg"
                    await sendData(data, fileName: name, mimeType: "image/jpeg")
                } else {
                    bumpSent()
                }
            }
            finishBatch(okText: "\(totalCount) photo(s) sent to PC")
            selectedPhotos = []
        }
    }

    // MARK: - Files

    private func handleFiles(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard client.isConnected else { return }
            startBatch(count: urls.count, label: "Preparing…")
            Task {
                for url in urls {
                    guard url.startAccessingSecurityScopedResource() else {
                        bumpSent()
                        continue
                    }
                    defer { url.stopAccessingSecurityScopedResource() }
                    if let data = try? Data(contentsOf: url) {
                        await sendData(data, fileName: url.lastPathComponent, mimeType: mimeType(for: url.pathExtension))
                    } else {
                        bumpSent()
                    }
                }
                finishBatch(okText: "\(totalCount) file(s) sent to PC")
            }
        case .failure:
            sendStatus = "Could not read the selected files."
        }
    }

    // MARK: - Text / links

    private func sendText() {
        client.pushClipboard(textToSend)
        if !textToSend.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            sendStatus = "Sent to PC clipboard"
            textToSend = ""
        }
    }

    private func sendLink() {
        client.sendLink(urlToSend)
        sendStatus = client.lastError ?? "Link opened on PC"
        if client.lastError == nil { urlToSend = "" }
    }

    // MARK: - Batching and upload

    private func startBatch(count: Int, label: String) {
        isSending = true
        totalCount = count
        sentCount = 0
        sendStatus = label
    }

    private func bumpSent() {
        sentCount += 1
        sendStatus = "Sent \(min(sentCount, totalCount))/\(totalCount)"
    }

    private func finishBatch(okText: String) {
        isSending = false
        sendStatus = okText
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if self.sendStatus == okText { self.sendStatus = nil }
        }
    }

    private func sendData(_ data: Data, fileName: String, mimeType: String) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            client.dropFile(data: data, fileName: fileName, mimeType: mimeType) { ok in
                self.bumpSent()
                cont.resume()
            }
        }
    }

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "heic", "heif": return "image/heic"
        case "mp4", "mov", "m4v": return "video/mp4"
        case "mp3", "m4a", "wav", "aac": return "audio/mpeg"
        case "pdf": return "application/pdf"
        case "zip": return "application/zip"
        case "txt", "md", "json", "csv": return "text/plain"
        default: return "application/octet-stream"
        }
    }
}