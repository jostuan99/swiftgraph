import SwiftUI

extension ProfileView {
    var header: some View {
        HStack {
            AvatarView(url: viewModel.avatarURL)
            Text(viewModel.name)
        }
    }
}
