import SwiftUI
import Core

struct AppView: View {
    @ObservedObject var store: Store<Void>
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            List(store.items, id: \.id) { item in
                ItemRow(item: item)
            }
            .navigationTitle("items_title")
            .toolbar {
                Button("add_button") {
                    store.send(.add(Item(title: formatTitle(draft))))
                }
            }
        }
    }

    private var emptyMessage: String {
        NSLocalizedString("empty_message", comment: "Shown when the list is empty")
    }

    private func countLabel(count: Int) -> String {
        String(localized: "\(count) items")
    }
}
