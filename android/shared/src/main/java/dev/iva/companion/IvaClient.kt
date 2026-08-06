package dev.iva.companion

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** What came back from one voice turn. */
sealed interface Answer {
    data class Spoken(val reply: String) : Answer

    /**
     * Something the user needs to hear about. [message] is phrased for text-to-speech;
     * [detail] is the technical line the app offers to copy, so a failure can be
     * reported without plugging the phone into a computer.
     */
    data class Problem(val message: String, val detail: String = "") : Answer
}

/**
 * One endpoint, one POST — so `HttpURLConnection` and `org.json`, both already in the
 * platform. An HTTP library here would be a dependency to keep current for no gain.
 */
object IvaClient {

    /**
     * The server holds the request open for the whole turn, so the read timeout has to
     * outlast Iva thinking. It is a little longer than the server's own 120s budget:
     * a 504 that explains itself beats a socket dying without a word.
     */
    private const val READ_TIMEOUT_MS = 130_000
    private const val CONNECT_TIMEOUT_MS = 15_000

    suspend fun ask(config: Config, text: String): Answer = withContext(Dispatchers.IO) {
        if (!config.isComplete) {
            return@withContext Answer.Problem(
                "Manca l'indirizzo o il token.",
                "impostazioni incomplete: indirizzo=${config.baseUrl.isNotBlank()} token=${config.token.isNotBlank()}",
            )
        }
        val connection = try {
            (URL(config.endpoint).openConnection() as HttpURLConnection)
        } catch (e: IOException) {
            return@withContext Answer.Problem(
                "Indirizzo non valido.",
                "URL rifiutato: ${config.endpoint} · ${e.javaClass.simpleName}: ${e.message}",
            )
        }
        try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.setRequestProperty("Authorization", "Bearer ${config.token}")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { out ->
                out.write(JSONObject().put("text", text).toString().toByteArray())
            }
            val status = connection.responseCode
            val body = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()
                ?.use { it.readText() }
                .orEmpty()
            readAnswer(status, body)
        } catch (e: IOException) {
            Answer.Problem(
                "Non riesco a raggiungere Iva.",
                "rete: ${e.javaClass.simpleName}: ${e.message} · ${config.endpoint}",
            )
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Turns a status code into something worth saying out loud. Visible for tests: this
     * is the only branching in the client, and every branch is a sentence the user hears
     * when things go wrong.
     */
    fun readAnswer(status: Int, body: String): Answer {
        if (status in 200..299) {
            val reply = runCatching { JSONObject(body).optString("reply") }.getOrDefault("")
            return if (reply.isNotBlank()) Answer.Spoken(reply)
            else Answer.Problem("Ha risposto senza dire niente.", detail(status, body))
        }
        val message = when (status) {
            401 -> "Token rifiutato."
            400 -> "Non ho capito cosa dire."
            409 -> "Sta ancora rispondendo, aspetta."
            429 -> "Troppe richieste di fila."
            502 -> "Iva si è inceppata."
            503 -> "Il server non è configurato."
            504 -> "Ci sta mettendo troppo: guarda su Telegram."
            // Cloudflare taglia l'origine a 100s e risponde 524, prima che la rotta
            // possa arrivare al suo tetto di 120s. Per chi ascolta è lo stesso caso del
            // 504: la risposta arriva comunque in chat, perché il turno continua.
            524 -> "Ci sta mettendo troppo: guarda su Telegram."
            in 520..529 -> "Iva non risponde."
            else -> "Errore $status."
        }
        return Answer.Problem(message, detail(status, body))
    }

    /** The copied line for an HTTP failure: the status and what the server actually said. */
    private fun detail(status: Int, body: String): String =
        "HTTP $status · risposta: ${body.trim().take(300).ifEmpty { "(vuota)" }}"
}
