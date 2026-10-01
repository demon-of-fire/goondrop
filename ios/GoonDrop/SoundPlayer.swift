import AVFoundation
import Foundation

/// Tiny synthesized tone player used to confirm remote actions on the phone.
///
/// The tones are generated in memory rather than shipped as audio files so the
/// IPA stays small and there is nothing to keep in sync. The audio session is
/// configured as `.playback` on purpose: a confirmation sound that the user
/// cannot hear because the ringer switch is off is worse than no sound at all.
@MainActor
final class SoundPlayer {
    static let shared = SoundPlayer()

    enum Tone {
        case ack
        case micMuted
        case micUnmuted
        case success
        case error

        /// (frequency, duration) pairs describing each little jingle.
        var notes: [(frequency: Double, seconds: Double)] {
            switch self {
            case .ack:
                return [(880, 0.06)]
            case .micMuted:
                // Falling two-tone: "going quiet".
                return [(660, 0.07), (392, 0.12)]
            case .micUnmuted:
                // Rising two-tone: "back live".
                return [(523, 0.07), (784, 0.12)]
            case .success:
                return [(659, 0.06), (880, 0.10)]
            case .error:
                return [(311, 0.10), (233, 0.16)]
            }
        }
    }

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let sampleRate: Double = 44_100
    private var isConfigured = false

    private init() {}

    private func configureIfNeeded() {
        guard !isConfigured else { return }
        isConfigured = true
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true, options: [])
        } catch {
            // Audio is a nicety here; if the session is unavailable the app
            // must keep working silently rather than trapping the user.
        }
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)
        engine.attach(player)
        if let format = format {
            engine.connect(player, to: engine.mainMixerNode, format: format)
        }
        engine.prepare()
        try? engine.start()
    }

    private func makeBuffer(notes: [(frequency: Double, seconds: Double)]) -> AVAudioPCMBuffer? {
        let totalFrames = AVAudioFrameCount(notes.reduce(0.0) { $0 + $1.seconds } * sampleRate)
        guard totalFrames > 0,
              let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: totalFrames)
        else { return nil }
        buffer.frameLength = totalFrames
        guard let channel = buffer.floatChannelData?[0] else { return nil }

        var frame: AVAudioFrameCount = 0
        for note in notes {
            let noteFrames = AVAudioFrameCount(note.seconds * sampleRate)
            for i in 0..<noteFrames {
                let t = Double(i) / sampleRate
                // Short attack/release ramp so the tone does not click.
                let envelope = min(1.0, t / 0.005) * min(1.0, (note.seconds - t) / 0.02)
                let clamped = envelope < 0 ? 0 : envelope
                channel[Int(frame) + Int(i)] = Float(sin(2.0 * .pi * note.frequency * t) * 0.28 * clamped)
            }
            frame += noteFrames
        }
        return buffer
    }

    func play(_ tone: Tone) {
        configureIfNeeded()
        guard engine.isRunning else {
            try? engine.start()
        }
        guard let buffer = makeBuffer(notes: tone.notes) else { return }
        // Duck whatever else is playing briefly so the confirmation is audible.
        try? AVAudioSession.sharedInstance().setActive(true, options: [])
        player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
        if !player.isPlaying { player.play() }
    }
}
