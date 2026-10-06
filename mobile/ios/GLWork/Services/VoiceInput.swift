import AVFoundation
import Foundation
import Speech

/// Hold-to-talk dictation: iOS speech recognition (Mandarin) on the microphone,
/// with the words recognized so far published as they come.
@MainActor
final class VoiceInput: ObservableObject {
    enum Failure: LocalizedError {
        case denied
        case unavailable
        case audio(String)

        var errorDescription: String? {
            switch self {
            case .denied: remoteLocalized("没有麦克风或语音识别权限：请在“设置 → GL Work”里打开。")
            case .unavailable: remoteLocalized("语音识别暂时不可用，请稍后再试。")
            case .audio(let reason): remoteLocalizedFormat("无法开始录音：%@", reason)
            }
        }
    }

    @Published private(set) var transcript = ""
    @Published private(set) var isRecording = false

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finished: CheckedContinuation<String, Never>?

    /// Ask for microphone and speech recognition once; true when both are allowed.
    func authorize() async -> Bool {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    func start() throws {
        guard !isRecording else { return }
        guard let recognizer, recognizer.isAvailable else { throw Failure.unavailable }
        transcript = ""
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            throw Failure.audio(error.localizedDescription)
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw Failure.audio(error.localizedDescription)
        }
        isRecording = true
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal == true || error != nil
            Task { @MainActor in
                guard let self else { return }
                if let text { self.transcript = text }
                if isFinal { self.complete() }
            }
        }
    }

    /// Stop listening and return everything recognized (empty when nothing was).
    func finish() async -> String {
        guard isRecording else { return transcript }
        stopAudio()
        request?.endAudio()
        let text = await withCheckedContinuation { continuation in
            finished = continuation
            // A final result normally follows endAudio within a moment; do not wait for ever.
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(2))
                self?.complete()
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Stop listening and drop what was said.
    func cancel() {
        stopAudio()
        task?.cancel()
        complete()
        transcript = ""
    }

    private func complete() {
        task = nil
        request = nil
        if isRecording { stopAudio() }
        finished?.resume(returning: transcript)
        finished = nil
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
