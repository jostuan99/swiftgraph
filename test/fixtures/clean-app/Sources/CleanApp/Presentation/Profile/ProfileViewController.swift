import Combine
import UIKit

final class ProfileViewController: UIViewController {
    let viewModel = ProfileViewModel()
    let nameLabel = UILabel()
    let pointsLabel = UILabel()
    let logoutButton = UIButton(type: .system)
    let nicknameField = UITextField()
    var cancellables = Set<AnyCancellable>()

    override func viewDidLoad() {
        super.viewDidLoad()
        setupViews()
        bind()
        Task { await viewModel.load() }
    }
}
