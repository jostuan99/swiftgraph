//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import SwiftUI

public struct NavigationController {
    open class Coordinator: UIViewController, UINavigationControllerDelegate, UIAdaptivePresentationControllerDelegate {
        var navigationView: UINavigationController

        init(navigationView: UINavigationController) {
            self.navigationView = navigationView
            super.init(nibName: nil, bundle: nil)
            self.navigationView.delegate = self
            self.navigationView.presentationController?.delegate = self
        }


        @available(*, unavailable)
        @MainActor required public init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        open override func viewDidLoad() {
            super.viewDidLoad()
            navigationView.didMove(toParent: self)
            addChild(navigationView)
            view.addSubview(navigationView.view)
        }

        public func presentationControllerShouldDismiss(_ presentationController: UIPresentationController) -> Bool {
            true
        }

        public func adaptivePresentationStyle(for controller: UIPresentationController) -> UIModalPresentationStyle {
            .pageSheet
        }

        public func presentationControllerDidDismiss(
            _ presentationController: UIPresentationController
        ) {
        }
    }
}
