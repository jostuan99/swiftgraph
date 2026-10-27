//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import Combine
import Foundation

final class LoginViewModel: ObservableObject {
    @Published var firstName: String = ""
    @Published var lastName = ""
    @Published var phoneNumber = ""
    @Published var customerNumber = ""
    @Published var state: State = .login
    @Published var error: DomainError?

    let useCase = DIContainer.shared.getLoginUseCase()
    private(set) var anonymousViewModelMapper: AnonymousViewModelMapper?
    private(set) var registerViewModelMapper: RegisterViewModelMapper?
    
    enum State {
        case login
        case main
    }
    
    init() {
        anonymousViewModelMapper = .init(viewModel: self)
        registerViewModelMapper = .init(viewModel: self)
    }
    
    func login() {
        guard let registerViewModelMapper else { return }
        useCase.register(registerViewModelMapper)
    }
}
