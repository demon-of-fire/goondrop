import SwiftUI

/// Media tab: one play/pause button that reflects what the PC is *actually*
/// doing, a "what's playing" card fed by the Windows launcher, and a mic
/// mute toggle that confirms audibly on the phone.
struct MediaView: View {
    @ObservedObject private var client = GoonDropClient.shared

    private var state: GoonMediaState { client.mediaState }

    var body: some View {
        Form {
            if !client.isConnected {
                Section {
                    Label {
                        Text("Connect to your PC first — media controls ride the existing secure connection.")
                    } icon: {
                        Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                            .foregroundColor(.orange)
                    }
                    .font(.footnote)
                }
            } else if !state.available {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("PC helper not detected", systemImage: "exclamationmark.triangle.fill")
                            .foregroundColor(.orange)
                        Text("Media and mic state comes from the Goon Drop launcher running on your PC. Start it (or restart it) to use these controls.")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                        Button("Check again") { client.requestMediaState() }
                            .font(.footnote)
                    }
                    .padding(.vertical, 4)
                }
            }

            nowPlayingSection

            Section {
                micToggle
            } header: {
                Text("Microphone")
            } footer: {
                Text("Mutes the microphone on your PC. Your iPhone plays a sound so you can confirm the change without being able to hear the PC.")
            }

            Section("PC sound") {
                volumeRow
            }

            Section("Track controls") {
                HStack(spacing: 10) {
                    mediaButton("backward.end.fill", label: "Previous", action: { client.skipPrevious() })
                    mediaButton(state.playing ? "pause.fill" : "play.fill",
                                label: state.playing ? "Pause" : "Play",
                                action: { client.togglePlayPause() },
                                emphasised: true)
                    mediaButton("forward.end.fill", label: "Next", action: { client.skipNext() })
                }
                .padding(.vertical, 2)
            }
        }
        .navigationTitle("Media")
        .onAppear {
            client.requestMediaState()
            client.refreshMediaStateOverHTTP()
        }
    }

    // MARK: - Now playing

    private var nowPlayingSection: some View {
        Section("Now playing") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Color.accentColor.opacity(state.playing ? 0.22 : 0.10))
                            .frame(width: 56, height: 56)
                        Image(systemName: state.hasTrack ? "waveform" : "music.note")
                            .font(.system(size: 24, weight: .medium))
                            .foregroundColor(state.hasTrack ? Color.accentColor : .secondary)
                            .scaleEffect(state.playing ? 1.08 : 1.0)
                            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: state.playing)
                    }

                    VStack(alignment: .leading, spacing: 3) {
                        Text(trackTitle)
                            .font(.headline)
                            .lineLimit(2)
                        Text(trackSubtitle)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 0)
                }

                HStack(spacing: 10) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                    Text(statusText)
                        .font(.footnote.weight(.medium))
                        .foregroundColor(.secondary)
                    Spacer()
                    if client.mediaPendingCommand {
                        ProgressView().controlSize(.small)
                    } else if state.available {
                        Text("updated \(Self.relativeTime(state.updatedAt))")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .padding(.vertical, 6)
        }
    }

    private var trackTitle: String {
        state.hasTrack ? state.title : "Nothing playing"
    }

    private var trackSubtitle: String {
        if !state.available { return "Waiting for your PC…" }
        guard state.hasTrack else { return "Start music or a video on your PC" }
        return state.appName.isEmpty ? "On your PC" : "In \(state.appName)"
    }

    private var statusText: String {
        guard state.available else { return "PC state unavailable" }
        guard state.hasTrack else { return "Idle" }
        return state.playing ? "Playing" : "Paused"
    }

    private var statusColor: Color {
        guard state.available, state.hasTrack else { return .gray }
        return state.playing ? .green : .orange
    }

    // MARK: - Microphone

    private var micToggle: some View {
        Button {
            client.toggleMicMute()
        } label: {
            HStack(spacing: 14) {
                Image(systemName: state.micMuted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 20, weight: .medium))
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(state.micMuted ? Color.red.opacity(0.18) : Color.green.opacity(0.18)))
                    .foregroundColor(state.micMuted ? .red : .green)

                VStack(alignment: .leading, spacing: 2) {
                    Text(state.micMuted ? "PC mic muted" : "PC mic live")
                        .font(.body.weight(.semibold))
                        .foregroundColor(.primary)
                    Text(state.micMuted ? "Tap to unmute" : "Tap to mute — you will hear a confirmation")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Spacer()

                Image(systemName: "speaker.wave.2.fill")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!client.isConnected || !state.available)
    }

    // MARK: - Volume

    private var volumeRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                mediaButton("speaker.slash.fill", label: "Mute", action: { client.toggleSpeakerMute() })
                mediaButton("speaker.wave.1.fill", label: "Down", action: { client.volumeDown() })
                mediaButton("speaker.wave.2.fill", label: "Up", action: { client.volumeUp() })
            }

            if state.volume >= 0 {
                HStack(spacing: 8) {
                    Image(systemName: state.volumeMuted ? "speaker.slash.fill" : "speaker.wave.1.fill")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    ProgressView(value: state.volumeMuted ? 0 : state.volume)
                        .tint(state.volumeMuted ? .red : .accentColor)
                    Text(state.volumeMuted ? "Muted" : "\(Int(state.volume * 100))%")
                        .font(.caption.monospacedDigit())
                        .foregroundColor(.secondary)
                        .frame(width: 52, alignment: .trailing)
                }
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Buttons

    private func mediaButton(_ icon: String, label: String,
                             action: @escaping () -> Void,
                             emphasised: Bool = false) -> some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: emphasised ? 24 : 18, weight: .medium))
                Text(label)
                    .font(.caption2.weight(.medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, emphasised ? 16 : 11)
            .background(emphasised ? Color.accentColor.opacity(0.16) : Color(.secondarySystemGroupedBackground))
            .foregroundColor(emphasised ? Color.accentColor : .primary)
            .cornerRadius(12)
        }
        .buttonStyle(.plain)
        .disabled(!client.isConnected || !state.available)
    }

    private static func relativeTime(_ millis: Int) -> String {
        guard millis > 0 else { return "—" }
        let seconds = max(0, Int(Date().timeIntervalSince1970) - millis / 1000)
        if seconds < 5 { return "just now" }
        if seconds < 60 { return "\(seconds)s ago" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        return "\(seconds / 3600)h ago"
    }
}
