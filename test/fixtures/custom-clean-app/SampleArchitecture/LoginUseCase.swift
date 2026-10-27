//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import Alamofire
import Combine

protocol LoginUseCase {
    func anonymous<Mapper: ViewModelMapper>(
        _ mapper: Mapper
    )
    
    func register<Mapper: RequestViewModelMapper>(
        _ mapper: Mapper
    )
}

final class LoginUseCaseImpl: LoginUseCase {
    let repository = DIContainer.shared.getLoginRepository()
    private var disposeBag = Set<AnyCancellable>()
    
    func anonymous<Mapper>(
        _ mapper: Mapper
    ) where Mapper : ViewModelMapper {
        let entityMapper = AnonymousEntityMapper()
        return repository.anonymousSession(entityMapper)
            .sink(
                receiveCompletion: {
                    if case .failure(let error) = $0 {
                        mapper.error(error)
                    }
                }
            ) { domain in
                if let domain = domain as? Mapper.EntityResult {
                    mapper.mapping(domain)
                } else {
                    mapper.error(DomainError.mapFailure)
                }
            }
            .store(in: &disposeBag)
    }
    
    func register<Mapper: RequestViewModelMapper>(
        _ mapper: Mapper
    ) {
        guard let request = mapper.getRequest() as? String else {
            return mapper.error(DomainError.mapFailure)
        }
        let entityMapper = RegisterEntityMapper(request)
        return repository.register(entityMapper)
            .sink {
                if case .failure(let error) = $0 {
                    mapper.error(error)
                }
            } receiveValue: { domain in
                if let domain = domain as? Mapper.EntityResult {
                    mapper.mapping(domain)
                } else {
                    mapper.error(DomainError.mapFailure)
                }
            }
            .store(in: &disposeBag)
    }
}

