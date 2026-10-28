extension ProfileViewModel {
    @MainActor
    func load() async {
        do {
            let profile = try await service.profile()
            name = profile.displayName
            avatarURL = profile.avatarURL
            points = profile.points
        } catch {
            errorMessage = error.localizedDescription
            showsError = true
        }
    }
}
