import Foundation

@main
struct CredentialHelper {
    struct Request: Decodable { let action: String; let value: String }
    static func main() {
        do {
            if Array(CommandLine.arguments.dropFirst()) == ["--self-test"] {
                try CredentialVerification.run()
                print("{\"passed\":true,\"isolatedKeychain\":true}")
                return
            }
            guard CommandLine.arguments.count == 1 else { throw CredentialFailure.invalidInput }
            // Bound input before decoding, including JSON escaping overhead.
            var input = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 65536), !chunk.isEmpty {
                input.append(chunk)
                guard input.count <= CredentialCodec.maximumBytes * 6 + 1024 else { throw CredentialFailure.invalidInput }
            }
            let request = try JSONDecoder().decode(Request.self, from: input)
            let codec = CredentialCodec(store: KeychainMasterKeyStore(service: "local.codebuddy.credentials.v1"))
            let value = try codec.transform(action: request.action, value: request.value)
            FileHandle.standardOutput.write(try JSONEncoder().encode(value))
        } catch {
            // Never serialize OS errors, input or secret material.
            FileHandle.standardError.write(Data("Mac credential protection failed\n".utf8))
            exit(1)
        }
    }
}
