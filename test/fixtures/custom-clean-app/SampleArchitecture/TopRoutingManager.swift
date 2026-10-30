//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import SwiftUI

final class TopRoutingManager: BaseRoutingManager {
    static var shared: BaseRoutingManager {
        BaseRoutingManager.getInstance()
    }

    init<RootView>(_ rootView: RootView) where RootView: View {
        let viewController = WrappedHostingController(rootView: rootView)
        let navigationController = UINavigationController(rootViewController: viewController)
        super.init(navigationController: navigationController)
    }
}

struct TopNavigationView<RootView: View>: UIViewControllerRepresentable {
    var rootView: RootView

    init(rootView: RootView) {
        self.rootView = rootView
    }

    func makeUIViewController(context: Context) -> UIViewController {
        context.coordinator.getNavigationView()
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {
    }

    func makeCoordinator() -> TopRoutingManager {
        TopRoutingManager(rootView)
    }
}
