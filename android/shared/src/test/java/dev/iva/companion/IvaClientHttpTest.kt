package dev.iva.companion

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket

/**
 * The client against a real socket, because the interesting failures live between the
 * code and the wire: a header that never got attached, a body the server cannot read,
 * a status the app turns into silence.
 *
 * A hand-written socket rather than a mock web server: `com.sun.net.httpserver` is not
 * in android.jar, and one request-response is not worth a test dependency.
 */
class IvaClientHttpTest {

    private val server = OneShotServer()
    private val config = Config("http://127.0.0.1:${server.port}", "secret-token")

    @After
    fun stop() {
        server.close()
    }

    @Test
    fun `a turn posts the dictated text to the app route and speaks the reply`() {
        server.replyWith(200, """{"reply":"Fatto."}""")

        val answer = runBlocking { IvaClient.ask(config, "ricordami il latte") }

        assertEquals("POST /eve/v1/app HTTP/1.1", server.requestLine)
        assertEquals("Bearer secret-token", server.header("authorization"))
        assertEquals("application/json", server.header("content-type"))
        assertEquals("ricordami il latte", JSONObject(server.body.orEmpty()).getString("text"))
        assertEquals(Answer.Spoken("Fatto."), answer)
    }

    @Test
    fun `a busy server is reported, not swallowed`() {
        server.replyWith(409, """{"error":"busy"}""")

        val answer = runBlocking { IvaClient.ask(config, "ciao") }

        assertTrue(answer is Answer.Problem)
        assertTrue((answer as Answer.Problem).message.contains("aspetta"))
    }

    @Test
    fun `a server that is not there says so instead of hanging`() {
        server.close()

        val answer = runBlocking { IvaClient.ask(config, "ciao") }

        assertEquals("Non riesco a raggiungere Iva.", (answer as Answer.Problem).message)
    }

    @Test
    fun `settings without an address never reach the network`() {
        val answer = runBlocking { IvaClient.ask(Config("", "secret-token"), "ciao") }

        assertTrue(answer is Answer.Problem)
        assertNull(server.requestLine)
    }

    @Test
    fun `six digits from telegram trade for the token, without a bearer`() {
        server.replyWith(200, """{"token":"secret-token"}""")

        val outcome = runBlocking {
            IvaClient.claimPairCode("http://127.0.0.1:${server.port}", " 123456 ")
        }

        assertEquals("POST /eve/v1/app/pair/claim HTTP/1.1", server.requestLine)
        // Pairing is how the app GETS the bearer: it must not be asked to present one.
        assertNull(server.header("authorization"))
        assertEquals("123456", JSONObject(server.body.orEmpty()).getString("code"))
        assertEquals(Pairing.Paired("secret-token"), outcome)
    }

    @Test
    fun `a code that is not six digits never reaches the network`() {
        val outcome = runBlocking {
            IvaClient.claimPairCode("http://127.0.0.1:${server.port}", "12ab34")
        }

        assertTrue(outcome is Pairing.Refused)
        assertNull(server.requestLine)
    }

    @Test
    fun `a wrong code says so in words, not numbers`() {
        server.replyWith(401, """{"error":"wrong code"}""")

        val outcome = runBlocking {
            IvaClient.claimPairCode("http://127.0.0.1:${server.port}", "000000")
        }

        assertTrue((outcome as Pairing.Refused).message.contains("Codice"))
    }
}

/** Serves exactly one request on a free port and remembers what arrived. */
private class OneShotServer {
    private val socket = ServerSocket(0)
    private val headers = mutableMapOf<String, String>()

    val port: Int get() = socket.localPort

    @Volatile
    var requestLine: String? = null

    @Volatile
    var body: String? = null

    fun header(name: String): String? = headers[name.lowercase()]

    fun replyWith(status: Int, json: String) {
        Thread {
            runCatching {
                socket.accept().use { client ->
                    val reader = BufferedReader(InputStreamReader(client.getInputStream()))
                    requestLine = reader.readLine()
                    var length = 0
                    while (true) {
                        val line = reader.readLine().orEmpty()
                        if (line.isEmpty()) break
                        val name = line.substringBefore(':').trim().lowercase()
                        val value = line.substringAfter(':').trim()
                        headers[name] = value
                        if (name == "content-length") length = value.toInt()
                    }
                    val buffer = CharArray(length)
                    var read = 0
                    while (read < length) {
                        val n = reader.read(buffer, read, length - read)
                        if (n < 0) break
                        read += n
                    }
                    body = String(buffer, 0, read)
                    client.getOutputStream().apply {
                        write(
                            ("HTTP/1.1 $status X\r\n" +
                                "Content-Type: application/json\r\n" +
                                "Content-Length: ${json.toByteArray().size}\r\n\r\n" +
                                json).toByteArray(),
                        )
                        flush()
                    }
                }
            }
        }.apply { isDaemon = true }.start()
    }

    fun close() {
        runCatching { socket.close() }
    }
}
