import SwiftUI

@main
struct GLWorkApp: App {
    @StateObject private var account = CompanyAccount()
    @AppStorage(RemoteAppearance.key) private var appearance = RemoteAppearance.system.rawValue

    init() {
        RemoteNotificationManager.shared.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(account)
                .preferredColorScheme(RemoteAppearance(rawValue: appearance)?.colorScheme)
        }
    }
}

/// 外观: follow the phone, or always light or dark. Kept on this phone.
enum RemoteAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    static let key = "glwork.appearance"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: remoteLocalized("跟随系统")
        case .light: remoteLocalized("浅色")
        case .dark: remoteLocalized("深色")
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
