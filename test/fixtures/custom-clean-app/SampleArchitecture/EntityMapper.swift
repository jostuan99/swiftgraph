//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import Alamofire

protocol EntityMapper {
    associatedtype DomainRequest
    associatedtype DomainResult
    associatedtype RequestData: Encodable
    associatedtype ResponseEntity: Decodable
    var requestEntity: RequestData { get set }
    var method: HTTPMethod { get }

    func mapping(_ entity: ResponseEntity) -> DomainResult

    static func domainToRequest(_ domain: DomainRequest) -> RequestData
}
