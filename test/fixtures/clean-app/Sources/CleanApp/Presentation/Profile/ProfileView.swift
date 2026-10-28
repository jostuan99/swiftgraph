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
        .alert("profile.error.title", isPresented: $viewModel.showsError) {
            Button("common.ok", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }
}
