//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import Swinject

final class DIContainer {
    static let shared = DIContainer()
    
    private let container = Container()
    
    init() {
        container.register(LoginRepository.self) { _ in
            LoginRepositoryImpl()
        }
        
        container.register(LoginUseCase.self) { _ in
            LoginUseCaseImpl()
        }
    }
    
    func getLoginUseCase() -> LoginUseCase {
        container.resolve(LoginUseCase.self)!
    }
    
    func getLoginRepository() -> LoginRepository {
        container.resolve(LoginRepository.self)!
    }
}
