//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import SwiftUI

@MainActor @preconcurrency open class BaseRoutingManager: NavigationController.Coordinator {
    private static var instance: BaseRoutingManager?

    static func getInstance() -> BaseRoutingManager {
        if let instance {
            instance
        } else {
            preconditionFailure("No navigationController now")
        }
    }

    var onDismiss: (() -> Void)?

    var currentNavigationView: UINavigationController {
        navigationView
    }

    func getNavigationView() -> UIViewController {
        self
    }

    init(navigationController: UINavigationController) {
        super.init(navigationView: navigationController)
        BaseRoutingManager.instance = self
    }

    func push(_ view: some View, animated flag: Bool) {
        let viewController = WrappedHostingController(rootView: view)
        currentNavigationView.pushViewController(viewController, animated: flag)
    }

    func sheet(_ view: some View, animated flag: Bool, dismiss: (() -> Void)? = nil) {
        let viewController = WrappedHostingController(rootView: view)
        self.onDismiss = dismiss
        currentNavigationView.present(viewController, animated: flag)
    }

    public override func presentationControllerDidDismiss(
        _ presentationController: UIPresentationController
    ) {
        onDismiss?()
        onDismiss = nil
    }

    func pop(animated flag: Bool) {
        currentNavigationView.popViewController(animated: flag)
    }
}

