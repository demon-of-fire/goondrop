import SwiftUI

/// Quick notes pushed to the PC and every other device, plus the shared
/// to-do checklist. Both are two-way: anything the PC or web app writes shows
/// up here, and anything changed here is broadcast straight back out.
struct NotesView: View {
    @ObservedObject private var client = GoonDropClient.shared
    @State private var noteDraft = ""
    @State private var itemDraft = ""
    @State private var confirmWipe = false

    var body: some View {
        Form {
            Section("Send a note") {
                TextField("Type a snippet to push to your PC", text: $noteDraft, axis: .vertical)
                    .lineLimit(1...5)
                Button {
                    let text = noteDraft
                    noteDraft = ""
                    client.sendNote(text)
                } label: {
                    Label("Send note", systemImage: "paperplane.fill")
                }
                .disabled(noteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !client.isConnected)

                if !client.notes.isEmpty {
                    ForEach(client.notes) { note in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(note.text)
                                .font(.callout)
                            Text("\(note.sourceDeviceName) · \(Self.time(note.timestamp))")
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }

            Section("Shared checklist") {
                HStack {
                    TextField("Add an item", text: $itemDraft)
                        .onSubmit(addItem)
                    Button(action: addItem) {
                        Image(systemName: "plus.circle.fill").font(.system(size: 22))
                    }
                    .disabled(itemDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if client.checklist.isEmpty {
                    Text("Nothing on the list yet.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                } else {
                    ForEach(client.checklist) { item in
                        HStack(spacing: 12) {
                            Button {
                                client.toggleChecklistItem(item)
                            } label: {
                                Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 21))
                                    .foregroundColor(item.done ? Color.accentColor : .secondary)
                            }
                            .buttonStyle(.plain)

                            Text(item.text)
                                .strikethrough(item.done, color: .secondary)
                                .foregroundColor(item.done ? .secondary : .primary)

                            Spacer()

                            Button {
                                client.removeChecklistItem(item)
                            } label: {
                                Image(systemName: "minus.circle")
                                    .foregroundColor(.red.opacity(0.7))
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    Button(role: .destructive) {
                        client.clearChecklist()
                    } label: {
                        Label("Clear list", systemImage: "trash")
                    }
                }
            }

            Section {
                Button(role: .destructive) {
                    confirmWipe = true
                } label: {
                    Label("Wipe everything on all devices", systemImage: "exclamationmark.triangle.fill")
                }
                .disabled(!client.isConnected)
            } header: {
                Text("Danger zone")
            } footer: {
                Text("Clears the clipboard history, chat, notes and checklist on your PC and on every paired device. Files on disk are not touched.")
            }
        }
        .navigationTitle("Notes")
        .confirmationDialog("Wipe Goon Drop everywhere?", isPresented: $confirmWipe, titleVisibility: .visible) {
            Button("Wipe everything", role: .destructive) { client.triggerNuclearWipe() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This clears shared data on your PC and every paired device.")
        }
    }

    private func addItem() {
        let text = itemDraft
        itemDraft = ""
        client.addChecklistItem(text)
    }

    private static func time(_ millis: Int) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(millis) / 1000))
    }
}
