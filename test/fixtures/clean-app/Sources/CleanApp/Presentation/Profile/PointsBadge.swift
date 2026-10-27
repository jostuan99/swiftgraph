import SwiftUI

struct PointsBadge: View {
    let points: Int

    var body: some View {
        Label("\(points)", systemImage: "star.fill")
    }
}
