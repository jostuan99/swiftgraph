import SwiftUI
import Core

struct ItemRow: View {
    let item: Item

    var body: some View {
        HStack {
            Text(item.title)
            Spacer()
            Text(verbatim: item.status.rawValue)
        }
    }
}
