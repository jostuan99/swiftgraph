import XCTest
import Testing
@testable import Core

final class StoreTests: XCTestCase {
    func testSendAddsItem() {
        let store = Store<Void>()
        store.send(.add(Item(title: "A")))
        XCTAssertEqual(store.items.count, 1)
    }
}

@Test func previewHasOneItem() {
    #expect(Store<Void>.preview().count == 1)
}
