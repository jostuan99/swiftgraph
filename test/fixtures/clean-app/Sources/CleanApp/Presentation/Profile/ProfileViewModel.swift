import Combine
import Foundation

final class ProfileViewModel: ObservableObject {
    @Published private(set) var name: String = ""
    @Published private(set) var avatarURL: URL?
    @Published private(set) var points: Int = 0
    @Published var nickname: String = ""
    @Published var notificationsEnabled: Bool = UserDefaults.standard.bool(forKey: "notificationsEnabled")

    private let service: ProfileService

    init(service: ProfileService = ProfileServiceImpl()) {
        self.service = service
    }
}
