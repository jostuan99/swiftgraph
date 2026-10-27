// swift-tools-version:5.9

import PackageDescription

let package = Package(
    name: "indexstore-calls",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Tag swift-6.4.0-RELEASE, matching the Xcode toolchain.
        .package(url: "https://github.com/swiftlang/indexstore-db.git", revision: "64aa0b26913249c4e7c21d351a215fba02702003"),
    ],
    targets: [
        .executableTarget(
            name: "indexstore-calls",
            dependencies: [.product(name: "IndexStoreDB", package: "indexstore-db")]
        ),
    ]
)
