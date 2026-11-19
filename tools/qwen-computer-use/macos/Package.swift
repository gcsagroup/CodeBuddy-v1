// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodeBuddyMacComputer",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidUse.git", revision: "b51f7adfbade197f0a9c802e34ba8a98cd4ecbc9"),
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.15.8")
    ],
    targets: [.executableTarget(
        name: "qwen-computer-runtime",
        dependencies: [
            .product(name: "FluidUse", package: "FluidUse"),
            .product(name: "FluidAudio", package: "FluidAudio")
        ],
        path: ".",
        exclude: ["contract-tests.swift", "Info.plist", "Tests"],
        sources: ["RuntimeContract.swift", "NativeInput.swift", "runtime.swift", "FormMatching.swift", "PDFDiskObservation.swift"]
    ), .testTarget(name: "FormMatchingTests", dependencies: ["qwen-computer-runtime"], path: "Tests")],
    swiftLanguageModes: [.v5]
)
