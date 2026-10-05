import SwiftUI

struct RootView: View {
    @EnvironmentObject private var account: CompanyAccount
    @State private var path: [CompanyHost] = []

    var body: some View {
        Group {
        #if DEBUG
            if let scenario = ProcessInfo.processInfo.environment["GLWORK_SCENARIO"] {
                debugScenario(scenario)
            } else {
                appRoot
            }
        #else
            appRoot
        #endif
        }
        .statusBarHidden(false)
    }

    @ViewBuilder
    private var appRoot: some View {
        if account.isSignedIn {
            NavigationStack(path: $path) {
                HostListView()
                    .navigationDestination(for: CompanyHost.self) { host in
                        RemoteSessionView(host: account.remoteHost(for: host))
                            .id(host.id)
                    }
            }
            .tint(RemoteTheme.accent)
            .onChange(of: account.isSignedIn) { _, signedIn in
                if !signedIn { path = [] }
            }
            #if DEBUG
            .onChange(of: account.hosts) { _, hosts in
                // UI checks in the simulator: open the first Mac without a tap.
                if ProcessInfo.processInfo.environment["GLWORK_OPEN_FIRST_HOST"] != nil, path.isEmpty,
                   let host = hosts.first(where: \.reachable) {
                    path = [host]
                }
            }
            #endif
        } else {
            SignInView()
                .tint(RemoteTheme.accent)
        }
    }

    #if DEBUG
    /// Offline screens with the demo client, for UI checks in the simulator.
    @ViewBuilder
    private func debugScenario(_ scenario: String) -> some View {
        switch scenario {
        case "projects":
            NavigationStack { RemoteSessionView() }
                .tint(RemoteTheme.accent)
        case "conversation":
            NavigationStack {
                RemoteConversationView(
                    client: DemoHarnessRemoteClient(),
                    session: RemoteSessionSummary(
                        id: "review-demo-session",
                        title: "登录流程上线检查",
                        updatedAt: Date(),
                        running: false,
                        projectName: "示例项目",
                        projectPath: "/Users/demo/Sample Project"
                    )
                )
            }
            .tint(RemoteTheme.accent)
        case "live-session":
            // One session on the first Mac, through the relay (GLWORK_SESSION).
            if let host = account.hosts.first(where: \.reachable),
               let sessionID = ProcessInfo.processInfo.environment["GLWORK_SESSION"] {
                let remote = account.remoteHost(for: host)
                NavigationStack {
                    RemoteConversationView(
                        client: LiveHarnessRemoteClient(baseURL: remote.baseURL, displayName: remote.name, accessToken: remote.accessToken),
                        session: RemoteSessionSummary(id: sessionID, title: "手机远程验收", updatedAt: Date(), running: false, projectName: "agent-work", projectPath: nil)
                    )
                }
                .tint(RemoteTheme.accent)
            } else {
                ProgressView().task { await account.refreshHosts() }
            }
        default:
            appRoot
        }
    }
    #endif
}
