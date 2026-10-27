// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CleanApp",
    defaultLocalization: "en",
    platforms: [.iOS(.v17)],
    dependencies: [
        .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.9.0"),
        .package(url: "https://github.com/Swinject/Swinject.git", from: "2.9.0"),
    ],
    targets: [
        .target(
            name: "CleanApp",
            dependencies: ["Alamofire", "Swinject"],
            resources: [.process("Resources")]
        ),
    ]
)
