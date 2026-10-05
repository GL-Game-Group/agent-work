import Foundation

/// One Mac the remote client talks to: through the company relay, as the signed-in member.
struct RemoteHost: Identifiable, Hashable {
    let id: String
    var name: String
    var baseURL: URL
    var accessToken: String?
}
