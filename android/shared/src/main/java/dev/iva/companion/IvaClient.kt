package dev.iva.companion

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.MalformedURLException
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
 * One step of pairing: the device asks the server for a six-digit code, the code
 * appears in the owner's Telegram, and typing it back trades it for the bearer token.
 * Nobody copies 43 characters onto a watch.
 */
sealed interface Pairing {
    data object CodeSent : Pairing

    data class Paired(val token: String) : Pairing

    data class Refused(val message: String, val detail: String = "") : Pairing
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

    /**
     * Synthesis takes seconds, not minutes. Waiting longer than this for a nicer voice
     * is worse than reading the same words with the phone's own.
     */
    private const val VOICE_TIMEOUT_MS = 35_000

    suspend fun ask(config: Config, text: String): Answer = withContext(Dispatchers.IO) {
        if (!config.isComplete) {
            return@withContext Answer.Problem(
                "Manca l'indirizzo o il token.",
                "impostazioni incomplete: indirizzo=${config.baseUrl.isNotBlank()} token=${config.token.isNotBlank()}",
            )
        }
        val url = try {
            URL(config.endpoint)
        } catch (e: MalformedURLException) {
            return@withContext Answer.Problem(
                "Indirizzo non valido.",
                "URL rifiutato: ${config.endpoint} · ${e.javaClass.simpleName}: ${e.message}",
            )
        }
        // A watch mid-handoff between WiFi and LTE loses the first connect and nothing
        // else, so one more try. Only here: past the connect the request may already be
        // travelling, and resending it would run the turn twice.
        val connection = try {
            connect(url, config.token, READ_TIMEOUT_MS)
        } catch (first: IOException) {
            try {
                connect(url, config.token, READ_TIMEOUT_MS)
            } catch (e: IOException) {
                return@withContext Answer.Problem(
                    "Non riesco a raggiungere Iva.",
                    "rete: ${e.javaClass.simpleName}: ${e.message} · ${config.endpoint}",
                )
            }
        }
        try {
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
     * Fetches the reply spoken in Iva's own voice, or null when the server cannot
     * produce it. Null is not an error to report: the caller reads the text with the
     * voice built into the device instead, and the user hears an answer either way.
     */
    suspend fun speak(config: Config, text: String): ByteArray? = withContext(Dispatchers.IO) {
        if (!config.isComplete) return@withContext null
        val connection = try {
            connect(URL(config.voiceEndpoint), config.token, VOICE_TIMEOUT_MS)
        } catch (e: IOException) {
            // No retry for the voice: the text fallback is faster than a second try.
            return@withContext null
        }
        try {
            connection.outputStream.use { it.write(JSONObject().put("text", text).toString().toByteArray()) }
            if (connection.responseCode !in 200..299) return@withContext null
            connection.inputStream.use { it.readBytes() }.takeIf { it.isNotEmpty() }
        } catch (e: IOException) {
            null
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Asks the server to send a pairing code to the owner's Telegram. No token yet —
     * getting one is the whole point.
     */
    suspend fun requestPairCode(baseUrl: String): Pairing = withContext(Dispatchers.IO) {
        pair(baseUrl, "", "{}") { status, _ ->
            when (status) {
                in 200..299 -> Pairing.CodeSent
                429 -> Pairing.Refused("Aspetta mezzo minuto prima di chiedere un altro codice.")
                502 -> Pairing.Refused("Il server non riesce a scrivere su Telegram.")
                503 -> Pairing.Refused("Il server non è configurato.")
                else -> Pairing.Refused("Errore $status.")
            }
        }
    }

    /** Trades the six digits read in Telegram for the token, which the caller stores. */
    suspend fun claimPairCode(baseUrl: String, code: String): Pairing = withContext(Dispatchers.IO) {
        val digits = code.trim()
        if (!digits.matches(Regex("\\d{6}"))) {
            return@withContext Pairing.Refused("Il codice è di 6 cifre.")
        }
        val body = JSONObject().put("code", digits).toString()
        pair(baseUrl, "/claim", body) { status, answer ->
            when (status) {
                in 200..299 -> {
                    val token = runCatching { JSONObject(answer).optString("token") }.getOrDefault("")
                    if (token.isBlank()) Pairing.Refused("Il server non ha mandato il token.")
                    else Pairing.Paired(token)
                }
                401 -> Pairing.Refused("Codice sbagliato o scaduto: chiedine un altro.")
                429 -> Pairing.Refused("Troppi tentativi: chiedi un nuovo codice.")
                503 -> Pairing.Refused("Il server non è configurato.")
                else -> Pairing.Refused("Errore $status.")
            }
        }
    }

    /** One pairing POST: same wire shape for asking a code and for claiming it. */
    private fun pair(
        baseUrl: String,
        suffix: String,
        body: String,
        read: (Int, String) -> Pairing,
    ): Pairing {
        val endpoint = baseUrl.trimEnd('/') + "/eve/v1/app/pair" + suffix
        val connection = try {
            connect(URL(endpoint), token = null, timeoutMs = CONNECT_TIMEOUT_MS)
        } catch (e: IOException) {
            return Pairing.Refused(
                "Non riesco a raggiungere il server.",
                "rete: ${e.javaClass.simpleName}: ${e.message} · $endpoint",
            )
        }
        return try {
            connection.outputStream.use { it.write(body.toByteArray()) }
            val status = connection.responseCode
            val answer = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()
                ?.use { it.readText() }
                .orEmpty()
            read(status, answer)
        } catch (e: IOException) {
            Pairing.Refused(
                "Non riesco a raggiungere il server.",
                "rete: ${e.javaClass.simpleName}: ${e.message} · $endpoint",
            )
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Registers this device's FCM token so the heartbeat can ring it. Bearer
     * required: only a paired device may ring. Best-effort — false is "not now".
     */
    suspend fun registerPushToken(config: Config, token: String): Boolean =
        withContext(Dispatchers.IO) {
            if (!config.isComplete) return@withContext false
            val body = JSONObject().put("token", token).put("platform", "wear").toString()
            post(config, "/push-token", body) != null
        }

    /**
     * The message the heartbeat parked for the wrist call, or null. The push that
     * woke us carried no content on purpose: this is where the content lives.
     */
    suspend fun fetchInbox(config: Config): String? = withContext(Dispatchers.IO) {
        val answer = post(config, "/inbox", "{}") ?: return@withContext null
        runCatching { JSONObject(answer).optString("text") }
            .getOrDefault("")
            .takeIf { it.isNotBlank() }
    }

    /** One small authenticated POST under the app route; null on any failure. */
    private fun post(config: Config, suffix: String, body: String): String? {
        val connection = try {
            connect(URL(config.endpoint + suffix), config.token, CONNECT_TIMEOUT_MS)
        } catch (e: IOException) {
            return null
        }
        return try {
            connection.outputStream.use { it.write(body.toByteArray()) }
            if (connection.responseCode !in 200..299) null
            else connection.inputStream.bufferedReader().use { it.readText() }
        } catch (e: IOException) {
            null
        } finally {
            connection.disconnect()
        }
    }

    /** Opens the socket before anything is sent, so a failure here is safe to retry. */
    private fun connect(url: URL, token: String?, timeoutMs: Int): HttpURLConnection {
        // A valid-but-non-http address (ftp://, file://) makes openConnection return a
        // non-HttpURLConnection; the hard cast would throw ClassCastException, which no
        // caller catches — the app crashes on every press. Turn it into the IOException
        // callers already handle, so a bad address reads as "can't reach", not a crash.
        val connection = url.openConnection() as? HttpURLConnection
            ?: throw IOException("unsupported URL scheme: ${url.protocol} (use http or https)")
        return connection.apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = timeoutMs
            if (token != null) setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "application/json")
            connect()
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
