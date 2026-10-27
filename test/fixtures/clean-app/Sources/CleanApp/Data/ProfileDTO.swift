import Foundation

struct ProfileResponse: Decodable {
    let displayName: String
    let avatarURL: URL?
    let points: Int

    enum CodingKeys: String, CodingKey {
        case displayName = "display_name"
        case avatarURL = "avatar_url"
        case points
    }
}
