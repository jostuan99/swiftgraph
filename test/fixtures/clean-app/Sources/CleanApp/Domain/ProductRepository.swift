protocol ProductRepository {
    func products() async throws -> ProductListResponse
    func cachedProducts() -> [ProductDTO]
}

final class ProductRepositoryImpl: ProductRepository {
    private let service: ProductService
    private let cache = ProductCache()

    init(service: ProductService) {
        self.service = service
    }

    func products() async throws -> ProductListResponse {
        try await service.fetchProducts()
    }

    func cachedProducts() -> [ProductDTO] {
        cache.load()
    }
}
