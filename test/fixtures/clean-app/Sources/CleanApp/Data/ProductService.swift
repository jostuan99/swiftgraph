import Alamofire

protocol ProductService {
    func fetchProducts() async throws -> ProductListResponse
}

final class ProductServiceImpl: ProductService {
    private let tokenStore: TokenStore

    init(tokenStore: TokenStore) {
        self.tokenStore = tokenStore
    }

    func fetchProducts() async throws -> ProductListResponse {
        let headers: HTTPHeaders = ["Authorization": tokenStore.read(key: "accessToken") ?? ""]
        return try await AF.request("https://api.example.com/v1/products", method: .get, headers: headers)
            .serializingDecodable(ProductListResponse.self)
            .value
    }
}
