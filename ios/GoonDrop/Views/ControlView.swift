import SwiftUI

/// Control tab: remote keyboard, media/volume keys, trackpad mouse, and power
/// on the connected Windows PC — all forwarded by the local launcher.
struct ControlView: View {
    @ObservedObject private var client = GoonDropClient.shared

    @State private var textToType = ""
    @State private var powerAction: PowerAction?

    var body: some View {
        Form {
            if !client.isConnected {
                Section {
                    HStack(spacing: 10) {
                        Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                            .foregroundColor(.orange)
                        Text("Connect to your PC first — control commands ride the existing secure connection.")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                    }
                }
            }

            Section("Type on PC keyboard") {
                TextField("What should the PC type?", text: $textToType, axis: .vertical)
                    .lineLimit(1...4)
                HStack(spacing: 8) {
                    Button {
                        client.typeOnPC(textToType)
                    } label: {
                        Label("Type it", systemImage: "keyboard")
                    }
                    .disabled(textToType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !client.isConnected)

                    Spacer()

                    Button("↵ Enter") { client.typeOnPC(textToType + "{ENTER}") }
                        .disabled(textToType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !client.isConnected)
                    Button("⌫ Bksp") { client.typeOnPC(textToType + "{BACKSPACE}") }
                        .disabled(textToType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !client.isConnected)
                }
                .font(.footnote)
            }

            Section("Media & volume") {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                    mediaButton("playpause.fill", "media_play")
                    mediaButton("backward.end.fill", "media_prev")
                    mediaButton("forward.end.fill", "media_next")
                    mediaButton("speaker.wave.2.fill", "volume_up")
                    mediaButton("speaker.wave.1.fill", "volume_down")
                    mediaButton("speaker.slash.fill", "volume_mute")
                }
                .padding(.vertical, 4)
            }

            Section {
                TrackpadView(client: client)
                    .frame(height: 180)
                    .listRowInsets(EdgeInsets())
            } header: {
                Text("Mouse")
            } footer: {
                Text("Drag to move the cursor · tap to left-click · hold to right-click")
            }

            Section("Power") {
                Button {
                    client.lockPC()
                } label: {
                    Label("Lock", systemImage: "lock.fill")
                }
                .disabled(!client.isConnected)

                Button {
                    powerAction = .sleep
                } label: {
                    Label("Sleep", systemImage: "powersleep")
                }
                .disabled(!client.isConnected)

                Button {
                    powerAction = .restart
                } label: {
                    Label("Restart", systemImage: "arrow.clockwise.circle")
                }
                .disabled(!client.isConnected)

                Button {
                    powerAction = .shutdown
                } label: {
                    Label("Shut down", systemImage: "power")
                        .foregroundColor(.red)
                }
                .disabled(!client.isConnected)
            }

            Section("System") {
                Button {
                    client.pingPC()
                } label: {
                    Label("Find My PC", systemImage: "bell.and.waves.left.and.right")
                }
                .disabled(!client.isConnected)

                Button {
                    client.openWindowsUpdate()
                } label: {
                    Label("Check for Windows updates", systemImage: "gearshape.2")
                }
                .disabled(!client.isConnected)
            }

            if let lastError = client.lastError, client.lastError?.isEmpty == false {
                Section {
                    Text(lastError)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }
        }
        .navigationTitle("Control")
        .confirmationDialog(
            powerAction?.title ?? "",
            isPresented: Binding(
                get: { powerAction != nil },
                set: { if !$0 { powerAction = nil } }
            ),
            titleVisibility: .visible,
            presenting: powerAction
        ) { action in
            Button("Yes, \(action.verb)", role: .destructive) {
                action.run(with: client)
            }
            Button("Cancel", role: .cancel) {}
        } message: { action in
            Text(action.message)
        }
    }

    private func mediaButton(_ icon: String, _ command: String) -> some View {
        Button {
            client.mediaCommand(command)
        } label: {
            Image(systemName: icon)
                .font(.system(size: 20))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Color(.secondarySystemGroupedBackground))
                .cornerRadius(10)
        }
        .buttonStyle(.plain)
        .disabled(!client.isConnected)
    }
}

private enum PowerAction: Identifiable {
    case sleep, restart, shutdown

    var id: Int { title.hashValue }

    var title: String {
        switch self {
        case .sleep: return "Sleep your PC?"
        case .restart: return "Restart your PC?"
        case .shutdown: return "Shut down your PC?"
        }
    }

    var verb: String {
        switch self {
        case .sleep: return "sleep it"
        case .restart: return "restart it"
        case .shutdown: return "shut it down"
        }
    }

    var message: String {
        switch self {
        case .sleep: return "The PC will suspend. Any paired apps stay connected and you can wake it with a key press."
        case .restart: return "About to restart the PC. Goon Drop will reconnect when it's back up."
        case .shutdown: return "The PC will power off. Start it again to continue using Goon Drop."
        }
    }

    @MainActor
    func run(with client: GoonDropClient) {
        switch self {
        case .sleep: client.sleepPC()
        case .restart: client.restartPC()
        case .shutdown: client.shutdownPC()
        }
    }
}

/// Drag to move the PC cursor, tap to left-click, press-and-hold for right-click.
private struct TrackpadView: View {
    @ObservedObject var client: GoonDropClient
    @State private var lastTranslation: CGSize = .zero
    @State private var didDrag = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16)
                .fill(Color.black.opacity(0.72))
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(Color.white.opacity(client.isConnected ? 0.25 : 0.1), lineWidth: 1)
                )

            VStack(spacing: 8) {
                Image(systemName: "cursorarrow.rays")
                    .font(.system(size: 28))
                    .foregroundColor(.white.opacity(client.isConnected ? 0.7 : 0.25))
                Text(client.isConnected ? "PC mouse" : "Waiting for PC…")
                    .font(.caption)
                    .foregroundColor(.white.opacity(0.6))
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .simultaneousGesture(
            DragGesture(minimumDistance: 1, coordinateSpace: .local)
                .onChanged { value in
                    guard client.isConnected else { return }
                    let dx = value.translation.width - lastTranslation.width
                    let dy = value.translation.height - lastTranslation.height
                    guard abs(dx) > 0.5 || abs(dy) > 0.5 else { return }
                    didDrag = true
                    let scale = 3.5
                    client.mouseMove(
                        dx: Double(max(-220, min(220, dx * scale))),
                        dy: Double(max(-220, min(220, dy * scale)))
                    )
                    lastTranslation = value.translation
                }
                .onEnded { _ in
                    lastTranslation = .zero
                    didDrag = false
                }
        )
        .simultaneousGesture(
            TapGesture()
                .onEnded {
                    guard client.isConnected, !didDrag else { return }
                    client.mouseClick(left: true)
                }
        )
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.6)
                .onEnded { _ in
                    guard client.isConnected else { return }
                    client.mouseClick(left: false)
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                }
        )
        .disabled(!client.isConnected)
        .padding(12)
    }
}