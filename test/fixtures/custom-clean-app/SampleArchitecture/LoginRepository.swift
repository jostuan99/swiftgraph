//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import Combine
import Foundation

protocol LoginRepository {
    func anonymousSession<Mapper: EntityMapper>(_ mapper: Mapper) -> AnyPublisher<Mapper.ResponseEntity, DomainError>
    func register<Mapper: EntityMapper>(_ mapper: Mapper) -> AnyPublisher<Mapper.ResponseEntity, DomainError>
}

final class LoginRepositoryImpl: LoginRepository {
    func anonymousSession<Mapper>(
        _ mapper: Mapper
    ) -> AnyPublisher<Mapper.ResponseEntity, DomainError> where Mapper : EntityMapper {
        let jsonData = "{ session_id=\"fjaksdjfkajsdjfa\" }"
        return Just(())
            .compactMap { _ in jsonData.data(using: .utf8) }
            .tryMap { data in
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                return try decoder.decode(Mapper.ResponseEntity.self, from: data)
            }
            .mapError { _ in DomainError() }
            .eraseToAnyPublisher()
    }
    
    func register<Mapper>(
        _ mapper: Mapper
    ) -> AnyPublisher<Mapper.ResponseEntity, DomainError> where Mapper : EntityMapper {
        let jsonData = "{ session_id=\"fjaksdjfkajsdjfa\" }"
        return Just(())
            .compactMap { _ in jsonData.data(using: .utf8) }
            .tryMap { data in
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                return try decoder.decode(Mapper.ResponseEntity.self, from: data)
            }
            .mapError { _ in DomainError() }
            .eraseToAnyPublisher()
    }
}

