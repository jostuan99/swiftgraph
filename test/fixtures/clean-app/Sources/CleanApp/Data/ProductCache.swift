import Foundation

final class ProductCache {
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent("products.json")

    func load() -> [ProductDTO] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([ProductDTO].self, from: data)) ?? []
    }
}
