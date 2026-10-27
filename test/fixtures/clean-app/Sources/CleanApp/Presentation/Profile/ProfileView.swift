import SwiftUI

struct ProfileView: View {
    @StateObject var viewModel = ProfileViewModel()

    var body: some View {
        VStack {
            header
            PointsBadge(points: viewModel.points)
            settings
        }
        .task {
            await viewModel.load()
        }
    }
}
