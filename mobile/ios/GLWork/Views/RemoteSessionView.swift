import SwiftUI
import UIKit

/// One Mac's workspaces and sessions: each workspace its own compact block, with a
/// "+" that starts a session there; 默认工作空间 first (the Mac's default workspace,
/// plus sessions in no workspace).
struct RemoteSessionView: View {
    @StateObject private var viewModel: RemoteHostViewModel
    /// Collapsed workspaces, kept on this phone per Mac.
    @AppStorage private var collapsedStorage: String
    @State private var creatingGroupID: String?
    @State private var createError: String?
    @State private var createdSession: RemoteSessionSummary?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(host: RemoteHost) {
        let client = LiveHarnessRemoteClient(baseURL: host.baseURL, displayName: host.name, accessToken: host.accessToken)
        _viewModel = StateObject(wrappedValue: RemoteHostViewModel(client: client))
        _collapsedStorage = AppStorage(wrappedValue: "", "glwork.collapsed.\(host.id)")
    }

    init(demoClient: DemoHarnessRemoteClient = DemoHarnessRemoteClient()) {
        _viewModel = StateObject(wrappedValue: RemoteHostViewModel(client: demoClient))
        _collapsedStorage = AppStorage(wrappedValue: "", "glwork.collapsed.demo")
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if viewModel.isLoading && viewModel.lastUpdated == nil {
                    ProjectsLoadingView()
                } else if let error = viewModel.errorMessage, viewModel.lastUpdated == nil {
                    ProjectsConnectionError(message: error) { Task { await viewModel.refresh() } }
                } else {
                    if let error = viewModel.errorMessage {
                        StaleProjectsBanner(message: error) { Task { await viewModel.refresh() } }
                    }
                    if let createError {
                        RemoteInlineNotice(title: "没有新建成功", message: createError, icon: "exclamationmark.triangle", tone: .danger)
                    }
                    ForEach(projectGroups) { group in
                        WorkspaceSection(
                            group: group,
                            client: viewModel.client,
                            isExpanded: isExpanded(group),
                            isCreating: creatingGroupID == group.id,
                            toggle: { toggle(group) },
                            create: { createSession(in: group) }
                        )
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .background(RemoteTheme.canvas.ignoresSafeArea())
        .safeAreaInset(edge: .top, spacing: 0) {
            RemotePageHeader(title: viewModel.client.displayName, subtitle: nil) {
                Button {
                    Task { await viewModel.refresh() }
                } label: {
                    if viewModel.isLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .buttonStyle(RemoteIconButtonStyle())
                .disabled(viewModel.isLoading)
                .accessibilityLabel("刷新")
            }
        }
        .remoteNavigationChromeHidden()
        .refreshable { await viewModel.refresh() }
        .task { await viewModel.monitor() }
        .navigationDestination(item: $createdSession) { session in
            RemoteConversationView(client: viewModel.client, session: session)
        }
    }

    // MARK: Workspaces

    /// The Host's first-use workspace (title `default-workspace`, shown as 默认工作区 on the desktop).
    private static let defaultWorkspaceTitle = "default-workspace"
    private static let defaultGroupID = "workspace:__default__"

    private var projectGroups: [RemoteProjectGroup] {
        var groups = viewModel.workspaceSnapshot.map { authoritativeGroups(snapshot: $0, sessions: viewModel.sessions) }
            ?? directoryFallbackGroups(sessions: viewModel.sessions.filter { !viewModel.archivedSessionIDs.contains($0.id) })
        // 默认工作空间 always first: the Mac's default workspace, or a group for sessions in none.
        if let index = groups.firstIndex(where: \.isDefault) {
            groups.insert(groups.remove(at: index), at: 0)
        } else {
            groups.insert(RemoteProjectGroup(id: Self.defaultGroupID, workspaceID: nil, title: remoteLocalized("默认工作空间"), path: nil, sessions: [], isDefault: true), at: 0)
        }
        return groups
    }

    private func authoritativeGroups(snapshot: RemoteWorkspaceSnapshot, sessions: [RemoteSessionSummary]) -> [RemoteProjectGroup] {
        let sessionsByID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        var claimed = Set<String>()
        var groups: [RemoteProjectGroup] = []
        for workspace in snapshot.items {
            let members = workspace.sessionIDs.compactMap { id -> RemoteSessionSummary? in
                guard !snapshot.archivedSessionIDs.contains(id), claimed.insert(id).inserted else { return nil }
                return sessionsByID[id]
            }
            let isDefault = workspace.title == Self.defaultWorkspaceTitle
            groups.append(RemoteProjectGroup(
                id: "workspace:\(workspace.id)",
                workspaceID: workspace.id,
                title: isDefault ? remoteLocalized("默认工作空间") : displayProjectTitle(workspace.title, path: workspace.path),
                path: workspace.path,
                sessions: members,
                isDefault: isDefault
            ))
        }
        let ungrouped = sessions.filter { !snapshot.archivedSessionIDs.contains($0.id) && !claimed.contains($0.id) }
        if !ungrouped.isEmpty {
            // Sessions in no workspace belong with 默认工作空间.
            if let index = groups.firstIndex(where: \.isDefault) {
                let group = groups[index]
                groups[index] = RemoteProjectGroup(id: group.id, workspaceID: group.workspaceID, title: group.title, path: group.path,
                                                   sessions: (group.sessions + ungrouped).sorted { $0.updatedAt > $1.updatedAt }, isDefault: true)
            } else {
                groups.append(RemoteProjectGroup(id: Self.defaultGroupID, workspaceID: nil, title: remoteLocalized("默认工作空间"), path: nil, sessions: ungrouped, isDefault: true))
            }
        }
        return groups
    }

    private func directoryFallbackGroups(sessions: [RemoteSessionSummary]) -> [RemoteProjectGroup] {
        var order: [String] = []
        var grouped: [String: [RemoteSessionSummary]] = [:]
        var titles: [String: (title: String, path: String?)] = [:]
        for session in sessions {
            let path = nonBlank(session.projectPath)
            let id = path.map { "directory:\(fallbackPathIdentity($0))" } ?? Self.defaultGroupID
            if grouped[id] == nil {
                order.append(id)
                titles[id] = (path == nil ? remoteLocalized("默认工作空间")
                    : (session.projectName ?? path.map(crossPlatformBasename) ?? remoteLocalized("未命名项目")), path)
            }
            grouped[id, default: []].append(session)
        }
        return order.compactMap { id in
            guard let details = titles[id] else { return nil }
            return RemoteProjectGroup(id: id, workspaceID: nil, title: details.title, path: details.path, sessions: grouped[id] ?? [], isDefault: id == Self.defaultGroupID)
        }
    }

    // MARK: Expansion

    private var collapsedIDs: Set<String> {
        get { Set(collapsedStorage.split(separator: "\n").map(String.init)) }
        nonmutating set { collapsedStorage = newValue.sorted().joined(separator: "\n") }
    }
    /// Expanded unless the member collapsed it; empty workspaces start collapsed.
    private func isExpanded(_ group: RemoteProjectGroup) -> Bool {
        let key = group.path.map(fallbackPathIdentity) ?? group.id
        if collapsedIDs.contains(key) { return false }
        if collapsedIDs.contains("open:\(key)") { return true }
        return !group.sessions.isEmpty
    }

    private func toggle(_ group: RemoteProjectGroup) {
        let key = group.path.map(fallbackPathIdentity) ?? group.id
        let expanded = isExpanded(group)
        var ids = collapsedIDs
        ids.remove(key)
        ids.remove("open:\(key)")
        if expanded { ids.insert(key) } else if group.sessions.isEmpty { ids.insert("open:\(key)") }
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) { collapsedIDs = ids }
    }

    // MARK: New session

    /// A session in this workspace, then straight into it.
    private func createSession(in group: RemoteProjectGroup) {
        guard creatingGroupID == nil else { return }
        creatingGroupID = group.id
        createError = nil
        Task {
            do {
                let sessionID = try await viewModel.client.createSession(
                    workspaceID: group.workspaceID,
                    cwd: group.workspaceID == nil ? group.path : nil
                )
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                creatingGroupID = nil
                createdSession = RemoteSessionSummary(id: sessionID, title: remoteLocalized("新会话"), updatedAt: Date(), running: false,
                                                      projectName: group.title, projectPath: group.path)
                await viewModel.refresh(silently: true)
            } catch {
                creatingGroupID = nil
                createError = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }

    // MARK: Paths

    private func displayProjectTitle(_ title: String, path: String) -> String {
        normalized(title) ?? normalized(path).map(crossPlatformBasename) ?? remoteLocalized("未命名项目")
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func nonBlank(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }

    private func crossPlatformBasename(_ path: String) -> String {
        path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    }

    private func fallbackPathIdentity(_ path: String) -> String {
        let third = path.count >= 3 ? path[path.index(path.startIndex, offsetBy: 2)] : nil
        let isDrivePath = path.count >= 3 && path[path.index(after: path.startIndex)] == ":" && (third == "/" || third == "\\")
        var identity = (isDrivePath || path.hasPrefix("\\\\")) ? path.replacingOccurrences(of: "\\", with: "/") : path
        while identity.count > 1 && identity.hasSuffix("/") { identity.removeLast() }
        if isDrivePath { identity = identity.prefix(1).lowercased() + identity.dropFirst() }
        return identity
    }
}

private struct RemoteProjectGroup: Identifiable {
    let id: String
    let workspaceID: String?
    let title: String
    let path: String?
    let sessions: [RemoteSessionSummary]
    var isDefault = false

    var runningCount: Int { sessions.count(where: \.running) }
}

/// One workspace: a header row (collapse, name, count, +) and its sessions.
private struct WorkspaceSection: View {
    let group: RemoteProjectGroup
    let client: any HarnessRemoteClient
    let isExpanded: Bool
    let isCreating: Bool
    let toggle: () -> Void
    let create: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Button(action: toggle) {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .frame(width: 12)
                        Image(systemName: group.isDefault ? "tray" : "folder")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(RemoteTheme.accent)
                        Text(group.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        if group.runningCount > 0 {
                            Circle().fill(RemoteTheme.accent).frame(width: 6, height: 6)
                        }
                        Text("\(group.sessions.count)")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                        Spacer(minLength: 4)
                    }
                    .frame(minHeight: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(group.title)
                .accessibilityValue(remoteLocalizedCount(group.sessions.count, unit: "session"))
                .accessibilityHint(isExpanded ? "轻点收起" : "轻点展开")

                Button(action: create) {
                    Group {
                        if isCreating { ProgressView().controlSize(.mini) } else { Image(systemName: "plus") }
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(RemoteTheme.accent)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isCreating)
                .accessibilityLabel("在\(group.title)新建会话")
            }
            .padding(.leading, 10)
            .padding(.trailing, 2)

            if isExpanded, !group.sessions.isEmpty {
                VStack(spacing: 0) {
                    ForEach(group.sessions) { session in
                        NavigationLink {
                            RemoteConversationView(client: client, session: session)
                        } label: {
                            SessionRow(session: session)
                        }
                        .buttonStyle(RemotePressableRowButtonStyle(cornerRadius: 8))
                    }
                }
                .padding(.bottom, 4)
            }
        }
        .remoteSurface(cornerRadius: 12)
    }
}

/// A session: title, and when it last changed; a dot while it runs.
private struct SessionRow: View {
    let session: RemoteSessionSummary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(session.running ? RemoteTheme.accent : Color.clear)
                .frame(width: 6, height: 6)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(session.running ? remoteLocalized("执行中") : relativeUpdate)
                    .font(.caption2)
                    .foregroundStyle(session.running ? RemoteTheme.accent : .secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, 30)
        .padding(.trailing, 12)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(session.title)
        .accessibilityValue(session.running ? remoteLocalized("执行中") : relativeUpdate)
        .accessibilityHint("打开会话")
    }

    private var relativeUpdate: String {
        let seconds = max(0, Date().timeIntervalSince(session.updatedAt))
        if seconds < 60 { return remoteLocalized("刚刚更新") }
        if seconds < 604_800 {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .short
            return formatter.localizedString(fromTimeInterval: -seconds)
        }
        return session.updatedAt.formatted(date: .abbreviated, time: .omitted)
    }
}

private struct StaleProjectsBanner: View {
    let message: String
    let retry: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    bannerMessage
                    Button("重试", action: retry)
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(RemotePressableRowButtonStyle(cornerRadius: 9))
                        .foregroundStyle(RemoteTheme.accent)
                        .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 11) {
                    bannerMessage
                    Spacer(minLength: 8)
                    Button("重试", action: retry)
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(RemotePressableRowButtonStyle(cornerRadius: 9))
                        .foregroundStyle(RemoteTheme.accent)
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
        }
        .padding(13)
        .background(RemoteTheme.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(RemoteTheme.warning.opacity(0.18), lineWidth: 1)
        }
    }

    private var bannerMessage: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(RemoteTheme.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text("连接中断 · 显示上次结果")
                    .font(.subheadline.weight(.semibold))
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
            }
        }
    }
}

