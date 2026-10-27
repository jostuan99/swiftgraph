extension ProfileViewModel {
    @MainActor
    func load() async {
        guard let profile = try? await service.profile() else { return }
        name = profile.displayName
        avatarURL = profile.avatarURL
        points = profile.points
    }
}
