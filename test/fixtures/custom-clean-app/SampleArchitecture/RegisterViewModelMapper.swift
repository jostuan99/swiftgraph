//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

struct RegisterViewModelMapper: RequestViewModelMapper {
    weak var viewModel: LoginViewModel?
    
    init(viewModel: LoginViewModel? = nil) {
        self.viewModel = viewModel
    }

    func getRequest() -> String {
        ""
    }

    func mapping(_ entity: String) {
        if !entity.isEmpty {
            viewModel?.state = .main
        }
    }

    func error(_ error: DomainError) {
        viewModel?.error = error
    }
}
