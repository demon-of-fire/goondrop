import SwiftUI
import UIKit

/// Clipboard tab: shared clipboard history with search, pinning, and the ability
/// to push a past entry back to the PC clipboard.
struct ClipboardView: View {
    @ObservedObject private var client = GoonDropClient.shared
    @State private var query = ""

    private var pinnedItems: [GoonClipboard] {
        filtered.filter { $0.pinned }
    }

    private var recentItems: [GoonClipboard] {
        filtered.filter { !$0.pinned }
    }

    private var filtered: [GoonClipboard] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return client.clipboardItems }
        return client.clipboardItems.filter {
            $0.text.lowercased().contains(q) || $0.sourceDeviceName.lowercased().contains(q)
        }
    }

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
            } else if filtered.isEmpty {
                Section {
                    Text("No matches for “\(query)”.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            } else {
                if !pinnedItems.isEmpty {
                    Section("Pinned") {
                        ForEach(pinnedItems) { item in
                            row(item)
                        }
                    }
                }
                if !recentItems.isEmpty {
                    Section("Recent") {
                        ForEach(recentItems) { item in
                            row(item)
                        }
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "Search clipboard")
        .navigationTitle("Clipboard")
        .onAppear {
            load()
        }
    }

    @ViewBuilder
    private func row(_ item: GoonClipboard) -> some View {
        Button {
            copy(item)
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(item.text)
                    .font(.system(size: 14))
                    .foregroundColor(.primary)
                    .lineLimit(4)
                HStack(spacing: 6) {
                    if item.pinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundColor(.orange)
                    } else {
                        Image(systemName: item.kind == "url" ? "link" : "text.alignleft")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
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
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                client.pinClipboard(item, pinned: !item.pinned)
            } label: {
                Label(item.pinned ? "Unpin" : "Pin", systemImage: item.pinned ? "pin.slash" : "pin")
            }
            .tint(.orange)
        }
        .contextMenu {
            Button {
                copy(item)
            } label: {
                Label("Copy to iPhone", systemImage: "doc.on.doc")
            }
            Button {
                client.restoreClipboardToPC(item)
            } label: {
                Label("Copy to PC clipboard", systemImage: "desktopcomputer")
            }
            Button {
                client.pinClipboard(item, pinned: !item.pinned)
            } label: {
                Label(item.pinned ? "Unpin" : "Pin", systemImage: item.pinned ? "pin.slash" : "pin")
            }
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
