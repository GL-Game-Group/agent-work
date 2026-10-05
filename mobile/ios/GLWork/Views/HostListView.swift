import SwiftUI

/// The member's Macs with 手机远程 on, from the company service.
struct HostListView: View {
    @EnvironmentObject private var account: CompanyAccount
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @State private var showsAbout = false
    @State private var confirmsSignOut = false
    @State private var unreachableHint: CompanyHost?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if let error = account.hostsError {
                    RemoteInlineNotice(title: "没有刷新成功", message: error, icon: "wifi.exclamationmark", tone: .warning)
                }
                if !account.hostsLoaded && account.isLoadingHosts {
                    RemoteLoadingState(icon: "laptopcomputer", title: "正在读取你的电脑…", message: "从公司服务获取开了手机远程的电脑")
                        .padding(.top, 40)
                } else if account.hosts.isEmpty && account.hostsLoaded {
                    EmptyHostsView()
                } else {
                    RemoteSectionHeader(title: "我的电脑", detail: remoteLocalizedCount(account.hosts.count, unit: "computer"))
                        .padding(.bottom, 2)
                    ForEach(account.hosts) { host in
                        if host.reachable {
                            NavigationLink(value: host) { HostRow(host: host) }
                                .buttonStyle(RemotePressableRowButtonStyle(cornerRadius: 12))
                                .remoteSurface(cornerRadius: 14)
                        } else {
                            Button { unreachableHint = host } label: { HostRow(host: host) }
                                .buttonStyle(RemotePressableRowButtonStyle(cornerRadius: 12))
                                .remoteSurface(cornerRadius: 14)
                        }
                    }
                    Text("下拉刷新。电脑要开着 GL Work，并在“插件 → 手机远程”里打开。")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 2)
                        .padding(.top, 4)
                }
            }
            .padding(.horizontal, RemoteTheme.pagePadding)
            .padding(.top, 8)
            .padding(.bottom, 28)
        }
        .refreshable { await account.refreshHosts() }
        .background(RemoteTheme.canvas.ignoresSafeArea())
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .remoteNavigationChromeHidden()
        .task { await account.refreshHosts() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await account.refreshHosts() } }
        }
        .sheet(isPresented: $showsAbout) {
            AboutRemoteView()
                .environmentObject(account)
                .presentationBackground(RemoteTheme.canvas)
        }
        .sheet(isPresented: $confirmsSignOut) {
            RemoteDestructiveConfirmationSheet(
                icon: "rectangle.portrait.and.arrow.right",
                title: "退出登录？",
                message: "退出后这台 iPhone 不能再连接你的电脑，电脑上的会话和设置不受影响。",
                confirmTitle: "退出登录"
            ) {
                confirmsSignOut = false
                Task { await account.signOut() }
            }
            .remoteDestructiveConfirmationPresentation(for: dynamicTypeSize)
        }
        .alert(item: $unreachableHint) { host in
            Alert(
                title: Text(host.closed ? "手机远程已关闭" : "\(host.label) 不在线"),
                message: Text(host.closed
                    ? "管理员关闭了这台电脑的手机远程，或公司暂停了手机远程。"
                    : "请确认这台电脑开着、没有睡眠，GL Work 正在运行，并在“插件 → 手机远程”里打开了。"),
                dismissButton: .default(Text("知道了"))
            )
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("GL Work")
                    .font(.title2.weight(.bold))
                Text(account.member.map { "\($0.name) 的电脑" } ?? "你的电脑")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Menu {
                if let member = account.member {
                    Section("\(member.name)（\(member.member)）") {
                        Button("关于 GL Work", systemImage: "info.circle") { showsAbout = true }
                        Button("退出登录", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { confirmsSignOut = true }
                    }
                } else {
                    Button("关于 GL Work", systemImage: "info.circle") { showsAbout = true }
                    Button("退出登录", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { confirmsSignOut = true }
                }
            } label: {
                Image(systemName: "person.crop.circle")
            }
            .buttonStyle(RemoteIconButtonStyle())
            .accessibilityLabel("账号")
            .accessibilityIdentifier("account-menu")
        }
        .padding(.horizontal, RemoteTheme.pagePadding)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(RemoteTheme.canvas)
    }
}

private struct EmptyHostsView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                RoundedRectangle(cornerRadius: 20).fill(RemoteTheme.accent.opacity(0.10))
                Image(systemName: "laptopcomputer.and.iphone")
                    .font(.system(size: 33, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(RemoteTheme.accent)
            }
            .frame(width: 70, height: 70)
            .accessibilityHidden(true)

            Text("还没有可以连接的电脑")
                .font(.title2.weight(.bold))
                .padding(.top, 14)
            Text("在你的电脑上打开手机远程后，它会出现在这里。")
                .font(.body)
                .foregroundStyle(.secondary)
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: 12) {
                step(1, "在电脑上打开 GL Work", "用同一个公司账号登录")
                step(2, "打开手机远程", "插件 → 手机远程 → 允许手机远程使用这台电脑")
                step(3, "回到这里下拉刷新", "电脑开着 GL Work 时就能连接")
            }
            .padding(14)
            .remoteSurface(cornerRadius: 16)
            .padding(.top, 22)
        }
        .padding(.top, 20)
    }

    private func step(_ number: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Text("\(number)")
                .font(.caption.weight(.bold))
                .foregroundStyle(RemoteTheme.accent)
                .frame(width: 25, height: 25)
                .background(RemoteTheme.accent.opacity(0.11), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct HostRow: View {
    let host: CompanyHost

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "laptopcomputer")
                .font(.system(size: 17, weight: .medium))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(host.reachable ? RemoteTheme.accent : .secondary)
                .frame(width: 38, height: 38)
                .background((host.reachable ? RemoteTheme.accent : Color.secondary).opacity(0.10), in: RoundedRectangle(cornerRadius: 11))
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(host.label)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    RemoteStatusPill(text: status, color: color)
                }
                if let seen = host.lastSeen, !host.reachable {
                    Text("最后在线 \(seen.formatted(.relative(presentation: .named)))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .frame(minHeight: 64)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(host.label)
        .accessibilityValue(status)
    }

    private var status: String { host.closed ? "已关闭" : host.online ? "在线" : "离线" }
    private var color: Color { host.closed ? RemoteTheme.warning : host.online ? RemoteTheme.success : .secondary }
}
