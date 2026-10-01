import SwiftUI

/// LAN chat with every other paired device, mirroring the web app's chat room.
struct ChatView: View {
    @ObservedObject private var client = GoonDropClient.shared
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            if client.chatMessages.isEmpty {
                Spacer()
                VStack(spacing: 10) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 40))
                        .foregroundColor(.secondary)
                    Text("No messages yet")
                        .font(.headline)
                    Text("Anything you send here appears on your PC and on every other paired device.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                }
                Spacer()
            } else {
                ScrollViewReader { proxy in
                    List {
                        ForEach(client.chatMessages) { message in
                            ChatBubble(message: message, isMine: message.isMine(deviceId: client.deviceId))
                                .id(message.id)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 3, leading: 12, bottom: 3, trailing: 12))
                        }
                    }
                    .listStyle(.plain)
                    .onChange(of: client.chatMessages.count) { count in
                        guard count > 0 else { return }
                        withAnimation { proxy.scrollTo(client.chatMessages[count - 1].id, anchor: .bottom) }
                    }
                    .onAppear {
                        if let last = client.chatMessages.last {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            Divider()

            HStack(spacing: 10) {
                TextField("Message your devices", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Color(.secondarySystemGroupedBackground))
                    .cornerRadius(18)
                    .onSubmit(send)

                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !client.isConnected)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)
        }
        .navigationTitle("Chat")
        .onAppear { client.requestChatHistory() }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        client.sendChat(text)
        draft = ""
    }
}

private struct ChatBubble: View {
    let message: GoonChatMessage
    let isMine: Bool

    var body: some View {
        HStack {
            if isMine { Spacer(minLength: 40) }

            VStack(alignment: isMine ? .trailing : .leading, spacing: 3) {
                Text(message.text)
                    .font(.callout)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(isMine ? Color.accentColor : Color(.secondarySystemGroupedBackground))
                    .foregroundColor(isMine ? .white : .primary)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                Text("\(isMine ? "You" : message.sourceDeviceName) · \(Self.time(message.timestamp))")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            if !isMine { Spacer(minLength: 40) }
        }
    }

    private static func time(_ millis: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(millis) / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = DateFormatter.isToday(date) ? "HH:mm" : "d MMM HH:mm"
        return formatter.string(from: date)
    }
}

private extension DateFormatter {
    static func isToday(_ date: Date) -> Bool {
        Calendar.current.isDateInToday(date)
    }
}
