// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MiniApp",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14)],
    targets: [
        .target(name: "Core", path: "Sources/Core"),
        .executableTarget(
            name: "App",
            dependencies: ["Core"],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "AppTests", dependencies: ["App"]),
    ]
)
