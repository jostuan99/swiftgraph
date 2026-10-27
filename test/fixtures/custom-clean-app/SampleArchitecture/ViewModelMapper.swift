//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

protocol ViewModelMapper {
    associatedtype EntityResult

    func mapping(_ entity: EntityResult)
    func error(_ error: DomainError)
}

protocol RequestViewModelMapper: ViewModelMapper {
    associatedtype EntityRequest: Encodable

    func getRequest() -> EntityRequest
}

struct DomainError: Error {
    static let mapFailure = DomainError()
}
