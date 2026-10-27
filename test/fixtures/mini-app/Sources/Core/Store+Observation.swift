import Combine

extension Store: ObservableObject {
    public var count: Int { items.count }
}
