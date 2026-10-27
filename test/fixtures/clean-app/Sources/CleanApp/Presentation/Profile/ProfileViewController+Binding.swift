import UIKit

extension ProfileViewController {
    func bind() {
        viewModel.$name
            .sink { [weak self] name in
                self?.nameLabel.text = name
            }
            .store(in: &cancellables)
        viewModel.$points
            .sink { [weak self] points in
                self?.pointsLabel.text = "\(points) pt"
            }
            .store(in: &cancellables)
    }
}
