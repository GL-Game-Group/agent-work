import SwiftUI

/// About, privacy, and the open-source notice.
struct AboutRemoteView: View {
    @EnvironmentObject private var account: CompanyAccount

    var body: some View {
        VStack(spacing: 0) {
            RemoteSheetHeader(title: "关于 GL Work", subtitle: version)
            ScrollView {
                VStack(alignment: .leading, spacing: RemoteTheme.sectionSpacing) {
                    section("连接方式", icon: "lock.shield", lines: [
                        "手机只连接公司服务（\(account.server.host() ?? account.server.absoluteString)），由公司服务中转到你自己的电脑；同事和公司以外的人都连不上你的电脑。",
                        "手机的登录凭据保存在这台 iPhone 的钥匙串里，只能用来连接你自己打开了手机远程的电脑，不能用来调用模型。管理员可以在后台吊销它。",
                        "手机上的操作等同于在电脑上操作：Agent 在电脑上拥有的权限，在手机上同样有效。",
                    ])
                    section("数据", icon: "internaldrive", lines: [
                        "会话、项目和文件都留在你的电脑上，手机只在打开时读取显示，不另外保存。",
                        "公司服务记录连接、发送消息和审批的时间（审计日志），不保存对话内容。",
                    ])
                    section("开源许可", icon: "doc.text", lines: [
                        "对话界面和远程协议改编自 DSHRemote（deepseek-harness-desktop，MIT License，Copyright (c) 2026 chokwinlee）。",
                    ])
                }
                .padding(.horizontal, RemoteTheme.pagePadding)
                .padding(.top, 20)
                .padding(.bottom, 34)
            }
        }
        .background(RemoteTheme.canvas.ignoresSafeArea())
    }

    private var version: String {
        let info = Bundle.main.infoDictionary
        return "版本 \(info?["CFBundleShortVersionString"] as? String ?? "-")（\(info?["CFBundleVersion"] as? String ?? "-")）"
    }

    private func section(_ title: String, icon: String, lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: icon)
                .font(.headline)
            ForEach(lines, id: \.self) { line in
                Text(line)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .remoteSurface(cornerRadius: 16)
    }
}
