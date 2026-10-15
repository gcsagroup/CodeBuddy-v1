import io.github.aaif_goose.MessageRole
import io.github.aaif_goose.ProviderMessage
import io.github.aaif_goose.ProviderModelConfig
import io.github.aaif_goose.declarativeProviderFromJson
import io.github.aaif_goose.streamFlow
import java.nio.file.Files
import java.nio.file.Path
import kotlinx.coroutines.runBlocking

fun main(args: Array<String>) = runBlocking {
    require(args.size == 1) {
        "usage: kotlin example <anonymous-local-provider.json>"
    }

    val provider = declarativeProviderFromJson(Files.readString(Path.of(args[0])))
    val model = ProviderModelConfig(modelName = "local-mock-model")
    val messages = listOf(
        ProviderMessage(
            role = MessageRole.USER,
            text = "What is the capital of France? Answer in one sentence.",
        ),
    )

    provider
        .streamFlow(
            model,
            "You are a knowledgeable geography expert.",
            messages,
        )
        .collect { chunk ->
            chunk.text?.let { print(it) }
            chunk.usageJson?.let { println("\nusage: $it") }
        }
    println()
}
