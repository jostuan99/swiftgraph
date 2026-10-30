//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import Foundation

enum Localization: String {
    case loginFirstName
    case loginLastName
    case loginPhoneNumber
    case loginCustomerNumber
    case loginButton

    var localized: String {
        Bundle.main.localizedString(forKey: rawValue, value: nil, table: nil)
    }
}
