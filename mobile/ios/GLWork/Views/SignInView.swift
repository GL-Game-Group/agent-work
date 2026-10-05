import SwiftUI

/// Sign in with the company GitHub account; the server address can be changed for another deployment.
struct SignInView: View {
    @EnvironmentObject private var account: CompanyAccount
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var errorMessage: String?
    @State private var showsServerSettings = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Image("BrandMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 56, height: 64)
                    .accessibilityHidden(true)

                Text("GL Work")
                    .font(.largeTitle.weight(.bold))
                    .padding(.top, 22)
                Text("高效工作，努力赚钱。")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)

                Text("用公司 GitHub 账号登录，就能在手机上查看和继续你自己电脑上的 GL Work 会话：发消息、回答 Agent 的提问和审批。")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 18)

                Button {
                    Task { await signIn() }
                } label: {
                    if account.isSigningIn {
                        ProgressView().tint(.white)
                    } else {
                        Label("使用 GitHub 登录", systemImage: "person.badge.key")
                    }
                }
                .buttonStyle(RemoteActionButtonStyle(kind: .primary))
                .disabled(account.isSigningIn)
                .padding(.top, 28)
                .accessibilityIdentifier("sign-in")

                if let errorMessage {
                    RemoteInlineNotice(title: "没有登录成功", message: errorMessage, icon: "exclamationmark.triangle", tone: .danger)
                        .padding(.top, 14)
                }

                Button {
                    showsServerSettings = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "server.rack")
                        Text(account.usesDefaultServer ? "服务器设置" : "服务器：\(account.server.host() ?? account.server.absoluteString)")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                .padding(.top, 22)
                .accessibilityIdentifier("server-settings")
            }
            .frame(maxWidth: 420, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, RemoteTheme.pagePadding + 8)
            .padding(.top, dynamicTypeSize.isAccessibilitySize ? 32 : 96)
            .padding(.bottom, 34)
        }
        .background(RemoteTheme.canvas.ignoresSafeArea())
        .sheet(isPresented: $showsServerSettings) {
            ServerSettingsView()
                .environmentObject(account)
                .presentationDetents([.medium])
                .presentationBackground(RemoteTheme.canvas)
        }
    }

    private func signIn() async {
        errorMessage = nil
        do {
            try await account.signIn()
        } catch let error as NSError where error.domain == "com.apple.AuthenticationServices.WebAuthenticationSession" && error.code == 1 {
            // Cancelled in the sign-in sheet.
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// The company service's address; changing it signs out of the old one.
struct ServerSettingsView: View {
    @EnvironmentObject private var account: CompanyAccount
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            RemoteSheetHeader(title: "服务器设置", subtitle: "一般不用修改；公司更换服务地址时，按管理员给的地址填写。")
            TextField(CompanyAccount.defaultServer.absoluteString, text: $address)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .font(.body.monospaced())
                .padding(12)
                .remoteFieldSurface(invalid: errorMessage != nil)
                .accessibilityIdentifier("server-address")
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(RemoteTheme.danger)
            }
            HStack(spacing: 10) {
                Button("恢复默认") {
                    address = CompanyAccount.defaultServer.absoluteString
                }
                .buttonStyle(RemoteActionButtonStyle(kind: .secondary))
                Button("保存") {
                    do {
                        try account.setServer(address)
                        dismiss()
                    } catch {
                        errorMessage = error.localizedDescription
                    }
                }
                .buttonStyle(RemoteActionButtonStyle(kind: .primary))
            }
            Spacer(minLength: 0)
        }
        .padding(RemoteTheme.pagePadding)
        .onAppear { address = account.server.absoluteString }
    }
}
