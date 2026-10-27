import Alamofire
import Combine
import Foundation

struct ProductRowViewData {
    let name: String
    let price: String
}

final class ProductListViewModel: ObservableObject {
    @Published private(set) var title: String = ""
    @Published private(set) var rows: [ProductRowViewData] = []
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var errorMessage: String?

    private let repository: ProductRepository
    private let settings: SettingsStore

    init(repository: ProductRepository, settings: SettingsStore) {
        self.repository = repository
        self.settings = settings
        lastUpdated = settings.lastUpdated
        rows = repository.cachedProducts().map { ProductRowViewData(name: $0.name, price: "¥\($0.price)") }
    }

    @MainActor
    func reload() async {
        do {
            errorMessage = nil
            let response = try await repository.products()
            title = response.title
            rows = response.items.map { ProductRowViewData(name: $0.name, price: "¥\($0.price)") }
            lastUpdated = Date()
            settings.markUpdated(Date())
        } catch let error as AFError {
            errorMessage = error.errorDescription
        } catch {
            rows = []
            errorMessage = error.localizedDescription
        }
    }
}
