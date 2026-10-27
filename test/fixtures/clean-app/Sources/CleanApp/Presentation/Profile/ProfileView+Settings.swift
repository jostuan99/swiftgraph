import SwiftUI

extension ProfileView {
    @ViewBuilder
    var settings: some View {
        Toggle("profile.notifications", isOn: $viewModel.notificationsEnabled)
        TextField("profile.nickname", text: $viewModel.nickname, prompt: Text("profile.nickname.placeholder"))
        Button("profile.logout") {
            viewModel.logout()
        }
    }
}

extension ProfileViewModel {
    func logout() {
        UserDefaults.standard.set(false, forKey: "notificationsEnabled")
    }
}
