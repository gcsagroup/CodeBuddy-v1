import Foundation
import Security

@main
struct CredentialTests {
    static func require(_ condition: @autoclosure () throws -> Bool) throws {
        if try !condition() { throw CredentialFailure.invalidInput }
    }
    static func rejects(_ operation: () throws -> Void) throws {
        do { try operation() } catch { return }
        throw CredentialFailure.invalidInput
    }
    static func main() throws {
        // Unique test service; never delete or inspect the product's key item.
        let service = "local.codebuddy.credentials.test." + UUID().uuidString
        let store = KeychainMasterKeyStore(service: service)
        defer { SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                               kSecAttrService as String: service] as CFDictionary) }
        let codec = CredentialCodec(store: store)
        try rejects { _ = try store.key(create: false) }
        let samples = ["fixture-only", "繁體 简体 🔑 café", "  fixture\r\nsecond line\t ", ""]
        for sample in samples {
            let encrypted = try codec.transform(action: "protect", value: sample)
            let reopened = CredentialCodec(store: KeychainMasterKeyStore(service: service))
            try require(try reopened.transform(action: "unprotect", value: encrypted) == sample)
            var bytes = Data(base64Encoded: encrypted)!
            bytes[bytes.count - 1] ^= 1
            try rejects { _ = try codec.transform(action: "unprotect", value: bytes.base64EncodedString()) }
        }
        try require(try store.key(create: true) == store.key(create: false))
        try rejects { _ = try codec.transform(action: "unprotect", value: "invalid-fixture") }
        try rejects { _ = try codec.transform(action: "unknown", value: "fixture") }
        let sealed = try codec.transform(action: "protect", value: "fixture-only")
        let missing = CredentialCodec(store: KeychainMasterKeyStore(service: service + ".missing"))
        try rejects { _ = try missing.transform(action: "unprotect", value: sealed) }
        try rejects { _ = try missing.store.key(create: false) }
        print("Mac credential Keychain round-trip, missing-key, tamper and Unicode checks passed")
    }
}
