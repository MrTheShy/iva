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

    /** Something the user needs to hear about, already phrased for text-to-speech. */
    data class Problem(val message: String) : Answer
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
        if (!config.isComplete) return@withContext Answer.Problem("Manca l'indirizzo o il token.")
        val connection = try {
            (URL(config.endpoint).openConnection() as HttpURLConnection)
        } catch (e: IOException) {
            return@withContext Answer.Problem("Indirizzo non valido.")
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
            Answer.Problem("Non riesco a raggiungere Iva.")
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Turns a status code into something worth saying out loud. Visible for tests: this
     * is the only branching in the client, and every branch is a sentence the user hears
     * when things go wrong.
     */
    fun readAnswer(status: Int, body: String): Answer = when (status) {
        in 200..299 -> {
            val reply = runCatching { JSONObject(body).optString("reply") }.getOrDefault("")
            if (reply.isBlank()) Answer.Problem("Ha risposto senza dire niente.")
            else Answer.Spoken(reply)
        }
        401 -> Answer.Problem("Token rifiutato.")
        400 -> Answer.Problem("Non ho capito cosa dire.")
        409 -> Answer.Problem("Sta ancora rispondendo, aspetta.")
        429 -> Answer.Problem("Troppe richieste di fila.")
        502 -> Answer.Problem("Iva si è inceppata.")
        503 -> Answer.Problem("Il server non è configurato.")
        504 -> Answer.Problem("Ci sta mettendo troppo: guarda su Telegram.")
        else -> Answer.Problem("Errore $status.")
    }
}
