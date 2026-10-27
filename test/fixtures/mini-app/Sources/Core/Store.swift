import Foundation

public enum Action {
    case add(Item)
    case remove(id: UUID)
}

/// Holds the items and applies actions to them.
public final class Store<State> {
    @Published public private(set) var items: [Item] = []
    private let logger: Logging

    public init(logger: Logging = ConsoleLogger()) {
        self.logger = logger
    }

    public func send(_ action: Action) {
        logger.log("send \(action)")
        reduce(action)
    }

    private func reduce(_ action: Action) {
        switch action {
        case .add(let item):
            items.append(item)
        case .remove(let id):
            items.removeAll { $0.id == id }
        }
    }

    public static func preview() -> Store<State> {
        let store = Store<State>()
        store.send(.add(Item(title: "Preview")))
        return store
    }
}
