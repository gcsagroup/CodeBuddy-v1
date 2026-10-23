import Foundation

@main
struct CredentialTests {
    static func main() throws {
        try CredentialVerification.run()
        print("Mac credential Keychain round-trip, missing-key, tamper and Unicode checks passed")
    }
}
