//
//  Copyright © 2026 by JosTuan. All rights reserved.
//

import SwiftUI

struct LoginView: View {
    @ObservedObject var vm: LoginViewModel = LoginViewModel()
    
    var body: some View {
        ZStack {
            VStack {
                HStack {
                    TextField(Localization.loginFirstName.localized,text: $vm.firstName)
                        .textFieldStyle(.roundedBorder)
                    TextField("loginLastName",text: $vm.lastName)
                        .textFieldStyle(.roundedBorder)
                }
                TextField(Localization.loginPhoneNumber
                    .localized,text: $vm.phoneNumber)
                .textFieldStyle(.roundedBorder)
                TextField("loginCustomerNumber",text: $vm.customerNumber)
                    .textFieldStyle(.roundedBorder)
                Button(action: { vm.anonymousSession() }) {
                    Text("loginButton")
                        .padding(12)
                        .frame(maxWidth: .infinity)
                        .clipShape(Capsule())
                }
                VStack {
                    Text("Push")
                        .font(.largeTitle)
                        .onTapGesture {
                            TopRoutingManager.shared.push(DetailView(), animated: true)
                        }
                    Text("Sheet")
                        .font(.largeTitle)
                        .onTapGesture {
                            TopRoutingManager.shared.sheet(DetailView(), animated: true)
                        }
                }
            }
            .padding(.horizontal, 16)

        }
    }
}

struct DetailView: View {

    var body: some View {
        ZStack {
            Color.clear
        }
    }
}

#Preview {
    LoginView()
}
