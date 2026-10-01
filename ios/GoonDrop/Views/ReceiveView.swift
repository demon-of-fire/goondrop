import SwiftUI

/// Receive files offered by the Windows launcher, then save or open them through iOS.
struct ReceiveView: View {
    @ObservedObject private var client = GoonDropClient.shared

    var body: some View {
        NavigationStack {
            Group {
                if client.incomingFiles.isEmpty {
                    ContentUnavailableView(
                        "No incoming files",
                        systemImage: "tray.and.arrow.down",
                        description: Text("Files sent from the Windows launcher will appear here. Keep Goon Drop connected, then tap Accept.")
                    )
                } else {
                    List {
                        ForEach(client.incomingFiles) { file in
                            Section {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack(alignment: .top) {
                                        Image(systemName: icon(for: file.mimeType))
                                            .font(.title2)
                                            .foregroundStyle(.tint)
                                            .frame(width: 30)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(file.fileName).font(.headline).lineLimit(2)
                                            Text("From \(file.sourceDeviceName) · \(ByteCountFormatter.string(fromByteCount: file.fileSize, countStyle: .file))")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    controls(for: file)
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Receive")
        }
    }

    @ViewBuilder
    private func controls(for file: IncomingFile) -> some View {
        switch file.status {
        case .offered:
            HStack {
                Button("Accept") { client.acceptIncomingFile(file) }.buttonStyle(.borderedProminent)
                Button("Decline", role: .destructive) { client.declineIncomingFile(file) }.buttonStyle(.bordered)
            }
        case .waitingForFile:
            Button("Download to iPhone") { client.downloadIncomingFile(file) }.buttonStyle(.borderedProminent)
        case .downloading:
            HStack { ProgressView(); Text("Downloading…").foregroundStyle(.secondary) }
        case .ready:
            if let url = file.localURL {
                ShareLink(item: url) { Label("Save or Open File", systemImage: "square.and.arrow.up") }
                    .buttonStyle(.borderedProminent)
            }
        case .declined:
            Label("Declined", systemImage: "xmark.circle").foregroundStyle(.secondary)
        case .failed:
            Text(file.errorMessage ?? "Download failed").foregroundStyle(.red)
            Button("Try again") { client.downloadIncomingFile(file) }.buttonStyle(.bordered)
        }
    }

    private func icon(for mimeType: String) -> String {
        if mimeType.hasPrefix("image/") { return "photo" }
        if mimeType.hasPrefix("video/") { return "video" }
        if mimeType.hasPrefix("audio/") { return "music.note" }
        if mimeType.contains("pdf") { return "doc.richtext" }
        return "doc"
    }
}
