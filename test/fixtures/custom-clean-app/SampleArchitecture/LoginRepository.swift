//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import Combine
import Foundation

protocol LoginRepository {
    func anonymousSession<Mapper: EntityMapper>(_ mapper: Mapper) -> AnyPublisher<Mapper.DomainResult, DomainError>
    func register<Mapper: EntityMapper>(_ mapper: Mapper) -> AnyPublisher<Mapper.DomainResult, DomainError>
}

final class LoginRepositoryImpl: LoginRepository {
    func anonymousSession<Mapper>(
        _ mapper: Mapper
    ) -> AnyPublisher<Mapper.DomainResult, DomainError> where Mapper : EntityMapper {
        Just("{\"session_id\": \"fjaksdjfkajsdjfa\"}")
            .compactMap { data in data.data(using: .utf8) }
            .tryMap { data in
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                return try decoder.decode(Mapper.ResponseEntity.self, from: data)
            }
            .map { mapper.mapping($0) }
            .mapError { _ in DomainError() }
            .eraseToAnyPublisher()
    }
    
    func register<Mapper>(
        _ mapper: Mapper
    ) -> AnyPublisher<Mapper.DomainResult, DomainError> where Mapper : EntityMapper {
        Just("{\"session_id\": \"fjaksdjfkajsdjfa\"}")
            .compactMap { data in data.data(using: .utf8) }
            .tryMap { data in
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                return try decoder.decode(Mapper.ResponseEntity.self, from: data)
            }
            .map { mapper.mapping($0) }
            .mapError { _ in DomainError() }
            .eraseToAnyPublisher()
    }
}

