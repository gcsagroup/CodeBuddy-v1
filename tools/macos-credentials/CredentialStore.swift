import Foundation
import Security
import CryptoKit

enum CredentialFailure: Error { case invalidInput, missingKey, keychain(OSStatus), invalidKey, invalidCiphertext }

protocol MasterKeyStore {
    func key(create: Bool) throws -> Data
}

struct KeychainMasterKeyStore: MasterKeyStore {
    let service: String
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: "aes-gcm-master-v1",
         kSecAttrSynchronizable as String: false]
    }
    func key(create: Bool) throws -> Data {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecSuccess {
            guard let data = result as? Data, data.count == 32 else { throw CredentialFailure.invalidKey }
            return data
        }
        guard status == errSecItemNotFound else { throw CredentialFailure.keychain(status) }
        guard create else { throw CredentialFailure.missingKey }
        var bytes = [UInt8](repeating: 0, count: 32)
        let randomStatus = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard randomStatus == errSecSuccess else { throw CredentialFailure.keychain(randomStatus) }
        let data = Data(bytes)
        var addition = query
        addition[kSecValueData as String] = data
        addition[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let added = SecItemAdd(addition as CFDictionary, nil)
        // Another process can win first-use creation. Never replace its key.
        if added == errSecDuplicateItem { return try key(create: false) }
        guard added == errSecSuccess else { throw CredentialFailure.keychain(added) }
        return data
    }
}

struct CredentialCodec {
    static let kind = "macos-keychain-aesgcm-v1"
    static let maximumBytes = 1024 * 1024
    let store: any MasterKeyStore
    func transform(action: String, value: String) throws -> String {
        let context = Data(Self.kind.utf8)
        switch action {
        case "protect":
            let plaintext = Data(value.utf8)
            guard plaintext.count <= Self.maximumBytes else { throw CredentialFailure.invalidInput }
            let key = SymmetricKey(data: try store.key(create: true))
            guard let combined = try AES.GCM.seal(plaintext, using: key, authenticating: context).combined else {
                throw CredentialFailure.invalidCiphertext
            }
            return combined.base64EncodedString()
        case "unprotect":
            guard let combined = Data(base64Encoded: value), combined.count >= 28,
                  combined.count <= Self.maximumBytes + 28 else { throw CredentialFailure.invalidCiphertext }
            let key = SymmetricKey(data: try store.key(create: false))
            let bytes = try AES.GCM.open(AES.GCM.SealedBox(combined: combined), using: key, authenticating: context)
            guard let plaintext = String(data: bytes, encoding: .utf8) else { throw CredentialFailure.invalidCiphertext }
            return plaintext
        default: throw CredentialFailure.invalidInput
        }
    }
}
