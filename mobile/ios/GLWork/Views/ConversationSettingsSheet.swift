import AVFoundation
import SwiftUI
import UIKit

/// A text file attached to the next message; its contents go into the message.
struct DraftTextFile: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let text: String
}

/// The session's settings: its model and mode, subagents, and 播报 with its voice.
struct ConversationSettingsSheet: View {
    let modelName: String
    let presetName: String?
    let subagentCount: Int
    @ObservedObject var speaker: ReplySpeaker
    let pickModel: () -> Void
    let openSubagents: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            RemoteSheetHeader(title: "会话设置")
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    group("对话") {
                        Button(action: pickModel) {
                            row("对话模型", value: modelName, icon: "cpu", chevron: true)
                        }
                        if let presetName {
                            row("当前模式", value: presetName, icon: "square.stack.3d.up", chevron: false)
                        }
                        Button(action: openSubagents) {
                            row("子代理", value: subagentCount > 0 ? remoteLocalizedCount(subagentCount, unit: "subagent") : remoteLocalized("暂无"), icon: "person.2", chevron: true)
                        }
                    }

                    group("播报") {
                        Toggle(isOn: $speaker.isEnabled) {
                            Label("回复完成后朗读", systemImage: "speaker.wave.2")
                                .font(.body)
                        }
                        .tint(RemoteTheme.accent)
                        .padding(.vertical, 8)
                        if speaker.isEnabled {
                            Text("音色")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.top, 4)
                            voiceRow(nil, name: remoteLocalized("系统默认"))
                            ForEach(speaker.voices, id: \.identifier) { voice in
                                voiceRow(voice.identifier, name: voiceLabel(voice))
                            }
                        }
                    }
                }
                .buttonStyle(RemotePressableRowButtonStyle(cornerRadius: 10))
                .padding(.horizontal, RemoteTheme.pagePadding)
                .padding(.bottom, 24)
            }
        }
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(remoteLocalized(title))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)
            VStack(alignment: .leading, spacing: 0) { content() }
                .padding(.horizontal, 12)
                .padding(.vertical, 2)
                .remoteSurface(cornerRadius: 12)
        }
    }

    private func row(_ title: String, value: String, icon: String, chevron: Bool) -> some View {
        HStack(spacing: 10) {
            Label(remoteLocalized(title), systemImage: icon)
                .font(.body)
                .foregroundStyle(.primary)
            Spacer(minLength: 8)
            Text(value)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    private func voiceRow(_ identifier: String?, name: String) -> some View {
        Button {
            speaker.voiceIdentifier = identifier
            speaker.preview(identifier)
        } label: {
            HStack {
                Text(name).font(.body).foregroundStyle(.primary)
                Spacer()
                if speaker.voiceIdentifier == identifier {
                    Image(systemName: "checkmark").foregroundStyle(RemoteTheme.accent)
                }
            }
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(speaker.voiceIdentifier == identifier ? .isSelected : [])
    }

    private func voiceLabel(_ voice: AVSpeechSynthesisVoice) -> String {
        let region = Locale.current.localizedString(forIdentifier: voice.language) ?? voice.language
        let quality = voice.quality == .premium ? remoteLocalized(" · 高级") : voice.quality == .enhanced ? remoteLocalized(" · 增强") : ""
        return "\(voice.name)（\(region)）\(quality)"
    }
}

/// The camera, for 拍照 in the attachment sheet.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
