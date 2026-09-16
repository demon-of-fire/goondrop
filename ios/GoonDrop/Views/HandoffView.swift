import SwiftUI
import UIKit

/// Handoff tab: links shared between the PC browser and your iPhone.
/// Tap a received link to open it on the iPhone; type a URL to open it on the PC.
struct HandoffView: View {
    @ObservedObject private var client = GoonDropClient.shared
    @State private var urlToSend = ""
    @State private var showSafariLink: String?

    var body: some View {
        Form {
            Section("Open a link on your PC") {
                TextField("https://example.com", text: $urlToSend)
                    .keyboardType(.URL)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                Button("Send to PC browser") {
                    client.sendLink(urlToSend)
                    if client.lastError == nil { urlToSend = "" }
                }
                .disabled(!client.isConnected)
                if !client.isConnected {
                    Text("Connect to a PC to hand links to it.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }

            if client.links.isEmpty {
                Section("Handoff history") {
                    Text("Links opened on your PC browser will appear here. Tap one to open it on your iPhone.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            } else {
                Section("Handoff history") {
                    ForEach(client.links) { link in
                        Button {
                            openInSafari(link.url)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(link.url)
                                    .font(.system(size: 14))
                                    .foregroundColor(.primary)
                                    .lineLimit(2)
                                if !link.title.isEmpty && link.title != link.url {
                                    Text(link.title)
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                        .lineLimit(1)
                                }
                                HStack {
                                    Text("From \(link.sourceDeviceName)")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                    Spacer()
                                    Text(GoonFormat.relative(link.timestamp))
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
        .navigationTitle("Handoff")
    }

    private func openInSafari(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        UIApplication.shared.open(url)
    }
}

#Preview {
    HandoffView()
}