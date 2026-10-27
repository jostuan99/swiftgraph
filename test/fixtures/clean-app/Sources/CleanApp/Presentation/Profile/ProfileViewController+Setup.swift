import UIKit

extension ProfileViewController {
    func setupViews() {
        logoutButton.setTitle(NSLocalizedString("profile.logout", comment: ""), for: .normal)
        logoutButton.addTarget(self, action: #selector(didTapLogout), for: .touchUpInside)
        nicknameField.placeholder = NSLocalizedString("profile.nickname.placeholder", comment: "")
    }

    @objc func didTapLogout() {
        viewModel.logout()
    }
}
