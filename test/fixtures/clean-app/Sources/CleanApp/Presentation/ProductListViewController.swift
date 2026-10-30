import Combine
import SwiftUI
import UIKit

final class ProductListViewController: UIViewController, UITableViewDataSource {
    private let viewModel: ProductListViewModel
    private let titleLabel = UILabel()
    private let lastUpdatedLabel = UILabel()
    private let errorLabel = UILabel()
    private let refreshButton = UIButton(type: .system)
    private let tableView = UITableView()
    private var cancellables = Set<AnyCancellable>()

    init(viewModel: ProductListViewModel) {
        self.viewModel = viewModel
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(ProductCell.self, forCellReuseIdentifier: "ProductCell")
        tableView.dataSource = self
        refreshButton.setTitle(NSLocalizedString("refresh", comment: ""), for: .normal)
        refreshButton.addTarget(self, action: #selector(didTapRefresh), for: .touchUpInside)
        viewModel.$title
            .sink { [weak self] title in
                self?.titleLabel.text = title
            }
            .store(in: &cancellables)
        viewModel.$lastUpdated
            .sink { [weak self] date in
                if let date {
                    self?.lastUpdatedLabel.text = DateFormatter.localizedString(from: date, dateStyle: .short, timeStyle: .short)
                }
                self?.lastUpdatedLabel.isHidden = date == nil
            }
            .store(in: &cancellables)
        viewModel.$errorMessage
            .sink { [weak self] message in
                self?.errorLabel.text = message
                self?.errorLabel.isHidden = message == nil
            }
            .store(in: &cancellables)
    }

    @objc private func didTapRefresh() {
        Task {
            await viewModel.reload()
            tableView.reloadData()
        }
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        viewModel.rows.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "ProductCell", for: indexPath) as! ProductCell
        cell.configure(with: viewModel.rows[indexPath.row])
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        if indexPath.row == 0 {
            navigationController?.pushViewController(ProfileViewController(), animated: true)
        } else {
            present(UIHostingController(rootView: ProfileView()), animated: true)
        }
    }
}

final class ProductCell: UITableViewCell {
    private let nameLabel = UILabel()
    private let priceLabel = UILabel()

    func configure(with row: ProductRowViewData) {
        nameLabel.text = row.name
        priceLabel.text = row.price
    }
}
