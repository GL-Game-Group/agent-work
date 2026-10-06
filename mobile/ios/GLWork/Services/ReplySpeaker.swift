import AVFoundation
import Foundation

/// 播报: reads the Agent's finished replies aloud, in the voice the member picked.
/// The choice is kept on this phone.
@MainActor
final class ReplySpeaker: ObservableObject {
    static let shared = ReplySpeaker()

    private static let enabledKey = "glwork.speak.enabled"
    private static let voiceKey = "glwork.speak.voice"

    @Published var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: Self.enabledKey)
            if !isEnabled { stop() }
        }
    }
    @Published var voiceIdentifier: String? {
        didSet { UserDefaults.standard.set(voiceIdentifier, forKey: Self.voiceKey) }
    }

    private let synthesizer = AVSpeechSynthesizer()

    private init() {
        isEnabled = UserDefaults.standard.bool(forKey: Self.enabledKey)
        voiceIdentifier = UserDefaults.standard.string(forKey: Self.voiceKey)
    }

    /// Chinese voices on this phone, the better ones first.
    var voices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("zh") }
            .sorted { ($0.quality.rawValue, $0.name) > ($1.quality.rawValue, $1.name) }
    }

    var voiceName: String {
        voices.first(where: { $0.identifier == voiceIdentifier })?.name ?? remoteLocalized("系统默认")
    }

    /// Read one reply aloud, when 播报 is on.
    func speakReply(_ text: String) {
        guard isEnabled else { return }
        speak(Self.speakable(text))
    }

    /// Try a voice out.
    func preview(_ identifier: String?) {
        speak(remoteLocalized("你好，我会把 Agent 的回复读给你听。"), voice: identifier)
    }

    func stop() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
    }

    private func speak(_ text: String, voice identifier: String? = nil) {
        guard !text.isEmpty else { return }
        stop()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
        try? AVAudioSession.sharedInstance().setActive(true)
        let utterance = AVSpeechUtterance(string: text)
        let id = identifier ?? voiceIdentifier
        utterance.voice = id.flatMap(AVSpeechSynthesisVoice.init(identifier:)) ?? AVSpeechSynthesisVoice(language: "zh-CN")
        synthesizer.speak(utterance)
    }

    /// What is worth hearing: no code blocks, no Markdown marks, not endless.
    static func speakable(_ text: String) -> String {
        var value = text.replacingOccurrences(of: "```[\\s\\S]*?```", with: remoteLocalized("（代码略）"), options: .regularExpression)
        value = value.replacingOccurrences(of: "`([^`]*)`", with: "$1", options: .regularExpression)
        value = value.replacingOccurrences(of: "!?\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        value = value.replacingOccurrences(of: "(?m)^\\s{0,3}(#{1,6}|[-*+]|\\d+\\.|>)\\s+", with: "", options: .regularExpression)
        value = value.replacingOccurrences(of: "[*_~|]", with: "", options: .regularExpression)
        value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.count > 1_200 ? String(value.prefix(1_200)) + remoteLocalized("……后面的内容请在屏幕上查看。") : value
    }
}
