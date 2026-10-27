//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import Alamofire
import Foundation

struct RegisterEntityMapper: EntityMapper {
    typealias DomainRequest = String
    typealias DomainResult = String
    typealias RequestData = String
    typealias ResponseEntity = AnonymousSession
    
    let method: HTTPMethod = .get
    var requestEntity: String
    
    init(_ domain: String) {
        requestEntity = Self.domainToRequest(domain)
    }
    
    static func domainToRequest(_ domain: String) -> String {
        domain
    }
    
    func mapping(_ entity: AnonymousSession) -> String {
        entity.sessionId
    }
}
