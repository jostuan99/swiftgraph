import Swinject

final class AppContainer {
    static let shared = AppContainer()

    let container = Container()

    init() {
        container.register(TokenStore.self) { _ in TokenStore() }
        container.register(ProductService.self) { resolver in
            ProductServiceImpl(tokenStore: resolver.resolve(TokenStore.self)!)
        }
        container.register(ProductRepository.self) { resolver in
            ProductRepositoryImpl(service: resolver.resolve(ProductService.self)!)
        }
    }

    func makeProductListViewModel() -> ProductListViewModel {
        ProductListViewModel(repository: container.resolve(ProductRepository.self)!, settings: SettingsStore())
    }
}
