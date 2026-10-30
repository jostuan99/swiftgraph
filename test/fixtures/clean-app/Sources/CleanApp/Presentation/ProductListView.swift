import SwiftUI

struct ProductListView: View {
    @StateObject var viewModel = AppContainer.shared.makeProductListViewModel()

    var body: some View {
        NavigationStack {
            List(viewModel.rows, id: \.name) { row in
                ProductRow(row: row)
            }
            .navigationTitle("products.title")
            .task {
                await viewModel.reload()
            }
            .toolbar {
                NavigationLink(destination: ProfileView(title: viewModel.title)) {
                    Text("profile.open")
                }
            }
        }
    }
}

struct ProductRow: View {
    let row: ProductRowViewData

    var body: some View {
        HStack {
            Text(row.name)
            Spacer()
            Text(row.price)
        }
    }
}
