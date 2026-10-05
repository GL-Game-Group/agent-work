import SwiftUI

@main
struct GLWorkApp: App {
    @StateObject private var account = CompanyAccount()

    init() {
        RemoteNotificationManager.shared.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(account)
        }
    }
}
