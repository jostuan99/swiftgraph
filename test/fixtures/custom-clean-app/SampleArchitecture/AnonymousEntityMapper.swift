//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import Alamofire
import Foundation

struct AnonymousEntityMapper: EntityMapper {
    typealias DomainRequest = Void
    typealias DomainResult = String
    typealias RequestData = Empty
    typealias ResponseEntity = AnonymousSession
    
    let method: HTTPMethod = .get
    var requestEntity: Empty = .value
    
    init() {
    }

    static func domainToRequest(_ domain: Void) -> Empty {
        .emptyValue()
    }
    
    func mapping(_ entity: AnonymousSession) -> String {
        entity.sessionId
    }
}

