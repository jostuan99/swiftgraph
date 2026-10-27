import Foundation

struct ProductListResponse: Decodable {
    let title: String
    let items: [ProductDTO]
}

struct ProductDTO: Decodable {
    let name: String
    let price: Decimal

    enum CodingKeys: String, CodingKey {
        case name = "product_name"
        case price
    }
}
