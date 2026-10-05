import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// One of the member's Macs that turned 手机远程 on (GET /agent-work/remote/hosts).
struct CompanyHost: Identifiable, Hashable, Decodable {
    let id: String
    let device: String
    let label: String
    let online: Bool
    let closed: Bool
    let lastSeenAt: Double?

    var reachable: Bool { online && !closed }

    var lastSeen: Date? { lastSeenAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// The signed-in member, as the company service named them at sign-in.
struct CompanyMember: Codable, Equatable {
    let member: String
    let displayName: String?

    var name: String { displayName ?? member }
}

enum CompanyAccountError: LocalizedError {
    case invalidServer
    case stateMismatch
    case refused(String)
    case unreachable

    var errorDescription: String? {
        switch self {
        case .invalidServer: "服务器地址要以 https:// 开头，例如 https://agent.glgwork.com"
        case .stateMismatch: "登录请求已过期，请重新登录。"
        case .refused(let reason): reason
        case .unreachable: "暂时连不上公司服务，请检查网络后重试。"
        }
    }
}

/**
 * The phone's company account: GitHub sign-in through the company service
 * (PKCE, returning to glwork://auth), the token it issues (Keychain), and the
 * member's Macs. The token only lists those Macs and reaches them through the
 * relay; it is not a desktop token and holds no model keys.
 */
@MainActor
final class CompanyAccount: NSObject, ObservableObject {
    static let defaultServer = URL(string: "https://agent.glgwork.com")!
    private static let serverKey = "glwork.server"
    private static let memberKey = "glwork.member"
    private static let tokenAccount = "phone-token"

    @Published private(set) var server: URL
    @Published private(set) var member: CompanyMember?
    @Published private(set) var hosts: [CompanyHost] = []
    @Published private(set) var hostsLoaded = false
    @Published private(set) var isLoadingHosts = false
    @Published var hostsError: String?
    @Published private(set) var isSigningIn = false
    @Published private(set) var token: String?

    private let defaults: UserDefaults
    private var authSession: ASWebAuthenticationSession?

    var isSignedIn: Bool { token != nil }
    var usesDefaultServer: Bool { server == Self.defaultServer }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        server = defaults.string(forKey: Self.serverKey).flatMap(URL.init(string:)) ?? Self.defaultServer
        token = Keychain.read(Self.tokenAccount)
        member = defaults.data(forKey: Self.memberKey).flatMap { try? JSONDecoder().decode(CompanyMember.self, from: $0) }
        super.init()
        #if DEBUG
        // UI checks in the simulator: a company service on this Mac and a token issued for the test.
        let environment = ProcessInfo.processInfo.environment
        if let server = environment["GLWORK_SERVER"].flatMap(URL.init(string:)) { self.server = server }
        if let token = environment["GLWORK_TOKEN"], !token.isEmpty {
            self.token = token
            member = CompanyMember(member: environment["GLWORK_MEMBER"] ?? "dev", displayName: environment["GLWORK_MEMBER"])
        }
        #endif
    }

    // MARK: Server

    /// A bare https origin (http only for this Mac while developing).
    static func parseServer(_ text: String) throws -> URL {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        guard let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty,
              components.path.isEmpty, components.query == nil, components.fragment == nil,
              scheme == "https" || (scheme == "http" && ["127.0.0.1", "localhost"].contains(host)) else {
            throw CompanyAccountError.invalidServer
        }
        return components.url!
    }

    /// Another company service: the token belongs to the old one, so this signs out here.
    func setServer(_ text: String) throws {
        let url = try Self.parseServer(text)
        guard url != server else { return }
        forget()
        server = url
        if url == Self.defaultServer { defaults.removeObject(forKey: Self.serverKey) } else { defaults.set(url.absoluteString, forKey: Self.serverKey) }
    }

    // MARK: Sign-in

    func signIn() async throws {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        let verifier = Self.randomURLSafe(bytes: 32)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded
        let state = Self.randomURLSafe(bytes: 24)
        var start = URLComponents(url: server.appending(path: "agent-work/auth/phone/start"), resolvingAgainstBaseURL: false)!
        start.queryItems = [URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "state", value: state)]

        let callback = try await authenticate(start.url!)
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "state" })?.value == state,
              let code = items.first(where: { $0.name == "code" })?.value else {
            throw CompanyAccountError.stateMismatch
        }

        struct Exchange: Encodable { let code: String; let code_verifier: String; let device_name: String }
        struct Issued: Decodable { let token: String; let member: String; let displayName: String? }
        var request = URLRequest(url: server.appending(path: "agent-work/auth/phone/token"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Exchange(code: code, code_verifier: verifier, device_name: UIDevice.current.model))
        let issued: Issued = try await send(request)
        Keychain.write(Self.tokenAccount, issued.token)
        token = issued.token
        let signedIn = CompanyMember(member: issued.member, displayName: issued.displayName)
        member = signedIn
        defaults.set(try? JSONEncoder().encode(signedIn), forKey: Self.memberKey)
        await refreshHosts()
    }

    private func authenticate(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "glwork") { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else {
                    continuation.resume(throwing: error ?? CompanyAccountError.stateMismatch)
                }
            }
            session.presentationContextProvider = self
            authSession = session
            if !session.start() { continuation.resume(throwing: CompanyAccountError.unreachable) }
        }
    }

    /// Sign out at the company service (best effort), then here.
    func signOut() async {
        if let token {
            var request = URLRequest(url: server.appending(path: "agent-work/auth/logout"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 10
            _ = try? await URLSession.shared.data(for: request)
        }
        forget()
    }

    private func forget() {
        Keychain.delete(Self.tokenAccount)
        defaults.removeObject(forKey: Self.memberKey)
        token = nil
        member = nil
        hosts = []
        hostsLoaded = false
        hostsError = nil
    }

    // MARK: Macs

    func refreshHosts() async {
        guard let token, !isLoadingHosts else { return }
        isLoadingHosts = true
        defer { isLoadingHosts = false }
        struct Listing: Decodable { let hosts: [CompanyHost] }
        var request = URLRequest(url: server.appending(path: "agent-work/remote/hosts"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        do {
            let listing: Listing = try await send(request)
            hosts = listing.hosts
            hostsLoaded = true
            hostsError = nil
        } catch CompanyAccountError.refused(let reason) where reason == Self.signedOutReason {
            forget()
        } catch {
            hostsError = error.localizedDescription
        }
    }

    /// The remote client's view of one Mac: the relay path, as this member.
    func remoteHost(for host: CompanyHost) -> RemoteHost {
        RemoteHost(id: host.id, name: host.label, baseURL: server.appending(path: "agent-work/remote/\(host.id)"), accessToken: token)
    }

    // MARK: HTTP

    private static let signedOutReason = "登录已失效，请重新登录。"

    private func send<Value: Decodable>(_ request: URLRequest) async throws -> Value {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw CompanyAccountError.unreachable
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw CompanyAccountError.refused(Self.signedOutReason) }
        guard (200..<300).contains(status) else {
            let reason = (try? JSONDecoder().decode(CompanyRefusal.self, from: data))?.error
            switch reason {
            case "access_denied": throw CompanyAccountError.refused("你的公司账号已停用，请联系管理员。")
            case "invalid_grant": throw CompanyAccountError.stateMismatch
            case let reason? where reason.unicodeScalars.contains(where: { $0.value > 0x7F }): throw CompanyAccountError.refused(reason)
            default: throw CompanyAccountError.refused("公司服务返回 \(status)，请稍后重试。")
            }
        }
        do {
            return try JSONDecoder().decode(Value.self, from: data)
        } catch {
            throw CompanyAccountError.refused("公司服务返回的数据无法识别。")
        }
    }

    private static func randomURLSafe(bytes count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes).base64URLEncoded
    }
}

extension CompanyAccount: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        }
    }
}

/// The company service's refusals: `{ "error": "<code or reason>" }`.
private struct CompanyRefusal: Decodable { let error: String }

private extension Data {
    var base64URLEncoded: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
