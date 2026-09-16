import SwiftUI
import UIKit

/// Clipboard tab: shared clipboard history. Tap an item to copy it to the iPhone
/// (it also writes to the PC clipboard via the server).
struct ClipboardView: View {
    @ObservedObject private var client = GoonDropClient.shared

    var body: some View {
        Form {
            Section {
                Button {
                    load()
                } label: {
                    Label("Refresh clipboard", systemImage: "arrow.clockwise")
                }
                if !client.clipboardItems.isEmpty {
                    Button(role: .destructive) {
                        client.clearClipboardHistory()
                    } label: {
                        Label("Clear history", systemImage: "trash")
                    }
                }
            }

            if client.clipboardItems.isEmpty {
                Section {
                    Text("Items synced from your PC and other devices will appear here.\nUse the Send tab to push text from your iPhone to the PC clipboard.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            } else {
                Section("Shared clipboard") {
                    ForEach(client.clipboardItems) { item in
                        Button {
                            copy(item)
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(item.text)
                                    .font(.system(size: 14))
                                    .foregroundColor(.primary)
                                    .lineLimit(4)
                                HStack(spacing: 6) {
                                    Image(systemName: item.kind == "url" ? "link" : "text.alignleft")
                                        .font(.caption2)
                                        .foregroundColor(.secondary)
                                    Text(item.sourceDeviceName)
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                    Spacer()
                                    Text(GoonFormat.relative(item.timestamp))
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }
            }
        }
        .navigationTitle("Clipboard")
        .onAppear {
            load()
        }
    }

    private func load() {
        if client.isConnected {
            client.requestClipboard()
        }
    }

    private func copy(_ item: GoonClipboard) {
        UIPasteboard.general.string = item.text
        client.statusMessage = "Copied to your clipboard"
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

#Preview {
    ClipboardView()
}