//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

extension LoginViewModel {
    func anonymousSession() {
        guard let anonymousViewModelMapper else { return }
        useCase.anonymous(anonymousViewModelMapper)
    }
}
