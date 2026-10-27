import Foundation

/// Something that can be shown in a list.
public protocol Listable {
    var title: String { get }
    func summary(maxLength: Int) -> String
}

public struct Item: Listable, Hashable {
    public let id: UUID
    public var title: String
    public var status: Status

    public init(title: String, status: Status = .draft) {
        self.id = UUID()
        self.title = title
        self.status = status
    }

    public func summary(maxLength: Int) -> String {
        String(title.prefix(maxLength))
    }
}

public enum Status: String, CaseIterable {
    case draft
    case published, archived
}
