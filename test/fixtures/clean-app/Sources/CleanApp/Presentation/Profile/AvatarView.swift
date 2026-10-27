import SwiftUI

struct AvatarView: View {
    let url: URL?

    var body: some View {
        AsyncImage(url: url)
    }
}