private struct ProjectsConnectionError: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        RemoteEmptyState(
            icon: "wifi.exclamationmark",
            title: "无法连接这台电脑",
            message: remoteLocalizedFormat(
                "请确认电脑上的 GL Work 正在运行，并在“插件 → 手机远程”里打开了。\n%@",
                message
            ),
            action: retry
        ) {
            Label("重新连接", systemImage: "arrow.clockwise")
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 72)
    }
}

private struct ProjectsLoadingView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("项目")
                    .font(.title2.weight(.bold))
                Spacer()
                ProgressView()
                    .controlSize(.small)
            }
            .padding(.horizontal, 2)

            ForEach(0..<2, id: \.self) { index in
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 12) {
                        Image(systemName: "folder")
                            .frame(width: 32)
                        VStack(alignment: .leading, spacing: 7) {
                            RoundedRectangle(cornerRadius: 3)
                                .frame(width: index == 0 ? 128 : 96, height: 15)
                            RoundedRectangle(cornerRadius: 3)
                                .frame(width: index == 0 ? 190 : 150, height: 10)
                        }
                    }
                    Divider()
                    RoundedRectangle(cornerRadius: 3)
                        .frame(height: 42)
                }
                .foregroundStyle(.secondary.opacity(0.22))
                .padding(16)
                .background(RemoteTheme.surface, in: RoundedRectangle(cornerRadius: 14))
                .overlay {
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(RemoteTheme.hairline, lineWidth: 1)
                }
                .accessibilityHidden(true)
            }

            Text("正在读取电脑上的项目与会话…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}
