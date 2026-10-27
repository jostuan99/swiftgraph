//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import SwiftUI

struct LoginView: View {
    @ObservedObject var vm: LoginViewModel = LoginViewModel()
    
    var body: some View {
        ZStack {
            if vm.state == .login {
                VStack {
                    HStack {
                        TextField("First Name",text: $vm.firstName)
                            .textFieldStyle(.roundedBorder)
                        TextField("Last Name",text: $vm.lastName)
                            .textFieldStyle(.roundedBorder)
                    }
                    TextField("Phone Number",text: $vm.phoneNumber)
                        .textFieldStyle(.roundedBorder)
                    TextField("Customer Number",text: $vm.customerNumber)
                        .textFieldStyle(.roundedBorder)
                    Button(action: { vm.anonymousSession() }) {
                        Text("Login")
                            .padding(12)
                            .frame(maxWidth: .infinity)
                            .clipShape(Capsule())
                    }
                }
                .padding(.horizontal, 16)
            } else {
                Text("Hello, user")
                    .font(.largeTitle)
            }
        }
    }
}
