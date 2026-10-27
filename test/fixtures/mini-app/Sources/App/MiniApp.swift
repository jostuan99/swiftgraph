import SwiftUI
import Core

@main
struct MiniApp: App {
    @StateObject private var store = Store<Void>()

    var body: some Scene {
        WindowGroup {
            AppView(store: store)
        }
    }
}
