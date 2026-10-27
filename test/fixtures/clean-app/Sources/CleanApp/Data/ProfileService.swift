import Alamofire

protocol ProfileService {
    func profile() async throws -> ProfileResponse
}

final class ProfileServiceImpl: ProfileService {
    func profile() async throws -> ProfileResponse {
        try await AF.request("https://api.example.com/v1/me").serializingDecodable(ProfileResponse.self).value
    }
}
